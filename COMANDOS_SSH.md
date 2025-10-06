# 📋 Comandos SSH - Guía Rápida

## 🔐 Conectar a Hostinger

Reemplaza con tus datos de hPanel → SSH Access:

```bash
ssh -p PUERTO usuario@HOST
```

**Ejemplo:**
```bash
ssh -p 65002 u123456789@srv123.main-hosting.eu
```

---

## ✅ Una vez conectado, ejecuta estos comandos EN ORDEN:

### 1️⃣ Verificar Node.js
```bash
node --version
```

**Respuestas esperadas:**
- ✅ `v18.17.0` o similar → **¡Perfecto! Continúa al paso 2**
- ❌ `command not found` → **Node.js no instalado, ve a "SOLUCIÓN A" abajo**

---

### 2️⃣ Verificar npm
```bash
npm --version
```

**Respuestas esperadas:**
- ✅ `9.6.7` o similar → **¡Perfecto! Continúa al paso 3**
- ❌ `command not found` → **Ve a "SOLUCIÓN A" abajo**

---

### 3️⃣ Navegar a public_html
```bash
cd ~/public_html
pwd
```

Deberías ver algo como: `/home/u123456789/public_html`

---

### 4️⃣ Crear carpeta socket-server
```bash
mkdir socket-server
cd socket-server
pwd
```

Deberías ver: `/home/u123456789/public_html/socket-server`

---

### 5️⃣ Crear archivo server.js

```bash
nano server.js
```

**Ahora en tu computadora:**
1. Abre: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\socket-server\server.js`
2. Selecciona TODO el contenido (Ctrl + A)
3. Copia (Ctrl + C)

**De vuelta en SSH (terminal):**
1. Click derecho en la ventana SSH → **Pegar**
2. Presiona: `Ctrl + O` (guardar)
3. Presiona: `Enter` (confirmar nombre)
4. Presiona: `Ctrl + X` (salir)

---

### 6️⃣ Crear archivo package.json

```bash
nano package.json
```

**En tu computadora:**
1. Abre: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\socket-server\package.json`
2. Copia TODO el contenido

**En SSH:**
1. Pega (click derecho)
2. `Ctrl + O` → `Enter` → `Ctrl + X`

---

### 7️⃣ Crear archivo .env

```bash
nano .env
```

**En tu computadora:**
1. Abre: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\socket-server\.env`
2. Copia TODO el contenido

**En SSH:**
1. Pega (click derecho)
2. `Ctrl + O` → `Enter` → `Ctrl + X`

---

### 8️⃣ Verificar archivos creados
```bash
ls -la
```

Deberías ver:
```
-rw-r--r-- 1 u123456789 u123456789   85 Oct  5 22:50 .env
-rw-r--r-- 1 u123456789 u123456789  450 Oct  5 22:51 package.json
-rw-r--r-- 1 u123456789 u123456789 5120 Oct  5 22:49 server.js
```

---

### 9️⃣ Instalar dependencias
```bash
npm install
```

Deberías ver:
```
added 45 packages, and audited 46 packages in 8s
found 0 vulnerabilities
```

---

### 🔟 Probar servidor (Primera vez)
```bash
node server.js
```

**✅ Si funciona:**
```
╔══════════════════════════════════════════════════════════╗
║   🚀 Socket.IO Server - SYA Tortillerías                ║
╚══════════════════════════════════════════════════════════╝

✅ Servidor corriendo en puerto 3000
🌐 Dominio: syatortillerias.com.mx
```

**Para detener:** `Ctrl + C`

---

### 1️⃣1️⃣ Instalar PM2 (mantener corriendo 24/7)
```bash
npm install -g pm2
```

---

### 1️⃣2️⃣ Iniciar con PM2
```bash
pm2 start server.js --name sya-socketio
```

---

### 1️⃣3️⃣ Guardar configuración
```bash
pm2 save
```

---

### 1️⃣4️⃣ Auto-start al reiniciar servidor
```bash
pm2 startup
```

Copia el comando que te muestra y ejecútalo.

---

### 1️⃣5️⃣ Ver logs en tiempo real
```bash
pm2 logs sya-socketio
```

**Para salir:** `Ctrl + C`

---

### 1️⃣6️⃣ Ver estado
```bash
pm2 status
```

---

## 🆘 SOLUCIÓN A: Node.js no está instalado

### Opción 1: Habilitar desde hPanel (Más rápido)

1. Ve a hPanel → Avanzado → Node.js
2. Habilita versión 18.x o 20.x
3. Guarda y espera 5 minutos
4. Vuelve a intentar `node --version`

### Opción 2: Usar NVM (Node Version Manager)

Si no hay opción en hPanel:

```bash
# Instalar NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Recargar configuración
source ~/.bashrc

# Instalar Node.js 18
nvm install 18

# Usar Node.js 18
nvm use 18

# Verificar
node --version
```

### Opción 3: Contactar soporte de Hostinger

En hPanel → Chat de soporte:
```
Hola, necesito habilitar Node.js versión 18 o superior en mi plan Business
para syatortillerias.com.mx. ¿Pueden activarlo por favor?
```

---

## 📊 Comandos útiles de PM2

```bash
# Ver logs
pm2 logs sya-socketio

# Ver solo últimas 100 líneas
pm2 logs sya-socketio --lines 100

# Reiniciar servidor
pm2 restart sya-socketio

# Detener servidor
pm2 stop sya-socketio

# Eliminar de PM2
pm2 delete sya-socketio

# Ver uso de recursos
pm2 monit

# Ver todos los procesos
pm2 list
```

---

## 🌐 Verificar desde navegador

```
https://socket.syatortillerias.com.mx
```

O si usas puerto directo:
```
https://syatortillerias.com.mx:3000
```

---

## ✅ Checklist final

- [ ] Node.js instalado y funcionando (`node --version`)
- [ ] npm instalado y funcionando (`npm --version`)
- [ ] Archivos creados: server.js, package.json, .env
- [ ] Dependencias instaladas (`npm install`)
- [ ] Servidor probado (`node server.js`)
- [ ] PM2 instalado (`npm install -g pm2`)
- [ ] Servidor corriendo en PM2 (`pm2 status`)
- [ ] Configuración guardada (`pm2 save`)
- [ ] Auto-start configurado (`pm2 startup`)
- [ ] Subdominio configurado en DNS
- [ ] Verificado en navegador

---

**¿Listo para empezar? Conecta por SSH y sigue estos comandos en orden.**
