/**
 * Tests for POST /api/sync-diagnostics/quarantine (Task 17)
 *
 * Covers:
 *  - 200 on valid payload (first insert)
 *  - Upsert idempotency: second POST with same (tenant, device, type, globalId)
 *    while admin_decision IS NULL → 200 (not 409)
 *  - Cross-tenant mismatch: 403 via ensureSameTenant
 *  - Invalid payload → 400 via ajv
 *  - Payload > 5 MB → 413 via express.json limit
 *  - Rate limit: 31st request in window → 429
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-quarantine';
process.env.SUPER_ADMIN_PIN_HASH = process.env.SUPER_ADMIN_PIN_HASH || 'x';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// sync-diagnostics.js uses a module-scoped express.Router(), so we must reset
// modules between tests to avoid sharing registered routes (and the closures
// over previous `pool` mocks) across tests.
function makeApp(pool) {
    let router;
    jest.isolateModules(() => {
        router = require('../routes/sync-diagnostics')(pool);
    });
    const app = express();
    app.use('/api/sync-diagnostics', router);
    return app;
}

function makeToken(tenantId) {
    return jwt.sign({ tenantId, userId: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function makeValidBody(overrides = {}) {
    return {
        tenantId: 83,
        branchId: 114,
        deviceId: 'device-test-17',
        deviceName: 'Test Device',
        appVersion: '1.0.0',
        quarantinedAt: new Date().toISOString(),
        entity: {
            type: 'Venta',
            globalId: 'venta-global-abc-123',
            localId: 42,
            payload: { id: 42, total: 100 },
            description: 'Venta de prueba'
        },
        failure: {
            category: 'fk_missing',
            technicalMessage: 'Parent Shift not found after 3 cycles'
        },
        dependencies: [{ type: 'Shift', globalId: 'shift-xxx' }],
        verifyResult: { existsRemote: false },
        ...overrides
    };
}

describe('POST /api/sync-diagnostics/quarantine', () => {
    test('200 on valid payload and calls pool.query with JSON-stringified JSONB params', async () => {
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
        const app = makeApp(pool);
        const token = makeToken(83);

        const res = await request(app)
            .post('/api/sync-diagnostics/quarantine')
            .set('Authorization', `Bearer ${token}`)
            .send(makeValidBody());

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(pool.query).toHaveBeenCalledTimes(1);

        // Verify JSONB params are JSON-encoded strings (node-pg array-literal bug guard)
        const params = pool.query.mock.calls[0][1];
        // $10 = entity_payload, $12 = failure, $13 = dependencies, $14 = verify_result
        expect(typeof params[9]).toBe('string');   // entity_payload
        expect(typeof params[11]).toBe('string');  // failure
        expect(typeof params[12]).toBe('string');  // dependencies
        expect(typeof params[13]).toBe('string');  // verify_result
        expect(JSON.parse(params[12])).toEqual([{ type: 'Shift', globalId: 'shift-xxx' }]);
    });

    test('upsert idempotent: two successive POSTs with same keys return 200', async () => {
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
        const app = makeApp(pool);
        const token = makeToken(83);
        const body = makeValidBody({ deviceId: 'upsert-dev' });

        const res1 = await request(app)
            .post('/api/sync-diagnostics/quarantine')
            .set('Authorization', `Bearer ${token}`)
            .send(body);
        const res2 = await request(app)
            .post('/api/sync-diagnostics/quarantine')
            .set('Authorization', `Bearer ${token}`)
            .send(body);

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        expect(pool.query).toHaveBeenCalledTimes(2);
        // SQL should contain ON CONFLICT DO UPDATE (upsert, not 409)
        expect(pool.query.mock.calls[0][0]).toMatch(/ON CONFLICT.*DO UPDATE/s);
    });

    test('403 when body.tenantId differs from JWT tenantId', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool);
        const token = makeToken(1); // JWT tenant 1, body tenant 83

        const res = await request(app)
            .post('/api/sync-diagnostics/quarantine')
            .set('Authorization', `Bearer ${token}`)
            .send(makeValidBody({ deviceId: 'xtenant-dev' }));

        expect(res.status).toBe(403);
        expect(pool.query).not.toHaveBeenCalled();
    });

    test('400 when required field missing (ajv strict)', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool);
        const token = makeToken(83);
        const body = makeValidBody({ deviceId: 'bad-dev' });
        delete body.failure;

        const res = await request(app)
            .post('/api/sync-diagnostics/quarantine')
            .set('Authorization', `Bearer ${token}`)
            .send(body);

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(pool.query).not.toHaveBeenCalled();
    });

    test('413 when payload exceeds 5mb limit', async () => {
        const pool = { query: jest.fn() };
        const app = makeApp(pool);
        const token = makeToken(83);
        // Build a payload with >5MB of description text
        const huge = 'x'.repeat(6 * 1024 * 1024);
        const body = makeValidBody({ deviceId: 'huge-dev' });
        body.entity.payload = { blob: huge };

        const res = await request(app)
            .post('/api/sync-diagnostics/quarantine')
            .set('Authorization', `Bearer ${token}`)
            .send(body);

        expect(res.status).toBe(413);
        expect(pool.query).not.toHaveBeenCalled();
    });

    test('429 when more than 30 requests in window from same device', async () => {
        const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
        const app = makeApp(pool);
        const token = makeToken(83);
        const deviceId = `rate-limit-dev-${Date.now()}`; // unique per run to avoid map collision
        const body = makeValidBody({ deviceId });

        // First 30 should succeed
        for (let i = 0; i < 30; i++) {
            const res = await request(app)
                .post('/api/sync-diagnostics/quarantine')
                .set('Authorization', `Bearer ${token}`)
                .send(body);
            expect(res.status).toBe(200);
        }
        // 31st hits the rate limit
        const res = await request(app)
            .post('/api/sync-diagnostics/quarantine')
            .set('Authorization', `Bearer ${token}`)
            .send(body);
        expect(res.status).toBe(429);
    });
});
