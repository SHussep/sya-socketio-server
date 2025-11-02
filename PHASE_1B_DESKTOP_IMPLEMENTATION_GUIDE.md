# 📱 Phase 1B: Desktop (C# WinUI) Implementation Guide

## Overview

This phase adds **broadcasting methods** to Desktop so it can:
1. Listen for mobile events (forwarded by Backend)
2. Emit events to Mobile (assignments, cash drawer status)
3. Create sales when assignments complete
4. Sync everything to Backend

---

## Architecture

```
Desktop Role: BRIDGE between Mobile ↔ Backend

Mobile (Flutter)
    ↓ Socket.IO
Backend (Node.js)  [Phase 1A ✅ - listeners ready]
    ↓ Forward events
Desktop (C#)       [Phase 1B - YOU ARE HERE]
    ↓ Process + broadcast
Mobile + Backend
```

---

## Implementation Steps

### STEP 1: Add Methods to SocketIOService

**File:** `SyaTortilleriasWinUi/Services/SocketIOService.cs`

**Current structure (verify you have this):**
```csharp
public class SocketIOService
{
    private SocketIO socket;

    public async Task ConnectAsync(string url) { ... }
    public void Emit(string eventName, object data) { ... }
    public void On(string eventName, Action<string> callback) { ... }
}
```

**Add these 6 new methods:**

#### Method 1A: Broadcast Assignment Created
```csharp
public void BroadcastAssignmentCreatedAsync(dynamic assignment)
{
    // When Owner creates assignment in Desktop, tell Mobile immediately
    try
    {
        var payload = new
        {
            assignmentId = assignment.Id,
            repartidorId = assignment.RepartidorId,
            tenantId = assignment.TenantId,
            branchId = assignment.BranchId,
            productId = assignment.ProductId,
            productName = assignment.Product?.Name ?? "Unknown",
            kilos = assignment.KilosAsignados,
            assignedAt = DateTime.Now.ToUniversalTime().ToString("O"),
            estado = "pending"
        };

        Console.WriteLine($"[SocketIO] 📢 Broadcasting assignment created: {assignment.Id}");
        socket.Emit("repartidor:assignment-created", payload);
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[SocketIO] ❌ Error broadcasting assignment: {ex.Message}");
    }
}
```

#### Method 1B: Broadcast Assignment Completed
```csharp
public void BroadcastAssignmentCompletedAsync(dynamic assignment)
{
    // When assignment is completed (kilos returned), tell Mobile
    try
    {
        var payload = new
        {
            assignmentId = assignment.Id,
            repartidorId = assignment.RepartidorId,
            tenantId = assignment.TenantId,
            branchId = assignment.BranchId,
            kilosDevueltos = assignment.KilosDevueltos ?? 0,
            kilosVendidos = assignment.KilosVendidos ?? 0,
            completedAt = DateTime.Now.ToUniversalTime().ToString("O"),
            estado = "completed"
        };

        Console.WriteLine($"[SocketIO] 📢 Broadcasting assignment completed: {assignment.Id}");
        socket.Emit("repartidor:assignment-completed", payload);
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[SocketIO] ❌ Error broadcasting assignment completion: {ex.Message}");
    }
}
```

#### Method 2: Broadcast Cash Drawer Opened (Desktop initiates - Option A)
```csharp
public void BroadcastCashDrawerOpenedAsync(dynamic cashDrawer, string repartidorName)
{
    // When Owner opens cash drawer for a repartidor, notify Mobile
    try
    {
        var payload = new
        {
            drawerId = cashDrawer.Id,
            repartidorId = cashDrawer.RepartidorId,
            tenantId = cashDrawer.TenantId,
            branchId = cashDrawer.BranchId,
            repartidorName = repartidorName,
            initialAmount = cashDrawer.InitialAmount,
            openedAt = DateTime.Now.ToUniversalTime().ToString("O"),
            openedByUsername = "Owner", // Get from current user
            estado = "open"
        };

        Console.WriteLine($"[SocketIO] 💰 Broadcasting cash drawer opened: ${cashDrawer.InitialAmount}");
        socket.Emit("cashier:drawer-opened", payload);
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[SocketIO] ❌ Error broadcasting cash drawer: {ex.Message}");
    }
}
```

#### Method 3: Listen for Mobile Events (Listener Setup)
```csharp
public void SetupMobileListeners()
{
    // EVENT 1: Mobile registered an expense
    socket.On("repartidor:expense-created", (data) =>
    {
        Console.WriteLine($"[SocketIO] 💸 Received expense from Mobile: {data}");
        // Parse the data and insert into Desktop SQLite
        HandleExpenseFromMobileAsync(data);
    });

    // EVENT 2: Mobile completed an assignment
    socket.On("repartidor:assignment-completed", (data) =>
    {
        Console.WriteLine($"[SocketIO] ✅ Received assignment completion from Mobile: {data}");
        HandleAssignmentCompletionFromMobileAsync(data);
    });

    // EVENT 3: Mobile opened cash drawer (Option B)
    socket.On("cashier:drawer-opened-by-repartidor", (data) =>
    {
        Console.WriteLine($"[SocketIO] 💰 Mobile opened cash drawer: {data}");
        HandleCashDrawerOpenedByMobileAsync(data);
    });

    // EVENT 4: Mobile closed cash drawer
    socket.On("cashier:drawer-closed", (data) =>
    {
        Console.WriteLine($"[SocketIO] 🔒 Mobile closed cash drawer: {data}");
        HandleCashDrawerClosedByMobileAsync(data);
    });

    // EVENT 5: Mobile requested assignments (offline recovery)
    socket.On("request:my-assignments", (data) =>
    {
        Console.WriteLine($"[SocketIO] 📋 Mobile requested assignments: {data}");
        HandleAssignmentRequestFromMobileAsync(data);
    });

    // EVENT 6: Expense was synced to Backend
    socket.On("expense:synced", (data) =>
    {
        Console.WriteLine($"[SocketIO] ✓ Expense synced to Backend: {data}");
        NotifyMobileExpenseSyncedAsync(data);
    });

    Console.WriteLine("[SocketIO] ✅ Mobile listeners setup complete");
}
```

#### Method 4: Handle Expense from Mobile
```csharp
private async void HandleExpenseFromMobileAsync(dynamic data)
{
    try
    {
        // Parse incoming data
        int expenseId = data.expenseId;
        int repartidorId = data.repartidorId;
        string description = data.description;
        decimal amount = decimal.Parse(data.amount.ToString());
        string category = data.category;
        DateTime expenseDate = DateTime.Parse(data.expenseDate);

        // Create Expense object
        var expense = new Expense
        {
            RepartidorId = repartidorId,
            TenantId = data.tenantId,
            BranchId = data.branchId,
            Description = description,
            Amount = amount,
            Category = category,
            ExpenseDate = expenseDate,
            Synced = false,  // Will sync to Backend
            RemoteId = null
        };

        // Insert into Desktop SQLite
        using (var connection = new SQLiteConnection("Data Source=local.db"))
        {
            connection.Open();
            string query = @"
                INSERT INTO expenses (repartidor_id, tenant_id, branch_id, description, amount, category, expense_date, synced, remote_id, created_at)
                VALUES (@repartidor_id, @tenant_id, @branch_id, @description, @amount, @category, @expense_date, @synced, @remote_id, @created_at)
            ";

            using (var cmd = new SQLiteCommand(query, connection))
            {
                cmd.Parameters.AddWithValue("@repartidor_id", repartidorId);
                cmd.Parameters.AddWithValue("@tenant_id", data.tenantId);
                cmd.Parameters.AddWithValue("@branch_id", data.branchId);
                cmd.Parameters.AddWithValue("@description", description);
                cmd.Parameters.AddWithValue("@amount", amount);
                cmd.Parameters.AddWithValue("@category", category);
                cmd.Parameters.AddWithValue("@expense_date", expenseDate);
                cmd.Parameters.AddWithValue("@synced", false);
                cmd.Parameters.AddWithValue("@remote_id", DBNull.Value);
                cmd.Parameters.AddWithValue("@created_at", DateTime.Now);

                await cmd.ExecuteNonQueryAsync();
            }
        }

        Console.WriteLine($"[Desktop] ✅ Expense inserted: ${amount} ({category})");

        // IMPORTANT: Immediately sync to Backend
        // Call UnifiedSyncService.SyncPendingExpensesAsync()
        // This will:
        // 1. POST /api/employees/{repartidorId}/expenses
        // 2. Get remote_id from Backend
        // 3. Emit 'expense:synced' back to Mobile
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[Desktop] ❌ Error handling mobile expense: {ex.Message}");
    }
}
```

#### Method 5: Handle Assignment Request from Mobile (Offline Recovery)
```csharp
private async void HandleAssignmentRequestFromMobileAsync(dynamic data)
{
    try
    {
        int repartidorId = data.repartidorId;
        int tenantId = data.tenantId;
        int branchId = data.branchId;
        string mobileSocketId = data.mobileSocketId;  // Route response to this Mobile socket

        Console.WriteLine($"[Desktop] 📋 Mobile {repartidorId} requested assignments");

        // Query Desktop SQLite for pending assignments
        var assignments = new List<dynamic>();

        using (var connection = new SQLiteConnection("Data Source=local.db"))
        {
            connection.Open();
            string query = @"
                SELECT
                    id, repartidor_id, product_id, kilos_asignados,
                    kilos_devueltos, kilos_vendidos, estado, fecha_asignacion
                FROM repartidor_assignments
                WHERE repartidor_id = @repartidor_id
                  AND tenant_id = @tenant_id
                  AND estado IN ('pending', 'returned')
                  AND fecha_asignacion >= date('now', '-1 day')
            ";

            using (var cmd = new SQLiteCommand(query, connection))
            {
                cmd.Parameters.AddWithValue("@repartidor_id", repartidorId);
                cmd.Parameters.AddWithValue("@tenant_id", tenantId);

                using (var reader = await cmd.ExecuteReaderAsync())
                {
                    while (await reader.ReadAsync())
                    {
                        assignments.Add(new
                        {
                            assignmentId = reader["id"],
                            repartidorId = reader["repartidor_id"],
                            productId = reader["product_id"],
                            kilos = reader["kilos_asignados"],
                            kilosDevueltos = reader["kilos_devueltos"],
                            kilosVendidos = reader["kilos_vendidos"],
                            estado = reader["estado"],
                            assignedAt = reader["fecha_asignacion"]
                        });
                    }
                }
            }
        }

        // Send response back to Mobile
        var responsePayload = new
        {
            repartidorId = repartidorId,
            assignments = assignments.ToArray(),
            count = assignments.Count,
            recoveredAt = DateTime.Now.ToUniversalTime().ToString("O")
        };

        // Use mobileSocketId to target specific Mobile socket
        Console.WriteLine($"[Desktop] 📤 Sending {assignments.Count} assignments to Mobile socket {mobileSocketId}");
        socket.Emit("response:my-assignments", responsePayload, ack =>
        {
            Console.WriteLine($"[Desktop] ✅ Assignments sent to Mobile");
        });
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[Desktop] ❌ Error handling assignment request: {ex.Message}");
    }
}
```

#### Method 6: Create Sale from Completed Assignment
```csharp
public async Task CreateSaleFromCompletedAssignmentAsync(dynamic assignment)
{
    try
    {
        // When assignment is completed, create a SALE
        var sale = new Sale
        {
            RepartidorId = assignment.RepartidorId,
            TenantId = assignment.TenantId,
            BranchId = assignment.BranchId,
            ProductId = assignment.ProductId,
            Kilos = assignment.KilosVendidos,  // Only what was actually sold
            PricePerKilo = GetCurrentProductPrice(assignment.ProductId),  // Get from DB
            TotalAmount = assignment.KilosVendidos * GetCurrentProductPrice(assignment.ProductId),
            AssignmentId = assignment.Id,
            SaleDate = DateTime.Now,
            Synced = false,  // Will sync to Backend
            RemoteId = null
        };

        // Insert into Desktop SQLite
        using (var connection = new SQLiteConnection("Data Source=local.db"))
        {
            connection.Open();
            string query = @"
                INSERT INTO sales (repartidor_id, tenant_id, branch_id, product_id, kilos, price_per_kilo, total_amount, assignment_id, sale_date, synced, remote_id, created_at)
                VALUES (@repartidor_id, @tenant_id, @branch_id, @product_id, @kilos, @price_per_kilo, @total_amount, @assignment_id, @sale_date, @synced, @remote_id, @created_at)
            ";

            using (var cmd = new SQLiteCommand(query, connection))
            {
                cmd.Parameters.AddWithValue("@repartidor_id", sale.RepartidorId);
                cmd.Parameters.AddWithValue("@tenant_id", sale.TenantId);
                cmd.Parameters.AddWithValue("@branch_id", sale.BranchId);
                cmd.Parameters.AddWithValue("@product_id", sale.ProductId);
                cmd.Parameters.AddWithValue("@kilos", sale.Kilos);
                cmd.Parameters.AddWithValue("@price_per_kilo", sale.PricePerKilo);
                cmd.Parameters.AddWithValue("@total_amount", sale.TotalAmount);
                cmd.Parameters.AddWithValue("@assignment_id", sale.AssignmentId);
                cmd.Parameters.AddWithValue("@sale_date", sale.SaleDate);
                cmd.Parameters.AddWithValue("@synced", false);
                cmd.Parameters.AddWithValue("@remote_id", DBNull.Value);
                cmd.Parameters.AddWithValue("@created_at", DateTime.Now);

                await cmd.ExecuteNonQueryAsync();
            }
        }

        Console.WriteLine($"[Desktop] ✅ Sale created: {sale.Kilos}kg @ ${sale.PricePerKilo} = ${sale.TotalAmount}");

        // Trigger sync to Backend
        // Call UnifiedSyncService.SyncPendingSalesAsync()
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[Desktop] ❌ Error creating sale: {ex.Message}");
    }
}
```

---

### STEP 2: Add Listeners to UnifiedSyncService

**File:** `SyaTortilleriasWinUi/Services/UnifiedSyncService.cs`

**In the constructor or initialization method:**

```csharp
public UnifiedSyncService(SocketIOService socketIOService, IDataService dataService)
{
    this.socketIOService = socketIOService;
    this.dataService = dataService;

    // Setup all Socket.IO listeners
    this.socketIOService.SetupMobileListeners();
}
```

**Add methods for handling Mobile events:**

```csharp
private async void HandleExpenseFromMobileAsync(dynamic data)
{
    // Delegate to SocketIOService
    // (Already implemented above in Step 1, Method 4)
    await SyncExpenseToBackendAsync(data);
}

private async void HandleAssignmentCompletionFromMobileAsync(dynamic data)
{
    // When Mobile marks assignment complete, create sale
    var assignment = new
    {
        Id = data.assignmentId,
        RepartidorId = data.repartidorId,
        KilosDevueltos = data.kilosDevueltos,
        KilosVendidos = data.kilosVendidos
    };

    await socketIOService.CreateSaleFromCompletedAssignmentAsync(assignment);
    await SyncPendingSalesAsync();
}

private async void HandleCashDrawerOpenedByMobileAsync(dynamic data)
{
    // Mobile opened cash drawer, save locally
    using (var connection = new SQLiteConnection("Data Source=local.db"))
    {
        connection.Open();
        string query = @"
            INSERT INTO cash_drawers (repartidor_id, tenant_id, branch_id, initial_amount, opened_at, estado)
            VALUES (@repartidor_id, @tenant_id, @branch_id, @initial_amount, @opened_at, 'open')
        ";

        using (var cmd = new SQLiteCommand(query, connection))
        {
            cmd.Parameters.AddWithValue("@repartidor_id", data.repartidorId);
            cmd.Parameters.AddWithValue("@tenant_id", data.tenantId);
            cmd.Parameters.AddWithValue("@branch_id", data.branchId);
            cmd.Parameters.AddWithValue("@initial_amount", data.initialAmount);
            cmd.Parameters.AddWithValue("@opened_at", data.openedAt);

            await cmd.ExecuteNonQueryAsync();
        }
    }
}

private async void HandleCashDrawerClosedByMobileAsync(dynamic data)
{
    // Mobile closed cash drawer
    using (var connection = new SQLiteConnection("Data Source=local.db"))
    {
        connection.Open();
        string query = @"
            UPDATE cash_drawers
            SET final_amount = @final_amount, closed_at = @closed_at, estado = 'closed'
            WHERE id = @id
        ";

        using (var cmd = new SQLiteCommand(query, connection))
        {
            cmd.Parameters.AddWithValue("@final_amount", data.finalAmount);
            cmd.Parameters.AddWithValue("@closed_at", data.closedAt);
            cmd.Parameters.AddWithValue("@id", data.drawerId);

            await cmd.ExecuteNonQueryAsync();
        }
    }
}
```

---

### STEP 3: Call Broadcasting Methods When Creating Assignments

**File:** Where assignments are created (RepartidoresViewModel or AssignmentService)

**When Owner creates assignment:**
```csharp
// Create assignment
var assignment = new RepartidorAssignment { ... };
await databaseService.InsertAsync(assignment);

// BROADCAST to Mobile
socketIOService.BroadcastAssignmentCreatedAsync(assignment);
```

**When assignment is completed:**
```csharp
// Update assignment
assignment.KilosDevueltos = returnedKilos;
assignment.KilosVendidos = soldKilos;
assignment.Estado = "completed";
await databaseService.UpdateAsync(assignment);

// BROADCAST to Mobile
socketIOService.BroadcastAssignmentCompletedAsync(assignment);

// CREATE sale
await CreateSaleFromCompletedAssignmentAsync(assignment);
```

---

### STEP 4: Call Broadcasting Methods When Opening Cash Drawer

**File:** Where cash drawer opening happens (CashDrawerViewModel or similar)

**When Owner opens cash drawer:**
```csharp
// Create cash drawer record
var cashDrawer = new CashDrawer
{
    RepartidorId = selectedRepartidorId,
    InitialAmount = openingAmount,
    OpenedAt = DateTime.Now,
    Estado = "open"
};
await databaseService.InsertAsync(cashDrawer);

// BROADCAST to Mobile
var repartidor = await databaseService.GetAsync<Employee>(selectedRepartidorId);
socketIOService.BroadcastCashDrawerOpenedAsync(cashDrawer, repartidor.FullName);
```

---

## SQLite Schema Updates Required

Make sure you have these tables:

```sql
-- If not exists
CREATE TABLE IF NOT EXISTS repartidor_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    repartidor_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    kilos_asignados REAL NOT NULL,
    kilos_devueltos REAL,
    kilos_vendidos REAL,
    estado TEXT DEFAULT 'pending',
    fecha_asignacion DATETIME DEFAULT CURRENT_TIMESTAMP,
    fecha_devolucion DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    repartidor_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    kilos REAL NOT NULL,
    price_per_kilo REAL NOT NULL,
    total_amount REAL NOT NULL,
    assignment_id INTEGER,
    sale_date DATETIME NOT NULL,
    synced BOOLEAN DEFAULT false,
    remote_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    repartidor_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    expense_date DATETIME NOT NULL,
    synced BOOLEAN DEFAULT false,
    remote_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cash_drawers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    repartidor_id INTEGER NOT NULL,
    initial_amount REAL NOT NULL,
    final_amount REAL,
    opened_at DATETIME NOT NULL,
    closed_at DATETIME,
    estado TEXT DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Testing Checklist

After implementing, test:

- [ ] Create assignment in Desktop
  - [ ] Mobile receives event "repartidor:assignment-created"
  - [ ] Mobile dashboard shows assignment

- [ ] Complete assignment (return kilos) in Desktop
  - [ ] Mobile receives "repartidor:assignment-completed"
  - [ ] Desktop creates sale in SQLite
  - [ ] Expense syncs to Backend

- [ ] Register expense in Mobile
  - [ ] Backend receives "repartidor:expense-created"
  - [ ] Desktop receives forwarded event
  - [ ] Desktop syncs to Backend via REST
  - [ ] Backend stores in PostgreSQL

- [ ] Open cash drawer in Desktop
  - [ ] Mobile receives "cashier:drawer-opened"
  - [ ] Mobile shows "$XXX caja abierta"

- [ ] Close cash drawer in Mobile
  - [ ] Backend receives "cashier:drawer-closed"
  - [ ] Desktop receives forwarded event

- [ ] Mobile offline, then reconnects
  - [ ] Mobile emits "request:my-assignments"
  - [ ] Desktop responds with all assignments
  - [ ] Mobile dashboard shows assignments

---

## Troubleshooting

### ❌ Mobile doesn't receive assignment event
- Check: Is Desktop connected to Socket.IO?
- Check: Is SocketIOService.BroadcastAssignmentCreatedAsync being called?
- Check: Is branchId correct?
- Backend logs: Look for `[ASSIGN]` events

### ❌ Desktop doesn't receive mobile expense event
- Check: Is SetupMobileListeners() being called?
- Check: Is listener code correct?
- Backend logs: Should see `[EXPENSE] 💸 Repartidor X registró gasto`

### ❌ Sale not syncing to Backend
- Check: Is UnifiedSyncService.SyncPendingSalesAsync() being called?
- Check: Is POST /api/sales endpoint working?
- Check: Backend response has remote_id?

---

## Summary

**Phase 1B adds to Desktop:**
- ✅ Broadcast assignment events to Mobile
- ✅ Listen for mobile events (forwarded by Backend)
- ✅ Process mobile events (insert into SQLite)
- ✅ Create sales from completed assignments
- ✅ Sync sales to Backend via REST API

**After Phase 1B:**
- Desktop fully integrated with Mobile & Backend
- Ready for Phase 2 (Mobile implementation)

**Estimated time:** 2-3 days

