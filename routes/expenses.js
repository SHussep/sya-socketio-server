// ═══════════════════════════════════════════════════════════════
// EXPENSES ROUTES - Extracted from server.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const JWT_SECRET = process.env.JWT_SECRET;
const { notifyExpenseCreated } = require('../utils/notificationHelper');

// Middleware: Autenticación JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token inválido o expirado' });
        }
        req.user = user;
        next();
    });
}

module.exports = (pool, io) => {
    const router = express.Router();

    // GET /api/expenses - Obtener gastos por sucursal y rango de fechas
    router.get('/', async (req, res) => {
        try {
            // Aceptar tanto branchId como branch_id para compatibilidad
            const branchId = req.query.branchId || req.query.branch_id;
            const startDate = req.query.startDate || req.query.start_date;
            const endDate = req.query.endDate || req.query.end_date;
            const { timezone, employee_id, tenant_id, shift_id, shiftId } = req.query;
            const shiftIdFilter = shift_id || shiftId;

            if (!branchId) {
                return res.status(400).json({ success: false, message: 'branchId es requerido' });
            }

            console.log(`[Expenses/GET] 📋 Obteniendo gastos - Branch: ${branchId}, Desde: ${startDate}, Hasta: ${endDate}, Shift: ${shiftIdFilter || 'ALL'}`);

            // Construir query con filtros opcionales
            let query = `
                SELECT
                    e.id,
                    e.global_id,
                    e.tenant_id,
                    e.branch_id,
                    b.name as branch_name,
                    e.employee_id,
                    CONCAT(emp.first_name, ' ', emp.last_name) as employee_name,
                    gcat.name as category,
                    e.global_category_id as category_id,
                    e.description,
                    e.amount,
                    e.quantity,
                    e.expense_date,
                    e.payment_type_id,
                    e.id_turno as shift_id,
                    e.status,
                    e.reviewed_by_desktop,
                    e.reviewed_by_employee_id,
                    CONCAT(reviewer.first_name, ' ', reviewer.last_name) as reviewed_by_name,
                    e.reviewed_at,
                    e.is_active,
                    e.created_at,
                    e.updated_at
                FROM expenses e
                LEFT JOIN employees emp ON e.employee_id = emp.id
                LEFT JOIN branches b ON e.branch_id = b.id
                LEFT JOIN global_expense_categories gcat ON e.global_category_id = gcat.id
                LEFT JOIN employees reviewer ON e.reviewed_by_employee_id = reviewer.id
                WHERE e.branch_id = $1
                  AND e.is_active = true
            `;

            const params = [branchId];
            let paramIndex = 2;

            // ✅ Usar timezone del cliente para filtrar fechas correctamente
            // Si el cliente envía timezone (IANA name como 'Australia/Sydney'),
            // convertimos expense_date a ese timezone antes de comparar
            const userTimezone = timezone || 'UTC';
            console.log(`[Expenses/GET] 🕐 Using timezone: ${userTimezone}`);

            // Filtro por rango de fechas usando AT TIME ZONE
            if (startDate && endDate) {
                // Extraer solo la parte de fecha para comparar en el timezone del cliente
                const startDateOnly = startDate.split('T')[0];
                const endDateOnly = endDate.split('T')[0];

                console.log(`[Expenses/GET] 📅 Date range in ${userTimezone}: ${startDateOnly} to ${endDateOnly}`);

                query += ` AND (e.expense_date AT TIME ZONE '${userTimezone}')::date >= '${startDateOnly}'::date`;
                query += ` AND (e.expense_date AT TIME ZONE '${userTimezone}')::date <= '${endDateOnly}'::date`;
            } else if (startDate) {
                const startDateOnly = startDate.split('T')[0];
                query += ` AND (e.expense_date AT TIME ZONE '${userTimezone}')::date >= '${startDateOnly}'::date`;
            } else if (endDate) {
                const endDateOnly = endDate.split('T')[0];
                query += ` AND (e.expense_date AT TIME ZONE '${userTimezone}')::date <= '${endDateOnly}'::date`;
            }

            // Filtro por empleado
            if (employee_id) {
                query += ` AND e.employee_id = $${paramIndex}`;
                params.push(employee_id);
                paramIndex++;
            }

            // Filtro por tenant
            if (tenant_id) {
                query += ` AND e.tenant_id = $${paramIndex}`;
                params.push(tenant_id);
                paramIndex++;
            }

            // Filtro por shift (turno)
            if (shiftIdFilter) {
                query += ` AND e.id_turno = $${paramIndex}`;
                params.push(parseInt(shiftIdFilter)); // Asegurar que es entero
                paramIndex++;
                console.log(`[Expenses/GET] 🔒 Aplicando filtro de turno: id_turno = ${shiftIdFilter}`);
            } else {
                console.log(`[Expenses/GET] ⚠️ Sin filtro de turno - retornando TODOS los gastos`);
            }

            query += ` ORDER BY e.expense_date DESC, e.created_at DESC`;

            console.log(`[Expenses/GET] Query: ${query}`);
            console.log(`[Expenses/GET] Params: ${JSON.stringify(params)}`);
            const result = await pool.query(query, params);

            console.log(`[Expenses/GET] ✅ Encontrados ${result.rows.length} gastos`);

            // Debug: Si no hay gastos con shift, verificar cuántos hay sin filtro de shift
            if (result.rows.length === 0 && shiftIdFilter) {
                const debugResult = await pool.query(
                    `SELECT COUNT(*) as total,
                            COUNT(CASE WHEN id_turno = $2 THEN 1 END) as with_shift,
                            COUNT(CASE WHEN id_turno IS NULL THEN 1 END) as null_shift
                     FROM expenses
                     WHERE branch_id = $1 AND is_active = true`,
                    [branchId, shiftIdFilter]
                );
                console.log(`[Expenses/GET] 🔍 Debug: Total gastos: ${debugResult.rows[0].total}, Con shift ${shiftIdFilter}: ${debugResult.rows[0].with_shift}, Sin shift: ${debugResult.rows[0].null_shift}`);
            }

            // Normalizar amount a número
            const normalizedRows = result.rows.map(row => ({
                ...row,
                amount: parseFloat(row.amount)
            }));

            res.json({
                success: true,
                count: result.rows.length,
                data: normalizedRows
            });
        } catch (error) {
            console.error('[Expenses/GET] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener gastos',
                error: error.message
            });
        }
    });

    // POST /api/expenses - Crear gasto desde Desktop (sin JWT)
    router.post('/', async (req, res) => {
        try {
            const { tenantId, branchId, category, description, amount, userEmail } = req.body;

            if (!tenantId || !branchId || !category || !amount) {
                return res.status(400).json({ success: false, message: 'Datos incompletos' });
            }

            // Buscar empleado por email
            let employeeId = null;
            let employeeName = 'Empleado'; // Default name
            if (userEmail) {
                const empResult = await pool.query(
                    'SELECT id, first_name, last_name, username FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                    [userEmail, tenantId]
                );
                if (empResult.rows.length > 0) {
                    employeeId = empResult.rows[0].id;
                    const emp = empResult.rows[0];
                    employeeName = emp.first_name ? `${emp.first_name} ${emp.last_name || ''}`.trim() : emp.username;
                }
            }

            // Buscar categoría global por nombre
            let globalCategoryId = 12; // Default: Otros Gastos (ID 12)
            const catResult = await pool.query(
                `SELECT id FROM global_expense_categories
                 WHERE LOWER(name) = LOWER($1)
                    OR LOWER(name) LIKE '%' || LOWER($1) || '%'
                 LIMIT 1`,
                [category]
            );

            if (catResult.rows.length > 0) {
                globalCategoryId = catResult.rows[0].id;
                console.log(`[Expenses] Categoría global encontrada: ${category} (ID: ${globalCategoryId})`);
            } else {
                console.log(`[Expenses] Categoría '${category}' no encontrada, usando Otros Gastos (ID: 12)`);
            }

            const result = await pool.query(
                `INSERT INTO expenses (tenant_id, branch_id, employee_id, global_category_id, description, amount, global_id, terminal_id, local_op_seq, created_local_utc)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)
                 RETURNING *`,
                [tenantId, branchId, employeeId, globalCategoryId, description, amount, uuidv4(), uuidv4(), new Date().toISOString()]
            );

            const newExpense = result.rows[0];
            console.log(`[Expenses] ✅ Gasto creado desde Desktop: ${category} - $${amount}`);

            // 📢 EMITIR EVENTO SOCKET.IO
            if (io && employeeId) {
                const roomName = `branch_${branchId}`;
                console.log(`[Expenses] 📡 Emitiendo 'expense_assigned' a ${roomName} para empleado ${employeeId}`);
                io.to(roomName).emit('expense_assigned', {
                    expenseId: newExpense.id,
                    employeeId: employeeId,
                    employeeName: employeeName,
                    amount: parseFloat(amount),
                    category: category,
                    description: description,
                    timestamp: new Date().toISOString()
                });
            }

            res.json({ success: true, data: newExpense });
        } catch (error) {
            console.error('[Expenses] Error:', error);
            res.status(500).json({ success: false, message: 'Error al crear gasto' });
        }
    });

    // POST /api/sync/expenses - Alias de /api/expenses (para compatibilidad con Desktop)
    // Ahora también acepta localShiftId para offline-first reconciliation
    // Soporta estados: draft, confirmed, deleted (para flujo de borradores)
    router.post('/sync', async (req, res) => {
        try {
            const {
                tenantId, branchId,
                employeeId,              // LEGACY: ID local (no usar)
                employee_global_id,      // ✅ NUEVO: UUID del empleado (idempotente)
                consumer_employee_global_id, // ✅ NUEVO: UUID del consumidor (si aplica)
                category, description, amount, quantity, userEmail,
                global_category_id,      // ✅ NUEVO: ID canónico de categoría (1-14) desde Desktop
                payment_type_id, expense_date_utc,
                id_turno,               // LEGACY: ID local del turno
                shift_global_id,        // ✅ NUEVO: UUID del turno (idempotente)
                reviewed_by_desktop,
                // Status (draft = borrador editable, confirmed = confirmado, deleted = eliminado)
                status = 'confirmed',
                needs_update = false,
                // OFFLINE-FIRST FIELDS (OPCIONALES - solo Desktop los envía, Mobile NO)
                global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
            } = req.body;

            // Detectar tipo de cliente: Desktop (offline-first) vs Mobile (online-only)
            const isDesktop = !!global_id && !!terminal_id;
            const reviewedValue = reviewed_by_desktop !== undefined ? reviewed_by_desktop : false;

            // Mapear status de español a inglés para compatibilidad con constraint de PostgreSQL
            const statusMap = {
                'confirmado': 'confirmed',
                'borrador': 'draft',
                'eliminado': 'deleted',
                'draft': 'draft',
                'confirmed': 'confirmed',
                'deleted': 'deleted'
            };
            const rawStatus = (status || 'confirmed').toLowerCase();
            const finalStatus = statusMap[rawStatus] || 'confirmed';

            // Si es Mobile (online-only), generar valores simples
            const finalGlobalId = global_id || uuidv4(); // Generate valid UUID for Mobile
            const finalTerminalId = terminal_id || uuidv4(); // Generate valid UUID for mobile apps
            const finalLocalOpSeq = local_op_seq || 0;
            const finalCreatedLocalUtc = created_local_utc || new Date().toISOString();
            const finalDeviceEventRaw = device_event_raw || Date.now();

            console.log(`[Sync/Expenses] 📥 Client Type: ${isDesktop ? 'DESKTOP (offline-first)' : 'MOBILE (online-only)'}`);
            console.log(`[Sync/Expenses] 📦 Tenant: ${tenantId}, Branch: ${branchId}, Category: ${category}`);
            console.log(`[Sync/Expenses] 💰 Amount: ${amount}, Quantity: ${quantity || 'N/A'}, Payment: ${payment_type_id}, Shift: ${id_turno || 'N/A'}`);
            console.log(`[Sync/Expenses] 📊 Status: ${finalStatus}, NeedsUpdate: ${needs_update}`);
            if (isDesktop) {
                console.log(`[Sync/Expenses] 🔐 Desktop IDs - Global: ${global_id}, Terminal: ${terminal_id}, Seq: ${local_op_seq}`);
            } else {
                console.log(`[Sync/Expenses] 📱 Mobile (online) - Auto-generated GlobalId: ${finalGlobalId}`);
            }
            console.log(`[Sync/Expenses] 📋 reviewed_by_desktop = ${reviewedValue}`);

            if (!tenantId || !branchId || !category || amount === null || amount === undefined || !payment_type_id) {
                return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, category, amount, payment_type_id requeridos)' });
            }

            // Convertir amount a número si viene como string
            const numericAmount = parseFloat(amount);
            if (isNaN(numericAmount)) {
                return res.status(400).json({ success: false, message: 'amount debe ser un número válido' });
            }

            // ✅ IDEMPOTENCIA: Resolver employee_global_id → PostgreSQL ID
            let finalEmployeeId = null;
            if (employee_global_id) {
                console.log(`[Sync/Expenses] 🔍 Resolviendo empleado con global_id: ${employee_global_id}`);
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [employee_global_id, tenantId]
                );
                if (empResult.rows.length > 0) {
                    finalEmployeeId = empResult.rows[0].id;
                    console.log(`[Sync/Expenses] ✅ Empleado resuelto: global_id ${employee_global_id} → id ${finalEmployeeId}`);
                } else {
                    console.log(`[Sync/Expenses] ❌ Empleado no encontrado con global_id: ${employee_global_id}`);
                    return res.status(400).json({
                        success: false,
                        message: `Empleado no encontrado con global_id: ${employee_global_id}`
                    });
                }
            } else if (employeeId) {
                // LEGACY: usar employeeId directo (no recomendado)
                finalEmployeeId = employeeId;
                console.log(`[Sync/Expenses] ⚠️ Usando employeeId legacy: ${employeeId}`);
            } else if (userEmail) {
                // Fallback: buscar por email
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                    [userEmail, tenantId]
                );
                if (empResult.rows.length > 0) {
                    finalEmployeeId = empResult.rows[0].id;
                }
            }

            // ✅ IDEMPOTENCIA: Resolver shift_global_id → PostgreSQL ID
            let finalShiftId = null;
            if (shift_global_id) {
                console.log(`[Sync/Expenses] 🔍 Resolviendo turno con global_id: ${shift_global_id}`);
                const shiftResult = await pool.query(
                    'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                    [shift_global_id, tenantId]
                );
                if (shiftResult.rows.length > 0) {
                    finalShiftId = shiftResult.rows[0].id;
                    console.log(`[Sync/Expenses] ✅ Turno resuelto: global_id ${shift_global_id} → id ${finalShiftId}`);
                } else {
                    console.log(`[Sync/Expenses] ⚠️ Turno no encontrado con global_id: ${shift_global_id}`);
                    // No es error crítico, el turno puede no existir aún
                }
            } else if (id_turno) {
                // LEGACY: usar id_turno directo (no recomendado)
                finalShiftId = id_turno;
                console.log(`[Sync/Expenses] ⚠️ Usando id_turno legacy: ${id_turno}`);
            }

            // ✅ IDEMPOTENCIA: Resolver consumer_employee_global_id si existe
            let finalConsumerEmployeeId = null;
            if (consumer_employee_global_id) {
                const consumerResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [consumer_employee_global_id, tenantId]
                );
                if (consumerResult.rows.length > 0) {
                    finalConsumerEmployeeId = consumerResult.rows[0].id;
                }
            }

            // ═══════════════════════════════════════════════════════════════════════════════
            // RESOLUCIÓN DE CATEGORÍA GLOBAL (IDs CANÓNICOS 1-14)
            // ═══════════════════════════════════════════════════════════════════════════════
            // Desktop envía global_category_id directamente (IDs canónicos inmutables 1-14).
            // Mobile envía solo category (nombre) y lo resolvemos.
            // ═══════════════════════════════════════════════════════════════════════════════
            let globalCategoryId = null;

            // ✅ PRIORIDAD 1: Si Desktop envía global_category_id, usarlo directamente
            if (global_category_id && Number.isInteger(Number(global_category_id)) && Number(global_category_id) >= 1 && Number(global_category_id) <= 14) {
                globalCategoryId = Number(global_category_id);
                console.log(`[Sync/Expenses] ✅ Usando global_category_id del cliente: ${globalCategoryId} (${category})`);
            }
            // PRIORIDAD 2: Buscar en global_expense_categories por nombre
            else {
                const globalCatResult = await pool.query(
                    `SELECT id FROM global_expense_categories
                     WHERE LOWER(name) = LOWER($1)
                        OR LOWER(name) LIKE '%' || LOWER($1) || '%'
                     LIMIT 1`,
                    [category]
                );

                if (globalCatResult.rows.length > 0) {
                    globalCategoryId = globalCatResult.rows[0].id;
                    console.log(`[Sync/Expenses] ✅ Categoría global por nombre: '${category}' → ID ${globalCategoryId}`);
                } else {
                    // 3. Mapeo manual de variantes conocidas → IDs canónicos (1-14)
                    const categoryMappings = {
                        // --- Materias Primas (IDs 1-3) ---
                        'maíz / maseca / harina': 1,
                        'maíz': 1,
                        'maiz': 1,
                        'maseca': 1,
                        'harina': 1,
                        'gas lp': 2,
                        'gaslp': 2,
                        'gas': 2,
                        'combustible vehículos': 3,
                        'combustible vehiculos': 3,
                        'gasolina': 3,
                        'combustible': 3,
                        'diesel': 3,
                        // --- Operativos (IDs 4-7) ---
                        'consumibles (papel, bolsas)': 4,
                        'consumibles': 4,
                        'bolsas': 4,
                        'papel': 4,
                        'refacciones moto': 5,
                        'moto': 5,
                        'refacciones auto': 6,
                        'auto': 6,
                        'reparaciones': 6,
                        'mantenimiento maquinaria': 7,
                        'mantenimiento': 7,
                        'maquinaria': 7,
                        // --- Administrativos (IDs 8-11) ---
                        'sueldos y salarios': 8,
                        'sueldos': 8,
                        'salarios': 8,
                        'impuestos (isr, iva)': 9,
                        'impuestos': 9,
                        'isr': 9,
                        'iva': 9,
                        'servicios (luz, agua, teléfono)': 10,
                        'servicios (luz, agua, telefono)': 10,
                        'servicios': 10,
                        'luz': 10,
                        'agua': 10,
                        'telefono': 10,
                        'teléfono': 10,
                        'limpieza': 11,
                        // --- Otros (IDs 12-14) ---
                        'otros gastos': 12,
                        'otros': 14,
                        'otro': 14,
                        'transporte': 12,
                        'comida': 13,
                        'almuerzo': 13,
                        'desayuno': 13,
                        'cena': 13,
                        'viáticos': 13,
                        'viaticos': 13
                    };

                    const lowerCategory = (category || '').toLowerCase().trim();
                    globalCategoryId = categoryMappings[lowerCategory] || 12;  // Default: Otros Gastos (ID 12)
                    console.log(`[Sync/Expenses] 🔄 Categoría mapeada: '${category}' → ID ${globalCategoryId}`);
                }
            }

            // ✅ Use client-provided UTC timestamp (already converted to UTC by Desktop)
            // Desktop sends expense_date_utc in ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)
            const expenseDate = expense_date_utc || new Date().toISOString();
            console.log(`[Sync/Expenses] 📅 Using expense timestamp: ${expenseDate}`);

            // Verificar si ya existe para manejar UPDATE vs INSERT
            const existing = await pool.query(
                'SELECT id, status FROM expenses WHERE global_id = $1',
                [finalGlobalId]
            );

            let result;
            if (existing.rows.length > 0 && needs_update) {
                // Ya existe y necesita actualización
                console.log(`[Sync/Expenses] 🔄 Actualizando gasto existente: ${finalGlobalId} (status: ${finalStatus})`);
                result = await pool.query(
                    `UPDATE expenses
                     SET amount = $1,
                         quantity = $2,
                         description = $3,
                         expense_date = $4,
                         payment_type_id = $5,
                         id_turno = $6,
                         status = $7,
                         reviewed_by_desktop = $8,
                         updated_at = NOW()
                     WHERE global_id = $9
                     RETURNING *`,
                    [
                        numericAmount,
                        quantity || null,
                        description || '',
                        expenseDate,
                        payment_type_id,
                        finalShiftId,  // Usar ID resuelto por GlobalId
                        finalStatus,
                        reviewedValue,
                        finalGlobalId
                    ]
                );
            } else if (existing.rows.length > 0) {
                // Ya existe pero no necesita actualización (idempotente)
                console.log(`[Sync/Expenses] ⏭️ Gasto ya existe (idempotente): ${finalGlobalId}`);
                return res.json({ success: true, data: existing.rows[0], message: 'Gasto ya registrado (idempotente)' });
            } else {
                // No existe, INSERT nuevo
                console.log(`[Sync/Expenses] ➕ Insertando nuevo gasto: ${finalGlobalId} (status: ${finalStatus}, globalCategoryId: ${globalCategoryId})`);
                result = await pool.query(
                    `INSERT INTO expenses (
                        tenant_id, branch_id, employee_id, payment_type_id, id_turno, global_category_id, description, amount, quantity, expense_date,
                        status, reviewed_by_desktop, is_active,
                        global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $14, $15, $16, $17)
                     RETURNING *`,
                    [
                        tenantId,
                        branchId,
                        finalEmployeeId,
                        payment_type_id,              // $4
                        finalShiftId,                 // $5 - Turno (resuelto por GlobalId)
                        globalCategoryId,             // $6 - CANÓNICO: global category ID (1-14)
                        description || '',            // $7
                        numericAmount,                // $8
                        quantity || null,             // $9 - Cantidad (litros, kg, etc.)
                        expenseDate,                  // $10
                        finalStatus,                  // $11 - Status (draft/confirmed/deleted)
                        reviewedValue,                // $12 - TRUE para Desktop, FALSE para Mobile
                        // is_active = true (hardcoded)   // $13 position shifted
                        finalGlobalId,                // $13 - UUID (Desktop) o generado (Mobile)
                        finalTerminalId,              // $14 - UUID (Desktop) o generado (Mobile)
                        finalLocalOpSeq,              // $15 - Sequence (Desktop) o 0 (Mobile)
                        finalCreatedLocalUtc,         // $16 - ISO 8601 timestamp
                        finalDeviceEventRaw           // $17 - Raw ticks
                    ]
                );
            }

            console.log(`[Sync/Expenses] ✅ Gasto sincronizado: ${category} - $${numericAmount} | PaymentType: ${payment_type_id}`);

            // Asegurar que amount es un número en la respuesta
            const responseData = result.rows[0];
            if (responseData) {
                responseData.amount = parseFloat(responseData.amount);
            }

            // 🔔 ENVIAR NOTIFICACIONES FCM si el gasto tiene empleado asignado
            // ⚠️ NO enviar notificación si es un gasto de Desktop ya revisado (el usuario que lo registra no necesita notificación)
            // Solo notificar cuando:
            // 1. Gasto de MÓVIL (reviewed_by_desktop = false) - para que admins lo vean
            // 2. Gasto de Desktop para OTRO empleado (no implementado aún)
            const shouldNotify = finalEmployeeId && !reviewedValue; // Solo notificar gastos de móvil (pendientes de revisión)

            if (shouldNotify) {
                try {
                    // Obtener datos del empleado y sucursal para las notificaciones
                    const employeeData = await pool.query(
                        `SELECT CONCAT(e.first_name, ' ', e.last_name) as full_name, e.global_id
                         FROM employees e
                         WHERE e.id = $1`,
                        [finalEmployeeId]
                    );

                    // Obtener nombre de la sucursal del gasto
                    const branchData = await pool.query(
                        `SELECT name FROM branches WHERE id = $1`,
                        [branchId]
                    );

                    if (employeeData.rows.length > 0) {
                        const employee = employeeData.rows[0];
                        const branchName = branchData.rows.length > 0 ? branchData.rows[0].name : 'Sucursal';

                        console.log(`[Sync/Expenses] 📨 Enviando notificaciones FCM para gasto de ${employee.full_name}`);

                        await notifyExpenseCreated(employee.global_id, {
                            expenseId: responseData.id,
                            amount: numericAmount,
                            description: description || category,
                            category,
                            branchId,
                            branchName: branchName,
                            employeeName: employee.full_name
                        });

                        console.log(`[Sync/Expenses] ✅ Notificaciones de gasto enviadas`);
                    }
                } catch (notifError) {
                    console.error(`[Sync/Expenses] ⚠️ Error enviando notificaciones: ${notifError.message}`);
                    // No fallar la sincronización si falla el envío de notificaciones
                }
            } else if (finalEmployeeId && reviewedValue) {
                console.log(`[Sync/Expenses] ℹ️ Gasto de Desktop (reviewed_by_desktop=true) - NO se envía notificación push`);
            }

            res.json({ success: true, data: responseData });
        } catch (error) {
            console.error('[Sync/Expenses] Error:', error);
            res.status(500).json({ success: false, message: 'Error al sincronizar gasto', error: error.message });
        }
    });

    // PUT /api/expenses/:global_id - Actualizar gasto existente
    router.put('/:global_id', async (req, res) => {
        try {
            const { global_id } = req.params;
            const {
                tenant_id,
                category,
                description,
                amount,
                payment_type_id,
                expense_date_utc,
                last_modified_local_utc
            } = req.body;

            console.log(`[Expenses/Update] 🔄 Actualizando gasto ${global_id} - Tenant: ${tenant_id}`);

            // Validar campos requeridos
            if (!tenant_id || !category || amount === null || !payment_type_id || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, category, amount, payment_type_id, global_id requeridos)'
                });
            }

            // Validar que el gasto existe y pertenece al tenant
            // NOTA: global_id es VARCHAR, no UUID - no usar ::uuid cast
            const checkResult = await pool.query(
                'SELECT id FROM expenses WHERE global_id = $1 AND tenant_id = $2',
                [global_id, tenant_id]
            );

            if (checkResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Gasto no encontrado o no pertenece al tenant'
                });
            }

            // Buscar categoría global por nombre
            let globalCategoryId = 12; // Default: Otros Gastos
            const catResult = await pool.query(
                `SELECT id FROM global_expense_categories
                 WHERE LOWER(name) = LOWER($1)
                    OR LOWER(name) LIKE '%' || LOWER($1) || '%'
                 LIMIT 1`,
                [category]
            );

            if (catResult.rows.length > 0) {
                globalCategoryId = catResult.rows[0].id;
            } else {
                console.log(`[Expenses/Update] Categoría '${category}' no encontrada, usando Otros Gastos (ID: 12)`);
            }

            // Actualizar gasto
            // NOTA: global_id es VARCHAR, no UUID - no usar ::uuid cast
            const numericAmount = parseFloat(amount);
            const updateResult = await pool.query(
                `UPDATE expenses
                 SET global_category_id = $1,
                     description = $2,
                     amount = $3,
                     payment_type_id = $4,
                     expense_date = $5,
                     updated_at = NOW()
                 WHERE global_id = $6 AND tenant_id = $7
                 RETURNING *`,
                [
                    globalCategoryId,
                    description || '',
                    numericAmount,
                    payment_type_id,
                    expense_date_utc || new Date().toISOString(),
                    global_id,
                    tenant_id
                ]
            );

            console.log(`[Expenses/Update] ✅ Gasto ${global_id} actualizado exitosamente`);

            const responseData = updateResult.rows[0];
            if (responseData) {
                responseData.amount = parseFloat(responseData.amount);
            }

            res.json({ success: true, data: responseData });
        } catch (error) {
            console.error('[Expenses/Update] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al actualizar gasto',
                error: error.message
            });
        }
    });

    // PATCH /api/expenses/:global_id/deactivate - Soft delete (marcar como eliminado)
    router.patch('/:global_id/deactivate', async (req, res) => {
        try {
            const { global_id } = req.params;
            const { tenant_id, last_modified_local_utc } = req.body;

            console.log(`[Expenses/Deactivate] 🗑️ Desactivando gasto ${global_id} - Tenant: ${tenant_id}`);

            // Validar que el gasto existe y pertenece al tenant
            // NOTA: global_id es VARCHAR, no UUID - no usar ::uuid cast
            const checkResult = await pool.query(
                'SELECT id, employee_global_id FROM expenses WHERE global_id = $1 AND tenant_id = $2',
                [global_id, tenant_id]
            );

            if (checkResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Gasto no encontrado o no pertenece al tenant'
                });
            }

            const employeeGlobalId = checkResult.rows[0].employee_global_id;

            // Soft delete: marcar como inactivo
            const result = await pool.query(
                `UPDATE expenses
                 SET is_active = false,
                     deleted_at = NOW(),
                     updated_at = NOW()
                 WHERE global_id = $1 AND tenant_id = $2
                 RETURNING *`,
                [global_id, tenant_id]
            );

            console.log(`[Expenses/Deactivate] ✅ Gasto ${global_id} desactivado exitosamente`);

            // ═══════════════════════════════════════════════════════════════
            // NOTIFICACIÓN EN TIEMPO REAL: Avisar al móvil que el gasto fue eliminado
            // ═══════════════════════════════════════════════════════════════
            const io = req.app.get('io');
            const expenseData = result.rows[0];
            if (io && expenseData) {
                const payload = {
                    globalId: global_id,
                    tenantId: tenant_id,
                    employeeGlobalId: employeeGlobalId,
                    deletedAt: new Date().toISOString()
                };

                // Emitir a la room del branch (donde está conectado el móvil)
                if (expenseData.branch_id) {
                    const branchRoom = `branch_${expenseData.branch_id}`;
                    io.to(branchRoom).emit('expense_deleted', payload);
                    console.log(`[Expenses/Deactivate] 📡 Emitido 'expense_deleted' a ${branchRoom}`);
                }

                // También emitir a la room del empleado específico (por si está conectado directamente)
                if (employeeGlobalId) {
                    const employeeRoom = `employee_${employeeGlobalId}`;
                    io.to(employeeRoom).emit('expense_deleted', payload);
                    console.log(`[Expenses/Deactivate] 📡 Emitido 'expense_deleted' a ${employeeRoom}`);
                }
            }

            res.json({
                success: true,
                message: 'Gasto desactivado correctamente',
                data: result.rows[0]
            });
        } catch (error) {
            console.error('[Expenses/Deactivate] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al desactivar gasto',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // EXPENSE CATEGORIES ENDPOINTS
    // ═══════════════════════════════════════════════════════════════

    // GET /api/expense-categories - Obtener categorías de gastos globales
    router.get('/categories', async (req, res) => {
        try {
            console.log(`[Expenses/Categories] 📋 Obteniendo categorías globales`);

            const query = `
                SELECT id, name, description, is_measurable, unit_abbreviation, is_available, sort_order, created_at, updated_at
                FROM global_expense_categories
                WHERE is_available = true
                ORDER BY sort_order ASC
            `;

            const result = await pool.query(query);

            console.log(`[Expenses/Categories] ✅ Encontradas ${result.rows.length} categorías globales`);

            res.json({
                success: true,
                count: result.rows.length,
                data: result.rows
            });
        } catch (error) {
            console.error('[Expenses/Categories] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener categorías de gastos',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // MOBILE EXPENSE REVIEW ENDPOINTS
    // ═══════════════════════════════════════════════════════════════
    router.get('/pending-review', async (req, res) => {
        try {
            const { employee_id, employee_global_id, tenant_id } = req.query;

            // ✅ IDEMPOTENCIA: Aceptar employee_global_id O employee_id
            if (!employee_id && !employee_global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'employee_id o employee_global_id es requerido'
                });
            }

            // Resolver employee_global_id → PostgreSQL ID si se proporciona
            let resolvedEmployeeId = employee_id;
            if (employee_global_id && !employee_id) {
                console.log(`[Expenses/PendingReview] 🔍 Resolviendo employee_global_id: ${employee_global_id}`);
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1' + (tenant_id ? ' AND tenant_id = $2' : ''),
                    tenant_id ? [employee_global_id, tenant_id] : [employee_global_id]
                );
                if (empResult.rows.length > 0) {
                    resolvedEmployeeId = empResult.rows[0].id;
                    console.log(`[Expenses/PendingReview] ✅ Empleado resuelto: ${employee_global_id} → ${resolvedEmployeeId}`);
                } else {
                    console.log(`[Expenses/PendingReview] ⚠️ Empleado no encontrado: ${employee_global_id}`);
                    return res.json({ success: true, count: 0, data: [] });
                }
            }

            console.log(`[Expenses/PendingReview] 🔍 Buscando gastos pendientes para employee_id: ${resolvedEmployeeId}`);

            // ✅ FILTRO: Solo gastos de MÓVIL pendientes de aprobación
            // - reviewed_by_desktop = false (no aprobado)
            // - local_op_seq = 0 (móvil no envía secuencia, o la envía como 0)
            // - Excluir gastos de Desktop que tienen local_op_seq > 0
            // - ✅ SOLO de turnos ABIERTOS (is_cash_cut_open = true)
            // - Los gastos de turnos cerrados son eliminados físicamente (ver shifts.js)
            // ✅ CRÍTICO: Incluir GlobalIds para que Desktop pueda resolver IDs locales
            const query = `
            SELECT
                e.id,
                e.global_id,
                e.tenant_id,
                e.branch_id,
                e.employee_id,
                emp.global_id as employee_global_id,
                CONCAT(emp.first_name, ' ', emp.last_name) as employee_name,
                gcat.name as category,
                e.global_category_id as category_id,
                e.global_category_id,
                e.description,
                e.amount,
                e.quantity,
                e.expense_date,
                e.payment_type_id,
                e.id_turno as shift_id,
                s.global_id as shift_global_id,
                s.is_cash_cut_open as shift_is_open,
                e.reviewed_by_desktop,
                e.terminal_id,
                e.local_op_seq,
                e.created_local_utc,
                e.device_event_raw,
                e.created_at
            FROM expenses e
            LEFT JOIN employees emp ON e.employee_id = emp.id
            LEFT JOIN global_expense_categories gcat ON e.global_category_id = gcat.id
            LEFT JOIN shifts s ON e.id_turno = s.id
            WHERE e.employee_id = $1
              AND e.reviewed_by_desktop = false
              AND (e.local_op_seq IS NULL OR e.local_op_seq = 0)
              AND s.is_cash_cut_open = true
              ${tenant_id ? 'AND e.tenant_id = $2' : ''}
            ORDER BY e.created_at DESC
        `;

            const params = tenant_id ? [resolvedEmployeeId, tenant_id] : [resolvedEmployeeId];
            const result = await pool.query(query, params);

            console.log(`[Expenses/PendingReview] ✅ Encontrados ${result.rows.length} gastos pendientes`);

            // Normalizar amount a número
            const normalizedRows = result.rows.map(row => ({
                ...row,
                amount: parseFloat(row.amount)
            }));

            res.json({
                success: true,
                count: result.rows.length,
                data: normalizedRows
            });
        } catch (error) {
            console.error('[Expenses/PendingReview] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener gastos pendientes',
                error: error.message
            });
        }
    });

    // PATCH /api/expenses/:global_id/approve - Aprobar gasto móvil
    router.patch('/:global_id/approve', async (req, res) => {
        try {
            const { global_id } = req.params;
            const { tenant_id, reviewer_employee_id, reviewer_employee_global_id } = req.body;

            console.log(`[Expenses/Approve] ✅ Aprobando gasto ${global_id} - Tenant: ${tenant_id}`);

            // Validar que el gasto existe y pertenece al tenant
            const checkResult = await pool.query(
                'SELECT id FROM expenses WHERE global_id = $1 AND tenant_id = $2',
                [global_id, tenant_id]
            );

            if (checkResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Gasto no encontrado o no pertenece al tenant'
                });
            }

            // Resolver reviewer_employee_global_id → PostgreSQL ID si se proporciona
            let reviewerEmployeeId = reviewer_employee_id || null;
            if (reviewer_employee_global_id && !reviewer_employee_id) {
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [reviewer_employee_global_id, tenant_id]
                );
                if (empResult.rows.length > 0) {
                    reviewerEmployeeId = empResult.rows[0].id;
                }
            }

            // Marcar como revisado con información de quién aprobó
            const result = await pool.query(
                `UPDATE expenses
                 SET reviewed_by_desktop = true,
                     reviewed_by_employee_id = $3,
                     reviewed_at = NOW(),
                     updated_at = NOW()
                 WHERE global_id = $1 AND tenant_id = $2
                 RETURNING *`,
                [global_id, tenant_id, reviewerEmployeeId]
            );

            console.log(`[Expenses/Approve] ✅ Gasto ${global_id} aprobado por employee_id: ${reviewerEmployeeId}`);

            res.json({
                success: true,
                message: 'Gasto aprobado correctamente',
                data: result.rows[0]
            });
        } catch (error) {
            console.error('[Expenses/Approve] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al aprobar gasto',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PATCH /:global_id - Editar descripción y monto de un gasto
    // Desktop usa esto para corregir errores antes de aprobar
    // ═══════════════════════════════════════════════════════════════
    router.patch('/:global_id', async (req, res) => {
        try {
            const { global_id } = req.params;
            const { tenant_id, category, description, amount } = req.body;

            console.log(`[Expenses/Edit] ✏️ Editando gasto ${global_id} - Tenant: ${tenant_id}`);

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            // Validar que el gasto existe y pertenece al tenant
            const checkResult = await pool.query(
                `SELECT e.id, e.description, e.amount, e.global_category_id, gcat.name as category_name
                 FROM expenses e
                 LEFT JOIN global_expense_categories gcat ON e.global_category_id = gcat.id
                 WHERE e.global_id = $1 AND e.tenant_id = $2`,
                [global_id, tenant_id]
            );

            if (checkResult.rows.length === 0) {
                console.log(`[Expenses/Edit] ❌ Gasto no encontrado: ${global_id}`);
                return res.status(404).json({
                    success: false,
                    message: 'Gasto no encontrado'
                });
            }

            const currentExpense = checkResult.rows[0];

            // Construir campos a actualizar
            const updates = [];
            const values = [];
            let paramIndex = 1;

            // Actualizar categoría si cambió
            if (category !== undefined && category !== currentExpense.category_name) {
                // Buscar el ID de la categoría global por nombre
                const categoryResult = await pool.query(
                    'SELECT id FROM global_expense_categories WHERE LOWER(name) = LOWER($1)',
                    [category]
                );
                if (categoryResult.rows.length > 0) {
                    updates.push(`global_category_id = $${paramIndex}`);
                    values.push(categoryResult.rows[0].id);
                    paramIndex++;
                    console.log(`[Expenses/Edit] 📂 Categoría cambiada: ${currentExpense.category_name} → ${category}`);
                }
            }

            if (description !== undefined && description !== currentExpense.description) {
                updates.push(`description = $${paramIndex}`);
                values.push(description);
                paramIndex++;
            }

            if (amount !== undefined && parseFloat(amount) !== parseFloat(currentExpense.amount)) {
                updates.push(`amount = $${paramIndex}`);
                values.push(parseFloat(amount));
                paramIndex++;
            }

            if (updates.length === 0) {
                console.log(`[Expenses/Edit] ℹ️ Sin cambios para gasto ${global_id}`);
                return res.json({
                    success: true,
                    message: 'Sin cambios',
                    data: currentExpense
                });
            }

            // Agregar updated_at
            updates.push(`updated_at = NOW()`);

            // Ejecutar actualización
            const updateQuery = `
                UPDATE expenses
                SET ${updates.join(', ')}
                WHERE global_id = $${paramIndex} AND tenant_id = $${paramIndex + 1}
                RETURNING *
            `;
            values.push(global_id, tenant_id);

            const updateResult = await pool.query(updateQuery, values);

            console.log(`[Expenses/Edit] ✅ Gasto editado: ${global_id}`);

            res.json({
                success: true,
                message: 'Gasto actualizado correctamente',
                data: updateResult.rows[0]
            });

        } catch (error) {
            console.error(`[Expenses/Edit] ❌ Error editando gasto:`, error);
            res.status(500).json({
                success: false,
                message: 'Error al editar gasto',
                error: error.message
            });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // SHIFT-BASED EXPENSE VALIDATION ENDPOINTS
    // Para validar gastos pendientes antes de cerrar turnos
    // ═══════════════════════════════════════════════════════════════

    // GET /api/expenses/pending-for-shift - Gastos pendientes de revisión para un turno específico
    // Desktop usa esto para verificar antes de cerrar turno
    router.get('/pending-for-shift', async (req, res) => {
        try {
            const { shift_global_id, shift_id, tenant_id, employee_id, employee_global_id } = req.query;

            console.log(`[Expenses/PendingForShift] 🔍 Buscando gastos pendientes`);
            console.log(`  - shift_global_id: ${shift_global_id || 'N/A'}`);
            console.log(`  - shift_id: ${shift_id || 'N/A'}`);
            console.log(`  - tenant_id: ${tenant_id}`);
            console.log(`  - employee_id: ${employee_id || 'N/A'}`);
            console.log(`  - employee_global_id: ${employee_global_id || 'N/A'}`);

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            // Resolver shift_global_id → PostgreSQL ID si se proporciona
            let resolvedShiftId = shift_id;
            if (shift_global_id) {
                const shiftResult = await pool.query(
                    'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                    [shift_global_id, tenant_id]
                );
                if (shiftResult.rows.length > 0) {
                    resolvedShiftId = shiftResult.rows[0].id;
                    console.log(`[Expenses/PendingForShift] ✅ Turno resuelto: ${shift_global_id} → ${resolvedShiftId}`);
                } else {
                    console.log(`[Expenses/PendingForShift] ⚠️ Turno no encontrado: ${shift_global_id}`);
                    // Si no existe el turno en PG, no hay gastos pendientes
                    return res.json({ success: true, count: 0, data: [] });
                }
            }

            // Resolver employee_global_id → PostgreSQL ID si se proporciona
            let resolvedEmployeeId = employee_id;
            if (employee_global_id) {
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [employee_global_id, tenant_id]
                );
                if (empResult.rows.length > 0) {
                    resolvedEmployeeId = empResult.rows[0].id;
                }
            }

            // Construir query dinámicamente
            let query = `
                SELECT
                    e.id,
                    e.global_id,
                    e.tenant_id,
                    e.branch_id,
                    e.employee_id,
                    CONCAT(emp.first_name, ' ', emp.last_name) as employee_name,
                    gcat.name as category,
                    e.global_category_id as category_id,
                    e.description,
                    e.amount,
                    e.quantity,
                    e.expense_date,
                    e.payment_type_id,
                    e.id_turno as shift_id,
                    sh.global_id as shift_global_id,
                    e.reviewed_by_desktop,
                    e.status,
                    e.is_active,
                    e.created_at
                FROM expenses e
                LEFT JOIN employees emp ON e.employee_id = emp.id
                LEFT JOIN global_expense_categories gcat ON e.global_category_id = gcat.id
                LEFT JOIN shifts sh ON e.id_turno = sh.id
                WHERE e.tenant_id = $1
                  AND e.reviewed_by_desktop = false
                  AND e.is_active = true
                  AND (e.status IS NULL OR e.status != 'deleted')
            `;

            const params = [tenant_id];
            let paramIndex = 2;

            // Filtro por turno
            if (resolvedShiftId) {
                query += ` AND e.id_turno = $${paramIndex}`;
                params.push(resolvedShiftId);
                paramIndex++;
            }

            // Filtro por empleado
            if (resolvedEmployeeId) {
                query += ` AND e.employee_id = $${paramIndex}`;
                params.push(resolvedEmployeeId);
                paramIndex++;
            }

            query += ` ORDER BY e.created_at DESC`;

            const result = await pool.query(query, params);

            console.log(`[Expenses/PendingForShift] ✅ Encontrados ${result.rows.length} gastos pendientes`);

            // Normalizar amount a número
            const normalizedRows = result.rows.map(row => ({
                ...row,
                amount: parseFloat(row.amount)
            }));

            res.json({
                success: true,
                count: result.rows.length,
                data: normalizedRows
            });
        } catch (error) {
            console.error('[Expenses/PendingForShift] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener gastos pendientes del turno',
                error: error.message
            });
        }
    });

    // POST /api/expenses/bulk-reject-orphaned - Rechazar gastos huérfanos de turnos cerrados
    // Desktop llama esto al reconectarse para limpiar gastos de turnos que ya cerró offline
    router.post('/bulk-reject-orphaned', async (req, res) => {
        try {
            const { tenant_id, shift_global_ids, reason } = req.body;

            console.log(`[Expenses/BulkRejectOrphaned] 🧹 Rechazando gastos huérfanos`);
            console.log(`  - tenant_id: ${tenant_id}`);
            console.log(`  - shift_global_ids: ${shift_global_ids?.length || 0} turnos`);
            console.log(`  - reason: ${reason || 'Turno cerrado sin revisión'}`);

            if (!tenant_id || !shift_global_ids || !Array.isArray(shift_global_ids)) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id y shift_global_ids (array) son requeridos'
                });
            }

            if (shift_global_ids.length === 0) {
                return res.json({ success: true, rejected_count: 0, message: 'No hay turnos para procesar' });
            }

            // Resolver shift_global_ids → PostgreSQL IDs
            const shiftIdsResult = await pool.query(
                'SELECT id, global_id FROM shifts WHERE global_id = ANY($1) AND tenant_id = $2',
                [shift_global_ids, tenant_id]
            );

            if (shiftIdsResult.rows.length === 0) {
                return res.json({ success: true, rejected_count: 0, message: 'Turnos no encontrados en PostgreSQL' });
            }

            const shiftIds = shiftIdsResult.rows.map(r => r.id);
            console.log(`[Expenses/BulkRejectOrphaned] ✅ Turnos resueltos: ${shiftIds.join(', ')}`);

            // Marcar gastos pendientes de esos turnos como rechazados/eliminados
            const rejectResult = await pool.query(
                `UPDATE expenses
                 SET status = 'deleted',
                     is_active = false,
                     reviewed_by_desktop = true,
                     deleted_at = NOW(),
                     updated_at = NOW()
                 WHERE tenant_id = $1
                   AND id_turno = ANY($2)
                   AND reviewed_by_desktop = false
                   AND is_active = true
                 RETURNING id, global_id, amount, description`,
                [tenant_id, shiftIds]
            );

            const rejectedCount = rejectResult.rows.length;
            console.log(`[Expenses/BulkRejectOrphaned] ✅ ${rejectedCount} gastos huérfanos rechazados`);

            // Registrar en bitácora los gastos rechazados
            if (rejectedCount > 0) {
                const rejectedDetails = rejectResult.rows.map(r => ({
                    id: r.id,
                    global_id: r.global_id,
                    amount: parseFloat(r.amount),
                    description: r.description
                }));
                console.log(`[Expenses/BulkRejectOrphaned] 📋 Detalles:`, rejectedDetails);
            }

            res.json({
                success: true,
                rejected_count: rejectedCount,
                rejected_expenses: rejectResult.rows,
                message: `${rejectedCount} gasto(s) rechazado(s) por: ${reason || 'Turno cerrado sin revisión'}`
            });
        } catch (error) {
            console.error('[Expenses/BulkRejectOrphaned] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al rechazar gastos huérfanos',
                error: error.message
            });
        }
    });

    // DELETE /api/expenses/:global_id - Eliminar gasto rechazado
    router.delete('/:global_id', async (req, res) => {
        try {
            const { global_id } = req.params;
            const { tenant_id } = req.query;

            console.log(`[Expenses/Delete] 🗑️ Eliminando gasto ${global_id} - Tenant: ${tenant_id}`);

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            // Validar que el gasto existe y pertenece al tenant
            const checkResult = await pool.query(
                'SELECT id FROM expenses WHERE global_id = $1 AND tenant_id = $2',
                [global_id, tenant_id]
            );

            if (checkResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Gasto no encontrado o no pertenece al tenant'
                });
            }

            // Eliminación PERMANENTE (hard delete)
            const result = await pool.query(
                `DELETE FROM expenses
             WHERE global_id = $1 AND tenant_id = $2
             RETURNING *`,
                [global_id, tenant_id]
            );

            console.log(`[Expenses/Delete] ✅ Gasto ${global_id} eliminado permanentemente`);

            res.json({
                success: true,
                message: 'Gasto eliminado correctamente',
                data: result.rows[0]
            });
        } catch (error) {
            console.error('[Expenses/Delete] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar gasto',
                error: error.message
            });
        }
    });

    return router;
};
