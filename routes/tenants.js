// ═══════════════════════════════════════════════════════════════
// RUTAS DE TENANTS - Multi-Tenant System
// ═══════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = function(pool, io) {
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
            console.log(`[Tenant Register] 🔍 Verificando email: ${ownerEmail}`);

            // Verificar si el email ya existe
            const existingTenant = await pool.query(
                'SELECT id FROM tenants WHERE LOWER(email) = LOWER($1)',
                [ownerEmail]
            );

            if (existingTenant.rows.length > 0) {
                console.log(`[Tenant Register] ❌ Email ya existe: ${ownerEmail}`);
                return res.status(409).json({
                    success: false,
                    message: 'Este email ya está registrado'
                });
            }

            console.log(`[Tenant Register] ✅ Email disponible. Iniciando registro...`);

            // Hash de contraseña
            const hashedPassword = await bcrypt.hash(password, 10);
            console.log(`[Tenant Register] 🔐 Password hasheado`);

            // Iniciar transacción
            await pool.query('BEGIN');
            console.log(`[Tenant Register] 📝 Transacción iniciada`);

            // 1. Crear Tenant con fecha de expiración del trial (30 días)
            const trialEndsAt = new Date();
            trialEndsAt.setDate(trialEndsAt.getDate() + 30); // Agregar 30 días

            // Generar tenant_code único (formato: TEN + timestamp)
            const tenantCode = `TEN${Date.now()}`;

            console.log(`[Tenant Register] 📊 Datos a insertar en tenants:`);
            console.log(`  - tenant_code: ${tenantCode}`);
            console.log(`  - business_name: ${businessName}`);
            console.log(`  - email: ${ownerEmail}`);
            console.log(`  - phone_number: ${phone || null}`);
            console.log(`  - subscription_id: 1 (Trial)`);
            console.log(`  - trial_ends_at: ${trialEndsAt.toISOString()}`);

            const tenantResult = await pool.query(
                `INSERT INTO tenants (
                    tenant_code, business_name, email, phone_number,
                    subscription_id, trial_ends_at, is_active
                )
                VALUES ($1, $2, $3, $4, 1, $5, true)
                RETURNING *`,
                [tenantCode, businessName, ownerEmail, phone || null, trialEndsAt]
            );

            const tenant = tenantResult.rows[0];
            console.log(`[Tenant Register] ✅ Tenant creado exitosamente:`);
            console.log(`  - ID: ${tenant.id}`);
            console.log(`  - tenant_code: ${tenant.tenant_code}`);
            console.log(`  - business_name: ${tenant.business_name}`);
            console.log(`  - subscription_id: ${tenant.subscription_id}`);
            console.log(`  - trial_ends_at: ${tenant.trial_ends_at}`);

            // 2. Crear Branch (Sucursal Principal)
            console.log(`[Tenant Register] 🏢 Creando branch: ${branchName}`);

            const branchResult = await pool.query(
                `INSERT INTO branches (
                    tenant_id, branch_code, name, is_active
                )
                VALUES ($1, 'BR001', $2, true)
                RETURNING *`,
                [tenant.id, branchName]
            );

            const branch = branchResult.rows[0];
            console.log(`[Tenant Register] ✅ Branch creado: ID ${branch.id} - ${branch.name}`);

            // 3. Crear Employee (Owner)
            // Generar global_id único para el empleado
            const employeeGlobalId = `EMP-${tenant.id}-${Date.now()}`;
            const username = ownerUsername || ownerEmail.split('@')[0];
            const fullName = ownerFullName || businessName;

            console.log(`[Tenant Register] 👤 Creando employee (owner):`);
            console.log(`  - username: ${username}`);
            console.log(`  - email: ${ownerEmail}`);
            console.log(`  - first_name: ${fullName}`);
            console.log(`  - global_id: ${employeeGlobalId}`);

            const employeeResult = await pool.query(
                `INSERT INTO employees (
                    tenant_id, main_branch_id, email, username, password_hash,
                    first_name, role_id, is_owner, is_active, global_id, email_verified
                )
                VALUES ($1, $2, $3, $4, $5, $6, 1, true, true, $7, true)
                RETURNING id, tenant_id, main_branch_id, email, username, first_name, role_id, is_owner, is_active, created_at`,
                [
                    tenant.id,
                    branch.id,
                    ownerEmail,
                    username,
                    hashedPassword,
                    fullName,
                    employeeGlobalId
                ]
            );

            const employee = employeeResult.rows[0];
            console.log(`[Tenant Register] ✅ Employee creado: ID ${employee.id} - ${employee.first_name} (owner)`);

            // 4. Asignar empleado a la sucursal principal
            console.log(`[Tenant Register] 🔗 Asignando empleado a branch...`);

            await pool.query(
                `INSERT INTO employee_branches (
                    tenant_id, employee_id, branch_id,
                    can_login, can_sell, can_manage_inventory, can_close_shift
                )
                VALUES ($1, $2, $3, true, true, true, true)`,
                [tenant.id, employee.id, branch.id]
            );

            console.log(`[Tenant Register] ✅ Empleado asignado a sucursal principal`);

            // 5. Obtener plan de suscripción
            console.log(`[Tenant Register] 📋 Obteniendo plan de suscripción ID ${tenant.subscription_id}...`);

            const subscription = await pool.query(
                'SELECT name, max_branches, max_devices, max_employees FROM subscriptions WHERE id = $1',
                [tenant.subscription_id]
            );

            const plan = subscription.rows[0];
            console.log(`[Tenant Register] ✅ Plan obtenido: ${plan.name}`);

            // Commit
            await pool.query('COMMIT');

            console.log(`[Tenant Register] 💾 COMMIT exitoso - Registro completado`);
            console.log(`[Tenant Register] 🎉 RESUMEN FINAL:`);
            console.log(`  - Tenant ID: ${tenant.id}`);
            console.log(`  - Business: ${tenant.business_name}`);
            console.log(`  - Subscription: ${plan.name} (ID: ${tenant.subscription_id})`);
            console.log(`  - Trial ends: ${tenant.trial_ends_at}`);

            // 🔔 Emitir evento Socket.IO para Super Admin (nuevo tenant registrado)
            if (io) {
                io.emit('superadmin:new-tenant', {
                    id: tenant.id,
                    tenantCode: tenant.tenant_code,
                    businessName: tenant.business_name,
                    email: tenant.email,
                    phoneNumber: tenant.phone_number,
                    subscriptionPlan: plan.name,
                    trialEndsAt: tenant.trial_ends_at,
                    branch: {
                        id: branch.id,
                        name: branch.name
                    },
                    owner: {
                        id: employee.id,
                        email: employee.email,
                        name: employee.first_name
                    },
                    registeredAt: new Date().toISOString()
                });
                console.log(`[Tenant Register] 📡 Evento 'superadmin:new-tenant' emitido para Super Admin`);
            }

            // Respuesta - Incluir información del trial
            const trialInfo = {
                startDate: new Date(),
                expiresAt: trialEndsAt,
                daysRemaining: 30,
                isActive: true,
                status: 'trial'
            };

            res.status(201).json({
                success: true,
                message: 'Negocio registrado exitosamente',
                data: {
                    tenant: {
                        id: tenant.id,
                        tenantCode: tenant.tenant_code,
                        businessName: tenant.business_name,
                        email: tenant.email,
                        phoneNumber: tenant.phone_number,
                        trialEndsAt: tenant.trial_ends_at,
                        subscriptionStatus: tenant.subscription_status
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
                        firstName: employee.first_name,
                        roleId: employee.role_id,
                        isOwner: employee.is_owner
                    },
                    subscription: {
                        plan: plan.name,
                        maxBranches: plan.max_branches,
                        maxDevices: plan.max_devices,
                        maxEmployees: plan.max_employees,
                        trial: trialInfo
                    }
                }
            });

        } catch (error) {
            // Rollback en caso de error
            await pool.query('ROLLBACK');

            console.error('[Tenant Register] ❌❌❌ ERROR CRÍTICO ❌❌❌');
            console.error('[Tenant Register] Error message:', error.message);
            console.error('[Tenant Register] Error stack:', error.stack);
            console.error('[Tenant Register] Error code:', error.code);
            console.error('[Tenant Register] Error detail:', error.detail);
            console.error('[Tenant Register] 🔄 ROLLBACK ejecutado');

            res.status(500).json({
                success: false,
                message: 'Error al registrar negocio',
                error: undefined,
                errorCode: error.code,
                errorDetail: error.detail
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // DELETE /api/tenants/cleanup-all
    // SOLO PARA DESARROLLO: Eliminar todos los tenants
    // ─────────────────────────────────────────────────────────
    router.delete('/cleanup-all', async (req, res) => {
        console.log('[Tenant Cleanup] Eliminando todos los tenants...');

        try {
            await pool.query('BEGIN');

            // Eliminar en orden inverso por las foreign keys
            await pool.query('DELETE FROM employee_branches');
            await pool.query('DELETE FROM ventas');
            await pool.query('DELETE FROM expenses');
            await pool.query('DELETE FROM shifts');
            await pool.query('DELETE FROM employees');
            await pool.query('DELETE FROM branches');
            await pool.query('DELETE FROM tenants');

            await pool.query('COMMIT');

            console.log('[Tenant Cleanup] ✅ Todos los tenants eliminados');

            res.json({
                success: true,
                message: 'Todos los tenants han sido eliminados'
            });

        } catch (error) {
            await pool.query('ROLLBACK');
            console.error('[Tenant Cleanup] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar tenants',
                error: undefined
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
            console.log(`[Tenant Get] ID=${tenant.id}, business_name="${tenant.business_name}"`);

            // Contar sucursales, empleados
            const branchCount = await pool.query(
                'SELECT COUNT(*) FROM branches WHERE tenant_id = $1',
                [id]
            );

            const employeeCount = await pool.query(
                'SELECT COUNT(*) FROM employees WHERE tenant_id = $1',
                [id]
            );

            // Calcular información del trial
            const now = new Date();
            const expiresAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
            const isExpired = expiresAt ? expiresAt < now : false;
            const daysRemaining = expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : 0;

            const trialStatus = {
                isActive: !isExpired && daysRemaining > 0,
                isExpired: isExpired,
                daysRemaining: Math.max(0, daysRemaining),
                expiresAt: expiresAt.toISOString(),
                status: isExpired ? 'expired' : (daysRemaining <= 7 ? 'expiring_soon' : 'active')
            };

            res.json({
                success: true,
                data: {
                    id: tenant.id,
                    tenantCode: tenant.tenant_code,
                    businessName: tenant.business_name,
                    email: tenant.email,
                    phoneNumber: tenant.phone_number,
                    subscription: {
                        name: tenant.subscription_name,
                        maxBranches: tenant.max_branches,
                        maxDevices: tenant.max_devices,
                        maxEmployees: tenant.max_employees,
                        trialEndsAt: tenant.trial_ends_at,
                        subscriptionStatus: tenant.subscription_status,
                        trial: trialStatus
                    },
                    stats: {
                        branches: parseInt(branchCount.rows[0].count),
                        employees: parseInt(employeeCount.rows[0].count)
                    },
                    isActive: tenant.is_active && trialStatus.isActive,
                    createdAt: tenant.created_at
                }
            });

        } catch (error) {
            console.error('[Tenant Get] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener tenant',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/tenants/by-code/:tenantCode
    // Obtener información de licencia del tenant por código
    // (Sin autenticación - solo para sincronización de licencia en Desktop)
    // ─────────────────────────────────────────────────────────
    router.get('/by-code/:tenantCode', async (req, res) => {
        try {
            const { tenantCode } = req.params;

            console.log(`[Tenant By Code] Consultando tenant: ${tenantCode}`);

            const result = await pool.query(
                `SELECT
                    t.id,
                    t.tenant_code,
                    t.business_name,
                    t.trial_ends_at,
                    t.subscription_status,
                    t.subscription_id,
                    t.is_active,
                    s.name as subscription_name
                FROM tenants t
                LEFT JOIN subscriptions s ON t.subscription_id = s.id
                WHERE t.tenant_code = $1`,
                [tenantCode]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const tenant = result.rows[0];

            // Verificar si el trial expiró
            const now = new Date();
            const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
            const isExpired = trialEndsAt && trialEndsAt < now;
            const daysRemaining = trialEndsAt ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)) : null;

            console.log(`[Tenant By Code] ✅ Tenant encontrado: ${tenant.business_name}, Trial expira: ${trialEndsAt ? trialEndsAt.toISOString() : 'N/A'}, Días restantes: ${daysRemaining}`);

            res.json({
                success: true,
                data: {
                    id: tenant.id,
                    tenantCode: tenant.tenant_code,
                    businessName: tenant.business_name,
                    trialEndsAt: trialEndsAt,
                    subscriptionStatus: tenant.subscription_status || 'trial',
                    subscriptionName: tenant.subscription_name || 'Trial', // Nombre del plan
                    isActive: tenant.is_active,
                    isExpired: isExpired,
                    daysRemaining: daysRemaining
                }
            });

        } catch (error) {
            console.error('[Tenant By Code] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener tenant',
                error: undefined
            });
        }
    });

    return router;
};
