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
                    porcentaje_descuento as discount_percentage,
                    nota as notes,
                    activo as is_active,
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
                    c.global_id,
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
                    global_id: c.global_id,
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

            // 🔄 RESOLVER ID: puede ser numérico o GlobalId (UUID)
            let customerId;
            let customerResult;

            // Verificar si es UUID (contiene guiones y tiene longitud de UUID)
            const isUuid = id.includes('-') && id.length >= 32;

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
                WHERE ${isUuid ? 'c.global_id = $1' : 'c.id = $1'} AND c.tenant_id = $2
            `;
            customerResult = await pool.query(customerQuery, [id, tenantId]);

            if (customerResult.rows.length === 0) {
                console.log(`[Customers/AccountStatement] ❌ Cliente no encontrado: ${id}`);
                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado'
                });
            }

            const customer = customerResult.rows[0];
            customerId = customer.id; // ID numérico resuelto

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
            // ✅ FIX: Incluir ventas mixtas (tipo_pago_id = 4) con crédito pendiente
            const salesQuery = `
                SELECT
                    v.id_venta AS id,
                    v.ticket_number,
                    v.fecha_venta_utc AS sale_date,
                    v.total AS amount,
                    v.monto_pagado AS amount_paid,
                    -- Para crédito puro usar (total - pagado), para mixto usar credito_original menos pagos aplicados
                    CASE v.tipo_pago_id
                        WHEN 3 THEN (v.total - COALESCE(v.monto_pagado, 0))
                        ELSE COALESCE(v.credito_original, v.total - COALESCE(v.monto_pagado, 0))
                    END AS pending_amount,
                    v.notas AS notes,
                    v.tipo_pago_id,
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
                    AND (
                        v.tipo_pago_id = 3  -- Crédito puro
                        OR (v.tipo_pago_id = 4 AND COALESCE(v.credito_original, 0) > 0)  -- Mixto con crédito
                    )
                    AND (v.status IS NULL OR v.status != 'cancelled')
                    AND (v.total - COALESCE(v.monto_pagado, 0)) > 0
                GROUP BY v.id_venta, v.ticket_number, v.fecha_venta_utc, v.total, v.monto_pagado, v.notas, v.tipo_pago_id, v.credito_original
                ORDER BY v.fecha_venta_utc DESC
            `;
            const salesResult = await pool.query(salesQuery, [customerId, tenantId]);

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
            const paymentsResult = await pool.query(paymentsQuery, [customerId, tenantId]);

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

    /**
     * GET /api/customers/:id/movements
     * Obtiene el historial unificado de movimientos del cliente
     * Incluye: ventas a crédito, pagos, notas de crédito, cancelaciones
     * Query params:
     *   - limit (optional) - número máximo de movimientos (default: 50)
     */
    router.get('/:id/movements', authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { tenantId } = req.user;
            const limit = parseInt(req.query.limit) || 50;
            const { startDate, endDate } = req.query;

            console.log(`[Customers/Movements] 📊 Obteniendo movimientos para cliente ${id}, limit: ${limit}, startDate: ${startDate}, endDate: ${endDate}`);

            // 🔄 RESOLVER ID: puede ser numérico o GlobalId (UUID)
            let customerId;
            let customerCheck;

            // Verificar si es UUID (contiene guiones y tiene longitud de UUID)
            const isUuid = id.includes('-') && id.length >= 32;

            if (isUuid) {
                // Buscar por global_id
                customerCheck = await pool.query(
                    'SELECT id, nombre, saldo_deudor FROM customers WHERE global_id = $1 AND tenant_id = $2',
                    [id, tenantId]
                );
                if (customerCheck.rows.length > 0) {
                    customerId = customerCheck.rows[0].id;
                }
                console.log(`[Customers/Movements] 🔐 Resolviendo GlobalId ${id} → ID: ${customerId}`);
            } else {
                // Buscar por ID numérico
                customerCheck = await pool.query(
                    'SELECT id, nombre, saldo_deudor FROM customers WHERE id = $1 AND tenant_id = $2',
                    [id, tenantId]
                );
                if (customerCheck.rows.length > 0) {
                    customerId = customerCheck.rows[0].id;
                }
            }

            if (!customerId || customerCheck.rows.length === 0) {
                console.log(`[Customers/Movements] ❌ Cliente no encontrado: ${id}`);
                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado'
                });
            }

            const customer = customerCheck.rows[0];

            // Verificar si existe la tabla notas_credito
            const tableCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'notas_credito'
                ) AS has_notas_credito
            `);
            const hasNotasCredito = tableCheck.rows[0]?.has_notas_credito || false;

            // Construir filtros de fecha opcionales
            // $4 = startDate, $5 = endDate (pueden ser null)
            const hasDateFilter = startDate || endDate;
            const dateFilterVentas = hasDateFilter ? `
                ${startDate ? "AND v.fecha_venta_utc >= $4::DATE" : ""}
                ${endDate ? "AND v.fecha_venta_utc < ($5::DATE + INTERVAL '1 day')" : ""}
            ` : '';
            const dateFilterCancellations = hasDateFilter ? `
                ${startDate ? "AND v.updated_at >= $4::DATE" : ""}
                ${endDate ? "AND v.updated_at < ($5::DATE + INTERVAL '1 day')" : ""}
            ` : '';
            const dateFilterPayments = hasDateFilter ? `
                ${startDate ? "AND cp.payment_date >= $4::DATE" : ""}
                ${endDate ? "AND cp.payment_date < ($5::DATE + INTERVAL '1 day')" : ""}
            ` : '';
            const dateFilterNotasCredito = hasDateFilter ? `
                ${startDate ? "AND nc.fecha_creacion >= $4::DATE" : ""}
                ${endDate ? "AND nc.fecha_creacion < ($5::DATE + INTERVAL '1 day')" : ""}
            ` : '';

            // Query base sin notas de crédito
            // ✅ FIX: Incluir ventas mixtas (tipo_pago_id = 4) que tienen crédito
            // - tipo_pago_id = 3: Crédito puro → monto = total
            // - tipo_pago_id = 4: Mixto con crédito → monto = credito_original
            let movementsQuery = `
                WITH all_movements AS (
                    -- 1. Ventas a crédito (aumentan saldo)
                    -- Incluye crédito puro (3) y ventas mixtas (4) con credito_original > 0
                    SELECT
                        v.id_venta AS id,
                        'credit_sale' AS movement_type,
                        CASE v.tipo_pago_id
                            WHEN 3 THEN 'Venta a crédito'
                            WHEN 4 THEN 'Venta mixta (crédito)'
                            ELSE 'Venta a crédito'
                        END AS movement_type_label,
                        v.fecha_venta_utc AS movement_date,
                        -- Para crédito puro usar total, para mixto usar credito_original
                        CASE v.tipo_pago_id
                            WHEN 3 THEN v.total
                            ELSE COALESCE(v.credito_original, v.total - COALESCE(v.monto_pagado, 0))
                        END AS amount,
                        NULL::NUMERIC AS balance_before,
                        NULL::NUMERIC AS balance_after,
                        v.ticket_number::TEXT AS reference,
                        CONCAT('Ticket #', v.ticket_number) AS description,
                        COALESCE(e.first_name || ' ' || COALESCE(e.last_name, ''), 'N/A') AS employee_name,
                        b.name AS branch_name,
                        v.notas AS notes,
                        v.global_id::TEXT AS global_id
                    FROM ventas v
                    LEFT JOIN employees e ON v.id_empleado = e.id
                    LEFT JOIN branches b ON v.branch_id = b.id
                    WHERE v.id_cliente = $1
                        AND v.tenant_id = $2
                        AND (
                            v.tipo_pago_id = 3  -- Crédito puro
                            OR (v.tipo_pago_id = 4 AND COALESCE(v.credito_original, 0) > 0)  -- Mixto con crédito
                        )
                        AND (v.status IS NULL OR v.status != 'cancelled')
                        ${dateFilterVentas}

                    UNION ALL

                    -- 2. Cancelaciones de venta a crédito (reducen saldo)
                    -- Incluye cancelaciones de crédito puro (3) y ventas mixtas (4) con credito_original
                    SELECT
                        v.id_venta AS id,
                        'sale_cancellation' AS movement_type,
                        'Venta cancelada' AS movement_type_label,
                        v.updated_at AS movement_date,
                        -- Para crédito puro usar -total, para mixto usar -credito_original
                        -CASE v.tipo_pago_id
                            WHEN 3 THEN v.total
                            ELSE COALESCE(v.credito_original, v.total - COALESCE(v.monto_pagado, 0))
                        END AS amount,
                        NULL::NUMERIC AS balance_before,
                        NULL::NUMERIC AS balance_after,
                        v.ticket_number::TEXT AS reference,
                        CONCAT('Cancelación Ticket #', v.ticket_number) AS description,
                        COALESCE(e.first_name || ' ' || COALESCE(e.last_name, ''), 'N/A') AS employee_name,
                        b.name AS branch_name,
                        v.notas AS notes,
                        v.global_id::TEXT AS global_id
                    FROM ventas v
                    LEFT JOIN employees e ON v.id_empleado = e.id
                    LEFT JOIN branches b ON v.branch_id = b.id
                    WHERE v.id_cliente = $1
                        AND v.tenant_id = $2
                        AND (
                            v.tipo_pago_id = 3  -- Crédito puro
                            OR (v.tipo_pago_id = 4 AND COALESCE(v.credito_original, 0) > 0)  -- Mixto con crédito
                        )
                        AND v.status = 'cancelled'
                        ${dateFilterCancellations}

                    UNION ALL

                    -- 3. Pagos de crédito (reducen saldo)
                    SELECT
                        cp.id AS id,
                        'credit_payment' AS movement_type,
                        CASE cp.payment_method
                            WHEN 'cash' THEN 'Pago en efectivo'
                            WHEN 'card' THEN 'Pago con tarjeta'
                            ELSE 'Pago'
                        END AS movement_type_label,
                        cp.payment_date AS movement_date,
                        -cp.amount AS amount,
                        NULL::NUMERIC AS balance_before,
                        NULL::NUMERIC AS balance_after,
                        cp.id::TEXT AS reference,
                        CASE cp.payment_method
                            WHEN 'cash' THEN 'Abono en efectivo'
                            WHEN 'card' THEN 'Abono con tarjeta'
                            ELSE 'Abono a cuenta'
                        END AS description,
                        COALESCE(e.first_name || ' ' || COALESCE(e.last_name, ''), 'N/A') AS employee_name,
                        b.name AS branch_name,
                        cp.notes AS notes,
                        cp.global_id AS global_id
                    FROM credit_payments cp
                    LEFT JOIN employees e ON cp.employee_id = e.id
                    LEFT JOIN branches b ON cp.branch_id = b.id
                    WHERE cp.customer_id = $1
                        AND cp.tenant_id = $2
                        ${dateFilterPayments}
            `;

            // Agregar notas de crédito solo si la tabla existe
            if (hasNotasCredito) {
                movementsQuery += `
                    UNION ALL

                    -- 4. Notas de crédito aplicadas (reducen saldo)
                    SELECT
                        nc.id AS id,
                        'credit_note' AS movement_type,
                        CASE nc.tipo
                            WHEN 'Cancelacion' THEN 'Nota de crédito (Cancelación)'
                            WHEN 'Devolucion' THEN 'Nota de crédito (Devolución)'
                            WHEN 'Ajuste' THEN 'Nota de crédito (Ajuste)'
                            ELSE 'Nota de crédito'
                        END AS movement_type_label,
                        nc.fecha_creacion AS movement_date,
                        -nc.monto_credito AS amount,
                        NULL::NUMERIC AS balance_before,
                        NULL::NUMERIC AS balance_after,
                        nc.numero_nota_credito AS reference,
                        CONCAT('NC #', nc.numero_nota_credito, ' - ', nc.razon) AS description,
                        COALESCE(e.first_name || ' ' || COALESCE(e.last_name, ''), 'N/A') AS employee_name,
                        b.name AS branch_name,
                        nc.notas AS notes,
                        nc.global_id AS global_id
                    FROM notas_credito nc
                    LEFT JOIN employees e ON nc.employee_id = e.id
                    LEFT JOIN branches b ON nc.branch_id = b.id
                    WHERE nc.cliente_id = $1
                        AND nc.tenant_id = $2
                        AND nc.estado = 'Aplicada'
                        AND nc.monto_credito > 0
                        ${dateFilterNotasCredito}
                `;
            }

            movementsQuery += `
                )
                SELECT *
                FROM all_movements
                ORDER BY movement_date DESC
                LIMIT $3
            `;

            // Construir array de parámetros (usando customerId resuelto)
            const queryParams = [customerId, tenantId, limit];
            if (hasDateFilter) {
                queryParams.push(startDate || null);  // $4
                queryParams.push(endDate || null);    // $5
            }

            const movementsResult = await pool.query(movementsQuery, queryParams);

            // Calcular saldos progresivos (balance_before y balance_after)
            // Los movimientos vienen ordenados DESC (más reciente primero)
            // balance_after del más reciente = saldo actual del cliente
            const currentBalance = parseFloat(customer.saldo_deudor || 0);
            let runningBalance = currentBalance;

            // Recorrer en orden (más reciente primero) y calcular saldos
            for (let i = 0; i < movementsResult.rows.length; i++) {
                const movement = movementsResult.rows[i];
                const amount = parseFloat(movement.amount || 0);

                // balance_after es el saldo DESPUÉS de este movimiento
                movement.balance_after = runningBalance;

                // balance_before es el saldo ANTES de este movimiento
                // Si amount es positivo (venta), antes era menor: before = after - amount
                // Si amount es negativo (pago), antes era mayor: before = after - amount
                movement.balance_before = runningBalance - amount;

                // Para el siguiente movimiento (más antiguo), el saldo era balance_before de este
                runningBalance = movement.balance_before;
            }

            // Calcular estadísticas globales (sin filtro de fecha - historial completo)
            // ✅ FIX: Incluir ventas mixtas (tipo_pago_id = 4) con crédito
            const statsQuery = `
                SELECT
                    -- Total de ventas a crédito (crédito puro + crédito en ventas mixtas)
                    COALESCE(SUM(CASE
                        WHEN tipo_pago_id = 3 AND (status IS NULL OR status != 'cancelled') THEN total
                        WHEN tipo_pago_id = 4 AND COALESCE(credito_original, 0) > 0 AND (status IS NULL OR status != 'cancelled') THEN credito_original
                        ELSE 0
                    END), 0) AS total_credit_sales,
                    COUNT(CASE
                        WHEN (tipo_pago_id = 3 OR (tipo_pago_id = 4 AND COALESCE(credito_original, 0) > 0))
                             AND (status IS NULL OR status != 'cancelled') THEN 1
                    END) AS credit_sales_count,
                    -- Total de cancelaciones (crédito puro + crédito en ventas mixtas)
                    COALESCE(SUM(CASE
                        WHEN tipo_pago_id = 3 AND status = 'cancelled' THEN total
                        WHEN tipo_pago_id = 4 AND COALESCE(credito_original, 0) > 0 AND status = 'cancelled' THEN credito_original
                        ELSE 0
                    END), 0) AS total_cancellations,
                    COUNT(CASE
                        WHEN (tipo_pago_id = 3 OR (tipo_pago_id = 4 AND COALESCE(credito_original, 0) > 0))
                             AND status = 'cancelled' THEN 1
                    END) AS cancellations_count
                FROM ventas
                WHERE id_cliente = $1 AND tenant_id = $2
            `;
            const salesStats = await pool.query(statsQuery, [customerId, tenantId]);

            const paymentStatsQuery = `
                SELECT
                    COALESCE(SUM(amount), 0) AS total_payments,
                    COUNT(*) AS payments_count
                FROM credit_payments
                WHERE customer_id = $1 AND tenant_id = $2
            `;
            const paymentStats = await pool.query(paymentStatsQuery, [customerId, tenantId]);

            // Estadísticas de NC solo si la tabla existe
            let ncStats = { rows: [{ total_credit_notes: 0, credit_notes_count: 0 }] };
            if (hasNotasCredito) {
                const ncStatsQuery = `
                    SELECT
                        COALESCE(SUM(monto_credito), 0) AS total_credit_notes,
                        COUNT(*) AS credit_notes_count
                    FROM notas_credito
                    WHERE cliente_id = $1 AND tenant_id = $2 AND estado = 'Aplicada' AND monto_credito > 0
                `;
                ncStats = await pool.query(ncStatsQuery, [customerId, tenantId]);
            }

            // ✅ Calcular estadísticas filtradas por período (si hay filtro de fecha)
            let periodStats = null;
            if (hasDateFilter) {
                // Construir condición de fecha para SQL
                let dateCondition = '';
                const periodParams = [customerId, tenantId];
                if (startDate && endDate) {
                    dateCondition = 'AND fecha_venta_utc >= $3::DATE AND fecha_venta_utc < ($4::DATE + INTERVAL \'1 day\')';
                    periodParams.push(startDate, endDate);
                } else if (startDate) {
                    dateCondition = 'AND fecha_venta_utc >= $3::DATE';
                    periodParams.push(startDate);
                } else if (endDate) {
                    dateCondition = 'AND fecha_venta_utc < ($3::DATE + INTERVAL \'1 day\')';
                    periodParams.push(endDate);
                }

                const periodStatsQuery = `
                    SELECT
                        COALESCE(SUM(CASE
                            WHEN tipo_pago_id = 3 AND (status IS NULL OR status != 'cancelled') THEN total
                            WHEN tipo_pago_id = 4 AND COALESCE(credito_original, 0) > 0 AND (status IS NULL OR status != 'cancelled') THEN credito_original
                            ELSE 0
                        END), 0) AS period_credit_sales,
                        COUNT(CASE
                            WHEN (tipo_pago_id = 3 OR (tipo_pago_id = 4 AND COALESCE(credito_original, 0) > 0))
                                 AND (status IS NULL OR status != 'cancelled') THEN 1
                        END) AS period_sales_count
                    FROM ventas
                    WHERE id_cliente = $1 AND tenant_id = $2
                    ${dateCondition}
                `;
                const periodResult = await pool.query(periodStatsQuery, periodParams);

                periodStats = {
                    total_sales: parseFloat(periodResult.rows[0]?.period_credit_sales || 0),
                    sales_count: parseInt(periodResult.rows[0]?.period_sales_count || 0),
                    start_date: startDate || null,
                    end_date: endDate || null
                };
                console.log(`[Customers/Movements] 📅 Período filtrado: ${JSON.stringify(periodStats)}`);
            }

            const stats = {
                total_credit_sales: parseFloat(salesStats.rows[0]?.total_credit_sales || 0),
                credit_sales_count: parseInt(salesStats.rows[0]?.credit_sales_count || 0),
                total_cancellations: parseFloat(salesStats.rows[0]?.total_cancellations || 0),
                cancellations_count: parseInt(salesStats.rows[0]?.cancellations_count || 0),
                total_payments: parseFloat(paymentStats.rows[0]?.total_payments || 0),
                payments_count: parseInt(paymentStats.rows[0]?.payments_count || 0),
                total_credit_notes: parseFloat(ncStats.rows[0]?.total_credit_notes || 0),
                credit_notes_count: parseInt(ncStats.rows[0]?.credit_notes_count || 0),
                current_balance: parseFloat(customer.saldo_deudor || 0),
                // Estadísticas del período filtrado (si aplica)
                period: periodStats
            };

            console.log(`[Customers/Movements] ✅ ${movementsResult.rows.length} movimientos encontrados`);

            // Debug: contar por tipo de movimiento
            const byType = {};
            movementsResult.rows.forEach(m => {
                byType[m.movement_type] = (byType[m.movement_type] || 0) + 1;
            });
            console.log(`[Customers/Movements] 📊 Desglose por tipo:`, byType);

            res.json({
                success: true,
                customer: {
                    id: customer.id,
                    name: customer.nombre,
                    current_balance: parseFloat(customer.saldo_deudor || 0)
                },
                movements: movementsResult.rows.map(m => ({
                    id: m.id,
                    movement_type: m.movement_type,
                    movement_type_label: m.movement_type_label,
                    movement_date: m.movement_date,
                    amount: parseFloat(m.amount || 0),
                    balance_before: m.balance_before != null ? parseFloat(m.balance_before) : null,
                    balance_after: m.balance_after != null ? parseFloat(m.balance_after) : null,
                    reference: m.reference,
                    description: m.description,
                    employee_name: m.employee_name,
                    branch_name: m.branch_name,
                    notes: m.notes,
                    global_id: m.global_id
                })),
                stats: stats,
                count: movementsResult.rows.length
            });

        } catch (error) {
            console.error('[Customers/Movements] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener movimientos del cliente',
                error: error.message
            });
        }
    });

    return router;
};
