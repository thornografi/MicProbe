-- Original measurements and legacy reviews remain intact. Accepted results are
-- frozen separately; listing never needs to transfer the full measurement JSON.
ALTER TABLE account_reports ADD COLUMN evaluation_json TEXT;
ALTER TABLE account_reports ADD COLUMN summary_json TEXT;
CREATE TABLE account_report_deletions (
    user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, run_id)
);
