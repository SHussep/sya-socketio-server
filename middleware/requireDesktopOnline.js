// ═══════════════════════════════════════════════════════════════════════════
// requireDesktopOnline.js
// ═══════════════════════════════════════════════════════════════════════════
// Middleware que bloquea operaciones críticas si el desktop (caja principal)
// de la sucursal NO está conectado al Socket.IO server.
//
// Complemento del offline-first: en single-caja el desktop es la fuente de
// verdad local. Si el móvil (u otro cliente) edita datos sensibles mientras
// el desktop está offline, al reconectar el desktop sobrescribirá esos cambios
// desde su SQLite local. Mejor rechazar de entrada con 423 Locked.
//
// Se considera que un desktop está online si existe al menos un socket con
// `clientType === 'desktop'` y `branchId === <branch>` en `io.sockets.sockets`.
//
// Resolución del branchId (en orden):
//   1. req.body.branch_id / branchId
//   2. req.params.branchId
//   3. req.query.branchId / branch_id
//   4. req.auth.branchId (del JWT via authMiddleware)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Retorna true si al menos un socket desktop está conectado para la branch dada.
 */
function isDesktopOnlineForBranch(io, branchId) {
    if (!io || !branchId) return false;
    const target = parseInt(branchId);
    if (!Number.isFinite(target) || target <= 0) return false;

    for (const [, socket] of io.sockets.sockets) {
        if (socket.clientType === 'desktop' && parseInt(socket.branchId) === target) {
            return true;
        }
    }
    return false;
}

/**
 * Middleware Express. Bloquea con 423 si el desktop está offline.
 *
 * @param {object} [opts]
 * @param {string} [opts.action]  Descripción de la operación (para el mensaje de error).
 * @param {function} [opts.resolveBranchId]  (req) => branchId.  Default: intenta body/params/query/auth.
 */
function requireDesktopOnline(opts = {}) {
    const { action = 'esta operación', resolveBranchId } = opts;

    return async function (req, res, next) {
        const io = req.app.get('io');
        if (!io) {
            console.error('[requireDesktopOnline] io no está en app.get("io") — permitiendo pero revisa config');
            return next();
        }

        let branchId = null;
        try {
            if (resolveBranchId) {
                const maybe = resolveBranchId(req);
                branchId = maybe && typeof maybe.then === 'function' ? await maybe : maybe;
            } else {
                branchId = _defaultResolveBranchId(req);
            }
        } catch (e) {
            console.error('[requireDesktopOnline] error resolviendo branchId:', e.message);
        }

        if (!branchId) {
            console.warn('[requireDesktopOnline] ⚠️ No se pudo resolver branchId — permitiendo (fallback conservador)');
            return next();
        }

        if (isDesktopOnlineForBranch(io, branchId)) {
            return next();
        }

        console.warn(`[requireDesktopOnline] 🔒 423 Locked: desktop offline para branch=${branchId}, action="${action}", endpoint=${req.method} ${req.originalUrl}`);
        return res.status(423).json({
            error: 'DESKTOP_OFFLINE',
            message: `El equipo principal (caja) debe estar conectado a internet para ${action}. Intenta de nuevo cuando esté en línea.`,
            branchId: branchId,
        });
    };
}

function _defaultResolveBranchId(req) {
    const candidates = [
        req.body?.branch_id,
        req.body?.branchId,
        req.params?.branchId,
        req.params?.branch_id,
        req.query?.branchId,
        req.query?.branch_id,
        req.user?.branchId,
        req.user?.branch_id,
        req.auth?.branchId,
        req.auth?.branch_id,
    ];
    for (const v of candidates) {
        if (v != null && v !== '') {
            const n = parseInt(v);
            if (Number.isFinite(n) && n > 0) return n;
        }
    }
    return null;
}

module.exports = requireDesktopOnline;
module.exports.isDesktopOnlineForBranch = isDesktopOnlineForBranch;
