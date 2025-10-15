// Test del refresh token de la app vieja de Dropbox
const fetch = require('node-fetch');

const OLD_APP_KEY = 'zf6rn0c3dyq5ji0';
const OLD_APP_SECRET = 'sindb8xm948blvo';
const OLD_REFRESH_TOKEN = 'gcdjgrGh7twAAAAAAAAAAeA1mIfsFNXPB47yzoRVL-zZuSsDw8QUTdsYoATNMu_F';

async function testOldRefreshToken() {
    try {
        console.log('\n🧪 Probando refresh token de la APP ANTERIOR de Dropbox...\n');
        console.log(`App Key: ${OLD_APP_KEY}`);
        console.log(`Refresh Token: ${OLD_REFRESH_TOKEN.substring(0, 20)}...\n`);

        const response = await fetch('https://api.dropbox.com/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: OLD_REFRESH_TOKEN,
                client_id: OLD_APP_KEY,
                client_secret: OLD_APP_SECRET
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error('❌ Error:', data.error_description || data.error);
            console.log('\nPosibles razones:');
            console.log('- La app fue eliminada');
            console.log('- El refresh token fue revocado');
            console.log('- Las credenciales cambiaron\n');
            return;
        }

        if (data.access_token) {
            console.log('═══════════════════════════════════════════════════════════');
            console.log('✅ ¡EL REFRESH TOKEN FUNCIONA!');
            console.log('═══════════════════════════════════════════════════════════\n');
            console.log('Nuevo access token generado:');
            console.log(data.access_token.substring(0, 50) + '...\n');
            console.log(`Expira en: ${data.expires_in} segundos (${data.expires_in / 3600} horas)\n`);
            console.log('═══════════════════════════════════════════════════════════');
            console.log('RECOMENDACIÓN:');
            console.log('═══════════════════════════════════════════════════════════\n');
            console.log('Opción 1: Usar esta APP VIEJA (tiene refresh token que funciona)');
            console.log('   - Actualiza el .env con estos valores');
            console.log('   - Esta app ya está probada y funciona\n');
            console.log('Opción 2: Crear una NUEVA app con configuración correcta');
            console.log('   - Necesitas configurar correctamente los permisos');
            console.log('   - Requiere completar el OAuth flow de nuevo\n');
            console.log('═══════════════════════════════════════════════════════════\n');
        } else {
            console.error('❌ Respuesta inesperada:', data);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

testOldRefreshToken();
