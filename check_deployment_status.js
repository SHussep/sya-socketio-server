#!/usr/bin/env node

/**
 * Check if employees endpoint is available on Render
 * Usage: node check_deployment_status.js
 */

const https = require('https');

const RENDER_API = 'https://sya-socketio-server.onrender.com';

async function checkEndpoint() {
    console.log('[Deployment Check] 🔍 Verificando estado del servidor...');
    console.log(`[Deployment Check] 📍 URL: ${RENDER_API}/api/employees`);
    console.log('');

    const testPayload = {
        tenantId: 1,
        branchId: 1,
        fullName: 'Test',
        username: 'test',
        email: 'test@example.com',
        roleId: 1
    };

    return new Promise((resolve) => {
        const postData = JSON.stringify(testPayload);

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(`${RENDER_API}/api/employees`, options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 200 || res.statusCode === 400 || res.statusCode === 500) {
                    console.log('✅ [Deployment Check] ÉXITO: Endpoint está activo');
                    console.log(`[Deployment Check] Status: ${res.statusCode}`);
                    console.log(`[Deployment Check] Response: ${data.substring(0, 100)}...`);
                    resolve(true);
                } else if (res.statusCode === 404) {
                    console.log('❌ [Deployment Check] FALLO: Endpoint NO ENCONTRADO (404)');
                    console.log(`[Deployment Check] Render aún no ha desplegado los cambios`);
                    console.log(`[Deployment Check] Response: ${data}`);
                    resolve(false);
                } else {
                    console.log(`⚠️  [Deployment Check] Status inesperado: ${res.statusCode}`);
                    console.log(`[Deployment Check] Response: ${data.substring(0, 100)}...`);
                    resolve(false);
                }
            });
        });

        req.on('error', (error) => {
            console.log(`❌ [Deployment Check] Error de conexión: ${error.message}`);
            resolve(false);
        });

        // Set timeout
        req.setTimeout(10000, () => {
            console.log('⚠️  [Deployment Check] Timeout - servidor no responde');
            req.destroy();
            resolve(false);
        });

        req.write(postData);
        req.end();
    });
}

async function main() {
    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║     DEPLOYMENT STATUS CHECK - Employees Endpoint   ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log('');

    const success = await checkEndpoint();
    console.log('');

    if (success) {
        console.log('✅ Endpoint está activo. El deploy fue exitoso.');
        console.log('');
        console.log('Próximos pasos:');
        console.log('1. Intenta agregar un nuevo empleado en WinUI');
        console.log('2. Verifica los logs en Visual Studio Output');
        console.log('3. Confirma que aparece en PostgreSQL');
    } else {
        console.log('❌ Endpoint NO está disponible.');
        console.log('');
        console.log('Posibles causas:');
        console.log('- Render aún está desplegando (espera 2-5 minutos)');
        console.log('- El nuevo archivo routes/employees.js no se desplegó');
        console.log('- Error en server.js al cargar las rutas');
        console.log('');
        console.log('Soluciones:');
        console.log('1. Espera 5 minutos y vuelve a intentar');
        console.log('2. Verifica los logs en https://dashboard.render.com');
        console.log('3. Si persiste, fuerza un redeploy:');
        console.log('   - git commit --allow-empty -m "Force redeploy"');
        console.log('   - git push');
    }

    process.exit(success ? 0 : 1);
}

main().catch(console.error);
