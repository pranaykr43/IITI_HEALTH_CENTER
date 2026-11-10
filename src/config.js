const path = require('node:path');

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('COOKIE_SECURE must be a boolean value');
}

function loadConfig(overrides = {}) {
  const env = process.env;
  const nodeEnv = overrides.nodeEnv || env.NODE_ENV || 'development';
  const config = {
    nodeEnv,
    port: Number(overrides.port ?? env.PORT ?? 3000),
    dbPath: overrides.dbPath ?? env.HEALTH_DB_PATH ?? path.join(process.cwd(), 'data', 'health-centre.sqlite'),
    publicBaseUrl: overrides.publicBaseUrl ?? env.PUBLIC_BASE_URL ?? null,
    googleClientId: overrides.googleClientId ?? env.GOOGLE_CLIENT_ID ?? null,
    googleClientSecret: overrides.googleClientSecret ?? env.GOOGLE_CLIENT_SECRET ?? null,
    googleCallbackUrl: overrides.googleCallbackUrl ?? env.GOOGLE_CALLBACK_URL ?? null,
    sessionTtlSeconds: Number(overrides.sessionTtlSeconds ?? env.SESSION_TTL_SECONDS ?? 60 * 60 * 8),
    cookieSecure: overrides.cookieSecure ?? parseBoolean(env.COOKIE_SECURE, nodeEnv === 'production'),
    demoPassword: overrides.demoPassword ?? env.HEALTH_DEMO_PASSWORD ?? (nodeEnv === 'production' ? undefined : 'ChangeMe123!'),
    logLevel: overrides.logLevel || env.LOG_LEVEL || 'info',
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  if (!Number.isInteger(config.sessionTtlSeconds) || config.sessionTtlSeconds < 60) throw new Error('SESSION_TTL_SECONDS must be an integer of at least 60');
  if (nodeEnv === 'production' && !config.cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
  if (Boolean(config.googleClientId) !== Boolean(config.googleClientSecret)) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together');
  }
  if (config.googleClientId && !config.googleCallbackUrl) {
    const baseOrigin = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : `http://localhost:${config.port}`;
    config.googleCallbackUrl = `${baseOrigin}/auth/google/callback`;
  }
  if (config.googleCallbackUrl) {
    let parsed;
    try { parsed = new URL(config.googleCallbackUrl); } catch { throw new Error('GOOGLE_CALLBACK_URL must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('GOOGLE_CALLBACK_URL must use HTTP or HTTPS');
    if (nodeEnv === 'production' && parsed.protocol !== 'https:') throw new Error('GOOGLE_CALLBACK_URL must use HTTPS in production');
  }
  if (config.publicBaseUrl) {
    let parsed;
    try { parsed = new URL(config.publicBaseUrl); } catch { throw new Error('PUBLIC_BASE_URL must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('PUBLIC_BASE_URL must use HTTP or HTTPS');
    if (nodeEnv === 'production' && parsed.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS in production');
  }
  return config;
}

module.exports = { loadConfig };
