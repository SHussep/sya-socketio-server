-- =====================================================
-- Migration: 059_enable_row_level_security.sql
-- Descripción: Habilitar Row-Level Security (RLS) por tenant_id
-- =====================================================
-- SEGURIDAD CRÍTICA: Prevenir que un tenant vea/modifique datos de otro
-- RLS aplica filtros automáticos a nivel de PostgreSQL basados en el token JWT
--
-- Requisito: Los tokens JWT deben incluir claim 'tenant_id'
-- El servidor debe usar SET LOCAL app.current_tenant_id = :tenant_id antes de cada query
-- =====================================================

-- ========== HABILITAR RLS EN TABLAS PRINCIPALES ==========

-- Tablas maestras
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;

-- Tablas transaccionales
ALTER TABLE ventas ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventas_detalle ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;

-- Guardian
ALTER TABLE scale_disconnections ENABLE ROW LEVEL SECURITY;
ALTER TABLE suspicious_weighing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_employee_scores_daily ENABLE ROW LEVEL SECURITY;

-- Dispositivos y asignaciones
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE repartidor_assignments ENABLE ROW LEVEL SECURITY;

-- ========== CREAR FUNCIÓN HELPER PARA OBTENER TENANT ACTUAL ==========
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS INTEGER AS $$
BEGIN
  -- Obtener tenant_id del setting de sesión (configurado por el servidor)
  RETURN current_setting('app.current_tenant_id', TRUE)::INTEGER;
EXCEPTION
  WHEN OTHERS THEN
    -- Si no está configurado, retornar NULL (queries fallarán por seguridad)
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION current_tenant_id() IS 'Obtiene tenant_id de la sesión actual - usado por RLS policies';

-- ========== POLÍTICAS RLS: SOLO VER/MODIFICAR DATOS DEL PROPIO TENANT ==========

-- customers
DROP POLICY IF EXISTS customers_tenant_isolation ON customers;
CREATE POLICY customers_tenant_isolation ON customers
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- productos
DROP POLICY IF EXISTS productos_tenant_isolation ON productos;
CREATE POLICY productos_tenant_isolation ON productos
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- employees
DROP POLICY IF EXISTS employees_tenant_isolation ON employees;
CREATE POLICY employees_tenant_isolation ON employees
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- branches
DROP POLICY IF EXISTS branches_tenant_isolation ON branches;
CREATE POLICY branches_tenant_isolation ON branches
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ventas
DROP POLICY IF EXISTS ventas_tenant_isolation ON ventas;
CREATE POLICY ventas_tenant_isolation ON ventas
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ventas_detalle (JOIN con ventas para obtener tenant_id)
DROP POLICY IF EXISTS ventas_detalle_tenant_isolation ON ventas_detalle;
CREATE POLICY ventas_detalle_tenant_isolation ON ventas_detalle
  USING (
    EXISTS (
      SELECT 1 FROM ventas
      WHERE ventas.id_venta = ventas_detalle.id_venta
        AND ventas.tenant_id = current_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ventas
      WHERE ventas.id_venta = ventas_detalle.id_venta
        AND ventas.tenant_id = current_tenant_id()
    )
  );

-- shifts
DROP POLICY IF EXISTS shifts_tenant_isolation ON shifts;
CREATE POLICY shifts_tenant_isolation ON shifts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- expenses
DROP POLICY IF EXISTS expenses_tenant_isolation ON expenses;
CREATE POLICY expenses_tenant_isolation ON expenses
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- deposits
DROP POLICY IF EXISTS deposits_tenant_isolation ON deposits;
CREATE POLICY deposits_tenant_isolation ON deposits
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- withdrawals
DROP POLICY IF EXISTS withdrawals_tenant_isolation ON withdrawals;
CREATE POLICY withdrawals_tenant_isolation ON withdrawals
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- scale_disconnections
DROP POLICY IF EXISTS scale_disconnections_tenant_isolation ON scale_disconnections;
CREATE POLICY scale_disconnections_tenant_isolation ON scale_disconnections
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- suspicious_weighing_events
DROP POLICY IF EXISTS suspicious_weighing_events_tenant_isolation ON suspicious_weighing_events;
CREATE POLICY suspicious_weighing_events_tenant_isolation ON suspicious_weighing_events
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- guardian_employee_scores_daily
DROP POLICY IF EXISTS guardian_scores_tenant_isolation ON guardian_employee_scores_daily;
CREATE POLICY guardian_scores_tenant_isolation ON guardian_employee_scores_daily
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- devices
DROP POLICY IF EXISTS devices_tenant_isolation ON devices;
CREATE POLICY devices_tenant_isolation ON devices
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- employee_branches (JOIN con employees)
DROP POLICY IF EXISTS employee_branches_tenant_isolation ON employee_branches;
CREATE POLICY employee_branches_tenant_isolation ON employee_branches
  USING (
    EXISTS (
      SELECT 1 FROM employees
      WHERE employees.id = employee_branches.employee_id
        AND employees.tenant_id = current_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM employees
      WHERE employees.id = employee_branches.employee_id
        AND employees.tenant_id = current_tenant_id()
    )
  );

-- repartidor_assignments
DROP POLICY IF EXISTS repartidor_assignments_tenant_isolation ON repartidor_assignments;
CREATE POLICY repartidor_assignments_tenant_isolation ON repartidor_assignments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ========== COMENTARIOS ==========
COMMENT ON FUNCTION current_tenant_id() IS 'Función helper para RLS - obtiene tenant_id de app.current_tenant_id setting';

-- ========== IMPORTANTE: CÓMO USAR RLS EN EL SERVIDOR ==========
-- Antes de cada query, el servidor Node.js debe ejecutar:
--
--   await client.query('SET LOCAL app.current_tenant_id = $1', [tenantId]);
--
-- Esto configura el tenant_id para la transacción/query actual.
-- RLS automáticamente filtrará resultados basándose en esto.
--
-- Ejemplo en Node.js con pg:
--
--   const client = await pool.connect();
--   try {
--     await client.query('BEGIN');
--     await client.query('SET LOCAL app.current_tenant_id = $1', [req.user.tenantId]);
--     const result = await client.query('SELECT * FROM customers'); // RLS aplicado
--     await client.query('COMMIT');
--     return result.rows;
--   } catch (err) {
--     await client.query('ROLLBACK');
--     throw err;
--   } finally {
--     client.release();
--   }
