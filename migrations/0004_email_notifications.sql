-- The business write and notification intent commit together. Sending happens
-- after the response; a provider outage cannot undo a login or license grant.
CREATE TABLE email_outbox (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('welcome', 'premium')),
    mode TEXT NOT NULL,
    license_id TEXT,
    recipient TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    first_attempt_at INTEGER,
    lease_until INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    payload_json TEXT,
    provider_id TEXT UNIQUE,
    last_error TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX email_outbox_due ON email_outbox(state, next_attempt_at, lease_until);

CREATE TABLE email_delivery (
    provider_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    priority INTEGER NOT NULL
);
CREATE TABLE email_suppressions (
    recipient TEXT PRIMARY KEY COLLATE NOCASE,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TRIGGER account_welcome_email AFTER INSERT ON accounts BEGIN
    INSERT OR IGNORE INTO email_outbox (id, user_id, kind, mode, recipient, created_at)
    VALUES ('welcome:' || NEW.id, NEW.id, 'welcome', 'account', lower(NEW.email), NEW.created_at);
END;

CREATE TRIGGER license_insert_email AFTER INSERT ON account_licenses WHEN NEW.active = 1 BEGIN
    INSERT OR IGNORE INTO email_outbox (id, user_id, kind, mode, license_id, recipient, created_at)
    SELECT 'premium:' || NEW.mode || ':' || NEW.license_id, NEW.user_id, 'premium', NEW.mode,
        NEW.license_id, lower(email), NEW.verified_at FROM accounts WHERE id = NEW.user_id;
END;

CREATE TRIGGER license_verified_email AFTER UPDATE ON account_licenses
WHEN NEW.active = 1 AND OLD.active = 0 BEGIN
    INSERT OR IGNORE INTO email_outbox (id, user_id, kind, mode, license_id, recipient, created_at)
    SELECT 'premium:' || NEW.mode || ':' || NEW.license_id, NEW.user_id, 'premium', NEW.mode,
        NEW.license_id, lower(email), NEW.verified_at FROM accounts WHERE id = NEW.user_id;
END;
