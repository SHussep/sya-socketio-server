-- Migration 044: Track which login screen the user came from in telemetry_events.
-- Valid values (enforced at the API layer, not the DB):
--   'classic' = pantalla de login clásica
--   'bubble'  = pantalla de login bubble (la nueva)
--   'pin'     = login con PIN (flujo bubble)
-- Nullable so legacy events stay valid.

ALTER TABLE telemetry_events
    ADD COLUMN IF NOT EXISTS login_mode VARCHAR(20);

-- Filter index for the reporting endpoint that aggregates by mode.
CREATE INDEX IF NOT EXISTS idx_telemetry_login_mode
    ON telemetry_events (tenant_id, event_type, login_mode)
    WHERE login_mode IS NOT NULL;
