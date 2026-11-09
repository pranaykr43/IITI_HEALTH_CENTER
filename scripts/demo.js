const assert = require('node:assert/strict');
const request = require('supertest');
const pino = require('pino');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');

async function main() {
  const system = createApp({
    config: { dbPath: ':memory:', nodeEnv: 'demo', logLevel: 'silent' },
    logger: pino({ level: 'silent' }),
  });
  seedDemoData({ db: system.db, config: system.config });
  const patient = request.agent(system.app);
  const admin = request.agent(system.app);
  const patientLogin = await patient.post('/api/auth/login').send({ email: 'patient@health.local', password: 'ChangeMe123!' });
  const adminLogin = await admin.post('/api/auth/login').send({ email: 'admin@health.local', password: 'ChangeMe123!' });
  assert.equal(patientLogin.status, 200);
  assert.equal(adminLogin.status, 200);

  const payload = { phone: '9508532340', age: 19, symptoms: 'A deterministic demo symptom', daysWithSymptoms: 2 };
  const first = await patient.post('/api/appointments').set('x-csrf-token', patientLogin.body.csrfToken).set('idempotency-key', 'demo-retry').send(payload);
  const replay = await patient.post('/api/appointments').set('x-csrf-token', patientLogin.body.csrfToken).set('idempotency-key', 'demo-retry').send(payload);
  const second = await patient.post('/api/appointments').set('x-csrf-token', patientLogin.body.csrfToken).set('idempotency-key', 'demo-second').send({ ...payload, symptoms: 'A second deterministic demo symptom' });
  const doctorId = system.appointments.listDoctors()[0].id;
  const schedule = await admin.post(`/api/admin/appointments/${first.body.appointment.id}/schedule`).set('x-csrf-token', adminLogin.body.csrfToken).send({ doctorId, scheduledFor: '2030-01-01T10:00:00.000Z' });
  const collision = await admin.post(`/api/admin/appointments/${second.body.appointment.id}/schedule`).set('x-csrf-token', adminLogin.body.csrfToken).send({ doctorId, scheduledFor: '2030-01-01T10:00:00.000Z' });
  const processed = [];
  const adapter = { async deliver(event) { processed.push(event.eventId); } };
  let event = await system.appointments.processOutboxOnce({ adapter });
  while (event) {
    event = await system.appointments.processOutboxOnce({ adapter });
  }

  console.log(JSON.stringify({
    retryReturnedSameAppointment: replay.body.appointment.id === first.body.appointment.id && replay.body.replayed === true,
    firstScheduleStatus: schedule.status,
    duplicateSlotStatus: collision.status,
    persistedAppointments: system.appointments.countAppointments(),
    outboxEventsProcessedBySyntheticAdapter: processed.length,
  }, null, 2));
  system.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
