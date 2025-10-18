// Script de diagnóstico para Render
const fs = require('fs');

console.log('=== DIAGNÓSTICO RENDER ===\n');

// 1. Verificar tamaño del archivo
const stats = fs.statSync('./server.js');
console.log(`1. Tamaño de server.js: ${stats.size} bytes (${(stats.size/1024).toFixed(2)} KB)`);
console.log(`   Esperado: ~98859 bytes (96.54 KB)\n`);

// 2. Buscar endpoints google-signup
const content = fs.readFileSync('./server.js', 'utf8');
const lines = content.split('\n');
const googleSignupLines = [];
lines.forEach((line, index) => {
    if (line.includes("app.post") && line.includes("google-signup")) {
        googleSignupLines.push(index + 1);
    }
});
console.log(`2. Endpoints google-signup encontrados: ${googleSignupLines.length}`);
googleSignupLines.forEach(lineNum => {
    console.log(`   Línea ${lineNum}`);
});
console.log('');

// 3. Verificar emailExists
const emailExistsCount = (content.match(/emailExists: true/g) || []).length;
console.log(`3. Ocurrencias de "emailExists: true": ${emailExistsCount}`);
console.log(`   Esperado: 3\n`);

// 4. Verificar logs específicos
const hasLogRequest = content.includes("console.log('[Google Signup] Request:'");
const hasLogEmailExists = content.includes("console.log(`[Google Signup] Email ya existe");
const hasLogError23505 = content.includes("Error 23505 detectado");

console.log(`4. Logs importantes:`);
console.log(`   - Log de Request: ${hasLogRequest ? '✅' : '❌'}`);
console.log(`   - Log Email existe: ${hasLogEmailExists ? '✅' : '❌'}`);
console.log(`   - Log Error 23505: ${hasLogError23505 ? '✅' : '❌'}`);
console.log('');

// 5. Verificar estructura del endpoint
const googleSignupStart = content.indexOf("app.post('/api/auth/google-signup'");
if (googleSignupStart !== -1) {
    const snippet = content.substring(googleSignupStart, googleSignupStart + 2000);
    const hasEmailExists = snippet.includes('emailExists: true');
    const hasValidation = snippet.includes('if (!email || !displayName');
    const hasExistingCheck = snippet.includes('if (existing.rows.length > 0)');

    console.log(`5. Estructura del endpoint /api/auth/google-signup:`);
    console.log(`   - Validación de campos: ${hasValidation ? '✅' : '❌'}`);
    console.log(`   - Check de email existente: ${hasExistingCheck ? '✅' : '❌'}`);
    console.log(`   - Respuesta con emailExists: ${hasEmailExists ? '✅' : '❌'}`);
} else {
    console.log(`5. ❌ No se encontró el endpoint google-signup`);
}

console.log('\n=== FIN DIAGNÓSTICO ===');
