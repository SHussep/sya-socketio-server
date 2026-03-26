# Shift Mutual Exclusion Across Devices

## Goal

Prevent one employee from having active sessions on multiple devices simultaneously. When an employee logs in on Device B while Device A has an active session, Device B is offered a force-takeover. The shift stays open on the backend — Device B inherits it. Device A gets kicked to login.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Force-close shift on takeover? | No — keep shift open, new device inherits it | No data loss, employee continues where they left off |
| Offline device behavior | Allow takeover with warning; offline device kicked on reconnect | Blocking is too disruptive if device is dead/lost |
| Where to check | At login time, before entering the app | Catches conflict early, gates at the entry point |
| Tracking mechanism | Hybrid: in-memory Map for real-time + DB flag for offline reconnect | Fast real-time checks, reliable offline revocation |
| Desktop force_logout UX | Blocking dialog with OK button, then navigate to login | Gives user a moment to understand what happened |
| Shift inheritance | Inherit shift metadata only (id, initial_amount, start_time) | Simpler; dashboard/backend has full history already |
| ID type for session tracking | PostgreSQL integer ID (from JWT `employeeId`) everywhere | Consistent — JWT is the source of truth for socket auth |
| Admin/Owner roles | Subject to same mutual exclusion rules | Admins can still skip shifts, but can't have dual active sessions |

## Architecture

Three components: Backend orchestration, Desktop handler, Mobile enhanced login.

**Key constraint:** All `employeeId` references in session tracking use the **PostgreSQL integer ID** from the JWT, not the UUID `globalId` nor the SQLite local ID.

### 1. Backend — Session Registry + Force-Logout Orchestration

#### In-Memory Session Registry

`activeDeviceSessions`: `Map<employeeId, {socketId, clientType, branchId, connectedAt}>`

- **Populated** on `identify_client` Socket.IO event (after JWT auth)
- **Removed** on `disconnect` event (only if socketId matches current entry)
- **Queried** during login to answer: "is the other device online right now?"
- **Overwrites** on duplicate: if same employee connects from a new socket, old entry is replaced (handles multi-window/reconnect gracefully)

```
// Lifecycle:
identify_client({type: 'mobile'})
  → activeDeviceSessions.set(employeeId, {socketId, clientType: 'mobile', branchId, connectedAt: Date.now()})

disconnect
  → if activeDeviceSessions.get(employeeId)?.socketId === socket.id
       activeDeviceSessions.delete(employeeId)
```

#### Database: Employee Session Revocation Flag

New columns on `employees` table:

```sql
ALTER TABLE employees ADD COLUMN IF NOT EXISTS session_revoked_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS session_revoked_for_device VARCHAR(20) DEFAULT NULL;
```

- `session_revoked_at`: Set to `NOW()` when force-takeover targets an **offline** device
- `session_revoked_for_device`: The device type being revoked (`'desktop'` or `'mobile'`), so only the correct device gets kicked on reconnect
- Checked on `identify_client` — if set AND `session_revoked_for_device` matches the connecting device's type, emit `force_logout` and clear both columns
- Uses atomic `UPDATE ... RETURNING` to prevent race conditions:
  ```sql
  UPDATE employees
  SET session_revoked_at = NULL, session_revoked_for_device = NULL
  WHERE id = $1 AND session_revoked_at IS NOT NULL AND session_revoked_for_device = $2
  RETURNING session_revoked_at
  ```

#### Conflict Check Endpoint (NEW)

**`GET /api/auth/session-conflict`** — Dedicated endpoint for conflict detection.

Query params: `employeeId` (PostgreSQL integer ID)

```json
{
  "hasConflict": true,
  "otherDeviceType": "desktop",
  "otherDeviceOnline": true,
  "shiftBranchName": "Sucursal Centro",
  "shiftStartTime": "2026-03-25T08:00:00Z"
}
```

Logic:
1. Query `activeDeviceSessions` for `employeeId` → determines if another device is online and its type
2. Query `shifts` table for open shift (`is_cash_cut_open = true AND employee_id = X`) → get branch name and start time
3. If an active socket session exists → `hasConflict: true, otherDeviceOnline: true, otherDeviceType: <from Map>`
4. Else if an open shift exists → `hasConflict: true, otherDeviceOnline: false, otherDeviceType: <inferred from shift terminal_id prefix ('mobile-' → 'mobile', else 'desktop')>`
5. If neither → `hasConflict: false`

**Why a separate endpoint instead of embedding in login response:**
- Desktop authenticates locally (SQLite BCrypt), not via `POST /api/auth/desktop-login`. The `desktop-login` endpoint is only used later for JWT refresh token acquisition.
- A dedicated endpoint lets both Desktop and Mobile call it at the right moment in their respective login flows.
- Mobile still gets `activeSessionConflict` in the `mobile-login` response as well (convenience — avoids an extra round-trip since Mobile already calls the backend for auth).

#### Login Response Enhancement (Mobile Only)

`POST /api/auth/mobile-login` gains a new field in the response:

```json
{
  "success": true,
  "token": "...",
  "activeSessionConflict": {
    "hasConflict": true,
    "otherDeviceType": "desktop",
    "otherDeviceOnline": true,
    "shiftBranchName": "Sucursal Centro",
    "shiftStartTime": "2026-03-25T08:00:00Z"
  }
}
```

This reuses the same logic as the `GET /api/auth/session-conflict` endpoint. Desktop does NOT use this — it calls the dedicated endpoint after local auth.

#### Reconciliation with Existing Single-Session Enforcement

The existing `mobileLogin` code has "SINGLE SESSION ENFORCEMENT" that deactivates old device tokens and emits `employee:access_revoked`. This operates at the **device token** level (FCM), not at the session/shift level.

**Strategy:** Keep existing FCM device token deactivation as-is (it's about FCM routing, not session control). Remove the `employee:access_revoked` socket emit from the login flow — the new `force_takeover` mechanism replaces it with a user-confirmed flow instead of an automatic kick.

#### New Socket.IO Event: `force_takeover`

Emitted by the new device after user confirms the takeover dialog. Uses Socket.IO **acknowledgment callback** for reliable response.

```
Client emits: force_takeover({ employeeId }, callback)

Server handler:
1. Look up activeDeviceSessions for employeeId
2. If found (old device online):
   a. Emit force_logout to old device's socketId with { reason: 'session_taken', takenByDevice: socket.clientType }
   b. Remove old entry from activeDeviceSessions
   c. callback({ success: true, wasOnline: true })
3. If NOT found (old device offline):
   a. Determine old device type from open shift's terminal_id prefix
   b. UPDATE employees SET session_revoked_at = NOW(), session_revoked_for_device = <old device type> WHERE id = employeeId
   c. callback({ success: true, wasOnline: false })
4. Register new device in activeDeviceSessions
```

**Timeout:** Client must implement a 10-second timeout. If no acknowledgment received, show error and let user retry.

#### Replacing Existing Mobile-to-Mobile Kick in `identify_client`

The current `identify_client` handler has mobile-specific session kicking:

```javascript
if (data.type === 'mobile' && socket.user?.employeeId && !socket.user?.isMasterLogin) { ... }
```

**This code is replaced** by the new `activeDeviceSessions` mechanism + `force_takeover` event. The old code that automatically kicks duplicate mobile sessions is removed — the new system handles this via user-confirmed takeover at login time, for both mobile-to-mobile and cross-device conflicts.

#### On `identify_client` — Revocation Check

After a device connects and identifies itself:

```
identify_client handler (existing, enhanced):
1. Set socket.clientType, socket.deviceInfo (existing)
2. NEW: Query employees WHERE id = employeeId AND session_revoked_at IS NOT NULL
3. If revoked AND session_revoked_for_device matches socket.clientType:
   a. Emit force_logout to this socket with { reason: 'session_revoked' }
   b. UPDATE employees SET session_revoked_at = NULL, session_revoked_for_device = NULL
      WHERE id = employeeId AND session_revoked_for_device = socket.clientType
      (atomic — only clears if still matches)
   c. Return (don't register in activeDeviceSessions)
4. If not revoked (or device type doesn't match):
   a. Register in activeDeviceSessions (overwrites previous entry for same employeeId)
```

### 2. Desktop (WinUI) — Force Logout Handler + Login Conflict Check

#### SocketIOService.cs — New Event Listener

In `SetupMobileListeners()`, add:

```
socket.On("force_logout", data => {
  // Must dispatch to UI thread for ContentDialog
  OnForceLogoutReceived?.Invoke(data);
});
```

New event: `event Action<ForceLogoutData> OnForceLogoutReceived`

Also add method to emit force_takeover with acknowledgment callback:

```
async Task<ForceLogoutResult> EmitForceTakeoverAsync(int employeeId)
```

#### ShellViewModel.cs — Force Logout Dialog

Subscribe to `OnForceLogoutReceived`:

1. Dispatch to UI thread via `DispatcherQueue.TryEnqueue()`
2. Show non-dismissable `ContentDialog`:
   - Title: "Sesion Tomada"
   - Content: "Tu sesion fue tomada por otro dispositivo. Seras redirigido al login."
   - Primary button: "Aceptar" (only button)
3. On OK:
   - Call `SessionService.EndSession()` (clears in-memory session)
   - Call `CurrentSessionService.ClearSessionAsync()` (clears SQLite)
   - Disconnect Socket.IO
   - Navigate to `LoginPage`

#### LoginViewModel.cs — Conflict Check After Local Auth

Desktop authenticates locally via SQLite BCrypt in `LoginAsync()`. The conflict check happens **after local auth succeeds but before `_sessionService.StartSession()`**:

1. After `_userService.AuthenticateAsync()` returns a valid employee
2. Call `GET /api/auth/session-conflict?employeeId={pgEmployeeId}` (use the employee's RemoteId or resolve via GlobalId)
3. If backend unreachable: skip conflict check (offline-first — allow login, conflict will be handled when connectivity returns)
4. If `hasConflict == true`:
   - Show `ContentDialog` with conflict info
   - If `otherDeviceOnline`:
     > "Tienes una sesion activa en [Movil] en [Sucursal Centro] desde las [08:00]. Deseas tomar el control? El otro dispositivo sera desconectado."
   - If `!otherDeviceOnline`:
     > "Tienes una sesion activa en [Movil] en [Sucursal Centro], pero esta desconectado. Si continuas, cuando se reconecte sera expulsado automaticamente."
   - Buttons: "Tomar Control" / "Cancelar"
5. On "Tomar Control":
   - Connect Socket.IO (needs JWT — acquire via existing `TenantService.AcquireRefreshTokenAsync()`)
   - Emit `force_takeover({ employeeId })` with 10s timeout
   - On success: proceed with `_sessionService.StartSession()` → normal flow
6. On "Cancelar": do NOT call `_sessionService.StartSession()`, return to login screen

### 3. Mobile (Flutter) — Enhanced Login Flow

#### Login ViewModel / simple_login_page.dart

After successful `POST /api/auth/mobile-login`, check `activeSessionConflict` in response:

1. If `hasConflict == true`:
   - Show `AlertDialog` with conflict info
   - If `otherDeviceOnline`:
     > "Tienes una sesion activa en [Desktop] en [Sucursal Centro] desde las [08:00]. Deseas tomar el control? El otro dispositivo sera desconectado."
   - If `!otherDeviceOnline`:
     > "Tienes una sesion activa en [Desktop] en [Sucursal Centro], pero esta desconectado. Si continuas, cuando se reconecte sera expulsado automaticamente."
   - Buttons: "Tomar Control" / "Cancelar"
2. On "Tomar Control":
   - Connect Socket.IO (using JWT from login response)
   - Emit `force_takeover({ employeeId })` with 10s timeout via Socket.IO acknowledgment callback
   - Wait for server acknowledgment
   - Proceed with normal login flow (save session, navigate)
3. On "Cancelar": clear saved JWT, stay on login screen
4. After takeover: `GET /api/shifts/current` returns the inherited shift → set as current shift

#### SocketService — force_logout Already Handled

Mobile already listens to `force_logout` and handles it (clears session, navigates to login). The existing handler in `main.dart` shows a dialog. Enhance it to use the `reason` field for appropriate messaging:
- `reason: 'session_taken'` → "Tu sesion fue tomada por otro dispositivo"
- `reason: 'session_revoked'` → "Tu sesion fue revocada mientras estabas desconectado"

## Data Flow

### Happy Path: Employee moves from Desktop to Mobile

```
1. Employee has open shift on Desktop (connected to Socket.IO)
2. Employee opens Mobile app, enters credentials
3. Mobile → POST /api/auth/mobile-login
4. Backend checks activeDeviceSessions → finds Desktop session
5. Backend checks shifts → finds open shift
6. Backend returns { token, activeSessionConflict: { hasConflict: true, otherDeviceType: 'desktop', otherDeviceOnline: true, ... } }
7. Mobile shows dialog: "Sesion activa en Desktop. Tomar control?"
8. Employee taps "Tomar Control"
9. Mobile connects Socket.IO, emits force_takeover({ employeeId }, callback)
10. Backend sends force_logout to Desktop's socketId
11. Backend removes Desktop from activeDeviceSessions
12. Backend registers Mobile in activeDeviceSessions
13. Backend calls callback({ success: true, wasOnline: true })
14. Desktop receives force_logout → shows dialog → navigates to login
15. Mobile proceeds with login → GET /api/shifts/current → inherits shift
```

### Offline Path: Desktop is offline when Mobile takes over

```
1. Employee has open shift on Desktop (disconnected — no internet)
2. Employee opens Mobile app, enters credentials
3. Mobile → POST /api/auth/mobile-login
4. Backend checks activeDeviceSessions → NOT found (Desktop disconnected)
5. Backend checks shifts → finds open shift
6. Backend infers device type from shift terminal_id (no 'mobile-' prefix → 'desktop')
7. Backend returns { activeSessionConflict: { hasConflict: true, otherDeviceType: 'desktop', otherDeviceOnline: false, ... } }
8. Mobile shows warning dialog: "Sesion activa pero dispositivo desconectado..."
9. Employee taps "Tomar Control"
10. Mobile emits force_takeover({ employeeId }, callback)
11. Backend sets session_revoked_at = NOW(), session_revoked_for_device = 'desktop' on employee record
12. Backend calls callback({ success: true, wasOnline: false })
13. Mobile proceeds with login → inherits shift
14. [Later] Desktop comes back online, Socket.IO reconnects
15. Desktop emits identify_client({ type: 'desktop' })
16. Backend checks session_revoked_at → IS NOT NULL, session_revoked_for_device = 'desktop' matches
17. Backend emits force_logout to Desktop with { reason: 'session_revoked' }
18. Backend atomically clears session_revoked_at and session_revoked_for_device
19. Desktop receives force_logout → shows dialog → navigates to login
```

### Desktop Login Path (Desktop checking against Mobile)

```
1. Employee has open shift on Mobile (connected or disconnected)
2. Employee opens Desktop app, enters credentials
3. Desktop authenticates locally via SQLite BCrypt → success
4. Desktop → GET /api/auth/session-conflict?employeeId={pgId}
5. Backend returns conflict info (same logic as mobile-login enrichment)
6. Desktop shows ContentDialog with conflict info
7. Employee clicks "Tomar Control"
8. Desktop connects Socket.IO (acquires JWT via refresh token)
9. Desktop emits force_takeover({ employeeId }, callback)
10. Backend handles same as above (kicks Mobile or sets revocation flag)
11. Desktop proceeds with _sessionService.StartSession() → normal flow
```

## Edge Cases

### Server Restart
- `activeDeviceSessions` Map is lost — all devices appear "offline"
- Devices reconnect via Socket.IO heartbeat → re-populate the Map via `identify_client`
- `session_revoked_at` + `session_revoked_for_device` in DB survives restart
- On reconnect, only the revoked device type gets kicked (not the takeover device)

### Same Device Re-login
- Employee logs out and logs back in on the same device
- `activeDeviceSessions` was cleared on disconnect → no conflict detected
- If disconnect event was missed (race condition): force_takeover to own socketId is harmless

### No Open Shift (Employee Never Opened One)
- No active socket session AND no open shift → `hasConflict: false` → normal login

### Both Devices Offline
- Neither device is in `activeDeviceSessions`
- Open shift exists in DB → conflict detected with `otherDeviceOnline: false`
- Takeover sets `session_revoked_at` with `session_revoked_for_device` targeting the old device type
- When old device reconnects: type matches → gets kicked
- When new device reconnects: type doesn't match → proceeds normally

### Backend Unreachable During Desktop Login
- Conflict check call fails → skip check, allow login
- Consistent with offline-first philosophy
- Conflict will be resolved when connectivity returns (via Socket.IO `identify_client`)

### Multiple Rapid Takeovers
- Employee takes over from A→B, then immediately B→C
- Each takeover either kicks the previous device (if online) or sets revocation flag (if offline)
- `session_revoked_for_device` is always overwritten with the latest target

## Files to Modify

### Backend (C:\SYA\sya-socketio-server)
- `socket/handlers.js` — activeDeviceSessions Map, identify_client enhancement, force_takeover handler, remove old mobile-to-mobile kick code
- `controllers/auth/loginMethods.js` — activeSessionConflict in mobile-login response, shared conflict detection logic
- `routes/auth.js` — new GET /api/auth/session-conflict endpoint
- `database/migrations.js` — `session_revoked_at` and `session_revoked_for_device` columns on employees (idempotent, using ADD COLUMN IF NOT EXISTS)

### Desktop (C:\Users\saul_\source\repos\SyaTortilleriasWinUi)
- `Services/SocketIOService.cs` — force_logout listener, force_takeover emit method
- `ViewModels/ShellViewModel.cs` — force_logout dialog + navigate to login (UI thread dispatch)
- `ViewModels/LoginViewModel.cs` — conflict check after local auth, takeover dialog

### Mobile (C:\SYA\sya_mobile_app)
- `presentation/views/simple_login_page.dart` or login ViewModel — activeSessionConflict check + takeover dialog
- `infrastructure/socket/socket_service.dart` — emit force_takeover method with acknowledgment callback
- `main.dart` — enhance force_logout handler to use `reason` field for messaging

## Out of Scope
- Multi-shift per employee (one employee = one shift = one device remains the rule)
- Offline sales reconciliation after takeover (handled by existing sync system)
- Admin overriding another employee's session (only self-takeover)
- Master login (`isMasterLogin`) exemption — masters follow same rules
