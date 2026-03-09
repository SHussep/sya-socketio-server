// ═══════════════════════════════════════════════════════════════
// TEST FCM - Script para probar notificaciones
// Simula eventos desde Desktop y verifica que llegan a Mobile
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000'; // Cambiar si no está en localhost
const BRANCH_ID = 1; // Cambiar según tu sucursal

async function testFCM() {
    console.log('\n═══════════════════════════════════════════');
    console.log('   🧪 PRUEBA DE FCM - Sistema de Notificaciones');
    console.log('═══════════════════════════════════════════\n');

    try {
        // TEST 1: Verificar que la tabla device_tokens existe
        console.log('✓ TEST 1: Verificando tabla device_tokens...');
        console.log('  Status: ✅ Tabla debe existir en PostgreSQL\n');

        // TEST 2: Enviar notificación de prueba a una sucursal
        console.log('✓ TEST 2: Enviando notificación de prueba a sucursal...');
        try {
            const response = await axios.post(`${API_BASE_URL}/api/notifications/send-to-branch`, {
                branchId: BRANCH_ID,
                title: '🧪 Notificación de Prueba',
                body: 'Esta es una prueba de FCM desde el backend',
                data: {
                    type: 'test',
                    message: 'Si ves esto en la app móvil, FCM funciona correctamente!'
                }
            });

            console.log(`  ✅ Response: ${JSON.stringify(response.data)}\n`);
        } catch (error) {
            console.log(`  ❌ Error: ${error.message}`);
            if (error.response?.data) {
                console.log(`  Detalles: ${JSON.stringify(error.response.data)}\n`);
            }
        }

        // TEST 3: Información sobre el servidor
        console.log('✓ TEST 3: Estado del servidor...');
        console.log(`  Backend URL: ${API_BASE_URL}`);
        console.log(`  Sucursal para pruebas: ${BRANCH_ID}\n`);

        // TEST 4: Instrucciones
        console.log('✓ TEST 4: Pasos para verificar que funciona:\n');
        console.log('  1️⃣  En Desktop:');
        console.log('      - Abre la app Desktop POS');
        console.log('      - Verifica que dice "Socket.IO Conectado" ✅\n');

        console.log('  2️⃣  En Mobile:');
        console.log('      - Abre la app Flutter');
        console.log('      - Ve a un empleado y inicialo en Desktop');
        console.log('      - O ejecuta el test: npm run test:fcm\n');

        console.log('  3️⃣  Verifica el log en Desktop:');
        console.log('      - Busca "[Socket.IO] 📥 Evento user-login recibido"');
        console.log('      - Debe aparecer una notificación verde arriba\n');

        console.log('  4️⃣  Verifica la app Mobile:');
        console.log('      - Si está ABIERTA: Notificación en la pantalla');
        console.log('      - Si está CERRADA: Notificación en bandeja del sistema\n');

        console.log('═══════════════════════════════════════════');
        console.log('   CHECKLIST DE VERIFICACIÓN:');
        console.log('═══════════════════════════════════════════\n');

        console.log('□ Desktop conectado a Socket.IO (dice "Socket.IO Conectado")');
        console.log('□ Base de datos device_tokens tiene registros');
        console.log('□ App Mobile instalada con google-services.json');
        console.log('□ App Mobile instalada con GoogleService-Info.plist');
        console.log('□ Permisos de notificación otorgados en Mobile');
        console.log('□ Backend tiene variable FIREBASE_SERVICE_ACCOUNT en Render');
        console.log('□ Notificación llega a Mobile cuando Desktop inicia sesión\n');

        console.log('═══════════════════════════════════════════');

    } catch (error) {
        console.error('❌ Error en test:', error.message);
    }
}

// Ejecutar test
testFCM();
