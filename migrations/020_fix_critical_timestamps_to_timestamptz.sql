-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 015: Fix critical real-time event timestamps
-- Convert guardian_events, shifts, and cash_cuts to TIMESTAMP WITH TIME ZONE
-- ═══════════════════════════════════════════════════════════════

-- 1. GUARDIAN_EVENTS - Real-time scale alert detection
ALTER TABLE guardian_events
  ALTER COLUMN event_date TYPE TIMESTAMP WITH TIME ZONE USING event_date AT TIME ZONE 'UTC';

-- 2. SHIFTS - Real-time shift start/end tracking
ALTER TABLE shifts
  ALTER COLUMN start_time TYPE TIMESTAMP WITH TIME ZONE USING start_time AT TIME ZONE 'UTC',
  ALTER COLUMN end_time TYPE TIMESTAMP WITH TIME ZONE USING end_time AT TIME ZONE 'UTC';

-- 3. CASH_CUTS - Cash drawer closing timestamps
ALTER TABLE cash_cuts
  ALTER COLUMN cut_date TYPE TIMESTAMP WITH TIME ZONE USING cut_date AT TIME ZONE 'UTC';

-- Add indexes for better performance on timezone-aware columns
CREATE INDEX IF NOT EXISTS idx_guardian_events_event_date ON guardian_events(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_start_time ON shifts(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_cash_cuts_cut_date ON cash_cuts(cut_date DESC);

-- Log migration completion
DO $$
BEGIN
  RAISE NOTICE 'Migration 015: Critical timestamps converted to TIMESTAMP WITH TIME ZONE';
  RAISE NOTICE '  - guardian_events.event_date and timestamp';
  RAISE NOTICE '  - shifts.start_time and end_time';
  RAISE NOTICE '  - cash_cuts.cut_date';
  RAISE NOTICE 'All timestamps are now stored in UTC with timezone awareness.';
END $$;
