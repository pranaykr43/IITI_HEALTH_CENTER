const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');
const { runLegacyImport } = require('../scripts/migrate-legacy-json');

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

test('legacy migration defaults to a dry run and skips scheduled or unmapped rows', () => {
  const system = createTestSystem();
  const records = [
    { _id: 'pending-1', email: 'patient@health.local', phone: '9508532340', age: 19, symptoms: 'Synthetic pending request', days: 2, sheduledtime: '' },
    { _id: 'scheduled-1', email: 'patient@health.local', phone: '9508532340', age: 19, symptoms: 'Synthetic scheduled request', days: 2, sheduledtime: '2030-01-01T10:00:00Z' },
    { _id: 'unknown-1', email: 'missing@health.local', phone: '9508532340', age: 19, symptoms: 'Synthetic unmatched request', days: 2, sheduledtime: '' },
  ];

  const result = runLegacyImport({ records, db: system.db });
  assert.deepEqual(result, {
    mode: 'dry-run',
    sourceRecords: 3,
    eligible: 1,
    imported: 0,
    replayed: 0,
    manualReviewRequired: 1,
    missingPatient: 1,
    invalid: 0,
    conflicts: 0,
  });
  assert.equal(system.appointments.countAppointments(), 0);
});

test('legacy migration applies only eligible rows and safely replays the same source', () => {
  const system = createTestSystem();
  const records = [
    { _id: 'pending-1', email: 'patient@health.local', phone: '9508532340', age: 19, symptoms: 'Synthetic pending request', days: 2, sheduledtime: '' },
  ];

  const first = runLegacyImport({ records, db: system.db, apply: true });
  const second = runLegacyImport({ records, db: system.db, apply: true });
  assert.equal(first.imported, 1);
  assert.equal(first.replayed, 0);
  assert.equal(second.imported, 0);
  assert.equal(second.replayed, 1);
  assert.equal(system.appointments.countAppointments(), 1);
});
