// ═══════════════════════════════════════════════════════════════════
// License Gate (v1.3.1 simplificado)
// ═══════════════════════════════════════════════════════════════════
//
// Modelo: cada sucursal tiene su propio branch_license independiente.
// SIN switch global por tenant.subscription_status.
//
// Para cada branch al login:
//   1. Buscar branch_licenses activa de esa branch
//      → existe + vigente → OK (scope='branch')
//      → existe + vencida → 403 BRANCH_LICENSE_EXPIRED
//      → no existe → fallback a tenant.trial_ends_at (safety net por si
//                    backfill aún no corre para una branch nueva, o por
//                    legacy mobile login sin branchId)
//
// La migración 060 garantiza que cada branch existente tenga una
// branch_license heredada de tenant.trial_ends_at, por lo que el
// fallback es excepcional (branches creadas entre deploys o flujos
// no-branch como mobileLogin).
// ═══════════════════════════════════════════════════════════════════

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * @returns {Promise<{
 *     ok: boolean,
 *     scope: 'branch'|'trial',
 *     error?: string,
 *     message?: string,
 *     expiresAt?: string|null,
 *     daysRemaining?: number|null,
 *     daysExpired?: number,
 *     licenseId?: number,
 *     isTrial?: boolean
 * }>}
 */
async function evaluateLicense(pool, tenant, branchId) {
    const now = new Date();

    // Flujos sin branchId (ej. mobileLogin clásico): pass-through con
    // tenant.trial_ends_at. Las acciones del POS validan per-branch en cada request.
    if (!branchId) {
        const trialEnds = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
        if (trialEnds && trialEnds < now) {
            return {
                ok: false,
                error: 'LICENSE_EXPIRED',
                scope: 'trial',
                expiresAt: trialEnds.toISOString(),
                daysExpired: Math.ceil((now - trialEnds) / MS_PER_DAY),
                message: 'Su licencia ha caducado. Contacta a soporte para renovar.'
            };
        }
        return {
            ok: true,
            scope: 'trial',
            expiresAt: trialEnds ? trialEnds.toISOString() : null,
            daysRemaining: trialEnds ? Math.ceil((trialEnds - now) / MS_PER_DAY) : null
        };
    }

    // Path principal: branch tiene su propia licencia.
    // ORDER BY blinda contra duplicados: si quedan dos rows activas para la misma branch
    // (al reactivar sin desactivar la previa), gana la de fecha más lejana — y NULL
    // (perpetua) gana sobre cualquier fecha. id DESC desempata por la más recientemente creada.
    const { rows } = await pool.query(
        `SELECT id, expires_at, granted_by FROM branch_licenses
         WHERE branch_id = $1 AND status = 'active'
         ORDER BY expires_at DESC NULLS FIRST, id DESC
         LIMIT 1`,
        [branchId]
    );

    if (rows.length === 0) {
        // Safety net: la migración 060 debería haber backfilleado esto.
        // Si no existe row para esta branch, caemos a tenant.trial_ends_at
        // como compatibilidad, así branches nuevas creadas entre deploys
        // no se bloquean.
        const trialEnds = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
        if (trialEnds && trialEnds > now) {
            return {
                ok: true,
                scope: 'trial',
                expiresAt: trialEnds.toISOString(),
                daysRemaining: Math.ceil((trialEnds - now) / MS_PER_DAY),
                isTrial: true
            };
        }
        return {
            ok: false,
            error: 'BRANCH_NO_LICENSE',
            scope: 'branch',
            message: 'Esta sucursal no tiene una licencia activa. Contacta a soporte.'
        };
    }

    const lic = rows[0];
    const exp = lic.expires_at ? new Date(lic.expires_at) : null;

    if (exp && exp < now) {
        return {
            ok: false,
            error: 'BRANCH_LICENSE_EXPIRED',
            scope: 'branch',
            expiresAt: exp.toISOString(),
            daysExpired: Math.ceil((now - exp) / MS_PER_DAY),
            licenseId: lic.id,
            message: 'La licencia de esta sucursal expiró. Contacta a soporte para renovarla.'
        };
    }

    return {
        ok: true,
        scope: 'branch',
        licenseId: lic.id,
        expiresAt: exp ? exp.toISOString() : null,
        daysRemaining: exp ? Math.ceil((exp - now) / MS_PER_DAY) : null,
        isTrial: lic.granted_by === 'system'
    };
}

function licenseGateErrorResponse(gate, businessName) {
    return {
        success: false,
        message: gate.message || 'Licencia inválida',
        error: gate.error || 'LICENSE_ERROR',
        licenseInfo: {
            expiresAt: gate.expiresAt ?? null,
            daysExpired: gate.daysExpired ?? null,
            scope: gate.scope,
            licenseId: gate.licenseId ?? null,
            businessName
        }
    };
}

function buildLicenseBlock(gate) {
    const days = gate.daysRemaining;
    let status;
    if (days === null || days === undefined) status = 'unlimited';
    else if (days < 0) status = 'expired';
    else if (days <= 7) status = 'expiring_soon';
    else status = 'active';

    return {
        expiresAt: gate.expiresAt ?? null,
        daysRemaining: days ?? null,
        scope: gate.scope,
        licenseId: gate.licenseId ?? null,
        isTrial: gate.isTrial ?? false,
        status
    };
}

module.exports = {
    evaluateLicense,
    licenseGateErrorResponse,
    buildLicenseBlock
};
