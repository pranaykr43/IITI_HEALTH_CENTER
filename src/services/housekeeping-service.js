const DAY_MS = 24 * 60 * 60 * 1000;

// Removes credentials and operational rows that have outlived their purpose. Expired
// sessions, reset tokens and OAuth transactions are otherwise only deleted when they are
// presented again, and delivered outbox rows and idempotency replays would accumulate
// indefinitely. Audit history is intentionally retained.
function createHousekeepingService(db, {
  now = () => Date.now(),
  idempotencyRetentionMs = 7 * DAY_MS,
  deliveredEventRetentionMs = 30 * DAY_MS,
  consumedTokenRetentionMs = DAY_MS,
} = {}) {
  for (const [name, value] of Object.entries({ idempotencyRetentionMs, deliveredEventRetentionMs, consumedTokenRetentionMs })) {
    if (!Number.isInteger(value) || value < 60_000) throw new TypeError(`${name} must be an integer of at least one minute`);
  }

  const purge = db.transaction((nowMs) => {
    const nowIso = new Date(nowMs).toISOString();
    const tokenCutoff = new Date(nowMs - consumedTokenRetentionMs).toISOString();
    return {
      sessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso).changes,
      passwordResetTokens: db.prepare(`
        DELETE FROM password_reset_tokens
        WHERE (used_at IS NOT NULL AND used_at <= ?) OR expires_at <= ?
      `).run(tokenCutoff, tokenCutoff).changes,
      oauthTransactions: db.prepare('DELETE FROM google_oauth_transactions WHERE expires_at <= ?').run(nowIso).changes,
      idempotencyKeys: db.prepare('DELETE FROM idempotency_keys WHERE created_at <= ?')
        .run(new Date(nowMs - idempotencyRetentionMs).toISOString()).changes,
      deliveredEvents: db.prepare("DELETE FROM outbox_events WHERE status = 'delivered' AND delivered_at <= ?")
        .run(new Date(nowMs - deliveredEventRetentionMs).toISOString()).changes,
    };
  }).immediate;

  return { run: () => purge(now()) };
}

module.exports = { createHousekeepingService, DAY_MS };
