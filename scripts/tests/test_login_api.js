const https = require('https');

// Test login against production server
async function testLogin() {
  const email = 'entretierras.podcast@gmail.com';
  const password = 'tu_contraseña'; // Cambiar por la contraseña real

  console.log('\n=== Test de Login contra Servidor ===\n');
  console.log(`URL: https://sya-socketio-server.onrender.com/api/auth/desktop-login`);
  console.log(`Email: ${email}`);
  console.log(`Password: ${password}\n`);

  const postData = JSON.stringify({
    email: email,
    password: password
  });

  const options = {
    hostname: 'sya-socketio-server.onrender.com',
    port: 443,
    path: '/api/auth/desktop-login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log(`📊 Status Code: ${res.statusCode}`);
        console.log(`📋 Response Headers: ${JSON.stringify(res.headers, null, 2)}`);
        console.log(`📝 Response Body:\n${JSON.stringify(JSON.parse(data), null, 2)}`);
        resolve();
      });
    });

    req.on('error', (error) => {
      console.error(`❌ Error: ${error.message}`);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

testLogin().catch(err => console.error(err));
