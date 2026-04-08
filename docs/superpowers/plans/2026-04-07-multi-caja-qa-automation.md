# Multi-Caja QA Automation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an automated test suite that simulates realistic multi-caja scenarios (sales, expenses, repartidores, liquidaciones, credits, discounts) and verifies that every corte de caja matches expected values.

**Architecture:** Three new files — a pure corte calculator, a fluent scenario builder wrapping REST/Socket.IO APIs, and the main test suite with 8 blocks / 19+ tests. One cleanup script. All tests run against Render PostgreSQL using existing seed data (employees, products, customers).

**Tech Stack:** Jest 30.x, node-fetch (or native fetch), jsonwebtoken, socket.io-client, pg (Pool), crypto

**Spec:** `docs/superpowers/specs/2026-04-07-multi-caja-qa-automation-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `tests/helpers/corte-calculator.js` | Pure function: given transaction log → expected corte values |
| Create | `tests/helpers/scenario-builder.js` | Fluent API wrapping REST endpoints + Socket.IO for test scenarios |
| Create | `tests/multi-caja-qa.test.js` | Main test suite: 7 blocks, 16+ tests |
| Create | `scripts/cleanup/clean-test-run.js` | Manual cleanup: deletes TEST-* records from all tables |
| Modify | `package.json` | Add `test:qa` script |

---

### Task 1: Corte Calculator — Pure Function

**Files:**
- Create: `tests/helpers/corte-calculator.js`

This is a standalone, zero-dependency module. It receives an array of transaction objects and returns the expected corte values. It replicates the SQL logic from `routes/cash-cuts.js` lines 162-262.

- [ ] **Step 1: Create corte-calculator.js with the core function**

```js
// tests/helpers/corte-calculator.js
//
// Pure function that calculates expected corte values from a transaction log.
// Replicates the SQL logic from routes/cash-cuts.js lines 162-262.
// If the server logic changes, update this file to match.

/**
 * @typedef {Object} Transaction
 * @property {'sale'|'expense'|'deposit'|'withdrawal'|'credit_payment'|'liquidation'} type
 * @property {number} amount - For sale: total. For others: amount.
 * @property {number} [tipoPagoId] - 1=Cash, 2=Card, 3=Credit, 4=Mixed. Used for sales.
 * @property {number} [estadoVentaId] - 3=Completed, 4=Cancelled, 5=Liquidated.
 * @property {string} [paymentMethod] - 'cash' or 'card'. Used for credit_payments.
 * @property {boolean} [isActive] - For expenses. Only is_active=true count.
 * @property {number} [cashAmount] - For liquidation breakdowns.
 * @property {number} [cardAmount] - For liquidation breakdowns.
 * @property {number} [creditAmount] - For liquidation breakdowns.
 * @property {boolean} [isRepartidorExpense] - True if expense belongs to repartidor.
 */

/**
 * Calculate expected corte values from a list of transactions.
 *
 * @param {number} initialAmount - Shift starting cash.
 * @param {Transaction[]} transactions - All transactions within the shift.
 * @param {number} countedCash - Physical cash counted at close.
 * @returns {Object} Expected corte values.
 */
function calculateExpectedCorte(initialAmount, transactions, countedCash) {
    let totalCashSales = 0;
    let totalCardSales = 0;
    let totalCreditSales = 0;
    let totalExpenses = 0;
    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let totalCashPayments = 0;
    let totalCardPayments = 0;
    let totalLiquidacionesEfectivo = 0;
    let totalLiquidacionesTarjeta = 0;
    let totalLiquidacionesCredito = 0;
    let totalRepartidorExpenses = 0;

    for (const tx of transactions) {
        switch (tx.type) {
            case 'sale': {
                // Only completed (3) and liquidated (5) sales count
                if (tx.estadoVentaId === 4) continue; // Cancelled — skip
                if (tx.estadoVentaId !== 3 && tx.estadoVentaId !== 5) continue;

                switch (tx.tipoPagoId) {
                    case 1: totalCashSales += tx.amount; break;
                    case 2: totalCardSales += tx.amount; break;
                    case 3: totalCreditSales += tx.amount; break;
                    // tipo_pago_id=4 (Mixed) is NOT handled by the server — excluded from all totals
                    default: break;
                }
                break;
            }
            case 'expense': {
                if (tx.isActive === false) continue; // Rejected/deactivated — skip
                totalExpenses += tx.amount;
                if (tx.isRepartidorExpense) {
                    totalRepartidorExpenses += tx.amount;
                }
                break;
            }
            case 'deposit': {
                totalDeposits += tx.amount;
                break;
            }
            case 'withdrawal': {
                totalWithdrawals += tx.amount;
                break;
            }
            case 'credit_payment': {
                if (tx.paymentMethod === 'cash') {
                    totalCashPayments += tx.amount;
                } else if (tx.paymentMethod === 'card') {
                    totalCardPayments += tx.amount;
                }
                break;
            }
            case 'liquidation': {
                // Liquidation totals are client-provided values sent to POST /api/cash-cuts
                totalLiquidacionesEfectivo += tx.cashAmount || 0;
                totalLiquidacionesTarjeta += tx.cardAmount || 0;
                totalLiquidacionesCredito += tx.creditAmount || 0;
                break;
            }
        }
    }

    // Formula from routes/cash-cuts.js line 262:
    // expectedCash = initial + cashSales + cashPayments + liqEfectivo + deposits - expenses - withdrawals
    const expectedCashInDrawer = initialAmount
        + totalCashSales
        + totalCashPayments
        + totalLiquidacionesEfectivo
        + totalDeposits
        - totalExpenses
        - totalWithdrawals;

    const difference = countedCash - expectedCashInDrawer;

    return {
        initialAmount,
        totalCashSales,
        totalCardSales,
        totalCreditSales,
        totalCashPayments,
        totalCardPayments,
        totalExpenses,
        totalDeposits,
        totalWithdrawals,
        totalLiquidacionesEfectivo,
        totalLiquidacionesTarjeta,
        totalLiquidacionesCredito,
        totalRepartidorExpenses,
        expectedCashInDrawer,
        countedCash,
        difference
    };
}

module.exports = { calculateExpectedCorte };
```

- [ ] **Step 2: Verify with a quick inline sanity test**

Run:
```bash
cd /c/SYA/sya-socketio-server && node -e "
const { calculateExpectedCorte } = require('./tests/helpers/corte-calculator');
const result = calculateExpectedCorte(500, [
  { type: 'sale', amount: 110, tipoPagoId: 1, estadoVentaId: 3 },
  { type: 'sale', amount: 200, tipoPagoId: 2, estadoVentaId: 3 },
  { type: 'sale', amount: 50, tipoPagoId: 1, estadoVentaId: 4 },  // cancelled
  { type: 'expense', amount: 150, isActive: true },
  { type: 'deposit', amount: 200 },
  { type: 'withdrawal', amount: 300 },
], 360);
console.log(JSON.stringify(result, null, 2));
// Expected: cashSales=110, cardSales=200, expenses=150, deposits=200, withdrawals=300
// expectedCash = 500 + 110 + 0 + 0 + 200 - 150 - 300 = 360
// difference = 360 - 360 = 0
console.log('PASS:', result.expectedCashInDrawer === 360 && result.difference === 0);
"
```

Expected: `PASS: true`

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add tests/helpers/corte-calculator.js
git commit -m "feat(qa): add corte calculator pure function

Replicates the server's cash-cut calculation logic (routes/cash-cuts.js)
as an independent function for verifying corte values in QA tests."
```

---

### Task 2: Scenario Builder — Fluent API

**Files:**
- Create: `tests/helpers/scenario-builder.js`

This is the core test infrastructure. It wraps REST API calls and Socket.IO connections into a readable fluent API. Each `Terminal` tracks its own transaction log.

**Context needed:**
- `tests/helpers/test-setup.js` — reuse `POOL_CONFIG`, `SERVER_URL`
- `tests/sync-server-first.test.js` — exact payload formats for each sync endpoint
- JWT auth pattern: `jwt.sign({ tenantId, employeeId, branchId, role: 'owner', is_owner: true }, JWT_SECRET)`

- [ ] **Step 1: Create scenario-builder.js with ScenarioBuilder class**

```js
// tests/helpers/scenario-builder.js
//
// Fluent API for building multi-caja test scenarios.
// Wraps REST API + Socket.IO calls into readable test stories.
// Each Terminal tracks its transaction log for corte verification.

const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');
const { POOL_CONFIG, SERVER_URL } = require('./test-setup');

const JWT_SECRET = process.env.JWT_SECRET;

function makeToken(tenantId, employeeId, branchId) {
    return jwt.sign(
        { tenantId, employeeId, branchId, role: 'owner', is_owner: true },
        JWT_SECRET,
        { expiresIn: '1h' }
    );
}

async function apiRequest(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    const res = await fetch(`${SERVER_URL}${path}`, opts);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, body: json };
}

/**
 * ScenarioBuilder — orchestrates multi-terminal test scenarios.
 */
class ScenarioBuilder {
    constructor({ tenantId, branchId }) {
        this.tenantId = tenantId;
        this.branchId = branchId;
        this.terminals = [];
        this.pool = new Pool(POOL_CONFIG);
        // Track ALL created records for cleanup (in creation order)
        this.createdRecords = [];
    }

    /**
     * Create a terminal (caja) that will operate independently.
     * @param {Object} opts
     * @param {string} opts.terminalId - Must start with 'TEST-'
     * @param {string} opts.employeeGlobalId - Global ID of the employee operating this terminal
     * @param {number} [opts.employeeId] - Numeric employee ID (for JWT)
     * @param {string} [opts.clientType='desktop'] - 'desktop' or 'mobile'
     */
    async createTerminal({ terminalId, employeeGlobalId, employeeId, clientType = 'desktop' }) {
        if (!terminalId.startsWith('TEST-')) {
            throw new Error(`Terminal ID must start with TEST-. Got: ${terminalId}`);
        }

        // Resolve numeric employee ID if not provided
        if (!employeeId) {
            const { rows } = await this.pool.query(
                'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                [employeeGlobalId, this.tenantId]
            );
            if (rows.length === 0) throw new Error(`Employee ${employeeGlobalId} not found`);
            employeeId = rows[0].id;
        }

        const token = makeToken(this.tenantId, employeeId, this.branchId);

        const terminal = new Terminal({
            terminalId,
            employeeGlobalId,
            employeeId,
            tenantId: this.tenantId,
            branchId: this.branchId,
            token,
            clientType,
            pool: this.pool,
            scenario: this
        });

        this.terminals.push(terminal);
        return terminal;
    }

    /**
     * Query a corte by shift ID.
     */
    async queryCorte(shiftId, token) {
        return apiRequest('GET', `/api/cash-cuts?shiftId=${shiftId}`, null, token);
    }

    /**
     * Query all cortes for the branch.
     */
    async queryBranchSummary(token) {
        return apiRequest('GET', `/api/cash-cuts?branch_id=${this.branchId}`, null, token);
    }

    /**
     * Track a created record for cleanup.
     */
    trackRecord(table, identifiers) {
        this.createdRecords.push({ table, ...identifiers });
    }

    /**
     * Cleanup ALL test records in reverse FK order.
     * Uses terminal_id LIKE 'TEST-%' as primary mechanism.
     */
    async cleanup() {
        const terminalIds = this.terminals.map(t => t.terminalId);
        if (terminalIds.length === 0) return;

        const cleanupQueries = [
            // 1. cancelaciones_bitacora
            `DELETE FROM cancelaciones_bitacora WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            // 2. credit_payments
            `DELETE FROM credit_payments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            // 3. ventas_detalle (via ventas)
            `DELETE FROM ventas_detalle WHERE id_venta IN (
                SELECT id_venta FROM ventas WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
            )`,
            // 4. ventas
            `DELETE FROM ventas WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            // 5. repartidor_returns (via assignments)
            `DELETE FROM repartidor_returns WHERE assignment_id IN (
                SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
            )`,
            // 6. repartidor_debts (via assignments)
            `DELETE FROM repartidor_debts WHERE assignment_id IN (
                SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
            )`,
            // 7. repartidor_liquidations
            `DELETE FROM repartidor_liquidations WHERE assignment_id IN (
                SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
            )`,
            // 8. repartidor_assignments
            `DELETE FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            // 9. cash_cuts
            `DELETE FROM cash_cuts WHERE shift_id IN (
                SELECT id FROM shifts WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
            )`,
            // 10. expenses
            `DELETE FROM expenses WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            // 11. deposits
            `DELETE FROM deposits WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            // 12. withdrawals
            `DELETE FROM withdrawals WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            // 13. shifts (last — everything else depends on shift_id)
            `DELETE FROM shifts WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
        ];

        for (const q of cleanupQueries) {
            try {
                const result = await this.pool.query(q, [this.tenantId]);
                if (result.rowCount > 0) {
                    const table = q.match(/DELETE FROM (\w+)/)?.[1] || 'unknown';
                    console.log(`  [Cleanup] Deleted ${result.rowCount} from ${table}`);
                }
            } catch (err) {
                // Log but don't fail — some tables may not have TEST- records
                console.warn(`  [Cleanup] Warning: ${err.message}`);
            }
        }

        // Disconnect all sockets
        for (const t of this.terminals) {
            if (t.socket) t.socket.disconnect();
        }
    }

    /**
     * Close the pool connection.
     */
    async destroy() {
        await this.pool.end();
    }
}


/**
 * Terminal — represents a single caja/device.
 * Tracks all transactions in memory for corte verification.
 */
class Terminal {
    constructor({ terminalId, employeeGlobalId, employeeId, tenantId, branchId, token, clientType, pool, scenario }) {
        this.terminalId = terminalId;
        this.employeeGlobalId = employeeGlobalId;
        this.employeeId = employeeId;
        this.tenantId = tenantId;
        this.branchId = branchId;
        this.token = token;
        this.clientType = clientType;
        this.pool = pool;
        this.scenario = scenario;

        this.shiftId = null;
        this.shiftGlobalId = null;
        this.shiftStartTime = null;
        this.socket = null;

        // Transaction log — used by corte-calculator
        this.transactions = [];
        // All global IDs created — for assertions
        this.createdGlobalIds = {};
    }

    /**
     * Open a shift for this terminal.
     * @param {number} initialAmount
     * @returns {Object} shift data including id, global_id, start_time
     */
    async openShift(initialAmount) {
        const res = await apiRequest('POST', '/api/shifts/open', {
            initialAmount,
            terminalId: this.terminalId,
            employeeGlobalId: this.employeeGlobalId,
            branchId: this.branchId
        }, this.token);

        if (res.status !== 200 && res.status !== 201) {
            throw new Error(`openShift failed (${res.status}): ${JSON.stringify(res.body)}`);
        }

        const shift = res.body.data || res.body.shift || res.body;
        this.shiftId = shift.id;
        this.shiftGlobalId = shift.global_id;
        this.shiftStartTime = shift.start_time;
        this.initialAmount = initialAmount;

        return shift;
    }

    /**
     * Create a sale via sync endpoint.
     * @param {Object} opts
     * @param {Array} opts.items - [{productGlobalId, productName, quantity, unitPrice, totalLine}]
     * @param {number} opts.tipoPagoId - 1=Cash, 2=Card, 3=Credit, 4=Mixed
     * @param {number} opts.total
     * @param {string} [opts.clientGlobalId] - For credit sales or client-specific pricing
     * @param {number} [opts.estadoVentaId=3] - 3=Completed, 5=Liquidated
     * @param {string} [opts.fechaLiquidacionUtc] - For liquidated sales (estado 5)
     */
    async createSale({ items = [], tipoPagoId, total, clientGlobalId, estadoVentaId = 3, fechaLiquidacionUtc, subtotal, totalDescuentos = 0 }) {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();
        const actualSubtotal = subtotal || total + totalDescuentos;

        const cashAmount = tipoPagoId === 1 ? total : 0;
        const cardAmount = tipoPagoId === 2 ? total : 0;
        const creditAmount = tipoPagoId === 3 ? total : 0;

        const detalles = items.map(item => ({
            id_producto: item.productId || 1,
            producto_global_id: item.productGlobalId,
            descripcion_producto: item.productName || 'Test Product',
            cantidad: item.quantity,
            precio_lista: item.listPrice || item.unitPrice,
            precio_unitario: item.unitPrice,
            total_linea: item.totalLine || (item.quantity * item.unitPrice),
            global_id: crypto.randomUUID()
        }));

        const payload = {
            tenant_id: this.tenantId,
            branch_id: this.branchId,
            empleado_global_id: this.employeeGlobalId,
            turno_global_id: this.shiftGlobalId,
            estado_venta_id: estadoVentaId,
            status: estadoVentaId === 3 ? 'completed' : 'liquidated',
            venta_tipo_id: 1,
            tipo_pago_id: tipoPagoId,
            subtotal: actualSubtotal,
            total_descuentos: totalDescuentos,
            total,
            monto_pagado: tipoPagoId === 3 ? 0 : total,
            cash_amount: cashAmount,
            card_amount: cardAmount,
            credit_amount: creditAmount,
            credito_original: tipoPagoId === 3 ? total : 0,
            ticket_number: Math.floor(Math.random() * 99999),
            fecha_venta_raw: Date.now(),
            fecha_venta_utc: now,
            global_id: globalId,
            terminal_id: this.terminalId,
            local_op_seq: 1,
            created_local_utc: now,
            device_event_raw: Date.now(),
            detalles
        };

        if (clientGlobalId) payload.cliente_global_id = clientGlobalId;
        if (fechaLiquidacionUtc) payload.fecha_liquidacion_utc = fechaLiquidacionUtc;

        const res = await apiRequest('POST', '/api/sales/sync', payload, this.token);
        if (!res.body.success) {
            throw new Error(`createSale failed: ${JSON.stringify(res.body)}`);
        }

        // Track in transaction log (include numeric ID for cancellation with inventory restore)
        const numericId = res.body.data?.id_venta || res.body.data?.id;
        this.transactions.push({
            type: 'sale',
            amount: total,
            tipoPagoId,
            estadoVentaId,
            globalId,
            numericId
        });

        this.createdGlobalIds[`sale_${globalId}`] = globalId;
        return { globalId, numericId, ...res.body.data };
    }

    /**
     * Cancel a sale.
     * NOTE: POST /api/cancelaciones/sync only inserts into cancelaciones_bitacora.
     * It does NOT update ventas.estado_venta_id. We must update the venta directly
     * so the corte query excludes it (corte only counts estado 3 and 5).
     * @param {string} saleGlobalId
     */
    async cancelSale(saleGlobalId) {
        // 1. Record the cancellation in bitacora
        const res = await apiRequest('POST', '/api/cancelaciones/sync', {
            tenant_id: this.tenantId,
            branch_id: this.branchId,
            venta_global_id: saleGlobalId,
            employee_global_id: this.employeeGlobalId,
            shift_global_id: this.shiftGlobalId,
            motivo: 'Test cancellation',
            global_id: crypto.randomUUID(),
            terminal_id: this.terminalId,
            local_op_seq: 1,
            created_local_utc: new Date().toISOString()
        }, this.token);

        // 2. CRITICAL: Update the venta's estado_venta_id to 4 (Cancelled)
        // Without this, the corte SQL still includes the sale in totals
        await this.pool.query(
            `UPDATE ventas SET estado_venta_id = 4 WHERE global_id = $1 AND tenant_id = $2`,
            [saleGlobalId, this.tenantId]
        );

        // 3. Update transaction log — mark sale as cancelled
        const saleTx = this.transactions.find(
            tx => tx.type === 'sale' && tx.globalId === saleGlobalId
        );
        if (saleTx) saleTx.estadoVentaId = 4;

        return res.body;
    }

    /**
     * Create an expense.
     * @param {Object} opts
     * @param {number} opts.categoryId - global_category_id
     * @param {number} opts.amount
     * @param {string} opts.description
     * @param {string} [opts.source='desktop']
     */
    async createExpense({ categoryId, amount, description, source = 'desktop' }) {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();

        const res = await apiRequest('POST', '/api/expenses/sync', {
            tenantId: this.tenantId,
            branchId: this.branchId,
            employee_global_id: this.employeeGlobalId,
            shift_global_id: this.shiftGlobalId,
            global_category_id: categoryId,
            category: 'Test Category',
            description,
            amount,
            quantity: 1,
            payment_type_id: 1,
            expense_date_utc: now,
            global_id: globalId,
            terminal_id: this.terminalId,
            local_op_seq: 1,
            created_local_utc: now,
            source
        }, this.token);

        if (!res.body.success) {
            throw new Error(`createExpense failed: ${JSON.stringify(res.body)}`);
        }

        this.transactions.push({
            type: 'expense',
            amount,
            isActive: true,
            isRepartidorExpense: source === 'mobile',
            globalId
        });

        this.createdGlobalIds[`expense_${globalId}`] = globalId;
        return { globalId, ...res.body.data };
    }

    /**
     * Approve an expense.
     * @param {string} expenseGlobalId
     */
    async approveExpense(expenseGlobalId) {
        const res = await apiRequest('PATCH', `/api/expenses/${expenseGlobalId}/approve`, {
            tenant_id: this.tenantId,
            reviewer_employee_global_id: this.employeeGlobalId
        }, this.token);

        // Expense stays is_active=true — no change to transaction log
        return res.body;
    }

    /**
     * Reject (deactivate) an expense.
     * @param {string} expenseGlobalId
     * @param {string} reason
     */
    async rejectExpense(expenseGlobalId, reason) {
        const res = await apiRequest('PATCH', `/api/expenses/${expenseGlobalId}/deactivate`, {
            tenant_id: this.tenantId,
            reason,
            rejected_by_employee_global_id: this.employeeGlobalId
        }, this.token);

        // Update transaction log — mark expense as inactive
        const expTx = this.transactions.find(
            tx => tx.type === 'expense' && tx.globalId === expenseGlobalId
        );
        if (expTx) expTx.isActive = false;

        return res.body;
    }

    /**
     * Edit an expense amount/description.
     * @param {string} expenseGlobalId
     * @param {Object} updates - { amount?, description? }
     */
    async editExpense(expenseGlobalId, { amount, description }) {
        const body = { tenant_id: this.tenantId };
        if (amount !== undefined) body.amount = amount;
        if (description !== undefined) body.description = description;

        const res = await apiRequest('PATCH', `/api/expenses/${expenseGlobalId}`, body, this.token);

        // Update transaction log amount
        if (amount !== undefined) {
            const expTx = this.transactions.find(
                tx => tx.type === 'expense' && tx.globalId === expenseGlobalId
            );
            if (expTx) expTx.amount = amount;
        }

        return res.body;
    }

    /**
     * Create a deposit.
     * @param {number} amount
     * @param {string} description
     */
    async createDeposit(amount, description = 'Test deposit') {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();

        const res = await apiRequest('POST', '/api/deposits/sync', {
            tenantId: this.tenantId,
            branchId: this.branchId,
            shift_global_id: this.shiftGlobalId,
            employee_global_id: this.employeeGlobalId,
            amount,
            description,
            authorized_by: 'Test Admin',
            deposit_date_utc: now,
            global_id: globalId,
            terminal_id: this.terminalId,
            local_op_seq: 1,
            created_local_utc: now
        }, this.token);

        if (!res.body.success) {
            throw new Error(`createDeposit failed: ${JSON.stringify(res.body)}`);
        }

        this.transactions.push({ type: 'deposit', amount, globalId });
        this.createdGlobalIds[`deposit_${globalId}`] = globalId;
        return { globalId, ...res.body.data };
    }

    /**
     * Create a withdrawal.
     * @param {number} amount
     * @param {string} description
     */
    async createWithdrawal(amount, description = 'Test withdrawal') {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();

        const res = await apiRequest('POST', '/api/withdrawals/sync', {
            tenantId: this.tenantId,
            branchId: this.branchId,
            shift_global_id: this.shiftGlobalId,
            employee_global_id: this.employeeGlobalId,
            amount,
            description,
            authorized_by: 'Test Admin',
            withdrawal_date_utc: now,
            global_id: globalId,
            terminal_id: this.terminalId,
            local_op_seq: 1,
            created_local_utc: now
        }, this.token);

        if (!res.body.success) {
            throw new Error(`createWithdrawal failed: ${JSON.stringify(res.body)}`);
        }

        this.transactions.push({ type: 'withdrawal', amount, globalId });
        this.createdGlobalIds[`withdrawal_${globalId}`] = globalId;
        return { globalId, ...res.body.data };
    }

    /**
     * Create a credit payment.
     * @param {Object} opts
     * @param {string} opts.clientGlobalId
     * @param {number} opts.amount
     * @param {string} opts.paymentMethod - 'cash' or 'card'
     */
    async createCreditPayment({ clientGlobalId, amount, paymentMethod }) {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();

        const res = await apiRequest('POST', '/api/credit-payments/sync', {
            tenantId: this.tenantId,
            branchId: this.branchId,
            customer_global_id: clientGlobalId,
            shift_global_id: this.shiftGlobalId,
            employee_global_id: this.employeeGlobalId,
            amount,
            paymentMethod,
            notes: 'Test credit payment',
            global_id: globalId,
            terminal_id: this.terminalId,
            local_op_seq: 1,
            created_local_utc: now
        }, this.token);

        if (!res.body.success) {
            throw new Error(`createCreditPayment failed: ${JSON.stringify(res.body)}`);
        }

        this.transactions.push({
            type: 'credit_payment',
            amount,
            paymentMethod,
            globalId
        });

        this.createdGlobalIds[`credit_payment_${globalId}`] = globalId;
        return { globalId, ...res.body.data };
    }

    /**
     * Assign products to a repartidor.
     * @param {Object} opts
     * @param {string} opts.repartidorEmployeeGlobalId
     * @param {string} [opts.repartidorShiftGlobalId]
     * @param {Array} opts.items - [{productGlobalId, productName, quantity, unitPrice}]
     */
    async assignToRepartidor({ repartidorEmployeeGlobalId, repartidorShiftGlobalId, items }) {
        const results = [];
        for (const item of items) {
            const globalId = crypto.randomUUID();
            const now = new Date().toISOString();

            const res = await apiRequest('POST', '/api/repartidor-assignments/sync', {
                tenant_id: this.tenantId,
                branch_id: this.branchId,
                employee_global_id: repartidorEmployeeGlobalId,
                created_by_employee_global_id: this.employeeGlobalId,
                shift_global_id: this.shiftGlobalId,
                repartidor_shift_global_id: repartidorShiftGlobalId || this.shiftGlobalId,
                product_global_id: item.productGlobalId,
                product_name: item.productName,
                assigned_quantity: item.quantity,
                assigned_amount: item.quantity * item.unitPrice,
                unit_price: item.unitPrice,
                unit_abbreviation: item.unit || 'kg',
                status: 'pending',
                fecha_asignacion: now,
                global_id: globalId,
                terminal_id: this.terminalId,
                local_op_seq: 1,
                created_local_utc: now
            }, this.token);

            results.push({ globalId, item, ...res.body });
            this.createdGlobalIds[`assignment_${globalId}`] = globalId;
        }
        return results;
    }

    /**
     * Change the client on a repartidor assignment.
     * @param {string} assignmentGlobalId
     * @param {Object} opts
     * @param {string} opts.newClientGlobalId
     */
    async changeAssignmentClient(assignmentGlobalId, { newClientGlobalId }) {
        // Resolve client numeric ID
        const { rows } = await this.pool.query(
            'SELECT id FROM customers WHERE global_id = $1 AND tenant_id = $2',
            [newClientGlobalId, this.tenantId]
        );
        const clientId = rows.length > 0 ? rows[0].id : null;

        // Update assignment directly in DB (no dedicated API endpoint for this)
        await this.pool.query(
            `UPDATE repartidor_assignments SET customer_id = $1, customer_global_id = $2, updated_at = NOW()
             WHERE global_id = $3 AND tenant_id = $4`,
            [clientId, newClientGlobalId, assignmentGlobalId, this.tenantId]
        );

        return { success: true, assignmentGlobalId, newClientGlobalId };
    }

    /**
     * Register a product return from repartidor.
     * @param {string} assignmentGlobalId
     * @param {Object} opts
     * @param {number} opts.quantity
     * @param {number} opts.unitPrice
     */
    async registerReturn(assignmentGlobalId, { quantity, unitPrice }) {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();

        const res = await apiRequest('POST', '/api/repartidor-returns/sync', {
            tenant_id: this.tenantId,
            branch_id: this.branchId,
            assignment_global_id: assignmentGlobalId,
            employee_global_id: this.employeeGlobalId,
            shift_global_id: this.shiftGlobalId,
            quantity,
            unit_price: unitPrice,
            amount: quantity * unitPrice,
            return_date: now,
            source: 'desktop',
            global_id: globalId,
            terminal_id: this.terminalId,
            local_op_seq: 1,
            created_local_utc: now
        }, this.token);

        this.createdGlobalIds[`return_${globalId}`] = globalId;
        return { globalId, ...res.body };
    }

    /**
     * Close the shift and create corte de caja.
     * Uses POST /api/cash-cuts which calculates totals server-side.
     *
     * @param {Object} opts
     * @param {number} opts.countedCash - Physical cash counted
     * @param {Object} [opts.liquidacionTotals] - Override auto-calculated liquidation totals
     */
    async closeShift({ countedCash, liquidacionTotals }) {
        // Close the shift by setting end_time directly in DB.
        // NOTE: We use direct SQL instead of POST /api/shifts/close because:
        // 1. The /close endpoint has additional business logic (notifications, session handling)
        //    that we don't want in tests
        // 2. POST /api/cash-cuts reads shift.end_time to define the time window for queries.
        //    If end_time is NULL, the date filters would behave unexpectedly.
        // 3. The shift must be closed BEFORE creating the corte.
        await this.pool.query(
            `UPDATE shifts SET end_time = NOW(), is_cash_cut_open = false WHERE id = $1`,
            [this.shiftId]
        );

        // Calculate liquidation totals from transaction log if not provided
        const liqTotals = liquidacionTotals || this._calculateLiquidationTotals();

        const res = await apiRequest('POST', '/api/cash-cuts', {
            shiftId: this.shiftId,
            branchId: this.branchId,
            initialAmount: this.initialAmount,
            countedCash,
            notes: 'QA Test corte',
            totalLiquidacionesEfectivo: liqTotals.totalLiquidacionesEfectivo || 0,
            totalLiquidacionesTarjeta: liqTotals.totalLiquidacionesTarjeta || 0,
            totalLiquidacionesCredito: liqTotals.totalLiquidacionesCredito || 0,
            totalRepartidorExpenses: liqTotals.totalRepartidorExpenses || 0
        }, this.token);

        if (!res.body.success) {
            throw new Error(`closeShift failed: ${JSON.stringify(res.body)}`);
        }

        return res.body.data;
    }

    /**
     * Calculate liquidation totals from the transaction log.
     */
    _calculateLiquidationTotals() {
        let totalLiquidacionesEfectivo = 0;
        let totalLiquidacionesTarjeta = 0;
        let totalLiquidacionesCredito = 0;
        let totalRepartidorExpenses = 0;

        for (const tx of this.transactions) {
            if (tx.type === 'liquidation') {
                totalLiquidacionesEfectivo += tx.cashAmount || 0;
                totalLiquidacionesTarjeta += tx.cardAmount || 0;
                totalLiquidacionesCredito += tx.creditAmount || 0;
            }
            if (tx.type === 'expense' && tx.isRepartidorExpense && tx.isActive !== false) {
                totalRepartidorExpenses += tx.amount;
            }
        }

        return {
            totalLiquidacionesEfectivo,
            totalLiquidacionesTarjeta,
            totalLiquidacionesCredito,
            totalRepartidorExpenses
        };
    }

    /**
     * Add a liquidation record to the transaction log.
     * This is tracked in memory only — the actual liquidation creates ventas with estado_venta_id=5.
     * @param {Object} opts
     * @param {number} opts.cashAmount
     * @param {number} opts.cardAmount
     * @param {number} opts.creditAmount
     */
    addLiquidation({ cashAmount = 0, cardAmount = 0, creditAmount = 0 }) {
        this.transactions.push({
            type: 'liquidation',
            cashAmount,
            cardAmount,
            creditAmount
        });
    }

    /**
     * Get product inventory (productos.inventario) for a given product global_id.
     * Used to verify inventory changes after cancellations/returns.
     * @param {string} productGlobalId
     * @returns {Object} { inventario, inventariar, productName }
     */
    async getProductInventory(productGlobalId) {
        const { rows } = await this.pool.query(
            `SELECT inventario, inventariar, nombre_producto as product_name
             FROM productos WHERE global_id = $1 AND tenant_id = $2`,
            [productGlobalId, this.tenantId]
        );
        if (rows.length === 0) throw new Error(`Product ${productGlobalId} not found`);
        return {
            inventario: parseFloat(rows[0].inventario || 0),
            inventariar: rows[0].inventariar,
            productName: rows[0].product_name
        };
    }

    /**
     * Set product inventory to a known value (for test setup).
     * @param {string} productGlobalId
     * @param {number} quantity
     */
    async setProductInventory(productGlobalId, quantity) {
        await this.pool.query(
            `UPDATE productos SET inventario = $1 WHERE global_id = $2 AND tenant_id = $3`,
            [quantity, productGlobalId, this.tenantId]
        );
    }

    /**
     * Cancel a sale using the REST API (POST /api/sales/:id/cancel).
     * Unlike cancelSale() which uses cancelaciones/sync, this endpoint
     * RESTORES INVENTORY if the product has inventariar=true.
     * @param {number} saleNumericId - The numeric id_venta from the ventas table
     */
    async cancelSaleWithInventoryRestore(saleNumericId) {
        const res = await apiRequest('POST', `/api/sales/${saleNumericId}/cancel`, {
            cancelReason: 'Test cancellation with inventory restore',
            cancelledByEmployeeId: this.employeeId
        }, this.token);

        // Also update transaction log
        const saleTx = this.transactions.find(
            tx => tx.type === 'sale' && tx.numericId === saleNumericId
        );
        if (saleTx) saleTx.estadoVentaId = 4;

        return res.body;
    }

    /**
     * Get the full transaction log for this terminal.
     */
    getTransactionLog() {
        return [...this.transactions];
    }

    /**
     * Get raw Socket.IO client (for event assertions).
     */
    getSocket() {
        return this.socket;
    }
}

module.exports = { ScenarioBuilder, Terminal };
```

- [ ] **Step 2: Verify the module loads without errors**

Run:
```bash
cd /c/SYA/sya-socketio-server && node -e "
const { ScenarioBuilder } = require('./tests/helpers/scenario-builder');
console.log('ScenarioBuilder loaded OK');
console.log('Methods:', Object.getOwnPropertyNames(ScenarioBuilder.prototype));
"
```

Expected: Module loads, lists methods.

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add tests/helpers/scenario-builder.js
git commit -m "feat(qa): add scenario builder fluent API

Wraps REST + Socket.IO APIs into readable terminal operations.
Each Terminal tracks its transaction log for corte verification."
```

---

### Task 3: Cleanup Script

**Files:**
- Create: `scripts/cleanup/clean-test-run.js`

Standalone script for manual cleanup of TEST-* records when tests crash.

- [ ] **Step 1: Create the cleanup script**

```js
#!/usr/bin/env node
// scripts/cleanup/clean-test-run.js
//
// Manual cleanup of QA test data from PostgreSQL.
// Usage: node scripts/cleanup/clean-test-run.js [--tenant-id=1]
//
// Deletes all records with terminal_id LIKE 'TEST-%' in reverse FK order.
// Safe to run multiple times (idempotent).

const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
    console.error('ERROR: DATABASE_URL env var is required');
    process.exit(1);
}

const args = process.argv.slice(2);
const tenantIdArg = args.find(a => a.startsWith('--tenant-id='));
const TENANT_ID = tenantIdArg ? parseInt(tenantIdArg.split('=')[1]) : 1;

const pool = new Pool({
    connectionString: DB_URL,
    ssl: DB_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const CLEANUP_QUERIES = [
    'DELETE FROM cancelaciones_bitacora WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    'DELETE FROM credit_payments WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    `DELETE FROM ventas_detalle WHERE id_venta IN (
        SELECT id_venta FROM ventas WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
    )`,
    'DELETE FROM ventas WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    `DELETE FROM repartidor_returns WHERE assignment_id IN (
        SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
    )`,
    `DELETE FROM repartidor_debts WHERE assignment_id IN (
        SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
    )`,
    `DELETE FROM repartidor_liquidations WHERE assignment_id IN (
        SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
    )`,
    'DELETE FROM repartidor_assignments WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    `DELETE FROM cash_cuts WHERE shift_id IN (
        SELECT id FROM shifts WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
    )`,
    'DELETE FROM expenses WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    'DELETE FROM deposits WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    'DELETE FROM withdrawals WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    'DELETE FROM shifts WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
];

async function main() {
    console.log(`\n🧹 Cleaning TEST-* records for tenant_id=${TENANT_ID}\n`);
    let totalDeleted = 0;

    for (const q of CLEANUP_QUERIES) {
        try {
            const result = await pool.query(q, [TENANT_ID]);
            const table = q.match(/DELETE FROM (\w+)/)?.[1] || 'unknown';
            if (result.rowCount > 0) {
                console.log(`  ✅ ${table}: ${result.rowCount} deleted`);
                totalDeleted += result.rowCount;
            }
        } catch (err) {
            const table = q.match(/DELETE FROM (\w+)/)?.[1] || 'unknown';
            console.warn(`  ⚠️  ${table}: ${err.message}`);
        }
    }

    console.log(`\n✅ Done. Total records deleted: ${totalDeleted}`);
    await pool.end();
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
```

- [ ] **Step 2: Verify it loads**

Run:
```bash
cd /c/SYA/sya-socketio-server && node -e "console.log('Script syntax OK')" && node --check scripts/cleanup/clean-test-run.js && echo "Syntax valid"
```

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add scripts/cleanup/clean-test-run.js
git commit -m "feat(qa): add manual cleanup script for TEST-* records

Standalone script that cleans test data from PostgreSQL.
Usage: node scripts/cleanup/clean-test-run.js --tenant-id=1"
```

---

### Task 4: Package.json — Add test:qa Script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the test:qa script**

Add to `package.json` scripts:
```json
"test:qa": "jest tests/multi-caja-qa.test.js --runInBand --forceExit --testTimeout=120000"
```

- [ ] **Step 2: Verify script is registered**

Run:
```bash
cd /c/SYA/sya-socketio-server && node -e "const pkg = require('./package.json'); console.log('test:qa =', pkg.scripts['test:qa'])"
```

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add package.json
git commit -m "feat(qa): add test:qa npm script for multi-caja QA suite"
```

---

### Task 5: Test Suite — Bloque 1 (Single Terminal Basic)

**Files:**
- Create: `tests/multi-caja-qa.test.js` (first block)

**Context:**
- Import `ScenarioBuilder` from `./helpers/scenario-builder`
- Import `calculateExpectedCorte` from `./helpers/corte-calculator`
- Use env vars: `QA_TENANT_ID`, `QA_BRANCH_ID`, `QA_CAJERO_1_GLOBAL_ID`
- Corte formula: `expected = initial + cashSales + cashPayments + liqCash + deposits - expenses - withdrawals`

- [ ] **Step 1: Create the test file with Bloque 1**

```js
// tests/multi-caja-qa.test.js
//
// Multi-Caja QA Automation Test Suite
// Verifies that corte de caja calculations are correct across all scenarios.
//
// Run: npm run test:qa
// Spec: docs/superpowers/specs/2026-04-07-multi-caja-qa-automation-design.md
//
// Prerequisites:
//   - Server running on TEST_SERVER_URL
//   - JWT_SECRET and DATABASE_URL env vars set
//   - QA_TENANT_ID, QA_BRANCH_ID, QA_CAJERO_1_GLOBAL_ID env vars set

const { ScenarioBuilder } = require('./helpers/scenario-builder');
const { calculateExpectedCorte } = require('./helpers/corte-calculator');

const QA_CONFIG = {
    tenantId: parseInt(process.env.QA_TENANT_ID || '1'),
    branchId: parseInt(process.env.QA_BRANCH_ID || '1'),
    cajero1GlobalId: process.env.QA_CAJERO_1_GLOBAL_ID,
    cajero2GlobalId: process.env.QA_CAJERO_2_GLOBAL_ID,
    repartidorGlobalId: process.env.QA_REPARTIDOR_GLOBAL_ID,
    clientCreditGlobalId: process.env.QA_CLIENT_CREDIT_GLOBAL_ID,
    clientDiscountGlobalId: process.env.QA_CLIENT_DISCOUNT_GLOBAL_ID,
    productWithInventoryGlobalId: process.env.QA_PRODUCT_WITH_INVENTORY_GLOBAL_ID,
};

// Validate required env vars
beforeAll(() => {
    const required = ['cajero1GlobalId'];
    for (const key of required) {
        if (!QA_CONFIG[key]) {
            throw new Error(`Missing env var: QA_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`);
        }
    }
});

// ════════════════════════════════════════════════════════════════════════
// BLOQUE 1: Terminal Única — Operaciones Básicas
// ════════════════════════════════════════════════════════════════════════
describe('Bloque 1: Single Terminal - Basic Operations', () => {
    let scenario;
    let cajaA;
    let corteResult;

    beforeAll(async () => {
        scenario = new ScenarioBuilder({
            tenantId: QA_CONFIG.tenantId,
            branchId: QA_CONFIG.branchId
        });

        // Cleanup orphaned data from previous failed runs
        await scenario.cleanup();

        cajaA = await scenario.createTerminal({
            terminalId: 'TEST-CAJA-A',
            employeeGlobalId: QA_CONFIG.cajero1GlobalId
        });

        // Open shift with $500 initial
        await cajaA.openShift(500);

        // 3 cash sales
        await cajaA.createSale({
            items: [{ productName: 'Tortilla Maíz 1kg', quantity: 5, unitPrice: 22 }],
            tipoPagoId: 1,
            total: 110
        });
        await cajaA.createSale({
            items: [{ productName: 'Tortilla Maíz 1kg', quantity: 10, unitPrice: 22 }],
            tipoPagoId: 1,
            total: 220
        });
        await cajaA.createSale({
            items: [{ productName: 'Totopos 500g', quantity: 3, unitPrice: 30 }],
            tipoPagoId: 1,
            total: 90
        });

        // 1 card sale
        await cajaA.createSale({
            items: [{ productName: 'Tortilla Maíz 1kg', quantity: 8, unitPrice: 22 }],
            tipoPagoId: 2,
            total: 176
        });

        // 1 sale that gets cancelled
        const cancelledSale = await cajaA.createSale({
            items: [{ productName: 'Tortilla Harina 1kg', quantity: 2, unitPrice: 28 }],
            tipoPagoId: 1,
            total: 56
        });
        await cajaA.cancelSale(cancelledSale.globalId);

        // 1 expense
        await cajaA.createExpense({ categoryId: 2, amount: 150, description: 'Gas LP' });

        // 1 deposit
        await cajaA.createDeposit(200, 'Cambio del banco');

        // 1 withdrawal
        await cajaA.createWithdrawal(300, 'Pago proveedor');

        // Close shift — expected cash = 500 + (110+220+90) + 0 + 200 - 150 - 300 = 670
        corteResult = await cajaA.closeShift({ countedCash: 670 });
    }, 60000);

    afterAll(async () => {
        await scenario.cleanup();
        await scenario.destroy();
    }, 30000);

    test('corte matches expected cash/card/credit totals', () => {
        const expected = calculateExpectedCorte(500, cajaA.getTransactionLog(), 670);

        expect(corteResult.total_cash_sales).toBeCloseTo(expected.totalCashSales, 2);
        expect(corteResult.total_card_sales).toBeCloseTo(expected.totalCardSales, 2);
        expect(corteResult.total_credit_sales).toBeCloseTo(expected.totalCreditSales, 2);
        expect(corteResult.total_expenses).toBeCloseTo(expected.totalExpenses, 2);
        expect(corteResult.total_deposits).toBeCloseTo(expected.totalDeposits, 2);
        expect(corteResult.total_withdrawals).toBeCloseTo(expected.totalWithdrawals, 2);
    });

    test('cancelled sale excluded from corte', () => {
        // Cash sales should be 110 + 220 + 90 = 420 (NOT 476 which includes cancelled $56)
        expect(corteResult.total_cash_sales).toBeCloseTo(420, 2);
    });

    test('difference = counted - expected', () => {
        const expected = calculateExpectedCorte(500, cajaA.getTransactionLog(), 670);
        expect(corteResult.expected_cash_in_drawer).toBeCloseTo(expected.expectedCashInDrawer, 2);
        expect(corteResult.difference).toBeCloseTo(expected.difference, 2);
        // With exact cash, difference should be 0
        expect(corteResult.difference).toBeCloseTo(0, 2);
    });
});
```

- [ ] **Step 2: Run only Bloque 1 to validate**

Run:
```bash
cd /c/SYA/sya-socketio-server && npm run test:qa -- --testNamePattern="Bloque 1"
```

Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add tests/multi-caja-qa.test.js
git commit -m "feat(qa): add Bloque 1 - single terminal basic operations

Tests cash/card sales, cancelled sale exclusion, expenses,
deposits, withdrawals, and corte difference calculation."
```

---

### Task 6: Test Suite — Bloque 2 (Discounts & Credit)

**Files:**
- Modify: `tests/multi-caja-qa.test.js` (append Bloque 2)

**Context:**
- Requires: `QA_CLIENT_CREDIT_GLOBAL_ID`, `QA_CLIENT_DISCOUNT_GLOBAL_ID`
- Credit sales (`tipo_pago_id=3`) appear in `totalCreditSales` but NOT in `expectedCashInDrawer`
- Credit payments appear in `totalCashPayments` or `totalCardPayments` and DO affect cash drawer
- Mixed payment (`tipo_pago_id=4`) is excluded from ALL totals — known gap

- [ ] **Step 1: Append Bloque 2 to the test file**

Add after Bloque 1's closing `});`:

```js
// ════════════════════════════════════════════════════════════════════════
// BLOQUE 2: Terminal Única — Descuentos y Crédito
// ════════════════════════════════════════════════════════════════════════
describe('Bloque 2: Single Terminal - Discounts & Credit', () => {
    let scenario;
    let cajaA;
    let corteResult;

    beforeAll(async () => {
        scenario = new ScenarioBuilder({
            tenantId: QA_CONFIG.tenantId,
            branchId: QA_CONFIG.branchId
        });
        await scenario.cleanup();

        cajaA = await scenario.createTerminal({
            terminalId: 'TEST-CAJA-A',
            employeeGlobalId: QA_CONFIG.cajero1GlobalId
        });

        await cajaA.openShift(500);

        // Sale with special product price (client pays $20/kg instead of $22/kg)
        await cajaA.createSale({
            items: [{ productName: 'Tortilla Maíz 1kg', quantity: 5, unitPrice: 20, listPrice: 22 }],
            tipoPagoId: 1,
            total: 100,
            subtotal: 110,
            totalDescuentos: 10,
            clientGlobalId: QA_CONFIG.clientDiscountGlobalId
        });

        // Sale with global percentage discount (10% off)
        await cajaA.createSale({
            items: [{ productName: 'Tortilla Maíz 1kg', quantity: 10, unitPrice: 19.80, listPrice: 22 }],
            tipoPagoId: 1,
            total: 198,
            subtotal: 220,
            totalDescuentos: 22,
            clientGlobalId: QA_CONFIG.clientDiscountGlobalId
        });

        // Credit sale (tipo_pago_id=3) — does NOT go into cash drawer
        await cajaA.createSale({
            items: [{ productName: 'Tortilla Maíz 1kg', quantity: 5, unitPrice: 22 }],
            tipoPagoId: 3,
            total: 110,
            clientGlobalId: QA_CONFIG.clientCreditGlobalId
        });

        // Partial credit payment in cash
        if (QA_CONFIG.clientCreditGlobalId) {
            await cajaA.createCreditPayment({
                clientGlobalId: QA_CONFIG.clientCreditGlobalId,
                amount: 50,
                paymentMethod: 'cash'
            });

            // Full credit payment by card
            await cajaA.createCreditPayment({
                clientGlobalId: QA_CONFIG.clientCreditGlobalId,
                amount: 60,
                paymentMethod: 'card'
            });
        }

        // Mixed payment sale (tipo_pago_id=4) — known gap
        await cajaA.createSale({
            items: [{ productName: 'Tortilla Maíz 1kg', quantity: 5, unitPrice: 22 }],
            tipoPagoId: 4,
            total: 110
        });

        // expected cash = 500 + (100 + 198) + 50 + 0 + 0 - 0 - 0 = 848
        corteResult = await cajaA.closeShift({ countedCash: 848 });
    }, 60000);

    afterAll(async () => {
        await scenario.cleanup();
        await scenario.destroy();
    }, 30000);

    test('discounted sales use discounted total', () => {
        // Cash sales = 100 + 198 = 298 (discounted prices, NOT list prices)
        // tipo_pago_id=4 sale ($110) is excluded
        expect(corteResult.total_cash_sales).toBeCloseTo(298, 2);
    });

    test('credit sale excluded from cash drawer', () => {
        // Credit sale ($110) goes to totalCreditSales, NOT expectedCashInDrawer
        expect(corteResult.total_credit_sales).toBeCloseTo(110, 2);
        // expectedCash should NOT include the $110 credit sale
        const expected = calculateExpectedCorte(500, cajaA.getTransactionLog(), 848);
        expect(expected.expectedCashInDrawer).toBeCloseTo(848, 2);
    });

    test('credit payments add to cash/card totals', () => {
        expect(corteResult.total_cash_payments).toBeCloseTo(50, 2);
        expect(corteResult.total_card_payments).toBeCloseTo(60, 2);
    });

    test('mixed payment (tipo_pago_id=4) excluded from all totals [KNOWN GAP]', () => {
        // tipo_pago_id=4 should NOT appear in cash, card, OR credit totals
        // If this test fails, the server now handles mixed payments — update corte-calculator
        const totalAccountedSales = corteResult.total_cash_sales + corteResult.total_card_sales + corteResult.total_credit_sales;
        // We created: $298 cash + $0 card + $110 credit = $408
        // Mixed $110 should be excluded
        expect(totalAccountedSales).toBeCloseTo(408, 2);
    });
});
```

- [ ] **Step 2: Run Bloque 2 to validate**

Run:
```bash
cd /c/SYA/sya-socketio-server && npm run test:qa -- --testNamePattern="Bloque 2"
```

Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add tests/multi-caja-qa.test.js
git commit -m "feat(qa): add Bloque 2 - discounts, credit, mixed payment

Tests special pricing, percentage discounts, credit sales/payments,
and documents the tipo_pago_id=4 mixed payment gap."
```

---

### Task 7: Test Suite — Bloque 3 (Multi-Caja Isolation)

**Files:**
- Modify: `tests/multi-caja-qa.test.js` (append Bloque 3)

**Context:**
- Requires: `QA_CAJERO_1_GLOBAL_ID`, `QA_CAJERO_2_GLOBAL_ID`
- Two terminals operating simultaneously in the same branch
- Each terminal's corte must ONLY include its own transactions
- Server filters by `id_turno` (shift ID) for completed sales and by date range for liquidated sales

- [ ] **Step 1: Append Bloque 3**

```js
// ════════════════════════════════════════════════════════════════════════
// BLOQUE 3: Multi-Caja — Aislamiento
// ════════════════════════════════════════════════════════════════════════
describe('Bloque 3: Multi-Caja Isolation', () => {
    let scenario;
    let cajaA, cajaB;
    let corteA, corteB;

    beforeAll(async () => {
        scenario = new ScenarioBuilder({
            tenantId: QA_CONFIG.tenantId,
            branchId: QA_CONFIG.branchId
        });
        await scenario.cleanup();

        cajaA = await scenario.createTerminal({
            terminalId: 'TEST-CAJA-A',
            employeeGlobalId: QA_CONFIG.cajero1GlobalId
        });
        cajaB = await scenario.createTerminal({
            terminalId: 'TEST-CAJA-B',
            employeeGlobalId: QA_CONFIG.cajero2GlobalId
        });

        // Open shifts
        await cajaA.openShift(500);
        await cajaB.openShift(300);

        // Terminal A: 2 cash sales ($110, $220)
        await cajaA.createSale({
            items: [{ productName: 'Tortilla Maíz 1kg', quantity: 5, unitPrice: 22 }],
            tipoPagoId: 1, total: 110
        });
        await cajaA.createSale({
            items: [{ productName: 'Tortilla Maíz 1kg', quantity: 10, unitPrice: 22 }],
            tipoPagoId: 1, total: 220
        });

        // Terminal B: 1 cash sale ($90), 1 expense ($50)
        await cajaB.createSale({
            items: [{ productName: 'Totopos 500g', quantity: 3, unitPrice: 30 }],
            tipoPagoId: 1, total: 90
        });
        await cajaB.createExpense({ categoryId: 2, amount: 50, description: 'Test expense B' });

        // Close both — A: expected = 500 + 330 = 830, B: expected = 300 + 90 - 50 = 340
        corteA = await cajaA.closeShift({ countedCash: 830 });
        corteB = await cajaB.closeShift({ countedCash: 340 });
    }, 60000);

    afterAll(async () => {
        await scenario.cleanup();
        await scenario.destroy();
    }, 30000);

    test('Terminal A corte excludes Terminal B transactions', () => {
        expect(corteA.total_cash_sales).toBeCloseTo(330, 2); // 110 + 220
        expect(corteA.total_expenses).toBeCloseTo(0, 2);      // No expenses for A
    });

    test('Terminal B corte excludes Terminal A transactions', () => {
        expect(corteB.total_cash_sales).toBeCloseTo(90, 2);   // Only B's sale
        expect(corteB.total_expenses).toBeCloseTo(50, 2);      // Only B's expense
    });

    test('Branch totals = sum of both cortes', () => {
        const branchCashSales = corteA.total_cash_sales + corteB.total_cash_sales;
        expect(branchCashSales).toBeCloseTo(420, 2); // 330 + 90
    });
});
```

- [ ] **Step 2: Run Bloque 3 to validate**

Run:
```bash
cd /c/SYA/sya-socketio-server && npm run test:qa -- --testNamePattern="Bloque 3"
```

Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add tests/multi-caja-qa.test.js
git commit -m "feat(qa): add Bloque 3 - multi-caja isolation

Verifies two terminals don't contaminate each other's corte
and branch totals equal the sum of individual cortes."
```

---

### Task 8: Test Suite — Bloque 4 (Repartidor Full Lifecycle)

**Files:**
- Modify: `tests/multi-caja-qa.test.js` (append Bloque 4)

**Context:**
- Requires: `QA_REPARTIDOR_GLOBAL_ID`, `QA_CLIENT_CREDIT_GLOBAL_ID`
- Repartidor lifecycle: assign → return partial → change client → liquidate
- Liquidation creates ventas with `estado_venta_id=5` and `fecha_liquidacion_utc`
- Liquidation totals are client-provided values sent with POST /api/cash-cuts

- [ ] **Step 1: Append Bloque 4**

```js
// ════════════════════════════════════════════════════════════════════════
// BLOQUE 4: Repartidor — Ciclo Completo
// ════════════════════════════════════════════════════════════════════════
describe('Bloque 4: Repartidor Full Lifecycle', () => {
    let scenario;
    let cajaA;
    let corteResult;
    let assignments;

    beforeAll(async () => {
        scenario = new ScenarioBuilder({
            tenantId: QA_CONFIG.tenantId,
            branchId: QA_CONFIG.branchId
        });
        await scenario.cleanup();

        cajaA = await scenario.createTerminal({
            terminalId: 'TEST-CAJA-A',
            employeeGlobalId: QA_CONFIG.cajero1GlobalId
        });

        await cajaA.openShift(500);

        // Assign products to repartidor
        assignments = await cajaA.assignToRepartidor({
            repartidorEmployeeGlobalId: QA_CONFIG.repartidorGlobalId,
            items: [
                { productName: 'Tortilla Maíz 1kg', quantity: 5, unitPrice: 22, unit: 'kg' },
                { productName: 'Totopos 500g', quantity: 3, unitPrice: 30, unit: 'pz' },
            ]
        });

        // Repartidor registers expense from mobile ($80 gas)
        const repartidorExpense = await cajaA.createExpense({
            categoryId: 1,
            amount: 80,
            description: 'Gasolina reparto',
            source: 'mobile'
        });

        // Desktop approves the expense
        await cajaA.approveExpense(repartidorExpense.globalId);

        // Return partial product (2 of 5 kg Tortilla Maíz)
        if (assignments[0]?.globalId) {
            await cajaA.registerReturn(assignments[0].globalId, {
                quantity: 2,
                unitPrice: 22
            });
        }

        // Change client on an assignment (repartidor assigned to wrong client)
        if (assignments[1]?.globalId && QA_CONFIG.clientCreditGlobalId) {
            await cajaA.changeAssignmentClient(assignments[1].globalId, {
                newClientGlobalId: QA_CONFIG.clientCreditGlobalId
            });
        }

        // Liquidate: repartidor sold 3kg Maíz ($66) + 3pz Totopos ($90) = $156
        // Payment: cash $100 + card $50 + credit $6
        //
        // NOTE: Liquidation totals (liqCash/liqCard/liqCredit) are client-provided values
        // sent with POST /api/cash-cuts. The server adds them to the formula SEPARATELY
        // from the sale totals. The actual ventas with estado_venta_id=5 ALSO appear in
        // totalCashSales/totalCardSales. This means if we create liquidated sales AND
        // send liqCash, the formula double-counts. In the real Desktop, the liqCash
        // represents the same money as the liquidated sales.
        //
        // To test accurately without double-counting, we send liqCash/liqCard/liqCredit
        // and do NOT create separate estado=5 sales. The liqTotals are the full story.

        // Track liquidation totals (these go to POST /api/cash-cuts body)
        cajaA.addLiquidation({ cashAmount: 100, cardAmount: 50, creditAmount: 6 });

        // Close shift
        // expectedCash = 500 + 0(cashSales) + 0(cashPayments) + 100(liqCash) + 0(deposits) - 80(expense) - 0(withdrawals) = 520
        corteResult = await cajaA.closeShift({ countedCash: 520 });
    }, 90000);

    afterAll(async () => {
        await scenario.cleanup();
        await scenario.destroy();
    }, 30000);

    test('liquidation cash/card/credit flow into corte', () => {
        expect(corteResult.total_liquidaciones_efectivo).toBeCloseTo(100, 2);
        expect(corteResult.total_liquidaciones_tarjeta).toBeCloseTo(50, 2);
        expect(corteResult.total_liquidaciones_credito).toBeCloseTo(6, 2);
    });

    test('repartidor expense appears in corte', () => {
        expect(corteResult.total_expenses).toBeCloseTo(80, 2);
        expect(corteResult.total_repartidor_expenses).toBeCloseTo(80, 2);
    });

    test('liquidated sales appear in corte sale totals', () => {
        // Liquidated cash sale ($66) should be in total_cash_sales
        // Liquidated card sale ($90) should be in total_card_sales
        expect(corteResult.total_cash_sales).toBeCloseTo(66, 2);
        expect(corteResult.total_card_sales).toBeCloseTo(90, 2);
    });

    test('client change reflected in assignment', async () => {
        if (assignments[1]?.globalId && QA_CONFIG.clientCreditGlobalId) {
            const { rows } = await scenario.pool.query(
                'SELECT customer_global_id FROM repartidor_assignments WHERE global_id = $1',
                [assignments[1].globalId]
            );
            expect(rows[0].customer_global_id).toBe(QA_CONFIG.clientCreditGlobalId);
        }
    });

    test('expected cash calculation is correct', () => {
        const expected = calculateExpectedCorte(500, cajaA.getTransactionLog(), 520);
        expect(corteResult.expected_cash_in_drawer).toBeCloseTo(expected.expectedCashInDrawer, 2);
        expect(corteResult.difference).toBeCloseTo(0, 2);
    });
});
```

- [ ] **Step 2: Run Bloque 4 to validate**

Run:
```bash
cd /c/SYA/sya-socketio-server && npm run test:qa -- --testNamePattern="Bloque 4"
```

Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add tests/multi-caja-qa.test.js
git commit -m "feat(qa): add Bloque 4 - repartidor full lifecycle

Tests assignment, returns, mobile expense approval, liquidation
with mixed payments, and corte verification."
```

---

### Task 9: Test Suite — Bloque 5 (Expense Workflows)

**Files:**
- Modify: `tests/multi-caja-qa.test.js` (append Bloque 5)

**Context:**
- Expense rejection: `PATCH /api/expenses/:global_id/deactivate` sets `is_active=false`
- Expense editing: `PATCH /api/expenses/:global_id` updates amount/description
- Expense approval: `PATCH /api/expenses/:global_id/approve`
- Only expenses with `is_active=true` appear in corte

- [ ] **Step 1: Append Bloque 5**

```js
// ════════════════════════════════════════════════════════════════════════
// BLOQUE 5: Repartidor — Flujo de Gastos
// ════════════════════════════════════════════════════════════════════════
describe('Bloque 5: Repartidor Expense Workflows', () => {
    let scenario;
    let cajaA;
    let corteResult;

    beforeAll(async () => {
        scenario = new ScenarioBuilder({
            tenantId: QA_CONFIG.tenantId,
            branchId: QA_CONFIG.branchId
        });
        await scenario.cleanup();

        cajaA = await scenario.createTerminal({
            terminalId: 'TEST-CAJA-A',
            employeeGlobalId: QA_CONFIG.cajero1GlobalId
        });

        await cajaA.openShift(500);

        // Expense 1: Repartidor sends $50 — Desktop REJECTS it
        const expense1 = await cajaA.createExpense({
            categoryId: 1, amount: 50, description: 'Combustible (original)',
            source: 'mobile'
        });
        await cajaA.rejectExpense(expense1.globalId, 'Monto incorrecto');

        // Expense 2: Repartidor resubmits corrected — Desktop EDITS amount and APPROVES
        const expense2 = await cajaA.createExpense({
            categoryId: 1, amount: 50, description: 'Combustible (corregido)',
            source: 'mobile'
        });
        await cajaA.editExpense(expense2.globalId, { amount: 45 });
        await cajaA.approveExpense(expense2.globalId);

        // Expense 3: $30 food — Desktop approves directly
        const expense3 = await cajaA.createExpense({
            categoryId: 3, amount: 30, description: 'Comida repartidor',
            source: 'mobile'
        });
        await cajaA.approveExpense(expense3.globalId);

        // expected total expenses: $45 + $30 = $75 (rejected $50 excluded)
        // expectedCash = 500 - 75 = 425
        corteResult = await cajaA.closeShift({ countedCash: 425 });
    }, 60000);

    afterAll(async () => {
        await scenario.cleanup();
        await scenario.destroy();
    }, 30000);

    test('rejected expense (is_active=false) excluded from corte', () => {
        // Only $45 + $30 = $75 should appear (NOT $50 rejected one)
        expect(corteResult.total_expenses).toBeCloseTo(75, 2);
    });

    test('edited expense uses corrected amount', () => {
        // The $50 was edited to $45 before approval
        // Total = $45 + $30 = $75
        expect(corteResult.total_expenses).toBeCloseTo(75, 2);
        expect(corteResult.expected_cash_in_drawer).toBeCloseTo(425, 2);
    });

    test('difference is zero with exact cash', () => {
        expect(corteResult.difference).toBeCloseTo(0, 2);
    });
});
```

- [ ] **Step 2: Run Bloque 5 to validate**

Run:
```bash
cd /c/SYA/sya-socketio-server && npm run test:qa -- --testNamePattern="Bloque 5"
```

Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add tests/multi-caja-qa.test.js
git commit -m "feat(qa): add Bloque 5 - expense reject/edit/approve workflows

Tests that rejected expenses (is_active=false) are excluded,
edited amounts use corrected values, and approval flow works."
```

---

### Task 10: Test Suite — Bloque 6 (Cross-Device Consistency)

**Files:**
- Modify: `tests/multi-caja-qa.test.js` (append Bloque 6)

**Context:**
- Same corte should return identical data regardless of which JWT queries it
- GET /api/cash-cuts?shiftId=X returns the same data for any authenticated user
- GET /api/cash-cuts?branch_id=X returns all cortes for the branch

- [ ] **Step 1: Append Bloque 6**

```js
// ════════════════════════════════════════════════════════════════════════
// BLOQUE 6: Consistencia Cross-Device
// ════════════════════════════════════════════════════════════════════════
describe('Bloque 6: Cross-Device Consistency', () => {
    let scenario;
    let cajaA;
    let corteResult;

    beforeAll(async () => {
        scenario = new ScenarioBuilder({
            tenantId: QA_CONFIG.tenantId,
            branchId: QA_CONFIG.branchId
        });
        await scenario.cleanup();

        cajaA = await scenario.createTerminal({
            terminalId: 'TEST-CAJA-A',
            employeeGlobalId: QA_CONFIG.cajero1GlobalId
        });

        await cajaA.openShift(500);

        // Create a mix of transactions
        await cajaA.createSale({
            items: [{ productName: 'Tortilla Maíz 1kg', quantity: 5, unitPrice: 22 }],
            tipoPagoId: 1, total: 110
        });
        await cajaA.createSale({
            items: [{ productName: 'Totopos', quantity: 2, unitPrice: 30 }],
            tipoPagoId: 2, total: 60
        });
        await cajaA.createExpense({ categoryId: 2, amount: 50, description: 'Test' });

        corteResult = await cajaA.closeShift({ countedCash: 560 });
    }, 60000);

    afterAll(async () => {
        await scenario.cleanup();
        await scenario.destroy();
    }, 30000);

    test('Terminal A corte === Terminal B query === branch summary', async () => {
        // Query 1: same shift, Terminal A's JWT
        const query1 = await scenario.queryCorte(cajaA.shiftId, cajaA.token);
        expect(query1.body.success).toBe(true);
        const corte1 = query1.body.data[0];

        // Query 2: same shift, different JWT (if cajero2 is available)
        let corte2 = corte1;
        if (QA_CONFIG.cajero2GlobalId) {
            const cajaB = await scenario.createTerminal({
                terminalId: 'TEST-CAJA-B',
                employeeGlobalId: QA_CONFIG.cajero2GlobalId
            });
            const query2 = await scenario.queryCorte(cajaA.shiftId, cajaB.token);
            corte2 = query2.body.data[0];
        }

        // Query 3: branch summary
        const query3 = await scenario.queryBranchSummary(cajaA.token);
        const corte3 = query3.body.data.find(c => c.shift_id === cajaA.shiftId);

        // All three should return identical values
        const fields = [
            'total_cash_sales', 'total_card_sales', 'total_credit_sales',
            'total_cash_payments', 'total_card_payments',
            'total_expenses', 'total_deposits', 'total_withdrawals',
            'total_liquidaciones_efectivo', 'total_liquidaciones_tarjeta', 'total_liquidaciones_credito',
            'expected_cash_in_drawer', 'difference'
        ];

        for (const field of fields) {
            expect(corte1[field]).toBeCloseTo(corte2[field], 2);
            if (corte3) {
                expect(corte1[field]).toBeCloseTo(corte3[field], 2);
            }
        }
    });
});
```

- [ ] **Step 2: Run Bloque 6 to validate**

Run:
```bash
cd /c/SYA/sya-socketio-server && npm run test:qa -- --testNamePattern="Bloque 6"
```

Expected: 1 test passes.

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add tests/multi-caja-qa.test.js
git commit -m "feat(qa): add Bloque 6 - cross-device consistency

Verifies that corte data is identical regardless of which
JWT queries it (Terminal A, Terminal B, or branch summary)."
```

---

### Task 11: Test Suite — Bloque 7 (Trust Model Edge Case)

**Files:**
- Modify: `tests/multi-caja-qa.test.js` (append Bloque 7)

**Context:**
- The server stores liquidation totals as-is from the client request
- If the client sends incorrect values, the server stores them anyway
- This test documents this "trust the client" model

- [ ] **Step 1: Append Bloque 7**

```js
// ════════════════════════════════════════════════════════════════════════
// BLOQUE 7: Edge Cases — Modelo de Confianza de Liquidaciones
// ════════════════════════════════════════════════════════════════════════
describe('Bloque 7: Edge Cases - Trust Model', () => {
    let scenario;
    let cajaA;
    let corteResult;

    beforeAll(async () => {
        scenario = new ScenarioBuilder({
            tenantId: QA_CONFIG.tenantId,
            branchId: QA_CONFIG.branchId
        });
        await scenario.cleanup();

        cajaA = await scenario.createTerminal({
            terminalId: 'TEST-CAJA-A',
            employeeGlobalId: QA_CONFIG.cajero1GlobalId
        });

        await cajaA.openShift(500);

        // Close shift with INTENTIONALLY WRONG liquidation totals
        // No actual liquidation happened, but we send $999
        corteResult = await cajaA.closeShift({
            countedCash: 1499,
            liquidacionTotals: {
                totalLiquidacionesEfectivo: 999,
                totalLiquidacionesTarjeta: 0,
                totalLiquidacionesCredito: 0,
                totalRepartidorExpenses: 0
            }
        });
    }, 60000);

    afterAll(async () => {
        await scenario.cleanup();
        await scenario.destroy();
    }, 30000);

    test('server stores client-provided liquidation totals as-is', () => {
        // Server should store $999, not $0 (no real liquidation happened)
        expect(corteResult.total_liquidaciones_efectivo).toBeCloseTo(999, 2);
        // expectedCash = 500 + 0 + 0 + 999 + 0 - 0 - 0 = 1499
        expect(corteResult.expected_cash_in_drawer).toBeCloseTo(1499, 2);
        expect(corteResult.difference).toBeCloseTo(0, 2);
    });
});
```

- [ ] **Step 2: Run the full suite to validate all 7 blocks**

Run:
```bash
cd /c/SYA/sya-socketio-server && npm run test:qa -- --verbose
```

Expected: All 16+ tests pass.

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add tests/multi-caja-qa.test.js
git commit -m "feat(qa): add Bloque 7 - trust model edge case

Documents that the server stores client-provided liquidation
totals as-is without validation. Tests the trust model."
```

---

### Task 12: Test Suite — Bloque 8 (Inventory on Cancellation & Credit)

**Files:**
- Modify: `tests/multi-caja-qa.test.js` (append Bloque 8)

**Context:**
- Products with `inventariar=true` should have inventory restored on sale cancellation
- `POST /api/sales/:id/cancel` restores inventory (unlike `cancelaciones/sync` which only logs)
- Credit sales also affect inventory the same way as cash/card sales
- The server does NOT decrement inventory on sale creation (Desktop handles that)
- For testing: we manually set inventory, decrement it (simulating Desktop), cancel, verify restoration
- Requires: `QA_PRODUCT_WITH_INVENTORY_GLOBAL_ID` env var (a product with `inventariar=true`)

- [ ] **Step 1: Append Bloque 8**

```js
// ════════════════════════════════════════════════════════════════════════
// BLOQUE 8: Inventario — Cancelaciones y Crédito
// ════════════════════════════════════════════════════════════════════════
describe('Bloque 8: Inventory on Cancellation & Credit', () => {
    let scenario;
    let cajaA;
    const PRODUCT_GLOBAL_ID = process.env.QA_PRODUCT_WITH_INVENTORY_GLOBAL_ID;
    let originalInventory;

    beforeAll(async () => {
        if (!PRODUCT_GLOBAL_ID) {
            console.warn('⚠️ QA_PRODUCT_WITH_INVENTORY_GLOBAL_ID not set — skipping inventory tests');
            return;
        }

        scenario = new ScenarioBuilder({
            tenantId: QA_CONFIG.tenantId,
            branchId: QA_CONFIG.branchId
        });
        await scenario.cleanup();

        cajaA = await scenario.createTerminal({
            terminalId: 'TEST-CAJA-A',
            employeeGlobalId: QA_CONFIG.cajero1GlobalId
        });

        // Save original inventory to restore later
        const productInfo = await cajaA.getProductInventory(PRODUCT_GLOBAL_ID);
        originalInventory = productInfo.inventario;

        // Set inventory to a known value
        await cajaA.setProductInventory(PRODUCT_GLOBAL_ID, 100);

        await cajaA.openShift(500);
    }, 60000);

    afterAll(async () => {
        if (PRODUCT_GLOBAL_ID && cajaA) {
            // Restore original inventory
            await cajaA.setProductInventory(PRODUCT_GLOBAL_ID, originalInventory);
        }
        if (scenario) {
            await scenario.cleanup();
            await scenario.destroy();
        }
    }, 30000);

    test('cancelled cash sale restores inventory (inventariar=true)', async () => {
        if (!PRODUCT_GLOBAL_ID) return;

        // Simulate Desktop: decrement inventory for a 5-unit sale
        await cajaA.setProductInventory(PRODUCT_GLOBAL_ID, 95); // 100 - 5

        // Create a cash sale
        const sale = await cajaA.createSale({
            items: [{
                productGlobalId: PRODUCT_GLOBAL_ID,
                productName: 'Test Inventory Product',
                quantity: 5,
                unitPrice: 22
            }],
            tipoPagoId: 1,
            total: 110
        });

        // Cancel using the endpoint that restores inventory
        await cajaA.cancelSaleWithInventoryRestore(sale.numericId);

        // Verify inventory was restored
        const after = await cajaA.getProductInventory(PRODUCT_GLOBAL_ID);
        expect(after.inventario).toBeCloseTo(100, 2); // Back to 100 (95 + 5)
    });

    test('cancelled credit sale restores inventory same as cash', async () => {
        if (!PRODUCT_GLOBAL_ID) return;

        // Reset inventory
        await cajaA.setProductInventory(PRODUCT_GLOBAL_ID, 100);
        // Simulate Desktop decrement
        await cajaA.setProductInventory(PRODUCT_GLOBAL_ID, 92); // 100 - 8

        // Create a credit sale
        const creditSale = await cajaA.createSale({
            items: [{
                productGlobalId: PRODUCT_GLOBAL_ID,
                productName: 'Test Inventory Product',
                quantity: 8,
                unitPrice: 22
            }],
            tipoPagoId: 3, // Credit
            total: 176,
            clientGlobalId: QA_CONFIG.clientCreditGlobalId
        });

        // Cancel — inventory should restore regardless of payment type
        await cajaA.cancelSaleWithInventoryRestore(creditSale.numericId);

        // Verify inventory was restored
        const after = await cajaA.getProductInventory(PRODUCT_GLOBAL_ID);
        expect(after.inventario).toBeCloseTo(100, 2); // Back to 100 (92 + 8)
    });

    test('non-cancelled sale does NOT change inventory on server', async () => {
        if (!PRODUCT_GLOBAL_ID) return;

        // Set known inventory
        await cajaA.setProductInventory(PRODUCT_GLOBAL_ID, 100);

        // Create a sale (server does NOT decrement — that's Desktop's job)
        await cajaA.createSale({
            items: [{
                productGlobalId: PRODUCT_GLOBAL_ID,
                productName: 'Test Inventory Product',
                quantity: 3,
                unitPrice: 22
            }],
            tipoPagoId: 1,
            total: 66
        });

        // Verify server did NOT change inventory
        const after = await cajaA.getProductInventory(PRODUCT_GLOBAL_ID);
        expect(after.inventario).toBeCloseTo(100, 2); // Still 100
    });
});
```

- [ ] **Step 2: Run Bloque 8 to validate**

Run:
```bash
cd /c/SYA/sya-socketio-server && npm run test:qa -- --testNamePattern="Bloque 8"
```

Expected: 3 tests pass (or skip if env var not set).

- [ ] **Step 3: Commit**

```bash
cd /c/SYA/sya-socketio-server
git add tests/multi-caja-qa.test.js
git commit -m "feat(qa): add Bloque 8 - inventory on cancellation & credit

Verifies that inventory is restored when sales are cancelled
(both cash and credit), and that sale creation does not
decrement inventory on the server side."
```

---

### Task 13: Final Integration Run

**Files:**
- All files already created
- Verify full suite end-to-end

- [ ] **Step 1: Run full cleanup to ensure clean state**

```bash
cd /c/SYA/sya-socketio-server && node scripts/cleanup/clean-test-run.js
```

- [ ] **Step 2: Run the complete QA suite**

```bash
cd /c/SYA/sya-socketio-server && npm run test:qa -- --verbose
```

Expected: All tests pass. Output shows transaction cleanup counts.

- [ ] **Step 3: Verify cleanup worked — no TEST-* records left**

```bash
cd /c/SYA/sya-socketio-server && node -e "
const { Pool } = require('pg');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
async function check() {
    const tables = ['shifts', 'ventas', 'expenses', 'deposits', 'withdrawals', 'cash_cuts'];
    for (const t of tables) {
        const { rows } = await pool.query(
            \`SELECT count(*)::int as cnt FROM \${t} WHERE terminal_id LIKE 'TEST-%'\`
        );
        console.log(\`  \${t}: \${rows[0].cnt} TEST-* records\`);
    }
    await pool.end();
}
check();
"
```

Expected: All counts are 0.

- [ ] **Step 4: Push to Render**

```bash
cd /c/SYA/sya-socketio-server && git push
```
