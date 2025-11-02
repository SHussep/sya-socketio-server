# 🔄 Rediseño de Asignaciones de Repartidores - Conceptual Claro

## Problema Actual

**En Desktop (SQLite):**
- Tabla `repartidor_assignments` tiene campos confusos:
  - `monto_asignado` - kilos asignados al inicio
  - `monto_devuelto` - kilos devueltos
  - `monto_vendido` - kilos finalmente vendidos
  - `synced` - ¿para qué si estamos en SQLite local?
  - `remote_id` - ¿para qué si no enviamos a Backend?

**En Backend (PostgreSQL):**
- Los mismos campos redundantes
- ¿Por qué copiar una asignación incompleta si aún no es venta?
- El campo `synced` en PostgreSQL no tiene sentido (si está en PostgreSQL, YA existe)

**Flujo Confuso:**
```
Desktop → asigna 300kg → SQLite (incompleto)
         → ¿sincronizar a PostgreSQL? (¿para qué?)
         → repartidor devuelve 15kg
         → venta final 285kg (AHORA es venta real)
         → ¿sincronizar como venta a PostgreSQL?
```

---

## Modelo Mental Correcto

### Conceptos Claros:

1. **ASIGNACIÓN** (temporal, solo en Desktop SQLite)
   - Owner/Gerente en Desktop asigna X kilos de un producto a un repartidor
   - Se guarda en SQLite local
   - Es un "borrador" hasta que se complete
   - **NO se envía a PostgreSQL** hasta que no sea venta real

2. **VENTA** (permanente, en PostgreSQL)
   - Se crea solo cuando la asignación se completa (repartidor devuelve excedentes)
   - Owner/Gerente registra: "asignamos 300kg, devolvió 15kg, vendió 285kg"
   - Esto genera una VENTA de 285kg
   - **AHORA sí se sincroniza a PostgreSQL**

3. **GASTO** (permanente, en PostgreSQL)
   - Repartidor registra gasto en Mobile app
   - Se guarda en SQLite local de Mobile
   - Se sincroniza a Desktop mediante Socket.IO
   - Desktop lo guarda en su SQLite
   - Desktop lo sincroniza a PostgreSQL
   - **NO es un borrador - es definitivo desde el inicio**

---

## Tabla de Verdad: ¿Dónde Guardamos?

| Dato | Desktop SQLite | PostgreSQL | Razón |
|------|---|---|---|
| **Asignación (300kg asignados)** | ✅ Sí | ❌ No | Es temporal, incompleta |
| **Devolución (15kg devueltos)** | ✅ Sí | ❌ No | Es información transitoria |
| **Venta Final (285kg vendidos)** | ✅ Sí | ✅ Sí | Es definitiva, sincronizada |
| **Gasto Registrado** | ✅ Sí | ✅ Sí | Es definitivo |
| **Gasto Devuelto** | ❌ No | ❌ No | Los gastos no se "devuelven" |

---

## Estructura de Tablas Rediseñadas

### Desktop (SQLite) - Lo que DEBE tener:

#### Tabla: `repartidor_assignments`
```sql
CREATE TABLE repartidor_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    repartidor_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    kilos_asignados REAL NOT NULL,          -- 300kg
    kilos_devueltos REAL,                   -- 15kg (nullable, puede ser NULL hasta que devuelva)
    kilos_vendidos REAL,                    -- 285kg (solo se calcula al completar: asignados - devueltos)
    fecha_asignacion DATETIME NOT NULL,
    fecha_devolucion DATETIME,              -- Cuándo devolvió
    estado TEXT DEFAULT 'pending',          -- 'pending', 'returned', 'completed'

    -- SOLO local, NO sincronizar
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    -- NO estos campos - son innecesarios:
    -- synced, remote_id, monto_asignado (duplicate), etc.

    FOREIGN KEY (repartidor_id) REFERENCES employees(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);
```

#### Tabla: `sales` (creada cuando asignación se completa)
```sql
-- Una asignación completada = una VENTA
-- Sale_date: fecha cuando se completó
-- Kilos: los que se vendieron realmente (asignados - devueltos)
CREATE TABLE sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    repartidor_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    kilos REAL NOT NULL,                    -- 285kg (final)
    price_per_kilo REAL NOT NULL,
    total_amount REAL NOT NULL,
    sale_date DATETIME NOT NULL,

    -- Link a la asignación que la originó
    assignment_id INTEGER,                  -- Referencia a repartidor_assignments

    -- Sync tracking (para enviar a Backend)
    synced BOOLEAN DEFAULT false,
    synced_at DATETIME,
    remote_id INTEGER,                      -- ID en PostgreSQL

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (repartidor_id) REFERENCES employees(id),
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (assignment_id) REFERENCES repartidor_assignments(id)
);
```

#### Tabla: `expenses`
```sql
CREATE TABLE expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    repartidor_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL,                 -- 'fuel', 'food', 'tools', 'other'
    expense_date DATETIME NOT NULL,

    -- Sync tracking
    synced BOOLEAN DEFAULT false,
    synced_at DATETIME,
    remote_id INTEGER,                      -- ID en PostgreSQL

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (repartidor_id) REFERENCES employees(id)
);
```

### Backend (PostgreSQL) - Solo datos finales:

#### Tabla: `sales` (ÚNICAMENTE esto)
```sql
CREATE TABLE sales (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    employee_id INTEGER NOT NULL REFERENCES employees(id),  -- Repartidor
    product_id INTEGER NOT NULL,
    kilos REAL NOT NULL,                    -- 285kg (definitivo)
    price_per_kilo REAL NOT NULL,
    total_amount REAL NOT NULL,
    sale_date TIMESTAMP NOT NULL,

    -- Metadata útil
    notes TEXT,
    synced_from_desktop_at TIMESTAMP,       -- Cuándo se recibió del Desktop

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- NO incluir: monto_asignado, monto_devuelto, synced (redundante), etc.
```

#### Tabla: `expenses`
```sql
CREATE TABLE expenses (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    description VARCHAR(255) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    category VARCHAR(50) NOT NULL,
    expense_date TIMESTAMP NOT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Flujo Correcto: Asignación → Venta

### Paso 1: Asignación en Desktop
```
Owner en Desktop
  ↓
  "Asignar 300kg de Tortillas a Juan"
  ↓
  INSERT INTO repartidor_assignments:
  {
    repartidor_id: 123,
    product_id: 5,
    kilos_asignados: 300,
    kilos_devueltos: NULL,
    kilos_vendidos: NULL,
    estado: 'pending'
  }
  ↓
  ✅ Guardado en SQLite local
  ❌ NO se envía a Backend todavía
```

### Paso 2: Juan devuelve excedentes
```
Juan en Desktop (o Mobile)
  ↓
  "Devolví 15kg de los 300kg asignados"
  ↓
  UPDATE repartidor_assignments:
  {
    kilos_devueltos: 15,
    kilos_vendidos: 285,  -- Calculado: 300 - 15
    estado: 'completed',
    fecha_devolucion: NOW()
  }
  ↓
  ✅ Actualizado en SQLite local
```

### Paso 3: Se crea VENTA (automático)
```
Desktop detecta que assignment.estado = 'completed'
  ↓
  INSERT INTO sales:
  {
    repartidor_id: 123,
    product_id: 5,
    kilos: 285,           -- Los que realmente se vendieron
    price_per_kilo: 10.5,
    total_amount: 2992.5, -- 285 * 10.5
    assignment_id: 456,   -- Link a la asignación
    synced: false,
    remote_id: NULL
  }
  ↓
  ✅ Guardado en SQLite local
```

### Paso 4: Desktop sincroniza VENTA a Backend
```
UnifiedSyncService detecta sales con synced=false
  ↓
  POST /api/sales
  {
    tenantId: 6,
    branchId: 17,
    employeeId: 123,
    productId: 5,
    kilos: 285,
    pricePerKilo: 10.5,
    totalAmount: 2992.5,
    saleDate: '2024-11-01T14:30:00Z'
  }
  ↓
  Backend INSERT INTO sales (PostgreSQL)
  ↓
  Response: { success: true, saleId: 999, remote_id: 999 }
  ↓
  Desktop UPDATE sales SET synced=true, remote_id=999
```

---

## Flujo Correcto: Gasto (Mobile → Desktop → Backend)

### Paso 1: Repartidor registra gasto en Mobile
```
Juan en Mobile app
  ↓
  "Gasté $50 en combustible"
  ↓
  Mobile INSERT INTO expenses (SQLite local)
  {
    repartidor_id: 123,
    description: 'Combustible',
    amount: 50.00,
    category: 'fuel',
    synced: false
  }
  ↓
  ✅ Guardado en Mobile SQLite
```

### Paso 2: Mobile sincroniza a Desktop vía Socket.IO
```
Mobile Socket.IO → Desktop Socket.IO
  ↓
  "Nuevo gasto registrado por Juan: $50 combustible"
  ↓
  Desktop INSERT INTO expenses (SQLite local)
  {
    repartidor_id: 123,
    description: 'Combustible',
    amount: 50.00,
    category: 'fuel',
    synced: false,
    remote_id: NULL
  }
  ↓
  ✅ Guardado en Desktop SQLite
```

### Paso 3: Desktop sincroniza a Backend
```
UnifiedSyncService detecta expenses con synced=false
  ↓
  POST /api/employees/123/expenses
  {
    tenantId: 6,
    description: 'Combustible',
    amount: 50.00,
    category: 'fuel',
    date: '2024-11-01'
  }
  ↓
  Backend INSERT INTO expenses (PostgreSQL)
  ↓
  Response: { success: true, expenseId: 777, remote_id: 777 }
  ↓
  Desktop UPDATE expenses SET synced=true, remote_id=777
```

---

## El Campo `synced` Explicado Correctamente

### En SQLite (Desktop/Mobile):
```
synced = false  → "Esta información aún no está en el servidor"
synced = true   → "Ya fue enviado a PostgreSQL"
```
✅ **TIENE SENTIDO** - es el tracking de qué necesita sincronizarse

### En PostgreSQL (Backend):
```
synced = ???  → ¿Para qué? Si está aquí, YA está sincronizado
              → El "origen de verdad" es PostgreSQL, no Desktop
              → NO necesita "synced"
```
❌ **NO TIENE SENTIDO** - PostgreSQL es el servidor, todo aquí está sincronizado por definición

---

## Resumen: Qué Guardar Dónde

### Desktop SQLite (temporales + en progreso):
- ✅ `repartidor_assignments` - borrador hasta completar
- ✅ `sales` - con `synced` tracking para enviar a Backend
- ✅ `expenses` - con `synced` tracking para enviar a Backend
- ✅ `gastos_repartidor` - historial local (opcional)

### PostgreSQL (datos finales confirmados):
- ✅ `sales` - **SIN campo synced** (redundante)
- ✅ `expenses` - **SIN campo synced** (redundante)
- ❌ `repartidor_assignments` - NO incluir (nunca se envía)
- ❌ Campos: `monto_asignado`, `monto_devuelto`, `monto_vendido`, `synced` - TODO esto solo en Desktop SQLite

---

## Cambios en Backend (PostgreSQL)

### Eliminar de tabla `sales`:
- `monto_asignado` (no aplicable)
- `monto_devuelto` (no aplicable)
- `monto_vendido` (simplemente es `kilos`)
- `synced` (si existe, eliminar)
- `remote_id` (si existe, eliminar)
- `fecha_devolucion` (no aplicable)

### Mantener solo:
- `id, tenant_id, branch_id, employee_id (repartidor), product_id`
- `kilos, price_per_kilo, total_amount, sale_date`
- `created_at, updated_at`
- Opcional: `notes, synced_from_desktop_at` (para auditoría)

### Eliminar de tabla `repartidor_assignments`:
- **Toda la tabla del Backend** - esto es solo Desktop

---

## Migraciones Necesarias

### Backend (PostgreSQL):
```sql
-- ELIMINAR columnas innecesarias de sales
ALTER TABLE sales DROP COLUMN IF EXISTS synced;
ALTER TABLE sales DROP COLUMN IF EXISTS remote_id;
ALTER TABLE sales DROP COLUMN IF EXISTS monto_asignado;
ALTER TABLE sales DROP COLUMN IF EXISTS monto_devuelto;
ALTER TABLE sales DROP COLUMN IF EXISTS monto_vendido;
ALTER TABLE sales DROP COLUMN IF EXISTS fecha_devolucion;

-- ELIMINAR tabla repartidor_assignments del Backend
DROP TABLE IF EXISTS repartidor_assignments;

-- AGREGAR columnas útiles
ALTER TABLE sales ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS synced_from_desktop_at TIMESTAMP;
```

### Desktop (SQLite):
No cambios necesarios - mantener como está pero con estructura clara

---

## Tabla Conceptual Final: Dónde Vive Cada Dato

| Dato | Desktop SQLite | PostgreSQL | Descripción |
|------|---|---|---|
| Asignación (300kg) | ✅ | ❌ | Temporal, solo en Desktop |
| Devolución (15kg) | ✅ | ❌ | Temporal, solo en Desktop |
| Venta Final (285kg) | ✅ | ✅ | Definitiva, sincronizada |
| Gasto Registrado | ✅ | ✅ | Definitivo, sincronizado |
| Synced flag | ✅ | ❌ | Tracking en Desktop únicamente |
| Remote ID | ✅ | ❌ | Mapping en Desktop únicamente |

---

## Próximos Pasos

1. **Limpiar Backend (PostgreSQL):**
   - Eliminar campos redundantes de `sales`
   - Eliminar tabla `repartidor_assignments` si existe
   - Ejecutar migraciones

2. **Verificar Desktop (SQLite):**
   - `repartidor_assignments` solo tiene campos de asignación
   - `sales` tiene `synced` y `remote_id` para tracking
   - `expenses` tiene `synced` y `remote_id` para tracking

3. **Actualizar Sincronización:**
   - POST /api/sales (para enviar ventas completadas)
   - POST /api/employees/:id/expenses (ya existe)
   - Ambos reciben datos finales, no borradores

4. **Mobile (Future):**
   - Puede registrar gastos (luego se sincronizan a Desktop)
   - NO necesita conocer asignaciones (eso es Desktop)
   - Gastos se envían a Backend vía Desktop

---

**Este diseño es mucho más limpio: borradores en local (SQLite), finales en servidor (PostgreSQL).**

