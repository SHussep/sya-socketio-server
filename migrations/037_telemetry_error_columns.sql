-- Migration 037: Add error columns to telemetry_events for socket_error events
-- These columns are already referenced in routes/telemetry.js POST endpoint

ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS error_reason VARCHAR(255);
ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS error_details TEXT;
ALTER TABLE telemetry_events ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER;

-- Index for querying errors by tenant
CREATE INDEX IF NOT EXISTS idx_telemetry_errors_tenant
    ON telemetry_events(tenant_id, event_timestamp DESC)
    WHERE event_type = 'socket_error';
