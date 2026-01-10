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
const {
    notifyPreparationModeActivated,
    notifyPreparationModeDeactivated
} = require('../utils/notificationHelper');

module.exports = function(pool, io) {

    // ═══════════════════════════════════════════════════════════════════════════
    // POST /api/preparation-mode/sync - Sincronizar logs desde Desktop
    // ═══════════════════════════════════════════════════════════════════════════
    router.post('/sync', async (req, res) => {
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
            const newEvents = []; // Para emitir por Socket.IO

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
                            global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
                        ) VALUES (
                            $1, $2, $3,
                            $4, $5,
                            $6, $7, $8,
                            $9, $10,
                            $11, $12, $13, $14,
                            $15,
                            $16, $17, $18, $19, $20
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
                        log.global_id,
                        log.terminal_id,
                        log.local_op_seq || 0,
                        log.device_event_raw || 0,
                        log.created_local_utc
                    ]);

                    // Obtener nombre de la sucursal para notificaciones
                    const branchResult = await client.query(
                        'SELECT name FROM branches WHERE id = $1',
                        [log.branch_id]
                    );
                    const branchName = branchResult.rows[0]?.name || `Sucursal ${log.branch_id}`;

                    if (upsertResult.rows[0].inserted) {
                        results.inserted++;

                        if (status === 'active') {
                            // Nueva activación
                            newEvents.push({
                                type: 'preparation_mode_activated',
                                branchId: log.branch_id,
                                tenantId: log.tenant_id,
                                branchName,
                                data: {
                                    id: upsertResult.rows[0].id,
                                    global_id: log.global_id,
                                    operator_employee_id,
                                    operator_name,
                                    authorized_by_employee_id,
                                    authorizer_name,
                                    activated_at: log.activated_at,
                                    reason: log.reason,
                                    branch_name: branchName
                                }
                            });
                        } else if (status === 'completed' && log.deactivated_at) {
                            // Log insertado ya completado (fue offline durante activación)
                            // Enviar notificación de desactivación
                            console.log(`[PrepMode/Sync] 📝 Log insertado ya completado, enviando notificación de desactivación`);
                            newEvents.push({
                                type: 'preparation_mode_deactivated',
                                branchId: log.branch_id,
                                tenantId: log.tenant_id,
                                branchName,
                                data: {
                                    id: upsertResult.rows[0].id,
                                    global_id: log.global_id,
                                    operator_employee_id,
                                    operator_name,
                                    deactivated_at: log.deactivated_at,
                                    duration_seconds: log.duration_seconds,
                                    severity: upsertResult.rows[0].severity,
                                    branch_name: branchName
                                }
                            });
                        }
                    } else {
                        results.updated++;

                        // Si se actualizó a completado, emitir evento de desactivación
                        if (status === 'completed' && log.deactivated_at) {
                            newEvents.push({
                                type: 'preparation_mode_deactivated',
                                branchId: log.branch_id,
                                tenantId: log.tenant_id,
                                branchName,
                                data: {
                                    id: upsertResult.rows[0].id,
                                    global_id: log.global_id,
                                    operator_employee_id,
                                    operator_name,
                                    deactivated_at: log.deactivated_at,
                                    duration_seconds: log.duration_seconds,
                                    severity: upsertResult.rows[0].severity,
                                    branch_name: branchName
                                }
                            });
                        }
                    }

                } catch (logError) {
                    console.error(`[PrepMode/Sync] ❌ Error en log ${log.global_id}:`, logError.message);
                    results.errors.push({ global_id: log.global_id, error: logError.message });
                }
            }

            await client.query('COMMIT');

            // Emitir eventos por Socket.IO y enviar notificaciones push
            for (const event of newEvents) {
                // Socket.IO
                if (io) {
                    const room = `branch_${event.branchId}`;
                    io.to(room).emit(event.type, event.data);
                    console.log(`[PrepMode/Sync] 📡 Emitiendo ${event.type} a room ${room}`);
                }

                // Notificaciones Push FCM
                console.log(`[PrepMode/Sync] 🔔 Enviando notificación push: ${event.type} para tenant ${event.tenantId}`);
                try {
                    if (event.type === 'preparation_mode_activated') {
                        const notifResult = await notifyPreparationModeActivated(
                            event.tenantId,
                            event.branchId,
                            {
                                operatorName: event.data.operator_name,
                                authorizerName: event.data.authorizer_name || event.data.operator_name,
                                branchName: event.branchName,
                                reason: event.data.reason,
                                activatedAt: event.data.activated_at
                            }
                        );
                        console.log(`[PrepMode/Sync] 📲 Resultado notificación activación: sent=${notifResult.sent}, failed=${notifResult.failed}, total=${notifResult.total || 0}`);
                    } else if (event.type === 'preparation_mode_deactivated') {
                        // Formatear duración
                        const durationSecs = parseFloat(event.data.duration_seconds) || 0;
                        let durationFormatted = '';
                        if (durationSecs >= 3600) {
                            const hours = Math.floor(durationSecs / 3600);
                            const mins = Math.floor((durationSecs % 3600) / 60);
                            durationFormatted = `${hours}h ${mins}m`;
                        } else if (durationSecs >= 60) {
                            const mins = Math.floor(durationSecs / 60);
                            const secs = Math.floor(durationSecs % 60);
                            durationFormatted = `${mins}m ${secs}s`;
                        } else {
                            durationFormatted = `${Math.floor(durationSecs)}s`;
                        }

                        const notifResult = await notifyPreparationModeDeactivated(
                            event.tenantId,
                            event.branchId,
                            {
                                operatorName: event.data.operator_name,
                                branchName: event.branchName,
                                durationFormatted,
                                severity: event.data.severity || 'Low',
                                deactivatedAt: event.data.deactivated_at
                            }
                        );
                        console.log(`[PrepMode/Sync] 📲 Resultado notificación desactivación: sent=${notifResult.sent}, failed=${notifResult.failed}, total=${notifResult.total || 0}`);
                    }
                } catch (notifError) {
                    console.error(`[PrepMode/Sync] ⚠️ Error enviando notificación push:`, notifError.message);
                    // No fallar el sync por error de notificación
                }
            }

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
                error: error.message
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
                error: error.message
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
                error: error.message
            });
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
                error: error.message
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
                error: error.message
            });
        }
    });

    return router;
};
