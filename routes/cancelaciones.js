// routes/cancelaciones.js
// Purpose: API endpoints for cancelaciones_bitacora (sale cancellations tracking)
// Supports offline-first synchronization with idempotent inserts

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

module.exports = (pool, io) => {
    // ============================================================================
    // POST /api/cancelaciones/sync
    // Sincronizar cancelación desde POS (offline-first idempotente)
    // Soporta tanto IDs numéricos como GlobalIds para compatibilidad offline
    // ============================================================================
    router.post('/sync', authenticateToken, async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                // Soportar tanto IDs numéricos como GlobalIds
                id_turno,
                id_empleado,
                shift_global_id,      // GlobalId del turno (preferido para offline-first)
                employee_global_id,   // GlobalId del empleado (preferido para offline-first)
                fecha,
                id_venta,
                venta_global_id,      // GlobalId de la venta (preferido para offline-first)
                id_venta_detalle,
                id_producto,
                descripcion,
                cantidad,
                peso_kg,
                motivo,
                razon_id, // Normalized cancellation reason ID (FK)
                otra_razon, // Free text if razon_id is "Otra"
                // Offline-first fields
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc
            } = req.body;

            console.log(`[Sync/Cancelaciones] 🔄 Sincronizando cancelación - Tenant: ${tenant_id}, Branch: ${branch_id}`);
            console.log(`[Sync/Cancelaciones] 🔐 Offline-First - GlobalId: ${global_id}, TerminalId: ${terminal_id}`);
            console.log(`[Sync/Cancelaciones] 📎 Referencias - ShiftGlobalId: ${shift_global_id}, EmployeeGlobalId: ${employee_global_id}, VentaGlobalId: ${venta_global_id}`);

            // ═══════════════════════════════════════════════════════════════════
            // RESOLVER GlobalIds a IDs de PostgreSQL (offline-first)
            // ═══════════════════════════════════════════════════════════════════
            let resolvedShiftId = id_turno || null;
            let resolvedEmployeeId = id_empleado || null;
            let resolvedVentaId = id_venta || null;

            // Resolver shift_global_id -> id
            if (shift_global_id && !resolvedShiftId) {
                const shiftResult = await pool.query(
                    'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                    [shift_global_id, tenant_id]
                );
                if (shiftResult.rows.length > 0) {
                    resolvedShiftId = shiftResult.rows[0].id;
                    console.log(`[Sync/Cancelaciones] ✅ Turno resuelto: ${shift_global_id} -> ${resolvedShiftId}`);
                } else {
                    console.log(`[Sync/Cancelaciones] ⚠️ Turno no encontrado: ${shift_global_id}`);
                }
            }

            // Resolver employee_global_id -> id
            if (employee_global_id && !resolvedEmployeeId) {
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [employee_global_id, tenant_id]
                );
                if (empResult.rows.length > 0) {
                    resolvedEmployeeId = empResult.rows[0].id;
                    console.log(`[Sync/Cancelaciones] ✅ Empleado resuelto: ${employee_global_id} -> ${resolvedEmployeeId}`);
                } else {
                    console.log(`[Sync/Cancelaciones] ⚠️ Empleado no encontrado: ${employee_global_id}`);
                }
            }

            // Resolver venta_global_id -> id_venta
            if (venta_global_id && !resolvedVentaId) {
                const ventaResult = await pool.query(
                    'SELECT id_venta FROM ventas WHERE global_id = $1 AND tenant_id = $2',
                    [venta_global_id, tenant_id]
                );
                if (ventaResult.rows.length > 0) {
                    resolvedVentaId = ventaResult.rows[0].id_venta;
                    console.log(`[Sync/Cancelaciones] ✅ Venta resuelta: ${venta_global_id} -> ${resolvedVentaId}`);
                }
            }

            // Validate required fields (después de resolver GlobalIds)
            if (!tenant_id || !branch_id || !global_id || !terminal_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, branch_id, global_id, terminal_id requeridos)'
                });
            }

            // Validar que al menos tenemos empleado resuelto
            if (!resolvedEmployeeId) {
                console.log(`[Sync/Cancelaciones] ❌ No se pudo resolver empleado`);
                return res.status(400).json({
                    success: false,
                    message: 'No se pudo resolver el empleado (id_empleado o employee_global_id requerido)'
                });
            }

            // Convert numeric fields
            const numericCantidad = parseFloat(cantidad) || 0;
            const numericPesoKg = peso_kg !== null && peso_kg !== undefined ? parseFloat(peso_kg) : null;

            // Idempotent INSERT with ON CONFLICT (global_id) DO NOTHING
            const result = await pool.query(
                `INSERT INTO cancelaciones_bitacora (
                    tenant_id, branch_id, id_turno, id_empleado, fecha,
                    id_venta, id_venta_detalle, id_producto, descripcion,
                    cantidad, peso_kg, motivo, razon_id, otra_razon,
                    global_id, terminal_id, local_op_seq, created_local_utc,
                    synced, synced_at_raw, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9,
                    $10, $11, $12, $13, $14,
                    $15, $16, $17, $18,
                    TRUE, EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000, CURRENT_TIMESTAMP
                )
                ON CONFLICT (global_id) DO NOTHING
                RETURNING id, global_id`,
                [
                    tenant_id, branch_id, resolvedShiftId, resolvedEmployeeId, fecha,
                    resolvedVentaId, id_venta_detalle, id_producto, descripcion,
                    numericCantidad, numericPesoKg, motivo, razon_id, otra_razon,
                    global_id, terminal_id, local_op_seq, created_local_utc
                ]
            );

            let row;
            if (result.rows.length > 0) {
                row = result.rows[0];
            } else {
                // Already exists — fetch the existing record
                const existing = await pool.query(
                    'SELECT id, global_id FROM cancelaciones_bitacora WHERE global_id = $1',
                    [global_id]
                );
                row = existing.rows[0];
            }

            const cancelacionId = row.id;
            const branchId = branch_id;

            // Emit socket event for real-time sync
            if (io) {
                io.to(`branch_${branchId}`).emit('cancellation_created', {
                    cancellationId: row.id,
                    globalId: row.global_id,
                    branchId
                });
            }

            console.log(`[Sync/Cancelaciones] ✅ Cancelación sincronizada - ID: ${cancelacionId}, GlobalId: ${global_id}`);

            res.json({
                success: true,
                message: 'Cancelación sincronizada correctamente',
                data: {
                    id: cancelacionId,
                    global_id: global_id,
                    synced: true
                }
            });

        } catch (error) {
            console.error('[Sync/Cancelaciones] ❌ Error sincronizando cancelación:', error);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar cancelación',
                error: undefined
            });
        }
    });

    // ============================================================================
    // POST /api/cancelaciones/sync-batch
    // Sincronizar múltiples cancelaciones en batch (soporta GlobalIds)
    // ============================================================================
    router.post('/sync-batch', authenticateToken, async (req, res) => {
        try {
            const { cancelaciones } = req.body;

            if (!Array.isArray(cancelaciones) || cancelaciones.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere un array de cancelaciones no vacío'
                });
            }

            // Rate limit: max 200 items per batch
            if (cancelaciones.length > 200) {
                return res.status(400).json({
                    success: false,
                    message: `Batch demasiado grande (${cancelaciones.length} items). Máximo 200 por request.`
                });
            }

            console.log(`[Sync/Cancelaciones/Batch] 🔄 Sincronizando ${cancelaciones.length} cancelaciones...`);

            const results = [];
            const client = await pool.connect();

            try {
                await client.query('BEGIN');

                for (const cancelacion of cancelaciones) {
                    const {
                        tenant_id, branch_id,
                        id_turno, id_empleado, id_venta,
                        shift_global_id, employee_global_id, venta_global_id,
                        fecha, id_venta_detalle, id_producto, descripcion,
                        cantidad, peso_kg, motivo, razon_id, otra_razon,
                        global_id, terminal_id, local_op_seq, created_local_utc
                    } = cancelacion;

                    // Resolver GlobalIds
                    let resolvedShiftId = id_turno || null;
                    let resolvedEmployeeId = id_empleado || null;
                    let resolvedVentaId = id_venta || null;

                    if (shift_global_id && !resolvedShiftId) {
                        const shiftResult = await client.query(
                            'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                            [shift_global_id, tenant_id]
                        );
                        if (shiftResult.rows.length > 0) resolvedShiftId = shiftResult.rows[0].id;
                    }

                    if (employee_global_id && !resolvedEmployeeId) {
                        const empResult = await client.query(
                            'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                            [employee_global_id, tenant_id]
                        );
                        if (empResult.rows.length > 0) resolvedEmployeeId = empResult.rows[0].id;
                    }

                    if (venta_global_id && !resolvedVentaId) {
                        const ventaResult = await client.query(
                            'SELECT id_venta FROM ventas WHERE global_id = $1 AND tenant_id = $2',
                            [venta_global_id, tenant_id]
                        );
                        if (ventaResult.rows.length > 0) resolvedVentaId = ventaResult.rows[0].id_venta;
                    }

                    // Skip si no hay empleado resuelto
                    if (!resolvedEmployeeId) {
                        console.log(`[Sync/Cancelaciones/Batch] ⚠️ Saltando cancelación sin empleado: ${global_id}`);
                        results.push({ global_id, success: false, error: 'Empleado no encontrado' });
                        continue;
                    }

                    const numericCantidad = parseFloat(cantidad) || 0;
                    const numericPesoKg = peso_kg !== null && peso_kg !== undefined ? parseFloat(peso_kg) : null;

                    const result = await client.query(
                        `INSERT INTO cancelaciones_bitacora (
                            tenant_id, branch_id, id_turno, id_empleado, fecha,
                            id_venta, id_venta_detalle, id_producto, descripcion,
                            cantidad, peso_kg, motivo, razon_id, otra_razon,
                            global_id, terminal_id, local_op_seq, created_local_utc,
                            synced, synced_at_raw, created_at
                        ) VALUES (
                            $1, $2, $3, $4, $5,
                            $6, $7, $8, $9,
                            $10, $11, $12, $13, $14,
                            $15, $16, $17, $18,
                            TRUE, EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000, CURRENT_TIMESTAMP
                        )
                        ON CONFLICT (global_id) DO NOTHING
                        RETURNING id, global_id`,
                        [
                            tenant_id, branch_id, resolvedShiftId, resolvedEmployeeId, fecha,
                            resolvedVentaId, id_venta_detalle, id_producto, descripcion,
                            numericCantidad, numericPesoKg, motivo, razon_id, otra_razon,
                            global_id, terminal_id, local_op_seq, created_local_utc
                        ]
                    );

                    let row;
                    if (result.rows.length > 0) {
                        row = result.rows[0];
                    } else {
                        // Already exists — fetch the existing record
                        const existing = await client.query(
                            'SELECT id, global_id FROM cancelaciones_bitacora WHERE global_id = $1',
                            [global_id]
                        );
                        row = existing.rows[0];
                    }

                    // Emit socket event for real-time sync
                    if (io) {
                        io.to(`branch_${branch_id}`).emit('cancellation_created', {
                            cancellationId: row.id,
                            globalId: row.global_id,
                            branchId: branch_id
                        });
                    }

                    results.push({
                        global_id: row.global_id,
                        id: row.id,
                        success: true
                    });
                }

                await client.query('COMMIT');

                console.log(`[Sync/Cancelaciones/Batch] ✅ ${results.length} cancelaciones sincronizadas`);

                res.json({
                    success: true,
                    message: `${results.length} cancelaciones sincronizadas correctamente`,
                    data: results
                });

            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }

        } catch (error) {
            console.error('[Sync/Cancelaciones/Batch] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar lote de cancelaciones',
                error: undefined
            });
        }
    });

    // ============================================================================
    // GET /api/cancelaciones
    // Obtener cancelaciones con filtros
    // ============================================================================
    router.get('/', async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                id_empleado,
                id_turno,
                fecha_inicio,
                fecha_fin,
                limit = 100,
                offset = 0
            } = req.query;

            if (!tenant_id || !branch_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id y branch_id son requeridos'
                });
            }

            let query = `
                SELECT * FROM cancelaciones_bitacora
                WHERE tenant_id = $1 AND branch_id = $2
            `;
            const params = [tenant_id, branch_id];
            let paramIndex = 3;

            if (id_empleado) {
                query += ` AND id_empleado = $${paramIndex++}`;
                params.push(id_empleado);
            }

            if (id_turno) {
                query += ` AND id_turno = $${paramIndex++}`;
                params.push(id_turno);
            }

            if (fecha_inicio) {
                query += ` AND fecha >= $${paramIndex++}`;
                params.push(fecha_inicio);
            }

            if (fecha_fin) {
                query += ` AND fecha <= $${paramIndex++}`;
                params.push(fecha_fin);
            }

            query += ` ORDER BY fecha DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
            params.push(limit, offset);

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });

        } catch (error) {
            console.error('[Cancelaciones/Get] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener cancelaciones',
                error: undefined
            });
        }
    });

    // ============================================================================
    // GET /api/cancelaciones/pull
    // Descargar cancelaciones para sincronización (server-first pull)
    // ============================================================================
    router.get('/pull', authenticateToken, async (req, res) => {
        try {
            const tenantId = req.user.tenantId;
            const branchId = req.query.branch_id || req.user.branchId;
            const since = req.query.since || '1970-01-01T00:00:00Z';
            const limit = Math.min(parseInt(req.query.limit) || 500, 1000);

            console.log(`[Cancelaciones/Pull] 📥 Descargando - Tenant: ${tenantId}, Branch: ${branchId}, Since: ${since}`);

            const result = await pool.query(
                `SELECT * FROM cancelaciones_bitacora
                 WHERE tenant_id = $1 AND branch_id = $2 AND created_at > $3
                 ORDER BY created_at ASC
                 LIMIT $4`,
                [tenantId, branchId, since, limit]
            );

            console.log(`[Cancelaciones/Pull] 📦 Encontradas ${result.rows.length} cancelaciones`);

            res.json({
                success: true,
                data: {
                    cancelaciones: result.rows,
                    last_sync: new Date().toISOString()
                },
                count: result.rows.length
            });

        } catch (error) {
            console.error('[Cancelaciones/Pull] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al descargar cancelaciones',
                error: undefined
            });
        }
    });

    // ============================================================================
    // GET /api/cancelaciones/razones
    // Obtener razones de cancelación activas (para UI dropdowns)
    // ============================================================================
    router.get('/razones', async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT id, descripcion, requiere_otra_razon, orden
                 FROM cancelacion_razones
                 WHERE activo = TRUE
                 ORDER BY orden ASC, descripcion ASC`
            );

            res.json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            console.error('[Cancelaciones/Razones] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener razones de cancelación',
                error: undefined
            });
        }
    });

    return router;
};
