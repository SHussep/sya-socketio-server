// Script para probar el snapshot del tenant 7
const https = require('https');

async function testSnapshot() {
    try {
        console.log('\n=== PROBANDO SNAPSHOT PARA TENANT 7 ===\n');

        // 1. Login para obtener token
        console.log('1. Haciendo login...');

        const loginData = JSON.stringify({
            email: 'saul.hussep@gmail.com',
            password: 'Tu contraseña aquí' // Necesitas poner la contraseña real
        });

        const loginOptions = {
            hostname: 'sya-socketio-server.onrender.com',
            path: '/api/restore/login',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': loginData.length
            }
        };

        const loginResponse = await new Promise((resolve, reject) => {
            const req = https.request(loginOptions, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.write(loginData);
            req.end();
        });

        if (loginResponse.status !== 200) {
            console.error('❌ Error en login:', loginResponse.data);
            return;
        }

        console.log('✅ Login exitoso');
        const token = loginResponse.data.data.tokens.access_token;
        console.log(`   Token: ${token.substring(0, 20)}...`);

        // 2. Obtener snapshot
        console.log('\n2. Obteniendo snapshot...');

        const snapshotOptions = {
            hostname: 'sya-socketio-server.onrender.com',
            path: '/api/restore/database-snapshot',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        };

        const snapshotResponse = await new Promise((resolve, reject) => {
            const req = https.request(snapshotOptions, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });

        if (snapshotResponse.status !== 200) {
            console.error('❌ Error obteniendo snapshot:', snapshotResponse.data);
            return;
        }

        console.log('✅ Snapshot obtenido\n');

        const snapshot = snapshotResponse.data.data;

        console.log('=== CONTENIDO DEL SNAPSHOT ===');
        console.log('\nMetadata:');
        console.log(`  Tenant ID: ${snapshot.metadata.tenant_id}`);
        console.log(`  Branch ID: ${snapshot.metadata.branch_id}`);
        console.log(`  Branch Name: ${snapshot.metadata.branch_name}`);
        console.log(`  Generated: ${snapshot.metadata.generated_at}`);
        console.log('\nRecord Counts:');
        console.log(`  Sales: ${snapshot.metadata.record_counts.sales}`);
        console.log(`  Expenses: ${snapshot.metadata.record_counts.expenses}`);
        console.log(`  Cash Cuts: ${snapshot.metadata.record_counts.cash_cuts}`);
        console.log(`  Guardian Events: ${snapshot.metadata.record_counts.guardian_events}`);
        console.log(`  Employees: ${snapshot.metadata.record_counts.employees}`);

        console.log('\nEmployees en snapshot:');
        if (snapshot.data.employees.length === 0) {
            console.log('  ❌ NO HAY EMPLEADOS EN EL SNAPSHOT');
        } else {
            snapshot.data.employees.forEach(emp => {
                console.log(`  - ${emp.full_name} (${emp.email})`);
                console.log(`    ID: ${emp.id} | Username: ${emp.username} | Role: ${emp.role}`);
            });
        }

        console.log('\n');

    } catch (error) {
        console.error('Error:', error);
    }
}

testSnapshot();
