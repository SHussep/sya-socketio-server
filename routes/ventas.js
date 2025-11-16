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
    router.get('/:id', async (req, res) => {
        try {
            const { id } = req.params;
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

    return router;
};
