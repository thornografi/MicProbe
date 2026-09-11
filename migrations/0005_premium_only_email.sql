-- Support replies are written by the owner. Only verified Premium access
-- generates an automatic message; retain prior welcome records for audit.
DROP TRIGGER IF EXISTS account_welcome_email;

UPDATE email_outbox
SET state = 'cancelled', last_error = 'email_kind_disabled',
    lease_until = 0, lease_token = NULL, next_attempt_at = 0,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE kind = 'welcome' AND state IN ('pending', 'retry', 'sending', 'needs_review');
