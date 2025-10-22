# 📦 Sistema de Asignaciones a Repartidores - Instrucciones de Implementación

## 🔍 Resumen

Este documento proporciona instrucciones para implementar el sistema completo de sincronización de asignaciones a repartidores (Mistress Ador) en SYA Tortillerías.

El sistema permite:
- ✅ Asignar kilos a repartidores y registrar en PostgreSQL
- ✅ Procesar devoluciones y liquidaciones
- ✅ Sincronizar cambios de estado desde Desktop
- ✅ Consultar asignaciones activas en tiempo real desde Mobile
- ✅ Generar reportes de liquidaciones por sucursal

---

## 📋 Componentes Implementados

### 1. Backend (Node.js + Express)

**Archivo**: `routes/repartidor_assignments.js`

**Nuevos Endpoints**:
```
POST   /api/repartidor-assignments                      - Crear asignación
POST   /api/repartidor-assignments/:id/liquidate        - Liquidar asignación
GET    /api/repartidor-assignments/employee/:employeeId - Obtener asignaciones
GET    /api/repartidor-liquidations/employee/:employeeId - Obtener liquidaciones
GET    /api/repartidor-liquidations/branch/:branchId/summary - Resumen por sucursal
```

**Cambios en server.js**:
- Importación de rutas: línea 55
- Inicialización con socket.io: líneas 2741-2746

### 2. Base de Datos PostgreSQL

**Archivo**: `MIGRATION_REPARTIDOR_ASSIGNMENTS.sql`

**Tablas Creadas**:
1. `repartidor_assignments` - Asignaciones individuales de kilos
2. `repartidor_liquidations` - Eventos de liquidación
3. `repartidor_debts` - Deudas de repartidores

---

## 🚀 Pasos de Implementación

### PASO 1: Ejecutar Migración SQL en PostgreSQL

Opción A - Si tiene acceso a psql local:
```bash
psql -h localhost -U usuario -d syatortillerias < MIGRATION_REPARTIDOR_ASSIGNMENTS.sql
```

Opción B - A través de Render Dashboard (RECOMENDADO):
1. Ir a https://dashboard.render.com
2. Seleccionar tu servicio PostgreSQL
3. Ir a "Console"
4. Copiar y pegar el contenido de `MIGRATION_REPARTIDOR_ASSIGNMENTS.sql`
5. Ejecutar

Opción C - A través de PgAdmin:
1. Abrir PgAdmin
2. Conectar a tu base de datos PostgreSQL remota
3. Abrir "Query Tool"
4. Copiar y pegar el contenido de `MIGRATION_REPARTIDOR_ASSIGNMENTS.sql`
5. Ejecutar (F5 o botón Execute)

### PASO 2: Deploy del Backend a Render

1. Commit de cambios en Git:
```bash
git add -A
git commit -m "Feat: Add repartidor assignments synchronization system"
git push origin main
```

2. Render redesplegará automáticamente

3. Verificar que los nuevos endpoints estén disponibles:
```bash
curl https://sya-socketio-server.onrender.com/health
```

### PASO 3: Implementar Desktop C# (Siguientes pasos)

Ver sección "Implementación Desktop" abajo.

### PASO 4: Implementar Mobile Flutter (Siguientes pasos)

Ver sección "Implementación Mobile" abajo.

---

## 🖥️ Implementación Desktop (C# WinUI) - EN PROGRESO

### Modelos a Crear

**`Models/RepartidorAssignment.cs`**:
```csharp
public class RepartidorAssignment
{
    public int Id { get; set; }
    public int SaleId { get; set; }
    public int EmployeeId { get; set; }
    public int BranchId { get; set; }
    public int TenantId { get; set; }

    public double CantidadAsignada { get; set; }
    public double CantidadDevuelta { get; set; }
    public double CantidadVendida => CantidadAsignada - CantidadDevuelta;

    public decimal MontoAsignado { get; set; }
    public decimal MontoDevuelto { get; set; }
    public decimal MontoVendido => MontoAsignado - MontoDevuelto;

    public string Estado { get; set; } // asignada, parcialmente_devuelta, completada, liquidada
    public DateTime FechaAsignacion { get; set; }
    public DateTime? FechaLiquidacion { get; set; }

    // Sync fields
    public bool Synced { get; set; }
    public int? RemoteId { get; set; }
}
```

**`Models/LiquidacionEvent.cs`**:
```csharp
public class LiquidacionEvent
{
    public int EmployeeId { get; set; }
    public int BranchId { get; set; }
    public int TenantId { get; set; }

    public double TotalKilosAsignados { get; set; }
    public double TotalKilosDevueltos { get; set; }
    public double TotalKilosVendidos => TotalKilosAsignados - TotalKilosDevueltos;

    public decimal MontoTotalAsignado { get; set; }
    public decimal MontoTotalDevuelto { get; set; }
    public decimal MontoTotalVendido => MontoTotalAsignado - MontoTotalDevuelto;

    public decimal TotalGastos { get; set; }
    public decimal NetoAEntregar { get; set; }
    public decimal DiferenciaDinero { get; set; }

    public DateTime FechaLiquidacion { get; set; }

    // Sync fields
    public bool Synced { get; set; }
    public int? RemoteId { get; set; }
}
```

### Métodos en UnifiedSyncService

En `Services/UnifiedSyncService.cs`, agregar:

```csharp
public async Task<bool> SyncRepartidorAssignmentAsync(RepartidorAssignment assignment)
{
    if (assignment.Synced) return true;

    try
    {
        var payload = new
        {
            sale_id = assignment.SaleId,
            employee_id = assignment.EmployeeId,
            branch_id = assignment.BranchId,
            tenant_id = assignment.TenantId,
            cantidad_asignada = assignment.CantidadAsignada,
            monto_asignado = assignment.MontoAsignado,
            turno_repartidor_id = assignment.TurnoRepartidorId,
            observaciones = assignment.Observaciones
        };

        var response = await _httpClient.PostAsJsonAsync(
            $"{_baseUrl}/api/repartidor-assignments",
            payload
        );

        if (response.IsSuccessStatusCode)
        {
            assignment.Synced = true;
            assignment.RemoteId = /* extraer de response */;
            return true;
        }
        return false;
    }
    catch (Exception ex)
    {
        Debug.WriteLine($"Error syncing assignment: {ex.Message}");
        return false;
    }
}

public async Task<bool> SyncLiquidacionAsync(LiquidacionEvent liquidacion)
{
    if (liquidacion.Synced) return true;

    try
    {
        var payload = new
        {
            assignment_id = liquidacion.AssignmentId,
            cantidad_devuelta = liquidacion.CantidadDevuelta,
            monto_devuelto = liquidacion.MontoDevuelto,
            total_gastos = liquidacion.TotalGastos,
            neto_a_entregar = liquidacion.NetoAEntregar,
            diferencia_dinero = liquidacion.DiferenciaDinero,
            observaciones = liquidacion.Observaciones
        };

        var response = await _httpClient.PostAsJsonAsync(
            $"{_baseUrl}/api/repartidor-assignments/{liquidacion.AssignmentId}/liquidate",
            payload
        );

        if (response.IsSuccessStatusCode)
        {
            liquidacion.Synced = true;
            return true;
        }
        return false;
    }
    catch (Exception ex)
    {
        Debug.WriteLine($"Error syncing liquidacion: {ex.Message}");
        return false;
    }
}
```

### Modificaciones en LiquidacionViewModel

En `ViewModels/LiquidacionViewModel.cs`, modificar `ProcessFullLiquidationAsync()`:

```csharp
// Después de insertar Devoluciones en la BD local
foreach (var devolution in returnsToInsert)
{
    await _unifiedSyncService.SyncReturnImmediatelyAsync(devolution);
}

// Crear y sincronizar evento de liquidación
var liquidacionEvent = new LiquidacionEvent
{
    EmployeeId = SelectedRepartidor.Id,
    BranchId = _currentBranchId,
    TenantId = _currentTenantId,
    TotalKilosAsignados = TotalKilosAsignados,
    TotalKilosDevueltos = TotalKilosDevueltos,
    MontoTotalAsignado = TotalValorAsignado,
    MontoTotalDevuelto = TotalValorDevuelto,
    TotalGastos = _gastosByType.Values.Sum(),
    NetoAEntregar = TotalAEntregar,
    DiferenciaDinero = Diferencia,
    FechaLiquidacion = DateTime.Now
};

await _unifiedSyncService.SyncLiquidacionAsync(liquidacionEvent);
```

---

## 📱 Implementación Mobile (Flutter) - EN PROGRESO

### Crear RepartidorAssignmentService

**`lib/services/repartidor_assignment_service.dart`**:
```dart
import 'package:dio/dio.dart';
import '../core/models/repartidor_assignment.dart';

class RepartidorAssignmentService {
  final Dio _dio;
  final String _baseUrl;

  RepartidorAssignmentService({
    required Dio dio,
    required String baseUrl,
  }) : _dio = dio, _baseUrl = baseUrl;

  /// Obtener asignaciones activas de un empleado
  Future<List<RepartidorAssignment>> getEmployeeAssignments({
    required int employeeId,
    int? branchId,
    int? tenantId,
  }) async {
    try {
      final queryParams = {
        'employee_id': employeeId.toString(),
        if (branchId != null) 'branch_id': branchId.toString(),
        if (tenantId != null) 'tenant_id': tenantId.toString(),
      };

      final response = await _dio.get(
        '$_baseUrl/api/repartidor-assignments/employee/$employeeId',
        queryParameters: queryParams,
      );

      if (response.statusCode == 200) {
        final data = response.data;
        if (data['success'] == true && data['data'] is List) {
          return (data['data'] as List)
              .map((item) => RepartidorAssignment.fromJson(item))
              .toList();
        }
      }
      return [];
    } catch (e) {
      print('Error fetching assignments: $e');
      return [];
    }
  }

  /// Obtener historial de liquidaciones
  Future<List<RepartidorLiquidation>> getDeliveryHistory({
    required int employeeId,
    int? branchId,
    int limit = 50,
    int offset = 0,
  }) async {
    try {
      final response = await _dio.get(
        '$_baseUrl/api/repartidor-liquidations/employee/$employeeId',
        queryParameters: {
          'limit': limit.toString(),
          'offset': offset.toString(),
          if (branchId != null) 'branch_id': branchId.toString(),
        },
      );

      if (response.statusCode == 200) {
        final data = response.data;
        if (data['success'] == true && data['data'] is List) {
          return (data['data'] as List)
              .map((item) => RepartidorLiquidation.fromJson(item))
              .toList();
        }
      }
      return [];
    } catch (e) {
      print('Error fetching delivery history: $e');
      return [];
    }
  }

  /// Obtener resumen de liquidaciones por sucursal
  Future<Map<String, dynamic>> getBranchSummary({
    required int branchId,
    int? tenantId,
    String? dateFrom,
    String? dateTo,
  }) async {
    try {
      final queryParams = {
        if (tenantId != null) 'tenant_id': tenantId.toString(),
        if (dateFrom != null) 'date_from': dateFrom,
        if (dateTo != null) 'date_to': dateTo,
      };

      final response = await _dio.get(
        '$_baseUrl/api/repartidor-liquidations/branch/$branchId/summary',
        queryParameters: queryParams,
      );

      if (response.statusCode == 200) {
        final data = response.data;
        if (data['success'] == true && data['data'] is Map) {
          return data['data'] as Map<String, dynamic>;
        }
      }
      return {};
    } catch (e) {
      print('Error fetching branch summary: $e');
      return {};
    }
  }
}
```

### Crear Modelos

**`lib/core/models/repartidor_assignment.dart`**:
```dart
class RepartidorAssignment {
  final int id;
  final int saleId;
  final int employeeId;
  final String employeeName;
  final int branchId;
  final String branchName;
  final double cantidadAsignada;
  final double cantidadDevuelta;
  final double cantidadVendida;
  final double montoAsignado;
  final double montoDevuelto;
  final double montoVendido;
  final String estado;
  final DateTime fechaAsignacion;
  final DateTime? fechaDevoluciones;
  final DateTime? fechaLiquidacion;
  final String? observaciones;

  RepartidorAssignment({
    required this.id,
    required this.saleId,
    required this.employeeId,
    required this.employeeName,
    required this.branchId,
    required this.branchName,
    required this.cantidadAsignada,
    required this.cantidadDevuelta,
    required this.cantidadVendida,
    required this.montoAsignado,
    required this.montoDevuelto,
    required this.montoVendido,
    required this.estado,
    required this.fechaAsignacion,
    this.fechaDevoluciones,
    this.fechaLiquidacion,
    this.observaciones,
  });

  factory RepartidorAssignment.fromJson(Map<String, dynamic> json) {
    return RepartidorAssignment(
      id: json['id'] ?? 0,
      saleId: json['sale_id'] ?? 0,
      employeeId: json['employee_id'] ?? 0,
      employeeName: json['employee_name'] ?? 'N/A',
      branchId: json['branch_id'] ?? 0,
      branchName: json['branch_name'] ?? 'N/A',
      cantidadAsignada: (json['cantidad_asignada'] as num?)?.toDouble() ?? 0.0,
      cantidadDevuelta: (json['cantidad_devuelta'] as num?)?.toDouble() ?? 0.0,
      cantidadVendida: (json['cantidad_vendida'] as num?)?.toDouble() ?? 0.0,
      montoAsignado: (json['monto_asignado'] as num?)?.toDouble() ?? 0.0,
      montoDevuelto: (json['monto_devuelto'] as num?)?.toDouble() ?? 0.0,
      montoVendido: (json['monto_vendido'] as num?)?.toDouble() ?? 0.0,
      estado: json['estado'] ?? 'asignada',
      fechaAsignacion: DateTime.parse(json['fecha_asignacion'] ?? DateTime.now().toIso8601String()),
      fechaDevoluciones: json['fecha_devoluciones'] != null ? DateTime.parse(json['fecha_devoluciones']) : null,
      fechaLiquidacion: json['fecha_liquidacion'] != null ? DateTime.parse(json['fecha_liquidacion']) : null,
      observaciones: json['observaciones'],
    );
  }
}

class RepartidorLiquidation {
  final int id;
  final int employeeId;
  final String employeeName;
  final int branchId;
  final String branchName;
  final double totalKilosAsignados;
  final double totalKilosDevueltos;
  final double totalKilosVendidos;
  final double montoTotalAsignado;
  final double montoTotalDevuelto;
  final double montoTotalVendido;
  final double totalGastos;
  final double netoAEntregar;
  final double diferenciaDinero;
  final DateTime fechaLiquidacion;
  final String? observaciones;

  RepartidorLiquidation({
    required this.id,
    required this.employeeId,
    required this.employeeName,
    required this.branchId,
    required this.branchName,
    required this.totalKilosAsignados,
    required this.totalKilosDevueltos,
    required this.totalKilosVendidos,
    required this.montoTotalAsignado,
    required this.montoTotalDevuelto,
    required this.montoTotalVendido,
    required this.totalGastos,
    required this.netoAEntregar,
    required this.diferenciaDinero,
    required this.fechaLiquidacion,
    this.observaciones,
  });

  factory RepartidorLiquidation.fromJson(Map<String, dynamic> json) {
    return RepartidorLiquidation(
      id: json['id'] ?? 0,
      employeeId: json['employee_id'] ?? 0,
      employeeName: json['employee_name'] ?? 'N/A',
      branchId: json['branch_id'] ?? 0,
      branchName: json['branch_name'] ?? 'N/A',
      totalKilosAsignados: (json['total_kilos_asignados'] as num?)?.toDouble() ?? 0.0,
      totalKilosDevueltos: (json['total_kilos_devueltos'] as num?)?.toDouble() ?? 0.0,
      totalKilosVendidos: (json['total_kilos_vendidos'] as num?)?.toDouble() ?? 0.0,
      montoTotalAsignado: (json['monto_total_asignado'] as num?)?.toDouble() ?? 0.0,
      montoTotalDevuelto: (json['monto_total_devuelto'] as num?)?.toDouble() ?? 0.0,
      montoTotalVendido: (json['monto_total_vendido'] as num?)?.toDouble() ?? 0.0,
      totalGastos: (json['total_gastos'] as num?)?.toDouble() ?? 0.0,
      netoAEntregar: (json['neto_a_entregar'] as num?)?.toDouble() ?? 0.0,
      diferenciaDinero: (json['diferencia_dinero'] as num?)?.toDouble() ?? 0.0,
      fechaLiquidacion: DateTime.parse(json['fecha_liquidacion'] ?? DateTime.now().toIso8601String()),
      observaciones: json['observaciones'],
    );
  }
}
```

---

## 📊 Verificación de Instalación

### 1. Verificar Tablas en PostgreSQL

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name LIKE 'repartidor%';
```

Debe retornar:
- repartidor_assignments
- repartidor_liquidations
- repartidor_debts

### 2. Verificar Endpoints

```bash
# Listar asignaciones de un empleado
curl -X GET "https://sya-socketio-server.onrender.com/api/repartidor-assignments/employee/1"

# Listar liquidaciones
curl -X GET "https://sya-socketio-server.onrender.com/api/repartidor-liquidations/employee/1"

# Obtener resumen de sucursal
curl -X GET "https://sya-socketio-server.onrender.com/api/repartidor-liquidations/branch/1/summary"
```

### 3. Prueba de Creación de Asignación

```bash
curl -X POST "https://sya-socketio-server.onrender.com/api/repartidor-assignments" \
  -H "Content-Type: application/json" \
  -d '{
    "sale_id": 123,
    "employee_id": 5,
    "branch_id": 1,
    "tenant_id": 1,
    "cantidad_asignada": 50.0,
    "monto_asignado": 2500.00,
    "turno_repartidor_id": 10,
    "observaciones": "Prueba de asignación"
  }'
```

---

## 🔧 Próximos Pasos

1. **Desktop (C#)**:
   - [ ] Crear modelos RepartidorAssignment y LiquidacionEvent
   - [ ] Implementar métodos de sync en UnifiedSyncService
   - [ ] Modificar LiquidacionViewModel para sincronizar
   - [ ] Probar flujo completo desde Desktop

2. **Mobile (Flutter)**:
   - [ ] Crear RepartidorAssignmentService
   - [ ] Crear modelos de asignaciones
   - [ ] Crear AssignmentsPage UI
   - [ ] Integrar con dashboard
   - [ ] Probar consultas en tiempo real

3. **Documentación**:
   - [ ] Crear guía de uso para usuarios
   - [ ] Documentar API completa

---

## 📞 Soporte

Si encuentras problemas:

1. Verifica que PostgreSQL esté actualizado con las nuevas tablas
2. Verifica que el backend esté desplegado con los nuevos endpoints
3. Revisa los logs en Render Dashboard
4. Verifica la conectividad de red

---

**Creado**: 2025-10-22
**Versión**: 1.0
**Estado**: En Implementación
