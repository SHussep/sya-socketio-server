// ═══════════════════════════════════════════════════════════════
// EMPLOYEES ROUTES - Handle employee synchronization from Desktop
// ═══════════════════════════════════════════════════════════════

const express = require('express');

module.exports = (pool) => {
    const router = express.Router();

    // POST /api/employees - Sync employee from Desktop app with roles and passwords
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
                password,  // BCrypt hashed password from Desktop
                roleId,
                isActive,
                isOwner,
                mainBranchId,
                googleUserIdentifier
            } = req.body;

            console.log(`[Employees/Sync] 🔄 Sincronizando empleado: ${fullName} (${username}) - Tenant: ${tenantId}, Role: ${roleId}`);

            // Validate required fields
            if (!tenantId || !fullName || !username || !email) {
                console.log(`[Employees/Sync] ❌ Datos incompletos`);
                return res.status(400).json({
                    success: false,
                    message: 'Faltan campos requeridos: tenantId, fullName, username, email'
                });
            }

            // Validate role_id if provided
            if (roleId) {
                const roleCheck = await client.query(
                    `SELECT id, name FROM roles WHERE id = $1 AND tenant_id = $2`,
                    [roleId, tenantId]
                );

                if (roleCheck.rows.length === 0) {
                    console.log(`[Employees/Sync] ❌ Rol no válido: ${roleId}`);
                    return res.status(400).json({
                        success: false,
                        message: 'El roleId no existe o no pertenece al tenant'
                    });
                }
            }

            // Check if employee already exists by email or username
            const existingResult = await client.query(
                `SELECT id, password_hash FROM employees WHERE
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
                         role_id = COALESCE($4, role_id),
                         password_hash = COALESCE($5, password_hash),
                         password_updated_at = CASE WHEN $5 IS NOT NULL THEN NOW() ELSE password_updated_at END,
                         updated_at = NOW()
                     WHERE id = $6 AND tenant_id = $7
                     RETURNING id, tenant_id, full_name, username, email, main_branch_id, is_active, role_id, created_at, updated_at`,
                    [
                        fullName,
                        branchId || mainBranchId,
                        isActive !== false,
                        roleId || null,
                        password || null,
                        existingId,
                        tenantId
                    ]
                );

                if (updateResult.rows.length > 0) {
                    const employee = updateResult.rows[0];
                    console.log(`[Employees/Sync] ✅ Empleado actualizado: ${fullName} (ID: ${employee.id})`);

                    // Get role with permissions if roleId is set
                    let roleData = null;
                    if (employee.role_id) {
                        const roleQuery = await client.query(
                            `SELECT r.id, r.name, r.description, ARRAY_AGG(p.code) as permissions
                             FROM roles r
                             LEFT JOIN role_permissions rp ON rp.role_id = r.id
                             LEFT JOIN permissions p ON p.id = rp.permission_id
                             WHERE r.id = $1
                             GROUP BY r.id, r.name, r.description`,
                            [employee.role_id]
                        );

                        if (roleQuery.rows.length > 0) {
                            roleData = {
                                id: roleQuery.rows[0].id,
                                name: roleQuery.rows[0].name,
                                description: roleQuery.rows[0].description,
                                permissions: roleQuery.rows[0].permissions.filter(p => p != null)
                            };
                        }
                    }

                    return res.json({
                        success: true,
                        data: employee,
                        id: employee.id,
                        employeeId: employee.id,
                        remoteId: employee.id,
                        role: roleData
                    });
                }
            }

            // Create new employee
            console.log(`[Employees/Sync] 📝 Creando nuevo empleado: ${fullName}`);

            const insertResult = await client.query(
                `INSERT INTO employees
                 (tenant_id, full_name, username, email, password_hash, main_branch_id, role_id, is_active, updated_at, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
                 RETURNING id, tenant_id, full_name, username, email, main_branch_id, role_id, is_active, created_at, updated_at`,
                [
                    tenantId,
                    fullName,
                    username,
                    email,
                    password || null,  // Can be null if not provided
                    branchId || mainBranchId,
                    roleId || null,
                    isActive !== false
                ]
            );

            if (insertResult.rows.length > 0) {
                const employee = insertResult.rows[0];
                console.log(`[Employees/Sync] ✅ Empleado sincronizado exitosamente: ${fullName} (ID: ${employee.id})`);

                // Get role with permissions if roleId is set
                let roleData = null;
                if (employee.role_id) {
                    const roleQuery = await client.query(
                        `SELECT r.id, r.name, r.description, ARRAY_AGG(p.code) as permissions
                         FROM roles r
                         LEFT JOIN role_permissions rp ON rp.role_id = r.id
                         LEFT JOIN permissions p ON p.id = rp.permission_id
                         WHERE r.id = $1
                         GROUP BY r.id, r.name, r.description`,
                        [employee.role_id]
                    );

                    if (roleQuery.rows.length > 0) {
                        roleData = {
                            id: roleQuery.rows[0].id,
                            name: roleQuery.rows[0].name,
                            description: roleQuery.rows[0].description,
                            permissions: roleQuery.rows[0].permissions.filter(p => p != null)
                        };
                    }
                }

                return res.json({
                    success: true,
                    data: employee,
                    id: employee.id,
                    employeeId: employee.id,
                    remoteId: employee.id,
                    role: roleData
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

    // POST /api/employees/:id/password - Sync password change from Desktop
    router.post('/:id/password', async (req, res) => {
        const client = await pool.connect();
        try {
            const employeeId = req.params.id;
            const { tenantId, oldPasswordHash, newPasswordHash } = req.body;

            console.log(`[Employees/Password] 🔄 Sincronizando cambio de contraseña para empleado ${employeeId}`);

            // Validate required fields
            if (!tenantId || !oldPasswordHash || !newPasswordHash) {
                return res.status(400).json({
                    success: false,
                    message: 'Faltan campos requeridos: tenantId, oldPasswordHash, newPasswordHash'
                });
            }

            // Verify that the employee exists and old password matches
            const checkResult = await client.query(
                `SELECT id, password_hash FROM employees WHERE id = $1 AND tenant_id = $2`,
                [employeeId, tenantId]
            );

            if (checkResult.rows.length === 0) {
                console.log(`[Employees/Password] ❌ Empleado no encontrado: ${employeeId}`);
                return res.status(404).json({
                    success: false,
                    message: 'Empleado no encontrado'
                });
            }

            const employee = checkResult.rows[0];

            // Verify old password matches
            if (employee.password_hash !== oldPasswordHash) {
                console.log(`[Employees/Password] ❌ Contraseña anterior no coincide para ${employeeId}`);
                return res.status(401).json({
                    success: false,
                    message: 'La contraseña anterior no coincide'
                });
            }

            // Update password
            const updateResult = await client.query(
                `UPDATE employees
                 SET password_hash = $1,
                     password_updated_at = NOW(),
                     updated_at = NOW()
                 WHERE id = $2 AND tenant_id = $3
                 RETURNING id, full_name, password_updated_at`,
                [newPasswordHash, employeeId, tenantId]
            );

            if (updateResult.rows.length > 0) {
                const updated = updateResult.rows[0];
                console.log(`[Employees/Password] ✅ Contraseña sincronizada para ${updated.full_name} (ID: ${updated.id})`);

                return res.json({
                    success: true,
                    message: 'Contraseña sincronizada exitosamente',
                    passwordSynced: true,
                    passwordUpdatedAt: updated.password_updated_at
                });
            }

            console.log(`[Employees/Password] ❌ Error: No se actualizó la contraseña`);
            res.status(500).json({
                success: false,
                message: 'No se pudo actualizar la contraseña'
            });

        } catch (error) {
            console.error(`[Employees/Password] ❌ Error:`, error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar contraseña',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // GET /api/roles - Get all available roles for a tenant
    router.get('/roles/:tenantId', async (req, res) => {
        try {
            const { tenantId } = req.params;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenantId'
                });
            }

            console.log(`[Roles] 🔄 Obteniendo roles para tenant ${tenantId}`);

            // Get all roles with their permissions
            const result = await pool.query(
                `SELECT r.id, r.name, r.description, r.is_system,
                        ARRAY_AGG(p.code) as permission_codes,
                        ARRAY_AGG(json_build_object('code', p.code, 'name', p.name, 'description', p.description)) as permissions
                 FROM roles r
                 LEFT JOIN role_permissions rp ON rp.role_id = r.id
                 LEFT JOIN permissions p ON p.id = rp.permission_id
                 WHERE r.tenant_id = $1
                 GROUP BY r.id, r.name, r.description, r.is_system
                 ORDER BY r.is_system DESC, r.name ASC`,
                [tenantId]
            );

            // Clean up null values from aggregated arrays
            const cleanedRoles = result.rows.map(role => ({
                id: role.id,
                name: role.name,
                description: role.description,
                isSystem: role.is_system,
                permissionCodes: role.permission_codes.filter(code => code != null),
                permissions: role.permissions
                    .filter(p => p && p.code != null)
                    .map(p => ({
                        code: p.code,
                        name: p.name,
                        description: p.description
                    }))
            }));

            console.log(`[Roles] ✅ Se obtuvieron ${cleanedRoles.length} roles para tenant ${tenantId}`);

            res.json({
                success: true,
                data: cleanedRoles,
                count: cleanedRoles.length
            });

        } catch (error) {
            console.error('[Roles] ❌ Error en GET:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener roles',
                error: error.message
            });
        }
    });

    return router;
};
