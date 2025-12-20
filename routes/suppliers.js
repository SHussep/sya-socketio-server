// ═══════════════════════════════════════════════════════════════
// SUPPLIERS ROUTES - Sincronización de Proveedores
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

    // GET /api/suppliers - Lista de proveedores
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { include_deleted = 'false' } = req.query;

            let query = `
                SELECT id, name, contact_person, phone_number, email, address,
                       is_active, is_undeletable, is_deleted, deleted_at,
                       global_id, terminal_id, local_op_seq, created_local_utc,
                       created_at, updated_at
                FROM suppliers
                WHERE tenant_id = $1
            `;

            if (include_deleted !== 'true') {
                query += ' AND (is_deleted = FALSE OR is_deleted IS NULL)';
            }

            query += ' ORDER BY name ASC';

            const result = await pool.query(query, [tenantId]);

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('[Suppliers] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener proveedores' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/suppliers/sync - Sincronización Offline-First desde Desktop
    // Soporta: global_id para idempotencia
    // ═══════════════════════════════════════════════════════════════
    router.post('/sync', async (req, res) => {
        const client = await pool.connect();
        try {
            const {
                tenantId,
                name, contact_person, phone_number, email, address,
                is_active, is_undeletable, is_deleted, deleted_at,
                // Offline-first fields
                global_id, terminal_id, local_op_seq, created_local_utc
            } = req.body;

            console.log(`[Suppliers/Sync] ════════════════════════════════════════════════════════`);
            console.log(`[Suppliers/Sync] 📥 Recibido proveedor - GlobalId: ${global_id}`);
            console.log(`[Suppliers/Sync]    Tenant: ${tenantId}, Name: ${name}`);

            // Validación básica
            if (!tenantId || !global_id || !name) {
                console.log(`[Suppliers/Sync] ❌ Datos incompletos`);
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenantId, global_id, name requeridos)'
                });
            }

            // ═══════════════════════════════════════════════════════════════
            // TRANSACCIÓN: Check de duplicados DENTRO para evitar race condition
            // ═══════════════════════════════════════════════════════════════
            await client.query('BEGIN');

            // IDEMPOTENCIA: Verificar si ya existe por global_id CON LOCK
            const existingCheck = await client.query(
                'SELECT id FROM suppliers WHERE global_id = $1 FOR UPDATE',
                [global_id]
            );

            if (existingCheck.rows.length > 0) {
                await client.query('COMMIT');
                console.log(`[Suppliers/Sync] ⚠️ Proveedor ${global_id} ya existe (ID: ${existingCheck.rows[0].id}) - Ignorando duplicado`);
                return res.json({
                    success: true,
                    message: 'Proveedor ya sincronizado anteriormente',
                    data: { id: existingCheck.rows[0].id, global_id }
                });
            }

            // ═══════════════════════════════════════════════════════════════
            // UPSERT: Insertar proveedor con ON CONFLICT para máxima idempotencia
            // ═══════════════════════════════════════════════════════════════
            const supplierResult = await client.query(
                `INSERT INTO suppliers (
                    tenant_id, name, contact_person, phone_number, email, address,
                    is_active, is_undeletable, is_deleted, deleted_at,
                    global_id, terminal_id, local_op_seq, created_local_utc
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                ON CONFLICT (global_id) DO UPDATE SET updated_at = NOW()
                RETURNING id`,
                [
                    tenantId,
                    name,
                    contact_person || null,
                    phone_number || null,
                    email || null,
                    address || null,
                    is_active !== false,
                    is_undeletable === true,
                    is_deleted === true,
                    deleted_at ? new Date(deleted_at) : null,
                    global_id,
                    terminal_id || null,
                    local_op_seq || 0,
                    created_local_utc || null
                ]
            );

            const supplierId = supplierResult.rows[0].id;
            await client.query('COMMIT');

            console.log(`[Suppliers/Sync] ✅ Proveedor ${global_id} sincronizado exitosamente (ID: ${supplierId})`);
            res.json({
                success: true,
                data: {
                    id: supplierId,
                    global_id
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Suppliers/Sync] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar proveedor',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUT /api/suppliers/:globalId - Actualizar proveedor
    // ═══════════════════════════════════════════════════════════════
    router.put('/:globalId', async (req, res) => {
        try {
            const { globalId } = req.params;
            const {
                tenant_id,
                name, contact_person, phone_number, email, address,
                is_active, is_deleted, deleted_at,
                last_modified_local_utc
            } = req.body;

            console.log(`[Suppliers/Update] 🔄 Actualizando proveedor ${globalId}`);

            const result = await pool.query(
                `UPDATE suppliers
                 SET name = $1,
                     contact_person = $2,
                     phone_number = $3,
                     email = $4,
                     address = $5,
                     is_active = $6,
                     is_deleted = $7,
                     deleted_at = $8,
                     updated_at = NOW(),
                     last_modified_local_utc = $9
                 WHERE global_id = $10 AND tenant_id = $11
                 RETURNING id`,
                [
                    name,
                    contact_person || null,
                    phone_number || null,
                    email || null,
                    address || null,
                    is_active !== false,
                    is_deleted === true,
                    deleted_at ? new Date(deleted_at) : null,
                    last_modified_local_utc || null,
                    globalId,
                    tenant_id
                ]
            );

            if (result.rows.length === 0) {
                console.log(`[Suppliers/Update] ❌ Proveedor ${globalId} no encontrado`);
                return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });
            }

            console.log(`[Suppliers/Update] ✅ Proveedor ${globalId} actualizado`);
            res.json({ success: true, data: { id: result.rows[0].id, global_id: globalId } });

        } catch (error) {
            console.error('[Suppliers/Update] ❌ Error:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar proveedor', error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DELETE /api/suppliers/:globalId - Soft delete de proveedor
    // ═══════════════════════════════════════════════════════════════
    router.delete('/:globalId', async (req, res) => {
        try {
            const { globalId } = req.params;
            const { tenant_id } = req.body;

            console.log(`[Suppliers/Delete] 🗑️ Eliminando proveedor ${globalId}`);

            const result = await pool.query(
                `UPDATE suppliers
                 SET is_deleted = TRUE,
                     is_active = FALSE,
                     deleted_at = NOW(),
                     updated_at = NOW()
                 WHERE global_id = $1 AND tenant_id = $2
                 RETURNING id`,
                [globalId, tenant_id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });
            }

            console.log(`[Suppliers/Delete] ✅ Proveedor ${globalId} eliminado (soft delete)`);
            res.json({ success: true, data: { id: result.rows[0].id, global_id: globalId } });

        } catch (error) {
            console.error('[Suppliers/Delete] ❌ Error:', error);
            res.status(500).json({ success: false, message: 'Error al eliminar proveedor', error: error.message });
        }
    });

    return router;
};
