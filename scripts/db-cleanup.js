#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * SYA Database Cleanup Tool
 * ═══════════════════════════════════════════════════════════════
 *
 * Herramienta interactiva para eliminar datos de un tenant.
 *
 * MODOS:
 *   1. Limpieza Parcial - Solo datos transaccionales (ventas, turnos, etc.)
 *      Mantiene: empleados, clientes, productos, sucursales, tenant
 *
 *   2. Limpieza Completa - ELIMINA TODO del tenant
 *      Incluye: empleados, clientes, productos, sucursales, tenant
 *
 * Uso:
 *   node scripts/db-cleanup.js
 *
 * O con argumentos:
 *   node scripts/db-cleanup.js --tenant=16 --mode=partial --dry-run
 *   node scripts/db-cleanup.js --tenant=16 --mode=full --force
 *
 * ═══════════════════════════════════════════════════════════════
 */

const { Pool } = require('pg');
const readline = require('readline');
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════
// CONFIGURACION
// ═══════════════════════════════════════════════════════════════

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// TABLAS PARA LIMPIEZA PARCIAL (solo datos transaccionales)
// Las tablas de empleados, clientes, productos estan PROTEGIDAS
const PARTIAL_CLEANUP_TABLES = [
    // Nivel 1: Tablas mas dependientes
    { name: 'notas_credito_detalle', description: 'Detalles de notas de credito' },
    { name: 'notas_credito', description: 'Notas de credito' },
    { name: 'repartidor_returns', description: 'Devoluciones de repartidor' },
    { name: 'repartidor_assignments', description: 'Asignaciones de repartidor' },
    { name: 'ventas_detalle', description: 'Detalles de ventas' },
    { name: 'ventas', description: 'Ventas' },
    { name: 'credit_payments', description: 'Pagos de credito' },
    { name: 'suspicious_weighing_logs', description: 'Logs pesajes sospechosos' },
    { name: 'scale_disconnection_logs', description: 'Logs desconexion bascula' },
    { name: 'preparation_mode_logs', description: 'Logs modo preparacion' },
    { name: 'employee_debts', description: 'Deudas de empleados' },
    { name: 'cash_cuts', description: 'Cortes de caja' },
    { name: 'deposits', description: 'Depositos' },
    { name: 'withdrawals', description: 'Retiros' },
    { name: 'expenses', description: 'Gastos' },
    { name: 'purchase_details', description: 'Detalles de compras' },
    { name: 'purchases', description: 'Compras' },
    { name: 'shifts', description: 'Turnos' },
    { name: 'telemetry_events', description: 'Telemetria' },
    { name: 'backup_metadata', description: 'Metadata respaldos' }
];

// TABLAS PARA LIMPIEZA COMPLETA (TODO incluido)
// Orden critico: de mayor a menor dependencia
const FULL_CLEANUP_TABLES = [
    // Nivel 1: Tablas mas dependientes
    { name: 'notas_credito_detalle', description: 'Detalles de notas de credito', fkColumn: 'tenant_id' },
    { name: 'notas_credito', description: 'Notas de credito', fkColumn: 'tenant_id' },
    { name: 'repartidor_returns', description: 'Devoluciones de repartidor', fkColumn: 'tenant_id' },
    { name: 'repartidor_assignments', description: 'Asignaciones de repartidor', fkColumn: 'tenant_id' },
    { name: 'ventas_detalle', description: 'Detalles de ventas', fkColumn: 'tenant_id' },
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
    { name: 'purchase_details', description: 'Detalles de compras', fkColumn: 'tenant_id' },
    { name: 'purchases', description: 'Compras', fkColumn: 'tenant_id' },
    { name: 'shifts', description: 'Turnos', fkColumn: 'tenant_id' },
    { name: 'sessions', description: 'Sesiones', fkColumn: 'tenant_id' },
    { name: 'device_tokens', description: 'Tokens FCM', fkColumn: null, customQuery: 'employee_id' },
    { name: 'employee_branches', description: 'Empleados-Sucursales', fkColumn: 'tenant_id' },
    { name: 'productos_branch_precios', description: 'Precios por sucursal', fkColumn: 'tenant_id' },
    { name: 'backup_metadata', description: 'Metadata respaldos', fkColumn: 'tenant_id' },
    { name: 'telemetry_events', description: 'Telemetria', fkColumn: 'tenant_id' },
    { name: 'notifications', description: 'Notificaciones', fkColumn: 'tenant_id' },
    // ENTIDADES PRINCIPALES
    { name: 'employees', description: 'EMPLEADOS', fkColumn: 'tenant_id', critical: true },
    { name: 'productos', description: 'PRODUCTOS', fkColumn: 'tenant_id', critical: true },
    { name: 'customers', description: 'CLIENTES', fkColumn: 'tenant_id', critical: true },
    { name: 'branches', description: 'SUCURSALES', fkColumn: 'tenant_id', critical: true },
    // TENANT
    { name: 'tenants', description: 'TENANT', fkColumn: 'id', critical: true, isTenantTable: true }
];

// ═══════════════════════════════════════════════════════════════
// UTILIDADES DE CONSOLA
// ═══════════════════════════════════════════════════════════════

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m'
};

function log(message, color = 'white') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(title) {
    const line = '═'.repeat(60);
    console.log(`\n${colors.cyan}${line}${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}  ${title}${colors.reset}`);
    console.log(`${colors.cyan}${line}${colors.reset}\n`);
}

function dangerHeader(title) {
    const line = '═'.repeat(60);
    console.log(`\n${colors.bgRed}${colors.bright}${line}${colors.reset}`);
    console.log(`${colors.bgRed}${colors.bright}  ${title}${colors.reset}`);
    console.log(`${colors.bgRed}${colors.bright}${line}${colors.reset}\n`);
}

function warning(message) {
    console.log(`${colors.bgYellow}${colors.bright} ADVERTENCIA ${colors.reset} ${colors.yellow}${message}${colors.reset}`);
}

function danger(message) {
    console.log(`${colors.bgRed}${colors.bright} PELIGRO ${colors.reset} ${colors.red}${message}${colors.reset}`);
}

function error(message) {
    console.log(`${colors.bgRed}${colors.bright} ERROR ${colors.reset} ${colors.red}${message}${colors.reset}`);
}

function success(message) {
    console.log(`${colors.bgGreen}${colors.bright} OK ${colors.reset} ${colors.green}${message}${colors.reset}`);
}

function info(message) {
    console.log(`${colors.bgBlue}${colors.bright} INFO ${colors.reset} ${colors.blue}${message}${colors.reset}`);
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => {
        rl.question(`${colors.cyan}${question}${colors.reset} `, answer => {
            resolve(answer.trim());
        });
    });
}

// ═══════════════════════════════════════════════════════════════
// FUNCIONES DE BASE DE DATOS
// ═══════════════════════════════════════════════════════════════

async function getTenants() {
    const result = await pool.query(`
        SELECT
            t.id,
            t.tenant_code,
            t.business_name,
            t.is_active,
            (SELECT COUNT(*) FROM branches WHERE tenant_id = t.id) as branch_count,
            (SELECT COUNT(*) FROM employees WHERE tenant_id = t.id) as employee_count,
            (SELECT COUNT(*) FROM customers WHERE tenant_id = t.id) as customer_count,
            (SELECT COUNT(*) FROM productos WHERE tenant_id = t.id) as product_count,
            (SELECT COUNT(*) FROM ventas WHERE tenant_id = t.id) as venta_count
        FROM tenants t
        ORDER BY t.id
    `);
    return result.rows;
}

async function getBranches(tenantId) {
    const result = await pool.query(`
        SELECT
            b.id,
            b.name,
            b.branch_code,
            b.is_active,
            (SELECT COUNT(*) FROM ventas WHERE branch_id = b.id) as ventas_count,
            (SELECT COUNT(*) FROM shifts WHERE branch_id = b.id) as shifts_count
        FROM branches b
        WHERE b.tenant_id = $1
        ORDER BY b.id
    `, [tenantId]);
    return result.rows;
}

async function tableExists(tableName) {
    const result = await pool.query(`
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_name = $1
        )
    `, [tableName]);
    return result.rows[0].exists;
}

async function columnExists(tableName, columnName) {
    const result = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2
    `, [tableName, columnName]);
    return result.rows.length > 0;
}

async function getTableCount(tableName, tenantId, branchId = null, tableConfig = null) {
    try {
        const exists = await tableExists(tableName);
        if (!exists) return { count: 0, exists: false };

        // Para limpieza completa con configuracion especial
        if (tableConfig) {
            if (tableConfig.isTenantTable) {
                const result = await pool.query(`SELECT COUNT(*) FROM ${tableName} WHERE id = $1`, [tenantId]);
                return { count: parseInt(result.rows[0].count), exists: true };
            }

            if (tableConfig.customQuery === 'employee_id') {
                const hasColumn = await columnExists(tableName, 'employee_id');
                if (!hasColumn) return { count: 0, exists: true };

                const result = await pool.query(`
                    SELECT COUNT(*) FROM ${tableName} dt
                    WHERE EXISTS (
                        SELECT 1 FROM employees e
                        WHERE e.id = dt.employee_id AND e.tenant_id = $1
                    )
                `, [tenantId]);
                return { count: parseInt(result.rows[0].count), exists: true };
            }
        }

        // Verificar columnas
        const hasTenantId = await columnExists(tableName, 'tenant_id');
        if (!hasTenantId) return { count: 0, exists: true };

        const hasBranchId = await columnExists(tableName, 'branch_id');

        let query, params;
        if (branchId && hasBranchId) {
            query = `SELECT COUNT(*) FROM ${tableName} WHERE tenant_id = $1 AND branch_id = $2`;
            params = [tenantId, branchId];
        } else {
            query = `SELECT COUNT(*) FROM ${tableName} WHERE tenant_id = $1`;
            params = [tenantId];
        }

        const result = await pool.query(query, params);
        return { count: parseInt(result.rows[0].count), exists: true };
    } catch (err) {
        return { count: 0, exists: false, error: err.message };
    }
}

async function removeGenericCustomerProtection(tenantId) {
    // El trigger verifica is_system_generic = true
    // Cambiamos a false para permitir la eliminacion
    try {
        const result = await pool.query(`
            UPDATE customers
            SET is_system_generic = false
            WHERE tenant_id = $1 AND is_system_generic = true
        `, [tenantId]);
        return result.rowCount;
    } catch (err) {
        return 0;
    }
}

async function deleteFromTable(tableName, tenantId, branchId = null, dryRun = false, tableConfig = null) {
    try {
        const exists = await tableExists(tableName);
        if (!exists) {
            return { table: tableName, deleted: 0, skipped: true, reason: 'tabla no existe' };
        }

        let query, params;

        // Para limpieza completa con configuracion especial
        if (tableConfig) {
            if (tableConfig.isTenantTable) {
                query = `DELETE FROM ${tableName} WHERE id = $1`;
                params = [tenantId];
            } else if (tableConfig.customQuery === 'employee_id') {
                const hasColumn = await columnExists(tableName, 'employee_id');
                if (!hasColumn) {
                    return { table: tableName, deleted: 0, skipped: true, reason: 'sin employee_id' };
                }

                query = `
                    DELETE FROM ${tableName} dt
                    WHERE EXISTS (
                        SELECT 1 FROM employees e
                        WHERE e.id = dt.employee_id AND e.tenant_id = $1
                    )
                `;
                params = [tenantId];
            } else {
                const hasColumn = await columnExists(tableName, tableConfig.fkColumn || 'tenant_id');
                if (!hasColumn) {
                    return { table: tableName, deleted: 0, skipped: true, reason: `sin ${tableConfig.fkColumn}` };
                }

                query = `DELETE FROM ${tableName} WHERE ${tableConfig.fkColumn || 'tenant_id'} = $1`;
                params = [tenantId];
            }
        } else {
            // Limpieza parcial estandar
            const hasTenantId = await columnExists(tableName, 'tenant_id');
            if (!hasTenantId) {
                return { table: tableName, deleted: 0, skipped: true, reason: 'sin tenant_id' };
            }

            const hasBranchId = await columnExists(tableName, 'branch_id');

            if (branchId && hasBranchId) {
                query = `DELETE FROM ${tableName} WHERE tenant_id = $1 AND branch_id = $2`;
                params = [tenantId, branchId];
            } else {
                query = `DELETE FROM ${tableName} WHERE tenant_id = $1`;
                params = [tenantId];
            }
        }

        if (dryRun) {
            const countQuery = query
                .replace(/^DELETE FROM (\w+) dt/, 'SELECT COUNT(*) FROM $1 dt')
                .replace(/^DELETE FROM (\w+)/, 'SELECT COUNT(*) FROM $1');

            const countResult = await pool.query(countQuery, params);
            return { table: tableName, deleted: parseInt(countResult.rows[0].count), dryRun: true };
        }

        const result = await pool.query(query, params);
        return { table: tableName, deleted: result.rowCount };
    } catch (err) {
        return { table: tableName, deleted: 0, error: err.message };
    }
}

// ═══════════════════════════════════════════════════════════════
// MODO 1: LIMPIEZA PARCIAL
// ═══════════════════════════════════════════════════════════════

async function runPartialCleanup(tenantId, selectedTenant, branchId = null) {
    header('Modo: Limpieza Parcial');

    info('Se eliminaran SOLO datos transaccionales');
    log('Protegidos: empleados, clientes, productos, sucursales, tenant', 'green');
    console.log('');

    // Mostrar resumen
    const scopeText = branchId ? `Sucursal ID: ${branchId}` : 'TODAS las sucursales';
    console.log(`  ${colors.bright}Tenant:${colors.reset}  ${selectedTenant.business_name} (ID: ${tenantId})`);
    console.log(`  ${colors.bright}Alcance:${colors.reset} ${scopeText}`);
    console.log('');

    // Contar registros
    log('Analizando datos a eliminar...', 'cyan');
    console.log('');

    let totalRecords = 0;
    const tableCounts = [];

    for (const table of PARTIAL_CLEANUP_TABLES) {
        const result = await getTableCount(table.name, tenantId, branchId);
        tableCounts.push({ ...table, ...result });
        if (result.count > 0) totalRecords += result.count;
    }

    console.log(`  ${'Tabla'.padEnd(32)} Registros`);
    console.log(`  ${'-'.repeat(32)} ---------`);

    for (const tc of tableCounts) {
        if (!tc.exists) {
            console.log(`  ${colors.dim}${tc.name.padEnd(32)} No existe${colors.reset}`);
        } else if (tc.count === 0) {
            console.log(`  ${colors.dim}${tc.name.padEnd(32)} 0${colors.reset}`);
        } else {
            console.log(`  ${colors.yellow}${tc.name.padEnd(32)} ${tc.count}${colors.reset}`);
        }
    }

    console.log('');
    warning(`Se eliminaran ${totalRecords} registros`);
    console.log('');

    // Confirmacion
    const confirm = await ask('Continuar? (s/n):');
    if (confirm.toLowerCase() !== 's' && confirm.toLowerCase() !== 'si') {
        log('\nOperacion cancelada', 'yellow');
        return;
    }

    // Ejecutar
    header('Ejecutando Limpieza Parcial');

    const results = [];
    for (const table of PARTIAL_CLEANUP_TABLES) {
        process.stdout.write(`  Eliminando ${table.name}... `);
        const result = await deleteFromTable(table.name, tenantId, branchId, false);
        results.push(result);

        if (result.error) {
            console.log(`${colors.red}ERROR: ${result.error}${colors.reset}`);
        } else if (result.skipped) {
            console.log(`${colors.dim}SKIP${colors.reset}`);
        } else {
            console.log(`${colors.green}OK (${result.deleted})${colors.reset}`);
        }
    }

    // Resumen
    const totalDeleted = results.reduce((sum, r) => sum + (r.deleted || 0), 0);
    const errors = results.filter(r => r.error);

    console.log('');
    success(`Limpieza parcial completada. ${totalDeleted} registros eliminados.`);
    if (errors.length > 0) {
        warning(`${errors.length} errores encontrados`);
    }
}

// ═══════════════════════════════════════════════════════════════
// MODO 2: LIMPIEZA COMPLETA
// ═══════════════════════════════════════════════════════════════

async function runFullCleanup(tenantId, selectedTenant) {
    dangerHeader('Modo: LIMPIEZA COMPLETA');

    danger('SE ELIMINARA TODO EL TENANT Y TODOS SUS DATOS');
    console.log('');
    log('Esto incluye:', 'red');
    log('  - Todas las ventas y transacciones', 'red');
    log('  - Todos los empleados', 'red');
    log('  - Todos los clientes', 'red');
    log('  - Todos los productos', 'red');
    log('  - Todas las sucursales', 'red');
    log('  - El tenant mismo', 'red');
    console.log('');

    let tablesToDelete = [...FULL_CLEANUP_TABLES];

    console.log('');
    console.log(`  ${colors.bright}Tenant:${colors.reset} ${selectedTenant.business_name} (ID: ${tenantId})`);
    console.log(`  ${colors.bright}Codigo:${colors.reset} ${selectedTenant.tenant_code || 'N/A'}`);
    console.log('');

    // Contar registros
    log('Analizando datos a eliminar...', 'cyan');

    let totalRecords = 0;
    const tableCounts = [];

    for (const tableConfig of tablesToDelete) {
        const result = await getTableCount(tableConfig.name, tenantId, null, tableConfig);
        tableCounts.push({ ...tableConfig, ...result });
        if (result.count > 0) totalRecords += result.count;
    }

    console.log('');
    console.log(`  ${'Tabla'.padEnd(32)} ${'Registros'.padEnd(12)} Tipo`);
    console.log(`  ${'-'.repeat(32)} ${'-'.repeat(12)} ----`);

    for (const tc of tableCounts) {
        let typeText = '';
        if (!tc.exists) {
            typeText = `${colors.dim}No existe${colors.reset}`;
        } else if (tc.critical) {
            typeText = `${colors.red}CRITICO${colors.reset}`;
        } else if (tc.count > 0) {
            typeText = `${colors.yellow}Datos${colors.reset}`;
        }

        const countStr = tc.count > 0 ? String(tc.count) : '-';
        const nameColor = tc.critical ? 'red' : (tc.count > 0 ? 'yellow' : 'dim');
        console.log(`  ${colors[nameColor]}${tc.name.padEnd(32)}${colors.reset} ${countStr.padEnd(12)} ${typeText}`);
    }

    console.log('');
    danger(`TOTAL: ${totalRecords} registros seran ELIMINADOS PERMANENTEMENTE`);
    console.log('');

    // Confirmacion
    const confirmWord = await ask('Escribe "ELIMINAR" para proceder:');
    if (confirmWord !== 'ELIMINAR') {
        error('Confirmacion incorrecta. Operacion cancelada.');
        return;
    }

    // Ejecutar
    dangerHeader('EJECUTANDO ELIMINACION COMPLETA');

    // Quitar proteccion del cliente generico (cambia is_system_generic a false)
    log('Removiendo proteccion de cliente generico...', 'yellow');
    const genericRemoved = await removeGenericCustomerProtection(tenantId);
    if (genericRemoved > 0) {
        log(`  ${genericRemoved} cliente(s) generico(s) desprotegido(s)`, 'dim');
    }

    const results = [];
    for (const tableConfig of tablesToDelete) {
        process.stdout.write(`  Eliminando ${tableConfig.name}... `);
        const result = await deleteFromTable(tableConfig.name, tenantId, null, false, tableConfig);
        results.push(result);

        if (result.error) {
            console.log(`${colors.red}ERROR: ${result.error}${colors.reset}`);
        } else if (result.skipped) {
            console.log(`${colors.dim}SKIP${colors.reset}`);
        } else {
            console.log(`${colors.green}OK (${result.deleted})${colors.reset}`);
        }
    }

    // Resumen
    const totalDeleted = results.reduce((sum, r) => sum + (r.deleted || 0), 0);
    const errors = results.filter(r => r.error);

    console.log('');
    success(`TENANT ELIMINADO COMPLETAMENTE. ${totalDeleted} registros eliminados.`);

    if (errors.length > 0) {
        warning(`${errors.length} errores encontrados`);
        for (const err of errors) {
            console.log(`  ${colors.red}- ${err.table}: ${err.error}${colors.reset}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// FLUJO PRINCIPAL
// ═══════════════════════════════════════════════════════════════

async function main() {
    header('SYA Database Cleanup Tool');

    try {
        // Verificar conexion
        log('Conectando a la base de datos...', 'cyan');
        await pool.query('SELECT 1');
        success('Conexion establecida');
        console.log('');

        // Menu principal
        header('Selecciona el Tipo de Limpieza');

        console.log(`  ${colors.bright}1.${colors.reset} ${colors.green}Limpieza Parcial${colors.reset}`);
        console.log(`     Solo datos transaccionales (ventas, turnos, gastos, etc.)`);
        console.log(`     ${colors.green}Mantiene: empleados, clientes, productos, sucursales${colors.reset}`);
        console.log('');
        console.log(`  ${colors.bright}2.${colors.reset} ${colors.red}Limpieza Completa${colors.reset}`);
        console.log(`     ${colors.red}ELIMINA TODO: empleados, clientes, productos, sucursales, tenant${colors.reset}`);
        console.log('');

        const modeChoice = await ask('Selecciona una opcion (1 o 2):');

        if (modeChoice !== '1' && modeChoice !== '2') {
            error('Opcion invalida');
            process.exit(1);
        }

        const isFullCleanup = modeChoice === '2';

        // Mostrar tenants
        header('Tenants Disponibles');
        const tenants = await getTenants();

        if (tenants.length === 0) {
            error('No hay tenants en la base de datos');
            process.exit(1);
        }

        console.log(`  ${'ID'.padEnd(5)} ${'Codigo'.padEnd(12)} ${'Negocio'.padEnd(22)} ${'Suc'.padEnd(4)} ${'Emp'.padEnd(4)} ${'Cli'.padEnd(5)} ${'Prod'.padEnd(5)} Ventas`);
        console.log(`  ${'-'.repeat(5)} ${'-'.repeat(12)} ${'-'.repeat(22)} ${'-'.repeat(4)} ${'-'.repeat(4)} ${'-'.repeat(5)} ${'-'.repeat(5)} ------`);

        for (const t of tenants) {
            console.log(`  ${String(t.id).padEnd(5)} ${(t.tenant_code || '-').padEnd(12)} ${(t.business_name || '-').substring(0, 20).padEnd(22)} ${String(t.branch_count).padEnd(4)} ${String(t.employee_count).padEnd(4)} ${String(t.customer_count).padEnd(5)} ${String(t.product_count).padEnd(5)} ${t.venta_count}`);
        }

        console.log('');
        const tenantIdStr = await ask('Ingresa el ID del tenant:');
        const tenantId = parseInt(tenantIdStr);

        if (isNaN(tenantId) || !tenants.find(t => t.id === tenantId)) {
            error('Tenant ID invalido');
            process.exit(1);
        }

        const selectedTenant = tenants.find(t => t.id === tenantId);
        success(`Tenant seleccionado: ${selectedTenant.business_name}`);

        if (isFullCleanup) {
            // Limpieza completa
            await runFullCleanup(tenantId, selectedTenant);
        } else {
            // Limpieza parcial - preguntar por sucursal
            const branches = await getBranches(tenantId);
            let branchId = null;

            if (branches.length > 0) {
                console.log('');
                console.log('Sucursales disponibles:');
                console.log(`  ${'ID'.padEnd(5)} ${'Nombre'.padEnd(20)} Ventas`);
                console.log(`  ${'-'.repeat(5)} ${'-'.repeat(20)} ------`);

                for (const b of branches) {
                    console.log(`  ${String(b.id).padEnd(5)} ${(b.name || '-').substring(0, 18).padEnd(20)} ${b.ventas_count}`);
                }

                console.log('');
                log('Deja en blanco para limpiar TODAS las sucursales', 'yellow');
                const branchIdStr = await ask('ID de sucursal (o Enter para todas):');

                if (branchIdStr) {
                    branchId = parseInt(branchIdStr);
                    if (isNaN(branchId) || !branches.find(b => b.id === branchId)) {
                        error('Branch ID invalido');
                        process.exit(1);
                    }
                }
            }

            await runPartialCleanup(tenantId, selectedTenant, branchId);
        }

    } catch (err) {
        error(`Error: ${err.message}`);
        console.error(err.stack);
        process.exit(1);
    } finally {
        rl.close();
        await pool.end();
    }
}

// ═══════════════════════════════════════════════════════════════
// MODO LINEA DE COMANDOS
// ═══════════════════════════════════════════════════════════════

async function runWithArgs() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
${colors.bright}SYA Database Cleanup Tool${colors.reset}

Uso interactivo:
  node scripts/db-cleanup.js

Uso con argumentos:
  node scripts/db-cleanup.js --tenant=ID --mode=MODE [opciones]

Modos:
  --mode=partial   Limpieza parcial (solo datos transaccionales)
  --mode=full      Limpieza completa (TODO incluido)

Opciones:
  --tenant=ID      ID del tenant (requerido en modo CLI)
  --branch=ID      ID de sucursal (solo para mode=partial)
  --keep-tenant    En mode=full, mantener tenant y sucursales
  --dry-run        Solo mostrar que se eliminaria
  --force          No pedir confirmacion
  --help           Mostrar esta ayuda

Ejemplos:
  node scripts/db-cleanup.js --tenant=16 --mode=partial --dry-run
  node scripts/db-cleanup.js --tenant=16 --mode=partial --branch=5
  node scripts/db-cleanup.js --tenant=16 --mode=full --dry-run
  node scripts/db-cleanup.js --tenant=16 --mode=full --keep-tenant --force
        `);
        process.exit(0);
    }

    if (!args.some(a => a.startsWith('--tenant='))) {
        await main();
        return;
    }

    // Modo CLI
    const tenantArg = args.find(a => a.startsWith('--tenant='));
    const modeArg = args.find(a => a.startsWith('--mode='));
    const branchArg = args.find(a => a.startsWith('--branch='));
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const keepTenant = args.includes('--keep-tenant');

    const tenantId = parseInt(tenantArg.split('=')[1]);
    const mode = modeArg ? modeArg.split('=')[1] : 'partial';
    const branchId = branchArg ? parseInt(branchArg.split('=')[1]) : null;

    const isFullCleanup = mode === 'full';

    header(`SYA Database Cleanup (CLI - ${isFullCleanup ? 'FULL' : 'Partial'})`);

    if (dryRun) {
        log('MODO DRY-RUN: No se realizaran cambios', 'yellow');
    }

    console.log(`  Tenant ID: ${tenantId}`);
    console.log(`  Modo: ${isFullCleanup ? 'COMPLETO' : 'Parcial'}`);
    if (!isFullCleanup && branchId) console.log(`  Branch ID: ${branchId}`);
    if (isFullCleanup && keepTenant) console.log(`  Mantener tenant: Si`);
    console.log('');

    if (!force && !dryRun) {
        error('Usa --force para ejecutar o --dry-run para simular');
        process.exit(1);
    }

    try {
        await pool.query('SELECT 1');

        const tenantCheck = await pool.query('SELECT business_name, tenant_code FROM tenants WHERE id = $1', [tenantId]);
        if (tenantCheck.rows.length === 0) {
            error(`Tenant con ID ${tenantId} no encontrado`);
            process.exit(1);
        }

        log(`Tenant: ${tenantCheck.rows[0].business_name}`, 'cyan');
        console.log('');

        let tablesToProcess;
        if (isFullCleanup) {
            tablesToProcess = keepTenant
                ? FULL_CLEANUP_TABLES.filter(t => t.name !== 'tenants' && t.name !== 'branches')
                : [...FULL_CLEANUP_TABLES];
        } else {
            tablesToProcess = PARTIAL_CLEANUP_TABLES.map(t => ({ ...t, fkColumn: 'tenant_id' }));
        }

        // Quitar proteccion del cliente generico para limpieza completa
        if (isFullCleanup && !dryRun) {
            log('Removiendo proteccion de cliente generico...', 'yellow');
            await removeGenericCustomerProtection(tenantId);
        }

        let totalDeleted = 0;
        for (const tableConfig of tablesToProcess) {
            const result = await deleteFromTable(
                tableConfig.name,
                tenantId,
                isFullCleanup ? null : branchId,
                dryRun,
                isFullCleanup ? tableConfig : null
            );

            if (result.error) {
                error(`${tableConfig.name}: ${result.error}`);
            } else if (result.skipped) {
                // Skip silently in CLI mode
            } else if (result.deleted > 0) {
                totalDeleted += result.deleted;
                if (dryRun) {
                    log(`[DRY] ${tableConfig.name}: ${result.deleted} registros`, 'yellow');
                } else {
                    success(`${tableConfig.name}: ${result.deleted} registros`);
                }
            }
        }

        console.log('');
        if (dryRun) {
            success(`DRY-RUN completado. Se eliminarian ${totalDeleted} registros.`);
        } else {
            success(`Eliminacion completada. ${totalDeleted} registros eliminados.`);
        }
    } catch (err) {
        error(err.message);
        process.exit(1);
    } finally {
        rl.close();
        await pool.end();
    }
}

// Ejecutar
runWithArgs().catch(err => {
    error(err.message);
    process.exit(1);
});
