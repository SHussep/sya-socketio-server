// ═══════════════════════════════════════════════════════════════
// UNITS OF MEASURE ROUTES - Catalog of measurement units
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

    // GET /api/units-of-measure - Get all units of measure
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT id, name, abbreviation FROM units_of_measure ORDER BY name ASC'
            );

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('[UnitsOfMeasure] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener unidades de medida' });
        }
    });

    return router;
};
