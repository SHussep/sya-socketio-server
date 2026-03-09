-- ============================================================
-- DIAGNÓSTICO: Tenant 34, Branches 35 y 36
-- Clientes y sus asignaciones de sucursal
-- ============================================================

-- 1. Info de las sucursales
SELECT id, name, branch_code, is_active
FROM branches
WHERE tenant_id = 34
ORDER BY id;

-- 2. Todos los clientes del tenant
SELECT id, nombre, telefono, activo, created_at
FROM customers
WHERE tenant_id = 34
ORDER BY nombre;

-- 3. Asignaciones cliente-sucursal (todas, activas e inactivas)
SELECT
    cb.id as assignment_id,
    cb.customer_id,
    c.nombre as cliente_nombre,
    cb.branch_id,
    b.name as branch_name,
    cb.is_active,
    cb.assigned_at,
    cb.removed_at
FROM cliente_branches cb
JOIN customers c ON c.id = cb.customer_id
JOIN branches b ON b.id = cb.branch_id
WHERE cb.tenant_id = 34
ORDER BY c.nombre, b.name;

-- 4. Resumen: cuántos clientes por sucursal (solo activos)
SELECT
    b.id as branch_id,
    b.name as branch_name,
    COUNT(cb.id) as clientes_asignados
FROM branches b
LEFT JOIN cliente_branches cb ON cb.branch_id = b.id AND cb.is_active = true AND cb.tenant_id = 34
WHERE b.tenant_id = 34
GROUP BY b.id, b.name
ORDER BY b.id;

-- 5. Clientes SIN asignación a ninguna sucursal
SELECT c.id, c.nombre, c.telefono
FROM customers c
WHERE c.tenant_id = 34 AND c.activo = true
AND NOT EXISTS (
    SELECT 1 FROM cliente_branches cb
    WHERE cb.customer_id = c.id AND cb.is_active = true
)
ORDER BY c.nombre;

-- ============================================================
-- EMPLEADOS (para comparar)
-- ============================================================

-- 6. Todos los empleados del tenant
SELECT id, first_name, last_name, is_active
FROM employees
WHERE tenant_id = 34
ORDER BY first_name;

-- 7. Asignaciones empleado-sucursal
SELECT
    eb.id as assignment_id,
    eb.employee_id,
    e.first_name || ' ' || COALESCE(e.last_name, '') as empleado,
    eb.branch_id,
    b.name as branch_name,
    (eb.removed_at IS NULL) as is_active,
    eb.assigned_at,
    eb.removed_at
FROM employee_branches eb
JOIN employees e ON e.id = eb.employee_id
JOIN branches b ON b.id = eb.branch_id
WHERE e.tenant_id = 34
ORDER BY e.first_name, b.name;

-- 8. Resumen empleados por sucursal
SELECT
    b.id as branch_id,
    b.name as branch_name,
    COUNT(eb.id) as empleados_asignados
FROM branches b
LEFT JOIN employee_branches eb ON eb.branch_id = b.id AND eb.removed_at IS NULL
LEFT JOIN employees e ON e.id = eb.employee_id AND e.tenant_id = 34
WHERE b.tenant_id = 34
GROUP BY b.id, b.name
ORDER BY b.id;
