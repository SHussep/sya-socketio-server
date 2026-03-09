#!/usr/bin/env node

/**
 * Verification script to check roles table structure and data
 * This confirms the migration 037 was applied correctly
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function verifyRolesTable() {
  try {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('VERIFICATION: Roles Table Structure');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // 1. Check table structure
    console.log('1. TABLE STRUCTURE:');
    const structureQuery = `
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_name = 'roles'
      ORDER BY ordinal_position
    `;
    const structureResult = await pool.query(structureQuery);

    if (structureResult.rows.length === 0) {
      console.error('❌ ERROR: roles table not found!');
      process.exit(1);
    }

    console.table(structureResult.rows);

    // 2. Check for unwanted columns
    const columnNames = structureResult.rows.map(r => r.column_name);
    const hasProblems = [];

    if (columnNames.includes('tenant_id')) {
      hasProblems.push('❌ ERROR: tenant_id column still exists (should be removed)');
    }
    if (columnNames.includes('branch_id')) {
      hasProblems.push('❌ ERROR: branch_id column still exists (should be removed)');
    }

    if (hasProblems.length > 0) {
      console.log('\nPROBLEMS FOUND:');
      hasProblems.forEach(p => console.log(p));
      console.log('\n⚠️  The migration did NOT apply correctly!');
    } else {
      console.log('\n✅ No tenant_id or branch_id columns found - correct!');
    }

    // 3. Check current roles data
    console.log('\n\n2. CURRENT ROLES DATA:');
    const rolesQuery = `
      SELECT id, name, description, created_at, updated_at
      FROM roles
      ORDER BY id
    `;
    const rolesResult = await pool.query(rolesQuery);

    console.log(`Found ${rolesResult.rows.length} roles:\n`);
    console.table(rolesResult.rows);

    // 4. Verify required roles exist
    console.log('\n3. ROLE VALIDATION:');
    const expectedRoles = {
      1: 'Administrador',
      2: 'Encargado',
      3: 'Repartidor',
      4: 'Ayudante',
      99: 'Otro'
    };

    let allCorrect = true;
    for (const [expectedId, expectedName] of Object.entries(expectedRoles)) {
      const found = rolesResult.rows.find(r => r.id === parseInt(expectedId));
      if (found && found.name === expectedName) {
        console.log(`✅ Role ${expectedId}: ${expectedName}`);
      } else {
        console.log(`❌ ERROR: Role ${expectedId} (${expectedName}) not found or wrong name`);
        allCorrect = false;
      }
    }

    if (rolesResult.rows.length !== 5) {
      console.log(`❌ ERROR: Expected 5 roles but found ${rolesResult.rows.length}`);
      allCorrect = false;
    } else {
      console.log(`✅ Correct number of roles: 5`);
    }

    // 5. Check for SERIAL sequence (should not exist)
    console.log('\n4. PRIMARY KEY VERIFICATION:');
    const pkQuery = `
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_name = 'roles' AND constraint_type = 'PRIMARY KEY'
    `;
    const pkResult = await pool.query(pkQuery);
    if (pkResult.rows.length > 0) {
      console.log('✅ Primary key exists:', pkResult.rows[0].constraint_name);
    }

    const sequenceQuery = `
      SELECT EXISTS(
        SELECT 1 FROM information_schema.sequences
        WHERE sequence_name LIKE 'roles%'
      ) as has_sequence
    `;
    const seqResult = await pool.query(sequenceQuery);
    if (seqResult.rows[0].has_sequence) {
      console.log('⚠️  WARNING: SERIAL sequence found (should use fixed IDs)');
      allCorrect = false;
    } else {
      console.log('✅ No SERIAL sequence (using fixed integer IDs as expected)');
    }

    // Final verdict
    console.log('\n═══════════════════════════════════════════════════════════════');
    if (allCorrect && hasProblems.length === 0) {
      console.log('✅ MIGRATION SUCCESSFUL: Roles table is correctly configured!');
      console.log('═══════════════════════════════════════════════════════════════\n');
      process.exit(0);
    } else {
      console.log('❌ MIGRATION FAILED: Roles table has issues (see above)');
      console.log('═══════════════════════════════════════════════════════════════\n');
      process.exit(1);
    }

  } catch (error) {
    console.error('Database error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verifyRolesTable();
