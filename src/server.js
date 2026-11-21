const http = require('node:http');
const { createApp } = require('./http/app');
const { loadConfig } = require('./config');
const { seedDemoData } = require('./seed');

const config = loadConfig();
if (config.nodeEnv === 'production' && process.env.SEED_ON_START === 'true') {
  throw new Error('SEED_ON_START is disabled in production; provision accounts through an approved process');
}
const system = createApp({ config });
if (process.env.SEED_ON_START === 'true') seedDemoData({ db: system.db, config });

const server = http.createServer(system.app);
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;
server.listen(config.port, () => {
  system.logger.info({ port: config.port, clinicTimeZone: config.clinicTimeZone }, 'health centre listening');
});

function runHousekeeping() {
  try {
    const removed = system.housekeeping.run();
    system.logger.info({ component: 'housekeeping', removed }, 'housekeeping completed');
  } catch (error) {
    system.logger.error({ component: 'housekeeping', err: error }, 'housekeeping failed');
  }
}
runHousekeeping();
const housekeepingTimer = setInterval(runHousekeeping, 60 * 60 * 1000);
housekeepingTimer.unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  system.logger.info({ signal }, 'shutting down');
  clearInterval(housekeepingTimer);
  const forceExit = setTimeout(() => {
    system.logger.error('graceful shutdown timed out; exiting');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  server.close(() => {
    system.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server, system };
