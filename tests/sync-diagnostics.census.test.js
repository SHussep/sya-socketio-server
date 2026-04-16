// ═══════════════════════════════════════════════════════════════
// Task 8: POST /api/sync-diagnostics/census
// Uses a minimal express app that mounts ONLY routes/sync-diagnostics.js
// to avoid loading the whole server (which imports ESM-only jose via jwks-rsa
// and fails Jest's default transform).
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const syncDiagnosticsRoutes = require('../routes/sync-diagnostics');
const { pool } = require('../database');

function buildApp() {
    const app = express();
    app.use(bodyParser.json());
    app.use('/api/sync-diagnostics', syncDiagnosticsRoutes(pool));
    return app;
}

const insertedDeviceIds = new Set();

describe('POST /api/sync-diagnostics/census', () => {
    let app, tenantToken;

    beforeAll(() => {
        app = buildApp();
        tenantToken = jwt.sign(
            { tenantId: 2, branchId: 2, userId: 1 },
            process.env.JWT_SECRET,
            { algorithm: 'HS256' }
        );
    });

    afterAll(async () => {
        if (insertedDeviceIds.size > 0) {
            try {
                await pool.query(
                    `DELETE FROM sync_census_reports
                     WHERE tenant_id = 2 AND device_id = ANY($1::text[])`,
                    [Array.from(insertedDeviceIds)]
                );
            } catch (e) {
                console.warn('[cleanup] could not delete census rows:', e.message);
            }
        }
        // Do not call pool.end() — the pool is shared with other test files
        // and jest runs with --forceExit.
    });

    it('accepts a valid census payload', async () => {
        const deviceId = 'test-device-' + Date.now() + '-a';
        insertedDeviceIds.add(deviceId);

        const res = await request(app)
            .post('/api/sync-diagnostics/census')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({
                tenantId: 2, branchId: 2,
                deviceId, deviceName: 'TEST', appVersion: '2.1.0',
                takenAt: new Date().toISOString(),
                summary: {
                    totalRecords: 10, pendingSync: 0, inQuarantine: 0,
                    autoResolvedToday: 0, failedSyncLogsUnresolved: 0
                },
                byEntityType: [],
                suspiciousRecords: [],
                handlerStats: []
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.id).toBe('string');
    });

    it('rejects when body.tenantId != jwt.tenantId', async () => {
        const res = await request(app)
            .post('/api/sync-diagnostics/census')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({
                tenantId: 99, branchId: 69, deviceId: 'x-' + Date.now(),
                takenAt: new Date().toISOString(),
                summary: {}, byEntityType: []
            });
        expect(res.status).toBe(403);
    });

    it('rejects extra properties (ajv strict)', async () => {
        const res = await request(app)
            .post('/api/sync-diagnostics/census')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send({
                tenantId: 2, branchId: 2, deviceId: 'x-' + Date.now(),
                takenAt: new Date().toISOString(),
                summary: {}, byEntityType: [],
                __hax: 'pwn'
            });
        expect(res.status).toBe(400);
    });

    it('enforces 1/hour rate limit per deviceId', async () => {
        const deviceId = 'rate-test-' + Date.now();
        insertedDeviceIds.add(deviceId);

        const payload = {
            tenantId: 2, branchId: 2, deviceId,
            takenAt: new Date().toISOString(),
            summary: {}, byEntityType: []
        };
        const first = await request(app)
            .post('/api/sync-diagnostics/census')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send(payload);
        expect(first.status).toBe(200);

        const second = await request(app)
            .post('/api/sync-diagnostics/census')
            .set('Authorization', `Bearer ${tenantToken}`)
            .send(payload);
        expect(second.status).toBe(429);
    });

    it('requires auth (401 without token)', async () => {
        const res = await request(app)
            .post('/api/sync-diagnostics/census')
            .send({
                tenantId: 2, branchId: 2, deviceId: 'noauth',
                takenAt: new Date().toISOString(),
                summary: {}, byEntityType: []
            });
        expect(res.status).toBe(401);
    });
});
