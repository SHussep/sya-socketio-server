# Configuración de Seguridad

## Variables de Entorno Requeridas

Este proyecto requiere las siguientes variables de entorno configuradas en **Render Dashboard > Environment**:

### 1. DATABASE_URL
**Descripción:** URL de conexión a PostgreSQL
**Formato:** `postgresql://USER:PASSWORD@HOST:PORT/DATABASE`
**Ejemplo:** `postgresql://myuser:securepass@localhost:5432/mydb`

⚠️ **NUNCA** expongas esta URL públicamente. Contiene credenciales de acceso a tu base de datos.

### 2. JWT_SECRET
**Descripción:** Clave secreta para firmar tokens JWT
**Requisitos:** Mínimo 64 caracteres, altamente aleatorio
**Generar:** `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`

⚠️ **NUNCA** uses un valor predecible o por defecto en producción.

### 3. NODE_ENV
**Descripción:** Entorno de ejecución
**Valor:** `production` (en Render)

## Configuración en Render

1. Ve a tu servicio en Render Dashboard
2. Click en "Environment" en el menú lateral
3. Agrega las variables de entorno:
   - `DATABASE_URL`: (copiar desde Render PostgreSQL > Internal Connection String)
   - `JWT_SECRET`: (generar con el comando de arriba)
   - `NODE_ENV`: `production`
4. Click "Save Changes"

## Rotación de Credenciales Comprometidas

Si tus credenciales fueron expuestas públicamente:

### PostgreSQL
1. Ve a Render Dashboard > PostgreSQL Database
2. Click en "Settings" > "Reset Password"
3. Actualiza `DATABASE_URL` en Environment variables

### JWT_SECRET
1. Genera un nuevo secret: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
2. Actualiza `JWT_SECRET` en Render Environment
3. Todos los tokens existentes quedarán invalidados (usuarios deben hacer login nuevamente)

## Mejores Prácticas

✅ **HACER:**
- Usar `.env.example` como plantilla (sin secretos)
- Configurar variables en Render Dashboard
- Rotar secretos periódicamente
- Usar secrets managers en producción (AWS Secrets Manager, HashiCorp Vault)

❌ **NO HACER:**
- Commitear archivos `.env` a Git
- Hardcodear secretos en el código
- Usar valores por defecto en producción
- Compartir credenciales por email/Slack

## Reporte de Vulnerabilidades

Si encuentras una vulnerabilidad de seguridad, por favor repórtala a:
- Email: saul.hussep@gmail.com
- NO abras un issue público en GitHub

## Historial de Incidentes

- **2025-10-07:** `.env` expuesto en GitHub (remediado)
  - Acción: Removido de Git, credenciales rotadas
  - Impacto: DATABASE_URL y JWT_SECRET comprometidos
  - Estado: Resuelto
