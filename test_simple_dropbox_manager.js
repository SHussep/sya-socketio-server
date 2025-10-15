// ═══════════════════════════════════════════════════════════════
// TEST: Dropbox Manager sin dependencias adicionales
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const dropboxManager = require('./utils/dropbox-manager');

async function testDropboxManager() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🧪 TEST: Dropbox Manager                              ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        // TEST 1: Verificar token y auto-refresh
        console.log('🔍 Test 1: Verificando token de Dropbox...');
        const accountInfo = await dropboxManager.getAccountInfo();
        console.log('✅ Token válido!');
        console.log(`   - Cuenta: ${accountInfo.name.display_name}`);
        console.log(`   - Email: ${accountInfo.email}`);
        console.log('');

        // TEST 2: Crear carpetas
        console.log('🔍 Test 2: Creando estructura de carpetas...');
        const testTenantId = 999;
        const testBranchId = 888;
        const folderPath = `/SYA Backups/${testTenantId}/${testBranchId}`;
        await dropboxManager.createFolder(folderPath);
        console.log('✅ Carpetas creadas/verificadas exitosamente');
        console.log('');

        // TEST 3: Subir archivo simple
        console.log('🔍 Test 3: Subiendo archivo de prueba...');
        const testContent = JSON.stringify({
            test: true,
            timestamp: new Date().toISOString(),
            message: 'Test desde Dropbox Manager',
            tenant_id: testTenantId,
            branch_id: testBranchId
        }, null, 2);

        const filename = `test_backup_${Date.now()}.json`;
        const filePath = `${folderPath}/${filename}`;

        await dropboxManager.uploadFile(filePath, testContent, true);
        console.log('✅ Archivo subido exitosamente!');
        console.log(`   - Ruta: ${filePath}`);
        console.log(`   - Tamaño: ${(testContent.length / 1024).toFixed(2)} KB`);
        console.log('');

        // TEST 4: Listar archivos
        console.log('🔍 Test 4: Listando archivos en la carpeta...');
        const files = await dropboxManager.listFiles(folderPath);
        console.log(`✅ Archivos encontrados: ${files.length}`);
        files.forEach(file => {
            console.log(`   - ${file.name} (${(file.size / 1024).toFixed(2)} KB)`);
        });
        console.log('');

        // TEST 5: Eliminar archivo de prueba
        console.log('🧹 Test 5: Eliminando archivo de prueba...');
        await dropboxManager.deleteFile(filePath);
        console.log('✅ Archivo eliminado');
        console.log('');

        // TEST 6: Verificar auto-refresh
        console.log('🔍 Test 6: Probando auto-refresh del token...');
        console.log('   - Forzando refresh...');
        const newToken = await dropboxManager.refreshAccessToken();
        console.log('✅ Token refrescado!');
        console.log(`   - Nuevo token: ${newToken.substring(0, 30)}...`);
        console.log('');

        // Verificar que el nuevo token funciona
        console.log('   - Probando nuevo token...');
        const accountInfo2 = await dropboxManager.getAccountInfo();
        console.log(`✅ Nuevo token funcional! Cuenta: ${accountInfo2.name.display_name}`);
        console.log('');

        // TEST 7: Limpiar carpetas de prueba
        console.log('🧹 Test 7: Limpiando carpetas de prueba...');
        try {
            await dropboxManager.deleteFile(folderPath);
            console.log('✅ Carpeta branch eliminada');
        } catch (error) {
            if (error.error?.error['.tag'] === 'path_lookup' &&
                error.error?.error.path_lookup['.tag'] === 'not_found') {
                console.log('⚠️  Carpeta ya estaba limpia');
            } else {
                throw error;
            }
        }

        try {
            await dropboxManager.deleteFile(`/SYA Backups/${testTenantId}`);
            console.log('✅ Carpeta tenant eliminada');
        } catch (error) {
            if (error.error?.error['.tag'] === 'path_lookup') {
                console.log('⚠️  Carpeta tenant no encontrada o no vacía');
            }
        }
        console.log('');

        console.log('═══════════════════════════════════════════════════════════');
        console.log('🎉 ¡TODOS LOS TESTS EXITOSOS!');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('✅ Dropbox Manager está funcionando correctamente');
        console.log('✅ Auto-refresh de tokens operativo');
        console.log('✅ Creación de carpetas funcional');
        console.log('✅ Subida de archivos funcional');
        console.log('✅ Listado y eliminación funcional');
        console.log('');
        console.log('📋 PRÓXIMOS PASOS:');
        console.log('   1. Actualizar DROPBOX_ACCESS_TOKEN en Render con este valor:');
        console.log('');
        console.log(newToken);
        console.log('');
        console.log('   2. Hacer redeploy del servidor en Render');
        console.log('   3. Probar registro real desde la app Desktop');
        console.log('');

    } catch (error) {
        console.error('\n❌ ERROR en el test:');
        if (error.status) {
            console.error('   Status:', error.status);
        }
        if (error.error) {
            console.error('   Detalles:', error.error.error_summary || JSON.stringify(error.error, null, 2));
        } else {
            console.error('   Mensaje:', error.message);
        }
        console.error('\n📋 Stack trace:', error.stack);
    }
}

// Ejecutar test
testDropboxManager();
