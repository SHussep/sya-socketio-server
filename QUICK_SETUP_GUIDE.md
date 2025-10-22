# ⚡ Guía Rápida de Setup - Sistema de Asignaciones a Repartidores

**Estado**: Backend desplegado ✅ | Necesita migración SQL ⏳ | Desktop/Mobile pendiente

---

## 🚀 PASO 1: Ejecutar Migración SQL (CRÍTICO)

El código del backend está desplegado pero **las tablas no existen aún en PostgreSQL**.

### Opción A: A través de Render Console (RECOMENDADO)

1. Ve a https://dashboard.render.com
2. Selecciona tu servicio PostgreSQL
3. Haz clic en "Console"
4. Copia el contenido de `MIGRATION_REPARTIDOR_ASSIGNMENTS.sql`
5. Pégalo en la consola
6. Ejecuta (presiona Enter)

```sql
-- Paste MIGRATION_REPARTIDOR_ASSIGNMENTS.sql content here
CREATE TABLE IF NOT EXISTS repartidor_assignments (
  ...
);
```

### Opción B: Usar pgAdmin (Si tienes instalado)

1. Abre pgAdmin
2. Conecta a tu PostgreSQL remota
3. Abre "Query Tool"
4. Copia y pega `MIGRATION_REPARTIDOR_ASSIGNMENTS.sql`
5. Ejecuta (F5 o botón Execute)

### Opción C: Usando comando psql

```bash
# Si tienes DATABASE_URL configurada
psql $DATABASE_URL < MIGRATION_REPARTIDOR_ASSIGNMENTS.sql
```

---

## ✅ VERIFICAR MIGRACIÓN

```bash
# Conectar a PostgreSQL y verificar tablas
psql $DATABASE_URL -c "\dt repartidor*"

# Debe mostrar:
# ├─ repartidor_assignments
# ├─ repartidor_liquidations
# └─ repartidor_debts
```

O usar este curl:

```bash
curl -X POST "https://sya-socketio-server.onrender.com/api/repartidor-assignments" \
  -H "Content-Type: application/json" \
  -d '{
    "sale_id": 1,
    "employee_id": 1,
    "branch_id": 1,
    "tenant_id": 1,
    "cantidad_asignada": 10.0,
    "monto_asignado": 500.00
  }'
```

Si retorna `success: true`, significa que las tablas existen ✅

---

## 📊 PASO 2: Probar Endpoints (Después de migración)

### Crear Asignación

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
    "observaciones": "Prueba"
  }'
```

### Listar Asignaciones

```bash
curl -X GET "https://sya-socketio-server.onrender.com/api/repartidor-assignments/employee/5"
```

### Liquidar Asignación

```bash
curl -X POST "https://sya-socketio-server.onrender.com/api/repartidor-assignments/1/liquidate" \
  -H "Content-Type: application/json" \
  -d '{
    "cantidad_devuelta": 10.0,
    "monto_devuelto": 500.00,
    "total_gastos": 100.00,
    "neto_a_entregar": 1900.00,
    "diferencia_dinero": 0
  }'
```

---

## 🖥️ PASO 3: Desktop (C# WinUI) - PENDIENTE

**ESTADO**: No implementado aún

**QUE FALTA**:
1. Crear modelos `RepartidorAssignment.cs` y `LiquidacionEvent.cs`
2. Agregar métodos sync en `UnifiedSyncService.cs`
3. Modificar `LiquidacionViewModel.cs` para sincronizar
4. Probar que Desktop envía asignaciones a Backend

**IMPACTO**: Sin esto, Desktop no puede enviar datos a PostgreSQL. Las asignaciones solo quedan en BD local.

---

## 📱 PASO 4: Mobile (Flutter) - PENDIENTE

**ESTADO**: No implementado aún

**QUE FALTA**:
1. Crear modelos Flutter para asignaciones
2. Crear `RepartidorAssignmentService`
3. Crear UI `AssignmentsPage`
4. Integrar en Dashboard
5. Probar consultas en tiempo real

**IMPACTO**: Sin esto, app móvil no puede ver asignaciones activas. No hay visibilidad de kilos asignados/devueltos/vendidos.

---

## 📈 Estado Actual

```
✅ Backend (Node.js)        - Desplegado en Render
   ├─ Código: ✅ Pusheado
   ├─ Endpoints: ✅ Disponibles (si migración se ejecuta)
   └─ Socket.IO: ✅ Listo

⏳ PostgreSQL (Migración)    - PENDIENTE
   ├─ Tablas: ❌ No existen aún
   └─ Necesita: Ejecutar MIGRATION_REPARTIDOR_ASSIGNMENTS.sql

❌ Desktop (C# WinUI)        - NO IMPLEMENTADO
   ├─ Modelos: ❌ No existen
   ├─ Sync: ❌ No sincroniza
   └─ Impacto: Asignaciones no se envían a Backend

❌ Mobile (Flutter)          - NO IMPLEMENTADO
   ├─ Service: ❌ No existe
   ├─ UI: ❌ No existe
   └─ Impacto: No hay visibilidad en app móvil
```

---

## ⏱️ TIEMPO ESTIMADO

| Tarea | Tiempo |
|-------|--------|
| Ejecutar migración SQL | 5 min ✅ |
| Implementar Desktop | 2-3 horas |
| Implementar Mobile | 3-4 horas |
| Testing integral | 1-2 horas |
| **TOTAL** | **6-10 horas** |

---

## 📞 Próximos Pasos

1. ✅ **AHORA**: Ejecutar `MIGRATION_REPARTIDOR_ASSIGNMENTS.sql` en PostgreSQL
2. ⏳ **LUEGO**: Implementar Desktop (C#)
3. ⏳ **DESPUÉS**: Implementar Mobile (Flutter)
4. ✅ **FINALMENTE**: Testing completo

---

## 🔗 Referencias

- `MIGRATION_REPARTIDOR_ASSIGNMENTS.sql` - Script SQL de migración
- `routes/repartidor_assignments.js` - Código de endpoints
- `INSTRUCTIONS_REPARTIDOR_ASSIGNMENTS.md` - Guía detallada de implementación
- `REPARTIDOR_ASSIGNMENTS_IMPLEMENTATION_SUMMARY.md` - Resumen técnico

---

**Creado**: 2025-10-22
**Última actualización**: 2025-10-22
**Status**: Esperando migración SQL
