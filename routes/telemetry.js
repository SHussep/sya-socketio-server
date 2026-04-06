// ═══════════════════════════════════════════════════════════════
// RUTAS DE TELEMETRÍA - App opens, scale config, user activity
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireAdminCredentials } = require('../middleware/adminAuth');
const { createTenantValidationMiddleware } = require('../middleware/deviceAuth');

module.exports = (pool) => {
    const router = express.Router();
    const validateTenant = createTenantValidationMiddleware(pool);

    // POST /api/telemetry - Registrar eventos de telemetría (app opens, scale config)
    // Idempotente: usa global_id para evitar duplicados
    router.post('/', validateTenant, async (req, res) => {
        try {
            const {
                tenantId,
                branchId,
                eventType,        // 'app_open' | 'scale_configured' | 'theme_changed' | 'socket_error'
                deviceId,
                deviceName,
                appVersion,
                scaleModel,       // Solo para scale_configured
                scalePort,        // Solo para scale_configured
                themeName,        // Solo para theme_changed
                errorReason,      // Solo para socket_error
                errorDetails,     // Solo para socket_error
                consecutiveFailures, // Solo para socket_error
                global_id,
                terminal_id,
                local_op_seq,
                device_event_raw,
                created_local_utc,
                eventTimestamp
            } = req.body;

            // Validaciones básicas
            if (!tenantId || !branchId || !eventType || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Campos requeridos: tenantId, branchId, eventType, global_id'
                });
            }

            // Validar eventType
            const validEventTypes = ['app_open', 'scale_configured', 'theme_changed', 'socket_error'];
            if (!validEventTypes.includes(eventType)) {
                return res.status(400).json({
                    success: false,
                    message: `eventType inválido. Valores permitidos: ${validEventTypes.join(', ')}`
                });
            }

            // Verificar que tenant y branch existen
            const tenantCheck = await pool.query(
                'SELECT id FROM tenants WHERE id = $1',
                [tenantId]
            );
            if (tenantCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const branchCheck = await pool.query(
                'SELECT id FROM branches WHERE id = $1 AND tenant_id = $2',
                [branchId, tenantId]
            );
            if (branchCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada para este tenant'
                });
            }

            // Insertar evento (ON CONFLICT para idempotencia)
            const result = await pool.query(`
                INSERT INTO telemetry_events (
                    tenant_id, branch_id, event_type,
                    device_id, device_name, app_version,
                    scale_model, scale_port, theme_name,
                    error_reason, error_details, consecutive_failures,
                    global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc,
                    event_timestamp
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, COALESCE($18, NOW()))
                ON CONFLICT (global_id) DO NOTHING
                RETURNING id
            `, [
                tenantId,
                branchId,
                eventType,
                deviceId || null,
                deviceName || null,
                appVersion || null,
                scaleModel || null,
                scalePort || null,
                themeName || null,
                errorReason || null,
                errorDetails || null,
                consecutiveFailures != null ? parseInt(consecutiveFailures) : null,
                global_id,
                terminal_id || null,
                local_op_seq || null,
                device_event_raw || null,
                created_local_utc || null,
                eventTimestamp || null
            ]);

            const wasInserted = result.rows.length > 0;
            const eventId = wasInserted ? result.rows[0].id : null;

            console.log(`[Telemetry] ${wasInserted ? '✅ NUEVO' : '⏭️ DUPLICADO'} ${eventType} - Tenant: ${tenantId}, Branch: ${branchId}${scaleModel ? `, Scale: ${scaleModel}` : ''}${themeName ? `, Theme: ${themeName}` : ''}${errorReason ? `, Reason: ${errorReason}, Failures: ${consecutiveFailures}` : ''}`);

            res.status(wasInserted ? 201 : 200).json({
                success: true,
                message: wasInserted ? 'Evento registrado' : 'Evento ya existía (idempotente)',
                data: {
                    id: eventId,
                    globalId: global_id,
                    eventType,
                    wasInserted
                }
            });

        } catch (error) {
            console.error('[Telemetry] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al registrar evento de telemetría'
            });
        }
    });

    // POST /api/telemetry/mobile - Registrar telemetría desde app móvil (autenticado)
    router.post('/mobile', authenticateToken, async (req, res) => {
        try {
            const { employeeId, tenantId, branchId } = req.user;
            const {
                eventType,        // 'app_open' | 'app_resume' | 'theme_changed'
                deviceId,
                deviceName,
                appVersion,
                platform,         // 'android' | 'ios'
                global_id,
                eventTimestamp,
                themeName         // nombre del tema actual
            } = req.body;

            // Validaciones básicas
            if (!eventType || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Campos requeridos: eventType, global_id'
                });
            }

            const validEventTypes = ['app_open', 'app_resume', 'theme_changed'];
            if (!validEventTypes.includes(eventType)) {
                return res.status(400).json({
                    success: false,
                    message: `eventType inválido. Valores permitidos: ${validEventTypes.join(', ')}`
                });
            }

            const result = await pool.query(`
                INSERT INTO telemetry_events (
                    tenant_id, branch_id, employee_id, event_type,
                    device_id, device_name, app_version, platform,
                    theme_name, global_id, event_timestamp
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, NOW()))
                ON CONFLICT (global_id) DO NOTHING
                RETURNING id
            `, [
                tenantId,
                branchId || null,
                employeeId,
                eventType,
                deviceId || null,
                deviceName || null,
                appVersion || null,
                platform || null,
                themeName || null,
                global_id,
                eventTimestamp || null
            ]);

            const wasInserted = result.rows.length > 0;

            console.log(`[Telemetry Mobile] ${wasInserted ? '✅ NUEVO' : '⏭️ DUP'} ${eventType} - Employee: ${employeeId}, Branch: ${branchId}, Platform: ${platform || 'unknown'}${themeName ? ', Theme: ' + themeName : ''}`);

            res.status(wasInserted ? 201 : 200).json({
                success: true,
                data: { wasInserted, globalId: global_id }
            });
        } catch (error) {
            console.error('[Telemetry Mobile] Error:', error);
            res.status(500).json({ success: false, message: 'Error al registrar evento de telemetría' });
        }
    });

    // GET /api/telemetry/user-activity - Actividad por empleado (admin/owner)
    router.get('/user-activity', authenticateToken, async (req, res) => {
        try {
            const { tenantId, roleId, employeeId: requesterId } = req.user;

            // Solo admins (roleId 1) y owners pueden ver actividad de todos
            if (roleId !== 1) {
                const ownerCheck = await pool.query(
                    'SELECT is_owner FROM employees WHERE id = $1 AND tenant_id = $2',
                    [requesterId, tenantId]
                );
                if (!ownerCheck.rows[0]?.is_owner) {
                    return res.status(403).json({ success: false, message: 'Acceso solo para administradores y owners' });
                }
            }

            const { startDate, endDate, branchId, employeeId } = req.query;

            // Default: últimos 30 días
            const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const end = endDate || new Date().toISOString().split('T')[0];

            // Actividad diaria por empleado
            let query = `
                SELECT
                    te.employee_id,
                    e.username,
                    CONCAT(e.first_name, ' ', e.last_name) as full_name,
                    r.name as role_name,
                    e.role_id,
                    e.is_owner,
                    DATE(te.event_timestamp) as date,
                    COUNT(*) FILTER (WHERE te.event_type = 'app_open') as app_opens,
                    COUNT(*) FILTER (WHERE te.event_type = 'app_resume') as app_resumes,
                    MIN(te.event_timestamp) as first_open,
                    MAX(te.event_timestamp) as last_open,
                    te.platform
                FROM telemetry_events te
                JOIN employees e ON te.employee_id = e.id
                LEFT JOIN roles r ON e.role_id = r.id
                WHERE te.tenant_id = $1
                  AND te.employee_id IS NOT NULL
                  AND te.event_type IN ('app_open', 'app_resume')
                  AND DATE(te.event_timestamp) >= $2
                  AND DATE(te.event_timestamp) <= $3
            `;
            const params = [tenantId, start, end];
            let paramIdx = 4;

            if (branchId) {
                query += ` AND te.branch_id = $${paramIdx}`;
                params.push(parseInt(branchId));
                paramIdx++;
            }
            if (employeeId) {
                query += ` AND te.employee_id = $${paramIdx}`;
                params.push(parseInt(employeeId));
                paramIdx++;
            }

            query += `
                GROUP BY te.employee_id, e.username, e.first_name, e.last_name,
                         r.name, e.role_id, e.is_owner, DATE(te.event_timestamp), te.platform
                ORDER BY date DESC, app_opens DESC
            `;

            const result = await pool.query(query, params);

            // Resumen: usuarios únicos, aperturas por rol
            const summary = await pool.query(`
                SELECT
                    COUNT(DISTINCT te.employee_id) as unique_users,
                    COUNT(*) FILTER (WHERE te.event_type = 'app_open') as total_opens,
                    COUNT(*) FILTER (WHERE te.event_type = 'app_resume') as total_resumes,
                    COUNT(DISTINCT te.employee_id) FILTER (WHERE e.role_id = 1) as admin_users,
                    COUNT(DISTINCT te.employee_id) FILTER (WHERE e.is_owner = true) as owner_users,
                    COUNT(DISTINCT te.employee_id) FILTER (WHERE e.role_id = 3) as repartidor_users
                FROM telemetry_events te
                JOIN employees e ON te.employee_id = e.id
                WHERE te.tenant_id = $1
                  AND te.employee_id IS NOT NULL
                  AND te.event_type IN ('app_open', 'app_resume')
                  AND DATE(te.event_timestamp) >= $2
                  AND DATE(te.event_timestamp) <= $3
            `, [tenantId, start, end]);

            // Tema más reciente por empleado
            const themesResult = await pool.query(`
                SELECT DISTINCT ON (employee_id)
                    employee_id,
                    theme_name
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND employee_id IS NOT NULL
                  AND theme_name IS NOT NULL
                ORDER BY employee_id, event_timestamp DESC
            `, [tenantId]);

            const themesByEmployee = {};
            for (const row of themesResult.rows) {
                themesByEmployee[row.employee_id] = row.theme_name;
            }

            console.log(`[User Activity] Tenant ${tenantId}: ${result.rows.length} registros, ${summary.rows[0]?.unique_users || 0} usuarios únicos`);

            res.json({
                success: true,
                data: {
                    summary: summary.rows[0],
                    dailyActivity: result.rows,
                    themesByEmployee
                }
            });
        } catch (error) {
            console.error('[User Activity] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener actividad de usuarios' });
        }
    });

    // GET /api/telemetry/stats - Obtener estadísticas de telemetría (admin)
    router.get('/stats', requireAdminCredentials, async (req, res) => {
        try {
            // Total de aperturas de app por tenant/branch
            const appOpens = await pool.query(`
                SELECT
                    t.business_name as tenant_name,
                    b.name as branch_name,
                    COUNT(*) as total_opens,
                    MAX(te.event_timestamp) as last_open
                FROM telemetry_events te
                JOIN tenants t ON te.tenant_id = t.id
                JOIN branches b ON te.branch_id = b.id
                WHERE te.event_type = 'app_open'
                GROUP BY t.id, t.business_name, b.id, b.name
                ORDER BY total_opens DESC
            `);

            // Configuraciones de báscula
            const scaleConfigs = await pool.query(`
                SELECT
                    t.business_name as tenant_name,
                    b.name as branch_name,
                    te.scale_model,
                    te.scale_port,
                    te.event_timestamp as configured_at
                FROM telemetry_events te
                JOIN tenants t ON te.tenant_id = t.id
                JOIN branches b ON te.branch_id = b.id
                WHERE te.event_type = 'scale_configured'
                ORDER BY te.event_timestamp DESC
            `);

            // Resumen
            const summary = await pool.query(`
                SELECT
                    (SELECT COUNT(DISTINCT branch_id) FROM telemetry_events WHERE event_type = 'app_open') as branches_with_app,
                    (SELECT COUNT(DISTINCT branch_id) FROM telemetry_events WHERE event_type = 'scale_configured') as branches_with_scale,
                    (SELECT COUNT(*) FROM telemetry_events WHERE event_type = 'app_open') as total_app_opens,
                    (SELECT COUNT(DISTINCT scale_model) FROM telemetry_events WHERE event_type = 'scale_configured' AND scale_model IS NOT NULL) as unique_scale_models
            `);

            res.json({
                success: true,
                data: {
                    summary: summary.rows[0],
                    appOpensByBranch: appOpens.rows,
                    scaleConfigurations: scaleConfigs.rows
                }
            });

        } catch (error) {
            console.error('[Telemetry Stats] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener estadísticas',
                error: undefined
            });
        }
    });

    return router;
};
