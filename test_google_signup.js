// ═══════════════════════════════════════════════════════════════
// TEST: Google Signup Endpoint
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

const API_URL = 'http://localhost:3000';

async function testGoogleSignup() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🧪 PRUEBA: Google Signup Endpoint                      ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        // Datos de prueba
        const testData = {
            idToken: 'fake-google-token-for-testing',
            email: 'test.user@gmail.com',
            displayName: 'Test User',
            businessName: 'Tortillería de Prueba',
            phoneNumber: '6641234567',
            address: 'Calle Falsa 123, Tijuana, BC',
            password: '1234',
            timezone: 'America/Tijuana'
        };

        console.log('📝 Enviando solicitud de registro...');
        console.log('📧 Email:', testData.email);
        console.log('🏢 Negocio:', testData.businessName);
        console.log('🌍 Timezone:', testData.timezone);
        console.log('');

        const response = await axios.post(`${API_URL}/api/auth/google-signup`, testData);

        if (response.data.success) {
            console.log('✅ REGISTRO EXITOSO!\n');
            console.log('📊 Respuesta del servidor:');
            console.log(JSON.stringify(response.data, null, 2));
            console.log('\n🎯 IDs asignados:');
            console.log('   - Tenant ID:', response.data.tenant.id);
            console.log('   - Branch ID:', response.data.branch.id);
            console.log('   - Employee ID:', response.data.employee.id);
            console.log('   - Tenant Code:', response.data.tenant.tenantCode);
            console.log('   - Branch Code:', response.data.branch.branchCode);
            console.log('\n🔑 Credenciales:');
            console.log('   - Username:', response.data.employee.username);
            console.log('   - Email:', response.data.employee.email);
            console.log('   - Role:', response.data.employee.role);
            console.log('\n💳 Subscripción:');
            console.log('   - Status:', response.data.tenant.subscriptionStatus);
            console.log('   - Trial hasta:', response.data.tenant.trialEndsAt);
            console.log('\n🔐 JWT Token:');
            console.log('   -', response.data.token ? '✅ Token generado' : '❌ No se generó token');
        } else {
            console.error('❌ REGISTRO FALLIDO');
            console.error('Mensaje:', response.data.message);
        }

    } catch (error) {
        console.error('\n❌ ERROR en la prueba:');
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Mensaje:', error.response.data.message || error.response.statusText);
            console.error('   Detalles:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('   Error:', error.message);
        }
        console.error('\n📋 Stack trace:', error.stack);
    }
}

// Función para verificar que el servidor está corriendo
async function checkServer() {
    try {
        const response = await axios.get(`${API_URL}/health`);
        console.log('✅ Servidor en línea');
        console.log('📊 Stats:', JSON.stringify(response.data.stats, null, 2));
        return true;
    } catch (error) {
        console.error('❌ Servidor no disponible en', API_URL);
        console.error('   Por favor, inicia el servidor con: npm start');
        return false;
    }
}

// Ejecutar pruebas
(async () => {
    console.clear();
    const serverRunning = await checkServer();
    if (serverRunning) {
        await testGoogleSignup();
    }
})();
