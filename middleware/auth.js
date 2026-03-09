// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE DE AUTENTICACIÓN - JWT + Superadmin PIN
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
const SUPER_ADMIN_PIN_HASH = process.env.SUPER_ADMIN_PIN_HASH;

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token inválido o expirado' });
        }
        req.user = user;
        next();
    });
}

// ✅ SECURITY: Superadmin PIN middleware for dangerous admin endpoints
function requireSuperAdminPIN(req, res, next) {
    if (!SUPER_ADMIN_PIN_HASH) {
        return res.status(503).json({ success: false, message: 'Superadmin no configurado' });
    }
    const pin = req.headers['x-admin-pin'];
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

module.exports = { authenticateToken, requireSuperAdminPIN };
