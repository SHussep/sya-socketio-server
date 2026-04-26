require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const AFFECTED_TENANTS = [23, 79, 32, 24, 20, 18, 97, 43];

async function detectDuplicateGroups(tenantId) {
    const cutoffResult = await pool.query(
        `SELECT MIN(event_timestamp) AS telemetry_first
         FROM telemetry_events
         WHERE tenant_id = $1 AND app_version LIKE '1.3.%'`,
        [tenantId]
    );
    const releaseFloor = new Date('2026-04-15T00:00:00Z');
    const telemetryFirst = cutoffResult.rows[0].telemetry_first;
    const cutoff = telemetryFirst && telemetryFirst < releaseFloor ? telemetryFirst : releaseFloor;

    const dedupCheck = await pool.query(
        'SELECT products_deduplicated_at, business_name FROM tenants WHERE id = $1',
        [tenantId]
    );
    if (dedupCheck.rows.length === 0) {
        return { tenantId, businessName: '(no existe)', cutoff, alreadyCompleted: false, groups: [] };
    }
    const businessName = dedupCheck.rows[0].business_name;
    const alreadyCompleted = dedupCheck.rows[0].products_deduplicated_at != null;
    if (alreadyCompleted) {
        return { tenantId, businessName, cutoff, alreadyCompleted, groups: [] };
    }

    const result = await pool.query(`
        WITH normalize AS (
            SELECT id, descripcion, created_at, precio_venta,
                   LOWER(TRIM(REGEXP_REPLACE(
                       TRANSLATE(descripcion, 'áéíóúÁÉÍÓÚñÑüÜ', 'aeiouAEIOUnNuU'),
                       '[^a-zA-Z0-9 ]', '', 'g'
                   ))) AS nombre_norm
            FROM productos
            WHERE tenant_id = $1 AND eliminado = false
        ),
        grupos AS (
            SELECT nombre_norm, COUNT(*) AS miembros
            FROM normalize
            GROUP BY nombre_norm
            HAVING COUNT(*) >= 2
        )
        SELECT
            n.nombre_norm AS group_key,
            n.id, n.descripcion, n.created_at, n.precio_venta,
            (SELECT COUNT(*) FROM ventas_detalle vd WHERE vd.id_producto = n.id) AS ventas,
            COALESCE((SELECT SUM(vd.cantidad * vd.precio_unitario)
                      FROM ventas_detalle vd WHERE vd.id_producto = n.id), 0) AS monto
        FROM normalize n
        INNER JOIN grupos g ON g.nombre_norm = n.nombre_norm
        ORDER BY n.nombre_norm, n.created_at ASC
    `, [tenantId]);

    const groupsMap = new Map();
    for (const row of result.rows) {
        if (!groupsMap.has(row.group_key)) {
            groupsMap.set(row.group_key, { groupKey: row.group_key, members: [] });
        }
        groupsMap.get(row.group_key).members.push({
            id: row.id,
            desc: row.descripcion,
            created: row.created_at,
            precio: parseFloat(row.precio_venta) || 0,
            ventas: parseInt(row.ventas) || 0,
            monto: parseFloat(row.monto) || 0,
            wasPostBug: new Date(row.created_at) >= cutoff
        });
    }

    return { tenantId, businessName, cutoff, alreadyCompleted, groups: Array.from(groupsMap.values()) };
}

(async () => {
    console.log('═════════════════════════════════════════════════════════════════════');
    console.log('SIMULACIÓN del endpoint /duplicates-suggestion (versión grupos)');
    console.log('═════════════════════════════════════════════════════════════════════\n');

    let totalGroups = 0;
    let totalProducts = 0;

    for (const tenantId of AFFECTED_TENANTS) {
        const r = await detectDuplicateGroups(tenantId);
        console.log(`\n┌─────────────────────────────────────────────────────────────────────`);
        console.log(`│ Tenant ${tenantId} — ${r.businessName}`);
        console.log(`│ Cutoff: ${r.cutoff.toISOString().substring(0, 10)} | Ya completado: ${r.alreadyCompleted ? 'SÍ' : 'NO'}`);
        console.log(`│ Grupos detectados: ${r.groups.length}`);
        console.log(`└─────────────────────────────────────────────────────────────────────`);

        for (const g of r.groups) {
            console.log(`\n  📦 Grupo "${g.groupKey}" (${g.members.length} productos):`);
            g.members.forEach((m, i) => {
                const tag = m.wasPostBug ? '🆕 POST-BUG' : '📅 PRE-BUG';
                console.log(`    ${i + 1}. ${tag} | "${m.desc}" (id=${m.id}) | ${m.ventas} ventas | $${m.monto.toFixed(2)} | precio $${m.precio.toFixed(2)} | creado ${m.created.toISOString().substring(0, 10)}`);
            });
            totalGroups++;
            totalProducts += g.members.length;
        }
    }

    console.log(`\n═════════════════════════════════════════════════════════════════════`);
    console.log(`TOTALES: ${totalGroups} grupos | ${totalProducts} productos involucrados`);
    console.log(`═════════════════════════════════════════════════════════════════════`);

    await pool.end();
})();
