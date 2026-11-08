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

function nowIso() {
  return new Date().toISOString();
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
      rows = db.prepare('SELECT * FROM appointments WHERE patient_id = ? ORDER BY requested_at DESC').all(actor.id);
    } else if (actor.role === 'doctor') {
      rows = db.prepare('SELECT * FROM appointments WHERE doctor_id = ? ORDER BY requested_at DESC').all(actor.doctorId);
    } else if (actor.role === 'admin') {
      rows = db.prepare('SELECT * FROM appointments ORDER BY requested_at DESC').all();
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
    return db.prepare('SELECT event_id AS eventId, event_type AS eventType, aggregate_id AS aggregateId, status, attempts FROM outbox_events ORDER BY id').all();
  }

  function processOutboxOnce() {
    const claimUntil = new Date(Date.now() + 30_000).toISOString();
    const event = db.transaction(() => {
      const candidate = db.prepare(`
        SELECT * FROM outbox_events
        WHERE (status IN ('pending', 'failed') OR status = 'processing') AND available_at <= ?
        ORDER BY id LIMIT 1
      `).get(nowIso());
      if (!candidate) return null;
      db.prepare('UPDATE outbox_events SET status = \'processing\', attempts = attempts + 1, available_at = ? WHERE id = ? AND status IN (\'pending\', \'failed\', \'processing\')').run(claimUntil, candidate.id);
      return candidate;
    })();

    if (!event) return null;
    const deliveredAt = nowIso();
    db.prepare('UPDATE outbox_events SET status = \'delivered\', delivered_at = ? WHERE id = ? AND status = \'processing\'').run(deliveredAt, event.id);
    return { eventId: event.event_id, eventType: event.event_type, deliveredAt };
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
    processOutboxOnce,
    countAppointments,
  };
}

module.exports = { createAppointmentService, mapAppointment, hashPayload };
