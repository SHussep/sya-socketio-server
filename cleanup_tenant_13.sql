-- ═══════════════════════════════════════════════════════════════════════════════
-- SCRIPT: Eliminar todos los datos del Tenant 13 (excepto branches y tenant)
-- FECHA: 2026-01-05
-- ═══════════════════════════════════════════════════════════════════════════════
-- IMPORTANTE: Ejecutar en orden. Las FKs requieren eliminar tablas hijas primero.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FASE 1: Tablas con dependencias más profundas (hojas del árbol de FKs)
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1.1 Devoluciones de repartidor (depende de repartidor_assignments)
DELETE FROM repartidor_returns WHERE tenant_id = 13;

-- 1.2 Asignaciones de repartidor (depende de ventas, employees, shifts)
DELETE FROM repartidor_assignments WHERE tenant_id = 13;

-- 1.3 Ventas detalle huérfanos (por si acaso, aunque CASCADE debería limpiarlos)
DELETE FROM ventas_detalle vd
WHERE NOT EXISTS (SELECT 1 FROM ventas v WHERE v.id_venta = vd.id_venta);

-- 1.4 Ventas (CASCADE elimina ventas_detalle automáticamente)
DELETE FROM ventas WHERE tenant_id = 13;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FASE 2: Tablas de operaciones financieras
-- ═══════════════════════════════════════════════════════════════════════════════

-- 2.1 Pagos de crédito (depende de customers, shifts, employees)
DELETE FROM credit_payments WHERE tenant_id = 13;

-- 2.2 Cortes de caja (depende de shifts, employees)
DELETE FROM cash_cuts WHERE tenant_id = 13;

-- 2.3 Depósitos (depende de shifts, employees)
DELETE FROM deposits WHERE tenant_id = 13;

-- 2.4 Retiros (depende de shifts, employees)
DELETE FROM withdrawals WHERE tenant_id = 13;

-- 2.5 Gastos (depende de shifts, employees, global_expense_categories)
DELETE FROM expenses WHERE tenant_id = 13;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FASE 3: Tablas de Guardian (seguridad/auditoría)
-- ═══════════════════════════════════════════════════════════════════════════════

-- 3.1 Logs de pesajes sospechosos
DELETE FROM suspicious_weighing_logs WHERE tenant_id = 13;

-- 3.2 Logs de desconexión de báscula
DELETE FROM scale_disconnection_logs WHERE tenant_id = 13;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FASE 4: Turnos (shifts) - muchas tablas dependen de esta
-- ═══════════════════════════════════════════════════════════════════════════════

DELETE FROM shifts WHERE tenant_id = 13;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FASE 5: Productos y precios por sucursal
-- ═══════════════════════════════════════════════════════════════════════════════

-- 5.1 Precios por sucursal (depende de productos)
DELETE FROM productos_branch_precios WHERE tenant_id = 13;

-- 5.2 Productos
DELETE FROM productos WHERE tenant_id = 13;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FASE 6: Clientes (IMPORTANTE: Deshabilitar trigger del cliente genérico)
-- ═══════════════════════════════════════════════════════════════════════════════

-- 6.1 Deshabilitar temporalmente el trigger que impide borrar cliente genérico
DROP TRIGGER IF EXISTS trg_prevent_generic_customer_delete ON customers;

-- 6.2 Eliminar todos los clientes (incluyendo el genérico "Público en General")
DELETE FROM customers WHERE tenant_id = 13;

-- 6.3 Restaurar el trigger
CREATE TRIGGER trg_prevent_generic_customer_delete
    BEFORE DELETE ON customers
    FOR EACH ROW
    EXECUTE FUNCTION prevent_generic_customer_delete();

-- ═══════════════════════════════════════════════════════════════════════════════
-- FASE 7: Metadata y telemetría
-- ═══════════════════════════════════════════════════════════════════════════════

DELETE FROM backup_metadata WHERE tenant_id = 13;
DELETE FROM telemetry_events WHERE tenant_id = 13;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FASE 8: Sesiones y tokens de dispositivos
-- ═══════════════════════════════════════════════════════════════════════════════

DELETE FROM sessions WHERE tenant_id = 13;

-- Device tokens dependen de employees y branches, eliminar antes de employees
DELETE FROM device_tokens dt
USING employees e
WHERE dt.employee_id = e.id AND e.tenant_id = 13;

-- ═══════════════════════════════════════════════════════════════════════════════
-- FASE 9: Empleados y sus relaciones
-- ═══════════════════════════════════════════════════════════════════════════════

-- 9.1 Relación empleado-sucursal
DELETE FROM employee_branches WHERE tenant_id = 13;

-- 9.2 Empleados
DELETE FROM employees WHERE tenant_id = 13;

-- ═══════════════════════════════════════════════════════════════════════════════
-- NO ELIMINAMOS: branches y tenants (como solicitado)
-- ═══════════════════════════════════════════════════════════════════════════════

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN: Ejecutar después del script para confirmar limpieza
-- ═══════════════════════════════════════════════════════════════════════════════
/*
SELECT 'repartidor_returns' AS tabla, COUNT(*) AS registros FROM repartidor_returns WHERE tenant_id = 13
UNION ALL SELECT 'repartidor_assignments', COUNT(*) FROM repartidor_assignments WHERE tenant_id = 13
UNION ALL SELECT 'ventas', COUNT(*) FROM ventas WHERE tenant_id = 13
UNION ALL SELECT 'credit_payments', COUNT(*) FROM credit_payments WHERE tenant_id = 13
UNION ALL SELECT 'cash_cuts', COUNT(*) FROM cash_cuts WHERE tenant_id = 13
UNION ALL SELECT 'deposits', COUNT(*) FROM deposits WHERE tenant_id = 13
UNION ALL SELECT 'withdrawals', COUNT(*) FROM withdrawals WHERE tenant_id = 13
UNION ALL SELECT 'expenses', COUNT(*) FROM expenses WHERE tenant_id = 13
UNION ALL SELECT 'suspicious_weighing_logs', COUNT(*) FROM suspicious_weighing_logs WHERE tenant_id = 13
UNION ALL SELECT 'scale_disconnection_logs', COUNT(*) FROM scale_disconnection_logs WHERE tenant_id = 13
UNION ALL SELECT 'shifts', COUNT(*) FROM shifts WHERE tenant_id = 13
UNION ALL SELECT 'productos_branch_precios', COUNT(*) FROM productos_branch_precios WHERE tenant_id = 13
UNION ALL SELECT 'productos', COUNT(*) FROM productos WHERE tenant_id = 13
UNION ALL SELECT 'customers', COUNT(*) FROM customers WHERE tenant_id = 13
UNION ALL SELECT 'backup_metadata', COUNT(*) FROM backup_metadata WHERE tenant_id = 13
UNION ALL SELECT 'telemetry_events', COUNT(*) FROM telemetry_events WHERE tenant_id = 13
UNION ALL SELECT 'sessions', COUNT(*) FROM sessions WHERE tenant_id = 13
UNION ALL SELECT 'employee_branches', COUNT(*) FROM employee_branches WHERE tenant_id = 13
UNION ALL SELECT 'employees', COUNT(*) FROM employees WHERE tenant_id = 13;
*/
