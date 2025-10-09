const axios = require('axios');

const API_URL = 'https://sya-socketio-server.onrender.com';

// IDs del usuario de prueba (SYA361666)
const TEST_TENANT_ID = 23;
const TEST_BRANCH_ID = 31;
const TEST_EMPLOYEE_ID = 36;

async function testSyncSale() {
    console.log('\n🧪 TEST: POST /api/sync/sales (Desktop Sync)\n');

    try {
        const saleData = {
            tenantId: TEST_TENANT_ID,
            branchId: TEST_BRANCH_ID,
            employeeId: TEST_EMPLOYEE_ID,
            ticketNumber: `TEST-${Date.now()}`,
            totalAmount: 125.50,
            paymentMethod: 'cash',
            userEmail: 'usuariodeprueba@test.com'
        };

        console.log('📤 Enviando venta:');
        console.log(JSON.stringify(saleData, null, 2));

        const response = await axios.post(`${API_URL}/api/sync/sales`, saleData);

        console.log('\n✅ Respuesta exitosa:');
        console.log('Status:', response.status);
        console.log('Data:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log(`\n✅ Venta sincronizada exitosamente!`);
            console.log(`   ID: ${response.data.data.id}`);
            console.log(`   Ticket: ${response.data.data.ticket_number}`);
            console.log(`   Total: $${response.data.data.total_amount}`);
            return response.data.data.id;
        }
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return null;
    }
}

async function testSyncExpense() {
    console.log('\n\n🧪 TEST: POST /api/sync/expenses (Desktop Sync)\n');

    try {
        const expenseData = {
            tenantId: TEST_TENANT_ID,
            branchId: TEST_BRANCH_ID,
            employeeId: TEST_EMPLOYEE_ID,
            category: 'Servicios',
            description: 'Prueba de sincronización Desktop',
            amount: 50.00,
            userEmail: 'usuariodeprueba@test.com'
        };

        console.log('📤 Enviando gasto:');
        console.log(JSON.stringify(expenseData, null, 2));

        const response = await axios.post(`${API_URL}/api/sync/expenses`, expenseData);

        console.log('\n✅ Respuesta exitosa:');
        console.log('Status:', response.status);
        console.log('Data:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log(`\n✅ Gasto sincronizado exitosamente!`);
            console.log(`   ID: ${response.data.data.id}`);
            console.log(`   Categoría: ${response.data.data.category}`);
            console.log(`   Total: $${response.data.data.amount}`);
            return response.data.data.id;
        }
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return null;
    }
}

async function testSyncCashCut() {
    console.log('\n\n🧪 TEST: POST /api/sync/cash-cuts (Desktop Sync)\n');

    try {
        const cashCutData = {
            tenantId: TEST_TENANT_ID,
            branchId: TEST_BRANCH_ID,
            employeeId: TEST_EMPLOYEE_ID,
            cutNumber: `CUT-${Date.now()}`,
            totalSales: 1500.00,
            totalExpenses: 200.00,
            cashInDrawer: 1800.00,
            expectedCash: 1300.00,
            difference: 500.00,
            userEmail: 'usuariodeprueba@test.com'
        };

        console.log('📤 Enviando corte de caja:');
        console.log(JSON.stringify(cashCutData, null, 2));

        const response = await axios.post(`${API_URL}/api/sync/cash-cuts`, cashCutData);

        console.log('\n✅ Respuesta exitosa:');
        console.log('Status:', response.status);
        console.log('Data:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log(`\n✅ Corte sincronizado exitosamente!`);
            console.log(`   ID: ${response.data.data.id}`);
            console.log(`   Número: ${response.data.data.cut_number}`);
            console.log(`   Diferencia: $${response.data.data.difference}`);
            return response.data.data.id;
        }
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return null;
    }
}

async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('🧪 PRUEBAS DE ENDPOINTS /api/sync/* PARA DESKTOP');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`\n📍 API URL: ${API_URL}`);
    console.log(`📍 Tenant ID: ${TEST_TENANT_ID}`);
    console.log(`📍 Branch ID: ${TEST_BRANCH_ID}`);
    console.log(`📍 Employee ID: ${TEST_EMPLOYEE_ID}`);

    // Test 1: Sync Sale
    const saleId = await testSyncSale();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 2: Sync Expense
    const expenseId = await testSyncExpense();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 3: Sync Cash Cut
    const cashCutId = await testSyncCashCut();

    console.log('\n\n═══════════════════════════════════════════════════════');
    console.log('📊 RESUMEN DE PRUEBAS');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Venta:       ${saleId ? '✅ OK (ID: ' + saleId + ')' : '❌ FALLÓ'}`);
    console.log(`Gasto:       ${expenseId ? '✅ OK (ID: ' + expenseId + ')' : '❌ FALLÓ'}`);
    console.log(`Corte:       ${cashCutId ? '✅ OK (ID: ' + cashCutId + ')' : '❌ FALLÓ'}`);

    if (saleId && expenseId && cashCutId) {
        console.log('\n✅ TODOS LOS TESTS PASARON - Desktop puede sincronizar correctamente\n');
    } else {
        console.log('\n❌ ALGUNOS TESTS FALLARON - Revisar logs arriba\n');
    }
}

main().catch(error => {
    console.error('\n❌ ERROR FATAL:', error);
    process.exit(1);
});
