// ═══════════════════════════════════════════════════════════════
// TEST: Probar Dropbox con token leído directamente del archivo
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { Dropbox } = require('dropbox');
const fetch = require('node-fetch');

async function testWithDirectToken() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🧪 TEST: Dropbox con token directo                    ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        // Leer .env manualmente
        const envPath = path.join(__dirname, '.env');
        const envContent = fs.readFileSync(envPath, 'utf8');
        const tokenMatch = envContent.match(/DROPBOX_ACCESS_TOKEN=(.+?)(\n|$)/s);

        if (!tokenMatch) {
            console.error('❌ No se encontró DROPBOX_ACCESS_TOKEN en .env');
            return;
        }

        let token = tokenMatch[1].trim();

        // Remover comentarios o líneas adicionales que puedan estar incluidas
        token = token.split('\n')[0].trim();

        console.log('📝 Token encontrado');
        console.log('   - Primeros 30 caracteres:', token.substring(0, 30) + '...');
        console.log('   - Últimos 20 caracteres: ...' + token.substring(token.length - 20));
        console.log('   - Longitud:', token.length);
        console.log('');

        // Crear instancia de Dropbox
        const dbx = new Dropbox({
            accessToken: token,
            fetch: fetch
        });

        console.log('🔍 Test 1: Obteniendo información de la cuenta...');
        const accountInfo = await dbx.usersGetCurrentAccount();
        console.log('✅ ÉXITO!');
        console.log(`   - Nombre: ${accountInfo.result.name.display_name}`);
        console.log(`   - Email: ${accountInfo.result.email}`);
        console.log('');

        console.log('🔍 Test 2: Creando carpeta para backups de SYA...');
        const testPath = '/SYA Backups/test_' + Date.now();

        try {
            await dbx.filesCreateFolderV2({ path: '/SYA Backups' });
            console.log('   ✅ Carpeta /SYA Backups creada');
        } catch (error) {
            if (error.error?.error['.tag'] === 'path' && error.error?.error.path['.tag'] === 'conflict') {
                console.log('   ⚠️  Carpeta /SYA Backups ya existe');
            } else {
                throw error;
            }
        }

        await dbx.filesCreateFolderV2({ path: testPath });
        console.log('✅ Carpeta de prueba creada:', testPath);
        console.log('');

        console.log('🔍 Test 3: Subiendo archivo de backup simulado...');
        const backupData = {
            metadata: {
                timestamp: new Date().toISOString(),
                type: 'initial_backup',
                version: '1.0.0'
            },
            data: {
                message: 'Este es un backup de prueba de SYA Tortillerías'
            }
        };

        await dbx.filesUpload({
            path: `${testPath}/backup_test.json`,
            contents: JSON.stringify(backupData, null, 2),
            mode: 'add'
        });
        console.log('✅ Archivo de backup subido exitosamente');
        console.log('');

        console.log('🧹 Limpiando carpeta de prueba...');
        await dbx.filesDeleteV2({ path: testPath });
        console.log('✅ Limpieza completada');
        console.log('');

        console.log('═══════════════════════════════════════════════════════════');
        console.log('🎉 ¡TODAS LAS PRUEBAS EXITOSAS!');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
        console.log('✅ El token de Dropbox funciona correctamente');
        console.log('✅ Puedes crear carpetas y subir archivos');
        console.log('✅ El sistema está listo para hacer backups');
        console.log('');
        console.log('📋 PRÓXIMO PASO:');
        console.log('   Actualizar DROPBOX_ACCESS_TOKEN en Render con este valor:');
        console.log('');
        console.log(token);
        console.log('');

    } catch (error) {
        console.error('\n❌ ERROR:');
        if (error.status) {
            console.error('   Status:', error.status);
        }
        if (error.error) {
            console.error('   Detalles:', error.error.error_summary || JSON.stringify(error.error, null, 2));
        } else {
            console.error('   Mensaje:', error.message);
        }
        console.error('\n📋 Stack:', error.stack);
    }
}

testWithDirectToken();
