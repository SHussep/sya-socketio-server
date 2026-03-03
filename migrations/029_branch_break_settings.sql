-- Migration 029: Add max_breaks_per_shift setting to branches
-- Allows admins to configure how many breaks a repartidor can take per shift

ALTER TABLE branches ADD COLUMN IF NOT EXISTS max_breaks_per_shift INTEGER DEFAULT 3;
