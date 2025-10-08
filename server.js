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

        // Generar JWT token
        const token = jwt.sign(
            { tenantId: tenant.id, employeeId: employee.id, branchId: branch.id, role: 'admin' },
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
            branches: [
                {
                    id: 1,
                    name: 'Sucursal Principal',
                    code: 'BR001'
                }
            ]
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
        const { tenantId } = req.user;

        // Total de ventas del día
        const salesResult = await pool.query(
            `SELECT COALESCE(SUM(total_amount), 0) as total
             FROM sales
             WHERE tenant_id = $1
             AND DATE(sale_date) = CURRENT_DATE`,
            [tenantId]
        );

        // Total de gastos del día
        const expensesResult = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as total
             FROM expenses
             WHERE tenant_id = $1
             AND DATE(expense_date) = CURRENT_DATE`,
            [tenantId]
        );

        // Último corte de caja
        const cashCutResult = await pool.query(
            `SELECT cash_in_drawer
             FROM cash_cuts
             WHERE tenant_id = $1
             ORDER BY cut_date DESC
             LIMIT 1`,
            [tenantId]
        );

        // Eventos Guardian no leídos
        const guardianEventsResult = await pool.query(
            `SELECT COUNT(*) as count
             FROM guardian_events
             WHERE tenant_id = $1
             AND is_read = false`,
            [tenantId]
        );

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
        const { tenantId, branchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false' } = req.query;

        let query = `
            SELECT s.id, s.ticket_number, s.total_amount, s.payment_method, s.sale_date,
                   e.full_name as employee_name, e.role as employee_role,
                   b.name as branch_name
            FROM sales s
            LEFT JOIN employees e ON s.employee_id = e.id
            LEFT JOIN branches b ON s.branch_id = b.id
            WHERE s.tenant_id = $1
        `;

        const params = [tenantId];

        // Filtrar por branch_id solo si no se solicita ver todas las sucursales
        if (all_branches !== 'true' && branchId) {
            query += ' AND s.branch_id = $2';
            params.push(branchId);
            query += ' ORDER BY s.sale_date DESC LIMIT $3 OFFSET $4';
            params.push(limit, offset);
        } else {
            query += ' ORDER BY s.sale_date DESC LIMIT $2 OFFSET $3';
            params.push(limit, offset);
        }

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
        const { tenantId, branchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false' } = req.query;

        let query = `
            SELECT e.id, e.description as concept, e.description, e.amount, e.expense_date,
                   emp.full_name as employee_name, b.name as branch_name,
                   cat.name as category
            FROM expenses e
            LEFT JOIN employees emp ON e.employee_id = emp.id
            LEFT JOIN branches b ON e.branch_id = b.id
            LEFT JOIN expense_categories cat ON e.category_id = cat.id
            WHERE e.tenant_id = $1
        `;

        const params = [tenantId];

        // Filtrar por branch_id solo si no se solicita ver todas las sucursales
        if (all_branches !== 'true' && branchId) {
            query += ' AND e.branch_id = $2';
            params.push(branchId);
            query += ' ORDER BY e.expense_date DESC LIMIT $3 OFFSET $4';
            params.push(limit, offset);
        } else {
            query += ' ORDER BY e.expense_date DESC LIMIT $2 OFFSET $3';
            params.push(limit, offset);
        }

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

        const result = await pool.query(
            `INSERT INTO expenses (tenant_id, branch_id, employee_id, category, description, amount)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [tenantId, branchId, employeeId, category, description, amount]
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

// GET /api/guardian-events - Lista de eventos Guardian (MUY IMPORTANTE)
app.get('/api/guardian-events', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId } = req.user;
        const { limit = 100, offset = 0, unreadOnly = false, all_branches = 'false' } = req.query;

        let query = `
            SELECT g.id, g.event_type, g.severity, g.title, g.description,
                   g.weight_kg, g.scale_id, g.metadata, g.is_read, g.event_date,
                   e.full_name as employee_name, b.name as branch_name
            FROM guardian_events g
            LEFT JOIN employees e ON g.employee_id = e.id
            LEFT JOIN branches b ON g.branch_id = b.id
            WHERE g.tenant_id = $1
        `;

        const params = [tenantId];
        let paramIndex = 2;

        // Filtrar por branch_id si no se solicita ver todas
        if (all_branches !== 'true' && branchId) {
            query += ` AND g.branch_id = $${paramIndex}`;
            params.push(branchId);
            paramIndex++;
        }

        if (unreadOnly === 'true') {
            query += ' AND g.is_read = false';
        }

        query += ` ORDER BY g.event_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

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

// GET /api/branches - Obtener sucursales del tenant
app.get('/api/branches', authenticateToken, async (req, res) => {
    try {
        const { tenantId } = req.user;

        const result = await pool.query(
            `SELECT id, branch_code, name, address, phone_number, is_active, created_at
             FROM branches
             WHERE tenant_id = $1 AND is_active = true
             ORDER BY created_at ASC`,
            [tenantId]
        );

        res.json({
            success: true,
            data: result.rows
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
