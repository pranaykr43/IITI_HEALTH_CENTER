const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('configuration rejects unsafe port and session values', () => {
  assert.throws(() => loadConfig({ port: 0 }), /PORT/);
  assert.throws(() => loadConfig({ sessionTtlSeconds: 30 }), /SESSION_TTL_SECONDS/);
});

test('production defaults cookies to secure unless explicitly overridden', () => {
  const config = loadConfig({ nodeEnv: 'production' });
  assert.equal(config.cookieSecure, true);
});
