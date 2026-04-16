// ═══════════════════════════════════════════════════════════════
// Task 8: POST /api/sync-diagnostics/verify
// Minimal express app to avoid loading the full server (see census test).
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

describe('POST /api/sync-diagnostics/verify', () => {
    let app, token;

    beforeAll(() => {
        app = buildApp();
        token = jwt.sign(
            { tenantId: 2, branchId: 2, userId: 1 },
            process.env.JWT_SECRET,
            { algorithm: 'HS256' }
        );
    });

    it('returns exists=false for unknown globalId', async () => {
        const res = await request(app)
            .post('/api/sync-diagnostics/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({
                entityType: 'Venta',
                globalId: '00000000-0000-0000-0000-000000000000'
            });
        expect(res.status).toBe(200);
        expect(res.body.exists).toBe(false);
    });

    it('rejects unsupported entityType', async () => {
        const res = await request(app)
            .post('/api/sync-diagnostics/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({
                entityType: 'DROP TABLE',
                globalId: 'x'
            });
        expect(res.status).toBe(400);
    });

    it('rejects missing globalId (ajv schema)', async () => {
        const res = await request(app)
            .post('/api/sync-diagnostics/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ entityType: 'Venta' });
        expect(res.status).toBe(400);
    });

    it('requires auth', async () => {
        const res = await request(app)
            .post('/api/sync-diagnostics/verify')
            .send({ entityType: 'Venta', globalId: 'x' });
        expect(res.status).toBe(401);
    });
});
