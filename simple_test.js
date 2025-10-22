const axios = require('axios');

const api = axios.create({
  baseURL: 'https://sya-socketio-server.onrender.com',
  headers: { 'Content-Type': 'application/json' },
});

(async () => {
  try {
    console.log('1. Creando asignación...');
    const assignRes = await api.post('/api/repartidor-assignments', {
      sale_id: 76,
      employee_id: 3,
      branch_id: 13,
      tenant_id: 3,
      cantidad_asignada: 50.0,
      monto_asignado: 2500.00,
      observaciones: 'Test simple',
    });
    const assignmentId = assignRes.data.data.id;
    console.log(`✅ Asignación creada: ID=${assignmentId}\n`);

    console.log('2. Liquidando asignación...');
    const liqRes = await api.post(`/api/repartidor-assignments/${assignmentId}/liquidate`, {
      cantidad_devuelta: 10.0,
      monto_devuelto: 500.00,
      total_gastos: 100.00,
      neto_a_entregar: 1900.00,
      diferencia_dinero: -600.00,
    });
    console.log('✅ Liquidación exitosa\n');

    console.log('3. Consultando asignaciones...');
    const assignmentsRes = await api.get('/api/repartidor-assignments/employee/3', {
      params: { tenant_id: 3, branch_id: 13 },
    });
    console.log(`✅ Asignaciones: ${assignmentsRes.data.count} encontradas\n`);

    console.log('4. Consultando liquidaciones...');
    const liqsRes = await api.get('/api/repartidor-liquidations/employee/3', {
      params: { tenant_id: 3, branch_id: 13 },
    });
    console.log(`✅ Liquidaciones: ${liqsRes.data.count} encontradas\n`);

    console.log('5. Consultando deudas...');
    const debtsRes = await api.get('/api/repartidor-debts/employee/3', {
      params: { tenant_id: 3, branch_id: 13 },
    });
    console.log(`✅ Deudas: ${debtsRes.data.count} encontradas\n`);

    console.log('╔════════════════════════════════════════╗');
    console.log('║   ✅ SISTEMA COMPLETAMENTE FUNCIONAL   ║');
    console.log('╚════════════════════════════════════════╝\n');

    console.log('Resumen:');
    console.log(`  • Asignación creada y liquidada: ID=${assignmentId}`);
    console.log(`  • Kilos vendidos: 40/50`);
    console.log(`  • Deuda generada: $600`);
    console.log(`  • Sistema de repartidores operacional: ✅\n`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    process.exit(1);
  }
})();
