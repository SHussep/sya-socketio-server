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

    // Rate-limit cooldowns (in-memory)
    const _multiDeviceCooldowns = new Map(); // key: employeeId, value: timestamp
    const _gpsDisabledCooldowns = new Map(); // key: employeeId, value: timestamp

    // Geofence state tracker: key = "empId_zoneId", value = boolean (true = inside)
    const _employeeZoneState = new Map();
    // Geofence notification cooldown: key = "empId_zoneId", value = timestamp of last notification
    const _geofenceCooldowns = new Map();
    const GEOFENCE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between notifications per employee-zone
    // Hysteresis: exit requires distance > radius * EXIT_MULTIPLIER to prevent GPS jitter toggling
    const EXIT_HYSTERESIS_MULTIPLIER = 1.20; // 20% buffer beyond radius to trigger exit

    // Format distance: meters when < 1000m, km when >= 1000m
    function formatDistance(meters) {
        if (meters >= 1000) {
            return `${(meters / 1000).toFixed(1)}km`;
        }
        return `${Math.round(meters)}m`;
    }

    // Haversine distance in meters between two lat/lng points
    function haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const toRad = (x) => x * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                  Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Check if repartidor entered/exited any ASSIGNED geofence zone
    // Only checks zones explicitly assigned to the employee — no fallback
    async function checkGeofences(client, tenantId, branchId, empId, lat, lng) {
        try {
            // Only check zones assigned to this employee
            const zones = await client.query(
                `SELECT gz.id, gz.name, gz.latitude, gz.longitude, gz.radius_meters
                 FROM geofence_zones gz
                 JOIN employee_geofence_zones egz ON egz.zone_id = gz.id
                 WHERE egz.employee_id = $1 AND egz.tenant_id = $2
                   AND egz.is_active = true AND gz.is_active = true`,
                [empId, tenantId]
            );

            // No assigned zones = no monitoring
            if (zones.rows.length === 0) return;

            let empName = null;
            let empGlobalId = null;
            let branchName = null;

            for (const zone of zones.rows) {
                const distance = haversineDistance(lat, lng, zone.latitude, zone.longitude);
                const stateKey = `${empId}_${zone.id}`;
                const wasInside = _employeeZoneState.get(stateKey) || false;

                // Hysteresis: enter at radius, exit at radius * 1.20
                // This prevents GPS jitter from causing rapid enter/exit toggling
                const isInside = wasInside
                    ? distance <= zone.radius_meters * EXIT_HYSTERESIS_MULTIPLIER  // already inside: stay inside until clearly out
                    : distance <= zone.radius_meters;                                // outside: enter only when clearly inside

                if (isInside !== wasInside) {
                    // Check cooldown: prevent spam notifications
                    const now = Date.now();
                    const lastNotification = _geofenceCooldowns.get(stateKey) || 0;
                    if (now - lastNotification < GEOFENCE_COOLDOWN_MS) {
                        // Update state silently (track position) but don't notify
                        _employeeZoneState.set(stateKey, isInside);
                        continue;
                    }

                    _employeeZoneState.set(stateKey, isInside);
                    _geofenceCooldowns.set(stateKey, now);
                    const eventType = isInside ? 'enter' : 'exit';

                    if (!empName) {
                        const empInfo = await client.query(
                            `SELECT COALESCE(first_name || ' ' || last_name, username) AS name, global_id FROM employees WHERE id = $1`,
                            [empId]
                        );
                        empName = empInfo.rows[0]?.name || 'Repartidor';
                        empGlobalId = empInfo.rows[0]?.global_id;
                    }

                    // Log event
                    await client.query(
                        `INSERT INTO geofence_events (tenant_id, zone_id, employee_id, branch_id, event_type, latitude, longitude, distance_meters)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                        [tenantId, zone.id, empId, branchId, eventType, lat, lng, Math.round(distance)]
                    );

                    // Emit socket event
                    io.to(`branch_${branchId}`).emit(`geofence:${eventType}`, {
                        employeeId: empId,
                        employeeName: empName,
                        zoneId: zone.id,
                        zoneName: zone.name,
                        branchId,
                        distance: Math.round(distance),
                        timestamp: new Date().toISOString()
                    });

                    console.log(`[GPS/geofence] ${isInside ? '🟢 ENTER' : '🔴 EXIT'}: ${empName} → "${zone.name}" (${formatDistance(distance)}, radio=${formatDistance(zone.radius_meters)})`);

                    // FCM push notification to admins
                    if (notifyGeofenceEvent) {
                        if (!branchName) {
                            const branchInfo = await client.query('SELECT name FROM branches WHERE id = $1', [branchId]);
                            branchName = branchInfo.rows[0]?.name || '';
                        }
                        notifyGeofenceEvent(tenantId, branchId, {
                            employeeId: empId, employeeName: empName,
                            zoneId: zone.id, zoneName: zone.name,
                            branchName, eventType, distance: Math.round(distance)
                        }).catch(err => console.error('[GPS/geofence] FCM admin error:', err.message));
                    }

                    // FCM push notification to the repartidor themselves
                    if (sendNotificationToEmployee && empGlobalId) {
                        const emoji = isInside ? '📍' : '📤';
                        const action = isInside ? 'Entraste a' : 'Saliste de';
                        sendNotificationToEmployee(empGlobalId, {
                            title: `${emoji} ${zone.name}`,
                            body: `${action} la zona "${zone.name}" (${formatDistance(distance)})`,
                            data: {
                                type: 'geofence_event_self',
                                eventType,
                                zoneId: String(zone.id),
                                zoneName: zone.name,
                                distance: String(Math.round(distance))
                            }
                        }).catch(err => console.error('[GPS/geofence] FCM repartidor error:', err.message));
                    }
                }
            }
        } catch (err) {
            console.error(`[GPS/geofence] Error: ${err.message}`);
        }
    }
    const MULTI_DEVICE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
    const GPS_DISABLED_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

    // Import notification helper (lazy — may not be available in all setups)
    let sendNotificationToAdminsInTenant;
    let notifyGeofenceEvent;
    let sendNotificationToEmployee;
    try {
        const notificationHelper = require('../utils/notificationHelper');
        sendNotificationToAdminsInTenant = notificationHelper.sendNotificationToAdminsInTenant;
        notifyGeofenceEvent = notificationHelper.notifyGeofenceEvent;
        sendNotificationToEmployee = notificationHelper.sendNotificationToEmployee;
    } catch (e) {
        console.warn('[GPS] ⚠️ notificationHelper not available, FCM disabled');
    }

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
                recorded_at,
                device_id
            } = req.body;

            if (!branch_id || latitude === undefined || longitude === undefined) {
                return res.status(400).json({
                    success: false,
                    message: 'branch_id, latitude, longitude son requeridos'
                });
            }

            // Validate speed: cap at 50 m/s (~180 km/h) — reject GPS anomalies
            if (speed !== undefined && speed !== null && (speed < 0 || speed > 50)) {
                return res.status(400).json({
                    success: false,
                    message: `Velocidad fuera de rango: ${speed} m/s (max 50 m/s)`
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
                    (tenant_id, branch_id, employee_id, shift_id, latitude, longitude, accuracy, speed, heading, recorded_at, device_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 RETURNING id, received_at`,
                [tenantId, branch_id, empId, shift_id ?? null, latitude, longitude,
                 accuracy ?? null, speed ?? null, heading ?? null,
                 recorded_at ?? new Date().toISOString(), device_id ?? null]
            );

            console.log(`[GPS/location] ✅ Stored: employee=${empId}, branch=${branch_id}, tenant=${tenantId}, device=${device_id || 'none'}`);

            // Multi-device anomaly detection
            if (device_id) {
                try {
                    const otherDevices = await client.query(
                        `SELECT DISTINCT device_id FROM repartidor_locations
                         WHERE employee_id = $1 AND device_id IS NOT NULL AND device_id != $2
                           AND received_at >= NOW() - INTERVAL '2 minutes'`,
                        [empId, device_id]
                    );
                    if (otherDevices.rows.length > 0) {
                        const cooldownKey = `${empId}`;
                        const lastAlerted = _multiDeviceCooldowns.get(cooldownKey);
                        if (!lastAlerted || Date.now() - lastAlerted > MULTI_DEVICE_COOLDOWN_MS) {
                            _multiDeviceCooldowns.set(cooldownKey, Date.now());

                            // Lookup employee name
                            const empInfo = await client.query(
                                `SELECT COALESCE(first_name || ' ' || last_name, username) AS name FROM employees WHERE id = $1`,
                                [empId]
                            );
                            const empName = empInfo.rows[0]?.name || 'Repartidor';

                            io.to(`branch_${branch_id}`).emit('repartidor:multi_device_alert', {
                                employeeId: empId,
                                branchId: branch_id,
                                employeeName: empName,
                                deviceIds: [device_id, ...otherDevices.rows.map(r => r.device_id)],
                                timestamp: new Date().toISOString()
                            });

                            if (sendNotificationToAdminsInTenant) {
                                sendNotificationToAdminsInTenant(tenantId, {
                                    title: '⚠️ Alerta: Múltiples Dispositivos',
                                    body: `${empName} está enviando ubicación desde ${otherDevices.rows.length + 1} dispositivos`,
                                    data: { type: 'multi_device_alert', employeeId: String(empId), branchId: String(branch_id) }
                                }).catch(err => console.error('[GPS] Multi-device FCM error:', err.message));
                            }
                            console.log(`[GPS] ⚠️ Multi-device alert: employee ${empId} using ${otherDevices.rows.length + 1} devices`);
                        }
                    }
                } catch (detectErr) {
                    console.error(`[GPS] Multi-device check error: ${detectErr.message}`);
                }
            }

            // Emit to branch room for admin real-time map
            io.to(`branch_${branch_id}`).emit('repartidor:location_update', {
                employeeId: empId,
                branchId: branch_id,
                latitude,
                longitude,
                accuracy: accuracy ?? null,
                speed: speed ?? null,
                shiftId: shift_id ?? null,
                deviceId: device_id ?? null,
                recordedAt: recorded_at ?? new Date().toISOString()
            });

            // Check geofence zones (non-blocking — doesn't delay response)
            checkGeofences(client, tenantId, branch_id, empId, latitude, longitude);

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
            const { employee_id, employee_global_id, branch_id, shift_id, device_id, locations } = req.body;

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

            // Build batch INSERT with parameterized values (now 11 columns)
            const values = [];
            const placeholders = [];
            let paramIdx = 1;

            for (const loc of locations) {
                placeholders.push(
                    `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7}, $${paramIdx + 8}, $${paramIdx + 9}, $${paramIdx + 10})`
                );
                values.push(
                    tenantId, branch_id, empId, shift_id ?? null,
                    loc.latitude, loc.longitude,
                    loc.accuracy ?? null, loc.speed ?? null, loc.heading ?? null,
                    loc.recorded_at ?? new Date().toISOString(),
                    device_id ?? null
                );
                paramIdx += 11;
            }

            await client.query(
                `INSERT INTO repartidor_locations
                    (tenant_id, branch_id, employee_id, shift_id, latitude, longitude, accuracy, speed, heading, recorded_at, device_id)
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
                accuracy: latest.accuracy ?? null,
                speed: latest.speed ?? null,
                shiftId: shift_id ?? null,
                deviceId: device_id ?? null,
                recordedAt: latest.recorded_at ?? new Date().toISOString()
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
            const { tenantId } = req.user;
            const { branch_id } = req.query;
            const targetBranch = branch_id ? parseInt(branch_id) : null;

            let result;
            if (targetBranch) {
                // Filter by specific branch
                console.log(`[GPS/active] Query: tenantId=${tenantId}, branch_id=${targetBranch}`);
                result = await pool.query(
                    `SELECT DISTINCT ON (rl.employee_id)
                        rl.employee_id,
                        COALESCE(e.first_name || ' ' || e.last_name, e.username) AS employee_name,
                        rl.latitude,
                        rl.longitude,
                        rl.accuracy,
                        rl.speed,
                        rl.heading,
                        rl.shift_id,
                        rl.device_id,
                        rl.recorded_at,
                        rl.received_at,
                        COALESCE(s.is_cash_cut_open, false) AS is_shift_open
                     FROM repartidor_locations rl
                     JOIN employees e ON e.id = rl.employee_id
                     LEFT JOIN shifts s ON s.id = rl.shift_id
                     WHERE rl.tenant_id = $1
                       AND rl.branch_id = $2
                       AND rl.received_at >= NOW() - INTERVAL '1 hour'
                     ORDER BY rl.employee_id, rl.received_at DESC`,
                    [tenantId, targetBranch]
                );
            } else {
                // No branch filter: show ALL repartidores in tenant
                console.log(`[GPS/active] Query: tenantId=${tenantId}, all branches`);
                result = await pool.query(
                    `SELECT DISTINCT ON (rl.employee_id)
                        rl.employee_id,
                        COALESCE(e.first_name || ' ' || e.last_name, e.username) AS employee_name,
                        rl.latitude,
                        rl.longitude,
                        rl.accuracy,
                        rl.speed,
                        rl.heading,
                        rl.shift_id,
                        rl.device_id,
                        rl.recorded_at,
                        rl.received_at,
                        rl.branch_id,
                        COALESCE(s.is_cash_cut_open, false) AS is_shift_open
                     FROM repartidor_locations rl
                     JOIN employees e ON e.id = rl.employee_id
                     LEFT JOIN shifts s ON s.id = rl.shift_id
                     WHERE rl.tenant_id = $1
                       AND rl.received_at >= NOW() - INTERVAL '1 hour'
                     ORDER BY rl.employee_id, rl.received_at DESC`,
                    [tenantId]
                );
            }

            console.log(`[GPS/active] Found ${result.rows.length} active repartidores${targetBranch ? ` for branch ${targetBranch}` : ' (all branches)'}`);
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
                       shift_id, device_id, recorded_at, received_at
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
    // GET /api/gps/shift-summary/:employeeId — Aggregated shift stats
    // Returns distance, time, speed stats computed server-side
    // ═══════════════════════════════════════════════════════════════
    router.get('/shift-summary/:employeeId', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { employeeId } = req.params;
            const { date, shift_id } = req.query;

            const targetDate = date || new Date().toISOString().split('T')[0];

            // Build WHERE clause: filter by shift_id if provided, otherwise by date
            let whereClause = `tenant_id = $1 AND employee_id = $2`;
            const params = [tenantId, employeeId];

            if (shift_id) {
                whereClause += ` AND shift_id = $${params.length + 1}`;
                params.push(shift_id);
            } else {
                whereClause += ` AND recorded_at >= $${params.length + 1}::date AND recorded_at < ($${params.length + 1}::date + INTERVAL '1 day')`;
                params.push(targetDate);
            }

            // Single query: aggregates + Haversine distance via window functions
            // GPS drift filtering:
            //   1. Exclude points with accuracy > 50m (unreliable GPS fix)
            //   2. Only sum segments where device is moving (speed >= 0.5 m/s)
            //   3. Exclude segments < 0.05km (50m) as GPS noise
            const result = await pool.query(`
                WITH points AS (
                    SELECT latitude, longitude, speed, accuracy, recorded_at,
                           LAG(latitude) OVER (ORDER BY recorded_at) AS prev_lat,
                           LAG(longitude) OVER (ORDER BY recorded_at) AS prev_lon,
                           LAG(recorded_at) OVER (ORDER BY recorded_at) AS prev_at
                    FROM repartidor_locations
                    WHERE ${whereClause}
                      AND (accuracy IS NULL OR accuracy <= 50)
                ),
                segments AS (
                    SELECT *,
                        CASE WHEN prev_lat IS NOT NULL THEN
                            6371 * 2 * ASIN(SQRT(
                                POWER(SIN(RADIANS(latitude - prev_lat) / 2), 2) +
                                COS(RADIANS(prev_lat)) * COS(RADIANS(latitude)) *
                                POWER(SIN(RADIANS(longitude - prev_lon) / 2), 2)
                            ))
                        ELSE 0 END AS segment_km,
                        CASE WHEN prev_at IS NOT NULL THEN
                            EXTRACT(EPOCH FROM (recorded_at - prev_at)) / 60.0
                        ELSE 0 END AS segment_minutes,
                        CASE WHEN speed IS NULL OR speed < 0.5 THEN true ELSE false END AS is_stopped
                    FROM points
                )
                SELECT
                    COUNT(*)::int AS total_points,
                    MIN(recorded_at) AS first_seen,
                    MAX(recorded_at) AS last_seen,
                    ROUND(EXTRACT(EPOCH FROM (MAX(recorded_at) - MIN(recorded_at))) / 60.0) AS active_minutes,
                    ROUND(COALESCE(SUM(CASE WHEN is_stopped AND segment_minutes < 10 THEN segment_minutes ELSE 0 END), 0)) AS stopped_minutes,
                    ROUND(COALESCE(SUM(CASE WHEN NOT is_stopped AND segment_km >= 0.05 THEN segment_km ELSE 0 END), 0)::numeric, 2) AS distance_km,
                    ROUND(COALESCE(AVG(CASE WHEN speed IS NOT NULL AND speed >= 0.5 THEN speed * 3.6 END), 0)::numeric, 1) AS avg_speed_kmh,
                    ROUND(COALESCE(MAX(CASE WHEN speed IS NOT NULL THEN speed * 3.6 END), 0)::numeric, 1) AS max_speed_kmh
                FROM segments
            `, params);

            const row = result.rows[0];
            const activeMin = parseInt(row.active_minutes) || 0;
            const stoppedMin = parseInt(row.stopped_minutes) || 0;

            return res.json({
                success: true,
                data: {
                    total_points: row.total_points || 0,
                    first_seen: row.first_seen,
                    last_seen: row.last_seen,
                    active_minutes: activeMin,
                    stopped_minutes: stoppedMin,
                    moving_minutes: Math.max(0, activeMin - stoppedMin),
                    distance_km: parseFloat(row.distance_km) || 0,
                    avg_speed_kmh: parseFloat(row.avg_speed_kmh) || 0,
                    max_speed_kmh: parseFloat(row.max_speed_kmh) || 0,
                }
            });

        } catch (error) {
            console.error(`[GPS/shift-summary] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/gps/tracking-disabled — Repartidor GPS was disabled
    // Sends FCM alert to admins in branch
    // ═══════════════════════════════════════════════════════════════
    router.post('/tracking-disabled', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { employee_id, branch_id, shift_id, device_id, reason } = req.body;

            if (!employee_id || !branch_id) {
                return res.status(400).json({
                    success: false,
                    message: 'employee_id y branch_id son requeridos'
                });
            }

            // Rate limit: 1 notification per employee per 5 minutes
            const cooldownKey = `${employee_id}`;
            const lastNotified = _gpsDisabledCooldowns.get(cooldownKey);
            if (lastNotified && Date.now() - lastNotified < GPS_DISABLED_COOLDOWN_MS) {
                return res.json({ success: true, throttled: true });
            }
            _gpsDisabledCooldowns.set(cooldownKey, Date.now());

            // Look up employee name + branch name
            const empResult = await pool.query(
                `SELECT COALESCE(e.first_name || ' ' || e.last_name, e.username) AS employee_name,
                        b.name AS branch_name
                 FROM employees e
                 LEFT JOIN branches b ON b.id = $3
                 WHERE e.id = $1 AND e.tenant_id = $2`,
                [employee_id, tenantId, branch_id]
            );
            const employeeName = empResult.rows[0]?.employee_name || 'Repartidor';
            const branchName = empResult.rows[0]?.branch_name || '';

            // Emit socket event to branch room (UI update)
            io.to(`branch_${branch_id}`).emit('repartidor:tracking_disabled', {
                employeeId: employee_id,
                branchId: branch_id,
                shiftId: shift_id || null,
                deviceId: device_id || null,
                employeeName,
                reason: reason || 'GPS desactivado',
                timestamp: new Date().toISOString()
            });

            // Send FCM to ALL admins in tenant (not branch-scoped)
            if (sendNotificationToAdminsInTenant) {
                const branchTag = branchName ? ` [${branchName}]` : '';
                sendNotificationToAdminsInTenant(tenantId, {
                    title: `GPS Inactivo${branchTag}`,
                    body: `${employeeName} sin señal GPS por más de 5 minutos`,
                    data: {
                        type: 'gps_tracking_disabled',
                        employeeId: String(employee_id),
                        employeeName,
                        branchId: String(branch_id),
                        shiftId: String(shift_id || '')
                    }
                }).catch(err => console.error('[GPS/tracking-disabled] FCM error:', err.message));
            }

            console.log(`[GPS] ⚠️ Tracking disabled: ${employeeName} (employee=${employee_id}, branch=${branch_id})`);
            return res.json({ success: true });

        } catch (error) {
            console.error(`[GPS/tracking-disabled] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/gps/break-start — Repartidor begins break
    // Pauses GPS tracking, notifies admins via FCM + socket
    // ═══════════════════════════════════════════════════════════════
    const _breakCooldowns = new Map();
    const BREAK_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

    router.post('/break-start', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { employee_id, branch_id, shift_id, device_id } = req.body;

            if (!employee_id || !branch_id) {
                return res.status(400).json({ success: false, message: 'employee_id y branch_id son requeridos' });
            }

            const cooldownKey = `break_start_${employee_id}`;
            const lastAction = _breakCooldowns.get(cooldownKey);
            if (lastAction && Date.now() - lastAction < BREAK_COOLDOWN_MS) {
                return res.json({ success: true, throttled: true });
            }
            _breakCooldowns.set(cooldownKey, Date.now());

            // Look up employee name + branch name
            const empResult = await pool.query(
                `SELECT COALESCE(e.first_name || ' ' || e.last_name, e.username) AS employee_name,
                        b.name AS branch_name
                 FROM employees e
                 LEFT JOIN branches b ON b.id = $3
                 WHERE e.id = $1 AND e.tenant_id = $2`,
                [employee_id, tenantId, branch_id]
            );
            const employeeName = empResult.rows[0]?.employee_name || 'Repartidor';
            const branchName = empResult.rows[0]?.branch_name || '';

            // Socket event to branch room (UI update)
            io.to(`branch_${branch_id}`).emit('repartidor:break_started', {
                employeeId: employee_id,
                branchId: branch_id,
                shiftId: shift_id || null,
                deviceId: device_id || null,
                employeeName,
                timestamp: new Date().toISOString()
            });

            // FCM to ALL admins in tenant
            if (sendNotificationToAdminsInTenant) {
                const branchTag = branchName ? ` [${branchName}]` : '';
                console.log(`[GPS/break-start] Sending FCM to admins in tenant ${tenantId}...`);
                sendNotificationToAdminsInTenant(tenantId, {
                    title: `Descanso Iniciado${branchTag}`,
                    body: `${employeeName} comenzó su descanso`,
                    data: { type: 'break_started', employeeId: String(employee_id), employeeName, branchId: String(branch_id) }
                }).then(result => {
                    console.log(`[GPS/break-start] FCM result: sent=${result.sent}, failed=${result.failed}, total=${result.total || 0}`);
                }).catch(err => console.error('[GPS/break-start] FCM error:', err.message));
            } else {
                console.warn('[GPS/break-start] sendNotificationToAdminsInTenant is NOT available');
            }

            console.log(`[GPS] 🍵 Break started: ${employeeName} (employee=${employee_id}, branch=${branch_id})`);
            return res.json({ success: true });

        } catch (error) {
            console.error(`[GPS/break-start] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/gps/break-end — Repartidor ends break
    // Resumes GPS tracking, notifies admins via FCM + socket
    // ═══════════════════════════════════════════════════════════════
    router.post('/break-end', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { employee_id, branch_id, shift_id, device_id } = req.body;

            if (!employee_id || !branch_id) {
                return res.status(400).json({ success: false, message: 'employee_id y branch_id son requeridos' });
            }

            const cooldownKey = `break_end_${employee_id}`;
            const lastAction = _breakCooldowns.get(cooldownKey);
            if (lastAction && Date.now() - lastAction < BREAK_COOLDOWN_MS) {
                return res.json({ success: true, throttled: true });
            }
            _breakCooldowns.set(cooldownKey, Date.now());

            // Look up employee name + branch name
            const empResult = await pool.query(
                `SELECT COALESCE(e.first_name || ' ' || e.last_name, e.username) AS employee_name,
                        b.name AS branch_name
                 FROM employees e
                 LEFT JOIN branches b ON b.id = $3
                 WHERE e.id = $1 AND e.tenant_id = $2`,
                [employee_id, tenantId, branch_id]
            );
            const employeeName = empResult.rows[0]?.employee_name || 'Repartidor';
            const branchName = empResult.rows[0]?.branch_name || '';

            // Socket event to branch room (UI update)
            io.to(`branch_${branch_id}`).emit('repartidor:break_ended', {
                employeeId: employee_id,
                branchId: branch_id,
                shiftId: shift_id || null,
                deviceId: device_id || null,
                employeeName,
                timestamp: new Date().toISOString()
            });

            // FCM to ALL admins in tenant
            if (sendNotificationToAdminsInTenant) {
                const branchTag = branchName ? ` [${branchName}]` : '';
                console.log(`[GPS/break-end] Sending FCM to admins in tenant ${tenantId}...`);
                sendNotificationToAdminsInTenant(tenantId, {
                    title: `Descanso Terminado${branchTag}`,
                    body: `${employeeName} terminó su descanso`,
                    data: { type: 'break_ended', employeeId: String(employee_id), employeeName, branchId: String(branch_id) }
                }).then(result => {
                    console.log(`[GPS/break-end] FCM result: sent=${result.sent}, failed=${result.failed}, total=${result.total || 0}`);
                }).catch(err => console.error('[GPS/break-end] FCM error:', err.message));
            } else {
                console.warn('[GPS/break-end] sendNotificationToAdminsInTenant is NOT available');
            }

            console.log(`[GPS] ✅ Break ended: ${employeeName} (employee=${employee_id}, branch=${branch_id})`);
            return res.json({ success: true });

        } catch (error) {
            console.error(`[GPS/break-end] ❌ Error: ${error.message}`);
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
