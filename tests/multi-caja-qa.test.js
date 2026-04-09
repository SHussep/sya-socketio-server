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
        if (!PRODUCT_GLOBAL_ID || !QA_CONFIG.clientCreditGlobalId) return;

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
