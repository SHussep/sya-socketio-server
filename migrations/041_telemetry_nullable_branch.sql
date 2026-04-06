-- Migration 041: Make branch_id nullable in telemetry_events
-- After Apple re-auth, app_open fires before branch is selected, causing NOT NULL violation

ALTER TABLE telemetry_events ALTER COLUMN branch_id DROP NOT NULL;
