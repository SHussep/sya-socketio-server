# 🚀 Socket.IO Server - SYA Tortillerías

## 📦 Archivos en esta carpeta

- `server.js` - Servidor Socket.IO principal
- `package.json` - Dependencias de Node.js
- `.env` - Configuración del entorno

## 🔧 Instalación en Hostinger

### Paso 1: Subir archivos a Hostinger

**Opción A: FileZilla (FTP)**
1. Conecta a `ftp.syatortillerias.com.mx`
2. Usuario: tu usuario de Hostinger
3. Contraseña: tu contraseña de Hostinger
4. Navega a: `/public_html/`
5. Crea carpeta: `socket-server`
6. Sube estos 3 archivos:
   - `server.js`
   - `package.json`
   - `.env`

**Opción B: SSH (Recomendado)**
```bash
# Conectar vía SSH
ssh usuario@syatortillerias.com.mx

# Navegar a public_html
cd public_html

# Crear carpeta
mkdir socket-server
cd socket-server

# Ahora sube los archivos con SFTP o usa git
```

### Paso 2: Instalar dependencias

Conéctate por SSH y ejecuta:

```bash
cd ~/public_html/socket-server
npm install
```

### Paso 3: Probar que funciona

```bash
node server.js
```

Deberías ver:
```
╔══════════════════════════════════════════════════════════╗
║   🚀 Socket.IO Server - SYA Tortillerías                ║
╚══════════════════════════════════════════════════════════╝

✅ Servidor corriendo en puerto 3000
🌐 Dominio: syatortillerias.com.mx
📅 Iniciado: ...
```

### Paso 4: Mantener corriendo 24/7 con PM2

```bash
# Instalar PM2 (solo la primera vez)
npm install -g pm2

# Iniciar el servidor
pm2 start server.js --name sya-socketio

# Guardar configuración
pm2 save

# Auto-iniciar al reiniciar servidor
pm2 startup
```

### Paso 5: Configurar subdominio en Hostinger

1. Ve a **hPanel → Dominios**
2. Selecciona `syatortillerias.com.mx`
3. Ve a **DNS Records**
4. Agrega registro tipo **A**:
   - Nombre: `socket`
   - Apunta a: Tu IP del servidor
   - TTL: 14400

5. Configura **Reverse Proxy** en hPanel:
   - Dominio: `socket.syatortillerias.com.mx`
   - Destino: `localhost:3000`

## 📊 Monitoreo

### Ver logs en tiempo real
```bash
pm2 logs sya-socketio
```

### Ver estado
```bash
pm2 status
```

### Reiniciar servidor
```bash
pm2 restart sya-socketio
```

### Detener servidor
```bash
pm2 stop sya-socketio
```

## ✅ Verificar que funciona

Abre en el navegador:
```
https://socket.syatortillerias.com.mx
```

Deberías ver:
```
Socket.IO Server for SYA Tortillerías - Running ✅
```

## 🔍 Troubleshooting

**Error: Puerto 3000 no accesible**
- Configura reverse proxy en Hostinger
- Usa subdomain `socket.syatortillerias.com.mx`

**Error: npm no encontrado**
- Tu plan de Hostinger debe ser Business o superior
- Verifica que Node.js esté habilitado en hPanel

**Error: Cannot find module 'socket.io'**
- Ejecuta `npm install` primero

**Error: Permission denied**
- Usa `sudo` si es necesario
- Verifica permisos de carpeta
