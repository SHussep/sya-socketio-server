// Script para probar que el endpoint /api/shifts/current funciona correctamente
// después de la corrección para mobile JWT (sin branchId)

const fetch = require('node-fetch');

const BASE_URL = 'https://sya-socketio-server.onrender.com';

// Simular JWT mobile (solo tiene tenantId, employeeId, email - SIN branchId)
const MOBILE_JWT_SIMULATION = {
  tenantId: 24,
  employeeId: 37,
  // NO tiene branchId
};

// Nota: En producción usarías el JWT real del login móvil
// Este script asume que tienes acceso al JWT o puedes obtenerlo vía /api/auth/login

async function testCurrentShift() {
  console.log('🧪 TEST: Verificar endpoint /api/shifts/current con JWT móvil\n');

  console.log('📋 Escenario:');
  console.log('   - Tenant ID: 24');
  console.log('   - Employee ID: 37');
  console.log('   - JWT móvil: NO incluye branchId');
  console.log('   - Turnos abiertos en DB: 2 (Shift ID 8 y 9 en diferentes sucursales)\n');

  console.log('⚠️  IMPORTANTE: Este script requiere un JWT válido.');
  console.log('   Usa el siguiente comando para obtener el JWT:\n');
  console.log('   curl -X POST https://sya-socketio-server.onrender.com/api/auth/login \\');
  console.log('     -H "Content-Type: application/json" \\');
  console.log('     -d \'{"username":"test@example.com","password":"tu_password"}\'');
  console.log('');
  console.log('   Luego reemplaza YOUR_JWT_TOKEN en este script.\n');

  const YOUR_JWT_TOKEN = 'REEMPLAZAR_CON_JWT_REAL_DE_MOBILE_LOGIN';

  if (YOUR_JWT_TOKEN === 'REEMPLAZAR_CON_JWT_REAL_DE_MOBILE_LOGIN') {
    console.log('❌ Por favor, reemplaza YOUR_JWT_TOKEN con un JWT válido.\n');
    return;
  }

  try {
    console.log('📡 Llamando GET /api/shifts/current...\n');

    const response = await fetch(`${BASE_URL}/api/shifts/current`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${YOUR_JWT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (response.ok) {
      console.log('✅ Respuesta exitosa!\n');

      if (data.data) {
        console.log('📊 Turno encontrado:');
        console.log(`   ID: ${data.data.id}`);
        console.log(`   Sucursal: ${data.data.branch_name} (ID: ${data.data.branch_id})`);
        console.log(`   Empleado: ${data.data.employee_name}`);
        console.log(`   Inicio: ${data.data.start_time}`);
        console.log(`   Monto inicial: $${data.data.initial_amount}`);
        console.log(`   Transacciones: ${data.data.transaction_counter}`);
        console.log(`   Estado: ${data.data.is_cash_cut_open ? '🟢 ABIERTO' : '🔴 CERRADO'}`);
        console.log('');
        console.log('✅ FIX VERIFICADO: El endpoint ahora funciona sin branchId en JWT móvil');
      } else {
        console.log('ℹ️  No hay turno abierto actualmente');
        console.log('   Esto es correcto si no hay turnos abiertos para este empleado');
      }
    } else {
      console.log('❌ Error en la respuesta:');
      console.log(`   Status: ${response.status}`);
      console.log(`   Mensaje: ${data.message || 'Sin mensaje'}`);
    }

  } catch (error) {
    console.error('❌ Error ejecutando test:', error.message);
  }
}

// Instrucciones adicionales
console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST: Verificar corrección de /api/shifts/current');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('📝 PASOS PARA EJECUTAR ESTE TEST:\n');
console.log('1. Obtén un JWT válido con el comando de login móvil (ver arriba)');
console.log('2. Copia el "token" de la respuesta JSON');
console.log('3. Reemplaza YOUR_JWT_TOKEN en línea 39 de este archivo');
console.log('4. Ejecuta: node test_current_shift_fix.js\n');

console.log('═══════════════════════════════════════════════════════════════\n');

testCurrentShift();
