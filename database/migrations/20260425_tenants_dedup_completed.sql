-- ═══════════════════════════════════════════════════════════════════
-- Migration 064 (2026-04-25): tenants.products_deduplicated_at
-- ═══════════════════════════════════════════════════════════════════
-- Marca por tenant para que el wizard de limpieza de duplicados de
-- productos solo aparezca una vez. Se llena cuando el dueño completa
-- el flujo (ya sea limpiando o descartando).
-- NULL = aún no ha visto/decidido. Timestamp = ya completado.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS products_deduplicated_at TIMESTAMPTZ;
