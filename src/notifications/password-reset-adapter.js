const crypto = require('node:crypto');

function createUnconfiguredPasswordResetAdapter({ logger } = {}) {
  return {
    configured: false,
    async deliver() {
      logger?.info?.({ component: 'password-reset' }, 'password reset delivery is not configured');
    },
  };
}

function createResendPasswordResetAdapter({ apiKey, from, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxAttempts = 3 } = {}) {
  if (!apiKey || !from || typeof fetchImpl !== 'function') throw new TypeError('Resend adapter requires API key, sender, and fetch');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new TypeError('Resend maxAttempts must be an integer from 1 to 3');
  return {
    configured: true,
    async deliver({ email, resetUrl }) {
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const idempotencyKey = `password-reset/${crypto.createHash('sha256').update(resetUrl).digest('hex')}`;
          const response = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify({ from, to: [email], subject: 'Reset your Health Centre demo password', text: `Use this link to reset your password: ${resetUrl}\n\nIf you did not request this, ignore this email.`, html: `<p>Use this link to reset your password:</p><p><a href="${resetUrl}">Reset password</a></p><p>If you did not request this, ignore this email.</p>` }),
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) return;
          lastError = new Error(`Resend returned HTTP ${response.status}`);
          if (response.status < 500 && response.status !== 429 && response.status !== 408) break;
        } catch (error) {
          lastError = error;
        }
        if (attempt < maxAttempts) await sleep(Math.min(250 * (2 ** (attempt - 1)), 2_000));
      }
      throw lastError || new Error('Resend delivery failed');
    },
  };
}

module.exports = { createUnconfiguredPasswordResetAdapter, createResendPasswordResetAdapter };
