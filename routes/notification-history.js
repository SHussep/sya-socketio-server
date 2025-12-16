// NOTIFICATION HISTORY ROUTES
const express = require("express");
const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware que extrae datos del token SIN verificar expiración
// (La app móvil maneja refresh tokens por separado)
function authenticateToken(req, res, next) {
    console.log(`[NotificationHistory/Auth] 🔑 Procesando autenticación...`);
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) {
        console.log(`[NotificationHistory/Auth] ❌ No hay token`);
        return res.status(401).json({ success: false, message: "Token no proporcionado" });
    }
    try {
        // Decodificar sin verificar - solo extraemos los datos
        const decoded = jwt.decode(token);
        console.log(`[NotificationHistory/Auth] 🔍 Token decodificado:`, decoded ? `tenantId=${decoded.tenantId}` : 'NULL');
        if (!decoded || !decoded.tenantId) {
            console.log(`[NotificationHistory/Auth] ❌ Token sin tenantId`);
            return res.status(403).json({ success: false, message: "Token inválido" });
        }
        req.user = decoded;
        console.log(`[NotificationHistory/Auth] ✅ Auth OK - tenantId=${decoded.tenantId}`);
        next();
    } catch (err) {
        console.log(`[NotificationHistory/Auth] ❌ Error:`, err.message);
        return res.status(403).json({ success: false, message: "Token inválido" });
    }
}

module.exports = (pool) => {
    const router = express.Router();

    // Log TODAS las requests que llegan a este router
    router.use((req, res, next) => {
        console.log(`[NotificationHistory] 📥 ${req.method} ${req.path} - Headers: ${req.headers.authorization ? 'Bearer ***' : 'NO AUTH'}`);
        next();
    });

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

    // Eliminar permanentemente TODAS las notificaciones (botón "Limpiar todas")
    router.delete("/delete-all", authenticateToken, async (req, res) => {
        try {
            console.log(`[NotificationHistory/DeleteAll] 📥 req.user:`, JSON.stringify(req.user));

            const { tenantId, branchId } = req.user || {};

            if (!tenantId) {
                console.error(`[NotificationHistory/DeleteAll] ❌ tenantId no encontrado en token`);
                return res.status(400).json({ success: false, message: 'tenantId no encontrado en token' });
            }

            // Aceptar category de body O query params (más compatible con HTTP DELETE)
            const category = req.body?.category || req.query?.category;

            console.log(`[NotificationHistory/DeleteAll] 🗑️ Eliminando todas - Tenant: ${tenantId}, Branch: ${branchId || 'ALL'}, Category: ${category || 'ALL'}`);

            let query = "DELETE FROM notifications WHERE tenant_id = $1";
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

            console.log(`[NotificationHistory/DeleteAll] 📝 Query: ${query}`);
            console.log(`[NotificationHistory/DeleteAll] 📝 Params: ${JSON.stringify(params)}`);

            const result = await pool.query(query, params);
            console.log(`[NotificationHistory/DeleteAll] ✅ Eliminadas ${result.rowCount} notificaciones`);
            res.json({ success: true, data: { count: result.rowCount, deleted: true } });
        } catch (error) {
            console.error(`[NotificationHistory/DeleteAll] ❌ Error:`, error.message);
            console.error(`[NotificationHistory/DeleteAll] ❌ Stack:`, error.stack);
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

