const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APPOINTMENT_STATUSES,
  assertIdempotencyKey,
  assertTransition,
  normalizeBooking,
} = require('../src/domain/appointments');

test('appointment state machine allows only intentional forward transitions', () => {
  assert.doesNotThrow(() => assertTransition(APPOINTMENT_STATUSES.REQUESTED, APPOINTMENT_STATUSES.CONFIRMED));
  assert.doesNotThrow(() => assertTransition(APPOINTMENT_STATUSES.CONFIRMED, APPOINTMENT_STATUSES.COMPLETED));
  assert.throws(() => assertTransition(APPOINTMENT_STATUSES.COMPLETED, APPOINTMENT_STATUSES.CONFIRMED), /Cannot transition/);
  assert.throws(() => assertTransition(APPOINTMENT_STATUSES.REQUESTED, APPOINTMENT_STATUSES.COMPLETED), /Cannot transition/);
});

test('booking validation rejects malformed clinical input', () => {
  assert.deepEqual(normalizeBooking({
    email: 'PATIENT@example.com',
    phone: '+91 95085 32340',
    age: '19',
    symptoms: 'Persistent fever',
    daysWithSymptoms: '2',
  }), {
    email: 'patient@example.com',
    phone: '+91 95085 32340',
    age: 19,
    symptoms: 'Persistent fever',
    daysWithSymptoms: 2,
  });
  assert.throws(() => normalizeBooking({ email: 'bad', phone: 'x', age: 200, symptoms: 'x', days: -1 }), /valid email/);
});

test('idempotency keys are bounded and non-empty', () => {
  assert.equal(assertIdempotencyKey('retry-1'), 'retry-1');
  assert.throws(() => assertIdempotencyKey(''), /idempotency key/);
  assert.throws(() => assertIdempotencyKey('x'.repeat(129)), /idempotency key/);
});
