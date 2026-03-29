# Arquitectura Multi-Caja

> **Last updated:** 2026-03-29

---

## Resumen

Multi-caja es un modo por sucursal que cambia la arquitectura de Desktop de **local-first** (SQLite → PG sync) a **server-first** (PG primero → SQLite cache). Garantiza exclusión mutua de turnos: un empleado solo puede tener un turno activo en un dispositivo a la vez.

```
                          multi_caja = false (default)
Desktop (SQLite) ──local-first──→ Backend (PostgreSQL) ←──API directa── Mobile (Flutter)
                          ↑ push/pull sync cada 5 min

                          multi_caja = true
Desktop (SQLite cache) ──server-first──→ Backend (PostgreSQL) ←──API directa── Mobile (Flutter)
                          ↑ PG primero, SQLite como WAL fallback offline
```

---

## Configuración por Sucursal

### Toggle: `multi_caja_enabled`

- Columna `branches.multi_caja_enabled BOOLEAN DEFAULT false`
- Endpoints: `GET/PUT /api/branches/:id/settings`
- **Guard de desactivación:** No se puede desactivar si hay turnos abiertos en la sucursal

### Matriz de Comportamiento

| Operación | `multi_caja=false` | `multi_caja=true` |
|-----------|-------------------|-------------------|
| Abrir turno (Desktop) | Local + sync | **Server-required** (POST /api/shifts/open) |
| Abrir turno (Mobile) | Server-required | Server-required (sin cambio) |
| Ventas offline | SQLite queue + flush | SQLite queue + flush (sin cambio) |
| Ventas online (Desktop) | Local + Task.Run sync | **PG primero (await), SQLite cache** |
| Depósitos/Retiros (Desktop) | Local + Task.Run sync | **PG primero (await), SQLite cache** |
| Cerrar turno | Desktop: local + sync. Mobile: server | **Requiere internet (bloquea sin conexión)** |

---

## Flujo de Apertura de Turno (Server-First)

```
Empleado toca "Abrir Turno"
  │
  ├─ Verificar multi_caja_enabled para la sucursal
  │   ├─ false → Comportamiento actual (Desktop local-first, Mobile server-first)
  │   └─ true → Continúa abajo
  │
  ├─ ¿Tiene internet?
  │   └─ NO → Bloquear: "Se requiere conexión a internet para abrir turno en modo multi-caja"
  │
  ├─ POST /api/shifts/open { initialAmount, terminalId }
  │   (Una sola llamada atómica con BEGIN/FOR UPDATE/COMMIT)
  │
  ├─ HTTP 201 → Turno creado exitosamente
  │   → Guardar copia en SQLite local (solo cache)
  │   → Iniciar heartbeat (30s)
  │   → Navegar a ventas
  │
  ├─ HTTP 409 + isSameDevice: true → Auto-recuperación
  │   → Crear/actualizar entrada local desde datos del servidor
  │   → Reanudar turno (mismo shift_id)
  │   → Cubre: restauración de DB, reinstalación, cache limpio
  │
  └─ HTTP 409 + isSameDevice: false → Diálogo de conflicto
      "Turno abierto en [deviceType] desde [startTime] en [branchName]"
      │
      ├─ [Tomar Control] → emit('force_takeover')
      │   → Servidor notifica/marca al otro dispositivo
      │   → Reintentar POST /api/shifts/open
      │
      └─ [Cancelar] → Regresar
```

### Terminal ID

Cada dispositivo persiste su `terminal_id` para identificarse:
- **Mobile:** `mobile-{uuid}` en SharedPreferences
- **Desktop:** Hardware UUID via `DatabaseService.GetTerminalIdAsync()`

---

## Cierre de Turno — Internet Obligatorio

En modo multi-caja, **cerrar turno requiere internet**. Si Desktop cierra sin internet, el backend sigue creyendo que el turno está abierto. Cuando otro dispositivo intenta abrir turno, recupera el "turno fantasma" y trabaja sobre él — hasta que Desktop reconecta y sincroniza el cierre, invalidando la sesión del otro dispositivo.

### Guard de Internet (Desktop)

```
Empleado toca "Cerrar Turno" / "Corte de Caja"
  │
  ├─ multi_caja = false → Cerrar normalmente (offline-first, sync después)
  │
  └─ multi_caja = true → ¿Hay internet?
      ├─ SÍ → Cerrar normalmente + sync inmediato
      └─ NO → BLOQUEAR: "Se requiere internet para cerrar turno en modo multi-caja"
```

### Puntos de Cierre Protegidos (Desktop)

| Punto de cierre | Archivo | Mecanismo |
|---|---|---|
| Cajero desde CashDrawer | `CashDrawerViewModel.CloseShift()` | `ShowWarningAsync` dialog |
| Repartidor desde Liquidación | `LiquidacionViewModel.ConfirmarLiquidacionAsync()` | Omite cierre, liquidación sí se completa |
| Repartidor desde CerrarTurno | `LiquidacionViewModel.CerrarTurno()` | Log + return |
| Cierre rápido desde Shell | `ShellPage.CloseMyShift_Click()` | `ShowMessageDialogAsync` dialog |

### Safety Net: Stale Shift Detection

Si a pesar del guard de internet un turno queda huérfano en el backend (por ejemplo, Desktop perdió internet después de iniciar el cierre), el backend tiene una protección adicional:

```
Empleado abre turno desde Device B
  │
  POST /api/shifts/open
  │
  Backend: turno abierto existe para este empleado
  ├─ last_heartbeat < 8 horas → 409 SHIFT_CONFLICT (comportamiento normal)
  └─ last_heartbeat ≥ 8 horas Y diferente dispositivo → AUTO-CIERRE
      → Cierra turno stale automáticamente
      → Abre turno nuevo para Device B
      → Log: "STALE SHIFT DETECTED: ID X, last activity Yh ago"
```

**Umbral:** 8 horas sin heartbeat. Configurable en `routes/shifts.js` (constante `STALE_HOURS`).

**Idempotencia:** Si Desktop sincroniza el cierre después del auto-cierre, el endpoint `POST /api/shifts/sync/close` retorna `"Turno ya estaba cerrado (idempotente)"`.

---

## Terminal Naming (Nombres de Terminal)

Cada dispositivo se registra automáticamente en `branch_devices` al abrir turno, con un nombre legible ("Caja 1", "Caja 2", etc.).

### Auto-Registro

```
Shift Open → POST /api/shifts/open (backend)
  │
  Después de crear shift (post-COMMIT):
  │
  ├─ ¿Device ya registrado en branch_devices?
  │   └─ SÍ → Update last_seen_at, reactivar si inactive
  │
  └─ NO → INSERT con nombre auto-generado
      → Cuenta dispositivos activos + 1 → "Caja N"
      → Retry si nombre colisiona (max 5 intentos)
      → ON CONFLICT por (device_id, branch_id, tenant_id)
```

### Gestión de Terminales

**Endpoints:**

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/devices/branch/:branchId` | Listar terminales (filtro `?include_inactive=true`) |
| PATCH | `/api/devices/:id` | Renombrar (`device_name`) o des/activar (`is_active`) |
| POST | `/api/devices/register` | Registrar manualmente (usado por Desktop claim-primary) |

**Permisos:** Solo Owner (`is_owner=true`) o Administrador (`role_id=1`) pueden renombrar/desactivar.

**Guards:**
- No se puede desactivar terminal con turno abierto
- Nombre único por sucursal entre terminales activas (índice `uq_branch_devices_name_active`)

**Socket.IO:** `terminal:updated` emitido a `branch_{branchId}` al renombrar/desactivar.

### Schema

```sql
-- branch_devices (creada en migration 013, extendida en 038)
device_id       VARCHAR     -- UUID del dispositivo
device_name     VARCHAR     -- "Caja 1", "Mi Tablet", etc.
device_type     VARCHAR     -- "desktop" | "mobile"
is_primary      BOOLEAN     -- Equipo Principal
is_active       BOOLEAN     -- Soft delete (DEFAULT TRUE)

-- Índices
idx_branch_devices_unique       UNIQUE (device_id, branch_id, tenant_id)
uq_branch_devices_name_active   UNIQUE (branch_id, tenant_id, device_name) WHERE is_active AND device_name IS NOT NULL
```

### Cache de Nombres

Los nombres se cachean en el cliente para uso offline (tickets, dashboard):

- **Desktop:** `BackendSyncService._terminalNameCache` (Dictionary estático) + `CurrentSession.TerminalNameCache` (SQLite JSON)
- **Mobile:** `TerminalApiService._nameCache` (Map estático) + SharedPreferences
- **Fallback:** Si no hay cache, muestra primeros 4 chars del UUID en mayúsculas

### UI de Gestión

- **Desktop:** `Settings > Dispositivos > Gestionar Terminales` → `TerminalManagementPage`
- **Mobile:** `Settings > Terminales` → `TerminalManagementPage`
- Ambos permiten renombrar y des/activar (solo Owner/Admin)

---

## Heartbeat

### Propósito

Determinar si un dispositivo está online u offline cuando otro solicita force-takeover. También usado para stale shift detection (umbral 8h).

### Implementación

| Componente | Detalle |
|------------|---------|
| Intervalo | 30 segundos |
| Evento | `shift_heartbeat` → `{ employeeId, shiftId, terminalId }` |
| Almacenamiento | `shifts.last_heartbeat` (PostgreSQL, TIMESTAMPTZ) |
| Umbral offline | ≥ 90 segundos sin heartbeat |
| Índice | `idx_shifts_active_heartbeat` en `(employee_id, is_cash_cut_open) WHERE is_cash_cut_open = true` |

### Ciclo de Vida

```
Turno abierto → StartHeartbeat (timer 30s) → emite shift_heartbeat
Turno cerrado → StopHeartbeat
App en background (mobile) → heartbeat se detiene (OS suspende), se reanuda al volver
```

### Desktop (C#)

```csharp
// SocketIOService.cs
StartShiftHeartbeat(int employeeId, int shiftId, string terminalId)  // Inicia timer 30s
StopShiftHeartbeat()                                                   // Detiene timer
SendShiftHeartbeatAsync(...)                                           // Emite al servidor
```

### Mobile (Dart)

```dart
// pos_view_model.dart
_startHeartbeat()   // Timer.periodic(30s) → SocketService().emitShiftHeartbeat()
_stopHeartbeat()    // Cancela timer
```

---

## Force Takeover (Tomar Control)

### Dispositivo objetivo ONLINE (heartbeat < 90s)

```
Device B → emit('force_takeover', { employeeId, terminalId })
  │
  Server (dentro de transacción FOR UPDATE):
  │  1. Actualizar shift.terminal_id = Device B
  │  2. Limpiar session_revoked_at
  │  3. COMMIT
  │  4. Enviar session_revoked_pending_flush a Device A
  │
  Device A recibe session_revoked_pending_flush:
  │  1. Flush datos pendientes (ventas, depósitos, retiros)
  │  2. Emitir flush_complete
  │
  Server recibe flush_complete:
  │  1. Limpiar flags de revocación
  │  2. Enviar force_logout a Device A
  │
  Device A recibe force_logout:
  │  1. Mostrar notificación: "Tu sesión fue tomada por otro dispositivo"
  │  2. Navegar a login/inicio
  │  3. Limpiar cache local de turno
  │
  Server → emit('force_takeover_result', { success: true }) a Device B
```

### Dispositivo objetivo OFFLINE (heartbeat ≥ 90s)

```
Device B → emit('force_takeover', { employeeId, terminalId })
  │
  Server:
  │  1. SET session_revoked_at = NOW()
  │  2. SET session_revoked_for_device = 'mobile' | 'desktop'
  │  3. Actualizar shift.terminal_id = Device B
  │  4. COMMIT
  │
  Device B recibe force_takeover_result { success: true, wasOnline: false }
  Device B hereda turno existente (mismo shift_id)
  │
  Cuando Device A reconecta:
  │  1. identify_client detecta session_revoked_at
  │  2. Servidor envía session_revoked_pending_flush
  │  3. Device A flush datos pendientes
  │  4. Device A emite flush_complete
  │  5. Servidor envía force_logout → Device A navega a login
  │
  CERO pérdida de datos
```

---

## Protocolo Flush-Before-Logout

### Eventos Socket.IO

| Evento | Dirección | Datos | Propósito |
|--------|-----------|-------|-----------|
| `session_revoked_pending_flush` | Server → Client | `{ reason, shiftId }` | Avisa al cliente que flush antes de logout |
| `flush_complete` | Client → Server | `{ employeeId }` | Cliente terminó de enviar datos |
| `force_logout` | Server → Client | `{}` | Finaliza la sesión |

### Flujo

```
Server detecta que necesita revocar sesión
  → Envía session_revoked_pending_flush
  → Cliente recibe, flush datos pendientes al servidor
  → Cliente emite flush_complete
  → Server limpia flags, envía force_logout
  → Cliente muestra notificación y navega a login
```

Si el cliente nunca envía `flush_complete` (crash/desconexión), el próximo reconect reinicia este flujo. Los datos quedan en la cola local.

---

## Flujo Server-First de Desktop (multi_caja=true)

### Ventas

```
VentasViewModel.FinalizePaymentAndPrintAsync()
  │
  ├─ MultiCajaEnabled = true:
  │   await SyncVentaAsync(venta)  ← foreground, espera confirmación de PG
  │   Si falla: venta queda en SQLite con Synced=false
  │            AutoSyncService la reintenta después
  │
  └─ MultiCajaEnabled = false:
      Task.Run(() => SyncVentaAsync(venta))  ← background, fire-and-forget
```

### Depósitos / Retiros

Mismo patrón: `await` cuando multi-caja, `Task.Run` cuando legacy.

### BackendSyncService — Métodos Server-First

```csharp
// Todos usan JWT via CreateAuthenticatedRequest()
FetchBranchSettingsAsync(int branchId)          → GET /api/branches/{id}/settings
OpenShiftOnServerAsync(decimal amount, string terminalId) → POST /api/shifts/open
CreateSaleServerFirstAsync(object payload)      → POST /api/ventas
CreateDepositServerFirstAsync(object payload)   → POST /api/deposits
CreateWithdrawalServerFirstAsync(object payload) → POST /api/withdrawals
```

---

## Auto-Recuperación

Cuando un dispositivo pierde su cache local (restauración de backup, reinstalación, etc.):

1. Intenta abrir turno → POST /api/shifts/open
2. Recibe 409 con `isSameDevice: true` (mismo terminal_id)
3. Crea entrada local desde `activeShift` del response
4. Reanuda el turno existente sin crear uno nuevo

Implementado en:
- **Mobile:** `PosViewModel.openShift()` — catch `ShiftConflictException`
- **Desktop:** `OpenShiftViewModel.StartShiftServerFirstAsync()` — check `result.IsConflict`

---

## Garantías de Datos

- El `shift_id` y `global_id` se preservan durante force-takeover (solo cambia `terminal_id`)
- Ventas de Device A y Device B referencian el mismo `shift_id` → todas válidas
- `global_id` en cada venta previene duplicados si ambos dispositivos sincronizan lo mismo
- **No se pierde ni se huérfana ningún dato** (excepto pérdida física de hardware)

---

## Habilitar / Deshabilitar

### Para habilitar

1. Asegurar que la migración `037_multi_caja_support.sql` está aplicada
2. Verificar que Desktop y Mobile están en versiones compatibles
3. `PUT /api/branches/{id}/settings` con `{ multi_caja_enabled: true }`

### Para deshabilitar

1. **Cerrar todos los turnos** en la sucursal (el endpoint bloquea si hay turnos abiertos)
2. `PUT /api/branches/{id}/settings` con `{ multi_caja_enabled: false }`
3. Dispositivos vuelven al comportamiento legacy en su siguiente turno

---

## Troubleshooting

### "Se requiere conexión a internet para abrir turno"
- Solo aparece en modo multi-caja. El dispositivo necesita contactar PG para abrir turno.
- Verificar conectividad de red y que el servidor esté corriendo.

### "Se requiere internet para cerrar turno en modo multi-caja"
- En multi-caja, cerrar turno sin internet dejaría el turno "fantasma" en el backend.
- El empleado debe esperar a tener internet para cerrar.
- Si es urgente: un admin puede cerrar el turno desde otro dispositivo con internet.

### Conflicto inesperado al abrir turno
- El empleado tiene un turno abierto en otro dispositivo.
- Opciones: cerrar el turno del otro dispositivo o usar "Tomar Control".
- Si el turno anterior tiene heartbeat > 8 horas: se auto-cierra y abre turno nuevo.

### "No hay terminales registradas"
- Los terminales se registran automáticamente al abrir turno.
- Verificar que la migración 038 se aplicó (`branch_devices.is_active` existe).
- Verificar que el índice `idx_branch_devices_unique` existe (requerido para ON CONFLICT).
- Si el auto-registro falla, revisar logs por "Terminal registration error (non-fatal)".

### Heartbeat no se actualiza
- Verificar que `SocketIOService.StartShiftHeartbeat()` se llama después de abrir turno.
- Revisar `shifts.last_heartbeat` en PostgreSQL para el turno activo.
- Si es mobile en background, es comportamiento esperado (OS suspende el timer).

### Force takeover no funciona
- Verificar que el evento `force_takeover` incluye `employeeId` y `terminalId`.
- Revisar logs del servidor en `socket/handlers.js` → `force_takeover` handler.
- Si el target está "offline" pero el heartbeat es reciente, puede haber desync del reloj.

### Datos pendientes después de force-logout
- Los datos quedan en SQLite local con `Synced=false`.
- `AutoSyncService` (Desktop) o `SaleQueueService` (Mobile) los reintenta automáticamente.
- Si el turno fue tomado, el servidor igual acepta los datos (mismo `shift_id`).

---

## Aplicabilidad a Multi-Sucursal

Multi-sucursal comparte los mismos principios que multi-caja:

| Requisito | Multi-Caja | Multi-Sucursal |
|---|---|---|
| Internet obligatorio | Sí | Sí |
| Backend como fuente de verdad | Sí | Sí |
| Exclusión mutua de turnos | Por empleado | Por empleado + sucursal |
| Heartbeat | Sí | Sí |
| Force takeover | Sí | Sí (cross-branch) |
| Terminal naming | Sí (por branch) | Sí (por branch) |
| Stale shift detection | 8 horas | 8 horas |

Al implementar multi-sucursal, reutilizar toda la infraestructura de multi-caja. La única diferencia es que el `branch_id` puede cambiar entre sesiones del mismo empleado.

---

## Archivos Clave

### Backend (`sya-socketio-server`)
| Archivo | Responsabilidad |
|---------|----------------|
| `migrations/037_multi_caja_support.sql` | Schema: `multi_caja_enabled`, `last_heartbeat`, índice |
| `migrations/038_terminal_naming.sql` | Schema: `is_active` en branch_devices, índice único de nombres |
| `database/migrations.js` | Auto-migration patches (is_active, idx_branch_devices_unique) |
| `routes/branches.js` | GET/PUT settings con toggle guard |
| `routes/shifts.js` | POST /open con 409 conflicto + stale detection (8h), auto-registro de terminal |
| `routes/devices.js` | CRUD terminales: listar, renombrar, des/activar |
| `socket/handlers.js` | `shift_heartbeat`, `force_takeover`, `flush_complete`, `session_revoked_pending_flush` |

### Mobile (`sya_mobile_app`)
| Archivo | Responsabilidad |
|---------|----------------|
| `lib/features/pos/services/pos_api_service.dart` | `ShiftConflictException`, envío de `terminalId`, parseo de terminal name |
| `lib/infrastructure/socket/socket_service.dart` | Heartbeat emit, flush stream, flush_complete, `terminal:updated` listener |
| `lib/features/pos/viewmodels/pos_view_model.dart` | Timer heartbeat, manejo 409, auto-recovery, revocation listener |
| `lib/features/terminals/` | Terminal management: model, API service (cache), UI page |

### Desktop (`SyaTortilleriasWinUi`)
| Archivo | Responsabilidad |
|---------|----------------|
| `Services/BackendSyncService.cs` | Métodos server-first, terminal name cache (`ResolveTerminalName`), `GetTerminalsAsync` |
| `Services/CurrentSessionService.cs` | `MultiCajaEnabled` flag de sesión |
| `Services/ShiftService.cs` | `RecoverShiftFromServerDataAsync` (auto-recovery) |
| `ViewModels/OpenShiftViewModel.cs` | `StartShiftServerFirstAsync`, heartbeat wiring |
| `ViewModels/VentasViewModel.cs` | `await` sync (multi-caja) vs `Task.Run` (legacy) |
| `ViewModels/CashDrawerViewModel.cs` | Guard de internet en `CloseShift()` para multi-caja |
| `ViewModels/LiquidacionViewModel.cs` | Guard de internet en `CerrarTurno()` y `ConfirmarLiquidacion()` |
| `Views/ShellPage.xaml.cs` | Guard de internet en `CloseMyShift_Click()` |
| `ViewModels/TerminalManagementViewModel.cs` | Gestión de terminales (renombrar, des/activar) |
| `Services/SocketIOService.cs` | Heartbeat timer, `session_revoked_pending_flush` handler, `flush_complete` |
