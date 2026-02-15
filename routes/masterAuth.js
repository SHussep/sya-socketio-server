// ═══════════════════════════════════════════════════════════════
// RUTAS: Master Login (Superusuario)
// Acceso de emergencia con contraseña maestra verificada contra BD
// Rate limiting agresivo + audit log completo
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// ═══════════════════════════════════════════════════════════════
// RATE LIMITER DEDICADO (más restrictivo que login normal)
// 3 intentos por IP en 15 minutos, lockout de 60 minutos
// ═══════════════════════════════════════════════════════════════
const masterLoginAttempts = new Map();

const MASTER_LOGIN_CONFIG = {
    maxAttempts: 3,
    windowMs: 15 * 60 * 1000,    // 15 minutos
    lockoutMs: 60 * 60 * 1000,   // 60 minutos de bloqueo
};

function cleanupMasterAttempts() {
    const now = Date.now();
    for (const [key, record] of masterLoginAttempts.entries()) {
        if (record.lockedUntil && record.lockedUntil < now) {
            masterLoginAttempts.delete(key);
        } else if (now - record.firstAttempt > MASTER_LOGIN_CONFIG.windowMs * 2) {
            masterLoginAttempts.delete(key);
        }
    }
}

setInterval(cleanupMasterAttempts, 5 * 60 * 1000);

function masterRateLimiter(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();

    let record = masterLoginAttempts.get(ip);

    if (!record) {
        record = { count: 0, firstAttempt: now };
    }

    // Verificar bloqueo
    if (record.lockedUntil && record.lockedUntil > now) {
        const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
        console.warn(`[MasterAuth] IP bloqueada: ${ip}, remaining: ${remainingSeconds}s`);
        return res.status(429).json({
            success: false,
            message: `Demasiados intentos. Intente de nuevo en ${Math.ceil(remainingSeconds / 60)} minutos.`,
            retryAfter: remainingSeconds
        });
    }

    // Resetear ventana si expiró
    if (now - record.firstAttempt > MASTER_LOGIN_CONFIG.windowMs) {
        record = { count: 0, firstAttempt: now };
    }

    record.count++;

    if (record.count > MASTER_LOGIN_CONFIG.maxAttempts) {
        record.lockedUntil = now + MASTER_LOGIN_CONFIG.lockoutMs;
        masterLoginAttempts.set(ip, record);
        console.warn(`[MasterAuth] IP bloqueada por exceso de intentos: ${ip}`);
        return res.status(429).json({
            success: false,
            message: 'Acceso bloqueado temporalmente por seguridad. Intente en 60 minutos.',
            retryAfter: MASTER_LOGIN_CONFIG.lockoutMs / 1000
        });
    }

    masterLoginAttempts.set(ip, record);
    req.clearMasterAttempts = () => masterLoginAttempts.delete(ip);
    next();
}

// ═══════════════════════════════════════════════════════════════
// RUTA PRINCIPAL
// ═══════════════════════════════════════════════════════════════

module.exports = function (pool) {
    const router = express.Router();

    // POST /api/auth/master-login
    router.post('/master-login', masterRateLimiter, async (req, res) => {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        const userAgent = req.headers['user-agent'] || '';
        const { username, password, clientType, ownerEmail } = req.body;

        try {
            // Validar campos requeridos
            if (!password) {
                return res.status(400).json({
                    success: false,
                    message: 'Contraseña es requerida'
                });
            }

            // Buscar credencial maestra
            // Si viene username, buscar por username. Si no (mobile), usar la primera activa.
            let credResult;
            if (username) {
                credResult = await pool.query(
                    'SELECT id, username, password_hash FROM master_credentials WHERE username = $1 AND is_active = true',
                    [username]
                );
            } else {
                credResult = await pool.query(
                    'SELECT id, username, password_hash FROM master_credentials WHERE is_active = true ORDER BY id ASC LIMIT 1'
                );
            }

            if (credResult.rows.length === 0) {
                // Registrar intento fallido
                await pool.query(
                    `INSERT INTO master_login_audit (username, ip_address, user_agent, success, client_type, failure_reason)
                     VALUES ($1, $2, $3, false, $4, 'usuario_no_encontrado')`,
                    [username, ip, userAgent, clientType || 'unknown']
                );

                console.warn(`[MasterAuth] Intento fallido - usuario no encontrado: ${username} desde ${ip}`);

                // Respuesta genérica (no revelar si el usuario existe)
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            const credential = credResult.rows[0];

            // Verificar contraseña con bcrypt (timing-safe)
            const isValid = await bcrypt.compare(password, credential.password_hash);

            if (!isValid) {
                // Registrar intento fallido
                await pool.query(
                    `INSERT INTO master_login_audit (username, ip_address, user_agent, success, client_type, failure_reason)
                     VALUES ($1, $2, $3, false, $4, 'contrasena_incorrecta')`,
                    [username, ip, userAgent, clientType || 'unknown']
                );

                console.warn(`[MasterAuth] Intento fallido - contraseña incorrecta: ${username} desde ${ip}`);

                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            // ═══════════════════════════════════════════════════════════
            // CONTRASEÑA VÁLIDA - Generar respuesta según clientType
            // ═══════════════════════════════════════════════════════════

            // Limpiar intentos después de éxito
            if (req.clearMasterAttempts) req.clearMasterAttempts();

            if (clientType === 'mobile' && ownerEmail) {
                // MOBILE: Buscar tenant por email del owner y hacer login como el owner
                const ownerResult = await pool.query(
                    `SELECT e.id, e.tenant_id, e.email, e.first_name, e.last_name, e.role_id,
                            e.main_branch_id, e.username, e.can_use_mobile_app,
                            e.google_user_identifier, e.global_id,
                            t.business_name
                     FROM employees e
                     JOIN tenants t ON e.tenant_id = t.id
                     WHERE LOWER(e.email) = LOWER($1) AND e.is_active = true
                     ORDER BY e.role_id ASC
                     LIMIT 1`,
                    [ownerEmail]
                );

                if (ownerResult.rows.length === 0) {
                    await pool.query(
                        `INSERT INTO master_login_audit (username, ip_address, user_agent, success, client_type, failure_reason)
                         VALUES ($1, $2, $3, false, $4, 'owner_email_no_encontrado')`,
                        [username, ip, userAgent, clientType]
                    );

                    return res.status(404).json({
                        success: false,
                        message: 'No se encontró un empleado con ese correo'
                    });
                }

                const owner = ownerResult.rows[0];

                // Obtener sucursales del owner
                const branchesResult = await pool.query(
                    `SELECT b.id, b.branch_code as code, b.name, b.address
                     FROM branches b
                     INNER JOIN employee_branches eb ON b.id = eb.branch_id
                     WHERE eb.employee_id = $1 AND b.tenant_id = $2 AND b.is_active = true
                     ORDER BY b.created_at ASC`,
                    [owner.id, owner.tenant_id]
                );

                const branches = branchesResult.rows;
                const selectedBranch = branches.find(b => b.id === owner.main_branch_id) || branches[0];

                if (!selectedBranch) {
                    return res.status(404).json({
                        success: false,
                        message: 'No se encontraron sucursales para este empleado'
                    });
                }

                // Generar JWT con datos reales del owner
                const token = jwt.sign(
                    {
                        employeeId: owner.id,
                        tenantId: owner.tenant_id,
                        branchId: selectedBranch.id,
                        roleId: owner.role_id,
                        email: owner.email,
                        isMasterLogin: true
                    },
                    JWT_SECRET,
                    { expiresIn: '15m' }
                );

                const refreshToken = jwt.sign(
                    {
                        employeeId: owner.id,
                        tenantId: owner.tenant_id,
                        isMasterLogin: true
                    },
                    JWT_SECRET,
                    { expiresIn: '30d' }
                );

                // Registrar éxito
                await pool.query(
                    `INSERT INTO master_login_audit (username, ip_address, user_agent, success, client_type, target_tenant_id, target_branch_id)
                     VALUES ($1, $2, $3, true, $4, $5, $6)`,
                    [username, ip, userAgent, clientType, owner.tenant_id, selectedBranch.id]
                );

                console.log(`[MasterAuth] Login maestro EXITOSO (mobile): ${username} → tenant ${owner.tenant_id} (${owner.business_name})`);

                return res.json({
                    success: true,
                    isMasterLogin: true,
                    data: {
                        token,
                        refreshToken,
                        employee: {
                            id: owner.id,
                            email: owner.email,
                            username: owner.username,
                            fullName: `${owner.first_name || ''} ${owner.last_name || ''}`.trim(),
                            firstName: owner.first_name,
                            lastName: owner.last_name,
                            roleId: owner.role_id,
                            mainBranchId: owner.main_branch_id,
                            canUseMobileApp: owner.can_use_mobile_app,
                            googleUserIdentifier: owner.google_user_identifier,
                            globalId: owner.global_id
                        },
                        tenant: {
                            id: owner.tenant_id,
                            businessName: owner.business_name
                        },
                        branches: branches.map(b => ({
                            id: b.id,
                            code: b.code,
                            name: b.name,
                            address: b.address
                        })),
                        selectedBranch: {
                            id: selectedBranch.id,
                            code: selectedBranch.code,
                            name: selectedBranch.name
                        }
                    }
                });

            } else {
                // DESKTOP: Solo verificar contraseña, Desktop usa BD local
                const token = jwt.sign(
                    {
                        isMasterLogin: true,
                        masterUsername: username,
                        role: 'admin'
                    },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );

                // Registrar éxito
                await pool.query(
                    `INSERT INTO master_login_audit (username, ip_address, user_agent, success, client_type)
                     VALUES ($1, $2, $3, true, $4)`,
                    [username, ip, userAgent, clientType || 'desktop']
                );

                console.log(`[MasterAuth] Login maestro EXITOSO (desktop): ${username} desde ${ip}`);

                return res.json({
                    success: true,
                    isMasterLogin: true,
                    data: {
                        token,
                        message: 'Acceso maestro verificado. Use la sesión local del equipo.'
                    }
                });
            }

        } catch (error) {
            console.error(`[MasterAuth] Error interno:`, error);
            return res.status(500).json({
                success: false,
                message: 'Error interno del servidor'
            });
        }
    });

    return router;
};
