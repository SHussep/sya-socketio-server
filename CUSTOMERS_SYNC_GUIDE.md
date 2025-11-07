# 📋 Guía de Sincronización de Clientes

## 🎯 Problema Resuelto

### **Antes:**
- ❌ Clientes NO se sincronizaban desde Desktop a PostgreSQL
- ❌ Desktop creaba clientes seed localmente
- ❌ Backend rechazaba ventas porque clientes no existían
- ❌ Cliente "Público en General" tenía ID fijo (conflictos entre tenants)

### **Ahora:**
- ✅ Clientes se sincronizan con idempotencia (`ON CONFLICT`)
- ✅ Cliente genérico se crea automáticamente por tenant
- ✅ Backend asigna cliente genérico si `id_cliente` es NULL o no existe
- ✅ Cliente genérico NO se puede borrar (trigger protegido)

---

## 🏗️ ARQUITECTURA

### **1. Cliente Genérico por Tenant**

Cada tenant tiene su propio cliente "Público en General":

```sql
-- Un genérico por tenant (garantizado por índice UNIQUE)
CREATE UNIQUE INDEX uq_customers_generic_per_tenant
    ON customers (tenant_id)
    WHERE is_system_generic = TRUE;
```

**Características:**
- ✅ Un solo genérico por tenant
- ✅ Marcado con `is_system_generic = TRUE`
- ✅ NO se puede editar ni borrar (trigger)
- ✅ Se crea automáticamente al crear tenant o al hacer sync

### **2. Función Automática**

```sql
SELECT get_or_create_generic_customer(tenant_id, branch_id);
```

**Comportamiento:**
1. Busca cliente genérico existente del tenant
2. Si NO existe, lo crea automáticamente
3. Retorna el `customer_id`

**Usado automáticamente en:**
- `/api/sync/sales` - Si `id_cliente` es NULL o no existe

---

## 📡 ENDPOINTS

### **POST /api/customers/sync** (Idempotente)

Sincroniza un cliente desde Desktop al backend.

**Request:**
```json
{
  "tenant_id": 1,
  "name": "María González",
  "phone": "5551234567",
  "email": "maria.g@email.com",
  "address": "Av. Hidalgo 123",
  "credit_limit": 5000,
  "current_balance": 0,
  "notes": "Cliente frecuente",
  "is_wholesale": false,
  "discount_percentage": 0,

  // ✅ OFFLINE-FIRST FIELDS
  "global_id": "550e8400-e29b-41d4-a716-446655440000",
  "terminal_id": "f3db8c11-062b-4f8b-80cd-883009e63833",
  "local_op_seq": 1,
  "created_local_utc": "2025-11-07T01:00:00Z",
  "device_event_raw": 1762457951662
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 5,
    "name": "María González",
    "global_id": "550e8400-e29b-41d4-a716-446655440000",
    "created_at": "2025-11-07T01:00:00Z"
  }
}
```

**⚠️ Nota:** Si el `name` contiene "Público en General", el endpoint lo ignora (el genérico se crea automáticamente en el servidor).

---

### **GET /api/customers** (Requiere JWT)

Obtiene lista de clientes del tenant autenticado.

**Query Parameters:**
- `include_generic` (opcional): `true` para incluir cliente genérico en listado (default: `false`)

**Request:**
```http
GET /api/customers?include_generic=false
Authorization: Bearer <JWT_TOKEN>
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 2,
      "tenant_id": 1,
      "name": "María González",
      "phone": "5551234567",
      "email": "maria.g@email.com",
      "address": "Av. Hidalgo 123",
      "credit_limit": 5000,
      "current_balance": 0,
      "notes": "Cliente frecuente",
      "is_system_generic": false,
      "created_at": "2025-11-07T01:00:00Z",
      "updated_at": "2025-11-07T01:00:00Z"
    },
    // ... más clientes (sin genérico por defecto)
  ]
}
```

---

### **GET /api/customers/generic** (Requiere JWT)

Obtiene o crea el cliente genérico del tenant autenticado.

**Request:**
```http
GET /api/customers/generic
Authorization: Bearer <JWT_TOKEN>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "tenant_id": 1,
    "name": "Público en General",
    "phone": "N/A",
    "address": "N/A",
    "email": null,
    "is_system_generic": true,
    "notes": "Cliente genérico del sistema - No editar ni eliminar",
    "created_at": "2025-11-07T00:00:00Z"
  }
}
```

---

## 🔄 FLUJO DE SINCRONIZACIÓN

### **Escenario 1: Sincronizar clientes desde Desktop**

```javascript
// Desktop: UnifiedSyncService.cs (nuevo método)
async Task<bool> SyncCustomerAsync(Cliente cliente) {
    var payload = new {
        tenant_id = 1,
        name = cliente.Name,
        phone = cliente.Phone,
        email = cliente.Email,
        address = cliente.Address,
        // ... otros campos
        global_id = cliente.GlobalId,  // UUID
        terminal_id = _terminalId,
        local_op_seq = cliente.LocalOpSeq
    };

    var response = await _httpClient.PostAsync("/api/customers/sync", payload);

    if (response.IsSuccessStatusCode) {
        // Actualizar RemoteId en local
        cliente.RemoteId = responseData.id;
        cliente.Synced = true;
        await _db.UpdateAsync(cliente);
    }
}
```

### **Escenario 2: Venta con cliente que no existe en backend**

```javascript
// Desktop envía:
POST /api/sync/sales
{
  "tenant_id": 1,
  "id_cliente": 5,  // Cliente solo existe en Desktop
  "ticket_number": 1,
  "total": 100
}

// Backend:
1. Busca cliente 5 en PostgreSQL → NO existe
2. Llama a get_or_create_generic_customer(1, 1)
3. Usa cliente genérico del tenant (ej: ID 1)
4. Inserta venta con id_cliente = 1 (genérico)
5. ✅ Venta guardada exitosamente
```

### **Escenario 3: Venta sin cliente (NULL)**

```javascript
// Desktop envía:
POST /api/sync/sales
{
  "tenant_id": 1,
  "id_cliente": null,  // Sin cliente
  "ticket_number": 2,
  "total": 50
}

// Backend:
1. id_cliente es NULL
2. Llama a get_or_create_generic_customer(1, 1)
3. Usa cliente genérico del tenant
4. Inserta venta con id_cliente = <genérico>
5. ✅ Venta guardada exitosamente
```

---

## 🛡️ PROTECCIONES

### **1. Trigger para Prevenir Eliminación**

```sql
CREATE TRIGGER trg_prevent_generic_customer_delete
    BEFORE DELETE ON customers
    FOR EACH ROW
    EXECUTE FUNCTION prevent_generic_customer_delete();
```

**Comportamiento:**
```sql
-- Intentar borrar cliente genérico:
DELETE FROM customers WHERE is_system_generic = TRUE;

-- ❌ ERROR: No se puede eliminar el cliente genérico del sistema (ID: 1)
```

### **2. Índice UNIQUE por Tenant**

```sql
CREATE UNIQUE INDEX uq_customers_generic_per_tenant
    ON customers (tenant_id)
    WHERE is_system_generic = TRUE;
```

**Garantiza:** Solo UN cliente genérico por tenant.

---

## 📊 ESTRUCTURA DE DATOS

### **Tabla: customers**

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | SERIAL | Primary key |
| `tenant_id` | INTEGER | FK a tenants |
| `name` | VARCHAR | Nombre del cliente |
| `phone` | VARCHAR | Teléfono |
| `email` | VARCHAR | Email |
| `address` | TEXT | Dirección |
| `credit_limit` | DECIMAL | Límite de crédito |
| `current_balance` | DECIMAL | Saldo actual |
| `notes` | TEXT | Notas |
| `is_wholesale` | BOOLEAN | ¿Cliente mayorista? |
| `discount_percentage` | DECIMAL | % de descuento |
| **`is_system_generic`** | **BOOLEAN** | **¿Es cliente genérico del sistema?** |
| **`global_id`** | **UUID** | **UUID único para idempotencia** |
| `terminal_id` | UUID | UUID de la terminal |
| `local_op_seq` | INTEGER | Secuencia local |
| `created_local_utc` | TIMESTAMPTZ | Timestamp del dispositivo |
| `device_event_raw` | BIGINT | Timestamp raw |
| `created_at` | TIMESTAMPTZ | Timestamp de creación |
| `updated_at` | TIMESTAMPTZ | Timestamp de actualización |

---

## 🚀 DESPLIEGUE

### **Migraciones Aplicadas:**

1. **071_create_generic_customer_per_tenant.sql**
   - Agrega columna `is_system_generic`
   - Crea índice UNIQUE por tenant
   - Crea función `get_or_create_generic_customer()`
   - Crea clientes genéricos para todos los tenants existentes
   - Crea trigger de protección contra eliminación

2. **072_add_offline_first_to_customers.sql**
   - Agrega columnas offline-first (`global_id`, `terminal_id`, `local_op_seq`, etc.)
   - Crea índice UNIQUE en `global_id` para ON CONFLICT
   - Crea trigger para `updated_at` automático

### **Código Backend:**

1. **routes/customers.js** (NUEVO)
   - `POST /api/customers/sync` - Sincronizar cliente
   - `GET /api/customers` - Listar clientes
   - `GET /api/customers/generic` - Obtener genérico

2. **routes/sales.js** (ACTUALIZADO)
   - Usa `get_or_create_generic_customer()` si cliente no existe

3. **server.js** (ACTUALIZADO)
   - Registra rutas de customers

---

## 📝 PRÓXIMOS PASOS (Desktop)

### **1. Agregar Método de Sync de Clientes**

```csharp
// UnifiedSyncService.cs
public async Task<bool> SyncCustomerImmediatelyAsync(Cliente cliente)
{
    if (cliente == null) return false;
    if (cliente.Synced) return true;

    var payload = new {
        tenant_id = _syncConfig.tenantId,
        name = cliente.Name,
        phone = cliente.Phone,
        email = cliente.Email,
        address = cliente.Address,
        credit_limit = cliente.CreditLimit,
        current_balance = cliente.CurrentBalance,
        notes = cliente.Notes,
        is_wholesale = cliente.IsWholesale,
        discount_percentage = cliente.DiscountPercentage,
        // Offline-first
        global_id = cliente.GlobalId,
        terminal_id = cliente.TerminalId,
        local_op_seq = cliente.LocalOpSeq,
        created_local_utc = cliente.CreatedLocalUtc,
        device_event_raw = cliente.DeviceEventRaw
    };

    var response = await _httpClient.PostAsync("/api/customers/sync", payload);

    if (response.IsSuccessStatusCode) {
        cliente.Synced = true;
        cliente.SyncedAt = DateTime.UtcNow;
        await _db.UpdateAsync(cliente);
        return true;
    }

    return false;
}
```

### **2. Sincronizar Clientes al Inicio**

```csharp
// En SyncAllPendingInCycleAsync, agregar:
var pendingCustomers = await _db.Table<Cliente>()
    .Where(c => !c.Synced && c.Name != "Público en General")
    .ToListAsync();

foreach (var customer in pendingCustomers) {
    await SyncCustomerImmediatelyAsync(customer);
}
```

### **3. No Sincronizar Cliente Genérico**

El cliente genérico se crea automáticamente en el servidor, NO debe sincronizarse desde Desktop.

```csharp
// Filtro:
.Where(c => !c.Synced && c.Name != "Público en General")
```

---

## ✅ RESUMEN

**Backend:**
- ✅ Cliente genérico por tenant (automático)
- ✅ Endpoint de sync idempotente
- ✅ Protección contra eliminación
- ✅ Asignación automática en ventas

**Desktop (pendiente):**
- ⚠️ Agregar método `SyncCustomerImmediatelyAsync`
- ⚠️ Llamar sync de clientes en ciclo de sincronización
- ⚠️ Excluir cliente genérico del sync

**Beneficios:**
- ✅ Ventas nunca fallan por cliente faltante
- ✅ Cada tenant tiene su cliente genérico
- ✅ Integridad referencial garantizada
- ✅ Idempotencia en sincronización
