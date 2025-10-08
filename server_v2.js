// ═══════════════════════════════════════════════════════════════
// SERVIDOR MULTI-TENANT - SYA TORTILLERÍAS v2.0
// PostgreSQL + Express + Socket.IO
// Arquitectura: Offline-First con Sync Inteligente
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const { pool, initializeDatabase } = require('./database');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Validación de seguridad
if (!JWT_SECRET) {
    console.error('❌ FATAL: JWT_SECRET no configurado');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// CONFIGURAR EXPRESS
// ═══════════════════════════════════════════════════════════════

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ═══════════════════════════════════════════════════════════════
// IMPORTAR RUTAS
// ═══════════════════════════════════════════════════════════════

const tenantsRouter = require('./routes/tenants')(pool);
const authRouter = require('./routes/auth')(pool);
const branchesRouter = require('./routes/branches')(pool, authRouter.authenticateToken);

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.send('SYA Tortillerías Multi-Tenant API v2.0 ✅');
});

app.get('/health', async (req, res) => {
    try {
        const tenants = await pool.query('SELECT COUNT(*) FROM tenants');
        const branches = await pool.query('SELECT COUNT(*) FROM branches');
        const employees = await pool.query('SELECT COUNT(*) FROM employees');

        res.json({
            status: 'ok',
            version: '2.0.0',
            timestamp: new Date().toISOString(),
            database: 'connected',
            stats: {
                tenants: parseInt(tenants.rows[0].count),
                branches: parseInt(branches.rows[0].count),
                employees: parseInt(employees.rows[0].count)
            }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// MONTAR RUTAS
// ═══════════════════════════════════════════════════════════════

app.use('/api/tenants', tenantsRouter);
app.use('/api/auth', authRouter);
app.use('/api/branches', branchesRouter);

// ═══════════════════════════════════════════════════════════════
// SYNC ENDPOINTS (Desktop → Backend)
// ═══════════════════════════════════════════════════════════════

// POST /api/sync/sales - Sync individual de venta
app.post('/api/sync/sales', async (req, res) => {
    const {
        tenantId,
        branchId,
        employeeId,
        customerId,
        ticketNumber,
        totalAmount,
        paymentMethod,
        saleType,
        deliveryPersonId,
        saleDate,
        items // Array de { productId, quantity, unitPrice, subtotal }
    } = req.body;

    if (!tenantId || !branchId || !ticketNumber || !totalAmount) {
        return res.status(400).json({
            success: false,
            message: 'Datos incompletos: tenantId, branchId, ticketNumber, totalAmount requeridos'
        });
    }

    try {
        await pool.query('BEGIN');

        // Insertar venta
        const saleResult = await pool.query(`
            INSERT INTO sales (
                tenant_id, branch_id, employee_id, customer_id,
                ticket_number, total_amount, payment_method,
                sale_type, delivery_person_id, sale_date
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
        `, [
            tenantId,
            branchId,
            employeeId || null,
            customerId || null,
            ticketNumber,
            totalAmount,
            paymentMethod || 'Efectivo',
            saleType || 'counter',
            deliveryPersonId || null,
            saleDate || new Date()
        ]);

        const saleId = saleResult.rows[0].id;

        // Insertar items si existen
        if (items && items.length > 0) {
            for (const item of items) {
                await pool.query(`
                    INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal)
                    VALUES ($1, $2, $3, $4, $5)
                `, [saleId, item.productId, item.quantity, item.unitPrice, item.subtotal]);
            }
        }

        // Actualizar sync_status
        await pool.query(`
            INSERT INTO sync_status (tenant_id, branch_id, sync_type, last_sync_at, records_synced, status)
            VALUES ($1, $2, 'sales', CURRENT_TIMESTAMP, 1, 'success')
            ON CONFLICT (tenant_id, branch_id, sync_type)
            DO UPDATE SET
                last_sync_at = CURRENT_TIMESTAMP,
                records_synced = sync_status.records_synced + 1,
                status = 'success',
                error_message = NULL
        `, [tenantId, branchId]);

        await pool.query('COMMIT');

        console.log(`[Sync Sales] ✅ Venta sincronizada: ${ticketNumber} - $${totalAmount} (Branch: ${branchId})`);

        res.json({
            success: true,
            message: 'Venta sincronizada',
            data: { saleId }
        });

    } catch (error) {
        await pool.query('ROLLBACK');

        // Si es duplicate key, no es error crítico
        if (error.code === '23505') {
            console.log(`[Sync Sales] ⚠️ Venta duplicada (ya existe): ${ticketNumber}`);
            return res.json({
                success: true,
                message: 'Venta ya sincronizada previamente',
                duplicate: true
            });
        }

        console.error('[Sync Sales] Error:', error);

        // Registrar error en sync_status
        try {
            await pool.query(`
                INSERT INTO sync_status (tenant_id, branch_id, sync_type, last_sync_at, records_synced, status, error_message)
                VALUES ($1, $2, 'sales', CURRENT_TIMESTAMP, 0, 'error', $3)
                ON CONFLICT (tenant_id, branch_id, sync_type)
                DO UPDATE SET
                    last_sync_at = CURRENT_TIMESTAMP,
                    status = 'error',
                    error_message = $3
            `, [tenantId, branchId, error.message]);
        } catch (e) {
            console.error('[Sync Status] Error al registrar error:', e);
        }

        res.status(500).json({
            success: false,
            message: 'Error al sincronizar venta',
            error: error.message
        });
    }
});

// POST /api/sync/expenses - Sync individual de gasto
app.post('/api/sync/expenses', async (req, res) => {
    const {
        tenantId,
        branchId,
        employeeId,
        categoryId,
        description,
        amount,
        expenseDate
    } = req.body;

    if (!tenantId || !branchId || !description || !amount) {
        return res.status(400).json({
            success: false,
            message: 'Datos incompletos'
        });
    }

    try {
        const result = await pool.query(`
            INSERT INTO expenses (
                tenant_id, branch_id, employee_id, category_id,
                description, amount, expense_date
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        `, [
            tenantId,
            branchId,
            employeeId || null,
            categoryId || null,
            description,
            amount,
            expenseDate || new Date()
        ]);

        // Actualizar sync_status
        await pool.query(`
            INSERT INTO sync_status (tenant_id, branch_id, sync_type, last_sync_at, records_synced, status)
            VALUES ($1, $2, 'expenses', CURRENT_TIMESTAMP, 1, 'success')
            ON CONFLICT (tenant_id, branch_id, sync_type)
            DO UPDATE SET
                last_sync_at = CURRENT_TIMESTAMP,
                records_synced = sync_status.records_synced + 1,
                status = 'success'
        `, [tenantId, branchId]);

        console.log(`[Sync Expenses] ✅ Gasto sincronizado: ${description} - $${amount}`);

        res.json({
            success: true,
            message: 'Gasto sincronizado',
            data: { expenseId: result.rows[0].id }
        });

    } catch (error) {
        console.error('[Sync Expenses] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al sincronizar gasto',
            error: error.message
        });
    }
});

// POST /api/sync/cash-cuts - Sync de corte de caja
app.post('/api/sync/cash-cuts', async (req, res) => {
    const {
        tenantId,
        branchId,
        employeeId,
        cutNumber,
        totalSales,
        totalExpenses,
        cashInDrawer,
        expectedCash,
        difference,
        cutDate
    } = req.body;

    if (!tenantId || !branchId || !employeeId || !cutNumber) {
        return res.status(400).json({
            success: false,
            message: 'Datos incompletos'
        });
    }

    try {
        const result = await pool.query(`
            INSERT INTO cash_cuts (
                tenant_id, branch_id, employee_id, cut_number,
                total_sales, total_expenses, cash_in_drawer,
                expected_cash, difference, cut_date
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
        `, [
            tenantId,
            branchId,
            employeeId,
            cutNumber,
            totalSales,
            totalExpenses,
            cashInDrawer,
            expectedCash,
            difference,
            cutDate || new Date()
        ]);

        await pool.query(`
            INSERT INTO sync_status (tenant_id, branch_id, sync_type, last_sync_at, records_synced, status)
            VALUES ($1, $2, 'cash_cuts', CURRENT_TIMESTAMP, 1, 'success')
            ON CONFLICT (tenant_id, branch_id, sync_type)
            DO UPDATE SET
                last_sync_at = CURRENT_TIMESTAMP,
                records_synced = sync_status.records_synced + 1,
                status = 'success'
        `, [tenantId, branchId]);

        console.log(`[Sync Cash Cuts] ✅ Corte sincronizado: ${cutNumber}`);

        res.json({
            success: true,
            message: 'Corte sincronizado',
            data: { cashCutId: result.rows[0].id }
        });

    } catch (error) {
        if (error.code === '23505') {
            return res.json({
                success: true,
                message: 'Corte ya sincronizado',
                duplicate: true
            });
        }

        console.error('[Sync Cash Cuts] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al sincronizar corte',
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// DASHBOARD ENDPOINTS (Móvil ← Backend)
// ═══════════════════════════════════════════════════════════════

// Helper: Validar límite de días según plan
async function getQueryDaysLimit(tenantId) {
    const result = await pool.query(`
        SELECT s.query_days_limit
        FROM tenants t
        JOIN subscriptions s ON t.subscription_id = s.id
        WHERE t.id = $1
    `, [tenantId]);

    return result.rows[0]?.query_days_limit || 30;
}

// GET /api/dashboard/consolidated - Dashboard consolidado
app.get('/api/dashboard/consolidated', authRouter.authenticateToken, async (req, res) => {
    const { tenantId } = req.user;
    const { startDate, endDate } = req.query;

    try {
        // Obtener límite de días según plan
        const daysLimit = await getQueryDaysLimit(tenantId);

        // Calcular rango de fechas
        let queryStartDate, queryEndDate;

        if (startDate && endDate) {
            queryStartDate = new Date(startDate);
            queryEndDate = new Date(endDate);

            // Validar límite si no es ilimitado
            if (daysLimit !== -1) {
                const daysDiff = Math.ceil((queryEndDate - queryStartDate) / (1000 * 60 * 60 * 24));
                if (daysDiff > daysLimit) {
                    return res.status(403).json({
                        success: false,
                        message: `Tu plan permite consultar hasta ${daysLimit} días. Actualiza tu plan para más historial.`,
                        daysLimit
                    });
                }
            }
        } else {
            // Por defecto: hoy
            queryEndDate = new Date();
            queryStartDate = new Date();
            queryStartDate.setHours(0, 0, 0, 0);
            queryEndDate.setHours(23, 59, 59, 999);
        }

        // Ventas por sucursal
        const salesByBranch = await pool.query(`
            SELECT
                b.id as branch_id,
                b.name as branch_name,
                COUNT(s.id) as ticket_count,
                COALESCE(SUM(s.total_amount), 0) as total_sales
            FROM branches b
            LEFT JOIN sales s ON b.id = s.branch_id
                AND s.sale_date >= $2
                AND s.sale_date <= $3
            WHERE b.tenant_id = $1 AND b.is_active = true
            GROUP BY b.id, b.name
            ORDER BY b.name
        `, [tenantId, queryStartDate, queryEndDate]);

        // Gastos por sucursal
        const expensesByBranch = await pool.query(`
            SELECT
                b.id as branch_id,
                COALESCE(SUM(e.amount), 0) as total_expenses
            FROM branches b
            LEFT JOIN expenses e ON b.id = e.branch_id
                AND e.expense_date >= $2
                AND e.expense_date <= $3
            WHERE b.tenant_id = $1
            GROUP BY b.id
        `, [tenantId, queryStartDate, queryEndDate]);

        // Última sincronización
        const lastSync = await pool.query(`
            SELECT
                branch_id,
                sync_type,
                last_sync_at,
                status,
                records_synced
            FROM sync_status
            WHERE tenant_id = $1
            ORDER BY last_sync_at DESC
        `, [tenantId]);

        // Consolidar
        const branches = salesByBranch.rows.map(branch => {
            const expenses = expensesByBranch.rows.find(e => e.branch_id === branch.branch_id);
            const branchSyncs = lastSync.rows.filter(s => s.branch_id === branch.branch_id);
            const latestSync = branchSyncs[0];

            return {
                branchId: branch.branch_id,
                branchName: branch.branch_name,
                sales: {
                    total: parseFloat(branch.total_sales),
                    tickets: parseInt(branch.ticket_count)
                },
                expenses: {
                    total: parseFloat(expenses?.total_expenses || 0)
                },
                netIncome: parseFloat(branch.total_sales) - parseFloat(expenses?.total_expenses || 0),
                sync: {
                    lastSyncAt: latestSync?.last_sync_at,
                    status: latestSync?.status,
                    minutesAgo: latestSync ? Math.floor((Date.now() - new Date(latestSync.last_sync_at)) / 60000) : null,
                    totalRecords: branchSyncs.reduce((sum, s) => sum + (s.records_synced || 0), 0)
                }
            };
        });

        // Totales
        const totals = {
            sales: branches.reduce((sum, b) => sum + b.sales.total, 0),
            tickets: branches.reduce((sum, b) => sum + b.sales.tickets, 0),
            expenses: branches.reduce((sum, b) => sum + b.expenses.total, 0),
            netIncome: 0
        };
        totals.netIncome = totals.sales - totals.expenses;

        res.json({
            success: true,
            dateRange: {
                start: queryStartDate.toISOString(),
                end: queryEndDate.toISOString()
            },
            daysLimit,
            totals,
            branches,
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        console.error('[Dashboard Consolidated] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener dashboard',
            error: error.message
        });
    }
});

// GET /api/dashboard/branch/:branchId - Dashboard de sucursal específica
app.get('/api/dashboard/branch/:branchId', authRouter.authenticateToken, async (req, res) => {
    const { tenantId } = req.user;
    const { branchId } = req.params;
    const { startDate, endDate } = req.query;

    try {
        // Verificar acceso a la sucursal
        const branchCheck = await pool.query(
            'SELECT id, name FROM branches WHERE id = $1 AND tenant_id = $2',
            [branchId, tenantId]
        );

        if (branchCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Sucursal no encontrada'
            });
        }

        const branch = branchCheck.rows[0];

        // Límite de días
        const daysLimit = await getQueryDaysLimit(tenantId);

        // Rango de fechas
        let queryStartDate = startDate ? new Date(startDate) : new Date();
        let queryEndDate = endDate ? new Date(endDate) : new Date();

        if (!startDate) queryStartDate.setHours(0, 0, 0, 0);
        if (!endDate) queryEndDate.setHours(23, 59, 59, 999);

        // Validar límite
        if (daysLimit !== -1) {
            const daysDiff = Math.ceil((queryEndDate - queryStartDate) / (1000 * 60 * 60 * 24));
            if (daysDiff > daysLimit) {
                return res.status(403).json({
                    success: false,
                    message: `Tu plan permite consultar hasta ${daysLimit} días`,
                    daysLimit
                });
            }
        }

        // Ventas
        const sales = await pool.query(`
            SELECT
                COUNT(*) as ticket_count,
                COALESCE(SUM(total_amount), 0) as total_sales,
                AVG(total_amount) as avg_ticket
            FROM sales
            WHERE branch_id = $1
                AND sale_date >= $2
                AND sale_date <= $3
        `, [branchId, queryStartDate, queryEndDate]);

        // Gastos
        const expenses = await pool.query(`
            SELECT
                COALESCE(SUM(amount), 0) as total_expenses,
                COUNT(*) as expense_count
            FROM expenses
            WHERE branch_id = $1
                AND expense_date >= $2
                AND expense_date <= $3
        `, [branchId, queryStartDate, queryEndDate]);

        // Sync status
        const syncStatus = await pool.query(`
            SELECT sync_type, last_sync_at, status, records_synced
            FROM sync_status
            WHERE branch_id = $1
            ORDER BY last_sync_at DESC
        `, [branchId]);

        const salesData = sales.rows[0];
        const expensesData = expenses.rows[0];

        res.json({
            success: true,
            branch: {
                id: branch.id,
                name: branch.name
            },
            dateRange: {
                start: queryStartDate.toISOString(),
                end: queryEndDate.toISOString()
            },
            daysLimit,
            summary: {
                sales: {
                    total: parseFloat(salesData.total_sales),
                    tickets: parseInt(salesData.ticket_count),
                    avgTicket: parseFloat(salesData.avg_ticket || 0)
                },
                expenses: {
                    total: parseFloat(expensesData.total_expenses),
                    count: parseInt(expensesData.expense_count)
                },
                netIncome: parseFloat(salesData.total_sales) - parseFloat(expensesData.total_expenses)
            },
            syncStatus: syncStatus.rows.map(s => ({
                type: s.sync_type,
                lastSyncAt: s.last_sync_at,
                status: s.status,
                recordsSynced: s.records_synced,
                minutesAgo: Math.floor((Date.now() - new Date(s.last_sync_at)) / 60000)
            })),
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        console.error('[Dashboard Branch] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener dashboard de sucursal',
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// INICIALIZAR SERVIDOR
// ═══════════════════════════════════════════════════════════════

async function startServer() {
    try {
        // Inicializar BD
        await initializeDatabase();

        // Iniciar servidor
        server.listen(PORT, () => {
            console.log('\n╔══════════════════════════════════════════════════════════╗');
            console.log('║   🚀 SYA Tortillerías Multi-Tenant API v2.0            ║');
            console.log('║   📊 PostgreSQL Database                                ║');
            console.log('╚══════════════════════════════════════════════════════════╝\n');
            console.log(`✅ Servidor corriendo en puerto ${PORT}`);
            console.log(`🌐 REST API: http://localhost:${PORT}/api`);
            console.log(`💾 Database: PostgreSQL`);
            console.log(`📅 Iniciado: ${new Date().toLocaleString('es-MX')}\n`);
            console.log('📋 Endpoints Multi-Tenant:');
            console.log('   POST /api/tenants/register');
            console.log('   POST /api/auth/desktop-login');
            console.log('   GET  /api/branches');
            console.log('   POST /api/sync/sales');
            console.log('   POST /api/sync/expenses');
            console.log('   POST /api/sync/cash-cuts');
            console.log('   GET  /api/dashboard/consolidated');
            console.log('   GET  /api/dashboard/branch/:id');
            console.log('   GET  /health\n');
        });
    } catch (error) {
        console.error('❌ Error al iniciar servidor:', error);
        process.exit(1);
    }
}

startServer();
