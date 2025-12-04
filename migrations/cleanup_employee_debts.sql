-- ═══════════════════════════════════════════════════════════════════════════════
-- SCRIPT: Limpieza de datos corruptos en employee_debts
-- Fecha: 2025-01-04
-- Propósito: Corregir registros con monto_deuda negativo o cero
-- ═══════════════════════════════════════════════════════════════════════════════

-- PASO 1: Identificar registros problemáticos
-- ═══════════════════════════════════════════════════════════════════════════════

-- Registros con monto_deuda <= 0 (datos corruptos)
SELECT
    id,
    global_id,
    employee_id,
    monto_deuda,
    monto_pagado,
    estado,
    fecha_deuda,
    notas,
    created_at
FROM employee_debts
WHERE monto_deuda <= 0
ORDER BY fecha_deuda DESC;

-- Estadísticas
SELECT
    CASE
        WHEN monto_deuda < 0 THEN 'NEGATIVO'
        WHEN monto_deuda = 0 THEN 'CERO'
        WHEN monto_deuda > 0 THEN 'POSITIVO (correcto)'
    END as tipo,
    COUNT(*) as cantidad,
    SUM(monto_deuda) as suma_total,
    AVG(monto_deuda) as promedio
FROM employee_debts
GROUP BY
    CASE
        WHEN monto_deuda < 0 THEN 'NEGATIVO'
        WHEN monto_deuda = 0 THEN 'CERO'
        WHEN monto_deuda > 0 THEN 'POSITIVO (correcto)'
    END
ORDER BY cantidad DESC;

-- PASO 2: OPCIÓN A - Eliminar registros con monto_deuda <= 0
-- ═══════════════════════════════════════════════════════════════════════════════
-- ⚠️ DESCOMENTAR SOLO SI QUIERES ELIMINAR ESTOS REGISTROS

-- BEGIN;
--
-- -- Backup antes de eliminar (opcional)
-- CREATE TEMP TABLE employee_debts_backup_negativos AS
-- SELECT * FROM employee_debts WHERE monto_deuda <= 0;
--
-- -- Eliminar registros corruptos
-- DELETE FROM employee_debts WHERE monto_deuda <= 0;
--
-- -- Verificar resultado
-- SELECT 'Registros eliminados: ' || COUNT(*) as resultado
-- FROM employee_debts_backup_negativos;
--
-- COMMIT;


-- PASO 3: OPCIÓN B - Convertir valores negativos a positivos (Math.Abs)
-- ═══════════════════════════════════════════════════════════════════════════════
-- ⚠️ DESCOMENTAR SOLO SI QUIERES CORREGIR EN LUGAR DE ELIMINAR

-- BEGIN;
--
-- -- Convertir negativos a positivos y eliminar ceros
-- UPDATE employee_debts
-- SET monto_deuda = ABS(monto_deuda),
--     notas = COALESCE(notas, '') || ' [CORREGIDO: valor era negativo]',
--     updated_at = NOW()
-- WHERE monto_deuda < 0;
--
-- -- Eliminar registros con monto_deuda = 0 (no tiene sentido tener una deuda de $0)
-- DELETE FROM employee_debts WHERE monto_deuda = 0;
--
-- -- Verificar resultado
-- SELECT
--     'Total registros después de corrección: ' || COUNT(*) as resultado,
--     'Suma total: $' || SUM(monto_deuda)::text as suma,
--     'Registros negativos restantes: ' || SUM(CASE WHEN monto_deuda < 0 THEN 1 ELSE 0 END)::text as negativos
-- FROM employee_debts;
--
-- COMMIT;


-- PASO 4: Validación final
-- ═══════════════════════════════════════════════════════════════════════════════

-- Verificar que no queden registros problemáticos
SELECT
    COUNT(*) as total_registros,
    COUNT(CASE WHEN monto_deuda <= 0 THEN 1 END) as registros_invalidos,
    COUNT(CASE WHEN monto_deuda > 0 THEN 1 END) as registros_validos,
    SUM(CASE WHEN monto_deuda > 0 THEN monto_deuda ELSE 0 END) as suma_faltantes_validos
FROM employee_debts;

-- Listar todos los empleados con faltantes pendientes (valores positivos)
SELECT
    ed.employee_id,
    CONCAT(e.first_name, ' ', e.last_name) as empleado,
    COUNT(*) as num_deudas,
    SUM(CASE WHEN ed.monto_deuda > 0 THEN ed.monto_deuda ELSE 0 END) as total_deuda,
    SUM(ed.monto_pagado) as total_pagado,
    SUM(CASE WHEN ed.monto_deuda > 0 THEN (ed.monto_deuda - COALESCE(ed.monto_pagado, 0)) ELSE 0 END) as pendiente
FROM employee_debts ed
LEFT JOIN employees e ON e.id = ed.employee_id
WHERE ed.monto_deuda > 0
GROUP BY ed.employee_id, e.first_name, e.last_name
HAVING SUM(CASE WHEN ed.monto_deuda > 0 THEN (ed.monto_deuda - COALESCE(ed.monto_pagado, 0)) ELSE 0 END) > 0
ORDER BY pendiente DESC;


-- ═══════════════════════════════════════════════════════════════════════════════
-- NOTAS IMPORTANTES:
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 1. CONCEPTUALMENTE:
--    - Un faltante (employee_debt) DEBE ser SIEMPRE positivo
--    - Se crea cuando CashDrawerSession.Difference < 0 (falta dinero)
--    - Desktop hace MontoDeuda = Math.Abs(difference)
--    - Si hay valores negativos en la BD, son datos CORRUPTOS
--
-- 2. OPCIONES DE LIMPIEZA:
--    - OPCIÓN A: Eliminar registros con monto_deuda <= 0 (más seguro)
--    - OPCIÓN B: Convertir negativos a positivos con ABS() (si quieres conservar datos)
--
-- 3. RECOMENDACIÓN:
--    - Primero ejecuta solo el PASO 1 para ver cuántos registros hay
--    - Decide si eliminar o corregir
--    - Luego descomenta OPCIÓN A o OPCIÓN B según tu decisión
--
-- 4. PREVENCIÓN FUTURA:
--    - Desktop ya tiene validación (solo crea cuando difference < 0)
--    - Backend ahora filtra (WHERE monto_deuda > 0)
--    - Considera agregar CHECK constraint en PostgreSQL:
--      ALTER TABLE employee_debts ADD CONSTRAINT check_monto_deuda_positive
--      CHECK (monto_deuda > 0);
--
-- ═══════════════════════════════════════════════════════════════════════════════
