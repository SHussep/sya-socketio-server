# Server-First Multi-Caja Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all Desktop operations to server-first when `multi_caja_enabled = true`, using SQLite as cache, with offline fallback and credit blocking.

**Architecture:** When MultiCajaEnabled, Desktop tries POST to server first; on network error, falls to offline queue (except credit/cancellation/credit-notes which are blocked offline). Master data reads use SQLite with 2-min TTL cache + socket event invalidation. On reconnect, offline queue drains in dependency order before resuming server-first mode.

**Tech Stack:** Node.js/Express/PostgreSQL (backend), C#/WinUI/SQLite (Desktop), Socket.IO (real-time)

**Spec:** `docs/superpowers/specs/2026-03-27-server-first-multi-caja-design.md`

**Repos:**
- Backend: `C:\SYA\sya-socketio-server` (push to `origin/main`)
- Desktop: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi`

---

## Phase 1: Foundation Infrastructure

### Task 1: Backend — Health Check Endpoint

**Files:**
- Create: `routes/health.js`
- Modify: `server.js` (register route)

- [ ] **Step 1: Create health route**

Follow codebase pattern where routes receive `pool` as parameter:

```javascript
// routes/health.js
const express = require('express');
const router = express.Router();

module.exports = function healthRoutes(pool) {
    router.get('/', async (req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok' });
        } catch (err) {
            res.status(503).json({ status: 'error', message: 'Database unreachable' });
        }
    });
    return router;
};
```

- [ ] **Step 2: Register in server.js**

Find where routes are registered (e.g., `app.use('/api/deposits', ...)`). Add:

```javascript
app.use('/api/health', require('./routes/health')(pool));  // No auth required
```

Also in this step: **update route registrations** to pass `io` to routes that will need socket emissions later. Find these registrations and add `io` parameter:

```javascript
// These routes currently receive only (pool). Change to (pool, io):
// credit-payments, purchases, suppliers, cancelaciones, notas-credito
// Example: change creditPaymentsRoutes(pool) → creditPaymentsRoutes(pool, io)
```

Update each route file's `module.exports` signature to accept `io` as second parameter. Routes that already have `io` (like expenses, deposits) don't need changes.

- [ ] **Step 3: Test manually**

```bash
curl http://localhost:3000/api/health
# Expected: {"status":"ok"}
```

- [ ] **Step 4: Commit and push**

```bash
git add routes/health.js server.js
git commit -m "feat: add /api/health endpoint for Desktop connectivity detection"
git push origin main
```

---

### Task 2: Desktop — ServerHealthService

**Files:**
- Create: `Services/ServerHealthService.cs`
- Create: `Services/Interfaces/IServerHealthService.cs`
- Modify: `App.xaml.cs` (DI registration)

**Context:** This service pings `GET /api/health` every 30s and exposes `IsServerReachable`. It also gets updated opportunistically when any HTTP call succeeds/fails. ViewModels bind to `ServerReachabilityChanged` event to enable/disable credit options.

- [ ] **Step 1: Create interface**

```csharp
// Services/Interfaces/IServerHealthService.cs
namespace SyaTortilleriasWinUi.Services.Interfaces;

public interface IServerHealthService
{
    bool IsServerReachable { get; }
    event Action<bool> ServerReachabilityChanged;
    void MarkOnline();
    void MarkOffline();
    Task StartMonitoringAsync();
    void StopMonitoring();
}
```

- [ ] **Step 2: Create implementation**

```csharp
// Services/ServerHealthService.cs
using System.Net.Http;
using SyaTortilleriasWinUi.Services.Interfaces;

namespace SyaTortilleriasWinUi.Services;

public class ServerHealthService : IServerHealthService
{
    private readonly HttpClient _httpClient;
    private readonly UserConfigService _userConfigService;
    private readonly Microsoft.UI.Dispatching.DispatcherQueue _dispatcherQueue;
    private CancellationTokenSource _cts;
    private volatile int _consecutiveFailures = 0;
    private volatile bool _isServerReachable = true;

    public bool IsServerReachable => _isServerReachable;
    public event Action<bool> ServerReachabilityChanged;

    public ServerHealthService(HttpClient httpClient, UserConfigService userConfigService)
    {
        _httpClient = httpClient;
        _userConfigService = userConfigService;
    }

    public void MarkOnline()
    {
        _consecutiveFailures = 0;
        if (!_isServerReachable)
        {
            _isServerReachable = true;
            _dispatcherQueue?.TryEnqueue(() => ServerReachabilityChanged?.Invoke(true));
        }
    }

    public void MarkOffline()
    {
        _consecutiveFailures++;
        if (_consecutiveFailures >= 2 && _isServerReachable)
        {
            _isServerReachable = false;
            _dispatcherQueue?.TryEnqueue(() => ServerReachabilityChanged?.Invoke(false));
        }
    }

    public async Task StartMonitoringAsync()
    {
        _cts = new CancellationTokenSource();
        while (!_cts.Token.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(30_000, _cts.Token);
                var response = await _httpClient.GetAsync("/api/health", _cts.Token);
                if (response.IsSuccessStatusCode)
                    MarkOnline();
                else
                    MarkOffline();
            }
            catch (OperationCanceledException) { break; }
            catch { MarkOffline(); }
        }
    }

    public void StopMonitoring()
    {
        _cts?.Cancel();
    }
}
```

- [ ] **Step 3: Register in DI container**

In `App.xaml.cs`, find where services are registered (look for `services.AddSingleton<ISessionService>`). Add:

```csharp
services.AddSingleton<IServerHealthService, ServerHealthService>();
```

- [ ] **Step 4: Start monitoring when shift opens**

In `ShellViewModel.cs`, after successful shift open, call:
```csharp
_ = _serverHealthService.StartMonitoringAsync();
```

Stop in `EndSession()`:
```csharp
_serverHealthService.StopMonitoring();
```

- [ ] **Step 5: Commit**

```bash
git add Services/ServerHealthService.cs Services/Interfaces/IServerHealthService.cs App.xaml.cs
git commit -m "feat: add ServerHealthService for multi-caja connectivity detection"
```

---

### Task 3: Desktop — CacheService

**Files:**
- Create: `Services/CacheService.cs`
- Create: `Services/Interfaces/ICacheService.cs`
- Modify: `App.xaml.cs` (DI registration)

**Context:** Manages TTL (2 min) per entity type. When socket events arrive (e.g., `customer_updated`), invalidates that entity's cache. Domain services check `IsCacheFresh("customers")` before deciding whether to re-pull from server.

- [ ] **Step 1: Create interface**

```csharp
// Services/Interfaces/ICacheService.cs
namespace SyaTortilleriasWinUi.Services.Interfaces;

public interface ICacheService
{
    bool IsCacheFresh(string entityType);
    void MarkCacheRefreshed(string entityType);
    void InvalidateCache(string entityType);
    void InvalidateAllCaches();
}
```

- [ ] **Step 2: Create implementation**

```csharp
// Services/CacheService.cs
using System.Collections.Concurrent;
using SyaTortilleriasWinUi.Services.Interfaces;

namespace SyaTortilleriasWinUi.Services;

public class CacheService : ICacheService
{
    private static readonly TimeSpan DefaultTtl = TimeSpan.FromMinutes(2);
    private readonly ConcurrentDictionary<string, DateTime> _lastRefreshed = new();

    public bool IsCacheFresh(string entityType)
    {
        if (_lastRefreshed.TryGetValue(entityType, out var lastTime))
            return (DateTime.UtcNow - lastTime) < DefaultTtl;
        return false;
    }

    public void MarkCacheRefreshed(string entityType)
    {
        _lastRefreshed[entityType] = DateTime.UtcNow;
    }

    public void InvalidateCache(string entityType)
    {
        _lastRefreshed.TryRemove(entityType, out _);
    }

    public void InvalidateAllCaches()
    {
        _lastRefreshed.Clear();
    }
}
```

- [ ] **Step 3: Register in DI and wire socket events**

In `App.xaml.cs`:
```csharp
services.AddSingleton<ICacheService, CacheService>();
```

In `SocketIOService.cs`, in the existing `customer_updated` and `product_updated` handlers, add cache invalidation:
```csharp
_cacheService.InvalidateCache("customers");
// and
_cacheService.InvalidateCache("products");
```

This requires injecting `ICacheService` into `SocketIOService`.

- [ ] **Step 4: Commit**

```bash
git add Services/CacheService.cs Services/Interfaces/ICacheService.cs App.xaml.cs
git commit -m "feat: add CacheService with TTL for multi-caja master data caching"
```

---

### Task 4: Desktop — Credit Offline Block UI

**Files:**
- Modify: `ViewModels/VentasViewModel.cs` (payment method disable logic)

**Context:** When `MultiCajaEnabled && !IsServerReachable`, disable credit payment option in the UI. The VentasViewModel controls which payment methods are available. We need to inject `IServerHealthService`, subscribe to `ServerReachabilityChanged`, and disable the credit option.

- [ ] **Step 1: Add IServerHealthService dependency to VentasViewModel**

In `VentasViewModel.cs` constructor, add `IServerHealthService serverHealthService` parameter. Store as `_serverHealthService`.

- [ ] **Step 2: Add property for credit availability**

```csharp
private bool _isCreditPaymentAvailable = true;
public bool IsCreditPaymentAvailable
{
    get => _isCreditPaymentAvailable;
    set { _isCreditPaymentAvailable = value; OnPropertyChanged(); }
}
```

- [ ] **Step 3: Subscribe to reachability changes**

In the constructor or initialization method:
```csharp
_serverHealthService.ServerReachabilityChanged += (isReachable) =>
{
    if (_sessionService.MultiCajaEnabled)
    {
        IsCreditPaymentAvailable = isReachable;
        if (!isReachable && /* current payment method is credit */)
        {
            // Auto-switch to cash, show notification
        }
    }
};
```

- [ ] **Step 4: Use IsCreditPaymentAvailable in XAML**

In the payment method selector (find where payment buttons are rendered), bind `IsEnabled` to `IsCreditPaymentAvailable` for the credit option. Add a tooltip "Requiere conexion a internet" when disabled.

- [ ] **Step 5: Also block cancellations and credit notes offline**

Find the cancellation ViewModel and credit note ViewModel. Add similar checks:
```csharp
if (_sessionService.MultiCajaEnabled && !_serverHealthService.IsServerReachable)
{
    // Show dialog: "Requiere conexion a internet para cancelaciones en modo multi-caja"
    return;
}
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: block credit/cancellation/credit-notes offline in multi-caja mode"
```

---

## Phase 2: Transactional Entities Server-First

### Task 5: Backend — Expenses Server-First Improvements

**Files:**
- Modify: `routes/expenses.js` (verify/fix direct POST, add pull endpoint)

**Context:** `POST /api/expenses` already exists (creates expense with email-based employee lookup). We need to: (a) ensure it generates `global_id`, (b) add `GET /api/expenses/pull` for incremental sync, (c) align idempotency to `DO NOTHING`.

- [ ] **Step 1: Fix POST /api/expenses for server-first**

Read `routes/expenses.js` POST handler. **Known bugs to fix:**

1. **global_id always regenerated**: Line ~262 uses `uuidv4()` unconditionally. Change to accept from request body for idempotency:
```javascript
const globalId = req.body.global_id || uuidv4();
```

2. **employeeId not accepted directly**: Desktop knows the employee ID. Add as alternative to `userEmail`:
```javascript
let employeeId = req.body.employeeId;
if (!employeeId && req.body.userEmail) {
    // existing email lookup
}
```

3. **Add expense_created socket emission** after successful insert (the existing `expense_assigned` event is for a different purpose):
```javascript
if (io) {
    io.to(`branch_${branchId}`).emit('expense_created', {
        expenseId: newExpense.id,
        globalId: newExpense.global_id,
        amount: parseFloat(amount),
        branchId,
        source: 'server_first'
    });
}
```

Verify it returns `{ success: true, data: { id, global_id, ... } }`

- [ ] **Step 2: Add shiftId parameter support**

Verify the POST accepts `shiftId` directly (Desktop knows the shift remote ID). If it only auto-finds the open shift, add:
```javascript
let shiftId = req.body.shiftId;
if (!shiftId && employeeId) {
    // existing auto-find open shift logic
}
```

- [ ] **Step 3: Create GET /api/expenses/pull endpoint**

Follow the exact pattern from `routes/deposits.js` pull endpoint:

```javascript
// GET /api/expenses/pull?since=ISO&branch_id=N&limit=500
router.get('/pull', authenticateToken, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const branchId = req.query.branch_id || req.user.branchId;
        const since = req.query.since || '1970-01-01T00:00:00Z';
        const limit = Math.min(parseInt(req.query.limit) || 500, 1000);

        const result = await pool.query(`
            SELECT e.*,
                   emp.global_id as employee_global_id,
                   s.global_id as shift_global_id
            FROM expenses e
            LEFT JOIN employees emp ON e.employee_id = emp.id
            LEFT JOIN shifts s ON e.id_turno = s.id
            WHERE e.tenant_id = $1 AND e.branch_id = $2
              AND e.created_at > $3
            ORDER BY e.created_at ASC
            LIMIT $4
        `, [tenantId, branchId, since, limit]);

        const lastSync = result.rows.length > 0
            ? result.rows[result.rows.length - 1].created_at
            : since;

        res.json({
            success: true,
            data: { expenses: result.rows, last_sync: lastSync },
            count: result.rows.length
        });
    } catch (err) {
        console.error('[Expenses Pull]', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});
```

- [ ] **Step 4: Commit and push**

```bash
git add routes/expenses.js
git commit -m "feat: improve expenses endpoint for server-first + add /pull"
git push origin main
```

---

### Task 6: Desktop — Expenses Server-First

**Files:**
- Modify: `Services/BackendSyncService.cs` (add `CreateExpenseServerFirstAsync`)
- Modify: `Services/ExpenseService.cs` (add multi-caja branch)

**Context:** Follow the exact pattern of `CreateDepositServerFirstAsync` (line ~2451 in BackendSyncService.cs). ExpenseService.RegisterExpenseForShiftAsync is the main create method (line ~99).

- [ ] **Step 1: Add CreateExpenseServerFirstAsync to BackendSyncService**

```csharp
public async Task<JsonElement?> CreateExpenseServerFirstAsync(object expensePayload)
{
    var request = await CreateAuthenticatedRequest(HttpMethod.Post, "/api/expenses");
    request.Content = new StringContent(
        JsonSerializer.Serialize(expensePayload),
        Encoding.UTF8, "application/json");

    var response = await _httpClient.SendAsync(request);
    var body = await response.Content.ReadAsStringAsync();
    using var doc = JsonDocument.Parse(body);
    var json = doc.RootElement;

    if (response.IsSuccessStatusCode &&
        json.TryGetProperty("success", out var s) && s.GetBoolean() &&
        json.TryGetProperty("data", out var data))
    {
        return data.Clone();
    }

    var msg = json.TryGetProperty("message", out var m) ? m.GetString() : "Error al crear gasto";
    throw new Exception(msg);
}
```

Add to `IBackendSyncService` interface:
```csharp
Task<JsonElement?> CreateExpenseServerFirstAsync(object expensePayload);
```

- [ ] **Step 2: Modify ExpenseService.RegisterExpenseForShiftAsync**

Add the try-POST-catch-fallback pattern at the beginning of the method, before the existing local insert:

```csharp
public async Task<Expense> RegisterExpenseForShiftAsync(Expense expense)
{
    // ... existing validation ...

    if (_sessionService.MultiCajaEnabled)
    {
        // Prepare GlobalId first (needed for idempotency)
        if (string.IsNullOrWhiteSpace(expense.GlobalId))
            await _databaseService.PrepareExpenseForInsertAsync(expense);

        try
        {
            var payload = new
            {
                tenantId = _sessionService.CurrentTenant.RemoteId,
                branchId = _sessionService.CurrentBranch.RemoteId,
                employeeId = _sessionService.CurrentUser.RemoteId,
                shiftId = _sessionService.CurrentShift?.RemoteId,
                global_category_id = expense.GlobalCategoryId,
                description = expense.Description,
                amount = expense.Amount,
                global_id = expense.GlobalId,
                terminal_id = expense.TerminalId,
                created_local_utc = expense.CreatedLocalUtc
            };

            var serverResult = await _backendSyncService.CreateExpenseServerFirstAsync(payload);
            if (serverResult.HasValue && serverResult.Value.TryGetProperty("id", out var idProp))
            {
                expense.RemoteId = idProp.GetInt32();
                expense.Synced = true;
                expense.NeedsUpdate = false;
            }

            _serverHealthService.MarkOnline();
        }
        catch (HttpRequestException ex) when (ex.StatusCode == null || (int)ex.StatusCode >= 500)
        {
            // Network error or 5xx → offline queue
            _serverHealthService.MarkOffline();
            expense.Synced = false;
            expense.PendingServer = true;
        }
        catch (Exception)
        {
            // 4xx or other error → don't queue, bubble up to UI
            throw;
        }
    }
    else
    {
        if (string.IsNullOrWhiteSpace(expense.GlobalId))
            await _databaseService.PrepareExpenseForInsertAsync(expense);
    }

    // Save to SQLite (as cache if server-first succeeded, or as offline queue)
    expense.Status = "confirmed";
    if (expense.DateTicks == 0) expense.Date = DateTime.Now;
    await db.InsertAsync(expense);
    return expense;
}
```

**Note:** This requires adding `IServerHealthService` and `IBackendSyncService` to `ExpenseService` constructor injection.

- [ ] **Step 3: Add PendingServer property to Expense model**

Check if the `Expense` model already has a `PendingServer` property. If not, add:
```csharp
public bool PendingServer { get; set; }
```

This field tracks entities created locally that need to be POSTed to server when reconnecting. It's different from `Synced` (which tracks whether the entity has been sync'd via the normal sync flow).

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: expense server-first creation in multi-caja mode"
```

---

### Task 7: Backend — Credit Payments Direct Creation Endpoint

**Files:**
- Modify: `routes/credit-payments.js` (add `POST /` for single-item creation)

**Context:** Currently only `POST /api/credit-payments/sync` exists (batch). We need a direct single-item `POST /api/credit-payments` for server-first mode. Follow the deposit direct creation pattern.

- [ ] **Step 1: Add POST / endpoint**

```javascript
// POST /api/credit-payments — Direct server-first creation
router.post('/', authenticateToken, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { branchId, customerId, customer_global_id, shiftId, shift_global_id,
                employeeId, employee_global_id, amount, paymentMethod, notes,
                global_id, terminal_id, created_local_utc } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Amount must be > 0' });
        }

        // Resolve global IDs to PG IDs
        let finalCustomerId = customerId;
        if (!finalCustomerId && customer_global_id) {
            const r = await pool.query(
                'SELECT id FROM customers WHERE global_id = $1 AND tenant_id = $2',
                [customer_global_id, tenantId]);
            if (r.rows.length > 0) finalCustomerId = r.rows[0].id;
        }
        if (!finalCustomerId) {
            return res.status(400).json({ success: false, message: 'Customer not found' });
        }

        let finalShiftId = shiftId;
        if (!finalShiftId && shift_global_id) {
            const r = await pool.query(
                'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                [shift_global_id, tenantId]);
            if (r.rows.length > 0) finalShiftId = r.rows[0].id;
        }

        let finalEmployeeId = employeeId || req.user.employeeId;
        if (!finalEmployeeId && employee_global_id) {
            const r = await pool.query(
                'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                [employee_global_id, tenantId]);
            if (r.rows.length > 0) finalEmployeeId = r.rows[0].id;
        }

        const finalGlobalId = global_id || require('uuid').v4();

        // Idempotency: DO NOTHING on conflict
        const result = await pool.query(`
            INSERT INTO credit_payments (
                tenant_id, branch_id, customer_id, shift_id, employee_id,
                amount, payment_method, payment_date, notes,
                global_id, terminal_id, created_local_utc
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11)
            ON CONFLICT (global_id) DO NOTHING
            RETURNING *
        `, [tenantId, branchId || req.user.branchId, finalCustomerId, finalShiftId,
            finalEmployeeId, amount, paymentMethod || 'cash', notes,
            finalGlobalId, terminal_id, created_local_utc]);

        let paymentRow;
        if (result.rows.length > 0) {
            paymentRow = result.rows[0];
        } else {
            // Already existed — fetch existing
            const existing = await pool.query(
                'SELECT * FROM credit_payments WHERE global_id = $1', [finalGlobalId]);
            paymentRow = existing.rows[0];
        }

        // Socket notification
        if (io) {
            const roomName = `branch_${paymentRow.branch_id}`;
            io.to(roomName).emit('credit_payment_created', {
                paymentId: paymentRow.id,
                customerId: paymentRow.customer_id,
                amount: parseFloat(paymentRow.amount),
                branchId: paymentRow.branch_id
            });
        }

        res.status(201).json({ success: true, data: paymentRow });
    } catch (err) {
        console.error('[CreditPayments] POST error:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});
```

- [ ] **Step 2: Add GET /pull endpoint**

```javascript
router.get('/pull', authenticateToken, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const branchId = req.query.branch_id || req.user.branchId;
        const since = req.query.since || '1970-01-01T00:00:00Z';
        const limit = Math.min(parseInt(req.query.limit) || 500, 1000);

        const result = await pool.query(`
            SELECT cp.*,
                   c.global_id as customer_global_id,
                   emp.global_id as employee_global_id,
                   s.global_id as shift_global_id
            FROM credit_payments cp
            LEFT JOIN customers c ON cp.customer_id = c.id
            LEFT JOIN employees emp ON cp.employee_id = emp.id
            LEFT JOIN shifts s ON cp.shift_id = s.id
            WHERE cp.tenant_id = $1 AND cp.branch_id = $2
              AND cp.created_at > $3
            ORDER BY cp.created_at ASC
            LIMIT $4
        `, [tenantId, branchId, since, limit]);

        const lastSync = result.rows.length > 0
            ? result.rows[result.rows.length - 1].created_at
            : since;

        res.json({
            success: true,
            data: { credit_payments: result.rows, last_sync: lastSync },
            count: result.rows.length
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
```

**Important:** Place the `GET /pull` route BEFORE `GET /customer/:customerId` to avoid route conflicts.

- [ ] **Step 3: Commit and push**

```bash
git add routes/credit-payments.js
git commit -m "feat: add direct POST + /pull for credit-payments (server-first)"
git push origin main
```

---

### Task 8: Desktop — Credit Payments Server-First

**Files:**
- Modify: `Services/BackendSyncService.cs` (add `CreateCreditPaymentServerFirstAsync`)
- Modify: The service/ViewModel that handles credit payment creation (find via grep for `credit_payment` or `CreditPayment`)

**Context:** Same pattern as Task 6. Add `CreateCreditPaymentServerFirstAsync` to BackendSyncService, then add multi-caja branch in the domain service.

- [ ] **Step 1: Add CreateCreditPaymentServerFirstAsync to BackendSyncService**

```csharp
public async Task<JsonElement?> CreateCreditPaymentServerFirstAsync(object payload)
{
    var request = await CreateAuthenticatedRequest(HttpMethod.Post, "/api/credit-payments");
    request.Content = new StringContent(
        JsonSerializer.Serialize(payload),
        Encoding.UTF8, "application/json");

    var response = await _httpClient.SendAsync(request);
    var body = await response.Content.ReadAsStringAsync();
    using var doc = JsonDocument.Parse(body);
    var json = doc.RootElement;

    if (response.IsSuccessStatusCode &&
        json.TryGetProperty("success", out var s) && s.GetBoolean() &&
        json.TryGetProperty("data", out var data))
    {
        return data.Clone();
    }

    var msg = json.TryGetProperty("message", out var m) ? m.GetString() : "Error al crear pago de credito";
    throw new Exception(msg);
}
```

Add to interface.

- [ ] **Step 2: Add multi-caja branch in credit payment creation**

Find the method that creates credit payments. Apply try-POST-catch-fallback pattern. Credit payments are **blocked offline** in multi-caja:

```csharp
if (_sessionService.MultiCajaEnabled)
{
    if (!_serverHealthService.IsServerReachable)
    {
        throw new InvalidOperationException("Pagos de credito requieren conexion a internet en modo multi-caja");
    }

    try
    {
        var payload = new { /* customer_global_id, amount, shiftId, etc. */ };
        var result = await _backendSyncService.CreateCreditPaymentServerFirstAsync(payload);
        // Parse RemoteId, set Synced=true, save to SQLite as cache
        _serverHealthService.MarkOnline();
    }
    catch (HttpRequestException)
    {
        _serverHealthService.MarkOffline();
        throw new InvalidOperationException("Se perdio la conexion. Pago de credito no procesado.");
    }
}
```

**Note:** Credit payments do NOT fall to offline queue — they throw an error if server is unreachable.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: credit payment server-first (blocked offline in multi-caja)"
```

---

### Task 9: Backend — Purchases Pull Endpoint

**Files:**
- Modify: `routes/purchases.js` (add `GET /pull`, verify POST direct creation)

**Context:** `POST /api/purchases` already exists for direct creation. Need to: (a) verify it generates `global_id`, (b) add pull endpoint.

- [ ] **Step 1: Verify POST /api/purchases generates global_id**

Read the existing POST handler. If it doesn't generate `global_id`, add:
```javascript
const globalId = req.body.global_id || require('uuid').v4();
```

And include in the INSERT statement.

- [ ] **Step 2: Add GET /api/purchases/pull endpoint**

Same pattern as expenses/deposits pull:

```javascript
router.get('/pull', authenticateToken, async (req, res) => {
    const tenantId = req.user.tenantId;
    const branchId = req.query.branch_id || req.user.branchId;
    const since = req.query.since || '1970-01-01T00:00:00Z';
    const limit = Math.min(parseInt(req.query.limit) || 500, 1000);

    const result = await pool.query(`
        SELECT p.*,
               s.global_id as supplier_global_id,
               emp.global_id as employee_global_id
        FROM purchases p
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        LEFT JOIN employees emp ON p.employee_id = emp.id
        WHERE p.tenant_id = $1 AND p.branch_id = $2
          AND p.created_at > $3
        ORDER BY p.created_at ASC
        LIMIT $4
    `, [tenantId, branchId, since, limit]);

    const lastSync = result.rows.length > 0
        ? result.rows[result.rows.length - 1].created_at : since;

    res.json({
        success: true,
        data: { purchases: result.rows, last_sync: lastSync },
        count: result.rows.length
    });
});
```

**Important:** Place BEFORE any `GET /:id` routes to avoid param conflicts.

- [ ] **Step 3: Commit and push**

```bash
git add routes/purchases.js
git commit -m "feat: add /pull endpoint for purchases, verify global_id on POST"
git push origin main
```

---

### Task 10: Desktop — Purchases Server-First

**Files:**
- Modify: `Services/BackendSyncService.cs` (add `CreatePurchaseServerFirstAsync`)
- Modify: `Services/PurchaseService.cs` (add multi-caja branch in `SavePurchaseAsync`)

- [ ] **Step 1: Add CreatePurchaseServerFirstAsync to BackendSyncService**

Same pattern as deposits. Endpoint: `POST /api/purchases`. Add to interface.

- [ ] **Step 2: Modify PurchaseService.SavePurchaseAsync**

Add try-POST-catch-fallback before existing local insert (line ~35 of PurchaseService.cs):

```csharp
if (_sessionService.MultiCajaEnabled)
{
    if (string.IsNullOrWhiteSpace(purchase.GlobalId))
        await _databaseService.PreparePurchaseForInsertAsync(purchase);

    try
    {
        var payload = new
        {
            tenantId = _sessionService.CurrentTenant.RemoteId,
            branchId = _sessionService.CurrentBranch.RemoteId,
            supplierId = purchase.SupplierId,  // TODO: may need RemoteId
            employeeId = _sessionService.CurrentUser.RemoteId,
            totalAmount = purchase.TotalAmount,
            paymentStatus = purchase.PaymentStatus,
            notes = purchase.Notes,
            global_id = purchase.GlobalId,
            terminal_id = purchase.TerminalId
        };
        var serverResult = await _backendSyncService.CreatePurchaseServerFirstAsync(payload);
        // Parse RemoteId, set Synced=true
        _serverHealthService.MarkOnline();
    }
    catch (HttpRequestException)
    {
        _serverHealthService.MarkOffline();
        purchase.PendingServer = true;
    }
}
// Continue with existing SQLite insert...
```

- [ ] **Step 3: Add PendingServer to Purchase model if missing**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: purchase server-first creation in multi-caja mode"
```

---

### Task 11: Backend — Cancellations and Credit Notes Endpoints

**Files:**
- Modify: `routes/cancelaciones.js` (registered at `/api/cancelaciones` in server.js)
- Modify: `routes/notas_credito.js` (registered at `/api/notas-credito` in server.js)
- Modify: `server.js` (pass `io` to both routes if not already done in Task 1)

**Context:** These routes already exist. Cancellations and credit notes are blocked offline but need server-first endpoints for online use. Both have PostgreSQL triggers that affect `saldo_deudor` and inventory, so they MUST go through the server.

**Important:** These route files currently may use `ON CONFLICT (global_id) DO UPDATE`. For server-first mode, change to `DO NOTHING` + return existing record on conflict (idempotency alignment from spec).

- [ ] **Step 1: Update cancelaciones.js for server-first**

Read `routes/cancelaciones.js`. Find the POST/sync endpoint. Ensure:

1. Accepts `global_id` from request body (for idempotency)
2. Change any `ON CONFLICT (global_id) DO UPDATE SET ...` to `ON CONFLICT (global_id) DO NOTHING`
3. After `DO NOTHING`, if no rows returned, SELECT the existing record by `global_id` and return it
4. Emit socket event after successful creation:
```javascript
if (io) {
    io.to(`branch_${branchId}`).emit('cancellation_created', {
        cancellationId: row.id,
        globalId: row.global_id,
        branchId,
        saleId: row.sale_id
    });
}
```
5. Update module.exports to accept `(pool, io)` if not done in Task 1

**Note:** Cancellation triggers: `trigger_update_customer_balance` fires on cancel of a credit sale (reverses `saldo_deudor`). These triggers run server-side automatically — Desktop doesn't need to handle balance updates.

- [ ] **Step 2: Update notas_credito.js for server-first**

Read `routes/notas_credito.js`. Same changes as step 1:

1. Accept `global_id` from request body
2. Change `ON CONFLICT DO UPDATE` to `DO NOTHING` + SELECT existing
3. Emit `credit_note_created` socket event
4. Update module.exports to accept `(pool, io)` if not done

**Note:** Credit note triggers: `trigger_revert_balance_on_nc_cancel` fires to reverse inventory. `GET /api/notas-credito/pull` already exists (line ~251) — verify it works, no need to create.

- [ ] **Step 3: Add /pull endpoint to cancelaciones if missing**

Check if `GET /api/cancelaciones/pull` exists. If not, add:
```javascript
router.get('/pull', authenticateToken, async (req, res) => {
    const tenantId = req.user.tenantId;
    const branchId = req.query.branch_id || req.user.branchId;
    const since = req.query.since || '1970-01-01T00:00:00Z';
    const limit = Math.min(parseInt(req.query.limit) || 500, 1000);

    const result = await pool.query(`
        SELECT c.*, v.global_id as sale_global_id
        FROM cancelaciones c
        LEFT JOIN ventas v ON c.sale_id = v.id_venta
        WHERE c.tenant_id = $1 AND c.branch_id = $2
          AND c.created_at > $3
        ORDER BY c.created_at ASC LIMIT $4
    `, [tenantId, branchId, since, limit]);

    const lastSync = result.rows.length > 0
        ? result.rows[result.rows.length - 1].created_at : since;
    res.json({ success: true, data: { cancelaciones: result.rows, last_sync: lastSync }, count: result.rows.length });
});
```

- [ ] **Step 4: Commit and push**

```bash
git add routes/cancelaciones.js routes/notas_credito.js server.js
git commit -m "feat: align cancellation + credit-note endpoints for server-first (DO NOTHING idempotency)"
git push origin main
```

---

### Task 12: Desktop — Cancellations and Credit Notes Server-First

**Files:**
- Modify: `Services/BackendSyncService.cs`
- Modify: The ViewModel/Service that handles cancellations (find via grep for `Cancelar` or `CancelSale`)
- Modify: The ViewModel/Service that handles credit notes

- [ ] **Step 1: Add server-first methods to BackendSyncService**

```csharp
public async Task<JsonElement?> CreateCancellationServerFirstAsync(object payload)
// Same pattern, POST /api/cancellations (or wherever the endpoint is)

public async Task<JsonElement?> CreateCreditNoteServerFirstAsync(object payload)
// Same pattern, POST /api/credit-notes (or wherever the endpoint is)
```

- [ ] **Step 2: Add multi-caja branches**

Both cancellations and credit notes are **blocked offline** (same as credit payments):
```csharp
if (_sessionService.MultiCajaEnabled && !_serverHealthService.IsServerReachable)
{
    throw new InvalidOperationException("Cancelaciones requieren conexion a internet en modo multi-caja");
}
```

When online, use try-POST-catch pattern. On network error during POST, show error (don't queue).

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: cancellation + credit-note server-first (blocked offline in multi-caja)"
```

---

## Phase 3: Master Data Server-First

### Task 13: Backend — Socket Events for Suppliers and Inventory

**Files:**
- Modify: `routes/suppliers.js` (emit `supplier_updated`)
- Modify: `routes/purchases.js` (emit `inventory_updated` on purchase creation)
- Modify: Wherever credit note returns are handled (emit `inventory_updated`)

- [ ] **Step 1: Add supplier_updated emission**

In `routes/suppliers.js`, after successful POST /sync and PUT /:globalId, emit:
```javascript
if (io) {
    // Suppliers are tenant-wide (same customer pattern)
    const branches = await pool.query(
        'SELECT id FROM branches WHERE tenant_id = $1 AND is_active = true',
        [tenantId]);
    for (const b of branches.rows) {
        io.to(`branch_${b.id}`).emit('supplier_updated', {
            supplierId: row.id,
            globalId: row.global_id,
            tenantId,
            action: wasInserted ? 'created' : 'updated'
        });
    }
}
```

- [ ] **Step 2: Add inventory_updated emission**

In `routes/purchases.js` POST handler, after successful purchase creation:
```javascript
if (io) {
    io.to(`branch_${branchId}`).emit('inventory_updated', {
        tenantId,
        branchId,
        action: 'purchase'
    });
}
```

- [ ] **Step 3: Commit and push**

```bash
git add routes/suppliers.js routes/purchases.js
git commit -m "feat: emit supplier_updated and inventory_updated socket events"
git push origin main
```

---

### Task 14: Desktop — Customers Server-First

**Files:**
- Modify: `Services/BackendSyncService.cs` (add customer CRUD methods)
- Modify: `Services/ClienteService.cs` (add multi-caja branch)

**Context:** Customers already have `POST /api/customers/sync` and `GET /api/customers/pull`. For server-first we use the sync endpoint (it handles single items). For reads, we add TTL-based cache refresh.

- [ ] **Step 1: Add customer server-first methods to BackendSyncService**

```csharp
public async Task<JsonElement?> CreateCustomerServerFirstAsync(object payload)
{
    var request = await CreateAuthenticatedRequest(HttpMethod.Post, "/api/customers/sync");
    request.Content = new StringContent(
        JsonSerializer.Serialize(payload),
        Encoding.UTF8, "application/json");
    // ... standard pattern ...
}

public async Task<List<JsonElement>> PullCustomersAsync(string since = null)
{
    var url = $"/api/customers/pull?since={Uri.EscapeDataString(since ?? "1970-01-01T00:00:00Z")}";
    var request = await CreateAuthenticatedRequest(HttpMethod.Get, url);
    var response = await _httpClient.SendAsync(request);
    // Parse response, return list
}
```

- [ ] **Step 2: Modify ClienteService for server-first reads**

In the method that lists customers (find via grep for `GetCustomers` or `GetClientes`):

```csharp
public async Task<List<Cliente>> GetAllClientesAsync()
{
    if (_sessionService.MultiCajaEnabled && !_cacheService.IsCacheFresh("customers"))
    {
        try
        {
            var serverCustomers = await _backendSyncService.PullCustomersAsync(_lastCustomerSync);
            // Update SQLite cache with server data
            // _lastCustomerSync = response last_sync
            _cacheService.MarkCacheRefreshed("customers");
            _serverHealthService.MarkOnline();
        }
        catch (HttpRequestException)
        {
            _serverHealthService.MarkOffline();
            // Fall through to SQLite read
        }
    }

    // Read from SQLite (always — it's the cache)
    return await _db.Table<Cliente>().Where(c => !c.IsDeleted).ToListAsync();
}
```

- [ ] **Step 3: Modify ClienteService for server-first writes**

In the save/create method, add try-POST-catch-fallback:

```csharp
if (_sessionService.MultiCajaEnabled)
{
    try
    {
        var payload = new { /* map cliente fields to API format */ };
        var result = await _backendSyncService.CreateCustomerServerFirstAsync(payload);
        // Parse RemoteId, set Synced=true
    }
    catch (HttpRequestException)
    {
        _serverHealthService.MarkOffline();
        cliente.PendingServer = true;
    }
}
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: customer server-first reads (TTL cache) and writes in multi-caja"
```

---

### Task 15: Desktop — Products Server-First

**Files:**
- Modify: `Services/BackendSyncService.cs` (add `PullProductsAsync`)
- Modify: `Services/ProductoService.cs` (add TTL cache reads + server-first writes)

**Context:** Products already have `GET /api/productos` and `POST /api/productos/sync`. Same pattern as customers.

- [ ] **Step 1: Add PullProductsAsync to BackendSyncService**

```csharp
public async Task<List<JsonElement>> PullProductsAsync()
{
    var tenantId = /* from session */;
    var branchId = /* from session */;
    var url = $"/api/productos?tenantId={tenantId}&branchId={branchId}";
    var request = await CreateAuthenticatedRequest(HttpMethod.Get, url);
    // ... standard GET pattern ...
}
```

- [ ] **Step 2: Add TTL cache to ProductoService reads**

Same pattern as ClienteService: check `_cacheService.IsCacheFresh("products")`, pull from server if stale, read from SQLite.

- [ ] **Step 3: Add server-first writes for product create/edit**

If products are edited on Desktop (price changes, etc.), apply try-POST-catch-fallback.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: product server-first reads + writes in multi-caja"
```

---

### Task 16: Desktop — Suppliers Server-First

**Files:**
- Modify: `Services/BackendSyncService.cs` (add `PullSuppliersAsync`, `CreateSupplierServerFirstAsync`)
- Modify: `Services/ProveedorService.cs` (add TTL cache + server-first writes)

**Context:** Suppliers have `GET /api/suppliers/pull` and `POST /api/suppliers/sync`. Same pattern.

- [ ] **Step 1: Add supplier methods to BackendSyncService**

- [ ] **Step 2: Add TTL cache to ProveedorService reads**

- [ ] **Step 3: Add server-first writes**

- [ ] **Step 4: Wire supplier_updated socket event to cache invalidation**

In `SocketIOService.cs`, add listener:
```csharp
_socket.On("supplier_updated", response =>
{
    _cacheService.InvalidateCache("suppliers");
});
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: supplier server-first reads + writes + socket invalidation in multi-caja"
```

---

### Task 17: Desktop — Employees Cache Refresh

**Files:**
- Modify: `Services/BackendSyncService.cs` (add `PullEmployeesAsync` if missing)
- Modify: Employee listing service (add TTL cache)

**Context:** Employees are generally read-only from Desktop. Just need TTL-cached reads from server. No server-first writes needed (employee management is admin-only).

- [ ] **Step 1: Add TTL cache to employee reads**

Same pattern: check `_cacheService.IsCacheFresh("employees")`, pull from server if stale.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: employee TTL cache refresh in multi-caja mode"
```

---

### Task 18: Desktop — Socket Event Listeners for Cache Invalidation

**Files:**
- Modify: `Services/SocketIOService.cs`

**Context:** Wire all new socket events to CacheService invalidation. Some already exist (customer_updated, product_updated), some are new (supplier_updated, inventory_updated).

- [ ] **Step 1: Inject ICacheService into SocketIOService**

Add to constructor and interface.

- [ ] **Step 2: Add/update socket listeners**

```csharp
// Existing - add cache invalidation
_socket.On("customer_updated", response => {
    _cacheService.InvalidateCache("customers");
    // ... existing handler ...
});

_socket.On("product_updated", response => {
    _cacheService.InvalidateCache("products");
    // ... existing handler ...
});

// New
_socket.On("supplier_updated", response => {
    _cacheService.InvalidateCache("suppliers");
});

_socket.On("inventory_updated", response => {
    _cacheService.InvalidateCache("products"); // products include stock
});

_socket.On("expense_created", response => {
    _cacheService.InvalidateCache("expenses");
});

_socket.On("credit_payment_created", response => {
    _cacheService.InvalidateCache("customers"); // saldo_deudor changed
});

_socket.On("cancellation_created", response => {
    _cacheService.InvalidateCache("customers"); // saldo_deudor may have changed
    _cacheService.InvalidateCache("sales");
});

_socket.On("credit_note_created", response => {
    _cacheService.InvalidateCache("customers");
    _cacheService.InvalidateCache("products"); // inventory changed
});
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: wire socket events to cache invalidation for multi-caja"
```

---

## Phase 4: Offline Queue and Reconciliation

### Task 19: Desktop — Offline Queue Processor

**Files:**
- Create: `Services/OfflineQueueService.cs`
- Create: `Services/Interfaces/IOfflineQueueService.cs`
- Modify: `App.xaml.cs` (DI registration)

**Context:** When Desktop reconnects after being offline in multi-caja, it must drain the offline queue before resuming server-first mode. Entities with `PendingServer = true` are processed in dependency order.

- [ ] **Step 1: Add PendingServer to all entity models**

Add `public bool PendingServer { get; set; }` to these SQLite models if not already present:
- `Expense`, `Purchase`, `PurchaseDetail`, `Cliente`, `Producto`, `Proveedor`, `Deposit`, `Withdrawal`, `CreditPayment`

**Note:** SQLite-net auto-adds new columns to existing tables on `CreateTableAsync`. But to be safe, check if `DatabaseMigrationService.cs` needs a migration entry. If the project uses explicit migrations, add one.

- [ ] **Step 2: Create ISyncableEntity interface**

```csharp
// Models/ISyncableEntity.cs
public interface ISyncableEntity
{
    int Id { get; set; }
    string GlobalId { get; set; }
    int? RemoteId { get; set; }
    bool Synced { get; set; }
    bool PendingServer { get; set; }
    string CreatedLocalUtc { get; set; }
}
```

Add `ISyncableEntity` to each entity model class (e.g., `public class Expense : ISyncableEntity`). These properties already exist on most models — this just formalizes the contract.

- [ ] **Step 3: Create IOfflineQueueService interface**

```csharp
public interface IOfflineQueueService
{
    bool IsDraining { get; }
    event Action<string> QueueDrainProgress;  // "Syncing expenses: 3/5"
    event Action QueueDrainCompleted;
    Task DrainQueueAsync();
}
```

- [ ] **Step 4: Create implementation**

```csharp
public class OfflineQueueService : IOfflineQueueService
{
    private readonly IDatabaseService _databaseService;
    private readonly IBackendSyncService _backendSyncService;
    private readonly ICacheService _cacheService;

    public bool IsDraining { get; private set; }
    public event Action<string> QueueDrainProgress;
    public event Action QueueDrainCompleted;

    public async Task DrainQueueAsync()
    {
        IsDraining = true;
        try
        {
            var db = await _databaseService.GetConnection();

            // 1. Master data first (FK dependencies)
            await DrainEntityAsync<Cliente>(db, "customers", "clientes");
            await DrainEntityAsync<Proveedor>(db, "suppliers", "proveedores");
            await DrainEntityAsync<Producto>(db, "products", "productos");

            // 2. Transactions
            await DrainEntityAsync<Expense>(db, "expenses", "gastos");
            await DrainEntityAsync<Purchase>(db, "purchases", "compras");
            // Deposits/withdrawals already server-first, but may have queued items
            await DrainEntityAsync<Deposit>(db, "deposits", "depositos");
            await DrainEntityAsync<Withdrawal>(db, "withdrawals", "retiros");

            // 3. Credit payments last (depend on customers)
            // Credit payments should NOT be in queue (blocked offline)
            // But just in case:
            await DrainEntityAsync<CreditPayment>(db, "credit_payments", "pagos credito");

            // 4. Force re-pull customer data (balance reconciliation)
            _cacheService.InvalidateAllCaches();

            QueueDrainCompleted?.Invoke();
        }
        finally
        {
            IsDraining = false;
        }
    }

    private async Task DrainEntityAsync<T>(SQLiteAsyncConnection db,
        string entityType, string displayName) where T : class, new()
    {
        var pending = await db.Table<T>()
            .Where(e => e.PendingServer == true)
            .ToListAsync();

        for (int i = 0; i < pending.Count; i++)
        {
            QueueDrainProgress?.Invoke($"Sincronizando {displayName}: {i+1}/{pending.Count}");
            try
            {
                // Call appropriate server-first method based on entity type
                await SyncEntityToServerAsync(pending[i], entityType);
                pending[i].PendingServer = false;
                pending[i].Synced = true;
                await db.UpdateAsync(pending[i]);
            }
            catch (Exception ex)
            {
                // Log error, increment retry count, continue with next
                Debug.WriteLine($"[OfflineQueue] Failed to sync {entityType}: {ex.Message}");
            }
        }
    }
}
```

The `SyncEntityToServerAsync` method dispatches to the appropriate server-first method:

```csharp
private async Task SyncEntityToServerAsync<T>(T entity, string entityType) where T : ISyncableEntity
{
    object payload;
    JsonElement? result;

    switch (entityType)
    {
        case "expenses":
            payload = MapExpenseToPayload((Expense)(object)entity);
            result = await _backendSyncService.CreateExpenseServerFirstAsync(payload);
            break;
        case "purchases":
            payload = MapPurchaseToPayload((Purchase)(object)entity);
            result = await _backendSyncService.CreatePurchaseServerFirstAsync(payload);
            break;
        case "customers":
            payload = MapCustomerToPayload((Cliente)(object)entity);
            result = await _backendSyncService.CreateCustomerServerFirstAsync(payload);
            break;
        case "suppliers":
            payload = MapSupplierToPayload((Proveedor)(object)entity);
            result = await _backendSyncService.CreateSupplierServerFirstAsync(payload);
            break;
        case "deposits":
            payload = MapDepositToPayload((Deposit)(object)entity);
            result = await _backendSyncService.CreateDepositServerFirstAsync(payload);
            break;
        case "withdrawals":
            payload = MapWithdrawalToPayload((Withdrawal)(object)entity);
            result = await _backendSyncService.CreateWithdrawalServerFirstAsync(payload);
            break;
        default:
            throw new NotSupportedException($"Entity type {entityType} not supported in offline queue");
    }

    if (result.HasValue && result.Value.TryGetProperty("id", out var idProp))
    {
        entity.RemoteId = idProp.GetInt32();
    }
}
```

Each `MapXxxToPayload` method creates the anonymous object with the fields the backend expects (tenantId, branchId, globalId, etc.).

- [ ] **Step 3: Wire to ServerHealthService reconnection**

Subscribe to `ServerReachabilityChanged`:
```csharp
_serverHealthService.ServerReachabilityChanged += async (isReachable) =>
{
    if (isReachable && _sessionService.MultiCajaEnabled)
    {
        await _offlineQueueService.DrainQueueAsync();
    }
};
```

- [ ] **Step 4: Register in DI**

```csharp
services.AddSingleton<IOfflineQueueService, OfflineQueueService>();
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: offline queue processor for multi-caja reconnection"
```

---

### Task 20: Integration Testing and Verification

- [ ] **Step 1: Backend — Verify all new endpoints**

Test each new/modified endpoint with curl or Postman:
```
GET  /api/health                    → {"status":"ok"}
POST /api/expenses                  → creates expense, returns {id, global_id}
GET  /api/expenses/pull?since=...   → returns expenses array
POST /api/credit-payments           → creates payment, returns {id, global_id}
GET  /api/credit-payments/pull      → returns payments array
GET  /api/purchases/pull            → returns purchases array
```

- [ ] **Step 2: Desktop — Verify multi-caja flow**

1. Enable multi-caja on branch
2. Open shift on Desktop
3. Create expense → verify it goes to server first (check PG)
4. Create purchase → verify server first
5. Try credit sale → verify credit option is available (online)
6. Disconnect internet → verify credit option is greyed out
7. Create expense offline → verify it queues locally
8. Reconnect → verify queue drains automatically
9. Check corte de caja → verify server totals

- [ ] **Step 3: Final commit**

```bash
git commit -m "feat: complete server-first multi-caja migration"
```
