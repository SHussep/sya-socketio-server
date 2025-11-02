# Database Migrations

This document describes all active database migrations in the SyaTortillerias project. Migrations are automatically executed by `runMigrations.js` when the server starts.

## Active Migrations

### 004_add_local_shift_id.sql
**Purpose**: Add offline-first synchronization support for shifts

Adds `local_shift_id` columns to:
- `shifts` table (UNIQUE constraint)
- `sales` table
- `expenses` table
- `deposits` table (if exists)
- `withdrawals` table (if exists)

These columns allow the Desktop app to track local shifts before syncing with the backend.

**Status**: ✅ Deployed and working

---

### 020_fix_critical_timestamps_to_timestamptz.sql
**Purpose**: Fix critical real-time event timestamps to use `TIMESTAMP WITH TIME ZONE`

Converts the following columns to proper UTC timezone-aware timestamps:
- `guardian_events.event_date`
- `shifts.start_time` and `shifts.end_time`
- `cash_cuts.cut_date`

This ensures accurate real-time tracking across timezones for financial and operational events.

**Status**: ✅ Deployed and working

---

### 021_fix_sales_expenses_timestamps_to_utc.sql
**Purpose**: Fix transaction timestamps to use `TIMESTAMP WITH TIME ZONE`

Converts transaction-related timestamps to UTC timezone-aware format:
- `sales.sale_date`
- `expenses.expense_date`
- `purchases.purchase_date`
- `cash_drawer_sessions.start_time`, `close_time`, `opened_at`, `closed_at`
- `cash_transactions.transaction_timestamp`, `voided_at`

Ensures consistent timezone handling across all financial transactions.

**Status**: ✅ Deployed and working

---

### 032_fix_backend_schema_cleanup.sql
**Purpose**: Remove Desktop-only fields from PostgreSQL backend schema

**Removed fields from `employees` table**:
- `synced` (sync flag)
- `synced_at` (sync timestamp)
- `remote_id` (Desktop local reference)

These fields should ONLY exist in Desktop's SQLite, not in the backend PostgreSQL.

**Added fields**:
- `branch_id` to `roles` table with CASCADE FK constraint
- Unique constraint on `roles`: `(tenant_id, branch_id, name)` to prevent duplicate roles per branch/tenant

**Ensures**: Proper multi-tenant role-based access control with branch-level scoping

**Status**: ✅ Deployed and working

---

### 033_fix_employees_and_employee_branches_schema.sql
**Purpose**: Fix employees and employee-branches table to match code expectations

**Changes to `employees` table**:
- Added `password_hash` column (stores bcrypt hashed password)
- Added `password_updated_at` timestamp
- Added `is_owner` boolean flag
- Added `google_user_identifier` for OAuth integration
- Added `updated_at` timestamp for sync tracking
- Added `role_id` INTEGER FK to `roles` table
- Removed old `role` VARCHAR column (migrated data to role_id)

**Restructured `employee_branches` table**:
- Proper multi-tenant structure: `(tenant_id, employee_id, branch_id)`
- Added `is_active` boolean for soft deletes
- Added `assigned_at` timestamp
- Unique constraint prevents duplicate assignments

This migration aligns the database schema with the Desktop app's expectations and enables multi-tenant employee management.

**Status**: ✅ Deployed and working - Fixed sync issues with Google OAuth

---

### 034_add_local_shift_id_to_shifts.sql
**Purpose**: Add local_shift_id column to shifts table for offline sync

Adds indexed `local_shift_id` UNIQUE column to track shifts created on Desktop app before backend sync.

**Index created**: `idx_shifts_local_shift_id`

**Status**: ✅ Deployed and working

---

### 035_fix_employees_password_column.sql
**Purpose**: Make employees.password column nullable

**Rationale**:
- Original schema had `password` as NOT NULL
- Current code uses `password_hash` instead of `password`
- This migration allows password to be NULL (deprecated)
- Marked with comment: "DEPRECATED - Use password_hash instead"

**Status**: ✅ Deployed and working - Fixed password constraint violations

---

### 036_add_removed_at_to_employee_branches.sql
**Purpose**: Add soft-delete support to employee-branch relationships

Adds `removed_at TIMESTAMP WITH TIME ZONE` column to `employee_branches` table:
- NULL = employee is still assigned to branch (active)
- Non-NULL = employee was unassigned from branch (soft deleted)

**Index created**: `idx_employee_branches_removed_at` for fast lookups of active relationships

**Status**: ✅ Deployed and working

---

### 037_create_roles_and_permissions_system.sql
**Purpose**: Implement comprehensive role-based access control (RBAC) system

**Key Components Created**:

1. **Roles Table** - System roles only (2 roles per tenant):
   - `Administrador`: Full system access
   - `Repartidor`: Limited access (sales, inventory, cash drawer, shift closing)

2. **Permissions Table** - 20 system permissions covering:
   - Access control (mobile app, desktop app)
   - Sales operations (create, view, edit, void)
   - Inventory management
   - Cash management (drawer, cuts, deposits/withdrawals)
   - Employee management and role assignment
   - Reports and data export
   - System administration

3. **Role-Permissions Junction Table** - Maps permissions to roles
   - Administrador role: ALL permissions
   - Repartidor role: Limited to sales and cash operations

4. **Employee-Permissions View** - Easy permission checking for authorization

**How Roles Are Assigned**:
- New tenant owner: Automatically gets `Administrador` role
- New employees: Default to `Repartidor` if not specified
- Desktop synced roles: Maps Desktop roles to system roles:
  - `encargado` → `Administrador`
  - `repartidor` → `Repartidor`
  - `ayudante` → `Repartidor`
  - `dueño` → `Administrador`
  - Others → `Repartidor` (default)

**New API Endpoints** (in `routes/employee_roles.js`):
- `PUT /api/employee-roles/:id/role` - Update employee role
- `GET /api/employee-roles/:id/permissions` - Get employee permissions
- `GET /api/employee-roles/by-tenant/:tenantId` - Get available roles
- `GET /api/employee-roles/system/all` - Get all system permissions
- `POST /api/employees/sync-role` - Sync role from Desktop to PostgreSQL

**Status**: ✅ Ready for deployment - Will be automatically executed by migration 037

---

### 999_clean_user_data.sql
**Purpose**: Manual database cleanup (CURRENTLY DISABLED)

⚠️ **WARNING**: This migration was TRUNCATING all user data on every Render redeploy, causing data loss.

**Current Status**: ✅ COMMENTED OUT to preserve data on redeploy

**When to use**: Only manually enable for complete database cleanup during development/testing

All TRUNCATE statements are commented out in a multi-line comment block.

---

## Migration Statistics

- **Total active migrations**: 10 (including 037)
- **Total lines of SQL**: ~3,000+
- **Last major schema change**: 037_create_roles_and_permissions_system.sql
- **Obsolete migrations removed**: 40 (for clarity and maintenance)
- **System roles**: 2 (Administrador, Repartidor)
- **System permissions**: 20 total across 6 categories

## How Migrations Are Executed

Migrations are automatically executed by `utils/runMigrations.js` in this order:

1. Each migration in the MIGRATIONS array is executed sequentially
2. Idempotent checks prevent duplicate execution (checks if columns/tables already exist)
3. Failed migrations do not block subsequent ones (non-blocking error handling)
4. Executed at server startup before accepting connections

## Adding New Migrations

When adding a new migration:

1. Create SQL file in `migrations/` folder with descriptive name
2. Add migration to MIGRATIONS array in `utils/runMigrations.js`
3. Use idempotent patterns: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
4. Document the migration in this file
5. Test on Render staging before production

## Key Architectural Decisions

### Multi-Tenant Design
- All tables include `tenant_id` as scoping field
- Foreign keys enforce tenant isolation
- Prevents data leakage between businesses

### Timezone Handling
- All event timestamps use `TIMESTAMP WITH TIME ZONE` in UTC
- Desktop app converts local times to UTC before sending
- Critical for accurate financial reporting across timezones

### Offline-First Sync
- Local IDs (`local_shift_id`, `local_employee_id`) track Desktop changes
- Backend generates remote IDs on first sync
- Two-way sync ensures data consistency

### Soft Deletes
- `removed_at` timestamp instead of hard deletes
- Preserves data integrity and audit trails
- Allows recovery of accidentally deleted data
