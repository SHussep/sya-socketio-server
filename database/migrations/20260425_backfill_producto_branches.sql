-- ═══════════════════════════════════════════════════════════════════
-- Migration 063 (2026-04-25): Backfill producto_branches para tenants legacy
-- ═══════════════════════════════════════════════════════════════════
-- BUG CRÍTICO REPORTADO: 15+ usuarios actualizaron a v1.3.x y "sus
-- productos desaparecieron". Causa raíz: el commit f2a4cbc del desktop
-- introdujo "regla: sucursal solo ve productos con ProductoBranch
-- explícito". Tenants creados antes de esa regla no tenían producto_branches
-- entries → todos los productos quedan filtrados (invisibles) tras update.
--
-- Fix: crear producto_branches para CADA combinación (tenant, branch, producto)
-- que falte. Inventario inicial = producto.inventario (porque ANTES el stock
-- vivía en la tabla base, no per-branch — preservar el valor que el usuario veía).
--
-- Idempotente: NOT EXISTS evita duplicar.
-- Solo afecta combinaciones faltantes — no toca producto_branches existentes
-- (precios/stock que el usuario ya configuró por sucursal).
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO producto_branches (
    tenant_id, branch_id, product_global_id,
    precio_venta, precio_compra, inventario, minimo,
    is_active, global_id, created_at, updated_at
)
SELECT
    p.tenant_id,
    b.id,
    p.global_id::uuid,
    COALESCE(p.precio_venta, 0),
    COALESCE(p.precio_compra, 0),
    COALESCE(p.inventario, 0),  -- preservar inventario base (era el stock visible antes)
    COALESCE(p.minimo, 0),
    true,
    gen_random_uuid(),
    NOW(),
    NOW()
FROM productos p
JOIN branches b ON b.tenant_id = p.tenant_id AND b.is_active = true
WHERE p.eliminado = false
  AND p.global_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM producto_branches pb
      WHERE pb.tenant_id = p.tenant_id
        AND pb.branch_id = b.id
        AND pb.product_global_id = p.global_id::uuid
  );

-- Reporte
DO $$
DECLARE
    backfilled INTEGER;
    affected_tenants INTEGER;
    affected_branches INTEGER;
BEGIN
    SELECT COUNT(*) INTO backfilled
    FROM producto_branches
    WHERE created_at >= NOW() - INTERVAL '1 minute';

    SELECT COUNT(DISTINCT tenant_id) INTO affected_tenants
    FROM producto_branches
    WHERE created_at >= NOW() - INTERVAL '1 minute';

    SELECT COUNT(DISTINCT branch_id) INTO affected_branches
    FROM producto_branches
    WHERE created_at >= NOW() - INTERVAL '1 minute';

    RAISE NOTICE '[Migration 063] % producto_branches creados (% tenants, % branches afectados)',
        backfilled, affected_tenants, affected_branches;
END $$;
