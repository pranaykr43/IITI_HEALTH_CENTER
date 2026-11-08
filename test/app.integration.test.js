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
  const ready = await request(system.app).get('/readyz');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.database, 'ok');
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

test('outbox processing is resumable and does not redeliver delivered events', async () => {
  const system = createTestSystem();
  const patient = request.agent(system.app);
  const csrf = await login(patient, 'patient@health.local');
  await patient.post('/api/appointments').set('x-csrf-token', csrf).set('idempotency-key', 'outbox-1').send({ phone: '9508532340', age: 19, symptoms: 'Persistent fever', daysWithSymptoms: 3 });
  system.db.prepare("UPDATE outbox_events SET status = 'processing', available_at = '2000-01-01T00:00:00.000Z'").run();
  const first = system.appointments.processOutboxOnce();
  assert.ok(first);
  assert.equal(system.appointments.listOutbox()[0].status, 'delivered');
  assert.equal(system.appointments.processOutboxOnce(), null);
  system.close();
  openSystems.delete(system);
});
