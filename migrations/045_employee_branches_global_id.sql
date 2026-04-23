-- Migration 045: Add global_id to employee_branches for offline-first idempotency.
--
-- Problema: employee_branches usaba UNIQUE(tenant_id, employee_id, branch_id) como
-- llave natural para deduplicar. Funcionaba para casos normales pero fallaba en:
--   1. Soft-delete + reactivate: el desktop podía crear filas duplicadas.
--   2. Recuperación tras pérdida local: sin UUID no había forma de matchear la
--      fila re-creada con el registro PG original.
--   3. Cross-device dedup: dos desktops offline creando la misma asignación
--      terminaban con Id local diferente sin forma de reconciliar sin depender
--      solo de la llave natural.
--
-- Solución: agregar global_id UUID UNIQUE. El cliente (desktop) genera el UUID
-- al crear la fila local. El push envía globalId. El server resuelve primero
-- por global_id; fallback a llave natural para registros pre-existentes.
--
-- Backfill: filas existentes reciben un UUID nuevo (no hay forma de recuperar
-- el UUID "original" si nunca existió).

ALTER TABLE employee_branches
    ADD COLUMN IF NOT EXISTS global_id UUID;

-- Backfill rows sin global_id.
UPDATE employee_branches SET global_id = gen_random_uuid() WHERE global_id IS NULL;

-- Enforce NOT NULL y UNIQUE después del backfill.
ALTER TABLE employee_branches ALTER COLUMN global_id SET NOT NULL;

-- DEFAULT gen_random_uuid() como safety net: cualquier INSERT (legacy o nuevo)
-- que no provea global_id recibe uno válido automáticamente. Evita violaciones
-- de NOT NULL en paths server-side que aún no fueron migrados para pasarlo
-- explícitamente (ej. googleSignup, joinBranch, etc).
ALTER TABLE employee_branches ALTER COLUMN global_id SET DEFAULT gen_random_uuid();

-- UNIQUE constraint + index (IF NOT EXISTS-safe pattern).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'employee_branches_global_id_key'
    ) THEN
        ALTER TABLE employee_branches ADD CONSTRAINT employee_branches_global_id_key UNIQUE (global_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employee_branches_global_id ON employee_branches(global_id);
