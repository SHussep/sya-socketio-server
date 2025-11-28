// ═══════════════════════════════════════════════════════════════
// EMPLOYEE BRANCHES ROUTES - Handle many-to-many employee-branch relationships
// ═══════════════════════════════════════════════════════════════

const express = require('express');

module.exports = (pool) => {
    const router = express.Router();

    // POST /api/employee-branches - Sync employee branch assignment from Desktop
    // Creates or updates the relationship between an employee and a branch
    router.post('/', async (req, res) => {
        const client = await pool.connect();
        try {
            const {
                tenantId,
                employeeId,
                branchId,
                isActive = true
            } = req.body;

            console.log(`[EmployeeBranches/Sync] 🔄 Sincronizando: Empleado ${employeeId} → Sucursal ${branchId} (Tenant: ${tenantId})`);

            // Validate required fields
            if (!tenantId || !employeeId || !branchId) {
                console.log(`[EmployeeBranches/Sync] ❌ Datos incompletos`);
                return res.status(400).json({
                    success: false,
                    message: 'Faltan campos requeridos: tenantId, employeeId, branchId'
                });
            }

            // Verify employee exists
            const empCheck = await client.query(
                `SELECT id FROM employees WHERE id = $1 AND tenant_id = $2`,
                [employeeId, tenantId]
            );

            if (empCheck.rows.length === 0) {
                console.log(`[EmployeeBranches/Sync] ❌ Empleado no encontrado: ${employeeId}`);
                return res.status(404).json({
                    success: false,
                    message: 'El empleado no existe'
                });
            }

            // Verify branch exists
            const branchCheck = await client.query(
                `SELECT id FROM branches WHERE id = $1 AND tenant_id = $2`,
                [branchId, tenantId]
            );

            if (branchCheck.rows.length === 0) {
                console.log(`[EmployeeBranches/Sync] ❌ Sucursal no encontrada: ${branchId}`);
                return res.status(404).json({
                    success: false,
                    message: 'La sucursal no existe'
                });
            }

            // Check if relationship already exists
            const existingResult = await client.query(
                `SELECT id FROM employee_branches
                 WHERE tenant_id = $1 AND employee_id = $2 AND branch_id = $3`,
                [tenantId, employeeId, branchId]
            );

            if (existingResult.rows.length > 0) {
                // Update existing relationship
                const existingId = existingResult.rows[0].id;
                console.log(`[EmployeeBranches/Sync] ⚠️ Relación ya existe (ID: ${existingId}), actualizando...`);

                const updateResult = await client.query(
                    `UPDATE employee_branches
                     SET removed_at = CASE WHEN $1 = false THEN NOW() ELSE NULL END,
                         updated_at = NOW()
                     WHERE id = $2
                     RETURNING id, tenant_id, employee_id, branch_id, assigned_at, removed_at, updated_at`,
                    [isActive, existingId]
                );

                if (updateResult.rows.length > 0) {
                    const relationship = updateResult.rows[0];
                    console.log(`[EmployeeBranches/Sync] ✅ Relación actualizada: Empleado ${employeeId} en Sucursal ${branchId}`);

                    return res.json({
                        success: true,
                        data: relationship,
                        id: relationship.id,
                        remoteId: relationship.id
                    });
                }
            }

            // Create new relationship
            console.log(`[EmployeeBranches/Sync] 📝 Creando nueva relación: Empleado ${employeeId} → Sucursal ${branchId}`);

            const insertResult = await client.query(
                `INSERT INTO employee_branches
                 (tenant_id, employee_id, branch_id, assigned_at, removed_at, updated_at)
                 VALUES ($1, $2, $3, NOW(), CASE WHEN $4 = false THEN NOW() ELSE NULL END, NOW())
                 RETURNING id, tenant_id, employee_id, branch_id, assigned_at, removed_at, updated_at`,
                [tenantId, employeeId, branchId, isActive]
            );

            if (insertResult.rows.length > 0) {
                const relationship = insertResult.rows[0];
                console.log(`[EmployeeBranches/Sync] ✅ Relación creada: Empleado ${employeeId} en Sucursal ${branchId} (ID: ${relationship.id})`);

                return res.json({
                    success: true,
                    data: relationship,
                    id: relationship.id,
                    remoteId: relationship.id
                });
            }

            console.log(`[EmployeeBranches/Sync] ❌ Error: No se insertó relación`);
            res.status(500).json({
                success: false,
                message: 'No se pudo crear la relación'
            });

        } catch (error) {
            console.error(`[EmployeeBranches/Sync] ❌ Error:`, error.message);
            console.error(`[EmployeeBranches/Sync] Stack:`, error.stack);

            res.status(500).json({
                success: false,
                message: 'Error al sincronizar relación empleado-sucursal',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // GET /api/employee-branches - Get all branches for an employee
    router.get('/', async (req, res) => {
        try {
            const { tenantId, employeeId } = req.query;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenantId'
                });
            }

            let query = `
                SELECT eb.id, eb.tenant_id, eb.employee_id, eb.branch_id,
                       eb.assigned_at, eb.removed_at, eb.updated_at,
                       (eb.removed_at IS NULL) as is_active,
                       b.name as branch_name, b.branch_code as branch_code
                FROM employee_branches eb
                JOIN branches b ON b.id = eb.branch_id
                WHERE eb.tenant_id = $1
            `;
            const params = [tenantId];

            if (employeeId) {
                query += ` AND eb.employee_id = $2`;
                params.push(employeeId);
            }

            query += ` ORDER BY b.name ASC`;

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });

        } catch (error) {
            console.error('[EmployeeBranches] Error en GET:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener asignaciones de sucursales'
            });
        }
    });

    // DELETE /api/employee-branches/:id - Remove employee from a branch
    router.delete('/:id', async (req, res) => {
        const client = await pool.connect();
        try {
            const relationshipId = req.params.id;
            const { tenantId } = req.body;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenantId'
                });
            }

            console.log(`[EmployeeBranches/Delete] 🔄 Eliminando relación ${relationshipId}`);

            // Get relationship info before deletion
            const getResult = await client.query(
                `SELECT employee_id, branch_id FROM employee_branches WHERE id = $1 AND tenant_id = $2`,
                [relationshipId, tenantId]
            );

            if (getResult.rows.length === 0) {
                console.log(`[EmployeeBranches/Delete] ❌ Relación no encontrada: ${relationshipId}`);
                return res.status(404).json({
                    success: false,
                    message: 'Relación no encontrada'
                });
            }

            const { employee_id, branch_id } = getResult.rows[0];

            // Soft delete - mark as inactive
            const deleteResult = await client.query(
                `UPDATE employee_branches
                 SET removed_at = NOW(),
                     updated_at = NOW()
                 WHERE id = $1 AND tenant_id = $2
                 RETURNING id, employee_id, branch_id`,
                [relationshipId, tenantId]
            );

            if (deleteResult.rows.length > 0) {
                console.log(`[EmployeeBranches/Delete] ✅ Empleado ${employee_id} removido de Sucursal ${branch_id}`);
                return res.json({
                    success: true,
                    message: 'Empleado removido de la sucursal',
                    data: deleteResult.rows[0]
                });
            }

            console.log(`[EmployeeBranches/Delete] ❌ Error: No se actualizó relación`);
            res.status(500).json({
                success: false,
                message: 'No se pudo remover el empleado'
            });

        } catch (error) {
            console.error(`[EmployeeBranches/Delete] ❌ Error:`, error.message);
            res.status(500).json({
                success: false,
                message: 'Error al remover empleado de sucursal',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    return router;
};
