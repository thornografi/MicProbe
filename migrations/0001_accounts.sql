PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);

CREATE TABLE IF NOT EXISTS account_login_challenges (
    nonce_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_login_challenges_expiry ON account_login_challenges(expires_at);

CREATE TABLE IF NOT EXISTS account_licenses (
    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('sandbox', 'production')),
    license_id TEXT NOT NULL,
    freemius_user_id TEXT,
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
    verified_at INTEGER NOT NULL,
    PRIMARY KEY(mode, license_id),
    UNIQUE(user_id, mode)
);

CREATE TABLE IF NOT EXISTS account_checkouts (
    state_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('sandbox', 'production')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    completed_license_id TEXT
);
CREATE INDEX IF NOT EXISTS account_checkouts_expiry ON account_checkouts(expires_at);

CREATE TABLE IF NOT EXISTS account_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    report_json TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, run_id)
);
CREATE INDEX IF NOT EXISTS account_reports_owner_date ON account_reports(user_id, created_at DESC, id DESC);
