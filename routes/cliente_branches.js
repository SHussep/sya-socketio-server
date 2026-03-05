// ═══════════════════════════════════════════════════════════════
// CLIENTE BRANCHES ROUTES - Handle many-to-many customer-branch relationships
// ═══════════════════════════════════════════════════════════════

const express = require('express');

module.exports = (pool) => {
    const router = express.Router();

    // Helper: Emitir evento Socket.IO de cambio de asignacion
    function emitBranchAssignmentEvent(req, customerId, branchId, isActive, action) {
        try {
            const io = req.app.get('io');
            if (io) {
                const roomName = `branch_${branchId}`;
                io.to(roomName).emit('cliente_branch:updated', {
                    customerId,
                    branchId,
                    isActive,
                    action,
                    timestamp: new Date().toISOString()
                });
                console.log(`[ClienteBranches/Socket] 📡 Evento emitido a ${roomName}: ${action}`);
            }
        } catch (err) {
            console.error(`[ClienteBranches/Socket] ⚠️ Error emitiendo evento: ${err.message}`);
        }
    }

    // POST /api/cliente-branches - Sync customer branch assignment from Desktop
    router.post('/', async (req, res) => {
        const client = await pool.connect();
        try {
            const {
                tenantId,
                customerId,
                branchId,
                isActive = true
            } = req.body;

            console.log(`[ClienteBranches/Sync] 🔄 Sincronizando: Cliente ${customerId} → Sucursal ${branchId} (Tenant: ${tenantId})`);

            if (!tenantId || !customerId || !branchId) {
                console.log(`[ClienteBranches/Sync] ❌ Datos incompletos`);
                return res.status(400).json({
                    success: false,
                    message: 'Faltan campos requeridos: tenantId, customerId, branchId'
                });
            }

            // Verify customer exists
            const custCheck = await client.query(
                `SELECT id FROM customers WHERE id = $1 AND tenant_id = $2`,
                [customerId, tenantId]
            );

            if (custCheck.rows.length === 0) {
                console.log(`[ClienteBranches/Sync] ❌ Cliente no encontrado: ${customerId}`);
                return res.status(404).json({
                    success: false,
                    message: 'El cliente no existe'
                });
            }

            // Verify branch exists
            const branchCheck = await client.query(
                `SELECT id FROM branches WHERE id = $1 AND tenant_id = $2`,
                [branchId, tenantId]
            );

            if (branchCheck.rows.length === 0) {
                console.log(`[ClienteBranches/Sync] ❌ Sucursal no encontrada: ${branchId}`);
                return res.status(404).json({
                    success: false,
                    message: 'La sucursal no existe'
                });
            }

            // Check if relationship already exists
            const existingResult = await client.query(
                `SELECT id FROM cliente_branches
                 WHERE tenant_id = $1 AND customer_id = $2 AND branch_id = $3`,
                [tenantId, customerId, branchId]
            );

            if (existingResult.rows.length > 0) {
                // Update existing relationship
                const existingId = existingResult.rows[0].id;
                console.log(`[ClienteBranches/Sync] ⚠️ Relacion ya existe (ID: ${existingId}), actualizando...`);

                const updateResult = await client.query(
                    `UPDATE cliente_branches
                     SET removed_at = CASE WHEN $1 = false THEN NOW() ELSE NULL END,
                         is_active = $1,
                         updated_at = NOW()
                     WHERE id = $2
                     RETURNING id, tenant_id, customer_id, branch_id, assigned_at, removed_at, updated_at`,
                    [isActive, existingId]
                );

                if (updateResult.rows.length > 0) {
                    const relationship = updateResult.rows[0];
                    console.log(`[ClienteBranches/Sync] ✅ Relacion actualizada: Cliente ${customerId} en Sucursal ${branchId}`);

                    emitBranchAssignmentEvent(req, customerId, branchId, isActive, 'updated');

                    return res.json({
                        success: true,
                        data: relationship,
                        id: relationship.id,
                        remoteId: relationship.id
                    });
                }
            }

            // Create new relationship
            console.log(`[ClienteBranches/Sync] 📝 Creando nueva relacion: Cliente ${customerId} → Sucursal ${branchId}`);

            const insertResult = await client.query(
                `INSERT INTO cliente_branches
                 (tenant_id, customer_id, branch_id, is_active, assigned_at, removed_at, updated_at)
                 VALUES ($1, $2, $3, $4, NOW(), CASE WHEN $4 = false THEN NOW() ELSE NULL END, NOW())
                 RETURNING id, tenant_id, customer_id, branch_id, assigned_at, removed_at, updated_at`,
                [tenantId, customerId, branchId, isActive]
            );

            if (insertResult.rows.length > 0) {
                const relationship = insertResult.rows[0];
                console.log(`[ClienteBranches/Sync] ✅ Relacion creada: Cliente ${customerId} en Sucursal ${branchId} (ID: ${relationship.id})`);

                emitBranchAssignmentEvent(req, customerId, branchId, isActive, 'assigned');

                return res.json({
                    success: true,
                    data: relationship,
                    id: relationship.id,
                    remoteId: relationship.id
                });
            }

            console.log(`[ClienteBranches/Sync] ❌ Error: No se inserto relacion`);
            res.status(500).json({
                success: false,
                message: 'No se pudo crear la relacion'
            });

        } catch (error) {
            console.error(`[ClienteBranches/Sync] ❌ Error:`, error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar relacion cliente-sucursal'
            });
        } finally {
            client.release();
        }
    });

    // GET /api/cliente-branches - Get all branches for a customer
    router.get('/', async (req, res) => {
        try {
            const { tenantId, customerId } = req.query;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere tenantId'
                });
            }

            let query = `
                SELECT cb.id, cb.tenant_id, cb.customer_id, cb.branch_id,
                       cb.is_active, cb.assigned_at, cb.removed_at, cb.updated_at,
                       b.name as branch_name, b.branch_code as branch_code
                FROM cliente_branches cb
                JOIN branches b ON b.id = cb.branch_id
                WHERE cb.tenant_id = $1
            `;
            const params = [tenantId];

            if (customerId) {
                query += ` AND cb.customer_id = $2`;
                params.push(customerId);
            }

            query += ` ORDER BY b.name ASC`;

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });

        } catch (error) {
            console.error('[ClienteBranches] Error en GET:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener asignaciones de sucursales'
            });
        }
    });

    return router;
};
