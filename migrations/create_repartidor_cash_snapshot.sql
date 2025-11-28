-- ============================================================================
-- MIGRACIÓN: Sistema de Snapshot de Corte de Caja para Repartidores
-- ============================================================================
-- Propósito: Mantener un snapshot incremental del estado de caja de cada turno
--            de repartidor, calculado en tiempo real y sincronizable offline-first
-- ============================================================================

-- Tabla principal: Snapshot de corte de caja por turno de repartidor
CREATE TABLE IF NOT EXISTS repartidor_shift_cash_snapshot (
  id SERIAL PRIMARY KEY,

  -- Identificadores multi-tenant
  tenant_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  repartidor_shift_id INTEGER NOT NULL REFERENCES repartidor_shifts(id) ON DELETE CASCADE,

  -- === MONTOS CALCULADOS ===
  -- Dinero inicial del turno
  initial_amount DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Ventas asignadas liquidadas (efectivo)
  cash_sales DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Ventas con tarjeta (si aplica para repartidores)
  card_sales DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Ventas a crédito (si aplica para repartidores)
  credit_sales DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Pagos de clientes en efectivo
  cash_payments DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Pagos de clientes con tarjeta
  card_payments DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Gastos del turno
  expenses DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Depósitos (ingresos extra)
  deposits DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Retiros (salidas de dinero)
  withdrawals DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- === MONTOS CALCULADOS DE ASIGNACIONES ===
  -- Total asignado (suma de todas las asignaciones)
  total_assigned_amount DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Total asignado en kilos
  total_assigned_quantity DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Total devuelto (suma de todas las devoluciones)
  total_returned_amount DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Total devuelto en kilos
  total_returned_quantity DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Dinero neto que debería entregar (asignado - devuelto)
  net_amount_to_deliver DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Cantidad neta en kilos (asignado - devuelto)
  net_quantity_delivered DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Dinero realmente entregado por el repartidor
  actual_cash_delivered DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- Diferencia (sobrante/faltante): actual_cash_delivered - net_amount_to_deliver
  cash_difference DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

  -- === CAMPO CALCULADO AUTOMÁTICAMENTE ===
  -- Dinero esperado en caja (fórmula del corte de caja)
  expected_cash DECIMAL(10,2) GENERATED ALWAYS AS (
    initial_amount
    + cash_sales
    + cash_payments
    + deposits
    - expenses
    - withdrawals
  ) STORED,

  -- === CONTADORES DE TRANSACCIONES ===
  assignment_count INTEGER DEFAULT 0 NOT NULL,
  liquidated_assignment_count INTEGER DEFAULT 0 NOT NULL,
  return_count INTEGER DEFAULT 0 NOT NULL,
  expense_count INTEGER DEFAULT 0 NOT NULL,
  deposit_count INTEGER DEFAULT 0 NOT NULL,
  withdrawal_count INTEGER DEFAULT 0 NOT NULL,

  -- === METADATA DE SINCRONIZACIÓN OFFLINE-FIRST ===
  -- Última actualización del snapshot
  last_updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Indica si el snapshot necesita recalcularse
  needs_recalculation BOOLEAN DEFAULT FALSE NOT NULL,

  -- Indica si el snapshot necesita actualizarse en el servidor
  needs_update BOOLEAN DEFAULT FALSE NOT NULL,

  -- Indica si el snapshot debe eliminarse (soft delete para sincronización)
  needs_deletion BOOLEAN DEFAULT FALSE NOT NULL,

  -- Última sincronización exitosa con el servidor
  synced_at TIMESTAMPTZ,

  -- UUID para idempotencia (evitar duplicados en sincronización)
  global_id VARCHAR(36) UNIQUE,

  -- ID de la terminal que creó/actualizó este snapshot
  terminal_id VARCHAR(100),

  -- Timestamp de creación
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- Timestamp de última actualización
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

  -- === CONSTRAINTS ===
  CONSTRAINT unique_snapshot_per_shift UNIQUE(repartidor_shift_id),
  CONSTRAINT chk_amounts_non_negative CHECK (
    initial_amount >= 0 AND
    cash_sales >= 0 AND
    card_sales >= 0 AND
    credit_sales >= 0 AND
    cash_payments >= 0 AND
    card_payments >= 0 AND
    expenses >= 0 AND
    deposits >= 0 AND
    withdrawals >= 0 AND
    total_assigned_amount >= 0 AND
    total_assigned_quantity >= 0 AND
    total_returned_amount >= 0 AND
    total_returned_quantity >= 0 AND
    net_amount_to_deliver >= 0 AND
    net_quantity_delivered >= 0
  )
);

-- Índices para optimizar queries
CREATE INDEX idx_cash_snapshot_shift ON repartidor_shift_cash_snapshot(repartidor_shift_id);
CREATE INDEX idx_cash_snapshot_employee ON repartidor_shift_cash_snapshot(employee_id);
CREATE INDEX idx_cash_snapshot_branch ON repartidor_shift_cash_snapshot(branch_id, tenant_id);
CREATE INDEX idx_cash_snapshot_needs_recalc ON repartidor_shift_cash_snapshot(needs_recalculation) WHERE needs_recalculation = TRUE;
CREATE INDEX idx_cash_snapshot_needs_update ON repartidor_shift_cash_snapshot(needs_update) WHERE needs_update = TRUE;
CREATE INDEX idx_cash_snapshot_needs_deletion ON repartidor_shift_cash_snapshot(needs_deletion) WHERE needs_deletion = TRUE;
CREATE INDEX idx_cash_snapshot_global_id ON repartidor_shift_cash_snapshot(global_id) WHERE global_id IS NOT NULL;
CREATE INDEX idx_cash_snapshot_updated_at ON repartidor_shift_cash_snapshot(updated_at DESC);

-- Trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_repartidor_cash_snapshot_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cash_snapshot_update_timestamp
BEFORE UPDATE ON repartidor_shift_cash_snapshot
FOR EACH ROW
EXECUTE FUNCTION update_repartidor_cash_snapshot_timestamp();

-- ============================================================================
-- FUNCIÓN: Recalcular snapshot de corte de caja para un turno
-- ============================================================================
-- Parámetros:
--   p_shift_id: ID del turno de repartidor
-- Retorna: El snapshot actualizado
-- ============================================================================
CREATE OR REPLACE FUNCTION recalculate_repartidor_cash_snapshot(p_shift_id INTEGER)
RETURNS TABLE(
  snapshot_id INTEGER,
  expected_cash DECIMAL,
  cash_sales DECIMAL,
  total_assigned_amount DECIMAL,
  total_returned_amount DECIMAL,
  net_amount_to_deliver DECIMAL,
  cash_difference DECIMAL,
  needs_update BOOLEAN
) AS $$
DECLARE
  v_shift_record RECORD;
  v_snapshot_id INTEGER;
  v_assignment_count INTEGER;
  v_liquidated_count INTEGER;
  v_return_count INTEGER;
  v_expense_count INTEGER;
  v_deposit_count INTEGER;
  v_withdrawal_count INTEGER;
BEGIN
  -- Obtener información del turno
  SELECT
    rs.id,
    rs.tenant_id,
    rs.branch_id,
    rs.employee_id,
    COALESCE(rs.initial_cash, 0) as initial_amount
  INTO v_shift_record
  FROM repartidor_shifts rs
  WHERE rs.id = p_shift_id;

  -- Si no existe el turno, salir
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Turno % no encontrado', p_shift_id;
  END IF;

  -- Calcular totales de asignaciones (todas, no solo liquidadas)
  WITH assignment_totals AS (
    SELECT
      COUNT(*) as total_assignments,
      COUNT(*) FILTER (WHERE ra.status = 'liquidated') as liquidated_assignments,
      COALESCE(SUM(ra.assigned_amount), 0) as total_assigned_amt,
      COALESCE(SUM(ra.assigned_quantity), 0) as total_assigned_qty
    FROM repartidor_assignments ra
    WHERE ra.repartidor_shift_id = p_shift_id
      AND ra.status != 'cancelled'
  ),

  -- Calcular totales de devoluciones
  return_totals AS (
    SELECT
      COUNT(*) as total_returns,
      COALESCE(SUM(rr.amount), 0) as total_returned_amt,
      COALESCE(SUM(rr.quantity), 0) as total_returned_qty
    FROM repartidor_returns rr
    INNER JOIN repartidor_assignments ra ON ra.id = rr.assignment_id
    WHERE ra.repartidor_shift_id = p_shift_id
  ),

  -- Calcular neto (asignado - devuelto)
  net_calculations AS (
    SELECT
      at.total_assigned_amt - COALESCE(rt.total_returned_amt, 0) as net_amt,
      at.total_assigned_qty - COALESCE(rt.total_returned_qty, 0) as net_qty
    FROM assignment_totals at
    LEFT JOIN return_totals rt ON TRUE
  ),

  -- Calcular ventas en efectivo (asignaciones liquidadas)
  cash_sales_calc AS (
    SELECT COALESCE(SUM(ra.assigned_amount - COALESCE(rr_agg.total_returned, 0)), 0) as cash_sales
    FROM repartidor_assignments ra
    LEFT JOIN (
      SELECT assignment_id, SUM(amount) as total_returned
      FROM repartidor_returns
      GROUP BY assignment_id
    ) rr_agg ON rr_agg.assignment_id = ra.id
    WHERE ra.repartidor_shift_id = p_shift_id
      AND ra.status = 'liquidated'
  ),

  -- Calcular gastos del turno
  expense_totals AS (
    SELECT
      COUNT(*) as total_expenses,
      COALESCE(SUM(amount), 0) as expenses
    FROM expenses
    WHERE shift_id = p_shift_id
  ),

  -- Calcular depósitos del turno
  deposit_totals AS (
    SELECT
      COUNT(*) as total_deposits,
      COALESCE(SUM(amount), 0) as deposits
    FROM deposits
    WHERE shift_id = p_shift_id
  ),

  -- Calcular retiros del turno
  withdrawal_totals AS (
    SELECT
      COUNT(*) as total_withdrawals,
      COALESCE(SUM(ABS(amount)), 0) as withdrawals
    FROM withdrawals
    WHERE shift_id = p_shift_id
  )

  -- Upsert en la tabla snapshot
  INSERT INTO repartidor_shift_cash_snapshot (
    tenant_id,
    branch_id,
    employee_id,
    repartidor_shift_id,
    initial_amount,
    cash_sales,
    card_sales,
    credit_sales,
    cash_payments,
    card_payments,
    expenses,
    deposits,
    withdrawals,
    total_assigned_amount,
    total_assigned_quantity,
    total_returned_amount,
    total_returned_quantity,
    net_amount_to_deliver,
    net_quantity_delivered,
    actual_cash_delivered,
    cash_difference,
    assignment_count,
    liquidated_assignment_count,
    return_count,
    expense_count,
    deposit_count,
    withdrawal_count,
    last_updated_at,
    needs_recalculation,
    needs_update
  )
  SELECT
    v_shift_record.tenant_id,
    v_shift_record.branch_id,
    v_shift_record.employee_id,
    v_shift_record.id,
    v_shift_record.initial_amount,
    cs.cash_sales,
    0, -- card_sales (placeholder para repartidores)
    0, -- credit_sales (placeholder)
    0, -- cash_payments (placeholder)
    0, -- card_payments (placeholder)
    et.expenses,
    dt.deposits,
    wt.withdrawals,
    at.total_assigned_amt,
    at.total_assigned_qty,
    rt.total_returned_amt,
    rt.total_returned_qty,
    nc.net_amt,
    nc.net_qty,
    0, -- actual_cash_delivered (se actualiza cuando el repartidor liquida)
    0, -- cash_difference (se calcula después)
    at.total_assignments,
    at.liquidated_assignments,
    rt.total_returns,
    et.total_expenses,
    dt.total_deposits,
    wt.total_withdrawals,
    NOW(),
    FALSE, -- needs_recalculation
    TRUE   -- needs_update (para que Desktop sepa que hay cambios)
  FROM assignment_totals at
  CROSS JOIN return_totals rt
  CROSS JOIN net_calculations nc
  CROSS JOIN cash_sales_calc cs
  CROSS JOIN expense_totals et
  CROSS JOIN deposit_totals dt
  CROSS JOIN withdrawal_totals wt

  ON CONFLICT (repartidor_shift_id)
  DO UPDATE SET
    cash_sales = EXCLUDED.cash_sales,
    expenses = EXCLUDED.expenses,
    deposits = EXCLUDED.deposits,
    withdrawals = EXCLUDED.withdrawals,
    total_assigned_amount = EXCLUDED.total_assigned_amount,
    total_assigned_quantity = EXCLUDED.total_assigned_quantity,
    total_returned_amount = EXCLUDED.total_returned_amount,
    total_returned_quantity = EXCLUDED.total_returned_quantity,
    net_amount_to_deliver = EXCLUDED.net_amount_to_deliver,
    net_quantity_delivered = EXCLUDED.net_quantity_delivered,
    assignment_count = EXCLUDED.assignment_count,
    liquidated_assignment_count = EXCLUDED.liquidated_assignment_count,
    return_count = EXCLUDED.return_count,
    expense_count = EXCLUDED.expense_count,
    deposit_count = EXCLUDED.deposit_count,
    withdrawal_count = EXCLUDED.withdrawal_count,
    last_updated_at = NOW(),
    needs_recalculation = FALSE,
    needs_update = TRUE
  RETURNING id INTO v_snapshot_id;

  -- Retornar el snapshot actualizado
  RETURN QUERY
  SELECT
    s.id as snapshot_id,
    s.expected_cash,
    s.cash_sales,
    s.total_assigned_amount,
    s.total_returned_amount,
    s.net_amount_to_deliver,
    s.cash_difference,
    s.needs_update
  FROM repartidor_shift_cash_snapshot s
  WHERE s.id = v_snapshot_id;

END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCIÓN: Actualizar dinero entregado por el repartidor (liquidación)
-- ============================================================================
CREATE OR REPLACE FUNCTION update_repartidor_cash_delivered(
  p_shift_id INTEGER,
  p_actual_cash_delivered DECIMAL
)
RETURNS TABLE(
  snapshot_id INTEGER,
  net_amount_to_deliver DECIMAL,
  actual_cash_delivered DECIMAL,
  cash_difference DECIMAL
) AS $$
BEGIN
  -- Actualizar el dinero entregado y calcular diferencia
  UPDATE repartidor_shift_cash_snapshot
  SET
    actual_cash_delivered = p_actual_cash_delivered,
    cash_difference = p_actual_cash_delivered - net_amount_to_deliver,
    needs_update = TRUE,
    last_updated_at = NOW()
  WHERE repartidor_shift_id = p_shift_id;

  -- Retornar el snapshot actualizado
  RETURN QUERY
  SELECT
    s.id as snapshot_id,
    s.net_amount_to_deliver,
    s.actual_cash_delivered,
    s.cash_difference
  FROM repartidor_shift_cash_snapshot s
  WHERE s.repartidor_shift_id = p_shift_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGER: Marcar snapshot para recalcular cuando cambian asignaciones
-- ============================================================================
CREATE OR REPLACE FUNCTION mark_cash_snapshot_for_recalc_on_assignment()
RETURNS TRIGGER AS $$
BEGIN
  -- Si es INSERT o UPDATE, usar NEW.repartidor_shift_id
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    UPDATE repartidor_shift_cash_snapshot
    SET
      needs_recalculation = TRUE,
      needs_update = TRUE
    WHERE repartidor_shift_id = NEW.repartidor_shift_id;
  END IF;

  -- Si es DELETE, usar OLD.repartidor_shift_id
  IF TG_OP = 'DELETE' THEN
    UPDATE repartidor_shift_cash_snapshot
    SET
      needs_recalculation = TRUE,
      needs_update = TRUE
    WHERE repartidor_shift_id = OLD.repartidor_shift_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assignment_mark_snapshot_recalc
AFTER INSERT OR UPDATE OR DELETE ON repartidor_assignments
FOR EACH ROW
EXECUTE FUNCTION mark_cash_snapshot_for_recalc_on_assignment();

-- ============================================================================
-- TRIGGER: Marcar snapshot para recalcular cuando cambian devoluciones
-- ============================================================================
CREATE OR REPLACE FUNCTION mark_cash_snapshot_for_recalc_on_return()
RETURNS TRIGGER AS $$
BEGIN
  -- Obtener el shift_id desde la asignación
  UPDATE repartidor_shift_cash_snapshot
  SET
    needs_recalculation = TRUE,
    needs_update = TRUE
  WHERE repartidor_shift_id IN (
    SELECT repartidor_shift_id
    FROM repartidor_assignments
    WHERE id = COALESCE(NEW.assignment_id, OLD.assignment_id)
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_return_mark_snapshot_recalc
AFTER INSERT OR UPDATE OR DELETE ON repartidor_returns
FOR EACH ROW
EXECUTE FUNCTION mark_cash_snapshot_for_recalc_on_return();

-- ============================================================================
-- COMENTARIOS PARA DOCUMENTACIÓN
-- ============================================================================
COMMENT ON TABLE repartidor_shift_cash_snapshot IS 'Snapshot incremental del estado de caja para cada turno de repartidor. Soporta sincronización offline-first con campos needs_update/needs_deletion.';
COMMENT ON COLUMN repartidor_shift_cash_snapshot.expected_cash IS 'Campo calculado automáticamente: initial_amount + cash_sales + cash_payments + deposits - expenses - withdrawals';
COMMENT ON COLUMN repartidor_shift_cash_snapshot.net_amount_to_deliver IS 'Dinero neto que el repartidor debe entregar: total_assigned_amount - total_returned_amount';
COMMENT ON COLUMN repartidor_shift_cash_snapshot.cash_difference IS 'Sobrante/Faltante: actual_cash_delivered - net_amount_to_deliver (positivo = sobrante, negativo = faltante)';
COMMENT ON COLUMN repartidor_shift_cash_snapshot.needs_recalculation IS 'TRUE si el snapshot necesita recalcularse por cambios en asignaciones/devoluciones';
COMMENT ON COLUMN repartidor_shift_cash_snapshot.needs_update IS 'TRUE si el snapshot ha cambiado y Desktop debe sincronizarlo';
COMMENT ON COLUMN repartidor_shift_cash_snapshot.needs_deletion IS 'TRUE si el snapshot debe eliminarse (soft delete para sincronización offline-first)';
COMMENT ON FUNCTION recalculate_repartidor_cash_snapshot(INTEGER) IS 'Recalcula el snapshot de corte de caja para un turno específico. Usa upsert idempotente.';
COMMENT ON FUNCTION update_repartidor_cash_delivered(INTEGER, DECIMAL) IS 'Actualiza el dinero entregado por el repartidor y calcula la diferencia (sobrante/faltante).';

-- ============================================================================
-- FIN DE MIGRACIÓN
-- ============================================================================
