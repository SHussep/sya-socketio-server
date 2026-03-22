// ═══════════════════════════════════════════════════════════════
// PREPARATION MODE LOGS API - Sincronización y Consultas
// ═══════════════════════════════════════════════════════════════
// Maneja la sincronización de logs del Modo Preparación desde Desktop/WinUI
// y consultas desde la App Móvil para auditoría de uso.
//
// El Modo Preparación permite pesar productos sin que Guardian genere alertas.
// Este endpoint permite rastrear cuándo se activa/desactiva para auditoría.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
// Las notificaciones FCM se envían directamente vía Socket.IO desde el desktop.
// El sync endpoint solo persiste datos en PostgreSQL.

module.exports = function(pool, io) {

    // ═══════════════════════════════════════════════════════════════════════════
    // POST /api/preparation-mode/sync - Sincronizar logs desde Desktop
    // ═══════════════════════════════════════════════════════════════════════════
    router.post('/sync', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const { logs = [] } = req.body;

            if (!Array.isArray(logs)) {
                return res.status(400).json({
                    success: false,
                    message: 'logs debe ser un array'
                });
            }

            console.log(`[PrepMode/Sync] 📥 Recibiendo ${logs.length} logs de Modo Preparación`);

            await client.query('BEGIN');

            const results = { inserted: 0, updated: 0, errors: [] };

            for (const log of logs) {
                try {
                    // Resolver shift por global_id
                    let shift_id = null;
                    if (log.shift_global_id) {
                        const shiftResult = await client.query(
                            'SELECT id FROM shifts WHERE global_id = $1',
                            [log.shift_global_id]
                        );
                        if (shiftResult.rows.length > 0) {
                            shift_id = shiftResult.rows[0].id;
                        }
                    }

                    // Resolver operator employee por global_id
                    const operatorResult = await client.query(
                        'SELECT id, first_name, last_name FROM employees WHERE global_id = $1',
                        [log.operator_employee_global_id]
                    );
                    if (operatorResult.rows.length === 0) {
                        results.errors.push({
                            global_id: log.global_id,
                            error: `Operator employee no encontrado: ${log.operator_employee_global_id}`
                        });
                        continue;
                    }
                    const operator_employee_id = operatorResult.rows[0].id;
                    const operator_name = `${operatorResult.rows[0].first_name} ${operatorResult.rows[0].last_name}`.trim();

                    // Resolver authorized_by employee por global_id (opcional)
                    let authorized_by_employee_id = null;
                    let authorizer_name = null;
                    if (log.authorized_by_global_id) {
                        const authResult = await client.query(
                            'SELECT id, first_name, last_name FROM employees WHERE global_id = $1',
                            [log.authorized_by_global_id]
                        );
                        if (authResult.rows.length > 0) {
                            authorized_by_employee_id = authResult.rows[0].id;
                            authorizer_name = `${authResult.rows[0].first_name} ${authResult.rows[0].last_name}`.trim();
                        }
                    }

                    // Calcular status
                    let status = log.status || 'active';
                    if (log.deactivated_at && !log.status) {
                        status = 'completed';
                    }

                    // Upsert log
                    const upsertResult = await client.query(`
                        INSERT INTO preparation_mode_logs (
                            tenant_id, branch_id, shift_id,
                            operator_employee_id, authorized_by_employee_id,
                            activated_at, deactivated_at, duration_seconds,
                            reason, notes,
                            was_reviewed, review_notes, reviewed_at, reviewed_by_employee_id,
                            status,
                            weighing_cycle_count, total_weight_kg, cycle_weights_json,
                            fuera_de_ventana, razon_activacion, razon_cierre,
                            requirio_justificacion_activacion, requirio_justificacion_cierre, notificacion_enviada,
                            global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
                        ) VALUES (
                            $1, $2, $3,
                            $4, $5,
                            $6, $7, $8,
                            $9, $10,
                            $11, $12, $13, $14,
                            $15,
                            $16, $17, $18,
                            $19, $20, $21,
                            $22, $23, $24,
                            $25, $26, $27, $28, $29
                        )
                        ON CONFLICT (global_id) DO UPDATE SET
                            deactivated_at = EXCLUDED.deactivated_at,
                            duration_seconds = EXCLUDED.duration_seconds,
                            status = EXCLUDED.status,
                            was_reviewed = EXCLUDED.was_reviewed,
                            review_notes = EXCLUDED.review_notes,
                            reviewed_at = EXCLUDED.reviewed_at,
                            reviewed_by_employee_id = EXCLUDED.reviewed_by_employee_id,
                            notes = EXCLUDED.notes,
                            weighing_cycle_count = EXCLUDED.weighing_cycle_count,
                            total_weight_kg = EXCLUDED.total_weight_kg,
                            cycle_weights_json = EXCLUDED.cycle_weights_json,
                            razon_cierre = EXCLUDED.razon_cierre,
                            requirio_justificacion_cierre = EXCLUDED.requirio_justificacion_cierre,
                            notificacion_enviada = EXCLUDED.notificacion_enviada,
                            updated_at = CURRENT_TIMESTAMP
                        RETURNING id, (xmax = 0) AS inserted, severity
                    `, [
                        log.tenant_id,
                        log.branch_id,
                        shift_id,
                        operator_employee_id,
                        authorized_by_employee_id,
                        log.activated_at || new Date().toISOString(),
                        log.deactivated_at,
                        log.duration_seconds ? parseFloat(log.duration_seconds) : null,
                        log.reason,
                        log.notes,
                        log.was_reviewed || false,
                        log.review_notes,
                        log.reviewed_at,
                        null, // reviewed_by_employee_id - resolver si viene
                        status,
                        log.weighing_cycle_count || 0,
                        log.total_weight_kg ? parseFloat(log.total_weight_kg) : 0,
                        log.cycle_weights_json || null,
                        log.fuera_de_ventana || false,
                        log.razon_activacion || null,
                        log.razon_cierre || null,
                        log.requirio_justificacion_activacion || false,
                        log.requirio_justificacion_cierre || false,
                        log.notificacion_enviada || false,
                        log.global_id,
                        log.terminal_id,
                        log.local_op_seq || 0,
                        log.device_event_raw || 0,
                        log.created_local_utc
                    ]);

                    if (upsertResult.rows[0].inserted) {
                        results.inserted++;
                    } else {
                        results.updated++;
                    }
                    // No enviar FCM desde sync — las notificaciones en tiempo real
                    // se envían vía Socket.IO directo desde el desktop.
                    // El sync solo persiste datos en PostgreSQL para consulta.

                } catch (logError) {
                    console.error(`[PrepMode/Sync] ❌ Error en log ${log.global_id}:`, logError.message);
                    results.errors.push({ global_id: log.global_id, error: logError.message });
                }
            }

            await client.query('COMMIT');

            console.log(`[PrepMode/Sync] ✅ Completado: ${results.inserted} insertados, ${results.updated} actualizados, ${results.errors.length} errores`);

            res.json({
                success: true,
                message: 'Sincronización de logs de Modo Preparación completada',
                results
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[PrepMode/Sync] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar logs de Modo Preparación',
                error: undefined
            });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/preparation-mode - Listar logs con filtros (para App Móvil)
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/', async (req, res) => {
        try {
            // Aceptar ambos formatos: camelCase y snake_case
            const tenantId = req.query.tenantId || req.query.tenant_id;
            const branchId = req.query.branchId || req.query.branch_id;
            const employeeId = req.query.employeeId || req.query.operator_employee_id;
            const status = req.query.status;
            const severity = req.query.severity;
            const wasReviewed = req.query.wasReviewed || req.query.was_reviewed;
            const startDate = req.query.fecha_desde || req.query.start_date;
            const endDate = req.query.fecha_hasta || req.query.end_date;
            const limit = req.query.limit || 50;
            const offset = req.query.offset || 0;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId o tenant_id es requerido'
                });
            }

            let query = `
                SELECT
                    pm.id, pm.global_id, pm.status, pm.severity,
                    pm.activated_at, pm.deactivated_at, pm.duration_seconds,
                    pm.reason, pm.notes,
                    pm.weighing_cycle_count, pm.total_weight_kg, pm.cycle_weights_json,
                    pm.was_reviewed, pm.review_notes, pm.reviewed_at,
                    CONCAT(op.first_name, ' ', op.last_name) as operator_name,
                    CONCAT(auth.first_name, ' ', auth.last_name) as authorizer_name,
                    CONCAT(rev.first_name, ' ', rev.last_name) as reviewer_name,
                    s.global_id as shift_global_id
                FROM preparation_mode_logs pm
                LEFT JOIN employees op ON pm.operator_employee_id = op.id
                LEFT JOIN employees auth ON pm.authorized_by_employee_id = auth.id
                LEFT JOIN employees rev ON pm.reviewed_by_employee_id = rev.id
                LEFT JOIN shifts s ON pm.shift_id = s.id
                WHERE pm.tenant_id = $1
            `;

            const params = [parseInt(tenantId)];
            let paramIndex = 2;

            // branchId es opcional para consultas a nivel tenant
            if (branchId) {
                query += ` AND pm.branch_id = $${paramIndex}`;
                params.push(parseInt(branchId));
                paramIndex++;
            }

            if (employeeId) {
                query += ` AND pm.operator_employee_id = $${paramIndex}`;
                params.push(parseInt(employeeId));
                paramIndex++;
            }

            if (status) {
                query += ` AND pm.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            if (severity) {
                query += ` AND pm.severity = $${paramIndex}`;
                params.push(severity);
                paramIndex++;
            }

            if (wasReviewed !== undefined) {
                query += ` AND pm.was_reviewed = $${paramIndex}`;
                params.push(wasReviewed === 'true');
                paramIndex++;
            }

            if (startDate) {
                query += ` AND pm.activated_at >= $${paramIndex}`;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                query += ` AND pm.activated_at <= $${paramIndex}`;
                params.push(endDate);
                paramIndex++;
            }

            // Primero contar el total sin paginación
            let countQuery = `
                SELECT COUNT(*) as total
                FROM preparation_mode_logs pm
                WHERE pm.tenant_id = $1
            `;
            const countParams = [parseInt(tenantId)];
            let countParamIndex = 2;

            if (branchId) {
                countQuery += ` AND pm.branch_id = $${countParamIndex}`;
                countParams.push(parseInt(branchId));
                countParamIndex++;
            }
            if (status) {
                countQuery += ` AND pm.status = $${countParamIndex}`;
                countParams.push(status);
                countParamIndex++;
            }
            if (startDate) {
                countQuery += ` AND pm.activated_at >= $${countParamIndex}`;
                countParams.push(startDate);
                countParamIndex++;
            }
            if (endDate) {
                countQuery += ` AND pm.activated_at <= $${countParamIndex}`;
                countParams.push(endDate);
                countParamIndex++;
            }

            const countResult = await pool.query(countQuery, countParams);
            const total = parseInt(countResult.rows[0].total);

            query += ` ORDER BY pm.activated_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await pool.query(query, params);

            const hasMore = (parseInt(offset) + result.rows.length) < total;

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length,
                pagination: {
                    total: total,
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    hasMore: hasMore
                }
            });

        } catch (error) {
            console.error('[PrepMode/List] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener logs de Modo Preparación',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/preparation-mode/summary - Resumen de uso (para Dashboard)
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/summary', async (req, res) => {
        try {
            // Aceptar ambos formatos: camelCase y snake_case
            const tenantId = req.query.tenantId || req.query.tenant_id;
            const branchId = req.query.branchId || req.query.branch_id;
            const startDate = req.query.fecha_desde || req.query.start_date;
            const endDate = req.query.fecha_hasta || req.query.end_date;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId o tenant_id es requerido'
                });
            }

            let branchFilter = '';
            let dateFilter = '';
            const params = [parseInt(tenantId)];
            let paramIndex = 2;

            // branchId es opcional
            if (branchId) {
                branchFilter = ` AND pm.branch_id = $${paramIndex}`;
                params.push(parseInt(branchId));
                paramIndex++;
            }

            if (startDate) {
                dateFilter += ` AND pm.activated_at >= $${paramIndex}`;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                dateFilter += ` AND pm.activated_at <= $${paramIndex}`;
                params.push(endDate);
                paramIndex++;
            }

            // Resumen general
            const summaryResult = await pool.query(`
                SELECT
                    COUNT(*) as total_activations,
                    COUNT(*) FILTER (WHERE pm.status = 'active') as active_sessions,
                    COUNT(*) FILTER (WHERE pm.status = 'completed') as completed_sessions,
                    COALESCE(SUM(pm.duration_seconds), 0) as total_duration_seconds,
                    COALESCE(AVG(pm.duration_seconds), 0) as avg_duration_seconds,
                    COALESCE(MAX(pm.duration_seconds), 0) as max_duration_seconds,
                    COUNT(*) FILTER (WHERE pm.severity = 'Critical') as critical_count,
                    COUNT(*) FILTER (WHERE pm.severity = 'High') as high_count,
                    COUNT(*) FILTER (WHERE pm.severity = 'Medium') as medium_count,
                    COUNT(*) FILTER (WHERE pm.severity = 'Low') as low_count,
                    COUNT(*) FILTER (WHERE pm.was_reviewed = false AND pm.status = 'completed') as pending_review
                FROM preparation_mode_logs pm
                WHERE pm.tenant_id = $1
                ${branchFilter}
                ${dateFilter}
            `, params);

            // Top operadores por uso
            const operatorsResult = await pool.query(`
                SELECT
                    pm.operator_employee_id,
                    CONCAT(e.first_name, ' ', e.last_name) as operator_name,
                    COUNT(*) as activations_count,
                    COALESCE(SUM(pm.duration_seconds), 0) as total_duration_seconds,
                    COUNT(*) FILTER (WHERE pm.severity IN ('Critical', 'High')) as high_severity_count
                FROM preparation_mode_logs pm
                JOIN employees e ON pm.operator_employee_id = e.id
                WHERE pm.tenant_id = $1
                ${branchFilter}
                ${dateFilter}
                GROUP BY pm.operator_employee_id, e.first_name, e.last_name
                ORDER BY activations_count DESC
                LIMIT 10
            `, params);

            // Activaciones por día (últimos 7 días) - usar solo los primeros params (sin fechas)
            const dailyParams = branchId ? [parseInt(tenantId), parseInt(branchId)] : [parseInt(tenantId)];
            const dailyBranchFilter = branchId ? 'AND pm.branch_id = $2' : '';
            const dailyResult = await pool.query(`
                SELECT
                    DATE(pm.activated_at AT TIME ZONE 'UTC') as date,
                    COUNT(*) as activations_count,
                    COALESCE(SUM(pm.duration_seconds), 0) as total_duration_seconds
                FROM preparation_mode_logs pm
                WHERE pm.tenant_id = $1
                    ${dailyBranchFilter}
                    AND pm.activated_at >= NOW() - INTERVAL '7 days'
                GROUP BY DATE(pm.activated_at AT TIME ZONE 'UTC')
                ORDER BY date DESC
            `, dailyParams);

            res.json({
                success: true,
                data: {
                    summary: summaryResult.rows[0],
                    top_operators: operatorsResult.rows,
                    daily_stats: dailyResult.rows
                }
            });

        } catch (error) {
            console.error('[PrepMode/Summary] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener resumen de Modo Preparación',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/preparation-mode/analytics - Hourly distribution + weight stats
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/analytics', async (req, res) => {
        try {
            const tenantId = req.query.tenantId || req.query.tenant_id;
            const branchId = req.query.branchId || req.query.branch_id;
            const startDate = req.query.start_date;
            const endDate = req.query.end_date;

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'tenantId es requerido' });
            }

            let branchFilter = '';
            let dateFilter = '';
            const params = [parseInt(tenantId)];
            let paramIndex = 2;

            if (branchId) {
                branchFilter = ` AND pm.branch_id = $${paramIndex}`;
                params.push(parseInt(branchId));
                paramIndex++;
            }
            if (startDate) {
                dateFilter += ` AND pm.activated_at >= $${paramIndex}`;
                params.push(startDate);
                paramIndex++;
            }
            if (endDate) {
                dateFilter += ` AND pm.activated_at <= $${paramIndex}`;
                params.push(endDate);
                paramIndex++;
            }

            // Activations by hour of day (0-23)
            const hourlyResult = await pool.query(`
                SELECT
                    EXTRACT(HOUR FROM pm.activated_at AT TIME ZONE 'America/Mexico_City') AS hour,
                    COUNT(*) AS activations,
                    COALESCE(SUM(pm.total_weight_kg), 0) AS total_weight_kg,
                    COALESCE(AVG(NULLIF(pm.total_weight_kg, 0)), 0) AS avg_weight_kg,
                    COALESCE(AVG(pm.duration_seconds), 0) AS avg_duration_seconds
                FROM preparation_mode_logs pm
                WHERE pm.tenant_id = $1 ${branchFilter} ${dateFilter}
                GROUP BY EXTRACT(HOUR FROM pm.activated_at AT TIME ZONE 'America/Mexico_City')
                ORDER BY hour
            `, params);

            // Top operators with weight stats
            const operatorWeightResult = await pool.query(`
                SELECT
                    pm.operator_employee_id,
                    CONCAT(e.first_name, ' ', e.last_name) AS operator_name,
                    COUNT(*) AS activations,
                    COALESCE(SUM(pm.total_weight_kg), 0) AS total_weight_kg,
                    COALESCE(AVG(NULLIF(pm.total_weight_kg, 0)), 0) AS avg_weight_kg,
                    COALESCE(SUM(pm.weighing_cycle_count), 0) AS total_cycles,
                    COALESCE(AVG(pm.duration_seconds), 0) AS avg_duration_seconds
                FROM preparation_mode_logs pm
                JOIN employees e ON pm.operator_employee_id = e.id
                WHERE pm.tenant_id = $1 ${branchFilter} ${dateFilter}
                GROUP BY pm.operator_employee_id, e.first_name, e.last_name
                ORDER BY total_weight_kg DESC
                LIMIT 10
            `, params);

            // Overall weight stats
            const weightStatsResult = await pool.query(`
                SELECT
                    COALESCE(SUM(pm.total_weight_kg), 0) AS total_weight_kg,
                    COALESCE(AVG(NULLIF(pm.total_weight_kg, 0)), 0) AS avg_weight_per_session,
                    COALESCE(SUM(pm.weighing_cycle_count), 0) AS total_cycles,
                    COUNT(*) FILTER (WHERE pm.total_weight_kg > 0) AS sessions_with_weight
                FROM preparation_mode_logs pm
                WHERE pm.tenant_id = $1 ${branchFilter} ${dateFilter}
            `, params);

            res.json({
                success: true,
                data: {
                    hourly: hourlyResult.rows,
                    operators: operatorWeightResult.rows,
                    weight_stats: weightStatsResult.rows[0]
                }
            });

        } catch (error) {
            console.error('[PrepMode/Analytics] Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener analytics' });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/preparation-mode/active - Sesiones activas actuales
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/active', async (req, res) => {
        try {
            const { tenantId, branchId } = req.query;

            if (!tenantId || !branchId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId y branchId son requeridos'
                });
            }

            const result = await pool.query(`
                SELECT
                    pm.id, pm.global_id, pm.activated_at, pm.reason,
                    CONCAT(op.first_name, ' ', op.last_name) as operator_name,
                    CONCAT(auth.first_name, ' ', auth.last_name) as authorizer_name,
                    EXTRACT(EPOCH FROM (NOW() - pm.activated_at)) as current_duration_seconds
                FROM preparation_mode_logs pm
                LEFT JOIN employees op ON pm.operator_employee_id = op.id
                LEFT JOIN employees auth ON pm.authorized_by_employee_id = auth.id
                WHERE pm.tenant_id = $1
                    AND pm.branch_id = $2
                    AND pm.status = 'active'
                ORDER BY pm.activated_at DESC
            `, [parseInt(tenantId), parseInt(branchId)]);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length,
                has_active: result.rows.length > 0
            });

        } catch (error) {
            console.error('[PrepMode/Active] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener sesiones activas',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // PATCH /api/preparation-mode/:id/review - Marcar como revisado
    // ═══════════════════════════════════════════════════════════════════════════
    router.patch('/:id/review', async (req, res) => {
        try {
            const { id } = req.params;
            const { review_notes, reviewed_by_employee_id, tenantId, branchId } = req.body;

            if (!tenantId || !branchId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId y branchId son requeridos'
                });
            }

            const result = await pool.query(`
                UPDATE preparation_mode_logs
                SET
                    was_reviewed = true,
                    review_notes = $1,
                    reviewed_at = CURRENT_TIMESTAMP,
                    reviewed_by_employee_id = $2,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $3 AND tenant_id = $4 AND branch_id = $5
                RETURNING id, global_id, was_reviewed
            `, [
                review_notes,
                reviewed_by_employee_id,
                parseInt(id),
                parseInt(tenantId),
                parseInt(branchId)
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Log no encontrado'
                });
            }

            res.json({
                success: true,
                message: 'Log marcado como revisado',
                data: result.rows[0]
            });

        } catch (error) {
            console.error('[PrepMode/Review] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al marcar como revisado',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // DELETE /api/preparation-mode/by-date-range - Eliminar logs por rango de fecha
    // ═══════════════════════════════════════════════════════════════════════════
    router.delete('/by-date-range', async (req, res) => {
        try {
            const tenantId = req.query.tenant_id;
            const branchId = req.query.branch_id;
            const startDate = req.query.start_date;
            const endDate = req.query.end_date;

            if (!tenantId || !branchId || !startDate || !endDate) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id, branch_id, start_date y end_date son requeridos'
                });
            }

            const result = await pool.query(
                `DELETE FROM preparation_mode_logs
                 WHERE tenant_id = $1 AND branch_id = $2
                   AND activated_at >= $3 AND activated_at <= $4
                 RETURNING id, global_id`,
                [parseInt(tenantId), parseInt(branchId), startDate, endDate]
            );

            console.log(`[PrepMode/DeleteRange] 🗑️ ${result.rows.length} logs eliminados (${startDate} - ${endDate})`);

            res.json({
                success: true,
                message: `${result.rows.length} logs eliminados`,
                data: {
                    deleted_count: result.rows.length,
                    deleted_global_ids: result.rows.map(r => r.global_id)
                }
            });
        } catch (error) {
            console.error('[PrepMode/DeleteRange] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar logs por rango de fecha'
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // DELETE /api/preparation-mode/:global_id - Eliminar un log individual
    // ═══════════════════════════════════════════════════════════════════════════
    router.delete('/:global_id', async (req, res) => {
        try {
            const { global_id } = req.params;
            const tenantId = req.query.tenant_id;
            const branchId = req.query.branch_id;

            if (!tenantId || !branchId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id y branch_id son requeridos'
                });
            }

            const result = await pool.query(
                `DELETE FROM preparation_mode_logs
                 WHERE global_id = $1 AND tenant_id = $2 AND branch_id = $3
                 RETURNING id, global_id`,
                [global_id, parseInt(tenantId), parseInt(branchId)]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Log no encontrado'
                });
            }

            console.log(`[PrepMode/Delete] 🗑️ Log eliminado: ${global_id}`);

            res.json({
                success: true,
                message: 'Log eliminado',
                data: result.rows[0]
            });
        } catch (error) {
            console.error('[PrepMode/Delete] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar log'
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // PREPARATION MODE WINDOWS - CRUD para ventanas horarias de alistamiento
    // ═══════════════════════════════════════════════════════════════════════════

    // GET /api/preparation-mode/windows - Listar ventanas de una sucursal
    router.get('/windows', async (req, res) => {
        try {
            const { tenant_id, branch_id } = req.query;
            if (!tenant_id || !branch_id) {
                return res.status(400).json({ success: false, message: 'tenant_id y branch_id son requeridos' });
            }

            const result = await pool.query(
                `SELECT * FROM preparation_mode_windows
                 WHERE tenant_id = $1 AND branch_id = $2
                 ORDER BY start_time`,
                [parseInt(tenant_id), parseInt(branch_id)]
            );

            res.json({ success: true, data: result.rows });
        } catch (error) {
            console.error('[PrepMode/Windows] Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener ventanas' });
        }
    });

    // POST /api/preparation-mode/windows - Crear ventana
    router.post('/windows', async (req, res) => {
        try {
            const { tenant_id, branch_id, name, start_time, end_time, is_active } = req.body;
            if (!tenant_id || !branch_id || !name || !start_time || !end_time) {
                return res.status(400).json({ success: false, message: 'Campos requeridos: tenant_id, branch_id, name, start_time, end_time' });
            }

            const result = await pool.query(
                `INSERT INTO preparation_mode_windows (tenant_id, branch_id, name, start_time, end_time, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [parseInt(tenant_id), parseInt(branch_id), name, start_time, end_time, is_active !== false]
            );

            const created = result.rows[0];
            res.json({ success: true, data: created });

            // Broadcast to branch so Desktop/Mobile stay in sync
            if (io) {
                io.to(`branch_${branch_id}`).emit('preparation_windows_updated', {
                    action: 'created',
                    branchId: parseInt(branch_id),
                    window: created
                });
            }
        } catch (error) {
            console.error('[PrepMode/Windows] Error creando:', error.message);
            res.status(500).json({ success: false, message: 'Error al crear ventana' });
        }
    });

    // DELETE /api/preparation-mode/windows/:id - Eliminar ventana
    router.delete('/windows/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query(
                'DELETE FROM preparation_mode_windows WHERE id = $1 RETURNING *',
                [parseInt(id)]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Ventana no encontrada' });
            }

            const deleted = result.rows[0];
            res.json({ success: true, data: deleted });

            // Broadcast to branch
            if (io) {
                io.to(`branch_${deleted.branch_id}`).emit('preparation_windows_updated', {
                    action: 'deleted',
                    branchId: deleted.branch_id,
                    windowId: deleted.id
                });
            }
        } catch (error) {
            console.error('[PrepMode/Windows] Error eliminando:', error.message);
            res.status(500).json({ success: false, message: 'Error al eliminar ventana' });
        }
    });

    // PATCH /api/preparation-mode/windows/:id - Actualizar ventana
    router.patch('/windows/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const { name, start_time, end_time, is_active } = req.body;

            const result = await pool.query(
                `UPDATE preparation_mode_windows
                 SET name = COALESCE($2, name),
                     start_time = COALESCE($3, start_time),
                     end_time = COALESCE($4, end_time),
                     is_active = COALESCE($5, is_active)
                 WHERE id = $1
                 RETURNING *`,
                [parseInt(id), name, start_time, end_time, is_active]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Ventana no encontrada' });
            }

            const updated = result.rows[0];
            res.json({ success: true, data: updated });

            // Broadcast to branch
            if (io) {
                io.to(`branch_${updated.branch_id}`).emit('preparation_windows_updated', {
                    action: 'updated',
                    branchId: updated.branch_id,
                    window: updated
                });
            }
        } catch (error) {
            console.error('[PrepMode/Windows] Error actualizando:', error.message);
            res.status(500).json({ success: false, message: 'Error al actualizar ventana' });
        }
    });

    return router;
};
