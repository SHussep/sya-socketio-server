#!/usr/bin/env node
/**
 * Script de prueba para verificar que GET /api/sales retorna tenant_id y branch_id
 */
const http = require('https');

const options = {
  hostname: 'sya-socketio-server.onrender.com',
  path: '/api/sales?limit=1',
  method: 'GET',
  headers: {
    'Authorization': 'Bearer test_token'
  }
};

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      console.log('\nRespuesta del API:');
      console.log(JSON.stringify(parsed, null, 2));
      
      if (parsed.data && parsed.data.length > 0) {
        console.log('\n✅ Primer item:');
        console.log(JSON.stringify(parsed.data[0], null, 2));
      }
    } catch (e) {
      console.log('Error parseando respuesta:', e.message);
      console.log('Raw response:', data.substring(0, 500));
    }
  });
});

req.on('error', (e) => {
  console.error(`Error: ${e.message}`);
});

req.end();
