const AuthController = require('../controllers/authController');

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

    // Debug
    router.get('/debug-employee/:email', bind(authController.debugEmployee));

    // Login
    router.post('/desktop-login', bind(authController.desktopLogin));
    router.post('/mobile-login', bind(authController.mobileLogin));
    router.post('/refresh-token', bind(authController.refreshToken));

    // Google Auth
    router.post('/google-signup', bind(authController.googleSignup));
    router.post('/google-login', bind(authController.googleLogin));

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

    // Middleware: Verificar JWT Token
    // Se adjunta al router para mantener compatibilidad con el código existente
    router.authenticateToken = bind(authController.authenticateToken);

    return router;
};
