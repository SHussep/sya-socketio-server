// Script CORREGIDO para obtener refresh token de Dropbox
// El problema anterior: faltaba incluir "token_access_type=offline"

// ⚠️ SEGURIDAD: Las credenciales deben venir de variables de entorno
const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;

if (!APP_KEY || !APP_SECRET) {
    console.error('❌ Error: DROPBOX_APP_KEY y DROPBOX_APP_SECRET deben estar configurados');
    console.error('   Ejecuta: export DROPBOX_APP_KEY=xxx DROPBOX_APP_SECRET=yyy');
    process.exit(1);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  OBTENER REFRESH TOKEN DE DROPBOX (PERMANENTE)');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('📝 Este método genera tokens que NUNCA expiran.\n');

console.log('PASO 1: Abre esta URL en tu navegador:\n');

// IMPORTANTE: Incluir token_access_type=offline para obtener refresh token
const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${APP_KEY}&response_type=code&token_access_type=offline`;

console.log(authUrl);
console.log('\n');

console.log('PASO 2: Autoriza la aplicación en tu navegador:');
console.log('   - Inicia sesión en Dropbox (usa LA CUENTA donde quieres los backups)');
console.log('   - Haz clic en "Permitir"');
console.log('   - Copia el CÓDIGO que te muestre\n');

console.log('PASO 3: Ejecuta este comando con el código:\n');
console.log('   node exchange_code_for_token.js TU_CODIGO_AQUI\n');

console.log('═══════════════════════════════════════════════════════════\n');
console.log('⚠️  IMPORTANTE:\n');
console.log('- El código de autorización solo funciona UNA VEZ');
console.log('- Si ya usaste un código, genera uno nuevo');
console.log('- El refresh token resultante NUNCA expira\n');
console.log('═══════════════════════════════════════════════════════════\n');
