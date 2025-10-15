// Script simple para obtener el refresh token de Dropbox
// Uso: node get_dropbox_refresh_token.js

const APP_KEY = 'tgmvr7snr4vbxb9';
const APP_SECRET = 'vrsgbq7tt44awpw';

console.log('═══════════════════════════════════════════════════════════');
console.log('  PASO 1: Autoriza la aplicación');
console.log('═══════════════════════════════════════════════════════════\n');

const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${APP_KEY}&response_type=code&token_access_type=offline`;

console.log('Abre esta URL en tu navegador:\n');
console.log(authUrl);
console.log('\n1. Inicia sesión en Dropbox');
console.log('2. Haz clic en "Permitir" / "Allow"');
console.log('3. Copia el código que aparece en la página\n');
console.log('═══════════════════════════════════════════════════════════\n');
console.log('PASO 2: Una vez que tengas el código, ejecuta:\n');
console.log('node exchange_code_for_token.js TU_CODIGO_AQUI\n');
console.log('═══════════════════════════════════════════════════════════\n');
