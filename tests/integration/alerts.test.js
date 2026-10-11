const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, makeClient, ACCOUNTS } = require('./helpers');

let server;
let api;
let sarah;
let joan;
let employer;
let admin;
let sarahAlertId;

before(async () => {
  server = await startServer();
  api = makeClient(server.baseUrl);
  sarah = await api.login(ACCOUNTS.sarah);
  joan = await api.login(ACCOUNTS.joan); // has no seeded alerts, used for the 10-alert cap
  employer = await api.login(ACCOUNTS.employer1);
  admin = await api.login(ACCOUNTS.admin);
});

const clearAlerts = async (user) => {
  const list = await api.get('/alerts', { token: user.token });
  for (const alert of list.body.alerts) await api.del(`/alerts/${alert.id}`, user.token);
};

after(async () => {
  if (sarahAlertId) await api.del(`/alerts/${sarahAlertId}`, sarah.token);
  await clearAlerts(joan);
  await server.stop();
});

test('401 without a token; 403 for employers and admins', async () => {
  assert.equal((await api.get('/alerts')).status, 401);
  assert.equal((await api.get('/alerts', { token: employer.token })).status, 403);
  assert.equal((await api.post('/alerts', { keywords: 'x' }, admin.token)).status, 403);
  assert.equal((await api.get('/alerts/match/recommendations', { token: employer.token })).status, 403);
  assert.equal((await api.get('/alerts/match/jobs/1', { token: admin.token })).status, 403);
});

test('empty state: a seeker with no alerts gets an empty list and the cap', async () => {
  await clearAlerts(joan);
  const res = await api.get('/alerts', { token: joan.token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.alerts, []);
  assert.equal(res.body.max_alerts, 10);
});

test('validation rejects empty criteria, bad min_match, bad job type and over-long text', async () => {
  const bad = [
    {},
    { name: 'x' },
    { keywords: 'react', min_match: 101 },
    { keywords: 'react', min_match: -1 },
    { keywords: 'react', min_match: 12.5 },
    { keywords: 'react', min_match: 'abc' },
    { keywords: 'react', job_type: 'Freelance' },
    { keywords: 'k'.repeat(201) },
    { location: 'l'.repeat(161) },
    { keywords: 'react', name: 'n'.repeat(101) }
  ];
  for (const body of bad) {
    assert.equal((await api.post('/alerts', body, joan.token)).status, 400, JSON.stringify(body).slice(0, 60));
  }
});

test('a seeker can create, list, update, pause and resume an alert', async () => {
  const created = await api.post('/alerts', { name: 'Test alert', keywords: 'frontend, react', location: 'Kampala', min_match: 40 }, sarah.token);
  assert.equal(created.status, 201);
  sarahAlertId = created.body.alert.id;
  assert.equal(created.body.alert.is_active, true);

  const list = await api.get('/alerts', { token: sarah.token });
  const found = list.body.alerts.find((a) => a.id === sarahAlertId);
  assert.ok(found);
  assert.ok(found.match_count >= 1);

  const updated = await api.put(`/alerts/${sarahAlertId}`, { name: 'Renamed', keywords: 'backend', min_match: 10 }, sarah.token);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.alert.name, 'Renamed');
  assert.equal(updated.body.alert.min_match, 10);

  const paused = await api.patch(`/alerts/${sarahAlertId}/status`, { is_active: false }, sarah.token);
  assert.equal(paused.body.alert.is_active, false);
  assert.equal((await api.patch(`/alerts/${sarahAlertId}/status`, { is_active: 'yes' }, sarah.token)).status, 400);
  const resumed = await api.patch(`/alerts/${sarahAlertId}/status`, { is_active: true }, sarah.token);
  assert.equal(resumed.body.alert.is_active, true);
});

test('ownership: another seeker gets 403, a missing alert 404', async () => {
  assert.equal((await api.put(`/alerts/${sarahAlertId}`, { keywords: 'hack' }, joan.token)).status, 403);
  assert.equal((await api.patch(`/alerts/${sarahAlertId}/status`, { is_active: false }, joan.token)).status, 403);
  assert.equal((await api.get(`/alerts/${sarahAlertId}/matches`, { token: joan.token })).status, 403);
  assert.equal((await api.del(`/alerts/${sarahAlertId}`, joan.token)).status, 403);
  assert.equal((await api.get('/alerts/99999999/matches', { token: sarah.token })).status, 404);
  assert.equal((await api.get('/alerts/abc/matches', { token: sarah.token })).status, 400);
});

test('matches are live, ranked by explainable score, and respect min_match', async () => {
  await api.put(`/alerts/${sarahAlertId}`, { keywords: 'developer, analyst, officer, coordinator', min_match: 20 }, sarah.token);
  const res = await api.get(`/alerts/${sarahAlertId}/matches`, { token: sarah.token });
  assert.equal(res.status, 200);
  const scores = res.body.matches.map((m) => m.match.score);
  assert.ok(scores.length >= 2);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.ok(scores.every((s) => s >= 20));
  const first = res.body.matches[0].match;
  assert.ok(Array.isArray(first.skills.matched) && Array.isArray(first.skills.missing));
  assert.equal(typeof first.location.reason, 'string');

  const strict = await api.put(`/alerts/${sarahAlertId}`, { keywords: 'developer', min_match: 100 }, sarah.token);
  assert.equal(strict.status, 200);
  assert.deepEqual((await api.get(`/alerts/${sarahAlertId}/matches`, { token: sarah.token })).body.matches, []);
});

test('score for a job is explainable: Sarah vs Frontend Developer (job 1)', async () => {
  const res = await api.get('/alerts/match/jobs/1', { token: sarah.token });
  assert.equal(res.status, 200);
  const { match } = res.body;
  assert.equal(match.score, 72); // 70% x 3/5 skills + 30% x same city
  assert.deepEqual(match.skills.missing, ['HTML', 'CSS']);
  assert.equal((await api.get('/alerts/match/jobs/99999999', { token: sarah.token })).status, 404);
});

test('recommendations: ranked, scored > 0, never include jobs already applied for', async () => {
  const res = await api.get('/alerts/match/recommendations?limit=20', { token: sarah.token });
  assert.equal(res.status, 200);
  const ids = res.body.recommendations.map((r) => r.job.id);
  assert.ok(!ids.includes(1), 'Sarah already applied to job 1');
  const scores = res.body.recommendations.map((r) => r.match.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.ok(scores.every((s) => s > 0));
});

test('at most 10 alerts per user (11th gets 409) and deleting frees a slot', async () => {
  await clearAlerts(joan);
  for (let i = 1; i <= 10; i += 1) {
    const res = await api.post('/alerts', { keywords: `term${i}` }, joan.token);
    assert.equal(res.status, 201, `alert ${i}`);
  }
  assert.equal((await api.post('/alerts', { keywords: 'one too many' }, joan.token)).status, 409);
  const list = await api.get('/alerts', { token: joan.token });
  assert.equal(list.body.alerts.length, 10);
  assert.equal((await api.del(`/alerts/${list.body.alerts[0].id}`, joan.token)).status, 200);
  assert.equal((await api.post('/alerts', { keywords: 'fits now' }, joan.token)).status, 201);
});
