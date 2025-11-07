# 🚨 CRITICAL FIXES - Offline Shifts & Ticket Number Conflicts

## 📋 Problemas Identificados

### **1. PostgreSQL índice UNIQUE sin id_turno**
```
Error: duplicate key value violates unique constraint "ventas_uq_ticket_per_branch"
Detail: Key (tenant_id, branch_id, ticket_number)=(1, 1, 2) already exists.
```

**Causa:** El índice en PostgreSQL solo incluía `(tenant_id, branch_id, ticket_number)` SIN `id_turno`.
**Impacto:** Ventas del turno 2 con TicketNumber=1 conflictan con ventas del turno 1.

### **2. Clientes seed con GlobalId inválido**
```
Error: invalid input syntax for type uuid: "SEED_CLIENT_1002"
```

**Causa:** SeedDataService usaba strings como "SEED_CLIENT_1002" en lugar de UUIDs válidos.
**Impacto:** Clientes seed no pueden sincronizarse a PostgreSQL.

### **3. Turnos offline NO se sincronizan**
```
"id_turno": 2  ← Este turno NO existe en PostgreSQL
```

**Causa:** No existe endpoint ni lógica para sincronizar turnos creados offline.
**Impacto:** Ventas de turnos offline fallan porque referencian turnos inexistentes en PostgreSQL.

---

## ✅ Soluciones Implementadas

### **Fix 1: Actualizar índice UNIQUE en PostgreSQL**

**Archivo:** `migrations/073_fix_ventas_ticket_unique_with_shift.sql`

```sql
-- Eliminar índice viejo
DROP INDEX IF EXISTS ventas_uq_ticket_per_branch;

-- Crear nuevo índice con id_turno
CREATE UNIQUE INDEX ventas_uq_ticket_per_branch_shift
    ON ventas(tenant_id, branch_id, id_turno, ticket_number);
```

**Resultado:**
```
✅ Turno 1, TicketNumber=1 → Permitido
✅ Turno 2, TicketNumber=1 → Permitido (diferente turno)
✅ Turno 2, TicketNumber=2 → Permitido
```

---

### **Fix 2: Arreglar GlobalId de clientes seed**

**Archivo:** `SyaTortilleriasWinUi/Services/SeedDataService.cs`

**Antes:**
```csharp
GlobalId = "SEED_CLIENT_1002"  ❌ String inválido
```

**Después:**
```csharp
GlobalId = "550e8400-e29b-41d4-a716-446655441002"  ✅ UUID válido
```

**Clientes seed actualizados:**
- `1002` → `550e8400-e29b-41d4-a716-446655441002` (María González)
- `1003` → `550e8400-e29b-41d4-a716-446655441003` (Juan Pérez)
- `1004` → `550e8400-e29b-41d4-a716-446655441004` (Ana Martínez)
- `1005` → `550e8400-e29b-41d4-a716-446655441005` (Carlos López)
- `2001` → `550e8400-e29b-41d4-a716-446655442001` (Restaurante El Fogón)
- `2002` → `550e8400-e29b-41d4-a716-446655442002` (Taquería Los Compadres)
- `2003` → `550e8400-e29b-41d4-a716-446655442003` (Comedor Industrial ABC)
- `2004` → `550e8400-e29b-41d4-a716-446655442004` (Fonda Doña Lucha)
- `3001` → `550e8400-e29b-41d4-a716-446655443001` (Supermercado La Esperanza)
- `3002` → `550e8400-e29b-41d4-a716-446655443002` (Hotel Vista Hermosa)

---

### **Fix 3: Implementar sincronización de turnos offline** (🔧 PENDIENTE)

#### **3.1. Backend: Crear endpoint `/api/shifts/sync`**

**Archivo a crear:** `routes/shifts.js` (agregar endpoint)

```javascript
// POST /api/shifts/sync - Sincronizar turno desde Desktop (idempotente)
router.post('/sync', async (req, res) => {
    try {
        const {
            tenant_id,
            branch_id,
            employee_id,
            start_time,
            initial_amount,
            transaction_counter,
            is_cash_cut_open,
            // Offline-first fields
            global_id,
            terminal_id,
            local_op_seq,
            created_local_utc,
            device_event_raw,
            local_shift_id  // ID del turno en Desktop
        } = req.body;

        // Validación
        if (!tenant_id || !branch_id || !employee_id || !global_id) {
            return res.status(400).json({
                success: false,
                message: 'Datos incompletos (tenant_id, branch_id, employee_id, global_id requeridos)'
            });
        }

        // ✅ IDEMPOTENTE: INSERT con ON CONFLICT (global_id) DO UPDATE
        const result = await pool.query(
            `INSERT INTO shifts (
                tenant_id, branch_id, employee_id, start_time,
                initial_amount, transaction_counter, is_cash_cut_open,
                global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9::uuid, $10, $11, $12)
             ON CONFLICT (global_id) DO UPDATE
             SET transaction_counter = EXCLUDED.transaction_counter,
                 is_cash_cut_open = EXCLUDED.is_cash_cut_open,
                 updated_at = NOW()
             RETURNING *`,
            [
                tenant_id,
                branch_id,
                employee_id,
                start_time,
                initial_amount || 0,
                transaction_counter || 0,
                is_cash_cut_open,
                global_id,
                terminal_id || null,
                local_op_seq || null,
                created_local_utc || null,
                device_event_raw || null
            ]
        );

        const shift = result.rows[0];

        console.log(`[Sync/Shifts] ✅ Turno sincronizado: ID ${shift.id} (LocalShiftId: ${local_shift_id}) - Employee ${employee_id}`);

        res.json({
            success: true,
            data: {
                id: shift.id,  // RemoteId para Desktop
                global_id: shift.global_id,
                local_shift_id: local_shift_id,  // Devolver para mapeo
                created_at: shift.created_at
            }
        });

    } catch (error) {
        console.error('[Sync/Shifts] ❌ Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error al sincronizar turno',
            error: error.message
        });
    }
});
```

#### **3.2. Desktop: Implementar sincronización de turnos**

**Archivo:** `UnifiedSyncService.cs`

**Agregar método público:**
```csharp
public async Task<bool> SyncShiftImmediatelyAsync(Shift shift)
{
    if (shift == null)
    {
        LogError("Shift", null, "Shift es null");
        return false;
    }

    // VERIFICACIÓN: ¿Ya está sincronizado?
    if (shift.Synced)
    {
        Debug.WriteLine($"[UnifiedSync] ⏭️ SHIFT {shift.Id} YA SINCRONIZADO (RemoteId: {shift.RemoteId}) - Ignorando");
        return true;
    }

    Debug.WriteLine($"[UnifiedSync] 🔄 Sincronizando SHIFT {shift.Id} inmediatamente...");
    return await SyncShiftInternalAsync(shift);
}
```

**Agregar método interno:**
```csharp
private async Task<bool> SyncShiftInternalAsync(Shift shift)
{
    try
    {
        var syncConfig = await GetSyncConfigAsync();
        if (!syncConfig.HasValue) return false;

        var connection = await _databaseService.GetConnectionAsync();

        // 🔥 PREPARAR Shift antes de sincronizar (asignar offline-first fields si no existen)
        if (string.IsNullOrWhiteSpace(shift.GlobalId))
        {
            await _databaseService.PrepareShiftForInsertAsync(shift);
            await connection.UpdateAsync(shift);  // Save offline-first fields
        }

        var payload = new
        {
            tenant_id = syncConfig.Value.tenantId,
            branch_id = syncConfig.Value.branchId,
            employee_id = shift.EmployeeId,
            start_time = shift.StartTime.ToUniversalTime().ToString("o"),
            initial_amount = shift.InitialAmount,
            transaction_counter = shift.TransactionCounter,
            is_cash_cut_open = shift.IsCashCutOpen,
            // ✅ OFFLINE-FIRST FIELDS
            global_id = shift.GlobalId,
            terminal_id = shift.TerminalId,
            local_op_seq = shift.LocalOpSeq,
            created_local_utc = shift.CreatedLocalUtc,
            device_event_raw = shift.DeviceEventRaw,
            local_shift_id = shift.Id  // Para mapeo en backend
        };

        var content = new StringContent(
            JsonSerializer.Serialize(payload),
            Encoding.UTF8,
            "application/json"
        );

        var response = await _httpClient.PostAsync("/api/shifts/sync", content);

        if (response.IsSuccessStatusCode)
        {
            shift.Synced = true;
            shift.SyncedAt = _timezoneService.GetCurrentTimeInUserTimezone();

            // Intentar extraer RemoteId de la respuesta
            try
            {
                var responseBody = await response.Content.ReadAsStringAsync();
                if (!string.IsNullOrEmpty(responseBody) && responseBody.StartsWith("{"))
                {
                    using (JsonDocument doc = JsonDocument.Parse(responseBody))
                    {
                        var root = doc.RootElement;
                        if (root.TryGetProperty("data", out var dataProp) &&
                            dataProp.TryGetProperty("id", out var idProp) &&
                            idProp.TryGetInt32(out int remoteId))
                        {
                            shift.RemoteId = remoteId;
                            Debug.WriteLine($"[UnifiedSync] ✅ RemoteId extraído: {remoteId}");
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[UnifiedSync] ⚠️ No se pudo extraer RemoteId: {ex.Message}");
            }

            await connection.UpdateAsync(shift);

            Debug.WriteLine($"[UnifiedSync] ✅ SHIFT {shift.Id} sincronizado exitosamente (RemoteId: {shift.RemoteId})");
            return true;
        }
        else
        {
            var errorBody = await response.Content.ReadAsStringAsync();
            LogError("Shift", shift.Id, $"HTTP {response.StatusCode}: {errorBody}");
            Debug.WriteLine($"[UnifiedSync] ❌ Error sincronizando SHIFT {shift.Id}: {response.StatusCode}");
            return false;
        }
    }
    catch (Exception ex)
    {
        LogError("Shift", shift.Id, ex.Message);
        Debug.WriteLine($"[UnifiedSync] ❌ Excepción sincronizando SHIFT: {ex.Message}");
        return false;
    }
}
```

**Integrar en ciclo de sync (ANTES de ventas):**
```csharp
public async Task<SyncCycleResult> SyncAllPendingInCycleAsync(bool forceSync = false)
{
    // ...

    // 0. SINCRONIZAR TURNOS PENDIENTES (ANTES DE VENTAS)
    Debug.WriteLine("[UnifiedSync] 📦 Procesando TURNOS pendientes...");
    var pendingShifts = await connection.Table<Shift>()
        .Where(s => !s.Synced)
        .Take(50)
        .ToListAsync();

    int shiftsSuccessful = 0;
    int shiftsFailed = 0;

    foreach (var shift in pendingShifts)
    {
        try
        {
            if (await SyncShiftInternalAsync(shift))
                shiftsSuccessful++;
            else
                shiftsFailed++;
        }
        catch (Exception ex)
        {
            LogError("Shift", shift.Id, ex.Message);
            shiftsFailed++;
        }
    }

    if (pendingShifts.Count > 0)
    {
        Debug.WriteLine($"[UnifiedSync] ✅ Turnos: {shiftsSuccessful} exitosos, {shiftsFailed} fallidos");
    }

    // 1. SINCRONIZAR VENTAS PENDIENTES
    // ...
}
```

---

## 📊 Impacto de los Fixes

### **Antes (BROKEN):**
```
1. Abrir Turno 1 offline → NO sincronizado
2. Crear ventas 1-6 del Turno 1 → ✅ OK localmente
3. Cerrar Turno 1 offline
4. Abrir Turno 2 offline → NO sincronizado
5. Crear venta 1 del Turno 2 → ❌ CRASH (TicketNumber conflict)
6. Go online → Ventas fallan (Turno 2 no existe en PostgreSQL)
```

### **Después (FIXED):**
```
1. Abrir Turno 1 offline → Synced=false, GlobalId asignado
2. Crear ventas 1-6 del Turno 1 → ✅ OK localmente
3. Cerrar Turno 1 offline
4. Abrir Turno 2 offline → Synced=false, GlobalId asignado
5. Crear venta 1 del Turno 2 → ✅ OK (índice incluye id_turno)
6. Go online:
   - Turnos 1 y 2 se sincronizan primero
   - Ventas se sincronizan después (usan RemoteId de turnos)
   - ✅ TODO EXITOSO
```

---

## 🧪 Test Plan

### **Test 1: Multiple Offline Shifts**
```
1. Offline: Abrir Turno 1, crear 3 ventas, cerrar
2. Offline: Abrir Turno 2, crear 5 ventas, cerrar
3. Offline: Abrir Turno 3, crear 2 ventas
4. Go online
5. Trigger sync
✅ Verificar: 3 turnos sincronizados, 10 ventas sincronizadas
```

### **Test 2: Ticket Numbers Across Shifts**
```
1. Offline: Turno 1 - Crear ventas con TicketNumber 1, 2, 3
2. Offline: Turno 2 - Crear ventas con TicketNumber 1, 2, 3
3. Go online
4. Trigger sync
✅ Verificar: 6 ventas sincronizadas sin conflictos
```

### **Test 3: Seed Customers Sync**
```
1. Fresh install → Seed data con UUIDs válidos
2. Go online
3. Trigger sync
✅ Verificar: 10 clientes seed sincronizados exitosamente
```

---

## 📝 Archivos Modificados

### **Backend:**
- ✅ `migrations/073_fix_ventas_ticket_unique_with_shift.sql` - NEW
- 🔧 `routes/shifts.js` - Agregar endpoint `/api/shifts/sync` (PENDIENTE)

### **Desktop:**
- ✅ `SyaTortilleriasWinUi/Services/SeedDataService.cs` - Fix GlobalId
- ✅ `SyaTortilleriasWinUi/Services/DatabaseService.cs` - Fix índice UNIQUE
- 🔧 `SyaTortilleriasWinUi/Services/UnifiedSyncService.cs` - Agregar shift sync (PENDIENTE)
- 🔧 `SyaTortilleriasWinUi/Services/Interfaces/IUnifiedSyncService.cs` - Agregar métodos (PENDIENTE)

---

## ⚠️ Breaking Changes

### **Desktop:**
- **Clientes seed:** GlobalId cambió de "SEED_CLIENT_XXXX" a UUIDs válidos
- **Acción requerida:** Usuarios existentes necesitan borrar seed data y recrear

### **PostgreSQL:**
- **Índice UNIQUE:** Cambió de `(tenant_id, branch_id, ticket_number)` a `(..., id_turno, ticket_number)`
- **Acción requerida:** Ejecutar migration 073

---

## 🚀 Deployment Order

1. **Backend:** Deploy migration 073 y endpoint shifts/sync
2. **Desktop:** Deploy con seed fix y shift sync
3. **Test:** Verificar flujo completo offline→online

---

**Status:** 2/3 fixes completos, 1 pendiente (shift sync)
**Priority:** CRITICAL - Bloquea uso offline multi-turno
**ETA:** ~2 horas para completar shift sync
