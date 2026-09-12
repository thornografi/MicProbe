-- Preserve the last definitive verification result. Empty means not recorded,
-- not a cancellation. Provider outages do not replace the last known result.
ALTER TABLE account_licenses ADD COLUMN inactive_reason TEXT NOT NULL DEFAULT '';
