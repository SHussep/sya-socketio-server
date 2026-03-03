-- Migration 028: GPS Tracking for Repartidores
-- Real-time location tracking with LFPDPPP-compliant consent logging.
-- Repartidor locations stored with shift context; retained 90 days.

-- ═══════════════════════════════════════════════════════════════
-- TABLE: repartidor_locations — Historial de ubicaciones GPS
-- ~5,760 rows/day/repartidor at 15s intervals
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS repartidor_locations (
    id BIGSERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    shift_id INTEGER,

    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    accuracy DOUBLE PRECISION,
    speed DOUBLE PRECISION,
    heading DOUBLE PRECISION,

    recorded_at TIMESTAMPTZ NOT NULL,   -- timestamp from device
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- timestamp from server

    CONSTRAINT chk_latitude CHECK (latitude BETWEEN -90 AND 90),
    CONSTRAINT chk_longitude CHECK (longitude BETWEEN -180 AND 180)
);

-- Fast lookup: latest location per employee in a branch
CREATE INDEX IF NOT EXISTS idx_repartidor_locations_branch_employee
    ON repartidor_locations (branch_id, employee_id, received_at DESC);

-- Fast lookup: history for a specific employee
CREATE INDEX IF NOT EXISTS idx_repartidor_locations_employee_date
    ON repartidor_locations (employee_id, recorded_at DESC);

-- Retention cleanup: delete records older than 90 days
CREATE INDEX IF NOT EXISTS idx_repartidor_locations_retention
    ON repartidor_locations (received_at);

-- Tenant isolation
CREATE INDEX IF NOT EXISTS idx_repartidor_locations_tenant
    ON repartidor_locations (tenant_id);

-- ═══════════════════════════════════════════════════════════════
-- TABLE: gps_consent_log — Registro de consentimiento (LFPDPPP)
-- One active record per employee per tenant
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gps_consent_log (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    consented BOOLEAN NOT NULL DEFAULT false,
    consented_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    device_info TEXT,           -- e.g. "Android 14, Samsung Galaxy A54"
    ip_address INET,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One consent record per employee per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_gps_consent_tenant_employee
    ON gps_consent_log (tenant_id, employee_id);
