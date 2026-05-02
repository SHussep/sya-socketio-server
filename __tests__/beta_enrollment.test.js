const request = require('supertest');
const express = require('express');

// Mock pool con un store en memoria que imita beta_enrollment_emails
function makeMockPool() {
    let nextId = 1;
    let rows = [];

    const sameTenant = (a, b) => String(a) === String(b);

    const query = jest.fn(async (sql, params = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (s.startsWith('SELECT COUNT(*)')) {
            const tenantId = params[0];
            return { rows: [{ c: rows.filter(r => sameTenant(r.tenant_id, tenantId)).length }] };
        }
        if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
            return { rows: [] };
        }
        if (s.startsWith('DELETE FROM beta_enrollment_emails')) {
            const [tenantId, keepLower] = params;
            rows = rows.filter(r =>
                !(sameTenant(r.tenant_id, tenantId) && !keepLower.includes(r.email.toLowerCase()))
            );
            return { rows: [] };
        }
        if (s.startsWith('INSERT INTO beta_enrollment_emails')) {
            const [tenantId, email, platform] = params;
            const existing = rows.find(r =>
                sameTenant(r.tenant_id, tenantId) && r.email.toLowerCase() === email.toLowerCase()
            );
            if (existing) {
                existing.platform = platform;
            } else {
                rows.push({
                    id: nextId++, tenant_id: tenantId, email, platform,
                    enrolled_at: new Date().toISOString(),
                    invitation_sent_at: null,
                });
            }
            return { rows: [] };
        }
        if (s.startsWith('SELECT id, email, platform, enrolled_at, invitation_sent_at FROM beta_enrollment_emails')) {
            const tenantId = params[0];
            return { rows: rows.filter(r => sameTenant(r.tenant_id, tenantId)) };
        }
        return { rows: [] };
    });

    return {
        connect: async () => ({ query, release: () => {} }),
        query,
    };
}

jest.mock('../utils/superadminNotifier', () => ({
    notifySuperadmins: jest.fn().mockResolvedValue(undefined),
}));

describe('POST /api/beta-enrollment', () => {
    let app;
    let pool;

    beforeEach(() => {
        pool = makeMockPool();
        app = express();
        app.use(express.json());
        app.use('/api/beta-enrollment', require('../routes/beta_enrollment')(pool));
    });

    test('rechaza sin tenant_id', async () => {
        const res = await request(app).post('/api/beta-enrollment').send({});
        expect(res.status).toBe(400);
    });

    test('acepta forma nueva con array', async () => {
        const res = await request(app).post('/api/beta-enrollment').send({
            tenant_id: 1,
            business_name: 'Test',
            emails: [
                { email: 'a@gmail.com', platform: 'android' },
                { email: 'b@icloud.com', platform: 'ios' },
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveLength(2);
    });

    test('compat shim: forma vieja con email único', async () => {
        const res = await request(app).post('/api/beta-enrollment').send({
            tenant_id: 1,
            email: 'legacy@gmail.com',
            platform: 'android',
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].email).toBe('legacy@gmail.com');
    });

    test('rechaza emails duplicados (case-insensitive)', async () => {
        const res = await request(app).post('/api/beta-enrollment').send({
            tenant_id: 1,
            emails: [
                { email: 'a@gmail.com', platform: 'android' },
                { email: 'A@gmail.com', platform: 'ios' },
            ],
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/duplicado/i);
    });

    test('rechaza más de 5 emails', async () => {
        const res = await request(app).post('/api/beta-enrollment').send({
            tenant_id: 1,
            emails: Array.from({ length: 6 }, (_, i) => ({
                email: `u${i}@gmail.com`, platform: 'android',
            })),
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/máximo 5/i);
    });

    test('reemplaza lista en POSTs sucesivos', async () => {
        await request(app).post('/api/beta-enrollment').send({
            tenant_id: 1,
            emails: [{ email: 'a@gmail.com', platform: 'android' }],
        });
        const res = await request(app).post('/api/beta-enrollment').send({
            tenant_id: 1,
            emails: [{ email: 'b@gmail.com', platform: 'ios' }],
        });
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].email).toBe('b@gmail.com');
    });
});

describe('GET /api/beta-enrollment/:tenantId', () => {
    let app;
    let pool;

    beforeEach(() => {
        pool = makeMockPool();
        app = express();
        app.use(express.json());
        app.use('/api/beta-enrollment', require('../routes/beta_enrollment')(pool));
    });

    test('regresa enrolled=false si no hay correos', async () => {
        const res = await request(app).get('/api/beta-enrollment/999');
        expect(res.status).toBe(200);
        expect(res.body.enrolled).toBe(false);
        expect(res.body.emails).toEqual([]);
    });

    test('regresa lista después de enroll', async () => {
        await request(app).post('/api/beta-enrollment').send({
            tenant_id: 1,
            emails: [{ email: 'a@gmail.com', platform: 'android' }],
        });
        const res = await request(app).get('/api/beta-enrollment/1');
        expect(res.body.enrolled).toBe(true);
        expect(res.body.emails).toHaveLength(1);
    });
});
