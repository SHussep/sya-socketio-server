// ═══════════════════════════════════════════════════════════════
// UTILIDAD: Refrescar Dropbox Access Token
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function refreshDropboxToken() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🔄 REFRESH: Dropbox Access Token                      ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        const { DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, DROPBOX_APP_SECRET } = process.env;

        if (!DROPBOX_REFRESH_TOKEN || !DROPBOX_APP_KEY || !DROPBOX_APP_SECRET) {
            console.error('❌ ERROR: Faltan credenciales de Dropbox en .env');
            console.error('   Requerido: DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, DROPBOX_APP_SECRET');
            return;
        }

        console.log('📝 Credenciales encontradas:');
        console.log(`   - APP_KEY: ${DROPBOX_APP_KEY}`);
        console.log(`   - APP_SECRET: ${DROPBOX_APP_SECRET ? 'Configurado ✓' : 'NO CONFIGURADO'}`);
        console.log(`   - REFRESH_TOKEN: ${DROPBOX_REFRESH_TOKEN.substring(0, 15)}...`);
        console.log('');

        console.log('🔄 Solicitando nuevo access token...');

        const response = await axios.post('https://api.dropbox.com/oauth2/token',
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: DROPBOX_REFRESH_TOKEN,
                client_id: DROPBOX_APP_KEY,
                client_secret: DROPBOX_APP_SECRET
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const { access_token, expires_in } = response.data;

        console.log('✅ NUEVO ACCESS TOKEN OBTENIDO!');
        console.log(`   - Expira en: ${expires_in} segundos (${(expires_in / 3600).toFixed(2)} horas)`);
        console.log(`   - Token: ${access_token.substring(0, 30)}...`);
        console.log('');

        // Actualizar archivo .env
        const envPath = path.join(__dirname, '.env');
        let envContent = fs.readFileSync(envPath, 'utf8');

        // Reemplazar el DROPBOX_ACCESS_TOKEN existente
        const tokenRegex = /DROPBOX_ACCESS_TOKEN=.*/;
        if (tokenRegex.test(envContent)) {
            envContent = envContent.replace(tokenRegex, `DROPBOX_ACCESS_TOKEN=${access_token}`);
            console.log('📝 Actualizando DROPBOX_ACCESS_TOKEN en .env...');
        } else {
            // Si no existe, agregarlo antes del REFRESH_TOKEN
            const refreshTokenLine = envContent.indexOf('DROPBOX_REFRESH_TOKEN');
            if (refreshTokenLine !== -1) {
                const insertPosition = envContent.lastIndexOf('\n', refreshTokenLine) + 1;
                envContent = envContent.slice(0, insertPosition) +
                    `DROPBOX_ACCESS_TOKEN=${access_token}\n` +
                    envContent.slice(insertPosition);
                console.log('📝 Agregando DROPBOX_ACCESS_TOKEN a .env...');
            }
        }

        fs.writeFileSync(envPath, envContent);
        console.log('✅ Archivo .env actualizado exitosamente!');

        console.log('\n⚠️  IMPORTANTE: Si estás corriendo en Render, actualiza la variable de entorno:');
        console.log('   1. Ve a tu servicio en Render Dashboard');
        console.log('   2. Settings → Environment Variables');
        console.log('   3. Actualiza DROPBOX_ACCESS_TOKEN con el nuevo valor');
        console.log('   4. Guarda los cambios (Render hará redeploy automático)');
        console.log('');
        console.log(`   Nuevo valor: ${access_token}`);
        console.log('');

        // Probar el nuevo token
        console.log('🧪 Probando nuevo token...');
        const { Dropbox } = require('dropbox');
        const dbx = new Dropbox({ accessToken: access_token });

        const accountInfo = await dbx.usersGetCurrentAccount();
        console.log('✅ TOKEN VÁLIDO!');
        console.log(`   - Cuenta: ${accountInfo.result.name.display_name}`);
        console.log(`   - Email: ${accountInfo.result.email}`);
        console.log('');

        console.log('🎉 PROCESO COMPLETADO EXITOSAMENTE!');

    } catch (error) {
        console.error('\n❌ ERROR al refrescar token:');
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('   Error:', error.message);
        }
        console.error('\n📋 Stack trace:', error.stack);
    }
}

// Ejecutar
refreshDropboxToken();
