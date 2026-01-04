// ═══════════════════════════════════════════════════════════════
// CUSTOMERS ROUTES - Sincronización de clientes desde Desktop
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware: Autenticación JWT (requerida)
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

// Middleware: Autenticación JWT opcional (para Desktop sin login)
// Si hay token válido, lo usa. Si no, continúa sin autenticación.
function optionalAuthenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        req.user = null;
        return next();
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            req.user = null; // Token inválido, pero continuar
        } else {
            req.user = user;
        }
        next();
    });
}

module.exports = (pool) => {
    const router = express.Router();

    // GET /api/customers - Lista de clientes del tenant
    // Acepta tenantId del JWT o como query param (para importación desde Desktop)
    router.get('/', async (req, res) => {
        try {
            // Intentar obtener tenantId del JWT primero, luego del query param
            let tenantId = req.query.tenantId;

            // Si hay token JWT, intentar extraer tenantId de ahí
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.split(' ')[1];
            if (token) {
                try {
                    const jwt = require('jsonwebtoken');
                    const decoded = jwt.verify(token, process.env.JWT_SECRET);
                    if (decoded.tenantId) {
                        tenantId = decoded.tenantId;
                    }
                } catch (jwtErr) {
                    // Token inválido o de Google - usar query param
                    console.log('[Customers] Token no es JWT del backend, usando query param');
                }
            }

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'Se requiere tenantId' });
            }

            const { include_generic = 'false' } = req.query;

            let query = `
                SELECT id, tenant_id, nombre as name, telefono as phone, correo as email, direccion as address,
                       credito_limite as credit_limit, saldo_deudor as current_balance, nota as notes, is_system_generic,
                       created_at, updated_at
                FROM customers
                WHERE tenant_id = $1
            `;

            // Por defecto, ocultar el cliente genérico en listados
            if (include_generic !== 'true') {
                query += ' AND (is_system_generic = FALSE OR is_system_generic IS NULL)';
            }

            query += ' ORDER BY name ASC';

            const result = await pool.query(query, [tenantId]);

            console.log(`[Customers] ✅ ${result.rows.length} clientes encontrados para tenant ${tenantId}`);

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('[Customers] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener clientes', error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/customers/pull - Descargar clientes para sincronización (Desktop/Caja Auxiliar)
    // Soporta sincronización incremental con parámetro 'since'
    // NO requiere JWT - acepta tenantId como query param (igual que /sync)
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/pull', optionalAuthenticateToken, async (req, res) => {
        try {
            const tenantId = req.user?.tenantId || req.query.tenantId;
            const since = req.query.since; // ISO timestamp para sync incremental

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'Se requiere tenantId' });
            }

            console.log(`[Customers/Pull] 📥 Descargando clientes - Tenant: ${tenantId}, Since: ${since || 'ALL'}`);

            let query = `
                SELECT
                    id,
                    global_id,
                    tenant_id,
                    nombre as name,
                    telefono as phone,
                    telefono_secundario as phone_secondary,
                    correo as email,
                    direccion as address,
                    tiene_credito as has_credit,
                    credito_limite as credit_limit,
                    saldo_deudor as balance,
                    descuento as discount,
                    nota as notes,
                    is_active,
                    is_system_generic,
                    created_at,
                    updated_at
                FROM customers
                WHERE tenant_id = $1
            `;

            const params = [tenantId];

            // Filtrar por fecha si se proporciona 'since'
            if (since) {
                query += ` AND updated_at > $2`;
                params.push(since);
            }

            query += ` ORDER BY updated_at ASC`;

            const result = await pool.query(query, params);

            // Obtener timestamp más reciente para próximo pull
            let lastSync = null;
            if (result.rows.length > 0) {
                const lastRow = result.rows[result.rows.length - 1];
                lastSync = lastRow.updated_at;
            }

            console.log(`[Customers/Pull] ✅ ${result.rows.length} clientes encontrados`);

            res.json({
                success: true,
                data: {
                    customers: result.rows,
                    last_sync: lastSync
                },
                count: result.rows.length
            });
        } catch (error) {
            console.error('[Customers/Pull] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al descargar clientes', error: error.message });
        }
    });

    // POST /api/customers/sync - Sincronizar cliente desde Desktop (idempotente)
    router.post('/sync', async (req, res) => {
        try {
            const {
                tenant_id,
                name,
                phone,
                phone_secondary,
                email,
                address,
                has_credit,
                credit_limit,
                // ❌ REMOVIDO: current_balance - PostgreSQL lo calcula automáticamente con triggers
                notes,
                is_wholesale,
                discount_percentage,
                // ✅ OFFLINE-FIRST FIELDS
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw
            } = req.body;

            console.log(`[Sync/Customers] 🔄 Sincronizando cliente - Tenant: ${tenant_id}, Nombre: ${name}`);
            console.log(`[Sync/Customers] 🔐 Offline-First - GlobalId: ${global_id}, TerminalId: ${terminal_id}`);

            // Validar campos requeridos
            if (!tenant_id || !name || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, name, global_id requeridos)'
                });
            }

            // ⚠️ NO permitir sincronizar el cliente genérico desde Desktop
            // El genérico se crea automáticamente en el servidor
            if (name.toLowerCase().includes('público') && name.toLowerCase().includes('general')) {
                console.log(`[Sync/Customers] ⏭️ Ignorando cliente genérico (se crea automáticamente en servidor)`);
                return res.json({
                    success: true,
                    message: 'Cliente genérico ignorado - se usa el del servidor',
                    data: null
                });
            }

            // ✅ IDEMPOTENTE: INSERT con ON CONFLICT (global_id) DO UPDATE
            // ⚠️ saldo_deudor se maneja automáticamente con triggers (sales + credit_payments)
            const result = await pool.query(
                `INSERT INTO customers (
                    tenant_id, nombre, telefono, telefono_secundario, correo, direccion,
                    tiene_credito, credito_limite, nota, porcentaje_descuento,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw,
                    is_system_generic, created_at, updated_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::uuid, $13, $14, $15, FALSE, NOW(), NOW())
                 ON CONFLICT (global_id) DO UPDATE
                 SET nombre = EXCLUDED.nombre,
                     telefono = EXCLUDED.telefono,
                     telefono_secundario = EXCLUDED.telefono_secundario,
                     correo = EXCLUDED.correo,
                     direccion = EXCLUDED.direccion,
                     tiene_credito = EXCLUDED.tiene_credito,
                     credito_limite = EXCLUDED.credito_limite,
                     nota = EXCLUDED.nota,
                     porcentaje_descuento = EXCLUDED.porcentaje_descuento,
                     updated_at = NOW()
                 RETURNING *`,
                [
                    tenant_id,
                    name,
                    phone || null,
                    phone_secondary || null,
                    email || null,
                    address || null,
                    has_credit || false,
                    credit_limit || 0,
                    notes || null,
                    discount_percentage || 0,
                    global_id,
                    terminal_id || null,
                    local_op_seq || null,
                    created_local_utc || null,
                    device_event_raw || null
                ]
            );

            const customer = result.rows[0];

            console.log(`[Sync/Customers] ✅ Cliente sincronizado: ${customer.nombre} (ID: ${customer.id})`);

            res.json({
                success: true,
                data: {
                    id: customer.id,
                    name: customer.nombre,
                    global_id: customer.global_id,
                    created_at: customer.created_at
                }
            });
        } catch (error) {
            console.error('[Sync/Customers] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar cliente',
                error: error.message
            });
        }
    });

    // GET /api/customers/generic - Obtener cliente genérico del tenant
    router.get('/generic', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;

            const result = await pool.query(
                'SELECT get_or_create_generic_customer($1, $2) as customer_id',
                [tenantId, branchId]
            );

            const customerId = result.rows[0].customer_id;

            const customer = await pool.query(
                'SELECT * FROM customers WHERE id = $1',
                [customerId]
            );

            console.log(`[Customers] ✅ Cliente genérico obtenido: ${customerId}`);

            res.json({
                success: true,
                data: customer.rows[0]
            });
        } catch (error) {
            console.error('[Customers] ❌ Error obteniendo genérico:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener cliente genérico', error: error.message });
        }
    });

    // PUT /api/customers/:id - Actualizar cliente existente desde Desktop
    // :id puede ser el ID numérico O el GlobalId (UUID)
    router.put('/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const {
                tenant_id,
                name,
                phone,
                phone_secondary,
                email,
                address,
                has_credit,
                credit_limit,
                notes,
                discount_percentage,
                tipo_descuento,
                monto_descuento_fijo,
                aplicar_redondeo,
                last_modified_local_utc
            } = req.body;

            console.log(`[Customers/Update] 🔄 Actualizando cliente ${id} - Tenant: ${tenant_id}`);
            console.log(`[Customers/Update] 📝 has_credit: ${has_credit}, credit_limit: ${credit_limit}`);

            // 🔄 RESOLVER ID: puede ser numérico o GlobalId (UUID)
            let customerId;
            let checkResult;

            // Verificar si es UUID (contiene guiones y tiene longitud de UUID)
            const isUuid = id.includes('-') && id.length >= 32;

            if (isUuid) {
                // Buscar por global_id
                checkResult = await pool.query(
                    'SELECT id, is_system_generic FROM customers WHERE global_id = $1 AND tenant_id = $2',
                    [id, tenant_id]
                );
                if (checkResult.rows.length > 0) {
                    customerId = checkResult.rows[0].id;
                }
                console.log(`[Customers/Update] 🔐 Resolviendo GlobalId ${id} → ID: ${customerId}`);
            } else {
                // Buscar por ID numérico
                checkResult = await pool.query(
                    'SELECT id, is_system_generic FROM customers WHERE id = $1 AND tenant_id = $2',
                    [id, tenant_id]
                );
                if (checkResult.rows.length > 0) {
                    customerId = checkResult.rows[0].id;
                }
            }

            if (!customerId || checkResult.rows.length === 0) {
                console.log(`[Customers/Update] ❌ Cliente no encontrado: ${id}`);
                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado o no pertenece al tenant'
                });
            }

            // ⚠️ NO permitir modificar el cliente genérico
            if (checkResult.rows[0]?.is_system_generic) {
                return res.status(403).json({
                    success: false,
                    message: 'No se puede modificar el cliente genérico del sistema'
                });
            }

            // UPDATE cliente usando el ID numérico resuelto
            const result = await pool.query(
                `UPDATE customers
                 SET nombre = $1,
                     telefono = $2,
                     telefono_secundario = $3,
                     correo = $4,
                     direccion = $5,
                     tiene_credito = $6,
                     credito_limite = $7,
                     nota = $8,
                     porcentaje_descuento = $9,
                     tipo_descuento = $10,
                     monto_descuento_fijo = $11,
                     aplicar_redondeo = $12,
                     updated_at = NOW()
                 WHERE id = $13 AND tenant_id = $14
                 RETURNING *`,
                [
                    name,
                    phone || null,
                    phone_secondary || null,
                    email || null,
                    address || null,
                    has_credit || false,
                    credit_limit || 0,
                    notes || null,
                    discount_percentage || 0,
                    tipo_descuento || 0,
                    monto_descuento_fijo || 0,
                    aplicar_redondeo || false,
                    customerId,  // Usar el ID numérico resuelto
                    tenant_id
                ]
            );

            const customer = result.rows[0];

            console.log(`[Customers/Update] ✅ Cliente ${customer.nombre} (ID: ${customer.id}) actualizado exitosamente`);
            console.log(`[Customers/Update] 💳 tiene_credito: ${customer.tiene_credito}, credito_limite: ${customer.credito_limite}`);

            res.json({
                success: true,
                message: 'Cliente actualizado exitosamente',
                data: {
                    id: customer.id,
                    name: customer.nombre,
                    global_id: customer.global_id,
                    has_credit: customer.tiene_credito,
                    credit_limit: parseFloat(customer.credito_limite || 0),
                    updated_at: customer.updated_at
                }
            });
        } catch (error) {
            console.error('[Customers/Update] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar cliente',
                error: error.message
            });
        }
    });

    // PATCH /api/customers/:id/balance - Actualizar saldo del cliente (desde Desktop offline-first)
    // :id puede ser el ID numérico O el GlobalId (UUID)
    router.patch('/:id/balance', async (req, res) => {
        try {
            const { id } = req.params;
            const { tenant_id, current_balance, last_balance_update_utc } = req.body;

            console.log(`[Customers/Balance] 💰 Actualizando saldo cliente ${id} - Tenant: ${tenant_id}, Nuevo saldo: $${current_balance}`);

            // Validar campos requeridos
            if (!tenant_id || current_balance === undefined || current_balance === null) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, current_balance requeridos)'
                });
            }

            // 🔄 RESOLVER ID: puede ser numérico o GlobalId (UUID)
            let customerId;
            let checkResult;

            // Verificar si es UUID (contiene guiones y tiene longitud de UUID)
            const isUuid = id.includes('-') && id.length >= 32;

            if (isUuid) {
                // Buscar por global_id
                checkResult = await pool.query(
                    'SELECT id, is_system_generic FROM customers WHERE global_id = $1 AND tenant_id = $2',
                    [id, tenant_id]
                );
                if (checkResult.rows.length > 0) {
                    customerId = checkResult.rows[0].id;
                }
            } else {
                // Buscar por ID numérico
                checkResult = await pool.query(
                    'SELECT id, is_system_generic FROM customers WHERE id = $1 AND tenant_id = $2',
                    [id, tenant_id]
                );
                if (checkResult.rows.length > 0) {
                    customerId = checkResult.rows[0].id;
                }
            }

            if (!customerId || checkResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado o no pertenece al tenant'
                });
            }

            // ⚠️ NO permitir modificar el saldo del cliente genérico (siempre debe ser 0)
            if (checkResult.rows[0].is_system_generic) {
                console.log(`[Customers/Balance] ⏭️ Ignorando actualización de saldo para cliente genérico`);
                return res.json({
                    success: true,
                    message: 'Cliente genérico - saldo no modificado',
                    data: { id: customerId, current_balance: 0 }
                });
            }

            // UPDATE saldo - SOBRESCRIBE el saldo calculado por triggers
            // OFFLINE-FIRST: El saldo de Desktop es la fuente de verdad
            const result = await pool.query(
                `UPDATE customers
                 SET saldo_deudor = $1,
                     updated_at = NOW()
                 WHERE id = $2 AND tenant_id = $3
                 RETURNING id, nombre, saldo_deudor, global_id, updated_at`,
                [current_balance, customerId, tenant_id]
            );

            const customer = result.rows[0];

            console.log(`[Customers/Balance] ✅ Saldo actualizado (offline-first): ${customer.nombre} → $${customer.saldo_deudor}`);

            res.json({
                success: true,
                message: 'Saldo actualizado exitosamente',
                data: {
                    id: customer.id,
                    global_id: customer.global_id,
                    name: customer.nombre,
                    current_balance: parseFloat(customer.saldo_deudor),
                    updated_at: customer.updated_at
                }
            });
        } catch (error) {
            console.error('[Customers/Balance] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar saldo de cliente',
                error: error.message
            });
        }
    });

    // PATCH /api/customers/:id/deactivate - Soft delete (desactivar cliente)
    // :id puede ser el ID numérico O el GlobalId (UUID)
    router.patch('/:id/deactivate', async (req, res) => {
        try {
            const { id } = req.params;
            const { tenant_id, last_modified_local_utc } = req.body;

            console.log(`[Customers/Deactivate] 🗑️ Desactivando cliente ${id} - Tenant: ${tenant_id}`);

            // 🔄 RESOLVER ID: puede ser numérico o GlobalId (UUID)
            let customerId;
            let checkResult;

            // Verificar si es UUID (contiene guiones y tiene longitud de UUID)
            const isUuid = id.includes('-') && id.length >= 32;

            if (isUuid) {
                // Buscar por global_id
                checkResult = await pool.query(
                    'SELECT id, is_system_generic FROM customers WHERE global_id = $1 AND tenant_id = $2',
                    [id, tenant_id]
                );
                if (checkResult.rows.length > 0) {
                    customerId = checkResult.rows[0].id;
                }
                console.log(`[Customers/Deactivate] 🔐 Resolviendo GlobalId ${id} → ID: ${customerId}`);
            } else {
                // Buscar por ID numérico
                checkResult = await pool.query(
                    'SELECT id, is_system_generic FROM customers WHERE id = $1 AND tenant_id = $2',
                    [id, tenant_id]
                );
                if (checkResult.rows.length > 0) {
                    customerId = checkResult.rows[0].id;
                }
            }

            if (!customerId || checkResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado o no pertenece al tenant'
                });
            }

            // ⚠️ NO permitir desactivar el cliente genérico
            if (checkResult.rows[0].is_system_generic) {
                return res.status(403).json({
                    success: false,
                    message: 'No se puede desactivar el cliente genérico del sistema'
                });
            }

            // Soft delete: marcar como inactivo usando el ID numérico resuelto
            const result = await pool.query(
                `UPDATE customers
                 SET activo = FALSE,
                     updated_at = NOW()
                 WHERE id = $1 AND tenant_id = $2
                 RETURNING id, nombre, activo, global_id`,
                [customerId, tenant_id]
            );

            const customer = result.rows[0];

            console.log(`[Customers/Deactivate] ✅ Cliente ${customer.nombre} (ID: ${customer.id}) desactivado exitosamente`);

            res.json({
                success: true,
                message: 'Cliente desactivado exitosamente',
                data: {
                    id: customer.id,
                    name: customer.nombre,
                    global_id: customer.global_id,
                    activo: customer.activo
                }
            });
        } catch (error) {
            console.error('[Customers/Deactivate] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al desactivar cliente',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PAYMENT REMINDER SYSTEM - NEW ENDPOINTS
    // ═══════════════════════════════════════════════════════════════

    /**
     * GET /api/customers/with-balance
     * Lista clientes con saldo deudor > 0, ordenados por sal do descendente
     * Query params:
     *   - tenant_id (required)
     *   - branch_id (optional) - filtra por sucursal
     */
    router.get('/with-balance', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { branch_id } = req.query;

            console.log(`[Customers/WithBalance] 📊 Obteniendo clientes con saldo para tenant ${tenantId}`);

            let query = `
                SELECT 
                    c.id,
                    c.nombre AS name,
                    c.saldo_deudor AS current_balance,
                    c.telefono AS phone,
                    c.telefono_secundario AS phone_secondary,
                    c.correo AS email,
                    c.direccion AS address,
                    c.credito_limite AS credit_limit,
                    c.tenant_id,
                    t.business_name AS tenant_name
                FROM customers c
                JOIN tenants t ON c.tenant_id = t.id
                WHERE c.tenant_id = $1
                    AND c.saldo_deudor > 0
                    AND c.activo = TRUE
                    AND (c.is_system_generic = FALSE OR c.is_system_generic IS NULL)
                ORDER BY c.saldo_deudor DESC
            `;

            const result = await pool.query(query, [tenantId]);

            console.log(`[Customers/WithBalance] ✅ ${result.rows.length} clientes con saldo encontrados`);

            res.json({
                success: true,
                count: result.rows.length,
                customers: result.rows.map(c => ({
                    id: c.id,
                    name: c.name,
                    current_balance: parseFloat(c.current_balance || 0),
                    phone: c.phone,
                    phone_secondary: c.phone_secondary,
                    email: c.email,
                    address: c.address,
                    credit_limit: parseFloat(c.credit_limit || 0),
                    tenant_id: c.tenant_id,
                    tenant_name: c.tenant_name
                }))
            });
        } catch (error) {
            console.error('[Customers/WithBalance] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener clientes con saldo deudor',
                error: error.message
            });
        }
    });

    /**
     * GET /api/customers/:id/account-statement
     * Obtiene el estado de cuenta completo de un cliente
     * Incluye: cliente, tenant, branch, ventas pendientes, pagos
     */
    router.get('/:id/account-statement', authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { tenantId, branchId } = req.user;

            console.log(`[Customers/AccountStatement] 📄 Generando estado de cuenta para cliente ${id}`);

            // 1. Datos del cliente
            const customerQuery = `
                SELECT 
                    c.id,
                    c.nombre AS name,
                    c.saldo_deudor AS current_balance,
                    c.telefono AS phone,
                    c.telefono_secundario AS phone_secondary,
                    c.correo AS email,
                    c.direccion AS address,
                    c.credito_limite AS credit_limit,
                    c.tenant_id
                FROM customers c
                WHERE c.id = $1 AND c.tenant_id = $2
            `;
            const customerResult = await pool.query(customerQuery, [id, tenantId]);

            if (customerResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado'
                });
            }

            const customer = customerResult.rows[0];

            // 2. Datos del Tenant y Branch
            const tenantQuery = `
                SELECT 
                    t.business_name AS name,
                    t.email,
                    t.phone_number AS phone,
                    b.name AS branch_name,
                    b.address AS branch_address,
                    b.phone AS branch_phone
                FROM tenants t
                LEFT JOIN branches b ON t.id = b.tenant_id AND b.id = $2
                WHERE t.id = $1
                LIMIT 1
            `;
            const tenantResult = await pool.query(tenantQuery, [tenantId, branchId]);
            const tenantData = tenantResult.rows[0] || {};

            // 3. Ventas a crédito pendientes (no canceladas) CON sus items
            const salesQuery = `
                SELECT
                    v.id_venta AS id,
                    v.ticket_number,
                    v.fecha_venta_utc AS sale_date,
                    v.total AS amount,
                    v.monto_pagado AS amount_paid,
                    (v.total - COALESCE(v.monto_pagado, 0)) AS pending_amount,
                    v.notas AS notes,
                    -- Items de la venta como JSON array
                    CASE
                        WHEN COUNT(vd.id_venta_detalle) > 0 THEN
                            json_agg(
                                json_build_object(
                                    'product_name', vd.descripcion_producto,
                                    'quantity', vd.cantidad,
                                    'unit_price', vd.precio_unitario,
                                    'subtotal', vd.total_linea
                                ) ORDER BY vd.id_venta_detalle
                            )
                        ELSE
                            '[]'::json
                    END AS items
                FROM ventas v
                LEFT JOIN ventas_detalle vd ON v.id_venta = vd.id_venta
                WHERE v.id_cliente = $1
                    AND v.tenant_id = $2
                    AND v.tipo_pago_id = 3
                    AND (v.status IS NULL OR v.status != 'cancelled')
                    AND (v.total - COALESCE(v.monto_pagado, 0)) > 0
                GROUP BY v.id_venta, v.ticket_number, v.fecha_venta_utc, v.total, v.monto_pagado, v.notas
                ORDER BY v.fecha_venta_utc DESC
            `;
            const salesResult = await pool.query(salesQuery, [id, tenantId]);

            // 4. Pagos recibidos
            const paymentsQuery = `
                SELECT 
                    cp.id,
                    cp.amount,
                    cp.payment_date,
                    cp.payment_method,
                    cp.notes,
                    e.first_name || ' ' || COALESCE(e.last_name, '') AS employee_name
                FROM credit_payments cp
                LEFT JOIN employees e ON cp.employee_id = e.id
                WHERE cp.customer_id = $1
                    AND cp.tenant_id = $2
                ORDER BY cp.payment_date DESC
                LIMIT 50
            `;
            const paymentsResult = await pool.query(paymentsQuery, [id, tenantId]);

            // 5. Calcular totales
            const totalPendingSales = salesResult.rows.reduce((sum, sale) => sum + parseFloat(sale.pending_amount || 0), 0);
            const totalPayments = paymentsResult.rows.reduce((sum, payment) => sum + parseFloat(payment.amount || 0), 0);

            console.log(`[Customers/AccountStatement] ✅ Estado generado: ${salesResult.rows.length} ventas, ${paymentsResult.rows.length} pagos`);

            res.json({
                success: true,
                customer: {
                    id: customer.id,
                    name: customer.name,
                    phone: customer.phone,
                    phone_secondary: customer.phone_secondary,
                    email: customer.email,
                    address: customer.address,
                    credit_limit: parseFloat(customer.credit_limit || 0),
                    current_balance: parseFloat(customer.current_balance || 0)
                },
                tenant: {
                    name: tenantData.name || '',
                    email: tenantData.email || '',
                    phone: tenantData.phone || ''
                },
                branch: {
                    name: tenantData.branch_name || '',
                    address: tenantData.branch_address || '',
                    phone: tenantData.branch_phone || ''
                },
                pending_sales: salesResult.rows.map(sale => ({
                    id: sale.id,
                    ticket_number: sale.ticket_number,
                    sale_date: sale.sale_date,
                    amount: parseFloat(sale.amount || 0),
                    amount_paid: parseFloat(sale.amount_paid || 0),
                    pending_amount: parseFloat(sale.pending_amount || 0),
                    notes: sale.notes || '',
                    items: Array.isArray(sale.items) ? sale.items.map(item => ({
                        product_name: item.product_name,
                        quantity: parseFloat(item.quantity || 0),
                        unit_price: parseFloat(item.unit_price || 0),
                        subtotal: parseFloat(item.subtotal || 0)
                    })) : []
                })),
                payments: paymentsResult.rows.map(payment => ({
                    id: payment.id,
                    amount: parseFloat(payment.amount || 0),
                    payment_date: payment.payment_date,
                    payment_method: payment.payment_method,
                    notes: payment.notes || '',
                    employee_name: payment.employee_name || 'N/A'
                })),
                summary: {
                    total_pending_sales: totalPendingSales,
                    total_payments: totalPayments,
                    total_due: parseFloat(customer.current_balance || 0),
                    generated_at: new Date().toISOString()
                }
            });

        } catch (error) {
            console.error('[Customers/AccountStatement] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al generar estado de cuenta',
                error: error.message
            });
        }
    });

    return router;
};
