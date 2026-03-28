# Terminal Naming System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admins to assign human-readable names to terminals so sales, tickets, and dashboards clearly identify which device generated each record.

**Architecture:** Extend the existing `branch_devices` PostgreSQL table with `is_active` and a unique name constraint. Auto-register terminals at shift open with suggested names. Clients cache terminal names locally and sync via Socket.IO `terminal:updated` events. Terminal names appear in POS header, tickets, dashboards, and a management page in settings.

**Tech Stack:** Node.js/Express/PostgreSQL (backend), C#/WinUI/SQLite (desktop), Flutter/Dart (mobile), Socket.IO (real-time sync)

**Spec:** `docs/superpowers/specs/2026-03-28-terminal-naming-design.md`

**Repos:**
- Backend: `C:\SYA\sya-socketio-server` (commit+push after changes)
- Desktop: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi` (NO commit unless user asks)
- Mobile: `C:\SYA\sya_mobile_app` (NO commit unless user asks)

---

## File Map

### Backend (`C:\SYA\sya-socketio-server`)

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `migrations/038_terminal_naming.sql` | Add `is_active` column + unique name index to `branch_devices` |
| Modify | `routes/devices.js` | Add PATCH endpoint, auto-naming in register, is_active filter in list, Socket.IO emit |
| Modify | `routes/shifts.js:32-150` | Auto-register terminal on shift open, return terminal info in response |

### Desktop (`C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi`)

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `Services/BackendSyncService.cs` | Add `GetTerminalsAsync()`, `GetTerminalNameAsync()` + in-memory cache |
| Modify | `Models/CurrentSession.cs` | Add `TerminalName` field |
| Modify | `Models/ReceiptSettings.cs` | Add `ShowTerminalName` toggle |
| Modify | `ViewModels/LoginViewModel.cs` | Capture terminal info from shift open response, cache names |
| Modify | `Views/ShellPage.xaml` + `ViewModels/ShellViewModel.cs` | Terminal name badge in POS header |
| Modify | `ViewModels/VentasDashboardViewModel.cs:1168-1184` | Update `FormatTicketDisplay` to use terminal name |
| Modify | `Helpers/ReceiptFormatter.cs:194-205` | Add "Terminal: Caja 1" line (if ShowTerminalName) |
| Modify | `Reports/Designs/SaleReceiptPdfDesigner.cs:187-194` | Same for PDF receipt |
| Modify | `Views/ReceiptSettingsPage.xaml:359-366` | Add ShowTerminalName toggle after ShowTurno |
| Modify | `ViewModels/ReceiptSettingsViewModel.cs:335-338` | Sync ShowTerminalName to service |
| Modify | `Models/SaleRowViewModel.cs` | Add Terminal property for DataGrid column |
| Modify | `Views/VentasDashboardPage.xaml` | Add "Terminal" column to sales DataGrid |
| Modify | `Models/OpenShiftDisplay.cs` | Add TerminalName, update Display property |
| Modify | `ViewModels/CashDrawerViewModel.cs:333-339` | Resolve terminal name for shift display |
| Create | `ViewModels/TerminalManagementViewModel.cs` | Terminal management settings ViewModel |
| Create | `Views/TerminalManagementPage.xaml` + `.xaml.cs` | Terminal management settings page |

### Flutter (`C:\SYA\sya_mobile_app`)

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `lib/features/terminals/models/terminal_model.dart` | Terminal data model |
| Create | `lib/features/terminals/services/terminal_api_service.dart` | REST API calls for terminals |
| Create | `lib/features/terminals/pages/terminal_management_page.dart` | Admin page to rename/deactivate terminals |
| Modify | `lib/infrastructure/socket/socket_service.dart` | Add `terminal:updated` listener + stream |
| Modify | `lib/features/pos/services/pos_api_service.dart:239-286` | Parse terminal info from shift open response |
| Modify | `lib/features/pos/viewmodels/pos_view_model.dart:340+` | Store terminal name, expose for UI |
| Modify | `lib/features/pos/pages/pos_page.dart:219-331` | Terminal badge in AppBar actions |
| Modify | `lib/presentation/views/settings_page.dart` | Add "Terminales" entry linking to management page |

---

## Task 1: Backend — Database Migration

**Files:**
- Create: `migrations/038_terminal_naming.sql`

- [ ] **Step 1: Create migration file**

```sql
-- migrations/038_terminal_naming.sql
-- ═══════════════════════════════════════════════════════════════
-- MIGRATION: Terminal naming support
-- Adds is_active soft-delete and unique name constraint to branch_devices
-- ═══════════════════════════════════════════════════════════════

-- Soft delete column
ALTER TABLE branch_devices
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Unique device name per branch among active devices (allows NULL device_name)
CREATE UNIQUE INDEX IF NOT EXISTS uq_branch_devices_name_active
    ON branch_devices(branch_id, tenant_id, device_name)
    WHERE is_active = TRUE AND device_name IS NOT NULL;
```

- [ ] **Step 2: Run migration against database**

```bash
cd /c/SYA/sya-socketio-server
# Run the migration via your usual method (psql or app startup)
node -e "
const { Pool } = require('pg');
const fs = require('fs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = fs.readFileSync('migrations/038_terminal_naming.sql', 'utf8');
pool.query(sql).then(() => { console.log('Migration OK'); pool.end(); }).catch(e => { console.error(e); pool.end(); });
"
```

Expected: "Migration OK" — `is_active` column added, unique index created.

- [ ] **Step 3: Verify migration**

```bash
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'branch_devices' AND column_name = 'is_active'\")
  .then(r => { console.log(r.rows); pool.end(); });
"
```

Expected: `[{ column_name: 'is_active', data_type: 'boolean', column_default: 'true' }]`

- [ ] **Step 4: Commit + push**

```bash
git add migrations/038_terminal_naming.sql
git commit -m "feat: add is_active and unique name constraint to branch_devices"
git push origin main
```

---

## Task 2: Backend — PATCH Endpoint + Socket Emit

**Files:**
- Modify: `routes/devices.js`

**Context:** `devices.js` exports `(pool, io) => { ... }` but currently the factory only receives `pool`. Check `server.js` to see if `io` is passed. The existing routes use `const io = req.app.get('io')` pattern as fallback. We'll use the same pattern.

- [ ] **Step 1: Add PATCH `/api/devices/:id` endpoint to `routes/devices.js`**

Insert before `return router;` (line ~320):

```javascript
    // ═══════════════════════════════════════════════════════════════════════════
    // PATCH /api/devices/:id - Rename or deactivate a terminal
    // Only Owner (is_owner=true) or Administrador (role_id=1) can modify
    // ═══════════════════════════════════════════════════════════════════════════
    router.patch('/:id', authenticateToken, async (req, res) => {
        try {
            const deviceId = parseInt(req.params.id);
            const { device_name, is_active } = req.body;
            const tenantId = req.user.tenantId;
            const employeeId = req.user.employeeId;

            if (!deviceId || isNaN(deviceId)) {
                return res.status(400).json({ success: false, message: 'ID de dispositivo inválido' });
            }

            // Check permissions: Owner or Administrador only
            const permCheck = await pool.query(
                `SELECT is_owner, role_id FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE`,
                [employeeId, tenantId]
            );
            if (permCheck.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Empleado no encontrado' });
            }
            const emp = permCheck.rows[0];
            if (!emp.is_owner && emp.role_id !== 1) {
                return res.status(403).json({ success: false, message: 'Solo Owner o Administrador pueden modificar terminales' });
            }

            // Fetch current device
            const current = await pool.query(
                `SELECT * FROM branch_devices WHERE id = $1 AND tenant_id = $2`,
                [deviceId, tenantId]
            );
            if (current.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Dispositivo no encontrado' });
            }
            const device = current.rows[0];

            // Handle deactivation
            if (is_active === false) {
                // Check for active shift
                const activeShift = await pool.query(
                    `SELECT id FROM shifts WHERE terminal_id = $1 AND is_cash_cut_open = TRUE AND tenant_id = $2`,
                    [device.device_id, tenantId]
                );
                if (activeShift.rows.length > 0) {
                    return res.status(400).json({ success: false, message: 'No se puede desactivar una terminal con turno abierto' });
                }

                await pool.query(
                    `UPDATE branch_devices SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
                    [deviceId]
                );
            }

            // Handle reactivation
            if (is_active === true) {
                await pool.query(
                    `UPDATE branch_devices SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
                    [deviceId]
                );
            }

            // Handle rename
            if (device_name !== undefined) {
                const trimmed = (device_name || '').trim();
                if (trimmed.length < 1 || trimmed.length > 50) {
                    return res.status(400).json({ success: false, message: 'El nombre debe tener entre 1 y 50 caracteres' });
                }

                // Check uniqueness among active devices in same branch
                const nameCheck = await pool.query(
                    `SELECT id FROM branch_devices
                     WHERE branch_id = $1 AND tenant_id = $2 AND device_name = $3
                     AND is_active = TRUE AND id != $4`,
                    [device.branch_id, tenantId, trimmed, deviceId]
                );
                if (nameCheck.rows.length > 0) {
                    return res.status(409).json({ success: false, message: `Ya existe una terminal con el nombre "${trimmed}" en esta sucursal` });
                }

                await pool.query(
                    `UPDATE branch_devices SET device_name = $1, updated_at = NOW() WHERE id = $2`,
                    [trimmed, deviceId]
                );
            }

            // Fetch updated device
            const updated = await pool.query(
                `SELECT id, device_id, device_name, device_type, is_primary, is_active, last_seen_at
                 FROM branch_devices WHERE id = $1`,
                [deviceId]
            );
            const result = updated.rows[0];

            // Emit Socket.IO event
            const io = req.app.get('io');
            if (io) {
                io.to(`branch_${device.branch_id}`).emit('terminal:updated', {
                    id: result.id,
                    deviceId: result.device_id,
                    deviceName: result.device_name,
                    deviceType: result.device_type,
                    isPrimary: result.is_primary,
                    isActive: result.is_active
                });
            }

            console.log(`[Devices] ✅ PATCH /${deviceId}: name=${result.device_name}, active=${result.is_active}`);

            res.json({
                success: true,
                data: {
                    id: result.id,
                    device_id: result.device_id,
                    device_name: result.device_name,
                    device_type: result.device_type,
                    is_primary: result.is_primary,
                    is_active: result.is_active,
                    last_seen_at: result.last_seen_at
                }
            });

        } catch (error) {
            console.error('[Devices] ❌ Error en PATCH:', error.message);
            if (error.code === '23505') {
                return res.status(409).json({ success: false, message: 'El nombre ya está en uso' });
            }
            res.status(500).json({ success: false, message: 'Error al actualizar dispositivo' });
        }
    });
```

- [ ] **Step 2: Add `is_active` filter to GET `/api/devices/branch/:branchId`**

In `routes/devices.js`, find the GET endpoint (line ~236) and modify the query:

Change from:
```javascript
const result = await pool.query(`
    SELECT id, device_id, device_name, device_type, is_primary,
           claimed_at, last_seen_at, created_at
    FROM branch_devices
    WHERE branch_id = $1 AND tenant_id = $2
    ORDER BY is_primary DESC, last_seen_at DESC
`, [branchId, tenantId]);
```

To:
```javascript
const { include_inactive } = req.query;
const result = await pool.query(`
    SELECT id, device_id, device_name, device_type, is_primary,
           COALESCE(is_active, TRUE) as is_active,
           claimed_at, last_seen_at, created_at
    FROM branch_devices
    WHERE branch_id = $1 AND tenant_id = $2
    ${include_inactive !== 'true' ? 'AND COALESCE(is_active, TRUE) = TRUE' : ''}
    ORDER BY is_primary DESC, last_seen_at DESC
`, [branchId, tenantId]);
```

- [ ] **Step 3: Add auto-naming to POST `/api/devices/register`**

In `routes/devices.js`, modify the register endpoint (line ~181). Replace the INSERT/UPSERT block with auto-naming logic:

After validation (line ~193), before the INSERT, add:

```javascript
            // Auto-generate name if not provided
            let finalDeviceName = device_name;
            if (!finalDeviceName || finalDeviceName.trim() === '') {
                // Count active devices to suggest next number
                const countResult = await pool.query(
                    `SELECT COUNT(*) as cnt FROM branch_devices
                     WHERE branch_id = $1 AND tenant_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
                    [branch_id, tenantId]
                );
                let n = parseInt(countResult.rows[0].cnt) + 1;
                finalDeviceName = `Caja ${n}`;

                // Retry if name collides (max 5 attempts)
                for (let attempt = 0; attempt < 5; attempt++) {
                    const nameExists = await pool.query(
                        `SELECT id FROM branch_devices
                         WHERE branch_id = $1 AND tenant_id = $2 AND device_name = $3
                         AND COALESCE(is_active, TRUE) = TRUE`,
                        [branch_id, tenantId, finalDeviceName]
                    );
                    if (nameExists.rows.length === 0) break;
                    n++;
                    finalDeviceName = `Caja ${n}`;
                }
            }
```

Then update the INSERT to use `finalDeviceName` instead of `device_name`, and add `is_new` flag to the RETURNING:

```javascript
            const result = await pool.query(`
                INSERT INTO branch_devices (
                    tenant_id, branch_id, device_id, device_name, device_type,
                    is_primary, last_seen_at, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, FALSE, NOW(), NOW(), NOW())
                ON CONFLICT (device_id, branch_id, tenant_id)
                DO UPDATE SET
                    device_name = COALESCE(NULLIF($4, ''), branch_devices.device_name),
                    device_type = COALESCE(EXCLUDED.device_type, branch_devices.device_type),
                    last_seen_at = NOW(),
                    updated_at = NOW()
                RETURNING id, is_primary, device_name,
                    (xmax = 0) as is_new
            `, [tenantId, branch_id, device_id, finalDeviceName, device_type]);
```

Update the response to include is_new and device_name:

```javascript
            res.json({
                success: true,
                message: result.rows[0].is_new ? 'Dispositivo registrado' : 'Dispositivo actualizado',
                data: {
                    id: result.rows[0].id,
                    device_id,
                    device_name: result.rows[0].device_name,
                    is_primary: result.rows[0].is_primary,
                    is_new: result.rows[0].is_new
                }
            });
```

- [ ] **Step 4: Commit + push**

```bash
git add routes/devices.js
git commit -m "feat: terminal naming - PATCH rename/deactivate, auto-naming on register, is_active filter"
git push origin main
```

---

## Task 3: Backend — Auto-Register Terminal on Shift Open

**Files:**
- Modify: `routes/shifts.js:32-150`

**Context:** The POST `/api/shifts/open` endpoint handles shift creation. After successfully opening a shift, we need to ensure the terminal is registered in `branch_devices` and return its name in the response.

- [ ] **Step 1: Add terminal auto-registration after shift creation**

In `routes/shifts.js`, find the success response block (around line 137 where `res.json({ success: true, data: shift })` is). Just BEFORE the response, add:

```javascript
            // ═══════════════════════════════════════════════════════════════
            // Auto-register terminal in branch_devices if not exists
            // ═══════════════════════════════════════════════════════════════
            let terminalInfo = null;
            if (shift.terminal_id) {
                try {
                    const deviceType = shift.terminal_id.startsWith('mobile-') ? 'mobile' : 'desktop';

                    // Check if already registered
                    const existing = await client.query(
                        `SELECT id, device_name, device_type, is_primary, COALESCE(is_active, TRUE) as is_active
                         FROM branch_devices
                         WHERE device_id = $1 AND branch_id = $2 AND tenant_id = $3`,
                        [shift.terminal_id, branchId, tenantId]
                    );

                    if (existing.rows.length > 0) {
                        const dev = existing.rows[0];
                        // Update last_seen_at, reactivate if inactive
                        await client.query(
                            `UPDATE branch_devices SET last_seen_at = NOW(), is_active = TRUE WHERE id = $1`,
                            [dev.id]
                        );
                        terminalInfo = {
                            id: dev.id,
                            name: dev.device_name,
                            deviceType: dev.device_type,
                            isPrimary: dev.is_primary,
                            isNew: false
                        };
                    } else {
                        // Auto-register with suggested name
                        const countResult = await client.query(
                            `SELECT COUNT(*) as cnt FROM branch_devices
                             WHERE branch_id = $1 AND tenant_id = $2 AND COALESCE(is_active, TRUE) = TRUE`,
                            [branchId, tenantId]
                        );
                        let n = parseInt(countResult.rows[0].cnt) + 1;
                        let suggestedName = `Caja ${n}`;

                        // Retry on name collision
                        for (let attempt = 0; attempt < 5; attempt++) {
                            const nameExists = await client.query(
                                `SELECT id FROM branch_devices
                                 WHERE branch_id = $1 AND tenant_id = $2 AND device_name = $3
                                 AND COALESCE(is_active, TRUE) = TRUE`,
                                [branchId, tenantId, suggestedName]
                            );
                            if (nameExists.rows.length === 0) break;
                            n++;
                            suggestedName = `Caja ${n}`;
                        }

                        const inserted = await client.query(
                            `INSERT INTO branch_devices (tenant_id, branch_id, device_id, device_name, device_type, is_primary, last_seen_at, created_at, updated_at)
                             VALUES ($1, $2, $3, $4, $5, FALSE, NOW(), NOW(), NOW())
                             ON CONFLICT (device_id, branch_id, tenant_id) DO UPDATE SET last_seen_at = NOW()
                             RETURNING id, device_name, device_type, is_primary`,
                            [tenantId, branchId, shift.terminal_id, suggestedName, deviceType]
                        );
                        const dev = inserted.rows[0];
                        terminalInfo = {
                            id: dev.id,
                            name: dev.device_name,
                            deviceType: dev.device_type,
                            isPrimary: dev.is_primary,
                            isNew: true
                        };
                    }
                    console.log(`[Shifts] 🏷️ Terminal: ${terminalInfo.name} (${terminalInfo.isNew ? 'NEW' : 'existing'})`);
                } catch (termErr) {
                    console.error(`[Shifts] ⚠️ Terminal registration error (non-fatal):`, termErr.message);
                }
            }
```

- [ ] **Step 2: Include terminal info in shift open response**

Find the success response (around line 137-147) and add `terminal` to it:

Change from:
```javascript
            res.status(201).json({
                success: true,
                data: shift,
                message: 'Turno abierto exitosamente'
            });
```

To:
```javascript
            res.status(201).json({
                success: true,
                data: shift,
                terminal: terminalInfo,
                message: 'Turno abierto exitosamente'
            });
```

- [ ] **Step 3: Commit + push**

```bash
git add routes/shifts.js
git commit -m "feat: auto-register terminal on shift open, return terminal info in response"
git push origin main
```

---

## Task 4: Desktop — Terminal Name Cache in BackendSyncService

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Services\BackendSyncService.cs`

**Context:** `BackendSyncService` already has `GetDashboardSummaryFromServerAsync` and `GetSalesFromServerAsync`. We add a method to fetch terminal list and an in-memory cache for name resolution.

- [ ] **Step 1: Add terminal cache fields and data class**

Near the other data classes (around line 2696), add:

```csharp
        public class ServerTerminal
        {
            public int Id { get; set; }
            public string DeviceId { get; set; } = "";
            public string DeviceName { get; set; } = "";
            public string DeviceType { get; set; } = "desktop";
            public bool IsPrimary { get; set; }
            public bool IsActive { get; set; } = true;
        }
```

- [ ] **Step 2: Add cache and fetch method**

Near the top of the `BackendSyncService` class, add a static cache:

```csharp
        // Terminal name cache: terminal_id → device_name
        private static readonly Dictionary<string, string> _terminalNameCache = new();
        private static readonly object _terminalCacheLock = new();

        public static string ResolveTerminalName(string? terminalId)
        {
            if (string.IsNullOrEmpty(terminalId)) return "Caja ?";
            lock (_terminalCacheLock)
            {
                if (_terminalNameCache.TryGetValue(terminalId, out var name))
                    return name;
            }
            // Fallback: first 4 chars of UUID
            return terminalId.Length >= 4 ? terminalId[..4].ToUpper() : terminalId.ToUpper();
        }

        public static void UpdateTerminalCache(string terminalId, string name)
        {
            lock (_terminalCacheLock)
            {
                _terminalNameCache[terminalId] = name;
            }
        }

        public async Task<List<ServerTerminal>?> GetTerminalsAsync(int branchId)
        {
            if (!System.Net.NetworkInformation.NetworkInterface.GetIsNetworkAvailable())
                return null;

            try
            {
                var request = await CreateAuthenticatedRequest(HttpMethod.Get, $"/api/devices/branch/{branchId}");
                var response = await _httpClient.SendAsync(request);
                if (!response.IsSuccessStatusCode) return null;

                var json = await response.Content.ReadAsStringAsync();
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (!root.TryGetProperty("success", out var s) || !s.GetBoolean()) return null;

                var devices = root.GetProperty("data").GetProperty("devices");
                var results = new List<ServerTerminal>();

                foreach (var item in devices.EnumerateArray())
                {
                    var terminal = new ServerTerminal
                    {
                        Id = item.TryGetProperty("id", out var id) ? id.GetInt32() : 0,
                        DeviceId = item.TryGetProperty("device_id", out var did) ? did.GetString() ?? "" : "",
                        DeviceName = item.TryGetProperty("device_name", out var dn) ? dn.GetString() ?? "" : "",
                        DeviceType = item.TryGetProperty("device_type", out var dt) ? dt.GetString() ?? "desktop" : "desktop",
                        IsPrimary = item.TryGetProperty("is_primary", out var ip) && ip.GetBoolean(),
                        IsActive = item.TryGetProperty("is_active", out var ia) ? ia.GetBoolean() : true,
                    };
                    results.Add(terminal);

                    // Populate cache
                    if (!string.IsNullOrEmpty(terminal.DeviceId) && !string.IsNullOrEmpty(terminal.DeviceName))
                        UpdateTerminalCache(terminal.DeviceId, terminal.DeviceName);
                }

                Debug.WriteLine($"[BackendSync] ✅ {results.Count} terminales cargadas, cache actualizado");
                return results;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[BackendSync] GetTerminals error: {ex.Message}");
                return null;
            }
        }
```

- [ ] **Step 3: No commit (Desktop — only commit when user asks)**

---

## Task 5: Desktop — Capture Terminal Info on Login + Cache Names

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Models\CurrentSession.cs`
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\LoginViewModel.cs`

- [ ] **Step 1: Add TerminalName to CurrentSession model**

In `Models/CurrentSession.cs`, add after the `TerminalId` property:

```csharp
        public string TerminalName { get; set; } = "";
```

- [ ] **Step 2: Parse terminal info from shift open response in LoginViewModel**

In `LoginViewModel.cs`, find where the shift open response is processed (where `MultiCajaEnabled` is set). After capturing the shift data, add terminal info parsing:

```csharp
// After shift open success, parse terminal info
if (responseJson.TryGetProperty("terminal", out var terminalProp) && terminalProp.ValueKind == JsonValueKind.Object)
{
    var terminalName = terminalProp.TryGetProperty("name", out var tn) ? tn.GetString() ?? "" : "";
    if (!string.IsNullOrEmpty(terminalName))
    {
        _sessionService.CurrentSession.TerminalName = terminalName;
        Services.BackendSyncService.UpdateTerminalCache(
            _sessionService.CurrentSession.TerminalId, terminalName);
        Debug.WriteLine($"[LoginViewModel] 🏷️ Terminal: {terminalName}");
    }
}
```

- [ ] **Step 3: Fetch all terminal names after login**

After shift open succeeds and session is established, add a background call to cache all terminal names:

```csharp
// Load terminal name cache for this branch (for resolving other terminals' names)
_ = Task.Run(async () =>
{
    try
    {
        var backendSync = App.Current.Services.GetRequiredService<IBackendSyncService>() as Services.BackendSyncService;
        var userConfig = new Services.UserConfigService();
        var branchId = userConfig.GetBranchId() ?? 0;
        if (backendSync != null && branchId > 0)
            await backendSync.GetTerminalsAsync(branchId);
    }
    catch (Exception ex)
    {
        Debug.WriteLine($"[LoginViewModel] ⚠️ Terminal cache load error: {ex.Message}");
    }
});
```

- [ ] **Step 4: No commit (Desktop)**

---

## Task 6: Desktop — POS Header Badge

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Views\ShellPage.xaml`
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\ShellViewModel.cs`

- [ ] **Step 1: Add TerminalName property to ShellViewModel**

In `ShellViewModel.cs`, add an observable property:

```csharp
[ObservableProperty]
private string _terminalDisplayName = "";
```

And in the initialization or shift-loaded method, set it:

```csharp
var session = _sessionService.CurrentSession;
TerminalDisplayName = !string.IsNullOrEmpty(session.TerminalName)
    ? session.TerminalName
    : "Terminal";
```

- [ ] **Step 2: Add terminal badge to ShellPage.xaml**

In `ShellPage.xaml`, find the status badges section (near the "Caja Auxiliar" badge). Add a new badge after it:

```xml
<!-- Terminal Name Badge -->
<Border Background="{ThemeResource CardBackgroundFillColorDefaultBrush}"
        BorderBrush="{ThemeResource CardStrokeColorDefaultBrush}"
        BorderThickness="1" CornerRadius="6"
        Padding="10,4" Margin="4,0"
        Visibility="{x:Bind ViewModel.HasTerminalName, Mode=OneWay}">
    <StackPanel Orientation="Horizontal" Spacing="6">
        <FontIcon Glyph="&#xE7F8;" FontSize="14"
                  Foreground="{ThemeResource SystemAccentColor}"/>
        <TextBlock Text="{x:Bind ViewModel.TerminalDisplayName, Mode=OneWay}"
                   Style="{ThemeResource CaptionTextBlockStyle}"
                   VerticalAlignment="Center"/>
    </StackPanel>
</Border>
```

Add `HasTerminalName` computed property in ShellViewModel:

```csharp
public bool HasTerminalName => !string.IsNullOrEmpty(TerminalDisplayName)
    && TerminalDisplayName != "Terminal";
```

- [ ] **Step 3: No commit (Desktop)**

---

## Task 7: Desktop — FormatTicketDisplay + Receipt

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\VentasDashboardViewModel.cs:1168-1184`
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Models\ReceiptSettings.cs`
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Helpers\ReceiptFormatter.cs:194-205`
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Reports\Designs\SaleReceiptPdfDesigner.cs:187-194`
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Views\ReceiptSettingsPage.xaml`
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\ReceiptSettingsViewModel.cs`

- [ ] **Step 1: Update FormatTicketDisplay to use terminal name**

In `VentasDashboardViewModel.cs`, change the body of `FormatTicketDisplay` (line ~1168). Keep the 3-arg signature so existing callers don't break:

```csharp
private static string FormatTicketDisplay(string? terminalId, int idTurno, int ticketNumber)
{
    // idTurno kept for backward compat but no longer shown in display
    var terminalName = Services.BackendSyncService.ResolveTerminalName(terminalId);
    return $"{terminalName} #{ticketNumber}";
}
```

Call sites at lines ~303 and ~775 remain unchanged — they already pass 3 args.

- [ ] **Step 2: Add ShowTerminalName to ReceiptSettings**

In `Models/ReceiptSettings.cs`, after `ShowCanal` (line ~100):

```csharp
        /// <summary>Mostrar nombre de terminal en el ticket</summary>
        public bool ShowTerminalName { get; set; } = true;
```

- [ ] **Step 3: Add terminal line to ReceiptFormatter (ESC/POS)**

In `Helpers/ReceiptFormatter.cs`, after the Canal block (line ~205):

```csharp
            // Terminal (configurable)
            if (settings.ShowTerminalName)
            {
                var terminalName = Services.BackendSyncService.ResolveTerminalName(sale?.TerminalId);
                lines.Add($"Terminal: {terminalName}");
            }
```

- [ ] **Step 4: Add terminal line to PDF receipt**

In `Reports/Designs/SaleReceiptPdfDesigner.cs`, after the Canal block (line ~199, after `y += bodyFont.Height + 2;`):

```csharp
            if (_settings.ShowTerminalName)
            {
                var terminalName = Services.BackendSyncService.ResolveTerminalName(_sale?.TerminalId);
                if (!onlyMeasure) g.DrawString($"Terminal: {terminalName}", bodyFont, PdfBrushes.Black, SideMargin, y);
                y += bodyFont.Height + 2;
            }
```

- [ ] **Step 5: Add toggle to ReceiptSettingsPage.xaml**

After the ShowCanal toggle (line ~366):

```xml
<ToggleSwitch
    Header="Terminal"
    IsOn="{x:Bind ViewModel.Settings.ShowTerminalName, Mode=TwoWay}"
    OffContent="Oculto"
    OnContent="Visible"
    Toggled="OnTicketFieldToggled"/>
```

- [ ] **Step 6: Sync in ReceiptSettingsViewModel**

In `ReceiptSettingsViewModel.cs`, in `SyncSettingsToService()` (line ~338), add:

```csharp
            current.ShowTerminalName = Settings.ShowTerminalName;
```

- [ ] **Step 7: No commit (Desktop)**

---

## Task 8: Flutter — Terminal Model + API Service

**Files:**
- Create: `C:\SYA\sya_mobile_app\lib\features\terminals\models\terminal_model.dart`
- Create: `C:\SYA\sya_mobile_app\lib\features\terminals\services\terminal_api_service.dart`

- [ ] **Step 1: Create terminal model**

```dart
// lib/features/terminals/models/terminal_model.dart

class Terminal {
  final int id;
  final String deviceId;
  final String deviceName;
  final String deviceType; // 'desktop' | 'mobile'
  final bool isPrimary;
  final bool isActive;
  final DateTime? lastSeenAt;

  const Terminal({
    required this.id,
    required this.deviceId,
    required this.deviceName,
    this.deviceType = 'desktop',
    this.isPrimary = false,
    this.isActive = true,
    this.lastSeenAt,
  });

  factory Terminal.fromJson(Map<String, dynamic> json) {
    return Terminal(
      id: json['id'] as int? ?? 0,
      deviceId: json['device_id'] as String? ?? '',
      deviceName: json['device_name'] as String? ?? '',
      deviceType: json['device_type'] as String? ?? 'desktop',
      isPrimary: json['is_primary'] as bool? ?? false,
      isActive: json['is_active'] as bool? ?? true,
      lastSeenAt: json['last_seen_at'] != null
          ? DateTime.tryParse(json['last_seen_at'] as String)
          : null,
    );
  }

  bool get isDesktop => deviceType == 'desktop';
  bool get isMobile => deviceType == 'mobile';
}
```

- [ ] **Step 2: Create terminal API service with name cache**

```dart
// lib/features/terminals/services/terminal_api_service.dart

import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import '../models/terminal_model.dart';

class TerminalApiService {
  final String baseUrl;
  final String Function() getToken;

  // In-memory cache: deviceId → deviceName
  static final Map<String, String> _nameCache = {};

  TerminalApiService({required this.baseUrl, required this.getToken});

  static String resolveTerminalName(String? terminalId) {
    if (terminalId == null || terminalId.isEmpty) return 'Caja ?';
    return _nameCache[terminalId] ??
           (terminalId.length >= 4 ? terminalId.substring(0, 4).toUpperCase() : terminalId.toUpperCase());
  }

  static void updateCache(String terminalId, String name) {
    _nameCache[terminalId] = name;
  }

  Future<List<Terminal>> getTerminals(int branchId, {bool includeInactive = false}) async {
    try {
      final url = '$baseUrl/api/devices/branch/$branchId${includeInactive ? '?include_inactive=true' : ''}';
      final response = await http.get(
        Uri.parse(url),
        headers: {'Authorization': 'Bearer ${getToken()}'},
      );
      if (response.statusCode != 200) return [];

      final data = json.decode(response.body);
      if (data['success'] != true) return [];

      final devices = (data['data']['devices'] as List)
          .map((d) => Terminal.fromJson(d))
          .toList();

      // Populate cache
      for (final t in devices) {
        if (t.deviceId.isNotEmpty && t.deviceName.isNotEmpty) {
          _nameCache[t.deviceId] = t.deviceName;
        }
      }
      debugPrint('[TerminalApi] ✅ ${devices.length} terminals loaded, cache updated');
      return devices;
    } catch (e) {
      debugPrint('[TerminalApi] Error: $e');
      return [];
    }
  }

  Future<bool> renameTerminal(int id, String newName) async {
    try {
      final response = await http.patch(
        Uri.parse('$baseUrl/api/devices/$id'),
        headers: {
          'Authorization': 'Bearer ${getToken()}',
          'Content-Type': 'application/json',
        },
        body: json.encode({'device_name': newName}),
      );
      return response.statusCode == 200;
    } catch (e) {
      debugPrint('[TerminalApi] Rename error: $e');
      return false;
    }
  }

  Future<bool> setTerminalActive(int id, bool active) async {
    try {
      final response = await http.patch(
        Uri.parse('$baseUrl/api/devices/$id'),
        headers: {
          'Authorization': 'Bearer ${getToken()}',
          'Content-Type': 'application/json',
        },
        body: json.encode({'is_active': active}),
      );
      return response.statusCode == 200;
    } catch (e) {
      debugPrint('[TerminalApi] SetActive error: $e');
      return false;
    }
  }
}
```

- [ ] **Step 3: No commit (Flutter)**

---

## Task 9: Flutter — Socket Listener + POS Badge + Shift Open Parsing

**Files:**
- Modify: `C:\SYA\sya_mobile_app\lib\infrastructure\socket\socket_service.dart`
- Modify: `C:\SYA\sya_mobile_app\lib\features\pos\services\pos_api_service.dart`
- Modify: `C:\SYA\sya_mobile_app\lib\features\pos\viewmodels\pos_view_model.dart`
- Modify: `C:\SYA\sya_mobile_app\lib\features\pos\pages\pos_page.dart`

- [ ] **Step 1: Add terminal:updated listener in SocketService**

In `socket_service.dart`, in `_setupSocketListeners()` method, add:

```dart
    _socket!.on('terminal:updated', (data) {
      try {
        final map = Map<String, dynamic>.from(
          (data is List ? data.first : data) as Map
        );
        final deviceId = map['deviceId'] as String? ?? '';
        final deviceName = map['deviceName'] as String? ?? '';
        if (deviceId.isNotEmpty && deviceName.isNotEmpty) {
          TerminalApiService.updateCache(deviceId, deviceName);
        }
        _terminalUpdatedController.add(map);
        print('[Socket.IO] 🏷️ terminal:updated: $deviceName');
      } catch (e) {
        print('[Socket.IO] ❌ Error terminal:updated: $e');
      }
    });
```

Add the StreamController near other controllers:

```dart
    final _terminalUpdatedController = StreamController<Map<String, dynamic>>.broadcast();
    Stream<Map<String, dynamic>> get terminalUpdatedStream => _terminalUpdatedController.stream;
```

Don't forget to add the import for TerminalApiService and close the controller in dispose.

- [ ] **Step 2: Parse terminal info from shift open response**

In `pos_api_service.dart`, after the shift data is parsed from the response (line ~259-262), add terminal name extraction:

```dart
      // Parse terminal info if present
      if (data['terminal'] != null) {
        final terminal = data['terminal'] as Map<String, dynamic>;
        final terminalName = terminal['name'] as String? ?? '';
        final terminalId = responseData['terminal_id'] as String? ?? '';
        if (terminalName.isNotEmpty && terminalId.isNotEmpty) {
          TerminalApiService.updateCache(terminalId, terminalName);
        }
      }
```

- [ ] **Step 3: Store terminal name in POS ViewModel**

In `pos_view_model.dart`, add a field:

```dart
String _terminalName = '';
String get terminalName => _terminalName;
```

In the `openShift` method, after shift opens successfully:

```dart
    _terminalName = TerminalApiService.resolveTerminalName(_terminalId);
    notifyListeners();
```

- [ ] **Step 4: Add terminal badge to POS AppBar**

In `pos_page.dart`, in the AppBar `actions` list (around line 280), add before the connection dot:

```dart
// Terminal badge
if (viewModel.terminalName.isNotEmpty)
  Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(6),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          viewModel.terminalName.contains('Móvil') ? Icons.phone_android : Icons.point_of_sale,
          size: 14,
          color: Theme.of(context).colorScheme.primary,
        ),
        const SizedBox(width: 4),
        Text(
          viewModel.terminalName,
          style: Theme.of(context).textTheme.labelSmall,
        ),
      ],
    ),
  ),
```

- [ ] **Step 5: No commit (Flutter)**

---

## Task 10: Flutter — Terminal Management Page

**Files:**
- Create: `C:\SYA\sya_mobile_app\lib\features\terminals\pages\terminal_management_page.dart`
- Modify: `C:\SYA\sya_mobile_app\lib\presentation\views\settings_page.dart`

- [ ] **Step 1: Create terminal management page**

```dart
// lib/features/terminals/pages/terminal_management_page.dart

import 'package:flutter/material.dart';
import '../models/terminal_model.dart';
import '../services/terminal_api_service.dart';

class TerminalManagementPage extends StatefulWidget {
  final TerminalApiService terminalService;
  final int branchId;
  final bool canEdit; // Owner or Admin

  const TerminalManagementPage({
    super.key,
    required this.terminalService,
    required this.branchId,
    required this.canEdit,
  });

  @override
  State<TerminalManagementPage> createState() => _TerminalManagementPageState();
}

class _TerminalManagementPageState extends State<TerminalManagementPage> {
  List<Terminal> _terminals = [];
  bool _loading = true;
  bool _showInactive = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final terminals = await widget.terminalService.getTerminals(
      widget.branchId, includeInactive: _showInactive);
    if (!mounted) return;
    setState(() {
      _terminals = terminals;
      _loading = false;
    });
  }

  Future<void> _rename(Terminal terminal) async {
    final controller = TextEditingController(text: terminal.deviceName);
    final newName = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Renombrar terminal'),
        content: TextField(
          controller: controller,
          maxLength: 50,
          decoration: const InputDecoration(labelText: 'Nombre'),
          autofocus: true,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancelar')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Guardar'),
          ),
        ],
      ),
    );
    if (newName == null || newName.isEmpty || newName == terminal.deviceName) return;

    final ok = await widget.terminalService.renameTerminal(terminal.id, newName);
    if (!mounted) return;
    if (ok) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Terminal renombrada a "$newName"')));
      _load();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Error al renombrar. Verifica que el nombre no esté duplicado.')));
    }
  }

  Future<void> _toggleActive(Terminal terminal) async {
    final ok = await widget.terminalService.setTerminalActive(terminal.id, !terminal.isActive);
    if (!mounted) return;
    if (ok) {
      _load();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(terminal.isActive
            ? 'No se puede desactivar (¿tiene turno abierto?)'
            : 'Error al reactivar')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Terminales'),
        actions: [
          if (widget.canEdit)
            FilterChip(
              label: const Text('Inactivas'),
              selected: _showInactive,
              onSelected: (v) {
                _showInactive = v;
                _load();
              },
            ),
          const SizedBox(width: 8),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _terminals.isEmpty
              ? const Center(child: Text('No hay terminales registradas'))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView.builder(
                    itemCount: _terminals.length,
                    itemBuilder: (ctx, i) {
                      final t = _terminals[i];
                      return ListTile(
                        leading: Icon(
                          t.isMobile ? Icons.phone_android : Icons.desktop_windows,
                          color: t.isActive
                              ? Theme.of(context).colorScheme.primary
                              : Theme.of(context).disabledColor,
                        ),
                        title: Text(
                          t.deviceName.isEmpty ? 'Sin nombre' : t.deviceName,
                          style: TextStyle(
                            color: t.isActive ? null : Theme.of(context).disabledColor,
                            decoration: t.isActive ? null : TextDecoration.lineThrough,
                          ),
                        ),
                        subtitle: Text([
                          if (t.isPrimary) 'Principal',
                          if (!t.isActive) 'Inactiva',
                          if (t.lastSeenAt != null) 'Última vez: ${_formatDate(t.lastSeenAt!)}',
                        ].join(' · ')),
                        trailing: widget.canEdit
                            ? PopupMenuButton<String>(
                                onSelected: (action) {
                                  if (action == 'rename') _rename(t);
                                  if (action == 'toggle') _toggleActive(t);
                                },
                                itemBuilder: (_) => [
                                  const PopupMenuItem(value: 'rename', child: Text('Renombrar')),
                                  PopupMenuItem(
                                    value: 'toggle',
                                    child: Text(t.isActive ? 'Desactivar' : 'Reactivar'),
                                  ),
                                ],
                              )
                            : null,
                      );
                    },
                  ),
                ),
    );
  }

  String _formatDate(DateTime dt) {
    final now = DateTime.now();
    final diff = now.difference(dt);
    if (diff.inMinutes < 5) return 'Ahora';
    if (diff.inHours < 1) return 'Hace ${diff.inMinutes}m';
    if (diff.inDays < 1) return 'Hace ${diff.inHours}h';
    return '${dt.day}/${dt.month} ${dt.hour}:${dt.minute.toString().padLeft(2, '0')}';
  }
}
```

- [ ] **Step 2: Add entry in settings page**

In `settings_page.dart`, add a ListTile in the appropriate section:

```dart
ListTile(
  leading: const Icon(Icons.point_of_sale),
  title: const Text('Terminales'),
  subtitle: const Text('Nombrar y administrar dispositivos'),
  trailing: const Icon(Icons.chevron_right),
  onTap: () {
    Navigator.push(context, MaterialPageRoute(
      builder: (_) => TerminalManagementPage(
        terminalService: terminalService, // inject from parent
        branchId: branchId,               // from session
        canEdit: isOwnerOrAdmin,          // from user role
      ),
    ));
  },
),
```

- [ ] **Step 3: No commit (Flutter)**

---

## Task 11: Desktop — VentasDashboard Terminal Column + Corte de Caja + Liquidaciones

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\VentasDashboardViewModel.cs`
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Models\SaleRowViewModel.cs` (add Terminal property)
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Views\VentasDashboardPage.xaml` (add column to DataGrid)
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Models\OpenShiftDisplay.cs` (add TerminalName)
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\CashDrawerViewModel.cs` (resolve terminal name for display)

- [ ] **Step 1: Add Terminal property to SaleRowViewModel**

Find `SaleRowViewModel` (search for `class SaleRowViewModel`) and add:

```csharp
public string Terminal { get; set; } = "";
```

- [ ] **Step 2: Populate Terminal in VentasDashboardViewModel**

In the server-first block (where `SaleRowViewModel` rows are created, ~line 298), add:

```csharp
Terminal = Services.BackendSyncService.ResolveTerminalName(s.TerminalId),
```

In the local sales block (where `_allSaleRows.Add(new SaleRowViewModel { ... })`, ~line 649), add:

```csharp
Terminal = Services.BackendSyncService.ResolveTerminalName(v.TerminalId),
```

- [ ] **Step 3: Add Terminal column to VentasDashboardPage.xaml DataGrid**

Find the DataGrid columns in `VentasDashboardPage.xaml` and add after the Canal column:

```xml
<controls:DataGridTextColumn Header="Terminal" Binding="{Binding Terminal}" Width="Auto"/>
```

- [ ] **Step 4: Add TerminalName to OpenShiftDisplay**

In `Models/OpenShiftDisplay.cs`:

```csharp
public string TerminalName { get; set; } = "";

public string Display => string.IsNullOrEmpty(TerminalName)
    ? EmployeeName
    : $"{EmployeeName} — {TerminalName}";
```

- [ ] **Step 5: Resolve terminal name in CashDrawerViewModel**

In `CashDrawerViewModel.cs`, where `OpenShiftDisplay` objects are created (~line 333):

```csharp
var items = shifts.Select(s => new OpenShiftDisplay
{
    Shift = s,
    EmployeeName = employeeNames.TryGetValue(s.EmployeeId, out var name)
        ? name
        : $"Empleado {s.EmployeeId}",
    TerminalName = Services.BackendSyncService.ResolveTerminalName(s.TerminalId)
}).ToList();
```

This makes the ComboBox display "María López — Caja 1" for each shift.

- [ ] **Step 6: No commit (Desktop)**

---

## Task 12: Desktop — Terminal Management Settings Page

**Files:**
- Create: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\TerminalManagementViewModel.cs`
- Create: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Views\TerminalManagementPage.xaml`
- Create: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Views\TerminalManagementPage.xaml.cs`

**Context:** Follow the pattern of existing settings pages (ReceiptSettingsViewModel). The page shows a list of terminals for the branch with inline rename and deactivate actions. Only visible to Owner/Admin.

- [ ] **Step 1: Create TerminalManagementViewModel**

```csharp
// ViewModels/TerminalManagementViewModel.cs
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using System.Collections.ObjectModel;
using System.Diagnostics;

namespace SyaTortilleriasWinUi.ViewModels;

public partial class TerminalManagementViewModel : ObservableObject
{
    private readonly Services.IBackendSyncService _backendSync;
    private readonly Services.ISessionService _sessionService;

    [ObservableProperty] private bool _isBusy;
    [ObservableProperty] private bool _showInactive;

    public ObservableCollection<TerminalDisplayItem> Terminals { get; } = new();

    public TerminalManagementViewModel(
        Services.IBackendSyncService backendSync,
        Services.ISessionService sessionService)
    {
        _backendSync = backendSync;
        _sessionService = sessionService;
    }

    [RelayCommand]
    public async Task LoadAsync()
    {
        IsBusy = true;
        try
        {
            var backendSync = _backendSync as Services.BackendSyncService;
            var branchId = new Services.UserConfigService().GetBranchId() ?? 0;
            if (backendSync == null || branchId <= 0) return;

            var terminals = await backendSync.GetTerminalsAsync(branchId);
            Terminals.Clear();
            if (terminals != null)
            {
                foreach (var t in terminals)
                {
                    if (!ShowInactive && !t.IsActive) continue;
                    Terminals.Add(new TerminalDisplayItem
                    {
                        Id = t.Id,
                        DeviceId = t.DeviceId,
                        Name = t.DeviceName,
                        DeviceType = t.DeviceType,
                        IsPrimary = t.IsPrimary,
                        IsActive = t.IsActive,
                    });
                }
            }
        }
        finally { IsBusy = false; }
    }

    // Rename and deactivate will use BackendSyncService PATCH calls
    // (add RenameTerminalAsync and SetTerminalActiveAsync to BackendSyncService)
}

public class TerminalDisplayItem
{
    public int Id { get; set; }
    public string DeviceId { get; set; } = "";
    public string Name { get; set; } = "";
    public string DeviceType { get; set; } = "desktop";
    public bool IsPrimary { get; set; }
    public bool IsActive { get; set; }
    public string DeviceIcon => DeviceType == "mobile" ? "\uE8EA" : "\uE7F8"; // Phone or Desktop icon
    public string StatusText => IsActive ? (IsPrimary ? "Principal" : "Activa") : "Inactiva";
}
```

- [ ] **Step 2: Create TerminalManagementPage XAML**

Create a basic page with a ListView showing terminal items with rename/deactivate buttons. Follow the pattern of other settings pages in the project. The XAML should bind to `TerminalManagementViewModel.Terminals` and show each terminal's icon, name, status, and action buttons.

- [ ] **Step 3: Add PATCH methods to BackendSyncService**

In `BackendSyncService.cs`, add:

```csharp
        public async Task<bool> RenameTerminalAsync(int terminalDbId, string newName)
        {
            try
            {
                var request = await CreateAuthenticatedRequest(HttpMethod.Patch, $"/api/devices/{terminalDbId}");
                request.Content = new StringContent(
                    System.Text.Json.JsonSerializer.Serialize(new { device_name = newName }),
                    System.Text.Encoding.UTF8, "application/json");
                var response = await _httpClient.SendAsync(request);
                return response.IsSuccessStatusCode;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[BackendSync] RenameTerminal error: {ex.Message}");
                return false;
            }
        }

        public async Task<bool> SetTerminalActiveAsync(int terminalDbId, bool active)
        {
            try
            {
                var request = await CreateAuthenticatedRequest(HttpMethod.Patch, $"/api/devices/{terminalDbId}");
                request.Content = new StringContent(
                    System.Text.Json.JsonSerializer.Serialize(new { is_active = active }),
                    System.Text.Encoding.UTF8, "application/json");
                var response = await _httpClient.SendAsync(request);
                return response.IsSuccessStatusCode;
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[BackendSync] SetTerminalActive error: {ex.Message}");
                return false;
            }
        }
```

- [ ] **Step 4: Register page in navigation (settings section)**

Add a navigation entry in the settings area that links to `TerminalManagementPage`. Only show for Owner/Admin roles.

- [ ] **Step 5: No commit (Desktop)**

---

## Task 13: Desktop + Flutter — Persist Terminal Name Cache Locally

**Files:**
- Modify: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Services\BackendSyncService.cs`
- Modify: `C:\SYA\sya_mobile_app\lib\features\terminals\services\terminal_api_service.dart`

**Context:** The in-memory cache is lost on restart. If app starts offline, terminal names won't resolve. Persist to local storage.

- [ ] **Step 1: Desktop — Save/load terminal cache to SQLite**

In `BackendSyncService.cs`, after populating the cache in `GetTerminalsAsync`, persist to SQLite `CurrentSession` or a dedicated setting:

```csharp
        // After cache population in GetTerminalsAsync:
        try
        {
            var cacheJson = System.Text.Json.JsonSerializer.Serialize(_terminalNameCache);
            var db = await App.Current.Services.GetRequiredService<IDatabaseService>().GetConnectionAsync();
            await db.ExecuteAsync(
                "UPDATE CurrentSession SET TerminalNameCache = ? WHERE Id = 1",
                cacheJson);
        }
        catch { /* Non-fatal: cache persistence is best-effort */ }
```

Add `TerminalNameCache` string property to `CurrentSession.cs`:

```csharp
        public string TerminalNameCache { get; set; } = "";
```

On startup (in `GetTerminalsAsync` or a separate init method), load the cache:

```csharp
        public static void LoadCacheFromLocal(string? json)
        {
            if (string.IsNullOrEmpty(json)) return;
            try
            {
                var cached = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(json);
                if (cached == null) return;
                lock (_terminalCacheLock)
                {
                    foreach (var kvp in cached)
                        _terminalNameCache.TryAdd(kvp.Key, kvp.Value);
                }
            }
            catch { }
        }
```

Call `LoadCacheFromLocal(session.TerminalNameCache)` early in the login flow.

- [ ] **Step 2: Flutter — Save/load terminal cache to SharedPreferences**

In `terminal_api_service.dart`:

```dart
  static const _cacheKey = 'terminal_name_cache';

  static Future<void> _persistCache() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_cacheKey, json.encode(_nameCache));
    } catch (_) {}
  }

  static Future<void> loadCacheFromLocal() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final cached = prefs.getString(_cacheKey);
      if (cached != null) {
        final map = Map<String, String>.from(json.decode(cached) as Map);
        _nameCache.addAll(map);
      }
    } catch (_) {}
  }
```

Call `_persistCache()` at the end of `getTerminals()`. Call `loadCacheFromLocal()` during app initialization.

- [ ] **Step 3: No commit (Desktop/Flutter)**

---

## Implementation Order

Tasks 1-3 (Backend) must be done first and pushed. Tasks 4-7 and 11-13 (Desktop) and Tasks 8-10 (Flutter) can be done in parallel after backend is deployed.

```
Task 1 (Migration) → Task 2 (PATCH + register + list) → Task 3 (Shift open)
                                                              ↓
                                          ┌─────────────────────────────────────┐
                                          ↓                                     ↓
                                  Tasks 4-7, 11-13 (Desktop)           Tasks 8-10, 13 (Flutter)
```

