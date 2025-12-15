// ═══════════════════════════════════════════════════════════════
// RUTAS DE SUPER ADMIN - Panel de Administración de Licencias
// Solo accesible con PIN + autenticación especial
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

// PIN hasheado (SHA256) - Cambiar en producción
// Default PIN: 147258 (cambiar por el tuyo)
const SUPER_ADMIN_PIN_HASH = process.env.SUPER_ADMIN_PIN_HASH || crypto.createHash('sha256').update('147258').digest('hex');

// Middleware de autenticación Super Admin
function authenticateSuperAdmin(req, res, next) {
    const authHeader = req.headers['x-admin-pin'];

    if (!authHeader) {
        return res.status(401).json({
            success: false,
            message: 'PIN de administrador requerido'
        });
    }

    const pinHash = crypto.createHash('sha256').update(authHeader).digest('hex');

    if (pinHash !== SUPER_ADMIN_PIN_HASH) {
        return res.status(403).json({
            success: false,
            message: 'PIN incorrecto'
        });
    }

    next();
}

module.exports = function(pool, io) {
    const router = require('express').Router();

    // Aplicar autenticación a todas las rutas
    router.use(authenticateSuperAdmin);

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/dashboard
    // Resumen general del sistema
    // ─────────────────────────────────────────────────────────
    router.get('/dashboard', async (req, res) => {
        try {
            // Queries en paralelo para mejor performance
            const [
                tenantsResult,
                branchesResult,
                employeesResult,
                telemetryResult,
                scaleConfigResult,
                recentTenantsResult,
                subscriptionDistribution
            ] = await Promise.all([
                // Total tenants
                pool.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active = true) as active FROM tenants'),

                // Total sucursales
                pool.query('SELECT COUNT(*) as total FROM branches'),

                // Total empleados
                pool.query('SELECT COUNT(*) as total FROM employees WHERE is_active = true'),

                // Total aperturas de app (telemetry)
                pool.query(`
                    SELECT
                        COUNT(*) as total_events,
                        COUNT(*) FILTER (WHERE event_type = 'app_open') as app_opens,
                        COUNT(DISTINCT tenant_id) as unique_tenants_with_activity
                    FROM telemetry_events
                `),

                // Sucursales con báscula configurada
                pool.query(`
                    SELECT COUNT(DISTINCT branch_id) as branches_with_scale
                    FROM telemetry_events
                    WHERE event_type = 'scale_configured'
                `),

                // Tenants registrados en últimos 30 días
                pool.query(`
                    SELECT COUNT(*) as recent
                    FROM tenants
                    WHERE created_at >= NOW() - INTERVAL '30 days'
                `),

                // Distribución por subscription
                pool.query(`
                    SELECT
                        s.name as plan,
                        COUNT(t.id) as count
                    FROM tenants t
                    JOIN subscriptions s ON t.subscription_id = s.id
                    GROUP BY s.name
                    ORDER BY count DESC
                `)
            ]);

            // Tenants por estado de suscripción
            const statusResult = await pool.query(`
                SELECT
                    subscription_status,
                    COUNT(*) as count
                FROM tenants
                GROUP BY subscription_status
            `);

            // Tenants con trial por expirar (próximos 7 días)
            const expiringResult = await pool.query(`
                SELECT COUNT(*) as expiring_soon
                FROM tenants
                WHERE subscription_status = 'trial'
                AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
            `);

            res.json({
                success: true,
                data: {
                    overview: {
                        totalTenants: parseInt(tenantsResult.rows[0].total),
                        activeTenants: parseInt(tenantsResult.rows[0].active),
                        totalBranches: parseInt(branchesResult.rows[0].total),
                        totalEmployees: parseInt(employeesResult.rows[0].total),
                        branchesWithScale: parseInt(scaleConfigResult.rows[0].branches_with_scale),
                        recentRegistrations: parseInt(recentTenantsResult.rows[0].recent)
                    },
                    telemetry: {
                        totalEvents: parseInt(telemetryResult.rows[0].total_events),
                        appOpens: parseInt(telemetryResult.rows[0].app_opens),
                        uniqueActiveTenantsWithTelemetry: parseInt(telemetryResult.rows[0].unique_tenants_with_activity)
                    },
                    subscriptionDistribution: subscriptionDistribution.rows,
                    statusDistribution: statusResult.rows,
                    alerts: {
                        trialsExpiringSoon: parseInt(expiringResult.rows[0].expiring_soon)
                    }
                }
            });

        } catch (error) {
            console.error('[SuperAdmin Dashboard] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener dashboard',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/tenants
    // Lista de todos los tenants con detalles
    // ─────────────────────────────────────────────────────────
    router.get('/tenants', async (req, res) => {
        try {
            const { status, search, sort = 'created_at', order = 'desc' } = req.query;

            let query = `
                SELECT
                    t.id,
                    t.tenant_code,
                    t.business_name,
                    t.email,
                    t.phone_number,
                    t.subscription_id,
                    t.subscription_status,
                    t.trial_ends_at,
                    t.is_active,
                    t.created_at,
                    s.name as subscription_name,
                    s.max_branches,
                    s.max_devices,
                    s.max_employees,
                    (SELECT COUNT(*) FROM branches WHERE tenant_id = t.id) as branch_count,
                    (SELECT COUNT(*) FROM employees WHERE tenant_id = t.id AND is_active = true) as employee_count,
                    (SELECT COUNT(*) FROM telemetry_events WHERE tenant_id = t.id AND event_type = 'app_open') as app_opens,
                    (SELECT COUNT(DISTINCT branch_id) FROM telemetry_events WHERE tenant_id = t.id AND event_type = 'scale_configured') as branches_with_scale,
                    (SELECT MAX(event_timestamp) FROM telemetry_events WHERE tenant_id = t.id) as last_activity
                FROM tenants t
                JOIN subscriptions s ON t.subscription_id = s.id
                WHERE 1=1
            `;

            const params = [];

            if (status) {
                params.push(status);
                query += ` AND t.subscription_status = $${params.length}`;
            }

            if (search) {
                params.push(`%${search}%`);
                query += ` AND (t.business_name ILIKE $${params.length} OR t.email ILIKE $${params.length})`;
            }

            // Validar columnas de ordenamiento
            const validSortColumns = ['created_at', 'business_name', 'trial_ends_at', 'app_opens'];
            const sortColumn = validSortColumns.includes(sort) ? sort : 'created_at';
            const sortOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

            query += ` ORDER BY ${sortColumn} ${sortOrder}`;

            const result = await pool.query(query, params);

            // Calcular días restantes para cada tenant
            const tenants = result.rows.map(tenant => {
                const now = new Date();
                const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
                const daysRemaining = trialEndsAt ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)) : null;
                const isExpired = trialEndsAt ? trialEndsAt < now : false;

                return {
                    id: tenant.id,
                    tenantCode: tenant.tenant_code,
                    businessName: tenant.business_name,
                    email: tenant.email,
                    phoneNumber: tenant.phone_number,
                    subscription: {
                        id: tenant.subscription_id,
                        name: tenant.subscription_name,
                        status: tenant.subscription_status,
                        maxBranches: tenant.max_branches,
                        maxDevices: tenant.max_devices,
                        maxEmployees: tenant.max_employees
                    },
                    trial: {
                        endsAt: tenant.trial_ends_at,
                        daysRemaining: Math.max(0, daysRemaining || 0),
                        isExpired: isExpired
                    },
                    stats: {
                        branches: parseInt(tenant.branch_count),
                        employees: parseInt(tenant.employee_count),
                        appOpens: parseInt(tenant.app_opens),
                        branchesWithScale: parseInt(tenant.branches_with_scale)
                    },
                    lastActivity: tenant.last_activity,
                    isActive: tenant.is_active,
                    createdAt: tenant.created_at
                };
            });

            res.json({
                success: true,
                count: tenants.length,
                data: tenants
            });

        } catch (error) {
            console.error('[SuperAdmin Tenants] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener tenants',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/tenants/:id
    // Detalles completos de un tenant
    // ─────────────────────────────────────────────────────────
    router.get('/tenants/:id', async (req, res) => {
        try {
            const { id } = req.params;

            // Información del tenant
            const tenantResult = await pool.query(`
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

            if (tenantResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];

            // Sucursales del tenant
            const branchesResult = await pool.query(`
                SELECT
                    b.id,
                    b.branch_code,
                    b.name,
                    b.address,
                    b.is_active,
                    b.created_at,
                    (SELECT COUNT(*) FROM employees e
                     JOIN employee_branches eb ON e.id = eb.employee_id
                     WHERE eb.branch_id = b.id AND e.is_active = true) as employee_count,
                    (SELECT COUNT(*) FROM telemetry_events WHERE branch_id = b.id AND event_type = 'scale_configured') > 0 as has_scale,
                    (SELECT MAX(event_timestamp) FROM telemetry_events WHERE branch_id = b.id) as last_activity
                FROM branches b
                WHERE b.tenant_id = $1
                ORDER BY b.created_at
            `, [id]);

            // Empleados del tenant
            const employeesResult = await pool.query(`
                SELECT
                    e.id,
                    e.email,
                    e.username,
                    e.first_name,
                    e.last_name,
                    e.role_id,
                    r.name as role_name,
                    e.is_owner,
                    e.is_active,
                    e.created_at
                FROM employees e
                LEFT JOIN roles r ON e.role_id = r.id
                WHERE e.tenant_id = $1
                ORDER BY e.is_owner DESC, e.created_at
            `, [id]);

            // Telemetría del tenant
            const telemetryResult = await pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE event_type = 'app_open') as app_opens,
                    COUNT(DISTINCT DATE(event_timestamp)) as active_days,
                    MIN(event_timestamp) as first_activity,
                    MAX(event_timestamp) as last_activity
                FROM telemetry_events
                WHERE tenant_id = $1
            `, [id]);

            // Actividad por día (últimos 30 días)
            const activityResult = await pool.query(`
                SELECT
                    DATE(event_timestamp) as date,
                    COUNT(*) as events
                FROM telemetry_events
                WHERE tenant_id = $1
                AND event_timestamp >= NOW() - INTERVAL '30 days'
                GROUP BY DATE(event_timestamp)
                ORDER BY date DESC
            `, [id]);

            // Ventas totales (si quieres métricas de negocio)
            const salesResult = await pool.query(`
                SELECT
                    COUNT(*) as total_sales,
                    COALESCE(SUM(total), 0) as total_revenue
                FROM ventas
                WHERE tenant_id = $1
            `, [id]);

            const now = new Date();
            const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
            const daysRemaining = trialEndsAt ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)) : null;

            res.json({
                success: true,
                data: {
                    tenant: {
                        id: tenant.id,
                        tenantCode: tenant.tenant_code,
                        businessName: tenant.business_name,
                        email: tenant.email,
                        phoneNumber: tenant.phone_number,
                        isActive: tenant.is_active,
                        createdAt: tenant.created_at
                    },
                    subscription: {
                        id: tenant.subscription_id,
                        name: tenant.subscription_name,
                        status: tenant.subscription_status,
                        maxBranches: tenant.max_branches,
                        maxDevices: tenant.max_devices,
                        maxEmployees: tenant.max_employees,
                        trialEndsAt: tenant.trial_ends_at,
                        daysRemaining: Math.max(0, daysRemaining || 0),
                        isExpired: trialEndsAt ? trialEndsAt < now : false
                    },
                    branches: branchesResult.rows.map(b => ({
                        id: b.id,
                        code: b.branch_code,
                        name: b.name,
                        address: b.address,
                        employeeCount: parseInt(b.employee_count),
                        hasScale: b.has_scale,
                        lastActivity: b.last_activity,
                        isActive: b.is_active,
                        createdAt: b.created_at
                    })),
                    employees: employeesResult.rows.map(e => ({
                        id: e.id,
                        email: e.email,
                        username: e.username,
                        name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
                        role: e.role_name,
                        roleId: e.role_id,
                        isOwner: e.is_owner,
                        isActive: e.is_active,
                        createdAt: e.created_at
                    })),
                    telemetry: {
                        appOpens: parseInt(telemetryResult.rows[0]?.app_opens || 0),
                        activeDays: parseInt(telemetryResult.rows[0]?.active_days || 0),
                        firstActivity: telemetryResult.rows[0]?.first_activity,
                        lastActivity: telemetryResult.rows[0]?.last_activity
                    },
                    activityHistory: activityResult.rows,
                    businessMetrics: {
                        totalSales: parseInt(salesResult.rows[0]?.total_sales || 0),
                        totalRevenue: parseFloat(salesResult.rows[0]?.total_revenue || 0)
                    }
                }
            });

        } catch (error) {
            console.error('[SuperAdmin Tenant Detail] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener detalles del tenant',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // PUT /api/superadmin/tenants/:id
    // Actualizar tenant (tier, fecha expiración, status)
    // ─────────────────────────────────────────────────────────
    router.put('/tenants/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const {
                subscriptionId,
                subscriptionStatus,
                trialEndsAt,
                isActive,
                businessName,
                phoneNumber
            } = req.body;

            // Verificar que el tenant existe
            const existingTenant = await pool.query(
                'SELECT * FROM tenants WHERE id = $1',
                [id]
            );

            if (existingTenant.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            // Construir query dinámico
            const updates = [];
            const values = [];
            let paramCount = 0;

            if (subscriptionId !== undefined) {
                paramCount++;
                updates.push(`subscription_id = $${paramCount}`);
                values.push(subscriptionId);
            }

            if (subscriptionStatus !== undefined) {
                paramCount++;
                updates.push(`subscription_status = $${paramCount}`);
                values.push(subscriptionStatus);
            }

            if (trialEndsAt !== undefined) {
                paramCount++;
                updates.push(`trial_ends_at = $${paramCount}`);
                values.push(trialEndsAt);
            }

            if (isActive !== undefined) {
                paramCount++;
                updates.push(`is_active = $${paramCount}`);
                values.push(isActive);
            }

            if (businessName !== undefined) {
                paramCount++;
                updates.push(`business_name = $${paramCount}`);
                values.push(businessName);
            }

            if (phoneNumber !== undefined) {
                paramCount++;
                updates.push(`phone_number = $${paramCount}`);
                values.push(phoneNumber);
            }

            if (updates.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No hay campos para actualizar'
                });
            }

            // Agregar updated_at
            paramCount++;
            updates.push(`updated_at = $${paramCount}`);
            values.push(new Date());

            // Agregar ID al final
            paramCount++;
            values.push(id);

            const result = await pool.query(`
                UPDATE tenants
                SET ${updates.join(', ')}
                WHERE id = $${paramCount}
                RETURNING *
            `, values);

            // Obtener subscription name
            const subResult = await pool.query(
                'SELECT name FROM subscriptions WHERE id = $1',
                [result.rows[0].subscription_id]
            );

            console.log(`[SuperAdmin] Tenant ${id} actualizado:`, req.body);

            res.json({
                success: true,
                message: 'Tenant actualizado correctamente',
                data: {
                    id: result.rows[0].id,
                    tenantCode: result.rows[0].tenant_code,
                    businessName: result.rows[0].business_name,
                    subscriptionId: result.rows[0].subscription_id,
                    subscriptionName: subResult.rows[0]?.name,
                    subscriptionStatus: result.rows[0].subscription_status,
                    trialEndsAt: result.rows[0].trial_ends_at,
                    isActive: result.rows[0].is_active,
                    updatedAt: result.rows[0].updated_at
                }
            });

        } catch (error) {
            console.error('[SuperAdmin Update Tenant] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar tenant',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/subscriptions
    // Lista de planes de suscripción disponibles
    // ─────────────────────────────────────────────────────────
    router.get('/subscriptions', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    id,
                    name,
                    max_branches,
                    max_devices,
                    max_devices_per_branch,
                    max_employees,
                    features,
                    is_active
                FROM subscriptions
                ORDER BY id
            `);

            res.json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            console.error('[SuperAdmin Subscriptions] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener suscripciones',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // PUT /api/superadmin/subscriptions/:id
    // Actualizar plan de suscripción
    // ─────────────────────────────────────────────────────────
    router.put('/subscriptions/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const {
                name,
                maxBranches,
                maxDevices,
                maxDevicesPerBranch,
                maxEmployees,
                features,
                isActive
            } = req.body;

            const updates = [];
            const values = [];
            let paramCount = 0;

            if (name !== undefined) {
                paramCount++;
                updates.push(`name = $${paramCount}`);
                values.push(name);
            }
            if (maxBranches !== undefined) {
                paramCount++;
                updates.push(`max_branches = $${paramCount}`);
                values.push(maxBranches);
            }
            if (maxDevices !== undefined) {
                paramCount++;
                updates.push(`max_devices = $${paramCount}`);
                values.push(maxDevices);
            }
            if (maxDevicesPerBranch !== undefined) {
                paramCount++;
                updates.push(`max_devices_per_branch = $${paramCount}`);
                values.push(maxDevicesPerBranch);
            }
            if (maxEmployees !== undefined) {
                paramCount++;
                updates.push(`max_employees = $${paramCount}`);
                values.push(maxEmployees);
            }
            if (features !== undefined) {
                paramCount++;
                updates.push(`features = $${paramCount}`);
                values.push(JSON.stringify(features));
            }
            if (isActive !== undefined) {
                paramCount++;
                updates.push(`is_active = $${paramCount}`);
                values.push(isActive);
            }

            if (updates.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No hay campos para actualizar'
                });
            }

            paramCount++;
            updates.push(`updated_at = $${paramCount}`);
            values.push(new Date());

            paramCount++;
            values.push(id);

            const result = await pool.query(`
                UPDATE subscriptions
                SET ${updates.join(', ')}
                WHERE id = $${paramCount}
                RETURNING *
            `, values);

            res.json({
                success: true,
                message: 'Suscripción actualizada',
                data: result.rows[0]
            });

        } catch (error) {
            console.error('[SuperAdmin Update Subscription] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar suscripción',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/telemetry/stats
    // Estadísticas detalladas de telemetría
    // ─────────────────────────────────────────────────────────
    router.get('/telemetry/stats', async (req, res) => {
        try {
            const { days = 30 } = req.query;

            // Aperturas por día
            const dailyOpens = await pool.query(`
                SELECT
                    DATE(event_timestamp) as date,
                    COUNT(*) as opens,
                    COUNT(DISTINCT tenant_id) as unique_tenants
                FROM telemetry_events
                WHERE event_type = 'app_open'
                AND event_timestamp >= NOW() - INTERVAL '${parseInt(days)} days'
                GROUP BY DATE(event_timestamp)
                ORDER BY date DESC
            `);

            // Top tenants por actividad
            const topTenants = await pool.query(`
                SELECT
                    t.id,
                    t.business_name,
                    COUNT(*) as app_opens,
                    MAX(te.event_timestamp) as last_activity
                FROM telemetry_events te
                JOIN tenants t ON te.tenant_id = t.id
                WHERE te.event_type = 'app_open'
                AND te.event_timestamp >= NOW() - INTERVAL '${parseInt(days)} days'
                GROUP BY t.id, t.business_name
                ORDER BY app_opens DESC
                LIMIT 10
            `);

            // Versiones de app en uso
            const appVersions = await pool.query(`
                SELECT
                    app_version,
                    COUNT(DISTINCT tenant_id) as tenants_count,
                    COUNT(*) as total_opens
                FROM telemetry_events
                WHERE event_type = 'app_open'
                AND app_version IS NOT NULL
                AND event_timestamp >= NOW() - INTERVAL '${parseInt(days)} days'
                GROUP BY app_version
                ORDER BY tenants_count DESC
            `);

            // Modelos de báscula
            const scaleModels = await pool.query(`
                SELECT
                    scale_model,
                    COUNT(DISTINCT tenant_id) as tenants_count
                FROM telemetry_events
                WHERE event_type = 'scale_configured'
                AND scale_model IS NOT NULL
                GROUP BY scale_model
                ORDER BY tenants_count DESC
            `);

            res.json({
                success: true,
                data: {
                    dailyActivity: dailyOpens.rows,
                    topTenants: topTenants.rows,
                    appVersions: appVersions.rows,
                    scaleModels: scaleModels.rows
                }
            });

        } catch (error) {
            console.error('[SuperAdmin Telemetry Stats] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener estadísticas de telemetría',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/verify-pin
    // Verificar PIN (para login inicial en la app)
    // ─────────────────────────────────────────────────────────
    router.post('/verify-pin', (req, res) => {
        // Si llegó aquí, el PIN es válido (pasó el middleware)
        res.json({
            success: true,
            message: 'PIN válido',
            authenticated: true
        });
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/extend-trial/:tenantId
    // Extender trial de un tenant (shortcut útil)
    // ─────────────────────────────────────────────────────────
    router.post('/extend-trial/:tenantId', async (req, res) => {
        try {
            const { tenantId } = req.params;
            const { days = 30 } = req.body;

            const result = await pool.query(`
                UPDATE tenants
                SET
                    trial_ends_at = GREATEST(trial_ends_at, NOW()) + INTERVAL '${parseInt(days)} days',
                    subscription_status = 'trial',
                    updated_at = NOW()
                WHERE id = $1
                RETURNING id, business_name, trial_ends_at
            `, [tenantId]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            console.log(`[SuperAdmin] Trial extendido ${days} días para tenant ${tenantId}`);

            res.json({
                success: true,
                message: `Trial extendido ${days} días`,
                data: {
                    tenantId: result.rows[0].id,
                    businessName: result.rows[0].business_name,
                    newTrialEndsAt: result.rows[0].trial_ends_at
                }
            });

        } catch (error) {
            console.error('[SuperAdmin Extend Trial] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al extender trial',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/activate-subscription/:tenantId
    // Activar suscripción de pago
    // ─────────────────────────────────────────────────────────
    router.post('/activate-subscription/:tenantId', async (req, res) => {
        try {
            const { tenantId } = req.params;
            const { subscriptionId, months = 1 } = req.body;

            const expiresAt = new Date();
            expiresAt.setMonth(expiresAt.getMonth() + parseInt(months));

            const result = await pool.query(`
                UPDATE tenants
                SET
                    subscription_id = $1,
                    subscription_status = 'active',
                    trial_ends_at = $2,
                    updated_at = NOW()
                WHERE id = $3
                RETURNING *
            `, [subscriptionId, expiresAt, tenantId]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            // Obtener nombre del plan
            const subResult = await pool.query(
                'SELECT name FROM subscriptions WHERE id = $1',
                [subscriptionId]
            );

            console.log(`[SuperAdmin] Suscripción activada para tenant ${tenantId}: Plan ${subResult.rows[0]?.name}, ${months} meses`);

            res.json({
                success: true,
                message: 'Suscripción activada correctamente',
                data: {
                    tenantId: result.rows[0].id,
                    businessName: result.rows[0].business_name,
                    subscriptionName: subResult.rows[0]?.name,
                    status: 'active',
                    expiresAt: expiresAt
                }
            });

        } catch (error) {
            console.error('[SuperAdmin Activate Subscription] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al activar suscripción',
                error: error.message
            });
        }
    });

    return router;
};
