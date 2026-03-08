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
            const { branch_id, employee_id, zone_id, date, start_date, end_date, limit = 100 } = req.query;

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
            if (start_date && end_date) {
                query += ` AND ge.created_at >= $${paramIdx}::date AND ge.created_at < ($${paramIdx + 1}::date + INTERVAL '1 day')`;
                params.push(start_date, end_date);
                paramIdx += 2;
            } else if (date) {
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

    // ═══════════════════════════════════════════════════════════════
    // GET /api/geofence-zones/by-employee/:employeeId — Assigned zones for a repartidor
    // ═══════════════════════════════════════════════════════════════
    router.get('/by-employee/:employeeId', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { employeeId } = req.params;

            const result = await pool.query(
                `SELECT gz.id, gz.branch_id, gz.name, gz.latitude, gz.longitude,
                        gz.radius_meters, gz.color, gz.is_active, gz.created_at, gz.updated_at
                 FROM geofence_zones gz
                 JOIN employee_geofence_zones egz ON egz.zone_id = gz.id
                 WHERE egz.employee_id = $1 AND egz.tenant_id = $2
                   AND egz.is_active = true AND gz.is_active = true
                 ORDER BY gz.name`,
                [parseInt(employeeId), tenantId]
            );

            return res.json({ success: true, data: result.rows });
        } catch (error) {
            console.error('[Geofence] by-employee error:', error.message);
            return res.status(500).json({ success: false, message: 'Error del servidor' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/geofence-zones/:zoneId/assignments — Employees assigned to a zone
    // ═══════════════════════════════════════════════════════════════
    router.get('/:zoneId/assignments', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { zoneId } = req.params;

            const result = await pool.query(
                `SELECT egz.id, egz.employee_id, egz.created_at,
                        COALESCE(e.first_name || ' ' || e.last_name, e.username) AS employee_name,
                        e.global_id AS employee_global_id
                 FROM employee_geofence_zones egz
                 JOIN employees e ON e.id = egz.employee_id
                 WHERE egz.zone_id = $1 AND egz.tenant_id = $2 AND egz.is_active = true
                 ORDER BY employee_name`,
                [parseInt(zoneId), tenantId]
            );

            return res.json({ success: true, data: result.rows });
        } catch (error) {
            console.error('[Geofence] zone assignments error:', error.message);
            return res.status(500).json({ success: false, message: 'Error del servidor' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/geofence-zones/:zoneId/assignments — Assign employees to zone
    // ═══════════════════════════════════════════════════════════════
    router.post('/:zoneId/assignments', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const { tenantId } = req.user;
            const { zoneId } = req.params;
            const { employee_ids } = req.body;
            const assignedBy = req.user.employeeId || null;

            if (!Array.isArray(employee_ids) || employee_ids.length === 0) {
                return res.status(400).json({ success: false, message: 'employee_ids es requerido' });
            }

            // Verify zone exists and belongs to tenant
            const zone = await client.query(
                'SELECT id, branch_id, name FROM geofence_zones WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [parseInt(zoneId), tenantId]
            );
            if (zone.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Zona no encontrada' });
            }

            await client.query('BEGIN');

            const results = [];
            for (const empId of employee_ids) {
                const result = await client.query(
                    `INSERT INTO employee_geofence_zones (tenant_id, employee_id, zone_id, assigned_by_employee_id)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (employee_id, zone_id) WHERE is_active = true
                     DO NOTHING
                     RETURNING *`,
                    [tenantId, parseInt(empId), parseInt(zoneId), assignedBy]
                );
                if (result.rows.length > 0) results.push(result.rows[0]);
            }

            await client.query('COMMIT');

            console.log(`[Geofence] 👥 Asignados ${results.length} repartidores a zona "${zone.rows[0].name}"`);

            io.to(`branch_${zone.rows[0].branch_id}`).emit('geofence:assignments_changed', {
                zoneId: parseInt(zoneId),
                zoneName: zone.rows[0].name,
                action: 'assigned',
                employeeIds: employee_ids.map(id => parseInt(id)).filter(Boolean),
                timestamp: new Date().toISOString()
            });

            return res.status(201).json({ success: true, data: results });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('[Geofence] Assignment error:', error.message);
            return res.status(500).json({ success: false, message: 'Error del servidor' });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // DELETE /api/geofence-zones/:zoneId/assignments/:employeeId — Unassign
    // ═══════════════════════════════════════════════════════════════
    router.delete('/:zoneId/assignments/:employeeId', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { zoneId, employeeId } = req.params;

            const result = await pool.query(
                `UPDATE employee_geofence_zones
                 SET is_active = false, updated_at = NOW()
                 WHERE zone_id = $1 AND employee_id = $2 AND tenant_id = $3 AND is_active = true
                 RETURNING *`,
                [parseInt(zoneId), parseInt(employeeId), tenantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Asignación no encontrada' });
            }

            // Get zone info for socket emission
            const zone = await pool.query('SELECT branch_id, name FROM geofence_zones WHERE id = $1', [parseInt(zoneId)]);

            console.log(`[Geofence] 👤❌ Desasignado empleado ${employeeId} de zona "${zone.rows[0]?.name}"`);

            io.to(`branch_${zone.rows[0]?.branch_id}`).emit('geofence:assignments_changed', {
                zoneId: parseInt(zoneId),
                zoneName: zone.rows[0]?.name,
                action: 'unassigned',
                employeeIds: [parseInt(employeeId)],
                timestamp: new Date().toISOString()
            });

            return res.json({ success: true, message: 'Asignación eliminada' });
        } catch (error) {
            console.error('[Geofence] Unassign error:', error.message);
            return res.status(500).json({ success: false, message: 'Error del servidor' });
        }
    });

    return router;
};
