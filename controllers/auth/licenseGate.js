// ═══════════════════════════════════════════════════════════════════
// License Gate (v1.3.1)
// ═══════════════════════════════════════════════════════════════════
//
// Convivencia entre dos modelos de licencia:
//
//   subscription_status = 'trial'    → gate clásico (tenant.trial_ends_at)
//   subscription_status = 'active'   → gate por sucursal (branch_licenses.expires_at)
//   subscription_status = 'expired'  → bloqueo total
//   subscription_status = 'cancelled' → bloqueo total
//
// El switch de trial → active es manual desde SuperAdmin via
// POST /api/superadmin/tenants/:id/promote-to-active.
//
// Uso típico (después de seleccionar la branch, no antes):
//
//   const gate = await evaluateLicense(this.pool, tenant, selectedBranch.id);
//   if (!gate.ok) {
//       return res.status(403).json(licenseGateErrorResponse(gate, tenant.business_name));
//   }
//   const licenseBlock = buildLicenseBlock(gate);
//   res.json({ ..., tenant: { license: licenseBlock }, branch: { ..., license: licenseBlock } });
// ═══════════════════════════════════════════════════════════════════

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Evalúa si la licencia para (tenant, branch) está vigente.
 *
 * @param {Pool} pool   pg pool
 * @param {Object} tenant   row de tenants con id, subscription_status, trial_ends_at
 * @param {number|null} branchId   id de la branch seleccionada (puede ser null en flujos no-branch)
 * @returns {Promise<{
 *     ok: boolean,
 *     scope: 'tenant'|'branch',
 *     error?: string,
 *     message?: string,
 *     expiresAt?: string|null,
 *     daysRemaining?: number|null,
 *     daysExpired?: number,
 *     licenseId?: number
 * }>}
 */
async function evaluateLicense(pool, tenant, branchId) {
    const now = new Date();
    const trialEnds = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
    const status = tenant.subscription_status;

    // ── Path A: tenant en trial ──────────────────────────────────────────
    if (status === 'trial' || !status) {
        if (trialEnds && trialEnds < now) {
            return {
                ok: false,
                error: 'LICENSE_EXPIRED',
                scope: 'tenant',
                expiresAt: trialEnds.toISOString(),
                daysExpired: Math.ceil((now - trialEnds) / MS_PER_DAY),
                message: 'Su licencia ha caducado. Por favor, contacte con soporte para renovar.'
            };
        }
        return {
            ok: true,
            scope: 'tenant',
            expiresAt: trialEnds ? trialEnds.toISOString() : null,
            daysRemaining: trialEnds
                ? Math.ceil((trialEnds - now) / MS_PER_DAY)
                : null
        };
    }

    // ── Path B: tenant suspendido/cancelado ──────────────────────────────
    if (status === 'expired' || status === 'cancelled') {
        return {
            ok: false,
            error: 'SUBSCRIPTION_INACTIVE',
            scope: 'tenant',
            message: status === 'cancelled'
                ? 'Tu suscripción fue cancelada. Contacta a soporte.'
                : 'Tu suscripción está expirada. Contacta a soporte para renovar.'
        };
    }

    // ── Path C: tenant 'active' → buscar branch_license ──────────────────
    if (!branchId) {
        // Llamada sin branch (flujo no-branch). En ese caso devolvemos OK
        // con scope tenant para no romper login mobile que no selecciona
        // branch en el handshake. La autoridad real corre en cada acción
        // concreta del POS.
        return {
            ok: true,
            scope: 'tenant',
            expiresAt: trialEnds ? trialEnds.toISOString() : null,
            daysRemaining: trialEnds
                ? Math.ceil((trialEnds - now) / MS_PER_DAY)
                : null
        };
    }

    const { rows } = await pool.query(
        `SELECT id, expires_at FROM branch_licenses
         WHERE tenant_id = $1 AND branch_id = $2 AND status = 'active'
         LIMIT 1`,
        [tenant.id, branchId]
    );

    if (rows.length === 0) {
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
        daysRemaining: exp ? Math.ceil((exp - now) / MS_PER_DAY) : null
    };
}

/**
 * Construye el body 403 de error de licencia.
 * @param {Object} gate    resultado de evaluateLicense (con ok=false)
 * @param {string} businessName
 */
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

/**
 * Construye el bloque "license" para la respuesta de login.
 * Se usa tanto en `tenant.license` como en `branch.license`.
 */
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
        status
    };
}

module.exports = {
    evaluateLicense,
    licenseGateErrorResponse,
    buildLicenseBlock
};
