-- =====================================================
-- Migration: 043_ensure_local_shift_id_in_sales.sql
-- Descripción: Asegurar que local_shift_id existe en sales
-- =====================================================
-- La migración 004 debería haber agregado esta columna,
-- pero parece que no se ejecutó correctamente.
-- Esta migración la agrega de forma segura si no existe.
-- =====================================================

-- Agregar local_shift_id a sales si no existe
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'sales'
    AND column_name = 'local_shift_id'
  ) THEN
    ALTER TABLE sales ADD COLUMN local_shift_id INT;
    COMMENT ON COLUMN sales.local_shift_id IS 'Local shift ID from Desktop app - tracks which local shift this sale belongs to';

    -- Crear índice si no existe
    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE tablename = 'sales'
      AND indexname = 'idx_sales_local_shift_id'
    ) THEN
      CREATE INDEX idx_sales_local_shift_id ON sales(local_shift_id);
    END IF;

    RAISE NOTICE 'Column local_shift_id added to sales table';
  ELSE
    RAISE NOTICE 'Column local_shift_id already exists in sales table';
  END IF;
END $$;
