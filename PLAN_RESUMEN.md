# 📋 PLAN EJECUTIVO - Arreglar Flujo de Empleados

## EL PROBLEMA EN 3 LÍNEAS

```
1. Cuando agregas empleado en Desktop → NO se guarda en PostgreSQL
2. Si se guarda, NO tiene email ni contraseña
3. Resultado: Login en mobile NO funciona, relaciones rotas
```

---

## SOLUCIÓN: Plan de 4 Fases

### FASE 1️⃣: AUDITORÍA (TÚ HACES ESTO)

**¿QUÉ HACER?**

Conecta a PostgreSQL y ejecuta ESTOS queries en orden:

```sql
-- QUERY 1: ¿Cuántos registros hay en cada tabla?
SELECT 'tenants' as tabla, COUNT(*) FROM tenants
UNION ALL
SELECT 'employees', COUNT(*) FROM employees
UNION ALL
SELECT 'employee_branches', COUNT(*) FROM employee_branches;

-- RESULTADO ESPERADO:
-- Si tenants = 1, employees = 1, employee_branches = 1 → Algo funciona
-- Si tenants = 1, employees = 0 → ROTO (empleados no se guardan)
-- Si tenants = 1, employees = 1, employee_branches = 0 → ROTO (branches no asignadas)
```

```sql
-- QUERY 2: Mostrar TODOS los empleados (estructura actual)
SELECT
    id, email, username, full_name, role_id,
    password_hash, main_branch_id, is_active
FROM employees;

-- PREGUNTA: ¿Aparecen empleados? ¿Tienen email? ¿Tienen password_hash?
```

```sql
-- QUERY 3: Mostrar relaciones employee_branches
SELECT eb.id, eb.employee_id, eb.branch_id, eb.is_active
FROM employee_branches eb;

-- PREGUNTA: ¿Aparecen relaciones? ¿Corresponden a los empleados?
```

---

### FASE 2️⃣: AUDITAR LOGS (TÚ Y YO JUNTOS)

**¿QUÉ HACER?**

1. **En Desktop**: Abre Visual Studio → Pestaña "Output"
2. **Agrega un nuevo empleado** (nombre, email, contraseña, rol)
3. **Busca en los logs**:
   ```
   [Employees/Sync] 🔄 Sincronizando empleado...
   [Employees/Sync] 📝 POST payload...
   [Employees/Sync] ✅ Sincronizado OR ❌ Error
   ```

4. **Mándame SCREENSHOT o COPIA completo de los logs**

---

### FASE 3️⃣: IDENTIFICAR EL PROBLEMA EXACTO (YO HAGO ESTO)

Basado en:
- Resultados de Query 1, 2, 3
- Logs de Desktop
- Logs de Render (también hay que revisar)

**Determinaremos si es**:
- ✅ Problema de BD (schema roto)
- ✅ Problema de Backend (endpoint roto)
- ✅ Problema de Desktop (no envía datos)

---

### FASE 4️⃣: IMPLEMENTAR SOLUCIÓN (YO HAGO, TÚ VALIDAS)

Crear migrations + arreglar código backend:

```
1. Migration 038: Arreglar tabla employees
   - Hacer email OBLIGATORIO
   - Hacer password_hash OBLIGATORIO
   - Agregar columna phone
   - Simplificar mobile permissions
   - Eliminar tablas innecesarias

2. Arreglar endpoint POST /api/employees
   - Validar que email y password_hash existan
   - Guardar en employees
   - Guardar en employee_branches (asignar a sucursal actual)
   - Devolver ID para que Desktop actualice

3. Validar que Desktop envíe correctamente
   - Email → SI
   - Password → SI
   - Rol válido (1-4 o 99) → SI

4. Prueba completa
   - Agregar empleado en Desktop
   - Verificar en PostgreSQL
   - Hacer login en mobile
```

---

## 🎯 QUÉ NECESITAMOS AHORA

### ACCIÓN INMEDIATA (HOY):

1. **Ejecuta QUERY 1, 2, 3 en PostgreSQL**
   - Cópiame el resultado completo

2. **Agrega un nuevo empleado en Desktop**
   - Mándame los logs completos de Visual Studio Output
   - Especifica qué datos llenaste (nombre, email, pass, rol)

3. **Mándame link a logs de Render**
   - O cópiame los últimos 20 líneas de logs de Render

---

## ESTRUCTURA FINAL (Qué debería verse)

```
POSTGRESQL (después del fix):
┌─────────────────────────────────┐
│ employees table                 │
├─────────────────────────────────┤
│ id    │ email           │ pass  │ role │ branch │
├─────────────────────────────────┤
│ 1     │ owner@ex.com    │ $$... │ 1    │ 1      │
│ 2     │ juan@ex.com     │ $$... │ 3    │ 1      │ ← NUEVO EMPLEADO
│ 3     │ maria@ex.com    │ $$... │ 2    │ 1      │ ← NUEVO EMPLEADO
└─────────────────────────────────┘

employee_branches table
┌──────────────────────────────┐
│ employee_id │ branch_id      │
├──────────────────────────────┤
│ 1           │ 1              │
│ 2           │ 1              │ ← RELACIÓN AUTOMÁTICA
│ 3           │ 1              │ ← RELACIÓN AUTOMÁTICA
└──────────────────────────────┘
```

---

## RIESGOS Y CONSIDERACIONES

### ✅ SEGURO (no rompe nada):
- Agregar columnas a employees
- Cambiar constraints a NOT NULL
- Eliminar tablas innecesarias (si están vacías)

### ⚠️ NECESITA CUIDADO:
- Cambiar tipo de datos
- Eliminar datos existentes
- Alterar FK relationships

### 🛡️ PROTECCIÓN:
- Todas las migrations tenemos backup en GitHub
- Render tiene snapshots de BD
- Si algo falla, revertimos

---

## TIMELINE ESTIMADO

```
Día 1 (HOY):
  - Ejecutas auditoría (30 min)
  - Agregas empleado, gets logs (15 min)
  - Yo analizo resultados (30 min)
  ↓
Día 2:
  - Yo creo migration y codigo (2-3 horas)
  - Yo hago commit y push (5 min)
  - Render redeploy (5-10 min)
  ↓
Día 2-3:
  - TÚ pruebas flujo completo
  - Si hay problemas, iteramos
  ↓
DONE: Flujo de empleados 100% funcional
```

---

## PREGUNTAS PARA TI

### ¿Tiene sentido el plan?

### ¿Puedes ejecutar las 3 queries hoy?

### ¿Hay algo del plan que no entiendas?

Si cualquier cosa no está clara, pregúntame antes de empezar.

---

## DOCUMENTO COMPLETO

Si necesitas más detalles técnicos:
→ Lee `EMPLOYEE_SYNC_RESTRUCTURE_PLAN.md`

---

**SIGUIENTE PASO**: Ejecuta la auditoría y mándame los resultados.
