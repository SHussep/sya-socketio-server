/**
 * Tests for Task 18 — admin endpoints for quarantine management.
 *
 *   GET  /api/sync-diagnostics/admin/quarantine?tenantId=X&status=pending
 *   POST /api/sync-diagnostics/admin/quarantine/:id/decide
 *
 * Uses an ephemeral RSA keypair generated at test-bootstrap so the
 * superAdminAuth middleware (RS256 verification against
 * SUPER_ADMIN_PUBLIC_KEY_PATH) can validate tokens we sign here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// 1) Generate ephemeral RSA keypair and write to temp files *before*
//    requiring modules that load the key paths.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sya-admin-jwt-'));
const privPath = path.join(tmpDir, 'priv.pem');
const pubPath = path.join(tmpDir, 'pub.pem');
fs.writeFileSync(privPath, privateKey);
fs.writeFileSync(pubPath, publicKey);

process.env.SUPER_ADMIN_PRIVATE_KEY_PATH = privPath;
process.env.SUPER_ADMIN_PUBLIC_KEY_PATH = pubPath;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// The superAdminAuth middleware requires '../database' which in turn requires
// pool env vars. We stub the pool by mocking the module.
jest.mock('../database', () => ({
    pool: {
        query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] })
    }
}));

const express = require('express');
const request = require('supertest');

function signSuperAdminJwt({ tenants = [83], userId = 7, aud = 'sync-diagnostics-admin', expiresIn = '5m' } = {}) {
    return jwt.sign(
        {
            sub: String(userId),
            role: 'super_admin',
            authorizedTenants: tenants,
            jti: crypto.randomUUID()
        },
        privateKey,
        { algorithm: 'RS256', audience: aud, expiresIn }
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

describe('GET /api/sync-diagnostics/admin/quarantine', () => {
    test('returns pending rows when status=pending (default)', async () => {
        const rows = [{ id: 1, entity_type: 'Venta', admin_decision: null }];
        const pool = {
            query: jest.fn().mockResolvedValue({ rowCount: 1, rows }),
            connect: jest.fn()
        };
        const app = makeApp(pool, null);
        const token = signSuperAdminJwt({ tenants: [83] });

        const res = await request(app)
            .get('/api/sync-diagnostics/admin/quarantine?tenantId=83')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.rows).toEqual(rows);
        expect(pool.query).toHaveBeenCalledTimes(1);
        const sql = pool.query.mock.calls[0][0];
        expect(sql).toMatch(/admin_decision IS NULL/);
    });

    test('status=resolved filters on admin_decision IS NOT NULL', async () => {
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }), connect: jest.fn() };
        const app = makeApp(pool, null);
        const token = signSuperAdminJwt({ tenants: [83] });

        await request(app)
            .get('/api/sync-diagnostics/admin/quarantine?tenantId=83&status=resolved')
            .set('Authorization', `Bearer ${token}`);

        const sql = pool.query.mock.calls[0][0];
        expect(sql).toMatch(/admin_decision IS NOT NULL/);
    });

    test('403 when tenant not authorized for super-admin', async () => {
        const pool = { query: jest.fn(), connect: jest.fn() };
        const app = makeApp(pool, null);
        const token = signSuperAdminJwt({ tenants: [1] }); // only tenant 1 authorized

        const res = await request(app)
            .get('/api/sync-diagnostics/admin/quarantine?tenantId=83')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(403);
        expect(pool.query).not.toHaveBeenCalled();
    });

    test('401 when no bearer token', async () => {
        const pool = { query: jest.fn(), connect: jest.fn() };
        const app = makeApp(pool, null);
        const res = await request(app).get('/api/sync-diagnostics/admin/quarantine?tenantId=83');
        expect(res.status).toBe(401);
    });
});

describe('POST /api/sync-diagnostics/admin/quarantine/:id/decide', () => {
    function makePoolForDecide(row) {
        // Mock client (BEGIN/UPDATE/INSERT/COMMIT/ROLLBACK) + top-level pool.query
        const clientQuery = jest.fn().mockImplementation((sql) => {
            if (/FOR UPDATE/.test(sql)) {
                return Promise.resolve({ rowCount: row ? 1 : 0, rows: row ? [row] : [] });
            }
            return Promise.resolve({ rowCount: 1, rows: [] });
        });
        const client = { query: clientQuery, release: jest.fn() };
        const pool = {
            connect: jest.fn().mockResolvedValue(client),
            query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] })
        };
        return { pool, client, clientQuery };
    }

    function makeIoMock(sockets = []) {
        return {
            in: jest.fn().mockReturnValue({
                fetchSockets: jest.fn().mockResolvedValue(sockets)
            })
        };
    }

    const sampleRow = {
        id: 42,
        tenant_id: 83,
        branch_id: 114,
        device_id: 'device-abc',
        entity_type: 'Venta',
        entity_global_id: 'venta-xxx',
        entity_local_id: 5,
        admin_decision: null
    };

    test('action=release updates decision, writes audit log, emits to desktop', async () => {
        const { pool, clientQuery } = makePoolForDecide(sampleRow);
        const desktop = {
            clientType: 'desktop',
            deviceInfo: { deviceId: 'device-abc' },
            emit: jest.fn()
        };
        const io = makeIoMock([desktop]);
        const app = makeApp(pool, io);
        const token = signSuperAdminJwt({ tenants: [83], userId: 7 });

        const res = await request(app)
            .post('/api/sync-diagnostics/admin/quarantine/42/decide')
            .set('Authorization', `Bearer ${token}`)
            .send({ action: 'release', notes: 'Resolved after investigation' });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.commandId).toMatch(/^[0-9a-f-]+$/i);
        expect(res.body.eventName).toBe('admin:release_from_quarantine');
        expect(res.body.delivered).toBe(1);

        // BEGIN + SELECT..FOR UPDATE + UPDATE decision + INSERT command_log + COMMIT = 5
        expect(clientQuery).toHaveBeenCalled();
        const sqls = clientQuery.mock.calls.map(c => c[0]);
        expect(sqls.some(s => /BEGIN/.test(s))).toBe(true);
        expect(sqls.some(s => /FOR UPDATE/.test(s))).toBe(true);
        expect(sqls.some(s => /UPDATE sync_quarantine_reports/.test(s))).toBe(true);
        expect(sqls.some(s => /INSERT INTO sync_admin_command_log/.test(s))).toBe(true);
        expect(sqls.some(s => /COMMIT/.test(s))).toBe(true);

        // JSONB payload stringified (node-pg array-literal guard)
        const insertCall = clientQuery.mock.calls.find(c => /INSERT INTO sync_admin_command_log/.test(c[0]));
        expect(typeof insertCall[1][5]).toBe('string');
        expect(JSON.parse(insertCall[1][5])).toMatchObject({ entityType: 'Venta', globalId: 'venta-xxx' });

        // Socket emitted with expected payload shape
        expect(desktop.emit).toHaveBeenCalledWith('admin:release_from_quarantine', expect.objectContaining({
            commandId: expect.any(String),
            adminJwt: expect.any(String),
            entityType: 'Venta',
            globalId: 'venta-xxx'
        }));
    });

    test('action=discard emits admin:discard_quarantined', async () => {
        const { pool } = makePoolForDecide(sampleRow);
        const desktop = { clientType: 'desktop', deviceInfo: { deviceId: 'device-abc' }, emit: jest.fn() };
        const io = makeIoMock([desktop]);
        const app = makeApp(pool, io);
        const token = signSuperAdminJwt({ tenants: [83] });

        const res = await request(app)
            .post('/api/sync-diagnostics/admin/quarantine/42/decide')
            .set('Authorization', `Bearer ${token}`)
            .send({ action: 'discard' });

        expect(res.status).toBe(200);
        expect(res.body.eventName).toBe('admin:discard_quarantined');
        expect(desktop.emit).toHaveBeenCalledWith('admin:discard_quarantined', expect.any(Object));
    });

    test('action=force_synced emits admin:force_mark_synced', async () => {
        const { pool } = makePoolForDecide(sampleRow);
        const desktop = { clientType: 'desktop', deviceInfo: { deviceId: 'device-abc' }, emit: jest.fn() };
        const io = makeIoMock([desktop]);
        const app = makeApp(pool, io);
        const token = signSuperAdminJwt({ tenants: [83] });

        const res = await request(app)
            .post('/api/sync-diagnostics/admin/quarantine/42/decide')
            .set('Authorization', `Bearer ${token}`)
            .send({ action: 'force_synced' });

        expect(res.status).toBe(200);
        expect(res.body.eventName).toBe('admin:force_mark_synced');
        expect(desktop.emit).toHaveBeenCalledWith('admin:force_mark_synced', expect.any(Object));
    });

    test('rejects action outside enum (400)', async () => {
        const { pool, clientQuery } = makePoolForDecide(sampleRow);
        const app = makeApp(pool, makeIoMock([]));
        const token = signSuperAdminJwt({ tenants: [83] });

        const res = await request(app)
            .post('/api/sync-diagnostics/admin/quarantine/42/decide')
            .set('Authorization', `Bearer ${token}`)
            .send({ action: 'delete_everything' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_action');
        expect(clientQuery).not.toHaveBeenCalled();
    });

    test('404 when row does not exist', async () => {
        const { pool } = makePoolForDecide(null); // no row
        const app = makeApp(pool, makeIoMock([]));
        const token = signSuperAdminJwt({ tenants: [83] });

        const res = await request(app)
            .post('/api/sync-diagnostics/admin/quarantine/99999/decide')
            .set('Authorization', `Bearer ${token}`)
            .send({ action: 'release' });

        expect(res.status).toBe(404);
    });

    test('403 when super-admin not authorized for the row tenant', async () => {
        const { pool } = makePoolForDecide(sampleRow); // tenant 83 row
        const app = makeApp(pool, makeIoMock([]));
        const token = signSuperAdminJwt({ tenants: [1] }); // only tenant 1

        const res = await request(app)
            .post('/api/sync-diagnostics/admin/quarantine/42/decide')
            .set('Authorization', `Bearer ${token}`)
            .send({ action: 'release' });

        expect(res.status).toBe(403);
    });

    test('409 when row already has a decision', async () => {
        const decided = { ...sampleRow, admin_decision: 'discard' };
        const { pool } = makePoolForDecide(decided);
        const app = makeApp(pool, makeIoMock([]));
        const token = signSuperAdminJwt({ tenants: [83] });

        const res = await request(app)
            .post('/api/sync-diagnostics/admin/quarantine/42/decide')
            .set('Authorization', `Bearer ${token}`)
            .send({ action: 'release' });

        expect(res.status).toBe(409);
        expect(res.body.error).toBe('already_decided');
    });

    test('when no desktop connected, marks command as queued', async () => {
        const { pool } = makePoolForDecide(sampleRow);
        const app = makeApp(pool, makeIoMock([])); // no sockets
        const token = signSuperAdminJwt({ tenants: [83] });

        const res = await request(app)
            .post('/api/sync-diagnostics/admin/quarantine/42/decide')
            .set('Authorization', `Bearer ${token}`)
            .send({ action: 'release' });

        expect(res.status).toBe(200);
        expect(res.body.delivered).toBe(0);
        // pool.query (top-level) should have been called to mark status='queued'
        const queuedUpdate = pool.query.mock.calls.find(c => /SET status = 'queued'/.test(c[0]));
        expect(queuedUpdate).toBeDefined();
    });
});
