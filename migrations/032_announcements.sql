-- Migration 032: Announcements table
-- Supports scheduled announcements with tier targeting and timezone

CREATE TABLE IF NOT EXISTS announcements (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    html_content TEXT,
    content_url VARCHAR(500),
    type VARCHAR(30) NOT NULL DEFAULT 'info',
    target_tiers TEXT[] DEFAULT '{}',
    scheduled_at TIMESTAMPTZ,
    timezone VARCHAR(50) DEFAULT 'America/Mexico_City',
    status VARCHAR(20) NOT NULL DEFAULT 'sent',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ
);

-- Index for pending scheduled announcements
CREATE INDEX IF NOT EXISTS idx_announcements_pending
ON announcements(status, scheduled_at)
WHERE status = 'pending';
