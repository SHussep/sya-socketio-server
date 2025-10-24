// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE: Autenticación de Administrador
// Protege endpoints sensibles de administración
// ═══════════════════════════════════════════════════════════════

/**
 * Middleware que requiere credenciales de administrador
 * Usa variable de entorno ADMIN_PASSWORD para verificación
 *
 * Uso:
 * app.get('/api/database/view', requireAdminCredentials, handler);
 *
 * Cliente debe enviar:
 * - En body: { admin_password: "..." }
 * - O en query: ?admin_password=...
 */
const requireAdminCredentials = (req, res, next) => {
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
        console.error('[Security] ❌ ADMIN_PASSWORD no está configurada');
        return res.status(500).json({
            success: false,
            error: 'ADMIN_PASSWORD no está configurada en el servidor'
        });
    }

    // Obtener password desde body o query
    const providedPassword = req.body?.admin_password || req.query?.admin_password;

    if (!providedPassword) {
        console.warn('[Security] ⚠️ Intento de acceso sin credenciales admin');
        return res.status(401).json({
            success: false,
            error: 'Credenciales de administrador requeridas'
        });
    }

    if (providedPassword !== adminPassword) {
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
