// ═══════════════════════════════════════════════════════════════
// PURCHASES ROUTES - Extracted from server.js
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

    // GET /api/purchases - Lista de compras
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false' } = req.query;

            let query = `
                SELECT p.id, p.purchase_number, p.total_amount, p.payment_status, p.notes, p.purchase_date,
                       s.name as supplier_name, emp.full_name as employee_name, b.name as branch_name
                FROM purchases p
                LEFT JOIN suppliers s ON p.supplier_id = s.id
                LEFT JOIN employees emp ON p.employee_id = emp.id
                LEFT JOIN branches b ON p.branch_id = b.id
                WHERE p.tenant_id = $1
            `;

            const params = [tenantId];

            if (all_branches !== 'true' && branchId) {
                query += ' AND p.branch_id = $2';
                params.push(branchId);
                query += ' ORDER BY p.purchase_date DESC LIMIT $3 OFFSET $4';
                params.push(limit, offset);
            } else {
                query += ' ORDER BY p.purchase_date DESC LIMIT $2 OFFSET $3';
                params.push(limit, offset);
            }

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('[Purchases] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener compras' });
        }
    });

    // POST /api/purchases - Crear compra desde Desktop (sin JWT)
    router.post('/', async (req, res) => {
        try {
            const { tenantId, branchId, supplierId, employeeId, purchaseNumber, totalAmount, paymentStatus, notes, userEmail } = req.body;

            if (!tenantId || !branchId || !supplierId || !purchaseNumber || !totalAmount) {
                return res.status(400).json({ success: false, message: 'Datos incompletos' });
            }

            // Buscar empleado por email si viene
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

            const result = await pool.query(
                `INSERT INTO purchases (tenant_id, branch_id, supplier_id, employee_id, purchase_number, total_amount, payment_status, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [tenantId, branchId, supplierId, finalEmployeeId, purchaseNumber, totalAmount, paymentStatus || 'pending', notes || null]
            );

            console.log(`[Purchases] ✅ Compra creada desde Desktop: ${purchaseNumber} - $${totalAmount}`);
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('[Purchases] Error:', error);
            res.status(500).json({ success: false, message: 'Error al crear compra' });
        }
    });

    // POST /api/sync/purchases - Alias de /api/purchases (para compatibilidad con Desktop)
    router.post('/sync', async (req, res) => {
        try {
            const { tenantId, branchId, supplierId, employeeId, purchaseNumber, totalAmount, paymentStatus, notes, userEmail } = req.body;

            console.log(`[Sync/Purchases] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, Purchase: ${purchaseNumber}`);

            if (!tenantId || !branchId || !supplierId || !purchaseNumber || !totalAmount) {
                return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, supplierId, purchaseNumber, totalAmount requeridos)' });
            }

            // Buscar empleado por email si viene
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

            const result = await pool.query(
                `INSERT INTO purchases (tenant_id, branch_id, supplier_id, employee_id, purchase_number, total_amount, payment_status, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [tenantId, branchId, supplierId, finalEmployeeId, purchaseNumber, totalAmount, paymentStatus || 'pending', notes || null]
            );

            console.log(`[Sync/Purchases] ✅ Compra sincronizada: ${purchaseNumber} - $${totalAmount}`);
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('[Sync/Purchases] Error:', error);
            res.status(500).json({ success: false, message: 'Error al sincronizar compra', error: error.message });
        }
    });

    return router;
};
