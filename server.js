// ═══════════════════════════════════════════════════════════════
// SERVIDOR SOCKET.IO + REST API PARA SYA TORTILLERÍAS
// Con PostgreSQL Database
// ✅ Repartidor system with debts endpoint support
// ✅ FCM notifications filtered by role (admins/encargados only)
// ═══════════════════════════════════════════════════════════════

// 🔴 CRITICAL: Forzar timezone UTC en el servidor
// Sin esto, new Date().toISOString() usa la timezone del sistema (Sydney en Render)
process.env.TZ = 'UTC';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const bodyParser = require('body-parser');
const { pool, initializeDatabase, runMigrations } = require('./database');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Validación de seguridad: Variables obligatorias en producción
if (!JWT_SECRET) {
    console.error('❌ FATAL ERROR: JWT_SECRET no está configurado en las variables de entorno');
    console.error('Por favor, configura JWT_SECRET en Render Dashboard > Environment');
    process.exit(1);
}

if (!process.env.ADMIN_PASSWORD) {
    console.error('⚠️ WARNING: ADMIN_PASSWORD no está configurado. Endpoints admin no funcionarán.');
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

// ✅ SECURITY: Helmet adds secure HTTP headers (XSS protection, clickjacking, etc.)
app.use(helmet());

// ✅ SECURITY: CORS restricted to known origins (was app.use(cors()) — allowed everything)
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, server-to-server)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        // Allow localhost with any port for development
        if (origin.startsWith('http://localhost')) {
            return callback(null, true);
        }
        console.warn(`[Security] CORS blocked origin: ${origin}`);
        return callback(null, false);
    },
    credentials: true
}));
app.use(bodyParser.json({ limit: '5mb' }));  // ✅ SECURITY: Reduced from 10mb (was DoS risk)
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

// Archivos estáticos (anuncios HTML, imágenes, etc.)
app.use('/public', express.static(require('path').join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════
// IMPORTAR RUTAS MODULARES
// ═══════════════════════════════════════════════════════════════

const { authenticateToken } = require('./middleware/auth');
const { requireAdminCredentials } = require('./middleware/adminAuth');
const { createTenantValidationMiddleware } = require('./middleware/deviceAuth');
const { initializeFirebase } = require('./utils/firebaseAdmin');
const notificationHelper = require('./utils/notificationHelper');

// Rutas existentes
const restoreRoutes = require('./routes/restore');
const backupRoutes = require('./routes/backup');
const authRoutes = require('./routes/auth')(pool);
const createRepartidorAssignmentRoutes = require('./routes/repartidor_assignments');
const createRepartidorReturnRoutes = require('./routes/repartidor_returns');
const createRepartidorDebtsRoutes = require('./routes/repartidor_debts');
const createEmployeeDebtsRoutes = require('./routes/employee_debts');
const notificationRoutes = require('./routes/notifications');
const salesRoutes = require('./routes/sales');
const ventasRoutes = require('./routes/ventas')(pool);
const expensesRoutes = require('./routes/expenses');
const shiftsRoutes = require('./routes/shifts');
const purchasesRoutes = require('./routes/purchases');
const suppliersRoutes = require('./routes/suppliers');
const guardianEventsRoutes = require('./routes/guardianEvents');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const depositsRoutes = require('./routes/deposits');
const withdrawalsRoutes = require('./routes/withdrawals');
const newCashCutsRoutes = require('./routes/cash-cuts');
const employeeBranchesRoutes = require('./routes/employee_branches')(pool);
const clienteBranchesRoutes = require('./routes/cliente_branches')(pool);
const employeeRolesRoutes = require('./routes/employee_roles');
const employeesRoutes = require('./routes/employees')(pool);
const customersRoutes = require('./routes/customers');
const productosRoutes = require('./routes/productos');
const categoriasProductosRoutes = require('./routes/categorias_productos');
const creditPaymentsRoutes = require('./routes/credit-payments');
const suspiciousWeighingLogsRoutes = require('./routes/suspiciousWeighingLogs');
const scaleDisconnectionLogsRoutes = require('./routes/scaleDisconnectionLogs');
const guardianRoutes = require('./routes/guardian');
const employeeMetricsRoutes = require('./routes/employeeMetrics');
const cancelacionesRoutes = require('./routes/cancelaciones');
const repartidoresRoutes = require('./routes/repartidores');
const syncDiagnosticsRoutes = require('./routes/sync-diagnostics');
const notificationHistoryRoutes = require('./routes/notification-history');
const notificationPreferencesRoutes = require('./routes/notificationPreferences');
const desktopUpdatesRoutes = require('./routes/desktopUpdates');
const superadminRoutes = require('./routes/superadmin');
const masterAuthRoutes = require('./routes/masterAuth');
const passwordResetRoutes = require('./routes/passwordReset');
const devicesRoutes = require('./routes/devices');
const notasCreditoRoutes = require('./routes/notas_credito');
const preparationModeRoutes = require('./routes/preparation_mode');
const betaEnrollmentRoutes = require('./routes/beta_enrollment');
const transfersRoutes = require('./routes/transfers');
const gpsTrackingRoutes = require('./routes/gps_tracking');
const shiftRequestsRoutes = require('./routes/shift_requests');
const geofenceZonesRoutes = require('./routes/geofence_zones');
const emailDigestRoutes = require('./routes/emailDigest');
const dataResetRoutes = require('./routes/data-reset');
const { processGuardianDigests, initializeDigestSchedules } = require('./jobs/guardianEmailDigest');
const { processLicenseExpiryNotifications } = require('./jobs/licenseExpiryNotifier');
const { purgeExpiredResets } = require('./jobs/dataResetPurge');

// Nuevas rutas extraídas de server.js
const createBranchesRoutes = require('./routes/branches');
const createTelemetryRoutes = require('./routes/telemetry');
const createDebugRoutes = require('./routes/debug');

// Socket.IO modules
const setupSocketAuth = require('./socket/auth');
const setupSocketHandlers = require('./socket/handlers');

// Inicializar Firebase para notificaciones push
initializeFirebase();

// ═══════════════════════════════════════════════════════════════
// REGISTRAR RUTAS PRE-IO (no necesitan Socket.IO)
// ═══════════════════════════════════════════════════════════════

app.use('/api/restore', restoreRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/auth', masterAuthRoutes(pool));
app.use('/api/password-reset', passwordResetRoutes);
app.use('/api/devices', devicesRoutes(pool));
app.use('/api/notifications', notificationRoutes);
app.use('/api/notification-preferences', notificationPreferencesRoutes);
app.use('/api/desktop/updates', desktopUpdatesRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/employee-branches', employeeBranchesRoutes);
app.use('/api/cliente-branches', clienteBranchesRoutes);

// ✅ SECURITY: Create tenant validation middleware for sync endpoints
const validateTenant = createTenantValidationMiddleware(pool);

// Health check
app.get('/', (req, res) => {
    res.send('Socket.IO Server for SYA Tortillerías - Running ✅');
});

app.get('/health', async (req, res) => {
    try {
        // ✅ SECURITY: Simple connectivity check, no stats exposed publicly
        await pool.query('SELECT 1');

        res.json({
            status: 'ok',
            version: '2026-02-08a',
            timestamp: new Date().toISOString(),
            database: 'connected'
        });
    } catch (error) {
        res.status(500).json({ status: 'error', database: 'disconnected' });
    }
});


// ═══════════════════════════════════════════════════════════════
// SOCKET.IO SETUP
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
    maxHttpBufferSize: 1e6, // 1MB - protección contra payloads grandes
    connectionStateRecovery: {},
});

// Make io accessible from routes via req.app.get('io')
app.set('io', io);

let stats = {
    desktopClients: 0,
    mobileClients: 0,
    totalEvents: 0,
    startTime: new Date(),
};

// In-memory stores for real-time status
const guardianStatusByBranch = new Map();
const scaleStatusByBranch = new Map();

// Setup Socket.IO authentication + event handlers
setupSocketAuth(io);
setupSocketHandlers(io, { pool, stats, notificationHelper, scaleStatusByBranch, guardianStatusByBranch });

// ═══════════════════════════════════════════════════════════════
// REGISTRAR RUTAS POST-IO (necesitan Socket.IO)
// ═══════════════════════════════════════════════════════════════

const repartidorAssignmentRoutes = createRepartidorAssignmentRoutes(io);
const repartidorReturnRoutes = createRepartidorReturnRoutes(io);
const repartidorDebtsRoutes = createRepartidorDebtsRoutes(io);
const employeeDebtsRoutes = createEmployeeDebtsRoutes(io);

// Rutas extraídas de server.js
app.use('/api/branches', createBranchesRoutes(pool, io, scaleStatusByBranch));
app.use('/api/telemetry', createTelemetryRoutes(pool));
const { debugRouter, databaseAdminRouter } = createDebugRoutes(pool, io, scaleStatusByBranch);
app.use('/api/debug', debugRouter);
app.use('/api/database', databaseAdminRouter);

// Super Admin routes (necesita io para eventos en tiempo real)
app.use('/api/superadmin', superadminRoutes(pool, io));

// Tenants routes (necesita io para notificar nuevos registros)
const tenantsRoutes = require('./routes/tenants')(pool, io);
app.use('/api/tenants', tenantsRoutes);

app.use('/api/repartidor-assignments', repartidorAssignmentRoutes);
app.use('/api/repartidor-returns', repartidorReturnRoutes);
app.use('/api/repartidor-liquidations', repartidorAssignmentRoutes);
app.use('/api/repartidor-debts', repartidorDebtsRoutes);
app.use('/api/employee-debts', employeeDebtsRoutes);

app.use('/api/sales', salesRoutes(pool, io));
app.use('/api/sales-items', salesRoutes(pool, io));
app.use('/api/ventas', ventasRoutes);
app.use('/api/expenses', expensesRoutes(pool, io));
app.use('/api/shifts', shiftsRoutes(pool, io));
app.use('/api/shift-requests', shiftRequestsRoutes(pool, io));
app.use('/api/cash-cuts', newCashCutsRoutes(pool));
app.use('/api/purchases', purchasesRoutes(pool));
app.use('/api/suppliers', suppliersRoutes(pool));
app.use('/api/guardian-events', guardianEventsRoutes(pool, io));
app.use('/api/dashboard', dashboardRoutes(pool));
app.use('/api/admin', adminRoutes(pool));
app.use('/api/employees', employeesRoutes);
app.use('/api/cancelaciones', cancelacionesRoutes(pool));
app.use('/api/employee-roles', employeeRolesRoutes);
app.use('/api/customers', customersRoutes(pool));
app.use('/api/productos', productosRoutes(pool));
app.use('/api/categorias-productos', categoriasProductosRoutes(pool));
app.use('/api/credit-payments', creditPaymentsRoutes(pool));
app.use('/api/suspicious-weighing-logs', suspiciousWeighingLogsRoutes(pool, io));
app.use('/api/scale-disconnection-logs', scaleDisconnectionLogsRoutes(pool));
app.use('/api/guardian', guardianRoutes(pool, guardianStatusByBranch));
app.use('/api/employee-metrics', employeeMetricsRoutes(pool));
app.use('/api/repartidores', repartidoresRoutes(pool));
app.use('/api/notas-credito', notasCreditoRoutes(pool));
app.use('/api/preparation-mode', preparationModeRoutes(pool, io));
app.use('/api/beta-enrollment', betaEnrollmentRoutes(pool));
app.use('/api/deposits', depositsRoutes(pool));
app.use('/api/withdrawals', withdrawalsRoutes(pool));
app.use('/api/sync-diagnostics', syncDiagnosticsRoutes(pool));
app.use('/api/transfers', transfersRoutes(pool, io));
app.use('/api/gps', gpsTrackingRoutes(pool, io));
app.use('/api/geofence-zones', geofenceZonesRoutes(pool, io));
app.use('/api/notification-history', notificationHistoryRoutes(pool));
app.use('/api/email-digest', emailDigestRoutes);
app.use('/api/data-reset', dataResetRoutes(pool));

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS MISC (pocos, no justifican su propio archivo de ruta)
// ═══════════════════════════════════════════════════════════════

// GET /api/desktop-online — Verifica Desktop conectado en una sucursal
app.get('/api/desktop-online', authenticateToken, (req, res) => {
    const branchId = req.query.branchId || (req.user && req.user.branchId);
    if (!branchId) {
        return res.status(400).json({ success: false, message: 'No se pudo determinar branchId (query param o JWT)' });
    }

    const roomName = `branch_${branchId}`;
    const roomSockets = io.sockets.adapter.rooms.get(roomName);

    let desktopOnline = false;
    let clientTypes = [];
    if (roomSockets) {
        for (const socketId of roomSockets) {
            const s = io.sockets.sockets.get(socketId);
            if (s) {
                clientTypes.push(s.clientType || 'unknown');
                if (s.clientType !== 'mobile') {
                    desktopOnline = true;
                }
            }
        }
    }

    console.log(`[DesktopOnline] JWT branchId=${branchId}, online=${desktopOnline}, clients=[${clientTypes.join(', ')}]`);
    res.json({ online: desktopOnline, branchId });
});

// POST /api/scale-disconnection-logs/close-orphans - Cerrar logs huérfanos
app.post('/api/scale-disconnection-logs/close-orphans', authenticateToken, async (req, res) => {
    try {
        const { branchId } = req.body;
        if (!branchId) {
            return res.status(400).json({ success: false, message: 'branchId requerido' });
        }
        const result = await pool.query(
            `UPDATE scale_disconnection_logs
             SET reconnected_at = NOW(),
                 disconnection_status = 'Reconnected',
                 duration_minutes = EXTRACT(EPOCH FROM (NOW() - disconnected_at)) / 60
             WHERE branch_id = $1 AND reconnected_at IS NULL
             RETURNING id`,
            [branchId]
        );
        console.log(`[SCALE] Cerrados ${result.rows.length} log(s) huérfanos para branch ${branchId} (manual)`);
        res.json({ success: true, closed: result.rows.length });
    } catch (error) {
        console.error('[SCALE] Error cerrando logs huérfanos:', error);
        res.status(500).json({ success: false, message: 'Error cerrando logs' });
    }
});

// Alias routes for backwards compatibility with Desktop client
app.post('/api/sync/cash-cuts', validateTenant, (req, res) => {
    req.url = '/sync';
    req.baseUrl = '/api/cash-cuts';
    newCashCutsRoutes(pool)(req, res);
});

app.post('/api/deposits/sync', validateTenant, (req, res) => {
    req.url = '/sync';
    req.baseUrl = '/api/deposits';
    depositsRoutes(pool)(req, res);
});

app.post('/api/withdrawals/sync', validateTenant, (req, res) => {
    req.url = '/sync';
    req.baseUrl = '/api/withdrawals';
    withdrawalsRoutes(pool)(req, res);
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

            // GPS location cleanup — delete records older than 90 days (runs every 24h)
            setInterval(async () => {
                try {
                    const result = await pool.query(
                        `DELETE FROM repartidor_locations WHERE received_at < NOW() - INTERVAL '90 days'`
                    );
                    if (result.rowCount > 0) {
                        console.log(`[GPS Cleanup] Deleted ${result.rowCount} location records older than 90 days`);
                    }
                } catch (err) {
                    console.error('[GPS Cleanup] Error:', err.message);
                }
            }, 24 * 60 * 60 * 1000); // 24 hours

            // Guardian email digest — initialize schedules for tenants without next_send_at
            initializeDigestSchedules().catch(err =>
                console.error('[GuardianDigest] Init error:', err.message)
            );

            // Cleanup: cerrar sesiones de alistamiento huérfanas (activas > 2h)
            async function cleanupOrphanedPrepModes() {
                try {
                    const { rowCount } = await pool.query(`
                        UPDATE preparation_mode_logs
                        SET status = 'force_closed',
                            deactivated_at = NOW(),
                            duration_seconds = EXTRACT(EPOCH FROM (NOW() - activated_at)),
                            notes = COALESCE(notes, '') || ' [Auto-cerrado al arrancar servidor]'
                        WHERE status = 'active'
                          AND activated_at < NOW() - INTERVAL '2 hours'
                    `);
                    if (rowCount > 0) {
                        console.log(`[PrepMode] Cerradas ${rowCount} sesión(es) huérfana(s) de alistamiento`);
                    }
                } catch (err) {
                    console.error('[PrepMode] Error limpiando huérfanos:', err.message);
                }
            }
            cleanupOrphanedPrepModes();

            // Guardian email digest — check every hour for pending digests
            setInterval(() => {
                processGuardianDigests().catch(err =>
                    console.error('[GuardianDigest] Interval error:', err.message)
                );
            }, 60 * 60 * 1000); // 1 hour

            // License expiry notifications — check every 12 hours
            setInterval(() => {
                processLicenseExpiryNotifications().catch(err =>
                    console.error('[LicenseExpiry] Interval error:', err.message)
                );
            }, 12 * 60 * 60 * 1000); // 12 hours

            // Run license check once on startup (after 30s to let DB init)
            setTimeout(() => {
                processLicenseExpiryNotifications().catch(err =>
                    console.error('[LicenseExpiry] Startup check error:', err.message)
                );
            }, 30000);

            // Data reset purge — check every 24 hours for expired resets to purge
            setInterval(() => {
                purgeExpiredResets().catch(err =>
                    console.error('[DataResetPurge] Interval error:', err.message)
                );
            }, 24 * 60 * 60 * 1000); // 24 hours

            // Run purge check once on startup (after 60s)
            setTimeout(() => {
                purgeExpiredResets().catch(err =>
                    console.error('[DataResetPurge] Startup check error:', err.message)
                );
            }, 60000);
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
