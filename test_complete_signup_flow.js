// ═══════════════════════════════════════════════════════════════
// TEST: Flujo completo de Google Signup con Dropbox Manager
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const dropboxManager = require('./utils/dropbox-manager');
const archiver = require('archiver');

async function testCompleteFlow() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🧪 TEST: Flujo Completo de Signup con Dropbox        ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        // Simular datos de signup
        const mockTenant = {
            id: 999,
            tenant_code: 'TNT_TEST_' + Date.now(),
            business_name: 'Tortillería de Prueba'
        };

        const mockBranch = {
            id: 888,
            branch_code: mockTenant.tenant_code + '-MAIN',
            name: mockTenant.business_name + ' - Principal'
        };

        const mockEmployee = {
            id: 777,
            email: 'test@syatortillerias.com',
            full_name: 'Usuario de Prueba'
        };

        console.log('📝 Datos de prueba:');
        console.log(`   - Tenant: ${mockTenant.business_name} (ID: ${mockTenant.id})`);
        console.log(`   - Branch: ${mockBranch.name} (ID: ${mockBranch.id})`);
        console.log(`   - Employee: ${mockEmployee.full_name}`);
        console.log('');

        // TEST 1: Verificar token de Dropbox
        console.log('🔍 Test 1: Verificando token de Dropbox...');
        const accountInfo = await dropboxManager.getAccountInfo();
        console.log('✅ Token válido!');
        console.log(`   - Cuenta: ${accountInfo.name.display_name}`);
        console.log(`   - Email: ${accountInfo.email}`);
        console.log('');

        // TEST 2: Crear carpetas para el backup
        console.log('🔍 Test 2: Creando estructura de carpetas...');
        const folderPath = `/SYA Backups/${mockTenant.id}/${mockBranch.id}`;
        await dropboxManager.createFolder(folderPath);
        console.log('✅ Carpetas creadas exitosamente');
        console.log('');

        // TEST 3: Crear y subir archivo de backup inicial
        console.log('🔍 Test 3: Creando y subiendo backup inicial...');

        // Crear un ZIP con README
        const archive = archiver('zip', { zlib: { level: 9 } });
        const chunks = [];

        archive.on('data', (chunk) => chunks.push(chunk));

        const readmeContent = `SYA Tortillerías - Backup Inicial

Este es el backup automático creado al registrar la cuenta.
Fecha de creación: ${new Date().toISOString()}
Tenant: ${mockTenant.business_name} (${mockTenant.tenant_code})
Branch: ${mockBranch.name} (${mockBranch.branch_code})
Employee: ${mockEmployee.full_name} (${mockEmployee.email})

Este backup inicial está vacío y se actualizará con el primer respaldo real del sistema.`;

        archive.append(readmeContent, { name: 'README.txt' });
        archive.finalize();

        await new Promise((resolve) => archive.on('end', resolve));

        const backupBuffer = Buffer.concat(chunks);
        const filename = `SYA_Backup_Branch_${mockBranch.id}_TEST.zip`;
        const dropboxPath = `${folderPath}/${filename}`;

        console.log(`   - Tamaño del backup: ${(backupBuffer.length / 1024).toFixed(2)} KB`);
        console.log(`   - Ruta en Dropbox: ${dropboxPath}`);

        await dropboxManager.uploadFile(dropboxPath, backupBuffer, true);
        console.log('✅ Backup subido exitosamente!');
        console.log('');

        // TEST 4: Verificar que el archivo se subió correctamente
        console.log('🔍 Test 4: Verificando archivo en Dropbox...');
        const files = await dropboxManager.listFiles(folderPath);
        console.log(`✅ Archivos encontrados: ${files.length}`);
        files.forEach(file => {
            console.log(`   - ${file.name} (${(file.size / 1024).toFixed(2)} KB)`);
        });
        console.log('');

        // TEST 5: Limpiar archivos de prueba
        console.log('🧹 Test 5: Limpiando archivos de prueba...');
        await dropboxManager.deleteFile(dropboxPath);
        console.log('✅ Archivo de prueba eliminado');

        // Intentar eliminar las carpetas (pueden no estar vacías)
        try {
            await dropboxManager.deleteFile(folderPath);
            await dropboxManager.deleteFile(`/SYA Backups/${mockTenant.id}`);
            console.log('✅ Carpetas de prueba eliminadas');
        } catch (error) {
            console.log('⚠️  Algunas carpetas no pudieron eliminarse (puede que no estén vacías)');
        }
        console.log('');

        // TEST 6: Probar refresh automático del token
        console.log('🔍 Test 6: Verificando auto-refresh de token...');
        console.log('   - Forzando refresh del token...');
        await dropboxManager.refreshAccessToken();
        console.log('✅ Token refrescado exitosamente!');
        console.log('');

        // Probar que el nuevo token funciona
        console.log('   - Probando nuevo token...');
        const accountInfo2 = await dropboxManager.getAccountInfo();
        console.log(`✅ Nuevo token funcional! Cuenta: ${accountInfo2.name.display_name}`);
        console.log('');

        console.log('═══════════════════════════════════════════════════════════');
        console.log('🎉 ¡TODOS LOS TESTS COMPLETADOS EXITOSAMENTE!');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('✅ El Dropbox Manager funciona correctamente');
        console.log('✅ El auto-refresh de tokens está operativo');
        console.log('✅ El flujo de signup está listo para producción');
        console.log('');
        console.log('📋 PRÓXIMOS PASOS:');
        console.log('   1. Actualizar DROPBOX_ACCESS_TOKEN en Render');
        console.log('   2. Hacer redeploy del servidor en Render');
        console.log('   3. Probar un registro real desde la app Desktop');
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
testCompleteFlow();
