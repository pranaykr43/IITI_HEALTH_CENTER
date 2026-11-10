const test = require('node:test');
const assert = require('node:assert/strict');
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

test('demo seeding is unavailable in production and refuses weak passwords', () => {
  const { seedDemoData } = require('../src/seed');
  assert.throws(() => seedDemoData({ config: { nodeEnv: 'production', demoPassword: undefined } }), /disabled in production/);
  assert.throws(() => seedDemoData({ config: { nodeEnv: 'development', demoPassword: 'short' } }), /at least 12 characters/);
});
