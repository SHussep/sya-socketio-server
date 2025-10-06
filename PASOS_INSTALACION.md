# 📝 Pasos de Instalación - Socket.IO en Hostinger

## ✅ Tu situación actual:
- ✅ Plan: Business
- ✅ Acceso SSH: Sí
- ⏳ Node.js: Por verificar

---

## 🔐 PASO 1: Conectar por SSH

### Obtén tus credenciales SSH:

1. Ve a **hPanel** → https://hpanel.hostinger.com
2. Selecciona tu sitio: **syatortillerias.com.mx**
3. Ve a **Avanzado → SSH Access**
4. Copia:
   - **Host/IP:** (algo como `srv123.main-hosting.eu`)
   - **Puerto:** (normalmente `65002` o `22`)
   - **Usuario SSH:** (tu usuario)
   - **Contraseña:** (tu contraseña de Hostinger o crea una nueva)

### Conéctate desde Windows:

**Opción A: PowerShell (Windows 10/11)**
```powershell
ssh -p PUERTO usuario@HOST
```
Ejemplo:
```powershell
ssh -p 65002 u123456789@srv123.main-hosting.eu
```

**Opción B: Usar PuTTY**
- Descarga: https://www.putty.org/
- Host: `srv123.main-hosting.eu`
- Puerto: `65002`
- Tipo: SSH
- Click "Open"

---

## 🔍 PASO 2: Verificar Node.js

Una vez conectado por SSH, ejecuta:

```bash
node --version
```

### ✅ Si responde algo como: `v18.17.0` o `v20.x.x`
**¡Perfecto! Tienes Node.js instalado.**

Continúa con el **PASO 3**.

### ❌ Si responde: `command not found` o `-bash: node: command not found`

**Node.js NO está instalado. Necesitas habilitarlo:**

#### Opción A: Habilitar desde hPanel (Recomendado)
1. Ve a **hPanel → Hosting → Avanzado**
2. Busca **"Node.js"** o **"Select PHP Version"** → Puede haber una pestaña para Node.js
3. Habilita Node.js versión **18.x** o **20.x**
4. Guarda cambios
5. Espera 5 minutos y vuelve a intentar `node --version`

#### Opción B: Contactar a soporte de Hostinger
Si no encuentras la opción:
1. Abre chat de soporte en hPanel
2. Escribe: *"Necesito habilitar Node.js 18 para mi plan Business"*
3. Ellos lo activarán en minutos

---

## 📦 PASO 3: Subir archivos del servidor

### Opción A: FileZilla (FTP/SFTP)

1. **Descargar FileZilla:** https://filezilla-project.org/download.php?type=client

2. **Conectar:**
   - Host: `sftp://srv123.main-hosting.eu` (tu servidor)
   - Usuario: tu usuario SSH
   - Contraseña: tu contraseña SSH
   - Puerto: 65002 (o el que tengas)

3. **Subir archivos:**
   - Panel izquierdo: Navega a `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\socket-server\`
   - Panel derecho: Navega a `/home/usuario/public_html/`
   - Crea carpeta: `socket-server`
   - Arrastra estos archivos al servidor:
     - `server.js`
     - `package.json`
     - `.env`

### Opción B: Copiar y pegar por SSH (Más rápido)

1. **Crear carpeta en el servidor:**
```bash
cd ~/public_html
mkdir socket-server
cd socket-server
```

2. **Crear archivo server.js:**
```bash
nano server.js
```
- Pega el contenido completo del archivo `server.js`
- Guarda: `Ctrl + O` → `Enter`
- Salir: `Ctrl + X`

3. **Crear archivo package.json:**
```bash
nano package.json
```
- Pega el contenido completo del archivo `package.json`
- Guarda: `Ctrl + O` → `Enter`
- Salir: `Ctrl + X`

4. **Crear archivo .env:**
```bash
nano .env
```
- Pega el contenido completo del archivo `.env`
- Guarda: `Ctrl + O` → `Enter`
- Salir: `Ctrl + X`

---

## 🚀 PASO 4: Instalar dependencias

En la carpeta `socket-server`, ejecuta:

```bash
npm install
```

Deberías ver algo como:
```
added 45 packages, and audited 46 packages in 8s
found 0 vulnerabilities
```

---

## 🎯 PASO 5: Probar el servidor (Primera vez)

```bash
node server.js
```

**✅ Si funciona, verás:**
```
╔══════════════════════════════════════════════════════════╗
║   🚀 Socket.IO Server - SYA Tortillerías                ║
╚══════════════════════════════════════════════════════════╝

✅ Servidor corriendo en puerto 3000
🌐 Dominio: syatortillerias.com.mx
📅 Iniciado: 05/10/2025 22:45:30
```

**Para detenerlo:** Presiona `Ctrl + C`

---

## 🔄 PASO 6: Mantener corriendo 24/7 con PM2

### Instalar PM2:
```bash
npm install -g pm2
```

### Iniciar el servidor:
```bash
pm2 start server.js --name sya-socketio
```

### Guardar configuración:
```bash
pm2 save
```

### Auto-iniciar al reiniciar servidor:
```bash
pm2 startup
```
(Copia y ejecuta el comando que te muestra)

### Ver logs en tiempo real:
```bash
pm2 logs sya-socketio
```

### Ver estado:
```bash
pm2 status
```

---

## 🌐 PASO 7: Configurar subdominio socket.syatortillerias.com.mx

### En hPanel de Hostinger:

1. **Ir a DNS/Nameservers:**
   - hPanel → Dominios → syatortillerias.com.mx → DNS / Nameservers

2. **Agregar registro DNS:**
   - Tipo: **A**
   - Nombre: **socket**
   - Apunta a: **IP de tu servidor** (la misma que syatortillerias.com.mx)
   - TTL: 14400

3. **Configurar Application/Reverse Proxy** (si está disponible):
   - Ve a: Avanzado → Applications
   - Si ves opción para "Node.js Application":
     - Domain: `socket.syatortillerias.com.mx`
     - Application root: `/home/usuario/public_html/socket-server`
     - Application startup file: `server.js`
     - Port: 3000

### Si NO hay opción de Application:

Necesitarás usar el servidor en el puerto directo o configurar un proxy manual con .htaccess.

**Alternativa:** Usar puerto 3000 directamente:
```
https://syatortillerias.com.mx:3000
```

Y actualizar en `appsettings.json`:
```json
"SocketIOUrl": "https://syatortillerias.com.mx:3000"
```

---

## ✅ PASO 8: Verificar que funciona

### Desde el navegador:
```
https://socket.syatortillerias.com.mx
```

O si usas puerto directo:
```
https://syatortillerias.com.mx:3000
```

Deberías ver:
```
Socket.IO Server for SYA Tortillerías - Running ✅
```

### Desde tu app Desktop:
1. Abre la app
2. Ve a Debug Output
3. Busca: `[APP] ✅ Socket.IO conectado`

---

## 🆘 PROBLEMAS COMUNES

### ❌ Error: "npm: command not found"
- Node.js no está instalado
- Vuelve al **PASO 2** y habilítalo desde hPanel

### ❌ Error: "EACCES: permission denied"
```bash
chmod -R 755 ~/public_html/socket-server
```

### ❌ Error: "Port 3000 already in use"
Otro proceso está usando el puerto 3000:
```bash
# Ver qué está usando el puerto
lsof -i :3000

# Matar el proceso (si es necesario)
pm2 delete all
```

### ❌ Error: "Cannot access subdomain"
- El DNS tarda hasta 24h en propagarse (normalmente 1-2 horas)
- Mientras tanto usa: `https://syatortillerias.com.mx:3000`

### ❌ Error: Firewall bloquea puerto 3000
Contacta a soporte de Hostinger:
*"Necesito abrir el puerto 3000 para Socket.IO en mi plan Business"*

---

## 📞 Siguiente paso después de instalar:

**Una vez que el servidor esté corriendo:**
1. Envía este mensaje a tu programador Flutter:

```
Servidor Socket.IO listo:
- URL: https://socket.syatortillerias.com.mx (o :3000)
- Documentación: BACKEND_SOCKETIO_HOSTINGER_GUIDE.md
- Eventos disponibles: scale_alert, sale_completed, scale_connected, scale_disconnected

Revisa la sección "📱 Guía para el Programador Flutter" en la documentación.
```

2. Prueba tu app Desktop - debería conectarse automáticamente

---

**¿En qué paso estás actualmente?**
