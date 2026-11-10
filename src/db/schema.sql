PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('patient', 'doctor', 'admin')),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  qualification TEXT NOT NULL,
  specialization TEXT NOT NULL,
  available_days TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  doctor_id INTEGER REFERENCES doctors(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'confirmed', 'rejected', 'completed', 'cancelled')),
  requested_at TEXT NOT NULL,
  scheduled_for TEXT,
  patient_phone TEXT NOT NULL,
  patient_age INTEGER NOT NULL CHECK (patient_age BETWEEN 0 AND 130),
  symptoms TEXT NOT NULL,
  days_with_symptoms INTEGER NOT NULL CHECK (days_with_symptoms BETWEEN 0 AND 3650),
  prescription_test TEXT,
  prescription_medicine TEXT,
  prescription_advice TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);

CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor ON appointments(doctor_id, scheduled_for);
CREATE UNIQUE INDEX IF NOT EXISTS uq_confirmed_doctor_slot
  ON appointments(doctor_id, scheduled_for)
  WHERE doctor_id IS NOT NULL AND scheduled_for IS NOT NULL AND status IN ('confirmed', 'completed');

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_user_id, key)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  claim_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  failed_at TEXT,
  redrive_count INTEGER NOT NULL DEFAULT 0 CHECK (redrive_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_outbox_available ON outbox_events(status, available_at, id);

CREATE TABLE IF NOT EXISTS notification_worker_heartbeats (
  worker_name TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
