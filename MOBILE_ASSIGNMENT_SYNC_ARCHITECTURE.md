# 📱 Mobile Assignment Synchronization Architecture

## Overview: Assignments on Mobile

**User's Requirements:**
1. Desktop Owner assigns 350kg of product to Repartidor Juan
2. Juan opens Mobile app → sees the 350kg assignment on Dashboard
3. Juan can register gastos (expenses) throughout the day
4. Juan sees cash opening info (caja abierta con X dinero inicial)
5. Both systems work offline with local SQLite data
6. Assignments are temporary (Desktop only), NOT sent to PostgreSQL

---

## Core Concept: Real-Time Push + Local Storage

```
Desktop (SQLite)                    Mobile (SQLite)
──────────────────────────────────────────────────────

1. Owner creates assignment
   INSERT repartidor_assignments
   (repartidor_id=123, kilos=350)
           ↓
           │ Socket.IO Event
           ├─→ "assignment:created"
           │   {repartidorId: 123, productId: 5, kilos: 350, ...}
           │
   Connected? YES           ↓           Connected? YES
   ┌─────────────────────────────────────────────────┐
   │ Mobile receives assignment event                │
   │ INSERT INTO repartidor_assignments (local SQLite)
   │ Dashboard re-renders, shows "350kg pending"    │
   └─────────────────────────────────────────────────┘

   Connected? NO            ↓           Connected? NO
   ┌─────────────────────────────────────────────────┐
   │ Next time Mobile connects, poll for assignments │
   │ GET /api/employees/:id/assignments/pending      │
   │ (Backend provides view of Desktop data)         │
   │ or get via Desktop directly                     │
   └─────────────────────────────────────────────────┘

2. Juan returns kilos, marks assignment completed
   Desktop: UPDATE repartidor_assignments
   Desktop: CREATE sale (285kg sold)
           ↓
           │ Socket.IO Event
           ├─→ "assignment:completed"
           │   {assignmentId: 456, kilos_vendidos: 285}
           │
   Mobile: UPDATE repartidor_assignments
           SET estado='completed', kilos_vendidos=285

3. Gastos sync Mobile → Desktop → Backend
   Mobile:  INSERT expenses (synced=false, remote_id=NULL)
           ↓
           │ Socket.IO to Desktop
           ├─→ "expense:created"
           │   {repartidorId: 123, amount: 50, category: 'fuel'}
           │
   Desktop: INSERT expenses (synced=false, remote_id=NULL)
           │ UnifiedSyncService
           ├─→ POST /api/employees/123/expenses → Backend
           │
   Backend: INSERT expenses (PostgreSQL)
           │ Response: {expenseId: 777}
           │
   Desktop: UPDATE expenses SET synced=true, remote_id=777
           │ Socket.IO back to Mobile
           ├─→ "expense:synced"
           │   {expenseId: 777, remoteId: 777}
           │
   Mobile:  UPDATE expenses SET synced=true, remote_id=777
```

---

## Data Flow Architecture

### Desktop → Mobile Assignment Sync

**Option 1: Real-Time Socket.IO (Preferred for Connected State)**
```
Desktop creates assignment
  ↓
Event: "repartidor:assignment-created"
  ├─ Payload: {
      assignmentId: 456,
      repartidorId: 123,
      productId: 5,
      kilos: 350,
      assignedAt: "2024-11-02T09:00:00Z",
      product: { id: 5, name: "Tortillas" },
      estado: "pending"
    }
  │
Mobile Socket.IO listener
  ├─ Is this Repartidor the recipient? Check repartidorId
  ├─ INSERT INTO repartidor_assignments (local SQLite)
  ├─ Broadcast update to UI: assignments list refreshes
  └─ Show notification: "Nuevo reparto: 350kg de Tortillas"
```

**Option 2: Pull on App Open (Fallback for Offline)**
```
Mobile Repartidor opens app after being offline
  ↓
Check: Do we have recent assignments?
  ├─ If last sync < 1 hour ago: skip
  ├─ If last sync > 1 hour ago OR assignments list empty
  │   ├─ Try: GET /api/employees/123/assignments/pending
  │   │   (Backend queries recent Desktop sync data)
  │   ├─ Or: Poll Desktop directly via Socket.IO
  │   │   emit "request:my-assignments"
  │   │
  │   └─ Desktop responds with all pending assignments for Juan
  │
  └─ UPDATE local assignments SQLite
```

---

## Mobile SQLite Schema (Extended)

### Table: repartidor_assignments (Local Copy)

**Purpose:** Track assignments created by Owner on Desktop

```sql
CREATE TABLE repartidor_assignments (
    -- Local ID
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identifiers
    remote_id INTEGER UNIQUE,                    -- ID from Desktop SQLite (if synced)
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    repartidor_id INTEGER NOT NULL,             -- ALWAYS = current logged-in user
    product_id INTEGER NOT NULL,

    -- Assignment Details
    kilos_asignados REAL NOT NULL,              -- 350
    kilos_devueltos REAL,                       -- NULL until returned
    kilos_vendidos REAL,                        -- NULL until completed

    -- Dates
    fecha_asignacion DATETIME NOT NULL,
    fecha_devolucion DATETIME,

    -- Workflow State
    estado TEXT DEFAULT 'pending',              -- pending, returned, completed

    -- Product Details (denormalized from Desktop for offline)
    product_name TEXT,                          -- "Tortillas" (cached)

    -- Local Tracking
    synced_from_desktop BOOLEAN DEFAULT false,  -- true if received from Desktop
    synced_to_backend BOOLEAN DEFAULT false,    -- true if sale was synced to Backend

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(tenant_id, remote_id),
    FOREIGN KEY (product_id) REFERENCES products(id)
);
```

### Table: cash_drawers (New - for cash opening)

**Purpose:** Track cash drawer opening for each shift

```sql
CREATE TABLE cash_drawers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identifiers
    remote_id INTEGER UNIQUE,                   -- ID from Desktop (if synced)
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    repartidor_id INTEGER NOT NULL,            -- Employee who opened drawer

    -- Cash Information
    initial_amount REAL NOT NULL,               -- How much cash at opening
    opening_time DATETIME NOT NULL,
    closing_time DATETIME,                      -- NULL if drawer still open
    final_amount REAL,                          -- How much cash at closing

    -- Workflow State
    estado TEXT DEFAULT 'open',                 -- open, closed

    -- Sync Tracking
    synced_to_backend BOOLEAN DEFAULT false,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(tenant_id, remote_id)
);
```

### Table: expenses (Existing - Already Defined)

```sql
CREATE TABLE expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    remote_id INTEGER UNIQUE,                   -- ID from Desktop/Backend
    tenant_id INTEGER NOT NULL,
    repartidor_id INTEGER NOT NULL,

    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL,                     -- fuel, food, tools, other
    expense_date DATETIME NOT NULL,

    synced BOOLEAN DEFAULT false,               -- true if synced to Desktop/Backend
    synced_at DATETIME,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (repartidor_id) REFERENCES employees(id)
);
```

---

## Socket.IO Events Between Systems

### Desktop → Mobile Events

```javascript
// 1. Assignment Created
socket.emit("repartidor:assignment-created", {
    assignmentId: 456,
    repartidorId: 123,
    productId: 5,
    productName: "Tortillas",
    kilos: 350,
    assignedAt: "2024-11-02T09:00:00Z",
    estado: "pending"
});

// 2. Assignment Completed
socket.emit("repartidor:assignment-completed", {
    assignmentId: 456,
    repartidorId: 123,
    kilosDevueltos: 15,
    kilosVendidos: 285,
    completedAt: "2024-11-02T17:00:00Z"
});

// 3. Cash Drawer Opened (Option A: Desktop initiates)
socket.emit("cashier:drawer-opened", {
    drawerId: 789,
    repartidorId: 123,
    repartidorName: "Juan",
    initialAmount: 200.00,
    openedAt: "2024-11-02T08:00:00Z"
});

// 4. Turno Cerrado (Shift ending)
socket.emit("repartidor:shift-ended", {
    repartidorId: 123,
    shiftEndedAt: "2024-11-02T18:00:00Z"
});
```

### Mobile → Desktop Events

```javascript
// 1. Request Assignments (on app open if offline before)
socket.emit("request:my-assignments", {
    repartidorId: 123,
    tenantId: 6
    // Desktop responds with list of pending assignments
});

// 2. Expense Registered
socket.emit("repartidor:expense-created", {
    expenseId: 111,
    repartidorId: 123,
    description: "Combustible",
    amount: 50.00,
    category: "fuel",
    expenseDate: "2024-11-02T10:30:00Z"
});

// 3. Cash Drawer Opened (Option B: Mobile initiates)
socket.emit("cashier:drawer-opened-by-repartidor", {
    repartidorId: 123,
    initialAmount: 200.00,
    openedAt: "2024-11-02T08:00:00Z"
});

// 4. Shift Closing (Final corte de caja)
socket.emit("repartidor:shift-closing", {
    repartidorId: 123,
    finalAmount: 2500.00,
    closedAt: "2024-11-02T18:00:00Z"
});
```

---

## Cash Drawer Opening: Two Approaches

### Option A: Desktop Owner Initiates (Recommended)

**Pros:**
- Owner controls when shift starts
- Clear accountability (Owner opens, time-stamped)
- Mobile receives notification (non-blocking)
- Works well in formal environment

**Cons:**
- Requires Desktop to be aware of when Repartidor arrives
- Extra step for Owner

**Flow:**
```
1. Owner in Desktop: Clicks "Abrir caja" for Juan
   INSERT INTO cash_drawers (tenant_id, branch_id, repartidor_id,
                             initial_amount, estado='open')

2. Desktop emits Socket.IO:
   "cashier:drawer-opened"
   {drawerId: 789, repartidorId: 123, initialAmount: 200, ...}

3. Mobile listening for this event:
   - Checks if event is for current logged-in user (repartidorId=123? Yes)
   - INSERT INTO cash_drawers (local copy, synced_from_desktop=true)
   - Show notification: "Tu caja fue abierta por Owner con $200"
   - Dashboard shows: "Caja abierta: $200"

4. Juan can now:
   - See pending assignments
   - Register gastos
   - Close shift when done
```

### Option B: Mobile Repartidor Initiates

**Pros:**
- No coordination needed with Owner
- Repartidor autonomy (can work flexible hours)
- Faster (Repartidor opens app, inputs amount)

**Cons:**
- No Owner oversight of opening time
- Could lead to untracked time (if app doesn't record)
- Need backup if Mobile offline

**Flow:**
```
1. Juan opens Mobile app, sees no active cash drawer
   App shows: "¿Con cuanto dinero abres tu caja?"
   Input: $200

2. Mobile:
   INSERT INTO cash_drawers (repartidor_id=123, initial_amount=200,
                             estado='open', synced_from_desktop=false)

3. Mobile emits Socket.IO:
   "cashier:drawer-opened-by-repartidor"
   {repartidorId: 123, initialAmount: 200, openedAt: now}

4. Desktop listening:
   - INSERT INTO cash_drawers (local copy)
   - Owner Dashboard shows: "Juan abrió caja a las 08:00 con $200"
   - Optional notification: "⏰ Juan abrió caja a las 08:00 con $200"

5. Both systems in sync
```

**Recommended Choice: Option A** (Desktop initiates)

Why:
- More formal and controlled
- Owner has accountability
- Mobile is notification-based (simpler, less logic)
- Aligns with existing Desktop-centric architecture

---

## Mobile Dashboard: Three Sections

### Section 1: Caja Abierta (Cash Drawer Status)

**If cash drawer open:**
```
┌─────────────────────────────────┐
│ 💰 CAJA ABIERTA                 │
│ Abierta a las 08:00 por Owner   │
│ Cantidad inicial: $200.00       │
│ Tiempo abierta: 8h 35m          │
│                                 │
│ [Cerrar Caja y Turno]          │
└─────────────────────────────────┘
```

**If cash drawer closed:**
```
┌─────────────────────────────────┐
│ 💰 CAJA CERRADA                 │
│ Apertura: 08:00 (200.00)        │
│ Cierre: 18:00 (2500.00)         │
│ Turno: Completado               │
│                                 │
│ [Abrir Nueva Caja]              │ ← Only if Desktop allows
└─────────────────────────────────┘
```

**Data Source:** Most recent record from cash_drawers table
- If `estado='open'`: show opening info
- If `estado='closed'`: show summary

---

### Section 2: Kilos Asignados (Pending Assignments)

**Display:**
```
┌─────────────────────────────────────────────┐
│ 📦 MIS ASIGNACIONES (Hoy)                   │
│                                              │
│ Tortillas:         350kg [Entregar]         │
│ • Entrega: 08:00   Pendiente                │
│                                              │
│ Pan Dulce:         150kg [Entregar]         │
│ • Entrega: 10:00   Pendiente                │
│                                              │
│ TOTAL ASIGNADO:    500kg                    │
│                                              │
│ [Ver Detalles]                              │
└─────────────────────────────────────────────┘
```

**Data Source:** repartidor_assignments where estado='pending'

**Interactions:**
- Tap assignment → See details (product name, kilos, product photo)
- Mark as "Returned" → Update kilos_devueltos, change estado to 'completed'
- System calculates kilos_vendidos = asignados - devueltos

---

### Section 3: Gastos Registrados (Today's Expenses)

**Display:**
```
┌─────────────────────────────────────────────┐
│ 💸 GASTOS REGISTRADOS (Hoy)                 │
│                                              │
│ 09:30 - Gasolina           $50.00  [✓ Sync]│
│ 12:00 - Almuerzo           $12.50  [✓ Sync]│
│ 15:30 - Herramientas       $35.00  [⏳ Sync]│
│                                              │
│ TOTAL GASTOS HOY:         $97.50             │
│                                              │
│ [+ Registrar Nuevo Gasto]                   │
│ [Sincronizar Ahora]                         │
└─────────────────────────────────────────────┘
```

**Data Source:** expenses where expense_date = TODAY

**Status Indicators:**
- ✓ Sync = synced=true (sent to Desktop/Backend)
- ⏳ Sync = synced=false (pending sync)
- ❌ Error = sync failed (show retry button)

**Interactions:**
- Tap [+] → Open expense dialog
  - Description, Amount, Category (dropdown: fuel, food, tools, other)
  - Date/Time picker (default = now)
  - Submit → INSERT into expenses (synced=false)
  - If online → Emit Socket.IO "repartidor:expense-created" immediately
- Tap [Sincronizar Ahora] → Force sync of all pending expenses

---

## Offline Data Strategy

### Scenario 1: Mobile Offline, Assignment Created in Desktop

```
Desktop: Creates assignment for Juan
         Emits Socket.IO "repartidor:assignment-created"

Mobile:  OFFLINE - event not received

Later:   Mobile reconnects (WiFi/Data available)

Mobile:  On app resume:
         - Check: lastSyncAssignments > 1 hour ago?
         - YES → Emit "request:my-assignments"

Desktop: Listens for "request:my-assignments"
         - Query all pending assignments for this repartidor
         - Emit "response:my-assignments" with full list

Mobile:  Receive list
         - For each assignment:
           - Check if exists locally (remote_id match)
           - If not exists: INSERT
           - If exists but newer: UPDATE
         - Refresh Dashboard
```

### Scenario 2: Mobile Offline, Juan Registers Expense

```
Mobile:  OFFLINE - user registers gasto
         INSERT INTO expenses (synced=false, remote_id=NULL)
         Notification: "Gasto guardado localmente, sincronizará cuando conecte"

Later:   Mobile reconnects

Mobile:  On app resume:
         - Query expenses where synced=false
         - For each: Emit "repartidor:expense-created"

Desktop: Receives "repartidor:expense-created"
         - INSERT INTO expenses (synced=false)
         - Emit Socket.IO to Backend via UnifiedSyncService

Backend: Receives expense
         - INSERT into PostgreSQL
         - Response: {expenseId: 777}

Desktop: UPDATE expenses SET remote_id=777
         - Emit "expense:synced" back to Mobile

Mobile:  UPDATE expenses SET synced=true, remote_id=777
         - Show ✓ indicator next to expense
```

---

## Backend Integration: Fallback Endpoints

While Socket.IO is preferred, backend should provide REST endpoints for reliability:

### GET /api/employees/:id/assignments/pending

**Purpose:** Mobile can fetch assignments if Socket.IO fails

```
GET /api/employees/123/assignments/pending

Response:
{
  success: true,
  assignments: [
    {
      id: 456,
      repartidorId: 123,
      productId: 5,
      productName: "Tortillas",
      kilos: 350,
      assignedAt: "2024-11-02T09:00:00Z",
      estado: "pending"
    },
    ...
  ]
}
```

**Implementation:** Backend queries Desktop SQLite via API (or polls if needed)

### GET /api/employees/:id/cash-drawer/current

**Purpose:** Mobile can check if cash drawer is open

```
GET /api/employees/123/cash-drawer/current

Response:
{
  success: true,
  cashDrawer: {
    id: 789,
    repartidorId: 123,
    initialAmount: 200.00,
    openedAt: "2024-11-02T08:00:00Z",
    estado: "open"
  }
}
```

---

## Implementation Priority

**Phase 1 (MVP - Next Sprint):**
1. ✅ Mobile SQLite schema (repartidor_assignments, cash_drawers)
2. ✅ Socket.IO event: "repartidor:assignment-created" (Desktop → Mobile)
3. ✅ Mobile Dashboard showing pending assignments
4. ✅ Mobile can register gastos (local INSERT + Socket.IO emit)
5. ✅ Desktop listening for "repartidor:expense-created" from Mobile

**Phase 2 (Optional - Future):**
1. Offline sync queue + manual "Sincronizar Ahora" button
2. Backend fallback endpoints (GET assignments, GET cash drawer)
3. Push notifications for assignments/cash drawer changes
4. Assignment completion flow (return kilos, mark completed)

**Phase 3 (Enhancement):**
1. Real-time location tracking (with permissions)
2. Photo capture for items/damages
3. Signature for delivery confirmation
4. Advanced analytics dashboard

---

## Summary: Key Design Decisions

| Aspect | Decision | Reason |
|--------|----------|--------|
| **Assignment Flow** | Desktop → Socket.IO → Mobile SQLite | Real-time, offline-capable |
| **Cash Drawer Initiator** | Desktop Owner (Option A) | Formal, accountable |
| **Expense Sync** | Mobile → Socket.IO → Desktop → Backend | Follows current pattern |
| **Offline Strategy** | Local SQLite + sync on reconnect | Works without internet |
| **Synced Field** | Only in SQLite, not Backend | Only tracking in local DB |
| **Fallback** | REST endpoints for critical data | Reliability if Socket.IO fails |

---

**This design keeps assignments in local storage (SQLite) on both Desktop and Mobile, never sending them to PostgreSQL. Only final sales (ventas) go to Backend. Both systems work offline with eventual consistency.**

