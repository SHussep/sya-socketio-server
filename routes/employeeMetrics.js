const express = require('express');
const router = express.Router();

module.exports = (pool) => {
    // ============================================================================
    // POST /api/employee-metrics/daily
    // Sincronizar métricas diarias desde Desktop (offline-first idempotente)
    // ============================================================================
    router.post('/daily', async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                employee_id,
                date,
                shift_id,
                // Contadores de eventos
                critical_events,
                high_events,
                moderate_events,
                low_events,
                informative_events,
                total_suspicious_events,
                // Métricas de desconexión
                disconnection_count,
                disconnection_total_minutes,
                disconnection_longest_minutes,
                // Métricas de rendimiento
                total_sales,
                clean_sales,
                success_rate,
                // Estado y top eventos
                daily_status,
                top_event_1_type,
                top_event_1_count,
                top_event_2_type,
                top_event_2_count,
                top_event_3_type,
                top_event_3_count,
                // Offline-first fields
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw
            } = req.body;

            // Validar campos requeridos
            if (!tenant_id || !branch_id || !employee_id || !date || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos: se requieren tenant_id, branch_id, employee_id, date y global_id'
                });
            }

            // Insertar o actualizar usando ON CONFLICT (idempotente por global_id)
            const result = await pool.query(
                `INSERT INTO employee_daily_metrics (
                    tenant_id,
                    branch_id,
                    employee_id,
                    date,
                    shift_id,
                    critical_events,
                    high_events,
                    moderate_events,
                    low_events,
                    informative_events,
                    total_suspicious_events,
                    disconnection_count,
                    disconnection_total_minutes,
                    disconnection_longest_minutes,
                    total_sales,
                    clean_sales,
                    success_rate,
                    daily_status,
                    top_event_1_type,
                    top_event_1_count,
                    top_event_2_type,
                    top_event_2_count,
                    top_event_3_type,
                    top_event_3_count,
                    global_id,
                    terminal_id,
                    local_op_seq,
                    created_local_utc,
                    device_event_raw,
                    created_at,
                    updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                    $21, $22, $23, $24, $25, $26, $27, $28, $29, NOW(), NOW()
                )
                ON CONFLICT (global_id) DO UPDATE
                SET
                    critical_events = EXCLUDED.critical_events,
                    high_events = EXCLUDED.high_events,
                    moderate_events = EXCLUDED.moderate_events,
                    low_events = EXCLUDED.low_events,
                    informative_events = EXCLUDED.informative_events,
                    total_suspicious_events = EXCLUDED.total_suspicious_events,
                    disconnection_count = EXCLUDED.disconnection_count,
                    disconnection_total_minutes = EXCLUDED.disconnection_total_minutes,
                    disconnection_longest_minutes = EXCLUDED.disconnection_longest_minutes,
                    total_sales = EXCLUDED.total_sales,
                    clean_sales = EXCLUDED.clean_sales,
                    success_rate = EXCLUDED.success_rate,
                    daily_status = EXCLUDED.daily_status,
                    top_event_1_type = EXCLUDED.top_event_1_type,
                    top_event_1_count = EXCLUDED.top_event_1_count,
                    top_event_2_type = EXCLUDED.top_event_2_type,
                    top_event_2_count = EXCLUDED.top_event_2_count,
                    top_event_3_type = EXCLUDED.top_event_3_type,
                    top_event_3_count = EXCLUDED.top_event_3_count,
                    updated_at = NOW()
                RETURNING id, global_id, created_at`,
                [
                    tenant_id,
                    branch_id,
                    employee_id,
                    date,
                    shift_id,
                    critical_events || 0,
                    high_events || 0,
                    moderate_events || 0,
                    low_events || 0,
                    informative_events || 0,
                    total_suspicious_events || 0,
                    disconnection_count || 0,
                    disconnection_total_minutes || 0,
                    disconnection_longest_minutes || 0,
                    total_sales || 0,
                    clean_sales || 0,
                    success_rate || 100,
                    daily_status || 'NORMAL',
                    top_event_1_type,
                    top_event_1_count || 0,
                    top_event_2_type,
                    top_event_2_count || 0,
                    top_event_3_type,
                    top_event_3_count || 0,
                    global_id,
                    terminal_id,
                    local_op_seq,
                    created_local_utc,
                    device_event_raw
                ]
            );

            const metrics = result.rows[0];
            console.log(`[Sync/EmployeeMetrics] ✅ Métricas sincronizadas: ID ${metrics.id} - Employee ${employee_id} - ${date} - ${daily_status}`);

            // También actualizar guardian_employee_scores_daily para compatibilidad
            try {
                const disconnectedSeconds = Math.round((disconnection_total_minutes || 0) * 60);

                await pool.query(
                    `INSERT INTO guardian_employee_scores_daily (
                        tenant_id,
                        branch_id,
                        employee_remote_id,
                        day,
                        suspicious_count,
                        disconnection_count,
                        disconnected_seconds,
                        created_at,
                        updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
                    ON CONFLICT (tenant_id, branch_id, employee_remote_id, day)
                    DO UPDATE SET
                        suspicious_count = EXCLUDED.suspicious_count,
                        disconnection_count = EXCLUDED.disconnection_count,
                        disconnected_seconds = EXCLUDED.disconnected_seconds,
                        updated_at = NOW()`,
                    [
                        tenant_id,
                        branch_id,
                        employee_id,
                        date,
                        total_suspicious_events || 0,
                        disconnection_count || 0,
                        disconnectedSeconds
                    ]
                );

                console.log(`[Sync/EmployeeMetrics] ✅ guardian_employee_scores_daily actualizado para Employee ${employee_id}`);
            } catch (guardianError) {
                console.error(`[Sync/EmployeeMetrics] ⚠️ Error actualizando guardian_employee_scores_daily: ${guardianError.message}`);
                // No fallar la request principal si esto falla
            }

            res.json({
                success: true,
                data: {
                    id: metrics.id,
                    global_id: metrics.global_id,
                    created_at: metrics.created_at
                }
            });

        } catch (error) {
            console.error('[Sync/EmployeeMetrics] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar métricas de empleado'
            });
        }
    });

    // ============================================================================
    // GET /api/employee-metrics/daily
    // Obtener métricas diarias (para reportes y análisis)
    // ============================================================================
    router.get('/daily', async (req, res) => {
        try {
            const { tenant_id, branch_id, employee_id, start_date, end_date, limit = 30 } = req.query;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenant_id'
                });
            }

            let query = `
                SELECT * FROM employee_daily_metrics
                WHERE tenant_id = $1
            `;
            const params = [tenant_id];
            let paramIndex = 2;

            if (branch_id) {
                query += ` AND branch_id = $${paramIndex}`;
                params.push(branch_id);
                paramIndex++;
            }

            if (employee_id) {
                query += ` AND employee_id = $${paramIndex}`;
                params.push(employee_id);
                paramIndex++;
            }

            if (start_date) {
                query += ` AND date >= $${paramIndex}`;
                params.push(start_date);
                paramIndex++;
            }

            if (end_date) {
                query += ` AND date <= $${paramIndex}`;
                params.push(end_date);
                paramIndex++;
            }

            query += ` ORDER BY date DESC, critical_events DESC LIMIT $${paramIndex}`;
            params.push(limit);

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            console.error('[EmployeeMetrics] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener métricas de empleado'
            });
        }
    });

    // ============================================================================
    // GET /api/employee-metrics/ranking
    // Ranking de empleados por tasa de éxito
    // ============================================================================
    router.get('/ranking', async (req, res) => {
        try {
            const { tenant_id, branch_id, start_date, end_date, limit = 10 } = req.query;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenant_id'
                });
            }

            let query = `
                SELECT
                    employee_id,
                    COUNT(*) as days_worked,
                    SUM(total_sales) as total_sales,
                    SUM(clean_sales) as total_clean_sales,
                    AVG(success_rate) as avg_success_rate,
                    SUM(critical_events) as total_critical_events,
                    SUM(disconnection_count) as total_disconnections,
                    SUM(disconnection_total_minutes) as total_disconnection_minutes
                FROM employee_daily_metrics
                WHERE tenant_id = $1
            `;
            const params = [tenant_id];
            let paramIndex = 2;

            if (branch_id) {
                query += ` AND branch_id = $${paramIndex}`;
                params.push(branch_id);
                paramIndex++;
            }

            if (start_date) {
                query += ` AND date >= $${paramIndex}`;
                params.push(start_date);
                paramIndex++;
            }

            if (end_date) {
                query += ` AND date <= $${paramIndex}`;
                params.push(end_date);
                paramIndex++;
            }

            query += `
                GROUP BY employee_id
                ORDER BY avg_success_rate DESC, total_critical_events ASC
                LIMIT $${paramIndex}
            `;
            params.push(limit);

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            console.error('[EmployeeMetrics/Ranking] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener ranking de empleados'
            });
        }
    });

    return router;
};
