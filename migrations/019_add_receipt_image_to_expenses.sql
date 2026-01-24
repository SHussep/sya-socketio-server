-- ═══════════════════════════════════════════════════════════════
-- Migración: Agregar campo receipt_image a expenses
-- Permite guardar foto del recibo/comprobante de gasto
-- Almacenado como Base64 comprimido (JPEG ~100-300KB)
-- ═══════════════════════════════════════════════════════════════

-- Agregar columna para imagen del recibo (Base64)
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS receipt_image TEXT;

-- Comentario descriptivo
COMMENT ON COLUMN expenses.receipt_image IS 'Imagen del recibo en Base64 (JPEG comprimido). Max recomendado: 500KB';

-- Índice parcial para gastos que tienen imagen (para queries de auditoría)
CREATE INDEX IF NOT EXISTS idx_expenses_has_receipt
ON expenses(id)
WHERE receipt_image IS NOT NULL;

-- Log
DO $$
BEGIN
    RAISE NOTICE '✅ Campo receipt_image agregado a expenses';
END $$;
