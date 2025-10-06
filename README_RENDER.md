# 🚀 Deployment en Render.com - Socket.IO Server

## Opción 1: Deploy desde Render Dashboard (Más fácil)

### Paso 1: Crear Web Service
1. En Render Dashboard: https://dashboard.render.com
2. Click **"New +"** → **"Web Service"**

### Paso 2: Conectar repositorio
Selecciona una de estas opciones:

#### Opción A: Public Git Repository
- Click **"Public Git repository"**
- Pega la URL de tu repo (si lo subes a GitHub)

#### Opción B: Deploy sin Git (Manual)
- No hay opción directa, necesitas GitHub

### Paso 3: Configurar el servicio
- **Name:** `sya-socketio`
- **Region:** Oregon (US West) o la más cercana
- **Branch:** `main`
- **Root Directory:** (dejar vacío o poner `socket-server` si está en subcarpeta)
- **Runtime:** Node
- **Build Command:** `npm install`
- **Start Command:** `node server.js`

### Paso 4: Plan
- Selecciona **Free**

### Paso 5: Variables de entorno
Click **"Add Environment Variable"**:
- `NODE_ENV` = `production`
- `PORT` = `10000` (Render asigna automáticamente, pero por si acaso)

### Paso 6: Deploy
- Click **"Create Web Service"**
- Espera 2-5 minutos mientras despliega

---

## Opción 2: Deploy Manual (Sin GitHub)

Si no quieres usar GitHub, puedes usar Render Shell:

1. Después de crear el servicio, ve a **Shell**
2. Sube archivos manualmente

**Pero es más complicado. Recomiendo usar GitHub.**

---

## 📁 Archivos necesarios para Render:

En tu carpeta del proyecto necesitas:
- ✅ `server.js`
- ✅ `package.json`
- ✅ `.env` (opcional, mejor usar Environment Variables)
- ✅ `render.yaml` (opcional, para auto-config)

---

## 🌐 URL Pública

Una vez desplegado, Render te dará una URL como:
```
https://sya-socketio.onrender.com
```

Usa esa URL en tu `appsettings.json`:
```json
"SocketIOUrl": "https://sya-socketio.onrender.com"
```

---

## ⚠️ Plan Gratuito - Limitaciones

- ✅ 750 horas/mes gratis
- ⚠️ Se "duerme" después de 15 min de inactividad
- ⚠️ Tarda 30-60 seg en "despertar" en la primera conexión
- ⚠️ 512 MB RAM

**Para producción seria:** Upgrade a plan Starter ($7/mes) - sin sleep, más recursos

---

## ✅ Verificar deployment

1. Abre la URL de Render en navegador
2. Deberías ver: `Socket.IO Server for SYA Tortillerías - Running ✅`
3. Prueba tu app Desktop

---

## 🔄 Actualizar código

Cada vez que hagas cambios:
1. Push a GitHub
2. Render auto-despliega (o click "Manual Deploy")

---

## 📊 Monitoreo

En Render Dashboard puedes ver:
- Logs en tiempo real
- Uso de CPU/RAM
- Eventos de deploy
