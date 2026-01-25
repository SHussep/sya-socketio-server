// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE: Autenticacion de Dispositivo para Sync Offline-First
// Verifica que el terminal_id esta registrado para el tenant
// ═══════════════════════════════════════════════════════════════

/**
 * Factory que crea el middleware validateSyncDevice con acceso al pool
 * Este middleware es ESTRICTO - rechaza si el dispositivo no esta registrado
 *
 * @param {Pool} pool - Pool de conexiones PostgreSQL
 * @returns {Function} Middleware de validacion de dispositivo
 */
function createDeviceAuthMiddleware(pool) {
    return async function validateSyncDevice(req, res, next) {
        const tenant_id = req.body?.tenant_id || req.body?.tenantId;
        const terminal_id = req.body?.terminal_id || req.body?.terminalId;
        const employee_global_id = req.body?.employee_global_id || req.body?.employeeGlobalId;

        if (!tenant_id) {
            return res.status(400).json({
                success: false,
                message: 'tenant_id es requerido'
            });
        }

        if (!terminal_id) {
            return res.status(400).json({
                success: false,
                message: 'terminal_id es requerido para sync'
            });
        }

        try {
            // Verificar terminal_id registrado (excepto MOBILE-APP que es especial)
            if (terminal_id !== 'MOBILE-APP') {
                const deviceResult = await pool.query(
                    `SELECT id, device_id, tenant_id, branch_id, is_active
                     FROM devices WHERE device_id = $1 AND tenant_id = $2`,
                    [terminal_id, tenant_id]
                );

                if (deviceResult.rows.length === 0) {
                    console.warn(`[DeviceAuth] Dispositivo no registrado: ${terminal_id}`);
                    return res.status(403).json({
                        success: false,
                        message: 'Dispositivo no registrado',
                        code: 'DEVICE_NOT_REGISTERED'
                    });
                }

                if (!deviceResult.rows[0].is_active) {
                    return res.status(403).json({
                        success: false,
                        message: 'Dispositivo desactivado',
                        code: 'DEVICE_INACTIVE'
                    });
                }

                req.device = deviceResult.rows[0];
            }

            // Verificar employee si se proporciona
            if (employee_global_id) {
                const empResult = await pool.query(
                    `SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2 AND is_active = true`,
                    [employee_global_id, tenant_id]
                );
                if (empResult.rows.length === 0) {
                    return res.status(403).json({
                        success: false,
                        message: 'Empleado no encontrado en este tenant',
                        code: 'EMPLOYEE_NOT_FOUND'
                    });
                }
                req.employee = empResult.rows[0];
            }

            req.validatedTenantId = parseInt(tenant_id);
            next();
        } catch (error) {
            console.error('[DeviceAuth] Error:', error.message);
            return res.status(500).json({ success: false, message: 'Error validando dispositivo' });
        }
    };
}

/**
 * Middleware de validacion SUAVE para sync - Solo valida tenant existe
 * NO rechaza por dispositivo no registrado (para compatibilidad)
 * Usa esto para transicion gradual
 */
function createTenantValidationMiddleware(pool) {
    return async function validateSyncTenant(req, res, next) {
        const tenant_id = req.body?.tenant_id || req.body?.tenantId;
        const employee_global_id = req.body?.employee_global_id || req.body?.employeeGlobalId;

        if (!tenant_id) {
            return res.status(400).json({
                success: false,
                message: 'tenant_id es requerido'
            });
        }

        try {
            // 1. Verificar que tenant existe y esta activo
            const tenantResult = await pool.query(
                'SELECT id, is_active FROM tenants WHERE id = $1',
                [tenant_id]
            );

            if (tenantResult.rows.length === 0) {
                console.warn(`[SyncAuth] Tenant no existe: ${tenant_id}`);
                return res.status(403).json({
                    success: false,
                    message: 'Tenant no encontrado',
                    code: 'TENANT_NOT_FOUND'
                });
            }

            if (!tenantResult.rows[0].is_active) {
                return res.status(403).json({
                    success: false,
                    message: 'Tenant inactivo',
                    code: 'TENANT_INACTIVE'
                });
            }

            // 2. Si hay employee_global_id, verificar pertenece al tenant
            if (employee_global_id) {
                const empResult = await pool.query(
                    `SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2`,
                    [employee_global_id, tenant_id]
                );

                if (empResult.rows.length === 0) {
                    console.warn(`[SyncAuth] Employee ${employee_global_id} no pertenece a tenant ${tenant_id}`);
                    return res.status(403).json({
                        success: false,
                        message: 'Empleado no pertenece a este tenant',
                        code: 'EMPLOYEE_TENANT_MISMATCH'
                    });
                }
            }

            req.validatedTenantId = parseInt(tenant_id);
            next();
        } catch (error) {
            console.error('[SyncAuth] Error:', error.message);
            return res.status(500).json({ success: false, message: 'Error validando sync' });
        }
    };
}

/**
 * Middleware opcional: Solo loguea la operacion de sync sin bloquear
 * Util para transicion gradual antes de requerir device auth
 */
function createSyncLogger(pool) {
    return async function logSyncOperation(req, res, next) {
        const tenant_id = req.body?.tenant_id || req.body?.tenantId;
        const terminal_id = req.body?.terminal_id || req.body?.terminalId;
        const employee_global_id = req.body?.employee_global_id;

        console.log(`[Sync] ${req.method} ${req.path} - tenant=${tenant_id}, terminal=${terminal_id}, employee=${employee_global_id || 'N/A'}`);

        next();
    };
}

module.exports = {
    createDeviceAuthMiddleware,
    createTenantValidationMiddleware,
    createSyncLogger
};
