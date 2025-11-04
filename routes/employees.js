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
                         can_use_mobile_app = COALESCE($8, can_use_mobile_app),
                         updated_at = NOW()
                     WHERE id = $6 AND tenant_id = $7
                     RETURNING id, tenant_id, full_name, username, email, main_branch_id, is_active, role_id, can_use_mobile_app, created_at, updated_at`,
                    [
                        fullName,
                        branchId || mainBranchId,
                        isActive !== false,
                        roleId || null,
                        password || null,
                        existingId,
                        tenantId,
                        canUseMobileApp
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
                 (tenant_id, full_name, username, email, password_hash, main_branch_id, role_id, can_use_mobile_app, is_active, updated_at, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
                 RETURNING id, tenant_id, full_name, username, email, main_branch_id, role_id, can_use_mobile_app, is_active, created_at, updated_at`,
                [
                    tenantId,
                    fullName,
                    username,
                    email,
                    password || null,  // Can be null if not provided
                    branchId || mainBranchId,
                    roleId || null,
                    canUseMobileApp,
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

    // POST /api/employees/:id/sync-role - Sync employee role and mobile app permissions from Desktop app
    // Automatically assigns mobile app permission based on role (ONLY ONE permission allowed)
    // - Administrador role → AccessMobileAppAsAdmin
    // - Repartidor role → AccessMobileAppAsDistributor
    router.post('/:id/sync-role', async (req, res) => {
        const client = await pool.connect();
        try {
            const employeeId = req.params.id;
            const { tenantId, roleId, canUseMobileApp, mobileAppPermissionOverride } = req.body;

            console.log(`[Employees/SyncRole] 🔄 Sincronizando empleado ${employeeId}: roleId=${roleId}, mobile=${canUseMobileApp}${mobileAppPermissionOverride ? `, override=${mobileAppPermissionOverride}` : ''}`);

            // Validate required fields
            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenantId'
                });
            }

            // Verify employee exists
            const employeeCheck = await client.query(
                `SELECT id, full_name, role_id FROM employees WHERE id = $1 AND tenant_id = $2`,
                [employeeId, tenantId]
            );

            if (employeeCheck.rows.length === 0) {
                console.log(`[Employees/SyncRole] ❌ Empleado no encontrado: ${employeeId}`);
                return res.status(404).json({
                    success: false,
                    message: 'Empleado no encontrado'
                });
            }

            const employee = employeeCheck.rows[0];

            // If roleId provided, validate it exists and get role name
            // Roles are now global: 1=Admin, 2=Encargado, 3=Repartidor, 4=Ayudante, 99=Otro (custom roles)
            let finalRoleId = employee.role_id;  // Keep existing role if not provided
            let roleName = null;
            if (roleId) {
                const roleCheck = await client.query(
                    `SELECT id, name FROM roles WHERE id = $1`,
                    [roleId]
                );

                if (roleCheck.rows.length === 0) {
                    console.log(`[Employees/SyncRole] ❌ Rol no válido: ${roleId}`);
                    return res.status(400).json({
                        success: false,
                        message: `Rol no válido: ${roleId}. Roles válidos: 1 (Admin), 2 (Encargado), 3 (Repartidor), 4 (Ayudante), 99 (Otro)`
                    });
                }
                finalRoleId = roleId;
                roleName = roleCheck.rows[0].name;
            }

            // Only update role and permissions if canUseMobileApp is true
            // If false, we don't grant access to mobile
            if (canUseMobileApp === true && roleId) {
                // Start transaction
                await client.query('BEGIN');

                // Update employee's role_id (enables mobile app access with this role)
                const updateResult = await client.query(
                    `UPDATE employees
                     SET role_id = $1,
                         updated_at = NOW()
                     WHERE id = $2 AND tenant_id = $3
                     RETURNING id, full_name, role_id`,
                    [finalRoleId, employeeId, tenantId]
                );

                const updated = updateResult.rows[0];
                console.log(`[Employees/SyncRole] ✅ Rol actualizado para ${updated.full_name}: role_id=${updated.role_id}`);

                // IMPORTANT: Only ONE mobile app permission per employee
                // Delete both first, then assign the correct one based on role
                await client.query(
                    `DELETE FROM employee_mobile_app_permissions
                     WHERE employee_id = $1 AND tenant_id = $2
                     AND permission_key IN ('AccessMobileAppAsAdmin', 'AccessMobileAppAsDistributor')`,
                    [employeeId, tenantId]
                );

                // Determine which mobile permission to assign based on role name
                // If mobileAppPermissionOverride is provided, use it (for custom roles like "Otro")
                // Otherwise, determine automatically based on role
                // Roles: 1=Administrador, 2=Encargado, 3=Repartidor, 4=Ayudante, 99=Otro
                let mobilePermission = mobileAppPermissionOverride || null;

                if (!mobilePermission) {
                    // Auto-assign based on role name if no override provided
                    if (roleName === 'Administrador') {
                        mobilePermission = 'AccessMobileAppAsAdmin';
                    } else if (roleName === 'Encargado') {
                        mobilePermission = 'AccessMobileAppAsAdmin';  // Encargado by default gets Admin access
                    } else if (roleName === 'Repartidor') {
                        mobilePermission = 'AccessMobileAppAsDistributor';
                    } else if (roleName === 'Ayudante') {
                        // Ayudante never gets mobile app access
                        mobilePermission = null;
                    } else if (roleName === 'Otro') {
                        // Custom role: admin must decide manually via mobileAppPermissionOverride
                        mobilePermission = null;
                    }
                }

                // Assign the appropriate permission (if role allows mobile access)
                if (mobilePermission) {
                    // Validate permission value
                    const validPermissions = ['AccessMobileAppAsAdmin', 'AccessMobileAppAsDistributor'];
                    if (!validPermissions.includes(mobilePermission)) {
                        return res.status(400).json({
                            success: false,
                            message: `Permiso inválido: ${mobilePermission}. Debe ser AccessMobileAppAsAdmin o AccessMobileAppAsDistributor`
                        });
                    }

                    await client.query(
                        `INSERT INTO employee_mobile_app_permissions (tenant_id, employee_id, permission_key, created_at, updated_at)
                         VALUES ($1, $2, $3, NOW(), NOW())
                         ON CONFLICT (tenant_id, employee_id, permission_key) DO UPDATE SET updated_at = NOW()`,
                        [tenantId, employeeId, mobilePermission]
                    );
                    console.log(`[Employees/SyncRole] 📱 Permiso de app móvil asignado: ${mobilePermission}`);
                } else {
                    console.log(`[Employees/SyncRole] ℹ️  Rol "${roleName}" no tiene permiso de app móvil asignado (Ayudante/Otro requieren configuración manual)`);
                }

                await client.query('COMMIT');

                // Get final permissions
                const finalPermsResult = await client.query(
                    `SELECT permission_key FROM employee_mobile_app_permissions WHERE employee_id = $1 AND tenant_id = $2`,
                    [employeeId, tenantId]
                );
                const finalPermissions = finalPermsResult.rows.map(r => r.permission_key);

                return res.json({
                    success: true,
                    message: 'Rol y permisos sincronizados exitosamente',
                    data: {
                        employeeId: updated.id,
                        fullName: updated.full_name,
                        roleId: updated.role_id,
                        roleName: roleName,
                        canUseMobileApp: true,
                        mobileAppPermissions: finalPermissions,
                        note: `Permiso de app móvil asignado automáticamente según rol: ${mobilePermission}`
                    }
                });

            } else if (canUseMobileApp === false) {
                // If canUseMobileApp is false, clear mobile app permissions
                await client.query('BEGIN');

                // Delete mobile app permissions
                await client.query(
                    `DELETE FROM employee_mobile_app_permissions WHERE employee_id = $1 AND tenant_id = $2`,
                    [employeeId, tenantId]
                );

                await client.query('COMMIT');

                console.log(`[Employees/SyncRole] ℹ️  Permisos de app móvil eliminados para ${employee.full_name}`);
                return res.json({
                    success: true,
                    message: 'Configuración actualizada',
                    data: {
                        employeeId: employee.id,
                        fullName: employee.full_name,
                        roleId: employee.role_id,
                        canUseMobileApp: false,
                        mobileAppPermissions: [],
                        note: 'Empleado sin acceso a App Móvil'
                    }
                });
            } else {
                // No role or canUseMobileApp provided, just return current state
                const permsResult = await client.query(
                    `SELECT permission_key FROM employee_mobile_app_permissions WHERE employee_id = $1 AND tenant_id = $2`,
                    [employeeId, tenantId]
                );

                const currentPerms = permsResult.rows.map(r => r.permission_key);

                return res.json({
                    success: true,
                    message: 'Estado actual',
                    data: {
                        employeeId: employee.id,
                        fullName: employee.full_name,
                        roleId: employee.role_id,
                        mobileAppPermissions: currentPerms
                    }
                });
            }

        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('[Employees/SyncRole] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar rol y permisos',
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
                `SELECT id, email, full_name, role_id, can_use_mobile_app FROM employees
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

            // Derive access type from role_id + can_use_mobile_app
            const accessType = getMobileAccessType(employee.role_id, employee.can_use_mobile_app);
            const hasMobileAccess = accessType !== 'none' && employee.can_use_mobile_app;

            return res.json({
                success: true,
                data: {
                    employeeId: employee.id,
                    email: employee.email,
                    fullName: employee.full_name,
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

    // PUT /api/employees/:id - Update employee mobile access
    // Allows updating mobile app access for an employee
    router.put('/:id', async (req, res) => {
        const client = await pool.connect();
        try {
            const employeeId = parseInt(req.params.id);
            const {
                tenantId,
                canUseMobileApp  // true or false
            } = req.body;

            // Validate parameters
            if (!employeeId || !tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: employeeId, tenantId'
                });
            }

            if (canUseMobileApp !== undefined && typeof canUseMobileApp !== 'boolean') {
                return res.status(400).json({
                    success: false,
                    message: 'canUseMobileApp debe ser true o false'
                });
            }

            // Verify employee exists and belongs to tenant
            const employeeCheck = await client.query(
                `SELECT id, email, full_name, role_id, can_use_mobile_app FROM employees
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

            // Update can_use_mobile_app if provided
            const updateResult = await client.query(
                `UPDATE employees
                 SET can_use_mobile_app = $1,
                     updated_at = NOW()
                 WHERE id = $2 AND tenant_id = $3
                 RETURNING id, email, full_name, role_id, can_use_mobile_app, updated_at`,
                [canUseMobileApp !== undefined ? canUseMobileApp : employee.can_use_mobile_app, employeeId, tenantId]
            );

            if (updateResult.rows.length > 0) {
                const updatedEmployee = updateResult.rows[0];
                const accessType = getMobileAccessType(updatedEmployee.role_id, updatedEmployee.can_use_mobile_app);

                console.log(`[Employees/UpdateMobileAccess] ✅ Acceso móvil actualizado: ${updatedEmployee.full_name} → ${accessType} (canUse: ${updatedEmployee.can_use_mobile_app})`);

                return res.json({
                    success: true,
                    message: 'Acceso a app móvil actualizado',
                    data: {
                        employeeId: updatedEmployee.id,
                        email: updatedEmployee.email,
                        fullName: updatedEmployee.full_name,
                        roleId: updatedEmployee.role_id,
                        canUseMobileApp: updatedEmployee.can_use_mobile_app,
                        mobileAccessType: accessType,
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
            console.error('[Employees/UpdateMobileAccess] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar acceso a app móvil',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    return router;
};
