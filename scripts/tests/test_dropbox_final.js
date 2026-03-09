// ═══════════════════════════════════════════════════════════════
// TEST FINAL: Conexión con Dropbox API con token refrescado
// ═══════════════════════════════════════════════════════════════

// Limpiar cache de require para forzar recarga de .env
delete require.cache[require.resolve('dotenv')];
delete require.cache[require.resolve('dotenv/config')];

require('dotenv').config();
const { Dropbox } = require('dropbox');
const fetch = require('node-fetch');

async function testDropboxFinal() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🧪 PRUEBA FINAL: Dropbox API                          ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        const token = process.env.DROPBOX_ACCESS_TOKEN;

        if (!token) {
            console.error('❌ ERROR: DROPBOX_ACCESS_TOKEN no está configurado');
            return;
        }

        console.log('📝 Token encontrado:', token.substring(0, 30) + '...');
        console.log('📏 Longitud del token:', token.length);
        console.log('');

        // Crear instancia de Dropbox
        const dbx = new Dropbox({
            accessToken: token,
            fetch: fetch
        });

        // Test 1: Obtener información de la cuenta
        console.log('🔍 Test 1: Obteniendo información de la cuenta...');
        const accountInfo = await dbx.usersGetCurrentAccount();
        console.log('✅ ÉXITO!');
        console.log(`   - Nombre: ${accountInfo.result.name.display_name}`);
        console.log(`   - Email: ${accountInfo.result.email}`);
        console.log(`   - Account ID: ${accountInfo.result.account_id}`);
        console.log('');

        // Test 2: Crear una carpeta de prueba
        console.log('🔍 Test 2: Creando carpeta de prueba...');
        const testFolderPath = '/SYA_Test_' + Date.now();
        await dbx.filesCreateFolderV2({ path: testFolderPath });
        console.log('✅ Carpeta creada:', testFolderPath);
        console.log('');

        // Test 3: Subir un archivo de prueba
        console.log('🔍 Test 3: Subiendo archivo de prueba...');
        const testContent = JSON.stringify({
            test: true,
            timestamp: new Date().toISOString(),
            message: 'Test desde SYA Tortillerías'
        }, null, 2);

        await dbx.filesUpload({
            path: `${testFolderPath}/test.json`,
            contents: testContent,
            mode: 'add',
            autorename: true
        });
        console.log('✅ Archivo subido exitosamente');
        console.log('');

        // Test 4: Listar contenido de la carpeta
        console.log('🔍 Test 4: Listando contenido de la carpeta...');
        const folderContents = await dbx.filesListFolder({ path: testFolderPath });
        console.log('✅ Archivos encontrados:', folderContents.result.entries.length);
        folderContents.result.entries.forEach(entry => {
            console.log(`   - ${entry.name} (${entry['.tag']})`);
        });
        console.log('');

        // Test 5: Crear estructura de carpetas para backups
        console.log('🔍 Test 5: Creando estructura para backups...');
        const backupPath = '/SYA Backups/test_tenant_123/test_branch_456';

        // Crear carpetas recursivamente
        const pathParts = backupPath.split('/').filter(p => p);
        let currentPath = '';
        for (const part of pathParts) {
            currentPath += '/' + part;
            try {
                await dbx.filesCreateFolderV2({ path: currentPath });
                console.log(`   ✅ Creada: ${currentPath}`);
            } catch (error) {
                if (error.error?.error['.tag'] === 'path' && error.error?.error.path['.tag'] === 'conflict') {
                    console.log(`   ⚠️  Ya existe: ${currentPath}`);
                } else {
                    throw error;
                }
            }
        }
        console.log('');

        // Test 6: Subir un archivo de backup simulado
        console.log('🔍 Test 6: Simulando backup...');
        const backupContent = {
            metadata: {
                tenant_id: 123,
                branch_id: 456,
                timestamp: new Date().toISOString(),
                type: 'test'
            },
            data: {
                sales: [],
                expenses: [],
                employees: []
            }
        };

        await dbx.filesUpload({
            path: `${backupPath}/backup_test_${Date.now()}.json`,
            contents: JSON.stringify(backupContent, null, 2),
            mode: { '.tag': 'overwrite' },
            autorename: false
        });
        console.log('✅ Backup de prueba subido exitosamente');
        console.log('');

        // Limpiar: eliminar carpeta de prueba
        console.log('🧹 Limpiando archivos de prueba...');
        await dbx.filesDeleteV2({ path: testFolderPath });
        console.log('✅ Carpeta de prueba eliminada');
        console.log('');

        console.log('═══════════════════════════════════════════════════════════');
        console.log('🎉 TODAS LAS PRUEBAS COMPLETADAS EXITOSAMENTE!');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('✅ Dropbox está listo para usarse en el sistema');
        console.log('✅ El token de acceso es válido');
        console.log('✅ La estructura de carpetas de backup funciona correctamente');
        console.log('');
        console.log('⚠️  PRÓXIMO PASO: Actualizar token en Render');
        console.log('   1. Ir a https://dashboard.render.com');
        console.log('   2. Seleccionar el servicio sya-socketio-server');
        console.log('   3. Environment → Variables');
        console.log('   4. Actualizar DROPBOX_ACCESS_TOKEN');
        console.log('');

    } catch (error) {
        console.error('\n❌ ERROR en la prueba:');
        if (error.status) {
            console.error('   Status:', error.status);
        }
        if (error.error) {
            console.error('   Detalles:', error.error.error_summary || JSON.stringify(error.error, null, 2));
        } else {
            console.error('   Error:', error.message);
        }
        console.error('\n📋 Stack trace:', error.stack);
    }
}

// Ejecutar
testDropboxFinal();
