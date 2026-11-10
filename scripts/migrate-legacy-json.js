const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { createAppointmentService } = require('../src/services/appointment-service');
const { normalizeBooking } = require('../src/domain/appointments');

function sourceKey(record, index) {
  const sourceId = record._id === undefined ? `row-${index}` : JSON.stringify(record._id);
  return `legacy-json-${crypto.createHash('sha256').update(sourceId).digest('hex').slice(0, 40)}`;
}

function normalizeLegacyBooking(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (typeof record.email !== 'string' || !record.email.trim()) return null;
  if (record.sheduledtime != null && String(record.sheduledtime).trim()) return null;
  for (const field of ['phone', 'age', 'symptoms', 'days']) {
    if (record[field] == null || String(record[field]).trim() === '') return null;
  }

  try {
    return normalizeBooking({
      email: record.email,
      phone: record.phone,
      age: record.age,
      symptoms: record.symptoms,
      daysWithSymptoms: record.days,
    });
  } catch {
    return null;
  }
}

function runLegacyImport({ records, db, apply = false }) {
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    sourceRecords: records.length,
    eligible: 0,
    imported: 0,
    replayed: 0,
    manualReviewRequired: 0,
    missingPatient: 0,
    invalid: 0,
    conflicts: 0,
  };
  const appointments = createAppointmentService(db);
  const findPatient = db.prepare('SELECT id, email, role FROM users WHERE email = ? COLLATE NOCASE');

  records.forEach((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      summary.invalid += 1;
      return;
    }
    if (record.sheduledtime != null && String(record.sheduledtime).trim()) {
      summary.manualReviewRequired += 1;
      return;
    }

    const booking = normalizeLegacyBooking(record);
    if (!booking) {
      summary.invalid += 1;
      return;
    }
    const patient = findPatient.get(booking.email);
    if (!patient || patient.role !== 'patient') {
      summary.missingPatient += 1;
      return;
    }

    summary.eligible += 1;
    if (!apply) return;

    try {
      const result = appointments.createAppointment(patient, booking, sourceKey(record, index));
      if (result.replayed) summary.replayed += 1;
      else summary.imported += 1;
    } catch (error) {
      if (error.statusCode === 409) {
        summary.conflicts += 1;
        return;
      }
      throw error;
    }
  });

  return summary;
}

function readArguments(args) {
  const values = new Map();
  const flags = new Set();
  for (const arg of args) {
    if (arg === '--apply') flags.add(arg);
    else if (arg.startsWith('--source=')) values.set('source', arg.slice('--source='.length));
    else if (arg.startsWith('--db=')) values.set('db', arg.slice('--db='.length));
    else throw new Error(`Unknown argument: ${arg.split('=')[0]}`);
  }
  return {
    source: path.resolve(values.get('source') || 'appointmentsdatabase.json'),
    dbPath: path.resolve(values.get('db') || path.join('data', 'health-centre.sqlite')),
    apply: flags.has('--apply'),
  };
}

function main(args = process.argv.slice(2)) {
  const options = readArguments(args);
  if (!fs.existsSync(options.source)) throw new Error('Legacy appointment JSON file was not found');
  if (!fs.existsSync(options.dbPath)) throw new Error('Target SQLite database was not found; create and seed it before migration');

  const records = JSON.parse(fs.readFileSync(options.source, 'utf8'));
  if (!Array.isArray(records)) throw new Error('Legacy appointment JSON must contain an array');

  const db = options.apply
    ? openDatabase(options.dbPath)
    : new Database(options.dbPath, { readonly: true, fileMustExist: true });
  try {
    const summary = runLegacyImport({ records, db, apply: options.apply });
    console.log(JSON.stringify({
      source: path.basename(options.source),
      target: path.basename(options.dbPath),
      ...summary,
      note: 'No passwords or user accounts are migrated. Scheduled legacy appointments require manual mapping and are skipped.',
    }, null, 2));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main, normalizeLegacyBooking, runLegacyImport };
