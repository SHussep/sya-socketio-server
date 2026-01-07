// ═══════════════════════════════════════════════════════════════
// EMPLOYEES ROUTES - Handle employee synchronization from Desktop
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');

module.exports = (pool) => {
    const router = express.Router();

    // ═════════════════════════════════════════════════════════════
    // HELPER: Detect if a string is already a BCrypt hash
    // ═════════════════════════════════════════════════════════════
    const isBcryptHash = (str) => {
        if (!str || typeof str !== 'string') return false;
        // BCrypt hashes start with $2a$, $2b$, or $2y$ and are 60 chars
        return /^\$2[aby]\$\d{2}\$.{53}$/.test(str);
    };

    // ═════════════════════════════════════════════════════════════
    // HELPER: Hash password if not already hashed
    // ═════════════════════════════════════════════════════════════
    const ensurePasswordHashed = async (password) => {
        if (!password) return null;
        if (isBcryptHash(password)) return password; // Already hashed
        // Hash plain text password
        return await bcrypt.hash(password, 10);
    };

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

    // POST /api/employees - Sync employee from Desktop or Mobile app
    // Handles password hashing and mobile-specific logic
    router.post('/', async (req, res) => {
        const client = await pool.connect();
        try {
            const {
                tenantId,
                branchId,
                fullName,
                username,
                email,
                password,  // Plain text from mobile, BCrypt hash from Desktop
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

            // Detectar origen: móvil vs desktop
            const isFromMobile = terminal_id === 'MOBILE-APP';

            // ═════════════════════════════════════════════════════════════
            // VALIDACIÓN ESPECIAL PARA CREACIÓN DESDE MÓVIL
            // ═════════════════════════════════════════════════════════════
            // Si se crea desde móvil Y quiere acceso a app móvil, DEBE tener contraseña
            const requestedMobileAccess = req.body.canUseMobileApp === true ||
                (req.body.canUseMobileApp === undefined && [1, 2, 3].includes(roleId));

            if (isFromMobile && requestedMobileAccess && !password) {
                console.log(`[Employees/Sync] ❌ Empleado creado desde móvil sin contraseña: ${fullName}`);
                return res.status(400).json({
                    success: false,
                    message: 'Para crear un empleado con acceso móvil desde la app, debe proporcionar una contraseña',
                    errorCode: 'MOBILE_PASSWORD_REQUIRED'
                });
            }

            // Auto-generar username: prioridad username > email > fullName
            const derivedUsername = username
                || (email ? email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : null)
                || (fullName ? fullName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : null);

            console.log(`[Employees/Sync] 🔄 Sincronizando empleado: ${fullName} (${derivedUsername}) - Tenant: ${tenantId}, Role: ${roleId}`);
            console.log(`[Employees/Sync] 🔑 GlobalId: ${global_id || 'null'}, TerminalId: ${terminal_id || 'null'}, Origen: ${isFromMobile ? 'MOBILE' : 'DESKTOP'}`);

            // Validate required fields (email ya NO es requerido - puede ser null)
            if (!tenantId || !fullName || !global_id) {
                console.log(`[Employees/Sync] ❌ Datos incompletos`);
                return res.status(400).json({
                    success: false,
                    message: 'Faltan campos requeridos: tenantId, fullName, global_id'
                });
            }

            // Split fullName into first_name and last_name
            const nameParts = fullName.trim().split(/\s+/);
            const firstName = nameParts[0] || fullName;
            const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

            // Validar que el rol exista en la base de datos para este tenant
            let mappedRoleId = roleId;
            if (roleId) {
                const roleCheck = await client.query(
                    `SELECT id, name FROM roles WHERE id = $1 AND tenant_id = $2`,
                    [roleId, tenantId]
                );

                if (roleCheck.rows.length === 0) {
                    // Buscar roles válidos para mostrar en el mensaje de error
                    const validRoles = await client.query(
                        `SELECT id, name FROM roles WHERE tenant_id = $1 ORDER BY id`,
                        [tenantId]
                    );
                    const validRolesList = validRoles.rows.map(r => `${r.id} (${r.name})`).join(', ');
                    console.log(`[Employees/Sync] ❌ Rol no válido: ${roleId}. Roles válidos para tenant ${tenantId}: ${validRolesList}`);
                    return res.status(400).json({
                        success: false,
                        message: `Rol no válido. Roles disponibles para este tenant: ${validRolesList}`
                    });
                }
                mappedRoleId = roleId;
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

                // ✅ Hash password if provided (handles plain text from mobile)
                const hashedPasswordForUpdate = await ensurePasswordHashed(password);

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
                            hashedPasswordForUpdate,  // ✅ Always BCrypt hashed
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

            // ✅ Ensure password is hashed (handles both plain text from mobile and hashed from desktop)
            const hashedPassword = await ensurePasswordHashed(password);
            if (password && hashedPassword) {
                console.log(`[Employees/Sync] 🔐 Password ${isBcryptHash(password) ? 'already hashed' : 'hashed from plain text'}`);
            }

            try {
                await client.query('BEGIN');

                // ✅ Empleados creados desde móvil: auto-verificar email (no tienen acceso a Gmail)
                const emailVerified = isFromMobile ? true : false;
                if (isFromMobile) {
                    console.log(`[Employees/Sync] 📧 Email auto-verificado para empleado creado desde móvil`);
                }

                const insertResult = await client.query(
                    `INSERT INTO employees
                     (tenant_id, first_name, last_name, username, email, password_hash, main_branch_id, role_id, can_use_mobile_app, is_active, email_verified, global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw, updated_at, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
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
                         email_verified = CASE WHEN EXCLUDED.email_verified = true THEN true ELSE employees.email_verified END,
                         updated_at = NOW()
                     RETURNING id, tenant_id, first_name, last_name, username, email, main_branch_id, role_id, can_use_mobile_app, is_active, email_verified, created_at, updated_at`,
                    [
                        tenantId,
                        firstName,
                        lastName,
                        derivedUsername,  // ✅ Username auto-generado del email
                        email,
                        hashedPassword,   // ✅ Always BCrypt hashed
                        branchId || mainBranchId,
                        mappedRoleId || null,
                        canUseMobileApp,
                        isActive !== false,
                        emailVerified,    // ✅ Auto-verificado si es de móvil
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

    // GET /api/employees - Get all ACTIVE employees for a tenant
    // Parámetro opcional: includeInactive=true para admins que necesitan ver todos
    router.get('/', async (req, res) => {
        try {
            const { tenantId, includeInactive } = req.query;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenantId'
                });
            }

            // Por defecto solo retornar empleados activos (soft delete)
            const activeFilter = includeInactive === 'true' ? '' : 'AND is_active = true';

            const result = await pool.query(
                `SELECT e.id, e.tenant_id, e.first_name, e.last_name, e.username, e.email, e.is_active,
                        e.role_id, r.name as role_name,
                        e.main_branch_id, e.can_use_mobile_app, e.google_user_identifier,
                        e.global_id, e.terminal_id, e.local_op_seq, e.created_local_utc, e.device_event_raw,
                        e.email_verified, e.is_owner,
                        e.created_at, e.updated_at
                 FROM employees e
                 LEFT JOIN roles r ON e.role_id = r.id
                 WHERE e.tenant_id = $1 ${activeFilter}
                 ORDER BY e.first_name ASC, e.last_name ASC`,
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

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/employees/pull - Descargar empleados para sincronización (Caja Auxiliar)
    // Soporta sincronización incremental con parámetro 'since'
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/pull', async (req, res) => {
        try {
            const { tenantId, branchId, since } = req.query;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenantId'
                });
            }

            console.log(`[Employees/Pull] 📥 Descargando empleados - Tenant: ${tenantId}, Branch: ${branchId || 'ALL'}, Since: ${since || 'ALL'}`);

            let query = `
                SELECT
                    e.id,
                    e.global_id,
                    e.tenant_id,
                    TRIM(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, ''))) as name,
                    e.username,
                    e.email,
                    e.is_active,
                    e.role_id,
                    r.global_id as role_global_id,
                    r.name as role_name,
                    e.main_branch_id,
                    e.can_use_mobile_app as has_mobile_access,
                    e.is_owner,
                    e.password_hash,
                    e.created_at,
                    e.updated_at
                FROM employees e
                LEFT JOIN roles r ON e.role_id = r.id
            `;

            const params = [tenantId];
            let paramIndex = 2;

            // Si hay branchId, filtrar por empleados de esa sucursal
            if (branchId) {
                query += `
                    INNER JOIN employee_branches eb ON e.id = eb.employee_id AND eb.branch_id = $${paramIndex}
                `;
                params.push(branchId);
                paramIndex++;
            }

            query += ` WHERE e.tenant_id = $1`;

            // Filtrar por fecha si se proporciona 'since'
            if (since) {
                query += ` AND e.updated_at > $${paramIndex}`;
                params.push(since);
                paramIndex++;
            }

            query += ` ORDER BY e.updated_at ASC`;

            const result = await pool.query(query, params);

            // Obtener timestamp más reciente para próximo pull
            let lastSync = null;
            if (result.rows.length > 0) {
                const lastRow = result.rows[result.rows.length - 1];
                lastSync = lastRow.updated_at;
            }

            console.log(`[Employees/Pull] ✅ ${result.rows.length} empleados encontrados`);

            res.json({
                success: true,
                data: {
                    employees: result.rows,
                    last_sync: lastSync
                },
                count: result.rows.length
            });

        } catch (error) {
            console.error('[Employees/Pull] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al descargar empleados',
                error: error.message
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

            // Get all roles with their permissions (tenant-specific roles)
            const result = await pool.query(
                `SELECT r.id, r.name, r.description, r.is_system, r.mobile_access_type, r.global_id,
                        ARRAY_AGG(p.code) as permission_codes,
                        ARRAY_AGG(json_build_object('code', p.code, 'name', p.name, 'description', p.description)) as permissions
                 FROM roles r
                 LEFT JOIN role_permissions rp ON rp.role_id = r.id
                 LEFT JOIN permissions p ON p.id = rp.permission_id
                 WHERE r.tenant_id = $1
                 GROUP BY r.id, r.name, r.description, r.is_system, r.mobile_access_type, r.global_id
                 ORDER BY r.is_system DESC, r.name ASC`,
                [tenantId]
            );

            // Clean up null values from aggregated arrays
            const cleanedRoles = result.rows.map(role => ({
                id: role.id,
                name: role.name,
                description: role.description,
                isSystem: role.is_system,
                mobileAccessType: role.mobile_access_type,  // 'admin', 'distributor', 'none'
                canAccessMobile: role.mobile_access_type !== 'none',
                globalId: role.global_id,
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

    // POST /api/roles - Create or sync a role from Desktop
    router.post('/roles', async (req, res) => {
        const client = await pool.connect();
        try {
            const {
                tenantId,
                name,
                description,
                isSystem,
                mobileAccessType,
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc
            } = req.body;

            console.log(`[Roles/Sync] 📥 Sincronizando rol: ${name} (tenant: ${tenantId})`);

            // Validaciones básicas
            if (!tenantId || !name) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenantId y name'
                });
            }

            if (!global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere global_id para sincronización'
                });
            }

            await client.query('BEGIN');

            // Verificar si ya existe por global_id
            const existingByGlobalId = await client.query(
                `SELECT id, name FROM roles WHERE global_id = $1`,
                [global_id]
            );

            let roleId;
            let isNew = false;

            if (existingByGlobalId.rows.length > 0) {
                // Actualizar rol existente
                roleId = existingByGlobalId.rows[0].id;
                console.log(`[Roles/Sync] 🔄 Actualizando rol existente ID: ${roleId}`);

                await client.query(
                    `UPDATE roles SET
                        name = $1,
                        description = $2,
                        mobile_access_type = $3,
                        updated_at = NOW()
                     WHERE id = $4`,
                    [name, description || null, mobileAccessType || 'none', roleId]
                );
            } else {
                // Verificar si ya existe un rol con el mismo nombre para este tenant
                const existingByName = await client.query(
                    `SELECT id FROM roles WHERE tenant_id = $1 AND name = $2`,
                    [tenantId, name]
                );

                if (existingByName.rows.length > 0) {
                    // Ya existe con ese nombre, actualizar global_id
                    roleId = existingByName.rows[0].id;
                    console.log(`[Roles/Sync] 🔗 Vinculando rol existente "${name}" (ID: ${roleId}) con global_id`);

                    await client.query(
                        `UPDATE roles SET
                            global_id = $1,
                            description = COALESCE($2, description),
                            mobile_access_type = COALESCE($3, mobile_access_type),
                            terminal_id = $4,
                            local_op_seq = $5,
                            created_local_utc = $6,
                            updated_at = NOW()
                         WHERE id = $7`,
                        [global_id, description, mobileAccessType, terminal_id, local_op_seq, created_local_utc, roleId]
                    );
                } else {
                    // Crear nuevo rol
                    isNew = true;
                    console.log(`[Roles/Sync] ➕ Creando nuevo rol: ${name}`);

                    const insertResult = await client.query(
                        `INSERT INTO roles
                            (tenant_id, name, description, is_system, mobile_access_type,
                             global_id, terminal_id, local_op_seq, created_local_utc, created_at, updated_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
                         RETURNING id`,
                        [
                            tenantId,
                            name,
                            description || null,
                            isSystem || false,
                            mobileAccessType || 'none',
                            global_id,
                            terminal_id,
                            local_op_seq || 0,
                            created_local_utc
                        ]
                    );

                    roleId = insertResult.rows[0].id;
                }
            }

            await client.query('COMMIT');

            console.log(`[Roles/Sync] ✅ Rol ${isNew ? 'creado' : 'actualizado'}: ${name} (ID: ${roleId})`);

            res.json({
                success: true,
                message: isNew ? 'Rol creado exitosamente' : 'Rol actualizado exitosamente',
                data: {
                    id: roleId,
                    name,
                    global_id,
                    isNew
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Roles/Sync] ❌ Error:', error.message);

            // Verificar si es error de unicidad
            if (error.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'Ya existe un rol con ese nombre para este tenant',
                    error: error.detail
                });
            }

            res.status(500).json({
                success: false,
                message: 'Error al sincronizar rol',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // PUT /api/roles/:roleId - Update a role (only non-system roles)
    router.put('/roles/:roleId', async (req, res) => {
        const client = await pool.connect();
        try {
            const roleId = parseInt(req.params.roleId);
            const { tenantId, name, description, mobileAccessType } = req.body;

            console.log(`[Roles/Update] 🔄 Actualizando rol ID: ${roleId}`);

            if (!roleId || !tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere roleId y tenantId'
                });
            }

            // Verificar que el rol existe y pertenece al tenant
            const roleCheck = await client.query(
                `SELECT id, name, is_system FROM roles WHERE id = $1 AND tenant_id = $2`,
                [roleId, tenantId]
            );

            if (roleCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Rol no encontrado'
                });
            }

            // No permitir editar roles del sistema
            if (roleCheck.rows[0].is_system) {
                return res.status(403).json({
                    success: false,
                    message: 'No se pueden editar los roles del sistema'
                });
            }

            await client.query('BEGIN');

            await client.query(
                `UPDATE roles SET
                    name = COALESCE($1, name),
                    description = COALESCE($2, description),
                    mobile_access_type = COALESCE($3, mobile_access_type),
                    updated_at = NOW()
                 WHERE id = $4`,
                [name, description, mobileAccessType, roleId]
            );

            await client.query('COMMIT');

            console.log(`[Roles/Update] ✅ Rol actualizado: ${name || roleCheck.rows[0].name}`);

            res.json({
                success: true,
                message: 'Rol actualizado exitosamente'
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Roles/Update] ❌ Error:', error.message);

            if (error.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'Ya existe un rol con ese nombre'
                });
            }

            res.status(500).json({
                success: false,
                message: 'Error al actualizar rol',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // DELETE /api/roles/:roleId - Delete a role (only non-system roles)
    router.delete('/roles/:roleId', async (req, res) => {
        const client = await pool.connect();
        try {
            const roleId = parseInt(req.params.roleId);
            const { tenantId } = req.body;

            console.log(`[Roles/Delete] 🗑️ Eliminando rol ID: ${roleId}`);

            if (!roleId || !tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere roleId y tenantId'
                });
            }

            // Verificar que el rol existe y pertenece al tenant
            const roleCheck = await client.query(
                `SELECT id, name, is_system FROM roles WHERE id = $1 AND tenant_id = $2`,
                [roleId, tenantId]
            );

            if (roleCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Rol no encontrado'
                });
            }

            // No permitir eliminar roles del sistema
            if (roleCheck.rows[0].is_system) {
                return res.status(403).json({
                    success: false,
                    message: 'No se pueden eliminar los roles del sistema (Administrador, Encargado, Repartidor, Ayudante)'
                });
            }

            // Verificar que no haya empleados asignados a este rol
            const employeesWithRole = await client.query(
                `SELECT COUNT(*) as count FROM employees WHERE role_id = $1`,
                [roleId]
            );

            if (parseInt(employeesWithRole.rows[0].count) > 0) {
                return res.status(409).json({
                    success: false,
                    message: `No se puede eliminar el rol porque hay ${employeesWithRole.rows[0].count} empleado(s) asignado(s)`
                });
            }

            await client.query('BEGIN');

            // Eliminar permisos del rol primero
            await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);

            // Eliminar el rol
            await client.query(`DELETE FROM roles WHERE id = $1`, [roleId]);

            await client.query('COMMIT');

            console.log(`[Roles/Delete] ✅ Rol eliminado: ${roleCheck.rows[0].name}`);

            res.json({
                success: true,
                message: 'Rol eliminado exitosamente'
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Roles/Delete] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar rol',
                error: error.message
            });
        } finally {
            client.release();
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
                roleName,  // Fallback si roleId es null (Desktop envía nombre del rol)
                canUseMobileApp,
                fullName,
                isActive,
                email,
                password_hash,        // ✅ Nuevo: para sincronizar cambios de contraseña
                passwordUpdatedAt     // ✅ Nuevo: timestamp del cambio de contraseña
            } = req.body;

            console.log(`[Employees/Update] 🔄 [UPDATE RECIBIDO] Actualizando empleado ID: ${employeeId}`);
            console.log(`[Employees/Update] 📝 Payload: ${JSON.stringify({ tenantId, roleId, roleName, canUseMobileApp, fullName, isActive, email })}`);

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

            // La validación del roleId se hace más adelante contra la BD

            // Split fullName if provided
            let firstName, lastName;
            if (fullName !== undefined) {
                const nameParts = fullName.trim().split(/\s+/);
                firstName = nameParts[0] || fullName;
                lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
            }

            // Verify employee exists and belongs to tenant
            const employeeCheck = await client.query(
                `SELECT id, email, first_name, last_name, role_id, can_use_mobile_app, is_active FROM employees
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

            // ═════════════════════════════════════════════════════════════
            // PREVENIR REACTIVACIÓN DE EMPLEADOS ELIMINADOS (SOFT DELETE)
            // ═════════════════════════════════════════════════════════════
            // Un empleado marcado como is_active = false NO puede ser reactivado
            if (isActive === true && employee.is_active === false) {
                const employeeFullName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim();
                console.log(`[Employees/Update] ❌ Intento de reactivar empleado eliminado: ${employeeFullName} (ID: ${employeeId})`);
                return res.status(400).json({
                    success: false,
                    message: 'No se puede reactivar un empleado eliminado. Si necesita este empleado, créelo nuevamente.',
                    errorCode: 'CANNOT_REACTIVATE_DELETED'
                });
            }

            // If roleId is being updated, verify it exists for this tenant
            // Desktop puede enviar roleId (PostgreSQL ID) o roleName (para mapeo)
            let resolvedRoleId = roleId;

            // Si roleId es null pero tenemos roleName, buscar el rol por nombre
            if ((resolvedRoleId === undefined || resolvedRoleId === null) && roleName) {
                const roleByName = await client.query(
                    `SELECT id, name FROM roles WHERE name = $1 AND tenant_id = $2`,
                    [roleName, tenantId]
                );
                if (roleByName.rows.length > 0) {
                    resolvedRoleId = roleByName.rows[0].id;
                    console.log(`[Employees/Update] 🔗 Rol resuelto por nombre: "${roleName}" → ID ${resolvedRoleId}`);
                } else {
                    console.log(`[Employees/Update] ⚠️ Rol "${roleName}" no encontrado para tenant ${tenantId}`);
                }
            }

            if (resolvedRoleId !== undefined && resolvedRoleId !== null && resolvedRoleId !== employee.role_id) {
                const roleCheck = await client.query(
                    `SELECT id, name FROM roles WHERE id = $1 AND tenant_id = $2`,
                    [resolvedRoleId, tenantId]
                );

                if (roleCheck.rows.length === 0) {
                    // Buscar roles válidos para mostrar en el mensaje de error
                    const validRoles = await client.query(
                        `SELECT id, name FROM roles WHERE tenant_id = $1 ORDER BY id`,
                        [tenantId]
                    );
                    const validRolesList = validRoles.rows.map(r => `${r.id} (${r.name})`).join(', ');
                    return res.status(400).json({
                        success: false,
                        message: `Rol ${resolvedRoleId} no válido. Roles disponibles: ${validRolesList}`
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

            if (resolvedRoleId !== undefined && resolvedRoleId !== null) {
                updates.push(`role_id = $${paramIndex}`);
                params.push(resolvedRoleId);
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

            // ✅ Nuevo: Sincronizar cambios de contraseña desde Desktop
            if (password_hash !== undefined && password_hash !== null && password_hash.length > 0) {
                updates.push(`password_hash = $${paramIndex}`);
                params.push(password_hash);
                paramIndex++;
                // También actualizar password_updated_at
                updates.push(`password_updated_at = NOW()`);
                console.log(`[Employees/Update] 🔐 Actualizando password_hash para empleado ${employeeId}`);
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

    // ═══════════════════════════════════════════════════════════════════════
    // VERIFICACIÓN DE EMAIL - Desktop genera código, lo guarda aquí, valida aquí
    // ═══════════════════════════════════════════════════════════════════════

    // POST /api/employees/:id/verification-code - Desktop guarda el código de verificación
    router.post('/:id/verification-code', async (req, res) => {
        const client = await pool.connect();
        try {
            const employeeId = parseInt(req.params.id);
            const { tenantId, code, expiresAt } = req.body;

            console.log(`[Employees/VerificationCode] 🔑 Guardando código de verificación para empleado ID: ${employeeId}`);

            if (!employeeId || !tenantId || !code) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: employeeId, tenantId, code'
                });
            }

            // Verificar que el empleado existe
            const employeeCheck = await client.query(
                `SELECT id, email FROM employees WHERE id = $1 AND tenant_id = $2`,
                [employeeId, tenantId]
            );

            if (employeeCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Empleado no encontrado'
                });
            }

            // Guardar código de verificación (expira en 24h por defecto)
            const expiration = expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

            await client.query(
                `UPDATE employees
                 SET verification_code = $1, verification_expires_at = $2, updated_at = NOW()
                 WHERE id = $3 AND tenant_id = $4`,
                [code, expiration, employeeId, tenantId]
            );

            console.log(`[Employees/VerificationCode] ✅ Código guardado para ${employeeCheck.rows[0].email}, expira: ${expiration}`);

            return res.json({
                success: true,
                message: 'Código de verificación guardado',
                expiresAt: expiration
            });

        } catch (error) {
            console.error('[Employees/VerificationCode] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al guardar código de verificación',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // POST /api/employees/verify-email - Valida código y marca email como verificado
    router.post('/verify-email', async (req, res) => {
        const client = await pool.connect();
        try {
            const { email, code, tenantId } = req.body;

            console.log(`[Employees/VerifyEmail] 🔍 Verificando código para email: ${email}`);

            if (!email || !code) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: email, code'
                });
            }

            // Buscar empleado con código válido y no expirado
            let query = `
                UPDATE employees
                SET email_verified = true, verification_code = NULL, verification_expires_at = NULL, updated_at = NOW()
                WHERE LOWER(email) = LOWER($1)
                  AND verification_code = $2
                  AND verification_expires_at > NOW()
            `;
            const params = [email, code];

            // Si se proporciona tenantId, agregar filtro
            if (tenantId) {
                query = `
                    UPDATE employees
                    SET email_verified = true, verification_code = NULL, verification_expires_at = NULL, updated_at = NOW()
                    WHERE LOWER(email) = LOWER($1)
                      AND verification_code = $2
                      AND verification_expires_at > NOW()
                      AND tenant_id = $3
                `;
                params.push(tenantId);
            }

            query += ' RETURNING id, email, first_name, last_name';

            const result = await client.query(query, params);

            if (result.rowCount === 0) {
                console.log(`[Employees/VerifyEmail] ❌ Código inválido o expirado para: ${email}`);
                return res.status(400).json({
                    success: false,
                    message: 'Código inválido o expirado'
                });
            }

            const employee = result.rows[0];
            const fullName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim();

            console.log(`[Employees/VerifyEmail] ✅ Email verificado para: ${fullName} (${employee.email})`);

            return res.json({
                success: true,
                message: 'Email verificado exitosamente',
                data: {
                    employeeId: employee.id,
                    email: employee.email,
                    fullName: fullName,
                    emailVerified: true
                }
            });

        } catch (error) {
            console.error('[Employees/VerifyEmail] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al verificar email',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // GET /api/employees/:id/verification-status - Obtiene estado de verificación de email
    router.get('/:id/verification-status', async (req, res) => {
        try {
            const employeeId = parseInt(req.params.id);
            const { tenantId } = req.query;

            if (!employeeId) {
                return res.status(400).json({
                    success: false,
                    message: 'employeeId es requerido'
                });
            }

            let query = `SELECT id, email, email_verified, verification_expires_at FROM employees WHERE id = $1`;
            const params = [employeeId];

            if (tenantId) {
                query += ' AND tenant_id = $2';
                params.push(tenantId);
            }

            const result = await pool.query(query, params);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Empleado no encontrado'
                });
            }

            const employee = result.rows[0];

            return res.json({
                success: true,
                data: {
                    employeeId: employee.id,
                    email: employee.email,
                    emailVerified: employee.email_verified,
                    verificationPending: employee.verification_expires_at && !employee.email_verified,
                    verificationExpiresAt: employee.verification_expires_at
                }
            });

        } catch (error) {
            console.error('[Employees/VerificationStatus] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener estado de verificación',
                error: error.message
            });
        }
    });

    return router;
};
