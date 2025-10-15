# Diagnóstico: KeyNotFoundException en CloudRestoreService.cs línea 192

## Problema
```
System.Collections.Generic.KeyNotFoundException
Message=The given key was not present in the dictionary.
at System.Text.Json.JsonElement.GetProperty(String propertyName)
at SYATortillerias.Services.CloudRestoreService.<LoginAsync>d__8.MoveNext()
in CloudRestoreService.cs:line 192
```

## Estructura de Respuesta del Servidor

El endpoint `/api/restore/login` devuelve:

```json
{
  "success": true,
  "message": "Autenticación exitosa",
  "data": {
    "employee": {
      "id": 1,
      "tenant_id": 1,
      "branch_id": 1,           ← AHORA NUNCA ES NULL
      "email": "user@example.com",
      "username": "username",
      "full_name": "Full Name",
      "role": "owner",
      "business_name": "Business Name"
    },
    "tokens": {
      "access_token": "eyJhbGc...",
      "refresh_token": "eyJhbGc...",
      "expires_in": 86400
    }
  }
}
```

## Posibles Causas

### 1. **Nombres de Propiedades con Snake_Case vs CamelCase**

El servidor usa `snake_case` (tenant_id, branch_id, full_name), pero el código C# podría estar esperando `camelCase` (tenantId, branchId, fullName).

**Solución**: En C#, usar los nombres exactos del JSON:

```csharp
// ❌ INCORRECTO
var tenantId = jsonElement.GetProperty("tenantId").GetInt32();

// ✅ CORRECTO
var tenantId = jsonElement.GetProperty("tenant_id").GetInt32();
```

### 2. **Propiedad que No Existe**

El código C# puede estar buscando una propiedad que el servidor no devuelve.

**Para identificar**:
- Revisar línea 192 de CloudRestoreService.cs
- Ver qué propiedad está intentando leer
- Verificar si existe en el JSON de respuesta

### 3. **Estructura Anidada Incorrecta**

El código C# podría estar buscando propiedades en el nivel incorrecto.

Ejemplo:
```csharp
// ❌ INCORRECTO - busca en el nivel raíz
var branchId = jsonElement.GetProperty("branch_id").GetInt32();

// ✅ CORRECTO - busca dentro de data.employee
var data = jsonElement.GetProperty("data");
var employee = data.GetProperty("employee");
var branchId = employee.GetProperty("branch_id").GetInt32();
```

## Cómo Diagnosticar

### Paso 1: Ver el código C# en línea 192
```csharp
// Necesitamos ver estas líneas para identificar el problema
// Líneas 185-200 de CloudRestoreService.cs
```

### Paso 2: Identificar la propiedad faltante

Buscar líneas como:
```csharp
.GetProperty("nombre_de_propiedad")
```

### Paso 3: Verificar contra el JSON

Comparar el nombre de la propiedad con el JSON de respuesta del servidor.

## Soluciones Comunes

### Si el problema es `branch_id` null:
✅ YA ESTÁ ARREGLADO - El servidor ahora siempre devuelve un valor válido

### Si el problema es nombres diferentes:

**Opción A: Cambiar nombres en el servidor** (routes/restore.js)
```javascript
// Cambiar de snake_case a camelCase
employee: {
  id: employee.id,
  tenantId: employee.tenant_id,     // ← camelCase
  branchId: branchId,                // ← camelCase
  email: employee.email,
  username: employee.username,
  fullName: employee.full_name,      // ← camelCase
  role: employee.role,
  businessName: employee.business_name // ← camelCase
}
```

**Opción B: Usar JsonProperty en C#**
```csharp
public class EmployeeData
{
    [JsonPropertyName("tenant_id")]
    public int TenantId { get; set; }

    [JsonPropertyName("branch_id")]
    public int BranchId { get; set; }

    [JsonPropertyName("full_name")]
    public string FullName { get; set; }

    [JsonPropertyName("business_name")]
    public string BusinessName { get; set; }
}
```

**Opción C: Usar nombres exactos del JSON**
```csharp
var tenantId = employee.GetProperty("tenant_id").GetInt32();
var branchId = employee.GetProperty("branch_id").GetInt32();
var fullName = employee.GetProperty("full_name").GetString();
```

## Próximo Paso

**NECESITO VER**:
Líneas 185-200 de `CloudRestoreService.cs` para identificar exactamente qué propiedad está buscando y por qué no la encuentra.

Por favor, comparte ese fragmento de código.
