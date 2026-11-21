const crypto = require('node:crypto');
const { AuthenticationError, AuthorizationError, ConflictError, NotFoundError, ValidationError } = require('../errors');
const { createSecretBox } = require('../security/secret-box');
const { generateSecret, verifyTotp, otpauthUri } = require('../security/totp');

const ISSUER = 'Health Centre';
const RECOVERY_CODE_COUNT = 10;
const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_ATTEMPTS = 5;
const STAFF_ROLES = new Set(['doctor', 'admin']);

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Recovery codes are 50 random bits shown as two groups of five base32 characters. They
// are compared case-insensitively and stored only as SHA-256 digests.
// Digits that look like letters are mapped back (0 to o, 1 to l, 8 to b) because the
// base32 alphabet never contains them.
function normalizeRecoveryCode(value) {
  return String(value || '').toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l').replace(/8/g, 'b').replace(/[^a-z2-7]/g, '');
}

function newRecoveryCode() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = crypto.randomBytes(10);
  const chars = [...bytes].map((byte) => alphabet[byte & 31]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

function createMfaService({ db, config, now = () => Date.now() }) {
  const box = createSecretBox(config.mfaEncryptionKey);
  const seal = (userId, secret) => box.seal(secret, `user:${userId}`);
  const open = (userId, sealed) => box.open(sealed, `user:${userId}`);
  const nowIso = () => new Date(now()).toISOString();
  const audit = (actorId, action, targetId, metadata = {}) => db.prepare(`
    INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
    VALUES (?, ?, 'user', ?, ?, ?)
  `).run(actorId, action, String(targetId), JSON.stringify(metadata), nowIso());

  const getRow = (userId) => db.prepare('SELECT * FROM user_mfa WHERE user_id = ?').get(userId);

  const protectedSet = new Set((config.demoProtectedEmails || []).map((email) => String(email).toLowerCase()));
  function isDemoLocked(user) {
    return Boolean(user && protectedSet.has(String(user.email).toLowerCase()));
  }
  const assertNotDemoLocked = (user) => {
    if (isDemoLocked(user)) throw new ConflictError('Two-factor setup is turned off for the shared demo accounts. Register your own patient account to try it.');
  };

  function isRequiredFor(user) {
    return Boolean(config.staffMfaRequired && user && STAFF_ROLES.has(user.role));
  }

  function isEnabled(userId) {
    return Boolean(getRow(userId)?.enabled_at);
  }

  function status(userId) {
    const row = getRow(userId);
    const remaining = row?.enabled_at
      ? db.prepare('SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId).count
      : 0;
    return { enabled: Boolean(row?.enabled_at), enabledAt: row?.enabled_at || null, recoveryCodesRemaining: remaining };
  }

  // Returns the not-yet-confirmed seed for this user, creating one if needed. Reusing the
  // pending seed keeps the QR code stable if the setup page is reloaded.
  const ensurePendingEnrollment = db.transaction((user) => {
    assertNotDemoLocked(user);
    const row = getRow(user.id);
    if (row?.enabled_at) throw new ConflictError('Two-factor authentication is already enabled');
    let secret;
    if (row) {
      secret = open(user.id, row.secret_ciphertext);
    } else {
      secret = generateSecret();
      db.prepare('INSERT INTO user_mfa (user_id, secret_ciphertext, created_at) VALUES (?, ?, ?)').run(user.id, seal(user.id, secret), nowIso());
    }
    return { secret, otpauthUri: otpauthUri({ issuer: ISSUER, account: user.email, secret }) };
  }).immediate;

  function replaceRecoveryCodes(userId) {
    db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)');
    const codes = [];
    while (codes.length < RECOVERY_CODE_COUNT) {
      const code = newRecoveryCode();
      if (codes.includes(code)) continue;
      insert.run(userId, digest(normalizeRecoveryCode(code)), nowIso());
      codes.push(code);
    }
    return codes;
  }

  // Confirms the pending seed with a valid code, issues recovery codes, and signs out every
  // other session of the user, since those were established with a password alone.
  const confirmEnrollment = db.transaction((user, code, currentSessionDigest) => {
    assertNotDemoLocked(user);
    const row = getRow(user.id);
    if (!row) throw new ConflictError('Start two-factor setup before confirming it');
    if (row.enabled_at) throw new ConflictError('Two-factor authentication is already enabled');
    const step = verifyTotp(open(user.id, row.secret_ciphertext), code, { nowMs: now() });
    if (step === null) throw new ValidationError('That code is not valid. Check the time on your device and try the newest code.');
    db.prepare('UPDATE user_mfa SET enabled_at = ?, last_used_step = ? WHERE user_id = ? AND enabled_at IS NULL').run(nowIso(), step, user.id);
    const recoveryCodes = replaceRecoveryCodes(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(user.id, currentSessionDigest || '');
    audit(user.id, 'mfa.enabled', user.id);
    return { recoveryCodes };
  }).immediate;

  // Verifies a TOTP code (advancing the replay barrier atomically) or consumes one recovery
  // code. Returns { method, recoveryCodesRemaining } or null.
  const verifySecondFactor = db.transaction((userId, { code, recoveryCode } = {}) => {
    const row = getRow(userId);
    if (!row?.enabled_at) return null;
    if (code) {
      const step = verifyTotp(open(userId, row.secret_ciphertext), code, { nowMs: now(), lastUsedStep: row.last_used_step });
      if (step === null) return null;
      const advanced = db.prepare('UPDATE user_mfa SET last_used_step = ? WHERE user_id = ? AND last_used_step < ?').run(step, userId, step);
      return advanced.changes === 1 ? { method: 'totp' } : null;
    }
    const normalized = normalizeRecoveryCode(recoveryCode);
    if (normalized.length !== 10) return null;
    const used = db.prepare(`
      UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL
    `).run(nowIso(), userId, digest(normalized));
    if (used.changes !== 1) return null;
    const remaining = db.prepare('SELECT COUNT(*) AS count FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId).count;
    audit(userId, 'mfa.recovery_code_used', userId, { remaining });
    return { method: 'recovery', recoveryCodesRemaining: remaining };
  }).immediate;

  const disable = db.transaction((user, code) => {
    if (isRequiredFor(user)) throw new ConflictError('Two-factor authentication is required for your role and cannot be turned off');
    if (!isEnabled(user.id)) throw new ConflictError('Two-factor authentication is not enabled');
    if (!verifySecondFactor(user.id, { code })) throw new ValidationError('Enter a current code from your authenticator app to turn off two-factor authentication');
    db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM user_mfa WHERE user_id = ?').run(user.id);
    audit(user.id, 'mfa.disabled', user.id);
  }).immediate;

  const regenerateRecoveryCodes = db.transaction((user, code) => {
    if (!isEnabled(user.id)) throw new ConflictError('Two-factor authentication is not enabled');
    if (!verifySecondFactor(user.id, { code })) throw new ValidationError('Enter a current code from your authenticator app to create new recovery codes');
    const recoveryCodes = replaceRecoveryCodes(user.id);
    audit(user.id, 'mfa.recovery_codes_regenerated', user.id);
    return { recoveryCodes };
  }).immediate;

  // For a lost device: an administrator clears another user's second factor. The user's
  // sessions are revoked; staff must enrol again at their next sign-in.
  const adminReset = db.transaction((actor, targetUserId) => {
    if (!actor || actor.role !== 'admin') throw new AuthorizationError();
    if (Number(targetUserId) === actor.id) throw new ConflictError('Administrators cannot reset their own two-factor authentication');
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
    if (!target) throw new NotFoundError('Account not found');
    const removed = db.prepare('DELETE FROM user_mfa WHERE user_id = ?').run(target.id).changes;
    db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    audit(actor.id, 'mfa.reset', target.id, { hadMfa: removed === 1 });
    return { reset: removed === 1 };
  }).immediate;

  function createPendingLogin(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const createdAt = now();
    db.prepare('INSERT INTO mfa_pending_logins (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(digest(token), userId, new Date(createdAt + PENDING_LOGIN_TTL_MS).toISOString(), new Date(createdAt).toISOString());
    return { token, expiresInMs: PENDING_LOGIN_TTL_MS };
  }

  function getPendingLogin(token) {
    if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
    const row = db.prepare(`
      SELECT mfa_pending_logins.*, users.account_status FROM mfa_pending_logins
      JOIN users ON users.id = mfa_pending_logins.user_id WHERE token_hash = ?
    `).get(digest(token));
    if (!row || row.expires_at <= nowIso() || row.account_status !== 'active' || row.attempts >= MAX_PENDING_ATTEMPTS) return null;
    return { userId: row.user_id, attemptsRemaining: MAX_PENDING_ATTEMPTS - row.attempts };
  }

  // Completes a pending sign-in. Each wrong code consumes one of five attempts; the pending
  // sign-in is deleted on success or when attempts run out, so a password alone is never
  // enough to keep guessing codes.
  function completePendingLogin(token, factor) {
    const pending = getPendingLogin(token);
    if (!pending) throw new AuthenticationError('Your sign-in expired. Enter your email and password again.');
    const tokenHash = digest(token);
    const result = verifySecondFactor(pending.userId, factor);
    if (!result) {
      const attempts = db.prepare('UPDATE mfa_pending_logins SET attempts = attempts + 1 WHERE token_hash = ? RETURNING attempts').get(tokenHash)?.attempts ?? MAX_PENDING_ATTEMPTS;
      if (attempts >= MAX_PENDING_ATTEMPTS) {
        db.prepare('DELETE FROM mfa_pending_logins WHERE token_hash = ?').run(tokenHash);
        audit(pending.userId, 'mfa.challenge_locked', pending.userId);
        throw new AuthenticationError('Too many incorrect codes. Sign in again with your email and password.');
      }
      throw new AuthenticationError(`That code is not valid. ${MAX_PENDING_ATTEMPTS - attempts} attempt${MAX_PENDING_ATTEMPTS - attempts === 1 ? '' : 's'} remaining.`);
    }
    db.prepare('DELETE FROM mfa_pending_logins WHERE token_hash = ?').run(tokenHash);
    return { userId: pending.userId, ...result };
  }

  return {
    isDemoLocked,
    isRequiredFor,
    isEnabled,
    status,
    ensurePendingEnrollment,
    confirmEnrollment,
    verifySecondFactor,
    disable,
    regenerateRecoveryCodes,
    adminReset,
    createPendingLogin,
    getPendingLogin,
    completePendingLogin,
  };
}

module.exports = {
  createMfaService,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  MAX_PENDING_ATTEMPTS,
  PENDING_LOGIN_TTL_MS,
};
