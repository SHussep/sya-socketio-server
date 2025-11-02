# 🏗️ Data Ownership Model - Quién es Dueño de Cada Dato

## El Concepto Central

```
┌─────────────────────────────────────────────────────────────┐
│                                                               │
│   Desktop (SQLite)        →  Backend (PostgreSQL)           │
│   Local Storage              Source of Truth                │
│   "In Progress"              "Final State"                  │
│                                                               │
│   ┌──────────────────────┐   ┌──────────────────────┐      │
│   │  Drafts & Tracking   │   │  Confirmed Data      │      │
│   │  • Asignaciones      │   │  • Ventas            │      │
│   │  • Devoluciones      │   │  • Gastos            │      │
│   │  • Borradores        │   │  • Reportes          │      │
│   │  • synced flag ✅    │   │  • synced flag ❌    │      │
│   │  • remote_id ✅      │   │  • remote_id ❌      │      │
│   └──────────────────────┘   └──────────────────────┘      │
│                                                               │
│   Dirección de flujo: ➜ (unidireccional)                    │
│   No hay escritura desde Backend a Desktop                  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Tabla de Propiedad: Quién es Dueño?

| Entidad | Desktop Dueño | Backend Dueño | Razón |
|---------|---|---|---|
| **Asignación de Kilos** | ✅ ↔️ Sync | ❌ | Solo se crea y edita en Desktop. Es el "borrador" |
| **Devolución de Kilos** | ✅ ↔️ Sync | ❌ | Solo se registra en Desktop. Causa que asignación se complete |
| **Venta (asign completada)** | ✅ Origen | ✅ Copia | Desktop crea, Backend recibe copia para reportes/auditoría |
| **Gasto** | ✅ Origen (Desktop) | ✅ Copia | Mobile/Desktop crean, Backend recibe copia |
| **Gasto (devuelto)** | ❌ | ❌ | No existe. Los gastos no se devuelven |

---

## Por Entidad: Flujo Completo

### 🎯 ASIGNACIÓN DE KILOS

```
Desktop                          PostgreSQL
─────────────────────────────────────────────────────

repartidor_assignments           ❌ No existe
├─ id (PK)
├─ repartidor_id
├─ product_id
├─ kilos_asignados: 300       ← Dueño: Desktop
├─ kilos_devueltos: NULL      ← Dueño: Desktop
├─ kilos_vendidos: NULL       ← Calculado por Desktop
├─ estado: 'pending'
├─ synced: false
└─ remote_id: NULL

Ciclo de vida:
1. Owner crea asignación en Desktop → SQLite
2. Repartidor devuelve kilos → Desktop UPDATE
3. Desktop calcula vendidos (300-15=285) → SQLite UPDATE
4. Estado cambia a 'completed' → SQLite UPDATE
5. ❌ NUNCA se envía a Backend
6. ❌ NO entra en PostgreSQL

¿Por qué no enviar a Backend?
- Es información transitoria, no es "venta real"
- El Backend solo necesita saber el RESULTADO (venta final)
- Los detalles de la asignación son internos de Desktop
```

### 💰 VENTA (Resultado Final)

```
Desktop                          PostgreSQL
─────────────────────────────────────────────────────

sales                            sales
├─ id (PK)                       ├─ id (PK)
├─ repartidor_id: 123           ├─ tenant_id
├─ product_id: 5                ├─ employee_id: 123
├─ kilos: 285                   ├─ product_id: 5
├─ price_per_kilo: 10.5         ├─ kilos: 285
├─ total_amount: 2992.5         ├─ price_per_kilo: 10.5
├─ assignment_id: 456           ├─ total_amount: 2992.5
├─ sale_date: ...               ├─ sale_date: ...
├─ synced: false ✅             ├─ notes: NULL
├─ synced_at: NULL              ├─ synced_from_desktop_at: NULL
├─ remote_id: NULL              ├─ created_at
└─ created_at                   └─ updated_at

Flujo:
1. Desktop crea asignación (300kg) → SQLite
2. Repartidor devuelve kilos (15kg) → SQLite
3. Desktop calcula: 300-15=285kg vendidos → CREA VENTA en SQLite
4. INSERT INTO sales (Desktop):
   - kilos: 285
   - synced: false
5. UnifiedSyncService detecta synced=false
6. POST /api/sales → Backend
7. Backend INSERT → PostgreSQL
8. Backend responde con remote_id
9. Desktop UPDATE sales SET synced=true, remote_id=999

¿Por qué "synced" en Desktop pero no en Backend?
- Desktop: "esto aún no está en el servidor" ✅
- Backend: "esto YA está en el servidor" (obvio)
```

### 🧾 GASTO

```
Mobile SQLite              Desktop SQLite           PostgreSQL
─────────────────────────────────────────────────────────────

expenses                   expenses                 expenses
├─ id                      ├─ id                    ├─ id
├─ repartidor_id: 123      ├─ repartidor_id: 123   ├─ employee_id: 123
├─ description: "Gasolina" ├─ description: ...     ├─ description: ...
├─ amount: 50              ├─ amount: 50           ├─ amount: 50
├─ category: 'fuel'        ├─ category: 'fuel'     ├─ category: 'fuel'
├─ synced: false ✅        ├─ synced: false ✅     ├─ no synced ❌
└─ remote_id: NULL         └─ remote_id: NULL      └─ created_at

Flujo:
1. Repartidor en Mobile:
   INSERT INTO expenses (synced=false)

2. Mobile Socket.IO notifica a Desktop:
   "Juan registró gasto de $50"

3. Desktop recibe Socket.IO:
   INSERT INTO expenses (synced=false)

4. UnifiedSyncService en Desktop:
   POST /api/employees/123/expenses

5. Backend INSERT → PostgreSQL

6. Backend responde con expense_id

7. Desktop UPDATE expenses SET synced=true, remote_id=777

Importante:
- Gastos son definitivos desde el inicio (no se borran/editan fácilmente)
- Se sincronizan pronto (no es un "borrador")
- Backend recibe gastos tal cual Desktop/Mobile los envían
```

---

## La Confusión Original Explicada

### ❌ Modelo Anterior (Confuso)

```
Desktop:
  - Asignación (300kg) synced=false → SQLite

        ↓ Sync to Backend

PostgreSQL:
  - Asignación (300kg) synced=??? → Tabla repartidor_assignments

PROBLEMA 1: ¿Para qué sincronizar si no es venta real?
PROBLEMA 2: Qué significa synced=true en Backend? (Si está aquí, YA está sincronizado)
PROBLEMA 3: El Backend tiene tabla repartidor_assignments (no la necesita)
PROBLEMA 4: Campos monto_asignado, monto_devuelto en Backend (innecesarios)
```

### ✅ Modelo Nuevo (Limpio)

```
Desktop:
  - Asignación (300kg) synced=false → Solo SQLite (no enviar)
  - Venta (285kg) synced=false → SQLite

        ↓ Sync to Backend (SOLO ventas)

PostgreSQL:
  - Venta (285kg) → Tabla sales (datos finales)

VENTAJA 1: Backend solo recibe VENTAS, no borradores
VENTAJA 2: synced=true en Backend tiene CERO sentido (no existe)
VENTAJA 3: PostgreSQL limpio, solo datos confirmados
VENTAJA 4: Cada tabla tiene campos relevantes
```

---

## Regla de Oro: Localidad de Datos

```
Si un dato puede cambiar o NO es definitivo:
  → Vive en SQLite (Desktop/Mobile)
  → Tiene un "synced" flag para tracking
  → Se sincroniza a Backend SOLO cuando es definitivo

Si un dato es definitivo y confirmado:
  → Vive en PostgreSQL (Backend)
  → NO tiene "synced" flag (redundante)
  → Es el "source of truth"
```

---

## Checklist: ¿Dónde Vive Este Dato?

### Pregunta: ¿Puede cambiar o es temporal?

| Dato | ¿Es Temporal? | ¿Dónde Vive? |
|------|---|---|
| Kilos asignados a repartidor | ✅ Sí | SQLite Desktop |
| Kilos devueltos | ✅ Sí | SQLite Desktop |
| Kilos vendidos (final) | ❌ No | SQLite + PostgreSQL |
| Gasto registrado | ❌ No | SQLite + PostgreSQL |
| Gasto editado | ⚠️ A veces | SQLite → PostgreSQL |
| Gasto devuelto | ❌ Nunca | N/A (no existe) |
| Reporte de ventas | ❌ No | PostgreSQL (Backend) |
| Reporte de gastos | ❌ No | PostgreSQL (Backend) |

---

## En Código: Cómo Implementar

### Desktop (C# SQLite)

```csharp
// ✅ CORRECTO: Asignación SOLO en SQLite
public async Task CreateAssignmentAsync(int repartidorId, int productId, double kilos)
{
    var assignment = new RepartidorAssignment
    {
        RepartidorId = repartidorId,
        ProductId = productId,
        KilosAsignados = kilos,
        Estado = "pending"
        // NO incluir: synced, remote_id para asignaciones
    };

    await connection.InsertAsync(assignment);
    // ❌ NO sincronizar a Backend
}

// ✅ CORRECTO: Cuando asignación se completa, crear VENTA
public async Task CompleteAssignmentAsync(int assignmentId, double kilosDevueltos)
{
    var assignment = await connection.GetAsync<RepartidorAssignment>(assignmentId);
    assignment.KilosDevueltos = kilosDevueltos;
    assignment.KilosVendidos = assignment.KilosAsignados - kilosDevueltos;
    assignment.Estado = "completed";

    await connection.UpdateAsync(assignment);

    // CREAR VENTA
    var sale = new Sale
    {
        RepartidorId = assignment.RepartidorId,
        ProductId = assignment.ProductId,
        Kilos = assignment.KilosVendidos,  // 285
        AssignmentId = assignmentId,
        Synced = false,
        RemoteId = null
    };

    await connection.InsertAsync(sale);
    // ✅ SÍ sincronizar esta VENTA a Backend
}

// ✅ CORRECTO: Gasto tiene synced tracking
public async Task CreateExpenseAsync(int repartidorId, string description, decimal amount)
{
    var expense = new Expense
    {
        RepartidorId = repartidorId,
        Description = description,
        Amount = amount,
        Synced = false,        // ✅ Tracking para sync
        RemoteId = null
    };

    await connection.InsertAsync(expense);
    // ✅ SÍ sincronizar a Backend
}
```

### Backend (Node.js PostgreSQL)

```javascript
// ❌ NO EXISTE tabla repartidor_assignments
// ❌ NO EXISTE tabla expenses con synced/remote_id

// ✅ EXISTE tabla sales (datos finales)
POST /api/sales
{
  tenantId: 6,
  employeeId: 123,
  productId: 5,
  kilos: 285,           // Ya es definitivo
  pricePerKilo: 10.5,
  totalAmount: 2992.5,
  saleDate: "2024-11-01T14:30:00Z"
  // ❌ NO fields: synced, remote_id, monto_asignado, etc.
}

// ✅ INSERT INTO sales (sin synced)
```

---

## Migración: Cómo Llegar Aquí

Si actualmente tienes:
- ❌ synced/remote_id en PostgreSQL
- ❌ repartidor_assignments en Backend
- ❌ Campos innecesarios en sales

**Ejecuta Migration 031:**
```sql
-- Esto limpia el Backend
-- Deja el Desktop tal cual (ya es correcto)
```

---

## Resumen Visual

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│  DESKTOP (SQLite)              →  BACKEND (PostgreSQL)        │
│  ═════════════════════════════════════════════════════════    │
│                                                                │
│  repartidor_assignments                                       │
│  (borrador)                                                    │
│  ├─ kilos_asignados: 300                                      │
│  ├─ kilos_devueltos: 15                                       │
│  ├─ kilos_vendidos: 285                                       │
│  └─ estado: 'completed'                                       │
│        ↓                                                       │
│  sales (definitivo)              sales (copia final)         │
│  ├─ kilos: 285                   ├─ kilos: 285              │
│  ├─ synced: true                 └─ (sin synced)            │
│  └─ remote_id: 999                                           │
│        ↓ (enviado a Backend)                                 │
│  expenses (definitivo)            expenses (copia)           │
│  ├─ synced: true                 └─ (sin synced)            │
│  └─ remote_id: 777                                           │
│                                                                │
└────────────────────────────────────────────────────────────────┘

Regla: Borradores en SQLite, finales en PostgreSQL.
```

---

**Con este modelo, cada tabla tiene una responsabilidad clara y no hay redundancia.**

