ALTER TABLE accounts ADD COLUMN email_authoritative INTEGER NOT NULL DEFAULT 0 CHECK(email_authoritative IN (0, 1));
ALTER TABLE accounts ADD COLUMN google_verified_at INTEGER;
ALTER TABLE account_checkouts ADD COLUMN recovery_email TEXT;
ALTER TABLE account_checkouts ADD COLUMN recovery_verified_at INTEGER;
CREATE INDEX account_checkouts_recovery_email ON account_checkouts(mode, recovery_email, created_at);
