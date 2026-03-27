# Server-First Multi-Caja Migration

## Goal

Migrate all Desktop (WinUI) operations to server-first when `multi_caja_enabled = true` for the branch. SQLite becomes a cache layer. This ensures data consistency when multiple devices (Desktop + iPad/Flutter) share the same shift.

## Context

- **System**: 3-layer POS for tortillerias — Backend (Node.js/Socket.IO/PostgreSQL) → Desktop (WinUI/C#/SQLite) → Mobile (Flutter/Dart)
- **Current state**: Desktop is local-first (SQLite) with background sync to server. Mobile is already server-first.
- **Problem**: In multi-caja, two devices can create conflicting data (especially credit balances, cash drawer totals) because Desktop doesn't go through the server first.
- **Already server-first**: Sales (`CreateSaleServerFirstAsync`), deposits (`CreateDepositServerFirstAsync`), withdrawals (`CreateWithdrawalServerFirstAsync`), shift opening, corte de caja summary.

## Architecture

### Three operation layers

| Layer | Entities | Online behavior | Offline behavior |
|-------|----------|----------------|-----------------|
| **Transactional** | Sales, expenses, deposits, withdrawals, purchases, credit payments, cancellations, credit notes | POST to server → save in SQLite as cache | Cash/card/transfer sales: local queue. **Credit sales (including mixed with credit component): blocked.** Cancellations/credit notes: blocked (affect balances). Expenses/deposits/withdrawals/purchases: local queue. |
| **Master data** | Customers, products, suppliers, employees | POST/PUT to server → SQLite as cache. Reads: SQLite with 2 min TTL + socket events for critical changes | Local queue with `pending_sync` flag. Duplicates resolved manually later. |
| **Read-only config** | Roles, categories, branch settings | Periodic pull from server → SQLite cache | SQLite cache (rarely changes) |

### Single-caja vs multi-caja

All changes are gated behind `_sessionService.MultiCajaEnabled`. When `false`, the existing local-first flow remains unchanged. No behavioral changes for single-caja branches.

### Server-first flow (transactional)

```
User creates operation (e.g., expense)
  → MultiCajaEnabled?
      NO → existing local-first flow (unchanged)
      YES → try POST /api/{resource}
          SUCCESS → receive RemoteId → save in SQLite (Synced=true)
          NETWORK ERROR → is credit/cancellation/credit-note? → BLOCKED (UI: greyed out + tooltip)
                          other? → save in SQLite (Synced=false, PendingServer=true) → sync on reconnect
```

### Server-first flow (master data writes)

```
User creates/edits master data (e.g., customer)
  → MultiCajaEnabled?
      NO → existing local-first flow (unchanged)
      YES → try POST/PUT /api/{resource}
          SUCCESS → receive RemoteId → save in SQLite as cache
          NETWORK ERROR → save in SQLite (Synced=false, PendingServer=true) → sync on reconnect
```

### Master data reads (with TTL cache)

```
ViewModel requests data (e.g., list customers)
  → MultiCajaEnabled?
      NO → read from SQLite (unchanged)
      YES → is cache fresh (< 2 min since last server pull)?
          YES → read from SQLite cache
          NO → try GET /api/{resource}
              SUCCESS → update SQLite cache → return data
              NETWORK ERROR → read from SQLite cache (stale but available)
```

### Socket events for cache invalidation

Existing events (`customer_updated`, `product_updated`) already trigger cache refresh. New events needed:

- `supplier_updated` — emitted when supplier is created/edited via `POST/PUT /api/suppliers`. Payload: `{ supplierId, globalId, tenantId, branchId, action: 'created'|'updated' }`
- `inventory_updated` — emitted when stock changes via: purchase creation, manual stock adjustment, credit note return (triggers `trigger_revert_balance_on_nc_cancel`). Payload: `{ productId, globalId, tenantId, branchId, action: 'purchase'|'adjustment'|'return' }`

On receiving an event, Desktop invalidates the TTL for that entity type and pulls fresh data on next access.

## Connectivity detection

### ServerHealthService (new)

- **Primary mechanism**: Opportunistic detection — any HTTP call failure (timeout, network error) immediately marks server as unreachable
- **Secondary mechanism**: Pings server every 30 seconds via `GET /api/health` (lightweight, returns 200 + `{ status: 'ok' }`)
- Exposes `IsServerReachable` as observable property
- ViewModels subscribe to changes for UI updates (e.g., credit option enable/disable)
- Debounced: requires 2 consecutive failures before marking offline (avoids flicker on transient errors)
- A single successful HTTP call (any endpoint) resets to online immediately
- Note: health ping proves server is reachable but not that writes will succeed (e.g., disk full). The try-catch pattern in server-first calls handles this — a 500 response on a write falls through to the offline queue, same as a network error.

## Credit sales offline block

When `MultiCajaEnabled && !IsServerReachable`:

- Payment method "Credito" appears greyed out / disabled in the payment selector
- **Mixed payments**: If a sale includes any credit component (`tipo_pago_id = 4`, partial cash + partial credit), the credit portion is also blocked. The cashier must use cash/card/transfer only.
- Tooltip: "Requiere conexion a internet"
- If credit was already selected when connection drops, auto-switch to cash with notification toast
- **Cancellations and credit notes** are also blocked offline — they trigger PostgreSQL balance updates (`trigger_update_customer_balance`, `trigger_revert_balance_on_nc_cancel`) that must execute on the server to maintain consistency.
- Rationale: credit sales affect `saldo_deudor` on customers table. Two devices extending credit simultaneously without server coordination can exceed credit limits.

## Error handling and retry strategy

### Server-first HTTP calls

```csharp
// Corrected pattern: try-POST-catch-fallback (not check-then-POST)
if (_sessionService.MultiCajaEnabled)
{
    try
    {
        var serverResult = await _backend.CreateExpenseServerFirstAsync(payload);
        entity.RemoteId = serverResult.Id;
        entity.Synced = true;
        await _db.InsertAsync(entity); // SQLite cache
        _serverHealth.MarkOnline(); // opportunistic: server is reachable
        return entity;
    }
    catch (HttpRequestException) // network error
    {
        _serverHealth.MarkOffline(); // opportunistic detection
        // Fall through to offline queue
    }
    catch (ServerErrorException ex) when (ex.StatusCode >= 500)
    {
        // Server error — queue for retry, don't block user
        // Fall through to offline queue
    }
    // 4xx errors (validation, conflict) should NOT fall to offline queue — show error to user

    // Offline queue fallback
    entity.Synced = false;
    entity.PendingServer = true;
    await _db.InsertAsync(entity);
    return entity;
}
```

### Retry configuration

- HTTP timeout: 10 seconds per request
- Queue processor: retries every 60 seconds when online
- Max retries per entity: 5 (then flag as `SyncFailed` for manual review)
- 4xx errors (validation, bad request): do NOT retry — show error to user immediately

## Offline → online reconciliation

When Desktop reconnects after operating offline in multi-caja:

### Pre-condition: drain queue before resuming server-first

When connectivity is restored, the offline queue MUST drain completely before Desktop resumes normal server-first mode. This prevents stale-read-of-own-write issues (e.g., a customer created offline doesn't exist on server yet, but Desktop tries to create a server-first sale referencing that customer).

```
Connection restored
  → Pause server-first mode (keep using local queue)
  → Drain offline queue in order (see below)
  → All drained successfully? → Resume server-first mode
  → Some failed? → Retry failed items, resume server-first for non-dependent entities
```

### Queue processing order

```
1. Master data (customers, suppliers, products) — FK dependencies must exist first
2. Transactions (sales, expenses, deposits, withdrawals, purchases)
3. Credit payments — last, after customers are synced
4. Post-drain: invalidate all customer caches (re-pull saldo_deudor from server)
```

### Step 4: Balance reconciliation

After the offline queue drains, Desktop MUST invalidate the customer cache and re-pull all customer data (especially `saldo_deudor`) from the server. This ensures local balances reflect all server-side trigger updates that fired during queue replay. The TTL is force-expired for the customers entity.

### Idempotency contract

All entities have `global_id` (UUID). Server endpoints use:

```sql
INSERT INTO {table} (...) VALUES (...)
ON CONFLICT (global_id) DO NOTHING
RETURNING id, global_id;
```

- If insert succeeds: returns the new `id` (normal case)
- If conflict (already exists): `RETURNING` returns nothing. The endpoint then does a `SELECT id FROM {table} WHERE global_id = $1` and returns the existing `id`.
- **In both cases**, the response includes `{ id, global_id }` so Desktop can mark the entity as synced with the correct `remote_id`.
- This is `DO NOTHING`, not `DO UPDATE` — financial transactions are immutable once created. Existing sync endpoints that use `DO UPDATE` (like credit-payments/sync) will be aligned to `DO NOTHING` for server-first mode.

### Duplicate master data

If two devices create the same customer/product while one is offline, both get different `global_id`s. These are genuine duplicates that get resolved manually (merge/delete) — an acceptable trade-off vs. blocking all master data creation offline.

## Components to modify/create

### Backend (sya-socketio-server)

| Component | Action | Detail |
|---|---|---|
| `POST /api/expenses` | **Create** | Direct single-item expense creation endpoint (server-first). NOT the batch `/sync` endpoint. Return `{ id, global_id }`. Emit socket `expense_created` to branch room. |
| `POST /api/purchases` | **Create** | Direct single-item purchase creation endpoint. Return `{ id, global_id }`. |
| `POST /api/credit-payments` | **Create** | Direct single-item credit payment endpoint. The existing `/sync` is batch-only. Return `{ id, global_id }`. Update `saldo_deudor` via existing trigger. |
| `POST /api/customers` | Verify | Verify create/edit endpoints work for server-first usage. Ensure `ON CONFLICT (global_id) DO NOTHING` + return existing `id`. |
| `POST /api/productos` | Verify | Same verification as customers. |
| `POST /api/suppliers` | **Create** | Direct create/edit supplier endpoint if not exists. |
| `GET /api/expenses/pull` | **Create** | Incremental pull endpoint with `since` parameter (does NOT exist — unlike deposits/withdrawals which have `/pull`). |
| `GET /api/purchases/pull` | **Create** | Incremental pull endpoint. |
| `GET /api/credit-payments/pull` | **Create** | Incremental pull endpoint. |
| `GET /api/health` | **Create** | Lightweight: `SELECT 1` + return `{ status: 'ok' }`. No auth required. |
| Socket: `supplier_updated` | **Create** | Emit on supplier create/edit. |
| Socket: `inventory_updated` | **Create** | Emit on purchase creation, manual stock adjustment, credit note return. |
| `POST /api/cancellations` | **Create** | Direct cancellation endpoint (server-first). Must execute balance/inventory triggers server-side. Return `{ id, global_id }`. |
| `POST /api/credit-notes` | **Create** | Direct credit note endpoint (server-first). Triggers `trigger_revert_balance_on_nc_cancel`. Return `{ id, global_id }`. |
| `GET /api/cancellations/pull` | **Create** | Incremental pull endpoint for multi-device visibility. |
| `GET /api/credit-notes/pull` | **Create** | Incremental pull endpoint for multi-device visibility. |
| Idempotency alignment | **Modify** | Ensure all server-first endpoints use `ON CONFLICT (global_id) DO NOTHING` + return existing `id` on conflict. |

### Desktop (SyaTortilleriasWinUi)

| Component | Action | Detail |
|---|---|---|
| `ServerHealthService.cs` | **Create** | Opportunistic + 30s ping. Expose `IsServerReachable`. Mark online/offline from any HTTP result. |
| `CacheService.cs` | **Create** | TTL=2 min per entity type. Force-invalidate on socket event. Force-invalidate all after queue drain. |
| `BackendSyncService.cs` | Expand | `CreateExpenseServerFirstAsync()`, `CreatePurchaseServerFirstAsync()`, `CreateCreditPaymentServerFirstAsync()`, `CreateCancellationServerFirstAsync()`, `CreateCreditNoteServerFirstAsync()` |
| `BackendSyncService.cs` | Expand | CRUD for master data: `CreateCustomerServerFirstAsync()`, `UpdateCustomerServerFirstAsync()`, `PullCustomersAsync()`, etc. |
| Domain services | Modify | `ExpenseService`, `PurchaseService`, `CreditPaymentService`, `ClienteService`, `ProductoService`, `ProveedorService` — add try-POST-catch-fallback pattern. |
| `SocketIOService.cs` | Expand | Listeners for `supplier_updated`, `inventory_updated`, `expense_created`. |
| Venta ViewModel | Modify | Disable credit (including mixed) when `MultiCaja && !IsServerReachable`. |
| Cancellation/CreditNote ViewModel | Modify | Block cancellations and credit notes when `MultiCaja && !IsServerReachable`. |
| Offline queue processor | **Create/Expand** | Process `PendingServer = true` in correct order. Drain before resuming server-first. Handle idempotent responses. |

## Migration order (by risk priority)

1. **Infrastructure**: `ServerHealthService`, `CacheService`, `GET /api/health` — foundation for everything else
2. **Credit offline block** — immediate safety: disable credit/cancellations/credit-notes offline in multi-caja UI
3. **Credit payments** — affects customer balances, highest inconsistency risk
4. **Cancellations + credit notes** — affect balances and inventory via triggers
5. **Expenses** — affects cash drawer totals (corte already server-first)
6. **Purchases** — affects inventory and supplier balances
7. **Customers (CRUD + credit)** — master data with sensitive balance field
8. **Products** — master data, shared prices
9. **Suppliers** — master data, lower risk
10. **Employees** — generally read-only from Desktop
11. **Inventory** — depends on products and purchases
12. **Offline queue processor** — reconciliation on reconnect

## Decisions log

| Decision | Choice | Rationale |
|---|---|---|
| Offline in multi-caja | Cash/card/transfer sales OK, credit/cancellations/credit-notes blocked, expenses/deposits/withdrawals queued | Can't stop selling tortillas because internet is down, but balance-affecting operations need server |
| Master data reads | SQLite cache TTL 2 min + socket events for critical changes | Fast UX + freshness where it matters |
| Master data writes offline | Local queue with `pending_sync`, duplicates resolved later | Rare operation, acceptable trade-off |
| Credit block UI | Greyed out option + tooltip "Requiere conexion a internet" | Clear, non-confusing for cashier |
| Mixed payments offline | Credit component blocked, cash/card/transfer portions allowed | Prevents partial credit extension without server validation |
| Cancellations offline | Blocked | Trigger `saldo_deudor` and inventory changes that need server |
| Idempotency | `global_id` + `ON CONFLICT DO NOTHING` + return existing `id` | Prevents duplicates, handles partial success (server got it, Desktop didn't get response) |
| Error handling | try-POST-catch-fallback, not check-then-POST | Avoids race condition between connectivity check and actual request |
| Retry strategy | 10s timeout, 60s retry interval, max 5 retries, 4xx = no retry | Balances responsiveness with server load |
| Queue drain | Must complete before resuming server-first mode | Prevents stale-read-of-own-write (e.g., customer created offline not yet on server) |
| Balance reconciliation | Force re-pull customer data after queue drain | Ensures `saldo_deudor` reflects all trigger updates from replayed transactions |
| Single-caja impact | None — all changes gated behind `MultiCajaEnabled` | Zero risk to existing single-register branches |
