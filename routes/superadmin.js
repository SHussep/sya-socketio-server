// ═══════════════════════════════════════════════════════════════
// RUTAS DE SUPER ADMIN - Panel de Administración de Licencias
// Solo accesible con PIN + autenticación especial
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { superadminRateLimiter } = require('../middleware/rateLimiter');

// PIN hasheado (SHA256) - OBLIGATORIO via variable de entorno
const SUPER_ADMIN_PIN_HASH = process.env.SUPER_ADMIN_PIN_HASH;
if (!SUPER_ADMIN_PIN_HASH) {
    console.error('⚠️ SECURITY WARNING: SUPER_ADMIN_PIN_HASH no está configurado. Panel de superadmin deshabilitado.');
}

// Middleware de autenticación Super Admin
function authenticateSuperAdmin(req, res, next) {
    if (!SUPER_ADMIN_PIN_HASH) {
        return res.status(503).json({
            success: false,
            message: 'Panel de superadmin no configurado'
        });
    }

    const authHeader = req.headers['x-admin-pin'];

    if (!authHeader) {
        // No registrar como intento fallido si no envio PIN (puede ser un scan aleatorio)
        return res.status(401).json({
            success: false,
            message: 'PIN de administrador requerido'
        });
    }

    const pinHash = crypto.createHash('sha256').update(authHeader).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(pinHash), Buffer.from(SUPER_ADMIN_PIN_HASH))) {
        // Registrar intento fallido para rate limiting
        if (req.registerFailedSuperadminAttempt) {
            req.registerFailedSuperadminAttempt();
        }
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        console.warn(`[Security] PIN incorrecto desde IP: ${ip}`);
        return res.status(403).json({
            success: false,
            message: 'PIN incorrecto'
        });
    }

    // PIN correcto - limpiar intentos fallidos
    if (req.clearSuperadminAttempts) {
        req.clearSuperadminAttempts();
    }

    next();
}

module.exports = function(pool, io) {
    const router = require('express').Router();

    // Aplicar rate limiting ANTES de autenticación (bloquea IPs abusivas)
    router.use(superadminRateLimiter);

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
                error: undefined
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
                    (SELECT COUNT(*) FROM employees WHERE tenant_id = t.id) as employee_count,
                    (SELECT COUNT(*) FROM employees WHERE tenant_id = t.id AND is_active = true) as active_employee_count,
                    (SELECT COUNT(*) FROM telemetry_events WHERE tenant_id = t.id AND event_type = 'app_open') as app_opens,
                    (SELECT COUNT(DISTINCT branch_id) FROM telemetry_events WHERE tenant_id = t.id AND event_type = 'scale_configured') as branches_with_scale,
                    (SELECT COUNT(*) FROM ventas WHERE tenant_id = t.id) as total_sales,
                    (SELECT COALESCE(SUM(total), 0) FROM ventas WHERE tenant_id = t.id) as total_revenue,
                    (SELECT MAX(event_timestamp) FROM telemetry_events WHERE tenant_id = t.id) as last_activity,
                    (SELECT app_version FROM telemetry_events WHERE tenant_id = t.id AND app_version IS NOT NULL ORDER BY event_timestamp DESC LIMIT 1) as app_version,
                    (SELECT theme_name FROM telemetry_events WHERE tenant_id = t.id AND theme_name IS NOT NULL ORDER BY event_timestamp DESC LIMIT 1) as theme_name
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
                        activeEmployees: parseInt(tenant.active_employee_count),
                        appOpens: parseInt(tenant.app_opens),
                        branchesWithScale: parseInt(tenant.branches_with_scale),
                        totalSales: parseInt(tenant.total_sales),
                        totalRevenue: parseFloat(tenant.total_revenue)
                    },
                    lastActivity: tenant.last_activity,
                    appVersion: tenant.app_version,
                    themeName: tenant.theme_name,
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
                error: undefined
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

            // Versión de app más reciente
            const appVersionResult = await pool.query(`
                SELECT app_version
                FROM telemetry_events
                WHERE tenant_id = $1 AND app_version IS NOT NULL
                ORDER BY event_timestamp DESC
                LIMIT 1
            `, [id]);

            // Tema más reciente del tenant
            const themeResult = await pool.query(`
                SELECT theme_name
                FROM telemetry_events
                WHERE tenant_id = $1 AND theme_name IS NOT NULL
                ORDER BY event_timestamp DESC
                LIMIT 1
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
                        createdAt: tenant.created_at,
                        appVersion: appVersionResult.rows[0]?.app_version || null,
                        themeName: themeResult.rows[0]?.theme_name || null
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
                error: undefined
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
                error: undefined
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
                error: undefined
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
                error: undefined
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

            // Temas en uso (resumen)
            const themes = await pool.query(`
                SELECT
                    theme_name,
                    COUNT(DISTINCT tenant_id) as tenants_count,
                    COUNT(*) as total_opens
                FROM telemetry_events
                WHERE event_type = 'theme_changed'
                AND theme_name IS NOT NULL
                AND event_timestamp >= NOW() - INTERVAL '${parseInt(days)} days'
                GROUP BY theme_name
                ORDER BY tenants_count DESC
            `);

            // Tenants por tema (desglose)
            const themeTenantsResult = await pool.query(`
                SELECT DISTINCT ON (te.tenant_id)
                    te.theme_name,
                    te.tenant_id,
                    t.business_name
                FROM telemetry_events te
                JOIN tenants t ON te.tenant_id = t.id
                WHERE te.event_type = 'theme_changed'
                AND te.theme_name IS NOT NULL
                AND te.event_timestamp >= NOW() - INTERVAL '${parseInt(days)} days'
                ORDER BY te.tenant_id, te.event_timestamp DESC
            `);

            // Agrupar tenants por tema
            const themesWithTenants = themes.rows.map(theme => ({
                ...theme,
                tenants: themeTenantsResult.rows
                    .filter(t => t.theme_name === theme.theme_name)
                    .map(t => ({ id: t.tenant_id, businessName: t.business_name }))
            }));

            // ── Uso de app móvil por tenant (employee-level data) ──
            const mobileByTenant = await pool.query(`
                SELECT
                    t.id as tenant_id,
                    t.business_name,
                    COUNT(DISTINCT te.employee_id) as employees_with_app,
                    (SELECT COUNT(*) FROM employees WHERE tenant_id = t.id AND is_active = true) as total_employees,
                    COUNT(*) FILTER (WHERE te.event_type = 'app_open') as total_opens,
                    COUNT(*) FILTER (WHERE te.event_type = 'app_open' AND DATE(te.event_timestamp) = CURRENT_DATE) as opens_today,
                    MAX(te.event_timestamp) as last_activity
                FROM telemetry_events te
                JOIN tenants t ON te.tenant_id = t.id
                WHERE te.employee_id IS NOT NULL
                  AND te.event_type IN ('app_open', 'app_resume')
                  AND te.event_timestamp >= NOW() - INTERVAL '${parseInt(days)} days'
                GROUP BY t.id, t.business_name
                ORDER BY total_opens DESC
            `);

            // Detalle por empleado con tema y plataforma
            const mobileEmployees = await pool.query(`
                SELECT
                    te.employee_id,
                    te.tenant_id,
                    e.username,
                    CONCAT(e.first_name, ' ', e.last_name) as full_name,
                    r.name as role_name,
                    e.is_owner,
                    COUNT(*) FILTER (WHERE te.event_type = 'app_open') as app_opens,
                    COUNT(*) FILTER (WHERE te.event_type = 'app_open' AND DATE(te.event_timestamp) = CURRENT_DATE) as opens_today,
                    MAX(te.event_timestamp) as last_activity,
                    (SELECT platform FROM telemetry_events WHERE employee_id = te.employee_id AND platform IS NOT NULL ORDER BY event_timestamp DESC LIMIT 1) as platform,
                    (SELECT app_version FROM telemetry_events WHERE employee_id = te.employee_id AND app_version IS NOT NULL ORDER BY event_timestamp DESC LIMIT 1) as app_version,
                    (SELECT theme_name FROM telemetry_events WHERE employee_id = te.employee_id AND theme_name IS NOT NULL ORDER BY event_timestamp DESC LIMIT 1) as theme_name
                FROM telemetry_events te
                JOIN employees e ON te.employee_id = e.id
                LEFT JOIN roles r ON e.role_id = r.id
                WHERE te.employee_id IS NOT NULL
                  AND te.event_type IN ('app_open', 'app_resume')
                  AND te.event_timestamp >= NOW() - INTERVAL '${parseInt(days)} days'
                GROUP BY te.employee_id, te.tenant_id, e.username, e.first_name, e.last_name, r.name, e.is_owner
                ORDER BY app_opens DESC
            `);

            // Agrupar empleados por tenant
            const mobileUsage = mobileByTenant.rows.map(tenant => ({
                tenantId: tenant.tenant_id,
                businessName: tenant.business_name,
                employeesWithApp: parseInt(tenant.employees_with_app),
                totalEmployees: parseInt(tenant.total_employees),
                totalOpens: parseInt(tenant.total_opens),
                opensToday: parseInt(tenant.opens_today),
                lastActivity: tenant.last_activity,
                employees: mobileEmployees.rows
                    .filter(emp => emp.tenant_id === tenant.tenant_id)
                    .map(emp => ({
                        id: emp.employee_id,
                        username: emp.username,
                        fullName: emp.full_name?.trim() || emp.username,
                        role: emp.role_name,
                        isOwner: emp.is_owner,
                        appOpens: parseInt(emp.app_opens),
                        opensToday: parseInt(emp.opens_today),
                        lastActivity: emp.last_activity,
                        platform: emp.platform,
                        appVersion: emp.app_version,
                        themeName: emp.theme_name
                    }))
            }));

            res.json({
                success: true,
                data: {
                    dailyActivity: dailyOpens.rows,
                    topTenants: topTenants.rows,
                    appVersions: appVersions.rows,
                    scaleModels: scaleModels.rows,
                    themes: themesWithTenants,
                    mobileUsage
                }
            });

        } catch (error) {
            console.error('[SuperAdmin Telemetry Stats] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener estadísticas de telemetría',
                error: undefined
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
            const { days, expiresAt } = req.body;

            let result;
            let message;

            if (expiresAt) {
                // Fecha exacta proporcionada
                result = await pool.query(`
                    UPDATE tenants
                    SET
                        trial_ends_at = $1,
                        subscription_status = 'trial',
                        updated_at = NOW()
                    WHERE id = $2
                    RETURNING id, business_name, trial_ends_at
                `, [new Date(expiresAt), tenantId]);
                message = `Trial establecido hasta ${new Date(expiresAt).toISOString().split('T')[0]}`;
            } else {
                // Dias relativos (default 30)
                const d = parseInt(days) || 30;
                result = await pool.query(`
                    UPDATE tenants
                    SET
                        trial_ends_at = GREATEST(trial_ends_at, NOW()) + INTERVAL '${d} days',
                        subscription_status = 'trial',
                        updated_at = NOW()
                    WHERE id = $1
                    RETURNING id, business_name, trial_ends_at
                `, [tenantId]);
                message = `Trial extendido ${d} días`;
            }

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            console.log(`[SuperAdmin] ${message} para tenant ${tenantId}`);

            res.json({
                success: true,
                message,
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
                error: undefined
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
            const { subscriptionId, months = 1, expiresAt: exactDate } = req.body;

            let expiresAt;
            if (exactDate) {
                expiresAt = new Date(exactDate);
            } else {
                expiresAt = new Date();
                expiresAt.setMonth(expiresAt.getMonth() + parseInt(months));
            }

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
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/master-credentials
    // Obtener username de credenciales maestras (id=1)
    // ─────────────────────────────────────────────────────────
    router.get('/master-credentials', async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT id, username, is_active, created_at, updated_at FROM master_credentials WHERE id = 1'
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Credenciales maestras no encontradas'
                });
            }

            res.json({
                success: true,
                data: {
                    id: result.rows[0].id,
                    username: result.rows[0].username,
                    isActive: result.rows[0].is_active,
                    createdAt: result.rows[0].created_at,
                    updatedAt: result.rows[0].updated_at
                }
            });
        } catch (error) {
            console.error('[SuperAdmin Master Credentials] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener credenciales maestras',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // PUT /api/superadmin/master-credentials
    // Actualizar username/password de credenciales maestras (id=1)
    // ─────────────────────────────────────────────────────────
    router.put('/master-credentials', async (req, res) => {
        try {
            const { username, password } = req.body;

            if (!username && !password) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere al menos username o password'
                });
            }

            const updates = [];
            const values = [];
            let paramCount = 0;

            if (username !== undefined && username.trim() !== '') {
                paramCount++;
                updates.push(`username = $${paramCount}`);
                values.push(username.trim());
            }

            if (password !== undefined && password.trim() !== '') {
                const passwordHash = await bcrypt.hash(password, 12);
                paramCount++;
                updates.push(`password_hash = $${paramCount}`);
                values.push(passwordHash);
            }

            if (updates.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No hay campos validos para actualizar'
                });
            }

            paramCount++;
            updates.push(`updated_at = $${paramCount}`);
            values.push(new Date());

            const result = await pool.query(`
                UPDATE master_credentials
                SET ${updates.join(', ')}
                WHERE id = 1
                RETURNING id, username, is_active, updated_at
            `, values);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Credenciales maestras no encontradas'
                });
            }

            console.log(`[SuperAdmin] Master credentials actualizadas: username=${username ? 'changed' : 'unchanged'}, password=${password ? 'changed' : 'unchanged'}`);

            res.json({
                success: true,
                message: 'Credenciales maestras actualizadas correctamente',
                data: {
                    id: result.rows[0].id,
                    username: result.rows[0].username,
                    isActive: result.rows[0].is_active,
                    updatedAt: result.rows[0].updated_at
                }
            });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'Ese username ya existe'
                });
            }
            console.error('[SuperAdmin Update Master Credentials] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar credenciales maestras',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/broadcast
    // Enviar o programar anuncio con filtro por tiers
    // ─────────────────────────────────────────────────────────
    router.post('/broadcast', async (req, res) => {
        try {
            const { title, htmlContent, contentUrl, type, targetTiers, scheduledAt, timezone } = req.body;

            if (!title) {
                return res.status(400).json({ success: false, message: 'El campo "title" es requerido' });
            }
            if (!htmlContent && !contentUrl) {
                return res.status(400).json({ success: false, message: 'Se requiere "htmlContent" o "contentUrl"' });
            }

            const announcementType = type || 'info';
            const tiers = targetTiers || [];
            const tz = timezone || 'America/Mexico_City';
            const now = new Date().toISOString();

            // Determine if scheduled — if scheduledAt is provided, always treat as scheduled
            // The scheduler will pick it up on the next tick if time has already passed
            const isScheduled = !!scheduledAt;
            if (isScheduled) {
                const parsedDate = new Date(scheduledAt);
                if (isNaN(parsedDate.getTime())) {
                    return res.status(400).json({ success: false, message: 'Formato de scheduledAt invalido' });
                }
            }

            // Save to database
            const result = await pool.query(
                `INSERT INTO announcements (title, html_content, content_url, type, target_tiers, scheduled_at, timezone, status, created_at, sent_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
                 RETURNING *`,
                [
                    title,
                    htmlContent || null,
                    contentUrl || null,
                    announcementType,
                    tiers,
                    isScheduled ? scheduledAt : null,
                    tz,
                    isScheduled ? 'pending' : 'sent',
                    isScheduled ? null : now
                ]
            );

            const saved = result.rows[0];

            const announcement = {
                id: saved.id,
                title,
                htmlContent: htmlContent || null,
                contentUrl: contentUrl || null,
                type: announcementType,
                targetTiers: tiers,
                sentAt: now
            };

            if (!isScheduled) {
                // Emit immediately
                io.emit('system:announcement', announcement);
                console.log(`[Broadcast] 📢 Anuncio enviado: "${title}" | Tiers: ${tiers.length ? tiers.join(',') : 'todos'}`);

                res.json({
                    success: true,
                    message: 'Anuncio enviado a todos los clientes conectados',
                    data: announcement
                });
            } else {
                console.log(`[Broadcast] ⏰ Anuncio programado: "${title}" para ${scheduledAt} (${tz})`);
                res.json({
                    success: true,
                    message: `Anuncio programado para ${scheduledAt}`,
                    data: { ...announcement, scheduledAt, timezone: tz, status: 'pending' }
                });
            }

        } catch (error) {
            console.error('[Broadcast] Error:', error);
            res.status(500).json({ success: false, message: 'Error al enviar anuncio' });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/announcements
    // Historial de anuncios enviados y pendientes
    // ─────────────────────────────────────────────────────────
    router.get('/announcements', async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT id, title, type, target_tiers, scheduled_at, timezone, status, created_at, sent_at
                 FROM announcements
                 ORDER BY created_at DESC
                 LIMIT 50`
            );

            res.json({
                success: true,
                data: result.rows.map(r => ({
                    id: r.id,
                    title: r.title,
                    type: r.type,
                    targetTiers: r.target_tiers || [],
                    scheduledAt: r.scheduled_at,
                    timezone: r.timezone,
                    status: r.status,
                    createdAt: r.created_at,
                    sentAt: r.sent_at
                }))
            });
        } catch (error) {
            console.error('[Announcements] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener anuncios' });
        }
    });

    // ─────────────────────────────────────────────────────────
    // DELETE /api/superadmin/announcements/:id
    // Cancelar anuncio pendiente
    // ─────────────────────────────────────────────────────────
    router.delete('/announcements/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query(
                `DELETE FROM announcements WHERE id = $1 AND status = 'pending' RETURNING id`,
                [id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Anuncio no encontrado o ya enviado' });
            }

            console.log(`[Broadcast] 🗑️ Anuncio pendiente #${id} cancelado`);
            res.json({ success: true, message: 'Anuncio cancelado' });
        } catch (error) {
            console.error('[Announcements] Error:', error);
            res.status(500).json({ success: false, message: 'Error al cancelar anuncio' });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/license-reminders
    // Send personalized license expiry reminders to specific tenants
    // ─────────────────────────────────────────────────────────
    router.post('/license-reminders', async (req, res) => {
        try {
            const { tenantIds, daysThreshold } = req.body;

            if (!tenantIds || !Array.isArray(tenantIds) || tenantIds.length === 0) {
                return res.status(400).json({ success: false, message: 'Se requiere un array de tenantIds' });
            }

            // Fetch tenant details for the requested IDs
            const tenantsResult = await pool.query(`
                SELECT t.id, t.business_name, t.tenant_code,
                       s.name as subscription_name, t.subscription_status,
                       t.trial_ends_at,
                       CASE
                         WHEN t.trial_ends_at IS NOT NULL
                         THEN GREATEST(0, EXTRACT(DAY FROM t.trial_ends_at - NOW()))::int
                         ELSE 0
                       END as days_remaining
                FROM tenants t
                JOIN subscriptions s ON t.subscription_id = s.id
                WHERE t.id = ANY($1)
                ORDER BY days_remaining ASC
            `, [tenantIds]);

            if (tenantsResult.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'No se encontraron tenants' });
            }

            let sentCount = 0;
            const results = [];

            for (const tenant of tenantsResult.rows) {
                const days = tenant.days_remaining;
                const name = tenant.business_name;
                const plan = tenant.subscription_name;

                // Generate personalized HTML
                const html = generateLicenseReminderHTML(name, days, plan);
                const title = days <= 0
                    ? `${name}: Tu licencia ha expirado`
                    : `${name}: Te quedan ${days} día${days === 1 ? '' : 's'}`;

                const announcement = {
                    title,
                    htmlContent: html,
                    type: 'license_reminder',
                    targetTenantId: tenant.id,
                    sentAt: new Date().toISOString()
                };

                // Find this tenant's branches and emit to their rooms
                let delivered = 0;
                const branchesResult = await pool.query(
                    'SELECT id FROM branches WHERE tenant_id = $1 AND is_active = true',
                    [tenant.id]
                );

                for (const branch of branchesResult.rows) {
                    const roomName = `branch_${branch.id}`;
                    const room = io.sockets.adapter.rooms.get(roomName);
                    if (room && room.size > 0) {
                        io.to(roomName).emit('system:announcement', announcement);
                        delivered += room.size;
                        console.log(`[License Reminder] 📡 Emitido a ${roomName} (${room.size} clientes)`);
                    }
                }

                // Save to DB
                await pool.query(
                    `INSERT INTO announcements (title, html_content, type, status, created_at, sent_at)
                     VALUES ($1, $2, 'license_reminder', 'sent', NOW(), NOW())`,
                    [title, html]
                );

                results.push({ tenantId: tenant.id, name, days, delivered });
                sentCount++;
                console.log(`[License Reminder] 📬 ${name}: ${days} días restantes (${delivered} sockets)`);
            }

            res.json({
                success: true,
                message: `${sentCount} recordatorio${sentCount === 1 ? '' : 's'} enviado${sentCount === 1 ? '' : 's'}`,
                data: results
            });

        } catch (error) {
            console.error('[License Reminders] Error:', error);
            res.status(500).json({ success: false, message: 'Error al enviar recordatorios' });
        }
    });

    // Generate personalized license reminder HTML (matches renovacion.html design)
    function generateLicenseReminderHTML(businessName, daysRemaining, plan) {
        const isExpired = daysRemaining <= 0;
        const urgencyColor = isExpired ? '#EF4444' : daysRemaining <= 3 ? '#F59E0B' : '#4fc3f7';
        const alertBg = isExpired
            ? 'rgba(239, 68, 68, 0.12), rgba(239, 68, 68, 0.04)'
            : daysRemaining <= 3
            ? 'rgba(255, 167, 38, 0.12), rgba(255, 167, 38, 0.04)'
            : 'rgba(79, 195, 247, 0.12), rgba(79, 195, 247, 0.04)';
        const alertBorder = isExpired
            ? 'rgba(239, 68, 68, 0.3)'
            : daysRemaining <= 3
            ? 'rgba(255, 167, 38, 0.3)'
            : 'rgba(79, 195, 247, 0.3)';
        const alertStrong = isExpired ? '#EF4444' : daysRemaining <= 3 ? '#ffa726' : '#4fc3f7';
        const alertIcon = isExpired ? '&#x26A0;&#xFE0F;' : daysRemaining <= 3 ? '&#x23F0;' : '&#x1F4CB;';
        const alertText = isExpired
            ? `<strong>${businessName}</strong>, tu licencia del sistema SYA <strong style="color:${alertStrong};">ha expirado</strong>. Renueva para seguir usando todas las funciones sin interrupciones.`
            : `<strong>${businessName}</strong>, tu licencia del plan <strong style="color:${alertStrong};">${plan}</strong> ${daysRemaining <= 3 ? '<strong style="color:#ffa726;">esta por vencer</strong>' : 'vence pronto'}. Te quedan <strong style="color:${urgencyColor};font-size:18px;">${daysRemaining}</strong> dia${daysRemaining === 1 ? '' : 's'}.`;

        const statusBadge = isExpired
            ? `<span style="display:inline-block;background:#EF4444;color:white;font-size:11px;font-weight:700;padding:5px 14px;border-radius:20px;letter-spacing:1px;margin-bottom:10px;">LICENCIA EXPIRADA</span>`
            : `<span style="display:inline-block;background:${urgencyColor};color:${daysRemaining <= 3 ? '#0a1628' : 'white'};font-size:11px;font-weight:700;padding:5px 14px;border-radius:20px;letter-spacing:1px;margin-bottom:10px;">${daysRemaining} DIA${daysRemaining === 1 ? '' : 'S'} RESTANTE${daysRemaining === 1 ? '' : 'S'}</span>`;

        return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0a1628;font-family:'Inter','Segoe UI',sans-serif;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px;overflow-y:auto;}
.container{max-width:700px;width:100%;}
.header{background:linear-gradient(135deg,#0d2137 0%,#1a3a5c 50%,#0d2137 100%);border-radius:20px 20px 0 0;padding:36px 40px 28px;text-align:center;border:1px solid rgba(79,195,247,0.15);border-bottom:none;position:relative;overflow:hidden;}
.header::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(circle at 50% 40%,rgba(79,195,247,0.06) 0%,transparent 50%);}
.logo{width:80px;height:auto;margin-bottom:14px;position:relative;filter:drop-shadow(0 4px 12px rgba(0,0,0,0.3));}
.brand{color:#4fc3f7;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:3px;margin-bottom:8px;position:relative;}
.header h1{color:#fff;font-size:24px;font-weight:800;position:relative;line-height:1.3;}
.divider{width:60px;height:3px;background:linear-gradient(90deg,${urgencyColor},${isExpired ? '#f87171' : daysRemaining <= 3 ? '#fbbf24' : '#81d4fa'});margin:16px auto 0;border-radius:2px;position:relative;}
.body{background:#0f1d30;padding:30px 40px;border-left:1px solid rgba(79,195,247,0.15);border-right:1px solid rgba(79,195,247,0.15);}
.alert-box{background:linear-gradient(135deg,${alertBg});border:1px solid ${alertBorder};border-radius:12px;padding:20px 24px;margin-bottom:24px;display:flex;align-items:center;gap:16px;}
.alert-icon{font-size:32px;min-width:40px;text-align:center;}
.alert-text{color:#e0e0e0;font-size:14px;line-height:1.6;}
.benefits-title{color:#4fc3f7;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;margin-bottom:16px;}
.benefits{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px;}
.benefit{display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;}
.benefit-icon{font-size:20px;min-width:28px;text-align:center;}
.benefit-text{color:#b0bec5;font-size:13px;line-height:1.4;}
.price-box{background:linear-gradient(135deg,rgba(79,195,247,0.1),rgba(79,195,247,0.03));border:1px solid rgba(79,195,247,0.2);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;}
.price-label{color:#78909c;font-size:13px;margin-bottom:6px;}
.price{color:#4fc3f7;font-size:36px;font-weight:800;}
.price-period{color:#546e7a;font-size:14px;}
.price-monthly{color:#78909c;font-size:13px;margin-top:6px;}
.contact-box{text-align:center;padding:20px;}
.contact-text{color:#b0bec5;font-size:14px;margin-bottom:14px;}
.contact-badge{display:inline-block;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#0a1628;padding:12px 36px;border-radius:30px;font-size:14px;font-weight:700;}
.footer{background:#081220;border-radius:0 0 20px 20px;padding:16px 40px;text-align:center;border:1px solid rgba(79,195,247,0.15);border-top:1px solid rgba(79,195,247,0.08);}
.footer p{color:#37474f;font-size:11px;letter-spacing:1px;}
.footer span{color:#4fc3f7;}
</style>
</head><body>
<div class="container">
    <div class="header">
        <img src="/public/assets/logo-sya.png" alt="SYA" class="logo">
        <p class="brand">SYA Tortillerias</p>
        ${statusBadge}
        <h1>Aviso de Licencia</h1>
        <div class="divider"></div>
    </div>
    <div class="body">
        <div class="alert-box">
            <span class="alert-icon">${alertIcon}</span>
            <div class="alert-text">${alertText}</div>
        </div>
        <p class="benefits-title">&#x2705; Tu licencia incluye</p>
        <div class="benefits">
            <div class="benefit"><span class="benefit-icon">&#x1F4BB;</span><span class="benefit-text">Punto de Venta completo</span></div>
            <div class="benefit"><span class="benefit-icon">&#x1F6E1;&#xFE0F;</span><span class="benefit-text">Guardian Anti-fraude</span></div>
            <div class="benefit"><span class="benefit-icon">&#x1F4F1;</span><span class="benefit-text">App movil incluida</span></div>
            <div class="benefit"><span class="benefit-icon">&#x2601;&#xFE0F;</span><span class="benefit-text">Respaldo en la nube</span></div>
            <div class="benefit"><span class="benefit-icon">&#x1F4CA;</span><span class="benefit-text">Reportes y dashboard</span></div>
            <div class="benefit"><span class="benefit-icon">&#x1F527;</span><span class="benefit-text">Soporte tecnico</span></div>
        </div>
        <div class="price-box">
            <p class="price-label">Licencia anual</p>
            <span class="price">$3,500</span>
            <span class="price-period"> MXN / a&#xF1;o</span>
            <p class="price-monthly">Menos de $300 al mes por todo tu negocio controlado</p>
        </div>
        <div class="contact-box">
            <p class="contact-text">Contacta a tu proveedor SYA para renovar</p>
            <span class="contact-badge">Renovar ahora</span>
        </div>
    </div>
    <div class="footer">
        <p><span>SYA TORTILLERIAS</span> &bull; Sistema Punto de Venta</p>
    </div>
</div>
</body></html>`;
    }

    // ─────────────────────────────────────────────────────────
    // Scheduler: Check for pending announcements every 30 seconds
    // ─────────────────────────────────────────────────────────
    setInterval(async () => {
        try {
            const result = await pool.query(
                `SELECT * FROM announcements
                 WHERE status = 'pending' AND scheduled_at <= NOW()
                 ORDER BY scheduled_at ASC`
            );

            for (const row of result.rows) {
                const announcement = {
                    id: row.id,
                    title: row.title,
                    htmlContent: row.html_content,
                    contentUrl: row.content_url,
                    type: row.type,
                    targetTiers: row.target_tiers || [],
                    sentAt: new Date().toISOString()
                };

                io.emit('system:announcement', announcement);

                await pool.query(
                    `UPDATE announcements SET status = 'sent', sent_at = NOW() WHERE id = $1`,
                    [row.id]
                );

                console.log(`[Broadcast Scheduler] 📢 Anuncio programado enviado: "${row.title}"`);
            }
        } catch (error) {
            // Silent fail - scheduler will retry on next tick
        }
    }, 30 * 1000);

    return router;
};
