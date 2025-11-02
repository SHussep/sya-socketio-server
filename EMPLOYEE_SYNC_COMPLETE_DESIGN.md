# 🏗️ Employee Sync - Diseño Completo y Correcto

## Problema Actual

El endpoint simple que creamos no maneja:
1. ❌ Password (lo dejamos vacío)
2. ❌ Roles dinámicos (debe venir del Desktop)
3. ❌ Sync de cambios de password
4. ❌ Permisos específicos por rol

## Solución Propuesta

### 1. Estructura de Tablas en PostgreSQL

```sql
-- Tabla de Roles
CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, name)
);

-- Tabla de Permisos
CREATE TABLE permissions (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255)
);

-- Tabla Junction: RolePermissions
CREATE TABLE role_permissions (
    id SERIAL PRIMARY KEY,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(role_id, permission_id)
);

-- Actualizar tabla employees
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMP;
```

### 2. Flujo de Creación de Empleado

```
Desktop (WinUI)
    │
    ├─> Valida datos locales (email, username, contraseña)
    ├─> Hashea contraseña con BCrypt
    ├─> Guarda en SQLite (Synced=false)
    │
    └─> POST /api/employees
        {
          "tenantId": 6,
          "branchId": 17,
          "fullName": "Juan Pérez",
          "username": "jperez",
          "email": "juan@example.com",
          "password": "Test1234!",           // ← IMPORTANTE: venir hasheada desde C#
          "roleId": 2,                       // ← ID del rol desde C#
          "isActive": true
        }
        │
        └─> Backend (Render/PostgreSQL)
            ├─> Valida que role_id existe
            ├─> Verifica email/username unique
            ├─> INSERT en employees con password_hash
            ├─> Retorna remoteId + role con permisos
            │
            └─> Response:
                {
                  "success": true,
                  "employeeId": 123,
                  "remoteId": 123,
                  "role": {
                    "id": 2,
                    "name": "Repartidor",
                    "permissions": ["VIEW_SALES", "VIEW_OWN_DELIVERIES"]
                  }
                }
        │
        └─> Desktop C#
            ├─> Recibe remoteId
            ├─> Recibe permisos del rol
            ├─> Marca empleado como Synced=true
            └─> Guarda permisos localmente para control de acceso
```

### 3. Flujo de Actualización de Password

```
Desktop (WinUI) - Usuario cambia su password
    │
    ├─> Valida password
    ├─> Hashea con BCrypt
    ├─> Guarda en SQLite (PasswordNeedsSynchinglazmente)
    │
    └─> POST /api/employees/{id}/password
        {
          "employeeId": 123,
          "oldPasswordHash": "hash_anterior",
          "newPasswordHash": "hash_nuevo",
          "tenantId": 6
        }
        │
        └─> Backend
            ├─> Verifica que oldPasswordHash coincida
            ├─> UPDATE employees SET password_hash = $1, password_updated_at = NOW()
            ├─> Retorna { success: true, passwordSynced: true }
            │
            └─> Si falla, retorna error
        │
        └─> Desktop C#
            ├─> Si success=true: marca como sincronizado
            ├─> Si falla: reintenta en próximo sync
            └─> Si falla 3 veces: notifica al usuario
```

### 4. Estructura de Tabla de Permisos

**Permisos predefinidos:**

| Código | Nombre | Descripción |
|--------|--------|-------------|
| `VIEW_ALL_SALES` | Ver todas las ventas | Puede ver todas las ventas |
| `VIEW_OWN_SALES` | Ver propias ventas | Solo ve sus ventas |
| `CREATE_SALE` | Crear venta | Puede registrar ventas |
| `VIEW_ALL_DELIVERIES` | Ver todos repartos | Puede ver todos |
| `VIEW_OWN_DELIVERIES` | Ver propios repartos | Solo los asignados |
| `UPDATE_DELIVERY_STATUS` | Actualizar estado | Puede cambiar estados |
| `VIEW_INVENTORY` | Ver inventario | Acceso a inventario |
| `MANAGE_EMPLOYEES` | Gestionar empleados | Solo Owner |

**Roles predefinidos:**

| Rol | Permisos |
|-----|----------|
| **Owner** | Todos los permisos |
| **Repartidor** | VIEW_OWN_SALES, VIEW_OWN_DELIVERIES, UPDATE_DELIVERY_STATUS |
| **Vendedor** | VIEW_ALL_SALES, CREATE_SALE, VIEW_OWN_DELIVERIES |
| **Gerente** | VIEW_ALL_* (excepto MANAGE_EMPLOYEES sin autenticación doble) |

### 5. Implementación en Backend (Node.js)

**POST /api/employees** - Crear/Actualizar empleado

```javascript
router.post('/', async (req, res) => {
    const { tenantId, branchId, fullName, username, email, password, roleId } = req.body;

    // 1. Validar campos requeridos
    if (!tenantId || !fullName || !username || !email || !password || !roleId) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // 2. Validar que role existe y tiene permisos
    const roleResult = await client.query(
        `SELECT r.*, array_agg(p.code) as permission_codes
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
         WHERE r.id = $1 AND r.tenant_id = $2
         GROUP BY r.id`,
        [roleId, tenantId]
    );

    if (roleResult.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'Role not found' });
    }

    // 3. Verificar si empleado existe
    const existing = await client.query(
        `SELECT id FROM employees
         WHERE (LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2))
         AND tenant_id = $3`,
        [email, username, tenantId]
    );

    if (existing.rows.length > 0) {
        // UPDATE password si cambió
        await client.query(
            `UPDATE employees
             SET password_hash = $1, password_updated_at = NOW(), updated_at = NOW()
             WHERE id = $2`,
            [password, existing.rows[0].id]
        );
    } else {
        // CREATE new employee
        await client.query(
            `INSERT INTO employees (tenant_id, branch_id, full_name, username, email, password_hash, role_id, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
            [tenantId, branchId, fullName, username, email, password, roleId]
        );
    }

    // 4. Retornar con permisos
    const role = roleResult.rows[0];
    return res.json({
        success: true,
        employeeId: employee.id,
        role: {
            id: role.id,
            name: role.name,
            permissions: role.permission_codes.filter(p => p != null)
        }
    });
});
```

**POST /api/employees/{id}/password** - Sincronizar cambio de password

```javascript
router.post('/:id/password', async (req, res) => {
    const { employeeId, oldPasswordHash, newPasswordHash, tenantId } = req.body;

    // 1. Verificar que la contraseña anterior coincide
    const result = await client.query(
        `SELECT password_hash FROM employees WHERE id = $1 AND tenant_id = $2`,
        [employeeId, tenantId]
    );

    if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    if (result.rows[0].password_hash !== oldPasswordHash) {
        return res.status(401).json({ success: false, message: 'Old password does not match' });
    }

    // 2. Actualizar con nueva contraseña
    await client.query(
        `UPDATE employees
         SET password_hash = $1, password_updated_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [newPasswordHash, employeeId]
    );

    return res.json({ success: true, passwordSynced: true });
});
```

### 6. Cambios Requeridos en C# (WinUI)

**En Employee.cs:**
```csharp
public class Employee
{
    public string PasswordHash { get; set; }
    public DateTime? PasswordUpdatedAt { get; set; }
    public bool PasswordNeedsSync { get; set; }
}
```

**En EmployeeService.cs - AddFullEmployeeAsync:**
```csharp
// Ya hash el password con BCrypt
var hashedPassword = BCrypt.Net.BCrypt.HashPassword(password, workFactor: 12);

var employee = new Employee
{
    // ... otros campos ...
    PasswordHash = hashedPassword,
    PasswordNeedsSync = true  // Marcar para sync inicial
};
```

**En UnifiedSyncService.cs - SyncEmployeeInternalAsync:**
```csharp
var payload = new
{
    tenantId = session.TenantId,
    branchId = session.BranchId,
    fullName = employee.FullName,
    username = employee.Username,
    email = employee.Email,
    password = employee.PasswordHash,  // ← Enviar hasheada
    roleId = employee.RoleId,
    isActive = employee.IsActive
};
```

**Nuevo método para sincronizar cambios de password:**
```csharp
private async Task<bool> SyncPasswordChangeAsync(Employee employee)
{
    var payload = new
    {
        employeeId = employee.RemoteId,
        oldPasswordHash = employee.PasswordHash,  // Valor anterior
        newPasswordHash = employee.PasswordHash,  // Valor nuevo
        tenantId = syncConfig.TenantId
    };

    var response = await _httpClient.PostAsync($"/api/employees/{employee.RemoteId}/password", content);

    if (response.IsSuccessStatusCode)
    {
        employee.PasswordNeedsSync = false;
        employee.PasswordUpdatedAt = DateTime.Now;
        return true;
    }

    return false;
}
```

## Ventajas de Este Diseño

✅ **Password segura:** Se hashea en cliente, se envía hasheada, se guarda hasheada
✅ **Roles dinámicos:** Vienen del Desktop, se validan en backend
✅ **Permisos granulares:** Cada rol tiene permisos específicos
✅ **Sync robusto:** El Desktop sabe qué cambios falta sincronizar
✅ **Control de acceso:** Desktop puede controlar menús/funciones basado en permisos

## Próximos Pasos

1. Crear migraciones en PostgreSQL
2. Actualizar endpoint POST /api/employees
3. Agregar endpoint POST /api/employees/{id}/password
4. Actualizar C# para enviar password hasheada
5. Implementar sync de cambios de password en UnifiedSyncService
6. Probar flujo completo

---

**Este es el diseño correcto y completo para manejo de empleados, roles y passwords.**
