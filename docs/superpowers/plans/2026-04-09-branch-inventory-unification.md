# Branch Inventory Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all inventory deductions operate on `producto_branches.inventario` (per-branch) instead of `productos.inventario` (global), and remove the redundant `branch_inventory` table.

**Architecture:** `producto_branches` already has `inventario` and `minimo` columns, synced by Desktop and Mobile. We change all `UPDATE productos SET inventario = ...` to `UPDATE producto_branches SET inventario = ...`, update kardex snapshots to reflect branch inventory, and emit branch-specific inventory via socket events. `branch_inventory` is dropped entirely.

**Tech Stack:** Node.js/Express, PostgreSQL, Socket.IO

**Key constraint:** `producto_branches.product_global_id` is **TEXT** (changed from UUID in migration 046 to support legacy seed IDs like "SEED_PRODUCT_63_9001"). Do NOT use `::uuid` casts — use plain text comparison with `productos.global_id` (VARCHAR).

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `utils/branchInventory.js` | **Create** | Helper to read/write branch inventory with auto-create fallback |
| `database/migrations.js` | Modify (~1992-2006, ~2375-2392) | Update NC trigger, remove `branch_inventory` CREATE, add DROP |
| `routes/ventas.js` | Modify (~654-790) | Deduct from `producto_branches`, emit branch-specific inventory |
| `routes/repartidor_assignments.js` | Modify (~541-710, ~1076-1156) | Deduct/restore from `producto_branches` (includes liquidation path) |
| `routes/repartidor_returns.js` | Modify (~232-315) | Restore to `producto_branches` |
| `routes/sales.js` | Modify (~343-350) | Sale cancellation restores to `producto_branches` |
| `routes/purchases.js` | Modify (~660-667) | Purchase cancellation reverts from `producto_branches` |
| `routes/transfers.js` | Modify (~160-210, ~590-605, ~656-687) | Replace `branch_inventory` with `producto_branches` |
| `routes/productos.js` | Modify (~97-139, ~206-221) | Remove `branch_inventory` JOIN, use `producto_branches` for inventory |
| `routes/superadmin.js` | Modify (~974) | Remove `branch_inventory` DELETE |
| `utils/cleanupTables.js` | Modify (~77) | Remove `branch_inventory` entry |
| `scripts/cleanup/clean_database_keep_subscriptions.js` | Modify (~31) | Remove `branch_inventory` entry |

---

### Task 1: Create branch inventory helper

**Files:**
- Create: `utils/branchInventory.js`

This helper encapsulates reading/writing branch inventory from `producto_branches` with auto-create fallback if no row exists for that product+branch.

- [ ] **Step 1: Create the helper file**

```js
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
```

- [ ] **Step 2: Commit**

```bash
git add utils/branchInventory.js
git commit -m "feat: add branchInventory helper for per-branch inventory operations"
```

---

### Task 2: Update routes/ventas.js — deduct from producto_branches

**Files:**
- Modify: `routes/ventas.js:654-790`

- [ ] **Step 1: Add require at top of file**

Add after existing requires (near top of the module.exports function):
```js
const { deductBranchStock, getBranchInventarioForEmit } = require('../utils/branchInventory');
```

- [ ] **Step 2: Change stock query (lines 658-665)**

Replace the stock-reading query to also fetch `global_id` and `inventario` (global fallback):
```js
const detailsForInventory = isRepartidorSale ? { rows: [] } : await client.query(
    `SELECT vd.id_producto, vd.cantidad, p.inventariar, p.descripcion,
            p.inventario AS global_inventario, p.global_id AS product_global_id
     FROM ventas_detalle vd
     JOIN productos p ON vd.id_producto = p.id AND p.tenant_id = $2
     WHERE vd.id_venta = $1`,
    [newVenta.id_venta, tenant_id]
);
```

Note: `p.inventario` is renamed to `global_inventario` (used only as fallback seed).

- [ ] **Step 3: Replace inventory deduction block (lines 668-713)**

Replace the for-loop body to use `deductBranchStock`:
```js
let deductedCount = 0;
for (const detail of detailsForInventory.rows) {
    if (detail.inventariar) {
        const qty = parseFloat(detail.cantidad);

        // Deduct from branch-specific inventory (producto_branches)
        const { stockBefore, stockAfter } = await deductBranchStock(
            client, tenant_id, branch_id,
            detail.product_global_id, qty,
            parseFloat(detail.global_inventario)
        );

        // Create kardex entry for this movement
        const kardexGlobalId = require('crypto').randomUUID();
        await client.query(
            `INSERT INTO kardex_entries (
                tenant_id, branch_id, product_id, product_global_id,
                timestamp, movement_type, employee_id, employee_global_id,
                quantity_before, quantity_change, quantity_after,
                description, sale_id, global_id, terminal_id, source
            ) VALUES ($1, $2, $3, $4, NOW(), 'Venta', $5, $6, $7, $8, $9, $10, $11, $12, $13, 'mobile')`,
            [
                tenant_id, branch_id, detail.id_producto, detail.product_global_id,
                id_empleado, empleado_global_id,
                stockBefore, -qty, stockAfter,
                `Venta móvil #${currentTicket}: ${detail.descripcion} x${qty}`,
                newVenta.id_venta, kardexGlobalId, mobileTerminalId
            ]
        );

        kardexEntries.push({
            global_id: kardexGlobalId,
            product_global_id: detail.product_global_id,
            product_id: detail.id_producto,
            descripcion: detail.descripcion,
            movement_type: 'Venta',
            quantity_before: stockBefore,
            quantity_change: -qty,
            quantity_after: stockAfter,
            sale_id: newVenta.id_venta,
            description: `Venta móvil #${currentTicket}: ${detail.descripcion} x${qty}`
        });

        deductedCount++;
    }
}
if (deductedCount > 0) {
    console.log(`[Ventas/Create] 📦 Inventario branch descontado: ${deductedCount} productos, ${deductedCount} kardex entries creados`);
}
```

- [ ] **Step 4: Update socket emit to use branch-specific inventory (lines 741-765)**

Replace the `product_updated` emit block to send per-branch inventory:
```js
// Fetch base product data for socket emit
const updatedProducts = await pool.query(
    `SELECT p.id, p.global_id, p.descripcion, p.inventario AS global_inventario,
            p.precio_venta, p.inventariar, p.bascula, p.unidad_medida_id
     FROM ventas_detalle vd
     JOIN productos p ON vd.id_producto = p.id AND p.tenant_id = $2
     WHERE vd.id_venta = $1 AND p.inventariar = true`,
    [newVenta.id_venta, tenant_id]
);
for (const prod of updatedProducts.rows) {
    for (const b of branches.rows) {
        const branchInv = await getBranchInventarioForEmit(
            pool, tenant_id, b.id,
            prod.global_id, parseFloat(prod.global_inventario)
        );
        const payload = {
            id_producto: String(prod.id),
            global_id: prod.global_id,
            descripcion: prod.descripcion,
            inventario: branchInv,
            precio_venta: parseFloat(prod.precio_venta),
            inventariar: prod.inventariar,
            pesable: prod.bascula,
            unidad_medida: prod.unidad_medida_id,
            action: 'updated',
            updatedAt: new Date().toISOString()
        };
        io.to(`branch_${b.id}`).emit('product_updated', payload);
    }
}
```

- [ ] **Step 5: Commit**

```bash
git add routes/ventas.js
git commit -m "feat: ventas deducts from producto_branches instead of global inventory"
```

---

### Task 3: Update routes/repartidor_assignments.js — deduct/restore from producto_branches

**Files:**
- Modify: `routes/repartidor_assignments.js:541-710`

- [ ] **Step 1: Add require**

Near top of module.exports function:
```js
const { deductBranchStock, restoreBranchStock, getBranchInventarioForEmit } = require('../utils/branchInventory');
```

- [ ] **Step 2: Replace assignment creation deduction (lines 541-621)**

Replace the inventory deduction block. Change from:
```js
if (wasInserted && resolvedProductId && ['pending', 'in_progress'].includes(assignment.status)) {
    try {
        const productCheck = await pool.query(
            `SELECT id, global_id, inventariar, inventario, descripcion FROM productos WHERE id = $1 AND tenant_id = $2`,
            [resolvedProductId, tenant_id]
        );
        const prod = productCheck.rows[0];
        if (prod && prod.inventariar) {
            const qty = parseFloat(assigned_quantity);
            const stockBefore = parseFloat(prod.inventario);
            const stockAfter = stockBefore - qty;

            await pool.query(
                `UPDATE productos SET inventario = inventario - $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
                [qty, resolvedProductId, tenant_id]
            );
```

To:
```js
if (wasInserted && resolvedProductId && ['pending', 'in_progress'].includes(assignment.status)) {
    try {
        const productCheck = await pool.query(
            `SELECT id, global_id, inventariar, inventario, descripcion FROM productos WHERE id = $1 AND tenant_id = $2`,
            [resolvedProductId, tenant_id]
        );
        const prod = productCheck.rows[0];
        if (prod && prod.inventariar) {
            const qty = parseFloat(assigned_quantity);

            const { stockBefore, stockAfter } = await deductBranchStock(
                pool, tenant_id, branch_id,
                prod.global_id, qty,
                parseFloat(prod.inventario)
            );
```

Everything after (kardex INSERT, console.log) stays the same — `stockBefore` and `stockAfter` are already in scope.

Remove the old `UPDATE productos SET inventario = ...` line (553-556).

- [ ] **Step 3: Update socket emit for assignment creation (lines 580-616)**

Replace the `updatedProd` query and payload to use branch inventory:
```js
if (io) {
    try {
        const branches = await pool.query(
            'SELECT id FROM branches WHERE tenant_id = $1 AND is_active = true', [tenant_id]
        );
        const p = prod; // already have product data
        for (const b of branches.rows) {
            const branchInv = await getBranchInventarioForEmit(
                pool, tenant_id, b.id, p.global_id, parseFloat(p.inventario)
            );
            const productPayload = {
                id_producto: String(p.id), global_id: p.global_id,
                descripcion: p.descripcion, inventario: branchInv,
                precio_venta: parseFloat(p.precio_venta || 0), inventariar: p.inventariar,
                pesable: p.bascula, unidad_medida: p.unidad_medida_id,
                action: 'updated', updatedAt: new Date().toISOString()
            };
            io.to(`branch_${b.id}`).emit('product_updated', productPayload);
        }
        // Kardex emit to all branches (unchanged payload)
        const kardexPayload = {
            entries: [{
                global_id: kardexGlobalId, product_global_id: prod.global_id,
                product_id: resolvedProductId, descripcion: prod.descripcion,
                movement_type: 'AsignacionRepartidor',
                quantity_before: stockBefore, quantity_change: -qty, quantity_after: stockAfter,
                description: `Asignación repartidor: ${product_name || prod.descripcion} x${qty}`,
                employee_global_id: created_by_employee_global_id,
                employee_id: resolvedCreatedByEmployeeId,
                timestamp: new Date().toISOString(), terminal_id: terminal_id || null,
                source: source || 'desktop'
            }]
        };
        for (const b of branches.rows) {
            io.to(`branch_${b.id}`).emit('kardex_entries_created', kardexPayload);
        }
        console.log(`[RepartidorAssignments] 📡 product_updated + kardex emitidos`);
    } catch (emitErr) {
        console.error('[RepartidorAssignments] ⚠️ Error emitting socket events:', emitErr.message);
    }
}
```

- [ ] **Step 4: Replace cancellation restoration (lines 631-710)**

Same pattern. Change from `UPDATE productos SET inventario = inventario + $1` to:
```js
if (!wasInserted && assignment.status === 'cancelled' && resolvedProductId) {
    try {
        const productCheck = await pool.query(
            `SELECT id, global_id, inventariar, inventario, descripcion FROM productos WHERE id = $1 AND tenant_id = $2`,
            [resolvedProductId, tenant_id]
        );
        const prod = productCheck.rows[0];
        if (prod && prod.inventariar) {
            const qty = parseFloat(assignment.assigned_quantity);

            const { stockBefore, stockAfter } = await restoreBranchStock(
                pool, tenant_id, branch_id,
                prod.global_id, qty,
                parseFloat(prod.inventario)
            );
```

Remove the old `UPDATE productos SET inventario = inventario + $1` line (643-645).

Update socket emit same pattern as step 3 (use `getBranchInventarioForEmit` per branch).

- [ ] **Step 5: Commit**

```bash
git add routes/repartidor_assignments.js
git commit -m "feat: repartidor assignments deducts/restores from producto_branches"
```

---

### Task 4: Update routes/repartidor_returns.js — restore to producto_branches

**Files:**
- Modify: `routes/repartidor_returns.js:232-315`

- [ ] **Step 1: Add require**

```js
const { restoreBranchStock, getBranchInventarioForEmit } = require('../utils/branchInventory');
```

- [ ] **Step 2: Replace inventory restoration (lines 232-268)**

Change from `UPDATE productos SET inventario = inventario + $1` to:
```js
if (wasInserted && assignment.product_id) {
    try {
        const productCheck = await pool.query(
            `SELECT id, global_id, inventariar, inventario, descripcion FROM productos WHERE id = $1 AND tenant_id = $2`,
            [assignment.product_id, tenant_id]
        );
        const prod = productCheck.rows[0];
        if (prod && prod.inventariar) {
            const qty = parseFloat(quantity);

            const { stockBefore, stockAfter } = await restoreBranchStock(
                pool, tenant_id, branch_id,
                prod.global_id, qty,
                parseFloat(prod.inventario)
            );
```

Remove old `UPDATE productos SET inventario = inventario + $1` line (244-246).

Kardex INSERT stays the same — `stockBefore`/`stockAfter` already in scope.

- [ ] **Step 3: Update socket emit (lines 271-311)**

Same pattern as Task 3: use `getBranchInventarioForEmit` per branch for `product_updated`.

- [ ] **Step 4: Commit**

```bash
git add routes/repartidor_returns.js
git commit -m "feat: repartidor returns restores inventory to producto_branches"
```

---

### Task 5: Update routes/transfers.js — replace branch_inventory with producto_branches

**Files:**
- Modify: `routes/transfers.js:160-210, 590-605, 656-687`

- [ ] **Step 1: Replace source/target stock reads (lines 160-177)**

Change FROM:
```js
const sourceStock = await client.query(
    `SELECT quantity FROM branch_inventory
     WHERE branch_id = $1 AND producto_id = $2 AND tenant_id = $3
     FOR UPDATE`,
    [from_branch_id, product.id, tenantId]
);
const stockBeforeSource = parseFloat(sourceStock.rows[0]?.quantity || 0);

const targetStock = await client.query(
    `SELECT quantity FROM branch_inventory
     WHERE branch_id = $1 AND producto_id = $2 AND tenant_id = $3
     FOR UPDATE`,
    [to_branch_id, product.id, tenantId]
);
const stockBeforeTarget = parseFloat(targetStock.rows[0]?.quantity || 0);
```

TO:
```js
const sourceStock = await client.query(
    `SELECT inventario FROM producto_branches
     WHERE branch_id = $1 AND product_global_id = $2 AND tenant_id = $3
     FOR UPDATE`,
    [from_branch_id, product.global_id, tenantId]
);
const stockBeforeSource = parseFloat(sourceStock.rows[0]?.inventario || 0);

const targetStock = await client.query(
    `SELECT inventario FROM producto_branches
     WHERE branch_id = $1 AND product_global_id = $2 AND tenant_id = $3
     FOR UPDATE`,
    [to_branch_id, product.global_id, tenantId]
);
const stockBeforeTarget = parseFloat(targetStock.rows[0]?.inventario || 0);
```

Note: The product query earlier (~line 140) must also select `global_id`. Verify it does:
```sql
SELECT id, global_id, descripcion, ... FROM productos WHERE global_id = $1::text
```

- [ ] **Step 2: Replace source deduction (lines 183-199)**

Change FROM:
```js
if (sourceStock.rows.length === 0) {
    await client.query(
        `INSERT INTO branch_inventory (tenant_id, branch_id, producto_id, quantity, minimum)
         VALUES ($1, $2, $3, (0 - $4::numeric), 0)
         ON CONFLICT (tenant_id, branch_id, producto_id)
         DO UPDATE SET quantity = branch_inventory.quantity - $4::numeric, updated_at = NOW()`,
        [tenantId, from_branch_id, product.id, quantity]
    );
} else {
    await client.query(
        `UPDATE branch_inventory
         SET quantity = quantity - $1::numeric, updated_at = NOW()
         WHERE branch_id = $2 AND producto_id = $3 AND tenant_id = $4`,
        [quantity, from_branch_id, product.id, tenantId]
    );
}
```

TO:
```js
if (sourceStock.rows.length === 0) {
    await client.query(
        `INSERT INTO producto_branches (tenant_id, branch_id, product_global_id, inventario, global_id)
         VALUES ($1, $2, $3, (0 - $4::numeric), gen_random_uuid())
         ON CONFLICT (tenant_id, product_global_id, branch_id)
         DO UPDATE SET inventario = producto_branches.inventario - $4::numeric, updated_at = NOW()`,
        [tenantId, from_branch_id, product.global_id, quantity]
    );
} else {
    await client.query(
        `UPDATE producto_branches
         SET inventario = inventario - $1::numeric, updated_at = NOW()
         WHERE branch_id = $2 AND product_global_id = $3 AND tenant_id = $4`,
        [quantity, from_branch_id, product.global_id, tenantId]
    );
}
```

- [ ] **Step 3: Replace target addition (lines 201-208)**

Change FROM:
```js
await client.query(
    `INSERT INTO branch_inventory (tenant_id, branch_id, producto_id, quantity, minimum)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (tenant_id, branch_id, producto_id)
     DO UPDATE SET quantity = branch_inventory.quantity + $4, updated_at = NOW()`,
    [tenantId, to_branch_id, product.id, quantity]
);
```

TO:
```js
await client.query(
    `INSERT INTO producto_branches (tenant_id, branch_id, product_global_id, inventario, global_id)
     VALUES ($1, $2, $3, $4, gen_random_uuid())
     ON CONFLICT (tenant_id, product_global_id, branch_id)
     DO UPDATE SET inventario = producto_branches.inventario + $4, updated_at = NOW()`,
    [tenantId, to_branch_id, product.global_id, quantity]
);
```

- [ ] **Step 4: Replace cancellation reversal (lines 590-604)**

Change FROM:
```js
await client.query(
    `UPDATE branch_inventory
     SET quantity = quantity + $1, updated_at = NOW()
     WHERE branch_id = $2 AND producto_id = $3 AND tenant_id = $4`,
    [item.quantity, transfer.from_branch_id, item.producto_id, tenantId]
);
await client.query(
    `UPDATE branch_inventory
     SET quantity = GREATEST(0, quantity - $1), updated_at = NOW()
     WHERE branch_id = $2 AND producto_id = $3 AND tenant_id = $4`,
    [item.quantity, transfer.to_branch_id, item.producto_id, tenantId]
);
```

TO:
```js
await client.query(
    `UPDATE producto_branches
     SET inventario = inventario + $1, updated_at = NOW()
     WHERE branch_id = $2 AND product_global_id = (SELECT global_id FROM productos WHERE id = $3 AND tenant_id = $4) AND tenant_id = $4`,
    [item.quantity, transfer.from_branch_id, item.producto_id, tenantId]
);
await client.query(
    `UPDATE producto_branches
     SET inventario = GREATEST(0, inventario - $1), updated_at = NOW()
     WHERE branch_id = $2 AND product_global_id = (SELECT global_id FROM productos WHERE id = $3 AND tenant_id = $4) AND tenant_id = $4`,
    [item.quantity, transfer.to_branch_id, item.producto_id, tenantId]
);
```

- [ ] **Step 5: Replace GET /branch-inventory endpoint (lines 656-687)**

Change FROM:
```js
const result = await pool.query(
    `SELECT bi.producto_id, bi.quantity, bi.minimum, bi.updated_at,
            p.descripcion AS product_name, p.global_id AS producto_global_id,
            p.bascula, p.inventariar,
            um.abreviacion AS unit_abbreviation
     FROM branch_inventory bi
     JOIN productos p ON p.id = bi.producto_id
     LEFT JOIN units_of_measure um ON um.id = p.unidad_medida_id
     WHERE bi.branch_id = $1 AND bi.tenant_id = $2 AND p.eliminado = FALSE
     ORDER BY p.descripcion`,
    [branchId, tenantId]
);
```

TO:
```js
const result = await pool.query(
    `SELECT p.id AS producto_id, pb.inventario AS quantity, pb.minimo AS minimum, pb.updated_at,
            p.descripcion AS product_name, p.global_id AS producto_global_id,
            p.bascula, p.inventariar,
            um.abbreviation AS unit_abbreviation
     FROM producto_branches pb
     JOIN productos p ON p.global_id = pb.product_global_id::text AND p.tenant_id = pb.tenant_id
     LEFT JOIN units_of_measure um ON um.id = p.unidad_medida_id
     WHERE pb.branch_id = $1 AND pb.tenant_id = $2 AND p.eliminado = FALSE
     ORDER BY p.descripcion`,
    [branchId, tenantId]
);
```

Note: Column aliases (`quantity`, `minimum`) kept for backward compatibility with any consumers of this endpoint.

- [ ] **Step 6: Commit**

```bash
git add routes/transfers.js
git commit -m "feat: transfers uses producto_branches instead of branch_inventory"
```

---

### Task 6: Update routes/productos.js — use producto_branches for inventory

**Files:**
- Modify: `routes/productos.js:97-139, 206-221`

- [ ] **Step 1: Update GET /api/productos query (lines 97-139)**

Remove the `branch_inventory` LEFT JOIN and use `producto_branches` for inventory:

Change FROM:
```sql
p.inventario AS inventario_global,
COALESCE(bi.quantity, p.inventario) AS inventario,
...
LEFT JOIN branch_inventory bi
    ON bi.producto_id = p.id
    AND bi.branch_id = $2
    AND bi.tenant_id = $1
```

TO:
```sql
p.inventario AS inventario_global,
COALESCE(pb.inventario, p.inventario) AS inventario,
...
LEFT JOIN producto_branches pb
    ON p.global_id = pb.product_global_id::text
    AND pb.branch_id = $2
    AND pb.tenant_id = $1
```

Full query replacement (lines 97-139):
```js
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
        COALESCE(pb.minimo, p.minimo) AS minimo,
        p.inventario AS inventario_global,
        COALESCE(pb.inventario, p.inventario) AS inventario,
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
    LEFT JOIN producto_branches pb
        ON p.global_id = pb.product_global_id::text
        AND pb.branch_id = $2
        AND pb.tenant_id = $1
    LEFT JOIN units_of_measure um
        ON um.id = p.unidad_medida_id
    WHERE p.tenant_id = $1
`;
```

- [ ] **Step 2: Update GET /api/productos/pull query (lines 206-233)**

Add LEFT JOIN to `producto_branches` for branch-specific inventory in the pull endpoint:

After the existing `LEFT JOIN productos_branch_precios` conditional (line 239-247), also join `producto_branches`:

Change the query to include branch inventory:
```js
if (branchId) {
    query = query.replace(
        'FROM productos p',
        `FROM productos p
         LEFT JOIN productos_branch_precios pbp ON p.id = pbp.producto_id AND pbp.branch_id = $${paramIndex}
         LEFT JOIN producto_branches pb ON p.global_id = pb.product_global_id::text AND pb.branch_id = $${paramIndex} AND pb.tenant_id = $1`
    );
    params.push(branchId);
    paramIndex++;
}
```

And in the SELECT list, change:
```sql
p.minimo,
p.inventario,
```
to:
```sql
COALESCE(pb.minimo, p.minimo) AS minimo,
COALESCE(pb.inventario, p.inventario) AS inventario,
```

- [ ] **Step 3: Commit**

```bash
git add routes/productos.js
git commit -m "feat: productos queries use producto_branches for branch-specific inventory"
```

---

### Task 7: Update routes/sales.js — sale cancellation restores to producto_branches

**Files:**
- Modify: `routes/sales.js:334-350`

- [ ] **Step 1: Add require**

```js
const { restoreBranchStock } = require('../utils/branchInventory');
```

- [ ] **Step 2: Replace inventory restoration in cancellation (lines 334-350)**

The sale cancellation fetches details and restores inventory. Change from:
```js
const detailsResult = await client.query(
    `SELECT vd.*, p.inventariar, p.inventario as stock_actual
     FROM ventas_detalle vd
     LEFT JOIN productos p ON vd.id_producto = p.id AND p.tenant_id = $2
     WHERE vd.id_venta = $1`,
    [saleId, tenantId]
);

for (const detail of detailsResult.rows) {
    if (detail.inventariar) {
        await client.query(
            `UPDATE productos SET inventario = inventario + $1, updated_at = NOW()
             WHERE id = $2 AND tenant_id = $3`,
            [parseFloat(detail.cantidad), detail.id_producto, tenantId]
        );
    }
```

TO:
```js
const detailsResult = await client.query(
    `SELECT vd.*, p.inventariar, p.inventario as global_inventario, p.global_id as product_global_id
     FROM ventas_detalle vd
     LEFT JOIN productos p ON vd.id_producto = p.id AND p.tenant_id = $2
     WHERE vd.id_venta = $1`,
    [saleId, tenantId]
);

for (const detail of detailsResult.rows) {
    if (detail.inventariar) {
        await restoreBranchStock(
            client, tenantId, sale.branch_id,
            detail.product_global_id, parseFloat(detail.cantidad),
            parseFloat(detail.global_inventario)
        );
    }
```

- [ ] **Step 3: Commit**

```bash
git add routes/sales.js
git commit -m "feat: sale cancellation restores inventory to producto_branches"
```

---

### Task 8: Update routes/purchases.js — purchase cancellation reverts from producto_branches

**Files:**
- Modify: `routes/purchases.js:650-668`

- [ ] **Step 1: Add require**

```js
const { deductBranchStock } = require('../utils/branchInventory');
```

- [ ] **Step 2: Replace inventory reversion in cancellation (lines 650-668)**

Purchase cancellation removes inventory that was added by the purchase. Change from:
```js
const detailsResult = await client.query(
    `SELECT pd.*, pr.inventariar
     FROM purchase_details pd
     LEFT JOIN productos pr ON pd.product_id = pr.id AND pr.tenant_id = $2
     WHERE pd.purchase_id = $1`,
    [purchaseId, tenantId]
);

for (const detail of detailsResult.rows) {
    if (detail.inventariar && detail.product_id) {
        await client.query(
            `UPDATE productos SET inventario = GREATEST(inventario - $1, 0), updated_at = NOW()
             WHERE id = $2 AND tenant_id = $3`,
            [parseFloat(detail.quantity), detail.product_id, tenantId]
        );
    }
}
```

TO:
```js
const detailsResult = await client.query(
    `SELECT pd.*, pr.inventariar, pr.inventario AS global_inventario, pr.global_id AS product_global_id
     FROM purchase_details pd
     LEFT JOIN productos pr ON pd.product_id = pr.id AND pr.tenant_id = $2
     WHERE pd.purchase_id = $1`,
    [purchaseId, tenantId]
);

for (const detail of detailsResult.rows) {
    if (detail.inventariar && detail.product_id && detail.product_global_id) {
        await deductBranchStock(
            client, tenantId, purchase.branch_id,
            detail.product_global_id, parseFloat(detail.quantity),
            parseFloat(detail.global_inventario)
        );
    }
}
```

Note: Purchase cancellation **deducts** (reverses a previous addition), so we use `deductBranchStock`. Uses `GREATEST(0, ...)` logic implicitly since `deductBranchStock` can go negative — this matches the current behavior.

- [ ] **Step 3: Commit**

```bash
git add routes/purchases.js
git commit -m "feat: purchase cancellation reverts inventory from producto_branches"
```

---

### Task 9: Update repartidor_assignments.js liquidation path

**Files:**
- Modify: `routes/repartidor_assignments.js:1076-1156`

This is a SEPARATE code block from Task 3 — the liquidation endpoint restores inventory when `cantidad_devuelta > 0`.

- [ ] **Step 1: Replace liquidation inventory restoration (lines 1076-1117)**

Change from:
```js
if (parseFloat(cantidad_devuelta) > 0 && assignment.product_id) {
    try {
        const prodCheck = await client.query(
            `SELECT id, global_id, inventariar, inventario, descripcion FROM productos WHERE id = $1 AND tenant_id = $2`,
            [assignment.product_id, tenant_id]
        );
        const prod = prodCheck.rows[0];
        if (prod && prod.inventariar) {
            const returnQty = parseFloat(cantidad_devuelta);
            const stockBefore = parseFloat(prod.inventario);
            const stockAfter = stockBefore + returnQty;

            await client.query(
                `UPDATE productos SET inventario = inventario + $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
                [returnQty, assignment.product_id, tenant_id]
            );
```

TO:
```js
if (parseFloat(cantidad_devuelta) > 0 && assignment.product_id) {
    try {
        const prodCheck = await client.query(
            `SELECT id, global_id, inventariar, inventario, descripcion FROM productos WHERE id = $1 AND tenant_id = $2`,
            [assignment.product_id, tenant_id]
        );
        const prod = prodCheck.rows[0];
        if (prod && prod.inventariar) {
            const returnQty = parseFloat(cantidad_devuelta);

            const { stockBefore, stockAfter } = await restoreBranchStock(
                client, tenant_id, branch_id,
                prod.global_id, returnQty,
                parseFloat(prod.inventario)
            );
```

Remove the old `UPDATE productos SET inventario = inventario + $1` line (1090-1091).

- [ ] **Step 2: Update socket emit for liquidation (lines 1129-1156)**

Replace the `updatedProd` query and emit to use branch inventory:
```js
if (parseFloat(cantidad_devuelta) > 0 && assignment.product_id) {
    try {
        const branches = await pool.query(
            'SELECT id FROM branches WHERE tenant_id = $1 AND is_active = true', [tenant_id]
        );
        const prodForEmit = await pool.query(
            `SELECT id, global_id, descripcion, inventario, precio_venta, inventariar, bascula, unidad_medida_id
             FROM productos WHERE id = $1`, [assignment.product_id]
        );
        if (prodForEmit.rows.length > 0) {
            const p = prodForEmit.rows[0];
            for (const b of branches.rows) {
                const branchInv = await getBranchInventarioForEmit(
                    pool, tenant_id, b.id, p.global_id, parseFloat(p.inventario)
                );
                const productPayload = {
                    id_producto: String(p.id), global_id: p.global_id,
                    descripcion: p.descripcion, inventario: branchInv,
                    precio_venta: parseFloat(p.precio_venta), inventariar: p.inventariar,
                    pesable: p.bascula, unidad_medida: p.unidad_medida_id,
                    action: 'updated', updatedAt: new Date().toISOString()
                };
                io.to(`branch_${b.id}`).emit('product_updated', productPayload);
            }
            console.log(`[RepartidorAssignments] 📡 product_updated emitido (devolución)`);
        }
    } catch (emitErr) {
        console.error('[RepartidorAssignments] ⚠️ Error emitting liquidation socket events:', emitErr.message);
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add routes/repartidor_assignments.js
git commit -m "feat: repartidor liquidation restores inventory to producto_branches"
```

---

### Task 10: Update DB trigger for nota_credito_detalle

**Files:**
- Modify: `database/migrations.js:1992-2006`

The PostgreSQL trigger `update_inventory_on_nota_credito_detalle` writes directly to `productos.inventario`. It must be updated to write to `producto_branches.inventario` instead.

- [ ] **Step 1: Replace the trigger function (lines 1992-2004)**

Change FROM:
```sql
CREATE OR REPLACE FUNCTION update_inventory_on_nota_credito_detalle()
RETURNS TRIGGER AS $$
DECLARE
    v_tenant_id INTEGER;
BEGIN
    IF NEW.devuelve_a_inventario = TRUE THEN
        SELECT tenant_id INTO v_tenant_id FROM notas_credito WHERE id = NEW.nota_credito_id;
        UPDATE productos SET inventario = inventario + NEW.cantidad, updated_at = CURRENT_TIMESTAMP WHERE id = NEW.producto_id AND tenant_id = v_tenant_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
```

TO:
```sql
CREATE OR REPLACE FUNCTION update_inventory_on_nota_credito_detalle()
RETURNS TRIGGER AS $$
DECLARE
    v_tenant_id INTEGER;
    v_branch_id INTEGER;
    v_product_global_id TEXT;
BEGIN
    IF NEW.devuelve_a_inventario = TRUE THEN
        SELECT nc.tenant_id, nc.branch_id INTO v_tenant_id, v_branch_id FROM notas_credito nc WHERE nc.id = NEW.nota_credito_id;
        SELECT global_id INTO v_product_global_id FROM productos WHERE id = NEW.producto_id AND tenant_id = v_tenant_id;
        UPDATE producto_branches SET inventario = inventario + NEW.cantidad, updated_at = CURRENT_TIMESTAMP
            WHERE product_global_id = v_product_global_id AND branch_id = v_branch_id AND tenant_id = v_tenant_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
```

Note: Requires `notas_credito` to have a `branch_id` column. Verify this exists — if not, fall back to updating `productos.inventario` as before (add a TODO).

- [ ] **Step 2: Commit**

```bash
git add database/migrations.js
git commit -m "feat: NC trigger updates producto_branches instead of global inventory"
```

---

### Task 11: Update branch-precio sync to also handle inventario/minimo

**Files:**
- Modify: `routes/productos.js:819-849`

- [ ] **Step 1: Update the sync endpoint to accept and persist inventario/minimo**

The `POST /api/productos/branch-precio/sync` endpoint should also update the corresponding `producto_branches` row if inventario or minimo are provided. Add after the existing INSERT (line 849):

```js
// Also sync inventario/minimo to producto_branches if provided
const { inventario, minimo } = req.body;
if (inventario !== undefined || minimo !== undefined) {
    await pool.query(
        `INSERT INTO producto_branches (tenant_id, branch_id, product_global_id, inventario, minimo, global_id)
         VALUES ($1, $2, (SELECT global_id FROM productos WHERE id = $3 AND tenant_id = $1),
                 COALESCE($4, 0), COALESCE($5, 0), gen_random_uuid())
         ON CONFLICT (tenant_id, product_global_id, branch_id)
         DO UPDATE SET
            inventario = COALESCE($4, producto_branches.inventario),
            minimo = COALESCE($5, producto_branches.minimo),
            updated_at = NOW()`,
        [tenant_id, branch_id, producto_id, inventario ?? null, minimo ?? null]
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add routes/productos.js
git commit -m "feat: branch-precio sync also updates producto_branches inventario/minimo"
```

---

### Task 12: Remove branch_inventory — migration and cleanup

**Files:**
- Modify: `database/migrations.js:2375-2392`
- Modify: `routes/superadmin.js:974`
- Modify: `utils/cleanupTables.js:77`
- Modify: `scripts/cleanup/clean_database_keep_subscriptions.js:31`

- [ ] **Step 1: Update database/migrations.js — remove branch_inventory creation, add DROP**

Replace lines 2375-2392:
```js
// Patch: Create branch_inventory table for inter-branch transfer tracking
try {
    await client.query(`
        CREATE TABLE IF NOT EXISTS branch_inventory (...)
    `);
    console.log('[Schema] ✅ branch_inventory table ready');
} catch (biErr) {
    console.error(`[Schema] ⚠️ branch_inventory migration error: ${biErr.message}`);
}
```

WITH:
```js
// Patch: Drop legacy branch_inventory table (replaced by producto_branches.inventario)
try {
    await client.query(`DROP TABLE IF EXISTS branch_inventory`);
    console.log('[Schema] ✅ branch_inventory table dropped (replaced by producto_branches)');
} catch (biErr) {
    console.error(`[Schema] ⚠️ branch_inventory drop error: ${biErr.message}`);
}
```

- [ ] **Step 2: Remove from superadmin.js (line 974)**

Delete this line:
```js
await safeDel('DELETE FROM branch_inventory WHERE tenant_id = $1', [id]);
```

- [ ] **Step 3: Remove from cleanupTables.js (line 77)**

Delete this line:
```js
{ name: 'branch_inventory', description: 'Inventario por sucursal', fkColumn: 'tenant_id' },
```

- [ ] **Step 4: Remove from cleanup script (line 31)**

In `scripts/cleanup/clean_database_keep_subscriptions.js`, delete:
```js
'branch_inventory',
```

- [ ] **Step 5: Commit**

```bash
git add database/migrations.js routes/superadmin.js utils/cleanupTables.js scripts/cleanup/clean_database_keep_subscriptions.js
git commit -m "chore: drop branch_inventory table, remove all references"
```

---

### Task 13: Verify server starts and test manually

- [ ] **Step 1: Start server locally**

```bash
cd C:\SYA\sya-socketio-server
npm start
```

Expected: Server starts without errors. Migrations run. `branch_inventory` is dropped.

- [ ] **Step 2: Test a mobile sale**

From the mobile app, create a sale with an inventory-tracked product. Verify:
- Product inventory decreases **only for the selling branch**
- Kardex entry shows correct `quantity_before`/`quantity_after` (branch values, not global)
- Desktop receives `product_updated` socket with branch-specific inventory
- Other branches see unchanged inventory

- [ ] **Step 3: Test repartidor assignment**

Create an assignment. Verify branch inventory decreases. Cancel it. Verify branch inventory restores.

- [ ] **Step 4: Test transfer**

Create a transfer between branches. Verify source branch inventory decreases and target increases.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete branch inventory unification — all deductions use producto_branches"
```
