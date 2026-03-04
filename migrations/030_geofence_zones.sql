-- Migration 030: Geofence Zones for Delivery Area Monitoring
-- Circular zones (center + radius) per branch. Detects enter/exit of repartidores.

CREATE TABLE IF NOT EXISTS geofence_zones (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

    name VARCHAR(100) NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    radius_meters DOUBLE PRECISION NOT NULL DEFAULT 500,

    color VARCHAR(7) DEFAULT '#4285F4',
    is_active BOOLEAN NOT NULL DEFAULT true,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_zone_latitude CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT chk_zone_longitude CHECK (longitude BETWEEN -180 AND 180),
    CONSTRAINT chk_zone_radius CHECK (radius_meters BETWEEN 50 AND 50000)
);

CREATE INDEX IF NOT EXISTS idx_geofence_zones_branch
    ON geofence_zones (branch_id, is_active);

CREATE INDEX IF NOT EXISTS idx_geofence_zones_tenant
    ON geofence_zones (tenant_id);

-- Log of enter/exit events
CREATE TABLE IF NOT EXISTS geofence_events (
    id BIGSERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    zone_id INTEGER NOT NULL REFERENCES geofence_zones(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

    event_type VARCHAR(10) NOT NULL CHECK (event_type IN ('enter', 'exit')),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    distance_meters DOUBLE PRECISION,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geofence_events_zone
    ON geofence_events (zone_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_geofence_events_employee
    ON geofence_events (employee_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_geofence_events_retention
    ON geofence_events (created_at);
