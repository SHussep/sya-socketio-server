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

    // Force takeover via REST (fallback when Socket.IO is not connected)
    router.post('/force-takeover', loginRateLimiter, async (req, res) => {
        try {
            const { employeeId, terminalId } = req.body;
            if (!employeeId) {
                return res.status(400).json({ success: false, error: 'employeeId required' });
            }

            const forceEmployeeIdInt = parseInt(employeeId, 10);
            const callerType = terminalId?.startsWith('mobile-') ? 'mobile' : 'desktop';
            console.log(`[Auth] 🔄 REST force-takeover for employee ${forceEmployeeIdInt} (terminal: ${terminalId || 'unknown'})`);

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Lock the active shift row
                const shiftResult = await client.query(
                    `SELECT id, terminal_id, last_heartbeat, branch_id
                     FROM shifts
                     WHERE employee_id = $1 AND is_cash_cut_open = true
                     FOR UPDATE`,
                    [forceEmployeeIdInt]
                );

                const activeShift = shiftResult.rows[0];

                // Mark employee as revoked so the old device gets kicked on reconnect
                const revokedDeviceType = activeShift?.terminal_id?.startsWith('mobile-') ? 'mobile' : 'desktop';
                await client.query(
                    `UPDATE employees SET session_revoked_at = NOW(), session_revoked_for_device = $2
                     WHERE id = $1`,
                    [forceEmployeeIdInt, revokedDeviceType]
                );

                // Transfer shift ownership to the new device
                if (terminalId && activeShift) {
                    await client.query(
                        'UPDATE shifts SET terminal_id = $2, last_heartbeat = NOW() WHERE id = $1',
                        [activeShift.id, terminalId]
                    );
                    console.log(`[Auth] 📝 Shift ${activeShift.id} terminal_id → ${terminalId}`);
                }

                await client.query('COMMIT');

                // Try to kick via Socket.IO if io is available
                let kickedCount = 0;
                const ioInstance = req.app.get('io');
                if (ioInstance) {
                    const forceLogoutPayload = {
                        reason: 'session_taken',
                        takenByDevice: callerType,
                        message: 'Tu sesión fue tomada por otro dispositivo'
                    };
                    for (const [sid, s] of ioInstance.sockets.sockets) {
                        if (parseInt(s.user?.employeeId, 10) === forceEmployeeIdInt) {
                            s.emit('force_logout', forceLogoutPayload);
                            kickedCount++;
                        }
                    }
                    // Broadcast to branch room as safety net
                    if (activeShift?.branch_id) {
                        ioInstance.to(`branch_${activeShift.branch_id}`).emit('force_logout', {
                            ...forceLogoutPayload,
                            targetEmployeeId: forceEmployeeIdInt
                        });
                    }
                }

                console.log(`[Auth] ✅ REST force-takeover success (kicked=${kickedCount}, revoked=${revokedDeviceType})`);
                res.json({ success: true, wasOnline: kickedCount > 0 });
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                throw err;
            } finally {
                client.release();
            }
        } catch (err) {
            console.error('[Auth] force-takeover error:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Middleware: Verificar JWT Token
    // Se adjunta al router para mantener compatibilidad con el código existente
    router.authenticateToken = bind(authController.authenticateToken);

    return router;
};
