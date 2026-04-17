/**
 * Sync Diagnostics API
 * Endpoint para obtener conteos de registros por entidad (debug/diagnóstico)
 * Permite comparar registros locales (SQLite) vs PostgreSQL
 */

const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { createTenantValidationMiddleware } = require('../middleware/deviceAuth');
const { authenticateToken } = require('../middleware/auth');
const superAdminAuth = require('../middleware/superAdminAuth');
const superAdminAuthOrPIN = require('../middleware/superAdminAuthOrPIN');
const Ajv = require('ajv');
const { notifyAdminsOfNewQuarantine } = require('../services/adminFcmNotifier');

// RSA private key for signing short-lived admin command JWTs (Task 18).
// Same private key as /api/auth/super-admin/login — lazy load + cache.
let ADMIN_CMD_PRIVATE_KEY = null;
function loadAdminCommandPrivateKey() {
    if (ADMIN_CMD_PRIVATE_KEY) return ADMIN_CMD_PRIVATE_KEY;
    const p = process.env.SUPER_ADMIN_PRIVATE_KEY_PATH;
    if (!p) throw new Error('SUPER_ADMIN_PRIVATE_KEY_PATH not set');
    ADMIN_CMD_PRIVATE_KEY = fs.readFileSync(p, 'utf8');
    return ADMIN_CMD_PRIVATE_KEY;
}

// Short-lived (<=5 min) admin command JWT — RS256, audience-bound.
// Used to authorize desktop Task 22 listener when receiving admin:release /
// admin:discard_quarantined / admin:force_mark_synced events.
function buildAdminCommandJwt(tenantId, userId, ttlMinutes = 5) {
    const ttl = Math.max(1, Math.min(5, Number(ttlMinutes) || 5));
    return jwt.sign(
        {
            sub: String(userId),
            role: 'super_admin',
            authorizedTenants: [tenantId],
            jti: crypto.randomUUID()
        },
        loadAdminCommandPrivateKey(),
        {
            algorithm: 'RS256',
            expiresIn: `${ttl}m`,
            audience: 'sync-diagnostics-admin'
        }
    );
}

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

// ═══════════════════════════════════════════════════════════════
// Task 17: POST /quarantine — desktop reports a quarantined entity
// ═══════════════════════════════════════════════════════════════

const quarantineSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['tenantId', 'branchId', 'deviceId', 'quarantinedAt', 'entity', 'failure'],
    properties: {
        tenantId: { type: 'integer' },
        branchId: { type: 'integer' },
        deviceId: { type: 'string', minLength: 1, maxLength: 200 },
        deviceName: { type: 'string', maxLength: 200 },
        appVersion: { type: 'string', maxLength: 50 },
        quarantinedAt: { type: 'string', minLength: 1, maxLength: 40 },
        entity: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'globalId', 'payload'],
            properties: {
                type: { type: 'string', minLength: 1, maxLength: 80 },
                globalId: { type: 'string', minLength: 1, maxLength: 80 },
                localId: { type: 'integer' },
                payload: { type: 'object' },
                description: { type: 'string', maxLength: 500 }
            }
        },
        failure: {
            type: 'object',
            additionalProperties: true,
            required: ['category', 'technicalMessage'],
            properties: {
                category: { type: 'string', minLength: 1, maxLength: 60 },
                technicalMessage: { type: 'string' }
            }
        },
        dependencies: { type: 'array' },
        verifyResult: { type: 'object' }
    }
};

// Quarantine rate limiter — 30 per hour per device (mirror /census Map pattern,
// no express-rate-limit dep; uses Map + setInterval cleanup with .unref()).
const QUARANTINE_WINDOW_MS = 60 * 60 * 1000;
const QUARANTINE_MAX_PER_WINDOW = 30;
const quarantineHitsByDevice = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of quarantineHitsByDevice.entries()) {
        if (now - entry.windowStart > QUARANTINE_WINDOW_MS * 2) {
            quarantineHitsByDevice.delete(key);
        }
    }
}, 10 * 60 * 1000).unref?.();

function quarantineRateLimit(req, res, next) {
    const deviceId = req.body?.deviceId;
    if (!deviceId || typeof deviceId !== 'string') return next(); // schema check handles this
    const key = `${req.user?.tenantId || 'x'}:${deviceId}`;
    const now = Date.now();
    const entry = quarantineHitsByDevice.get(key);
    if (!entry || (now - entry.windowStart) > QUARANTINE_WINDOW_MS) {
        quarantineHitsByDevice.set(key, { windowStart: now, count: 1 });
        return next();
    }
    if (entry.count >= QUARANTINE_MAX_PER_WINDOW) {
        return res.status(429).json({
            success: false,
            message: 'Quarantine rate limit exceeded (30/hour/device)',
            retryAfterSeconds: Math.ceil((QUARANTINE_WINDOW_MS - (now - entry.windowStart)) / 1000)
        });
    }
    entry.count += 1;
    next();
}

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
const validateQuarantine = ajv.compile(quarantineSchema);

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

module.exports = (pool, io) => {

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
                    // JSONB columns: must stringify arrays explicitly
                    // (node-pg otherwise encodes JS arrays as Postgres array literals)
                    JSON.stringify(summary),
                    JSON.stringify(byEntityType),
                    suspiciousRecords ? JSON.stringify(suspiciousRecords) : null,
                    handlerStats ? JSON.stringify(handlerStats) : null
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

    // =========================================================================
    // GET /api/sync-diagnostics/admin/overview
    // Super-admin overview: latest census per device across ALL tenants,
    // plus quarantine counts. No tenantId required.
    // =========================================================================
    router.get('/admin/overview', superAdminAuthOrPIN, async (req, res) => {
        try {
            // Latest census per device (one row per device, most recent)
            const censusResult = await pool.query(`
                SELECT DISTINCT ON (device_id)
                    cr.id, cr.tenant_id, cr.branch_id, cr.device_id,
                    cr.device_name, cr.app_version, cr.taken_at, cr.summary,
                    cr.received_at,
                    t.business_name AS tenant_name
                FROM sync_census_reports cr
                LEFT JOIN tenants t ON t.id = cr.tenant_id
                ORDER BY device_id, taken_at DESC
            `);

            // Pending quarantine counts per tenant
            const quarantineResult = await pool.query(`
                SELECT tenant_id, COUNT(*) AS pending_count
                FROM sync_quarantine_reports
                WHERE admin_decision IS NULL
                GROUP BY tenant_id
            `);

            // Recent sync event failures (last 24h) per tenant
            const eventsResult = await pool.query(`
                SELECT tenant_id, COUNT(*) AS failed_count,
                       MAX(created_at) AS last_failure
                FROM sync_events
                WHERE status = 'failed'
                  AND created_at > NOW() - INTERVAL '24 hours'
                GROUP BY tenant_id
            `);

            // Telemetry errors (last 24h) per tenant
            const telemetryResult = await pool.query(`
                SELECT tenant_id, COUNT(*) AS error_count,
                       MAX(event_timestamp) AS last_error
                FROM telemetry_errors
                WHERE event_timestamp > NOW() - INTERVAL '24 hours'
                GROUP BY tenant_id
            `);

            res.json({
                devices: censusResult.rows,
                quarantine: quarantineResult.rows,
                syncFailures: eventsResult.rows,
                telemetryErrors: telemetryResult.rows
            });
        } catch (e) {
            console.error('[admin/overview]', e);
            res.status(500).json({ error: 'query_failed', detail: e.message });
        }
    });

    // =========================================================================
    // GET /api/sync-diagnostics/admin/sync-logs?tenantId=X&status=failed&hours=24
    // Admin endpoint: detailed sync event logs for a tenant.
    // Shows exactly WHICH records failed and WHY.
    // =========================================================================
    router.get('/admin/sync-logs', superAdminAuthOrPIN, async (req, res) => {
        const tenantId = Number(req.query.tenantId);
        if (!Number.isInteger(tenantId) || tenantId <= 0) {
            return res.status(400).json({ error: 'invalid_tenantId' });
        }
        const authorized = req.superAdmin?.authorizedTenants;
        const tenantAllowed = Array.isArray(authorized) &&
            (authorized.includes('*') || authorized.includes(tenantId));
        if (!tenantAllowed) {
            return res.status(403).json({ error: 'tenant_not_authorized' });
        }

        const status = req.query.status || 'failed';
        const hours = Math.min(parseInt(req.query.hours) || 72, 720);
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);

        try {
            const params = [tenantId];
            let sql = `
                SELECT se.entity_type, se.entity_global_id, se.entity_description,
                       se.status, se.error_category, se.error_message, se.error_detail,
                       se.endpoint, se.http_status_code, se.retry_count,
                       se.device_name, se.device_type, se.employee_name,
                       se.dependency_info, se.created_at, se.resolved_at,
                       b.name AS branch_name
                FROM sync_events se
                LEFT JOIN branches b ON se.branch_id = b.id
                WHERE se.tenant_id = $1
            `;
            let idx = 2;

            if (status !== 'all') {
                sql += ` AND se.status = $${idx++}`;
                params.push(status);
            }

            if (hours > 0) {
                sql += ` AND se.created_at > NOW() - INTERVAL '${hours} hours'`;
            }

            sql += ` ORDER BY se.created_at DESC LIMIT $${idx}`;
            params.push(limit);

            const r = await pool.query(sql, params);
            res.json({ rows: r.rows, count: r.rowCount });
        } catch (e) {
            console.error('[admin/sync-logs]', e);
            res.status(500).json({ error: 'query_failed' });
        }
    });

    // =========================================================================
    // GET /api/sync-diagnostics/admin/census   (Task 12 — Fase 2)
    // Super-admin endpoint. Returns recent census reports for a tenant,
    // optionally filtered by deviceId. Protected by superAdminAuthOrPIN (JWT or PIN).
    // =========================================================================
    router.get('/admin/census', superAdminAuthOrPIN, async (req, res) => {
        const tenantId = Number(req.query.tenantId);
        if (!Number.isInteger(tenantId) || tenantId <= 0) {
            return res.status(400).json({ error: 'invalid_tenant_id' });
        }

        // Tenant authorization check (defense-in-depth on top of middleware).
        const authorized = req.superAdmin?.authorizedTenants;
        const tenantAllowed = Array.isArray(authorized) &&
            (authorized.includes('*') || authorized.includes(tenantId));
        if (!tenantAllowed) {
            return res.status(403).json({ error: 'tenant_not_authorized' });
        }

        const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : null;
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

        const params = [tenantId];
        let sql = `SELECT id, tenant_id, branch_id, device_id, device_name, app_version,
                          taken_at, summary, by_entity_type, suspicious_records, handler_stats, received_at
                   FROM sync_census_reports WHERE tenant_id = $1`;
        if (deviceId) {
            params.push(deviceId);
            sql += ` AND device_id = $${params.length}`;
        }
        sql += ` ORDER BY taken_at DESC LIMIT ${limit}`;

        try {
            const r = await pool.query(sql, params);
            res.json({ rows: r.rows, count: r.rowCount, limit });
        } catch (e) {
            console.error('[admin/census]', e);
            res.status(500).json({ error: 'query_failed' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // Task 17: POST /quarantine — ingest quarantine report from desktop
    // Upserts on (tenant_id, device_id, entity_type, entity_global_id)
    // WHERE admin_decision IS NULL (idempotent while undecided).
    // ═══════════════════════════════════════════════════════════════
    router.post('/quarantine',
        express.json({ limit: '5mb' }),
        authenticateToken,
        ensureSameTenant,
        quarantineRateLimit,
        async (req, res) => {
            if (!validateQuarantine(req.body)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid quarantine payload',
                    errors: validateQuarantine.errors
                });
            }
            const b = req.body;
            try {
                await pool.query(
                    `INSERT INTO sync_quarantine_reports
                        (tenant_id, branch_id, device_id, device_name, app_version, quarantined_at,
                         entity_type, entity_global_id, entity_local_id, entity_payload, entity_description,
                         failure, dependencies, verify_result)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                     ON CONFLICT (tenant_id, device_id, entity_type, entity_global_id)
                       WHERE admin_decision IS NULL
                     DO UPDATE SET
                        failure = EXCLUDED.failure,
                        dependencies = EXCLUDED.dependencies,
                        verify_result = EXCLUDED.verify_result,
                        quarantined_at = EXCLUDED.quarantined_at,
                        entity_payload = EXCLUDED.entity_payload,
                        entity_description = EXCLUDED.entity_description,
                        device_name = EXCLUDED.device_name,
                        app_version = EXCLUDED.app_version,
                        received_at = NOW()`,
                    [
                        b.tenantId, b.branchId, b.deviceId,
                        b.deviceName || null, b.appVersion || null,
                        b.quarantinedAt,
                        b.entity.type, b.entity.globalId, b.entity.localId || null,
                        // JSONB columns: stringify explicitly. node-pg otherwise encodes
                        // JS arrays as Postgres ARRAY literals (breaks JSONB insert).
                        JSON.stringify(b.entity.payload),
                        b.entity.description || null,
                        JSON.stringify(b.failure),
                        JSON.stringify(b.dependencies || []),
                        JSON.stringify(b.verifyResult || {})
                    ]
                );
                console.log(`[SyncDiagnostics/quarantine] ✅ tenant=${b.tenantId} device=${b.deviceId} ${b.entity.type}/${b.entity.globalId}`);
                // Task 30: FCM push a admins/owners del tenant (fire-and-forget, no bloquea response)
                notifyAdminsOfNewQuarantine(b).catch(e =>
                    console.error('[SyncDiagnostics/quarantine] FCM notify error:', e.message)
                );
                return res.status(200).json({ success: true });
            } catch (e) {
                console.error('[SyncDiagnostics/quarantine] ❌', e.message);
                return res.status(500).json({ success: false, message: 'insert_failed' });
            }
        }
    );

    // ═══════════════════════════════════════════════════════════════
    // Task 18: Admin endpoints to list and decide quarantine reports
    //   GET  /admin/quarantine?tenantId&status=pending|resolved|all
    //   POST /admin/quarantine/:id/decide  { action, notes }
    // Both require super-admin auth (JWT RS256 or PIN) via superAdminAuthOrPIN.
    // ═══════════════════════════════════════════════════════════════

    router.get('/admin/quarantine', superAdminAuthOrPIN, async (req, res) => {
        const tenantId = Number(req.query.tenantId);
        if (!Number.isInteger(tenantId) || tenantId <= 0) {
            return res.status(400).json({ error: 'invalid_tenantId' });
        }
        const authorized = req.superAdmin?.authorizedTenants;
        const tenantAllowed = Array.isArray(authorized) &&
            (authorized.includes('*') || authorized.includes(tenantId));
        if (!tenantAllowed) {
            return res.status(403).json({ error: 'tenant_not_authorized' });
        }

        const status = String(req.query.status || 'pending').toLowerCase();
        const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : null;
        const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);

        const params = [tenantId];
        let sql = `SELECT id, tenant_id, branch_id, device_id, device_name, app_version,
                          quarantined_at, entity_type, entity_global_id, entity_local_id,
                          entity_payload, entity_description, failure, dependencies, verify_result,
                          admin_decision, admin_decided_at, admin_decided_by, admin_notes, received_at
                   FROM sync_quarantine_reports WHERE tenant_id = $1`;
        if (status === 'pending') sql += ` AND admin_decision IS NULL`;
        else if (status === 'resolved') sql += ` AND admin_decision IS NOT NULL`;
        // status === 'all' → no extra filter
        if (deviceId) {
            params.push(deviceId);
            sql += ` AND device_id = $${params.length}`;
        }
        sql += ` ORDER BY quarantined_at DESC LIMIT ${limit}`;

        try {
            const r = await pool.query(sql, params);
            res.json({ rows: r.rows, count: r.rowCount, limit });
        } catch (e) {
            console.error('[admin/quarantine]', e);
            res.status(500).json({ error: 'query_failed' });
        }
    });

    router.post('/admin/quarantine/:id/decide',
        superAdminAuthOrPIN,
        express.json({ limit: '100kb' }),
        async (req, res) => {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).json({ error: 'invalid_id' });
            }
            const { action, notes } = req.body || {};
            if (!['release', 'discard', 'force_synced'].includes(action)) {
                return res.status(400).json({ error: 'invalid_action' });
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const sel = await client.query(
                    'SELECT * FROM sync_quarantine_reports WHERE id = $1 FOR UPDATE',
                    [id]
                );
                const row = sel.rows[0];
                if (!row) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ error: 'not_found' });
                }
                const authorized = req.superAdmin?.authorizedTenants;
                const tenantAllowed = Array.isArray(authorized) &&
                    (authorized.includes('*') || authorized.includes(row.tenant_id));
                if (!tenantAllowed) {
                    await client.query('ROLLBACK');
                    return res.status(403).json({ error: 'tenant_not_authorized' });
                }
                if (row.admin_decision !== null) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({ error: 'already_decided', currentDecision: row.admin_decision });
                }

                await client.query(
                    `UPDATE sync_quarantine_reports
                     SET admin_decision = $1,
                         admin_decided_at = NOW(),
                         admin_decided_by = $2,
                         admin_notes = $3
                     WHERE id = $4`,
                    [action, req.superAdmin.userId, notes || null, id]
                );

                const commandId = crypto.randomUUID();
                const eventName = action === 'release' ? 'admin:release_from_quarantine'
                                : action === 'discard' ? 'admin:discard_quarantined'
                                : 'admin:force_mark_synced';
                const payloadForLog = {
                    entityType: row.entity_type,
                    globalId: row.entity_global_id,
                    localId: row.entity_local_id,
                    notes: notes || null
                };

                await client.query(
                    `INSERT INTO sync_admin_command_log
                        (command_id, tenant_id, device_id, admin_user_id, command_type, payload, status)
                     VALUES ($1,$2,$3,$4,$5,$6,'issued')`,
                    [
                        commandId, row.tenant_id, row.device_id, req.superAdmin.userId,
                        eventName,
                        // JSONB: stringify to avoid node-pg array-literal bug
                        JSON.stringify(payloadForLog)
                    ]
                );

                await client.query('COMMIT');

                // Emit Socket.IO only to the target desktop (best effort).
                // If no desktop connected right now → mark command as 'queued';
                // Task 24 will re-emit on reconnect.
                let delivered = 0;
                try {
                    if (io && typeof io.in === 'function') {
                        const sockets = await io.in(`branch_${row.branch_id}`).fetchSockets();
                        const adminJwt = buildAdminCommandJwt(row.tenant_id, req.superAdmin.userId, 5);
                        const emitPayload = {
                            adminJwt,
                            commandId,
                            entityType: row.entity_type,
                            globalId: row.entity_global_id,
                            localId: row.entity_local_id,
                            notes: notes || null
                        };
                        for (const s of sockets) {
                            const clientType = s.clientType || s.data?.clientType;
                            if (clientType !== 'desktop') continue;
                            const deviceIdOnSocket =
                                s.deviceInfo?.deviceId ||
                                s.data?.deviceId ||
                                s.handshake?.auth?.deviceId;
                            if (!deviceIdOnSocket || deviceIdOnSocket === row.device_id) {
                                s.emit(eventName, emitPayload);
                                delivered += 1;
                            }
                        }
                    }
                } catch (emitErr) {
                    console.error('[admin/decide] socket emit failed:', emitErr.message);
                }

                if (delivered === 0) {
                    await pool.query(
                        `UPDATE sync_admin_command_log SET status = 'queued' WHERE command_id = $1`,
                        [commandId]
                    );
                }

                return res.json({ ok: true, commandId, delivered, eventName });
            } catch (e) {
                try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
                console.error('[admin/decide]', e);
                return res.status(500).json({ error: 'decide_failed' });
            } finally {
                client.release();
            }
        }
    );

    // ═══════════════════════════════════════════════════════════════
    // Task 25 — Full backup on-demand (Fase 5)
    //
    // Flow:
    //   1. Super-admin POST /admin/request-backup → issues uploadToken
    //      (HS256, 15 min, scope='backup_upload'), crea fila pending,
    //      emite/encola admin:request_full_backup al desktop.
    //   2. Desktop ejecuta backup encriptado (Task 26) y POST /backup-upload
    //      con el uploadToken → storage adapter persiste blob → status='uploaded'.
    //   3. Super-admin GET /admin/backup/:reqId → signed URL (15 min).
    //   4. Driver 'fs' expone GET /backup-download que valida JWT HS256 y
    //      sirve el blob encriptado.
    // ═══════════════════════════════════════════════════════════════
    const backupStorage = require('../services/backupStorage');

    router.post('/admin/request-backup',
        superAdminAuthOrPIN,
        express.json({ limit: '10kb' }),
        async (req, res) => {
            try {
                const { tenantId, deviceId, branchId: providedBranchId } = req.body || {};
                if (!tenantId || !deviceId) {
                    return res.status(400).json({ error: 'missing_fields' });
                }
                const tenantIdNum = Number(tenantId);
                const authorized = req.superAdmin?.authorizedTenants || [];
                const tenantAllowed = Array.isArray(authorized) &&
                    (authorized.includes('*') || authorized.includes(tenantIdNum));
                if (!tenantAllowed) {
                    return res.status(403).json({ error: 'tenant_not_authorized' });
                }

                // Resolver branchId: body > último census reportado por este device
                let branchId = Number(providedBranchId);
                if (!branchId) {
                    const bq = await pool.query(
                        `SELECT branch_id FROM sync_census_reports
                          WHERE tenant_id = $1 AND device_id = $2
                          ORDER BY received_at DESC LIMIT 1`,
                        [tenantIdNum, deviceId]
                    );
                    if (bq.rowCount === 0) {
                        return res.status(400).json({
                            error: 'branch_unknown_no_census',
                            hint: 'pass branchId explicitly'
                        });
                    }
                    branchId = bq.rows[0].branch_id;
                }

                if (!process.env.BACKUP_UPLOAD_SECRET) {
                    return res.status(500).json({ error: 'backup_upload_secret_not_configured' });
                }

                const reqId = crypto.randomUUID();
                const uploadToken = jwt.sign(
                    { reqId, deviceId, scope: 'backup_upload' },
                    process.env.BACKUP_UPLOAD_SECRET,
                    { expiresIn: '15m', algorithm: 'HS256' }
                );
                const tokenHash = crypto.createHash('sha256').update(uploadToken).digest('hex');
                // Fila `pending` vive hasta 48h; pasado ese TTL el cron de Task 29
                // la mueve a 'expired'. El uploadToken JWT expira en 15min.
                const expiresAt = new Date(Date.now() + 48 * 3600 * 1000);

                await pool.query(
                    `INSERT INTO sync_backup_requests
                        (id, tenant_id, branch_id, device_id, requested_by,
                         upload_token_hash, status, expires_at)
                     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)`,
                    [reqId, tenantIdNum, branchId, deviceId,
                     req.superAdmin.userId, tokenHash, expiresAt]
                );

                // Emit o encolar admin:request_full_backup al desktop target.
                const { buildAdminCommandJwt } = require('../utils/adminCommandJwt');
                const commandId = crypto.randomUUID();
                const payloadForLog = {
                    reqId,
                    uploadToken,
                    expiresAt: expiresAt.toISOString()
                };
                let delivered = 0;

                try {
                    if (io && typeof io.in === 'function') {
                        const sockets = await io.in(`branch_${branchId}`).fetchSockets();
                        const adminJwt = buildAdminCommandJwt(tenantIdNum, req.superAdmin.userId, 5);
                        const emitPayload = {
                            adminJwt,
                            commandId,
                            reqId,
                            uploadToken,
                            expiresAt: expiresAt.toISOString()
                        };
                        for (const s of sockets) {
                            const clientType = s.clientType || s.data?.clientType;
                            if (clientType !== 'desktop') continue;
                            const deviceIdOnSocket =
                                s.deviceInfo?.deviceId ||
                                s.data?.deviceId ||
                                s.handshake?.auth?.deviceId;
                            if (!deviceIdOnSocket || deviceIdOnSocket === deviceId) {
                                s.emit('admin:request_full_backup', emitPayload);
                                delivered += 1;
                            }
                        }
                    }
                } catch (emitErr) {
                    console.error('[admin/request-backup] socket emit failed:', emitErr.message);
                }

                const logStatus = delivered > 0 ? 'issued' : 'queued';
                await pool.query(
                    `INSERT INTO sync_admin_command_log
                        (command_id, tenant_id, device_id, admin_user_id,
                         command_type, payload, status)
                     VALUES ($1,$2,$3,$4,'admin:request_full_backup',$5,$6)`,
                    [commandId, tenantIdNum, deviceId, req.superAdmin.userId,
                     JSON.stringify(payloadForLog), logStatus]
                );

                return res.json({
                    reqId,
                    commandId,
                    delivered,
                    expiresAt: expiresAt.toISOString()
                });
            } catch (e) {
                console.error('[admin/request-backup]', e);
                return res.status(500).json({ error: 'request_backup_failed' });
            }
        }
    );

    // Upload del blob encriptado. El desktop autentica con uploadToken
    // (Bearer HS256) — NO super-admin JWT. One-shot: status 'pending' → 'uploaded'.
    router.post('/backup-upload',
        express.raw({ limit: '500mb', type: '*/*' }),
        async (req, res) => {
            const header = req.headers.authorization || '';
            const token = header.startsWith('Bearer ') ? header.slice(7) : null;
            if (!token) return res.status(401).json({ error: 'missing_token' });
            if (!process.env.BACKUP_UPLOAD_SECRET) {
                return res.status(500).json({ error: 'backup_upload_secret_not_configured' });
            }

            let decoded;
            try {
                decoded = jwt.verify(token, process.env.BACKUP_UPLOAD_SECRET, {
                    algorithms: ['HS256']
                });
            } catch (e) {
                return res.status(401).json({ error: 'invalid_token' });
            }
            if (decoded.scope !== 'backup_upload') {
                return res.status(401).json({ error: 'bad_scope' });
            }

            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const r = await client.query(
                    `SELECT * FROM sync_backup_requests
                      WHERE id = $1 AND upload_token_hash = $2 FOR UPDATE`,
                    [decoded.reqId, tokenHash]
                );
                if (r.rowCount === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ error: 'not_found' });
                }
                const row = r.rows[0];
                if (row.status !== 'pending') {
                    await client.query('ROLLBACK');
                    return res.status(409).json({ error: 'token_consumed_or_stale' });
                }
                if (new Date(row.expires_at) < new Date()) {
                    await client.query('ROLLBACK');
                    return res.status(410).json({ error: 'expired' });
                }

                const key = `backups/${row.tenant_id}/${row.device_id}/${decoded.reqId}.enc`;
                const { sizeBytes } = await backupStorage.putObjectEncrypted(key, req.body);

                await client.query(
                    `UPDATE sync_backup_requests
                        SET status='uploaded', uploaded_at=NOW(),
                            storage_key=$1, size_bytes=$2
                      WHERE id=$3`,
                    [key, sizeBytes, decoded.reqId]
                );
                await client.query('COMMIT');
                return res.json({ ok: true, sizeBytes });
            } catch (e) {
                try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
                console.error('[backup-upload]', e);
                return res.status(500).json({ error: 'upload_failed' });
            } finally {
                client.release();
            }
        }
    );

    // Super-admin retrieves signed URL for an uploaded backup.
    router.get('/admin/backup/:reqId', superAdminAuthOrPIN, async (req, res) => {
        try {
            const r = await pool.query(
                `SELECT * FROM sync_backup_requests WHERE id = $1`,
                [req.params.reqId]
            );
            if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
            const row = r.rows[0];
            const authorized = req.superAdmin?.authorizedTenants || [];
            const tenantAllowed = Array.isArray(authorized) &&
                (authorized.includes('*') || authorized.includes(row.tenant_id));
            if (!tenantAllowed) {
                return res.status(403).json({ error: 'tenant_not_authorized' });
            }
            if (row.status !== 'uploaded') {
                return res.status(409).json({ error: 'not_uploaded', status: row.status });
            }
            const url = await backupStorage.getSignedUrl(row.storage_key, 15 * 60);
            return res.json({
                url,
                sizeBytes: row.size_bytes,
                storageKey: row.storage_key,
                uploadedAt: row.uploaded_at
            });
        } catch (e) {
            console.error('[admin/backup/:reqId]', e);
            return res.status(500).json({ error: 'signed_url_failed' });
        }
    });

    // FS-driver only: serves the encrypted blob to super-admin after validating
    // the short-lived HS256 download token issued by backupStorage.getSignedUrl.
    // S3-driver would return a presigned S3 URL directly, making this endpoint
    // irrelevant — se mantiene registrado pero responde 404 cuando no aplica.
    router.get('/backup-download', async (req, res) => {
        try {
            if (backupStorage.driver !== 'fs') {
                return res.status(404).json({ error: 'not_applicable_for_driver' });
            }
            const token = req.query?.token;
            if (!token || typeof token !== 'string') {
                return res.status(401).json({ error: 'missing_token' });
            }
            if (!process.env.BACKUP_DOWNLOAD_SECRET) {
                return res.status(500).json({ error: 'backup_download_secret_not_configured' });
            }
            let decoded;
            try {
                decoded = jwt.verify(token, process.env.BACKUP_DOWNLOAD_SECRET, {
                    algorithms: ['HS256']
                });
            } catch (e) {
                return res.status(401).json({ error: 'invalid_token' });
            }
            if (decoded.scope !== 'backup_download' || !decoded.key) {
                return res.status(401).json({ error: 'bad_scope' });
            }
            const full = backupStorage._resolveKeyForDownload(decoded.key);
            if (!fs.existsSync(full)) {
                return res.status(404).json({ error: 'not_found' });
            }
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition',
                `attachment; filename="${decoded.key.split('/').pop()}"`);
            fs.createReadStream(full).pipe(res);
        } catch (e) {
            console.error('[backup-download]', e);
            if (!res.headersSent) res.status(500).json({ error: 'download_failed' });
        }
    });

    return router;
};
