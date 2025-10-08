// ═══════════════════════════════════════════════════════════════
// RUTAS DE TENANTS - Multi-Tenant System
// ═══════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = function(pool) {
    const router = require('express').Router();

    // ─────────────────────────────────────────────────────────
    // POST /api/tenants/register
    // Registro de nuevo negocio (Tenant)
    // ─────────────────────────────────────────────────────────
    router.post('/register', async (req, res) => {
        console.log('[Tenant Register] Nueva solicitud de registro');

        const {
            businessName,
            rfc,
            ownerEmail,
            phone,
            address,
            password,
            branchName = 'Sucursal Principal',
            ownerFullName,
            ownerUsername
        } = req.body;

        // Validaciones
        if (!businessName || !ownerEmail || !password) {
            return res.status(400).json({
                success: false,
                message: 'Datos incompletos: businessName, ownerEmail y password son requeridos'
            });
        }

        // Validar formato de email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(ownerEmail)) {
            return res.status(400).json({
                success: false,
                message: 'Formato de email inválido'
            });
        }

        // Validar longitud de contraseña
        if (password.length < 4) {
            return res.status(400).json({
                success: false,
                message: 'La contraseña debe tener al menos 4 caracteres'
            });
        }

        try {
            // Verificar si el email ya existe
            const existingTenant = await pool.query(
                'SELECT id FROM tenants WHERE LOWER(owner_email) = LOWER($1)',
                [ownerEmail]
            );

            if (existingTenant.rows.length > 0) {
                return res.status(409).json({
                    success: false,
                    message: 'Este email ya está registrado'
                });
            }

            // Hash de contraseña
            const hashedPassword = await bcrypt.hash(password, 10);

            // Iniciar transacción
            await pool.query('BEGIN');

            // 1. Crear Tenant
            const tenantResult = await pool.query(
                `INSERT INTO tenants (
                    business_name, rfc, owner_email, phone, address,
                    subscription_id, is_active
                )
                VALUES ($1, $2, $3, $4, $5, 1, true)
                RETURNING *`,
                [businessName, rfc || null, ownerEmail, phone || null, address || null]
            );

            const tenant = tenantResult.rows[0];
            console.log(`[Tenant Register] Tenant creado: ID ${tenant.id} - ${tenant.business_name}`);

            // 2. Crear Branch (Sucursal Principal)
            const branchResult = await pool.query(
                `INSERT INTO branches (
                    tenant_id, branch_code, name, is_active
                )
                VALUES ($1, 'BR001', $2, true)
                RETURNING *`,
                [tenant.id, branchName]
            );

            const branch = branchResult.rows[0];
            console.log(`[Tenant Register] Branch creado: ID ${branch.id} - ${branch.name}`);

            // 3. Crear Employee (Owner)
            const employeeResult = await pool.query(
                `INSERT INTO employees (
                    tenant_id, main_branch_id, email, username, password,
                    full_name, role, is_active
                )
                VALUES ($1, $2, $3, $4, $5, $6, 'owner', true)
                RETURNING id, tenant_id, main_branch_id, email, username, full_name, role, is_active, created_at`,
                [
                    tenant.id,
                    branch.id,
                    ownerEmail,
                    ownerUsername || ownerEmail.split('@')[0],
                    hashedPassword,
                    ownerFullName || businessName
                ]
            );

            const employee = employeeResult.rows[0];
            console.log(`[Tenant Register] Employee creado: ID ${employee.id} - ${employee.full_name} (owner)`);

            // 4. Asignar empleado a la sucursal principal
            await pool.query(
                `INSERT INTO employee_branches (
                    employee_id, branch_id,
                    can_login, can_sell, can_manage_inventory, can_close_shift
                )
                VALUES ($1, $2, true, true, true, true)`,
                [employee.id, branch.id]
            );

            console.log(`[Tenant Register] Empleado asignado a sucursal principal`);

            // 5. Obtener plan de suscripción
            const subscription = await pool.query(
                'SELECT name, max_branches, max_devices, max_employees FROM subscriptions WHERE id = $1',
                [tenant.subscription_id]
            );

            const plan = subscription.rows[0];

            // Commit
            await pool.query('COMMIT');

            console.log(`[Tenant Register] ✅ Registro completado exitosamente`);

            // Respuesta
            res.status(201).json({
                success: true,
                message: 'Negocio registrado exitosamente',
                data: {
                    tenant: {
                        id: tenant.id,
                        businessName: tenant.business_name,
                        ownerEmail: tenant.owner_email,
                        rfc: tenant.rfc,
                        phone: tenant.phone,
                        address: tenant.address
                    },
                    branch: {
                        id: branch.id,
                        code: branch.branch_code,
                        name: branch.name
                    },
                    employee: {
                        id: employee.id,
                        email: employee.email,
                        username: employee.username,
                        fullName: employee.full_name,
                        role: employee.role
                    },
                    subscription: {
                        plan: plan.name,
                        maxBranches: plan.max_branches,
                        maxDevices: plan.max_devices,
                        maxEmployees: plan.max_employees
                    }
                }
            });

        } catch (error) {
            // Rollback en caso de error
            await pool.query('ROLLBACK');

            console.error('[Tenant Register] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al registrar negocio',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/tenants/:id
    // Obtener información de un tenant
    // ─────────────────────────────────────────────────────────
    router.get('/:id', async (req, res) => {
        const { id } = req.params;

        try {
            const result = await pool.query(`
                SELECT
                    t.*,
                    s.name as subscription_name,
                    s.max_branches,
                    s.max_devices,
                    s.max_employees
                FROM tenants t
                JOIN subscriptions s ON t.subscription_id = s.id
                WHERE t.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const tenant = result.rows[0];

            // Contar sucursales, empleados
            const branchCount = await pool.query(
                'SELECT COUNT(*) FROM branches WHERE tenant_id = $1',
                [id]
            );

            const employeeCount = await pool.query(
                'SELECT COUNT(*) FROM employees WHERE tenant_id = $1',
                [id]
            );

            res.json({
                success: true,
                data: {
                    id: tenant.id,
                    businessName: tenant.business_name,
                    rfc: tenant.rfc,
                    ownerEmail: tenant.owner_email,
                    phone: tenant.phone,
                    address: tenant.address,
                    subscription: {
                        name: tenant.subscription_name,
                        maxBranches: tenant.max_branches,
                        maxDevices: tenant.max_devices,
                        maxEmployees: tenant.max_employees,
                        expiresAt: tenant.subscription_expires_at
                    },
                    stats: {
                        branches: parseInt(branchCount.rows[0].count),
                        employees: parseInt(employeeCount.rows[0].count)
                    },
                    isActive: tenant.is_active,
                    createdAt: tenant.created_at
                }
            });

        } catch (error) {
            console.error('[Tenant Get] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener tenant',
                error: error.message
            });
        }
    });

    return router;
};
