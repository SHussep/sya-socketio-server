#!/usr/bin/env node
/**
 * Script para ejecutar la migración 005_normalize_sales_schema.sql
 * Uso: node run_migration_005.js
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Obtener DATABASE_URL del .env o variable de entorno
require('dotenv').config();
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('❌ ERROR: DATABASE_URL no está configurada');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runMigration() {
    const client = await pool.connect();

    try {
        console.log('🔄 Ejecutando migración 005_normalize_sales_schema.sql...\n');

        // Leer el archivo SQL
        const sqlFile = path.join(__dirname, 'migrations', '005_normalize_sales_schema.sql');
        const sql = fs.readFileSync(sqlFile, 'utf8');

        // Ejecutar el script
        await client.query(sql);

        console.log('\n✅ Migración completada exitosamente!');
        console.log('\n📊 Verificando tablas creadas...\n');

        // Verificar payment_types
        const paymentTypes = await client.query('SELECT * FROM payment_types ORDER BY id');
        console.log('📋 Payment Types:');
        paymentTypes.rows.forEach(row => {
            console.log(`   ${row.id}. ${row.name} (${row.code})`);
        });

        // Verificar sale_types
        const saleTypes = await client.query('SELECT * FROM sale_types ORDER BY id');
        console.log('\n📋 Sale Types:');
        saleTypes.rows.forEach(row => {
            console.log(`   ${row.id}. ${row.name} (${row.code})`);
        });

        // Verificar sales_items table
        const salesItemsCheck = await client.query(
            "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='sales_items')"
        );
        console.log(`\n✅ Tabla sales_items existe: ${salesItemsCheck.rows[0].exists}`);

        // Verificar vistas
        const viewsCheck = await client.query(
            "SELECT table_name FROM information_schema.views WHERE table_schema='public' AND table_name LIKE 'sales%'"
        );
        console.log(`\n✅ Vistas creadas: ${viewsCheck.rows.map(v => v.table_name).join(', ')}`);

        console.log('\n✨ La BD está normalizada y lista para usar!\n');

    } catch (error) {
        console.error('\n❌ ERROR ejecutando migración:');
        console.error(error.message);
        console.error('\nDetalles completos:');
        console.error(error);
        process.exit(1);
    } finally {
        await client.end();
        await pool.end();
    }
}

// Ejecutar migración
runMigration();
