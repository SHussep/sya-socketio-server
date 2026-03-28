-- migrations/038_terminal_naming.sql
-- ═══════════════════════════════════════════════════════════════
-- MIGRATION: Terminal naming support
-- Adds is_active soft-delete and unique name constraint to branch_devices
-- ═══════════════════════════════════════════════════════════════

-- Soft delete column
ALTER TABLE branch_devices
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Unique device name per branch among active devices (allows NULL device_name)
CREATE UNIQUE INDEX IF NOT EXISTS uq_branch_devices_name_active
    ON branch_devices(branch_id, tenant_id, device_name)
    WHERE is_active = TRUE AND device_name IS NOT NULL;
