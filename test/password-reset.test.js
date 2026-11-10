const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createPasswordResetService, tokenDigest } = require('../src/services/password-reset-service');

test('password recovery stores only token hashes, supersedes old tokens, and enforces expiry', async () => {
  const db = openDatabase(':memory:');
  try {
    const userId = db.prepare(`
      INSERT INTO users (email, name, role, password_hash, created_at)
      VALUES ('reset@example.test', 'Synthetic Reset', 'patient', 'old-hash', '2026-01-01T00:00:00.000Z')
    `).run().lastInsertRowid;
    const sessions = db.prepare(`
      INSERT INTO sessions (id, user_id, csrf_token, expires_at, created_at)
      VALUES ('synthetic-session', ?, 'synthetic-csrf', '2030-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(userId);
    assert.equal(sessions.changes, 1);
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const links = [];
    const service = createPasswordResetService({
      db,
      now: () => nowMs,
      tokenTtlMs: 60_000,
      adapter: { async deliver({ resetUrl }) { links.push(new URL(resetUrl).searchParams.get('token')); } },
    });

    await service.requestReset('reset@example.test', 'https://health.example.test');
    const firstToken = links[0];
    const firstHash = db.prepare('SELECT token_hash FROM password_reset_tokens ORDER BY id DESC LIMIT 1').get().token_hash;
    assert.equal(firstHash, tokenDigest(firstToken));
    assert.notEqual(firstHash, firstToken);

    await service.requestReset('reset@example.test', 'https://health.example.test');
    const secondToken = links[1];
    assert.equal(service.completeReset(firstToken, 'Replacement-Strong-Password-55!'), false);
    nowMs += 60_001;
    assert.equal(service.completeReset(secondToken, 'Replacement-Strong-Password-55!'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(userId).count, 1);
  } finally {
    db.close();
  }
});
