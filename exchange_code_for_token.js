// Script para intercambiar el código de autorización por tokens
// Uso: node exchange_code_for_token.js TU_CODIGO_AQUI

const APP_KEY = 'tgmvr7snr4vbxb9';
const APP_SECRET = 'vrsgbq7tt44awpw';

const authCode = process.argv[2];

if (!authCode) {
    console.error('❌ Error: Debes proporcionar el código de autorización');
    console.error('Uso: node exchange_code_for_token.js TU_CODIGO_AQUI');
    process.exit(1);
}

async function exchangeCode() {
    try {
        const fetch = (await import('node-fetch')).default;

        console.log('\n⏳ Intercambiando código por tokens...\n');

        const response = await fetch('https://api.dropbox.com/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                code: authCode,
                grant_type: 'authorization_code',
                client_id: APP_KEY,
                client_secret: APP_SECRET
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error('❌ Error:', data.error_description || data.error);
            process.exit(1);
        }

        if (data.access_token) {
            if (data.refresh_token) {
                // ✅ Caso ideal: obtuvimos ambos tokens
                console.log('═══════════════════════════════════════════════════════════');
                console.log('✅ TOKENS GENERADOS EXITOSAMENTE');
                console.log('═══════════════════════════════════════════════════════════\n');
                console.log('Actualiza tu archivo .env con estos valores:\n');
                console.log(`DROPBOX_ACCESS_TOKEN=${data.access_token}`);
                console.log(`DROPBOX_REFRESH_TOKEN=${data.refresh_token}`);
                console.log(`DROPBOX_APP_KEY=${APP_KEY}`);
                console.log(`DROPBOX_APP_SECRET=${APP_SECRET}`);
                console.log('\n═══════════════════════════════════════════════════════════\n');
                console.log('⚠️  IMPORTANTE:');
                console.log('- El REFRESH_TOKEN nunca expira (guárdalo seguro)');
                console.log('- El ACCESS_TOKEN expira en ~4 horas');
                console.log('- Tu servidor automáticamente renovará el access token\n');
                console.log('═══════════════════════════════════════════════════════════\n');
            } else {
                // ⚠️ Solo obtuvimos access_token (sin refresh_token)
                console.log('\n⚠️  ADVERTENCIA: No se obtuvo REFRESH_TOKEN\n');
                console.log('═══════════════════════════════════════════════════════════');
                console.log('Respuesta de Dropbox:');
                console.log('═══════════════════════════════════════════════════════════\n');
                console.log(JSON.stringify(data, null, 2));
                console.log('\n═══════════════════════════════════════════════════════════');
                console.log('PROBLEMA IDENTIFICADO:');
                console.log('═══════════════════════════════════════════════════════════\n');
                console.log('El código de autorización no incluyó "token_access_type=offline".\n');
                console.log('SOLUCIÓN:');
                console.log('1. Vuelve a ejecutar: node get_refresh_token_fixed.js');
                console.log('2. Usa la URL que ese script te dé (incluye token_access_type=offline)');
                console.log('3. Vuelve a autorizar y obtén un NUEVO código');
                console.log('4. Vuelve a ejecutar este script con el nuevo código\n');
                console.log('═══════════════════════════════════════════════════════════\n');
            }
        } else {
            console.error('❌ Respuesta inesperada:', data);
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

exchangeCode();
