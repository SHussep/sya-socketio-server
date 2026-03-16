-- Migration 036: Add operator justification fields to scale_disconnection_logs
-- For suspicious reconnection tracking - operator must justify why scale was disconnected

ALTER TABLE scale_disconnection_logs
ADD COLUMN IF NOT EXISTS operator_justification TEXT,
ADD COLUMN IF NOT EXISTS required_justification BOOLEAN DEFAULT FALSE;
