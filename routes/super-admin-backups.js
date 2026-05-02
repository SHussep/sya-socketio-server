const express = require('express');

const LIST_SQL = `
    SELECT DISTINCT ON (bm.tenant_id, bm.branch_id)
      t.id   AS tenant_id, t.business_name AS tenant_name, t.email AS owner_email,
      b.id   AS branch_id, b.name AS branch_name,
      bm.id  AS backup_id, bm.backup_filename, bm.backup_path,
      bm.file_size_bytes, bm.created_at, bm.device_name
    FROM backup_metadata bm
    JOIN tenants  t ON t.id = bm.tenant_id
    JOIN branches b ON b.id = bm.branch_id
    WHERE bm.branch_id IS NOT NULL
    ORDER BY bm.tenant_id, bm.branch_id, bm.created_at DESC
`;

function groupByTenant(rows) {
    const byTenant = new Map();
    for (const r of rows) {
        let t = byTenant.get(r.tenant_id);
        if (!t) {
            t = {
                tenant_id: r.tenant_id,
                tenant_name: r.tenant_name,
                owner_email: r.owner_email,
                latest_backup_at: r.created_at,
                branches: []
            };
            byTenant.set(r.tenant_id, t);
        }
        t.branches.push({
            branch_id: r.branch_id,
            branch_name: r.branch_name,
            backup_id: r.backup_id,
            backup_filename: r.backup_filename,
            file_size_bytes: r.file_size_bytes != null ? Number(r.file_size_bytes) : null,
            created_at: new Date(r.created_at).toISOString(),
            device_name: r.device_name
        });
        if (new Date(r.created_at) > new Date(t.latest_backup_at)) {
            t.latest_backup_at = r.created_at;
        }
    }
    const tenants = [...byTenant.values()];
    for (const t of tenants) {
        t.branches.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        t.latest_backup_at = new Date(t.latest_backup_at).toISOString();
    }
    tenants.sort((a, b) => new Date(b.latest_backup_at) - new Date(a.latest_backup_at));
    return tenants;
}

module.exports = function createSuperAdminBackupsRouter(pool) {
    const router = express.Router();

    router.get('/list', async (req, res) => {
        try {
            const result = await pool.query(LIST_SQL);
            res.json({ tenants: groupByTenant(result.rows) });
        } catch (err) {
            console.error('[super-admin-backups] /list error:', err);
            res.status(500).json({ success: false, error: 'internal' });
        }
    });

    return router;
};
