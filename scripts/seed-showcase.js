#!/usr/bin/env node
// Fills a development database with synthetic, clearly fictional activity so every
// dashboard has something to show: several doctors and patients, two weeks of history,
// a waiting queue, and booked visits (including today). Refuses to run in production.
const crypto = require('node:crypto');
const { openDatabase, closeDatabase } = require('../src/db');
const { loadConfig } = require('../src/config');
const { seedDemoData, assertDemoSeedingAllowed } = require('../src/seed');
const { createAuthService } = require('../src/services/auth-service');
const { parseScheduleInput, wallClock } = require('../src/domain/clinic-time');
const { notificationPayload, mapAppointment } = require('../src/services/appointment-service');

const DAY_MS = 24 * 60 * 60 * 1000;
const DOCTORS = [
  { email: 'meera.rao@health.local', name: 'Dr. Meera Rao', specialization: 'General medicine', days: 'Monday-Friday', start: '09:00', end: '17:00' },
  { email: 'arjun.iyer@health.local', name: 'Dr. Arjun Iyer', specialization: 'Dermatology', days: 'Monday, Wednesday, Friday', start: '10:00', end: '14:00' },
  { email: 'kavya.nair@health.local', name: 'Dr. Kavya Nair', specialization: 'Counselling', days: 'Tuesday-Saturday', start: '11:00', end: '18:00' },
];
const PATIENTS = ['Aarav Sharma', 'Diya Patel', 'Ishaan Gupta', 'Ananya Reddy', 'Kabir Singh', 'Meher Joshi', 'Rohan Das', 'Sara Khan', 'Vivaan Menon', 'Tara Bose'];
const REASONS = [
  ['Sore throat and mild fever', 2], ['Sprained ankle after football', 1], ['Recurring headaches during exams', 7],
  ['Skin rash on forearm', 4], ['Trouble sleeping and feeling anxious', 14], ['Seasonal allergies, sneezing', 5],
  ['Stomach ache after meals', 3], ['Follow-up on blood test results', 0], ['Persistent dry cough', 6], ['Acne flare-up', 21],
];
const NOTES = [
  { test: 'Throat swab', medicine: 'Paracetamol 500 mg as needed', advice: 'Warm fluids and rest for two days' },
  { test: '', medicine: 'Ibuprofen gel', advice: 'Ice, compression and elevation; avoid sport for a week' },
  { test: 'Eye check referral', medicine: '', advice: 'Regular breaks from screens and consistent sleep' },
  { test: '', medicine: 'Hydrocortisone cream 1%', advice: 'Avoid scented soaps; return if it spreads' },
];

function main() {
  const config = loadConfig();
  assertDemoSeedingAllowed(config);
  const db = openDatabase(config.dbPath);
  try {
    seedDemoData({ db, config });
    const auth = createAuthService(db, config);
    if (db.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'meera.rao@health.local'").get().count) {
      console.log('Showcase data already present; nothing to do.');
      return;
    }
    const now = Date.now();
    const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@health.local'").get().id;
    const demoDoctor = db.prepare("SELECT doctors.id, doctors.user_id, doctors.start_time, doctors.end_time, doctors.available_days FROM doctors JOIN users ON users.id = doctors.user_id WHERE users.email = 'doctor@health.local'").get();

    const doctors = [{ id: demoDoctor.id, userId: demoDoctor.user_id, start: demoDoctor.start_time, end: demoDoctor.end_time, days: [1, 2, 3, 4, 5] }];
    for (const doctor of DOCTORS) {
      const user = auth.createUser({ email: doctor.email, name: doctor.name, role: 'doctor', password: config.demoPassword });
      const id = db.prepare('INSERT INTO doctors (user_id, qualification, specialization, available_days, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, 'MBBS', doctor.specialization, doctor.days, doctor.start, doctor.end).lastInsertRowid;
      const days = { 'Monday-Friday': [1, 2, 3, 4, 5], 'Monday, Wednesday, Friday': [1, 3, 5], 'Tuesday-Saturday': [2, 3, 4, 5, 6] }[doctor.days];
      doctors.push({ id, userId: user.id, start: doctor.start, end: doctor.end, days });
    }
    const demoPatientId = db.prepare("SELECT id FROM users WHERE email = 'patient@health.local'").get().id;
    const patients = [demoPatientId, ...PATIENTS.map((name) => auth.createUser({
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@student.example`, name, role: 'patient', password: config.demoPassword,
    }).id)];

    const insert = db.prepare(`INSERT INTO appointments (id, patient_id, doctor_id, status, requested_at, scheduled_for, patient_phone, patient_age,
      symptoms, days_with_symptoms, prescription_test, prescription_medicine, prescription_advice, version)
      VALUES (@id, @patient, @doctor, @status, @requested, @scheduled, @phone, @age, @symptoms, @days, @test, @medicine, @advice, @version)`);
    const outbox = db.prepare(`INSERT INTO outbox_events (event_id, event_type, aggregate_id, payload_json, status, attempts, available_at, created_at, delivered_at)
      VALUES (?, ?, ?, ?, 'delivered', 1, ?, ?, ?)`);
    const audit = db.prepare(`INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (?, ?, 'appointment', ?, ?, ?)`);
    const used = new Set();
    const pad = (n) => String(n).padStart(2, '0');

    // Finds a free, aligned slot for a doctor on the clinic day `offset` days from now.
    const slotFor = (doctor, offset, preferredMinute) => {
      const clock = wallClock(new Date(now + offset * DAY_MS), config.clinicTimeZone);
      const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(clock.weekday);
      if (!doctor.days.includes(weekday)) return null;
      const [sh, sm] = doctor.start.split(':').map(Number);
      const [eh, em] = doctor.end.split(':').map(Number);
      for (let minute = Math.max(sh * 60 + sm, preferredMinute); minute + config.slotMinutes <= eh * 60 + em; minute += config.slotMinutes) {
        const wall = `${clock.year}-${pad(clock.month)}-${pad(clock.day)}T${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
        const iso = parseScheduleInput(wall, config.clinicTimeZone).toISOString();
        if (!used.has(`${doctor.id}|${iso}`)) { used.add(`${doctor.id}|${iso}`); return iso; }
      }
      return null;
    };

    let n = 0;
    const add = ({ status, requestedOffsetHours, doctor = null, scheduled = null, note = null, patient }) => {
      const [symptoms, days] = REASONS[n % REASONS.length];
      const row = {
        id: crypto.randomUUID(), patient, doctor: doctor?.id ?? null, status,
        requested: new Date(now - requestedOffsetHours * 3_600_000).toISOString(), scheduled,
        phone: `98${String(10_000_000 + n * 7_919).slice(0, 8)}`, age: 18 + (n * 3) % 9,
        symptoms, days, test: note?.test || null, medicine: note?.medicine || null, advice: note?.advice || null,
        version: status === 'requested' ? 0 : status === 'confirmed' ? 1 : 2,
      };
      insert.run(row);
      const appointment = mapAppointment({
        ...row, patient_id: row.patient, doctor_id: row.doctor, requested_at: row.requested, scheduled_for: row.scheduled,
      });
      outbox.run(crypto.randomUUID(), `appointment.${status}`, row.id, JSON.stringify(notificationPayload(appointment)), row.requested, row.requested, row.requested);
      const actor = status === 'requested' || status === 'cancelled' ? row.patient : status === 'completed' ? doctor.userId : adminId;
      audit.run(actor, `appointment.${status}`, row.id, '{}', row.requested);
      n += 1;
    };

    // Two weeks of history: completed and cancelled visits.
    for (let day = 13; day >= 1; day -= 1) {
      const perDay = 1 + ((day * 7) % 4);
      for (let k = 0; k < perDay; k += 1) {
        let doctor = doctors[(day + k) % doctors.length];
        let scheduled = slotFor(doctor, -day, 9 * 60 + k * 45);
        if (!scheduled) { doctor = doctors[0]; scheduled = slotFor(doctor, -day, 9 * 60 + k * 45); }
        if (!scheduled) continue;
        const cancelled = (day + k) % 6 === 0;
        add({ status: cancelled ? 'cancelled' : 'completed', requestedOffsetHours: day * 24 + 20 + k, doctor, scheduled, note: cancelled ? null : NOTES[(day + k) % NOTES.length], patient: patients[(day * 3 + k) % patients.length] });
      }
    }
    // Booked visits: today and the coming week.
    for (let day = 0; day <= 7; day += 1) {
      doctors.forEach((doctor, index) => {
        if ((day + index) % 2) return;
        const nowClock = wallClock(new Date(now), config.clinicTimeZone);
        const earliest = day === 0 ? nowClock.hour * 60 + nowClock.minute + 30 : 9 * 60 + index * 30;
        const scheduled = slotFor(doctor, day, earliest);
        if (scheduled) add({ status: 'confirmed', requestedOffsetHours: 20 + ((day * 37 + index * 19) % 110), doctor, scheduled, patient: patients[(day + index * 2) % patients.length] });
      });
    }
    // The waiting queue, oldest first.
    [52, 26, 9, 4, 1.5, 0.4].forEach((hours, index) => add({ status: 'requested', requestedOffsetHours: hours, patient: patients[(index * 4 + 1) % patients.length] }));

    console.log(JSON.stringify({
      message: 'Showcase data added. All synthetic accounts use HEALTH_DEMO_PASSWORD; for local development only.',
      appointments: n,
      doctors: ['doctor@health.local', ...DOCTORS.map((doctor) => doctor.email)],
      samplePatients: ['patient@health.local', `${PATIENTS[0].toLowerCase().replace(/\s+/g, '.')}@student.example`],
    }, null, 2));
  } finally {
    closeDatabase(db);
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main };
