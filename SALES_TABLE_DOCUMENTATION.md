# 📊 Documentación - Nueva Estructura de Tabla SALES

## ✅ Migración Completada

Se ha mejorado significativamente la tabla `sales` en PostgreSQL para incluir toda la información crítica necesaria para la app móvil.

---

## 🆕 Nuevos Campos Agregados

### 1. Identificación Única de Ventas

```sql
shift_id INTEGER                  -- ID del turno (crítico para identificar venta única)
branch_sale_number INTEGER        -- Número secuencial de venta en la sucursal
shift_sale_number INTEGER         -- Número secuencial de venta en el turno
```

**Ejemplo de Identificación Única:**
- `tenant_id=1, branch_id=3, shift_id=45, shift_sale_number=6`
- Esto representa: Tenant #1, Sucursal #3, Turno #45, Venta #6 del turno
- Ticket Display: "45-6" (mostrado al usuario)

### 2. Métodos y Tipos de Pago (CRÍTICO)

```sql
payment_type VARCHAR(50)          -- 'cash', 'credit', 'card', 'transfer', 'mixed'
is_credit_sale BOOLEAN            -- TRUE si fue a crédito (fiado)
card_type VARCHAR(50)             -- 'visa', 'mastercard', 'amex', etc.
card_last_four VARCHAR(4)         -- Últimos 4 dígitos de tarjeta
```

**Valores Permitidos para `payment_type`:**
- `'cash'` - Efectivo
- `'credit'` - A crédito (fiado)
- `'card'` - Tarjeta de crédito/débito
- `'transfer'` - Transferencia bancaria
- `'mixed'` - Pago mixto (ej: mitad efectivo, mitad tarjeta)

### 3. Desglose de Montos

```sql
subtotal DECIMAL(10,2)            -- Subtotal sin descuentos
discount_amount DECIMAL(10,2)     -- Monto total de descuentos
tax_amount DECIMAL(10,2)          -- IVA u otros impuestos
cash_received DECIMAL(10,2)       -- Efectivo recibido del cliente
change_given DECIMAL(10,2)        -- Cambio entregado al cliente
```

### 4. Estados de Venta

```sql
sale_status VARCHAR(50)           -- 'completed', 'cancelled', 'pending', 'refunded'
is_cancelled BOOLEAN              -- TRUE si fue cancelada
cancelled_at TIMESTAMP            -- Cuándo se canceló
cancelled_by INTEGER              -- ID del empleado que canceló
cancellation_reason TEXT          -- Razón de cancelación
```

### 5. Delivery/Entrega

```sql
is_delivery BOOLEAN               -- TRUE si es para delivery
delivery_address TEXT             -- Dirección de entrega
delivery_fee DECIMAL(10,2)        -- Costo de envío
delivery_status VARCHAR(50)       -- 'pending', 'in_transit', 'delivered'
```

### 6. Información de Cliente (para crédito)

```sql
customer_name VARCHAR(255)        -- Nombre del cliente
customer_phone VARCHAR(20)        -- Teléfono del cliente
credit_due_date DATE              -- Fecha de vencimiento si es a crédito
```

### 7. Auditoría y Sincronización

```sql
updated_at TIMESTAMP              -- Última actualización (auto-actualizable)
synced_to_cloud BOOLEAN           -- TRUE si ya se sincronizó a la nube
synced_at TIMESTAMP               -- Cuándo se sincronizó
```

### 8. Tickets e Impresión

```sql
receipt_printed BOOLEAN           -- TRUE si se imprimió ticket
receipt_print_count INTEGER       -- Cuántas veces se imprimió
folio_fiscal VARCHAR(255)         -- RFC/Folio fiscal si se facturó
```

---

## 📋 Vista Completa para App Móvil

Se creó una vista `v_sales_complete` que incluye toda la información necesaria con JOINs automáticos:

```sql
CREATE OR REPLACE VIEW v_sales_complete AS
SELECT
  s.*,
  b.name as branch_name,
  b.branch_code,
  e.full_name as employee_name,
  e.username as employee_username,
  CONCAT(s.shift_id, '-', s.shift_sale_number) as ticket_display,  -- "45-6"
  CONCAT(s.branch_id, '-', s.shift_id, '-', s.shift_sale_number) as unique_sale_id  -- "3-45-6"
FROM sales s
LEFT JOIN branches b ON s.branch_id = b.id
LEFT JOIN employees e ON s.employee_id = e.id;
```

**Uso en consultas:**

```sql
-- En vez de hacer JOINs manualmente, usar la vista:
SELECT * FROM v_sales_complete
WHERE tenant_id = 1
AND branch_id = 3
AND sale_date >= '2025-10-01'
ORDER BY sale_date DESC;
```

---

## 🔧 Cómo Actualizar el Backend (Node.js)

### Opción 1: Modificar Endpoint Existente de Sync

```javascript
// routes/sales.js o similar

router.post('/sync-sales', async (req, res) => {
  try {
    const { sales, tenant_id, branch_id } = req.body;

    for (const sale of sales) {
      await pool.query(`
        INSERT INTO sales (
          tenant_id,
          branch_id,
          shift_id,              -- ✅ NUEVO - Obligatorio
          employee_id,
          customer_id,
          ticket_number,
          branch_sale_number,    -- ✅ NUEVO
          shift_sale_number,     -- ✅ NUEVO
          total_amount,
          subtotal,              -- ✅ NUEVO
          discount_amount,       -- ✅ NUEVO
          tax_amount,            -- ✅ NUEVO
          payment_type,          -- ✅ NUEVO - 'cash', 'credit', 'card', etc.
          payment_method,
          is_credit_sale,        -- ✅ NUEVO - boolean
          card_type,             -- ✅ NUEVO - si payment_type='card'
          card_last_four,        -- ✅ NUEVO
          sale_type,
          is_delivery,           -- ✅ NUEVO
          delivery_fee,          -- ✅ NUEVO
          delivery_address,      -- ✅ NUEVO
          cash_received,         -- ✅ NUEVO
          change_given,          -- ✅ NUEVO
          customer_name,         -- ✅ NUEVO
          customer_phone,        -- ✅ NUEVO
          sale_status,           -- ✅ NUEVO - default 'completed'
          sale_date,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
          $21, $22, $23, $24, $25, $26, $27
        )
        ON CONFLICT (tenant_id, branch_id, shift_id, shift_sale_number)
        DO UPDATE SET
          total_amount = EXCLUDED.total_amount,
          payment_type = EXCLUDED.payment_type,
          is_credit_sale = EXCLUDED.is_credit_sale,
          updated_at = CURRENT_TIMESTAMP
      `, [
        sale.tenant_id,
        sale.branch_id,
        sale.shift_id,              // ✅ Desde desktop app
        sale.employee_id,
        sale.customer_id,
        sale.ticket_number,
        sale.branch_sale_number,
        sale.shift_sale_number,
        sale.total_amount,
        sale.subtotal,
        sale.discount_amount || 0,
        sale.tax_amount || 0,
        sale.payment_type,          // ✅ Desde desktop
        sale.payment_method,
        sale.is_credit_sale || false,
        sale.card_type,
        sale.card_last_four,
        sale.sale_type,
        sale.is_delivery || false,
        sale.delivery_fee || 0,
        sale.delivery_address,
        sale.cash_received,
        sale.change_given,
        sale.customer_name,
        sale.customer_phone,
        sale.sale_status || 'completed',
        sale.sale_date,
        sale.created_at
      ]);
    }

    res.json({ success: true, count: sales.length });
  } catch (error) {
    console.error('Error syncing sales:', error);
    res.status(500).json({ error: error.message });
  }
});
```

### Opción 2: Usar Vista para Consultas

```javascript
// GET endpoint para obtener ventas con toda la info
router.get('/sales/:tenant_id/:branch_id', async (req, res) => {
  try {
    const { tenant_id, branch_id } = req.params;
    const { start_date, end_date } = req.query;

    const { rows } = await pool.query(`
      SELECT * FROM v_sales_complete
      WHERE tenant_id = $1
        AND branch_id = $2
        AND sale_date >= $3
        AND sale_date <= $4
      ORDER BY sale_date DESC
    `, [tenant_id, branch_id, start_date, end_date]);

    res.json({
      success: true,
      sales: rows,
      count: rows.length
    });
  } catch (error) {
    console.error('Error fetching sales:', error);
    res.status(500).json({ error: error.message });
  }
});
```

---

## 💾 Cómo Actualizar la App Desktop (WinUI)

La app desktop debe enviar estos campos adicionales al backend:

### Modelo de Venta Actualizado (C#)

```csharp
public class Sale
{
    public int Id { get; set; }
    public int TenantId { get; set; }
    public int BranchId { get; set; }

    // ✅ NUEVO - Campos críticos
    public int ShiftId { get; set; }  // Del turno actual
    public int BranchSaleNumber { get; set; }  // Contador de sucursal
    public int ShiftSaleNumber { get; set; }  // Contador de turno

    public int? EmployeeId { get; set; }
    public int? CustomerId { get; set; }
    public string TicketNumber { get; set; }  // Para display: "45-6"

    // ✅ NUEVO - Montos desglosados
    public decimal Subtotal { get; set; }
    public decimal DiscountAmount { get; set; }
    public decimal TaxAmount { get; set; }
    public decimal TotalAmount { get; set; }

    // ✅ NUEVO - Método de pago detallado
    public string PaymentType { get; set; }  // "cash", "credit", "card", "transfer"
    public string? PaymentMethod { get; set; }
    public bool IsCreditSale { get; set; }
    public string? CardType { get; set; }
    public string? CardLastFour { get; set; }

    // ✅ NUEVO - Efectivo
    public decimal? CashReceived { get; set; }
    public decimal? ChangeGiven { get; set; }

    // ✅ NUEVO - Delivery
    public bool IsDelivery { get; set; }
    public decimal DeliveryFee { get; set; }
    public string? DeliveryAddress { get; set; }

    public string SaleType { get; set; }
    public int? DeliveryPersonId { get; set; }
    public string? Notes { get; set; }
    public DateTime SaleDate { get; set; }
    public DateTime CreatedAt { get; set; }
}
```

### Ejemplo de Construcción de Venta

```csharp
var sale = new Sale
{
    TenantId = currentTenant.Id,
    BranchId = currentBranch.Id,
    ShiftId = currentShift.Id,  // ✅ Del turno abierto
    EmployeeId = currentEmployee.Id,

    // ✅ Números secuenciales
    BranchSaleNumber = GetNextBranchSaleNumber(),  // Auto-incrementar
    ShiftSaleNumber = GetNextShiftSaleNumber(),    // Auto-incrementar del turno
    TicketNumber = $"{currentShift.Id}-{shiftSaleNumber}",  // "45-6"

    // ✅ Montos
    Subtotal = cartItems.Sum(i => i.Price * i.Quantity),
    DiscountAmount = appliedDiscount,
    TaxAmount = 0,  // Si aplica IVA
    TotalAmount = subtotal - discount + tax,

    // ✅ Método de pago
    PaymentType = selectedPaymentMethod,  // "cash", "credit", "card"
    IsCreditSale = selectedPaymentMethod == "credit",
    CardType = paymentInfo.CardType,  // Si es tarjeta
    CardLastFour = paymentInfo.LastFour,

    // ✅ Efectivo (si aplica)
    CashReceived = paymentType == "cash" ? cashReceived : null,
    ChangeGiven = paymentType == "cash" ? (cashReceived - totalAmount) : null,

    SaleType = "local",  // o "delivery"
    SaleDate = DateTime.UtcNow,
    CreatedAt = DateTime.UtcNow
};
```

---

## 📱 Consultas Útiles para la App Móvil

### 1. Obtener Ventas del Día con Toda la Info

```sql
SELECT * FROM v_sales_complete
WHERE tenant_id = 1
  AND branch_id = 3
  AND DATE(sale_date) = CURRENT_DATE
ORDER BY sale_date DESC;
```

### 2. Ventas por Método de Pago (Hoy)

```sql
SELECT
  payment_type,
  COUNT(*) as total_sales,
  SUM(total_amount) as total_amount
FROM sales
WHERE tenant_id = 1
  AND branch_id = 3
  AND DATE(sale_date) = CURRENT_DATE
GROUP BY payment_type;
```

### 3. Ventas de un Turno Específico

```sql
SELECT * FROM v_sales_complete
WHERE tenant_id = 1
  AND shift_id = 45
ORDER BY shift_sale_number ASC;
```

### 4. Ventas a Crédito Pendientes

```sql
SELECT * FROM v_sales_complete
WHERE tenant_id = 1
  AND is_credit_sale = TRUE
  AND sale_status != 'refunded'
ORDER BY credit_due_date ASC;
```

---

## 🎯 Checklist de Migración

### Backend (Node.js)

- [ ] Actualizar endpoint `/sync-sales` para recibir nuevos campos
- [ ] Actualizar endpoint de consultas para usar `v_sales_complete`
- [ ] Agregar validación de `shift_id` (requerido)
- [ ] Agregar validación de `payment_type` (valores permitidos)
- [ ] Actualizar esquema de Joi/Zod si se usa validación

### Desktop App (WinUI)

- [ ] Actualizar modelo `Sale` con nuevos campos
- [ ] Enviar `shift_id` en todas las ventas (del turno actual)
- [ ] Enviar `branch_sale_number` y `shift_sale_number`
- [ ] Enviar `payment_type` correctamente ('cash', 'credit', 'card')
- [ ] Enviar `subtotal`, `discount_amount`, `tax_amount`
- [ ] Enviar `cash_received` y `change_given` si payment_type='cash'
- [ ] Enviar `card_type` y `card_last_four` si payment_type='card'
- [ ] Actualizar lógica de tickets para usar formato "shift_id-shift_sale_number"

### Mobile App (Flutter)

- [ ] Actualizar modelos Dart para incluir nuevos campos
- [ ] Usar `ticket_display` para mostrar número de ticket
- [ ] Filtrar por `payment_type` en reportes
- [ ] Mostrar ventas a crédito con `is_credit_sale`
- [ ] Implementar filtros por turno usando `shift_id`

---

## 🔍 Debugging y Verificación

### Verificar Estructura de Tabla

```sql
\d sales
```

### Ver Ventas Recientes con Toda la Info

```sql
SELECT
  id,
  ticket_number,
  shift_id,
  shift_sale_number,
  payment_type,
  total_amount,
  sale_date
FROM sales
ORDER BY sale_date DESC
LIMIT 10;
```

### Verificar Índices

```sql
SELECT indexname FROM pg_indexes
WHERE tablename = 'sales';
```

---

## 📞 Soporte

Si tienes problemas con la migración:
1. Verificar que la migración `004_enhance_sales_table.sql` se aplicó correctamente
2. Revisar logs del backend para errores de sincronización
3. Verificar que el desktop esté enviando `shift_id` en todas las ventas

**Archivo de Migración:** `migrations/004_enhance_sales_table.sql`
**Fecha de Aplicación:** 2025-10-14
