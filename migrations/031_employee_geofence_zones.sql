-- Migration 031: Employee-Geofence Zone Assignments
-- Junction table to assign specific geofence zones to specific repartidores

CREATE TABLE IF NOT EXISTS employee_geofence_zones (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    zone_id INTEGER NOT NULL REFERENCES geofence_zones(id) ON DELETE CASCADE,
    assigned_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraint: one active assignment per employee-zone pair
CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_geofence_unique_active
    ON employee_geofence_zones (employee_id, zone_id) WHERE is_active = true;

-- Fast lookups by employee (for checkGeofences and mobile route tab)
CREATE INDEX IF NOT EXISTS idx_employee_geofence_employee
    ON employee_geofence_zones (employee_id, is_active);

-- Fast lookups by zone (for admin assignment management)
CREATE INDEX IF NOT EXISTS idx_employee_geofence_zone
    ON employee_geofence_zones (zone_id, is_active);

-- Tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_employee_geofence_tenant
    ON employee_geofence_zones (tenant_id);
