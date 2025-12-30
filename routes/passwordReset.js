// ═══════════════════════════════════════════════════════════
// RUTA: PASSWORD RESET
// Endpoint para enviar emails de recuperación de contraseña
// ═══════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { sendPasswordResetEmail } = require('../utils/emailService');

/**
 * POST /api/password-reset
 * Envía un email con la contraseña temporal
 *
 * Body:
 * - recipientEmail: string (email del destinatario)
 * - recipientName: string (nombre del destinatario)
 * - temporaryPassword: string (contraseña temporal generada)
 * - isForAdmin: boolean (opcional, si es para notificar al admin)
 * - employeeName: string (opcional, nombre del empleado si isForAdmin=true)
 */
router.post('/', async (req, res) => {
    try {
        const { recipientEmail, recipientName, temporaryPassword, isForAdmin, employeeName } = req.body;

        // Validar campos requeridos
        if (!recipientEmail || !recipientName || !temporaryPassword) {
            console.log('❌ Password reset: Faltan campos requeridos');
            return res.status(400).json({
                success: false,
                message: 'Faltan campos requeridos: recipientEmail, recipientName, temporaryPassword'
            });
        }

        console.log(`📧 Enviando email de recuperación a ${recipientEmail}${isForAdmin ? ` (para ${employeeName})` : ''}`);

        const success = await sendPasswordResetEmail({
            to: recipientEmail,
            recipientName,
            temporaryPassword,
            isForAdmin: isForAdmin || false,
            employeeName
        });

        if (success) {
            console.log('✅ Email de recuperación enviado exitosamente');
            res.json({ success: true, message: 'Email enviado exitosamente' });
        } else {
            console.log('❌ Error enviando email de recuperación');
            res.status(500).json({
                success: false,
                message: 'Error al enviar el email. Verifica la configuración del servidor de correo.'
            });
        }
    } catch (error) {
        console.error('❌ Error en /api/password-reset:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
