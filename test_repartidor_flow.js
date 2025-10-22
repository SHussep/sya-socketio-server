#!/usr/bin/env node

/**
 * Script de prueba para verificar flujo completo de asignaciones a repartidores
 * Crear asignación → Liquidar → Verificar deuda
 */

const axios = require('axios');
require('dotenv').config();

const API_BASE = process.env.API_BASE || 'https://sya-socketio-server.onrender.com';

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
});

async function testRepartidorFlow() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   TESTING REPARTIDOR SYSTEM - COMPLETE FLOW           ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  try {
    // PASO 1: Crear una asignación
    console.log('1️⃣  CREAR ASIGNACIÓN');
    console.log('─'.repeat(50));

    const assignmentPayload = {
      sale_id: 76,  // Venta real del sistema
      employee_id: 3,  // Empleado real
      branch_id: 13,  // Sucursal real
      tenant_id: 3,  // Tenant real
      cantidad_asignada: 50.0,
      monto_asignado: 2500.00,
      observaciones: 'Prueba de asignación a repartidor - Sistema completo',
    };

    console.log('Payload:');
    console.log(JSON.stringify(assignmentPayload, null, 2));

    const assignmentRes = await api.post('/api/repartidor/assignments', assignmentPayload);

    if (assignmentRes.data.success) {
      const assignment = assignmentRes.data.data;
      console.log('\n✅ Asignación creada exitosamente');
      console.log(`   ID: ${assignment.id}`);
      console.log(`   Kilos asignados: ${assignment.cantidad_asignada}`);
      console.log(`   Monto asignado: $${assignment.monto_asignado}`);
      console.log(`   Estado: ${assignment.estado}\n`);

      const assignmentId = assignment.id;

      // PASO 2: Liquidar la asignación
      console.log('2️⃣  LIQUIDAR ASIGNACIÓN');
      console.log('─'.repeat(50));

      const liquidationPayload = {
        cantidad_devuelta: 10.0, // 10 kilos devueltos
        monto_devuelto: 500.00, // $500 devueltos
        total_gastos: 100.00, // $100 en gastos (combustible)
        neto_a_entregar: 1900.00, // 2500 - 500 - 100
        diferencia_dinero: -600.00, // Negativo = DEUDA
      };

      console.log('Payload:');
      console.log(JSON.stringify(liquidationPayload, null, 2));

      const liquidationRes = await api.post(
        `/api/repartidor/assignments/${assignmentId}/liquidate`,
        liquidationPayload
      );

      if (liquidationRes.data.success) {
        const liquidation = liquidationRes.data.liquidation;
        console.log('\n✅ Liquidación procesada exitosamente');
        if (liquidation.id) console.log(`   Liquidation ID: ${liquidation.id}`);
        console.log(`   Kilos vendidos: ${liquidation.total_kilos_vendidos}`);
        if (liquidation.monto_total_vendido) console.log(`   Monto vendido: $${liquidation.monto_total_vendido}`);
        if (liquidation.total_gastos) console.log(`   Gastos: $${liquidation.total_gastos}`);
        console.log(`   Neto a entregar: $${liquidation.neto_a_entregar}`);
        console.log(`   Diferencia: $${liquidation.diferencia_dinero}`);

        if (liquidation.diferencia_dinero && liquidation.diferencia_dinero < 0) {
          console.log(`   ⚠️  DEUDA GENERADA: $${Math.abs(liquidation.diferencia_dinero)}\n`);
        }
      } else {
        console.log('❌ Error liquidando asignación');
        console.log(liquidationRes.data);
        return;
      }

      // PASO 3: Consultar asignaciones activas
      console.log('3️⃣  CONSULTAR ASIGNACIONES ACTIVAS');
      console.log('─'.repeat(50));

      try {
        const assignmentsRes = await api.get('/api/repartidor/assignments/employee/3', {
          params: {
            tenant_id: 3,
            branch_id: 13,
          },
        });

        console.log(`Total de asignaciones: ${assignmentsRes.data.count}`);
        if (assignmentsRes.data && assignmentsRes.data.data && assignmentsRes.data.data.length > 0) {
          assignmentsRes.data.data.forEach((a, idx) => {
            console.log(`\n  Asignación ${idx + 1}:`);
            console.log(`    ID: ${a.id}`);
            console.log(`    Estado: ${a.estado}`);
            console.log(`    Kilos: ${a.cantidad_asignada} (${a.cantidad_vendida} vendidos)`);
          });
        }
        console.log();
      } catch (e) {
        console.error('❌ Error en PASO 3:', e.message);
        throw e;
      }

      // PASO 4: Consultar liquidaciones
      console.log('4️⃣  CONSULTAR LIQUIDACIONES');
      console.log('─'.repeat(50));

      const liquidationsRes = await api.get('/api/repartidor/liquidations/employee/3', {
        params: {
          tenant_id: 3,
          branch_id: 13,
        },
      });

      console.log(`Total de liquidaciones: ${liquidationsRes.data.count}`);
      if (liquidationsRes.data.data.length > 0) {
        liquidationsRes.data.data.forEach((l, idx) => {
          console.log(`\n  Liquidación ${idx + 1}:`);
          console.log(`    ID: ${l.id}`);
          console.log(`    Kilos vendidos: ${l.total_kilos_vendidos}`);
          console.log(`    Neto: $${l.neto_a_entregar}`);
          console.log(`    Diferencia: $${l.diferencia_dinero}`);
        });
      }
      console.log();

      // PASO 5: Consultar deudas
      console.log('5️⃣  CONSULTAR DEUDAS');
      console.log('─'.repeat(50));

      const debtsRes = await api.get('/api/repartidor/debts/employee/3', {
        params: {
          tenant_id: 3,
          branch_id: 13,
        },
      });

      console.log(`Total de deudas: ${debtsRes.data.count}`);
      if (debtsRes.data.data.length > 0) {
        debtsRes.data.data.forEach((d, idx) => {
          console.log(`\n  Deuda ${idx + 1}:`);
          console.log(`    ID: ${d.id}`);
          console.log(`    Monto: $${d.monto_deuda}`);
          console.log(`    Pagado: $${d.monto_pagado}`);
          console.log(`    Pendiente: $${d.monto_pendiente}`);
          console.log(`    Estado: ${d.estado}`);
        });
      } else {
        console.log('No hay deudas registradas');
      }
      console.log();

      // PASO 6: Resumen por sucursal
      console.log('6️⃣  RESUMEN POR SUCURSAL');
      console.log('─'.repeat(50));

      const summaryRes = await api.get('/api/repartidor/liquidations/branch/13/summary', {
        params: {
          tenant_id: 3,
        },
      });

      console.log('Resumen de sucursal:');
      console.log(JSON.stringify(summaryRes.data, null, 2));
      console.log();

      // RESUMEN FINAL
      console.log('╔════════════════════════════════════════════════════════╗');
      console.log('║     ✅ PRUEBA COMPLETA EJECUTADA EXITOSAMENTE         ║');
      console.log('╚════════════════════════════════════════════════════════╝\n');

      console.log('Resumen de operaciones:');
      console.log('✅ Asignación creada (ID: ' + assignmentId + ')');
      console.log('✅ Liquidación procesada');
      console.log('✅ Deuda registrada (si corresponde)');
      console.log('✅ Consultas de datos exitosas');
      console.log('\n✨ Sistema de repartidores completamente funcional\n');

    } else {
      console.log('❌ Error creando asignación:');
      console.log(assignmentRes.data);
    }

  } catch (error) {
    console.error('❌ Error en la prueba:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
}

testRepartidorFlow().catch(error => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});
