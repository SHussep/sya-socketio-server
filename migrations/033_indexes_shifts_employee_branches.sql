-- Migration 033: Indexes para shifts y employee_branches
-- Mejora rendimiento en consultas frecuentes (login, apertura de turno, asignaciones)

-- shifts: consultas por tenant, sucursal, empleado
CREATE INDEX IF NOT EXISTS idx_shifts_tenant_id ON shifts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_shifts_branch_id ON shifts(branch_id);
CREATE INDEX IF NOT EXISTS idx_shifts_employee_id ON shifts(employee_id);

-- shifts: partial index para turnos activos (CheckActiveShiftAsync)
CREATE INDEX IF NOT EXISTS idx_shifts_employee_active ON shifts(employee_id, end_time) WHERE end_time IS NULL;

-- employee_branches: consultas por empleado, sucursal, tenant
CREATE INDEX IF NOT EXISTS idx_employee_branches_employee_id ON employee_branches(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_branches_branch_id ON employee_branches(branch_id);
CREATE INDEX IF NOT EXISTS idx_employee_branches_tenant_id ON employee_branches(tenant_id);
