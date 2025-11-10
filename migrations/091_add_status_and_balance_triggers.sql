-- =====================================================
-- Migration: 091_add_status_and_balance_triggers.sql
-- Descripción: Agregar status a sales + triggers para calcular saldo_deudor automáticamente
-- =====================================================

-- PROBLEMA:
--   1. saldo_deudor se sincronizaba desde Desktop pero quedaba desactualizado
--   2. Desktop actualiza saldo localmente pero no se refleja en PostgreSQL
--   3. Ventas canceladas no revierten el saldo en PostgreSQL

-- SOLUCIÓN:
--   1. NO sincronizar saldo_deudor (Desktop ya no lo envía)
--   2. Calcular saldo_deudor automáticamente con triggers:
--      - INSERT sale (credit) → aumenta saldo
--      - UPDATE sale status='cancelled' → revierte saldo
--      - INSERT credit_payment → disminuye saldo (trigger ya existe en migración 088)
--   3. Agregar columna status a sales para saber si está cancelada

-- ========== AGREGAR COLUMNA STATUS A VENTAS ==========

ALTER TABLE ventas ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_ventas_status ON ventas(status);

COMMENT ON COLUMN ventas.status IS 'Estado de la venta: completed (normal) o cancelled (anulada). Ventas cancelled NO cuentan para saldo_deudor';

-- ========== TRIGGER: AUMENTAR SALDO EN VENTAS A CRÉDITO ==========

CREATE OR REPLACE FUNCTION update_customer_balance_on_credit_sale()
RETURNS TRIGGER AS $$
BEGIN
  -- Solo si es venta a crédito (tipo_pago_id=3) Y no está cancelada
  -- tipo_pago_id: 1=Efectivo, 2=Tarjeta, 3=Crédito (según Desktop)
  IF NEW.tipo_pago_id = 3 AND NEW.id_cliente IS NOT NULL AND (NEW.status IS NULL OR NEW.status = 'completed') THEN
    UPDATE customers
    SET saldo_deudor = saldo_deudor + NEW.total,
        updated_at = NOW()
    WHERE id = NEW.id_cliente;

    RAISE NOTICE '✅ Saldo aumentado +% para cliente % (venta %)', NEW.total, NEW.id_cliente, NEW.id_venta;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_customer_balance_on_credit_sale ON ventas;
CREATE TRIGGER trg_update_customer_balance_on_credit_sale
  AFTER INSERT ON ventas
  FOR EACH ROW
  EXECUTE FUNCTION update_customer_balance_on_credit_sale();

COMMENT ON FUNCTION update_customer_balance_on_credit_sale IS 'Aumenta saldo_deudor cuando se crea venta a crédito (tipo_pago_id=3, status=completed)';

-- ========== TRIGGER: REVERTIR SALDO EN CANCELACIONES ==========

CREATE OR REPLACE FUNCTION revert_customer_balance_on_sale_cancellation()
RETURNS TRIGGER AS $$
DECLARE
    credit_amount NUMERIC(10, 2);
BEGIN
  -- Solo si cambió de completed → cancelled Y es venta a crédito (tipo_pago_id=3)
  IF OLD.status = 'completed' AND NEW.status = 'cancelled' AND OLD.tipo_pago_id = 3 AND OLD.id_cliente IS NOT NULL THEN

    -- Calcular cuánto crédito se había otorgado (total - monto pagado)
    credit_amount := OLD.total - COALESCE(OLD.monto_pagado, 0);

    -- Revertir el saldo (disminuir)
    IF credit_amount > 0 THEN
      UPDATE customers
      SET saldo_deudor = GREATEST(0, saldo_deudor - credit_amount),
          updated_at = NOW()
      WHERE id = OLD.id_cliente;

      RAISE NOTICE '✅ Saldo revertido -% para cliente % (venta % cancelada)', credit_amount, OLD.id_cliente, OLD.id_venta;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_revert_customer_balance_on_sale_cancellation ON ventas;
CREATE TRIGGER trg_revert_customer_balance_on_sale_cancellation
  AFTER UPDATE ON ventas
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION revert_customer_balance_on_sale_cancellation();

COMMENT ON FUNCTION revert_customer_balance_on_sale_cancellation IS 'Revierte saldo_deudor cuando venta a crédito cambia de completed a cancelled';

-- ========== INICIALIZAR STATUS PARA VENTAS EXISTENTES ==========

-- Marcar ventas según estado_venta_id:
--   4 = Cancelada → 'cancelled'
--   Otros → 'completed'
UPDATE ventas
SET status = CASE
  WHEN estado_venta_id = 4 THEN 'cancelled'
  ELSE 'completed'
END
WHERE status IS NULL;

-- ========== COMENTARIOS ==========

COMMENT ON COLUMN ventas.status IS 'Estado de venta: completed=normal, cancelled=anulada (no cuenta para saldo ni reportes). Se deriva de estado_venta_id';
COMMENT ON TABLE ventas IS 'Ventas - status indica si está cancelada (derived from estado_venta_id=4). saldo_deudor de customers se calcula automáticamente con triggers';

-- ========== RESUMEN ==========

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '════════════════════════════════════════════════════════════';
    RAISE NOTICE '✅ Migration 091 completada:';
    RAISE NOTICE '   1. Columna status agregada a sales';
    RAISE NOTICE '   2. Trigger: ventas a crédito aumentan saldo automáticamente';
    RAISE NOTICE '   3. Trigger: cancelaciones revierten saldo automáticamente';
    RAISE NOTICE '   4. Trigger: pagos disminuyen saldo (ya existía en migration 088)';
    RAISE NOTICE '';
    RAISE NOTICE '⚠️  IMPORTANTE:';
    RAISE NOTICE '   - Desktop ya NO sincroniza saldo_deudor';
    RAISE NOTICE '   - PostgreSQL calcula saldo desde sales + credit_payments';
    RAISE NOTICE '   - Desktop DEBE sincronizar status de ventas';
    RAISE NOTICE '════════════════════════════════════════════════════════════';
END $$;
