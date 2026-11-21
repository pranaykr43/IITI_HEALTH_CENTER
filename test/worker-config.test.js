const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkerOptions } = require('../src/services/appointment-service');

test('notification retries have a hard maximum attempt bound', () => {
  const base = { leaseMs: 30_000, baseDelayMs: 1_000, maxDelayMs: 60_000 };
  assert.doesNotThrow(() => validateWorkerOptions({ ...base, maxAttempts: 1 }));
  assert.doesNotThrow(() => validateWorkerOptions({ ...base, maxAttempts: 10 }));
  assert.throws(() => validateWorkerOptions({ ...base, maxAttempts: 11 }), /1 to 10/);
});
