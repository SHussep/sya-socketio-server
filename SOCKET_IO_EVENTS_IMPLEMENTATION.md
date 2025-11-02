# 🔌 Socket.IO Events Implementation Guide

## Events Between Desktop and Mobile

This document specifies which Socket.IO events should be emitted between Desktop and Mobile for the assignment sync architecture to work.

---

## Event Categories

### 1. Assignment Events (Desktop → Mobile)

#### Event: `repartidor:assignment-created`

**When it fires:**
- Desktop: Owner creates new assignment in `repartidor_assignments` table
- Desktop code calls: `await unifiedSyncService.CreateAssignmentAsync()`

**Payload:**
```javascript
{
  assignmentId: 456,              // Primary key in Desktop SQLite
  repartidorId: 123,              // Who this assignment is for
  tenantId: 6,
  branchId: 17,
  productId: 5,                   // What product
  productName: "Tortillas",       // Denormalized for offline use
  kilos: 350,                     // How many kilos
  assignedAt: "2024-11-02T09:00:00Z",
  estado: "pending"
}
```

**Mobile listener (Flutter):**
```dart
socket.on('repartidor:assignment-created', (data) {
  // Only process if this is for the current logged-in repartidor
  if (data['repartidorId'] == currentRepartidorId) {
    // INSERT into local SQLite
    final assignment = RepartidorAssignment.fromJson(data);
    assignment.syncedFromDesktop = true;
    await database.insertAssignment(assignment);

    // Refresh UI
    notifyListeners();  // or setState()

    // Show notification
    showNotification('📦 Nueva asignación: ${data["kilos"]}kg de ${data["productName"]}');
  }
});
```

**Desktop implementation (C# needed):**
The `SocketIOService` should emit this event after inserting assignment:
```csharp
public async Task BroadcastAssignmentCreatedAsync(RepartidorAssignment assignment)
{
    var payload = new
    {
        assignmentId = assignment.Id,
        repartidorId = assignment.RepartidorId,
        tenantId = assignment.TenantId,
        branchId = assignment.BranchId,
        productId = assignment.ProductId,
        productName = assignment.Product?.Name,
        kilos = assignment.KilosAsignados,
        assignedAt = assignment.FechaAsignacion,
        estado = assignment.Estado
    };

    socket.Emit("repartidor:assignment-created", payload);
}
```

---

#### Event: `repartidor:assignment-completed`

**When it fires:**
- Desktop: Assignment marked as completed (repartidor returned kilos)
- Desktop code: `UPDATE repartidor_assignments SET kilos_devueltos=15, kilos_vendidos=285, estado='completed'`

**Payload:**
```javascript
{
  assignmentId: 456,
  repartidorId: 123,
  kilosDevueltos: 15,             // What repartidor returned
  kilosVendidos: 285,             // What was actually sold
  completedAt: "2024-11-02T17:00:00Z",
  estado: "completed"
}
```

**Mobile listener:**
```dart
socket.on('repartidor:assignment-completed', (data) {
  if (data['repartidorId'] == currentRepartidorId) {
    // UPDATE local SQLite
    await database.updateAssignment(
      data['assignmentId'],
      {
        'kilos_devueltos': data['kilosDevueltos'],
        'kilos_vendidos': data['kilosVendidos'],
        'estado': 'completed'
      }
    );

    notifyListeners();
    showNotification('✅ Asignación completada: ${data["kilosVendidos"]}kg vendidos');
  }
});
```

---

### 2. Cash Drawer Events

#### Event: `cashier:drawer-opened` (Desktop → Mobile)

**When it fires:**
- Desktop: Owner clicks "Abrir Caja" for a repartidor
- Desktop inserts into `cash_drawers` table

**Payload:**
```javascript
{
  drawerId: 789,                  // Primary key from Desktop cash_drawers
  repartidorId: 123,
  tenantId: 6,
  branchId: 17,
  repartidorName: "Juan",         // Display name
  initialAmount: 200.00,
  openedAt: "2024-11-02T08:00:00Z",
  openedByUsername: "Owner Name",  // Who opened it
  estado: "open"
}
```

**Mobile listener:**
```dart
socket.on('cashier:drawer-opened', (data) {
  if (data['repartidorId'] == currentRepartidorId) {
    // INSERT or UPDATE local cash_drawers
    final drawer = CashDrawer.fromJson(data);
    drawer.syncedFromDesktop = true;
    await database.insertOrUpdateCashDrawer(drawer);

    notifyListeners();
    showNotification(
      '💰 Tu caja fue abierta a las ${data["openedAt"]} con \$${data["initialAmount"]}'
    );
  }
});
```

---

#### Event: `cashier:drawer-opened-by-repartidor` (Mobile → Desktop)

**When it fires:**
- Mobile: Repartidor opens app and initiates cash drawer (if Desktop doesn't open it)
- Mobile inserts into `cash_drawers` table

**Payload:**
```javascript
{
  repartidorId: 123,
  tenantId: 6,
  branchId: 17,
  repartidorName: "Juan",
  initialAmount: 200.00,
  openedAt: "2024-11-02T08:00:00Z"
}
```

**Desktop listener (Node.js Socket.IO server):**
```javascript
socket.on('cashier:drawer-opened-by-repartidor', (data) => {
  // Verify the user is actually this repartidor
  const repartidorId = socket.handshake.auth.repartidorId;
  if (repartidorId !== data.repartidorId) {
    return; // Reject: someone is trying to open caja for another repartidor
  }

  // INSERT into Desktop SQLite via C# UnifiedSyncService
  // This is async, so we need a callback or promise
  eventEmitter.emit('cashier:drawer-opened-mobile', {
    ...data,
    socketId: socket.id
  });

  // Acknowledge to Mobile
  socket.emit('cashier:drawer-acknowledged');
});
```

**Desktop handler (C#):**
```csharp
public async Task HandleCashDrawerOpenedByMobileAsync(dynamic data)
{
    var drawer = new CashDrawer
    {
        RepartidorId = data.repartidorId,
        TenantId = data.tenantId,
        BranchId = data.branchId,
        InitialAmount = data.initialAmount,
        OpenedAt = DateTime.Parse(data.openedAt),
        Estado = "open"
    };

    // INSERT into local SQLite
    await databaseService.InsertAsync(drawer);

    // Broadcast to all connected Desktop users (Owner/Gerente)
    await socketIOService.BroadcastCashDrawerOpenedAsync(drawer);
}
```

---

#### Event: `cashier:drawer-closed` (Mobile → Desktop)

**When it fires:**
- Mobile: Repartidor closes shift, reports final cash amount
- Mobile updates `cash_drawers` table

**Payload:**
```javascript
{
  drawerId: 789,                  // The drawer being closed
  repartidorId: 123,
  finalAmount: 2500.00,           // Total cash at end of day
  closedAt: "2024-11-02T18:00:00Z",
  notas: "Todo ok, sin diferencias" // Optional notes
}
```

**Mobile implementation (Flutter):**
```dart
Future<void> closeCashDrawer(double finalAmount, String notes) async {
  // UPDATE local SQLite
  await database.updateCashDrawer(currentDrawerId, {
    'final_amount': finalAmount,
    'closed_at': DateTime.now(),
    'notas': notes,
    'estado': 'closed'
  });

  // Emit to Desktop
  socket.emit('cashier:drawer-closed', {
    'drawerId': currentDrawerId,
    'repartidorId': currentRepartidorId,
    'finalAmount': finalAmount,
    'closedAt': DateTime.now().toIso8601String(),
    'notas': notes
  });

  showNotification('✅ Turno cerrado. Caja cerrada con \$${finalAmount}');
}
```

**Desktop listener (Node.js):**
```javascript
socket.on('cashier:drawer-closed', (data) => {
  const repartidorId = socket.handshake.auth.repartidorId;
  if (repartidorId !== data.repartidorId) return;

  // Emit to C# service
  eventEmitter.emit('cashier:drawer-closed-mobile', {
    ...data,
    socketId: socket.id
  });

  socket.emit('cashier:drawer-closure-acknowledged');
});
```

**Desktop handler (C#):**
```csharp
public async Task HandleCashDrawerClosedByMobileAsync(dynamic data)
{
    // UPDATE local SQLite
    await databaseService.UpdateCashDrawerAsync(data.drawerId, new
    {
        FinalAmount = data.finalAmount,
        ClosedAt = DateTime.Parse(data.closedAt),
        Estado = "closed",
        Notas = data.notas
    });

    // Broadcast to Owner/Gerente
    await socketIOService.BroadcastCashDrawerClosedAsync(data);

    // Optionally: trigger UnifiedSyncService to sync this to Backend
}
```

---

### 3. Expense Events

#### Event: `repartidor:expense-created` (Mobile → Desktop)

**When it fires:**
- Mobile: Repartidor registers a new gasto
- Mobile inserts into `expenses` table with `synced=false`

**Payload:**
```javascript
{
  expenseId: 111,                 // Local ID in Mobile SQLite
  repartidorId: 123,
  tenantId: 6,
  description: "Combustible",
  amount: 50.00,
  category: "fuel",               // fuel, food, tools, other
  expenseDate: "2024-11-02T10:30:00Z",
  notas: null                     // Optional
}
```

**Desktop listener (Node.js):**
```javascript
socket.on('repartidor:expense-created', (data) => {
  const repartidorId = socket.handshake.auth.repartidorId;
  if (repartidorId !== data.repartidorId) return;

  eventEmitter.emit('expense:from-mobile', {
    ...data,
    socketId: socket.id
  });
});
```

**Desktop handler (C#):**
```csharp
public async Task HandleExpenseFromMobileAsync(dynamic data)
{
    var expense = new Expense
    {
        RepartidorId = data.repartidorId,
        TenantId = data.tenantId,
        Description = data.description,
        Amount = data.amount,
        Category = data.category,
        ExpenseDate = DateTime.Parse(data.expenseDate),
        Synced = false,
        RemoteId = null
    };

    // INSERT into Desktop SQLite
    await databaseService.InsertAsync(expense);

    // Trigger sync to Backend (UnifiedSyncService)
    await unifiedSyncService.SyncPendingExpensesAsync();
}
```

---

#### Event: `expense:synced` (Desktop → Mobile)

**When it fires:**
- Desktop: Expense was successfully synced to Backend
- Backend returns `remote_id`

**Payload:**
```javascript
{
  expenseId: 111,                 // Local ID in Mobile SQLite
  repartidorId: 123,
  remoteId: 777,                  // ID from PostgreSQL
  syncedAt: "2024-11-02T10:35:00Z"
}
```

**Mobile listener:**
```dart
socket.on('expense:synced', (data) {
  if (data['repartidorId'] == currentRepartidorId) {
    // UPDATE local SQLite
    await database.updateExpense(data['expenseId'], {
      'synced': true,
      'remote_id': data['remoteId'],
      'synced_at': data['syncedAt']
    });

    notifyListeners();
  }
});
```

---

### 4. Request/Response Events

#### Event: `request:my-assignments` (Mobile → Desktop)

**Purpose:** Mobile explicitly requests its assignments (used when offline sync is needed)

**When it fires:**
- Mobile: On app open, if last sync > 1 hour ago
- Mobile: User manually taps "Refresh Assignments"

**Payload:**
```javascript
{
  repartidorId: 123,
  tenantId: 6,
  lastSyncAt: "2024-11-02T08:00:00Z"  // Optional: only send newer
}
```

**Desktop listener (Node.js):**
```javascript
socket.on('request:my-assignments', (data) => {
  const repartidorId = socket.handshake.auth.repartidorId;
  if (repartidorId !== data.repartidorId) return;

  eventEmitter.emit('request:assignments', {
    repartidorId: data.repartidorId,
    tenantId: data.tenantId,
    socketId: socket.id,
    lastSyncAt: data.lastSyncAt
  });
});
```

**Desktop handler (C#):**
```csharp
public async Task HandleRequestMyAssignmentsAsync(dynamic data)
{
    var repartidorId = data.repartidorId;
    var lastSyncAt = data.lastSyncAt != null
        ? DateTime.Parse(data.lastSyncAt)
        : DateTime.MinValue;

    // Query local SQLite
    var assignments = await databaseService.GetAsync<RepartidorAssignment>(
        a => a.RepartidorId == repartidorId && a.UpdatedAt >= lastSyncAt
    );

    // Send back to Mobile
    var socketId = data.socketId; // From Node.js listener
    await socketIOService.EmitToSocketAsync(socketId, "response:my-assignments", new
    {
        repartidorId = repartidorId,
        assignments = assignments.Select(a => new
        {
            assignmentId = a.Id,
            repartidorId = a.RepartidorId,
            productId = a.ProductId,
            productName = a.Product?.Name,
            kilos = a.KilosAsignados,
            kilosDevueltos = a.KilosDevueltos,
            kilosVendidos = a.KilosVendidos,
            assignedAt = a.FechaAsignacion,
            estado = a.Estado
        }).ToList()
    });
}
```

**Mobile listener:**
```dart
socket.on('response:my-assignments', (data) {
  // Bulk update local SQLite with assignments
  for (var assignmentData in data['assignments']) {
    final assignment = RepartidorAssignment.fromJson(assignmentData);
    assignment.syncedFromDesktop = true;

    // INSERT or UPDATE (upsert)
    await database.insertOrUpdateAssignment(assignment);
  }

  notifyListeners();
  showNotification('✅ Asignaciones sincronizadas: ${data["assignments"].length} encontradas');
});
```

---

## Implementation Checklist

### Backend (Node.js Socket.IO) - Already have Socket.IO setup

- [ ] Listen for `cashier:drawer-opened-by-repartidor`
- [ ] Verify repartidorId matches socket auth
- [ ] Emit to C# service via eventEmitter
- [ ] Listen for `repartidor:expense-created`
- [ ] Verify repartidorId matches socket auth
- [ ] Listen for `cashier:drawer-closed`
- [ ] Listen for `request:my-assignments`
- [ ] Query Desktop SQLite for assignments
- [ ] Emit `response:my-assignments` back to Mobile

### Desktop (C# WinUI) - UnifiedSyncService enhancements

- [ ] Create `BroadcastAssignmentCreatedAsync()` method
- [ ] Emit `repartidor:assignment-created` after INSERT
- [ ] Create `BroadcastAssignmentCompletedAsync()` method
- [ ] Emit `repartidor:assignment-completed` after completion
- [ ] Create `BroadcastCashDrawerOpenedAsync()` method
- [ ] Emit `cashier:drawer-opened` to specific repartidor(s)
- [ ] Handle `cashier:drawer-opened-by-repartidor` listener
- [ ] Handle `repartidor:expense-created` listener
- [ ] Sync expenses to Backend when received
- [ ] Emit `expense:synced` back to Mobile
- [ ] Handle `request:my-assignments` listener
- [ ] Query all pending assignments
- [ ] Emit `response:my-assignments` to specific Mobile socket

### Mobile (Flutter) - Socket.IO listeners

- [ ] Listen for `repartidor:assignment-created`
- [ ] Check if for current repartidor
- [ ] INSERT into local SQLite `repartidor_assignments`
- [ ] Refresh Dashboard UI
- [ ] Listen for `repartidor:assignment-completed`
- [ ] UPDATE local assignment
- [ ] Listen for `cashier:drawer-opened`
- [ ] INSERT/UPDATE local `cash_drawers`
- [ ] Listen for `expense:synced`
- [ ] UPDATE expense with remote_id
- [ ] Listen for `response:my-assignments`
- [ ] Bulk sync assignments on reconnect
- [ ] Emit `repartidor:expense-created` after INSERT
- [ ] Emit `cashier:drawer-closed` when shift ends
- [ ] Emit `request:my-assignments` on app open

---

## Error Handling

### What if Mobile is offline when assignment is created?

**Problem:** Mobile doesn't receive Socket.IO event

**Solution:**
- Desktop holds the assignment in SQLite (already does)
- Mobile checks `lastSyncAssignments` timestamp
- When Mobile reconnects: emit `request:my-assignments`
- Desktop responds with all assignments created since last sync

### What if Desktop is offline when Mobile registers expense?

**Problem:** Desktop doesn't receive `repartidor:expense-created` event

**Solution:**
- Mobile stores expense in SQLite with `synced=false`
- When Desktop comes online, it will sync via polling or next sync cycle
- Or: Mobile can emit the expense again (idempotent due to unique constraints)

### What if Backend is offline when Desktop tries to sync expense?

**Problem:** UnifiedSyncService fails to POST /api/employees/:id/expenses

**Solution:**
- Desktop marks expense `synced=false` and retries
- UnifiedSyncService has retry logic
- Eventually syncs when Backend comes online
- Mobile only updates when Desktop successfully syncs (`expense:synced` event)

---

**This event structure allows full offline-first capability while maintaining eventual consistency across all three systems.**

