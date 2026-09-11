ALTER TABLE test_runs ADD COLUMN review_checks INTEGER NOT NULL DEFAULT 0;

CREATE TABLE account_reviews (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('sandbox', 'production')),
    report_id TEXT NOT NULL REFERENCES account_reports(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1,
    state_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, mode, report_id)
);
CREATE INDEX account_reviews_owner ON account_reviews(user_id, mode);

CREATE TABLE account_review_requests (
    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    minute INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    PRIMARY KEY (user_id, minute)
);
CREATE INDEX account_review_requests_expiry ON account_review_requests(minute);
