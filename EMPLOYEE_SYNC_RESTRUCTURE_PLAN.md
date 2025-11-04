# 📋 Plan de Reestructuración - Flujo de Empleados

## 🔴 PROBLEMA ACTUAL

### Lo que DEBERÍA pasar:
```
Desktop: Agregar nuevo empleado
    ↓ (nombre, email, contraseña, teléfono, rol)
    ↓
PostgreSQL: Guardar en employees (email, password_hash, role_id)
    ↓
PostgreSQL: Guardar en employee_branches (assign a sucursal actual)
    ↓
Mobile/Login: Acceder con email + contraseña
```

### Lo que REALMENTE pasa:
```
Desktop: Agregar nuevo empleado
    ↓
PostgreSQL: ??? (vacío, nada, o datos incompletos)
    ↓
❌ Error al hacer login en mobile
❌ Sin relaciones con branches
❌ Sin email/contraseña guardados
```

---

## 📊 FASE 1: AUDITORÍA - Verificar Estado Real

### 1.1 Estructura Actual de Tablas

Necesitamos ejecutar en PostgreSQL:

```sql
-- ═════════════════════════════════════════════════════════════════════════
-- AUDITORÍA 1: ¿Existen las tablas?
-- ═════════════════════════════════════════════════════════════════════════

-- Listar TODAS las tablas
\dt

-- Verificar estructura de employees
\d employees

-- Verificar estructura de employee_branches
\d employee_branches

-- Verificar estructura de roles
\d roles

-- Verificar estructura de branches
\d branches

-- ═════════════════════════════════════════════════════════════════════════
-- AUDITORÍA 2: ¿Qué datos hay realmente?
-- ═════════════════════════════════════════════════════════════════════════

-- Cuántos registros en cada tabla
SELECT 'tenants' as table_name, COUNT(*) as count FROM tenants
UNION ALL
SELECT 'employees', COUNT(*) FROM employees
UNION ALL
SELECT 'employee_branches', COUNT(*) FROM employee_branches
UNION ALL
SELECT 'branches', COUNT(*) FROM branches
UNION ALL
SELECT 'roles', COUNT(*) FROM roles;

-- Mostrar TODOS los empleados (estructura y datos)
SELECT
    id, tenant_id, email, username, full_name,
    role_id, password_hash, main_branch_id, is_active
FROM employees
LIMIT 20;

-- Mostrar relaciones employee_branches
SELECT
    id, tenant_id, employee_id, branch_id, is_active, removed_at
FROM employee_branches
LIMIT 20;

-- Verificar que roles existan
SELECT id, name FROM roles ORDER BY id;

-- ═════════════════════════════════════════════════════════════════════════
-- AUDITORÍA 3: ¿Hay datos inconsistentes?
-- ═════════════════════════════════════════════════════════════════════════

-- Empleados sin role_id válido
SELECT e.id, e.email, e.role_id
FROM employees e
LEFT JOIN roles r ON e.role_id = r.id
WHERE r.id IS NULL;

-- Empleados sin email
SELECT id, username, full_name
FROM employees
WHERE email IS NULL OR email = '';

-- Empleados sin password_hash
SELECT id, username, email
FROM employees
WHERE password_hash IS NULL OR password_hash = '';

-- Employee_branches sin employees válidos
SELECT eb.id, eb.employee_id, eb.branch_id
FROM employee_branches eb
LEFT JOIN employees e ON eb.employee_id = e.id
WHERE e.id IS NULL;

-- Employee_branches sin branches válidas
SELECT eb.id, eb.employee_id, eb.branch_id
FROM employee_branches eb
LEFT JOIN branches b ON eb.branch_id = b.id
WHERE b.id IS NULL;
```

### 1.2 Flujo de Sync - ¿Qué se envía desde Desktop?

En Desktop, buscar logs cuando se agrega un empleado:

```csharp
// En Visual Studio Output, buscar:
[Employees/Sync] 🔄 Sincronizando empleado: {nombre}
[Employees/Sync] 📝 POST payload...
[Employees/Sync] ✅ Sincronizado exitoso OR ❌ Error

// Qué debería ver:
// 1. Payload enviado con email y password
// 2. Response con id (RemoteId)
// 3. Status 200 OK
```

En Backend, revisar logs de Render:

```javascript
// En Render logs, buscar:
[Employees/Sync] 🔄 Sincronizando empleado
[Employees/Sync] 📝 Creando nuevo empleado
[Employees/Sync] ✅ Empleado creado OR ❌ Error

// Qué podría estar fallando:
// 1. ❌ Error: insert or update on table "employees" violates foreign key constraint "employees_tenant_id_fkey"
//    → Tenant no existe en PostgreSQL
// 2. ❌ Error: column "..." does not exist
//    → Campo no existe en tabla (schema mismatch)
// 3. ❌ Error: null value in column "..." violates not-null constraint
//    → Falta un campo requerido (email, password_hash, role_id)
// 4. ❌ Silencio total - no hay logs
//    → Endpoint no existe o no está siendo llamado
```

---

## 🎯 FASE 2: PLAN DE REESTRUCTURACIÓN

### 2.1 Simplificación de Tablas

#### MANTENER (actuales y funcionales):
```
✅ tenants - Información de negocio
✅ roles - Roles globales (1,2,3,4,99)
✅ branches - Sucursales del negocio
✅ employees - Datos de empleados
✅ employee_branches - Relación empleado ↔ sucursal
```

#### ELIMINAR (innecesarias):
```
❌ role_permissions - No se usa en PostgreSQL (es para frontend)
❌ employee_mobile_app_permissions - Puede simplificarse a columna en employees
❌ permissions - Tabla teórica que no se usa
```

**Motivo**: Simplificar la BD significa menos tablas, menos FKs, menos bugs.

### 2.2 Estructura Mejorada de `employees`

```sql
CREATE TABLE employees (
    -- PRIMARY KEY
    id SERIAL PRIMARY KEY,

    -- TENANT (Scoping)
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- IDENTIFICACIÓN PERSONAL
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,                -- ✅ OBLIGATORIO para login
    phone VARCHAR(20),

    -- ACCESO Y AUTENTICACIÓN
    username VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,        -- ✅ BCrypt hasheado
    password_updated_at TIMESTAMP WITH TIME ZONE,

    -- ROLES Y PERMISOS
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,  -- GLOBAL ROLE
    can_use_mobile_app BOOLEAN DEFAULT false,   -- ✅ Simplificado

    -- SUCURSAL PRINCIPAL
    main_branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,

    -- ESTADO
    is_active BOOLEAN DEFAULT true,
    is_owner BOOLEAN DEFAULT false,

    -- AUTENTICACIÓN EXTERNA
    google_user_identifier VARCHAR(255),

    -- METADATOS
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- ÍNDICES Y CONSTRAINTS
    UNIQUE(tenant_id, email),
    UNIQUE(tenant_id, username),
    INDEX idx_employees_tenant_id (tenant_id),
    INDEX idx_employees_email (LOWER(email)),
    INDEX idx_employees_is_active (is_active)
);
```

**Cambios**:
- ✅ `email` es OBLIGATORIO (NOT NULL)
- ✅ `password_hash` es OBLIGATORIO
- ✅ Agregar `phone`
- ✅ `can_use_mobile_app` es BOOLEAN simple (no tabla separada)

### 2.3 Estructura de `employee_branches` (sin cambios)

```sql
CREATE TABLE employee_branches (
    id SERIAL PRIMARY KEY,

    -- SCOPING Y RELACIONES
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

    -- ESTADO
    is_active BOOLEAN DEFAULT true,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMP WITH TIME ZONE,          -- Soft delete

    -- TIMESTAMPS
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- CONSTRAINTS
    UNIQUE(tenant_id, employee_id, branch_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    FOREIGN KEY (employee_id) REFERENCES employees(id),
    FOREIGN KEY (branch_id) REFERENCES branches(id),

    -- ÍNDICES
    INDEX idx_emp_branch_tenant (tenant_id),
    INDEX idx_emp_branch_employee (employee_id),
    INDEX idx_emp_branch_branch (branch_id),
    INDEX idx_emp_branch_active (is_active, removed_at)
);
```

**Cambios**: Ninguno (estructura es correcta)

---

## 🔧 FASE 3: IDENTIFICAR PUNTOS DE FALLO

### 3.1 Checklist de Posibles Problemas

```
❌ ¿El endpoint POST /api/employees EXISTE?
   Ubicación: routes/employees.js

❌ ¿El endpoint RECIBE email y password_hash?
   Verificar: req.body.email, req.body.password_hash

❌ ¿El endpoint VALIDA que email sea obligatorio?
   Verificar: if (!email) { return error }

❌ ¿El endpoint hace INSERT en employees?
   Verificar: INSERT INTO employees (tenant_id, email, password_hash, ...)

❌ ¿El endpoint hace INSERT en employee_branches?
   Verificar: INSERT INTO employee_branches (employee_id, branch_id, ...)

❌ ¿Desktop envía email y password en el payload?
   Ubicación: UnifiedSyncService.cs
   Verificar: payload.email, payload.password

❌ ¿Desktop marca el empleado como Synced después?
   Verificar: employee.Synced = true; employee.SyncedAt = DateTime.Now;

❌ ¿Desktop asigna el branch correctamente?
   Verificar: employeeBranch.branch_id = session.BranchId;
```

---

## 📝 FASE 4: IMPLEMENTACIÓN DEL FIX

### 4.1 Crear Migration para Arreglar `employees`

```sql
-- Migration: 038_fix_employees_table_structure.sql

BEGIN;

-- 1. Hacer email obligatorio
ALTER TABLE employees
MODIFY COLUMN email VARCHAR(255) NOT NULL;

-- 2. Hacer password_hash obligatorio
ALTER TABLE employees
MODIFY COLUMN password_hash VARCHAR(255) NOT NULL;

-- 3. Agregar columna phone si no existe
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS phone VARCHAR(20);

-- 4. Agregar columna can_use_mobile_app (boolean)
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS can_use_mobile_app BOOLEAN DEFAULT false;

-- 5. Borrar tabla role_permissions si existe (no se usa)
DROP TABLE IF EXISTS role_permissions CASCADE;

-- 6. Borrar tabla employee_mobile_app_permissions si existe (simplificada)
DROP TABLE IF EXISTS employee_mobile_app_permissions CASCADE;

-- 7. Borrar tabla permissions si está vacía
DROP TABLE IF EXISTS permissions CASCADE;

-- 8. Verificar integridad
SELECT
    'Validación de employees' as check_name,
    COUNT(*) as total,
    COUNT(CASE WHEN email IS NULL THEN 1 END) as missing_email,
    COUNT(CASE WHEN password_hash IS NULL THEN 1 END) as missing_password
FROM employees;

COMMIT;
```

### 4.2 Arreglar Endpoint Backend (POST /api/employees)

**Ubicación**: `routes/employees.js`

**Cambios necesarios**:

```javascript
// 1. VALIDAR que email y password_hash existan
if (!email) {
    return res.status(400).json({ error: 'email is required' });
}
if (!password_hash) {
    return res.status(400).json({ error: 'password_hash is required' });
}

// 2. VALIDAR que role_id sea válido
if (![1, 2, 3, 4, 99].includes(roleId)) {
    return res.status(400).json({ error: 'invalid role_id' });
}

// 3. CREAR en employees
INSERT INTO employees (
    tenant_id, email, username, full_name, password_hash,
    role_id, main_branch_id, phone, is_active
)
VALUES (
    tenantId, email, username, fullName, passwordHash,
    roleId, mainBranchId, phone, true
)

// 4. CREAR en employee_branches (asignar a sucursal actual)
INSERT INTO employee_branches (
    tenant_id, employee_id, branch_id, is_active, assigned_at
)
VALUES (
    tenantId, employeeId, branchId, true, NOW()
)

// 5. ASIGNAR permisos de app móvil (usando can_use_mobile_app)
UPDATE employees
SET can_use_mobile_app = (roleId != 4)  -- Todos EXCEPTO Ayudante
WHERE id = employeeId
```

### 4.3 Arreglar Desktop (UnifiedSyncService.cs)

**Verificar que se envíe**:

```csharp
// SyncEmployeesAsync() debe enviar:
var payload = new {
    tenantId = syncConfig.Value.tenantId,
    branchId = syncConfig.Value.branchId,
    email = employee.Email,              // ✅ OBLIGATORIO
    username = employee.Username,
    fullName = employee.FullName,
    phone = employee.PhoneNumber,        // Opcional
    roleId = employee.RoleId,            // 1, 2, 3, 4, o 99
    password = employee.Password,        // ✅ OBLIGATORIO (será hasheado en backend)
    canUseMobileApp = (employee.RoleId != 4),  // Todos excepto Ayudante
    mainBranchId = employee.MainBranchId
};
```

### 4.4 Flujo Completo Arreglado

```
DESKTOP:
1. Usuario agrega empleado: Nombre="Juan", Email="juan@example.com", Pass="Abc123", Rol=3
2. Desktop valida: ✅ Email existe, ✅ Contraseña válida, ✅ Rol válido
3. Desktop calcula: passwordHash = bcrypt("Abc123", 12)
4. Desktop crea en SQLite: Employee { Email="juan@example.com", PasswordHash="$2b$...", RoleId=3, Synced=false }
5. Desktop envía POST /api/employees:
   {
     tenantId: 1,
     branchId: 1,
     email: "juan@example.com",
     password: "Abc123",              ← El hash se calcula en backend
     roleId: 3,
     fullName: "Juan Pérez"
   }

BACKEND:
6. Valida: ✅ email, ✅ password, ✅ roleId, ✅ tenantId existe
7. Hashea password: passwordHash = bcrypt("Abc123", 10)
8. INSERT en employees:
   INSERT INTO employees (tenant_id, email, username, full_name, password_hash, role_id, main_branch_id, can_use_mobile_app)
   VALUES (1, "juan@example.com", "juan", "Juan Pérez", "$2b$...", 3, 1, true)
9. INSERT en employee_branches:
   INSERT INTO employee_branches (tenant_id, employee_id, branch_id, is_active, assigned_at)
   VALUES (1, 2, 1, true, NOW())
10. Retorna: { id: 2, email: "juan@example.com", role_id: 3, ... }

POSTGRESQL (resultado):
employees: { id: 2, email: "juan@example.com", password_hash: "$2b$...", role_id: 3, ... }
employee_branches: { employee_id: 2, branch_id: 1, is_active: true, ... }

MOBILE LOGIN:
11. Usuario intenta login: email="juan@example.com", password="Abc123"
12. Backend: SELECT * FROM employees WHERE email='juan@example.com' AND is_active=true
13. Backend: bcrypt.compare("Abc123", "$2b$...") → ✅ TRUE
14. Backend: SELECT can_use_mobile_app FROM employees WHERE id=2 → true
15. Backend: ✅ Login exitoso
```

---

## 📋 CHECKLIST DE VALIDACIÓN

### Pre-Implementation
- [ ] Auditar PostgreSQL con queries de Auditoría 1-3
- [ ] Revisar logs de Render para ver errores exactos
- [ ] Revisar logs de Desktop para ver qué se envía
- [ ] Identificar cuál es el EXACTO punto de fallo

### Implementation
- [ ] Crear migration 038 para arreglar schema
- [ ] Actualizar endpoint POST /api/employees
- [ ] Validar que Desktop envíe email y password
- [ ] Pruebas en Render

### Post-Implementation
- [ ] Agregar nuevo empleado en Desktop
- [ ] Verificar que se cree en PostgreSQL
- [ ] Verificar email y password_hash en BD
- [ ] Verificar relación en employee_branches
- [ ] Hacer login en mobile app
- [ ] Verificar que funcione

---

## 🚨 PRÓXIMOS PASOS

1. **TÚ (Saul)**: Ejecuta los queries de Auditoría en PostgreSQL
2. **TÚ (Saul)**: Revisor logs de Render y Desktop
3. **YO (Claude)**: Basado en lo anterior, crear migration específica
4. **YO (Claude)**: Arreglar endpoint backend
5. **JUNTOS**: Probar el flujo completo

**¿Cuál es el estado actual? Ejecuta la auditoría primero.**
