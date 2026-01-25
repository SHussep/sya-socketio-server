// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE: Autenticacion JWT
// Verifica tokens JWT y extrae informacion del usuario
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Factory que crea el middleware authenticateToken con acceso al pool
 * @param {Pool} pool - Pool de conexiones PostgreSQL
 * @returns {Function} Middleware de autenticacion
 */
function createAuthMiddleware(pool) {
    return async function authenticateToken(req, res, next) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        try {
            const user = jwt.verify(token, JWT_SECRET);

            // Verificar que el tenant existe en la base de datos
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

/**
 * Middleware para verificar que tenant_id en el body coincide con JWT
 * Usar DESPUES de authenticateToken
 */
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

module.exports = { createAuthMiddleware, requireTenantMatch };
