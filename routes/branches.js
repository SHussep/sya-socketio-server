// ═══════════════════════════════════════════════════════════════
// RUTAS DE BRANCHES (SUCURSALES) - Multi-Tenant System
// ═══════════════════════════════════════════════════════════════

module.exports = function(pool, authenticateToken) {
    const router = require('express').Router();
    const cloudinaryService = require('../services/cloudinaryService');

    // ─────────────────────────────────────────────────────────
    // GET /api/branches
    // Obtener todas las sucursales del tenant
    // ─────────────────────────────────────────────────────────
    router.get('/', authenticateToken, async (req, res) => {
        const { tenantId } = req.user;

        try {
            const result = await pool.query(`
                SELECT
                    b.*,
                    (SELECT COUNT(*) FROM employees e
                     JOIN employee_branches eb ON e.id = eb.employee_id
                     WHERE eb.branch_id = b.id) as employee_count
                FROM branches b
                WHERE b.tenant_id = $1
                ORDER BY b.created_at ASC
            `, [tenantId]);

            res.json({
                success: true,
                data: result.rows.map(b => ({
                    id: b.id,
                    code: b.branch_code,
                    name: b.name,
                    address: b.address,
                    phone: b.phone_number,
                    rfc: b.rfc,
                    latitude: b.latitude,
                    longitude: b.longitude,
                    employeeCount: parseInt(b.employee_count),
                    isActive: b.is_active,
                    createdAt: b.created_at
                }))
            });

        } catch (error) {
            console.error('[Branches Get] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener sucursales',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/branches/:id
    // Obtener una sucursal específica
    // ─────────────────────────────────────────────────────────
    router.get('/:id', authenticateToken, async (req, res) => {
        const { tenantId } = req.user;
        const { id } = req.params;

        try {
            const result = await pool.query(`
                SELECT * FROM branches
                WHERE id = $1 AND tenant_id = $2
            `, [id, tenantId]);

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada'
                });
            }

            const branch = result.rows[0];

            // Obtener empleados de esta sucursal
            const employees = await pool.query(`
                SELECT e.id,
                       CONCAT(e.first_name, ' ', e.last_name) as full_name,
                       r.name as role, e.email,
                       eb.can_login, eb.can_sell, eb.can_manage_inventory, eb.can_close_shift
                FROM employees e
                JOIN employee_branches eb ON e.id = eb.employee_id
                LEFT JOIN roles r ON e.role_id = r.id
                WHERE eb.branch_id = $1 AND e.is_active = true
                ORDER BY e.first_name, e.last_name
            `, [id]);

            res.json({
                success: true,
                data: {
                    id: branch.id,
                    code: branch.branch_code,
                    name: branch.name,
                    address: branch.address,
                    phone: branch.phone_number,
                    rfc: branch.rfc,
                    latitude: branch.latitude,
                    longitude: branch.longitude,
                    isActive: branch.is_active,
                    createdAt: branch.created_at,
                    employees: employees.rows
                }
            });

        } catch (error) {
            console.error('[Branch Get] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener sucursal',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/branches
    // Crear nueva sucursal
    // ─────────────────────────────────────────────────────────
    router.post('/', authenticateToken, async (req, res) => {
        const { tenantId, role } = req.user;
        const { code, name, address, phone, latitude, longitude } = req.body;

        // Solo owners y managers pueden crear sucursales
        if (role !== 'owner' && role !== 'manager') {
            return res.status(403).json({
                success: false,
                message: 'No tienes permisos para crear sucursales'
            });
        }

        if (!code || !name) {
            return res.status(400).json({
                success: false,
                message: 'Código y nombre de sucursal son requeridos'
            });
        }

        try {
            // Verificar límite de sucursales según plan
            const tenant = await pool.query(`
                SELECT t.subscription_id, s.max_branches
                FROM tenants t
                JOIN subscriptions s ON t.subscription_id = s.id
                WHERE t.id = $1
            `, [tenantId]);

            const { max_branches } = tenant.rows[0];

            // Contar sucursales actuales
            const count = await pool.query(
                'SELECT COUNT(*) FROM branches WHERE tenant_id = $1',
                [tenantId]
            );

            const currentBranches = parseInt(count.rows[0].count);

            // -1 significa ilimitado
            if (max_branches !== -1 && currentBranches >= max_branches) {
                return res.status(403).json({
                    success: false,
                    message: `Has alcanzado el límite de ${max_branches} sucursales de tu plan. Actualiza tu suscripción.`
                });
            }

            // Crear sucursal
            const result = await pool.query(`
                INSERT INTO branches (
                    tenant_id, branch_code, name, address, phone_number,
                    latitude, longitude, is_active
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, true)
                RETURNING *
            `, [
                tenantId,
                code,
                name,
                address || null,
                phone || null,
                latitude || null,
                longitude || null
            ]);

            const branch = result.rows[0];

            console.log(`[Branch Create] ✅ Sucursal creada: ${branch.name} (${branch.branch_code})`);

            res.status(201).json({
                success: true,
                message: 'Sucursal creada exitosamente',
                data: {
                    id: branch.id,
                    code: branch.branch_code,
                    name: branch.name,
                    address: branch.address,
                    phone: branch.phone_number,
                    latitude: branch.latitude,
                    longitude: branch.longitude,
                    isActive: branch.is_active,
                    createdAt: branch.created_at
                }
            });

        } catch (error) {
            // Violación de unique constraint
            if (error.code === '23505') {
                return res.status(409).json({
                    success: false,
                    message: 'Ya existe una sucursal con ese código'
                });
            }

            console.error('[Branch Create] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al crear sucursal',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // PUT /api/branches/:id
    // Actualizar sucursal
    // ─────────────────────────────────────────────────────────
    router.put('/:id', authenticateToken, async (req, res) => {
        const { tenantId, role } = req.user;
        const { id } = req.params;
        const { name, address, phone, latitude, longitude, isActive, rfc } = req.body;

        // Solo owners y managers pueden actualizar
        if (role !== 'owner' && role !== 'manager') {
            return res.status(403).json({
                success: false,
                message: 'No tienes permisos para actualizar sucursales'
            });
        }

        try {
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

            // Actualizar (incluye RFC)
            const result = await pool.query(`
                UPDATE branches
                SET name = COALESCE($1, name),
                    address = COALESCE($2, address),
                    phone_number = COALESCE($3, phone_number),
                    latitude = COALESCE($4, latitude),
                    longitude = COALESCE($5, longitude),
                    is_active = COALESCE($6, is_active),
                    rfc = COALESCE($7, rfc),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $8 AND tenant_id = $9
                RETURNING *
            `, [
                name,
                address,
                phone,
                latitude,
                longitude,
                isActive,
                rfc,
                id,
                tenantId
            ]);

            const branch = result.rows[0];

            console.log(`[Branch Update] ✅ Sucursal actualizada: ${branch.name} (RFC: ${branch.rfc || 'N/A'})`);

            // Si es la sucursal principal (primera creada), también actualizar el nombre del tenant
            if (name) {
                const primaryBranch = await pool.query(
                    `SELECT id FROM branches
                     WHERE tenant_id = $1
                     ORDER BY created_at ASC
                     LIMIT 1`,
                    [tenantId]
                );

                if (primaryBranch.rows.length > 0 && primaryBranch.rows[0].id === parseInt(id)) {
                    // Es la sucursal principal, actualizar también el tenant
                    await pool.query(
                        `UPDATE tenants SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                        [name, tenantId]
                    );
                    console.log(`[Branch Update] ✅ Tenant también actualizado con nombre: ${name}`);
                }
            }

            res.json({
                success: true,
                message: 'Sucursal actualizada exitosamente',
                data: {
                    id: branch.id,
                    code: branch.branch_code,
                    name: branch.name,
                    address: branch.address,
                    phone: branch.phone_number,
                    rfc: branch.rfc,
                    latitude: branch.latitude,
                    longitude: branch.longitude,
                    isActive: branch.is_active,
                    updatedAt: branch.updated_at
                }
            });

        } catch (error) {
            console.error('[Branch Update] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar sucursal',
                error: undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/branches/sync-info
    // Sincronizar información de sucursal desde Desktop (SIN JWT)
    // Usa tenantId/branchId del payload para identificación
    // Si es la sucursal principal, también actualiza el tenant
    // ─────────────────────────────────────────────────────────
    router.post('/sync-info', async (req, res) => {
        const { tenantId, branchId, name, address, phone, rfc, logo_base64, existing_logo_url } = req.body;

        console.log(`[Branch Sync] 📥 Recibida solicitud de sync: tenantId=${tenantId}, branchId=${branchId}, hasLogo=${!!logo_base64}`);

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
                    phone_number = COALESCE($3, phone_number),
                    rfc = COALESCE($4, rfc),
                    logo_url = COALESCE($7, logo_url),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $5 AND tenant_id = $6
                RETURNING *
            `, [name, address, phone, rfc, branchId, tenantId, logoUrl]);

            const branch = result.rows[0];
            console.log(`[Branch Sync] ✅ Sucursal actualizada: ${branch.name} (RFC: ${branch.rfc || 'N/A'}, Logo: ${branch.logo_url ? 'Sí' : 'No'})`);

            // Si es la sucursal principal y se cambió el nombre o logo, también actualizar el tenant
            let tenantUpdated = false;
            const isPrimaryCheck = await pool.query(
                `SELECT id FROM branches
                 WHERE tenant_id = $1
                 ORDER BY created_at ASC
                 LIMIT 1`,
                [tenantId]
            );

            const isPrimary = isPrimaryCheck.rows.length > 0 && isPrimaryCheck.rows[0].id === branchId;

            if (isPrimary) {
                const updateFields = [];
                const updateValues = [];
                let paramIndex = 1;

                if (name && name !== oldName) {
                    updateFields.push(`name = $${paramIndex}`);
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
                    console.log(`[Branch Sync] ✅ Tenant también actualizado (nombre: ${name || 'sin cambio'}, logo: ${logoUrl ? 'Sí' : 'No'})`);
                }
            }

            res.json({
                success: true,
                message: tenantUpdated
                    ? 'Sucursal y negocio actualizados exitosamente'
                    : 'Sucursal actualizada exitosamente',
                data: {
                    id: branch.id,
                    name: branch.name,
                    address: branch.address,
                    phone: branch.phone_number,
                    rfc: branch.rfc,
                    logo_url: branch.logo_url,
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

    return router;
};
