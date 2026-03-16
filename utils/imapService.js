// ═══════════════════════════════════════════════════════════
// SERVICIO IMAP - Lectura de bandeja info@
// Usa ImapFlow para conectar al buzón de EMAIL_INFO_USER
// ═══════════════════════════════════════════════════════════

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function getImapConfig() {
    return {
        host: process.env.IMAP_HOST || 'imap.hostinger.com',
        port: parseInt(process.env.IMAP_PORT || '993'),
        secure: true,
        auth: {
            user: process.env.EMAIL_INFO_USER,
            pass: process.env.EMAIL_INFO_PASSWORD,
        },
        logger: false,
    };
}

/**
 * Fetch recent messages from a mailbox folder.
 * @param {string} folder  IMAP folder name (e.g. 'INBOX', 'Sent', 'INBOX.Sent')
 * @param {number} limit   Max messages to return (default 30)
 * @param {number} page    1-based page number
 * @returns {Promise<{messages: Array, total: number}>}
 */
async function fetchMessages(folder = 'INBOX', limit = 30, page = 1) {
    if (!process.env.EMAIL_INFO_USER || !process.env.EMAIL_INFO_PASSWORD) {
        throw new Error('EMAIL_INFO_USER / EMAIL_INFO_PASSWORD no configurados');
    }

    const client = new ImapFlow(getImapConfig());

    try {
        await client.connect();

        const lock = await client.getMailboxLock(folder);
        try {
            const mailbox = client.mailbox;
            const total = mailbox.exists || 0;

            if (total === 0) {
                return { messages: [], total: 0 };
            }

            // Calculate range (newest first)
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

            // Sort newest first
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
 * @param {number} uid     The IMAP UID
 * @param {string} folder  IMAP folder (default 'INBOX')
 * @returns {Promise<Object>}
 */
async function fetchEmailByUid(uid, folder = 'INBOX') {
    if (!process.env.EMAIL_INFO_USER || !process.env.EMAIL_INFO_PASSWORD) {
        throw new Error('EMAIL_INFO_USER / EMAIL_INFO_PASSWORD no configurados');
    }

    const client = new ImapFlow(getImapConfig());

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
 * @param {string} rawMessage  The full RFC822 message source
 */
async function appendToSent(rawMessage) {
    if (!process.env.EMAIL_INFO_USER || !process.env.EMAIL_INFO_PASSWORD) {
        console.error('[IMAP] Cannot append to Sent: EMAIL_INFO credentials not configured');
        return;
    }

    const client = new ImapFlow(getImapConfig());

    try {
        await client.connect();

        // Try common Sent folder names (Hostinger uses "Sent")
        const folders = ['Sent', 'INBOX.Sent', 'Sent Messages', 'Sent Items'];
        let appended = false;

        for (const folder of folders) {
            try {
                await client.append(folder, rawMessage, ['\\Seen'], new Date());
                console.log(`[IMAP] Message appended to ${folder}`);
                appended = true;
                break;
            } catch (e) {
                // Folder doesn't exist, try next
            }
        }

        if (!appended) {
            console.error('[IMAP] Could not find Sent folder to append message');
        }
    } catch (err) {
        console.error('[IMAP] Error appending to Sent:', err.message);
    } finally {
        await client.logout();
    }
}

// Convenience wrappers
const fetchInboxMessages = (limit, page) => fetchMessages('INBOX', limit, page);
const fetchSentMessages = (limit, page) => fetchMessages('Sent', limit, page);
const fetchInboxEmail = (uid) => fetchEmailByUid(uid, 'INBOX');
const fetchSentEmail = (uid) => fetchEmailByUid(uid, 'Sent');

module.exports = {
    fetchMessages,
    fetchEmailByUid,
    fetchInboxMessages,
    fetchSentMessages,
    fetchInboxEmail,
    fetchSentEmail,
    appendToSent,
};
