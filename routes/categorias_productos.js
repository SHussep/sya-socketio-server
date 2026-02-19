// ═══════════════════════════════════════════════════════════════
// CATEGORIAS PRODUCTOS ROUTES - Sincronización de Categorías de Producto
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

// Middleware: Autenticación JWT opcional (para Desktop sin login)
function optionalAuthenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        req.user = null;
        return next();
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            req.user = null;
        } else {
            req.user = user;
        }
        next();
    });
}

module.exports = (pool) => {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // GET /api/categorias-productos/pull - Descargar categorías para Desktop sync
    // Soporta: since (ISO timestamp) para sync incremental
    // ═══════════════════════════════════════════════════════════════
    router.get('/pull', optionalAuthenticateToken, async (req, res) => {
        try {
            const tenantId = req.user?.tenantId || req.query.tenantId;
            const since = req.query.since;

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'Se requiere tenantId' });
            }

            console.log(`[CategoriasProductos/Pull] 📥 Descargando categorías - Tenant: ${tenantId}, Since: ${since || 'ALL'}`);

            let query = `
                SELECT
                    id,
                    global_id,
                    tenant_id,
                    nombre,
                    is_available,
                    is_system_category,
                    is_deleted,
                    deleted_at,
                    terminal_id,
                    created_at,
                    updated_at
                FROM categorias_productos
                WHERE tenant_id = $1
            `;

            const params = [tenantId];

            if (since) {
                query += ` AND updated_at > $2`;
                params.push(since);
            }

            query += ` ORDER BY updated_at ASC`;

            const result = await pool.query(query, params);

            let lastSync = null;
            if (result.rows.length > 0) {
                const lastRow = result.rows[result.rows.length - 1];
                lastSync = lastRow.updated_at;
            }

            console.log(`[CategoriasProductos/Pull] ✅ ${result.rows.length} categorías encontradas`);

            res.json({
                success: true,
                data: {
                    categorias: result.rows,
                    last_sync: lastSync
                },
                count: result.rows.length
            });
        } catch (error) {
            console.error('[CategoriasProductos/Pull] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al descargar categorías', error: undefined });
        }
    });

    // GET /api/categorias-productos - Lista de categorías
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { include_deleted = 'false' } = req.query;

            let query = `
                SELECT id, nombre, is_available, is_system_category,
                       is_deleted, deleted_at,
                       global_id, terminal_id, local_op_seq, created_local_utc,
                       created_at, updated_at
                FROM categorias_productos
                WHERE tenant_id = $1
            `;

            if (include_deleted !== 'true') {
                query += ' AND (is_deleted = FALSE OR is_deleted IS NULL)';
            }

            query += ' ORDER BY id ASC';

            const result = await pool.query(query, [tenantId]);

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('[CategoriasProductos] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener categorías' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/categorias-productos/sync - Sincronización Offline-First desde Desktop
    // Soporta: global_id para idempotencia
    // ═══════════════════════════════════════════════════════════════
    router.post('/sync', async (req, res) => {
        const client = await pool.connect();
        try {
            const {
                tenantId,
                nombre, is_available, is_system_category,
                is_deleted, deleted_at,
                // Offline-first fields
                global_id, terminal_id, local_op_seq, created_local_utc
            } = req.body;

            console.log(`[CategoriasProductos/Sync] ════════════════════════════════════════════════════════`);
            console.log(`[CategoriasProductos/Sync] 📥 Recibida categoría - GlobalId: ${global_id}`);
            console.log(`[CategoriasProductos/Sync]    Tenant: ${tenantId}, Nombre: ${nombre}`);

            // Validación básica
            if (!tenantId || !global_id || !nombre) {
                console.log(`[CategoriasProductos/Sync] ❌ Datos incompletos`);
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenantId, global_id, nombre requeridos)'
                });
            }

            // ═══════════════════════════════════════════════════════════════
            // TRANSACCIÓN: Check de duplicados DENTRO para evitar race condition
            // ═══════════════════════════════════════════════════════════════
            await client.query('BEGIN');

            // IDEMPOTENCIA: Verificar si ya existe por global_id CON LOCK
            const existingCheck = await client.query(
                'SELECT id FROM categorias_productos WHERE global_id = $1 FOR UPDATE',
                [global_id]
            );

            if (existingCheck.rows.length > 0) {
                await client.query('COMMIT');
                console.log(`[CategoriasProductos/Sync] ⚠️ Categoría ${global_id} ya existe (ID: ${existingCheck.rows[0].id}) - Ignorando duplicado`);
                return res.json({
                    success: true,
                    message: 'Categoría ya sincronizada anteriormente',
                    data: { id: existingCheck.rows[0].id, global_id }
                });
            }

            // ═══════════════════════════════════════════════════════════════
            // INSERT: Ya verificamos duplicados arriba con FOR UPDATE lock
            // ═══════════════════════════════════════════════════════════════
            const categoriaResult = await client.query(
                `INSERT INTO categorias_productos (
                    tenant_id, nombre, is_available, is_system_category,
                    is_deleted, deleted_at,
                    global_id, terminal_id, local_op_seq, created_local_utc
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING id`,
                [
                    tenantId,
                    nombre,
                    is_available !== false,
                    is_system_category === true,
                    is_deleted === true,
                    deleted_at ? new Date(deleted_at) : null,
                    global_id,
                    terminal_id || null,
                    local_op_seq || 0,
                    created_local_utc || null
                ]
            );

            const categoriaId = categoriaResult.rows[0].id;
            await client.query('COMMIT');

            console.log(`[CategoriasProductos/Sync] ✅ Categoría ${global_id} sincronizada exitosamente (ID: ${categoriaId})`);
            res.json({
                success: true,
                data: {
                    id: categoriaId,
                    global_id
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[CategoriasProductos/Sync] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar categoría',
                error: undefined
            });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUT /api/categorias-productos/:globalId - Actualizar categoría
    // ═══════════════════════════════════════════════════════════════
    router.put('/:globalId', async (req, res) => {
        try {
            const { globalId } = req.params;
            const {
                tenant_id,
                nombre, is_available, is_system_category,
                is_deleted, deleted_at,
                last_modified_local_utc
            } = req.body;

            console.log(`[CategoriasProductos/Update] 🔄 Actualizando categoría ${globalId}`);

            const result = await pool.query(
                `UPDATE categorias_productos
                 SET nombre = $1,
                     is_available = $2,
                     is_system_category = $3,
                     is_deleted = $4,
                     deleted_at = $5,
                     updated_at = NOW(),
                     last_modified_local_utc = $6
                 WHERE global_id = $7 AND tenant_id = $8
                 RETURNING id`,
                [
                    nombre,
                    is_available !== false,
                    is_system_category === true,
                    is_deleted === true,
                    deleted_at ? new Date(deleted_at) : null,
                    last_modified_local_utc || null,
                    globalId,
                    tenant_id
                ]
            );

            if (result.rows.length === 0) {
                console.log(`[CategoriasProductos/Update] ❌ Categoría ${globalId} no encontrada`);
                return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
            }

            console.log(`[CategoriasProductos/Update] ✅ Categoría ${globalId} actualizada`);
            res.json({ success: true, data: { id: result.rows[0].id, global_id: globalId } });

        } catch (error) {
            console.error('[CategoriasProductos/Update] ❌ Error:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar categoría', error: undefined });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DELETE /api/categorias-productos/:globalId - Soft delete de categoría
    // ═══════════════════════════════════════════════════════════════
    router.delete('/:globalId', async (req, res) => {
        try {
            const { globalId } = req.params;
            const { tenant_id } = req.body;

            console.log(`[CategoriasProductos/Delete] 🗑️ Eliminando categoría ${globalId}`);

            const result = await pool.query(
                `UPDATE categorias_productos
                 SET is_deleted = TRUE,
                     is_available = FALSE,
                     deleted_at = NOW(),
                     updated_at = NOW()
                 WHERE global_id = $1 AND tenant_id = $2
                 RETURNING id`,
                [globalId, tenant_id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Categoría no encontrada' });
            }

            console.log(`[CategoriasProductos/Delete] ✅ Categoría ${globalId} eliminada (soft delete)`);
            res.json({ success: true, data: { id: result.rows[0].id, global_id: globalId } });

        } catch (error) {
            console.error('[CategoriasProductos/Delete] ❌ Error:', error);
            res.status(500).json({ success: false, message: 'Error al eliminar categoría', error: undefined });
        }
    });

    return router;
};
