// __tests__/super-admin-backups.test.js
// Auth scheme: requireSuperAdminPIN (middleware/auth.js) reads
// SUPER_ADMIN_PIN_HASH at module-load time, so the env var must be set
// BEFORE the middleware is required.

const crypto = require('crypto');

const TEST_PIN = '1234';
process.env.SUPER_ADMIN_PIN_HASH = crypto.createHash('sha256').update(TEST_PIN).digest('hex');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../utils/dropbox-manager', () => ({ getClient: jest.fn() }));

const expressLib = require('express');
const request = require('supertest');
const { requireSuperAdminPIN } = require('../middleware/auth');

function makeApp(pool) {
    let router;
    jest.isolateModules(() => {
        router = require('../routes/super-admin-backups')(pool);
    });
    const app = expressLib();
    app.use(expressLib.json());
    app.use('/api/super-admin/backups', requireSuperAdminPIN, router);
    return app;
}

describe('GET /api/super-admin/backups/list', () => {
    test('401 when no x-admin-pin header', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool);
        const res = await request(app).get('/api/super-admin/backups/list');
        expect(res.status).toBe(401);
    });

    test('403 when x-admin-pin is wrong', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool);
        const res = await request(app)
            .get('/api/super-admin/backups/list')
            .set('x-admin-pin', '9999');
        expect(res.status).toBe(403);
    });

    test('empty list when DB has no backups', async () => {
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
        const app = makeApp(pool);
        const res = await request(app)
            .get('/api/super-admin/backups/list')
            .set('x-admin-pin', TEST_PIN);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ tenants: [] });
    });

    test('groups branches under tenants and sorts by latest_backup_at desc', async () => {
        const rows = [
            { tenant_id: 9, tenant_name: 'El Sol',  owner_email: 'a@s.com', branch_id: 22, branch_name: 'B22', backup_id: 99, backup_filename: 'f99', backup_path: '/sol/22/f99', file_size_bytes: 100, created_at: '2026-04-30T10:00:00Z', device_name: 'D2' },
            { tenant_id: 7, tenant_name: 'Esquina', owner_email: 'b@s.com', branch_id: 13, branch_name: 'Norte', backup_id: 90, backup_filename: 'f90', backup_path: '/esq/13/f90', file_size_bytes: 200, created_at: '2026-04-30T08:02:11Z', device_name: 'D3' },
            { tenant_id: 7, tenant_name: 'Esquina', owner_email: 'b@s.com', branch_id: 12, branch_name: 'Centro', backup_id: 91, backup_filename: 'f91', backup_path: '/esq/12/f91', file_size_bytes: 300, created_at: '2026-05-01T18:14:23Z', device_name: 'D1' }
        ];
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: rows.length, rows }) };
        const app = makeApp(pool);
        const res = await request(app)
            .get('/api/super-admin/backups/list')
            .set('x-admin-pin', TEST_PIN);
        expect(res.status).toBe(200);
        expect(res.body.tenants).toHaveLength(2);
        expect(res.body.tenants[0].tenant_id).toBe(7);
        expect(res.body.tenants[0].latest_backup_at).toBe('2026-05-01T18:14:23.000Z');
        expect(res.body.tenants[0].branches).toHaveLength(2);
        expect(res.body.tenants[0].branches[0].branch_id).toBe(12);
        expect(res.body.tenants[0].branches[1].branch_id).toBe(13);
        expect(res.body.tenants[1].tenant_id).toBe(9);
        expect(res.body.tenants[0].branches[0].backup_path).toBeUndefined();
    });
});

describe('POST /api/super-admin/backups/temp-link', () => {
    test('400 when backup_id missing', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool);
        const res = await request(app)
            .post('/api/super-admin/backups/temp-link')
            .set('x-admin-pin', TEST_PIN)
            .send({});
        expect(res.status).toBe(400);
    });

    test('404 when backup_id not found', async () => {
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
        const app = makeApp(pool);
        const res = await request(app)
            .post('/api/super-admin/backups/temp-link')
            .set('x-admin-pin', TEST_PIN)
            .send({ backup_id: 9999 });
        expect(res.status).toBe(404);
    });

    test('200 returns temp_link and expires_at on success', async () => {
        const dropboxManager = require('../utils/dropbox-manager');
        dropboxManager.getClient.mockResolvedValue({
            filesGetTemporaryLink: jest.fn().mockResolvedValue({
                result: { link: 'https://dl.dropboxusercontent.com/abc123' }
            })
        });
        const pool = { query: jest.fn().mockResolvedValue({
            rowCount: 1, rows: [{ backup_path: '/tenants/7/branches/12/backup.sdf' }]
        }) };
        const app = makeApp(pool);
        const before = Date.now();
        const res = await request(app)
            .post('/api/super-admin/backups/temp-link')
            .set('x-admin-pin', TEST_PIN)
            .send({ backup_id: 4521 });
        expect(res.status).toBe(200);
        expect(res.body.temp_link).toBe('https://dl.dropboxusercontent.com/abc123');
        const expires = new Date(res.body.expires_at).getTime();
        expect(expires).toBeGreaterThan(before + 4 * 3600_000 - 60_000);
        expect(expires).toBeLessThan(before + 4 * 3600_000 + 60_000);
    });

    test('502 when Dropbox call fails', async () => {
        const dropboxManager = require('../utils/dropbox-manager');
        dropboxManager.getClient.mockResolvedValue({
            filesGetTemporaryLink: jest.fn().mockRejectedValue(new Error('dropbox boom'))
        });
        const pool = { query: jest.fn().mockResolvedValue({
            rowCount: 1, rows: [{ backup_path: '/x' }]
        }) };
        const app = makeApp(pool);
        const res = await request(app)
            .post('/api/super-admin/backups/temp-link')
            .set('x-admin-pin', TEST_PIN)
            .send({ backup_id: 1 });
        expect(res.status).toBe(502);
    });
});
