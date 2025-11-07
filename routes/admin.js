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
    // ⚠️ SOLO LIMPIA TRANSACCIONES - Mantiene: subscriptions, tenants, branches, employees, roles, productos, customers
    router.post('/cleanup', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            console.log(`\n[ADMIN] 🧹 Iniciando limpieza de datos transaccionales solicitada por ${req.user.email}\n`);

            await client.query('BEGIN');

            // Borrar datos transaccionales (orden inverso por FKs)
            console.log('[ADMIN] 🗑️  Borrando datos transaccionales...');

            const result1 = await client.query('DELETE FROM ventas_detalle');
            console.log(`[ADMIN]    ✅ Eliminados ${result1.rowCount} registros de ventas_detalle`);

            const result2 = await client.query('DELETE FROM ventas');
            console.log(`[ADMIN]    ✅ Eliminados ${result2.rowCount} registros de ventas`);

            const result3 = await client.query('DELETE FROM repartidor_assignments');
            console.log(`[ADMIN]    ✅ Eliminados ${result3.rowCount} registros de repartidor_assignments`);

            const result4 = await client.query('DELETE FROM cash_cuts');
            console.log(`[ADMIN]    ✅ Eliminados ${result4.rowCount} registros de cash_cuts`);

            const result5 = await client.query('DELETE FROM withdrawals');
            console.log(`[ADMIN]    ✅ Eliminados ${result5.rowCount} registros de withdrawals`);

            const result6 = await client.query('DELETE FROM deposits');
            console.log(`[ADMIN]    ✅ Eliminados ${result6.rowCount} registros de deposits`);

            const result7 = await client.query('DELETE FROM expenses');
            console.log(`[ADMIN]    ✅ Eliminados ${result7.rowCount} registros de expenses`);

            const result8 = await client.query('DELETE FROM shifts');
            console.log(`[ADMIN]    ✅ Eliminados ${result8.rowCount} registros de shifts`);

            const result9 = await client.query('DELETE FROM sessions');
            console.log(`[ADMIN]    ✅ Eliminados ${result9.rowCount} registros de sessions`);

            const result10 = await client.query('DELETE FROM devices');
            console.log(`[ADMIN]    ✅ Eliminados ${result10.rowCount} registros de devices`);

            const result11 = await client.query('DELETE FROM backup_metadata');
            console.log(`[ADMIN]    ✅ Eliminados ${result11.rowCount} registros de backup_metadata`);

            // Guardian tables
            let result12 = { rowCount: 0 };
            let result13 = { rowCount: 0 };
            let result14 = { rowCount: 0 };

            try {
                result12 = await client.query('DELETE FROM guardian_employee_scores_daily');
                console.log(`[ADMIN]    ✅ Eliminados ${result12.rowCount} registros de guardian_employee_scores_daily`);

                result13 = await client.query('DELETE FROM suspicious_weighing_events');
                console.log(`[ADMIN]    ✅ Eliminados ${result13.rowCount} registros de suspicious_weighing_events`);

                result14 = await client.query('DELETE FROM scale_disconnections');
                console.log(`[ADMIN]    ✅ Eliminados ${result14.rowCount} registros de scale_disconnections`);
            } catch (e) {
                console.log(`[ADMIN]    ℹ️  Tablas Guardian no existen aún: ${e.message}`);
            }

            // Reset sequences de transaccionales
            console.log('[ADMIN] 🔄 Reiniciando secuencias...');
            await client.query('ALTER SEQUENCE IF EXISTS ventas_id_venta_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE IF EXISTS ventas_detalle_id_venta_detalle_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE IF EXISTS shifts_id_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE IF EXISTS devices_id_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE IF EXISTS expenses_id_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE IF EXISTS deposits_id_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE IF EXISTS withdrawals_id_seq RESTART WITH 1');
            await client.query('ALTER SEQUENCE IF EXISTS cash_cuts_id_seq RESTART WITH 1');

            // Commit transaction
            await client.query('COMMIT');

            // Verificar limpieza
            console.log('[ADMIN] 📊 Verificando limpieza...');
            const verify = await client.query(`
                SELECT
                    (SELECT COUNT(*) FROM ventas) as ventas,
                    (SELECT COUNT(*) FROM ventas_detalle) as ventas_detalle,
                    (SELECT COUNT(*) FROM expenses) as expenses,
                    (SELECT COUNT(*) FROM cash_cuts) as cash_cuts,
                    (SELECT COUNT(*) FROM shifts) as shifts,
                    (SELECT COUNT(*) FROM devices) as devices
            `);

            const data = verify.rows[0];
            console.log(`[ADMIN]    ventas: ${data.ventas}`);
            console.log(`[ADMIN]    ventas_detalle: ${data.ventas_detalle}`);
            console.log(`[ADMIN]    expenses: ${data.expenses}`);
            console.log(`[ADMIN]    cash_cuts: ${data.cash_cuts}`);
            console.log(`[ADMIN]    shifts: ${data.shifts}`);
            console.log(`[ADMIN]    devices: ${data.devices}`);

            // Verificar maestros intactos
            console.log('[ADMIN] ✅ Verificando datos maestros (NO MODIFICADOS)...');
            const masters = await client.query(`
                SELECT
                    'Subscriptions' as tabla, COUNT(*) as count FROM subscriptions
                UNION ALL
                SELECT 'Roles', COUNT(*) FROM roles
                UNION ALL
                SELECT 'Tenants', COUNT(*) FROM tenants
                UNION ALL
                SELECT 'Branches', COUNT(*) FROM branches
                UNION ALL
                SELECT 'Employees', COUNT(*) FROM employees
                UNION ALL
                SELECT 'Customers', COALESCE((SELECT COUNT(*) FROM customers), 0) FROM (SELECT 1) AS dummy
                UNION ALL
                SELECT 'Productos', COALESCE((SELECT COUNT(*) FROM productos), 0) FROM (SELECT 1) AS dummy
            `);

            masters.rows.forEach(row => {
                console.log(`[ADMIN]    ${row.tabla}: ${row.count}`);
            });

            console.log('[ADMIN] ✅ ¡Limpieza completada exitosamente!\n');

            res.json({
                success: true,
                message: 'Limpieza de datos transaccionales completada - Maestros intactos',
                deleted: {
                    ventas_detalle: result1.rowCount,
                    ventas: result2.rowCount,
                    repartidor_assignments: result3.rowCount,
                    cash_cuts: result4.rowCount,
                    withdrawals: result5.rowCount,
                    deposits: result6.rowCount,
                    expenses: result7.rowCount,
                    shifts: result8.rowCount,
                    sessions: result9.rowCount,
                    devices: result10.rowCount,
                    backup_metadata: result11.rowCount,
                    guardian_scores: result12.rowCount,
                    suspicious_events: result13.rowCount,
                    scale_disconnections: result14.rowCount
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
                    (SELECT COUNT(*) FROM ventas) as ventas,
                    (SELECT COUNT(*) FROM ventas_detalle) as ventas_detalle,
                    (SELECT COUNT(*) FROM expenses) as expenses,
                    (SELECT COUNT(*) FROM cash_cuts) as cash_cuts,
                    (SELECT COUNT(*) FROM shifts) as shifts,
                    (SELECT COUNT(*) FROM tenants) as tenants,
                    (SELECT COUNT(*) FROM employees) as employees,
                    (SELECT COUNT(*) FROM branches) as branches,
                    (SELECT COUNT(*) FROM subscriptions) as subscriptions,
                    (SELECT COUNT(*) FROM roles) as roles,
                    COALESCE((SELECT COUNT(*) FROM customers), 0) as customers,
                    COALESCE((SELECT COUNT(*) FROM productos), 0) as productos,
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
