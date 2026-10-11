const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient, ACCOUNTS, createJob, applyTo, setStatus, futureIso } = require('./helpers');

let server;
let api;
let employer;
let other;
let admin;
let sarah;
let grace;
let jobId;
let appId;
let interviewId;

const proposal = (overrides = {}) => ({
  application_id: appId,
  format: 'Video call',
  venue: 'https://meet.example.com/test',
  note: 'Bring your laptop',
  slots: [futureIso(5, 10), futureIso(6, 14)],
  ...overrides
});

before(async () => {
  server = await startServer();
  api = makeClient(server.baseUrl);
  employer = await api.login(ACCOUNTS.employer1);
  other = await api.login(ACCOUNTS.employer2);
  admin = await api.login(ACCOUNTS.admin);
  sarah = await api.login(ACCOUNTS.sarah);
  grace = await api.login(ACCOUNTS.grace);
  jobId = await createJob(api, employer.token);
  appId = await applyTo(api, sarah.token, jobId);
});

after(async () => {
  await api.del(`/jobs/${jobId}`, employer.token); // cascades applications, interviews and slots
  await server.stop();
});

test('unauthenticated requests get 401', async () => {
  assert.equal((await api.get('/interviews')).status, 401);
  assert.equal((await api.post('/interviews', proposal())).status, 401);
});

test('a Pending applicant cannot be invited (only Shortlisted)', async () => {
  const res = await api.post('/interviews', proposal(), employer.token);
  assert.equal(res.status, 409);
});

test('non-owner employer, job seeker and admin cannot propose (403)', async () => {
  await setStatus(api, employer.token, appId, 'Shortlisted');
  assert.equal((await api.post('/interviews', proposal(), other.token)).status, 403);
  assert.equal((await api.post('/interviews', proposal(), sarah.token)).status, 403);
  assert.equal((await api.post('/interviews', proposal(), admin.token)).status, 403);
});

test('validation: slots count, past dates, duplicates, format, venue, unknown application', async () => {
  const bad = [
    proposal({ slots: [] }),
    proposal({ slots: [futureIso(1), futureIso(2), futureIso(3), futureIso(4)] }),
    proposal({ slots: [new Date(Date.now() - 3600 * 1000).toISOString()] }),
    proposal({ slots: [futureIso(3), futureIso(3)] }),
    proposal({ slots: ['not a date'] }),
    proposal({ slots: [futureIso(1000)] }),
    proposal({ format: 'Carrier pigeon' }),
    proposal({ venue: '' }),
    proposal({ note: 'x'.repeat(501) })
  ];
  for (const body of bad) {
    const res = await api.post('/interviews', body, employer.token);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await api.post('/interviews', proposal({ application_id: 99999999 }), employer.token)).status, 404);
});

test('owner proposes an interview for a shortlisted applicant (interview + slots saved together)', async () => {
  const res = await api.post('/interviews', proposal(), employer.token);
  assert.equal(res.status, 201);
  interviewId = res.body.interview.id;
  assert.equal(res.body.interview.status, 'Proposed');
  assert.equal(res.body.interview.slots.length, 2);
});

test('only one active interview per application', async () => {
  const res = await api.post('/interviews', proposal(), employer.token);
  assert.equal(res.status, 409);
  const list = await api.get(`/interviews?job_id=${jobId}`, { token: employer.token });
  assert.equal(list.body.interviews.length, 1); // the rejected attempt left nothing behind
  assert.equal(list.body.interviews[0].slots.length, 2);
});

test('visibility: candidate and owner see it; other seeker/employer do not', async () => {
  const mine = await api.get('/interviews', { token: sarah.token });
  assert.ok(mine.body.interviews.some((i) => i.id === interviewId));
  const notMine = await api.get('/interviews', { token: grace.token });
  assert.ok(!notMine.body.interviews.some((i) => i.id === interviewId));
  const otherEmployer = await api.get('/interviews', { token: other.token });
  assert.ok(!otherEmployer.body.interviews.some((i) => i.id === interviewId));
  const adminView = await api.get('/interviews', { token: admin.token });
  assert.ok(adminView.body.interviews.some((i) => i.id === interviewId));
});

test('only the invited candidate can confirm or decline (403 for others)', async () => {
  const list = await api.get('/interviews', { token: sarah.token });
  const slotId = list.body.interviews.find((i) => i.id === interviewId).slots[0].id;
  assert.equal((await api.post(`/interviews/${interviewId}/confirm`, { slot_id: slotId }, grace.token)).status, 403);
  assert.equal((await api.post(`/interviews/${interviewId}/decline`, { reason: 'nope' }, grace.token)).status, 403);
  assert.equal((await api.post(`/interviews/${interviewId}/confirm`, { slot_id: slotId }, employer.token)).status, 403);
  assert.equal((await api.post('/interviews/99999999/confirm', { slot_id: 1 }, sarah.token)).status, 404);
});

test('confirm needs one of THIS interview\'s slots', async () => {
  assert.equal((await api.post(`/interviews/${interviewId}/confirm`, {}, sarah.token)).status, 400);
  assert.equal((await api.post(`/interviews/${interviewId}/confirm`, { slot_id: 99999999 }, sarah.token)).status, 400);
});

test('decline requires a reason', async () => {
  assert.equal((await api.post(`/interviews/${interviewId}/decline`, { reason: '' }, sarah.token)).status, 400);
  assert.equal((await api.post(`/interviews/${interviewId}/decline`, { reason: 'x'.repeat(501) }, sarah.token)).status, 400);
});

test('candidate confirms one slot; it cannot be answered twice', async () => {
  const list = await api.get('/interviews', { token: sarah.token });
  const slot = list.body.interviews.find((i) => i.id === interviewId).slots[1];
  const res = await api.post(`/interviews/${interviewId}/confirm`, { slot_id: slot.id }, sarah.token);
  assert.equal(res.status, 200);
  const updated = res.body.interview;
  assert.equal(updated.status, 'Confirmed');
  assert.deepEqual(updated.slots.filter((s) => s.is_selected).map((s) => s.id), [slot.id]);
  assert.equal((await api.post(`/interviews/${interviewId}/decline`, { reason: 'changed my mind' }, sarah.token)).status, 409);
  assert.equal((await api.post('/interviews', proposal(), employer.token)).status, 409); // still active
});

test('cancel: non-owner and admin get 403; owner cancels and may then propose again', async () => {
  assert.equal((await api.post(`/interviews/${interviewId}/cancel`, {}, other.token)).status, 403);
  assert.equal((await api.post(`/interviews/${interviewId}/cancel`, {}, admin.token)).status, 403);
  assert.equal((await api.post(`/interviews/${interviewId}/cancel`, {}, sarah.token)).status, 403);
  const res = await api.post(`/interviews/${interviewId}/cancel`, {}, employer.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.interview.status, 'Cancelled');
  assert.equal((await api.post(`/interviews/${interviewId}/cancel`, {}, employer.token)).status, 409);

  const again = await api.post('/interviews', proposal({ slots: [futureIso(8, 9)] }), employer.token);
  assert.equal(again.status, 201);
  interviewId = again.body.interview.id;
});

test('candidate declines with a reason; the employer sees it and can re-invite', async () => {
  const res = await api.post(`/interviews/${interviewId}/decline`, { reason: 'I have another commitment' }, sarah.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.interview.status, 'Declined');
  const asEmployer = await api.get(`/interviews?job_id=${jobId}`, { token: employer.token });
  const declined = asEmployer.body.interviews.find((i) => i.id === interviewId);
  assert.equal(declined.decline_reason, 'I have another commitment');
  assert.equal((await api.post(`/interviews/${interviewId}/confirm`, { slot_id: declined.slots[0].id }, sarah.token)).status, 409);
  assert.equal((await api.post('/interviews', proposal({ slots: [futureIso(9, 9)] }), employer.token)).status, 201);
});
