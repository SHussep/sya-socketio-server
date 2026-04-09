// ═══════════════════════════════════════════════════════════════
// BRANCH SETUP ROUTES - Provide available data for new branch setup
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (pool) => {
    const router = express.Router();

    // GET /api/branch-setup/available-data?tenantId=X
    // Returns products, employees, and customers available for assignment to a new branch
    router.get('/available-data', authenticateToken, async (req, res) => {
        try {
            const tenantId = parseInt(req.query.tenantId || req.user.tenantId);
            if (!tenantId) {
                return res.status(400).json({ error: 'tenantId is required' });
            }

            // Products: active, not deleted
            const productsResult = await pool.query(`
                SELECT p.id, p.global_id, p.descripcion, p.precio_venta, p.precio_compra,
                       p.image_url, p.unidad_medida,
                       COALESCE(cp.nombre, 'Sin categoria') as categoria
                FROM productos p
                LEFT JOIN categorias_productos cp ON cp.id = p.categoria_id AND cp.tenant_id = $1
                WHERE p.tenant_id = $1 AND p.eliminado = FALSE
                ORDER BY p.descripcion
            `, [tenantId]);

            // Employees: active, not owner (owner is auto-assigned)
            const employeesResult = await pool.query(`
                SELECT e.id, e.global_id,
                       COALESCE(e.first_name || ' ' || e.last_name, e.username) as full_name,
                       e.email, e.role_id,
                       COALESCE(r.name, 'Empleado') as role_name,
                       (e.pin_hash IS NOT NULL) as has_pin
                FROM employees e
                LEFT JOIN employee_roles r ON r.id = e.role_id AND r.tenant_id = $1
                WHERE e.tenant_id = $1 AND e.is_active = true AND e.is_owner = false
                ORDER BY full_name
            `, [tenantId]);

            // Customers: active, exclude generic
            const customersResult = await pool.query(`
                SELECT c.id, c.global_id, c.name, c.phone, c.address
                FROM customers c
                WHERE c.tenant_id = $1 AND c.activo = true
                  AND LOWER(c.name) != 'publico en general'
                ORDER BY c.name
            `, [tenantId]);

            res.json({
                products: productsResult.rows,
                employees: employeesResult.rows,
                customers: customersResult.rows
            });
        } catch (error) {
            console.error('Error fetching available data for branch setup:', error);
            res.status(500).json({ error: 'Error al obtener datos disponibles' });
        }
    });

    return router;
};
