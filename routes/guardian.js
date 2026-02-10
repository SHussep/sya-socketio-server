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

module.exports = (pool) => {
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
                error: error.message
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
                error: error.message
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
                error: error.message
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
                error: error.message
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
                error: error.message
            });
        }
    });

    return router;
};
