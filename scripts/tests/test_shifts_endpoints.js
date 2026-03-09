const axios = require('axios');

const API_URL = 'https://sya-socketio-server.onrender.com';

// Usar credenciales del usuario de prueba
const TEST_TENANT_CODE = 'SYA361666';
const TEST_USERNAME = 'usuariodeprueba';
const TEST_PASSWORD = 'TestPassword123';

let authToken = null;
let tenantId = null;
let branchId = null;
let employeeId = null;

async function login() {
    console.log('\n🔐 INICIANDO SESIÓN...\n');

    try {
        const response = await axios.post(`${API_URL}/api/auth/desktop-login`, {
            tenantCode: TEST_TENANT_CODE,
            username: TEST_USERNAME,
            password: TEST_PASSWORD
        });

        if (response.data.success) {
            authToken = response.data.token;
            tenantId = response.data.user.tenant_id;
            branchId = response.data.user.branch_id;
            employeeId = response.data.user.id;

            console.log('✅ Login exitoso');
            console.log(`   Tenant ID: ${tenantId}`);
            console.log(`   Branch ID: ${branchId}`);
            console.log(`   Employee ID: ${employeeId}`);
            console.log(`   Token: ${authToken.substring(0, 20)}...`);
            return true;
        } else {
            console.log('❌ Login falló:', response.data.message);
            return false;
        }
    } catch (error) {
        console.error('❌ Error en login:', error.response?.data || error.message);
        return false;
    }
}

async function testGetCurrentShift() {
    console.log('\n\n📋 TEST: GET /api/shifts/current\n');

    try {
        const response = await axios.get(`${API_URL}/api/shifts/current`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });

        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            if (response.data.data) {
                console.log('\n✅ Turno actual encontrado');
                return response.data.data.id;
            } else {
                console.log('\n⚠️ No hay turno abierto');
                return null;
            }
        }
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return null;
    }
}

async function testOpenShift() {
    console.log('\n\n🚀 TEST: POST /api/shifts/open\n');

    try {
        const response = await axios.post(
            `${API_URL}/api/shifts/open`,
            { initialAmount: 500.00 },
            { headers: { Authorization: `Bearer ${authToken}` } }
        );

        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log('\n✅ Turno abierto exitosamente');
            console.log(`   Shift ID: ${response.data.data.id}`);
            console.log(`   Monto inicial: $${response.data.data.initial_amount}`);
            return response.data.data.id;
        }
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return null;
    }
}

async function testGetHistory() {
    console.log('\n\n📚 TEST: GET /api/shifts/history\n');

    try {
        const response = await axios.get(
            `${API_URL}/api/shifts/history?limit=10`,
            { headers: { Authorization: `Bearer ${authToken}` } }
        );

        console.log('Status:', response.status);
        console.log(`Turnos encontrados: ${response.data.data.length}`);

        if (response.data.data.length > 0) {
            console.log('\nPrimer turno:');
            console.log(JSON.stringify(response.data.data[0], null, 2));
            console.log('\n✅ Historial obtenido correctamente');
        } else {
            console.log('\n⚠️ No hay turnos en el historial');
        }
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

async function testGetSummary() {
    console.log('\n\n📊 TEST: GET /api/shifts/summary\n');

    try {
        const response = await axios.get(
            `${API_URL}/api/shifts/summary`,
            { headers: { Authorization: `Bearer ${authToken}` } }
        );

        console.log('Status:', response.status);
        console.log('Summary:', JSON.stringify(response.data.data, null, 2));
        console.log('\n✅ Resumen obtenido correctamente');
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

async function testCloseShift(shiftId) {
    console.log('\n\n🔒 TEST: POST /api/shifts/close\n');

    try {
        const response = await axios.post(
            `${API_URL}/api/shifts/close`,
            { shiftId, finalAmount: 1250.50 },
            { headers: { Authorization: `Bearer ${authToken}` } }
        );

        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log('\n✅ Turno cerrado exitosamente');
            console.log(`   Monto inicial: $${response.data.data.initial_amount}`);
            console.log(`   Monto final: $${response.data.data.final_amount}`);
            console.log(`   Diferencia: $${response.data.data.final_amount - response.data.data.initial_amount}`);
        }
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

async function testGuardianEvents() {
    console.log('\n\n🛡️ TEST: Guardian Events\n');

    try {
        // 1. Obtener eventos Guardian
        console.log('📋 GET /api/guardian-events');
        const getResponse = await axios.get(
            `${API_URL}/api/guardian-events?limit=10`,
            { headers: { Authorization: `Bearer ${authToken}` } }
        );

        console.log('Status:', getResponse.status);
        console.log(`Eventos encontrados: ${getResponse.data.data.length}`);

        if (getResponse.data.data.length > 0) {
            console.log('\nPrimer evento:');
            console.log(JSON.stringify(getResponse.data.data[0], null, 2));
        }

        // 2. Crear nuevo evento Guardian
        console.log('\n\n📤 POST /api/guardian-events');
        const createResponse = await axios.post(
            `${API_URL}/api/guardian-events`,
            {
                branchId: branchId,
                eventType: 'suspicious_weighing',
                severity: 'High',
                title: 'Prueba de evento Guardian',
                description: 'Evento de prueba desde test_shifts_endpoints.js',
                weightKg: 1.5,
                scaleId: 'SCALE-TEST-001',
                metadata: {
                    test: true,
                    timestamp: new Date().toISOString()
                }
            },
            { headers: { Authorization: `Bearer ${authToken}` } }
        );

        console.log('Status:', createResponse.status);
        console.log('Response:', JSON.stringify(createResponse.data, null, 2));

        if (createResponse.data.success) {
            console.log('\n✅ Evento Guardian creado exitosamente');
        }

    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

async function testSalesAndExpenses() {
    console.log('\n\n💰 TEST: Sales & Expenses\n');

    try {
        // 1. Obtener ventas
        console.log('📋 GET /api/sales');
        const salesResponse = await axios.get(
            `${API_URL}/api/sales?limit=5`,
            { headers: { Authorization: `Bearer ${authToken}` } }
        );

        console.log('Status:', salesResponse.status);
        console.log(`Ventas encontradas: ${salesResponse.data.data.length}`);

        if (salesResponse.data.data.length > 0) {
            console.log('\nPrimera venta:');
            console.log(JSON.stringify(salesResponse.data.data[0], null, 2));
        }

        // 2. Obtener gastos
        console.log('\n\n📋 GET /api/expenses');
        const expensesResponse = await axios.get(
            `${API_URL}/api/expenses?limit=5`,
            { headers: { Authorization: `Bearer ${authToken}` } }
        );

        console.log('Status:', expensesResponse.status);
        console.log(`Gastos encontrados: ${expensesResponse.data.data.length}`);

        if (expensesResponse.data.data.length > 0) {
            console.log('\nPrimer gasto:');
            console.log(JSON.stringify(expensesResponse.data[0], null, 2));
        }

        console.log('\n✅ Endpoints de ventas y gastos funcionan correctamente');

    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
    }
}

async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('🧪 PRUEBAS COMPLETAS DE ENDPOINTS');
    console.log('═══════════════════════════════════════════════════════');

    // 1. Login
    const loginSuccess = await login();
    if (!loginSuccess) {
        console.log('\n❌ No se pudo continuar sin login exitoso');
        process.exit(1);
    }

    // 2. Verificar turno actual
    let currentShiftId = await testGetCurrentShift();

    // 3. Si no hay turno, abrir uno
    if (!currentShiftId) {
        currentShiftId = await testOpenShift();

        // Esperar un poco para que se cree
        await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
        console.log(`\n⚠️ Ya existe un turno abierto (ID: ${currentShiftId})`);
        console.log('   Saltando creación de nuevo turno...');
    }

    // 4. Obtener historial
    await testGetHistory();

    // 5. Obtener resumen
    await testGetSummary();

    // 6. Probar Guardian Events
    await testGuardianEvents();

    // 7. Probar Sales & Expenses
    await testSalesAndExpenses();

    // 8. Cerrar turno (opcional - comentado para no cerrar siempre)
    // if (currentShiftId) {
    //     await testCloseShift(currentShiftId);
    // }

    console.log('\n\n═══════════════════════════════════════════════════════');
    console.log('✅ PRUEBAS COMPLETADAS');
    console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(error => {
    console.error('\n❌ ERROR FATAL:', error);
    process.exit(1);
});
