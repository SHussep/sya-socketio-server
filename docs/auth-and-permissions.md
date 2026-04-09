# Autenticación y Permisos

> **Last updated:** 2026-03-13

---

## JWT Authentication

Todos los endpoints usan `authenticateToken` middleware excepto los marcados como públicos.

```
Authorization: Bearer <token>
```

Token contiene: `{ employeeId, tenantId, branchId, email, isOwner }`

---

## Protección del Owner (is_owner = true)

El propietario del negocio tiene campos protegidos que **no pueden ser modificados** por nadie, ni siquiera por sí mismo desde la UI.

### Endpoints protegidos

| Endpoint | Protección | Error |
|----------|-----------|-------|
| `PUT /api/employees/:id` | No permite cambiar `roleId`, `canUseMobileApp`, `mobileAccessType`, ni `isActive=false` del owner | 403 `OWNER_PROTECTED` |
| `PUT /api/employee-roles/by-uuid/:globalId/role` | No permite cambiar el rol del owner | 403 `OWNER_PROTECTED` |

### Archivos
- `routes/employees.js` — Guard en PUT endpoint
- `routes/employee_roles.js` — Guard en role update

### WinUI Desktop
- `EditEmployeeViewModel.cs` — `CanEditRoleAndAccess` = false cuando target es owner
- `EditEmployeeDialog.xaml` — ComboBox de rol y CheckBox de acceso móvil deshabilitados
- `UnifiedSyncService.cs` — Si recibe 403 OWNER_PROTECTED, revierte cambios locales consultando `/api/employees/:id/mobile-access` y marca `NeedsUpdate = false`

### Flutter Mobile
- `RoleValidatorService` — Valida `mobileAccessType` cada 5 min y al recibir `employee:updated`
- Si detecta cambio de rol → fuerza logout (seguridad)
- Endpoint: `GET /api/employees/:id/mobile-access?tenantId=X`

---

## Data Reset - Role Check

### Endpoints
| Endpoint | Permiso requerido | Descripción |
|----------|------------------|-------------|
| `POST /api/data-reset/branch/:branchId` | owner o admin | Reset datos de una sucursal |
| `POST /api/data-reset/tenant` | owner o admin | Reset datos de todo el tenant |
| `GET /api/data-reset/status/:tenantId` | owner o admin | Estado del último reset |

### Helper: `requireOwnerOrAdmin(pool, employeeId, tenantId)`
Verifica `is_owner = true` OR `mobile_access_type = 'admin'` en la tabla roles.
**No usa `role_id` hardcodeado** (es auto-increment por tenant).

---

## Flujo de Verificación de Email

```
1. Admin crea/edita empleado con acceso móvil
2. Si email no verificado → se guarda SIN acceso móvil (PendingVerification)
3. Se envía correo de verificación
4. Empleado verifica email
5. Se habilita acceso móvil → EnableMobileAccessAfterVerification()
6. Owner está implícitamente verificado (registró con Google OAuth)
```
