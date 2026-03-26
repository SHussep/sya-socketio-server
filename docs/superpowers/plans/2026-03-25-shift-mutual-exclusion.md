# Shift Mutual Exclusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent one employee from having active sessions on multiple devices (Desktop WinUI + Flutter Mobile) simultaneously, with force-takeover via Socket.IO.

**Architecture:** Hybrid session tracking — in-memory Map for real-time online/offline detection, DB columns (`session_revoked_at`, `session_revoked_for_device`) for offline device revocation. New `GET /api/auth/session-conflict` endpoint for Desktop (which authenticates locally). Mobile gets conflict info embedded in mobile-login response. Socket.IO `force_takeover` event with `force_takeover_result` response event orchestrates the handoff.

**Tech Stack:** Node.js/Express/PostgreSQL (backend), Socket.IO 4.x, WinUI 3/C# (desktop), Flutter/Dart (mobile)

**Spec:** `docs/superpowers/specs/2026-03-25-shift-mutual-exclusion-design.md`

---

## File Structure

### Backend (C:\SYA\sya-socketio-server)

| File | Action | Responsibility |
|------|--------|---------------|
| `socket/activeDeviceSessions.js` | **Create** | Singleton Map module — shared between socket handlers and REST routes |
| `database/migrations.js` | Modify | Add `session_revoked_at` and `session_revoked_for_device` columns to `employees` |
| `socket/handlers.js` | Modify | Populate/cleanup Map in `identify_client`/`disconnect`, add `force_takeover` handler, add revocation check, remove old mobile-to-mobile kick |
| `controllers/auth/loginMethods.js` | Modify | Add `checkSessionConflict()` helper, embed conflict info in mobile-login response, remove `employee:access_revoked` emit (replaced by new system) |
| `routes/auth.js` | Modify | Add `GET /api/auth/session-conflict` endpoint |

### Desktop (C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi)

| File | Action | Responsibility |
|------|--------|---------------|
| `Services/SocketIOService.cs` | Modify | Add `force_logout` listener, `OnForceLogoutReceived` event, `EmitForceTakeoverAsync()` method. **Note:** The `ISocketIOService` interface is defined inline in this same file (line ~17), not in a separate file. |
| `ViewModels/ShellViewModel.cs` | Modify | Subscribe to `OnForceLogoutReceived`, show blocking dialog, end session (triggers navigation to login) |
| `ViewModels/LoginViewModel.cs` | Modify | Call session-conflict endpoint after local auth, show takeover dialog |

### Mobile (C:\SYA\sya_mobile_app)

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/infrastructure/socket/socket_service.dart` | Modify | Add `emitForceTakeover()` method with acknowledgment callback |
| `lib/presentation/views/simple_login_page.dart` | Modify | Check `activeSessionConflict` in login response, show takeover dialog |
| `lib/main.dart` | Modify | Enhance `force_logout` handler to show reason-specific messages |

---

## Phase 1: Backend

### Task 1: Database Migration + Session Registry Module

**Files:**
- Create: `C:\SYA\sya-socketio-server\socket\activeDeviceSessions.js`
- Modify: `C:\SYA\sya-socketio-server\database\migrations.js`

- [ ] **Step 1: Create the shared session registry module**

Create `socket/activeDeviceSessions.js`:

```javascript
/**
 * In-memory registry of active device sessions per employee.
 * Key: employeeId (PostgreSQL integer from JWT)
 * Value: { socketId, clientType, branchId, connectedAt }
 *
 * Shared between socket/handlers.js and REST routes.
 * Lost on server restart — rebuilt via identify_client on reconnect.
 */
const activeDeviceSessions = new Map();

module.exports = activeDeviceSessions;
```

- [ ] **Step 2: Add migration for revocation columns on employees table**

In `database/migrations.js`, add a new patch block **before** the final `console.log('[Schema] ✅ Database initialization complete')` line. Follow the existing pattern of checking column existence first:

```javascript
// ══════════════════════════════════════════════════════════════
// Patch: Add session revocation columns for mutual exclusion
// ══════════════════════════════════════════════════════════════
try {
    const checkSessionRevoked = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'employees' AND column_name = 'session_revoked_at'
    `);
    if (checkSessionRevoked.rows.length === 0) {
        console.log('[Schema] Adding session revocation columns to employees...');
        await client.query(`
            ALTER TABLE employees
            ADD COLUMN session_revoked_at TIMESTAMPTZ DEFAULT NULL
        `);
        await client.query(`
            ALTER TABLE employees
            ADD COLUMN session_revoked_for_device VARCHAR(20) DEFAULT NULL
        `);
        console.log('[Schema] ✅ Session revocation columns added');
    }
} catch (err) {
    console.error('[Schema] Error adding session revocation columns:', err.message);
}
```

- [ ] **Step 3: Test migration runs without errors**

Run: `node -e "const { runMigrations } = require('./database/migrations'); runMigrations().then(() => console.log('OK')).catch(e => console.error(e))"`

Expected: No errors, "Session revocation columns added" on first run, silently skipped on subsequent runs.

- [ ] **Step 4: Verify columns exist in PostgreSQL**

Run: `node -e "const pool = require('./database/pool'); pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'employees' AND column_name IN ('session_revoked_at', 'session_revoked_for_device')\").then(r => { console.log(r.rows); pool.end(); })"`

Expected: Two rows: `session_revoked_at` and `session_revoked_for_device`.

- [ ] **Step 5: Commit**

```bash
cd C:/SYA/sya-socketio-server
git add socket/activeDeviceSessions.js database/migrations.js
git commit -m "feat(auth): add session registry module and revocation columns migration"
```

---

### Task 2: Socket Handler Changes

**Files:**
- Modify: `C:\SYA\sya-socketio-server\socket\handlers.js`

**Context:** This file exports a function `setupSocketHandlers(io, { pool, stats, ... })`. We need to:
1. Import `activeDeviceSessions` Map
2. Replace the existing mobile-to-mobile kick code in `identify_client` (lines ~138-159) with the new Map-based registration + revocation check
3. Update `disconnect` handler to clean up the Map
4. Add new `force_takeover` event handler

- [ ] **Step 1: Import activeDeviceSessions at top of handlers.js**

At the top of the file (after `module.exports = function...` line 6), add:

```javascript
const activeDeviceSessions = require('./activeDeviceSessions');
```

- [ ] **Step 2: Replace mobile-to-mobile kick code in identify_client with revocation check + Map registration**

Find the `identify_client` handler (line ~131). The existing code at lines ~138-159 loops through `io.sockets.sockets` to find duplicate mobile sessions and sends `force_logout`. **Replace that entire block** (the `if (data.type === 'mobile' && socket.user?.employeeId && !socket.user?.isMasterLogin)` section) with:

```javascript
        // ═══════════════════════════════════════════════════════════════
        // MUTUAL EXCLUSION: Session revocation check + Map registration
        // ═══════════════════════════════════════════════════════════════
        const employeeId = socket.user?.employeeId;
        if (employeeId) {
            try {
                // Check if this device was revoked while offline
                const revocationCheck = await pool.query(
                    `UPDATE employees
                     SET session_revoked_at = NULL, session_revoked_for_device = NULL
                     WHERE id = $1
                       AND session_revoked_at IS NOT NULL
                       AND session_revoked_for_device = $2
                     RETURNING session_revoked_at`,
                    [employeeId, data.type]
                );

                if (revocationCheck.rows.length > 0) {
                    // This device was revoked — kick it
                    console.log(`[Socket] 🚫 Employee ${employeeId} (${data.type}) was revoked while offline — sending force_logout`);
                    socket.emit('force_logout', {
                        reason: 'session_revoked',
                        message: 'Tu sesión fue revocada mientras estabas desconectado'
                    });
                    return; // Don't register in activeDeviceSessions
                }

                // Register this device in the session registry
                activeDeviceSessions.set(employeeId, {
                    socketId: socket.id,
                    clientType: data.type,
                    branchId: socket.branchId || null,
                    connectedAt: Date.now()
                });
                console.log(`[Socket] 📱 Employee ${employeeId} registered as ${data.type} (socket: ${socket.id})`);
            } catch (err) {
                console.error(`[Socket] Error in session registry for employee ${employeeId}:`, err.message);
                // Non-blocking — continue even if registry fails
            }
        }
```

**Important:** The `identify_client` handler must be `async` for the await to work. Change:
```javascript
socket.on('identify_client', (data) => {
```
to:
```javascript
socket.on('identify_client', async (data) => {
```

Keep the existing code that follows (desktop online status broadcast at lines ~161-170 and mobile desktop status check at lines ~172-191) — those are unrelated.

- [ ] **Step 3: Update disconnect handler to clean up activeDeviceSessions**

Find the `disconnect` handler (line ~930). **Add** cleanup code at the beginning of the handler, before the existing desktop offline broadcast:

```javascript
        // Clean up session registry (only if this socket is the current entry)
        const empId = socket.user?.employeeId;
        if (empId && activeDeviceSessions.has(empId)) {
            const session = activeDeviceSessions.get(empId);
            if (session.socketId === socket.id) {
                activeDeviceSessions.delete(empId);
                console.log(`[Socket] 🔌 Employee ${empId} removed from session registry (disconnect)`);
            }
        }
```

- [ ] **Step 4: Add force_takeover event handler**

Add a new event handler inside the `io.on('connection', (socket) => { ... })` block, after the existing event handlers but before the `disconnect` handler. Use Socket.IO acknowledgment callback:

```javascript
    // ═══════════════════════════════════════════════════════════════
    // MUTUAL EXCLUSION: Force takeover — new device kicks old device
    // Uses event-based response (force_takeover_result) instead of
    // Socket.IO ack callbacks — safer cross-library compatibility.
    // ═══════════════════════════════════════════════════════════════
    socket.on('force_takeover', async (data) => {
        const employeeId = data?.employeeId || socket.user?.employeeId;
        if (!employeeId) {
            socket.emit('force_takeover_result', { success: false, error: 'No employeeId' });
            return;
        }

        console.log(`[Socket] 🔄 Force takeover requested by ${socket.clientType} for employee ${employeeId}`);

        try {
            const existingSession = activeDeviceSessions.get(employeeId);

            if (existingSession && existingSession.socketId !== socket.id) {
                // Old device is ONLINE — send force_logout directly
                const oldSocket = io.sockets.sockets.get(existingSession.socketId);
                if (oldSocket) {
                    oldSocket.emit('force_logout', {
                        reason: 'session_taken',
                        takenByDevice: socket.clientType || 'unknown',
                        message: 'Tu sesión fue tomada por otro dispositivo'
                    });
                    console.log(`[Socket] 📤 force_logout sent to ${existingSession.clientType} (socket: ${existingSession.socketId})`);
                }
                activeDeviceSessions.delete(employeeId);

                // Register new device
                activeDeviceSessions.set(employeeId, {
                    socketId: socket.id,
                    clientType: socket.clientType || 'unknown',
                    branchId: socket.branchId || null,
                    connectedAt: Date.now()
                });

                socket.emit('force_takeover_result', { success: true, wasOnline: true });
            } else {
                // Old device is OFFLINE — set revocation flag in DB
                // Determine old device type from open shift's terminal_id
                let revokedDeviceType = 'unknown';
                const shiftResult = await pool.query(
                    `SELECT terminal_id FROM shifts
                     WHERE employee_id = $1 AND is_cash_cut_open = true
                     ORDER BY start_time DESC LIMIT 1`,
                    [employeeId]
                );
                if (shiftResult.rows.length > 0) {
                    const terminalId = shiftResult.rows[0].terminal_id || '';
                    revokedDeviceType = terminalId.startsWith('mobile-') ? 'mobile' : 'desktop';
                }

                await pool.query(
                    `UPDATE employees
                     SET session_revoked_at = NOW(), session_revoked_for_device = $2
                     WHERE id = $1`,
                    [employeeId, revokedDeviceType]
                );

                // Register new device
                activeDeviceSessions.set(employeeId, {
                    socketId: socket.id,
                    clientType: socket.clientType || 'unknown',
                    branchId: socket.branchId || null,
                    connectedAt: Date.now()
                });

                console.log(`[Socket] 📝 Session revocation flag set for employee ${employeeId} (${revokedDeviceType})`);
                socket.emit('force_takeover_result', { success: true, wasOnline: false });
            }
        } catch (err) {
            console.error(`[Socket] Error in force_takeover:`, err.message);
            socket.emit('force_takeover_result', { success: false, error: err.message });
        }
    });
```

- [ ] **Step 5: Test socket handler changes**

Restart the server: `npm start` (or `node server.js`)

Verify no startup errors. Check logs for `[Schema]` migration messages.

- [ ] **Step 6: Commit**

```bash
cd C:/SYA/sya-socketio-server
git add socket/handlers.js
git commit -m "feat(socket): add activeDeviceSessions registry, force_takeover handler, revocation check"
```

---

### Task 3: Conflict Detection Endpoint + Mobile Login Enhancement

**Files:**
- Modify: `C:\SYA\sya-socketio-server\controllers\auth\loginMethods.js`
- Modify: `C:\SYA\sya-socketio-server\routes\auth.js`

- [ ] **Step 1: Add checkSessionConflict helper to loginMethods.js**

At the bottom of `loginMethods.js`, **before** the closing of `module.exports`, add a new exported function. The file currently exports `{ desktopLogin, mobileLogin }`. Change it to also export `checkSessionConflict`:

Find the `module.exports` object (line ~29) and add the new function. If the file structure is `module.exports = { desktopLogin: async (req, res) => { ... }, mobileLogin: async (req, res) => { ... } }`, add `checkSessionConflict` as a standalone exported function at the end of the file:

```javascript
// ═══════════════════════════════════════════════════════════════
// SESSION CONFLICT DETECTION
// Used by: GET /api/auth/session-conflict (Desktop)
//          POST /api/auth/mobile-login (embedded in response)
// ═══════════════════════════════════════════════════════════════
async function checkSessionConflict(employeeId, pool) {
    const activeDeviceSessions = require('../socket/activeDeviceSessions');

    let hasConflict = false;
    let otherDeviceType = null;
    let otherDeviceOnline = false;
    let shiftBranchName = null;
    let shiftStartTime = null;

    // 1. Check in-memory registry for online device
    const existingSession = activeDeviceSessions.get(employeeId);
    if (existingSession) {
        hasConflict = true;
        otherDeviceType = existingSession.clientType;
        otherDeviceOnline = true;
    }

    // 2. Check DB for open shift (even if no active socket session)
    const shiftResult = await pool.query(
        `SELECT s.id, s.start_time, s.terminal_id, b.nombre as branch_name
         FROM shifts s
         LEFT JOIN branches b ON b.id = s.branch_id
         WHERE s.employee_id = $1 AND s.is_cash_cut_open = true
         ORDER BY s.start_time DESC
         LIMIT 1`,
        [employeeId]
    );

    if (shiftResult.rows.length > 0) {
        const shift = shiftResult.rows[0];
        hasConflict = true;
        shiftBranchName = shift.branch_name;
        shiftStartTime = shift.start_time;

        // If we didn't find an online session, infer device type from terminal_id
        if (!otherDeviceType) {
            const terminalId = shift.terminal_id || '';
            otherDeviceType = terminalId.startsWith('mobile-') ? 'mobile' : 'desktop';
        }
    }

    if (!hasConflict) return null;

    return {
        hasConflict: true,
        otherDeviceType: otherDeviceType || 'unknown',
        otherDeviceOnline,
        shiftBranchName,
        shiftStartTime
    };
}
```

Then export it separately so it doesn't get added to the AuthController prototype. At the very end of the file, after the `module.exports` object, add:

```javascript
// Exported separately — utility function, not an HTTP handler
module.exports.checkSessionConflict = checkSessionConflict;
```

- [ ] **Step 2: Embed conflict info in mobile-login response**

Inside the `mobileLogin` function, **after** JWT tokens are generated (around line ~450) and **before** the response is sent (around line ~538), add the conflict check. Find the section where the response object is built and add:

```javascript
        // ═══════════════════════════════════════════════════════════════
        // MUTUAL EXCLUSION: Check for active session on another device
        // ═══════════════════════════════════════════════════════════════
        let activeSessionConflict = null;
        try {
            // pool is available via closure from the controller constructor (this.pool)
            // or via the pool module — check which pattern this file uses.
            // loginMethods.js methods are bound to AuthController prototype via Object.assign,
            // so `this.pool` is the correct reference inside mobileLogin.
            activeSessionConflict = await checkSessionConflict(employee.id, this.pool);
        } catch (conflictErr) {
            console.error('[Auth] Error checking session conflict:', conflictErr.message);
            // Non-blocking — login continues without conflict info
        }
```

Then add `activeSessionConflict` to the `res.json({ ... })` response object. **Important:** Add it at the TOP LEVEL of the response (next to `token`, `refreshToken`), NOT inside a nested `data` object. The Mobile consumer reads it as `responseData['activeSessionConflict']` from the top-level parsed JSON:

```javascript
        activeSessionConflict,  // null if no conflict, object if conflict detected
```

- [ ] **Step 3: Remove employee:access_revoked socket emit from mobileLogin**

In the SINGLE SESSION ENFORCEMENT section (lines ~487-534), find and **remove** (or comment out) the Socket.IO emit that sends `employee:access_revoked`:

```javascript
// REMOVE THIS LINE (around line ~510):
// io.to(`branch_${employee.main_branch_id}`).emit('employee:access_revoked', { ... });
```

Keep the FCM device token deactivation code (it's about FCM routing, not session control). Only remove the socket emit.

**Note:** The `io` object may not be available in loginMethods.js. If the emit is done differently (e.g., via a helper), find and remove that specific emit. The key is: don't emit `employee:access_revoked` during login anymore — the new `force_takeover` mechanism replaces it.

- [ ] **Step 4: Add GET /api/auth/session-conflict route**

In `routes/auth.js`, add the new route. The file uses `const AuthController = require(...)` and binds methods. Add:

```javascript
// Session conflict check (used by Desktop before session start)
// Rate-limited to prevent abuse (reuses existing loginRateLimiter)
router.get('/session-conflict', loginRateLimiter, async (req, res) => {
    try {
        const employeeId = parseInt(req.query.employeeId);
        if (!employeeId) {
            return res.status(400).json({ success: false, error: 'employeeId query param required' });
        }

        const { checkSessionConflict } = require('../controllers/auth/loginMethods');
        const conflict = await checkSessionConflict(employeeId, pool);

        res.json({
            success: true,
            ...(conflict || { hasConflict: false })
        });
    } catch (err) {
        console.error('[Auth] session-conflict error:', err.message);
        res.status(500).json({ success: false, error: 'Internal error' });
    }
});
```

Add this before the `return router;` line (around line ~54). The `pool` variable is available from the `module.exports = (pool) => { ... }` wrapper.

- [ ] **Step 5: Test conflict detection endpoint**

Start server and test with curl:

```bash
# No conflict (use an employee ID that has no open shift)
curl "http://localhost:3000/api/auth/session-conflict?employeeId=999"
# Expected: {"success":true,"hasConflict":false}

# With open shift (use a real employee ID that has an open shift)
curl "http://localhost:3000/api/auth/session-conflict?employeeId=<REAL_ID>"
# Expected: {"success":true,"hasConflict":true,"otherDeviceType":"desktop",...}
```

- [ ] **Step 6: Test mobile-login returns activeSessionConflict**

```bash
curl -X POST http://localhost:3000/api/auth/mobile-login \
  -H "Content-Type: application/json" \
  -d '{"email":"<test_email>","password":"<test_password>"}'
# Expected: response includes "activeSessionConflict" field (null or object)
```

- [ ] **Step 7: Commit**

```bash
cd C:/SYA/sya-socketio-server
git add controllers/auth/loginMethods.js routes/auth.js
git commit -m "feat(auth): add session conflict detection endpoint and mobile-login enhancement"
```

- [ ] **Step 8: Push backend changes**

```bash
cd C:/SYA/sya-socketio-server
git push origin main
```

---

## Phase 2: Desktop (WinUI)

### Task 4: SocketIOService — force_logout Listener + force_takeover Emit

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Services\SocketIOService.cs` (contains both the `ISocketIOService` interface at line ~17 and the `SocketIOService` class at line ~129)

- [ ] **Step 1: Add event and method to ISocketIOService interface**

In `SocketIOService.cs`, find the `ISocketIOService` interface (starts at line ~17). In the events section (around lines 65-126), add:

```csharp
/// <summary>
/// Fired when the server sends force_logout (session taken by another device).
/// </summary>
event Action<ForceLogoutMessage> OnForceLogoutReceived;

/// <summary>
/// Emits force_takeover to the server. Returns result with success/wasOnline.
/// </summary>
Task<ForceLogoutResult> EmitForceTakeoverAsync(int employeeId);
```

Also add the message/result classes. Add them to a convenient location (either in the same file or in the Models folder). If adding inline at the bottom of the interface file:

```csharp
public class ForceLogoutMessage
{
    [System.Text.Json.Serialization.JsonPropertyName("reason")]
    public string Reason { get; set; }

    [System.Text.Json.Serialization.JsonPropertyName("message")]
    public string Message { get; set; }

    [System.Text.Json.Serialization.JsonPropertyName("takenByDevice")]
    public string TakenByDevice { get; set; }
}

public class ForceLogoutResult
{
    [System.Text.Json.Serialization.JsonPropertyName("success")]
    public bool Success { get; set; }

    [System.Text.Json.Serialization.JsonPropertyName("wasOnline")]
    public bool WasOnline { get; set; }

    [System.Text.Json.Serialization.JsonPropertyName("error")]
    public string Error { get; set; }
}
```

- [ ] **Step 2: Add force_logout listener in SetupMobileListeners()**

In `SocketIOService.cs`, find `SetupMobileListeners()` (line ~1600). Add the `force_logout` listener alongside the other listeners:

```csharp
            // ═══════════════════════════════════════════════════════════════
            // MUTUAL EXCLUSION: force_logout — session taken by another device
            // ═══════════════════════════════════════════════════════════════
            _socket.On("force_logout", (response) =>
            {
                try
                {
                    var parsed = response.GetValue<ForceLogoutMessage>();
                    Debug.WriteLine($"[SocketIO] 🚫 force_logout received: reason={parsed?.Reason}, takenBy={parsed?.TakenByDevice}");
                    OnForceLogoutReceived?.Invoke(parsed ?? new ForceLogoutMessage { Reason = "unknown", Message = "Sesión cerrada por otro dispositivo" });
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"[SocketIO] ❌ Error parsing force_logout: {ex.Message}");
                    OnForceLogoutReceived?.Invoke(new ForceLogoutMessage { Reason = "unknown", Message = "Sesión cerrada por otro dispositivo" });
                }
            });
```

- [ ] **Step 3: Declare the event in the class**

In `SocketIOService.cs`, find where other events are declared (near the class fields) and add:

```csharp
public event Action<ForceLogoutMessage> OnForceLogoutReceived;
```

- [ ] **Step 4: Implement EmitForceTakeoverAsync method**

Add a new method in `SocketIOService.cs`. Place it near the other `Emit*Async` methods (around line ~1032). Uses a temporary event listener for `force_takeover_result` (event-based response pattern — more reliable than ack callbacks across Socket.IO client libraries):

```csharp
        /// <summary>
        /// Emits force_takeover to server. Listens for force_takeover_result response event.
        /// Timeout: 10 seconds.
        /// </summary>
        public async Task<ForceLogoutResult> EmitForceTakeoverAsync(int employeeId)
        {
            if (_socket == null || !IsConnected)
            {
                Debug.WriteLine("[SocketIO] Cannot emit force_takeover — not connected");
                return new ForceLogoutResult { Success = false, Error = "Not connected" };
            }

            try
            {
                var tcs = new TaskCompletionSource<ForceLogoutResult>();
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                cts.Token.Register(() =>
                {
                    tcs.TrySetResult(new ForceLogoutResult { Success = false, Error = "Timeout" });
                    _socket?.Off("force_takeover_result"); // Clean up listener on timeout
                });

                // One-time listener for the server's response event
                _socket.On("force_takeover_result", (response) =>
                {
                    try
                    {
                        var result = response.GetValue<ForceLogoutResult>();
                        tcs.TrySetResult(result ?? new ForceLogoutResult { Success = false, Error = "Null response" });
                    }
                    catch (Exception ex)
                    {
                        tcs.TrySetResult(new ForceLogoutResult { Success = false, Error = ex.Message });
                    }
                    _socket?.Off("force_takeover_result"); // Clean up after receiving
                });

                await _socket.EmitAsync("force_takeover", new { employeeId });
                return await tcs.Task;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[SocketIO] Error emitting force_takeover: {ex.Message}");
                return new ForceLogoutResult { Success = false, Error = ex.Message };
            }
        }
```

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/saul_/source/repos/SyaTortilleriasWinUi"
git add SyaTortilleriasWinUi/Services/SocketIOService.cs
git commit -m "feat(socket): add force_logout listener and force_takeover emit for mutual exclusion"
```

---

### Task 5: ShellViewModel — Force Logout Dialog

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\ShellViewModel.cs`

- [ ] **Step 1: Subscribe to OnForceLogoutReceived in constructor**

In `ShellViewModel.cs`, find the constructor (line ~417) where other socket events are subscribed (lines ~458-499). After the existing subscriptions, add:

```csharp
            socketService.OnForceLogoutReceived += OnForceLogoutReceived;
```

- [ ] **Step 2: Implement the force_logout handler**

Add a new method in `ShellViewModel.cs`. Place it near the other socket event handlers (around line ~1361):

```csharp
        private void OnForceLogoutReceived(ForceLogoutMessage message)
        {
            Debug.WriteLine($"[ShellVM] Force logout received: {message?.Reason}");

            // Must dispatch to UI thread for ContentDialog
            App.MainWindow.DispatcherQueue.TryEnqueue(async () =>
            {
                try
                {
                    var dialog = new Microsoft.UI.Xaml.Controls.ContentDialog
                    {
                        Title = "Sesion Tomada",
                        Content = message?.Message ?? "Tu sesion fue tomada por otro dispositivo. Seras redirigido al login.",
                        PrimaryButtonText = "Aceptar",
                        DefaultButton = Microsoft.UI.Xaml.Controls.ContentDialogButton.Primary,
                        XamlRoot = App.MainWindow.Content.XamlRoot
                    };

                    await dialog.ShowAsync();

                    // End session — this triggers App.OnSessionEnded() which navigates to LoginPage
                    Debug.WriteLine("[ShellVM] Ending session after force_logout...");

                    var currentSessionService = _serviceProvider.GetRequiredService<ICurrentSessionService>();
                    await currentSessionService.ClearSessionAsync();

                    var socketIOService = _serviceProvider.GetRequiredService<ISocketIOService>();
                    // Disconnect socket before ending session to prevent reconnect attempts
                    try { await socketIOService.DisconnectAsync(); } catch { }

                    // EndSession() fires SessionEnded event → App navigates to LoginPage
                    _sessionService.EndSession();
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"[ShellVM] Error handling force_logout: {ex.Message}");
                    // Fallback: EndSession should still trigger navigation
                    try { _sessionService.EndSession(); } catch { }
                }
            });
        }
```

**Note:** `_sessionService.EndSession()` fires the `SessionEnded` event which `App.xaml.cs` listens to and navigates to `LoginPage`. This is the standard logout pattern in this codebase — do NOT use `_navigationService` (it doesn't exist in ShellViewModel).

**Note:** `DisconnectAsync()` must exist on `ISocketIOService`. If the interface only has `Disconnect()` (sync), use that instead. Check the existing interface to confirm the method name.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/saul_/source/repos/SyaTortilleriasWinUi"
git add SyaTortilleriasWinUi/ViewModels/ShellViewModel.cs
git commit -m "feat(shell): handle force_logout with blocking dialog and redirect to login"
```

---

### Task 6: LoginViewModel — Conflict Check + Takeover Dialog

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\LoginViewModel.cs`

**Context:** Desktop authenticates locally via `_userService.AuthenticateAsync()` (line ~498). The conflict check happens AFTER local auth succeeds but BEFORE `_sessionService.StartSession()` (line ~718).

- [ ] **Step 1: Add conflict check method**

Add a private method to `LoginViewModel.cs`:

```csharp
        /// <summary>
        /// Checks if the employee has an active session on another device.
        /// Returns null if no conflict, or the conflict info object.
        /// Returns null on network errors (offline-first: allow login).
        /// </summary>
        private async Task<SessionConflictInfo> CheckSessionConflictAsync(int employeeRemoteId)
        {
            try
            {
                var httpClient = _serviceProvider.GetRequiredService<HttpClient>();
                var syncConfig = await _syncConfigService.GetConfigAsync();
                if (syncConfig == null) return null;

                var baseUrl = syncConfig.ServerUrl?.TrimEnd('/');
                if (string.IsNullOrEmpty(baseUrl)) return null;

                var response = await httpClient.GetAsync($"{baseUrl}/api/auth/session-conflict?employeeId={employeeRemoteId}");
                if (!response.IsSuccessStatusCode) return null;

                var json = await response.Content.ReadAsStringAsync();
                var result = System.Text.Json.JsonSerializer.Deserialize<SessionConflictResponse>(json);

                if (result?.Success == true && result.HasConflict)
                {
                    return new SessionConflictInfo
                    {
                        HasConflict = true,
                        OtherDeviceType = result.OtherDeviceType,
                        OtherDeviceOnline = result.OtherDeviceOnline,
                        ShiftBranchName = result.ShiftBranchName,
                        ShiftStartTime = result.ShiftStartTime
                    };
                }

                return null;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[LoginVM] ⚠️ Session conflict check failed (offline-first, allowing login): {ex.Message}");
                return null; // Offline-first: allow login if backend unreachable
            }
        }
```

Add the supporting classes (at the bottom of the file or in a separate Models file):

```csharp
    public class SessionConflictResponse
    {
        [System.Text.Json.Serialization.JsonPropertyName("success")]
        public bool Success { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("hasConflict")]
        public bool HasConflict { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("otherDeviceType")]
        public string OtherDeviceType { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("otherDeviceOnline")]
        public bool OtherDeviceOnline { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("shiftBranchName")]
        public string ShiftBranchName { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("shiftStartTime")]
        public string ShiftStartTime { get; set; }
    }

    public class SessionConflictInfo
    {
        public bool HasConflict { get; set; }
        public string OtherDeviceType { get; set; }
        public bool OtherDeviceOnline { get; set; }
        public string ShiftBranchName { get; set; }
        public string ShiftStartTime { get; set; }
    }
```

- [ ] **Step 2: Add takeover dialog method**

```csharp
        /// <summary>
        /// Shows the session conflict dialog and handles force takeover.
        /// Returns true if takeover succeeded or no conflict, false if user cancelled.
        /// </summary>
        private async Task<bool> HandleSessionConflictAsync(SessionConflictInfo conflict, Employee employee)
        {
            if (conflict == null) return true; // No conflict

            string deviceLabel = conflict.OtherDeviceType == "mobile" ? "Móvil" : "Desktop";
            string branchLabel = conflict.ShiftBranchName ?? "otra sucursal";

            string startTimeLabel = "";
            if (!string.IsNullOrEmpty(conflict.ShiftStartTime))
            {
                if (DateTime.TryParse(conflict.ShiftStartTime, out var startTime))
                    startTimeLabel = $" desde las {startTime.ToLocalTime():HH:mm}";
            }

            string message;
            if (conflict.OtherDeviceOnline)
            {
                message = $"Tienes una sesión activa en {deviceLabel} en {branchLabel}{startTimeLabel}.\n\n¿Deseas tomar el control? El otro dispositivo será desconectado.";
            }
            else
            {
                message = $"Tienes una sesión activa en {deviceLabel} en {branchLabel}{startTimeLabel}, pero está desconectado.\n\nSi continúas, cuando se reconecte será expulsado automáticamente.";
            }

            var dialog = new Microsoft.UI.Xaml.Controls.ContentDialog
            {
                Title = "Sesión Activa en Otro Dispositivo",
                Content = message,
                PrimaryButtonText = "Tomar Control",
                CloseButtonText = "Cancelar",
                DefaultButton = Microsoft.UI.Xaml.Controls.ContentDialogButton.Primary,
                XamlRoot = App.MainWindow.Content.XamlRoot
            };

            var result = await dialog.ShowAsync();

            if (result != Microsoft.UI.Xaml.Controls.ContentDialogResult.Primary)
            {
                Debug.WriteLine("[LoginVM] ❌ User cancelled session takeover");
                return false; // User cancelled
            }

            // User confirmed — execute force takeover via Socket.IO
            Debug.WriteLine("[LoginVM] User confirmed takeover — connecting Socket.IO...");

            try
            {
                // Ensure Socket.IO is connected (needs JWT).
                // ConnectAsync() internally calls RefreshJwtAsync() which acquires a fresh JWT
                // via TenantService's refresh-token endpoint. The refresh token must already
                // be set from a previous session or acquired during this login flow.
                var socketService = _serviceProvider.GetRequiredService<ISocketIOService>();

                // Set refresh token if available (from previous session stored in SecureStorage)
                var savedRefreshToken = await _tokenService.GetRefreshTokenAsync();
                if (!string.IsNullOrEmpty(savedRefreshToken))
                {
                    socketService.SetRefreshToken(savedRefreshToken);
                }

                if (!socketService.IsConnected)
                {
                    await socketService.ConnectAsync();
                    // Wait for connection with polling (more reliable than fixed delay)
                    for (int i = 0; i < 10 && !socketService.IsConnected; i++)
                        await Task.Delay(500);
                }

                if (!socketService.IsConnected)
                {
                    Debug.WriteLine("[LoginVM] Socket.IO not connected — cannot force takeover");
                    await ShowErrorDialog("No se pudo conectar al servidor. Verifica tu conexión e intenta de nuevo.");
                    return false;
                }

                // Get the PostgreSQL employee ID
                int employeeRemoteId = employee.RemoteId ?? 0;
                if (employeeRemoteId == 0)
                {
                    Debug.WriteLine("[LoginVM] Employee has no RemoteId — cannot execute takeover");
                    await ShowErrorDialog("No se pudo identificar al empleado en el servidor.");
                    return false;
                }

                var takeoverResult = await socketService.EmitForceTakeoverAsync(employeeRemoteId);

                if (takeoverResult?.Success == true)
                {
                    Debug.WriteLine($"[LoginVM] ✅ Takeover successful (wasOnline: {takeoverResult.WasOnline})");
                    return true;
                }
                else
                {
                    Debug.WriteLine($"[LoginVM] ❌ Takeover failed: {takeoverResult?.Error}");
                    await ShowErrorDialog($"Error al tomar control: {takeoverResult?.Error ?? "Error desconocido"}");
                    return false;
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[LoginVM] ❌ Takeover exception: {ex.Message}");
                await ShowErrorDialog($"Error de conexión: {ex.Message}");
                return false;
            }
        }

        private async Task ShowErrorDialog(string message)
        {
            var errorDialog = new Microsoft.UI.Xaml.Controls.ContentDialog
            {
                Title = "Error",
                Content = message,
                CloseButtonText = "Aceptar",
                XamlRoot = App.MainWindow.Content.XamlRoot
            };
            await errorDialog.ShowAsync();
        }
```

- [ ] **Step 3: Insert conflict check into LoginAsync flow**

In `LoginAsync()`, find the section **after** local authentication succeeds (after `_userService.AuthenticateAsync()` at line ~498) and **before** `_sessionService.StartSession()` (at line ~718).

The best insertion point is after the employee is authenticated and before the session starts. Find the code that looks like:

```csharp
// ... authentication succeeded, employee is valid ...
// ... tenant and branch are loaded ...
await _sessionService.StartSession(employee, tenant, branch);
```

Insert the conflict check **before** `_sessionService.StartSession()`:

```csharp
                // ═══════════════════════════════════════════════════════════════
                // MUTUAL EXCLUSION: Check for active session on another device
                // ═══════════════════════════════════════════════════════════════
                if (isBackendReachable)
                {
                    int employeeRemoteId = employee.RemoteId ?? 0;
                    if (employeeRemoteId > 0)
                    {
                        var conflict = await CheckSessionConflictAsync(employeeRemoteId);
                        if (conflict != null)
                        {
                            var takeoverOk = await HandleSessionConflictAsync(conflict, employee);
                            if (!takeoverOk)
                            {
                                // User cancelled — abort login
                                IsLoading = false;
                                return;
                            }
                        }
                    }
                    else
                    {
                        Debug.WriteLine("[LoginVM] Employee has no RemoteId — skipping session conflict check");
                    }
                }
```

**Important:** `isBackendReachable` is a LOCAL variable (no underscore) declared earlier in `LoginAsync()` (around line ~329). If the backend is not reachable, skip the check (offline-first). If `RemoteId` is 0 (employee never synced), skip as well — there can't be a server-side session conflict.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/saul_/source/repos/SyaTortilleriasWinUi"
git add SyaTortilleriasWinUi/ViewModels/LoginViewModel.cs
git commit -m "feat(login): add session conflict check and takeover dialog for mutual exclusion"
```

---

## Phase 3: Mobile (Flutter)

### Task 7: SocketService — force_takeover Emit Method

**Files:**
- Modify: `C:\SYA\sya_mobile_app\lib\infrastructure\socket\socket_service.dart`

- [ ] **Step 1: Add emitForceTakeover method**

In `socket_service.dart`, add a new method near the other emit methods (around line ~772):

```dart
  /// Emits force_takeover to the server. Listens for force_takeover_result response event.
  /// Returns a Map with { success: bool, wasOnline: bool, error: String? }.
  /// Timeout: 10 seconds.
  Future<Map<String, dynamic>> emitForceTakeover(int employeeId) async {
    if (_socket == null || !_isConnected) {
      return {'success': false, 'error': 'Not connected'};
    }

    try {
      final completer = Completer<Map<String, dynamic>>();

      // Timeout after 10 seconds — cancel timer on success to prevent leak
      late final Timer timeoutTimer;
      timeoutTimer = Timer(const Duration(seconds: 10), () {
        if (!completer.isCompleted) {
          _socket?.off('force_takeover_result'); // Clean up listener
          completer.complete({'success': false, 'error': 'Timeout'});
        }
      });

      // Listen for one-time response event from server
      _socket!.once('force_takeover_result', (data) {
        timeoutTimer.cancel(); // Prevent timer leak
        if (!completer.isCompleted) {
          if (data is Map) {
            completer.complete(Map<String, dynamic>.from(data));
          } else {
            completer.complete({'success': true, 'wasOnline': false});
          }
        }
      });

      _socket!.emit('force_takeover', {'employeeId': employeeId});
      return await completer.future;
    } catch (e) {
      debugPrint('[SocketService] Error emitting force_takeover: $e');
      return {'success': false, 'error': e.toString()};
    }
  }
```

`dart:async` should already be imported (the file uses `StreamController.broadcast()`). If not, add it.

- [ ] **Step 2: Commit**

```bash
cd C:/SYA/sya_mobile_app
git add lib/infrastructure/socket/socket_service.dart
git commit -m "feat(socket): add emitForceTakeover method for mutual exclusion"
```

---

### Task 8: Mobile Login — Conflict Check + Takeover Dialog

**Files:**
- Modify: `C:\SYA\sya_mobile_app\lib\presentation\views\simple_login_page.dart`

**Context:** The login flow is in `_performLogin()` (lines 419-715). After the API response is parsed and before session saving starts (line ~489), check for `activeSessionConflict`.

- [ ] **Step 1: Add conflict handling after login response parsing**

In `_performLogin()`, find the section where the response is parsed and `success` is confirmed (around line ~447). After extracting the response data but **before** `AuthService().saveSession()` (line ~489), add:

```dart
          // ═══════════════════════════════════════════════════════════
          // MUTUAL EXCLUSION: Check for active session on another device
          // ═══════════════════════════════════════════════════════════
          final activeSessionConflict = data['activeSessionConflict'];
          if (activeSessionConflict != null && activeSessionConflict['hasConflict'] == true) {
            final otherDeviceType = activeSessionConflict['otherDeviceType'] ?? 'otro dispositivo';
            final otherDeviceOnline = activeSessionConflict['otherDeviceOnline'] == true;
            final shiftBranchName = activeSessionConflict['shiftBranchName'] ?? 'otra sucursal';
            final shiftStartTime = activeSessionConflict['shiftStartTime'];

            String startTimeLabel = '';
            if (shiftStartTime != null) {
              try {
                final dt = DateTime.parse(shiftStartTime).toLocal();
                startTimeLabel = ' desde las ${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
              } catch (_) {}
            }

            final deviceLabel = otherDeviceType == 'mobile' ? 'Móvil' : 'Desktop';

            String dialogMessage;
            if (otherDeviceOnline) {
              dialogMessage = 'Tienes una sesión activa en $deviceLabel en $shiftBranchName$startTimeLabel.\n\n¿Deseas tomar el control? El otro dispositivo será desconectado.';
            } else {
              dialogMessage = 'Tienes una sesión activa en $deviceLabel en $shiftBranchName$startTimeLabel, pero está desconectado.\n\nSi continúas, cuando se reconecte será expulsado automáticamente.';
            }

            // Show confirmation dialog
            final shouldTakeover = await showDialog<bool>(
              context: context,
              barrierDismissible: false,
              builder: (ctx) => AlertDialog(
                title: const Text('Sesión Activa en Otro Dispositivo'),
                content: Text(dialogMessage),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(ctx).pop(false),
                    child: const Text('Cancelar'),
                  ),
                  ElevatedButton(
                    onPressed: () => Navigator.of(ctx).pop(true),
                    style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF15803D)),
                    child: const Text('Tomar Control', style: TextStyle(color: Colors.white)),
                  ),
                ],
              ),
            );

            if (shouldTakeover != true) {
              // User cancelled — abort login
              setState(() { _isLoading = false; });
              return;
            }

            // Execute force takeover
            // First connect Socket.IO with the JWT we just got
            final token = data['token'];
            final branchId = data['selectedBranch']?['id'] ??
                (data['availableBranches'] as List?)?.first?['id'];

            if (branchId != null && token != null) {
              await SocketService().connect(AppConfig.apiBaseUrl, branchId, forceToken: token);
              // Brief wait for connection to establish
              await Future.delayed(const Duration(seconds: 2));
            }

            final employeeId = data['employee']?['id'] ?? data['employee']?['employeeId'];
            if (employeeId != null) {
              final takeoverResult = await SocketService().emitForceTakeover(employeeId);
              debugPrint('[Login] Force takeover result: $takeoverResult');

              if (takeoverResult['success'] != true) {
                if (mounted) {
                  setState(() {
                    _errorMessage = 'Error al tomar control: ${takeoverResult['error'] ?? 'Error desconocido'}';
                    _isLoading = false;
                  });
                }
                return;
              }
            }

            // Disconnect Socket.IO — it will be reconnected properly later in the login flow
            await SocketService().disconnect();
          }
```

- [ ] **Step 2: Commit**

```bash
cd C:/SYA/sya_mobile_app
git add lib/presentation/views/simple_login_page.dart
git commit -m "feat(login): add session conflict check and takeover dialog for mutual exclusion"
```

---

### Task 9: Mobile main.dart — Enhanced force_logout Messages

**Files:**
- Modify: `C:\SYA\sya_mobile_app\lib\main.dart`

- [ ] **Step 1: Update force_logout handler to use reason-specific messages**

In `main.dart`, find the `_subscribeToForceLogout` method (lines ~295-336). Update the dialog content to use the `reason` field:

Find the dialog builder section (around line ~307-324). Replace the static dialog content with:

```dart
            final reason = data['reason'] ?? 'unknown';
            final message = data['message'] as String?;

            String dialogTitle;
            String dialogContent;

            switch (reason) {
              case 'session_taken':
                final takenBy = data['takenByDevice'] ?? 'otro dispositivo';
                final deviceLabel = takenBy == 'desktop' ? 'Desktop' : 'Móvil';
                dialogTitle = 'Sesión Tomada';
                dialogContent = message ?? 'Tu sesión fue tomada desde $deviceLabel. Serás redirigido al login.';
                break;
              case 'session_revoked':
                dialogTitle = 'Sesión Expirada';
                dialogContent = message ?? 'Tu sesión fue revocada mientras estabas desconectado.';
                break;
              default:
                dialogTitle = 'Sesión Cerrada';
                dialogContent = message ?? 'Se inició sesión en otro dispositivo.';
            }
```

Then update the AlertDialog to use these variables:

```dart
            await showDialog(
              context: dialogContext,
              barrierDismissible: false,
              builder: (ctx) => AlertDialog(
                title: Text(dialogTitle),
                content: Text(dialogContent),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(ctx).pop(),
                    child: const Text('Entendido'),
                  ),
                ],
              ),
            );
```

- [ ] **Step 2: Commit**

```bash
cd C:/SYA/sya_mobile_app
git add lib/main.dart
git commit -m "feat(main): show reason-specific messages for force_logout events"
```

---

## End-to-End Testing Checklist

After all tasks are complete, verify these scenarios:

### Scenario 1: Desktop → Mobile takeover (both online)
1. Open Desktop, login as employee X, open shift
2. Open Mobile, login as employee X
3. **Expected:** Mobile shows "Sesión activa en Desktop" dialog
4. Tap "Tomar Control"
5. **Expected:** Desktop shows "Sesión Tomada" dialog → navigates to login
6. **Expected:** Mobile proceeds to dashboard with inherited shift

### Scenario 2: Desktop → Mobile takeover (Desktop offline)
1. Open Desktop, login as employee X, open shift
2. Disconnect Desktop from internet
3. Open Mobile, login as employee X
4. **Expected:** Mobile shows "desconectado" warning dialog
5. Tap "Tomar Control"
6. **Expected:** Mobile proceeds to dashboard
7. Reconnect Desktop to internet
8. **Expected:** Desktop shows "Sesión Tomada" dialog → navigates to login

### Scenario 3: Mobile → Desktop takeover
1. Open Mobile, login as employee X, open shift
2. Open Desktop, login as employee X
3. **Expected:** Desktop shows "Sesión activa en Móvil" dialog
4. Click "Tomar Control"
5. **Expected:** Mobile shows force_logout dialog → navigates to login
6. **Expected:** Desktop proceeds normally

### Scenario 4: No conflict
1. Open Desktop, login as employee X (no open shift elsewhere)
2. **Expected:** Normal login, no dialog

### Scenario 5: User cancels takeover
1. Open Desktop with open shift
2. Open Mobile, login as same employee
3. **Expected:** Conflict dialog appears
4. Tap "Cancelar"
5. **Expected:** Stay on login screen, Desktop unaffected

### Scenario 6: Backend unreachable (Desktop)
1. Stop backend server
2. Open Desktop, login as employee X
3. **Expected:** Conflict check silently skipped, normal login proceeds
