// Regression: the ORIGINAL JobConnect workflow must still work after the three new features were added.
// login -> employer posts job -> seeker applies -> employer shortlists -> seeker sees the new status.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient, ACCOUNTS, createJob, applyTo, setStatus } = require('./helpers');

let server;
let api;
let employer;
let other;
let seeker;
let jobId;

before(async () => {
  server = await startServer();
  api = makeClient(server.baseUrl);
  employer = await api.login(ACCOUNTS.employer1);
  other = await api.login(ACCOUNTS.employer2);
  seeker = await api.login(ACCOUNTS.grace);
});

after(async () => {
  if (jobId) await api.del(`/jobs/${jobId}`, employer.token);
  await server.stop();
});

test('health check reports the database as connected', async () => {
  const res = await api.get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.database, 'connected');
});

test('login works for every seeded role and never returns the password hash', async () => {
  for (const [name, email] of Object.entries(ACCOUNTS)) {
    const { user, token } = await api.login(email);
    assert.ok(token, `${name} should receive a token`);
    assert.equal(user.email, email);
    assert.equal(user.password, undefined);
  }
});

test('login rejects a wrong password and protected routes reject a missing token', async () => {
  const bad = await api.post('/auth/login', { email: ACCOUNTS.sarah, password: 'wrong-password' });
  assert.equal(bad.status, 401);
  const anon = await api.get('/auth/me');
  assert.equal(anon.status, 401);
});

test('public job browsing still returns open jobs', async () => {
  const res = await api.get('/jobs');
  assert.equal(res.status, 200);
  assert.ok(res.body.jobs.length >= 1);
  assert.ok(res.body.jobs.every((job) => job.status === 'open'));
});

test('employer posts a job, seeker applies, duplicate is refused', async () => {
  jobId = await createJob(api, employer.token);
  const applicationId = await applyTo(api, seeker.token, jobId);
  assert.ok(applicationId);
  const form = new FormData();
  form.append('cover_letter', 'second try');
  const duplicate = await api.postForm(`/applications/apply/${jobId}`, form, seeker.token);
  assert.equal(duplicate.status, 409);
});

test('only the owning employer sees applicants and shortlists; the seeker sees the new status', async () => {
  const mine = await api.get(`/applications/job/${jobId}`, { token: employer.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.applications.length, 1);
  const applicationId = mine.body.applications[0].id;

  const denied = await api.get(`/applications/job/${jobId}`, { token: other.token });
  assert.equal(denied.status, 403);
  const deniedUpdate = await setStatus(api, other.token, applicationId, 'Shortlisted');
  assert.equal(deniedUpdate.status, 403);

  const shortlisted = await setStatus(api, employer.token, applicationId, 'Shortlisted');
  assert.equal(shortlisted.status, 200);
  assert.equal(shortlisted.body.application.status, 'Shortlisted');

  const asSeeker = await api.get('/applications/my-applications', { token: seeker.token });
  const row = asSeeker.body.applications.find((app) => app.id === applicationId);
  assert.equal(row.status, 'Shortlisted');
  // Scorecard data is employer-private and must not leak into the seeker's own application list.
  assert.equal(row.overall, undefined);
  assert.equal(row.recommendation, undefined);
});
