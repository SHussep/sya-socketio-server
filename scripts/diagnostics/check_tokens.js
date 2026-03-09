const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // 1. Verificar tokens activos
  var result = await pool.query(
    `SELECT dt.id, dt.device_name, dt.platform, dt.is_active, dt.last_used_at,
            dt.device_id, LEFT(dt.device_token, 30) as token_preview,
            e.first_name || ' ' || e.last_name as employee_name, e.username, r.name as role_name, r.mobile_access_type,
            b.name as branch_name
     FROM device_tokens dt
     JOIN employees e ON dt.employee_id = e.id
     JOIN roles r ON e.role_id = r.id
     JOIN branches b ON dt.branch_id = b.id
     WHERE b.tenant_id = 31
     ORDER BY dt.is_active DESC, dt.last_used_at DESC`
  );

  console.log('=== DEVICE TOKENS para tenant 31 ===');
  console.log('Total registros:', result.rows.length);

  result.rows.forEach(function(row) {
    var status = row.is_active ? 'ACTIVO' : 'INACTIVO';
    console.log('');
    console.log('ID: ' + row.id + ' | ' + status);
    console.log('  Device: ' + row.device_name + ' (' + row.platform + ')');
    console.log('  Employee: ' + row.employee_name + ' | Role: ' + row.role_name + ' | Access: ' + row.mobile_access_type);
    console.log('  Branch: ' + row.branch_name);
    console.log('  Token preview: ' + row.token_preview + '...');
    console.log('  Last used: ' + row.last_used_at);
    console.log('  Device ID: ' + row.device_id);
  });

  // 2. Simular EXACTA query que usa notificationHelper.sendNotificationToAdminsInTenant
  console.log('\n=== SIMULACION: sendNotificationToAdminsInTenant(31) ===');
  var adminsResult = await pool.query(
    `SELECT DISTINCT dt.device_token, dt.employee_id, b.name as branch_name
     FROM device_tokens dt
     JOIN employees e ON dt.employee_id = e.id
     JOIN roles r ON e.role_id = r.id
     JOIN branches b ON dt.branch_id = b.id
     WHERE b.tenant_id = 31
       AND dt.is_active = true
       AND r.mobile_access_type = 'admin'`
  );
  console.log('Dispositivos que recibirian FCM:', adminsResult.rows.length);
  adminsResult.rows.forEach(function(row) {
    console.log('  employee_id=' + row.employee_id + ' | branch=' + row.branch_name + ' | token=' + row.device_token.substring(0, 30) + '...');
  });

  // 3. Verificar notification_preferences
  console.log('\n=== NOTIFICATION PREFERENCES ===');
  var prefsResult = await pool.query(
    `SELECT * FROM notification_preferences np
     JOIN employees e ON np.employee_id = e.id
     JOIN branches b ON e.tenant_id = b.tenant_id
     WHERE b.tenant_id = 31`
  );
  console.log('Preferencias encontradas:', prefsResult.rows.length);
  if (prefsResult.rows.length === 0) {
    console.log('  (Sin preferencias = usar defaults = todas activas)');
  }

  // 4. Verificar historial de notificaciones recientes
  console.log('\n=== ULTIMAS NOTIFICACIONES ENVIADAS (tenant 31) ===');
  var notifsResult = await pool.query(
    `SELECT id, category, event_type, title, LEFT(body, 80) as body_preview, created_at
     FROM notifications
     WHERE tenant_id = 31
     ORDER BY created_at DESC
     LIMIT 5`
  );
  notifsResult.rows.forEach(function(row) {
    console.log('  [' + row.created_at + '] ' + row.event_type + ': ' + row.title);
    console.log('    ' + row.body_preview);
  });

  await pool.end();
}

check().catch(function(e) { console.error('ERROR:', e.message); process.exit(1); });
