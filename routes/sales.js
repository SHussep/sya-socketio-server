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
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false', branch_id, timezone, startDate, endDate } = req.query;

            // Prioridad: 1. branch_id del query, 2. branchId del JWT
            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            // Usar timezone si viene en query, sino usar UTC por defecto
            const userTimezone = timezone || 'UTC';

            let query = `
                SELECT s.id, s.ticket_number, s.total_amount, s.payment_method, s.sale_date,
                       s.sale_type, s.employee_id, s.tenant_id, s.branch_id,
                       e.full_name as employee_name, e.role as employee_role,
                       b.name as branch_name, b.id as "branchId",
                       ra.id as assignment_id,
                       (s.sale_date AT TIME ZONE '${userTimezone}') as sale_date_display
                FROM sales s
                LEFT JOIN employees e ON s.employee_id = e.id
                LEFT JOIN branches b ON s.branch_id = b.id
                LEFT JOIN repartidor_assignments ra ON s.id = ra.sale_id
                WHERE s.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

            // Filtrar por branch_id solo si no se solicita ver todas las sucursales
            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND s.branch_id = $${paramIndex}`;
                params.push(targetBranchId);
                paramIndex++;
            }

            // Filtrar por rango de fechas si se proporciona (en timezone del usuario)
            if (startDate || endDate) {
                if (startDate) {
                    query += ` AND (s.sale_date AT TIME ZONE '${userTimezone}')::date >= $${paramIndex}::date`;
                    params.push(startDate);
                    paramIndex++;
                }
                if (endDate) {
                    query += ` AND (s.sale_date AT TIME ZONE '${userTimezone}')::date <= $${paramIndex}::date`;
                    params.push(endDate);
                    paramIndex++;
                }
            }

            query += ` ORDER BY s.sale_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
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

    // POST /api/sales - Crear venta desde Desktop (sin JWT)
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

    // POST /api/sync/sales - Alias de /api/sales (para compatibilidad con Desktop)
    // Ahora también acepta localShiftId para offline-first reconciliation
    router.post('/sync', async (req, res) => {
        try {
            const { tenantId, branchId, employeeId, ticketNumber, totalAmount, paymentMethod, tipoPagoId, userEmail, sale_type, ventaTipoId, fechaVenta, localShiftId } = req.body;

            console.log(`[Sync/Sales] ⏮️  RAW REQUEST BODY:`, JSON.stringify(req.body, null, 2));
            console.log(`[Sync/Sales] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, Ticket: ${ticketNumber}, Type: ${sale_type}, FechaVenta: ${fechaVenta}, LocalShiftId: ${localShiftId}`);
            console.log(`[Sync/Sales] Received totalAmount: ${totalAmount} (type: ${typeof totalAmount})`);
            console.log(`[Sync/Sales] Received paymentMethod: ${paymentMethod}, tipoPagoId: ${tipoPagoId}`);

            if (!tenantId || !branchId || !ticketNumber || totalAmount === null || totalAmount === undefined) {
                return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, ticketNumber, totalAmount requeridos)' });
            }

            // Convertir totalAmount a número si viene como string
            const numericTotalAmount = parseFloat(totalAmount);
            if (isNaN(numericTotalAmount)) {
                return res.status(400).json({ success: false, message: 'totalAmount debe ser un número válido' });
            }

            // Determinar método de pago de manera robusta usando tipoPagoId si viene
            let finalPaymentMethod = paymentMethod || 'cash';
            if (tipoPagoId) {
                const tipoPagoMap = {
                    1: 'cash',      // Efectivo
                    2: 'card',      // Tarjeta
                    3: 'credit'     // Crédito
                };
                finalPaymentMethod = tipoPagoMap[tipoPagoId] || paymentMethod || 'cash';
                console.log(`[Sync/Sales] 💳 Usando tipoPagoId ${tipoPagoId} -> ${finalPaymentMethod}`);
            }

            // Usar employeeId del body si viene, sino buscar por email
            let finalEmployeeId = employeeId;
            if (!finalEmployeeId && userEmail) {
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                    [userEmail, tenantId]
                );
                if (empResult.rows.length > 0) {
                    finalEmployeeId = empResult.rows[0].id;
                }
            }

            // ✅ CRITICAL FIX: ALWAYS use server time (UTC now)
            // NEVER trust client-provided timestamps - they can be in different timezones
            // Server timestamp is the source of truth
            const saleDate = new Date().toISOString();
            console.log(`[Sync/Sales] 📅 Using server UTC timestamp: ${saleDate}`);

            console.log(`[Sync/Sales] 📤 About to insert - saleDate: ${saleDate} (type: ${typeof saleDate}, null: ${saleDate === null}, empty: ${saleDate === ''})`);

            // Determinar sale_type_id basado en ventaTipoId o sale_type
            // ventaTipoId: 1=Mostrador, 2=Repartidor
            let finalSaleTypeId = ventaTipoId || (sale_type === 'delivery' ? 2 : 1);
            if (!ventaTipoId && !sale_type) finalSaleTypeId = 1; // Default: Mostrador

            // ✅ IMPORTANTE: Mapear correctamente el sale_type TEXT basado en finalSaleTypeId
            // 1 = 'counter', 2 = 'delivery'
            const finalSaleType = finalSaleTypeId === 2 ? 'delivery' : 'counter';

            const result = await pool.query(
                `INSERT INTO sales (tenant_id, branch_id, employee_id, local_shift_id, ticket_number, total_amount, payment_method, payment_type_id, sale_type, sale_type_id, sale_date)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 RETURNING *`,
                [tenantId, branchId, finalEmployeeId, localShiftId || null, ticketNumber, numericTotalAmount, finalPaymentMethod, tipoPagoId || 1, finalSaleType, finalSaleTypeId, saleDate]
            );

            console.log(`[Sync/Sales] ✅ Venta sincronizada: ${ticketNumber} - $${numericTotalAmount} | Pago: ${tipoPagoId} | Tipo: ${finalSaleType} (ID: ${finalSaleTypeId}) | LocalShiftId: ${localShiftId}`);

            // Asegurar que total_amount es un número y formatear timestamps en UTC
            const responseData = result.rows[0];
            if (responseData) {
                responseData.total_amount = parseFloat(responseData.total_amount);
                // Format timestamps as ISO strings in UTC
                if (responseData.sale_date) {
                    responseData.sale_date = new Date(responseData.sale_date).toISOString();
                }
            }

            res.json({ success: true, data: responseData });
        } catch (error) {
            console.error('[Sync/Sales] Error:', error);
            res.status(500).json({ success: false, message: 'Error al sincronizar venta', error: error.message });
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

    return router;
};
