// ═══════════════════════════════════════════════════════════════
// SERVIDOR SOCKET.IO PARA SYA TORTILLERÍAS - HOSTINGER
// Dominio: syatortillerias.com.mx
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = [
    'http://localhost',
    'https://syatortillerias.com.mx',
    'https://www.syatortillerias.com.mx',
    'https://socket.syatortillerias.com.mx',
];

// Crear servidor HTTP
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Socket.IO Server for SYA Tortillerías - Running ✅');
});

// Configurar Socket.IO con CORS
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

// ═══════════════════════════════════════════════════════════════
// ESTADÍSTICAS Y MONITOREO
// ═══════════════════════════════════════════════════════════════

let stats = {
    desktopClients: 0,
    mobileClients: 0,
    totalEvents: 0,
    startTime: new Date(),
};

// ═══════════════════════════════════════════════════════════════
// MANEJO DE CONEXIONES
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] Cliente conectado: ${socket.id}`);

    // ─────────────────────────────────────────────────────────
    // 1. CLIENTE SE UNE A SU SUCURSAL
    // ─────────────────────────────────────────────────────────
    socket.on('join_branch', (branchId) => {
        const roomName = `branch_${branchId}`;
        socket.join(roomName);

        socket.branchId = branchId;
        socket.clientType = 'unknown';

        console.log(`[JOIN] Cliente ${socket.id} → ${roomName}`);

        // Notificar al cliente que se unió correctamente
        socket.emit('joined_branch', {
            branchId,
            message: `Conectado a sucursal ${branchId}`
        });
    });

    // ─────────────────────────────────────────────────────────
    // 2. IDENTIFICAR TIPO DE CLIENTE (Desktop o Mobile)
    // ─────────────────────────────────────────────────────────
    socket.on('identify_client', (data) => {
        socket.clientType = data.type; // 'desktop' o 'mobile'
        socket.deviceInfo = data.deviceInfo || {};

        if (data.type === 'desktop') {
            stats.desktopClients++;
        } else if (data.type === 'mobile') {
            stats.mobileClients++;
        }

        console.log(`[IDENTIFY] ${socket.id} → ${data.type} (Sucursal: ${socket.branchId})`);
    });

    // ─────────────────────────────────────────────────────────
    // 3. EVENTOS DESDE DESKTOP → REDISTRIBUIR A MÓVILES
    // ─────────────────────────────────────────────────────────

    // 🔔 Alerta de báscula
    socket.on('scale_alert', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;

        console.log(`[ALERT] Sucursal ${data.branchId}: ${data.eventType} (${data.severity})`);

        // Reenviar SOLO a clientes móviles de la misma sucursal
        io.to(roomName).emit('scale_alert', {
            ...data,
            receivedAt: new Date().toISOString(),
        });
    });

    // 🔌 Báscula desconectada
    socket.on('scale_disconnected', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;

        console.log(`[SCALE] Sucursal ${data.branchId}: Báscula desconectada`);

        io.to(roomName).emit('scale_disconnected', {
            ...data,
            receivedAt: new Date().toISOString(),
        });
    });

    // ✅ Báscula conectada
    socket.on('scale_connected', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;

        console.log(`[SCALE] Sucursal ${data.branchId}: Báscula conectada`);

        io.to(roomName).emit('scale_connected', {
            ...data,
            receivedAt: new Date().toISOString(),
        });
    });

    // 💰 Venta completada
    socket.on('sale_completed', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;

        console.log(`[SALE] Sucursal ${data.branchId}: Ticket #${data.ticketNumber} - $${data.total}`);

        io.to(roomName).emit('sale_completed', {
            ...data,
            receivedAt: new Date().toISOString(),
        });
    });

    // ⚖️ Actualización de peso (opcional, puede generar mucho tráfico)
    socket.on('weight_update', (data) => {
        const roomName = `branch_${data.branchId}`;

        // No incrementar stats (demasiado frecuente)
        // No hacer log (muy verbose)

        io.to(roomName).emit('weight_update', {
            ...data,
            receivedAt: new Date().toISOString(),
        });
    });

    // ─────────────────────────────────────────────────────────
    // 4. SOLICITAR ESTADÍSTICAS DEL SERVIDOR
    // ─────────────────────────────────────────────────────────
    socket.on('get_stats', () => {
        socket.emit('stats', {
            ...stats,
            connectedClients: io.sockets.sockets.size,
            uptime: Math.floor((Date.now() - stats.startTime) / 1000), // segundos
        });
    });

    // ─────────────────────────────────────────────────────────
    // 5. DESCONEXIÓN
    // ─────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        if (socket.clientType === 'desktop') {
            stats.desktopClients = Math.max(0, stats.desktopClients - 1);
        } else if (socket.clientType === 'mobile') {
            stats.mobileClients = Math.max(0, stats.mobileClients - 1);
        }

        console.log(`[DISCONNECT] ${socket.id} (${socket.clientType})`);
    });
});

// ═══════════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ═══════════════════════════════════════════════════════════════

server.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║   🚀 Socket.IO Server - SYA Tortillerías                ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    console.log(`✅ Servidor corriendo en puerto ${PORT}`);
    console.log(`🌐 Dominio: syatortillerias.com.mx`);
    console.log(`📅 Iniciado: ${stats.startTime.toLocaleString('es-MX')}\n`);
});

// Manejo de errores
process.on('uncaughtException', (err) => {
    console.error('[ERROR] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[ERROR] Unhandled Rejection:', reason);
});
