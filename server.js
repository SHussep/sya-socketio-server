// ═══════════════════════════════════════════════════════════════
// SERVIDOR SOCKET.IO + REST API PARA SYA TORTILLERÍAS
// Con PostgreSQL Database
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool, initializeDatabase } = require('./database');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sya-secret-key-change-in-production';

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

// Ver todos los datos de la BD (para debugging)
app.get('/api/database/view', async (req, res) => {
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

// ─────────────────────────────────────────────────────────
// AUTH: Google Signup (desde Desktop)
// ─────────────────────────────────────────────────────────
app.post('/api/auth/google-signup', async (req, res) => {
    try {
        const { idToken, email, displayName, businessName, phoneNumber, address } = req.body;

        console.log('[Google Signup] Request:', { email, businessName });

        // Verificar si ya existe
        const existing = await pool.query(
            'SELECT id FROM tenants WHERE LOWER(email) = LOWER($1)',
            [email]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'El email ya está registrado'
            });
        }

        // Generar TenantCode único
        const tenantCode = `SYA${Date.now().toString().slice(-6)}`;

        // Crear tenant
        const tenantResult = await pool.query(
            `INSERT INTO tenants (tenant_code, business_name, email, phone_number, address,
             subscription_status, subscription_plan, trial_ends_at, max_devices)
             VALUES ($1, $2, $3, $4, $5, 'trial', 'basic', $6, 3)
             RETURNING *`,
            [
                tenantCode,
                businessName,
                email,
                phoneNumber,
                address,
                new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 días
            ]
        );

        const tenant = tenantResult.rows[0];

        // Crear empleado admin
        const hashedPassword = await bcrypt.hash('1234', 10);
        const username = displayName.replace(/\s+/g, '').toLowerCase();

        const employeeResult = await pool.query(
            `INSERT INTO employees (tenant_id, username, full_name, email, password, role, is_active)
             VALUES ($1, $2, $3, $4, $5, 'admin', true)
             RETURNING *`,
            [tenant.id, username, displayName, email, hashedPassword]
        );

        const employee = employeeResult.rows[0];

        // Generar JWT token
        const token = jwt.sign(
            { tenantId: tenant.id, employeeId: employee.id, role: 'admin' },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        console.log('[Google Signup] ✅ Tenant creado:', tenantCode);

        res.json({
            success: true,
            token,
            tenant: {
                id: tenant.id,
                tenantCode: tenant.tenant_code,
                businessName: tenant.business_name,
                subscriptionStatus: tenant.subscription_status,
                subscriptionPlan: tenant.subscription_plan,
                subscriptionEndsAt: tenant.subscription_ends_at,
                trialEndsAt: tenant.trial_ends_at
            }
        });
    } catch (error) {
        console.error('[Google Signup] Error:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
});

// ─────────────────────────────────────────────────────────
// AUTH: Desktop Login
// ─────────────────────────────────────────────────────────
app.post('/api/auth/desktop-login', async (req, res) => {
    try {
        const { tenantCode, username, password } = req.body;

        console.log('[Desktop Login] Request:', { tenantCode, username });

        // Buscar tenant
        const tenantResult = await pool.query(
            'SELECT * FROM tenants WHERE tenant_code = $1',
            [tenantCode]
        );

        if (tenantResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Código de tenant inválido' });
        }

        const tenant = tenantResult.rows[0];

        // Buscar empleado
        const employeeResult = await pool.query(
            'SELECT * FROM employees WHERE tenant_id = $1 AND LOWER(username) = LOWER($2)',
            [tenant.id, username]
        );

        if (employeeResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Usuario no encontrado' });
        }

        const employee = employeeResult.rows[0];

        // Validar password
        const validPassword = await bcrypt.compare(password, employee.password);
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        }

        // Generar token
        const token = jwt.sign(
            { tenantId: tenant.id, employeeId: employee.id, role: employee.role },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        console.log('[Desktop Login] ✅ Login exitoso');

        res.json({
            success: true,
            token,
            tenant: {
                id: tenant.id,
                tenantCode: tenant.tenant_code,
                businessName: tenant.business_name,
                subscriptionStatus: tenant.subscription_status,
                subscriptionPlan: tenant.subscription_plan,
                subscriptionEndsAt: tenant.subscription_ends_at,
                trialEndsAt: tenant.trial_ends_at
            },
            branch: {
                id: 1,
                branchCode: 'BR001',
                name: 'Sucursal Principal'
            },
            user: {
                id: employee.id,
                username: employee.username,
                fullName: employee.full_name,
                email: employee.email,
                role: employee.role
            }
        });
    } catch (error) {
        console.error('[Desktop Login] Error:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
});

// ─────────────────────────────────────────────────────────
// AUTH: Mobile Credentials Login
// ─────────────────────────────────────────────────────────
app.post('/api/auth/mobile-credentials-login', async (req, res) => {
    try {
        const { email, username, password } = req.body;

        console.log('[Mobile Login] Request:', { email, username });

        // Buscar empleado por email
        const employeeResult = await pool.query(
            'SELECT * FROM employees WHERE LOWER(email) = LOWER($1)',
            [email]
        );

        if (employeeResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        }

        const employee = employeeResult.rows[0];

        // Validar password
        const validPassword = await bcrypt.compare(password, employee.password);
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        }

        // Buscar tenant
        const tenantResult = await pool.query(
            'SELECT * FROM tenants WHERE id = $1',
            [employee.tenant_id]
        );

        const tenant = tenantResult.rows[0];

        console.log('[Mobile Login] ✅ Credenciales válidas');

        res.json({
            success: true,
            employee: {
                id: employee.id,
                username: employee.username,
                fullName: employee.full_name,
                email: employee.email,
                role: employee.role
            },
            tenant: {
                id: tenant.id,
                tenantCode: tenant.tenant_code,
                businessName: tenant.business_name
            }
        });
    } catch (error) {
        console.error('[Mobile Login] Error:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
});

// ─────────────────────────────────────────────────────────
// AUTH: Scan QR Code (Mobile vinculación)
// ─────────────────────────────────────────────────────────
app.post('/api/auth/scan-qr', async (req, res) => {
    try {
        const { syncCode, email, deviceId, deviceName } = req.body;

        console.log('[QR Scan] Request:', { syncCode, email, deviceId });

        // Buscar empleado
        const employeeResult = await pool.query(
            'SELECT * FROM employees WHERE LOWER(email) = LOWER($1)',
            [email]
        );

        if (employeeResult.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Usuario no encontrado' });
        }

        const employee = employeeResult.rows[0];

        // Buscar tenant
        const tenantResult = await pool.query(
            'SELECT * FROM tenants WHERE id = $1',
            [employee.tenant_id]
        );

        const tenant = tenantResult.rows[0];

        // Validar límite de dispositivos
        const deviceCountResult = await pool.query(
            'SELECT COUNT(*) FROM devices WHERE tenant_id = $1 AND is_active = true',
            [tenant.id]
        );

        const deviceCount = parseInt(deviceCountResult.rows[0].count);
        const maxDevices = tenant.max_devices || 3;

        if (deviceCount >= maxDevices) {
            return res.status(403).json({
                success: false,
                message: `Límite de dispositivos alcanzado (${maxDevices})`
            });
        }

        // Registrar dispositivo
        await pool.query(
            `INSERT INTO devices (id, name, tenant_id, employee_id, device_type, is_active)
             VALUES ($1, $2, $3, $4, 'mobile', true)
             ON CONFLICT (id) DO UPDATE SET
                name = $2,
                employee_id = $4,
                last_active = CURRENT_TIMESTAMP,
                is_active = true`,
            [deviceId, deviceName, tenant.id, employee.id]
        );

        // Generar tokens
        const accessToken = jwt.sign(
            { tenantId: tenant.id, employeeId: employee.id, deviceId },
            JWT_SECRET,
            { expiresIn: '15m' }
        );

        const refreshToken = jwt.sign(
            { tenantId: tenant.id, employeeId: employee.id, deviceId },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        console.log('[QR Scan] ✅ Dispositivo vinculado');

        res.json({
            success: true,
            accessToken,
            refreshToken,
            employee: {
                id: employee.id,
                username: employee.username,
                fullName: employee.full_name,
                email: employee.email,
                role: employee.role
            },
            tenant: {
                id: tenant.id,
                tenantCode: tenant.tenant_code,
                businessName: tenant.business_name
            },
            branch: {
                id: 1,
                name: 'Sucursal Principal'
            }
        });
    } catch (error) {
        console.error('[QR Scan] Error:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
});

// ═══════════════════════════════════════════════════════════════
// CONFIGURAR SOCKET.IO
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

    socket.on('scale_alert', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        console.log(`[ALERT] Sucursal ${data.branchId}: ${data.eventType} (${data.severity})`);
        io.to(roomName).emit('scale_alert', { ...data, receivedAt: new Date().toISOString() });
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
