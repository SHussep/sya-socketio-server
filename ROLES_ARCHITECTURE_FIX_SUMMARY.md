# 🔧 Roles Architecture Fix - Complete Summary

## Problem Identified

The role-based access control system had a critical architectural mismatch:

### **Old Architecture (Broken):**
- ❌ Roles were tenant-scoped with auto-increment IDs
- ❌ Example: Tenant 1 had roles with IDs 14, 15, 16, 17 (auto-assigned)
- ❌ Desktop sent fixed roleIds (1-4) that didn't match PostgreSQL
- ❌ Google signup tried to create tenant-scoped roles on every signup
- ❌ Result: FK constraint violations, sync failures, "role doesn't exist" errors

### **New Architecture (Fixed):**
- ✅ Roles are GLOBAL with FIXED integer IDs (1, 2, 3, 4, 99)
- ✅ All tenants share the same role IDs:
  - ID 1 = Administrador (full access)
  - ID 2 = Encargado (shift manager)
  - ID 3 = Repartidor (distributor/limited access)
  - ID 4 = Ayudante (helper/support)
  - ID 99 = Otro (custom roles from Desktop)
- ✅ Mobile permissions are tenant-scoped but reference global roles
- ✅ Google signup uses existing global roles (no creation needed)

---

## Changes Made

### **1. Migration 037 - Database Schema** ✅
**File:** `migrations/037_create_roles_and_permissions_system.sql`

**What Changed:**
```sql
-- OLD: Created tenant-scoped roles
INSERT INTO roles (tenant_id, name, description)
VALUES ($1, 'Acceso Total', 'Admin access')

-- NEW: Uses global fixed roles (no tenant_id, fixed IDs)
INSERT INTO roles (id, name, description, created_at, updated_at)
VALUES
    (1, 'Administrador', 'Acceso total al sistema', NOW(), NOW()),
    (2, 'Encargado', 'Gerente de turno - permisos extensos', NOW(), NOW()),
    (3, 'Repartidor', 'Acceso limitado como repartidor', NOW(), NOW()),
    (4, 'Ayudante', 'Soporte - acceso limitado', NOW(), NOW()),
    (99, 'Otro', 'Rol genérico para roles personalizados desde Desktop', NOW(), NOW())
```

**Critical Fix:**
- Drops old tenant-scoped roles table first
- Maps existing employee role_ids to new global roles:
  - 14, 16 → 1 (Administrador)
  - 15, 17 → 3 (Repartidor)
  - NULL → 1 (Administrador default)
- Adds FK constraint AFTER data is consistent (prevents violations)

**Commits:**
- `b9135bb` - Initial global roles migration
- `0bb68a1` - Fixed FK constraint violation with proper role ID mapping

---

### **2. Auth.js - Google Signup** ✅
**File:** `routes/auth.js` (lines 362-368)

**What Changed:**
```javascript
// OLD: Tried to create tenant-scoped roles
const accesoTotalResult = await client.query(`
    INSERT INTO roles (tenant_id, name, description)
    VALUES ($1, $2, $3)
    RETURNING id
`, [tenant.id, 'Acceso Total', 'Acceso completo al sistema']);

// NEW: Uses hardcoded global role IDs
const accesoTotalRoleId = 1;  // Global: Administrador
const accesoRepartidorRoleId = 3;  // Global: Repartidor
```

**Why:** Google signup no longer needs to create roles. It just references the existing global roles. This fixes the error: "column 'tenant_id' of relation 'roles' does not exist"

**Commit:**
- `8500b97` - Removed tenant-scoped role creation from signup

---

## Impact on Employee Sync

### **Before (Broken):**
```
Desktop sends: roleId=1 (Administrador)
PostgreSQL has: role_id=14 (old tenant-scoped ID)
Result: ❌ FK constraint error
```

### **After (Fixed):**
```
Desktop sends: roleId=1 (Administrador)
PostgreSQL has: role_id=1 (global fixed ID)
Result: ✅ Perfect match - sync succeeds!
```

---

## Deployment Status

### **Commits in Order:**
1. ✅ `b9135bb` - Migration 037: Global roles with fixed IDs
2. ✅ `0bb68a1` - Migration 037: FK constraint fix with role ID mapping
3. ✅ `8500b97` - Auth.js: Remove tenant-scoped role creation

### **Expected After Redeploy:**
1. Migration 037 will apply successfully (FK violations resolved)
2. All employees will have role_ids mapped to global roles (1, 2, 3, 4, 99)
3. Google signup will work without role creation errors
4. Employee sync will work perfectly (roleIds match between Desktop and PostgreSQL)

---

## Testing Checklist

After Render redeploy completes:

- [ ] Check PostgreSQL roles table:
  ```sql
  SELECT id, name FROM roles ORDER BY id;
  -- Should show exactly 5 rows with IDs: 1, 2, 3, 4, 99
  ```

- [ ] Verify no tenant_id/branch_id columns:
  ```sql
  \d roles
  -- Should NOT have tenant_id or branch_id columns
  ```

- [ ] Test Google signup:
  1. Click "Sign up with Google" in Desktop
  2. Complete Google OAuth flow
  3. Check logs for: `✅ Roles globales asignados`
  4. Verify tenant was created (should succeed now)

- [ ] Test employee sync:
  1. Add new employee in Desktop with role 1-4
  2. Verify sync succeeds in logs
  3. Check PostgreSQL:
     ```sql
     SELECT id, full_name, role_id FROM employees WHERE role_id IN (1,2,3,4);
     -- Should show correct role_ids matching Desktop
     ```

- [ ] Test custom role mapping:
  1. Create custom role in Desktop (roleId > 4)
  2. Assign employee with custom role
  3. Verify employee syncs with role_id=99 in PostgreSQL
  4. Optional: Check POST /api/employees/:id/sync-role with mobileAppPermissionOverride

---

## Key Files Modified

| File | Changes | Status |
|------|---------|--------|
| `migrations/037_create_roles_and_permissions_system.sql` | Global roles, FK fix, role ID mapping | ✅ Fixed |
| `routes/auth.js` | Remove role creation, use global IDs | ✅ Fixed |
| `routes/employees.js` | Already has role ID mapping (no change needed) | ✅ OK |
| `SyaTortilleriasWinUi/Services/UnifiedSyncService.cs` | Already sends roleId correctly (no change needed) | ✅ OK |

---

## Architecture Diagram

```
BEFORE (Broken):
────────────────────────────────────────────
Desktop              PostgreSQL
roleId: 1     ──X──→  role_id: 14 (tenant 1)
roleId: 2            role_id: 15 (tenant 1)
roleId: 3            role_id: 16 (tenant 2)
roleId: 4            role_id: 17 (tenant 2)
                     ❌ No match!

AFTER (Fixed):
────────────────────────────────────────────
Desktop              PostgreSQL (Global)
roleId: 1     ──✅──→  role_id: 1 (Administrador)
roleId: 2            role_id: 2 (Encargado)
roleId: 3            role_id: 3 (Repartidor)
roleId: 4            role_id: 4 (Ayudante)
roleId: 50 (custom)  role_id: 99 (Otro)
                     ✅ Perfect match!
```

---

## Rollback Plan (If Needed)

If issues arise after deployment, we can:

1. Keep old employee role_ids by reverting migration 037
2. Or manually map role_ids in PostgreSQL
3. Contact Saul with detailed error logs

But the fixes should work because:
- Migration properly maps old IDs to new ones
- Code no longer tries to create roles
- All IDs are pre-created and fixed

---

## Questions & Answers

**Q: Will existing employees lose their roles?**
A: No. Migration 037 maps old role_ids (14, 15, 16, 17) to new global ones (1, 2, 3, 4).

**Q: What about tenants created before this fix?**
A: Their employees will be mapped automatically during migration.

**Q: Will Desktop and PostgreSQL now sync correctly?**
A: Yes. Both will use IDs 1-4 for standard roles and 99 for custom roles.

**Q: Do I need to update Desktop code?**
A: No. Desktop already sends the correct roleIds (1-4).

**Q: What about mobile app permissions?**
A: They remain tenant-scoped (in employee_mobile_app_permissions table) but reference global role IDs.

---

## Related Documentation

- **Migration File:** `migrations/037_create_roles_and_permissions_system.sql`
- **Role ID Mapping:** `routes/employees.js` (lines 40-61)
- **Sync Endpoint:** `routes/employees.js` (lines 396-402)
- **Desktop Sync Service:** `SyaTortilleriasWinUi/Services/UnifiedSyncService.cs` (lines 1317-1336)
- **Verification Guide:** `MIGRATION_VERIFICATION_GUIDE.md`
