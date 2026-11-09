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
server.listen(config.port, () => {
  system.app.locals.logger?.info?.({ port: config.port }, 'health centre listening');
  console.log(`Health Centre listening on http://127.0.0.1:${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close(() => {
    system.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { server, system };
