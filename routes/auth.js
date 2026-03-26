const AuthController = require('../controllers/auth');
const { loginRateLimiter } = require('../middleware/rateLimiter');

module.exports = function (pool) {
    const router = require('express').Router();
    const authController = new AuthController(pool);

    // Helper to bind methods to the controller instance
    const bind = (method) => method.bind(authController);

    // ═══════════════════════════════════════════════════════════════
    // RUTAS DE AUTENTICACIÓN - Multi-Tenant System
    // ═══════════════════════════════════════════════════════════════

    // Gmail OAuth
    router.get('/gmail/start-oauth', bind(authController.startGmailOAuth));
    router.get('/gmail/oauth-callback', bind(authController.gmailOAuthCallbackPage));
    router.post('/gmail/oauth-callback', bind(authController.exchangeGmailCode));
    router.post('/gmail/refresh-token', bind(authController.refreshGmailToken));

    // Login (con rate limiting para prevenir fuerza bruta)
    router.post('/desktop-login', loginRateLimiter, bind(authController.desktopLogin));
    router.post('/mobile-login', loginRateLimiter, bind(authController.mobileLogin));
    router.post('/refresh-token', bind(authController.refreshToken));

    // Google Auth (con rate limiting)
    router.post('/google-signup', loginRateLimiter, bind(authController.googleSignup));
    router.post('/google-login', loginRateLimiter, bind(authController.googleLogin));

    // Devices
    router.post('/devices/register', bind(authController.registerDevice));

    // Tenant Management
    router.put('/tenants/:id/overwrite', bind(authController.overwriteTenant));

    // Branch Management
    router.delete('/branches/:id/full-wipe', bind(authController.fullWipeBranch));
    router.delete('/branches/:id/wipe', bind(authController.wipeBranch));
    router.post('/check-email', bind(authController.checkEmail));
    router.get('/branches', bind(authController.getBranches));
    router.post('/create-branch', bind(authController.createBranch));
    router.post('/join-existing-branch', bind(authController.joinExistingBranch));
    router.post('/sync-init-after-wipe', bind(authController.syncInitAfterWipe));

    // Employee
    router.get('/tenant/:tenantId/main-employee', bind(authController.getMainEmployee));

    // Verify Admin Password (para reclamar rol de Equipo Principal)
    router.post('/verify-admin-password', loginRateLimiter, bind(authController.verifyAdminPassword));

    // Session conflict check (used by Desktop before session start)
    router.get('/session-conflict', loginRateLimiter, async (req, res) => {
        try {
            const employeeId = parseInt(req.query.employeeId);
            if (!employeeId) {
                return res.status(400).json({ success: false, error: 'employeeId query param required' });
            }
            const terminalId = req.query.terminalId || null; // caller's unique device ID

            const { checkSessionConflict } = require('../controllers/auth/loginMethods');
            const conflict = await checkSessionConflict(employeeId, pool, terminalId);

            res.json({
                success: true,
                ...(conflict || { hasConflict: false })
            });
        } catch (err) {
            console.error('[Auth] session-conflict error:', err.message);
            res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // Middleware: Verificar JWT Token
    // Se adjunta al router para mantener compatibilidad con el código existente
    router.authenticateToken = bind(authController.authenticateToken);

    return router;
};
