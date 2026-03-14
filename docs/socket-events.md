# Socket.IO Events Reference (Backend - Source of Truth)

> **Last updated:** 2026-03-13
> **Clients:** WinUI Desktop, Flutter Mobile (SYAAdmin)
> **Room pattern:** `branch_${branchId}`

## Quick Reference: Event Flow

```
Desktop (WinUI) ──emit──> Backend (Node.js) ──broadcast──> Mobile (Flutter)
Desktop (WinUI) <──on──── Backend (Node.js) <──emit────── Mobile (Flutter)
```

---

## SCALE & GUARDIAN

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `scale_alert` | Desktop→Backend→Mobile | `{ branchId, alertId, severity, eventType, weightDetected, details, timestamp, employeeName, pageContext }` | EMIT | ON |
| `scale_disconnected` | Desktop→Backend→Mobile | `{ branchId, disconnectedAt, message }` | EMIT | ON |
| `scale_connected` | Desktop→Backend→Mobile | `{ branchId, connectedAt, message }` | EMIT | ON |
| `weight_update` | Desktop→Backend→Mobile | `{ branchId, currentWeight, timestamp }` | EMIT | ON |
| `guardian_status_changed` | Desktop→Backend→Mobile | `{ branchId, isEnabled, changedBy, changedAt, tenantId }` | EMIT | ON |

## SHIFTS

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `shift_started` | Desktop→Backend→Mobile | `{ tenantId, branchId, shiftId, employeeId, employeeName, initialAmount, startTime, branchName }` | EMIT | ON |
| `shift_ended` | Desktop→Backend→Mobile | `{ tenantId, branchId, shiftId, employeeId, employeeName, endTime, branchName, totalCashSales, totalCardSales, totalCreditSales, finalAmount }` | EMIT | ON |
| `shift_auto_closed` | Backend→Desktop | `{ shiftId, branchId, reason }` | ON | - |
| `shift_request_new` | Mobile→Backend→Desktop | `{ requestId, employeeId, employeeGlobalId, employeeName, branchId, branchName, requestedAt }` | ON | - |
| `shift_request_resolved` | Desktop→Backend→Mobile | `{ requestId, employeeId, status: 'approved'\|'rejected'\|'cancelled', rejectionReason? }` | ON | ON |

## SALES

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `sale_completed` | Desktop→Backend→Mobile | `{ branchId, saleId, ticketNumber, total, paymentMethod, completedAt, employeeName }` | EMIT | ON |
| `sale_cancelled` | Desktop→Backend (FCM) | `{ branchId, tenantId, ticketNumber, total, reason, cancelledByEmployeeName, branchName }` | EMIT | - |
| `credit_sale_created` | Desktop→Backend (FCM) | `{ branchId, tenantId, ticketNumber, total, creditAmount, clientName, branchName, employeeName }` | EMIT | - |
| `client_payment_received` | Desktop→Backend (FCM) | `{ branchId, tenantId, clientName, amount, remainingBalance, branchName, employeeName }` | EMIT | - |

## ASSIGNMENTS (Repartidor)

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `assignment_created` | Desktop→Backend→Both | `{ branchId, assignment: { employeeId, assignedQuantity, productName, unitAbbreviation }, timestamp }` | EMIT+ON | ON |
| `assignment_updated` | Backend→Desktop | `{ assignment: {...}, previousStatus, isLiquidation, timestamp }` | ON | ON |
| `assignment_edited` | Desktop→Backend→Mobile | `{ branchId, assignmentId, productName, oldQuantity, newQuantity, reason, editedByEmployeeName, repartidorId, timestamp }` | EMIT+ON | ON |
| `assignment_cancelled` | Desktop→Backend→Mobile | `{ branchId, assignmentId, productName, quantity, reason, cancelledByEmployeeName, repartidorId, timestamp }` | EMIT+ON | ON |
| `assignment_liquidated` | Desktop→Backend→Mobile | `{ branchId, repartidorId, repartidorName, itemCount, totalAmount, paymentMethod, timestamp }` | EMIT+ON | ON |
| `repartidor:assignment-created` | Desktop→Backend→Mobile | `{ branchId, assignment: { employeeId, quantity }, timestamp }` | EMIT | - |
| `repartidor:return-created` | Desktop→Backend→Mobile | `{ branchId, return: {...}, repartidorId, quantity, source, timestamp }` | EMIT | ON |
| `repartidor:assignment-completed` | Mobile→Backend→Desktop | `{ assignmentId, repartidorId, tenantId, branchId, kilosVendidos, kilosDevueltos, completedAt }` | EMIT+ON | - |

## EXPENSES

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `expense_assigned` | Desktop→Backend→Mobile | `{ expenseId, employeeId, employeeName, amount, category, description, timestamp }` | - | ON |
| `expense_approved` | Desktop→Backend→Mobile | `{ globalId, branchId, employeeId, amount, category, description, approvedByEmployeeName, timestamp }` | - | ON |
| `expense_edited` | Desktop→Backend→Mobile | `{ globalId, branchId, employeeId, oldAmount, newAmount, oldDescription, newDescription, reason, editedByEmployeeName, timestamp }` | - | ON |
| `expense_deleted` | Desktop→Backend→Mobile | `{ globalId, tenantId, employeeGlobalId, deletedAt }` | - | ON |
| `expense_rejected` | Desktop→Backend→Mobile | `{ globalId, branchId, employeeId, amount, category, reason, rejectedByEmployeeName, timestamp }` | - | ON |
| `repartidor:expense-created` | Mobile→Backend→Desktop | `{ branchId, repartidorId, amount, category, description, expenseId }` | ON | - |

## EMPLOYEES

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `employee:updated` | REST→Backend→Both | `{ employeeId, fullName, email, roleId, canUseMobileApp, isActive, emailVerified, updatedAt, source }` | ON | ON |
| `employee:role-updated` | REST→Backend→Mobile | `{ globalId, employeeId, newRoleId, newRoleName, mobileAccessType, tenantId, updatedAt }` | - | ON |
| `employee:access_revoked` | Backend→Mobile | `{ employeeId, employeeName, reason, timestamp }` | - | ON |
| `admin:permissions_updated` | REST→Backend→Mobile | `{ employeeId, mobilePermissions: [], timestamp }` | - | ON |
| `employee:update-photo` | Desktop→Backend (DB) | `{ employeeId, profilePhotoUrl }` | EMIT | - |
| `employee_branch:updated` | REST→Backend→Desktop | `{ employeeId, branchId, isActive, action, timestamp }` | ON | - |
| `cliente_branch:updated` | REST→Backend→Desktop | `{ ... }` | ON | - |
| `user-login` | Desktop→Backend→Desktop | `{ employeeId, employeeName, employeeRole, branchId, timestamp, scaleStatus }` | EMIT+ON | ON |

## PREPARATION MODE

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `preparation_mode_activated` | Desktop→Backend→Mobile | `{ tenantId, branchId, branchName, operatorEmployeeId, operatorName, authorizedByEmployeeId, authorizerName, reason, activatedAt, globalId }` | EMIT | ON |
| `preparation_mode_deactivated` | Desktop→Backend→Mobile | `{ tenantId, branchId, branchName, operatorName, durationFormatted, durationSeconds, severity, deactivatedAt, reason, globalId, weighingCycleCount, totalWeightKg }` | EMIT | ON |
| `manual_weight_override_changed` | Desktop→Backend (FCM) | `{ tenantId, branchId, branchName, employeeName, isActivated, timestamp }` | EMIT | - |

## TRANSFERS

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `transfer:received` | REST→Backend→Both | `{ transferId, globalId, fromBranchId, fromBranchName, toBranchId, toBranchName, items[], createdAt }` | ON | ON |
| `transfer:sent` | REST→Backend | `{ ... }` (same as received) | - | - |
| `transfer:cancelled` | REST→Backend→Desktop | `{ transferId, globalId, fromBranchId, toBranchId, reason, cancelledAt }` | ON | - |

## CASH DRAWER (Repartidor)

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `cashier:drawer-opened-by-repartidor` | Mobile→Backend→Desktop | `{ branchId, repartidorId, initialAmount }` | ON | - |
| `cashier:drawer-closed` | Mobile→Backend→Desktop | `{ branchId, repartidorId, drawerId, finalAmount }` | ON | - |
| `cashier:drawer-opened` | Desktop→Backend | `{ drawerId, repartidorId, tenantId, branchId, initialAmount, openedAt }` | EMIT | - |

## BACKUP & ANNOUNCEMENTS

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `backup:request` | Mobile→Backend→Desktop | `{ branchId, tenantId, mobileSocketId }` | ON | - |
| `backup:result` | Desktop→Backend→Mobile | `{ mobileSocketId, success, message }` | EMIT | ON |
| `branch:announcement` | Mobile→Backend→Desktop | `{ branchId, message, senderName }` | ON | - |
| `system:announcement` | Backend→Desktop | `{ title, htmlContent, type, sentAt }` | ON | - |

## BRANCH INFO

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `branch_info_updated` | REST→Backend→Both | `{ branchId, tenantId, name, address, phone, rfc, logoUrl, updatedAt, receivedAt }` | ON | ON |
| `branch_settings_changed` | REST→Backend→Mobile | `{ branchId, settings: {...} }` | - | ON |

## GPS & GEOFENCE

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `repartidor:location_update` | REST→Backend→Mobile | `{ employeeId, branchId, latitude, longitude, accuracy, speed, recordedAt, mapIcon }` | - | ON |
| `geofence:enter` | REST→Backend→Mobile | `{ employeeId, employeeName, zoneId, zoneName, branchId, distance, timestamp }` | - | ON |
| `geofence:exit` | REST→Backend→Mobile | `{ employeeId, employeeName, zoneId, zoneName, branchId, distance, timestamp }` | - | ON |
| `geofence:zone_updated` | REST→Backend→Mobile | `{ id, branch_id, name, latitude, longitude, radius_meters, is_active }` | - | ON |
| `geofence:assignments_changed` | REST→Backend→Mobile | `{ zoneId, zoneName, action, employeeIds, timestamp }` | - | ON |

## INFRASTRUCTURE

| Event | Direction | Payload | Desktop | Mobile |
|-------|-----------|---------|---------|--------|
| `join_branch` | Client→Backend | `branchId` (number) | EMIT | EMIT |
| `join_all_branches` | Client→Backend | `branchIds` (array) | EMIT | EMIT |
| `identify_client` | Client→Backend | `{ type: 'desktop'\|'mobile' }` | EMIT | EMIT |
| `joined_branch` | Backend→Client | confirmation | - | ON |
| `auth_error` | Backend→Client | `{ message }` | - | ON (diag) |
| `ping_check`/`pong_check` | Desktop↔Backend | `{ ts }` | EMIT+ON | - |

---

## IMPORTANT: Data Type Rules

All payloads use **camelCase** field names. Numeric IDs are **integers** (not strings).

### Common Pitfall: Socket.IO List Wrapping
Socket.IO can wrap payloads in an array `[{...}]`. **All handlers must use:**
```dart
// Flutter
final map = Map<String, dynamic>.from((data is List ? data.first : data) as Map);
```
```csharp
// C# (already handled by SocketIOClient library)
```

### Field Type Contract
| Field | Type | Notes |
|-------|------|-------|
| `branchId` | int | Never string |
| `tenantId` | int | Never string |
| `employeeId` | int | PostgreSQL ID |
| `repartidorId` | int | PostgreSQL employee ID |
| `timestamp` | string (ISO 8601) | `new Date().toISOString()` |
| `amount`, `total`, `quantity` | number (float) | May come as string from PostgreSQL NUMERIC — use `_safeDouble()` |
| `globalId` | string (UUID) | `uuid.v4()` format |
