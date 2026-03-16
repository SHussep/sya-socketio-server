// ═══════════════════════════════════════════════════════════════
// NOTIFICATION HELPER
// Envía notificaciones FCM basadas en eventos del backend
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const { sendNotificationToMultipleDevices } = require('./firebaseAdmin');
const { pool } = require('../database');

// ═══════════════════════════════════════════════════════════════
// MAPEO DE COLUMNAS LEGACY → GRUPO
// ═══════════════════════════════════════════════════════════════

const LEGACY_TO_GROUP = {
    'notify_login': 'notify_turnos',
    'notify_shift_start': 'notify_turnos',
    'notify_shift_end': 'notify_turnos',
    'notify_expense_created': 'notify_gastos',
    'notify_assignment_created': 'notify_repartidores',
    'notify_guardian_peso_no_registrado': 'notify_guardian',
    'notify_guardian_operacion_irregular': 'notify_guardian',
    'notify_guardian_discrepancia': 'notify_guardian',
};

// ═══════════════════════════════════════════════════════════════
// PREFERENCIAS DE NOTIFICACIONES
// ═══════════════════════════════════════════════════════════════

/**
 * Obtiene las preferencias de notificación de un empleado
 * @param {number} employeeId - ID numérico del empleado
 * @returns {Object} Preferencias del empleado o valores por defecto
 */
async function getNotificationPreferences(employeeId) {
    const defaults = {
        // Group columns (new system)
        notify_turnos: true,
        notify_ventas: true,
        notify_gastos: true,
        notify_repartidores: true,
        notify_guardian: true,
        // Legacy columns (backward compatibility)
        notify_login: true,
        notify_shift_start: true,
        notify_shift_end: true,
        notify_expense_created: true,
        notify_assignment_created: true,
        notify_guardian_peso_no_registrado: true,
        notify_guardian_operacion_irregular: true,
        notify_guardian_discrepancia: true
    };

    try {
        const result = await pool.query(
            `SELECT * FROM notification_preferences WHERE employee_id = $1`,
            [employeeId]
        );

        if (result.rows.length === 0) {
            return defaults;
        }

        return { ...defaults, ...result.rows[0] };
    } catch (error) {
        // Si la tabla no existe o hay error, retornar defaults
        console.error('[NotificationHelper] ⚠️ Error obteniendo preferencias:', error.message);
        return defaults;
    }
}

/**
 * Filtra dispositivos según preferencias de notificación
 * @param {Array} deviceTokensWithEmployeeId - Array de {device_token, employee_id}
 * @param {string} notificationType - Tipo de notificación (notify_login, notify_shift_start, etc.)
 * @returns {Array} Dispositivos filtrados que quieren recibir esta notificación
 */
async function filterDevicesByPreferences(deviceTokensWithEmployeeId, notificationType) {
    const filteredTokens = [];
    // Resolve legacy column names to group columns
    const groupColumn = LEGACY_TO_GROUP[notificationType] || notificationType;

    for (const device of deviceTokensWithEmployeeId) {
        const prefs = await getNotificationPreferences(device.employee_id);

        // Check group column (new system takes precedence)
        if (prefs[groupColumn] !== false) {
            filteredTokens.push(device.device_token);
        } else {
            console.log(`[NotificationHelper] Empleado ${device.employee_id} no quiere ${groupColumn}`);
        }
    }

    return filteredTokens;
}

/**
 * Helper interno para guardar notificación en la tabla de historial (campana)
 * Excluye: guardian (tiene su propia página)
 */
async function saveToNotificationHistory({ tenant_id, branch_id, employee_id, category, event_type, title, body, data }) {
    try {
        // Excluir eventos de Guardian (tienen su propia página)
        if (category === 'guardian') return null;

        await pool.query(
            `INSERT INTO notifications (tenant_id, branch_id, employee_id, category, event_type, title, body, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [tenant_id, branch_id, employee_id, category, event_type, title, body, data ? JSON.stringify(data) : null]
        );
    } catch (error) {
        // No fallar si no se puede guardar, solo loguear
        console.error('[NotificationHelper] ⚠️ Error guardando en historial:', error.message);
    }
}

/**
 * Envía notificación a todos los dispositivos de una sucursal
 */
async function sendNotificationToBranch(branchId, { title, body, data = {} }) {
    try {
        // Obtener todos los dispositivos activos de la sucursal
        const result = await pool.query(
            `SELECT DISTINCT device_token FROM device_tokens
             WHERE branch_id = $1 AND is_active = true`,
            [branchId]
        );

        const deviceTokens = result.rows.map(row => row.device_token);

        if (deviceTokens.length === 0) {
            console.log(`[NotificationHelper] ℹ️ No hay dispositivos activos en la sucursal ${branchId}`);
            return { sent: 0, failed: 0 };
        }

        const results = await sendNotificationToMultipleDevices(deviceTokens, {
            title,
            body,
            data
        });

        const successCount = results.filter(r => r.success).length;
        const invalidTokens = results
            .filter(r => r.result === 'INVALID_TOKEN')
            .map(r => r.deviceToken);

        console.log(`[NotificationHelper] ✅ Notificaciones enviadas a sucursal ${branchId}: ${successCount}/${deviceTokens.length}`);

        // Desactivar tokens inválidos
        if (invalidTokens.length > 0) {
            try {
                await pool.query(
                    `UPDATE device_tokens SET is_active = false
                     WHERE device_token = ANY($1)`,
                    [invalidTokens]
                );
                console.log(`[NotificationHelper] 🧹 Deactivated ${invalidTokens.length} invalid tokens from branch ${branchId}`);
            } catch (updateError) {
                console.error(`[NotificationHelper] ⚠️ Error updating invalid tokens:`, updateError.message);
            }
        }

        return {
            sent: successCount,
            failed: deviceTokens.length - successCount,
            total: deviceTokens.length,
            invalidTokensRemoved: invalidTokens.length
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error enviando notificaciones:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación SOLO a administradores y encargados de una sucursal
 * Útil para eventos que solo los supervisores deben ver (login, alertas, etc.)
 * @param {number} branchId - ID de la sucursal
 * @param {object} notification - { title, body, data }
 * @param {object} options - { excludeEmployeeGlobalId: string, notificationType: string } - Opciones de filtrado
 */
async function sendNotificationToAdminsInBranch(branchId, { title, body, data = {} }, options = {}) {
    try {
        const { excludeEmployeeGlobalId, notificationType } = options;

        // Obtener ID numérico del empleado a excluir (si se especificó)
        let excludeEmployeeId = null;
        if (excludeEmployeeGlobalId) {
            const excludeResult = await pool.query(
                `SELECT id FROM employees WHERE global_id = $1 LIMIT 1`,
                [excludeEmployeeGlobalId]
            );
            if (excludeResult.rows.length > 0) {
                excludeEmployeeId = excludeResult.rows[0].id;
                console.log(`[NotificationHelper] 🚫 Excluyendo employee_id ${excludeEmployeeId} (global: ${excludeEmployeeGlobalId}) de notificación a admins`);
            }
        }

        // Obtener dispositivos de empleados con acceso móvil de tipo 'admin'
        // Buscar por mobile_access_type en la tabla roles (NO por nombre de rol)
        // INCLUYENDO employee_id para filtrar por preferencias
        // Excluyendo al empleado que ya recibió notificación personal (si aplica)
        const query = excludeEmployeeId
            ? `SELECT DISTINCT dt.device_token, dt.employee_id
               FROM device_tokens dt
               JOIN employees e ON dt.employee_id = e.id
               JOIN roles r ON e.role_id = r.id
               WHERE dt.branch_id = $1
                 AND dt.is_active = true
                 AND r.mobile_access_type = 'admin'
                 AND e.id != $2`
            : `SELECT DISTINCT dt.device_token, dt.employee_id
               FROM device_tokens dt
               JOIN employees e ON dt.employee_id = e.id
               JOIN roles r ON e.role_id = r.id
               WHERE dt.branch_id = $1
                 AND dt.is_active = true
                 AND r.mobile_access_type = 'admin'`;

        const result = excludeEmployeeId
            ? await pool.query(query, [branchId, excludeEmployeeId])
            : await pool.query(query, [branchId]);

        // Filtrar según preferencias de notificación (si se especificó tipo)
        let deviceTokens;
        if (notificationType) {
            deviceTokens = await filterDevicesByPreferences(result.rows, notificationType);
        } else {
            deviceTokens = result.rows.map(row => row.device_token);
        }

        // 🔍 DEBUG: Log cantidad de admins encontrados
        console.log(`[NotificationHelper] 👥 Admins/Encargados en sucursal ${branchId}: ${deviceTokens.length} dispositivo(s)${excludeEmployeeId ? ` (excluyendo employee ${excludeEmployeeId})` : ''}`);

        if (deviceTokens.length === 0) {
            console.log(`[NotificationHelper] ℹ️ No hay administradores/encargados con dispositivos activos en sucursal ${branchId}`);
            return { sent: 0, failed: 0 };
        }

        const results = await sendNotificationToMultipleDevices(deviceTokens, {
            title,
            body,
            data
        });

        const successCount = results.filter(r => r.success).length;
        const invalidTokens = results
            .filter(r => r.result === 'INVALID_TOKEN')
            .map(r => r.deviceToken);

        console.log(`[NotificationHelper] ✅ Notificaciones enviadas a admins/encargados de sucursal ${branchId}: ${successCount}/${deviceTokens.length}`);

        // Desactivar tokens inválidos
        if (invalidTokens.length > 0) {
            try {
                await pool.query(
                    `UPDATE device_tokens SET is_active = false
                     WHERE device_token = ANY($1)`,
                    [invalidTokens]
                );
                console.log(`[NotificationHelper] 🧹 Deactivated ${invalidTokens.length} invalid tokens from branch ${branchId}`);
            } catch (updateError) {
                console.error(`[NotificationHelper] ⚠️ Error updating invalid tokens:`, updateError.message);
            }
        }

        return {
            sent: successCount,
            failed: deviceTokens.length - successCount,
            total: deviceTokens.length,
            invalidTokensRemoved: invalidTokens.length
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error enviando notificaciones a admins:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación a TODOS los administradores y encargados de un TENANT (todas las sucursales)
 * Útil para eventos críticos que deben notificar a todos los supervisores del negocio
 * @param {number} tenantId - ID del tenant
 * @param {object} notification - { title, body, data }
 * @param {object} options - { excludeEmployeeGlobalId: string, notificationType: string }
 */
async function sendNotificationToAdminsInTenant(tenantId, { title, body, data = {} }, options = {}) {
    try {
        const { excludeEmployeeGlobalId, notificationType } = options;

        // Obtener ID numérico del empleado a excluir (si se especificó)
        let excludeEmployeeId = null;
        if (excludeEmployeeGlobalId) {
            const excludeResult = await pool.query(
                `SELECT id FROM employees WHERE global_id = $1 LIMIT 1`,
                [excludeEmployeeGlobalId]
            );
            if (excludeResult.rows.length > 0) {
                excludeEmployeeId = excludeResult.rows[0].id;
                console.log(`[NotificationHelper] 🚫 Excluyendo employee_id ${excludeEmployeeId} de notificación a admins del tenant`);
            }
        }

        // Obtener dispositivos de empleados con acceso móvil de tipo 'admin'
        // Buscar por mobile_access_type en la tabla roles (NO por nombre de rol)
        // Filtrar por TENANT (todas las sucursales del negocio)
        const query = excludeEmployeeId
            ? `SELECT DISTINCT dt.device_token, dt.employee_id, b.name as branch_name
               FROM device_tokens dt
               JOIN employees e ON dt.employee_id = e.id
               JOIN roles r ON e.role_id = r.id
               JOIN branches b ON dt.branch_id = b.id
               WHERE b.tenant_id = $1
                 AND dt.is_active = true
                 AND r.mobile_access_type = 'admin'
                 AND e.id != $2`
            : `SELECT DISTINCT dt.device_token, dt.employee_id, b.name as branch_name
               FROM device_tokens dt
               JOIN employees e ON dt.employee_id = e.id
               JOIN roles r ON e.role_id = r.id
               JOIN branches b ON dt.branch_id = b.id
               WHERE b.tenant_id = $1
                 AND dt.is_active = true
                 AND r.mobile_access_type = 'admin'`;

        const result = excludeEmployeeId
            ? await pool.query(query, [tenantId, excludeEmployeeId])
            : await pool.query(query, [tenantId]);

        // Filtrar según preferencias de notificación (si se especificó tipo)
        let deviceTokens;
        if (notificationType) {
            deviceTokens = await filterDevicesByPreferences(result.rows, notificationType);
        } else {
            deviceTokens = result.rows.map(row => row.device_token);
        }

        // 🔍 DEBUG: Log cantidad de admins encontrados
        console.log(`[NotificationHelper] 👥 Admins/Encargados en tenant ${tenantId}: ${deviceTokens.length} dispositivo(s)${excludeEmployeeId ? ` (excluyendo employee ${excludeEmployeeId})` : ''}`);

        if (deviceTokens.length === 0) {
            console.log(`[NotificationHelper] ℹ️ No hay administradores/encargados con dispositivos activos en tenant ${tenantId}`);
            return { sent: 0, failed: 0, total: 0 };
        }

        const results = await sendNotificationToMultipleDevices(deviceTokens, {
            title,
            body,
            data
        });

        const successCount = results.filter(r => r.success).length;
        const invalidTokens = results
            .filter(r => r.result === 'INVALID_TOKEN')
            .map(r => r.deviceToken);

        console.log(`[NotificationHelper] ✅ Notificaciones enviadas a admins/encargados del tenant ${tenantId}: ${successCount}/${deviceTokens.length}`);

        // Desactivar tokens inválidos
        if (invalidTokens.length > 0) {
            try {
                await pool.query(
                    `UPDATE device_tokens SET is_active = false
                     WHERE device_token = ANY($1)`,
                    [invalidTokens]
                );
                console.log(`[NotificationHelper] 🧹 Deactivated ${invalidTokens.length} invalid tokens from tenant ${tenantId}`);
            } catch (updateError) {
                console.error(`[NotificationHelper] ⚠️ Error updating invalid tokens:`, updateError.message);
            }
        }

        return {
            sent: successCount,
            failed: deviceTokens.length - successCount,
            total: deviceTokens.length,
            invalidTokensRemoved: invalidTokens.length
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error enviando notificaciones a admins del tenant:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación a un empleado específico
 * @param {string} employeeId - GlobalId (UUID) del empleado para idempotencia
 */
async function sendNotificationToEmployee(employeeId, { title, body, data = {} }) {
    try {
        // IMPORTANTE: employeeId es el GlobalId (UUID), no el autoincrement ID
        // Obtener el ID numérico del empleado desde PostgreSQL usando global_id
        const employeeResult = await pool.query(
            `SELECT id FROM employees WHERE global_id = $1 LIMIT 1`,
            [employeeId]
        );

        if (employeeResult.rows.length === 0) {
            console.log(`[NotificationHelper] ⚠️ No se encontró empleado con global_id: ${employeeId}`);
            return { sent: 0, failed: 0 };
        }

        const employeeIdNumeric = employeeResult.rows[0].id;

        // Obtener todos los dispositivos activos del empleado
        const result = await pool.query(
            `SELECT DISTINCT device_token FROM device_tokens
             WHERE employee_id = $1 AND is_active = true`,
            [employeeIdNumeric]
        );

        const deviceTokens = result.rows.map(row => row.device_token);

        if (deviceTokens.length === 0) {
            console.log(`[NotificationHelper] ℹ️ No hay dispositivos activos para employee ${employeeId}`);
            return { sent: 0, failed: 0 };
        }

        // 🔍 DEBUG: Log cantidad de tokens para detectar duplicados
        console.log(`[NotificationHelper] 📱 Employee ${employeeIdNumeric} (global_id: ${employeeId}) tiene ${deviceTokens.length} dispositivo(s) activo(s)`);
        if (deviceTokens.length > 1) {
            console.log(`[NotificationHelper] ⚠️ ADVERTENCIA: Employee ${employeeIdNumeric} tiene MÚLTIPLES dispositivos activos - se enviarán ${deviceTokens.length} notificaciones`);
        }

        const results = await sendNotificationToMultipleDevices(deviceTokens, {
            title,
            body,
            data
        });

        const successCount = results.filter(r => r.success).length;
        const invalidTokens = results
            .filter(r => r.result === 'INVALID_TOKEN')
            .map(r => r.deviceToken);

        console.log(`[NotificationHelper] ✅ Notificaciones enviadas a employee ${employeeIdNumeric} (global_id: ${employeeId}): ${successCount}/${deviceTokens.length}`);

        // Desactivar tokens inválidos
        if (invalidTokens.length > 0) {
            try {
                await pool.query(
                    `UPDATE device_tokens SET is_active = false
                     WHERE device_token = ANY($1)`,
                    [invalidTokens]
                );
                console.log(`[NotificationHelper] 🧹 Deactivated ${invalidTokens.length} invalid tokens from employee ${employeeId}`);
            } catch (updateError) {
                console.error(`[NotificationHelper] ⚠️ Error updating invalid tokens:`, updateError.message);
            }
        }

        return {
            sent: successCount,
            failed: deviceTokens.length - successCount,
            total: deviceTokens.length,
            invalidTokensRemoved: invalidTokens.length
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error enviando notificaciones:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando un usuario inicia sesión
 * A: Administradores y encargados (role_id 1,2) EXCEPTO el que hizo login + el empleado que hizo login
 */
async function notifyUserLogin(branchId, { employeeId, employeeName, branchName, scaleStatus, isReviewMode }) {
    try {
        // NO enviar push FCM para user-login.
        // El evento shift_started ya notifica la accion relevante (apertura de turno).
        // user-login solo se guarda en historial para auditoria.
        const employeeResult = await pool.query(
            `SELECT id FROM employees WHERE global_id = $1 LIMIT 1`,
            [employeeId]
        );
        const employeeIdNumeric = employeeResult.rows[0]?.id;

        // Guardar en historial de notificaciones (campana) - solo auditoria
        const tenantResult = await pool.query('SELECT tenant_id FROM branches WHERE id = $1', [branchId]);
        const tenantId = tenantResult.rows[0]?.tenant_id;
        if (tenantId) {
            await saveToNotificationHistory({
                tenant_id: tenantId,
                branch_id: branchId,
                employee_id: employeeIdNumeric,
                category: 'login',
                event_type: 'user_login',
                title: 'Inicio de Sesion',
                body: isReviewMode
                    ? `${employeeName} inicio sesion en ${branchName} (modo consulta)`
                    : `${employeeName} inicio sesion en ${branchName}`,
                data: { employeeName, branchName, scaleStatus, isReviewMode }
            });
        }

        console.log(`[NotificationHelper] Login de ${employeeName} registrado en historial (sin push FCM)`);
        return { self: { sent: 0 }, others: { sent: 0 }, total: 0 };
    } catch (error) {
        console.error('[NotificationHelper] Error en notifyUserLogin:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Mapea el título del evento (eventType) a la categoría simple del Guardian
 * Basado en GuardianScenarioCatalog.cs
 */
function getGuardianSimpleCategory(eventType) {
    // Normalizar para comparación
    const et = (eventType || '').toLowerCase();

    // 🔴 PesoNoRegistrado - Se pesó producto pero no se cobró
    const pesoNoRegistrado = [
        'peso no cobrado', 'peso sin registro', 'pesosinregistro',
        'múltiples pesos sin cobrar', 'multiplespesossinregistro',
        'retiro parcial sin cobrar', 'pesoparcialsinregistro',
        'peso fuera de ventas', 'pesoenpantallanoautorizada',
        'salió de ventas con peso', 'cambiopantalladurantepesaje',
        'peso sin sesión', 'sesionnoiniciadaconpeso',
        'pesaje abandonado', 'pesosinconfirmacionfinal',
        'producto pesado eliminado', 'productopesadoeliminado',
        'pesaje cancelado', 'dialogocanceladoconpeso',
        'actividad fuera de horario', 'actividadfuerahorario'
    ];

    // 🟠 Discrepancia - El peso cobrado no coincide con lo detectado
    const discrepancia = [
        'peso cobrado diferente al pesado', 'pesorealvsregistrado',
        'cobró $0 con producto en báscula', 'pesoceroconpesoenbascula',
        'peso muy bajo para el producto', 'pesoinferiorpromedioproducto',
        'inventario no cuadra', 'discrepanciainventariocierre',
        'peso no corresponde al producto', 'correlacionpesoproductoincorrecta'
    ];

    // 🟡 OperacionIrregular - Todo lo demás (cancelaciones, tiempos, desconexiones, etc.)
    // No necesitamos listar explícitamente porque es el default

    for (const keyword of pesoNoRegistrado) {
        if (et.includes(keyword)) return 'peso_no_registrado';
    }

    for (const keyword of discrepancia) {
        if (et.includes(keyword)) return 'discrepancia';
    }

    // Default: operación irregular
    return 'operacion_irregular';
}

/**
 * Envía notificación cuando hay una alerta de báscula (Guardian)
 * Solo notifica a administradores y encargados (role_id 1, 2)
 * Filtra según preferencias: notify_guardian_peso_no_registrado,
 *   notify_guardian_operacion_irregular, notify_guardian_discrepancia
 */
async function notifyScaleAlert(branchId, { severity, eventType, details, employeeName, simpleCategory }) {
    const severityText = severity === 'high' ? 'ALTA' : severity === 'medium' ? 'MEDIA' : 'BAJA';

    // Si no viene simpleCategory del frontend, determinarla a partir del eventType
    const resolvedCategory = simpleCategory || getGuardianSimpleCategory(eventType);

    // Todas las alertas de Guardian usan el mismo grupo de preferencias
    const notificationType = 'notify_guardian';

    console.log(`[NotificationHelper] 🎯 Guardian Alert: ${eventType} → categoría: ${resolvedCategory}`);

    return await sendNotificationToAdminsInBranch(branchId, {
        title: `Alerta de Báscula [${severityText}]`,
        body: `${eventType}: ${details} (${employeeName})`,
        data: {
            type: 'scale_alert',
            severity,
            eventType,
            employeeName,
            details,
            simpleCategory: resolvedCategory
        }
    }, notificationType ? { notificationType } : {});
}

/**
 * Envía notificación cuando se completa una venta
 */
async function notifySaleCompleted(branchId, { ticketNumber, total, paymentMethod, employeeName }) {
    return await sendNotificationToBranch(branchId, {
        title: 'Venta Completada',
        body: `Ticket #${ticketNumber} - $${total.toFixed(2)} (${paymentMethod})`,
        data: {
            type: 'sale_completed',
            ticketNumber: ticketNumber.toString(),
            total: total.toString(),
            paymentMethod,
            employeeName
        }
    });
}

/**
 * Envía notificación cuando se inicia un turno
 * Solo notifica a administradores y encargados (role_id 1, 2)
 */
async function notifyShiftStarted(branchId, { employeeName, branchName, initialAmount, startTime }) {
    return await sendNotificationToAdminsInBranch(branchId, {
        title: 'Turno Iniciado',
        body: `${employeeName} inició turno en ${branchName} con $${initialAmount.toFixed(2)}`,
        data: {
            type: 'shift_started',
            employeeName,
            branchName,
            initialAmount: initialAmount.toString()
        }
    }, { notificationType: 'notify_turnos' });
}

/**
 * Envía notificación cuando termina un turno
 * @param {number} branchId - ID de la sucursal
 * @param {string} employeeGlobalId - UUID del empleado (para notificación personalizada)
 * @param {object} params - Datos del cierre: employeeName, branchName, difference, countedCash, expectedCash
 */
async function notifyShiftEnded(branchId, employeeGlobalId, { employeeName, branchName, difference, countedCash, expectedCash }) {
    const icon = difference >= 0 ? '💰' : '⚠️';
    const status = difference === 0
        ? 'Sin diferencia'
        : difference > 0
            ? `Sobrante: $${difference.toFixed(2)}`
            : `Faltante: $${Math.abs(difference).toFixed(2)}`;

    try {
        // 1️⃣ Enviar notificación PERSONALIZADA al empleado que cerró su turno
        const employeeResult = await sendNotificationToEmployee(employeeGlobalId, {
            title: '✅ Tu Corte de Caja',
            body: `Turno finalizado - ${status} | Efectivo contado: $${countedCash.toFixed(2)}`,
            data: {
                type: 'shift_ended_self',
                employeeName,
                branchName,
                difference: difference.toString(),
                countedCash: countedCash.toString(),
                expectedCash: expectedCash.toString(),
                status
            }
        });

        console.log(`[NotificationHelper] ✅ Notificación de cierre enviada al empleado ${employeeName} (global_id: ${employeeGlobalId}): ${employeeResult.sent}/${employeeResult.total || employeeResult.sent}`);

        // 2️⃣ Enviar notificación a ADMINISTRADORES/ENCARGADOS de la sucursal
        // EXCLUIR al empleado que ya recibió su notificación personal (evita duplicados)
        const adminResult = await sendNotificationToAdminsInBranch(branchId, {
            title: `${icon} Corte de Caja`,
            body: `${employeeName} finalizó turno - ${status}`,
            data: {
                type: 'shift_ended',
                employeeName,
                branchName,
                difference: difference.toString(),
                countedCash: countedCash.toString(),
                expectedCash: expectedCash.toString(),
                status
            }
        }, { excludeEmployeeGlobalId: employeeGlobalId, notificationType: 'notify_turnos' });

        console.log(`[NotificationHelper] ✅ Notificaciones de cierre enviadas a admins/encargados de sucursal ${branchId}: ${adminResult.sent}/${adminResult.total || adminResult.sent}`);

        // Guardar en historial de notificaciones (campana)
        const tenantResult = await pool.query('SELECT tenant_id FROM branches WHERE id = $1', [branchId]);
        const tenantId = tenantResult.rows[0]?.tenant_id;
        const empResult = await pool.query('SELECT id FROM employees WHERE global_id = $1', [employeeGlobalId]);
        const employeeIdNumeric = empResult.rows[0]?.id;
        if (tenantId) {
            await saveToNotificationHistory({
                tenant_id: tenantId,
                branch_id: branchId,
                employee_id: employeeIdNumeric,
                category: 'cash_cut',
                event_type: 'shift_ended',
                title: icon + ' Corte de Caja',
                body: `${employeeName} finalizó turno - ${status}`,
                data: { employeeName, branchName, difference, countedCash, expectedCash, status }
            });
        }

        return {
            employee: employeeResult,
            admins: adminResult,
            totalSent: (employeeResult.sent || 0) + (adminResult.sent || 0)
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error enviando notificaciones de cierre de turno:', error.message);
        return { employee: { sent: 0, failed: 0 }, admins: { sent: 0, failed: 0 }, error: error.message };
    }
}

/**
 * Envía notificación cuando la báscula se desconecta
 * Solo notifica a administradores y encargados (no a todos los empleados)
 */
async function notifyScaleDisconnection(branchId, { message }) {
    return await sendNotificationToAdminsInBranch(branchId, {
        title: 'Bascula Desconectada',
        body: message || 'La bascula se ha desconectado',
        data: {
            type: 'scale_disconnected'
        }
    }, { notificationType: 'notify_guardian' });
}

/**
 * Envía notificación cuando la báscula se conecta
 * Solo notifica a administradores y encargados (no a todos los empleados)
 */
async function notifyScaleConnection(branchId, { message }) {
    return await sendNotificationToAdminsInBranch(branchId, {
        title: 'Bascula Conectada',
        body: message || 'La bascula se ha conectado',
        data: {
            type: 'scale_connected'
        }
    }, { notificationType: 'notify_guardian' });
}

/**
 * Envía notificación cuando se registra un gasto para un empleado/repartidor
 * Notifica a:
 * Los administradores y encargados de la sucursal (NO al empleado que lo creó)
 * @param {string} employeeGlobalId - GlobalId (UUID) del empleado/repartidor (se excluye de la notificación)
 * @param {object} params - Datos del gasto
 */
async function notifyExpenseCreated(employeeGlobalId, { expenseId, amount, description, category, branchId, branchName, employeeName }) {
    try {
        console.log(`[NotificationHelper] 💸 Iniciando notificación de gasto de ${employeeName} a admins de sucursal ${branchId}`);

        // Notificar solo a administradores/encargados (excluir al empleado que creó el gasto)
        const adminResult = await sendNotificationToAdminsInBranch(branchId, {
            title: '💸 Gasto Registrado',
            body: `${employeeName} registró $${amount.toFixed(2)} - ${description || category}`,
            data: {
                type: 'expense_created',
                expenseId: expenseId.toString(),
                employeeName,
                amount: amount.toString(),
                description,
                category
            }
        }, { excludeEmployeeGlobalId: employeeGlobalId, notificationType: 'notify_gastos' });

        console.log(`[NotificationHelper] ✅ Notificaciones de gasto enviadas a ADMINS/ENCARGADOS de sucursal ${branchId}: ${adminResult.sent}/${adminResult.total || adminResult.sent} dispositivos`);

        // Guardar en historial de notificaciones (campana)
        const tenantResult = await pool.query('SELECT tenant_id FROM branches WHERE id = $1', [branchId]);
        const tenantId = tenantResult.rows[0]?.tenant_id;
        const empResult = await pool.query('SELECT id FROM employees WHERE global_id = $1', [employeeGlobalId]);
        const employeeIdNumeric = empResult.rows[0]?.id;
        if (tenantId) {
            await saveToNotificationHistory({
                tenant_id: tenantId,
                branch_id: branchId,
                employee_id: employeeIdNumeric,
                category: 'expense',
                event_type: 'expense_created',
                title: '💸 Gasto Registrado',
                body: `${employeeName} registró $${amount.toFixed(2)} - ${description || category}`,
                data: { expenseId, employeeName, amount, description, category }
            });
        }

        return {
            admins: adminResult,
            totalSent: adminResult.sent || 0
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error enviando notificaciones de gasto:', error.message);
        return { admins: { sent: 0, failed: 0 }, error: error.message };
    }
}

/**
 * Envía notificación cuando se crea una asignación para un repartidor
 * Notifica a:
 * 1. El repartidor que recibe la asignación
 * 2. Los administradores y encargados de la sucursal
 * @param {string} employeeGlobalId - GlobalId (UUID) del repartidor
 * @param {object} params - Datos de la asignación
 */
async function notifyAssignmentCreated(employeeGlobalId, { assignmentId, quantity, amount, unitAbbreviation, productName, branchName, branchId, employeeName, createdByName, isConsolidated, itemCount, itemsBreakdown }) {
    // ✅ Formatear mensaje según si es consolidado (múltiples items) o individual
    let repartidorBody, adminBody;
    const unit = unitAbbreviation || 'kg';

    if (isConsolidated && itemCount > 1) {
        // Notificación CONSOLIDADA con desglose de productos
        const breakdownText = itemsBreakdown && itemsBreakdown.length > 0
            ? '\n' + itemsBreakdown.join('\n')
            : '';
        repartidorBody = `Recibiste ${itemCount} producto${itemCount > 1 ? 's' : ''} por $${amount.toFixed(2)} en ${branchName}${breakdownText}`;
        adminBody = `${employeeName} recibió ${itemCount} producto${itemCount > 1 ? 's' : ''} ($${amount.toFixed(2)}) autorizado por ${createdByName}${breakdownText}`;
    } else {
        // Notificación INDIVIDUAL: "Se te asignó 25.00 pz ($750.00) - Salsa Roja"
        const productInfo = productName ? ` - ${productName}` : '';
        repartidorBody = `Se te asignó ${quantity.toFixed(2)} ${unit} ($${amount.toFixed(2)})${productInfo}`;
        adminBody = `${employeeName} recibió ${quantity.toFixed(2)} ${unit} ($${amount.toFixed(2)})${productInfo} autorizado por ${createdByName}`;
    }

    // Notificar al repartidor (usando GlobalId)
    const employeeResult = await sendNotificationToEmployee(employeeGlobalId, {
        title: isConsolidated ? '📦 Nueva Entrega' : 'Nueva Asignación',
        body: repartidorBody,
        data: {
            type: 'assignment_created',
            assignmentId: assignmentId.toString(),
            quantity: quantity.toString(),
            amount: amount.toString(),
            unitAbbreviation: unit,
            productName: productName || '',
            branchName,
            isConsolidated: isConsolidated ? 'true' : 'false',
            itemCount: (itemCount || 1).toString()
        }
    });

    // Notificar a administradores y encargados
    // EXCLUIR al repartidor que ya recibió su notificación personal (evita duplicados)
    const adminResult = await sendNotificationToAdminsInBranch(branchId, {
        title: isConsolidated ? '📦 Entrega Asignada' : 'Asignación Creada',
        body: adminBody,
        data: {
            type: 'assignment_created',
            assignmentId: assignmentId.toString(),
            employeeName,
            createdByName,
            quantity: quantity.toString(),
            amount: amount.toString(),
            unitAbbreviation: unit,
            productName: productName || '',
            branchName,
            isConsolidated: isConsolidated ? 'true' : 'false',
            itemCount: (itemCount || 1).toString()
        }
    }, { excludeEmployeeGlobalId: employeeGlobalId, notificationType: 'notify_repartidores' });

    return {
        employee: employeeResult,
        admins: adminResult,
        total: employeeResult.sent + adminResult.sent
    };
}

/**
 * Envía notificación cuando se activa el Modo Preparación (Guardian deshabilitado temporalmente)
 * Notifica a TODOS los administradores y encargados del TENANT (todas las sucursales)
 * @param {number} tenantId - ID del tenant
 * @param {number} branchId - ID de la sucursal (para guardar en historial)
 * @param {object} params - Datos de la activación
 */
async function notifyPreparationModeActivated(tenantId, branchId, { operatorName, authorizerName, branchName, reason, activatedAt, title: customTitle, body: customBody }) {
    try {
        const reasonText = reason ? ` - ${reason}` : '';

        const fcmTitle = customTitle || `Modo Preparacion [${branchName}]`;
        const fcmBody = customBody || `${operatorName} activo el Modo Preparacion${authorizerName !== operatorName ? ` (autorizado por ${authorizerName})` : ''}${reasonText}`;

        // Enviar notificación a TODOS los administradores/encargados del TENANT
        const result = await sendNotificationToAdminsInTenant(tenantId, {
            title: fcmTitle,
            body: fcmBody,
            data: {
                type: 'preparation_mode_activated',
                operatorName,
                authorizerName,
                branchName,
                branchId: branchId.toString(),
                tenantId: tenantId.toString(),
                reason: reason || '',
                activatedAt: activatedAt || new Date().toISOString()
            }
        }, { notificationType: 'notify_guardian' });

        console.log(`[NotificationHelper] ⚠️ Notificación de Modo Preparación enviada a admins del tenant ${tenantId}: ${result.sent}/${result.total || 0}`);

        // Guardar en historial de notificaciones (campana) - Usar category 'security' en lugar de 'guardian'
        // para que aparezca en la campana (guardian tiene su propia página)
        await saveToNotificationHistory({
            tenant_id: tenantId,
            branch_id: branchId,
            employee_id: null, // No hay un empleado específico, es para todos los admins
            category: 'security',
            event_type: 'preparation_mode_activated',
            title: `⚠️ Modo Preparación [${branchName}]`,
            body: `${operatorName} activó el Modo Preparación${reasonText}`,
            data: { operatorName, authorizerName, branchName, branchId, tenantId, reason, activatedAt }
        });

        return result;
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error en notifyPreparationModeActivated:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando se desactiva el Modo Preparación
 * Notifica a TODOS los administradores y encargados del TENANT
 * @param {number} tenantId - ID del tenant
 * @param {number} branchId - ID de la sucursal
 * @param {object} params - Datos de la desactivación
 */
async function notifyPreparationModeDeactivated(tenantId, branchId, { operatorName, branchName, durationFormatted, severity, deactivatedAt, reason, weighingCycleCount = 0, totalWeightKg = 0, title: customTitle, body: customBody }) {
    try {
        // Determinar emoji/icono según severidad
        const severityInfo = {
            'Critical': { emoji: '🔴', text: 'CRÍTICA' },
            'High': { emoji: '🟠', text: 'ALTA' },
            'Medium': { emoji: '🟡', text: 'MEDIA' },
            'Low': { emoji: '🟢', text: 'BAJA' }
        };
        const info = severityInfo[severity] || { emoji: '⚪', text: severity };

        // Construir body con datos de pesaje si los hay
        let defaultBody = `${operatorName} finalizó - Duración: ${durationFormatted} (${info.emoji} ${info.text})`;
        if (weighingCycleCount > 0) {
            defaultBody += ` | Pesajes: ${weighingCycleCount}, Total: ${Number(totalWeightKg).toFixed(3)}kg`;
        }

        const fcmTitle = customTitle || `Modo Preparacion Finalizado [${branchName}]`;
        const fcmBody = customBody || defaultBody;

        // Enviar notificacion a TODOS los administradores/encargados del TENANT
        const result = await sendNotificationToAdminsInTenant(tenantId, {
            title: fcmTitle,
            body: fcmBody,
            data: {
                type: 'preparation_mode_deactivated',
                operatorName,
                branchName,
                branchId: branchId.toString(),
                tenantId: tenantId.toString(),
                durationFormatted,
                severity,
                deactivatedAt: deactivatedAt || new Date().toISOString(),
                reason: reason || '',
                weighingCycleCount: weighingCycleCount.toString(),
                totalWeightKg: totalWeightKg.toString()
            }
        }, { notificationType: 'notify_guardian' });

        console.log(`[NotificationHelper] ✅ Notificación de desactivación enviada a admins del tenant ${tenantId}: ${result.sent}/${result.total || 0}`);

        // Guardar en historial de notificaciones
        await saveToNotificationHistory({
            tenant_id: tenantId,
            branch_id: branchId,
            employee_id: null,
            category: 'security',
            event_type: 'preparation_mode_deactivated',
            title: `✅ Modo Preparación Finalizado [${branchName}]`,
            body,
            data: { operatorName, branchName, branchId, tenantId, durationFormatted, severity, deactivatedAt, reason, weighingCycleCount, totalWeightKg }
        });

        return result;
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error en notifyPreparationModeDeactivated:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando se activa/desactiva el Peso Manual (override de báscula)
 * Notifica a TODOS los administradores y encargados del TENANT
 * @param {number} tenantId - ID del tenant
 * @param {number} branchId - ID de la sucursal
 * @param {object} params - Datos del cambio
 */
async function notifyManualWeightOverrideChanged(tenantId, branchId, { employeeName, branchName, isActivated, timestamp }) {
    try {
        const action = isActivated ? 'activó' : 'desactivó';
        const emoji = isActivated ? '⚠️' : '✅';
        const title = isActivated
            ? `⚠️ Peso Manual Activado [${branchName}]`
            : `✅ Peso Manual Desactivado [${branchName}]`;
        const body = `${employeeName} ${action} el modo de peso manual`;

        const result = await sendNotificationToAdminsInTenant(tenantId, {
            title,
            body,
            data: {
                type: 'manual_weight_override_changed',
                employeeName,
                branchName,
                branchId: branchId.toString(),
                tenantId: tenantId.toString(),
                isActivated: isActivated.toString(),
                timestamp: timestamp || new Date().toISOString()
            }
        }, { notificationType: 'notify_guardian' });

        console.log(`[NotificationHelper] ${emoji} Notificación de Peso Manual (${action}) enviada a admins del tenant ${tenantId}: ${result.sent}/${result.total || 0}`);

        // Guardar en historial de notificaciones (campana)
        await saveToNotificationHistory({
            tenant_id: tenantId,
            branch_id: branchId,
            employee_id: null,
            category: 'security',
            event_type: 'manual_weight_override_changed',
            title,
            body,
            data: { employeeName, branchName, branchId, tenantId, isActivated, timestamp }
        });

        return result;
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error en notifyManualWeightOverrideChanged:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando se realiza una venta a crédito
 * Notifica a TODOS los administradores y encargados del TENANT
 * @param {number} tenantId - ID del tenant
 * @param {number} branchId - ID de la sucursal
 * @param {object} params - Datos de la venta a crédito
 */
async function notifyCreditSaleCreated(tenantId, branchId, { ticketNumber, total, creditAmount, clientName, branchName, employeeName }) {
    try {
        const result = await sendNotificationToAdminsInTenant(tenantId, {
            title: `Venta a Credito [${branchName}]`,
            body: `${clientName}: $${creditAmount.toFixed(2)} de $${total.toFixed(2)} - Ticket #${ticketNumber}`,
            data: {
                type: 'credit_sale_created',
                ticketNumber: ticketNumber.toString(),
                total: total.toString(),
                creditAmount: creditAmount.toString(),
                clientName,
                branchName,
                employeeName,
                branchId: branchId.toString(),
                tenantId: tenantId.toString()
            }
        }, { notificationType: 'notify_ventas' });

        console.log(`[NotificationHelper] Notificacion de venta a credito enviada a admins del tenant ${tenantId}: ${result.sent}/${result.total || 0}`);

        // Guardar en historial de notificaciones (campana)
        await saveToNotificationHistory({
            tenant_id: tenantId,
            branch_id: branchId,
            employee_id: null,
            category: 'business',
            event_type: 'credit_sale_created',
            title: `💳 Venta a Crédito [${branchName}]`,
            body: `${clientName}: $${creditAmount.toFixed(2)} de $${total.toFixed(2)} - Ticket #${ticketNumber}`,
            data: { ticketNumber, total, creditAmount, clientName, branchName, employeeName }
        });

        return result;
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error en notifyCreditSaleCreated:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando un cliente realiza un abono/pago
 * Notifica a TODOS los administradores y encargados del TENANT
 * @param {number} tenantId - ID del tenant
 * @param {number} branchId - ID de la sucursal
 * @param {object} params - Datos del pago recibido
 */
async function notifyClientPaymentReceived(tenantId, branchId, { paymentAmount, clientName, branchName, employeeName, remainingBalance, paymentMethod }) {
    try {
        const balanceText = remainingBalance > 0
            ? `Saldo restante: $${remainingBalance.toFixed(2)}`
            : 'Deuda liquidada';

        const result = await sendNotificationToAdminsInTenant(tenantId, {
            title: `Abono Recibido [${branchName}]`,
            body: `${clientName} abono $${paymentAmount.toFixed(2)} (${paymentMethod || 'Efectivo'}) - ${balanceText}`,
            data: {
                type: 'client_payment_received',
                paymentAmount: paymentAmount.toString(),
                clientName,
                branchName,
                employeeName,
                remainingBalance: remainingBalance.toString(),
                paymentMethod: paymentMethod || 'Efectivo',
                branchId: branchId.toString(),
                tenantId: tenantId.toString()
            }
        }, { notificationType: 'notify_ventas' });

        console.log(`[NotificationHelper] 💵 Notificación de abono recibido enviada a admins del tenant ${tenantId}: ${result.sent}/${result.total || 0}`);

        // Guardar en historial de notificaciones (campana)
        await saveToNotificationHistory({
            tenant_id: tenantId,
            branch_id: branchId,
            employee_id: null,
            category: 'business',
            event_type: 'client_payment_received',
            title: `💵 Abono Recibido [${branchName}]`,
            body: `${clientName} abonó $${paymentAmount.toFixed(2)} - ${balanceText}`,
            data: { paymentAmount, clientName, branchName, employeeName, remainingBalance, paymentMethod }
        });

        return result;
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error en notifyClientPaymentReceived:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando se cancela una venta
 * Notifica a TODOS los administradores y encargados del TENANT
 * @param {number} tenantId - ID del tenant
 * @param {number} branchId - ID de la sucursal
 * @param {object} params - Datos de la venta cancelada
 */
async function notifySaleCancelled(tenantId, branchId, { ticketNumber, total, reason, branchName, employeeName, authorizedBy }) {
    try {
        const reasonText = reason ? ` - ${reason}` : '';
        const authText = authorizedBy ? ` (Autorizado por ${authorizedBy})` : '';

        const result = await sendNotificationToAdminsInTenant(tenantId, {
            title: `Venta Cancelada [${branchName}]`,
            body: `Ticket #${ticketNumber} ($${total.toFixed(2)}) cancelado por ${employeeName}${authText}${reasonText}`,
            data: {
                type: 'sale_cancelled',
                ticketNumber: ticketNumber.toString(),
                total: total.toString(),
                reason: reason || '',
                branchName,
                employeeName,
                authorizedBy: authorizedBy || '',
                branchId: branchId.toString(),
                tenantId: tenantId.toString()
            }
        }, { notificationType: 'notify_ventas' });

        console.log(`[NotificationHelper] ❌ Notificación de venta cancelada enviada a admins del tenant ${tenantId}: ${result.sent}/${result.total || 0}`);

        // Guardar en historial de notificaciones (campana)
        await saveToNotificationHistory({
            tenant_id: tenantId,
            branch_id: branchId,
            employee_id: null,
            category: 'business',
            event_type: 'sale_cancelled',
            title: `❌ Venta Cancelada [${branchName}]`,
            body: `Ticket #${ticketNumber} ($${total.toFixed(2)}) cancelado por ${employeeName}${authText}${reasonText}`,
            data: { ticketNumber, total, reason, branchName, employeeName, authorizedBy }
        });

        return result;
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error en notifySaleCancelled:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando el Guardian cambia de estado (activado/desactivado)
 * Solo notifica a administradores y encargados
 */
async function notifyGuardianStatusChanged(branchId, { isEnabled, changedBy }) {
    const status = isEnabled ? 'ACTIVADO' : 'DESACTIVADO';
    const icon = isEnabled ? '🛡️' : '⚠️';
    return await sendNotificationToAdminsInBranch(branchId, {
        title: `${icon} Guardian ${status}`,
        body: `El sistema Guardian fue ${status} por ${changedBy}`,
        data: {
            type: 'guardian_status_changed',
            isEnabled: String(isEnabled),
            changedBy
        }
    }, { notificationType: 'notify_guardian' });
}

/**
 * Envía notificación cuando un repartidor entra o sale de una geocerca
 * Notifica a TODOS los administradores del TENANT
 */
async function notifyGeofenceEvent(tenantId, branchId, { employeeId, employeeName, zoneId, zoneName, branchName, eventType, distance }) {
    try {
        const isEnter = eventType === 'enter';
        const emoji = isEnter ? '🟢' : '🔴';
        const action = isEnter ? 'entró a' : 'salió de';
        const branchTag = branchName ? ` [${branchName}]` : '';
        const distText = distance >= 1000 ? `${(distance / 1000).toFixed(1)}km` : `${Math.round(distance)}m`;

        const title = `${emoji} Geocerca${branchTag}`;
        const body = `${employeeName} ${action} "${zoneName}" (${distText})`;

        const result = await sendNotificationToAdminsInTenant(tenantId, {
            title,
            body,
            data: {
                type: 'geofence_event',
                eventType,
                employeeId: String(employeeId),
                employeeName,
                zoneId: String(zoneId),
                zoneName,
                branchId: String(branchId),
                branchName: branchName || '',
                distance: String(distance)
            }
        }, { notificationType: 'notify_repartidores' });

        console.log(`[NotificationHelper] ${emoji} Geocerca: ${employeeName} ${action} "${zoneName}" - FCM: ${result.sent}/${result.total || 0}`);

        await saveToNotificationHistory({
            tenant_id: tenantId,
            branch_id: branchId,
            employee_id: employeeId,
            category: 'geofence',
            event_type: `geofence_${eventType}`,
            title,
            body,
            data: { employeeName, zoneName, zoneId, branchName, distance, eventType }
        });

        return result;
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error en notifyGeofenceEvent:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

module.exports = {
    sendNotificationToBranch,
    sendNotificationToAdminsInBranch,
    sendNotificationToAdminsInTenant,
    sendNotificationToEmployee,
    notifyUserLogin,
    notifyScaleAlert,
    notifySaleCompleted,
    notifyShiftStarted,
    notifyShiftEnded,
    notifyScaleDisconnection,
    notifyScaleConnection,
    notifyExpenseCreated,
    notifyAssignmentCreated,
    notifyPreparationModeActivated,
    notifyPreparationModeDeactivated,
    notifyManualWeightOverrideChanged,
    notifyCreditSaleCreated,
    notifyClientPaymentReceived,
    notifySaleCancelled,
    notifyGuardianStatusChanged,
    notifyGeofenceEvent
};
