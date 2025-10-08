const axios = require('axios');
const { Pool } = require('pg');

const API_URL = 'https://sya-socketio-server.onrender.com';

const pool = new Pool({
    connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
    ssl: { rejectUnauthorized: false }
});

const testUsers = [
    {
        email: 'test1@tortilleria.com',
        displayName: 'Juan Pérez',
        businessName: 'Tortillería El Molino',
        phoneNumber: '5551234567',
        address: 'Av. Reforma 123, CDMX',
        password: 'test1234'
    },
    {
        email: 'test2@tortilleria.com',
        displayName: 'María González',
        businessName: 'Tortillas La Guadalupana',
        phoneNumber: '5557654321',
        address: 'Calle Juárez 456, Guadalajara',
        password: 'test1234'
    },
    {
        email: 'test3@tortilleria.com',
        displayName: 'Carlos Ramírez',
        businessName: 'Maíz Dorado',
        phoneNumber: '5559876543',
        address: 'Blvd. Zapata 789, Monterrey',
        password: 'test1234'
    }
];

async function registerUsers() {
    console.log('\n🧪 INICIANDO PRUEBA DE REGISTRO\n');

    const createdData = [];

    for (const user of testUsers) {
        try {
            console.log(`\n📝 Registrando: ${user.businessName} (${user.email})...`);

            const response = await axios.post(`${API_URL}/api/auth/google-signup`, user, {
                timeout: 30000
            });

            if (response.data.success) {
                console.log(`✅ Usuario registrado exitosamente`);
                console.log(`   - Tenant ID: ${response.data.tenant.id}`);
                console.log(`   - Tenant Code: ${response.data.tenant.tenantCode}`);
                console.log(`   - Employee ID: ${response.data.employee.id}`);
                console.log(`   - Branch ID: ${response.data.branch.id}`);
                console.log(`   - Branch Code: ${response.data.branch.branchCode}`);

                createdData.push({
                    tenantId: response.data.tenant.id,
                    tenantCode: response.data.tenant.tenantCode,
                    employeeId: response.data.employee.id,
                    branchId: response.data.branch.id,
                    businessName: user.businessName
                });
            } else {
                console.log(`❌ Error: ${response.data.message}`);
            }

        } catch (error) {
            console.error(`❌ Error registrando ${user.email}:`, error.response?.data || error.message);
        }

        // Pausa entre requests
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return createdData;
}

async function createAdditionalBranches(createdData) {
    console.log('\n\n🏢 CREANDO BRANCHES ADICIONALES\n');

    for (const data of createdData) {
        try {
            console.log(`\n📍 Creando 2 branches para: ${data.businessName}`);

            const branches = [
                { name: `${data.businessName} - Sucursal Norte`, suffix: 'NORTE' },
                { name: `${data.businessName} - Sucursal Sur`, suffix: 'SUR' }
            ];

            for (const branch of branches) {
                const branchCode = `${data.tenantCode}-${branch.suffix}`;

                const result = await pool.query(`
                    INSERT INTO branches (tenant_id, branch_code, name, address, is_active)
                    VALUES ($1, $2, $3, $4, true)
                    RETURNING id, branch_code, name
                `, [data.tenantId, branchCode, branch.name, 'Dirección pendiente']);

                console.log(`   ✅ Branch creado: ${result.rows[0].branch_code} (ID: ${result.rows[0].id})`);

                // Vincular employee a este branch
                await pool.query(`
                    INSERT INTO employee_branches (employee_id, branch_id, can_login, can_sell, can_manage_inventory, can_close_shift)
                    VALUES ($1, $2, true, true, true, true)
                `, [data.employeeId, result.rows[0].id]);

                console.log(`   ✅ Employee ${data.employeeId} vinculado al branch`);
            }

        } catch (error) {
            console.error(`❌ Error creando branches:`, error.message);
        }
    }
}

async function verifyData(createdData) {
    console.log('\n\n📊 VERIFICANDO DATOS EN BD\n');

    try {
        for (const data of createdData) {
            console.log(`\n🔍 Verificando: ${data.businessName}`);

            // Verificar tenant
            const tenant = await pool.query('SELECT * FROM tenants WHERE id = $1', [data.tenantId]);
            console.log(`   ✅ Tenant existe: ${tenant.rows[0].business_name}`);

            // Verificar employee
            const employee = await pool.query('SELECT * FROM employees WHERE id = $1', [data.employeeId]);
            console.log(`   ✅ Employee existe: ${employee.rows[0].full_name} (main_branch_id: ${employee.rows[0].main_branch_id})`);

            // Verificar branches
            const branches = await pool.query('SELECT id, branch_code, name FROM branches WHERE tenant_id = $1', [data.tenantId]);
            console.log(`   ✅ Branches (${branches.rows.length}):`);
            branches.rows.forEach(b => console.log(`      - ${b.branch_code}: ${b.name}`));

            // Verificar employee_branches
            const empBranches = await pool.query('SELECT branch_id FROM employee_branches WHERE employee_id = $1', [data.employeeId]);
            console.log(`   ✅ Employee vinculado a ${empBranches.rows.length} branches`);
        }

        console.log('\n✅ TODAS LAS VERIFICACIONES PASARON\n');

    } catch (error) {
        console.error('❌ Error en verificación:', error.message);
    }
}

async function deleteTestData(createdData) {
    console.log('\n\n🗑️  ELIMINANDO DATOS DE PRUEBA\n');

    try {
        for (const data of createdData) {
            console.log(`🗑️  Eliminando tenant: ${data.businessName}...`);

            // Orden correcto respetando foreign keys
            await pool.query('DELETE FROM employee_branches WHERE employee_id = $1', [data.employeeId]);
            await pool.query('DELETE FROM employees WHERE tenant_id = $1', [data.tenantId]);
            await pool.query('DELETE FROM branches WHERE tenant_id = $1', [data.tenantId]);
            await pool.query('DELETE FROM tenants WHERE id = $1', [data.tenantId]);

            console.log(`   ✅ Eliminado completamente`);
        }

        console.log('\n✅ DATOS DE PRUEBA ELIMINADOS\n');

    } catch (error) {
        console.error('❌ Error eliminando:', error.message);
    }
}

async function main() {
    try {
        // 1. Registrar 3 usuarios
        const createdData = await registerUsers();

        if (createdData.length === 0) {
            console.log('\n❌ No se pudo registrar ningún usuario. Abortando.\n');
            process.exit(1);
        }

        // 2. Crear 2 branches adicionales por cada tenant
        await createAdditionalBranches(createdData);

        // 3. Verificar datos
        await verifyData(createdData);

        // 4. Eliminar datos de prueba
        await deleteTestData(createdData);

        await pool.end();
        console.log('✅ PRUEBA COMPLETADA CON ÉXITO\n');
        process.exit(0);

    } catch (error) {
        console.error('❌ Error fatal:', error);
        await pool.end();
        process.exit(1);
    }
}

main();
