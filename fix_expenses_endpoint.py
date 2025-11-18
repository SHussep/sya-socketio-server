#!/usr/bin/env python3
"""
Modificar endpoint /sync de expenses para soportar:
- Desktop: con campos offline-first (global_id, terminal_id, etc.)
- Mobile: sin campos offline-first (online-only)
"""

import re
import uuid

with open('routes/expenses.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Hacer opcionales los campos offline-first en destructuring
old_destructure = '''            const {
                tenantId, branchId, employeeId, category, description, amount, quantity, userEmail,
                payment_type_id, expense_date_utc, id_turno,  // ✅ payment_type_id es REQUERIDO, expense_date_utc ya en UTC, id_turno turno al que pertenece
                reviewed_by_desktop,  // ✅ Cada cliente DEBE enviar este campo explícitamente
                // ✅ OFFLINE-FIRST FIELDS
                global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
            } = req.body;'''

new_destructure = '''            const {
                tenantId, branchId, employeeId, category, description, amount, quantity, userEmail,
                payment_type_id, expense_date_utc, id_turno,
                reviewed_by_desktop,
                // OFFLINE-FIRST FIELDS (OPCIONALES - solo Desktop los envía, Mobile NO)
                global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
            } = req.body;'''

content = content.replace(old_destructure, new_destructure)

# 2. Detectar tipo de cliente y generar valores por defecto para Mobile
old_validation = '''            // ✅ VALIDAR que el campo reviewed_by_desktop venga en el request
            // Desktop debe enviar true, Mobile debe enviar false
            const reviewedValue = reviewed_by_desktop !== undefined ? reviewed_by_desktop : false;  // Por defecto FALSE (mobile)

            console.log(`[Sync/Expenses] 📥 Sync request - Tenant: ${tenantId}, Branch: ${branchId}, Category: ${category}, PaymentType: ${payment_type_id}, ShiftId: ${id_turno || 'N/A'}`);
            console.log(`[Sync/Expenses] Received amount: ${amount} (type: ${typeof amount})`);
            console.log(`[Sync/Expenses] 🔐 Offline-First - GlobalId: ${global_id}, TerminalId: ${terminal_id}, LocalOpSeq: ${local_op_seq}`);
            console.log(`[Sync/Expenses] 📋 reviewed_by_desktop = ${reviewedValue} (recibido: ${reviewed_by_desktop})`);

            if (!tenantId || !branchId || !category || amount === null || amount === undefined || !global_id || !payment_type_id) {
                return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, category, amount, payment_type_id, global_id requeridos)' });
            }'''

new_validation = '''            // Detectar tipo de cliente: Desktop (offline-first) vs Mobile (online-only)
            const isDesktop = !!global_id && !!terminal_id;
            const reviewedValue = reviewed_by_desktop !== undefined ? reviewed_by_desktop : false;

            // Si es Mobile (online-only), generar valores simples
            const finalGlobalId = global_id || `mobile-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const finalTerminalId = terminal_id || 'mobile-app';
            const finalLocalOpSeq = local_op_seq || 0;
            const finalCreatedLocalUtc = created_local_utc || new Date().toISOString();
            const finalDeviceEventRaw = device_event_raw || Date.now();

            console.log(`[Sync/Expenses] 📥 Client Type: ${isDesktop ? 'DESKTOP (offline-first)' : 'MOBILE (online-only)'}`);
            console.log(`[Sync/Expenses] 📦 Tenant: ${tenantId}, Branch: ${branchId}, Category: ${category}`);
            console.log(`[Sync/Expenses] 💰 Amount: ${amount}, Quantity: ${quantity || 'N/A'}, Payment: ${payment_type_id}, Shift: ${id_turno || 'N/A'}`);
            if (isDesktop) {
                console.log(`[Sync/Expenses] 🔐 Desktop IDs - Global: ${global_id}, Terminal: ${terminal_id}, Seq: ${local_op_seq}`);
            } else {
                console.log(`[Sync/Expenses] 📱 Mobile (online) - Auto-generated GlobalId: ${finalGlobalId}`);
            }
            console.log(`[Sync/Expenses] 📋 reviewed_by_desktop = ${reviewedValue}`);

            if (!tenantId || !branchId || !category || amount === null || amount === undefined || !payment_type_id) {
                return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, category, amount, payment_type_id requeridos)' });
            }'''

content = content.replace(old_validation, new_validation)

# 3. Usar las variables finales en el INSERT
old_insert_values = '''                [
                    tenantId,
                    branchId,
                    finalEmployeeId,
                    payment_type_id,              // $4
                    id_turno || null,             // $5 - Turno al que pertenece el gasto
                    categoryId,                   // $6
                    description || '',            // $7
                    numericAmount,                // $8
                    quantity || null,             // $9 - Cantidad (litros, kg, etc.)
                    expenseDate,                  // $10
                    reviewedValue,                // $11 - TRUE para Desktop, FALSE para Mobile
                    global_id,                    // $12 - UUID
                    terminal_id,                  // $13 - UUID
                    local_op_seq,                 // $14 - Sequence number
                    created_local_utc,            // $15 - ISO 8601 timestamp
                    device_event_raw              // $16 - Raw ticks
                ]'''

new_insert_values = '''                [
                    tenantId,
                    branchId,
                    finalEmployeeId,
                    payment_type_id,              // $4
                    id_turno || null,             // $5 - Turno al que pertenece el gasto
                    categoryId,                   // $6
                    description || '',            // $7
                    numericAmount,                // $8
                    quantity || null,             // $9 - Cantidad (litros, kg, etc.)
                    expenseDate,                  // $10
                    reviewedValue,                // $11 - TRUE para Desktop, FALSE para Mobile
                    finalGlobalId,                // $12 - UUID (Desktop) o generado (Mobile)
                    finalTerminalId,              // $13 - UUID (Desktop) o 'mobile-app' (Mobile)
                    finalLocalOpSeq,              // $14 - Sequence (Desktop) o 0 (Mobile)
                    finalCreatedLocalUtc,         // $15 - ISO 8601 timestamp
                    finalDeviceEventRaw           // $16 - Raw ticks
                ]'''

content = content.replace(old_insert_values, new_insert_values)

with open('routes/expenses.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("[OK] Endpoint /sync actualizado para soportar Desktop y Mobile")
print("     - Desktop: envia global_id, terminal_id, etc.")
print("     - Mobile: NO envia esos campos, backend los genera automaticamente")
