# 📱 Guía de API para Mobile App (Flutter/Dart)
## SYA Tortillerías - Backend PostgreSQL

---

## 📋 ÍNDICE

1. [Resumen del Backend](#resumen-del-backend)
2. [Convenciones de Naming](#convenciones-de-naming)
3. [Autenticación](#autenticación)
4. [Endpoints Principales](#endpoints-principales)
5. [Modelos de Datos](#modelos-de-datos)
6. [Ejemplos de Uso](#ejemplos-de-uso)
7. [Errores Comunes](#errores-comunes)
8. [Migración desde API Antigua](#migración-desde-api-antigua)

---

## 1. RESUMEN DEL BACKEND

### Estado Actual (Noviembre 2025)

**✅ Backend completamente refactorizado:**
- Schema limpio consolidado en `schema.sql`
- Sistema de migrations antiguo (100+ archivos) **ELIMINADO**
- Naming estandarizado: **ESPAÑOL en PostgreSQL**, English en Desktop/Mobile
- Offline-first con UUIDs (`global_id`, `terminal_id`)

### Arquitectura

```
┌─────────────────┐
│  Mobile App     │
│  (Flutter)      │
└────────┬────────┘
         │ HTTPS/REST
         ▼
┌─────────────────┐
│  Backend API    │
│  (Node.js)      │
│  Render.com     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  PostgreSQL     │
│  (Tablas en ES) │
└─────────────────┘
```

---

## 2. CONVENCIONES DE NAMING

### 🔴 CRÍTICO: Diferencia entre Mobile y PostgreSQL

| Contexto | Naming Convention | Ejemplo |
|----------|-------------------|---------|
| **PostgreSQL** | 🇪🇸 **ESPAÑOL** (snake_case) | `ventas`, `id_venta`, `fecha_venta_utc` |
| **Mobile App (Dart)** | 🇬🇧 English (camelCase) | `Sale`, `saleId`, `saleDate` |
| **API Request/Response** | 🇪🇸 **ESPAÑOL** (snake_case) | `{"id_venta": 1, "total": 6250}` |

### Tablas Principales (PostgreSQL)

| Tabla PostgreSQL | Descripción | ID Column |
|------------------|-------------|-----------|
| `ventas` | Ventas/Sales | `id_venta` |
| `ventas_detalle` | Items de venta | `id_venta_detalle` |
| `customers` | Clientes | `id` |
| `employees` | Empleados | `id` |
| `shifts` | Turnos | `id` |
| `repartidor_assignments` | Asignaciones a repartidores | `id` |
| `repartidor_returns` | Devoluciones | `id` |
| `credit_payments` | Pagos a crédito | `id` |

### Campos Comunes (PostgreSQL → Dart)

| PostgreSQL (español) | Dart (English) | Tipo |
|---------------------|----------------|------|
| `id_venta` | `saleId` | int |
| `id_cliente` | `customerId` | int? |
| `id_empleado` | `employeeId` | int |
| `id_turno` | `shiftId` | int |
| `ticket_number` | `ticketNumber` | int |
| `fecha_venta_utc` | `saleDate` | DateTime |
| `total` | `total` | double |
| `tipo_pago_id` | `paymentTypeId` | int |
| `estado_venta_id` | `saleStatusId` | int |

---

## 3. AUTENTICACIÓN

### Login con Credenciales

**Endpoint:** `POST /api/auth/mobile-credentials-login`

**Request:**
```json
{
  "email": "repartidor@example.com",
  "password": "password123"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "refresh_token_here",
  "employee": {
    "id": 5,
    "username": "repartidor",
    "email": "repartidor@example.com",
    "role_id": 3,
    "tenant_id": 1,
    "branch_id": 1,
    "can_use_mobile_app": true,
    "mobile_access_type": "distributor"
  }
}
```

### Headers para Requests Autenticados

```dart
headers: {
  'Authorization': 'Bearer $accessToken',
  'Content-Type': 'application/json',
}
```

### Renovar Token

**Endpoint:** `POST /api/auth/refresh-token`

**Request:**
```json
{
  "refresh_token": "refresh_token_here"
}
```

---

## 4. ENDPOINTS PRINCIPALES

### 📊 Dashboard

**Endpoint:** `GET /api/dashboard/summary`

**Query Params:**
```
?branch_id=1
&start_date=2025-11-01T00:00:00.000Z
&end_date=2025-11-30T23:59:59.999Z
```

**Response:**
```json
{
  "success": true,
  "data": {
    "total_sales": 125000.50,
    "total_expenses": 15000.00,
    "net": 110000.50,
    "last_cash_cut": {
      "id": 45,
      "cut_date": "2025-11-12T08:00:00.000Z",
      "difference": 0
    }
  }
}
```

**Estado:** ✅ ACTUALIZADO - Usa tabla `ventas`

---

### 💰 Ventas (Sales)

#### ⚠️ IMPORTANTE: Endpoint GET /api/sales NO ACTUALIZADO

**❌ NO USAR:** `GET /api/sales` - Aún usa tabla `sales` antigua que no existe.

**✅ ALTERNATIVA:** Crear endpoint nuevo `/api/mobile/sales` o actualizar el existente.

#### Estructura de Venta Correcta (tabla `ventas`)

```json
{
  "id_venta": 1,
  "tenant_id": 1,
  "branch_id": 1,
  "ticket_number": 1234,
  "id_empleado": 5,
  "id_turno": 10,
  "id_cliente": 3,
  "tipo_pago_id": 1,
  "venta_tipo_id": 2,
  "estado_venta_id": 3,
  "subtotal": 6000.00,
  "total_descuentos": 0,
  "total": 6000.00,
  "monto_pagado": 6000.00,
  "fecha_venta_utc": "2025-11-12T14:30:00.000Z",
  "notas": null,
  "status": "completed",
  "global_id": "a3b7defd-5cb5-42d6-8dee-273c07136442"
}
```

**Campos importantes:**

| Campo | Descripción | Valores |
|-------|-------------|---------|
| `tipo_pago_id` | Método de pago | 1=Efectivo, 2=Tarjeta, 3=Crédito |
| `venta_tipo_id` | Tipo de venta | 1=Mostrador, 2=Repartidor |
| `estado_venta_id` | Estado | 3=Completada, 4=Cancelada |
| `status` | Estado texto | 'completed', 'cancelled' |

---

### 🚚 Repartidor Assignments

#### GET - Obtener Asignaciones de Repartidor

**Endpoint:** `GET /api/repartidor-assignments/employee/:employeeId`

**Query Params:**
```
?tenant_id=1
&branch_id=1
&estado=pending
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "venta_id": 123,
      "employee_id": 5,
      "assigned_quantity": 250.00,
      "assigned_amount": 6250.00,
      "unit_price": 25.00,
      "status": "pending",
      "fecha_asignacion": "2025-11-12T08:00:00.000Z",
      "created_by_employee_id": 1,
      "shift_id": 10,
      "repartidor_shift_id": 11,
      "observaciones": null
    }
  ],
  "count": 1
}
```

**Estados disponibles:**
- `pending` - Pendiente de entregar
- `in_progress` - En ruta
- `liquidated` - Liquidado
- `cancelled` - Cancelado

**Estado:** ✅ ACTUALIZADO - Usa `venta_id` (español)

---

### 📦 Repartidor Returns

#### POST - Registrar Devolución

**Endpoint:** `POST /api/repartidor-returns/sync`

**Request:**
```json
{
  "tenant_id": 1,
  "branch_id": 1,
  "assignment_id": 1,
  "employee_id": 5,
  "registered_by_employee_id": 5,
  "shift_id": 11,
  "quantity": 10.00,
  "unit_price": 25.00,
  "amount": 250.00,
  "return_date": "2025-11-12T15:30:00.000Z",
  "source": "mobile",
  "notes": "Cliente cerrado",
  "global_id": "d0b34f1c-2a1f-4961-a19a-6bd227a18026",
  "terminal_id": "f88cc216-549e-4349-8f5f-551ab538f846",
  "local_op_seq": 1,
  "created_local_utc": "2025-11-12T15:30:00.000Z"
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "global_id": "d0b34f1c-2a1f-4961-a19a-6bd227a18026",
    "assignment_id": 1,
    "quantity": 10.00,
    "amount": 250.00
  },
  "message": "Devolución registrada exitosamente"
}
```

#### GET - Historial de Devoluciones

**Endpoint:** `GET /api/repartidor-returns/employee/:employeeId`

**Query Params:**
```
?tenant_id=1
&branch_id=1
&limit=50
&offset=0
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "assignment_id": 1,
      "venta_id": 123,
      "quantity": 10.00,
      "unit_price": 25.00,
      "amount": 250.00,
      "return_date": "2025-11-12T15:30:00.000Z",
      "source": "mobile",
      "notes": "Cliente cerrado",
      "registered_by_name": "Juan Pérez"
    }
  ],
  "count": 1,
  "pagination": {
    "limit": 50,
    "offset": 0
  }
}
```

**Estado:** ✅ ACTUALIZADO - Usa `venta_id` (español)

---

### 💳 Pagos a Crédito

#### POST - Registrar Pago

**Endpoint:** `POST /api/credit-payments/sync`

**Request:**
```json
{
  "tenant_id": 1,
  "branch_id": 1,
  "customer_id": 5,
  "shift_id": 10,
  "employee_id": 3,
  "amount": 500.00,
  "payment_method": "cash",
  "payment_date": "2025-11-12T16:00:00.000Z",
  "notes": "Abono parcial",
  "global_id": "e3f5a8b9-1234-5678-90ab-cdef12345678",
  "terminal_id": "f88cc216-549e-4349-8f5f-551ab538f846",
  "local_op_seq": 1,
  "created_local_utc": "2025-11-12T16:00:00.000Z"
}
```

**Valores payment_method:**
- `"cash"` - Efectivo
- `"card"` - Tarjeta

**Response (201 Created):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "customer_id": 5,
    "amount": 500.00,
    "payment_method": "cash",
    "new_balance": 1500.00
  },
  "message": "Pago registrado y saldo actualizado"
}
```

**⚠️ Importante:** El backend actualiza automáticamente `customers.saldo_deudor` con triggers.

---

### 👥 Clientes

#### GET - Buscar Clientes

**Endpoint:** `GET /api/customers/search`

**Query Params:**
```
?tenant_id=1
&branch_id=1
&q=Juan
&limit=20
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 5,
      "tenant_id": 1,
      "nombre": "Juan Pérez",
      "telefono": "1234567890",
      "direccion": "Calle Principal 123",
      "activo": true,
      "tiene_credito": true,
      "credito_limite": 5000.00,
      "saldo_deudor": 2000.00,
      "tipo_descuento": 1,
      "porcentaje_descuento": 10.00,
      "global_id": "customer-uuid-here"
    }
  ],
  "count": 1
}
```

#### GET - Clientes con Crédito

**Endpoint:** `GET /api/customers/with-credit`

**Query Params:**
```
?tenant_id=1
&branch_id=1
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 5,
      "nombre": "Juan Pérez",
      "saldo_deudor": 2000.00,
      "credito_limite": 5000.00,
      "credito_disponible": 3000.00
    }
  ]
}
```

---

## 5. MODELOS DE DATOS

### Venta (Sale)

```dart
class Sale {
  final int idVenta;
  final int tenantId;
  final int branchId;
  final int ticketNumber;
  final int employeeId;
  final int shiftId;
  final int? customerId;
  final int paymentTypeId;
  final int saleTypeId;
  final int saleStatusId;
  final double subtotal;
  final double totalDiscounts;
  final double total;
  final double amountPaid;
  final DateTime saleDate;
  final String? notes;
  final String status;
  final String globalId;

  Sale({
    required this.idVenta,
    required this.tenantId,
    required this.branchId,
    required this.ticketNumber,
    required this.employeeId,
    required this.shiftId,
    this.customerId,
    required this.paymentTypeId,
    required this.saleTypeId,
    required this.saleStatusId,
    required this.subtotal,
    required this.totalDiscounts,
    required this.total,
    required this.amountPaid,
    required this.saleDate,
    this.notes,
    required this.status,
    required this.globalId,
  });

  factory Sale.fromJson(Map<String, dynamic> json) {
    return Sale(
      idVenta: json['id_venta'],
      tenantId: json['tenant_id'],
      branchId: json['branch_id'],
      ticketNumber: json['ticket_number'],
      employeeId: json['id_empleado'],
      shiftId: json['id_turno'],
      customerId: json['id_cliente'],
      paymentTypeId: json['tipo_pago_id'],
      saleTypeId: json['venta_tipo_id'],
      saleStatusId: json['estado_venta_id'],
      subtotal: (json['subtotal'] as num).toDouble(),
      totalDiscounts: (json['total_descuentos'] as num).toDouble(),
      total: (json['total'] as num).toDouble(),
      amountPaid: (json['monto_pagado'] as num).toDouble(),
      saleDate: DateTime.parse(json['fecha_venta_utc']),
      notes: json['notas'],
      status: json['status'],
      globalId: json['global_id'],
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id_venta': idVenta,
      'tenant_id': tenantId,
      'branch_id': branchId,
      'ticket_number': ticketNumber,
      'id_empleado': employeeId,
      'id_turno': shiftId,
      'id_cliente': customerId,
      'tipo_pago_id': paymentTypeId,
      'venta_tipo_id': saleTypeId,
      'estado_venta_id': saleStatusId,
      'subtotal': subtotal,
      'total_descuentos': totalDiscounts,
      'total': total,
      'monto_pagado': amountPaid,
      'fecha_venta_utc': saleDate.toIso8601String(),
      'notas': notes,
      'status': status,
      'global_id': globalId,
    };
  }
}
```

### Repartidor Assignment

```dart
class RepartidorAssignment {
  final int id;
  final int tenantId;
  final int branchId;
  final int idVenta;
  final int employeeId;
  final int createdByEmployeeId;
  final int? shiftId;
  final int? repartidorShiftId;
  final double assignedQuantity;
  final double assignedAmount;
  final double unitPrice;
  final String status;
  final DateTime assignmentDate;
  final DateTime? settlementDate;
  final String? notes;
  final String globalId;

  RepartidorAssignment({
    required this.id,
    required this.tenantId,
    required this.branchId,
    required this.idVenta,
    required this.employeeId,
    required this.createdByEmployeeId,
    this.shiftId,
    this.repartidorShiftId,
    required this.assignedQuantity,
    required this.assignedAmount,
    required this.unitPrice,
    required this.status,
    required this.assignmentDate,
    this.settlementDate,
    this.notes,
    required this.globalId,
  });

  factory RepartidorAssignment.fromJson(Map<String, dynamic> json) {
    return RepartidorAssignment(
      id: json['id'],
      tenantId: json['tenant_id'],
      branchId: json['branch_id'],
      idVenta: json['venta_id'],  // Backend usa venta_id (foreign key)
      employeeId: json['employee_id'],
      createdByEmployeeId: json['created_by_employee_id'],
      shiftId: json['shift_id'],
      repartidorShiftId: json['repartidor_shift_id'],
      assignedQuantity: (json['assigned_quantity'] as num).toDouble(),
      assignedAmount: (json['assigned_amount'] as num).toDouble(),
      unitPrice: (json['unit_price'] as num).toDouble(),
      status: json['status'],
      assignmentDate: DateTime.parse(json['fecha_asignacion']),
      settlementDate: json['fecha_liquidacion'] != null
          ? DateTime.parse(json['fecha_liquidacion'])
          : null,
      notes: json['observaciones'],
      globalId: json['global_id'],
    );
  }
}
```

### Credit Payment

```dart
class CreditPayment {
  final int? id;
  final int tenantId;
  final int branchId;
  final int customerId;
  final int? shiftId;
  final int? employeeId;
  final double amount;
  final String paymentMethod; // 'cash' | 'card'
  final DateTime paymentDate;
  final String? notes;
  final String globalId;

  CreditPayment({
    this.id,
    required this.tenantId,
    required this.branchId,
    required this.customerId,
    this.shiftId,
    this.employeeId,
    required this.amount,
    required this.paymentMethod,
    required this.paymentDate,
    this.notes,
    required this.globalId,
  });

  factory CreditPayment.fromJson(Map<String, dynamic> json) {
    return CreditPayment(
      id: json['id'],
      tenantId: json['tenant_id'],
      branchId: json['branch_id'],
      customerId: json['customer_id'],
      shiftId: json['shift_id'],
      employeeId: json['employee_id'],
      amount: (json['amount'] as num).toDouble(),
      paymentMethod: json['payment_method'],
      paymentDate: DateTime.parse(json['payment_date']),
      notes: json['notes'],
      globalId: json['global_id'],
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'tenant_id': tenantId,
      'branch_id': branchId,
      'customer_id': customerId,
      'shift_id': shiftId,
      'employee_id': employeeId,
      'amount': amount,
      'payment_method': paymentMethod,
      'payment_date': paymentDate.toIso8601String(),
      'notes': notes,
      'global_id': globalId,
      'terminal_id': globalId, // UUID del dispositivo móvil
      'local_op_seq': 1,
      'created_local_utc': DateTime.now().toUtc().toIso8601String(),
    };
  }
}
```

---

## 6. EJEMPLOS DE USO

### Servicio API (Dart)

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

class SyaApiService {
  final String baseUrl = 'https://sya-socketio-server.onrender.com';
  String? _accessToken;

  // Login
  Future<bool> login(String email, String password) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/auth/mobile-credentials-login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'email': email,
        'password': password,
      }),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body);
      _accessToken = data['accessToken'];
      return true;
    }
    return false;
  }

  // Headers autenticados
  Map<String, String> _authHeaders() {
    return {
      'Authorization': 'Bearer $_accessToken',
      'Content-Type': 'application/json',
    };
  }

  // Obtener asignaciones de repartidor
  Future<List<RepartidorAssignment>> getAssignments(int employeeId) async {
    final response = await http.get(
      Uri.parse('$baseUrl/api/repartidor-assignments/employee/$employeeId'),
      headers: _authHeaders(),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body);
      return (data['data'] as List)
          .map((json) => RepartidorAssignment.fromJson(json))
          .toList();
    }
    throw Exception('Failed to load assignments');
  }

  // Registrar devolución
  Future<bool> registerReturn(RepartidorReturn returnData) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/repartidor-returns/sync'),
      headers: _authHeaders(),
      body: jsonEncode(returnData.toJson()),
    );

    return response.statusCode == 201;
  }

  // Registrar pago a crédito
  Future<bool> registerCreditPayment(CreditPayment payment) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/credit-payments/sync'),
      headers: _authHeaders(),
      body: jsonEncode(payment.toJson()),
    );

    return response.statusCode == 201;
  }
}
```

---

## 7. ERRORES COMUNES

### Error 401 - Unauthorized

```json
{
  "success": false,
  "message": "Token no proporcionado"
}
```

**Solución:** Incluir header `Authorization: Bearer <token>`

### Error 400 - Bad Request

```json
{
  "success": false,
  "message": "tenant_id, branch_id, id_venta requeridos"
}
```

**Solución:** Verificar que todos los campos requeridos estén presentes en el payload.

### Error 404 - Not Found

```json
{
  "success": false,
  "message": "Venta 123 no encontrada en tenant 1"
}
```

**Solución:** Verificar que la venta existe y que el `tenant_id` es correcto.

### Error 500 - Internal Server Error

```json
{
  "success": false,
  "message": "Error al sincronizar asignación de repartidor",
  "error": "column 'sale_id' does not exist"
}
```

**Solución:** Reportar al backend - probablemente un endpoint no actualizado.

---

## 8. MIGRACIÓN DESDE API ANTIGUA

### Cambios Críticos

| Antes (Tabla `sales`) | Ahora (Tabla `ventas`) |
|-----------------------|------------------------|
| `sales.id` | `ventas.id_venta` |
| `sales.total_amount` | `ventas.total` |
| `sales.sale_date` | `ventas.fecha_venta_utc` |
| `sales.payment_method` | `ventas.tipo_pago_id` |
| `sales.sale_type` | `ventas.venta_tipo_id` |
| `sales_items` | `ventas_detalle` |
| `repartidor_assignments.sale_id` | `repartidor_assignments.venta_id` |

### Endpoints Obsoletos ❌

Estos endpoints **NO deben usarse** - aún referencian tablas antiguas:

- `GET /api/sales` - Usa tabla `sales` (no existe)
- `GET /api/sales-items` - Usa VIEW `sales_items_with_details` (no existe)

### Endpoints Nuevos/Actualizados ✅

- `GET /api/dashboard/summary` - ✅ Usa `ventas`
- `GET /api/repartidor-assignments/employee/:id` - ✅ Usa `venta_id`
- `POST /api/repartidor-returns/sync` - ✅ Usa `venta_id`
- `POST /api/credit-payments/sync` - ✅ Nuevo
- `GET /api/customers/with-credit` - ✅ Nuevo

---

## 9. NOTAS PARA EL PROGRAMADOR

### Convenciones Importantes

1. **Naming PostgreSQL → Dart:**
   - PostgreSQL: `id_venta` (snake_case español)
   - Dart: `idVenta` (camelCase inglés)
   - JSON payload: `id_venta` (snake_case español)

2. **UUIDs Offline-First:**
   - Siempre incluir `global_id` (UUID) en requests
   - Incluir `terminal_id` (UUID del dispositivo)
   - Incluir `local_op_seq` (secuencia local)
   - Esto garantiza idempotencia

3. **Timestamps:**
   - Backend usa UTC siempre
   - Frontend debe convertir a timezone local para display
   - Enviar timestamps en formato ISO 8601

4. **Triggers Automáticos:**
   - `customers.saldo_deudor` se actualiza automáticamente
   - No necesitas calcularlo manualmente en mobile

### Próximos Pasos

1. **Crear endpoint nuevo:** `GET /api/mobile/sales`
   - Reemplazo de `/api/sales` GET
   - Debe usar tabla `ventas`
   - Incluir filtros por repartidor, fecha, estado

2. **Crear endpoint:** `GET /api/mobile/sales/:id/details`
   - Venta completa con items (`ventas_detalle`)
   - Para mostrar detalle de venta en app

3. **WebSockets (Socket.IO):**
   - Escuchar eventos en tiempo real:
     - `assignment_created` - Nueva asignación
     - `return_registered` - Nueva devolución
     - `payment_received` - Nuevo pago

### Contacto

Para dudas sobre la API, revisar:
- `schema.sql` - Schema completo de base de datos
- `seeds.sql` - Datos iniciales
- `routes/` - Implementación de endpoints

---

**Fecha última actualización:** 12 de Noviembre 2025
**Versión Backend:** 2.0.0 (Schema limpio)
**URL Backend:** https://sya-socketio-server.onrender.com
