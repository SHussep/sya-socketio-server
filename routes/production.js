// ═══════════════════════════════════════════════════════════════
// PRODUCTION MODULE API - Entries, Alerts, Yield Configs
// ═══════════════════════════════════════════════════════════════
// Desktop sync (offline-first → PostgreSQL) and Flutter consumption.
// Entries & alerts: Desktop creates, syncs via POST; Flutter reads via GET.
// Yield configs: bidirectional CRUD (Desktop sync + Flutter server-first).
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { authenticateToken } = require('../middleware/auth');

module.exports = (pool, io) => {
    const router = express.Router();

    // ═══════════════════════════════════════
    // Helper: Normalize Desktop entry_mode values
    // ═══════════════════════════════════════
    const normalizeEntryMode = (mode) => {
        const map = { 'ScaleConfirmed': 'automatic', 'Manual': 'manual', 'Accumulated': 'accumulated' };
        return map[mode] || mode?.toLowerCase() || 'automatic';
    };

    // ═══════════════════════════════════════
    // POST /entries/sync — Desktop batch upsert
    // ═══════════════════════════════════════
    router.post('/entries/sync', authenticateToken, async (req, res) => {
        try {
            const entries = Array.isArray(req.body) ? req.body : [req.body];
            const results = { inserted: 0, updated: 0, errors: [] };

            for (const entry of entries) {
                try {
                    // Resolve shift FK from global_id
                    let shiftId = entry.shift_id || null;
                    if (!shiftId && entry.shift_global_id) {
                        const shiftRes = await pool.query(
                            'SELECT id FROM shifts WHERE global_id = $1', [entry.shift_global_id]
                        );
                        shiftId = shiftRes.rows[0]?.id || null;
                    }

                    // Resolve employee FK from global_id
                    let employeeId = entry.employee_id || null;
                    if (employeeId === 0) employeeId = null;
                    if (!employeeId && entry.employee_global_id) {
                        const empRes = await pool.query(
                            'SELECT id FROM employees WHERE global_id = $1', [entry.employee_global_id]
                        );
                        employeeId = empRes.rows[0]?.id || null;
                    }

                    const result = await pool.query(`
                        INSERT INTO production_entries (
                            tenant_id, branch_id, shift_id, employee_id,
                            weight_kg, target_product_id, expected_output_kg,
                            is_auto_calculated, entry_mode, notes,
                            is_accumulated, accumulation_count, accumulation_detail,
                            global_id, terminal_id, local_op_seq,
                            created_local_utc, device_event_raw, last_modified_local_utc,
                            is_deleted
                        ) VALUES (
                            $1, $2, $3, $4,
                            $5, $6, $7,
                            $8, $9, $10,
                            $11, $12, $13,
                            $14, $15, $16,
                            $17, $18, $19,
                            $20
                        )
                        ON CONFLICT (global_id) DO UPDATE SET
                            weight_kg = EXCLUDED.weight_kg,
                            expected_output_kg = EXCLUDED.expected_output_kg,
                            notes = EXCLUDED.notes,
                            is_deleted = EXCLUDED.is_deleted,
                            last_modified_local_utc = EXCLUDED.last_modified_local_utc,
                            updated_at = CURRENT_TIMESTAMP
                        RETURNING id, (xmax = 0) AS inserted
                    `, [
                        entry.tenant_id, entry.branch_id, shiftId, employeeId,
                        entry.weight_kg, entry.target_product_id || null, entry.expected_output_kg || null,
                        entry.is_auto_calculated ?? true, normalizeEntryMode(entry.entry_mode), entry.notes || null,
                        entry.is_accumulated ?? false, entry.accumulation_count || 0, entry.accumulation_detail || null,
                        entry.global_id, entry.terminal_id || null, entry.local_op_seq || null,
                        entry.created_local_utc || entry.timestamp || null, entry.device_event_raw || null, entry.last_modified_local_utc || null,
                        entry.is_deleted ?? false
                    ]);

                    const row = result.rows[0];
                    if (row.inserted) {
                        results.inserted++;
                        // Emit socket event for new entries
                        if (io) {
                            const roomName = `branch_${entry.branch_id}`;
                            io.to(roomName).emit('production_entry:created', {
                                branchId: entry.branch_id,
                                entryId: row.id,
                                weightKg: entry.weight_kg,
                                employeeName: entry.employee_name || null,
                                source: 'desktop_sync'
                            });
                        }
                    } else {
                        results.updated++;
                    }
                } catch (entryErr) {
                    results.errors.push({ global_id: entry.global_id, error: entryErr.message });
                }
            }

            res.json({ success: true, ...results });
        } catch (err) {
            console.error('[Production] Error syncing entries:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // GET /entries/pull — Desktop incremental pull
    // ═══════════════════════════════════════
    router.get('/entries/pull', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId, since } = req.query;
            let query = `
                SELECT pe.*, e.nombre AS employee_name, p.nombre AS product_name
                FROM production_entries pe
                LEFT JOIN employees e ON pe.employee_id = e.id
                LEFT JOIN productos p ON pe.target_product_id = p.id
                WHERE pe.tenant_id = $1 AND pe.branch_id = $2
            `;
            const params = [tenantId, branchId];

            if (since) {
                query += ` AND pe.updated_at > $3`;
                params.push(since);
            }
            query += ` ORDER BY pe.created_local_utc DESC LIMIT 500`;

            const result = await pool.query(query, params);
            res.json({ success: true, data: result.rows });
        } catch (err) {
            console.error('[Production] Error pulling entries:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // GET /entries — Flutter list with filters
    // ═══════════════════════════════════════
    router.get('/entries', authenticateToken, async (req, res) => {
        try {
            const { branch_id, start_date, end_date, employee_id, limit = 50, offset = 0 } = req.query;
            let query = `
                SELECT pe.*, e.nombre AS employee_name, p.nombre AS product_name
                FROM production_entries pe
                LEFT JOIN employees e ON pe.employee_id = e.id
                LEFT JOIN productos p ON pe.target_product_id = p.id
                WHERE pe.branch_id = $1 AND pe.is_deleted = false
            `;
            const params = [branch_id];
            let paramIdx = 2;

            if (start_date) {
                query += ` AND pe.created_local_utc >= $${paramIdx}`;
                params.push(start_date);
                paramIdx++;
            }
            if (end_date) {
                query += ` AND pe.created_local_utc <= $${paramIdx}`;
                params.push(end_date);
                paramIdx++;
            }
            if (employee_id) {
                query += ` AND pe.employee_id = $${paramIdx}`;
                params.push(employee_id);
                paramIdx++;
            }

            query += ` ORDER BY pe.created_local_utc DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await pool.query(query, params);
            res.json({ success: true, data: result.rows });
        } catch (err) {
            console.error('[Production] Error fetching entries:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // GET /entries/summary — Flutter daily summary
    // ═══════════════════════════════════════
    router.get('/entries/summary', authenticateToken, async (req, res) => {
        try {
            const { branch_id, date, timezone = 'America/Mexico_City' } = req.query;

            // Total entries for the day
            const summaryResult = await pool.query(`
                SELECT
                    COUNT(*) AS total_entries,
                    COALESCE(SUM(weight_kg), 0) AS total_masa_kg
                FROM production_entries
                WHERE branch_id = $1
                    AND is_deleted = false
                    AND (created_local_utc AT TIME ZONE $2)::date = $3::date
            `, [branch_id, timezone, date]);

            // Alert count for the day
            const alertResult = await pool.query(`
                SELECT COUNT(*) AS alert_count
                FROM production_alerts
                WHERE branch_id = $1
                    AND is_deleted = false
                    AND (created_local_utc AT TIME ZONE $2)::date = $3::date
            `, [branch_id, timezone, date]);

            // Breakdown by product
            const byProductResult = await pool.query(`
                SELECT
                    pe.target_product_id AS product_id,
                    p.nombre AS product_name,
                    COUNT(*) AS entry_count,
                    COALESCE(SUM(pe.weight_kg), 0) AS total_masa_kg,
                    COALESCE(SUM(pe.expected_output_kg), 0) AS total_expected_output_kg
                FROM production_entries pe
                LEFT JOIN productos p ON pe.target_product_id = p.id
                WHERE pe.branch_id = $1
                    AND pe.is_deleted = false
                    AND (pe.created_local_utc AT TIME ZONE $2)::date = $3::date
                GROUP BY pe.target_product_id, p.nombre
                ORDER BY total_masa_kg DESC
            `, [branch_id, timezone, date]);

            const summary = summaryResult.rows[0];
            res.json({
                success: true,
                data: {
                    date,
                    totalMasaKg: parseFloat(summary.total_masa_kg),
                    totalEntries: parseInt(summary.total_entries),
                    alertCount: parseInt(alertResult.rows[0].alert_count),
                    byProduct: byProductResult.rows.map(r => ({
                        productId: r.product_id,
                        productName: r.product_name,
                        totalMasaKg: parseFloat(r.total_masa_kg),
                        totalExpectedOutputKg: parseFloat(r.total_expected_output_kg),
                        entryCount: parseInt(r.entry_count)
                    }))
                }
            });
        } catch (err) {
            console.error('[Production] Error fetching summary:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // (Alerts and YieldConfigs endpoints added in Tasks 3 and 4)

    return router;
};
