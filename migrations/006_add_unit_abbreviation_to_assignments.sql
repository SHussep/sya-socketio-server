-- Migration 006: Add unit_abbreviation to repartidor_assignments
-- Purpose: Store the unit of measure abbreviation for product assignments
-- This allows the mobile app to display the correct unit (kg, pz, L, etc.)

-- Add the unit_abbreviation column
ALTER TABLE repartidor_assignments
ADD COLUMN IF NOT EXISTS unit_abbreviation VARCHAR(10) DEFAULT 'kg';

-- Comment
COMMENT ON COLUMN repartidor_assignments.unit_abbreviation IS 'Abbreviation of product unit (kg, pz, L, etc.) - captured from product at assignment time';

-- Backfill existing records with default 'kg' (most common case)
UPDATE repartidor_assignments
SET unit_abbreviation = 'kg'
WHERE unit_abbreviation IS NULL;
