/**
 * Employee Roles API
 * Manage employee roles and permissions across the system
 *
 * This allows Desktop app to:
 * 1. Assign/update employee roles (Administrador or Repartidor)
 * 2. Grant/revoke specific permissions
 * 3. Check current employee permissions
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { createTenantValidationMiddleware } = require('../middleware/deviceAuth');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const validateTenant = createTenantValidationMiddleware(pool);

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/employees/:id/role
// Update employee's role (Administrador or Repartidor)
//
// Request Body:
// {
//   "tenantId": number,
//   "newRoleName": "Administrador" | "Repartidor"
// }
// ─────────────────────────────────────────────────────────────────────────

router.put('/:id/role', validateTenant, async (req, res) => {
    console.log(`[Employee Roles] PUT /api/employees/${req.params.id}/role`);

    const { id } = req.params;
    const { tenantId, newRoleName } = req.body;

    // Validate inputs
    if (!tenantId || !newRoleName) {
        return res.status(400).json({
            success: false,
            message: 'Faltan campos requeridos: tenantId, newRoleName'
        });
    }

    if (!['Administrador', 'Repartidor'].includes(newRoleName)) {
        return res.status(400).json({
            success: false,
            message: 'Role debe ser "Administrador" o "Repartidor"'
        });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Verify employee exists and belongs to tenant
        const employeeCheck = await client.query(
            'SELECT id, role_id FROM employees WHERE id = $1 AND tenant_id = $2',
            [id, tenantId]
        );

        if (employeeCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Empleado no encontrado'
            });
        }

        const employee = employeeCheck.rows[0];

        // 2. Get new role ID
        const roleResult = await client.query(
            'SELECT id, name FROM roles WHERE tenant_id = $1 AND name = $2',
            [tenantId, newRoleName]
        );

        if (roleResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: `Role "${newRoleName}" no existe para este tenant`
            });
        }

        const newRoleId = roleResult.rows[0].id;

        // Check if already has this role
        if (employee.role_id === newRoleId) {
            await client.query('ROLLBACK');
            return res.status(200).json({
                success: true,
                message: `Empleado ya tiene el rol "${newRoleName}"`,
                roleChanged: false,
                employee: {
                    id: employee.id,
                    roleId: newRoleId,
                    roleName: newRoleName
                }
            });
        }

        // 3. Update employee role
        const updateResult = await client.query(
            'UPDATE employees SET role_id = $1, updated_at = NOW() WHERE id = $2 RETURNING id, role_id',
            [newRoleId, id]
        );

        console.log(`[Employee Roles] ✅ Rol actualizado para empleado ${id}: ${newRoleName} (ID: ${newRoleId})`);

        // 4. Get full employee info with role and permissions
        const employeeWithPermissions = await client.query(`
            SELECT
                e.id,
                e.email,
                e.full_name,
                e.tenant_id,
                r.id as role_id,
                r.name as role_name,
                ARRAY_AGG(p.code) as permission_codes
            FROM employees e
            JOIN roles r ON e.role_id = r.id
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN permissions p ON rp.permission_id = p.id
            WHERE e.id = $1
            GROUP BY e.id, r.id
        `, [id]);

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: `Rol actualizado a "${newRoleName}"`,
            roleChanged: true,
            employee: employeeWithPermissions.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Employee Roles] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error al actualizar rol del empleado',
            error: undefined
        });
    } finally {
        client.release();
    }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/employees/:id/permissions
// Get all permissions for an employee
// ─────────────────────────────────────────────────────────────────────────

router.get('/:id/permissions', async (req, res) => {
    console.log(`[Employee Roles] GET /api/employees/${req.params.id}/permissions`);

    const { id } = req.params;
    const { tenantId } = req.query;

    if (!tenantId) {
        return res.status(400).json({
            success: false,
            message: 'tenantId es requerido'
        });
    }

    try {
        const result = await pool.query(`
            SELECT
                e.id,
                e.email,
                e.full_name,
                r.id as role_id,
                r.name as role_name,
                r.description as role_description,
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'code', p.code,
                        'name', p.name,
                        'description', p.description,
                        'category', p.category
                    )
                ) as permissions
            FROM employees e
            JOIN roles r ON e.role_id = r.id
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN permissions p ON rp.permission_id = p.id
            WHERE e.id = $1 AND e.tenant_id = $2 AND e.is_active = true
            GROUP BY e.id, r.id
        `, [id, tenantId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Empleado no encontrado'
            });
        }

        return res.status(200).json({
            success: true,
            employee: result.rows[0]
        });

    } catch (error) {
        console.error('[Employee Roles] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener permisos del empleado',
            error: undefined
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/roles
// Get available roles for a tenant
// ─────────────────────────────────────────────────────────────────────────

router.get('/by-tenant/:tenantId', async (req, res) => {
    console.log(`[Employee Roles] GET /api/roles by tenant`);

    const { tenantId } = req.params;

    try {
        const result = await pool.query(`
            SELECT
                r.id,
                r.name,
                r.description,
                r.is_system,
                COUNT(rp.id) as permission_count,
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'code', p.code,
                        'name', p.name
                    )
                ) FILTER (WHERE p.id IS NOT NULL) as permissions
            FROM roles r
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN permissions p ON rp.permission_id = p.id
            WHERE r.tenant_id = $1
            GROUP BY r.id
            ORDER BY r.is_system DESC, r.name
        `, [tenantId]);

        return res.status(200).json({
            success: true,
            roles: result.rows
        });

    } catch (error) {
        console.error('[Employee Roles] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener roles',
            error: undefined
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/permissions
// Get all available system permissions
// ─────────────────────────────────────────────────────────────────────────

router.get('/system/all', async (req, res) => {
    console.log('[Employee Roles] GET /api/permissions/system/all');

    try {
        const result = await pool.query(`
            SELECT
                id,
                code,
                name,
                description,
                category
            FROM permissions
            ORDER BY category, name
        `);

        return res.status(200).json({
            success: true,
            permissions: result.rows
        });

    } catch (error) {
        console.error('[Employee Roles] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener permisos del sistema',
            error: undefined
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/employees/sync-role
// Sync employee role from Desktop to PostgreSQL
//
// Used when Desktop creates/updates an employee and needs to sync their role
// Request Body:
// {
//   "tenantId": number,
//   "employeeId": number,
//   "desktopRole": "encargado" | "repartidor" | "ayudante",  // Desktop role
//   "hasMobileAppAccess": boolean  // Whether employee should have mobile app access
// }
// ─────────────────────────────────────────────────────────────────────────

router.post('/sync-role', validateTenant, async (req, res) => {
    console.log('[Employee Roles] POST /api/employees/sync-role');

    const { tenantId, employeeId, desktopRole, hasMobileAppAccess } = req.body;

    if (!tenantId || !employeeId || !desktopRole) {
        return res.status(400).json({
            success: false,
            message: 'Faltan campos requeridos: tenantId, employeeId, desktopRole'
        });
    }

    // Map Desktop roles to system roles
    const roleMapping = {
        'encargado': 'Administrador',   // Managers -> Admins
        'repartidor': 'Repartidor',      // Delivery agents -> Delivery
        'ayudante': 'Repartidor',        // Helpers -> Delivery
        'dueño': 'Administrador',        // Owner -> Admin
        'empleado': 'Repartidor'         // Generic employees -> Delivery
    };

    const systemRoleName = roleMapping[desktopRole.toLowerCase()] || 'Repartidor';

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Get system role ID
        const roleResult = await client.query(
            'SELECT id FROM roles WHERE tenant_id = $1 AND name = $2',
            [tenantId, systemRoleName]
        );

        if (roleResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: `Role "${systemRoleName}" no existe para este tenant`
            });
        }

        const roleId = roleResult.rows[0].id;

        // 2. Update employee role
        const updateResult = await client.query(
            `UPDATE employees
             SET role_id = $1, updated_at = NOW()
             WHERE id = $2 AND tenant_id = $3
             RETURNING id, email, full_name, role_id`,
            [roleId, employeeId, tenantId]
        );

        if (updateResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Empleado no encontrado'
            });
        }

        const employee = updateResult.rows[0];

        console.log(`[Employee Roles] ✅ Rol sincronizado para empleado ${employeeId}: ${systemRoleName}`);

        // 3. Get updated employee with permissions
        const employeeWithPermissions = await client.query(`
            SELECT
                e.id,
                e.email,
                e.full_name,
                r.id as role_id,
                r.name as role_name,
                ARRAY_AGG(p.code ORDER BY p.code) as permission_codes
            FROM employees e
            JOIN roles r ON e.role_id = r.id
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN permissions p ON rp.permission_id = p.id
            WHERE e.id = $1
            GROUP BY e.id, r.id
        `, [employeeId]);

        await client.query('COMMIT');

        return res.status(200).json({
            success: true,
            message: `Rol sincronizado: ${desktopRole} → ${systemRoleName}`,
            employee: employeeWithPermissions.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Employee Roles] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error al sincronizar rol del empleado',
            error: undefined
        });
    } finally {
        client.release();
    }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/employee-roles/by-uuid/:globalId/role
// Get employee's current role by UUID (global_id)
// Used by Desktop on login to check if role changed
//
// Query: ?tenantId=number
// ─────────────────────────────────────────────────────────────────────────

router.get('/by-uuid/:globalId/role', async (req, res) => {
    const { globalId } = req.params;
    const { tenantId } = req.query;

    console.log(`[Employee Roles] GET /api/employee-roles/by-uuid/${globalId}/role (tenant: ${tenantId})`);

    if (!globalId || !tenantId) {
        return res.status(400).json({
            success: false,
            message: 'Parámetros requeridos: globalId en URL, tenantId en query'
        });
    }

    try {
        const result = await pool.query(`
            SELECT
                e.id,
                e.global_id,
                e.first_name,
                e.last_name,
                e.email,
                e.main_branch_id,
                r.id as role_id,
                r.name as role_name,
                r.mobile_access_type,
                ARRAY_AGG(p.code) FILTER (WHERE p.code IS NOT NULL) as permission_codes
            FROM employees e
            JOIN roles r ON e.role_id = r.id
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN permissions p ON rp.permission_id = p.id
            WHERE e.global_id = $1 AND e.tenant_id = $2
            GROUP BY e.id, r.id
        `, [globalId, tenantId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Empleado no encontrado con ese UUID'
            });
        }

        const emp = result.rows[0];

        return res.json({
            success: true,
            data: {
                globalId: emp.global_id,
                employeeId: emp.id,
                fullName: `${emp.first_name} ${emp.last_name || ''}`.trim(),
                email: emp.email,
                roleId: emp.role_id,
                roleName: emp.role_name,
                mobileAccessType: emp.mobile_access_type,
                permissionCodes: emp.permission_codes || []
            }
        });

    } catch (error) {
        console.error('[Employee Roles] Error getting role by UUID:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error al obtener rol del empleado',
            error: undefined
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/employee-roles/by-uuid/:globalId/role
// Update employee's role by UUID (global_id)
// Used by Mobile app to change an employee's role
//
// Request Body:
// {
//   "tenantId": number,
//   "newRoleId": number  (PostgreSQL role ID for this tenant)
// }
// ─────────────────────────────────────────────────────────────────────────

router.put('/by-uuid/:globalId/role', validateTenant, async (req, res) => {
    const { globalId } = req.params;
    const { tenantId, newRoleId } = req.body;

    console.log(`[Employee Roles] PUT /api/employee-roles/by-uuid/${globalId}/role (tenant: ${tenantId}, newRoleId: ${newRoleId})`);

    if (!globalId || !tenantId || !newRoleId) {
        return res.status(400).json({
            success: false,
            message: 'Campos requeridos: globalId en URL, tenantId y newRoleId en body'
        });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Verify employee exists by global_id
        const employeeCheck = await client.query(
            'SELECT id, role_id, main_branch_id, first_name, last_name, email FROM employees WHERE global_id = $1 AND tenant_id = $2',
            [globalId, tenantId]
        );

        if (employeeCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Empleado no encontrado con ese UUID'
            });
        }

        const employee = employeeCheck.rows[0];

        // 2. Verify new role exists for this tenant
        const roleCheck = await client.query(
            'SELECT id, name, mobile_access_type FROM roles WHERE id = $1 AND tenant_id = $2',
            [newRoleId, tenantId]
        );

        if (roleCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: `Rol con ID ${newRoleId} no existe para este tenant`
            });
        }

        const newRole = roleCheck.rows[0];

        // 3. Check if already has this role
        if (employee.role_id === newRoleId) {
            await client.query('ROLLBACK');
            return res.json({
                success: true,
                message: `Empleado ya tiene el rol "${newRole.name}"`,
                roleChanged: false,
                data: {
                    globalId: globalId,
                    roleId: newRoleId,
                    roleName: newRole.name
                }
            });
        }

        // 4. Update employee role
        await client.query(
            'UPDATE employees SET role_id = $1, updated_at = NOW() WHERE id = $2',
            [newRoleId, employee.id]
        );

        // 5. Get updated employee with permissions
        const updatedEmployee = await client.query(`
            SELECT
                e.id,
                e.global_id,
                e.first_name,
                e.last_name,
                e.email,
                e.main_branch_id,
                r.id as role_id,
                r.name as role_name,
                r.mobile_access_type,
                ARRAY_AGG(p.code) FILTER (WHERE p.code IS NOT NULL) as permission_codes
            FROM employees e
            JOIN roles r ON e.role_id = r.id
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN permissions p ON rp.permission_id = p.id
            WHERE e.id = $1
            GROUP BY e.id, r.id
        `, [employee.id]);

        await client.query('COMMIT');

        const emp = updatedEmployee.rows[0];

        // 6. Emit Socket.IO event to notify other clients
        const io = req.app.get('io');
        if (io && employee.main_branch_id) {
            const eventData = {
                employeeGlobalId: globalId,
                employeeId: employee.id,
                employeeName: `${employee.first_name} ${employee.last_name || ''}`.trim(),
                newRoleId: newRoleId,
                newRoleName: newRole.name,
                mobileAccessType: newRole.mobile_access_type,
                tenantId: parseInt(tenantId),
                updatedAt: new Date().toISOString()
            };

            io.to(`branch_${employee.main_branch_id}`).emit('employee:role-updated', eventData);
            console.log(`[Employee Roles] 📡 Emitted employee:role-updated to branch_${employee.main_branch_id}`);
        }

        console.log(`[Employee Roles] ✅ Rol actualizado por UUID ${globalId}: ${newRole.name} (ID: ${newRoleId})`);

        return res.json({
            success: true,
            message: `Rol actualizado a "${newRole.name}"`,
            roleChanged: true,
            data: {
                globalId: emp.global_id,
                employeeId: emp.id,
                fullName: `${emp.first_name} ${emp.last_name || ''}`.trim(),
                roleId: emp.role_id,
                roleName: emp.role_name,
                mobileAccessType: emp.mobile_access_type,
                permissionCodes: emp.permission_codes || []
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Employee Roles] Error updating role by UUID:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error al actualizar rol del empleado',
            error: undefined
        });
    } finally {
        client.release();
    }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/employee-roles/roles/:roleId/permissions
// Sync role permissions from Desktop
// Replaces all permissions for a role with the given permission codes
//
// Request Body:
// {
//   "tenantId": number,
//   "permissionCodes": ["AccessPointOfSale", "ManageProducts", ...]
// }
// ─────────────────────────────────────────────────────────────────────────

router.put('/roles/:roleId/permissions', validateTenant, async (req, res) => {
    const { roleId } = req.params;
    const { tenantId, permissionCodes } = req.body;

    console.log(`[Employee Roles] PUT /api/employee-roles/roles/${roleId}/permissions (tenant: ${tenantId}, codes: ${permissionCodes?.length})`);

    if (!roleId || !tenantId || !Array.isArray(permissionCodes)) {
        return res.status(400).json({
            success: false,
            message: 'Campos requeridos: roleId en URL, tenantId y permissionCodes (array) en body'
        });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Verify role exists for this tenant
        const roleCheck = await client.query(
            'SELECT id, name FROM roles WHERE id = $1 AND tenant_id = $2',
            [roleId, tenantId]
        );

        if (roleCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: `Rol con ID ${roleId} no existe para este tenant`
            });
        }

        const role = roleCheck.rows[0];

        // 2. Get permission IDs from codes
        let permissionIds = [];
        if (permissionCodes.length > 0) {
            const permResult = await client.query(
                'SELECT id, code FROM permissions WHERE code = ANY($1)',
                [permissionCodes]
            );
            permissionIds = permResult.rows.map(p => p.id);

            if (permissionIds.length !== permissionCodes.length) {
                const foundCodes = permResult.rows.map(p => p.code);
                const missingCodes = permissionCodes.filter(c => !foundCodes.includes(c));
                console.log(`[Employee Roles] ⚠️ Permisos no encontrados: ${missingCodes.join(', ')}`);
            }
        }

        // 3. Delete existing role_permissions
        await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);

        // 4. Insert new role_permissions
        if (permissionIds.length > 0) {
            const values = permissionIds.map((pid, i) => `($1, $${i + 2})`).join(', ');
            const params = [roleId, ...permissionIds];
            await client.query(
                `INSERT INTO role_permissions (role_id, permission_id) VALUES ${values} ON CONFLICT DO NOTHING`,
                params
            );
        }

        // 5. Derive and update mobile_access_type from permissions
        const hasAdminAccess = permissionCodes.includes('AccessMobileAppAsAdmin');
        const hasDistributorAccess = permissionCodes.includes('AccessMobileAppAsDistributor');
        const newMobileAccessType = hasAdminAccess ? 'admin' : (hasDistributorAccess ? 'distributor' : 'none');

        await client.query(
            'UPDATE roles SET mobile_access_type = $1, updated_at = NOW() WHERE id = $2',
            [newMobileAccessType, roleId]
        );

        await client.query('COMMIT');

        console.log(`[Employee Roles] ✅ Permisos sincronizados para rol "${role.name}" (ID: ${roleId}): ${permissionIds.length} permisos, mobile_access_type=${newMobileAccessType}`);

        return res.json({
            success: true,
            message: `Permisos actualizados para rol "${role.name}"`,
            data: {
                roleId: parseInt(roleId),
                roleName: role.name,
                permissionCount: permissionIds.length,
                mobileAccessType: newMobileAccessType,
                permissionCodes: permissionCodes
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Employee Roles] Error syncing role permissions:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Error al sincronizar permisos del rol',
            error: undefined
        });
    } finally {
        client.release();
    }
});

module.exports = router;
