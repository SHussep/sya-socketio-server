// ═══════════════════════════════════════════════════════════════
// PRACTICE MODE API - Limpieza de datos de práctica
// ═══════════════════════════════════════════════════════════════
// Maneja la limpieza de notificaciones generadas durante sesiones
// de práctica/entrenamiento. Los datos de práctica se marcan con
// is_practice = true y pueden ser eliminados cuando ya no se necesiten.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const notificationHelper = require('../utils/notificationHelper');

module.exports = function(pool, io) {

    // ═══════════════════════════════════════════════════════════════════════════
    // DELETE /api/practice-mode/cleanup - Eliminar notificaciones de práctica
    // ═══════════════════════════════════════════════════════════════════════════
    router.delete('/cleanup', authenticateToken, async (req, res) => {
        try {
            const tenant_id = req.user.tenantId;
            const { branch_id, terminal_id, owner_name } = req.body;

            if (!branch_id) {
                return res.status(400).json({
                    success: false,
                    message: 'branch_id es requerido'
                });
            }

            console.log(`[PracticeMode/Cleanup] 🧹 Limpiando notificaciones de práctica - Tenant: ${tenant_id}, Branch: ${branch_id}, Terminal: ${terminal_id || 'N/A'}`);

            // Eliminar notificaciones marcadas como práctica para esta sucursal
            const result = await pool.query(
                `DELETE FROM notifications
                 WHERE is_practice = true
                   AND branch_id = $1
                   AND tenant_id = $2
                 RETURNING id`,
                [parseInt(branch_id), parseInt(tenant_id)]
            );

            const deletedCount = result.rows.length;

            console.log(`[PracticeMode/Cleanup] ✅ ${deletedCount} notificaciones de práctica eliminadas`);

            // Emitir evento Socket.IO a la sucursal para que otros clientes actualicen
            if (io) {
                io.to(`branch_${branch_id}`).emit('practice_mode_cleanup', {
                    branchId: parseInt(branch_id),
                    tenantId: parseInt(tenant_id),
                    terminalId: terminal_id,
                    deletedCount,
                    timestamp: new Date().toISOString()
                });
            }

            // Enviar FCM a admins notificando la limpieza
            try {
                await notificationHelper.notifyPracticeModeCleanup(
                    parseInt(tenant_id),
                    parseInt(branch_id),
                    {
                        ownerName: owner_name || 'Sistema',
                        terminalId: terminal_id,
                        deletedCount
                    }
                );
            } catch (fcmError) {
                console.error(`[PracticeMode/Cleanup] ⚠️ Error enviando FCM de limpieza:`, fcmError.message);
            }

            res.json({
                success: true,
                deleted_notifications: deletedCount,
                message: `${deletedCount} notificaciones de práctica eliminadas`
            });

        } catch (error) {
            console.error('[PracticeMode/Cleanup] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al limpiar datos de práctica'
            });
        }
    });

    return router;
};
