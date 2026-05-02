// __tests__/super-admin-backups.test.js
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sya-sa-backups-'));
const privPath = path.join(tmpDir, 'priv.pem');
const pubPath = path.join(tmpDir, 'pub.pem');
fs.writeFileSync(privPath, privateKey);
fs.writeFileSync(pubPath, publicKey);
process.env.SUPER_ADMIN_PRIVATE_KEY_PATH = privPath;
process.env.SUPER_ADMIN_PUBLIC_KEY_PATH = pubPath;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// NOTE: this module-level mock is consumed by `superAdminAuth` middleware,
// which queries `super_admin_jwt_revocations` on every authenticated request.
// `mockResolvedValue` is required (a bare jest.fn() returns undefined → middleware crashes).
jest.mock('../database', () => ({
    pool: { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) }
}));
jest.mock('../utils/dropbox-manager', () => ({ getClient: jest.fn() }));

const expressLib = require('express');
const request = require('supertest');
const superAdminAuth = require('../middleware/superAdminAuth');

function signSuperAdminJwt({ tenants = [], userId = 1, expiresIn = '5m' } = {}) {
    return jwt.sign(
        { sub: String(userId), role: 'super_admin', authorizedTenants: tenants, jti: crypto.randomUUID() },
        privateKey,
        { algorithm: 'RS256', audience: 'sync-diagnostics-admin', expiresIn }
    );
}

function makeApp(pool) {
    let router;
    jest.isolateModules(() => {
        router = require('../routes/super-admin-backups')(pool);
    });
    const app = expressLib();
    app.use(expressLib.json());
    app.use('/api/super-admin/backups', superAdminAuth, router);
    return app;
}

describe('GET /api/super-admin/backups/list', () => {
    test('401 when no Authorization header', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool);
        const res = await request(app).get('/api/super-admin/backups/list');
        expect(res.status).toBe(401);
    });

    test('empty list when DB has no backups', async () => {
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
        const app = makeApp(pool);
        const res = await request(app)
            .get('/api/super-admin/backups/list')
            .set('Authorization', `Bearer ${signSuperAdminJwt()}`);
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
            .set('Authorization', `Bearer ${signSuperAdminJwt()}`);
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

describe('super-admin-backups (placeholder)', () => {
    test('module loads', () => {
        const pool = { query: jest.fn() };
        expect(() => makeApp(pool)).not.toThrow();
    });
});
