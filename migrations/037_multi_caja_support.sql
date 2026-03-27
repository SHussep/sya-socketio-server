-- Migration: 037_multi_caja_support.sql
-- Multi-caja shift mutual exclusion support
--
-- Adds per-branch multi_caja toggle and shift heartbeat tracking.
-- When multi_caja_enabled = true on a branch:
--   - Shifts can only be opened with server confirmation (no offline opening)
--   - PostgreSQL is the single source of truth for shift state
--   - Force-takeover uses last_heartbeat to determine device liveness
--
-- Default false: zero behavior change until admin explicitly enables per branch.

-- 1. Branch setting: enables strict server-first shift management
ALTER TABLE branches ADD COLUMN IF NOT EXISTS multi_caja_enabled BOOLEAN DEFAULT false;

-- 2. Shift heartbeat: tracks device liveness for force-takeover decisions
-- Nullable: null means "never sent heartbeat" (treated as offline for takeover purposes)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ;

-- 3. Partial index for fast active-shift lookups (heartbeat + conflict checks)
-- Only indexes open shifts — keeps the index small and fast
CREATE INDEX IF NOT EXISTS idx_shifts_active_heartbeat
  ON shifts(employee_id, is_cash_cut_open)
  WHERE is_cash_cut_open = true;
