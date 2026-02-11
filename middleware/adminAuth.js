// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE: Autenticación de Administrador
// Protege endpoints sensibles de administración
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

/**
 * Middleware que requiere credenciales de administrador
 * Usa variable de entorno ADMIN_PASSWORD para verificación
 *
 * ✅ SECURITY: Uses timing-safe comparison to prevent timing attacks
 * ✅ SECURITY: Only accepts password from request body (not query string)
 *
 * Uso:
 * app.get('/api/database/view', requireAdminCredentials, handler);
 *
 * Cliente debe enviar:
 * - En body: { admin_password: "..." }
 */
const requireAdminCredentials = (req, res, next) => {
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
        console.error('[Security] ❌ ADMIN_PASSWORD no está configurada');
        return res.status(500).json({
            success: false,
            error: 'Configuración del servidor incompleta'
        });
    }

    // ✅ SECURITY: Only accept password from body, NOT from query string
    // Query strings are logged in server access logs, browser history, and proxy logs
    const providedPassword = req.body?.admin_password;

    if (!providedPassword) {
        return res.status(401).json({
            success: false,
            error: 'Credenciales de administrador requeridas'
        });
    }

    // ✅ SECURITY: Timing-safe comparison prevents timing attacks
    // Plain !== comparison leaks password length and character matches via response timing
    const expected = Buffer.from(String(adminPassword));
    const provided = Buffer.from(String(providedPassword));

    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
        console.warn('[Security] ⚠️ Intento de acceso con credenciales admin INVÁLIDAS');
        return res.status(403).json({
            success: false,
            error: 'Credenciales de administrador inválidas'
        });
    }

    console.log('[Security] ✅ Acceso admin autorizado');
    next();
};

module.exports = { requireAdminCredentials };
