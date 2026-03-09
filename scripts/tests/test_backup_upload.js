// Script para probar el endpoint /api/backup/upload-desktop

const API_URL = 'https://sya-socketio-server.onrender.com/api/backup/upload-desktop';

// Crear un backup de prueba muy pequeño (solo 1KB en Base64)
const testBackupContent = 'UEsDBBQAAAAIAEaQYVkAAAAAAAAAAAAAAAAJAAAAdGVzdC50eHQKiJ0BZw=='; // ZIP vacío

const payload = {
    tenant_id: 24,
    branch_id: 45,
    employee_id: 1,
    backup_filename: 'TEST_Backup_20251013_190000.zip',
    backup_base64: testBackupContent,
    device_name: 'TestDevice',
    device_id: 'test-device-001'
};

async function testUpload() {
    try {
        console.log('[Test] Enviando petición a:', API_URL);
        console.log('[Test] Payload:', JSON.stringify({...payload, backup_base64: '... (base64 content) ...'}));

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const responseText = await response.text();

        console.log('[Test] Status:', response.status, response.statusText);
        console.log('[Test] Response Body:', responseText);

        if (response.ok) {
            const data = JSON.parse(responseText);
            console.log('[Test] ✅ SUCCESS! Backup ID:', data.data?.backup_id);
        } else {
            console.log('[Test] ❌ FAILED');
        }
    } catch (error) {
        console.error('[Test] ❌ Error:', error.message);
    }
}

testUpload();
