// ═══════════════════════════════════════════════════════════
// JOB: Guardian Email Digest
// Corre cada hora, checa qué tenants tienen pendiente un envío
// y manda el resumen al owner del tenant.
// ═══════════════════════════════════════════════════════════

const { rawPool: pool } = require('../database/pool');
const { sendGuardianDigestEmail } = require('../utils/guardianDigestEmail');

const FREQUENCY_INTERVALS = {
    weekly: '7 days',
    biweekly: '14 days',
    monthly: '1 month'
};

const FREQUENCY_LOOKBACK = {
    weekly: '7 days',
    biweekly: '14 days',
    monthly: '30 days'
};

/**
 * Procesa todos los tenants que tienen un digest pendiente.
 * Se llama desde un setInterval en server.js cada hora.
 */
async function processGuardianDigests() {
    try {
        // Buscar tenants que toca enviar
        const { rows: pendingTenants } = await pool.query(`
            SELECT t.id, t.business_name, t.email AS tenant_email,
                   t.email_digest_frequency,
                   t.email_digest_last_sent_at
            FROM tenants t
            WHERE t.is_active = true
              AND t.email_digest_enabled = true
              AND t.email_digest_frequency != 'off'
              AND t.email_digest_next_send_at IS NOT NULL
              AND t.email_digest_next_send_at <= NOW()
        `);

        if (pendingTenants.length === 0) return;

        console.log(`[GuardianDigest] ${pendingTenants.length} tenant(s) pendiente(s) de envío`);

        for (const tenant of pendingTenants) {
            try {
                await processTenantDigest(tenant);
            } catch (err) {
                console.error(`[GuardianDigest] Error procesando tenant ${tenant.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[GuardianDigest] Error general:', err.message);
    }
}

async function processTenantDigest(tenant) {
    const frequency = tenant.email_digest_frequency || 'biweekly';
    const lookback = FREQUENCY_LOOKBACK[frequency] || '14 days';
    const interval = FREQUENCY_INTERVALS[frequency] || '14 days';

    // Buscar el owner del tenant (único con email validado)
    const { rows: owners } = await pool.query(`
        SELECT e.id, e.first_name, e.last_name, e.email
        FROM employees e
        WHERE e.tenant_id = $1
          AND e.is_owner = true
          AND e.is_active = true
          AND e.email IS NOT NULL
          AND e.email != ''
        LIMIT 1
    `, [tenant.id]);

    if (owners.length === 0) {
        // Sin owner con email, usar email del tenant
        if (!tenant.tenant_email) {
            console.log(`[GuardianDigest] Tenant ${tenant.id}: sin email de owner ni tenant, omitiendo`);
            await updateNextSend(tenant.id, interval);
            return;
        }
    }

    const ownerEmail = owners.length > 0 ? owners[0].email : tenant.tenant_email;
    const ownerName = owners.length > 0
        ? `${owners[0].first_name || ''} ${owners[0].last_name || ''}`.trim() || 'Propietario'
        : 'Propietario';

    // Obtener sucursales del tenant
    const { rows: branches } = await pool.query(`
        SELECT id, name FROM branches
        WHERE tenant_id = $1 AND is_active = true
        ORDER BY name
    `, [tenant.id]);

    if (branches.length === 0) {
        await updateNextSend(tenant.id, interval);
        return;
    }

    // Consultar eventos por sucursal en el período
    const branchData = [];
    let grandTotalEvents = 0, grandCritical = 0, grandHigh = 0, grandDisconnections = 0;

    for (const branch of branches) {
        // Eventos sospechosos
        const { rows: [susp] } = await pool.query(`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE severity = 'Critical') AS critical,
                COUNT(*) FILTER (WHERE severity = 'High') AS high
            FROM suspicious_weighing_logs
            WHERE tenant_id = $1 AND branch_id = $2
              AND timestamp >= NOW() - $3::interval
        `, [tenant.id, branch.id, lookback]);

        // Desconexiones
        const { rows: [disc] } = await pool.query(`
            SELECT COUNT(*) AS total
            FROM scale_disconnection_logs
            WHERE tenant_id = $1 AND branch_id = $2
              AND disconnected_at >= NOW() - $3::interval
        `, [tenant.id, branch.id, lookback]);

        const total = parseInt(susp.total) || 0;
        const critical = parseInt(susp.critical) || 0;
        const high = parseInt(susp.high) || 0;
        const disconnections = parseInt(disc.total) || 0;

        branchData.push({
            branchName: branch.name,
            totalEvents: total,
            critical,
            high,
            disconnections
        });

        grandTotalEvents += total;
        grandCritical += critical;
        grandHigh += high;
        grandDisconnections += disconnections;
    }

    // Calcular label del período
    const endDate = new Date();
    const startDate = new Date();
    if (frequency === 'weekly') startDate.setDate(startDate.getDate() - 7);
    else if (frequency === 'biweekly') startDate.setDate(startDate.getDate() - 14);
    else startDate.setDate(startDate.getDate() - 30);

    const periodLabel = `${formatDate(startDate)} - ${formatDate(endDate)}`;

    // Enviar email
    const sent = await sendGuardianDigestEmail({
        to: ownerEmail,
        ownerName,
        businessName: tenant.business_name,
        frequency,
        periodLabel,
        branches: branchData,
        totals: {
            totalEvents: grandTotalEvents,
            critical: grandCritical,
            high: grandHigh,
            disconnections: grandDisconnections
        }
    });

    if (sent) {
        console.log(`[GuardianDigest] ✅ Email enviado a ${ownerEmail} (Tenant: ${tenant.business_name})`);
    } else {
        console.log(`[GuardianDigest] ⚠️ No se pudo enviar a ${ownerEmail}`);
    }

    // Actualizar fecha del próximo envío
    await updateNextSend(tenant.id, interval);
}

async function updateNextSend(tenantId, interval) {
    await pool.query(`
        UPDATE tenants
        SET email_digest_last_sent_at = NOW(),
            email_digest_next_send_at = NOW() + $2::interval
        WHERE id = $1
    `, [tenantId, interval]);
}

function formatDate(date) {
    const d = date.getDate().toString().padStart(2, '0');
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const y = date.getFullYear();
    return `${d}/${m}/${y}`;
}

module.exports = { processGuardianDigests };
