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

## Architecture

Three components: Backend orchestration, Desktop handler, Mobile enhanced login.

### 1. Backend — Session Registry + Force-Logout Orchestration

#### In-Memory Session Registry

`activeDeviceSessions`: `Map<employeeId, {socketId, clientType, branchId, connectedAt}>`

- **Populated** on `identify_client` Socket.IO event (after JWT auth)
- **Removed** on `disconnect` event
- **Queried** during login to answer: "is the other device online right now?"

```
// Lifecycle:
identify_client({type: 'mobile'})
  → activeDeviceSessions.set(employeeId, {socketId, clientType: 'mobile', branchId, connectedAt: Date.now()})

disconnect
  → activeDeviceSessions.delete(employeeId)  // only if socketId matches
```

#### Database: Employee Session Revocation Flag

New column on `employees` table:

```sql
ALTER TABLE employees ADD COLUMN session_revoked_at TIMESTAMPTZ DEFAULT NULL;
```

- Set to `NOW()` when force-takeover is executed and old device is **offline**
- Checked on `identify_client` — if set, emit `force_logout` and clear the flag
- Lightweight: no new table, just one nullable timestamp column

#### Login Response Enhancement

Both `POST /api/auth/mobile-login` and `POST /api/auth/desktop-login` gain a new field in the response:

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

Logic:
1. Query `activeDeviceSessions` for `employeeId` → determines if other device is online and its type
2. Query `shifts` table for open shift (`is_cash_cut_open = true AND employee_id = X`) → get branch name and start time
3. If either an active socket session OR an open shift exists (from a different context than the current login) → `hasConflict: true`
4. If no conflict → `activeSessionConflict: null` or omitted

**Important:** The JWT is still returned even if there's a conflict. The client decides whether to proceed (force-takeover) or cancel. The JWT is needed for the Socket.IO connection to emit `force_takeover`.

#### New Socket.IO Event: `force_takeover`

Emitted by the new device after user confirms the takeover dialog.

```
Client emits: force_takeover({ employeeId })

Server handler:
1. Look up activeDeviceSessions for employeeId
2. If found (old device online):
   a. Emit force_logout to old device's socketId with { reason: 'session_taken', takenByDevice: 'mobile' }
   b. Remove old entry from activeDeviceSessions
   c. Respond: { success: true, wasOnline: true }
3. If NOT found (old device offline):
   a. UPDATE employees SET session_revoked_at = NOW() WHERE id = employeeId
   b. Respond: { success: true, wasOnline: false }
4. Register new device in activeDeviceSessions
```

#### On `identify_client` — Revocation Check

After a device connects and identifies itself:

```
identify_client handler (existing, enhanced):
1. Set socket.clientType, socket.deviceInfo (existing)
2. NEW: Query employees WHERE id = employeeId AND session_revoked_at IS NOT NULL
3. If revoked:
   a. Emit force_logout to this socket with { reason: 'session_revoked' }
   b. UPDATE employees SET session_revoked_at = NULL WHERE id = employeeId
   c. Return (don't register in activeDeviceSessions)
4. If not revoked:
   a. Register in activeDeviceSessions (existing behavior enhanced)
```

### 2. Desktop (WinUI) — Force Logout Handler

#### SocketIOService.cs — New Event Listener

In `SetupMobileListeners()`, add:

```
socket.On("force_logout", data => {
  // Fire event for ViewModel layer
  OnForceLogoutReceived?.Invoke(data);
});
```

New event: `event Action<ForceLogoutData> OnForceLogoutReceived`

#### ShellViewModel.cs (or App.xaml.cs) — Force Logout Dialog

Subscribe to `OnForceLogoutReceived`:

1. Show non-dismissable `ContentDialog`:
   - Title: "Sesión Tomada"
   - Content: "Tu sesión fue tomada por otro dispositivo. Serás redirigido al login."
   - Primary button: "Aceptar" (only button)
2. On OK:
   - Call `SessionService.EndSession()` (clears in-memory session)
   - Call `CurrentSessionService.ClearSessionAsync()` (clears SQLite)
   - Disconnect Socket.IO
   - Navigate to `LoginPage`

#### OpenShiftViewModel.cs — Login Conflict Check

In `desktop-login` response handling, check `activeSessionConflict`:

1. If `hasConflict == true`:
   - Show `ContentDialog` with conflict info
   - If `otherDeviceOnline`:
     > "Tienes una sesión activa en [Móvil] en [Sucursal Centro] desde las [08:00]. ¿Deseas tomar el control? El otro dispositivo será desconectado."
   - If `!otherDeviceOnline`:
     > "Tienes una sesión activa en [Móvil] en [Sucursal Centro], pero está desconectado. Si continúas, cuando se reconecte será expulsado automáticamente."
   - Buttons: "Tomar Control" / "Cancelar"
2. On "Tomar Control": emit `force_takeover` via Socket.IO → proceed with login
3. On "Cancelar": stay on login screen (discard JWT)
4. After takeover: inherit shift via existing `CheckActiveShiftAsync` flow

### 3. Mobile (Flutter) — Enhanced Login Flow

#### Login ViewModel / simple_login_page.dart

After successful `POST /api/auth/mobile-login`, check `activeSessionConflict` in response:

1. If `hasConflict == true`:
   - Show `AlertDialog` with conflict info
   - If `otherDeviceOnline`:
     > "Tienes una sesión activa en [Desktop] en [Sucursal Centro] desde las [08:00]. ¿Deseas tomar el control? El otro dispositivo será desconectado."
   - If `!otherDeviceOnline`:
     > "Tienes una sesión activa en [Desktop] en [Sucursal Centro], pero está desconectado. Si continúas, cuando se reconecte será expulsado automáticamente."
   - Buttons: "Tomar Control" / "Cancelar"
2. On "Tomar Control":
   - Connect Socket.IO (using JWT from login response)
   - Emit `force_takeover({ employeeId })`
   - Wait for server acknowledgment
   - Proceed with normal login flow
3. On "Cancelar": clear saved JWT, stay on login screen
4. After takeover: `GET /api/shifts/current` returns the inherited shift → set as current shift

#### SocketService — force_logout Already Handled

Mobile already listens to `force_logout` and handles it (clears session, navigates to login). The existing `force_logout` handler in `main.dart` shows a dialog: "Logged in elsewhere". No changes needed here — just ensure the `reason` field is used to show appropriate message.

## Data Flow

### Happy Path: Employee moves from Desktop to Mobile

```
1. Employee has open shift on Desktop (connected to Socket.IO)
2. Employee opens Mobile app, enters credentials
3. Mobile → POST /api/auth/mobile-login
4. Backend checks activeDeviceSessions → finds Desktop session
5. Backend checks shifts → finds open shift
6. Backend returns { token, activeSessionConflict: { hasConflict: true, otherDeviceType: 'desktop', otherDeviceOnline: true, ... } }
7. Mobile shows dialog: "Sesión activa en Desktop. ¿Tomar control?"
8. Employee taps "Tomar Control"
9. Mobile connects Socket.IO, emits force_takeover({ employeeId })
10. Backend sends force_logout to Desktop's socketId
11. Backend removes Desktop from activeDeviceSessions
12. Backend registers Mobile in activeDeviceSessions
13. Backend responds { success: true, wasOnline: true }
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
6. Backend returns { activeSessionConflict: { hasConflict: true, otherDeviceType: 'unknown', otherDeviceOnline: false, ... } }
7. Mobile shows warning dialog: "Sesión activa pero dispositivo desconectado..."
8. Employee taps "Tomar Control"
9. Mobile emits force_takeover({ employeeId })
10. Backend sets session_revoked_at = NOW() on employee record
11. Backend responds { success: true, wasOnline: false }
12. Mobile proceeds with login → inherits shift
13. [Later] Desktop comes back online, Socket.IO reconnects
14. Desktop emits identify_client
15. Backend checks session_revoked_at → IS NOT NULL
16. Backend emits force_logout to Desktop
17. Backend clears session_revoked_at
18. Desktop receives force_logout → shows dialog → navigates to login
```

## Edge Cases

### Server Restart
- `activeDeviceSessions` Map is lost — all devices appear "offline"
- Devices reconnect via Socket.IO heartbeat → re-populate the Map via `identify_client`
- `session_revoked_at` in DB survives restart — offline revocations still work

### Same Device Re-login
- Employee logs out and logs back in on the same device
- `activeDeviceSessions` was cleared on disconnect → no conflict detected
- If disconnect event was missed (race condition): force_takeover to own socketId is harmless

### No Open Shift (Employee Never Opened One)
- `activeSessionConflict.hasConflict` based on active socket session OR open shift
- If neither exists → no conflict → normal login flow

### Both Devices Offline
- Neither device is in `activeDeviceSessions`
- Open shift exists in DB → conflict detected with `otherDeviceOnline: false`
- Takeover sets `session_revoked_at` → whichever device reconnects first gets kicked

## Files to Modify

### Backend (C:\SYA\sya-socketio-server)
- `socket/handlers.js` — activeDeviceSessions Map, identify_client enhancement, force_takeover handler
- `controllers/auth/loginMethods.js` — activeSessionConflict in login responses
- `database/migrations.js` or new migration — `session_revoked_at` column on employees

### Desktop (C:\Users\saul_\source\repos\SyaTortilleriasWinUi)
- `Services/SocketIOService.cs` — force_logout listener
- `ViewModels/ShellViewModel.cs` — force_logout dialog + navigate to login
- `ViewModels/LoginViewModel.cs` — activeSessionConflict check + takeover dialog

### Mobile (C:\SYA\sya_mobile_app)
- `presentation/views/simple_login_page.dart` or login ViewModel — activeSessionConflict check + takeover dialog
- `infrastructure/socket/socket_service.dart` — emit force_takeover method

## Out of Scope
- Multi-shift per employee (one employee = one shift = one device remains the rule)
- Offline sales reconciliation after takeover (handled by existing sync system)
- Admin overriding another employee's session (only self-takeover)
