-- FCM device tokens for SuperAdmin (SYAAdmin app)
-- No employee/tenant association: SuperAdmin is global.

CREATE TABLE IF NOT EXISTS superadmin_devices (
    id           SERIAL PRIMARY KEY,
    device_token TEXT UNIQUE NOT NULL,
    platform     VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android')),
    device_id    TEXT,
    device_name  TEXT,
    is_active    BOOLEAN     DEFAULT TRUE,
    last_used_at TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    created_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_superadmin_devices_active
    ON superadmin_devices (is_active) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_superadmin_devices_device_id
    ON superadmin_devices (device_id) WHERE device_id IS NOT NULL;
