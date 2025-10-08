-- ============================================================================
-- MIGRACIÓN: Agregar tabla sync_status para tracking de sincronizaciones
-- ============================================================================

BEGIN;

-- Tabla de estado de sincronización por sucursal
CREATE TABLE IF NOT EXISTS sync_status (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  sync_type VARCHAR(50) NOT NULL, -- sales, expenses, inventory, purchases, etc
  last_sync_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  records_synced INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'success', -- success, error, partial
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, branch_id, sync_type)
);

CREATE INDEX idx_sync_status_tenant_branch ON sync_status(tenant_id, branch_id);
CREATE INDEX idx_sync_status_last_sync ON sync_status(last_sync_at);

-- Trigger para updated_at
CREATE TRIGGER update_sync_status_updated_at BEFORE UPDATE ON sync_status
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Agregar columna a subscriptions para límite de días de consulta
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS query_days_limit INTEGER DEFAULT 30;

-- Actualizar límites por plan
UPDATE subscriptions SET query_days_limit = 30 WHERE name = 'Free';
UPDATE subscriptions SET query_days_limit = 90 WHERE name = 'Basic';
UPDATE subscriptions SET query_days_limit = 365 WHERE name = 'Pro';
UPDATE subscriptions SET query_days_limit = -1 WHERE name = 'Enterprise'; -- -1 = ilimitado

COMMIT;

-- Verificación
SELECT name, query_days_limit FROM subscriptions ORDER BY id;
