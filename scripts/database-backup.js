#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config');

const REQUIRED_SCHEMA_VERSION = 4;

function validateDatabase(filePath) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('SQLite integrity check failed');
    }
    const version = db.pragma('user_version', { simple: true });
    if (version !== REQUIRED_SCHEMA_VERSION) throw new Error(`Unsupported database schema version ${version}; expected ${REQUIRED_SCHEMA_VERSION}`);
    const expected = ['users', 'appointments', 'outbox_events', 'password_reset_tokens', 'notification_worker_heartbeats', 'google_oauth_transactions'];
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const missing = expected.filter((name) => !tables.has(name));
    if (missing.length) throw new Error(`Database is missing required tables: ${missing.join(', ')}`);
    return { schemaVersion: version };
  } finally {
    db.close();
  }
}

async function writeBackup(sourcePath, destinationPath) {
  const destination = path.resolve(destinationPath);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      await db.backup(temporary);
    } finally {
      db.close();
    }
    const validation = validateDatabase(temporary);
    // link() atomically reserves the destination and never overwrites an existing backup.
    fs.linkSync(temporary, destination);
    return { destination, ...validation };
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function parseArgs(argv) {
  if (argv.length !== 1 || argv[0].startsWith('-')) throw new Error('Usage: npm run db:backup -- <new-destination.sqlite>');
  return argv[0];
}

async function main() {
  const destination = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const result = await writeBackup(config.dbPath, destination);
  console.log(`Verified SQLite backup created at ${result.destination} (schema ${result.schemaVersion}).`);
}

if (require.main === module) main().catch((error) => {
  console.error(`Database backup failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = { REQUIRED_SCHEMA_VERSION, validateDatabase, writeBackup };
