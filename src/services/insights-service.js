const { mapAppointment } = require('./appointment-service');
const { parseScheduleInput, parseAvailableDays, wallClock } = require('../domain/clinic-time');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_SHORT = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat' };
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (value) => String(value).padStart(2, '0');
const dateKey = (clock) => `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`;
const minutesOf = (hhmm) => {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

// Read models for the staff dashboards. Every query is bounded so the dashboards stay
// fast as history grows; full history remains available through the audit log.
function createInsightsService(db, { clinicTimeZone = 'Asia/Kolkata', slotMinutes = 15, now = () => Date.now() } = {}) {
  const withNames = `
    SELECT appointments.*, patient_users.name AS patient_name, doctor_users.name AS doctor_name
    FROM appointments
    JOIN users AS patient_users ON patient_users.id = appointments.patient_id
    LEFT JOIN doctors ON doctors.id = appointments.doctor_id
    LEFT JOIN users AS doctor_users ON doctor_users.id = doctors.user_id`;

  function adminOverview() {
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const weekAheadIso = new Date(nowMs + 7 * DAY_MS).toISOString();
    const monthAgoIso = new Date(nowMs - 30 * DAY_MS).toISOString();

    const queue = db.prepare(`${withNames} WHERE appointments.status = 'requested' ORDER BY appointments.requested_at ASC LIMIT 100`).all().map(mapAppointment);
    const upcoming = db.prepare(`${withNames} WHERE appointments.status = 'confirmed' AND appointments.scheduled_for >= ? ORDER BY appointments.scheduled_for ASC LIMIT 60`).all(nowIso).map(mapAppointment);
    const recent = db.prepare(`${withNames} WHERE appointments.status IN ('completed', 'cancelled', 'rejected') ORDER BY appointments.requested_at DESC LIMIT 20`).all().map(mapAppointment);

    const counts = db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'requested' THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN status = 'confirmed' AND scheduled_for >= ? AND scheduled_for < ? THEN 1 ELSE 0 END) AS nextSevenDays,
        SUM(CASE WHEN status = 'completed' AND requested_at >= ? THEN 1 ELSE 0 END) AS completed30,
        SUM(CASE WHEN status IN ('cancelled', 'rejected') AND requested_at >= ? THEN 1 ELSE 0 END) AS cancelled30,
        SUM(CASE WHEN requested_at >= ? THEN 1 ELSE 0 END) AS requested30
      FROM appointments
    `).get(nowIso, weekAheadIso, monthAgoIso, monthAgoIso, monthAgoIso);
    const oldestWaiting = queue[0]?.requestedAt || null;

    return {
      queue,
      upcoming,
      recent,
      counts: {
        waiting: counts.waiting || 0,
        nextSevenDays: counts.nextSevenDays || 0,
        completed30: counts.completed30 || 0,
        cancelled30: counts.cancelled30 || 0,
        requested30: counts.requested30 || 0,
        oldestWaitingHours: oldestWaiting ? Math.floor((nowMs - Date.parse(oldestWaiting)) / 3_600_000) : null,
      },
      requestsByDay: requestsByDay(14),
    };
  }

  // Requests per clinic-calendar day for the trailing window, including empty days.
  function requestsByDay(days) {
    const nowMs = now();
    const buckets = [];
    const index = new Map();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const clock = wallClock(new Date(nowMs - offset * DAY_MS), clinicTimeZone);
      const key = dateKey(clock);
      if (index.has(key)) continue;
      index.set(key, buckets.length);
      buckets.push({ date: key, label: `${clock.day} ${MONTH_SHORT[clock.month - 1]}`, weekday: WEEKDAY_SHORT[clock.weekday], count: 0 });
    }
    const since = new Date(nowMs - (days + 1) * DAY_MS).toISOString();
    for (const row of db.prepare('SELECT requested_at FROM appointments WHERE requested_at >= ?').all(since)) {
      const position = index.get(dateKey(wallClock(new Date(row.requested_at), clinicTimeZone)));
      if (position !== undefined) buckets[position].count += 1;
    }
    return buckets;
  }

  // Bookable slots per active doctor for the next `days` clinic days, marking taken ones.
  // Values are clinic wall-clock strings, exactly what the schedule form accepts.
  function slotBoard(days = 14) {
    const nowMs = now();
    const horizon = new Date(nowMs + (days + 1) * DAY_MS).toISOString();
    const doctors = db.prepare(`
      SELECT doctors.id, users.name, doctors.start_time, doctors.end_time, doctors.available_days
      FROM doctors JOIN users ON users.id = doctors.user_id
      WHERE users.account_status = 'active' ORDER BY users.name
    `).all();
    const booked = db.prepare(`
      SELECT doctor_id, scheduled_for FROM appointments
      WHERE status IN ('confirmed', 'completed') AND scheduled_for >= ? AND scheduled_for < ?
    `).all(new Date(nowMs).toISOString(), horizon);
    const taken = new Set(booked.map((row) => `${row.doctor_id}|${row.scheduled_for}`));

    return doctors.map((doctor) => {
      const opens = minutesOf(doctor.start_time) ?? 9 * 60;
      const closes = minutesOf(doctor.end_time) ?? 17 * 60;
      const workingDays = parseAvailableDays(doctor.available_days);
      const dayList = [];
      for (let offset = 0; offset < days; offset += 1) {
        const clock = wallClock(new Date(nowMs + offset * DAY_MS), clinicTimeZone);
        if (workingDays && !workingDays.has(clock.weekday)) continue;
        const date = dateKey(clock);
        const slots = [];
        for (let minute = opens; minute + slotMinutes <= closes; minute += slotMinutes) {
          const value = `${date}T${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
          let instant;
          try { instant = parseScheduleInput(value, clinicTimeZone); } catch { continue; }
          if (instant.getTime() <= nowMs) continue;
          slots.push({ value, label: value.slice(11), taken: taken.has(`${doctor.id}|${instant.toISOString()}`) });
        }
        if (slots.length) dayList.push({ date, label: `${WEEKDAY_SHORT[clock.weekday]} ${clock.day} ${MONTH_SHORT[clock.month - 1]}`, slots });
      }
      return { id: doctor.id, name: doctor.name, hours: `${doctor.start_time}–${doctor.end_time}`, days: dayList };
    });
  }

  function doctorAgenda(doctorId) {
    const nowMs = now();
    const todayKey = dateKey(wallClock(new Date(nowMs), clinicTimeZone));
    const confirmed = db.prepare(`${withNames} WHERE appointments.doctor_id = ? AND appointments.status = 'confirmed' ORDER BY appointments.scheduled_for ASC LIMIT 100`).all(doctorId).map(mapAppointment);
    const recent = db.prepare(`${withNames} WHERE appointments.doctor_id = ? AND appointments.status IN ('completed', 'cancelled') ORDER BY appointments.scheduled_for DESC LIMIT 20`).all(doctorId).map(mapAppointment);
    const isToday = (item) => dateKey(wallClock(new Date(item.scheduledFor), clinicTimeZone)) === todayKey;
    return {
      today: confirmed.filter(isToday),
      upcoming: confirmed.filter((item) => !isToday(item) && Date.parse(item.scheduledFor) > nowMs),
      overdue: confirmed.filter((item) => !isToday(item) && Date.parse(item.scheduledFor) <= nowMs),
      recent,
    };
  }

  return { adminOverview, requestsByDay, slotBoard, doctorAgenda };
}

module.exports = { createInsightsService };
