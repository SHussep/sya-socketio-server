const express = require('express');
const router = express.Router();
const { pool } = require('../database');

/**
 * GET /api/notification-preferences/:employeeGlobalId
 * Obtiene las preferencias de notificaciones de un empleado
 */
router.get('/:employeeGlobalId', async (req, res) => {
    const { employeeGlobalId } = req.params;

    try {
        // Obtener employee_id desde global_id
        const employeeResult = await pool.query(
            `SELECT e.id, e.tenant_id FROM employees e WHERE e.global_id = $1 LIMIT 1`,
            [employeeGlobalId]
        );

        if (employeeResult.rows.length === 0) {
            return res.status(404).json({ error: 'Empleado no encontrado' });
        }

        const { id: employeeId, tenant_id: tenantId } = employeeResult.rows[0];

        // Obtener preferencias existentes o valores por defecto
        const prefsResult = await pool.query(
            `SELECT * FROM notification_preferences WHERE employee_id = $1`,
            [employeeId]
        );

        if (prefsResult.rows.length === 0) {
            // Retornar valores por defecto
            return res.json({
                notify_login: true,
                notify_shift_start: true,
                notify_shift_end: true,
                notify_expense_created: true,
                notify_assignment_created: true,
                notify_guardian_peso_no_registrado: true,
                notify_guardian_operacion_irregular: true,
                notify_guardian_discrepancia: true
            });
        }

        const prefs = prefsResult.rows[0];
        res.json({
            notify_login: prefs.notify_login,
            notify_shift_start: prefs.notify_shift_start,
            notify_shift_end: prefs.notify_shift_end,
            notify_expense_created: prefs.notify_expense_created,
            notify_assignment_created: prefs.notify_assignment_created,
            notify_guardian_peso_no_registrado: prefs.notify_guardian_peso_no_registrado,
            notify_guardian_operacion_irregular: prefs.notify_guardian_operacion_irregular,
            notify_guardian_discrepancia: prefs.notify_guardian_discrepancia
        });

    } catch (error) {
        console.error('[NotificationPreferences] Error obteniendo preferencias:', error.message);
        res.status(500).json({ error: undefined });
    }
});

/**
 * POST /api/notification-preferences
 * Guarda las preferencias de notificaciones de un empleado
 */
router.post('/', async (req, res) => {
    const {
        employee_global_id,
        notify_login,
        notify_shift_start,
        notify_shift_end,
        notify_expense_created,
        notify_assignment_created,
        notify_guardian_peso_no_registrado,
        notify_guardian_operacion_irregular,
        notify_guardian_discrepancia
    } = req.body;

    if (!employee_global_id) {
        return res.status(400).json({ error: 'employee_global_id es requerido' });
    }

    try {
        // Obtener employee_id y tenant_id desde global_id
        const employeeResult = await pool.query(
            `SELECT e.id, e.tenant_id FROM employees e WHERE e.global_id = $1 LIMIT 1`,
            [employee_global_id]
        );

        if (employeeResult.rows.length === 0) {
            return res.status(404).json({ error: 'Empleado no encontrado' });
        }

        const { id: employeeId, tenant_id: tenantId } = employeeResult.rows[0];

        // Upsert preferencias
        const result = await pool.query(`
            INSERT INTO notification_preferences (
                tenant_id,
                employee_id,
                notify_login,
                notify_shift_start,
                notify_shift_end,
                notify_expense_created,
                notify_assignment_created,
                notify_guardian_peso_no_registrado,
                notify_guardian_operacion_irregular,
                notify_guardian_discrepancia
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (tenant_id, employee_id)
            DO UPDATE SET
                notify_login = EXCLUDED.notify_login,
                notify_shift_start = EXCLUDED.notify_shift_start,
                notify_shift_end = EXCLUDED.notify_shift_end,
                notify_expense_created = EXCLUDED.notify_expense_created,
                notify_assignment_created = EXCLUDED.notify_assignment_created,
                notify_guardian_peso_no_registrado = EXCLUDED.notify_guardian_peso_no_registrado,
                notify_guardian_operacion_irregular = EXCLUDED.notify_guardian_operacion_irregular,
                notify_guardian_discrepancia = EXCLUDED.notify_guardian_discrepancia,
                updated_at = NOW()
            RETURNING *
        `, [
            tenantId,
            employeeId,
            notify_login ?? true,
            notify_shift_start ?? true,
            notify_shift_end ?? true,
            notify_expense_created ?? true,
            notify_assignment_created ?? true,
            notify_guardian_peso_no_registrado ?? true,
            notify_guardian_operacion_irregular ?? true,
            notify_guardian_discrepancia ?? true
        ]);

        console.log(`[NotificationPreferences] ✅ Preferencias guardadas para empleado ${employee_global_id}`);

        res.json({
            success: true,
            preferences: result.rows[0]
        });

    } catch (error) {
        console.error('[NotificationPreferences] Error guardando preferencias:', error.message);
        res.status(500).json({ error: undefined });
    }
});

module.exports = router;
