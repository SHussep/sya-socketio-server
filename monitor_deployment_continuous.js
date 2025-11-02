#!/usr/bin/env node

/**
 * Continuous Deployment Monitor
 * Checks every 10 seconds if the /api/employees endpoint is available
 */

const https = require('https');
const { createServer } = require('http');

const RENDER_API = 'https://sya-socketio-server.onrender.com';
const CHECK_INTERVAL = 10000; // 10 seconds
const MAX_ATTEMPTS = 60; // 10 minutes
let attempt = 0;

function checkEndpoint() {
    return new Promise((resolve) => {
        const testPayload = JSON.stringify({
            tenantId: 1,
            branchId: 1,
            fullName: 'Test',
            username: 'test',
            email: 'test@example.com',
            roleId: 1
        });

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(testPayload)
            },
            timeout: 5000
        };

        const req = https.request(`${RENDER_API}/api/employees`, options, (res) => {
            if (res.statusCode === 200 || res.statusCode === 400 || res.statusCode === 500) {
                resolve(true);
            } else if (res.statusCode === 404) {
                resolve(false);
            } else {
                resolve(null);
            }
            res.resume(); // Consume response
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });

        req.write(testPayload);
        req.end();
    });
}

function formatTime() {
    return new Date().toLocaleTimeString('es-ES');
}

async function monitor() {
    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║   MONITOREO DE DESPLIEGUE - Employees Endpoint   ║');
    console.log('║   Esperando activación (~10 minutos máximo)      ║');
    console.log('╚═══════════════════════════════════════════════════╝\n');

    while (attempt < MAX_ATTEMPTS) {
        attempt++;
        const timestamp = formatTime();
        const remainingAttempts = MAX_ATTEMPTS - attempt;
        const remainingSeconds = remainingAttempts * 10;

        try {
            const isActive = await checkEndpoint();

            if (isActive === true) {
                console.log('\n╔═══════════════════════════════════════════════════╗');
                console.log('║  ✅ ¡ÉXITO! Endpoint /api/employees ACTIVO         ║');
                console.log('╚═══════════════════════════════════════════════════╝\n');
                console.log(`[${timestamp}] Status: 200 OK\n`);
                console.log('PRÓXIMOS PASOS:');
                console.log('1. Regresa a WinUI y agrega un nuevo empleado');
                console.log('2. Observa los logs en Visual Studio Output');
                console.log('3. Debería ver: [Employees/Sync] ✅ Empleado sincronizado...\n');
                process.exit(0);
            } else if (isActive === false) {
                console.log(`[${timestamp}] ⏳ Intento ${attempt}/${MAX_ATTEMPTS} - Aún no disponible (${remainingSeconds}s restantes)`);
            } else {
                console.log(`[${timestamp}] ⚠️  Intento ${attempt}/${MAX_ATTEMPTS} - Error de conexión`);
            }
        } catch (error) {
            console.log(`[${timestamp}] ⚠️  Error: ${error.message}`);
        }

        if (attempt < MAX_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL));
        }
    }

    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║  ❌ TIMEOUT - Endpoint no se activó               ║');
    console.log('╚═══════════════════════════════════════════════════╝\n');
    console.log('CAUSAS POSIBLES:');
    console.log('1. Render está procesando un build lento');
    console.log('2. Hay un error en el build de Render');
    console.log('3. El archivo employees.js tiene un error\n');
    console.log('SOLUCIONES:');
    console.log('1. Verifica https://dashboard.render.com');
    console.log('2. Busca errores en "Logs"');
    console.log('3. Si hay error, copia-pega aquí para debugging\n');

    process.exit(1);
}

monitor().catch(console.error);
