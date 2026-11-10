const pino = require('pino');
const os = require('node:os');
const { openDatabase } = require('../db');
const { createAppointmentService } = require('../services/appointment-service');
const { createConsoleNotificationAdapter } = require('../notifications/console-adapter');
const { createNotificationWorker } = require('./notification-worker');

function positiveIntegerFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function main() {
  const processOptions = {
    workerName: `notifications-${os.hostname()}-${process.pid}`.slice(0, 80),
    leaseMs: positiveIntegerFromEnv('NOTIFICATION_LEASE_MS', 30_000),
    maxAttempts: positiveIntegerFromEnv('NOTIFICATION_MAX_ATTEMPTS', 5),
    baseDelayMs: positiveIntegerFromEnv('NOTIFICATION_RETRY_BASE_MS', 1_000),
    maxDelayMs: positiveIntegerFromEnv('NOTIFICATION_RETRY_MAX_MS', 60_000),
  };
  if (processOptions.maxDelayMs < processOptions.baseDelayMs) {
    throw new Error('NOTIFICATION_RETRY_MAX_MS must be >= NOTIFICATION_RETRY_BASE_MS');
  }
  const dbPath = process.env.HEALTH_DB_PATH || './data/health-centre.sqlite';
  const db = openDatabase(dbPath);
  const appointments = createAppointmentService(db);
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
  const adapter = createConsoleNotificationAdapter({
    write: (line) => logger.info({ component: 'notification-adapter' }, line),
  });
  const worker = createNotificationWorker({
    appointments,
    adapter,
    logger,
    pollIntervalMs: positiveIntegerFromEnv('NOTIFICATION_POLL_INTERVAL_MS', 1_000),
    processOptions,
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'notification worker shutting down');
    try {
      await worker.stop();
    } finally {
      db.close();
    }
  };

  process.once('SIGINT', () => { shutdown('SIGINT').catch((error) => { logger.error({ err: error }, 'worker shutdown failed'); process.exitCode = 1; }); });
  process.once('SIGTERM', () => { shutdown('SIGTERM').catch((error) => { logger.error({ err: error }, 'worker shutdown failed'); process.exitCode = 1; }); });
  logger.info({ database: dbPath }, 'notification worker started with local console adapter');
  worker.start().catch((error) => {
    logger.error({ err: error }, 'notification worker stopped unexpectedly');
    process.exitCode = 1;
    shutdown('worker-error').catch((shutdownError) => logger.error({ err: shutdownError }, 'worker shutdown failed'));
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main, positiveIntegerFromEnv };
