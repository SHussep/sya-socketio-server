// utils/branchInventory.js
// Helper for per-branch inventory operations on producto_branches table

/**
 * Get current branch inventory for a product. Auto-creates producto_branches row
 * if missing (using global productos.inventario as seed value).
 *
 * @param {object} client - pg client (transaction) or pool
 * @param {number} tenantId
 * @param {number} branchId
 * @param {string} productGlobalId - TEXT string from productos.global_id
 * @param {number} globalInventario - fallback from productos.inventario
 * @returns {Promise<number>} current branch inventory
 */
async function getBranchStock(client, tenantId, branchId, productGlobalId, globalInventario) {
    let result = await client.query(
        `SELECT inventario FROM producto_branches
         WHERE tenant_id = $1 AND branch_id = $2 AND product_global_id = $3`,
        [tenantId, branchId, productGlobalId]
    );

    if (result.rows.length === 0) {
        // Auto-create row seeded with global inventory
        result = await client.query(
            `INSERT INTO producto_branches (tenant_id, branch_id, product_global_id, inventario, minimo, global_id)
             VALUES ($1, $2, $3, $4, 0, gen_random_uuid())
             ON CONFLICT (tenant_id, product_global_id, branch_id) DO NOTHING
             RETURNING inventario`,
            [tenantId, branchId, productGlobalId, globalInventario]
        );
        if (result.rows.length === 0) {
            // Row was created by concurrent process — re-read
            result = await client.query(
                `SELECT inventario FROM producto_branches
                 WHERE tenant_id = $1 AND branch_id = $2 AND product_global_id = $3`,
                [tenantId, branchId, productGlobalId]
            );
        }
        console.log(`[BranchInventory] Auto-created producto_branches row: tenant=${tenantId}, branch=${branchId}, product=${productGlobalId}, inventario=${globalInventario}`);
    }

    return parseFloat(result.rows[0]?.inventario ?? globalInventario);
}

/**
 * Deduct inventory from producto_branches and return before/after values.
 *
 * @param {object} client - pg client (inside transaction)
 * @param {number} tenantId
 * @param {number} branchId
 * @param {string} productGlobalId
 * @param {number} qty - positive number to deduct
 * @param {number} globalInventario - fallback seed value
 * @returns {Promise<{stockBefore: number, stockAfter: number}>}
 */
async function deductBranchStock(client, tenantId, branchId, productGlobalId, qty, globalInventario) {
    const stockBefore = await getBranchStock(client, tenantId, branchId, productGlobalId, globalInventario);
    const stockAfter = stockBefore - qty;

    await client.query(
        `UPDATE producto_branches
         SET inventario = inventario - $1, updated_at = NOW()
         WHERE tenant_id = $2 AND branch_id = $3 AND product_global_id = $4`,
        [qty, tenantId, branchId, productGlobalId]
    );

    return { stockBefore, stockAfter };
}

/**
 * Restore (add) inventory to producto_branches and return before/after values.
 *
 * @param {object} client - pg client (inside transaction)
 * @param {number} tenantId
 * @param {number} branchId
 * @param {string} productGlobalId
 * @param {number} qty - positive number to add back
 * @param {number} globalInventario - fallback seed value
 * @returns {Promise<{stockBefore: number, stockAfter: number}>}
 */
async function restoreBranchStock(client, tenantId, branchId, productGlobalId, qty, globalInventario) {
    const stockBefore = await getBranchStock(client, tenantId, branchId, productGlobalId, globalInventario);
    const stockAfter = stockBefore + qty;

    await client.query(
        `UPDATE producto_branches
         SET inventario = inventario + $1, updated_at = NOW()
         WHERE tenant_id = $2 AND branch_id = $3 AND product_global_id = $4`,
        [qty, tenantId, branchId, productGlobalId]
    );

    return { stockBefore, stockAfter };
}

/**
 * Get branch inventory for a product (for socket emit). Returns branch-specific
 * value or falls back to global.
 */
async function getBranchInventarioForEmit(pool, tenantId, branchId, productGlobalId, globalInventario) {
    const result = await pool.query(
        `SELECT inventario FROM producto_branches
         WHERE tenant_id = $1 AND branch_id = $2 AND product_global_id = $3`,
        [tenantId, branchId, productGlobalId]
    );
    return parseFloat(result.rows[0]?.inventario ?? globalInventario);
}

module.exports = { getBranchStock, deductBranchStock, restoreBranchStock, getBranchInventarioForEmit };
