// NOTIFICATION HISTORY ROUTES
const express = require("express");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;

function authenticateToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ success: false, message: "Token no proporcionado" });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: "Token invalido" });
        req.user = user;
        next();
    });
}

module.exports = (pool) => {
    const router = express.Router();

    router.get("/", authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;
            const { category, is_read, include_hidden = "false", limit = 50, offset = 0 } = req.query;
            let query = `SELECT n.*, e.first_name || ' ' || COALESCE(e.last_name, '') as employee_name, b.name as branch_name FROM notifications n LEFT JOIN employees e ON n.employee_id = e.id LEFT JOIN branches b ON n.branch_id = b.id WHERE n.tenant_id = $1`;
            const params = [tenantId];
            let idx = 2;
            if (branchId) { query += ` AND (n.branch_id = $${idx} OR n.branch_id IS NULL)`; params.push(branchId); idx++; }
            if (category) { query += ` AND n.category = $${idx}`; params.push(category); idx++; }
            if (is_read === "true") query += " AND n.is_read = TRUE";
            else if (is_read === "false") query += " AND n.is_read = FALSE";
            if (include_hidden !== "true") query += " AND (n.is_hidden = FALSE OR n.is_hidden IS NULL)";
            query += ` ORDER BY n.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
            params.push(parseInt(limit), parseInt(offset));
            const result = await pool.query(query, params);
            res.json({ success: true, data: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.get("/unread-count", authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;
            let query = "SELECT category, COUNT(*) as count FROM notifications WHERE tenant_id = $1 AND is_read = FALSE AND (is_hidden = FALSE OR is_hidden IS NULL)";
            const params = [tenantId];
            if (branchId) { query += " AND (branch_id = $2 OR branch_id IS NULL)"; params.push(branchId); }
            query += " GROUP BY category";
            const result = await pool.query(query, params);
            const counts = { login: 0, logout: 0, cash_cut: 0, credit_payment: 0, expense: 0, sale: 0, system: 0, total: 0 };
            for (const row of result.rows) { counts[row.category] = parseInt(row.count); counts.total += parseInt(row.count); }
            res.json({ success: true, data: counts });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.post("/", async (req, res) => {
        try {
            const { tenant_id, branch_id, employee_id, category, event_type, title, body, data } = req.body;
            if (!tenant_id || !category || !event_type || !title) return res.status(400).json({ success: false, message: "Campos requeridos" });
            const result = await pool.query("INSERT INTO notifications (tenant_id, branch_id, employee_id, category, event_type, title, body, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *", [tenant_id, branch_id, employee_id, category, event_type, title, body, data]);
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.patch("/:id/read", authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { tenantId, employeeId } = req.user;
            const result = await pool.query("UPDATE notifications SET is_read = TRUE, read_at = NOW(), read_by_employee_id = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING id, is_read", [employeeId, id, tenantId]);
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: "No encontrada" });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.patch("/read-all", authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId, employeeId } = req.user;
            const { category } = req.body;
            let query = "UPDATE notifications SET is_read = TRUE, read_at = NOW(), read_by_employee_id = $1, updated_at = NOW() WHERE tenant_id = $2 AND is_read = FALSE";
            const params = [employeeId, tenantId];
            let idx = 3;
            if (branchId) { query += ` AND (branch_id = $${idx} OR branch_id IS NULL)`; params.push(branchId); idx++; }
            if (category) { query += ` AND category = $${idx}`; params.push(category); }
            const result = await pool.query(query, params);
            res.json({ success: true, data: { count: result.rowCount } });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    router.patch("/:id/hide", authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { tenantId, employeeId } = req.user;
            const result = await pool.query("UPDATE notifications SET is_hidden = TRUE, hidden_at = NOW(), hidden_by_employee_id = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING id", [employeeId, id, tenantId]);
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: "No encontrada" });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // Marcar como leída y eliminar (ocultar) en una sola operación
    router.patch("/:id/read-and-delete", authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { tenantId, employeeId } = req.user;
            const result = await pool.query(
                `UPDATE notifications SET
                    is_read = TRUE, read_at = NOW(), read_by_employee_id = $1,
                    is_hidden = TRUE, hidden_at = NOW(), hidden_by_employee_id = $1,
                    updated_at = NOW()
                WHERE id = $2 AND tenant_id = $3 RETURNING id`,
                [employeeId, id, tenantId]
            );
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: "No encontrada" });
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // Marcar todas como leídas y eliminar (ocultar) en una sola operación
    router.patch("/read-and-delete-all", authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId, employeeId } = req.user;
            const { category } = req.body;
            let query = `UPDATE notifications SET
                is_read = TRUE, read_at = NOW(), read_by_employee_id = $1,
                is_hidden = TRUE, hidden_at = NOW(), hidden_by_employee_id = $1,
                updated_at = NOW()
            WHERE tenant_id = $2 AND (is_hidden = FALSE OR is_hidden IS NULL)`;
            const params = [employeeId, tenantId];
            let idx = 3;
            if (branchId) { query += ` AND (branch_id = $${idx} OR branch_id IS NULL)`; params.push(branchId); idx++; }
            if (category) { query += ` AND category = $${idx}`; params.push(category); }
            const result = await pool.query(query, params);
            res.json({ success: true, data: { count: result.rowCount } });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ==========================================
    // ELIMINACIÓN PERMANENTE DE POSTGRESQL
    // ==========================================

    // Eliminar permanentemente una notificación
    router.delete("/:id", authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { tenantId } = req.user;
            const result = await pool.query(
                "DELETE FROM notifications WHERE id = $1 AND tenant_id = $2 RETURNING id",
                [id, tenantId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: "Notificación no encontrada" });
            }
            res.json({ success: true, data: { id: result.rows[0].id, deleted: true } });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // Eliminar permanentemente todas las notificaciones (leídas u ocultas)
    router.delete("/delete-read", authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;
            const { category } = req.query;

            // Eliminar notificaciones que ya fueron leídas o están ocultas
            let query = "DELETE FROM notifications WHERE tenant_id = $1 AND (is_read = TRUE OR is_hidden = TRUE)";
            const params = [tenantId];
            let idx = 2;

            if (branchId) {
                query += ` AND (branch_id = $${idx} OR branch_id IS NULL)`;
                params.push(branchId);
                idx++;
            }
            if (category) {
                query += ` AND category = $${idx}`;
                params.push(category);
            }

            const result = await pool.query(query, params);
            res.json({ success: true, data: { count: result.rowCount, deleted: true } });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    });

    return router;
};

module.exports.createNotification = async (pool, { tenant_id, branch_id, employee_id, category, event_type, title, body, data }) => {
    try {
        const result = await pool.query("INSERT INTO notifications (tenant_id, branch_id, employee_id, category, event_type, title, body, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", [tenant_id, branch_id, employee_id, category, event_type, title, body, data]);
        return result.rows[0].id;
    } catch (e) { console.error("[NotificationHistory] Error:", e.message); return null; }
};

