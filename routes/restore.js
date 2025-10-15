// ═══════════════════════════════════════════════════════════════
// ROUTES: Restauración de Base de Datos (Recuperación de Cuenta)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../database');

// ============================================================================
// MIDDLEWARE: Autenticación JWT
// ============================================================================

const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Token no proporcionado' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Token inválido o expirado' });
    }
};

// ============================================================================
// POST /api/restore/login
// Autentica usuario y retorna sus datos de configuración
// ============================================================================

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email y contraseña son requeridos'
            });
        }

        console.log(`[Restore] Intento de login: ${email}`);

        // Buscar empleado por email
        const employeeResult = await pool.query(
            `SELECT
                e.id,
                e.tenant_id,
                e.email,
                e.username,
                e.full_name,
                e.password,
                e.role,
                e.is_active,
                e.main_branch_id,
                t.business_name
            FROM employees e
            INNER JOIN tenants t ON e.tenant_id = t.id
            WHERE e.email = $1`,
            [email.toLowerCase()]
        );

        if (employeeResult.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Credenciales incorrectas'
            });
        }

        const employee = employeeResult.rows[0];

        // Verificar si está activo
        if (!employee.is_active) {
            return res.status(403).json({
                success: false,
                message: 'Cuenta desactivada. Contacta al administrador'
            });
        }

        // Verificar contraseña
        const passwordMatch = await bcrypt.compare(password, employee.password);

        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: 'Credenciales incorrectas'
            });
        }

        // Generar tokens (usar "employeeId" para consistencia con otros endpoints)
        const accessToken = jwt.sign(
            {
                employeeId: employee.id,
                tenantId: employee.tenant_id,
                branchId: employee.main_branch_id,
                email: employee.email,
                role: employee.role
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        const refreshToken = jwt.sign(
            { employeeId: employee.id },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        console.log(`[Restore] ✅ Login exitoso: ${employee.full_name} (${employee.email})`);

        res.json({
            success: true,
            message: 'Autenticación exitosa',
            data: {
                employee: {
                    id: employee.id,
                    tenant_id: employee.tenant_id,
                    branch_id: employee.main_branch_id,
                    email: employee.email,
                    username: employee.username,
                    full_name: employee.full_name,
                    role: employee.role,
                    business_name: employee.business_name
                },
                tokens: {
                    access_token: accessToken,
                    refresh_token: refreshToken,
                    expires_in: 86400 // 24 horas en segundos
                }
            }
        });

    } catch (error) {
        console.error('[Restore] ❌ Error en login:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            error: error.message
        });
    }
});

// ============================================================================
// GET /api/restore/database-snapshot
// Descarga snapshot completo de la base de datos del usuario
// ============================================================================

router.get('/database-snapshot', authenticate, async (req, res) => {
    try {
        const { tenantId, branchId } = req.user;

        console.log(`[Restore] Generando snapshot para tenant ${tenantId}, branch ${branchId}`);

        // VENTAS (últimas 1000)
        const salesResult = await pool.query(
            `SELECT * FROM sales
             WHERE tenant_id = $1 AND branch_id = $2
             ORDER BY sale_date DESC
             LIMIT 1000`,
            [tenantId, branchId]
        );

        // GASTOS (últimos 500)
        const expensesResult = await pool.query(
            `SELECT * FROM expenses
             WHERE tenant_id = $1 AND branch_id = $2
             ORDER BY expense_date DESC
             LIMIT 500`,
            [tenantId, branchId]
        );

        // CORTES DE CAJA (últimos 100)
        const cashCutsResult = await pool.query(
            `SELECT * FROM cash_cuts
             WHERE tenant_id = $1 AND branch_id = $2
             ORDER BY cut_date DESC
             LIMIT 100`,
            [tenantId, branchId]
        );

        // GUARDIAN EVENTS (últimos 500)
        const guardianEventsResult = await pool.query(
            `SELECT * FROM guardian_events
             WHERE tenant_id = $1 AND branch_id = $2
             ORDER BY timestamp DESC
             LIMIT 500`,
            [tenantId, branchId]
        );

        // EMPLEADOS de la sucursal
        const employeesResult = await pool.query(
            `SELECT e.* FROM employees e
             INNER JOIN employee_branches eb ON e.id = eb.employee_id
             WHERE e.tenant_id = $1 AND eb.branch_id = $2`,
            [tenantId, branchId]
        );

        // INFORMACIÓN DE LA SUCURSAL
        const branchResult = await pool.query(
            `SELECT * FROM branches WHERE id = $1 AND tenant_id = $2`,
            [branchId, tenantId]
        );

        const snapshot = {
            metadata: {
                tenant_id: tenantId,
                branch_id: branchId,
                branch_name: branchResult.rows[0]?.name || 'N/A',
                generated_at: new Date().toISOString(),
                record_counts: {
                    sales: salesResult.rows.length,
                    expenses: expensesResult.rows.length,
                    cash_cuts: cashCutsResult.rows.length,
                    guardian_events: guardianEventsResult.rows.length,
                    employees: employeesResult.rows.length
                }
            },
            data: {
                sales: salesResult.rows,
                expenses: expensesResult.rows,
                cash_cuts: cashCutsResult.rows,
                guardian_events: guardianEventsResult.rows,
                employees: employeesResult.rows.map(e => ({
                    ...e,
                    password: undefined // No enviar contraseñas
                })),
                branch: branchResult.rows[0]
            }
        };

        console.log(`[Restore] ✅ Snapshot generado: ${salesResult.rows.length} ventas, ${expensesResult.rows.length} gastos`);

        res.json({
            success: true,
            message: 'Snapshot generado exitosamente',
            data: snapshot
        });

    } catch (error) {
        console.error('[Restore] ❌ Error generando snapshot:', error);
        res.status(500).json({
            success: false,
            message: 'Error generando snapshot',
            error: error.message
        });
    }
});

// ============================================================================
// GET /api/restore/available-branches
// Obtiene las sucursales disponibles para el usuario
// ============================================================================

router.get('/available-branches', authenticate, async (req, res) => {
    try {
        const { tenantId, id: employeeId } = req.user;

        console.log(`[Restore] Obteniendo sucursales para empleado ${employeeId}`);

        // Obtener sucursales del tenant
        const branchesResult = await pool.query(
            `SELECT b.* FROM branches b
             WHERE b.tenant_id = $1 AND b.is_active = true
             ORDER BY b.name`,
            [tenantId]
        );

        res.json({
            success: true,
            data: branchesResult.rows
        });

    } catch (error) {
        console.error('[Restore] ❌ Error obteniendo sucursales:', error);
        res.status(500).json({
            success: false,
            message: 'Error obteniendo sucursales',
            error: error.message
        });
    }
});

// ============================================================================
// POST /api/restore/verify-account
// Verifica si existe una cuenta con el email proporcionado
// ============================================================================

router.post('/verify-account', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email es requerido'
            });
        }

        const result = await pool.query(
            `SELECT
                e.id,
                e.full_name,
                e.email,
                t.business_name,
                b.name as branch_name
            FROM employees e
            INNER JOIN tenants t ON e.tenant_id = t.id
            LEFT JOIN branches b ON e.main_branch_id = b.id
            WHERE e.email = $1`,
            [email.toLowerCase()]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No se encontró una cuenta con ese email'
            });
        }

        const account = result.rows[0];

        res.json({
            success: true,
            message: 'Cuenta encontrada',
            data: {
                full_name: account.full_name,
                email: account.email,
                business_name: account.business_name,
                branch_name: account.branch_name || 'N/A'
            }
        });

    } catch (error) {
        console.error('[Restore] ❌ Error verificando cuenta:', error);
        res.status(500).json({
            success: false,
            message: 'Error verificando cuenta',
            error: error.message
        });
    }
});

module.exports = router;
