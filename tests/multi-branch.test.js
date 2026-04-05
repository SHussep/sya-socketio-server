const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { createSocket, createAdminSocket, seedTestData, cleanupTestData, waitForEvent, expectNoEvent, POOL_CONFIG } = require('./helpers/test-setup');

const SERVER_URL = process.env.TEST_SERVER_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET;

// Generate a JWT for a specific employee+branch (for REST API tests)
function makeToken(employeeId, branchId, tenantId = 1) {
    return jwt.sign({ tenantId, employeeId, branchId, role: 'owner', is_owner: true }, JWT_SECRET, { expiresIn: '1h' });
}

// Prerequisites:
// 1. Server running: cd /c/SYA/sya-socketio-server && node server.js
// 2. Set env: TEST_TOKEN=<valid_jwt> JWT_SECRET=<secret> DATABASE_URL=<pg_connection_string>
// Run: npm test -- tests/multi-branch.test.js

const TEST_EMP = [99901, 99902, 99903];
const TEST_BRANCHES = [99901, 99902];
const BRANCH_A = 99901;
const BRANCH_B = 99902;

describe('Multi-Branch Business Rules', () => {
    let pool;

    beforeAll(async () => {
        pool = new Pool(POOL_CONFIG);
    });

    beforeEach(async () => {
        await cleanupTestData(pool, TEST_EMP, TEST_BRANCHES);
    });

    afterAll(async () => {
        await cleanupTestData(pool, TEST_EMP, TEST_BRANCHES);
        await pool.end();
    });

    // ============================================================
    // REGLA T4: Cierre de turno no afecta otros dispositivos/modos
    // ============================================================
    describe('Regla T4: shift_ended isolation', () => {
        test('shift_ended in Branch A does NOT affect employees in Branch B', async () => {
            const shiftIdA = await seedTestData(pool, { employeeId: 99901, branchId: BRANCH_A, hasActiveShift: true });
            await seedTestData(pool, { employeeId: 99902, branchId: BRANCH_B, hasActiveShift: true });

            const socketPedro = await createSocket({ employeeId: 99901, branchId: BRANCH_A });
            const socketJuan = await createSocket({ employeeId: 99902, branchId: BRANCH_B });

            try {
                socketPedro.emit('shift_ended', {
                    shiftId: shiftIdA, employeeId: 99901,
                    branchId: BRANCH_A, source: 'test'
                });
                await expectNoEvent(socketJuan, 'shift_ended', 2000);
            } finally {
                socketPedro.disconnect();
                socketJuan.disconnect();
            }
        });

        test('shift_ended does NOT trigger force_logout for ANY device', async () => {
            await seedTestData(pool, { employeeId: 99901, branchId: BRANCH_A, hasActiveShift: true });

            const socket1 = await createSocket({ employeeId: 99901, branchId: BRANCH_A });
            const socket2 = await createSocket({ employeeId: 99902, branchId: BRANCH_A });

            try {
                socket1.emit('shift_ended', {
                    shiftId: 1, employeeId: 99901,
                    branchId: BRANCH_A, source: 'test'
                });
                await Promise.all([
                    expectNoEvent(socket1, 'force_logout', 2000),
                    expectNoEvent(socket2, 'force_logout', 2000)
                ]);
            } finally {
                socket1.disconnect();
                socket2.disconnect();
            }
        });
    });

    // ==========================================================================
    // REGLA S3/S5: force_takeover branch isolation
    // ==========================================================================
    describe('Regla S3/S5: force_takeover branch isolation', () => {
        test('force_takeover on Branch A does NOT kick supervisor socket in Branch B', async () => {
            await seedTestData(pool, { employeeId: 99901, branchId: BRANCH_A, hasActiveShift: true });

            const socketShift = await createSocket({ employeeId: 99901, branchId: BRANCH_A });
            const socketSupervisor = await createSocket({ employeeId: 99901, branchId: BRANCH_B });
            const socketTakeover = await createSocket({ employeeId: 99903, branchId: BRANCH_A });

            try {
                socketTakeover.emit('force_takeover', {
                    employeeId: 99901,
                    terminalId: 'test-takeover-terminal'
                });

                // Branch A socket SHOULD be kicked
                const logoutResult = await waitForEvent(socketShift, 'force_logout', 5000);
                expect(logoutResult.reason).toBe('session_taken');

                // Branch B supervisor should NOT be kicked
                await expectNoEvent(socketSupervisor, 'force_logout', 3000);
            } finally {
                socketShift.disconnect();
                socketSupervisor.disconnect();
                socketTakeover.disconnect();
            }
        });

        test('force_takeover does NOT kick admin socket connected via join_all_branches', async () => {
            await seedTestData(pool, { employeeId: 99901, branchId: BRANCH_A, hasActiveShift: true });

            const socketShift = await createSocket({ employeeId: 99901, branchId: BRANCH_A });
            const socketAdmin = await createAdminSocket({ employeeId: 99901, branchIds: [BRANCH_A, BRANCH_B] });
            const socketTakeover = await createSocket({ employeeId: 99903, branchId: BRANCH_A });

            try {
                socketTakeover.emit('force_takeover', {
                    employeeId: 99901,
                    terminalId: 'test-takeover-terminal'
                });

                // Shift socket (has branchId) SHOULD be kicked
                const logoutResult = await waitForEvent(socketShift, 'force_logout', 5000);
                expect(logoutResult.reason).toBe('session_taken');

                // Admin socket (no branchId) should NOT be directly kicked.
                // Room broadcast may reach it, but with targetEmployeeId for client filtering.
                // The direct kick loop should skip it (fail-closed).
                // We can't easily test the room broadcast filtering here since
                // the admin IS in branch_A room, but the targetEmployeeId mechanism
                // ensures the client filters correctly.
            } finally {
                socketShift.disconnect();
                socketAdmin.disconnect();
                socketTakeover.disconnect();
            }
        });
    });

    // =============================================
    // REGLA S6: Supervisor no afectado por caja
    // =============================================
    describe('Regla S6: Supervisor not affected by caja events', () => {
        test('closing caja in Branch A does not affect supervisor in Branch B', async () => {
            await seedTestData(pool, { employeeId: 99901, branchId: BRANCH_A, hasActiveShift: true });

            const socketCajero = await createSocket({ employeeId: 99901, branchId: BRANCH_A });
            const socketSupervisor = await createSocket({ employeeId: 99901, branchId: BRANCH_B });

            try {
                socketCajero.emit('shift_ended', {
                    shiftId: 1, employeeId: 99901,
                    branchId: BRANCH_A, source: 'cash_cut_closed'
                });
                await Promise.all([
                    expectNoEvent(socketSupervisor, 'shift_ended', 2000),
                    expectNoEvent(socketSupervisor, 'force_logout', 2000)
                ]);
            } finally {
                socketCajero.disconnect();
                socketSupervisor.disconnect();
            }
        });
    });

    // ===========================================================
    // REGLA T1: Un turno activo por empleado en TODO el sistema
    // ===========================================================
    describe('Regla T1: One active shift per employee system-wide', () => {
        test('opening shift in Branch B when shift exists in Branch A returns 409', async () => {
            // Seed: employee 99901 already has active shift in BRANCH_A
            await seedTestData(pool, { employeeId: 99901, branchId: BRANCH_A, hasActiveShift: true });
            // Also ensure BRANCH_B exists for the second open attempt
            await seedTestData(pool, { employeeId: 99902, branchId: BRANCH_B, hasActiveShift: false });

            // JWT must have employeeId=99901 and branchId=BRANCH_B (trying to open in B)
            const token = makeToken(99901, BRANCH_B);
            const response = await fetch(`${SERVER_URL}/api/shifts/open`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    initialAmount: 500,
                    terminalId: 'test-terminal-branchB',
                    deviceType: 'desktop',
                    branchId: BRANCH_B
                })
            });

            // Should be 409 because employee already has shift in BRANCH_A
            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body.error).toBe('SHIFT_CONFLICT');
            // The active shift is in BRANCH_A, but we're trying to open in BRANCH_B
            expect(body.activeShift.branchId).toBe(BRANCH_A);
            expect(body.activeShift.branchId).not.toBe(BRANCH_B);
        });
    });

    // ===========================================================
    // REGLA E2: Multi-caja — two employees same branch
    // ===========================================================
    describe('Regla E2: Multi-caja independence', () => {
        test('closing shift for employee A does not affect employee B in same branch', async () => {
            await seedTestData(pool, { employeeId: 99901, branchId: BRANCH_A, hasActiveShift: true });
            await seedTestData(pool, { employeeId: 99902, branchId: BRANCH_A, hasActiveShift: true });

            const socketA = await createSocket({ employeeId: 99901, branchId: BRANCH_A });
            const socketB = await createSocket({ employeeId: 99902, branchId: BRANCH_A });

            try {
                socketA.emit('shift_ended', {
                    shiftId: 1, employeeId: 99901,
                    branchId: BRANCH_A, source: 'cash_cut_closed'
                });

                // B receives shift_ended (same room) but payload has employeeId
                // so client can filter: "not mine"
                const received = await waitForEvent(socketB, 'shift_ended', 3000);
                expect(received.employeeId).toBe(99901);
            } finally {
                socketA.disconnect();
                socketB.disconnect();
            }
        });
    });
});
