const test = require('node:test');
const assert = require('node:assert/strict');
const { createResendPasswordResetAdapter } = require('../src/notifications/password-reset-adapter');

test('Resend adapter retries transient responses without logging or returning the reset token', async () => {
  const calls = [];
  const delays = [];
  const adapter = createResendPasswordResetAdapter({
    apiKey: 'synthetic-key', from: 'demo@example.test', sleep: async (ms) => delays.push(ms),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: calls.length === 2, status: calls.length === 1 ? 503 : 200 };
    },
  });
  await adapter.deliver({ email: 'patient@example.test', resetUrl: 'https://demo.example.test/password/reset?token=synthetic-reset-token' });
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [250]);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-key');
  assert.match(calls[0].options.headers['Idempotency-Key'], /^password-reset\/[a-f0-9]{64}$/);
  assert.equal(calls[0].options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
  assert.doesNotMatch(calls[0].options.headers['Idempotency-Key'], /synthetic-reset-token/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.to[0], 'patient@example.test');
  assert.match(body.text, /synthetic-reset-token/);
  assert.doesNotMatch(body.subject + body.text, /symptom|appointment|medical/i);
});

test('Resend adapter does not retry permanent client errors', async () => {
  let calls = 0;
  const adapter = createResendPasswordResetAdapter({
    apiKey: 'synthetic-key', from: 'demo@example.test', sleep: async () => assert.fail('must not retry'),
    fetchImpl: async () => { calls += 1; return { ok: false, status: 400 }; },
  });
  await assert.rejects(adapter.deliver({ email: 'patient@example.test', resetUrl: 'https://demo.example.test/reset?token=x' }), /HTTP 400/);
  assert.equal(calls, 1);
});
