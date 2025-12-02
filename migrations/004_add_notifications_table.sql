-- ═══════════════════════════════════════════════════════════════
-- Migration 004: Notifications Table
-- ═══════════════════════════════════════════════════════════════
-- Tabla para almacenar historial de notificaciones por tenant/empleado
-- Categorías: login, logout, cash_cut, credit_payment, expense, sale, etc.
-- EXCLUYE: guardian (tiene su propia página)
-- ═══════════════════════════════════════════════════════════════

-- Crear tabla de notificaciones
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    branch_id INTEGER REFERENCES branches(id),
    employee_id INTEGER REFERENCES employees(id),

    -- Categorización
    category VARCHAR(50) NOT NULL, -- 'login', 'logout', 'cash_cut', 'credit_payment', 'expense', 'sale', 'system'
    event_type VARCHAR(100) NOT NULL, -- Tipo específico del evento

    -- Contenido
    title VARCHAR(255) NOT NULL,
    body TEXT,
    data JSONB, -- Datos adicionales (IDs relacionados, montos, etc.)

    -- Estado
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    read_by_employee_id INTEGER REFERENCES employees(id),

    -- Soft delete
    is_hidden BOOLEAN DEFAULT FALSE,
    hidden_at TIMESTAMPTZ,
    hidden_by_employee_id INTEGER REFERENCES employees(id),

    -- Metadatos
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para búsquedas eficientes
CREATE INDEX IF NOT EXISTS idx_notifications_tenant ON notifications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notifications_branch ON notifications(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_notifications_employee ON notifications(tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_notifications_category ON notifications(tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(tenant_id, is_read, is_hidden) WHERE is_read = FALSE AND is_hidden = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(tenant_id, created_at DESC);

-- Comentarios de documentación
COMMENT ON TABLE notifications IS 'Historial de notificaciones por tenant/empleado. Excluye Guardian.';
COMMENT ON COLUMN notifications.category IS 'Categoría: login, logout, cash_cut, credit_payment, expense, sale, system';
COMMENT ON COLUMN notifications.event_type IS 'Tipo específico del evento (ej: cash_cut_opened, credit_payment_received)';
COMMENT ON COLUMN notifications.data IS 'Datos adicionales en formato JSON (IDs, montos, nombres, etc.)';

-- Tabla para configuración de preferencias de notificaciones por empleado
CREATE TABLE IF NOT EXISTS notification_preferences (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    employee_id INTEGER NOT NULL REFERENCES employees(id),

    -- Preferencias por categoría
    login_enabled BOOLEAN DEFAULT TRUE,
    logout_enabled BOOLEAN DEFAULT TRUE,
    cash_cut_enabled BOOLEAN DEFAULT TRUE,
    credit_payment_enabled BOOLEAN DEFAULT TRUE,
    expense_enabled BOOLEAN DEFAULT TRUE,
    sale_enabled BOOLEAN DEFAULT FALSE, -- Por defecto deshabilitado (muchas ventas)
    system_enabled BOOLEAN DEFAULT TRUE,

    -- Metadatos
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(tenant_id, employee_id)
);

COMMENT ON TABLE notification_preferences IS 'Preferencias de notificaciones por empleado';
