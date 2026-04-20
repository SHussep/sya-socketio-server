// ═══════════════════════════════════════════════════════════════
// RUTAS DE BRANCHES (SUCURSALES) - Endpoints inline de server.js
// GET/POST/PUT /api/branches/* + scale-status
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { createTenantValidationMiddleware } = require('../middleware/deviceAuth');

module.exports = (pool, io, scaleStatusByBranch) => {
    const router = express.Router();
    const validateTenant = createTenantValidationMiddleware(pool);

    // GET /api/branches - Obtener sucursales del tenant (autenticado)
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, employeeId } = req.user;

            // Obtener sucursales del empleado (a las que tiene acceso)
            const result = await pool.query(
                `SELECT b.id, b.branch_code as code, b.name, b.address, b.phone
                 FROM branches b
                 INNER JOIN employee_branches eb ON b.id = eb.branch_id
                 WHERE eb.employee_id = $1 AND b.tenant_id = $2 AND b.is_active = true
                 ORDER BY b.created_at ASC`,
                [employeeId, tenantId]
            );

            console.log(`[Branches] Sucursales para employee ${employeeId}: ${result.rows.length}`);

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('[Branches] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener sucursales' });
        }
    });

    // GET /api/branches/:branchId/desktop-online
    // Verifica si hay un cliente Desktop conectado al socket de esta sucursal
    router.get('/:branchId/desktop-online', authenticateToken, (req, res) => {
        const branchId = parseInt(req.params.branchId);
        if (!branchId) {
            return res.status(400).json({ success: false, message: 'branchId requerido' });
        }

        const roomName = `branch_${branchId}`;
        const roomSockets = io.sockets.adapter.rooms.get(roomName);

        let desktopOnline = false;
        if (roomSockets) {
            for (const socketId of roomSockets) {
                const s = io.sockets.sockets.get(socketId);
                // Fix B: requerir clientType='desktop' explícito, alineado con lo que se
                // broadcastea via 'desktop_status_changed'. Antes 'unknown' contaba como online,
                // desalineando REST vs socket.
                if (s && s.clientType === 'desktop') {
                    desktopOnline = true;
                    break;
                }
            }
        }

        res.json({ online: desktopOnline });
    });

    // POST /api/branches - Crear sucursal
    router.post('/', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const { tenantId } = req.user;
            const { name, address, phoneNumber, timezone } = req.body;

            if (!name) {
                return res.status(400).json({ success: false, message: 'name es requerido' });
            }

            await client.query('BEGIN');

            // Obtener tenant_code para generar branch_code
            const tenantResult = await client.query('SELECT tenant_code FROM tenants WHERE id = $1', [tenantId]);
            if (tenantResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, message: 'Tenant no encontrado' });
            }

            // Verificar licencia disponible (FOR UPDATE para evitar race conditions)
            const licenseResult = await client.query(`
                SELECT id FROM branch_licenses
                WHERE tenant_id = $1 AND status = 'available'
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE
            `, [tenantId]);

            if (licenseResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'No tienes licencias de sucursal disponibles. Contacta a soporte para agregar más sucursales.'
                });
            }

            const availableLicenseId = licenseResult.rows[0].id;

            // Contar sucursales existentes para código
            const countResult = await client.query(
                'SELECT COUNT(*) as count FROM branches WHERE tenant_id = $1',
                [tenantId]
            );
            const branchCount = parseInt(countResult.rows[0].count);
            const branchCode = `${tenantResult.rows[0].tenant_code}-BR${branchCount + 1}`;

            const result = await client.query(
                `INSERT INTO branches (tenant_id, branch_code, name, address, phone, timezone, is_active, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), NOW())
                 RETURNING *`,
                [tenantId, branchCode, name, address || null, phoneNumber || null, timezone || 'America/Mexico_City']
            );

            // Activar la licencia con el branch recién creado
            await client.query(`
                UPDATE branch_licenses
                SET branch_id = $1, status = 'active', activated_at = NOW(), updated_at = NOW()
                WHERE id = $2
            `, [result.rows[0].id, availableLicenseId]);

            await client.query('COMMIT');

            console.log(`[Branches] OK Sucursal creada: ${name} (Code: ${branchCode})`);
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Branches] Error:', error);
            res.status(500).json({ success: false, message: 'Error al crear sucursal' });
        } finally {
            client.release();
        }
    });

    // GET /api/branches/:id/settings - Obtener configuración de sucursal
    router.get('/:id/settings', authenticateToken, async (req, res) => {
        const { id } = req.params;
        const tenantId = req.user.tenantId;

        if (!tenantId) {
            return res.status(401).json({ success: false, message: 'Token no contiene tenantId' });
        }

        try {
            const result = await pool.query(`
                SELECT b.cajero_consolida_liquidaciones, b.max_breaks_per_shift, b.multi_caja_enabled,
                       b.use_pin_login,
                       COALESCE((s.features->>'multi_caja')::boolean, false) AS plan_allows_multi_caja
                FROM branches b
                JOIN tenants t ON t.id = b.tenant_id
                LEFT JOIN subscriptions s ON s.id = t.subscription_id AND s.is_active = true
                WHERE b.id = $1 AND b.tenant_id = $2
            `, [id, tenantId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Sucursal no encontrada' });
            }

            const row = result.rows[0];
            res.json({
                success: true,
                data: {
                    cajero_consolida_liquidaciones: row.cajero_consolida_liquidaciones ?? false,
                    max_breaks_per_shift: row.max_breaks_per_shift ?? 1,
                    multi_caja_enabled: row.multi_caja_enabled ?? false,
                    use_pin_login: row.use_pin_login ?? false,
                    plan_allows_multi_caja: row.plan_allows_multi_caja ?? false,
                }
            });
        } catch (error) {
            console.error('[Branch Settings] Error GET:', error);
            res.status(500).json({ success: false, message: 'Error al obtener configuración' });
        }
    });

    // PUT /api/branches/:id/settings - Actualizar configuración de sucursal
    router.put('/:id/settings', authenticateToken, async (req, res) => {
        const { id } = req.params;
        const tenantId = req.user.tenantId;
        const { cajero_consolida_liquidaciones, max_breaks_per_shift, multi_caja_enabled, use_pin_login } = req.body;

        console.log(`[Branch Settings] PUT /branches/${id}/settings - tenant=${tenantId}, body=${JSON.stringify(req.body)}`);

        if (!tenantId) {
            return res.status(401).json({ success: false, message: 'Token no contiene tenantId' });
        }

        try {
            // Guard: cannot disable multi-caja while shifts are open
            if (multi_caja_enabled === false) {
                const openShifts = await pool.query(`
                    SELECT id FROM shifts
                    WHERE branch_id = $1 AND end_time IS NULL
                    LIMIT 1
                `, [id]);
                if (openShifts.rows.length > 0) {
                    return res.status(409).json({
                        success: false,
                        message: 'No se puede desactivar multi-caja mientras hay turnos abiertos en esta sucursal'
                    });
                }
            }

            const result = await pool.query(`
                UPDATE branches
                SET cajero_consolida_liquidaciones = COALESCE($1, cajero_consolida_liquidaciones),
                    max_breaks_per_shift = COALESCE($2, max_breaks_per_shift),
                    multi_caja_enabled = COALESCE($3, multi_caja_enabled),
                    use_pin_login = COALESCE($4, use_pin_login),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $5 AND tenant_id = $6
                RETURNING id, cajero_consolida_liquidaciones, max_breaks_per_shift, multi_caja_enabled, use_pin_login
            `, [cajero_consolida_liquidaciones, max_breaks_per_shift, multi_caja_enabled, use_pin_login, id, tenantId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Sucursal no encontrada' });
            }

            const row = result.rows[0];
            console.log(`[Branch Settings] ✅ cajero_consolida=${row.cajero_consolida_liquidaciones}, max_breaks=${row.max_breaks_per_shift}, multi_caja=${row.multi_caja_enabled}, pin_login=${row.use_pin_login} para branch ${id}`);

            // Notificar via socket a todos los dispositivos de esta sucursal
            const roomName = `branch_${id}`;
            io.to(roomName).emit('branch_settings_changed', {
                branchId: parseInt(id),
                cajero_consolida_liquidaciones: row.cajero_consolida_liquidaciones,
                max_breaks_per_shift: row.max_breaks_per_shift,
                multi_caja_enabled: row.multi_caja_enabled,
                use_pin_login: row.use_pin_login,
                receivedAt: new Date().toISOString()
            });

            res.json({ success: true, data: row });
        } catch (error) {
            console.error('[Branch Settings] Error:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar configuración' });
        }
    });

    // PUT /api/branches/:id - Actualizar datos de sucursal
    router.put('/:id', validateTenant, async (req, res) => {
        try {
            const { id } = req.params;
            const { tenantId, name, address, phone, rfc } = req.body;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId es requerido en el payload'
                });
            }

            // Verificar que la sucursal pertenece al tenant
            const existing = await pool.query(
                'SELECT id FROM branches WHERE id = $1 AND tenant_id = $2',
                [id, tenantId]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada'
                });
            }

            const result = await pool.query(`
                UPDATE branches
                SET name = COALESCE($1, name),
                    address = COALESCE($2, address),
                    phone = COALESCE($3, phone),
                    rfc = COALESCE($4, rfc),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $5 AND tenant_id = $6
                RETURNING *
            `, [
                name,
                address,
                phone,
                rfc,
                id,
                tenantId
            ]);

            const branch = result.rows[0];

            console.log(`[Branch Update] ✅ Sucursal actualizada: ${branch.name} (RFC: ${branch.rfc || 'N/A'})`);

            // Notificar a dispositivos en esta sucursal
            io.to(`branch_${id}`).emit('branch_info_updated', {
                branchId: parseInt(id),
                tenantId: parseInt(tenantId),
                name: branch.name,
                address: branch.address,
                phone: branch.phone,
                rfc: branch.rfc,
                logoUrl: branch.logo_url,
                latitude: branch.latitude,
                longitude: branch.longitude,
                googleMapsUrl: branch.google_maps_url,
                updatedAt: branch.updated_at,
                receivedAt: new Date().toISOString()
            });
            console.log(`[Branch Update] 📡 Emitido branch_info_updated a branch_${id}`);

            res.json({
                success: true,
                message: 'Sucursal actualizada exitosamente',
                data: {
                    id: branch.id,
                    code: branch.branch_code,
                    name: branch.name,
                    address: branch.address,
                    phone: branch.phone,
                    rfc: branch.rfc,
                    timezone: branch.timezone,
                    isActive: branch.is_active,
                    updatedAt: branch.updated_at
                }
            });

        } catch (error) {
            console.error('[Branch Update] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar sucursal'
            });
        }
    });

    // GET /api/branches/:branchId/business-info - Obtener info del negocio para una sucursal
    router.get('/:branchId/business-info', authenticateToken, async (req, res) => {
        const { branchId } = req.params;
        const tenantId = req.user.tenantId;

        if (!tenantId || !branchId) {
            return res.status(400).json({ success: false, message: 'branchId es requerido' });
        }

        try {
            const result = await pool.query(
                'SELECT id, name, address, phone, rfc, logo_url, latitude, longitude, google_maps_url FROM branches WHERE id = $1 AND tenant_id = $2',
                [branchId, tenantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Sucursal no encontrada' });
            }

            const branch = result.rows[0];
            res.json({
                success: true,
                data: {
                    name: branch.name,
                    address: branch.address,
                    phone: branch.phone,
                    rfc: branch.rfc,
                    logo_url: branch.logo_url,
                    latitude: branch.latitude,
                    longitude: branch.longitude,
                    google_maps_url: branch.google_maps_url
                }
            });
        } catch (error) {
            console.error('[Branch Info] Error:', error);
            res.status(500).json({ success: false, message: 'Error del servidor' });
        }
    });

    // POST /api/branches/sync-info - Sincronizar info de sucursal desde Desktop
    router.post('/sync-info', validateTenant, async (req, res) => {
        const { tenantId, branchId, name, address, phone, rfc, logo_base64, existing_logo_url, latitude, longitude, google_maps_url } = req.body;
        const cloudinaryService = require('../services/cloudinaryService');

        console.log(`[Branch Sync] 📥 Recibida solicitud: tenantId=${tenantId}, branchId=${branchId}, name=${name}, hasLogo=${!!logo_base64}`);

        if (!tenantId || !branchId) {
            return res.status(400).json({
                success: false,
                message: 'tenantId y branchId son requeridos'
            });
        }

        try {
            // Verificar que la sucursal pertenece al tenant
            const existing = await pool.query(
                'SELECT id, name, logo_url FROM branches WHERE id = $1 AND tenant_id = $2',
                [branchId, tenantId]
            );

            if (existing.rows.length === 0) {
                console.log(`[Branch Sync] ❌ Sucursal no encontrada: branchId=${branchId}, tenantId=${tenantId}`);
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada para este tenant'
                });
            }

            const oldName = existing.rows[0].name;

            // Subir logo a Cloudinary si viene en base64
            let logoUrl = existing.rows[0].logo_url || existing_logo_url || null;
            if (logo_base64) {
                try {
                    if (cloudinaryService.isConfigured()) {
                        console.log(`[Branch Sync] 📤 Subiendo logo a Cloudinary...`);
                        const uploadResult = await cloudinaryService.uploadBusinessLogo(logo_base64, {
                            tenantId,
                            branchId,
                        });
                        logoUrl = uploadResult.url;
                        console.log(`[Branch Sync] ✅ Logo subido: ${logoUrl}`);
                    } else {
                        console.log(`[Branch Sync] ⚠️ Cloudinary no configurado, logo no subido`);
                    }
                } catch (logoError) {
                    console.error(`[Branch Sync] ⚠️ Error subiendo logo (continuando sin logo):`, logoError.message);
                }
            }

            // Actualizar sucursal (incluye logo_url)
            const result = await pool.query(`
                UPDATE branches
                SET name = COALESCE($1, name),
                    address = COALESCE($2, address),
                    phone = COALESCE($3, phone),
                    rfc = COALESCE($4, rfc),
                    logo_url = COALESCE($7, logo_url),
                    latitude = COALESCE($8, latitude),
                    longitude = COALESCE($9, longitude),
                    google_maps_url = COALESCE($10, google_maps_url),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $5 AND tenant_id = $6
                RETURNING *
            `, [name, address, phone, rfc, branchId, tenantId, logoUrl, latitude || null, longitude || null, google_maps_url || null]);

            const branch = result.rows[0];
            console.log(`[Branch Sync] ✅ Sucursal actualizada: ${branch.name} (RFC: ${branch.rfc || 'N/A'}, Logo: ${branch.logo_url ? 'Sí' : 'No'})`);

            // Si es la sucursal principal, actualizar tenant (nombre y/o logo)
            let tenantUpdated = false;
            const branchIdInt = parseInt(branchId);

            const primaryBranch = await pool.query(
                `SELECT id FROM branches
                 WHERE tenant_id = $1
                 ORDER BY created_at ASC
                 LIMIT 1`,
                [tenantId]
            );

            const isPrimary = primaryBranch.rows.length > 0 && primaryBranch.rows[0].id === branchIdInt;

            if (isPrimary) {
                const updateFields = [];
                const updateValues = [];
                let paramIndex = 1;

                if (name && name !== oldName) {
                    updateFields.push(`business_name = $${paramIndex}`);
                    updateValues.push(name);
                    paramIndex++;
                }

                if (logoUrl) {
                    updateFields.push(`logo_url = $${paramIndex}`);
                    updateValues.push(logoUrl);
                    paramIndex++;
                }

                if (updateFields.length > 0) {
                    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
                    updateValues.push(tenantId);
                    await pool.query(
                        `UPDATE tenants SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
                        updateValues
                    );
                    tenantUpdated = true;
                    console.log(`[Branch Sync] ✅ Tenant actualizado (nombre: ${name || 'sin cambio'}, logo: ${logoUrl ? 'Sí' : 'No'})`);
                }
            }

            // Notificar a dispositivos moviles en esta sucursal
            io.to(`branch_${branchId}`).emit('branch_info_updated', {
                branchId: parseInt(branchId),
                tenantId: parseInt(tenantId),
                name: branch.name,
                address: branch.address,
                phone: branch.phone,
                rfc: branch.rfc,
                logoUrl: branch.logo_url,
                latitude: branch.latitude,
                longitude: branch.longitude,
                googleMapsUrl: branch.google_maps_url,
                updatedAt: branch.updated_at,
                receivedAt: new Date().toISOString()
            });
            console.log(`[Branch Sync] 📡 Emitido branch_info_updated a branch_${branchId}`);

            res.json({
                success: true,
                message: tenantUpdated
                    ? 'Sucursal y negocio actualizados exitosamente'
                    : 'Sucursal actualizada exitosamente',
                data: {
                    id: branch.id,
                    name: branch.name,
                    address: branch.address,
                    phone: branch.phone,
                    rfc: branch.rfc,
                    logo_url: branch.logo_url,
                    latitude: branch.latitude,
                    longitude: branch.longitude,
                    google_maps_url: branch.google_maps_url,
                    tenantUpdated: tenantUpdated,
                    updatedAt: branch.updated_at
                }
            });

        } catch (error) {
            console.error('[Branch Sync] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar sucursal',
                error: undefined
            });
        }
    });

    // GET /api/branches/:branchId/scale-status - Estado actual de la báscula (memoria + DB fallback)
    router.get('/:branchId/scale-status', authenticateToken, async (req, res) => {
        const branchId = parseInt(req.params.branchId);
        if (!branchId) {
            return res.status(400).json({ success: false, message: 'branchId requerido' });
        }
        // 1. Check in-memory Map first (real-time, updated by socket events)
        const status = scaleStatusByBranch.get(branchId);
        if (status) {
            return res.json({ success: true, data: { ...status, branchId } });
        }
        // 2. Fallback to DB (persisted across server restarts)
        try {
            const result = await pool.query(
                `SELECT scale_status, scale_status_updated_at FROM branches WHERE id = $1`,
                [branchId]
            );
            if (result.rows.length > 0 && result.rows[0].scale_status && result.rows[0].scale_status !== 'unknown') {
                const statusTime = result.rows[0].scale_status_updated_at;
                const dbStatus = {
                    status: result.rows[0].scale_status,
                    updatedAt: statusTime,
                    // Include disconnectedAt/connectedAt so mobile app can show timer
                    ...(result.rows[0].scale_status === 'disconnected'
                        ? { disconnectedAt: statusTime }
                        : { connectedAt: statusTime }),
                    source: 'db'
                };
                // Re-hydrate in-memory Map so subsequent requests are fast
                scaleStatusByBranch.set(branchId, dbStatus);
                return res.json({ success: true, data: { ...dbStatus, branchId } });
            }
        } catch (e) {
            console.error(`[SCALE] Error reading scale status from DB: ${e.message}`);
        }
        res.json({ success: true, data: { status: 'unknown', branchId } });
    });

    return router;
};
