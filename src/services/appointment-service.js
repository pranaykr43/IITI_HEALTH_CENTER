const crypto = require('node:crypto');
const {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} = require('../errors');
const {
  APPOINTMENT_STATUSES,
  assertIdempotencyKey,
  assertTransition,
  normalizeBooking,
} = require('../domain/appointments');
const { createConsoleNotificationAdapter } = require('../notifications/console-adapter');

const MAX_MANUAL_REDRIVES = 3;

function nowIso() {
  return new Date().toISOString();
}

function isoAt(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function validateWorkerOptions({ leaseMs, maxAttempts, baseDelayMs, maxDelayMs }) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new TypeError('leaseMs must be a positive integer');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 1) throw new TypeError('baseDelayMs must be a positive integer');
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) throw new TypeError('maxDelayMs must be an integer >= baseDelayMs');
}

function retryDelayMs(attempt, baseDelayMs, maxDelayMs) {
  return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(attempt - 1, 30)));
}

function safeErrorCode(error) {
  const value = error?.code || error?.name;
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value)
    ? value
    : 'notification_delivery_failed';
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function mapAppointment(row) {
  if (!row) return null;
  return {
    id: row.id,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    status: row.status,
    requestedAt: row.requested_at,
    scheduledFor: row.scheduled_for,
    patientName: row.patient_name || null,
    doctorName: row.doctor_name || null,
    patientPhone: row.patient_phone,
    patientAge: row.patient_age,
    symptoms: row.symptoms,
    daysWithSymptoms: row.days_with_symptoms,
    prescription: {
      test: row.prescription_test,
      medicine: row.prescription_medicine,
      advice: row.prescription_advice,
    },
    version: row.version,
  };
}

function getAppointment(db, id) {
  return mapAppointment(db.prepare('SELECT * FROM appointments WHERE id = ?').get(id));
}

function createAppointmentService(db) {
  const createAppointment = db.transaction((actor, input, idempotencyKey) => {
    if (!actor || actor.role !== 'patient') throw new AuthorizationError('Only patients can create appointments');
    const booking = normalizeBooking({ ...input, email: actor.email });
    const key = assertIdempotencyKey(idempotencyKey);
    const requestHash = hashPayload({ actorId: actor.id, booking });
    const existingKey = db.prepare('SELECT request_hash, response_json FROM idempotency_keys WHERE actor_user_id = ? AND key = ?').get(actor.id, key);

    if (existingKey) {
      if (existingKey.request_hash !== requestHash) {
        throw new ConflictError('Idempotency key was already used with a different request');
      }
      return { appointment: JSON.parse(existingKey.response_json), replayed: true };
    }

    const id = crypto.randomUUID();
    const createdAt = nowIso();
    db.prepare(`
      INSERT INTO appointments (
        id, patient_id, status, requested_at, patient_phone, patient_age,
        symptoms, days_with_symptoms, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(id, actor.id, APPOINTMENT_STATUSES.REQUESTED, createdAt, booking.phone, booking.age, booking.symptoms, booking.daysWithSymptoms);

    const appointment = getAppointment(db, id);
    db.prepare(`
      INSERT INTO idempotency_keys (key, actor_user_id, request_hash, response_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(key, actor.id, requestHash, JSON.stringify(appointment), createdAt);
    db.prepare(`
      INSERT INTO outbox_events (event_id, event_type, aggregate_id, payload_json, available_at, created_at)
      VALUES (?, 'appointment.requested', ?, ?, ?, ?)
    `).run(crypto.randomUUID(), id, JSON.stringify(appointment), createdAt, createdAt);
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (?, 'appointment.requested', 'appointment', ?, ?, ?)
    `).run(actor.id, id, JSON.stringify({ idempotencyKey: key }), createdAt);

    return { appointment, replayed: false };
  });

  const scheduleAppointment = db.transaction((actor, appointmentId, doctorId, scheduledFor) => {
    if (!actor || actor.role !== 'admin') throw new AuthorizationError('Only administrators can schedule appointments');
    if (!Number.isInteger(Number(doctorId))) throw new ValidationError('A valid doctor is required');
    const parsedDate = new Date(scheduledFor);
    if (!scheduledFor || Number.isNaN(parsedDate.getTime())) throw new ValidationError('A valid scheduled time is required');
    if (parsedDate <= new Date()) throw new ValidationError('Scheduled time must be in the future');

    const doctor = db.prepare(`
      SELECT doctors.id, users.name FROM doctors JOIN users ON users.id = doctors.user_id WHERE doctors.id = ?
    `).get(Number(doctorId));
    if (!doctor) throw new NotFoundError('Doctor not found');

    const current = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    if (!current) throw new NotFoundError('Appointment not found');
    assertTransition(current.status, APPOINTMENT_STATUSES.CONFIRMED);

    const normalizedTime = parsedDate.toISOString();
    try {
      const result = db.prepare(`
        UPDATE appointments
        SET doctor_id = ?, scheduled_for = ?, status = 'confirmed', version = version + 1
        WHERE id = ? AND status = 'requested' AND version = ?
      `).run(doctor.id, normalizedTime, appointmentId, current.version);
      if (result.changes !== 1) throw new ConflictError('Appointment changed before it could be scheduled');
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(error.message).includes('appointments.doctor_id, appointments.scheduled_for')) {
        throw new ConflictError('That doctor is already booked for the requested time');
      }
      throw error;
    }

    const appointment = getAppointment(db, appointmentId);
    const createdAt = nowIso();
    db.prepare(`
      INSERT INTO outbox_events (event_id, event_type, aggregate_id, payload_json, available_at, created_at)
      VALUES (?, 'appointment.confirmed', ?, ?, ?, ?)
    `).run(crypto.randomUUID(), appointmentId, JSON.stringify(appointment), createdAt, createdAt);
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (?, 'appointment.confirmed', 'appointment', ?, ?, ?)
    `).run(actor.id, appointmentId, JSON.stringify({ doctorId: doctor.id, scheduledFor: normalizedTime }), createdAt);
    return appointment;
  });

  const transitionAppointment = db.transaction((actor, appointmentId, nextStatus) => {
    const current = getAppointment(db, appointmentId);
    if (!current) throw new NotFoundError('Appointment not found');
    if (actor.role === 'patient' && current.patientId !== actor.id) throw new AuthorizationError();
    if (actor.role === 'doctor' && current.doctorId !== actor.doctorId) throw new AuthorizationError();
    if (!['admin', 'doctor', 'patient'].includes(actor.role)) throw new AuthorizationError();
    if (actor.role === 'doctor' && nextStatus !== APPOINTMENT_STATUSES.COMPLETED) throw new AuthorizationError('Doctors can only complete assigned appointments');
    if (actor.role === 'patient' && nextStatus !== APPOINTMENT_STATUSES.CANCELLED) throw new AuthorizationError('Patients can only cancel their appointments');
    assertTransition(current.status, nextStatus);

    const result = db.prepare(`
      UPDATE appointments SET status = ?, version = version + 1
      WHERE id = ? AND version = ?
    `).run(nextStatus, appointmentId, current.version);
    if (result.changes !== 1) throw new ConflictError('Appointment changed before the transition completed');

    const updated = getAppointment(db, appointmentId);
    const createdAt = nowIso();
    db.prepare(`
      INSERT INTO outbox_events (event_id, event_type, aggregate_id, payload_json, available_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), `appointment.${nextStatus}`, appointmentId, JSON.stringify(updated), createdAt, createdAt);
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (?, ?, 'appointment', ?, '{}', ?)
    `).run(actor.id, `appointment.${nextStatus}`, appointmentId, createdAt);
    return updated;
  });

  const completeAppointment = db.transaction((actor, appointmentId, prescription) => {
    if (!actor || actor.role !== 'doctor') throw new AuthorizationError('Only doctors can complete appointments');
    const current = getAppointment(db, appointmentId);
    if (!current) throw new NotFoundError('Appointment not found');
    if (current.doctorId !== actor.doctorId) throw new AuthorizationError();
    assertTransition(current.status, APPOINTMENT_STATUSES.COMPLETED);
    const result = db.prepare(`
      UPDATE appointments
      SET status = 'completed', prescription_test = ?, prescription_medicine = ?, prescription_advice = ?, version = version + 1
      WHERE id = ? AND status = 'confirmed' AND version = ?
    `).run(prescription.test || null, prescription.medicine || null, prescription.advice || null, appointmentId, current.version);
    if (result.changes !== 1) throw new ConflictError('Appointment changed before it could be completed');
    const updated = getAppointment(db, appointmentId);
    const createdAt = nowIso();
    db.prepare(`
      INSERT INTO outbox_events (event_id, event_type, aggregate_id, payload_json, available_at, created_at)
      VALUES (?, 'appointment.completed', ?, ?, ?, ?)
    `).run(crypto.randomUUID(), appointmentId, JSON.stringify(updated), createdAt, createdAt);
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (?, 'appointment.completed', 'appointment', ?, '{}', ?)
    `).run(actor.id, appointmentId, createdAt);
    return updated;
  });

  function listForActor(actor) {
    let rows;
    if (actor.role === 'patient') {
      rows = db.prepare(`SELECT appointments.*, doctor_users.name AS doctor_name
        FROM appointments
        LEFT JOIN doctors ON doctors.id = appointments.doctor_id
        LEFT JOIN users AS doctor_users ON doctor_users.id = doctors.user_id
        WHERE appointments.patient_id = ? ORDER BY appointments.requested_at DESC`).all(actor.id);
    } else if (actor.role === 'doctor') {
      rows = db.prepare(`SELECT appointments.*, patient_users.name AS patient_name, doctor_users.name AS doctor_name
        FROM appointments
        JOIN users AS patient_users ON patient_users.id = appointments.patient_id
        LEFT JOIN doctors ON doctors.id = appointments.doctor_id
        LEFT JOIN users AS doctor_users ON doctor_users.id = doctors.user_id
        WHERE appointments.doctor_id = ? ORDER BY appointments.requested_at DESC`).all(actor.doctorId);
    } else if (actor.role === 'admin') {
      rows = db.prepare(`SELECT appointments.*, patient_users.name AS patient_name, doctor_users.name AS doctor_name
        FROM appointments
        JOIN users AS patient_users ON patient_users.id = appointments.patient_id
        LEFT JOIN doctors ON doctors.id = appointments.doctor_id
        LEFT JOIN users AS doctor_users ON doctor_users.id = doctors.user_id
        ORDER BY appointments.requested_at DESC`).all();
    } else {
      throw new AuthorizationError();
    }
    return rows.map(mapAppointment);
  }

  function listDoctors() {
    return db.prepare(`
      SELECT doctors.id, users.name, doctors.qualification, doctors.specialization,
             doctors.available_days AS availableDays, doctors.start_time AS startTime,
             doctors.end_time AS endTime
      FROM doctors JOIN users ON users.id = doctors.user_id ORDER BY users.name
    `).all();
  }

  function listOutbox() {
    return db.prepare(`
      SELECT event_id AS eventId, event_type AS eventType, aggregate_id AS aggregateId,
             status, attempts, available_at AS availableAt, last_error AS lastError,
             failed_at AS failedAt, redrive_count AS redriveCount, created_at AS createdAt,
             delivered_at AS deliveredAt
      FROM outbox_events ORDER BY id DESC LIMIT 50
    `).all();
  }

  function getOutboxMetrics(nowMs = Date.now()) {
    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
        COALESCE(SUM(attempts), 0) AS attempts,
        MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldestPendingAt
      FROM outbox_events
    `).get();
    const heartbeat = db.prepare('SELECT worker_name AS workerName, last_seen_at AS lastSeenAt FROM notification_worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1').get() || null;
    return {
      pending: counts.pending || 0,
      processing: counts.processing || 0,
      failed: counts.failed || 0,
      dead: counts.dead || 0,
      attempts: counts.attempts || 0,
      oldestPendingAt: counts.oldestPendingAt,
      oldestPendingAgeSeconds: counts.oldestPendingAt
        ? Math.max(0, Math.floor((nowMs - Date.parse(counts.oldestPendingAt)) / 1000))
        : 0,
      workerName: heartbeat?.workerName || null,
      workerLastSeenAt: heartbeat?.lastSeenAt || null,
    };
  }

  function listRecentNotificationActivity(limit = 12) {
    const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 12));
    return db.prepare(`
      SELECT event_id AS eventId, event_type AS eventType, status, attempts,
             last_error AS lastError, created_at AS createdAt, delivered_at AS deliveredAt,
             failed_at AS failedAt, redrive_count AS redriveCount
      FROM outbox_events
      WHERE status IN ('delivered', 'failed', 'dead')
      ORDER BY id DESC LIMIT ?
    `).all(boundedLimit);
  }

  function recordWorkerHeartbeat(workerName = 'notifications', at = new Date().toISOString()) {
    const normalizedName = String(workerName).trim();
    if (!normalizedName || normalizedName.length > 80) throw new TypeError('workerName must be between 1 and 80 characters');
    db.prepare(`
      INSERT INTO notification_worker_heartbeats (worker_name, last_seen_at) VALUES (?, ?)
      ON CONFLICT(worker_name) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(normalizedName, at);
  }

  const redriveDeadEvent = db.transaction((actor, eventId, reason, at = new Date().toISOString()) => {
    if (!actor || actor.role !== 'admin') throw new AuthorizationError();
    const normalizedReason = String(reason || '').trim();
    if (normalizedReason.length < 10 || normalizedReason.length > 500) {
      throw new ValidationError('Redrive reason must be between 10 and 500 characters');
    }
    const event = db.prepare('SELECT id, status, attempts, redrive_count FROM outbox_events WHERE event_id = ?').get(eventId);
    if (!event) throw new NotFoundError('Notification event not found');
    if (event.status !== 'dead') throw new ConflictError('Only dead notification events can be redriven');
    if (event.redrive_count >= MAX_MANUAL_REDRIVES) throw new ConflictError('This event has reached the manual redrive limit');
    const update = db.prepare(`
      UPDATE outbox_events
      SET status = 'pending', available_at = ?, redrive_count = redrive_count + 1
      WHERE id = ? AND status = 'dead' AND redrive_count = ?
    `).run(at, event.id, event.redrive_count);
    if (update.changes !== 1) throw new ConflictError('Notification event changed before it could be redriven');
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (?, 'notification.redriven', 'notification_event', ?, ?, ?)
    `).run(actor.id, eventId, JSON.stringify({ reason: normalizedReason, attempts: event.attempts, redriveCount: event.redrive_count + 1 }), at);
    return { eventId, status: 'pending', attempts: event.attempts, redriveCount: event.redrive_count + 1, availableAt: at };
  }).immediate;

  function claimOutboxEvent({ nowMs, leaseMs, maxAttempts }) {
    return db.transaction(() => {
      const now = isoAt(nowMs);
      db.prepare(`
        UPDATE outbox_events
        SET status = 'dead', failed_at = COALESCE(failed_at, ?),
            claim_token = NULL, lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'maximum_attempts_reached')
        WHERE attempts >= (redrive_count + 1) * ? AND (
          (status IN ('pending', 'failed') AND available_at <= ?)
          OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
      `).run(now, maxAttempts, now, now);

      const candidate = db.prepare(`
        SELECT * FROM outbox_events
        WHERE attempts < (redrive_count + 1) * ? AND (
          (status IN ('pending', 'failed') AND available_at <= ?)
          OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
        ORDER BY id LIMIT 1
      `).get(maxAttempts, now, now);
      if (!candidate) return null;
      const claimToken = crypto.randomUUID();
      const leaseExpiresAt = isoAt(nowMs + leaseMs);
      const updated = db.prepare(`
        UPDATE outbox_events
        SET status = 'processing', attempts = attempts + 1,
            claim_token = ?, lease_expires_at = ?
        WHERE id = ? AND attempts = ? AND (
          (status IN ('pending', 'failed') AND available_at <= ?)
          OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
      `).run(claimToken, leaseExpiresAt, candidate.id, candidate.attempts, now, now);
      if (updated.changes !== 1) return null;
      return {
        id: candidate.id,
        claimToken,
        leaseExpiresAt,
        attempt: candidate.attempts + 1,
        redriveCount: candidate.redrive_count,
        event: {
          eventId: candidate.event_id,
          eventType: candidate.event_type,
          aggregateId: candidate.aggregate_id,
          payload: JSON.parse(candidate.payload_json),
          attempt: candidate.attempts + 1,
        },
      };
    }).immediate();
  }

  function completeOutboxClaim(claim, nowMs) {
    const deliveredAt = isoAt(nowMs);
    const result = db.prepare(`
      UPDATE outbox_events
      SET status = 'delivered', delivered_at = ?, claim_token = NULL,
          lease_expires_at = NULL, last_error = NULL, failed_at = NULL
      WHERE id = ? AND status = 'processing' AND claim_token = ? AND lease_expires_at > ?
    `).run(deliveredAt, claim.id, claim.claimToken, deliveredAt);
    if (result.changes !== 1) return { status: 'stale', eventId: claim.event.eventId };
    return { status: 'delivered', eventId: claim.event.eventId, deliveredAt, attempt: claim.attempt };
  }

  function failOutboxClaim(claim, error, { nowMs, maxAttempts, baseDelayMs, maxDelayMs }) {
    const failedAt = isoAt(nowMs);
    const terminal = claim.attempt >= (claim.redriveCount + 1) * maxAttempts;
    const nextAvailableAt = terminal
      ? failedAt
      : isoAt(nowMs + retryDelayMs(claim.attempt, baseDelayMs, maxDelayMs));
    const status = terminal ? 'dead' : 'failed';
    const result = db.prepare(`
      UPDATE outbox_events
      SET status = ?, available_at = ?, last_error = ?,
          failed_at = CASE WHEN ? = 'dead' THEN ? ELSE NULL END,
          claim_token = NULL, lease_expires_at = NULL
      WHERE id = ? AND status = 'processing' AND claim_token = ? AND lease_expires_at > ?
    `).run(status, nextAvailableAt, safeErrorCode(error), status, failedAt, claim.id, claim.claimToken, failedAt);
    if (result.changes !== 1) return { status: 'stale', eventId: claim.event.eventId, attempt: claim.attempt };
    return {
      status,
      eventId: claim.event.eventId,
      attempt: claim.attempt,
      availableAt: nextAvailableAt,
      lastError: safeErrorCode(error),
    };
  }

  async function processOutboxOnce(options = {}) {
    const {
      adapter = createConsoleNotificationAdapter(),
      now = Date.now,
      leaseMs = 30_000,
      maxAttempts = 5,
      baseDelayMs = 1_000,
      maxDelayMs = 60_000,
    } = options;
    validateWorkerOptions({ leaseMs, maxAttempts, baseDelayMs, maxDelayMs });
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    const deliver = typeof adapter === 'function' ? adapter : adapter?.deliver;
    if (typeof deliver !== 'function') throw new TypeError('adapter must be a function or provide deliver(event)');

    const claimedAt = now();
    recordWorkerHeartbeat(options.workerName || 'notifications', isoAt(claimedAt));
    const claim = claimOutboxEvent({ nowMs: claimedAt, leaseMs, maxAttempts });
    if (!claim) return null;

    try {
      await deliver.call(adapter, claim.event);
    } catch (error) {
      return failOutboxClaim(claim, error, {
        nowMs: now(),
        maxAttempts,
        baseDelayMs,
        maxDelayMs,
      });
    }
    return completeOutboxClaim(claim, now());
  }

  function countAppointments() {
    return db.prepare('SELECT COUNT(*) AS count FROM appointments').get().count;
  }

  return {
    createAppointment,
    scheduleAppointment,
    transitionAppointment,
    completeAppointment,
    getAppointment,
    listForActor,
    listDoctors,
    listOutbox,
    getOutboxMetrics,
    listRecentNotificationActivity,
    recordWorkerHeartbeat,
    redriveDeadEvent,
    processOutboxOnce,
    countAppointments,
  };
}

module.exports = { createAppointmentService, mapAppointment, hashPayload };
