#!/usr/bin/env node
const { openDatabase } = require('../src/db');
const { loadConfig } = require('../src/config');
const { createAuthService } = require('../src/services/auth-service');

function readHidden(prompt, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('Run admin bootstrap directly in an interactive terminal.');
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => { input.setRawMode(false); input.pause(); input.removeListener('data', onData); };
    const onData = (buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\u0003') { cleanup(); output.write('\n'); reject(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); output.write('\n'); resolve(value); return; }
        if (char === '\u0008' || char === '\u007f') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    input.on('data', onData);
  });
}

function bootstrapInitialAdmin({ db, auth, email, name, password }) {
  return db.transaction(() => {
    const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (existing) throw new Error('An administrator already exists; initial bootstrap is disabled.');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedName = String(name || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 320) throw new Error('Enter a valid email address.');
    if (!normalizedName || normalizedName.length > 120) throw new Error('Name must be between 1 and 120 characters.');
    if (typeof password !== 'string' || password.length < 14 || password.length > 200) throw new Error('Password must contain 14 to 200 characters.');
    const user = auth.createUser({ email: normalizedEmail, name: normalizedName, role: 'admin', password });
    db.prepare(`INSERT INTO audit_log (actor_user_id, action, aggregate_type, aggregate_id, metadata_json, created_at)
      VALUES (NULL, 'admin.bootstrap', 'user', ?, '{"method":"interactive-cli"}', ?)`)
      .run(String(user.id), new Date().toISOString());
    return { id: user.id, email: user.email };
  }).immediate();
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Usage: npm run admin:create (interactive; accepts no arguments).');
  const config = loadConfig();
  if (config.nodeEnv !== 'production') throw new Error('Initial administrator bootstrap is enabled only in production.');
  const db = openDatabase(config.dbPath);
  try {
    const auth = createAuthService(db, config);
    if (db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) throw new Error('An administrator already exists; initial bootstrap is disabled.');
    const email = await readHidden('Administrator email: ');
    const name = await readHidden('Administrator name: ');
    const password = await readHidden('Administrator password (hidden): ');
    const confirmation = await readHidden('Confirm password (hidden): ');
    if (password !== confirmation) throw new Error('Passwords did not match.');
    const user = bootstrapInitialAdmin({ db, auth, email, name, password });
    console.log(`Initial administrator created for ${user.email}. No password was displayed.`);
  } finally {
    db.close();
  }
}

if (require.main === module) main().catch((error) => { console.error(`Admin bootstrap failed: ${error.message}`); process.exitCode = 1; });
module.exports = { bootstrapInitialAdmin, readHidden };
