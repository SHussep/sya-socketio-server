// ═══════════════════════════════════════════════════════════════
// TEST: Google Signup Endpoint en PRODUCCIÓN
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

const API_URL = 'https://sya-socketio-server.onrender.com';

async function testGoogleSignup() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🧪 PRUEBA: Google Signup en PRODUCCIÓN                ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        // Datos de prueba con email único usando timestamp
        const uniqueEmail = `test${Date.now()}@example.com`;
        const testData = {
            idToken: 'fake-google-token-for-testing',
            email: uniqueEmail,
            displayName: 'Test Production User',
            businessName: 'Tortillería de Prueba Producción',
            phoneNumber: '6641234567',
            address: 'Calle Falsa 123, Tijuana, BC',
            password: '1234',
            timezone: 'America/Tijuana'
        };

        console.log('📝 Enviando solicitud de registro a:', API_URL);
        console.log('📧 Email:', testData.email);
        console.log('🏢 Negocio:', testData.businessName);
        console.log('🌍 Timezone:', testData.timezone);
        console.log('');

        const response = await axios.post(`${API_URL}/api/auth/google-signup`, testData, {
            timeout: 30000,
            validateStatus: () => true // Aceptar cualquier status code
        });

        console.log('📊 Status Code:', response.status);
        console.log('📊 Respuesta del servidor:');
        console.log(JSON.stringify(response.data, null, 2));

        if (response.data.success) {
            console.log('\n✅ REGISTRO EXITOSO!');
            console.log('\n🎯 IDs asignados:');
            console.log('   - Tenant ID:', response.data.tenant.id);
            console.log('   - Branch ID:', response.data.branch.id);
            console.log('   - Employee ID:', response.data.employee.id);
        } else {
            console.error('\n❌ REGISTRO FALLIDO');
            console.error('Mensaje:', response.data.message);
            if (response.data.error) {
                console.error('Error detallado:', response.data.error);
            }
        }

    } catch (error) {
        console.error('\n❌ ERROR en la prueba:');
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Status Text:', error.response.statusText);
            console.error('   Mensaje:', error.response.data?.message || 'Sin mensaje');
            console.error('   Detalles completos:');
            console.error(JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
            console.error('   No se recibió respuesta del servidor');
            console.error('   Error:', error.message);
        } else {
            console.error('   Error:', error.message);
        }
        console.error('\n📋 Stack trace:', error.stack);
    }
}

// Función para verificar que el servidor está corriendo
async function checkServer() {
    try {
        console.log('🔍 Verificando servidor en:', API_URL);
        const response = await axios.get(`${API_URL}/health`, { timeout: 10000 });
        console.log('✅ Servidor en línea');
        console.log('📊 Database:', response.data.database);
        console.log('📊 Stats:', JSON.stringify(response.data.stats, null, 2));
        console.log('');
        return true;
    } catch (error) {
        console.error('❌ Servidor no disponible');
        console.error('   Error:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', JSON.stringify(error.response.data, null, 2));
        }
        return false;
    }
}

// Ejecutar pruebas
(async () => {
    const serverRunning = await checkServer();
    if (serverRunning) {
        await testGoogleSignup();
    } else {
        console.error('\n⚠️ El servidor no está disponible. Verifica los logs en Render.');
    }
})();
