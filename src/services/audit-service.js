// Read-only access to the audit trail for administrators. Rows are written inside the
// same transactions as the changes they describe; this service never modifies them.
const CATEGORIES = Object.freeze({
  account: 'Accounts',
  admin: 'Administrator setup',
  appointment: 'Appointments',
  mfa: 'Two-factor authentication',
  notification: 'Notifications',
  password: 'Password resets',
  patient: 'Patient sign-up and sign-in',
});

const DESCRIPTIONS = Object.freeze({
  'account.created': 'Created an account',
  'account.disabled': 'Disabled an account',
  'account.active': 'Reactivated an account',
  'admin.bootstrap': 'Created the first administrator',
  'appointment.requested': 'Requested an appointment',
  'appointment.confirmed': 'Scheduled an appointment',
  'appointment.completed': 'Completed a visit',
  'appointment.cancelled': 'Cancelled an appointment',
  'appointment.rejected': 'Declined an appointment',
  'mfa.enabled': 'Turned on two-factor authentication',
  'mfa.disabled': 'Turned off two-factor authentication',
  'mfa.reset': 'Reset two-factor authentication',
  'mfa.recovery_code_used': 'Signed in with a recovery code',
  'mfa.recovery_codes_regenerated': 'Created new recovery codes',
  'mfa.challenge_locked': 'Locked a sign-in after wrong codes',
  'notification.redriven': 'Re-queued a failed notification',
  'password.reset': 'Reset a password',
  'patient.registered': 'Registered as a patient',
  'patient.google_authenticated': 'Signed in with Google',
});

// Only these metadata keys are shown; anything else stays in the database.
const VISIBLE_METADATA = new Set(['role', 'previousStatus', 'reason', 'scheduledFor', 'doctorId', 'remaining', 'redriveCount', 'hadMfa', 'method']);

function createAuditService(db) {
  function list({ category = '', beforeId = null, limit = 50 } = {}) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const clauses = [];
    const params = [];
    if (category && Object.hasOwn(CATEGORIES, category)) {
      clauses.push('audit_log.action LIKE ?');
      params.push(`${category}.%`);
    }
    if (Number.isInteger(beforeId) && beforeId > 0) {
      clauses.push('audit_log.id < ?');
      params.push(beforeId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT audit_log.id, audit_log.action, audit_log.aggregate_type AS aggregateType, audit_log.aggregate_id AS aggregateId,
             audit_log.metadata_json AS metadataJson, audit_log.created_at AS createdAt,
             actor.name AS actorName, actor.role AS actorRole
      FROM audit_log LEFT JOIN users AS actor ON actor.id = audit_log.actor_user_id
      ${where}
      ORDER BY audit_log.id DESC LIMIT ?
    `).all(...params, boundedLimit + 1);
    const hasMore = rows.length > boundedLimit;
    const entries = rows.slice(0, boundedLimit).map((row) => {
      let metadata = {};
      try { metadata = JSON.parse(row.metadataJson) || {}; } catch { metadata = {}; }
      const details = Object.entries(metadata)
        .filter(([key, value]) => VISIBLE_METADATA.has(key) && value !== null && value !== undefined && typeof value !== 'object')
        .map(([key, value]) => ({ key, value: String(value).slice(0, 200) }));
      return {
        id: row.id,
        action: row.action,
        description: DESCRIPTIONS[row.action] || row.action,
        target: `${row.aggregateType} ${row.aggregateType === 'appointment' ? String(row.aggregateId).slice(0, 8) : row.aggregateId}`,
        actor: row.actorName ? `${row.actorName} (${row.actorRole})` : 'System or signed-out user',
        createdAt: row.createdAt,
        details,
      };
    });
    return { entries, nextBeforeId: hasMore ? entries[entries.length - 1].id : null };
  }

  return { list, categories: CATEGORIES };
}

module.exports = { createAuditService, AUDIT_CATEGORIES: CATEGORIES };
