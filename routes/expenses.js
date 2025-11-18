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
            const { limit = 50, offset = 0, all_branches = 'false', branch_id, timezone, startDate, endDate, shift_id, employee_id } = req.query;

            // Prioridad: 1. branch_id del query, 2. branchId del JWT
            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            // Usar timezone si viene en query, sino usar UTC por defecto
            const userTimezone = timezone || 'UTC';

            let query = `
                SELECT e.id, e.description as concept, e.description, e.amount, e.expense_date,
                       e.id_turno as shift_id,
                       CONCAT(emp.first_name, ' ', emp.last_name) as employee_name,
                       b.name as branch_name, b.id as "branchId",
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

            // ✅ Filtrar por turno (id_turno)
            if (shift_id) {
                query += ` AND e.id_turno = $${paramIndex}`;
                params.push(parseInt(shift_id));
                paramIndex++;
                console.log(`[Expenses] ✅ Filtrando por shift_id=${shift_id}`);
            }

            // ✅ Filtrar por employee_id (para que repartidores vean solo sus gastos)
            if (employee_id) {
                query += ` AND e.employee_id = $${paramIndex}`;
                params.push(parseInt(employee_id));
                paramIndex++;
                console.log(`[Expenses] ✅ Filtrando por employee_id=${employee_id}`);
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

            console.log(`[Expenses] Fetching expenses - Tenant: ${tenantId}, Branch: ${targetBranchId}, Shift: ${shift_id || 'ALL'}, Timezone: ${userTimezone}, all_branches: ${all_branches}`);
            console.log(`[Expenses] Query: ${query}`);
            console.log(`[Expenses] Params: ${JSON.stringify(params)}`);

            const result = await pool.query(query, params);

            console.log(`[Expenses] ✅ Gastos encontrados: ${result.rows.length}`);
            console.log(`[Expenses] 🔍 Shift IDs: ${result.rows.map(r => `ID ${r.id}:shift_${r.shift_id ?? 'NULL'}`).join(', ')}`);

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
                payment_type_id, expense_date_utc, id_turno,  // ✅ payment_type_id es REQUERIDO, expense_date_utc ya en UTC, id_turno turno al que pertenece
                // ✅ OFFLINE-FIRST FIELDS
                global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
            } = req.body;

            // ✅ LÓGICA CRÍTICA: Este endpoint es SOLO para Desktop
            // Todos los gastos que llegan aquí DEBEN marcarse como reviewed_by_desktop = true
            // porque se generaron en Desktop, no en app móvil
            const isFromDesktop = true;  // Este endpoint /sync es exclusivo de Desktop

            console.log(`[Sync/Expenses] 🖥️ DESKTOP sync - Tenant: ${tenantId}, Branch: ${branchId}, Category: ${category}, PaymentType: ${payment_type_id}, ShiftId: ${id_turno || 'N/A'}, ExpenseDateUTC: ${expense_date_utc}`);
            console.log(`[Sync/Expenses] Received amount: ${amount} (type: ${typeof amount})`);
            console.log(`[Sync/Expenses] 🔐 Offline-First - GlobalId: ${global_id}, TerminalId: ${terminal_id}, LocalOpSeq: ${local_op_seq}`);
            console.log(`[Sync/Expenses] 📋 Marcando como reviewed_by_desktop = TRUE (origen: Desktop)`);

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
                    tenant_id, branch_id, employee_id, payment_type_id, id_turno, category_id, description, amount, expense_date,
                    reviewed_by_desktop,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::uuid, $13, $14, $15)
                 ON CONFLICT (global_id) DO UPDATE
                 SET amount = EXCLUDED.amount,
                     description = EXCLUDED.description,
                     expense_date = EXCLUDED.expense_date,
                     payment_type_id = EXCLUDED.payment_type_id,
                     id_turno = EXCLUDED.id_turno,
                     reviewed_by_desktop = EXCLUDED.reviewed_by_desktop
                 RETURNING *`,
                [
                    tenantId,
                    branchId,
                    finalEmployeeId,
                    payment_type_id,              // $4
                    id_turno || null,             // $5 - Turno al que pertenece el gasto
                    categoryId,                   // $6
                    description || '',            // $7
                    numericAmount,                // $8
                    expenseDate,                  // $9
                    true,                         // $10 - SIEMPRE TRUE: este endpoint es solo para Desktop
                    global_id,                    // $11 - UUID from Desktop
                    terminal_id,                  // $12 - UUID from Desktop
                    local_op_seq,                 // $13 - Sequence number from Desktop
                    created_local_utc,            // $14 - ISO 8601 timestamp from Desktop
                    device_event_raw              // $15 - Raw .NET ticks from Desktop
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

    // PUT /api/expenses/:global_id - Actualizar gasto existente
    router.put('/:global_id', async (req, res) => {
        try {
            const { global_id } = req.params;
            const {
                tenant_id,
                category,
                description,
                amount,
                payment_type_id,
                expense_date_utc,
                last_modified_local_utc
            } = req.body;

            console.log(`[Expenses/Update] 🔄 Actualizando gasto ${global_id} - Tenant: ${tenant_id}`);

            // Validar campos requeridos
            if (!tenant_id || !category || amount === null || !payment_type_id || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, category, amount, payment_type_id, global_id requeridos)'
                });
            }

            // Validar que el gasto existe y pertenece al tenant
            const checkResult = await pool.query(
                'SELECT id FROM expenses WHERE global_id = $1::uuid AND tenant_id = $2',
                [global_id, tenant_id]
            );

            if (checkResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Gasto no encontrado o no pertenece al tenant'
                });
            }

            // Buscar o crear categoría
            let categoryId = null;
            const catResult = await pool.query(
                'SELECT id FROM expense_categories WHERE LOWER(name) = LOWER($1) AND tenant_id = $2',
                [category, tenant_id]
            );

            if (catResult.rows.length > 0) {
                categoryId = catResult.rows[0].id;
            } else {
                const newCat = await pool.query(
                    'INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) RETURNING id',
                    [tenant_id, category]
                );
                categoryId = newCat.rows[0].id;
                console.log(`[Expenses/Update] Categoría creada: ${category} (ID: ${categoryId})`);
            }

            // Actualizar gasto
            const numericAmount = parseFloat(amount);
            const updateResult = await pool.query(
                `UPDATE expenses
                 SET category_id = $1,
                     description = $2,
                     amount = $3,
                     payment_type_id = $4,
                     expense_date = $5,
                     updated_at = NOW()
                 WHERE global_id = $6::uuid AND tenant_id = $7
                 RETURNING *`,
                [
                    categoryId,
                    description || '',
                    numericAmount,
                    payment_type_id,
                    expense_date_utc || new Date().toISOString(),
                    global_id,
                    tenant_id
                ]
            );

            console.log(`[Expenses/Update] ✅ Gasto ${global_id} actualizado exitosamente`);

            const responseData = updateResult.rows[0];
            if (responseData) {
                responseData.amount = parseFloat(responseData.amount);
            }

            res.json({ success: true, data: responseData });
        } catch (error) {
            console.error('[Expenses/Update] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar gasto',
                error: error.message
            });
        }
    });

    // PATCH /api/expenses/:global_id/deactivate - Soft delete (marcar como eliminado)
    router.patch('/:global_id/deactivate', async (req, res) => {
        try {
            const { global_id } = req.params;
            const { tenant_id, last_modified_local_utc } = req.body;

            console.log(`[Expenses/Deactivate] 🗑️ Desactivando gasto ${global_id} - Tenant: ${tenant_id}`);

            // Validar que el gasto existe y pertenece al tenant
            const checkResult = await pool.query(
                'SELECT id FROM expenses WHERE global_id = $1::uuid AND tenant_id = $2',
                [global_id, tenant_id]
            );

            if (checkResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Gasto no encontrado o no pertenece al tenant'
                });
            }

            // Soft delete: marcar como inactivo
            const result = await pool.query(
                `UPDATE expenses
                 SET is_active = false,
                     deleted_at = NOW(),
                     updated_at = NOW()
                 WHERE global_id = $1::uuid AND tenant_id = $2
                 RETURNING *`,
                [global_id, tenant_id]
            );

            console.log(`[Expenses/Deactivate] ✅ Gasto ${global_id} desactivado exitosamente`);

            res.json({
                success: true,
                message: 'Gasto desactivado correctamente',
                data: result.rows[0]
            });
        } catch (error) {
            console.error('[Expenses/Deactivate] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al desactivar gasto',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // MOBILE EXPENSE REVIEW ENDPOINTS
    // ═══════════════════════════════════════════════════════════════
        router.get('/pending-review', async (req, res) => {
        try {
            const { employee_id, tenant_id } = req.query;

            if (!employee_id) {
                return res.status(400).json({
                    success: false,
                    message: 'employee_id es requerido'
                });
            }

        console.log(`[Expenses/PendingReview] 🔍 Buscando gastos pendientes para employee_id: ${employee_id}`);

        const query = `
            SELECT
                e.id,
                e.global_id,
                e.tenant_id,
                e.branch_id,
                e.employee_id,
                CONCAT(emp.first_name, ' ', emp.last_name) as employee_name,
                cat.name as category,
                cat.id as category_id,
                e.description,
                e.amount,
                e.expense_date,
                e.payment_type_id,
                e.id_turno as shift_id,
                e.reviewed_by_desktop,
                e.terminal_id,
                e.local_op_seq,
                e.created_local_utc,
                e.device_event_raw,
                e.created_at
            FROM expenses e
            LEFT JOIN employees emp ON e.employee_id = emp.id
            LEFT JOIN expense_categories cat ON e.category_id = cat.id
            WHERE e.employee_id = $1
              AND e.reviewed_by_desktop = false
              ${tenant_id ? 'AND e.tenant_id = $2' : ''}
            ORDER BY e.created_at DESC
        `;

        const params = tenant_id ? [employee_id, tenant_id] : [employee_id];
        const result = await pool.query(query, params);

        console.log(`[Expenses/PendingReview] ✅ Encontrados ${result.rows.length} gastos pendientes`);

        // Normalizar amount a número
        const normalizedRows = result.rows.map(row => ({
            ...row,
            amount: parseFloat(row.amount)
        }));

        res.json({
            success: true,
            count: result.rows.length,
            data: normalizedRows
        });
    } catch (error) {
        console.error('[Expenses/PendingReview] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener gastos pendientes',
            error: error.message
        });
    }
    });

    // PATCH /api/expenses/:global_id/approve - Aprobar gasto móvil
    router.patch('/:global_id/approve', async (req, res) => {
    try {
        const { global_id } = req.params;
        const { tenant_id } = req.body;

        console.log(`[Expenses/Approve] ✅ Aprobando gasto ${global_id} - Tenant: ${tenant_id}`);

        // Validar que el gasto existe y pertenece al tenant
        const checkResult = await pool.query(
            'SELECT id FROM expenses WHERE global_id = $1::uuid AND tenant_id = $2',
            [global_id, tenant_id]
        );

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Gasto no encontrado o no pertenece al tenant'
            });
        }

        // Marcar como revisado
        const result = await pool.query(
            `UPDATE expenses
             SET reviewed_by_desktop = true,
                 updated_at = NOW()
             WHERE global_id = $1::uuid AND tenant_id = $2
             RETURNING *`,
            [global_id, tenant_id]
        );

        console.log(`[Expenses/Approve] ✅ Gasto ${global_id} aprobado exitosamente`);

        res.json({
            success: true,
            message: 'Gasto aprobado correctamente',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('[Expenses/Approve] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al aprobar gasto',
            error: error.message
        });
    }
    });

    // DELETE /api/expenses/:global_id - Eliminar gasto rechazado
    router.delete('/:global_id', async (req, res) => {
    try {
        const { global_id } = req.params;
        const { tenant_id } = req.query;

        console.log(`[Expenses/Delete] 🗑️ Eliminando gasto ${global_id} - Tenant: ${tenant_id}`);

        if (!tenant_id) {
            return res.status(400).json({
                success: false,
                message: 'tenant_id es requerido'
            });
        }

        // Validar que el gasto existe y pertenece al tenant
        const checkResult = await pool.query(
            'SELECT id FROM expenses WHERE global_id = $1::uuid AND tenant_id = $2',
            [global_id, tenant_id]
        );

        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Gasto no encontrado o no pertenece al tenant'
            });
        }

        // Eliminación PERMANENTE (hard delete)
        const result = await pool.query(
            `DELETE FROM expenses
             WHERE global_id = $1::uuid AND tenant_id = $2
             RETURNING *`,
            [global_id, tenant_id]
        );

        console.log(`[Expenses/Delete] ✅ Gasto ${global_id} eliminado permanentemente`);

        res.json({
            success: true,
            message: 'Gasto eliminado correctamente',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('[Expenses/Delete] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al eliminar gasto',
            error: error.message
        });
    }
});

return router;
};
