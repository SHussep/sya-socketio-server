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

describe('super-admin-backups (placeholder)', () => {
    test('module loads', () => {
        const pool = { query: jest.fn() };
        expect(() => makeApp(pool)).not.toThrow();
    });
});
