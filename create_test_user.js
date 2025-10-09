const axios = require('axios');

const API_URL = 'https://sya-socketio-server.onrender.com';

async function createTestUser() {
    console.log('\n🧪 CREANDO USUARIO DE PRUEBA...\n');

    try {
        const testUser = {
            email: `test_${Date.now()}@tortilleria.com`,
            displayName: 'Usuario de Prueba',
            businessName: 'Tortillería de Pruebas',
            phoneNumber: '5551234567',
            address: 'Calle de Prueba 123',
            password: 'TestPassword123'
        };

        console.log('Datos del usuario:');
        console.log(JSON.stringify(testUser, null, 2));

        const response = await axios.post(
            `${API_URL}/api/auth/google-signup`,
            testUser,
            { timeout: 30000 }
        );

        if (response.data.success) {
            console.log('\n✅ Usuario creado exitosamente\n');
            console.log('═══════════════════════════════════════════');
            console.log('📋 CREDENCIALES PARA TESTING:');
            console.log('═══════════════════════════════════════════');
            console.log(`Tenant Code: ${response.data.tenant.tenantCode}`);
            console.log(`Username: ${response.data.employee.username || 'N/A'}`);
            console.log(`Email: ${response.data.employee.email}`);
            console.log(`Password: TestPassword123`);
            console.log(`\nTenant ID: ${response.data.tenant.id}`);
            console.log(`Employee ID: ${response.data.employee.id}`);
            console.log(`Branch ID: ${response.data.branch.id}`);
            console.log(`Branch Code: ${response.data.branch.branchCode}`);
            console.log('═══════════════════════════════════════════\n');

            const fs = require('fs');
            fs.writeFileSync(
                'test_credentials.json',
                JSON.stringify({
                    tenantCode: response.data.tenant.tenantCode,
                    username: response.data.employee.username,
                    email: response.data.employee.email,
                    password: 'TestPassword123',
                    tenantId: response.data.tenant.id,
                    employeeId: response.data.employee.id,
                    branchId: response.data.branch.id
                }, null, 2)
            );

            console.log('✅ Credenciales guardadas en test_credentials.json\n');

        } else {
            console.log('❌ Error:', response.data.message);
        }

    } catch (error) {
        console.error('❌ Error creando usuario:', error.response?.data || error.message);
    }
}

createTestUser();
