# 🚀 INICIO RÁPIDO - Socket.IO en Hostinger

## 📋 Resumen de lo que tienes:

✅ **Archivos listos en:** `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\socket-server\`
- ✅ `server.js` - Servidor Socket.IO
- ✅ `package.json` - Dependencias
- ✅ `.env` - Configuración
- ✅ `README.md` - Documentación completa
- ✅ `PASOS_INSTALACION.md` - Guía detallada
- ✅ `COMANDOS_SSH.md` - Comandos listos para copiar/pegar

✅ **App Desktop actualizada:**
- ✅ URL configurada: `https://socket.syatortillerias.com.mx`
- ✅ Sin reconexiones infinitas
- ✅ Funciona sin backend (modo local)

✅ **Dominio:**
- ✅ `syatortillerias.com.mx` activo en Hostinger
- ✅ Plan Business confirmado
- ✅ SSH disponible

---

## 🎯 TUS PRÓXIMOS PASOS (En orden):

### 📍 AHORA MISMO (5 minutos):

1. **Ir a hPanel de Hostinger:**
   - URL: https://hpanel.hostinger.com
   - Selecciona: `syatortillerias.com.mx`

2. **Verificar Node.js:**
   - Busca: **Avanzado → Node.js**
   - Si existe: Habilita versión **18.x**
   - Si NO existe: Anótalo (lo haremos por SSH)

3. **Obtener credenciales SSH:**
   - Ve a: **Avanzado → SSH Access**
   - Anota:
     ```
     Host: ___________________
     Puerto: _________________
     Usuario: ________________
     ```
   - Si no tienes contraseña SSH, créala ahí mismo

---

### 📍 DESPUÉS (10-15 minutos):

4. **Conectar por SSH:**

   **Opción A: PowerShell (Windows)**
   ```powershell
   # Presiona: Win + X → PowerShell
   ssh -p TU_PUERTO tu_usuario@tu_host
   ```

   **Opción B: PuTTY**
   - Descarga: https://www.putty.org/
   - Ingresa host, puerto, usuario
   - Click "Open"

5. **Ejecutar comandos del archivo:**
   - Abre: `COMANDOS_SSH.md`
   - Copia y pega cada comando EN ORDEN
   - Sigue las instrucciones exactas

6. **Verificar que funciona:**
   - En navegador: `https://socket.syatortillerias.com.mx`
   - Debería mostrar: "Socket.IO Server for SYA Tortillerías - Running ✅"

---

### 📍 FINALMENTE (5 minutos):

7. **Probar desde tu app Desktop:**
   - Abre tu app de Windows
   - Busca en Debug Output: `[APP] ✅ Socket.IO conectado`

8. **Enviar info a programador Flutter:**
   - Archivo: `BACKEND_SOCKETIO_HOSTINGER_GUIDE.md`
   - Mensaje:
     ```
     Hola, el servidor Socket.IO está listo.

     URL: https://socket.syatortillerias.com.mx

     Adjunto la documentación con todo lo que necesitas
     para implementar la conexión en Flutter.

     Revisa la sección "📱 Guía para el Programador Flutter"
     ```

---

## ⏱️ Tiempo estimado total: **20-30 minutos**

---

## 🆘 Si tienes problemas:

### ❌ "No encuentro Node.js en hPanel"
→ No hay problema, lo instalaremos por SSH con NVM (está en COMANDOS_SSH.md)

### ❌ "No puedo conectar por SSH"
→ Verifica:
- Puerto correcto (65002 es común en Hostinger)
- Contraseña SSH creada en hPanel
- Firewall de Windows no bloquea SSH

### ❌ "node: command not found"
→ Ejecuta los comandos de "SOLUCIÓN A" en COMANDOS_SSH.md

### ❌ "npm install falla"
→ Intenta: `npm install --legacy-peer-deps`

### ❌ "PM2 no se instala globalmente"
→ Intenta: `npm install pm2` (local, sin -g)
→ Luego usa: `npx pm2 start server.js --name sya-socketio`

### ❌ "Puerto 3000 bloqueado"
→ Contacta soporte Hostinger: "Necesito abrir puerto 3000 para WebSocket/Socket.IO"

---

## 📁 Archivos que debes consultar:

| Archivo | Cuándo usarlo |
|---------|--------------|
| `INICIO_RAPIDO.md` (este) | Para saber qué hacer ahora |
| `PASOS_INSTALACION.md` | Guía paso a paso detallada |
| `COMANDOS_SSH.md` | Comandos exactos para copiar/pegar |
| `README.md` | Referencia general |
| `BACKEND_SOCKETIO_HOSTINGER_GUIDE.md` | Para tu programador Flutter |

---

## ✅ Checklist visual:

```
PREPARACIÓN:
 ☑ Archivos del servidor creados
 ☑ App Desktop actualizada
 ☑ Dominio verificado
 ☑ Plan Hostinger verificado (Business)
 ☑ SSH disponible

POR HACER:
 ☐ 1. Entrar a hPanel
 ☐ 2. Verificar/habilitar Node.js
 ☐ 3. Obtener credenciales SSH
 ☐ 4. Conectar por SSH
 ☐ 5. Crear carpeta socket-server
 ☐ 6. Copiar archivos (server.js, package.json, .env)
 ☐ 7. Ejecutar npm install
 ☐ 8. Probar con node server.js
 ☐ 9. Instalar PM2
 ☐ 10. Iniciar con PM2
 ☐ 11. Configurar subdominio en DNS
 ☐ 12. Verificar en navegador
 ☐ 13. Probar desde app Desktop
 ☐ 14. Enviar docs a programador Flutter
```

---

## 🎯 TU SIGUIENTE ACCIÓN:

**Abre hPanel ahora:**
```
https://hpanel.hostinger.com
```

Y anota en un papel:
1. ¿Tienes Node.js habilitado? (Sí / No)
2. Host SSH: __________
3. Puerto SSH: __________
4. Usuario SSH: __________
5. ¿Contraseña SSH lista? (Sí / No)

**Una vez que tengas esto, abre `COMANDOS_SSH.md` y sigue los pasos.**

---

¡Éxito! 🚀
