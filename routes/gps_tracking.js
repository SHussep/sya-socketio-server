// routes/gps_tracking.js
// GPS Tracking for Repartidores — Real-time location + LFPDPPP consent
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('[SECURITY] ❌ JWT_SECRET no está configurado en el entorno');
}

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
    // POST /api/gps/location — Repartidor sends current location
    // ═══════════════════════════════════════════════════════════════
    router.post('/location', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const { tenantId } = req.user;
            const {
                employee_id,
                employee_global_id,
                branch_id,
                shift_id,
                latitude,
                longitude,
                accuracy,
                speed,
                heading,
                recorded_at
            } = req.body;

            if (!branch_id || latitude === undefined || longitude === undefined) {
                return res.status(400).json({
                    success: false,
                    message: 'branch_id, latitude, longitude son requeridos'
                });
            }

            // Resolve employee ID
            let empId = employee_id;
            if (!empId && employee_global_id) {
                const lookup = await client.query(
                    `SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2`,
                    [employee_global_id, tenantId]
                );
                if (lookup.rows.length > 0) empId = lookup.rows[0].id;
            }
            if (!empId) {
                return res.status(400).json({ success: false, message: 'employee_id o employee_global_id requerido' });
            }

            const result = await client.query(
                `INSERT INTO repartidor_locations
                    (tenant_id, branch_id, employee_id, shift_id, latitude, longitude, accuracy, speed, heading, recorded_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING id, received_at`,
                [tenantId, branch_id, empId, shift_id || null, latitude, longitude,
                 accuracy || null, speed || null, heading || null,
                 recorded_at || new Date().toISOString()]
            );

            // Emit to branch room for admin real-time map
            io.to(`branch_${branch_id}`).emit('repartidor:location_update', {
                employeeId: empId,
                branchId: branch_id,
                latitude,
                longitude,
                accuracy: accuracy || null,
                speed: speed || null,
                shiftId: shift_id || null,
                recordedAt: recorded_at || new Date().toISOString()
            });

            return res.status(201).json({
                success: true,
                data: { id: result.rows[0].id, received_at: result.rows[0].received_at }
            });

        } catch (error) {
            console.error(`[GPS/location] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/gps/batch-location — Batch upload (reconnection buffer)
    // Accepts up to 100 points at once
    // ═══════════════════════════════════════════════════════════════
    router.post('/batch-location', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const { tenantId } = req.user;
            const { employee_id, employee_global_id, branch_id, shift_id, locations } = req.body;

            if (!branch_id || !Array.isArray(locations) || locations.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'branch_id y locations[] son requeridos'
                });
            }

            if (locations.length > 100) {
                return res.status(400).json({
                    success: false,
                    message: 'Máximo 100 ubicaciones por lote'
                });
            }

            // Resolve employee ID
            let empId = employee_id;
            if (!empId && employee_global_id) {
                const lookup = await client.query(
                    `SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2`,
                    [employee_global_id, tenantId]
                );
                if (lookup.rows.length > 0) empId = lookup.rows[0].id;
            }
            if (!empId) {
                return res.status(400).json({ success: false, message: 'employee_id o employee_global_id requerido' });
            }

            await client.query('BEGIN');

            // Build batch INSERT with parameterized values
            const values = [];
            const placeholders = [];
            let paramIdx = 1;

            for (const loc of locations) {
                placeholders.push(
                    `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, $${paramIdx + 9})`
                );
                values.push(
                    tenantId, branch_id, empId, shift_id || null,
                    loc.latitude, loc.longitude,
                    loc.accuracy || null, loc.speed || null, loc.heading || null,
                    loc.recorded_at || new Date().toISOString()
                );
                paramIdx += 10;
            }

            const insertedCount = await client.query(
                `INSERT INTO repartidor_locations
                    (tenant_id, branch_id, employee_id, shift_id, latitude, longitude, accuracy, speed, heading, recorded_at)
                 VALUES ${placeholders.join(', ')}`,
                values
            );

            await client.query('COMMIT');

            // Emit latest location to branch room
            const latest = locations[locations.length - 1];
            io.to(`branch_${branch_id}`).emit('repartidor:location_update', {
                employeeId: empId,
                branchId: branch_id,
                latitude: latest.latitude,
                longitude: latest.longitude,
                accuracy: latest.accuracy || null,
                speed: latest.speed || null,
                shiftId: shift_id || null,
                recordedAt: latest.recorded_at || new Date().toISOString()
            });

            return res.status(201).json({
                success: true,
                data: { inserted: locations.length }
            });

        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error(`[GPS/batch] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/gps/active-locations — Latest location per active repartidor
    // Used by admin dashboard map
    // ═══════════════════════════════════════════════════════════════
    router.get('/active-locations', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { branch_id } = req.query;
            const targetBranch = branch_id || userBranchId;

            const result = await pool.query(
                `SELECT DISTINCT ON (rl.employee_id)
                    rl.employee_id,
                    e.name AS employee_name,
                    rl.latitude,
                    rl.longitude,
                    rl.accuracy,
                    rl.speed,
                    rl.heading,
                    rl.shift_id,
                    rl.recorded_at,
                    rl.received_at
                 FROM repartidor_locations rl
                 JOIN employees e ON e.id = rl.employee_id
                 WHERE rl.tenant_id = $1
                   AND rl.branch_id = $2
                   AND rl.received_at >= NOW() - INTERVAL '1 hour'
                 ORDER BY rl.employee_id, rl.received_at DESC`,
                [tenantId, targetBranch]
            );

            return res.json({ success: true, data: result.rows });

        } catch (error) {
            console.error(`[GPS/active] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/gps/location-history/:employeeId — Route history by date
    // ═══════════════════════════════════════════════════════════════
    router.get('/location-history/:employeeId', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { employeeId } = req.params;
            const { date, shift_id } = req.query;

            // Default to today
            const targetDate = date || new Date().toISOString().split('T')[0];

            let query = `
                SELECT id, latitude, longitude, accuracy, speed, heading,
                       shift_id, recorded_at, received_at
                FROM repartidor_locations
                WHERE tenant_id = $1
                  AND employee_id = $2
                  AND recorded_at >= $3::date
                  AND recorded_at < ($3::date + INTERVAL '1 day')`;
            const params = [tenantId, employeeId, targetDate];

            if (shift_id) {
                query += ` AND shift_id = $4`;
                params.push(shift_id);
            }

            query += ` ORDER BY recorded_at ASC`;

            const result = await pool.query(query, params);

            return res.json({ success: true, data: result.rows });

        } catch (error) {
            console.error(`[GPS/history] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/gps/consent — Register GPS consent (LFPDPPP)
    // ═══════════════════════════════════════════════════════════════
    router.post('/consent', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { employee_id, employee_global_id, consented, device_info } = req.body;

            // Resolve employee ID
            let empId = employee_id;
            if (!empId && employee_global_id) {
                const lookup = await pool.query(
                    `SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2`,
                    [employee_global_id, tenantId]
                );
                if (lookup.rows.length > 0) empId = lookup.rows[0].id;
            }
            if (!empId) {
                return res.status(400).json({ success: false, message: 'employee_id o employee_global_id requerido' });
            }

            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

            const result = await pool.query(
                `INSERT INTO gps_consent_log (tenant_id, employee_id, consented, consented_at, device_info, ip_address)
                 VALUES ($1, $2, $3, NOW(), $4, $5)
                 ON CONFLICT (tenant_id, employee_id)
                 DO UPDATE SET
                    consented = EXCLUDED.consented,
                    consented_at = CASE WHEN EXCLUDED.consented = true THEN NOW() ELSE gps_consent_log.consented_at END,
                    revoked_at = CASE WHEN EXCLUDED.consented = false THEN NOW() ELSE NULL END,
                    device_info = EXCLUDED.device_info,
                    ip_address = EXCLUDED.ip_address,
                    updated_at = NOW()
                 RETURNING id, consented, consented_at, revoked_at`,
                [tenantId, empId, consented, device_info || null, ip]
            );

            return res.json({ success: true, data: result.rows[0] });

        } catch (error) {
            console.error(`[GPS/consent] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/gps/consent/:employeeId — Check consent status
    // ═══════════════════════════════════════════════════════════════
    router.get('/consent/:employeeId', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { employeeId } = req.params;

            const result = await pool.query(
                `SELECT consented, consented_at, revoked_at, device_info, updated_at
                 FROM gps_consent_log
                 WHERE tenant_id = $1 AND employee_id = $2`,
                [tenantId, employeeId]
            );

            if (result.rows.length === 0) {
                return res.json({ success: true, data: { consented: false, never_asked: true } });
            }

            return res.json({ success: true, data: result.rows[0] });

        } catch (error) {
            console.error(`[GPS/consent-check] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    return router;
};
