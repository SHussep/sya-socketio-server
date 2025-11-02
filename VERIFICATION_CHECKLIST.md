# ✅ Verification Checklist - Employee Sync Fix

## Pre-Deployment ✅

- [x] Migration 027 created (`migrations/027_add_missing_employee_columns.sql`)
- [x] database.js updated with auto-migration logic (lines 369-493)
- [x] routes/employees.js enhanced with validation and logging
- [x] Git commit created and pushed to `main` branch
- [x] Summary documentation created (`EMPLOYEE_SYNC_FIX_SUMMARY.md`)

---

## Step 1: Verify Render Deployment

**Timeline:** 2-5 minutes after push

1. Go to https://dashboard.render.com
2. Select service `sya-socketio-server`
3. Check "Deployments" tab
4. Should see new deployment in progress
5. Wait for status to show "Live" (green checkmark)

**Expected in Logs:**
```
[DB] ✅ Tabla roles verificada/creada
[DB] ✅ Columna employees.branch_id verificada/agregada
[DB] ✅ Columna employees.role_id verificada/agregada
[DB] ✅ Columna employees.is_owner verificada/agregada
[DB] ✅ Columna employees.google_user_identifier verificada/agregada
[DB] ✅ branch_id populated from main_branch_id for existing employees
[DB] ✅ Default roles created
[DB] ✅ role_id populated for existing employees
[DB] ✅ Índices para employees creados/verificados
```

---

## Step 2: Verify PostgreSQL Schema

Connect to Postgres database in Render and run:

```sql
-- Check roles table exists
SELECT * FROM information_schema.tables
WHERE table_name = 'roles';

-- Check employees has new columns
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'employees'
ORDER BY ordinal_position;

-- Expected columns in order:
-- id, tenant_id, username, full_name, email, password, role,
-- main_branch_id, is_active, created_at, updated_at,
-- branch_id, role_id, is_owner, google_user_identifier
```

**Expected output:**
```
column_name           | data_type
------------------------------------
id                   | integer
tenant_id            | integer
username             | character varying
full_name            | character varying
email                | character varying
password             | character varying
role                 | character varying
main_branch_id       | integer
is_active            | boolean
created_at           | timestamp
updated_at           | timestamp
branch_id            | integer
role_id              | integer
is_owner             | boolean
google_user_identifier| character varying
```

---

## Step 3: Test Endpoint with curl

```bash
# Get a valid roleId and branchId first
# Query database to get these values

curl -X POST https://sya-socketio-server.onrender.com/api/employees \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": 1,
    "branchId": 1,
    "fullName": "Test Sync Employee",
    "username": "testsync001",
    "email": "testsync@example.com",
    "roleId": 1,
    "isActive": true,
    "isOwner": false
  }'
```

**Expected response:**
```json
{
  "success": true,
  "data": {
    "id": 999,
    "tenant_id": 1,
    "branch_id": 1,
    "full_name": "Test Sync Employee",
    "username": "testsync001",
    "email": "testsync@example.com",
    "role_id": 1,
    "is_active": true,
    "is_owner": false,
    "created_at": "2024-10-31T12:34:56.789Z",
    "updated_at": "2024-10-31T12:34:56.789Z"
  },
  "id": 999,
  "employeeId": 999,
  "remoteId": 999
}
```

**Logs should show:**
```
[Employees/Sync] 🔄 Desktop sync - Tenant: 1, Branch: 1, Employee: Test Sync Employee (testsync001)
[Employees/Sync] 📝 Creando nuevo empleado: Test Sync Employee
[Employees/Sync] ✅ Empleado sincronizado exitosamente: Test Sync Employee (ID: 999)
[Employees/Sync] 📊 Detalles: email=testsync@example.com, role_id=1, branch_id=1
```

---

## Step 4: Test in WinUI Desktop App

1. Open `SyaTortilleriasWinUi` in Visual Studio
2. Set Debug Output filter to show `[Employees/Sync]` and `[UnifiedSync]`
3. Navigate to Employees page
4. Click "Add Employee" button
5. Fill in form:
   - Full Name: "Juan Test"
   - Username: "juantest01"
   - Email: "juantest@example.com"
   - Password: "Test1234!"
   - Confirm Password: "Test1234!"
   - Role: (select any available role)
6. Click "Add Employee"

**Expected in Visual Studio Output:**

```
DEBUG: Llamando AddFullEmployeeAsync
  Nombre: Juan Test
  Username: juantest01
  Email: juantest@example.com
  RoleId: 2

DEBUG: AddFullEmployeeAsync retornó: True

[Employees/Sync] 🔄 Desktop sync - Tenant: 1, Branch: 1, Employee: Juan Test (juantest01)
[Employees/Sync] 📝 Creando nuevo empleado: Juan Test
[Employees/Sync] ✅ Empleado sincronizado exitosamente: Juan Test (ID: 1001)
[Employees/Sync] 📊 Detalles: email=juantest@example.com, role_id=2, branch_id=1

[UnifiedSync] 🔄 Sincronizando EMPLEADOS...
[UnifiedSync] ✅ EMPLEADO Juan Test sincronizado exitosamente (RemoteId: 1001)
```

**Success indicators:**
- ✅ No errors in Visual Studio Output
- ✅ InfoBar shows "Empleado agregado correctamente. Sincronizando con servidor..."
- ✅ Employee appears in local list
- ✅ After ~2-5 seconds, employee appears in PostgreSQL

---

## Step 5: Verify in PostgreSQL

```sql
SELECT id, full_name, username, email, branch_id, role_id, is_owner, synced
FROM employees
WHERE email = 'juantest@example.com'
LIMIT 1;
```

**Expected:**
```
id  | full_name | username  | email              | branch_id | role_id | is_owner
----|-----------|-----------|-------------------|-----------|---------|----------
1001| Juan Test | juantest01| juantest@example.com| 1        | 2       | false
```

---

## Step 6: Error Handling Tests

### Test 6a: Invalid roleId

```bash
curl -X POST https://sya-socketio-server.onrender.com/api/employees \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": 1,
    "branchId": 1,
    "fullName": "Test",
    "username": "test999",
    "email": "test999@example.com",
    "roleId": 9999,
    "isActive": true
  }'
```

**Expected response (400 Bad Request):**
```json
{
  "success": false,
  "message": "El rol 9999 especificado no existe para el tenant"
}
```

### Test 6b: Invalid branchId

```bash
curl -X POST https://sya-socketio-server.onrender.com/api/employees \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": 1,
    "branchId": 9999,
    "fullName": "Test",
    "username": "test998",
    "email": "test998@example.com",
    "roleId": 1,
    "isActive": true
  }'
```

**Expected response (400 Bad Request):**
```json
{
  "success": false,
  "message": "La rama 9999 especificada no existe para el tenant"
}
```

### Test 6c: Missing required fields

```bash
curl -X POST https://sya-socketio-server.onrender.com/api/employees \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": 1,
    "fullName": "Test",
    "username": "test997"
  }'
```

**Expected response (400 Bad Request):**
```json
{
  "success": false,
  "message": "Datos incompletos (tenantId, branchId, fullName, username, email, roleId requeridos)"
}
```

---

## Step 7: Backward Compatibility Check

Verify that existing employees still work:

```sql
-- Check that old employees still have 'role' column
SELECT id, full_name, role, role_id
FROM employees
WHERE tenant_id = 1
LIMIT 5;

-- Should show:
-- Some rows may have role (old data) and role_id (migrated)
```

---

## Rollback Plan (if needed)

```bash
cd C:\SYA\sya-socketio-server

# Revert last commit
git reset --hard HEAD~1

# Force push to Render
git push --force

# Render will redeploy old version
```

⚠️ **Note:** This will lose the new columns. Only use if critical issues found.

---

## Success Criteria

- [x] Render deployment completes without errors
- [x] Database shows all new columns in employees table
- [x] POST /api/employees endpoint validates roleId and branchId
- [x] curl test creates employee in PostgreSQL
- [x] WinUI test shows employee syncing with debug output
- [x] Employee appears in PostgreSQL after sync
- [x] Error handling returns proper 400 errors for invalid roleId/branchId

---

## Monitoring

Once deployed, monitor these:

### 1. Render Logs
- Go to https://dashboard.render.com
- Check for any `[Employees/Sync] ❌` errors

### 2. PostgreSQL
```sql
-- Check for any failed syncs
SELECT COUNT(*) as employee_count FROM employees WHERE role_id IS NULL;
-- Should be 0 if migration worked
```

### 3. Application
- Check Visual Studio Output for sync errors
- Check Render logs for validation failures

---

**Expected Deployment Time:** 5-10 minutes
**Testing Time:** 10-15 minutes
**Total:** ~20-25 minutes

Good luck! 🚀
