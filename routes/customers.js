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
                email,
                address,
                has_credit,
                credit_limit,
                current_balance,
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
            const result = await pool.query(
                `INSERT INTO customers (
                    tenant_id, nombre, telefono, correo, direccion,
                    tiene_credito, credito_limite, saldo_deudor, nota, porcentaje_descuento,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw,
                    is_system_generic, synced, created_at, updated_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::uuid, $13, $14, $15, FALSE, TRUE, NOW(), NOW())
                 ON CONFLICT (global_id) DO UPDATE
                 SET nombre = EXCLUDED.nombre,
                     telefono = EXCLUDED.telefono,
                     correo = EXCLUDED.correo,
                     direccion = EXCLUDED.direccion,
                     tiene_credito = EXCLUDED.tiene_credito,
                     credito_limite = EXCLUDED.credito_limite,
                     saldo_deudor = EXCLUDED.saldo_deudor,
                     nota = EXCLUDED.nota,
                     porcentaje_descuento = EXCLUDED.porcentaje_descuento,
                     updated_at = NOW()
                 RETURNING *`,
                [
                    tenant_id,
                    name,
                    phone || null,
                    email || null,
                    address || null,
                    has_credit || false,
                    credit_limit || 0,
                    current_balance || 0,
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

    return router;
};
