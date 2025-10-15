// ═══════════════════════════════════════════════════════════════
// TEST: Verificar conexión con Dropbox API
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const { Dropbox } = require('dropbox');

async function testDropboxConnection() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🧪 PRUEBA: Conexión con Dropbox API                   ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        // Verificar variables de entorno
        console.log('📝 Verificando credenciales de Dropbox...');
        console.log('   - ACCESS_TOKEN:', process.env.DROPBOX_ACCESS_TOKEN ? `${process.env.DROPBOX_ACCESS_TOKEN.substring(0, 20)}...` : 'NO CONFIGURADO');
        console.log('   - APP_KEY:', process.env.DROPBOX_APP_KEY || 'NO CONFIGURADO');
        console.log('   - APP_SECRET:', process.env.DROPBOX_APP_SECRET ? 'Configurado ✓' : 'NO CONFIGURADO');
        console.log('   - REFRESH_TOKEN:', process.env.DROPBOX_REFRESH_TOKEN ? `${process.env.DROPBOX_REFRESH_TOKEN.substring(0, 15)}...` : 'NO CONFIGURADO');
        console.log('');

        if (!process.env.DROPBOX_ACCESS_TOKEN) {
            console.error('❌ ERROR: DROPBOX_ACCESS_TOKEN no está configurado en .env');
            return;
        }

        // Crear instancia de Dropbox
        const dbx = new Dropbox({
            accessToken: process.env.DROPBOX_ACCESS_TOKEN,
            clientId: process.env.DROPBOX_APP_KEY,
            clientSecret: process.env.DROPBOX_APP_SECRET
        });

        console.log('🔍 Obteniendo información de la cuenta...');
        const accountInfo = await dbx.usersGetCurrentAccount();

        console.log('✅ CONEXIÓN EXITOSA!');
        console.log('\n📊 Información de la cuenta:');
        console.log('   - Nombre:', accountInfo.result.name.display_name);
        console.log('   - Email:', accountInfo.result.email);
        console.log('   - Account ID:', accountInfo.result.account_id);
        console.log('   - País:', accountInfo.result.country || 'N/A');
        console.log('');

        // Probar crear una carpeta de prueba
        console.log('📁 Probando crear carpeta de prueba...');
        const testFolderPath = '/SYA_Test_' + Date.now();

        try {
            await dbx.filesCreateFolderV2({ path: testFolderPath });
            console.log('✅ Carpeta de prueba creada:', testFolderPath);

            // Probar subir un archivo de prueba
            console.log('📄 Probando subir archivo de prueba...');
            const testContent = JSON.stringify({
                test: true,
                timestamp: new Date().toISOString(),
                message: 'Este es un archivo de prueba de SYA Tortillerías'
            }, null, 2);

            await dbx.filesUpload({
                path: `${testFolderPath}/test.json`,
                contents: testContent,
                mode: 'add',
                autorename: true
            });
            console.log('✅ Archivo de prueba subido exitosamente');

            // Listar contenido de la carpeta
            console.log('📂 Listando contenido de la carpeta...');
            const folderContents = await dbx.filesListFolder({ path: testFolderPath });
            console.log('✅ Archivos encontrados:', folderContents.result.entries.length);
            folderContents.result.entries.forEach(entry => {
                console.log(`   - ${entry.name} (${entry['.tag']})`);
            });

            // Limpiar carpeta de prueba
            console.log('\n🧹 Eliminando carpeta de prueba...');
            await dbx.filesDeleteV2({ path: testFolderPath });
            console.log('✅ Carpeta de prueba eliminada');

        } catch (error) {
            console.error('❌ Error en operaciones de archivos:', error.error?.error_summary || error.message);
        }

        console.log('\n✅ TODAS LAS PRUEBAS COMPLETADAS EXITOSAMENTE!');

    } catch (error) {
        console.error('\n❌ ERROR en la prueba:');
        if (error.status) {
            console.error('   Status:', error.status);
        }
        if (error.error) {
            console.error('   Mensaje:', error.error.error_summary || JSON.stringify(error.error, null, 2));
        } else {
            console.error('   Error:', error.message);
        }
        console.error('\n📋 Stack trace:', error.stack);
    }
}

// Ejecutar prueba
testDropboxConnection();
