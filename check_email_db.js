// Script para verificar si un email existe en la base de datos
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkEmail(email) {
    try {
        console.log(`\n=== VERIFICANDO EMAIL EN BASE DE DATOS ===`);
        console.log(`Email a buscar: ${email}\n`);

        // Query exacta como en el código
        const result = await pool.query(
            'SELECT id, tenant_code, business_name, email FROM tenants WHERE LOWER(email) = LOWER($1)',
            [email]
        );

        console.log(`Resultados encontrados: ${result.rows.length}`);

        if (result.rows.length > 0) {
            console.log('\n✅ EMAIL ENCONTRADO:\n');
            result.rows.forEach((row, i) => {
                console.log(`Tenant ${i+1}:`);
                console.log(`  ID: ${row.id}`);
                console.log(`  Tenant Code: ${row.tenant_code}`);
                console.log(`  Business Name: ${row.business_name}`);
                console.log(`  Email: "${row.email}" (length: ${row.email.length})`);
                console.log('');
            });

            // Buscar branches
            const branchesResult = await pool.query(
                `SELECT id, branch_code, name, timezone
                 FROM branches
                 WHERE tenant_id = $1
                 ORDER BY created_at ASC`,
                [result.rows[0].id]
            );

            console.log(`Sucursales encontradas: ${branchesResult.rows.length}`);
            if (branchesResult.rows.length > 0) {
                console.log('\n📋 Sucursales:');
                branchesResult.rows.forEach((b, i) => {
                    console.log(`  ${i+1}. ${b.name} (${b.branch_code}) - ${b.timezone}`);
                });
            }
        } else {
            console.log('\n❌ EMAIL NO ENCONTRADO');
            console.log('\nListando TODOS los emails en la BD para comparar:\n');

            const allEmails = await pool.query('SELECT id, email, business_name FROM tenants ORDER BY created_at DESC LIMIT 10');
            allEmails.rows.forEach((row, i) => {
                console.log(`${i+1}. "${row.email}" - ${row.business_name}`);
            });
        }

        await pool.end();

    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
    }
}

// Email de prueba
const testEmail = process.argv[2] || 'saul.hussep@gmail.com';
checkEmail(testEmail);
