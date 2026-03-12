// Tenant & Branch Management Methods

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const archiver = require('archiver');
const { Readable } = require('stream');
const dropboxManager = require('../../utils/dropbox-manager');
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = {
    async overwriteTenant(req, res) {
        console.log('[Tenant Overwrite] Nueva solicitud de sobrescritura de tenant');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const tenantId = parseInt(req.params.id);
        const { businessName, ownerName, phoneNumber, address, password } = req.body;

        if (!tenantId || isNaN(tenantId)) {
            return res.status(400).json({
                success: false,
                message: 'ID de tenant inválido'
            });
        }

        if (!businessName || !ownerName || !password) {
            return res.status(400).json({
                success: false,
                message: 'businessName, ownerName y password son requeridos'
            });
        }

        const client = await this.pool.connect();

        try {
            const decoded = jwt.verify(token, JWT_SECRET);

            if (decoded.tenantId !== tenantId) {
                return res.status(403).json({
                    success: false,
                    message: 'No autorizado para modificar este tenant'
                });
            }

            // Verificar que el usuario sea owner o admin (role_id = 1)
            const employeeCheck = await this.pool.query(
                'SELECT role_id, is_owner FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [decoded.employeeId, tenantId]
            );

            if (employeeCheck.rows.length === 0 || (!employeeCheck.rows[0].is_owner && employeeCheck.rows[0].role_id !== 1)) {
                return res.status(403).json({
                    success: false,
                    message: 'Solo el propietario o administrador puede sobrescribir el tenant'
                });
            }

            await client.query('BEGIN');

            await client.query(`
                UPDATE tenants
                SET business_name = $1,
                    updated_at = NOW()
                WHERE id = $2
            `, [businessName, tenantId]);

            console.log(`[Tenant Overwrite] ✅ Tenant actualizado: ${businessName} (ID: ${tenantId})`);

            const passwordHash = await bcrypt.hash(password, 10);

            const ownerNameParts = ownerName.trim().split(/\s+/);
            const ownerFirstName = ownerNameParts[0] || ownerName;
            const ownerLastName = ownerNameParts.length > 1 ? ownerNameParts.slice(1).join(' ') : '';

            await client.query(`
                UPDATE employees
                SET first_name = $1,
                    last_name = $2,
                    password_hash = $3,
                    updated_at = NOW()
                WHERE tenant_id = $4 AND is_owner = true
            `, [ownerFirstName, ownerLastName, passwordHash, tenantId]);

            console.log(`[Tenant Overwrite] ✅ Empleado owner actualizado: ${ownerName}`);

            await client.query('COMMIT');

            res.json({
                success: true,
                message: 'Información del tenant sobrescrita exitosamente',
                tenant: {
                    id: tenantId,
                    businessName: businessName
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');

            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            console.error('[Tenant Overwrite] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al sobrescribir tenant',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        } finally {
            client.release();
        }
    },

    async fullWipeBranch(req, res) {
        console.log('[Branch Full Wipe] Nueva solicitud de limpieza completa de sucursal');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const branchId = parseInt(req.params.id);

        if (!branchId || isNaN(branchId)) {
            return res.status(400).json({
                success: false,
                message: 'ID de sucursal inválido'
            });
        }

        const client = await this.pool.connect();

        try {
            const decoded = jwt.verify(token, JWT_SECRET);

            await client.query('BEGIN');

            const branchResult = await client.query(
                'SELECT * FROM branches WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [branchId, decoded.tenantId]
            );

            if (branchResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada o no pertenece a tu negocio'
                });
            }

            const branch = branchResult.rows[0];

            const employeeResult = await client.query(
                'SELECT role_id, is_owner FROM employees WHERE id = $1 AND tenant_id = $2',
                [decoded.employeeId, decoded.tenantId]
            );

            if (employeeResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            const employee = employeeResult.rows[0];

            if (!employee.is_owner && employee.role_id !== 1) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Solo el propietario o administrador puede hacer limpieza completa de sucursales'
                });
            }

            console.log(`[Branch Full Wipe] Limpieza completa de branch ${branch.name} (ID: ${branchId})`);

            // 1. Dispositivos (tabla actual: branch_devices)
            const devicesResult = await client.query(
                'DELETE FROM branch_devices WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${devicesResult.rowCount} dispositivos eliminados`);

            // 2. Sesiones
            const sessionsResult = await client.query(
                `DELETE FROM sessions WHERE employee_id IN (
                    SELECT id FROM employees WHERE id IN (
                        SELECT employee_id FROM employee_branches WHERE branch_id = $1
                    )
                )`,
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${sessionsResult.rowCount} sesiones eliminadas`);

            // 3. Ventas (CASCADE elimina ventas_detalle, repartidor_assignments y repartidor_returns)
            const salesResult = await client.query(
                'DELETE FROM ventas WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${salesResult.rowCount} ventas eliminadas`);

            // 4. Pagos de crédito
            const creditPaymentsResult = await client.query(
                'DELETE FROM credit_payments WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${creditPaymentsResult.rowCount} pagos de crédito eliminados`);

            // 5. Gastos
            const expensesResult = await client.query(
                'DELETE FROM expenses WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${expensesResult.rowCount} gastos eliminados`);

            // 6. Depósitos
            const depositsResult = await client.query(
                'DELETE FROM deposits WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${depositsResult.rowCount} depósitos eliminados`);

            // 7. Retiros
            const withdrawalsResult = await client.query(
                'DELETE FROM withdrawals WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${withdrawalsResult.rowCount} retiros eliminados`);

            // 8. Cortes de caja
            const cashCutsResult = await client.query(
                'DELETE FROM cash_cuts WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${cashCutsResult.rowCount} cortes de caja eliminados`);

            // 9. Shifts (después de ventas/expenses por FK RESTRICT)
            const shiftsResult = await client.query(
                'DELETE FROM shifts WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${shiftsResult.rowCount} shifts eliminados`);

            // 10. Guardian: pesajes sospechosos
            const suspiciousLogsResult = await client.query(
                'DELETE FROM suspicious_weighing_logs WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${suspiciousLogsResult.rowCount} suspicious weighing logs eliminados`);

            // 11. Guardian: desconexiones de báscula
            const scaleLogsResult = await client.query(
                'DELETE FROM scale_disconnection_logs WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${scaleLogsResult.rowCount} scale disconnection logs eliminados`);

            const employeeBranchesResult = await client.query(
                'DELETE FROM employee_branches WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${employeeBranchesResult.rowCount} relaciones eliminadas`);

            const employeesMainBranchResult = await client.query(
                'UPDATE employees SET main_branch_id = NULL WHERE main_branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${employeesMainBranchResult.rowCount} empleados actualizados`);

            const backupsResult = await client.query(
                'DELETE FROM backup_metadata WHERE branch_id = $1',
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK ${backupsResult.rowCount} backups eliminados`);

            await client.query(
                `UPDATE branches SET name = 'Sucursal Reestablecida' WHERE id = $1`,
                [branchId]
            );
            console.log(`[Branch Full Wipe] OK Sucursal reestablecida`);

            await client.query('COMMIT');

            console.log(`[Branch Full Wipe] ✅ Sucursal "${branch.name}" completamente limpiada`);

            res.json({
                success: true,
                message: `La sucursal "${branch.name}" ha sido completamente limpiada. Puedes iniciar desde cero.`,
                branch: {
                    id: branch.id,
                    name: branch.name,
                    branchCode: branch.branch_code
                },
                deletedItems: {
                    devices: devicesResult.rowCount,
                    sessions: sessionsResult.rowCount,
                    sales: salesResult.rowCount,
                    creditPayments: creditPaymentsResult.rowCount,
                    expenses: expensesResult.rowCount,
                    deposits: depositsResult.rowCount,
                    withdrawals: withdrawalsResult.rowCount,
                    cashCuts: cashCutsResult.rowCount,
                    shifts: shiftsResult.rowCount,
                    suspiciousLogs: suspiciousLogsResult.rowCount,
                    scaleLogs: scaleLogsResult.rowCount,
                    employeeBranches: employeeBranchesResult.rowCount,
                    backups: backupsResult.rowCount,
                    employeesUpdated: employeesMainBranchResult.rowCount
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');

            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            console.error('[Branch Full Wipe] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al limpiar sucursal',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        } finally {
            client.release();
        }
    },

    async wipeBranch(req, res) {
        console.log('[Branch Wipe] Nueva solicitud de limpieza de sucursal');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const branchId = parseInt(req.params.id);

        if (!branchId || isNaN(branchId)) {
            return res.status(400).json({
                success: false,
                message: 'ID de sucursal inválido'
            });
        }

        const client = await this.pool.connect();

        try {
            const decoded = jwt.verify(token, JWT_SECRET);

            await client.query('BEGIN');

            const branchResult = await client.query(
                'SELECT * FROM branches WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [branchId, decoded.tenantId]
            );

            if (branchResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada o no pertenece a tu negocio'
                });
            }

            const branch = branchResult.rows[0];

            const employeeResult = await client.query(
                'SELECT role_id, is_owner FROM employees WHERE id = $1 AND tenant_id = $2',
                [decoded.employeeId, decoded.tenantId]
            );

            if (employeeResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Usuario no encontrado'
                });
            }

            const employee = employeeResult.rows[0];

            if (!employee.is_owner && employee.role_id !== 1 && employee.role_id !== 2) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: 'Solo propietarios, administradores y encargados pueden limpiar sucursales'
                });
            }

            console.log(`[Branch Wipe] Limpiando datos transaccionales de branch ${branch.name} (ID: ${branchId})`);

            const devicesResult = await client.query(
                'DELETE FROM branch_devices WHERE branch_id = $1',
                [branchId]
            );

            console.log(`[Branch Wipe] ✅ ${devicesResult.rowCount} dispositivos eliminados`);

            await client.query('COMMIT');

            console.log(`[Branch Wipe] ✅ Sucursal "${branch.name}" limpiada exitosamente`);

            res.json({
                success: true,
                message: `La sucursal "${branch.name}" ha sido limpiada. Ahora puedes iniciar desde cero.`,
                branch: {
                    id: branch.id,
                    name: branch.name,
                    branchCode: branch.branch_code,
                    devicesDeactivated: devicesResult.rowCount
                }
            });

        } catch (error) {
            await client.query('ROLLBACK');

            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado'
                });
            }

            console.error('[Branch Wipe] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al limpiar sucursal',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        } finally {
            client.release();
        }
    },

    async checkEmail(req, res) {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email es requerido'
            });
        }

        try {
            const result = await this.pool.query(
                'SELECT id FROM employees WHERE LOWER(email) = LOWER($1)',
                [email]
            );

            res.json({
                success: true,
                exists: result.rows.length > 0
            });
        } catch (error) {
            console.error('[Check Email] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al verificar email',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    async getBranches(req, res) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const tenantId = decoded.tenantId;

            const branchesResult = await this.pool.query(
                `SELECT id, branch_code, name, address, timezone, created_at
                 FROM branches
                 WHERE tenant_id = $1 AND is_active = true
                 ORDER BY created_at ASC`,
                [tenantId]
            );

            res.json({
                success: true,
                branches: branchesResult.rows
            });

        } catch (error) {
            console.error('[Get Branches] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener sucursales',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    async createBranch(req, res) {
        console.log('[Create Branch] Nueva solicitud de creación de sucursal');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const { name, address, timezone } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'El nombre de la sucursal es requerido'
            });
        }

        const client = await this.pool.connect();

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const tenantId = decoded.tenantId;

            await client.query('BEGIN');

            const tenantResult = await client.query(`
                SELECT t.id, t.tenant_code, t.business_name,
                       s.name as subscription_name
                FROM tenants t
                JOIN subscriptions s ON t.subscription_id = s.id
                WHERE t.id = $1 AND t.is_active = true
            `, [tenantId]);

            if (tenantResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];

            // Buscar una licencia disponible (FOR UPDATE para evitar race conditions)
            const licenseResult = await client.query(`
                SELECT id FROM branch_licenses
                WHERE tenant_id = $1 AND status = 'available'
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE
            `, [tenantId]);

            if (licenseResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: `No tienes licencias de sucursal disponibles. Contacta a soporte para agregar más sucursales.`
                });
            }

            const availableLicenseId = licenseResult.rows[0].id;

            // Contar branches para generar código único
            const countResult = await client.query(
                'SELECT COUNT(*) as count FROM branches WHERE tenant_id = $1',
                [tenantId]
            );
            const branchCount = parseInt(countResult.rows[0].count);
            const branchCode = `B${tenantId}S${branchCount + 1}`;

            const newBranchResult = await client.query(`
                INSERT INTO branches (tenant_id, branch_code, name, address, timezone)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id, branch_code, name, address, timezone, created_at
            `, [tenantId, branchCode, name, address, timezone || 'America/Mexico_City']);

            const newBranch = newBranchResult.rows[0];

            // Activar la licencia con el branch recién creado
            await client.query(`
                UPDATE branch_licenses
                SET branch_id = $1, status = 'active', activated_at = NOW(), updated_at = NOW()
                WHERE id = $2
            `, [newBranch.id, availableLicenseId]);

            const ownerResult = await client.query(
                'SELECT id FROM employees WHERE tenant_id = $1 AND is_owner = true',
                [tenantId]
            );

            if (ownerResult.rows.length > 0) {
                const ownerId = ownerResult.rows[0].id;
                await client.query(`
                    INSERT INTO employee_branches (tenant_id, employee_id, branch_id)
                    VALUES ($1, $2, $3)
                    ON CONFLICT DO NOTHING
                `, [tenantId, ownerId, newBranch.id]);
            }

            const genericCustomerResult = await client.query(
                'SELECT get_or_create_generic_customer($1, $2) as customer_id',
                [tenantId, newBranch.id]
            );
            console.log(`[Create Branch] Cliente genérico creado/verificado: ${genericCustomerResult.rows[0].customer_id}`);

            await client.query('COMMIT');

            console.log(`[Create Branch] ✅ Sucursal creada: ${newBranch.name} (${newBranch.branch_code})`);

            res.status(201).json({
                success: true,
                message: 'Sucursal creada exitosamente',
                branch: newBranch
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Create Branch] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al crear sucursal',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        } finally {
            client.release();
        }
    },

    async joinExistingBranch(req, res) {
        console.log('[Join Branch] Solicitud para unirse a sucursal existente');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        const { branchId } = req.body;

        if (!branchId) {
            return res.status(400).json({
                success: false,
                message: 'ID de sucursal requerido'
            });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const { employeeId, tenantId } = decoded;

            const branchResult = await this.pool.query(
                'SELECT * FROM branches WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [branchId, tenantId]
            );

            if (branchResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada o no pertenece a tu negocio'
                });
            }

            const branch = branchResult.rows[0];

            await this.pool.query(`
                INSERT INTO employee_branches (tenant_id, employee_id, branch_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (employee_id, branch_id) DO NOTHING
            `, [tenantId, employeeId, branchId]);

            await this.pool.query(
                'UPDATE employees SET main_branch_id = $1 WHERE id = $2',
                [branchId, employeeId]
            );

            const newToken = jwt.sign(
                {
                    employeeId: employeeId,
                    tenantId: tenantId,
                    branchId: branchId,
                    roleId: decoded.roleId,
                    email: decoded.email
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            console.log(`[Join Branch] ✅ Empleado ${employeeId} unido a branch ${branch.name}`);

            res.json({
                success: true,
                message: `Te has unido a la sucursal ${branch.name}`,
                token: newToken,
                branch: {
                    id: branch.id,
                    name: branch.name,
                    branchCode: branch.branch_code
                }
            });

        } catch (error) {
            console.error('[Join Branch] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al unirse a la sucursal',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    async syncInitAfterWipe(req, res) {
        console.log('[Sync Init] Solicitud de sincronización inicial post-wipe');

        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const { tenantId, branchId, employeeId } = decoded;

            // ═══════════════════════════════════════════════════════════════
            // OBTENER INFORMACIÓN DEL TENANT (CRÍTICO para licencia)
            // ═══════════════════════════════════════════════════════════════
            const tenantResult = await this.pool.query(
                `SELECT id, tenant_code, business_name
                 FROM tenants
                 WHERE id = $1`,
                [tenantId]
            );

            if (tenantResult.rows.length === 0) {
                console.log(`[Sync Init] ❌ Tenant ${tenantId} no encontrado`);
                return res.status(404).json({
                    success: false,
                    message: 'Tenant no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];
            console.log(`[Sync Init] ✅ Tenant encontrado: ID=${tenant.id}, Code=${tenant.tenant_code}`);

            // ═══════════════════════════════════════════════════════════════
            // OBTENER INFORMACIÓN DEL EMPLEADO
            // ═══════════════════════════════════════════════════════════════
            const employeeResult = await this.pool.query(
                `SELECT e.id, e.email, e.first_name, e.last_name, e.main_branch_id,
                        r.name as role_name
                 FROM employees e
                 LEFT JOIN roles r ON e.role_id = r.id
                 WHERE e.id = $1 AND e.tenant_id = $2`,
                [employeeId, tenantId]
            );

            let employee = null;
            if (employeeResult.rows.length > 0) {
                const emp = employeeResult.rows[0];
                employee = {
                    id: emp.id,
                    email: emp.email || '',
                    name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
                    role: emp.role_name || 'Empleado',
                    primaryBranchId: emp.main_branch_id || branchId
                };
                console.log(`[Sync Init] ✅ Empleado: ID=${employee.id}, Email=${employee.email}`);
            }

            // ═══════════════════════════════════════════════════════════════
            // OBTENER SUCURSALES DEL TENANT
            // ═══════════════════════════════════════════════════════════════
            const branchesResult = await this.pool.query(
                `SELECT b.id, b.branch_code, b.name, b.timezone, b.address, b.phone, b.is_active,
                        (SELECT COUNT(*) FROM employee_branches eb WHERE eb.branch_id = b.id) as employee_count
                 FROM branches b
                 WHERE b.tenant_id = $1 AND b.is_active = true
                 ORDER BY b.id`,
                [tenantId]
            );

            const branches = branchesResult.rows.map(b => ({
                id: b.id,
                branchCode: b.branch_code,
                name: b.name,
                timezone: b.timezone || 'America/Mexico_City',
                address: b.address || '',
                phone: b.phone || '',
                isActive: b.is_active,
                employeeCount: parseInt(b.employee_count) || 0,
                primary: b.id === branchId // Marcar como primaria si coincide con el branch del token
            }));

            console.log(`[Sync Init] ✅ ${branches.length} sucursales encontradas`);

            // ═══════════════════════════════════════════════════════════════
            // OBTENER DATOS DE PRODUCTOS, CATEGORÍAS Y CLIENTES (legado - opcional)
            // ═══════════════════════════════════════════════════════════════
            let productsResult = { rows: [] };
            let categoriesResult = { rows: [] };
            let customersResult = { rows: [] };

            try {
                productsResult = await this.pool.query(
                    'SELECT * FROM products WHERE tenant_id = $1 AND is_active = true',
                    [tenantId]
                );

                categoriesResult = await this.pool.query(
                    'SELECT * FROM categories WHERE tenant_id = $1 AND is_active = true',
                    [tenantId]
                );

                customersResult = await this.pool.query(
                    'SELECT * FROM customers WHERE tenant_id = $1 AND is_active = true',
                    [tenantId]
                );

                console.log(`[Sync Init] Enviando datos base: ${productsResult.rows.length} productos, ${categoriesResult.rows.length} categorías`);
            } catch (legacyDataError) {
                console.log(`[Sync Init] ⚠️ Tablas legacy no disponibles (ignorando): ${legacyDataError.message}`);
                // Continuar sin datos legacy - no es crítico
            }

            // ═══════════════════════════════════════════════════════════════
            // RESPUESTA CON ESTRUCTURA COMPLETA (para WinUI y app móvil)
            // ═══════════════════════════════════════════════════════════════
            res.json({
                success: true,
                // NUEVO: Información estructurada para sincronización de sesión
                sync: {
                    tenant: {
                        id: tenant.id,
                        code: tenant.tenant_code,  // ⚠️ CRÍTICO: tenant_code para consultar licencia
                        name: tenant.business_name
                    },
                    employee: employee,
                    branches: branches,
                    timestamp: new Date().toISOString()
                },
                // LEGADO: Mantener compatibilidad con clientes anteriores
                data: {
                    products: productsResult.rows,
                    categories: categoriesResult.rows,
                    customers: customersResult.rows
                }
            });

        } catch (error) {
            console.error('[Sync Init] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error en sincronización inicial',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    async getMainEmployee(req, res) {
        const { tenantId } = req.params;

        try {
            const result = await this.pool.query(
                `SELECT id, first_name, last_name, email, username, global_id
                 FROM employees
                 WHERE tenant_id = $1 AND is_owner = true
                 LIMIT 1`,
                [tenantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No se encontró empleado principal'
                });
            }

            const employee = result.rows[0];

            // ⚠️ CRÍTICO: Generar global_id si no existe (para empleados legacy)
            if (!employee.global_id) {
                const { v4: uuidv4 } = require('uuid');
                const newGlobalId = uuidv4();
                const newTerminalId = 'server-auto-' + Date.now();

                await this.pool.query(
                    `UPDATE employees
                     SET global_id = $1,
                         terminal_id = COALESCE(terminal_id, $2),
                         local_op_seq = COALESCE(local_op_seq, 1),
                         created_local_utc = COALESCE(created_local_utc, $3)
                     WHERE id = $4`,
                    [newGlobalId, newTerminalId, new Date().toISOString(), employee.id]
                );

                employee.global_id = newGlobalId;
                console.log(`[Get Main Employee] 🔑 GlobalId auto-generado para empleado ${employee.id}: ${newGlobalId}`);
            }

            // Si el username está vacío o null, derivarlo del email automáticamente
            if (!employee.username || employee.username.trim() === '') {
                employee.username = employee.email ? employee.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
            }

            // Construir full_name: usar first_name + last_name si existen, sino usar parte del email
            let fullName = '';
            if (employee.first_name && employee.first_name.trim() !== '') {
                fullName = employee.first_name.trim();
                if (employee.last_name && employee.last_name.trim() !== '') {
                    fullName += ' ' + employee.last_name.trim();
                }
            } else if (employee.email) {
                // Si no hay nombre, usar el prefijo del email con la primera letra mayúscula
                const emailPrefix = employee.email.split('@')[0];
                fullName = emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1);
            }
            employee.full_name = fullName;

            console.log(`[Get Main Employee] ✅ Empleado retornado:`);
            console.log(`[Get Main Employee]    - ID: ${employee.id}`);
            console.log(`[Get Main Employee]    - GlobalId: ${employee.global_id}`);
            console.log(`[Get Main Employee]    - Username: ${employee.username}`);
            console.log(`[Get Main Employee]    - FullName: ${fullName}`);

            res.json({
                success: true,
                employee: employee
            });
        } catch (error) {
            console.error('[Get Main Employee] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener empleado principal',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // VERIFY ADMIN PASSWORD - Para reclamar rol de Equipo Principal
    // Verifica la contraseña del owner/admin del tenant
    // ═══════════════════════════════════════════════════════════════════════════
    async verifyAdminPassword(req, res) {
        console.log('[Verify Admin Password] Nueva solicitud de verificación');

        const { tenantId, password } = req.body;

        if (!tenantId || !password) {
            return res.status(400).json({
                success: false,
                message: 'tenantId y password son requeridos'
            });
        }

        try {
            // Buscar al owner del tenant O cualquier administrador (role_id = 1)
            const employeeResult = await this.pool.query(
                `SELECT id, password_hash, first_name, last_name, is_owner, role_id
                 FROM employees
                 WHERE tenant_id = $1
                   AND is_active = TRUE
                   AND (is_owner = TRUE OR role_id = 1)
                 ORDER BY is_owner DESC, id ASC
                 LIMIT 1`,
                [tenantId]
            );

            if (employeeResult.rows.length === 0) {
                console.log(`[Verify Admin Password] ❌ No se encontró owner/admin para tenant ${tenantId}`);
                return res.status(404).json({
                    success: false,
                    message: 'No se encontró administrador para este negocio'
                });
            }

            const employee = employeeResult.rows[0];

            // Verificar que tenga contraseña configurada
            if (!employee.password_hash) {
                console.log(`[Verify Admin Password] ❌ El administrador no tiene contraseña configurada`);
                return res.status(400).json({
                    success: false,
                    message: 'El administrador no tiene contraseña configurada. Por favor, configura una contraseña primero.'
                });
            }

            // Comparar contraseña con bcrypt
            const isValid = await bcrypt.compare(password, employee.password_hash);

            if (isValid) {
                console.log(`[Verify Admin Password] ✅ Contraseña verificada para tenant ${tenantId}`);
                res.json({
                    success: true,
                    message: 'Contraseña verificada correctamente',
                    admin: {
                        id: employee.id,
                        name: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
                        isOwner: employee.is_owner
                    }
                });
            } else {
                console.log(`[Verify Admin Password] ❌ Contraseña incorrecta para tenant ${tenantId}`);
                res.status(401).json({
                    success: false,
                    message: 'Contraseña incorrecta'
                });
            }

        } catch (error) {
            console.error('[Verify Admin Password] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al verificar contraseña',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    authenticateToken(req, res, next) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token no proporcionado'
            });
        }

        jwt.verify(token, JWT_SECRET, async (err, user) => {
            if (err) {
                // ✅ 401 para token expirado (la app debe intentar renovar)
                // 403 se reserva para "no tienes permiso" (tenant eliminado, etc.)
                return res.status(401).json({
                    success: false,
                    message: 'Token inválido o expirado',
                    code: 'TOKEN_EXPIRED'
                });
            }

            // ✅ FIX: Verificar que el tenant realmente existe en la base de datos
            // Esto previene que usuarios con tokens válidos pero tenants eliminados
            // sigan accediendo a la aplicación
            if (user.tenantId) {
                try {
                    const tenantCheck = await this.pool.query(
                        'SELECT id FROM tenants WHERE id = $1',
                        [user.tenantId]
                    );

                    if (tenantCheck.rows.length === 0) {
                        console.log(`[Auth] ❌ Tenant ${user.tenantId} no existe en la base de datos`);
                        return res.status(403).json({
                            success: false,
                            message: 'Tu cuenta ha sido desactivada o eliminada. Por favor, contacta al administrador.',
                            code: 'TENANT_NOT_FOUND'
                        });
                    }
                } catch (dbError) {
                    console.error('[Auth] Error verificando tenant:', dbError);
                    // En caso de error de BD, dejamos pasar para no bloquear el servicio
                    // pero registramos el error
                }
            }

            req.user = user;
            next();
        });
    }

};
