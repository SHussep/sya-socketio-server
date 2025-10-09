const axios = require('axios');

const API_URL = 'https://sya-socketio-server.onrender.com';

// Credenciales del usuario de prueba
const TEST_TENANT_CODE = 'SYA361666';
const TEST_USERNAME = 'usuariodeprueba';
const TEST_PASSWORD = 'TestPassword123';

let authToken = null;
let tenantId = null;
let branchId = null;
let employeeId = null;

// ============================================================================
// AUTENTICACIÓN
// ============================================================================

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

// ============================================================================
// 1. VENTAS (SALES)
// ============================================================================

async function testSyncSales() {
    console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 TEST 1: VENTAS (POST /api/sync/sales)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        const saleData = {
            tenantId,
            branchId,
            employeeId,
            ticketNumber: `SALE-${Date.now()}`,
            totalAmount: 250.00,
            paymentMethod: 'cash'
        };

        console.log('📤 Enviando venta:', JSON.stringify(saleData, null, 2));

        const response = await axios.post(`${API_URL}/api/sync/sales`, saleData);

        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log(`\n✅ VENTA SINCRONIZADA`);
            console.log(`   ID: ${response.data.data.id}`);
            console.log(`   Ticket: ${response.data.data.ticket_number}`);
            console.log(`   Total: $${response.data.data.total_amount}`);
            return response.data.data.id;
        }
        return null;
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return null;
    }
}

async function testGetSales() {
    console.log('\n📋 Obteniendo lista de ventas (GET /api/sales)...');

    try {
        const response = await axios.get(`${API_URL}/api/sales?limit=5`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });

        console.log('Status:', response.status);
        console.log(`Ventas encontradas: ${response.data.data.length}`);

        if (response.data.data.length > 0) {
            console.log('\nÚltima venta:');
            const lastSale = response.data.data[0];
            console.log(`   ID: ${lastSale.id}`);
            console.log(`   Ticket: ${lastSale.ticket_number}`);
            console.log(`   Total: $${lastSale.total_amount}`);
            console.log(`   Fecha: ${lastSale.sale_date}`);
            console.log('\n✅ GET /api/sales funciona correctamente');
        }
        return true;
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return false;
    }
}

// ============================================================================
// 2. GASTOS (EXPENSES)
// ============================================================================

async function testSyncExpenses() {
    console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💸 TEST 2: GASTOS (POST /api/sync/expenses)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        const expenseData = {
            tenantId,
            branchId,
            employeeId,
            category: 'Mantenimiento',
            description: 'Reparación de equipo',
            amount: 150.00
        };

        console.log('📤 Enviando gasto:', JSON.stringify(expenseData, null, 2));

        const response = await axios.post(`${API_URL}/api/sync/expenses`, expenseData);

        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log(`\n✅ GASTO SINCRONIZADO`);
            console.log(`   ID: ${response.data.data.id}`);
            console.log(`   Categoría ID: ${response.data.data.category_id}`);
            console.log(`   Total: $${response.data.data.amount}`);
            return response.data.data.id;
        }
        return null;
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return null;
    }
}

async function testGetExpenses() {
    console.log('\n📋 Obteniendo lista de gastos (GET /api/expenses)...');

    try {
        const response = await axios.get(`${API_URL}/api/expenses?limit=5`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });

        console.log('Status:', response.status);
        console.log(`Gastos encontrados: ${response.data.data.length}`);

        if (response.data.data.length > 0) {
            console.log('\nÚltimo gasto:');
            const lastExpense = response.data.data[0];
            console.log(`   ID: ${lastExpense.id}`);
            console.log(`   Categoría: ${lastExpense.category}`);
            console.log(`   Descripción: ${lastExpense.description}`);
            console.log(`   Total: $${lastExpense.amount}`);
            console.log('\n✅ GET /api/expenses funciona correctamente');
        }
        return true;
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return false;
    }
}

// ============================================================================
// 3. COMPRAS (PURCHASES) - VERIFICAR SI EXISTEN ENDPOINTS
// ============================================================================

async function testPurchases() {
    console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🛒 TEST 3: COMPRAS (Verificando endpoints)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Test GET /api/purchases
    try {
        console.log('📋 Intentando GET /api/purchases...');
        const response = await axios.get(`${API_URL}/api/purchases?limit=5`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });
        console.log('✅ GET /api/purchases existe');
        console.log(`   Compras encontradas: ${response.data.data?.length || 0}`);
        return true;
    } catch (error) {
        if (error.response?.status === 404) {
            console.log('⚠️ GET /api/purchases NO EXISTE (404)');
            console.log('   Necesita implementarse en backend');
        } else {
            console.error('❌ Error:', error.response?.data || error.message);
        }
        return false;
    }
}

// ============================================================================
// 4. TURNOS (SHIFTS)
// ============================================================================

async function testShifts() {
    console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⏰ TEST 4: TURNOS (SHIFTS)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 1. Verificar turno actual
    console.log('📋 GET /api/shifts/current...');
    try {
        const currentResponse = await axios.get(`${API_URL}/api/shifts/current`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });

        console.log('Status:', currentResponse.status);

        if (currentResponse.data.data) {
            console.log('✅ Turno activo encontrado');
            console.log(`   Shift ID: ${currentResponse.data.data.id}`);
            console.log(`   Inicio: ${currentResponse.data.data.start_time}`);
            console.log(`   Monto inicial: $${currentResponse.data.data.initial_amount}`);
            return currentResponse.data.data.id;
        } else {
            console.log('⚠️ No hay turno abierto, abriendo uno nuevo...');

            // 2. Abrir turno
            const openResponse = await axios.post(
                `${API_URL}/api/shifts/open`,
                { initialAmount: 1000.00 },
                { headers: { Authorization: `Bearer ${authToken}` } }
            );

            console.log('Status:', openResponse.status);
            console.log('✅ Turno abierto');
            console.log(`   Shift ID: ${openResponse.data.data.id}`);
            console.log(`   Monto inicial: $${openResponse.data.data.initial_amount}`);
            return openResponse.data.data.id;
        }
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return null;
    }
}

async function testShiftHistory() {
    console.log('\n📋 GET /api/shifts/history...');

    try {
        const response = await axios.get(`${API_URL}/api/shifts/history?limit=5`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });

        console.log('Status:', response.status);
        console.log(`Turnos en historial: ${response.data.data.length}`);

        if (response.data.data.length > 0) {
            console.log('\nÚltimo turno:');
            const lastShift = response.data.data[0];
            console.log(`   ID: ${lastShift.id}`);
            console.log(`   Inicio: ${lastShift.start_time}`);
            console.log(`   Fin: ${lastShift.end_time || 'Aún abierto'}`);
            console.log(`   Inicial: $${lastShift.initial_amount}`);
            console.log(`   Final: $${lastShift.final_amount || 'N/A'}`);
        }
        console.log('✅ GET /api/shifts/history funciona correctamente');
        return true;
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return false;
    }
}

async function testShiftSummary() {
    console.log('\n📊 GET /api/shifts/summary...');

    try {
        const response = await axios.get(`${API_URL}/api/shifts/summary`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });

        console.log('Status:', response.status);
        console.log('Summary:', JSON.stringify(response.data.data, null, 2));
        console.log('✅ GET /api/shifts/summary funciona correctamente');
        return true;
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return false;
    }
}

// ============================================================================
// 5. CORTES DE CAJA (CASH CUTS)
// ============================================================================

async function testCashCuts() {
    console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('💰 TEST 5: CORTES DE CAJA (CASH CUTS)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        const cashCutData = {
            tenantId,
            branchId,
            employeeId,
            cutNumber: `CUT-${Date.now()}`,
            totalSales: 2000.00,
            totalExpenses: 300.00,
            cashInDrawer: 2200.00,
            expectedCash: 1700.00,
            difference: 500.00
        };

        console.log('📤 Enviando corte:', JSON.stringify(cashCutData, null, 2));

        const response = await axios.post(`${API_URL}/api/sync/cash-cuts`, cashCutData);

        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log(`\n✅ CORTE SINCRONIZADO`);
            console.log(`   ID: ${response.data.data.id}`);
            console.log(`   Número: ${response.data.data.cut_number}`);
            console.log(`   Diferencia: $${response.data.data.difference}`);
            return response.data.data.id;
        }
        return null;
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return null;
    }
}

async function testGetCashCuts() {
    console.log('\n📋 GET /api/cash-cuts...');

    try {
        const response = await axios.get(`${API_URL}/api/cash-cuts?limit=5`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });

        console.log('Status:', response.status);
        console.log(`Cortes encontrados: ${response.data.data.length}`);

        if (response.data.data.length > 0) {
            console.log('\nÚltimo corte:');
            const lastCut = response.data.data[0];
            console.log(`   ID: ${lastCut.id}`);
            console.log(`   Número: ${lastCut.cut_number}`);
            console.log(`   Ventas: $${lastCut.total_sales}`);
            console.log(`   Gastos: $${lastCut.total_expenses}`);
            console.log(`   Diferencia: $${lastCut.difference}`);
        }
        console.log('✅ GET /api/cash-cuts funciona correctamente');
        return true;
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return false;
    }
}

// ============================================================================
// 6. EVENTOS GUARDIAN
// ============================================================================

async function testGuardianEvents() {
    console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🛡️ TEST 6: EVENTOS GUARDIAN');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        const eventData = {
            branchId,
            eventType: 'suspicious_weighing',
            severity: 'High',
            title: 'Peso sospechoso detectado - Test',
            description: 'Prueba exhaustiva de eventos Guardian',
            weightKg: 2.5,
            scaleId: 'SCALE-TEST-001',
            metadata: {
                test: true,
                timestamp: new Date().toISOString(),
                location: 'Pruebas exhaustivas'
            }
        };

        console.log('📤 Creando evento Guardian:', JSON.stringify(eventData, null, 2));

        const response = await axios.post(
            `${API_URL}/api/guardian-events`,
            eventData,
            { headers: { Authorization: `Bearer ${authToken}` } }
        );

        console.log('Status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log(`\n✅ EVENTO GUARDIAN CREADO`);
            console.log(`   ID: ${response.data.data.id}`);
            console.log(`   Tipo: ${response.data.data.event_type}`);
            console.log(`   Severidad: ${response.data.data.severity}`);
            console.log(`   Peso: ${response.data.data.weight_kg} kg`);
            console.log(`   Báscula: ${response.data.data.scale_id}`);
            return response.data.data.id;
        }
        return null;
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return null;
    }
}

async function testGetGuardianEvents() {
    console.log('\n📋 GET /api/guardian-events...');

    try {
        const response = await axios.get(`${API_URL}/api/guardian-events?limit=5`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });

        console.log('Status:', response.status);
        console.log(`Eventos encontrados: ${response.data.data.length}`);

        if (response.data.data.length > 0) {
            console.log('\nÚltimo evento:');
            const lastEvent = response.data.data[0];
            console.log(`   ID: ${lastEvent.id}`);
            console.log(`   Tipo: ${lastEvent.event_type}`);
            console.log(`   Severidad: ${lastEvent.severity}`);
            console.log(`   Título: ${lastEvent.title}`);
            console.log(`   Peso: ${lastEvent.weight_kg} kg`);
            console.log(`   Báscula: ${lastEvent.scale_id}`);
            console.log(`   Fecha: ${lastEvent.event_date}`);
        }
        console.log('✅ GET /api/guardian-events funciona correctamente');
        return true;
    } catch (error) {
        console.error('❌ Error:', error.response?.data || error.message);
        return false;
    }
}

// ============================================================================
// MAIN TEST SUITE
// ============================================================================

async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🧪 PRUEBAS EXHAUSTIVAS DE TODOS LOS ENDPOINTS');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`\n📍 API URL: ${API_URL}`);
    console.log(`📍 Tenant Code: ${TEST_TENANT_CODE}`);
    console.log(`📍 Username: ${TEST_USERNAME}`);

    // LOGIN
    const loginSuccess = await login();
    if (!loginSuccess) {
        console.log('\n❌ No se pudo continuar sin login exitoso');
        process.exit(1);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    // RESULTADOS
    const results = {
        sales_create: null,
        sales_get: null,
        expenses_create: null,
        expenses_get: null,
        purchases_get: null,
        shifts_create: null,
        shifts_history: null,
        shifts_summary: null,
        cash_cuts_create: null,
        cash_cuts_get: null,
        guardian_create: null,
        guardian_get: null
    };

    // 1. VENTAS
    results.sales_create = await testSyncSales();
    await new Promise(resolve => setTimeout(resolve, 1000));
    results.sales_get = await testGetSales();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. GASTOS
    results.expenses_create = await testSyncExpenses();
    await new Promise(resolve => setTimeout(resolve, 1000));
    results.expenses_get = await testGetExpenses();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 3. COMPRAS
    results.purchases_get = await testPurchases();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 4. TURNOS
    results.shifts_create = await testShifts();
    await new Promise(resolve => setTimeout(resolve, 1000));
    results.shifts_history = await testShiftHistory();
    await new Promise(resolve => setTimeout(resolve, 1000));
    results.shifts_summary = await testShiftSummary();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 5. CORTES DE CAJA
    results.cash_cuts_create = await testCashCuts();
    await new Promise(resolve => setTimeout(resolve, 1000));
    results.cash_cuts_get = await testGetCashCuts();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 6. GUARDIAN EVENTS
    results.guardian_create = await testGuardianEvents();
    await new Promise(resolve => setTimeout(resolve, 1000));
    results.guardian_get = await testGetGuardianEvents();

    // RESUMEN FINAL
    console.log('\n\n═══════════════════════════════════════════════════════════════');
    console.log('📊 RESUMEN DE RESULTADOS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('1. VENTAS (SALES):');
    console.log(`   POST /api/sync/sales    ${results.sales_create ? '✅ OK (ID: ' + results.sales_create + ')' : '❌ FALLÓ'}`);
    console.log(`   GET  /api/sales         ${results.sales_get ? '✅ OK' : '❌ FALLÓ'}`);

    console.log('\n2. GASTOS (EXPENSES):');
    console.log(`   POST /api/sync/expenses ${results.expenses_create ? '✅ OK (ID: ' + results.expenses_create + ')' : '❌ FALLÓ'}`);
    console.log(`   GET  /api/expenses      ${results.expenses_get ? '✅ OK' : '❌ FALLÓ'}`);

    console.log('\n3. COMPRAS (PURCHASES):');
    console.log(`   GET  /api/purchases     ${results.purchases_get ? '✅ OK' : '⚠️ NO IMPLEMENTADO'}`);

    console.log('\n4. TURNOS (SHIFTS):');
    console.log(`   POST /api/shifts/open   ${results.shifts_create ? '✅ OK (ID: ' + results.shifts_create + ')' : '❌ FALLÓ'}`);
    console.log(`   GET  /api/shifts/history ${results.shifts_history ? '✅ OK' : '❌ FALLÓ'}`);
    console.log(`   GET  /api/shifts/summary ${results.shifts_summary ? '✅ OK' : '❌ FALLÓ'}`);

    console.log('\n5. CORTES DE CAJA (CASH CUTS):');
    console.log(`   POST /api/sync/cash-cuts ${results.cash_cuts_create ? '✅ OK (ID: ' + results.cash_cuts_create + ')' : '❌ FALLÓ'}`);
    console.log(`   GET  /api/cash-cuts      ${results.cash_cuts_get ? '✅ OK' : '❌ FALLÓ'}`);

    console.log('\n6. EVENTOS GUARDIAN:');
    console.log(`   POST /api/guardian-events ${results.guardian_create ? '✅ OK (ID: ' + results.guardian_create + ')' : '❌ FALLÓ'}`);
    console.log(`   GET  /api/guardian-events ${results.guardian_get ? '✅ OK' : '❌ FALLÓ'}`);

    const totalTests = Object.values(results).filter(r => r !== null).length;
    const passedTests = Object.values(results).filter(r => r === true || (typeof r === 'number' && r > 0)).length;

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`✅ TESTS PASADOS: ${passedTests}/${totalTests}`);
    console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(error => {
    console.error('\n❌ ERROR FATAL:', error);
    process.exit(1);
});
