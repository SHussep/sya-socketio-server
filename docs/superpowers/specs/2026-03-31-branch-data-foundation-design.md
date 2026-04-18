# Data Foundation para Segunda Sucursal - Design Spec

## Goal

Cuando un admin crea una segunda (o tercera, etc.) sucursal desde el WelcomeViewModel, en vez de ejecutar seed local de productos/categorías/proveedores, se bajan los datos reales del tenant desde PostgreSQL. Los productos se presentan en un diálogo de selección donde todos están checked por default y el usuario puede deseleccionar los que no necesita. Datos de referencia (categorías, proveedores, roles, clientes) se bajan automáticamente sin selección.

## Architecture

Un dispositivo = una sucursal. Al crear una nueva sucursal, la BD local se resetea (comportamiento actual). El nuevo servicio `BranchSetupService` reemplaza a `SeedDataService` para sucursales 2+, bajando datos reales de PostgreSQL en vez de generar seed data. Los endpoints GET existentes se reutilizan tal cual.

## Scope

- **In scope:** Pull de datos desde PostgreSQL al crear sucursal 2+, diálogo de selección de productos, FK remapping entre IDs de PostgreSQL e IDs locales de SQLite.
- **Out of scope:** Onboarding/tour UX (Sub-proyecto 2), página admin multi-sucursal (Sub-proyecto 3), Flutter (Sub-proyecto 4).

---

## Detección: ¿Es primera sucursal o sucursal adicional?

En el flujo de WelcomeViewModel, cuando `dialogResult.Action == "create"`:

- El BranchSelectionDialog solo aparece si el usuario ya tiene sucursales existentes (viene de un login con email que ya existe en el sistema)
- Por lo tanto, si el flujo llega al bloque `"create"` dentro del BranchSelectionDialog, **siempre es sucursal 2+**
- La primera sucursal se crea por el flujo normal de WelcomePage Steps 1-4 con seed local

**Decisión:** Si el flujo entra por `dialogResult.Action == "create"`, usar `BranchSetupService.PullTenantDataAsync()`. Si es el flujo normal de WelcomePage (primera sucursal), seguir usando `SeedDataService` como hoy.

---

## Datos por tipo de pull

### Automático (sin selección del usuario)

| Dato | Endpoint | Filtra eliminados |
|------|----------|-------------------|
| Categorías de productos | `GET /api/categorias-productos` | Sí (`is_deleted = FALSE`) |
| Categorías de gastos | `GET /api/expenses/categories` | Sí (`is_available = true`) |
| Proveedores | `GET /api/suppliers` | Sí (`is_deleted = FALSE`) |
| Roles + permisos | `GET /api/roles/by-tenant/:tenantId` | No hay soft-delete |
| Cliente genérico | `GET /api/customers?include_generic=true` | Sí (`activo = TRUE`). **Nota:** endpoint tiene LIMIT 20. Filtrar resultado client-side por `is_system_generic == true` para obtener solo el genérico. |

### Con selección del usuario

| Dato | Endpoint | Filtra eliminados |
|------|----------|-------------------|
| Productos | `GET /api/productos` | Sí (`eliminado = false`) — además se filtran en el query |

### Seed local (datos fijos del sistema, sin cambios)

- TipoPago, TipoVenta, TipoDeSalida, TipoDescuento, EstadoVenta, UnitOfMeasure

Estos los sigue manejando `DatabaseSeedService` como hoy. Son tablas de catálogo fijo que el usuario no crea ni modifica.

---

## Orden de ejecución

```
WelcomeViewModel (dialogResult.Action == "create"):
│
├── Pasos 1-6 (sin cambios): crear branch en PG, obtener empleado,
│   reset BD, RegisterFirstUser, CurrentSession, UserConfig, JWT, registrar device
│
├── DatabaseSeedService.SeedCatalogsOnlyAsync()     ← NUEVO método
│   Solo seedea: TipoPago, TipoVenta, TipoDeSalida, TipoDescuento,
│   EstadoVenta, UnitOfMeasure, Permission (datos fijos)
│
├── BranchSetupService.PullTenantDataAsync(accessToken, tenantId)  ← NUEVO
│   1. GET /api/categorias-productos → INSERT CategoriaProducto
│   2. GET /api/suppliers            → INSERT Proveedor
│   3. GET /api/expenses/categories  → INSERT ExpenseCategory
│   4. GET /api/roles/by-tenant/:id  → INSERT Role + RolePermission
│   5. GET /api/customers?include_generic=true → INSERT Cliente (genérico)
│   Retorna: mapas de FK remapping (pgCatId→localCatId, pgProvId→localProvId)
│
├── BranchSetupService.PullProductosAsync(accessToken, tenantId)   ← NUEVO
│   GET /api/productos → retorna lista de productos para mostrar en UI
│
├── UI: Diálogo de selección de productos (todos checked por default)
│   Usuario deselecciona los que no quiere → lista de seleccionados
│
├── BranchSetupService.InsertSelectedProductosAsync(selectedProducts, fkMaps)
│   INSERT productos seleccionados con FKs remapeadas a IDs locales
│
├── Paso 7-8 (sin cambios): DeviceMode Primary, multi-caja, navegar a LoginPage
```

---

## FK Remapping: PostgreSQL IDs → SQLite IDs

Los IDs auto-incrementados de PostgreSQL no coinciden con los de SQLite. Cuando un producto referencia `categoria=5` (PG ID), necesitamos el `CategoriaProducto.Id` local correspondiente.

**Estrategia:** Al insertar datos de referencia, guardamos `RemoteId = PG ID`. Luego para productos, buscamos la referencia local por `RemoteId`.

```
Ejemplo:
PG: categorias_productos { id: 5, nombre: "Tortillas", global_id: "CAT_52_1" }
→ SQLite: CategoriaProducto { Id: 1 (auto), RemoteId: 5, Nombre: "Tortillas", GlobalId: "CAT_52_1" }

PG: productos { categoria: 5, proveedor_id: 3 }
→ Lookup: CategoriaProducto WHERE RemoteId = 5 → Id = 1
→ Lookup: Proveedor WHERE RemoteId = 3 → Id = 2
→ SQLite: Producto { Categoria: 1, ProveedorId: 2 }
```

**Mapas necesarios:**
- `Dictionary<int, int> categoryMap` — PG categoría ID → SQLite CategoriaProducto.Id
- `Dictionary<int, int> supplierMap` — PG supplier ID → SQLite Proveedor.Id
- `UnidadMedidaId` — se mantiene igual (seed local con IDs fijos 1-4)

---

## Mapeo de campos: PostgreSQL JSON → SQLite Models

### CategoriaProducto

| PG JSON | SQLite CategoriaProducto |
|---------|--------------------------|
| `id` | `RemoteId` |
| `nombre` | `Nombre` |
| `is_available` | `IsAvailable` |
| `global_id` | `GlobalId` |
| `terminal_id` | `TerminalId` |
| `local_op_seq` | `LocalOpSeq` |
| `created_local_utc` | `CreatedLocalUtc` |
| — | `Id` (auto-increment) |
| — | `Synced = true` |
| — | `SyncedAt = DateTime.Now` |
| — | `IsDeleted = false` |
| — | `NeedsUpdate = false` |
| — | `LastModifiedLocalUtc = null` |

**Nota sobre `IsSystemCategory`:** Esta propiedad es `[Ignore]` (no se almacena en SQLite). Se computa como `Id >= 1 && Id <= 5`. En una BD nueva con auto-increment, las categorías del sistema insertadas primero recibirán IDs 1-N, lo cual puede no coincidir con la lógica original. Esto es cosmético y no afecta funcionalidad — solo afecta si algún código muestra un ícono diferente para categorías de sistema.

### Proveedor

| PG JSON | SQLite Proveedor |
|---------|------------------|
| `id` | `RemoteId` |
| `name` | `Name` |
| `contact_person` | `ContactPerson` |
| `phone_number` | `PhoneNumber` |
| `email` | `Email` |
| `address` | `Address` |
| `is_active` | `IsActive` |
| `is_undeletable` | `IsUndeletable` |
| `global_id` | `GlobalId` |
| `terminal_id` | `TerminalId` |
| `local_op_seq` | `LocalOpSeq` |
| `created_local_utc` | `CreatedLocalUtc` |
| — | `Id` (auto-increment) |
| — | `TenantId` = tenantId del contexto |
| — | `Synced = true` |
| — | `SyncedAt = DateTime.Now` |
| — | `IsDeleted = false` |

### ExpenseCategory

| PG JSON | SQLite ExpenseCategory |
|---------|------------------------|
| `id` | `Id` (usar PG ID directo, no auto-increment) |
| `name` | `Name` |
| `is_available` | `IsAvailable` |
| `is_measurable` | `IsMeasurableCost` |
| `unit_abbreviation` | `UnitOfMeasureId` → **RESOLVE**: buscar `UnitOfMeasure` WHERE `Abbreviation == unit_abbreviation`, usar su `Id`. Si no se encuentra o `unit_abbreviation` es null, dejar `UnitOfMeasureId = null`. |
| — | `PostgresCategoryId = id` |
| — | `LastSyncedAt = DateTime.Now` |

**Nota:** ExpenseCategory usa `[PrimaryKey]` sin `[AutoIncrement]`, por lo que podemos asignar el PG ID directamente como PK. El campo `PostgresCategoryId` también se llena con el mismo valor.

**Nota:** Los campos `description` y `sort_order` del JSON se ignoran intencionalmente — no existen en el modelo SQLite.

### Role

| PG JSON | SQLite Role |
|---------|-------------|
| `id` | `RemoteId` |
| `name` | `Name` |
| `description` | `Description` |
| `is_system` | `IsSystem` |
| — | `Id` (auto-increment) |
| — | `TenantId` = tenantId del contexto |
| — | `GlobalId` = generar `"ROLE_{tenantId}_{name}"` |
| — | `MobileAccessType` = derivar de permisos (ver abajo) |
| — | `TerminalId = string.Empty` |
| — | `LocalOpSeq = 0` |
| — | `CreatedLocalUtc = string.Empty` |
| — | `DeviceEventRaw = 0` |
| — | `CreatedAt = DateTime.Now` |
| — | `UpdatedAt = DateTime.Now` |
| — | `Synced = true` |
| — | `SyncedAt = DateTime.Now` |

**Derivar `MobileAccessType`:** Evaluar el array `permissions` del JSON:
- Si contiene `code == "AccessMobileAppAsAdmin"` → `MobileAccessType = "admin"`
- Si contiene `code == "AccessMobileAppAsDistributor"` → `MobileAccessType = "distributor"`
- Si ambos → `MobileAccessType = "admin"` (prioridad admin)
- Si ninguno → `MobileAccessType = "none"`

**Permisos del rol:** El endpoint retorna `permissions` como array de `{ code, name }`. Para cada permiso:
1. Buscar en tabla local `Permission` por `Key == code`
2. Si existe, crear `RolePermission { RoleId = localRoleId, PermissionId = localPermissionId }`

**Nota sobre `Permission.Key` == PG `code`:** Los permisos del sistema se seedean localmente por `DatabaseSeedService` con valores de `Key` que corresponden a los `code` en PostgreSQL (ej: `"ManageEmployees"`, `"ViewSales"`, etc.). Esta correspondencia debe mantenerse. Si un permiso del backend no existe localmente, se ignora silenciosamente.

### Cliente (solo genérico)

| PG JSON | SQLite Cliente |
|---------|----------------|
| `id` | `RemoteId` |
| `global_id` | `GlobalId` |
| `name` | `Nombre` |
| `phone` | `Telefono` |
| `email` | `Correo` |
| `address` | `Direccion` |
| `credit_limit` | `CreditoLimite` |
| `current_balance` | `SaldoDeudor` |
| `notes` | `Nota` |
| `is_system_generic` | `IsGeneric = 1` |
| `tiene_credito` | `TieneCredito` |
| `tipo_descuento` | `TipoDescuento` |
| `discount_percentage` | `PorcentajeDescuento` |
| `monto_descuento_fijo` | `MontoDescuentoFijo` |
| `aplicar_redondeo` | `AplicarRedondeo` |
| `latitude` | `Latitude` |
| `longitude` | `Longitude` |
| `google_maps_url` | `GoogleMapsUrl` |
| — | `IdCliente` (auto-increment) |
| — | `TenantId` = tenantId del contexto |
| — | `Activo = true` |
| — | `Synced = true` |
| — | `SyncedAt = DateTime.Now` |
| — | `FechaDeAlta = DateTime.Now` |

### Producto (solo los seleccionados)

| PG JSON | SQLite Producto |
|---------|-----------------|
| `id` | `RemoteId` |
| `id_producto` | `IDProducto` (parse string → long) |
| `descripcion` | `Descripcion` |
| `categoria` | `Categoria` → **REMAP** via `categoryMap[pgCatId]` |
| `precio_compra` | `PrecioCompra` |
| `precio_venta` | `PrecioVenta` (usar `precio_venta_base`, no el branch-override) |
| `produccion` | `Produccion` |
| `inventariar` | `Inventariar` |
| `tipos_de_salida_id` | `TiposDeSalidaID` |
| `notificar` | `Notificar` |
| `minimo` | `Minimo` |
| — | `Inventario = 0` (inventario empieza en 0 para nueva sucursal) |
| `proveedor_id` | `ProveedorId` → **REMAP** via `supplierMap[pgProvId]` |
| `unidad_medida_id` | `UnidadMedidaId` (IDs fijos, sin remap) |
| `eliminado` | `Eliminado` (siempre false, filtramos en query) |
| `bascula` | `Bascula` |
| `is_pos_shortcut` | `IsPosShortcut` |
| `image_url` | `ImageUrl` |
| `global_id` | `GlobalId` |
| — | `TenantId` = tenantId del contexto |
| — | `TerminalId = null` |
| — | `LocalOpSeq = null` |
| — | `CreatedLocalUtc = null` |
| — | `DeviceEventRaw = null` |
| — | `Synced = true` |
| — | `SyncedAt = DateTime.Now` |
| — | `NeedsUpdate = false` |
| — | `NeedsDelete = false` |
| — | `PendingServer = false` |
| — | `NeedsDuplicateCheck = false` |

**Notas importantes:**
- `Inventario` se pone en 0 — nueva sucursal empieza sin stock
- `precio_venta` usa `precio_venta_base` del JSON (precio base del tenant, no el override de otra sucursal)
- FKs `Categoria` y `ProveedorId` se remapean usando los diccionarios construidos en el paso anterior
- Si `categoria` es null/0 en PG, usar 0 en SQLite (sin categoría)
- Si `proveedor_id` es null/0 en PG, usar 0 en SQLite (sin proveedor)
- **NO pasar `branchId`** al endpoint `GET /api/productos` — así el query no hace JOIN con `productos_branch_precios` y retorna precios base. Pasar solo `tenantId` como query param.
- Offline-first fields (`TerminalId`, `LocalOpSeq`, `CreatedLocalUtc`, `DeviceEventRaw`) se dejan en null — son datos que se originaron en otro terminal y no necesitan rastreo local.
- Todas las inserciones deben hacerse dentro de `RunInTransactionAsync` para atomicidad.

---

## UI: Diálogo de selección de productos

**Implementación:** ContentDialog en WelcomePage.xaml.cs (delegate pattern, como `RequestAdminPasswordAsync`)

**Delegate en WelcomeViewModel:**
```csharp
public Func<List<ProductoPullItem>, Task<List<ProductoPullItem>?>>? RequestProductSelectionAsync { get; set; }
```

**DTO para la UI:**
```csharp
public class ProductoPullItem
{
    public int PgId { get; set; }           // PG id (para referencia)
    public string IdProducto { get; set; }  // SKU
    public string Descripcion { get; set; }
    public double PrecioVenta { get; set; }
    public string UnidadAbrev { get; set; } // "kg", "pz", etc.
    public string? ImageUrl { get; set; }
    public bool IsSelected { get; set; } = true;  // checked por default

    // Campos completos para insertar después (no se muestran en UI)
    public int Categoria { get; set; }
    public double PrecioCompra { get; set; }
    public bool Produccion { get; set; }
    public bool Inventariar { get; set; }
    public int TiposDeSalidaId { get; set; }
    public bool Notificar { get; set; }
    public double Minimo { get; set; }
    public int ProveedorId { get; set; }
    public int UnidadMedidaId { get; set; }
    public bool Bascula { get; set; }
    public bool IsPosShortcut { get; set; }
    public string GlobalId { get; set; }
}
```

**UI del diálogo:**
- Título: "Productos disponibles"
- Subtítulo: "Estos productos ya existen en tu negocio. Deselecciona los que no necesitas en esta sucursal."
- TextBox de búsqueda (filtra por Descripcion o IdProducto)
- ListView/ItemsRepeater con CheckBox por producto: imagen (si hay), SKU, descripción, precio, unidad
- Todos checked por default
- Botón primario: "Continuar con N productos" (actualiza al cambiar selección)
- Botón secundario: "Cancelar" → cancela creación de sucursal completa
- Si 0 productos seleccionados: confirmar "¿Seguro que no quieres importar ningún producto?"

**Caso especial:** Si el tenant tiene 0 productos activos en PostgreSQL, se salta el diálogo y se ejecuta `SeedDataService.SeedProductsAsync()` como fallback (primera sucursal nunca creó productos).

---

## Nuevo servicio: BranchSetupService

**Ubicación:** `SyaTortilleriasWinUi/Services/BranchSetupService.cs`

**Interfaz:** `IBranchSetupService`

```csharp
public interface IBranchSetupService
{
    // Pull y guardar datos de referencia (categorías, proveedores, roles, cliente genérico)
    // Retorna mapas de FK remapping
    Task<FkRemapResult> PullAndSaveReferenceDataAsync(string accessToken, int tenantId);

    // Pull lista de productos del tenant (para mostrar en UI)
    Task<List<ProductoPullItem>> PullProductListAsync(string accessToken, int tenantId);

    // Insertar productos seleccionados en SQLite con FKs remapeadas
    Task InsertSelectedProductosAsync(List<ProductoPullItem> selected, int tenantId, FkRemapResult fkMaps);
}

public class FkRemapResult
{
    public Dictionary<int, int> CategoryMap { get; set; }   // PG catId → local catId
    public Dictionary<int, int> SupplierMap { get; set; }   // PG supId → local supId
    public Dictionary<int, int> RoleMap { get; set; }       // PG roleId → local roleId (para futuras asignaciones)
}
```

**Dependencias:** `HttpClient` (para llamadas GET), `IDatabaseService` (para insertar en SQLite), `ICurrentSessionService`.

**Registro en DI:** `services.AddSingleton<IBranchSetupService, BranchSetupService>();`

---

## Cambios en servicios de seed

**Dos servicios de seed existen hoy:**
- `DatabaseSeedService` — seedea catálogos fijos (roles, permisos, tipos de pago, etc.)
- `SeedDataService` — seedea productos y clientes de negocio

**Nuevo método en `DatabaseSeedService`:**
```csharp
public async Task SeedCatalogsOnlyAsync()
{
    // Solo seedea:
    // - EstadoVenta
    // - TipoVenta
    // - TipoPago
    // - TipoDeSalida
    // - TipoDescuento
    // - UnitOfMeasure
    // - Permission (permisos del sistema)
    //
    // NO seedea: CategoriaProducto, Proveedor, ExpenseCategory, Role, RolePermission, Cliente, Producto
    // (esos se bajan de PostgreSQL via BranchSetupService)
}
```

Los métodos existentes (`SeedInitialDataAsync`, `SeedDataIfNeededAsync`) no se modifican — se siguen usando para la primera sucursal.

---

## Cambio en WelcomeViewModel

En el bloque `dialogResult.Action == "create"` (línea ~581), reemplazar:

```csharp
// ANTES:
var seedSvc = App.Current.Services.GetRequiredService<SeedDataService>();
await seedSvc.SeedDataIfNeededAsync();

// DESPUÉS:
var dbSeedSvc = App.Current.Services.GetRequiredService<IDatabaseSeedService>();
await dbSeedSvc.SeedCatalogsOnlyAsync();  // solo tablas fijas (TipoPago, UnitOfMeasure, Permission, etc.)

var branchSetup = App.Current.Services.GetRequiredService<IBranchSetupService>();

// 1. Pull datos de referencia
ProgressMessage = "Descargando catálogos del negocio...";
var fkMaps = await branchSetup.PullAndSaveReferenceDataAsync(accessToken, tenantId);

// 2. Pull lista de productos
ProgressMessage = "Obteniendo productos...";
var allProducts = await branchSetup.PullProductListAsync(accessToken, tenantId);

if (allProducts.Count > 0)
{
    // 3. Mostrar diálogo de selección
    List<ProductoPullItem>? selected = null;
    if (RequestProductSelectionAsync != null)
        selected = await RequestProductSelectionAsync(allProducts);

    if (selected == null)
    {
        // Usuario canceló → revertir creación? o simplemente no importar productos
        Debug.WriteLine("[WelcomeVM] Usuario canceló selección de productos");
    }
    else if (selected.Count > 0)
    {
        // 4. Insertar seleccionados
        ProgressMessage = $"Importando {selected.Count} productos...";
        await branchSetup.InsertSelectedProductosAsync(selected, tenantId, fkMaps);
    }
}
else
{
    // Tenant sin productos — seedear los defaults
    await seedSvc.SeedProductsAsync();
}
```

---

## Manejo de errores

- **Sin internet:** Imposible — el usuario acaba de crear la sucursal en PG (requirió internet).
- **Endpoint falla:** Mostrar error con retry. No avanzar sin datos de referencia (categorías/proveedores son necesarias para que productos tengan FKs válidas).
- **0 productos en tenant:** Fallback a seed local (caso de primera sucursal que nunca creó productos custom).
- **FK no encontrada en mapa:** Si un producto referencia una categoría o proveedor que no está en el mapa (ej: fue eliminada), usar 0 (sin categoría/proveedor).

---

## Archivos a crear/modificar

| Archivo | Acción |
|---------|--------|
| `Services/BranchSetupService.cs` | **CREAR** — servicio principal de pull |
| `Services/Interfaces/IBranchSetupService.cs` | **CREAR** — interfaz |
| `Models/ProductoPullItem.cs` | **CREAR** — DTO para selección de productos |
| `Services/DatabaseSeedService.cs` | **MODIFICAR** — agregar `SeedCatalogsOnlyAsync()` |
| `ViewModels/WelcomeViewModel.cs` | **MODIFICAR** — usar BranchSetupService en bloque "create" |
| `Views/WelcomePage.xaml.cs` | **MODIFICAR** — implementar delegate de selección de productos |
| `App.xaml.cs` | **MODIFICAR** — registrar BranchSetupService en DI |
