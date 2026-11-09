const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');

const port = Number(process.env.E2E_PORT || 43173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('E2E_PORT must be a valid TCP port');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-centre-e2e-'));
const password = 'E2E-only-Strong-Password-2026!';
const config = {
  nodeEnv: 'test',
  port,
  dbPath: path.join(tempDir, 'e2e.sqlite'),
  cookieSecure: false,
  demoPassword: password,
  logLevel: 'silent',
};

let system;
let server;
let shuttingDown = false;

function cleanup() {
  try { system?.close(); } catch { /* The database may already be closed. */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!server?.listening) {
    cleanup();
    process.exit(0);
    return;
  }
  server.close(() => {
    cleanup();
    process.exit(0);
  });
}

try {
  system = createApp({ config, e2eShutdown: shutdown, rateLimitLimit: 5_000 });
  seedDemoData({ db: system.db, config });
  const secondDoctor = system.auth.createUser({
    email: 'doctor2@health.local',
    name: 'Dr. Second Demo',
    role: 'doctor',
    password,
  });
  system.db.prepare(`
    INSERT INTO doctors (user_id, qualification, specialization, available_days, start_time, end_time)
    VALUES (?, 'MBBS', 'General medicine', 'Monday-Friday', '09:00', '17:00')
  `).run(secondDoctor.id);

  server = http.createServer(system.app);
  server.on('error', (error) => {
    console.error(`E2E server failed: ${error.message}`);
    cleanup();
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`E2E_READY http://127.0.0.1:${port}`);
  });
} catch (error) {
  cleanup();
  throw error;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', cleanup);
