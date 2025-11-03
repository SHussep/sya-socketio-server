// ═══════════════════════════════════════════════════════════════
// RUTAS DE AUTENTICACIÓN - Multi-Tenant System
// ═══════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const archiver = require('archiver');
const { Readable } = require('stream');
const dropboxManager = require('../utils/dropbox-manager');
const { OAuth2Client } = require('google-auth-library');

const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

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

        // idToken es opcional - Desktop autentica con Google pero no siempre envía el token
        if (!email || !displayName || !businessName || !password) {
            return res.status(400).json({
                success: false,
                message: 'Faltan campos requeridos: email, displayName, businessName, password'
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // 1. Verificar si el email ya está registrado en tenants
            const existingTenant = await client.query(
                'SELECT id, tenant_code, business_name FROM tenants WHERE LOWER(email) = LOWER($1)',
                [email]
            );

            if (existingTenant.rows.length > 0) {
                // Email ya existe - obtener sucursales disponibles
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

            // 4. Crear tenant (negocio) - incluir subscription_id
            const tenantResult = await client.query(`
                INSERT INTO tenants (tenant_code, business_name, email, subscription_id)
                VALUES ($1, $2, $3, $4)
                RETURNING id, tenant_code, business_name, email
            `, [tenantCode, businessName, email, subscriptionId]);

            const tenant = tenantResult.rows[0];

            console.log(`[Google Signup] ✅ Tenant creado: ${tenant.tenant_code} (ID: ${tenant.id})`);

            // 4b. Roles are now GLOBAL (not tenant-scoped) with fixed IDs
            // Migration 037 created: 1=Administrador, 2=Encargado, 3=Repartidor, 4=Ayudante, 99=Otro
            // Owner/first signup gets role ID 1 (Administrador)
            console.log(`[Google Signup] 📝 Usando roles globales del sistema...`);
            const accesoTotalRoleId = 1;  // Global role: Administrador
            const accesoRepartidorRoleId = 3;  // Global role: Repartidor
            console.log(`[Google Signup] ✅ Roles globales asignados: Administrador (ID: ${accesoTotalRoleId}), Repartidor (ID: ${accesoRepartidorRoleId})`);

            // 5. Crear branch por defecto (primera sucursal) - solo columnas esenciales
            // Use short code to stay within varchar(20) limit: tenant_id suffixed with -M for main
            const branchCode = `B${tenant.id}M`;
            const branchResult = await client.query(`
                INSERT INTO branches (tenant_id, branch_code, name)
                VALUES ($1, $2, $3)
                RETURNING id, branch_code, name
            `, [tenant.id, branchCode, businessName + ' - Principal']);

            const branch = branchResult.rows[0];

            console.log(`[Google Signup] ✅ Branch creado: ${branch.branch_code} (ID: ${branch.id})`);

            // 6. Hash de contraseña
            const passwordHash = await bcrypt.hash(password, 10);

            // 7. Crear empleado administrador - incluir main_branch_id
            const username = displayName.replace(/\s+/g, '').toLowerCase();
            const employeeResult = await client.query(`
                INSERT INTO employees (
                    tenant_id, email, username, full_name, password_hash,
                    role_id, main_branch_id, is_active, is_owner,
                    google_user_identifier, password_updated_at, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, $8, NOW(), NOW(), NOW())
                RETURNING id, email, username, full_name, role_id, is_active, created_at
            `, [tenant.id, email, username, displayName, passwordHash, accesoTotalRoleId, branch.id, email]);

            const employee = employeeResult.rows[0];

            console.log(`[Google Signup] ✅ Employee creado: ${employee.email} (ID: ${employee.id}, RoleId: ${employee.role_id})`);

            // 8. Asignar empleado a la sucursal (employee-branch many-to-many relationship)
            await client.query(`
                INSERT INTO employee_branches (
                    tenant_id, employee_id, branch_id, is_active
                ) VALUES ($1, $2, $3, true)
            `, [tenant.id, employee.id, branch.id]);

            await client.query('COMMIT');

            // 9. Crear backup inicial (día 0) en Dropbox
            try {
                console.log(`[Google Signup] Creando backup inicial para branch ${branch.id}...`);

                // Crear un ZIP vacío con metadata
                const archive = archiver('zip', { zlib: { level: 9 } });
                const chunks = [];

                archive.on('data', (chunk) => chunks.push(chunk));

                // Agregar un archivo README indicando que es backup inicial
                const readmeContent = `SYA Tortillerías - Backup Inicial

Este es el backup automático creado al registrar la cuenta.
Fecha de creación: ${new Date().toISOString()}
Tenant: ${tenant.business_name} (${tenant.tenant_code})
Branch: ${branch.name} (${branch.branch_code})
Employee: ${employee.full_name} (${employee.email})

Este backup inicial está vacío y se actualizará con el primer respaldo real del sistema.`;

                archive.append(readmeContent, { name: 'README.txt' });
                archive.finalize();

                await new Promise((resolve) => archive.on('end', resolve));

                const backupBuffer = Buffer.concat(chunks);
                const filename = `SYA_Backup_Branch_${branch.id}.zip`;
                const dropboxPath = `/SYA Backups/${tenant.id}/${branch.id}/${filename}`;

                // Crear carpeta en Dropbox (auto-refresca el token si es necesario)
                await dropboxManager.createFolder(`/SYA Backups/${tenant.id}/${branch.id}`);

                // Subir a Dropbox usando el manager (auto-refresca el token si es necesario)
                await dropboxManager.uploadFile(dropboxPath, backupBuffer, true);

                // Registrar metadata en la BD
                await pool.query(
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
                // No fallar el registro si el backup falla
                console.error(`[Google Signup] ⚠️ Error al crear backup inicial:`, backupError.message);
            }

            // 10. Generar JWT token
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
                    businessName: tenant.business_name
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
            console.error('[Google Signup] Error code:', error.code);

            // Si es error de email duplicado (código 23505 de PostgreSQL), retornar branches
            if (error.code === '23505') {
                try {
                    console.log('[Google Signup] Error 23505 detectado - verificando email existente');
                    const existingTenant = await pool.query(
                        'SELECT id, tenant_code, business_name FROM tenants WHERE LOWER(email) = LOWER($1)',
                        [req.body.email]
                    );

                    if (existingTenant.rows.length > 0) {
                        const tenantId = existingTenant.rows[0].id;
                        const branchesResult = await pool.query(
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
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/auth/google-login
    // Verificar Google ID Token y retornar info de cuenta (SIN registrar dispositivo)
    // ─────────────────────────────────────────────────────────
    router.post('/google-login', async (req, res) => {
        console.log('[Google Login] Nueva solicitud de verificación con Google ID Token');

        const { idToken } = req.body;

        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: 'idToken es requerido'
            });
        }

        try {
            // 1. Verificar Google ID Token
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

            // 2. Buscar empleado por email
            const employeeResult = await pool.query(
                'SELECT * FROM employees WHERE LOWER(email) = LOWER($1) AND is_active = true',
                [email]
            );

            // 3. Si el email NO EXISTE, retornar info básica
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

            // 4. Email EXISTE - Obtener tenant con subscription
            const tenantResult = await pool.query(
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

            // 5. Obtener todas las sucursales del tenant
            const branchesResult = await pool.query(`
                SELECT b.id, b.branch_code, b.name, b.address, b.timezone
                FROM branches b
                WHERE b.tenant_id = $1 AND b.is_active = true
                ORDER BY b.created_at ASC
            `, [employee.tenant_id]);

            const branches = branchesResult.rows;

            // 6. Generar JWT token (access + refresh) - SIN deviceId
            const accessToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    role: employee.role,
                    email: employee.email
                },
                JWT_SECRET,
                { expiresIn: '7d' } // Token de acceso de 7 días
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
                    fullName: employee.full_name,
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
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/devices/register
    // Registrar dispositivo en una sucursal con validación de límites
    // ─────────────────────────────────────────────────────────
    router.post('/devices/register', async (req, res) => {
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

        const client = await pool.connect();

        try {
            // Verificar token
            const decoded = jwt.verify(token, JWT_SECRET);

            // Verificar que el token pertenece al tenant correcto
            if (decoded.tenantId !== tenantId || decoded.employeeId !== employeeId) {
                return res.status(403).json({
                    success: false,
                    message: 'No autorizado para registrar dispositivos en este tenant'
                });
            }

            await client.query('BEGIN');

            // 1. Obtener tenant con subscription y límites
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

            // 2. Verificar que la sucursal existe y pertenece al tenant
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

            // 3. Verificar si el dispositivo ya existe
            const existingDeviceResult = await client.query(
                'SELECT * FROM devices WHERE device_id = $1 AND tenant_id = $2',
                [deviceId, tenantId]
            );

            if (existingDeviceResult.rows.length > 0) {
                const existingDevice = existingDeviceResult.rows[0];

                // Si el dispositivo ya está registrado en el MISMO branch y está activo
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

                // Si el dispositivo está en OTRO branch, desactivarlo allí
                if (existingDevice.branch_id !== branchId) {
                    console.log(`[Device Register] Dispositivo se moverá de branch ${existingDevice.branch_id} a ${branchId}`);

                    // Contar dispositivos activos en el nuevo branch (excluyendo el que vamos a mover)
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

                    // Actualizar: cambiar a nuevo branch y reactivar
                    await client.query(
                        `UPDATE devices
                         SET branch_id = $1, employee_id = $2, device_name = $3,
                             device_type = $4, is_active = true, last_seen = NOW(), updated_at = NOW()
                         WHERE device_id = $5 AND tenant_id = $6`,
                        [branchId, employeeId, deviceName || existingDevice.device_name, deviceType || existingDevice.device_type, deviceId, tenantId]
                    );
                }

                // Si el dispositivo está en el mismo branch pero inactivo, reactivarlo
                if (existingDevice.branch_id === branchId && !existingDevice.is_active) {
                    // Contar dispositivos activos en el branch
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

                    // Reactivar dispositivo
                    await client.query(
                        `UPDATE devices
                         SET is_active = true, employee_id = $1, device_name = $2,
                             device_type = $3, last_seen = NOW(), updated_at = NOW()
                         WHERE device_id = $4 AND tenant_id = $5`,
                        [employeeId, deviceName || existingDevice.device_name, deviceType || existingDevice.device_type, deviceId, tenantId]
                    );
                }

                await client.query('COMMIT');

                // Obtener dispositivo actualizado
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

            // 4. Si el dispositivo NO existe, validar límite y crear uno nuevo
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

            // Crear nuevo dispositivo
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

            console.error('[Device Register] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al registrar dispositivo',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // ─────────────────────────────────────────────────────────
    // PUT /api/tenants/:id/overwrite
    // Sobrescribir información de tenant existente con nuevos datos
    // ─────────────────────────────────────────────────────────
    router.put('/tenants/:id/overwrite', async (req, res) => {
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

        const client = await pool.connect();

        try {
            // Verificar token
            const decoded = jwt.verify(token, JWT_SECRET);

            // Verificar que el token pertenece al tenant correcto
            if (decoded.tenantId !== tenantId) {
                return res.status(403).json({
                    success: false,
                    message: 'No autorizado para modificar este tenant'
                });
            }

            await client.query('BEGIN');

            // 1. Actualizar información del tenant (solo business_name - phone y address no existen en tenants)
            await client.query(`
                UPDATE tenants
                SET business_name = $1,
                    updated_at = NOW()
                WHERE id = $2
            `, [businessName, tenantId]);

            console.log(`[Tenant Overwrite] ✅ Tenant actualizado: ${businessName} (ID: ${tenantId})`);

            // 2. Actualizar información del empleado owner
            const passwordHash = await bcrypt.hash(password, 10);

            await client.query(`
                UPDATE employees
                SET full_name = $1,
                    password = $2,
                    updated_at = NOW()
                WHERE tenant_id = $3 AND role = 'owner'
            `, [ownerName, passwordHash, tenantId]);

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
    });

    // ─────────────────────────────────────────────────────────
    // DELETE /api/branches/:id/full-wipe
    // Eliminar TODOS los datos de una sucursal (empleados, dispositivos, etc.)
    // MÁS AGRESIVO que /wipe - Solo mantiene el branch vacío
    // ─────────────────────────────────────────────────────────
    router.delete('/branches/:id/full-wipe', async (req, res) => {
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

        const client = await pool.connect();

        try {
            // Verificar token
            const decoded = jwt.verify(token, JWT_SECRET);

            await client.query('BEGIN');

            // 1. Verificar que la sucursal existe y pertenece al tenant del usuario
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

            // 2. Verificar permisos (solo owner puede hacer full-wipe)
            const employeeResult = await client.query(
                'SELECT role FROM employees WHERE id = $1 AND tenant_id = $2',
                [decoded.employeeId, decoded.tenantId]
            );

            if (employeeResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            const userRole = employeeResult.rows[0].role;

            if (userRole !== 'owner') {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Solo el propietario puede hacer limpieza completa de sucursales'
                });
            }

            console.log(`[Branch Full Wipe] Limpieza completa de branch ${branch.name} (ID: ${branchId})`);

            // 3. ELIMINAR TODOS LOS DATOS relacionados al branch (FULL WIPE COMPLETO)

            // 3.1. Eliminar dispositivos
            const devicesResult = await client.query(
                'DELETE FROM devices WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${devicesResult.rowCount} dispositivos eliminados`);

            // 3.2. Eliminar sesiones
            const sessionsResult = await client.query(
                `DELETE FROM sessions WHERE employee_id IN (
                    SELECT id FROM employees WHERE id IN (
                        SELECT employee_id FROM employee_branches WHERE branch_id = $1
                    )
                )`,
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${sessionsResult.rowCount} sesiones eliminadas`);

            // 3.3. Eliminar ventas
            const salesResult = await client.query(
                'DELETE FROM sales WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${salesResult.rowCount} ventas eliminadas`);

            // 3.4. Eliminar gastos
            const expensesResult = await client.query(
                'DELETE FROM expenses WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${expensesResult.rowCount} gastos eliminados`);

            // 3.5. Eliminar shifts
            const shiftsResult = await client.query(
                'DELETE FROM shifts WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${shiftsResult.rowCount} shifts eliminados`);

            // 3.6. Eliminar eventos
            const eventsResult = await client.query(
                'DELETE FROM guardian_events WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${eventsResult.rowCount} eventos eliminados`);

            // 3.7. Eliminar relaciones employee_branches
            const employeeBranchesResult = await client.query(
                'DELETE FROM employee_branches WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${employeeBranchesResult.rowCount} relaciones eliminadas`);

            // 3.8. Actualizar empleados
            const employeesMainBranchResult = await client.query(
                'UPDATE employees SET main_branch_id = NULL WHERE main_branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${employeesMainBranchResult.rowCount} empleados actualizados`);

            // 3.9. Eliminar backups
            const backupsResult = await client.query(
                'DELETE FROM backup_metadata WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${backupsResult.rowCount} backups eliminados`);

            // 3.10. Resetear nombre de sucursal
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
    });

    // ─────────────────────────────────────────────────────────
    // DELETE /api/branches/:id/wipe
    // Limpiar datos transaccionales de una sucursal (iniciar desde cero)
    // ─────────────────────────────────────────────────────────
    router.delete('/branches/:id/wipe', async (req, res) => {
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

        const client = await pool.connect();

        try {
            // Verificar token
            const decoded = jwt.verify(token, JWT_SECRET);

            await client.query('BEGIN');

            // 1. Verificar que la sucursal existe y pertenece al tenant del usuario
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

            // 2. Verificar permisos (solo owner o admin pueden limpiar sucursales)
            const employeeResult = await client.query(
                'SELECT role FROM employees WHERE id = $1 AND tenant_id = $2',
                [decoded.employeeId, decoded.tenantId]
            );

            if (employeeResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            const userRole = employeeResult.rows[0].role;

            if (userRole !== 'owner' && userRole !== 'admin') {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Solo propietarios y administradores pueden limpiar sucursales'
                });
            }

            // 3. Limpiar datos transaccionales de la sucursal
            // NOTA: NO eliminamos el branch, tenant, ni employees, solo datos operacionales

            console.log(`[Branch Wipe] Limpiando datos transaccionales de branch ${branch.name} (ID: ${branchId})`);

            // Desactivar todos los dispositivos del branch (NO eliminar)
            const devicesResult = await client.query(
                'UPDATE devices SET is_active = false, updated_at = NOW() WHERE branch_id = $1',
                [branchId]
            );

            console.log(`[Branch Wipe] ✅ ${devicesResult.rowCount} dispositivos desactivados`);

            // Aquí se pueden agregar más limpiezas según las tablas que tengas
            // Por ejemplo: shifts, sales, expenses, inventory_movements, etc.
            // NOTA: Para este momento solo desactivamos dispositivos ya que los datos
            // transaccionales están en la BD local SQLite, no en PostgreSQL

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
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/auth/check-email
    // Verificar si un email ya está registrado (SIN registrar)
    // ─────────────────────────────────────────────────────────
    router.post('/check-email', async (req, res) => {
        try {
            const { email } = req.body;

            console.log('[Check Email] Request:', { email });

            if (!email) {
                return res.status(400).json({
                    success: false,
                    message: 'Email es requerido'
                });
            }

            // Verificar si el email existe
            const existing = await pool.query(
                'SELECT id, tenant_code, business_name FROM tenants WHERE LOWER(email) = LOWER($1)',
                [email]
            );

            if (existing.rows.length > 0) {
                // Email existe - obtener sucursales disponibles
                const tenantId = existing.rows[0].id;
                const branchesResult = await pool.query(
                    `SELECT id, branch_code, name, timezone
                     FROM branches
                     WHERE tenant_id = $1
                     ORDER BY created_at ASC`,
                    [tenantId]
                );

                console.log(`[Check Email] Email existe. Tenant: ${existing.rows[0].business_name}, Sucursales: ${branchesResult.rows.length}`);

                return res.status(200).json({
                    success: true,
                    emailExists: true,
                    tenant: {
                        id: existing.rows[0].id,
                        tenantCode: existing.rows[0].tenant_code,
                        businessName: existing.rows[0].business_name
                    },
                    branches: branchesResult.rows.map(b => ({
                        id: b.id,
                        branchCode: b.branch_code,
                        name: b.name,
                        timezone: b.timezone || 'America/Mexico_City'
                    }))
                });
            } else {
                // Email no existe
                console.log(`[Check Email] Email disponible: ${email}`);
                return res.json({
                    success: true,
                    emailExists: false,
                    message: 'Email disponible'
                });
            }
        } catch (error) {
            console.error('[Check Email] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al verificar email',
                error: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/auth/branches
    // Obtener lista de sucursales del tenant autenticado
    // ─────────────────────────────────────────────────────────
    router.get('/branches', async (req, res) => {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        try {
            // Verificar token
            const decoded = jwt.verify(token, JWT_SECRET);

            // Obtener sucursales del tenant con información de backup
            const branchesResult = await pool.query(`
                SELECT
                    b.id,
                    b.branch_code,
                    b.name,
                    b.address,
                    b.timezone,
                    b.is_active,
                    b.created_at,
                    COUNT(DISTINCT eb.employee_id) as employee_count,
                    MAX(bm.id) as backup_id,
                    MAX(bm.backup_filename) as backup_filename,
                    MAX(bm.file_size_bytes) as backup_size_bytes,
                    MAX(bm.created_at) as last_backup_date,
                    MAX(bm.backup_path) as backup_path
                FROM branches b
                LEFT JOIN employee_branches eb ON b.id = eb.branch_id
                LEFT JOIN backup_metadata bm ON b.id = bm.branch_id AND b.tenant_id = bm.tenant_id
                WHERE b.tenant_id = $1 AND b.is_active = true
                GROUP BY b.id
                ORDER BY b.created_at ASC
            `, [decoded.tenantId]);

            console.log(`[Get Branches] ✅ ${branchesResult.rows.length} sucursales encontradas para tenant ${decoded.tenantId}`);

            res.json({
                success: true,
                branches: branchesResult.rows.map(b => ({
                    id: b.id,
                    name: b.name,
                    address: b.address,
                    branchCode: b.branch_code,
                    timezone: b.timezone,
                    employeeCount: parseInt(b.employee_count),
                    hasBackup: b.backup_id !== null,
                    backup: b.backup_id ? {
                        id: b.backup_id,
                        filename: b.backup_filename,
                        sizeBytes: parseInt(b.backup_size_bytes),
                        sizeMB: (parseInt(b.backup_size_bytes) / 1024 / 1024).toFixed(2),
                        createdAt: b.last_backup_date,
                        path: b.backup_path
                    } : null,
                    createdAt: b.created_at
                }))
            });

        } catch (error) {
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            console.error('[Get Branches] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener sucursales',
                error: error.message
            });
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/auth/create-branch
    // Crear nueva sucursal para tenant existente
    // ─────────────────────────────────────────────────────────
    router.post('/create-branch', async (req, res) => {
        console.log('[Create Branch] Nueva solicitud de creación de sucursal');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const { tenantId, branchName, address, phone, email, rfc, timezone } = req.body;

        if (!tenantId || !branchName) {
            return res.status(400).json({
                success: false,
                message: 'tenantId y branchName son requeridos'
            });
        }

        // Timezone es ahora opcional - usa default si no se proporciona
        // La app móvil detecta automáticamente la zona horaria del dispositivo
        const finalTimezone = timezone || 'UTC';

        const client = await pool.connect();

        try {
            // Verificar token
            const decoded = jwt.verify(token, JWT_SECRET);

            // Verificar que el token pertenece al tenant correcto
            if (decoded.tenantId !== tenantId) {
                return res.status(403).json({
                    success: false,
                    message: 'No autorizado para crear sucursales en este tenant'
                });
            }

            await client.query('BEGIN');

            // Obtener tenant con su suscripción
            const tenantResult = await client.query(`
                SELECT t.*, s.name as subscription_plan, s.max_branches
                FROM tenants t
                JOIN subscriptions s ON t.subscription_id = s.id
                WHERE t.id = $1
            `, [tenantId]);

            if (tenantResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];

            // Contar sucursales activas actuales
            const branchCountResult = await client.query(
                'SELECT COUNT(*) as count FROM branches WHERE tenant_id = $1 AND is_active = true',
                [tenantId]
            );

            const currentBranchCount = parseInt(branchCountResult.rows[0].count);
            const maxBranches = tenant.max_branches || 3; // Default: 3 para Basic

            // Validar límite de sucursales
            if (currentBranchCount >= maxBranches) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: `Has alcanzado el límite de ${maxBranches} sucursales para tu plan ${tenant.subscription_plan}. Actualiza tu suscripción para agregar más.`
                });
            }

            // Generar branch code único
            const branchCode = `${tenant.tenant_code}-BR${currentBranchCount + 1}`;

            // Crear nueva sucursal
            const branchResult = await client.query(`
                INSERT INTO branches (
                    tenant_id, branch_code, name, address, timezone,
                    is_active, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
                RETURNING id, branch_code, name, address, timezone
            `, [
                tenantId,
                branchCode,
                branchName,
                address || null,
                finalTimezone
            ]);

            const newBranch = branchResult.rows[0];

            // ⭐ NUEVO: Asignar automáticamente el owner (empleado actual) a la nueva sucursal
            // Esto vincula al dueño/owner con la rama que acaba de crear
            await client.query(`
                INSERT INTO employee_branches (
                    tenant_id, employee_id, branch_id, is_active, assigned_at, synced
                ) VALUES ($1, $2, $3, true, NOW(), false)
            `, [tenantId, decoded.employeeId, newBranch.id]);

            console.log(`[Create Branch] ✅ EmployeeBranch creado automáticamente: Empleado ${decoded.employeeId} → Sucursal ${newBranch.id}`);

            await client.query('COMMIT');

            console.log(`[Create Branch] ✅ Sucursal creada: ${newBranch.name} (ID: ${newBranch.id}, Code: ${newBranch.branch_code})`);

            res.status(201).json({
                success: true,
                message: 'Sucursal creada exitosamente',
                branch: {
                    id: newBranch.id,
                    name: newBranch.name,
                    branchCode: newBranch.branch_code,
                    address: newBranch.address,
                    timezone: newBranch.timezone
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

            console.error('[Create Branch] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al crear sucursal',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/auth/join-existing-branch
    // Unirse a sucursal existente y desactivar dispositivo anterior
    // ─────────────────────────────────────────────────────────
    router.post('/join-existing-branch', async (req, res) => {
        console.log('[Join Existing Branch] Nueva solicitud');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const { branchId, deviceId } = req.body;

        if (!branchId || !deviceId) {
            return res.status(400).json({
                success: false,
                message: 'branchId y deviceId son requeridos'
            });
        }

        const client = await pool.connect();

        try {
            // Verificar token
            const decoded = jwt.verify(token, JWT_SECRET);

            await client.query('BEGIN');

            // Verificar que la sucursal existe y pertenece al tenant
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

            // Verificar si el empleado ya tiene permisos en esta sucursal
            const permissionResult = await client.query(
                'SELECT * FROM employee_branches WHERE employee_id = $1 AND branch_id = $2',
                [decoded.employeeId, branchId]
            );

            // Si no tiene permisos, crearlos (owner tiene acceso a todas sus sucursales)
            if (permissionResult.rows.length === 0) {
                console.log(`[Join Existing Branch] Creando permisos para empleado ${decoded.employeeId} en sucursal ${branch.name}`);

                await client.query(`
                    INSERT INTO employee_branches (
                        employee_id, branch_id, can_login, can_sell,
                        can_manage_inventory, can_close_shift, assigned_at
                    ) VALUES ($1, $2, true, true, true, true, NOW())
                `, [decoded.employeeId, branchId]);
            }

            // TODO: Implementar tabla 'devices' para rastrear dispositivos
            // Por ahora, solo registramos el evento en logs
            console.log(`[Join Existing Branch] Dispositivo ${deviceId} se unió a sucursal ${branch.name}`);
            console.log(`[Join Existing Branch] ⚠️ Funcionalidad de desactivación de dispositivos pendiente de implementar`);

            // Actualizar main_branch_id del empleado
            await client.query(
                'UPDATE employees SET main_branch_id = $1 WHERE id = $2',
                [branchId, decoded.employeeId]
            );

            await client.query('COMMIT');

            console.log(`[Join Existing Branch] ✅ Empleado ${decoded.employeeId} asignado a sucursal ${branch.name}`);

            res.json({
                success: true,
                message: `Te has unido exitosamente a ${branch.name}`,
                branch: {
                    id: branch.id,
                    name: branch.name,
                    branchCode: branch.branch_code,
                    address: branch.address
                },
                warning: 'La desactivación automática de dispositivos anteriores estará disponible próximamente'
            });

        } catch (error) {
            await client.query('ROLLBACK');

            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            console.error('[Join Existing Branch] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al unirse a la sucursal',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // ─────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────
    // POST /api/auth/sync-init-after-wipe
    // Obtiene info de sincronización después del full wipe
    // Preparado para múltiples sucursales
    // ─────────────────────────────────────────────────────────
    router.post('/sync-init-after-wipe', async (req, res) => {
        const { accessToken } = req.body;

        if (!accessToken) {
            return res.status(400).json({
                success: false,
                message: 'Access token requerido'
            });
        }

        const client = await pool.connect();

        try {
            let decoded;
            try {
                decoded = jwt.verify(accessToken, JWT_SECRET);
            } catch (err) {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            const { tenantId, employeeId } = decoded;

            console.log(`[Sync Init] Inicializando para tenant ${tenantId}, employee ${employeeId}`);

            // 1. Obtener info del tenant
            const tenantResult = await client.query(
                'SELECT id, tenant_code, business_name FROM tenants WHERE id = $1',
                [tenantId]
            );

            if (tenantResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];

            // 2. Obtener info del empleado
            const employeeResult = await client.query(
                `SELECT id, email, full_name, role, main_branch_id
                 FROM employees WHERE id = $1 AND tenant_id = $2`,
                [employeeId, tenantId]
            );

            if (employeeResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Empleado no encontrado'
                });
            }

            const employee = employeeResult.rows[0];

            // 3. Obtener todas las sucursales (PREPARADO PARA MULTISUCURSAL)
            const branchesResult = await client.query(
                `SELECT id, branch_code, name, timezone, is_active,
                        COALESCE(address, '') as address, COALESCE(phone, '') as phone
                 FROM branches WHERE tenant_id = $1 ORDER BY id ASC`,
                [tenantId]
            );

            const branches = branchesResult.rows;

            // 4. Obtener contador de empleados por sucursal
            const employeeCountResult = await client.query(
                `SELECT branch_id, COUNT(*) as employee_count
                 FROM employee_branches
                 WHERE branch_id IN (SELECT id FROM branches WHERE tenant_id = $1)
                 GROUP BY branch_id`,
                [tenantId]
            );

            const employeeCountByBranch = {};
            employeeCountResult.rows.forEach(row => {
                employeeCountByBranch[row.branch_id] = row.employee_count;
            });

            // Agregar metadata a sucursales
            const branchesWithMetadata = branches.map(branch => ({
                ...branch,
                employee_count: employeeCountByBranch[branch.id] || 0,
                primary: branch.id === employee.main_branch_id
            }));

            console.log(`[Sync Init] OK - ${branches.length} sucursales`);

            res.json({
                success: true,
                sync: {
                    tenant: {
                        id: tenant.id,
                        code: tenant.tenant_code,
                        name: tenant.business_name
                    },
                    employee: {
                        id: employee.id,
                        email: employee.email,
                        name: employee.full_name,
                        role: employee.role,
                        primary_branch_id: employee.main_branch_id
                    },
                    branches: branchesWithMetadata,
                    timestamp: new Date().toISOString()
                }
            });

        } catch (error) {
            console.error('[Sync Init] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error obteniendo información',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/auth/tenant/:tenantId/main-employee
    // Obtiene el empleado principal (admin) del tenant para reusarlo en nuevas sucursales
    // ─────────────────────────────────────────────────────────
    router.get('/tenant/:tenantId/main-employee', async (req, res) => {
        const { tenantId } = req.params;
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        try {
            // Verificar token
            let decoded;
            try {
                decoded = jwt.verify(token, JWT_SECRET);
            } catch (err) {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            console.log(`[Main Employee] Obteniendo empleado principal del tenant ${tenantId}`);

            // Obtener el empleado principal/admin del tenant (el que tiene is_owner = true)
            const employeeResult = await pool.query(
                `SELECT id, username, email, full_name, role
                 FROM employees
                 WHERE tenant_id = $1 AND is_active = true AND role = 'owner'
                 LIMIT 1`,
                [tenantId]
            );

            if (employeeResult.rows.length === 0) {
                console.log(`[Main Employee] No se encontró empleado owner para tenant ${tenantId}`);

                // Si no hay owner, obtener el empleado más antiguo (primer registrado)
                const fallbackResult = await pool.query(
                    `SELECT id, username, email, full_name, role
                     FROM employees
                     WHERE tenant_id = $1 AND is_active = true
                     ORDER BY created_at ASC
                     LIMIT 1`,
                    [tenantId]
                );

                if (fallbackResult.rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: 'No hay empleados activos en este tenant'
                    });
                }

                const employee = fallbackResult.rows[0];
                console.log(`[Main Employee] ✅ Empleado (fallback) encontrado: ${employee.email} (ID: ${employee.id})`);

                return res.json({
                    success: true,
                    employee: {
                        id: employee.id,
                        username: employee.username,
                        email: employee.email,
                        fullName: employee.full_name,
                        role: employee.role
                    }
                });
            }

            const employee = employeeResult.rows[0];
            console.log(`[Main Employee] ✅ Empleado owner encontrado: ${employee.email} (ID: ${employee.id})`);

            res.json({
                success: true,
                employee: {
                    id: employee.id,
                    username: employee.username,
                    email: employee.email,
                    fullName: employee.full_name,
                    role: employee.role
                }
            });

        } catch (error) {
            console.error(`[Main Employee] Error: ${error.message}`);
            res.status(500).json({
                success: false,
                message: 'Error obteniendo empleado principal',
                error: error.message
            });
        }
    });


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
