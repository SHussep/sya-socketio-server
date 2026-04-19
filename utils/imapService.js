// ═══════════════════════════════════════════════════════════
// SERVICIO IMAP - Lectura de bandejas info@ y no-reply@
// Usa ImapFlow para conectar a las cuentas configuradas.
// Soporta credenciales genéricas para reutilizar con distintas cuentas.
// ═══════════════════════════════════════════════════════════

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const INFO_CREDS = {
    userVar: 'EMAIL_INFO_USER',
    passVar: 'EMAIL_INFO_PASSWORD',
    label: 'info',
};

const NOREPLY_CREDS = {
    userVar: 'EMAIL_USER',
    passVar: 'EMAIL_PASSWORD',
    label: 'no-reply',
};

function getImapConfig(creds = INFO_CREDS) {
    return {
        host: process.env.IMAP_HOST || 'imap.hostinger.com',
        port: parseInt(process.env.IMAP_PORT || '993'),
        secure: true,
        auth: {
            user: process.env[creds.userVar],
            pass: process.env[creds.passVar],
        },
        logger: false,
    };
}

function assertCreds(creds) {
    if (!process.env[creds.userVar] || !process.env[creds.passVar]) {
        throw new Error(`${creds.userVar} / ${creds.passVar} no configurados`);
    }
}

/**
 * Fetch recent messages from a mailbox folder.
 */
async function fetchMessages(folder = 'INBOX', limit = 30, page = 1, creds = INFO_CREDS) {
    assertCreds(creds);
    const client = new ImapFlow(getImapConfig(creds));

    try {
        await client.connect();

        const lock = await client.getMailboxLock(folder);
        try {
            const mailbox = client.mailbox;
            const total = mailbox.exists || 0;

            if (total === 0) {
                return { messages: [], total: 0 };
            }

            const end = total - (page - 1) * limit;
            const start = Math.max(1, end - limit + 1);

            if (end < 1) {
                return { messages: [], total };
            }

            const messages = [];

            for await (const msg of client.fetch(`${start}:${end}`, {
                envelope: true,
                flags: true,
                bodyStructure: true,
                headers: ['date'],
            })) {
                const env = msg.envelope;
                const from = env.from && env.from[0] ? env.from[0] : {};
                const to = env.to && env.to[0] ? env.to[0] : {};

                messages.push({
                    uid: msg.uid,
                    seq: msg.seq,
                    from: from.address || '',
                    fromName: from.name || from.address || '',
                    to: to.address || '',
                    toName: to.name || to.address || '',
                    subject: env.subject || '(sin asunto)',
                    date: env.date ? env.date.toISOString() : null,
                    isSeen: msg.flags.has('\\Seen'),
                    isFlagged: msg.flags.has('\\Flagged'),
                });
            }

            messages.sort((a, b) => new Date(b.date) - new Date(a.date));

            return { messages, total };
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
}

/**
 * Fetch a single email by UID with full body.
 */
async function fetchEmailByUid(uid, folder = 'INBOX', creds = INFO_CREDS) {
    assertCreds(creds);
    const client = new ImapFlow(getImapConfig(creds));

    try {
        await client.connect();

        const lock = await client.getMailboxLock(folder);
        try {
            const msg = await client.fetchOne(uid, {
                envelope: true,
                flags: true,
                source: true,
            }, { uid: true });

            if (!msg) {
                return null;
            }

            const env = msg.envelope;
            const from = env.from && env.from[0] ? env.from[0] : {};
            const to = env.to && env.to[0] ? env.to[0] : {};

            const parsed = await simpleParser(msg.source);

            return {
                uid: msg.uid,
                from: from.address || '',
                fromName: from.name || from.address || '',
                to: to.address || '',
                toName: to.name || to.address || '',
                subject: env.subject || '(sin asunto)',
                date: env.date ? env.date.toISOString() : null,
                isSeen: msg.flags.has('\\Seen'),
                htmlBody: parsed.html || null,
                textBody: parsed.text || null,
            };
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
}

/**
 * Append a sent message to the Sent folder so it shows in IMAP.
 * Uses the specified credentials' Sent folder (default: info@).
 */
async function appendToSent(rawMessage, creds = INFO_CREDS) {
    if (!process.env[creds.userVar] || !process.env[creds.passVar]) {
        console.error(`[IMAP] Cannot append to Sent (${creds.label}): credentials not configured`);
        return;
    }

    const client = new ImapFlow(getImapConfig(creds));

    try {
        await client.connect();

        const folders = ['Sent', 'INBOX.Sent', 'Sent Messages', 'Sent Items'];
        let appended = false;

        for (const folder of folders) {
            try {
                await client.append(folder, rawMessage, ['\\Seen'], new Date());
                console.log(`[IMAP] Message appended to ${creds.label}/${folder}`);
                appended = true;
                break;
            } catch (e) {
                // Folder doesn't exist, try next
            }
        }

        if (!appended) {
            console.error(`[IMAP] Could not find Sent folder for ${creds.label}`);
        }
    } catch (err) {
        console.error(`[IMAP] Error appending to Sent (${creds.label}):`, err.message);
    } finally {
        await client.logout();
    }
}

// Convenience wrappers — info@ (default)
const fetchInboxMessages = (limit, page) => fetchMessages('INBOX', limit, page, INFO_CREDS);
const fetchSentMessages = (limit, page) => fetchMessages('Sent', limit, page, INFO_CREDS);
const fetchInboxEmail = (uid) => fetchEmailByUid(uid, 'INBOX', INFO_CREDS);
const fetchSentEmail = (uid) => fetchEmailByUid(uid, 'Sent', INFO_CREDS);

// Convenience wrappers — no-reply@
const fetchNoReplySentMessages = (limit, page) =>
    fetchMessages('Sent', limit, page, NOREPLY_CREDS);
const fetchNoReplySentEmail = (uid) =>
    fetchEmailByUid(uid, 'Sent', NOREPLY_CREDS);

module.exports = {
    fetchMessages,
    fetchEmailByUid,
    fetchInboxMessages,
    fetchSentMessages,
    fetchInboxEmail,
    fetchSentEmail,
    fetchNoReplySentMessages,
    fetchNoReplySentEmail,
    appendToSent,
    INFO_CREDS,
    NOREPLY_CREDS,
};
