# Shift Mutual Exclusion — System Documentation

## Overview

One employee can only have **one active POS session** across all devices (Desktop, Flutter Mobile, iPad, etc.).
The system uses the shift's `terminal_id` in PostgreSQL as the **single source of truth** to determine which device currently owns a shift.

Each device has a unique UUID:
- **Flutter/Mobile**: `DeviceIdHelper.getTerminalId()` → `mobile-{uuid}` (stored in SharedPreferences)
- **Desktop/WinUI**: `DatabaseService.GetTerminalIdAsync()` → UUID derived from device hardware ID

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          BACKEND (Node.js)                                  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  PostgreSQL: shifts table (SOURCE OF TRUTH)                          │   │
│  │                                                                      │   │
│  │  terminal_id VARCHAR(100)  ← UUID of the device that owns the shift  │   │
│  │  is_cash_cut_open BOOLEAN  ← true = shift is active                  │   │
│  │                                                                      │   │
│  │  Conflict = shift.terminal_id ≠ caller's terminalId                  │   │
│  │  No conflict = same terminal_id OR no open shift                     │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  Socket.IO Events:              HTTP Endpoints:                             │
│  ├─ identify_client             ├─ GET /api/auth/session-conflict           │
│  ├─ force_takeover              │     ?employeeId=X&terminalId=Y            │
│  ├─ force_logout (emitted)      └─ POST /api/auth/mobile-login              │
│  └─ force_takeover_result                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Conflict Detection: `checkSessionConflict(employeeId, pool, callerTerminalId)`

```
  1. Query: SELECT shift WHERE employee_id = X AND is_cash_cut_open = true
     │
     ├─ No rows → return null (no conflict, no open shift)
     │
     ├─ shift.terminal_id == callerTerminalId → return null (this device owns it)
     │
     └─ shift.terminal_id != callerTerminalId → CONFLICT
        return { hasConflict: true, otherDeviceType, shiftBranchName, shiftStartTime }
```

The `otherDeviceType` field (desktop/mobile) is derived from the terminal_id prefix for display purposes only. It does NOT affect conflict detection — any terminal_id mismatch is a conflict, regardless of device type.

---

## Flow 1: Desktop Login (Conflict Check at Login)

Desktop checks for conflicts at **login time** because login = POS access.

```
  Desktop                      Backend                        Other Device
    │                            │                              │
    │  1. BCrypt login (local)   │                              │
    │  ✅ success                │                              │
    │                            │                              │
    │  2. GET /session-conflict  │                              │
    │     ?employeeId=132        │                              │
    │     &terminalId=af33f874.. │                              │
    │  ─────────────────────────>│                              │
    │                            │  Query open shift for emp 132│
    │                            │  Compare terminal_ids        │
    │                            │                              │
    │  <── { hasConflict: true,  │                              │
    │       otherDeviceType:     │                              │
    │       "mobile",            │                              │
    │       shiftBranchName:     │                              │
    │       "SYA Principal" }    │                              │
    │                            │                              │
    │  3. Show Dialog:           │                              │
    │  ┌─────────────────────┐   │                              │
    │  │ Sesión Activa en    │   │                              │
    │  │ Otro Dispositivo    │   │                              │
    │  │                     │   │                              │
    │  │ [Tomar Control]     │   │                              │
    │  │ [Modo Supervisor]   │   │                              │
    │  │ [Cancelar]          │   │                              │
    │  └─────────────────────┘   │                              │
```

### Desktop Dialog Options:

| Option | Behavior |
|--------|----------|
| **Tomar Control** | Connect Socket.IO → emit `force_takeover` with `terminalId` → enter POS |
| **Modo Supervisor** | Navigate to ShellPage (view-only, no shift loaded) |
| **Cancelar** | Stay on login screen |

---

## Flow 2: Flutter POS Entry (Conflict Check at POS Entry)

Flutter login **always succeeds** — no conflict check at login.
Conflict is checked when the user enters the POS screen.

```
  Flutter                      Backend                        Other Device
    │                            │                              │
    │  Login ✅                  │                              │
    │  Navigate to Dashboard     │                              │
    │                            │                              │
    │  User taps "Punto de Venta"│                              │
    │                            │                              │
    │  POSViewModel.initialize() │                              │
    │  ├─ Load terminalId        │                              │
    │  ├─ _loadEmployeeInfo()    │                              │
    │  ├─ _checkCurrentShift()   │                              │
    │  │                         │                              │
    │  ├─ _checkSessionConflict()│                              │
    │  │   GET /session-conflict │                              │
    │  │   ?employeeId=132       │                              │
    │  │   &terminalId=0e93c226..│                              │
    │  │  ──────────────────────>│  Compare shift.terminal_id   │
    │  │                         │  with caller's terminalId    │
    │  │  <── { hasConflict }    │                              │
    │  │                         │                              │
    │  └─> state = sessionConflict (if conflict)                │
    │      state = ready (if no conflict)                       │
```

### No Conflict Cases (goes straight to POS):

```
  _checkSessionConflict() returns null when:

  ├─ No open shift for this employee (is_cash_cut_open = true)
  │
  └─ Open shift exists AND shift.terminal_id == caller's terminalId
     (this device already owns the shift)
```

---

## Flow 3: Force Takeover

When a device takes over, the backend:
1. **Iterates ALL connected sockets** for the same employee and kicks them
2. **Updates the shift's `terminal_id`** to the caller's device
3. **Clears any stale revocation flags** in the DB

```
  Requesting Device             Backend                    Other Devices
  (e.g. Flutter)                                           (Desktop, iPad, etc.)
    │                            │                              │
    │  emit('force_takeover', {  │                              │
    │    employeeId: 132,        │                              │
    │    terminalId: '0e93c2..'  │                              │
    │  })                        │                              │
    │  ─────────────────────────>│                              │
    │                            │                              │
    │                            │  for (socket of io.sockets)  │
    │                            │    if same employeeId         │
    │                            │    AND different socketId     │
    │                            │                              │
    │                            │  emit('force_logout', {      │
    │                            │    reason: 'session_taken',  │
    │                            │    takenByDevice: 'mobile'   │
    │                            │  }) ────────────────────────>│ kicked
    │                            │      (to ALL other sockets)  │
    │                            │                              │
    │                            │  UPDATE shifts               │
    │                            │  SET terminal_id = '0e93c2..'│
    │                            │  WHERE employee_id = 132     │
    │                            │  AND is_cash_cut_open = true  │
    │                            │                              │
    │                            │  Clear stale revocation flags │
    │                            │                              │
    │  <── force_takeover_result │                              │
    │      { success: true,      │                              │
    │        wasOnline: true }   │                              │
    │                            │                              │
    │  _skipConflictCheck = true │                              │
    │  re-initialize() ──> POS   │                              │
```

**Key design decisions:**
- Iterates ALL sockets (not a Map lookup) → works with any number of devices
- Updates `terminal_id` on the shift → next conflict check recognizes the new owner
- Does NOT set DB revocation flags → avoids stale flag problems on reconnect
- Offline devices discover the conflict via `checkSessionConflict` when they re-enter POS

---

## Flow 4: force_logout Behavior Per Device

### Desktop receives force_logout:

```
  ┌──────────────────────────────────────────────┐
  │  ShellViewModel.OnForceLogoutReceived()       │
  │                                               │
  │  1. Show ContentDialog: "Sesión Tomada"       │
  │  2. _sessionService.EndSession()              │
  │  3. Navigate to LoginPage                     │
  │                                               │
  │  (Always full logout — Desktop login = POS)   │
  │  On next login, checkSessionConflict runs     │
  │  again and user can choose what to do.        │
  └──────────────────────────────────────────────┘
```

### Flutter receives force_logout:

```
  ┌──────────────────────────────────────────────────────────┐
  │  reason == 'session_taken'                                │
  │  ┌────────────────────────────────────────────────────┐   │
  │  │  1. Show dialog: "Desktop tomó el control del POS" │   │
  │  │  2. popUntil(first route) → back to Dashboard      │   │
  │  │  3. Stay logged in, keep socket connected           │   │
  │  │                                                     │   │
  │  │  User can still use Dashboard, Guardian, etc.       │   │
  │  │  Re-entering POS will trigger conflict check again. │   │
  │  └────────────────────────────────────────────────────┘   │
  │                                                           │
  │  reason == 'session_revoked'                              │
  │  ┌────────────────────────────────────────────────────┐   │
  │  │  1. Disconnect socket                               │   │
  │  │  2. Show dialog: "Sesión Expirada"                  │   │
  │  │  3. authService.logout()                            │   │
  │  │  4. Navigate to AuthGate (login screen)             │   │
  │  │                                                     │   │
  │  │  (Reserved for admin-initiated session revocations)  │   │
  │  └────────────────────────────────────────────────────┘   │
  └──────────────────────────────────────────────────────────┘
```

---

## Flow 5: Opening a New Shift

When no shift exists, the user opens one. The new shift gets the device's `terminal_id`.

```
  Flutter                      Backend
    │                            │
    │  POSViewModel.initialize() │
    │  ├─ _checkCurrentShift()   │
    │  │   └─ shift = null       │
    │  └─> state = noShift       │
    │                            │
    │  Show "Abrir Turno" screen │
    │  User enters initial amount│
    │  User taps "Abrir Turno"   │
    │                            │
    │  openShift()               │
    │  ├─ _checkSessionConflict()│──> checks for existing shift
    │  │   └─ conflict? ─── NO ──│──> proceed
    │  │                    YES ─│──> show conflict screen
    │  │                         │
    │  ├─ POST /api/shifts/open  │
    │  │  ─────────────────────>│  Create shift in DB
    │  │                         │  terminal_id = auto-generated
    │  │  <── shift data         │
    │  └─> state = ready → POS   │
```

Desktop creates shifts locally (SQLite) and syncs via `POST /api/shifts/sync`. The `TerminalId` is set by `PrepareShiftForInsertAsync()` before sync.

---

## State Machine: POSViewModel (Flutter)

```
  ┌─────────┐
  │ loading  │───────────────────────────────────────────────┐
  └────┬─────┘                                               │
       │ initialize()                                        │
       │ _terminalId = DeviceIdHelper.getTerminalId()        │
       ▼                                                     │
  ┌──────────┐    shift exists     ┌──────────────────┐      │
  │ noShift  │◄── no shift ──────  │ _checkCurrentShift│      │
  └────┬─────┘                     └────────┬─────────┘      │
       │                                    │ shift exists    │
       │ openShift()                        ▼                 │
       │                           ┌──────────────────────┐   │
       │                           │ _checkSessionConflict│   │
       │                           │ (passes terminalId)  │   │
       │                           └────────┬─────────────┘   │
       │                                    │                 │
       │                        ┌───────────┴──────────┐      │
       │                        │                      │      │
       │                    conflict              no conflict  │
       │                        │                      │      │
       │                        ▼                      ▼      │
       │               ┌────────────────┐      ┌───────────┐  │
       │               │sessionConflict │      │   ready    │  │
       │               └───────┬────────┘      └───────────┘  │
       │                       │                              │
       │              forceTakeover(terminalId)               │
       │                       │                              │
       │              _skipConflictCheck=true                  │
       │                       │                              │
       │                 re-initialize()                      │
       │                       │                              │
       └───────────────────────┴──────────────────────────────┘
                                                   │
                                              ┌────┴────┐
                                              │  error   │
                                              └──────────┘
```

---

## Key Files

| Component | File | Purpose |
|-----------|------|---------|
| **Backend** | `controllers/auth/loginMethods.js` | `checkSessionConflict(empId, pool, callerTerminalId)` — source of truth logic |
| **Backend** | `routes/auth.js` | `GET /session-conflict?employeeId=X&terminalId=Y` endpoint |
| **Backend** | `socket/handlers.js` | `identify_client`, `force_takeover` (socket iteration + shift update), `disconnect` |
| **Flutter** | `core/utils/device_id_helper.dart` | `getTerminalId()` → unique `mobile-{uuid}` per device |
| **Flutter** | `features/pos/viewmodels/pos_view_model.dart` | Conflict check + force takeover logic |
| **Flutter** | `features/pos/pages/pos_entry_page.dart` | Conflict UI screen |
| **Flutter** | `main.dart` | `force_logout` handler (`session_taken` → exit POS, `session_revoked` → full logout) |
| **Flutter** | `infrastructure/socket/socket_service.dart` | `emitForceTakeover(employeeId, terminalId:)` |
| **Desktop** | `ViewModels/LoginViewModel.cs` | `CheckSessionConflictAsync` (passes terminalId), `HandleSessionConflictAsync` |
| **Desktop** | `ViewModels/ShellViewModel.cs` | `OnForceLogoutReceived` handler |
| **Desktop** | `Services/SocketIOService.cs` | `EmitForceTakeoverAsync(employeeId, terminalId)` |
| **Desktop** | `Services/DatabaseService.cs` | `GetTerminalIdAsync()` → UUID from device hardware ID |
| **Desktop** | `Services/ShiftService.cs` | `CreateShiftAsync` → calls `PrepareShiftForInsertAsync` to set TerminalId |

---

## Design Decisions

### Why terminal_id instead of device type (desktop/mobile)?
Multiple devices of the same type (e.g., two iPads, Flutter Windows + iPad) would be invisible to each other with binary device type tracking. Unique terminal_ids solve this — every device is uniquely identified.

### Why iterate all sockets instead of a Map lookup?
- The Map uses composite keys (`{empId}_{deviceType}`) which has the same binary type problem
- Socket iteration finds ALL devices for an employee regardless of type
- No Map state to get stale or lost on server restart

### Why no DB revocation flags on force_takeover?
- Online devices are kicked immediately via socket iteration
- Offline devices discover the conflict via `checkSessionConflict` when they re-enter POS
- DB flags caused stale revocation problems: devices getting kicked on reconnect long after the takeover was resolved

### Why does Flutter check at POS entry and Desktop checks at login?
- Flutter can use the Dashboard, Guardian, and other features without a POS shift — login should always succeed
- Desktop login IS POS access — the entire app revolves around the POS, so checking at login is appropriate
