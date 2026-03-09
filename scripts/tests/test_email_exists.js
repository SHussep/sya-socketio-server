// Test del endpoint google-signup con email duplicado
const https = require('https');

const testData = {
    idToken: 'test_token_from_google',
    email: 'saul.hussep@gmail.com', // Email que sabemos que existe
    displayName: 'Test User',
    businessName: 'Test Business',
    password: 'testpassword123',
    timezone: 'America/Mexico_City'
};

console.log('=== TEST GOOGLE SIGNUP CON EMAIL EXISTENTE ===\n');
console.log('Enviando request a Render...');
console.log('Email:', testData.email);
console.log('');

const postData = JSON.stringify(testData);

const options = {
    hostname: 'sya-socketio-server.onrender.com',
    port: 443,
    path: '/api/auth/google-signup',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
    }
};

const req = https.request(options, (res) => {
    console.log(`Status Code: ${res.statusCode}`);
    console.log(`Status Message: ${res.statusMessage}`);
    console.log('Headers:', JSON.stringify(res.headers, null, 2));
    console.log('');

    let data = '';

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        console.log('Response Body:');
        try {
            const jsonData = JSON.parse(data);
            console.log(JSON.stringify(jsonData, null, 2));

            console.log('\n=== ANÁLISIS ===');
            console.log('✅ success:', jsonData.success);
            console.log('📧 emailExists:', jsonData.emailExists || 'NO PRESENTE');
            console.log('🏢 tenant:', jsonData.tenant ? 'PRESENTE' : 'NO PRESENTE');
            console.log('🏪 branches:', jsonData.branches ? `${jsonData.branches.length} sucursales` : 'NO PRESENTE');

            if (jsonData.branches && jsonData.branches.length > 0) {
                console.log('\n📋 Sucursales encontradas:');
                jsonData.branches.forEach((b, i) => {
                    console.log(`   ${i+1}. ${b.name} (${b.branchCode})`);
                });
            }

            if (jsonData.emailExists === true) {
                console.log('\n✅ ¡ÉXITO! El servidor está retornando emailExists: true');
            } else {
                console.log('\n❌ ERROR: El servidor NO está retornando emailExists: true');
            }
        } catch (error) {
            console.log('ERROR parsing JSON:', error.message);
            console.log('Raw data:', data);
        }
    });
});

req.on('error', (error) => {
    console.error('❌ Request error:', error.message);
});

req.write(postData);
req.end();
