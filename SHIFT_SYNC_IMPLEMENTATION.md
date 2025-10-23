# 🔄 Shift Synchronization Implementation

## Overview
This document describes the complete shift lifecycle synchronization between Desktop POS, Backend Server, and Mobile App through Socket.IO events, PostgreSQL updates, and Firebase Cloud Messaging (FCM) notifications.

## Architecture Flow

```
Desktop (C#)
    ↓
    │ Opens/Closes Shift (Local SQLite update)
    │ Sends Socket.IO Event
    ↓
Backend (Node.js Socket.IO)
    ↓
    ├─→ Updates PostgreSQL (shift status)
    ├─→ Broadcasts to Desktop/Mobile clients
    └─→ Sends FCM notification to Mobile repartidores
    ↓
Mobile (Flutter)
    ↓
    └─→ Receives notification (foreground or background)
```

## Implementation Details

### 1. Desktop Changes (C# - CashDrawerService.cs)

**File**: `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\Services\CashDrawerService.cs`

#### Changes Made:
- Added `ISocketIOService` dependency injection
- In `CloseSessionAsync()` method (after line 192):
  - Get employee and branch information
  - Create `ShiftEndedMessage` with all session data
  - Call `_socketIOService.SendShiftEndedAsync(shiftEndedMessage)`
  - Wrapped in try-catch to not block shift closing if Socket.IO fails

#### Code Location:
- Line 20: Added `private readonly ISocketIOService _socketIOService;`
- Line 35: Added parameter `ISocketIOService socketIOService` to constructor
- Line 43: Store the service: `_socketIOService = socketIOService;`
- Lines 198-244: Added shift sync logic after `UpdateAsync(shiftToClose)`

#### What It Does:
1. When a cashier closes a shift locally (updates SQLite)
2. Immediately sends a Socket.IO event with complete shift data
3. Desktop sends: ShiftEndedMessage with all financial details
4. If Socket.IO connection fails, shift closing still completes (graceful degradation)

### 2. Backend Changes (Node.js - server.js)

**File**: `C:\SYA\sya-socketio-server\server.js`

#### shift_started Event Handler (Line 2837-2882)
**Previous behavior**: Only broadcasted to clients in branch
**New behavior**:
1. Broadcasts to all clients as before
2. Updates PostgreSQL: `UPDATE shifts SET is_open = true`
3. Calls `notificationHelper.notifyShiftStarted()` to send FCM

#### shift_ended Event Handler (Line 2884-2942)
**Previous behavior**: Only broadcasted to clients in branch
**New behavior**:
1. Broadcasts to all clients as before
2. Updates PostgreSQL: `UPDATE shifts SET is_open = false, end_time = $1`
3. Calls `notificationHelper.notifyShiftEnded()` to send FCM

#### Error Handling:
- Both handlers wrapped in try-catch
- Log success/failure to console
- Broadcast still happens even if DB update fails (graceful degradation)

### 3. Database Synchronization

#### PostgreSQL Shifts Table Updates

**When shift_started event received:**
```sql
UPDATE shifts
SET is_open = true,
    start_time = $1,
    updated_at = NOW()
WHERE id = $2 AND tenant_id = $3
```

**When shift_ended event received:**
```sql
UPDATE shifts
SET is_open = false,
    end_time = $1,
    updated_at = NOW()
WHERE id = $2 AND tenant_id = $3
```

### 4. FCM Notifications

#### notifyShiftStarted
Sends to all repartidores in the branch:
- **Title**: 🟢 Turno Iniciado
- **Body**: `{employeeName} inició turno en {branchName} con ${initialAmount}`
- **Data**: type, employeeName, branchName, initialAmount

#### notifyShiftEnded
Sends to all repartidores in the branch:
- **Title**: 💰/⚠️ Corte de Caja
- **Body**: `{employeeName} finalizó turno en {branchName} - {status}`
  - Status varies based on difference (sobrante/faltante/sin diferencia)
- **Data**: type, employeeName, branchName, difference, status

### 5. Mobile Notification Handling

**File**: `C:\SYA\sya_mobile_app\lib\core\services\fcm_service.dart`

The FCM service streams notifications to the rest of the app:
- `shiftStarted` StreamController for shift start events
- `shiftEnded` StreamController for shift end events

**Notification Reception**:
- **Foreground** (app open): Notification shown in-app via StreamControllers
- **Background** (app closed): Notification shown in system tray via `firebaseMessagingBackgroundHandler`

## Testing Checklist

- [ ] **Desktop**: Verify Socket.IO says "✅ Socket.IO Conectado"
- [ ] **Mobile**: Register device and see "Device Token obtenido" in logs
- [ ] **PostgreSQL**: Verify device_tokens table has entries for mobile devices
- [ ] **Open Shift**: Desktop opens shift → Backend updates PostgreSQL → Mobile gets FCM notification
- [ ] **Close Shift**: Desktop closes shift → Backend updates PostgreSQL → Mobile gets FCM notification
- [ ] **Verify DB**: Query `SELECT * FROM shifts WHERE tenant_id = 1` to confirm is_open changes
- [ ] **Offline Test**: Close Mobile app → Desktop closes shift → Mobile receives notification in system tray

## Key Files Modified

1. **Desktop (C#)**
   - `Services/CashDrawerService.cs` - Added Socket.IO event sending

2. **Backend (Node.js)**
   - `server.js` - Enhanced shift_started and shift_ended handlers
   - `utils/notificationHelper.js` - Already has notifyShiftStarted() and notifyShiftEnded()

3. **Mobile (Flutter)**
   - `lib/core/services/fcm_service.dart` - Already configured for FCM reception
   - `lib/core/services/device_registration_service.dart` - Registers device on login

## Future Enhancements

1. Store shift events in PostgreSQL for audit trail
2. Add retry logic for failed FCM sends
3. Implement shift synchronization for other events (scale alerts, sales, etc.)
4. Add confirmation from mobile that notification was received

## Troubleshooting

### Problem: Shift not updating in PostgreSQL
**Solution**:
1. Check Desktop logs: "Error enviando evento de cierre de turno"
2. Check Backend logs: "[SHIFT] Error sincronizando turno con PostgreSQL"
3. Verify Socket.IO connection is active: Backend logs should show "Socket.IO Conectado"
4. Query: `SELECT is_open FROM shifts WHERE id = X`

### Problem: FCM notifications not arriving
**Solution**:
1. Check device_tokens table has entries: `SELECT COUNT(*) FROM device_tokens WHERE is_active = true`
2. Verify FIREBASE_SERVICE_ACCOUNT is set in Render environment
3. Check Backend logs: "[FCM] Notificación de cierre de turno enviada"
4. Verify mobile has notification permission enabled

### Problem: Backend not receiving shift_ended event
**Solution**:
1. Check Desktop logs: "Socket.IO 📤 Corte de caja enviado"
2. Check if Socket.IO connection is active
3. Verify branchId matches between Desktop and Backend logs
4. Check if there are any TypeErrors in Desktop app compilation

## Monitoring

### Backend Logs to Watch
```
[SHIFT] ✅ Turno #123 actualizado en PostgreSQL
[FCM] 📨 Notificación de cierre de turno enviada a sucursal 1
```

### Desktop Logs to Watch
```
[Socket.IO] 📤 Corte de caja enviado: John Doe - Diferencia: $0.00
[CashDrawerService] Evento de cierre de turno enviado exitosamente
```

### Mobile Logs to Watch
```
[FCM] 📨 Notificación en foreground recibida
   Título: 💰 Corte de Caja
   Cuerpo: John Doe finalizó turno en Sucursal Centro - Sin diferencia
```
