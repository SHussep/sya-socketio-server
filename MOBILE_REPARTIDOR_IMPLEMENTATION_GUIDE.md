# 📱 Mobile (Flutter) - Repartidor Dashboard Implementation Guide

## Contexto

La aplicación Mobile es usada por los **Repartidores** para:
- Ver sus **kilos asignados** (asignados por el gerente/owner en Desktop)
- **Registrar gastos** durante su turno
- **Ver sus entregas** asignadas y actualizar estados
- **Hacer un corte de caja** al final del turno
- (Futuro) Compartir su **ubicación en tiempo real** mientras está en turno

---

## Arquitectura

### Tech Stack Actual
- **Framework**: Flutter (Dart)
- **Backend API**: Node.js/Express en Render (PostgreSQL)
- **Local Storage**: SQLite (para offline-first)
- **Real-time**: Socket.IO (opcional, para ubicación en tiempo real)

### Flujo de Datos

```
Repartidor inicia sesión
    ↓
Mobile llama: GET /api/employees/:id (obtiene perfil + permisos)
    ↓
Mobile valida Permissions (incluye 'VIEW_OWN_DELIVERIES')
    ↓
Repartidor ve Dashboard con:
    - Kilos asignados
    - Entregas pendientes
    - Gastos registrados hoy
    ↓
Repartidor registra gasto:
    - POST /api/employees/:id/expenses
    - Desktop "baja" gastos vía sincronización
    ↓
Al final del turno: Corte de caja
    - POST /api/employees/:id/daily-cut
    - Backend crea resumen del día
    - Desktop lo sincroniza
```

---

## Endpoints Requeridos en Backend (Ya implementados o a agregar)

### 1. Login + Obtener Permisos
**GET /api/employees/:id**

Respuesta:
```json
{
  "success": true,
  "data": {
    "id": 123,
    "fullName": "Juan Repartidor",
    "email": "juan@example.com",
    "role": {
      "id": 2,
      "name": "Repartidor",
      "permissions": ["VIEW_OWN_SALES", "VIEW_OWN_DELIVERIES", "UPDATE_DELIVERY_STATUS", "CREATE_EXPENSE", "VIEW_OWN_EXPENSES"]
    }
  }
}
```

### 2. Obtener Entregas Asignadas
**GET /api/employees/:id/assigned-deliveries**

Parámetros:
- `status`: (opcional) "pending", "in_route", "delivered"
- `date`: (opcional) "2024-11-01"

Respuesta:
```json
{
  "success": true,
  "data": [
    {
      "id": 456,
      "customerId": 789,
      "customerName": "Don Pepe",
      "address": "Calle Principal 123",
      "kilos": 50,
      "status": "pending",
      "notes": "Dejar en puerta",
      "assignedAt": "2024-11-01T08:00:00Z",
      "deliveredAt": null,
      "location": {
        "latitude": 25.1234,
        "longitude": -77.5678
      }
    }
  ]
}
```

### 3. Registrar/Crear Gasto
**POST /api/employees/:id/expenses**

Request:
```json
{
  "tenantId": 6,
  "description": "Combustible",
  "amount": 50.00,
  "category": "fuel",
  "date": "2024-11-01"
}
```

Respuesta:
```json
{
  "success": true,
  "data": {
    "id": 999,
    "employeeId": 123,
    "description": "Combustible",
    "amount": 50.00,
    "category": "fuel",
    "date": "2024-11-01",
    "createdAt": "2024-11-01T12:30:00Z"
  }
}
```

### 4. Obtener Gastos del Repartidor
**GET /api/employees/:id/expenses**

Parámetros:
- `date`: (opcional) "2024-11-01"
- `limit`: (opcional, default 50)

Respuesta:
```json
{
  "success": true,
  "data": [
    {
      "id": 999,
      "employeeId": 123,
      "description": "Combustible",
      "amount": 50.00,
      "category": "fuel",
      "date": "2024-11-01",
      "createdAt": "2024-11-01T12:30:00Z"
    }
  ],
  "total": 150.00,
  "count": 3
}
```

### 5. Actualizar Estado de Entrega
**PATCH /api/employees/:id/deliveries/:deliveryId**

Request:
```json
{
  "tenantId": 6,
  "status": "delivered",
  "notes": "Entregado en mano al cliente",
  "location": {
    "latitude": 25.1234,
    "longitude": -77.5678
  }
}
```

Respuesta:
```json
{
  "success": true,
  "data": {
    "id": 456,
    "status": "delivered",
    "deliveredAt": "2024-11-01T14:30:00Z"
  }
}
```

### 6. Hacer Corte de Caja
**POST /api/employees/:id/daily-cut**

Request:
```json
{
  "tenantId": 6,
  "cutDate": "2024-11-01",
  "totalKilos": 500,
  "totalExpenses": 150.00,
  "deliveriesCompleted": 10,
  "deliveriesPending": 0,
  "notes": "Día normal, sin incidentes"
}
```

Respuesta:
```json
{
  "success": true,
  "data": {
    "id": 777,
    "employeeId": 123,
    "cutDate": "2024-11-01",
    "totalKilos": 500,
    "totalExpenses": 150.00,
    "deliveriesCompleted": 10,
    "deliveriesPending": 0,
    "createdAt": "2024-11-01T18:00:00Z"
  }
}
```

---

## Pantallas del Repartidor (Flutter)

### 1. **Login Screen** (ya existe probablemente)
- Email + Password
- Login contra Desktop (SQLite) + Backend (PostgreSQL)
- Obtiene permisos del servidor

### 2. **Dashboard** (NUEVA - principal)
```
┌─────────────────────────────────┐
│ Hola, Juan                      │
│ Bienvenido, Repartidor         │
├─────────────────────────────────┤
│ 📦 Kilos Asignados              │
│ [        500 kg        ]        │
├─────────────────────────────────┤
│ 📍 Mi Repartos                  │
│ [  Ver mis entregas  ]          │
│ (10 pendientes)                 │
├─────────────────────────────────┤
│ 💰 Gastos Hoy                   │
│ [    $150.00 (3)    ]           │
│ [  Registrar gasto  ]           │
├─────────────────────────────────┤
│ ✂️  Corte de Caja               │
│ [   Hacer corte    ]            │
└─────────────────────────────────┘
```

**Funcionalidad:**
- GET /api/employees/:id (perfil)
- GET /api/employees/:id/assigned-deliveries (kilos/entregas)
- GET /api/employees/:id/expenses (gastos)
- Logout

### 3. **Mis Entregas** (NUEVA)
```
┌─────────────────────────────────┐
│ < Mis Entregas                  │
├─────────────────────────────────┤
│ [✓ Entregadas] [⏳ Pendientes]  │
├─────────────────────────────────┤
│ 1. Don Pepe                     │
│    📍 Calle Principal 123       │
│    📦 50 kg                     │
│    Status: Pendiente            │
│    [Ver detalles]               │
│                                 │
│ 2. Doña María                  │
│    📍 Av. Central 456           │
│    📦 30 kg                     │
│    Status: En ruta              │
│    [Actualizar estado]          │
└─────────────────────────────────┘
```

**Funcionalidad:**
- GET /api/employees/:id/assigned-deliveries
- Filter por status
- PATCH /api/employees/:id/deliveries/:id (actualizar estado)
- Mostrar detalles (cliente, dirección, kilos, notas)

### 4. **Registrar Gasto** (NUEVA - modal o pantalla)
```
┌─────────────────────────────────┐
│ Registrar Gasto                 │
├─────────────────────────────────┤
│ Descripción:                    │
│ [________________]              │
│                                 │
│ Monto:                          │
│ [$________________]             │
│                                 │
│ Categoría:                      │
│ [▼ Combustible]                 │
│                                 │
│ Fecha:                          │
│ [2024-11-01]                    │
│                                 │
│ [Cancelar]  [Guardar]           │
└─────────────────────────────────┘
```

**Funcionalidad:**
- POST /api/employees/:id/expenses
- Categorías: combustible, comida, herramientas, otros
- Guardar localmente (offline-first)
- Sincronizar a backend cuando hay conexión

### 5. **Corte de Caja** (NUEVA)
```
┌─────────────────────────────────┐
│ Corte de Caja - 01/Nov         │
├─────────────────────────────────┤
│ Resumen del Día:                │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│ Kilos entregados:  500 kg       │
│ Entregas:         10 ✓          │
│ Gastos registrados: $150.00     │
│                                 │
│ Notas (opcional):               │
│ [________________________]       │
│ [________________________]       │
│                                 │
│ [    Enviar Corte     ]         │
│ [    Cancelar         ]         │
└─────────────────────────────────┘
```

**Funcionalidad:**
- Mostrar resumen automático
- POST /api/employees/:id/daily-cut
- Envía a Backend
- Desktop lo sincroniza
- Muestra confirmación

---

## Modelo de Datos (Flutter)

```dart
class Repartidor {
  int id;
  String fullName;
  String email;
  List<String> permissions;  // Validar "CREATE_EXPENSE", "VIEW_OWN_DELIVERIES"

  DateTime loginAt;
  DateTime? logoutAt;
}

class Entrega {
  int id;
  int customerId;
  String customerName;
  String address;
  double kilos;
  String status;  // "pending", "in_route", "delivered"
  String? notes;
  DateTime? assignedAt;
  DateTime? deliveredAt;

  Location? location;
}

class Location {
  double latitude;
  double longitude;
  DateTime recordedAt;
}

class Gasto {
  int id;
  int employeeId;
  String description;
  double amount;
  String category;  // "fuel", "food", "tools", "other"
  DateTime date;
  DateTime createdAt;
  bool synced;  // local flag
}

class CorteDeCaja {
  int id;
  int employeeId;
  DateTime cutDate;
  double totalKilos;
  double totalExpenses;
  int deliveriesCompleted;
  int deliveriesPending;
  String? notes;
  DateTime createdAt;
  bool synced;
}
```

---

## Control de Acceso

### Validación de Permisos en Frontend

```dart
bool canViewDeliveries(List<String> permissions) {
  return permissions.contains('VIEW_OWN_DELIVERIES');
}

bool canRegisterExpense(List<String> permissions) {
  return permissions.contains('CREATE_EXPENSE');
}

bool canUpdateDeliveryStatus(List<String> permissions) {
  return permissions.contains('UPDATE_DELIVERY_STATUS');
}
```

### Respuestas del Backend si No Tiene Permisos

Si el repartidor **NO** tiene el permiso, el endpoint retorna **403 Forbidden**:

```json
{
  "success": false,
  "message": "No tiene permiso para registrar gastos",
  "code": "PERMISSION_DENIED"
}
```

---

## Sincronización y Offline-First

### Local SQLite
```
employees:
  - id, fullName, email, roleId, permissions

deliveries:
  - id, customerId, customerName, address, kilos, status, synced, syncedAt

expenses:
  - id, description, amount, category, date, synced, syncedAt

daily_cuts:
  - id, cutDate, totalKilos, totalExpenses, synced, syncedAt
```

### Sync Strategy
1. **Gastos**: Se guardan localmente primero
   - POST /api/employees/:id/expenses
   - Si falla: reintentar cada 5 minutos
   - Si exito: marcar como synced

2. **Entregas**: Solo actualización de estado
   - PATCH /api/employees/:id/deliveries/:id
   - Similar retry logic

3. **Corte de Caja**: Una vez por día
   - POST /api/employees/:id/daily-cut
   - No se permite enviar dos cortes el mismo día

---

## Instalación de Dependencias Flutter

```yaml
# pubspec.yaml

dependencies:
  flutter:
    sdk: flutter

  # HTTP & API
  http: ^1.1.0
  dio: ^5.0.0

  # Local Storage
  sqflite: ^2.2.0
  path: ^1.8.0

  # JSON Serialization
  json_serializable: ^6.6.0
  json_annotation: ^4.8.0

  # State Management
  provider: ^6.0.0

  # DateTime & Timezone
  intl: ^0.19.0
  timezone: ^0.9.0

  # Real-time (opcional)
  socket_io_client: ^2.0.0

  # UI
  cupertino_icons: ^1.0.2
  material_design_icons_flutter: ^7.0.0

  # Logging
  logger: ^2.0.0

dev_dependencies:
  flutter_test:
    sdk: flutter

  build_runner: ^2.3.0
  json_serializable: ^6.6.0
```

---

## Estructura del Proyecto Flutter

```
lib/
├── models/
│   ├── repartidor.dart
│   ├── entrega.dart
│   ├── gasto.dart
│   ├── corte_caja.dart
│   └── location.dart
│
├── services/
│   ├── api_service.dart
│   ├── database_service.dart
│   ├── sync_service.dart
│   └── auth_service.dart
│
├── providers/
│   ├── repartidor_provider.dart
│   ├── entregas_provider.dart
│   ├── gastos_provider.dart
│   └── sync_provider.dart
│
├── screens/
│   ├── login_screen.dart
│   ├── dashboard_screen.dart
│   ├── entregas_screen.dart
│   ├── gasto_form_screen.dart
│   ├── corte_caja_screen.dart
│   └── perfil_screen.dart
│
├── widgets/
│   ├── entrega_card.dart
│   ├── gasto_card.dart
│   ├── corte_resumen.dart
│   └── sync_status_indicator.dart
│
└── main.dart
```

---

## Próximos Pasos (Prioritarios)

### Semana 1
- [ ] Agregar endpoints faltantes en Backend Node.js
  - POST /api/employees/:id/expenses
  - GET /api/employees/:id/expenses
  - GET /api/employees/:id/assigned-deliveries
  - PATCH /api/employees/:id/deliveries/:id
  - POST /api/employees/:id/daily-cut

- [ ] Crear estructura base de Flutter app
- [ ] Implementar ApiService para llamadas HTTP

### Semana 2
- [ ] Dashboard screen
- [ ] Entregas screen
- [ ] Gasto form screen

### Semana 3
- [ ] Corte de caja screen
- [ ] Sync logic (local SQLite)
- [ ] Testing & bug fixes

---

## Consideraciones Especiales

### 1. Offline-First
Los repartidores pueden perder conectividad mientras entregan:
- Guardar gastos en SQLite local
- Sincronizar cuando vuelva la conexión
- Mostrar indicador de sync status

### 2. Timezone
Usar timezone del tenant (ej: America/Chicago)
- Los gastos/entregas usan fecha local, no UTC
- El backend debe respetar este timezone

### 3. Ubicación en Tiempo Real (Futuro)
```dart
// Para después
if (permissions.contains('SHARE_LOCATION')) {
  startLocationTracking();  // enviando lat/long cada 5 min
}
```

### 4. Validación de Permisos
SIEMPRE validar en frontend + backend:
```dart
if (!permissions.contains('CREATE_EXPENSE')) {
  showError("No tienes permiso para registrar gastos");
  return;
}
```

---

**Este es el plan completo para implementar el dashboard del Repartidor en Flutter.**

