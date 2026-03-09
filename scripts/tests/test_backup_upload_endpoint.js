// Test del endpoint /api/backup/upload-desktop
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

async function testBackupUpload() {
    try {
        console.log('\n🧪 PROBANDO ENDPOINT DE BACKUP DESDE DESKTOP\n');
        console.log('═══════════════════════════════════════════════════════════\n');

        // Crear un archivo de prueba pequeño (simulando un backup)
        const testBackupContent = 'Este es un backup de prueba - ' + new Date().toISOString();
        const base64Content = Buffer.from(testBackupContent).toString('base64');

        const payload = {
            tenant_id: 22,
            branch_id: 30,
            employee_id: null,
            backup_filename: 'test_backup.zip',
            backup_base64: base64Content,
            device_name: 'PC-Test-Desktop',
            device_id: 'test-device-12345'
        };

        console.log('📤 Enviando petición a localhost:3000/api/backup/upload-desktop...');
        console.log(`   Tenant ID: ${payload.tenant_id}`);
        console.log(`   Branch ID: ${payload.branch_id}`);
        console.log(`   Device: ${payload.device_name}`);
        console.log(`   Tamaño: ${testBackupContent.length} bytes\n`);

        const response = await fetch('http://localhost:3000/api/backup/upload-desktop', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const responseText = await response.text();
        console.log(`📡 Respuesta del servidor: ${response.status} ${response.statusText}\n`);

        if (!response.ok) {
            console.error('❌ Error del servidor:');
            console.error(responseText);
            return;
        }

        const result = JSON.parse(responseText);

        if (result.success) {
            console.log('✅ BACKUP SUBIDO EXITOSAMENTE\n');
            console.log('Detalles:');
            console.log(`   Backup ID: ${result.data.backup_id}`);
            console.log(`   Ruta en Dropbox: ${result.data.dropbox_path}`);
            console.log(`   Tamaño: ${result.data.file_size_bytes} bytes`);
            console.log(`   Creado: ${result.data.created_at}`);
            console.log(`   Expira: ${result.data.expires_at}`);
            console.log(`\n   Mensaje: ${result.message}\n`);
            console.log('═══════════════════════════════════════════════════════════');
            console.log('✅ TEST EXITOSO - EL SISTEMA DE BACKUPS FUNCIONA CORRECTAMENTE');
            console.log('═══════════════════════════════════════════════════════════\n');
        } else {
            console.error('❌ Error:', result.message);
        }

    } catch (error) {
        console.error('❌ Error en el test:', error.message);
        if (error.code === 'ECONNREFUSED') {
            console.error('\n⚠️  El servidor no está corriendo en localhost:3000');
            console.error('   Ejecuta: node server.js\n');
        }
    }
}

testBackupUpload();
