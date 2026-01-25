// ═══════════════════════════════════════════════════════════════
// DEVICES ROUTES - Gestion de dispositivos (Primary/Auxiliar)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const { createAuthMiddleware } = require('../middleware/auth');

module.exports = (pool) => {
    const router = express.Router();
    const authenticateToken = createAuthMiddleware(pool);

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
            console.error('[Devices] ❌ Error en claim-primary:', error.message);
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
            const tenantId = req.user.tenantId; // SEGURO: Solo del JWT, nunca del body

            console.log(`[Devices] POST /register - Device: ${device_id?.substring(0, 10)}..., Type: ${device_type}`);

            if (!device_id || !branch_id || !tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere device_id, branch_id y tenant_id'
                });
            }

            // Insertar o actualizar dispositivo (como Auxiliar por defecto)
            const result = await pool.query(`
                INSERT INTO branch_devices (
                    tenant_id, branch_id, device_id, device_name, device_type,
                    is_primary, last_seen_at, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, FALSE, NOW(), NOW(), NOW())
                ON CONFLICT (device_id, branch_id, tenant_id)
                DO UPDATE SET
                    device_name = COALESCE(EXCLUDED.device_name, branch_devices.device_name),
                    device_type = COALESCE(EXCLUDED.device_type, branch_devices.device_type),
                    last_seen_at = NOW(),
                    updated_at = NOW()
                RETURNING id, is_primary
            `, [tenantId, branch_id, device_id, device_name, device_type]);

            console.log(`[Devices] ✅ Dispositivo registrado: ${device_id.substring(0, 10)}... (Primary: ${result.rows[0].is_primary})`);

            res.json({
                success: true,
                message: 'Dispositivo registrado',
                data: {
                    id: result.rows[0].id,
                    device_id,
                    is_primary: result.rows[0].is_primary
                }
            });

        } catch (error) {
            console.error('[Devices] ❌ Error en register:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al registrar dispositivo',
                error: error.message
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

            const result = await pool.query(`
                SELECT id, device_id, device_name, device_type, is_primary,
                       claimed_at, last_seen_at, created_at
                FROM branch_devices
                WHERE branch_id = $1 AND tenant_id = $2
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
                error: error.message
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
                error: error.message
            });
        }
    });

    return router;
};
