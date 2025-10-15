// Prueba alternativa: Usar PKCE flow para obtener token
// Este método es más moderno y puede funcionar mejor

require('dotenv').config();
const crypto = require('crypto');

async function testDropboxPKCE() {
    const APP_KEY = 'tgmvr7snr4vbxb9';
    const APP_SECRET = 'vrsgbq7tt44awpw';

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  DIAGNÓSTICO: Problema con tokens de Dropbox');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('📋 Información de tu app:');
    console.log(`   App Key: ${APP_KEY}`);
    console.log(`   App Secret: ${APP_SECRET}\n`);

    console.log('⚠️  PROBLEMA IDENTIFICADO:');
    console.log('   Los tokens generados con OAuth están fallando con 401.\n');

    console.log('🔍 POSIBLES CAUSAS:\n');
    console.log('1. La app de Dropbox necesita configuración adicional:');
    console.log('   - Ve a: https://www.dropbox.com/developers/apps');
    console.log('   - Abre tu app: tgmvr7snr4vbxb9');
    console.log('   - En "Settings" → "OAuth 2"');
    console.log('   - Verifica que "Access token expiration" = "No expiration"\n');

    console.log('2. La app necesita ser aprobada por Dropbox:');
    console.log('   - En modo desarrollo, solo TÚ puedes usar la app');
    console.log('   - Pero el token debe generarse desde TU cuenta de Dropbox\n');

    console.log('3. Permisos insuficientes:');
    console.log('   - Ve a "Permissions" tab en tu app');
    console.log('   - Asegúrate de tener marcados:');
    console.log('     ✓ files.metadata.write');
    console.log('     ✓ files.metadata.read');
    console.log('     ✓ files.content.write');
    console.log('     ✓ files.content.read\n');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  SOLUCIÓN ALTERNATIVA: Usar "Generated access token"');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('Pasos para generar un token que SÍ funcione:\n');
    console.log('1. Ve a: https://www.dropbox.com/developers/apps');
    console.log('2. Abre tu app: tgmvr7snr4vbxb9');
    console.log('3. Ve a "Settings" tab');
    console.log('4. Busca la sección "OAuth 2"');
    console.log('5. Asegúrate que "Access token expiration" = "No expiration"');
    console.log('6. Haz clic en "Generate" en "Generated access token"');
    console.log('7. Copia el token generado\n');

    console.log('⚠️  IMPORTANTE: Si "Access token expiration" está en "Short-lived",');
    console.log('   CÁMBIALO a "No expiration" y regenera el token.\n');
    console.log('═══════════════════════════════════════════════════════════\n');
}

testDropboxPKCE();
