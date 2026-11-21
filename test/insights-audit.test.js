const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');
const { createInsightsService } = require('../src/services/insights-service');
const { createAuditService } = require('../src/services/audit-service');

const systems = new Set();
test.afterEach(() => {
  for (const system of systems) system.close();
  systems.clear();
});

function createSystem() {
  const system = createApp({ config: { dbPath: ':memory:', nodeEnv: 'test', logLevel: 'silent', mfaEncryptionKey: crypto.randomBytes(32).toString('base64') } });
  seedDemoData({ db: system.db, config: system.config });
  systems.add(system);
  return system;
}

function insertAppointment(db, { status, requestedAt, scheduledFor = null, doctorId = null }) {
  const patientId = db.prepare("SELECT id FROM users WHERE email = 'patient@health.local'").get().id;
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO appointments (id, patient_id, doctor_id, status, requested_at, scheduled_for, patient_phone, patient_age, symptoms, days_with_symptoms, version)
    VALUES (?, ?, ?, ?, ?, ?, '9000000000', 30, 'Synthetic symptom', 1, 0)`).run(id, patientId, doctorId, status, requestedAt, scheduledFor);
  return id;
}

test('slot board lists aligned slots inside working hours and marks booked ones', () => {
  const system = createSystem();
  const doctorId = system.db.prepare('SELECT id FROM doctors').get().id;
  // Monday 2030-01-07 07:00 IST; the seeded doctor works Monday-Friday 09:00-17:00.
  const nowMs = Date.parse('2030-01-07T01:30:00.000Z');
  insertAppointment(system.db, { status: 'confirmed', requestedAt: '2030-01-06T00:00:00.000Z', scheduledFor: '2030-01-07T05:00:00.000Z', doctorId });
  const insights = createInsightsService(system.db, { clinicTimeZone: 'Asia/Kolkata', slotMinutes: 15, now: () => nowMs });
  const [doctor] = insights.slotBoard(7);
  assert.equal(doctor.id, doctorId);
  assert.deepEqual(doctor.days.map((day) => day.label), ['Mon 7 Jan', 'Tue 8 Jan', 'Wed 9 Jan', 'Thu 10 Jan', 'Fri 11 Jan'], 'weekend days are skipped');
  const monday = doctor.days[0];
  assert.equal(monday.slots.length, 32, '09:00 to 16:45 in 15-minute slots');
  assert.equal(monday.slots[0].value, '2030-01-07T09:00');
  assert.equal(monday.slots.at(-1).value, '2030-01-07T16:45');
  assert.equal(monday.slots.find((slot) => slot.value === '2030-01-07T10:30').taken, true, '05:00Z is 10:30 IST');
  assert.equal(monday.slots.filter((slot) => slot.taken).length, 1);
});

test('requests per day are bucketed by clinic calendar day, including empty days', () => {
  const system = createSystem();
  const nowMs = Date.parse('2030-01-10T12:00:00.000Z'); // 17:30 IST on 10 Jan
  insertAppointment(system.db, { status: 'requested', requestedAt: '2030-01-09T19:00:00.000Z' }); // 00:30 IST on 10 Jan
  insertAppointment(system.db, { status: 'requested', requestedAt: '2030-01-09T17:00:00.000Z' }); // 22:30 IST on 9 Jan
  insertAppointment(system.db, { status: 'cancelled', requestedAt: '2029-12-01T00:00:00.000Z' }); // outside the window
  const buckets = createInsightsService(system.db, { now: () => nowMs }).requestsByDay(14);
  assert.equal(buckets.length, 14);
  assert.equal(buckets.at(-1).date, '2030-01-10');
  assert.equal(buckets.at(-1).count, 1);
  assert.equal(buckets.at(-2).count, 1);
  assert.equal(buckets.reduce((sum, day) => sum + day.count, 0), 2);
});

test('admin overview is bounded and counts the waiting queue oldest first', () => {
  const system = createSystem();
  const nowMs = Date.parse('2030-01-10T12:00:00.000Z');
  for (let index = 0; index < 120; index += 1) {
    insertAppointment(system.db, { status: 'requested', requestedAt: new Date(nowMs - (index + 1) * 60_000).toISOString() });
  }
  const overview = createInsightsService(system.db, { now: () => nowMs }).adminOverview();
  assert.equal(overview.queue.length, 100, 'the queue list is capped');
  assert.equal(overview.counts.waiting, 120, 'counts are not capped');
  assert.ok(Date.parse(overview.queue[0].requestedAt) < Date.parse(overview.queue[1].requestedAt), 'oldest first');
  assert.equal(overview.counts.oldestWaitingHours, 2);
});

test('audit log filters by category, pages by id and shows only allow-listed metadata', () => {
  const system = createSystem();
  const insert = system.db.prepare("INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at) VALUES (NULL, ?, 'user', '1', ?, '2030-01-01T00:00:00.000Z')");
  for (let index = 0; index < 60; index += 1) insert.run('account.created', JSON.stringify({ role: 'patient', password: 'must-not-appear', nested: { a: 1 } }));
  insert.run('mfa.enabled', '{}');
  const audit = createAuditService(system.db);

  const first = audit.list({ limit: 50 });
  assert.equal(first.entries.length, 50);
  assert.ok(first.nextBeforeId);
  const second = audit.list({ limit: 50, beforeId: first.nextBeforeId });
  assert.equal(second.entries.length, 11);
  assert.equal(second.nextBeforeId, null);
  assert.ok(second.entries.every((entry) => entry.id < first.nextBeforeId + 1));

  const mfaOnly = audit.list({ category: 'mfa' });
  assert.deepEqual(mfaOnly.entries.map((entry) => entry.action), ['mfa.enabled']);
  assert.equal(mfaOnly.entries[0].description, 'Turned on two-factor authentication');
  assert.equal(audit.list({ category: 'unknown' }).entries.length, 50, 'unknown categories are ignored');

  const created = first.entries.find((entry) => entry.action === 'account.created');
  assert.deepEqual(created.details, [{ key: 'role', value: 'patient' }]);
  assert.doesNotMatch(JSON.stringify(first), /must-not-appear/);
});

test('admin pages are administrator-only and render for administrators', async () => {
  const system = createSystem();
  const admin = request.agent(system.app);
  const patient = request.agent(system.app);
  assert.equal((await admin.post('/api/auth/login').send({ email: 'admin@health.local', password: 'ChangeMe123!' })).status, 200);
  assert.equal((await patient.post('/api/auth/login').send({ email: 'patient@health.local', password: 'ChangeMe123!' })).status, 200);
  for (const path of ['/admin/accounts', '/admin/notifications', '/admin/audit']) {
    const page = await admin.get(path).set('Accept', 'text/html');
    assert.equal(page.status, 200, path);
    assert.match(page.text, /aria-current="page"/);
    assert.equal((await patient.get(path).set('Accept', 'text/html')).status, 403, path);
  }
  const desk = await admin.get('/dashboard').set('Accept', 'text/html');
  assert.match(desk.text, /data-slot-board="/);
  assert.match(desk.text, /Requests per day, last 14 days/);
  const audit = await admin.get('/admin/audit?category=account&before=abc').set('Accept', 'application/json');
  assert.equal(audit.status, 200);
  assert.ok(Array.isArray(audit.body.entries));
});
