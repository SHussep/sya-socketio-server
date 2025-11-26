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
 * Envía notificación FCM a un dispositivo específico
 */
async function sendNotificationToDevice(deviceToken, {
    title = 'SYA Notificación',
    body = '',
    data = {}
} = {}) {
    if (!firebaseInitialized || !admin.apps.length) {
        console.warn('⚠️ Firebase not initialized, cannot send notification');
        return null;
    }

    try {
        const message = {
            notification: {
                title,
                body
            },
            data,
            token: deviceToken,
            // Configuraciones específicas
            android: {
                priority: 'high',
                ttl: 3600 // 1 hora
            },
            apns: {
                headers: {
                    'apns-priority': '10'
                },
                payload: {
                    aps: {
                        alert: {
                            title: title,
                            body: body
                        },
                        sound: 'default',
                        badge: 1
                    }
                }
            }
        };

        const response = await admin.messaging().send(message);
        console.log(`[FCM] ✅ Notificación enviada a dispositivo: ${response}`);
        return response;
    } catch (error) {
        console.error(`[FCM] ❌ Error enviando notificación: ${error.message}`);
        // Si el token es inválido, debería ser removido
        if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered' ||
            error.code === 'messaging/third-party-auth-error' ||
            error.message?.includes('Requested entity was not found')) {
            console.warn(`[FCM] ⚠️ Token inválido, debería ser removido de BD (${error.code})`);
            return 'INVALID_TOKEN';
        }
        return null;
    }
}

/**
 * Envía notificación a múltiples dispositivos
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
