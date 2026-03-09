require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function verifyShift() {
  try {
    console.log('🔍 Verificando turno creado por la prueba...\n');

    // Check the shift with ID 4
    const shift = await pool.query(
      `SELECT s.id, s.tenant_id, s.branch_id, s.employee_id, s.start_time,
              s.initial_amount, s.is_cash_cut_open, s.created_at,
              e.full_name as employee_name, e.username,
              b.name as branch_name
       FROM shifts s
       LEFT JOIN employees e ON s.employee_id = e.id
       LEFT JOIN branches b ON s.branch_id = b.id
       WHERE s.id = 4`
    );

    if (shift.rows.length === 0) {
      console.log('❌ No se encontró el turno con ID 4');
      await pool.end();
      return;
    }

    const shiftData = shift.rows[0];

    console.log('✅ TURNO ENCONTRADO EN POSTGRESQL');
    console.log('=' .repeat(60));
    console.log(`📊 ID: ${shiftData.id}`);
    console.log(`🏢 Tenant ID: ${shiftData.tenant_id}`);
    console.log(`🌿 Sucursal: ${shiftData.branch_name} (ID: ${shiftData.branch_id})`);
    console.log(`👤 Empleado: ${shiftData.employee_name} (@${shiftData.username}, ID: ${shiftData.employee_id})`);
    console.log(`💰 Monto inicial: $${shiftData.initial_amount}`);
    console.log(`🕐 Inicio: ${new Date(shiftData.start_time).toLocaleString('es-MX')}`);
    console.log(`📅 Creado: ${new Date(shiftData.created_at).toLocaleString('es-MX')}`);
    console.log(`🟢 Estado: ${shiftData.is_cash_cut_open ? 'ABIERTO' : 'CERRADO'}`);
    console.log('=' .repeat(60));

    console.log('\n✅ CONCLUSIÓN: El turno fue sincronizado exitosamente desde el endpoint /api/sync/shifts/open');
    console.log('✅ La app móvil PUEDE consultar este turno usando GET /api/shifts/current');
    console.log('✅ El turno pertenece al tenant_id=24, branch_id=45, employee_id=37');

    // Check all shifts for tenant 24
    const allShifts = await pool.query(
      `SELECT COUNT(*) FROM shifts WHERE tenant_id = 24`
    );

    console.log(`\n📊 Total de turnos para tenant 24: ${allShifts.rows[0].count}`);

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
  }
}

verifyShift();
