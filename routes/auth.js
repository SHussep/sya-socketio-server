// ═══════════════════════════════════════════════════════════════
// RUTAS DE AUTENTICACIÓN - Multi-Tenant System
// ═══════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = function(pool) {
    const router = require('express').Router();

    // ─────────────────────────────────────────────────────────
    // POST /api/auth/desktop-login
    // Login desde Desktop con selector de sucursal
    // ─────────────────────────────────────────────────────────
    router.post('/desktop-login', async (req, res) => {
        console.log('[Desktop Login] Nueva solicitud de login');

        const { email, username, password, branchId } = req.body;

        // Validar que se envíe email O username
        if ((!email && !username) || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email/username y contraseña son requeridos'
            });
        }

        try {
            // Buscar empleado por email o username
            let query, params;
            if (email) {
                query = 'SELECT * FROM employees WHERE LOWER(email) = LOWER($1) AND is_active = true';
                params = [email];
            } else {
                query = 'SELECT * FROM employees WHERE LOWER(username) = LOWER($1) AND is_active = true';
                params = [username];
            }

            const employeeResult = await pool.query(query, params);

            if (employeeResult.rows.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            const employee = employeeResult.rows[0];

            // Verificar contraseña
            const validPassword = await bcrypt.compare(password, employee.password);
            if (!validPassword) {
                console.log(`[Desktop Login] Contraseña incorrecta para: ${employee.email}`);
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            // Obtener tenant
            const tenantResult = await pool.query(
                `SELECT t.*, s.name as subscription_name
                 FROM tenants t
                 JOIN subscriptions s ON t.subscription_id = s.id
                 WHERE t.id = $1 AND t.is_active = true`,
                [employee.tenant_id]
            );

            if (tenantResult.rows.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'Tenant inactivo o no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];

            // Obtener sucursales donde el empleado puede trabajar
            const branchesResult = await pool.query(`
                SELECT b.*, eb.can_login, eb.can_sell, eb.can_manage_inventory, eb.can_close_shift
                FROM branches b
                JOIN employee_branches eb ON b.id = eb.branch_id
                WHERE eb.employee_id = $1 AND b.is_active = true AND eb.can_login = true
                ORDER BY b.name
            `, [employee.id]);

            const branches = branchesResult.rows;

            if (branches.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'No tienes acceso a ninguna sucursal'
                });
            }

            // Si se especificó branchId, verificar que el empleado tenga acceso
            let selectedBranch;
            if (branchId) {
                selectedBranch = branches.find(b => b.id === parseInt(branchId));
                if (!selectedBranch) {
                    return res.status(403).json({
                        success: false,
                        message: 'No tienes acceso a esta sucursal'
                    });
                }
            } else {
                // Si no se especificó, usar la sucursal principal
                selectedBranch = branches.find(b => b.id === employee.main_branch_id) || branches[0];
            }

            // Generar JWT token
            const token = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: selectedBranch.id,
                    role: employee.role,
                    email: employee.email
                },
                JWT_SECRET,
                { expiresIn: '15m' } // Token de acceso de 15 minutos
            );

            // Generar refresh token
            const refreshToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            console.log(`[Desktop Login] ✅ Login exitoso: ${employee.email} → ${selectedBranch.name}`);

            res.json({
                success: true,
                message: 'Login exitoso',
                data: {
                    token,
                    refreshToken,
                    employee: {
                        id: employee.id,
                        email: employee.email,
                        username: employee.username,
                        fullName: employee.full_name,
                        role: employee.role
                    },
                    tenant: {
                        id: tenant.id,
                        businessName: tenant.business_name,
                        rfc: tenant.rfc,
                        subscription: tenant.subscription_name
                    },
                    branch: {
                        id: selectedBranch.id,
                        code: selectedBranch.branch_code,
                        name: selectedBranch.name,
                        permissions: {
                            canLogin: selectedBranch.can_login,
                            canSell: selectedBranch.can_sell,
                            canManageInventory: selectedBranch.can_manage_inventory,
                            canCloseShift: selectedBranch.can_close_shift
                        }
                    },
                    availableBranches: branches.map(b => ({
                        id: b.id,
                        code: b.branch_code,
                        name: b.name
                    }))
                }
            });

        } catch (error) {
            console.error('[Desktop Login] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error en el servidor',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/auth/mobile-login
    // Login desde app móvil (igual que desktop)
    // ─────────────────────────────────────────────────────────
    router.post('/mobile-login', async (req, res) => {
        // Reusa la misma lógica que desktop-login
        console.log('[Mobile Login] Redirigiendo a desktop-login logic');
        req.url = '/desktop-login';
        return router.handle(req, res);
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/auth/refresh-token
    // Renovar token de acceso usando refresh token
    // ─────────────────────────────────────────────────────────
    router.post('/refresh-token', async (req, res) => {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token requerido'
            });
        }

        try {
            // Verificar refresh token
            const decoded = jwt.verify(refreshToken, JWT_SECRET);

            // Obtener empleado actualizado
            const employeeResult = await pool.query(
                'SELECT * FROM employees WHERE id = $1 AND is_active = true',
                [decoded.employeeId]
            );

            if (employeeResult.rows.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: 'Empleado no encontrado o inactivo'
                });
            }

            const employee = employeeResult.rows[0];

            // Generar nuevo access token
            const newToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: employee.main_branch_id,
                    role: employee.role,
                    email: employee.email
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            console.log(`[Refresh Token] ✅ Token renovado para: ${employee.email}`);

            res.json({
                success: true,
                token: newToken
            });

        } catch (error) {
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Refresh token inválido o expirado'
                });
            }

            console.error('[Refresh Token] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al renovar token',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // Middleware: Verificar JWT Token
    // ─────────────────────────────────────────────────────────
    router.authenticateToken = function(req, res, next) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) {
                return res.status(403).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            req.user = user;
            next();
        });
    };

    return router;
};
