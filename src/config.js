const path = require('node:path');

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function loadConfig(overrides = {}) {
  const env = process.env;
  const nodeEnv = overrides.nodeEnv || env.NODE_ENV || 'development';
  const config = {
    nodeEnv,
    port: Number(overrides.port ?? env.PORT ?? 3000),
    dbPath: overrides.dbPath ?? env.HEALTH_DB_PATH ?? path.join(process.cwd(), 'data', 'health-centre.sqlite'),
    sessionTtlSeconds: Number(overrides.sessionTtlSeconds ?? env.SESSION_TTL_SECONDS ?? 60 * 60 * 8),
    cookieSecure: overrides.cookieSecure ?? parseBoolean(env.COOKIE_SECURE, nodeEnv === 'production'),
    demoPassword: overrides.demoPassword || env.HEALTH_DEMO_PASSWORD || 'ChangeMe123!',
    logLevel: overrides.logLevel || env.LOG_LEVEL || 'info',
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  if (!Number.isInteger(config.sessionTtlSeconds) || config.sessionTtlSeconds < 60) throw new Error('SESSION_TTL_SECONDS must be an integer of at least 60');
  return config;
}

module.exports = { loadConfig };
