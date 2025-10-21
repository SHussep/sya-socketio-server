# 🔴 Análisis: Transacciones Duplicadas - Ticket_Number

## Problema Identificado

En la sucursal **13 (El Canguro - Principal)**, los usuarios veían la misma venta duplicada en el Dashboard móvil.

### Ejemplo
```
Ticket 15 - 21/10/2025 14:45 - $18.00
Ticket 15 - 21/10/2025 14:45 - $18.00  ← APARECÍA REPETIDA
```

---

## Causa Raíz

**NO es un duplicado de ID** sino **duplicados de ticket_number**:

| ID | Ticket# | Monto | Hora | Fecha |
|----|---------|-------|------|-------|
| 37 | 15 | $45.00 | 14:45 | 21/10 |
| 41 | 15 | $18.00 | 14:50 | 21/10 |

**Dos ventas diferentes con el MISMO número de ticket.**

### Respuesta API Correcta
```json
{
  "success": true,
  "data": [
    {"id": 40, "ticket_number": 20, ...},
    {"id": 39, "ticket_number": 19, ...},
    {"id": 38, "ticket_number": 16, ...},
    {"id": 37, "ticket_number": 15, ...},    ← ticket_number: 15
    {"id": 41, "ticket_number": 15, ...}     ← ticket_number: 15 (DUPLICADO)
  ]
}
```

### Por Qué Se Mostraba Duplicado en UI

El Flutter vota renderizar ambas ventas porque tienen IDs diferentes (37 vs 41), pero como tienen el mismo ticket_number, se ven como "la misma venta repetida" al usuario.

---

## Raíz del Problema

### ¿Por Qué Hay Duplicados de Ticket_Number?

La tabla `sales` **NO TIENE RESTRICCIÓN UNIQUE** en `(tenant_id, branch_id, ticket_number)`.

Esto permite que:

1. **El Desktop App genere números duplicados** (contador local mal sincronizado)
2. **Una venta se sincronice 2 veces** con el mismo ticket_number
3. **Errores de concurrencia** en generación de ticket_number

### Lugar del Problema

**Desktop App (C# WinUI)** - Necesita investigar cómo genera ticket_number:
- ¿Es un contador simple?
- ¿Se reinicia al desconectar?
- ¿Se sincroniza con el servidor?

---

## Solución Implementada

### Paso 1: Crear Índice UNIQUE (Prevención)

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_ticket_per_branch
ON sales(tenant_id, branch_id, ticket_number)
WHERE deleted_at IS NULL;
```

**Esto:**
- ✅ Previene NUEVOS duplicados
- ⚠️ NO elimina los existentes
- 💪 Valida automáticamente en inserciones

### Paso 2: Limpiar Duplicados Existentes (Opcional)

```sql
DELETE FROM sales
WHERE id IN (
    SELECT id FROM (
        SELECT
            id,
            ROW_NUMBER() OVER (
                PARTITION BY tenant_id, branch_id, ticket_number
                ORDER BY created_at DESC
            ) as rn
        FROM sales
    ) t
    WHERE rn > 1
);
```

**Mantiene:** La venta MÁS ANTIGUA (probablemente la correcta)
**Elimina:** Las más nuevas (duplicados)

---

## Próximos Pasos

### 1. Ejecutar Migración
```bash
# En la BD de Render
# Copiar contenido de MIGRATE_ADD_UNIQUE_TICKET.sql
```

### 2. Investigar Desktop App
Revisar cómo genera `ticket_number`:
- `C:\Users\saul_\source\repos\SyaTortilleriasWinUi\SyaTortilleriasWinUi\ViewModels\VentasViewModel.cs`
- O donde se crea una venta

**Buscar:**
```csharp
ticketNumber = ... // ¿Cómo se genera?
```

**Debe:**
- Obtener el siguiente número del servidor (no localmente)
- O sincronizar con la BD antes de crear

### 3. Verificar Sincronización
Asegurar que si una venta ya existe, no se cree otra con el mismo ticket_number.

---

## Comandos para Verificar

### Ver duplicados actuales
```sql
SELECT ticket_number, COUNT(*) as count, array_agg(id) as ids
FROM sales
WHERE branch_id = 13
GROUP BY tenant_id, branch_id, ticket_number
HAVING COUNT(*) > 1;
```

### Ver todas las ventas de ticket 15
```sql
SELECT id, ticket_number, total_amount, sale_date
FROM sales
WHERE branch_id = 13 AND ticket_number = 15
ORDER BY sale_date;
```

### Verificar que el índice existe
```sql
SELECT indexname FROM pg_indexes
WHERE tablename = 'sales'
AND indexname = 'idx_unique_ticket_per_branch';
```

---

## Línea de Tiempo

| Fecha | Evento |
|-------|--------|
| 22/10 22:00 | Identificados duplicados en logs |
| 22/10 22:15 | Causa identificada: ticket_number sin UNIQUE |
| 22/10 22:30 | Índice UNIQUE creado en migración |
| 22/10 22:45 | Investigar Desktop App (TODO) |

---

## Impacto

### Antes (Sin Restricción)
- ❌ Múltiples ventas con mismo ticket_number
- ❌ UI muestra duplicados
- ❌ Reportes incorrectos
- ❌ Sin validación en BD

### Después (Con Índice UNIQUE)
- ✅ NO se permiten nuevos duplicados
- ✅ BD rechaza inserciones duplicadas
- ✅ UI mostrará ventas únicas
- ✅ Reportes correctos
- ✅ Error claro si hay conflicto (para debugging)

---

## Documentación Relacionada

- `SYNC_ISSUES_FOUND.md` - Problemas de sincronización
- `SYNC_FIXES_APPLIED.md` - Fixes aplicados en cliente
- `MOBILE_APP_ERROR_FIX.md` - Fix de errores 500
