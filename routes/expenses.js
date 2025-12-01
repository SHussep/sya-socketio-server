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
                    e.employee_id,
                    CONCAT(emp.first_name, ' ', emp.last_name) as employee_name,
                    cat.name as category,
                    cat.id as category_id,
                    e.description,
                    e.amount,
                    e.quantity,
                    e.expense_date,
                    e.payment_type_id,
                    e.id_turno as shift_id,
                    e.status,
                    e.reviewed_by_desktop,
                    e.is_active,
                    e.created_at,
                    e.updated_at
                FROM expenses e
                LEFT JOIN employees emp ON e.employee_id = emp.id
                LEFT JOIN expense_categories cat ON e.category_id = cat.id
                WHERE e.branch_id = $1
                  AND e.is_active = true
            `;

            const params = [branchId];
            let paramIndex = 2;

            // Filtro por rango de fechas
            if (startDate) {
                query += ` AND e.expense_date >= $${paramIndex}`;
                params.push(startDate);
                paramIndex++;
            }

            if (endDate) {
                query += ` AND e.expense_date <= $${paramIndex}`;
                params.push(endDate);
                paramIndex++;
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
                params.push(shiftIdFilter);
                paramIndex++;
            }

            query += ` ORDER BY e.expense_date DESC, e.created_at DESC`;

            const result = await pool.query(query, params);

            console.log(`[Expenses/GET] ✅ Encontrados ${result.rows.length} gastos`);

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

            // Buscar o crear categoría
            let categoryId = null;
            const catResult = await pool.query(
                'SELECT id FROM expense_categories WHERE LOWER(name) = LOWER($1) AND tenant_id = $2',
                [category, tenantId]
            );

            if (catResult.rows.length > 0) {
                categoryId = catResult.rows[0].id;
            } else {
                const newCat = await pool.query(
                    'INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) RETURNING id',
                    [tenantId, category]
                );
                categoryId = newCat.rows[0].id;
                console.log(`[Expenses] Categoría creada: ${category} (ID: ${categoryId})`);
            }

            const result = await pool.query(
                `INSERT INTO expenses (tenant_id, branch_id, employee_id, category_id, description, amount)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [tenantId, branchId, employeeId, categoryId, description, amount]
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

            // Buscar o crear categoría
            let categoryId = null;
            const catResult = await pool.query(
                'SELECT id FROM expense_categories WHERE LOWER(name) = LOWER($1) AND tenant_id = $2',
                [category, tenantId]
            );

            if (catResult.rows.length > 0) {
                categoryId = catResult.rows[0].id;
            } else {
                const newCat = await pool.query(
                    'INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) RETURNING id',
                    [tenantId, category]
                );
                categoryId = newCat.rows[0].id;
                console.log(`[Sync/Expenses] Categoría creada: ${category} (ID: ${categoryId})`);
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
                console.log(`[Sync/Expenses] ➕ Insertando nuevo gasto: ${finalGlobalId} (status: ${finalStatus})`);
                result = await pool.query(
                    `INSERT INTO expenses (
                        tenant_id, branch_id, employee_id, payment_type_id, id_turno, category_id, description, amount, quantity, expense_date,
                        status, reviewed_by_desktop,
                        global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                     RETURNING *`,
                    [
                        tenantId,
                        branchId,
                        finalEmployeeId,
                        payment_type_id,              // $4
                        finalShiftId,                 // $5 - Turno (resuelto por GlobalId)
                        categoryId,                   // $6
                        description || '',            // $7
                        numericAmount,                // $8
                        quantity || null,             // $9 - Cantidad (litros, kg, etc.)
                        expenseDate,                  // $10
                        finalStatus,                  // $11 - Status (draft/confirmed/deleted)
                        reviewedValue,                // $12 - TRUE para Desktop, FALSE para Mobile
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
            if (finalEmployeeId) {
                try {
                    // Obtener datos del empleado y sucursal para las notificaciones
                    const employeeData = await pool.query(
                        `SELECT e.full_name, e.global_id, b.name as branch_name
                         FROM employees e
                         JOIN branches b ON e.branch_id = b.id
                         WHERE e.id = $1`,
                        [finalEmployeeId]
                    );

                    if (employeeData.rows.length > 0) {
                        const employee = employeeData.rows[0];

                        console.log(`[Sync/Expenses] 📨 Enviando notificaciones FCM para gasto de ${employee.full_name}`);

                        await notifyExpenseCreated(employee.global_id, {
                            expenseId: responseData.id,
                            amount: numericAmount,
                            description: description || category,
                            category,
                            branchId,
                            branchName: employee.branch_name,
                            employeeName: employee.full_name
                        });

                        console.log(`[Sync/Expenses] ✅ Notificaciones de gasto enviadas`);
                    }
                } catch (notifError) {
                    console.error(`[Sync/Expenses] ⚠️ Error enviando notificaciones: ${notifError.message}`);
                    // No fallar la sincronización si falla el envío de notificaciones
                }
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

            // Buscar o crear categoría
            let categoryId = null;
            const catResult = await pool.query(
                'SELECT id FROM expense_categories WHERE LOWER(name) = LOWER($1) AND tenant_id = $2',
                [category, tenant_id]
            );

            if (catResult.rows.length > 0) {
                categoryId = catResult.rows[0].id;
            } else {
                const newCat = await pool.query(
                    'INSERT INTO expense_categories (tenant_id, name) VALUES ($1, $2) RETURNING id',
                    [tenant_id, category]
                );
                categoryId = newCat.rows[0].id;
                console.log(`[Expenses/Update] Categoría creada: ${category} (ID: ${categoryId})`);
            }

            // Actualizar gasto
            // NOTA: global_id es VARCHAR, no UUID - no usar ::uuid cast
            const numericAmount = parseFloat(amount);
            const updateResult = await pool.query(
                `UPDATE expenses
                 SET category_id = $1,
                     description = $2,
                     amount = $3,
                     payment_type_id = $4,
                     expense_date = $5,
                     updated_at = NOW()
                 WHERE global_id = $6 AND tenant_id = $7
                 RETURNING *`,
                [
                    categoryId,
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
                'SELECT id FROM expenses WHERE global_id = $1 AND tenant_id = $2',
                [global_id, tenant_id]
            );

            if (checkResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Gasto no encontrado o no pertenece al tenant'
                });
            }

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

    // GET /api/expense-categories - Obtener categorías de gastos
    router.get('/categories', async (req, res) => {
        try {
            const { tenant_id } = req.query;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            console.log(`[Expenses/Categories] 📋 Obteniendo categorías para tenant_id: ${tenant_id}`);

            const query = `
                SELECT id, tenant_id, name, description, created_at, updated_at
                FROM expense_categories
                WHERE tenant_id = $1
                ORDER BY name ASC
            `;

            const result = await pool.query(query, [tenant_id]);

            console.log(`[Expenses/Categories] ✅ Encontradas ${result.rows.length} categorías`);

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
            const { employee_id, tenant_id } = req.query;

            if (!employee_id) {
                return res.status(400).json({
                    success: false,
                    message: 'employee_id es requerido'
                });
            }

            console.log(`[Expenses/PendingReview] 🔍 Buscando gastos pendientes para employee_id: ${employee_id}`);

            // ✅ FILTRO: Solo gastos de MÓVIL pendientes de aprobación
            // - reviewed_by_desktop = false (no aprobado)
            // - local_op_seq = 0 (móvil no envía secuencia, o la envía como 0)
            // - Excluir gastos de Desktop que tienen local_op_seq > 0
            const query = `
            SELECT
                e.id,
                e.global_id,
                e.tenant_id,
                e.branch_id,
                e.employee_id,
                CONCAT(emp.first_name, ' ', emp.last_name) as employee_name,
                cat.name as category,
                cat.id as category_id,
                e.description,
                e.amount,
                e.quantity,
                e.expense_date,
                e.payment_type_id,
                e.id_turno as shift_id,
                e.reviewed_by_desktop,
                e.terminal_id,
                e.local_op_seq,
                e.created_local_utc,
                e.device_event_raw,
                e.created_at
            FROM expenses e
            LEFT JOIN employees emp ON e.employee_id = emp.id
            LEFT JOIN expense_categories cat ON e.category_id = cat.id
            WHERE e.employee_id = $1
              AND e.reviewed_by_desktop = false
              AND (e.local_op_seq IS NULL OR e.local_op_seq = 0)
              ${tenant_id ? 'AND e.tenant_id = $2' : ''}
            ORDER BY e.created_at DESC
        `;

            const params = tenant_id ? [employee_id, tenant_id] : [employee_id];
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
            const { tenant_id } = req.body;

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

            // Marcar como revisado
            const result = await pool.query(
                `UPDATE expenses
             SET reviewed_by_desktop = true,
                 updated_at = NOW()
             WHERE global_id = $1 AND tenant_id = $2
             RETURNING *`,
                [global_id, tenant_id]
            );

            console.log(`[Expenses/Approve] ✅ Gasto ${global_id} aprobado exitosamente`);

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
