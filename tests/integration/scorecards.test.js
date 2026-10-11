const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient, ACCOUNTS, createJob, applyTo } = require('./helpers');

let server;
let api;
let employer;
let other;
let admin;
let seeker;
let jobId;
let appA;
let appB;

const valid = { technical: 5, communication: 4, culture_fit: 4, recommendation: 'Strong yes', notes: 'Great' };

before(async () => {
  server = await startServer();
  api = makeClient(server.baseUrl);
  employer = await api.login(ACCOUNTS.employer1);
  other = await api.login(ACCOUNTS.employer2);
  admin = await api.login(ACCOUNTS.admin);
  seeker = await api.login(ACCOUNTS.peter);
  jobId = await createJob(api, employer.token);
  appA = await applyTo(api, seeker.token, jobId);
  const brian = await api.login(ACCOUNTS.brian);
  appB = await applyTo(api, brian.token, jobId);
});

after(async () => {
  await api.del(`/jobs/${jobId}`, employer.token); // cascades applications + scorecards
  await server.stop();
});

test('unauthenticated requests get 401', async () => {
  assert.equal((await api.get(`/scorecards/application/${appA}`)).status, 401);
});

test('job seekers always get 403 (read, write and job list)', async () => {
  assert.equal((await api.get(`/scorecards/application/${appA}`, { token: seeker.token })).status, 403);
  assert.equal((await api.put(`/scorecards/application/${appA}`, valid, seeker.token)).status, 403);
  assert.equal((await api.get(`/scorecards/job/${jobId}`, { token: seeker.token })).status, 403);
});

test('an employer who does not own the job gets 403', async () => {
  assert.equal((await api.get(`/scorecards/application/${appA}`, { token: other.token })).status, 403);
  assert.equal((await api.put(`/scorecards/application/${appA}`, valid, other.token)).status, 403);
  assert.equal((await api.get(`/scorecards/job/${jobId}`, { token: other.token })).status, 403);
});

test('unknown application gives 404 and a bad id gives 400', async () => {
  assert.equal((await api.get('/scorecards/application/99999999', { token: employer.token })).status, 404);
  assert.equal((await api.get('/scorecards/application/abc', { token: employer.token })).status, 400);
});

test('empty state: no scorecard yet returns null', async () => {
  const res = await api.get(`/scorecards/application/${appA}`, { token: employer.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.scorecard, null);
});

test('validation rejects out-of-range, fractional, missing and non-numeric ratings', async () => {
  for (const bad of [0, 6, 3.5, -1, 'abc', null, undefined, true]) {
    const res = await api.put(`/scorecards/application/${appA}`, { ...valid, technical: bad }, employer.token);
    assert.equal(res.status, 400, `technical=${String(bad)}`);
  }
  assert.equal((await api.put(`/scorecards/application/${appA}`, { ...valid, recommendation: 'Definitely' }, employer.token)).status, 400);
  assert.equal((await api.put(`/scorecards/application/${appA}`, { ...valid, notes: 'x'.repeat(2001) }, employer.token)).status, 400);
  assert.equal((await api.put(`/scorecards/application/${appA}`, { ...valid, notes: 42 }, employer.token)).status, 400);
});

test('owner creates a scorecard; overall is computed by SQL; notes of exactly 2000 chars are allowed', async () => {
  const res = await api.put(`/scorecards/application/${appA}`, { ...valid, notes: 'n'.repeat(2000), overall: 1 }, employer.token);
  assert.equal(res.status, 201);
  assert.equal(res.body.scorecard.overall, '4.33'); // (5+4+4)/3, ignoring the client-sent "overall"
  assert.equal(res.body.scorecard.notes.length, 2000);
});

test('saving again updates the same row (one scorecard per application)', async () => {
  const first = await api.get(`/scorecards/application/${appA}`, { token: employer.token });
  const res = await api.put(
    `/scorecards/application/${appA}`,
    { technical: 2, communication: 2, culture_fit: 3, recommendation: 'No', notes: '' },
    employer.token
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.scorecard.id, first.body.scorecard.id);
  assert.equal(res.body.scorecard.overall, '2.33');
  assert.equal(res.body.scorecard.notes, null);
  const list = await api.get(`/scorecards/job/${jobId}`, { token: employer.token });
  assert.equal(list.body.scorecards.filter((s) => s.application_id === appA).length, 1);
});

test('admin can read but not write', async () => {
  assert.equal((await api.get(`/scorecards/application/${appA}`, { token: admin.token })).status, 200);
  assert.equal((await api.get(`/scorecards/job/${jobId}`, { token: admin.token })).status, 200);
  assert.equal((await api.put(`/scorecards/application/${appA}`, valid, admin.token)).status, 403);
});

test('rank=1 orders scorecards by overall, best first', async () => {
  await api.put(`/scorecards/application/${appB}`, { ...valid, technical: 5, communication: 5, culture_fit: 5 }, employer.token);
  const res = await api.get(`/scorecards/job/${jobId}?rank=1`, { token: employer.token });
  assert.equal(res.status, 200);
  const overall = res.body.scorecards.map((s) => Number(s.overall));
  assert.deepEqual(overall, [...overall].sort((a, b) => b - a));
  assert.equal(res.body.scorecards[0].application_id, appB);
});
