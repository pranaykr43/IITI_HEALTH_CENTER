const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { createAppointmentService } = require('../src/services/appointment-service');

const cleanups = [];
test.afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups.length = 0;
});

test('outbox reliability migration preserves old events and gives stale processing rows reclaimable leases', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-centre-outbox-migration-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'legacy.sqlite');
  const legacyDb = new Database(dbPath);
  cleanups.push(() => { if (legacyDb.open) legacyDb.close(); });
  legacyDb.exec(`
    CREATE TABLE outbox_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'failed')) DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE INDEX idx_outbox_available ON outbox_events(status, available_at, id);
  `);
  legacyDb.prepare(`
    INSERT INTO outbox_events (event_id, event_type, aggregate_id, payload_json, status, attempts, available_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('old-pending', 'appointment.requested', 'appointment-1', '{"synthetic":true}', 'pending', 0, '2032-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z');
  legacyDb.prepare(`
    INSERT INTO outbox_events (event_id, event_type, aggregate_id, payload_json, status, attempts, available_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('old-processing', 'appointment.confirmed', 'appointment-2', '{"synthetic":true}', 'processing', 2, '2031-01-01T00:00:30.000Z', '2030-01-01T00:00:00.000Z');
  legacyDb.close();

  const db = openDatabase(dbPath);
  cleanups.push(() => { if (db.open) db.close(); });
  const columns = db.pragma('table_info(outbox_events)').map((column) => column.name);
  assert.ok(columns.includes('claim_token'));
  assert.ok(columns.includes('lease_expires_at'));
  assert.ok(columns.includes('last_error'));
  assert.ok(columns.includes('failed_at'));
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.deepEqual(db.prepare('SELECT event_id, status, attempts FROM outbox_events ORDER BY id').all(), [
    { event_id: 'old-pending', status: 'pending', attempts: 0 },
    { event_id: 'old-processing', status: 'processing', attempts: 2 },
  ]);
  assert.equal(db.prepare("SELECT lease_expires_at FROM outbox_events WHERE event_id = 'old-processing'").get().lease_expires_at, '2031-01-01T00:00:30.000Z');
  const service = createAppointmentService(db);
  const recovered = await service.processOutboxOnce({
    now: () => Date.parse('2031-01-01T00:00:31.000Z'),
    adapter: { async deliver() {} },
  });
  assert.equal(recovered.eventId, 'old-processing');
  assert.equal(recovered.status, 'delivered');
  assert.doesNotThrow(() => db.prepare(`
    INSERT INTO outbox_events (event_id, event_type, aggregate_id, payload_json, status, available_at, created_at)
    VALUES ('dead-check', 'test', 'test', '{}', 'dead', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')
  `).run());

  db.close();
  const reopened = openDatabase(dbPath);
  assert.equal(reopened.pragma('user_version', { simple: true }), 1);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM outbox_events').get().count, 3);
  reopened.close();
});
