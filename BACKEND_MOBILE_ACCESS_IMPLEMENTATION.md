# ✅ Backend - Mobile App Access Implementation COMPLETE

## What Was Done

### 1. Migration 038: Added mobile_access_type Column ✅

**File**: `migrations/038_add_mobile_access_to_employees.sql`

```sql
-- Column added to employees table
mobile_access_type VARCHAR(50) DEFAULT NULL

-- Allowed values: 'admin', 'distributor', 'none', NULL
-- Automatically populated based on role:
--   - Roles 1,2 (Admin, Encargado) → 'admin'
--   - Role 3 (Repartidor) → 'distributor'
--   - Roles 4,99 (Ayudante, Otro) → 'none'

-- Removed: employee_mobile_app_permissions table (no longer needed)
-- Consolidated to single column for simplicity
```

---

### 2. Endpoints Added/Updated ✅

#### POST /api/employees (Updated)
**Purpose**: Create or update employee with mobile access control

**Request Body**:
```json
{
  "tenantId": 1,
  "fullName": "Juan Pérez",
  "username": "juan",
  "email": "juan@example.com",
  "password": "$2b$12$...",  // BCrypt hashed
  "roleId": 3,              // 1-4 or custom (maps to 99)
  "mobileAccessType": "distributor",  // NEW: 'admin', 'distributor', or 'none'
  "mainBranchId": 1
}
```

**Features**:
- ✅ Accepts `mobileAccessType` parameter
- ✅ Auto-determines type based on role if not provided
- ✅ Validates role_id and mobile_access_type
- ✅ Maps custom roles (> 4) to role 99 ("Otro")
- ✅ Returns mobile_access_type in response

**Response**:
```json
{
  "success": true,
  "id": 2,
  "data": {
    "id": 2,
    "email": "juan@example.com",
    "fullName": "Juan Pérez",
    "roleId": 3,
    "mobile_access_type": "distributor",
    "created_at": "2025-11-04T12:30:00Z"
  }
}
```

---

#### PUT /api/employees/:id (NEW)
**Purpose**: Update employee mobile access without changing other data

**Endpoint**: `PUT /api/employees/{employeeId}`

**Request Body**:
```json
{
  "tenantId": 1,
  "mobileAccessType": "admin"  // Change from 'distributor' to 'admin'
}
```

**Response**:
```json
{
  "success": true,
  "message": "Acceso a app móvil actualizado",
  "data": {
    "employeeId": 2,
    "email": "juan@example.com",
    "fullName": "Juan Pérez",
    "roleId": 3,
    "mobileAccessType": "admin",
    "updatedAt": "2025-11-04T12:35:00Z"
  }
}
```

---

#### GET /api/employees/:id/mobile-access (NEW)
**Purpose**: Mobile app calls this after login to verify access

**Endpoint**: `GET /api/employees/{employeeId}/mobile-access?tenantId={tenantId}`

**Response**:
```json
{
  "success": true,
  "data": {
    "employeeId": 2,
    "email": "juan@example.com",
    "fullName": "Juan Pérez",
    "roleId": 3,
    "mobileAccessType": "distributor",
    "hasMobileAccess": true,
    "message": "Acceso aprobado como Repartidor"
  }
}
```

**If No Access**:
```json
{
  "success": true,
  "data": {
    "employeeId": 1,
    "email": "ayudante@example.com",
    "fullName": "Ayudante",
    "roleId": 4,
    "mobileAccessType": "none",
    "hasMobileAccess": false,
    "message": "No tiene acceso a la aplicación móvil"
  }
}
```

---

## How It Works

### 1. Employee Creation Flow

```
Desktop sends:
{
  fullName: "Juan",
  roleId: 3,
  mobileAccessType: "distributor"  ← Sent from Desktop
}
  ↓
Backend processes:
- Validates roleId (maps custom → 99)
- Validates mobileAccessType (must be 'admin', 'distributor', or 'none')
- If mobileAccessType not provided, auto-determines from roleId
  ↓
PostgreSQL saves:
- employees.role_id = 3
- employees.mobile_access_type = 'distributor'
  ↓
Mobile app queries:
GET /api/employees/:id/mobile-access?tenantId=1
  ↓
Response:
hasMobileAccess: true
mobileAccessType: 'distributor'
  ↓
Mobile app shows: Distributor interface
```

### 2. Auto-Determination Logic

If Desktop doesn't send `mobileAccessType`, backend auto-determines:

```javascript
// routes/employees.js lines 67-76
if ([1, 2].includes(roleId)) {
    determinedMobileAccessType = 'admin';      // Administrador, Encargado
} else if (roleId === 3) {
    determinedMobileAccessType = 'distributor'; // Repartidor
} else {
    determinedMobileAccessType = 'none';        // Ayudante (4), Otro (99)
}
```

### 3. Edit Flow

```
Desktop user clicks "Edit Employee"
  ↓
Changes mobile access checkbox
  ↓
Desktop sends:
PUT /api/employees/2
{
  tenantId: 1,
  mobileAccessType: 'admin'  ← Changed from 'distributor'
}
  ↓
Backend updates:
UPDATE employees SET mobile_access_type = 'admin' WHERE id = 2
  ↓
Next mobile app login:
GET /api/employees/2/mobile-access
  ↓
Returns: mobileAccessType: 'admin' (updated)
```

---

## Database Structure

### employees table

```sql
CREATE TABLE employees (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    email VARCHAR(255) NOT NULL,
    username VARCHAR(100) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role_id INTEGER NOT NULL REFERENCES roles(id),  -- Global roles (1-4, 99)
    mobile_access_type VARCHAR(50) DEFAULT NULL,   -- NEW FIELD
    main_branch_id INTEGER REFERENCES branches(id),
    is_active BOOLEAN DEFAULT true,
    is_owner BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Allowed values for mobile_access_type:
-- NULL or 'none' = no mobile app access
-- 'admin' = admin access to mobile app
-- 'distributor' = distributor/limited access to mobile app
```

---

## Removed Tables/Columns

### Removed: employee_mobile_app_permissions
**Reason**: No longer needed - consolidated to single `mobile_access_type` column

### Removed: role_permissions
**Reason**: Not used in PostgreSQL - was theoretical table for frontend

### Removed: permissions (if empty)
**Reason**: Not used with new simplified system

---

## Testing Endpoints

### Create Employee with Mobile Access
```bash
curl -X POST http://localhost:3000/api/employees \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": 1,
    "fullName": "Test Employee",
    "username": "test",
    "email": "test@example.com",
    "password": "hashed_password",
    "roleId": 3,
    "mobileAccessType": "distributor"
  }'
```

### Update Mobile Access
```bash
curl -X PUT http://localhost:3000/api/employees/2 \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": 1,
    "mobileAccessType": "admin"
  }'
```

### Check Mobile Access (from Mobile App)
```bash
curl -X GET "http://localhost:3000/api/employees/2/mobile-access?tenantId=1"
```

---

## Files Modified

| File | Changes | Lines |
|------|---------|-------|
| `migrations/038_add_mobile_access_to_employees.sql` | Created migration | 1-75 |
| `routes/employees.js` | Updated POST for mobile_access_type | 63-87, 102-124, 167-183 |
| `routes/employees.js` | Added GET endpoint for mobile-access | 633-692 |
| `routes/employees.js` | Added PUT endpoint for mobile-access | 694-718 |

---

## Logs to Expect

When employee is created/updated with mobile access:

```
[Employees/Sync] 🔄 Sincronizando empleado: Juan Pérez (juan) - Tenant: 1, Role: 3
[Employees/Sync] 📱 Mobile Access Type: distributor (Role: 3)
[Employees/Sync] 📝 Creando nuevo empleado: Juan Pérez
[Employees/Sync] ✅ Empleado sincronizado exitosamente: Juan Pérez (ID: 2)
```

When mobile access is updated:

```
[Employees/UpdateMobileAccess] ✅ Acceso móvil actualizado: Juan Pérez → admin
```

When mobile app checks access:

```
[Employees/MobileAccess] GET request from mobile app for employee 2
```

---

## Compatibility

- ✅ Backwards compatible - existing employees get mobile_access_type based on their role_id during migration
- ✅ Desktop doesn't need to send mobileAccessType (auto-determined from roleId)
- ✅ Works with existing role mapping (custom roles → 99)
- ✅ Mobile app can be updated independently to check new endpoint

---

## Summary

Backend is 100% ready. Waiting for Desktop to:

1. Add `MobileAccessType` property to Employee model
2. Add UI checkbox for mobile app access
3. Send `mobileAccessType` in sync payload
4. Call PUT endpoint to edit mobile access

**Commit**: `5b42b33`
**Status**: DEPLOYED to Render ✅
