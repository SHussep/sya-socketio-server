-- Migration 021: Add employee_id and platform to telemetry_events
-- Enables per-user app usage tracking (who opened the app, when, how many times)

ALTER TABLE telemetry_events
ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;

ALTER TABLE telemetry_events
ADD COLUMN IF NOT EXISTS platform VARCHAR(20);
-- Values: 'android', 'ios', 'windows', 'macos', 'linux'

-- Index for per-employee queries
CREATE INDEX IF NOT EXISTS idx_telemetry_employee_id
ON telemetry_events(employee_id);

-- Composite index for the main query pattern: employee + date range
CREATE INDEX IF NOT EXISTS idx_telemetry_employee_date
ON telemetry_events(employee_id, event_timestamp DESC)
WHERE event_type IN ('app_open', 'app_resume');

-- Composite index for tenant-scoped employee activity queries
CREATE INDEX IF NOT EXISTS idx_telemetry_tenant_employee
ON telemetry_events(tenant_id, employee_id, event_timestamp DESC)
WHERE event_type IN ('app_open', 'app_resume');
