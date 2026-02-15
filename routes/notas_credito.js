// ═══════════════════════════════════════════════════════════════
// NOTAS DE CRÉDITO API - Sincronización y Consultas
// ═══════════════════════════════════════════════════════════════
// Maneja la sincronización de notas de crédito desde Desktop/WinUI
// y consultas desde la App Móvil.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

module.exports = function(pool) {

    // ═══════════════════════════════════════════════════════════════════════════
    // POST /api/notas-credito/sync - Sincronizar NC desde Desktop
    // ═══════════════════════════════════════════════════════════════════════════
    router.post('/sync', async (req, res) => {
        const client = await pool.connect();
        try {
            // Soportar tanto formato batch (notas_credito array) como single (objeto directo)
            let notas_credito = [];
            let detalles = [];

            if (Array.isArray(req.body.notas_credito)) {
                // Formato batch: { notas_credito: [...], detalles: [...] }
                notas_credito = req.body.notas_credito;
                detalles = req.body.detalles || [];
            } else if (req.body.global_id) {
                // Formato single (desde Desktop): objeto directo con global_id
                notas_credito = [req.body];
                detalles = req.body.detalles || [];
            } else {
                return res.status(400).json({
                    success: false,
                    message: 'Formato inválido: enviar notas_credito array o objeto con global_id'
                });
            }

            console.log(`[NC/Sync] 📥 Recibiendo ${notas_credito.length} notas de crédito, ${detalles.length} detalles`);

            await client.query('BEGIN');

            const results = { inserted: 0, updated: 0, errors: [], data: [] };

            for (const nc of notas_credito) {
                try {
                    // Resolver FKs por global_id
                    // Soportar ambos nombres: venta_global_id (legacy) o venta_original_global_id (Desktop)
                    const ventaGlobalId = nc.venta_global_id || nc.venta_original_global_id;
                    const ventaResult = await client.query(
                        'SELECT id_venta FROM ventas WHERE global_id = $1',
                        [ventaGlobalId]
                    );
                    if (ventaResult.rows.length === 0) {
                        results.errors.push({ global_id: nc.global_id, error: `Venta no encontrada: ${ventaGlobalId}` });
                        continue;
                    }
                    const venta_original_id = ventaResult.rows[0].id_venta;

                    const shiftResult = await client.query(
                        'SELECT id FROM shifts WHERE global_id = $1',
                        [nc.shift_global_id]
                    );
                    const shift_id = shiftResult.rows.length > 0 ? shiftResult.rows[0].id : null;

                    const empResult = await client.query(
                        'SELECT id FROM employees WHERE global_id = $1',
                        [nc.employee_global_id]
                    );
                    const employee_id = empResult.rows.length > 0 ? empResult.rows[0].id : null;

                    const authResult = await client.query(
                        'SELECT id FROM employees WHERE global_id = $1',
                        [nc.authorized_by_global_id || nc.employee_global_id]
                    );
                    const authorized_by_id = authResult.rows.length > 0 ? authResult.rows[0].id : employee_id;

                    let cliente_id = null;
                    if (nc.cliente_global_id) {
                        const clienteResult = await client.query(
                            'SELECT id FROM customers WHERE global_id = $1',
                            [nc.cliente_global_id]
                        );
                        if (clienteResult.rows.length > 0) {
                            cliente_id = clienteResult.rows[0].id;
                        }
                    }

                    if (!shift_id || !employee_id) {
                        results.errors.push({ global_id: nc.global_id, error: 'Shift o Employee no encontrado' });
                        continue;
                    }

                    // Upsert NC
                    const upsertResult = await client.query(`
                        INSERT INTO notas_credito (
                            venta_original_id, shift_id, employee_id, authorized_by_id, cliente_id,
                            tenant_id, branch_id, tipo, estado,
                            total, monto_credito, monto_efectivo, monto_tarjeta,
                            fecha_creacion, fecha_venta_original,
                            razon, notas, numero_nota_credito, ticket_original,
                            global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
                        ) VALUES (
                            $1, $2, $3, $4, $5,
                            $6, $7, $8, $9,
                            $10, $11, $12, $13,
                            $14, $15,
                            $16, $17, $18, $19,
                            $20, $21, $22, $23, $24
                        )
                        ON CONFLICT (global_id) DO UPDATE SET
                            estado = EXCLUDED.estado,
                            total = EXCLUDED.total,
                            monto_credito = EXCLUDED.monto_credito,
                            monto_efectivo = EXCLUDED.monto_efectivo,
                            monto_tarjeta = EXCLUDED.monto_tarjeta,
                            razon = EXCLUDED.razon,
                            notas = EXCLUDED.notas,
                            updated_at = CURRENT_TIMESTAMP
                        RETURNING id, (xmax = 0) AS inserted
                    `, [
                        venta_original_id, shift_id, employee_id, authorized_by_id, cliente_id,
                        nc.tenant_id, nc.branch_id, nc.tipo || 'Cancelacion', nc.estado || 'Aplicada',
                        parseFloat(nc.total) || 0,
                        parseFloat(nc.monto_credito) || 0,
                        parseFloat(nc.monto_efectivo) || 0,
                        parseFloat(nc.monto_tarjeta) || 0,
                        nc.fecha_creacion || new Date().toISOString(),
                        nc.fecha_venta_original,
                        nc.razon || 'Sin razón especificada',
                        nc.notas,
                        nc.numero_nota_credito,
                        nc.ticket_original,
                        nc.global_id,
                        nc.terminal_id,
                        nc.local_op_seq || 0,
                        nc.device_event_raw || 0,
                        nc.created_local_utc
                    ]);

                    const ncId = upsertResult.rows[0].id;
                    const wasInserted = upsertResult.rows[0].inserted;

                    if (wasInserted) {
                        results.inserted++;
                    } else {
                        results.updated++;
                    }

                    // Guardar el ID para el response (útil para sync single desde Desktop)
                    results.data.push({ global_id: nc.global_id, id: ncId, inserted: wasInserted });

                    // Procesar detalles de esta NC
                    // Soportar detalles embebidos (Desktop) o en array separado
                    const ncDetalles = nc.detalles || detalles.filter(d => d.nota_credito_global_id === nc.global_id);
                    for (const det of ncDetalles) {
                        // Resolver producto
                        let producto_id = null;
                        if (det.producto_global_id) {
                            const prodResult = await client.query(
                                'SELECT id FROM productos WHERE global_id = $1',
                                [det.producto_global_id]
                            );
                            if (prodResult.rows.length > 0) {
                                producto_id = prodResult.rows[0].id;
                            }
                        }

                        if (!producto_id) {
                            console.warn(`[NC/Sync] ⚠️ Producto no encontrado: ${det.producto_global_id}`);
                            continue;
                        }

                        // Resolver venta_detalle_original
                        let venta_detalle_original_id = null;
                        if (det.venta_detalle_global_id) {
                            const vdResult = await client.query(
                                'SELECT id_venta_detalle FROM ventas_detalle WHERE global_id = $1',
                                [det.venta_detalle_global_id]
                            );
                            if (vdResult.rows.length > 0) {
                                venta_detalle_original_id = vdResult.rows[0].id_venta_detalle;
                            }
                        }

                        await client.query(`
                            INSERT INTO notas_credito_detalle (
                                nota_credito_id, venta_detalle_original_id, producto_id,
                                descripcion_producto, cantidad, cantidad_original,
                                precio_unitario, total_linea, devuelve_a_inventario,
                                global_id, terminal_id, local_op_seq
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                            ON CONFLICT (global_id) DO UPDATE SET
                                cantidad = EXCLUDED.cantidad,
                                total_linea = EXCLUDED.total_linea,
                                devuelve_a_inventario = EXCLUDED.devuelve_a_inventario
                        `, [
                            ncId, venta_detalle_original_id, producto_id,
                            det.descripcion_producto || 'Producto',
                            parseFloat(det.cantidad) || 0,
                            parseFloat(det.cantidad_original) || 0,
                            parseFloat(det.precio_unitario) || 0,
                            parseFloat(det.total_linea) || 0,
                            det.devuelve_a_inventario !== false,
                            det.global_id,
                            det.terminal_id,
                            det.local_op_seq || 0
                        ]);
                    }

                } catch (ncError) {
                    console.error(`[NC/Sync] ❌ Error en NC ${nc.global_id}:`, ncError.message);
                    results.errors.push({ global_id: nc.global_id, error: ncError.message });
                }
            }

            await client.query('COMMIT');

            console.log(`[NC/Sync] ✅ Completado: ${results.inserted} insertadas, ${results.updated} actualizadas, ${results.errors.length} errores`);

            // Para formato single (Desktop), incluir data con el ID
            const response = {
                success: true,
                message: 'Sincronización de notas de crédito completada',
                results
            };

            // Si es single NC, incluir data directamente para que Desktop extraiga RemoteId
            if (results.data.length === 1) {
                response.data = results.data[0];
            }

            res.json(response);

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[NC/Sync] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar notas de crédito',
                error: undefined
            });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/notas-credito/pull - Descargar NC para sincronización
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/pull', async (req, res) => {
        try {
            const { tenantId, branchId, since, limit = 500 } = req.query;

            if (!tenantId || !branchId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId y branchId son requeridos'
                });
            }

            console.log(`[NC/Pull] 📥 Descargando NC - Tenant: ${tenantId}, Branch: ${branchId}, Since: ${since || 'ALL'}`);

            let query = `
                SELECT
                    nc.*,
                    v.global_id as venta_global_id,
                    s.global_id as shift_global_id,
                    e.global_id as employee_global_id,
                    auth.global_id as authorized_by_global_id,
                    c.global_id as cliente_global_id
                FROM notas_credito nc
                LEFT JOIN ventas v ON nc.venta_original_id = v.id_venta
                LEFT JOIN shifts s ON nc.shift_id = s.id
                LEFT JOIN employees e ON nc.employee_id = e.id
                LEFT JOIN employees auth ON nc.authorized_by_id = auth.id
                LEFT JOIN customers c ON nc.cliente_id = c.id
                WHERE nc.tenant_id = $1 AND nc.branch_id = $2
            `;

            const params = [parseInt(tenantId), parseInt(branchId)];
            let paramIndex = 3;

            if (since) {
                query += ` AND nc.updated_at > $${paramIndex}`;
                params.push(since);
                paramIndex++;
            }

            query += ` ORDER BY nc.updated_at ASC LIMIT $${paramIndex}`;
            params.push(parseInt(limit) || 500);

            const ncResult = await pool.query(query, params);
            console.log(`[NC/Pull] 📦 Encontradas ${ncResult.rows.length} notas de crédito`);

            // Cargar detalles
            let detalles = [];
            if (ncResult.rows.length > 0) {
                const ncIds = ncResult.rows.map(nc => nc.id);
                const detResult = await pool.query(`
                    SELECT
                        ncd.*,
                        p.global_id as producto_global_id,
                        vd.global_id as venta_detalle_global_id
                    FROM notas_credito_detalle ncd
                    LEFT JOIN productos p ON ncd.producto_id = p.id
                    LEFT JOIN ventas_detalle vd ON ncd.venta_detalle_original_id = vd.id_venta_detalle
                    WHERE ncd.nota_credito_id = ANY($1)
                `, [ncIds]);
                detalles = detResult.rows;
            }

            res.json({
                success: true,
                data: {
                    notas_credito: ncResult.rows,
                    detalles,
                    last_sync: new Date().toISOString()
                },
                count: ncResult.rows.length,
                detalles_count: detalles.length
            });

        } catch (error) {
            console.error('[NC/Pull] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al descargar notas de crédito',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/notas-credito - Listar NC con filtros (para App Móvil)
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/', async (req, res) => {
        try {
            const { tenantId, branchId, ventaId, estado, fecha_desde, fecha_hasta, limit = 50, offset = 0 } = req.query;

            if (!tenantId || !branchId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId y branchId son requeridos'
                });
            }

            let query = `
                SELECT
                    nc.id, nc.global_id, nc.tipo, nc.estado, nc.total,
                    nc.monto_credito, nc.monto_efectivo, nc.monto_tarjeta,
                    nc.fecha_creacion, nc.razon, nc.numero_nota_credito, nc.ticket_original,
                    v.ticket_number as venta_ticket_number,
                    CONCAT(e.first_name, ' ', e.last_name) as empleado_nombre,
                    c.nombre as cliente_nombre
                FROM notas_credito nc
                LEFT JOIN ventas v ON nc.venta_original_id = v.id_venta
                LEFT JOIN employees e ON nc.employee_id = e.id
                LEFT JOIN customers c ON nc.cliente_id = c.id
                WHERE nc.tenant_id = $1 AND nc.branch_id = $2
            `;

            const params = [parseInt(tenantId), parseInt(branchId)];
            let paramIndex = 3;

            if (ventaId) {
                query += ` AND nc.venta_original_id = $${paramIndex}`;
                params.push(parseInt(ventaId));
                paramIndex++;
            }

            if (estado) {
                query += ` AND nc.estado = $${paramIndex}`;
                params.push(estado);
                paramIndex++;
            }

            if (fecha_desde) {
                query += ` AND nc.fecha_creacion >= $${paramIndex}`;
                params.push(fecha_desde);
                paramIndex++;
            }

            if (fecha_hasta) {
                query += ` AND nc.fecha_creacion <= $${paramIndex}`;
                params.push(fecha_hasta);
                paramIndex++;
            }

            query += ` ORDER BY nc.fecha_creacion DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });

        } catch (error) {
            console.error('[NC/List] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener notas de crédito',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/notas-credito/venta/:ventaId - NC de una venta específica
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/venta/:ventaId', async (req, res) => {
        try {
            const { ventaId } = req.params;
            const { tenantId, branchId } = req.query;

            if (!tenantId || !branchId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId y branchId son requeridos'
                });
            }

            const ncResult = await pool.query(`
                SELECT
                    nc.id, nc.global_id, nc.tipo, nc.estado, nc.total,
                    nc.monto_credito, nc.monto_efectivo, nc.razon, nc.notas,
                    nc.numero_nota_credito, nc.fecha_creacion,
                    CONCAT(e.first_name, ' ', e.last_name) as empleado_nombre
                FROM notas_credito nc
                LEFT JOIN employees e ON nc.employee_id = e.id
                WHERE nc.venta_original_id = $1 AND nc.tenant_id = $2 AND nc.branch_id = $3
                ORDER BY nc.fecha_creacion DESC
            `, [parseInt(ventaId), parseInt(tenantId), parseInt(branchId)]);

            // Cargar detalles para cada NC
            for (const nc of ncResult.rows) {
                const detResult = await pool.query(`
                    SELECT
                        ncd.descripcion_producto, ncd.cantidad, ncd.cantidad_original,
                        ncd.precio_unitario, ncd.total_linea, ncd.devuelve_a_inventario
                    FROM notas_credito_detalle ncd
                    WHERE ncd.nota_credito_id = $1
                `, [nc.id]);
                nc.detalles = detResult.rows;
            }

            res.json({
                success: true,
                data: ncResult.rows,
                count: ncResult.rows.length,
                total_devuelto: ncResult.rows.reduce((sum, nc) => sum + parseFloat(nc.total), 0)
            });

        } catch (error) {
            console.error('[NC/Venta] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener notas de crédito de la venta',
                error: undefined
            });
        }
    });

    return router;
};
