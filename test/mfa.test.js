const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');
const { loadConfig } = require('../src/config');
const { hotp, totp, verifyTotp, base32Encode, base32Decode, otpauthUri } = require('../src/security/totp');
const { createSecretBox } = require('../src/security/secret-box');

const PASSWORD = 'ChangeMe123!';
const TEST_KEY = crypto.randomBytes(32).toString('base64');
const systems = new Set();
test.afterEach(() => {
  for (const system of systems) system.close();
  systems.clear();
});

function createSystem({ staffMfaRequired = true } = {}) {
  const clock = { now: Date.parse('2030-01-01T10:00:05.000Z') };
  const system = createApp({
    config: { dbPath: ':memory:', nodeEnv: 'test', logLevel: 'silent', staffMfaRequired, mfaEncryptionKey: TEST_KEY },
    now: () => clock.now,
  });
  seedDemoData({ db: system.db, config: system.config });
  systems.add(system);
  return { system, clock };
}

async function apiLogin(agent, email, extra = {}) {
  return agent.post('/api/auth/login').send({ email, password: PASSWORD, ...extra });
}

async function enroll(agent, csrf, clock) {
  const setup = await agent.get('/account/security').set('Accept', 'application/json');
  assert.equal(setup.status, 200);
  const { secret } = setup.body.setup;
  const enabled = await agent.post('/account/mfa/enable').set('Accept', 'application/json').set('x-csrf-token', csrf)
    .send({ code: totp(secret, clock.now) });
  assert.equal(enabled.status, 200);
  return { secret, recoveryCodes: enabled.body.recoveryCodes };
}

function anonymousCsrf(response) {
  return response.text.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
}

async function browserPasswordStep(agent, role, email) {
  const page = await agent.get(`/login/${role}`);
  return agent.post(`/auth/login/${role}`).type('form').send({ _csrf: anonymousCsrf(page), email, password: PASSWORD });
}

async function submitChallenge(agent, fields) {
  const page = await agent.get('/auth/mfa');
  if (page.status !== 200) return page;
  return agent.post('/auth/mfa').type('form').send({ _csrf: anonymousCsrf(page), ...fields });
}

test('TOTP matches the RFC 6238 SHA-1 test vectors and base32 round-trips', () => {
  const rfcSecret = Buffer.from('12345678901234567890');
  assert.equal(hotp(rfcSecret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(rfcSecret, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(hotp(rfcSecret, Math.floor(1234567890 / 30), 8), '89005924');
  assert.equal(hotp(rfcSecret, Math.floor(20000000000 / 30), 8), '65353130');
  const secret = base32Encode(rfcSecret);
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode(secret.toLowerCase()), rfcSecret);
  assert.equal(totp(secret, 59_000), '287082');
  assert.equal(verifyTotp(secret, '287082', { nowMs: 59_000 }), 1);
  assert.equal(verifyTotp(secret, '287082', { nowMs: 59_000 + 30_000 }), 1, 'one step of drift is accepted');
  assert.equal(verifyTotp(secret, '287082', { nowMs: 59_000 + 90_000 }), null, 'older codes expire');
  assert.equal(verifyTotp(secret, '287082', { nowMs: 59_000, lastUsedStep: 1 }), null, 'a used step cannot be replayed');
  assert.equal(verifyTotp(secret, '28708', { nowMs: 59_000 }), null);
  assert.match(otpauthUri({ issuer: 'Health Centre', account: 'a@b.test', secret }), /^otpauth:\/\/totp\/Health%20Centre%3Aa%40b\.test\?secret=GEZD.*issuer=Health\+Centre/);
});

test('secret box encrypts with authentication and binds ciphertext to its owner', () => {
  const box = createSecretBox(TEST_KEY);
  const sealed = box.seal('JBSWY3DPEHPK3PXP', 'user:1');
  assert.doesNotMatch(sealed, /JBSWY3DPEHPK3PXP/);
  assert.equal(box.open(sealed, 'user:1'), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => box.open(sealed, 'user:2'));
  const parts = sealed.split(':');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => box.open(parts.join(':'), 'user:1'));
  assert.throws(() => createSecretBox(crypto.randomBytes(32)).open(sealed, 'user:1'));
  assert.throws(() => createSecretBox('too-short'), /32 bytes/);
});

test('configuration requires an MFA key in production and enforces staff MFA there by default', () => {
  const production = { nodeEnv: 'production', dbPath: '/var/lib/health/data/health.sqlite', demoMode: true, trustProxyHops: 1, publicBaseUrl: 'https://health.example' };
  // Explicit empty values keep these assertions independent of any local .env file.
  assert.throws(() => loadConfig({ ...production, mfaEncryptionKey: '' }), /MFA_ENCRYPTION_KEY must be set/);
  assert.throws(() => loadConfig({ ...production, mfaEncryptionKey: 'c2hvcnQ=' }), /exactly 32 bytes/);
  assert.equal(loadConfig({ ...production, mfaEncryptionKey: TEST_KEY }).staffMfaRequired, true);
  assert.equal(loadConfig({ ...production, mfaEncryptionKey: crypto.randomBytes(32).toString('hex') }).staffMfaRequired, true);
  assert.equal(loadConfig({ nodeEnv: 'test' }).staffMfaRequired, false);
  assert.equal(loadConfig({ nodeEnv: 'test', mfaEncryptionKey: '' }).mfaEncryptionKeyIsDevelopmentDefault, true);
});

test('staff must enrol before using the app; enrolment stores an encrypted seed and hashed recovery codes', async () => {
  const { system, clock } = createSystem();
  const admin = request.agent(system.app);
  const otherDevice = request.agent(system.app);
  const csrf = (await apiLogin(admin, 'admin@health.local')).body.csrfToken;
  assert.equal((await apiLogin(otherDevice, 'admin@health.local')).status, 200);

  const blocked = await admin.get('/api/appointments');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'mfa_enrollment_required');
  const redirected = await admin.get('/dashboard').set('Accept', 'text/html');
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.location, '/account/security');
  const page = await admin.get('/account/security').set('Accept', 'text/html');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.text, /required for administrator accounts/);
  assert.match(page.text, /src="data:image\/svg\+xml;base64,/);

  const secret = page.text.match(/data-mfa-secret="([A-Z2-7]+)"/)[1];
  const wrong = await admin.post('/account/mfa/enable').set('Accept', 'application/json').set('x-csrf-token', csrf).send({ code: '000000' });
  assert.equal(wrong.status, 400);

  const enabled = await admin.post('/account/mfa/enable').set('Accept', 'application/json').set('x-csrf-token', csrf).send({ code: totp(secret, clock.now) });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.recoveryCodes.length, 10);
  assert.equal(new Set(enabled.body.recoveryCodes).size, 10);

  const adminId = system.db.prepare("SELECT id FROM users WHERE email = 'admin@health.local'").get().id;
  const stored = system.db.prepare('SELECT secret_ciphertext, enabled_at FROM user_mfa WHERE user_id = ?').get(adminId);
  assert.ok(stored.enabled_at);
  assert.doesNotMatch(stored.secret_ciphertext, new RegExp(secret));
  const hashes = system.db.prepare('SELECT code_hash FROM mfa_recovery_codes WHERE user_id = ?').all(adminId).map((row) => row.code_hash);
  assert.equal(hashes.length, 10);
  for (const code of enabled.body.recoveryCodes) assert.ok(!hashes.includes(code));
  assert.equal(system.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'mfa.enabled'").get().count, 1);

  assert.equal((await admin.get('/api/appointments')).status, 200, 'the enrolling session continues');
  assert.equal((await otherDevice.get('/api/appointments')).status, 401, 'password-only sessions elsewhere are revoked');
});

test('API sign-in requires a fresh second factor and rejects replayed codes', async () => {
  const { system, clock } = createSystem();
  const admin = request.agent(system.app);
  const csrf = (await apiLogin(admin, 'admin@health.local')).body.csrfToken;
  const { secret } = await enroll(admin, csrf, clock);

  const missing = await apiLogin(request(system.app), 'admin@health.local');
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, 'mfa_required');
  const replay = await apiLogin(request(system.app), 'admin@health.local', { otp: totp(secret, clock.now) });
  assert.equal(replay.status, 401, 'the code used for enrolment cannot be reused');
  assert.equal((await apiLogin(request(system.app), 'admin@health.local', { password: 'wrong', otp: '123456' })).status, 401);

  clock.now += 30_000;
  const fresh = await apiLogin(request(system.app), 'admin@health.local', { otp: totp(secret, clock.now) });
  assert.equal(fresh.status, 200);
  assert.equal((await apiLogin(request(system.app), 'admin@health.local', { otp: totp(secret, clock.now) })).status, 401, 'each code works once');
});

test('browser sign-in asks for the code on a separate step and locks after five wrong codes', async () => {
  const { system, clock } = createSystem();
  const setupAgent = request.agent(system.app);
  const csrf = (await apiLogin(setupAgent, 'doctor@health.local')).body.csrfToken;
  const { secret } = await enroll(setupAgent, csrf, clock);
  clock.now += 30_000;

  const browser = request.agent(system.app);
  const passwordStep = await browserPasswordStep(browser, 'doctor', 'doctor@health.local');
  assert.equal(passwordStep.status, 302);
  assert.equal(passwordStep.headers.location, '/auth/mfa');
  assert.doesNotMatch(String(passwordStep.headers['set-cookie']), /health_session=[0-9a-f]/, 'no session before the second factor');
  assert.equal((await browser.get('/dashboard')).status, 302, 'a pending sign-in is not a session');

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const wrong = await submitChallenge(browser, { code: '000000' });
    assert.equal(wrong.status, 401);
    assert.match(wrong.text, new RegExp(`${5 - attempt} attempt`));
  }
  const locked = await submitChallenge(browser, { code: '000000' });
  assert.equal(locked.status, 302);
  assert.equal(locked.headers.location, '/login');
  assert.equal((await browser.get('/auth/mfa')).headers.location, '/login', 'the locked sign-in cannot be resumed');
  assert.equal(system.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'mfa.challenge_locked'").get().count, 1);

  await browserPasswordStep(browser, 'doctor', 'doctor@health.local');
  const success = await submitChallenge(browser, { code: totp(secret, clock.now) });
  assert.equal(success.status, 302);
  assert.equal(success.headers.location, '/dashboard');
  assert.match(String(success.headers['set-cookie']), /health_session=[0-9a-f]{64}/);
  assert.equal((await browser.get('/dashboard')).status, 200);
});

test('recovery codes sign in exactly once and can be regenerated', async () => {
  const { system, clock } = createSystem();
  const setupAgent = request.agent(system.app);
  const csrf = (await apiLogin(setupAgent, 'admin@health.local')).body.csrfToken;
  const { secret, recoveryCodes } = await enroll(setupAgent, csrf, clock);

  const browser = request.agent(system.app);
  await browserPasswordStep(browser, 'admin', 'admin@health.local');
  const used = await submitChallenge(browser, { recoveryCode: recoveryCodes[0].toUpperCase() });
  assert.equal(used.status, 302);
  assert.equal(used.headers.location, '/dashboard');
  assert.match((await browser.get('/dashboard')).text, /Signed in with a recovery code\. 9 recovery codes left/);

  const again = request.agent(system.app);
  await browserPasswordStep(again, 'admin', 'admin@health.local');
  assert.equal((await submitChallenge(again, { recoveryCode: recoveryCodes[0] })).status, 401);

  clock.now += 30_000;
  const regenerated = await setupAgent.post('/account/mfa/recovery-codes').set('Accept', 'application/json').set('x-csrf-token', csrf).send({ code: totp(secret, clock.now) });
  assert.equal(regenerated.status, 200);
  assert.equal(regenerated.body.recoveryCodes.length, 10);
  const stale = await apiLogin(request(system.app), 'admin@health.local', { recoveryCode: recoveryCodes[1] });
  assert.equal(stale.status, 401, 'old recovery codes stop working');
  assert.equal((await apiLogin(request(system.app), 'admin@health.local', { recoveryCode: regenerated.body.recoveryCodes[0] })).status, 200);
});

test('patients may opt in and out; staff cannot turn required MFA off', async () => {
  const { system, clock } = createSystem();
  const patient = request.agent(system.app);
  const patientCsrf = (await apiLogin(patient, 'patient@health.local')).body.csrfToken;
  assert.equal((await patient.get('/api/appointments')).status, 200, 'patients are not forced to enrol');
  const { secret } = await enroll(patient, patientCsrf, clock);
  assert.equal((await patient.post('/account/mfa/disable').set('Accept', 'application/json').set('x-csrf-token', patientCsrf).send({ code: '000000' })).status, 400);
  clock.now += 30_000;
  assert.equal((await patient.post('/account/mfa/disable').set('Accept', 'application/json').set('x-csrf-token', patientCsrf).send({ code: totp(secret, clock.now) })).status, 204);
  assert.equal((await apiLogin(request(system.app), 'patient@health.local')).status, 200);

  const doctor = request.agent(system.app);
  const doctorCsrf = (await apiLogin(doctor, 'doctor@health.local')).body.csrfToken;
  const doctorMfa = await enroll(doctor, doctorCsrf, clock);
  clock.now += 30_000;
  const refused = await doctor.post('/account/mfa/disable').set('Accept', 'application/json').set('x-csrf-token', doctorCsrf).send({ code: totp(doctorMfa.secret, clock.now) });
  assert.equal(refused.status, 409);
  assert.equal((await doctor.post('/account/mfa/enable').set('Accept', 'application/json').send({ code: '123456' })).status, 403, 'CSRF is enforced');
});

test('administrators can reset another user’s MFA, which signs that user out, but not their own', async () => {
  const { system, clock } = createSystem();
  const admin = request.agent(system.app);
  const adminCsrf = (await apiLogin(admin, 'admin@health.local')).body.csrfToken;
  await enroll(admin, adminCsrf, clock);
  const doctor = request.agent(system.app);
  const doctorCsrf = (await apiLogin(doctor, 'doctor@health.local')).body.csrfToken;
  await enroll(doctor, doctorCsrf, clock);
  const doctorId = system.db.prepare("SELECT id FROM users WHERE email = 'doctor@health.local'").get().id;
  const adminId = system.db.prepare("SELECT id FROM users WHERE email = 'admin@health.local'").get().id;

  const listing = await admin.get('/admin/accounts').set('Accept', 'text/html');
  assert.match(listing.text, /Reset 2FA<span class="sr-only"> for Dr\. Demo<\/span>/);
  assert.equal((await doctor.post(`/admin/accounts/${adminId}/reset-mfa`).set('Accept', 'application/json').set('x-csrf-token', doctorCsrf)).status, 403);
  assert.equal((await admin.post(`/admin/accounts/${adminId}/reset-mfa`).set('Accept', 'application/json').set('x-csrf-token', adminCsrf)).status, 409);

  const reset = await admin.post(`/admin/accounts/${doctorId}/reset-mfa`).set('Accept', 'application/json').set('x-csrf-token', adminCsrf);
  assert.equal(reset.status, 200);
  assert.equal(reset.body.reset, true);
  assert.equal(system.db.prepare('SELECT COUNT(*) AS count FROM user_mfa WHERE user_id = ?').get(doctorId).count, 0);
  assert.equal((await doctor.get('/api/appointments')).status, 401, 'the doctor is signed out everywhere');
  assert.equal(system.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'mfa.reset'").get().count, 1);
  const again = request.agent(system.app);
  assert.equal((await apiLogin(again, 'doctor@health.local')).status, 200);
  assert.equal((await again.get('/api/appointments')).body.error, 'mfa_enrollment_required', 'the doctor must enrol again');
});
