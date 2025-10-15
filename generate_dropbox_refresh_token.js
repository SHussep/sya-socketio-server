// Script para generar Dropbox Refresh Token
// Ejecutar: node generate_dropbox_refresh_token.js

const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log('═══════════════════════════════════════════════════════════');
console.log('  GENERADOR DE DROPBOX REFRESH TOKEN');
console.log('═══════════════════════════════════════════════════════════\n');

let appKey, appSecret;

rl.question('1. Ingresa tu DROPBOX_APP_KEY: ', (key) => {
    appKey = key.trim();

    rl.question('2. Ingresa tu DROPBOX_APP_SECRET: ', (secret) => {
        appSecret = secret.trim();

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('PASO 3: Autorizar la aplicación');
        console.log('═══════════════════════════════════════════════════════════\n');

        const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${appKey}&response_type=code&token_access_type=offline`;

        console.log('Abre esta URL en tu navegador:\n');
        console.log(authUrl);
        console.log('\n1. Inicia sesión en Dropbox');
        console.log('2. Autoriza la aplicación');
        console.log('3. Copia el código de autorización que aparece\n');

        rl.question('4. Pega el código de autorización aquí: ', async (code) => {
            const authCode = code.trim();

            try {
                const fetch = (await import('node-fetch')).default;

                console.log('\n⏳ Generando refresh token...\n');

                const response = await fetch('https://api.dropbox.com/oauth2/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: new URLSearchParams({
                        code: authCode,
                        grant_type: 'authorization_code',
                        client_id: appKey,
                        client_secret: appSecret
                    })
                });

                const data = await response.json();

                if (data.access_token) {
                    console.log('═══════════════════════════════════════════════════════════');
                    console.log('✅ TOKENS GENERADOS EXITOSAMENTE');
                    console.log('═══════════════════════════════════════════════════════════\n');
                    console.log('Agrega estos valores a tu archivo .env:\n');
                    console.log(`DROPBOX_ACCESS_TOKEN=${data.access_token}`);
                    console.log(`DROPBOX_REFRESH_TOKEN=${data.refresh_token}`);
                    console.log(`DROPBOX_APP_KEY=${appKey}`);
                    console.log(`DROPBOX_APP_SECRET=${appSecret}`);
                    console.log('\n═══════════════════════════════════════════════════════════\n');
                    console.log('⚠️  IMPORTANTE:');
                    console.log('- El REFRESH_TOKEN nunca expira (guárdalo bien)');
                    console.log('- El ACCESS_TOKEN expira en 4 horas');
                    console.log('- El servidor automáticamente renovará el access token usando el refresh token');
                    console.log('\n═══════════════════════════════════════════════════════════\n');
                } else {
                    console.error('❌ Error:', data);
                }
            } catch (error) {
                console.error('❌ Error generando tokens:', error.message);
            }

            rl.close();
        });
    });
});
