// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE: superAdminAuthOrPIN
// Accepts EITHER:
//   1. RS256 JWT via Authorization: Bearer <token>  (CLI tools)
//   2. Super-admin PIN via X-Admin-PIN header        (SYAAdmin app)
// Populates req.superAdmin for downstream route handlers.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const superAdminAuth = require('./superAdminAuth');

const SUPER_ADMIN_PIN_HASH = process.env.SUPER_ADMIN_PIN_HASH;

module.exports = async function superAdminAuthOrPIN(req, res, next) {
    // Path 1: Bearer token present → delegate to RS256 JWT middleware
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
        return superAdminAuth(req, res, next);
    }

    // Path 2: X-Admin-PIN header → SHA-256 PIN verification
    const pin = req.body?.adminPin || req.headers['x-admin-pin'];
    if (!pin) {
        return res.status(401).json({
            error: 'missing_credentials',
            message: 'Provide Authorization: Bearer <JWT> or X-Admin-PIN header'
        });
    }

    if (!SUPER_ADMIN_PIN_HASH) {
        return res.status(503).json({ error: 'superadmin_not_configured' });
    }

    const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(pinHash), Buffer.from(SUPER_ADMIN_PIN_HASH))) {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        console.warn(`[superAdminAuthOrPIN] PIN incorrecto desde IP: ${ip}`);
        return res.status(403).json({ error: 'invalid_pin' });
    }

    // PIN is global super-admin → authorize all tenants
    req.superAdmin = {
        userId: 'pin-auth',
        authorizedTenants: ['*'],
        jti: null
    };
    next();
};
