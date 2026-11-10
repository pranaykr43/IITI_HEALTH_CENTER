const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const OUTBOX_RELIABILITY_MIGRATION = 1;
const ACCOUNT_LIFECYCLE_MIGRATION = 2;
const NOTIFICATION_OPERATIONS_MIGRATION = 3;

function migrateLegacyIdempotencyTable(db) {
  const columns = db.pragma('table_info(idempotency_keys)');
  const keyColumn = columns.find((column) => column.name === 'key');
  const actorColumn = columns.find((column) => column.name === 'actor_user_id');
  if (!keyColumn || !actorColumn || keyColumn.pk !== 1) return;

  db.transaction(() => {
    db.exec(`
      ALTER TABLE idempotency_keys RENAME TO idempotency_keys_legacy;
      CREATE TABLE idempotency_keys (
        key TEXT NOT NULL,
        actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (actor_user_id, key)
      );
      INSERT OR IGNORE INTO idempotency_keys (key, actor_user_id, request_hash, response_json, created_at)
      SELECT key, actor_user_id, request_hash, response_json, created_at FROM idempotency_keys_legacy;
      DROP TABLE idempotency_keys_legacy;
    `);
  })();
}

function migrateOutboxReliability(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version >= OUTBOX_RELIABILITY_MIGRATION) return;

  const columns = new Set(db.pragma('table_info(outbox_events)').map((column) => column.name));
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbox_events'").get()?.sql || '';
  const requiredColumns = ['claim_token', 'lease_expires_at', 'last_error', 'failed_at'];
  const needsRebuild = requiredColumns.some((column) => !columns.has(column)) || !definition.includes("'dead'");

  if (needsRebuild) {
    db.transaction(() => {
      db.exec(`
        DROP INDEX IF EXISTS idx_outbox_available;
        ALTER TABLE outbox_events RENAME TO outbox_events_before_reliability;
        CREATE TABLE outbox_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead')) DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          available_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          claim_token TEXT,
          lease_expires_at TEXT,
          last_error TEXT,
          failed_at TEXT
        );
      `);

      const optionalColumn = (name, fallback = 'NULL') => (columns.has(name) ? name : fallback);
      const leaseExpression = columns.has('lease_expires_at')
        ? 'lease_expires_at'
        : "CASE WHEN status = 'processing' THEN available_at ELSE NULL END";
      db.exec(`
        INSERT INTO outbox_events (
          id, event_id, event_type, aggregate_id, payload_json, status, attempts,
          available_at, created_at, delivered_at, claim_token, lease_expires_at, last_error, failed_at
        )
        SELECT id, event_id, event_type, aggregate_id, payload_json, status, attempts,
          available_at, created_at, ${optionalColumn('delivered_at')},
          ${optionalColumn('claim_token')}, ${leaseExpression},
          ${optionalColumn('last_error')}, ${optionalColumn('failed_at')}
        FROM outbox_events_before_reliability;
        DROP TABLE outbox_events_before_reliability;
        CREATE INDEX idx_outbox_available ON outbox_events(status, available_at, id);
      `);
    })();
  }

  db.pragma(`user_version = ${OUTBOX_RELIABILITY_MIGRATION}`);
}

function migrateAccountLifecycle(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version >= ACCOUNT_LIFECYCLE_MIGRATION) return;
  const columns = new Set(db.pragma('table_info(users)').map((column) => column.name));
  db.transaction(() => {
    if (!columns.has('account_status')) {
      db.exec("ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'disabled'))");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id, created_at DESC);
    `);
    db.pragma(`user_version = ${ACCOUNT_LIFECYCLE_MIGRATION}`);
  }).immediate();
}

function migrateNotificationOperations(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version >= NOTIFICATION_OPERATIONS_MIGRATION) return;
  const columns = new Set(db.pragma('table_info(outbox_events)').map((column) => column.name));
  db.transaction(() => {
    if (!columns.has('redrive_count')) {
      db.exec('ALTER TABLE outbox_events ADD COLUMN redrive_count INTEGER NOT NULL DEFAULT 0 CHECK (redrive_count >= 0)');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_worker_heartbeats (
        worker_name TEXT PRIMARY KEY,
        last_seen_at TEXT NOT NULL
      );
    `);
    db.pragma(`user_version = ${NOTIFICATION_OPERATIONS_MIGRATION}`);
  }).immediate();
}

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.exec(schema);
  migrateLegacyIdempotencyTable(db);
  migrateOutboxReliability(db);
  migrateAccountLifecycle(db);
  migrateNotificationOperations(db);
  return db;
}

function closeDatabase(db) {
  if (db && db.open) db.close();
}

module.exports = {
  openDatabase,
  closeDatabase,
  migrateOutboxReliability,
  migrateAccountLifecycle,
  migrateNotificationOperations,
};
