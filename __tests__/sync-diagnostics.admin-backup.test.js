/**
 * Tests for Task 25 — admin endpoints for full-backup on-demand.
 *
 *   POST /api/sync-diagnostics/admin/request-backup   (super-admin)
 *   POST /api/sync-diagnostics/backup-upload          (HS256 upload token)
 *   GET  /api/sync-diagnostics/admin/backup/:reqId    (super-admin)
 *
 * Uses an ephemeral RSA keypair for the super-admin (RS256) and a test
 * HS256 secret for the upload token.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sya-backup-'));
const privPath = path.join(tmpDir, 'priv.pem');
const pubPath = path.join(tmpDir, 'pub.pem');
const storageDir = path.join(tmpDir, 'storage');
fs.writeFileSync(privPath, privateKey);
fs.writeFileSync(pubPath, publicKey);

process.env.SUPER_ADMIN_PRIVATE_KEY_PATH = privPath;
process.env.SUPER_ADMIN_PUBLIC_KEY_PATH = pubPath;
process.env.BACKUP_UPLOAD_SECRET = 'test-upload-secret-hs256';
process.env.BACKUP_DOWNLOAD_SECRET = 'test-download-secret-hs256';
process.env.BACKUP_STORAGE_DRIVER = 'fs';
process.env.BACKUP_STORAGE_DIR = storageDir;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../database', () => ({
    pool: { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) }
}));

const express = require('express');
const request = require('supertest');

function signSuperAdminJwt({ tenants = [83], userId = 7, expiresIn = '5m' } = {}) {
    return jwt.sign(
        {
            sub: String(userId),
            role: 'super_admin',
            authorizedTenants: tenants,
            jti: crypto.randomUUID()
        },
        privateKey,
        { algorithm: 'RS256', audience: 'sync-diagnostics-admin', expiresIn }
    );
}

function signUploadToken(reqId, deviceId = 'dev-1', opts = {}) {
    return jwt.sign(
        { reqId, deviceId, scope: opts.scope || 'backup_upload' },
        process.env.BACKUP_UPLOAD_SECRET,
        { algorithm: 'HS256', expiresIn: opts.expiresIn || '15m' }
    );
}

function makeApp(pool, io) {
    let router;
    jest.isolateModules(() => {
        router = require('../routes/sync-diagnostics')(pool, io);
    });
    const app = express();
    app.use('/api/sync-diagnostics', router);
    return app;
}

function makeIoMock(sockets = []) {
    return {
        in: jest.fn().mockReturnValue({
            fetchSockets: jest.fn().mockResolvedValue(sockets)
        })
    };
}

// ════════════════════════════════════════════════════════════════════
describe('POST /api/sync-diagnostics/admin/request-backup', () => {
    test('400 when missing fields', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool, null);
        const res = await request(app)
            .post('/api/sync-diagnostics/admin/request-backup')
            .set('Authorization', `Bearer ${signSuperAdminJwt({ tenants: [83] })}`)
            .send({ tenantId: 83 }); // missing deviceId
        expect(res.status).toBe(400);
    });

    test('403 when tenant not authorized', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool, null);
        const res = await request(app)
            .post('/api/sync-diagnostics/admin/request-backup')
            .set('Authorization', `Bearer ${signSuperAdminJwt({ tenants: [1] })}`)
            .send({ tenantId: 83, deviceId: 'dev-1', branchId: 114 });
        // superAdminAuth catches req.body.tenantId mismatch first → 403.
        expect(res.status).toBe(403);
    });

    test('happy path returns reqId + expiresAt, inserts pending row', async () => {
        // pool.query is called twice: INSERT into sync_backup_requests, then
        // INSERT into sync_admin_command_log.
        const queryCalls = [];
        const pool = {
            query: jest.fn().mockImplementation((sql, params) => {
                queryCalls.push({ sql, params });
                return Promise.resolve({ rowCount: 1, rows: [] });
            })
        };
        const app = makeApp(pool, makeIoMock([]));
        const res = await request(app)
            .post('/api/sync-diagnostics/admin/request-backup')
            .set('Authorization', `Bearer ${signSuperAdminJwt({ tenants: [83] })}`)
            .send({ tenantId: 83, deviceId: 'dev-1', branchId: 114 });

        expect(res.status).toBe(200);
        expect(res.body.reqId).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.body.commandId).toMatch(/^[0-9a-f-]{36}$/);
        expect(res.body.delivered).toBe(0);
        expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

        // Backup request row is pending, command log is queued (no sockets).
        const insertBackup = queryCalls.find(c => /INTO sync_backup_requests/.test(c.sql));
        expect(insertBackup).toBeDefined();
        expect(insertBackup.sql).toMatch(/'pending'/);

        const insertCmdLog = queryCalls.find(c => /INTO sync_admin_command_log/.test(c.sql));
        expect(insertCmdLog).toBeDefined();
        expect(insertCmdLog.params).toContain('queued');
    });

    test('resolves branchId from census when not provided', async () => {
        const queryCalls = [];
        const pool = {
            query: jest.fn().mockImplementation((sql, params) => {
                queryCalls.push({ sql, params });
                if (/FROM sync_census_reports/.test(sql)) {
                    return Promise.resolve({ rowCount: 1, rows: [{ branch_id: 999 }] });
                }
                return Promise.resolve({ rowCount: 1, rows: [] });
            })
        };
        const app = makeApp(pool, makeIoMock([]));
        const res = await request(app)
            .post('/api/sync-diagnostics/admin/request-backup')
            .set('Authorization', `Bearer ${signSuperAdminJwt({ tenants: [83] })}`)
            .send({ tenantId: 83, deviceId: 'dev-1' });

        expect(res.status).toBe(200);
        const insertBackup = queryCalls.find(c => /INTO sync_backup_requests/.test(c.sql));
        expect(insertBackup.params).toContain(999); // branch_id resolved from census
    });

    test('400 when no branchId and no census available', async () => {
        const pool = {
            query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] })
        };
        const app = makeApp(pool, null);
        const res = await request(app)
            .post('/api/sync-diagnostics/admin/request-backup')
            .set('Authorization', `Bearer ${signSuperAdminJwt({ tenants: [83] })}`)
            .send({ tenantId: 83, deviceId: 'dev-1' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('branch_unknown_no_census');
    });
});

// ════════════════════════════════════════════════════════════════════
describe('POST /api/sync-diagnostics/backup-upload', () => {
    test('401 when missing token', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool, null);
        const res = await request(app)
            .post('/api/sync-diagnostics/backup-upload')
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.from('payload'));
        expect(res.status).toBe(401);
    });

    test('401 when token has wrong scope', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool, null);
        const token = signUploadToken('r1', 'dev-1', { scope: 'something_else' });
        const res = await request(app)
            .post('/api/sync-diagnostics/backup-upload')
            .set('Authorization', `Bearer ${token}`)
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.from('payload'));
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('bad_scope');
    });

    test('409 when backup request already uploaded (one-shot)', async () => {
        const reqId = crypto.randomUUID();
        const token = signUploadToken(reqId, 'dev-1');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const existing = {
            id: reqId,
            tenant_id: 83,
            device_id: 'dev-1',
            status: 'uploaded',
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            upload_token_hash: tokenHash
        };
        const clientQuery = jest.fn().mockImplementation((sql) => {
            if (/FOR UPDATE/.test(sql)) return Promise.resolve({ rowCount: 1, rows: [existing] });
            return Promise.resolve({ rowCount: 1, rows: [] });
        });
        const pool = {
            connect: jest.fn().mockResolvedValue({ query: clientQuery, release: jest.fn() }),
            query: jest.fn()
        };
        const app = makeApp(pool, null);
        const res = await request(app)
            .post('/api/sync-diagnostics/backup-upload')
            .set('Authorization', `Bearer ${token}`)
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.from('payload'));
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('token_consumed_or_stale');
    });

    test('410 when expired', async () => {
        const reqId = crypto.randomUUID();
        const token = signUploadToken(reqId, 'dev-1');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const existing = {
            id: reqId,
            tenant_id: 83,
            device_id: 'dev-1',
            status: 'pending',
            expires_at: new Date(Date.now() - 10_000).toISOString(),
            upload_token_hash: tokenHash
        };
        const clientQuery = jest.fn().mockImplementation((sql) => {
            if (/FOR UPDATE/.test(sql)) return Promise.resolve({ rowCount: 1, rows: [existing] });
            return Promise.resolve({ rowCount: 1, rows: [] });
        });
        const pool = {
            connect: jest.fn().mockResolvedValue({ query: clientQuery, release: jest.fn() }),
            query: jest.fn()
        };
        const app = makeApp(pool, null);
        const res = await request(app)
            .post('/api/sync-diagnostics/backup-upload')
            .set('Authorization', `Bearer ${token}`)
            .set('Content-Type', 'application/octet-stream')
            .send(Buffer.from('payload'));
        expect(res.status).toBe(410);
    });
});

// ════════════════════════════════════════════════════════════════════
describe('GET /api/sync-diagnostics/admin/backup/:reqId', () => {
    test('404 when not found', async () => {
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
        const app = makeApp(pool, null);
        const res = await request(app)
            .get('/api/sync-diagnostics/admin/backup/' + crypto.randomUUID())
            .set('Authorization', `Bearer ${signSuperAdminJwt({ tenants: [83] })}`);
        expect(res.status).toBe(404);
    });

    test('403 when cross-tenant', async () => {
        const row = { id: 'r1', tenant_id: 83, status: 'uploaded', storage_key: 'k', size_bytes: 10 };
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [row] }) };
        const app = makeApp(pool, null);
        const res = await request(app)
            .get('/api/sync-diagnostics/admin/backup/r1')
            .set('Authorization', `Bearer ${signSuperAdminJwt({ tenants: [1] })}`);
        expect(res.status).toBe(403);
    });

    test('409 when not uploaded yet', async () => {
        const row = { id: 'r1', tenant_id: 83, status: 'pending' };
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [row] }) };
        const app = makeApp(pool, null);
        const res = await request(app)
            .get('/api/sync-diagnostics/admin/backup/r1')
            .set('Authorization', `Bearer ${signSuperAdminJwt({ tenants: [83] })}`);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('not_uploaded');
    });

    test('happy path returns signed URL', async () => {
        const row = {
            id: 'r1',
            tenant_id: 83,
            status: 'uploaded',
            storage_key: 'backups/83/dev-1/r1.enc',
            size_bytes: 1234,
            uploaded_at: new Date().toISOString()
        };
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [row] }) };
        const app = makeApp(pool, null);
        const res = await request(app)
            .get('/api/sync-diagnostics/admin/backup/r1')
            .set('Authorization', `Bearer ${signSuperAdminJwt({ tenants: [83] })}`);
        expect(res.status).toBe(200);
        expect(res.body.url).toMatch(/backup-download\?token=/);
        expect(res.body.sizeBytes).toBe(1234);
    });
});

afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});
