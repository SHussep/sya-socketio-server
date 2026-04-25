-- ═══════════════════════════════════════════════════════════════════
-- Migration 062 (2026-04-25): Reparar branch_licenses activas sin expires_at
-- ═══════════════════════════════════════════════════════════════════
-- Bug: cuando se crea una branch adicional para un tenant existente
-- (POST /api/branches), el endpoint activaba una licencia 'available'
-- (cupo del superadmin) sin setear expires_at. Resultado: licencia
-- 'active' con branch_id asignada pero sin fecha → desktop la veía
-- como "perpetua sin trial" y mostraba "Tu licencia expiró el N/A".
--
-- Diferencia con migración 061: 061 filtró granted_by='system' (signups).
-- Esta migración 062 captura las activadas via branches.js que tienen
-- granted_by='superadmin' (cupo creado por superadmin).
--
-- Filtros: solo licencias activas Y asignadas a branch (branch_id NOT NULL),
-- para no tocar licencias 'available' o 'revoked' que pueden estar sin
-- fecha intencionalmente.
-- ═══════════════════════════════════════════════════════════════════

UPDATE branch_licenses bl
SET expires_at = t.trial_ends_at,
    duration_days = COALESCE(bl.duration_days, 30),
    notes = COALESCE(bl.notes, '') || ' [migración 062: expires_at heredado de tenant.trial_ends_at]',
    updated_at = NOW()
FROM tenants t
WHERE bl.tenant_id = t.id
  AND bl.status = 'active'
  AND bl.branch_id IS NOT NULL
  AND bl.expires_at IS NULL
  AND t.trial_ends_at IS NOT NULL;

-- Reporte
DO $$
DECLARE
    fixed_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO fixed_count
    FROM branch_licenses
    WHERE notes LIKE '%migración 062%';
    RAISE NOTICE '[Migration 062] % branch_licenses activas con expires_at backfilled', fixed_count;
END $$;
