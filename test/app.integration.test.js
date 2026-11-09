const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');

const openSystems = new Set();
test.afterEach(() => {
  for (const system of openSystems) system.close();
  openSystems.clear();
});

function createTestSystem() {
  const system = createApp({ config: { dbPath: ':memory:', nodeEnv: 'test', logLevel: 'silent' } });
  seedDemoData({ db: system.db, config: system.config });
  openSystems.add(system);
  return system;
}

async function login(agent, email, password = 'ChangeMe123!') {
  const response = await agent.post('/api/auth/login').send({ email, password });
  assert.equal(response.status, 200);
  return response.body.csrfToken;
}

test('health and readiness endpoints expose a usable service', async () => {
  const system = createTestSystem();
  const health = await request(system.app).get('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.headers['strict-transport-security'], undefined);
  assert.doesNotMatch(health.headers['content-security-policy'], /upgrade-insecure-requests/);
  const ready = await request(system.app).get('/readyz');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.database, 'ok');
});

test('production security headers retain HTTPS enforcement', async () => {
  const system = createApp({ config: { dbPath: ':memory:', nodeEnv: 'production', cookieSecure: true, logLevel: 'silent' } });
  try {
    const health = await request(system.app).get('/healthz');
    assert.equal(health.status, 200);
    assert.match(health.headers['strict-transport-security'], /max-age=/);
    assert.match(health.headers['content-security-policy'], /upgrade-insecure-requests/);
  } finally {
    system.close();
  }
});

test('active browser surface renders real navigation and authenticated dashboard', async () => {
  const system = createTestSystem();
  const home = await request(system.app).get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Appointment coordination/);
  const patient = request.agent(system.app);
  const csrf = await login(patient, 'patient@health.local');
  const dashboard = await patient.get('/dashboard');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Your appointments/);
  assert.match(dashboard.text, new RegExp(csrf));
});

test('patient booking is idempotent and persists an outbox event', async () => {
  const system = createTestSystem();
  const patient = request.agent(system.app);
  const csrf = await login(patient, 'patient@health.local');
  const booking = {
    phone: '9508532340',
    age: 19,
    symptoms: 'Persistent fever',
    daysWithSymptoms: 3,
  };
  const first = await patient.post('/api/appointments')
    .set('x-csrf-token', csrf)
    .set('idempotency-key', 'booking-retry-1')
    .send(booking);
  assert.equal(first.status, 201);
  const second = await patient.post('/api/appointments')
    .set('x-csrf-token', csrf)
    .set('idempotency-key', 'booking-retry-1')
    .send(booking);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.appointment.id, first.body.appointment.id);
  assert.equal(system.appointments.countAppointments(), 1);
  assert.equal(system.appointments.listOutbox()[0].status, 'pending');
});

test('reusing an idempotency key with a different payload is rejected', async () => {
  const system = createTestSystem();
  const patient = request.agent(system.app);
  const csrf = await login(patient, 'patient@health.local');
  const base = { phone: '9508532340', age: 19, symptoms: 'Persistent fever', daysWithSymptoms: 3 };
  assert.equal((await patient.post('/api/appointments').set('x-csrf-token', csrf).set('idempotency-key', 'same-key').send(base)).status, 201);
  const conflict = await patient.post('/api/appointments')
    .set('x-csrf-token', csrf)
    .set('idempotency-key', 'same-key')
    .send({ ...base, age: 20 });
  assert.equal(conflict.status, 409);
  assert.equal(system.appointments.countAppointments(), 1);
});

test('database uniqueness prevents double booking of a doctor slot', async () => {
  const system = createTestSystem();
  const patient = request.agent(system.app);
  const admin = request.agent(system.app);
  const patientCsrf = await login(patient, 'patient@health.local');
  const adminCsrf = await login(admin, 'admin@health.local');
  const first = await patient.post('/api/appointments').set('x-csrf-token', patientCsrf).set('idempotency-key', 'slot-1').send({ phone: '9508532340', age: 19, symptoms: 'Persistent fever', daysWithSymptoms: 3 });
  const second = await patient.post('/api/appointments').set('x-csrf-token', patientCsrf).set('idempotency-key', 'slot-2').send({ phone: '9508532340', age: 19, symptoms: 'Persistent cough', daysWithSymptoms: 4 });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const doctorId = system.appointments.listDoctors()[0].id;
  const scheduledFor = '2030-01-01T10:00:00.000Z';
  const pastSchedule = await admin.post(`/api/admin/appointments/${first.body.appointment.id}/schedule`).set('x-csrf-token', adminCsrf).send({ doctorId, scheduledFor: '2020-01-01T10:00:00.000Z' });
  assert.equal(pastSchedule.status, 400);
  const firstSchedule = await admin.post(`/api/admin/appointments/${first.body.appointment.id}/schedule`).set('x-csrf-token', adminCsrf).send({ doctorId, scheduledFor });
  assert.equal(firstSchedule.status, 200);
  const duplicate = await admin.post(`/api/admin/appointments/${second.body.appointment.id}/schedule`).set('x-csrf-token', adminCsrf).send({ doctorId, scheduledFor });
  assert.equal(duplicate.status, 409);
  assert.equal(system.appointments.listForActor({ id: 1, role: 'admin' }).filter((item) => item.status === 'confirmed').length, 1);
});

test('concurrent administrators cannot confirm the same doctor slot twice', async () => {
  const system = createTestSystem();
  const patient = request.agent(system.app);
  const firstAdmin = request.agent(system.app);
  const secondAdmin = request.agent(system.app);
  const patientCsrf = await login(patient, 'patient@health.local');
  const firstAdminCsrf = await login(firstAdmin, 'admin@health.local');
  const secondAdminCsrf = await login(secondAdmin, 'admin@health.local');
  const booking = { phone: '9508532340', age: 19, symptoms: 'Synthetic scheduling test', daysWithSymptoms: 1 };
  const first = await patient.post('/api/appointments').set('x-csrf-token', patientCsrf).set('idempotency-key', 'concurrent-slot-1').send(booking);
  const second = await patient.post('/api/appointments').set('x-csrf-token', patientCsrf).set('idempotency-key', 'concurrent-slot-2').send({ ...booking, symptoms: 'Second synthetic booking' });
  const doctorId = system.appointments.listDoctors()[0].id;
  const scheduledFor = '2030-01-02T10:00:00.000Z';

  const responses = await Promise.all([
    firstAdmin.post(`/api/admin/appointments/${first.body.appointment.id}/schedule`).set('x-csrf-token', firstAdminCsrf).send({ doctorId, scheduledFor }),
    secondAdmin.post(`/api/admin/appointments/${second.body.appointment.id}/schedule`).set('x-csrf-token', secondAdminCsrf).send({ doctorId, scheduledFor }),
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const appointments = system.appointments.listForActor({ id: 1, role: 'admin' });
  assert.equal(appointments.filter((appointment) => appointment.status === 'confirmed').length, 1);
  assert.equal(appointments.filter((appointment) => appointment.status === 'requested').length, 1);
});

test('ownership and role boundaries reject unauthorized mutations', async () => {
  const system = createTestSystem();
  const patient = request.agent(system.app);
  const csrf = await login(patient, 'patient@health.local');
  const appointment = await patient.post('/api/appointments').set('x-csrf-token', csrf).set('idempotency-key', 'ownership-1').send({ phone: '9508532340', age: 19, symptoms: 'Persistent fever', daysWithSymptoms: 3 });
  const forbidden = await patient.post(`/api/admin/appointments/${appointment.body.appointment.id}/schedule`).set('x-csrf-token', csrf).send({ doctorId: 1, scheduledFor: '2030-01-01T10:00:00.000Z' });
  assert.equal(forbidden.status, 403);
  const invalidCsrf = await patient.post('/api/appointments').set('idempotency-key', 'ownership-2').send({ phone: '9508532340', age: 19, symptoms: 'Persistent fever', daysWithSymptoms: 3 });
  assert.equal(invalidCsrf.status, 403);
});

test('doctor completion is one transaction and records prescription data', async () => {
  const system = createTestSystem();
  const patient = request.agent(system.app);
  const admin = request.agent(system.app);
  const doctor = request.agent(system.app);
  const patientCsrf = await login(patient, 'patient@health.local');
  const adminCsrf = await login(admin, 'admin@health.local');
  const doctorCsrf = await login(doctor, 'doctor@health.local');
  const created = await patient.post('/api/appointments').set('x-csrf-token', patientCsrf).set('idempotency-key', 'complete-1').send({ phone: '9508532340', age: 19, symptoms: 'Persistent fever', daysWithSymptoms: 3 });
  const doctorId = system.appointments.listDoctors()[0].id;
  await admin.post(`/api/admin/appointments/${created.body.appointment.id}/schedule`).set('x-csrf-token', adminCsrf).send({ doctorId, scheduledFor: '2030-01-01T10:00:00.000Z' });
  const completed = await doctor.post(`/api/doctor/appointments/${created.body.appointment.id}/complete`).set('x-csrf-token', doctorCsrf).send({ test: 'CBC', medicine: 'Rest', advice: 'Hydrate' });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.appointment.status, 'completed');
  assert.equal(completed.body.appointment.prescription.test, 'CBC');
  assert.equal(system.appointments.listOutbox().filter((event) => event.aggregateId === created.body.appointment.id).length, 3);
});

test('outbox processing reclaims expired leases and does not repeat delivered events', async () => {
  const system = createTestSystem();
  const patient = request.agent(system.app);
  const csrf = await login(patient, 'patient@health.local');
  await patient.post('/api/appointments').set('x-csrf-token', csrf).set('idempotency-key', 'outbox-1').send({ phone: '9508532340', age: 19, symptoms: 'Persistent fever', daysWithSymptoms: 3 });
  system.db.prepare("UPDATE outbox_events SET status = 'processing', attempts = 1, claim_token = 'simulated-worker', lease_expires_at = '2999-01-01T00:00:00.000Z'").run();
  const adapter = { async deliver() {} };
  const clock = () => Date.parse('2026-11-09T00:00:00.000Z');
  assert.equal(await system.appointments.processOutboxOnce({ adapter, now: clock }), null);
  system.db.prepare("UPDATE outbox_events SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE status = 'processing'").run();
  const first = await system.appointments.processOutboxOnce({ adapter, now: clock });
  assert.equal(first.status, 'delivered');
  assert.equal(system.appointments.listOutbox()[0].status, 'delivered');
  assert.equal(system.appointments.listOutbox()[0].attempts, 2);
  assert.equal(await system.appointments.processOutboxOnce({ adapter, now: clock }), null);
  system.close();
  openSystems.delete(system);
});

test('administrator lifecycle provisions accounts, revokes disabled sessions, and protects the last admin', async () => {
  const system = createTestSystem();
  const admin = request.agent(system.app);
  const adminCsrf = await login(admin, 'admin@health.local');
  const created = await admin.post('/admin/accounts').set('Accept', 'application/json').set('x-csrf-token', adminCsrf).send({
    email: ' NEW.DOCTOR@health.local ', name: 'Dr New', password: 'Initial-Strong-Password-42!', role: 'doctor',
  });
  assert.equal(created.status, 201);
  const account = system.db.prepare("SELECT id FROM users WHERE email = 'new.doctor@health.local'").get();
  assert.ok(account);
  assert.equal(system.db.prepare('SELECT COUNT(*) AS count FROM doctors WHERE user_id = ?').get(account.id).count, 1);
  assert.equal(system.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'account.created' AND aggregate_id = ?").get(String(account.id)).count, 1);

  const escalation = await admin.post('/admin/accounts').set('Accept', 'application/json').set('x-csrf-token', adminCsrf).send({
    email: 'escalation@health.local', name: 'Escalation Attempt', password: 'Initial-Strong-Password-42!', role: 'admin',
  });
  assert.equal(escalation.status, 400);
  const missingAdminConfirmation = await admin.post('/admin/accounts/admin').set('Accept', 'application/json').set('x-csrf-token', adminCsrf).send({
    email: 'second-admin@health.local', name: 'Second Admin', password: 'Initial-Strong-Password-42!', role: 'admin',
  });
  assert.equal(missingAdminConfirmation.status, 400);
  const secondAdminResponse = await admin.post('/admin/accounts/admin').set('Accept', 'application/json').set('x-csrf-token', adminCsrf).send({
    email: 'second-admin@health.local', name: 'Second Admin', password: 'Initial-Strong-Password-42!', role: 'admin', confirmAdminCreation: 'yes',
  });
  assert.equal(secondAdminResponse.status, 201);
  const secondAdminId = secondAdminResponse.body.user.id;

  const doctor = request.agent(system.app);
  await login(doctor, 'new.doctor@health.local', 'Initial-Strong-Password-42!');
  const disabled = await admin.post(`/admin/accounts/${account.id}/disable`).set('Accept', 'application/json').set('x-csrf-token', adminCsrf);
  assert.equal(disabled.status, 200);
  assert.equal((await doctor.get('/dashboard')).status, 302);
  assert.equal((await request(system.app).post('/api/auth/login').send({ email: 'new.doctor@health.local', password: 'Initial-Strong-Password-42!' })).status, 401);

  await admin.post(`/admin/accounts/${secondAdminId}/disable`).set('Accept', 'application/json').set('x-csrf-token', adminCsrf);
  const originalAdminId = system.db.prepare("SELECT id FROM users WHERE email = 'admin@health.local'").get().id;
  const lastAdmin = await admin.post(`/admin/accounts/${originalAdminId}/disable`).set('Accept', 'application/json').set('x-csrf-token', adminCsrf);
  assert.equal(lastAdmin.status, 409);
  assert.equal(system.db.prepare("SELECT account_status FROM users WHERE email = 'admin@health.local'").get().account_status, 'active');
});

test('password recovery is generic, single use, revokes old sessions, and never returns the token', async () => {
  let deliveredUrl;
  const system = createApp({
    config: { dbPath: ':memory:', nodeEnv: 'test', logLevel: 'silent' },
    passwordResetAdapter: { async deliver({ resetUrl }) { deliveredUrl = resetUrl; } },
  });
  seedDemoData({ db: system.db, config: system.config });
  openSystems.add(system);
  const patient = request.agent(system.app);
  await login(patient, 'patient@health.local');
  const existingSessionCount = system.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'patient@health.local')").get().count;
  const forgot = await request(system.app).post('/password/forgot').send({ email: 'patient@health.local' });
  assert.equal(forgot.status, 200);
  assert.match(forgot.text, /If an active account matches/);
  assert.doesNotMatch(forgot.text, /token=/);
  const token = new URL(deliveredUrl).searchParams.get('token');
  assert.ok(token);
  const reset = await request(system.app).post('/password/reset').send({ token, password: 'Replacement-Strong-Password-55!', confirmPassword: 'Replacement-Strong-Password-55!' });
  assert.equal(reset.status, 302);
  assert.equal((await patient.get('/dashboard')).status, 302);
  assert.equal((await request(system.app).post('/api/auth/login').send({ email: 'patient@health.local', password: 'Replacement-Strong-Password-55!' })).status, 200);
  assert.equal((await request(system.app).post('/password/reset').send({ token, password: 'Another-Strong-Password-56!', confirmPassword: 'Another-Strong-Password-56!' })).status, 400);
  assert.equal(existingSessionCount, 1);
  assert.equal(system.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'password.reset'").get().count, 1);

  const unknown = await request(system.app).post('/password/forgot').send({ email: 'nobody@health.local' });
  assert.equal(unknown.status, forgot.status);
  assert.match(unknown.text, /If an active account matches/);
});
