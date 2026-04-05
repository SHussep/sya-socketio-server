const { io } = require('socket.io-client');
const { Pool } = require('pg');

const SERVER_URL = process.env.TEST_SERVER_URL || 'http://localhost:3001';
const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Pool config — Render requires SSL
const POOL_CONFIG = {
    connectionString: TEST_DB_URL,
    ssl: TEST_DB_URL && !TEST_DB_URL.includes('localhost') ? { rejectUnauthorized: false } : false
};

// Auth token — single JWT with admin/tenant access
const TEST_TOKEN = process.env.TEST_TOKEN;

// Create a connected, authenticated socket for a given employee+branch
async function createSocket({ employeeId, branchId, tenantId = 1, clientType = 'desktop' }) {
    const socket = io(SERVER_URL, {
        auth: { token: TEST_TOKEN },
        transports: ['websocket'],
        forceNew: true
    });

    await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
        setTimeout(() => reject(new Error('Socket connect timeout')), 5000);
    });

    // Identify client
    socket.emit('identify_client', {
        type: clientType,
        employeeId,
        tenantId,
        branchId
    });

    // Join branch room (sets socket.branchId on server)
    socket.emit('join_branch', branchId);
    await new Promise(r => setTimeout(r, 200));

    return socket;
}

// Create a socket that joined via join_all_branches (admin/supervisor — no s.branchId set)
async function createAdminSocket({ employeeId, branchIds, tenantId = 1 }) {
    const socket = io(SERVER_URL, {
        auth: { token: TEST_TOKEN },
        transports: ['websocket'],
        forceNew: true
    });

    await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('connect_error', reject);
        setTimeout(() => reject(new Error('Socket connect timeout')), 5000);
    });

    socket.emit('identify_client', { type: 'desktop', employeeId, tenantId });
    socket.emit('join_all_branches', branchIds); // Does NOT set socket.branchId
    await new Promise(r => setTimeout(r, 200));

    return socket;
}

// Create test employee + shift in DB
async function seedTestData(pool, { employeeId, branchId, tenantId = 1, hasActiveShift = false }) {
    // Ensure test branch exists (FK on shifts.branch_id)
    await pool.query(`
        INSERT INTO branches (id, tenant_id, branch_code, name)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO NOTHING
    `, [branchId, tenantId, `TEST_${branchId}`, `Test Branch ${branchId}`]);

    // NOT NULL columns: id, tenant_id, username, global_id
    await pool.query(`
        INSERT INTO employees (id, tenant_id, username, email, global_id)
        VALUES ($1, $2, $3, $4, gen_random_uuid())
        ON CONFLICT (id) DO NOTHING
    `, [employeeId, tenantId, `test_emp_${employeeId}`, `test${employeeId}@test.com`]);

    if (hasActiveShift) {
        // shifts requires: global_id, terminal_id, local_op_seq, created_local_utc (all NOT NULL)
        const result = await pool.query(`
            INSERT INTO shifts (employee_id, tenant_id, branch_id, is_cash_cut_open, initial_amount, start_time, terminal_id, global_id, local_op_seq, created_local_utc)
            VALUES ($1, $2, $3, true, 500, NOW(), $4, gen_random_uuid(), 1, NOW())
            RETURNING id
        `, [employeeId, tenantId, branchId, `test-terminal-${employeeId}`]);
        return result.rows[0].id;
    }
    return null;
}

// Cleanup test data — call in beforeEach AND afterAll for safety
async function cleanupTestData(pool, employeeIds, branchIds = []) {
    for (const empId of employeeIds) {
        await pool.query('DELETE FROM shifts WHERE employee_id = $1', [empId]);
        await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
    }
    for (const bId of branchIds) {
        await pool.query('DELETE FROM branches WHERE id = $1', [bId]);
    }
}

// Wait for a socket event with timeout
function waitForEvent(socket, eventName, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs);
        socket.once(eventName, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

// Expect NO event within a time window
function expectNoEvent(socket, eventName, windowMs = 2000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(eventName, handler);
            resolve(); // No event = success
        }, windowMs);
        const handler = (data) => {
            clearTimeout(timer);
            reject(new Error(`Unexpected ${eventName} received: ${JSON.stringify(data)}`));
        };
        socket.once(eventName, handler);
    });
}

module.exports = {
    createSocket,
    createAdminSocket,
    seedTestData,
    cleanupTestData,
    waitForEvent,
    expectNoEvent,
    SERVER_URL,
    TEST_DB_URL,
    POOL_CONFIG
};
