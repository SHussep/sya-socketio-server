const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const archiver = require('archiver');
const { Readable } = require('stream');
const dropboxManager = require('../utils/dropbox-manager');
const { OAuth2Client } = require('google-auth-library');

const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Helper: Derive mobile access type from role_id and can_use_mobile_app
// Must match the logic in routes/employees.js getMobileAccessType
const deriveMobileAccessType = (roleId, canUseMobileApp) => {
    if (!canUseMobileApp) return 'none';

    switch (roleId) {
        case 1:
        case 2:
            return 'admin';      // Administrador, Encargado
        case 3:
            return 'distributor'; // Repartidor
        case 4:
        case 99:
        default:
            return 'none';
    }
};

class AuthController {
    constructor(pool) {
        this.pool = pool;
    }

    async startGmailOAuth(req, res) {
        console.log('[Gmail OAuth] Generando URL de autenticación');

        try {
            const redirectUri = process.env.GMAIL_REDIRECT_URI ||
                `${req.protocol}://${req.get('host')}/api/auth/gmail/oauth-callback`;

            const oauth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET,
                redirectUri
            );

            const authUrl = oauth2Client.generateAuthUrl({
                access_type: 'offline',
                prompt: 'consent',
                scope: [
                    'openid',
                    'https://www.googleapis.com/auth/gmail.send',
                    'https://www.googleapis.com/auth/userinfo.email',
                    'https://www.googleapis.com/auth/userinfo.profile'
                ]
            });

            console.log('[Gmail OAuth] ✅ URL generada exitosamente');

            res.json({
                success: true,
                auth_url: authUrl
            });

        } catch (error) {
            console.error('[Gmail OAuth] Error generando URL:', error);
            res.status(500).json({
                success: false,
                message: 'Error al generar URL de autenticación',
                error: error.message
            });
        }
    }

    gmailOAuthCallbackPage(req, res) {
        const code = req.query.code;

        if (code) {
            res.send(`
                <html>
                    <head>
                        <title>Autenticación Exitosa</title>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                            h1 { color: #4CAF50; }
                        </style>
                    </head>
                    <body>
                        <h1>✅ Autenticación Exitosa</h1>
                        <p>Tu cuenta de Gmail ha sido vinculada correctamente.</p>
                        <p>Puedes cerrar esta ventana.</p>
                    </body>
                </html>
            `);
        } else {
            res.status(400).send(`
                <html>
                    <head>
                        <title>Error de Autenticación</title>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                            h1 { color: #f44336; }
                        </style>
                    </head>
                    <body>
                        <h1>❌ Error de Autenticación</h1>
                        <p>No se recibió el código de autorización.</p>
                        <p>Por favor, intenta de nuevo.</p>
                    </body>
                </html>
            `);
        }
    }

    async exchangeGmailCode(req, res) {
        console.log('[Gmail Callback] Intercambiando código por tokens');

        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                success: false,
                message: 'Código de autorización requerido'
            });
        }

        try {
            const redirectUri = process.env.GMAIL_REDIRECT_URI ||
                `${req.protocol}://${req.get('host')}/api/auth/gmail/oauth-callback`;

            const oauth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET,
                redirectUri
            );

            const { tokens } = await oauth2Client.getToken(code);

            console.log('[Gmail Callback] ✅ Tokens obtenidos exitosamente');
            console.log('[Gmail Callback] 📊 Tokens recibidos de Google:');
            console.log('[Gmail Callback]    - access_token:', tokens.access_token ? `${tokens.access_token.substring(0, 20)}...` : 'NO');
            console.log('[Gmail Callback]    - refresh_token:', tokens.refresh_token ? `${tokens.refresh_token.substring(0, 20)}...` : '❌ NO PRESENTE');
            console.log('[Gmail Callback]    - id_token:', tokens.id_token ? 'Sí' : 'NO');
            console.log('[Gmail Callback]    - expiry_date:', tokens.expiry_date);

            if (!tokens.refresh_token) {
                console.error('[Gmail Callback] ❌ ERROR CRÍTICO: Google NO devolvió refresh_token!');
                console.error('[Gmail Callback] Esto ocurre cuando el usuario ya autorizó la app antes.');
                console.error('[Gmail Callback] Solución: Asegurar que prompt=consent esté en la URL de auth.');
            }

            res.json({
                success: true,
                tokens: {
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    id_token: tokens.id_token,
                    expiry_date: tokens.expiry_date,
                    token_type: tokens.token_type,
                    scope: tokens.scope
                }
            });

        } catch (error) {
            console.error('[Gmail Callback] Error intercambiando código:', error);
            res.status(500).json({
                success: false,
                message: 'Error al intercambiar código de autorización',
                error: error.message
            });
        }
    }

    async refreshGmailToken(req, res) {
        console.log('[Gmail Refresh] Refrescando access token');

        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token requerido'
            });
        }

        try {
            const oauth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET
            );

            oauth2Client.setCredentials({
                refresh_token: refresh_token
            });

            const { credentials } = await oauth2Client.refreshAccessToken();

            console.log('[Gmail Refresh] ✅ Access token refrescado exitosamente');

            res.json({
                success: true,
                tokens: {
                    access_token: credentials.access_token,
                    refresh_token: credentials.refresh_token || refresh_token,
                    expiry_date: credentials.expiry_date,
                    token_type: credentials.token_type,
                    scope: credentials.scope
                }
            });

        } catch (error) {
            console.error('[Gmail Refresh] Error refrescando token:', error);
            res.status(401).json({
                success: false,
                message: 'Error al refrescar access token. El refresh token puede ser inválido o expirado.',
                error: error.message
            });
        }
    }

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
            console.log(`[Desktop Login] 🔍 Buscando tenant con código: ${tenantCode}`);
            const tenantLookup = await this.pool.query(
                'SELECT id FROM tenants WHERE tenant_code = $1 AND is_active = true',
                [tenantCode]
            );

            if (tenantLookup.rows.length === 0) {
                console.log(`[Desktop Login] ❌ Tenant no encontrado con código: ${tenantCode}`);
                return res.status(401).json({
                    success: false,
                    message: 'Código de tenant inválido'
                });
            }

            const tenantId = tenantLookup.rows[0].id;
            console.log(`[Desktop Login] ✅ Tenant encontrado: ID ${tenantId}`);

            // Buscar empleado SOLO por email
            const query = 'SELECT * FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = true';
            const params = [email, tenantId];

            console.log('[Desktop Login] Ejecutando query:', query);
            console.log('[Desktop Login] Parámetros:', params);

            const employeeResult = await this.pool.query(query, params);

            console.log(`[Desktop Login] Empleados encontrados: ${employeeResult.rows.length}`);

            if (employeeResult.rows.length > 1) {
                console.log('[Desktop Login] ADVERTENCIA: Multiples empleados con el mismo email');
            }

            if (employeeResult.rows.length === 0) {
                console.log('[Desktop Login] ❌ No se encontró empleado con esas credenciales');
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            const employee = employeeResult.rows[0];
            console.log(`[Desktop Login] Empleado encontrado: ID ${employee.id}, Email ${employee.email}`);

            if (!employee.password_hash) {
                console.log(`[Desktop Login] ⚠️ Empleado ${employee.email} no tiene contraseña configurada`);
                return res.status(401).json({
                    success: false,
                    message: 'Usuario no tiene contraseña configurada. Contacte al administrador.'
                });
            }

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
                console.log(`[Desktop Login] Contraseña incorrecta para: ${employee.email}`);
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            // ═══════════════════════════════════════════════════════════════════
            // ✅ AUTO-GENERAR GLOBAL_ID SI NO EXISTE (Garantiza sincronización)
            // Esto es crítico para empleados creados antes del sistema offline-first
            // ═══════════════════════════════════════════════════════════════════
            if (!employee.global_id) {
                const { v4: uuidv4 } = require('uuid');
                const newGlobalId = uuidv4();
                const newTerminalId = 'server-auto-' + Date.now();

                await this.pool.query(
                    `UPDATE employees
                     SET global_id = $1,
                         terminal_id = COALESCE(terminal_id, $2),
                         local_op_seq = COALESCE(local_op_seq, 1),
                         created_local_utc = COALESCE(created_local_utc, $3)
                     WHERE id = $4`,
                    [newGlobalId, newTerminalId, new Date().toISOString(), employee.id]
                );

                employee.global_id = newGlobalId;
                employee.terminal_id = newTerminalId;
                console.log(`[Desktop Login] 🔑 GlobalId auto-generado para empleado ${employee.id}: ${newGlobalId}`);
            }

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
                const daysExpired = Math.ceil((now - trialEndsAt) / (1000 * 60 * 60 * 24));
                console.log(`[Desktop Login] ❌ Licencia vencida para tenant ${tenant.id}. Expiró hace ${daysExpired} días.`);
                return res.status(403).json({
                    success: false,
                    message: 'Su licencia ha caducado. Por favor, contacte con soporte para renovar.',
                    error: 'LICENSE_EXPIRED',
                    licenseInfo: {
                        expiresAt: trialEndsAt.toISOString(),
                        daysExpired: daysExpired,
                        businessName: tenant.business_name
                    }
                });
            }

            const daysRemaining = trialEndsAt ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)) : null;
            console.log(`[Desktop Login] Licencia válida. Días restantes: ${daysRemaining || 'ilimitado'}`);

            // Query simplificado - sin columnas de permisos que pueden no existir
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
                        fullName: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
                        firstName: employee.first_name,
                        lastName: employee.last_name,
                        roleId: employee.role_id,
                        mainBranchId: employee.main_branch_id,
                        canUseMobileApp: employee.can_use_mobile_app,
                        googleUserIdentifier: employee.google_user_identifier,
                        globalId: employee.global_id,
                        terminalId: employee.terminal_id,
                        localOpSeq: employee.local_op_seq,
                        createdLocalUtc: employee.created_local_utc,
                        deviceEventRaw: employee.device_event_raw
                    },
                    tenant: {
                        id: tenant.id,
                        businessName: tenant.business_name,
                        rfc: tenant.rfc,
                        subscription: tenant.subscription_name,
                        license: {
                            expiresAt: trialEndsAt ? trialEndsAt.toISOString() : null,
                            daysRemaining: daysRemaining,
                            status: daysRemaining === null ? 'unlimited' : (daysRemaining <= 7 ? 'expiring_soon' : 'active')
                        }
                    },
                    branch: {
                        id: selectedBranch.id,
                        code: selectedBranch.branch_code,
                        name: selectedBranch.name,
                        permissions: {
                            canLogin: selectedBranch.can_login ?? true,
                            canSell: selectedBranch.can_sell ?? true,
                            canManageInventory: selectedBranch.can_manage_inventory ?? false,
                            canCloseShift: selectedBranch.can_close_shift ?? false
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
    }

    async mobileLogin(req, res) {
        console.log('[Mobile Login] Nueva solicitud de login desde app móvil');

        const { email, password, branchId } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email y contraseña son requeridos'
            });
        }

        try {
            // Buscar empleado SOLO por email, con JOIN a roles para obtener mobile_access_type
            const query = `
                SELECT e.*, r.name as role_name, r.mobile_access_type
                FROM employees e
                LEFT JOIN roles r ON e.role_id = r.id AND e.tenant_id = r.tenant_id
                WHERE LOWER(e.email) = LOWER($1) AND e.is_active = true
            `;
            const params = [email];

            const employeeResult = await this.pool.query(query, params);

            if (employeeResult.rows.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            const employee = employeeResult.rows[0];

            if (!employee.can_use_mobile_app) {
                console.log(`[Mobile Login] ❌ Empleado ${employee.email} NO tiene permiso para app móvil`);
                return res.status(403).json({
                    success: false,
                    message: 'No tienes permiso para usar la aplicación móvil. Contacta al administrador.'
                });
            }

            // Verificar que el email esté verificado (requerido para app móvil)
            // NOTA: El owner (is_owner = true) está verificado implícitamente por haber usado Gmail OAuth
            if (employee.email_verified !== true && !employee.is_owner) {
                console.log(`[Mobile Login] ❌ Empleado ${employee.email} NO tiene email verificado (email_verified=${employee.email_verified})`);
                return res.status(403).json({
                    success: false,
                    message: 'Tu email no ha sido verificado. Contacta al administrador para completar la verificación.',
                    error: 'EMAIL_NOT_VERIFIED'
                });
            }

            if (!employee.password_hash) {
                return res.status(401).json({
                    success: false,
                    message: 'Usuario no tiene contraseña configurada. Contacte al administrador.'
                });
            }

            const validPassword = await bcrypt.compare(password, employee.password_hash);

            if (!validPassword) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

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
                const daysExpired = Math.ceil((now - trialEndsAt) / (1000 * 60 * 60 * 24));
                console.log(`[Mobile Login] ❌ Licencia vencida para tenant ${tenant.id}. Expiró hace ${daysExpired} días.`);
                return res.status(403).json({
                    success: false,
                    message: 'Su licencia ha caducado. Por favor, contacte con soporte para renovar.',
                    error: 'LICENSE_EXPIRED',
                    licenseInfo: {
                        expiresAt: trialEndsAt.toISOString(),
                        daysExpired: daysExpired,
                        businessName: tenant.business_name
                    }
                });
            }

            const daysRemaining = trialEndsAt ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)) : null;
            console.log(`[Mobile Login] Licencia válida. Días restantes: ${daysRemaining || 'ilimitado'}`);

            // Query simplificado - sin columnas de permisos que pueden no existir
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

            const token = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: selectedBranch.id,
                    roleId: employee.role_id,
                    email: employee.email,
                    canUseMobileApp: employee.can_use_mobile_app
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

            const employeeData = {
                id: employee.id,
                global_id: employee.global_id,  // ✅ Necesario para preferencias de notificaciones
                username: employee.username,
                fullName: employee.full_name || `${employee.first_name || ''} ${employee.last_name || ''}`.trim() || employee.username,
                email: employee.email,
                role: employee.role_name || 'Empleado',
                roleId: employee.role_id,
                isActive: employee.is_active,
                canUseMobileApp: employee.can_use_mobile_app,
                mobileAccessType: employee.mobile_access_type || 'none',  // Viene del JOIN con roles table
                createdAt: employee.created_at
            };

            console.log(`[Mobile Login] 📱 Tipo de acceso móvil: ${employee.mobile_access_type || 'none'} (from roles table, roleId=${employee.role_id}) para ${employee.email}`);

            const branchesData = branches.map(branch => ({
                id: branch.id,
                name: branch.name,
                address: branch.address,
                api_base_url: branch.api_url,
                is_active: branch.is_active,
                last_sync_date: new Date().toISOString(),
                timezone: branch.timezone || 'America/Mexico_City'
            }));

            console.log(`[Mobile Login] ✅ Login exitoso: ${employee.email} (can_use_mobile_app=true)`);

            return res.json({
                success: true,
                message: 'Login exitoso',
                data: {
                    token,
                    refreshToken,
                    employee: employeeData,
                    availableBranches: branchesData,
                    selectedBranch: selectedBranch,
                    tenant: {
                        id: tenant.id,
                        name: tenant.name,
                        businessName: tenant.business_name,
                        subscription: tenant.subscription_name,
                        license: {
                            expiresAt: trialEndsAt ? trialEndsAt.toISOString() : null,
                            daysRemaining: daysRemaining,
                            status: daysRemaining === null ? 'unlimited' : (daysRemaining <= 7 ? 'expiring_soon' : 'active')
                        }
                    }
                }
            });

        } catch (error) {
            console.error('[Mobile Login] Error:', error);
            return res.status(500).json({
                success: false,
                message: 'Error del servidor',
                error: error.message
            });
        }
    }

    async refreshToken(req, res) {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token requerido'
            });
        }

        try {
            const decoded = jwt.verify(refreshToken, JWT_SECRET);

            const employeeResult = await this.pool.query(
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

            const newToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: employee.main_branch_id,
                    roleId: employee.role_id,
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
    }

    async googleSignup(req, res) {
        console.log('[Google Signup] Nueva solicitud de registro con Google');

        const { idToken, email, displayName, businessName, phoneNumber, address, password } = req.body;

        if (!email || !displayName || !businessName || !password) {
            return res.status(400).json({
                success: false,
                message: 'Faltan campos requeridos: email, displayName, businessName, password'
            });
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const existingTenant = await client.query(
                'SELECT id, tenant_code, business_name FROM tenants WHERE LOWER(email) = LOWER($1)',
                [email]
            );

            if (existingTenant.rows.length > 0) {
                const tenantId = existingTenant.rows[0].id;
                const branchesResult = await client.query(
                    `SELECT id, branch_code, name, timezone
                     FROM branches
                     WHERE tenant_id = $1
                     ORDER BY created_at ASC`,
                    [tenantId]
                );

                console.log(`[Google Signup] Email ya existe. Tenant: ${existingTenant.rows[0].business_name}, Sucursales: ${branchesResult.rows.length}`);

                await client.query('ROLLBACK');
                return res.status(409).json({
                    success: false,
                    message: 'Este email ya está registrado',
                    emailExists: true,
                    tenant: {
                        id: existingTenant.rows[0].id,
                        tenantCode: existingTenant.rows[0].tenant_code,
                        businessName: existingTenant.rows[0].business_name
                    },
                    branches: branchesResult.rows.map(b => ({
                        id: b.id,
                        branchCode: b.branch_code,
                        name: b.name,
                        timezone: b.timezone || 'America/Mexico_City'
                    }))
                });
            }

            const subscriptionResult = await client.query(
                "SELECT id FROM subscriptions WHERE name = 'Trial' LIMIT 1"
            );

            if (subscriptionResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(500).json({
                    success: false,
                    message: 'Error: No se encontró plan de subscripción Trial'
                });
            }

            const subscriptionId = subscriptionResult.rows[0].id;
            const tenantCode = `TEN${Date.now()}`;
            const trialEndsAt = new Date();
            trialEndsAt.setDate(trialEndsAt.getDate() + 30);

            console.log(`[Google Signup] 📊 Datos a insertar:`);
            console.log(`  - tenant_code: ${tenantCode}`);
            console.log(`  - business_name: ${businessName}`);
            console.log(`  - email: ${email}`);
            console.log(`  - subscription_id: ${subscriptionId} (Trial)`);
            console.log(`  - trial_ends_at: ${trialEndsAt.toISOString()}`);

            const tenantResult = await client.query(`
                INSERT INTO tenants (tenant_code, business_name, email, subscription_id, trial_ends_at, subscription_status)
                VALUES ($1, $2, $3, $4, $5, 'trial')
                RETURNING id, tenant_code, business_name, email, subscription_id, trial_ends_at, subscription_status
            `, [tenantCode, businessName, email, subscriptionId, trialEndsAt]);

            const tenant = tenantResult.rows[0];

            console.log(`[Google Signup] ✅ Tenant creado exitosamente:`);
            console.log(`  - ID: ${tenant.id}`);
            console.log(`  - tenant_code: ${tenant.tenant_code}`);
            console.log(`  - subscription_id: ${tenant.subscription_id}`);
            console.log(`  - trial_ends_at: ${tenant.trial_ends_at}`);

            console.log(`[Google Signup] 📝 Usando roles globales del sistema...`);
            const accesoTotalRoleId = 1;
            const accesoRepartidorRoleId = 3;
            console.log(`[Google Signup] ✅ Roles globales asignados: Administrador (ID: ${accesoTotalRoleId}), Repartidor (ID: ${accesoRepartidorRoleId})`);

            const branchCode = `B${tenant.id}M`;
            const branchResult = await client.query(`
                INSERT INTO branches (tenant_id, branch_code, name)
                VALUES ($1, $2, $3)
                RETURNING id, branch_code, name
            `, [tenant.id, branchCode, businessName + ' - Principal']);

            const branch = branchResult.rows[0];

            console.log(`[Google Signup] ✅ Branch creado: ${branch.branch_code} (ID: ${branch.id})`);

            const passwordHash = await bcrypt.hash(password, 10);
            const username = displayName.replace(/\s+/g, '').toLowerCase();

            const nameParts = displayName.trim().split(/\s+/);
            const firstName = nameParts[0] || displayName;
            const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

            const employeeResult = await client.query(`
                INSERT INTO employees (
                    tenant_id, email, username, first_name, last_name, password_hash,
                    role_id, main_branch_id, can_use_mobile_app, is_active, is_owner,
                    google_user_identifier, global_id, password_updated_at, email_verified, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true, true, $9, gen_random_uuid()::text, NOW(), true, NOW(), NOW())
                RETURNING id, email, username, first_name, last_name, role_id, can_use_mobile_app, is_active, global_id, created_at
            `, [tenant.id, email, username, firstName, lastName, passwordHash, accesoTotalRoleId, branch.id, email]);

            const employee = employeeResult.rows[0];

            console.log(`[Google Signup] ✅ Employee creado: ${employee.email} (ID: ${employee.id}, RoleId: ${employee.role_id})`);

            await client.query(`
                INSERT INTO employee_branches (
                    tenant_id, employee_id, branch_id
                ) VALUES ($1, $2, $3)
            `, [tenant.id, employee.id, branch.id]);

            const genericCustomerResult = await client.query(
                'SELECT get_or_create_generic_customer($1, $2) as customer_id',
                [tenant.id, branch.id]
            );
            const genericCustomerId = genericCustomerResult.rows[0].customer_id;
            console.log(`[Google Signup] ✅ Cliente genérico creado: ID ${genericCustomerId}`);

            await client.query('COMMIT');

            try {
                console.log(`[Google Signup] Creando backup inicial para branch ${branch.id}...`);

                const archive = archiver('zip', { zlib: { level: 9 } });
                const chunks = [];

                archive.on('data', (chunk) => chunks.push(chunk));

                const readmeContent = `SYA Tortillerías - Backup Inicial

Este es el backup automático creado al registrar la cuenta.
Fecha de creación: ${new Date().toISOString()}
Tenant: ${tenant.business_name} (${tenant.tenant_code})
Branch: ${branch.name} (${branch.branch_code})
Employee: ${displayName} (${employee.email})

Este backup inicial está vacío y se actualizará con el primer respaldo real del sistema.`;

                archive.append(readmeContent, { name: 'README.txt' });
                archive.finalize();

                await new Promise((resolve) => archive.on('end', resolve));

                const backupBuffer = Buffer.concat(chunks);
                const filename = `SYA_Backup_Branch_${branch.id}.zip`;
                const dropboxPath = `/SYA Backups/${tenant.id}/${branch.id}/${filename}`;

                await dropboxManager.createFolder(`/SYA Backups/${tenant.id}/${branch.id}`);
                await dropboxManager.uploadFile(dropboxPath, backupBuffer, true);

                await this.pool.query(
                    `INSERT INTO backup_metadata (
                        tenant_id, branch_id, employee_id, backup_filename, backup_path,
                        file_size_bytes, device_name, device_id, is_automatic, encryption_enabled
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                        tenant.id,
                        branch.id,
                        employee.id,
                        filename,
                        dropboxPath,
                        backupBuffer.length,
                        'Sistema',
                        'initial-signup',
                        true,
                        false
                    ]
                );

                console.log(`[Google Signup] ✅ Backup inicial creado: ${dropboxPath} (${(backupBuffer.length / 1024).toFixed(2)} KB)`);
            } catch (backupError) {
                console.error(`[Google Signup] ⚠️ Error al crear backup inicial:`, backupError.message);
            }

            const token = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: tenant.id,
                    branchId: branch.id,
                    roleId: employee.role_id,
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
                    trialEndsAt: tenant.trial_ends_at,
                    subscriptionStatus: tenant.subscription_status || 'trial'
                },
                employee: {
                    id: employee.id,
                    email: employee.email,
                    fullName: `${employee.first_name} ${employee.last_name}`.trim(),
                    roleId: employee.role_id,
                    globalId: employee.global_id
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
            console.error('[Google Signup] Error code:', error.code);

            if (error.code === '23505') {
                try {
                    console.log('[Google Signup] Error 23505 detectado - verificando email existente');
                    const existingTenant = await this.pool.query(
                        'SELECT id, tenant_code, business_name FROM tenants WHERE LOWER(email) = LOWER($1)',
                        [req.body.email]
                    );

                    if (existingTenant.rows.length > 0) {
                        const tenantId = existingTenant.rows[0].id;
                        const branchesResult = await this.pool.query(
                            `SELECT id, branch_code, name, timezone
                             FROM branches
                             WHERE tenant_id = $1
                             ORDER BY created_at ASC`,
                            [tenantId]
                        );

                        console.log(`[Google Signup] Email duplicado capturado en catch. Tenant: ${existingTenant.rows[0].business_name}, Sucursales: ${branchesResult.rows.length}`);

                        client.release();
                        return res.status(409).json({
                            success: false,
                            message: 'Este email ya está registrado',
                            emailExists: true,
                            tenant: {
                                id: existingTenant.rows[0].id,
                                tenantCode: existingTenant.rows[0].tenant_code,
                                businessName: existingTenant.rows[0].business_name
                            },
                            branches: branchesResult.rows.map(b => ({
                                id: b.id,
                                branchCode: b.branch_code,
                                name: b.name,
                                timezone: b.timezone || 'America/Mexico_City'
                            }))
                        });
                    }
                } catch (nestedError) {
                    console.error('[Google Signup] Error al manejar email duplicado:', nestedError);
                }
            }

            res.status(500).json({
                success: false,
                message: 'Error al registrar usuario',
                error: error.message
            });
        } finally {
            client.release();
        }
    }

    async googleLogin(req, res) {
        console.log('[Google Login] Nueva solicitud de verificación con Google ID Token');

        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: 'idToken es requerido'
            });
        }

        try {
            console.log('[Google Login] Verificando Google ID Token...');
            let ticket;
            try {
                ticket = await googleClient.verifyIdToken({
                    idToken: idToken,
                    audience: GOOGLE_CLIENT_ID
                });
            } catch (error) {
                console.error('[Google Login] Error al verificar ID Token:', error.message);
                return res.status(401).json({
                    success: false,
                    message: 'Token de Google inválido o expirado'
                });
            }

            const payload = ticket.getPayload();
            const email = payload.email;
            const googleName = payload.name;

            console.log(`[Google Login] Token verificado. Email: ${email}`);

            const employeeResult = await this.pool.query(
                'SELECT * FROM employees WHERE LOWER(email) = LOWER($1) AND is_active = true',
                [email]
            );

            if (employeeResult.rows.length === 0) {
                console.log(`[Google Login] Email no registrado: ${email}`);
                return res.json({
                    success: true,
                    emailExists: false,
                    email: email,
                    googleName: googleName
                });
            }

            const employee = employeeResult.rows[0];

            const tenantResult = await this.pool.query(
                `SELECT t.*, s.name as subscription_name, s.max_branches, s.max_employees, s.max_devices_per_branch
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

            const branchesResult = await this.pool.query(`
                SELECT b.id, b.branch_code, b.name, b.address, b.timezone
                FROM branches b
                WHERE b.tenant_id = $1 AND b.is_active = true
                ORDER BY b.created_at ASC
            `, [employee.tenant_id]);

            const branches = branchesResult.rows;

            const accessToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    roleId: employee.role_id,
                    email: employee.email
                },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            const refreshToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            console.log(`[Google Login] ✅ Email existe: ${employee.email} - ${branches.length} sucursales disponibles`);

            res.json({
                success: true,
                emailExists: true,
                email: email,
                employee: {
                    id: employee.id,
                    email: employee.email,
                    username: employee.username,
                    fullName: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
                    role: employee.role
                },
                tenant: {
                    id: tenant.id,
                    tenantCode: tenant.tenant_code,
                    businessName: tenant.business_name,
                    rfc: tenant.rfc,
                    subscription: tenant.subscription_name
                },
                branches: branches.map(b => ({
                    id: b.id,
                    branchCode: b.branch_code,
                    name: b.name,
                    address: b.address,
                    timezone: b.timezone || 'America/Mexico_City'
                })),
                planLimits: {
                    maxBranches: tenant.max_branches,
                    maxEmployees: tenant.max_employees,
                    maxDevicesPerBranch: tenant.max_devices_per_branch
                },
                accessToken,
                refreshToken
            });

        } catch (error) {
            console.error('[Google Login] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error en el servidor',
                error: error.message
            });
        }
    }

    async registerDevice(req, res) {
        console.log('[Device Register] Nueva solicitud de registro de dispositivo');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const { tenantId, branchId, employeeId, deviceId, deviceName, deviceType } = req.body;

        if (!tenantId || !branchId || !employeeId || !deviceId) {
            return res.status(400).json({
                success: false,
                message: 'Faltan campos requeridos: tenantId, branchId, employeeId, deviceId'
            });
        }

        const client = await this.pool.connect();

        try {
            const decoded = jwt.verify(token, JWT_SECRET);

            // Validar que el tenantId coincida
            if (decoded.tenantId !== tenantId) {
                return res.status(403).json({
                    success: false,
                    message: 'No autorizado para registrar dispositivos en este tenant'
                });
            }

            // Validar que el employeeId existe y pertenece al tenant
            const employeeCheck = await client.query(
                'SELECT id FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [employeeId, tenantId]
            );

            if (employeeCheck.rows.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'Empleado no encontrado o no pertenece a este tenant'
                });
            }

            await client.query('BEGIN');

            // ⭐ MIGRACIÓN: Agregar columnas faltantes si no existen
            try {
                await client.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_id TEXT`);
                await client.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_name VARCHAR(255)`);
                await client.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
                await client.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP`);
                await client.query(`ALTER TABLE devices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
                console.log('[Device Register] ✅ Columnas de migración verificadas/agregadas');
            } catch (migrationError) {
                console.log('[Device Register] ⚠️ Migración de columnas (puede ignorarse si ya existen):', migrationError.message);
            }

            const tenantResult = await client.query(`
                SELECT t.id, t.tenant_code, t.business_name,
                       s.name as subscription_name, s.max_devices_per_branch
                FROM tenants t
                JOIN subscriptions s ON t.subscription_id = s.id
                WHERE t.id = $1 AND t.is_active = true
            `, [tenantId]);

            if (tenantResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado o inactivo'
                });
            }

            const tenant = tenantResult.rows[0];
            const maxDevicesPerBranch = tenant.max_devices_per_branch || 3;

            const branchResult = await client.query(
                'SELECT * FROM branches WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [branchId, tenantId]
            );

            if (branchResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada o no pertenece a este tenant'
                });
            }

            const branch = branchResult.rows[0];

            const existingDeviceResult = await client.query(
                'SELECT * FROM devices WHERE device_id = $1 AND tenant_id = $2',
                [deviceId, tenantId]
            );

            if (existingDeviceResult.rows.length > 0) {
                const existingDevice = existingDeviceResult.rows[0];

                if (existingDevice.branch_id === branchId && existingDevice.is_active) {
                    await client.query('COMMIT');
                    console.log(`[Device Register] Dispositivo ya registrado y activo en branch ${branch.name}`);
                    return res.json({
                        success: true,
                        message: 'Dispositivo ya está registrado en esta sucursal',
                        device: {
                            id: existingDevice.id,
                            deviceId: existingDevice.device_id,
                            deviceName: existingDevice.device_name,
                            deviceType: existingDevice.device_type,
                            branchId: existingDevice.branch_id,
                            branchName: branch.name,
                            isActive: existingDevice.is_active,
                            lastSeen: existingDevice.last_seen
                        }
                    });
                }

                if (existingDevice.branch_id !== branchId) {
                    console.log(`[Device Register] Dispositivo se moverá de branch ${existingDevice.branch_id} a ${branchId}`);

                    const activeDevicesResult = await client.query(
                        'SELECT COUNT(*) as count FROM devices WHERE branch_id = $1 AND is_active = true AND device_id != $2',
                        [branchId, deviceId]
                    );

                    const activeDevicesCount = parseInt(activeDevicesResult.rows[0].count);

                    if (activeDevicesCount >= maxDevicesPerBranch) {
                        await client.query('ROLLBACK');
                        return res.status(403).json({
                            success: false,
                            message: `La sucursal "${branch.name}" ha alcanzado el límite de ${maxDevicesPerBranch} dispositivos para el plan ${tenant.subscription_name}. Actualiza tu suscripción para agregar más dispositivos.`
                        });
                    }

                    await client.query(
                        `UPDATE devices
                         SET branch_id = $1, employee_id = $2, device_name = $3,
                             device_type = $4, is_active = true, last_seen = NOW(), updated_at = NOW()
                         WHERE device_id = $5 AND tenant_id = $6`,
                        [branchId, employeeId, deviceName || existingDevice.device_name, deviceType || existingDevice.device_type, deviceId, tenantId]
                    );
                }

                if (existingDevice.branch_id === branchId && !existingDevice.is_active) {
                    const activeDevicesResult = await client.query(
                        'SELECT COUNT(*) as count FROM devices WHERE branch_id = $1 AND is_active = true',
                        [branchId]
                    );

                    const activeDevicesCount = parseInt(activeDevicesResult.rows[0].count);

                    if (activeDevicesCount >= maxDevicesPerBranch) {
                        await client.query('ROLLBACK');
                        return res.status(403).json({
                            success: false,
                            message: `La sucursal "${branch.name}" ha alcanzado el límite de ${maxDevicesPerBranch} dispositivos para el plan ${tenant.subscription_name}. Actualiza tu suscripción para agregar más dispositivos.`
                        });
                    }

                    await client.query(
                        `UPDATE devices
                         SET is_active = true, employee_id = $1, device_name = $2,
                             device_type = $3, last_seen = NOW(), updated_at = NOW()
                         WHERE device_id = $4 AND tenant_id = $5`,
                        [employeeId, deviceName || existingDevice.device_name, deviceType || existingDevice.device_type, deviceId, tenantId]
                    );
                }

                await client.query('COMMIT');

                const updatedDeviceResult = await client.query(
                    'SELECT * FROM devices WHERE device_id = $1 AND tenant_id = $2',
                    [deviceId, tenantId]
                );

                const updatedDevice = updatedDeviceResult.rows[0];

                console.log(`[Device Register] ✅ Dispositivo actualizado: ${deviceId} en branch ${branch.name}`);

                return res.json({
                    success: true,
                    message: 'Dispositivo registrado exitosamente',
                    device: {
                        id: updatedDevice.id,
                        deviceId: updatedDevice.device_id,
                        deviceName: updatedDevice.device_name,
                        deviceType: updatedDevice.device_type,
                        branchId: updatedDevice.branch_id,
                        branchName: branch.name,
                        isActive: updatedDevice.is_active,
                        lastSeen: updatedDevice.last_seen
                    }
                });
            }

            const activeDevicesResult = await client.query(
                'SELECT COUNT(*) as count FROM devices WHERE branch_id = $1 AND is_active = true',
                [branchId]
            );

            const activeDevicesCount = parseInt(activeDevicesResult.rows[0].count);

            if (activeDevicesCount >= maxDevicesPerBranch) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: `La sucursal "${branch.name}" ha alcanzado el límite de ${maxDevicesPerBranch} dispositivos para el plan ${tenant.subscription_name}. Actualiza tu suscripción para agregar más dispositivos.`
                });
            }

            const newDeviceResult = await client.query(`
                INSERT INTO devices (
                    tenant_id, branch_id, employee_id, device_id,
                    device_name, device_type, is_active, last_seen
                ) VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
                RETURNING id, device_id, device_name, device_type, branch_id, is_active, last_seen
            `, [tenantId, branchId, employeeId, deviceId, deviceName || 'Dispositivo', deviceType || 'desktop']);

            const newDevice = newDeviceResult.rows[0];

            await client.query('COMMIT');

            console.log(`[Device Register] ✅ Dispositivo creado: ${deviceId} en branch ${branch.name} (${activeDevicesCount + 1}/${maxDevicesPerBranch})`);

            res.status(201).json({
                success: true,
                message: 'Dispositivo registrado exitosamente',
                device: {
                    id: newDevice.id,
                    deviceId: newDevice.device_id,
                    deviceName: newDevice.device_name,
                    deviceType: newDevice.device_type,
                    branchId: newDevice.branch_id,
                    branchName: branch.name,
                    isActive: newDevice.is_active,
                    lastSeen: newDevice.last_seen
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');

            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            console.error('[Device Register] Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al registrar dispositivo'
            });
        } finally {
            client.release();
        }
    }

    async overwriteTenant(req, res) {
        console.log('[Tenant Overwrite] Nueva solicitud de sobrescritura de tenant');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const tenantId = parseInt(req.params.id);
        const { businessName, ownerName, phoneNumber, address, password } = req.body;

        if (!tenantId || isNaN(tenantId)) {
            return res.status(400).json({
                success: false,
                message: 'ID de tenant inválido'
            });
        }

        if (!businessName || !ownerName || !password) {
            return res.status(400).json({
                success: false,
                message: 'businessName, ownerName y password son requeridos'
            });
        }

        const client = await this.pool.connect();

        try {
            const decoded = jwt.verify(token, JWT_SECRET);

            if (decoded.tenantId !== tenantId) {
                return res.status(403).json({
                    success: false,
                    message: 'No autorizado para modificar este tenant'
                });
            }

            await client.query('BEGIN');

            await client.query(`
                UPDATE tenants
                SET business_name = $1,
                    updated_at = NOW()
                WHERE id = $2
            `, [businessName, tenantId]);

            console.log(`[Tenant Overwrite] ✅ Tenant actualizado: ${businessName} (ID: ${tenantId})`);

            const passwordHash = await bcrypt.hash(password, 10);

            const ownerNameParts = ownerName.trim().split(/\s+/);
            const ownerFirstName = ownerNameParts[0] || ownerName;
            const ownerLastName = ownerNameParts.length > 1 ? ownerNameParts.slice(1).join(' ') : '';

            await client.query(`
                UPDATE employees
                SET first_name = $1,
                    last_name = $2,
                    password_hash = $3,
                    updated_at = NOW()
                WHERE tenant_id = $4 AND is_owner = true
            `, [ownerFirstName, ownerLastName, passwordHash, tenantId]);

            console.log(`[Tenant Overwrite] ✅ Empleado owner actualizado: ${ownerName}`);

            await client.query('COMMIT');

            res.json({
                success: true,
                message: 'Información del tenant sobrescrita exitosamente',
                tenant: {
                    id: tenantId,
                    businessName: businessName
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');

            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            console.error('[Tenant Overwrite] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al sobrescribir tenant',
                error: error.message
            });
        } finally {
            client.release();
        }
    }

    async fullWipeBranch(req, res) {
        console.log('[Branch Full Wipe] Nueva solicitud de limpieza completa de sucursal');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const branchId = parseInt(req.params.id);

        if (!branchId || isNaN(branchId)) {
            return res.status(400).json({
                success: false,
                message: 'ID de sucursal inválido'
            });
        }

        const client = await this.pool.connect();

        try {
            const decoded = jwt.verify(token, JWT_SECRET);

            await client.query('BEGIN');

            const branchResult = await client.query(
                'SELECT * FROM branches WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [branchId, decoded.tenantId]
            );

            if (branchResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada o no pertenece a tu negocio'
                });
            }

            const branch = branchResult.rows[0];

            const employeeResult = await client.query(
                'SELECT role_id, is_owner FROM employees WHERE id = $1 AND tenant_id = $2',
                [decoded.employeeId, decoded.tenantId]
            );

            if (employeeResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            const employee = employeeResult.rows[0];

            if (!employee.is_owner && employee.role_id !== 1) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Solo el propietario o administrador puede hacer limpieza completa de sucursales'
                });
            }

            console.log(`[Branch Full Wipe] Limpieza completa de branch ${branch.name} (ID: ${branchId})`);

            const devicesResult = await client.query(
                'DELETE FROM devices WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${devicesResult.rowCount} dispositivos eliminados`);

            const sessionsResult = await client.query(
                `DELETE FROM sessions WHERE employee_id IN (
                    SELECT id FROM employees WHERE id IN (
                        SELECT employee_id FROM employee_branches WHERE branch_id = $1
                    )
                )`,
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${sessionsResult.rowCount} sesiones eliminadas`);

            const salesResult = await client.query(
                'DELETE FROM ventas WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${salesResult.rowCount} ventas eliminadas`);

            const expensesResult = await client.query(
                'DELETE FROM expenses WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${expensesResult.rowCount} gastos eliminados`);

            const shiftsResult = await client.query(
                'DELETE FROM shifts WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${shiftsResult.rowCount} shifts eliminados`);

            const eventsResult = await client.query(
                'DELETE FROM guardian_events WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${eventsResult.rowCount} eventos eliminados`);

            const employeeBranchesResult = await client.query(
                'DELETE FROM employee_branches WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${employeeBranchesResult.rowCount} relaciones eliminadas`);

            const employeesMainBranchResult = await client.query(
                'UPDATE employees SET main_branch_id = NULL WHERE main_branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${employeesMainBranchResult.rowCount} empleados actualizados`);

            const backupsResult = await client.query(
                'DELETE FROM backup_metadata WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${backupsResult.rowCount} backups eliminados`);

            await client.query(
                `UPDATE branches SET name = 'Sucursal Reestablecida' WHERE id = $1`,
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK Sucursal reestablecida`);

            await client.query('COMMIT');

            console.log(`[Branch Full Wipe] ✅ Sucursal "${branch.name}" completamente limpiada`);

            res.json({
                success: true,
                message: `La sucursal "${branch.name}" ha sido completamente limpiada. Puedes iniciar desde cero.`,
                branch: {
                    id: branch.id,
                    name: branch.name,
                    branchCode: branch.branch_code
                },
                deletedItems: {
                    devices: devicesResult.rowCount,
                    employeeBranches: employeeBranchesResult.rowCount,
                    backups: backupsResult.rowCount,
                    employeesUpdated: employeesMainBranchResult.rowCount
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');

            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            console.error('[Branch Full Wipe] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al limpiar sucursal',
                error: error.message
            });
        } finally {
            client.release();
        }
    }

    async wipeBranch(req, res) {
        console.log('[Branch Wipe] Nueva solicitud de limpieza de sucursal');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const branchId = parseInt(req.params.id);

        if (!branchId || isNaN(branchId)) {
            return res.status(400).json({
                success: false,
                message: 'ID de sucursal inválido'
            });
        }

        const client = await this.pool.connect();

        try {
            const decoded = jwt.verify(token, JWT_SECRET);

            await client.query('BEGIN');

            const branchResult = await client.query(
                'SELECT * FROM branches WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [branchId, decoded.tenantId]
            );

            if (branchResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada o no pertenece a tu negocio'
                });
            }

            const branch = branchResult.rows[0];

            const employeeResult = await client.query(
                'SELECT role_id, is_owner FROM employees WHERE id = $1 AND tenant_id = $2',
                [decoded.employeeId, decoded.tenantId]
            );

            if (employeeResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            const employee = employeeResult.rows[0];

            if (!employee.is_owner && employee.role_id !== 1 && employee.role_id !== 2) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Solo propietarios, administradores y encargados pueden limpiar sucursales'
                });
            }

            console.log(`[Branch Wipe] Limpiando datos transaccionales de branch ${branch.name} (ID: ${branchId})`);

            const devicesResult = await client.query(
                'UPDATE devices SET is_active = false, updated_at = NOW() WHERE branch_id = $1',
                [branchId]
            );

            console.log(`[Branch Wipe] ✅ ${devicesResult.rowCount} dispositivos desactivados`);

            await client.query('COMMIT');

            console.log(`[Branch Wipe] ✅ Sucursal "${branch.name}" limpiada exitosamente`);

            res.json({
                success: true,
                message: `La sucursal "${branch.name}" ha sido limpiada. Ahora puedes iniciar desde cero.`,
                branch: {
                    id: branch.id,
                    name: branch.name,
                    branchCode: branch.branch_code,
                    devicesDeactivated: devicesResult.rowCount
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');

            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            console.error('[Branch Wipe] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al limpiar sucursal',
                error: error.message
            });
        } finally {
            client.release();
        }
    }

    async checkEmail(req, res) {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email es requerido'
            });
        }

        try {
            const result = await this.pool.query(
                'SELECT id FROM employees WHERE LOWER(email) = LOWER($1)',
                [email]
            );

            res.json({
                success: true,
                exists: result.rows.length > 0
            });
        } catch (error) {
            console.error('[Check Email] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al verificar email',
                error: error.message
            });
        }
    }

    async getBranches(req, res) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const tenantId = decoded.tenantId;

            const branchesResult = await this.pool.query(
                `SELECT id, branch_code, name, address, timezone, created_at
                 FROM branches
                 WHERE tenant_id = $1 AND is_active = true
                 ORDER BY created_at ASC`,
                [tenantId]
            );

            res.json({
                success: true,
                branches: branchesResult.rows
            });

        } catch (error) {
            console.error('[Get Branches] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener sucursales',
                error: error.message
            });
        }
    }

    async createBranch(req, res) {
        console.log('[Create Branch] Nueva solicitud de creación de sucursal');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const { name, address, timezone } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'El nombre de la sucursal es requerido'
            });
        }

        const client = await this.pool.connect();

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const tenantId = decoded.tenantId;

            await client.query('BEGIN');

            const tenantResult = await client.query(`
                SELECT t.id, t.tenant_code, t.business_name,
                       s.name as subscription_name, s.max_branches
                FROM tenants t
                JOIN subscriptions s ON t.subscription_id = s.id
                WHERE t.id = $1 AND t.is_active = true
            `, [tenantId]);

            if (tenantResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];
            const maxBranches = tenant.max_branches || 1;

            const currentBranchesResult = await client.query(
                'SELECT COUNT(*) as count FROM branches WHERE tenant_id = $1 AND is_active = true',
                [tenantId]
            );

            const currentBranchesCount = parseInt(currentBranchesResult.rows[0].count);

            if (currentBranchesCount >= maxBranches) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: `Has alcanzado el límite de ${maxBranches} sucursales para el plan ${tenant.subscription_name}. Actualiza tu suscripción para agregar más sucursales.`
                });
            }

            const branchCode = `B${tenantId}S${currentBranchesCount + 1}`;

            const newBranchResult = await client.query(`
                INSERT INTO branches (tenant_id, branch_code, name, address, timezone)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id, branch_code, name, address, timezone, created_at
            `, [tenantId, branchCode, name, address, timezone || 'America/Mexico_City']);

            const newBranch = newBranchResult.rows[0];

            const ownerResult = await client.query(
                'SELECT id FROM employees WHERE tenant_id = $1 AND is_owner = true',
                [tenantId]
            );

            if (ownerResult.rows.length > 0) {
                const ownerId = ownerResult.rows[0].id;
                await client.query(`
                    INSERT INTO employee_branches (tenant_id, employee_id, branch_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT DO NOTHING
                `, [tenantId, ownerId, newBranch.id]);
            }

            const genericCustomerResult = await client.query(
                'SELECT get_or_create_generic_customer($1, $2) as customer_id',
                [tenantId, newBranch.id]
            );
            console.log(`[Create Branch] Cliente genérico creado/verificado: ${genericCustomerResult.rows[0].customer_id}`);

            await client.query('COMMIT');

            console.log(`[Create Branch] ✅ Sucursal creada: ${newBranch.name} (${newBranch.branch_code})`);

            res.status(201).json({
                success: true,
                message: 'Sucursal creada exitosamente',
                branch: newBranch
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Create Branch] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al crear sucursal',
                error: error.message
            });
        } finally {
            client.release();
        }
    }

    async joinExistingBranch(req, res) {
        console.log('[Join Branch] Solicitud para unirse a sucursal existente');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const { branchId } = req.body;

        if (!branchId) {
            return res.status(400).json({
                success: false,
                message: 'ID de sucursal requerido'
            });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const { employeeId, tenantId } = decoded;

            const branchResult = await this.pool.query(
                'SELECT * FROM branches WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [branchId, tenantId]
            );

            if (branchResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada o no pertenece a tu negocio'
                });
            }

            const branch = branchResult.rows[0];

            await this.pool.query(`
                INSERT INTO employee_branches (tenant_id, employee_id, branch_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (employee_id, branch_id) DO NOTHING
            `, [tenantId, employeeId, branchId]);

            await this.pool.query(
                'UPDATE employees SET main_branch_id = $1 WHERE id = $2',
                [branchId, employeeId]
            );

            const newToken = jwt.sign(
                {
                    employeeId: employeeId,
                    tenantId: tenantId,
                    branchId: branchId,
                    roleId: decoded.roleId,
                    email: decoded.email
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            console.log(`[Join Branch] ✅ Empleado ${employeeId} unido a branch ${branch.name}`);

            res.json({
                success: true,
                message: `Te has unido a la sucursal ${branch.name}`,
                token: newToken,
                branch: {
                    id: branch.id,
                    name: branch.name,
                    branchCode: branch.branch_code
                }
            });

        } catch (error) {
            console.error('[Join Branch] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al unirse a la sucursal',
                error: error.message
            });
        }
    }

    async syncInitAfterWipe(req, res) {
        console.log('[Sync Init] Solicitud de sincronización inicial post-wipe');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const { tenantId, branchId, employeeId } = decoded;

            // ═══════════════════════════════════════════════════════════════
            // OBTENER INFORMACIÓN DEL TENANT (CRÍTICO para licencia)
            // ═══════════════════════════════════════════════════════════════
            const tenantResult = await this.pool.query(
                `SELECT id, tenant_code, business_name
                 FROM tenants
                 WHERE id = $1`,
                [tenantId]
            );

            if (tenantResult.rows.length === 0) {
                console.log(`[Sync Init] ❌ Tenant ${tenantId} no encontrado`);
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];
            console.log(`[Sync Init] ✅ Tenant encontrado: ID=${tenant.id}, Code=${tenant.tenant_code}`);

            // ═══════════════════════════════════════════════════════════════
            // OBTENER INFORMACIÓN DEL EMPLEADO
            // ═══════════════════════════════════════════════════════════════
            const employeeResult = await this.pool.query(
                `SELECT e.id, e.email, e.first_name, e.last_name, e.main_branch_id,
                        r.name as role_name
                 FROM employees e
                 LEFT JOIN roles r ON e.role_id = r.id
                 WHERE e.id = $1 AND e.tenant_id = $2`,
                [employeeId, tenantId]
            );

            let employee = null;
            if (employeeResult.rows.length > 0) {
                const emp = employeeResult.rows[0];
                employee = {
                    id: emp.id,
                    email: emp.email || '',
                    name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
                    role: emp.role_name || 'Empleado',
                    primaryBranchId: emp.main_branch_id || branchId
                };
                console.log(`[Sync Init] ✅ Empleado: ID=${employee.id}, Email=${employee.email}`);
            }

            // ═══════════════════════════════════════════════════════════════
            // OBTENER SUCURSALES DEL TENANT
            // ═══════════════════════════════════════════════════════════════
            const branchesResult = await this.pool.query(
                `SELECT b.id, b.branch_code, b.name, b.timezone, b.address, b.phone, b.is_active,
                        (SELECT COUNT(*) FROM employee_branches eb WHERE eb.branch_id = b.id) as employee_count
                 FROM branches b
                 WHERE b.tenant_id = $1 AND b.is_active = true
                 ORDER BY b.id`,
                [tenantId]
            );

            const branches = branchesResult.rows.map(b => ({
                id: b.id,
                branchCode: b.branch_code,
                name: b.name,
                timezone: b.timezone || 'America/Mexico_City',
                address: b.address || '',
                phone: b.phone || '',
                isActive: b.is_active,
                employeeCount: parseInt(b.employee_count) || 0,
                primary: b.id === branchId // Marcar como primaria si coincide con el branch del token
            }));

            console.log(`[Sync Init] ✅ ${branches.length} sucursales encontradas`);

            // ═══════════════════════════════════════════════════════════════
            // OBTENER DATOS DE PRODUCTOS, CATEGORÍAS Y CLIENTES (legado - opcional)
            // ═══════════════════════════════════════════════════════════════
            let productsResult = { rows: [] };
            let categoriesResult = { rows: [] };
            let customersResult = { rows: [] };

            try {
                productsResult = await this.pool.query(
                    'SELECT * FROM products WHERE tenant_id = $1 AND is_active = true',
                    [tenantId]
                );

                categoriesResult = await this.pool.query(
                    'SELECT * FROM categories WHERE tenant_id = $1 AND is_active = true',
                    [tenantId]
                );

                customersResult = await this.pool.query(
                    'SELECT * FROM customers WHERE tenant_id = $1 AND is_active = true',
                    [tenantId]
                );

                console.log(`[Sync Init] Enviando datos base: ${productsResult.rows.length} productos, ${categoriesResult.rows.length} categorías`);
            } catch (legacyDataError) {
                console.log(`[Sync Init] ⚠️ Tablas legacy no disponibles (ignorando): ${legacyDataError.message}`);
                // Continuar sin datos legacy - no es crítico
            }

            // ═══════════════════════════════════════════════════════════════
            // RESPUESTA CON ESTRUCTURA COMPLETA (para WinUI y app móvil)
            // ═══════════════════════════════════════════════════════════════
            res.json({
                success: true,
                // NUEVO: Información estructurada para sincronización de sesión
                sync: {
                    tenant: {
                        id: tenant.id,
                        code: tenant.tenant_code,  // ⚠️ CRÍTICO: tenant_code para consultar licencia
                        name: tenant.business_name
                    },
                    employee: employee,
                    branches: branches,
                    timestamp: new Date().toISOString()
                },
                // LEGADO: Mantener compatibilidad con clientes anteriores
                data: {
                    products: productsResult.rows,
                    categories: categoriesResult.rows,
                    customers: customersResult.rows
                }
            });

        } catch (error) {
            console.error('[Sync Init] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error en sincronización inicial',
                error: error.message
            });
        }
    }

    async getMainEmployee(req, res) {
        const { tenantId } = req.params;

        try {
            const result = await this.pool.query(
                `SELECT id, first_name, last_name, email, username, global_id
                 FROM employees
                 WHERE tenant_id = $1 AND is_owner = true
                 LIMIT 1`,
                [tenantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No se encontró empleado principal'
                });
            }

            const employee = result.rows[0];

            // ⚠️ CRÍTICO: Generar global_id si no existe (para empleados legacy)
            if (!employee.global_id) {
                const { v4: uuidv4 } = require('uuid');
                const newGlobalId = uuidv4();
                const newTerminalId = 'server-auto-' + Date.now();

                await this.pool.query(
                    `UPDATE employees
                     SET global_id = $1,
                         terminal_id = COALESCE(terminal_id, $2),
                         local_op_seq = COALESCE(local_op_seq, 1),
                         created_local_utc = COALESCE(created_local_utc, $3)
                     WHERE id = $4`,
                    [newGlobalId, newTerminalId, new Date().toISOString(), employee.id]
                );

                employee.global_id = newGlobalId;
                console.log(`[Get Main Employee] 🔑 GlobalId auto-generado para empleado ${employee.id}: ${newGlobalId}`);
            }

            // Si el username está vacío o null, derivarlo del email automáticamente
            if (!employee.username || employee.username.trim() === '') {
                employee.username = employee.email ? employee.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
            }

            // Construir full_name: usar first_name + last_name si existen, sino usar parte del email
            let fullName = '';
            if (employee.first_name && employee.first_name.trim() !== '') {
                fullName = employee.first_name.trim();
                if (employee.last_name && employee.last_name.trim() !== '') {
                    fullName += ' ' + employee.last_name.trim();
                }
            } else if (employee.email) {
                // Si no hay nombre, usar el prefijo del email con la primera letra mayúscula
                const emailPrefix = employee.email.split('@')[0];
                fullName = emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);
            }
            employee.full_name = fullName;

            console.log(`[Get Main Employee] ✅ Empleado retornado:`);
            console.log(`[Get Main Employee]    - ID: ${employee.id}`);
            console.log(`[Get Main Employee]    - GlobalId: ${employee.global_id}`);
            console.log(`[Get Main Employee]    - Username: ${employee.username}`);
            console.log(`[Get Main Employee]    - FullName: ${fullName}`);

            res.json({
                success: true,
                employee: employee
            });
        } catch (error) {
            console.error('[Get Main Employee] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener empleado principal',
                error: error.message
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // VERIFY ADMIN PASSWORD - Para reclamar rol de Equipo Principal
    // Verifica la contraseña del owner/admin del tenant
    // ═══════════════════════════════════════════════════════════════════════════
    async verifyAdminPassword(req, res) {
        console.log('[Verify Admin Password] Nueva solicitud de verificación');

        const { tenantId, password } = req.body;

        if (!tenantId || !password) {
            return res.status(400).json({
                success: false,
                message: 'tenantId y password son requeridos'
            });
        }

        try {
            // Buscar al owner del tenant O cualquier administrador (role_id = 1)
            const employeeResult = await this.pool.query(
                `SELECT id, password_hash, first_name, last_name, is_owner, role_id
                 FROM employees
                 WHERE tenant_id = $1
                   AND is_active = TRUE
                   AND (is_owner = TRUE OR role_id = 1)
                 ORDER BY is_owner DESC, id ASC
                 LIMIT 1`,
                [tenantId]
            );

            if (employeeResult.rows.length === 0) {
                console.log(`[Verify Admin Password] ❌ No se encontró owner/admin para tenant ${tenantId}`);
                return res.status(404).json({
                    success: false,
                    message: 'No se encontró administrador para este negocio'
                });
            }

            const employee = employeeResult.rows[0];

            // Verificar que tenga contraseña configurada
            if (!employee.password_hash) {
                console.log(`[Verify Admin Password] ❌ El administrador no tiene contraseña configurada`);
                return res.status(400).json({
                    success: false,
                    message: 'El administrador no tiene contraseña configurada. Por favor, configura una contraseña primero.'
                });
            }

            // Comparar contraseña con bcrypt
            const isValid = await bcrypt.compare(password, employee.password_hash);

            if (isValid) {
                console.log(`[Verify Admin Password] ✅ Contraseña verificada para tenant ${tenantId}`);
                res.json({
                    success: true,
                    message: 'Contraseña verificada correctamente',
                    admin: {
                        id: employee.id,
                        name: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
                        isOwner: employee.is_owner
                    }
                });
            } else {
                console.log(`[Verify Admin Password] ❌ Contraseña incorrecta para tenant ${tenantId}`);
                res.status(401).json({
                    success: false,
                    message: 'Contraseña incorrecta'
                });
            }

        } catch (error) {
            console.error('[Verify Admin Password] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al verificar contraseña',
                error: error.message
            });
        }
    }

    authenticateToken(req, res, next) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        jwt.verify(token, JWT_SECRET, async (err, user) => {
            if (err) {
                // ✅ 401 para token expirado (la app debe intentar renovar)
                // 403 se reserva para "no tienes permiso" (tenant eliminado, etc.)
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado',
                    code: 'TOKEN_EXPIRED'
                });
            }

            // ✅ FIX: Verificar que el tenant realmente existe en la base de datos
            // Esto previene que usuarios con tokens válidos pero tenants eliminados
            // sigan accediendo a la aplicación
            if (user.tenantId) {
                try {
                    const tenantCheck = await this.pool.query(
                        'SELECT id FROM tenants WHERE id = $1',
                        [user.tenantId]
                    );

                    if (tenantCheck.rows.length === 0) {
                        console.log(`[Auth] ❌ Tenant ${user.tenantId} no existe en la base de datos`);
                        return res.status(403).json({
                            success: false,
                            message: 'Tu cuenta ha sido desactivada o eliminada. Por favor, contacta al administrador.',
                            code: 'TENANT_NOT_FOUND'
                        });
                    }
                } catch (dbError) {
                    console.error('[Auth] Error verificando tenant:', dbError);
                    // En caso de error de BD, dejamos pasar para no bloquear el servicio
                    // pero registramos el error
                }
            }

            req.user = user;
            next();
        });
    }

}

module.exports = AuthController;
