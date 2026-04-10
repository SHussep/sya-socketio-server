// ═══════════════════════════════════════════════════════════════
// SOCKET.IO AUTHENTICATION MIDDLEWARE
// Validates JWT token on connection
// Resolves employeeGlobalId → correct PG employeeId (fixes stale JWT)
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
const { pool } = require('../database');

module.exports = function setupSocketAuth(io) {
    io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token;
        if (!token) {
            console.warn(`[Socket.IO Auth] ❌ Connection rejected: no token from ${socket.id}`);
            return next(new Error('Token requerido'));
        }

        try {
            const user = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
            socket.user = user;
            socket.authenticated = true;

            // Resolve employeeGlobalId → correct PG employeeId (Desktop JWT may have stale ID)
            const employeeGlobalId = socket.handshake.auth?.employeeGlobalId;
            if (employeeGlobalId && user.tenantId) {
                try {
                    const result = await pool.query(
                        'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                        [employeeGlobalId, user.tenantId]
                    );
                    if (result.rows.length > 0) {
                        const resolvedId = result.rows[0].id;
                        if (resolvedId !== user.employeeId) {
                            console.log(`[Socket.IO Auth] ⚠️ JWT employeeId=${user.employeeId} → resolved to ${resolvedId} via globalId=${employeeGlobalId}`);
                            socket.user.employeeId = resolvedId;
                        }
                    }
                } catch (dbErr) {
                    console.warn(`[Socket.IO Auth] ⚠️ Could not resolve employeeGlobalId: ${dbErr.message}`);
                }
            }

            console.log(`[Socket.IO Auth] ✅ Authenticated: tenant=${user.tenantId}, employee=${socket.user.employeeId}, branch=${user.branchId}`);
            next();
        } catch (err) {
            console.warn(`[Socket.IO Auth] ❌ Connection rejected: invalid token from ${socket.id}`);
            return next(new Error('Token inválido o expirado'));
        }
    });
};
