-- Practice Mode: Add is_practice flag to notifications table
-- Allows marking notifications generated during practice/training sessions
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_practice BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_practice ON notifications(is_practice) WHERE is_practice = true;
