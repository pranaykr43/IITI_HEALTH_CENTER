const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { writeBackup, validateDatabase } = require('../scripts/database-backup');
const { restoreDatabase, requireStoppedDeclaration } = require('../scripts/database-restore');

const cleanupDirectories = [];
test.afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test('verified backup is non-overwriting and staged restore preserves a safety copy', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'health-centre-backup-'));
  cleanupDirectories.push(directory);
  const source = path.join(directory, 'source.sqlite');
  const target = path.join(directory, 'live.sqlite');
  const backup = path.join(directory, 'backup.sqlite');
  const db = openDatabase(source);
  db.prepare('INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, \'patient\', ?, ?)')
    .run('synthetic@example.test', 'Synthetic Patient', 'not-a-real-password-hash', '2026-01-01T00:00:00.000Z');
  db.close();

  const result = await writeBackup(source, backup);
  assert.equal(result.schemaVersion, 4);
  assert.equal(validateDatabase(backup).schemaVersion, 4);
  await assert.rejects(writeBackup(source, backup), /already exists|EEXIST/i);

  const live = openDatabase(target);
  live.prepare('INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, \'patient\', ?, ?)')
    .run('original@example.test', 'Original Patient', 'synthetic', '2026-01-02T00:00:00.000Z');
  live.close();
  assert.throws(() => requireStoppedDeclaration([backup]), /confirm-stopped/);
  const restored = await restoreDatabase(backup, target, { confirmStopped: true });
  assert.ok(fs.existsSync(restored.safetyPath));
  const check = openDatabase(target);
  assert.equal(check.prepare('SELECT email FROM users').get().email, 'synthetic@example.test');
  check.close();
  const safety = openDatabase(restored.safetyPath);
  assert.equal(safety.prepare('SELECT email FROM users').get().email, 'original@example.test');
  safety.close();
});
