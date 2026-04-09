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

class ScenarioBuilder {
    constructor({ tenantId, branchId }) {
        this.tenantId = tenantId;
        this.branchId = branchId;
        this.terminals = [];
        this.pool = new Pool(POOL_CONFIG);
        this.createdRecords = [];
    }

    async createTerminal({ terminalId, employeeGlobalId, employeeId, clientType = 'desktop' }) {
        if (!terminalId.startsWith('TEST-')) {
            throw new Error(`Terminal ID must start with TEST-. Got: ${terminalId}`);
        }
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
            terminalId, employeeGlobalId, employeeId,
            tenantId: this.tenantId, branchId: this.branchId,
            token, clientType, pool: this.pool, scenario: this
        });
        this.terminals.push(terminal);
        return terminal;
    }

    async queryCorte(shiftId, token) {
        return apiRequest('GET', `/api/cash-cuts?shiftId=${shiftId}`, null, token);
    }

    async queryBranchSummary(token) {
        return apiRequest('GET', `/api/cash-cuts?branch_id=${this.branchId}`, null, token);
    }

    trackRecord(table, identifiers) {
        this.createdRecords.push({ table, ...identifiers });
    }

    async cleanup() {
        const cleanupQueries = [
            `DELETE FROM cancelaciones_bitacora WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            `DELETE FROM credit_payments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            `DELETE FROM ventas_detalle WHERE id_venta IN (
                SELECT id_venta FROM ventas WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
            )`,
            `DELETE FROM ventas WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            `DELETE FROM repartidor_returns WHERE assignment_id IN (
                SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
            )`,
            `DELETE FROM repartidor_debts WHERE assignment_id IN (
                SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
            )`,
            `DELETE FROM repartidor_liquidations WHERE assignment_id IN (
                SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
            )`,
            `DELETE FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            `DELETE FROM cash_cuts WHERE shift_id IN (
                SELECT id FROM shifts WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
            )`,
            `DELETE FROM expenses WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            `DELETE FROM deposits WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
            `DELETE FROM withdrawals WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1`,
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
                console.warn(`  [Cleanup] Warning: ${err.message}`);
            }
        }

        for (const t of this.terminals) {
            if (t.socket) t.socket.disconnect();
        }
    }

    async destroy() {
        await this.pool.end();
    }
}

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
        this.transactions = [];
        this.createdGlobalIds = {};
    }

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

        const numericId = res.body.data?.id_venta || res.body.data?.id;
        this.transactions.push({
            type: 'sale', amount: total, tipoPagoId, estadoVentaId, globalId, numericId
        });
        this.createdGlobalIds[`sale_${globalId}`] = globalId;
        return { globalId, numericId, ...res.body.data };
    }

    async cancelSale(saleGlobalId) {
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

        // CRITICAL: Update the venta's estado_venta_id to 4 (Cancelled)
        // cancelaciones/sync only inserts into bitacora, doesn't update the venta
        await this.pool.query(
            `UPDATE ventas SET estado_venta_id = 4 WHERE global_id = $1 AND tenant_id = $2`,
            [saleGlobalId, this.tenantId]
        );

        const saleTx = this.transactions.find(tx => tx.type === 'sale' && tx.globalId === saleGlobalId);
        if (saleTx) saleTx.estadoVentaId = 4;
        return res.body;
    }

    async createExpense({ categoryId, amount, description, source = 'desktop' }) {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();
        const res = await apiRequest('POST', '/api/expenses/sync', {
            tenantId: this.tenantId, branchId: this.branchId,
            employee_global_id: this.employeeGlobalId,
            shift_global_id: this.shiftGlobalId,
            global_category_id: categoryId, category: 'Test Category',
            description, amount, quantity: 1, payment_type_id: 1,
            expense_date_utc: now, global_id: globalId,
            terminal_id: this.terminalId, local_op_seq: 1,
            created_local_utc: now, source
        }, this.token);

        if (!res.body.success) {
            throw new Error(`createExpense failed: ${JSON.stringify(res.body)}`);
        }
        this.transactions.push({
            type: 'expense', amount, isActive: true,
            isRepartidorExpense: source === 'mobile', globalId
        });
        this.createdGlobalIds[`expense_${globalId}`] = globalId;
        return { globalId, ...res.body.data };
    }

    async approveExpense(expenseGlobalId) {
        const res = await apiRequest('PATCH', `/api/expenses/${expenseGlobalId}/approve`, {
            tenant_id: this.tenantId,
            reviewer_employee_global_id: this.employeeGlobalId
        }, this.token);
        return res.body;
    }

    async rejectExpense(expenseGlobalId, reason) {
        const res = await apiRequest('PATCH', `/api/expenses/${expenseGlobalId}/deactivate`, {
            tenant_id: this.tenantId, reason,
            rejected_by_employee_global_id: this.employeeGlobalId
        }, this.token);
        const expTx = this.transactions.find(tx => tx.type === 'expense' && tx.globalId === expenseGlobalId);
        if (expTx) expTx.isActive = false;
        return res.body;
    }

    async editExpense(expenseGlobalId, { amount, description }) {
        const body = { tenant_id: this.tenantId };
        if (amount !== undefined) body.amount = amount;
        if (description !== undefined) body.description = description;
        const res = await apiRequest('PATCH', `/api/expenses/${expenseGlobalId}`, body, this.token);
        if (amount !== undefined) {
            const expTx = this.transactions.find(tx => tx.type === 'expense' && tx.globalId === expenseGlobalId);
            if (expTx) expTx.amount = amount;
        }
        return res.body;
    }

    async createDeposit(amount, description = 'Test deposit') {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();
        const res = await apiRequest('POST', '/api/deposits/sync', {
            tenantId: this.tenantId, branchId: this.branchId,
            shift_global_id: this.shiftGlobalId,
            employee_global_id: this.employeeGlobalId,
            amount, description, authorized_by: 'Test Admin',
            deposit_date_utc: now, global_id: globalId,
            terminal_id: this.terminalId, local_op_seq: 1,
            created_local_utc: now
        }, this.token);
        if (!res.body.success) throw new Error(`createDeposit failed: ${JSON.stringify(res.body)}`);
        this.transactions.push({ type: 'deposit', amount, globalId });
        this.createdGlobalIds[`deposit_${globalId}`] = globalId;
        return { globalId, ...res.body.data };
    }

    async createWithdrawal(amount, description = 'Test withdrawal') {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();
        const res = await apiRequest('POST', '/api/withdrawals/sync', {
            tenantId: this.tenantId, branchId: this.branchId,
            shift_global_id: this.shiftGlobalId,
            employee_global_id: this.employeeGlobalId,
            amount, description, authorized_by: 'Test Admin',
            withdrawal_date_utc: now, global_id: globalId,
            terminal_id: this.terminalId, local_op_seq: 1,
            created_local_utc: now
        }, this.token);
        if (!res.body.success) throw new Error(`createWithdrawal failed: ${JSON.stringify(res.body)}`);
        this.transactions.push({ type: 'withdrawal', amount, globalId });
        this.createdGlobalIds[`withdrawal_${globalId}`] = globalId;
        return { globalId, ...res.body.data };
    }

    async createCreditPayment({ clientGlobalId, amount, paymentMethod }) {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();
        const res = await apiRequest('POST', '/api/credit-payments/sync', {
            tenantId: this.tenantId, branchId: this.branchId,
            customer_global_id: clientGlobalId,
            shift_global_id: this.shiftGlobalId,
            employee_global_id: this.employeeGlobalId,
            amount, paymentMethod, notes: 'Test credit payment',
            global_id: globalId, terminal_id: this.terminalId,
            local_op_seq: 1, created_local_utc: now
        }, this.token);
        if (!res.body.success) throw new Error(`createCreditPayment failed: ${JSON.stringify(res.body)}`);
        this.transactions.push({ type: 'credit_payment', amount, paymentMethod, globalId });
        this.createdGlobalIds[`credit_payment_${globalId}`] = globalId;
        return { globalId, ...res.body.data };
    }

    async assignToRepartidor({ repartidorEmployeeGlobalId, repartidorShiftGlobalId, items }) {
        const results = [];
        for (const item of items) {
            const globalId = crypto.randomUUID();
            const now = new Date().toISOString();
            const res = await apiRequest('POST', '/api/repartidor-assignments/sync', {
                tenant_id: this.tenantId, branch_id: this.branchId,
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
                status: 'pending', fecha_asignacion: now,
                global_id: globalId, terminal_id: this.terminalId,
                local_op_seq: 1, created_local_utc: now
            }, this.token);
            results.push({ globalId, item, ...res.body });
            this.createdGlobalIds[`assignment_${globalId}`] = globalId;
        }
        return results;
    }

    async changeAssignmentClient(assignmentGlobalId, { newClientGlobalId }) {
        const { rows } = await this.pool.query(
            'SELECT id FROM customers WHERE global_id = $1 AND tenant_id = $2',
            [newClientGlobalId, this.tenantId]
        );
        const clientId = rows.length > 0 ? rows[0].id : null;
        await this.pool.query(
            `UPDATE repartidor_assignments SET customer_id = $1, customer_global_id = $2, updated_at = NOW()
             WHERE global_id = $3 AND tenant_id = $4`,
            [clientId, newClientGlobalId, assignmentGlobalId, this.tenantId]
        );
        return { success: true, assignmentGlobalId, newClientGlobalId };
    }

    async registerReturn(assignmentGlobalId, { quantity, unitPrice }) {
        const globalId = crypto.randomUUID();
        const now = new Date().toISOString();
        const res = await apiRequest('POST', '/api/repartidor-returns/sync', {
            tenant_id: this.tenantId, branch_id: this.branchId,
            assignment_global_id: assignmentGlobalId,
            employee_global_id: this.employeeGlobalId,
            shift_global_id: this.shiftGlobalId,
            quantity, unit_price: unitPrice,
            amount: quantity * unitPrice,
            return_date: now, source: 'desktop',
            global_id: globalId, terminal_id: this.terminalId,
            local_op_seq: 1, created_local_utc: now
        }, this.token);
        this.createdGlobalIds[`return_${globalId}`] = globalId;
        return { globalId, ...res.body };
    }

    async closeShift({ countedCash, liquidacionTotals }) {
        // Close the shift by setting end_time directly in DB
        await this.pool.query(
            `UPDATE shifts SET end_time = NOW(), is_cash_cut_open = false WHERE id = $1`,
            [this.shiftId]
        );

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
        return { totalLiquidacionesEfectivo, totalLiquidacionesTarjeta, totalLiquidacionesCredito, totalRepartidorExpenses };
    }

    addLiquidation({ cashAmount = 0, cardAmount = 0, creditAmount = 0 }) {
        this.transactions.push({ type: 'liquidation', cashAmount, cardAmount, creditAmount });
    }

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

    async setProductInventory(productGlobalId, quantity) {
        await this.pool.query(
            `UPDATE productos SET inventario = $1 WHERE global_id = $2 AND tenant_id = $3`,
            [quantity, productGlobalId, this.tenantId]
        );
    }

    async cancelSaleWithInventoryRestore(saleNumericId) {
        const res = await apiRequest('POST', `/api/sales/${saleNumericId}/cancel`, {
            cancelReason: 'Test cancellation with inventory restore',
            cancelledByEmployeeId: this.employeeId
        }, this.token);
        const saleTx = this.transactions.find(tx => tx.type === 'sale' && tx.numericId === saleNumericId);
        if (saleTx) saleTx.estadoVentaId = 4;
        return res.body;
    }

    getTransactionLog() {
        return [...this.transactions];
    }

    getSocket() {
        return this.socket;
    }
}

module.exports = { ScenarioBuilder, Terminal };
