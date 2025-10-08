// ═══════════════════════════════════════════════════════════════
// RUTAS DE BRANCHES (SUCURSALES) - Multi-Tenant System
// ═══════════════════════════════════════════════════════════════

module.exports = function(pool, authenticateToken) {
    const router = require('express').Router();

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
                error: error.message
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
                SELECT e.id, e.full_name, e.role, e.email,
                       eb.can_login, eb.can_sell, eb.can_manage_inventory, eb.can_close_shift
                FROM employees e
                JOIN employee_branches eb ON e.id = eb.employee_id
                WHERE eb.branch_id = $1 AND e.is_active = true
                ORDER BY e.full_name
            `, [id]);

            res.json({
                success: true,
                data: {
                    id: branch.id,
                    code: branch.branch_code,
                    name: branch.name,
                    address: branch.address,
                    phone: branch.phone_number,
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
                error: error.message
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
                error: error.message
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
        const { name, address, phone, latitude, longitude, isActive } = req.body;

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

            // Actualizar
            const result = await pool.query(`
                UPDATE branches
                SET name = COALESCE($1, name),
                    address = COALESCE($2, address),
                    phone_number = COALESCE($3, phone_number),
                    latitude = COALESCE($4, latitude),
                    longitude = COALESCE($5, longitude),
                    is_active = COALESCE($6, is_active),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $7 AND tenant_id = $8
                RETURNING *
            `, [
                name,
                address,
                phone,
                latitude,
                longitude,
                isActive,
                id,
                tenantId
            ]);

            const branch = result.rows[0];

            console.log(`[Branch Update] ✅ Sucursal actualizada: ${branch.name}`);

            res.json({
                success: true,
                message: 'Sucursal actualizada exitosamente',
                data: {
                    id: branch.id,
                    code: branch.branch_code,
                    name: branch.name,
                    address: branch.address,
                    phone: branch.phone_number,
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
                error: error.message
            });
        }
    });

    return router;
};
