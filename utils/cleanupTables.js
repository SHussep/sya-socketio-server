// ═══════════════════════════════════════════════════════════════
// TABLA DE LIMPIEZA COMPARTIDA
// Usado por: scripts/db-cleanup.js y routes/data-reset.js
// ═══════════════════════════════════════════════════════════════

// LIMPIEZA PARCIAL: Solo datos transaccionales
// Mantiene: empleados, clientes, productos, sucursales, tenant, roles, config
const PARTIAL_CLEANUP_TABLES = [
    { name: 'notas_credito_detalle', description: 'Detalles de notas de credito', fkColumn: 'tenant_id' },
    { name: 'inventory_transfer_items', description: 'Items de transferencias', fkColumn: 'tenant_id' },
    { name: 'ventas_detalle', description: 'Detalles de ventas', fkColumn: 'tenant_id' },
    { name: 'purchase_details', description: 'Detalles de compras', fkColumn: 'tenant_id' },
    { name: 'notas_credito', description: 'Notas de credito', fkColumn: 'tenant_id' },
    { name: 'inventory_transfers', description: 'Transferencias de inventario', fkColumn: 'tenant_id' },
    { name: 'repartidor_returns', description: 'Devoluciones de repartidor', fkColumn: 'tenant_id' },
    { name: 'repartidor_assignments', description: 'Asignaciones de repartidor', fkColumn: 'tenant_id' },
    { name: 'ventas', description: 'Ventas', fkColumn: 'tenant_id' },
    { name: 'credit_payments', description: 'Pagos de credito', fkColumn: 'tenant_id' },
    { name: 'suspicious_weighing_logs', description: 'Logs pesajes sospechosos', fkColumn: 'tenant_id' },
    { name: 'scale_disconnection_logs', description: 'Logs desconexion bascula', fkColumn: 'tenant_id' },
    { name: 'preparation_mode_logs', description: 'Logs modo preparacion', fkColumn: 'tenant_id' },
    { name: 'employee_debts', description: 'Deudas de empleados', fkColumn: 'tenant_id' },
    { name: 'cash_cuts', description: 'Cortes de caja', fkColumn: 'tenant_id' },
    { name: 'deposits', description: 'Depositos', fkColumn: 'tenant_id' },
    { name: 'withdrawals', description: 'Retiros', fkColumn: 'tenant_id' },
    { name: 'expenses', description: 'Gastos', fkColumn: 'tenant_id' },
    { name: 'purchases', description: 'Compras', fkColumn: 'tenant_id' },
    { name: 'shift_requests', description: 'Solicitudes de turno', fkColumn: 'tenant_id' },
    { name: 'shifts', description: 'Turnos', fkColumn: 'tenant_id' },
    { name: 'kardex_entries', description: 'Movimientos de inventario (kardex)', fkColumn: 'tenant_id' },
    { name: 'repartidor_locations', description: 'Ubicaciones GPS repartidores', fkColumn: 'tenant_id' },
    { name: 'geofence_events', description: 'Eventos de geofence', fkColumn: 'tenant_id' },
    { name: 'telemetry_events', description: 'Telemetria', fkColumn: 'tenant_id' },
    { name: 'sync_error_reports', description: 'Reportes de errores de sync', fkColumn: 'tenant_id' },
    { name: 'backup_metadata', description: 'Metadata respaldos', fkColumn: 'tenant_id' },
];

// LIMPIEZA COMPLETA: TODO incluido
// Orden por dependencias FK (hijas primero)
const FULL_CLEANUP_TABLES = [
    // Nivel 1: Detalles (tablas hijas)
    { name: 'notas_credito_detalle', description: 'Detalles de notas de credito', fkColumn: 'tenant_id' },
    { name: 'inventory_transfer_items', description: 'Items de transferencias', fkColumn: 'tenant_id' },
    { name: 'ventas_detalle', description: 'Detalles de ventas', fkColumn: 'tenant_id' },
    { name: 'purchase_details', description: 'Detalles de compras', fkColumn: 'tenant_id' },
    // Nivel 2: Transacciones
    { name: 'notas_credito', description: 'Notas de credito', fkColumn: 'tenant_id' },
    { name: 'inventory_transfers', description: 'Transferencias de inventario', fkColumn: 'tenant_id' },
    { name: 'repartidor_returns', description: 'Devoluciones de repartidor', fkColumn: 'tenant_id' },
    { name: 'repartidor_assignments', description: 'Asignaciones de repartidor', fkColumn: 'tenant_id' },
    { name: 'ventas', description: 'Ventas', fkColumn: 'tenant_id' },
    { name: 'credit_payments', description: 'Pagos de credito', fkColumn: 'tenant_id' },
    { name: 'suspicious_weighing_logs', description: 'Logs pesajes sospechosos', fkColumn: 'tenant_id' },
    { name: 'scale_disconnection_logs', description: 'Logs desconexion bascula', fkColumn: 'tenant_id' },
    { name: 'preparation_mode_logs', description: 'Logs modo preparacion', fkColumn: 'tenant_id' },
    { name: 'employee_debts', description: 'Deudas de empleados', fkColumn: 'tenant_id' },
    { name: 'cash_cuts', description: 'Cortes de caja', fkColumn: 'tenant_id' },
    { name: 'deposits', description: 'Depositos', fkColumn: 'tenant_id' },
    { name: 'withdrawals', description: 'Retiros', fkColumn: 'tenant_id' },
    { name: 'expenses', description: 'Gastos', fkColumn: 'tenant_id' },
    { name: 'purchases', description: 'Compras', fkColumn: 'tenant_id' },
    { name: 'shift_requests', description: 'Solicitudes de turno', fkColumn: 'tenant_id' },
    { name: 'shifts', description: 'Turnos', fkColumn: 'tenant_id' },
    { name: 'kardex_entries', description: 'Movimientos de inventario (kardex)', fkColumn: 'tenant_id' },
    // Nivel 3: GPS y geofence
    { name: 'repartidor_locations', description: 'Ubicaciones GPS repartidores', fkColumn: 'tenant_id' },
    { name: 'gps_consent_log', description: 'Consentimiento GPS', fkColumn: 'tenant_id' },
    { name: 'employee_geofence_zones', description: 'Asignaciones empleado-zona', fkColumn: 'tenant_id' },
    { name: 'geofence_events', description: 'Eventos de geofence', fkColumn: 'tenant_id' },
    { name: 'geofence_zones', description: 'Zonas de geofence', fkColumn: 'tenant_id' },
    // Nivel 4: Config y union
    { name: 'sessions', description: 'Sesiones', fkColumn: 'tenant_id' },
    { name: 'device_tokens', description: 'Tokens FCM', fkColumn: null, customQuery: 'employee_id' },
    { name: 'employee_branches', description: 'Empleados-Sucursales', fkColumn: 'tenant_id' },
    { name: 'producto_branches', description: 'Productos asignados por sucursal', fkColumn: 'tenant_id' },
    { name: 'productos_branch_precios', description: 'Precios por sucursal', fkColumn: 'tenant_id' },
    { name: 'branch_inventory', description: 'Inventario por sucursal', fkColumn: 'tenant_id' },
    { name: 'branch_devices', description: 'Dispositivos por sucursal', fkColumn: 'tenant_id' },
    { name: 'notification_preferences', description: 'Preferencias notificaciones', fkColumn: 'tenant_id' },
    { name: 'cliente_branches', description: 'Clientes-Sucursales', fkColumn: 'tenant_id' },
    { name: 'backup_metadata', description: 'Metadata respaldos', fkColumn: 'tenant_id' },
    { name: 'telemetry_events', description: 'Telemetria', fkColumn: 'tenant_id' },
    { name: 'notifications', description: 'Notificaciones', fkColumn: 'tenant_id' },
    // Nivel 5: Maestros
    { name: 'role_permissions', description: 'Permisos de rol', fkColumn: 'tenant_id' },
    { name: 'employees', description: 'EMPLEADOS', fkColumn: 'tenant_id', critical: true },
    { name: 'productos', description: 'PRODUCTOS', fkColumn: 'tenant_id', critical: true },
    { name: 'customers', description: 'CLIENTES', fkColumn: 'tenant_id', critical: true },
    { name: 'roles', description: 'ROLES', fkColumn: 'tenant_id', critical: true },
    { name: 'categorias_productos', description: 'Categorías productos', fkColumn: 'tenant_id' },
    { name: 'devices', description: 'Dispositivos', fkColumn: 'tenant_id' },
    { name: 'fcm_tokens', description: 'Tokens FCM', fkColumn: 'tenant_id' },
    { name: 'followup_emails', description: 'Emails de seguimiento', fkColumn: 'tenant_id' },
    // Nivel 6: Tenant/Branch (solo en cleanup completo con --mode=full)
    { name: 'sync_error_reports', description: 'Reportes de errores de sync', fkColumn: 'tenant_id' },
    { name: 'branch_licenses', description: 'Licencias de sucursal', fkColumn: 'tenant_id' },
    { name: 'branches', description: 'SUCURSALES', fkColumn: 'tenant_id', critical: true, structural: true },
    { name: 'tenants', description: 'TENANT', fkColumn: 'id', critical: true, isTenantTable: true, structural: true },
];

module.exports = { PARTIAL_CLEANUP_TABLES, FULL_CLEANUP_TABLES };
