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
const { notifySuperadmins } = require('../utils/superadminNotifier');

// Días en los que se envía notificación (negativos = ya venció)
const NOTIFY_AT_DAYS = [14, 7, 3, 1, 0, -3];

const SUMMARY_STATE_KEY = 'license_expiry_last_summary_date';

let systemStateTableReady = false;

async function ensureSystemStateTable() {
    if (systemStateTableReady) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS system_state (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    systemStateTableReady = true;
}

async function readSystemState(key) {
    await ensureSystemStateTable();
    const { rows } = await pool.query(
        'SELECT value FROM system_state WHERE key = $1',
        [key]
    );
    return rows.length > 0 ? rows[0].value : null;
}

async function writeSystemState(key, value) {
    await ensureSystemStateTable();
    await pool.query(`
        INSERT INTO system_state (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [key, value]);
}

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

        // Resumen diario al SuperAdmin (push FCM)
        await sendSuperadminSummary(now).catch(err =>
            console.error('[LicenseExpiry] Error en resumen SuperAdmin:', err.message)
        );
    } catch (err) {
        console.error('[LicenseExpiry] Error general:', err.message);
    }
}

/**
 * Envía un push diario al SuperAdmin con el conteo de licencias en
 * estado crítico. Dedup por día UTC para evitar duplicados (el job
 * corre cada 12h).
 */
async function sendSuperadminSummary(now) {
    const todayKey = now.toISOString().slice(0, 10); // YYYY-MM-DD UTC

    // Dedup: sobrevive a restarts (in-memory + DB)
    const lastSentDate = await readSystemState(SUMMARY_STATE_KEY).catch(() => null);
    if (lastSentDate === todayKey) return;

    const { rows } = await pool.query(`
        SELECT
            COUNT(*) FILTER (WHERE trial_ends_at < NOW()) AS expired,
            COUNT(*) FILTER (WHERE trial_ends_at >= NOW()
                              AND trial_ends_at <  NOW() + INTERVAL '7 days') AS expiring_7d,
            COUNT(*) FILTER (WHERE trial_ends_at >= NOW() + INTERVAL '7 days'
                              AND trial_ends_at <  NOW() + INTERVAL '14 days') AS expiring_14d
        FROM tenants
        WHERE is_active = TRUE AND trial_ends_at IS NOT NULL
    `);

    const expired    = Number(rows[0].expired)      || 0;
    const expiring7  = Number(rows[0].expiring_7d)  || 0;
    const expiring14 = Number(rows[0].expiring_14d) || 0;

    if (expired === 0 && expiring7 === 0 && expiring14 === 0) {
        await writeSystemState(SUMMARY_STATE_KEY, todayKey).catch(() => {});
        return;
    }

    const parts = [];
    if (expired   > 0) parts.push(`${expired} vencida${expired === 1 ? '' : 's'}`);
    if (expiring7 > 0) parts.push(`${expiring7} esta semana`);
    if (expiring14 > 0) parts.push(`${expiring14} en 8-14 días`);

    await notifySuperadmins(
        '⏰ Licencias por expirar',
        parts.join(' · '),
        {
            type: 'license_expiry_summary',
            expired,
            expiring_7d: expiring7,
            expiring_14d: expiring14,
        }
    );

    await writeSystemState(SUMMARY_STATE_KEY, todayKey).catch(() => {});
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
