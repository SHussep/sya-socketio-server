/**
 * Sync Diagnostics API
 * Endpoint para obtener conteos de registros por entidad (debug/diagnóstico)
 * Permite comparar registros locales (SQLite) vs PostgreSQL
 */

const express = require('express');
const router = express.Router();
const { createTenantValidationMiddleware } = require('../middleware/deviceAuth');

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

    return router;
};
