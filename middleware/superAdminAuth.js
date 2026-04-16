// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE: superAdminAuth
// Verifica JWT firmado con RS256 emitido por /api/auth/super-admin/login.
// Defensa contra algorithm-confusion, audiencia fija, revocación por jti,
// allowlist de IP opcional y verificación de tenant autorizado.
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const fs = require('fs');
const { pool } = require('../database');

const EXPECTED_AUD = 'sync-diagnostics-admin';
let PUBLIC_KEY = null;

function loadPublicKey() {
    if (PUBLIC_KEY) return PUBLIC_KEY;
    const p = process.env.SUPER_ADMIN_PUBLIC_KEY_PATH;
    if (!p) throw new Error('SUPER_ADMIN_PUBLIC_KEY_PATH not set');
    PUBLIC_KEY = fs.readFileSync(p, 'utf8');
    return PUBLIC_KEY;
}

module.exports = async function superAdminAuth(req, res, next) {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'missing_token' });

        const allow = (process.env.SUPER_ADMIN_IP_ALLOWLIST || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        if (allow.length > 0 && !allow.includes(req.ip)) {
            return res.status(403).json({ error: 'ip_not_allowed' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, loadPublicKey(), {
                algorithms: ['RS256'],
                audience: EXPECTED_AUD
            });
        } catch (e) {
            return res.status(401).json({ error: 'invalid_super_admin_token' });
        }

        if (decoded.role !== 'super_admin') {
            return res.status(401).json({ error: 'not_super_admin' });
        }

        const rev = await pool.query(
            'SELECT 1 FROM super_admin_jwt_revocations WHERE jti = $1',
            [decoded.jti]
        );
        if (rev.rowCount > 0) {
            return res.status(401).json({ error: 'token_revoked' });
        }

        const requestedTenant = Number(req.body?.tenantId ?? req.query?.tenantId);
        if (requestedTenant) {
            const authorized = Array.isArray(decoded.authorizedTenants) &&
                decoded.authorizedTenants.includes(requestedTenant);
            if (!authorized) {
                return res.status(403).json({ error: 'tenant_not_authorized' });
            }
        }

        req.superAdmin = {
            userId: decoded.sub,
            authorizedTenants: decoded.authorizedTenants || [],
            jti: decoded.jti
        };
        next();
    } catch (e) {
        console.error('[superAdminAuth] unexpected', e);
        res.status(500).json({ error: 'auth_error' });
    }
};
