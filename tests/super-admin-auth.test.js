// ═══════════════════════════════════════════════════════════════
// TEST: superAdminAuth middleware (RS256)
// ═══════════════════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// Mock the database module BEFORE requiring the middleware
jest.mock('../database', () => ({
    pool: { query: jest.fn() }
}));

const { pool } = require('../database');
const superAdminAuth = require('../middleware/superAdminAuth');

describe('superAdminAuth middleware (RS256)', () => {
    let privateKey, publicKey;

    beforeAll(() => {
        const { generateKeyPairSync } = require('crypto');
        const kp = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        privateKey = kp.privateKey;
        publicKey = kp.publicKey;
        process.env.SUPER_ADMIN_PUBLIC_KEY_PATH = path.join(__dirname, 'tmp-pub.pem');
        fs.writeFileSync(process.env.SUPER_ADMIN_PUBLIC_KEY_PATH, publicKey);
    });

    afterAll(() => {
        try { fs.unlinkSync(process.env.SUPER_ADMIN_PUBLIC_KEY_PATH); } catch (e) { /* ignore */ }
    });

    beforeEach(() => {
        // Default: no revocations
        pool.query.mockReset();
        pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
    });

    const mkReq = (token, body = {}) => ({
        headers: { authorization: `Bearer ${token}` },
        body,
        query: {},
        ip: '127.0.0.1'
    });
    const mkRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

    it('rejects HS256-signed tokens (algorithm confusion guard)', async () => {
        const token = jwt.sign({ role: 'super_admin', authorizedTenants: [52] }, 'some-hs-secret');
        const res = mkRes();
        const next = jest.fn();
        await superAdminAuth(mkReq(token, { tenantId: 52 }), res, next);
        expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects when authorizedTenants does not include requested tenant', async () => {
        const token = jwt.sign(
            { sub: 1, role: 'super_admin', authorizedTenants: [99], jti: 'abc', aud: 'sync-diagnostics-admin' },
            privateKey,
            { algorithm: 'RS256', expiresIn: '60m' }
        );
        const res = mkRes();
        const next = jest.fn();
        await superAdminAuth(mkReq(token, { tenantId: 52 }), res, next);
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it('accepts a valid super-admin token for authorized tenant', async () => {
        const token = jwt.sign(
            { sub: 1, role: 'super_admin', authorizedTenants: [52], jti: 'xyz', aud: 'sync-diagnostics-admin' },
            privateKey,
            { algorithm: 'RS256', expiresIn: '60m' }
        );
        const res = mkRes();
        const next = jest.fn();
        const req = mkReq(token, { tenantId: 52 });
        await superAdminAuth(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(req.superAdmin.authorizedTenants).toEqual([52]);
    });

    it('rejects when jti is revoked', async () => {
        const token = jwt.sign(
            { sub: 1, role: 'super_admin', authorizedTenants: [52], jti: 'revoked-jti', aud: 'sync-diagnostics-admin' },
            privateKey,
            { algorithm: 'RS256', expiresIn: '60m' }
        );
        // Mock revocation lookup returning 1 row (token IS revoked)
        pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] });

        const res = mkRes();
        const next = jest.fn();
        await superAdminAuth(mkReq(token, { tenantId: 52 }), res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'token_revoked' }));
        expect(next).not.toHaveBeenCalled();
    });
});
