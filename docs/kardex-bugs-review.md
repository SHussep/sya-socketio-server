# Kardex & Inventario — Errores Corregidos y Pendientes

**Fecha**: 9 de abril de 2026
**Propósito**: Documento para revisión por otro programador. Lista los bugs encontrados, los ya corregidos, y los pendientes.

---

## 1. Errores Ya Corregidos (Backend — sya-socketio-server)

### 1.1 `kardexEntries is not defined` en ventas.js
- **Archivo**: `routes/ventas.js`
- **Problema**: La variable `kardexEntries` se declaraba dentro del bloque `if (items && items.length > 0)` (línea ~662), pero se referenciaba en el bloque de emisión de Socket.IO (línea ~766) que está **fuera** de ese scope.
- **Efecto**: Después de una venta móvil con deducción de inventario, el servidor lanzaba error al intentar emitir `kardex_entries_created` via socket. El producto sí se descontaba en BD, pero Desktop no recibía la notificación.
- **Fix**: Se movió `const kardexEntries = []` antes del bloque de items, al nivel de la transacción.
- **Commit**: `4f7d5fb` — ya en producción (Render auto-deploy).

### 1.2 `column p.sku does not exist` en kardex.js
- **Archivo**: `routes/kardex.js`, línea ~214
- **Problema**: La tabla `productos` NO tiene columna `sku`. El campo equivalente es `id_producto` (BIGINT, SKU local del Desktop).
- **Fix**: Se cambió a buscar por `p.id_producto::text` O por `p.descripcion ILIKE`.

### 1.3 `column p.unidad_medida does not exist` en múltiples archivos
- **Archivos afectados**:
  - `routes/ventas.js` (emisión de `product_updated` socket)
  - `routes/repartidor_assignments.js` (3 emisiones: create, cancel, liquidate)
  - `routes/repartidor_returns.js` (emisión de `product_updated`)
- **Problema**: La columna correcta es `unidad_medida_id` (INTEGER FK). No existe `unidad_medida`.
- **Fix**: Cambiado a `p.unidad_medida_id` en todos los archivos mencionados.

### 1.4 `column p.pesable does not exist` en ventas.js
- **Archivo**: `routes/ventas.js`
- **Problema**: La columna correcta es `bascula` (BOOLEAN). No existe `pesable`.
- **Fix**: Cambiado a `p.bascula`.

### 1.5 Repartidor returns no restauraban inventario
- **Archivo**: `routes/repartidor_returns.js`
- **Problema**: Al sincronizar devoluciones de repartidor, solo se insertaba el registro en `repartidor_returns` pero NO se restauraba el inventario en `productos` ni se creaba entrada de kardex.
- **Fix**: Se agregó lógica para `UPDATE productos SET inventario = inventario + qty` e `INSERT INTO kardex_entries` con tipo `DevolucionRepartidor`. Usa `xmax = 0` para idempotencia.

### 1.6 Guardian dashboard `product_name: null`
- **Archivo**: `routes/dashboard.js`
- **Problema**: Parseaba JSON con `(swl.additional_data_json::jsonb->>'ProductId')` (PascalCase) pero los datos enviados usan `productId` (camelCase). También usaba `p.id_producto` (SKU) en lugar de `p.id` (PK).
- **Fix**: Cambiado a `LEFT JOIN productos p ON p.id = swl.related_product_id` (usa la FK directa).

---

## 2. Errores Ya Corregidos (Desktop — SyaTortilleriasWinUi)

### 2.1 JSON parsing falla con NUMERIC de PostgreSQL
- **Archivo**: `ViewModels/KardexViewModel.cs`, método `SearchFromServerAsync()`
- **Problema**: PostgreSQL `NUMERIC(10,2)` llega como string JSON (`"43.00"`) via node-postgres. El código usaba `GetDouble()`, `GetInt32()`, `GetInt64()` que esperan tipo JSON `number` y lanzan `InvalidOperationException`.
- **Efecto**: El endpoint `/api/kardex/pull` respondía correctamente con datos, pero Desktop crasheaba al parsear la respuesta. Kardex aparecía vacío.
- **Fix**: Se crearon helpers `SafeGetDouble()`, `SafeGetInt()`, `SafeGetLong()` que manejan ambos tipos (number y string).
- **Estado**: Editado, **pendiente de compilar y probar**.

### 2.2 KardexViewModel usaba JWT de memoria volátil
- **Archivo**: `ViewModels/KardexViewModel.cs`
- **Problema**: Usaba `_tenantService.CurrentAuthToken` que vive en memoria y se pierde al reiniciar la app.
- **Fix**: Cambiado a `UserConfigService.GetValidJwtTokenAsync()` que lee del almacenamiento persistente y refresca automáticamente.

### 2.3 Kardex filtraba por SKU en lugar de GlobalId
- **Archivos**: `ViewModels/KardexViewModel.cs`, `Views/KardexPage.xaml.cs`, `Views/ProductosPage.xaml.cs`
- **Problema**: Al navegar desde la lista de productos al kardex, se enviaba `IDProducto` (SKU local, no único entre tenants). En multi-tenant, el mismo SKU "9002" podría existir en múltiples tenants.
- **Fix**: Ahora se envía `GlobalId` (UUID único). El ViewModel usa `product_global_id` (filtro preciso) con fallback a `product_sku` (búsqueda por texto).

### 2.4 Columna "Unidad" se borra al recibir `product_updated` via Socket.IO
- **Archivo**: `Services/ProductoService.cs`, método `ApplyRemoteUpdateAsync()`
- **Problema**: Al actualizar un producto desde socket, se lee de SQLite y las propiedades `[Ignore]` (`UnidadAbrev`, `UnidadMedidaNombre`) quedan vacías porque no se persisten en SQLite.
- **Fix**: Después de update/insert, se busca la unidad de medida y se re-populan los campos:
  ```csharp
  var unit = await _db.Table<UnitOfMeasure>().FirstOrDefaultAsync(u => u.Id == existing.UnidadMedidaId);
  existing.UnidadMedidaNombre = unit?.Name ?? "N/D";
  existing.UnidadAbrev = unit?.Abbreviation ?? "";
  ```

---

## 3. Referencia: Esquema PostgreSQL (columnas correctas)

**Tabla `productos`** — columnas relevantes:
| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | SERIAL PK | ID interno PostgreSQL |
| `id_producto` | BIGINT | SKU del Desktop (NO es PK, NO es unique entre tenants) |
| `descripcion` | VARCHAR(255) | Nombre del producto |
| `precio_venta` | NUMERIC(10,2) | **Llega como STRING en JSON** |
| `inventario` | NUMERIC(10,2) | **Llega como STRING en JSON** |
| `inventariar` | BOOLEAN | Si se trackea inventario |
| `bascula` | BOOLEAN | **NO es `pesable`** |
| `unidad_medida_id` | INTEGER FK | **NO es `unidad_medida`** |
| `global_id` | VARCHAR(255) UNIQUE | UUID para sync offline-first |

**NO existen las columnas**: `sku`, `pesable`, `unidad_medida`

### node-postgres y NUMERIC
node-postgres (pg) retorna columnas `NUMERIC(10,2)` como **strings** JavaScript (`"43.00"`, no `43`). Esto es por diseño para evitar pérdida de precisión. Cualquier cliente que parsee JSON de nuestras APIs debe manejar ambos tipos.

---

## 4. Gaps Arquitectónicos Identificados (No Implementados)

### 4.1 Inventario per-branch NO existe en PostgreSQL
- **Tabla `productos_branch_precios`** solo tiene `precio_venta` y `precio_compra`. **NO tiene columna `inventario`**.
- Actualmente, toda deducción de inventario (ventas, asignaciones de repartidor) modifica `productos.inventario` (inventario global).
- **Impacto**: Si Sucursal A vende 5 kg de masa, se descuenta del inventario global. Sucursal B ve el mismo descuento. En multi-sucursal esto es incorrecto.
- **Solución requerida**:
  1. Agregar columna `inventario NUMERIC(10,2) DEFAULT 0` a `productos_branch_precios`
  2. Modificar todas las deducciones de inventario para usar el inventario de la branch específica
  3. El Desktop ya tiene `ProductoBranch.Inventario` en SQLite local — solo falta el backend

### 4.2 Kardex no tiene paginación
- El endpoint `/api/kardex/pull` usa `LIMIT 500` fijo. Para sucursales con alto volumen de movimientos, esto puede ser insuficiente.
- Considerar agregar `offset` o cursor-based pagination.

---

## 5. Checklist para el Programador

### Para verificar que los fixes de backend funcionan:
- [ ] Revisar logs de Render después del deploy de commit `4f7d5fb`
- [ ] Hacer una venta desde móvil con un producto que tiene `inventariar = true`
- [ ] Verificar que Desktop recibe el socket `product_updated` (inventario actualizado)
- [ ] Verificar que Desktop recibe el socket `kardex_entries_created`
- [ ] Verificar que no aparece error `kardexEntries is not defined` en logs de Render

### Para verificar fixes de Desktop (requiere recompilar):
- [ ] Abrir kardex desde la lista de productos (click en "Ver Kardex")
- [ ] Verificar que los movimientos se cargan correctamente (no queda vacío)
- [ ] Verificar que cantidades (Antes, Cambio, Después) muestran valores correctos
- [ ] Verificar que la columna "Unidad" no desaparece después de recibir un `product_updated` via socket
- [ ] Revisar Debug output para confirmar `[KardexVM] Kardex cargado desde servidor: N entries`

### Archivos modificados en Desktop (pendientes de commit):
- `ViewModels/KardexViewModel.cs` — JSON parsing seguro + JWT persistente + filtro por GlobalId
- `Views/KardexPage.xaml.cs` — Navegación por GlobalId
- `Views/ProductosPage.xaml.cs` — Envía GlobalId al navegar a kardex
- `Services/ProductoService.cs` — Re-popula UnidadAbrev/UnidadMedidaNombre después de socket update
