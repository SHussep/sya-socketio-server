// ═══════════════════════════════════════════════════════════════
// EMPLOYEES ROUTES - Handle employee synchronization from Desktop
// ═══════════════════════════════════════════════════════════════

const express = require('express');

module.exports = (pool) => {
    const router = express.Router();

    // POST /api/employees - Sync employee from Desktop app
    // Accepts the payload from WinUI and saves to PostgreSQL
    router.post('/', async (req, res) => {
        const client = await pool.connect();
        try {
            const {
                tenantId,
                branchId,
                fullName,
                username,
                email,
                roleId,
                isActive,
                isOwner,
                mainBranchId,
                googleUserIdentifier
            } = req.body;

            console.log(`[Employees/Sync] 🔄 Sincronizando empleado: ${fullName} (${username}) - Tenant: ${tenantId}, Branch: ${branchId}`);

            // Validate required fields
            if (!tenantId || !fullName || !username || !email) {
                console.log(`[Employees/Sync] ❌ Datos incompletos`);
                return res.status(400).json({
                    success: false,
                    message: 'Faltan campos requeridos: tenantId, fullName, username, email'
                });
            }

            // Check if employee already exists by email or username
            const existingResult = await client.query(
                `SELECT id FROM employees WHERE
                 (LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2))
                 AND tenant_id = $3`,
                [email, username, tenantId]
            );

            if (existingResult.rows.length > 0) {
                // Update existing employee
                const existingId = existingResult.rows[0].id;
                console.log(`[Employees/Sync] ⚠️ Empleado ya existe (ID: ${existingId}), actualizando...`);

                const updateResult = await client.query(
                    `UPDATE employees
                     SET full_name = $1,
                         main_branch_id = COALESCE($2, main_branch_id),
                         is_active = COALESCE($3, is_active),
                         updated_at = NOW()
                     WHERE id = $4 AND tenant_id = $5
                     RETURNING *`,
                    [
                        fullName,
                        branchId || mainBranchId,
                        isActive !== false,
                        existingId,
                        tenantId
                    ]
                );

                if (updateResult.rows.length > 0) {
                    const employee = updateResult.rows[0];
                    console.log(`[Employees/Sync] ✅ Empleado actualizado: ${fullName} (ID: ${employee.id})`);

                    return res.json({
                        success: true,
                        data: employee,
                        id: employee.id,
                        employeeId: employee.id,
                        remoteId: employee.id
                    });
                }
            }

            // Create new employee
            console.log(`[Employees/Sync] 📝 Creando nuevo empleado: ${fullName}`);

            const insertResult = await client.query(
                `INSERT INTO employees
                 (tenant_id, full_name, username, email, main_branch_id, is_active, updated_at, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                 RETURNING id, tenant_id, full_name, username, email, main_branch_id, is_active, created_at, updated_at`,
                [
                    tenantId,
                    fullName,
                    username,
                    email,
                    branchId || mainBranchId,
                    isActive !== false
                ]
            );

            if (insertResult.rows.length > 0) {
                const employee = insertResult.rows[0];
                console.log(`[Employees/Sync] ✅ Empleado sincronizado exitosamente: ${fullName} (ID: ${employee.id})`);

                return res.json({
                    success: true,
                    data: employee,
                    id: employee.id,
                    employeeId: employee.id,
                    remoteId: employee.id
                });
            }

            console.log(`[Employees/Sync] ❌ Error: No se insertó empleado`);
            res.status(500).json({
                success: false,
                message: 'No se pudo guardar el empleado'
            });

        } catch (error) {
            console.error(`[Employees/Sync] ❌ Error:`, error.message);
            console.error(`[Employees/Sync] Stack:`, error.stack);

            res.status(500).json({
                success: false,
                message: 'Error al sincronizar empleado',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // GET /api/employees - Get all employees for a tenant
    router.get('/', async (req, res) => {
        try {
            const { tenantId } = req.query;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenantId'
                });
            }

            const result = await pool.query(
                `SELECT id, tenant_id, full_name, username, email, is_active, created_at, updated_at
                 FROM employees
                 WHERE tenant_id = $1
                 ORDER BY full_name ASC`,
                [tenantId]
            );

            res.json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            console.error('[Employees] Error en GET:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener empleados'
            });
        }
    });

    return router;
};
