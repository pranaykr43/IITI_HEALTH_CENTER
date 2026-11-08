const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { AuthenticationError, ConflictError } = require('../errors');

function createAuthService(db, config) {
  const findUserByEmail = (email) => db.prepare(`
    SELECT users.*, doctors.id AS doctor_id
    FROM users LEFT JOIN doctors ON doctors.user_id = users.id
    WHERE users.email = ? COLLATE NOCASE
  `).get(String(email || '').trim().toLowerCase());

  const findUserById = (id) => db.prepare(`
    SELECT users.id, users.email, users.name, users.role, doctors.id AS doctor_id
    FROM users LEFT JOIN doctors ON doctors.user_id = users.id WHERE users.id = ?
  `).get(id);

  function publicUser(row) {
    if (!row) return null;
    return { id: row.id, email: row.email, name: row.name, role: row.role, doctorId: row.doctor_id || null };
  }

  function createUser({ email, name, role, password }) {
    const passwordHash = bcrypt.hashSync(password, 12);
    try {
      const result = db.prepare(`
        INSERT INTO users (email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)
      `).run(email.trim().toLowerCase(), name.trim(), role, passwordHash, new Date().toISOString());
      return publicUser(findUserById(result.lastInsertRowid));
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new ConflictError('A user with that email already exists');
      throw error;
    }
  }

  function authenticate(email, password) {
    const user = findUserByEmail(email);
    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
      throw new AuthenticationError('Invalid email or password');
    }
    return publicUser(user);
  }

  function createSession(userId) {
    const id = crypto.randomBytes(32).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + config.sessionTtlSeconds * 1000).toISOString();
    db.prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, csrfToken, expiresAt, createdAt.toISOString());
    return { id, csrfToken, expiresAt };
  }

  function getSession(id) {
    if (!id) return null;
    const session = db.prepare(`
      SELECT sessions.id, sessions.csrf_token, sessions.expires_at,
             users.id AS user_id, users.email, users.name, users.role,
             doctors.id AS doctor_id
      FROM sessions JOIN users ON users.id = sessions.user_id
      LEFT JOIN doctors ON doctors.user_id = users.id
      WHERE sessions.id = ?
    `).get(id);
    if (!session) return null;
    if (new Date(session.expires_at) <= new Date()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return null;
    }
    return {
      id: session.id,
      csrfToken: session.csrf_token,
      expiresAt: session.expires_at,
      user: publicUser({
        id: session.user_id,
        email: session.email,
        name: session.name,
        role: session.role,
        doctor_id: session.doctor_id,
      }),
    };
  }

  function destroySession(id) {
    if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  function cleanupSessions() {
    return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString()).changes;
  }

  return { authenticate, createUser, createSession, getSession, destroySession, cleanupSessions, findUserById };
}

module.exports = { createAuthService };
