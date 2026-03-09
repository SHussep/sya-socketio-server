#!/usr/bin/env node

/**
 * Test script para verificar el endpoint POST /api/notifications/send-event
 * Simula un evento de login desde Desktop
 */

const https = require('https');

async function testNotificationEndpoint() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🧪 TEST: Notification Endpoint /api/notifications/send-event');
  console.log('═══════════════════════════════════════════════════════════\n');

  const payload = {
    employeeId: 3,
    tenantId: 3,
    eventType: 'login',
    userName: 'Saul Corona',
    scaleStatus: 'connected',
    eventTime: new Date().toISOString(),
    data: {
      extra: 'test data'
    }
  };

  const postData = JSON.stringify(payload);

  const options = {
    hostname: 'sya-socketio-server.onrender.com',
    port: 443,
    path: '/api/notifications/send-event',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  console.log('📤 Enviando solicitud POST...');
  console.log(`   URL: https://${options.hostname}${options.path}`);
  console.log(`   Método: ${options.method}`);
  console.log(`   Payload:\n${JSON.stringify(payload, null, 2)}\n`);

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log(`\n✅ Respuesta recibida`);
        console.log(`📊 Status Code: ${res.statusCode}`);
        console.log(`📋 Headers:`, res.headers);

        try {
          const parsedData = JSON.parse(data);
          console.log(`📝 Response Body:\n${JSON.stringify(parsedData, null, 2)}`);
        } catch (e) {
          console.log(`📝 Response Body:\n${data}`);
        }

        if (res.statusCode === 200) {
          console.log('\n✅ ¡TEST EXITOSO! El endpoint está funcionando correctamente.\n');
        } else {
          console.log(`\n⚠️ Status code ${res.statusCode} - Verificar respuesta arriba.\n`);
        }

        resolve();
      });
    });

    req.on('error', (error) => {
      console.error(`\n❌ Error: ${error.message}`);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

// Ejecutar test
testNotificationEndpoint()
  .then(() => {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Test completado');
    console.log('═══════════════════════════════════════════════════════════\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Test falló:', err);
    process.exit(1);
  });
