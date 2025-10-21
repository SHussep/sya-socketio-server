#!/usr/bin/env node

/**
 * Script para probar el flujo COMPLETO de sincronización de ventas
 * Simula exactamente lo que hace el cliente WinUI
 *
 * Uso: node test_sync_complete_flow.js
 */

const http = require('http');
const https = require('https');

// Configuración
const BACKEND_URL = 'https://sya-socketio-server.onrender.com';
const TENANT_ID = 3;
const BRANCH_ID = 13;
const EMPLOYEE_ID = 3;
const TICKET_NUMBER = Math.floor(Math.random() * 1000);
const TOTAL_AMOUNT = 100.00;
const PAYMENT_METHOD = 'Efectivo';
const USER_EMAIL = 'entretierras.podcast@gmail.com';

// Fecha en ISO 8601 UTC (igual que el cliente)
const FECHA_VENTA = new Date().toISOString();

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  TEST COMPLETO: Sincronización de Venta                   ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

console.log('📋 CONFIGURACIÓN:');
console.log(`  Backend URL: ${BACKEND_URL}`);
console.log(`  Tenant ID: ${TENANT_ID}`);
console.log(`  Branch ID: ${BRANCH_ID}`);
console.log(`  Employee ID: ${EMPLOYEE_ID}`);
console.log(`  Ticket #: ${TICKET_NUMBER}`);
console.log(`  Total: $${TOTAL_AMOUNT}`);
console.log(`  Fecha: ${FECHA_VENTA}\n`);

// Payload exacto que envía el cliente
const payload = {
    tenantId: TENANT_ID,
    branchId: BRANCH_ID,
    employeeId: EMPLOYEE_ID,
    ticketNumber: TICKET_NUMBER,
    totalAmount: TOTAL_AMOUNT,
    paymentMethod: PAYMENT_METHOD,
    userEmail: USER_EMAIL,
    fechaVenta: FECHA_VENTA
};

console.log('📤 PAYLOAD QUE SE ENVIARÁ:');
console.log(JSON.stringify(payload, null, 2));
console.log('\n═════════════════════════════════════════════════════════════\n');

// Función para hacer POST
function postToBackend(url, payload) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const client = isHttps ? https : http;

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'SYA-Client-Test/1.0'
            },
            timeout: 30000 // 30 segundos como el cliente
        };

        console.log(`🚀 ENVIANDO POST a ${url}`);
        console.log(`   Opción: ${options.method} ${options.path}`);
        console.log(`   Host: ${options.hostname}\n`);

        const startTime = Date.now();

        const req = client.request(options, (res) => {
            let data = '';

            console.log(`⏱️  RESPUESTA RECIBIDA:`);
            console.log(`   Status Code: ${res.statusCode}`);
            console.log(`   Status Message: ${res.statusMessage}`);
            console.log(`   Headers: ${JSON.stringify(res.headers, null, 2)}\n`);

            res.on('data', (chunk) => {
                data += chunk;
                console.log(`📦 Recibiendo datos... (${data.length} bytes)\n`);
            });

            res.on('end', () => {
                const duration = Date.now() - startTime;
                console.log(`✅ DESCARGA COMPLETA`);
                console.log(`   Duración total: ${duration}ms`);
                console.log(`   Tamaño total: ${data.length} bytes\n`);

                console.log(`📄 RESPUESTA COMPLETA:`);
                try {
                    const json = JSON.parse(data);
                    console.log(JSON.stringify(json, null, 2));
                    resolve({
                        success: true,
                        statusCode: res.statusCode,
                        body: json,
                        rawBody: data,
                        duration
                    });
                } catch (e) {
                    console.log(data);
                    resolve({
                        success: false,
                        statusCode: res.statusCode,
                        body: data,
                        rawBody: data,
                        duration,
                        parseError: e.message
                    });
                }
            });
        });

        req.on('error', (error) => {
            console.error(`❌ ERROR DE CONEXIÓN:`);
            console.error(`   ${error.message}\n`);
            reject(error);
        });

        req.on('timeout', () => {
            console.error(`❌ TIMEOUT (30 segundos)\n`);
            req.destroy();
            reject(new Error('Request timeout'));
        });

        const jsonPayload = JSON.stringify(payload);
        console.log(`📝 Enviando ${jsonPayload.length} bytes de JSON\n`);

        req.write(jsonPayload);
        req.end();
    });
}

// Ejecutar el test
(async () => {
    try {
        const result = await postToBackend(`${BACKEND_URL}/api/sync/sales`, payload);

        console.log('\n═════════════════════════════════════════════════════════════');
        console.log('📊 RESUMEN DEL TEST:');
        console.log('═════════════════════════════════════════════════════════════\n');

        if (result.statusCode === 200 && result.success) {
            console.log('✅ ÉXITO COMPLETO');
            console.log(`   Status: ${result.statusCode}`);
            console.log(`   Duración: ${result.duration}ms`);
            console.log(`   Venta guardada: ${result.body.data?.id || 'ID no disponible'}`);
        } else if (result.statusCode >= 400) {
            console.log('❌ ERROR EN LA SOLICITUD');
            console.log(`   Status: ${result.statusCode}`);
            console.log(`   Mensaje: ${result.body.message || result.rawBody}`);
        } else {
            console.log('⚠️  RESPUESTA INESPERADA');
            console.log(`   Status: ${result.statusCode}`);
            console.log(`   Duración: ${result.duration}ms`);
        }

        console.log('\n═════════════════════════════════════════════════════════════');
        console.log('🔍 VERIFICACIÓN EN BASE DE DATOS:');
        console.log('═════════════════════════════════════════════════════════════\n');
        console.log(`Ejecuta en Node.js:\n`);
        console.log(`  const { Pool } = require('pg');`);
        console.log(`  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });`);
        console.log(`  const result = await pool.query('SELECT * FROM sales WHERE ticket_number = $1 AND tenant_id = $2', [${TICKET_NUMBER}, ${TENANT_ID}]);`);
        console.log(`  console.log(result.rows);`);
        console.log(`  await pool.end();\n`);

        process.exit(0);

    } catch (error) {
        console.error('\n❌ ERROR FATAL:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
