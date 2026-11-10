const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');

const systems = new Set();
test.afterEach(() => {
  for (const system of systems) system.close();
  systems.clear();
});

function createSystem({ google = false, payloadOverrides = {} } = {}) {
  let authRequest;
  const payload = {
    iss: 'https://accounts.google.com', aud: 'test-client-id', azp: 'test-client-id',
    exp: Math.floor(Date.now() / 1000) + 300, sub: 'google-subject-123',
    email: 'new.patient@example.test', email_verified: true, name: 'New Patient', nonce: '',
    ...payloadOverrides,
  };
  const oauthClientFactory = google ? () => ({
    generateAuthUrl(options) { authRequest = options; return `https://accounts.google.test/oauth?state=${options.state}`; },
    async getToken(input) { this.exchange = input; return { tokens: { id_token: 'verified-test-token' } }; },
    async verifyIdToken({ audience }) {
      assert.equal(audience, 'test-client-id');
      return { getPayload: () => ({ ...payload, nonce: authRequest.nonce }) };
    },
  }) : undefined;
  const system = createApp({
    config: {
      dbPath: ':memory:', nodeEnv: 'test', logLevel: 'silent',
      ...(google ? { googleClientId: 'test-client-id', googleClientSecret: 'test-client-secret', googleCallbackUrl: 'http://localhost/auth/google/callback' } : {}),
    },
    ...(oauthClientFactory ? { oauthClientFactory } : {}),
  });
  seedDemoData({ db: system.db, config: system.config });
  systems.add(system);
  return { system, getAuthRequest: () => authRequest };
}

async function getAnonymousCsrf(agent, path) {
  const page = await agent.get(path);
  assert.equal(page.status, 200);
  return page.text.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1];
}

async function googleCallback(agent, state, code = 'synthetic-code') {
  return agent.get('/auth/google/callback').query({ state, code });
}

function cookieValue(response, name) {
  const cookie = (response.headers['set-cookie'] || []).find((value) => value.startsWith(`${name}=`));
  return cookie?.split(';', 1)[0].slice(name.length + 1);
}

test('role selection clearly routes patient, doctor and administrator sign-in', async () => {
  const { system } = createSystem();
  const choice = await request(system.app).get('/login');
  assert.equal(choice.status, 200);
  assert.match(choice.text, /Patient Sign In/);
  assert.match(choice.text, /Doctor Sign In/);
  assert.match(choice.text, /Administrator/);
  assert.match(choice.text, /Create a patient account/);
  assert.equal((await request(system.app).get('/login/patient')).status, 200);
  assert.equal((await request(system.app).get('/login/doctor')).status, 200);
  assert.equal((await request(system.app).get('/login/admin')).status, 200);
  assert.equal((await request(system.app).get('/login/superuser')).status, 404);
});

test('email password sign-in enforces the selected server-side role and rotates the session', async () => {
  const { system } = createSystem();
  const formWithoutCsrf = await request(system.app).post('/auth/login/patient').type('form').send({ email: 'patient@health.local', password: 'ChangeMe123!' });
  assert.equal(formWithoutCsrf.status, 403);
  const agent = request.agent(system.app);
  const csrf = await getAnonymousCsrf(agent, '/login/patient');
  const patientLogin = await agent.post('/auth/login/patient').type('form').send({ _csrf: csrf, email: 'patient@health.local', password: 'ChangeMe123!', role: 'admin' });
  assert.equal(patientLogin.status, 302);
  const sessionId = cookieValue(patientLogin, 'health_session');
  assert.equal(system.auth.getSession(sessionId).user.role, 'patient');

  const doctorAgent = request.agent(system.app);
  const doctorCsrf = await getAnonymousCsrf(doctorAgent, '/login/doctor');
  const wrongRole = await doctorAgent.post('/auth/login/doctor').type('form').send({ _csrf: doctorCsrf, email: 'patient@health.local', password: 'ChangeMe123!' });
  assert.equal(wrongRole.status, 401);
  assert.match(wrongRole.text, /not a doctor account/);

  const adminAgent = request.agent(system.app);
  const adminCsrf = await getAnonymousCsrf(adminAgent, '/login/admin');
  assert.equal((await adminAgent.post('/auth/login/admin').type('form').send({ _csrf: adminCsrf, email: 'admin@health.local', password: 'ChangeMe123!' })).status, 302);
});

test('public registration always creates a patient and rejects missing CSRF', async () => {
  const { system } = createSystem();
  const agent = request.agent(system.app);
  const csrf = await getAnonymousCsrf(agent, '/register');
  const response = await agent.post('/auth/register/patient').type('form').send({
    _csrf: csrf, name: 'A Patient', email: 'public.patient@example.test',
    password: 'Strong patient password 2026!', confirmPassword: 'Strong patient password 2026!', role: 'admin',
  });
  assert.equal(response.status, 302);
  const sessionId = cookieValue(response, 'health_session');
  assert.equal(system.auth.getSession(sessionId).user.role, 'patient');
  assert.equal(system.db.prepare('SELECT role FROM users WHERE email = ?').get('public.patient@example.test').role, 'patient');
  const denied = await request(system.app).post('/auth/register/patient').type('form').send({
    name: 'No CSRF', email: 'no.csrf@example.test', password: 'Strong patient password 2026!', confirmPassword: 'Strong patient password 2026!',
  });
  assert.equal(denied.status, 403);
  assert.equal(system.db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('no.csrf@example.test').count, 0);
});

test('Google is clearly disabled without configuration and does not affect password login', async () => {
  const { system } = createSystem();
  const page = await request(system.app).get('/login/patient');
  assert.match(page.text, /Google sign-in is not configured/);
  assert.doesNotMatch(page.text, /href="\/auth\/google"/);
  assert.equal((await request(system.app).get('/auth/google')).status, 302);
  const login = await request(system.app).post('/api/auth/login').send({ email: 'patient@health.local', password: 'ChangeMe123!' });
  assert.equal(login.status, 200);
});

test('Google OAuth verifies claims, links a patient, and regenerates the server session', async () => {
  const { system } = createSystem({ google: true, payloadOverrides: { email: 'patient@health.local', sub: 'verified-google-patient' } });
  const agent = request.agent(system.app);
  const login = await agent.post('/api/auth/login').send({ email: 'patient@health.local', password: 'ChangeMe123!' });
  const priorSession = cookieValue(login, 'health_session');
  const oldCsrf = login.body.csrfToken;
  const started = await agent.get('/auth/google');
  assert.equal(started.status, 302);
  const state = new URL(started.headers.location).searchParams.get('state');
  const callback = await googleCallback(agent, state);
  assert.equal(callback.status, 302);
  const newSession = cookieValue(callback, 'health_session');
  assert.notEqual(newSession, priorSession);
  assert.equal(system.auth.getSession(priorSession), null);
  assert.equal(system.auth.getSession(newSession).user.role, 'patient');
  assert.equal(system.db.prepare('SELECT google_subject FROM users WHERE email = ?').get('patient@health.local').google_subject, 'verified-google-patient');
  assert.notEqual(system.auth.getSession(newSession).csrfToken, oldCsrf);
  assert.equal(system.db.prepare('SELECT used_at, code_verifier FROM google_oauth_transactions').get().code_verifier, null);
});

test('Google OAuth creates only patient accounts and rejects invalid identity claims', async (t) => {
  await t.test('new verified account', async () => {
    const { system } = createSystem({ google: true, payloadOverrides: { role: 'admin' } });
    const agent = request.agent(system.app);
    const started = await agent.get('/auth/google');
    const state = new URL(started.headers.location).searchParams.get('state');
    assert.equal((await googleCallback(agent, state)).status, 302);
    const row = system.db.prepare('SELECT role, google_subject FROM users WHERE email = ?').get('new.patient@example.test');
    assert.deepEqual(row, { role: 'patient', google_subject: 'google-subject-123' });
  });
  for (const [label, payloadOverrides] of [
    ['wrong audience', { aud: 'attacker-client' }],
    ['wrong issuer', { iss: 'https://evil.example' }],
    ['expired token', { exp: 1 }],
    ['unverified email', { email_verified: false }],
  ]) {
    await t.test(label, async () => {
      const { system } = createSystem({ google: true, payloadOverrides });
      const agent = request.agent(system.app);
      const started = await agent.get('/auth/google');
      const state = new URL(started.headers.location).searchParams.get('state');
      const result = await googleCallback(agent, state);
      assert.equal(result.status, 302);
      assert.match(result.headers.location, /error=/);
      assert.equal(system.db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('new.patient@example.test').count, 0);
    });
  }
  await t.test('cannot link a doctor account or elevate through role parameters', async () => {
    const { system } = createSystem({ google: true, payloadOverrides: { email: 'doctor@health.local', role: 'admin' } });
    const agent = request.agent(system.app);
    const started = await agent.get('/auth/google');
    const state = new URL(started.headers.location).searchParams.get('state');
    await googleCallback(agent, state);
    assert.equal(system.db.prepare('SELECT google_subject FROM users WHERE email = ?').get('doctor@health.local').google_subject, null);
    assert.equal(system.db.prepare("SELECT COUNT(*) AS count FROM sessions JOIN users ON users.id = sessions.user_id WHERE users.email = 'doctor@health.local'").get().count, 0);
  });
});

test('Google OAuth state is single use and bound to the initiating browser', async () => {
  const { system } = createSystem({ google: true });
  const first = request.agent(system.app);
  const second = request.agent(system.app);
  const started = await first.get('/auth/google');
  const state = new URL(started.headers.location).searchParams.get('state');
  assert.equal((await googleCallback(second, state)).status, 302);
  assert.equal((await googleCallback(first, state)).status, 302);
  assert.equal(system.db.prepare('SELECT COUNT(*) AS count FROM users WHERE email = ?').get('new.patient@example.test').count, 1);
  assert.equal((await googleCallback(first, state)).status, 302);
  assert.equal(system.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
});

test('Google account linking rejects a second Google subject for an already linked email', () => {
  const { system } = createSystem({ google: true });
  system.accounts.authenticateGooglePatient({ email: 'patient@health.local', name: 'Patient', subject: 'first-google-subject' });
  assert.throws(
    () => system.accounts.authenticateGooglePatient({ email: 'patient@health.local', name: 'Patient', subject: 'different-google-subject' }),
    /different Google account/,
  );
  assert.equal(system.db.prepare('SELECT google_subject FROM users WHERE email = ?').get('patient@health.local').google_subject, 'first-google-subject');
});

test('logout revokes the session and its CSRF token cannot authorize another mutation', async () => {
  const { system } = createSystem();
  const agent = request.agent(system.app);
  const login = await agent.post('/api/auth/login').send({ email: 'patient@health.local', password: 'ChangeMe123!' });
  const sessionId = cookieValue(login, 'health_session');
  const logout = await agent.post('/auth/logout').set('x-csrf-token', login.body.csrfToken);
  assert.equal(logout.status, 302);
  assert.equal(system.auth.getSession(sessionId), null);
  assert.equal((await agent.get('/dashboard')).status, 302);
});
