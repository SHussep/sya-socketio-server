# 🔴 ERROR EN APP MÓVIL - PROBLEMA Y SOLUCIÓN

## El Problema

La app móvil estaba recibiendo **error 500** al intentar obtener las ventas:

```
I/flutter ( 6799): [Dashboard API] Ventas Status: 500
I/flutter ( 6799): Response body: {"success":false,"message":"Error al obtener ventas"}
```

Mismo error para gastos.

---

## 🔍 Causa Raíz

**SQL Parameter Injection Bug** en los endpoints:
- `/api/sales` (línea 1281)
- `/api/expenses` (línea 1385)

### El Bug Exacto

```javascript
// ❌ ANTES (INCORRECTO):
query += ` ORDER BY s.sale_date DESC LIMIT ${paramIndex} OFFSET ${paramIndex + 1}`;

// Esto genera SQL como:
// LIMIT 2 OFFSET 3  ← Números literales en lugar de parámetros
```

En PostgreSQL con pg library, **LIMIT y OFFSET deben estar parametrizados como `$1`, `$2`, etc.**

**No se puede usar:**
```sql
LIMIT 2 OFFSET 3  -- ❌ Falla con pg library
```

**Se debe usar:**
```sql
LIMIT $2 OFFSET $3  -- ✅ Funciona
```

---

## ✅ Solución Aplicada

### 1. Agregar `$` a los placeholders

**ANTES:**
```javascript
query += ` AND s.branch_id = ${paramIndex}`;
query += ` AND (s.sale_date AT TIME ZONE '${userTimezone}')::date >= ${paramIndex}::date`;
query += ` LIMIT ${paramIndex} OFFSET ${paramIndex + 1}`;
```

**DESPUÉS:**
```javascript
query += ` AND s.branch_id = $${paramIndex}`;  // ← Agregar $
query += ` AND (s.sale_date AT TIME ZONE '${userTimezone}')::date >= $${paramIndex}::date`;
query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
```

### 2. Mejorar Logging

Agregados logs detallados para debugging:

```javascript
console.log(`[Sales] Query: ${query}`);
console.log(`[Sales] Params: ${JSON.stringify(params)}`);
// Si hay error:
console.error('[Sales] ❌ Error:', error.message);
console.error('[Sales] SQL Error Code:', error.code);
```

---

## 📊 Cambios Exactos

### Endpoint: `/api/sales` (GET)

**Línea 1262:**
```diff
- query += ` AND s.branch_id = ${paramIndex}`;
+ query += ` AND s.branch_id = $${paramIndex}`;
```

**Línea 1270:**
```diff
- query += ` AND (s.sale_date AT TIME ZONE '${userTimezone}')::date >= ${paramIndex}::date`;
+ query += ` AND (s.sale_date AT TIME ZONE '${userTimezone}')::date >= $${paramIndex}::date`;
```

**Línea 1275:**
```diff
- query += ` AND (s.sale_date AT TIME ZONE '${userTimezone}')::date <= ${paramIndex}::date`;
+ query += ` AND (s.sale_date AT TIME ZONE '${userTimezone}')::date <= $${paramIndex}::date`;
```

**Línea 1281:**
```diff
- query += ` ORDER BY s.sale_date DESC LIMIT ${paramIndex} OFFSET ${paramIndex + 1}`;
+ query += ` ORDER BY s.sale_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
```

---

### Endpoint: `/api/expenses` (GET)

Las mismas correcciones en:
- Línea 1366 (branch_id filter)
- Línea 1374 (startDate filter)
- Línea 1379 (endDate filter)
- Línea 1385 (LIMIT/OFFSET)

---

## 🧪 Cómo Verificar

Después de que Render despliegue:

1. **Abre la app móvil**
2. **Ve al Dashboard**
3. **Deberías ver:**
   ```
   I/flutter ( 6799): [Dashboard API] Ventas Status: 200
   I/flutter ( 6799): [Dashboard API] Gastos Status: 200
   ```

4. **NO deberías ver:**
   ```
   Ventas Status: 500  ← ERROR (ya no debe ocurrir)
   ```

---

## 📋 Impact

| Antes | Después |
|-------|---------|
| ❌ App móvil ve error 500 | ✅ App móvil recibe datos |
| ❌ Dashboard vacío | ✅ Dashboard muestra ventas |
| ❌ No hay listado de gastos | ✅ Gastos se cargan |

---

## 🔧 Debugging Avanzado

Si aún hay errores, revisar los logs de Render:

```
[Sales] Fetching sales - Tenant: 3, Branch: 13, ...
[Sales] Query: SELECT ... WHERE ... LIMIT $2 OFFSET $3
[Sales] Params: ["3", "13", 50, 0]
[Sales] ✅ Ventas encontradas: 14
```

Si ves errores SQL, están reportados en:
```
[Sales] ❌ Error: syntax error at end of input
[Sales] SQL Error Code: 42601
```

---

## 🎯 Resumen

**Problema:** SQL query malformada con parámetros no parametrizados
**Solución:** Agregar `$` a todos los placeholders de parámetros
**Resultado:** App móvil puede cargar ventas y gastos correctamente

---

## 📁 Archivos Modificados

- `server.js` líneas 1262-1282 (endpoint /api/sales)
- `server.js` líneas 1366-1385 (endpoint /api/expenses)

**Commit:** `24c6d12`

