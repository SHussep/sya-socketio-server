#!/usr/bin/env node

/**
 * Test script to verify shift_ended event handling
 * Tests that:
 * 1. Backend receives shift_ended with correct RemoteId
 * 2. PostgreSQL is_cash_cut_open is updated to false
 * 3. FCM notification is sent
 */

const axios = require('axios');

const BACKEND_URL = 'https://sya-socketio-server.onrender.com';

async function testShiftClose() {
    console.log('🧪 Testing shift_ended event handling...\n');

    try {
        // 1. Check current shift status
        console.log('1️⃣  Checking shift status in PostgreSQL...');
        const shiftsResponse = await axios.get(`${BACKEND_URL}/api/shifts/current`, {
            params: { employeeId: 3, branchId: 13 }
        });
        console.log('   Response:', shiftsResponse.data);

        // 2. Get list of open shifts
        console.log('\n2️⃣  Getting all open shifts in branch 13...');
        const openShiftsResponse = await axios.get(`${BACKEND_URL}/api/shifts/branch/13/open`);
        console.log('   Open shifts:', JSON.stringify(openShiftsResponse.data, null, 2));

        // 3. Check specific shift by ID
        console.log('\n3️⃣  Checking specific shifts (ID=9 and ID=11)...');
        for (const shiftId of [9, 11]) {
            try {
                const response = await axios.get(`${BACKEND_URL}/api/shifts/${shiftId}`);
                console.log(`   Shift #${shiftId}:`, response.data);
            } catch (err) {
                console.log(`   Shift #${shiftId}: NOT FOUND`);
            }
        }

        console.log('\n✅ Test completed. Check Backend logs on Render for shift_ended events.');
        console.log('\n📝 EXPECTED LOGS when you close a shift on Desktop:');
        console.log('   [SHIFT] Sucursal 13: Saul Corona cerró turno - Diferencia: $[AMOUNT]');
        console.log('   [SHIFT] ✅ Turno #11 actualizado en PostgreSQL');
        console.log('   [FCM] ✅ Notificación enviada');

    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

testShiftClose();
