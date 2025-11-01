// ═══════════════════════════════════════════════════════════════
// SERVIDOR SOCKET.IO + REST API PARA SYA TORTILLERÍAS
// Con PostgreSQL Database
// ✅ Repartidor system with debts endpoint support
// ═══════════════════════════════════════════════════════════════

// 🔴 CRITICAL: Forzar timezone UTC en el servidor
// Sin esto, new Date().toISOString() usa la timezone del sistema (Sydney en Render)
process.env.TZ = 'UTC';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool, initializeDatabase } = require('./database');
const { runMigrations } = require('./utils/runMigrations');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Validación de seguridad: JWT_SECRET es obligatorio en producción
if (!JWT_SECRET) {
    console.error('❌ FATAL ERROR: JWT_SECRET no está configurado en las variables de entorno');
    console.error('Por favor, configura JWT_SECRET en Render Dashboard > Environment');
    process.exit(1);
}

const ALLOWED_ORIGINS = [
    'http://localhost',
    'https://syatortillerias.com.mx',
    'https://www.syatortillerias.com.mx',
    'https://socket.syatortillerias.com.mx',
];

// ═══════════════════════════════════════════════════════════════
// CONFIGURAR EXPRESS
// ═══════════════════════════════════════════════════════════════

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ═══════════════════════════════════════════════════════════════
// REST API ENDPOINTS
// ═══════════════════════════════════════════════════════════════


// Importar rutas modulares
const restoreRoutes = require('./routes/restore');
const backupRoutes = require('./routes/backup');
const authRoutes = require('./routes/auth')(pool); // Pasar pool al módulo
const createRepartidorAssignmentRoutes = require('./routes/repartidor_assignments'); // Rutas de asignaciones a repartidores
const createRepartidorDebtsRoutes = require('./routes/repartidor_debts'); // Rutas de deudas de repartidores
const notificationRoutes = require('./routes/notifications'); // Rutas de notificaciones FCM
const { initializeFirebase } = require('./utils/firebaseAdmin'); // Firebase Admin SDK
const notificationHelper = require('./utils/notificationHelper');
const { requireAdminCredentials } = require('./middleware/adminAuth'); // Helper para enviar notificaciones en eventos

// NUEVAS RUTAS MODULARES (refactorización de endpoints)
const salesRoutes = require('./routes/sales');
const expensesRoutes = require('./routes/expenses');
const shiftsRoutes = require('./routes/shifts');
const cashCutsRoutes = require('./routes/cashCuts');
const purchasesRoutes = require('./routes/purchases');
const guardianEventsRoutes = require('./routes/guardianEvents');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const depositsRoutes = require('./routes/deposits');
const withdrawalsRoutes = require('./routes/withdrawals');
const newCashCutsRoutes = require('./routes/cash-cuts');

// Inline employee sync endpoint (avoids file loading issues)
const employeesRoutes = (() => {
    const express = require('express');
    const router = express.Router();

    router.post('/', async (req, res) => {
        const client = await pool.connect();
        try {
            const { tenantId, branchId, fullName, username, email, roleId, isActive, isOwner, mainBranchId, googleUserIdentifier } = req.body;

            console.log(`[Employees/Sync] 🔄 Sincronizando: ${fullName} (${username})`);

            if (!tenantId || !fullName || !username || !email) {
                return res.status(400).json({ success: false, message: 'Faltan campos requeridos' });
            }

            // Check if exists
            const existingResult = await client.query(
                `SELECT id FROM employees WHERE (LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)) AND tenant_id = $3`,
                [email, username, tenantId]
            );

            if (existingResult.rows.length > 0) {
                // Update
                const result = await client.query(
                    `UPDATE employees SET full_name = $1, main_branch_id = COALESCE($2, main_branch_id), is_active = COALESCE($3, is_active), updated_at = NOW() WHERE id = $4 AND tenant_id = $5 RETURNING *`,
                    [fullName, branchId || mainBranchId, isActive !== false, existingResult.rows[0].id, tenantId]
                );
                const emp = result.rows[0];
                console.log(`[Employees/Sync] ✅ Actualizado: ${fullName} (ID: ${emp.id})`);
                return res.json({ success: true, data: emp, id: emp.id, employeeId: emp.id, remoteId: emp.id });
            }

            // Create
            const result = await client.query(
                `INSERT INTO employees (tenant_id, full_name, username, email, main_branch_id, is_active, updated_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *`,
                [tenantId, fullName, username, email, branchId || mainBranchId, isActive !== false]
            );
            const emp = result.rows[0];
            console.log(`[Employees/Sync] ✅ Creado: ${fullName} (ID: ${emp.id})`);
            res.json({ success: true, data: emp, id: emp.id, employeeId: emp.id, remoteId: emp.id });

        } catch (error) {
            console.error('[Employees/Sync] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al sincronizar empleado', error: error.message });
        } finally {
            client.release();
        }
    });

    router.get('/', async (req, res) => {
        try {
            const { tenantId } = req.query;
            if (!tenantId) return res.status(400).json({ success: false, message: 'Se requiere tenantId' });

            const result = await pool.query(
                `SELECT id, tenant_id, full_name, username, email, is_active, created_at, updated_at FROM employees WHERE tenant_id = $1 ORDER BY full_name ASC`,
                [tenantId]
            );
            res.json({ success: true, data: result.rows });
        } catch (error) {
            console.error('[Employees] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener empleados' });
        }
    });

    return router;
})();

// Inicializar Firebase para notificaciones push
initializeFirebase();

// Registrar rutas
app.use('/api/restore', restoreRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/auth', authRoutes); // Registrar rutas de autenticación
app.use('/api/notifications', notificationRoutes); // Registrar rutas de notificaciones

// Health check
app.get('/', (req, res) => {
    res.send('Socket.IO Server for SYA Tortillerías - Running ✅');
});

app.get('/health', async (req, res) => {
    try {
        const tenants = await pool.query('SELECT COUNT(*) FROM tenants');
        const employees = await pool.query('SELECT COUNT(*) FROM employees');
        const devices = await pool.query('SELECT COUNT(*) FROM devices');

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: 'connected',
            stats: {
                tenants: parseInt(tenants.rows[0].count),
                employees: parseInt(employees.rows[0].count),
                devices: parseInt(devices.rows[0].count),
            }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// 🔍 Diagnostic endpoint to verify timezone configuration
app.get('/timezone-diagnostic', (req, res) => {
    try {
        const now = new Date();
        const tzEnvVar = process.env.TZ;

        // Get current system timezone offset
        const offset = -now.getTimezoneOffset();
        const offsetHours = Math.floor(Math.abs(offset) / 60);
        const offsetMinutes = Math.abs(offset) % 60;
        const offsetSign = offset >= 0 ? '+' : '-';
        const tzOffset = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;

        // Test a known timestamp
        const testDate = new Date('2025-10-26T19:35:13.276Z'); // Known Sydney time

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
        res.status(500).json({ status: 'error', message: error.message, stack: error.stack });
    }
});

// Ver todos los datos de la BD (para debugging)
app.get('/api/database/view', requireAdminCredentials, async (req, res) => {
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// Arreglar tenants antiguos sin subscription_id
app.post('/api/database/fix-old-tenants', requireAdminCredentials, async (req, res) => {
    try {
        // Obtener subscription Basic
        const subResult = await pool.query("SELECT id FROM subscriptions WHERE name = 'Basic' LIMIT 1");
        if (subResult.rows.length === 0) {
            return res.status(500).json({ success: false, message: 'Plan Basic no encontrado' });
        }
        const basicId = subResult.rows[0].id;

        // Actualizar tenants sin subscription_id
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// Eliminar tenant y todos sus datos relacionados
app.post('/api/database/delete-tenant-by-email', requireAdminCredentials, async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email es requerido' });
        }

        console.log(`[Delete Tenant] Buscando tenant con email: ${email}`);

        // Buscar el tenant por email
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

        // Obtener estadísticas antes de borrar
        const stats = {
            tenant: tenant,
            branches: (await pool.query('SELECT COUNT(*) FROM branches WHERE tenant_id = $1', [tenantId])).rows[0].count,
            employees: (await pool.query('SELECT COUNT(*) FROM employees WHERE tenant_id = $1', [tenantId])).rows[0].count,
            sales: (await pool.query('SELECT COUNT(*) FROM sales WHERE tenant_id = $1', [tenantId])).rows[0].count,
            expenses: (await pool.query('SELECT COUNT(*) FROM expenses WHERE tenant_id = $1', [tenantId])).rows[0].count,
            shifts: (await pool.query('SELECT COUNT(*) FROM shifts WHERE tenant_id = $1', [tenantId])).rows[0].count,
            backups: (await pool.query('SELECT COUNT(*) FROM backup_metadata WHERE tenant_id = $1', [tenantId])).rows[0].count
        };

        console.log(`[Delete Tenant] Eliminando datos: ${JSON.stringify(stats)}`);

        // Eliminar en orden correcto (respetando foreign keys)
        await pool.query('DELETE FROM guardian_events WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM cash_cuts WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM shifts WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM purchases WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM sales WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM expenses WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM backup_metadata WHERE tenant_id = $1', [tenantId]);
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
            deleted: stats
        });

    } catch (error) {
        console.error('[Delete Tenant] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─────────────────────────────────────────────────────────
// AUTH: Google Signup (desde Desktop)
// ─────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════
// MODULAR ROUTES - Move all REST endpoints to modular routes
// ═══════════════════════════════════════════════════════════════

const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ['GET', 'POST'],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
});

let stats = {
    desktopClients: 0,
    mobileClients: 0,
    totalEvents: 0,
    startTime: new Date(),
};

// ═══════════════════════════════════════════════════════════════
// INICIALIZAR RUTAS CON SOCKET.IO
// ═══════════════════════════════════════════════════════════════
const repartidorAssignmentRoutes = createRepartidorAssignmentRoutes(io);
const repartidorDebtsRoutes = createRepartidorDebtsRoutes(io);
app.use('/api/repartidor-assignments', repartidorAssignmentRoutes);
app.use('/api/repartidor-liquidations', repartidorAssignmentRoutes);
app.use('/api/repartidor-debts', repartidorDebtsRoutes);

// Registrar nuevas rutas modulares
// Note: Mount routes under their respective base paths to avoid conflicts
app.use('/api/sales', salesRoutes(pool));
app.use('/api/sales-items', salesRoutes(pool));
app.use('/api/expenses', expensesRoutes(pool));
app.use('/api/shifts', shiftsRoutes(pool));
app.use('/api/cash-cuts', cashCutsRoutes(pool));
app.use('/api/purchases', purchasesRoutes(pool));
app.use('/api/guardian-events', guardianEventsRoutes(pool, io)); // Requires io for Socket.IO
app.use('/api/dashboard', dashboardRoutes(pool));
app.use('/api/admin', adminRoutes(pool)); // Rutas de administración
app.use('/api/employees', employeesRoutes); // Rutas de sincronización de empleados desde Desktop

// FASE 1: Cash Management Routes (Deposits, Withdrawals, Cash Cuts)
app.use('/api/deposits', depositsRoutes(pool));
app.use('/api/withdrawals', withdrawalsRoutes(pool));
app.use('/api/cash-cuts-new', newCashCutsRoutes(pool)); // New comprehensive cash cuts endpoint

// Sync endpoints are mounted at their service-specific paths
// e.g., /api/sales/sync, /api/expenses/sync, /api/cash-cuts/sync, etc.
// This avoids the /api/sync conflict that was happening before

// Alias routes for backwards compatibility with Desktop client
// Desktop expects /api/sync/cash-cuts but we have /api/cash-cuts/sync
app.post('/api/sync/cash-cuts', (req, res) => {
    // Forward to the correct endpoint
    req.url = '/sync';
    req.baseUrl = '/api/cash-cuts';
    cashCutsRoutes(pool)(req, res);
});

// Alias routes for FASE 1 cash management endpoints
app.post('/api/deposits/sync', (req, res) => {
    req.url = '/sync';
    req.baseUrl = '/api/deposits';
    depositsRoutes(pool)(req, res);
});

app.post('/api/withdrawals/sync', (req, res) => {
    req.url = '/sync';
    req.baseUrl = '/api/withdrawals';
    withdrawalsRoutes(pool)(req, res);
});

app.post('/api/cash-cuts-new/sync', (req, res) => {
    req.url = '/sync';
    req.baseUrl = '/api/cash-cuts-new';
    newCashCutsRoutes(pool)(req, res);
});

// ═══════════════════════════════════════════════════════════════
// AUTHENTICATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token inválido o expirado' });
        }
        req.user = user;
        next();
    });
}

// ═══════════════════════════════════════════════════════════════
// BRANCHES ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// GET /api/branches - Obtener sucursales del tenant (autenticado)
app.get('/api/branches', authenticateToken, async (req, res) => {
    try {
        const { tenantId, employeeId } = req.user;

        // Obtener sucursales del empleado (a las que tiene acceso)
        const result = await pool.query(
            `SELECT b.id, b.branch_code as code, b.name, b.address, b.phone_number
             FROM branches b
             INNER JOIN employee_branches eb ON b.id = eb.branch_id
             WHERE eb.employee_id = $1 AND b.tenant_id = $2 AND b.is_active = true
             ORDER BY b.created_at ASC`,
            [employeeId, tenantId]
        );

        console.log(`[Branches] 📋 Sucursales para employee ${employeeId}: ${result.rows.length}`);

        res.json({
            success: true,
            branches: result.rows
        });
    } catch (error) {
        console.error('[Branches] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener sucursales' });
    }
});

// POST /api/branches - Crear sucursal
app.post('/api/branches', authenticateToken, async (req, res) => {
    try {
        const { tenantId } = req.user;
        const { name, address, phoneNumber, timezone } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, message: 'name es requerido' });
        }

        // Obtener tenant_code para generar branch_code
        const tenantResult = await pool.query('SELECT tenant_code FROM tenants WHERE id = $1', [tenantId]);
        if (tenantResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Tenant no encontrado' });
        }

        // Contar sucursales existentes
        const countResult = await pool.query(
            'SELECT COUNT(*) as count FROM branches WHERE tenant_id = $1',
            [tenantId]
        );
        const branchCount = parseInt(countResult.rows[0].count);

        // Generar branch_code único
        const branchCode = `${tenantResult.rows[0].tenant_code}-BR${branchCount + 1}`;

        const result = await pool.query(
            `INSERT INTO branches (tenant_id, branch_code, name, address, phone_number, timezone, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, true, NOW(), NOW())
             RETURNING *`,
            [tenantId, branchCode, name, address || null, phoneNumber || null, timezone || 'America/Mexico_City']
        );

        console.log(`[Branches] OK Sucursal creada: ${name} (Code: ${branchCode})`);
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[Branches] Error:', error);
        res.status(500).json({ success: false, message: 'Error al crear sucursal' });
    }
});

// GET /api/branches - Listar sucursales
app.get('/api/branches', authenticateToken, async (req, res) => {
    try {
        const { tenantId } = req.user;

        const result = await pool.query(
            `SELECT * FROM branches WHERE tenant_id = $1 AND is_active = true ORDER BY created_at DESC`,
            [tenantId]
        );

        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[Branches] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener sucursales' });
    }
});
io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] Cliente conectado: ${socket.id}`);

    socket.on('join_branch', (branchId) => {
        const roomName = `branch_${branchId}`;
        socket.join(roomName);
        socket.branchId = branchId;
        socket.clientType = 'unknown';
        console.log(`[JOIN] Cliente ${socket.id} → ${roomName}`);
        socket.emit('joined_branch', { branchId, message: `Conectado a sucursal ${branchId}` });
    });

    socket.on('identify_client', (data) => {
        socket.clientType = data.type;
        socket.deviceInfo = data.deviceInfo || {};
        if (data.type === 'desktop') stats.desktopClients++;
        else if (data.type === 'mobile') stats.mobileClients++;
        console.log(`[IDENTIFY] ${socket.id} → ${data.type} (Sucursal: ${socket.branchId})`);
    });

    socket.on('scale_alert', async (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;

        // DEBUG: Mostrar todos los datos recibidos
        console.log(`[ALERT] 🔍 Datos recibidos:`, {
            branchId: data.branchId,
            eventType: data.eventType,
            severity: data.severity,
            employeeName: data.employeeName
        });

        console.log(`[ALERT] Sucursal ${data.branchId}: ${data.eventType} (${data.severity})`);
        console.log(`[ALERT] Emitiendo a room: ${roomName}`);

        // ⚠️ IMPORTANTE: NO guardar en BD aquí ni enviar FCM
        // Desktop ya envía los eventos via REST API (/api/guardian-events)
        // que se encarga del guardado en BD y envío de FCM
        // Solo emitimos aquí para eventos en TIEMPO REAL (actualizaciones que no fueron guardadas en Desktop)

        // ✅ Emitir evento en tiempo real a la app móvil (para actualizaciones instantáneas)
        console.log(`[ALERT] 📡 Emitiendo evento en tiempo real (scale_alert) a branch_${data.branchId}`);
        io.to(roomName).emit('scale_alert', {
            ...data,
            receivedAt: new Date().toISOString(),
            source: 'realtime'  // Indicar que es un evento en tiempo real
        });
    });

    socket.on('scale_disconnected', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        console.log(`[SCALE] Sucursal ${data.branchId}: Báscula desconectada`);
        io.to(roomName).emit('scale_disconnected', { ...data, receivedAt: new Date().toISOString() });
    });

    socket.on('scale_connected', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        console.log(`[SCALE] Sucursal ${data.branchId}: Báscula conectada`);
        io.to(roomName).emit('scale_connected', { ...data, receivedAt: new Date().toISOString() });
    });

    socket.on('sale_completed', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        console.log(`[SALE] Sucursal ${data.branchId}: Ticket #${data.ticketNumber} - $${data.total}`);
        io.to(roomName).emit('sale_completed', { ...data, receivedAt: new Date().toISOString() });
    });

    socket.on('weight_update', (data) => {
        const roomName = `branch_${data.branchId}`;
        io.to(roomName).emit('weight_update', { ...data, receivedAt: new Date().toISOString() });
    });

    socket.on('shift_started', async (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        console.log(`[SHIFT] Sucursal ${data.branchId}: ${data.employeeName} inició turno - $${data.initialAmount}`);

        // Broadcast al escritorio y móviles en la sucursal
        io.to(roomName).emit('shift_started', { ...data, receivedAt: new Date().toISOString() });

        // NUEVO: Sincronizar con PostgreSQL y enviar notificaciones FCM
        try {
            // Actualizar shift en PostgreSQL: marcar como abierto
            const updateShiftQuery = `
                UPDATE shifts
                SET is_cash_cut_open = true,
                    start_time = $1,
                    updated_at = NOW()
                WHERE id = $2 AND tenant_id = $3
                RETURNING id;
            `;

            const shiftResult = await pool.query(updateShiftQuery, [
                data.startTime || new Date().toISOString(),
                data.shiftId,
                data.tenantId
            ]);

            if (shiftResult.rows.length > 0) {
                console.log(`[SHIFT] ✅ Turno #${data.shiftId} actualizado en PostgreSQL`);

                // Enviar notificación FCM a todos los repartidores de la sucursal
                await notificationHelper.notifyShiftStarted(data.branchId, {
                    employeeName: data.employeeName,
                    branchName: data.branchName,
                    initialAmount: data.initialAmount,
                    startTime: data.startTime
                });

                console.log(`[FCM] 📨 Notificación de inicio de turno enviada a sucursal ${data.branchId}`);
            } else {
                console.log(`[SHIFT] ⚠️ No se encontró turno #${data.shiftId} en PostgreSQL`);
            }
        } catch (error) {
            console.error(`[SHIFT] ❌ Error sincronizando turno con PostgreSQL:`, error.message);
            // No fallar el broadcast si hay error en la sincronización
        }
    });

    socket.on('shift_ended', async (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        console.log(`[SHIFT] Sucursal ${data.branchId}: ${data.employeeName} cerró turno - Diferencia: $${data.difference}`);
        console.log(`[SHIFT] DEBUG - Datos recibidos: shiftId=${data.shiftId}, tenantId=${data.tenantId}, branchId=${data.branchId}, endTime=${data.endTime}`);
        console.log(`[SHIFT] DEBUG - Desglose: cash=$${data.totalCashSales}, card=$${data.totalCardSales}, credit=$${data.totalCreditSales}`);

        // Contar clientes conectados en este room
        const clientsInRoom = io.sockets.adapter.rooms.get(roomName);
        const clientCount = clientsInRoom ? clientsInRoom.size : 0;
        console.log(`[SHIFT] 📡 Room '${roomName}' tiene ${clientCount} clientes conectados (socket.id=${socket.id}, clientType=${socket.clientType})`);

        // Broadcast al escritorio y móviles en la sucursal
        console.log(`[SHIFT] 📤 Retransmitiendo shift_ended a ${roomName}...`);
        io.to(roomName).emit('shift_ended', { ...data, receivedAt: new Date().toISOString() });
        console.log(`[SHIFT] ✅ shift_ended retransmitido a ${roomName}`);

        // NUEVO: Sincronizar con PostgreSQL y enviar notificaciones FCM
        try {
            // Actualizar shift en PostgreSQL: marcar como cerrado
            const updateShiftQuery = `
                UPDATE shifts
                SET is_cash_cut_open = false,
                    end_time = $1,
                    updated_at = NOW()
                WHERE id = $2 AND tenant_id = $3
                RETURNING id;
            `;

            console.log(`[SHIFT] DEBUG - Ejecutando UPDATE con: endTime=$1:${data.endTime || new Date().toISOString()}, shiftId=$2:${data.shiftId}, tenantId=$3:${data.tenantId}`);

            const shiftResult = await pool.query(updateShiftQuery, [
                data.endTime || new Date().toISOString(),
                data.shiftId,
                data.tenantId
            ]);

            console.log(`[SHIFT] DEBUG - Resultado del UPDATE: rows.length=${shiftResult.rows.length}, rows=${JSON.stringify(shiftResult.rows)}`);

            if (shiftResult.rows.length > 0) {
                console.log(`[SHIFT] ✅ Turno #${data.shiftId} actualizado en PostgreSQL`);

                // Enviar notificación FCM a todos los repartidores de la sucursal
                const statusIcon = data.difference === 0
                    ? '✅'
                    : data.difference > 0
                        ? '💰'
                        : '⚠️';

                const differenceText = data.difference === 0
                    ? 'Sin diferencia'
                    : data.difference > 0
                        ? `Sobrante: $${Math.abs(data.difference).toFixed(2)}`
                        : `Faltante: $${Math.abs(data.difference).toFixed(2)}`;

                await notificationHelper.notifyShiftEnded(data.branchId, {
                    employeeName: data.employeeName,
                    branchName: data.branchName,
                    difference: data.difference,
                    countedCash: data.countedCash,
                    expectedCash: data.expectedCashInDrawer
                });

                console.log(`[FCM] 📨 Notificación de cierre de turno enviada a sucursal ${data.branchId}`);
            } else {
                console.log(`[SHIFT] ⚠️ No se encontró turno #${data.shiftId} en PostgreSQL`);
            }
        } catch (error) {
            console.error(`[SHIFT] ❌ Error sincronizando turno con PostgreSQL:`, error.message);
            // No fallar el broadcast si hay error en la sincronización
        }
    });

    socket.on('get_stats', () => {
        socket.emit('stats', {
            ...stats,
            connectedClients: io.sockets.sockets.size,
            uptime: Math.floor((Date.now() - stats.startTime) / 1000),
        });
    });

    socket.on('disconnect', () => {
        if (socket.clientType === 'desktop') stats.desktopClients = Math.max(0, stats.desktopClients - 1);
        else if (socket.clientType === 'mobile') stats.mobileClients = Math.max(0, stats.mobileClients - 1);
        console.log(`[DISCONNECT] ${socket.id} (${socket.clientType})`);
    });
});

// ═══════════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════

async function startServer() {
    try {
        // Initialize database
        await initializeDatabase();

        // Run migrations
        await runMigrations();

        // Start server
        server.listen(PORT, () => {
            console.log('\n╔══════════════════════════════════════════════════════════╗');
            console.log('║   🚀 Socket.IO + REST API - SYA Tortillerías            ║');
            console.log('║   📊 PostgreSQL Database                                 ║');
            console.log('╚══════════════════════════════════════════════════════════╝\n');
            console.log(`✅ Servidor corriendo en puerto ${PORT}`);
            console.log(`🌐 REST API: http://localhost:${PORT}/api`);
            console.log(`🔌 Socket.IO: http://localhost:${PORT}`);
            console.log(`💾 Database: PostgreSQL`);
            console.log(`📅 Iniciado: ${stats.startTime.toLocaleString('es-MX')}\n`);
            console.log('📋 Endpoints disponibles:');
            console.log('   POST /api/auth/google-signup');
            console.log('   POST /api/auth/desktop-login');
            console.log('   POST /api/auth/mobile-credentials-login');
            console.log('   POST /api/auth/scan-qr');
            console.log('   GET  /health\n');
        });
    } catch (error) {
        console.error('❌ Error starting server:', error);
        process.exit(1);
    }
}

startServer();

// Manejo de errores
process.on('uncaughtException', (err) => {
    console.error('[ERROR] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[ERROR] Unhandled Rejection:', reason);
});
