const express = require('express');
const router = express.Router();

module.exports = (pool) => {
    // ============================================================================
    // POST /api/scale-disconnection-logs/sync
    // Sincronizar evento de desconexión desde Desktop (offline-first idempotente)
    // ============================================================================
    router.post('/sync', async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                shift_global_id,      // ✅ GlobalId para idempotencia
                employee_global_id,   // ✅ GlobalId para idempotencia
                disconnected_at,
                reconnected_at,
                duration_minutes,
                status,
                reason,
                notes,
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw
            } = req.body;

            // Validar campos requeridos
            if (!tenant_id || !branch_id || !employee_global_id || !global_id || !disconnected_at || !status) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos: se requieren tenant_id, branch_id, employee_global_id, global_id, disconnected_at y status'
                });
            }

            // ✅ IDEMPOTENCIA: Resolver employee_global_id -> employee_id (PostgreSQL ID)
            const employeeResult = await pool.query(
                'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                [employee_global_id, tenant_id]
            );
            if (employeeResult.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: `Empleado con global_id ${employee_global_id} no encontrado`
                });
            }
            const employee_id = employeeResult.rows[0].id;

            // ✅ IDEMPOTENCIA: Resolver shift_global_id -> shift_id (opcional)
            let shift_id = null;
            if (shift_global_id) {
                const shiftResult = await pool.query(
                    'SELECT id FROM shifts WHERE global_id = $1',
                    [shift_global_id]
                );
                shift_id = shiftResult.rows.length > 0 ? shiftResult.rows[0].id : null;
            }

            // Insertar o actualizar usando ON CONFLICT (idempotente)
            const result = await pool.query(
                `INSERT INTO scale_disconnection_logs (
                    tenant_id,
                    branch_id,
                    shift_id,
                    employee_id,
                    disconnected_at,
                    reconnected_at,
                    duration_minutes,
                    disconnection_status,
                    reason,
                    notes,
                    global_id,
                    terminal_id,
                    local_op_seq,
                    created_local_utc,
                    device_event_raw,
                    created_at,
                    updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW()
                )
                ON CONFLICT (global_id) DO UPDATE
                SET
                    reconnected_at = EXCLUDED.reconnected_at,
                    duration_minutes = EXCLUDED.duration_minutes,
                    disconnection_status = EXCLUDED.disconnection_status,
                    notes = EXCLUDED.notes,
                    updated_at = NOW()
                RETURNING id, global_id, created_at`,
                [
                    tenant_id,
                    branch_id,
                    shift_id,
                    employee_id,
                    disconnected_at,
                    reconnected_at,
                    duration_minutes,
                    status,
                    reason,
                    notes,
                    global_id,
                    terminal_id,
                    local_op_seq,
                    created_local_utc,
                    device_event_raw
                ]
            );

            const log = result.rows[0];
            console.log(`[Sync/ScaleDisconnection] ✅ Log sincronizado: ID ${log.id} - ${status} (${duration_minutes || 0}min)`);

            res.json({
                success: true,
                data: {
                    id: log.id,
                    global_id: log.global_id,
                    created_at: log.created_at
                }
            });

        } catch (error) {
            console.error('[Sync/ScaleDisconnection] ❌ Error:', error.message);
            console.error('[Sync/ScaleDisconnection] ❌ Stack:', error.stack);
            console.error('[Sync/ScaleDisconnection] ❌ Body recibido:', JSON.stringify(req.body, null, 2));
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar log de desconexión de báscula',
                error: error.message
            });
        }
    });

    // ============================================================================
    // GET /api/scale-disconnection-logs
    // Obtener logs de desconexión (para análisis y reportes)
    // ============================================================================
    router.get('/', async (req, res) => {
        try {
            const { tenant_id, branch_id, limit = 50 } = req.query;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenant_id'
                });
            }

            let query = `
                SELECT * FROM scale_disconnection_logs
                WHERE tenant_id = $1
            `;
            const params = [tenant_id];

            if (branch_id) {
                query += ' AND branch_id = $2';
                params.push(branch_id);
            }

            query += ' ORDER BY disconnected_at DESC LIMIT $' + (params.length + 1);
            params.push(limit);

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            console.error('[ScaleDisconnection] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener logs de desconexión'
            });
        }
    });

    return router;
};
