// ═══════════════════════════════════════════════════════════════
// FIREBASE ADMIN SDK INITIALIZATION
// Envía notificaciones FCM a dispositivos registrados
// ═══════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let firebaseInitialized = false;

/**
 * Inicializa Firebase Admin SDK
 * Espera archivo serviceAccountKey.json en la raíz del proyecto
 */
function initializeFirebase() {
    if (firebaseInitialized) {
        return;
    }

    try {
        const serviceAccountPath = path.join(__dirname, '../serviceAccountKey.json');

        // En producción (Render), las credenciales vienen de variables de entorno
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('✅ Firebase initialized from environment variable');
        } else if (fs.existsSync(serviceAccountPath)) {
            const serviceAccount = require(serviceAccountPath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('✅ Firebase initialized from serviceAccountKey.json');
        } else {
            console.warn('⚠️ Firebase not initialized - serviceAccountKey.json not found');
            console.warn('   Push notifications will be disabled');
            console.warn('   To enable, provide FIREBASE_SERVICE_ACCOUNT env var or serviceAccountKey.json');
            return false;
        }

        firebaseInitialized = true;
        return true;
    } catch (error) {
        console.error('❌ Error initializing Firebase:', error.message);
        console.warn('   Push notifications will be disabled');
        return false;
    }
}

/**
 * Envía notificación FCM a un dispositivo específico.
 *
 * dataOnly: cuando true, omite el campo `notification:` y envía solo `data:`.
 * Necesario para flujos donde la app móvil construye su propia notificación
 * local (flutter_local_notifications) — incluir `notification:` causaba doble
 * notificación en Android porque el SO la mostraba auto y la app además
 * llamaba a show() desde onMessage. iOS ya lo evita con
 * setForegroundNotificationPresentationOptions(alert: false).
 *
 * En data-only, los strings `title` y `body` se incluyen dentro de `data` para
 * que la app pueda renderizar la notif local con el mismo contenido.
 */
async function sendNotificationToDevice(deviceToken, {
    title = 'SYA Notificación',
    body = '',
    data = {},
    dataOnly = false
} = {}) {
    if (!firebaseInitialized || !admin.apps.length) {
        console.warn('⚠️ Firebase not initialized, cannot send notification');
        return null;
    }

    try {
        // FCM data fields deben ser strings — convertir cualquier number/bool
        // a string para evitar "must only contain string values" del SDK admin.
        const stringifiedData = {};
        for (const [k, v] of Object.entries(data || {})) {
            if (v == null) continue;
            stringifiedData[k] = typeof v === 'string' ? v : String(v);
        }

        const message = {
            data: dataOnly
                ? { ...stringifiedData, title: String(title), body: String(body) }
                : stringifiedData,
            token: deviceToken,
            android: {
                priority: 'high',
                ttl: 3600
            },
            apns: {
                headers: {
                    'apns-priority': '10'
                },
                payload: {
                    aps: dataOnly
                        // En iOS data-only debe ir content-available para wake en background.
                        ? { 'content-available': 1 }
                        : {
                            alert: { title, body },
                            sound: 'default',
                            badge: 1
                        }
                }
            }
        };
        if (!dataOnly) {
            message.notification = { title, body };
        }

        const response = await admin.messaging().send(message);
        console.log(`[FCM] ✅ Notificación enviada a dispositivo: ${response}`);
        return response;
    } catch (error) {
        console.error(`[FCM] ❌ Error enviando notificación: ${error.message}`);

        // Errores que SÍ indican token inválido (remover de BD).
        // NOTA: messaging/third-party-auth-error NO va aquí — ese es un problema
        // de credenciales APNs/OAuth del servidor, no del token del dispositivo.
        // Marcar tokens válidos como inválidos por este error causa que todos los
        // dispositivos queden desactivados silenciosamente.
        if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered' ||
            error.message?.includes('Requested entity was not found')) {
            console.warn(`[FCM] ⚠️ Token inválido, debería ser removido de BD (${error.code})`);
            return 'INVALID_TOKEN';
        }

        // Error de credenciales del servidor (APNs expirado, service account mal, etc).
        // Log explícito para que sea obvio que el token NO es el problema.
        if (error.code === 'messaging/third-party-auth-error') {
            console.error(`[FCM] 🚨 ERROR DE CREDENCIALES DEL SERVIDOR (no del token): ${error.code}`);
            console.error(`[FCM]    Verificar APNs Authentication Key en Firebase Console → Cloud Messaging`);
        }

        return null;
    }
}

/**
 * Envía notificación a múltiples dispositivos.
 * notificationData puede incluir dataOnly:true para omitir el campo
 * `notification:` y dejar que la app construya su propia notif local.
 */
async function sendNotificationToMultipleDevices(deviceTokens, notificationData) {
    if (!firebaseInitialized || !admin.apps.length) {
        console.warn('⚠️ Firebase not initialized, cannot send notifications');
        return [];
    }

    const results = [];

    for (const deviceToken of deviceTokens) {
        const result = await sendNotificationToDevice(deviceToken, notificationData);
        results.push({
            deviceToken,
            success: result !== null && result !== 'INVALID_TOKEN',
            result
        });
    }

    return results;
}

module.exports = {
    initializeFirebase,
    sendNotificationToDevice,
    sendNotificationToMultipleDevices,
    isFirebaseInitialized: () => firebaseInitialized
};
