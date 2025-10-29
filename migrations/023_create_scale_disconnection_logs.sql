-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION 023: Create scale_disconnection_logs table
-- Purpose: Track scale disconnection events for monitoring and alerts
-- Date: 2025-10-29
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE SCALE_DISCONNECTION_LOGS TABLE
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS scale_disconnection_logs (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,

  -- Event details
  event_type VARCHAR(50) NOT NULL DEFAULT 'DISCONNECTION',
  event_description TEXT,
  severity VARCHAR(20) DEFAULT 'HIGH',

  -- Scale info
  scale_name VARCHAR(100),
  scale_ip VARCHAR(15),
  scale_model VARCHAR(100),

  -- Timestamps
  disconnection_time TIMESTAMP WITH TIME ZONE NOT NULL,
  reconnection_time TIMESTAMP WITH TIME ZONE,
  duration_seconds INTEGER,

  -- Sync status
  is_synced BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMP WITH TIME ZONE,

  -- Metadata
  error_message TEXT,
  resolution_status VARCHAR(20) DEFAULT 'PENDING', -- PENDING, RESOLVED, ESCALATED

  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- CREATE INDICES FOR PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX idx_scale_disconnection_tenant ON scale_disconnection_logs(tenant_id);
CREATE INDEX idx_scale_disconnection_branch ON scale_disconnection_logs(branch_id);
CREATE INDEX idx_scale_disconnection_shift ON scale_disconnection_logs(shift_id);
CREATE INDEX idx_scale_disconnection_employee ON scale_disconnection_logs(employee_id);
CREATE INDEX idx_scale_disconnection_time ON scale_disconnection_logs(disconnection_time DESC);
CREATE INDEX idx_scale_disconnection_sync ON scale_disconnection_logs(is_synced);
CREATE INDEX idx_scale_disconnection_status ON scale_disconnection_logs(resolution_status);

-- ═══════════════════════════════════════════════════════════════════════════
-- ADD COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════
COMMENT ON TABLE scale_disconnection_logs IS 'Track scale disconnection events for monitoring and real-time alerts';
COMMENT ON COLUMN scale_disconnection_logs.shift_id IS 'Reference to the shift during which disconnection occurred';
COMMENT ON COLUMN scale_disconnection_logs.is_synced IS 'Whether this event has been synced to mobile app';
COMMENT ON COLUMN scale_disconnection_logs.duration_seconds IS 'Duration of disconnection in seconds (calculated if reconnected)';

COMMIT;
