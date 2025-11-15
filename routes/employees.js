// ═══════════════════════════════════════════════════════════════
// EMPLOYEES ROUTES - Handle employee synchronization from Desktop
// ═══════════════════════════════════════════════════════════════

const express = require('express');

module.exports = (pool) => {
    const router = express.Router();

    // ═════════════════════════════════════════════════════════════
    // HELPER: Derive mobile access type from role_id and boolean
    // ═════════════════════════════════════════════════════════════
    const getMobileAccessType = (roleId, canUseMobileApp) => {
        if (!canUseMobileApp) return 'none';

        switch (roleId) {
            case 1:
            case 2:
                return 'admin';      // Administrador, Encargado
            case 3:
                return 'distributor'; // Repartidor
            case 4:
                return 'none';        // Ayudante (cannot use mobile)
            case 99:
                return 'none';        // Otro (undefined)
            default:
                return 'none';
        }
    };

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
                googleUserIdentifier,
                // ✅ OFFLINE-FIRST FIELDS
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw
            } = req.body;

            console.log(`[Employees/Sync] 🔄 Sincronizando empleado: ${fullName} (${username}) - Tenant: ${tenantId}, Role: ${roleId}`);
            console.log(`[Employees/Sync] 🔑 GlobalId: ${global_id || 'null'}, TerminalId: ${terminal_id || 'null'}`);

            // Validate required fields
            if (!tenantId || !fullName || !username || !email || !global_id) {
                console.log(`[Employees/Sync] ❌ Datos incompletos`);
                return res.status(400).json({
                    success: false,
                    message: 'Faltan campos requeridos: tenantId, fullName, username, email, global_id'
                });
            }

            // Split fullName into first_name and last_name
            const nameParts = fullName.trim().split(/\s+/);
            const firstName = nameParts[0] || fullName;
            const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

            // Map role_id: if not 1-4, use "Otro" (99) for custom roles from Desktop
            let mappedRoleId = roleId;
            if (roleId) {
                if (![1, 2, 3, 4, 99].includes(roleId)) {
                    // Custom role from Desktop → map to "Otro"
                    console.log(`[Employees/Sync] ℹ️  Rol custom detectado: ${roleId} → mapeando a "Otro" (99)`);
                    mappedRoleId = 99;
                }

                const roleCheck = await client.query(
                    `SELECT id, name FROM roles WHERE id = $1`,
                    [mappedRoleId]
                );

                if (roleCheck.rows.length === 0) {
                    console.log(`[Employees/Sync] ❌ Rol no válido: ${mappedRoleId}`);
                    return res.status(400).json({
                        success: false,
                        message: `Rol no válido. Roles válidos: 1 (Admin), 2 (Encargado), 3 (Repartidor), 4 (Ayudante), o cualquier custom (mapeará a Otro)`
                    });
                }
            }

            // Determine if employee can use mobile app
            // If canUseMobileApp is explicitly provided, use it; otherwise determine from role
            let canUseMobileApp = req.body.canUseMobileApp;

            if (canUseMobileApp === undefined || canUseMobileApp === null) {
                // Auto-assign based on role if not explicitly provided
                // Roles 1, 2, 3 can use mobile app by default; 4 and 99 cannot
                canUseMobileApp = [1, 2, 3].includes(mappedRoleId) ? true : false;
            }

            // Validate canUseMobileApp is boolean
            if (typeof canUseMobileApp !== 'boolean') {
                console.log(`[Employees/Sync] ❌ canUseMobileApp debe ser boolean: ${canUseMobileApp}`);
                return res.status(400).json({
                    success: false,
                    message: `canUseMobileApp debe ser true o false`
                });
            }

            // Derive the access type from role + boolean
            const mobileAccessType = getMobileAccessType(mappedRoleId, canUseMobileApp);

            console.log(`[Employees/Sync] 📱 Mobile Access: ${mobileAccessType} (Role: ${mappedRoleId}, Can Use: ${canUseMobileApp})`);

            // ✅ IDEMPOTENCIA: Check if employee already exists by global_id
            const existingResult = await client.query(
                `SELECT id, password_hash FROM employees WHERE global_id = $1 AND tenant_id = $2`,
                [global_id, tenantId]
            );

            if (existingResult.rows.length > 0) {
                // Update existing employee with transaction
                const existingId = existingResult.rows[0].id;
                console.log(`[Employees/Sync] ⚠️ Empleado ya existe (ID: ${existingId}), actualizando...`);

                try {
                    await client.query('BEGIN');

                    const updateResult = await client.query(
                        `UPDATE employees
                         SET first_name = $1,
                             last_name = $2,
                             main_branch_id = COALESCE($3, main_branch_id),
                             is_active = COALESCE($4, is_active),
                             role_id = COALESCE($5, role_id),
                             password_hash = COALESCE($6, password_hash),
                             password_updated_at = CASE WHEN $6 IS NOT NULL THEN NOW() ELSE password_updated_at END,
                             can_use_mobile_app = COALESCE($9, can_use_mobile_app),
                             updated_at = NOW()
                         WHERE id = $7 AND tenant_id = $8
                         RETURNING id, tenant_id, first_name, last_name, username, email, main_branch_id, is_active, role_id, can_use_mobile_app, created_at, updated_at`,
                        [
                            firstName,
                            lastName,
                            branchId || mainBranchId,
                            isActive !== false,
                            mappedRoleId || null,
                            password || null,
                            existingId,
                            tenantId,
                            canUseMobileApp
                        ]
                    );

                    if (updateResult.rows.length === 0) {
                        await client.query('ROLLBACK');
                        return res.status(500).json({
                            success: false,
                            message: 'No se pudo actualizar el empleado'
                        });
                    }

                    const employee = updateResult.rows[0];

                    // Update or create employee_branches relationship
                    if (employee.main_branch_id) {
                        const branchCheck = await client.query(
                            `SELECT id FROM branches WHERE id = $1 AND tenant_id = $2`,
                            [employee.main_branch_id, tenantId]
                        );

                        if (branchCheck.rows.length > 0) {
                            await client.query(
                                `INSERT INTO employee_branches (tenant_id, employee_id, branch_id, created_at, updated_at)
                                 VALUES ($1, $2, $3, NOW(), NOW())
                                 ON CONFLICT (tenant_id, employee_id, branch_id) DO UPDATE SET updated_at = NOW()`,
                                [tenantId, employee.id, employee.main_branch_id]
                            );

                            console.log(`[Employees/Sync] ✓ Relación employee_branches actualizada: Empleado ${employee.id} → Sucursal ${employee.main_branch_id}`);
                        }
                    }

                    await client.query('COMMIT');

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
                        role: roleData,
                        synced: true  // Desktop can now mark as Sincronizado
                    });

                } catch (txError) {
                    await client.query('ROLLBACK').catch(() => {});
                    console.error(`[Employees/Sync] ❌ Error al actualizar empleado:`, txError.message);
                    return res.status(500).json({
                        success: false,
                        message: 'Error al sincronizar empleado (transacción revertida)',
                        error: txError.message
                    });
                }
            }

            // Create new employee with transaction (BEGIN/COMMIT/ROLLBACK)
            // Ensures employee_branches is created atomically
            console.log(`[Employees/Sync] 📝 Creando nuevo empleado: ${fullName}`);

            try {
                await client.query('BEGIN');

                const insertResult = await client.query(
                    `INSERT INTO employees
                     (tenant_id, first_name, last_name, username, email, password_hash, main_branch_id, role_id, can_use_mobile_app, is_active, global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw, updated_at, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())
                     ON CONFLICT (global_id) DO UPDATE
                     SET first_name = EXCLUDED.first_name,
                         last_name = EXCLUDED.last_name,
                         username = EXCLUDED.username,
                         email = EXCLUDED.email,
                         password_hash = COALESCE(EXCLUDED.password_hash, employees.password_hash),
                         main_branch_id = COALESCE(EXCLUDED.main_branch_id, employees.main_branch_id),
                         role_id = COALESCE(EXCLUDED.role_id, employees.role_id),
                         can_use_mobile_app = COALESCE(EXCLUDED.can_use_mobile_app, employees.can_use_mobile_app),
                         is_active = COALESCE(EXCLUDED.is_active, employees.is_active),
                         updated_at = NOW()
                     RETURNING id, tenant_id, first_name, last_name, username, email, main_branch_id, role_id, can_use_mobile_app, is_active, created_at, updated_at`,
                    [
                        tenantId,
                        firstName,
                        lastName,
                        username,
                        email,
                        password || null,  // Can be null if not provided
                        branchId || mainBranchId,
                        mappedRoleId || null,
                        canUseMobileApp,
                        isActive !== false,
                        global_id,            // ✅ OFFLINE-FIRST
                        terminal_id,          // ✅ OFFLINE-FIRST
                        local_op_seq,         // ✅ OFFLINE-FIRST
                        created_local_utc,    // ✅ OFFLINE-FIRST
                        device_event_raw      // ✅ OFFLINE-FIRST
                    ]
                );

                if (insertResult.rows.length === 0) {
                    await client.query('ROLLBACK');
                    console.log(`[Employees/Sync] ❌ Error: No se insertó empleado`);
                    return res.status(500).json({
                        success: false,
                        message: 'No se pudo guardar el empleado'
                    });
                }

                const employee = insertResult.rows[0];

                // Add employee to main branch (create employee_branches relationship)
                if (employee.main_branch_id) {
                    const branchCheck = await client.query(
                        `SELECT id FROM branches WHERE id = $1 AND tenant_id = $2`,
                        [employee.main_branch_id, tenantId]
                    );

                    if (branchCheck.rows.length > 0) {
                        // Insert into employee_branches
                        await client.query(
                            `INSERT INTO employee_branches (tenant_id, employee_id, branch_id, created_at, updated_at)
                             VALUES ($1, $2, $3, NOW(), NOW())
                             ON CONFLICT (tenant_id, employee_id, branch_id) DO UPDATE SET updated_at = NOW()`,
                            [tenantId, employee.id, employee.main_branch_id]
                        );

                        console.log(`[Employees/Sync] ✓ Relación employee_branches creada: Empleado ${employee.id} → Sucursal ${employee.main_branch_id}`);
                    } else {
                        console.log(`[Employees/Sync] ⚠️ Sucursal ${employee.main_branch_id} no encontrada, saltando relación employee_branches`);
                    }
                }

                await client.query('COMMIT');

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
                    role: roleData,
                    synced: true  // Desktop can now mark as Sincronizado
                });

            } catch (txError) {
                await client.query('ROLLBACK').catch(() => {});
                console.error(`[Employees/Sync] ❌ Error en transacción:`, txError.message);
                return res.status(500).json({
                    success: false,
                    message: 'Error al sincronizar empleado (transacción revertida)',
                    error: txError.message
                });
            }

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
                `SELECT id, tenant_id, first_name, last_name, username, email, is_active, created_at, updated_at
                 FROM employees
                 WHERE tenant_id = $1
                 ORDER BY first_name ASC, last_name ASC`,
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
                 RETURNING id, first_name, last_name, password_updated_at`,
                [newPasswordHash, employeeId, tenantId]
            );

            if (updateResult.rows.length > 0) {
                const updated = updateResult.rows[0];
                const updatedFullName = `${updated.first_name || ''} ${updated.last_name || ''}`.trim();
                console.log(`[Employees/Password] ✅ Contraseña sincronizada para ${updatedFullName} (ID: ${updated.id})`);

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

    // DELETE /api/employees/:id - Delete employee and all related data
    // Deletes employee from employees table and cascades to employee_branches
    router.delete('/:id', async (req, res) => {
        const client = await pool.connect();
        try {
            const employeeId = parseInt(req.params.id);
            const { tenantId } = req.body;

            console.log(`[Employees/Delete] 🗑️  [DELETE RECIBIDO] Eliminando empleado ID: ${employeeId}`);
            console.log(`[Employees/Delete] 📝 Payload: ${JSON.stringify({ tenantId })}`);

            // Validate parameters
            if (!employeeId || !tenantId) {
                console.log(`[Employees/Delete] ❌ Parámetros faltantes: employeeId=${employeeId}, tenantId=${tenantId}`);
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: employeeId en URL, tenantId en body'
                });
            }

            // Verify employee exists and belongs to tenant
            const employeeCheck = await client.query(
                `SELECT id, email, first_name, last_name FROM employees
                 WHERE id = $1 AND tenant_id = $2`,
                [employeeId, tenantId]
            );

            if (employeeCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Empleado no encontrado'
                });
            }

            const employee = employeeCheck.rows[0];
            const employeeFullName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim();

            // Start transaction
            await client.query('BEGIN');

            try {
                // Delete employee_branches entries first (foreign key reference)
                const branchesDeleteResult = await client.query(
                    `DELETE FROM employee_branches
                     WHERE employee_id = $1 AND tenant_id = $2`,
                    [employeeId, tenantId]
                );

                // Delete the employee
                const employeeDeleteResult = await client.query(
                    `DELETE FROM employees
                     WHERE id = $1 AND tenant_id = $2
                     RETURNING id, first_name, last_name, email`,
                    [employeeId, tenantId]
                );

                await client.query('COMMIT');

                console.log(`[Employees/Delete] ✅ Empleado eliminado: ${employeeFullName} (ID: ${employeeId})`);
                console.log(`[Employees/Delete] ℹ️  Se eliminaron ${branchesDeleteResult.rowCount} relaciones de sucursales`);

                return res.json({
                    success: true,
                    message: 'Empleado eliminado exitosamente',
                    data: {
                        employeeId: employeeId,
                        fullName: employeeFullName,
                        email: employee.email,
                        branchesDeleted: branchesDeleteResult.rowCount,
                        deletedAt: new Date().toISOString()
                    }
                });

            } catch (innerError) {
                await client.query('ROLLBACK');
                throw innerError;
            }

        } catch (error) {
            console.error('[Employees/Delete] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar empleado',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // GET /api/employees/:id/mobile-access - Get mobile app access type
    // Called by mobile app after login to verify access level
    router.get('/:id/mobile-access', async (req, res) => {
        const client = await pool.connect();
        try {
            const employeeId = parseInt(req.params.id);
            const { tenantId } = req.query;

            if (!employeeId || !tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: employeeId en URL, tenantId en query'
                });
            }

            const result = await client.query(
                `SELECT id, email, first_name, last_name, role_id, can_use_mobile_app FROM employees
                 WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
                [employeeId, tenantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Empleado no encontrado o inactivo'
                });
            }

            const employee = result.rows[0];
            const employeeFullName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim();

            // Derive access type from role_id + can_use_mobile_app
            const accessType = getMobileAccessType(employee.role_id, employee.can_use_mobile_app);
            const hasMobileAccess = accessType !== 'none' && employee.can_use_mobile_app;

            return res.json({
                success: true,
                data: {
                    employeeId: employee.id,
                    email: employee.email,
                    fullName: employeeFullName,
                    roleId: employee.role_id,
                    canUseMobileApp: employee.can_use_mobile_app,
                    mobileAccessType: accessType,
                    hasMobileAccess: hasMobileAccess,
                    message: hasMobileAccess
                        ? `Acceso aprobado como ${accessType === 'admin' ? 'Administrador' : 'Repartidor'}`
                        : 'No tiene acceso a la aplicación móvil'
                }
            });

        } catch (error) {
            console.error('[Employees/MobileAccess] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al verificar acceso móvil',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // PUT /api/employees/:id - Update employee (role, mobile access, name, status)
    // Flexible endpoint to update multiple fields when Desktop edits an employee
    router.put('/:id', async (req, res) => {
        const client = await pool.connect();
        try {
            const employeeId = parseInt(req.params.id);
            const {
                tenantId,
                roleId,
                canUseMobileApp,
                fullName,
                isActive,
                email
            } = req.body;

            console.log(`[Employees/Update] 🔄 [UPDATE RECIBIDO] Actualizando empleado ID: ${employeeId}`);
            console.log(`[Employees/Update] 📝 Payload: ${JSON.stringify({ tenantId, roleId, canUseMobileApp, fullName, isActive, email })}`);

            // Validate parameters
            if (!employeeId || !tenantId) {
                console.log(`[Employees/Update] ❌ Parámetros faltantes: employeeId=${employeeId}, tenantId=${tenantId}`);
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: employeeId, tenantId'
                });
            }

            // Validate types if provided
            if (canUseMobileApp !== undefined && typeof canUseMobileApp !== 'boolean') {
                return res.status(400).json({
                    success: false,
                    message: 'canUseMobileApp debe ser true o false'
                });
            }

            if (roleId !== undefined && ![1, 2, 3, 4, 99].includes(roleId)) {
                return res.status(400).json({
                    success: false,
                    message: 'roleId inválido. Roles válidos: 1, 2, 3, 4, 99'
                });
            }

            // Split fullName if provided
            let firstName, lastName;
            if (fullName !== undefined) {
                const nameParts = fullName.trim().split(/\s+/);
                firstName = nameParts[0] || fullName;
                lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
            }

            // Verify employee exists and belongs to tenant
            const employeeCheck = await client.query(
                `SELECT id, email, first_name, last_name, role_id, can_use_mobile_app FROM employees
                 WHERE id = $1 AND tenant_id = $2`,
                [employeeId, tenantId]
            );

            if (employeeCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Empleado no encontrado'
                });
            }

            const employee = employeeCheck.rows[0];

            // If roleId is being updated, verify it exists
            if (roleId !== undefined && roleId !== employee.role_id) {
                const roleCheck = await client.query(
                    `SELECT id FROM roles WHERE id = $1`,
                    [roleId]
                );

                if (roleCheck.rows.length === 0) {
                    return res.status(400).json({
                        success: false,
                        message: `Rol ${roleId} no encontrado`
                    });
                }
            }

            // Build dynamic UPDATE statement
            const updates = [];
            const params = [];
            let paramIndex = 1;

            if (fullName !== undefined) {
                updates.push(`first_name = $${paramIndex}`);
                params.push(firstName);
                paramIndex++;
                updates.push(`last_name = $${paramIndex}`);
                params.push(lastName);
                paramIndex++;
            }

            if (roleId !== undefined) {
                updates.push(`role_id = $${paramIndex}`);
                params.push(roleId);
                paramIndex++;
            }

            if (canUseMobileApp !== undefined) {
                updates.push(`can_use_mobile_app = $${paramIndex}`);
                params.push(canUseMobileApp);
                paramIndex++;
            }

            if (isActive !== undefined) {
                updates.push(`is_active = $${paramIndex}`);
                params.push(isActive);
                paramIndex++;
            }

            if (email !== undefined) {
                updates.push(`email = $${paramIndex}`);
                params.push(email);
                paramIndex++;
            }

            // Always update timestamp
            updates.push(`updated_at = NOW()`);

            // Add WHERE clause parameters
            params.push(employeeId);
            params.push(tenantId);

            const query = `UPDATE employees
                          SET ${updates.join(', ')}
                          WHERE id = $${paramIndex} AND tenant_id = $${paramIndex + 1}
                          RETURNING id, email, first_name, last_name, role_id, can_use_mobile_app, is_active, updated_at`;

            const updateResult = await client.query(query, params);

            if (updateResult.rows.length > 0) {
                const updatedEmployee = updateResult.rows[0];
                const updatedFullName = `${updatedEmployee.first_name || ''} ${updatedEmployee.last_name || ''}`.trim();
                const accessType = getMobileAccessType(updatedEmployee.role_id, updatedEmployee.can_use_mobile_app);

                // Log what was updated
                const changes = [];
                if (fullName !== undefined) changes.push(`nombre: ${fullName}`);
                if (roleId !== undefined) changes.push(`rol: ${roleId}`);
                if (canUseMobileApp !== undefined) changes.push(`acceso_móvil: ${canUseMobileApp}`);
                if (isActive !== undefined) changes.push(`activo: ${isActive}`);
                if (email !== undefined) changes.push(`email: ${email}`);

                console.log(`[Employees/Update] ✅ Empleado actualizado: ${updatedFullName} (ID: ${employeeId}) - Cambios: ${changes.join(', ')}`);

                return res.json({
                    success: true,
                    message: 'Empleado actualizado exitosamente',
                    data: {
                        employeeId: updatedEmployee.id,
                        email: updatedEmployee.email,
                        fullName: updatedFullName,
                        roleId: updatedEmployee.role_id,
                        canUseMobileApp: updatedEmployee.can_use_mobile_app,
                        mobileAccessType: accessType,
                        isActive: updatedEmployee.is_active,
                        updatedAt: updatedEmployee.updated_at
                    }
                });
            } else {
                return res.status(500).json({
                    success: false,
                    message: 'No se pudo actualizar el empleado'
                });
            }

        } catch (error) {
            console.error('[Employees/Update] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar empleado',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // PUT /api/employees/:id/password - Update employee password
    router.put('/:id/password', async (req, res) => {
        const client = await pool.connect();
        try {
            const employeeId = parseInt(req.params.id);
            const { tenantId, passwordHash } = req.body;

            console.log(`[Employees/Password] 🔐 Actualizando contraseña para empleado ID: ${employeeId}`);

            // Validate parameters
            if (!employeeId || !tenantId || !passwordHash) {
                console.log(`[Employees/Password] ❌ Parámetros faltantes`);
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: employeeId, tenantId, passwordHash'
                });
            }

            // Verify employee exists and belongs to tenant
            const employeeCheck = await client.query(
                `SELECT id FROM employees WHERE id = $1 AND tenant_id = $2`,
                [employeeId, tenantId]
            );

            if (employeeCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Empleado no encontrado'
                });
            }

            // Update password
            const updateResult = await client.query(
                `UPDATE employees
                 SET password_hash = $1,
                     password_updated_at = NOW(),
                     updated_at = NOW()
                 WHERE id = $2 AND tenant_id = $3
                 RETURNING id, updated_at`,
                [passwordHash, employeeId, tenantId]
            );

            if (updateResult.rows.length > 0) {
                console.log(`[Employees/Password] ✅ Contraseña actualizada para empleado ID: ${employeeId}`);
                return res.json({
                    success: true,
                    message: 'Contraseña actualizada exitosamente',
                    data: {
                        employeeId: updateResult.rows[0].id,
                        updatedAt: updateResult.rows[0].updated_at
                    }
                });
            } else {
                return res.status(500).json({
                    success: false,
                    message: 'No se pudo actualizar la contraseña'
                });
            }

        } catch (error) {
            console.error('[Employees/Password] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar contraseña',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    return router;
};
