# 🚀 Guía de Deployment: Migraciones 050-060

## 📋 Resumen de Cambios

### ✅ Migraciones Creadas (050-060)

| # | Archivo | Descripción | Estado |
|---|---------|-------------|--------|
| 050 | `create_customers_table.sql` | Tabla customers 1:1 con Cliente.cs | ✅ Listo |
| 051 | `create_productos_table.sql` | Tabla productos 1:1 con Producto.cs | ✅ Listo |
| 052 | `add_sync_columns_to_shifts.sql` | Sync columns en shifts | ✅ Listo |
| 053 | `add_sync_columns_to_expenses.sql` | Sync completas en expenses | ✅ Listo |
| 054 | `add_sync_columns_to_employees.sql` | Sync + tracking en employees | ✅ Listo |
| 055 | `fix_ventas_add_missing_sync_columns.sql` | Completar sync en ventas | ✅ Listo |
| 056 | `add_sync_columns_to_cash_management.sql` | Sync en deposits/withdrawals | ✅ Listo |
| 057 | `create_guardian_tables.sql` | Guardian: báscula monitoring | ✅ Listo |
| 058 | `enhance_devices_for_licensing.sql` | Sistema de licencias | ✅ Listo |
| 059 | `enable_row_level_security.sql` | RLS en todas las tablas | ✅ Listo |
| 060 | `fix_sales_references_to_ventas.sql` | ⚠️ **CRÍTICO:** Arregla FK sales→ventas | ✅ Listo |

### ✅ Archivos Modificados

| Archivo | Cambios | Razón |
|---------|---------|-------|
| `database.js` | Comentada tabla `sales` (líneas 257-273) | Evitar conflicto con migration 046 que usa `ventas` |
| `database.js` | Comentada tabla `guardian_events` (líneas 312-331) | Evitar conflicto con migration 057 que usa tablas específicas |

---

## 🔴 Problema Resuelto: Referencias a Tabla 'sales'

### El Problema

```
❌ ERROR al aplicar migraciones:
   - Migration 042 crea repartidor_assignments con FK a sales(id)
   - Migration 046 elimina tabla 'sales' y crea 'ventas'
   - database.js intenta crear tabla 'sales' → CONFLICTO
   - FK constraint violation cuando se intenta usar repartidor_assignments
```

### La Solución (Migration 060)

```sql
-- 1. DROP constraint FK antigua
ALTER TABLE repartidor_assignments DROP CONSTRAINT [sale_id_fkey];

-- 2. Renombrar columna sale_id → venta_id
ALTER TABLE repartidor_assignments RENAME COLUMN sale_id TO venta_id;

-- 3. Crear nueva FK a ventas(id_venta)
ALTER TABLE repartidor_assignments
ADD CONSTRAINT repartidor_assignments_venta_id_fkey
FOREIGN KEY (venta_id) REFERENCES ventas(id_venta) ON DELETE CASCADE;

-- 4. DROP tablas residuales
DROP TABLE IF EXISTS sales CASCADE;
DROP TABLE IF EXISTS sale_items CASCADE;
DROP TABLE IF EXISTS sales_items CASCADE;
```

### Cambios en database.js

```javascript
// ANTES (❌ CONFLICTO):
await client.query(`
    CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        ...
    )
`);

// DESPUÉS (✅ COMENTADO):
// ⚠️ TABLA OBSOLETA: sales → ahora se usa 'ventas' (migration 046)
// Migration 046 renombró 'sales' a 'ventas' con esquema 1:1 con Desktop
/*
await client.query(`
    CREATE TABLE IF NOT EXISTS sales (...)
`);
*/
```

---

## 📦 Archivos Pendientes de Actualizar (DESPUÉS del deployment)

⚠️ **IMPORTANTE:** Estos archivos todavía usan la tabla `sales` antigua y necesitarán actualizarse en la siguiente fase (limpieza del backend):

```
routes/sales.js                    → Actualizar queries: sales → ventas
routes/repartidor_assignments.js   → Actualizar FK: sale_id → venta_id
routes/cash-cuts.js                → Actualizar joins con sales
routes/dashboard.js                → Actualizar estadísticas
routes/admin.js                    → Actualizar queries admin
routes/tenants.js                  → Actualizar queries de tenant
routes/restore.js                  → Actualizar backup/restore
```

**No actualices estos archivos ahora** - hazlo en una fase separada después de verificar que las migraciones funcionaron correctamente.

---

## 🚀 Pasos para Deployment en Render

### 1. Verificar Archivos Modificados

```bash
cd C:\SYA\sya-socketio-server

# Ver archivos modificados
git status

# Deberías ver:
#   modified:   database.js
#   new file:   migrations/050_create_customers_table.sql
#   new file:   migrations/051_create_productos_table.sql
#   new file:   migrations/052_add_sync_columns_to_shifts.sql
#   new file:   migrations/053_add_sync_columns_to_expenses.sql
#   new file:   migrations/054_add_sync_columns_to_employees.sql
#   new file:   migrations/055_fix_ventas_add_missing_sync_columns.sql
#   new file:   migrations/056_add_sync_columns_to_cash_management.sql
#   new file:   migrations/057_create_guardian_tables.sql
#   new file:   migrations/058_enhance_devices_for_licensing.sql
#   new file:   migrations/059_enable_row_level_security.sql
#   new file:   migrations/060_fix_sales_references_to_ventas.sql
#   new file:   MIGRATIONS_050-060_DEPLOYMENT_GUIDE.md
```

### 2. Hacer Commit

```bash
git add migrations/050*.sql
git add migrations/051*.sql
git add migrations/052*.sql
git add migrations/053*.sql
git add migrations/054*.sql
git add migrations/055*.sql
git add migrations/056*.sql
git add migrations/057*.sql
git add migrations/058*.sql
git add migrations/059*.sql
git add migrations/060*.sql
git add database.js
git add MIGRATIONS_050-060_DEPLOYMENT_GUIDE.md

git commit -m "feat: Implementar arquitectura offline-first completa (migrations 050-060)

- ✅ Crear tabla customers (1:1 con Cliente.cs Desktop)
- ✅ Crear tabla productos (1:1 con Producto.cs Desktop)
- ✅ Agregar columnas sync a shifts, expenses, employees
- ✅ Completar columnas offline-first en ventas
- ✅ Agregar sync a deposits/withdrawals
- ✅ Crear tablas Guardian (scale_disconnections, suspicious_weighing_events, scores_daily)
- ✅ Implementar sistema de licencias por dispositivo
- ✅ Habilitar Row-Level Security (RLS) en todas las tablas
- ✅ FIX: Arreglar referencias sales → ventas (migration 060)
- ✅ Comentar creación de tablas obsoletas en database.js (sales, guardian_events)

BREAKING CHANGES:
- repartidor_assignments.sale_id renombrado a venta_id
- FK ahora apunta a ventas(id_venta) en lugar de sales(id)
- Tabla sales eliminada completamente
"
```

### 3. Push a Render

```bash
git push origin main

# O si usas otro branch:
git push origin [nombre-branch]
```

### 4. Monitorear Deployment en Render

1. Ve a tu dashboard de Render: https://dashboard.render.com
2. Selecciona el servicio `sya-socketio-server`
3. Ve a la pestaña "Logs"
4. Observa el deployment en tiempo real

**Busca estas líneas en los logs:**

```
[MIGRATION] Running migration 050_create_customers_table.sql...
[MIGRATION] ✅ Migration 050 completed

[MIGRATION] Running migration 051_create_productos_table.sql...
[MIGRATION] ✅ Migration 051 completed

...

[MIGRATION] Running migration 060_fix_sales_references_to_ventas.sql...
✅ Migration 060 completada:
   - Actualizada FK: repartidor_assignments.venta_id → ventas.id_venta
   - Eliminadas tablas antiguas: sales, sale_items, sales_items
   - Renombrada columna: sale_id → venta_id
[MIGRATION] ✅ Migration 060 completed

[SERVER] ✅ All migrations completed successfully
[SERVER] Server listening on port 3000
```

### 5. Verificar en PostgreSQL (Render Dashboard)

Render te da acceso a una shell de PostgreSQL. Accede y ejecuta:

```sql
-- 1. Verificar que las tablas existen
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Deberías ver:
--   customers
--   productos
--   scale_disconnections
--   suspicious_weighing_events
--   guardian_employee_scores_daily
--   ... y otras

-- 2. Verificar RLS habilitado
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND rowsecurity = true;

-- Deberías ver todas las tablas principales con rowsecurity = true

-- 3. Verificar columnas sync en customers
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'customers'
  AND column_name LIKE '%sync%';

-- Deberías ver:
--   synced          | boolean
--   synced_at       | timestamp with time zone
--   remote_id       | integer

-- 4. Verificar FK actualizada en repartidor_assignments
SELECT
    tc.constraint_name,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.table_name = 'repartidor_assignments'
  AND tc.constraint_type = 'FOREIGN KEY';

-- Deberías ver:
--   repartidor_assignments_venta_id_fkey | venta_id | ventas | id_venta

-- 5. Verificar que tabla sales NO existe
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'sales';

-- Debería retornar 0 rows (tabla eliminada)
```

---

## ✅ Checklist de Verificación Post-Deployment

- [ ] Migraciones 050-060 aplicadas sin errores
- [ ] Tabla `customers` existe con GlobalId UNIQUE
- [ ] Tabla `productos` existe con GlobalId UNIQUE
- [ ] Tablas Guardian existen (scale_disconnections, suspicious_weighing_events, guardian_employee_scores_daily)
- [ ] RLS habilitado en todas las tablas principales
- [ ] FK en repartidor_assignments apunta a ventas.id_venta
- [ ] Tabla `sales` eliminada (no existe)
- [ ] Servidor arrancó sin errores
- [ ] Endpoint `/health` responde 200 OK

**Comando rápido de verificación:**

```bash
# Test health endpoint
curl https://sya-socketio-server.onrender.com/health

# Debería retornar:
# { "status": "ok", "timestamp": "..." }
```

---

## 🔄 Rollback Plan (En caso de emergencia)

Si algo sale mal durante el deployment:

### Opción 1: Rollback en Render Dashboard
1. Ve a Render Dashboard → sya-socketio-server
2. Pestaña "Deploys"
3. Click en "Rollback to previous deploy"

### Opción 2: Rollback via Git
```bash
git revert HEAD
git push origin main
```

### Opción 3: Rollback Manual de Migraciones
```sql
-- SOLO EN CASO DE EMERGENCIA
-- Ejecutar en shell de PostgreSQL de Render

-- Eliminar tablas creadas por migraciones 050-060
DROP TABLE IF EXISTS guardian_employee_scores_daily CASCADE;
DROP TABLE IF EXISTS suspicious_weighing_events CASCADE;
DROP TABLE IF EXISTS scale_disconnections CASCADE;
DROP TABLE IF EXISTS productos CASCADE;
DROP TABLE IF EXISTS customers CASCADE;

-- Revertir cambios en repartidor_assignments
ALTER TABLE repartidor_assignments RENAME COLUMN venta_id TO sale_id;
-- (FK necesitará recreación manual)

-- Deshabilitar RLS
ALTER TABLE ventas DISABLE ROW LEVEL SECURITY;
ALTER TABLE employees DISABLE ROW LEVEL SECURITY;
-- ... etc para todas las tablas
```

---

## 📞 Soporte

Si encuentras errores durante el deployment:

1. **Captura los logs completos** de Render
2. **Ejecuta las queries de verificación** para identificar el problema
3. **No hagas cambios manuales en producción** sin documentarlos
4. **Usa el rollback** si el servidor no arranca

---

## 🎯 Próximos Pasos (DESPUÉS de verificar deployment exitoso)

1. ✅ Verificar que migraciones se aplicaron correctamente
2. 🔄 Actualizar rutas que usan `sales` → `ventas`
3. 🔧 Implementar endpoint `/devices/handshake`
4. 🔧 Implementar endpoint `/sync/batch`
5. 🧪 Testing de sincronización Desktop → PostgreSQL
6. 📱 Implementar endpoints Guardian para app móvil

---

**Documento creado:** 2025-11-07
**Deployment target:** Render PostgreSQL
**Estado:** ✅ Listo para deployment
