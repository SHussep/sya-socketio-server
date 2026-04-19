// ═══════════════════════════════════════════════════════════════
// RUTAS DE SUPER ADMIN - Panel de Administración de Licencias
// Solo accesible con PIN + autenticación especial
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { superadminRateLimiter } = require('../middleware/rateLimiter');
const { sendEmail, sendFollowupEmail, sanitizeEmailHeader } = require('../utils/emailService');
const { fetchInboxMessages, fetchSentMessages, fetchInboxEmail, fetchSentEmail, fetchNoReplySentMessages, fetchNoReplySentEmail } = require('../utils/imapService');

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
    // POST /api/superadmin/socket-token
    // Entrega un JWT HS256 de corta vida (1h) para que SYAAdmin
    // pueda autenticar contra Socket.IO. Nunca se persiste.
    // ─────────────────────────────────────────────────────────
    router.post('/socket-token', (req, res) => {
        if (!process.env.JWT_SECRET) {
            return res.status(503).json({
                success: false,
                message: 'JWT_SECRET no configurado'
            });
        }

        try {
            const jti = crypto.randomUUID();
            const token = jwt.sign(
                {
                    role: 'super_admin',
                    scope: 'admin-socket',
                    userId: 'pin-auth',
                    jti,
                },
                process.env.JWT_SECRET,
                { algorithm: 'HS256', expiresIn: '1h' }
            );
            const ip = req.ip || req.connection?.remoteAddress || 'unknown';
            console.log(`[Superadmin] 🔑 socket-token emitido jti=${jti} ip=${ip}`);
            return res.json({
                success: true,
                token,
                expiresIn: 3600,
            });
        } catch (e) {
            console.error('[Superadmin] socket-token error:', e);
            return res.status(500).json({
                success: false,
                message: 'No se pudo emitir token'
            });
        }
    });

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
                subscriptionDistribution,
                trialExtensionsResult
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
                `),

                // Trial extensions tracking (followups with trialExpired scenario)
                pool.query(`
                    SELECT
                        fe.tenant_id,
                        fe.sent_to,
                        fe.sent_at,
                        t.business_name,
                        t.subscription_status,
                        EXISTS (
                            SELECT 1 FROM telemetry_events te
                            WHERE te.tenant_id = fe.tenant_id
                              AND te.event_type = 'app_open'
                              AND te.event_timestamp > fe.sent_at
                        ) AS came_back,
                        (t.subscription_status = 'active') AS converted
                    FROM followup_emails fe
                    JOIN tenants t ON t.id = fe.tenant_id
                    WHERE fe.scenario = 'trialExpired'
                    ORDER BY fe.sent_at DESC
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
                    },
                    trialExtensions: {
                        summary: {
                            totalSent: trialExtensionsResult.rows.length,
                            cameBack: trialExtensionsResult.rows.filter(r => r.came_back).length,
                            converted: trialExtensionsResult.rows.filter(r => r.converted).length
                        },
                        tenants: trialExtensionsResult.rows.map(r => ({
                            tenantId: r.tenant_id,
                            businessName: r.business_name,
                            sentTo: r.sent_to,
                            sentAt: r.sent_at,
                            cameBack: r.came_back,
                            converted: r.converted,
                            subscriptionStatus: r.subscription_status
                        }))
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
    // GET /api/superadmin/system-health
    // Salud del sistema: PostgreSQL + Socket.IO
    // ─────────────────────────────────────────────────────────
    router.get('/system-health', async (req, res) => {
        try {
            const [
                dbSizeResult,
                tableSizesResult,
                tenantRowCountsResult,
                pgConnectionsResult,
                cacheHitResult
            ] = await Promise.all([
                // 1. Total database size
                pool.query(`SELECT pg_database_size(current_database()) as total_bytes`),

                // 2. Top 10 tables by size
                pool.query(`
                    SELECT
                        relname as table_name,
                        pg_total_relation_size(relid) as total_bytes,
                        n_live_tup as row_count
                    FROM pg_stat_user_tables
                    ORDER BY pg_total_relation_size(relid) DESC
                    LIMIT 10
                `),

                // 3. Per-tenant row counts across key tables
                pool.query(`
                    SELECT
                        t.id as tenant_id,
                        t.business_name,
                        COALESCE(v.ventas_count, 0) as ventas_count,
                        COALESCE(te.telemetry_count, 0) as telemetry_count,
                        COALESCE(e.employee_count, 0) as employee_count,
                        COALESCE(c.customer_count, 0) as customer_count,
                        (COALESCE(v.ventas_count, 0) + COALESCE(te.telemetry_count, 0) +
                         COALESCE(e.employee_count, 0) + COALESCE(c.customer_count, 0)) as total_rows
                    FROM tenants t
                    LEFT JOIN (SELECT tenant_id, COUNT(*) as ventas_count FROM ventas GROUP BY tenant_id) v ON v.tenant_id = t.id
                    LEFT JOIN (SELECT tenant_id, COUNT(*) as telemetry_count FROM telemetry_events GROUP BY tenant_id) te ON te.tenant_id = t.id
                    LEFT JOIN (SELECT tenant_id, COUNT(*) as employee_count FROM employees GROUP BY tenant_id) e ON e.tenant_id = t.id
                    LEFT JOIN (SELECT tenant_id, COUNT(*) as customer_count FROM customers GROUP BY tenant_id) c ON c.tenant_id = t.id
                    ORDER BY total_rows DESC
                    LIMIT 10
                `),

                // 4. PostgreSQL connections
                pool.query(`
                    SELECT
                        COUNT(*) as total,
                        COUNT(*) FILTER (WHERE state = 'active') as active,
                        COUNT(*) FILTER (WHERE state = 'idle') as idle
                    FROM pg_stat_activity
                    WHERE datname = current_database()
                `),

                // 5. Cache hit ratio
                pool.query(`
                    SELECT
                        CASE WHEN SUM(heap_blks_hit) + SUM(heap_blks_read) > 0
                             THEN ROUND(SUM(heap_blks_hit)::numeric / (SUM(heap_blks_hit) + SUM(heap_blks_read)) * 100, 2)
                             ELSE 100
                        END as cache_hit_ratio
                    FROM pg_statio_user_tables
                `)
            ]);

            // Socket.IO stats – aggregate + per-tenant breakdown
            let totalConnections = 0;
            let desktopCount = 0;
            let mobileCount = 0;
            let authenticatedCount = 0;
            const onlineMap = new Map();

            for (const [, socket] of io.sockets.sockets) {
                totalConnections++;
                if (socket.authenticated) authenticatedCount++;
                if (socket.clientType === 'desktop') desktopCount++;
                else if (socket.clientType === 'mobile') mobileCount++;

                // Per-tenant breakdown
                if (socket.authenticated && socket.user?.tenantId) {
                    const tid = socket.user.tenantId;
                    if (!onlineMap.has(tid)) {
                        onlineMap.set(tid, { tenantId: tid, desktopCount: 0, mobileCount: 0 });
                    }
                    const info = onlineMap.get(tid);
                    if (socket.clientType === 'desktop') info.desktopCount++;
                    else if (socket.clientType === 'mobile') info.mobileCount++;
                }
            }

            // Fetch business names for online tenants
            let onlineTenants = [];
            if (onlineMap.size > 0) {
                const tids = Array.from(onlineMap.keys());
                const namesResult = await pool.query(
                    `SELECT id, business_name FROM tenants WHERE id = ANY($1)`,
                    [tids]
                );
                const nameMap = new Map(namesResult.rows.map(r => [r.id, r.business_name]));
                onlineTenants = Array.from(onlineMap.values()).map(t => ({
                    tenantId: t.tenantId,
                    businessName: nameMap.get(t.tenantId) || `Tenant ${t.tenantId}`,
                    desktopCount: t.desktopCount,
                    mobileCount: t.mobileCount,
                }));
            }

            const dbSize = dbSizeResult.rows[0];
            const pgConn = pgConnectionsResult.rows[0];
            const cacheRatio = cacheHitResult.rows[0];

            res.json({
                success: true,
                data: {
                    database: {
                        totalBytes: parseInt(dbSize.total_bytes),
                        totalFormatted: formatBytes(parseInt(dbSize.total_bytes)),
                        tables: tableSizesResult.rows.map(r => ({
                            name: r.table_name,
                            totalBytes: parseInt(r.total_bytes),
                            rowCount: parseInt(r.row_count)
                        }))
                    },
                    tenantStorage: tenantRowCountsResult.rows.map(r => ({
                        tenantId: r.tenant_id,
                        businessName: r.business_name,
                        ventasCount: parseInt(r.ventas_count),
                        telemetryCount: parseInt(r.telemetry_count),
                        employeeCount: parseInt(r.employee_count),
                        customerCount: parseInt(r.customer_count),
                        totalRows: parseInt(r.total_rows)
                    })),
                    socket: {
                        totalConnections,
                        desktopCount,
                        mobileCount,
                        authenticatedCount,
                        onlineTenants
                    },
                    postgres: {
                        connectionsTotal: parseInt(pgConn.total),
                        connectionsActive: parseInt(pgConn.active),
                        connectionsIdle: parseInt(pgConn.idle),
                        cacheHitRatio: parseFloat(cacheRatio.cache_hit_ratio)
                    }
                }
            });
        } catch (error) {
            console.error('[SuperAdmin SystemHealth] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener salud del sistema' });
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
                    s.max_devices,
                    s.max_employees,
                    (SELECT COUNT(*) FROM branch_licenses WHERE tenant_id = t.id AND status IN ('available', 'active')) as total_licenses,
                    (SELECT COUNT(*) FROM branch_licenses WHERE tenant_id = t.id AND status = 'active') as used_licenses,
                    (SELECT COUNT(*) FROM branches WHERE tenant_id = t.id) as branch_count,
                    (SELECT COUNT(*) FROM employees WHERE tenant_id = t.id) as employee_count,
                    (SELECT COUNT(*) FROM employees WHERE tenant_id = t.id AND is_active = true) as active_employee_count,
                    (SELECT COUNT(*) FROM telemetry_events WHERE tenant_id = t.id AND event_type = 'app_open') as app_opens,
                    (SELECT COUNT(DISTINCT branch_id) FROM telemetry_events WHERE tenant_id = t.id AND event_type = 'scale_configured') as branches_with_scale,
                    (SELECT COUNT(*) FROM telemetry_events WHERE tenant_id = t.id AND event_type = 'socket_error') as error_count,
                    (SELECT COUNT(*) FROM ventas WHERE tenant_id = t.id) as total_sales,
                    (SELECT COALESCE(SUM(total), 0) FROM ventas WHERE tenant_id = t.id) as total_revenue,
                    (SELECT MAX(event_timestamp) FROM telemetry_events WHERE tenant_id = t.id) as last_activity,
                    (SELECT app_version FROM telemetry_events WHERE tenant_id = t.id AND app_version IS NOT NULL AND platform IS NULL ORDER BY event_timestamp DESC LIMIT 1) as desktop_version,
                    (SELECT app_version FROM telemetry_events WHERE tenant_id = t.id AND app_version IS NOT NULL AND platform IN ('android', 'ios') ORDER BY event_timestamp DESC LIMIT 1) as mobile_version,
                    (SELECT theme_name FROM telemetry_events WHERE tenant_id = t.id AND theme_name IS NOT NULL ORDER BY event_timestamp DESC LIMIT 1) as theme_name,
                    (SELECT name FROM employees WHERE tenant_id = t.id AND is_owner = true LIMIT 1) as owner_name,
                    (SELECT MAX(created_at) FROM backup_metadata WHERE tenant_id = t.id) as last_backup
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
                        maxBranches: parseInt(tenant.total_licenses) || 0,
                        maxDevices: tenant.max_devices,
                        maxEmployees: tenant.max_employees
                    },
                    licenses: {
                        total: parseInt(tenant.total_licenses) || 0,
                        used: parseInt(tenant.used_licenses) || 0,
                        available: (parseInt(tenant.total_licenses) || 0) - (parseInt(tenant.used_licenses) || 0)
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
                        errorCount: parseInt(tenant.error_count),
                        totalSales: parseInt(tenant.total_sales),
                        totalRevenue: parseFloat(tenant.total_revenue)
                    },
                    ownerName: tenant.owner_name,
                    lastActivity: tenant.last_activity,
                    desktopVersion: tenant.desktop_version,
                    mobileVersion: tenant.mobile_version,
                    appVersion: tenant.desktop_version || tenant.mobile_version,
                    themeName: tenant.theme_name,
                    lastBackup: tenant.last_backup,
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
                    (SELECT COUNT(*) FROM employees e
                     JOIN employee_branches eb ON e.id = eb.employee_id
                     WHERE eb.branch_id = b.id) as total_employee_count,
                    (SELECT COUNT(DISTINCT cb.customer_id) FROM cliente_branches cb
                     WHERE cb.branch_id = b.id AND cb.is_active = true) as customer_count,
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

            // Versión de app más reciente (desktop y mobile por separado)
            const desktopVersionResult = await pool.query(`
                SELECT app_version
                FROM telemetry_events
                WHERE tenant_id = $1 AND app_version IS NOT NULL AND platform IS NULL
                ORDER BY event_timestamp DESC
                LIMIT 1
            `, [id]);

            const mobileVersionResult = await pool.query(`
                SELECT app_version
                FROM telemetry_events
                WHERE tenant_id = $1 AND app_version IS NOT NULL AND platform IN ('android', 'ios')
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

            // Licencias del tenant
            const licensesResult = await pool.query(`
                SELECT bl.id, bl.branch_id, bl.status, bl.granted_by, bl.granted_at, bl.activated_at,
                       b.name as branch_name, b.branch_code
                FROM branch_licenses bl
                LEFT JOIN branches b ON bl.branch_id = b.id
                WHERE bl.tenant_id = $1 AND bl.status != 'revoked'
                ORDER BY bl.status DESC, bl.created_at ASC
            `, [id]);

            // Último seguimiento enviado
            const followupResult = await pool.query(`
                SELECT id, sent_to, subject, scenario, sent_at
                FROM followup_emails
                WHERE tenant_id = $1
                ORDER BY sent_at DESC
                LIMIT 1
            `, [id]);

            // Último respaldo en Dropbox
            const backupResult = await pool.query(`
                SELECT created_at, backup_filename
                FROM backup_metadata
                WHERE tenant_id = $1
                ORDER BY created_at DESC
                LIMIT 1
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
                        desktopVersion: desktopVersionResult.rows[0]?.app_version || null,
                        mobileVersion: mobileVersionResult.rows[0]?.app_version || null,
                        appVersion: desktopVersionResult.rows[0]?.app_version || mobileVersionResult.rows[0]?.app_version || null,
                        themeName: themeResult.rows[0]?.theme_name || null,
                        lastBackup: backupResult.rows[0]?.created_at || null
                    },
                    subscription: {
                        id: tenant.subscription_id,
                        name: tenant.subscription_name,
                        status: tenant.subscription_status,
                        maxBranches: licensesResult.rows.length,
                        maxDevices: tenant.max_devices,
                        maxEmployees: tenant.max_employees,
                        trialEndsAt: tenant.trial_ends_at,
                        daysRemaining: Math.max(0, daysRemaining || 0),
                        isExpired: trialEndsAt ? trialEndsAt < now : false
                    },
                    licenses: {
                        total: licensesResult.rows.length,
                        used: licensesResult.rows.filter(l => l.status === 'active').length,
                        available: licensesResult.rows.filter(l => l.status === 'available').length,
                        details: licensesResult.rows.map(l => ({
                            id: l.id,
                            branchId: l.branch_id,
                            branchName: l.branch_name,
                            branchCode: l.branch_code,
                            status: l.status,
                            grantedBy: l.granted_by,
                            grantedAt: l.granted_at,
                            activatedAt: l.activated_at
                        }))
                    },
                    branches: branchesResult.rows.map(b => ({
                        id: b.id,
                        code: b.branch_code,
                        name: b.name,
                        address: b.address,
                        employeeCount: parseInt(b.employee_count) || 0,
                        totalEmployeeCount: parseInt(b.total_employee_count) || 0,
                        customerCount: parseInt(b.customer_count) || 0,
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
                    },
                    lastFollowup: followupResult.rows.length > 0 ? {
                        subject: followupResult.rows[0].subject,
                        sentTo: followupResult.rows[0].sent_to,
                        scenario: followupResult.rows[0].scenario,
                        sentAt: followupResult.rows[0].sent_at
                    } : null
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
    // DELETE /api/superadmin/tenants/:id
    // Eliminar un tenant y TODOS sus datos (CASCADE)
    // ─────────────────────────────────────────────────────────
    router.delete('/tenants/:id', async (req, res) => {
        const client = await pool.connect();
        try {
            const { id } = req.params;

            // Verify tenant exists
            const tenantResult = await client.query(
                'SELECT id, business_name, email FROM tenants WHERE id = $1',
                [id]
            );

            if (tenantResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];

            await client.query('BEGIN');

            // Helper: try a DELETE, rollback to savepoint if table doesn't exist or has issues
            async function safeDel(sql, params) {
                const sp = 'sp_' + Math.random().toString(36).slice(2, 8);
                await client.query(`SAVEPOINT ${sp}`);
                try {
                    const r = await client.query(sql, params);
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    return r.rowCount;
                } catch (e) {
                    console.log(`[DeleteTenant] safeDel skipped: ${e.message.substring(0, 100)}`);
                    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
                    return 0;
                }
            }

            // Comprehensive delete in dependency order (leaves → parents).
            // Every table with a FK to tenants/branches/employees/productos
            // must be deleted BEFORE its parent. safeDel() for tables that
            // may not exist in all environments; direct query for critical ones.

            console.log(`[DeleteTenant] Starting deletion of tenant ${id} (${tenant.business_name})`);

            // ── Phase 1: Deepest leaf tables ──
            await safeDel('DELETE FROM repartidor_returns WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM repartidor_assignments WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM repartidor_locations WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM ventas_detalle WHERE id_venta IN (SELECT id_venta FROM ventas WHERE tenant_id = $1)', [id]);
            await safeDel('DELETE FROM cancelaciones_bitacora WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM venta_cancelaciones WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM purchase_details WHERE purchase_id IN (SELECT id FROM purchases WHERE tenant_id = $1)', [id]);
            await safeDel('DELETE FROM kardex_entries WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM notas_credito_detalle WHERE nota_credito_id IN (SELECT id FROM notas_credito WHERE tenant_id = $1)', [id]);
            await safeDel('DELETE FROM inventory_transfer_items WHERE transfer_id IN (SELECT id FROM inventory_transfers WHERE tenant_id = $1)', [id]);

            // ── Phase 1b: Production module ──
            await safeDel('DELETE FROM production_alerts WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM production_entries WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM production_yield_configs WHERE tenant_id = $1', [id]);

            // ── Phase 2: Financial / operational ──
            await safeDel('DELETE FROM notas_credito WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM credit_payments WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM ventas WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM cash_cuts WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM deposits WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM withdrawals WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM expenses WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM purchases WHERE tenant_id = $1', [id]);

            // ── Phase 3: Guardian / logs / sync ──
            await safeDel('DELETE FROM suspicious_weighing_logs WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM scale_disconnection_logs WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM preparation_mode_logs WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM preparation_mode_windows WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM sync_error_reports WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM data_resets WHERE tenant_id = $1', [id]);

            // ── Phase 4: Employee debts, then shifts ──
            await safeDel('DELETE FROM employee_debt_payments WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM employee_debts WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM shift_requests WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM shifts WHERE tenant_id = $1', [id]);

            // ── Phase 5: Products and pricing ──
            await safeDel('DELETE FROM productos_branch_precios WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM producto_branches WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM customer_product_prices WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM categorias_productos WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM productos WHERE tenant_id = $1', [id]);

            // ── Phase 6: Inventory ──
            await safeDel('DELETE FROM inventory_transfers WHERE tenant_id = $1', [id]);

            // ── Phase 7: Customers (disable generic customer trigger) ──
            await client.query('DROP TRIGGER IF EXISTS trg_prevent_generic_customer_delete ON customers');
            await safeDel('DELETE FROM cliente_branches WHERE tenant_id = $1', [id]);
            await client.query('DELETE FROM customers WHERE tenant_id = $1', [id]);
            await client.query(`
                CREATE TRIGGER trg_prevent_generic_customer_delete
                    BEFORE DELETE ON customers FOR EACH ROW
                    EXECUTE FUNCTION prevent_generic_customer_delete()
            `);

            // ── Phase 8: Metadata, telemetry, notifications ──
            await safeDel('DELETE FROM backup_metadata WHERE tenant_id = $1', [id]);
            await client.query('DELETE FROM telemetry_events WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM notifications WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM followup_emails WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM sessions WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM beta_enrollments WHERE tenant_id = $1', [id]);

            // ── Phase 9: Devices ──
            await safeDel('DELETE FROM device_tokens WHERE employee_id IN (SELECT id FROM employees WHERE tenant_id = $1)', [id]);
            await safeDel('DELETE FROM branch_devices WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM notification_preferences WHERE tenant_id = $1', [id]);

            // ── Phase 10: GPS / Geofence ──
            await safeDel('DELETE FROM gps_locations WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM geofence_zones WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM employee_geofence_zones WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM geofence_events WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM gps_consent_log WHERE tenant_id = $1', [id]);

            // ── Phase 12: Employees and relations ──
            // Safety: null out FK refs from shifts to employees in case shifts weren't fully deleted
            await safeDel('UPDATE shifts SET closed_by_employee_id = NULL WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM shifts WHERE tenant_id = $1', [id]);
            await client.query('DELETE FROM employee_branches WHERE tenant_id = $1', [id]);
            await client.query('DELETE FROM employees WHERE tenant_id = $1', [id]);

            // ── Phase 13: sync_events, suppliers, licenses, roles, branches ──
            await client.query('DELETE FROM sync_events WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM branch_settings WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM suppliers WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM roles WHERE tenant_id = $1', [id]);
            await safeDel('DELETE FROM global_expense_categories WHERE tenant_id = $1', [id]);
            await client.query('DELETE FROM branch_licenses WHERE tenant_id = $1', [id]);
            await client.query('DELETE FROM branches WHERE tenant_id = $1', [id]);

            // ── Phase 14: The tenant itself ──
            await client.query('DELETE FROM tenants WHERE id = $1', [id]);

            await client.query('COMMIT');

            console.log(`[Superadmin] 🗑️ Tenant eliminado: ${tenant.business_name} (ID: ${id})`);

            res.json({
                success: true,
                message: `Tenant "${tenant.business_name}" eliminado correctamente`,
                deleted: {
                    id: parseInt(id),
                    businessName: tenant.business_name,
                    email: tenant.email
                }
            });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('[Superadmin] Error eliminando tenant:', error);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar tenant: ' + error.message
            });
        } finally {
            client.release();
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/tenants/:id/send-followup
    // Enviar email de seguimiento al owner del tenant
    // ─────────────────────────────────────────────────────────
    router.post('/tenants/:id/send-followup', async (req, res) => {
        try {
            const { id } = req.params;
            const { subject: rawSubject, body, scenario } = req.body;

            if (!rawSubject || !body) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere "subject" y "body"'
                });
            }

            // Sanitize subject to prevent email header injection
            const subject = sanitizeEmailHeader(rawSubject);

            // Buscar el email del owner del tenant
            const ownerResult = await pool.query(`
                SELECT e.email, e.first_name, e.last_name
                FROM employees e
                WHERE e.tenant_id = $1
                  AND e.is_owner = true
                  AND e.is_active = true
                LIMIT 1
            `, [id]);

            if (ownerResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No se encontró un owner activo con email para este tenant'
                });
            }

            const owner = ownerResult.rows[0];
            if (!owner.email) {
                return res.status(400).json({
                    success: false,
                    message: 'El owner de este tenant no tiene email registrado'
                });
            }

            const sent = await sendFollowupEmail({
                to: owner.email,
                subject,
                html: body
            });

            if (!sent) {
                return res.status(500).json({
                    success: false,
                    message: 'Error al enviar el email. Verifica la configuración SMTP.'
                });
            }

            // Guardar registro del envío
            await pool.query(`
                INSERT INTO followup_emails (tenant_id, sent_to, subject, scenario)
                VALUES ($1, $2, $3, $4)
            `, [id, owner.email, subject, scenario || null]);

            console.log(`[Followup Email] ✉️ Enviado a ${owner.email} (tenant ${id}) — "${subject}"`);

            res.json({
                success: true,
                message: `Email enviado a ${owner.email}`,
                data: { sentTo: owner.email }
            });

        } catch (error) {
            console.error('[Followup Email] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al enviar email de seguimiento',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/tenants/:id/followups
    // Historial de emails de seguimiento enviados a un tenant
    // ─────────────────────────────────────────────────────────
    router.get('/tenants/:id/followups', async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query(`
                SELECT id, sent_to, subject, scenario, sent_at
                FROM followup_emails
                WHERE tenant_id = $1
                ORDER BY sent_at DESC
                LIMIT 20
            `, [id]);

            res.json({
                success: true,
                data: result.rows.map(r => ({
                    id: r.id,
                    sentTo: r.sent_to,
                    subject: r.subject,
                    scenario: r.scenario,
                    sentAt: r.sent_at
                }))
            });
        } catch (error) {
            console.error('[Followup History] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener historial de seguimientos'
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/inbox
    // Bandeja de entrada del buzón info@ (IMAP)
    // ─────────────────────────────────────────────────────────
    router.get('/inbox', async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 30, 50);
            const page = parseInt(req.query.page) || 1;

            const result = await fetchInboxMessages(limit, page);

            res.json({
                success: true,
                data: result.messages,
                total: result.total,
                page,
                limit
            });
        } catch (error) {
            console.error('[Inbox] Error fetching messages:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener bandeja de entrada'
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/inbox/:uid
    // Detalle de un correo por UID (IMAP)
    // ─────────────────────────────────────────────────────────
    router.get('/inbox/:uid', async (req, res) => {
        try {
            const uid = parseInt(req.params.uid);
            if (!uid || isNaN(uid)) {
                return res.status(400).json({
                    success: false,
                    message: 'UID inválido'
                });
            }

            const email = await fetchInboxEmail(uid);

            if (!email) {
                return res.status(404).json({
                    success: false,
                    message: 'Email no encontrado'
                });
            }

            res.json({
                success: true,
                data: email
            });
        } catch (error) {
            console.error('[Inbox] Error fetching email:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener email'
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/sent
    // Bandeja de salida (correos enviados) del buzón info@
    // ─────────────────────────────────────────────────────────
    router.get('/sent', async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 30, 50);
            const page = parseInt(req.query.page) || 1;

            const result = await fetchSentMessages(limit, page);

            res.json({
                success: true,
                data: result.messages,
                total: result.total,
                page,
                limit
            });
        } catch (error) {
            console.error('[Sent] Error fetching messages:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener bandeja de salida'
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/sent/:uid
    // Detalle de un correo enviado por UID
    // ─────────────────────────────────────────────────────────
    router.get('/sent/:uid', async (req, res) => {
        try {
            const uid = parseInt(req.params.uid);
            if (!uid || isNaN(uid)) {
                return res.status(400).json({
                    success: false,
                    message: 'UID inválido'
                });
            }

            const email = await fetchSentEmail(uid);

            if (!email) {
                return res.status(404).json({
                    success: false,
                    message: 'Email no encontrado'
                });
            }

            res.json({
                success: true,
                data: email
            });
        } catch (error) {
            console.error('[Sent] Error fetching email:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener email enviado'
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/sent-noreply
    // Bandeja de salida de no-reply@ (correos automáticos del sistema)
    // ─────────────────────────────────────────────────────────
    router.get('/sent-noreply', async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 30, 50);
            const page = parseInt(req.query.page) || 1;

            const result = await fetchNoReplySentMessages(limit, page);

            res.json({
                success: true,
                data: result.messages,
                total: result.total,
                page,
                limit
            });
        } catch (error) {
            console.error('[SentNoReply] Error fetching messages:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener bandeja de salida (no-reply)'
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/sent-noreply/:uid
    // Detalle de un correo enviado por no-reply
    // ─────────────────────────────────────────────────────────
    router.get('/sent-noreply/:uid', async (req, res) => {
        try {
            const uid = parseInt(req.params.uid);
            if (!uid || isNaN(uid)) {
                return res.status(400).json({
                    success: false,
                    message: 'UID inválido'
                });
            }

            const email = await fetchNoReplySentEmail(uid);

            if (!email) {
                return res.status(404).json({
                    success: false,
                    message: 'Email no encontrado'
                });
            }

            res.json({
                success: true,
                data: email
            });
        } catch (error) {
            console.error('[SentNoReply] Error fetching email:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener email enviado (no-reply)'
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
    // POST /api/superadmin/subscriptions
    // Crear nuevo plan de suscripción
    // ─────────────────────────────────────────────────────────
    router.post('/subscriptions', async (req, res) => {
        try {
            const {
                name,
                maxBranches,
                maxDevices,
                maxDevicesPerBranch,
                maxEmployees,
                features,
                isActive
            } = req.body;

            if (!name || maxBranches === undefined || maxDevices === undefined || maxDevicesPerBranch === undefined) {
                return res.status(400).json({
                    success: false,
                    message: 'Campos requeridos: name, maxBranches, maxDevices, maxDevicesPerBranch'
                });
            }

            const result = await pool.query(`
                INSERT INTO subscriptions (name, max_branches, max_devices, max_devices_per_branch, max_employees, features, is_active)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
            `, [
                name,
                maxBranches,
                maxDevices,
                maxDevicesPerBranch,
                maxEmployees || null,
                features ? JSON.stringify(features) : null,
                isActive !== undefined ? isActive : true
            ]);

            res.status(201).json({
                success: true,
                message: 'Plan creado exitosamente',
                data: result.rows[0]
            });

        } catch (error) {
            console.error('[SuperAdmin Create Subscription] Error:', error);
            if (error.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'Ya existe un plan con ese nombre'
                });
            }
            res.status(500).json({
                success: false,
                message: 'Error al crear suscripción',
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
    // GET /api/superadmin/tenants/:id/licenses
    // Listar licencias de un tenant
    // ─────────────────────────────────────────────────────────
    router.get('/tenants/:id/licenses', async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                SELECT bl.id, bl.branch_id, bl.status, bl.granted_by, bl.notes,
                       bl.granted_at, bl.activated_at, bl.revoked_at, bl.created_at,
                       b.name as branch_name, b.branch_code, b.is_active as branch_is_active
                FROM branch_licenses bl
                LEFT JOIN branches b ON bl.branch_id = b.id
                WHERE bl.tenant_id = $1
                ORDER BY bl.status ASC, bl.created_at ASC
            `, [id]);

            const total = result.rows.filter(l => l.status !== 'revoked').length;
            const used = result.rows.filter(l => l.status === 'active').length;

            res.json({
                success: true,
                data: {
                    total,
                    used,
                    available: total - used,
                    licenses: result.rows.map(l => ({
                        id: l.id,
                        branchId: l.branch_id,
                        branchName: l.branch_name,
                        branchCode: l.branch_code,
                        branchIsActive: l.branch_is_active,
                        status: l.status,
                        grantedBy: l.granted_by,
                        notes: l.notes,
                        grantedAt: l.granted_at,
                        activatedAt: l.activated_at,
                        revokedAt: l.revoked_at,
                        createdAt: l.created_at
                    }))
                }
            });

        } catch (error) {
            console.error('[SuperAdmin Licenses List] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener licencias',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/tenants/:id/licenses
    // Agregar licencias a un tenant
    // ─────────────────────────────────────────────────────────
    router.post('/tenants/:id/licenses', async (req, res) => {
        try {
            const { id } = req.params;
            const { count = 1, notes } = req.body;

            const licenseCount = Math.min(Math.max(1, parseInt(count) || 1), 50);

            // Verificar que el tenant existe
            const tenantResult = await pool.query(
                'SELECT id, business_name FROM tenants WHERE id = $1',
                [id]
            );

            if (tenantResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            // Insertar licencias
            const insertedIds = [];
            for (let i = 0; i < licenseCount; i++) {
                const result = await pool.query(`
                    INSERT INTO branch_licenses (tenant_id, status, granted_by, notes)
                    VALUES ($1, 'available', 'superadmin', $2)
                    RETURNING id
                `, [id, notes || 'Agregada por superadmin']);
                insertedIds.push(result.rows[0].id);
            }

            // Obtener totales actualizados
            const totalsResult = await pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status IN ('available', 'active')) as total,
                    COUNT(*) FILTER (WHERE status = 'active') as used,
                    COUNT(*) FILTER (WHERE status = 'available') as available
                FROM branch_licenses
                WHERE tenant_id = $1
            `, [id]);

            console.log(`[SuperAdmin] ✅ ${licenseCount} licencia(s) agregada(s) a tenant ${id} (${tenantResult.rows[0].business_name})`);

            res.json({
                success: true,
                message: `${licenseCount} licencia(s) agregada(s) exitosamente`,
                data: {
                    addedIds: insertedIds,
                    totals: {
                        total: parseInt(totalsResult.rows[0].total),
                        used: parseInt(totalsResult.rows[0].used),
                        available: parseInt(totalsResult.rows[0].available)
                    }
                }
            });

        } catch (error) {
            console.error('[SuperAdmin Add Licenses] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al agregar licencias',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // DELETE /api/superadmin/tenants/:tenantId/licenses/:licenseId
    // Revocar una licencia (solo si está 'available')
    // ─────────────────────────────────────────────────────────
    router.delete('/tenants/:tenantId/licenses/:licenseId', async (req, res) => {
        try {
            const { tenantId, licenseId } = req.params;

            // Verificar que la licencia existe y pertenece al tenant
            const licenseResult = await pool.query(
                'SELECT id, status, branch_id FROM branch_licenses WHERE id = $1 AND tenant_id = $2',
                [licenseId, tenantId]
            );

            if (licenseResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Licencia no encontrada'
                });
            }

            const license = licenseResult.rows[0];

            if (license.status === 'active') {
                return res.status(400).json({
                    success: false,
                    message: 'No se puede revocar una licencia activa. Primero desactiva la sucursal asociada.'
                });
            }

            if (license.status === 'revoked') {
                return res.status(400).json({
                    success: false,
                    message: 'Esta licencia ya está revocada'
                });
            }

            // Revocar
            await pool.query(`
                UPDATE branch_licenses
                SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
                WHERE id = $1
            `, [licenseId]);

            console.log(`[SuperAdmin] ✅ Licencia ${licenseId} revocada para tenant ${tenantId}`);

            res.json({
                success: true,
                message: 'Licencia revocada exitosamente'
            });

        } catch (error) {
            console.error('[SuperAdmin Revoke License] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al revocar licencia',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/tenants/:id/telemetry-errors
    // Errores de telemetría (socket_error) de un tenant
    // ─────────────────────────────────────────────────────────
    router.get('/tenants/:id/telemetry-errors', async (req, res) => {
        try {
            const { id } = req.params;
            const { limit = 50, from, to } = req.query;

            let query = `
                SELECT
                    te.id,
                    te.device_name,
                    te.device_id,
                    te.app_version,
                    te.error_reason,
                    te.error_details,
                    te.consecutive_failures,
                    te.event_timestamp,
                    b.name as branch_name
                FROM telemetry_events te
                LEFT JOIN branches b ON te.branch_id = b.id
                WHERE te.tenant_id = $1
                  AND te.event_type = 'socket_error'
            `;
            const params = [id];

            if (from) {
                params.push(from);
                query += ` AND te.event_timestamp >= $${params.length}`;
            }
            if (to) {
                params.push(to);
                query += ` AND te.event_timestamp <= $${params.length}`;
            }

            params.push(parseInt(limit));
            query += ` ORDER BY te.event_timestamp DESC LIMIT $${params.length}`;

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows.map(r => ({
                    id: r.id,
                    deviceName: r.device_name,
                    deviceId: r.device_id,
                    appVersion: r.app_version,
                    errorReason: r.error_reason,
                    errorDetails: r.error_details,
                    consecutiveFailures: r.consecutive_failures,
                    eventTimestamp: r.event_timestamp,
                    branchName: r.branch_name
                }))
            });
        } catch (error) {
            console.error('[Superadmin] Error fetching telemetry errors:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener errores de telemetría'
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // DELETE /api/superadmin/tenants/:id/telemetry-errors
    // Eliminar errores de telemetría por IDs o todos
    // ─────────────────────────────────────────────────────────
    router.delete('/tenants/:id/telemetry-errors', async (req, res) => {
        try {
            const { id } = req.params;
            const { ids } = req.body || {};

            let result;
            if (ids && Array.isArray(ids) && ids.length > 0) {
                result = await pool.query(
                    `DELETE FROM telemetry_events
                     WHERE tenant_id = $1
                       AND event_type = 'socket_error'
                       AND id = ANY($2::int[])
                     RETURNING id`,
                    [id, ids]
                );
            } else {
                result = await pool.query(
                    `DELETE FROM telemetry_events
                     WHERE tenant_id = $1
                       AND event_type = 'socket_error'
                     RETURNING id`,
                    [id]
                );
            }

            console.log(`[Superadmin] Deleted ${result.rowCount} telemetry errors for tenant ${id}`);

            res.json({
                success: true,
                deletedCount: result.rowCount
            });
        } catch (error) {
            console.error('[Superadmin] Error deleting telemetry errors:', error);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar errores de telemetría'
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/online-tenants
    // Tenants con al menos un socket conectado
    // ─────────────────────────────────────────────────────────
    router.get('/online-tenants', (req, res) => {
        try {
            const onlineMap = new Map();
            let totalSockets = 0;
            let skippedNoAuth = 0;
            let skippedNoTenant = 0;

            for (const [, socket] of io.sockets.sockets) {
                totalSockets++;

                // Count sockets that fail our filters for debugging
                if (!socket.authenticated) {
                    skippedNoAuth++;
                    continue;
                }
                if (!socket.user?.tenantId) {
                    skippedNoTenant++;
                    continue;
                }

                const tid = socket.user.tenantId;
                if (!onlineMap.has(tid)) {
                    onlineMap.set(tid, {
                        tenantId: tid,
                        desktopCount: 0,
                        mobileCount: 0,
                        branches: new Set(),
                    });
                }
                const info = onlineMap.get(tid);
                if (socket.clientType === 'desktop') info.desktopCount++;
                else if (socket.clientType === 'mobile') info.mobileCount++;
                if (socket.branchId) info.branches.add(socket.branchId);
            }

            const data = Array.from(onlineMap.values()).map(t => ({
                tenantId: t.tenantId,
                desktopCount: t.desktopCount,
                mobileCount: t.mobileCount,
                branchCount: t.branches.size,
            }));

            const debug = {
                totalSockets,
                authenticatedSockets: totalSockets - skippedNoAuth,
                skippedNoAuth,
                skippedNoTenant,
                uniqueTenants: onlineMap.size,
            };

            console.log(`[Superadmin] Online tenants: ${onlineMap.size} tenants, ${totalSockets} total sockets (noAuth=${skippedNoAuth}, noTenant=${skippedNoTenant})`);

            res.json({ success: true, data, debug });
        } catch (error) {
            console.error('[Superadmin] Error getting online tenants:', error);
            res.status(500).json({ success: false, message: 'Error al obtener tenants en linea' });
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

            // Versiones de app en uso (separadas por plataforma)
            const appVersions = await pool.query(`
                SELECT
                    app_version,
                    COALESCE(platform, 'desktop') as platform,
                    COUNT(DISTINCT tenant_id) as tenants_count,
                    COUNT(*) as total_opens
                FROM telemetry_events
                WHERE event_type = 'app_open'
                AND app_version IS NOT NULL
                AND event_timestamp >= NOW() - INTERVAL '${parseInt(days)} days'
                GROUP BY app_version, platform
                ORDER BY platform ASC, tenants_count DESC
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
    // POST /api/superadmin/register-device
    // Registra un device token FCM del SuperAdmin (SYAAdmin app)
    // Body: { deviceToken, platform, deviceId?, deviceName? }
    // ─────────────────────────────────────────────────────────
    router.post('/register-device', async (req, res) => {
        const { deviceToken, platform, deviceId, deviceName } = req.body || {};

        if (!deviceToken || !platform) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: deviceToken, platform'
            });
        }
        if (!['ios', 'android'].includes(platform)) {
            return res.status(400).json({
                success: false,
                message: 'platform must be "ios" or "android"'
            });
        }

        try {
            // Si llega un deviceId, desactivar tokens previos del mismo
            // dispositivo físico (caso reinstall / token refresh).
            if (deviceId) {
                await pool.query(
                    `UPDATE superadmin_devices
                     SET is_active = FALSE, updated_at = NOW()
                     WHERE device_id = $1 AND device_token <> $2 AND is_active = TRUE`,
                    [deviceId, deviceToken]
                );
            }

            const result = await pool.query(
                `INSERT INTO superadmin_devices
                    (device_token, platform, device_id, device_name, is_active, last_used_at)
                 VALUES ($1, $2, $3, $4, TRUE, NOW())
                 ON CONFLICT (device_token) DO UPDATE SET
                    platform     = EXCLUDED.platform,
                    device_id    = EXCLUDED.device_id,
                    device_name  = EXCLUDED.device_name,
                    is_active    = TRUE,
                    last_used_at = NOW(),
                    updated_at   = NOW()
                 RETURNING id`,
                [deviceToken, platform, deviceId || null, deviceName || null]
            );

            console.log(
                `[Superadmin] ✅ Device registrado id=${result.rows[0].id} platform=${platform}`
            );

            return res.json({
                success: true,
                message: 'Device registered',
                deviceId: result.rows[0].id,
            });
        } catch (err) {
            console.error('[Superadmin] register-device error:', err.message);
            return res.status(500).json({
                success: false,
                message: 'Error registrando device'
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/unregister-device
    // Desactiva el token (logout)
    // Body: { deviceToken }
    // ─────────────────────────────────────────────────────────
    router.post('/unregister-device', async (req, res) => {
        const { deviceToken } = req.body || {};
        if (!deviceToken) {
            return res.status(400).json({
                success: false,
                message: 'deviceToken is required'
            });
        }

        try {
            await pool.query(
                `UPDATE superadmin_devices
                 SET is_active = FALSE, updated_at = NOW()
                 WHERE device_token = $1`,
                [deviceToken]
            );
            return res.json({ success: true, message: 'Device unregistered' });
        } catch (err) {
            console.error('[Superadmin] unregister-device error:', err.message);
            return res.status(500).json({
                success: false,
                message: 'Error desregistrando device'
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/test-notification
    // Envía una notificación de prueba a todos los SuperAdmin devices
    // ─────────────────────────────────────────────────────────
    router.post('/test-notification', async (req, res) => {
        try {
            const { notifySuperadmins } = require('../utils/superadminNotifier');
            const result = await notifySuperadmins(
                '🔔 Test SYA Admin',
                'Si ves esto, las notificaciones FCM funcionan correctamente!',
                { type: 'test' }
            );
            console.log('[Superadmin] Test notification result:', result);
            res.json({ success: true, ...result });
        } catch (err) {
            console.error('[Superadmin] test-notification error:', err.message);
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/test-email
    // Envía un correo de prueba desde no-reply (ejercita sendEmail +
    // copia a Sent folder del no-reply).
    // Body: { to: string }
    // ─────────────────────────────────────────────────────────
    router.post('/test-email', async (req, res) => {
        try {
            const { to } = req.body || {};
            if (!to || typeof to !== 'string') {
                return res.status(400).json({
                    success: false,
                    message: 'Body.to es requerido'
                });
            }

            const html = `
                <p>Hola,</p>
                <p>Esto es un correo de prueba enviado desde <b>no-reply@syatortillerias.com</b>
                   a las ${new Date().toISOString()}.</p>
                <p>Si lo recibes, el envío SMTP funciona. Debería aparecer también en la
                   pestaña <b>Sistema</b> de la app SYA Admin.</p>
                <p>—<br/>SYA Tortillerías</p>
            `;

            const ok = await sendEmail({
                to,
                subject: '🧪 Prueba de correo SYA Admin',
                html,
            });

            return res.json({ success: ok, to });
        } catch (err) {
            console.error('[Superadmin] test-email error:', err.message);
            res.status(500).json({ success: false, message: err.message });
        }
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

    // Generate personalized license reminder HTML (matches renovacion.html design)
    function generateLicenseReminderHTML(businessName, daysRemaining, plan) {
        const isExpired = daysRemaining <= 0;
        const accentColor = isExpired ? '#ef4444' : daysRemaining <= 3 ? '#f59e0b' : '#22d3ee';
        const accentGlow = isExpired ? 'rgba(239,68,68,0.25)' : daysRemaining <= 3 ? 'rgba(245,158,11,0.25)' : 'rgba(34,211,238,0.2)';
        const statusLabel = isExpired ? 'Expirada' : daysRemaining <= 3 ? 'Por vencer' : 'Activa';
        const statusBg = isExpired ? 'rgba(239,68,68,0.15)' : daysRemaining <= 3 ? 'rgba(245,158,11,0.15)' : 'rgba(34,211,238,0.1)';

        const messageText = isExpired
            ? `Tu licencia <strong>ha expirado</strong>. El acceso al sistema puede verse interrumpido. Contacta a tu proveedor SYA para reactivar tu servicio.`
            : daysRemaining <= 3
            ? `Tu licencia vence en <strong>${daysRemaining} dia${daysRemaining === 1 ? '' : 's'}</strong>. Contacta a tu proveedor SYA para renovar y evitar interrupciones en tu servicio.`
            : `Tu licencia vence en <strong>${daysRemaining} dias</strong>. Te recomendamos renovar con anticipacion para asegurar la continuidad de tu servicio.`;

        const progressPercent = isExpired ? 100 : Math.max(5, Math.min(95, ((30 - daysRemaining) / 30) * 100));
        const progressColor = isExpired ? '#ef4444' : daysRemaining <= 3 ? '#f59e0b' : '#22d3ee';

        return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{background:#080e1a;font-family:'Inter','Segoe UI',sans-serif;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:24px;overflow-y:auto}
.card{max-width:620px;width:100%;background:#0c1525;border:1px solid rgba(255,255,255,0.06);border-radius:16px;overflow:hidden}

/* Top bar */
.top-bar{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:1px solid rgba(255,255,255,0.04)}
.top-left{display:flex;align-items:center;gap:12px}
.logo{width:36px;height:36px;border-radius:10px;object-fit:contain}
.app-name{font-size:13px;font-weight:600;color:#e2e8f0;letter-spacing:0.3px}
.app-sub{font-size:11px;color:#475569;font-weight:400}
.status-pill{font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;letter-spacing:0.5px;background:${statusBg};color:${accentColor};border:1px solid ${accentColor}30}

/* Hero */
.hero{padding:36px 28px 28px;text-align:center;position:relative}
.hero::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:200px;height:120px;background:radial-gradient(ellipse,${accentGlow},transparent 70%);pointer-events:none}
.days-number{font-size:72px;font-weight:700;color:${accentColor};line-height:1;position:relative;letter-spacing:-3px}
.days-number.expired{font-size:48px;letter-spacing:0}
.days-label{font-size:13px;color:#64748b;font-weight:500;margin-top:4px;text-transform:uppercase;letter-spacing:2px}
.progress-track{width:100%;max-width:280px;height:4px;background:rgba(255,255,255,0.06);border-radius:2px;margin:20px auto 0;overflow:hidden}
.progress-fill{height:100%;width:${progressPercent}%;background:${progressColor};border-radius:2px;transition:width 0.6s ease}

/* Message */
.message{padding:0 28px 24px}
.message-box{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px 20px}
.message-box p{font-size:13px;color:#94a3b8;line-height:1.7}
.message-box strong{color:${accentColor};font-weight:600}

/* Plan info */
.plan-section{padding:0 28px 24px}
.plan-header{font-size:11px;font-weight:600;color:#475569;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px}
.plan-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:rgba(255,255,255,0.04);border-radius:10px;overflow:hidden}
.plan-item{background:#0c1525;padding:14px 16px;text-align:center}
.plan-item:first-child{border-radius:10px 0 0 10px}
.plan-item:last-child{border-radius:0 10px 10px 0}
.plan-value{font-size:14px;font-weight:600;color:#e2e8f0;margin-bottom:2px}
.plan-label{font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:1px}

/* Features */
.features{padding:0 28px 24px}
.feat-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.03)}
.feat-row:last-child{border-bottom:none}
.feat-dot{width:6px;height:6px;border-radius:50%;background:${accentColor};flex-shrink:0}
.feat-text{font-size:13px;color:#94a3b8}
.feat-text strong{color:#cbd5e1;font-weight:500}

/* Footer */
.footer-bar{padding:16px 28px;border-top:1px solid rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:space-between}
.footer-brand{font-size:11px;color:#334155;font-weight:500;letter-spacing:0.5px}
.footer-contact{font-size:11px;color:#475569}
.footer-contact strong{color:#64748b;font-weight:500}
</style></head><body>
<div class="card">
    <div class="top-bar">
        <div class="top-left">
            <img src="https://sya-socketio-server.onrender.com/public/assets/logo-sya.png" alt="SYA" class="logo">
            <div>
                <div class="app-name">SYA Tortillerias</div>
                <div class="app-sub">Sistema Punto de Venta</div>
            </div>
        </div>
        <span class="status-pill">${statusLabel}</span>
    </div>

    <div class="hero">
        ${isExpired
            ? '<div class="days-number expired">Licencia Expirada</div><div class="days-label">Servicio interrumpido</div>'
            : `<div class="days-number">${daysRemaining}</div><div class="days-label">dia${daysRemaining === 1 ? '' : 's'} restante${daysRemaining === 1 ? '' : 's'}</div>`
        }
        <div class="progress-track"><div class="progress-fill"></div></div>
    </div>

    <div class="message">
        <div class="message-box"><p>${messageText}</p></div>
    </div>

    <div class="plan-section">
        <div class="plan-header">Detalles de licencia</div>
        <div class="plan-grid">
            <div class="plan-item">
                <div class="plan-value">${businessName}</div>
                <div class="plan-label">Negocio</div>
            </div>
            <div class="plan-item">
                <div class="plan-value">${plan}</div>
                <div class="plan-label">Plan</div>
            </div>
            <div class="plan-item">
                <div class="plan-value">${isExpired ? 'Vencida' : daysRemaining + 'd'}</div>
                <div class="plan-label">Vigencia</div>
            </div>
        </div>
    </div>

    <div class="features">
        <div class="plan-header">Incluido en tu plan</div>
        <div class="feat-row"><span class="feat-dot"></span><span class="feat-text"><strong>Punto de Venta</strong> con bascula integrada</span></div>
        <div class="feat-row"><span class="feat-dot"></span><span class="feat-text"><strong>Guardian</strong> sistema anti-fraude en tiempo real</span></div>
        <div class="feat-row"><span class="feat-dot"></span><span class="feat-text"><strong>App Movil</strong> control remoto de tu negocio</span></div>
        <div class="feat-row"><span class="feat-dot"></span><span class="feat-text"><strong>Reportes</strong> ventas, cortes y dashboard</span></div>
        <div class="feat-row"><span class="feat-dot"></span><span class="feat-text"><strong>Soporte</strong> tecnico y actualizaciones incluidas</span></div>
    </div>

    <div class="footer-bar">
        <span class="footer-brand">SYA TORTILLERIAS</span>
        <span class="footer-contact">Contacta a <strong>tu proveedor SYA</strong></span>
    </div>
</div>
</body></html>`;
    }

    // ─────────────────────────────────────────────────────────
    // GET /api/superadmin/beta-enrollments
    // List all tenants who requested beta / more info
    // ─────────────────────────────────────────────────────────
    router.get('/beta-enrollments', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT be.id, be.tenant_id, be.employee_id, be.email,
                       be.business_name, be.platform, be.enrolled_at,
                       t.business_name as tenant_name
                FROM beta_enrollments be
                LEFT JOIN tenants t ON t.id = be.tenant_id
                ORDER BY be.enrolled_at DESC
            `);

            res.json({
                success: true,
                count: result.rows.length,
                data: result.rows
            });
        } catch (error) {
            console.error('[Beta Enrollments] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener beta enrollments' });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/superadmin/license-reminders
    // Enviar recordatorio de licencia personalizado por tenant
    // ─────────────────────────────────────────────────────────
    router.post('/license-reminders', async (req, res) => {
        try {
            const { tenantIds } = req.body;

            if (!tenantIds || !Array.isArray(tenantIds) || tenantIds.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere un array "tenantIds" con al menos un ID'
                });
            }

            // Consultar info de cada tenant
            const tenantsResult = await pool.query(`
                SELECT
                    t.id,
                    t.business_name,
                    t.trial_ends_at,
                    t.subscription_status,
                    s.name as plan_name
                FROM tenants t
                JOIN subscriptions s ON t.subscription_id = s.id
                WHERE t.id = ANY($1)
            `, [tenantIds]);

            if (tenantsResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No se encontraron tenants con esos IDs'
                });
            }

            const results = [];

            for (const tenant of tenantsResult.rows) {
                const now = new Date();
                const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
                const daysRemaining = trialEndsAt
                    ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24))
                    : 0;

                const htmlContent = generateLicenseReminderHTML(
                    tenant.business_name,
                    daysRemaining,
                    tenant.plan_name
                );

                const isExpired = daysRemaining <= 0;
                const title = isExpired
                    ? `${tenant.business_name}: Licencia expirada`
                    : `${tenant.business_name}: Te quedan ${daysRemaining} dia${daysRemaining === 1 ? '' : 's'}`;

                const announcement = {
                    title,
                    htmlContent,
                    type: 'license_reminder',
                    targetTenantId: tenant.id,
                    sentAt: new Date().toISOString()
                };

                // Enviar solo a sockets de este tenant
                let delivered = 0;
                const sockets = await io.fetchSockets();
                for (const socket of sockets) {
                    if (socket.user && socket.user.tenantId === tenant.id) {
                        socket.emit('system:announcement', announcement);
                        delivered++;
                    }
                }

                console.log(`[License Reminder] 📢 "${title}" → ${delivered} socket(s)`);

                results.push({
                    tenantId: tenant.id,
                    name: tenant.business_name,
                    days: daysRemaining,
                    delivered
                });
            }

            res.json({
                success: true,
                message: `${results.length} recordatorios enviados`,
                data: results
            });

        } catch (error) {
            console.error('[License Reminders] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al enviar recordatorios',
                error: undefined
            });
        }
    });

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

// Helper: format bytes to human-readable string
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
