// ═══════════════════════════════════════════════════════════════
// EMPLOYEE BRANCHES ROUTES - Handle many-to-many employee-branch relationships
// ═══════════════════════════════════════════════════════════════

const express = require('express');

module.exports = (pool) => {
    const router = express.Router();

    // Helper: Emitir evento Socket.IO de cambio de asignación
    function emitBranchAssignmentEvent(req, employeeId, branchId, isActive, action) {
        try {
            const io = req.app.get('io');
            if (io) {
                const roomName = `branch_${branchId}`;
                io.to(roomName).emit('employee_branch:updated', {
                    employeeId,
                    branchId,
                    isActive,
                    action,
                    timestamp: new Date().toISOString()
                });
                console.log(`[EmployeeBranches/Socket] 📡 Evento emitido a ${roomName}: ${action}`);
            }
        } catch (err) {
            console.error(`[EmployeeBranches/Socket] ⚠️ Error emitiendo evento: ${err.message}`);
        }
    }

    // POST /api/employee-branches - Sync employee branch assignment from Desktop
    // Creates or updates the relationship between an employee and a branch
    // Prefiere employeeGlobalId (offline-first). Cae a employeeId numérico por compat legacy.
    router.post('/', async (req, res) => {
        const client = await pool.connect();
        try {
            const {
                tenantId,
                employeeId: employeeIdLegacy,
                employeeGlobalId,
                branchId,
                isActive = true,
                globalId: assignmentGlobalId  // ← NUEVO: UUID de la fila EmployeeBranch generado por el desktop
            } = req.body;

            const idShown = employeeGlobalId || employeeIdLegacy;
            console.log(`[EmployeeBranches/Sync] 🔄 [INCOMING POST] Payload completo: ${JSON.stringify(req.body)}`);
            console.log(`[EmployeeBranches/Sync] 🔄 Sincronizando: Empleado ${idShown} → Sucursal ${branchId} (Tenant: ${tenantId}, isActive=${isActive}, globalId=${assignmentGlobalId ?? 'none'})`);

            // Validate required fields
            if (!tenantId || (!employeeGlobalId && !employeeIdLegacy) || !branchId) {
                console.log(`[EmployeeBranches/Sync] ❌ Datos incompletos`);
                return res.status(400).json({
                    success: false,
                    message: 'Faltan campos requeridos: tenantId, employeeGlobalId (o employeeId), branchId'
                });
            }

            // Resolver employee_id: preferir globalId (offline-first).
            let employeeId;
            if (employeeGlobalId) {
                const byGlobal = await client.query(
                    `SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2`,
                    [employeeGlobalId, tenantId]
                );
                if (byGlobal.rows.length === 0) {
                    console.log(`[EmployeeBranches/Sync] ⏳ Empleado con globalId ${employeeGlobalId} aún no existe en PG (resoluble)`);
                    return res.status(404).json({
                        success: false,
                        code: 'EMPLOYEE_NOT_SYNCED',
                        message: 'El empleado aún no se sincronizó a PG — se reintentará en el próximo ciclo'
                    });
                }
                employeeId = byGlobal.rows[0].id;
            } else {
                const empCheck = await client.query(
                    `SELECT id FROM employees WHERE id = $1 AND tenant_id = $2`,
                    [employeeIdLegacy, tenantId]
                );
                if (empCheck.rows.length === 0) {
                    console.log(`[EmployeeBranches/Sync] ❌ Empleado no encontrado: ${employeeIdLegacy}`);
                    return res.status(404).json({
                        success: false,
                        message: 'El empleado no existe'
                    });
                }
                employeeId = employeeIdLegacy;
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

            // ═════════════════════════════════════════════════════════════
            // RESOLUCIÓN DE IDEMPOTENCIA
            // 1. Si viene globalId → buscar por global_id (prioridad).
            // 2. Si no viene, fallback a llave natural (tenant, emp, branch)
            //    para compatibilidad con clientes antiguos que aún no envían globalId.
            // Si se encuentra por llave natural pero no tiene global_id en PG,
            // populamos el global_id recibido (o generamos uno) para reconciliar.
            // ═════════════════════════════════════════════════════════════
            let existingResult;
            if (assignmentGlobalId) {
                existingResult = await client.query(
                    `SELECT id, global_id FROM employee_branches WHERE global_id = $1`,
                    [assignmentGlobalId]
                );
            } else {
                existingResult = { rows: [] };
            }

            if (existingResult.rows.length === 0) {
                // Fallback a llave natural
                existingResult = await client.query(
                    `SELECT id, global_id FROM employee_branches
                     WHERE tenant_id = $1 AND employee_id = $2 AND branch_id = $3`,
                    [tenantId, employeeId, branchId]
                );
            }

            if (existingResult.rows.length > 0) {
                // Update existing relationship
                const existingId = existingResult.rows[0].id;
                const existingGlobalId = existingResult.rows[0].global_id;
                console.log(`[EmployeeBranches/Sync] ⚠️ Relación ya existe (ID: ${existingId}, global_id=${existingGlobalId}), actualizando...`);

                // Reconciliar global_id: si PG no tiene y el cliente sí → adoptar el del cliente
                // Si PG tiene uno distinto al que envía el cliente → conservar el de PG (el cliente ajusta)
                const globalIdToPersist = existingGlobalId || assignmentGlobalId || null;

                const updateResult = await client.query(
                    `UPDATE employee_branches
                     SET removed_at = CASE WHEN $1 = false THEN NOW() ELSE NULL END,
                         global_id = COALESCE(global_id, $3),
                         updated_at = NOW()
                     WHERE id = $2
                     RETURNING id, tenant_id, employee_id, branch_id, global_id, assigned_at, removed_at, updated_at`,
                    [isActive, existingId, globalIdToPersist]
                );

                if (updateResult.rows.length > 0) {
                    const relationship = updateResult.rows[0];
                    console.log(`[EmployeeBranches/Sync] ✅ Relación actualizada: Empleado ${employeeId} en Sucursal ${branchId} (global_id=${relationship.global_id})`);

                    // Notificar a la sucursal afectada via Socket.IO
                    emitBranchAssignmentEvent(req, employeeId, branchId, isActive, 'updated');

                    return res.json({
                        success: true,
                        data: relationship,
                        id: relationship.id,
                        remoteId: relationship.id,
                        globalId: relationship.global_id
                    });
                }
            }

            // Create new relationship
            console.log(`[EmployeeBranches/Sync] 📝 Creando nueva relación: Empleado ${employeeId} → Sucursal ${branchId} (global_id=${assignmentGlobalId ?? '(auto)'})`);

            const insertResult = await client.query(
                `INSERT INTO employee_branches
                 (tenant_id, employee_id, branch_id, global_id, assigned_at, removed_at, updated_at)
                 VALUES ($1, $2, $3, COALESCE($5, gen_random_uuid()), NOW(), CASE WHEN $4 = false THEN NOW() ELSE NULL END, NOW())
                 RETURNING id, tenant_id, employee_id, branch_id, global_id, assigned_at, removed_at, updated_at`,
                [tenantId, employeeId, branchId, isActive, assignmentGlobalId || null]
            );

            if (insertResult.rows.length > 0) {
                const relationship = insertResult.rows[0];
                console.log(`[EmployeeBranches/Sync] ✅ Relación creada: Empleado ${employeeId} en Sucursal ${branchId} (ID: ${relationship.id}, global_id=${relationship.global_id})`);

                // Notificar a la sucursal afectada via Socket.IO
                emitBranchAssignmentEvent(req, employeeId, branchId, isActive, 'assigned');

                return res.json({
                    success: true,
                    data: relationship,
                    id: relationship.id,
                    remoteId: relationship.id,
                    globalId: relationship.global_id
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
                error: undefined
            });
        } finally {
            client.release();
        }
    });

    // GET /api/employee-branches - Get all branches for an employee
    router.get('/', async (req, res) => {
        try {
            const { tenantId, employeeId } = req.query;

            console.log(`[EmployeeBranches/GET] 🔍 Query: tenantId=${tenantId} employeeId=${employeeId ?? '(all)'}`);

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenantId'
                });
            }

            let query = `
                SELECT eb.id, eb.tenant_id, eb.employee_id, eb.branch_id,
                       eb.global_id, eb.assigned_at, eb.removed_at, eb.updated_at,
                       (eb.removed_at IS NULL) as is_active,
                       b.name as branch_name, b.branch_code as branch_code,
                       e.global_id as employee_global_id,
                       e.first_name, e.last_name
                FROM employee_branches eb
                JOIN branches b ON b.id = eb.branch_id
                JOIN employees e ON e.id = eb.employee_id
                WHERE eb.tenant_id = $1
            `;
            const params = [tenantId];

            if (employeeId) {
                query += ` AND eb.employee_id = $2`;
                params.push(employeeId);
            }

            query += ` ORDER BY e.id, b.name ASC`;

            const result = await pool.query(query, params);

            console.log(`[EmployeeBranches/GET] 🔍 ${result.rows.length} filas devueltas:`);
            for (const row of result.rows) {
                console.log(`[EmployeeBranches/GET]    emp_id=${row.employee_id} (${row.first_name} ${row.last_name}) → branch_id=${row.branch_id} (${row.branch_name}) is_active=${row.is_active} removed_at=${row.removed_at ?? 'null'}`);
            }

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
                error: undefined
            });
        } finally {
            client.release();
        }
    });

    return router;
};
