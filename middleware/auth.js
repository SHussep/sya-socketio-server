// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE DE AUTENTICACIÓN - JWT + Superadmin PIN
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
const SUPER_ADMIN_PIN_HASH = process.env.SUPER_ADMIN_PIN_HASH;

// Simple JWT verification (used by server.js, branches, debug, telemetry)
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token inválido o expirado' });
        }
        req.user = user;
        next();
    });
}

// Factory: JWT verification + tenant DB validation (used by devices, expenses, guardian)
function createAuthMiddleware(pool) {
    return async function authenticateToken(req, res, next) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        try {
            const user = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

            if (user.tenantId && pool) {
                try {
                    const tenantCheck = await pool.query(
                        'SELECT id FROM tenants WHERE id = $1',
                        [user.tenantId]
                    );

                    if (tenantCheck.rows.length === 0) {
                        console.log(`[Auth] Tenant ${user.tenantId} no existe`);
                        return res.status(403).json({
                            success: false,
                            message: 'Tu cuenta ha sido desactivada o eliminada.',
                            code: 'TENANT_NOT_FOUND'
                        });
                    }
                } catch (dbError) {
                    console.error('[Auth] Error verificando tenant:', dbError.message);
                }
            }

            req.user = user;
            next();
        } catch (err) {
            return res.status(401).json({
                success: false,
                message: 'Token invalido o expirado',
                code: 'TOKEN_EXPIRED'
            });
        }
    };
}

// Verify tenant_id in body matches JWT (use AFTER authenticateToken)
function requireTenantMatch(req, res, next) {
    const jwtTenantId = req.user?.tenantId;
    const bodyTenantId = req.body?.tenant_id || req.body?.tenantId;

    if (!jwtTenantId) {
        return res.status(401).json({
            success: false,
            message: 'Token no contiene tenant_id'
        });
    }

    if (bodyTenantId && parseInt(bodyTenantId) !== parseInt(jwtTenantId)) {
        console.warn(`[Auth] Tenant mismatch: JWT=${jwtTenantId}, body=${bodyTenantId}`);
        return res.status(403).json({
            success: false,
            message: 'No tienes acceso a este tenant'
        });
    }

    next();
}

// ✅ SECURITY: Superadmin PIN middleware for dangerous admin endpoints
function requireSuperAdminPIN(req, res, next) {
    if (!SUPER_ADMIN_PIN_HASH) {
        return res.status(503).json({ success: false, message: 'Superadmin no configurado' });
    }
    const pin = req.body?.adminPin || req.headers['x-admin-pin'];
    if (!pin) {
        return res.status(401).json({ success: false, message: 'PIN de superadmin requerido' });
    }
    const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(pinHash), Buffer.from(SUPER_ADMIN_PIN_HASH))) {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        console.warn(`[Security] ⚠️ PIN incorrecto en endpoint admin desde IP: ${ip}`);
        return res.status(403).json({ success: false, message: 'PIN incorrecto' });
    }
    next();
}

module.exports = { authenticateToken, createAuthMiddleware, requireTenantMatch, requireSuperAdminPIN };
