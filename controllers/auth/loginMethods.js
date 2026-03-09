// Login Methods (desktopLogin, mobileLogin)

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

const maskEmail = (email) => {
    if (!email) return 'unknown';
    return email.replace(/^(.)(.*)(@.*)$/, '$1***$3');
};

const deriveMobileAccessType = (roleId, canUseMobileApp) => {
    if (!canUseMobileApp) return 'none';
    switch (roleId) {
        case 1:
        case 2:
            return 'admin';
        case 3:
            return 'distributor';
        case 4:
        case 99:
        default:
            return 'none';
    }
};

module.exports = {
    async desktopLogin(req, res) {
        const { email, password, branchId, tenantCode } = req.body;

        console.log(`[Desktop Login] Intento de login: email=${maskEmail(email)}, tenantCode=${tenantCode}`);

        if (!tenantCode || !email || !password) {
            return res.status(400).json({
                success: false,
                message: 'TenantCode, Email y contraseña son requeridos'
            });
        }

        try {
            console.log(`[Desktop Login] 🔍 Buscando tenant con código: ${tenantCode}`);
            const tenantLookup = await this.pool.query(
                'SELECT id FROM tenants WHERE tenant_code = $1 AND is_active = true',
                [tenantCode]
            );

            if (tenantLookup.rows.length === 0) {
                console.log(`[Desktop Login] ❌ Tenant no encontrado con código: ${tenantCode}`);
                return res.status(401).json({
                    success: false,
                    message: 'Código de tenant inválido'
                });
            }

            const tenantId = tenantLookup.rows[0].id;
            console.log(`[Desktop Login] ✅ Tenant encontrado: ID ${tenantId}`);

            // Buscar empleado SOLO por email
            const query = 'SELECT * FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = true';
            const params = [email, tenantId];

            console.log('[Desktop Login] Ejecutando query:', query);
            console.log('[Desktop Login] Parámetros:', params);

            const employeeResult = await this.pool.query(query, params);

            console.log(`[Desktop Login] Empleados encontrados: ${employeeResult.rows.length}`);

            if (employeeResult.rows.length > 1) {
                console.log('[Desktop Login] ADVERTENCIA: Multiples empleados con el mismo email');
            }

            if (employeeResult.rows.length === 0) {
                console.log('[Desktop Login] ❌ No se encontró empleado con esas credenciales');
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            const employee = employeeResult.rows[0];
            console.log(`[Desktop Login] Empleado encontrado: ID ${employee.id}, Email ${employee.email}`);

            if (!employee.password_hash) {
                console.log(`[Desktop Login] ⚠️ Empleado ${employee.email} no tiene contraseña configurada`);
                return res.status(401).json({
                    success: false,
                    message: 'Usuario no tiene contraseña configurada. Contacte al administrador.'
                });
            }

            let validPassword = false;
            try {
                validPassword = await bcrypt.compare(password, employee.password_hash);
            } catch (bcryptError) {
                console.error('[Desktop Login] Error en verificacion de password');
                return res.status(500).json({
                    success: false,
                    message: 'Error en el servidor'
                });
            }

            if (!validPassword) {
                const maskedEmail = employee.email ? employee.email.replace(/^(.)(.*)(@.*)$/, '$1***$3') : 'unknown';
                console.log(`[Desktop Login] Contraseña incorrecta para: ${maskedEmail}`);
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            // ═══════════════════════════════════════════════════════════════════
            // ✅ AUTO-GENERAR GLOBAL_ID SI NO EXISTE (Garantiza sincronización)
            // Esto es crítico para empleados creados antes del sistema offline-first
            // ═══════════════════════════════════════════════════════════════════
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
                employee.terminal_id = newTerminalId;
                console.log(`[Desktop Login] 🔑 GlobalId auto-generado para empleado ${employee.id}: ${newGlobalId}`);
            }

            const tenantResult = await this.pool.query(
                `SELECT t.*, s.name as subscription_name
                 FROM tenants t
                 JOIN subscriptions s ON t.subscription_id = s.id
                 WHERE t.id = $1 AND t.is_active = true`,
                [employee.tenant_id]
            );

            if (tenantResult.rows.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'Tenant inactivo o no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];

            const now = new Date();
            const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;

            if (trialEndsAt && trialEndsAt < now) {
                const daysExpired = Math.ceil((now - trialEndsAt) / (1000 * 60 * 60 * 24));
                console.log(`[Desktop Login] ❌ Licencia vencida para tenant ${tenant.id}. Expiró hace ${daysExpired} días.`);
                return res.status(403).json({
                    success: false,
                    message: 'Su licencia ha caducado. Por favor, contacte con soporte para renovar.',
                    error: 'LICENSE_EXPIRED',
                    licenseInfo: {
                        expiresAt: trialEndsAt.toISOString(),
                        daysExpired: daysExpired,
                        businessName: tenant.business_name
                    }
                });
            }

            const daysRemaining = trialEndsAt ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)) : null;
            console.log(`[Desktop Login] Licencia válida. Días restantes: ${daysRemaining || 'ilimitado'}`);

            // Query simplificado - sin columnas de permisos que pueden no existir
            const branchesResult = await this.pool.query(`
                SELECT b.*
                FROM branches b
                JOIN employee_branches eb ON b.id = eb.branch_id
                WHERE eb.employee_id = $1 AND b.is_active = true
                ORDER BY b.name
            `, [employee.id]);

            const branches = branchesResult.rows;

            if (branches.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'No tienes acceso a ninguna sucursal'
                });
            }

            let selectedBranch;
            if (branchId) {
                selectedBranch = branches.find(b => b.id === parseInt(branchId));
                if (!selectedBranch) {
                    return res.status(403).json({
                        success: false,
                        message: 'No tienes acceso a esta sucursal'
                    });
                }
            } else {
                selectedBranch = branches.find(b => b.id === employee.main_branch_id) || branches[0];
            }

            const token = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: selectedBranch.id,
                    roleId: employee.role_id,
                    email: employee.email
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const refreshToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            console.log(`[Desktop Login] ✅ Login exitoso: ${employee.email} → ${selectedBranch.name}`);

            res.json({
                success: true,
                message: 'Login exitoso',
                data: {
                    token,
                    refreshToken,
                    employee: {
                        id: employee.id,
                        email: employee.email,
                        username: employee.username,
                        fullName: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
                        firstName: employee.first_name,
                        lastName: employee.last_name,
                        roleId: employee.role_id,
                        mainBranchId: employee.main_branch_id,
                        canUseMobileApp: employee.can_use_mobile_app,
                        googleUserIdentifier: employee.google_user_identifier,
                        globalId: employee.global_id,
                        terminalId: employee.terminal_id,
                        localOpSeq: employee.local_op_seq,
                        createdLocalUtc: employee.created_local_utc,
                        deviceEventRaw: employee.device_event_raw
                    },
                    tenant: {
                        id: tenant.id,
                        businessName: tenant.business_name,
                        rfc: tenant.rfc,
                        subscription: tenant.subscription_name,
                        license: {
                            expiresAt: trialEndsAt ? trialEndsAt.toISOString() : null,
                            daysRemaining: daysRemaining,
                            status: daysRemaining === null ? 'unlimited' : (daysRemaining <= 7 ? 'expiring_soon' : 'active')
                        }
                    },
                    branch: {
                        id: selectedBranch.id,
                        code: selectedBranch.branch_code,
                        name: selectedBranch.name,
                        permissions: {
                            canLogin: selectedBranch.can_login ?? true,
                            canSell: selectedBranch.can_sell ?? true,
                            canManageInventory: selectedBranch.can_manage_inventory ?? false,
                            canCloseShift: selectedBranch.can_close_shift ?? false
                        }
                    },
                    availableBranches: branches.map(b => ({
                        id: b.id,
                        code: b.branch_code,
                        name: b.name
                    }))
                }
            });

        } catch (error) {
            console.error('[Desktop Login] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error en el servidor',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    async mobileLogin(req, res) {
        console.log('[Mobile Login] Nueva solicitud de login desde app móvil');

        const { email, password, branchId } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email y contraseña son requeridos'
            });
        }

        try {
            // Buscar empleado SOLO por email, con JOIN a roles para obtener mobile_access_type
            const query = `
                SELECT e.*, r.name as role_name, r.mobile_access_type
                FROM employees e
                LEFT JOIN roles r ON e.role_id = r.id AND e.tenant_id = r.tenant_id
                WHERE LOWER(e.email) = LOWER($1) AND e.is_active = true
            `;
            const params = [email];

            const employeeResult = await this.pool.query(query, params);

            if (employeeResult.rows.length === 0) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            const employee = employeeResult.rows[0];

            if (!employee.can_use_mobile_app) {
                console.log(`[Mobile Login] ❌ Empleado ${maskEmail(employee.email)} NO tiene permiso para app móvil`);
                return res.status(403).json({
                    success: false,
                    message: 'No tienes permiso para usar la aplicación móvil. Contacta al administrador.'
                });
            }

            // Verificar que el email esté verificado (requerido para app móvil)
            // NOTA: El owner (is_owner = true) está verificado implícitamente por haber usado Gmail OAuth
            if (employee.email_verified !== true && !employee.is_owner) {
                console.log(`[Mobile Login] ❌ Empleado ${maskEmail(employee.email)} NO tiene email verificado`);
                return res.status(403).json({
                    success: false,
                    message: 'Tu email no ha sido verificado. Contacta al administrador para completar la verificación.',
                    error: 'EMAIL_NOT_VERIFIED'
                });
            }

            if (!employee.password_hash) {
                return res.status(401).json({
                    success: false,
                    message: 'Usuario no tiene contraseña configurada. Contacte al administrador.'
                });
            }

            const validPassword = await bcrypt.compare(password, employee.password_hash);

            if (!validPassword) {
                return res.status(401).json({
                    success: false,
                    message: 'Credenciales inválidas'
                });
            }

            const tenantResult = await this.pool.query(
                `SELECT t.*, s.name as subscription_name
                 FROM tenants t
                 JOIN subscriptions s ON t.subscription_id = s.id
                 WHERE t.id = $1 AND t.is_active = true`,
                [employee.tenant_id]
            );

            if (tenantResult.rows.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'Tenant inactivo o no encontrado'
                });
            }

            const tenant = tenantResult.rows[0];

            const now = new Date();
            const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;

            if (trialEndsAt && trialEndsAt < now) {
                const daysExpired = Math.ceil((now - trialEndsAt) / (1000 * 60 * 60 * 24));
                console.log(`[Mobile Login] ❌ Licencia vencida para tenant ${tenant.id}. Expiró hace ${daysExpired} días.`);
                return res.status(403).json({
                    success: false,
                    message: 'Su licencia ha caducado. Por favor, contacte con soporte para renovar.',
                    error: 'LICENSE_EXPIRED',
                    licenseInfo: {
                        expiresAt: trialEndsAt.toISOString(),
                        daysExpired: daysExpired,
                        businessName: tenant.business_name
                    }
                });
            }

            const daysRemaining = trialEndsAt ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)) : null;
            console.log(`[Mobile Login] Licencia válida. Días restantes: ${daysRemaining || 'ilimitado'}`);

            // Query simplificado - sin columnas de permisos que pueden no existir
            const branchesResult = await this.pool.query(`
                SELECT b.*
                FROM branches b
                JOIN employee_branches eb ON b.id = eb.branch_id
                WHERE eb.employee_id = $1 AND b.is_active = true
                ORDER BY b.name
            `, [employee.id]);

            const branches = branchesResult.rows;

            if (branches.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'No tienes acceso a ninguna sucursal'
                });
            }

            let selectedBranch;
            if (branchId) {
                selectedBranch = branches.find(b => b.id === parseInt(branchId));
                if (!selectedBranch) {
                    return res.status(403).json({
                        success: false,
                        message: 'No tienes acceso a esta sucursal'
                    });
                }
            } else {
                selectedBranch = branches.find(b => b.id === employee.main_branch_id) || branches[0];
            }

            const token = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: selectedBranch.id,
                    roleId: employee.role_id,
                    email: employee.email,
                    canUseMobileApp: employee.can_use_mobile_app
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const refreshToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            const employeeData = {
                id: employee.id,
                global_id: employee.global_id,  // ✅ Necesario para preferencias de notificaciones
                username: employee.username,
                fullName: employee.full_name || `${employee.first_name || ''} ${employee.last_name || ''}`.trim() || employee.username,
                email: employee.email,
                role: employee.role_name || 'Empleado',
                roleId: employee.role_id,
                isOwner: employee.is_owner || false,
                isActive: employee.is_active,
                canUseMobileApp: employee.can_use_mobile_app,
                mobileAccessType: employee.mobile_access_type || 'none',  // Viene del JOIN con roles table
                createdAt: employee.created_at
            };

            console.log(`[Mobile Login] 📱 Tipo de acceso móvil: ${employee.mobile_access_type || 'none'} (from roles table, roleId=${employee.role_id}) para ${employee.email}`);

            const branchesData = branches.map(branch => ({
                id: branch.id,
                name: branch.name,
                address: branch.address,
                api_base_url: branch.api_url,
                is_active: branch.is_active,
                last_sync_date: new Date().toISOString(),
                timezone: branch.timezone || 'America/Mexico_City'
            }));

            // === SINGLE SESSION ENFORCEMENT ===
            // Kick old devices before allowing new login
            try {
                const io = req.app.get('io');
                const activeDevices = await this.pool.query(
                    `SELECT device_token FROM device_tokens
                     WHERE employee_id = $1 AND is_active = true`,
                    [employee.id]
                );

                if (activeDevices.rows.length > 0) {
                    // 1. Send FCM to old devices FIRST (while tokens still active)
                    const { sendNotificationToEmployee } = require('../utils/notificationHelper');
                    await sendNotificationToEmployee(employee.global_id, {
                        title: 'Sesión cerrada',
                        body: 'Se inició sesión en otro dispositivo. Tu sesión ha sido cerrada.',
                        data: {
                            type: 'access_revoked',
                            employeeId: String(employee.id),
                            reason: 'new_device_login'
                        }
                    }).catch(err => console.log(`[Mobile Login] ⚠️ FCM kick failed: ${err.message}`));

                    // 2. Emit socket event to branch room
                    if (io) {
                        const branchId = selectedBranch.id;
                        io.to(`branch_${branchId}`).emit('employee:access_revoked', {
                            employeeId: employee.id,
                            employeeName: employeeData.fullName,
                            reason: 'Se inició sesión desde otro dispositivo.',
                            timestamp: new Date().toISOString()
                        });
                        console.log(`[Mobile Login] 📡 access_revoked emitido a branch_${branchId}`);
                    }

                    // 3. Deactivate ALL old device tokens (new device will register after login)
                    await this.pool.query(
                        `UPDATE device_tokens SET is_active = false, updated_at = CURRENT_TIMESTAMP
                         WHERE employee_id = $1 AND is_active = true`,
                        [employee.id]
                    );

                    console.log(`[Mobile Login] 🔒 Kicked ${activeDevices.rows.length} old device(s) for employee ${employee.id}`);
                }
            } catch (kickErr) {
                console.log(`[Mobile Login] ⚠️ Could not kick old devices: ${kickErr.message}`);
                // Non-blocking — login continues even if kick fails
            }

            console.log(`[Mobile Login] ✅ Login exitoso: ${employee.email} (can_use_mobile_app=true)`);

            return res.json({
                success: true,
                message: 'Login exitoso',
                data: {
                    token,
                    refreshToken,
                    employee: employeeData,
                    availableBranches: branchesData,
                    selectedBranch: selectedBranch,
                    tenant: {
                        id: tenant.id,
                        name: tenant.name,
                        businessName: tenant.business_name,
                        subscription: tenant.subscription_name,
                        license: {
                            expiresAt: trialEndsAt ? trialEndsAt.toISOString() : null,
                            daysRemaining: daysRemaining,
                            status: daysRemaining === null ? 'unlimited' : (daysRemaining <= 7 ? 'expiring_soon' : 'active')
                        }
                    }
                }
            });

        } catch (error) {
            console.error('[Mobile Login] Error:', error);
            return res.status(500).json({
                success: false,
                message: 'Error del servidor',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    }

};
