// ═══════════════════════════════════════════════════════════════
// SALES ROUTES - Extracted from server.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware: Autenticación JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token inválido o expirado' });
        }
        req.user = user;
        next();
    });
}

module.exports = (pool) => {
    const router = express.Router();

    // GET /api/sales - Lista de ventas (con soporte de timezone)
    // ✅ ACTUALIZADO: Ahora usa tabla 'ventas' con nomenclatura correcta
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false', branch_id, timezone, startDate, endDate } = req.query;

            // Prioridad: 1. branch_id del query, 2. branchId del JWT
            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            // Usar timezone si viene en query, sino usar UTC por defecto
            const userTimezone = timezone || 'UTC';

            let query = `
                SELECT v.id_venta as id, v.ticket_number, v.total as total_amount,
                       v.tipo_pago_id as payment_method, v.fecha_venta_utc as sale_date,
                       v.venta_tipo_id as sale_type, v.id_empleado as employee_id,
                       v.tenant_id, v.branch_id,
                       CONCAT(e.first_name, ' ', e.last_name) as employee_name,
                       r.name as employee_role,
                       b.name as branch_name, b.id as "branchId",
                       ra.id as assignment_id,
                       (v.fecha_venta_utc AT TIME ZONE '${userTimezone}') as sale_date_display
                FROM ventas v
                LEFT JOIN employees e ON v.id_empleado = e.id
                LEFT JOIN roles r ON e.role_id = r.id
                LEFT JOIN branches b ON v.branch_id = b.id
                LEFT JOIN repartidor_assignments ra ON v.id_venta = ra.venta_id
                WHERE v.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

            // Filtrar por branch_id solo si no se solicita ver todas las sucursales
            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND v.branch_id = $${paramIndex}`;
                params.push(targetBranchId);
                paramIndex++;
            }

            // Filtrar por rango de fechas si se proporciona (en timezone del usuario)
            if (startDate || endDate) {
                if (startDate) {
                    query += ` AND (v.fecha_venta_utc AT TIME ZONE '${userTimezone}')::date >= $${paramIndex}::date`;
                    params.push(startDate);
                    paramIndex++;
                }
                if (endDate) {
                    query += ` AND (v.fecha_venta_utc AT TIME ZONE '${userTimezone}')::date <= $${paramIndex}::date`;
                    params.push(endDate);
                    paramIndex++;
                }
            }

            query += ` ORDER BY v.fecha_venta_utc DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            console.log(`[Sales] Fetching sales - Tenant: ${tenantId}, Branch: ${targetBranchId}, Timezone: ${userTimezone}, all_branches: ${all_branches}`);
            console.log(`[Sales] Query: ${query}`);
            console.log(`[Sales] Params: ${JSON.stringify(params)}`);

            const result = await pool.query(query, params);

            console.log(`[Sales] ✅ Ventas encontradas: ${result.rows.length}`);

            // Debug: detectar duplicados en respuesta
            const idCount = {};
            result.rows.forEach(row => {
                idCount[row.id] = (idCount[row.id] || 0) + 1;
            });
            const duplicates = Object.entries(idCount).filter(([_, count]) => count > 1);
            if (duplicates.length > 0) {
                console.log(`[Sales] ⚠️ DUPLICADOS EN RESPUESTA: ${JSON.stringify(duplicates)}`);
                console.log(`[Sales] IDs: ${result.rows.map(r => r.id).join(', ')}`);
            }

            // Normalizar total_amount a número y formatear timestamps en UTC
            const normalizedRows = result.rows.map(row => ({
                ...row,
                total_amount: parseFloat(row.total_amount),
                // Ensure sale_date is always sent as ISO string in UTC (Z suffix)
                sale_date: row.sale_date ? new Date(row.sale_date).toISOString() : null,
                // Convert sale_date_display to ISO string as well
                sale_date_display: row.sale_date_display ? new Date(row.sale_date_display).toISOString() : null
            }));

            res.json({
                success: true,
                data: normalizedRows
            });
        } catch (error) {
            console.error('[Sales] ❌ Error:', error.message);
            console.error('[Sales] SQL Error Code:', error.code);
            console.error('[Sales] Full error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener ventas', error: error.message });
        }
    });

    // ⚠️ ENDPOINT OBSOLETO - Ya no usar (usa tabla 'sales' antigua)
    // Desktop ahora usa POST /api/sales/sync que inserta en tabla 'ventas'
    // App Móvil usa GET /api/ventas para consultas
    /*
    router.post('/', async (req, res) => {
        try {
            const { tenantId, branchId, ticketNumber, totalAmount, paymentMethod, userEmail } = req.body;

            console.log(`[Sales] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, User: ${userEmail}`);
            console.log(`[Sales] Received totalAmount: ${totalAmount} (type: ${typeof totalAmount})`);

            // Validar datos requeridos
            if (!tenantId || !branchId || !ticketNumber || totalAmount === null || totalAmount === undefined) {
                return res.status(400).json({ success: false, message: 'Datos incompletos' });
            }

            // Convertir totalAmount a número si viene como string
            const numericTotalAmount = parseFloat(totalAmount);
            if (isNaN(numericTotalAmount)) {
                return res.status(400).json({ success: false, message: 'totalAmount debe ser un número válido' });
            }

            // Buscar el empleado por email (opcional, para employee_id)
            let employeeId = null;
            if (userEmail) {
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                    [userEmail, tenantId]
                );
                if (empResult.rows.length > 0) {
                    employeeId = empResult.rows[0].id;
                }
            }

            const result = await pool.query(
                `INSERT INTO sales (tenant_id, branch_id, employee_id, ticket_number, total_amount, payment_method)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [tenantId, branchId, employeeId, ticketNumber, numericTotalAmount, paymentMethod]
            );

            console.log(`[Sales] ✅ Venta creada desde Desktop: ${ticketNumber} - $${numericTotalAmount}`);

            // Asegurar que total_amount es un número en la respuesta
            const responseData = result.rows[0];
            if (responseData) {
                responseData.total_amount = parseFloat(responseData.total_amount);
            }

            res.json({ success: true, data: responseData });
        } catch (error) {
            console.error('[Sales] Error:', error);
            res.status(500).json({ success: false, message: 'Error al crear venta' });
        }
    });
    */

    // POST /api/sync/sales - Sincronizar venta desde Desktop
    // 🔴 NUEVO: Ahora usa tabla "ventas" con estructura 1:1 con Desktop
    router.post('/sync', async (req, res) => {
        try {
            // 🔴 NUEVO: Aceptar payload con snake_case (match con Desktop)
            const {
                tenant_id,
                branch_id,
                // ✅ RELACIONES: Todas usan GlobalIds (offline-first completo)
                empleado_global_id,               // GlobalId (empleados pueden crearse offline)
                turno_global_id,                  // GlobalId (turnos se crean offline)
                cliente_global_id,                // GlobalId (clientes se crean offline)
                repartidor_global_id,             // GlobalId (repartidores son empleados)
                turno_repartidor_global_id,       // GlobalId (turnos se crean offline)
                estado_venta_id,
                venta_tipo_id,
                tipo_pago_id,
                ticket_number,
                subtotal,
                total_descuentos,
                total,
                monto_pagado,
                fecha_venta_raw,
                fecha_liquidacion_raw,
                notas,
                // ✅ OFFLINE-FIRST FIELDS
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw
            } = req.body;

            console.log(`[Sync/Sales] 🔄 Sincronizando venta - Tenant: ${tenant_id}, Branch: ${branch_id}, Ticket: ${ticket_number}`);
            console.log(`[Sync/Sales] 🔑 GlobalIds - empleado: ${empleado_global_id}, turno: ${turno_global_id}, cliente: ${cliente_global_id || 'null'}`);
            console.log(`[Sync/Sales] 🔑 Repartidor - global_id: ${repartidor_global_id || 'null'}, turno_global_id: ${turno_repartidor_global_id || 'null'}`);
            console.log(`[Sync/Sales] 💰 Montos - Subtotal: ${subtotal}, Descuentos: ${total_descuentos}, Total: ${total}, Pagado: ${monto_pagado}`);

            // Validar campos requeridos (incluyendo global_id para idempotencia)
            if (!tenant_id || !branch_id || !empleado_global_id || !turno_global_id || !ticket_number || total === null || total === undefined || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, branch_id, empleado_global_id, turno_global_id, ticket_number, total, global_id requeridos)'
                });
            }

            // 🔑 RESOLVER GLOBALIDS A IDs DE POSTGRESQL
            // 1. Resolver empleado (REQUERIDO)
            const employeeResult = await pool.query(
                'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                [empleado_global_id, tenant_id]
            );
            if (employeeResult.rows.length === 0) {
                console.log(`[Sync/Sales] ❌ Empleado no encontrado: ${empleado_global_id}`);
                return res.status(400).json({
                    success: false,
                    message: `Empleado no encontrado con global_id: ${empleado_global_id}`
                });
            }
            const id_empleado = employeeResult.rows[0].id;

            // 2. Resolver turno (REQUERIDO)
            const shiftResult = await pool.query(
                'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                [turno_global_id, tenant_id]
            );
            if (shiftResult.rows.length === 0) {
                console.log(`[Sync/Sales] ❌ Turno no encontrado: ${turno_global_id}`);
                return res.status(400).json({
                    success: false,
                    message: `Turno no encontrado con global_id: ${turno_global_id}`
                });
            }
            const id_turno = shiftResult.rows[0].id;

            // 3. Resolver repartidor asignado (opcional)
            let id_repartidor_asignado = null;
            if (repartidor_global_id) {
                const repartidorResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [repartidor_global_id, tenant_id]
                );
                if (repartidorResult.rows.length > 0) {
                    id_repartidor_asignado = repartidorResult.rows[0].id;
                } else {
                    console.log(`[Sync/Sales] ⚠️ Repartidor no encontrado con global_id: ${repartidor_global_id}`);
                }
            }

            // 4. Resolver cliente (opcional)
            let id_cliente = null;
            if (cliente_global_id) {
                const customerResult = await pool.query(
                    'SELECT id FROM customers WHERE global_id = $1 AND tenant_id = $2',
                    [cliente_global_id, tenant_id]
                );
                if (customerResult.rows.length > 0) {
                    id_cliente = customerResult.rows[0].id;
                } else {
                    console.log(`[Sync/Sales] ⚠️ Cliente no encontrado con global_id: ${cliente_global_id}`);
                }
            }

            // 5. Resolver turno del repartidor (opcional)
            let id_turno_repartidor = null;
            if (turno_repartidor_global_id) {
                const turnoRepartidorResult = await pool.query(
                    'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                    [turno_repartidor_global_id, tenant_id]
                );
                if (turnoRepartidorResult.rows.length > 0) {
                    id_turno_repartidor = turnoRepartidorResult.rows[0].id;
                } else {
                    console.log(`[Sync/Sales] ⚠️ Turno repartidor no encontrado con global_id: ${turno_repartidor_global_id}`);
                }
            }

            console.log(`[Sync/Sales] ✅ IDs resueltos - empleado: ${id_empleado}, turno: ${id_turno}, repartidor: ${id_repartidor_asignado || 'null'}, cliente: ${id_cliente || 'null'}, turno_repartidor: ${id_turno_repartidor || 'null'}`);

            // Convertir montos a números
            const numericSubtotal = parseFloat(subtotal) || 0;
            const numericTotalDescuentos = parseFloat(total_descuentos) || 0;
            const numericTotal = parseFloat(total);
            const numericMontoPagado = parseFloat(monto_pagado) || 0;

            if (isNaN(numericTotal)) {
                return res.status(400).json({ success: false, message: 'total debe ser un número válido' });
            }

            // ✅ Si no hay cliente resuelto, obtener/crear el cliente genérico del tenant
            let finalIdCliente = id_cliente;
            if (!finalIdCliente) {
                const genericResult = await pool.query(
                    'SELECT get_or_create_generic_customer($1, $2) as customer_id',
                    [tenant_id, branch_id]
                );
                finalIdCliente = genericResult.rows[0].customer_id;
                console.log(`[Sync/Sales] ✅ Usando cliente genérico del tenant: ${finalIdCliente}`);
            }

            // ✅ Mapear estado_venta_id a status
            // Desktop: 1=Borrador, 2=Asignada, 3=Completada, 4=Cancelada, 5=Liquidada
            // PostgreSQL: 'completed' o 'cancelled'
            const status = (estado_venta_id === 4) ? 'cancelled' : 'completed';

            // ✅ IDEMPOTENTE: INSERT con ON CONFLICT (global_id) DO UPDATE
            const result = await pool.query(
                `INSERT INTO ventas (
                    tenant_id, branch_id, id_empleado, id_turno,
                    estado_venta_id, venta_tipo_id, tipo_pago_id,
                    id_repartidor_asignado, id_turno_repartidor,
                    ticket_number, id_cliente,
                    subtotal, total_descuentos, total, monto_pagado,
                    fecha_venta_raw, fecha_liquidacion_raw,
                    notas, status,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
                 ON CONFLICT (tenant_id, branch_id, ticket_number, id_turno) DO UPDATE
                 SET subtotal = EXCLUDED.subtotal,
                     total_descuentos = EXCLUDED.total_descuentos,
                     total = EXCLUDED.total,
                     monto_pagado = EXCLUDED.monto_pagado,
                     estado_venta_id = EXCLUDED.estado_venta_id,
                     status = EXCLUDED.status,
                     notas = EXCLUDED.notas,
                     fecha_liquidacion_raw = EXCLUDED.fecha_liquidacion_raw,
                     id_repartidor_asignado = EXCLUDED.id_repartidor_asignado,
                     id_turno_repartidor = EXCLUDED.id_turno_repartidor
                 RETURNING *`,
                [
                    tenant_id,
                    branch_id,
                    id_empleado,
                    id_turno,
                    estado_venta_id || 3,                    // Default: 3=Completada
                    venta_tipo_id || 1,                      // Default: 1=Mostrador
                    tipo_pago_id || 1,                       // Default: 1=Efectivo
                    id_repartidor_asignado || null,
                    id_turno_repartidor || null,
                    ticket_number,
                    finalIdCliente,                          // NULL si el cliente no existe
                    numericSubtotal,
                    numericTotalDescuentos,
                    numericTotal,
                    numericMontoPagado,
                    fecha_venta_raw || null,
                    fecha_liquidacion_raw || null,
                    notas || null,
                    status,                                   // ✅ NUEVO: 'completed' o 'cancelled'
                    global_id,                                // UUID from Desktop
                    terminal_id,                              // UUID from Desktop
                    local_op_seq,                             // Sequence number from Desktop
                    created_local_utc,                        // ISO 8601 timestamp from Desktop
                    device_event_raw                          // Raw .NET ticks from Desktop
                ]
            );

            const insertedVenta = result.rows[0];

            console.log(`[Sync/Sales] ✅ Venta sincronizada exitosamente:`);
            console.log(`[Sync/Sales]    ID: ${insertedVenta.id_venta}`);
            console.log(`[Sync/Sales]    Ticket: ${insertedVenta.ticket_number}`);
            console.log(`[Sync/Sales]    Total: $${insertedVenta.total}`);
            console.log(`[Sync/Sales]    Estado: ${insertedVenta.estado_venta_id}`);
            console.log(`[Sync/Sales]    Tipo: ${insertedVenta.venta_tipo_id}`);

            // Formatear respuesta (Desktop espera "data.id_venta")
            res.json({
                success: true,
                data: {
                    id_venta: insertedVenta.id_venta,
                    ticket_number: insertedVenta.ticket_number,
                    total: parseFloat(insertedVenta.total),
                    fecha_venta_utc: insertedVenta.fecha_venta_utc,
                    created_at: insertedVenta.created_at
                }
            });
        } catch (error) {
            console.error('[Sync/Sales] ❌ Error:', error);
            console.error('[Sync/Sales] Error detalle:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar venta',
                error: error.message
            });
        }
    });

    // POST /api/sync/sales-items - Sincronizar líneas de venta (VentasDetalle)
    router.post('/sync-items', async (req, res) => {
        try {
            const { tenantId, branchId, saleId, items } = req.body;

            console.log(`[Sync/SalesItems] 📦 Sincronizando ${items?.length || 0} líneas para venta ${saleId}`);

            if (!tenantId || !branchId || !saleId || !Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, saleId, items requeridos)' });
            }

            // Borrar líneas existentes (en caso de actualización)
            await pool.query('DELETE FROM sales_items WHERE sale_id = $1', [saleId]);

            // Insertar nuevas líneas
            const insertedItems = [];
            for (const item of items) {
                try {
                    const result = await pool.query(
                        `INSERT INTO sales_items (
                            tenant_id, branch_id, sale_id, product_id, product_name,
                            quantity, unit_price, list_price,
                            customer_discount, manual_discount, total_discount, subtotal
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                        RETURNING *`,
                        [
                            tenantId,
                            branchId,
                            saleId,
                            item.product_id || null,
                            item.product_name || '',
                            parseFloat(item.quantity) || 0,
                            parseFloat(item.unit_price) || 0,
                            parseFloat(item.list_price) || 0,
                            parseFloat(item.customer_discount) || 0,
                            parseFloat(item.manual_discount) || 0,
                            parseFloat(item.total_discount) || 0,
                            parseFloat(item.subtotal) || 0
                        ]
                    );
                    insertedItems.push(result.rows[0]);
                } catch (itemError) {
                    console.error(`[Sync/SalesItems] ⚠️ Error insertando línea:`, itemError.message);
                }
            }

            console.log(`[Sync/SalesItems] ✅ ${insertedItems.length}/${items.length} líneas sincronizadas para venta ${saleId}`);

            res.json({ success: true, data: insertedItems });
        } catch (error) {
            console.error('[Sync/SalesItems] Error:', error);
            res.status(500).json({ success: false, message: 'Error al sincronizar líneas de venta', error: error.message });
        }
    });

    // GET /api/sales-items - Obtener artículos por venta específica
    router.get('/items', async (req, res) => {
        try {
            const { sale_id, tenant_id, branch_id } = req.query;

            if (!sale_id || !tenant_id || !branch_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: sale_id, tenant_id, branch_id'
                });
            }

            const result = await pool.query(
                `SELECT * FROM sales_items_with_details
                 WHERE sale_id = $1 AND tenant_id = $2 AND branch_id = $3
                 ORDER BY created_at ASC`,
                [parseInt(sale_id), parseInt(tenant_id), parseInt(branch_id)]
            );

            // Convertir amounts a números
            const items = result.rows.map(row => ({
                ...row,
                quantity: parseFloat(row.quantity),
                unit_price: parseFloat(row.unit_price),
                list_price: parseFloat(row.list_price),
                customer_discount: parseFloat(row.customer_discount),
                manual_discount: parseFloat(row.manual_discount),
                total_discount: parseFloat(row.total_discount),
                subtotal: parseFloat(row.subtotal),
                total_amount: row.total_amount ? parseFloat(row.total_amount) : null
            }));

            res.json({ data: items });
        } catch (error) {
            console.error('[SalesItems/GetBySale] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener artículos de venta', error: error.message });
        }
    });

    // GET /api/sales-items/branch - Obtener artículos de una sucursal con paginación
    router.get('/items/branch', async (req, res) => {
        try {
            const { tenant_id, branch_id, limit = 1000, offset = 0 } = req.query;

            if (!tenant_id || !branch_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: tenant_id, branch_id'
                });
            }

            const result = await pool.query(
                `SELECT * FROM sales_items_with_details
                 WHERE tenant_id = $1 AND branch_id = $2
                 ORDER BY created_at DESC
                 LIMIT $3 OFFSET $4`,
                [parseInt(tenant_id), parseInt(branch_id), parseInt(limit), parseInt(offset)]
            );

            // Convertir amounts a números
            const items = result.rows.map(row => ({
                ...row,
                quantity: parseFloat(row.quantity),
                unit_price: parseFloat(row.unit_price),
                list_price: parseFloat(row.list_price),
                customer_discount: parseFloat(row.customer_discount),
                manual_discount: parseFloat(row.manual_discount),
                total_discount: parseFloat(row.total_discount),
                subtotal: parseFloat(row.subtotal),
                total_amount: row.total_amount ? parseFloat(row.total_amount) : null
            }));

            res.json({ data: items });
        } catch (error) {
            console.error('[SalesItems/GetByBranch] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener artículos por sucursal', error: error.message });
        }
    });

    // GET /api/sales-items/by-type - Obtener artículos filtrados por tipo de venta
    router.get('/items/by-type', async (req, res) => {
        try {
            const { tenant_id, branch_id, sale_type, limit = 1000 } = req.query;

            if (!tenant_id || !branch_id || !sale_type) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: tenant_id, branch_id, sale_type'
                });
            }

            // Mapear sale_type string a sale_type_code
            const saleTypeCode = sale_type.toLowerCase();

            const result = await pool.query(
                `SELECT * FROM sales_items_with_details
                 WHERE tenant_id = $1 AND branch_id = $2
                 AND LOWER(sale_type_name) LIKE LOWER($3)
                 ORDER BY created_at DESC
                 LIMIT $4`,
                [parseInt(tenant_id), parseInt(branch_id), `%${saleTypeCode}%`, parseInt(limit)]
            );

            // Convertir amounts a números
            const items = result.rows.map(row => ({
                ...row,
                quantity: parseFloat(row.quantity),
                unit_price: parseFloat(row.unit_price),
                list_price: parseFloat(row.list_price),
                customer_discount: parseFloat(row.customer_discount),
                manual_discount: parseFloat(row.manual_discount),
                total_discount: parseFloat(row.total_discount),
                subtotal: parseFloat(row.subtotal),
                total_amount: row.total_amount ? parseFloat(row.total_amount) : null
            }));

            res.json({ data: items });
        } catch (error) {
            console.error('[SalesItems/GetByType] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener artículos por tipo de venta', error: error.message });
        }
    });

    // GET /api/sales-items/by-payment - Obtener artículos filtrados por tipo de pago
    router.get('/items/by-payment', async (req, res) => {
        try {
            const { tenant_id, branch_id, payment_type, limit = 1000 } = req.query;

            if (!tenant_id || !branch_id || !payment_type) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: tenant_id, branch_id, payment_type'
                });
            }

            // Mapear payment_type string a payment_type_code
            const paymentTypeCode = payment_type.toLowerCase();

            const result = await pool.query(
                `SELECT * FROM sales_items_with_details
                 WHERE tenant_id = $1 AND branch_id = $2
                 AND LOWER(payment_type_name) LIKE LOWER($3)
                 ORDER BY created_at DESC
                 LIMIT $4`,
                [parseInt(tenant_id), parseInt(branch_id), `%${paymentTypeCode}%`, parseInt(limit)]
            );

            // Convertir amounts a números
            const items = result.rows.map(row => ({
                ...row,
                quantity: parseFloat(row.quantity),
                unit_price: parseFloat(row.unit_price),
                list_price: parseFloat(row.list_price),
                customer_discount: parseFloat(row.customer_discount),
                manual_discount: parseFloat(row.manual_discount),
                total_discount: parseFloat(row.total_discount),
                subtotal: parseFloat(row.subtotal),
                total_amount: row.total_amount ? parseFloat(row.total_amount) : null
            }));

            res.json({ data: items });
        } catch (error) {
            console.error('[SalesItems/GetByPayment] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener artículos por tipo de pago', error: error.message });
        }
    });

    // GET /api/sales-items/stats - Obtener estadísticas de artículos vendidos
    router.get('/items/stats', async (req, res) => {
        try {
            const { tenant_id, branch_id } = req.query;

            if (!tenant_id || !branch_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: tenant_id, branch_id'
                });
            }

            const result = await pool.query(
                `SELECT
                    COUNT(*) as total_items,
                    COUNT(DISTINCT sale_id) as total_sales,
                    SUM(quantity) as total_quantity,
                    SUM(subtotal) as total_revenue,
                    SUM(total_discount) as total_discounts,
                    AVG(subtotal) as avg_item_price,
                    MAX(created_at) as last_sale_date
                 FROM sales_items
                 WHERE tenant_id = $1 AND branch_id = $2`,
                [parseInt(tenant_id), parseInt(branch_id)]
            );

            const stats = result.rows[0] || {};

            // Convertir amounts a números
            const formattedStats = {
                total_items: parseInt(stats.total_items) || 0,
                total_sales: parseInt(stats.total_sales) || 0,
                total_quantity: parseFloat(stats.total_quantity) || 0,
                total_revenue: parseFloat(stats.total_revenue) || 0,
                total_discounts: parseFloat(stats.total_discounts) || 0,
                avg_item_price: parseFloat(stats.avg_item_price) || 0,
                last_sale_date: stats.last_sale_date
            };

            res.json(formattedStats);
        } catch (error) {
            console.error('[SalesItems/GetStats] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener estadísticas', error: error.message });
        }
    });

    // PUT /api/sync/sales/:globalId - Actualizar venta existente (liquidación, cancelación)
    // ⚠️ Sin authenticateToken para permitir sync offline-first desde Desktop
    // El tenant_id en el payload valida que solo puede actualizar sus propias ventas
    router.put('/sync/:globalId', async (req, res) => {
        try {
            const { globalId } = req.params;
            const {
                tenant_id,
                branch_id,
                estado_venta_id,
                fecha_liquidacion_raw,
                monto_pagado,
                total,
                subtotal,
                tipo_pago_id,
                // ✅ RELACIONES: Todas usan GlobalIds (offline-first completo)
                repartidor_global_id,             // GlobalId (empleados pueden crearse offline)
                turno_repartidor_global_id,       // GlobalId (turnos se crean offline)
                notas
            } = req.body;

            console.log(`[Sync/Sales/Update] 🔄 Actualizando venta GlobalId: ${globalId}`);
            console.log(`[Sync/Sales/Update] 📊 Estado: ${estado_venta_id}, Total: ${total}, Pagado: ${monto_pagado}`);
            console.log(`[Sync/Sales/Update] 🔑 GlobalIds - repartidor: ${repartidor_global_id || 'null'}, turno_repartidor: ${turno_repartidor_global_id || 'null'}`);

            // Verificar que la venta existe
            const existingVenta = await pool.query(
                'SELECT id_venta FROM ventas WHERE global_id = $1 AND tenant_id = $2',
                [globalId, tenant_id]
            );

            if (existingVenta.rows.length === 0) {
                console.log(`[Sync/Sales/Update] ❌ Venta no encontrada: ${globalId}`);
                return res.status(404).json({
                    success: false,
                    message: 'Venta no encontrada'
                });
            }

            const ventaId = existingVenta.rows[0].id_venta;

            // 🔑 RESOLVER GLOBALIDS A IDs DE POSTGRESQL
            // 1. Resolver repartidor asignado (opcional)
            let id_repartidor_asignado = null;
            if (repartidor_global_id) {
                const repartidorResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [repartidor_global_id, tenant_id]
                );
                if (repartidorResult.rows.length > 0) {
                    id_repartidor_asignado = repartidorResult.rows[0].id;
                } else {
                    console.log(`[Sync/Sales/Update] ⚠️ Repartidor no encontrado con global_id: ${repartidor_global_id}`);
                }
            }

            // 2. Resolver turno del repartidor (opcional)
            let id_turno_repartidor = null;
            if (turno_repartidor_global_id) {
                const turnoRepartidorResult = await pool.query(
                    'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                    [turno_repartidor_global_id, tenant_id]
                );
                if (turnoRepartidorResult.rows.length > 0) {
                    id_turno_repartidor = turnoRepartidorResult.rows[0].id;
                } else {
                    console.log(`[Sync/Sales/Update] ⚠️ Turno repartidor no encontrado con global_id: ${turno_repartidor_global_id}`);
                }
            }

            console.log(`[Sync/Sales/Update] ✅ IDs resueltos - repartidor: ${id_repartidor_asignado || 'null'}, turno_repartidor: ${id_turno_repartidor || 'null'}`);

            // Actualizar venta con campos modificables
            const result = await pool.query(
                `UPDATE ventas
                 SET estado_venta_id = $1,
                     fecha_liquidacion_raw = $2,
                     monto_pagado = $3,
                     total = $4,
                     subtotal = $5,
                     tipo_pago_id = $6,
                     id_repartidor_asignado = $7,
                     id_turno_repartidor = $8,
                     notas = $9,
                     status = CASE WHEN $1 = 4 THEN 'cancelled' ELSE 'completed' END,
                     updated_at = NOW()
                 WHERE global_id = $10 AND tenant_id = $11
                 RETURNING *`,
                [
                    estado_venta_id,
                    fecha_liquidacion_raw,
                    monto_pagado,
                    total,
                    subtotal,
                    tipo_pago_id,
                    id_repartidor_asignado,
                    id_turno_repartidor,
                    notas,
                    globalId,
                    tenant_id
                ]
            );

            if (result.rows.length === 0) {
                console.log(`[Sync/Sales/Update] ❌ Error al actualizar venta ${globalId}`);
                return res.status(500).json({
                    success: false,
                    message: 'Error al actualizar venta'
                });
            }

            const updatedVenta = result.rows[0];

            console.log(`[Sync/Sales/Update] ✅ Venta actualizada exitosamente:`);
            console.log(`[Sync/Sales/Update]    ID: ${updatedVenta.id_venta}`);
            console.log(`[Sync/Sales/Update]    Estado: ${updatedVenta.estado_venta_id}`);
            console.log(`[Sync/Sales/Update]    Total: $${updatedVenta.total}`);

            res.json({
                success: true,
                message: 'Venta actualizada exitosamente',
                venta_id: updatedVenta.id_venta,
                estado: updatedVenta.estado_venta_id
            });

        } catch (error) {
            console.error('[Sync/Sales/Update] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar venta',
                error: error.message
            });
        }
    });

    return router;
};
