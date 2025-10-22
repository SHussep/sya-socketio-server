#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const serverFile = path.join(__dirname, 'server.js');
let content = fs.readFileSync(serverFile, 'utf8');

// Update 1: GET /api/sales endpoint
const salesOldPattern = `// GET /api/sales - Lista de ventas
app.get('/api/sales', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', branch_id } = req.query;

        // Prioridad: 1. branch_id del query, 2. branchId del JWT
        const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

        let query = \`
            SELECT s.id, s.ticket_number, s.total_amount, s.payment_method, s.sale_date,
                   s.sale_type,
                   e.full_name as employee_name, e.role as employee_role,
                   b.name as branch_name, b.id as branch_id
            FROM sales s
            LEFT JOIN employees e ON s.employee_id = e.id
            LEFT JOIN branches b ON s.branch_id = b.id
            WHERE s.tenant_id = $1
        \`;

        const params = [tenantId];

        // Filtrar por branch_id solo si no se solicita ver todas las sucursales
        if (all_branches !== 'true' && targetBranchId) {
            query += ' AND s.branch_id = $2';
            params.push(targetBranchId);
            query += ' ORDER BY s.sale_date DESC LIMIT $3 OFFSET $4';
            params.push(limit, offset);
        } else {
            query += ' ORDER BY s.sale_date DESC LIMIT $2 OFFSET $3';
            params.push(limit, offset);
        }

        console.log(\`[Sales] Fetching sales - Tenant: \${tenantId}, Branch: \${targetBranchId}, all_branches: \${all_branches}\`);

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('[Sales] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener ventas' });
    }
});`;

const salesNewPattern = `// GET /api/sales - Lista de ventas (con soporte de timezone)
app.get('/api/sales', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', branch_id, timezone, startDate, endDate } = req.query;

        // Prioridad: 1. branch_id del query, 2. branchId del JWT
        const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

        // Usar timezone si viene en query, sino usar UTC por defecto
        const userTimezone = timezone || 'UTC';

        let query = \`
            SELECT s.id, s.ticket_number, s.total_amount, s.payment_method, s.sale_date,
                   s.sale_type,
                   e.full_name as employee_name, e.role as employee_role,
                   b.name as branch_name, b.id as branch_id,
                   (s.sale_date AT TIME ZONE '\${userTimezone}') as sale_date_display
            FROM sales s
            LEFT JOIN employees e ON s.employee_id = e.id
            LEFT JOIN branches b ON s.branch_id = b.id
            WHERE s.tenant_id = $1
        \`;

        const params = [tenantId];
        let paramIndex = 2;

        // Filtrar por branch_id solo si no se solicita ver todas las sucursales
        if (all_branches !== 'true' && targetBranchId) {
            query += \` AND s.branch_id = \$\${paramIndex}\`;
            params.push(targetBranchId);
            paramIndex++;
        }

        // Filtrar por rango de fechas si se proporciona (en timezone del usuario)
        if (startDate || endDate) {
            if (startDate) {
                query += \` AND (s.sale_date AT TIME ZONE '\${userTimezone}')::date >= \$\${paramIndex}::date\`;
                params.push(startDate);
                paramIndex++;
            }
            if (endDate) {
                query += \` AND (s.sale_date AT TIME ZONE '\${userTimezone}')::date <= \$\${paramIndex}::date\`;
                params.push(endDate);
                paramIndex++;
            }
        }

        query += \` ORDER BY s.sale_date DESC LIMIT \$\${paramIndex} OFFSET \$\${paramIndex + 1}\`;
        params.push(limit, offset);

        console.log(\`[Sales] Fetching sales - Tenant: \${tenantId}, Branch: \${targetBranchId}, Timezone: \${userTimezone}, all_branches: \${all_branches}\`);

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('[Sales] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener ventas' });
    }
});`;

// Update 2: GET /api/expenses endpoint
const expensesOldPattern = `// GET /api/expenses - Lista de gastos
app.get('/api/expenses', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', branch_id } = req.query;

        // Prioridad: 1. branch_id del query, 2. branchId del JWT
        const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

        let query = \`
            SELECT e.id, e.description as concept, e.description, e.amount, e.expense_date,
                   emp.full_name as employee_name, b.name as branch_name, b.id as branch_id,
                   cat.name as category
            FROM expenses e
            LEFT JOIN employees emp ON e.employee_id = emp.id
            LEFT JOIN branches b ON e.branch_id = b.id
            LEFT JOIN expense_categories cat ON e.category_id = cat.id
            WHERE e.tenant_id = $1
        \`;

        const params = [tenantId];

        // Filtrar por branch_id solo si no se solicita ver todas las sucursales
        if (all_branches !== 'true' && targetBranchId) {
            query += ' AND e.branch_id = $2';
            params.push(targetBranchId);
            query += ' ORDER BY e.expense_date DESC LIMIT $3 OFFSET $4';
            params.push(limit, offset);
        } else {
            query += ' ORDER BY e.expense_date DESC LIMIT $2 OFFSET $3';
            params.push(limit, offset);
        }

        console.log(\`[Expenses] Fetching expenses - Tenant: \${tenantId}, Branch: \${targetBranchId}, all_branches: \${all_branches}\`);

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('[Expenses] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener gastos' });
    }
});`;

const expensesNewPattern = `// GET /api/expenses - Lista de gastos (con soporte de timezone)
app.get('/api/expenses', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId: userBranchId } = req.user;
        const { limit = 50, offset = 0, all_branches = 'false', branch_id, timezone, startDate, endDate } = req.query;

        // Prioridad: 1. branch_id del query, 2. branchId del JWT
        const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

        // Usar timezone si viene en query, sino usar UTC por defecto
        const userTimezone = timezone || 'UTC';

        let query = \`
            SELECT e.id, e.description as concept, e.description, e.amount, e.expense_date,
                   emp.full_name as employee_name, b.name as branch_name, b.id as branch_id,
                   cat.name as category,
                   (e.expense_date AT TIME ZONE '\${userTimezone}') as expense_date_display
            FROM expenses e
            LEFT JOIN employees emp ON e.employee_id = emp.id
            LEFT JOIN branches b ON e.branch_id = b.id
            LEFT JOIN expense_categories cat ON e.category_id = cat.id
            WHERE e.tenant_id = $1
        \`;

        const params = [tenantId];
        let paramIndex = 2;

        // Filtrar por branch_id solo si no se solicita ver todas las sucursales
        if (all_branches !== 'true' && targetBranchId) {
            query += \` AND e.branch_id = \$\${paramIndex}\`;
            params.push(targetBranchId);
            paramIndex++;
        }

        // Filtrar por rango de fechas si se proporciona (en timezone del usuario)
        if (startDate || endDate) {
            if (startDate) {
                query += \` AND (e.expense_date AT TIME ZONE '\${userTimezone}')::date >= \$\${paramIndex}::date\`;
                params.push(startDate);
                paramIndex++;
            }
            if (endDate) {
                query += \` AND (e.expense_date AT TIME ZONE '\${userTimezone}')::date <= \$\${paramIndex}::date\`;
                params.push(endDate);
                paramIndex++;
            }
        }

        query += \` ORDER BY e.expense_date DESC LIMIT \$\${paramIndex} OFFSET \$\${paramIndex + 1}\`;
        params.push(limit, offset);

        console.log(\`[Expenses] Fetching expenses - Tenant: \${tenantId}, Branch: \${targetBranchId}, Timezone: \${userTimezone}, all_branches: \${all_branches}\`);

        const result = await pool.query(query, params);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('[Expenses] Error:', error);
        res.status(500).json({ success: false, message: 'Error al obtener gastos' });
    }
});`;

// Apply updates
console.log('Aplicando actualizaciones de FASE 1: Timezone Support en Backend...\n');

if (content.includes(salesOldPattern)) {
    console.log('✓ Encontrado: GET /api/sales endpoint');
    content = content.replace(salesOldPattern, salesNewPattern);
    console.log('✅ Actualizado: GET /api/sales con soporte de timezone\n');
} else {
    console.log('⚠️  GET /api/sales endpoint no encontrado (posiblemente ya actualizado)\n');
}

if (content.includes(expensesOldPattern)) {
    console.log('✓ Encontrado: GET /api/expenses endpoint');
    content = content.replace(expensesOldPattern, expensesNewPattern);
    console.log('✅ Actualizado: GET /api/expenses con soporte de timezone\n');
} else {
    console.log('⚠️  GET /api/expenses endpoint no encontrado (posiblemente ya actualizado)\n');
}

// Write updated file
fs.writeFileSync(serverFile, content, 'utf8');

console.log('═══════════════════════════════════════════════════════════');
console.log('✨ FASE 1 Completada: Backend Timezone Updates');
console.log('═══════════════════════════════════════════════════════════');
console.log('\nCambios realizados:');
console.log('1. GET /api/sales ahora acepta parámetro ?timezone=');
console.log('2. GET /api/expenses ahora acepta parámetro ?timezone=');
console.log('3. Ambos endpoints usan AT TIME ZONE para filtrado y conversión');
console.log('4. Se agregó soporte para filtrado por rango de fechas con timezone awareness');
console.log('\nPróximos pasos:');
console.log('1. Restart Node.js server');
console.log('2. Probar endpoints con timezone:');
console.log('   GET /api/sales?timezone=America/Mexico_City&startDate=2025-10-21');
console.log('3. Proceder a FASE 2: Flutter App Updates');
console.log('═══════════════════════════════════════════════════════════\n');

