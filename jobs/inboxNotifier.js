// ═══════════════════════════════════════════════════════════
// JOB: Inbox Notifier
// Polea el INBOX cada N minutos. Cuando detecta UIDs nuevos,
// envía una push al SuperAdmin (SYAAdmin app).
// ═══════════════════════════════════════════════════════════

const { ImapFlow } = require('imapflow');
const { notifySuperadmins } = require('../utils/superadminNotifier');

let lastSeenUid = null; // Estado en memoria (se inicializa en primer run)

function getImapConfig() {
    return {
        host: process.env.EMAIL_INFO_HOST || 'imap.gmail.com',
        port: parseInt(process.env.EMAIL_INFO_PORT || '993'),
        secure: true,
        auth: {
            user: process.env.EMAIL_INFO_USER,
            pass: process.env.EMAIL_INFO_PASSWORD,
        },
        logger: false,
    };
}

/**
 * Polea el INBOX y dispara notificaciones para UIDs > lastSeenUid.
 */
async function checkInboxAndNotify() {
    if (!process.env.EMAIL_INFO_USER || !process.env.EMAIL_INFO_PASSWORD) {
        return; // IMAP no configurado, skip silencioso
    }

    const client = new ImapFlow(getImapConfig());

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');

        try {
            const total = client.mailbox.exists || 0;
            if (total === 0) return;

            // Primer run: marcar el último UID como visto y salir sin notificar
            if (lastSeenUid === null) {
                const latest = await client.fetchOne('*', { uid: true });
                lastSeenUid = latest ? latest.uid : 0;
                console.log(`[InboxNotifier] Inicializado lastSeenUid=${lastSeenUid}`);
                return;
            }

            // Buscar mensajes con UID > lastSeenUid
            const newMessages = [];
            for await (const msg of client.fetch(
                { uid: `${lastSeenUid + 1}:*` },
                { envelope: true, uid: true },
                { uid: true }
            )) {
                if (msg.uid > lastSeenUid) {
                    newMessages.push(msg);
                }
            }

            if (newMessages.length === 0) return;

            // Actualizar lastSeenUid al máximo encontrado
            const maxUid = newMessages.reduce(
                (acc, m) => (m.uid > acc ? m.uid : acc),
                lastSeenUid
            );

            // Construir payload de notificación
            if (newMessages.length === 1) {
                const m = newMessages[0];
                const fromName =
                    (m.envelope.from && m.envelope.from[0]?.name) ||
                    (m.envelope.from && m.envelope.from[0]?.address) ||
                    'Remitente desconocido';
                const subject = m.envelope.subject || '(sin asunto)';
                await notifySuperadmins('📬 Nuevo correo', `${fromName}: ${subject}`, {
                    type: 'inbox_new',
                    uid: m.uid,
                    from: fromName,
                    subject,
                });
            } else {
                await notifySuperadmins(
                    '📬 Nuevos correos',
                    `${newMessages.length} correos nuevos en la bandeja`,
                    {
                        type: 'inbox_new_multi',
                        count: newMessages.length,
                    }
                );
            }

            console.log(
                `[InboxNotifier] ${newMessages.length} correos nuevos (UID ${lastSeenUid + 1}..${maxUid})`
            );

            lastSeenUid = maxUid;
        } finally {
            lock.release();
        }
    } catch (err) {
        console.error('[InboxNotifier] Error:', err.message);
    } finally {
        try {
            await client.logout();
        } catch (_) {
            /* ignore */
        }
    }
}

module.exports = { checkInboxAndNotify };
