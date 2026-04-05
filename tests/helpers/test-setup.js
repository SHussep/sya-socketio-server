const { io } = require('socket.io-client');
const { Pool } = require('pg');

const SERVER_URL = process.env.TEST_SERVER_URL || 'http://localhost:3001';
const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

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
    // Ensure employee exists
    await pool.query(`
        INSERT INTO employees (id, tenant_id, name, email, role, global_id)
        VALUES ($1, $2, $3, $4, 'cajero', gen_random_uuid())
        ON CONFLICT (id) DO NOTHING
    `, [employeeId, tenantId, `TestEmployee_${employeeId}`, `test${employeeId}@test.com`]);

    if (hasActiveShift) {
        const result = await pool.query(`
            INSERT INTO shifts (employee_id, tenant_id, branch_id, is_cash_cut_open, initial_amount, start_time, terminal_id)
            VALUES ($1, $2, $3, true, 500, NOW(), $4)
            RETURNING id
        `, [employeeId, tenantId, branchId, `test-terminal-${employeeId}`]);
        return result.rows[0].id;
    }
    return null;
}

// Cleanup test data — call in beforeEach AND afterAll for safety
async function cleanupTestData(pool, employeeIds) {
    for (const empId of employeeIds) {
        await pool.query('DELETE FROM shifts WHERE employee_id = $1', [empId]);
        await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
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
    TEST_DB_URL
};
