-- ═══════════════════════════════════════════════════════════════════
-- Migration 059 (2026-04-25): Per-branch license expiry
-- ═══════════════════════════════════════════════════════════════════
-- Each branch_license can now have its own expires_at, enabling
-- independent renewal cycles per sucursal.
--
-- Convivencia: tenant.trial_ends_at sigue siendo el gate mientras
-- subscription_status='trial'. Una vez promovido a 'active',
-- branch_licenses.expires_at toma autoridad por-branch.
--
-- No backfill: tenants existentes (todos en 'trial') siguen sin cambios.
-- SuperAdmin promueve manualmente vía /tenants/:id/promote-to-active.
-- ═══════════════════════════════════════════════════════════════════

-- Columnas nuevas (idempotentes)
ALTER TABLE branch_licenses
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NULL,
    ADD COLUMN IF NOT EXISTS duration_days INTEGER NULL,
    ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP NULL,
    ADD COLUMN IF NOT EXISTS last_days_notified INTEGER NULL,
    ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMP NULL,
    ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT false;

-- Comentarios (documentación inline)
COMMENT ON COLUMN branch_licenses.expires_at IS
    'Fecha de expiración de la licencia. NULL = perpetua (caso enterprise/comp). Solo aplica cuando tenant.subscription_status=''active''.';
COMMENT ON COLUMN branch_licenses.duration_days IS
    'Duración del plan vendido en días (365=anual, 30=mensual). Sirve para auditoría y cálculo de presets de renovación.';
COMMENT ON COLUMN branch_licenses.assigned_at IS
    'Momento en que el superadmin asignó esta licencia a una branch (status: available -> active).';
COMMENT ON COLUMN branch_licenses.last_days_notified IS
    'Último checkpoint de días notificado por el job (14|7|3|1|0|-3). Dedup por-licencia.';
COMMENT ON COLUMN branch_licenses.auto_renew IS
    'Reservado para v1.4: pago integrado (Stripe/MercadoPago) que renueve automáticamente.';

-- Índices
CREATE INDEX IF NOT EXISTS idx_branch_licenses_expiring
    ON branch_licenses(expires_at)
    WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_branch_licenses_lookup
    ON branch_licenses(tenant_id, branch_id, status);

-- ═══════════════════════════════════════════════════════════════════
-- Tabla de auditoría: histórico completo de cambios por licencia
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS branch_license_history (
    id SERIAL PRIMARY KEY,
    license_id INTEGER NOT NULL REFERENCES branch_licenses(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
        -- 'assigned' | 'renewed' | 'extended' | 'unassigned'
        -- 'revoked' | 'restored' | 'expired_auto'
    old_branch_id INTEGER NULL,
    new_branch_id INTEGER NULL,
    old_expires_at TIMESTAMP NULL,
    new_expires_at TIMESTAMP NULL,
    old_status VARCHAR(20) NULL,
    new_status VARCHAR(20) NULL,
    notes TEXT,
    performed_by VARCHAR(100) DEFAULT 'superadmin',
    performed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branch_license_history_license
    ON branch_license_history(license_id, performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_branch_license_history_action
    ON branch_license_history(action, performed_at DESC);
