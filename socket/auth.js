// ═══════════════════════════════════════════════════════════════
// SOCKET.IO AUTHENTICATION MIDDLEWARE
// Validates JWT token on connection
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = function setupSocketAuth(io) {
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token;
        if (!token) {
            console.warn(`[Socket.IO Auth] ❌ Connection rejected: no token from ${socket.id}`);
            return next(new Error('Token requerido'));
        }

        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) {
                console.warn(`[Socket.IO Auth] ❌ Connection rejected: invalid token from ${socket.id}`);
                return next(new Error('Token inválido o expirado'));
            }
            socket.user = user;
            socket.authenticated = true;
            console.log(`[Socket.IO Auth] ✅ Authenticated: tenant=${user.tenantId}, branch=${user.branchId}`);
            next();
        });
    });
};
