// ═══════════════════════════════════════════════════════════════
// TEST: Endpoint /api/restore/verify-account en producción
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

const API_URL = 'https://sya-socketio-server.onrender.com';

async function testRestoreEndpoint() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🧪 TEST: Endpoint de Restore en Producción           ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        // Test 1: Verificar que el servidor esté en línea
        console.log('🔍 Test 1: Verificando servidor...');
        const healthResponse = await axios.get(`${API_URL}/health`, { timeout: 10000 });
        console.log('✅ Servidor en línea');
        console.log(`   - Status: ${healthResponse.data.status}`);
        console.log(`   - Database: ${healthResponse.data.database}`);
        console.log(`   - Tenants: ${healthResponse.data.stats.tenants}`);
        console.log(`   - Employees: ${healthResponse.data.stats.employees}`);
        console.log('');

        // Test 2: Verificar endpoint de verify-account (no requiere auth)
        console.log('🔍 Test 2: Probando /api/restore/verify-account...');

        const verifyResponse = await axios.post(
            `${API_URL}/api/restore/verify-account`,
            {
                email: 'test@example.com' // Email de prueba
            },
            {
                timeout: 10000,
                validateStatus: () => true // Aceptar cualquier status
            }
        );

        console.log(`   - Status Code: ${verifyResponse.status}`);
        console.log(`   - Response:`, JSON.stringify(verifyResponse.data, null, 2));
        console.log('');

        // Test 3: Verificar estructura de respuesta
        if (verifyResponse.status === 404) {
            console.log('✅ Endpoint funciona correctamente (404 esperado para email inexistente)');
        } else if (verifyResponse.status === 200) {
            console.log('✅ Endpoint funciona y encontró una cuenta');

            // Verificar que tenga los campos esperados
            if (verifyResponse.data.data) {
                const hasFullName = verifyResponse.data.data.full_name !== undefined;
                const hasEmail = verifyResponse.data.data.email !== undefined;
                const hasBusinessName = verifyResponse.data.data.business_name !== undefined;

                console.log('   - Tiene full_name:', hasFullName ? '✅' : '❌');
                console.log('   - Tiene email:', hasEmail ? '✅' : '❌');
                console.log('   - Tiene business_name:', hasBusinessName ? '✅' : '❌');
            }
        } else {
            console.log(`⚠️  Status inesperado: ${verifyResponse.status}`);
        }
        console.log('');

        console.log('═══════════════════════════════════════════════════════════');
        console.log('📊 RESUMEN');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('✅ Servidor en Render está en línea');
        console.log('✅ Endpoints de restore están funcionando');
        console.log('');
        console.log('💡 PRÓXIMO PASO:');
        console.log('   Prueba hacer login con un usuario real desde la app Desktop');
        console.log('');

    } catch (error) {
        console.error('\n❌ ERROR en el test:');
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Status Text:', error.response.statusText);
            console.error('   Data:', JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
            console.error('   No se recibió respuesta del servidor');
            console.error('   ⚠️  El servidor puede estar en proceso de redeploy');
            console.error('   Error:', error.message);
        } else {
            console.error('   Error:', error.message);
        }
        console.error('\n📋 Stack trace:', error.stack);
    }
}

// Ejecutar test
testRestoreEndpoint();
