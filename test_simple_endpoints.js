const axios = require('axios');

const API_BASE = 'https://sya-socketio-server.onrender.com';

async function testEndpoints() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🧪 TESTING CRITICAL ENDPOINTS (No Auth Required)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    let passed = 0, failed = 0;

    // Test 1: Health Check
    try {
        console.log('📋 1. Testing Health Check...');
        const response = await axios.get(`${API_BASE}/health`);
        console.log('✅ Health Check PASSED');
        console.log(`   Database: ${response.data.database}`);
        console.log(`   Status: ${response.data.status}\n`);
        passed++;
    } catch (error) {
        console.error('❌ Health Check FAILED:', error.message, '\n');
        failed++;
    }

    // Test 2: Home endpoint
    try {
        console.log('📋 2. Testing Home Endpoint...');
        const response = await axios.get(`${API_BASE}/`);
        if (response.data.includes('Socket.IO')) {
            console.log('✅ Home Endpoint PASSED\n');
            passed++;
        } else {
            throw new Error('Unexpected response');
        }
    } catch (error) {
        console.error('❌ Home Endpoint FAILED:', error.message, '\n');
        failed++;
    }

    // Test 3: Cash Cuts Sync (POST - no auth)
    try {
        console.log('📋 3. Testing Cash Cuts Sync (POST /api/cash-cuts/sync)...');
        const timestamp = Date.now();
        const cashCutData = {
            tenantId: 3,
            branchId: 13,
            employeeId: 1,
            cutNumber: `TEST-${timestamp}`,
            totalSales: 1500,
            totalExpenses: 200,
            cashInDrawer: 500,
            expectedCash: 1100,
            difference: -600,
            cutDate: new Date().toISOString()
        };

        const response = await axios.post(
            `${API_BASE}/api/cash-cuts/sync`,
            cashCutData
        );

        if (response.data.success) {
            console.log('✅ Cash Cuts Sync PASSED');
            console.log(`   Cut created: ${response.data.data.cut_number}`);
            console.log(`   Cut date: ${response.data.data.cut_date}\n`);
            passed++;
        } else {
            throw new Error('Response not successful');
        }
    } catch (error) {
        console.error('❌ Cash Cuts Sync FAILED:', error.message);
        if (error.response?.data) {
            console.error('   Response:', error.response.data, '\n');
        } else {
            console.error('\n');
        }
        failed++;
    }

    // Test 4: Sales Sync (POST - no auth)
    try {
        console.log('📋 4. Testing Sales Sync (POST /api/sales/sync)...');
        const timestamp = Date.now();
        const salesData = {
            tenantId: 3,
            branchId: 13,
            employeeId: 1,
            saleNumber: `SALE-${timestamp}`,
            totalAmount: 500,
            saleDate: new Date().toISOString(),
            customerName: 'Test'
        };

        const response = await axios.post(
            `${API_BASE}/api/sales/sync`,
            salesData
        );

        if (response.data.success) {
            console.log('✅ Sales Sync PASSED');
            console.log(`   Sale created: ${response.data.data.sale_number}\n`);
            passed++;
        } else {
            throw new Error('Response not successful');
        }
    } catch (error) {
        console.error('❌ Sales Sync FAILED:', error.message);
        if (error.response?.data) {
            console.error('   Response:', error.response.data, '\n');
        } else {
            console.error('\n');
        }
        failed++;
    }

    // Test 5: Expenses Sync (POST - no auth)
    try {
        console.log('📋 5. Testing Expenses Sync (POST /api/expenses/sync)...');
        const timestamp = Date.now();
        const expenseData = {
            tenantId: 3,
            branchId: 13,
            employeeId: 1,
            expenseNumber: `EXP-${timestamp}`,
            amount: 100,
            description: 'Test',
            expenseDate: new Date().toISOString()
        };

        const response = await axios.post(
            `${API_BASE}/api/expenses/sync`,
            expenseData
        );

        if (response.data.success) {
            console.log('✅ Expenses Sync PASSED');
            console.log(`   Expense created: ${response.data.data.expense_number}\n`);
            passed++;
        } else {
            throw new Error('Response not successful');
        }
    } catch (error) {
        console.error('❌ Expenses Sync FAILED:', error.message);
        if (error.response?.data) {
            console.error('   Response:', error.response.data, '\n');
        } else {
            console.error('\n');
        }
        failed++;
    }

    // Test 6: Shifts Sync/Open (POST - no auth)
    try {
        console.log('📋 6. Testing Shifts Sync/Open (POST /api/shifts/sync/open)...');
        const timestamp = Date.now();
        const shiftData = {
            tenantId: 3,
            branchId: 13,
            employeeId: 1,
            shiftNumber: `SHIFT-${timestamp}`,
            startTime: new Date().toISOString(),
            initialAmount: 450
        };

        const response = await axios.post(
            `${API_BASE}/api/shifts/sync/open`,
            shiftData
        );

        if (response.data.success) {
            console.log('✅ Shifts Sync/Open PASSED');
            console.log(`   Shift created: ${response.data.data.shift_number}\n`);
            passed++;
        } else {
            throw new Error('Response not successful');
        }
    } catch (error) {
        console.error('❌ Shifts Sync/Open FAILED:', error.message);
        if (error.response?.data) {
            console.error('   Response:', error.response.data, '\n');
        } else {
            console.error('\n');
        }
        failed++;
    }

    // Test 7: Purchases Sync (POST - no auth)
    try {
        console.log('📋 7. Testing Purchases Sync (POST /api/purchases/sync)...');
        const timestamp = Date.now();
        const purchaseData = {
            tenantId: 3,
            branchId: 13,
            employeeId: 1,
            purchaseNumber: `PUR-${timestamp}`,
            totalAmount: 200,
            vendorName: 'Test Vendor',
            purchaseDate: new Date().toISOString()
        };

        const response = await axios.post(
            `${API_BASE}/api/purchases/sync`,
            purchaseData
        );

        if (response.data.success) {
            console.log('✅ Purchases Sync PASSED');
            console.log(`   Purchase created: ${response.data.data.purchase_number}\n`);
            passed++;
        } else {
            throw new Error('Response not successful');
        }
    } catch (error) {
        console.error('❌ Purchases Sync FAILED:', error.message);
        if (error.response?.data) {
            console.error('   Response:', error.response.data, '\n');
        } else {
            console.error('\n');
        }
        failed++;
    }

    // Summary
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('📊 TEST SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📈 Total: ${passed + failed}\n`);

    if (failed === 0) {
        console.log('🎉 ALL TESTS PASSED! Deployment is working correctly!');
        process.exit(0);
    } else {
        console.log('⚠️ Some tests failed. See errors above.');
        process.exit(1);
    }
}

testEndpoints().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
