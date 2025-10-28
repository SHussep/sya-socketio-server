# Migración 004: Local Shift ID para Offline-First Sync

## 📋 Descripción

Esta migración agrega soporte para **offline-first synchronization** mediante el seguimiento de `local_shift_id` en PostgreSQL.

### ¿Por qué es importante?

Cuando un usuario:
1. Abre un turno (shift) en Desktop
2. Pierde internet
3. Cierra el turno localmente
4. Intenta abrir un nuevo turno

**Sin esta migración**: El sistema se bloquea porque PostgreSQL no sabe que el turno anterior fue cerrado offline.

**Con esta migración**: PostgreSQL reconoce el nuevo turno por su `local_shift_id` diferente y auto-cierra el turno anterior.

---

## 🔧 Instalación

### Opción 1: Script automático (RECOMENDADO)

```bash
# Desde la raíz del proyecto
node apply_004_local_shift_id_migration.js
```

Este script:
- ✅ Lee el archivo de migración SQL
- ✅ Lo ejecuta en PostgreSQL
- ✅ Verifica que las columnas se crearon correctamente
- ✅ Verifica que los índices se crearon

### Opción 2: SQL manual (Para administrador de BD)

Si necesitas ejecutar SQL directamente:

```bash
# Conectar a PostgreSQL
psql -h <host> -U <user> -d <database>

# Ejecutar migración
\i migrations/004_add_local_shift_id.sql
```

---

## 📊 Cambios de Base de Datos

Se agregan columnas `local_shift_id` a las siguientes tablas:

| Tabla | Columna | Tipo | Restricción |
|-------|---------|------|------------|
| `shifts` | `local_shift_id` | INT | UNIQUE |
| `sales` | `local_shift_id` | INT | - |
| `expenses` | `local_shift_id` | INT | - |
| `deposits` | `local_shift_id` | INT | - |
| `withdrawals` | `local_shift_id` | INT | - |

Se crean los siguientes índices para optimizar búsquedas:
- `idx_shifts_local_shift_id` (shifts)
- `idx_shifts_employee_open` (shifts, para empleados con turno abierto)
- `idx_sales_local_shift_id` (sales)
- `idx_expenses_local_shift_id` (expenses)

---

## 🔄 Cómo Funciona el Sistema

### Flujo Normal (Con Internet)
```
Desktop abre turno
    ↓
Envía localShiftId=1 a PostgreSQL
    ↓
PostgreSQL almacena turno con local_shift_id=1
    ↓
Desktop hace venta → envía localShiftId=1
    ↓
PostgreSQL almacena venta con local_shift_id=1
    ↓
Desktop cierra turno → sincroniza con PostgreSQL
```

### Flujo Offline (Sin Internet)
```
Desktop abre turno (localShiftId=1)
    ↓
❌ Internet se corta
    ↓
Desktop cierra turno localmente (sin sincronizar)
    ↓
Desktop abre nuevo turno (localShiftId=2)
    ↓
✅ Internet regresa
    ↓
Desktop sincroniza nuevo turno con localShiftId=2
    ↓
PostgreSQL detecta:
  - Turno antiguo tiene local_shift_id=1 (abierto)
  - Nuevo turno tiene local_shift_id=2
    ↓
Auto-cierra turno con local_shift_id=1
    ↓
Crea nuevo turno con local_shift_id=2
    ↓
Todas las transacciones se reconcilian correctamente
```

---

## 🚀 Después de Aplicar la Migración

### Paso 1: Verificar que funcionó

```bash
# En PostgreSQL, debería ver:
SELECT column_name FROM information_schema.columns
WHERE table_name = 'shifts' AND column_name = 'local_shift_id';

# Debería retornar: local_shift_id
```

### Paso 2: Hacer deploy

El código ya está actualizado:
- ✅ Backend API acepta `localShiftId` en todos los endpoints
- ✅ Desktop app envía `localShiftId` en todos los payloads
- ✅ Endpoints de shift open implementan smart UPSERT

**Solo necesita hacer deploy normal de sya-socketio-server a Render.**

### Paso 3: Probar Offline

1. **Abrir turno** (debe sincronizar sin error)
2. **Simular offline**: Desconectar internet o usar DevTools
3. **Cerrar turno** localmente
4. **Abrir nuevo turno** (debería funcionar sin bloqueos)
5. **Reconectar internet**: Todas las transacciones deberían sincronizar

---

## 🔍 Verificación Post-Migración

### En PostgreSQL

```sql
-- Ver todas las columnas de shifts con local_shift_id
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'shifts'
ORDER BY ordinal_position;

-- Ver índices creados
SELECT indexname FROM pg_indexes
WHERE tablename IN ('shifts', 'sales', 'expenses', 'deposits', 'withdrawals')
AND indexname LIKE '%local_shift%';

-- Verificar integridad
SELECT COUNT(*) as total_shifts FROM shifts;
SELECT COUNT(*) as total_sales FROM sales;
SELECT COUNT(*) as total_expenses FROM expenses;
```

### En Desktop App

El app debería:
1. ✅ Enviar `localShiftId` al abrir turno
2. ✅ Incluir `localShiftId` en todos los sync payloads
3. ✅ Trabajar sin errores en modo offline

---

## 📝 Archivos Modificados

### Backend (sya-socketio-server)

```
migrations/004_add_local_shift_id.sql     ← SQL de migración
apply_004_local_shift_id_migration.js     ← Script para aplicar
routes/shifts.js                          ← Smart UPSERT en /api/shifts/sync/open
routes/deposits.js                        ← Acepta localShiftId
routes/withdrawals.js                     ← Acepta localShiftId
routes/sales.js                           ← Acepta localShiftId
routes/expenses.js                        ← Acepta localShiftId
```

### Desktop (SyaTortilleriasWinUi)

```
Services/BackendSyncService.cs            ← Envía localShiftId en shift open
Services/UnifiedSyncService.cs            ← Envía localShiftId en todas las transacciones
```

---

## ⚠️ Consideraciones Importantes

1. **No hay datos históricos que actualizar**: Las nuevas columnas aceptan NULL, así que no rompen datos existentes

2. **Cambio compatible**: Los endpoints todavía funcionan sin `localShiftId` (es opcional), pero se recomienda siempre enviarlo

3. **Índices optimizados**: Los índices creados mejoran performance en búsquedas de turnos offline

4. **Sin downtime**: La migración puede ejecutarse sin que la app se caiga

---

## 🆘 Troubleshooting

### Si falla la migración

```bash
# Ver logs detallados
node apply_004_local_shift_id_migration.js 2>&1 | tail -50

# Si hay error de conexión a PostgreSQL
# Verificar:
# 1. DATABASE_URL en .env es correcto
# 2. Render PostgreSQL está online
# 3. SSL settings son correctos
```

### Si el index falla

Algunos hosts PostgreSQL pueden no permitir índices directos en NULL. En ese caso:

```sql
-- PostgreSQL ejecutará automáticamente esto:
CREATE INDEX idx_shifts_local_shift_id ON shifts(local_shift_id)
WHERE local_shift_id IS NOT NULL;
```

---

## 📞 Contacto

Si hay problemas:
1. Revisar los logs de `apply_004_local_shift_id_migration.js`
2. Revisar que la migración SQL esté en `migrations/004_add_local_shift_id.sql`
3. Verificar conexión a PostgreSQL en Render

---

**¡Migración lista para producción!** ✅
