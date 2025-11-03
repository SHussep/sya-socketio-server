# Guía de Verificación - Migración 037 (Roles Globales)

## Estado Actual

✅ **COMPLETADO:**
- ✅ Migración 037 ha sido reemplazada con nueva estructura
- ✅ Cambios pusheados a GitHub (commit b9135bb)
- ✅ Render ha completado el despliegue
- ✅ El endpoint `/api/employees` está activo

## Próximos Pasos - Verificar la Migración

### Opción 1: Verificación Automática con Script

```bash
# 1. Obtén la DATABASE_URL del Render (dashboard → Environment Variables)

# 2. Copia la DATABASE_URL completa

# 3. Ejecuta:
DATABASE_URL="postgresql://user:password@host:port/dbname" \
  node check_roles_migration.js
```

### Opción 2: Verificación Manual con psql

```bash
# Conecta a la base de datos de Render:
psql "postgresql://user:password@host:port/dbname"

# Luego ejecuta estos comandos:

-- Ver estructura de la tabla
\d roles

-- Ver todos los roles
SELECT id, name, description FROM roles ORDER BY id;

-- Verificar que NO hay tenant_id ni branch_id
SELECT column_name FROM information_schema.columns
WHERE table_name = 'roles'
ORDER BY ordinal_position;
```

### Opción 3: Verificación desde Hpanel

Si tienes acceso a Hpanel (donde está la BD en localhost):

```bash
# Si PostgreSQL está corriendo localmente:
DATABASE_URL="postgresql://localhost:5432/sya_tortillerias_server" \
  node check_roles_migration.js
```

## Qué Debería Ver Si la Migración Fue Exitosa

```
1️⃣  ESTRUCTURA DE LA TABLA "roles":
─────────────────────────────────────────────────────────────
   id                   | integer              | nullable: NO
   name                 | character varying    | nullable: NO
   description          | text                 | nullable: YES
   created_at           | timestamp with tz    | nullable: YES
   updated_at           | timestamp with tz    | nullable: YES

✅ Estructura correcta: Sin tenant_id ni branch_id

2️⃣  DATOS DE ROLES:
─────────────────────────────────────────────────────────────
   Total de roles: 5

   ID 1  | Administrador       | Acceso total al sistema
   ID 2  | Encargado           | Gerente de turno - permisos extensos
   ID 3  | Repartidor          | Acceso limitado como repartidor
   ID 4  | Ayudante            | Soporte - acceso limitado
   ID 99 | Otro                | Rol genérico para roles personalizados desde Desktop

✅ Cantidad correcta: 5 roles

4️⃣  VERIFICACIÓN DE CLAVE PRIMARIA:
─────────────────────────────────────────────────────────────
   ✅ Sin secuencias SERIAL (usando IDs fijos como se espera)

═══════════════════════════════════════════════════════════════
✅ ÉXITO: ¡La migración 037 se aplicó correctamente!
   La tabla roles es ahora GLOBAL con IDs fijos (1, 2, 3, 4, 99)
═══════════════════════════════════════════════════════════════
```

## Qué Cambió en la Migración 037

### ❌ ANTES (Incorrecto):
- Tabla `roles` con `tenant_id` y `branch_id` (scoped por tenant)
- IDs auto-incrementales con SERIAL
- Solo 2 roles: "Acceso Total" (ID 14) y "Acceso Repartidor" (ID 15)
- Los IDs no coincidían con Desktop (Desktop envía 1-4)

### ✅ AHORA (Correcto):
- Tabla `roles` GLOBAL sin `tenant_id` ni `branch_id`
- IDs FIJOS: 1, 2, 3, 4, 99 (no auto-incrementales)
- 5 roles: Administrador, Encargado, Repartidor, Ayudante, Otro
- Los IDs coinciden exactamente con Desktop
- Rol 99 "Otro" para roles personalizados creados en Desktop

## Cómo Afecta Esto al Sincronización

### Sincronización de Empleados:

```javascript
// Desktop envía:
{
  tenantId: 1,
  branchId: 1,
  roleId: 1,           // ← Ahora coincide con ID 1 en PostgreSQL
  canUseMobileApp: true,
  email: "...",
  password: "..."
}

// PostgreSQL busca:
SELECT * FROM roles WHERE id = 1  // ← ¡ENCUENTRA! (Administrador)
```

### Roles Personalizados de Desktop:

```javascript
// Si Desktop crea un rol personalizado con ID 50:
{
  tenantId: 1,
  roleId: 50,           // ← NO existe en PostgreSQL (es custom)
  canUseMobileApp: true
}

// El servidor mapea automáticamente:
mappedRoleId = 50 > 4 ? 99 : 50  // → ID 99 (Otro)

// PostgreSQL busca:
SELECT * FROM roles WHERE id = 99  // ← ¡ENCUENTRA! (Otro)
```

## Siguientes Pasos Después de Verificar

1. **Agregar un empleado nuevo en Desktop** con roleId 1, 2, 3, o 4
2. **Revisar los logs** en Visual Studio Output para ver:
   ```
   [Employees/Sync] ✅ Empleado sincronizado correctamente
   ```
3. **Verificar en PostgreSQL** que el empleado tiene el `role_id` correcto
4. **Probar con rol personalizado** (si existe en Desktop):
   - Crear un empleado con rol personalizado (ID > 4)
   - Verificar que se mapea a ID 99 ("Otro")

## Archivos de Referencia

- **Migración:** `migrations/037_create_roles_and_permissions_system.sql`
- **Endpoint de sync:** `routes/employees.js:396-402` (POST /:id/sync-role)
- **Lógica de mapeo:** `routes/employees.js:40-61` (Role ID mapping)
- **Servicio Desktop:** `SyaTortilleriasWinUi/Services/UnifiedSyncService.cs:1317-1336`

## Contacto

Si hay problemas durante la verificación:
- Revisa que el DATABASE_URL sea correcto
- Verifica que la BD de Render esté accesible
- Comprueba los logs de Render en el dashboard
