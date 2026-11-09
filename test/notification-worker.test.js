const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');
const { createAppointmentService } = require('../src/services/appointment-service');
const { createConsoleNotificationAdapter } = require('../src/notifications/console-adapter');
const { createNotificationWorker } = require('../src/workers/notification-worker');

const BASE_TIME = Date.parse('2035-01-01T00:00:00.000Z');
const cleanups = [];
test.afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups.length = 0;
});

function createTestSystem(dbPath = ':memory:') {
  const system = createApp({ config: { dbPath, nodeEnv: 'test', logLevel: 'silent' } });
  seedDemoData({ db: system.db, config: system.config });
  cleanups.push(() => { if (system.db.open) system.close(); });
  return system;
}

function createTrackedDatabase(dbPath) {
  const db = openDatabase(dbPath);
  cleanups.push(() => { if (db.open) db.close(); });
  return db;
}

function createTrackedDirectory(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function enqueueSyntheticEvent(system, suffix = '1') {
  const patient = system.db.prepare("SELECT id, email, role FROM users WHERE email = 'patient@health.local'").get();
  return system.appointments.createAppointment(patient, {
    phone: '9508532340',
    age: 19,
    symptoms: 'Synthetic worker reliability fixture',
    daysWithSymptoms: 1,
  }, `worker-test-${suffix}`);
}

function outboxRow(system) {
  return system.db.prepare('SELECT * FROM outbox_events ORDER BY id LIMIT 1').get();
}

test('notification adapter receives an event and the current claim is acknowledged', async () => {
  const system = createTestSystem();
  enqueueSyntheticEvent(system);
  let delivered;

  const result = await system.appointments.processOutboxOnce({
    now: () => BASE_TIME,
    leaseMs: 5_000,
    adapter: { async deliver(event) { delivered = event; } },
  });

  assert.equal(result.status, 'delivered');
  assert.equal(result.attempt, 1);
  assert.equal(delivered.eventType, 'appointment.requested');
  assert.equal(delivered.attempt, 1);
  assert.equal(outboxRow(system).status, 'delivered');
  assert.equal(outboxRow(system).claim_token, null);
  assert.equal(outboxRow(system).lease_expires_at, null);
});

test('default console adapter emits a local summary without logging payload details', async () => {
  const lines = [];
  const adapter = createConsoleNotificationAdapter({ write: (line) => lines.push(line) });
  await adapter.deliver({
    eventId: 'synthetic-event',
    eventType: 'appointment.requested',
    aggregateId: 'synthetic-appointment',
    payload: { symptoms: 'synthetic confidential symptom' },
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /notification:local/);
  assert.doesNotMatch(lines[0], /confidential symptom/);
  assert.doesNotMatch(lines[0], /email|SMTP|sent/i);
});

test('transient failures use exponential backoff and then succeed', async () => {
  const system = createTestSystem();
  enqueueSyntheticEvent(system);
  let nowMs = BASE_TIME;
  let calls = 0;
  const adapter = {
    async deliver() {
      calls += 1;
      if (calls < 3) {
        const error = new Error('provider error containing private payload');
        error.code = 'ECONNRESET';
        throw error;
      }
    },
  };

  const failed = await system.appointments.processOutboxOnce({
    adapter,
    now: () => nowMs,
    leaseMs: 1_000,
    baseDelayMs: 250,
    maxDelayMs: 400,
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.availableAt, new Date(BASE_TIME + 250).toISOString());
  assert.equal(outboxRow(system).last_error, 'ECONNRESET');
  assert.doesNotMatch(outboxRow(system).last_error, /private payload/);
  assert.equal(await system.appointments.processOutboxOnce({ adapter, now: () => nowMs }), null);

  nowMs += 250;
  const cappedRetry = await system.appointments.processOutboxOnce({
    adapter,
    now: () => nowMs,
    leaseMs: 1_000,
    baseDelayMs: 250,
    maxDelayMs: 400,
  });
  assert.equal(cappedRetry.status, 'failed');
  assert.equal(cappedRetry.availableAt, new Date(BASE_TIME + 650).toISOString());
  nowMs += 400;
  const retried = await system.appointments.processOutboxOnce({
    adapter,
    now: () => nowMs,
    leaseMs: 1_000,
    baseDelayMs: 250,
    maxDelayMs: 400,
  });
  assert.equal(retried.status, 'delivered');
  assert.equal(retried.attempt, 3);
  assert.equal(calls, 3);
});

test('maximum attempts move a failed event to terminal dead state', async () => {
  const system = createTestSystem();
  enqueueSyntheticEvent(system);
  let nowMs = BASE_TIME;
  let calls = 0;
  const adapter = { async deliver() { calls += 1; throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); } };
  const options = { adapter, now: () => nowMs, leaseMs: 1_000, maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 100 };

  assert.equal((await system.appointments.processOutboxOnce(options)).status, 'failed');
  nowMs += 10;
  const terminal = await system.appointments.processOutboxOnce(options);
  assert.equal(terminal.status, 'dead');
  assert.equal(outboxRow(system).attempts, 2);
  assert.ok(outboxRow(system).failed_at);
  assert.equal(system.appointments.listOutbox()[0].lastError, 'ECONNREFUSED');
  assert.equal(await system.appointments.processOutboxOnce(options), null);
  assert.equal(calls, 2);
});

test('separate SQLite connections cannot claim the same unexpired event', async () => {
  const dir = createTrackedDirectory('health-centre-outbox-concurrent-');
  const dbPath = path.join(dir, 'health-centre.sqlite');
  const firstSystem = createTestSystem(dbPath);
  const secondDb = createTrackedDatabase(dbPath);
  const secondService = createAppointmentService(secondDb);
  enqueueSyntheticEvent(firstSystem);

  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let releaseAdapter;
  const adapterGate = new Promise((resolve) => { releaseAdapter = resolve; });
  let deliveries = 0;
  const firstRun = firstSystem.appointments.processOutboxOnce({
    now: () => BASE_TIME,
    leaseMs: 5_000,
    adapter: { async deliver() { deliveries += 1; signalStarted(); await adapterGate; } },
  });
  await started;
  const competingRun = await secondService.processOutboxOnce({
    now: () => BASE_TIME,
    leaseMs: 5_000,
    adapter: { async deliver() { deliveries += 1; } },
  });
  assert.equal(competingRun, null);
  releaseAdapter();
  assert.equal((await firstRun).status, 'delivered');
  assert.equal(deliveries, 1);
});

test('expired leases recover crashed claims and stale workers cannot overwrite newer claims', async () => {
  const dir = createTrackedDirectory('health-centre-outbox-stale-');
  const dbPath = path.join(dir, 'health-centre.sqlite');
  const firstSystem = createTestSystem(dbPath);
  const secondDb = createTrackedDatabase(dbPath);
  const secondService = createAppointmentService(secondDb);
  enqueueSyntheticEvent(firstSystem);

  firstSystem.db.prepare(`
    UPDATE outbox_events SET status = 'processing', attempts = 1,
      claim_token = 'crashed-process', lease_expires_at = ?
  `).run(new Date(BASE_TIME - 1).toISOString());
  let nowMs = BASE_TIME;
  let recoveredDeliveries = 0;
  const recovered = await firstSystem.appointments.processOutboxOnce({
    now: () => nowMs,
    leaseMs: 100,
    adapter: { async deliver() { recoveredDeliveries += 1; } },
  });
  assert.equal(recovered.status, 'delivered');
  assert.equal(recovered.attempt, 2);
  assert.equal(recoveredDeliveries, 1);

  enqueueSyntheticEvent(firstSystem, 'stale');
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let releaseAdapter;
  const adapterGate = new Promise((resolve) => { releaseAdapter = resolve; });
  const oldWorker = firstSystem.appointments.processOutboxOnce({
    now: () => nowMs,
    leaseMs: 100,
    adapter: { async deliver() { signalStarted(); await adapterGate; } },
  });
  await started;
  nowMs += 101;
  const newWorker = await secondService.processOutboxOnce({
    now: () => nowMs,
    leaseMs: 100,
    adapter: { async deliver() {} },
  });
  assert.equal(newWorker.status, 'delivered');
  releaseAdapter();
  const staleResult = await oldWorker;
  assert.equal(staleResult.status, 'stale');
  assert.equal(firstSystem.db.prepare('SELECT status FROM outbox_events WHERE event_id = ?').get(newWorker.eventId).status, 'delivered');
});

test('notification worker stop waits for in-flight delivery and starts no further pass', async () => {
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  let releasePass;
  const passGate = new Promise((resolve) => { releasePass = resolve; });
  let passes = 0;
  const worker = createNotificationWorker({
    appointments: {
      async processOutboxOnce() {
        passes += 1;
        signalStarted();
        await passGate;
        return { status: 'delivered' };
      },
    },
    adapter: { async deliver() {} },
    pollIntervalMs: 60_000,
  });

  worker.start();
  await started;
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  releasePass();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(passes, 1);
});
