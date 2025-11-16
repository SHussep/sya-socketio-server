# Cambios Nomenclatura - Sales → Ventas

## Tabla renombrada:
- `sales` → `ventas`
- `sales_items` → `ventas_detalle`

## Columnas en tabla ventas:
- `id` → `id_venta`
- `employee_id` → `id_empleado`
- `customer_id` → `id_cliente`
- `shift_id` → `id_turno`
- `sale_date` → `fecha_venta_utc` (generated column)
- `total_amount` → `total`
- `payment_method` → `tipo_pago_id` (1=Efectivo, 2=Tarjeta, 3=Crédito)
- `sale_type` → `venta_tipo_id` (1=Counter, 2=Delivery)

## Columnas en tabla ventas_detalle:
- `id` → `id_venta_detalle`
- `sale_id` → `id_venta`
- `product_id` → `id_producto`
- `product_name` → `descripcion_producto`
- `quantity` → `cantidad`
- `unit_price` → `precio_unitario`
- `list_price` → `precio_lista`
- `line_total` → `total_linea`

##Empleados (employees):
- Ya NO tiene columna `full_name`, usar: `CONCAT(first_name, ' ', last_name)`
- Ya NO tiene columna `role`, usar: `role_id` (FK a tabla roles)
- Ya NO tiene columna `password`, usar: `password_hash`

## Shifts:
- Tabla es correcta, pero verificar referencias a employees
