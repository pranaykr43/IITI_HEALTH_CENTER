const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { ValidationError } = require('../errors');

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createPasswordResetService({
  db,
  adapter,
  now = Date.now,
  tokenTtlMs = 30 * 60 * 1000,
  reportDeliveryFailure = () => {},
}) {
  if (!Number.isInteger(tokenTtlMs) || tokenTtlMs < 60_000) throw new TypeError('tokenTtlMs must be at least one minute');
  if (!adapter || typeof adapter.deliver !== 'function') throw new TypeError('adapter.deliver is required');

  async function requestReset(emailInput, baseUrl) {
    const startedAt = Date.now();
    const email = String(emailInput || '').trim().toLowerCase();
    if (email.length > 320 || !/^\S+@\S+\.\S+$/.test(email)) return;

    const user = db.prepare(`
      SELECT id, email FROM users WHERE email = ? COLLATE NOCASE AND account_status = 'active'
    `).get(email);
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const createdAtMs = now();
      const createdAt = new Date(createdAtMs).toISOString();
      const expiresAt = new Date(createdAtMs + tokenTtlMs).toISOString();
      db.transaction(() => {
        db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
          .run(createdAt, user.id);
        db.prepare(`
          INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
          VALUES (?, ?, ?, ?)
        `).run(user.id, tokenDigest(rawToken), expiresAt, createdAt);
      }).immediate();

      const resetUrl = new URL('/password/reset', baseUrl);
      resetUrl.searchParams.set('token', rawToken);
      try {
        await adapter.deliver({ email: user.email, resetUrl: resetUrl.toString(), expiresAt });
      } catch {
        reportDeliveryFailure();
      }
    }
    // Keep unknown and active-account requests close in timing, even with a fast local adapter.
    const delayMs = 100 - (Date.now() - startedAt);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  function completeReset(tokenInput, passwordInput) {
    const token = String(tokenInput || '');
    const password = String(passwordInput || '');
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) return false;
    if (password.length < 12 || password.length > 200) {
      throw new ValidationError('Password must be between 12 and 200 characters');
    }
    const nowIso = new Date(now()).toISOString();
    const passwordHash = bcrypt.hashSync(password, 12);

    return db.transaction(() => {
      const reset = db.prepare(`
        SELECT password_reset_tokens.id, password_reset_tokens.user_id
        FROM password_reset_tokens JOIN users ON users.id = password_reset_tokens.user_id
        WHERE password_reset_tokens.token_hash = ?
          AND password_reset_tokens.used_at IS NULL
          AND password_reset_tokens.expires_at > ?
          AND users.account_status = 'active'
      `).get(tokenDigest(token), nowIso);
      if (!reset) return false;

      const consumed = db.prepare(`
        UPDATE password_reset_tokens SET used_at = ?
        WHERE id = ? AND used_at IS NULL AND expires_at > ?
      `).run(nowIso, reset.id, nowIso);
      if (consumed.changes !== 1) return false;
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND account_status = \'active\'')
        .run(passwordHash, reset.user_id);
      db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
        .run(nowIso, reset.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);
      db.prepare(`
        INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
        VALUES (?, 'password.reset', 'user', ?, '{}', ?)
      `).run(reset.user_id, String(reset.user_id), nowIso);
      return true;
    }).immediate();
  }

  return { requestReset, completeReset };
}

module.exports = { createPasswordResetService, tokenDigest };
