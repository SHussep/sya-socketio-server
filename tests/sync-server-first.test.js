/**
 * SYNC SERVER-FIRST INTEGRATION TESTS
 *
 * Simulates the exact payloads that Desktop WinUI sends to each sync endpoint.
 * Verifies:
 *   1. Data lands correctly in PostgreSQL
 *   2. GlobalId idempotency (double-send = no duplicate)
 *   3. GlobalId resolution (FK references resolve via GlobalId)
 *   4. Dependency chain (employee → shift → sale → assignment → return)
 *   5. Update flow (PUT after initial POST)
 *
 * Prerequisites:
 *   1. Server running: cd /c/SYA/sya-socketio-server && node server.js
 *   2. Set env: JWT_SECRET=<secret> DATABASE_URL=<pg_connection_string>
 *   Run: npm test -- tests/sync-server-first.test.js
 */

const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { POOL_CONFIG } = require('./helpers/test-setup');

const SERVER_URL = process.env.TEST_SERVER_URL || 'http://127.0.0.1:3000';
const JWT_SECRET = process.env.JWT_SECRET;

// ── Test IDs (high range to avoid collisions) ──────────────────────
const TENANT_ID = 1;
const BRANCH_ID = 99901;
const EMP_ID = 99901;

// Generate GlobalIds for all test entities
const G = {
    employee:       crypto.randomUUID(),
    shift:          crypto.randomUUID(),
    customer:       crypto.randomUUID(),
    product:        crypto.randomUUID(),
    supplier:       crypto.randomUUID(),
    sale:           crypto.randomUUID(),
    saleDetail:     crypto.randomUUID(),
    expense:        crypto.randomUUID(),
    purchase:       crypto.randomUUID(),
    purchaseDetail: crypto.randomUUID(),
    deposit:        crypto.randomUUID(),
    withdrawal:     crypto.randomUUID(),
    cashCut:        crypto.randomUUID(),
    assignment:     crypto.randomUUID(),
    returnItem:     crypto.randomUUID(),
    creditPayment:  crypto.randomUUID(),
    cancelacion:    crypto.randomUUID(),
};

function makeToken(employeeId = EMP_ID, branchId = BRANCH_ID) {
    return jwt.sign(
        { tenantId: TENANT_ID, employeeId, branchId, role: 'owner', is_owner: true },
        JWT_SECRET,
        { expiresIn: '1h' }
    );
}

const TOKEN = makeToken();
const AUTH = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` };

async function syncPost(path, body) {
    const res = await fetch(`${SERVER_URL}${path}`, {
        method: 'POST', headers: AUTH, body: JSON.stringify(body)
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, body: json };
}

async function syncPut(path, body) {
    const res = await fetch(`${SERVER_URL}${path}`, {
        method: 'PUT', headers: AUTH, body: JSON.stringify(body)
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, body: json };
}

// ════════════════════════════════════════════════════════════════════
describe('Sync Server-First Integration', () => {
    let pool;

    beforeAll(async () => {
        pool = new Pool(POOL_CONFIG);
        await pool.query(`
            INSERT INTO branches (id, tenant_id, branch_code, name, multi_caja_enabled)
            VALUES ($1, $2, 'TEST_SYNC', 'Test Sync Branch', true)
            ON CONFLICT (id) DO NOTHING
        `, [BRANCH_ID, TENANT_ID]);
    }, 15000);

    afterAll(async () => {
        // Cleanup in reverse dependency order
        const cleanup = [
            'DELETE FROM cancelaciones_bitacora WHERE tenant_id = $1 AND branch_id = $2',
            'DELETE FROM credit_payments WHERE tenant_id = $1 AND branch_id = $2',
            'DELETE FROM repartidor_returns WHERE tenant_id = $1 AND branch_id = $2',
            'DELETE FROM repartidor_assignments WHERE tenant_id = $1 AND branch_id = $2',
            'DELETE FROM cash_cuts WHERE tenant_id = $1 AND branch_id = $2',
            'DELETE FROM withdrawals WHERE tenant_id = $1 AND branch_id = $2',
            'DELETE FROM deposits WHERE tenant_id = $1 AND branch_id = $2',
            'DELETE FROM ventas_detalle WHERE id_venta IN (SELECT id_venta FROM ventas WHERE tenant_id = $1 AND branch_id = $2)',
            'DELETE FROM ventas WHERE tenant_id = $1 AND branch_id = $2',
            'DELETE FROM expenses WHERE tenant_id = $1 AND branch_id = $2',
            'DELETE FROM purchase_details WHERE purchase_id IN (SELECT id FROM purchases WHERE tenant_id = $1 AND branch_id = $2)',
            'DELETE FROM purchases WHERE tenant_id = $1 AND branch_id = $2',
            'DELETE FROM shifts WHERE employee_id = $1',
        ];
        for (const q of cleanup) {
            await pool.query(q, q.includes('employee_id') ? [EMP_ID] : [TENANT_ID, BRANCH_ID]).catch(() => {});
        }
        await pool.query('DELETE FROM suppliers WHERE tenant_id = $1 AND global_id = $2', [TENANT_ID, G.supplier]).catch(() => {});
        await pool.query('DELETE FROM customers WHERE tenant_id = $1 AND global_id = $2', [TENANT_ID, G.customer]).catch(() => {});
        await pool.query('DELETE FROM employees WHERE id = $1', [EMP_ID]).catch(() => {});
        await pool.query('DELETE FROM branches WHERE id = $1', [BRANCH_ID]).catch(() => {});
        await pool.end();
    }, 30000);

    // ════════════════════════════════════════════════════════════════
    // 1. EMPLOYEE — seed directly (employee sync varies by project)
    // ════════════════════════════════════════════════════════════════
    describe('1. Employee', () => {
        test('seed employee with GlobalId', async () => {
            await pool.query(`
                INSERT INTO employees (id, tenant_id, username, email, global_id, first_name, last_name)
                VALUES ($1, $2, 'test_sync_emp', 'test_sync@test.com', $3, 'Test', 'Sync')
                ON CONFLICT (id) DO UPDATE SET global_id = $3
            `, [EMP_ID, TENANT_ID, G.employee]);

            const { rows } = await pool.query('SELECT id, global_id FROM employees WHERE id = $1', [EMP_ID]);
            expect(rows.length).toBe(1);
            expect(rows[0].global_id).toBe(G.employee);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 2. SHIFT SYNC
    // ════════════════════════════════════════════════════════════════
    describe('2. Shift sync', () => {
        test('POST /api/shifts/sync creates shift resolving employee GlobalId', async () => {
            const res = await syncPost('/api/shifts/sync', {
                tenant_id: TENANT_ID,
                branch_id: BRANCH_ID,
                employee_global_id: G.employee,
                initial_amount: 500,
                is_cash_cut_open: true,
                start_time: new Date().toISOString(),
                global_id: G.shift,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const { rows } = await pool.query('SELECT * FROM shifts WHERE global_id = $1', [G.shift]);
            expect(rows.length).toBe(1);
            expect(rows[0].employee_id).toBe(EMP_ID);
            expect(rows[0].branch_id).toBe(BRANCH_ID);
            expect(rows[0].is_cash_cut_open).toBe(true);
        });

        test('idempotency — same GlobalId does NOT create duplicate', async () => {
            const res = await syncPost('/api/shifts/sync', {
                tenant_id: TENANT_ID,
                branch_id: BRANCH_ID,
                employee_global_id: G.employee,
                initial_amount: 500,
                is_cash_cut_open: true,
                start_time: new Date().toISOString(),
                global_id: G.shift,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect(res.status).toBe(200);
            const { rows } = await pool.query('SELECT count(*)::int as cnt FROM shifts WHERE global_id = $1', [G.shift]);
            expect(rows[0].cnt).toBe(1);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 3. CUSTOMER SYNC
    // ════════════════════════════════════════════════════════════════
    describe('3. Customer sync', () => {
        test('POST /api/customers/sync creates customer', async () => {
            const res = await syncPost('/api/customers/sync', {
                tenant_id: TENANT_ID,
                branch_id: BRANCH_ID,
                name: 'Cliente Test Sync',
                telefono: '5551234567',
                tiene_credito: true,
                credit_limit: 1000,
                porcentaje_descuento: 5,
                global_id: G.customer,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const { rows } = await pool.query('SELECT * FROM customers WHERE global_id = $1', [G.customer]);
            expect(rows.length).toBe(1);
            expect(rows[0].nombre).toBe('Cliente Test Sync');
            expect(parseFloat(rows[0].credito_limite)).toBe(1000);
        });

        test('idempotency — same GlobalId updates instead of duplicating', async () => {
            const res = await syncPost('/api/customers/sync', {
                tenant_id: TENANT_ID,
                branch_id: BRANCH_ID,
                name: 'Cliente Test UPDATED',
                telefono: '5559999999',
                tiene_credito: true,
                credit_limit: 2000,
                global_id: G.customer,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 2,
                created_local_utc: new Date().toISOString()
            });

            expect(res.status).toBe(200);
            const { rows } = await pool.query('SELECT count(*)::int as cnt, max(nombre) as nombre FROM customers WHERE global_id = $1', [G.customer]);
            expect(rows[0].cnt).toBe(1);
            expect(rows[0].nombre).toBe('Cliente Test UPDATED');
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 4. SUPPLIER SYNC
    // ════════════════════════════════════════════════════════════════
    describe('4. Supplier sync', () => {
        test('POST /api/suppliers/sync creates supplier', async () => {
            const res = await syncPost('/api/suppliers/sync', {
                tenantId: TENANT_ID,
                branchId: BRANCH_ID,
                global_id: G.supplier,
                name: 'Proveedor Test Sync',
                contact_name: 'Juan Proveedor',
                phone: '5550001111',
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const { rows } = await pool.query('SELECT * FROM suppliers WHERE global_id = $1', [G.supplier]);
            expect(rows.length).toBe(1);
            expect(rows[0].name).toBe('Proveedor Test Sync');
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 5. EXPENSE SYNC
    // ════════════════════════════════════════════════════════════════
    describe('5. Expense sync', () => {
        test('POST /api/expenses/sync creates expense', async () => {
            const res = await syncPost('/api/expenses/sync', {
                tenantId: TENANT_ID,
                branchId: BRANCH_ID,
                employee_global_id: G.employee,
                shift_global_id: G.shift,
                category: 'Gas LP',
                global_category_id: 2,
                description: 'Tanque de gas para producción',
                amount: 350.50,
                quantity: 1,
                payment_type_id: 1,
                expense_date_utc: new Date().toISOString(),
                global_id: G.expense,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString(),
                source: 'desktop'
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const { rows } = await pool.query('SELECT * FROM expenses WHERE global_id = $1', [G.expense]);
            expect(rows.length).toBe(1);
            expect(parseFloat(rows[0].amount)).toBeCloseTo(350.50, 2);
        });

        test('PUT /api/expenses/:globalId updates expense', async () => {
            const res = await syncPut(`/api/expenses/${G.expense}`, {
                tenant_id: TENANT_ID,
                category: 'Gas LP',
                description: 'Tanque de gas ACTUALIZADO',
                amount: 400,
                quantity: 1,
                payment_type_id: 1
            });

            expect(res.status).toBe(200);

            const { rows } = await pool.query('SELECT description, amount FROM expenses WHERE global_id = $1', [G.expense]);
            expect(rows[0].description).toBe('Tanque de gas ACTUALIZADO');
            expect(parseFloat(rows[0].amount)).toBeCloseTo(400, 2);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 6. VENTA SYNC — complex GlobalId resolution
    // ════════════════════════════════════════════════════════════════
    describe('6. Venta sync', () => {
        test('POST /api/sales/sync creates sale resolving employee, shift, customer GlobalIds', async () => {
            const res = await syncPost('/api/sales/sync', {
                tenant_id: TENANT_ID,
                branch_id: BRANCH_ID,
                empleado_global_id: G.employee,
                turno_global_id: G.shift,
                cliente_global_id: G.customer,
                estado_venta_id: 3,
                status: 'completed',
                venta_tipo_id: 1,
                tipo_pago_id: 1,
                subtotal: 250.00,
                total_descuentos: 12.50,
                total: 237.50,
                monto_pagado: 237.50,
                cash_amount: 237.50,
                card_amount: 0,
                credit_amount: 0,
                credito_original: 0,
                ticket_number: 99001,
                fecha_venta_raw: Date.now(),
                global_id: G.sale,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString(),
                device_event_raw: Date.now(),
                detalles: [{
                    id_producto: 1,
                    descripcion_producto: 'Tortilla de Maíz 1kg',
                    cantidad: 5,
                    precio_lista: 50,
                    precio_unitario: 47.50,
                    total_linea: 237.50,
                    global_id: G.saleDetail
                }]
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.id_venta).toBeDefined();

            // Verify FK resolution
            const { rows } = await pool.query(`
                SELECT v.*, e.global_id as emp_gid, c.global_id as cust_gid, s.global_id as shift_gid
                FROM ventas v
                JOIN employees e ON v.id_empleado = e.id
                LEFT JOIN customers c ON v.id_cliente = c.id
                JOIN shifts s ON v.id_turno = s.id
                WHERE v.global_id = $1
            `, [G.sale]);

            expect(rows.length).toBe(1);
            expect(rows[0].emp_gid).toBe(G.employee);
            expect(rows[0].cust_gid).toBe(G.customer);
            expect(rows[0].shift_gid).toBe(G.shift);
            expect(parseFloat(rows[0].total)).toBeCloseTo(237.50, 2);
        });

        test('idempotency — same sale GlobalId does not duplicate', async () => {
            const res = await syncPost('/api/sales/sync', {
                tenant_id: TENANT_ID,
                branch_id: BRANCH_ID,
                empleado_global_id: G.employee,
                turno_global_id: G.shift,
                estado_venta_id: 3,
                status: 'completed',
                venta_tipo_id: 1,
                tipo_pago_id: 1,
                subtotal: 250.00,
                total: 237.50,
                monto_pagado: 237.50,
                cash_amount: 237.50,
                ticket_number: 99001,
                fecha_venta_raw: Date.now(),
                global_id: G.sale,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString(),
                detalles: []
            });

            expect(res.status).toBe(200);
            const { rows } = await pool.query('SELECT count(*)::int as cnt FROM ventas WHERE global_id = $1', [G.sale]);
            expect(rows[0].cnt).toBe(1);
        });

        test('sale with non-existent employee GlobalId fails', async () => {
            const res = await syncPost('/api/sales/sync', {
                tenant_id: TENANT_ID,
                branch_id: BRANCH_ID,
                empleado_global_id: crypto.randomUUID(),
                turno_global_id: G.shift,
                estado_venta_id: 3,
                status: 'completed',
                total: 100,
                ticket_number: 99999,
                fecha_venta_raw: Date.now(),
                global_id: crypto.randomUUID(),
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString(),
                detalles: []
            });

            expect(res.body.success).toBe(false);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 7. PURCHASE SYNC
    // ════════════════════════════════════════════════════════════════
    describe('7. Purchase sync', () => {
        test('POST /api/purchases/sync creates purchase with supplier GlobalId', async () => {
            const res = await syncPost('/api/purchases/sync', {
                tenantId: TENANT_ID,
                branchId: BRANCH_ID,
                proveedor_global_id: G.supplier,
                employee_global_id: G.employee,
                shift_global_id: G.shift,
                total: 1500.00,
                amount_paid: 1500.00,
                status_id: 2,
                payment_method: 'cash',
                notes: 'Compra de prueba sync',
                global_id: G.purchase,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString(),
                details: [{
                    product_name: 'Maíz 50kg',
                    quantity: 10,
                    unit_price: 150,
                    total: 1500,
                    global_id: G.purchaseDetail
                }]
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const { rows } = await pool.query('SELECT * FROM purchases WHERE global_id = $1', [G.purchase]);
            expect(rows.length).toBe(1);
            expect(parseFloat(rows[0].total_amount)).toBeCloseTo(1500, 2);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 8. DEPOSIT SYNC
    // ════════════════════════════════════════════════════════════════
    describe('8. Deposit sync', () => {
        test('POST /api/deposits/sync creates deposit', async () => {
            const res = await syncPost('/api/deposits/sync', {
                tenantId: TENANT_ID,
                branchId: BRANCH_ID,
                shift_global_id: G.shift,
                employee_global_id: G.employee,
                amount: 200,
                description: 'Depósito de prueba',
                authorized_by: 'Admin',
                deposit_date_utc: new Date().toISOString(),
                global_id: G.deposit,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const { rows } = await pool.query('SELECT * FROM deposits WHERE global_id = $1', [G.deposit]);
            expect(rows.length).toBe(1);
            expect(parseFloat(rows[0].amount)).toBeCloseTo(200, 2);
        });

        test('idempotency — same deposit GlobalId does not duplicate', async () => {
            await syncPost('/api/deposits/sync', {
                tenantId: TENANT_ID, branchId: BRANCH_ID,
                shift_global_id: G.shift, employee_global_id: G.employee,
                amount: 200, global_id: G.deposit,
                terminal_id: crypto.randomUUID(), local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            const { rows } = await pool.query('SELECT count(*)::int as cnt FROM deposits WHERE global_id = $1', [G.deposit]);
            expect(rows[0].cnt).toBe(1);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 9. WITHDRAWAL SYNC
    // ════════════════════════════════════════════════════════════════
    describe('9. Withdrawal sync', () => {
        test('POST /api/withdrawals/sync creates withdrawal', async () => {
            const res = await syncPost('/api/withdrawals/sync', {
                tenantId: TENANT_ID,
                branchId: BRANCH_ID,
                shift_global_id: G.shift,
                employee_global_id: G.employee,
                amount: 100,
                description: 'Retiro para cambio',
                authorized_by: 'Admin',
                withdrawal_date_utc: new Date().toISOString(),
                global_id: G.withdrawal,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const { rows } = await pool.query('SELECT * FROM withdrawals WHERE global_id = $1', [G.withdrawal]);
            expect(rows.length).toBe(1);
            expect(parseFloat(rows[0].amount)).toBeCloseTo(100, 2);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 10. CREDIT PAYMENT SYNC
    // ════════════════════════════════════════════════════════════════
    describe('10. Credit payment sync', () => {
        test('POST /api/credit-payments/sync creates payment resolving customer GlobalId', async () => {
            const res = await syncPost('/api/credit-payments/sync', {
                tenantId: TENANT_ID,
                branchId: BRANCH_ID,
                customer_global_id: G.customer,
                shift_global_id: G.shift,
                employee_global_id: G.employee,
                amount: 150.00,
                paymentMethod: 'cash',
                notes: 'Abono de prueba',
                global_id: G.creditPayment,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const { rows } = await pool.query(`
                SELECT cp.*, c.global_id as cust_gid
                FROM credit_payments cp
                JOIN customers c ON cp.customer_id = c.id
                WHERE cp.global_id = $1
            `, [G.creditPayment]);
            expect(rows.length).toBe(1);
            expect(rows[0].cust_gid).toBe(G.customer);
            expect(parseFloat(rows[0].amount)).toBeCloseTo(150, 2);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 11. CASH CUT SYNC
    // ════════════════════════════════════════════════════════════════
    describe('11. Cash cut sync', () => {
        test('POST /api/cash-cuts/sync creates cash cut', async () => {
            const res = await syncPost('/api/cash-cuts/sync', {
                tenantId: TENANT_ID,
                branchId: BRANCH_ID,
                shift_global_id: G.shift,
                countedCash: 1500.00,
                difference: -37.50,
                notes: 'Corte de prueba',
                total_liquidaciones_efectivo: 0,
                total_liquidaciones_tarjeta: 0,
                total_liquidaciones_credito: 0,
                total_repartidor_expenses: 0,
                has_consolidated_liquidaciones: false,
                global_id: G.cashCut,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect(res.status).toBe(200);
            // Cash cuts endpoint wraps in results[] array
            const result = res.body.results ? res.body.results[0] : res.body;
            expect(result.success).toBe(true);

            const { rows } = await pool.query('SELECT * FROM cash_cuts WHERE global_id = $1', [G.cashCut]);
            expect(rows.length).toBe(1);
            expect(parseFloat(rows[0].counted_cash)).toBeCloseTo(1500, 2);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 12. CANCELACION SYNC
    // ════════════════════════════════════════════════════════════════
    describe('12. Cancelacion sync', () => {
        test('POST /api/cancelaciones/sync creates cancellation log', async () => {
            const res = await syncPost('/api/cancelaciones/sync', {
                tenant_id: TENANT_ID,
                branch_id: BRANCH_ID,
                shift_global_id: G.shift,
                employee_global_id: G.employee,
                venta_global_id: G.sale,
                razon_id: 1,
                otra_razon: null,
                monto_total: 237.50,
                fecha: new Date().toISOString(),
                global_id: G.cancelacion,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            const { rows } = await pool.query('SELECT * FROM cancelaciones_bitacora WHERE global_id = $1', [G.cancelacion]);
            expect(rows.length).toBe(1);
        });

        test('idempotency — same cancelacion GlobalId uses DO NOTHING', async () => {
            await syncPost('/api/cancelaciones/sync', {
                tenant_id: TENANT_ID, branch_id: BRANCH_ID,
                shift_global_id: G.shift, employee_global_id: G.employee,
                venta_global_id: G.sale, razon_id: 1,
                monto_total: 237.50, fecha: new Date().toISOString(),
                global_id: G.cancelacion,
                terminal_id: crypto.randomUUID(), local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            const { rows } = await pool.query('SELECT count(*)::int as cnt FROM cancelaciones_bitacora WHERE global_id = $1', [G.cancelacion]);
            expect(rows[0].cnt).toBe(1);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 13. REPARTIDOR CHAIN — Assignment → Return
    // ════════════════════════════════════════════════════════════════
    describe('13. Repartidor chain', () => {
        test('13a. POST /api/repartidor-assignments/sync creates assignment', async () => {
            // FCM notifications may add latency
            const res = await syncPost('/api/repartidor-assignments/sync', {
                tenant_id: TENANT_ID,
                branch_id: BRANCH_ID,
                employee_global_id: G.employee,
                created_by_employee_global_id: G.employee,
                shift_global_id: G.shift,
                venta_global_id: G.sale,
                assigned_quantity: 5,
                assigned_amount: 237.50,
                product_name: 'Tortilla de Maíz 1kg',
                global_id: G.assignment,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect([200, 201]).toContain(res.status);
            expect(res.body.success).toBe(true);
        }, 15000);

        test('13b. POST /api/repartidor-returns/sync creates return', async () => {
            const res = await syncPost('/api/repartidor-returns/sync', {
                tenant_id: TENANT_ID,
                branch_id: BRANCH_ID,
                assignment_global_id: G.assignment,
                employee_global_id: G.employee,
                registered_by_employee_global_id: G.employee,
                shift_global_id: G.shift,
                quantity: 2,
                unit_price: 47.50,
                amount: 95.00,
                source: 'desktop',
                notes: 'Devolvió 2kg',
                global_id: G.returnItem,
                terminal_id: crypto.randomUUID(),
                local_op_seq: 1,
                created_local_utc: new Date().toISOString()
            });

            expect([200, 201]).toContain(res.status);
            expect(res.body.success).toBe(true);

            const { rows } = await pool.query(`
                SELECT rr.*, ra.global_id as assignment_gid
                FROM repartidor_returns rr
                JOIN repartidor_assignments ra ON rr.assignment_id = ra.id
                WHERE rr.global_id = $1
            `, [G.returnItem]);
            expect(rows.length).toBe(1);
            expect(rows[0].assignment_gid).toBe(G.assignment);
            expect(parseFloat(rows[0].amount)).toBeCloseTo(95, 2);
        });
    });

    // ════════════════════════════════════════════════════════════════
    // 14. CROSS-ENTITY GlobalId INTEGRITY
    // ════════════════════════════════════════════════════════════════
    describe('14. GlobalId integrity', () => {
        test('all synced entities have unique GlobalIds in DB', async () => {
            const checks = [
                { table: 'employees', gid: G.employee },
                { table: 'shifts', gid: G.shift },
                { table: 'customers', gid: G.customer },
                { table: 'suppliers', gid: G.supplier },
                { table: 'ventas', gid: G.sale },
                { table: 'expenses', gid: G.expense },
                { table: 'deposits', gid: G.deposit },
                { table: 'withdrawals', gid: G.withdrawal },
            ];

            for (const { table, gid } of checks) {
                const { rows } = await pool.query(`SELECT count(*)::int as cnt FROM ${table} WHERE global_id = $1`, [gid]);
                expect(rows[0].cnt).toBe(1);
            }
        });
    });
});
