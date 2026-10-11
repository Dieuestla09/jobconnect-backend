// Shared helpers for the live-API integration tests.
//
// These tests talk to a REAL running API and the REAL database from .env (use your local learning database,
// never a shared one). By default each test file starts its own server on a free port; set API_URL to test
// a server you already started (e.g. API_URL=http://localhost:5000).
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const backendRoot = path.join(__dirname, '..', '..');
const PASSWORD = 'password123';

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

const startServer = async () => {
  if (process.env.API_URL) return { baseUrl: process.env.API_URL.replace(/\/$/, ''), stop: async () => {} };

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: backendRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        return {
          baseUrl,
          stop: async () => {
            child.kill();
            await new Promise((resolve) => child.once('exit', resolve));
          }
        };
      }
    } catch (error) {
      // server not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`API did not start. Is the database running and .env correct?\n${output}`);
};

// Small fetch wrapper: returns { status, body }. `form` sends multipart (used by the apply endpoint).
const makeClient = (baseUrl) => {
  const call = async (method, url, { token, body, form } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}/api${url}`, { method, headers, body: payload });
    let json = null;
    try {
      json = await res.json();
    } catch (error) {
      json = null;
    }
    return { status: res.status, body: json };
  };

  const login = async (email) => {
    const res = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
    if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    return { token: res.body.token, user: res.body.user };
  };

  return {
    get: (url, opts) => call('GET', url, opts),
    post: (url, body, token) => call('POST', url, { token, body }),
    put: (url, body, token) => call('PUT', url, { token, body }),
    patch: (url, body, token) => call('PATCH', url, { token, body }),
    del: (url, token) => call('DELETE', url, { token }),
    postForm: (url, form, token) => call('POST', url, { token, form }),
    login
  };
};

// Seed accounts from database/seed.sql (all use password123).
const ACCOUNTS = {
  admin: 'admin@jobconnect.com',
  employer1: 'employer1@jobconnect.com', // owns jobs 1-4
  employer2: 'employer2@jobconnect.com', // owns jobs 5-8
  sarah: 'seeker1@jobconnect.com',
  brian: 'seeker2@jobconnect.com',
  grace: 'seeker3@jobconnect.com',
  peter: 'seeker4@jobconnect.com',
  joan: 'seeker5@jobconnect.com'
};

// A job owned by `employerToken`; returns its id. Remove it with client.del(`/jobs/${id}`, token) (cascades).
const createJob = async (client, employerToken, overrides = {}) => {
  const res = await client.post(
    '/jobs',
    {
      title: `ZZ Test job ${Date.now()}`,
      description: 'Created by an automated test',
      requirements: 'React, Node.js, SQL',
      responsibilities: 'Testing',
      location: 'Kampala, Uganda',
      job_type: 'Full-time',
      salary_range: 'n/a',
      deadline: '2030-01-01',
      ...overrides
    },
    employerToken
  );
  if (res.status !== 201) throw new Error(`createJob failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.job.id;
};

// Apply as a seeker (uses the CV already on their profile). Returns the application id.
const applyTo = async (client, seekerToken, jobId) => {
  const form = new FormData();
  form.append('cover_letter', 'Automated test application');
  const res = await client.postForm(`/applications/apply/${jobId}`, form, seekerToken);
  if (res.status !== 201) throw new Error(`apply failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.application.id;
};

const setStatus = (client, employerToken, applicationId, status) =>
  client.put(`/applications/${applicationId}/status`, { status }, employerToken);

const futureIso = (days, hour = 10) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

module.exports = { startServer, makeClient, ACCOUNTS, createJob, applyTo, setStatus, futureIso };
