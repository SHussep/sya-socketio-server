# Terminal Naming System — Design Spec

## Goal

Allow admins (Owner/Administrador) to assign human-readable names to terminals (devices) so every sale, shift, ticket, and dashboard clearly identifies which device generated it. Replaces the current unreadable UUID-based identification.

## Context

- **3-layer architecture**: Backend (Node.js/PostgreSQL) → Desktop (WinUI/C#) → Mobile (Flutter/Dart)
- Each device already has a persistent `terminal_id` (UUID v4) stored locally
- Mobile terminals use format `mobile-{uuid8}`, Desktop uses plain UUID
- `terminal_id` is tracked on: `ventas`, `shifts`, `expenses`, `deposits`, `withdrawals`, `cash_cuts`, `purchases`, `repartidor_assignments`, etc.
- **Existing infrastructure**: `branch_devices` table already exists (migration 013) with `device_id`, `device_name`, `device_type`, `is_primary`, `last_seen_at`. Routes exist at `/api/devices/` for register, claim-primary, heartbeat, and list.
- Ticket display currently uses first 2 chars of UUID (e.g., `A1-1-5`) — not meaningful

## Architecture

Server-authoritative: terminal names live in PostgreSQL in the existing `branch_devices` table. Clients cache locally and sync via REST + Socket.IO events. Auto-registration on first shift open with optional rename prompt for Owner/Admin users.

## Database Changes

### Extend existing `branch_devices` table

No new table needed. Add two columns and one constraint:

```sql
-- Migration: 0XX_terminal_naming.sql

-- Soft delete support
ALTER TABLE branch_devices
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Unique name per branch among active devices
CREATE UNIQUE INDEX IF NOT EXISTS uq_branch_devices_name_active
    ON branch_devices(branch_id, tenant_id, device_name)
    WHERE is_active = TRUE AND device_name IS NOT NULL;
```

### Existing fields (already in branch_devices)

| Field | Purpose |
|-------|---------|
| `device_id` | The device UUID (matches `terminal_id` across all tables) |
| `device_name` | User-assigned name, free text, max 255 chars. Unique per branch among active devices |
| `device_type` | `'desktop'`, `'mobile'`, `'tablet'` |
| `is_primary` | Whether this is the primary device for the branch |
| `last_seen_at` | Updated on shift open and heartbeat |
| `tenant_id` | Tenant scoping |
| `branch_id` | Branch scoping |

### New fields

| Field | Purpose |
|-------|---------|
| `is_active` | Soft delete. Inactive devices don't appear in filters/lists but historical data keeps the name |

## API Changes

### Existing endpoints (keep as-is)

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/devices/register` | Register device (already does UPSERT) |
| POST | `/api/devices/claim-primary` | Claim primary role |
| GET | `/api/devices/branch/:branchId` | List devices for branch |
| POST | `/api/devices/heartbeat` | Update last_seen_at |

### Modify: GET `/api/devices/branch/:branchId`

Add `include_inactive` query param. Default: only active devices.

```sql
-- Current (no is_active filter)
WHERE branch_id = $1 AND tenant_id = $2

-- New
WHERE branch_id = $1 AND tenant_id = $2
  AND (is_active = TRUE OR $3 = TRUE)  -- $3 = include_inactive param
```

### New: PATCH `/api/devices/:id`

Rename or deactivate a device.

**Body:**
```json
{ "device_name": "Caja Principal" }
// or
{ "is_active": false }
```

**Auth:** Owner or Administrador only.

**Validation:**
- Name must be 1-50 characters (enforce reasonable limit even though column is 255)
- Name must be unique among active devices in the same branch+tenant
- Cannot deactivate a device with an active (open) shift
- On rename, emit Socket.IO `terminal:updated` to `branch_{branchId}` room

**Response:**
```json
{
    "success": true,
    "data": {
        "id": 1,
        "device_id": "a1b2c3d4-...",
        "device_name": "Caja Principal",
        "device_type": "desktop",
        "is_primary": true,
        "is_active": true
    }
}
```

### Modify: POST `/api/devices/register`

Add auto-naming when `device_name` is null/empty:
1. Count active devices in branch: `SELECT COUNT(*) FROM branch_devices WHERE branch_id = $1 AND tenant_id = $2 AND is_active = TRUE`
2. Suggested name: `"Caja {count + 1}"`
3. If name collides (reactivated device), increment until unique
4. Return `is_new: true` if this was an INSERT (not an UPDATE) — tells client to show rename prompt

Handle race condition: wrap in retry loop catching unique constraint violation on `uq_branch_devices_name_active`, increment N and retry (max 5 attempts).

## Auto-Registration Flow

Terminal registration happens automatically at shift open — no manual setup required.

```
Device opens shift (POST /api/shifts/open)
  ↓
Backend checks: does device_id exist in branch_devices for this branch?
  ↓
  NO → Call register logic internally:
    1. Determine device_type from terminal_id format (mobile-* = mobile, else desktop)
    2. Generate suggested name: "Caja {N}" (N = count of active devices + 1)
    3. INSERT into branch_devices with auto-name
    4. Include device info in shift open response
    5. Client shows rename prompt (Owner/Admin only)
  ↓
  YES → Update last_seen_at
    1. Include device info in shift open response
    2. If is_active = FALSE, reactivate (set is_active = TRUE, keep old name)
```

### Shift open response addition

The existing shift open response adds a `terminal` object:

```json
{
    "success": true,
    "shift": { ... },
    "terminal": {
        "id": 1,
        "name": "Caja 1",
        "deviceType": "desktop",
        "isPrimary": true,
        "isNew": true
    }
}
```

`isNew: true` tells the client to show the rename prompt (only for Owner/Admin roles).

## Name Resolution

### Client-side cache

On login/startup, clients fetch `GET /api/devices/branch/:branchId` and build a local map:

```
Map<string, string> terminalNames = { "a1b2c3d4-..." → "Caja 1", "mobile-e5f6g7h8" → "Caja 2" }
```

### Real-time sync

When a device is renamed or deactivated:
1. Backend emits Socket.IO event `terminal:updated` to room `branch_{branchId}`
2. Payload: `{ id, deviceId, deviceName, deviceType, isPrimary, isActive }`
3. All connected clients update their local cache

### Name lookup

Wherever `terminal_id` appears in data (sales, shifts, etc.):
- Client resolves locally: `terminalNames[terminal_id] ?? "Caja ?" `
- No server-side JOIN needed — keeps existing queries fast
- Fallback for unknown terminal_ids (historical data before naming): first 4 chars of UUID

## Where Terminal Name Appears

### POS Screen

- Top bar or header area: badge showing device icon + name
- Desktop icon (monitor) or mobile icon (phone) based on `device_type`
- Always visible so operator knows which terminal they're on

### Printed/PDF Ticket (configurable)

New receipt setting: `ShowTerminalName` (default: `true`)

- Added alongside existing toggles in `ReceiptSettings`: `ShowTicketNumber`, `ShowTurno`, `ShowCanal`
- When enabled, ticket prints line: `Terminal: Caja 1`
- In `ReceiptSettings` model: `public bool ShowTerminalName { get; set; } = true;`
- User can disable in receipt settings — same pattern as all other toggles

### Ticket Display in Dashboards

Change format from `A1-{shiftId}-{ticketNumber}` to `{terminalName} #{ticketNumber}`.

The `FormatTicketDisplay` method changes:
- Old: `FormatTicketDisplay(terminalId, shiftId, ticketNumber)` → `"A1-1-5"`
- New: `FormatTicketDisplay(terminalName, ticketNumber)` → `"Caja 1 #5"`
- Fallback if name not cached: first 4 chars of UUID + ` #` + ticketNumber
- Note: `shiftId` is intentionally dropped from the display — it's internal info not useful to the user. Shift info is available elsewhere (column, details).

### Sales Table (VentasDashboard)

New column "Terminal" showing the terminal name with device type icon.

### Corte de Caja (CashDrawerViewModel)

Each shift's section header includes terminal name: "Turno #1 — Caja 1"

### Liquidaciones

Assignment source shows: "Asignada desde Caja 2"

### Settings — Terminal Management Section

New section in Settings (Desktop and Flutter):

- List of all devices for the branch (active by default, toggle to show inactive)
- Each row: device type icon, name (editable), primary badge, last seen timestamp, status
- Actions: Rename, Deactivate/Reactivate
- Only Owner/Administrador can edit; other roles see read-only list

## Permissions

| Action | Owner | Administrador | Cajero/Other |
|--------|-------|---------------|--------------|
| View terminal list | Yes | Yes | Yes (read-only) |
| Rename terminal | Yes | Yes | No |
| Deactivate terminal | Yes | Yes | No |
| Reactivate terminal | Yes | Yes | No |
| See rename prompt on first use | Yes | Yes | No (auto-named silently) |

## Edge Cases

1. **Name collision on auto-register**: Backend retries with incremented N (max 5 attempts). If all fail, use fallback name "Caja-{uuid4chars}".

2. **Deactivated terminal opens shift**: Reactivate automatically, keep old name.

3. **Same device, different branch**: A device could serve multiple branches (unlikely but supported). Each branch gets its own `branch_devices` entry with independent naming. The unique index includes `branch_id`.

4. **Historical data (pre-naming)**: Sales/shifts created before terminal naming show `terminal_id` UUID. Client resolves via cache; for unknown IDs, falls back to UUID prefix. No backfill migration needed — terminals get registered on next shift open.

5. **No network at startup**: Terminal name from last session should be cached locally (Desktop: SQLite, Flutter: SharedPreferences). If cache is empty (first ever offline start), use UUID prefix.

6. **Concurrent registration race**: Unique constraint on `(branch_id, tenant_id, device_name) WHERE is_active` prevents duplicates. Retry loop handles the conflict.

## Migration from `is_primary` to naming

The existing `is_primary` concept remains. It controls which device has full access (Primary) vs auxiliary. Terminal naming is orthogonal — a device named "Caja 1" could be Primary or Auxiliar. The `is_primary` badge shows alongside the terminal name in the management UI.

## Future Considerations

- Desktop may become optional — Flutter could be the sole client. The design is device-agnostic: `device_type` is informational, not functional. No "primary terminal = desktop" assumption.
- Terminal analytics: which terminal sells more, peak hours per terminal, etc. The `branch_devices` table with `device_id` linking to sales/shifts enables this without schema changes.
- Could add terminal-specific settings (printer config, scale config) to `branch_devices` later.
