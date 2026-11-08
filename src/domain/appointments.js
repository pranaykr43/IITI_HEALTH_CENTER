const { ConflictError, ValidationError } = require('../errors');

const APPOINTMENT_STATUSES = Object.freeze({
  REQUESTED: 'requested',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

const transitions = Object.freeze({
  requested: new Set(['confirmed', 'rejected', 'cancelled']),
  confirmed: new Set(['completed', 'cancelled']),
  rejected: new Set(),
  completed: new Set(),
  cancelled: new Set(),
});

function assertTransition(currentStatus, nextStatus) {
  if (!Object.prototype.hasOwnProperty.call(transitions, currentStatus)) {
    throw new ValidationError(`Unknown appointment status: ${currentStatus}`);
  }
  if (!transitions[currentStatus].has(nextStatus)) {
    throw new ConflictError(`Cannot transition appointment from ${currentStatus} to ${nextStatus}`);
  }
}

function normalizeBooking(input) {
  const email = String(input.email || '').trim().toLowerCase();
  const phone = String(input.phone || '').trim();
  const symptoms = String(input.symptoms || '').trim();
  const age = Number(input.age);
  const daysWithSymptoms = Number(input.daysWithSymptoms ?? input.days);

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new ValidationError('A valid email is required');
  if (!phone || !/^[0-9+()\-\s]{7,24}$/.test(phone)) throw new ValidationError('A valid phone number is required');
  if (!Number.isInteger(age) || age < 0 || age > 130) throw new ValidationError('Age must be an integer from 0 to 130');
  if (!Number.isInteger(daysWithSymptoms) || daysWithSymptoms < 0 || daysWithSymptoms > 3650) {
    throw new ValidationError('Days with symptoms must be an integer from 0 to 3650');
  }
  if (symptoms.length < 3 || symptoms.length > 2000) throw new ValidationError('Symptoms must be between 3 and 2,000 characters');

  return { email, phone, age, daysWithSymptoms, symptoms };
}

function assertIdempotencyKey(key) {
  const normalized = String(key || '').trim();
  if (!normalized || normalized.length > 128) throw new ValidationError('A valid idempotency key is required');
  return normalized;
}

module.exports = {
  APPOINTMENT_STATUSES,
  assertTransition,
  normalizeBooking,
  assertIdempotencyKey,
};
