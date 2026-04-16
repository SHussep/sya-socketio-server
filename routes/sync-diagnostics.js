/**
 * Sync Diagnostics API
 * Endpoint para obtener conteos de registros por entidad (debug/diagnóstico)
 * Permite comparar registros locales (SQLite) vs PostgreSQL
 */

const express = require('express');
const router = express.Router();
const { createTenantValidationMiddleware } = require('../middleware/deviceAuth');
const { authenticateToken } = require('../middleware/auth');
const Ajv = require('ajv');

// ═══════════════════════════════════════════════════════════════
// Task 8: /census and /verify endpoints (Fase 2 - Census reporting)
// ═══════════════════════════════════════════════════════════════

// AJV instance with strict mode (rejects unknown / extra properties).
const ajv = new Ajv({ allErrors: true, strict: true });

// Census payload schema — posted ~daily by desktop.
// `additionalProperties: false` at the root ensures ajv rejects unknown keys
// (required by the "rejects extra properties" test).
const censusSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['tenantId', 'branchId', 'deviceId', 'takenAt', 'summary', 'byEntityType'],
    properties: {
        tenantId: { type: 'integer' },
        branchId: { type: 'integer' },
        deviceId: { type: 'string', minLength: 1, maxLength: 200 },
        deviceName: { type: 'string', maxLength: 200 },
        appVersion: { type: 'string', maxLength: 50 },
        takenAt: { type: 'string', minLength: 1, maxLength: 40 },
        summary: { type: 'object' },
        byEntityType: { type: 'array' },
        suspiciousRecords: { type: 'array' },
        handlerStats: { type: 'array' }
    }
};

// Verify payload schema.
const verifySchema = {
    type: 'object',
    additionalProperties: false,
    required: ['entityType', 'globalId'],
    properties: {
        entityType: { type: 'string', minLength: 1, maxLength: 80 },
        globalId: { type: 'string', minLength: 1, maxLength: 80 }
    }
};

// We accept any non-empty string for takenAt to avoid requiring ajv-formats
// (kept schema minimal; the PG column is TIMESTAMPTZ and will parse ISO strings).
const validateCensus = ajv.compile(censusSchema);
const validateVerify = ajv.compile(verifySchema);

// Whitelist of entity types → (table, globalId column).
// Built from existing entityConfig in verify-global-ids and real PG schema
// (verified against schema.sql + migrations on 2026-04-16).
// NOTE: desktop entity type names (PascalCase C#) mapped to backend tables.
const ALLOWED_ENTITY_TYPES = {
    Venta:                   { table: 'ventas', col: 'global_id' },
    Expense:                 { table: 'expenses', col: 'global_id' },
    Shift:                   { table: 'shifts', col: 'global_id' },
    CashDrawerSession:       { table: 'cash_cuts', col: 'global_id' },
    Deposit:                 { table: 'deposits', col: 'global_id' },
    Withdrawal:              { table: 'withdrawals', col: 'global_id' },
    Employee:                { table: 'employees', col: 'global_id' },
    Customer:                { table: 'customers', col: 'global_id' },
    Product:                 { table: 'productos', col: 'global_id' },
    CreditPayment:           { table: 'credit_payments', col: 'global_id' },
    RepartidorAssignment:    { table: 'repartidor_assignments', col: 'global_id' },
    RepartidorReturn:        { table: 'repartidor_returns', col: 'global_id' },
    SuspiciousWeighingLog:   { table: 'suspicious_weighing_logs', col: 'global_id' },
    ScaleDisconnectionLog:   { table: 'scale_disconnection_logs', col: 'global_id' },
    Purchase:                { table: 'purchases', col: 'global_id' },
    NotaCredito:             { table: 'notas_credito', col: 'global_id' },
    PreparationModeLog:      { table: 'preparation_mode_logs', col: 'global_id' },
    InventoryTransfer:       { table: 'inventory_transfers', col: 'global_id' },
    CustomerProductPrice:    { table: 'customer_product_prices', col: 'global_id' },
    KardexEntry:             { table: 'kardex_entries', col: 'global_id' },
    ProductoBranchPrecio:    { table: 'productos_branch_precios', col: 'global_id' }
};

// In-memory 1-per-hour rate limiter per deviceId for /census.
// Matches existing rateLimiter.js pattern (Map + setInterval cleanup) and
// avoids pulling in express-rate-limit as a new dependency.
const CENSUS_WINDOW_MS = 60 * 60 * 1000;
const censusLastSeenByDevice = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of censusLastSeenByDevice.entries()) {
        if (now - ts > CENSUS_WINDOW_MS * 2) censusLastSeenByDevice.delete(key);
    }
}, 10 * 60 * 1000).unref?.();

function censusRateLimit(req, res, next) {
    const deviceId = req.body?.deviceId;
    if (!deviceId || typeof deviceId !== 'string') return next(); // schema check handles this
    const key = `${req.user?.tenantId || 'x'}:${deviceId}`;
    const now = Date.now();
    const last = censusLastSeenByDevice.get(key);
    if (last && (now - last) < CENSUS_WINDOW_MS) {
        return res.status(429).json({
            success: false,
            message: 'Census already received from this device within the last hour',
            retryAfterSeconds: Math.ceil((CENSUS_WINDOW_MS - (now - last)) / 1000)
        });
    }
    // We record on successful INSERT below; expose helper on req.
    req._censusMarkAccepted = () => censusLastSeenByDevice.set(key, Date.now());
    next();
}

function ensureSameTenant(req, res, next) {
    const jwtTenantId = Number(req.user?.tenantId);
    const bodyTenantId = Number(req.body?.tenantId);
    if (!jwtTenantId || !bodyTenantId || jwtTenantId !== bodyTenantId) {
        return res.status(403).json({ success: false, message: 'tenantId mismatch' });
    }
    next();
}

module.exports = (pool) => {

    const validateTenant = createTenantValidationMiddleware(pool);

    // GET /api/sync-diagnostics/counts/:tenantId/:branchId
    // Obtiene conteos de todas las entidades sincronizables para un tenant/branch
    router.get('/counts/:tenantId/:branchId', async (req, res) => {
        const { tenantId, branchId } = req.params;

        // Validar que tenantId y branchId sean enteros positivos
        const parsedTenantId = parseInt(tenantId, 10);
        const parsedBranchId = parseInt(branchId, 10);
        if (isNaN(parsedTenantId) || parsedTenantId <= 0 || isNaN(parsedBranchId) || parsedBranchId <= 0) {
            return res.status(400).json({ success: false, message: 'tenantId y branchId deben ser enteros positivos' });
        }

        try {
            console.log(`[SyncDiagnostics] 📊 Obteniendo conteos para tenant=${parsedTenantId}, branch=${parsedBranchId}`);

            const counts = {};

            // Ventas (solo de esta sucursal)
            const salesResult = await pool.query(
                'SELECT COUNT(*) as count FROM ventas WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.sales = parseInt(salesResult.rows[0].count);

            // Gastos (solo de esta sucursal)
            const expensesResult = await pool.query(
                'SELECT COUNT(*) as count FROM expenses WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.expenses = parseInt(expensesResult.rows[0].count);

            // Cortes de caja (solo de esta sucursal)
            const cashCutsResult = await pool.query(
                'SELECT COUNT(*) as count FROM cash_cuts WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.cashCuts = parseInt(cashCutsResult.rows[0].count);

            // Depósitos (solo de esta sucursal)
            const depositsResult = await pool.query(
                'SELECT COUNT(*) as count FROM deposits WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.deposits = parseInt(depositsResult.rows[0].count);

            // Retiros (solo de esta sucursal)
            const withdrawalsResult = await pool.query(
                'SELECT COUNT(*) as count FROM withdrawals WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.withdrawals = parseInt(withdrawalsResult.rows[0].count);

            // Turnos (solo de esta sucursal)
            const shiftsResult = await pool.query(
                'SELECT COUNT(*) as count FROM shifts WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.shifts = parseInt(shiftsResult.rows[0].count);

            // Pagos de crédito (solo de esta sucursal)
            const creditPaymentsResult = await pool.query(
                'SELECT COUNT(*) as count FROM credit_payments WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.creditPayments = parseInt(creditPaymentsResult.rows[0].count);

            // Clientes (todo el tenant, no por sucursal)
            // Excluir cliente genérico del sistema (is_system_generic = TRUE)
            const customersResult = await pool.query(
                'SELECT COUNT(*) as count FROM customers WHERE tenant_id = $1 AND (is_system_generic = FALSE OR is_system_generic IS NULL)',
                [parsedTenantId]
            );
            counts.customers = parseInt(customersResult.rows[0].count);

            // Empleados (todo el tenant)
            const employeesResult = await pool.query(
                'SELECT COUNT(*) as count FROM employees WHERE tenant_id = $1',
                [parsedTenantId]
            );
            counts.employees = parseInt(employeesResult.rows[0].count);

            // Asignaciones de repartidor (solo de esta sucursal)
            const assignmentsResult = await pool.query(
                'SELECT COUNT(*) as count FROM repartidor_assignments WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.repartidorAssignments = parseInt(assignmentsResult.rows[0].count);

            // Devoluciones de repartidor (solo de esta sucursal)
            const returnsResult = await pool.query(
                'SELECT COUNT(*) as count FROM repartidor_returns WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.repartidorReturns = parseInt(returnsResult.rows[0].count);

            // Guardian logs (solo de esta sucursal)
            const guardianLogsResult = await pool.query(
                'SELECT COUNT(*) as count FROM suspicious_weighing_logs WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.guardianLogs = parseInt(guardianLogsResult.rows[0].count);

            // Scale disconnection logs (solo de esta sucursal)
            const scaleLogsResult = await pool.query(
                'SELECT COUNT(*) as count FROM scale_disconnection_logs WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.scaleDisconnectionLogs = parseInt(scaleLogsResult.rows[0].count);

            // Cancelaciones (solo de esta sucursal)
            const cancelacionesResult = await pool.query(
                'SELECT COUNT(*) as count FROM cancelaciones_bitacora WHERE tenant_id = $1 AND branch_id = $2',
                [parsedTenantId, parsedBranchId]
            );
            counts.cancelaciones = parseInt(cancelacionesResult.rows[0].count);

            console.log(`[SyncDiagnostics] ✅ Conteos obtenidos:`, counts);

            res.json({
                success: true,
                data: counts,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('[SyncDiagnostics] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error obteniendo conteos'
            });
        }
    });

    // =========================================================================
    // POST /api/sync-diagnostics/verify-global-ids
    // Recibe listas de global_ids por entidad y verifica cuáles existen en PostgreSQL.
    // Permite detectar registros marcados como sincronizados en SQLite que no llegaron al backend.
    // =========================================================================
    router.post('/verify-global-ids', validateTenant, async (req, res) => {
        const { tenantId, branchId, entities } = req.body;

        // Validar inputs requeridos
        if (!tenantId || !entities || typeof entities !== 'object') {
            return res.status(400).json({
                success: false,
                message: 'Se requiere tenantId y entities (objeto con arrays de global_ids por entidad)'
            });
        }

        // Validar que tenantId y branchId sean enteros positivos
        const parsedTenantId = parseInt(tenantId, 10);
        const parsedBranchId = branchId ? parseInt(branchId, 10) : null;
        if (isNaN(parsedTenantId) || parsedTenantId <= 0) {
            return res.status(400).json({ success: false, message: 'tenantId debe ser un entero positivo' });
        }
        if (branchId && (isNaN(parsedBranchId) || parsedBranchId <= 0)) {
            return res.status(400).json({ success: false, message: 'branchId debe ser un entero positivo' });
        }

        try {
            console.log(`[SyncDiagnostics] 🔍 Verificando global_ids para tenant=${parsedTenantId}, branch=${parsedBranchId}`);

            // Mapeo de nombre de entidad → configuración de tabla
            const entityConfig = {
                ventas: { table: 'ventas', useBranch: true },
                expenses: { table: 'expenses', useBranch: true },
                shifts: { table: 'shifts', useBranch: true },
                cash_cuts: { table: 'cash_cuts', useBranch: true },
                deposits: { table: 'deposits', useBranch: true },
                withdrawals: { table: 'withdrawals', useBranch: true },
                employees: { table: 'employees', useBranch: false },
                customers: { table: 'customers', useBranch: false },
                productos: { table: 'productos', useBranch: false },
                credit_payments: { table: 'credit_payments', useBranch: true },
                repartidor_assignments: { table: 'repartidor_assignments', useBranch: true },
                repartidor_returns: { table: 'repartidor_returns', useBranch: true },
                repartidor_liquidations: { table: 'repartidor_liquidations', useBranch: true },
                suspicious_weighing_logs: { table: 'suspicious_weighing_logs', useBranch: true },
                scale_disconnection_logs: { table: 'scale_disconnection_logs', useBranch: true },
                purchases: { table: 'purchases', useBranch: true },
                notas_credito: { table: 'notas_credito', useBranch: true },
                cancelaciones_bitacora: { table: 'cancelaciones_bitacora', useBranch: true },
                employee_daily_metrics: { table: 'employee_daily_metrics', useBranch: true },
                employee_debts: { table: 'employee_debts', useBranch: false },
                proveedores: { table: 'proveedores', useBranch: false },
                preparation_mode_logs: { table: 'preparation_mode_logs', useBranch: true }
            };

            const results = {};
            let totalSent = 0;
            let totalFound = 0;
            let totalMissing = 0;

            for (const [entityName, globalIds] of Object.entries(entities)) {
                if (!Array.isArray(globalIds) || globalIds.length === 0) continue;

                const config = entityConfig[entityName];
                if (!config) {
                    // Entidad no reconocida - omitir silenciosamente (no reflejar input del usuario en respuesta)
                    console.warn(`[SyncDiagnostics] ⚠️ Entidad no reconocida: ${entityName}`);
                    continue;
                }

                // Limitar a 10000 por entidad (UUIDs son ~36 chars, 10000 x 36 = ~360KB - aceptable)
                // Filtrar solo strings válidos (UUIDs/GlobalIds) - rechazar valores no-string
                const sanitizedIds = globalIds
                    .filter(id => typeof id === 'string' && id.length > 0 && id.length <= 50)
                    .slice(0, 10000);

                if (sanitizedIds.length === 0) continue;

                try {
                    // Query: buscar cuáles de estos global_ids existen
                    // Nota: config.table viene del whitelist entityConfig, nunca del input del usuario
                    // Usar global_id::text para compatibilidad con columnas tipo uuid o text
                    let query, params;
                    if (config.useBranch && parsedBranchId) {
                        query = `SELECT global_id::text FROM ${config.table} WHERE tenant_id = $1 AND branch_id = $2 AND global_id::text = ANY($3::text[])`;
                        params = [parsedTenantId, parsedBranchId, sanitizedIds];
                    } else {
                        query = `SELECT global_id::text FROM ${config.table} WHERE tenant_id = $1 AND global_id::text = ANY($2::text[])`;
                        params = [parsedTenantId, sanitizedIds];
                    }

                    const result = await pool.query(query, params);
                    const foundIds = new Set(result.rows.map(r => r.global_id));
                    const missingIds = sanitizedIds.filter(id => !foundIds.has(id));

                    results[entityName] = {
                        sent: sanitizedIds.length,
                        found: foundIds.size,
                        missing: missingIds
                    };

                    totalSent += sanitizedIds.length;
                    totalFound += foundIds.size;
                    totalMissing += missingIds.length;

                    if (missingIds.length > 0) {
                        console.log(`[SyncDiagnostics] ⚠️ ${entityName}: ${missingIds.length}/${sanitizedIds.length} faltantes`);
                    }
                } catch (queryError) {
                    console.error(`[SyncDiagnostics] ❌ Error consultando ${entityName}:`, queryError.message);
                    results[entityName] = {
                        sent: sanitizedIds.length,
                        found: 0,
                        missing: sanitizedIds,
                        error: 'Error interno al consultar entidad'
                    };
                    totalSent += sanitizedIds.length;
                    totalMissing += sanitizedIds.length;
                }
            }

            console.log(`[SyncDiagnostics] ✅ Verificación completada: ${totalFound}/${totalSent} encontrados, ${totalMissing} faltantes`);

            res.json({
                success: true,
                results,
                summary: {
                    totalSent,
                    totalFound,
                    totalMissing
                },
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('[SyncDiagnostics] ❌ Error en verify-global-ids:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error interno del servidor'
            });
        }
    });

    // =========================================================================
    // POST /api/sync-diagnostics/report
    // Recibe reportes de errores de sincronización desde Desktop.
    // Guarda en sync_error_reports y notifica al owner via Socket.IO.
    // =========================================================================
    router.post('/report', validateTenant, async (req, res) => {
        const { tenantId, branchId, deviceId, deviceName, appVersion, autoGenerated, syncStats, errors } = req.body;

        if (!tenantId || !branchId || !deviceId) {
            return res.status(400).json({
                success: false,
                message: 'Se requiere tenantId, branchId y deviceId'
            });
        }

        try {
            console.log(`[SyncDiagnostics] 📨 Reporte de sync recibido de ${deviceName || deviceId} (tenant=${tenantId}, branch=${branchId}, auto=${!!autoGenerated})`);

            const result = await pool.query(
                `INSERT INTO sync_error_reports (tenant_id, branch_id, device_id, device_name, app_version, auto_generated, sync_stats, errors)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING id, created_at`,
                [tenantId, branchId, deviceId, deviceName || null, appVersion || null, !!autoGenerated,
                 syncStats ? JSON.stringify(syncStats) : null,
                 errors ? JSON.stringify(errors) : null]
            );

            const reportId = result.rows[0].id;

            // Notificar al owner via Socket.IO si está disponible
            const io = req.app.get('io');
            if (io) {
                // Buscar el tenant room del owner
                const branchInfo = await pool.query(
                    'SELECT b.name as branch_name, t.business_name FROM branches b JOIN tenants t ON b.tenant_id = t.id WHERE b.id = $1 AND b.tenant_id = $2',
                    [branchId, tenantId]
                );
                const branchName = branchInfo.rows[0]?.branch_name || `Sucursal ${branchId}`;

                const errorCount = Array.isArray(errors) ? errors.length : 0;
                const totalPending = syncStats?.totalPending || 0;

                io.to(`tenant_${tenantId}`).emit('sync_error_report_received', {
                    reportId,
                    branchId,
                    branchName,
                    deviceName: deviceName || deviceId,
                    autoGenerated: !!autoGenerated,
                    totalPending,
                    errorCount,
                    createdAt: result.rows[0].created_at
                });

                console.log(`[SyncDiagnostics] 📡 Notificacion enviada a tenant_${tenantId}`);
            }

            res.json({
                success: true,
                reportId,
                message: 'Reporte recibido y almacenado'
            });

        } catch (error) {
            console.error('[SyncDiagnostics] ❌ Error guardando reporte:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error interno al guardar reporte'
            });
        }
    });

    // =========================================================================
    // GET /api/sync-diagnostics/reports/:tenantId
    // Lista reportes de errores de sincronización para un tenant.
    // Permite al admin ver qué dispositivos están teniendo problemas.
    // =========================================================================
    router.get('/reports/:tenantId', validateTenant, async (req, res) => {
        const { tenantId } = req.params;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const branchId = req.query.branchId || null;

        try {
            let query = `
                SELECT r.*, b.name as branch_name
                FROM sync_error_reports r
                LEFT JOIN branches b ON r.branch_id = b.id
                WHERE r.tenant_id = $1
            `;
            const params = [tenantId];

            if (branchId) {
                query += ` AND r.branch_id = $2`;
                params.push(branchId);
            }

            query += ` ORDER BY r.created_at DESC LIMIT $${params.length + 1}`;
            params.push(limit);

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows.map(r => ({
                    id: r.id,
                    branchId: r.branch_id,
                    branchName: r.branch_name,
                    deviceId: r.device_id,
                    deviceName: r.device_name,
                    appVersion: r.app_version,
                    autoGenerated: r.auto_generated,
                    syncStats: r.sync_stats,
                    errors: r.errors,
                    createdAt: r.created_at
                }))
            });
        } catch (error) {
            console.error('[SyncDiagnostics] ❌ Error listando reportes:', error.message);
            res.status(500).json({ success: false, message: 'Error listando reportes' });
        }
    });

    // =========================================================================
    // POST /api/sync-diagnostics/events
    // Recibe un batch de eventos de sincronización individuales desde Desktop/Mobile.
    // Cada evento tiene contexto completo: dependencias, conexión, error detail.
    // =========================================================================
    router.post('/events', validateTenant, async (req, res) => {
        const { tenantId, branchId, deviceId, deviceType, deviceName, appVersion, syncCycleId, events } = req.body;

        if (!tenantId || !branchId || !deviceId || !Array.isArray(events)) {
            return res.status(400).json({
                success: false,
                message: 'Se requiere tenantId, branchId, deviceId y events (array)'
            });
        }

        if (events.length > 500) {
            return res.status(400).json({ success: false, message: 'Máximo 500 eventos por batch' });
        }

        try {
            let inserted = 0;
            for (const evt of events) {
                try {
                    await pool.query(`
                        INSERT INTO sync_events (
                            tenant_id, branch_id, device_id, device_type, device_name,
                            entity_type, entity_global_id, entity_description,
                            operation, sync_mode, status,
                            http_status_code, error_category, error_message, error_detail,
                            endpoint, request_summary, dependency_info, connection_info,
                            retry_count, first_occurred_at, resolved_at,
                            app_version, employee_id, employee_name,
                            shift_global_id, sync_cycle_id
                        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
                    `, [
                        tenantId, branchId, deviceId,
                        deviceType || 'desktop', deviceName || null,
                        evt.entityType, evt.entityGlobalId || null, evt.entityDescription || null,
                        evt.operation || 'create', evt.syncMode || 'offline_first', evt.status || 'failed',
                        evt.httpStatusCode || null, evt.errorCategory || null,
                        evt.errorMessage || null, evt.errorDetail || null,
                        evt.endpoint || null,
                        evt.requestSummary ? JSON.stringify(evt.requestSummary) : null,
                        evt.dependencyInfo ? JSON.stringify(evt.dependencyInfo) : null,
                        evt.connectionInfo ? JSON.stringify(evt.connectionInfo) : null,
                        evt.retryCount || 0,
                        evt.firstOccurredAt || null, evt.resolvedAt || null,
                        appVersion || null, evt.employeeId || null, evt.employeeName || null,
                        evt.shiftGlobalId || null, syncCycleId || null
                    ]);
                    inserted++;
                } catch (evtErr) {
                    console.error(`[SyncEvents] ❌ Error inserting event: ${evtErr.message}`);
                }
            }

            console.log(`[SyncEvents] 📊 ${inserted}/${events.length} eventos insertados (tenant=${tenantId}, branch=${branchId}, cycle=${syncCycleId || 'N/A'})`);

            res.json({ success: true, inserted, total: events.length });
        } catch (error) {
            console.error('[SyncEvents] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error guardando eventos' });
        }
    });

    // =========================================================================
    // GET /api/sync-diagnostics/events/:tenantId
    // Lista eventos de sincronización con filtros avanzados.
    // Query params: branchId, status, entityType, deviceType, since, syncCycleId, limit
    // =========================================================================
    router.get('/events/:tenantId', validateTenant, async (req, res) => {
        const { tenantId } = req.params;
        const {
            branchId, status, entityType, deviceType,
            since, syncCycleId,
            limit: rawLimit
        } = req.query;
        const limit = Math.min(parseInt(rawLimit) || 50, 500);

        try {
            let query = `
                SELECT se.*, b.name as branch_name
                FROM sync_events se
                LEFT JOIN branches b ON se.branch_id = b.id
                WHERE se.tenant_id = $1
            `;
            const params = [tenantId];
            let paramIdx = 2;

            if (branchId) {
                query += ` AND se.branch_id = $${paramIdx++}`;
                params.push(branchId);
            }
            if (status) {
                query += ` AND se.status = $${paramIdx++}`;
                params.push(status);
            }
            if (entityType) {
                query += ` AND se.entity_type = $${paramIdx++}`;
                params.push(entityType);
            }
            if (deviceType) {
                query += ` AND se.device_type = $${paramIdx++}`;
                params.push(deviceType);
            }
            if (since) {
                query += ` AND se.created_at >= $${paramIdx++}`;
                params.push(since);
            }
            if (syncCycleId) {
                query += ` AND se.sync_cycle_id = $${paramIdx++}`;
                params.push(syncCycleId);
            }

            query += ` ORDER BY se.created_at DESC LIMIT $${paramIdx}`;
            params.push(limit);

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });
        } catch (error) {
            console.error('[SyncEvents] ❌ Error listing events:', error.message);
            res.status(500).json({ success: false, message: 'Error listando eventos' });
        }
    });

    // =========================================================================
    // GET /api/sync-diagnostics/events/:tenantId/summary
    // Resumen agregado para soporte remoto.
    // Agrupa por entity_type, error_category, device_type.
    // Query params: branchId, hours (default 24)
    // =========================================================================
    router.get('/events/:tenantId/summary', validateTenant, async (req, res) => {
        const { tenantId } = req.params;
        const branchId = req.query.branchId || null;
        const hours = parseInt(req.query.hours) || 24;
        const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        try {
            const params = [tenantId, since];
            let branchFilter = '';
            if (branchId) {
                branchFilter = ' AND se.branch_id = $3';
                params.push(branchId);
            }

            // Failures by entity type
            const byEntity = await pool.query(`
                SELECT entity_type, status, COUNT(*) as count,
                       MAX(created_at) as last_occurrence,
                       array_agg(DISTINCT error_category) FILTER (WHERE error_category IS NOT NULL) as error_categories
                FROM sync_events se
                WHERE tenant_id = $1 AND created_at >= $2 ${branchFilter}
                GROUP BY entity_type, status
                ORDER BY count DESC
            `, params);

            // Failures by error category
            const byCategory = await pool.query(`
                SELECT error_category, COUNT(*) as count,
                       array_agg(DISTINCT entity_type) as affected_entities,
                       MIN(created_at) as first_occurrence,
                       MAX(created_at) as last_occurrence
                FROM sync_events se
                WHERE tenant_id = $1 AND created_at >= $2 AND status = 'failed' ${branchFilter}
                GROUP BY error_category
                ORDER BY count DESC
            `, params);

            // Activity by device
            const byDevice = await pool.query(`
                SELECT device_type, device_name, device_id,
                       COUNT(*) FILTER (WHERE status = 'failed') as failures,
                       COUNT(*) FILTER (WHERE status = 'success') as successes,
                       MAX(created_at) as last_activity
                FROM sync_events se
                WHERE tenant_id = $1 AND created_at >= $2 ${branchFilter}
                GROUP BY device_type, device_name, device_id
                ORDER BY failures DESC
            `, params);

            // Unresolved failures with full detail
            const unresolved = await pool.query(`
                SELECT entity_type, entity_global_id, entity_description,
                       error_category, error_message, error_detail, endpoint,
                       dependency_info, connection_info,
                       retry_count, first_occurred_at, created_at,
                       device_type, device_name, employee_name,
                       shift_global_id, sync_cycle_id
                FROM sync_events se
                WHERE tenant_id = $1 AND created_at >= $2
                  AND status = 'failed' AND resolved_at IS NULL ${branchFilter}
                ORDER BY created_at DESC
                LIMIT 50
            `, params);

            // Dependency chain failures (root cause analysis)
            const depFailures = await pool.query(`
                SELECT entity_type, entity_global_id, entity_description,
                       error_message, dependency_info, created_at,
                       device_name, employee_name
                FROM sync_events se
                WHERE tenant_id = $1 AND created_at >= $2
                  AND status = 'failed' AND dependency_info IS NOT NULL ${branchFilter}
                ORDER BY created_at DESC
                LIMIT 20
            `, params);

            res.json({
                success: true,
                period: { hours, since },
                summary: {
                    byEntityType: byEntity.rows,
                    byErrorCategory: byCategory.rows,
                    byDevice: byDevice.rows,
                    unresolvedFailures: unresolved.rows,
                    dependencyFailures: depFailures.rows
                }
            });
        } catch (error) {
            console.error('[SyncEvents] ❌ Error generating summary:', error.message);
            res.status(500).json({ success: false, message: 'Error generando resumen' });
        }
    });

    // =========================================================================
    // POST /api/sync-diagnostics/census   (Task 8 — Fase 2)
    // Desktop posts a daily census of local record counts + suspicious rows.
    // Persists to sync_census_reports (JSONB). Rate-limited 1/hour per device.
    // =========================================================================
    router.post('/census', authenticateToken, (req, res, next) => {
        // AJV strict validation BEFORE tenant check so malformed bodies 400.
        if (!validateCensus(req.body)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid census payload',
                errors: validateCensus.errors
            });
        }
        next();
    }, ensureSameTenant, censusRateLimit, async (req, res) => {
        const {
            tenantId, branchId, deviceId, deviceName, appVersion, takenAt,
            summary, byEntityType, suspiciousRecords, handlerStats
        } = req.body;

        try {
            const result = await pool.query(
                `INSERT INTO sync_census_reports (
                    tenant_id, branch_id, device_id, device_name, app_version,
                    taken_at, summary, by_entity_type, suspicious_records, handler_stats
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 RETURNING id, received_at`,
                [
                    tenantId, branchId, deviceId,
                    deviceName || null, appVersion || null,
                    takenAt,
                    summary, byEntityType,
                    suspiciousRecords || null,
                    handlerStats || null
                ]
            );
            if (req._censusMarkAccepted) req._censusMarkAccepted();
            return res.status(200).json({
                success: true,
                id: String(result.rows[0].id),
                receivedAt: result.rows[0].received_at
            });
        } catch (err) {
            console.error('[SyncDiagnostics/census] ❌', err.message);
            return res.status(500).json({ success: false, message: 'Error storing census' });
        }
    });

    // =========================================================================
    // POST /api/sync-diagnostics/verify   (Task 8 — Fase 2)
    // Desktop asks: does this (entityType, globalId) exist on PG?
    // Used to detect local broken-FK / quarantine decisions.
    // =========================================================================
    router.post('/verify', authenticateToken, async (req, res) => {
        if (!validateVerify(req.body)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid verify payload',
                errors: validateVerify.errors
            });
        }
        const { entityType, globalId } = req.body;
        const def = ALLOWED_ENTITY_TYPES[entityType];
        if (!def) {
            return res.status(400).json({
                success: false,
                message: `Unsupported entityType: ${entityType}`
            });
        }
        try {
            // Scope to tenant from JWT to prevent cross-tenant probing.
            const tenantId = Number(req.user?.tenantId);
            // Cast the column to text so it works for both TEXT and UUID PG types.
            const sql = `SELECT 1 FROM ${def.table}
                          WHERE tenant_id = $1 AND ${def.col}::text = $2
                          LIMIT 1`;
            const r = await pool.query(sql, [tenantId, String(globalId)]);
            return res.status(200).json({ exists: r.rowCount > 0 });
        } catch (err) {
            console.error('[SyncDiagnostics/verify] ❌', err.message);
            return res.status(500).json({ success: false, message: 'Error verifying entity' });
        }
    });

    return router;
};
