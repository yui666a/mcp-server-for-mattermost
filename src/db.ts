import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  authorized_at INTEGER
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id TEXT PRIMARY KEY,
  cookie_hash TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  upstream_state_hash TEXT UNIQUE,
  upstream_verifier TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
  code_hash TEXT PRIMARY KEY,
  mm_user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mm_user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  from_code_hash TEXT NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS grants_user ON grants (mm_user_id);
CREATE INDEX IF NOT EXISTS grants_code ON grants (from_code_hash);
CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  used INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS mm_creds (
  mm_user_id TEXT PRIMARY KEY,
  access_sealed TEXT NOT NULL,
  refresh_sealed TEXT NOT NULL,
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS post_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mm_user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  pending_post_id TEXT NOT NULL,
  post_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (mm_user_id, channel_id, root_id, body_hash)
);
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY,
  mm_user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  message_sealed TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'posted', 'failed')),
  pending_post_id TEXT,
  first_attempt_at INTEGER,
  post_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_posts_user ON scheduled_posts (mm_user_id, scheduled_at, id);
CREATE INDEX IF NOT EXISTS scheduled_posts_due ON scheduled_posts (status, scheduled_at, id);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  return db;
}
