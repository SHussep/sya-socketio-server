// routes/geofence_zones.js
// CRUD for geofence zones — circular delivery areas per branch
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

function authenticateToken(req, res, next) {
    if (!JWT_SECRET) {
        return res.status(500).json({ success: false, message: 'Configuración de seguridad faltante' });
    }
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token inválido' });
        }
        req.user = user;
        next();
    });
}

module.exports = (pool, io) => {

    // ═══════════════════════════════════════════════════════════════
    // GET /api/geofence-zones?branch_id=X — List active zones
    // ═══════════════════════════════════════════════════════════════
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { branch_id } = req.query;

            if (!branch_id) {
                return res.status(400).json({ success: false, message: 'branch_id es requerido' });
            }

            const result = await pool.query(
                `SELECT id, branch_id, name, latitude, longitude, radius_meters, color, is_active, created_at, updated_at
                 FROM geofence_zones
                 WHERE tenant_id = $1 AND branch_id = $2 AND is_active = true
                 ORDER BY name`,
                [tenantId, parseInt(branch_id)]
            );

            return res.json({ success: true, data: result.rows });
        } catch (error) {
            console.error('[Geofence] GET error:', error.message);
            return res.status(500).json({ success: false, message: 'Error del servidor' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/geofence-zones/events — Geofence event history
    // ═══════════════════════════════════════════════════════════════
    router.get('/events', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { branch_id, employee_id, zone_id, date, limit = 100 } = req.query;

            if (!branch_id) {
                return res.status(400).json({ success: false, message: 'branch_id es requerido' });
            }

            let query = `
                SELECT ge.id, ge.event_type, ge.latitude, ge.longitude, ge.distance_meters, ge.created_at,
                       COALESCE(e.first_name || ' ' || e.last_name, e.username) AS employee_name,
                       e.id AS employee_id,
                       gz.name AS zone_name, gz.color AS zone_color
                FROM geofence_events ge
                JOIN employees e ON e.id = ge.employee_id
                JOIN geofence_zones gz ON gz.id = ge.zone_id
                WHERE ge.tenant_id = $1 AND ge.branch_id = $2`;
            const params = [tenantId, parseInt(branch_id)];
            let paramIdx = 3;

            if (employee_id) {
                query += ` AND ge.employee_id = $${paramIdx}`;
                params.push(parseInt(employee_id));
                paramIdx++;
            }
            if (zone_id) {
                query += ` AND ge.zone_id = $${paramIdx}`;
                params.push(parseInt(zone_id));
                paramIdx++;
            }
            if (date) {
                query += ` AND ge.created_at >= $${paramIdx}::date AND ge.created_at < ($${paramIdx}::date + INTERVAL '1 day')`;
                params.push(date);
                paramIdx++;
            }

            query += ` ORDER BY ge.created_at DESC LIMIT $${paramIdx}`;
            params.push(parseInt(limit));

            const result = await pool.query(query, params);
            return res.json({ success: true, data: result.rows });
        } catch (error) {
            console.error('[Geofence] Events GET error:', error.message);
            return res.status(500).json({ success: false, message: 'Error del servidor' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/geofence-zones — Create zone
    // ═══════════════════════════════════════════════════════════════
    router.post('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { name, latitude, longitude, radius_meters, branch_id, color } = req.body;

            if (!name || latitude == null || longitude == null || !branch_id) {
                return res.status(400).json({
                    success: false,
                    message: 'name, latitude, longitude, branch_id son requeridos'
                });
            }

            const result = await pool.query(
                `INSERT INTO geofence_zones (tenant_id, branch_id, name, latitude, longitude, radius_meters, color)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING *`,
                [tenantId, branch_id, name.trim(), latitude, longitude, radius_meters || 500, color || '#4285F4']
            );

            const zone = result.rows[0];
            console.log(`[Geofence] ✅ Zona creada: "${zone.name}" (${zone.radius_meters}m) en branch ${branch_id}`);

            io.to(`branch_${branch_id}`).emit('geofence:zone_created', zone);

            return res.status(201).json({ success: true, data: zone });
        } catch (error) {
            console.error('[Geofence] POST error:', error.message);
            return res.status(500).json({ success: false, message: 'Error del servidor' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUT /api/geofence-zones/:id — Update zone
    // ═══════════════════════════════════════════════════════════════
    router.put('/:id', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { id } = req.params;
            const { name, latitude, longitude, radius_meters, color } = req.body;

            const result = await pool.query(
                `UPDATE geofence_zones
                 SET name = COALESCE($1, name),
                     latitude = COALESCE($2, latitude),
                     longitude = COALESCE($3, longitude),
                     radius_meters = COALESCE($4, radius_meters),
                     color = COALESCE($5, color),
                     updated_at = NOW()
                 WHERE id = $6 AND tenant_id = $7 AND is_active = true
                 RETURNING *`,
                [name?.trim(), latitude, longitude, radius_meters, color, parseInt(id), tenantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Zona no encontrada' });
            }

            const zone = result.rows[0];
            console.log(`[Geofence] ✏️ Zona actualizada: "${zone.name}" (id=${zone.id})`);

            io.to(`branch_${zone.branch_id}`).emit('geofence:zone_updated', zone);

            return res.json({ success: true, data: zone });
        } catch (error) {
            console.error('[Geofence] PUT error:', error.message);
            return res.status(500).json({ success: false, message: 'Error del servidor' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DELETE /api/geofence-zones/:id — Soft-delete zone
    // ═══════════════════════════════════════════════════════════════
    router.delete('/:id', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { id } = req.params;

            const result = await pool.query(
                `UPDATE geofence_zones
                 SET is_active = false, updated_at = NOW()
                 WHERE id = $1 AND tenant_id = $2 AND is_active = true
                 RETURNING id, branch_id, name`,
                [parseInt(id), tenantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Zona no encontrada' });
            }

            const zone = result.rows[0];
            console.log(`[Geofence] 🗑️ Zona eliminada: "${zone.name}" (id=${zone.id})`);

            io.to(`branch_${zone.branch_id}`).emit('geofence:zone_deleted', { id: zone.id });

            return res.json({ success: true, message: 'Zona eliminada' });
        } catch (error) {
            console.error('[Geofence] DELETE error:', error.message);
            return res.status(500).json({ success: false, message: 'Error del servidor' });
        }
    });

    return router;
};
