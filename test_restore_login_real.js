// ═══════════════════════════════════════════════════════════════
// TEST: Login real en /api/restore/login con credenciales válidas
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const { pool } = require('./database');

const API_URL = 'https://sya-socketio-server.onrender.com';

async function testRestoreLogin() {
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║   🧪 TEST: /api/restore/login con usuario real         ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        // Primero, buscar un empleado real en la base de datos
        console.log('🔍 Buscando empleado en la base de datos...');

        const employeeResult = await pool.query(`
            SELECT
                e.id,
                e.email,
                e.full_name,
                e.tenant_id,
                e.main_branch_id,
                t.business_name
            FROM employees e
            INNER JOIN tenants t ON e.tenant_id = t.id
            WHERE e.is_active = true
            LIMIT 1
        `);

        if (employeeResult.rows.length === 0) {
            console.log('❌ No se encontró ningún empleado activo en la BD');
            return;
        }

        const employee = employeeResult.rows[0];

        console.log('✅ Empleado encontrado:');
        console.log(`   - ID: ${employee.id}`);
        console.log(`   - Email: ${employee.email}`);
        console.log(`   - Nombre: ${employee.full_name}`);
        console.log(`   - Tenant ID: ${employee.tenant_id}`);
        console.log(`   - Main Branch ID: ${employee.main_branch_id}`);
        console.log(`   - Negocio: ${employee.business_name}`);
        console.log('');

        // Verificar si tiene main_branch_id
        if (!employee.main_branch_id) {
            console.log('⚠️  ADVERTENCIA: Este empleado NO tiene main_branch_id asignado');
            console.log('   Este es el problema que debería arreglar el fix.');
            console.log('');
        }

        // Probar el endpoint con contraseña de prueba "1234"
        console.log('🔍 Probando endpoint /api/restore/login...');
        console.log(`   URL: ${API_URL}/api/restore/login`);
        console.log(`   Email: ${employee.email}`);
        console.log(`   Password: 1234 (contraseña de prueba común)`);
        console.log('');

        const loginResponse = await axios.post(
            `${API_URL}/api/restore/login`,
            {
                email: employee.email,
                password: '1234' // Contraseña común de prueba
            },
            {
                timeout: 10000,
                validateStatus: () => true // Aceptar cualquier status
            }
        );

        console.log('📊 RESPUESTA DEL SERVIDOR:');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`Status Code: ${loginResponse.status}`);
        console.log('');
        console.log('Headers:');
        console.log(JSON.stringify(loginResponse.headers, null, 2));
        console.log('');
        console.log('Body (estructura completa):');
        console.log(JSON.stringify(loginResponse.data, null, 2));
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');

        // Analizar la estructura de la respuesta
        if (loginResponse.status === 200 && loginResponse.data.success) {
            console.log('✅ LOGIN EXITOSO!');
            console.log('');
            console.log('📋 Analizando estructura de datos:');

            const data = loginResponse.data.data;

            if (data) {
                console.log('   ✅ data existe');

                if (data.employee) {
                    console.log('   ✅ data.employee existe');
                    console.log(`      - id: ${data.employee.id}`);
                    console.log(`      - tenant_id: ${data.employee.tenant_id}`);
                    console.log(`      - branch_id: ${data.employee.branch_id} ${data.employee.branch_id === null ? '❌ NULL!' : '✅'}`);
                    console.log(`      - email: ${data.employee.email}`);
                    console.log(`      - full_name: ${data.employee.full_name}`);
                } else {
                    console.log('   ❌ data.employee NO EXISTE');
                }

                if (data.tokens) {
                    console.log('   ✅ data.tokens existe');
                    console.log(`      - access_token: ${data.tokens.access_token ? 'presente' : 'ausente'}`);
                    console.log(`      - refresh_token: ${data.tokens.refresh_token ? 'presente' : 'ausente'}`);
                } else {
                    console.log('   ❌ data.tokens NO EXISTE');
                }
            } else {
                console.log('   ❌ data NO EXISTE en la respuesta');
            }

        } else if (loginResponse.status === 401) {
            console.log('⚠️  Credenciales incorrectas (401)');
            console.log('   Intenta con otro usuario o usa la contraseña correcta');
        } else {
            console.log(`⚠️  Status inesperado: ${loginResponse.status}`);
            console.log(`   Mensaje: ${loginResponse.data.message || 'Sin mensaje'}`);
        }

        console.log('');

    } catch (error) {
        console.error('\n❌ ERROR:');
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('   Error:', error.message);
        }
        console.error('\n📋 Stack:', error.stack);
    } finally {
        await pool.end();
    }
}

// Ejecutar test
testRestoreLogin();
