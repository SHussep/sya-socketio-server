// ═══════════════════════════════════════════════════════════════
// CUSTOMERS ROUTES - Sincronización de clientes desde Desktop
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

    // GET /api/customers - Lista de clientes del tenant
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
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
                    is_system_generic, synced, created_at, updated_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::uuid, $13, $14, $15, FALSE, TRUE, NOW(), NOW())
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

            // Validar que el cliente pertenece al tenant
            const checkResult = await pool.query(
                'SELECT id FROM customers WHERE id = $1 AND tenant_id = $2',
                [id, tenant_id]
            );

            if (checkResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado o no pertenece al tenant'
                });
            }

            // ⚠️ NO permitir modificar el cliente genérico
            const genericCheck = await pool.query(
                'SELECT is_system_generic FROM customers WHERE id = $1',
                [id]
            );

            if (genericCheck.rows[0]?.is_system_generic) {
                return res.status(403).json({
                    success: false,
                    message: 'No se puede modificar el cliente genérico del sistema'
                });
            }

            // UPDATE cliente
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
                    id,
                    tenant_id
                ]
            );

            const customer = result.rows[0];

            console.log(`[Customers/Update] ✅ Cliente ${customer.nombre} (ID: ${customer.id}) actualizado exitosamente`);

            res.json({
                success: true,
                message: 'Cliente actualizado exitosamente',
                data: {
                    id: customer.id,
                    name: customer.nombre,
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

    // PATCH /api/customers/:id/deactivate - Soft delete (desactivar cliente)
    router.patch('/:id/deactivate', async (req, res) => {
        try {
            const { id } = req.params;
            const { tenant_id, last_modified_local_utc } = req.body;

            console.log(`[Customers/Deactivate] 🗑️ Desactivando cliente ${id} - Tenant: ${tenant_id}`);

            // Validar que el cliente pertenece al tenant
            const checkResult = await pool.query(
                'SELECT id, is_system_generic FROM customers WHERE id = $1 AND tenant_id = $2',
                [id, tenant_id]
            );

            if (checkResult.rows.length === 0) {
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

            // Soft delete: marcar como inactivo
            const result = await pool.query(
                `UPDATE customers
                 SET activo = FALSE,
                     updated_at = NOW()
                 WHERE id = $1 AND tenant_id = $2
                 RETURNING id, nombre, activo`,
                [id, tenant_id]
            );

            const customer = result.rows[0];

            console.log(`[Customers/Deactivate] ✅ Cliente ${customer.nombre} (ID: ${customer.id}) desactivado exitosamente`);

            res.json({
                success: true,
                message: 'Cliente desactivado exitosamente',
                data: {
                    id: customer.id,
                    name: customer.nombre,
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

    return router;
};
