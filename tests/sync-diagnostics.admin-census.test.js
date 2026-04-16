// ═══════════════════════════════════════════════════════════════
// Task 12: GET /api/sync-diagnostics/admin/census
// Tests the super-admin-protected census query endpoint.
// Uses a minimal express app (same pattern as Task 8 tests) to avoid
// pulling in the full server (ESM jose/jwks-rsa issue).
//
// Strategy: mock ../middleware/superAdminAuth to inject req.superAdmin
// based on a test header `x-test-authorized` (JSON-serialized array).
// Missing header -> 401 (simulating missing token).
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const request = require('supertest');

// Mock the superAdminAuth middleware BEFORE requiring the route.
// The mock inspects a test-only header to simulate a decoded token.
jest.mock('../middleware/superAdminAuth', () => {
    return function mockSuperAdminAuth(req, res, next) {
        const header = req.headers['x-test-authorized'];
        if (header === undefined) {
            return res.status(401).json({ error: 'missing_token' });
        }
        let authorizedTenants;
        try {
            authorizedTenants = JSON.parse(header);
        } catch (e) {
            return res.status(401).json({ error: 'invalid_super_admin_token' });
        }
        req.superAdmin = {
            userId: 1,
            authorizedTenants,
            jti: 'test-jti'
        };
        next();
    };
});

const syncDiagnosticsRoutes = require('../routes/sync-diagnostics');
const { pool } = require('../database');

function buildApp() {
    const app = express();
    app.use(bodyParser.json());
    app.use('/api/sync-diagnostics', syncDiagnosticsRoutes(pool));
    return app;
}

const TEST_TENANT_ID = 2;
const TEST_BRANCH_ID = 2;
const insertedDeviceIds = new Set();

async function insertCensusRow(deviceId, overrides = {}) {
    insertedDeviceIds.add(deviceId);
    const takenAt = overrides.takenAt || new Date().toISOString();
    const r = await pool.query(
        `INSERT INTO sync_census_reports (
            tenant_id, branch_id, device_id, device_name, app_version,
            taken_at, summary, by_entity_type, suspicious_records, handler_stats
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
            overrides.tenantId || TEST_TENANT_ID,
            overrides.branchId || TEST_BRANCH_ID,
            deviceId,
            overrides.deviceName || 'ADMIN-CENSUS-TEST',
            overrides.appVersion || '2.1.0',
            takenAt,
            overrides.summary || { totalRecords: 5 },
            overrides.byEntityType || [],
            overrides.suspiciousRecords || null,
            overrides.handlerStats || null
        ]
    );
    return r.rows[0].id;
}

describe('GET /api/sync-diagnostics/admin/census', () => {
    let app;

    beforeAll(() => {
        app = buildApp();
    });

    afterAll(async () => {
        if (insertedDeviceIds.size > 0) {
            try {
                await pool.query(
                    `DELETE FROM sync_census_reports
                     WHERE device_id = ANY($1::text[])`,
                    [Array.from(insertedDeviceIds)]
                );
            } catch (e) {
                console.warn('[cleanup] could not delete admin-census rows:', e.message);
            }
        }
        // Do not close pool — shared across test files, jest --forceExit.
    });

    it('returns 401 without Authorization header (no x-test-authorized)', async () => {
        const res = await request(app)
            .get('/api/sync-diagnostics/admin/census')
            .query({ tenantId: TEST_TENANT_ID });
        expect(res.status).toBe(401);
    });

    it('returns 200 with valid token and returns { rows, count, limit }', async () => {
        const deviceId = 'admin-test-' + Date.now() + '-ok';
        await insertCensusRow(deviceId);

        const res = await request(app)
            .get('/api/sync-diagnostics/admin/census')
            .set('x-test-authorized', JSON.stringify([TEST_TENANT_ID]))
            .query({ tenantId: TEST_TENANT_ID });

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.rows)).toBe(true);
        expect(typeof res.body.count).toBe('number');
        expect(typeof res.body.limit).toBe('number');
        // We should see the row we just inserted somewhere in the list
        const found = res.body.rows.some(r => r.device_id === deviceId);
        expect(found).toBe(true);
    });

    it('returns 400 when tenantId is missing', async () => {
        const res = await request(app)
            .get('/api/sync-diagnostics/admin/census')
            .set('x-test-authorized', JSON.stringify([TEST_TENANT_ID]));
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_tenant_id');
    });

    it('returns 400 when tenantId is invalid (non-integer)', async () => {
        const res = await request(app)
            .get('/api/sync-diagnostics/admin/census')
            .set('x-test-authorized', JSON.stringify([TEST_TENANT_ID]))
            .query({ tenantId: 'not-a-number' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_tenant_id');
    });

    it('returns 403 when tenantId not in authorizedTenants', async () => {
        const res = await request(app)
            .get('/api/sync-diagnostics/admin/census')
            // Authorized only for tenant 999, but requesting tenant 2
            .set('x-test-authorized', JSON.stringify([999]))
            .query({ tenantId: TEST_TENANT_ID });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('tenant_not_authorized');
    });

    it('accepts wildcard "*" in authorizedTenants', async () => {
        const deviceId = 'admin-test-' + Date.now() + '-wild';
        await insertCensusRow(deviceId);

        const res = await request(app)
            .get('/api/sync-diagnostics/admin/census')
            .set('x-test-authorized', JSON.stringify(['*']))
            .query({ tenantId: TEST_TENANT_ID });
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.rows)).toBe(true);
    });

    it('filters by deviceId when provided', async () => {
        const deviceA = 'admin-test-' + Date.now() + '-filterA';
        const deviceB = 'admin-test-' + Date.now() + '-filterB';
        await insertCensusRow(deviceA);
        await insertCensusRow(deviceB);

        const res = await request(app)
            .get('/api/sync-diagnostics/admin/census')
            .set('x-test-authorized', JSON.stringify([TEST_TENANT_ID]))
            .query({ tenantId: TEST_TENANT_ID, deviceId: deviceA });

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.rows)).toBe(true);
        // All returned rows should match deviceA
        for (const r of res.body.rows) {
            expect(r.device_id).toBe(deviceA);
        }
        // And deviceA should be present
        expect(res.body.rows.some(r => r.device_id === deviceA)).toBe(true);
    });
});
