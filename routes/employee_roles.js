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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

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

router.put('/:id/role', async (req, res) => {
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
            error: error.message
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
            error: error.message
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
            error: error.message
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
            error: error.message
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

router.post('/sync-role', async (req, res) => {
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
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router;
