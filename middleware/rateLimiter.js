// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE: Rate Limiting
// Previene ataques de fuerza bruta y abuso de API
// ═══════════════════════════════════════════════════════════════

// Almacenamiento en memoria para intentos
// En produccion con multiples instancias, usar Redis
const loginAttempts = new Map();
const syncAttempts = new Map();
const superadminAttempts = new Map();

// Configuracion
const LOGIN_CONFIG = {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,   // 15 minutos
    lockoutMs: 30 * 60 * 1000,  // 30 minutos de bloqueo
};

const SYNC_CONFIG = {
    maxAttempts: 100,
    windowMs: 60 * 1000,  // 1 minuto
    lockoutMs: 5 * 60 * 1000,  // 5 minutos de bloqueo
};

const SUPERADMIN_CONFIG = {
    maxAttempts: 3,
    windowMs: 15 * 60 * 1000,   // 15 minutos
    lockoutMs: 60 * 60 * 1000,  // 1 hora de bloqueo
};

/**
 * Limpia registros expirados periodicamente
 */
function cleanupExpiredRecords() {
    const now = Date.now();

    for (const [key, record] of loginAttempts.entries()) {
        if (record.lockedUntil && record.lockedUntil < now) {
            loginAttempts.delete(key);
        } else if (now - record.firstAttempt > LOGIN_CONFIG.windowMs * 2) {
            loginAttempts.delete(key);
        }
    }

    for (const [key, record] of syncAttempts.entries()) {
        if (record.lockedUntil && record.lockedUntil < now) {
            syncAttempts.delete(key);
        } else if (now - record.firstAttempt > SYNC_CONFIG.windowMs * 2) {
            syncAttempts.delete(key);
        }
    }

    for (const [key, record] of superadminAttempts.entries()) {
        if (record.lockedUntil && record.lockedUntil < now) {
            superadminAttempts.delete(key);
        } else if (now - record.firstAttempt > SUPERADMIN_CONFIG.windowMs * 2) {
            superadminAttempts.delete(key);
        }
    }
}

// Ejecutar limpieza cada 5 minutos
setInterval(cleanupExpiredRecords, 5 * 60 * 1000);

/**
 * Rate limiter para endpoints de login
 * Limita por IP
 */
function loginRateLimiter(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();

    let record = loginAttempts.get(ip);

    if (!record) {
        record = { count: 0, firstAttempt: now };
    }

    // Verificar si esta bloqueado
    if (record.lockedUntil && record.lockedUntil > now) {
        const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
        console.warn(`[RateLimit] IP bloqueada: ${ip}, remaining: ${remainingSeconds}s`);
        return res.status(429).json({
            success: false,
            message: `Demasiados intentos. Intente de nuevo en ${Math.ceil(remainingSeconds / 60)} minutos.`,
            retryAfter: remainingSeconds
        });
    }

    // Resetear ventana si expiro
    if (now - record.firstAttempt > LOGIN_CONFIG.windowMs) {
        record = { count: 0, firstAttempt: now };
    }

    record.count++;

    // Bloquear si excede intentos
    if (record.count > LOGIN_CONFIG.maxAttempts) {
        record.lockedUntil = now + LOGIN_CONFIG.lockoutMs;
        loginAttempts.set(ip, record);
        console.warn(`[RateLimit] IP bloqueada por exceso de intentos: ${ip}`);
        return res.status(429).json({
            success: false,
            message: 'Cuenta bloqueada temporalmente por seguridad. Intente en 30 minutos.',
            retryAfter: LOGIN_CONFIG.lockoutMs / 1000
        });
    }

    loginAttempts.set(ip, record);

    // Adjuntar funcion para limpiar en login exitoso
    req.clearLoginAttempts = () => loginAttempts.delete(ip);

    next();
}

/**
 * Rate limiter para endpoints de sync
 * Limita por terminal_id + tenant_id
 */
function syncRateLimiter(req, res, next) {
    const terminal_id = req.body?.terminal_id || req.body?.terminalId || 'unknown';
    const tenant_id = req.body?.tenant_id || req.body?.tenantId || 'unknown';
    const key = `${tenant_id}:${terminal_id}`;
    const now = Date.now();

    let record = syncAttempts.get(key);

    if (!record) {
        record = { count: 0, firstAttempt: now };
    }

    // Verificar bloqueo
    if (record.lockedUntil && record.lockedUntil > now) {
        const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
        return res.status(429).json({
            success: false,
            message: 'Demasiadas solicitudes de sync. Espere unos minutos.',
            retryAfter: remainingSeconds
        });
    }

    // Resetear ventana
    if (now - record.firstAttempt > SYNC_CONFIG.windowMs) {
        record = { count: 0, firstAttempt: now };
    }

    record.count++;

    if (record.count > SYNC_CONFIG.maxAttempts) {
        record.lockedUntil = now + SYNC_CONFIG.lockoutMs;
        syncAttempts.set(key, record);
        console.warn(`[RateLimit] Sync bloqueado: ${key}`);
        return res.status(429).json({
            success: false,
            message: 'Demasiadas solicitudes de sync.',
            retryAfter: SYNC_CONFIG.lockoutMs / 1000
        });
    }

    syncAttempts.set(key, record);
    next();
}

/**
 * Rate limiter para endpoints de superadmin
 * Limita por IP - muy agresivo: 3 intentos, 1 hora de bloqueo
 */
function superadminRateLimiter(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();

    let record = superadminAttempts.get(ip);

    if (!record) {
        record = { count: 0, firstAttempt: now };
    }

    // Verificar si esta bloqueado
    if (record.lockedUntil && record.lockedUntil > now) {
        const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
        console.warn(`[RateLimit] SuperAdmin IP bloqueada: ${ip}, remaining: ${remainingSeconds}s`);
        return res.status(429).json({
            success: false,
            message: `Demasiados intentos fallidos. Bloqueado por ${Math.ceil(remainingSeconds / 60)} minutos.`,
            retryAfter: remainingSeconds
        });
    }

    // Resetear ventana si expiro
    if (now - record.firstAttempt > SUPERADMIN_CONFIG.windowMs) {
        record = { count: 0, firstAttempt: now };
    }

    superadminAttempts.set(ip, record);

    // Guardar funcion para registrar intento fallido (se llama desde el middleware de auth)
    req.registerFailedSuperadminAttempt = () => {
        record.count++;
        if (record.count >= SUPERADMIN_CONFIG.maxAttempts) {
            record.lockedUntil = now + SUPERADMIN_CONFIG.lockoutMs;
            console.warn(`[RateLimit] SuperAdmin IP bloqueada por exceso de intentos: ${ip}`);
        }
        superadminAttempts.set(ip, record);
    };

    // Limpiar en auth exitoso
    req.clearSuperadminAttempts = () => superadminAttempts.delete(ip);

    next();
}

/**
 * Limpia intentos de login para una IP especifica
 * Llamar despues de un login exitoso
 */
function clearLoginAttempts(ip) {
    loginAttempts.delete(ip);
}

/**
 * Obtiene estadisticas de rate limiting (para debugging)
 */
function getRateLimitStats() {
    return {
        loginAttempts: loginAttempts.size,
        syncAttempts: syncAttempts.size
    };
}

module.exports = {
    loginRateLimiter,
    syncRateLimiter,
    superadminRateLimiter,
    clearLoginAttempts,
    getRateLimitStats
};
