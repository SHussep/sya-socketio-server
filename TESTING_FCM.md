# 🧪 Guía de Pruebas - Firebase Cloud Messaging (FCM)

## ¿Cómo verificar que todo funciona?

### Paso 1: Iniciar Backend (Render)
El backend debe estar corriendo en Render. Verifica que:
- Está desplegado: https://sya-socketio-server.onrender.com
- Tiene la variable de entorno `FIREBASE_SERVICE_ACCOUNT` configurada

### Paso 2: Verificar Desktop está conectado a Socket.IO

En tu app Desktop POS:
1. Abre la app
2. **Busca en la pantalla**: Debe decir algo como "✅ Socket.IO Conectado"
3. Si NO ve nada, el Desktop no está conectado

**Dónde está en la app?**
- En `ShellPage.xaml`, agregamos un InfoBar para mostrar notificaciones
- Busca en la parte superior de la pantalla

### Paso 3: Verificar que Mobile está registrado

**En la app Mobile (Flutter):**
1. Instala la app en un dispositivo o emulador
2. Inicia sesión
3. En los logs de la app, busca:
   ```
   [FCM] ✅ Device Token obtenido: ...
   [DeviceRegistration] ✅ Dispositivo registrado
   ```

Si ves esos mensajes, el dispositivo está registrado en el backend.

### Paso 4: Prueba real - Iniciar sesión desde Desktop

**Este es el test real:**

1. **En Desktop POS**:
   - Abre la app
   - Inicia sesión como un usuario (ej: admin)
   - Verifica que se conectó a Socket.IO ✅

2. **En Mobile**:
   - Abre la app Flutter
   - Inicia sesión como DIFERENTE usuario (ej: repartidor)
   - **IMPORTANTE**: Inicia sesión en una sucursal diferente o espera

3. **En Desktop**:
   - Ve a otro usuario y inicia sesión
   - El backend debería enviar notificación FCM

4. **En Mobile**:
   - Si app está ABIERTA: Verás una notificación en la pantalla
   - Si app está CERRADA: Verás la notificación en la bandeja del sistema

### Paso 5: Verificar registros en PostgreSQL

Para confirmar que el dispositivo está registrado:

```bash
psql -U postgres -d sya_tortillerias -c "SELECT id, employee_id, device_token, platform, is_active FROM device_tokens LIMIT 10;"
```

Deberías ver registros como:
```
 id | employee_id |           device_token            | platform | is_active
----+-------------+-----------------------------------+----------+-----------
  1 |       5     | c8n9x8v2k3l...                   | android  | t
  2 |       6     | a1b2c3d4e5f...                   | ios      | t
```

---

## 🔍 Troubleshooting

### Problema: "Device Token no obtenido"
**Solución:**
- Verifica que el dispositivo permite notificaciones
- En Android: Settings → Apps → App Permissions → Notifications → Allow
- En iOS: Settings → Notifications → Enable Notifications

### Problema: "No hay dispositivos activos en la sucursal"
**Solución:**
- Verifica que el employee_id en device_tokens es correcto
- Verifica que branch_id es correcto
- Ejecuta: `SELECT * FROM device_tokens WHERE is_active = true;`

### Problema: Notificación no llega
**Verificar:**
1. Backend tiene `FIREBASE_SERVICE_ACCOUNT` en variables de entorno
2. `google-services.json` está en `android/app/`
3. `GoogleService-Info.plist` está en `ios/Runner/`
4. Permisos de notificación otorgados en dispositivo

### Problema: "Notificación de prueba no se envió"
**Solución:**
- El backend debe estar corriendo
- Ejecuta: `node test_fcm.js`
- Si falla, verifica que el backend está en `http://localhost:3000`

---

## 📊 Checklist Final

- [ ] Backend corriendo en Render (https://sya-socketio-server.onrender.com)
- [ ] Firebase `FIREBASE_SERVICE_ACCOUNT` variable agregada en Render
- [ ] Desktop conectado a Socket.IO (muestra "✅ Conectado")
- [ ] Mobile instalado con `google-services.json`
- [ ] Mobile instalado con `GoogleService-Info.plist`
- [ ] Mobile muestra "Device Token obtenido"
- [ ] Mobile muestra "Dispositivo registrado"
- [ ] PostgreSQL tiene registros en tabla `device_tokens`
- [ ] Prueba: Desktop inicia sesión → Mobile recibe notificación

---

## 🚀 Cuando todo funciona

Debería ver algo así:

**En Desktop:**
```
[Socket.IO] ✅ Conectado al servidor
[Socket.IO] 📥 Evento user-login recibido
[Socket.IO] Usuario Juan Martinez inicio sesion en Sucursal Centro
```

**En Mobile (abierta):**
```
[FCM] ✅ Device Token obtenido: c8n9x8v2k3l...
[DeviceRegistration] ✅ Dispositivo registrado: Employee 5, Branch 1
[FCM] 📨 Notificación en foreground recibida
   Título: 👤 Acceso de Usuario
   Cuerpo: Juan Martinez inició sesión en Sucursal Centro
```

**En Mobile (cerrada):**
- Notificación aparece en la bandeja del sistema (Android)
- Notificación aparece en la pantalla de bloqueo (iOS)

---

¿Necesitas ayuda con alguno de estos pasos?
