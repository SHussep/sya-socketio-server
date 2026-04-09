/**
 * Elimina una sucursal por ID (con cascade)
 * Uso: node scripts/delete_branch.js <branchId>
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function deleteBranch(branchId) {
    const client = await pool.connect();
    try {
        // Verificar que existe
        const { rows } = await client.query(
            'SELECT id, name, tenant_id, branch_code FROM branches WHERE id = $1',
            [branchId]
        );

        if (rows.length === 0) {
            console.log(`❌ No se encontró sucursal con ID ${branchId}`);
            return;
        }

        const branch = rows[0];
        console.log(`🔍 Sucursal encontrada:`);
        console.log(`   - ID: ${branch.id}`);
        console.log(`   - Nombre: ${branch.name}`);
        console.log(`   - Código: ${branch.branch_code}`);
        console.log(`   - Tenant: ${branch.tenant_id}`);

        await client.query('BEGIN');

        // Liberar licencia asociada (de active → available)
        const licResult = await client.query(
            "UPDATE branch_licenses SET status = 'available', branch_id = NULL, activated_at = NULL, updated_at = NOW() WHERE branch_id = $1 AND status = 'active' RETURNING id",
            [branchId]
        );
        if (licResult.rowCount > 0) {
            console.log(`   📜 Licencia ${licResult.rows[0].id} liberada (available)`);
        }

        // Limpiar relaciones que podrían no tener CASCADE
        await client.query('DELETE FROM branch_devices WHERE branch_id = $1', [branchId]);
        await client.query('DELETE FROM employee_branches WHERE branch_id = $1', [branchId]);

        // Eliminar la sucursal (CASCADE limpia el resto)
        const result = await client.query('DELETE FROM branches WHERE id = $1', [branchId]);

        await client.query('COMMIT');

        if (result.rowCount > 0) {
            console.log(`\n✅ Sucursal "${branch.name}" (ID: ${branchId}) eliminada exitosamente`);
        } else {
            console.log(`❌ No se pudo eliminar`);
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Error:', err.message);
    } finally {
        client.release();
        await pool.end();
    }
}

const branchId = parseInt(process.argv[2]);
if (!branchId) {
    console.log('Uso: node scripts/delete_branch.js <branchId>');
    process.exit(1);
}

deleteBranch(branchId);
