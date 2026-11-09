const { openDatabase, closeDatabase } = require('./db');
const { loadConfig } = require('./config');
const { createAuthService } = require('./services/auth-service');

function seedDemoData({ db, config = loadConfig() } = {}) {
  assertDemoSeedingAllowed(config);
  const ownsDb = !db;
  const database = db || openDatabase(config.dbPath);
  try {
    const auth = createAuthService(database, config);
    const password = config.demoPassword;
    const users = [
      { email: 'admin@health.local', name: 'Demo Administrator', role: 'admin' },
      { email: 'doctor@health.local', name: 'Dr. Demo', role: 'doctor' },
      { email: 'patient@health.local', name: 'Demo Patient', role: 'patient' },
    ];

    const seeded = users.map((input) => {
      const existing = database.prepare('SELECT id, email, name, role FROM users WHERE email = ? COLLATE NOCASE').get(input.email);
      return existing || auth.createUser({ ...input, password });
    });
    const doctorUser = seeded.find((user) => user.role === 'doctor');
    const existingDoctor = database.prepare('SELECT id FROM doctors WHERE user_id = ?').get(doctorUser.id);
    if (!existingDoctor) {
      database.prepare(`
        INSERT INTO doctors (user_id, qualification, specialization, available_days, start_time, end_time)
        VALUES (?, 'MBBS', 'General medicine', 'Monday-Friday', '09:00', '17:00')
      `).run(doctorUser.id);
    }

    return {
      users: seeded,
      credentials: users.map(({ email, role }) => ({ email, role, password })),
    };
  } finally {
    if (ownsDb) closeDatabase(database);
  }
}

function assertDemoSeedingAllowed(config) {
  if (config.nodeEnv === 'production') throw new Error('Demo data seeding is disabled in production');
  if (typeof config.demoPassword !== 'string' || config.demoPassword.length < 12) {
    throw new Error('HEALTH_DEMO_PASSWORD must be at least 12 characters before seeding demo accounts');
  }
}

if (require.main === module) {
  let db;
  try {
    const config = loadConfig();
    assertDemoSeedingAllowed(config);
    db = openDatabase(config.dbPath);
    const result = seedDemoData({ db, config });
    console.log(JSON.stringify({
      database: config.dbPath,
      message: 'Demo data is ready. These credentials are for local development only.',
      credentials: result.credentials,
    }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    closeDatabase(db);
  }
}

module.exports = { seedDemoData, assertDemoSeedingAllowed };
