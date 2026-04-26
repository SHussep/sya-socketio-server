// Signup Methods (refreshToken, googleSignup, googleLogin, registerDevice)

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const archiver = require('archiver');
const { OAuth2Client } = require('google-auth-library');
const { BCRYPT_ROUNDS } = require('../../config/security');
const { notifySuperadmins } = require('../../utils/superadminNotifier');
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const maskEmail = (email) => {
    if (!email) return 'unknown';
    return email.replace(/^(.)(.*)(@.*)$/, '$1***$3');
};

module.exports = {
    async refreshToken(req, res) {
        const { refreshToken, branch_id } = req.body;

        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token requerido'
            });
        }

        try {
            const decoded = jwt.verify(refreshToken, JWT_SECRET, { algorithms: ['HS256'] });

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

            // Determine branchId: use override if owner, else use main_branch_id
            let branchId = employee.main_branch_id;
            if (branch_id && employee.is_owner === true) {
                // Verify the branch belongs to the same tenant
                const branchCheck = await this.pool.query(
                    'SELECT id FROM branches WHERE id = $1 AND tenant_id = $2',
                    [parseInt(branch_id), employee.tenant_id]
                );
                if (branchCheck.rows.length > 0) {
                    branchId = parseInt(branch_id);
                    console.log(`[Refresh Token] 🏪 Owner branch override: ${branchId} (kiosk mode)`);
                }
            }

            if (!branchId) {
                const branchResult = await this.pool.query(
                    'SELECT id FROM branches WHERE tenant_id = $1 ORDER BY id LIMIT 1',
                    [employee.tenant_id]
                );
                if (branchResult.rows.length > 0) {
                    branchId = branchResult.rows[0].id;
                    await this.pool.query(
                        'UPDATE employees SET main_branch_id = $1 WHERE id = $2',
                        [branchId, employee.id]
                    );
                    console.log(`[Refresh Token] 🔧 Auto-asignó main_branch_id=${branchId} a empleado ${employee.email}`);
                } else {
                    return res.status(400).json({
                        success: false,
                        message: 'No hay sucursales disponibles para este empleado'
                    });
                }
            }

            // New access token
            const newToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: branchId,
                    roleId: employee.role_id,
                    email: employee.email,
                    is_owner: employee.is_owner === true
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            // Rolling refresh token — issue new one with fresh 30d expiry
            const newRefreshToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    is_owner: employee.is_owner === true
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            console.log(`[Refresh Token] ✅ Token renovado para: ${employee.email} (branch=${branchId}, rolling=true)`);

            res.json({
                success: true,
                token: newToken,             // MUST keep 'token' — existing Flutter reads data['token']
                accessToken: newToken,       // New field for kiosk clients
                refreshToken: newRefreshToken,
                expiresIn: 900
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
                message: 'Error interno del servidor'
            });
        }
    },

    async googleSignup(req, res) {
        console.log('[Google Signup] Nueva solicitud de registro con Google');

        const { idToken, email, displayName, businessName, phoneNumber, address, password, rfc } = req.body;

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
                INSERT INTO branches (tenant_id, branch_code, name, address, phone, rfc)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id, branch_code, name
            `, [tenant.id, branchCode, businessName + ' - Principal', address || null, phoneNumber || null, rfc || null]);

            const branch = branchResult.rows[0];

            console.log(`[Google Signup] ✅ Branch creado: ${branch.branch_code} (ID: ${branch.id})`);

            // ✅ SECURITY: Password validation
            if (!password || password.length < 6) {
                return res.status(400).json({
                    success: false,
                    message: 'La contraseña debe tener al menos 6 caracteres'
                });
            }

            const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
            const username = displayName.replace(/\s+/g, '').toLowerCase();

            const nameParts = displayName.trim().split(/\s+/);
            const firstName = nameParts[0] || displayName;
            const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

            const employeeResult = await client.query(`
                INSERT INTO employees (
                    tenant_id, email, username, first_name, last_name, password_hash,
                    role_id, main_branch_id, can_use_mobile_app, is_active, is_owner,
                    mobile_access_type, mobile_access_types,
                    google_user_identifier, global_id, password_updated_at, email_verified, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true, true, 'admin', 'admin', $9, gen_random_uuid()::text, NOW(), true, NOW(), NOW())
                RETURNING id, email, username, first_name, last_name, role_id, can_use_mobile_app, is_active, global_id, created_at
            `, [tenant.id, email, username, firstName, lastName, passwordHash, accesoTotalRoleId, branch.id, email]);

            const employee = employeeResult.rows[0];

            console.log(`[Google Signup] ✅ Employee creado: ${employee.email} (ID: ${employee.id}, RoleId: ${employee.role_id})`);

            const employeeBranchResult = await client.query(`
                INSERT INTO employee_branches (
                    tenant_id, employee_id, branch_id, global_id
                ) VALUES ($1, $2, $3, gen_random_uuid())
                RETURNING id, global_id
            `, [tenant.id, employee.id, branch.id]);
            const employeeBranch = employeeBranchResult.rows[0];
            console.log(`[Google Signup] ✅ EmployeeBranch creado: ID=${employeeBranch.id}, GlobalId=${employeeBranch.global_id}`);

            const genericCustomerResult = await client.query(
                'SELECT get_or_create_generic_customer($1, $2) as customer_id',
                [tenant.id, branch.id]
            );
            const genericCustomerId = genericCustomerResult.rows[0].customer_id;
            console.log(`[Google Signup] ✅ Cliente genérico creado: ID ${genericCustomerId}`);

            // Crear licencia inicial para la sucursal principal con expires_at del trial.
            // CRÍTICO: sin expires_at la licencia se ve como "perpetua" pero
            // granted_by='system' la marca como trial → el desktop la trata como
            // expirada (días=0 + sin fecha = "Tu licencia expiró el N/A").
            await client.query(`
                INSERT INTO branch_licenses (tenant_id, branch_id, status, granted_by, expires_at, duration_days, activated_at, assigned_at, notes)
                VALUES ($1, $2, 'active', 'system', $3, 30, NOW(), NOW(), 'Licencia inicial - trial 30 días')
            `, [tenant.id, branch.id, tenant.trial_ends_at]);
            console.log(`[Google Signup] ✅ Licencia de sucursal creada para branch ${branch.id} (expira ${tenant.trial_ends_at})`);

            // ===== Seed supplier "Productos propios" =====
            const supplierGlobalId = `SEED_SUPPLIER_PRODUCTOS_PROPIOS_${tenant.id}`;
            const supplierResult = await client.query(`
                INSERT INTO suppliers (tenant_id, name, contact_person, phone_number, global_id, is_active, created_at, updated_at)
                VALUES ($1, 'Productos propios', 'N/A', 'N/A', $2, true, NOW(), NOW())
                RETURNING id
            `, [tenant.id, supplierGlobalId]);
            const defaultSupplierId = supplierResult.rows[0].id;
            console.log(`[Google Signup] ✅ Proveedor 'Productos propios' creado (ID: ${defaultSupplierId})`);

            // ===== Seed product categories (6 categorías canónicas) =====
            const seedCategories = [
                { nombre: 'Derivados de maíz', globalId: `SEED_CAT_${tenant.id}_1` },
                { nombre: 'Materias Primas', globalId: `SEED_CAT_${tenant.id}_2` },
                { nombre: 'Complementarios', globalId: `SEED_CAT_${tenant.id}_3` },
                { nombre: 'Bebidas', globalId: `SEED_CAT_${tenant.id}_4` },
                { nombre: 'Antojitos', globalId: `SEED_CAT_${tenant.id}_5` },
                { nombre: 'Salsas', globalId: `SEED_CAT_${tenant.id}_6` },
            ];
            const categoryIdMap = {};
            const categoryGlobalIdMap = {};
            for (const cat of seedCategories) {
                const catResult = await client.query(`
                    INSERT INTO categorias_productos (tenant_id, nombre, is_available, is_system_category, global_id, created_at, updated_at)
                    VALUES ($1, $2, true, true, $3, NOW(), NOW())
                    RETURNING id
                `, [tenant.id, cat.nombre, cat.globalId]);
                categoryIdMap[cat.nombre] = catResult.rows[0].id;
                categoryGlobalIdMap[cat.nombre] = cat.globalId;
            }
            console.log(`[Google Signup] ✅ 6 categorías seed creadas para tenant ${tenant.id}`);

            // ===== Seed products (9 productos iniciales con imágenes Cloudinary) =====
            const seedProducts = [
                { id: 9001, desc: 'Tortilla de Maíz', precio: 26.00, bascula: true, produccion: true, unidad: 1, cat: 'Derivados de maíz', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822301/TortillaMaiz_scug2v.webp' },
                { id: 9002, desc: 'Masa', precio: 20.00, bascula: true, produccion: true, unidad: 1, cat: 'Derivados de maíz', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822303/Masa_nzre1m.png' },
                { id: 9003, desc: 'Totopos', precio: 40.00, bascula: false, produccion: true, unidad: 3, cat: 'Derivados de maíz', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822303/Totopos_d5zxd1.png' },
                { id: 9004, desc: 'Salsa Roja', precio: 30.00, bascula: false, produccion: true, unidad: 3, cat: 'Salsas', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822303/SalsaRoja_fximvw.png' },
                { id: 9005, desc: 'Salsa Verde', precio: 30.00, bascula: false, produccion: true, unidad: 3, cat: 'Salsas', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822303/SalsaVerde_yg4zwm.png' },
                { id: 9006, desc: 'Tortilla de Harina', precio: 35.00, bascula: true, produccion: true, unidad: 1, cat: 'Derivados de maíz', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822304/TortillaHarina_k8tvt5.png' },
                { id: 9007, desc: 'Bolsa', precio: 1.00, bascula: false, produccion: false, unidad: 3, cat: 'Complementarios', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1776658909/Bolsa_tfprmp.png' },
                { id: 9008, desc: 'Costal', precio: 5.00, bascula: false, produccion: false, unidad: 3, cat: 'Complementarios', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1775878976/Costal_crv5l7.png' },
                { id: 9009, desc: 'Papel', precio: 1.00, bascula: false, produccion: false, unidad: 3, cat: 'Complementarios', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1775878975/PapelCebolla_pvnfen.png' },
            ];
            for (const p of seedProducts) {
                await client.query(`
                    INSERT INTO productos (
                        tenant_id, id_producto, descripcion,
                        precio_venta, bascula, is_pos_shortcut, produccion,
                        unidad_medida_id, proveedor_id, categoria, categoria_global_id,
                        global_id, terminal_id, image_url
                    ) VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10, $11, $12, $13)
                `, [
                    tenant.id, p.id, p.desc,
                    p.precio, p.bascula, p.produccion,
                    p.unidad, defaultSupplierId,
                    categoryIdMap[p.cat], categoryGlobalIdMap[p.cat],
                    `SEED_PRODUCT_${tenant.id}_${p.id}`, `mobile-signup-${Date.now()}`,
                    p.img
                ]);
            }
            console.log(`[Google Signup] ✅ 9 productos seed creados para tenant ${tenant.id}`);

            // Crear ProductoBranch para cada seed en la sucursal principal.
            // Sin esto, el desktop (con filtro estricto por PB) muestra catálogo vacío
            // al primer login. Misma transacción → si esto falla, todo el signup
            // hace ROLLBACK y el usuario no queda en estado inconsistente.
            for (const p of seedProducts) {
                await client.query(`
                    INSERT INTO producto_branches (
                        tenant_id, branch_id, product_global_id,
                        precio_venta, precio_compra, inventario, minimo,
                        is_active, global_id, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, 0, 0, 0, true, gen_random_uuid()::text, NOW(), NOW())
                `, [
                    tenant.id, branch.id,
                    `SEED_PRODUCT_${tenant.id}_${p.id}`,
                    p.precio
                ]);
            }
            console.log(`[Google Signup] ✅ 9 producto_branches creados para branch ${branch.id}`);

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
                    email: employee.email,
                    is_owner: employee.is_owner === true
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const refreshToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: tenant.id,
                    is_owner: employee.is_owner === true
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            console.log(`[Google Signup] ✅ Registro completado exitosamente para: ${email}`);

            // Notificación push al SuperAdmin (no bloquea la respuesta)
            notifySuperadmins(
                '🆕 Nuevo cliente registrado',
                `${businessName} (${email})`,
                {
                    type: 'tenant_signup',
                    tenant_id: tenant.id,
                    tenant_code: tenant.tenant_code,
                    business_name: businessName,
                    email,
                }
            ).catch(err =>
                console.error('[Google Signup] Error notif SuperAdmin:', err.message)
            );

            res.status(201).json({
                success: true,
                message: 'Registro exitoso',
                token,
                refreshToken,
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
                    globalId: employee.global_id,
                    isOwner: true,
                    canUseMobileApp: true,
                    mobileAccessType: 'admin',
                    mobileAccessTypes: 'admin'
                },
                branch: {
                    id: branch.id,
                    branchCode: branch.branch_code,
                    name: branch.name
                },
                // Permite al desktop guardar el mismo UUID que PG — evita un ciclo de
                // reconciliación en el primer sync tras el registro.
                employeeBranch: {
                    id: employeeBranch.id,
                    globalId: employeeBranch.global_id
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
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        } finally {
            client.release();
        }
    },

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
            const googlePictureUrl = payload.picture || null;

            console.log(`[Google Login] Token verificado. Email: ${email}, Picture: ${googlePictureUrl ? 'yes' : 'no'}`);

            // Buscar en TENANTS (fuente de verdad del email de registro)
            const tenantResult = await this.pool.query(
                `SELECT t.*, s.name as subscription_name, s.max_employees, s.max_devices_per_branch
                 FROM tenants t
                 JOIN subscriptions s ON t.subscription_id = s.id
                 WHERE LOWER(t.email) = LOWER($1) AND t.is_active = true`,
                [email]
            );

            if (tenantResult.rows.length === 0) {
                console.log(`[Google Login] Email no registrado en tenants: ${maskEmail(email)}`);
                return res.json({
                    success: true,
                    emailExists: false,
                    email: email,
                    googleName: googleName
                });
            }

            const tenant = tenantResult.rows[0];
            console.log(`[Google Login] Tenant encontrado: ${tenant.business_name} (ID: ${tenant.id})`);

            // Buscar el employee owner del tenant, JOIN con roles para obtener mobile_access_type
            const employeeResult = await this.pool.query(
                `SELECT e.*, r.name as role_name, r.mobile_access_type as role_mobile_access_type
                 FROM employees e
                 LEFT JOIN roles r ON e.role_id = r.id
                 WHERE e.tenant_id = $1 AND e.is_active = true
                 ORDER BY e.is_owner DESC NULLS LAST, r.id ASC, e.id ASC
                 LIMIT 1`,
                [tenant.id]
            );

            const employee = employeeResult.rows[0] || null;

            // Guardar foto de perfil de Google si está disponible
            if (employee && googlePictureUrl) {
                try {
                    await this.pool.query(
                        `UPDATE employees SET profile_photo_url = $1 WHERE id = $2`,
                        [googlePictureUrl, employee.id]
                    );
                    console.log(`[Google Login] 📸 Foto de perfil guardada para employee ${employee.id}`);
                } catch (photoError) {
                    console.log(`[Google Login] ⚠️ Error guardando foto: ${photoError.message}`);
                }
            }

            const branchesResult = await this.pool.query(`
                SELECT b.id, b.branch_code, b.name, b.address, b.timezone
                FROM branches b
                WHERE b.tenant_id = $1 AND b.is_active = true
                ORDER BY b.created_at ASC
            `, [tenant.id]);

            const branches = branchesResult.rows;

            // Obtener conteo de licencias para planLimits
            const licensesResult = await this.pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status IN ('available', 'active')) as total_licenses,
                    COUNT(*) FILTER (WHERE status = 'active') as used_licenses,
                    COUNT(*) FILTER (WHERE status = 'available') as available_licenses
                FROM branch_licenses
                WHERE tenant_id = $1
            `, [tenant.id]);
            const licenseInfo = licensesResult.rows[0];

            // Determinar branchId: main_branch_id si existe, si no, única sucursal,
            // si no, null (multi-branch requerirá selección posterior)
            let resolvedBranchId = null;
            if (employee) {
                resolvedBranchId = employee.main_branch_id || null;
                if (!resolvedBranchId && branches.length === 1) {
                    resolvedBranchId = branches[0].id;
                    // Persistir auto-asignación para que refresh-token futuro lo use
                    try {
                        await this.pool.query(
                            'UPDATE employees SET main_branch_id = $1 WHERE id = $2',
                            [resolvedBranchId, employee.id]
                        );
                        console.log(`[Google Login] 🔧 Auto-asignó main_branch_id=${resolvedBranchId} a empleado ${employee.email}`);
                    } catch (err) {
                        console.log(`[Google Login] ⚠️ No se pudo persistir main_branch_id: ${err.message}`);
                    }
                }
            }

            // Generar tokens usando el employee si existe, o datos mínimos del tenant
            const tokenPayload = employee ? {
                employeeId: employee.id,
                tenantId: tenant.id,
                ...(resolvedBranchId ? { branchId: resolvedBranchId } : {}),
                roleId: employee.role_id,
                email: email,
                is_owner: employee.is_owner === true
            } : {
                tenantId: tenant.id,
                email: email,
                is_owner: false
            };

            const accessToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '15m' });
            console.log(`[Google Login] 🔑 Token firmado con branchId=${resolvedBranchId ?? 'null (multi-branch)'}`);

            const refreshPayload = employee ? {
                employeeId: employee.id,
                tenantId: tenant.id,
                is_owner: employee.is_owner === true
            } : {
                tenantId: tenant.id,
                is_owner: false
            };

            const refreshToken = jwt.sign(refreshPayload, JWT_SECRET, { expiresIn: '30d' });

            console.log(`[Google Login] ✅ Email existe en tenant: ${tenant.business_name} - ${branches.length} sucursales disponibles`);

            res.json({
                success: true,
                emailExists: true,
                email: email,
                employee: employee ? {
                    id: employee.id,
                    email: employee.email,
                    username: employee.username,
                    fullName: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
                    role: employee.role_name || employee.role,
                    roleId: employee.role_id,
                    isOwner: employee.is_owner === true,
                    canUseMobileApp: employee.can_use_mobile_app === true,
                    globalId: employee.global_id,
                    mobileAccessType: employee.role_mobile_access_type || 'none',
                    mobileAccessTypes: employee.role_mobile_access_type || 'none'
                } : null,
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
                    maxBranches: parseInt(licenseInfo.total_licenses) || 1,
                    usedBranches: parseInt(licenseInfo.used_licenses) || 0,
                    availableBranches: parseInt(licenseInfo.available_licenses) || 0,
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
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

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
            const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

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

            // ═══════════════════════════════════════════════════════════════
            // Helper: sincronizar dispositivo a branch_devices (tabla unificada)
            // Genera nombre secuencial "Caja N" si no tiene nombre previo
            // ═══════════════════════════════════════════════════════════════
            async function syncToBranchDevices(devId, devName, devType) {
                try {
                    // Verificar si ya existe en branch_devices
                    const existingBD = await client.query(
                        `SELECT id, device_name FROM branch_devices WHERE device_id = $1 AND branch_id = $2 AND tenant_id = $3`,
                        [devId, branchId, tenantId]
                    );

                    if (existingBD.rows.length > 0) {
                        // Ya existe — solo actualizar last_seen y reactivar
                        await client.query(
                            `UPDATE branch_devices SET last_seen_at = NOW(), is_active = TRUE, updated_at = NOW() WHERE id = $1`,
                            [existingBD.rows[0].id]
                        );
                        return existingBD.rows[0].device_name;
                    }

                    // Auto-generar nombre "Caja N"
                    const countResult = await client.query(
                        `SELECT COUNT(*) as cnt FROM branch_devices WHERE branch_id = $1 AND tenant_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
                        [branchId, tenantId]
                    );
                    let n = parseInt(countResult.rows[0].cnt) + 1;
                    let finalName = devName || `Caja ${n}`;

                    // Si no tiene nombre custom, generar secuencial con detección de colisiones
                    if (!devName || devName === 'Dispositivo') {
                        finalName = `Caja ${n}`;
                        for (let attempt = 0; attempt < 5; attempt++) {
                            const collision = await client.query(
                                `SELECT id FROM branch_devices WHERE branch_id = $1 AND tenant_id = $2 AND device_name = $3 AND COALESCE(is_active, TRUE) = TRUE`,
                                [branchId, tenantId, finalName]
                            );
                            if (collision.rows.length === 0) break;
                            n++;
                            finalName = `Caja ${n}`;
                        }
                    }

                    await client.query(`
                        INSERT INTO branch_devices (tenant_id, branch_id, device_id, device_name, device_type, is_primary, last_seen_at, created_at, updated_at)
                        VALUES ($1, $2, $3, $4, $5, FALSE, NOW(), NOW(), NOW())
                        ON CONFLICT (device_id, branch_id, tenant_id) DO UPDATE SET
                            device_name = COALESCE(NULLIF($4, ''), branch_devices.device_name),
                            last_seen_at = NOW(), is_active = TRUE, updated_at = NOW()
                    `, [tenantId, branchId, devId, finalName, devType || 'desktop']);

                    console.log(`[Device Register] ✅ Sincronizado a branch_devices: ${finalName}`);
                    return finalName;
                } catch (bdError) {
                    console.error('[Device Register] ⚠️ Error sincronizando a branch_devices:', bdError.message);
                    return devName || 'Dispositivo';
                }
            }

            const existingDeviceResult = await client.query(
                'SELECT * FROM devices WHERE device_id = $1 AND tenant_id = $2',
                [deviceId, tenantId]
            );

            if (existingDeviceResult.rows.length > 0) {
                const existingDevice = existingDeviceResult.rows[0];

                if (existingDevice.branch_id === branchId && existingDevice.is_active) {
                    // Sincronizar a branch_devices (tabla unificada)
                    const bdName = await syncToBranchDevices(existingDevice.device_id, existingDevice.device_name, existingDevice.device_type);
                    await client.query('COMMIT');
                    console.log(`[Device Register] Dispositivo ya registrado y activo en branch ${branch.name}`);
                    return res.json({
                        success: true,
                        message: 'Dispositivo ya está registrado en esta sucursal',
                        device: {
                            id: existingDevice.id,
                            deviceId: existingDevice.device_id,
                            deviceName: bdName,
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

                // Sincronizar a branch_devices (tabla unificada)
                const bdNameUpdated = await syncToBranchDevices(deviceId, deviceName, deviceType);
                await client.query('COMMIT');

                // Auto-enable multi-caja si 2+ dispositivos activos
                try {
                    const bdCount = await this.pool.query(
                        `SELECT COUNT(*) as cnt FROM branch_devices
                         WHERE branch_id = $1 AND tenant_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
                        [branchId, tenantId]
                    );
                    if (parseInt(bdCount.rows[0].cnt) >= 2) {
                        const branchMC = await this.pool.query(
                            `SELECT multi_caja_enabled FROM branches WHERE id = $1 AND tenant_id = $2`,
                            [branchId, tenantId]
                        );
                        if (branchMC.rows.length > 0 && !branchMC.rows[0].multi_caja_enabled) {
                            await this.pool.query(
                                `UPDATE branches SET multi_caja_enabled = TRUE, updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
                                [branchId, tenantId]
                            );
                            console.log(`[Device Register] 🔄 Multi-caja auto-habilitado para branch ${branchId}`);
                            const io = req.app.get('io');
                            if (io) {
                                io.to(`branch_${branchId}`).emit('branch_settings_changed', {
                                    branchId, multi_caja_enabled: true, auto_enabled: true,
                                    active_device_count: parseInt(bdCount.rows[0].cnt),
                                    receivedAt: new Date().toISOString()
                                });
                            }
                        }
                    }
                } catch (mcErr) {
                    console.error('[Device Register] ⚠️ Error auto-enable multi-caja:', mcErr.message);
                }

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
                        deviceName: bdNameUpdated,
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

            // Sincronizar a branch_devices PRIMERO (para obtener nombre secuencial)
            const bdNameNew = await syncToBranchDevices(deviceId, deviceName, deviceType || 'desktop');

            const newDeviceResult = await client.query(`
                INSERT INTO devices (
                    tenant_id, branch_id, employee_id, device_id,
                    device_name, device_type, is_active, last_seen
                ) VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
                RETURNING id, device_id, device_name, device_type, branch_id, is_active, last_seen
            `, [tenantId, branchId, employeeId, deviceId, bdNameNew, deviceType || 'desktop']);

            const newDevice = newDeviceResult.rows[0];

            await client.query('COMMIT');

            // Auto-enable multi-caja si 2+ dispositivos activos
            try {
                const bdCount = await this.pool.query(
                    `SELECT COUNT(*) as cnt FROM branch_devices
                     WHERE branch_id = $1 AND tenant_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
                    [branchId, tenantId]
                );
                if (parseInt(bdCount.rows[0].cnt) >= 2) {
                    const branchMC = await this.pool.query(
                        `SELECT multi_caja_enabled FROM branches WHERE id = $1 AND tenant_id = $2`,
                        [branchId, tenantId]
                    );
                    if (branchMC.rows.length > 0 && !branchMC.rows[0].multi_caja_enabled) {
                        await this.pool.query(
                            `UPDATE branches SET multi_caja_enabled = TRUE, updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
                            [branchId, tenantId]
                        );
                        console.log(`[Device Register] 🔄 Multi-caja auto-habilitado para branch ${branchId}`);
                        const io = req.app.get('io');
                        if (io) {
                            io.to(`branch_${branchId}`).emit('branch_settings_changed', {
                                branchId, multi_caja_enabled: true, auto_enabled: true,
                                active_device_count: parseInt(bdCount.rows[0].cnt),
                                receivedAt: new Date().toISOString()
                            });
                        }
                    }
                }
            } catch (mcErr) {
                console.error('[Device Register] ⚠️ Error auto-enable multi-caja:', mcErr.message);
            }

            console.log(`[Device Register] ✅ Dispositivo creado: ${deviceId} en branch ${branch.name} como "${bdNameNew}" (${activeDevicesCount + 1}/${maxDevicesPerBranch})`);

            res.status(201).json({
                success: true,
                message: 'Dispositivo registrado exitosamente',
                device: {
                    id: newDevice.id,
                    deviceId: newDevice.device_id,
                    deviceName: bdNameNew,
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

};
