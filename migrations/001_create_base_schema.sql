-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 001: Crear esquema base - ESTRUCTURA EXACTA DE SQLite + Multi-Tenant
-- ═══════════════════════════════════════════════════════════════════════════
-- ESTRUCTURA IDÉNTICA A LA BASE DE DATOS LOCAL
-- Solo se agregan: tenant_id y branch_id para identificar de qué sucursal viene
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLAS CORE - Tenant y Branch (para multi-tenancy)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "tenants" (
  "id" SERIAL PRIMARY KEY,
  "tenant_code" VARCHAR NOT NULL UNIQUE,
  "business_name" VARCHAR NOT NULL,
  "owner_email" VARCHAR,
  "google_user_id" VARCHAR,
  "phone_number" VARCHAR,
  "rfc" VARCHAR,
  "address" VARCHAR,
  "created_at" BIGINT,
  "subscription_status" VARCHAR,
  "subscription_plan" VARCHAR,
  "trial_ends_at" BIGINT,
  "subscription_ends_at" BIGINT,
  "max_branches" INTEGER,
  "max_users" INTEGER,
  "is_active" INTEGER,
  "token" VARCHAR
);

CREATE TABLE "branches" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_code" VARCHAR NOT NULL,
  "branch_name" VARCHAR NOT NULL,
  "address" VARCHAR,
  "phone_number" VARCHAR,
  "is_active" INTEGER DEFAULT 1,
  "created_at" BIGINT,
  "timezone" VARCHAR
);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLAS DE CATÁLOGOS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "business" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "business_name" VARCHAR NOT NULL,
  "owner_name" VARCHAR,
  "phone_number" VARCHAR,
  "address" VARCHAR,
  "rfc" VARCHAR,
  "logo_file_token" VARCHAR,
  "is_active" INTEGER DEFAULT 1
);

CREATE TABLE "employee" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "username" VARCHAR NOT NULL,
  "full_name" VARCHAR NOT NULL,
  "email" VARCHAR NOT NULL,
  "role_id" INTEGER NOT NULL,
  "is_active" INTEGER DEFAULT 1,
  "is_owner" INTEGER DEFAULT 0,
  "google_user_identifier" VARCHAR
);

CREATE TABLE "employee_details" (
  "employee_id" INTEGER PRIMARY KEY REFERENCES employee(id),
  "address" VARCHAR,
  "phone_number" VARCHAR,
  "hire_date" BIGINT,
  "salary" FLOAT,
  "commission" FLOAT,
  "saldo_deudor" FLOAT
);

CREATE TABLE "role" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR NOT NULL UNIQUE
);

CREATE TABLE "permission" (
  "id" SERIAL PRIMARY KEY,
  "key" VARCHAR NOT NULL UNIQUE,
  "description" VARCHAR NOT NULL
);

CREATE TABLE "role_permissions" (
  "id" SERIAL PRIMARY KEY,
  "role_id" INTEGER NOT NULL REFERENCES role(id),
  "permission_id" INTEGER NOT NULL REFERENCES permission(id)
);

CREATE TABLE "credential" (
  "employee_id" INTEGER PRIMARY KEY REFERENCES employee(id),
  "password_hash" VARCHAR NOT NULL,
  "google_id" VARCHAR
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCTOS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "categorias_productos" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "categoria" VARCHAR NOT NULL,
  "disponible" INTEGER DEFAULT 1
);

CREATE TABLE "tipos_de_salida" (
  "id" SERIAL PRIMARY KEY,
  "tipo_de_salida_nombre" VARCHAR NOT NULL
);

CREATE TABLE "units_of_measure" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR NOT NULL,
  "abbreviation" VARCHAR NOT NULL UNIQUE
);

CREATE TABLE "proveedores" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "name" VARCHAR NOT NULL,
  "contact_person" VARCHAR,
  "phone_number" VARCHAR NOT NULL,
  "email" VARCHAR,
  "address" VARCHAR,
  "is_active" INTEGER DEFAULT 1,
  "is_undeletable" INTEGER DEFAULT 0
);

CREATE TABLE "productos" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "descripcion" VARCHAR NOT NULL,
  "categoria" INTEGER REFERENCES categorias_productos(id),
  "precio_compra" FLOAT NOT NULL,
  "precio_venta" FLOAT NOT NULL,
  "produccion" INTEGER NOT NULL DEFAULT 0,
  "inventariar" INTEGER NOT NULL DEFAULT 1,
  "tipos_de_salida_id" INTEGER NOT NULL REFERENCES tipos_de_salida(id),
  "notificar" INTEGER NOT NULL DEFAULT 0,
  "minimo" FLOAT NOT NULL DEFAULT 0,
  "inventario" FLOAT NOT NULL DEFAULT 0,
  "proveedores_id_proveedor" INTEGER REFERENCES proveedores(id),
  "eliminado" INTEGER NOT NULL DEFAULT 0,
  "bascula" INTEGER NOT NULL DEFAULT 0,
  "is_pos_shortcut" INTEGER DEFAULT 0,
  "unidad_medida_id" INTEGER REFERENCES units_of_measure(id),
  "remote_id" INTEGER,
  "synced" INTEGER DEFAULT 0
);

CREATE TABLE "product_formulas" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "producto_final_id" INTEGER REFERENCES productos(id),
  "producto_materia_id" INTEGER REFERENCES productos(id),
  "cantidad_materia_por_unidad" FLOAT,
  "output_quantity" FLOAT,
  "input_quantity" FLOAT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- CLIENTES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "tipos_descuento" (
  "id" INTEGER PRIMARY KEY,
  "nombre" VARCHAR,
  "descripcion" VARCHAR
);

CREATE TABLE "clientes" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "nombre" VARCHAR NOT NULL,
  "direccion" VARCHAR,
  "correo" VARCHAR,
  "telefono" VARCHAR NOT NULL,
  "telefono_sec" VARCHAR,
  "tiene_credito" INTEGER DEFAULT 0,
  "credito_limite" FLOAT DEFAULT 0,
  "fecha_de_alta" BIGINT,
  "descuento" FLOAT DEFAULT 0,
  "activo" INTEGER NOT NULL DEFAULT 1,
  "saldo_deudor" FLOAT DEFAULT 0,
  "nota" VARCHAR,
  "tipo_descuento" INTEGER NOT NULL DEFAULT 0,
  "porcentaje_descuento" FLOAT NOT NULL DEFAULT 0,
  "monto_descuento_fijo" FLOAT NOT NULL DEFAULT 0,
  "aplicar_redondeo" INTEGER NOT NULL DEFAULT 0,
  "last_discount_changed_by_employee_id" INTEGER REFERENCES employee(id),
  "last_discount_changed_at" BIGINT,
  "discount_notes" VARCHAR,
  "remote_id" INTEGER,
  "synced" INTEGER DEFAULT 0
);

CREATE TABLE "precios_especiales_cliente" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "id_cliente" INTEGER REFERENCES clientes(id),
  "id_producto" INTEGER REFERENCES productos(id),
  "precio_especial" FLOAT,
  "porcentaje_descuento" FLOAT,
  "set_by_employee_id" INTEGER REFERENCES employee(id),
  "set_at" BIGINT,
  "notes" VARCHAR,
  UNIQUE(id_cliente, id_producto)
);

CREATE TABLE "cliente_change_logs" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "cliente_id" INTEGER REFERENCES clientes(id),
  "fecha" BIGINT NOT NULL,
  "employee_id" INTEGER REFERENCES employee(id),
  "campo" VARCHAR NOT NULL,
  "valor_anterior" VARCHAR,
  "valor_nuevo" VARCHAR,
  "notas" VARCHAR
);

CREATE TABLE "cliente_creditos" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "cliente_id" INTEGER REFERENCES clientes(id),
  "monto" FLOAT NOT NULL,
  "fecha" BIGINT NOT NULL,
  "notas" VARCHAR,
  "pago_id" INTEGER
);

CREATE TABLE "pagos_cliente" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "id_cliente" INTEGER NOT NULL REFERENCES clientes(id),
  "id_empleado_registro" INTEGER NOT NULL REFERENCES employee(id),
  "fecha_pago" BIGINT NOT NULL,
  "monto_pagado" FLOAT NOT NULL,
  "metodo_pago" VARCHAR,
  "notas" VARCHAR
);

CREATE TABLE "pago_aplicaciones" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "pago_id" INTEGER REFERENCES pagos_cliente(id),
  "venta_id" INTEGER,
  "monto_aplicado" FLOAT NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════════
-- TURNOS (SHIFTS)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "shift" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "employee_id" INTEGER REFERENCES employee(id),
  "business_id" INTEGER REFERENCES business(id),
  "start_time" BIGINT,
  "end_time" BIGINT,
  "initial_amount" FLOAT DEFAULT 0,
  "final_amount" FLOAT DEFAULT 0,
  "transaction_counter" INTEGER DEFAULT 0,
  "is_cash_cut_open" INTEGER DEFAULT 1,
  "remote_id" INTEGER,
  "synced" INTEGER DEFAULT 0,
  "synced_at" BIGINT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- VENTAS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "estado_venta" (
  "id" INTEGER PRIMARY KEY,
  "nombre" VARCHAR NOT NULL
);

CREATE TABLE "tipos_venta" (
  "id" SERIAL PRIMARY KEY,
  "nombre" VARCHAR NOT NULL
);

CREATE TABLE "tipos_pago" (
  "id" SERIAL PRIMARY KEY,
  "nombre" VARCHAR NOT NULL
);

CREATE TABLE "ventas" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "estado_venta_id" INTEGER NOT NULL REFERENCES estado_venta(id),
  "id_repartidor_asignado" INTEGER REFERENCES employee(id),
  "id_turno_repartidor" INTEGER,
  "id_turno" INTEGER NOT NULL REFERENCES shift(id),
  "id_negocio" INTEGER NOT NULL REFERENCES business(id),
  "id_empleado" INTEGER NOT NULL REFERENCES employee(id),
  "id_cliente" INTEGER REFERENCES clientes(id),
  "venta_tipo_id" INTEGER REFERENCES tipos_venta(id),
  "tipo_pago_id" INTEGER REFERENCES tipos_pago(id),
  "ticket_number" INTEGER NOT NULL,
  "fecha_venta" BIGINT,
  "subtotal" FLOAT,
  "total_descuentos" FLOAT,
  "total" FLOAT,
  "monto_pagado" FLOAT,
  "notas" VARCHAR,
  "fecha_liquidacion" BIGINT,
  "remote_id" INTEGER,
  "synced" INTEGER DEFAULT 0,
  "synced_at" BIGINT
);

CREATE TABLE "ventas_detalle" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "id_venta" INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  "id_producto" INTEGER NOT NULL REFERENCES productos(id),
  "descripcion_producto" VARCHAR NOT NULL,
  "cantidad" FLOAT,
  "precio_lista" FLOAT,
  "precio_unitario" FLOAT,
  "total_linea" FLOAT,
  "tipo_descuento_cliente_id" INTEGER,
  "monto_cliente_descuento" FLOAT,
  "tipo_descuento_manual_id" INTEGER,
  "monto_manual_descuento" FLOAT
);

CREATE TABLE "devoluciones" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "id_venta_original" INTEGER REFERENCES ventas(id),
  "id_producto" INTEGER REFERENCES productos(id),
  "cantidad_devuelta" FLOAT,
  "fecha_devolucion" BIGINT
);

CREATE TABLE "cancelaciones_bitacora" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "id_turno" INTEGER NOT NULL REFERENCES shift(id),
  "id_empleado" INTEGER NOT NULL REFERENCES employee(id),
  "fecha" BIGINT NOT NULL,
  "id_venta" INTEGER REFERENCES ventas(id),
  "id_venta_detalle" INTEGER,
  "id_producto" INTEGER REFERENCES productos(id),
  "descripcion" VARCHAR,
  "cantidad" FLOAT,
  "motivo" VARCHAR
);

-- ═══════════════════════════════════════════════════════════════════════════
-- COMPRAS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "purchase_statuses" (
  "id" INTEGER PRIMARY KEY,
  "name" VARCHAR NOT NULL
);

CREATE TABLE "purchases" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "proveedor_id" INTEGER NOT NULL REFERENCES proveedores(id),
  "employee_id" INTEGER NOT NULL REFERENCES employee(id),
  "shift_id" INTEGER NOT NULL REFERENCES shift(id),
  "purchase_date" BIGINT NOT NULL,
  "status_id" INTEGER NOT NULL REFERENCES purchase_statuses(id),
  "payment_type_id" INTEGER NOT NULL REFERENCES tipos_pago(id),
  "subtotal" FLOAT DEFAULT 0,
  "taxes" FLOAT DEFAULT 0,
  "total" FLOAT NOT NULL,
  "amount_paid" FLOAT DEFAULT 0,
  "notes" VARCHAR,
  "invoice_number" VARCHAR,
  "remote_id" INTEGER,
  "synced" INTEGER DEFAULT 0,
  "synced_at" BIGINT
);

CREATE TABLE "purchase_details" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "purchase_id" INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  "product_id" INTEGER NOT NULL REFERENCES productos(id),
  "product_description" VARCHAR NOT NULL,
  "quantity" FLOAT,
  "unit_price" FLOAT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- GASTOS (EXPENSES)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "expense_category" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "name" VARCHAR NOT NULL,
  "is_available" INTEGER DEFAULT 1,
  "is_measurable_cost" INTEGER DEFAULT 0,
  "unit_of_measure_id" INTEGER REFERENCES units_of_measure(id)
);

CREATE TABLE "expense" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "shift_id" INTEGER NOT NULL REFERENCES shift(id),
  "business_id" INTEGER NOT NULL REFERENCES business(id),
  "description" VARCHAR,
  "total" FLOAT NOT NULL,
  "quantity" FLOAT,
  "payment_type_id" INTEGER REFERENCES tipos_pago(id),
  "category_id" INTEGER NOT NULL REFERENCES expense_category(id),
  "note" VARCHAR,
  "date" BIGINT,
  "status" VARCHAR NOT NULL,
  "employee_id" INTEGER NOT NULL REFERENCES employee(id),
  "consumer_employee_id" INTEGER REFERENCES employee(id),
  "remote_id" INTEGER,
  "synced" INTEGER DEFAULT 0,
  "synced_at" BIGINT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- CAJA (CASH DRAWER)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "cash_drawer_sessions" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "shift_id" INTEGER NOT NULL REFERENCES shift(id),
  "employee_id" INTEGER NOT NULL REFERENCES employee(id),
  "business_id" INTEGER NOT NULL REFERENCES business(id),
  "start_time" BIGINT,
  "close_time" BIGINT,
  "initial_amount" FLOAT DEFAULT 0,
  "total_cash_sales" FLOAT DEFAULT 0,
  "total_card_sales" FLOAT DEFAULT 0,
  "total_credit_sales" FLOAT DEFAULT 0,
  "total_cash_payments" FLOAT DEFAULT 0,
  "total_card_payments" FLOAT DEFAULT 0,
  "total_expenses" FLOAT DEFAULT 0,
  "total_deposits" FLOAT DEFAULT 0,
  "total_withdrawals" FLOAT DEFAULT 0,
  "unregistered_weight_events" INTEGER DEFAULT 0,
  "scale_connection_events" INTEGER DEFAULT 0,
  "cancelled_sales" INTEGER DEFAULT 0,
  "expected_cash_in_drawer" FLOAT DEFAULT 0,
  "counted_cash" FLOAT DEFAULT 0,
  "difference" FLOAT DEFAULT 0,
  "notes" VARCHAR,
  "is_closed" INTEGER DEFAULT 0,
  "remote_id" INTEGER,
  "synced" INTEGER DEFAULT 0,
  "synced_at" BIGINT
);

CREATE TABLE "cash_transactions" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "shift_id" INTEGER NOT NULL REFERENCES shift(id),
  "timestamp" BIGINT NOT NULL,
  "type" INTEGER NOT NULL,
  "amount" FLOAT,
  "description" VARCHAR,
  "sale_id" INTEGER REFERENCES ventas(id),
  "expense_id" INTEGER REFERENCES expense(id),
  "client_payment_id" INTEGER REFERENCES pagos_cliente(id),
  "employee_id" INTEGER NOT NULL REFERENCES employee(id),
  "notes" VARCHAR,
  "is_voided" INTEGER DEFAULT 0,
  "voided_at" BIGINT,
  "voided_by_employee_id" INTEGER REFERENCES employee(id),
  "void_reason" VARCHAR
);

-- ═══════════════════════════════════════════════════════════════════════════
-- REPARTIDORES (DELIVERY)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "movimientos_saldo_repartidor" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "id_empleado" INTEGER REFERENCES employee(id),
  "fecha" BIGINT,
  "tipo_movimiento" VARCHAR,
  "monto" FLOAT,
  "saldo_anterior" FLOAT,
  "saldo_nuevo" FLOAT,
  "id_venta_asociada" INTEGER REFERENCES ventas(id),
  "notas" VARCHAR
);

-- ═══════════════════════════════════════════════════════════════════════════
-- GUARDIAN (MONITOREO)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "guardian_employee_scores" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "employee_id" INTEGER REFERENCES employee(id),
  "score" FLOAT DEFAULT 0,
  "critical_events" INTEGER DEFAULT 0,
  "high_events" INTEGER DEFAULT 0,
  "moderate_events" INTEGER DEFAULT 0,
  "low_events" INTEGER DEFAULT 0,
  "informative_events" INTEGER DEFAULT 0,
  "last_points_applied" FLOAT,
  "last_event_at" BIGINT,
  "last_critical_event_at" BIGINT,
  "last_high_or_critical_event_at" BIGINT,
  "last_decay_applied" BIGINT,
  "created_at" BIGINT,
  "last_reset_at" BIGINT,
  "last_updated_at" BIGINT,
  "score_band" VARCHAR
);

CREATE TABLE "suspicious_weighing_logs" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "shift_id" INTEGER REFERENCES shift(id),
  "employee_id" INTEGER REFERENCES employee(id),
  "timestamp" BIGINT,
  "event_type" VARCHAR,
  "weight_detected" FLOAT,
  "details" VARCHAR,
  "severity" VARCHAR,
  "suspicion_level" VARCHAR,
  "scenario_code" VARCHAR,
  "risk_score" INTEGER,
  "points_assigned" INTEGER,
  "employee_score_after_event" FLOAT,
  "employee_score_band" VARCHAR,
  "page_context" VARCHAR,
  "trust_score" FLOAT,
  "additional_data_json" VARCHAR,
  "was_reviewed" INTEGER DEFAULT 0,
  "review_notes" VARCHAR,
  "reviewed_at" BIGINT,
  "reviewed_by_employee_id" INTEGER REFERENCES employee(id),
  "similar_events_in_session" INTEGER,
  "cycle_duration_seconds" FLOAT,
  "max_weight_in_cycle" FLOAT,
  "discrepancy_amount" FLOAT,
  "related_product_id" INTEGER REFERENCES productos(id),
  "related_sale_id" INTEGER REFERENCES ventas(id),
  "remote_id" INTEGER,
  "synced" INTEGER DEFAULT 0,
  "synced_at" BIGINT
);

CREATE TABLE "scale_disconnection_log" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "user_id" INTEGER REFERENCES employee(id),
  "start_time" BIGINT,
  "end_time" BIGINT,
  "duration_minutes" FLOAT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- KARDEX (INVENTARIO)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "kardex_entries" (
  "id" SERIAL PRIMARY KEY,
  "tenant_id" INTEGER NOT NULL REFERENCES tenants(id),
  "branch_id" INTEGER NOT NULL REFERENCES branches(id),
  "product_id" INTEGER NOT NULL REFERENCES productos(id),
  "timestamp" BIGINT NOT NULL,
  "movement_type" INTEGER NOT NULL,
  "employee_id" INTEGER NOT NULL REFERENCES employee(id),
  "quantity_before" FLOAT,
  "quantity_change" FLOAT,
  "quantity_after" FLOAT,
  "description" VARCHAR,
  "sale_id" INTEGER REFERENCES ventas(id),
  "purchase_id" INTEGER REFERENCES purchases(id),
  "adjustment_id" INTEGER
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ÍNDICES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX idx_branches_tenant_id ON branches(tenant_id);
CREATE INDEX idx_employee_tenant_id ON employee(tenant_id);
CREATE INDEX idx_shift_tenant_branch ON shift(tenant_id, branch_id);
CREATE INDEX idx_shift_employee_id ON shift(employee_id);
CREATE INDEX idx_ventas_tenant_branch ON ventas(tenant_id, branch_id);
CREATE INDEX idx_ventas_id_turno ON ventas(id_turno);
CREATE INDEX idx_ventas_id_repartidor ON ventas(id_repartidor_asignado);
CREATE INDEX idx_ventas_detalle_id_venta ON ventas_detalle(id_venta);
CREATE INDEX idx_expense_tenant_branch ON expense(tenant_id, branch_id);
CREATE INDEX idx_expense_shift_id ON expense(shift_id);
CREATE INDEX idx_purchases_tenant_branch ON purchases(tenant_id, branch_id);
CREATE INDEX idx_purchases_shift_id ON purchases(shift_id);
CREATE INDEX idx_cash_drawer_tenant_branch ON cash_drawer_sessions(tenant_id, branch_id);
CREATE INDEX idx_cash_drawer_shift_id ON cash_drawer_sessions(shift_id);
CREATE INDEX idx_cash_trans_tenant_branch ON cash_transactions(tenant_id, branch_id);
CREATE INDEX idx_cash_trans_shift_id ON cash_transactions(shift_id);
CREATE INDEX idx_guardian_tenant_branch ON guardian_employee_scores(tenant_id, branch_id);
CREATE INDEX idx_guardian_employee_id ON guardian_employee_scores(employee_id);
CREATE INDEX idx_movimientos_repartidor_tenant_branch ON movimientos_saldo_repartidor(tenant_id, branch_id);
CREATE INDEX idx_movimientos_repartidor_empleado ON movimientos_saldo_repartidor(id_empleado);
CREATE INDEX idx_suspicious_logs_tenant_branch ON suspicious_weighing_logs(tenant_id, branch_id);
CREATE INDEX idx_suspicious_logs_shift_id ON suspicious_weighing_logs(shift_id);
CREATE INDEX idx_suspicious_logs_employee_id ON suspicious_weighing_logs(employee_id);

COMMIT;
