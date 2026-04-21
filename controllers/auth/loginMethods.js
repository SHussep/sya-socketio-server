// Login Methods (desktopLogin, mobileLogin)

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

const maskEmail = (email) => {
    if (!email) return 'unknown';
    return email.replace(/^(.)(.*)(@.*)$/, '$1***$3');
};

module.exports = {
    async desktopLogin(req, res) {
        const { email, password, branchId, tenantCode } = req.body;

        console.log(`[Desktop Login] Intento de login: email=${maskEmail(email)}, tenantCode=${tenantCode || '(sin código)'}`);

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email y contraseña son requeridos'
            });
        }

        try {
            let tenantId;
            let query, params;

            if (tenantCode) {
                // Flujo original: buscar tenant por código + email
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

                tenantId = tenantLookup.rows[0].id;
                query = 'SELECT * FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = true';
                params = [email, tenantId];
            } else {
                // Flujo sin tenantCode: buscar empleado solo por email
                // Útil para usuarios que se registraron desde móvil (Apple/Google)
                console.log(`[Desktop Login] 🔍 Buscando empleado solo por email (sin tenantCode)`);
                query = 'SELECT * FROM employees WHERE LOWER(email) = LOWER($1) AND is_active = true AND is_owner = true';
                params = [email];
            }

            console.log(`[Desktop Login] ✅ Tenant: ${tenantId || 'auto-detect'}`);


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
            // Si no venía tenantCode, obtener tenantId del empleado encontrado
            if (!tenantId) {
                tenantId = employee.tenant_id;
            }
            console.log(`[Desktop Login] Empleado encontrado: ID ${employee.id}, Email ${employee.email}, TenantId: ${tenantId}`);

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
                    email: employee.email,
                    is_owner: employee.is_owner === true
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const refreshToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    is_owner: employee.is_owner === true
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
                        isOwner: employee.is_owner === true,
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
                        tenantCode: tenant.tenant_code,
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
            // Buscar empleado SOLO por email, con JOIN a roles para fallback de mobile_access_type
            const query = `
                SELECT e.*, r.name as role_name, r.mobile_access_type as role_mobile_access_type
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
                    message: 'Tu periodo de prueba ha finalizado.',
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
                    canUseMobileApp: employee.can_use_mobile_app,
                    is_owner: employee.is_owner === true
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const refreshToken = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    is_owner: employee.is_owner === true
                },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            // Prioridad: owner siempre admin > employee override > role default
            let resolvedAccessType;
            if (employee.is_owner) {
                resolvedAccessType = 'admin';
            } else {
                resolvedAccessType = (employee.mobile_access_type && employee.mobile_access_type !== 'none')
                    ? employee.mobile_access_type
                    : (employee.role_mobile_access_type || 'none');
            }

            // Resolve mobile_access_types: new plural field takes priority, fallback to singular
            const resolvedAccessTypes = employee.is_owner
                ? 'admin'
                : (employee.mobile_access_types || (resolvedAccessType !== 'none' ? resolvedAccessType : null));

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
                mobileAccessType: resolvedAccessType,
                mobileAccessTypes: resolvedAccessTypes,
                createdAt: employee.created_at
            };

            console.log(`[Mobile Login] 📱 Tipo de acceso móvil: ${resolvedAccessType} (employee=${employee.mobile_access_type || 'none'}, role=${employee.role_mobile_access_type || 'none'}, roleId=${employee.role_id}) para ${employee.email}`);

            const branchesData = branches.map(branch => ({
                id: branch.id,
                name: branch.name,
                address: branch.address,
                phone: branch.phone || null,
                rfc: branch.rfc || null,
                logo_url: branch.logo_url || null,
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

                    // 2. Socket emit removed — replaced by force_takeover mutual exclusion system

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

            // ═══════════════════════════════════════════════════════════════
            // MUTUAL EXCLUSION: Check for active session on another device
            // ═══════════════════════════════════════════════════════════════
            let activeSessionConflict = null;
            try {
                console.log(`[Mobile Login] 🔍 Checking session conflict for employee ${employee.id}...`);
                const mobileTerminalId = req.body.terminalId || null;
                activeSessionConflict = await checkSessionConflict(employee.id, this.pool, mobileTerminalId);
                console.log(`[Mobile Login] 🔍 Conflict result:`, JSON.stringify(activeSessionConflict));
            } catch (conflictErr) {
                console.error('[Mobile Login] Error checking session conflict:', conflictErr.message, conflictErr.stack);
            }

            console.log(`[Mobile Login] ✅ Login exitoso: ${employee.email} (can_use_mobile_app=true)`);

            return res.json({
                success: true,
                message: 'Login exitoso',
                data: {
                    token,
                    refreshToken,
                    activeSessionConflict,
                    employee: employeeData,
                    availableBranches: branchesData,
                    selectedBranch: selectedBranch,
                    tenant: {
                        id: tenant.id,
                        name: tenant.name,
                        businessName: tenant.business_name,
                        logoUrl: tenant.logo_url || null,
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
                message: 'Error del servidor'
            });
        }
    },

    // ═══════════════════════════════════════════════════════════════
    // PIN LOGIN — kiosk-style auth for bubble profile picker
    // Mirrors desktopLogin's response envelope exactly (DRY follow-up tracked).
    // Per-employee lockout: 5 failed attempts → 5-minute lock.
    // ═══════════════════════════════════════════════════════════════
    async pinLogin(req, res) {
        const MAX_ATTEMPTS = 5;
        const LOCK_MINUTES = 5;

        const { tenantCode, branchId, employeeId, pin } = req.body || {};

        if (!pin || typeof pin !== 'string' || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
            return res.status(400).json({ success: false, code: 'INVALID_PIN_FORMAT', message: 'PIN debe ser 4-6 dígitos numéricos' });
        }
        if (!tenantCode || !branchId || !employeeId) {
            return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'tenantCode, branchId y employeeId son requeridos' });
        }

        try {
            // Resolve tenant
            const tenantLookup = await this.pool.query(
                'SELECT id FROM tenants WHERE tenant_code = $1 AND is_active = true',
                [tenantCode]
            );
            if (tenantLookup.rows.length === 0) {
                return res.status(404).json({ success: false, code: 'TENANT_NOT_FOUND', message: 'Tenant no encontrado' });
            }
            const tenantId = tenantLookup.rows[0].id;

            // Resolve employee
            const empResult = await this.pool.query(
                `SELECT * FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
                [employeeId, tenantId]
            );
            if (empResult.rows.length === 0 || !empResult.rows[0].pin_hash) {
                return res.status(404).json({ success: false, code: 'PIN_NOT_SET', message: 'Este empleado no tiene PIN configurado' });
            }
            const employee = empResult.rows[0];

            // Lockout pre-check
            const lockRes = await this.pool.query(
                `SELECT failed_attempts, locked_until FROM employee_pin_lockouts
                 WHERE tenant_id = $1 AND employee_id = $2`,
                [tenantId, employeeId]
            );
            if (lockRes.rows.length && lockRes.rows[0].locked_until && new Date(lockRes.rows[0].locked_until).getTime() > Date.now()) {
                const retryAfterSeconds = Math.ceil((new Date(lockRes.rows[0].locked_until).getTime() - Date.now()) / 1000);
                console.log(`[PIN Login] 🔒 Empleado ${employeeId} bloqueado por ${retryAfterSeconds}s`);
                return res.status(423).json({ success: false, code: 'PIN_LOCKED', retryAfterSeconds, message: 'Demasiados intentos fallidos. Espera antes de reintentar.' });
            }

            // Verify PIN
            let validPin = false;
            try {
                validPin = await bcrypt.compare(pin, employee.pin_hash);
            } catch (bcryptError) {
                console.error('[PIN Login] Error en verificación de PIN:', bcryptError.message);
                return res.status(500).json({ success: false, message: 'Error en el servidor' });
            }

            if (!validPin) {
                // Atomic increment — prevents lost-update race on concurrent bad PINs.
                const incRes = await this.pool.query(
                    `INSERT INTO employee_pin_lockouts (tenant_id, employee_id, failed_attempts, locked_until, last_attempt_at, updated_at)
                     VALUES ($1, $2, 1, NULL, NOW(), NOW())
                     ON CONFLICT (tenant_id, employee_id)
                     DO UPDATE SET failed_attempts = employee_pin_lockouts.failed_attempts + 1,
                                   last_attempt_at = NOW(),
                                   updated_at = NOW()
                     RETURNING failed_attempts`,
                    [tenantId, employeeId]
                );
                const newAttempts = incRes.rows[0].failed_attempts;
                if (newAttempts >= MAX_ATTEMPTS) {
                    await this.pool.query(
                        `UPDATE employee_pin_lockouts
                         SET locked_until = $3, updated_at = NOW()
                         WHERE tenant_id = $1 AND employee_id = $2`,
                        [tenantId, employeeId, new Date(Date.now() + LOCK_MINUTES * 60_000)]
                    );
                    console.log(`[PIN Login] 🔒 Empleado ${employeeId} bloqueado tras ${newAttempts} intentos`);
                    return res.status(423).json({ success: false, code: 'PIN_LOCKED', retryAfterSeconds: LOCK_MINUTES * 60, message: 'Demasiados intentos fallidos.' });
                }
                console.log(`[PIN Login] ❌ PIN incorrecto para empleado ${employeeId} (intentos=${newAttempts})`);
                return res.status(401).json({ success: false, code: 'INVALID_PIN', remainingAttempts: MAX_ATTEMPTS - newAttempts, message: 'PIN incorrecto' });
            }

            // Success → reset lockout
            await this.pool.query(
                `INSERT INTO employee_pin_lockouts (tenant_id, employee_id, failed_attempts, locked_until, last_attempt_at, updated_at)
                 VALUES ($1, $2, 0, NULL, NOW(), NOW())
                 ON CONFLICT (tenant_id, employee_id)
                 DO UPDATE SET failed_attempts = 0, locked_until = NULL, last_attempt_at = NOW(), updated_at = NOW()`,
                [tenantId, employeeId]
            );

            // Tenant + license (mirror desktopLogin)
            const tenantResult = await this.pool.query(
                `SELECT t.*, s.name as subscription_name
                 FROM tenants t
                 JOIN subscriptions s ON t.subscription_id = s.id
                 WHERE t.id = $1 AND t.is_active = true`,
                [employee.tenant_id]
            );
            if (tenantResult.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Tenant inactivo o no encontrado' });
            }
            const tenant = tenantResult.rows[0];
            const now = new Date();
            const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
            if (trialEndsAt && trialEndsAt < now) {
                const daysExpired = Math.ceil((now - trialEndsAt) / (1000 * 60 * 60 * 24));
                return res.status(403).json({
                    success: false,
                    message: 'Su licencia ha caducado.',
                    error: 'LICENSE_EXPIRED',
                    licenseInfo: { expiresAt: trialEndsAt.toISOString(), daysExpired, businessName: tenant.business_name }
                });
            }
            const daysRemaining = trialEndsAt ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)) : null;

            // Available branches
            const branchesResult = await this.pool.query(`
                SELECT b.*
                FROM branches b
                JOIN employee_branches eb ON b.id = eb.branch_id
                WHERE eb.employee_id = $1 AND b.is_active = true
                ORDER BY b.name
            `, [employee.id]);
            const branches = branchesResult.rows;
            if (branches.length === 0) {
                return res.status(403).json({ success: false, message: 'No tienes acceso a ninguna sucursal' });
            }
            const selectedBranch = branches.find(b => b.id === parseInt(branchId)) || branches[0];

            // Mint JWT (branchId MUST be present; downstream middleware reads it)
            const token = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: selectedBranch.id,
                    roleId: employee.role_id,
                    email: employee.email,
                    is_owner: employee.is_owner === true
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );
            const refreshToken = jwt.sign(
                { employeeId: employee.id, tenantId: employee.tenant_id, is_owner: employee.is_owner === true },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            console.log(`[PIN Login] ✅ Login exitoso por PIN: empleado ${employee.id} → ${selectedBranch.name}`);

            res.json({
                success: true,
                message: 'Login por PIN exitoso',
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
                        isOwner: employee.is_owner === true,
                        mainBranchId: employee.main_branch_id,
                        canUseMobileApp: employee.can_use_mobile_app,
                        globalId: employee.global_id,
                        terminalId: employee.terminal_id,
                        localOpSeq: employee.local_op_seq,
                        createdLocalUtc: employee.created_local_utc,
                        deviceEventRaw: employee.device_event_raw
                    },
                    tenant: {
                        id: tenant.id,
                        businessName: tenant.business_name,
                        tenantCode: tenant.tenant_code,
                        rfc: tenant.rfc,
                        subscription: tenant.subscription_name,
                        license: {
                            expiresAt: trialEndsAt ? trialEndsAt.toISOString() : null,
                            daysRemaining,
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
                    availableBranches: branches.map(b => ({ id: b.id, code: b.branch_code, name: b.name }))
                }
            });

        } catch (error) {
            console.error('[PIN Login] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error en el servidor',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    },

    // ═══════════════════════════════════════════════════════════════
    // EMPLOYEE PASSWORD LOGIN — bubble-flow auth por employeeId + password
    // Resuelve el hueco donde empleados sin email (cajeros) no pueden usar
    // desktop-login (que busca por email). Permite al bubble login obtener
    // JWT+refreshToken del backend tras validar password local.
    // Mirrors pinLogin's response envelope.
    // ═══════════════════════════════════════════════════════════════
    async employeePasswordLogin(req, res) {
        const { tenantCode, branchId, employeeId, employeeGlobalId, password } = req.body || {};

        if (!password || typeof password !== 'string' || password.length < 1) {
            return res.status(400).json({ success: false, code: 'INVALID_PASSWORD_FORMAT', message: 'Password requerido' });
        }
        if (!tenantCode || !branchId || (!employeeId && !employeeGlobalId)) {
            return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'tenantCode, branchId y (employeeId o employeeGlobalId) son requeridos' });
        }

        try {
            const tenantLookup = await this.pool.query(
                'SELECT id FROM tenants WHERE tenant_code = $1 AND is_active = true',
                [tenantCode]
            );
            if (tenantLookup.rows.length === 0) {
                return res.status(404).json({ success: false, code: 'TENANT_NOT_FOUND', message: 'Tenant no encontrado' });
            }
            const tenantId = tenantLookup.rows[0].id;

            // Resolver empleado por global_id (preferido, estable entre BD local y PG)
            // o por id (fallback cuando el desktop aún tiene el remoteId de PG).
            const empQuery = employeeGlobalId
                ? `SELECT * FROM employees WHERE global_id = $1 AND tenant_id = $2 AND is_active = true`
                : `SELECT * FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = true`;
            const empParam = employeeGlobalId || employeeId;
            const empResult = await this.pool.query(empQuery, [empParam, tenantId]);

            if (empResult.rows.length === 0) {
                return res.status(404).json({ success: false, code: 'EMPLOYEE_NOT_FOUND', message: 'Empleado no encontrado' });
            }
            const employee = empResult.rows[0];

            if (!employee.password_hash) {
                return res.status(401).json({ success: false, code: 'PASSWORD_NOT_SET', message: 'Este empleado no tiene contraseña configurada' });
            }

            let validPassword = false;
            try {
                validPassword = await bcrypt.compare(password, employee.password_hash);
            } catch (bcryptError) {
                console.error('[Employee Password Login] Error bcrypt:', bcryptError.message);
                return res.status(500).json({ success: false, message: 'Error en el servidor' });
            }

            if (!validPassword) {
                console.log(`[Employee Password Login] ❌ Password incorrecta para empleado ${employeeId}`);
                return res.status(401).json({ success: false, code: 'INVALID_PASSWORD', message: 'Credenciales inválidas' });
            }

            // Tenant + license
            const tenantResult = await this.pool.query(
                `SELECT t.*, s.name as subscription_name
                 FROM tenants t
                 JOIN subscriptions s ON t.subscription_id = s.id
                 WHERE t.id = $1 AND t.is_active = true`,
                [employee.tenant_id]
            );
            if (tenantResult.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Tenant inactivo o no encontrado' });
            }
            const tenant = tenantResult.rows[0];
            const now = new Date();
            const trialEndsAt = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
            if (trialEndsAt && trialEndsAt < now) {
                const daysExpired = Math.ceil((now - trialEndsAt) / (1000 * 60 * 60 * 24));
                return res.status(403).json({
                    success: false,
                    message: 'Su licencia ha caducado.',
                    error: 'LICENSE_EXPIRED',
                    licenseInfo: { expiresAt: trialEndsAt.toISOString(), daysExpired, businessName: tenant.business_name }
                });
            }
            const daysRemaining = trialEndsAt ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)) : null;

            const branchesResult = await this.pool.query(`
                SELECT b.*
                FROM branches b
                JOIN employee_branches eb ON b.id = eb.branch_id
                WHERE eb.employee_id = $1 AND b.is_active = true
                ORDER BY b.name
            `, [employee.id]);
            const branches = branchesResult.rows;
            if (branches.length === 0) {
                return res.status(403).json({ success: false, message: 'No tienes acceso a ninguna sucursal' });
            }
            const selectedBranch = branches.find(b => b.id === parseInt(branchId)) || branches[0];

            const token = jwt.sign(
                {
                    employeeId: employee.id,
                    tenantId: employee.tenant_id,
                    branchId: selectedBranch.id,
                    roleId: employee.role_id,
                    email: employee.email,
                    is_owner: employee.is_owner === true
                },
                JWT_SECRET,
                { expiresIn: '15m' }
            );
            const refreshToken = jwt.sign(
                { employeeId: employee.id, tenantId: employee.tenant_id, is_owner: employee.is_owner === true },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            console.log(`[Employee Password Login] ✅ Login exitoso: empleado ${employee.id} (${employee.email || employee.username || 'sin email'}) → ${selectedBranch.name}`);

            res.json({
                success: true,
                message: 'Login por empleado+password exitoso',
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
                        isOwner: employee.is_owner === true,
                        mainBranchId: employee.main_branch_id,
                        canUseMobileApp: employee.can_use_mobile_app,
                        globalId: employee.global_id,
                        terminalId: employee.terminal_id
                    },
                    tenant: {
                        id: tenant.id,
                        businessName: tenant.business_name,
                        tenantCode: tenant.tenant_code,
                        rfc: tenant.rfc,
                        subscription: tenant.subscription_name,
                        license: {
                            expiresAt: trialEndsAt ? trialEndsAt.toISOString() : null,
                            daysRemaining,
                            status: daysRemaining === null ? 'unlimited' : (daysRemaining <= 7 ? 'expiring_soon' : 'active')
                        }
                    },
                    branch: {
                        id: selectedBranch.id,
                        code: selectedBranch.branch_code,
                        name: selectedBranch.name
                    }
                }
            });

        } catch (error) {
            console.error('[Employee Password Login] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error en el servidor',
                ...(process.env.NODE_ENV !== 'production' && { error: error.message })
            });
        }
    }

};

// ═══════════════════════════════════════════════════════════════
// SESSION CONFLICT DETECTION
// Used by: GET /api/auth/session-conflict (Desktop)
//          POST /api/auth/mobile-login (embedded in response)
// Exported separately — utility function, not an HTTP handler.
// ═══════════════════════════════════════════════════════════════
async function checkSessionConflict(employeeId, pool, callerTerminalId) {

    console.log(`[SessionConflict] Checking employee ${employeeId} (callerTerminal: ${callerTerminalId || 'unknown'})`);

    // 1. Check DB for open shift — this is the SOURCE OF TRUTH for conflict.
    //    Just being connected to Socket.IO (e.g. on Dashboard) is NOT a conflict.
    const shiftResult = await pool.query(
        `SELECT s.id, s.start_time, s.terminal_id, s.branch_id, b.name as branch_name
         FROM shifts s
         LEFT JOIN branches b ON b.id = s.branch_id
         WHERE s.employee_id = $1 AND s.is_cash_cut_open = true
         ORDER BY s.start_time DESC
         LIMIT 1`,
        [employeeId]
    );

    console.log(`[SessionConflict] DB shift query: ${shiftResult.rows.length} rows found`, shiftResult.rows.length > 0 ? JSON.stringify(shiftResult.rows[0]) : '');

    if (shiftResult.rows.length === 0) {
        console.log(`[SessionConflict] No open shift — no conflict`);
        return null;
    }

    const shift = shiftResult.rows[0];
    const shiftTerminalId = shift.terminal_id || '';

    // If this device owns the shift → no conflict
    if (callerTerminalId && shiftTerminalId === callerTerminalId) {
        console.log(`[SessionConflict] Shift terminal matches caller (${callerTerminalId}) — no conflict`);
        return null;
    }

    // Only enforce mutual exclusion when multi_caja_enabled is true for this branch
    try {
        const branchResult = await pool.query(
            'SELECT multi_caja_enabled FROM branches WHERE id = $1',
            [shift.branch_id]
        );
        const multiCaja = branchResult.rows[0]?.multi_caja_enabled ?? false;
        if (!multiCaja) {
            console.log(`[SessionConflict] multi_caja_enabled=false for branch ${shift.branch_id} — skipping conflict`);
            return null;
        }
    } catch (brErr) {
        // Column might not exist yet (pre-migration) — skip conflict check
        console.log(`[SessionConflict] Could not check multi_caja_enabled: ${brErr.message} — skipping conflict`);
        return null;
    }

    // Different terminal → conflict. Determine device type by checking branch_devices table.
    // Flutter devices may not be in branch_devices, so default to 'mobile' if not found.
    let shiftDeviceType = 'mobile'; // default: if device not registered, it's likely Flutter/mobile
    try {
        const deviceResult = await pool.query(
            `SELECT device_type FROM branch_devices WHERE device_id = $1 LIMIT 1`,
            [shiftTerminalId]
        );
        if (deviceResult.rows.length > 0 && deviceResult.rows[0].device_type) {
            shiftDeviceType = deviceResult.rows[0].device_type; // 'desktop', 'tablet', or 'mobile'
        }
    } catch (devErr) {
        console.log(`[SessionConflict] Could not query branch_devices: ${devErr.message} — defaulting to mobile`);
    }

    console.log(`[SessionConflict] Conflict! Shift terminal=${shiftTerminalId}, caller terminal=${callerTerminalId}. Shift device: ${shiftDeviceType}`);

    return {
        hasConflict: true,
        otherDeviceType: shiftDeviceType,
        otherDeviceOnline: true, // We can't reliably determine this from HTTP — assume online
        shiftBranchId: shift.branch_id,
        shiftBranchName: shift.branch_name,
        shiftStartTime: shift.start_time
    };
}

module.exports.checkSessionConflict = checkSessionConflict;
