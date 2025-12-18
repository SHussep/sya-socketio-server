// ═══════════════════════════════════════════════════════════════
// PRODUCTOS ROUTES - Sincronización de productos desde Desktop
// ═══════════════════════════════════════════════════════════════
// Modelo: Productos por TENANT, compartidos entre branches
// Opcional: Precios diferentes por branch (productos_branch_precios)
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

    // ═══════════════════════════════════════════════════════════════
    // GET /api/productos - Lista de productos del tenant
    // Incluye precio específico de sucursal si existe
    // ═══════════════════════════════════════════════════════════════
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;
            const {
                include_deleted = 'false',
                only_active = 'true',
                category,
                search
            } = req.query;

            console.log(`[Productos] 📦 GET productos - Tenant: ${tenantId}, Branch: ${branchId}`);

            // Query con LEFT JOIN para obtener precio de sucursal si existe
            let query = `
                SELECT
                    p.id,
                    p.tenant_id,
                    p.id_producto,
                    p.descripcion,
                    p.categoria,
                    p.precio_compra,
                    p.precio_venta AS precio_venta_base,
                    COALESCE(pbp.precio_venta, p.precio_venta) AS precio_venta,
                    COALESCE(pbp.precio_compra, p.precio_compra) AS precio_compra_efectivo,
                    pbp.id AS precio_branch_id,
                    p.produccion,
                    p.inventariar,
                    p.tipos_de_salida_id,
                    p.notificar,
                    p.minimo,
                    p.inventario,
                    p.proveedor_id,
                    p.unidad_medida_id,
                    p.eliminado,
                    p.bascula,
                    p.is_pos_shortcut,
                    p.global_id,
                    p.created_at,
                    p.updated_at,
                    um.abbreviation AS unidad_abrev,
                    um.name AS unidad_nombre
                FROM productos p
                LEFT JOIN productos_branch_precios pbp
                    ON pbp.producto_id = p.id
                    AND pbp.branch_id = $2
                    AND pbp.eliminado = FALSE
                LEFT JOIN units_of_measure um
                    ON um.id = p.unidad_medida_id
                WHERE p.tenant_id = $1
            `;

            const params = [tenantId, branchId];
            let paramIndex = 3;

            // Filtrar eliminados
            if (include_deleted !== 'true') {
                query += ` AND p.eliminado = FALSE`;
            }

            // Filtrar por categoría
            if (category) {
                query += ` AND p.categoria = $${paramIndex}`;
                params.push(category);
                paramIndex++;
            }

            // Búsqueda por descripción
            if (search) {
                query += ` AND p.descripcion ILIKE $${paramIndex}`;
                params.push(`%${search}%`);
                paramIndex++;
            }

            query += ` ORDER BY p.descripcion ASC`;

            const result = await pool.query(query, params);

            console.log(`[Productos] ✅ ${result.rows.length} productos encontrados`);

            res.json({
                success: true,
                data: result.rows,
                meta: {
                    total: result.rows.length,
                    branch_id: branchId,
                    has_branch_pricing: result.rows.some(p => p.precio_branch_id != null)
                }
            });
        } catch (error) {
            console.error('[Productos] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener productos',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/sync - Sincronizar producto desde Desktop
    // IDEMPOTENTE: Usa global_id para ON CONFLICT
    // ═══════════════════════════════════════════════════════════════
    router.post('/sync', async (req, res) => {
        try {
            const {
                tenant_id,
                id_producto,           // ID local de Desktop (SQLite)
                descripcion,
                categoria,
                precio_compra,
                precio_venta,
                produccion,
                inventariar,
                tipos_de_salida_id,
                notificar,
                minimo,
                inventario,
                proveedor_id,
                unidad_medida_id,
                eliminado,
                bascula,
                is_pos_shortcut,
                // Offline-first fields
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw,
                last_modified_local_utc,
                // Sync flags from Desktop
                needs_delete
            } = req.body;

            console.log(`[Productos/Sync] 🔄 Sincronizando producto - GlobalId: ${global_id}`);
            console.log(`[Productos/Sync] 📦 Descripcion: ${descripcion}, Tenant: ${tenant_id}`);

            // Validar campos requeridos
            if (!tenant_id || !descripcion || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, descripcion, global_id requeridos)'
                });
            }

            // ✅ Si needs_delete=true, marcar como eliminado (soft delete)
            const isDeleted = needs_delete === true || eliminado === true;

            // ✅ IDEMPOTENTE: INSERT con ON CONFLICT (global_id) DO UPDATE
            const result = await pool.query(
                `INSERT INTO productos (
                    tenant_id, id_producto, descripcion, categoria,
                    precio_compra, precio_venta, produccion, inventariar,
                    tipos_de_salida_id, notificar, minimo, inventario,
                    proveedor_id, unidad_medida_id, eliminado, bascula, is_pos_shortcut,
                    global_id, terminal_id, local_op_seq, created_local_utc,
                    device_event_raw, last_modified_local_utc,
                    needs_update, needs_delete,
                    created_at, updated_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, $14, $15, $16, $17, $18, $19,
                    $20, $21, $22, $23, FALSE, $24, NOW(), NOW()
                )
                ON CONFLICT (global_id) DO UPDATE
                SET descripcion = EXCLUDED.descripcion,
                    categoria = EXCLUDED.categoria,
                    precio_compra = EXCLUDED.precio_compra,
                    precio_venta = EXCLUDED.precio_venta,
                    produccion = EXCLUDED.produccion,
                    inventariar = EXCLUDED.inventariar,
                    tipos_de_salida_id = EXCLUDED.tipos_de_salida_id,
                    notificar = EXCLUDED.notificar,
                    minimo = EXCLUDED.minimo,
                    inventario = EXCLUDED.inventario,
                    proveedor_id = EXCLUDED.proveedor_id,
                    unidad_medida_id = EXCLUDED.unidad_medida_id,
                    eliminado = EXCLUDED.eliminado,
                    bascula = EXCLUDED.bascula,
                    is_pos_shortcut = EXCLUDED.is_pos_shortcut,
                    last_modified_local_utc = EXCLUDED.last_modified_local_utc,
                    needs_update = FALSE,
                    needs_delete = EXCLUDED.needs_delete,
                    updated_at = NOW()
                RETURNING *,
                    (xmax = 0) AS inserted`,
                [
                    tenant_id,
                    id_producto || null,
                    descripcion,
                    categoria || null,
                    precio_compra || 0,
                    precio_venta || 0,
                    produccion || false,
                    inventariar || false,
                    tipos_de_salida_id || null,
                    notificar || false,
                    minimo || 0,
                    inventario || 0,
                    proveedor_id || null,
                    unidad_medida_id || null,
                    isDeleted,
                    bascula || false,
                    is_pos_shortcut || false,
                    global_id,
                    terminal_id || null,
                    local_op_seq || null,
                    created_local_utc || null,
                    device_event_raw || null,
                    last_modified_local_utc || null,
                    needs_delete || false
                ]
            );

            const producto = result.rows[0];
            const action = producto.inserted ? 'INSERTADO' : 'ACTUALIZADO';

            console.log(`[Productos/Sync] ✅ Producto ${action}: ${descripcion} (ID: ${producto.id})`);

            res.json({
                success: true,
                message: `Producto ${action.toLowerCase()} correctamente`,
                data: {
                    id: producto.id,
                    global_id: producto.global_id,
                    descripcion: producto.descripcion,
                    precio_venta: parseFloat(producto.precio_venta),
                    eliminado: producto.eliminado,
                    inserted: producto.inserted
                }
            });
        } catch (error) {
            console.error('[Productos/Sync] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar producto',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/sync-batch - Sincronizar múltiples productos
    // Más eficiente para sincronización inicial
    // ═══════════════════════════════════════════════════════════════
    router.post('/sync-batch', async (req, res) => {
        try {
            const { tenant_id, productos } = req.body;

            if (!tenant_id || !productos || !Array.isArray(productos)) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id y array de productos requeridos)'
                });
            }

            console.log(`[Productos/SyncBatch] 🔄 Sincronizando ${productos.length} productos - Tenant: ${tenant_id}`);

            const results = {
                inserted: 0,
                updated: 0,
                errors: []
            };

            // Procesar en una transacción
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                for (const prod of productos) {
                    try {
                        const isDeleted = prod.needs_delete === true || prod.eliminado === true;

                        const result = await client.query(
                            `INSERT INTO productos (
                                tenant_id, id_producto, descripcion, categoria,
                                precio_compra, precio_venta, produccion, inventariar,
                                tipos_de_salida_id, notificar, minimo, inventario,
                                proveedor_id, unidad_medida_id, eliminado, bascula, is_pos_shortcut,
                                global_id, terminal_id, local_op_seq, created_local_utc,
                                device_event_raw, last_modified_local_utc,
                                needs_update, needs_delete,
                                created_at, updated_at
                            )
                            VALUES (
                                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                                $11, $12, $13, $14, $15, $16, $17, $18, $19,
                                $20, $21, $22, $23, FALSE, $24, NOW(), NOW()
                            )
                            ON CONFLICT (global_id) DO UPDATE
                            SET descripcion = EXCLUDED.descripcion,
                                categoria = EXCLUDED.categoria,
                                precio_compra = EXCLUDED.precio_compra,
                                precio_venta = EXCLUDED.precio_venta,
                                produccion = EXCLUDED.produccion,
                                inventariar = EXCLUDED.inventariar,
                                tipos_de_salida_id = EXCLUDED.tipos_de_salida_id,
                                notificar = EXCLUDED.notificar,
                                minimo = EXCLUDED.minimo,
                                inventario = EXCLUDED.inventario,
                                proveedor_id = EXCLUDED.proveedor_id,
                                unidad_medida_id = EXCLUDED.unidad_medida_id,
                                eliminado = EXCLUDED.eliminado,
                                bascula = EXCLUDED.bascula,
                                is_pos_shortcut = EXCLUDED.is_pos_shortcut,
                                last_modified_local_utc = EXCLUDED.last_modified_local_utc,
                                needs_update = FALSE,
                                needs_delete = EXCLUDED.needs_delete,
                                updated_at = NOW()
                            RETURNING (xmax = 0) AS inserted`,
                            [
                                tenant_id,
                                prod.id_producto || null,
                                prod.descripcion,
                                prod.categoria || null,
                                prod.precio_compra || 0,
                                prod.precio_venta || 0,
                                prod.produccion || false,
                                prod.inventariar || false,
                                prod.tipos_de_salida_id || null,
                                prod.notificar || false,
                                prod.minimo || 0,
                                prod.inventario || 0,
                                prod.proveedor_id || null,
                                prod.unidad_medida_id || null,
                                isDeleted,
                                prod.bascula || false,
                                prod.is_pos_shortcut || false,
                                prod.global_id,
                                prod.terminal_id || null,
                                prod.local_op_seq || null,
                                prod.created_local_utc || null,
                                prod.device_event_raw || null,
                                prod.last_modified_local_utc || null,
                                prod.needs_delete || false
                            ]
                        );

                        if (result.rows[0].inserted) {
                            results.inserted++;
                        } else {
                            results.updated++;
                        }
                    } catch (prodError) {
                        results.errors.push({
                            global_id: prod.global_id,
                            descripcion: prod.descripcion,
                            error: prodError.message
                        });
                    }
                }

                await client.query('COMMIT');
            } catch (txError) {
                await client.query('ROLLBACK');
                throw txError;
            } finally {
                client.release();
            }

            console.log(`[Productos/SyncBatch] ✅ Completado: ${results.inserted} insertados, ${results.updated} actualizados, ${results.errors.length} errores`);

            res.json({
                success: true,
                message: `Sincronización completada`,
                data: results
            });
        } catch (error) {
            console.error('[Productos/SyncBatch] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar productos',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DELETE /api/productos/:global_id - Soft delete de producto
    // ═══════════════════════════════════════════════════════════════
    router.delete('/:global_id', async (req, res) => {
        try {
            const { global_id } = req.params;
            const { tenant_id, last_modified_local_utc } = req.body;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id requerido'
                });
            }

            console.log(`[Productos] 🗑️ Soft delete producto: ${global_id}`);

            const result = await pool.query(
                `UPDATE productos
                 SET eliminado = TRUE,
                     needs_delete = TRUE,
                     last_modified_local_utc = COALESCE($3, NOW()::TEXT),
                     updated_at = NOW()
                 WHERE global_id = $1 AND tenant_id = $2
                 RETURNING id, global_id, descripcion`,
                [global_id, tenant_id, last_modified_local_utc || null]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Producto no encontrado'
                });
            }

            console.log(`[Productos] ✅ Producto eliminado (soft): ${result.rows[0].descripcion}`);

            res.json({
                success: true,
                message: 'Producto eliminado correctamente',
                data: result.rows[0]
            });
        } catch (error) {
            console.error('[Productos] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar producto',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/branch-precio/sync - Sincronizar precio de sucursal
    // ═══════════════════════════════════════════════════════════════
    router.post('/branch-precio/sync', async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                producto_global_id,
                precio_venta,
                precio_compra,
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc,
                last_modified_local_utc,
                eliminado
            } = req.body;

            console.log(`[Productos/BranchPrecio] 🔄 Sincronizando precio - Producto: ${producto_global_id}, Branch: ${branch_id}`);

            // Validar campos requeridos
            if (!tenant_id || !branch_id || !producto_global_id || !global_id || precio_venta === undefined) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos'
                });
            }

            // Resolver producto_id desde global_id
            const productoLookup = await pool.query(
                'SELECT id FROM productos WHERE global_id = $1 AND tenant_id = $2',
                [producto_global_id, tenant_id]
            );

            if (productoLookup.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: `Producto no encontrado: ${producto_global_id}`
                });
            }

            const producto_id = productoLookup.rows[0].id;

            const result = await pool.query(
                `INSERT INTO productos_branch_precios (
                    tenant_id, branch_id, producto_id,
                    precio_venta, precio_compra,
                    global_id, terminal_id, local_op_seq,
                    created_local_utc, last_modified_local_utc, eliminado,
                    created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
                ON CONFLICT (global_id) DO UPDATE
                SET precio_venta = EXCLUDED.precio_venta,
                    precio_compra = EXCLUDED.precio_compra,
                    last_modified_local_utc = EXCLUDED.last_modified_local_utc,
                    eliminado = EXCLUDED.eliminado,
                    updated_at = NOW()
                RETURNING *,
                    (xmax = 0) AS inserted`,
                [
                    tenant_id,
                    branch_id,
                    producto_id,
                    precio_venta,
                    precio_compra || null,
                    global_id,
                    terminal_id || null,
                    local_op_seq || null,
                    created_local_utc || null,
                    last_modified_local_utc || null,
                    eliminado || false
                ]
            );

            const precio = result.rows[0];
            const action = precio.inserted ? 'INSERTADO' : 'ACTUALIZADO';

            console.log(`[Productos/BranchPrecio] ✅ Precio ${action} para branch ${branch_id}`);

            res.json({
                success: true,
                message: `Precio de sucursal ${action.toLowerCase()}`,
                data: {
                    id: precio.id,
                    global_id: precio.global_id,
                    producto_id: precio.producto_id,
                    branch_id: precio.branch_id,
                    precio_venta: parseFloat(precio.precio_venta),
                    inserted: precio.inserted
                }
            });
        } catch (error) {
            console.error('[Productos/BranchPrecio] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar precio de sucursal',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/productos/categories - Categorías de productos
    // ═══════════════════════════════════════════════════════════════
    router.get('/categories', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;

            // Por ahora retornamos categorías hardcoded (podrían estar en una tabla)
            // TODO: Crear tabla de categorías si se necesita
            const categories = [
                { id: 1, name: 'Tortillas' },
                { id: 2, name: 'Tostadas' },
                { id: 3, name: 'Otros Productos' },
                { id: 4, name: 'Bebidas' },
                { id: 5, name: 'Servicios' }
            ];

            res.json({
                success: true,
                data: categories
            });
        } catch (error) {
            console.error('[Productos/Categories] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al obtener categorías',
                error: error.message
            });
        }
    });

    return router;
};
