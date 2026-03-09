// ═══════════════════════════════════════════════════════════════
// RUTAS DE DEBUG Y ADMINISTRACIÓN DE BASE DE DATOS
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { authenticateToken, requireSuperAdminPIN } = require('../middleware/auth');
const { requireAdminCredentials } = require('../middleware/adminAuth');

module.exports = (pool, io, scaleStatusByBranch) => {
    const debugRouter = express.Router();
    const databaseAdminRouter = express.Router();

    // ═══════════════════════════════════════════════════════════════
    // DEBUG ENDPOINTS
    // ═══════════════════════════════════════════════════════════════

    // GET /api/debug/rooms - Show active socket rooms and clients
    debugRouter.get('/rooms', requireAdminCredentials, (req, res) => {
        const rooms = {};
        io.sockets.adapter.rooms.forEach((sockets, roomName) => {
            if (roomName.startsWith('branch_')) {
                const clients = [];
                sockets.forEach(socketId => {
                    const s = io.sockets.sockets.get(socketId);
                    clients.push({ id: socketId, type: s?.clientType || 'unknown' });
                });
                rooms[roomName] = { count: sockets.size, clients };
            }
        });
        res.json({ totalConnected: io.sockets.sockets.size, rooms });
    });

    // GET /api/debug/test-sale - Emit a test sale_completed event
    debugRouter.get('/test-sale', requireAdminCredentials, (req, res) => {
        const branchId = parseInt(req.query.branchId) || 32;
        const roomName = `branch_${branchId}`;
        const roomSockets = io.sockets.adapter.rooms.get(roomName);
        const clientCount = roomSockets ? roomSockets.size : 0;

        const testSale = {
            branchId,
            saleId: 99999,
            ticketNumber: 9999,
            total: 77.77,
            paymentMethod: 'cash',
            completedAt: new Date().toISOString(),
            employeeName: 'TEST DIAGNOSTIC',
        };

        console.log(`[DEBUG] Emitiendo sale_completed de prueba a ${roomName} (${clientCount} clientes)`);
        io.to(roomName).emit('sale_completed', { ...testSale, receivedAt: new Date().toISOString() });

        res.json({
            sent: true,
            room: roomName,
            clientsInRoom: clientCount,
            payload: testSale,
        });
    });

    // GET /api/debug/timezone-diagnostic - Verify timezone configuration
    debugRouter.get('/timezone-diagnostic', requireAdminCredentials, (req, res) => {
        try {
            const now = new Date();
            const tzEnvVar = process.env.TZ;

            const offset = -now.getTimezoneOffset();
            const offsetHours = Math.floor(Math.abs(offset) / 60);
            const offsetMinutes = Math.abs(offset) % 60;
            const offsetSign = offset >= 0 ? '+' : '-';
            const tzOffset = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;

            const testDate = new Date('2025-10-26T19:35:13.276Z');

            res.json({
                diagnostic: {
                    message: '🔍 Timezone Configuration Diagnostic',
                    timezone_check: {
                        TZ_env_variable: tzEnvVar || 'NOT SET',
                        node_timezone_offset: tzOffset,
                        expected: 'TZ should be UTC (+00:00)',
                        status: tzOffset === '+00:00' ? '✅ CORRECT' : '❌ WRONG - Still using system timezone'
                    },
                    server_timestamps: {
                        javascript_now: now.toISOString(),
                        javascript_utc_string: now.toUTCString(),
                        test_timestamp_iso: testDate.toISOString()
                    },
                    node_version: process.version,
                    platform: process.platform,
                    critical_issue: tzOffset !== '+00:00' ?
                        '⚠️ TIMEZONE NOT SET TO UTC! Data will be stored with wrong offset.' :
                        '✅ Timezone is correctly set to UTC'
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // GET /api/debug/scale-status-map - Ver contenido completo del Map en memoria
    debugRouter.get('/scale-status-map', authenticateToken, (req, res) => {
        const allStatuses = {};
        for (const [branchId, status] of scaleStatusByBranch) {
            allStatuses[branchId] = status;
        }
        res.json({ success: true, data: allStatuses, totalBranches: scaleStatusByBranch.size });
    });

    // ═══════════════════════════════════════════════════════════════
    // DATABASE ADMIN ENDPOINTS (Superadmin PIN required)
    // ═══════════════════════════════════════════════════════════════

    // GET /api/database/view - Ver todos los datos de la BD
    databaseAdminRouter.get('/view', requireSuperAdminPIN, async (req, res) => {
        try {
            const tenants = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
            const employees = await pool.query('SELECT id, tenant_id, username, full_name, email, role, is_active, created_at FROM employees ORDER BY created_at DESC');
            const devices = await pool.query('SELECT * FROM devices ORDER BY linked_at DESC');
            const sessions = await pool.query('SELECT id, tenant_id, employee_id, device_id, expires_at, created_at, is_active FROM sessions ORDER BY created_at DESC');

            res.json({
                success: true,
                timestamp: new Date().toISOString(),
                data: {
                    tenants: tenants.rows,
                    employees: employees.rows,
                    devices: devices.rows,
                    sessions: sessions.rows,
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: undefined });
        }
    });

    // POST /api/database/fix-old-tenants - Arreglar tenants antiguos sin subscription_id
    databaseAdminRouter.post('/fix-old-tenants', requireSuperAdminPIN, async (req, res) => {
        try {
            const subResult = await pool.query("SELECT id FROM subscriptions WHERE name = 'Basic' LIMIT 1");
            if (subResult.rows.length === 0) {
                return res.status(500).json({ success: false, message: 'Plan Basic no encontrado' });
            }
            const basicId = subResult.rows[0].id;

            const result = await pool.query(
                'UPDATE tenants SET subscription_id = $1 WHERE subscription_id IS NULL RETURNING id, business_name, email',
                [basicId]
            );

            res.json({
                success: true,
                message: `${result.rows.length} tenant(s) actualizados`,
                updated: result.rows
            });
        } catch (error) {
            res.status(500).json({ success: false, error: undefined });
        }
    });

    // POST /api/database/delete-tenant-by-email - Eliminar tenant completo
    databaseAdminRouter.post('/delete-tenant-by-email', requireSuperAdminPIN, async (req, res) => {
        try {
            const { email } = req.body;

            if (!email) {
                return res.status(400).json({ success: false, message: 'Email es requerido' });
            }

            console.log(`[Delete Tenant] Buscando tenant con email: ${email}`);

            const tenantResult = await pool.query(
                'SELECT id, business_name, email FROM tenants WHERE LOWER(email) = LOWER($1)',
                [email]
            );

            if (tenantResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No se encontró tenant con ese email'
                });
            }

            const tenant = tenantResult.rows[0];
            const tenantId = tenant.id;

            console.log(`[Delete Tenant] Encontrado: ${tenant.business_name} (ID: ${tenantId})`);

            const deleteStats = {
                tenant: tenant,
                branches: (await pool.query('SELECT COUNT(*) FROM branches WHERE tenant_id = $1', [tenantId])).rows[0].count,
                employees: (await pool.query('SELECT COUNT(*) FROM employees WHERE tenant_id = $1', [tenantId])).rows[0].count,
                sales: (await pool.query('SELECT COUNT(*) FROM ventas WHERE tenant_id = $1', [tenantId])).rows[0].count,
                expenses: (await pool.query('SELECT COUNT(*) FROM expenses WHERE tenant_id = $1', [tenantId])).rows[0].count,
                shifts: (await pool.query('SELECT COUNT(*) FROM shifts WHERE tenant_id = $1', [tenantId])).rows[0].count,
                backups: (await pool.query('SELECT COUNT(*) FROM backup_metadata WHERE tenant_id = $1', [tenantId])).rows[0].count
            };

            console.log(`[Delete Tenant] Eliminando datos: ${JSON.stringify(deleteStats)}`);

            // Eliminar en orden correcto (respetando foreign keys)
            await pool.query('DELETE FROM guardian_events WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM cash_cuts WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM shifts WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM purchases WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM ventas WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM expenses WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM backup_metadata WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM cliente_branches WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM employee_branches WHERE employee_id IN (SELECT id FROM employees WHERE tenant_id = $1)', [tenantId]);
            await pool.query('DELETE FROM employees WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM devices WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM branches WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM sessions WHERE tenant_id = $1', [tenantId]);
            await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);

            console.log(`[Delete Tenant] ✅ Tenant ${tenantId} eliminado completamente`);

            res.json({
                success: true,
                message: `Tenant "${tenant.business_name}" eliminado exitosamente`,
                deleted: deleteStats
            });

        } catch (error) {
            console.error('[Delete Tenant] Error:', error);
            res.status(500).json({ success: false, error: undefined });
        }
    });

    return { debugRouter, databaseAdminRouter };
};
