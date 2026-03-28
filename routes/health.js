// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK ROUTE - Connectivity check for Desktop clients
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

module.exports = function healthRoutes(pool) {
    router.get('/', async (req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok' });
        } catch (err) {
            res.status(503).json({ status: 'error', message: 'Database unreachable' });
        }
    });
    return router;
};
