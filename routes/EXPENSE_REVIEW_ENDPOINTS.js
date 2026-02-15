// ═══════════════════════════════════════════════════════════════
// MOBILE EXPENSE REVIEW ENDPOINTS
// ═══════════════════════════════════════════════════════════════
// Agregar estos endpoints al archivo expenses.js ANTES de "return router;"

// GET /api/expenses/pending-review - Obtener gastos móviles pendientes de revisión
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
            error: undefined
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
            error: undefined
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
            error: undefined
        });
    }
});
