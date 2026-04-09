# Sincronización Desktop ↔ Backend

> **Last updated:** 2026-03-13

---

## Arquitectura General

```
WinUI Desktop (SQLite)  ←→  Backend (PostgreSQL)  ←→  Flutter Mobile (API directa)
         ↑                         ↑
    UnifiedSyncService        REST endpoints
    (push + pull)             (CRUD + sync)
```

- **Desktop** usa SQLite local (offline-first) y sincroniza con PostgreSQL via REST
- **Mobile** consume PostgreSQL directamente via API (online-only)

---

## UnifiedSyncService (Desktop)

### Ciclo de Sync (cada 5 minutos)

```
1. Verificar gastos huérfanos de turnos cerrados
2. Verificar consistencia del turno actual (local vs servidor)
3. PUSH: Subir entidades pendientes (Synced=false o NeedsUpdate=true)
4. PULL: Descargar cambios del servidor (empleados, proveedores, clientes, ventas)
5. Actualizar LastSyncDate en licencia
```

### Entidades sincronizadas (en orden)

| Entidad | Handler | Push | Pull | Sync inmediato |
|---------|---------|------|------|----------------|
| Empleados | `EmployeeSyncHandler` | INSERT/UPDATE | Si (incremental) | Si |
| Empleados-Sucursal | inline | INSERT | No | No |
| Clientes-Sucursal | inline | INSERT | No | No |
| Categorías Producto | `CategoriaProductoSyncHandler` | INSERT | No | No |
| Productos | `ProductoSyncHandler` | INSERT/UPDATE/DELETE(soft) | No | Si |
| Turnos | `ShiftSyncHandler` | INSERT | No | No |
| Ventas | `VentaSyncHandler` | INSERT | Si (incremental) | No |
| Asignaciones Repartidor | `RepartidorAssignmentHandler` | INSERT | No | Si |
| Devoluciones Repartidor | `RepartidorReturnHandler` | INSERT/UPDATE | No | Si |
| Liquidaciones Repartidor | `RepartidorLiquidationHandler` | INSERT | No | No |
| Gastos | `ExpenseHandler` | INSERT/UPDATE | No | No |
| Compras | `PurchaseHandler` | INSERT/UPDATE | No | No |
| Proveedores | `ProveedorHandler` | INSERT | Si (incremental) | No |
| Clientes | `CustomerSyncHandler` | INSERT/UPDATE/DEACTIVATE | Si (incremental) | Si |
| Depósitos | `DepositHandler` | INSERT | No | No |
| Retiros | `WithdrawalHandler` | INSERT | No | No |
| Pagos de Crédito | `CreditPaymentHandler` | INSERT | No | No |
| Saldos Clientes | `CustomerBalanceHandler` | UPDATE | No | No |
| Cortes de Caja | `CashCutHandler` | INSERT | No | No |
| Guardian Logs | `GuardianLogHandler` | INSERT | No | Si |
| Scale Disconnection Logs | `ScaleDisconnectionLogHandler` | INSERT/UPDATE | No | Si |
| Employee Daily Metrics | `EmployeeDailyMetricsHandler` | INSERT/UPDATE | No | Si |
| Cancelaciones Bitácora | `CancelacionBitacoraHandler` | INSERT | No | No |
| Deudas Empleados | `EmployeeDebtHandler` | INSERT/UPDATE | No | No |
| Logs Modo Preparación | `PreparationModeLogHandler` | INSERT | No | No |

### Sync inmediato
Algunas entidades se sincronizan inmediatamente al crear/editar (sin esperar el ciclo de 5 min).
Se activa llamando al handler directamente desde el servicio de la entidad.

---

## Campos de Control (SQLite)

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `Synced` | bool | `true` si ya fue enviado al backend |
| `SyncedAt` | DateTime? | Timestamp de última sincronización exitosa |
| `NeedsUpdate` | bool | `true` si fue modificado localmente después de sincronizar |
| `NeedsDelete` | bool | `true` si fue eliminado localmente (soft-delete) |
| `RemoteId` | int? | ID en PostgreSQL (asignado por el backend) |
| `GlobalId` | string | UUID único para identificación cross-platform |
| `LocalOpSeq` | int | Secuencia de operación local (para ordenamiento) |

---

## Resolución de IDs

Desktop usa IDs locales (SQLite auto-increment). Backend usa IDs propios (PostgreSQL).
La resolución se hace via `GlobalId` (UUID) o `RemoteId`.

### Ejemplo: Productos
```
Local: ProductoId=1234, GlobalId="15646a0e-...", RemoteId=32405
Push: POST /api/products/sync → backend asigna RemoteId=32405
Pull: Backend envía global_id → Desktop busca por GlobalId
```

### Ejemplo: Roles
```
Local: RoleId=1 (Administrador), RemoteId=181
Sync: Mapea local 1 → PostgreSQL 181 via Role.RemoteId
```

### Ejemplo: Proveedores (seed data)
```
GlobalId: "SEED_SUPPLIER_PRODUCTOS_PROPIOS_0" (string, no UUID)
Tipo en PostgreSQL: VARCHAR(255) (no UUID — changed from UUID to support seed IDs)
```

---

## Imágenes de Productos

```
1. Producto creado localmente con imagen en AppData/ProductImages/
2. Al sincronizar, ProductoSyncHandler sube imagen a Cloudinary
3. Backend responde con URL de Cloudinary
4. Handler actualiza ImageUrl en SQLite local
5. Payload al backend incluye la URL de Cloudinary
```

Endpoint Cloudinary: `POST /api/products/:globalId/image`

---

## Manejo de Errores de Sync

### 403 OWNER_PROTECTED
- Revierte cambios locales consultando datos del backend
- Marca `NeedsUpdate = false` para no reintentar

### Cualquier otro error HTTP
- Se registra en `_errorLog`
- `NeedsUpdate` permanece `true` para reintentar en el próximo ciclo

### Sin internet
- Cambios se acumulan en SQLite con `Synced=false` o `NeedsUpdate=true`
- Se sincronizan cuando vuelve la conectividad
