// ═══════════════════════════════════════════════════════════════
// LOGIN CONTROLLER - Maneja login de Desktop y Mobile
// ═══════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

class LoginController {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Login desde aplicacion Desktop
     */
    async desktopLogin(req, res) {
        const { email, password, branchId, tenantCode } = req.body;

        console.log(`[Desktop Login] Intento de login: email=${email}, tenantCode=${tenantCode}`);

        if (!tenantCode || !email || !password) {
            return res.status(400).json({
                success: false,
                message: 'TenantCode, Email y contraseña son requeridos'
            });
        }

        try {
            // Buscar tenant por codigo
            const tenantLookup = await this.pool.query(
                'SELECT id FROM tenants WHERE tenant_code = $1 AND is_active = true',
                [tenantCode]
            );

            if (tenantLookup.rows.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: 'Codigo de tenant invalido'
                });
            }

            const tenantId = tenantLookup.rows[0].id;

            // Buscar empleado por email
            const employeeResult = await this.pool.query(
                'SELECT * FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = true',
                [email, tenantId]
            );

            if (employeeResult.rows.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales invalidas'
                });
            }

            const employee = employeeResult.rows[0];

            if (!employee.password_hash) {
                return res.status(401).json({
                    success: false,
                    message: 'Usuario no tiene contraseña configurada'
                });
            }

            // Verificar password
            let validPassword = false;
            try {
                validPassword = await bcrypt.compare(password, employee.password_hash);
            } catch (bcryptError) {
                console.error('[Desktop Login] Error en verificacion de password');
                return res.status(500).json({
                    success: false,
                    message: 'Error en el servidor'
                });
            }

            if (!validPassword) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales invalidas'
                });
            }

            // Verificar tenant y licencia
            const tenantResult = await this.pool.query(
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
            const now = new Date();
            const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;

            if (trialEndsAt && trialEndsAt < now) {
                return res.status(403).json({
                    success: false,
                    message: 'Su licencia ha caducado',
                    error: 'LICENSE_EXPIRED'
                });
            }

            // Obtener sucursales del empleado
            const branchesResult = await this.pool.query(`
                SELECT b.*
                FROM branches b
                JOIN employee_branches eb ON b.id = eb.branch_id
                WHERE eb.employee_id = $1 AND b.is_active = true
                ORDER BY b.name
            `, [employee.id]);

            const branches = branchesResult.rows;

            if (branches.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'No tienes acceso a ninguna sucursal'
                });
            }

            // Seleccionar sucursal
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
                selectedBranch = branches.find(b => b.id === employee.main_branch_id) || branches[0];
            }

            // Generar tokens
            const token = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: selectedBranch.id,
                    roleId: employee.role_id,
                    email: employee.email
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const refreshToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            console.log(`[Desktop Login] Login exitoso: ${employee.email}`);

            // Limpiar intentos de rate limiting si existe
            if (req.clearLoginAttempts) {
                req.clearLoginAttempts();
            }

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
                        fullName: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
                        firstName: employee.first_name,
                        lastName: employee.last_name,
                        roleId: employee.role_id,
                        mainBranchId: employee.main_branch_id,
                        globalId: employee.global_id,
                        isOwner: employee.is_owner,
                        profilePhotoUrl: employee.profile_photo_url || null
                    },
                    tenant: {
                        id: tenant.id,
                        tenantCode: tenant.tenant_code,
                        businessName: tenant.business_name,
                        subscriptionName: tenant.subscription_name,
                        trialEndsAt: tenant.trial_ends_at
                    },
                    branches,
                    currentBranch: selectedBranch
                }
            });

        } catch (error) {
            console.error('[Desktop Login] Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error en el servidor'
            });
        }
    }

    /**
     * Login desde aplicacion Mobile
     */
    async mobileLogin(req, res) {
        const { email, password, branchId } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email y contraseña son requeridos'
            });
        }

        try {
            // Buscar empleado con acceso movil
            const employeeResult = await this.pool.query(`
                SELECT e.*, r.name as role_name, r.mobile_access_type
                FROM employees e
                LEFT JOIN roles r ON e.role_id = r.id AND e.tenant_id = r.tenant_id
                WHERE LOWER(e.email) = LOWER($1) AND e.is_active = true
            `, [email]);

            if (employeeResult.rows.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales invalidas'
                });
            }

            const employee = employeeResult.rows[0];

            // Verificar permiso de app movil
            if (!employee.can_use_mobile_app) {
                return res.status(403).json({
                    success: false,
                    message: 'No tienes permiso para usar la aplicacion movil'
                });
            }

            // Verificar email verificado
            if (employee.email_verified !== true && !employee.is_owner) {
                return res.status(403).json({
                    success: false,
                    message: 'Tu email no ha sido verificado',
                    error: 'EMAIL_NOT_VERIFIED'
                });
            }

            if (!employee.password_hash) {
                return res.status(401).json({
                    success: false,
                    message: 'Usuario no tiene contraseña configurada'
                });
            }

            const validPassword = await bcrypt.compare(password, employee.password_hash);

            if (!validPassword) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales invalidas'
                });
            }

            // Verificar tenant y licencia
            const tenantResult = await this.pool.query(
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
            const now = new Date();
            const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;

            if (trialEndsAt && trialEndsAt < now) {
                return res.status(403).json({
                    success: false,
                    message: 'Su licencia ha caducado',
                    error: 'LICENSE_EXPIRED'
                });
            }

            // Obtener sucursales
            const branchesResult = await this.pool.query(`
                SELECT b.*
                FROM branches b
                JOIN employee_branches eb ON b.id = eb.branch_id
                WHERE eb.employee_id = $1 AND b.is_active = true
            `, [employee.id]);

            const branches = branchesResult.rows;

            if (branches.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'No tienes acceso a ninguna sucursal'
                });
            }

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
                selectedBranch = branches.find(b => b.id === employee.main_branch_id) || branches[0];
            }

            // Generar tokens
            const token = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: selectedBranch.id,
                    roleId: employee.role_id,
                    email: employee.email
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const refreshToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            // Limpiar rate limiting
            if (req.clearLoginAttempts) {
                req.clearLoginAttempts();
            }

            res.json({
                success: true,
                message: 'Login exitoso',
                data: {
                    token,
                    refreshToken,
                    employee: {
                        id: employee.id,
                        email: employee.email,
                        fullName: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
                        roleId: employee.role_id,
                        roleName: employee.role_name,
                        mobileAccessType: employee.mobile_access_type,
                        globalId: employee.global_id,
                        isOwner: employee.is_owner,
                        profilePhotoUrl: employee.profile_photo_url || null
                    },
                    tenant: {
                        id: tenant.id,
                        businessName: tenant.business_name,
                        tenantCode: tenant.tenant_code
                    },
                    branches,
                    currentBranch: selectedBranch
                }
            });

        } catch (error) {
            console.error('[Mobile Login] Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error en el servidor'
            });
        }
    }
}

module.exports = LoginController;
