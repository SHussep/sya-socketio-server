-- =====================================================
-- PostgreSQL Database Schema - Final Clean State
-- SYA Tortillerías System
-- =====================================================
-- This file contains the complete database schema after
-- all migrations applied. No migration history needed.
-- =====================================================

-- ========== DATABASE CONFIGURATION ==========

-- Set database timezone to UTC (critical for timestamp consistency)
-- NOTE: Commented out to avoid hardcoding database name
-- The timezone is already configured in Render database settings
-- ALTER DATABASE sya_tortillerias SET timezone TO 'UTC';

-- ========== CORE TABLES ==========

-- subscriptions (planes de suscripción)
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    max_branches INTEGER NOT NULL DEFAULT 1,
    max_devices INTEGER NOT NULL DEFAULT 1,
    max_devices_per_branch INTEGER NOT NULL DEFAULT 3,
    max_employees INTEGER,
    features JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- tenants (empresas/organizaciones)
CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    tenant_code VARCHAR(50) UNIQUE NOT NULL,
    business_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone_number VARCHAR(50),
    subscription_id INTEGER REFERENCES subscriptions(id),
    subscription_status VARCHAR(50) DEFAULT 'trial',
    trial_ends_at TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- branches (sucursales)
CREATE TABLE IF NOT EXISTS branches (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    phone VARCHAR(50),
    timezone VARCHAR(50) DEFAULT 'America/Mexico_City',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, branch_code)
);

CREATE INDEX IF NOT EXISTS idx_branches_tenant_id ON branches(tenant_id);

-- roles (GLOBAL - fixed IDs)
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- employees (empleados)
CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username VARCHAR(100) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    password_hash VARCHAR(255),
    password_updated_at TIMESTAMP,
    role_id INTEGER REFERENCES roles(id) ON DELETE RESTRICT,
    is_active BOOLEAN DEFAULT TRUE,
    is_owner BOOLEAN DEFAULT FALSE,
    mobile_access_type VARCHAR(50) DEFAULT 'none',
    can_use_mobile_app BOOLEAN DEFAULT FALSE,
    google_user_identifier VARCHAR(255),
    main_branch_id INTEGER REFERENCES branches(id),

    -- Offline-first sync columns (for idempotency and audit trail)
    global_id VARCHAR(255) UNIQUE NOT NULL,
    terminal_id VARCHAR(100),
    local_op_seq BIGINT,
    created_local_utc TEXT,
    device_event_raw BIGINT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, username),
    UNIQUE(tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_employees_tenant_id ON employees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email);
CREATE INDEX IF NOT EXISTS idx_employees_global_id ON employees(global_id);

-- employee_branches (empleados asignados a sucursales)
CREATE TABLE IF NOT EXISTS employee_branches (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, employee_id, branch_id)
);

-- device_tokens (tokens FCM para notificaciones push)
CREATE TABLE IF NOT EXISTS device_tokens (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    device_token TEXT NOT NULL UNIQUE,
    platform VARCHAR(50) NOT NULL, -- 'android' or 'ios'
    device_name VARCHAR(255),
    device_id VARCHAR(255), -- Identificador único del dispositivo físico (Android ID o iOS identifierForVendor)
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_employee_id ON device_tokens(employee_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_branch_id ON device_tokens(branch_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_is_active ON device_tokens(is_active);
CREATE INDEX IF NOT EXISTS idx_device_tokens_device_id ON device_tokens(device_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_device_employee ON device_tokens(device_id, employee_id, is_active);

-- sessions (sesiones de usuario)
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id ON sessions(tenant_id);

-- ========== SHIFTS AND CASH MANAGEMENT ==========

-- shifts (turnos de empleados)
CREATE TABLE IF NOT EXISTS shifts (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    end_time TIMESTAMP WITH TIME ZONE,
    initial_amount DECIMAL(10, 2) DEFAULT 0,
    final_amount DECIMAL(10, 2),
    is_cash_cut_open BOOLEAN DEFAULT TRUE,
    transaction_counter INTEGER DEFAULT 0,

    -- Offline-first sync columns (for idempotency and audit trail)
    global_id VARCHAR(36) UNIQUE NOT NULL,
    terminal_id VARCHAR(36) NOT NULL,
    local_op_seq BIGINT NOT NULL,
    created_local_utc VARCHAR(50) NOT NULL,
    device_event_raw BIGINT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS shifts_uq_global_id ON shifts(global_id);

-- expense_categories (categorías de gastos)
CREATE TABLE IF NOT EXISTS expense_categories (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- expenses (gastos)
CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    id_turno INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
    description TEXT,
    amount DECIMAL(10, 2) NOT NULL,
    quantity DECIMAL(10, 3),  -- Cantidad medible (litros para combustible, kg para materiales, etc.)
    expense_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    payment_type_id INTEGER,  -- 1=Efectivo, 2=Tarjeta

    -- Status (draft = borrador editable, confirmed = confirmado en liquidación, deleted = eliminado)
    status VARCHAR(20) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft', 'confirmed', 'deleted')),

    -- Mobile app review system
    reviewed_by_desktop BOOLEAN DEFAULT FALSE,  -- TRUE = aprobado por Desktop, FALSE = pendiente de revisión

    -- Soft delete (legacy - usar status='deleted' preferiblemente)
    is_active BOOLEAN DEFAULT TRUE,
    deleted_at TIMESTAMP,

    -- Offline-first sync columns (for idempotency and audit trail)
    global_id VARCHAR(255) UNIQUE NOT NULL,
    terminal_id VARCHAR(100) NOT NULL,
    local_op_seq INTEGER NOT NULL,
    device_event_raw BIGINT,
    created_local_utc TEXT NOT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expenses_tenant_id ON expenses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_expenses_branch_id ON expenses(branch_id);
CREATE INDEX IF NOT EXISTS idx_expenses_shift ON expenses(id_turno);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_payment_type ON expenses(payment_type_id);
CREATE INDEX IF NOT EXISTS idx_expenses_quantity ON expenses(quantity) WHERE quantity IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_is_active ON expenses(is_active);
CREATE INDEX IF NOT EXISTS idx_expenses_deleted_at ON expenses(deleted_at);
CREATE INDEX IF NOT EXISTS idx_expenses_terminal_seq ON expenses(terminal_id, local_op_seq);
CREATE INDEX IF NOT EXISTS idx_expenses_reviewed_by_desktop ON expenses(employee_id, reviewed_by_desktop) WHERE reviewed_by_desktop = FALSE;
CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
CREATE INDEX IF NOT EXISTS idx_expenses_employee_status ON expenses(employee_id, status);

-- deposits (depósitos)
CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    deposit_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description TEXT NOT NULL DEFAULT '',

    -- Offline-first sync columns (for idempotency and audit trail)
    global_id VARCHAR(255) UNIQUE NOT NULL,
    terminal_id VARCHAR(100) NOT NULL,
    local_op_seq INTEGER NOT NULL,
    device_event_raw BIGINT,
    created_local_utc TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposits_tenant_branch ON deposits(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_deposits_shift ON deposits(shift_id);
CREATE INDEX IF NOT EXISTS idx_deposits_employee ON deposits(employee_id);
CREATE INDEX IF NOT EXISTS idx_deposits_date ON deposits(deposit_date);
CREATE INDEX IF NOT EXISTS idx_deposits_terminal_seq ON deposits(terminal_id, local_op_seq);

-- withdrawals (retiros)
CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    withdrawal_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description TEXT NOT NULL DEFAULT '',

    -- Offline-first sync columns (for idempotency and audit trail)
    global_id VARCHAR(255) UNIQUE NOT NULL,
    terminal_id VARCHAR(100) NOT NULL,
    local_op_seq INTEGER NOT NULL,
    device_event_raw BIGINT,
    created_local_utc TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_tenant_branch ON withdrawals(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_shift ON withdrawals(shift_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_employee ON withdrawals(employee_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_date ON withdrawals(withdrawal_date);
CREATE INDEX IF NOT EXISTS idx_withdrawals_terminal_seq ON withdrawals(terminal_id, local_op_seq);

-- cash_cuts (cortes de caja)
CREATE TABLE IF NOT EXISTS cash_cuts (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,

    -- Timing
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    cut_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Initial amount
    initial_amount NUMERIC(12, 2) DEFAULT 0,

    -- Sales breakdown by payment type
    total_cash_sales NUMERIC(12, 2) DEFAULT 0,
    total_card_sales NUMERIC(12, 2) DEFAULT 0,
    total_credit_sales NUMERIC(12, 2) DEFAULT 0,

    -- Credit payment collections
    total_cash_payments NUMERIC(12, 2) DEFAULT 0,
    total_card_payments NUMERIC(12, 2) DEFAULT 0,

    -- Deposits and withdrawals
    total_deposits NUMERIC(12, 2) DEFAULT 0,
    total_withdrawals NUMERIC(12, 2) DEFAULT 0,
    total_expenses NUMERIC(12, 2) NOT NULL,

    -- Cash reconciliation
    expected_cash_in_drawer NUMERIC(12, 2) DEFAULT 0,
    counted_cash NUMERIC(12, 2) DEFAULT 0,
    difference NUMERIC(12, 2) DEFAULT 0,

    -- Security events (Guardian)
    unregistered_weight_events INTEGER DEFAULT 0,
    scale_connection_events INTEGER DEFAULT 0,
    cancelled_sales INTEGER DEFAULT 0,

    -- Notes and status
    notes TEXT,
    is_closed BOOLEAN DEFAULT TRUE,

    -- Offline-first sync columns (for idempotency and audit trail)
    global_id VARCHAR(255) UNIQUE NOT NULL,
    terminal_id VARCHAR(100) NOT NULL,
    local_op_seq INTEGER NOT NULL,
    device_event_raw BIGINT,
    created_local_utc TEXT NOT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cash_cuts_tenant_id ON cash_cuts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cash_cuts_branch_id ON cash_cuts(branch_id);
CREATE INDEX IF NOT EXISTS idx_cash_cuts_shift ON cash_cuts(shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cash_cuts_closed ON cash_cuts(tenant_id, branch_id, is_closed);
CREATE INDEX IF NOT EXISTS idx_cash_cuts_end_time ON cash_cuts(tenant_id, branch_id, end_time DESC) WHERE end_time IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cash_cuts_terminal_seq ON cash_cuts(terminal_id, local_op_seq);

-- ========== CUSTOMERS AND PRODUCTS ==========

-- customers (clientes)
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id_cliente INTEGER,  -- Desktop local ID (preserved for traceability)

    -- Customer information
    nombre VARCHAR(255) NOT NULL,
    direccion TEXT,
    correo VARCHAR(255),
    telefono VARCHAR(50),
    telefono_secundario VARCHAR(50),

    -- Status and configuration
    activo BOOLEAN DEFAULT TRUE,
    nota TEXT,

    -- Credit system
    tiene_credito BOOLEAN DEFAULT FALSE,
    credito_limite NUMERIC(10,2) DEFAULT 0,
    saldo_deudor NUMERIC(10,2) DEFAULT 0,

    -- Discount system
    tipo_descuento INTEGER DEFAULT 0,  -- 0=None, 1=Percentage, 2=Fixed amount
    porcentaje_descuento NUMERIC(5,2) DEFAULT 0,
    monto_descuento_fijo NUMERIC(10,2) DEFAULT 0,
    aplicar_redondeo BOOLEAN DEFAULT FALSE,

    -- Generic customer (Público en General)
    is_system_generic BOOLEAN DEFAULT FALSE,

    -- Offline-first sync columns (for idempotency and audit trail)
    global_id VARCHAR(255) UNIQUE NOT NULL,
    terminal_id VARCHAR(100),
    local_op_seq INTEGER,
    created_local_utc TEXT,
    device_event_raw BIGINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_global_id ON customers(global_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_generic_per_tenant ON customers(tenant_id) WHERE is_system_generic = TRUE;
CREATE INDEX IF NOT EXISTS idx_customers_terminal_seq ON customers(terminal_id, local_op_seq) WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_activo ON customers(tenant_id, activo);
CREATE INDEX IF NOT EXISTS idx_customers_credito ON customers(tenant_id, tiene_credito) WHERE tiene_credito = TRUE;
CREATE INDEX IF NOT EXISTS idx_customers_nombre ON customers(tenant_id, nombre);

-- productos (products)
CREATE TABLE IF NOT EXISTS productos (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id_producto BIGINT,  -- Desktop local ID

    -- Product information
    descripcion VARCHAR(255) NOT NULL,
    categoria INTEGER,  -- FK to categories table

    -- Pricing
    precio_compra NUMERIC(10,2) DEFAULT 0,
    precio_venta NUMERIC(10,2) DEFAULT 0,

    -- Product configuration
    produccion BOOLEAN DEFAULT FALSE,  -- Is production product
    inventariar BOOLEAN DEFAULT FALSE,  -- Track inventory
    tipos_de_salida_id INTEGER,  -- Output type
    notificar BOOLEAN DEFAULT FALSE,  -- Notify when low stock
    minimo NUMERIC(10,2) DEFAULT 0,  -- Minimum inventory
    inventario NUMERIC(10,2) DEFAULT 0,  -- Current inventory

    -- Relations
    proveedor_id INTEGER,  -- Supplier ID
    unidad_medida_id INTEGER,  -- Unit of measure ID

    -- Status and configuration
    eliminado BOOLEAN DEFAULT FALSE,  -- Soft delete
    bascula BOOLEAN DEFAULT FALSE,  -- Requires scale/weight
    is_pos_shortcut BOOLEAN DEFAULT FALSE,  -- Show in POS shortcuts

    -- Offline-first sync columns (for idempotency)
    global_id VARCHAR(255) UNIQUE NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_productos_tenant ON productos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_productos_global_id ON productos(global_id);
CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(tenant_id, categoria);
CREATE INDEX IF NOT EXISTS idx_productos_proveedor ON productos(tenant_id, proveedor_id);
CREATE INDEX IF NOT EXISTS idx_productos_activos ON productos(tenant_id, eliminado) WHERE eliminado = FALSE;
CREATE INDEX IF NOT EXISTS idx_productos_pos_shortcuts ON productos(tenant_id, is_pos_shortcut) WHERE is_pos_shortcut = TRUE;
CREATE INDEX IF NOT EXISTS idx_productos_inventariables ON productos(tenant_id, inventariar) WHERE inventariar = TRUE;
CREATE INDEX IF NOT EXISTS idx_productos_bajo_stock ON productos(tenant_id, inventario, minimo) WHERE inventariar = TRUE AND notificar = TRUE;

-- ========== VENTAS (SALES) ==========

-- ventas (sales)
CREATE TABLE IF NOT EXISTS ventas (
    id_venta INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Scope
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

    -- Status and assignments
    estado_venta_id INTEGER NOT NULL DEFAULT 3,  -- 1=Draft, 2=Assigned, 3=Completed, 4=Cancelled, 5=Settled
    status VARCHAR(30),  -- 'completed' | 'cancelled'
    id_repartidor_asignado INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    id_turno_repartidor INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    id_turno INTEGER NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,

    -- Relations
    id_empleado INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    id_cliente INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    venta_tipo_id INTEGER,  -- 1=Counter, 2=Delivery
    tipo_pago_id INTEGER,  -- Payment type ID: 1=Efectivo, 2=Tarjeta, 3=Crédito

    -- Ticket number (visible folio)
    ticket_number INTEGER NOT NULL,

    -- Raw timestamps (preserves .NET ticks or epoch_ms)
    fecha_venta_raw BIGINT,
    fecha_liquidacion_raw BIGINT,

    -- Amounts
    subtotal NUMERIC(14,2) DEFAULT 0,
    total_descuentos NUMERIC(14,2) DEFAULT 0,
    total NUMERIC(14,2) NOT NULL,
    monto_pagado NUMERIC(14,2) DEFAULT 0,

    -- Notes
    notas TEXT,

    -- Generated columns (from raw timestamps)
    fecha_venta_utc TIMESTAMPTZ GENERATED ALWAYS AS
        (CASE
            WHEN fecha_venta_raw IS NULL THEN NULL
            ELSE to_timestamp((fecha_venta_raw)::double precision / 1000.0)
        END) STORED,

    fecha_liquidacion_utc TIMESTAMPTZ GENERATED ALWAYS AS
        (CASE
            WHEN fecha_liquidacion_raw IS NULL THEN NULL
            ELSE to_timestamp((fecha_liquidacion_raw)::double precision / 1000.0)
        END) STORED,

    -- Offline-first columns (for idempotency and audit trail)
    global_id UUID UNIQUE NOT NULL,
    terminal_id UUID NOT NULL,
    local_op_seq INTEGER NOT NULL,
    created_local_utc TEXT NOT NULL,
    device_event_raw BIGINT,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ✅ CONSTRAINT CORRECTO: Un ticket es único POR TURNO
-- Cada turno tiene su propia secuencia de tickets (1, 2, 3, ..., N)
-- El mismo empleado puede tener ticket #1 en turno A y ticket #1 en turno B
CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_ticket_per_shift ON ventas(tenant_id, branch_id, ticket_number, id_turno);
CREATE INDEX IF NOT EXISTS ventas_scope_time_idx ON ventas(tenant_id, branch_id, fecha_venta_utc DESC);
CREATE INDEX IF NOT EXISTS ventas_scope_turno_idx ON ventas(tenant_id, branch_id, id_turno);
CREATE INDEX IF NOT EXISTS ventas_scope_emp_idx ON ventas(tenant_id, branch_id, id_empleado);
CREATE INDEX IF NOT EXISTS ventas_estado_idx ON ventas(tenant_id, branch_id, estado_venta_id);
CREATE INDEX IF NOT EXISTS ventas_repartidor_idx ON ventas(id_repartidor_asignado) WHERE id_repartidor_asignado IS NOT NULL;
CREATE INDEX IF NOT EXISTS ventas_liquidacion_idx ON ventas(fecha_liquidacion_utc) WHERE fecha_liquidacion_utc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ventas_terminal_seq ON ventas(terminal_id, local_op_seq);

-- ventas_detalle (sale items)
CREATE TABLE IF NOT EXISTS ventas_detalle (
    id_venta_detalle INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- FK to venta
    id_venta INTEGER NOT NULL REFERENCES ventas(id_venta) ON DELETE CASCADE,

    -- Product
    id_producto INTEGER NOT NULL,
    descripcion_producto VARCHAR(255) NOT NULL,

    -- Quantities and prices
    cantidad NUMERIC(14,3) NOT NULL,  -- 3 decimals for weight
    precio_lista NUMERIC(14,2) NOT NULL,
    precio_unitario NUMERIC(14,2) NOT NULL,
    total_linea NUMERIC(14,2) NOT NULL,

    -- Discounts
    tipo_descuento_cliente_id INTEGER,
    monto_cliente_descuento NUMERIC(14,2) DEFAULT 0,
    tipo_descuento_manual_id INTEGER,
    monto_manual_descuento NUMERIC(14,2) DEFAULT 0,

    -- Offline-first columns
    global_id UUID UNIQUE NOT NULL,
    terminal_id UUID NOT NULL,
    local_op_seq INTEGER NOT NULL,
    created_local_utc TEXT NOT NULL,
    device_event_raw BIGINT,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ventas_detalle_venta_idx ON ventas_detalle(id_venta);
CREATE INDEX IF NOT EXISTS ventas_detalle_producto_idx ON ventas_detalle(id_producto);
CREATE INDEX IF NOT EXISTS idx_ventas_detalle_terminal_seq ON ventas_detalle(terminal_id, local_op_seq);

-- ========== REPARTIDOR (DELIVERY) SYSTEM ==========

-- repartidor_assignments (asignaciones a repartidores)
-- CRITICAL: Uses Spanish naming convention (id_venta, NOT sale_id)
CREATE TABLE IF NOT EXISTS repartidor_assignments (
    id SERIAL PRIMARY KEY,

    -- Relations
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    venta_id INTEGER NOT NULL REFERENCES ventas(id_venta) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    created_by_employee_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    repartidor_shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,

    -- Assignment details (READONLY - original values, never updated)
    assigned_quantity NUMERIC(10, 2) NOT NULL,
    assigned_amount NUMERIC(10, 2) NOT NULL,
    unit_price NUMERIC(10, 2) NOT NULL,

    -- Status
    status VARCHAR(30) NOT NULL DEFAULT 'pending',  -- pending | in_progress | liquidated | cancelled

    -- Dates
    fecha_asignacion TIMESTAMP NOT NULL DEFAULT NOW(),
    fecha_liquidacion TIMESTAMP,

    -- Notes
    observaciones TEXT,

    -- Offline-first sync columns
    global_id UUID UNIQUE NOT NULL,
    terminal_id UUID NOT NULL,
    local_op_seq INTEGER NOT NULL,
    created_local_utc TIMESTAMPTZ NOT NULL,
    device_event_raw BIGINT,

    -- Audit
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_tenant ON repartidor_assignments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_branch ON repartidor_assignments(branch_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_venta_id ON repartidor_assignments(venta_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_employee ON repartidor_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_created_by ON repartidor_assignments(created_by_employee_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_shift ON repartidor_assignments(shift_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_repartidor_shift ON repartidor_assignments(repartidor_shift_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_status ON repartidor_assignments(status);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_terminal_seq ON repartidor_assignments(terminal_id, local_op_seq);

-- repartidor_returns (devoluciones de repartidores)
CREATE TABLE IF NOT EXISTS repartidor_returns (
    id SERIAL PRIMARY KEY,

    -- UUID for idempotency (offline-first)
    global_id UUID UNIQUE NOT NULL,

    -- Relations and traceability
    assignment_id INTEGER NOT NULL REFERENCES repartidor_assignments(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    registered_by_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,

    -- Return details
    quantity NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10,2) NOT NULL,
    amount NUMERIC(10,2) NOT NULL,  -- Calculated: quantity * unit_price

    -- Date and origin
    return_date TIMESTAMP WITH TIME ZONE NOT NULL,
    source VARCHAR(20) NOT NULL CHECK (source IN ('desktop', 'mobile')),
    notes TEXT,

    -- Status (draft = borrador editable, confirmed = confirmado en liquidación, deleted = eliminado)
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'deleted')),

    -- Offline-first fields
    terminal_id UUID NOT NULL,
    local_op_seq INTEGER NOT NULL,
    created_local_utc TIMESTAMP WITH TIME ZONE NOT NULL,
    device_event_raw BIGINT,

    -- Audit
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repartidor_returns_global_id ON repartidor_returns(global_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_assignment ON repartidor_returns(assignment_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_employee ON repartidor_returns(employee_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_tenant ON repartidor_returns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_branch ON repartidor_returns(branch_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_shift ON repartidor_returns(shift_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_return_date ON repartidor_returns(return_date);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_source ON repartidor_returns(source);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_status ON repartidor_returns(status);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_employee_status ON repartidor_returns(employee_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS unique_repartidor_returns_global_terminal ON repartidor_returns(global_id, terminal_id);

-- ========== CREDIT PAYMENTS ==========

-- credit_payments (pagos a crédito)
CREATE TABLE IF NOT EXISTS credit_payments (
    id SERIAL PRIMARY KEY,

    -- Scope
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

    -- References
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,

    -- Payment data
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash', 'card')),
    payment_date TIMESTAMPTZ NOT NULL,
    notes TEXT,

    -- Offline-first (for idempotency and audit trail)
    global_id VARCHAR(255) UNIQUE NOT NULL,
    terminal_id VARCHAR(100),
    local_op_seq INTEGER,
    device_event_raw BIGINT,
    created_local_utc TEXT,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_payments_tenant_branch ON credit_payments(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_credit_payments_customer ON credit_payments(customer_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_credit_payments_shift ON credit_payments(shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_payments_employee ON credit_payments(employee_id, payment_date DESC) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_payments_global_id ON credit_payments(global_id);
CREATE INDEX IF NOT EXISTS idx_credit_payments_terminal_seq ON credit_payments(terminal_id, local_op_seq) WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_credit_payments_method ON credit_payments(tenant_id, payment_method, payment_date DESC);

-- ========== TRIGGERS ==========

-- Trigger: Actualizar saldo_deudor en customers automáticamente
CREATE OR REPLACE FUNCTION update_customer_balance()
RETURNS TRIGGER AS $$
BEGIN
    -- INSERT venta a crédito → aumenta saldo_deudor
    IF TG_OP = 'INSERT' AND NEW.tipo_pago_id = 3 THEN
        UPDATE customers
        SET saldo_deudor = saldo_deudor + NEW.total
        WHERE id = NEW.id_cliente;

    -- UPDATE status='cancelled' → revierte saldo
    ELSIF TG_OP = 'UPDATE' AND OLD.status != 'cancelled' AND NEW.status = 'cancelled' AND NEW.tipo_pago_id = 3 THEN
        UPDATE customers
        SET saldo_deudor = saldo_deudor - NEW.total
        WHERE id = NEW.id_cliente;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_customer_balance
AFTER INSERT OR UPDATE ON ventas
FOR EACH ROW
WHEN (NEW.id_cliente IS NOT NULL AND NEW.tipo_pago_id = 3)
EXECUTE FUNCTION update_customer_balance();

-- Trigger: Disminuir saldo_deudor cuando se registra un pago a crédito
CREATE OR REPLACE FUNCTION decrease_customer_balance_on_payment()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE customers
    SET saldo_deudor = GREATEST(saldo_deudor - NEW.amount, 0)
    WHERE id = NEW.customer_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_decrease_balance_on_credit_payment
AFTER INSERT ON credit_payments
FOR EACH ROW
EXECUTE FUNCTION decrease_customer_balance_on_payment();

-- Function: Obtener o crear cliente genérico "Público en General" por tenant
CREATE OR REPLACE FUNCTION get_or_create_generic_customer(p_tenant_id INTEGER, p_branch_id INTEGER)
RETURNS INTEGER AS $$
DECLARE
    v_customer_id INTEGER;
BEGIN
    -- Intentar encontrar el cliente genérico existente
    SELECT id INTO v_customer_id
    FROM customers
    WHERE tenant_id = p_tenant_id
    AND is_system_generic = TRUE
    LIMIT 1;

    -- Si no existe, crearlo
    IF v_customer_id IS NULL THEN
        INSERT INTO customers (
            tenant_id,
            nombre,
            telefono,
            direccion,
            correo,
            is_system_generic,
            nota,
            global_id,
            created_at,
            updated_at
        ) VALUES (
            p_tenant_id,
            'Público en General',
            'N/A',
            'N/A',
            NULL,
            TRUE,
            'Cliente genérico del sistema - No editar ni eliminar',
            'GENERIC_CUSTOMER_' || p_tenant_id,
            NOW(),
            NOW()
        )
        RETURNING id INTO v_customer_id;

        RAISE NOTICE '✅ Cliente genérico creado para tenant % con ID %', p_tenant_id, v_customer_id;
    END IF;

    RETURN v_customer_id;
END;
$$ LANGUAGE plpgsql;

-- Trigger: Prevenir eliminación del cliente genérico del sistema
CREATE OR REPLACE FUNCTION prevent_generic_customer_delete()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_system_generic = TRUE THEN
        RAISE EXCEPTION 'No se puede eliminar el cliente genérico del sistema (ID: %)', OLD.id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_generic_customer_delete ON customers;
CREATE TRIGGER trg_prevent_generic_customer_delete
    BEFORE DELETE ON customers
    FOR EACH ROW
    EXECUTE FUNCTION prevent_generic_customer_delete();

-- ========== BACKUP METADATA ==========

-- backup_metadata (metadatos de respaldos en Dropbox)
CREATE TABLE IF NOT EXISTS backup_metadata (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    backup_filename VARCHAR(255) NOT NULL,
    backup_path TEXT NOT NULL,
    file_size_bytes BIGINT,
    device_name VARCHAR(255),
    device_id VARCHAR(255),
    is_automatic BOOLEAN DEFAULT FALSE,
    encryption_enabled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ========== COMENTARIOS ==========
COMMENT ON TABLE tenants IS 'Empresas/organizaciones multi-tenant';
COMMENT ON TABLE branches IS 'Sucursales por tenant';
COMMENT ON TABLE employees IS 'Empleados con acceso al sistema';
COMMENT ON TABLE shifts IS 'Turnos de trabajo de empleados';
COMMENT ON TABLE expenses IS 'Gastos registrados por sucursal';
COMMENT ON TABLE deposits IS 'Depósitos de efectivo';
COMMENT ON TABLE withdrawals IS 'Retiros de efectivo';
COMMENT ON TABLE customers IS 'Clientes del sistema';
COMMENT ON TABLE productos IS 'Productos vendidos';
COMMENT ON TABLE ventas IS 'Ventas registradas (mostrador y repartidor)';
COMMENT ON TABLE ventas_detalle IS 'Detalle de líneas de venta';
COMMENT ON TABLE repartidor_assignments IS 'Asignaciones de ventas a repartidores';
COMMENT ON TABLE repartidor_returns IS 'Devoluciones de repartidores';
COMMENT ON TABLE credit_payments IS 'Pagos de clientes con crédito';
COMMENT ON TABLE backup_metadata IS 'Metadatos de respaldos en Dropbox';
