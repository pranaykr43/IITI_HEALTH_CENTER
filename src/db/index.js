const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

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
  return db;
}

function closeDatabase(db) {
  if (db && db.open) db.close();
}

module.exports = { openDatabase, closeDatabase };
