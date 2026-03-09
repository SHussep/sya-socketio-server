const express = require('express');
const router = express.Router();
const { pool } = require('../database');

/**
 * GET /api/notification-preferences/:employeeGlobalId
 * Obtiene las preferencias de notificaciones de un empleado
 * Retorna columnas de grupo (nuevo) + legacy (backward compat)
 */
router.get('/:employeeGlobalId', async (req, res) => {
    const { employeeGlobalId } = req.params;

    try {
        const employeeResult = await pool.query(
            `SELECT e.id, e.tenant_id FROM employees e WHERE e.global_id = $1 LIMIT 1`,
            [employeeGlobalId]
        );

        if (employeeResult.rows.length === 0) {
            return res.status(404).json({ error: 'Empleado no encontrado' });
        }

        const { id: employeeId } = employeeResult.rows[0];

        const prefsResult = await pool.query(
            `SELECT * FROM notification_preferences WHERE employee_id = $1`,
            [employeeId]
        );

        if (prefsResult.rows.length === 0) {
            return res.json({
                // Group columns (new system)
                notify_turnos: true,
                notify_ventas: true,
                notify_gastos: true,
                notify_repartidores: true,
                notify_guardian: true,
                // Legacy columns (backward compat)
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
            // Group columns
            notify_turnos: prefs.notify_turnos ?? true,
            notify_ventas: prefs.notify_ventas ?? true,
            notify_gastos: prefs.notify_gastos ?? true,
            notify_repartidores: prefs.notify_repartidores ?? true,
            notify_guardian: prefs.notify_guardian ?? true,
            // Legacy columns
            notify_login: prefs.notify_login ?? true,
            notify_shift_start: prefs.notify_shift_start ?? true,
            notify_shift_end: prefs.notify_shift_end ?? true,
            notify_expense_created: prefs.notify_expense_created ?? true,
            notify_assignment_created: prefs.notify_assignment_created ?? true,
            notify_guardian_peso_no_registrado: prefs.notify_guardian_peso_no_registrado ?? true,
            notify_guardian_operacion_irregular: prefs.notify_guardian_operacion_irregular ?? true,
            notify_guardian_discrepancia: prefs.notify_guardian_discrepancia ?? true
        });

    } catch (error) {
        console.error('[NotificationPreferences] Error obteniendo preferencias:', error.message);
        res.status(500).json({ error: undefined });
    }
});

/**
 * POST /api/notification-preferences
 * Guarda las preferencias de notificaciones de un empleado
 * Acepta columnas de grupo (nuevo) o legacy (backward compat)
 */
router.post('/', async (req, res) => {
    const {
        employee_global_id,
        // Group columns (new system)
        notify_turnos,
        notify_ventas,
        notify_gastos,
        notify_repartidores,
        notify_guardian,
        // Legacy columns (old system)
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
        const employeeResult = await pool.query(
            `SELECT e.id, e.tenant_id FROM employees e WHERE e.global_id = $1 LIMIT 1`,
            [employee_global_id]
        );

        if (employeeResult.rows.length === 0) {
            return res.status(404).json({ error: 'Empleado no encontrado' });
        }

        const { id: employeeId, tenant_id: tenantId } = employeeResult.rows[0];

        // Determine effective group values
        // If group columns provided, use them directly
        // If only legacy provided, derive groups from them
        const effTurnos = notify_turnos ?? (notify_login !== undefined ? (notify_login && notify_shift_start && notify_shift_end) : true);
        const effVentas = notify_ventas ?? true;
        const effGastos = notify_gastos ?? (notify_expense_created ?? true);
        const effRepartidores = notify_repartidores ?? (notify_assignment_created ?? true);
        const effGuardian = notify_guardian ?? (notify_guardian_peso_no_registrado !== undefined
            ? (notify_guardian_peso_no_registrado && notify_guardian_operacion_irregular && notify_guardian_discrepancia)
            : true);

        // Sync legacy columns from group values
        const effLogin = notify_login ?? effTurnos;
        const effShiftStart = notify_shift_start ?? effTurnos;
        const effShiftEnd = notify_shift_end ?? effTurnos;
        const effExpense = notify_expense_created ?? effGastos;
        const effAssignment = notify_assignment_created ?? effRepartidores;
        const effGuardianPeso = notify_guardian_peso_no_registrado ?? effGuardian;
        const effGuardianOp = notify_guardian_operacion_irregular ?? effGuardian;
        const effGuardianDisc = notify_guardian_discrepancia ?? effGuardian;

        const result = await pool.query(`
            INSERT INTO notification_preferences (
                tenant_id, employee_id,
                notify_turnos, notify_ventas, notify_gastos, notify_repartidores, notify_guardian,
                notify_login, notify_shift_start, notify_shift_end,
                notify_expense_created, notify_assignment_created,
                notify_guardian_peso_no_registrado, notify_guardian_operacion_irregular, notify_guardian_discrepancia
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (tenant_id, employee_id)
            DO UPDATE SET
                notify_turnos = EXCLUDED.notify_turnos,
                notify_ventas = EXCLUDED.notify_ventas,
                notify_gastos = EXCLUDED.notify_gastos,
                notify_repartidores = EXCLUDED.notify_repartidores,
                notify_guardian = EXCLUDED.notify_guardian,
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
            tenantId, employeeId,
            effTurnos, effVentas, effGastos, effRepartidores, effGuardian,
            effLogin, effShiftStart, effShiftEnd,
            effExpense, effAssignment,
            effGuardianPeso, effGuardianOp, effGuardianDisc
        ]);

        console.log(`[NotificationPreferences] Preferencias guardadas para empleado ${employee_global_id}`);

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
