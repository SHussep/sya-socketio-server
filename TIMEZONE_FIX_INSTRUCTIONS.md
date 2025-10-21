# Instrucciones Críticas: Corrección de Zonas Horarias - SYA Tortillerías

## Problema Identificado

Las ventas, gastos, cortes de caja y eventos Guardian se estaban guardando con la zona horaria del SERVIDOR (UTC), no la del usuario/sucursal.

**Ejemplo del bug:**
- Usuario en Sydney hace venta a las 17:28 (hora Sydney)
- Configuró su sucursal para zona horaria México (Centro)
- La venta se guardaba en PostgreSQL con UTC o hora del servidor, NO hora de México

## Causa Raíz

Las columnas de fecha en PostgreSQL tenían `DEFAULT CURRENT_TIMESTAMP`, que se ejecuta en el servidor, ignorando la zona horaria del cliente.

```sql
-- ANTES (incorrecto):
sale_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP

-- DESPUÉS (correcto):
sale_date TIMESTAMP WITH TIME ZONE NOT NULL
```

## Solución Implementada

### 1. Backend (C#/Desktop)
✅ **Hecho**: BackendSyncService.cs ahora envía fechas con zona horaria correcta
- `SyncUnsyncedSalesAsync()` → envía `fechaVenta` en ISO 8601 con zona horaria
- `SyncUnsyncedExpensesAsync()` → envía `fechaGasto` en ISO 8601 con zona horaria
- `SyncSaleAsync()` y `SyncExpenseAsync()` → aceptan parámetro opcional de fecha
- Todas las operaciones usan `TimezoneService.GetCurrentTimeInUserTimezone()`

### 2. Backend API (Node.js/server.js)
✅ **Hecho**: Endpoints receptores ahora almacenan la fecha recibida
- `/api/sync/sales` → recibe `fechaVenta` y lo almacena en `sale_date`
- `/api/sync/expenses` → recibe `fechaGasto` y lo almacena en `expense_date`

### 3. Base de Datos (CRITICAL - REQUIERE ACCIÓN)
⚠️ **PENDIENTE**: Ejecutar migración en la BD de Render

## ACCIONES REQUERIDAS

### Paso 1: Ejecutar Migración en PostgreSQL

Debes conectarte a tu base de datos de Render y ejecutar la migración:

**Archivo**: `C:/SYA/sya-socketio-server/migrations/003_fix_timezone_dates.sql`

**Opción A: Usando psql (si tienes acceso local)**
```bash
psql "postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v" -f ./migrations/003_fix_timezone_dates.sql
```

**Opción B: Usar Render Console (Recomendado)**
1. Ir a Render.com → sya_db_oe4v
2. Abrir "Shell" o "Query"
3. Copiar el contenido de `003_fix_timezone_dates.sql` y ejecutarlo

**Opción C: Usar DBeaver o PgAdmin**
1. Conectarse con los datos en `.env`
2. Abrir Query y ejecutar el SQL

### Lo que hace la migración:
```sql
-- Remover DEFAULT CURRENT_TIMESTAMP de estas tablas:
ALTER TABLE sales ALTER COLUMN sale_date SET NOT NULL;
ALTER TABLE expenses ALTER COLUMN expense_date SET NOT NULL;
ALTER TABLE purchases ALTER COLUMN purchase_date SET NOT NULL;
ALTER TABLE cash_cuts ALTER COLUMN cut_date SET NOT NULL;
ALTER TABLE guardian_events ALTER COLUMN event_date SET NOT NULL;

-- Llenar registros existentes con CURRENT_TIMESTAMP (si están NULL)
UPDATE sales SET sale_date = CURRENT_TIMESTAMP WHERE sale_date IS NULL;
-- ... (mismo para otros)
```

### Paso 2: Verificar la Ejecución

Después de ejecutar la migración, verifica:

```sql
-- Verifica que las columnas sean NOT NULL
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_name IN ('sales', 'expenses', 'purchases', 'cash_cuts', 'guardian_events')
AND column_name IN ('sale_date', 'expense_date', 'purchase_date', 'cut_date', 'event_date');

-- Debería mostrar is_nullable = NO y column_default = (vacío/null)
```

### Paso 3: Probar el Flujo Completo

1. **Build Desktop App**
   ```bash
   cd "C:\Users\saul_\source\repos\SyaTortilleriasWinUi"
   dotnet build SyaTortilleriasWinUi -c Debug
   ```

2. **Crear una venta de prueba en Sydney**
   - Configurar sucursal con zona horaria: México - Centro
   - Ir a una ciudad en Sydney (zona horaria: Australia/Sydney)
   - Hacer una venta a las 17:28 Sydney time

3. **Verificar en PostgreSQL**
   ```sql
   SELECT id, ticket_number, sale_date AT TIME ZONE 'America/Mexico_City' as sale_time_mexico,
          sale_date AT TIME ZONE 'Australia/Sydney' as sale_time_sydney
   FROM sales
   ORDER BY id DESC
   LIMIT 5;
   ```

   **Debería mostrar**: Ambas zonas horarias correctas (la venta aparecerá con la hora en que fue hecha, respetando la zona)

## Flujo Completo: Cómo Funciona Ahora

```
┌─────────────────────────────────────────────────────────────┐
│ USUARIO EN SYDNEY crea VENTA a las 17:28 Sydney Time       │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ TimezoneService.GetCurrentTimeInUserTimezone()             │
│ Retorna: 17:28 Sydney con offset +11:00                   │
│ → DateTime: 2025-10-21T17:28:00+11:00                      │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Desktop App serializa: "fechaVenta": "2025-10-21T17:28...+11:00"
│ Envía al backend en SYNC                                  │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ POST /api/sync/sales con fechaVenta                        │
│ Backend recibe y almacena en sale_date                    │
└────────────────────┬────────────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ PostgreSQL: sale_date = '2025-10-21 17:28:00+11:00'       │
│ ✅ CORRECTO: Respeta la zona horaria de Sydney           │
└─────────────────────────────────────────────────────────────┘
```

## Consultas Útiles para la App Futura

Cuando implementes la app para consultar ventas:

```sql
-- Mostrar ventas en zona horaria del usuario (México)
SELECT id, ticket_number,
       sale_date AT TIME ZONE 'America/Mexico_City' as venta_hora_mexico,
       total_amount
FROM sales
ORDER BY sale_date DESC;

-- Mostrar en zona horaria de la sucursal
SELECT b.timezone, s.id, s.ticket_number,
       s.sale_date AT TIME ZONE b.timezone as venta_hora_sucursal,
       s.total_amount
FROM sales s
JOIN branches b ON s.branch_id = b.id
ORDER BY s.sale_date DESC;
```

## Commits Realizados

### Desktop (SyaTortilleriasWinUi)
- `6b8d487`: Sync fechaVenta y fechaGasto en payloads
- `d185c56`: Agregar TimezoneService + fix DateTime.Now refs

### Backend (sya-socketio-server)
- `ffcada5`: Endpoints /api/sync/sales y /api/sync/expenses aceptan fechas
- `21c36b0`: Migración 003_fix_timezone_dates.sql - CRÍTICA

## Estado Final

| Componente | Status | Nota |
|-----------|--------|------|
| Desktop App | ✅ Completo | Envía fechas con zona horaria correcta |
| Backend API | ✅ Completo | Recibe y almacena fechas correctamente |
| BD Schema | ⏳ PENDIENTE | Necesita ejecutar migration 003 en Render |
| Testing | ⏳ PENDIENTE | Crear venta en Sydney, verificar en PostgreSQL |

## Próximos Pasos

1. ✅ **INMEDIATO**: Ejecutar migración en PostgreSQL (Render)
2. ⏳ **SOON**: Build desktop y probar sync de venta
3. ⏳ **SOON**: Consultar datos en BD para verificar zona horaria
4. ⏳ **FUTURE**: Implementar app que consume datos con zonas horarias correctas

---

**¿Preguntas o problemas?** Revisa los commits para ver exactamente qué cambió.
