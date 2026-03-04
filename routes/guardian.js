// ═══════════════════════════════════════════════════════════════
// GUARDIAN ROUTES - Unified API for Guardian Events (Mobile App)
// ═══════════════════════════════════════════════════════════════
//
// This file provides a unified API for the mobile app to consume
// Guardian events from PostgreSQL. It combines:
// - suspicious_weighing_logs (suspicious scale events)
// - scale_disconnection_logs (scale disconnection/reconnection events)
//
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { createAuthMiddleware } = require('../middleware/auth');

module.exports = (pool, guardianStatusByBranch) => {
    const router = express.Router();
    const authenticateToken = createAuthMiddleware(pool);

    // ============================================================================
    // GET /api/guardian/events
    // Get all Guardian events (suspicious + disconnections) with filters
    // ============================================================================
    router.get('/events', authenticateToken, async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                employee_id,
                start_date,
                end_date,
                event_type,      // 'suspicious', 'disconnection', or 'all' (default)
                severity,        // 'Critical', 'High', 'Medium', 'Low'
                include_hidden = 'false',
                limit = 100,
                offset = 0
            } = req.query;

            console.log(`[Guardian/Events] 🔍 Request: tenant=${tenant_id}, branch=${branch_id}, type=${event_type}, dates=${start_date} to ${end_date}`);

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            const events = [];
            const eventTypeFilter = event_type || 'all';

            // ═══════════════════════════════════════════════════════════════
            // QUERY 1: Suspicious Weighing Logs
            // ═══════════════════════════════════════════════════════════════
            if (eventTypeFilter === 'all' || eventTypeFilter === 'suspicious') {
                let suspiciousQuery = `
                    SELECT
                        swl.id,
                        swl.global_id,
                        'suspicious' as event_category,
                        swl.tenant_id,
                        swl.branch_id,
                        swl.shift_id,
                        swl.employee_id,
                        e.first_name || ' ' || e.last_name as employee_name,
                        swl.timestamp as event_time,
                        swl.event_type,
                        swl.weight_detected,
                        swl.details,
                        swl.severity,
                        swl.suspicion_level,
                        swl.scenario_code,
                        swl.risk_score,
                        swl.points_assigned,
                        swl.employee_score_after_event,
                        swl.employee_score_band,
                        swl.page_context,
                        swl.trust_score,
                        swl.was_reviewed,
                        swl.review_notes,
                        swl.reviewed_at,
                        swl.is_hidden,
                        swl.created_at
                    FROM suspicious_weighing_logs swl
                    LEFT JOIN employees e ON e.id = swl.employee_id
                    WHERE swl.tenant_id = $1
                `;
                const suspiciousParams = [tenant_id];
                let paramIndex = 2;

                if (branch_id) {
                    suspiciousQuery += ` AND swl.branch_id = $${paramIndex}`;
                    suspiciousParams.push(branch_id);
                    paramIndex++;
                }

                if (employee_id) {
                    suspiciousQuery += ` AND swl.employee_id = $${paramIndex}`;
                    suspiciousParams.push(employee_id);
                    paramIndex++;
                }

                if (start_date) {
                    suspiciousQuery += ` AND swl.timestamp >= $${paramIndex}::timestamptz`;
                    suspiciousParams.push(start_date);
                    paramIndex++;
                }

                if (end_date) {
                    suspiciousQuery += ` AND swl.timestamp < $${paramIndex}::timestamptz`;
                    suspiciousParams.push(end_date);
                    paramIndex++;
                }

                if (severity) {
                    suspiciousQuery += ` AND swl.severity = $${paramIndex}`;
                    suspiciousParams.push(severity);
                    paramIndex++;
                }

                // Filtrar eventos ocultos
                if (include_hidden !== 'true') {
                    suspiciousQuery += ` AND (swl.is_hidden IS NULL OR swl.is_hidden = false)`;
                }

                suspiciousQuery += ` ORDER BY swl.timestamp DESC`;

                const suspiciousResult = await pool.query(suspiciousQuery, suspiciousParams);
                console.log(`[Guardian/Events] 📊 Suspicious query returned ${suspiciousResult.rows.length} rows`);
                events.push(...suspiciousResult.rows);
            }

            // ═══════════════════════════════════════════════════════════════
            // QUERY 2: Scale Disconnection Logs
            // ═══════════════════════════════════════════════════════════════
            if (eventTypeFilter === 'all' || eventTypeFilter === 'disconnection') {
                let disconnectionQuery = `
                    SELECT
                        sdl.id,
                        sdl.global_id,
                        'disconnection' as event_category,
                        sdl.tenant_id,
                        sdl.branch_id,
                        sdl.shift_id,
                        sdl.employee_id,
                        e.first_name || ' ' || e.last_name as employee_name,
                        sdl.disconnected_at as event_time,
                        CASE
                            WHEN sdl.disconnection_status = 'reconnected' THEN 'Báscula Reconectada'
                            ELSE 'Báscula Desconectada'
                        END as event_type,
                        NULL as weight_detected,
                        COALESCE(sdl.notes, 'Duración: ' || COALESCE(sdl.duration_minutes, 0) || ' minutos') as details,
                        CASE
                            WHEN COALESCE(sdl.duration_minutes, 0) > 10 THEN 'High'
                            WHEN COALESCE(sdl.duration_minutes, 0) > 5 THEN 'Medium'
                            ELSE 'Low'
                        END as severity,
                        NULL as suspicion_level,
                        'SCALE_DISCONNECTION' as scenario_code,
                        NULL as risk_score,
                        NULL as points_assigned,
                        NULL as employee_score_after_event,
                        NULL as employee_score_band,
                        NULL as page_context,
                        NULL as trust_score,
                        false as was_reviewed,
                        NULL as review_notes,
                        NULL as reviewed_at,
                        sdl.is_hidden,
                        sdl.disconnected_at as created_at,
                        sdl.reconnected_at,
                        sdl.duration_minutes,
                        sdl.disconnection_status
                    FROM scale_disconnection_logs sdl
                    LEFT JOIN employees e ON e.id = sdl.employee_id
                    WHERE sdl.tenant_id = $1
                `;
                const disconnectionParams = [tenant_id];
                let paramIndex = 2;

                if (branch_id) {
                    disconnectionQuery += ` AND sdl.branch_id = $${paramIndex}`;
                    disconnectionParams.push(branch_id);
                    paramIndex++;
                }

                if (employee_id) {
                    disconnectionQuery += ` AND sdl.employee_id = $${paramIndex}`;
                    disconnectionParams.push(employee_id);
                    paramIndex++;
                }

                if (start_date) {
                    disconnectionQuery += ` AND sdl.disconnected_at >= $${paramIndex}::timestamptz`;
                    disconnectionParams.push(start_date);
                    paramIndex++;
                }

                if (end_date) {
                    disconnectionQuery += ` AND sdl.disconnected_at < $${paramIndex}::timestamptz`;
                    disconnectionParams.push(end_date);
                    paramIndex++;
                }

                // Filtrar eventos ocultos
                if (include_hidden !== 'true') {
                    disconnectionQuery += ` AND (sdl.is_hidden IS NULL OR sdl.is_hidden = false)`;
                }

                disconnectionQuery += ` ORDER BY sdl.disconnected_at DESC`;

                const disconnectionResult = await pool.query(disconnectionQuery, disconnectionParams);
                console.log(`[Guardian/Events] 📊 Disconnection query returned ${disconnectionResult.rows.length} rows`);
                events.push(...disconnectionResult.rows);
            }

            // ═══════════════════════════════════════════════════════════════
            // Sort combined results by event_time DESC
            // ═══════════════════════════════════════════════════════════════
            events.sort((a, b) => new Date(b.event_time) - new Date(a.event_time));

            // Apply pagination
            const paginatedEvents = events.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

            console.log(`[Guardian/Events] ✅ Returning ${paginatedEvents.length} events (total: ${events.length})`);

            res.json({
                success: true,
                data: paginatedEvents,
                pagination: {
                    total: events.length,
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    hasMore: events.length > parseInt(offset) + parseInt(limit)
                }
            });

        } catch (error) {
            console.error('[Guardian/Events] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener eventos Guardian',
                error: undefined
            });
        }
    });

    // ============================================================================
    // GET /api/guardian/summary
    // Get summary statistics for Guardian events (for dashboard cards)
    // ============================================================================
    router.get('/summary', authenticateToken, async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                start_date,
                end_date
            } = req.query;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            // Default to today if no dates provided
            const today = new Date();
            const startOfDay = start_date || new Date(today.setHours(0, 0, 0, 0)).toISOString();
            const endOfDay = end_date || new Date(today.setHours(23, 59, 59, 999)).toISOString();

            // ═══════════════════════════════════════════════════════════════
            // Suspicious Events Summary
            // ═══════════════════════════════════════════════════════════════
            let suspiciousQuery = `
                SELECT
                    COUNT(*) FILTER (WHERE severity = 'Critical') as critical_count,
                    COUNT(*) FILTER (WHERE severity = 'High') as high_count,
                    COUNT(*) FILTER (WHERE severity = 'Medium') as medium_count,
                    COUNT(*) FILTER (WHERE severity = 'Low') as low_count,
                    COUNT(*) as total_suspicious
                FROM suspicious_weighing_logs
                WHERE tenant_id = $1
                  AND timestamp >= $2::timestamptz
                  AND timestamp < $3::timestamptz
            `;
            const suspiciousParams = [tenant_id, startOfDay, endOfDay];

            if (branch_id) {
                suspiciousQuery = suspiciousQuery.replace(
                    'WHERE tenant_id = $1',
                    'WHERE tenant_id = $1 AND branch_id = $4'
                );
                suspiciousParams.push(branch_id);
            }

            const suspiciousResult = await pool.query(suspiciousQuery, suspiciousParams);

            // ═══════════════════════════════════════════════════════════════
            // Disconnection Events Summary
            // ═══════════════════════════════════════════════════════════════
            let disconnectionQuery = `
                SELECT
                    COUNT(*) as total_disconnections,
                    COALESCE(SUM(duration_minutes), 0) as total_disconnection_minutes,
                    COALESCE(MAX(duration_minutes), 0) as longest_disconnection_minutes
                FROM scale_disconnection_logs
                WHERE tenant_id = $1
                  AND disconnected_at >= $2::timestamptz
                  AND disconnected_at < $3::timestamptz
            `;
            const disconnectionParams = [tenant_id, startOfDay, endOfDay];

            if (branch_id) {
                disconnectionQuery = disconnectionQuery.replace(
                    'WHERE tenant_id = $1',
                    'WHERE tenant_id = $1 AND branch_id = $4'
                );
                disconnectionParams.push(branch_id);
            }

            const disconnectionResult = await pool.query(disconnectionQuery, disconnectionParams);

            const suspicious = suspiciousResult.rows[0];
            const disconnection = disconnectionResult.rows[0];

            res.json({
                success: true,
                data: {
                    suspicious: {
                        critical: parseInt(suspicious.critical_count) || 0,
                        high: parseInt(suspicious.high_count) || 0,
                        medium: parseInt(suspicious.medium_count) || 0,
                        low: parseInt(suspicious.low_count) || 0,
                        total: parseInt(suspicious.total_suspicious) || 0
                    },
                    disconnections: {
                        count: parseInt(disconnection.total_disconnections) || 0,
                        totalMinutes: parseFloat(disconnection.total_disconnection_minutes) || 0,
                        longestMinutes: parseFloat(disconnection.longest_disconnection_minutes) || 0
                    },
                    period: {
                        start: startOfDay,
                        end: endOfDay
                    }
                }
            });

        } catch (error) {
            console.error('[Guardian/Summary] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener resumen Guardian',
                error: undefined
            });
        }
    });

    // ============================================================================
    // GET /api/guardian/employees-ranking
    // Get employees ranked by Guardian events (for employee list)
    // ============================================================================
    router.get('/employees-ranking', authenticateToken, async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                start_date,
                end_date,
                limit = 20
            } = req.query;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            // Default to today if no dates provided
            const today = new Date();
            const startOfDay = start_date || new Date(today.setHours(0, 0, 0, 0)).toISOString();
            const endOfDay = end_date || new Date(today.setHours(23, 59, 59, 999)).toISOString();

            let query = `
                SELECT
                    swl.employee_id,
                    e.first_name || ' ' || e.last_name as employee_name,
                    COUNT(*) as total_events,
                    COUNT(*) FILTER (WHERE swl.severity = 'Critical') as critical_events,
                    COUNT(*) FILTER (WHERE swl.severity = 'High') as high_events,
                    COUNT(*) FILTER (WHERE swl.severity = 'Medium') as medium_events,
                    AVG(swl.employee_score_after_event) as avg_score,
                    MAX(swl.employee_score_band) as score_band
                FROM suspicious_weighing_logs swl
                LEFT JOIN employees e ON e.id = swl.employee_id
                WHERE swl.tenant_id = $1
                  AND swl.timestamp >= $2::timestamptz
                  AND swl.timestamp < $3::timestamptz
            `;
            const params = [tenant_id, startOfDay, endOfDay];
            let paramIndex = 4;

            if (branch_id) {
                query += ` AND swl.branch_id = $${paramIndex}`;
                params.push(branch_id);
                paramIndex++;
            }

            query += `
                GROUP BY swl.employee_id, e.first_name, e.last_name
                ORDER BY critical_events DESC, high_events DESC, total_events DESC
                LIMIT $${paramIndex}
            `;
            params.push(limit);

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows.map(row => ({
                    employeeId: row.employee_id,
                    employeeName: row.employee_name || 'Desconocido',
                    totalEvents: parseInt(row.total_events),
                    criticalEvents: parseInt(row.critical_events),
                    highEvents: parseInt(row.high_events),
                    mediumEvents: parseInt(row.medium_events),
                    avgScore: parseFloat(row.avg_score) || 0,
                    scoreBand: row.score_band || 'Normal'
                })),
                period: {
                    start: startOfDay,
                    end: endOfDay
                }
            });

        } catch (error) {
            console.error('[Guardian/EmployeesRanking] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener ranking de empleados',
                error: undefined
            });
        }
    });

    // ============================================================================
    // DELETE /api/guardian/events/:id
    // Delete a Guardian event permanently
    // ============================================================================
    router.delete('/events/:id', authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { event_category, tenant_id } = req.body;

            if (!id || !event_category || !tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'id, event_category y tenant_id son requeridos'
                });
            }

            // ✅ SECURITY: Validate table name against whitelist (not user input)
            const ALLOWED_TABLES = {
                'suspicious': 'suspicious_weighing_logs',
                'disconnection': 'scale_disconnection_logs'
            };
            const table = ALLOWED_TABLES[event_category];
            if (!table) {
                return res.status(400).json({
                    success: false,
                    message: 'event_category debe ser "suspicious" o "disconnection"'
                });
            }

            const result = await pool.query(
                `DELETE FROM ${table}
                 WHERE id = $1 AND tenant_id = $2
                 RETURNING id`,
                [id, tenant_id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Evento no encontrado'
                });
            }

            console.log(`[Guardian] 🗑️ Evento eliminado: ${event_category} #${id}`);

            res.json({
                success: true,
                data: result.rows[0],
                message: 'Evento eliminado'
            });

        } catch (error) {
            console.error('[Guardian/Delete] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar evento',
                error: undefined
            });
        }
    });

    // ============================================================================
    // POST /api/guardian/events/delete-all
    // Delete all Guardian events for a date range permanently
    // (Changed from DELETE to POST: DELETE with body is unreliable on some
    //  HTTP clients/Android - the body gets stripped silently)
    // ============================================================================
    router.post('/events/delete-all', authenticateToken, async (req, res) => {
        try {
            const { tenant_id, branch_id, start_date, end_date } = req.body;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            // Default to today if no dates provided
            const today = new Date();
            const startOfDay = start_date || new Date(today.setHours(0, 0, 0, 0)).toISOString();
            const endOfDay = end_date || new Date(today.setHours(23, 59, 59, 999)).toISOString();

            // Delete from suspicious_weighing_logs
            let suspiciousQuery = `
                DELETE FROM suspicious_weighing_logs
                WHERE tenant_id = $1
                  AND timestamp >= $2::timestamptz
                  AND timestamp < $3::timestamptz
            `;
            const suspiciousParams = [tenant_id, startOfDay, endOfDay];

            if (branch_id) {
                suspiciousQuery += ` AND branch_id = $4`;
                suspiciousParams.push(branch_id);
            }

            const suspiciousResult = await pool.query(suspiciousQuery, suspiciousParams);

            // Delete from scale_disconnection_logs
            let disconnectionQuery = `
                DELETE FROM scale_disconnection_logs
                WHERE tenant_id = $1
                  AND disconnected_at >= $2::timestamptz
                  AND disconnected_at < $3::timestamptz
            `;
            const disconnectionParams = [tenant_id, startOfDay, endOfDay];

            if (branch_id) {
                disconnectionQuery += ` AND branch_id = $4`;
                disconnectionParams.push(branch_id);
            }

            const disconnectionResult = await pool.query(disconnectionQuery, disconnectionParams);

            const totalDeleted = suspiciousResult.rowCount + disconnectionResult.rowCount;
            console.log(`[Guardian] 🗑️ ${totalDeleted} eventos eliminados (${suspiciousResult.rowCount} suspicious, ${disconnectionResult.rowCount} disconnections)`);

            res.json({
                success: true,
                data: {
                    suspiciousDeleted: suspiciousResult.rowCount,
                    disconnectionsDeleted: disconnectionResult.rowCount,
                    totalDeleted
                },
                message: `${totalDeleted} eventos eliminados`
            });

        } catch (error) {
            console.error('[Guardian/DeleteAll] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar eventos',
                error: undefined
            });
        }
    });

    // ============================================================================
    // GET /api/guardian/status
    // Get last known Guardian enabled/disabled status for a branch
    // (Stored in server memory from guardian_status_changed socket events)
    // ============================================================================
    router.get('/status', authenticateToken, (req, res) => {
        const { branch_id } = req.query;

        if (!branch_id) {
            return res.status(400).json({
                success: false,
                message: 'branch_id es requerido'
            });
        }

        const status = guardianStatusByBranch
            ? guardianStatusByBranch.get(Number(branch_id))
            : null;

        res.json({
            success: true,
            data: status || {
                isEnabled: true, // Default: Guardian está activo
                changedBy: null,
                changedAt: null,
            }
        });
    });

    // ============================================================================
    // GET /api/guardian/analytics
    // Aggregated analytics data for Guardian charts (mobile "Análisis" tab)
    // Single endpoint → 7 parallel queries → one JSON response
    // ============================================================================
    router.get('/analytics', authenticateToken, async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                start_date,
                end_date
            } = req.query;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            // Default to last 7 days if no dates provided
            const endDt = end_date ? new Date(end_date) : new Date();
            const startDt = start_date ? new Date(start_date) : new Date(endDt.getTime() - 7 * 24 * 60 * 60 * 1000);
            const startISO = startDt.toISOString();
            const endISO = endDt.toISOString();

            console.log(`[Guardian/Analytics] 📊 Request: tenant=${tenant_id}, branch=${branch_id}, ${startISO} → ${endISO}`);

            // Build branch filter clause
            const branchFilter = branch_id ? ' AND branch_id = $4' : '';
            const baseParams = branch_id
                ? [tenant_id, startISO, endISO, branch_id]
                : [tenant_id, startISO, endISO];

            // Determine granularity: daily for ≤30 days, weekly for >30 days
            const daysDiff = Math.ceil((endDt - startDt) / (1000 * 60 * 60 * 24));
            const truncUnit = daysDiff > 30 ? 'week' : 'day';

            // ═══════════════════════════════════════════════════════════════
            // Run 7 queries in parallel
            // ═══════════════════════════════════════════════════════════════
            const [
                dailyTrendResult,
                disconnectionTrendResult,
                severityDistResult,
                topEmployeesResult,
                eventTypesResult,
                disconnectionStatsResult,
                keyMetricsResult
            ] = await Promise.all([

                // 1️⃣ Daily event trend by severity (suspicious events)
                pool.query(`
                    SELECT
                        date_trunc('${truncUnit}', timestamp) as period,
                        COUNT(*) FILTER (WHERE severity = 'Critical') as critical,
                        COUNT(*) FILTER (WHERE severity = 'High') as high,
                        COUNT(*) FILTER (WHERE severity = 'Medium') as medium,
                        COUNT(*) FILTER (WHERE severity = 'Low') as low,
                        COUNT(*) as total
                    FROM suspicious_weighing_logs
                    WHERE tenant_id = $1
                      AND timestamp >= $2::timestamptz
                      AND timestamp < $3::timestamptz
                      ${branchFilter}
                    GROUP BY period
                    ORDER BY period ASC
                `, baseParams),

                // 2️⃣ Daily disconnection trend
                pool.query(`
                    SELECT
                        date_trunc('${truncUnit}', disconnected_at) as period,
                        COUNT(*) as count,
                        COALESCE(SUM(duration_minutes), 0) as total_minutes
                    FROM scale_disconnection_logs
                    WHERE tenant_id = $1
                      AND disconnected_at >= $2::timestamptz
                      AND disconnected_at < $3::timestamptz
                      ${branchFilter}
                    GROUP BY period
                    ORDER BY period ASC
                `, baseParams),

                // 3️⃣ Severity distribution (suspicious only)
                pool.query(`
                    SELECT
                        severity,
                        COUNT(*) as count
                    FROM suspicious_weighing_logs
                    WHERE tenant_id = $1
                      AND timestamp >= $2::timestamptz
                      AND timestamp < $3::timestamptz
                      ${branchFilter}
                    GROUP BY severity
                    ORDER BY
                        CASE severity
                            WHEN 'Critical' THEN 1
                            WHEN 'High' THEN 2
                            WHEN 'Medium' THEN 3
                            WHEN 'Low' THEN 4
                        END
                `, baseParams),

                // 4️⃣ Top 5 employees with most events (severity breakdown)
                pool.query(`
                    SELECT
                        swl.employee_id,
                        COALESCE(e.first_name || ' ' || e.last_name, 'Desconocido') as employee_name,
                        COUNT(*) as total,
                        COUNT(*) FILTER (WHERE swl.severity = 'Critical') as critical,
                        COUNT(*) FILTER (WHERE swl.severity = 'High') as high,
                        COUNT(*) FILTER (WHERE swl.severity = 'Medium') as medium,
                        COUNT(*) FILTER (WHERE swl.severity = 'Low') as low,
                        COALESCE(AVG(swl.risk_score), 0) as avg_risk_score
                    FROM suspicious_weighing_logs swl
                    LEFT JOIN employees e ON e.id = swl.employee_id
                    WHERE swl.tenant_id = $1
                      AND swl.timestamp >= $2::timestamptz
                      AND swl.timestamp < $3::timestamptz
                      ${branchFilter.replace('branch_id', 'swl.branch_id')}
                    GROUP BY swl.employee_id, e.first_name, e.last_name
                    ORDER BY critical DESC, high DESC, total DESC
                    LIMIT 5
                `, baseParams),

                // 5️⃣ Event types breakdown (by scenario_code → human-readable label)
                pool.query(`
                    SELECT
                        COALESCE(scenario_code, event_type) as type_key,
                        CASE COALESCE(scenario_code, event_type)
                            WHEN 'PesoSinRegistro' THEN 'Peso no cobrado'
                            WHEN 'MultiplesPesosSinRegistro' THEN 'Multiples pesos sin cobrar'
                            WHEN 'PesoParcialSinRegistro' THEN 'Retiro parcial sin cobrar'
                            WHEN 'PesoEnPantallaNoAutorizada' THEN 'Peso fuera de ventas'
                            WHEN 'CambioPantallaDurantePesaje' THEN 'Salio de ventas con peso'
                            WHEN 'SesionNoIniciadaConPeso' THEN 'Peso sin sesion'
                            WHEN 'PesoSinConfirmacionFinal' THEN 'Pesaje abandonado'
                            WHEN 'ProductoPesadoEliminado' THEN 'Producto pesado eliminado'
                            WHEN 'DialogoCanceladoConPeso' THEN 'Pesaje cancelado'
                            WHEN 'DialogoIgnorado' THEN 'Tiempo excedido sin confirmar'
                            WHEN 'ActividadFueraHorario' THEN 'Actividad fuera de horario'
                            WHEN 'CancelacionesExcesivas' THEN 'Muchas cancelaciones'
                            WHEN 'TiempoExcesivoConfirmacion' THEN 'Producto mucho tiempo en bascula'
                            WHEN 'AjusteNormal' THEN 'Operacion normal'
                            WHEN 'ReduccionPesoSinJustificacion' THEN 'Producto quitado antes de cobrar'
                            WHEN 'PesoInestableProlongado' THEN 'Bascula inestable'
                            WHEN 'MultiplesAjustesArribaAbajo' THEN 'Ajustes repetidos de peso'
                            WHEN 'DesconexionBascula' THEN 'Bascula desconectada'
                            WHEN 'DesconexionesFrecuentes' THEN 'Desconexiones frecuentes'
                            WHEN 'ReconexionConPesoActivo' THEN 'Reconexion con peso activo'
                            WHEN 'ReinicioSistemaDuranteTurno' THEN 'Sistema reiniciado'
                            WHEN 'PesoRealVsRegistrado' THEN 'Peso cobrado diferente al pesado'
                            WHEN 'PesoCeroConPesoEnBascula' THEN 'Cobro $0 con producto en bascula'
                            WHEN 'PesoInferiorPromedioProducto' THEN 'Peso muy bajo para el producto'
                            WHEN 'DiscrepanciaInventarioCierre' THEN 'Inventario no cuadra'
                            WHEN 'CorrelacionPesoProductoIncorrecta' THEN 'Peso no corresponde al producto'
                            WHEN 'PicosActividadSospechosa' THEN 'Muchos eventos sospechosos'
                            WHEN 'AusenciaActividadHorarioPico' THEN 'Sin actividad en horario pico'
                            WHEN 'CambioUsuarioDurantePesaje' THEN 'Cambio de usuario con peso'
                            WHEN 'VelocidadTransaccionAnormal' THEN 'Transaccion muy rapida/lenta'
                            WHEN 'UsoOverridePermisos' THEN 'Permiso especial usado'
                            WHEN 'BasculaNoAutorizada' THEN 'Bascula no autorizada'
                            WHEN 'PesajesFraccionados' THEN 'Pesajes divididos'
                            WHEN 'PesoExcedeDuranteGracia' THEN 'Peso excede durante gracia'
                            WHEN 'PesoRetiradoSinRegistrar' THEN 'Peso retirado sin registrar'
                            WHEN 'VentaCanceladaConProductosPesados' THEN 'Venta cancelada con productos pesados'
                            WHEN 'SegundoProductoSinMoverBascula' THEN 'Segundo producto sin mover bascula'
                            WHEN 'TaraSospechosa' THEN 'TARA bloqueada - peso sospechoso'
                            WHEN 'PesoNegativo' THEN 'Peso negativo - error de bascula'
                            WHEN 'GraciaExpiradaConPeso' THEN 'Producto olvidado en bascula'
                            WHEN 'PesoIncrementadoPostVenta' THEN 'Peso agregado despues de cobrar'
                            ELSE COALESCE(scenario_code, event_type)
                        END as label,
                        COUNT(*) as count,
                        AVG(risk_score) as avg_risk
                    FROM suspicious_weighing_logs
                    WHERE tenant_id = $1
                      AND timestamp >= $2::timestamptz
                      AND timestamp < $3::timestamptz
                      ${branchFilter}
                    GROUP BY type_key, label
                    ORDER BY count DESC
                    LIMIT 10
                `, baseParams),

                // 6️⃣ Disconnection stats (aggregate)
                pool.query(`
                    SELECT
                        COUNT(*) as total_disconnections,
                        COALESCE(SUM(duration_minutes), 0) as total_downtime_minutes,
                        COALESCE(AVG(duration_minutes), 0) as avg_downtime_minutes,
                        COALESCE(MAX(duration_minutes), 0) as max_downtime_minutes
                    FROM scale_disconnection_logs
                    WHERE tenant_id = $1
                      AND disconnected_at >= $2::timestamptz
                      AND disconnected_at < $3::timestamptz
                      ${branchFilter}
                `, baseParams),

                // 7️⃣ Key metrics: most active hour + avg risk score + total events
                pool.query(`
                    SELECT
                        COUNT(*) as total_events,
                        COALESCE(AVG(risk_score), 0) as avg_risk_score,
                        MODE() WITHIN GROUP (ORDER BY EXTRACT(HOUR FROM timestamp)) as most_active_hour
                    FROM suspicious_weighing_logs
                    WHERE tenant_id = $1
                      AND timestamp >= $2::timestamptz
                      AND timestamp < $3::timestamptz
                      ${branchFilter}
                `, baseParams)
            ]);

            // ═══════════════════════════════════════════════════════════════
            // Format response
            // ═══════════════════════════════════════════════════════════════
            const keyMetrics = keyMetricsResult.rows[0] || {};
            const disconnectionStats = disconnectionStatsResult.rows[0] || {};

            res.json({
                success: true,
                data: {
                    granularity: truncUnit,
                    period: { start: startISO, end: endISO, days: daysDiff },

                    keyMetrics: {
                        totalEvents: parseInt(keyMetrics.total_events) || 0,
                        avgRiskScore: parseFloat(parseFloat(keyMetrics.avg_risk_score || 0).toFixed(1)),
                        mostActiveHour: keyMetrics.most_active_hour != null
                            ? parseInt(keyMetrics.most_active_hour)
                            : null,
                        totalDisconnections: parseInt(disconnectionStats.total_disconnections) || 0
                    },

                    dailyTrend: dailyTrendResult.rows.map(r => ({
                        period: r.period,
                        critical: parseInt(r.critical) || 0,
                        high: parseInt(r.high) || 0,
                        medium: parseInt(r.medium) || 0,
                        low: parseInt(r.low) || 0,
                        total: parseInt(r.total) || 0
                    })),

                    disconnectionTrend: disconnectionTrendResult.rows.map(r => ({
                        period: r.period,
                        count: parseInt(r.count) || 0,
                        totalMinutes: parseFloat(r.total_minutes) || 0
                    })),

                    severityDistribution: severityDistResult.rows.map(r => ({
                        severity: r.severity,
                        count: parseInt(r.count) || 0
                    })),

                    topEmployees: topEmployeesResult.rows.map(r => ({
                        employeeId: r.employee_id,
                        employeeName: r.employee_name,
                        total: parseInt(r.total) || 0,
                        critical: parseInt(r.critical) || 0,
                        high: parseInt(r.high) || 0,
                        medium: parseInt(r.medium) || 0,
                        low: parseInt(r.low) || 0,
                        avgRiskScore: parseFloat(parseFloat(r.avg_risk_score || 0).toFixed(1))
                    })),

                    eventTypes: eventTypesResult.rows.map(r => ({
                        typeKey: r.type_key,
                        label: r.label,
                        count: parseInt(r.count) || 0,
                        avgRisk: parseFloat(parseFloat(r.avg_risk || 0).toFixed(1))
                    })),

                    disconnectionStats: {
                        total: parseInt(disconnectionStats.total_disconnections) || 0,
                        totalDowntimeMinutes: parseFloat(parseFloat(disconnectionStats.total_downtime_minutes || 0).toFixed(1)),
                        avgDowntimeMinutes: parseFloat(parseFloat(disconnectionStats.avg_downtime_minutes || 0).toFixed(1)),
                        maxDowntimeMinutes: parseFloat(parseFloat(disconnectionStats.max_downtime_minutes || 0).toFixed(1))
                    }
                }
            });

            console.log(`[Guardian/Analytics] ✅ Response sent (${dailyTrendResult.rows.length} trend periods, ${topEmployeesResult.rows.length} top employees)`);

        } catch (error) {
            console.error('[Guardian/Analytics] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener analytics de Guardian',
                error: undefined
            });
        }
    });

    return router;
};
