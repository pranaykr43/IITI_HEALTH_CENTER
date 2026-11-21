const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');
const { loadConfig } = require('../src/config');
const { parseScheduleInput, parseAvailableDays, formatClinicDateTime } = require('../src/domain/clinic-time');
const { createHousekeepingService, DAY_MS } = require('../src/services/housekeeping-service');

const PASSWORD = 'ChangeMe123!';
const openSystems = new Set();
test.afterEach(() => {
  for (const system of openSystems) system.close();
  openSystems.clear();
});

function createSystem(extra = {}) {
  const system = createApp({ config: { dbPath: ':memory:', nodeEnv: 'test', logLevel: 'silent', ...extra.config }, ...extra.options });
  seedDemoData({ db: system.db, config: system.config });
  openSystems.add(system);
  return system;
}

async function login(agent, email, password = PASSWORD) {
  const response = await agent.post('/api/auth/login').send({ email, password });
  assert.equal(response.status, 200, `login failed for ${email}`);
  return response.body.csrfToken;
}

async function requestAppointment(agent, csrf, key = crypto.randomUUID()) {
  const response = await agent.post('/api/appointments').set('x-csrf-token', csrf).set('Idempotency-Key', key)
    .send({ phone: '9000000000', age: 30, symptoms: 'Synthetic confidential symptom', daysWithSymptoms: 2 });
  assert.equal(response.status, 201);
  return response.body.appointment;
}

async function scheduledSetup() {
  const system = createSystem();
  const patient = request.agent(system.app);
  const admin = request.agent(system.app);
  const patientCsrf = await login(patient, 'patient@health.local');
  const adminCsrf = await login(admin, 'admin@health.local');
  const doctorId = system.db.prepare('SELECT id FROM doctors').get().id;
  const schedule = (appointmentId, scheduledFor) => admin.post(`/api/admin/appointments/${appointmentId}/schedule`)
    .set('x-csrf-token', adminCsrf).send({ doctorId, scheduledFor });
  return { system, patient, admin, patientCsrf, adminCsrf, doctorId, schedule };
}

test('wall-clock schedule input is interpreted in the clinic time zone, not the server zone', () => {
  assert.equal(parseScheduleInput('2030-01-01T10:30', 'Asia/Kolkata').toISOString(), '2030-01-01T05:00:00.000Z');
  assert.equal(parseScheduleInput('2030-01-01T10:30', 'UTC').toISOString(), '2030-01-01T10:30:00.000Z');
  assert.equal(parseScheduleInput('2030-01-01T10:00:00.000Z', 'Asia/Kolkata').toISOString(), '2030-01-01T10:00:00.000Z');
  assert.equal(parseScheduleInput('2030-07-01T09:00', 'America/New_York').toISOString(), '2030-07-01T13:00:00.000Z');
  assert.throws(() => parseScheduleInput('2030-03-10T02:30', 'America/New_York'), /does not exist/);
  assert.throws(() => parseScheduleInput('tomorrow at ten', 'Asia/Kolkata'), /valid scheduled time/);
  assert.match(formatClinicDateTime('2030-01-01T05:00:00.000Z', 'Asia/Kolkata'), /10:30/);
});

test('doctor availability text is parsed conservatively', () => {
  assert.deepEqual([...parseAvailableDays('Monday-Friday')], ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
  assert.deepEqual([...parseAvailableDays('Mon, Wed and Fri')], ['Monday', 'Wednesday', 'Friday']);
  assert.deepEqual([...parseAvailableDays('Friday to Monday')], ['Friday', 'Saturday', 'Sunday', 'Monday']);
  assert.equal(parseAvailableDays('whenever possible'), null);
  assert.equal(parseAvailableDays(''), null);
});

test('scheduling enforces aligned slots, doctor hours, working days and active doctors', async () => {
  const { system, patient, patientCsrf, admin, adminCsrf, schedule } = await scheduledSetup();
  const first = await requestAppointment(patient, patientCsrf);
  const second = await requestAppointment(patient, patientCsrf);

  // 2030-01-01 is a Tuesday. The seeded doctor works Monday-Friday 09:00-17:00 clinic time.
  const misaligned = await schedule(first.id, '2030-01-01T10:05');
  assert.equal(misaligned.status, 400);
  assert.match(misaligned.body.message, /15-minute slot/);
  assert.equal((await schedule(first.id, '2030-01-01T08:45')).status, 400);
  assert.equal((await schedule(first.id, '2030-01-01T16:50')).status, 400);
  const weekend = await schedule(first.id, '2030-01-05T10:00');
  assert.equal(weekend.status, 400);
  assert.match(weekend.body.message, /not available on Saturdays/);

  const booked = await schedule(first.id, '2030-01-01T10:30');
  assert.equal(booked.status, 200);
  assert.equal(booked.body.appointment.scheduledFor, '2030-01-01T05:00:00.000Z');
  // An overlapping request inside the same slot cannot be expressed, and the same slot collides.
  assert.equal((await schedule(second.id, '2030-01-01T10:35')).status, 400);
  assert.equal((await schedule(second.id, '2030-01-01T05:00:00.000Z')).status, 409);

  const doctorUserId = system.db.prepare("SELECT id FROM users WHERE email = 'doctor@health.local'").get().id;
  const disabled = await admin.post(`/api/admin/accounts/${doctorUserId}/disable`).set('x-csrf-token', adminCsrf);
  assert.equal(disabled.status, 404, 'admin account actions are browser routes, not /api routes');
  await admin.post(`/admin/accounts/${doctorUserId}/disable`).set('Accept', 'application/json').set('x-csrf-token', adminCsrf).expect(200);
  const toDisabledDoctor = await schedule(second.id, '2030-01-01T11:00');
  assert.equal(toDisabledDoctor.status, 409);
  assert.match(toDisabledDoctor.body.message, /disabled/);
  assert.equal((await admin.get('/api/doctors')).body.doctors.length, 0);
});

test('notification outbox payloads carry identifiers only, never clinical details', async () => {
  const { system, patient, patientCsrf, schedule } = await scheduledSetup();
  const appointment = await requestAppointment(patient, patientCsrf);
  await schedule(appointment.id, '2030-01-01T10:00:00.000Z');
  const payloads = system.db.prepare('SELECT payload_json FROM outbox_events').all().map((row) => row.payload_json);
  assert.equal(payloads.length, 2);
  for (const payload of payloads) {
    assert.doesNotMatch(payload, /Synthetic confidential symptom|9000000000|prescription|symptoms|patientPhone/);
    assert.equal(JSON.parse(payload).appointmentId, appointment.id);
  }
});

test('session tokens are stored only as SHA-256 digests', async () => {
  const system = createSystem();
  const agent = request.agent(system.app);
  const response = await agent.post('/api/auth/login').send({ email: 'patient@health.local', password: PASSWORD });
  const token = /health_session=([0-9a-f]{64})/.exec(String(response.headers['set-cookie']))[1];
  const stored = system.db.prepare('SELECT id FROM sessions').all().map((row) => row.id);
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0], token);
  assert.equal(stored[0], crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(system.auth.getSession(stored[0]), null, 'the stored digest is not itself a usable session token');
  assert.equal((await agent.get('/api/appointments')).status, 200);
});

test('failed sign-ins are throttled per client and email while successful sign-ins are not counted', async () => {
  const system = createSystem({ options: { loginAttemptLimit: 3 } });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await request(system.app).post('/api/auth/login').send({ email: 'admin@health.local', password: PASSWORD })).status, 200);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await request(system.app).post('/api/auth/login').send({ email: 'patient@health.local', password: 'wrong-password' })).status, 401);
  }
  const blocked = await request(system.app).post('/api/auth/login').send({ email: 'patient@health.local', password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.equal((await request(system.app).post('/api/auth/login').send({ email: 'doctor@health.local', password: PASSWORD })).status, 200);
  assert.equal((await request(system.app).post('/api/auth/login').send({ email: 'nobody@health.local', password: PASSWORD })).status, 401);
});

test('metrics require a bearer token when configured and are hidden in production without one', async () => {
  const productionConfig = { dbPath: ':memory:', nodeEnv: 'production', mfaEncryptionKey: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=', demoMode: true, cookieSecure: true, trustProxyHops: 1, publicBaseUrl: 'https://health.example', logLevel: 'silent' };
  const hidden = createApp({ config: productionConfig });
  openSystems.add(hidden);
  assert.equal((await request(hidden.app).get('/metrics')).status, 404);

  const token = 'm'.repeat(40);
  const protectedSystem = createApp({ config: { ...productionConfig, metricsToken: token } });
  openSystems.add(protectedSystem);
  assert.equal((await request(protectedSystem.app).get('/metrics')).status, 401);
  assert.equal((await request(protectedSystem.app).get('/metrics').set('Authorization', `Bearer ${'x'.repeat(40)}`)).status, 401);
  const scraped = await request(protectedSystem.app).get('/metrics').set('Authorization', `Bearer ${token}`);
  assert.equal(scraped.status, 200);
  assert.match(scraped.text, /health_centre_outbox_events\{status="dead"\} 0/);
  assert.match(scraped.text, /health_centre_worker_heartbeat_age_seconds -1/);
});

test('status messages cannot be injected through the URL and survive a single redirect only', async () => {
  const { patient, patientCsrf, admin, adminCsrf } = await scheduledSetup();
  const phishing = await patient.get('/dashboard?message=Call%20555-0100%20to%20verify%20your%20account&error=Account%20locked');
  assert.equal(phishing.status, 200);
  assert.doesNotMatch(phishing.text, /555-0100|Account locked/);

  const appointment = await requestAppointment(patient, patientCsrf);
  const misaligned = await admin.post(`/admin/appointments/${appointment.id}/schedule`).type('form')
    .send({ _csrf: adminCsrf, doctorId: '1', scheduledFor: '2030-01-01T10:07' });
  assert.equal(misaligned.status, 302);
  assert.equal(misaligned.headers.location, '/dashboard');
  const withFlash = await admin.get('/dashboard');
  assert.match(withFlash.text, /role="alert">[\s\S]{0,400}Scheduled time must start on a 15-minute slot boundary/);
  assert.doesNotMatch((await admin.get('/dashboard')).text, /slot boundary/);

  const forbidden = await patient.post(`/admin/appointments/${appointment.id}/schedule`).type('form')
    .send({ _csrf: patientCsrf, doctorId: '1', scheduledFor: '2030-01-01T10:00' });
  assert.equal(forbidden.status, 403);
});

test('login page ignores error text supplied in the query string', async () => {
  const system = createSystem();
  const page = await request(system.app).get('/login/patient?error=Your%20account%20is%20suspended&message=Spoofed');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /suspended|Spoofed/);
});

test('housekeeping removes expired credentials and aged operational rows but keeps live data', () => {
  const system = createSystem();
  const { db } = system;
  const nowMs = Date.parse('2030-06-01T00:00:00.000Z');
  const iso = (offsetMs) => new Date(nowMs + offsetMs).toISOString();
  const patientId = db.prepare("SELECT id FROM users WHERE email = 'patient@health.local'").get().id;
  const insertSession = db.prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)');
  insertSession.run('expired', patientId, 'c', iso(-1000), iso(-DAY_MS));
  insertSession.run('live', patientId, 'c', iso(DAY_MS), iso(-1000));
  const insertToken = db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at, used_at) VALUES (?, ?, ?, ?, ?)');
  insertToken.run(patientId, 'old-used', iso(-2 * DAY_MS), iso(-3 * DAY_MS), iso(-3 * DAY_MS));
  insertToken.run(patientId, 'fresh', iso(DAY_MS), iso(-1000), null);
  const insertKey = db.prepare('INSERT INTO idempotency_keys (key, actor_user_id, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)');
  insertKey.run('old', patientId, 'h', '{}', iso(-8 * DAY_MS));
  insertKey.run('recent', patientId, 'h', '{}', iso(-DAY_MS));
  const insertEvent = db.prepare(`INSERT INTO outbox_events (event_id, event_type, aggregate_id, payload_json, status, available_at, created_at, delivered_at)
    VALUES (?, 'test', 'a', '{}', ?, ?, ?, ?)`);
  insertEvent.run('old-delivered', 'delivered', iso(-40 * DAY_MS), iso(-40 * DAY_MS), iso(-40 * DAY_MS));
  insertEvent.run('old-dead', 'dead', iso(-40 * DAY_MS), iso(-40 * DAY_MS), null);
  insertEvent.run('recent-delivered', 'delivered', iso(-DAY_MS), iso(-DAY_MS), iso(-DAY_MS));

  const removed = createHousekeepingService(db, { now: () => nowMs }).run();
  assert.deepEqual(removed, { sessions: 1, passwordResetTokens: 1, oauthTransactions: 0, mfaPendingLogins: 0, idempotencyKeys: 1, deliveredEvents: 1 });
  assert.deepEqual(db.prepare('SELECT id FROM sessions').all().map((row) => row.id), ['live']);
  assert.deepEqual(db.prepare('SELECT token_hash FROM password_reset_tokens').all().map((row) => row.token_hash), ['fresh']);
  assert.deepEqual(db.prepare('SELECT key FROM idempotency_keys').all().map((row) => row.key), ['recent']);
  assert.deepEqual(db.prepare('SELECT event_id FROM outbox_events ORDER BY id').all().map((row) => row.event_id), ['old-dead', 'recent-delivered']);
});

test('configuration validates clinic time zone, slot length and metrics token', () => {
  assert.equal(loadConfig({ nodeEnv: 'test' }).clinicTimeZone, 'Asia/Kolkata');
  assert.throws(() => loadConfig({ nodeEnv: 'test', clinicTimeZone: 'Mars/Olympus' }), /CLINIC_TIMEZONE/);
  assert.throws(() => loadConfig({ nodeEnv: 'test', slotMinutes: 7 }), /APPOINTMENT_SLOT_MINUTES/);
  assert.throws(() => loadConfig({ nodeEnv: 'test', metricsToken: 'short' }), /METRICS_TOKEN/);
  assert.equal(loadConfig({ nodeEnv: 'test', metricsToken: '' }).metricsToken, null);
});

test('signed-out browser visits to role pages redirect to sign-in while API calls stay 401', async () => {
  const system = createSystem();
  const page = await request(system.app).get('/appointments/new').set('Accept', 'text/html');
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login');
  assert.equal((await request(system.app).get('/api/appointments')).status, 401);
  assert.equal((await request(system.app).post('/appointments').type('form').send({})).status, 401);
});

test('schema migration 5 revokes raw sessions and scrubs clinical data from existing outbox rows', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { openDatabase, CURRENT_SCHEMA_VERSION } = require('../src/db');
  const cleanup = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-migration-5-'));
  const dbPath = path.join(dir, 'v4.sqlite');
  try {
    const initial = openDatabase(dbPath);
    initial.pragma('user_version = 4');
    initial.prepare("INSERT INTO users (email, name, role, password_hash, created_at) VALUES ('p@example.test', 'P', 'patient', 'x', '2030-01-01T00:00:00.000Z')").run();
    initial.prepare("INSERT INTO sessions (id, user_id, csrf_token, expires_at, created_at) VALUES ('raw-token', 1, 'c', '2099-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')").run();
    const legacyPayload = JSON.stringify({ id: 'appt-1', patientId: 1, doctorId: null, status: 'requested', scheduledFor: null, version: 0, symptoms: 'Synthetic legacy symptom', patientPhone: '9000000000', prescription: { medicine: 'x' } });
    initial.prepare("INSERT INTO outbox_events (event_id, event_type, aggregate_id, payload_json, available_at, created_at) VALUES ('e1', 'appointment.requested', 'appt-1', ?, '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')").run(legacyPayload);
    initial.close();

    const migrated = openDatabase(dbPath);
    cleanup.push(() => migrated.open && migrated.close());
    assert.equal(migrated.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    const payload = migrated.prepare("SELECT payload_json FROM outbox_events WHERE event_id = 'e1'").get().payload_json;
    assert.doesNotMatch(payload, /Synthetic legacy symptom|9000000000|prescription/);
    assert.deepEqual(JSON.parse(payload), { appointmentId: 'appt-1', patientId: 1, doctorId: null, status: 'requested', scheduledFor: null, version: 0 });
    migrated.close();
  } finally {
    for (const fn of cleanup) fn();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
