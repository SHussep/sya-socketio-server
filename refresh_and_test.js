// Refrescar token y probar Dropbox
require('dotenv').config();
const fetch = require('node-fetch');
const { Dropbox } = require('dropbox');

async function refreshAndTest() {
    try {
        console.log('\n🔄 Paso 1: Refrescando access token...\n');

        // Refrescar el token
        const response = await fetch('https://api.dropbox.com/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
                client_id: process.env.DROPBOX_APP_KEY,
                client_secret: process.env.DROPBOX_APP_SECRET
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error('❌ Error al refrescar:', data.error_description || data.error);
            process.exit(1);
        }

        if (!data.access_token) {
            console.error('❌ No se obtuvo access_token');
            process.exit(1);
        }

        const newAccessToken = data.access_token;
        console.log('✅ Nuevo access token obtenido');
        console.log(`   Token: ${newAccessToken.substring(0, 30)}...`);
        console.log(`   Expira en: ${data.expires_in / 3600} horas\n`);

        // Actualizar en memoria
        process.env.DROPBOX_ACCESS_TOKEN = newAccessToken;

        console.log('🧪 Paso 2: Probando Dropbox con el nuevo token...\n');

        // Crear cliente de Dropbox
        const dbx = new Dropbox({
            accessToken: newAccessToken,
            fetch: fetch
        });

        // Test 1: Listar carpeta raíz
        console.log('📂 Test 1: Listando carpeta raíz...');
        const listResult = await dbx.filesListFolder({ path: '' });
        console.log(`✅ Carpeta raíz accesible. Archivos encontrados: ${listResult.result.entries.length}\n`);

        // Test 2: Crear carpeta
        console.log('📁 Test 2: Verificando carpeta /SYA Backups...');
        try {
            await dbx.filesCreateFolderV2({ path: '/SYA Backups' });
            console.log('✅ Carpeta /SYA Backups creada\n');
        } catch (err) {
            if (err.status === 409) {
                console.log('✅ Carpeta /SYA Backups ya existe\n');
            } else {
                throw err;
            }
        }

        // Test 3: Subir archivo de prueba
        console.log('📤 Test 3: Subiendo archivo de prueba...');
        const testContent = Buffer.from('Test con refresh token - ' + new Date().toISOString());
        const uploadResult = await dbx.filesUpload({
            path: '/SYA Backups/test_with_refresh_token.txt',
            contents: testContent,
            mode: { '.tag': 'overwrite' }
        });
        console.log(`✅ Archivo subido: ${uploadResult.result.path_display}`);
        console.log(`   Tamaño: ${uploadResult.result.size} bytes\n`);

        console.log('═══════════════════════════════════════════════════════════');
        console.log('✅ ÉXITO TOTAL - SISTEMA DE REFRESH TOKEN FUNCIONA');
        console.log('═══════════════════════════════════════════════════════════\n');
        console.log('📋 Próximos pasos:');
        console.log('1. Actualizar .env con el nuevo access token');
        console.log('2. Actualizar Render.com con las credenciales de la app vieja');
        console.log('3. El servidor automáticamente refrescará tokens cuando expiren\n');
        console.log(`Nuevo DROPBOX_ACCESS_TOKEN:\n${newAccessToken}\n`);

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.error) {
            console.error('Detalles:', JSON.stringify(error.error, null, 2));
        }
        process.exit(1);
    }
}

refreshAndTest();
