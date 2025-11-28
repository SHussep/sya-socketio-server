-- ============================================================================
-- MIGRACIÓN: Actualizar funciones para usar shift_cash_snapshot
-- ============================================================================
-- Propósito: Actualizar nombres de funciones y referencias a tabla genérica
-- ============================================================================

-- 1. Eliminar funciones antiguas
DROP FUNCTION IF EXISTS recalculate_repartidor_cash_snapshot(INTEGER);
DROP FUNCTION IF EXISTS update_repartidor_cash_delivered(INTEGER, DECIMAL);
DROP FUNCTION IF EXISTS update_repartidor_cash_snapshot_timestamp();

-- 2. Crear función actualizada de timestamp
CREATE OR REPLACE FUNCTION update_shift_cash_snapshot_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Actualizar trigger de timestamp
DROP TRIGGER IF EXISTS trg_cash_snapshot_update_timestamp ON shift_cash_snapshot;
DROP TRIGGER IF EXISTS trg_cash_snapshot_update_timestamp ON repartidor_shift_cash_snapshot;

CREATE TRIGGER trg_cash_snapshot_update_timestamp
BEFORE UPDATE ON shift_cash_snapshot
FOR EACH ROW
EXECUTE FUNCTION update_shift_cash_snapshot_timestamp();

-- 4. Crear función de recálculo actualizada (para repartidores)
CREATE OR REPLACE FUNCTION recalculate_shift_cash_snapshot(p_shift_id INTEGER)
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
  v_employee_role VARCHAR(50);
BEGIN
  -- Obtener información del turno y rol del empleado
  SELECT
    s.id,
    s.tenant_id,
    s.branch_id,
    s.employee_id,
    COALESCE(s.initial_cash, 0) as initial_amount,
    r.name as role_name
  INTO v_shift_record
  FROM shifts s
  INNER JOIN employees e ON s.employee_id = e.id
  INNER JOIN roles r ON e.role_id = r.id
  WHERE s.id = p_shift_id;

  -- Si no existe el turno, salir
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Turno % no encontrado', p_shift_id;
  END IF;

  v_employee_role := v_shift_record.role_name;

  -- Solo para repartidores: calcular asignaciones y devoluciones
  IF v_employee_role = 'repartidor' THEN
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
      SELECT
        COALESCE(SUM(ra.assigned_amount - COALESCE(rr_sub.returned_amt, 0)), 0) as cash_sales
      FROM repartidor_assignments ra
      LEFT JOIN (
        SELECT
          rr.assignment_id,
          SUM(rr.amount) as returned_amt
        FROM repartidor_returns rr
        GROUP BY rr.assignment_id
      ) rr_sub ON rr_sub.assignment_id = ra.id
      WHERE ra.repartidor_shift_id = p_shift_id
        AND ra.status = 'liquidated'
    ),

    -- Contadores
    counters AS (
      SELECT
        at.total_assignments as assignment_count,
        at.liquidated_assignments as liquidated_assignment_count,
        rt.total_returns as return_count,
        0 as expense_count,
        0 as deposit_count,
        0 as withdrawal_count
      FROM assignment_totals at
      LEFT JOIN return_totals rt ON TRUE
    )

    -- Insertar o actualizar snapshot
    INSERT INTO shift_cash_snapshot (
      tenant_id,
      branch_id,
      employee_id,
      shift_id,
      employee_role,
      initial_amount,
      cash_sales,
      expected_cash,
      total_assigned_amount,
      total_assigned_quantity,
      total_returned_amount,
      total_returned_quantity,
      net_amount_to_deliver,
      net_quantity_delivered,
      assignment_count,
      liquidated_assignment_count,
      return_count,
      needs_recalculation,
      needs_update,
      last_updated_at
    )
    SELECT
      v_shift_record.tenant_id,
      v_shift_record.branch_id,
      v_shift_record.employee_id,
      p_shift_id,
      v_employee_role,
      v_shift_record.initial_amount,
      cs.cash_sales,
      v_shift_record.initial_amount + cs.cash_sales,
      at.total_assigned_amt,
      at.total_assigned_qty,
      COALESCE(rt.total_returned_amt, 0),
      COALESCE(rt.total_returned_qty, 0),
      nc.net_amt,
      nc.net_qty,
      c.assignment_count,
      c.liquidated_assignment_count,
      c.return_count,
      FALSE,
      TRUE,
      NOW()
    FROM assignment_totals at
    LEFT JOIN return_totals rt ON TRUE
    LEFT JOIN net_calculations nc ON TRUE
    LEFT JOIN cash_sales_calc cs ON TRUE
    LEFT JOIN counters c ON TRUE
    ON CONFLICT (shift_id)
    DO UPDATE SET
      cash_sales = EXCLUDED.cash_sales,
      expected_cash = EXCLUDED.expected_cash,
      total_assigned_amount = EXCLUDED.total_assigned_amount,
      total_assigned_quantity = EXCLUDED.total_assigned_quantity,
      total_returned_amount = EXCLUDED.total_returned_amount,
      total_returned_quantity = EXCLUDED.total_returned_quantity,
      net_amount_to_deliver = EXCLUDED.net_amount_to_deliver,
      net_quantity_delivered = EXCLUDED.net_quantity_delivered,
      cash_difference = EXCLUDED.actual_cash_delivered - EXCLUDED.net_amount_to_deliver,
      assignment_count = EXCLUDED.assignment_count,
      liquidated_assignment_count = EXCLUDED.liquidated_assignment_count,
      return_count = EXCLUDED.return_count,
      needs_recalculation = FALSE,
      needs_update = TRUE,
      last_updated_at = NOW()
    RETURNING id INTO v_snapshot_id;

  ELSE
    -- Para otros roles (cajeros, administradores): snapshot básico
    INSERT INTO shift_cash_snapshot (
      tenant_id,
      branch_id,
      employee_id,
      shift_id,
      employee_role,
      initial_amount,
      cash_sales,
      expected_cash,
      needs_recalculation,
      needs_update,
      last_updated_at
    )
    VALUES (
      v_shift_record.tenant_id,
      v_shift_record.branch_id,
      v_shift_record.employee_id,
      p_shift_id,
      v_employee_role,
      v_shift_record.initial_amount,
      0,
      v_shift_record.initial_amount,
      FALSE,
      TRUE,
      NOW()
    )
    ON CONFLICT (shift_id)
    DO UPDATE SET
      initial_amount = EXCLUDED.initial_amount,
      expected_cash = EXCLUDED.expected_cash,
      needs_recalculation = FALSE,
      needs_update = TRUE,
      last_updated_at = NOW()
    RETURNING id INTO v_snapshot_id;
  END IF;

  -- Retornar el snapshot actualizado
  RETURN QUERY
  SELECT
    scs.id,
    scs.expected_cash,
    scs.cash_sales,
    scs.total_assigned_amount,
    scs.total_returned_amount,
    scs.net_amount_to_deliver,
    scs.cash_difference,
    scs.needs_update
  FROM shift_cash_snapshot scs
  WHERE scs.id = v_snapshot_id;
END;
$$ LANGUAGE plpgsql;

-- 5. Crear función de actualización de dinero entregado
CREATE OR REPLACE FUNCTION update_shift_cash_delivered(
  p_shift_id INTEGER,
  p_actual_cash_delivered DECIMAL
)
RETURNS TABLE(
  snapshot_id INTEGER,
  net_amount_to_deliver DECIMAL,
  actual_cash_delivered DECIMAL,
  cash_difference DECIMAL
) AS $$
DECLARE
  v_snapshot_id INTEGER;
BEGIN
  -- Actualizar el dinero entregado y calcular diferencia
  UPDATE shift_cash_snapshot
  SET
    actual_cash_delivered = p_actual_cash_delivered,
    cash_difference = p_actual_cash_delivered - net_amount_to_deliver,
    needs_update = TRUE,
    last_updated_at = NOW()
  WHERE shift_id = p_shift_id
  RETURNING id INTO v_snapshot_id;

  -- Si no existe, lanzar error
  IF v_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'No existe snapshot para el turno %', p_shift_id;
  END IF;

  -- Retornar datos actualizados
  RETURN QUERY
  SELECT
    scs.id,
    scs.net_amount_to_deliver,
    scs.actual_cash_delivered,
    scs.cash_difference
  FROM shift_cash_snapshot scs
  WHERE scs.id = v_snapshot_id;
END;
$$ LANGUAGE plpgsql;

-- 6. Actualizar triggers de asignaciones y devoluciones
DROP TRIGGER IF EXISTS trg_assignment_mark_snapshot_recalc ON repartidor_assignments;
DROP TRIGGER IF EXISTS trg_return_mark_snapshot_recalc ON repartidor_returns;

CREATE OR REPLACE FUNCTION mark_shift_snapshot_for_recalc()
RETURNS TRIGGER AS $$
BEGIN
  -- Marcar el snapshot como que necesita recalculación
  UPDATE shift_cash_snapshot
  SET needs_recalculation = TRUE, last_updated_at = NOW()
  WHERE shift_id = COALESCE(NEW.repartidor_shift_id, OLD.repartidor_shift_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_assignment_mark_snapshot_recalc
AFTER INSERT OR UPDATE OR DELETE ON repartidor_assignments
FOR EACH ROW
EXECUTE FUNCTION mark_shift_snapshot_for_recalc();

CREATE TRIGGER trg_return_mark_snapshot_recalc
AFTER INSERT OR UPDATE OR DELETE ON repartidor_returns
FOR EACH ROW
EXECUTE FUNCTION mark_shift_snapshot_for_recalc();

-- ============================================================================
-- FIN DE MIGRACIÓN
-- ============================================================================
