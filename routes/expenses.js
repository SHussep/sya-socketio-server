// ═══════════════════════════════════════════════════════════════
// EXPENSES ROUTES - Extracted from server.js
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

    // GET /api/expenses - Lista de gastos (con soporte de timezone)
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false', branch_id, timezone, startDate, endDate } = req.query;

            // Prioridad: 1. branch_id del query, 2. branchId del JWT
            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            // Usar timezone si viene en query, sino usar UTC por defecto
            const userTimezone = timezone || 'UTC';

            let query = `
                SELECT e.id, e.description as concept, e.description, e.amount, e.expense_date,
                       emp.full_name as employee_name, b.name as branch_name, b.id as "branchId",
                       cat.name as category,
                       (e.expense_date AT TIME ZONE '${userTimezone}') as expense_date_display
                FROM expenses e
                LEFT JOIN employees emp ON e.employee_id = emp.id
                LEFT JOIN branches b ON e.branch_id = b.id
                LEFT JOIN expense_categories cat ON e.category_id = cat.id
                WHERE e.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

            // Filtrar por branch_id solo si no se solicita ver todas las sucursales
            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND e.branch_id = $${paramIndex}`;
                params.push(targetBranchId);
                paramIndex++;
            }

            // Filtrar por rango de fechas si se proporciona (en timezone del usuario)
            if (startDate || endDate) {
                if (startDate) {
                    query += ` AND (e.expense_date AT TIME ZONE '${userTimezone}')::date >= $${paramIndex}::date`;
                    params.push(startDate);
                    paramIndex++;
                }
                if (endDate) {
                    query += ` AND (e.expense_date AT TIME ZONE '${userTimezone}')::date <= $${paramIndex}::date`;
                    params.push(endDate);
                    paramIndex++;
                }
            }

            query += ` ORDER BY e.expense_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            console.log(`[Expenses] Fetching expenses - Tenant: ${tenantId}, Branch: ${targetBranchId}, Timezone: ${userTimezone}, all_branches: ${all_branches}`);
            console.log(`[Expenses] Query: ${query}`);
            console.log(`[Expenses] Params: ${JSON.stringify(params)}`);

            const result = await pool.query(query, params);

            console.log(`[Expenses] ✅ Gastos encontrados: ${result.rows.length}`);

            // Normalizar amount a número y formatear timestamps en UTC
            const normalizedRows = result.rows.map(row => ({
                ...row,
                amount: parseFloat(row.amount),
                // Ensure expense_date is always sent as ISO string in UTC (Z suffix)
                expense_date: row.expense_date ? new Date(row.expense_date).toISOString() : null,
                // Convert expense_date_display to ISO string as well
                expense_date_display: row.expense_date_display ? new Date(row.expense_date_display).toISOString() : null
            }));

            res.json({
                success: true,
                data: normalizedRows
            });
        } catch (error) {
            console.error('[Expenses] ❌ Error:', error.message);
            console.error('[Expenses] SQL Error Code:', error.code);
            console.error('[Expenses] Full error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener gastos', error: error.message });
        }
    });

    // POST /api/expenses - Crear gasto desde Desktop (sin JWT)
    router.post('/', async (req, res) => {
        try {
            const { tenantId, branchId, category, description, amount, userEmail } = req.body;

            if (!tenantId || !branchId || !category || !amount) {
                return res.status(400).json({ success: false, message: 'Datos incompletos' });
            }

            // Buscar empleado por email
            let employeeId = null;
            if (userEmail) {
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                    [userEmail, tenantId]
                );
                if (empResult.rows.length > 0) {
                    employeeId = empResult.rows[0].id;
                }
            }

            // Buscar o crear categoría
            let categoryId = null;
            const catResult = await pool.query(
                'SELECT id FROM expense_categories WHERE LOWER(name) = LOWER($1) AND tenant_id = $2',
                [category, tenantId]
            );

            if (catResult.rows.length > 0) {
                categoryId = catResult.rows[0].id;
            } else {
                const newCat = await pool.query(
                    'INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) RETURNING id',
                    [tenantId, category]
                );
                categoryId = newCat.rows[0].id;
                console.log(`[Expenses] Categoría creada: ${category} (ID: ${categoryId})`);
            }

            const result = await pool.query(
                `INSERT INTO expenses (tenant_id, branch_id, employee_id, category_id, description, amount)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [tenantId, branchId, employeeId, categoryId, description, amount]
            );

            console.log(`[Expenses] ✅ Gasto creado desde Desktop: ${category} - $${amount}`);
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('[Expenses] Error:', error);
            res.status(500).json({ success: false, message: 'Error al crear gasto' });
        }
    });

    // POST /api/sync/expenses - Alias de /api/expenses (para compatibilidad con Desktop)
    // Ahora también acepta localShiftId para offline-first reconciliation
    router.post('/sync', async (req, res) => {
        try {
            const {
                tenantId, branchId, employeeId, category, description, amount, userEmail,
                payment_type_id, expense_date_utc,  // ✅ NUEVO: payment_type_id es REQUERIDO, expense_date_utc ya en UTC
                // ✅ OFFLINE-FIRST FIELDS
                global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
            } = req.body;

            console.log(`[Sync/Expenses] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, Category: ${category}, PaymentType: ${payment_type_id}, ExpenseDateUTC: ${expense_date_utc}`);
            console.log(`[Sync/Expenses] Received amount: ${amount} (type: ${typeof amount})`);
            console.log(`[Sync/Expenses] 🔐 Offline-First - GlobalId: ${global_id}, TerminalId: ${terminal_id}, LocalOpSeq: ${local_op_seq}`);

            if (!tenantId || !branchId || !category || amount === null || amount === undefined || !global_id || !payment_type_id) {
                return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, category, amount, payment_type_id, global_id requeridos)' });
            }

            // Convertir amount a número si viene como string
            const numericAmount = parseFloat(amount);
            if (isNaN(numericAmount)) {
                return res.status(400).json({ success: false, message: 'amount debe ser un número válido' });
            }

            // Usar employeeId del body si viene, sino buscar por email
            let finalEmployeeId = employeeId;
            if (!finalEmployeeId && userEmail) {
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                    [userEmail, tenantId]
                );
                if (empResult.rows.length > 0) {
                    finalEmployeeId = empResult.rows[0].id;
                }
            }

            // Buscar o crear categoría
            let categoryId = null;
            const catResult = await pool.query(
                'SELECT id FROM expense_categories WHERE LOWER(name) = LOWER($1) AND tenant_id = $2',
                [category, tenantId]
            );

            if (catResult.rows.length > 0) {
                categoryId = catResult.rows[0].id;
            } else {
                const newCat = await pool.query(
                    'INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) RETURNING id',
                    [tenantId, category]
                );
                categoryId = newCat.rows[0].id;
                console.log(`[Sync/Expenses] Categoría creada: ${category} (ID: ${categoryId})`);
            }

            // ✅ Use client-provided UTC timestamp (already converted to UTC by Desktop)
            // Desktop sends expense_date_utc in ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)
            const expenseDate = expense_date_utc || new Date().toISOString();
            console.log(`[Sync/Expenses] 📅 Using expense timestamp: ${expenseDate}`);

            // ✅ IDEMPOTENTE: INSERT con ON CONFLICT (global_id) DO UPDATE
            const result = await pool.query(
                `INSERT INTO expenses (
                    tenant_id, branch_id, employee_id, payment_type_id, category_id, description, amount, expense_date,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw,
                    synced, synced_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::uuid, $11, $12, $13, true, NOW())
                 ON CONFLICT (global_id) DO UPDATE
                 SET amount = EXCLUDED.amount,
                     description = EXCLUDED.description,
                     expense_date = EXCLUDED.expense_date,
                     payment_type_id = EXCLUDED.payment_type_id,
                     synced_at = NOW()
                 RETURNING *`,
                [
                    tenantId,
                    branchId,
                    finalEmployeeId,
                    payment_type_id,              // ✅ NUEVO (posición $4)
                    categoryId,                   // ahora $5
                    description || '',            // ahora $6
                    numericAmount,                // ahora $7
                    expenseDate,                  // ahora $8
                    global_id,                    // ahora $9 - UUID from Desktop
                    terminal_id,                  // ahora $10 - UUID from Desktop
                    local_op_seq,                 // ahora $11 - Sequence number from Desktop
                    created_local_utc,            // ahora $12 - ISO 8601 timestamp from Desktop
                    device_event_raw              // ahora $13 - Raw .NET ticks from Desktop
                ]
            );

            console.log(`[Sync/Expenses] ✅ Gasto sincronizado: ${category} - $${numericAmount} | PaymentType: ${payment_type_id}`);

            // Asegurar que amount es un número en la respuesta
            const responseData = result.rows[0];
            if (responseData) {
                responseData.amount = parseFloat(responseData.amount);
            }

            res.json({ success: true, data: responseData });
        } catch (error) {
            console.error('[Sync/Expenses] Error:', error);
            res.status(500).json({ success: false, message: 'Error al sincronizar gasto', error: error.message });
        }
    });

    return router;
};
