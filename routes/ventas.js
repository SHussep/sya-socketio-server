// ═══════════════════════════════════════════════════════════════
// VENTAS API - Para consultas desde App Móvil
// ═══════════════════════════════════════════════════════════════
// Este archivo maneja CONSULTAS (GET) de ventas para la app móvil.
// La sincronización desde Desktop sigue usando /api/sales/sync
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

module.exports = function(pool) {

    // ─────────────────────────────────────────────────────────
    // GET /api/ventas - Listar ventas de una sucursal
    // Query params: tenantId, branchId, shiftId (opcional), fecha_desde, fecha_hasta
    // ─────────────────────────────────────────────────────────
    router.get('/', async (req, res) => {
        try {
            const { tenantId, branchId, shiftId, fecha_desde, fecha_hasta, limit = 50, offset = 0 } = req.query;

            if (!tenantId || !branchId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId y branchId son requeridos'
                });
            }

            let query = `
                SELECT
                    v.id_venta,
                    v.ticket_number,
                    v.total,
                    v.subtotal,
                    v.total_descuentos,
                    v.monto_pagado,
                    v.estado_venta_id,
                    v.venta_tipo_id,
                    v.tipo_pago_id,
                    v.fecha_venta_utc,
                    v.fecha_liquidacion_utc,
                    v.notas,
                    v.id_turno,
                    v.id_empleado,
                    v.id_cliente,
                    v.id_repartidor_asignado,
                    CONCAT(e.first_name, ' ', e.last_name) as empleado_nombre,
                    c.nombre as cliente_nombre,
                    CONCAT(r.first_name, ' ', r.last_name) as repartidor_nombre,
                    v.created_at
                FROM ventas v
                LEFT JOIN employees e ON v.id_empleado = e.id
                LEFT JOIN customers c ON v.id_cliente = c.id
                LEFT JOIN employees r ON v.id_repartidor_asignado = r.id
                WHERE v.tenant_id = $1 AND v.branch_id = $2
            `;

            const params = [parseInt(tenantId), parseInt(branchId)];
            let paramIndex = 3;

            if (shiftId) {
                query += ` AND v.id_turno = $${paramIndex}`;
                params.push(parseInt(shiftId));
                paramIndex++;
            }

            if (fecha_desde) {
                query += ` AND v.fecha_venta_utc >= $${paramIndex}`;
                params.push(fecha_desde);
                paramIndex++;
            }

            if (fecha_hasta) {
                query += ` AND v.fecha_venta_utc <= $${paramIndex}`;
                params.push(fecha_hasta);
                paramIndex++;
            }

            query += ` ORDER BY v.fecha_venta_utc DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length,
                limit: parseInt(limit),
                offset: parseInt(offset)
            });

        } catch (error) {
            console.error('[Ventas API] Error en GET /:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener ventas',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/ventas/:id - Obtener detalle de una venta específica
    // ─────────────────────────────────────────────────────────
    router.get('/:id', async (req, res, next) => {
        try {
            const { id } = req.params;

            // Si el id no es un número, pasar al siguiente handler (ej: /pull, /turno)
            if (isNaN(parseInt(id))) {
                return next('route');
            }

            const { tenantId, branchId } = req.query;

            if (!tenantId || !branchId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId y branchId son requeridos'
                });
            }

            // Obtener venta principal
            const ventaResult = await pool.query(`
                SELECT
                    v.id_venta,
                    v.ticket_number,
                    v.total,
                    v.subtotal,
                    v.total_descuentos,
                    v.monto_pagado,
                    v.estado_venta_id,
                    v.venta_tipo_id,
                    v.tipo_pago_id,
                    v.fecha_venta_utc,
                    v.fecha_liquidacion_utc,
                    v.notas,
                    v.id_turno,
                    v.id_empleado,
                    v.id_cliente,
                    v.id_repartidor_asignado,
                    CONCAT(e.first_name, ' ', e.last_name) as empleado_nombre,
                    c.nombre as cliente_nombre,
                    c.direccion as cliente_direccion,
                    c.telefono as cliente_telefono,
                    CONCAT(r.first_name, ' ', r.last_name) as repartidor_nombre,
                    v.created_at
                FROM ventas v
                LEFT JOIN employees e ON v.id_empleado = e.id
                LEFT JOIN customers c ON v.id_cliente = c.id
                LEFT JOIN employees r ON v.id_repartidor_asignado = r.id
                WHERE v.id_venta = $1 AND v.tenant_id = $2 AND v.branch_id = $3
            `, [parseInt(id), parseInt(tenantId), parseInt(branchId)]);

            if (ventaResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Venta no encontrada'
                });
            }

            const venta = ventaResult.rows[0];

            // Obtener detalles (líneas de venta)
            const detallesResult = await pool.query(`
                SELECT
                    vd.id_venta_detalle,
                    vd.id_producto,
                    vd.descripcion_producto,
                    vd.cantidad,
                    vd.precio_unitario,
                    vd.precio_lista,
                    vd.total_linea,
                    vd.monto_cliente_descuento,
                    vd.monto_manual_descuento
                FROM ventas_detalle vd
                WHERE vd.id_venta = $1
                ORDER BY vd.created_at ASC
            `, [parseInt(id)]);

            venta.detalles = detallesResult.rows;

            res.json({
                success: true,
                data: venta
            });

        } catch (error) {
            console.error('[Ventas API] Error en GET /:id:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener venta',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/ventas/turno/:shiftId - Obtener ventas de un turno
    // ─────────────────────────────────────────────────────────
    router.get('/turno/:shiftId', async (req, res) => {
        try {
            const { shiftId } = req.params;
            const { tenantId, branchId } = req.query;

            if (!tenantId || !branchId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId y branchId son requeridos'
                });
            }

            const result = await pool.query(`
                SELECT
                    v.id_venta,
                    v.ticket_number,
                    v.total,
                    v.subtotal,
                    v.total_descuentos,
                    v.estado_venta_id,
                    v.venta_tipo_id,
                    v.tipo_pago_id,
                    v.fecha_venta_utc,
                    v.notas,
                    CONCAT(e.first_name, ' ', e.last_name) as empleado_nombre,
                    c.nombre as cliente_nombre
                FROM ventas v
                LEFT JOIN employees e ON v.id_empleado = e.id
                LEFT JOIN customers c ON v.id_cliente = c.id
                WHERE v.id_turno = $1 AND v.tenant_id = $2 AND v.branch_id = $3
                ORDER BY v.fecha_venta_utc DESC
            `, [parseInt(shiftId), parseInt(tenantId), parseInt(branchId)]);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });

        } catch (error) {
            console.error('[Ventas API] Error en GET /turno/:shiftId:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener ventas del turno',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/ventas/pull - Descargar ventas para sincronización bidireccional
    // ═══════════════════════════════════════════════════════════════════════════
    // Este endpoint permite a Desktop descargar ventas creadas desde Flutter/Móvil.
    // Retorna ventas modificadas desde una fecha dada, con GlobalIds para resolver
    // relaciones localmente (empleados, clientes, turnos).
    //
    // Query params:
    //   - tenantId (requerido)
    //   - branchId (requerido)
    //   - since (opcional): ISO timestamp - solo ventas modificadas después de esta fecha
    //   - limit (opcional): máximo de registros (default 500)
    //
    // Respuesta incluye:
    //   - ventas: array con todas las ventas y sus GlobalIds
    //   - detalles: array con todos los detalles de venta
    //   - last_sync: timestamp del servidor para próximo pull
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/pull', async (req, res) => {
        try {
            const { tenantId, branchId, since, limit = 500 } = req.query;

            const tenantIdNum = parseInt(tenantId);
            const branchIdNum = parseInt(branchId);

            if (!tenantId || !branchId || isNaN(tenantIdNum) || isNaN(branchIdNum)) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId y branchId son requeridos y deben ser números válidos'
                });
            }

            console.log(`[Ventas/Pull] 📥 Descargando ventas - Tenant: ${tenantIdNum}, Branch: ${branchIdNum}, Since: ${since || 'ALL'}`);

            // Construir query base con JOINs para obtener GlobalIds
            let query = `
                SELECT
                    v.id_venta,
                    v.global_id,
                    v.tenant_id,
                    v.branch_id,
                    v.ticket_number,
                    v.subtotal,
                    v.total_descuentos,
                    v.total,
                    v.monto_pagado,
                    v.credito_original,
                    v.estado_venta_id,
                    v.venta_tipo_id,
                    v.tipo_pago_id,
                    v.fecha_venta_utc,
                    v.fecha_liquidacion_utc,
                    v.notas,
                    v.terminal_id,
                    v.local_op_seq,
                    v.created_local_utc,
                    v.created_at,
                    v.updated_at,
                    -- GlobalIds para resolver relaciones en Desktop
                    e.global_id as empleado_global_id,
                    CONCAT(e.first_name, ' ', e.last_name) as empleado_nombre,
                    c.global_id as cliente_global_id,
                    c.nombre as cliente_nombre,
                    s.global_id as turno_global_id,
                    r.global_id as repartidor_global_id,
                    CONCAT(r.first_name, ' ', r.last_name) as repartidor_nombre,
                    sr.global_id as turno_repartidor_global_id
                FROM ventas v
                LEFT JOIN employees e ON v.id_empleado = e.id
                LEFT JOIN customers c ON v.id_cliente = c.id
                LEFT JOIN shifts s ON v.id_turno = s.id
                LEFT JOIN employees r ON v.id_repartidor_asignado = r.id
                LEFT JOIN shifts sr ON v.id_turno_repartidor = sr.id
                WHERE v.tenant_id = $1 AND v.branch_id = $2
            `;

            const params = [tenantIdNum, branchIdNum];
            let paramIndex = 3;

            // Filtrar por fecha de modificación si se proporciona 'since'
            if (since) {
                query += ` AND v.updated_at > $${paramIndex}`;
                params.push(since);
                paramIndex++;
            }

            const limitNum = parseInt(limit) || 500;
            query += ` ORDER BY v.updated_at ASC LIMIT $${paramIndex}`;
            params.push(limitNum);

            const ventasResult = await pool.query(query, params);
            console.log(`[Ventas/Pull] 📦 Encontradas ${ventasResult.rows.length} ventas`);

            // Si hay ventas, obtener sus detalles
            let detalles = [];
            if (ventasResult.rows.length > 0) {
                const ventaIds = ventasResult.rows.map(v => v.id_venta);

                const detallesResult = await pool.query(`
                    SELECT
                        vd.id_venta_detalle,
                        vd.id_venta,
                        vd.id_producto,
                        vd.descripcion_producto,
                        vd.cantidad,
                        vd.precio_unitario,
                        vd.precio_lista,
                        vd.total_linea,
                        vd.monto_cliente_descuento,
                        vd.monto_manual_descuento,
                        vd.global_id,
                        vd.created_at,
                        -- GlobalId del producto para resolver en Desktop
                        p.global_id as producto_global_id
                    FROM ventas_detalle vd
                    LEFT JOIN productos p ON vd.id_producto = p.id
                    WHERE vd.id_venta = ANY($1)
                    ORDER BY vd.id_venta, vd.created_at ASC
                `, [ventaIds]);

                detalles = detallesResult.rows;
                console.log(`[Ventas/Pull] 📦 Encontrados ${detalles.length} detalles de venta`);
            }

            // Timestamp del servidor para próximo pull
            const serverTimestamp = new Date().toISOString();

            res.json({
                success: true,
                data: {
                    ventas: ventasResult.rows,
                    detalles: detalles,
                    last_sync: serverTimestamp
                },
                count: ventasResult.rows.length,
                detalles_count: detalles.length
            });

        } catch (error) {
            console.error('[Ventas/Pull] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al descargar ventas',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // POST /api/ventas - Crear venta desde Flutter/Móvil (Online POS)
    // ═══════════════════════════════════════════════════════════════════════════
    // Este endpoint permite crear ventas directamente desde la app móvil.
    // A diferencia de /api/sales/sync (Desktop), este endpoint:
    //   - Genera el global_id en el servidor si no se proporciona
    //   - No requiere todos los campos offline-first
    //   - Ideal para dispositivos siempre conectados
    // ═══════════════════════════════════════════════════════════════════════════
    router.post('/', async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                empleado_global_id,
                turno_global_id,
                cliente_global_id,
                estado_venta_id = 3, // Default: Completada (venta de mostrador)
                venta_tipo_id = 1,   // Default: Mostrador
                tipo_pago_id = 1,    // Default: Efectivo
                ticket_number,
                subtotal,
                total_descuentos = 0,
                total,
                monto_pagado,
                notas,
                // Detalles de la venta
                items = [],
                // Opcional: global_id (si viene de offline-first)
                global_id
            } = req.body;

            console.log(`[Ventas/Create] 🛒 Creando venta desde móvil - Tenant: ${tenant_id}, Branch: ${branch_id}, Ticket: ${ticket_number}`);

            // Validar campos requeridos
            if (!tenant_id || !branch_id || !empleado_global_id || !turno_global_id || !ticket_number || total === null || total === undefined) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, branch_id, empleado_global_id, turno_global_id, ticket_number, total requeridos)'
                });
            }

            // Resolver empleado
            const employeeResult = await pool.query(
                'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                [empleado_global_id, tenant_id]
            );
            if (employeeResult.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: `Empleado no encontrado con global_id: ${empleado_global_id}`
                });
            }
            const id_empleado = employeeResult.rows[0].id;

            // Resolver turno
            const shiftResult = await pool.query(
                'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                [turno_global_id, tenant_id]
            );
            if (shiftResult.rows.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: `Turno no encontrado con global_id: ${turno_global_id}`
                });
            }
            const id_turno = shiftResult.rows[0].id;

            // Resolver cliente (opcional)
            let id_cliente = null;
            if (cliente_global_id) {
                const customerResult = await pool.query(
                    'SELECT id FROM customers WHERE global_id = $1 AND tenant_id = $2',
                    [cliente_global_id, tenant_id]
                );
                if (customerResult.rows.length > 0) {
                    id_cliente = customerResult.rows[0].id;
                }
            }

            // Si no hay cliente, usar el genérico
            if (!id_cliente) {
                const genericResult = await pool.query(
                    'SELECT get_or_create_generic_customer($1, $2) as customer_id',
                    [tenant_id, branch_id]
                );
                id_cliente = genericResult.rows[0].customer_id;
            }

            // Generar global_id si no viene
            const finalGlobalId = global_id || require('crypto').randomUUID();

            // Iniciar transacción
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Insertar venta
                const insertResult = await client.query(`
                    INSERT INTO ventas (
                        tenant_id, branch_id, id_empleado, id_turno, id_cliente,
                        estado_venta_id, venta_tipo_id, tipo_pago_id,
                        ticket_number, subtotal, total_descuentos, total, monto_pagado,
                        credito_original, notas, global_id,
                        terminal_id, fecha_venta_utc, created_local_utc
                    ) VALUES (
                        $1, $2, $3, $4, $5,
                        $6, $7, $8,
                        $9, $10, $11, $12, $13,
                        $14, $15, $16,
                        'MOBILE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                    )
                    ON CONFLICT (global_id) DO UPDATE SET
                        estado_venta_id = EXCLUDED.estado_venta_id,
                        monto_pagado = EXCLUDED.monto_pagado,
                        updated_at = CURRENT_TIMESTAMP
                    RETURNING id_venta, global_id
                `, [
                    tenant_id, branch_id, id_empleado, id_turno, id_cliente,
                    estado_venta_id, venta_tipo_id, tipo_pago_id,
                    ticket_number,
                    parseFloat(subtotal) || 0,
                    parseFloat(total_descuentos) || 0,
                    parseFloat(total),
                    parseFloat(monto_pagado) || parseFloat(total),
                    tipo_pago_id === 3 ? parseFloat(total) : 0, // credito_original
                    notas || null,
                    finalGlobalId
                ]);

                const newVenta = insertResult.rows[0];
                console.log(`[Ventas/Create] ✅ Venta creada: ID=${newVenta.id_venta}, GlobalId=${newVenta.global_id}`);

                // Insertar detalles si vienen
                if (items && items.length > 0) {
                    for (const item of items) {
                        // Resolver producto
                        let id_producto = item.id_producto;
                        if (item.producto_global_id && !id_producto) {
                            const prodResult = await client.query(
                                'SELECT id FROM productos WHERE global_id = $1',
                                [item.producto_global_id]
                            );
                            if (prodResult.rows.length > 0) {
                                id_producto = prodResult.rows[0].id;
                            }
                        }

                        await client.query(`
                            INSERT INTO ventas_detalle (
                                id_venta, id_producto, descripcion_producto,
                                cantidad, precio_unitario, precio_lista, total_linea,
                                monto_cliente_descuento, monto_manual_descuento,
                                global_id
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                            ON CONFLICT (global_id) DO NOTHING
                        `, [
                            newVenta.id_venta,
                            id_producto,
                            item.descripcion_producto || item.nombre_producto,
                            parseFloat(item.cantidad) || 0,
                            parseFloat(item.precio_unitario) || 0,
                            parseFloat(item.precio_lista) || parseFloat(item.precio_unitario) || 0,
                            parseFloat(item.total_linea) || 0,
                            parseFloat(item.monto_cliente_descuento) || 0,
                            parseFloat(item.monto_manual_descuento) || 0,
                            item.global_id || require('crypto').randomUUID()
                        ]);
                    }
                    console.log(`[Ventas/Create] ✅ ${items.length} detalles insertados`);
                }

                await client.query('COMMIT');

                res.status(201).json({
                    success: true,
                    message: 'Venta creada exitosamente',
                    data: {
                        id_venta: newVenta.id_venta,
                        global_id: newVenta.global_id,
                        ticket_number: ticket_number
                    }
                });

            } catch (txError) {
                await client.query('ROLLBACK');
                throw txError;
            } finally {
                client.release();
            }

        } catch (error) {
            console.error('[Ventas/Create] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al crear venta',
                error: error.message
            });
        }
    });

    return router;
};
