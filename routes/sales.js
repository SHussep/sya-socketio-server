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
    // ✅ Por defecto solo muestra ventas COBRADAS (estado 3=Completada, 5=Liquidada)
    //    Usar include_pending=true para incluir asignadas (estado 2)
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false', branch_id, timezone, startDate, endDate, shift_id, include_pending = 'false' } = req.query;

            // Prioridad: 1. branch_id del query, 2. branchId del JWT
            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            // Usar timezone si viene en query, sino usar UTC por defecto
            const userTimezone = timezone || 'UTC';

            // ✅ FILTRO DE ESTADOS:
            // - Por defecto: solo ventas COBRADAS (3=Completada, 5=Liquidada)
            // - Con include_pending=true: incluye asignadas (2) para monitoreo
            // - Siempre excluye: 1=Borrador, 4=Cancelada
            const estadoFilter = include_pending === 'true'
                ? 'v.estado_venta_id IN (2, 3, 5)'  // Asignada + Completada + Liquidada
                : 'v.estado_venta_id IN (3, 5)';    // Solo Completada + Liquidada (cobradas)

            // ✅ FIX: Usar subconsulta para assignment_id en lugar de LEFT JOIN
            // Esto evita duplicados cuando una venta tiene múltiples asignaciones
            // (asignar, devolver, reasignar). Obtiene la asignación más reciente.
            let query = `
                SELECT v.id_venta as id, v.ticket_number, v.total as total_amount,
                       v.tipo_pago_id as payment_method, v.fecha_venta_utc as sale_date,
                       v.venta_tipo_id as sale_type, v.id_empleado as employee_id,
                       v.estado_venta_id, v.status,
                       v.tenant_id, v.branch_id, v.id_turno as shift_id,
                       v.has_nota_credito,
                       -- Payment breakdown for mixed payments
                       v.cash_amount, v.card_amount, v.credit_amount,
                       CONCAT(e.first_name, ' ', e.last_name) as employee_name,
                       r.name as employee_role,
                       b.name as branch_name, b.id as "branchId",
                       -- Customer name
                       c.nombre as customer_name,
                       (SELECT ra.id FROM repartidor_assignments ra
                        WHERE ra.venta_id = v.id_venta
                        ORDER BY ra.created_at DESC LIMIT 1) as assignment_id,
                       (v.fecha_venta_utc AT TIME ZONE '${userTimezone}') as sale_date_display,
                       -- Items summary: quantities grouped by unit of measure
                       items_agg.items_summary
                FROM ventas v
                LEFT JOIN employees e ON v.id_empleado = e.id
                LEFT JOIN roles r ON e.role_id = r.id
                LEFT JOIN branches b ON v.branch_id = b.id
                LEFT JOIN customers c ON v.id_cliente = c.id
                LEFT JOIN LATERAL (
                    SELECT json_agg(json_build_object('unit', sub.unit, 'qty', sub.total_qty) ORDER BY sub.total_qty DESC) as items_summary
                    FROM (
                        SELECT COALESCE(um.abbreviation, 'kg') as unit, SUM(vd.cantidad) as total_qty
                        FROM ventas_detalle vd
                        LEFT JOIN productos p ON vd.id_producto = p.id AND p.tenant_id = v.tenant_id
                        LEFT JOIN units_of_measure um ON p.unidad_medida_id = um.id
                        WHERE vd.id_venta = v.id_venta
                        GROUP BY COALESCE(um.abbreviation, 'kg')
                    ) sub
                ) items_agg ON true
                WHERE v.tenant_id = $1 AND ${estadoFilter}
            `;

            const params = [tenantId];
            let paramIndex = 2;

            // Filtrar por branch_id solo si no se solicita ver todas las sucursales
            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND v.branch_id = $${paramIndex}`;
                params.push(targetBranchId);
                paramIndex++;
            }

            // 🆕 Filtrar por shift_id (usando id_turno en la tabla ventas)
            if (shift_id) {
                query += ` AND v.id_turno = $${paramIndex}`;
                params.push(parseInt(shift_id));
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

            console.log(`[Sales] Fetching sales - Tenant: ${tenantId}, Branch: ${targetBranchId}, Shift: ${shift_id || 'ALL'}, Timezone: ${userTimezone}, all_branches: ${all_branches}`);
            console.log(`[Sales] Query: ${query}`);
            console.log(`[Sales] Params: ${JSON.stringify(params)}`);

            const result = await pool.query(query, params);

            console.log(`[Sales] ✅ Ventas encontradas: ${result.rows.length}`);
            console.log(`[Sales] 🔍 Shift IDs: ${result.rows.map(r => `ID ${r.id}:shift_${r.shift_id ?? 'NULL'}`).join(', ')}`);

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

            // Normalizar total_amount y payment breakdown a números, formatear timestamps en UTC
            const normalizedRows = result.rows.map(row => ({
                ...row,
                total_amount: parseFloat(row.total_amount),
                // Payment breakdown as numbers
                cash_amount: row.cash_amount ? parseFloat(row.cash_amount) : null,
                card_amount: row.card_amount ? parseFloat(row.card_amount) : null,
                credit_amount: row.credit_amount ? parseFloat(row.credit_amount) : null,
                // Ensure sale_date is always sent as ISO string in UTC (Z suffix)
                sale_date: row.sale_date ? new Date(row.sale_date).toISOString() : null,
                // Convert sale_date_display to ISO string as well
                sale_date_display: row.sale_date_display ? new Date(row.sale_date_display).toISOString() : null,
                // Customer name and items summary
                customer_name: row.customer_name || null,
                items_summary: row.items_summary || []
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
                credito_original, // ✅ AUDITORÍA: Crédito generado al momento de la venta (INMUTABLE)
                // ✅ DESGLOSE DE PAGO - Para dashboard móvil
                cash_amount,
                card_amount,
                credit_amount,
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
            console.log(`[Sync/Sales] 💳 Desglose - Efectivo: ${cash_amount || 0}, Tarjeta: ${card_amount || 0}, Crédito: ${credit_amount || 0}`);
            console.log(`[Sync/Sales] 💰 Montos - Subtotal: ${subtotal}, Descuentos: ${total_descuentos}, Total: ${total}, Pagado: ${monto_pagado}, Crédito Original: ${credito_original || 0}`);

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
            const numericCreditoOriginal = parseFloat(credito_original) || 0; // ✅ AUDITORÍA: Crédito inmutable

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
            // PostgreSQL: 'draft', 'assigned', 'completed', 'cancelled', 'liquidated'
            // IMPORTANTE: Solo estado 3 (Completada) y 5 (Liquidada) cuentan para corte de caja
            const statusMap = {
                1: 'draft',      // Borrador - no cuenta
                2: 'assigned',   // Asignada a repartidor - NO cuenta en corte hasta liquidación
                3: 'completed',  // Completada (venta mostrador) - SÍ cuenta
                4: 'cancelled',  // Cancelada - no cuenta
                5: 'liquidated'  // Liquidada (repartidor cobró) - SÍ cuenta
            };
            const status = statusMap[estado_venta_id] || 'completed';

            // ✅ DESGLOSE DE PAGO - Convertir a números
            const numericCashAmount = parseFloat(cash_amount) || 0;
            const numericCardAmount = parseFloat(card_amount) || 0;
            const numericCreditAmount = parseFloat(credit_amount) || 0;

            // ✅ IDEMPOTENTE: INSERT con ON CONFLICT (global_id) DO UPDATE
            const result = await pool.query(
                `INSERT INTO ventas (
                    tenant_id, branch_id, id_empleado, id_turno,
                    estado_venta_id, venta_tipo_id, tipo_pago_id,
                    id_repartidor_asignado, id_turno_repartidor,
                    ticket_number, id_cliente,
                    subtotal, total_descuentos, total, monto_pagado, credito_original,
                    cash_amount, card_amount, credit_amount,
                    fecha_venta_raw, fecha_liquidacion_raw,
                    notas, status,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
                 ON CONFLICT (tenant_id, branch_id, ticket_number, id_turno) DO UPDATE
                 SET subtotal = EXCLUDED.subtotal,
                     total_descuentos = EXCLUDED.total_descuentos,
                     total = EXCLUDED.total,
                     monto_pagado = EXCLUDED.monto_pagado,
                     credito_original = CASE WHEN ventas.credito_original = 0 OR ventas.credito_original IS NULL THEN EXCLUDED.credito_original ELSE ventas.credito_original END,
                     cash_amount = EXCLUDED.cash_amount,
                     card_amount = EXCLUDED.card_amount,
                     credit_amount = EXCLUDED.credit_amount,
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
                    numericCreditoOriginal,                   // ✅ AUDITORÍA: Crédito original inmutable
                    numericCashAmount,                        // ✅ Desglose: Efectivo
                    numericCardAmount,                        // ✅ Desglose: Tarjeta
                    numericCreditAmount,                      // ✅ Desglose: Crédito
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
            console.log(`[Sync/Sales]    💳 GUARDADO - Efectivo: $${insertedVenta.cash_amount}, Tarjeta: $${insertedVenta.card_amount}, Crédito: $${insertedVenta.credit_amount}`);
            console.log(`[Sync/Sales]    Tipo: ${insertedVenta.venta_tipo_id}`);

            // ═══════════════════════════════════════════════════════════════
            // SINCRONIZAR DETALLES DE LA VENTA (si vienen en el payload)
            // ═══════════════════════════════════════════════════════════════
            const { detalles } = req.body;
            let detallesSincronizados = 0;

            console.log(`[Sync/Sales] 🔍 Detalles recibidos:`, typeof detalles, Array.isArray(detalles) ? `array[${detalles.length}]` : detalles);

            if (Array.isArray(detalles) && detalles.length > 0) {
                console.log(`[Sync/Sales] 📦 Procesando ${detalles.length} detalles de venta...`);

                for (const detalle of detalles) {
                    try {
                        // INSERT con ON CONFLICT para idempotencia por global_id
                        await pool.query(
                            `INSERT INTO ventas_detalle (
                                id_venta,
                                id_producto,
                                descripcion_producto,
                                cantidad,
                                precio_lista,
                                precio_unitario,
                                total_linea,
                                tipo_descuento_cliente_id,
                                monto_cliente_descuento,
                                tipo_descuento_manual_id,
                                monto_manual_descuento,
                                global_id,
                                terminal_id,
                                local_op_seq,
                                created_local_utc,
                                device_event_raw
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                            ON CONFLICT (global_id) DO UPDATE SET
                                cantidad = EXCLUDED.cantidad,
                                precio_unitario = EXCLUDED.precio_unitario,
                                total_linea = EXCLUDED.total_linea,
                                monto_cliente_descuento = EXCLUDED.monto_cliente_descuento,
                                monto_manual_descuento = EXCLUDED.monto_manual_descuento`,
                            [
                                insertedVenta.id_venta,
                                detalle.id_producto,
                                detalle.descripcion_producto || '',
                                parseFloat(detalle.cantidad) || 0,
                                parseFloat(detalle.precio_lista) || 0,
                                parseFloat(detalle.precio_unitario) || 0,
                                parseFloat(detalle.total_linea) || 0,
                                detalle.tipo_descuento_cliente_id || null,
                                parseFloat(detalle.monto_cliente_descuento) || 0,
                                detalle.tipo_descuento_manual_id || null,
                                parseFloat(detalle.monto_manual_descuento) || 0,
                                detalle.global_id,
                                detalle.terminal_id,
                                detalle.local_op_seq || 0,
                                detalle.created_local_utc || new Date().toISOString(),
                                detalle.device_event_raw || null
                            ]
                        );
                        detallesSincronizados++;
                    } catch (detalleError) {
                        console.error(`[Sync/Sales] ⚠️ Error insertando detalle: ${detalleError.message}`);
                    }
                }

                console.log(`[Sync/Sales] ✅ ${detallesSincronizados}/${detalles.length} detalles sincronizados`);
            }

            // Formatear respuesta (Desktop espera "data.id_venta")
            // ✅ Incluir employee_global_id para sincronización con SQLite local
            const employeeGlobalIdResult = await pool.query(
                'SELECT global_id FROM employees WHERE id = $1',
                [id_empleado]
            );
            const employeeGlobalId = employeeGlobalIdResult.rows[0]?.global_id || null;

            res.json({
                success: true,
                data: {
                    id_venta: insertedVenta.id_venta,
                    ticket_number: insertedVenta.ticket_number,
                    total: parseFloat(insertedVenta.total),
                    fecha_venta_utc: insertedVenta.fecha_venta_utc,
                    created_at: insertedVenta.created_at,
                    employee_global_id: employeeGlobalId,
                    detalles_sincronizados: detallesSincronizados  // Nuevo: cantidad de detalles sincronizados
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

    // ============================================================================
    // DEPRECATED: POST /api/sync/sales-items
    // Esta ruta usaba tabla 'sales_items' que NO EXISTE en el esquema actual.
    // Los detalles de venta ahora se sincronizan junto con la venta en POST /sync
    // usando la tabla 'ventas_detalle'.
    // ============================================================================
    /*
    router.post('/sync-items', async (req, res) => {
        try {
            const { tenantId, branchId, saleId, items } = req.body;

            console.log(`[Sync/SalesItems] 📦 Sincronizando ${items?.length || 0} líneas para venta ${saleId}`);

            if (!tenantId || !branchId || !saleId || !Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, saleId, items requeridos)' });
            }

            // Borrar líneas existentes (en caso de actualización)
            await pool.query('DELETE FROM ventas_detalle WHERE id_venta = $1', [saleId]);

            // Insertar nuevas líneas
            const insertedItems = [];
            for (const item of items) {
                try {
                    const result = await pool.query(
                        `INSERT INTO ventas_detalle (
                            id_venta, id_producto, descripcion,
                            cantidad, precio_unitario, descuento, subtotal
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                        RETURNING *`,
                        [
                            saleId,
                            item.product_id || null,
                            item.product_name || '',
                            parseFloat(item.quantity) || 0,
                            parseFloat(item.unit_price) || 0,
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
    */

    // GET /api/sales/items - Obtener artículos por venta específica
    // Usa tabla ventas_detalle con JOIN a ventas para obtener tenant_id y branch_id
    router.get('/items', async (req, res) => {
        try {
            const { sale_id, tenant_id, branch_id } = req.query;

            if (!sale_id || !tenant_id || !branch_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: sale_id, tenant_id, branch_id'
                });
            }

            console.log(`[SalesItems/GetBySale] Fetching items for sale_id=${sale_id}, tenant_id=${tenant_id}, branch_id=${branch_id}`);

            const result = await pool.query(
                `SELECT
                    vd.id_venta_detalle as id,
                    v.tenant_id,
                    v.branch_id,
                    vd.id_venta as sale_id,
                    vd.id_producto as product_id,
                    vd.descripcion_producto as product_name,
                    vd.cantidad as quantity,
                    vd.precio_unitario as unit_price,
                    vd.precio_lista as list_price,
                    COALESCE(vd.monto_cliente_descuento, 0) as customer_discount,
                    COALESCE(vd.monto_manual_descuento, 0) as manual_discount,
                    COALESCE(vd.monto_cliente_descuento, 0) + COALESCE(vd.monto_manual_descuento, 0) as total_discount,
                    vd.total_linea as subtotal,
                    vd.created_at,
                    v.ticket_number,
                    v.total as total_amount
                FROM ventas_detalle vd
                INNER JOIN ventas v ON vd.id_venta = v.id_venta
                WHERE vd.id_venta = $1 AND v.tenant_id = $2 AND v.branch_id = $3
                ORDER BY vd.created_at ASC`,
                [parseInt(sale_id), parseInt(tenant_id), parseInt(branch_id)]
            );

            console.log(`[SalesItems/GetBySale] Found ${result.rows.length} items`);

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

    // GET /api/sales/items/branch - Obtener artículos de una sucursal con paginación
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
                `SELECT
                    vd.id_venta_detalle as id,
                    v.tenant_id,
                    v.branch_id,
                    vd.id_venta as sale_id,
                    vd.id_producto as product_id,
                    vd.descripcion_producto as product_name,
                    vd.cantidad as quantity,
                    vd.precio_unitario as unit_price,
                    vd.precio_lista as list_price,
                    COALESCE(vd.monto_cliente_descuento, 0) as customer_discount,
                    COALESCE(vd.monto_manual_descuento, 0) as manual_discount,
                    COALESCE(vd.monto_cliente_descuento, 0) + COALESCE(vd.monto_manual_descuento, 0) as total_discount,
                    vd.total_linea as subtotal,
                    vd.created_at,
                    v.ticket_number,
                    v.total as total_amount
                FROM ventas_detalle vd
                INNER JOIN ventas v ON vd.id_venta = v.id_venta
                WHERE v.tenant_id = $1 AND v.branch_id = $2
                ORDER BY vd.created_at DESC
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

    // GET /api/sales/items/by-type - Obtener artículos filtrados por tipo de venta
    // venta_tipo_id: 1 = Mostrador (counter), 2 = Repartidor (delivery)
    router.get('/items/by-type', async (req, res) => {
        try {
            const { tenant_id, branch_id, sale_type, limit = 1000 } = req.query;

            if (!tenant_id || !branch_id || !sale_type) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: tenant_id, branch_id, sale_type'
                });
            }

            // Mapear sale_type string a venta_tipo_id
            const saleTypeCode = sale_type.toLowerCase();
            let ventaTipoId = null;
            if (saleTypeCode === 'counter' || saleTypeCode === 'mostrador') {
                ventaTipoId = 1;
            } else if (saleTypeCode === 'delivery' || saleTypeCode === 'repartidor') {
                ventaTipoId = 2;
            }

            let query = `
                SELECT
                    vd.id_venta_detalle as id,
                    v.tenant_id,
                    v.branch_id,
                    vd.id_venta as sale_id,
                    vd.id_producto as product_id,
                    vd.descripcion_producto as product_name,
                    vd.cantidad as quantity,
                    vd.precio_unitario as unit_price,
                    vd.precio_lista as list_price,
                    COALESCE(vd.monto_cliente_descuento, 0) as customer_discount,
                    COALESCE(vd.monto_manual_descuento, 0) as manual_discount,
                    COALESCE(vd.monto_cliente_descuento, 0) + COALESCE(vd.monto_manual_descuento, 0) as total_discount,
                    vd.total_linea as subtotal,
                    vd.created_at,
                    v.ticket_number,
                    v.total as total_amount,
                    CASE v.venta_tipo_id WHEN 1 THEN 'counter' WHEN 2 THEN 'delivery' ELSE 'unknown' END as sale_type_name
                FROM ventas_detalle vd
                INNER JOIN ventas v ON vd.id_venta = v.id_venta
                WHERE v.tenant_id = $1 AND v.branch_id = $2
            `;
            const params = [parseInt(tenant_id), parseInt(branch_id)];

            if (ventaTipoId) {
                query += ` AND v.venta_tipo_id = $3 ORDER BY vd.created_at DESC LIMIT $4`;
                params.push(ventaTipoId, parseInt(limit));
            } else {
                query += ` ORDER BY vd.created_at DESC LIMIT $3`;
                params.push(parseInt(limit));
            }

            const result = await pool.query(query, params);

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

    // GET /api/sales/items/by-payment - Obtener artículos filtrados por tipo de pago
    // tipo_pago_id: 1 = Efectivo (cash), 2 = Tarjeta (card), 3 = Crédito (credit)
    router.get('/items/by-payment', async (req, res) => {
        try {
            const { tenant_id, branch_id, payment_type, limit = 1000 } = req.query;

            if (!tenant_id || !branch_id || !payment_type) {
                return res.status(400).json({
                    success: false,
                    message: 'Parámetros requeridos: tenant_id, branch_id, payment_type'
                });
            }

            // Mapear payment_type string a tipo_pago_id
            const paymentTypeCode = payment_type.toLowerCase();
            let tipoPagoId = null;
            if (paymentTypeCode === 'cash' || paymentTypeCode === 'efectivo') {
                tipoPagoId = 1;
            } else if (paymentTypeCode === 'card' || paymentTypeCode === 'tarjeta') {
                tipoPagoId = 2;
            } else if (paymentTypeCode === 'credit' || paymentTypeCode === 'credito' || paymentTypeCode === 'crédito') {
                tipoPagoId = 3;
            }

            let query = `
                SELECT
                    vd.id_venta_detalle as id,
                    v.tenant_id,
                    v.branch_id,
                    vd.id_venta as sale_id,
                    vd.id_producto as product_id,
                    vd.descripcion_producto as product_name,
                    vd.cantidad as quantity,
                    vd.precio_unitario as unit_price,
                    vd.precio_lista as list_price,
                    COALESCE(vd.monto_cliente_descuento, 0) as customer_discount,
                    COALESCE(vd.monto_manual_descuento, 0) as manual_discount,
                    COALESCE(vd.monto_cliente_descuento, 0) + COALESCE(vd.monto_manual_descuento, 0) as total_discount,
                    vd.total_linea as subtotal,
                    vd.created_at,
                    v.ticket_number,
                    v.total as total_amount,
                    CASE v.tipo_pago_id WHEN 1 THEN 'cash' WHEN 2 THEN 'card' WHEN 3 THEN 'credit' ELSE 'unknown' END as payment_type_name
                FROM ventas_detalle vd
                INNER JOIN ventas v ON vd.id_venta = v.id_venta
                WHERE v.tenant_id = $1 AND v.branch_id = $2
            `;
            const params = [parseInt(tenant_id), parseInt(branch_id)];

            if (tipoPagoId) {
                query += ` AND v.tipo_pago_id = $3 ORDER BY vd.created_at DESC LIMIT $4`;
                params.push(tipoPagoId, parseInt(limit));
            } else {
                query += ` ORDER BY vd.created_at DESC LIMIT $3`;
                params.push(parseInt(limit));
            }

            const result = await pool.query(query, params);

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

    // GET /api/sales/items/stats - Obtener estadísticas de artículos vendidos
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
                    COUNT(DISTINCT vd.id_venta) as total_sales,
                    SUM(vd.cantidad) as total_quantity,
                    SUM(vd.total_linea) as total_revenue,
                    SUM(COALESCE(vd.monto_cliente_descuento, 0) + COALESCE(vd.monto_manual_descuento, 0)) as total_discounts,
                    AVG(vd.total_linea) as avg_item_price,
                    MAX(vd.created_at) as last_sale_date
                 FROM ventas_detalle vd
                 INNER JOIN ventas v ON vd.id_venta = v.id_venta
                 WHERE v.tenant_id = $1 AND v.branch_id = $2`,
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
                notas,
                // ✅ DESGLOSE DE PAGO - Para correcciones y re-sync
                cash_amount,
                card_amount,
                credit_amount
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

            // ✅ Mapear estado_venta_id a status
            // 1=Borrador→draft, 2=Asignada→assigned, 3=Completada→completed, 4=Cancelada→cancelled, 5=Liquidada→liquidated
            const statusMap = {
                1: 'draft',
                2: 'assigned',
                3: 'completed',
                4: 'cancelled',
                5: 'liquidated'
            };
            const newStatus = statusMap[estado_venta_id] || 'completed';

            // ✅ Parsear montos de desglose (solo si se envían)
            const numericCashAmount = cash_amount !== undefined ? parseFloat(cash_amount) : null;
            const numericCardAmount = card_amount !== undefined ? parseFloat(card_amount) : null;
            const numericCreditAmount = credit_amount !== undefined ? parseFloat(credit_amount) : null;

            // Log del desglose si se envía
            if (numericCashAmount !== null || numericCardAmount !== null || numericCreditAmount !== null) {
                console.log(`[Sync/Sales/Update] 💳 Desglose recibido - Efectivo: ${numericCashAmount}, Tarjeta: ${numericCardAmount}, Crédito: ${numericCreditAmount}`);
            }

            // Actualizar venta con campos modificables (incluyendo desglose si se envía)
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
                     status = $12,
                     cash_amount = COALESCE($13, cash_amount),
                     card_amount = COALESCE($14, card_amount),
                     credit_amount = COALESCE($15, credit_amount),
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
                    tenant_id,
                    newStatus,  // $12 - status mapeado desde estado_venta_id
                    numericCashAmount,   // $13
                    numericCardAmount,   // $14
                    numericCreditAmount  // $15
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
