const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { AuthenticationError, ConflictError } = require('../errors');

// Session tokens are bearer credentials. Only their SHA-256 digest is stored, so a copied
// database file or backup cannot be replayed as a live session.
function sessionDigest(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
let timingEqualisationHash = null;
function dummyPasswordHash() {
  // Compared against when an email is unknown so that response time does not reveal
  // whether an account exists. Generated lazily with the same cost as real hashes.
  if (!timingEqualisationHash) timingEqualisationHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);
  return timingEqualisationHash;
}

function createAuthService(db, config) {
  const findUserByEmail = (email) => db.prepare(`
    SELECT users.*, doctors.id AS doctor_id
    FROM users LEFT JOIN doctors ON doctors.user_id = users.id
    WHERE users.email = ? COLLATE NOCASE
  `).get(String(email || '').trim().toLowerCase());

  const findUserById = (id) => db.prepare(`
    SELECT users.id, users.email, users.name, users.role, users.account_status, doctors.id AS doctor_id
    FROM users LEFT JOIN doctors ON doctors.user_id = users.id WHERE users.id = ?
  `).get(id);

  function publicUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.account_status || 'active',
      doctorId: row.doctor_id || null,
    };
  }

  function createUser({ email, name, role, password, googleSubject = null }) {
    const passwordHash = bcrypt.hashSync(password, 12);
    try {
      const result = db.prepare(`
        INSERT INTO users (email, name, role, password_hash, created_at, google_subject) VALUES (?, ?, ?, ?, ?, ?)
      `).run(email.trim().toLowerCase(), name.trim(), role, passwordHash, new Date().toISOString(), googleSubject);
      return publicUser(findUserById(result.lastInsertRowid));
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new ConflictError('A user with that email already exists');
      throw error;
    }
  }

  // Asynchronous comparison keeps the event loop responsive: a cost-12 bcrypt check
  // takes hundreds of milliseconds and must not stall every other request.
  async function authenticate(email, password) {
    const user = findUserByEmail(email);
    const matches = await bcrypt.compare(String(password || ''), user ? user.password_hash : dummyPasswordHash());
    if (!user || !matches || user.account_status !== 'active') {
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
      .run(sessionDigest(id), userId, csrfToken, expiresAt, createdAt.toISOString());
    return { id, csrfToken, expiresAt };
  }

  function getSession(id) {
    if (!id || !SESSION_TOKEN_PATTERN.test(String(id))) return null;
    const digest = sessionDigest(id);
    const session = db.prepare(`
      SELECT sessions.id, sessions.csrf_token, sessions.expires_at,
             users.id AS user_id, users.email, users.name, users.role, users.account_status,
             doctors.id AS doctor_id
      FROM sessions JOIN users ON users.id = sessions.user_id
      LEFT JOIN doctors ON doctors.user_id = users.id
      WHERE sessions.id = ?
    `).get(digest);
    if (!session) return null;
    if (session.account_status !== 'active' || new Date(session.expires_at) <= new Date()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(digest);
      return null;
    }
    return {
      id,
      csrfToken: session.csrf_token,
      expiresAt: session.expires_at,
      user: publicUser({
        id: session.user_id,
        email: session.email,
        name: session.name,
        role: session.role,
        doctor_id: session.doctor_id,
        account_status: session.account_status,
      }),
    };
  }

  function destroySession(id) {
    if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionDigest(id));
  }

  function destroyUserSessions(userId) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
  }

  function cleanupSessions() {
    return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString()).changes;
  }

  return {
    authenticate,
    createUser,
    createSession,
    getSession,
    destroySession,
    destroyUserSessions,
    cleanupSessions,
    findUserById,
  };
}

module.exports = { createAuthService, sessionDigest };
