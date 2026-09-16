PRAGMA foreign_keys = ON;
CREATE TABLE devices (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('pc','mobile')),
  public_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
);
CREATE TABLE spaces (
  id TEXT PRIMARY KEY, pc_id TEXT NOT NULL UNIQUE REFERENCES devices(id), status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE enrollment_codes (
  code_hmac TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed_by TEXT, registration_id TEXT
);
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), challenge_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX challenge_expiry ON auth_challenges(expires_at);
CREATE TABLE device_sessions (
  token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), expires_at INTEGER NOT NULL
);
CREATE INDEX session_device ON device_sessions(device_id,expires_at);
CREATE TABLE pairings (
  id TEXT PRIMARY KEY, pc_id TEXT NOT NULL REFERENCES devices(id), code_hmac TEXT UNIQUE NOT NULL,
  offer_jws TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  claim_json TEXT, mobile_id TEXT, grant_jws TEXT, binding_id TEXT
);
CREATE INDEX pairing_pc ON pairings(pc_id,state);
CREATE INDEX pairing_expiry ON pairings(expires_at);
CREATE TABLE bindings (
  id TEXT PRIMARY KEY, pc_id TEXT NOT NULL REFERENCES devices(id), mobile_id TEXT NOT NULL REFERENCES devices(id),
  scopes_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), grant_jws TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', pc_ack INTEGER NOT NULL DEFAULT 1, UNIQUE(pc_id,mobile_id)
);
CREATE INDEX binding_mobile ON bindings(mobile_id,state);
CREATE TABLE push_tokens (
  device_id TEXT PRIMARY KEY REFERENCES devices(id), ciphertext TEXT NOT NULL, revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE notification_preferences (
  mobile_id TEXT NOT NULL REFERENCES devices(id), pc_id TEXT NOT NULL REFERENCES devices(id),
  value_json TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(mobile_id,pc_id)
);
CREATE TABLE rate_limits (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL);
CREATE INDEX rate_expiry ON rate_limits(expires_at);
CREATE TABLE security_audit (id TEXT PRIMARY KEY, code TEXT NOT NULL, device_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX audit_expiry ON security_audit(created_at);
