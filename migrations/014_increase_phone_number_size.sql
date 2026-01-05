-- Migration: 014_increase_phone_number_size
-- Description: Increase phone_number column size to accommodate formatted phone numbers
-- Date: 2026-01-06

-- Suppliers table: phone_number was VARCHAR(20), now VARCHAR(50)
ALTER TABLE suppliers ALTER COLUMN phone_number TYPE VARCHAR(50);

-- Employees table: phone_number was VARCHAR(50), now VARCHAR(100) for safety
ALTER TABLE employees ALTER COLUMN phone_number TYPE VARCHAR(100);

-- Tenants table: phone_number was VARCHAR(50), this is fine, but let's ensure consistency
-- Already VARCHAR(50), no change needed
