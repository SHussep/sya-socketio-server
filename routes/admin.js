// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTES - Sistema de limpieza y mantenimiento
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

    // POST /api/admin/cleanup - Limpiar datos de transacciones (mantener maestros)
    // Requiere: JWT válido
    router.post('/cleanup', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            console.log(`\n[ADMIN] 🧹 Iniciando limpieza de datos solicitada por ${req.user.email}\n`);

            await client.query('BEGIN');

            // Desactivar constraints
            console.log('[ADMIN] ⏸️  Desactivando triggers...');
            await client.query('ALTER TABLE sales_items DISABLE TRIGGER ALL');
            await client.query('ALTER TABLE sales DISABLE TRIGGER ALL');
            await client.query('ALTER TABLE expenses DISABLE TRIGGER ALL');
            await client.query('ALTER TABLE cash_cuts DISABLE TRIGGER ALL');
            await client.query('ALTER TABLE guardian_events DISABLE TRIGGER ALL');
            await client.query('ALTER TABLE shifts DISABLE TRIGGER ALL');

            // Borrar datos
            console.log('[ADMIN] 🗑️  Borrando datos de transacciones...');

            const result1 = await client.query('DELETE FROM sales_items');
            console.log(`[ADMIN]    ✅ Eliminados ${result1.rowCount} registros de sales_items`);

            const result2 = await client.query('DELETE FROM sales');
            console.log(`[ADMIN]    ✅ Eliminados ${result2.rowCount} registros de sales`);

            const result3 = await client.query('DELETE FROM expenses');
            console.log(`[ADMIN]    ✅ Eliminados ${result3.rowCount} registros de expenses`);

            const result4 = await client.query('DELETE FROM cash_cuts');
            console.log(`[ADMIN]    ✅ Eliminados ${result4.rowCount} registros de cash_cuts`);

            const result5 = await client.query('DELETE FROM guardian_events');
            console.log(`[ADMIN]    ✅ Eliminados ${result5.rowCount} registros de guardian_events`);

            const result6 = await client.query('DELETE FROM shifts');
            console.log(`[ADMIN]    ✅ Eliminados ${result6.rowCount} registros de shifts`);

            // Reactivar constraints
            console.log('[ADMIN] ▶️  Reactivando triggers...');
            await client.query('ALTER TABLE sales_items ENABLE TRIGGER ALL');
            await client.query('ALTER TABLE sales ENABLE TRIGGER ALL');
            await client.query('ALTER TABLE expenses ENABLE TRIGGER ALL');
            await client.query('ALTER TABLE cash_cuts ENABLE TRIGGER ALL');
            await client.query('ALTER TABLE guardian_events ENABLE TRIGGER ALL');
            await client.query('ALTER TABLE shifts ENABLE TRIGGER ALL');

            // Reset sequences
            console.log('[ADMIN] 🔄 Reiniciando secuencias...');
            await client.query('ALTER SEQUENCE sales_id_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE sales_items_id_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE expenses_id_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE cash_cuts_id_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE guardian_events_id_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE shifts_id_seq RESTART WITH 1');

            // Commit transaction
            await client.query('COMMIT');

            // Verificar limpieza
            console.log('[ADMIN] 📊 Verificando limpieza...');
            const verify = await client.query(`
                SELECT
                    (SELECT COUNT(*) FROM sales) as sales_count,
                    (SELECT COUNT(*) FROM sales_items) as sales_items_count,
                    (SELECT COUNT(*) FROM expenses) as expenses_count,
                    (SELECT COUNT(*) FROM cash_cuts) as cash_cuts_count,
                    (SELECT COUNT(*) FROM guardian_events) as guardian_events_count,
                    (SELECT COUNT(*) FROM shifts) as shifts_count
            `);

            const data = verify.rows[0];
            console.log(`[ADMIN]    sales: ${data.sales_count}`);
            console.log(`[ADMIN]    sales_items: ${data.sales_items_count}`);
            console.log(`[ADMIN]    expenses: ${data.expenses_count}`);
            console.log(`[ADMIN]    cash_cuts: ${data.cash_cuts_count}`);
            console.log(`[ADMIN]    guardian_events: ${data.guardian_events_count}`);
            console.log(`[ADMIN]    shifts: ${data.shifts_count}`);

            // Verificar maestros intactos
            console.log('[ADMIN] ✅ Verificando datos maestros...');
            const masters = await client.query(`
                SELECT
                    'Tenants' as tabla, COUNT(*) as count FROM tenants
                UNION ALL
                SELECT 'Branches', COUNT(*) FROM branches
                UNION ALL
                SELECT 'Employees', COUNT(*) FROM employees
                UNION ALL
                SELECT 'Subscriptions', COUNT(*) FROM subscriptions
            `);

            masters.rows.forEach(row => {
                console.log(`[ADMIN]    ${row.tabla}: ${row.count}`);
            });

            console.log('[ADMIN] ✅ ¡Limpieza completada exitosamente!\n');

            res.json({
                success: true,
                message: 'Limpieza completada exitosamente',
                deleted: {
                    sales_items: result1.rowCount,
                    sales: result2.rowCount,
                    expenses: result3.rowCount,
                    cash_cuts: result4.rowCount,
                    guardian_events: result5.rowCount,
                    shifts: result6.rowCount
                },
                remaining: data,
                masters: masters.rows
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[ADMIN] ❌ Error durante la limpieza:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error durante la limpieza',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // GET /api/admin/status - Estado general de la BD
    router.get('/status', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    (SELECT COUNT(*) FROM sales) as sales,
                    (SELECT COUNT(*) FROM sales_items) as sales_items,
                    (SELECT COUNT(*) FROM expenses) as expenses,
                    (SELECT COUNT(*) FROM cash_cuts) as cash_cuts,
                    (SELECT COUNT(*) FROM tenants) as tenants,
                    (SELECT COUNT(*) FROM employees) as employees,
                    (SELECT COUNT(*) FROM subscriptions) as subscriptions,
                    NOW() as server_time
            `);

            res.json({
                success: true,
                data: result.rows[0]
            });
        } catch (error) {
            console.error('[ADMIN] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener estado' });
        }
    });

    return router;
};
