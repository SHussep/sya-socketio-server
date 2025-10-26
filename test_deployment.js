const axios = require('axios');

const API_BASE = 'https://sya-socketio-server.onrender.com';

// Test credentials
const TEST_USER = {
    email: 'admin@example.com',
    password: 'admin123'
};

let authToken = null;
let testResults = {
    passed: 0,
    failed: 0,
    errors: []
};

async function test(name, fn) {
    try {
        console.log(`\n📋 Testing: ${name}`);
        await fn();
        console.log(`✅ ${name} - PASSED`);
        testResults.passed++;
    } catch (error) {
        console.error(`❌ ${name} - FAILED`);
        console.error(`   Error: ${error.message}`);
        testResults.failed++;
        testResults.errors.push({ test: name, error: error.message });
    }
}

async function runTests() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🧪 TESTING RENDER DEPLOYMENT - All Endpoints');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Test 1: Health Check
    await test('Health Check', async () => {
        const response = await axios.get(`${API_BASE}/health`);
        if (!response.data.status || response.data.status !== 'ok') {
            throw new Error('Health check failed');
        }
        console.log(`   Database: ${response.data.database}`);
        console.log(`   Tenants: ${response.data.stats.tenants}, Employees: ${response.data.stats.employees}`);
    });

    // Test 2: Home endpoint
    await test('Home Endpoint (/)', async () => {
        const response = await axios.get(`${API_BASE}/`);
        if (!response.data.includes('Socket.IO Server')) {
            throw new Error('Home endpoint not working');
        }
    });

    // Test 3: Login (get token)
    await test('Login & Get Token', async () => {
        const response = await axios.post(`${API_BASE}/api/auth/desktop-login`, TEST_USER);
        if (!response.data.token) {
            throw new Error('No token returned');
        }
        authToken = response.data.token;
        console.log(`   Token obtained: ${authToken.substring(0, 20)}...`);
    });

    if (!authToken) {
        console.error('\n⚠️ Login failed - cannot test authenticated endpoints');
        return;
    }

    const headers = { Authorization: `Bearer ${authToken}` };

    // Test 4: Branches endpoint (uses authenticateToken)
    await test('GET /api/branches (authenticateToken middleware)', async () => {
        const response = await axios.get(`${API_BASE}/api/branches`, { headers });
        if (!response.data.success) {
            throw new Error('Branches endpoint failed');
        }
        console.log(`   Branches found: ${response.data.branches.length}`);
    });

    // Test 5: Cash Cuts List
    await test('GET /api/cash-cuts (List)', async () => {
        const response = await axios.get(`${API_BASE}/api/cash-cuts`, { headers });
        if (!response.data.success) {
            throw new Error('Cash cuts list failed');
        }
        console.log(`   Cash cuts found: ${response.data.data.length}`);
    });

    // Test 6: Cash Cuts Sync (critical - has cutDate field)
    await test('POST /api/cash-cuts/sync (with cutDate)', async () => {
        const timestamp = Date.now();
        const cashCutData = {
            tenantId: 3,
            branchId: 13,
            employeeId: 1,
            cutNumber: `CUT-TEST-${timestamp}`,
            totalSales: 1500,
            totalExpenses: 200,
            cashInDrawer: 500,
            expectedCash: 1100,
            difference: -600,
            cutDate: new Date().toISOString()
        };

        const response = await axios.post(
            `${API_BASE}/api/cash-cuts/sync`,
            cashCutData,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.data.success) {
            throw new Error('Cash cuts sync failed');
        }
        console.log(`   Cut created: ${response.data.data.cut_number}`);
        console.log(`   Cut date: ${response.data.data.cut_date}`);
    });

    // Test 7: Sales Sync
    await test('POST /api/sales/sync', async () => {
        const timestamp = Date.now();
        const salesData = {
            tenantId: 3,
            branchId: 13,
            employeeId: 1,
            saleNumber: `SALE-${timestamp}`,
            totalAmount: 500,
            saleDate: new Date().toISOString(),
            customerName: 'Test Customer'
        };

        const response = await axios.post(
            `${API_BASE}/api/sales/sync`,
            salesData,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.data.success) {
            throw new Error('Sales sync failed');
        }
        console.log(`   Sale created: ${response.data.data.sale_number}`);
    });

    // Test 8: Expenses Sync
    await test('POST /api/expenses/sync', async () => {
        const timestamp = Date.now();
        const expenseData = {
            tenantId: 3,
            branchId: 13,
            employeeId: 1,
            expenseNumber: `EXP-${timestamp}`,
            amount: 100,
            description: 'Test Expense',
            expenseDate: new Date().toISOString()
        };

        const response = await axios.post(
            `${API_BASE}/api/expenses/sync`,
            expenseData,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.data.success) {
            throw new Error('Expenses sync failed');
        }
        console.log(`   Expense created: ${response.data.data.expense_number}`);
    });

    // Test 9: Shifts Sync
    await test('POST /api/shifts/sync', async () => {
        const timestamp = Date.now();
        const shiftData = {
            tenantId: 3,
            branchId: 13,
            employeeId: 1,
            shiftNumber: `SHIFT-${timestamp}`,
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
            status: 'open'
        };

        const response = await axios.post(
            `${API_BASE}/api/shifts/sync`,
            shiftData,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.data.success) {
            throw new Error('Shifts sync failed');
        }
        console.log(`   Shift created: ${response.data.data.shift_number}`);
    });

    // Test 10: Dashboard Metrics
    await test('GET /api/dashboard/metrics', async () => {
        const response = await axios.get(`${API_BASE}/api/dashboard/metrics`, { headers });
        if (!response.data.success) {
            throw new Error('Dashboard metrics failed');
        }
        console.log(`   Metrics retrieved successfully`);
    });

    // Print Summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📊 TEST RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`✅ Passed: ${testResults.passed}`);
    console.log(`❌ Failed: ${testResults.failed}`);

    if (testResults.errors.length > 0) {
        console.log('\n📋 Failed Tests:');
        testResults.errors.forEach(err => {
            console.log(`   - ${err.test}: ${err.error}`);
        });
    }

    if (testResults.failed === 0) {
        console.log('\n🎉 ALL TESTS PASSED! Deployment is successful!');
    } else {
        console.log('\n⚠️ Some tests failed. Please review the errors above.');
        process.exit(1);
    }
}

runTests().catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
});
