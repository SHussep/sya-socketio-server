// ═══════════════════════════════════════════════════════════
// SERVICIO IMAP - Lectura de bandeja de entrada (info@)
// Usa ImapFlow para conectar al buzón de EMAIL_INFO_USER
// ═══════════════════════════════════════════════════════════

const { ImapFlow } = require('imapflow');

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
 * Fetch recent inbox messages (headers + preview only).
 * @param {number} limit  Max messages to return (default 30)
 * @param {number} page   1-based page number
 * @returns {Promise<{messages: Array, total: number}>}
 */
async function fetchInboxMessages(limit = 30, page = 1) {
    if (!process.env.EMAIL_INFO_USER || !process.env.EMAIL_INFO_PASSWORD) {
        throw new Error('EMAIL_INFO_USER / EMAIL_INFO_PASSWORD no configurados');
    }

    const client = new ImapFlow(getImapConfig());

    try {
        await client.connect();

        const lock = await client.getMailboxLock('INBOX');
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

                messages.push({
                    uid: msg.uid,
                    seq: msg.seq,
                    from: from.address || '',
                    fromName: from.name || from.address || '',
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
 * @param {number} uid  The IMAP UID
 * @returns {Promise<Object>}
 */
async function fetchEmailByUid(uid) {
    if (!process.env.EMAIL_INFO_USER || !process.env.EMAIL_INFO_PASSWORD) {
        throw new Error('EMAIL_INFO_USER / EMAIL_INFO_PASSWORD no configurados');
    }

    const client = new ImapFlow(getImapConfig());

    try {
        await client.connect();

        const lock = await client.getMailboxLock('INBOX');
        try {
            // Fetch envelope + full source
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

            // Parse the raw source to extract html and text parts
            const { simpleParser } = require('mailparser');
            const parsed = await simpleParser(msg.source);

            return {
                uid: msg.uid,
                from: from.address || '',
                fromName: from.name || from.address || '',
                to: to.address || '',
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

module.exports = { fetchInboxMessages, fetchEmailByUid };
