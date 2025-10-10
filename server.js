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

// Registrar rutas
app.use('/api/restore', restoreRoutes);
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
        const { idToken, email, displayName, businessName, phoneNumber, address, password } = req.body;

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

        // Obtener subscription_id del plan Basic
        const subscriptionResult = await pool.query(
            "SELECT id FROM subscriptions WHERE name = 'Basic' LIMIT 1"
        );

        if (subscriptionResult.rows.length === 0) {
            return res.status(500).json({
                success: false,
                message: 'No se encontró plan de subscripción Basic. Contacte al administrador.'
            });
        }

        const subscriptionId = subscriptionResult.rows[0].id;

        // Crear tenant
        const tenantResult = await pool.query(
            `INSERT INTO tenants (tenant_code, business_name, email, phone_number, address,
             subscription_status, subscription_id, trial_ends_at)
             VALUES ($1, $2, $3, $4, $5, 'trial', $6, $7)
             RETURNING *`,
            [
                tenantCode,
                businessName,
                email,
                phoneNumber,
                address,
                subscriptionId,
                new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 días
            ]
        );

        const tenant = tenantResult.rows[0];

        // Crear empleado admin con la contraseña del desktop (o 1234 por defecto)
        const passwordToHash = password || '1234';
        const hashedPassword = await bcrypt.hash(passwordToHash, 10);
        const username = displayName.replace(/\s+/g, '').toLowerCase();

        console.log('[Google Signup] Creando usuario con contraseña desde desktop:', password ? '✅' : '❌ (usando 1234 por defecto)');

        const employeeResult = await pool.query(
            `INSERT INTO employees (tenant_id, username, full_name, email, password, role, is_active)
             VALUES ($1, $2, $3, $4, $5, 'admin', true)
             RETURNING *`,
            [tenant.id, username, displayName, email, hashedPassword]
        );

        const employee = employeeResult.rows[0];

        // Crear branch principal
        const branchCode = `${tenantCode}-MAIN`;
        const branchResult = await pool.query(
            `INSERT INTO branches (tenant_id, branch_code, name, address, is_active)
             VALUES ($1, $2, $3, $4, true)
             RETURNING *`,
            [tenant.id, branchCode, `${businessName} - Principal`, address || 'N/A']
        );

        const branch = branchResult.rows[0];

        // Actualizar employee con main_branch_id
        await pool.query(
            `UPDATE employees SET main_branch_id = $1 WHERE id = $2`,
            [branch.id, employee.id]
        );

        // Vincular employee a branch con permisos completos
        await pool.query(
            `INSERT INTO employee_branches (employee_id, branch_id, can_login, can_sell, can_manage_inventory, can_close_shift)
             VALUES ($1, $2, true, true, true, true)`,
            [employee.id, branch.id]
        );

        console.log('[Google Signup] ✅ Tenant creado:', tenantCode);
        console.log('[Google Signup] ✅ Branch creado:', branchCode);
        console.log('[Google Signup] ✅ Employee ID:', employee.id);

        res.json({
            success: true,
            tenant: {
                id: tenant.id,
                tenantCode: tenant.tenant_code,
                businessName: tenant.business_name,
                subscriptionStatus: tenant.subscription_status,
                subscriptionPlan: tenant.subscription_plan,
                subscriptionEndsAt: tenant.subscription_ends_at,
                trialEndsAt: tenant.trial_ends_at
            },
            employee: {
                id: employee.id,
                username: employee.username,  // ✅ AGREGADO: username para login móvil
                email: employee.email,
                fullName: employee.full_name,
                role: employee.role
            },
            branch: {
                id: branch.id,
                branchCode: branch.branch_code,
                name: branch.name
            },
            // ✅ AGREGADO: Credenciales para mostrar en Desktop UI
            credentials: {
                username: employee.username,
                email: employee.email,
                message: 'Guarda estas credenciales para iniciar sesión en la app móvil'
            }
        });
    } catch (error) {
        console.error('[Google Signup] ❌ Error completo:', error);
        console.error('[Google Signup] ❌ Stack:', error.stack);

        // Devolver mensaje más descriptivo
        const errorMessage = error.code === '23505'
            ? 'El email ya está registrado'
            : error.message || 'Error en el servidor';

        res.status(500).json({
            success: false,
            message: errorMessage,
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
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

        // Obtener main_branch_id del empleado
        const branchId = employee.main_branch_id || 1;

        // Generar token
        const token = jwt.sign(
            { tenantId: tenant.id, employeeId: employee.id, branchId, role: employee.role },
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
                id: branchId,
                branchCode: 'BR001',
                name: 'Sucursal Principal'
            },
            user: {
                id: employee.id,
                tenant_id: tenant.id,
                branch_id: branchId,
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
// AUTH: Mobile Login (username o email + password)
// ─────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        console.log('[Mobile Login] Request:', { username });

        // Buscar empleado por username O email
        const employeeResult = await pool.query(
            'SELECT * FROM employees WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)',
            [username]
        );

        if (employeeResult.rows.length === 0) {
            console.log('[Mobile Login] ❌ Usuario no encontrado');
            return res.status(401).json({
                isSuccess: false,
                errorMessage: 'Credenciales inválidas'
            });
        }

        const employee = employeeResult.rows[0];

        // Validar password
        const validPassword = await bcrypt.compare(password, employee.password);
        if (!validPassword) {
            console.log('[Mobile Login] ❌ Contraseña incorrecta');
            return res.status(401).json({
                isSuccess: false,
                errorMessage: 'Credenciales inválidas'
            });
        }

        // Buscar tenant
        const tenantResult = await pool.query(
            'SELECT * FROM tenants WHERE id = $1',
            [employee.tenant_id]
        );

        const tenant = tenantResult.rows[0];

        // Obtener branches del employee
        const branchesResult = await pool.query(
            `SELECT b.id, b.branch_code as code, b.name, b.address
             FROM branches b
             INNER JOIN employee_branches eb ON b.id = eb.branch_id
             WHERE eb.employee_id = $1 AND b.is_active = true
             ORDER BY b.created_at ASC`,
            [employee.id]
        );

        const branches = branchesResult.rows.map(b => ({
            id: b.id,
            code: b.code,
            name: b.name,
            address: b.address || 'N/A'
        }));

        // Generar JWT token
        const token = jwt.sign(
            {
                employeeId: employee.id,
                tenantId: tenant.id,
                email: employee.email
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        console.log('[Mobile Login] ✅ Login exitoso:', employee.username);
        console.log(`[Mobile Login] Branches accesibles: ${branches.length}`);

        res.json({
            isSuccess: true,
            token: token,
            user: {
                id: employee.id,
                username: employee.username,
                fullName: employee.full_name,
                email: employee.email,
                role: employee.role,
                isActive: employee.is_active,
                createdAt: employee.created_at
            },
            tenant: {
                id: tenant.id,
                tenantCode: tenant.tenant_code,
                businessName: tenant.business_name,
                subscriptionStatus: tenant.subscription_status,
                subscriptionPlan: tenant.subscription_plan
            },
            branches: branches
        });
    } catch (error) {
        console.error('[Mobile Login] Error:', error);
        res.status(500).json({
            isSuccess: false,
            errorMessage: 'Error en el servidor'
        });
    }
});

// ─────────────────────────────────────────────────────────
// AUTH: Mobile Credentials Login (Alias para compatibilidad)
// ─────────────────────────────────────────────────────────
app.post('/api/auth/mobile-credentials-login', async (req, res) => {
    // Redirigir al endpoint principal
    req.body.username = req.body.email || req.body.username;
    return app._router.handle(
        Object.assign(req, { url: '/api/auth/login', method: 'POST' }),
        res
    );
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

// ─────────────────────────────────────────────────────────
// AUTH: Unirse a Nueva Sucursal (Desktop)
// ─────────────────────────────────────────────────────────
app.post('/api/auth/join-branch', async (req, res) => {
    try {
        const { email, password, branchName, address } = req.body;

        console.log('[Join Branch] Request:', { email, branchName });

        // 1. Validar credenciales del empleado
        const employeeResult = await pool.query(
            'SELECT * FROM employees WHERE LOWER(email) = LOWER($1)',
            [email]
        );

        if (employeeResult.rows.length === 0) {
            console.log('[Join Branch] ❌ Usuario no encontrado');
            return res.status(401).json({
                success: false,
                message: 'Credenciales inválidas'
            });
        }

        const employee = employeeResult.rows[0];

        // Validar password
        const validPassword = await bcrypt.compare(password, employee.password);
        if (!validPassword) {
            console.log('[Join Branch] ❌ Contraseña incorrecta');
            return res.status(401).json({
                success: false,
                message: 'Credenciales inválidas'
            });
        }

        // 2. Obtener tenant del empleado
        const tenantResult = await pool.query(
            'SELECT * FROM tenants WHERE id = $1',
            [employee.tenant_id]
        );

        const tenant = tenantResult.rows[0];

        // 3. Crear nueva sucursal
        const branchCode = `${tenant.tenant_code}-${Date.now().toString().slice(-6)}`;
        const branchResult = await pool.query(
            `INSERT INTO branches (tenant_id, branch_code, name, address, is_active)
             VALUES ($1, $2, $3, $4, true)
             RETURNING *`,
            [tenant.id, branchCode, branchName, address || 'N/A']
        );

        const branch = branchResult.rows[0];

        // 4. Vincular empleado a la nueva sucursal con permisos completos
        await pool.query(
            `INSERT INTO employee_branches (employee_id, branch_id, can_login, can_sell, can_manage_inventory, can_close_shift)
             VALUES ($1, $2, true, true, true, true)`,
            [employee.id, branch.id]
        );

        console.log('[Join Branch] ✅ Sucursal creada:', branchCode);
        console.log('[Join Branch] ✅ Empleado vinculado a sucursal');

        res.json({
            success: true,
            message: 'Te has unido exitosamente a la nueva sucursal',
            branch: {
                id: branch.id,
                branchCode: branch.branch_code,
                name: branch.name,
                address: branch.address
            },
            employee: {
                username: employee.username,
                id: employee.id,
                email: employee.email,
                fullName: employee.full_name,
                role: employee.role
            },
            tenant: {
                id: tenant.id,
                tenantCode: tenant.tenant_code,
                businessName: tenant.business_name
            }
        });
    } catch (error) {
        console.error('[Join Branch] ❌ Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al crear la sucursal',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// POST /api/auth/refresh - Refrescar access token usando refresh token
app.post('/api/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
        return res.status(401).json({ success: false, message: 'Refresh token no proporcionado' });
    }

    try {
        // Verificar el refresh token
        const decoded = jwt.verify(refreshToken, JWT_SECRET);

        // Verificar que el dispositivo siga activo
        const deviceResult = await pool.query(
            'SELECT * FROM mobile_devices WHERE device_id = $1 AND tenant_id = $2 AND is_active = true',
            [decoded.deviceId, decoded.tenantId]
        );

        if (deviceResult.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'Dispositivo no encontrado o inactivo' });
        }

        // Generar nuevo access token
        const newAccessToken = jwt.sign(
            { tenantId: decoded.tenantId, employeeId: decoded.employeeId, deviceId: decoded.deviceId },
            JWT_SECRET,
            { expiresIn: '15m' }
        );

        // Actualizar last_active del dispositivo
        await pool.query(
            'UPDATE mobile_devices SET last_active = CURRENT_TIMESTAMP WHERE device_id = $1',
            [decoded.deviceId]
        );

        console.log(`[Token Refresh] ✅ Token refrescado para device ${decoded.deviceId}`);

        res.json({
            success: true,
            accessToken: newAccessToken,
            refreshToken: refreshToken, // Mantener el mismo refresh token
            expiresIn: 900 // 15 minutos en segundos
        });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(403).json({ success: false, message: 'Refresh token expirado' });
        }
        console.error('[Token Refresh] Error:', error);
        res.status(403).json({ success: false, message: 'Refresh token inválido' });
    }
});

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS PARA DASHBOARD MÓVIL
// ═══════════════════════════════════════════════════════════════

// Middleware para autenticación JWT
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

// GET /api/dashboard/summary - Resumen del dashboard
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { branch_id, start_date, end_date, all_branches = 'false' } = req.query;

        // Prioridad: 1. branch_id del query, 2. branchId del JWT
        const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;
        const shouldFilterByBranch = all_branches !== 'true' && targetBranchId;

        // Construir filtros de fecha
        let dateFilter = 'DATE(sale_date) = CURRENT_DATE';
        let expenseDateFilter = 'DATE(expense_date) = CURRENT_DATE';

        if (start_date && end_date) {
            dateFilter = `sale_date >= '${start_date}' AND sale_date <= '${end_date}'`;
            expenseDateFilter = `expense_date >= '${start_date}' AND expense_date <= '${end_date}'`;
        }

        // Total de ventas
        let salesQuery = `SELECT COALESCE(SUM(total_amount), 0) as total FROM sales WHERE tenant_id = $1 AND ${dateFilter}`;
        let salesParams = [tenantId];
        if (shouldFilterByBranch) {
            salesQuery += ` AND branch_id = $2`;
            salesParams.push(targetBranchId);
        }
        const salesResult = await pool.query(salesQuery, salesParams);

        // Total de gastos
        let expensesQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE tenant_id = $1 AND ${expenseDateFilter}`;
        let expensesParams = [tenantId];
        if (shouldFilterByBranch) {
            expensesQuery += ` AND branch_id = $2`;
            expensesParams.push(targetBranchId);
        }
        const expensesResult = await pool.query(expensesQuery, expensesParams);

        // Último corte de caja
        let cashCutQuery = `SELECT cash_in_drawer FROM cash_cuts WHERE tenant_id = $1`;
        let cashCutParams = [tenantId];
        if (shouldFilterByBranch) {
            cashCutQuery += ` AND branch_id = $2`;
            cashCutParams.push(targetBranchId);
        }
        cashCutQuery += ` ORDER BY cut_date DESC LIMIT 1`;
        const cashCutResult = await pool.query(cashCutQuery, cashCutParams);

        // Eventos Guardian no leídos
        let guardianQuery = `SELECT COUNT(*) as count FROM guardian_events WHERE tenant_id = $1 AND is_read = false`;
        let guardianParams = [tenantId];
        if (shouldFilterByBranch) {
            guardianQuery += ` AND branch_id = $2`;
            guardianParams.push(targetBranchId);
        }
        const guardianEventsResult = await pool.query(guardianQuery, guardianParams);

        console.log(`[Dashboard Summary] Fetching summary - Tenant: ${tenantId}, Branch: ${targetBranchId}, all_branches: ${all_branches}`);

        res.json({
            success: true,
            data: {
                totalSales: parseFloat(salesResult.rows[0].total),
                totalExpenses: parseFloat(expensesResult.rows[0].total),
                cashInDrawer: cashCutResult.rows.length > 0 ? parseFloat(cashCutResult.rows[0].cash_in_drawer) : 0,
                unreadGuardianEvents: parseInt(guardianEventsResult.rows[0].count)
            }
        });
    } catch (error) {
        console.error('[Dashboard Summary] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener resumen' });
    }
});

// GET /api/sales - Lista de ventas
app.get('/api/sales', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', branch_id } = req.query;

        // Prioridad: 1. branch_id del query, 2. branchId del JWT
        const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

        let query = `
            SELECT s.id, s.ticket_number, s.total_amount, s.payment_method, s.sale_date,
                   s.sale_type,
                   e.full_name as employee_name, e.role as employee_role,
                   b.name as branch_name, b.id as branch_id
            FROM sales s
            LEFT JOIN employees e ON s.employee_id = e.id
            LEFT JOIN branches b ON s.branch_id = b.id
            WHERE s.tenant_id = $1
        `;

        const params = [tenantId];

        // Filtrar por branch_id solo si no se solicita ver todas las sucursales
        if (all_branches !== 'true' && targetBranchId) {
            query += ' AND s.branch_id = $2';
            params.push(targetBranchId);
            query += ' ORDER BY s.sale_date DESC LIMIT $3 OFFSET $4';
            params.push(limit, offset);
        } else {
            query += ' ORDER BY s.sale_date DESC LIMIT $2 OFFSET $3';
            params.push(limit, offset);
        }

        console.log(`[Sales] Fetching sales - Tenant: ${tenantId}, Branch: ${targetBranchId}, all_branches: ${all_branches}`);

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('[Sales] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener ventas' });
    }
});

// POST /api/sales - Crear venta desde Desktop (sin JWT)
app.post('/api/sales', async (req, res) => {
    try {
        const { tenantId, branchId, ticketNumber, totalAmount, paymentMethod, userEmail } = req.body;

        console.log(`[Sales] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, User: ${userEmail}`);

        // Validar datos requeridos
        if (!tenantId || !branchId || !ticketNumber || !totalAmount) {
            return res.status(400).json({ success: false, message: 'Datos incompletos' });
        }

        // Buscar el empleado por email (opcional, para employee_id)
        let employeeId = null;
        if (userEmail) {
            const empResult = await pool.query(
                'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                [userEmail, tenantId]
            );
            if (empResult.rows.length > 0) {
                employeeId = empResult.rows[0].id;
            }
        }

        const result = await pool.query(
            `INSERT INTO sales (tenant_id, branch_id, employee_id, ticket_number, total_amount, payment_method)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [tenantId, branchId, employeeId, ticketNumber, totalAmount, paymentMethod]
        );

        console.log(`[Sales] ✅ Venta creada desde Desktop: ${ticketNumber} - $${totalAmount}`);
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[Sales] Error:', error);
        res.status(500).json({ success: false, message: 'Error al crear venta' });
    }
});

// GET /api/expenses - Lista de gastos
app.get('/api/expenses', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', branch_id } = req.query;

        // Prioridad: 1. branch_id del query, 2. branchId del JWT
        const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

        let query = `
            SELECT e.id, e.description as concept, e.description, e.amount, e.expense_date,
                   emp.full_name as employee_name, b.name as branch_name, b.id as branch_id,
                   cat.name as category
            FROM expenses e
            LEFT JOIN employees emp ON e.employee_id = emp.id
            LEFT JOIN branches b ON e.branch_id = b.id
            LEFT JOIN expense_categories cat ON e.category_id = cat.id
            WHERE e.tenant_id = $1
        `;

        const params = [tenantId];

        // Filtrar por branch_id solo si no se solicita ver todas las sucursales
        if (all_branches !== 'true' && targetBranchId) {
            query += ' AND e.branch_id = $2';
            params.push(targetBranchId);
            query += ' ORDER BY e.expense_date DESC LIMIT $3 OFFSET $4';
            params.push(limit, offset);
        } else {
            query += ' ORDER BY e.expense_date DESC LIMIT $2 OFFSET $3';
            params.push(limit, offset);
        }

        console.log(`[Expenses] Fetching expenses - Tenant: ${tenantId}, Branch: ${targetBranchId}, all_branches: ${all_branches}`);

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('[Expenses] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener gastos' });
    }
});

// POST /api/expenses - Crear gasto desde Desktop (sin JWT)
app.post('/api/expenses', async (req, res) => {
    try {
        const { tenantId, branchId, category, description, amount, userEmail } = req.body;

        if (!tenantId || !branchId || !category || !amount) {
            return res.status(400).json({ success: false, message: 'Datos incompletos' });
        }

        // Buscar empleado por email
        let employeeId = null;
        if (userEmail) {
            const empResult = await pool.query(
                'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                [userEmail, tenantId]
            );
            if (empResult.rows.length > 0) {
                employeeId = empResult.rows[0].id;
            }
        }

        // Buscar o crear categoría
        let categoryId = null;
        const catResult = await pool.query(
            'SELECT id FROM expense_categories WHERE LOWER(name) = LOWER($1) AND tenant_id = $2',
            [category, tenantId]
        );

        if (catResult.rows.length > 0) {
            categoryId = catResult.rows[0].id;
        } else {
            const newCat = await pool.query(
                'INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) RETURNING id',
                [tenantId, category]
            );
            categoryId = newCat.rows[0].id;
            console.log(`[Expenses] Categoría creada: ${category} (ID: ${categoryId})`);
        }

        const result = await pool.query(
            `INSERT INTO expenses (tenant_id, branch_id, employee_id, category_id, description, amount)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [tenantId, branchId, employeeId, categoryId, description, amount]
        );

        console.log(`[Expenses] ✅ Gasto creado desde Desktop: ${category} - $${amount}`);
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[Expenses] Error:', error);
        res.status(500).json({ success: false, message: 'Error al crear gasto' });
    }
});

// GET /api/cash-cuts - Lista de cortes de caja
app.get('/api/cash-cuts', authenticateToken, async (req, res) => {
    try {
        const { tenantId } = req.user;
        const { limit = 50, offset = 0 } = req.query;

        const result = await pool.query(
            `SELECT c.id, c.cut_number, c.total_sales, c.total_expenses, c.cash_in_drawer,
                    c.expected_cash, c.difference, c.cut_date,
                    e.full_name as employee_name, b.name as branch_name
             FROM cash_cuts c
             LEFT JOIN employees e ON c.employee_id = e.id
             LEFT JOIN branches b ON c.branch_id = b.id
             WHERE c.tenant_id = $1
             ORDER BY c.cut_date DESC
             LIMIT $2 OFFSET $3`,
            [tenantId, limit, offset]
        );

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('[Cash Cuts] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener cortes de caja' });
    }
});

// POST /api/cash-cuts - Crear corte de caja (desde Desktop)
app.post('/api/cash-cuts', authenticateToken, async (req, res) => {
    try {
        const { tenantId, employeeId } = req.user;
        const { branchId, cutNumber, totalSales, totalExpenses, cashInDrawer, expectedCash, difference } = req.body;

        const result = await pool.query(
            `INSERT INTO cash_cuts (tenant_id, branch_id, employee_id, cut_number, total_sales, total_expenses, cash_in_drawer, expected_cash, difference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [tenantId, branchId, employeeId, cutNumber, totalSales, totalExpenses, cashInDrawer, expectedCash, difference]
        );

        console.log(`[Cash Cuts] ✅ Corte creado: ${cutNumber}`);
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[Cash Cuts] Error:', error);
        res.status(500).json({ success: false, message: 'Error al crear corte de caja' });
    }
});

// ============================================================================
// ENDPOINTS DE SYNC PARA DESKTOP (ALIAS DE LOS ENDPOINTS NORMALES)
// ============================================================================

// POST /api/sync/sales - Alias de /api/sales (para compatibilidad con Desktop)
app.post('/api/sync/sales', async (req, res) => {
    try {
        const { tenantId, branchId, employeeId, ticketNumber, totalAmount, paymentMethod, userEmail, sale_type } = req.body;

        console.log(`[Sync/Sales] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, Ticket: ${ticketNumber}, Type: ${sale_type}`);

        if (!tenantId || !branchId || !ticketNumber || !totalAmount) {
            return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, ticketNumber, totalAmount requeridos)' });
        }

        // Usar employeeId del body si viene, sino buscar por email
        let finalEmployeeId = employeeId;
        if (!finalEmployeeId && userEmail) {
            const empResult = await pool.query(
                'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                [userEmail, tenantId]
            );
            if (empResult.rows.length > 0) {
                finalEmployeeId = empResult.rows[0].id;
            }
        }

        const result = await pool.query(
            `INSERT INTO sales (tenant_id, branch_id, employee_id, ticket_number, total_amount, payment_method, sale_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [tenantId, branchId, finalEmployeeId, ticketNumber, totalAmount, paymentMethod || 'cash', sale_type || 'counter']
        );

        console.log(`[Sync/Sales] ✅ Venta sincronizada: ${ticketNumber} - $${totalAmount} (${sale_type || 'counter'})`);
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[Sync/Sales] Error:', error);
        res.status(500).json({ success: false, message: 'Error al sincronizar venta', error: error.message });
    }
});

// POST /api/sync/expenses - Alias de /api/expenses (para compatibilidad con Desktop)
app.post('/api/sync/expenses', async (req, res) => {
    try {
        const { tenantId, branchId, employeeId, category, description, amount, userEmail } = req.body;

        console.log(`[Sync/Expenses] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, Category: ${category}`);

        if (!tenantId || !branchId || !category || !amount) {
            return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, category, amount requeridos)' });
        }

        // Usar employeeId del body si viene, sino buscar por email
        let finalEmployeeId = employeeId;
        if (!finalEmployeeId && userEmail) {
            const empResult = await pool.query(
                'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                [userEmail, tenantId]
            );
            if (empResult.rows.length > 0) {
                finalEmployeeId = empResult.rows[0].id;
            }
        }

        // Buscar o crear categoría
        let categoryId = null;
        const catResult = await pool.query(
            'SELECT id FROM expense_categories WHERE LOWER(name) = LOWER($1) AND tenant_id = $2',
            [category, tenantId]
        );

        if (catResult.rows.length > 0) {
            categoryId = catResult.rows[0].id;
        } else {
            const newCat = await pool.query(
                'INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) RETURNING id',
                [tenantId, category]
            );
            categoryId = newCat.rows[0].id;
            console.log(`[Sync/Expenses] Categoría creada: ${category} (ID: ${categoryId})`);
        }

        const result = await pool.query(
            `INSERT INTO expenses (tenant_id, branch_id, employee_id, category_id, description, amount)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [tenantId, branchId, finalEmployeeId, categoryId, description || '', amount]
        );

        console.log(`[Sync/Expenses] ✅ Gasto sincronizado: ${category} - $${amount}`);
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[Sync/Expenses] Error:', error);
        res.status(500).json({ success: false, message: 'Error al sincronizar gasto', error: error.message });
    }
});

// POST /api/sync/cash-cuts - Alias de /api/cash-cuts (para compatibilidad con Desktop)
app.post('/api/sync/cash-cuts', async (req, res) => {
    try {
        const { tenantId, branchId, employeeId, cutNumber, totalSales, totalExpenses, cashInDrawer, expectedCash, difference, userEmail } = req.body;

        console.log(`[Sync/CashCuts] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, Cut: ${cutNumber}`);

        if (!tenantId || !branchId || !cutNumber) {
            return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, cutNumber requeridos)' });
        }

        // Usar employeeId del body si viene, sino buscar por email
        let finalEmployeeId = employeeId;
        if (!finalEmployeeId && userEmail) {
            const empResult = await pool.query(
                'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                [userEmail, tenantId]
            );
            if (empResult.rows.length > 0) {
                finalEmployeeId = empResult.rows[0].id;
            }
        }

        const result = await pool.query(
            `INSERT INTO cash_cuts (tenant_id, branch_id, employee_id, cut_number, total_sales, total_expenses, cash_in_drawer, expected_cash, difference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [tenantId, branchId, finalEmployeeId, cutNumber, totalSales || 0, totalExpenses || 0, cashInDrawer || 0, expectedCash || 0, difference || 0]
        );

        console.log(`[Sync/CashCuts] ✅ Corte sincronizado: ${cutNumber}`);
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[Sync/CashCuts] Error:', error);
        res.status(500).json({ success: false, message: 'Error al sincronizar corte', error: error.message });
    }
});

// ============================================================================
// ENDPOINTS DE COMPRAS (PURCHASES)
// ============================================================================

// GET /api/purchases - Lista de compras
app.get('/api/purchases', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false' } = req.query;

        let query = `
            SELECT p.id, p.purchase_number, p.total_amount, p.payment_status, p.notes, p.purchase_date,
                   s.name as supplier_name, emp.full_name as employee_name, b.name as branch_name
            FROM purchases p
            LEFT JOIN suppliers s ON p.supplier_id = s.id
            LEFT JOIN employees emp ON p.employee_id = emp.id
            LEFT JOIN branches b ON p.branch_id = b.id
            WHERE p.tenant_id = $1
        `;

        const params = [tenantId];

        if (all_branches !== 'true' && branchId) {
            query += ' AND p.branch_id = $2';
            params.push(branchId);
            query += ' ORDER BY p.purchase_date DESC LIMIT $3 OFFSET $4';
            params.push(limit, offset);
        } else {
            query += ' ORDER BY p.purchase_date DESC LIMIT $2 OFFSET $3';
            params.push(limit, offset);
        }

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('[Purchases] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener compras' });
    }
});

// POST /api/purchases - Crear compra desde Desktop (sin JWT)
app.post('/api/purchases', async (req, res) => {
    try {
        const { tenantId, branchId, supplierId, employeeId, purchaseNumber, totalAmount, paymentStatus, notes, userEmail } = req.body;

        if (!tenantId || !branchId || !supplierId || !purchaseNumber || !totalAmount) {
            return res.status(400).json({ success: false, message: 'Datos incompletos' });
        }

        // Buscar empleado por email si viene
        let finalEmployeeId = employeeId;
        if (!finalEmployeeId && userEmail) {
            const empResult = await pool.query(
                'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                [userEmail, tenantId]
            );
            if (empResult.rows.length > 0) {
                finalEmployeeId = empResult.rows[0].id;
            }
        }

        const result = await pool.query(
            `INSERT INTO purchases (tenant_id, branch_id, supplier_id, employee_id, purchase_number, total_amount, payment_status, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [tenantId, branchId, supplierId, finalEmployeeId, purchaseNumber, totalAmount, paymentStatus || 'pending', notes || null]
        );

        console.log(`[Purchases] ✅ Compra creada desde Desktop: ${purchaseNumber} - $${totalAmount}`);
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[Purchases] Error:', error);
        res.status(500).json({ success: false, message: 'Error al crear compra' });
    }
});

// POST /api/sync/purchases - Alias de /api/purchases (para compatibilidad con Desktop)
app.post('/api/sync/purchases', async (req, res) => {
    try {
        const { tenantId, branchId, supplierId, employeeId, purchaseNumber, totalAmount, paymentStatus, notes, userEmail } = req.body;

        console.log(`[Sync/Purchases] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, Purchase: ${purchaseNumber}`);

        if (!tenantId || !branchId || !supplierId || !purchaseNumber || !totalAmount) {
            return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, supplierId, purchaseNumber, totalAmount requeridos)' });
        }

        // Buscar empleado por email si viene
        let finalEmployeeId = employeeId;
        if (!finalEmployeeId && userEmail) {
            const empResult = await pool.query(
                'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                [userEmail, tenantId]
            );
            if (empResult.rows.length > 0) {
                finalEmployeeId = empResult.rows[0].id;
            }
        }

        const result = await pool.query(
            `INSERT INTO purchases (tenant_id, branch_id, supplier_id, employee_id, purchase_number, total_amount, payment_status, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [tenantId, branchId, supplierId, finalEmployeeId, purchaseNumber, totalAmount, paymentStatus || 'pending', notes || null]
        );

        console.log(`[Sync/Purchases] ✅ Compra sincronizada: ${purchaseNumber} - $${totalAmount}`);
        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[Sync/Purchases] Error:', error);
        res.status(500).json({ success: false, message: 'Error al sincronizar compra', error: error.message });
    }
});

// GET /api/guardian-events - Lista de eventos Guardian (MUY IMPORTANTE)
app.get('/api/guardian-events', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 100, offset = 0, unreadOnly = false, all_branches = 'false', branch_id } = req.query;

        // Prioridad: 1. branch_id del query, 2. branchId del JWT
        const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

        let query = `
            SELECT g.id, g.event_type, g.severity, g.title, g.description,
                   g.weight_kg, g.scale_id, g.metadata, g.is_read, g.event_date,
                   e.full_name as employee_name, b.name as branch_name, b.id as branch_id
            FROM guardian_events g
            LEFT JOIN employees e ON g.employee_id = e.id
            LEFT JOIN branches b ON g.branch_id = b.id
            WHERE g.tenant_id = $1
        `;

        const params = [tenantId];
        let paramIndex = 2;

        // Filtrar por branch_id si no se solicita ver todas
        if (all_branches !== 'true' && targetBranchId) {
            query += ` AND g.branch_id = $${paramIndex}`;
            params.push(targetBranchId);
            paramIndex++;
        }

        if (unreadOnly === 'true') {
            query += ' AND g.is_read = false';
        }

        query += ` ORDER BY g.event_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        console.log(`[Guardian Events] Fetching events - Tenant: ${tenantId}, Branch: ${targetBranchId}, all_branches: ${all_branches}, unreadOnly: ${unreadOnly}`);

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('[Guardian Events] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener eventos Guardian' });
    }
});

// POST /api/guardian-events - Crear evento Guardian (desde Desktop)
app.post('/api/guardian-events', authenticateToken, async (req, res) => {
    try {
        const { tenantId, employeeId } = req.user;
        const { branchId, eventType, severity, title, description, weightKg, scaleId, metadata } = req.body;

        const result = await pool.query(
            `INSERT INTO guardian_events (tenant_id, branch_id, employee_id, event_type, severity, title, description, weight_kg, scale_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [tenantId, branchId, employeeId, eventType, severity, title, description, weightKg, scaleId, metadata ? JSON.stringify(metadata) : null]
        );

        const event = result.rows[0];

        console.log(`[Guardian Events] 🚨 Evento creado: ${eventType} - ${title}`);

        // ✅ Notificación en tiempo real vía Socket.IO
        // Emitir evento solo a usuarios del mismo tenant
        io.to(`tenant_${tenantId}`).emit('guardian_event', {
            id: event.id,
            eventType: event.event_type,
            severity: event.severity,
            title: event.title,
            description: event.description,
            branchId: event.branch_id,
            weightKg: event.weight_kg,
            scaleId: event.scale_id,
            eventDate: event.event_date,
            timestamp: event.event_date
        });

        console.log(`[Guardian Events] 📡 Notificación Socket.IO enviada a tenant_${tenantId}`);

        res.json({ success: true, data: event });
    } catch (error) {
        console.error('[Guardian Events] Error:', error);
        res.status(500).json({ success: false, message: 'Error al crear evento Guardian' });
    }
});

// PUT /api/guardian-events/:id/mark-read - Marcar evento como leído
app.put('/api/guardian-events/:id/mark-read', authenticateToken, async (req, res) => {
    try {
        const { tenantId } = req.user;
        const { id } = req.params;

        const result = await pool.query(
            `UPDATE guardian_events
             SET is_read = true
             WHERE id = $1 AND tenant_id = $2
             RETURNING *`,
            [id, tenantId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Evento no encontrado' });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (error) {
        console.error('[Guardian Events] Error:', error);
        res.status(500).json({ success: false, message: 'Error al marcar evento' });
    }
});

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
        const { branchCode, name, address, phoneNumber } = req.body;

        const result = await pool.query(
            `INSERT INTO branches (tenant_id, branch_code, name, address, phone_number)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [tenantId, branchCode, name, address, phoneNumber]
        );

        console.log(`[Branches] ✅ Sucursal creada: ${name}`);
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

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS DE TURNOS (SHIFTS) - CORTES DE CAJA
// ═══════════════════════════════════════════════════════════════

// POST /api/shifts/open - Abrir turno (inicio de sesión)
app.post('/api/shifts/open', authenticateToken, async (req, res) => {
    try {
        const { tenantId, employeeId, branchId } = req.user;
        const { initialAmount } = req.body;

        // Verificar si hay un turno abierto para este empleado
        const existingShift = await pool.query(
            `SELECT id FROM shifts
             WHERE tenant_id = $1 AND branch_id = $2 AND employee_id = $3 AND is_cash_cut_open = true`,
            [tenantId, branchId, employeeId]
        );

        if (existingShift.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Ya tienes un turno abierto. Debes cerrar el turno actual antes de abrir uno nuevo.',
                existingShiftId: existingShift.rows[0].id
            });
        }

        // Crear nuevo turno
        const result = await pool.query(
            `INSERT INTO shifts (tenant_id, branch_id, employee_id, start_time, initial_amount, transaction_counter, is_cash_cut_open)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, 0, true)
             RETURNING id, tenant_id, branch_id, employee_id, start_time, initial_amount, transaction_counter, is_cash_cut_open, created_at`,
            [tenantId, branchId, employeeId, initialAmount || 0]
        );

        const shift = result.rows[0];
        console.log(`[Shifts] 🚀 Turno abierto: ID ${shift.id} - Empleado ${employeeId} - Sucursal ${branchId}`);

        res.json({
            success: true,
            data: shift,
            message: 'Turno abierto exitosamente'
        });

    } catch (error) {
        console.error('[Shifts] Error al abrir turno:', error);
        res.status(500).json({ success: false, message: 'Error al abrir turno' });
    }
});

// POST /api/shifts/close - Cerrar turno (cierre de sesión)
app.post('/api/shifts/close', authenticateToken, async (req, res) => {
    try {
        const { tenantId, employeeId, branchId } = req.user;
        const { shiftId, finalAmount } = req.body;

        // Verificar que el turno existe, pertenece al empleado y está abierto
        const shiftCheck = await pool.query(
            `SELECT id, start_time FROM shifts
             WHERE id = $1 AND tenant_id = $2 AND branch_id = $3 AND employee_id = $4 AND is_cash_cut_open = true`,
            [shiftId, tenantId, branchId, employeeId]
        );

        if (shiftCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Turno no encontrado o ya está cerrado'
            });
        }

        // Cerrar el turno
        const result = await pool.query(
            `UPDATE shifts
             SET end_time = CURRENT_TIMESTAMP,
                 final_amount = $1,
                 is_cash_cut_open = false,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING id, tenant_id, branch_id, employee_id, start_time, end_time, initial_amount, final_amount, transaction_counter, is_cash_cut_open`,
            [finalAmount || 0, shiftId]
        );

        const shift = result.rows[0];
        console.log(`[Shifts] 🔒 Turno cerrado: ID ${shift.id} - Empleado ${employeeId}`);

        res.json({
            success: true,
            data: shift,
            message: 'Turno cerrado exitosamente'
        });

    } catch (error) {
        console.error('[Shifts] Error al cerrar turno:', error);
        res.status(500).json({ success: false, message: 'Error al cerrar turno' });
    }
});

// GET /api/shifts/current - Obtener turno actual del empleado
app.get('/api/shifts/current', authenticateToken, async (req, res) => {
    try {
        const { tenantId, employeeId, branchId } = req.user;

        const result = await pool.query(
            `SELECT s.id, s.tenant_id, s.branch_id, s.employee_id, s.start_time, s.end_time,
                    s.initial_amount, s.final_amount, s.transaction_counter, s.is_cash_cut_open,
                    e.full_name as employee_name,
                    b.name as branch_name
             FROM shifts s
             LEFT JOIN employees e ON s.employee_id = e.id
             LEFT JOIN branches b ON s.branch_id = b.id
             WHERE s.tenant_id = $1 AND s.branch_id = $2 AND s.employee_id = $3 AND s.is_cash_cut_open = true
             ORDER BY s.start_time DESC
             LIMIT 1`,
            [tenantId, branchId, employeeId]
        );

        if (result.rows.length === 0) {
            return res.json({
                success: true,
                data: null,
                message: 'No hay turno abierto'
            });
        }

        res.json({
            success: true,
            data: result.rows[0]
        });

    } catch (error) {
        console.error('[Shifts] Error al obtener turno actual:', error);
        res.status(500).json({ success: false, message: 'Error al obtener turno actual' });
    }
});

// GET /api/shifts/history - Obtener historial de turnos (cortes de caja)
app.get('/api/shifts/history', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', employee_id } = req.query;

        let query = `
            SELECT s.id, s.tenant_id, s.branch_id, s.employee_id, s.start_time, s.end_time,
                   s.initial_amount, s.final_amount, s.transaction_counter, s.is_cash_cut_open,
                   e.full_name as employee_name, e.role as employee_role,
                   b.name as branch_name
            FROM shifts s
            LEFT JOIN employees e ON s.employee_id = e.id
            LEFT JOIN branches b ON s.branch_id = b.id
            WHERE s.tenant_id = $1
        `;

        const params = [tenantId];
        let paramIndex = 2;

        // Filtrar por sucursal si no se solicita todas
        if (all_branches !== 'true' && branchId) {
            query += ` AND s.branch_id = $${paramIndex}`;
            params.push(branchId);
            paramIndex++;
        }

        // Filtrar por empleado específico (para ver historial de un usuario)
        if (employee_id) {
            query += ` AND s.employee_id = $${paramIndex}`;
            params.push(employee_id);
            paramIndex++;
        }

        query += ` ORDER BY s.start_time DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('[Shifts] Error al obtener historial:', error);
        res.status(500).json({ success: false, message: 'Error al obtener historial de turnos' });
    }
});

// GET /api/shifts/summary - Resumen de cortes de caja (para administradores)
app.get('/api/shifts/summary', authenticateToken, async (req, res) => {
    try {
        const { tenantId } = req.user;
        const { date_from, date_to, branch_id } = req.query;

        let query = `
            SELECT s.id, s.branch_id, s.employee_id, s.start_time, s.end_time,
                   s.initial_amount, s.final_amount, s.transaction_counter, s.is_cash_cut_open,
                   e.full_name as employee_name,
                   b.name as branch_name,
                   (s.final_amount - s.initial_amount) as difference
            FROM shifts s
            LEFT JOIN employees e ON s.employee_id = e.id
            LEFT JOIN branches b ON s.branch_id = b.id
            WHERE s.tenant_id = $1
        `;

        const params = [tenantId];
        let paramIndex = 2;

        if (branch_id) {
            query += ` AND s.branch_id = $${paramIndex}`;
            params.push(branch_id);
            paramIndex++;
        }

        if (date_from) {
            query += ` AND s.start_time >= $${paramIndex}`;
            params.push(date_from);
            paramIndex++;
        }

        if (date_to) {
            query += ` AND s.start_time <= $${paramIndex}`;
            params.push(date_to);
            paramIndex++;
        }

        query += ` ORDER BY s.start_time DESC`;

        const result = await pool.query(query, params);

        // Calcular totales
        const summary = {
            total_shifts: result.rows.length,
            total_transactions: result.rows.reduce((sum, shift) => sum + (shift.transaction_counter || 0), 0),
            total_initial: result.rows.reduce((sum, shift) => sum + parseFloat(shift.initial_amount || 0), 0),
            total_final: result.rows.reduce((sum, shift) => sum + parseFloat(shift.final_amount || 0), 0),
            shifts: result.rows
        };

        summary.total_difference = summary.total_final - summary.total_initial;

        res.json({
            success: true,
            data: summary
        });

    } catch (error) {
        console.error('[Shifts] Error al obtener resumen:', error);
        res.status(500).json({ success: false, message: 'Error al obtener resumen de cortes' });
    }
});

// PUT /api/shifts/:id/increment-counter - Incrementar contador de transacciones
app.put('/api/shifts/:id/increment-counter', authenticateToken, async (req, res) => {
    try {
        const { tenantId } = req.user;
        const { id } = req.params;

        const result = await pool.query(
            `UPDATE shifts
             SET transaction_counter = transaction_counter + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND tenant_id = $2 AND is_cash_cut_open = true
             RETURNING transaction_counter`,
            [id, tenantId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Turno no encontrado o cerrado' });
        }

        res.json({
            success: true,
            data: { transaction_counter: result.rows[0].transaction_counter }
        });

    } catch (error) {
        console.error('[Shifts] Error al incrementar contador:', error);
        res.status(500).json({ success: false, message: 'Error al incrementar contador' });
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
