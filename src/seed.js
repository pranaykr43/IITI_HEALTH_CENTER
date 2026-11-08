const { openDatabase, closeDatabase } = require('./db');
const { loadConfig } = require('./config');
const { createAuthService } = require('./services/auth-service');

function seedDemoData({ db, config = loadConfig() } = {}) {
  const ownsDb = !db;
  const database = db || openDatabase(config.dbPath);
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

  const result = {
    users: seeded,
    credentials: users.map(({ email, role }) => ({ email, role, password })),
  };
  if (ownsDb) closeDatabase(database);
  return result;
}

if (require.main === module) {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const result = seedDemoData({ db, config });
  console.log(JSON.stringify({
    database: config.dbPath,
    message: 'Demo data is ready. These credentials are for local development only.',
    credentials: result.credentials,
  }, null, 2));
  closeDatabase(db);
}

module.exports = { seedDemoData };
