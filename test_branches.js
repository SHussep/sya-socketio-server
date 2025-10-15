const axios = require('axios');

const API_URL = 'https://sya-socketio-server.onrender.com';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbXBsb3llZUlkIjo1LCJ0ZW5hbnRJZCI6NSwiYnJhbmNoSWQiOjUsInJvbGUiOiJvd25lciIsImVtYWlsIjoidGVzdDE3NjA1MjU1MjU1NjhAZXhhbXBsZS5jb20iLCJpYXQiOjE3NjA1MjU1MjYsImV4cCI6MTc2MTEzMDMyNn0._dJYhd2KhvID-_jTLPJzpYNBVDev3gDNk4KDR09LiV4';

async function testBranches() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🧪 PRUEBA: Listar Sucursales con Respaldos           ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        const response = await axios.get(`${API_URL}/api/auth/branches`, {
            headers: {
                'Authorization': `Bearer ${TOKEN}`
            }
        });

        console.log('📊 Status Code:', response.status);
        console.log('📊 Respuesta del servidor:');
        console.log(JSON.stringify(response.data, null, 2));

        if (response.data.success && response.data.branches.length > 0) {
            console.log('\n✅ SUCURSALES ENCONTRADAS!');
            response.data.branches.forEach((branch, index) => {
                console.log(`\n🏢 Sucursal ${index + 1}:`);
                console.log(`   - Nombre: ${branch.name}`);
                console.log(`   - Código: ${branch.branchCode}`);
                console.log(`   - Tiene backup: ${branch.hasBackup ? '✅ SÍ' : '❌ NO'}`);
                if (branch.backup) {
                    console.log(`   - Backup ID: ${branch.backup.id}`);
                    console.log(`   - Archivo: ${branch.backup.filename}`);
                    console.log(`   - Tamaño: ${branch.backup.sizeMB} MB`);
                    console.log(`   - Fecha: ${branch.backup.createdAt}`);
                }
            });
        }

    } catch (error) {
        console.error('\n❌ ERROR:', error.response?.data || error.message);
    }
}

testBranches();
