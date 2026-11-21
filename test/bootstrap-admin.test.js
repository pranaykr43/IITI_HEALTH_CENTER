const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createAuthService } = require('../src/services/auth-service');
const { bootstrapInitialAdmin } = require('../scripts/bootstrap-admin');

function createSystem() {
  const db = openDatabase(':memory:');
  const auth = createAuthService(db, { sessionTtlSeconds: 3600 });
  return { db, auth };
}

test('initial administrator bootstrap creates exactly one audited admin', () => {
  const { db, auth } = createSystem();
  try {
    const created = bootstrapInitialAdmin({
      db, auth, email: ' First.Admin@Example.test ', name: 'First Admin', password: 'Bootstrap-Strong-Password-91!',
    });
    assert.equal(created.email, 'first.admin@example.test');
    const admins = db.prepare("SELECT id, password_hash FROM users WHERE role = 'admin'").all();
    assert.equal(admins.length, 1);
    assert.notEqual(admins[0].password_hash, 'Bootstrap-Strong-Password-91!');
    const audit = db.prepare("SELECT action, actor_user_id FROM audit_log WHERE action = 'admin.bootstrap'").get();
    assert.equal(audit.actor_user_id, null);

    assert.throws(() => bootstrapInitialAdmin({
      db, auth, email: 'second@example.test', name: 'Second Admin', password: 'Bootstrap-Strong-Password-92!',
    }), /administrator already exists/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count, 1);
  } finally {
    db.close();
  }
});

test('initial administrator bootstrap rejects weak or malformed input without writing', () => {
  const { db, auth } = createSystem();
  try {
    assert.throws(() => bootstrapInitialAdmin({ db, auth, email: 'not-an-email', name: 'Admin', password: 'Bootstrap-Strong-Password-91!' }), /valid email/);
    assert.throws(() => bootstrapInitialAdmin({ db, auth, email: 'admin@example.test', name: '', password: 'Bootstrap-Strong-Password-91!' }), /Name must be/);
    assert.throws(() => bootstrapInitialAdmin({ db, auth, email: 'admin@example.test', name: 'Admin', password: 'short-pass' }), /14 to 200/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count, 0);
  } finally {
    db.close();
  }
});
