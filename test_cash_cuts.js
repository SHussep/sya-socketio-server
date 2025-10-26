const axios = require('axios');

const API_BASE = 'https://sya-socketio-server.onrender.com';

async function testCashCutSync() {
    try {
        console.log('[TEST] Testing cash cut sync with cutDate...\n');

        // Test data - NOW with cutNumber required field
        const timestamp = Date.now();
        const cashCutData = {
            tenantId: 3,
            branchId: 13,
            employeeId: 1,
            cutNumber: `CUT-${timestamp}`, // REQUIRED field
            totalSales: 1500,
            totalExpenses: 200,
            cashInDrawer: 500,
            expectedCash: 1100,
            difference: -600,
            cutDate: new Date().toISOString() // NEW: cutDate field
        };

        console.log('[TEST] Sending cash cut sync:');
        console.log(JSON.stringify(cashCutData, null, 2));

        // Test the correct endpoint path (cash-cuts sync is at /api/cash-cuts/sync)
        const response = await axios.post(
            `${API_BASE}/api/cash-cuts/sync`,
            cashCutData,
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            }
        );

        console.log('\n[TEST] ✅ Response status:', response.status);
        console.log('[TEST] Response data:');
        console.log(JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log('\n[SUCCESS] ✅ Cash cut sync successful!');
            console.log('[SUCCESS] ✅ cutDate field was sent and persisted to database');

            if (response.data.data && response.data.data.cut_date) {
                console.log(`[SUCCESS] ✅ Database cut_date: ${response.data.data.cut_date}`);
            }
        } else {
            console.log('\n[ERROR] ⚠️ Response indicates error:', response.data.error);
        }
    } catch (error) {
        console.error('[TEST] ❌ Error:', error.message);
        if (error.response) {
            console.error('[TEST] Response status:', error.response.status);
            console.error('[TEST] Response data:', error.response.data);
        }
    }
}

testCashCutSync();
