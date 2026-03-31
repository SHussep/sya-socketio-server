// ═══════════════════════════════════════════════════════════════
// PRODUCTOS ROUTES - Sincronización de productos desde Desktop
// ═══════════════════════════════════════════════════════════════
// Modelo: Productos por TENANT, compartidos entre branches
// Opcional: Precios diferentes por branch (productos_branch_precios)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
const cloudinaryService = require('../services/cloudinaryService');

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

module.exports = (pool, io) => {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // HELPER: Emitir product_updated a todas las branches del tenant
    // Productos son tenant-wide, se emite a TODAS las branches activas
    // ═══════════════════════════════════════════════════════════════
    async function emitProductUpdate(tenantId, productData, action) {
        if (!io) return;
        try {
            const branches = await pool.query(
                'SELECT id FROM branches WHERE tenant_id = $1 AND is_active = true',
                [tenantId]
            );
            // Normalizar id_producto a string (puede llegar como number desde upload-image)
            const normalized = { ...productData };
            if (normalized.id_producto != null) normalized.id_producto = String(normalized.id_producto);
            const payload = { ...normalized, action, updatedAt: new Date().toISOString() };
            for (const b of branches.rows) {
                io.to(`branch_${b.id}`).emit('product_updated', payload);
            }
            console.log(`[Productos] 📡 product_updated emitido a ${branches.rows.length} branches (action=${action})`);
        } catch (err) {
            console.error('[Productos] ⚠️ Error emitting product_updated:', err.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // GET /api/productos - Lista de productos del tenant
    // Incluye precio específico de sucursal si existe
    // Acepta tenantId/branchId del JWT o como query params (para importación)
    // ═══════════════════════════════════════════════════════════════
    router.get('/', async (req, res) => {
        try {
            // Intentar obtener tenantId/branchId del JWT primero, luego del query param
            let tenantId = req.query.tenantId;
            let branchId = req.query.branchId;

            // Si hay token JWT, extraer datos (query params tienen prioridad si se proporcionan)
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.split(' ')[1];
            if (token) {
                try {
                    const jwt = require('jsonwebtoken');
                    const decoded = jwt.verify(token, process.env.JWT_SECRET);
                    if (!tenantId && decoded.tenantId) tenantId = decoded.tenantId;
                    if (!branchId && decoded.branchId) branchId = decoded.branchId;
                } catch (jwtErr) {
                    console.log('[Productos] Token no es JWT del backend, usando query params');
                }
            }

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'Se requiere tenantId' });
            }

            const {
                include_deleted = 'false',
                only_active = 'true',
                category,
                search
            } = req.query;

            console.log(`[Productos] 📦 GET productos - Tenant: ${tenantId}, Branch: ${branchId || 'N/A'}`);

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
                    COALESCE(NULLIF(pbp.precio_venta, 0), p.precio_venta) AS precio_venta,
                    COALESCE(NULLIF(pbp.precio_compra, 0), p.precio_compra) AS precio_compra_efectivo,
                    pbp.id AS precio_branch_id,
                    p.produccion,
                    p.inventariar,
                    p.tipos_de_salida_id,
                    p.notificar,
                    p.minimo,
                    p.inventario AS inventario_global,
                    COALESCE(bi.quantity, p.inventario) AS inventario,
                    p.proveedor_id,
                    p.unidad_medida_id,
                    p.eliminado,
                    p.bascula,
                    p.is_pos_shortcut,
                    p.image_url,
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
                LEFT JOIN branch_inventory bi
                    ON bi.producto_id = p.id
                    AND bi.branch_id = $2
                    AND bi.tenant_id = $1
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
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/productos/pull - Descargar productos para sincronización (Caja Auxiliar)
    // Soporta sincronización incremental con parámetro 'since'
    // Incluye precios específicos de sucursal si branchId está presente
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/pull', authenticateToken, async (req, res) => {
        try {
            const tenantId = req.user.tenantId || req.query.tenantId;
            const branchId = req.user.branchId || req.query.branchId;
            const since = req.query.since; // ISO timestamp para sync incremental

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'Se requiere tenantId' });
            }

            console.log(`[Productos/Pull] 📥 Descargando productos - Tenant: ${tenantId}, Branch: ${branchId || 'N/A'}, Since: ${since || 'ALL'}`);

            // Query con LEFT JOIN a precios de sucursal si hay branchId
            let query = `
                SELECT
                    p.id,
                    p.global_id,
                    p.tenant_id,
                    p.descripcion as name,
                    p.categoria as categoria_id,
                    p.precio_compra as precio_costo,
                    COALESCE(NULLIF(pbp.precio_venta, 0), p.precio_venta) as precio_venta,
                    p.produccion,
                    p.inventariar,
                    p.tipos_de_salida_id,
                    p.notificar,
                    p.minimo,
                    p.inventario,
                    p.proveedor_id,
                    p.unidad_medida as unidad_medida_id,
                    p.bascula as pesable,
                    p.is_active,
                    p.created_at,
                    p.updated_at,
                    prov.global_id as proveedor_global_id
                FROM productos p
                LEFT JOIN suppliers prov ON p.proveedor_id = prov.id
            `;

            const params = [tenantId];
            let paramIndex = 2;

            // LEFT JOIN a precios específicos de sucursal
            if (branchId) {
                query = query.replace(
                    'FROM productos p',
                    `FROM productos p
                     LEFT JOIN productos_branch_precios pbp ON p.id = pbp.producto_id AND pbp.branch_id = $${paramIndex}`
                );
                params.push(branchId);
                paramIndex++;
            }

            query += ` WHERE p.tenant_id = $1`;

            // Filtrar por fecha si se proporciona 'since'
            if (since) {
                query += ` AND p.updated_at > $${paramIndex}`;
                params.push(since);
                paramIndex++;
            }

            query += ` ORDER BY p.updated_at ASC`;

            const result = await pool.query(query, params);

            // Obtener timestamp más reciente para próximo pull
            let lastSync = null;
            if (result.rows.length > 0) {
                const lastRow = result.rows[result.rows.length - 1];
                lastSync = lastRow.updated_at;
            }

            console.log(`[Productos/Pull] ✅ ${result.rows.length} productos encontrados`);

            res.json({
                success: true,
                data: {
                    products: result.rows,
                    last_sync: lastSync
                },
                count: result.rows.length
            });
        } catch (error) {
            console.error('[Productos/Pull] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al descargar productos', error: undefined });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/sync - Sincronizar producto desde Desktop
    // IDEMPOTENTE: Usa global_id para ON CONFLICT
    // ✅ CORREGIDO: Resolver proveedor_id usando proveedor_global_id
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
                proveedor_id,          // ID local (legacy)
                proveedor_global_id,   // ✅ GlobalId del proveedor
                categoria_global_id,   // ✅ GlobalId de la categoría
                unidad_medida_id,
                eliminado,
                bascula,
                is_pos_shortcut,
                image_url,             // URL de imagen del producto
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
            console.log(`[Productos/Sync] 💰 Precios: venta=${precio_venta}, compra=${precio_compra}`);
            console.log(`[Productos/Sync] 🏭 Proveedor: ID=${proveedor_id}, GlobalId=${proveedor_global_id}`);
            console.log(`[Productos/Sync] 🖼️ ImageUrl recibido: ${image_url || '(null)'}`);  // Debug image

            // Validar campos requeridos
            if (!tenant_id || !descripcion || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, descripcion, global_id requeridos)'
                });
            }

            // ✅ Si needs_delete=true, marcar como eliminado (soft delete)
            const isDeleted = needs_delete === true || eliminado === true;

            // ✅ Resolver proveedor_id desde proveedor_global_id
            let resolvedProveedorId = null;
            if (proveedor_global_id) {
                const supplierResult = await pool.query(
                    'SELECT id FROM suppliers WHERE global_id = $1 AND tenant_id = $2',
                    [proveedor_global_id, tenant_id]
                );
                if (supplierResult.rows.length > 0) {
                    resolvedProveedorId = supplierResult.rows[0].id;
                    console.log(`[Productos/Sync] ✅ Proveedor resuelto: GlobalId=${proveedor_global_id} -> PostgresID=${resolvedProveedorId}`);
                } else {
                    console.log(`[Productos/Sync] ⚠️ Proveedor no encontrado por GlobalId: ${proveedor_global_id}`);
                }
            }

            // ✅ Resolver categoria_id desde categoria_global_id (opcional, no rompe si no existe)
            let resolvedCategoriaId = null;
            if (categoria_global_id) {
                const catResult = await pool.query(
                    'SELECT id FROM categorias_productos WHERE global_id = $1 AND tenant_id = $2',
                    [categoria_global_id, tenant_id]
                );
                if (catResult.rows.length > 0) {
                    resolvedCategoriaId = catResult.rows[0].id;
                    console.log(`[Productos/Sync] ✅ Categoría resuelta: GlobalId=${categoria_global_id} -> PostgresID=${resolvedCategoriaId}`);
                } else {
                    console.log(`[Productos/Sync] ⚠️ Categoría no encontrada por GlobalId: ${categoria_global_id} (se guardará solo el ID local)`);
                }
            }

            // ✅ IDEMPOTENTE: INSERT con ON CONFLICT (global_id) DO UPDATE
            const result = await pool.query(
                `INSERT INTO productos (
                    tenant_id, id_producto, descripcion, categoria, categoria_global_id,
                    precio_compra, precio_venta, produccion, inventariar,
                    tipos_de_salida_id, notificar, minimo, inventario,
                    proveedor_id, unidad_medida_id, eliminado, bascula, is_pos_shortcut,
                    global_id, terminal_id, local_op_seq, created_local_utc,
                    device_event_raw, last_modified_local_utc,
                    needs_update, needs_delete, image_url,
                    created_at, updated_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, $14, $15, $16, $17, $18, $19,
                    $20, $21, $22, $23, $24, FALSE, $25, $26, NOW(), NOW()
                )
                ON CONFLICT (global_id) DO UPDATE
                SET descripcion = EXCLUDED.descripcion,
                    categoria = EXCLUDED.categoria,
                    categoria_global_id = COALESCE(EXCLUDED.categoria_global_id, productos.categoria_global_id),
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
                    image_url = COALESCE(EXCLUDED.image_url, productos.image_url),
                    updated_at = NOW()
                RETURNING *,
                    (xmax = 0) AS inserted`,
                [
                    tenant_id,
                    id_producto || null,
                    descripcion,
                    categoria || null,
                    categoria_global_id || null,  // $5 - GlobalId de la categoría
                    precio_compra || 0,
                    precio_venta || 0,
                    produccion || false,
                    inventariar || false,
                    tipos_de_salida_id || null,
                    notificar || false,
                    minimo || 0,
                    inventario || 0,
                    resolvedProveedorId,  // ✅ Usar ID resuelto desde global_id
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
                    needs_delete || false,
                    image_url || null  // $26
                ]
            );

            const producto = result.rows[0];
            const action = producto.inserted ? 'INSERTADO' : 'ACTUALIZADO';

            console.log(`[Productos/Sync] ✅ Producto ${action}: ${descripcion} (ID: ${producto.id}, ProveedorID: ${resolvedProveedorId})`);

            // 📡 Emitir a Desktop/Mobile vía Socket.IO
            await emitProductUpdate(tenant_id, {
                id: producto.id,
                id_producto: producto.id_producto,
                global_id: producto.global_id,
                descripcion: producto.descripcion,
                categoria: producto.categoria,
                precio_compra: parseFloat(producto.precio_compra || 0),
                precio_venta: parseFloat(producto.precio_venta || 0),
                produccion: producto.produccion,
                inventariar: producto.inventariar,
                notificar: producto.notificar,
                minimo: parseFloat(producto.minimo || 0),
                inventario: parseFloat(producto.inventario || 0),
                bascula: producto.bascula,
                is_pos_shortcut: producto.is_pos_shortcut,
                image_url: producto.image_url,
                eliminado: producto.eliminado,
            }, producto.inserted ? 'created' : 'updated');

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
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/sync-batch - Sincronizar múltiples productos
    // Más eficiente para sincronización inicial
    // ═══════════════════════════════════════════════════════════════
    router.post('/sync-batch', authenticateToken, async (req, res) => {
        try {
            const { tenant_id, productos } = req.body;

            if (!tenant_id || !productos || !Array.isArray(productos)) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id y array de productos requeridos)'
                });
            }

            // Rate limit: max 200 items per batch
            if (productos.length > 200) {
                return res.status(400).json({
                    success: false,
                    message: `Batch demasiado grande (${productos.length} items). Máximo 200 por request.`
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

                        // ✅ Resolver proveedor_id desde proveedor_global_id
                        let resolvedProveedorId = null;
                        if (prod.proveedor_global_id) {
                            const supplierResult = await client.query(
                                'SELECT id FROM suppliers WHERE global_id = $1 AND tenant_id = $2',
                                [prod.proveedor_global_id, tenant_id]
                            );
                            if (supplierResult.rows.length > 0) {
                                resolvedProveedorId = supplierResult.rows[0].id;
                            }
                        }

                        const result = await client.query(
                            `INSERT INTO productos (
                                tenant_id, id_producto, descripcion, categoria, categoria_global_id,
                                precio_compra, precio_venta, produccion, inventariar,
                                tipos_de_salida_id, notificar, minimo, inventario,
                                proveedor_id, unidad_medida_id, eliminado, bascula, is_pos_shortcut,
                                global_id, terminal_id, local_op_seq, created_local_utc,
                                device_event_raw, last_modified_local_utc,
                                needs_update, needs_delete, image_url,
                                created_at, updated_at
                            )
                            VALUES (
                                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                                $11, $12, $13, $14, $15, $16, $17, $18, $19,
                                $20, $21, $22, $23, $24, FALSE, $25, $26, NOW(), NOW()
                            )
                            ON CONFLICT (global_id) DO UPDATE
                            SET descripcion = EXCLUDED.descripcion,
                                categoria = EXCLUDED.categoria,
                                categoria_global_id = COALESCE(EXCLUDED.categoria_global_id, productos.categoria_global_id),
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
                                image_url = COALESCE(EXCLUDED.image_url, productos.image_url),
                                updated_at = NOW()
                            RETURNING (xmax = 0) AS inserted`,
                            [
                                tenant_id,
                                prod.id_producto || null,
                                prod.descripcion,
                                prod.categoria || null,
                                prod.categoria_global_id || null,  // $5
                                prod.precio_compra || 0,
                                prod.precio_venta || 0,
                                prod.produccion || false,
                                prod.inventariar || false,
                                prod.tipos_de_salida_id || null,
                                prod.notificar || false,
                                prod.minimo || 0,
                                prod.inventario || 0,
                                resolvedProveedorId,  // ✅ Usar ID resuelto desde global_id
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
                                prod.needs_delete || false,
                                prod.image_url || null  // $26
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
                error: undefined
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

            // 📡 Emitir a Desktop/Mobile vía Socket.IO
            await emitProductUpdate(tenant_id, {
                global_id,
                eliminado: true,
                descripcion: result.rows[0].descripcion,
            }, 'deleted');

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
                error: undefined
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
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/cleanup-duplicates - Limpiar productos duplicados
    // ═══════════════════════════════════════════════════════════════
    // Si hay múltiples productos con el mismo id_producto (SKU local) pero
    // diferentes global_id, elimina los que NO coinciden con los GlobalIds
    // proporcionados (los de la BD local del cliente).
    // ═══════════════════════════════════════════════════════════════
    router.post('/cleanup-duplicates', async (req, res) => {
        const client = await pool.connect();

        try {
            const { tenant_id, products } = req.body;

            if (!tenant_id || !products || !Array.isArray(products)) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, products[] requeridos)'
                });
            }

            console.log(`[Productos/CleanupDuplicates] 🧹 Iniciando limpieza para tenant ${tenant_id} con ${products.length} productos`);

            await client.query('BEGIN');

            let duplicatesRemoved = 0;
            let productsProcessed = 0;
            const errors = [];

            for (const product of products) {
                const { id_producto, global_id } = product;

                if (!id_producto || !global_id) {
                    continue;
                }

                productsProcessed++;

                try {
                    // Buscar todos los productos con este id_producto para este tenant
                    const existingProducts = await client.query(
                        `SELECT id, global_id, descripcion
                         FROM productos
                         WHERE tenant_id = $1
                         AND id = $2`,
                        [tenant_id, id_producto]
                    );

                    // También buscar por el campo "id" que podría ser diferente del SKU
                    // El problema es que el campo "id" en PostgreSQL es el PK auto-increment,
                    // pero el cliente usa "IDProducto" como identificador único local.
                    // Necesitamos buscar duplicados por global_id que empiecen con SEED_PRODUCT_
                    // y tengan el mismo número de producto.

                    // Buscar productos duplicados: mismo tenant, mismo patrón de ID en global_id
                    // Ejemplo: SEED_PRODUCT_9001 y SEED_PRODUCT_16_9001 son el mismo producto
                    const productIdMatch = global_id.match(/(\d+)$/); // Extraer número final
                    if (productIdMatch) {
                        const productNumber = productIdMatch[1];

                        // Buscar todos los productos con global_id que terminen en este número
                        // y sean del mismo tenant (productos seed duplicados)
                        // ✅ INCLUIR image_url para preservarla
                        const duplicates = await client.query(
                            `SELECT id, global_id, descripcion, image_url
                             FROM productos
                             WHERE tenant_id = $1
                             AND global_id LIKE 'SEED_PRODUCT_%'
                             AND global_id LIKE $2
                             AND global_id != $3
                             AND eliminado = false`,
                            [tenant_id, `%_${productNumber}`, global_id]
                        );

                        if (duplicates.rows.length > 0) {
                            console.log(`[Productos/CleanupDuplicates] 🔍 Encontrados ${duplicates.rows.length} duplicados para producto ${productNumber}`);

                            for (const dup of duplicates.rows) {
                                console.log(`[Productos/CleanupDuplicates] 🗑️ Eliminando duplicado: id=${dup.id}, global_id=${dup.global_id}, descripcion=${dup.descripcion}, image_url=${dup.image_url || '(null)'}`);

                                // ✅ PRESERVAR IMAGEN: Si el duplicado tiene image_url y el original no, transferirla
                                if (dup.image_url) {
                                    // Buscar el producto original (el que se queda) y verificar si tiene imagen
                                    const original = await client.query(
                                        `SELECT id, image_url FROM productos
                                         WHERE tenant_id = $1 AND global_id = $2`,
                                        [tenant_id, global_id]
                                    );

                                    if (original.rows.length > 0 && !original.rows[0].image_url) {
                                        // Transferir imagen del duplicado al original
                                        await client.query(
                                            `UPDATE productos
                                             SET image_url = $1, updated_at = NOW()
                                             WHERE id = $2`,
                                            [dup.image_url, original.rows[0].id]
                                        );
                                        console.log(`[Productos/CleanupDuplicates] 🖼️ Imagen transferida de duplicado ${dup.id} a original ${original.rows[0].id}: ${dup.image_url}`);
                                    }
                                }

                                // Soft delete del duplicado
                                await client.query(
                                    `UPDATE productos
                                     SET eliminado = true,
                                         needs_delete = true,
                                         updated_at = NOW()
                                     WHERE id = $1`,
                                    [dup.id]
                                );

                                duplicatesRemoved++;
                            }
                        }
                    }
                } catch (productError) {
                    console.error(`[Productos/CleanupDuplicates] ⚠️ Error procesando producto ${id_producto}:`, productError.message);
                    errors.push({ id_producto, error: productError.message });
                }
            }

            await client.query('COMMIT');

            console.log(`[Productos/CleanupDuplicates] ✅ Limpieza completada: ${duplicatesRemoved} duplicados eliminados de ${productsProcessed} productos procesados`);

            res.json({
                success: true,
                message: `Limpieza completada`,
                duplicatesRemoved,
                productsProcessed,
                errors: errors.length > 0 ? errors : undefined
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Productos/CleanupDuplicates] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al limpiar duplicados',
                error: undefined
            });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/upload-image - Subir imagen de producto a Cloudinary
    // ═══════════════════════════════════════════════════════════════
    // Permite subir imágenes personalizadas para cualquier producto,
    // incluyendo productos seed (cada tenant puede personalizar).
    // ═══════════════════════════════════════════════════════════════
    router.post('/upload-image', async (req, res) => {
        try {
            const { tenant_id, product_id, global_id, image_base64 } = req.body;

            if (!tenant_id || !product_id || !global_id || !image_base64) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, product_id, global_id, image_base64 requeridos)'
                });
            }

            // Nota: Ya no bloqueamos productos seed - cada tenant puede personalizar sus imágenes
            const isSeed = cloudinaryService.isSeedProduct(product_id);
            if (isSeed) {
                console.log(`[Productos/UploadImage] 🌱 Producto seed ${product_id} - subiendo imagen personalizada para tenant ${tenant_id}`);
            }

            // Verificar si Cloudinary está configurado
            if (!cloudinaryService.isConfigured()) {
                console.log('[Productos/UploadImage] ⚠️ Cloudinary no configurado');
                return res.status(503).json({
                    success: false,
                    message: 'Servicio de imágenes no disponible'
                });
            }

            console.log(`[Productos/UploadImage] 📤 Subiendo imagen para producto ${product_id} (tenant ${tenant_id})`);

            // Subir a Cloudinary
            const result = await cloudinaryService.uploadProductImage(image_base64, {
                tenantId: tenant_id,
                productId: product_id,
                globalId: global_id
            });

            // Actualizar image_url en la base de datos
            await pool.query(
                `UPDATE productos
                 SET image_url = $1, updated_at = NOW()
                 WHERE global_id = $2 AND tenant_id = $3`,
                [result.url, global_id, tenant_id]
            );

            console.log(`[Productos/UploadImage] ✅ Imagen subida: ${result.url}${isSeed ? ' (producto seed personalizado)' : ''}`);

            // 📡 Emitir a Desktop/Mobile vía Socket.IO
            await emitProductUpdate(tenant_id, {
                global_id,
                id_producto: product_id,
                image_url: result.url,
            }, 'image_updated');

            res.json({
                success: true,
                message: isSeed ? 'Imagen personalizada subida para producto seed' : 'Imagen subida exitosamente',
                data: {
                    image_url: result.url,
                    public_id: result.publicId,
                    is_seed: isSeed
                }
            });

        } catch (error) {
            console.error('[Productos/UploadImage] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al subir imagen',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/productos/seed-image/:productId - Obtener URL de imagen seed
    // ═══════════════════════════════════════════════════════════════
    router.get('/seed-image/:productId', (req, res) => {
        const productId = parseInt(req.params.productId);

        if (!cloudinaryService.isSeedProduct(productId)) {
            return res.status(404).json({
                success: false,
                message: 'No es un producto seed'
            });
        }

        const imageUrl = cloudinaryService.getSeedProductImageUrl(productId);

        res.json({
            success: true,
            data: {
                product_id: productId,
                image_url: imageUrl,
                is_seed: true
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/productos/seed-images - Obtener todas las URLs de imágenes seed
    // ═══════════════════════════════════════════════════════════════
    router.get('/seed-images', (req, res) => {
        const seedImages = {};

        for (const productId of [9001, 9002, 9003, 9004, 9005, 9006]) {
            seedImages[productId] = cloudinaryService.getSeedProductImageUrl(productId);
        }

        res.json({
            success: true,
            data: seedImages
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/delete-image - Eliminar imagen de Cloudinary
    // ═══════════════════════════════════════════════════════════════
    router.post('/delete-image', async (req, res) => {
        try {
            const { image_url } = req.body;

            if (!image_url) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere image_url'
                });
            }

            console.log(`[Productos/DeleteImage] Eliminando imagen: ${image_url}`);

            // Extraer public_id de la URL de Cloudinary
            // URL format: https://res.cloudinary.com/cloud_name/image/upload/v1234567890/folder/filename.ext
            const urlMatch = image_url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
            if (!urlMatch) {
                return res.status(400).json({
                    success: false,
                    message: 'URL de imagen inválida'
                });
            }

            const publicId = urlMatch[1];

            // No eliminar imágenes seed (compartidas)
            if (publicId.startsWith('sya-seed-products/')) {
                console.log(`[Productos/DeleteImage] ⚠️ No se elimina imagen seed: ${publicId}`);
                return res.json({
                    success: false,
                    message: 'No se puede eliminar imagen de producto semilla'
                });
            }

            // Eliminar de Cloudinary
            const deleted = await cloudinaryService.deleteProductImage(publicId);

            if (deleted) {
                console.log(`[Productos/DeleteImage] ✅ Imagen eliminada: ${publicId}`);
                res.json({
                    success: true,
                    message: 'Imagen eliminada exitosamente'
                });
            } else {
                res.json({
                    success: false,
                    message: 'No se pudo eliminar la imagen'
                });
            }

        } catch (error) {
            console.error('[Productos/DeleteImage] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar imagen',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/force-sync - Sincronización agresiva (hard delete)
    // ═══════════════════════════════════════════════════════════════
    // PELIGROSO: Elimina permanentemente productos que no existan en la lista local.
    // Usar solo cuando el cliente quiere forzar que PostgreSQL coincida con su BD local.
    // ═══════════════════════════════════════════════════════════════
    router.post('/force-sync', async (req, res) => {
        const client = await pool.connect();

        try {
            const { tenant_id: tenantId, local_products, terminal_id } = req.body;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenant_id'
                });
            }

            if (!local_products || !Array.isArray(local_products)) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere array local_products con GlobalIds'
                });
            }

            console.log(`[Productos/ForceSync] ⚠️ SYNC AGRESIVO - Tenant: ${tenantId}, Terminal: ${terminal_id}`);
            console.log(`[Productos/ForceSync] 📦 ${local_products.length} productos locales recibidos`);

            await client.query('BEGIN');

            // Obtener GlobalIds de la lista local
            const localGlobalIds = local_products
                .map(p => p.global_id)
                .filter(id => id != null && id !== '');

            if (localGlobalIds.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'No se recibieron productos válidos con global_id'
                });
            }

            console.log(`[Productos/ForceSync] 🔍 GlobalIds válidos: ${localGlobalIds.length}`);

            // 1. Obtener productos actuales en PostgreSQL para este tenant
            const existingResult = await client.query(
                `SELECT id, global_id, descripcion, image_url
                 FROM productos
                 WHERE tenant_id = $1`,
                [tenantId]
            );

            const existingProducts = existingResult.rows;
            console.log(`[Productos/ForceSync] 📋 ${existingProducts.length} productos en PostgreSQL`);

            // 2. Identificar productos a eliminar (no están en la lista local)
            const localGlobalIdSet = new Set(localGlobalIds.map(id => id.toLowerCase()));
            const productsToDelete = existingProducts.filter(
                p => !localGlobalIdSet.has(p.global_id?.toLowerCase())
            );

            console.log(`[Productos/ForceSync] 🗑️ ${productsToDelete.length} productos a eliminar`);

            // 3. Eliminar productos que no existen localmente
            // SEGURO: Verificar si tienen historial (ventas, asignaciones, notas de crédito)
            // - Sin historial → HARD DELETE
            // - Con historial → SOFT DELETE (eliminado = true) para preservar integridad referencial
            const deletedProducts = [];
            const softDeletedProducts = [];
            for (const prod of productsToDelete) {
                // Verificar si el producto tiene registros asociados
                const hasHistory = await client.query(
                    `SELECT EXISTS(
                        SELECT 1 FROM ventas_detalle WHERE id_producto = $1
                        UNION ALL
                        SELECT 1 FROM repartidor_assignments WHERE product_id = $1
                        UNION ALL
                        SELECT 1 FROM repartidor_returns WHERE product_id = $1
                        UNION ALL
                        SELECT 1 FROM notas_credito_detalle WHERE producto_id = $1
                    ) AS has_refs`,
                    [prod.id]
                );

                if (hasHistory.rows[0]?.has_refs) {
                    // SOFT DELETE - producto tiene historial, no podemos eliminarlo sin romper registros
                    await client.query(
                        `UPDATE productos SET eliminado = TRUE, updated_at = NOW() WHERE id = $1`,
                        [prod.id]
                    );

                    softDeletedProducts.push({
                        id: prod.id,
                        global_id: prod.global_id,
                        descripcion: prod.descripcion,
                        reason: 'Tiene historial de ventas/asignaciones'
                    });

                    console.log(`[Productos/ForceSync] ⚠️ SOFT DELETE (tiene historial): ${prod.descripcion} (${prod.global_id})`);
                } else {
                    // HARD DELETE - producto sin historial, seguro de eliminar
                    // Eliminar imagen de Cloudinary si existe (excepto seeds compartidos)
                    if (prod.image_url && !prod.image_url.includes('sya-seed-products')) {
                        try {
                            const urlMatch = prod.image_url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
                            if (urlMatch) {
                                const publicId = urlMatch[1];
                                await cloudinaryService.deleteProductImage(publicId);
                                console.log(`[Productos/ForceSync] 🖼️ Imagen eliminada: ${publicId}`);
                            }
                        } catch (imgErr) {
                            console.log(`[Productos/ForceSync] ⚠️ Error eliminando imagen: ${imgErr.message}`);
                        }
                    }

                    await client.query(
                        `DELETE FROM productos WHERE id = $1`,
                        [prod.id]
                    );

                    deletedProducts.push({
                        id: prod.id,
                        global_id: prod.global_id,
                        descripcion: prod.descripcion
                    });

                    console.log(`[Productos/ForceSync] ❌ HARD DELETE: ${prod.descripcion} (${prod.global_id})`);
                }
            }

            // 4. Sincronizar/actualizar productos locales
            let inserted = 0;
            let updated = 0;

            for (const localProd of local_products) {
                if (!localProd.global_id) continue;

                try {
                    const result = await client.query(
                        `INSERT INTO productos (
                            tenant_id, id_producto, descripcion, categoria, categoria_global_id,
                            precio_compra, precio_venta, produccion, inventariar,
                            tipos_de_salida_id, notificar, minimo, inventario,
                            proveedor_id, unidad_medida_id, eliminado, bascula, is_pos_shortcut,
                            global_id, terminal_id, local_op_seq, created_local_utc,
                            device_event_raw, last_modified_local_utc,
                            needs_update, needs_delete, image_url,
                            created_at, updated_at
                        )
                        VALUES (
                            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                            $11, $12, $13, $14, $15, $16, $17, $18, $19,
                            $20, $21, $22, $23, $24, FALSE, FALSE, $25, NOW(), NOW()
                        )
                        ON CONFLICT (global_id) DO UPDATE
                        SET descripcion = EXCLUDED.descripcion,
                            categoria = EXCLUDED.categoria,
                            categoria_global_id = COALESCE(EXCLUDED.categoria_global_id, productos.categoria_global_id),
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
                            terminal_id = COALESCE(EXCLUDED.terminal_id, productos.terminal_id),
                            last_modified_local_utc = EXCLUDED.last_modified_local_utc,
                            needs_update = FALSE,
                            needs_delete = FALSE,
                            image_url = COALESCE(EXCLUDED.image_url, productos.image_url),
                            updated_at = NOW()
                        RETURNING (xmax = 0) AS inserted`,
                        [
                            tenantId,
                            localProd.id_producto || null,
                            localProd.descripcion,
                            localProd.categoria || null,
                            localProd.categoria_global_id || null,  // $5
                            localProd.precio_compra || 0,
                            localProd.precio_venta || 0,
                            localProd.produccion || false,
                            localProd.inventariar || false,
                            localProd.tipos_de_salida_id || null,
                            localProd.notificar || false,
                            localProd.minimo || 0,
                            localProd.inventario || 0,
                            localProd.proveedor_id || null,
                            localProd.unidad_medida_id || null,
                            localProd.eliminado || false,
                            localProd.bascula || false,
                            localProd.is_pos_shortcut || false,
                            localProd.global_id,
                            localProd.terminal_id || terminal_id || null,
                            localProd.local_op_seq || null,
                            localProd.created_local_utc || null,
                            localProd.device_event_raw || null,
                            localProd.last_modified_local_utc || null,
                            localProd.image_url || null  // $25
                        ]
                    );

                    if (result.rows[0]?.inserted) {
                        inserted++;
                    } else {
                        updated++;
                    }
                } catch (prodErr) {
                    console.log(`[Productos/ForceSync] ⚠️ Error con ${localProd.descripcion}: ${prodErr.message}`);
                }
            }

            await client.query('COMMIT');

            console.log(`[Productos/ForceSync] ✅ Completado: ${deletedProducts.length} hard-deleted, ${softDeletedProducts.length} soft-deleted, ${inserted} insertados, ${updated} actualizados`);

            res.json({
                success: true,
                message: 'Sincronización agresiva completada',
                data: {
                    deleted: deletedProducts.length,
                    deleted_products: deletedProducts,
                    soft_deleted: softDeletedProducts.length,
                    soft_deleted_products: softDeletedProducts,
                    inserted,
                    updated,
                    total_local: local_products.length
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Productos/ForceSync] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error en sincronización agresiva',
                error: undefined
            });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/check-code-exists - Verificar si código existe
    // ═══════════════════════════════════════════════════════════════
    // Usado antes de crear un producto para evitar duplicados entre PCs
    // ═══════════════════════════════════════════════════════════════
    router.post('/check-code-exists', async (req, res) => {
        try {
            const { tenant_id: tenantId, id_producto, descripcion, exclude_global_id } = req.body;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenant_id'
                });
            }

            console.log(`[Productos/CheckCode] 🔍 Verificando código ${id_producto} para tenant ${tenantId}`);

            // Buscar por id_producto (código/SKU)
            let query = `
                SELECT id, global_id, descripcion, terminal_id, id_producto
                FROM productos
                WHERE tenant_id = $1
                AND eliminado = FALSE
                AND (id_producto = $2 OR LOWER(descripcion) = LOWER($3))
            `;
            const params = [tenantId, id_producto, descripcion];

            // Excluir el producto actual si se está editando
            if (exclude_global_id) {
                query += ` AND global_id != $4`;
                params.push(exclude_global_id);
            }

            const result = await pool.query(query, params);

            const exists = result.rows.length > 0;
            const conflicts = result.rows.map(r => ({
                id: r.id,
                global_id: r.global_id,
                descripcion: r.descripcion,
                id_producto: r.id_producto,
                terminal_id: r.terminal_id
            }));

            console.log(`[Productos/CheckCode] ${exists ? '⚠️ CONFLICTO' : '✅ OK'}: ${conflicts.length} coincidencias`);

            res.json({
                success: true,
                exists,
                conflicts,
                message: exists
                    ? `Ya existe un producto con código ${id_producto} o descripción "${descripcion}"`
                    : 'Código disponible'
            });

        } catch (error) {
            console.error('[Productos/CheckCode] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error verificando código',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/productos/check-pending-duplicates - Verificar duplicados pendientes
    // ═══════════════════════════════════════════════════════════════
    // Llamado al iniciar la app para verificar productos que se crearon offline
    // ═══════════════════════════════════════════════════════════════
    router.post('/check-pending-duplicates', async (req, res) => {
        try {
            const { tenant_id: tenantId, products_to_check } = req.body;

            if (!tenantId || !products_to_check || !Array.isArray(products_to_check)) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenant_id y array products_to_check'
                });
            }

            console.log(`[Productos/CheckDuplicates] 🔍 Verificando ${products_to_check.length} productos para tenant ${tenantId}`);

            const duplicates = [];

            for (const prod of products_to_check) {
                const { global_id, id_producto, descripcion } = prod;

                // Buscar duplicados (mismo código o descripción, diferente global_id)
                const result = await pool.query(
                    `SELECT id, global_id, descripcion, terminal_id, id_producto, created_at
                     FROM productos
                     WHERE tenant_id = $1
                     AND eliminado = FALSE
                     AND global_id != $2
                     AND (id_producto = $3 OR LOWER(descripcion) = LOWER($4))`,
                    [tenantId, global_id, id_producto, descripcion]
                );

                if (result.rows.length > 0) {
                    duplicates.push({
                        local_product: prod,
                        conflicts: result.rows.map(r => ({
                            id: r.id,
                            global_id: r.global_id,
                            descripcion: r.descripcion,
                            id_producto: r.id_producto,
                            terminal_id: r.terminal_id,
                            created_at: r.created_at
                        }))
                    });
                }
            }

            console.log(`[Productos/CheckDuplicates] ${duplicates.length > 0 ? '⚠️' : '✅'} ${duplicates.length} productos con duplicados`);

            res.json({
                success: true,
                has_duplicates: duplicates.length > 0,
                duplicates,
                message: duplicates.length > 0
                    ? `Se encontraron ${duplicates.length} productos con posibles duplicados`
                    : 'No se encontraron duplicados'
            });

        } catch (error) {
            console.error('[Productos/CheckDuplicates] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error verificando duplicados',
                error: undefined
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
                error: undefined
            });
        }
    });

    return router;
};
