-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN: Triggers para Notas de Crédito - Saldo Cliente e Inventario
-- ═══════════════════════════════════════════════════════════════════════════
-- Esta migración agrega los triggers faltantes para:
-- 1. Actualizar saldo_deudor del cliente cuando se aplica NC a venta a crédito
-- 2. Actualizar inventario de productos cuando devuelve_a_inventario = TRUE
-- ═══════════════════════════════════════════════════════════════════════════

-- ============================================================================
-- 1. TRIGGER: Actualizar saldo del cliente en notas de crédito
-- ============================================================================
-- Cuando se crea una nota de crédito para una venta a crédito (tipo_pago_id=3),
-- se debe reducir el saldo_deudor del cliente por el monto de la NC.

CREATE OR REPLACE FUNCTION update_customer_balance_on_nota_credito()
RETURNS TRIGGER AS $$
DECLARE
    v_tipo_pago_id INTEGER;
    v_cliente_id INTEGER;
BEGIN
    -- Solo procesar si la NC está aplicada y tiene cliente
    IF NEW.estado = 'Aplicada' AND NEW.cliente_id IS NOT NULL THEN

        -- Obtener el tipo de pago de la venta original
        SELECT tipo_pago_id, id_cliente INTO v_tipo_pago_id, v_cliente_id
        FROM ventas
        WHERE id_venta = NEW.venta_original_id;

        -- Si la venta original fue a crédito (tipo_pago_id = 3), reducir saldo
        IF v_tipo_pago_id = 3 THEN
            UPDATE customers
            SET saldo_deudor = GREATEST(saldo_deudor - NEW.total, 0),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.cliente_id;

            RAISE NOTICE '[NC Trigger] Reducido saldo cliente % en $% por NC %',
                NEW.cliente_id, NEW.total, NEW.id;
        END IF;

        -- Si hay monto_credito específico (para casos mixtos), aplicarlo también
        IF NEW.monto_credito > 0 AND v_tipo_pago_id != 3 THEN
            UPDATE customers
            SET saldo_deudor = GREATEST(saldo_deudor - NEW.monto_credito, 0),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.cliente_id;

            RAISE NOTICE '[NC Trigger] Reducido saldo cliente % en $% (monto_credito) por NC %',
                NEW.cliente_id, NEW.monto_credito, NEW.id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Eliminar trigger si existe y recrear
DROP TRIGGER IF EXISTS trigger_update_balance_on_nota_credito ON notas_credito;
CREATE TRIGGER trigger_update_balance_on_nota_credito
    AFTER INSERT ON notas_credito
    FOR EACH ROW
    EXECUTE FUNCTION update_customer_balance_on_nota_credito();

-- ============================================================================
-- 2. TRIGGER: Actualizar inventario en detalle de nota de crédito
-- ============================================================================
-- Cuando se inserta un detalle de NC con devuelve_a_inventario = TRUE,
-- se debe aumentar el inventario del producto correspondiente.

CREATE OR REPLACE FUNCTION update_inventory_on_nota_credito_detalle()
RETURNS TRIGGER AS $$
DECLARE
    v_tenant_id INTEGER;
    v_branch_id INTEGER;
BEGIN
    -- Solo procesar si devuelve_a_inventario es TRUE
    IF NEW.devuelve_a_inventario = TRUE THEN

        -- Obtener tenant_id y branch_id de la nota de crédito padre
        SELECT tenant_id, branch_id INTO v_tenant_id, v_branch_id
        FROM notas_credito
        WHERE id = NEW.nota_credito_id;

        -- Aumentar inventario del producto
        UPDATE productos
        SET inventario = inventario + NEW.cantidad,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.producto_id
          AND tenant_id = v_tenant_id;

        RAISE NOTICE '[NC Detalle Trigger] Aumentado inventario producto % en % unidades por NC detalle %',
            NEW.producto_id, NEW.cantidad, NEW.id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Eliminar trigger si existe y recrear
DROP TRIGGER IF EXISTS trigger_update_inventory_on_nc_detalle ON notas_credito_detalle;
CREATE TRIGGER trigger_update_inventory_on_nc_detalle
    AFTER INSERT ON notas_credito_detalle
    FOR EACH ROW
    EXECUTE FUNCTION update_inventory_on_nota_credito_detalle();

-- ============================================================================
-- 3. TRIGGER: Actualizar inventario en devoluciones de repartidor
-- ============================================================================
-- Cuando un repartidor registra una devolución confirmada, el inventario debe aumentar.
-- Si se elimina una devolución previamente confirmada, revertir el inventario.

CREATE OR REPLACE FUNCTION update_inventory_on_repartidor_return()
RETURNS TRIGGER AS $$
BEGIN
    -- INSERT: Solo procesar returns confirmados
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'confirmed' AND NEW.product_id IS NOT NULL THEN
            UPDATE productos
            SET inventario = inventario + NEW.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.product_id
              AND tenant_id = NEW.tenant_id;

            RAISE NOTICE '[Repartidor Return Trigger] INSERT: Aumentado inventario producto % en % kg',
                NEW.product_id, NEW.quantity;
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE: Manejar cambios de status
    IF TG_OP = 'UPDATE' AND NEW.product_id IS NOT NULL THEN
        -- De draft/deleted a confirmed -> aumentar inventario
        IF OLD.status != 'confirmed' AND NEW.status = 'confirmed' THEN
            UPDATE productos
            SET inventario = inventario + NEW.quantity,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.product_id
              AND tenant_id = NEW.tenant_id;

            RAISE NOTICE '[Repartidor Return Trigger] UPDATE->confirmed: Aumentado inventario producto % en % kg',
                NEW.product_id, NEW.quantity;

        -- De confirmed a deleted -> revertir inventario
        ELSIF OLD.status = 'confirmed' AND NEW.status = 'deleted' THEN
            UPDATE productos
            SET inventario = GREATEST(inventario - NEW.quantity, 0),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.product_id
              AND tenant_id = NEW.tenant_id;

            RAISE NOTICE '[Repartidor Return Trigger] UPDATE->deleted: Reducido inventario producto % en % kg',
                NEW.product_id, NEW.quantity;
        END IF;
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Eliminar trigger si existe y recrear
DROP TRIGGER IF EXISTS trigger_update_inventory_on_repartidor_return ON repartidor_returns;
CREATE TRIGGER trigger_update_inventory_on_repartidor_return
    AFTER INSERT OR UPDATE ON repartidor_returns
    FOR EACH ROW
    EXECUTE FUNCTION update_inventory_on_repartidor_return();

-- ============================================================================
-- 4. TRIGGER: Revertir saldo si se anula una nota de crédito
-- ============================================================================
-- Si una NC pasa de 'Aplicada' a 'Anulada', revertir el saldo del cliente

CREATE OR REPLACE FUNCTION revert_customer_balance_on_nc_cancel()
RETURNS TRIGGER AS $$
DECLARE
    v_tipo_pago_id INTEGER;
BEGIN
    -- Solo procesar si cambia de Aplicada a Anulada
    IF OLD.estado = 'Aplicada' AND NEW.estado = 'Anulada' AND NEW.cliente_id IS NOT NULL THEN

        -- Obtener el tipo de pago de la venta original
        SELECT tipo_pago_id INTO v_tipo_pago_id
        FROM ventas
        WHERE id_venta = NEW.venta_original_id;

        -- Si la venta original fue a crédito, devolver el saldo
        IF v_tipo_pago_id = 3 THEN
            UPDATE customers
            SET saldo_deudor = saldo_deudor + NEW.total,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.cliente_id;

            RAISE NOTICE '[NC Cancel Trigger] Revertido saldo cliente % en $% por anulación NC %',
                NEW.cliente_id, NEW.total, NEW.id;
        END IF;

        -- Si había monto_credito específico
        IF NEW.monto_credito > 0 AND v_tipo_pago_id != 3 THEN
            UPDATE customers
            SET saldo_deudor = saldo_deudor + NEW.monto_credito,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.cliente_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Eliminar trigger si existe y recrear
DROP TRIGGER IF EXISTS trigger_revert_balance_on_nc_cancel ON notas_credito;
CREATE TRIGGER trigger_revert_balance_on_nc_cancel
    AFTER UPDATE ON notas_credito
    FOR EACH ROW
    WHEN (OLD.estado IS DISTINCT FROM NEW.estado)
    EXECUTE FUNCTION revert_customer_balance_on_nc_cancel();

-- ============================================================================
-- 5. COMENTARIOS
-- ============================================================================
COMMENT ON FUNCTION update_customer_balance_on_nota_credito() IS
    'Reduce saldo_deudor del cliente cuando se aplica una NC a venta a crédito';

COMMENT ON FUNCTION update_inventory_on_nota_credito_detalle() IS
    'Aumenta inventario cuando detalle de NC tiene devuelve_a_inventario=TRUE';

COMMENT ON FUNCTION update_inventory_on_repartidor_return() IS
    'Aumenta inventario cuando repartidor registra devolución';

COMMENT ON FUNCTION revert_customer_balance_on_nc_cancel() IS
    'Revierte saldo_deudor si se anula una NC previamente aplicada';
