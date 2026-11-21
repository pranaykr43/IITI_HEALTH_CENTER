const { ValidationError } = require('../errors');

// Wall-clock values from <input type="datetime-local"> carry no offset. They are
// interpreted in the clinic's configured IANA time zone, never the server's zone,
// so a UTC container and an IST browser agree on what "10:30" means.
const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const EXPLICIT_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const formatterCache = new Map();
function partsFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'long',
    }));
  }
  return formatterCache.get(timeZone);
}

function wallClock(date, timeZone) {
  const parts = Object.fromEntries(partsFormatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

function offsetMs(date, timeZone) {
  const clock = wallClock(date, timeZone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

function parseScheduleInput(value, timeZone) {
  const input = String(value || '').trim();
  if (EXPLICIT_OFFSET_PATTERN.test(input)) {
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const match = WALL_CLOCK_PATTERN.exec(input);
  if (!match) throw new ValidationError('A valid scheduled time is required');
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = new Date(naiveUtc - offsetMs(new Date(naiveUtc), timeZone));
  // Re-evaluate once so a daylight-saving boundary between the guess and the result is honoured.
  candidate = new Date(naiveUtc - offsetMs(candidate, timeZone));
  const check = wallClock(candidate, timeZone);
  if (check.year !== year || check.month !== month || check.day !== day || check.hour !== hour || check.minute !== minute) {
    throw new ValidationError('That local time does not exist in the clinic time zone');
  }
  return candidate;
}

function minutesOfDay(hhmm) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Parses the free-text availability that doctors were provisioned with, such as
// "Monday-Friday" or "Monday, Wednesday, Friday". Returns null when the value cannot
// be understood so callers can fall back to not restricting by day.
function parseAvailableDays(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const lookup = (name) => WEEKDAYS.findIndex((day) => day.toLowerCase().startsWith(name.trim().toLowerCase().slice(0, 3)));
  const days = new Set();
  for (const token of value.split(/[,/]|\band\b/i)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const range = trimmed.split(/\s*(?:-|–|to)\s*/i);
    if (range.length === 2) {
      const start = lookup(range[0]);
      const end = lookup(range[1]);
      if (start < 0 || end < 0) return null;
      for (let index = start; ; index = (index + 1) % 7) {
        days.add(WEEKDAYS[index]);
        if (index === end) break;
      }
    } else {
      const index = lookup(trimmed);
      if (index < 0 || trimmed.length < 3) return null;
      days.add(WEEKDAYS[index]);
    }
  }
  return days.size ? days : null;
}

function assertBookableSlot(date, { timeZone, slotMinutes, doctor }) {
  const clock = wallClock(date, timeZone);
  const startMinute = clock.hour * 60 + clock.minute;
  if (clock.second !== 0 || date.getUTCMilliseconds() !== 0 || startMinute % slotMinutes !== 0) {
    throw new ValidationError(`Scheduled time must start on a ${slotMinutes}-minute slot boundary in clinic time`);
  }
  const opens = minutesOfDay(doctor.start_time);
  const closes = minutesOfDay(doctor.end_time);
  if (opens !== null && closes !== null && (startMinute < opens || startMinute + slotMinutes > closes)) {
    throw new ValidationError(`The selected doctor sees patients between ${doctor.start_time} and ${doctor.end_time} clinic time`);
  }
  const days = parseAvailableDays(doctor.available_days);
  if (days && !days.has(clock.weekday)) {
    throw new ValidationError(`The selected doctor is not available on ${clock.weekday}s`);
  }
}

function formatClinicDateTime(value, timeZone) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
  }).format(date);
}

module.exports = {
  parseScheduleInput,
  assertBookableSlot,
  parseAvailableDays,
  formatClinicDateTime,
  wallClock,
};
