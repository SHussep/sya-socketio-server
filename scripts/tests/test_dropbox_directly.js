// Test directo de subida a Dropbox
require('dotenv').config();
const { Dropbox } = require('dropbox');
const fetch = require('node-fetch');

async function testDropboxUpload() {
    try {
        console.log('🧪 Probando conexión a Dropbox...\n');

        const dbx = new Dropbox({
            accessToken: process.env.DROPBOX_ACCESS_TOKEN,
            fetch: fetch
        });

        // Test 1: Listar archivos en la carpeta raíz
        console.log('📂 Test 1: Listando carpeta raíz...');
        const listResult = await dbx.filesListFolder({ path: '' });
        console.log(`✅ Carpeta raíz accesible. Archivos encontrados: ${listResult.result.entries.length}\n`);

        // Test 2: Crear carpeta de prueba
        console.log('📁 Test 2: Creando carpeta de prueba...');
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
        const testContent = Buffer.from('Hola desde SYA Backup System - ' + new Date().toISOString());
        const uploadResult = await dbx.filesUpload({
            path: '/SYA Backups/test_backup.txt',
            contents: testContent,
            mode: { '.tag': 'overwrite' }
        });
        console.log(`✅ Archivo subido: ${uploadResult.result.path_display}`);
        console.log(`   Tamaño: ${uploadResult.result.size} bytes\n`);

        console.log('═══════════════════════════════════════════════════════════');
        console.log('✅ TODOS LOS TESTS PASARON - DROPBOX FUNCIONA CORRECTAMENTE');
        console.log('═══════════════════════════════════════════════════════════\n');

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.error) {
            console.error('Detalles:', JSON.stringify(error.error, null, 2));
        }
        process.exit(1);
    }
}

testDropboxUpload();
