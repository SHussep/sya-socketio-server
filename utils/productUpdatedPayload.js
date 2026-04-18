// utils/productUpdatedPayload.js
// Canonical payload builder for the `product_updated` Socket.IO event.
//
// CONTEXT
// -------
// Desktop (WinUI) deserializes `product_updated` into `ProductUpdatedMessage`
// (see SocketIOService.cs). Its field names match PostgreSQL columns:
//   bascula, produccion, inventariar, notificar, minimo, precio_compra, etc.
//
// Several routes (repartidor_assignments, sales, repartidor_returns, etc.)
// historically emitted a slim partial payload where `bascula` was aliased as
// `pesable`. Desktop's deserializer therefore defaulted `Bascula` to false,
// and `ApplyRemoteUpdateAsync` overwrote the local value. Same issue hit
// `produccion`, `notificar`, `minimo` when those fields were omitted entirely.
//
// This helper guarantees every emission carries the full set of product
// columns the desktop expects, so incidental inventory-change notifications
// cannot silently corrupt unrelated product settings.

/**
 * Full column list to SELECT from `productos` when you plan to emit
 * `product_updated`. Import and concat into your query.
 */
const PRODUCT_UPDATED_COLUMNS = `
    id,
    tenant_id,
    id_producto,
    global_id,
    descripcion,
    categoria,
    precio_compra,
    precio_venta,
    produccion,
    inventariar,
    notificar,
    minimo,
    inventario,
    bascula,
    is_pos_shortcut,
    unidad_medida_id,
    proveedor_id,
    tipos_de_salida_id,
    image_url,
    eliminado
`;

/**
 * Build a complete `product_updated` payload from a `productos` row.
 *
 * @param {object} row - row from SELECT on productos (must include PRODUCT_UPDATED_COLUMNS)
 * @param {number|null} branchInv - branch-specific inventory (from getBranchInventarioForEmit).
 *                                  Pass null to fall back to the global productos.inventario.
 * @param {string} action - 'created' | 'updated' | 'deleted' | 'image_updated'
 * @returns {object} payload
 */
function buildProductUpdatedPayload(row, branchInv, action = 'updated') {
    const inventario = branchInv != null
        ? parseFloat(branchInv)
        : parseFloat(row.inventario || 0);

    return {
        id: row.id,
        id_producto: row.id_producto != null ? String(row.id_producto) : null,
        global_id: row.global_id,
        descripcion: row.descripcion,
        categoria: row.categoria,
        precio_compra: parseFloat(row.precio_compra || 0),
        precio_venta: parseFloat(row.precio_venta || 0),
        produccion: row.produccion === true,
        inventariar: row.inventariar === true,
        notificar: row.notificar === true,
        minimo: parseFloat(row.minimo || 0),
        inventario,
        bascula: row.bascula === true,
        // Legacy alias. Some older clients may still read `pesable`; keep
        // emitting it so a partial rollout doesn't regress those consumers.
        pesable: row.bascula === true,
        is_pos_shortcut: row.is_pos_shortcut === true,
        unidad_medida_id: row.unidad_medida_id,
        // Legacy alias used by a few early routes.
        unidad_medida: row.unidad_medida_id,
        proveedor_id: row.proveedor_id,
        tipos_de_salida_id: row.tipos_de_salida_id,
        image_url: row.image_url,
        eliminado: row.eliminado === true,
        action,
        updatedAt: new Date().toISOString()
    };
}

module.exports = { PRODUCT_UPDATED_COLUMNS, buildProductUpdatedPayload };
