-- Add map_icon column to employees for GPS map marker customization
-- Stores Material Icons name string (e.g. 'two_wheeler', 'directions_car')
ALTER TABLE employees ADD COLUMN IF NOT EXISTS map_icon VARCHAR(30) DEFAULT 'two_wheeler';
