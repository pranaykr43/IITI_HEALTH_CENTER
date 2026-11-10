const crypto = require('node:crypto');
const { AuthenticationError } = require('../errors');

const STATE_TTL_MS = 10 * 60 * 1000;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createGoogleOAuthService({ db, config, oauthClientFactory }) {
  const enabled = Boolean(config.googleClientId && config.googleClientSecret);
  let client = null;
  if (enabled) {
    if (oauthClientFactory) client = oauthClientFactory(config);
    else {
      const { OAuth2Client } = require('google-auth-library');
      client = new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleCallbackUrl);
    }
  }

  function createAuthorizationRequest(browserToken) {
    if (!enabled) throw new AuthenticationError('Google sign-in is not configured');
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const created = new Date();
    db.prepare(`
      INSERT INTO google_oauth_transactions (state_hash, nonce, browser_hash, code_verifier, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      digest(state), nonce, digest(browserToken), codeVerifier,
      new Date(created.getTime() + STATE_TTL_MS).toISOString(), created.toISOString(),
    );
    const url = client.generateAuthUrl({
      access_type: 'online',
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return { url, state };
  }

  const consumeTransaction = db.transaction((state, browserToken) => {
    const now = new Date().toISOString();
    db.prepare('DELETE FROM google_oauth_transactions WHERE expires_at <= ?').run(now);
    const row = db.prepare(`
      SELECT * FROM google_oauth_transactions WHERE state_hash = ? AND used_at IS NULL AND expires_at > ?
    `).get(digest(state), now);
    if (!row || !constantTimeEqual(row.browser_hash, digest(browserToken)) || !row.code_verifier) {
      throw new AuthenticationError('Google sign-in request expired or could not be verified');
    }
    const updated = db.prepare(`
      UPDATE google_oauth_transactions SET used_at = ?, code_verifier = NULL
      WHERE state_hash = ? AND used_at IS NULL AND code_verifier = ?
    `).run(now, digest(state), row.code_verifier);
    if (updated.changes !== 1) throw new AuthenticationError('Google sign-in request has already been used');
    return { nonce: row.nonce, codeVerifier: row.code_verifier };
  }).immediate;

  async function authenticateCallback({ state, browserToken, code }) {
    if (!enabled) throw new AuthenticationError('Google sign-in is not configured');
    if (typeof state !== 'string' || state.length < 32 || state.length > 200 || typeof code !== 'string' || code.length > 4096) {
      throw new AuthenticationError('Google sign-in response could not be verified');
    }
    const transaction = consumeTransaction(state, browserToken);
    const tokenResponse = await client.getToken({ code, codeVerifier: transaction.codeVerifier });
    const idToken = tokenResponse.tokens?.id_token;
    if (!idToken) throw new AuthenticationError('Google did not return a valid identity token');
    const ticket = await client.verifyIdToken({ idToken, audience: config.googleClientId });
    const payload = ticket.getPayload();
    const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
    const nowSeconds = Math.floor(Date.now() / 1000);
    const validIssuer = ['accounts.google.com', 'https://accounts.google.com'].includes(payload?.iss);
    if (!validIssuer || !audiences.includes(config.googleClientId) || (payload?.azp && payload.azp !== config.googleClientId)
      || (audiences.length > 1 && payload?.azp !== config.googleClientId)
      || !Number.isFinite(payload?.exp) || payload.exp <= nowSeconds
      || !payload?.sub || !payload?.email || payload.email_verified !== true
      || !constantTimeEqual(payload.nonce, transaction.nonce)) {
      throw new AuthenticationError('Google sign-in could not verify this patient account');
    }
    return { email: payload.email, name: payload.name || '', subject: payload.sub };
  }

  return { enabled, createAuthorizationRequest, authenticateCallback };
}

module.exports = { createGoogleOAuthService, digest, constantTimeEqual, STATE_TTL_MS };
