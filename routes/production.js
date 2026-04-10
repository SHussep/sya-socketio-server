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
                SELECT pe.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, p.descripcion AS product_name
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
                SELECT pe.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, p.descripcion AS product_name
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
                    p.descripcion AS product_name,
                    COUNT(*) AS entry_count,
                    COALESCE(SUM(pe.weight_kg), 0) AS total_masa_kg,
                    COALESCE(SUM(pe.expected_output_kg), 0) AS total_expected_output_kg
                FROM production_entries pe
                LEFT JOIN productos p ON pe.target_product_id = p.id
                WHERE pe.branch_id = $1
                    AND pe.is_deleted = false
                    AND (pe.created_local_utc AT TIME ZONE $2)::date = $3::date
                GROUP BY pe.target_product_id, p.descripcion
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

    // ═══════════════════════════════════════
    // Dedup: check if alert was already broadcast via direct socket event
    // Uses shared Map on io object, populated by handlers.js
    // ═══════════════════════════════════════
    function wasAlreadyBroadcast(branchId, scenarioCode) {
        if (!io.recentDirectProductionAlerts) return false;
        // Match the same key format used in handlers.js
        const key = `${branchId}:${scenarioCode}:${Math.floor(Date.now() / 30000)}`;
        return io.recentDirectProductionAlerts.has(key);
    }

    // ═══════════════════════════════════════
    // POST /alerts/sync — Desktop batch upsert
    // ═══════════════════════════════════════
    router.post('/alerts/sync', authenticateToken, async (req, res) => {
        try {
            const alerts = Array.isArray(req.body) ? req.body : [req.body];
            const results = { inserted: 0, updated: 0, errors: [] };

            for (const alert of alerts) {
                try {
                    let shiftId = alert.shift_id || null;
                    if (!shiftId && alert.shift_global_id) {
                        const shiftRes = await pool.query(
                            'SELECT id FROM shifts WHERE global_id = $1', [alert.shift_global_id]
                        );
                        shiftId = shiftRes.rows[0]?.id || null;
                    }

                    let employeeId = alert.employee_id || null;
                    if (!employeeId && alert.employee_global_id) {
                        const empRes = await pool.query(
                            'SELECT id FROM employees WHERE global_id = $1', [alert.employee_global_id]
                        );
                        employeeId = empRes.rows[0]?.id || null;
                    }

                    let reviewedById = alert.reviewed_by_employee_id || null;
                    if (!reviewedById && alert.reviewed_by_global_id) {
                        const revRes = await pool.query(
                            'SELECT id FROM employees WHERE global_id = $1', [alert.reviewed_by_global_id]
                        );
                        reviewedById = revRes.rows[0]?.id || null;
                    }

                    const detectedWeight = alert.detected_weight_kg === 0 ? null : alert.detected_weight_kg;

                    const result = await pool.query(`
                        INSERT INTO production_alerts (
                            tenant_id, branch_id, shift_id, employee_id,
                            alert_type, scenario_code, severity,
                            detected_weight_kg, details,
                            cycle_duration_seconds, max_weight_in_cycle, points_assigned,
                            additional_data_json,
                            was_reviewed, reviewed_by_employee_id, review_notes, reviewed_at,
                            global_id, terminal_id, local_op_seq,
                            created_local_utc, device_event_raw, last_modified_local_utc,
                            is_deleted
                        ) VALUES (
                            $1, $2, $3, $4,
                            $5, $6, $7,
                            $8, $9,
                            $10, $11, $12,
                            $13,
                            $14, $15, $16, $17,
                            $18, $19, $20,
                            $21, $22, $23,
                            $24
                        )
                        ON CONFLICT (global_id) DO UPDATE SET
                            was_reviewed = EXCLUDED.was_reviewed,
                            reviewed_by_employee_id = EXCLUDED.reviewed_by_employee_id,
                            review_notes = EXCLUDED.review_notes,
                            reviewed_at = EXCLUDED.reviewed_at,
                            is_deleted = EXCLUDED.is_deleted,
                            last_modified_local_utc = EXCLUDED.last_modified_local_utc,
                            updated_at = CURRENT_TIMESTAMP
                        RETURNING id, (xmax = 0) AS inserted
                    `, [
                        alert.tenant_id, alert.branch_id, shiftId, employeeId,
                        alert.alert_type, alert.scenario_code, alert.severity,
                        detectedWeight, alert.details || null,
                        alert.cycle_duration_seconds || null, alert.max_weight_in_cycle || null, alert.points_assigned || 0,
                        alert.additional_data_json ? JSON.stringify(alert.additional_data_json) : null,
                        alert.was_reviewed ?? false, reviewedById, alert.review_notes || null, alert.reviewed_at || null,
                        alert.global_id, alert.terminal_id || null, alert.local_op_seq || null,
                        alert.created_local_utc || alert.timestamp || null, alert.device_event_raw || null, alert.last_modified_local_utc || null,
                        alert.is_deleted ?? false
                    ]);

                    const row = result.rows[0];
                    if (row.inserted) {
                        results.inserted++;
                        // Only emit if not already broadcast via direct socket event
                        if (io && !wasAlreadyBroadcast(alert.branch_id, alert.scenario_code)) {
                            const roomName = `branch_${alert.branch_id}`;
                            io.to(roomName).emit('production_alert:created', {
                                branchId: alert.branch_id,
                                alertId: row.id,
                                alertType: alert.alert_type,
                                severity: alert.severity,
                                scenarioCode: alert.scenario_code,
                                source: 'desktop_sync'
                            });
                        }
                    } else {
                        results.updated++;
                    }
                } catch (alertErr) {
                    results.errors.push({ global_id: alert.global_id, error: alertErr.message });
                }
            }

            res.json({ success: true, ...results });
        } catch (err) {
            console.error('[Production] Error syncing alerts:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // GET /alerts/pull — Desktop incremental pull (gets reviews from Flutter)
    // ═══════════════════════════════════════
    router.get('/alerts/pull', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId, since } = req.query;
            let query = `
                SELECT pa.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name
                FROM production_alerts pa
                LEFT JOIN employees e ON pa.employee_id = e.id
                WHERE pa.tenant_id = $1 AND pa.branch_id = $2
            `;
            const params = [tenantId, branchId];

            if (since) {
                query += ` AND pa.updated_at > $3`;
                params.push(since);
            }
            query += ` ORDER BY pa.created_local_utc DESC LIMIT 500`;

            const result = await pool.query(query, params);
            res.json({ success: true, data: result.rows });
        } catch (err) {
            console.error('[Production] Error pulling alerts:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // GET /alerts — Flutter list with filters
    // ═══════════════════════════════════════
    router.get('/alerts', authenticateToken, async (req, res) => {
        try {
            const { branch_id, start_date, end_date, severity, reviewed, limit = 50, offset = 0 } = req.query;
            let query = `
                SELECT pa.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, re.nombre AS reviewed_by_name
                FROM production_alerts pa
                LEFT JOIN employees e ON pa.employee_id = e.id
                LEFT JOIN employees re ON pa.reviewed_by_employee_id = re.id
                WHERE pa.branch_id = $1 AND pa.is_deleted = false
            `;
            const params = [branch_id];
            let paramIdx = 2;

            if (start_date) {
                query += ` AND pa.created_local_utc >= $${paramIdx}`;
                params.push(start_date);
                paramIdx++;
            }
            if (end_date) {
                query += ` AND pa.created_local_utc <= $${paramIdx}`;
                params.push(end_date);
                paramIdx++;
            }
            if (severity) {
                query += ` AND pa.severity = $${paramIdx}`;
                params.push(severity);
                paramIdx++;
            }
            if (reviewed !== undefined) {
                query += ` AND pa.was_reviewed = $${paramIdx}`;
                params.push(reviewed === 'true');
                paramIdx++;
            }

            query += ` ORDER BY pa.created_local_utc DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await pool.query(query, params);
            res.json({ success: true, data: result.rows });
        } catch (err) {
            console.error('[Production] Error fetching alerts:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // GET /alerts/unreviewed-count — Flutter badge
    // ═══════════════════════════════════════
    router.get('/alerts/unreviewed-count', authenticateToken, async (req, res) => {
        try {
            const { branch_id } = req.query;
            const result = await pool.query(`
                SELECT COUNT(*) AS count
                FROM production_alerts
                WHERE branch_id = $1 AND was_reviewed = false AND is_deleted = false
            `, [branch_id]);
            res.json({ success: true, count: parseInt(result.rows[0].count) });
        } catch (err) {
            console.error('[Production] Error counting unreviewed alerts:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // PATCH /alerts/:id/review — Both Desktop and Flutter
    // ═══════════════════════════════════════
    router.patch('/alerts/:id/review', authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { reviewed_by_employee_id, review_notes } = req.body;

            const result = await pool.query(`
                UPDATE production_alerts
                SET was_reviewed = true,
                    reviewed_by_employee_id = $1,
                    review_notes = $2,
                    reviewed_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $3
                RETURNING id, branch_id
            `, [reviewed_by_employee_id, review_notes || null, id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Alert not found' });
            }

            const row = result.rows[0];
            if (io) {
                const roomName = `branch_${row.branch_id}`;
                io.to(roomName).emit('production_alert:reviewed', {
                    branchId: row.branch_id,
                    alertId: row.id,
                    reviewedBy: reviewed_by_employee_id
                });
            }

            res.json({ success: true, data: row });
        } catch (err) {
            console.error('[Production] Error reviewing alert:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // POST /yield-configs/sync — Desktop batch upsert
    // ═══════════════════════════════════════
    router.post('/yield-configs/sync', authenticateToken, async (req, res) => {
        try {
            const configs = Array.isArray(req.body) ? req.body : [req.body];
            const results = { inserted: 0, updated: 0, errors: [] };

            for (const config of configs) {
                try {
                    const createdById = config.created_by_employee_id === 0 ? null : config.created_by_employee_id;

                    const result = await pool.query(`
                        INSERT INTO production_yield_configs (
                            tenant_id, branch_id, product_id,
                            yield_per_kg_masa, is_active, notes,
                            created_by_employee_id,
                            global_id, terminal_id, local_op_seq,
                            created_local_utc, device_event_raw, last_modified_local_utc,
                            is_deleted
                        ) VALUES (
                            $1, $2, $3,
                            $4, $5, $6,
                            $7,
                            $8, $9, $10,
                            $11, $12, $13,
                            $14
                        )
                        ON CONFLICT (global_id) DO UPDATE SET
                            yield_per_kg_masa = EXCLUDED.yield_per_kg_masa,
                            is_active = EXCLUDED.is_active,
                            notes = EXCLUDED.notes,
                            is_deleted = EXCLUDED.is_deleted,
                            last_modified_local_utc = EXCLUDED.last_modified_local_utc,
                            updated_at = CURRENT_TIMESTAMP
                        RETURNING id, (xmax = 0) AS inserted
                    `, [
                        config.tenant_id, config.branch_id, config.product_id,
                        config.yield_per_kg_masa, config.is_active ?? true, config.notes || null,
                        createdById,
                        config.global_id, config.terminal_id || null, config.local_op_seq || null,
                        config.created_local_utc || null, config.device_event_raw || null, config.last_modified_local_utc || null,
                        config.is_deleted ?? false
                    ]);

                    const row = result.rows[0];
                    if (row.inserted) {
                        results.inserted++;
                        if (io) {
                            io.to(`branch_${config.branch_id}`).emit('yield_config:created', {
                                branchId: config.branch_id,
                                configId: row.id,
                                productId: config.product_id,
                                yieldPerKgMasa: config.yield_per_kg_masa
                            });
                        }
                    } else {
                        results.updated++;
                        if (io) {
                            io.to(`branch_${config.branch_id}`).emit('yield_config:updated', {
                                branchId: config.branch_id,
                                configId: row.id,
                                productId: config.product_id,
                                yieldPerKgMasa: config.yield_per_kg_masa
                            });
                        }
                    }
                } catch (configErr) {
                    results.errors.push({ global_id: config.global_id, error: configErr.message });
                }
            }

            res.json({ success: true, ...results });
        } catch (err) {
            console.error('[Production] Error syncing yield configs:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // GET /yield-configs/pull — Desktop incremental pull
    // ═══════════════════════════════════════
    router.get('/yield-configs/pull', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId, since } = req.query;
            let query = `
                SELECT pyc.*, p.descripcion AS product_name
                FROM production_yield_configs pyc
                LEFT JOIN productos p ON pyc.product_id = p.id
                WHERE pyc.tenant_id = $1 AND pyc.branch_id = $2
            `;
            const params = [tenantId, branchId];

            if (since) {
                query += ` AND pyc.updated_at > $3`;
                params.push(since);
            }
            query += ` ORDER BY pyc.created_at DESC`;

            const result = await pool.query(query, params);
            res.json({ success: true, data: result.rows });
        } catch (err) {
            console.error('[Production] Error pulling yield configs:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // GET /yield-configs — Flutter list active configs
    // ═══════════════════════════════════════
    router.get('/yield-configs', authenticateToken, async (req, res) => {
        try {
            const { branch_id, tenant_id } = req.query;
            const result = await pool.query(`
                SELECT pyc.*, p.descripcion AS product_name
                FROM production_yield_configs pyc
                LEFT JOIN productos p ON pyc.product_id = p.id
                WHERE pyc.branch_id = $1 AND pyc.tenant_id = $2
                    AND pyc.is_active = true AND pyc.is_deleted = false
                ORDER BY p.descripcion ASC
            `, [branch_id, tenant_id]);
            res.json({ success: true, data: result.rows });
        } catch (err) {
            console.error('[Production] Error fetching yield configs:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // POST /yield-configs — Flutter create (server-first)
    // ═══════════════════════════════════════
    router.post('/yield-configs', authenticateToken, async (req, res) => {
        try {
            const { branch_id, tenant_id, product_id, yield_per_kg_masa, notes, created_by_employee_id } = req.body;
            const globalId = uuidv4();

            const result = await pool.query(`
                INSERT INTO production_yield_configs (
                    tenant_id, branch_id, product_id,
                    yield_per_kg_masa, is_active, notes,
                    created_by_employee_id, global_id,
                    created_local_utc
                ) VALUES ($1, $2, $3, $4, true, $5, $6, $7, CURRENT_TIMESTAMP)
                RETURNING *
            `, [tenant_id, branch_id, product_id, yield_per_kg_masa, notes || null, created_by_employee_id || null, globalId]);

            const row = result.rows[0];

            // Get product name for response
            const prodResult = await pool.query('SELECT nombre FROM productos WHERE id = $1', [product_id]);
            row.product_name = prodResult.rows[0]?.nombre || null;

            if (io) {
                io.to(`branch_${branch_id}`).emit('yield_config:created', {
                    branchId: branch_id,
                    configId: row.id,
                    productId: product_id,
                    yieldPerKgMasa: yield_per_kg_masa
                });
            }

            res.json({ success: true, data: row });
        } catch (err) {
            console.error('[Production] Error creating yield config:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // PUT /yield-configs/:id — Flutter edit
    // ═══════════════════════════════════════
    router.put('/yield-configs/:id', authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { yield_per_kg_masa, notes } = req.body;

            const result = await pool.query(`
                UPDATE production_yield_configs
                SET yield_per_kg_masa = $1, notes = $2,
                    last_modified_local_utc = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = $3 AND is_deleted = false
                RETURNING *
            `, [yield_per_kg_masa, notes || null, id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Config not found' });
            }

            const row = result.rows[0];
            const prodResult = await pool.query('SELECT nombre FROM productos WHERE id = $1', [row.product_id]);
            row.product_name = prodResult.rows[0]?.nombre || null;

            if (io) {
                io.to(`branch_${row.branch_id}`).emit('yield_config:updated', {
                    branchId: row.branch_id,
                    configId: row.id,
                    productId: row.product_id,
                    yieldPerKgMasa: yield_per_kg_masa
                });
            }

            res.json({ success: true, data: row });
        } catch (err) {
            console.error('[Production] Error updating yield config:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ═══════════════════════════════════════
    // DELETE /yield-configs/:id — Flutter soft delete
    // ═══════════════════════════════════════
    router.delete('/yield-configs/:id', authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;

            const result = await pool.query(`
                UPDATE production_yield_configs
                SET is_active = false, is_deleted = true, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING id, branch_id, product_id
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Config not found' });
            }

            const row = result.rows[0];
            if (io) {
                io.to(`branch_${row.branch_id}`).emit('yield_config:deleted', {
                    branchId: row.branch_id,
                    configId: row.id,
                    productId: row.product_id
                });
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[Production] Error deleting yield config:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
