// ═══════════════════════════════════════════════════════════════
// PIN ROUTES - Employee PIN management for Kiosk Mode
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticateToken } = require('../middleware/auth');

module.exports = (pool) => {
    const router = express.Router();

    // POST /api/employees/:id/pin - Set/update PIN (employee changes own, or owner sets)
    router.post('/:id/pin', authenticateToken, async (req, res) => {
        try {
            const { tenantId, employeeId: callerId, is_owner: callerIsOwner } = req.user;
            const targetId = parseInt(req.params.id);
            const { pin } = req.body;

            if (!pin || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
                return res.status(400).json({
                    success: false,
                    message: 'PIN debe ser numérico de 4-6 dígitos'
                });
            }

            // Verify target employee exists and belongs to same tenant
            const empResult = await pool.query(
                'SELECT id, tenant_id FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [targetId, tenantId]
            );
            if (empResult.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
            }

            // Authorization: only self or owner can set PIN
            if (targetId !== callerId && !callerIsOwner) {
                return res.status(403).json({ success: false, message: 'Solo el propietario puede cambiar el PIN de otro empleado' });
            }

            const pinHash = await bcrypt.hash(pin, 12);

            await pool.query(
                'UPDATE employees SET pin_hash = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
                [pinHash, targetId, tenantId]
            );

            console.log(`[PIN] ✅ PIN ${callerId === targetId ? 'changed by self' : 'set by owner'} for employee ${targetId}`);

            res.json({
                success: true,
                message: 'PIN actualizado',
                data: { pin_hash: pinHash }
            });
        } catch (error) {
            console.error('[PIN] Error setting PIN:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar PIN' });
        }
    });

    // POST /api/employees/:id/pin/verify - Verify PIN server-side
    router.post('/:id/pin/verify', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const targetId = parseInt(req.params.id);
            const { pin } = req.body;

            if (!pin) {
                return res.status(400).json({ success: false, message: 'PIN requerido' });
            }

            const empResult = await pool.query(
                'SELECT pin_hash FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [targetId, tenantId]
            );

            if (empResult.rows.length === 0 || !empResult.rows[0].pin_hash) {
                return res.status(404).json({ success: false, message: 'Empleado sin PIN configurado' });
            }

            const valid = await bcrypt.compare(pin, empResult.rows[0].pin_hash);

            res.json({
                success: true,
                data: { valid }
            });
        } catch (error) {
            console.error('[PIN] Error verifying PIN:', error);
            res.status(500).json({ success: false, message: 'Error al verificar PIN' });
        }
    });

    // POST /api/employees/:id/pin/reset - Owner resets employee's PIN
    router.post('/:id/pin/reset', authenticateToken, async (req, res) => {
        try {
            const { tenantId, is_owner: callerIsOwner } = req.user;
            const targetId = parseInt(req.params.id);
            const { pin } = req.body;

            if (!callerIsOwner) {
                return res.status(403).json({ success: false, message: 'Solo el propietario puede resetear PINs' });
            }

            if (!pin || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
                return res.status(400).json({
                    success: false,
                    message: 'PIN debe ser numérico de 4-6 dígitos'
                });
            }

            const empResult = await pool.query(
                'SELECT id FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [targetId, tenantId]
            );
            if (empResult.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
            }

            const pinHash = await bcrypt.hash(pin, 12);

            await pool.query(
                'UPDATE employees SET pin_hash = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3',
                [pinHash, targetId, tenantId]
            );

            console.log(`[PIN] ✅ PIN reset by owner for employee ${targetId}`);

            res.json({
                success: true,
                message: 'PIN reseteado',
                data: { pin_hash: pinHash }
            });
        } catch (error) {
            console.error('[PIN] Error resetting PIN:', error);
            res.status(500).json({ success: false, message: 'Error al resetear PIN' });
        }
    });

    return router;
};
