// ═══════════════════════════════════════════════════════════════
// BRANCH SETTINGS ROUTES - Store per-branch settings (receipt config, etc.)
// Uses JSONB for flexible key-value storage per branch
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

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

    // GET /api/branch-settings/:key - Get a branch setting by key
    router.get('/:key', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { key } = req.params;
            const branch_id = req.query.branch_id || userBranchId;

            if (!tenantId || !branch_id) {
                return res.status(400).json({ success: false, message: 'tenant_id y branch_id requeridos' });
            }

            const result = await pool.query(
                `SELECT setting_value, updated_at, updated_by_terminal_id
                 FROM branch_settings
                 WHERE tenant_id = $1 AND branch_id = $2 AND setting_key = $3`,
                [tenantId, branch_id, key]
            );

            if (result.rows.length === 0) {
                return res.json({ success: true, data: null });
            }

            res.json({
                success: true,
                data: {
                    value: result.rows[0].setting_value,
                    updated_at: result.rows[0].updated_at,
                    updated_by_terminal_id: result.rows[0].updated_by_terminal_id
                }
            });
        } catch (error) {
            console.error(`[BranchSettings] GET error:`, error.message);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // POST /api/branch-settings/:key - Upsert a branch setting
    router.post('/:key', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { key } = req.params;
            const { value, branch_id: bodyBranchId, terminal_id } = req.body;
            const branch_id = bodyBranchId || userBranchId;

            if (!tenantId || !branch_id) {
                return res.status(400).json({ success: false, message: 'tenant_id y branch_id requeridos' });
            }

            if (value === undefined || value === null) {
                return res.status(400).json({ success: false, message: 'value es requerido' });
            }

            const result = await pool.query(
                `INSERT INTO branch_settings (tenant_id, branch_id, setting_key, setting_value, updated_by_terminal_id, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (tenant_id, branch_id, setting_key)
                 DO UPDATE SET
                    setting_value = EXCLUDED.setting_value,
                    updated_by_terminal_id = EXCLUDED.updated_by_terminal_id,
                    updated_at = NOW()
                 RETURNING id, updated_at`,
                [tenantId, branch_id, key, JSON.stringify(value), terminal_id || null]
            );

            console.log(`[BranchSettings] Upserted ${key} for tenant=${tenantId} branch=${branch_id}`);

            res.json({
                success: true,
                data: {
                    id: result.rows[0].id,
                    updated_at: result.rows[0].updated_at
                }
            });
        } catch (error) {
            console.error(`[BranchSettings] POST error:`, error.message);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    return router;
};
