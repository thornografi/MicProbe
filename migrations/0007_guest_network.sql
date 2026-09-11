ALTER TABLE test_runs ADD COLUMN guest_network_hash TEXT;
CREATE INDEX test_runs_guest_network ON test_runs(day, guest_network_hash, state, expires_at);
