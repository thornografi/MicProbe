-- Keep every purchase's owner, including revoked purchases. A later purchase
-- can grant access to the same account without transferring the earlier one.
CREATE TABLE account_licenses_history (
    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('sandbox', 'production')),
    license_id TEXT NOT NULL,
    freemius_user_id TEXT,
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
    verified_at INTEGER NOT NULL,
    PRIMARY KEY(mode, license_id)
);
INSERT INTO account_licenses_history SELECT * FROM account_licenses;
DROP TABLE account_licenses;
ALTER TABLE account_licenses_history RENAME TO account_licenses;
CREATE INDEX account_licenses_owner ON account_licenses(user_id, mode, active DESC, verified_at DESC);
