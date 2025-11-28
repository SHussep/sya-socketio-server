// ═══════════════════════════════════════════════════════════════
// SUSPICIOUS WEIGHING LOGS ROUTES - Guardian Scale Monitoring
// ═══════════════════════════════════════════════════════════════

const express = require('express');

module.exports = (pool, io) => {
    const router = express.Router();

    // POST /api/suspicious-weighing-logs/sync - Sincronizar log desde Desktop (offline-first idempotente)
    router.post('/sync', async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                shift_id,
                employee_id,
                timestamp,
                event_type,
                weight_detected,
                details,
                severity,
                suspicion_level,
                scenario_code,
                risk_score,
                points_assigned,
                employee_score_after_event,
                employee_score_band,
                page_context,
                trust_score,
                additional_data_json,
                was_reviewed,
                review_notes,
                reviewed_at,
                reviewed_by_employee_id,
                similar_events_in_session,
                cycle_duration_seconds,
                max_weight_in_cycle,
                discrepancy_amount,
                related_product_id,
                related_sale_id,
                // Offline-first fields
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw
            } = req.body;

            // Validación
            if (!tenant_id || !branch_id || !employee_id || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, branch_id, employee_id, global_id requeridos)'
                });
            }

            console.log(`[Sync/GuardianLogs] 🔍 Sincronizando log Guardian - Tenant: ${tenant_id}, Employee: ${employee_id}, EventType: ${event_type}, GlobalId: ${global_id}`);

            // ✅ IDEMPOTENTE: INSERT con ON CONFLICT (global_id) DO UPDATE
            const result = await pool.query(
                `INSERT INTO suspicious_weighing_logs (
                    tenant_id, branch_id, shift_id, employee_id,
                    timestamp, event_type, weight_detected, details,
                    severity, suspicion_level, scenario_code, risk_score,
                    points_assigned, employee_score_after_event, employee_score_band,
                    page_context, trust_score, additional_data_json,
                    was_reviewed, review_notes, reviewed_at, reviewed_by_employee_id,
                    similar_events_in_session, cycle_duration_seconds,
                    max_weight_in_cycle, discrepancy_amount,
                    related_product_id, related_sale_id,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                 )
                 VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                    $21, $22, $23, $24, $25, $26, $27, $28,
                    $29::uuid, $30::uuid, $31, $32, $33
                 )
                 ON CONFLICT (global_id) DO UPDATE
                 SET
                     was_reviewed = EXCLUDED.was_reviewed,
                     review_notes = EXCLUDED.review_notes,
                     reviewed_at = EXCLUDED.reviewed_at,
                     reviewed_by_employee_id = EXCLUDED.reviewed_by_employee_id,
                     updated_at = NOW()
                 RETURNING id, global_id, created_at`,
                [
                    tenant_id, branch_id, shift_id, employee_id,
                    timestamp, event_type, weight_detected, details,
                    severity, suspicion_level, scenario_code, risk_score,
                    points_assigned, employee_score_after_event, employee_score_band,
                    page_context, trust_score, additional_data_json,
                    was_reviewed || false, review_notes, reviewed_at, reviewed_by_employee_id,
                    similar_events_in_session || 0, cycle_duration_seconds || 0,
                    max_weight_in_cycle || 0, discrepancy_amount || 0,
                    related_product_id, related_sale_id,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                ]
            );

            const log = result.rows[0];

            console.log(`[Sync/GuardianLogs] ✅ Log sincronizado: ID ${log.id} - ${event_type} (${severity}) - Employee ${employee_id}`);

            // ✅ NUEVO: Emitir evento Socket.IO en tiempo real a la app móvil
            if (io && branch_id) {
                // Obtener nombre del empleado si no se proporcionó
                let employeeName = 'Empleado desconocido';
                try {
                    const empResult = await pool.query(
                        'SELECT first_name, last_name FROM employees WHERE id = $1 AND tenant_id = $2',
                        [employee_id, tenant_id]
                    );
                    if (empResult.rows.length > 0) {
                        const emp = empResult.rows[0];
                        employeeName = `${emp.first_name} ${emp.last_name}`.trim();
                    }
                } catch (empError) {
                    console.error(`[Sync/GuardianLogs] ⚠️ Error obteniendo nombre de empleado: ${empError.message}`);
                }

                io.to(`branch_${branch_id}`).emit('scale_alert', {
                    branchId: branch_id,
                    alertId: log.id,
                    severity: severity || 'medium',
                    eventType: event_type,
                    weightDetected: weight_detected || 0,
                    details: details || '',
                    timestamp: timestamp || new Date().toISOString(),
                    employeeName: employeeName,
                    receivedAt: new Date().toISOString(),
                    source: 'sync'
                });

                console.log(`[Sync/GuardianLogs] 📡 Evento 'scale_alert' emitido a branch_${branch_id} para app móvil (${employeeName})`);
            }

            res.json({
                success: true,
                data: {
                    id: log.id,
                    global_id: log.global_id,
                    created_at: log.created_at
                }
            });

        } catch (error) {
            console.error('[Sync/GuardianLogs] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar log Guardian',
                error: error.message
            });
        }
    });

    // GET /api/suspicious-weighing-logs - Lista de logs (para revisión)
    router.get('/', async (req, res) => {
        try {
            const { tenant_id, branch_id, limit = 100, offset = 0, unreviewed_only = 'false' } = req.query;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id requerido'
                });
            }

            let query = `
                SELECT * FROM suspicious_weighing_logs
                WHERE tenant_id = $1
            `;
            const params = [tenant_id];
            let paramIndex = 2;

            if (branch_id) {
                query += ` AND branch_id = $${paramIndex}`;
                params.push(branch_id);
                paramIndex++;
            }

            if (unreviewed_only === 'true') {
                query += ` AND was_reviewed = false`;
            }

            query += ` ORDER BY timestamp DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });

        } catch (error) {
            console.error('[GuardianLogs] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener logs Guardian',
                error: error.message
            });
        }
    });

    return router;
};
