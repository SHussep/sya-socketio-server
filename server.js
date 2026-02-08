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
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool, initializeDatabase, runMigrations } = require('./database');
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
app.use(bodyParser.json({ limit: '10mb' }));  // Aumentado para soportar imágenes Base64 de productos
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// ═══════════════════════════════════════════════════════════════
// REST API ENDPOINTS
// ═══════════════════════════════════════════════════════════════


// Importar rutas modulares
const restoreRoutes = require('./routes/restore');
const backupRoutes = require('./routes/backup');
const authRoutes = require('./routes/auth')(pool); // Pasar pool al módulo
// tenantsRoutes se inicializa después de crear io (necesita Socket.IO)
const createRepartidorAssignmentRoutes = require('./routes/repartidor_assignments'); // Rutas de asignaciones a repartidores
const createRepartidorReturnRoutes = require('./routes/repartidor_returns'); // Rutas de devoluciones de repartidores
const createRepartidorDebtsRoutes = require('./routes/repartidor_debts'); // Rutas de deudas de repartidores
const createEmployeeDebtsRoutes = require('./routes/employee_debts'); // Rutas de deudas de empleados (faltantes corte caja)
const notificationRoutes = require('./routes/notifications'); // Rutas de notificaciones FCM
const { initializeFirebase } = require('./utils/firebaseAdmin'); // Firebase Admin SDK
const notificationHelper = require('./utils/notificationHelper');
const { requireAdminCredentials } = require('./middleware/adminAuth'); // Helper para enviar notificaciones en eventos

// NUEVAS RUTAS MODULARES (refactorización de endpoints)
const salesRoutes = require('./routes/sales');
const ventasRoutes = require('./routes/ventas')(pool); // Rutas de consulta de ventas para app móvil
const expensesRoutes = require('./routes/expenses');
const shiftsRoutes = require('./routes/shifts');
const cashCutsRoutes = require('./routes/cashCuts');
const purchasesRoutes = require('./routes/purchases');
const suppliersRoutes = require('./routes/suppliers');
const guardianEventsRoutes = require('./routes/guardianEvents');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const depositsRoutes = require('./routes/deposits');
const withdrawalsRoutes = require('./routes/withdrawals');
const newCashCutsRoutes = require('./routes/cash-cuts');
const employeeBranchesRoutes = require('./routes/employee_branches')(pool); // Rutas de relaciones empleado-sucursal
const employeeRolesRoutes = require('./routes/employee_roles'); // Rutas para gestionar roles y permisos
const employeesRoutes = require('./routes/employees')(pool); // Rutas de empleados con sync-role endpoint
const customersRoutes = require('./routes/customers'); // Rutas de sincronización de clientes
const productosRoutes = require('./routes/productos'); // Rutas de sincronización de productos
const creditPaymentsRoutes = require('./routes/credit-payments'); // Rutas de pagos de crédito
const suspiciousWeighingLogsRoutes = require('./routes/suspiciousWeighingLogs'); // Rutas de Guardian logs de báscula
const scaleDisconnectionLogsRoutes = require('./routes/scaleDisconnectionLogs'); // Rutas de eventos de desconexión de báscula
const guardianRoutes = require('./routes/guardian'); // API unificada de Guardian para app móvil
const employeeMetricsRoutes = require('./routes/employeeMetrics'); // Rutas de métricas diarias de empleados
const cancelacionesRoutes = require('./routes/cancelaciones'); // Rutas de cancelaciones bitácora con sync offline-first
const repartidoresRoutes = require('./routes/repartidores'); // Rutas de resumen y detalles de repartidores
const syncDiagnosticsRoutes = require('./routes/sync-diagnostics'); // Rutas de diagnóstico de sincronización
const notificationHistoryRoutes = require('./routes/notification-history'); // Rutas de historial de notificaciones (campana)
const notificationPreferencesRoutes = require('./routes/notificationPreferences'); // Preferencias de notificaciones por empleado
const desktopUpdatesRoutes = require('./routes/desktopUpdates'); // Actualizaciones de app Desktop
const superadminRoutes = require('./routes/superadmin'); // Panel de Super Admin (licencias, telemetría)
const passwordResetRoutes = require('./routes/passwordReset'); // Recuperación de contraseña por email
const devicesRoutes = require('./routes/devices'); // Gestión de dispositivos (Primary/Auxiliar)
const notasCreditoRoutes = require('./routes/notas_credito'); // Notas de crédito (devoluciones)
const preparationModeRoutes = require('./routes/preparation_mode'); // Logs de Modo Preparación (auditoría Guardian)

// Inicializar Firebase para notificaciones push
initializeFirebase();

// Registrar rutas
app.use('/api/restore', restoreRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/auth', authRoutes); // Registrar rutas de autenticación
app.use('/api/password-reset', passwordResetRoutes); // Recuperación de contraseña por email
app.use('/api/devices', devicesRoutes(pool)); // Gestión de dispositivos (Primary/Auxiliar)
// tenantsRoutes se registra después de crear io
app.use('/api/notifications', notificationRoutes); // Registrar rutas de notificaciones FCM
app.use('/api/notification-history', notificationHistoryRoutes(pool)); // Historial de notificaciones (campana)
app.use('/api/notification-preferences', notificationPreferencesRoutes); // Preferencias de notificaciones por empleado
app.use('/api/desktop/updates', desktopUpdatesRoutes); // Actualizaciones de app Desktop
app.use('/api/employees', employeesRoutes); // Registrar rutas de empleados con sync-role endpoint
app.use('/api/employee-branches', employeeBranchesRoutes); // Registrar rutas de relaciones empleado-sucursal

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
            sales: (await pool.query('SELECT COUNT(*) FROM ventas WHERE tenant_id = $1', [tenantId])).rows[0].count,
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
        await pool.query('DELETE FROM ventas WHERE tenant_id = $1', [tenantId]);
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

// Make io accessible from routes via req.app.get('io')
app.set('io', io);

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
const repartidorReturnRoutes = createRepartidorReturnRoutes(io);
const repartidorDebtsRoutes = createRepartidorDebtsRoutes(io);
const employeeDebtsRoutes = createEmployeeDebtsRoutes(io);

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

// Registrar nuevas rutas modulares
// Note: Mount routes under their respective base paths to avoid conflicts
app.use('/api/sales', salesRoutes(pool)); // Sync desde Desktop (POST /api/sales/sync)
app.use('/api/sales-items', salesRoutes(pool));
app.use('/api/ventas', ventasRoutes); // Consultas desde App Móvil (GET)
app.use('/api/expenses', expensesRoutes(pool, io));
app.use('/api/shifts', shiftsRoutes(pool, io));
app.use('/api/cash-cuts', newCashCutsRoutes(pool)); // Using new cash-cuts.js with offline-first sync
app.use('/api/purchases', purchasesRoutes(pool));
app.use('/api/suppliers', suppliersRoutes(pool));
app.use('/api/guardian-events', guardianEventsRoutes(pool, io)); // Requires io for Socket.IO
app.use('/api/dashboard', dashboardRoutes(pool));
app.use('/api/admin', adminRoutes(pool)); // Rutas de administración
app.use('/api/employees', employeesRoutes); // Rutas de sincronización de empleados desde Desktop
app.use('/api/cancelaciones', cancelacionesRoutes(pool)); // Rutas de cancelaciones bitácora con sync offline-first
app.use('/api/employee-roles', employeeRolesRoutes); // Rutas para gestionar roles y permisos
app.use('/api/customers', customersRoutes(pool)); // Rutas de sincronización de clientes
app.use('/api/productos', productosRoutes(pool)); // Rutas de sincronización de productos
app.use('/api/credit-payments', creditPaymentsRoutes(pool)); // Rutas de pagos de crédito
app.use('/api/suspicious-weighing-logs', suspiciousWeighingLogsRoutes(pool, io)); // Rutas de Guardian logs de báscula (con Socket.IO)
app.use('/api/scale-disconnection-logs', scaleDisconnectionLogsRoutes(pool)); // Rutas de eventos de desconexión de báscula
app.use('/api/guardian', guardianRoutes(pool)); // API unificada de Guardian para app móvil (events, summary, employees-ranking)
app.use('/api/employee-metrics', employeeMetricsRoutes(pool)); // Rutas de métricas diarias de empleados
app.use('/api/repartidores', repartidoresRoutes(pool)); // Rutas de resumen y detalles de repartidores
app.use('/api/notas-credito', notasCreditoRoutes(pool)); // Notas de crédito (devoluciones)
app.use('/api/preparation-mode', preparationModeRoutes(pool, io)); // Logs de Modo Preparación (auditoría Guardian)

// FASE 1: Cash Management Routes (Deposits, Withdrawals)
app.use('/api/deposits', depositsRoutes(pool));
app.use('/api/withdrawals', withdrawalsRoutes(pool));
app.use('/api/sync-diagnostics', syncDiagnosticsRoutes(pool)); // Diagnóstico de sincronización (debug)
// Note: cash-cuts now uses newCashCutsRoutes at /api/cash-cuts (line 337)

// Sync endpoints are mounted at their service-specific paths
// e.g., /api/sales/sync, /api/expenses/sync, /api/cash-cuts/sync, etc.
// This avoids the /api/sync conflict that was happening before

// Alias routes for backwards compatibility with Desktop client
// Desktop expects /api/sync/cash-cuts but we have /api/cash-cuts/sync
app.post('/api/sync/cash-cuts', (req, res) => {
    // Forward to the correct endpoint
    req.url = '/sync';
    req.baseUrl = '/api/cash-cuts';
    newCashCutsRoutes(pool)(req, res);
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

// Note: /api/cash-cuts-new removed - now using /api/cash-cuts with newCashCutsRoutes

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

// PUT /api/branches/:id - Actualizar datos de sucursal (sin auth - usa tenantId del payload)
// Columnas válidas: name, address, phone, rfc, timezone, is_active
app.put('/api/branches/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { tenantId, name, address, phone, rfc } = req.body;

        // Validar que tenantId venga en el payload
        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: 'tenantId es requerido en el payload'
            });
        }

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

        // Actualizar sucursal (solo columnas que existen en schema)
        const result = await pool.query(`
            UPDATE branches
            SET name = COALESCE($1, name),
                address = COALESCE($2, address),
                phone = COALESCE($3, phone),
                rfc = COALESCE($4, rfc),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $5 AND tenant_id = $6
            RETURNING *
        `, [
            name,
            address,
            phone,
            rfc,
            id,
            tenantId
        ]);

        const branch = result.rows[0];

        console.log(`[Branch Update] ✅ Sucursal actualizada: ${branch.name} (RFC: ${branch.rfc || 'N/A'})`);

        res.json({
            success: true,
            message: 'Sucursal actualizada exitosamente',
            data: {
                id: branch.id,
                code: branch.branch_code,
                name: branch.name,
                address: branch.address,
                phone: branch.phone,
                rfc: branch.rfc,
                timezone: branch.timezone,
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

// ═══════════════════════════════════════════════════════════════
// POST /api/branches/sync-info - Sincronizar info de sucursal desde Desktop
// Sin JWT - usa tenantId/branchId del payload para identificación
// Si es la sucursal principal, también actualiza el nombre del tenant
// ═══════════════════════════════════════════════════════════════
app.post('/api/branches/sync-info', async (req, res) => {
    const { tenantId, branchId, name, address, phone, rfc } = req.body;

    console.log(`[Branch Sync] 📥 Recibida solicitud: tenantId=${tenantId}, branchId=${branchId}, name=${name}`);

    if (!tenantId || !branchId) {
        return res.status(400).json({
            success: false,
            message: 'tenantId y branchId son requeridos'
        });
    }

    try {
        // Verificar que la sucursal pertenece al tenant
        const existing = await pool.query(
            'SELECT id, name FROM branches WHERE id = $1 AND tenant_id = $2',
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

        // Actualizar sucursal (columna es 'phone', no 'phone_number')
        const result = await pool.query(`
            UPDATE branches
            SET name = COALESCE($1, name),
                address = COALESCE($2, address),
                phone = COALESCE($3, phone),
                rfc = COALESCE($4, rfc),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $5 AND tenant_id = $6
            RETURNING *
        `, [name, address, phone, rfc, branchId, tenantId]);

        const branch = result.rows[0];
        console.log(`[Branch Sync] ✅ Sucursal actualizada: ${branch.name} (RFC: ${branch.rfc || 'N/A'})`);

        // Si es la sucursal principal y se cambió el nombre, también actualizar el tenant
        let tenantUpdated = false;
        const branchIdInt = parseInt(branchId);

        if (name && name !== oldName) {
            const primaryBranch = await pool.query(
                `SELECT id FROM branches
                 WHERE tenant_id = $1
                 ORDER BY created_at ASC
                 LIMIT 1`,
                [tenantId]
            );

            console.log(`[Branch Sync] 🔍 Primary branch check: primaryId=${primaryBranch.rows[0]?.id}, currentBranchId=${branchIdInt}`);

            if (primaryBranch.rows.length > 0 && primaryBranch.rows[0].id === branchIdInt) {
                await pool.query(
                    `UPDATE tenants SET business_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                    [name, tenantId]
                );
                tenantUpdated = true;
                console.log(`[Branch Sync] ✅ Tenant también actualizado con business_name: ${name}`);
            } else {
                console.log(`[Branch Sync] ℹ️ No es sucursal principal, solo se actualizó la sucursal`);
            }
        } else {
            console.log(`[Branch Sync] ℹ️ Nombre no cambió (old: ${oldName}, new: ${name})`);
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
                phone: branch.phone,
                rfc: branch.rfc,
                tenantUpdated: tenantUpdated,
                updatedAt: branch.updated_at
            }
        });

    } catch (error) {
        console.error('[Branch Sync] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al sincronizar sucursal',
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/telemetry - Registrar eventos de telemetría (app opens, scale config)
// Idempotente: usa global_id para evitar duplicados
// ═══════════════════════════════════════════════════════════════
app.post('/api/telemetry', async (req, res) => {
    try {
        const {
            tenantId,
            branchId,
            eventType,        // 'app_open' | 'scale_configured' | 'theme_changed'
            deviceId,
            deviceName,
            appVersion,
            scaleModel,       // Solo para scale_configured
            scalePort,        // Solo para scale_configured
            themeName,        // Solo para theme_changed
            global_id,
            terminal_id,
            local_op_seq,
            device_event_raw,
            created_local_utc,
            eventTimestamp
        } = req.body;

        // Validaciones básicas
        if (!tenantId || !branchId || !eventType || !global_id) {
            return res.status(400).json({
                success: false,
                message: 'Campos requeridos: tenantId, branchId, eventType, global_id'
            });
        }

        // Validar eventType
        const validEventTypes = ['app_open', 'scale_configured', 'theme_changed'];
        if (!validEventTypes.includes(eventType)) {
            return res.status(400).json({
                success: false,
                message: `eventType inválido. Valores permitidos: ${validEventTypes.join(', ')}`
            });
        }

        // Verificar que tenant y branch existen
        const tenantCheck = await pool.query(
            'SELECT id FROM tenants WHERE id = $1',
            [tenantId]
        );
        if (tenantCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Tenant no encontrado'
            });
        }

        const branchCheck = await pool.query(
            'SELECT id FROM branches WHERE id = $1 AND tenant_id = $2',
            [branchId, tenantId]
        );
        if (branchCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Sucursal no encontrada para este tenant'
            });
        }

        // Insertar evento (ON CONFLICT para idempotencia)
        const result = await pool.query(`
            INSERT INTO telemetry_events (
                tenant_id, branch_id, event_type,
                device_id, device_name, app_version,
                scale_model, scale_port, theme_name,
                global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc,
                event_timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, COALESCE($15, NOW()))
            ON CONFLICT (global_id) DO NOTHING
            RETURNING id
        `, [
            tenantId,
            branchId,
            eventType,
            deviceId || null,
            deviceName || null,
            appVersion || null,
            scaleModel || null,
            scalePort || null,
            themeName || null,
            global_id,
            terminal_id || null,
            local_op_seq || null,
            device_event_raw || null,
            created_local_utc || null,
            eventTimestamp || null
        ]);

        const wasInserted = result.rows.length > 0;
        const eventId = wasInserted ? result.rows[0].id : null;

        console.log(`[Telemetry] ${wasInserted ? '✅ NUEVO' : '⏭️ DUPLICADO'} ${eventType} - Tenant: ${tenantId}, Branch: ${branchId}${scaleModel ? `, Scale: ${scaleModel}` : ''}${themeName ? `, Theme: ${themeName}` : ''}`);

        res.status(wasInserted ? 201 : 200).json({
            success: true,
            message: wasInserted ? 'Evento registrado' : 'Evento ya existía (idempotente)',
            data: {
                id: eventId,
                globalId: global_id,
                eventType,
                wasInserted
            }
        });

    } catch (error) {
        console.error('[Telemetry] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al registrar evento de telemetría',
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// GET /api/telemetry/stats - Obtener estadísticas de telemetría (admin)
// ═══════════════════════════════════════════════════════════════
app.get('/api/telemetry/stats', async (req, res) => {
    try {
        // Total de aperturas de app por tenant/branch
        const appOpens = await pool.query(`
            SELECT
                t.business_name as tenant_name,
                b.name as branch_name,
                COUNT(*) as total_opens,
                MAX(te.event_timestamp) as last_open
            FROM telemetry_events te
            JOIN tenants t ON te.tenant_id = t.id
            JOIN branches b ON te.branch_id = b.id
            WHERE te.event_type = 'app_open'
            GROUP BY t.id, t.business_name, b.id, b.name
            ORDER BY total_opens DESC
        `);

        // Configuraciones de báscula
        const scaleConfigs = await pool.query(`
            SELECT
                t.business_name as tenant_name,
                b.name as branch_name,
                te.scale_model,
                te.scale_port,
                te.event_timestamp as configured_at
            FROM telemetry_events te
            JOIN tenants t ON te.tenant_id = t.id
            JOIN branches b ON te.branch_id = b.id
            WHERE te.event_type = 'scale_configured'
            ORDER BY te.event_timestamp DESC
        `);

        // Resumen
        const summary = await pool.query(`
            SELECT
                (SELECT COUNT(DISTINCT branch_id) FROM telemetry_events WHERE event_type = 'app_open') as branches_with_app,
                (SELECT COUNT(DISTINCT branch_id) FROM telemetry_events WHERE event_type = 'scale_configured') as branches_with_scale,
                (SELECT COUNT(*) FROM telemetry_events WHERE event_type = 'app_open') as total_app_opens,
                (SELECT COUNT(DISTINCT scale_model) FROM telemetry_events WHERE event_type = 'scale_configured' AND scale_model IS NOT NULL) as unique_scale_models
        `);

        res.json({
            success: true,
            data: {
                summary: summary.rows[0],
                appOpensByBranch: appOpens.rows,
                scaleConfigurations: scaleConfigs.rows
            }
        });

    } catch (error) {
        console.error('[Telemetry Stats] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener estadísticas',
            error: error.message
        });
    }
});

io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] Cliente conectado: ${socket.id}`);

    socket.on('join_branch', (branchId) => {
        // Dejar todos los rooms de branch anteriores antes de unirse al nuevo
        // Esto es necesario cuando un cliente cambia de sucursal después del login
        socket.rooms.forEach(room => {
            if (room.startsWith('branch_') && room !== `branch_${branchId}`) {
                socket.leave(room);
                console.log(`[LEAVE] Cliente ${socket.id} dejó ${room}`);
            }
        });

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

        // DEBUG: Listar clientes en el room
        const roomSockets = io.sockets.adapter.rooms.get(roomName);
        const clientCount = roomSockets ? roomSockets.size : 0;
        console.log(`[ALERT] 📊 Clientes en room '${roomName}': ${clientCount}`);
        if (roomSockets) {
            roomSockets.forEach(socketId => {
                const clientSocket = io.sockets.sockets.get(socketId);
                console.log(`[ALERT]   → ${socketId} (tipo: ${clientSocket?.clientType || 'unknown'})`);
            });
        }

        // ⚠️ IMPORTANTE: NO guardar en BD aquí ni enviar FCM
        // Desktop ya envía los eventos via REST API (/api/guardian-events)
        // que se encarga del guardado en BD y envío de FCM

        // ❌ Socket.IO emit comentado - no soporta filtrado por rol
        // Solo usamos notificaciones FCM que ya están filtradas por rol (admins/encargados)
        // console.log(`[ALERT] 📡 Emitiendo evento en tiempo real (scale_alert) a branch_${data.branchId}`);
        // io.to(roomName).emit('scale_alert', {
        //     ...data,
        //     receivedAt: new Date().toISOString(),
        //     source: 'realtime'
        // });
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

    socket.on('user-login', async (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        console.log(`[USER-LOGIN] Sucursal ${data.branchId}: ${data.employeeName} (${data.employeeRole}) inició sesión`);

        // Broadcast al escritorio y móviles en la sucursal
        io.to(roomName).emit('user-login', { ...data, receivedAt: new Date().toISOString() });

        // Enviar notificación FCM a admins/encargados + al empleado que hizo login
        try {
            await notificationHelper.notifyUserLogin(data.branchId, {
                employeeId: data.employeeId,
                employeeName: data.employeeName,
                branchName: data.branchName,
                scaleStatus: data.scaleStatus || 'unknown'
            });
            console.log(`[FCM] 📨 Notificación de login enviada a sucursal ${data.branchId}`);
        } catch (error) {
            console.error(`[USER-LOGIN] ⚠️ Error enviando notificación FCM:`, error.message);
            // No fallar el broadcast si hay error en la notificación
        }
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

        // NOTA: El sync real se hace vía /api/shifts/sync (idempotente con global_id)
        // Este handler solo hace broadcast en tiempo real a clientes conectados
        // Las notificaciones FCM se envían desde /api/shifts/sync cuando Desktop sincroniza
        console.log(`[SHIFT] ℹ️ Shift closure broadcast completado. Sync y notificaciones se manejan vía /api/shifts/sync`);
    });

    // ═══════════════════════════════════════════════════════════════
    // BUSINESS ALERTS - Alertas de negocio (ventas a crédito, abonos, cancelaciones)
    // ═══════════════════════════════════════════════════════════════

    socket.on('credit_sale_created', async (data) => {
        stats.totalEvents++;
        // Desktop envía: total (monto a crédito), newBalance, previousBalance
        const creditAmount = data.creditAmount || data.total || 0;
        console.log(`[CREDIT_SALE] 💳 Venta a crédito en sucursal ${data.branchId}: Ticket #${data.ticketNumber}, Cliente: ${data.clientName}, Crédito: $${creditAmount}`);

        try {
            await notificationHelper.notifyCreditSaleCreated(data.tenantId, data.branchId, {
                ticketNumber: data.ticketNumber,
                total: data.total || creditAmount,
                creditAmount: creditAmount,
                clientName: data.clientName,
                branchName: data.branchName,
                employeeName: data.employeeName
            });
            console.log(`[CREDIT_SALE] ✅ Notificación FCM enviada para venta a crédito Ticket #${data.ticketNumber}`);
        } catch (error) {
            console.error(`[CREDIT_SALE] ❌ Error enviando notificación FCM:`, error.message);
        }
    });

    socket.on('client_payment_received', async (data) => {
        stats.totalEvents++;
        // Desktop envía: amount (monto del pago), newBalance (saldo restante después del pago)
        const paymentAmount = data.paymentAmount || data.amount || 0;
        const remainingBalance = data.remainingBalance || data.newBalance || 0;
        console.log(`[CLIENT_PAYMENT] 💵 Abono recibido en sucursal ${data.branchId}: Cliente: ${data.clientName}, Monto: $${paymentAmount}`);

        try {
            await notificationHelper.notifyClientPaymentReceived(data.tenantId, data.branchId, {
                paymentAmount: paymentAmount,
                clientName: data.clientName,
                branchName: data.branchName,
                employeeName: data.employeeName,
                remainingBalance: remainingBalance,
                paymentMethod: data.paymentMethod || 'Efectivo'
            });
            console.log(`[CLIENT_PAYMENT] ✅ Notificación FCM enviada para abono de ${data.clientName}`);
        } catch (error) {
            console.error(`[CLIENT_PAYMENT] ❌ Error enviando notificación FCM:`, error.message);
        }
    });

    socket.on('sale_cancelled', async (data) => {
        stats.totalEvents++;
        // Desktop envía: cancellationReason, cancelledByEmployeeName, originalEmployeeName
        const reason = data.reason || data.cancellationReason || '';
        const employeeName = data.employeeName || data.cancelledByEmployeeName || 'Empleado';
        const authorizedBy = data.authorizedBy || '';
        console.log(`[SALE_CANCELLED] ❌ Venta cancelada en sucursal ${data.branchId}: Ticket #${data.ticketNumber}, Total: $${data.total}`);

        try {
            await notificationHelper.notifySaleCancelled(data.tenantId, data.branchId, {
                ticketNumber: data.ticketNumber,
                total: data.total,
                reason: reason,
                branchName: data.branchName,
                employeeName: employeeName,
                authorizedBy: authorizedBy
            });
            console.log(`[SALE_CANCELLED] ✅ Notificación FCM enviada para cancelación de Ticket #${data.ticketNumber}`);
        } catch (error) {
            console.error(`[SALE_CANCELLED] ❌ Error enviando notificación FCM:`, error.message);
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PREPARATION MODE - Notificación en tiempo real a administradores
    // ═══════════════════════════════════════════════════════════════
    socket.on('preparation_mode_activated', async (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;

        console.log(`[PREPMODE] ⚠️ Modo Preparación ACTIVADO en sucursal ${data.branchId} (tenant ${data.tenantId})`);
        console.log(`[PREPMODE]   Sucursal: ${data.branchName}`);
        console.log(`[PREPMODE]   Operador: ${data.operatorName} (ID: ${data.operatorEmployeeId})`);
        console.log(`[PREPMODE]   Autorizado por: ${data.authorizerName} (ID: ${data.authorizedByEmployeeId})`);
        console.log(`[PREPMODE]   Razón: ${data.reason || 'No especificada'}`);

        // Broadcast a todos los clientes en la sucursal
        io.to(roomName).emit('preparation_mode_activated', {
            ...data,
            receivedAt: new Date().toISOString()
        });

        // Enviar notificación FCM a TODOS los administradores/encargados del TENANT
        try {
            await notificationHelper.notifyPreparationModeActivated(data.tenantId, data.branchId, {
                operatorName: data.operatorName,
                authorizerName: data.authorizerName,
                branchName: data.branchName,
                reason: data.reason,
                activatedAt: data.activatedAt
            });
            console.log(`[PREPMODE] 📨 Notificación FCM enviada a administradores del tenant ${data.tenantId}`);
        } catch (error) {
            console.error(`[PREPMODE] ⚠️ Error enviando notificación FCM:`, error.message);
        }
    });

    // Desactivación del Modo Preparación
    socket.on('preparation_mode_deactivated', async (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;

        console.log(`[PREPMODE] ✅ Modo Preparación DESACTIVADO en sucursal ${data.branchId} (tenant ${data.tenantId})`);
        console.log(`[PREPMODE]   Sucursal: ${data.branchName}`);
        console.log(`[PREPMODE]   Operador: ${data.operatorName}`);
        console.log(`[PREPMODE]   Duración: ${data.durationFormatted} (${data.severity})`);

        // Broadcast a todos los clientes en la sucursal
        io.to(roomName).emit('preparation_mode_deactivated', {
            ...data,
            receivedAt: new Date().toISOString()
        });

        // Enviar notificación FCM a TODOS los administradores/encargados del TENANT
        try {
            await notificationHelper.notifyPreparationModeDeactivated(data.tenantId, data.branchId, {
                operatorName: data.operatorName,
                branchName: data.branchName,
                durationFormatted: data.durationFormatted,
                severity: data.severity,
                deactivatedAt: data.deactivatedAt,
                reason: data.reason,
                weighingCycleCount: data.weighingCycleCount || 0,
                totalWeightKg: data.totalWeightKg || 0
            });
            console.log(`[PREPMODE] 📨 Notificación de desactivación FCM enviada a administradores del tenant ${data.tenantId}`);
        } catch (error) {
            console.error(`[PREPMODE] ⚠️ Error enviando notificación FCM de desactivación:`, error.message);
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // MANUAL WEIGHT OVERRIDE - Notificación de activación/desactivación de Peso Manual
    // ═══════════════════════════════════════════════════════════════
    socket.on('manual_weight_override_changed', async (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        const action = data.isActivated ? 'ACTIVADO' : 'DESACTIVADO';

        console.log(`[WEIGHT-OVERRIDE] Peso Manual ${action} en sucursal ${data.branchId} (tenant ${data.tenantId})`);
        console.log(`[WEIGHT-OVERRIDE]   Sucursal: ${data.branchName}`);
        console.log(`[WEIGHT-OVERRIDE]   Empleado: ${data.employeeName} (ID: ${data.employeeId})`);

        // Broadcast a todos los clientes en la sucursal
        io.to(roomName).emit('manual_weight_override_changed', {
            ...data,
            receivedAt: new Date().toISOString()
        });

        // Enviar notificación FCM a administradores del TENANT
        try {
            await notificationHelper.notifyManualWeightOverrideChanged(data.tenantId, data.branchId, {
                employeeName: data.employeeName,
                branchName: data.branchName,
                isActivated: data.isActivated,
                timestamp: data.timestamp
            });
            console.log(`[WEIGHT-OVERRIDE] Notificación FCM enviada a administradores del tenant ${data.tenantId}`);
        } catch (error) {
            console.error(`[WEIGHT-OVERRIDE] Error enviando notificación FCM:`, error.message);
        }
    });

    socket.on('get_stats', () => {
        socket.emit('stats', {
            ...stats,
            connectedClients: io.sockets.sockets.size,
            uptime: Math.floor((Date.now() - stats.startTime) / 1000),
        });
    });

    // ═══════════════════════════════════════════════════════════════
    // ASSIGNMENT REAL-TIME UPDATES (Edit, Cancel, Liquidate)
    // Broadcast to all devices in the branch for instant UI updates
    // ═══════════════════════════════════════════════════════════════

    socket.on('assignment_edited', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        console.log(`[ASSIGNMENT] ✏️ Asignación editada en sucursal ${data.branchId}: ${data.productName} (${data.oldQuantity} → ${data.newQuantity})`);
        io.to(roomName).emit('assignment_edited', { ...data, receivedAt: new Date().toISOString() });
    });

    socket.on('assignment_cancelled', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        console.log(`[ASSIGNMENT] ❌ Asignación cancelada en sucursal ${data.branchId}: ${data.productName} - Razón: ${data.reason}`);
        io.to(roomName).emit('assignment_cancelled', { ...data, receivedAt: new Date().toISOString() });
    });

    socket.on('assignment_liquidated', (data) => {
        stats.totalEvents++;
        const roomName = `branch_${data.branchId}`;
        console.log(`[ASSIGNMENT] ✅ Liquidación en sucursal ${data.branchId}: ${data.itemCount} items por ${data.employeeName}`);
        io.to(roomName).emit('assignment_liquidated', { ...data, receivedAt: new Date().toISOString() });
    });

    // ═══════════════════════════════════════════════════════════════
    // DESKTOP → MOBILE BROADCASTING (Notifications from Desktop to Mobile)
    // ═══════════════════════════════════════════════════════════════

    // EVENT: Desktop creates a new assignment for repartidor
    socket.on('repartidor:assignment-created', (data) => {
        console.log(`[ASSIGNMENT] 📦 Desktop creó asignación para repartidor ${data.assignment?.employeeId}: ${data.assignment?.quantity || 0}kg`);

        // Broadcast to all clients in the branch room (Mobile will receive it)
        const branchRoom = `branch_${data.branchId}`;
        io.to(branchRoom).emit('repartidor:assignment-created', {
            ...data,
            source: 'desktop',
            receivedAt: new Date().toISOString()
        });

        console.log(`[ASSIGNMENT] 📤 Notificación enviada a ${branchRoom}`);
    });

    // EVENT: Desktop registers a return from repartidor
    socket.on('repartidor:return-created', (data) => {
        console.log(`[RETURN] 📦 Desktop registró devolución de repartidor: ${data.return?.quantity || 0}kg (${data.return?.reason || 'sin motivo'})`);

        // Broadcast to all clients in the branch room (Mobile will receive it)
        const branchRoom = `branch_${data.branchId}`;
        io.to(branchRoom).emit('repartidor:return-created', {
            ...data,
            source: 'desktop',
            receivedAt: new Date().toISOString()
        });

        console.log(`[RETURN] 📤 Notificación enviada a ${branchRoom}`);
    });

    // ═══════════════════════════════════════════════════════════════
    // MOBILE REPARTIDOR LISTENERS (Assignment Sync Architecture)
    // ═══════════════════════════════════════════════════════════════

    // EVENT 1: Mobile notifies that cash drawer was opened by repartidor
    // (Optional - if using Option B: Mobile initiates cash drawer opening)
    socket.on('cashier:drawer-opened-by-repartidor', (data) => {
        const repartidorId = socket.handshake.auth?.repartidorId;

        // Verify the mobile user is actually this repartidor
        if (repartidorId && repartidorId !== data.repartidorId) {
            console.log(`[CASHIER] ❌ Security violation: Socket repartidorId=${repartidorId} tried to open drawer for repartidorId=${data.repartidorId}`);
            return;
        }

        console.log(`[CASHIER] 💰 Repartidor ${data.repartidorId} abrió caja desde Mobile con $${data.initialAmount}`);

        // Forward to Desktop (if connected to same branch)
        const branchRoom = `branch_${data.branchId}`;
        io.to(branchRoom).emit('cashier:drawer-opened-by-repartidor', {
            ...data,
            source: 'mobile',
            receivedAt: new Date().toISOString()
        });

        // Acknowledge to Mobile
        socket.emit('cashier:drawer-acknowledged', { success: true });
    });

    // EVENT 2: Mobile sends expense created notification
    socket.on('repartidor:expense-created', (data) => {
        const repartidorId = socket.handshake.auth?.repartidorId;

        // Verify the mobile user is this repartidor
        if (repartidorId && repartidorId !== data.repartidorId) {
            console.log(`[EXPENSE] ❌ Security violation: Socket repartidorId=${repartidorId} tried to create expense for ${data.repartidorId}`);
            return;
        }

        console.log(`[EXPENSE] 💸 Repartidor ${data.repartidorId} registró gasto: $${data.amount} (${data.category})`);
        console.log(`[EXPENSE] 📝 Descripción: ${data.description}`);

        // Forward to Desktop so it can sync to Backend
        const branchRoom = `branch_${data.branchId}`;
        io.to(branchRoom).emit('repartidor:expense-created', {
            ...data,
            source: 'mobile',
            receivedAt: new Date().toISOString()
        });

        // Acknowledge to Mobile
        socket.emit('expense:received', {
            success: true,
            expenseId: data.expenseId,
            message: 'Gasto recibido por servidor, Desktop sincronizará a Backend'
        });
    });

    // EVENT 3: Mobile notifies assignment was completed
    socket.on('repartidor:assignment-completed', (data) => {
        const repartidorId = socket.handshake.auth?.repartidorId;

        // Verify the mobile user is this repartidor
        if (repartidorId && repartidorId !== data.repartidorId) {
            console.log(`[ASSIGNMENT] ❌ Security violation: Socket repartidorId=${repartidorId} tried to complete assignment for ${data.repartidorId}`);
            return;
        }

        console.log(`[ASSIGNMENT] ✅ Repartidor ${data.repartidorId} completó asignación: ${data.kilosVendidos}kg vendidos (${data.kilosDevueltos}kg devueltos)`);

        // Forward to Desktop so it can create sale and sync to Backend
        const branchRoom = `branch_${data.branchId}`;
        io.to(branchRoom).emit('repartidor:assignment-completed', {
            ...data,
            source: 'mobile',
            receivedAt: new Date().toISOString()
        });

        // Acknowledge to Mobile
        socket.emit('assignment:completion-received', {
            success: true,
            assignmentId: data.assignmentId,
            message: 'Asignación completada, Desktop creará venta'
        });
    });

    // EVENT 4: Mobile requests current assignments (for offline recovery)
    socket.on('request:my-assignments', (data) => {
        const repartidorId = socket.handshake.auth?.repartidorId;

        // Verify the mobile user is this repartidor
        if (repartidorId && repartidorId !== data.repartidorId) {
            console.log(`[REQUEST] ❌ Security violation: Socket repartidorId=${repartidorId} tried to request assignments for ${data.repartidorId}`);
            return;
        }

        console.log(`[REQUEST] 📋 Repartidor ${data.repartidorId} solicitó sus asignaciones actuales`);

        // Forward to Desktop to query assignments
        const branchRoom = `branch_${data.branchId}`;
        io.to(branchRoom).emit('request:my-assignments', {
            repartidorId: data.repartidorId,
            tenantId: data.tenantId,
            branchId: data.branchId,
            lastSyncAt: data.lastSyncAt,
            mobileSocketId: socket.id,  // Desktop sends response back via this ID
            source: 'mobile-recovery',
            requestedAt: new Date().toISOString()
        });
    });

    // EVENT 5: Mobile notifies cash drawer closing
    socket.on('cashier:drawer-closed', (data) => {
        const repartidorId = socket.handshake.auth?.repartidorId;

        // Verify the mobile user is this repartidor
        if (repartidorId && repartidorId !== data.repartidorId) {
            console.log(`[CASHIER] ❌ Security violation: Socket repartidorId=${repartidorId} tried to close drawer for ${data.repartidorId}`);
            return;
        }

        console.log(`[CASHIER] 🔒 Repartidor ${data.repartidorId} cerró caja con $${data.finalAmount}`);

        // Forward to Desktop
        const branchRoom = `branch_${data.branchId}`;
        io.to(branchRoom).emit('cashier:drawer-closed', {
            ...data,
            source: 'mobile',
            receivedAt: new Date().toISOString()
        });

        // Acknowledge to Mobile
        socket.emit('cashier:closure-acknowledged', {
            success: true,
            drawerId: data.drawerId,
            message: 'Cierre de caja registrado'
        });
    });

    // EVENT: Mobile requests backup from Desktop POS
    socket.on('backup:request', (data) => {
        console.log(`[BACKUP] 📱 Mobile solicitó respaldo - Branch: ${data.branchId}, Tenant: ${data.tenantId}`);

        const branchRoom = `branch_${data.branchId}`;
        io.to(branchRoom).emit('backup:request', {
            tenantId: data.tenantId,
            branchId: data.branchId,
            mobileSocketId: socket.id,
            requestedAt: new Date().toISOString()
        });
    });

    // EVENT: Desktop sends backup result back to Mobile
    socket.on('backup:result', (data) => {
        console.log(`[BACKUP] 💻 Desktop respondió respaldo - Success: ${data.success}, Target: ${data.mobileSocketId}`);

        if (data.mobileSocketId) {
            io.to(data.mobileSocketId).emit('backup:result', {
                success: data.success,
                message: data.message,
                completedAt: new Date().toISOString()
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // END MOBILE LISTENERS
    // ═══════════════════════════════════════════════════════════════

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
