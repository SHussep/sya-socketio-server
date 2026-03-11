// ═══════════════════════════════════════════════════════════
// JOB: License Expiry Notifier
// Corre cada 24h. Envía emails al owner cuando:
//   - 14 días antes de vencer
//   - 7 días antes de vencer
//   - 3 días antes de vencer
//   - 1 día antes de vencer
//   - El día que vence
//   - 3 días después de vencido (último aviso)
// ═══════════════════════════════════════════════════════════

const { rawPool: pool } = require('../database/pool');
const { sendLicenseExpiryEmail } = require('../utils/licenseExpiryEmail');

// Días en los que se envía notificación (negativos = ya venció)
const NOTIFY_AT_DAYS = [14, 7, 3, 1, 0, -3];

/**
 * Procesa todos los tenants activos y envía avisos de vencimiento si corresponde.
 */
async function processLicenseExpiryNotifications() {
    try {
        // Buscar tenants con fechas de vencimiento
        const { rows: tenants } = await pool.query(`
            SELECT t.id, t.business_name, t.email AS tenant_email,
                   t.subscription_status, t.trial_ends_at,
                   t.license_expiry_last_notified_at, t.license_expiry_last_days_notified
            FROM tenants t
            WHERE t.is_active = true
              AND t.trial_ends_at IS NOT NULL
        `);

        if (tenants.length === 0) return;

        const now = new Date();

        for (const tenant of tenants) {
            try {
                await checkAndNotifyTenant(tenant, now);
            } catch (err) {
                console.error(`[LicenseExpiry] Error procesando tenant ${tenant.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[LicenseExpiry] Error general:', err.message);
    }
}

async function checkAndNotifyTenant(tenant, now) {
    // Determinar fecha de vencimiento y tipo
    const isTrial = tenant.subscription_status === 'trial';
    const expiryDate = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;

    if (!expiryDate) return;

    // Calcular días restantes
    const diffMs = expiryDate.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    // Encontrar el checkpoint más cercano para notificar
    const checkpoint = NOTIFY_AT_DAYS.find(d => daysRemaining <= d && daysRemaining > d - 1);
    if (checkpoint === undefined) {
        // No estamos en ningún checkpoint
        // Pero si ya venció hace más de 3 días, no seguir notificando
        return;
    }

    // Verificar si ya notificamos en este checkpoint
    const lastNotifiedDays = tenant.license_expiry_last_days_notified;
    if (lastNotifiedDays !== null && lastNotifiedDays !== undefined && lastNotifiedDays === checkpoint) {
        return; // Ya se envió para este checkpoint
    }

    // Buscar owner email
    const { rows: owners } = await pool.query(`
        SELECT e.id, e.first_name, e.last_name, e.email
        FROM employees e
        WHERE e.tenant_id = $1
          AND e.is_owner = true
          AND e.is_active = true
          AND e.email IS NOT NULL AND e.email != ''
        LIMIT 1
    `, [tenant.id]);

    const ownerEmail = owners.length > 0 ? owners[0].email : tenant.tenant_email;
    if (!ownerEmail) return;

    const ownerName = owners.length > 0
        ? `${owners[0].first_name || ''} ${owners[0].last_name || ''}`.trim() || 'Propietario'
        : 'Propietario';

    const formattedExpiry = formatDate(expiryDate);

    const sent = await sendLicenseExpiryEmail({
        to: ownerEmail,
        ownerName,
        businessName: tenant.business_name,
        daysRemaining: Math.max(daysRemaining, 0),
        expiryDate: formattedExpiry,
        isTrial
    });

    if (sent) {
        console.log(`[LicenseExpiry] ✅ Email enviado a ${ownerEmail} (${tenant.business_name}): ${daysRemaining} días restantes`);

        // Registrar que se notificó
        await pool.query(`
            UPDATE tenants
            SET license_expiry_last_notified_at = NOW(),
                license_expiry_last_days_notified = $2
            WHERE id = $1
        `, [tenant.id, checkpoint]);
    }
}

function formatDate(date) {
    const d = date.getDate().toString().padStart(2, '0');
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const y = date.getFullYear();
    return `${d}/${m}/${y}`;
}

module.exports = { processLicenseExpiryNotifications };
