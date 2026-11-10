const crypto = require('node:crypto');
const { AuthorizationError, AuthenticationError, ConflictError, NotFoundError, ValidationError } = require('../errors');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_ROLES = new Set(['patient', 'doctor', 'admin']);

function normalizeAccount(input) {
  const email = String(input.email || '').trim().toLowerCase();
  const name = String(input.name || '').trim();
  const password = String(input.password || '');
  const role = String(input.role || '').trim().toLowerCase();
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) throw new ValidationError('Enter a valid email address');
  if (!name || name.length > 120) throw new ValidationError('Name must be between 1 and 120 characters');
  if (password.length < 12 || password.length > 200) throw new ValidationError('Password must be between 12 and 200 characters');
  if (!ACCOUNT_ROLES.has(role)) throw new ValidationError('Choose a valid account role');
  return { email, name, password, role };
}

function createAccountService({ db, auth, now = () => new Date() }) {
  const createAccount = db.transaction((actor, input, allowAdmin = false) => {
    if (!actor || actor.role !== 'admin') throw new AuthorizationError();
    const account = normalizeAccount(input);
    if (account.role === 'admin' && allowAdmin !== true) {
      throw new AuthorizationError('Administrator creation requires the privileged operation');
    }

    const createdAt = now().toISOString();
    const user = auth.createUser(account);
    if (account.role === 'doctor') {
      db.prepare(`
        INSERT INTO doctors (user_id, qualification, specialization, available_days, start_time, end_time)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        user.id,
        String(input.qualification || 'MBBS').trim().slice(0, 120),
        String(input.specialization || 'General medicine').trim().slice(0, 120),
        String(input.availableDays || 'Monday-Friday').trim().slice(0, 120),
        String(input.startTime || '09:00'),
        String(input.endTime || '17:00'),
      );
    }
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (?, 'account.created', 'user', ?, ?, ?)
    `).run(actor.id, String(user.id), JSON.stringify({ role: account.role }), createdAt);
    return { ...user, status: 'active' };
  }).immediate;

  const changeStatus = db.transaction((actor, targetUserId, nextStatus) => {
    if (!actor || actor.role !== 'admin') throw new AuthorizationError();
    if (!['active', 'disabled'].includes(nextStatus)) throw new ValidationError('Invalid account status');
    const target = db.prepare('SELECT id, role, account_status FROM users WHERE id = ?').get(targetUserId);
    if (!target) throw new NotFoundError('Account not found');
    if (target.account_status === nextStatus) return { ...target, unchanged: true };

    if (target.role === 'admin' && nextStatus === 'disabled') {
      const activeAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND account_status = 'active'").get().count;
      if (activeAdmins <= 1) throw new ConflictError('The last active administrator cannot be disabled');
    }

    const changedAt = now().toISOString();
    const updated = db.prepare(`
      UPDATE users SET account_status = ? WHERE id = ? AND account_status = ?
    `).run(nextStatus, targetUserId, target.account_status);
    if (updated.changes !== 1) throw new ConflictError('Account status changed concurrently');
    if (nextStatus === 'disabled') {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
    }
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (?, ?, 'user', ?, ?, ?)
    `).run(actor.id, `account.${nextStatus}`, String(targetUserId), JSON.stringify({ previousStatus: target.account_status }), changedAt);
    return { ...target, account_status: nextStatus, unchanged: false };
  }).immediate;

  const registerPatient = db.transaction((input) => {
    const account = normalizeAccount({ ...input, role: 'patient' });
    const user = auth.createUser(account);
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (NULL, 'patient.registered', 'user', ?, '{}', ?)
    `).run(String(user.id), now().toISOString());
    return { ...user, status: 'active' };
  }).immediate;

  const authenticateGooglePatient = db.transaction(({ email, name, subject }) => {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedSubject = String(subject || '').trim();
    const safeName = String(name || '').trim().slice(0, 120) || normalizedEmail.split('@')[0];
    if (!normalizedEmail || !normalizedSubject) throw new AuthenticationError('Google sign-in could not be verified');
    const existing = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(normalizedEmail);
    let user;
    if (existing) {
      if (existing.role !== 'patient' || existing.account_status !== 'active') {
        throw new AuthenticationError('This Google account cannot be used for patient sign-in');
      }
      if (existing.google_subject && existing.google_subject !== normalizedSubject) {
        throw new ConflictError('This email is already linked to a different Google account');
      }
      const claimed = db.prepare(`
        UPDATE users SET google_subject = ? WHERE id = ? AND (google_subject IS NULL OR google_subject = ?)
      `).run(normalizedSubject, existing.id, normalizedSubject);
      if (claimed.changes !== 1) throw new ConflictError('This Google account is already linked to another user');
      user = auth.findUserById(existing.id);
    } else {
      const randomPassword = crypto.randomBytes(48).toString('base64url');
      user = auth.createUser({ email: normalizedEmail, name: safeName, role: 'patient', password: randomPassword, googleSubject: normalizedSubject });
    }
    db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (?, 'patient.google_authenticated', 'user', ?, '{}', ?)
    `).run(user.id, String(user.id), now().toISOString());
    return { ...user, status: 'active' };
  }).immediate;

  function listAccounts() {
    return db.prepare(`
      SELECT id, email, name, role, account_status AS status, created_at AS createdAt
      FROM users ORDER BY created_at DESC, id DESC
    `).all();
  }

  return {
    createAccount,
    registerPatient,
    authenticateGooglePatient,
    changeStatus,
    listAccounts,
  };
}

module.exports = { createAccountService, normalizeAccount };
