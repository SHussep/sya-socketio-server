// ═══════════════════════════════════════════════════════════════
// DEVICES ROUTES - Gestion de dispositivos (Primary/Auxiliar)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const { createAuthMiddleware } = require('../middleware/auth');

module.exports = (pool) => {
    const router = express.Router();
    const authenticateToken = createAuthMiddleware(pool);

    // GET /api/devices/debug-list - Diagnóstico temporal: ver branch_devices
    router.get('/debug-list', async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT id, device_id, device_name, device_type, is_primary,
                        COALESCE(is_active, TRUE) as is_active, branch_id, tenant_id,
                        last_seen_at, created_at
                 FROM branch_devices ORDER BY created_at DESC LIMIT 50`
            );
            res.json({ count: result.rows.length, devices: result.rows });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // POST /api/devices/claim-primary - Reclamar rol de Equipo Principal
    // Permite a un dispositivo reclamar el rol de Principal para una sucursal.
    // Si ya existe un Principal, lo reemplaza (requiere password de admin).
    // ═══════════════════════════════════════════════════════════════════════════
    router.post('/claim-primary', authenticateToken, async (req, res) => {
        const client = await pool.connect();

        try {
            const { device_id, device_name, branch_id, admin_password_hash } = req.body;
            const tenantId = req.user.tenantId; // SEGURO: Solo del JWT, nunca del body

            console.log(`[Devices] POST /claim-primary - Device: ${device_id?.substring(0, 10)}..., Branch: ${branch_id}`);

            if (!device_id || !branch_id || !tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere device_id, branch_id y tenant_id'
                });
            }

            await client.query('BEGIN');

            // Verificar si ya existe un dispositivo Primary para esta sucursal
            const existingPrimaryResult = await client.query(`
                SELECT id, device_id, device_name, claimed_at, employee_id
                FROM branch_devices
                WHERE branch_id = $1 AND tenant_id = $2 AND is_primary = TRUE
            `, [branch_id, tenantId]);

            const existingPrimary = existingPrimaryResult.rows[0];

            if (existingPrimary) {
                // Ya hay un Primary - verificar si es el mismo dispositivo
                if (existingPrimary.device_id === device_id) {
                    // Es el mismo dispositivo, solo actualizar timestamp
                    await client.query(`
                        UPDATE branch_devices
                        SET device_name = COALESCE($1, device_name),
                            last_seen_at = NOW()
                        WHERE device_id = $2 AND branch_id = $3 AND tenant_id = $4
                    `, [device_name, device_id, branch_id, tenantId]);

                    await client.query('COMMIT');

                    console.log(`[Devices] ✅ Dispositivo Primary actualizado: ${device_id.substring(0, 10)}...`);

                    return res.json({
                        success: true,
                        message: 'Dispositivo Primary actualizado',
                        data: {
                            device_id,
                            is_primary: true,
                            replaced_existing: false
                        }
                    });
                }

                // Es un dispositivo diferente - verificar contraseña de admin
                if (!admin_password_hash) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        success: false,
                        message: 'Se requiere contraseña de administrador para reclamar rol Principal',
                        existing_primary: {
                            device_name: existingPrimary.device_name,
                            claimed_at: existingPrimary.claimed_at
                        }
                    });
                }

                // Verificar contraseña contra un administrador del tenant
                // Nota: admin_password_hash ahora debería ser la contraseña en texto plano
                const adminCheck = await client.query(`
                    SELECT id, first_name, last_name, password_hash
                    FROM employees
                    WHERE tenant_id = $1
                      AND (role_id = 1 OR is_owner = TRUE)
                      AND is_active = TRUE
                    ORDER BY is_owner DESC
                    LIMIT 1
                `, [tenantId]);

                if (adminCheck.rows.length === 0) {
                    await client.query('ROLLBACK');
                    console.log(`[Devices] ❌ No se encontró administrador para tenant ${tenantId}`);
                    return res.status(404).json({
                        success: false,
                        message: 'No se encontró administrador para este negocio'
                    });
                }

                const admin = adminCheck.rows[0];

                // Verificar contraseña con bcrypt
                const passwordValid = await bcrypt.compare(admin_password_hash, admin.password_hash);

                if (!passwordValid) {
                    await client.query('ROLLBACK');
                    console.log(`[Devices] ❌ Contraseña de admin incorrecta para tenant ${tenantId}`);
                    return res.status(403).json({
                        success: false,
                        message: 'Contraseña de administrador incorrecta'
                    });
                }

                console.log(`[Devices] 🔄 Reemplazando Primary existente: ${existingPrimary.device_name}`);

                // Degradar el dispositivo Primary existente a Auxiliar
                await client.query(`
                    UPDATE branch_devices
                    SET is_primary = FALSE,
                        updated_at = NOW()
                    WHERE id = $1
                `, [existingPrimary.id]);
            }

            // Insertar o actualizar el nuevo dispositivo como Primary
            await client.query(`
                INSERT INTO branch_devices (
                    tenant_id, branch_id, device_id, device_name,
                    is_primary, claimed_at, last_seen_at, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW(), NOW(), NOW())
                ON CONFLICT (device_id, branch_id, tenant_id)
                DO UPDATE SET
                    is_primary = TRUE,
                    device_name = COALESCE(EXCLUDED.device_name, branch_devices.device_name),
                    claimed_at = NOW(),
                    last_seen_at = NOW(),
                    updated_at = NOW()
            `, [tenantId, branch_id, device_id, device_name]);

            await client.query('COMMIT');

            console.log(`[Devices] ✅ Nuevo Primary registrado: ${device_id.substring(0, 10)}... para branch ${branch_id}`);

            // Notificar a la sucursal que hay un nuevo Primary
            const io = req.app.get('io');
            if (io) {
                io.to(`branch_${branch_id}`).emit('terminal:primary_claimed', {
                    device_id,
                    device_name,
                    branch_id: parseInt(branch_id),
                    replaced_existing: !!existingPrimary
                });
            }

            res.json({
                success: true,
                message: existingPrimary ? 'Rol Principal reclamado (reemplazó existente)' : 'Rol Principal asignado',
                data: {
                    device_id,
                    is_primary: true,
                    replaced_existing: !!existingPrimary,
                    previous_primary: existingPrimary ? {
                        device_name: existingPrimary.device_name,
                        claimed_at: existingPrimary.claimed_at
                    } : null
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Devices] ❌ Error en claim-primary:', error.message, error.stack);
            res.status(500).json({
                success: false,
                message: 'Error al reclamar rol Principal',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // POST /api/devices/register - Registrar dispositivo Auxiliar
    // Registra un nuevo dispositivo como Caja Auxiliar
    // ═══════════════════════════════════════════════════════════════════════════
    router.post('/register', authenticateToken, async (req, res) => {
        try {
            const { device_id, device_name, device_type, branch_id } = req.body;
            const tenantId = req.user.tenantId;

            console.log(`[Devices] POST /register - Device: ${device_id?.substring(0, 10)}..., Type: ${device_type}`);

            if (!device_id || !branch_id || !tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere device_id, branch_id y tenant_id'
                });
            }

            // Auto-generate name if not provided
            let finalDeviceName = device_name;
            if (!finalDeviceName || finalDeviceName.trim() === '') {
                const countResult = await pool.query(
                    `SELECT COUNT(*) as cnt FROM branch_devices
                     WHERE branch_id = $1 AND tenant_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
                    [branch_id, tenantId]
                );
                let n = parseInt(countResult.rows[0].cnt) + 1;
                finalDeviceName = `Caja ${n}`;

                // Retry if name collides (max 5 attempts)
                for (let attempt = 0; attempt < 5; attempt++) {
                    const nameExists = await pool.query(
                        `SELECT id FROM branch_devices
                         WHERE branch_id = $1 AND tenant_id = $2 AND device_name = $3
                         AND COALESCE(is_active, TRUE) = TRUE`,
                        [branch_id, tenantId, finalDeviceName]
                    );
                    if (nameExists.rows.length === 0) break;
                    n++;
                    finalDeviceName = `Caja ${n}`;
                }
            }

            const result = await pool.query(`
                INSERT INTO branch_devices (
                    tenant_id, branch_id, device_id, device_name, device_type,
                    is_primary, last_seen_at, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, FALSE, NOW(), NOW(), NOW())
                ON CONFLICT (device_id, branch_id, tenant_id)
                DO UPDATE SET
                    device_name = COALESCE(NULLIF($4, ''), branch_devices.device_name),
                    device_type = COALESCE(EXCLUDED.device_type, branch_devices.device_type),
                    last_seen_at = NOW(),
                    updated_at = NOW()
                RETURNING id, is_primary, device_name,
                    (xmax = 0) as is_new
            `, [tenantId, branch_id, device_id, finalDeviceName, device_type]);

            console.log(`[Devices] ✅ Dispositivo ${result.rows[0].is_new ? 'registrado' : 'actualizado'}: ${device_id.substring(0, 10)}... name=${result.rows[0].device_name}`);

            // ═══════════════════════════════════════════════════════════════
            // AUTO-ENABLE MULTI-CAJA: Si hay 2+ dispositivos activos
            // y multi_caja_enabled está desactivado, activarlo automáticamente
            // ═══════════════════════════════════════════════════════════════
            let multiCajaAutoEnabled = false;
            try {
                const activeDeviceCount = await pool.query(
                    `SELECT COUNT(*) as cnt FROM branch_devices
                     WHERE branch_id = $1 AND tenant_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
                    [branch_id, tenantId]
                );
                const count = parseInt(activeDeviceCount.rows[0].cnt);

                if (count >= 2) {
                    const branchCheck = await pool.query(
                        `SELECT multi_caja_enabled FROM branches WHERE id = $1 AND tenant_id = $2`,
                        [branch_id, tenantId]
                    );

                    if (branchCheck.rows.length > 0 && !branchCheck.rows[0].multi_caja_enabled) {
                        await pool.query(
                            `UPDATE branches SET multi_caja_enabled = TRUE, updated_at = NOW()
                             WHERE id = $1 AND tenant_id = $2`,
                            [branch_id, tenantId]
                        );

                        console.log(`[Devices] 🔄 Multi-caja auto-habilitado para branch ${branch_id} (${count} dispositivos activos)`);
                        multiCajaAutoEnabled = true;

                        const io = req.app.get('io');
                        if (io) {
                            io.to(`branch_${branch_id}`).emit('branch_settings_changed', {
                                branchId: parseInt(branch_id),
                                multi_caja_enabled: true,
                                auto_enabled: true,
                                active_device_count: count,
                                receivedAt: new Date().toISOString()
                            });
                        }
                    }
                }
            } catch (mcErr) {
                console.error('[Devices] ⚠️ Error verificando multi-caja:', mcErr.message);
            }

            res.json({
                success: true,
                message: result.rows[0].is_new ? 'Dispositivo registrado' : 'Dispositivo actualizado',
                data: {
                    id: result.rows[0].id,
                    device_id,
                    device_name: result.rows[0].device_name,
                    is_primary: result.rows[0].is_primary,
                    is_new: result.rows[0].is_new,
                    multi_caja_auto_enabled: multiCajaAutoEnabled
                }
            });

        } catch (error) {
            console.error('[Devices] ❌ Error en register:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al registrar dispositivo',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GET /api/devices/branch/:branchId - Listar dispositivos de una sucursal
    // ═══════════════════════════════════════════════════════════════════════════
    router.get('/branch/:branchId', authenticateToken, async (req, res) => {
        try {
            const { branchId } = req.params;
            const tenantId = req.user.tenantId || req.query.tenantId;

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'Se requiere tenantId' });
            }

            const { include_inactive } = req.query;
            const result = await pool.query(`
                SELECT id, device_id, device_name, device_type, is_primary,
                       COALESCE(is_active, TRUE) as is_active,
                       claimed_at, last_seen_at, created_at
                FROM branch_devices
                WHERE branch_id = $1 AND tenant_id = $2
                ${include_inactive !== 'true' ? 'AND COALESCE(is_active, TRUE) = TRUE' : ''}
                ORDER BY is_primary DESC, last_seen_at DESC
            `, [branchId, tenantId]);

            console.log(`[Devices] GET /branch/${branchId} - ${result.rows.length} dispositivos`);

            res.json({
                success: true,
                data: {
                    devices: result.rows,
                    count: result.rows.length,
                    has_primary: result.rows.some(d => d.is_primary)
                }
            });

        } catch (error) {
            console.error('[Devices] ❌ Error listando dispositivos:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al listar dispositivos',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // POST /api/devices/heartbeat - Actualizar última actividad del dispositivo
    // ═══════════════════════════════════════════════════════════════════════════
    router.post('/heartbeat', authenticateToken, async (req, res) => {
        try {
            const { device_id, branch_id } = req.body;
            const tenantId = req.user.tenantId; // SEGURO: Solo del JWT, nunca del body

            if (!device_id || !branch_id || !tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere device_id, branch_id y tenant_id'
                });
            }

            const result = await pool.query(`
                UPDATE branch_devices
                SET last_seen_at = NOW()
                WHERE device_id = $1 AND branch_id = $2 AND tenant_id = $3
                RETURNING is_primary
            `, [device_id, branch_id, tenantId]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Dispositivo no encontrado'
                });
            }

            res.json({
                success: true,
                data: {
                    is_primary: result.rows[0].is_primary
                }
            });

        } catch (error) {
            console.error('[Devices] ❌ Error en heartbeat:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error en heartbeat',
                error: undefined
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // PATCH /api/devices/:id - Rename or deactivate a terminal
    // Only Owner (is_owner=true) or Administrador (role_id=1) can modify
    // ═══════════════════════════════════════════════════════════════════════════
    router.patch('/:id', authenticateToken, async (req, res) => {
        try {
            const deviceId = parseInt(req.params.id);
            const { device_name, is_active } = req.body;
            const tenantId = req.user.tenantId;
            const employeeId = req.user.employeeId;

            if (!deviceId || isNaN(deviceId)) {
                return res.status(400).json({ success: false, message: 'ID de dispositivo inválido' });
            }

            // Check permissions: Owner or Administrador only
            const permCheck = await pool.query(
                `SELECT is_owner, role_id FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE`,
                [employeeId, tenantId]
            );
            if (permCheck.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Empleado no encontrado' });
            }
            const emp = permCheck.rows[0];
            if (!emp.is_owner && emp.role_id !== 1) {
                return res.status(403).json({ success: false, message: 'Solo Owner o Administrador pueden modificar terminales' });
            }

            // Fetch current device
            const current = await pool.query(
                `SELECT * FROM branch_devices WHERE id = $1 AND tenant_id = $2`,
                [deviceId, tenantId]
            );
            if (current.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Dispositivo no encontrado' });
            }
            const device = current.rows[0];

            // Handle deactivation
            if (is_active === false) {
                const activeShift = await pool.query(
                    `SELECT id FROM shifts WHERE terminal_id = $1 AND is_cash_cut_open = TRUE AND tenant_id = $2`,
                    [device.device_id, tenantId]
                );
                if (activeShift.rows.length > 0) {
                    return res.status(400).json({ success: false, message: 'No se puede desactivar una terminal con turno abierto' });
                }
                await pool.query(
                    `UPDATE branch_devices SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
                    [deviceId]
                );
            }

            // Handle reactivation
            if (is_active === true) {
                await pool.query(
                    `UPDATE branch_devices SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
                    [deviceId]
                );
            }

            // Handle rename
            if (device_name !== undefined) {
                const trimmed = (device_name || '').trim();
                if (trimmed.length < 1 || trimmed.length > 50) {
                    return res.status(400).json({ success: false, message: 'El nombre debe tener entre 1 y 50 caracteres' });
                }

                // Check uniqueness among active devices in same branch
                const nameCheck = await pool.query(
                    `SELECT id FROM branch_devices
                     WHERE branch_id = $1 AND tenant_id = $2 AND device_name = $3
                     AND COALESCE(is_active, TRUE) = TRUE AND id != $4`,
                    [device.branch_id, tenantId, trimmed, deviceId]
                );
                if (nameCheck.rows.length > 0) {
                    return res.status(409).json({ success: false, message: `Ya existe una terminal con el nombre "${trimmed}" en esta sucursal` });
                }

                await pool.query(
                    `UPDATE branch_devices SET device_name = $1, updated_at = NOW() WHERE id = $2`,
                    [trimmed, deviceId]
                );
            }

            // Fetch updated device
            const updated = await pool.query(
                `SELECT id, device_id, device_name, device_type, is_primary, COALESCE(is_active, TRUE) as is_active, last_seen_at
                 FROM branch_devices WHERE id = $1`,
                [deviceId]
            );
            const result = updated.rows[0];

            // Emit Socket.IO event
            const io = req.app.get('io');
            if (io) {
                io.to(`branch_${device.branch_id}`).emit('terminal:updated', {
                    id: result.id,
                    deviceId: result.device_id,
                    deviceName: result.device_name,
                    deviceType: result.device_type,
                    isPrimary: result.is_primary,
                    isActive: result.is_active
                });
            }

            console.log(`[Devices] ✅ PATCH /${deviceId}: name=${result.device_name}, active=${result.is_active}`);

            res.json({
                success: true,
                data: {
                    id: result.id,
                    device_id: result.device_id,
                    device_name: result.device_name,
                    device_type: result.device_type,
                    is_primary: result.is_primary,
                    is_active: result.is_active,
                    last_seen_at: result.last_seen_at
                }
            });

        } catch (error) {
            console.error('[Devices] ❌ Error en PATCH:', error.message);
            if (error.code === '23505') {
                return res.status(409).json({ success: false, message: 'El nombre ya está en uso' });
            }
            res.status(500).json({ success: false, message: 'Error al actualizar dispositivo' });
        }
    });

    return router;
};
