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
    // POST /api/auth/google-signup
    // Registro desde Desktop con Google OAuth
    // ─────────────────────────────────────────────────────────
    router.post('/google-signup', async (req, res) => {
        console.log('[Google Signup] Nueva solicitud de registro con Google');

        const { idToken, email, displayName, businessName, phoneNumber, address, password } = req.body;

        if (!idToken || !email || !displayName || !businessName || !password) {
            return res.status(400).json({
                success: false,
                message: 'Faltan campos requeridos: idToken, email, displayName, businessName, password'
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // 1. Verificar si el email ya está registrado
            const existingEmployee = await client.query(
                'SELECT id, tenant_id FROM employees WHERE LOWER(email) = LOWER($1)',
                [email]
            );

            if (existingEmployee.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    message: 'Este email ya está registrado'
                });
            }

            // 2. Obtener la subscripción por defecto (Basic - Trial)
            const subscriptionResult = await client.query(
                "SELECT id FROM subscriptions WHERE name = 'Basic' LIMIT 1"
            );

            if (subscriptionResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(500).json({
                    success: false,
                    message: 'Error: No se encontró plan de subscripción Basic'
                });
            }

            const subscriptionId = subscriptionResult.rows[0].id;

            // 3. Generar tenant_code único
            const tenantCode = `TNT${Date.now()}`;

            // 4. Crear tenant (negocio)
            const tenantResult = await client.query(`
                INSERT INTO tenants (
                    tenant_code, business_name, subscription_id,
                    subscription_status, trial_ends_at, contact_email,
                    contact_phone, address, is_active, created_at, updated_at
                ) VALUES ($1, $2, $3, 'trial', NOW() + INTERVAL '30 days', $4, $5, $6, true, NOW(), NOW())
                RETURNING id, tenant_code, business_name, subscription_status, trial_ends_at
            `, [tenantCode, businessName, subscriptionId, email, phoneNumber, address]);

            const tenant = tenantResult.rows[0];

            console.log(`[Google Signup] ✅ Tenant creado: ${tenant.tenant_code} (ID: ${tenant.id})`);

            // 5. Crear branch por defecto (primera sucursal)
            const branchCode = `${tenantCode}-MAIN`;
            const branchResult = await client.query(`
                INSERT INTO branches (
                    tenant_id, branch_code, name, address,
                    is_active, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, true, NOW(), NOW())
                RETURNING id, branch_code, name
            `, [tenant.id, branchCode, businessName + ' - Principal', address || 'N/A']);

            const branch = branchResult.rows[0];

            console.log(`[Google Signup] ✅ Branch creado: ${branch.branch_code} (ID: ${branch.id})`);

            // 6. Hash de contraseña
            const passwordHash = await bcrypt.hash(password, 10);

            // 7. Crear empleado owner
            const username = displayName.replace(/\s+/g, '').toLowerCase();
            const employeeResult = await client.query(`
                INSERT INTO employees (
                    tenant_id, email, username, full_name, password,
                    role, is_active, google_id, main_branch_id, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, 'owner', true, $6, $7, NOW(), NOW())
                RETURNING id, email, username, full_name, role
            `, [tenant.id, email, username, displayName, passwordHash, idToken, branch.id]);

            const employee = employeeResult.rows[0];

            console.log(`[Google Signup] ✅ Employee creado: ${employee.email} (ID: ${employee.id}, Role: ${employee.role})`);

            // 8. Asignar permisos completos al owner en el branch
            await client.query(`
                INSERT INTO employee_branches (
                    employee_id, branch_id, can_login, can_sell,
                    can_manage_inventory, can_close_shift, assigned_at
                ) VALUES ($1, $2, true, true, true, true, NOW())
            `, [employee.id, branch.id]);

            await client.query('COMMIT');

            // 9. Generar JWT token
            const token = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: tenant.id,
                    branchId: branch.id,
                    role: employee.role,
                    email: employee.email
                },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            console.log(`[Google Signup] ✅ Registro completado exitosamente para: ${email}`);

            res.status(201).json({
                success: true,
                message: 'Registro exitoso',
                token,
                tenant: {
                    id: tenant.id,
                    tenantCode: tenant.tenant_code,
                    businessName: tenant.business_name,
                    subscriptionStatus: tenant.subscription_status,
                    subscriptionPlan: 'Basic',
                    trialEndsAt: tenant.trial_ends_at
                },
                employee: {
                    id: employee.id,
                    email: employee.email,
                    fullName: employee.full_name,
                    role: employee.role
                },
                branch: {
                    id: branch.id,
                    branchCode: branch.branch_code,
                    name: branch.name
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Google Signup] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al registrar usuario',
                error: error.message
            });
        } finally {
            client.release();
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
