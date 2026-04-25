-- ═══════════════════════════════════════════════════════════════════
-- Migration 061 (2026-04-25): Reparar branch_licenses con expires_at NULL
-- ═══════════════════════════════════════════════════════════════════
-- Bug: los flujos de signup (register clásico, Google, Apple) creaban la
-- licencia inicial con granted_by='system' pero SIN expires_at. Resultado:
-- el desktop la veía como "perpetua + isTrial=true" y mostraba el error
-- "Tu licencia expiró el N/A" porque combinaba los dos campos como
-- "expirada sin fecha".
--
-- Fix retroactivo: para licencias activas con granted_by='system' y
-- expires_at NULL, copiar tenant.trial_ends_at como expires_at. Esto
-- repara tenants creados desde el deploy de migración 059 hasta este.
-- ═══════════════════════════════════════════════════════════════════

UPDATE branch_licenses bl
SET expires_at = t.trial_ends_at,
    duration_days = COALESCE(bl.duration_days, 30),
    notes = COALESCE(bl.notes, '') || ' [migración 061: expires_at backfilled from tenant.trial_ends_at]',
    updated_at = NOW()
FROM tenants t
WHERE bl.tenant_id = t.id
  AND bl.status = 'active'
  AND bl.granted_by = 'system'
  AND bl.expires_at IS NULL
  AND t.trial_ends_at IS NOT NULL;

-- Reporte
DO $$
DECLARE
    fixed_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO fixed_count
    FROM branch_licenses
    WHERE notes LIKE '%migración 061%';
    RAISE NOTICE '[Migration 061] % branch_licenses con expires_at backfilled', fixed_count;
END $$;
