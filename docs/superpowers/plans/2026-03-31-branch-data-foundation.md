# Branch Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When creating a second+ branch, pull real tenant data from PostgreSQL instead of seeding dummy products — with a product selection dialog.

**Architecture:** New `BranchSetupService` handles all HTTP GET calls to existing backend endpoints + SQLite inserts with FK remapping. WelcomeViewModel orchestrates the flow, WelcomePage hosts the product selection ContentDialog via delegate pattern.

**Tech Stack:** WinUI 3 / .NET 8, SQLite (sqlite-net-pcl), HttpClient + System.Text.Json, CommunityToolkit.Mvvm

**Spec:** `docs/superpowers/specs/2026-03-31-branch-data-foundation-design.md`

---

### Task 1: Create DTOs and interface

**Files:**
- Create: `SyaTortilleriasWinUi/Models/ProductoPullItem.cs`
- Create: `SyaTortilleriasWinUi/Services/Interfaces/IBranchSetupService.cs`

- [ ] **Step 1: Create ProductoPullItem DTO and FkRemapResult**

```csharp
// SyaTortilleriasWinUi/Models/ProductoPullItem.cs
namespace SYATortillerias.Models;

/// <summary>
/// DTO for displaying tenant products during branch setup selection.
/// </summary>
public class ProductoPullItem
{
    public int PgId { get; set; }
    public string IdProducto { get; set; } = string.Empty;
    public string Descripcion { get; set; } = string.Empty;
    public double PrecioVenta { get; set; }
    public string UnidadAbrev { get; set; } = string.Empty;
    public string? ImageUrl { get; set; }
    public bool IsSelected { get; set; } = true;

    // Campos completos para insertar (no se muestran en UI)
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
    public string GlobalId { get; set; } = string.Empty;
}

public class FkRemapResult
{
    public Dictionary<int, int> CategoryMap { get; set; } = new();
    public Dictionary<int, int> SupplierMap { get; set; } = new();
    public Dictionary<int, int> RoleMap { get; set; } = new();
}
```

- [ ] **Step 2: Create IBranchSetupService interface**

```csharp
// SyaTortilleriasWinUi/Services/Interfaces/IBranchSetupService.cs
using SYATortillerias.Models;

namespace SYATortillerias.Services.Interfaces;

public interface IBranchSetupService
{
    Task<FkRemapResult> PullAndSaveReferenceDataAsync(string accessToken, int tenantId);
    Task<List<ProductoPullItem>> PullProductListAsync(string accessToken, int tenantId);
    Task InsertSelectedProductosAsync(List<ProductoPullItem> selected, int tenantId, FkRemapResult fkMaps);
}
```

- [ ] **Step 3: Commit**

```
git add SyaTortilleriasWinUi/Models/ProductoPullItem.cs SyaTortilleriasWinUi/Services/Interfaces/IBranchSetupService.cs
git commit -m "feat: add DTOs and interface for branch data pull"
```

---

### Task 2: Create BranchSetupService — reference data pull

**Files:**
- Create: `SyaTortilleriasWinUi/Services/BranchSetupService.cs`

**Context:** This service pulls categories, suppliers, expense categories, roles+permissions, and the generic customer from PostgreSQL and inserts them into SQLite. It builds FK remapping dictionaries.

**HTTP pattern:** Follow `TenantService.cs` — create `HttpClient` with base URL from `IConfiguration["ApiSettings:BackendUrl"]`, set Bearer token per-request, parse responses with `JsonDocument`.

- [ ] **Step 1: Create BranchSetupService with constructor and helper**

```csharp
// SyaTortilleriasWinUi/Services/BranchSetupService.cs
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using SYATortillerias.Models;
using SYATortillerias.Services.Interfaces;

namespace SYATortillerias.Services;

public class BranchSetupService : IBranchSetupService
{
    private readonly IDatabaseService _databaseService;
    private readonly HttpClient _httpClient;

    public BranchSetupService(IConfiguration configuration, IDatabaseService databaseService)
    {
        _databaseService = databaseService;
        _httpClient = new HttpClient();
        var baseUrl = configuration["ApiSettings:BackendUrl"] ?? "http://localhost:3001";
        _httpClient.BaseAddress = new Uri(baseUrl);
        _httpClient.Timeout = TimeSpan.FromSeconds(60);
    }

    private async Task<JsonDocument?> GetJsonAsync(string url, string accessToken)
    {
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            var response = await _httpClient.SendAsync(request);

            if (!response.IsSuccessStatusCode)
            {
                Debug.WriteLine($"[BranchSetup] ❌ GET {url} → {response.StatusCode}");
                return null;
            }

            var json = await response.Content.ReadAsStringAsync();
            return JsonDocument.Parse(json);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[BranchSetup] ❌ GET {url} error: {ex.Message}");
            return null;
        }
    }
```

- [ ] **Step 2: Implement PullAndSaveReferenceDataAsync**

Add this method to `BranchSetupService.cs`. It calls 5 endpoints in sequence and inserts data into SQLite.

```csharp
    public async Task<FkRemapResult> PullAndSaveReferenceDataAsync(string accessToken, int tenantId)
    {
        var result = new FkRemapResult();
        var db = await _databaseService.GetConnectionAsync();

        // 1. Categorías de productos
        Debug.WriteLine("[BranchSetup] 📥 Pulling categorías de productos...");
        var catDoc = await GetJsonAsync($"/api/categorias-productos?tenantId={tenantId}", accessToken);
        if (catDoc != null && catDoc.RootElement.TryGetProperty("data", out var catArray))
        {
            foreach (var item in catArray.EnumerateArray())
            {
                var cat = new CategoriaProducto
                {
                    Nombre = item.GetProperty("nombre").GetString() ?? "",
                    IsAvailable = item.TryGetProperty("is_available", out var av) && av.GetBoolean(),
                    GlobalId = item.TryGetProperty("global_id", out var gid) ? gid.GetString() ?? "" : "",
                    TerminalId = item.TryGetProperty("terminal_id", out var tid) ? tid.GetString() ?? "" : "",
                    LocalOpSeq = item.TryGetProperty("local_op_seq", out var lop) ? lop.GetInt32() : 0,
                    CreatedLocalUtc = item.TryGetProperty("created_local_utc", out var clu) ? clu.GetString() ?? "" : "",
                    RemoteId = item.GetProperty("id").GetInt32(),
                    Synced = true,
                    SyncedAt = DateTime.Now,
                    IsDeleted = false,
                    NeedsUpdate = false
                };
                await db.InsertAsync(cat);
                result.CategoryMap[cat.RemoteId.Value] = cat.Id;
            }
            Debug.WriteLine($"[BranchSetup] ✅ {result.CategoryMap.Count} categorías insertadas");
            catDoc.Dispose();
        }

        // 2. Proveedores
        Debug.WriteLine("[BranchSetup] 📥 Pulling proveedores...");
        var supDoc = await GetJsonAsync($"/api/suppliers?tenantId={tenantId}", accessToken);
        if (supDoc != null && supDoc.RootElement.TryGetProperty("data", out var supArray))
        {
            foreach (var item in supArray.EnumerateArray())
            {
                var sup = new Proveedor
                {
                    TenantId = tenantId,
                    Name = item.GetProperty("name").GetString() ?? "",
                    ContactPerson = item.TryGetProperty("contact_person", out var cp) ? cp.GetString() : null,
                    PhoneNumber = item.TryGetProperty("phone_number", out var ph) ? ph.GetString() ?? "" : "",
                    Email = item.TryGetProperty("email", out var em) ? em.GetString() : null,
                    Address = item.TryGetProperty("address", out var ad) ? ad.GetString() : null,
                    IsActive = item.TryGetProperty("is_active", out var ia) && ia.GetBoolean(),
                    IsUndeletable = item.TryGetProperty("is_undeletable", out var iu) && iu.GetBoolean(),
                    GlobalId = item.TryGetProperty("global_id", out var gid2) ? gid2.GetString() ?? "" : "",
                    TerminalId = item.TryGetProperty("terminal_id", out var tid2) ? tid2.GetString() ?? "" : "",
                    LocalOpSeq = item.TryGetProperty("local_op_seq", out var lop2) ? lop2.GetInt32() : 0,
                    CreatedLocalUtc = item.TryGetProperty("created_local_utc", out var clu2) ? clu2.GetString() ?? "" : "",
                    RemoteId = item.GetProperty("id").GetInt32(),
                    Synced = true,
                    SyncedAt = DateTime.Now,
                    IsDeleted = false,
                    NeedsUpdate = false,
                    PendingServer = false
                };
                await db.InsertAsync(sup);
                result.SupplierMap[sup.RemoteId.Value] = sup.Id;
            }
            Debug.WriteLine($"[BranchSetup] ✅ {result.SupplierMap.Count} proveedores insertados");
            supDoc.Dispose();
        }

        // 3. Categorías de gastos (globales, no por tenant)
        Debug.WriteLine("[BranchSetup] 📥 Pulling categorías de gastos...");
        var expDoc = await GetJsonAsync("/api/expenses/categories", accessToken);
        if (expDoc != null && expDoc.RootElement.TryGetProperty("data", out var expArray))
        {
            // Pre-load UnitOfMeasure for abbreviation lookup
            var units = await db.Table<UnitOfMeasure>().ToListAsync();
            var unitByAbbrev = units.ToDictionary(u => u.Abbreviation, u => u.Id, StringComparer.OrdinalIgnoreCase);

            foreach (var item in expArray.EnumerateArray())
            {
                var pgId = item.GetProperty("id").GetInt32();
                int? unitOfMeasureId = null;
                if (item.TryGetProperty("unit_abbreviation", out var ua) && ua.ValueKind == JsonValueKind.String)
                {
                    var abbrev = ua.GetString();
                    if (!string.IsNullOrEmpty(abbrev) && unitByAbbrev.TryGetValue(abbrev, out var uid))
                        unitOfMeasureId = uid;
                }

                var expCat = new ExpenseCategory
                {
                    Id = pgId,
                    Name = item.GetProperty("name").GetString() ?? "",
                    IsAvailable = item.TryGetProperty("is_available", out var iav) && iav.GetBoolean(),
                    IsMeasurableCost = item.TryGetProperty("is_measurable", out var im) && im.GetBoolean(),
                    UnitOfMeasureId = unitOfMeasureId,
                    PostgresCategoryId = pgId,
                    LastSyncedAt = DateTime.Now
                };
                await db.InsertOrReplaceAsync(expCat);
            }
            Debug.WriteLine($"[BranchSetup] ✅ Categorías de gastos insertadas");
            expDoc.Dispose();
        }

        // 4. Roles + permisos
        Debug.WriteLine("[BranchSetup] 📥 Pulling roles...");
        var roleDoc = await GetJsonAsync($"/api/roles/by-tenant/{tenantId}", accessToken);
        if (roleDoc != null && roleDoc.RootElement.TryGetProperty("roles", out var rolesArray))
        {
            var localPermissions = await db.Table<Permission>().ToListAsync();
            var permByKey = localPermissions.ToDictionary(p => p.Key, p => p.Id);

            foreach (var item in rolesArray.EnumerateArray())
            {
                var roleName = item.GetProperty("name").GetString() ?? "";

                // Derive MobileAccessType from permissions
                var mobileAccessType = "none";
                if (item.TryGetProperty("permissions", out var permsArr) && permsArr.ValueKind == JsonValueKind.Array)
                {
                    var permCodes = permsArr.EnumerateArray()
                        .Select(p => p.TryGetProperty("code", out var c) ? c.GetString() : null)
                        .Where(c => c != null)
                        .ToHashSet();

                    if (permCodes.Contains("AccessMobileAppAsAdmin"))
                        mobileAccessType = "admin";
                    else if (permCodes.Contains("AccessMobileAppAsDistributor"))
                        mobileAccessType = "distributor";
                }

                var role = new Role
                {
                    TenantId = tenantId,
                    Name = roleName,
                    Description = item.TryGetProperty("description", out var desc) ? desc.GetString() ?? "" : "",
                    IsSystem = item.TryGetProperty("is_system", out var isSys) && isSys.GetBoolean(),
                    MobileAccessType = mobileAccessType,
                    GlobalId = $"ROLE_{tenantId}_{roleName}",
                    TerminalId = string.Empty,
                    LocalOpSeq = 0,
                    CreatedLocalUtc = string.Empty,
                    DeviceEventRaw = 0,
                    CreatedAt = DateTime.Now,
                    UpdatedAt = DateTime.Now,
                    RemoteId = item.GetProperty("id").GetInt32(),
                    Synced = true,
                    SyncedAt = DateTime.Now
                };
                await db.InsertAsync(role);
                result.RoleMap[role.RemoteId.Value] = role.Id;

                // Insert RolePermissions
                if (item.TryGetProperty("permissions", out var permsArr2) && permsArr2.ValueKind == JsonValueKind.Array)
                {
                    foreach (var perm in permsArr2.EnumerateArray())
                    {
                        var code = perm.TryGetProperty("code", out var pc) ? pc.GetString() : null;
                        if (code != null && permByKey.TryGetValue(code, out var localPermId))
                        {
                            await db.InsertAsync(new RolePermission
                            {
                                RoleId = role.Id,
                                PermissionId = localPermId
                            });
                        }
                    }
                }
            }
            Debug.WriteLine($"[BranchSetup] ✅ {result.RoleMap.Count} roles insertados");
            roleDoc.Dispose();
        }

        // 5. Cliente genérico
        Debug.WriteLine("[BranchSetup] 📥 Pulling cliente genérico...");
        var custDoc = await GetJsonAsync($"/api/customers?tenantId={tenantId}&include_generic=true", accessToken);
        if (custDoc != null && custDoc.RootElement.TryGetProperty("data", out var custArray))
        {
            foreach (var item in custArray.EnumerateArray())
            {
                var isGeneric = item.TryGetProperty("is_system_generic", out var isg) && isg.GetBoolean();
                if (!isGeneric) continue;

                var cliente = new Cliente
                {
                    TenantId = tenantId,
                    Nombre = item.TryGetProperty("name", out var nm) ? nm.GetString() ?? "Público en General" : "Público en General",
                    Telefono = item.TryGetProperty("phone", out var ph3) ? ph3.GetString() : null,
                    Correo = item.TryGetProperty("email", out var em3) ? em3.GetString() : null,
                    Direccion = item.TryGetProperty("address", out var ad3) ? ad3.GetString() : null,
                    CreditoLimite = item.TryGetProperty("credit_limit", out var cl) ? cl.GetDouble() : 0,
                    SaldoDeudor = item.TryGetProperty("current_balance", out var cb) ? cb.GetDouble() : 0,
                    Nota = item.TryGetProperty("notes", out var nt) ? nt.GetString() : null,
                    IsGeneric = 1,
                    TieneCredito = item.TryGetProperty("tiene_credito", out var tc) && tc.GetBoolean(),
                    TipoDescuento = item.TryGetProperty("tipo_descuento", out var td) ? td.GetInt32() : 0,
                    PorcentajeDescuento = item.TryGetProperty("discount_percentage", out var dp) ? dp.GetDouble() : 0,
                    MontoDescuentoFijo = item.TryGetProperty("monto_descuento_fijo", out var mdf) ? mdf.GetDouble() : 0,
                    AplicarRedondeo = item.TryGetProperty("aplicar_redondeo", out var ar) && ar.GetBoolean(),
                    Latitude = item.TryGetProperty("latitude", out var lat) && lat.ValueKind != JsonValueKind.Null ? lat.GetDouble() : null,
                    Longitude = item.TryGetProperty("longitude", out var lng) && lng.ValueKind != JsonValueKind.Null ? lng.GetDouble() : null,
                    GoogleMapsUrl = item.TryGetProperty("google_maps_url", out var gm) ? gm.GetString() : null,
                    GlobalId = item.TryGetProperty("global_id", out var gid3) ? gid3.GetString() ?? "SYSTEM_GENERIC_CUSTOMER" : "SYSTEM_GENERIC_CUSTOMER",
                    RemoteId = item.GetProperty("id").GetInt32(),
                    Activo = true,
                    Synced = true,
                    SyncedAt = DateTime.Now,
                    FechaDeAlta = DateTime.Now,
                    NeedsUpdate = false,
                    PendingServer = false
                };
                await db.InsertAsync(cliente);
                Debug.WriteLine($"[BranchSetup] ✅ Cliente genérico: {cliente.Nombre} (ID local: {cliente.IdCliente})");
                break; // Solo necesitamos el genérico
            }
            custDoc.Dispose();
        }

        return result;
    }
```

- [ ] **Step 3: Commit**

```
git add SyaTortilleriasWinUi/Services/BranchSetupService.cs
git commit -m "feat: BranchSetupService — pull reference data from PostgreSQL"
```

---

### Task 3: BranchSetupService — product pull and insert

**Files:**
- Modify: `SyaTortilleriasWinUi/Services/BranchSetupService.cs`

- [ ] **Step 1: Implement PullProductListAsync**

Add this method to `BranchSetupService.cs`:

```csharp
    public async Task<List<ProductoPullItem>> PullProductListAsync(string accessToken, int tenantId)
    {
        var products = new List<ProductoPullItem>();

        Debug.WriteLine("[BranchSetup] 📥 Pulling productos del tenant...");
        // No pasar branchId — queremos precios base, no overrides de otra sucursal
        var doc = await GetJsonAsync($"/api/productos?tenantId={tenantId}", accessToken);
        if (doc == null) return products;

        if (doc.RootElement.TryGetProperty("data", out var dataArray))
        {
            foreach (var item in dataArray.EnumerateArray())
            {
                // Filtrar eliminados (el endpoint ya debería filtrar, pero doble check)
                if (item.TryGetProperty("eliminado", out var elim) && elim.GetBoolean())
                    continue;

                products.Add(new ProductoPullItem
                {
                    PgId = item.GetProperty("id").GetInt32(),
                    IdProducto = item.TryGetProperty("id_producto", out var idp) ? idp.GetString() ?? "0" : "0",
                    Descripcion = item.TryGetProperty("descripcion", out var desc) ? desc.GetString() ?? "" : "",
                    PrecioVenta = item.TryGetProperty("precio_venta_base", out var pvb) ? pvb.GetDouble() :
                                  item.TryGetProperty("precio_venta", out var pv) ? pv.GetDouble() : 0,
                    UnidadAbrev = item.TryGetProperty("unidad_abrev", out var ua) ? ua.GetString() ?? "" : "",
                    ImageUrl = item.TryGetProperty("image_url", out var img) && img.ValueKind != JsonValueKind.Null ? img.GetString() : null,
                    IsSelected = true,
                    Categoria = item.TryGetProperty("categoria", out var cat) && cat.ValueKind == JsonValueKind.Number ? cat.GetInt32() : 0,
                    PrecioCompra = item.TryGetProperty("precio_compra", out var pc) ? pc.GetDouble() : 0,
                    Produccion = item.TryGetProperty("produccion", out var prod) && prod.GetBoolean(),
                    Inventariar = item.TryGetProperty("inventariar", out var inv) && inv.GetBoolean(),
                    TiposDeSalidaId = item.TryGetProperty("tipos_de_salida_id", out var tds) ? tds.GetInt32() : 1,
                    Notificar = item.TryGetProperty("notificar", out var notif) && notif.GetBoolean(),
                    Minimo = item.TryGetProperty("minimo", out var min) ? min.GetDouble() : 0,
                    ProveedorId = item.TryGetProperty("proveedor_id", out var provId) && provId.ValueKind == JsonValueKind.Number ? provId.GetInt32() : 0,
                    UnidadMedidaId = item.TryGetProperty("unidad_medida_id", out var umId) ? umId.GetInt32() : 1,
                    Bascula = item.TryGetProperty("bascula", out var bas) && bas.GetBoolean(),
                    IsPosShortcut = item.TryGetProperty("is_pos_shortcut", out var ips) && ips.GetBoolean(),
                    GlobalId = item.TryGetProperty("global_id", out var gid) ? gid.GetString() ?? "" : ""
                });
            }
        }

        doc.Dispose();
        Debug.WriteLine($"[BranchSetup] ✅ {products.Count} productos disponibles (no eliminados)");
        return products;
    }
```

- [ ] **Step 2: Implement InsertSelectedProductosAsync**

Add this method to `BranchSetupService.cs`:

```csharp
    public async Task InsertSelectedProductosAsync(List<ProductoPullItem> selected, int tenantId, FkRemapResult fkMaps)
    {
        var db = await _databaseService.GetConnectionAsync();
        int inserted = 0;

        await db.RunInTransactionAsync(conn =>
        {
            foreach (var item in selected)
            {
                // Remap FKs: PG category ID → local SQLite category ID
                int localCatId = 0;
                if (item.Categoria > 0 && fkMaps.CategoryMap.TryGetValue(item.Categoria, out var mappedCat))
                    localCatId = mappedCat;

                int localProvId = 0;
                if (item.ProveedorId > 0 && fkMaps.SupplierMap.TryGetValue(item.ProveedorId, out var mappedSup))
                    localProvId = mappedSup;

                // Parse SKU string to long
                long idProducto = 0;
                long.TryParse(item.IdProducto, out idProducto);

                var producto = new Producto
                {
                    IDProducto = idProducto,
                    TenantId = tenantId,
                    Descripcion = item.Descripcion,
                    Categoria = localCatId,
                    PrecioCompra = item.PrecioCompra,
                    PrecioVenta = item.PrecioVenta,
                    Produccion = item.Produccion,
                    Inventariar = item.Inventariar,
                    TiposDeSalidaID = item.TiposDeSalidaId,
                    Notificar = item.Notificar,
                    Minimo = item.Minimo,
                    Inventario = 0, // Nueva sucursal empieza sin stock
                    ProveedorId = localProvId,
                    UnidadMedidaId = item.UnidadMedidaId,
                    Eliminado = false,
                    Bascula = item.Bascula,
                    IsPosShortcut = item.IsPosShortcut,
                    ImageUrl = item.ImageUrl,
                    GlobalId = item.GlobalId,
                    RemoteId = item.PgId,
                    Synced = true,
                    SyncedAt = DateTime.Now,
                    NeedsUpdate = false,
                    NeedsDelete = false,
                    PendingServer = false,
                    NeedsDuplicateCheck = false
                };
                conn.Insert(producto);
                inserted++;
            }
        });

        Debug.WriteLine($"[BranchSetup] ✅ {inserted} productos insertados en SQLite");
    }
}
```

- [ ] **Step 3: Commit**

```
git add SyaTortilleriasWinUi/Services/BranchSetupService.cs
git commit -m "feat: BranchSetupService — product pull list and bulk insert with FK remap"
```

---

### Task 4: Add SeedCatalogsOnlyAsync to DatabaseSeedService

**Files:**
- Modify: `SyaTortilleriasWinUi/Services/DatabaseSeedService.cs`
- Modify: `SyaTortilleriasWinUi/Services/Interfaces/IDatabaseSeedService.cs`

**Context:** `DatabaseSeedService.SeedInitialDataAsync()` (line 42) seeds everything. We need a new method that only seeds the fixed system catalogs (TipoPago, TipoVenta, etc.) without touching CategoriaProducto, Proveedor, ExpenseCategory, Role, RolePermission, or Cliente — those come from PostgreSQL for second+ branches.

- [ ] **Step 1: Add method signature to IDatabaseSeedService interface**

In `SyaTortilleriasWinUi/Services/Interfaces/IDatabaseSeedService.cs`, add:

```csharp
/// <summary>
/// Seeds only fixed system catalogs (TipoPago, TipoVenta, etc.) for second+ branch setup.
/// Does NOT seed: CategoriaProducto, Proveedor, ExpenseCategory, Role, RolePermission, Cliente.
/// </summary>
Task SeedCatalogsOnlyAsync(SQLiteAsyncConnection connection);
```

- [ ] **Step 2: Implement SeedCatalogsOnlyAsync in DatabaseSeedService**

Add this method to `DatabaseSeedService.cs` (after `SeedInitialDataAsync`).

**CRITICAL:** NO duplicar datos de seed manualmente. Los valores EXACTOS deben copiarse del método `SeedInitialDataAsync` existente (líneas 54-193). La implementación debe:

1. **Leer `SeedInitialDataAsync`** (línea 42) y copiar SOLO estos bloques:
   - EstadoVenta (con IDs explícitos como `{1,"Borrador"}, {2,"Asignada"}, ...`)
   - TipoVenta (con IDs)
   - TipoPago (con IDs)
   - TipoDeSalida (con el campo correcto `TipoDeSalidaNombre`)
   - TipoDescuento (con IDs)
   - PurchaseStatus (líneas 144-155, **no omitir**)
   - UnitOfMeasure (con abreviaciones exactas del codebase)
2. Llamar `await SeedPermissionsAsync(connection)` (línea 726)
3. **NO incluir**: CategoriaProducto, ExpenseCategory, Role, RolePermission, Cliente, Proveedor (esos vienen de PG)

**IMPORTANTE sobre `SafeInsertAllAsync`:** Este método toma `Func<Task>`, NO `List<T>`. Usar la misma firma:
```csharp
await SafeInsertAllAsync(connection, async () => await connection.InsertAllAsync(items), "TableName");
```

```csharp
public async Task SeedCatalogsOnlyAsync(SQLiteAsyncConnection connection)
{
    Debug.WriteLine("[DatabaseSeed] 🌱 Seeding catálogos fijos (branch setup)...");

    // COPIAR los bloques exactos de SeedInitialDataAsync (líneas 54-193)
    // para: EstadoVenta, TipoVenta, TipoPago, TipoDeSalida, TipoDescuento,
    //       PurchaseStatus, UnitOfMeasure
    // Usar SafeInsertAllAsync con la firma correcta: (connection, async () => ..., "name")
    //
    // Ejemplo:
    // var existingEstados = await connection.Table<EstadoVenta>().CountAsync();
    // if (existingEstados == 0)
    // {
    //     var estados = new List<EstadoVenta> { /* COPIAR EXACTO de líneas 64-69 */ };
    //     await SafeInsertAllAsync(connection, async () => await connection.InsertAllAsync(estados), "EstadoVenta");
    // }

    // Permission (sistema) — reutilizar método existente
    await SeedPermissionsAsync(connection);

    Debug.WriteLine("[DatabaseSeed] ✅ Catálogos fijos seeded (branch setup)");
}
```

**El implementador DEBE leer `SeedInitialDataAsync` y copiar los valores exactos.** No inventar datos.

- [ ] **Step 3: Commit**

```
git add SyaTortilleriasWinUi/Services/DatabaseSeedService.cs SyaTortilleriasWinUi/Services/Interfaces/IDatabaseSeedService.cs
git commit -m "feat: add SeedCatalogsOnlyAsync for second+ branch setup"
```

---

### Task 5: Register BranchSetupService in DI and wire WelcomeViewModel

**Files:**
- Modify: `SyaTortilleriasWinUi/App.xaml.cs` (add DI registration, ~line 121)
- Modify: `SyaTortilleriasWinUi/ViewModels/WelcomeViewModel.cs` (replace seed block, lines 777-789)

- [ ] **Step 1: Register BranchSetupService in App.xaml.cs**

After the existing `IDatabaseSeedService` registration (~line 121), add:

```csharp
services.AddSingleton<IBranchSetupService, BranchSetupService>();
```

Add the using at the top of App.xaml.cs if not already present:
```csharp
using SYATortillerias.Services.Interfaces;
```

- [ ] **Step 2: Add delegate and usings to WelcomeViewModel**

Near the existing `RequestAdminPasswordAsync` delegate (~line 96), add:

```csharp
public Func<List<ProductoPullItem>, Task<List<ProductoPullItem>?>>? RequestProductSelectionAsync { get; set; }
```

Add at the top:
```csharp
using SYATortillerias.Models;
```

- [ ] **Step 3: Replace seed block in WelcomeViewModel**

Replace lines 777-789 (the existing PASO 7 block) with:

```csharp
// PASO 7: Modo Primary + catálogos + pull de datos
await _deviceModeService.SetDeviceModeAsync(DeviceOperationMode.Primary);

try
{
    // Seed solo catálogos fijos (TipoPago, UnitOfMeasure, Permission, etc.)
    var dbSeedSvc = App.Current.Services.GetRequiredService<IDatabaseSeedService>();
    var dbConn = await _databaseService.GetConnectionAsync();
    await dbSeedSvc.SeedCatalogsOnlyAsync(dbConn);
    Debug.WriteLine("[WelcomeVM] ✅ Catálogos fijos seeded");

    // Pull datos reales del tenant desde PostgreSQL
    var branchSetup = App.Current.Services.GetRequiredService<IBranchSetupService>();

    ProgressMessage = "Descargando catálogos del negocio...";
    var fkMaps = await branchSetup.PullAndSaveReferenceDataAsync(accessToken, tenantId);
    Debug.WriteLine("[WelcomeVM] ✅ Datos de referencia descargados");

    ProgressMessage = "Obteniendo productos...";
    var allProducts = await branchSetup.PullProductListAsync(accessToken, tenantId);
    Debug.WriteLine($"[WelcomeVM] ✅ {allProducts.Count} productos disponibles");

    if (allProducts.Count > 0)
    {
        // Mostrar diálogo de selección
        List<ProductoPullItem>? selectedProducts = null;
        if (RequestProductSelectionAsync != null)
            selectedProducts = await RequestProductSelectionAsync(allProducts);

        if (selectedProducts != null && selectedProducts.Count > 0)
        {
            ProgressMessage = $"Importando {selectedProducts.Count} productos...";
            await branchSetup.InsertSelectedProductosAsync(selectedProducts, tenantId, fkMaps);
            Debug.WriteLine($"[WelcomeVM] ✅ {selectedProducts.Count} productos importados");
        }
        else
        {
            Debug.WriteLine("[WelcomeVM] ⚠️ Sin productos seleccionados");
        }
    }
    else
    {
        // Tenant sin productos — seedear defaults
        Debug.WriteLine("[WelcomeVM] ⚠️ Tenant sin productos, seeding defaults...");
        var seedSvc = App.Current.Services.GetRequiredService<SeedDataService>();
        await seedSvc.SeedDataIfNeededAsync();
    }
}
catch (Exception setupEx)
{
    Debug.WriteLine($"[WelcomeVM] ⚠️ Error en branch setup: {setupEx.Message}");
    // Fallback: intentar seed normal
    try
    {
        var seedSvc = App.Current.Services.GetRequiredService<SeedDataService>();
        await seedSvc.SeedDataIfNeededAsync();
        Debug.WriteLine("[WelcomeVM] ✅ Fallback seed completado");
    }
    catch (Exception seedEx)
    {
        Debug.WriteLine($"[WelcomeVM] ⚠️ Seed fallback error: {seedEx.Message}");
    }
}
```

- [ ] **Step 4: Commit**

```
git add SyaTortilleriasWinUi/App.xaml.cs SyaTortilleriasWinUi/ViewModels/WelcomeViewModel.cs
git commit -m "feat: wire BranchSetupService in DI and WelcomeViewModel"
```

---

### Task 6: Product selection dialog in WelcomePage

**Files:**
- Modify: `SyaTortilleriasWinUi/Views/WelcomePage.xaml.cs` (add delegate implementation, after ~line 210)

**Context:** Follow the same delegate pattern as `RequestAdminPasswordAsync`. The dialog shows a ListView with CheckBoxes for each product, a search TextBox, and a "Continuar con N productos" button.

- [ ] **Step 1: Add the product selection delegate in WelcomePage.xaml.cs**

After the existing `RequestAdminPasswordAsync` delegate implementation (~line 210), add:

```csharp
// Configurar delegado para selección de productos al crear nueva sucursal
ViewModel.RequestProductSelectionAsync = async (allProducts) =>
{
    // Observable collection for filtering
    var displayProducts = new List<ProductoPullItem>(allProducts);
    var searchBox = new TextBox
    {
        PlaceholderText = "Buscar por nombre o código...",
        Margin = new Thickness(0, 0, 0, 8)
    };

    var listView = new ListView
    {
        Height = 400,
        SelectionMode = ListViewSelectionMode.None
    };

    // Build item template inline
    var updateList = new Action<string>(filter =>
    {
        var filtered = string.IsNullOrWhiteSpace(filter)
            ? allProducts
            : allProducts.Where(p =>
                p.Descripcion.Contains(filter, StringComparison.OrdinalIgnoreCase) ||
                p.IdProducto.Contains(filter, StringComparison.OrdinalIgnoreCase)).ToList();

        listView.Items.Clear();
        foreach (var product in filtered)
        {
            var cb = new CheckBox
            {
                IsChecked = product.IsSelected,
                Tag = product,
                Content = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    Spacing = 12,
                    Children =
                    {
                        new TextBlock { Text = product.IdProducto, Width = 60, VerticalAlignment = VerticalAlignment.Center,
                            Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["TextFillColorSecondaryBrush"] },
                        new TextBlock { Text = product.Descripcion, Width = 200, VerticalAlignment = VerticalAlignment.Center },
                        new TextBlock { Text = $"${product.PrecioVenta:F2}", Width = 80, VerticalAlignment = VerticalAlignment.Center },
                        new TextBlock { Text = product.UnidadAbrev, Width = 40, VerticalAlignment = VerticalAlignment.Center,
                            Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["TextFillColorSecondaryBrush"] }
                    }
                }
            };
            cb.Checked += (s, e) => { if (s is CheckBox c && c.Tag is ProductoPullItem p) p.IsSelected = true; };
            cb.Unchecked += (s, e) => { if (s is CheckBox c && c.Tag is ProductoPullItem p) p.IsSelected = false; };
            listView.Items.Add(cb);
        }
    });

    searchBox.TextChanged += (s, e) => updateList(searchBox.Text);
    updateList(""); // Initial load

    var countText = new TextBlock
    {
        Text = $"{allProducts.Count} productos seleccionados",
        Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
        Margin = new Thickness(0, 4, 0, 0)
    };

    var panel = new StackPanel { Spacing = 8, MinWidth = 500 };
    panel.Children.Add(new TextBlock
    {
        Text = "Estos productos ya existen en tu negocio. Deselecciona los que no necesitas en esta sucursal.",
        TextWrapping = TextWrapping.Wrap
    });
    panel.Children.Add(searchBox);
    panel.Children.Add(listView);
    panel.Children.Add(countText);

    var dialog = new ContentDialog
    {
        Title = "Productos disponibles",
        Content = panel,
        PrimaryButtonText = $"Continuar con {allProducts.Count} productos",
        CloseButtonText = "Cancelar",
        DefaultButton = ContentDialogButton.Primary,
        XamlRoot = this.XamlRoot,
        RequestedTheme = App.MainWindow.Content is FrameworkElement feProducts ? feProducts.RequestedTheme : ElementTheme.Default
    };

    var result = await dialog.ShowAsync();
    if (result != ContentDialogResult.Primary)
        return null;

    return allProducts.Where(p => p.IsSelected).ToList();
};
```

**Nota:** Add `using SYATortillerias.Models;` at the top of WelcomePage.xaml.cs if not present.

- [ ] **Step 2: Commit**

```
git add SyaTortilleriasWinUi/Views/WelcomePage.xaml.cs
git commit -m "feat: product selection dialog for branch setup"
```

---

### Task 7: Manual testing

- [ ] **Step 1: Verificar estado limpio**

```
node scripts/audit_tenant.js 52
```

Verificar que tenant 52 tiene productos, categorías, proveedores. Si la sucursal de prueba anterior sigue, eliminarla con `node scripts/delete_branch.js <id>`.

- [ ] **Step 2: Compilar y probar**

1. Compilar la solución en Visual Studio
2. Ejecutar la app
3. En WelcomePage, autenticar con Gmail
4. En BranchSelectionDialog, crear nueva sucursal
5. Verificar en Output/Debug:
   - `[DatabaseSeed] ✅ Catálogos fijos seeded`
   - `[BranchSetup] ✅ N categorías insertadas`
   - `[BranchSetup] ✅ N proveedores insertados`
   - `[BranchSetup] ✅ Categorías de gastos insertadas`
   - `[BranchSetup] ✅ N roles insertados`
   - `[BranchSetup] ✅ Cliente genérico: Público en General`
   - `[BranchSetup] ✅ N productos disponibles`
6. Verificar diálogo de selección de productos aparece con productos checked
7. Deseleccionar alguno, confirmar
8. Verificar en ProductosPage que solo los seleccionados aparecen
9. Verificar que el cliente "Público en General" existe en la nueva sucursal

- [ ] **Step 3: Verificar datos en PostgreSQL**

```
node scripts/audit_tenant.js 52
```

Verificar que no se crearon duplicados en PostgreSQL.

- [ ] **Step 4: Limpiar sucursal de prueba**

```
node scripts/delete_branch.js <branchId>
```
