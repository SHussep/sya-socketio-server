// ═══════════════════════════════════════════════════════════════
// SERVIDOR SOCKET.IO + REST API PARA SYA TORTILLERÍAS
// Dominio: syatortillerias.com.mx
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
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
// IN-MEMORY DATABASE (Para producción, usar MongoDB/PostgreSQL)
// ═══════════════════════════════════════════════════════════════

const db = {
    tenants: [],
    employees: [],
    devices: [],
    sessions: [],
    qrCodes: [], // QR codes activos
};

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

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        stats: {
            tenants: db.tenants.length,
            employees: db.employees.length,
            devices: db.devices.length,
            sessions: db.sessions.length,
        }
    });
});

// ─────────────────────────────────────────────────────────
// AUTH: Google Signup (desde Desktop)
// ─────────────────────────────────────────────────────────
app.post('/api/auth/google-signup', async (req, res) => {
    try {
        const { idToken, email, displayName, businessName, phoneNumber, address } = req.body;

        console.log('[Google Signup] Request:', { email, businessName });

        // Verificar si ya existe
        if (db.tenants.find(t => t.email.toLowerCase() === email.toLowerCase())) {
            return res.status(409).json({
                success: false,
                message: 'El email ya está registrado'
            });
        }

        // Generar TenantCode único
        const tenantCode = `SYA${Date.now().toString().slice(-6)}`;

        // Crear tenant
        const tenant = {
            id: db.tenants.length + 1,
            tenantCode,
            businessName,
            email,
            phoneNumber,
            address,
            subscriptionStatus: 'trial',
            subscriptionPlan: 'basic',
            subscriptionEndsAt: null,
            trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 días
            maxDevices: 3,
            createdAt: new Date().toISOString()
        };

        db.tenants.push(tenant);

        // Crear empleado admin
        const hashedPassword = await bcrypt.hash('1234', 10); // Password por defecto

        const employee = {
            id: db.employees.length + 1,
            tenantId: tenant.id,
            username: displayName.replace(/\s+/g, '').toLowerCase(),
            fullName: displayName,
            email,
            password: hashedPassword,
            role: 'admin',
            isActive: true,
            createdAt: new Date().toISOString()
        };

        db.employees.push(employee);

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
                tenantCode: tenant.tenantCode,
                businessName: tenant.businessName,
                subscriptionStatus: tenant.subscriptionStatus,
                subscriptionPlan: tenant.subscriptionPlan,
                subscriptionEndsAt: tenant.subscriptionEndsAt,
                trialEndsAt: tenant.trialEndsAt
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
        const tenant = db.tenants.find(t => t.tenantCode === tenantCode);
        if (!tenant) {
            return res.status(401).json({ success: false, message: 'Código de tenant inválido' });
        }

        // Buscar empleado
        const employee = db.employees.find(e =>
            e.tenantId === tenant.id &&
            e.username.toLowerCase() === username.toLowerCase()
        );

        if (!employee) {
            return res.status(401).json({ success: false, message: 'Usuario no encontrado' });
        }

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
                tenantCode: tenant.tenantCode,
                businessName: tenant.businessName,
                subscriptionStatus: tenant.subscriptionStatus,
                subscriptionPlan: tenant.subscriptionPlan,
                subscriptionEndsAt: tenant.subscriptionEndsAt,
                trialEndsAt: tenant.trialEndsAt
            },
            branch: {
                id: 1,
                branchCode: 'BR001',
                name: 'Sucursal Principal'
            },
            user: {
                id: employee.id,
                username: employee.username,
                fullName: employee.fullName,
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
        const employee = db.employees.find(e => e.email.toLowerCase() === email.toLowerCase());

        if (!employee) {
            return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        }

        // Validar password
        const validPassword = await bcrypt.compare(password, employee.password);
        if (!validPassword) {
            return res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        }

        // Buscar tenant
        const tenant = db.tenants.find(t => t.id === employee.tenantId);

        console.log('[Mobile Login] ✅ Credenciales válidas');

        res.json({
            success: true,
            employee: {
                id: employee.id,
                username: employee.username,
                fullName: employee.fullName,
                email: employee.email,
                role: employee.role
            },
            tenant: {
                id: tenant.id,
                tenantCode: tenant.tenantCode,
                businessName: tenant.businessName
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
        const employee = db.employees.find(e => e.email.toLowerCase() === email.toLowerCase());

        if (!employee) {
            return res.status(401).json({ success: false, message: 'Usuario no encontrado' });
        }

        const tenant = db.tenants.find(t => t.id === employee.tenantId);

        // Validar límite de dispositivos
        const deviceCount = db.devices.filter(d => d.tenantId === tenant.id).length;
        const maxDevices = tenant.maxDevices || 3;

        if (deviceCount >= maxDevices) {
            return res.status(403).json({
                success: false,
                message: `Límite de dispositivos alcanzado (${maxDevices})`
            });
        }

        // Registrar dispositivo
        db.devices.push({
            id: deviceId,
            name: deviceName,
            tenantId: tenant.id,
            employeeId: employee.id,
            linkedAt: new Date().toISOString()
        });

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
                fullName: employee.fullName,
                email: employee.email,
                role: employee.role
            },
            tenant: {
                id: tenant.id,
                tenantCode: tenant.tenantCode,
                businessName: tenant.businessName
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

server.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║   🚀 Socket.IO + REST API - SYA Tortillerías            ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    console.log(`✅ Servidor corriendo en puerto ${PORT}`);
    console.log(`🌐 REST API: http://localhost:${PORT}/api`);
    console.log(`🔌 Socket.IO: http://localhost:${PORT}`);
    console.log(`📅 Iniciado: ${stats.startTime.toLocaleString('es-MX')}\n`);
    console.log('📋 Endpoints disponibles:');
    console.log('   POST /api/auth/google-signup');
    console.log('   POST /api/auth/desktop-login');
    console.log('   POST /api/auth/mobile-credentials-login');
    console.log('   POST /api/auth/scan-qr');
    console.log('   GET  /health\n');
});

// Manejo de errores
process.on('uncaughtException', (err) => {
    console.error('[ERROR] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[ERROR] Unhandled Rejection:', reason);
});
