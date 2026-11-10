const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('../src/config');

test('configuration rejects unsafe port and session values', () => {
  assert.throws(() => loadConfig({ port: 0 }), /PORT/);
  assert.throws(() => loadConfig({ sessionTtlSeconds: 30 }), /SESSION_TTL_SECONDS/);
});

test('production requires secure cookies and has no demo password fallback', () => {
  const config = loadConfig({ nodeEnv: 'production' });
  assert.equal(config.cookieSecure, true);
  assert.equal(config.demoPassword, undefined);
  assert.throws(() => loadConfig({ nodeEnv: 'production', cookieSecure: false }), /COOKIE_SECURE must be true/);
});

test('cookie secure environment parsing rejects unknown values', () => {
  const previous = process.env.COOKIE_SECURE;
  process.env.COOKIE_SECURE = 'sometimes';
  try {
    assert.throws(() => loadConfig(), /COOKIE_SECURE must be a boolean/);
  } finally {
    if (previous === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = previous;
  }
});

test('Google OAuth is optional but validates complete configuration and secure callback URLs', () => {
  const withoutGoogle = loadConfig({ nodeEnv: 'test', port: 3200 });
  assert.equal(withoutGoogle.googleClientId, null);
  assert.equal(withoutGoogle.googleCallbackUrl, null);
  assert.throws(() => loadConfig({ googleClientId: 'client-only' }), /must be configured together/);
  assert.throws(() => loadConfig({ nodeEnv: 'production', googleClientId: 'client', googleClientSecret: 'secret', googleCallbackUrl: 'http://health.example/auth/google/callback' }), /must use HTTPS/);
  const configured = loadConfig({ nodeEnv: 'test', port: 3200, googleClientId: 'client', googleClientSecret: 'secret' });
  assert.equal(configured.googleCallbackUrl, 'http://localhost:3200/auth/google/callback');
});

test('.env values are loaded before application configuration is read', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'health-centre-env-'));
  try {
    fs.writeFileSync(path.join(tempRoot, '.env'), [
      'GOOGLE_CLIENT_ID=local-client-id',
      'GOOGLE_CLIENT_SECRET=local-client-secret',
      'PORT=3407',
      'PUBLIC_BASE_URL=http://localhost:3407',
    ].join('\n'));
    const configModule = path.resolve(__dirname, '../src/config.js');
    const script = `const { loadConfig } = require(${JSON.stringify(configModule)}); const config = loadConfig({ nodeEnv: 'test' }); process.stdout.write(JSON.stringify({ port: config.port, googleClientId: config.googleClientId, googleCallbackUrl: config.googleCallbackUrl }));`;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: tempRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      port: 3407,
      googleClientId: 'local-client-id',
      googleCallbackUrl: 'http://localhost:3407/auth/google/callback',
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('demo seeding is unavailable in production and refuses weak passwords', () => {
  const { seedDemoData } = require('../src/seed');
  assert.throws(() => seedDemoData({ config: { nodeEnv: 'production', demoPassword: undefined } }), /disabled in production/);
  assert.throws(() => seedDemoData({ config: { nodeEnv: 'development', demoPassword: 'short' } }), /at least 12 characters/);
});
