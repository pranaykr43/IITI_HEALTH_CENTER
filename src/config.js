const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config();

function parseBoolean(value, fallback, name = 'COOKIE_SECURE') {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean value`);
}

function loadConfig(overrides = {}) {
  const env = process.env;
  const nodeEnv = overrides.nodeEnv || env.NODE_ENV || 'development';
  if (!['development', 'test', 'production', 'demo'].includes(nodeEnv)) throw new Error('NODE_ENV must be development, test, demo, or production');
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
    trustProxyHops: Number(overrides.trustProxyHops ?? env.TRUST_PROXY_HOPS ?? 0),
    resendApiKey: overrides.resendApiKey ?? env.RESEND_API_KEY ?? null,
    emailFrom: overrides.emailFrom ?? env.EMAIL_FROM ?? null,
    demoMode: (overrides.demoMode ?? env.DEMO_MODE ?? 'false') === true || String(overrides.demoMode ?? env.DEMO_MODE ?? 'false').toLowerCase() === 'true',
    clinicTimeZone: overrides.clinicTimeZone ?? env.CLINIC_TIMEZONE ?? 'Asia/Kolkata',
    slotMinutes: Number(overrides.slotMinutes ?? env.APPOINTMENT_SLOT_MINUTES ?? 15),
    metricsToken: overrides.metricsToken ?? env.METRICS_TOKEN ?? null,
    mfaEncryptionKey: overrides.mfaEncryptionKey ?? env.MFA_ENCRYPTION_KEY ?? null,
    staffMfaRequired: overrides.staffMfaRequired ?? parseBoolean(env.STAFF_MFA_REQUIRED, nodeEnv === 'production', 'STAFF_MFA_REQUIRED'),
  };
  if (config.mfaEncryptionKey === '') config.mfaEncryptionKey = null;
  if (!config.mfaEncryptionKey) {
    if (nodeEnv === 'production') throw new Error('MFA_ENCRYPTION_KEY must be set in production (32 random bytes, base64 or hex)');
    // Development and test only: a fixed, publicly known key so local databases keep working
    // across restarts. It never protects real secrets.
    config.mfaEncryptionKey = crypto.createHash('sha256').update('health-centre-insecure-development-mfa-key').digest('base64');
    config.mfaEncryptionKeyIsDevelopmentDefault = true;
  }
  {
    const text = String(config.mfaEncryptionKey).trim();
    const bytes = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
    if (bytes.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64 hex characters)');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.clinicTimeZone });
  } catch {
    throw new Error('CLINIC_TIMEZONE must be a valid IANA time zone such as Asia/Kolkata');
  }
  if (![5, 10, 15, 20, 30, 60].includes(config.slotMinutes)) throw new Error('APPOINTMENT_SLOT_MINUTES must be one of 5, 10, 15, 20, 30, or 60');
  if (config.metricsToken === '') config.metricsToken = null;
  if (config.metricsToken !== null && (typeof config.metricsToken !== 'string' || config.metricsToken.length < 32)) {
    throw new Error('METRICS_TOKEN must be at least 32 characters when configured');
  }
  const testOnlyMemoryDb = overrides.nodeEnv === 'production' && overrides.dbPath === ':memory:' && env.NODE_ENV !== 'production';
  if (nodeEnv === 'production' && !testOnlyMemoryDb) {
    const configuredDbPath = overrides.dbPath ?? env.HEALTH_DB_PATH;
    if (!configuredDbPath || configuredDbPath === ':memory:' || !path.isAbsolute(config.dbPath)) {
      throw new Error('HEALTH_DB_PATH must be explicitly configured as an absolute persistent path in production');
    }
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  if (!Number.isInteger(config.sessionTtlSeconds) || config.sessionTtlSeconds < 60) throw new Error('SESSION_TTL_SECONDS must be an integer of at least 60');
  if (nodeEnv === 'production' && !config.cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
  if (nodeEnv === 'production' && !config.demoMode) throw new Error('DEMO_MODE must be true in production; this application is for synthetic demonstrations only');
  if (!Number.isInteger(config.trustProxyHops) || config.trustProxyHops < 0 || config.trustProxyHops > 2) throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 2');
  if (nodeEnv === 'production' && config.trustProxyHops !== 1) throw new Error('TRUST_PROXY_HOPS must be 1 behind the configured Caddy proxy');
  if (nodeEnv === 'production' && (!config.publicBaseUrl || !config.publicBaseUrl.startsWith('https://'))) throw new Error('PUBLIC_BASE_URL must be an HTTPS URL in production');
  if (Boolean(config.resendApiKey) !== Boolean(config.emailFrom)) throw new Error('RESEND_API_KEY and EMAIL_FROM must be configured together');
  if (config.emailFrom && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.emailFrom) || config.emailFrom.length > 254)) throw new Error('EMAIL_FROM must be a valid sender email address');
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
    if (nodeEnv === 'production' && (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/')) throw new Error('PUBLIC_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment');
  }
  config.emailEnabled = Boolean(config.resendApiKey && config.emailFrom);
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(config.logLevel)) throw new Error('LOG_LEVEL must be a valid Pino level');
  return config;
}

module.exports = { loadConfig };
