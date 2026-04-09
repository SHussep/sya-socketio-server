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

    // POST /api/branch-setup/import
    // Import selected products and employees into a new branch
    router.post('/import', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const { tenantId, branchId, productIds, employeeIds } = req.body;

            if (!tenantId || !branchId) {
                return res.status(400).json({ error: 'tenantId and branchId are required' });
            }

            await client.query('BEGIN');

            let productsImported = 0;
            let employeesImported = 0;

            // 1. Products → create producto_branches rows with inventory=0 and base prices
            if (productIds && productIds.length > 0) {
                const productsData = await client.query(`
                    SELECT id, global_id, precio_venta, precio_compra
                    FROM productos
                    WHERE id = ANY($1) AND tenant_id = $2 AND eliminado = FALSE
                `, [productIds, tenantId]);

                for (const product of productsData.rows) {
                    const result = await client.query(`
                        INSERT INTO producto_branches
                          (tenant_id, branch_id, product_global_id, precio_venta, precio_compra,
                           inventario, minimo, is_active, global_id)
                        VALUES ($1, $2, $3, $4, $5, 0, 0, true, gen_random_uuid())
                        ON CONFLICT (tenant_id, product_global_id, branch_id) DO NOTHING
                        RETURNING id
                    `, [tenantId, branchId, product.global_id, product.precio_venta, product.precio_compra]);

                    if (result.rows.length > 0) productsImported++;
                }
            }

            // 2. Employees → create employee_branches relationships
            if (employeeIds && employeeIds.length > 0) {
                for (const employeeId of employeeIds) {
                    const result = await client.query(`
                        INSERT INTO employee_branches (tenant_id, employee_id, branch_id)
                        VALUES ($1, $2, $3)
                        ON CONFLICT (employee_id, branch_id) DO NOTHING
                        RETURNING id
                    `, [tenantId, employeeId, branchId]);

                    if (result.rows.length > 0) employeesImported++;
                }
            }

            await client.query('COMMIT');

            res.json({
                success: true,
                imported: {
                    products: productsImported,
                    employees: employeesImported
                }
            });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error importing branch setup data:', error);
            res.status(500).json({ error: 'Error al importar datos de sucursal' });
        } finally {
            client.release();
        }
    });

    return router;
};
