// Apple Sign-In Methods
// Verifica identity tokens de Apple y maneja signup/login

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { BCRYPT_ROUNDS } = require('../../config/security');

const JWT_SECRET = process.env.JWT_SECRET;
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.sya.mobileapp';


// Cliente JWKS para obtener las public keys de Apple
const appleJwksClient = jwksClient({
    jwksUri: 'https://appleid.apple.com/auth/keys',
    cache: true,
    cacheMaxAge: 86400000, // 24 horas
    rateLimit: true,
});

/**
 * Verifica un identity token de Apple Sign-In.
 * Apple usa JWTs firmados con RS256, verificados con sus public keys.
 * @param {string} identityToken - JWT de Apple
 * @returns {object} - { email, sub, email_verified }
 */
async function verifyAppleToken(identityToken) {
    // 1. Decodificar el header para obtener el kid
    const decoded = jwt.decode(identityToken, { complete: true });
    if (!decoded || !decoded.header || !decoded.header.kid) {
        throw new Error('Token de Apple inválido: no se pudo decodificar el header');
    }

    // 2. Obtener la public key de Apple usando el kid
    const key = await appleJwksClient.getSigningKey(decoded.header.kid);
    const publicKey = key.getPublicKey();

    // 3. Verificar el token
    const payload = jwt.verify(identityToken, publicKey, {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: APPLE_BUNDLE_ID,
    });

    return {
        sub: payload.sub,           // Identificador único del usuario en Apple
        email: payload.email,
        email_verified: payload.email_verified === 'true' || payload.email_verified === true,
    };
}

module.exports = {
    /**
     * POST /api/auth/apple-login
     * Verifica si el email de Apple ya está registrado.
     * Similar a googleLogin pero para tokens de Apple.
     */
    async appleLogin(req, res) {
        console.log('[Apple Login] Nueva solicitud de verificación con Apple Identity Token');

        const { identityToken, fullName } = req.body;

        if (!identityToken) {
            return res.status(400).json({
                success: false,
                message: 'identityToken es requerido'
            });
        }

        try {
            // Verificar el token de Apple
            let appleUser;
            try {
                appleUser = await verifyAppleToken(identityToken);
            } catch (error) {
                console.error('[Apple Login] Error al verificar Identity Token:', error.message);
                return res.status(401).json({
                    success: false,
                    message: 'Token de Apple inválido o expirado'
                });
            }

            const email = appleUser.email;
            const appleSub = appleUser.sub;
            console.log(`[Apple Login] Token verificado. Email: ${email}, Sub: ${appleSub}`);

            // Buscar primero por apple_user_identifier (más confiable - Apple puede ocultar email)
            let tenantResult = await this.pool.query(
                `SELECT t.*, s.name as subscription_name, s.max_employees, s.max_devices_per_branch
                 FROM tenants t
                 JOIN subscriptions s ON t.subscription_id = s.id
                 JOIN employees e ON e.tenant_id = t.id
                 WHERE e.apple_user_identifier = $1 AND t.is_active = true
                 LIMIT 1`,
                [appleSub]
            );

            // Si no se encontró por apple_sub, buscar por email en tenants
            if (tenantResult.rows.length === 0 && email) {
                tenantResult = await this.pool.query(
                    `SELECT t.*, s.name as subscription_name, s.max_employees, s.max_devices_per_branch
                     FROM tenants t
                     JOIN subscriptions s ON t.subscription_id = s.id
                     WHERE LOWER(t.email) = LOWER($1) AND t.is_active = true`,
                    [email]
                );
            }

            if (tenantResult.rows.length === 0) {
                console.log(`[Apple Login] Email/Apple ID no registrado`);
                return res.json({
                    success: true,
                    emailExists: false,
                    email: email,
                    appleName: fullName || null,
                    appleSub: appleSub
                });
            }

            const tenant = tenantResult.rows[0];
            console.log(`[Apple Login] Tenant encontrado: ${tenant.business_name} (ID: ${tenant.id})`);

            // Buscar el employee owner, JOIN con roles para obtener mobile_access_type
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

            // Actualizar apple_user_identifier si no lo tiene
            if (employee && !employee.apple_user_identifier) {
                try {
                    await this.pool.query(
                        `UPDATE employees SET apple_user_identifier = $1 WHERE id = $2`,
                        [appleSub, employee.id]
                    );
                    console.log(`[Apple Login] 🍎 Apple ID vinculado a employee ${employee.id}`);
                } catch (err) {
                    console.log(`[Apple Login] ⚠️ Error vinculando Apple ID: ${err.message}`);
                }
            }

            // Obtener branches
            const branchesResult = await this.pool.query(`
                SELECT b.id, b.branch_code, b.name, b.address, b.timezone
                FROM branches b
                WHERE b.tenant_id = $1 AND b.is_active = true
                ORDER BY b.created_at ASC
            `, [tenant.id]);

            // Licencias
            const licensesResult = await this.pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE status IN ('available', 'active')) as total_licenses,
                    COUNT(*) FILTER (WHERE status = 'active') as used_licenses,
                    COUNT(*) FILTER (WHERE status = 'available') as available_licenses
                FROM branch_licenses
                WHERE tenant_id = $1
            `, [tenant.id]);
            const licenseInfo = licensesResult.rows[0];

            // Determinar branchId: main_branch_id si existe, si no, única sucursal
            const branches = branchesResult.rows;
            let resolvedBranchId = null;
            if (employee) {
                resolvedBranchId = employee.main_branch_id || null;
                if (!resolvedBranchId && branches.length === 1) {
                    resolvedBranchId = branches[0].id;
                    try {
                        await this.pool.query(
                            'UPDATE employees SET main_branch_id = $1 WHERE id = $2',
                            [resolvedBranchId, employee.id]
                        );
                        console.log(`[Apple Login] 🔧 Auto-asignó main_branch_id=${resolvedBranchId} a empleado ${employee.email}`);
                    } catch (err) {
                        console.log(`[Apple Login] ⚠️ No se pudo persistir main_branch_id: ${err.message}`);
                    }
                }
            }

            // Generar tokens
            const tokenPayload = employee ? {
                employeeId: employee.id,
                tenantId: tenant.id,
                ...(resolvedBranchId ? { branchId: resolvedBranchId } : {}),
                roleId: employee.role_id,
                email: employee.email,
                is_owner: employee.is_owner === true
            } : {
                tenantId: tenant.id,
                email: email,
                is_owner: false
            };

            const accessToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '15m' });
            console.log(`[Apple Login] 🔑 Token firmado con branchId=${resolvedBranchId ?? 'null (multi-branch)'}`);
            const refreshToken = jwt.sign(
                employee ? { employeeId: employee.id, tenantId: tenant.id, is_owner: employee.is_owner === true }
                         : { tenantId: tenant.id, is_owner: false },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            console.log(`[Apple Login] ✅ Email existe en tenant: ${tenant.business_name}`);

            res.json({
                success: true,
                emailExists: true,
                email: email,
                accessToken,
                refreshToken,
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
                    subscription: tenant.subscription_name
                },
                branches: branchesResult.rows.map(b => ({
                    id: b.id,
                    branchCode: b.branch_code,
                    name: b.name,
                    timezone: b.timezone || 'America/Mexico_City'
                })),
                planLimits: {
                    maxBranches: parseInt(licenseInfo?.total_licenses, 10) || 0,
                    usedBranches: parseInt(licenseInfo?.used_licenses, 10) || 0,
                    availableBranches: parseInt(licenseInfo?.available_licenses, 10) || 0,
                    maxEmployees: tenant.max_employees || 0,
                    maxDevicesPerBranch: tenant.max_devices_per_branch || 0
                }
            });

        } catch (error) {
            console.error('[Apple Login] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al procesar login con Apple',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    /**
     * POST /api/auth/apple-signup
     * Crea un nuevo tenant usando Apple Sign-In.
     * Reutiliza la misma lógica de googleSignup pero con Apple identity token.
     */
    async appleSignup(req, res) {
        console.log('[Apple Signup] Nueva solicitud de registro con Apple');

        const { identityToken, email, displayName, businessName, phoneNumber, address, password, rfc } = req.body;

        if (!identityToken || !email || !businessName || !password) {
            return res.status(400).json({
                success: false,
                message: 'Faltan campos requeridos: identityToken, email, businessName, password'
            });
        }

        // Verificar el token de Apple
        let appleUser;
        try {
            appleUser = await verifyAppleToken(identityToken);
        } catch (error) {
            console.error('[Apple Signup] Error al verificar Identity Token:', error.message);
            return res.status(401).json({
                success: false,
                message: 'Token de Apple inválido o expirado'
            });
        }

        // Inyectar el apple_sub en el request y delegar a googleSignup
        // (misma lógica de creación de tenant/branch/employee)
        // Pero necesitamos manejar apple_user_identifier en lugar de google_user_identifier
        const appleSub = appleUser.sub;
        const finalName = displayName || 'Propietario';

        const bcrypt = require('bcryptjs');
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Verificar email duplicado
            const existingTenant = await client.query(
                'SELECT id, tenant_code, business_name FROM tenants WHERE LOWER(email) = LOWER($1)',
                [email]
            );

            if (existingTenant.rows.length > 0) {
                const tenantId = existingTenant.rows[0].id;
                const branchesResult = await client.query(
                    `SELECT id, branch_code, name, timezone FROM branches WHERE tenant_id = $1 ORDER BY created_at ASC`,
                    [tenantId]
                );

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
                        id: b.id, branchCode: b.branch_code, name: b.name,
                        timezone: b.timezone || 'America/Mexico_City'
                    }))
                });
            }

            // Generar tenant code (mismo formato que Google signup)
            const tenantCode = `TEN${Date.now()}`;

            // Crear tenant
            const tenantResult = await client.query(
                `INSERT INTO tenants (tenant_code, business_name, email, subscription_id, is_active, trial_ends_at, subscription_status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [tenantCode, businessName, email, 1, true, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), 'trial']
            );
            const tenant = tenantResult.rows[0];

            // Crear branch
            const branchCode = `B${tenant.id}M`;
            const branchResult = await client.query(
                `INSERT INTO branches (tenant_id, branch_code, name, address, phone, rfc, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [tenant.id, branchCode, businessName + ' - Principal', address || null, phoneNumber || null, rfc || null, true]
            );
            const branch = branchResult.rows[0];

            // Crear employee owner con apple_user_identifier
            const { v4: uuidv4 } = require('uuid');
            const globalId = uuidv4();
            const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

            const employeeResult = await client.query(
                `INSERT INTO employees (
                    tenant_id, username, email, password_hash, first_name, last_name,
                    role_id, is_active, is_owner, can_use_mobile_app, main_branch_id,
                    apple_user_identifier, global_id, terminal_id, email_verified
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                 RETURNING *`,
                [
                    tenant.id, email.split('@')[0], email, hashedPassword,
                    finalName.split(' ')[0], finalName.split(' ').slice(1).join(' ') || '',
                    1, true, true, true, branch.id,
                    appleSub, globalId, 'mobile-' + Date.now(), true
                ]
            );
            const employee = employeeResult.rows[0];

            // Employee-branch relationship
            await client.query(
                `INSERT INTO employee_branches (tenant_id, employee_id, branch_id) VALUES ($1, $2, $3)`,
                [tenant.id, employee.id, branch.id]
            );

            // Cliente genérico "Público en General"
            const genericCustomerResult = await client.query(
                'SELECT get_or_create_generic_customer($1, $2) as customer_id',
                [tenant.id, branch.id]
            );
            console.log(`[Apple Signup] ✅ Cliente genérico creado: ID ${genericCustomerResult.rows[0].customer_id}`);

            // Licencia de sucursal
            await client.query(`
                INSERT INTO branch_licenses (tenant_id, branch_id, status, granted_by, activated_at, notes)
                VALUES ($1, $2, 'active', 'system', NOW(), 'Licencia inicial - registro')
            `, [tenant.id, branch.id]);
            console.log(`[Apple Signup] ✅ Licencia de sucursal creada para branch ${branch.id}`);

            // ===== Seed supplier "Productos propios" =====
            const supplierGlobalId = `SEED_SUPPLIER_PRODUCTOS_PROPIOS_${tenant.id}`;
            const supplierResult = await client.query(`
                INSERT INTO suppliers (tenant_id, name, contact_person, phone_number, global_id, is_active, created_at, updated_at)
                VALUES ($1, 'Productos propios', 'N/A', 'N/A', $2, true, NOW(), NOW())
                RETURNING id
            `, [tenant.id, supplierGlobalId]);
            const defaultSupplierId = supplierResult.rows[0].id;
            console.log(`[Apple Signup] ✅ Proveedor 'Productos propios' creado (ID: ${defaultSupplierId})`);

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
            console.log(`[Apple Signup] ✅ 6 categorías seed creadas para tenant ${tenant.id}`);

            // ===== Seed products (9 productos iniciales con imágenes Cloudinary) =====
            const seedProducts = [
                { id: 9001, desc: 'Tortilla de Maíz', precio: 26.00, bascula: true, produccion: true, unidad: 1, cat: 'Derivados de maíz', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822301/TortillaMaiz_scug2v.webp' },
                { id: 9002, desc: 'Masa', precio: 20.00, bascula: true, produccion: true, unidad: 1, cat: 'Derivados de maíz', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822303/Masa_nzre1m.png' },
                { id: 9003, desc: 'Totopos', precio: 40.00, bascula: false, produccion: true, unidad: 3, cat: 'Derivados de maíz', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822303/Totopos_d5zxd1.png' },
                { id: 9004, desc: 'Salsa Roja', precio: 30.00, bascula: false, produccion: true, unidad: 3, cat: 'Salsas', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822303/SalsaRoja_fximvw.png' },
                { id: 9005, desc: 'Salsa Verde', precio: 30.00, bascula: false, produccion: true, unidad: 3, cat: 'Salsas', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822303/SalsaVerde_yg4zwm.png' },
                { id: 9006, desc: 'Tortilla de Harina', precio: 35.00, bascula: true, produccion: true, unidad: 1, cat: 'Derivados de maíz', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1774822304/TortillaHarina_k8tvt5.png' },
                { id: 9007, desc: 'Bolsa', precio: 1.00, bascula: false, produccion: false, unidad: 3, cat: 'Complementarios', img: 'https://res.cloudinary.com/dhm7qyyl1/image/upload/v1775878976/Bolsa_npe9gn.png' },
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
            console.log(`[Apple Signup] ✅ 9 productos seed creados para tenant ${tenant.id}`);

            await client.query('COMMIT');

            // Generar tokens
            const token = jwt.sign(
                { employeeId: employee.id, tenantId: tenant.id, branchId: branch.id, roleId: 1, email, is_owner: true },
                JWT_SECRET, { expiresIn: '15m' }
            );
            const refreshToken = jwt.sign(
                { employeeId: employee.id, tenantId: tenant.id, is_owner: true },
                JWT_SECRET, { expiresIn: '30d' }
            );

            console.log(`[Apple Signup] ✅ Registro completado: ${email} → Tenant: ${businessName}`);

            res.status(201).json({
                success: true,
                message: 'Registro exitoso',
                token,
                refreshToken,
                tenant: {
                    id: tenant.id, tenantCode: tenant.tenant_code, businessName: tenant.business_name,
                    trialEndsAt: tenant.trial_ends_at, subscriptionStatus: 'trial'
                },
                employee: {
                    id: employee.id, email: employee.email,
                    fullName: `${employee.first_name} ${employee.last_name}`.trim(),
                    roleId: 1, globalId: employee.global_id,
                    isOwner: true,
                    canUseMobileApp: true,
                    mobileAccessType: 'admin',
                    mobileAccessTypes: 'admin'
                },
                branch: { id: branch.id, branchCode: branch.branch_code, name: branch.name }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Apple Signup] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al registrar usuario con Apple',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        } finally {
            client.release();
        }
    }
};
