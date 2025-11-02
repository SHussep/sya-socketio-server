# 🔄 Complete System Data Flow: Desktop ↔ Backend ↔ Mobile

## High-Level Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SYSTEM OVERVIEW                             │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│                  │         │                  │         │                  │
│  DESKTOP (WinUI) │◄────────│  BACKEND (Node)  │────────►│  MOBILE (Flutter)│
│  SQLite (Local)  │ REST/   │  PostgreSQL      │ Socket  │  SQLite (Local)  │
│                  │ Socket  │  (Central)       │   .IO   │                  │
└──────────────────┘         │                  │         └──────────────────┘
                             └──────────────────┘

KEY FLOWS:
═════════════════════════════════════════════════════════════════════

1. ASSIGNMENTS (Temporary Data)
   Desktop SQLite ONLY → (Socket.IO notify) → Mobile SQLite
   ❌ NOT sent to Backend (not final data)

2. SALES (Final Data)
   Desktop SQLite → (sync) → Backend PostgreSQL
   ✅ Only final sales synced

3. EXPENSES (Final Data)
   Mobile SQLite → (Socket.IO) → Desktop SQLite → (sync) → Backend PostgreSQL

4. CASH DRAWER (Operational Data)
   Desktop → (notify) → Mobile SQLite
   or Mobile → (notify) → Desktop

SYNC DIRECTIONS:
───────────────
Desktop → Backend: ✅ (sales, expenses)
Backend → Desktop: ❌ (read-only, no back-sync)
Desktop ↔ Mobile: ✅ (via Socket.IO, bidirectional)
Mobile → Backend: ❌ (goes through Desktop)
```

---

## Detailed Workflow: A Complete Day in the Life

### Timeline: November 2, 2024

---

### 08:00 AM - Owner Opens App & Prepares Day

**Desktop (Owner's View):**
```
1. Owner logs in to Desktop app
   - Authentication happens
   - Role = "Owner" (all permissions loaded)

2. Owner sees: Dashboard with Repartidores list
   - Juan (Repartidor)
   - Maria (Repartidor)
   - Pedro (Repartidor)

3. Owner opens "Repartidores" view
   - All employees visible
```

**Backend (PostgreSQL):**
```
- Owner info loaded from employees table
- Role "Owner" fetched from roles table
- Permissions {16 permissions} loaded from role_permissions
```

**Mobile:**
```
- Not open yet
- Nothing happens
```

---

### 08:15 AM - Owner Opens Cash Drawer for Juan

**Desktop:**
```
Owner clicks: [Abrir Caja] button next to Juan's name

DESKTOP CODE:
└─ CashDrawerService.OpenDrawerAsync(repartidorId=123, initialAmount=200)
   ├─ INSERT INTO cash_drawers (tenant_id=6, branch_id=17,
   │                           repartidor_id=123, initial_amount=200,
   │                           estado='open', created_at=NOW)
   │
   ├─ Returns: CashDrawer { id=789, remote_id=null, synced_to_backend=false }
   │
   └─ SocketIOService.BroadcastCashDrawerOpenedAsync(cashDrawer)
      ├─ Emit: "cashier:drawer-opened"
      │ Payload: {
      │   drawerId: 789,
      │   repartidorId: 123,
      │   repartidorName: "Juan",
      │   initialAmount: 200.00,
      │   openedAt: "2024-11-02T08:15:00Z",
      │   estado: "open"
      │ }
      │
      └─ Socket.IO Server (Node.js)
         └─ socket.emit('cashier:drawer-opened', payload)
            └─ Broadcasts to ALL connected clients
```

**Backend (PostgreSQL):**
```
- Nothing happens yet
- Cash drawers are NOT synced to Backend (operational data stays local)
```

**Mobile (Juan):**
```
Juan is not logged in yet
(Still waiting for him to arrive)

When Mobile connects to Socket.IO:
┌─────────────────────────────────────────────────────┐
│ Socket.IO listener receives: 'cashier:drawer-opened'│
│                                                     │
│ Check: Is this for me (repartidorId=123)? YES      │
│                                                     │
│ INSERT INTO cash_drawers (local SQLite)             │
│ {                                                   │
│   remote_id=789,        ← From Desktop             │
│   repartidor_id=123,                                │
│   initial_amount=200.00,                            │
│   opened_at="2024-11-02T08:15:00Z",                │
│   estado='open',                                    │
│   synced_from_desktop=true                         │
│ }                                                   │
│                                                     │
│ Dashboard shows: "Caja abierta con \$200.00"       │
│ Timestamp: 08:15 AM                                │
└─────────────────────────────────────────────────────┘
```

---

### 08:20 AM - Owner Assigns Kilos to Juan

**Desktop:**
```
Owner clicks [Asignar] button for Juan

Opens dialog:
- Product: "Tortillas" (dropdown)
- Quantity: 350 (kilos)
- [Asignar] button

Owner submits:

DESKTOP CODE:
└─ RepartidorAssignmentService.CreateAssignmentAsync(
     repartidorId=123,
     productId=5,
     kilos=350
   )
   ├─ INSERT INTO repartidor_assignments (
   │   tenant_id=6,
   │   branch_id=17,
   │   repartidor_id=123,
   │   product_id=5,
   │   kilos_asignados=350,
   │   estado='pending',
   │   fecha_asignacion=NOW
   │ )
   │
   ├─ Returns: RepartidorAssignment { id=456 }
   │
   └─ SocketIOService.BroadcastAssignmentCreatedAsync(assignment)
      ├─ Emit: "repartidor:assignment-created"
      │ Payload: {
      │   assignmentId: 456,
      │   repartidorId: 123,
      │   productId: 5,
      │   productName: "Tortillas",
      │   kilos: 350,
      │   assignedAt: "2024-11-02T08:20:00Z",
      │   estado: "pending"
      │ }
      │
      └─ Socket.IO Server
         └─ Broadcast to all clients
```

**Backend (PostgreSQL):**
```
- Nothing happens
- Assignments are NOT synced to Backend
- This is temporary data, lives in Desktop SQLite only
```

**Mobile (Juan):**
```
Juan just arrived and opens the app

Mobile Socket.IO listener:
┌─────────────────────────────────────────────────────┐
│ Receives: "repartidor:assignment-created"           │
│                                                     │
│ Check: Is this for me (repartidorId=123)? YES      │
│                                                     │
│ INSERT INTO repartidor_assignments (local SQLite)   │
│ {                                                   │
│   remote_id=456,        ← From Desktop             │
│   repartidor_id=123,                                │
│   product_id=5,                                     │
│   product_name='Tortillas',                         │
│   kilos_asignados=350,                              │
│   estado='pending',                                 │
│   synced_from_desktop=true                         │
│ }                                                   │
│                                                     │
│ Dashboard updates:                                  │
│ ┌─────────────────────────────────────────────┐    │
│ │ 💰 CAJA ABIERTA                             │    │
│ │ Abierta a las 08:15 con \$200.00            │    │
│ │                                              │    │
│ │ 📦 ASIGNACIONES (Hoy)                       │    │
│ │ Tortillas: 350kg [Entregar]                 │    │
│ │ TOTAL: 350kg                                │    │
│ │                                              │    │
│ │ 💸 GASTOS (Hoy)                             │    │
│ │ (ninguno yet)                               │    │
│ └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

---

### 10:30 AM - Juan Registers a Gasto (Expense)

**Mobile:**
```
Juan is driving and buys gas for \$50

Mobile UI (Gastos Section):
┌─────────────────────────────────────────────┐
│ [+ Registrar Nuevo Gasto]                   │
│                                              │
│ Clicks button → Opens dialog:               │
│ Description: "Gasolina"                     │
│ Amount: 50.00                               │
│ Category: "fuel" (dropdown)                 │
│ Date: 2024-11-02 (auto-filled)              │
│ [Guardar Gasto]                             │
└─────────────────────────────────────────────┘

MOBILE CODE:
└─ ExpenseService.RegisterExpenseAsync(
     repartidorId=123,
     description="Gasolina",
     amount=50.00,
     category="fuel"
   )
   ├─ INSERT INTO expenses (
   │   repartidor_id=123,
   │   tenant_id=6,
   │   description="Gasolina",
   │   amount=50.00,
   │   category="fuel",
   │   expense_date=NOW,
   │   synced=false
   │ )
   │
   ├─ Returns: Expense { id=111 }
   │
   ├─ Check: isOnline? YES (has WiFi)
   │
   └─ SocketIOService.EmitExpenseCreated(expense)
      ├─ Emit: "repartidor:expense-created"
      │ Payload: {
      │   expenseId: 111,
      │   repartidorId: 123,
      │   description: "Gasolina",
      │   amount: 50.00,
      │   category: "fuel",
      │   expenseDate: "2024-11-02T10:30:00Z"
      │ }
      │
      └─ Socket.IO Server
         └─ Emits to Desktop (via event listener)
```

**Desktop:**
```
Desktop Socket.IO listener receives: "repartidor:expense-created"

DESKTOP CODE:
└─ SocketIOService event handler
   ├─ Verify: Is repartidorId=123 valid? YES
   │
   ├─ Emit internal event: 'expense:from-mobile'
   │
   └─ UnifiedSyncService.HandleExpenseFromMobileAsync(expense)
      ├─ INSERT INTO expenses (
      │   repartidor_id=123,
      │   tenant_id=6,
      │   description="Gasolina",
      │   amount=50.00,
      │   category="fuel",
      │   expense_date="2024-11-02T10:30:00Z",
      │   synced=false
      │ )
      │
      ├─ Returns: Expense { id=122, remote_id=null }
      │
      └─ Trigger sync immediately: SyncPendingExpensesAsync()
         ├─ Query: SELECT * FROM expenses WHERE synced=false
         │
         ├─ For each expense:
         │   ├─ Prepare payload:
         │   │ {
         │   │   tenantId: 6,
         │   │   employeeId: 123,
         │   │   description: "Gasolina",
         │   │   amount: 50.00,
         │   │   category: "fuel",
         │   │   date: "2024-11-02"
         │   │ }
         │   │
         │   └─ POST /api/employees/123/expenses → Backend
         │
         └─ (Continue to Backend)
```

**Backend (PostgreSQL):**
```
POST /api/employees/123/expenses

Node.js endpoint validates:
├─ tenantId matches employee? YES
├─ Employee exists? YES
├─ All required fields? YES
│
└─ INSERT INTO expenses (
    tenant_id=6,
    employee_id=123,
    description="Gasolina",
    amount=50.00,
    category="fuel",
    expense_date="2024-11-02",
    created_at=NOW
  )

Response: {
  success: true,
  expenseId: 777,
  created_at: "2024-11-02T10:30:00Z"
}

(Note: No synced/remote_id in PostgreSQL - redundant)
```

**Desktop (back from Backend):**
```
Backend response received:
├─ Success? YES
├─ expenseId: 777 (from PostgreSQL)
│
└─ UPDATE expenses SET synced=true, remote_id=777
   WHERE id=122

   Emit: "expense:synced"
   Payload: {
     expenseId: 111,        ← Original Mobile ID
     repartidorId: 123,
     remoteId: 777,         ← PostgreSQL ID
     syncedAt: "2024-11-02T10:30:00Z"
   }
```

**Mobile:**
```
Socket.IO listener receives: "expense:synced"

MOBILE CODE:
└─ Check: Is this for me (repartidorId=123)? YES
   │
   └─ UPDATE expenses
      SET synced=true,
          remote_id=777
      WHERE id=111

   Dashboard updates:
   ┌────────────────────────────────────────────┐
   │ 💸 GASTOS (Hoy)                            │
   │                                             │
   │ 10:30 - Gasolina      \$50.00  [✓ Synced] │
   │ TOTAL GASTOS HOY:     \$50.00              │
   │                                             │
   │ [+ Registrar Nuevo Gasto]                  │
   └────────────────────────────────────────────┘
```

---

### 17:00 PM - Juan Returns with Unsold Kilos

**Mobile:**
```
Juan is back at warehouse

Dashboard shows:
┌──────────────────────────────────────┐
│ 📦 ASIGNACIONES (Hoy)                │
│                                      │
│ Tortillas: 350kg [Devolver]          │
│ • Estado: pending                    │
│ • [Registrar Devolución]             │
└──────────────────────────────────────┘

Juan clicks [Registrar Devolución]:
Opens dialog:
- Kilos devueltos: 15 (input)
- [Guardar]

Mobile code:
└─ AssignmentService.CompleteAssignmentAsync(
     assignmentId=456,
     kilosDevueltos=15
   )
   ├─ UPDATE repartidor_assignments
   │  SET kilos_devueltos=15,
   │      kilos_vendidos=285,  ← Calculated: 350-15
   │      estado='completed',
   │      fecha_devolucion=NOW
   │ WHERE id=456
   │
   ├─ Emit: "repartidor:assignment-completed"
   │ Payload: {
   │   assignmentId: 456,
   │   repartidorId: 123,
   │   kilosDevueltos: 15,
   │   kilosVendidos: 285,
   │   completedAt: "2024-11-02T17:00:00Z"
   │ }
   │
   └─ Socket.IO to Desktop
```

**Desktop:**
```
Socket.IO listener receives: "repartidor:assignment-completed"

DESKTOP CODE:
└─ SocketIOService event handler
   │
   ├─ UPDATE repartidor_assignments
   │  SET kilos_devueltos=15,
   │      kilos_vendidos=285,
   │      estado='completed',
   │      fecha_devolucion=NOW
   │ WHERE id=456
   │
   └─ Trigger: SalesService.CreateSaleFromAssignmentAsync(assignmentId=456)
      ├─ Get assignment details (350kg, 15 returned, 285 sold)
      │
      ├─ INSERT INTO sales (
      │   repartidor_id=123,
      │   product_id=5,
      │   kilos=285,
      │   price_per_kilo=10.50,
      │   total_amount=2992.50,  ← 285 * 10.50
      │   assignment_id=456,
      │   synced=false
      │ )
      │
      ├─ Returns: Sale { id=200, remote_id=null }
      │
      └─ Trigger: UnifiedSyncService.SyncPendingExpensesAsync()
         ├─ Query: SELECT * FROM sales WHERE synced=false
         │
         └─ POST /api/sales → Backend
            ├─ Payload: {
            │   tenantId: 6,
            │   branchId: 17,
            │   employeeId: 123,
            │   productId: 5,
            │   kilos: 285,
            │   pricePerKilo: 10.50,
            │   totalAmount: 2992.50,
            │   saleDate: "2024-11-02T17:00:00Z"
            │ }
            │
            └─ (Continue to Backend)
```

**Backend (PostgreSQL):**
```
POST /api/sales

Node.js endpoint validates:
├─ All required fields? YES
│
└─ INSERT INTO sales (
    tenant_id=6,
    branch_id=17,
    employee_id=123,
    product_id=5,
    kilos=285,
    price_per_kilo=10.50,
    total_amount=2992.50,
    sale_date="2024-11-02T17:00:00Z",
    created_at=NOW
  )

Response: {
  success: true,
  saleId: 888,
  remote_id: 888
}

Note: No monto_asignado, monto_devuelto, synced fields
      (Only in Desktop SQLite)
```

**Desktop (back from Backend):**
```
Backend response received:
├─ Success? YES
├─ remote_id: 888 (from PostgreSQL)
│
└─ UPDATE sales SET synced=true, remote_id=888
   WHERE id=200
```

---

### 18:00 PM - Juan Closes Shift (Corte de Caja)

**Mobile:**
```
Juan prepares to leave

Dashboard shows:
┌────────────────────────────────────────────┐
│ 💰 CAJA ABIERTA                            │
│ Abierta a las 08:15 con \$200.00           │
│ Tiempo abierta: 9h 45m                     │
│                                             │
│ [Cerrar Caja y Turno]                      │
└────────────────────────────────────────────┘

Juan clicks [Cerrar Caja y Turno]:

Dialog appears:
- Cantidad final en caja: [input]
- Notas (optional): [input]
- [Cerrar Turno]

Juan enters: \$2500.00 (amount of money in cash drawer)

MOBILE CODE:
└─ CashDrawerService.CloseDrawerAsync(
     drawerId=789,
     finalAmount=2500.00,
     notas=null
   )
   ├─ UPDATE cash_drawers
   │  SET final_amount=2500.00,
   │      closed_at=NOW,
   │      estado='closed'
   │ WHERE id=789
   │
   ├─ Emit: "cashier:drawer-closed"
   │ Payload: {
   │   drawerId: 789,
   │   repartidorId: 123,
   │   finalAmount: 2500.00,
   │   closedAt: "2024-11-02T18:00:00Z"
   │ }
   │
   └─ Socket.IO to Desktop
```

**Desktop:**
```
Socket.IO listener receives: "cashier:drawer-closed"

DESKTOP CODE:
└─ CashDrawerService.CloseDrawerAsync(drawerId=789, finalAmount=2500.00)
   ├─ UPDATE cash_drawers
   │  SET final_amount=2500.00,
   │      closed_at=NOW,
   │      estado='closed'
   │ WHERE id=789
   │
   └─ Optional: Generate corte summary
      ├─ Total assigned: 350kg
      ├─ Total returned: 15kg
      ├─ Total sold: 285kg
      ├─ Total gastos: \$97.50
      ├─ Opening caja: \$200.00
      ├─ Closing caja: \$2500.00
      ├─ Difference: \$2500 - \$200 - \$97.50 - (sales income)
      │
      └─ Store in local report (for audit trail)
```

---

## Data Consistency Guarantees

### What Lives Where

| Entity | Desktop SQLite | Mobile SQLite | PostgreSQL | Reason |
|--------|---|---|---|---|
| **repartidor_assignments** | ✅ | ✅ (copy) | ❌ | Temporary, local-only |
| **sales** | ✅ | ❌ | ✅ | Final data, synced |
| **expenses** | ✅ | ✅ (source) | ✅ | Final data, synced |
| **cash_drawers** | ✅ | ✅ (notify) | ❌ | Operational, local |
| **synced flag** | ✅ | ✅ | ❌ | Only in SQLite (tracking) |
| **remote_id** | ✅ | ✅ | ❌ | Only in SQLite (mapping) |

### Sync Flow Summary

```
Assignment Created in Desktop
  ↓
Broadcast to Mobile (Socket.IO)
  ↓
Mobile stores locally (NOT sent to Backend)
  ↓
Assignment completed → Sale created
  ↓
Sale synced to Backend (via Desktop)
  ↓
Sale stored in PostgreSQL (final)

---

Expense created in Mobile
  ↓
Sent to Desktop (Socket.IO)
  ↓
Desktop syncs to Backend (REST API)
  ↓
Synced response sent back to Mobile
  ↓
Mobile marks as synced

---

Cash Drawer opened in Desktop
  ↓
Notify Mobile (Socket.IO)
  ↓
Mobile stores locally
  ↓
Cash Drawer closed in Mobile
  ↓
Notify Desktop
  ↓
Desktop knows shift is complete
```

---

## Offline Scenarios & Recovery

### Scenario A: Mobile Offline for Assignment Creation

```
Timeline:
08:20 - Desktop creates assignment (Mobile offline)
09:00 - Mobile connects
10:00 - Mobile checks sync status

Mobile:
├─ Check: lastSyncAssignments > 1 hour? YES
├─ Query local assignments: []  (empty)
│
└─ Emit: "request:my-assignments"
   └─ Desktop responds with all pending assignments
      └─ Mobile INSERTs them
```

### Scenario B: Desktop Offline for Expense Sync

```
Timeline:
10:30 - Mobile creates expense (Desktop offline)
11:00 - Desktop comes online
11:15 - Desktop syncs

Mobile:
├─ Expense stored locally with synced=false
├─ When online: tries to send via Socket.IO
│
Desktop:
├─ Receives "repartidor:expense-created"
├─ Syncs to Backend
├─ Emits "expense:synced" to Mobile
│
Mobile:
└─ Updates: synced=true, remote_id=777
```

### Scenario C: Backend Offline for Sales Sync

```
Timeline:
17:00 - Desktop creates sale (Backend offline)
17:30 - Backend comes online
18:00 - Retry kicks in

Desktop:
├─ Sale stored locally with synced=false
├─ UnifiedSyncService detects unsync
├─ Retries POST /api/sales
│
Backend:
├─ Receives and processes
│
Desktop:
└─ Updates: synced=true, remote_id=888
```

---

## Deployment Readiness Checklist

### Backend (Node.js + PostgreSQL)

- [x] Migration 030: Roles & Permissions
- [x] Migration 031: Clean redundant sync fields
- [x] POST /api/employees (create employees)
- [x] POST /api/employees/:id/password (sync password changes)
- [x] GET /api/roles/:tenantId (fetch roles with permissions)
- [x] POST /api/sales (receive final sales from Desktop)
- [x] POST /api/employees/:id/expenses (receive expenses from Desktop)
- [ ] POST /api/employees (handle login with password validation)
- [ ] Socket.IO handlers for cashier events
- [ ] Socket.IO handlers for expense events
- [ ] Socket.IO handlers for request:my-assignments

### Desktop (C# WinUI)

- [x] Models: Employee with password_hash, role_id, permissions
- [x] UnifiedSyncService: SyncEmployeeInternalAsync with password
- [x] UnifiedSyncService: SyncPasswordChangeAsync
- [x] Models: RepartidorAssignment with proper fields (no remote_id)
- [ ] UnifiedSyncService: BroadcastAssignmentCreatedAsync
- [ ] UnifiedSyncService: BroadcastAssignmentCompletedAsync
- [ ] Services: SalesService to create sales from completed assignments
- [ ] Services: CashDrawerService for opening/closing drawers
- [ ] SocketIOService: Listen for mobile events

### Mobile (Flutter)

- [ ] Models: RepartidorAssignment, CashDrawer, Expense
- [ ] SQLite tables: repartidor_assignments, cash_drawers, expenses
- [ ] Socket.IO listeners: assignment-created, assignment-completed
- [ ] Socket.IO listeners: cashier-drawer-opened, cashier-drawer-closed
- [ ] Socket.IO listeners: expense:synced
- [ ] Dashboard screen with 3 sections
- [ ] Expense registration dialog
- [ ] Offline data persistence & sync on reconnect

---

## Success Metrics

When fully implemented:

1. **Consistency**: Same data visible on Desktop and Mobile simultaneously
2. **Offline Capability**: Both systems work without internet
3. **Eventually Consistent**: When reconnected, all data syncs automatically
4. **No Redundancy**: No duplicate synced/remote_id fields in PostgreSQL
5. **Performance**: Real-time Socket.IO for responsive UX
6. **Audit Trail**: Every sync tracked (synced_at, remote_id, timestamps)

---

**This architecture ensures data integrity, offline functionality, and clean separation of concerns across all three systems.**

