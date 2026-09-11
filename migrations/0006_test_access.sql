-- Audio and reports are never stored in this quota ledger. Days use UTC.
CREATE TABLE test_visitors (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX test_visitors_expiry ON test_visitors(expires_at);
CREATE TABLE test_access_days (day INTEGER PRIMARY KEY, salt TEXT NOT NULL);
CREATE TABLE test_visitor_rates (
  hour INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY(hour, ip_hash)
);
CREATE TABLE test_runs (
  run_id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  user_id TEXT,
  day INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved', 'completed', 'released')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX test_runs_account_day ON test_runs(user_id, day, state);
CREATE INDEX test_runs_visitor_day ON test_runs(visitor_id, day, state);
CREATE INDEX test_runs_day ON test_runs(day);
