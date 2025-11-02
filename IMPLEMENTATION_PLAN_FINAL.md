# 🎯 PLAN DE IMPLEMENTACIÓN FINAL - Employee Sync + Roles + Permissions

## Contexto del Negocio

**3 Aplicaciones que deben sincronizarse:**
1. **Desktop (WinUI)** - C#: Punto de venta, gestión de repartidores
2. **Backend (Render)** - Node.js/PostgreSQL: API central
3. **Mobile (Flutter)** - App para repartidores

**Flujo de negocio:**
- Owner/Gerente crea empleado en Desktop
- Asigna rol (Owner o Repartidor)
- Asigna kilos al repartidor
- Repartidor inicia sesión en Mobile
- Ve su dashboard con kilos asignados
- Registra gastos (se sincronizan a Desktop)
- Al final del turno, hace corte (se sincroniza a Backend)

---

## FASE 1: Backend (PostgreSQL + Node.js)

### 1.1 Migraciones de BD

**Crear Migration 028:**

```sql
-- Step 1: Crear tabla de Roles
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    is_system BOOLEAN DEFAULT false,  -- true para Owner/Repartidor
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, name)
);

-- Step 2: Crear tabla de Permisos
CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    category VARCHAR(50),  -- 'sales', 'deliveries', 'inventory', 'admin'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 3: Crear tabla de RolePermissions
CREATE TABLE IF NOT EXISTS role_permissions (
    id SERIAL PRIMARY KEY,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(role_id, permission_id)
);

-- Step 4: Actualizar tabla employees
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE RESTRICT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMP;

-- Step 5: Insertar permisos estándar
INSERT INTO permissions (code, name, description, category) VALUES
    -- Sales permissions
    ('VIEW_ALL_SALES', 'Ver todas las ventas', 'Puede ver todas las ventas del negocio', 'sales'),
    ('VIEW_OWN_SALES', 'Ver sus propias ventas', 'Solo ve las ventas que registró', 'sales'),
    ('CREATE_SALE', 'Crear venta', 'Puede registrar nuevas ventas', 'sales'),
    ('EDIT_SALE', 'Editar venta', 'Puede modificar ventas existentes', 'sales'),

    -- Delivery permissions
    ('VIEW_ALL_DELIVERIES', 'Ver todos los repartos', 'Puede ver todos los repartos', 'deliveries'),
    ('VIEW_OWN_DELIVERIES', 'Ver sus repartos', 'Solo ve los repartos asignados', 'deliveries'),
    ('UPDATE_DELIVERY_STATUS', 'Actualizar estado de reparto', 'Puede cambiar estado (pendiente, en ruta, entregado)', 'deliveries'),
    ('ASSIGN_DELIVERIES', 'Asignar repartos', 'Puede asignar repartos a repartidores', 'deliveries'),

    -- Expense permissions
    ('VIEW_ALL_EXPENSES', 'Ver todos los gastos', 'Puede ver todos los gastos', 'sales'),
    ('CREATE_EXPENSE', 'Crear gasto', 'Puede registrar nuevos gastos', 'sales'),
    ('VIEW_OWN_EXPENSES', 'Ver sus gastos', 'Solo ve sus gastos personales', 'sales'),

    -- Inventory permissions
    ('VIEW_INVENTORY', 'Ver inventario', 'Acceso al módulo de inventario', 'inventory'),
    ('EDIT_INVENTORY', 'Editar inventario', 'Puede modificar cantidades de inventario', 'inventory'),

    -- Admin permissions
    ('MANAGE_EMPLOYEES', 'Gestionar empleados', 'Crear, editar, eliminar empleados', 'admin'),
    ('VIEW_REPORTS', 'Ver reportes', 'Acceso a reportes y analytics', 'admin'),
    ('MANAGE_ROLES', 'Gestionar roles', 'Crear y modificar roles y permisos', 'admin')
ON CONFLICT DO NOTHING;

-- Step 6: Insertar roles estándar
INSERT INTO roles (tenant_id, name, description, is_system) VALUES
    ((SELECT id FROM tenants LIMIT 1), 'Owner', 'Propietario con acceso total', true),
    ((SELECT id FROM tenants LIMIT 1), 'Repartidor', 'Repartidor con acceso limitado', true)
ON CONFLICT DO NOTHING;

-- Step 7: Asignar permisos a roles
-- Owner: todos los permisos
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'Owner' AND r.is_system = true
ON CONFLICT DO NOTHING;

-- Repartidor: permisos limitados
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'Repartidor' AND r.is_system = true
AND p.code IN ('VIEW_OWN_SALES', 'VIEW_OWN_DELIVERIES', 'UPDATE_DELIVERY_STATUS', 'CREATE_EXPENSE', 'VIEW_OWN_EXPENSES')
ON CONFLICT DO NOTHING;

-- Step 8: Crear índices
CREATE INDEX IF NOT EXISTS idx_employees_role_id ON employees(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_permissions_code ON permissions(code);
```

### 1.2 Endpoints

#### POST /api/employees - Crear/Sincronizar empleado

```javascript
{
  "tenantId": 6,
  "branchId": 17,
  "fullName": "Juan Pérez",
  "username": "jperez",
  "email": "juan@example.com",
  "password": "$2b$12$...",  // BCrypt hasheada desde C#
  "roleId": 2,               // ID del rol
  "isActive": true
}

// Response:
{
  "success": true,
  "employeeId": 123,
  "remoteId": 123,
  "role": {
    "id": 2,
    "name": "Repartidor",
    "permissions": ["VIEW_OWN_SALES", "VIEW_OWN_DELIVERIES", "UPDATE_DELIVERY_STATUS", "CREATE_EXPENSE", "VIEW_OWN_EXPENSES"]
  }
}
```

#### POST /api/employees/{id}/password - Sincronizar cambio de contraseña

```javascript
{
  "tenantId": 6,
  "oldPasswordHash": "hash_anterior",
  "newPasswordHash": "hash_nuevo"
}

// Response:
{
  "success": true,
  "passwordSynced": true
}
```

#### GET /api/employees/{id} - Obtener empleado con permisos

```javascript
// Response:
{
  "success": true,
  "data": {
    "id": 123,
    "fullName": "Juan Pérez",
    "email": "juan@example.com",
    "role": {
      "id": 2,
      "name": "Repartidor",
      "permissions": [...]
    },
    "branchId": 17
  }
}
```

#### GET /api/roles - Listar roles disponibles

```javascript
// Response:
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Owner",
      "permissions": [/* todos */],
      "description": "Propietario con acceso total"
    },
    {
      "id": 2,
      "name": "Repartidor",
      "permissions": [/* limitados */],
      "description": "Repartidor con acceso limitado"
    }
  ]
}
```

---

## FASE 2: Desktop (C# WinUI)

### 2.1 Cambios en Models

**Employee.cs:**
```csharp
public class Employee
{
    public string PasswordHash { get; set; }      // Hasheada con BCrypt
    public DateTime? PasswordUpdatedAt { get; set; }
    public bool PasswordNeedsSync { get; set; }    // Marcar cambios
    public int RoleId { get; set; }                // ID del rol
    [Ignore] public Role Role { get; set; }        // Info del rol
    [Ignore] public List<string> Permissions { get; set; }  // Permisos del rol
}
```

**Role.cs:**
```csharp
public class Role
{
    [PrimaryKey, AutoIncrement]
    public int Id { get; set; }

    [NotNull]
    public int RemoteId { get; set; }  // ID en PostgreSQL

    [NotNull, Unique]
    public string Name { get; set; }

    public string Description { get; set; }

    [Ignore]
    public List<string> Permissions { get; set; }
}
```

### 2.2 Cambios en EmployeeService

**AddFullEmployeeAsync:**
```csharp
public async Task<bool> AddFullEmployeeAsync(Employee employee, string plainPassword, Role selectedRole)
{
    // Hash password con BCrypt
    var hashedPassword = BCrypt.Net.BCrypt.HashPassword(plainPassword, workFactor: 12);

    employee.PasswordHash = hashedPassword;
    employee.RoleId = selectedRole.RemoteId;  // Usar RemoteId
    employee.PasswordNeedsSync = true;

    // Guardar en SQLite
    connection.Insert(employee);

    return true;
}
```

### 2.3 Cambios en UnifiedSyncService

**SyncEmployeeInternalAsync:**
```csharp
private async Task<bool> SyncEmployeeInternalAsync(Employee employee)
{
    var payload = new
    {
        tenantId = syncConfig.TenantId,
        branchId = syncConfig.BranchId,
        fullName = employee.FullName,
        username = employee.Username,
        email = employee.Email,
        password = employee.PasswordHash,        // ← Hasheada
        roleId = employee.RoleId,                // ← ID del rol
        isActive = employee.IsActive
    };

    var response = await _httpClient.PostAsync("/api/employees", content);

    if (response.IsSuccessStatusCode)
    {
        var responseContent = await response.Content.ReadAsStringAsync();
        var result = JsonDocument.Parse(responseContent);
        var root = result.RootElement;

        // Guardar información del rol
        if (root.TryGetProperty("role", out var roleProp))
        {
            if (roleProp.TryGetProperty("permissions", out var permissionsProp))
            {
                var permissions = new List<string>();
                foreach (var perm in permissionsProp.EnumerateArray())
                {
                    permissions.Add(perm.GetString());
                }
                employee.Permissions = permissions;
            }
        }

        employee.Synced = true;
        employee.SyncedAt = DateTime.Now;
        employee.PasswordNeedsSync = false;

        await connection.UpdateAsync(employee);
        return true;
    }

    return false;
}

// Nuevo método para sincronizar cambio de password
private async Task<bool> SyncPasswordChangeAsync(Employee employee)
{
    var oldPassword = await connection.ExecuteScalarAsync<string>(
        "SELECT PasswordHash FROM employees WHERE Id = ?", employee.Id
    );

    var payload = new
    {
        tenantId = syncConfig.TenantId,
        oldPasswordHash = oldPassword,
        newPasswordHash = employee.PasswordHash
    };

    var response = await _httpClient.PostAsync($"/api/employees/{employee.RemoteId}/password", content);

    if (response.IsSuccessStatusCode)
    {
        employee.PasswordNeedsSync = false;
        employee.PasswordUpdatedAt = DateTime.Now;
        await connection.UpdateAsync(employee);
        return true;
    }

    return false;
}
```

---

## FASE 3: Mobile (Flutter)

### 3.1 Estructura para Repartidor Dashboard

**Pantallas necesarias:**

1. **Login** (ya existe probablemente)
   - Valida email/password contra Desktop local
   - Sincroniza con Backend (Render)
   - Obtiene permisos del usuario

2. **Dashboard Repartidor** (NUEVA)
   - Título: "Hola, {nombre}"
   - Card con kilos asignados (info sincronizada desde Desktop)
   - Botón: "Ver mis repartos"
   - Botón: "Registrar gasto"
   - Card con resumen de gastos del día

3. **Mis Repartos** (NUEVA)
   - Lista de repartos asignados
   - Estado: Pendiente, En ruta, Entregado
   - Botón para actualizar estado
   - Mapa con ubicación actual (si está activo en turno)

4. **Registrar Gasto** (NUEVA)
   - Formulario: Descripción, Monto, Categoría
   - Guarda en local first
   - Sincroniza a Desktop en background

5. **Corte de Caja** (NUEVA)
   - Resumen del día
   - Total de kilos
   - Total de gastos
   - Botón: "Enviar corte"
   - Se sincroniza a Desktop/Backend

### 3.2 API Endpoints necesarios en Backend

```
GET /api/employees/{id}/assigned-deliveries
GET /api/employees/{id}/expenses
POST /api/employees/{id}/expenses
POST /api/employees/{id}/daily-cut
GET /api/employees/{id}/location-history
```

---

## FASE 4: Sincronización Entre Sistemas

### Flujo: Repartidor registra gasto en Mobile

```
Mobile (Flutter)
    │
    ├─> Registra gasto localmente
    │   (app de flutter tiene SQLite local)
    │
    └─> POST /api/employees/{id}/expenses
        {
          "description": "Combustible",
          "amount": 50.00,
          "category": "fuel",
          "date": "2024-11-01"
        }
        │
        └─> Backend
            ├─> Guarda en expenses table
            ├─> Retorna { success: true, id: 456 }
            │
            └─> Response a Mobile
                │
                └─> Mobile sincroniza a Desktop vía Socket.IO
                    (si está disponible)
                    │
                    └─> Desktop (C#)
                        ├─> Recibe gasto del repartidor
                        ├─> Actualiza en vista de corte
                        └─> Marca para sincronización reversa
```

---

## Resumen de Cambios por Sistema

### Desktop (C#)
- [x] Hash password con BCrypt
- [ ] Actualizar Employee model con PasswordHash, RoleId, Permissions
- [ ] Actualizar AddFullEmployeeAsync para enviar password hasheada
- [ ] Agregar método SyncPasswordChangeAsync
- [ ] UI: Mostrar rol del empleado
- [ ] UI: Mostrar permisos del empleado

### Backend (Node.js)
- [ ] Crear migraciones: roles, permissions, role_permissions
- [ ] Crear seeds con roles Owner/Repartidor y permisos
- [ ] Endpoint POST /api/employees con validación de password
- [ ] Endpoint POST /api/employees/{id}/password
- [ ] Endpoint GET /api/roles
- [ ] Endpoint POST /api/employees/{id}/expenses
- [ ] Endpoint GET /api/employees/{id}/assigned-deliveries

### Mobile (Flutter)
- [ ] Pantalla Dashboard para Repartidor
- [ ] Pantalla Mis Repartos
- [ ] Pantalla Registrar Gasto
- [ ] Pantalla Corte de Caja
- [ ] Sincronización con Backend

---

## Orden de Implementación Recomendado

**Semana 1:**
1. Crear migraciones en PostgreSQL
2. Crear endpoints en Backend
3. Actualizar Desktop C#

**Semana 2:**
4. Crear pantallas Mobile
5. Implementar sincronización

**Semana 3:**
6. Testing e3e2e
7. Ajustes y optimizaciones

---

**Este es el plan completo y realista para el sistema completo.**
