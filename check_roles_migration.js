#!/usr/bin/env node

/**
 * Check if migration 037 was applied correctly
 * Connects using DATABASE_URL from environment
 */

const { Pool } = require('pg');

// Try to get DATABASE_URL from environment or show instructions
let connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('\n❌ ERROR: DATABASE_URL not set');
  console.error('\nTo verify roles table, set the DATABASE_URL environment variable:');
  console.error('   export DATABASE_URL="postgresql://user:password@host:5432/dbname"');
  console.error('\nOr pass it as an argument:');
  console.error('   DATABASE_URL="..." node check_roles_migration.js');
  process.exit(1);
}

const pool = new Pool({
  connectionString: connectionString,
  // Use SSL for Render
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function checkMigration() {
  try {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  VERIFICACIÓN: Migración 037 - Roles Globales');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // 1. Check table exists and structure
    const structureQuery = `
      SELECT
        column_name,
        data_type,
        is_nullable
      FROM information_schema.columns
      WHERE table_name = 'roles'
      ORDER BY ordinal_position
    `;

    const structure = await pool.query(structureQuery);

    if (structure.rows.length === 0) {
      console.error('❌ ERROR: Table "roles" not found!');
      console.error('   Migration may not have executed.');
      process.exit(1);
    }

    console.log('1️⃣  ESTRUCTURA DE LA TABLA "roles":');
    console.log('─────────────────────────────────────────────────────────────');
    structure.rows.forEach(row => {
      console.log(`   ${row.column_name.padEnd(20)} | ${row.data_type.padEnd(20)} | nullable: ${row.is_nullable}`);
    });

    // Check for problematic columns
    const columns = structure.rows.map(r => r.column_name);
    const issues = [];

    if (columns.includes('tenant_id')) {
      issues.push('   ❌ tenant_id column (should NOT exist in global roles table)');
    }
    if (columns.includes('branch_id')) {
      issues.push('   ❌ branch_id column (should NOT exist in global roles table)');
    }

    if (issues.length > 0) {
      console.log('\n⚠️  PROBLEMAS ENCONTRADOS:');
      issues.forEach(i => console.log(i));
      console.log('\n❌ La tabla tiene estructura incorrecta!');
    } else {
      console.log('\n✅ Estructura correcta: Sin tenant_id ni branch_id');
    }

    // 2. Check roles data
    const rolesQuery = `SELECT id, name, description FROM roles ORDER BY id`;
    const roles = await pool.query(rolesQuery);

    console.log('\n\n2️⃣  DATOS DE ROLES:');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`   Total de roles: ${roles.rows.length}\n`);

    if (roles.rows.length === 0) {
      console.log('   ❌ No hay roles en la tabla!');
      process.exit(1);
    }

    roles.rows.forEach(role => {
      console.log(`   ID ${role.id.toString().padEnd(2)} | ${role.name.padEnd(20)} | ${role.description || '(sin descripción)'}`);
    });

    // 3. Validate required roles
    const expectedRoles = {
      1: 'Administrador',
      2: 'Encargado',
      3: 'Repartidor',
      4: 'Ayudante',
      99: 'Otro'
    };

    console.log('\n\n3️⃣  VALIDACIÓN DE ROLES REQUERIDOS:');
    console.log('─────────────────────────────────────────────────────────────');

    let allValid = true;
    for (const [id, name] of Object.entries(expectedRoles)) {
      const found = roles.rows.find(r => r.id === parseInt(id));
      if (found && found.name === name) {
        console.log(`   ✅ Role ${id}: ${name}`);
      } else {
        console.log(`   ❌ Role ${id}: ${name} NO ENCONTRADO`);
        allValid = false;
      }
    }

    if (roles.rows.length !== 5) {
      console.log(`\n   ❌ ERROR: Esperados 5 roles, pero hay ${roles.rows.length}`);
      allValid = false;
    } else {
      console.log(`\n   ✅ Cantidad correcta: 5 roles`);
    }

    // 4. Check for SERIAL sequence (should NOT exist)
    const seqQuery = `
      SELECT EXISTS(
        SELECT 1 FROM information_schema.sequences
        WHERE sequence_name LIKE '%roles%'
      ) as has_sequence
    `;
    const seqResult = await pool.query(seqQuery);

    console.log('\n\n4️⃣  VERIFICACIÓN DE CLAVE PRIMARIA:');
    console.log('─────────────────────────────────────────────────────────────');

    if (seqResult.rows[0].has_sequence) {
      console.log('   ⚠️  ADVERTENCIA: Encontrada secuencia SERIAL');
      console.log('   (Debería usar IDs fijos, no auto-incremento)');
      allValid = false;
    } else {
      console.log('   ✅ Sin secuencias SERIAL (usando IDs fijos como se espera)');
    }

    // Final verdict
    console.log('\n═══════════════════════════════════════════════════════════════');
    if (allValid && issues.length === 0) {
      console.log('✅ ÉXITO: ¡La migración 037 se aplicó correctamente!');
      console.log('   La tabla roles es ahora GLOBAL con IDs fijos (1, 2, 3, 4, 99)');
      console.log('═══════════════════════════════════════════════════════════════\n');
      process.exit(0);
    } else {
      console.log('❌ ERROR: La migración 037 no se aplicó correctamente');
      console.log('   Revisa la estructura de la tabla (ver arriba)');
      console.log('═══════════════════════════════════════════════════════════════\n');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ Database Error:', error.message);
    if (error.message.includes('ECONNREFUSED')) {
      console.error('\n💡 Solución: Verifica que DATABASE_URL esté correcto');
      console.error('   y que la base de datos sea accesible.');
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

checkMigration();
