const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
    ssl: { rejectUnauthorized: false }
});

async function checkShiftsTable() {
    try {
        console.log('🔍 Verificando tabla shifts...\n');

        // 1. Estructura de la tabla
        const structure = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'shifts'
            ORDER BY ordinal_position;
        `);

        console.log('📋 Estructura de la tabla shifts:');
        structure.rows.forEach(col => {
            console.log(`  - ${col.column_name}: ${col.data_type} (${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'})`);
        });

        // 2. Turnos del tenant 24
        const shifts = await pool.query(`
            SELECT id, tenant_id, branch_id, employee_id, start_time, end_time, is_cash_cut_open
            FROM shifts
            WHERE tenant_id = 24
            ORDER BY start_time DESC
            LIMIT 10;
        `);

        console.log(`\n📊 Turnos del tenant 24 (últimos 10):`);
        if (shifts.rows.length === 0) {
            console.log('  ❌ No hay turnos registrados para tenant 24');
        } else {
            shifts.rows.forEach(shift => {
                const status = shift.is_cash_cut_open ? '🟢 ABIERTO' : '🔴 CERRADO';
                console.log(`  ${status} | ID: ${shift.id} | Branch: ${shift.branch_id} | Emp: ${shift.employee_id} | ${shift.start_time.toISOString()}`);
            });
        }

        // 3. Turnos abiertos del branch 45
        const openShifts = await pool.query(`
            SELECT id, tenant_id, branch_id, employee_id, start_time, is_cash_cut_open
            FROM shifts
            WHERE tenant_id = 24 AND branch_id = 45 AND is_cash_cut_open = true
            ORDER BY start_time DESC;
        `);

        console.log(`\n🟢 Turnos ABIERTOS en branch 45:`);
        if (openShifts.rows.length === 0) {
            console.log('  ❌ No hay turnos abiertos en branch 45');
        } else {
            openShifts.rows.forEach(shift => {
                console.log(`  ID: ${shift.id} | Emp: ${shift.employee_id} | Inicio: ${shift.start_time.toISOString()}`);
            });
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await pool.end();
    }
}

checkShiftsTable();
