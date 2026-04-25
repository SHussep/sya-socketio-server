-- ═══════════════════════════════════════════════════════════════════
-- Migration 060 (2026-04-25): Backfill branch_licenses para tenants existentes
-- ═══════════════════════════════════════════════════════════════════
-- Modelo simplificado: cada sucursal tiene su propio branch_license
-- independiente. SIN switch global tenant.subscription_status.
--
-- Para no romper a clientes existentes, copiamos tenant.trial_ends_at
-- a CADA branch activa que aún no tenga una branch_license activa.
-- Tras este backfill el desktop sigue viendo exactamente la misma
-- fecha que antes; superadmin puede después diferenciar fechas por
-- sucursal desde SYAAdmin.
--
-- Idempotente: NOT EXISTS evita duplicar si ya existe row activa.
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO branch_licenses (
    tenant_id, branch_id, status, expires_at, granted_by, notes,
    assigned_at, activated_at, granted_at, created_at, updated_at
)
SELECT
    b.tenant_id,
    b.id,
    'active',
    t.trial_ends_at,
    'system',
    'Backfill migración 060: heredado de tenant.trial_ends_at para preservar acceso',
    NOW(), NOW(), NOW(), NOW(), NOW()
FROM branches b
JOIN tenants t ON t.id = b.tenant_id
WHERE b.is_active = true
  AND t.is_active = true
  AND t.trial_ends_at IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM branch_licenses bl
      WHERE bl.branch_id = b.id
        AND bl.status = 'active'
  );

-- Reporte de cuántas filas se crearon (visible en logs de Render):
DO $$
DECLARE
    backfilled_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO backfilled_count
    FROM branch_licenses
    WHERE notes LIKE 'Backfill migración 060%';
    RAISE NOTICE '[Migration 060] % branches con licencia heredada del tenant', backfilled_count;
END $$;
