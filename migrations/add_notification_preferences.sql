-- ═══════════════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN: Agregar tabla de preferencias de notificaciones
-- Fecha: 2024-12-08
-- Descripción: Permite a cada empleado configurar qué notificaciones push desea recibir
-- ═══════════════════════════════════════════════════════════════════════════════════════

-- Crear tabla de preferencias de notificaciones
CREATE TABLE IF NOT EXISTS notification_preferences (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- Caja y Turnos
    notify_login BOOLEAN DEFAULT true,           -- Inicios de sesión
    notify_shift_start BOOLEAN DEFAULT true,     -- Inicio de turno
    notify_shift_end BOOLEAN DEFAULT true,       -- Corte de caja

    -- Gastos
    notify_expense_created BOOLEAN DEFAULT true, -- Gastos registrados

    -- Repartidores
    notify_assignment_created BOOLEAN DEFAULT true, -- Asignaciones de producto

    -- Guardian de Báscula
    notify_guardian_peso_no_registrado BOOLEAN DEFAULT true,      -- Peso no registrado
    notify_guardian_operacion_irregular BOOLEAN DEFAULT true,     -- Operación irregular
    notify_guardian_discrepancia BOOLEAN DEFAULT true,            -- Discrepancia de peso

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Constraint único por empleado
    UNIQUE(tenant_id, employee_id)
);

-- Índice para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_notification_preferences_employee
ON notification_preferences(employee_id);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_tenant
ON notification_preferences(tenant_id);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_notification_preferences_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para updated_at
DROP TRIGGER IF EXISTS trigger_notification_preferences_updated_at ON notification_preferences;
CREATE TRIGGER trigger_notification_preferences_updated_at
    BEFORE UPDATE ON notification_preferences
    FOR EACH ROW
    EXECUTE FUNCTION update_notification_preferences_updated_at();

-- Comentarios de documentación
COMMENT ON TABLE notification_preferences IS 'Preferencias de notificaciones push por empleado';
COMMENT ON COLUMN notification_preferences.notify_login IS 'Notificar inicios de sesión de empleados';
COMMENT ON COLUMN notification_preferences.notify_shift_start IS 'Notificar cuando un empleado abre caja';
COMMENT ON COLUMN notification_preferences.notify_shift_end IS 'Notificar cortes de caja (incluye sobrante/faltante)';
COMMENT ON COLUMN notification_preferences.notify_expense_created IS 'Notificar gastos registrados desde app móvil';
COMMENT ON COLUMN notification_preferences.notify_assignment_created IS 'Notificar asignaciones de producto a repartidores';
COMMENT ON COLUMN notification_preferences.notify_guardian_peso_no_registrado IS 'Notificar alertas de peso no registrado (posible robo)';
COMMENT ON COLUMN notification_preferences.notify_guardian_operacion_irregular IS 'Notificar operaciones irregulares (desconexiones, cancelaciones)';
COMMENT ON COLUMN notification_preferences.notify_guardian_discrepancia IS 'Notificar discrepancias de peso';

SELECT 'Migración notification_preferences completada' AS status;
