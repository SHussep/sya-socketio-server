# FASE 1: Modificaciones Backend para Timezone Support

## Resumen
Este documento detalla los cambios requeridos en `server.js` para soportar filtrado y conversión de timezones en las queries de sales y expenses.

## Cambios Requeridos

### 1. Endpoint GET /api/sales (línea 1233)

**Cambio**: Aceptar parámetros `timezone`, `startDate`, `endDate` y usar `AT TIME ZONE` en queries.

**Antes** (líneas 1234-1278):
```javascript
app.get('/api/sales', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', branch_id } = req.query;
        // ... resto del código sin timezone support
```

**Después**:
```javascript
app.get('/api/sales', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', branch_id, timezone, startDate, endDate } = req.query;

        const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;
        const userTimezone = timezone || 'UTC';

        let query = `
            SELECT s.id, s.ticket_number, s.total_amount, s.payment_method, s.sale_date,
                   s.sale_type,
                   e.full_name as employee_name, e.role as employee_role,
                   b.name as branch_name, b.id as branch_id,
                   (s.sale_date AT TIME ZONE '${userTimezone}') as sale_date_display
            FROM sales s
            LEFT JOIN employees e ON s.employee_id = e.id
            LEFT JOIN branches b ON s.branch_id = b.id
            WHERE s.tenant_id = $1
        `;

        const params = [tenantId];
        let paramIndex = 2;

        // Filtrar por branch_id
        if (all_branches !== 'true' && targetBranchId) {
            query += ` AND s.branch_id = $${paramIndex}`;
            params.push(targetBranchId);
            paramIndex++;
        }

        // Filtrar por rango de fechas si se proporciona
        if (startDate || endDate) {
            if (startDate) {
                query += ` AND (s.sale_date AT TIME ZONE '${userTimezone}')::date >= $${paramIndex}::date`;
                params.push(startDate);
                paramIndex++;
            }
            if (endDate) {
                query += ` AND (s.sale_date AT TIME ZONE '${userTimezone}')::date <= $${paramIndex}::date`;
                params.push(endDate);
                paramIndex++;
            }
        }

        query += ` ORDER BY s.sale_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        console.log(`[Sales] Fetching sales - Tenant: ${tenantId}, Branch: ${targetBranchId}, Timezone: ${userTimezone}`);

        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[Sales] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener ventas' });
    }
});
```

**Impacto**:
- El endpoint ahora acepta `?timezone=America/Mexico_City`
- Convierte `sale_date` a la zona horaria del usuario en la query
- Filtra por rango de fechas en la zona horaria del usuario
- Retorna `sale_date_display` con la conversión ya hecha

---

### 2. Endpoint GET /api/expenses (línea 1319)

**Cambio**: Similar a sales, aceptar `timezone`, `startDate`, `endDate`.

**Antes** (líneas 1320-1364):
```javascript
app.get('/api/expenses', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', branch_id } = req.query;
        // ... resto del código sin timezone support
```

**Después**:
```javascript
app.get('/api/expenses', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', branch_id, timezone, startDate, endDate } = req.query;

        const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;
        const userTimezone = timezone || 'UTC';

        let query = `
            SELECT e.id, e.description as concept, e.description, e.amount, e.expense_date,
                   emp.full_name as employee_name, b.name as branch_name, b.id as branch_id,
                   cat.name as category,
                   (e.expense_date AT TIME ZONE '${userTimezone}') as expense_date_display
            FROM expenses e
            LEFT JOIN employees emp ON e.employee_id = emp.id
            LEFT JOIN branches b ON e.branch_id = b.id
            LEFT JOIN expense_categories cat ON e.category_id = cat.id
            WHERE e.tenant_id = $1
        `;

        const params = [tenantId];
        let paramIndex = 2;

        // Filtrar por branch_id
        if (all_branches !== 'true' && targetBranchId) {
            query += ` AND e.branch_id = $${paramIndex}`;
            params.push(targetBranchId);
            paramIndex++;
        }

        // Filtrar por rango de fechas si se proporciona
        if (startDate || endDate) {
            if (startDate) {
                query += ` AND (e.expense_date AT TIME ZONE '${userTimezone}')::date >= $${paramIndex}::date`;
                params.push(startDate);
                paramIndex++;
            }
            if (endDate) {
                query += ` AND (e.expense_date AT TIME ZONE '${userTimezone}')::date <= $${paramIndex}::date`;
                params.push(endDate);
                paramIndex++;
            }
        }

        query += ` ORDER BY e.expense_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        console.log(`[Expenses] Fetching expenses - Tenant: ${tenantId}, Branch: ${targetBranchId}, Timezone: ${userTimezone}`);

        const result = await pool.query(query, params);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[Expenses] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener gastos' });
    }
});
```

---

## Ejemplo de Uso

### Query Original (sin timezone):
```
GET /api/sales?branchId=1
```

### Query Nueva (con timezone):
```
GET /api/sales?branchId=1&timezone=America/Mexico_City&startDate=2025-10-21&endDate=2025-10-22
```

Retorna:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "ticket_number": "1001",
      "total_amount": 250.00,
      "sale_date": "2025-10-21T22:28:00+00:00",
      "sale_date_display": "2025-10-21 17:28:00-05:00",
      "employee_name": "Juan Pérez",
      "branch_name": "Monterrey"
    }
  ]
}
```

---

## Pasos para Implementar

1. Abrir `C:/SYA/sya-socketio-server/server.js` en un editor
2. Ir a línea 1233 y reemplazar el endpoint GET /api/sales
3. Ir a línea 1319 y reemplazar el endpoint GET /api/expenses
4. Probar con curl o Postman:
   ```bash
   curl "http://localhost:3000/api/sales?timezone=America/Mexico_City" \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```
5. Hacer commit de los cambios

