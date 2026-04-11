/**
 * Rutas API para Asignaciones a Repartidores y Liquidaciones
 *
 * Endpoints:
 *   POST   /api/repartidor-assignments - Crear asignación
 *   POST   /api/repartidor-assignments/:id/liquidate - Liquidar asignación
 *   GET    /api/repartidor-assignments/employee/:employeeId - Obtener asignaciones de empleado
 *   GET    /api/repartidor-liquidations/employee/:employeeId - Obtener liquidaciones de empleado
 *   GET    /api/repartidor-liquidations/branch/:branchId/summary - Resumen por sucursal
 *   POST   /api/repartidor-assignments/:globalId/cancel-liquidation - Cancelar liquidación
 */

const express = require('express');
const { pool } = require('../database');
const { notifyAssignmentCreated } = require('../utils/notificationHelper');
const { deductBranchStock, restoreBranchStock, getBranchInventarioForEmit } = require('../utils/branchInventory');
const jwt = require('jsonwebtoken');

// ⚠️ SEGURIDAD: JWT_SECRET debe estar configurado en el entorno
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[SECURITY] ❌ JWT_SECRET no está configurado en el entorno');
}

function createRepartidorAssignmentRoutes(io) {
  const router = express.Router();

  // Middleware para extraer datos del JWT (opcional para este endpoint)
  function extractJwtData(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token && JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.jwtData = decoded;
      } catch (err) {
        req.jwtData = null;
      }
    }
    next();
  }

  // ═══════════════════════════════════════════════════════════════
  // POST /api/repartidor-assignments/sync
  // Sincronizar asignación desde Desktop (idempotente con global_id)
  // También soporta asignaciones directas desde móvil (sin venta)
  // Esquema normalizado 3NF - Sin redundancia
  // ═══════════════════════════════════════════════════════════════
  router.post('/sync', extractJwtData, async (req, res) => {
    const {
      tenant_id: body_tenant_id,
      branch_id: body_branch_id,
      venta_id,                         // ID numérico (legacy, puede no venir) - OPCIONAL para asignaciones directas
      venta_global_id,                  // ✅ UUID de la venta (offline-first) - OPCIONAL para asignaciones directas
      employee_id,                      // DEPRECATED: ID numérico (legacy)
      employee_global_id,               // ✅ UUID del repartidor (offline-first, preferido)
      created_by_employee_id,           // DEPRECATED: ID numérico (legacy)
      created_by_employee_global_id,    // ✅ UUID del empleado que autorizó (offline-first, preferido)
      shift_id,                         // DEPRECATED: ID numérico (legacy) - OPCIONAL para asignaciones directas
      shift_global_id,                  // ✅ UUID del turno del vendedor - OPCIONAL para asignaciones directas
      repartidor_shift_id,              // DEPRECATED: ID numérico (legacy)
      repartidor_shift_global_id,       // ✅ UUID del turno del repartidor (offline-first, preferido)
      assigned_quantity,
      assigned_amount,
      unit_price,
      unit_abbreviation,  // Product unit (kg, pz, L, etc.)
      status,
      fecha_asignacion,
      fecha_liquidacion,
      observaciones,
      // Product tracking (per-product assignments)
      product_id,                   // DEPRECATED: ID numérico (legacy)
      product_global_id,            // ✅ UUID del producto (offline-first, preferido)
      product_name,                 // Nombre del producto (denormalizado)
      venta_detalle_id,             // ID del detalle de venta
      // Offline-first fields
      global_id,
      terminal_id,
      local_op_seq,
      created_local_utc,
      device_event_raw,
      // 🆕 Payment tracking fields (para pagos mixtos)
      payment_method_id,
      cash_amount,
      card_amount,
      credit_amount,
      amount_received,
      is_credit,
      payment_reference,
      liquidated_by_employee_global_id,  // UUID del empleado que liquidó
      suppress_notification,             // Si es true, NO enviar notificación FCM (anti-spam para batch)
      source,                            // Origen: 'desktop' o 'mobile'
      // Edit tracking fields (auditoría de ediciones)
      was_edited,
      edit_reason,
      last_edited_at,
      last_edited_by_employee_global_id,
      original_quantity_before_edit,
      original_amount_before_edit,
      // Cancellation tracking fields
      cancel_reason,
      cancelled_at,
      cancelled_by_employee_global_id
    } = req.body;

    try {
      // ✅ Usar tenant_id/branch_id del JWT si no vienen en el body (para móvil)
      const tenant_id = body_tenant_id || (req.jwtData && req.jwtData.tenantId);
      let branch_id = body_branch_id || (req.jwtData && req.jwtData.branchId);

      // ✅ Determinar si es asignación directa (sin venta) o desde venta
      const isDirectAssignment = !venta_id && !venta_global_id;

      console.log('[RepartidorAssignments] 📦 POST /api/repartidor-assignments/sync');
      console.log(`  GlobalId: ${global_id}, Repartidor: ${employee_id || employee_global_id}`);
      console.log(`  Mode: ${isDirectAssignment ? 'DIRECT (sin venta)' : 'FROM_SALE'}, VentaGlobalId: ${venta_global_id || venta_id || 'N/A'}`);
      console.log(`  Product: ${product_name || 'N/A'}, Quantity: ${assigned_quantity} ${unit_abbreviation || 'kg'}, Status: ${status}`);
      console.log(`  RepartidorShiftGlobalId: ${repartidor_shift_global_id || 'N/A'}, RepartidorShiftId: ${repartidor_shift_id || 'N/A'}`);
      console.log(`  Tenant: ${tenant_id} (from: ${body_tenant_id ? 'body' : 'jwt'}), Branch: ${branch_id} (from: ${body_branch_id ? 'body' : 'jwt'})`);
      // 🆕 Log payment info when liquidating
      if (payment_method_id || cash_amount || card_amount || credit_amount) {
        console.log(`  💰 Payment: method=${payment_method_id}, cash=$${cash_amount || 0}, card=$${card_amount || 0}, credit=$${credit_amount || 0}`);
      }

      // Validar campos requeridos
      if (!tenant_id || !branch_id) {
        return res.status(400).json({
          success: false,
          message: 'tenant_id y branch_id son requeridos (pueden venir del JWT o del body)'
        });
      }

      // ✅ Para móvil: resolver branch_id del turno del REPARTIDOR (no del JWT del admin)
      // El admin puede estar logueado en branch_36 pero asignar a un repartidor en branch_35
      if (source === 'mobile' && repartidor_shift_global_id) {
        const shiftBranch = await pool.query(
          'SELECT branch_id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
          [repartidor_shift_global_id, tenant_id]
        );
        if (shiftBranch.rows.length > 0 && shiftBranch.rows[0].branch_id) {
          const originalBranch = branch_id;
          branch_id = shiftBranch.rows[0].branch_id;
          if (originalBranch != branch_id) {
            console.log(`[RepartidorAssignments] 🔄 branch_id corregido: JWT=${originalBranch} → shift=${branch_id} (del turno del repartidor)`);
          }
        }
      }

      // INFO: Verificar si Desktop está conectado (solo log, no bloquear)
      // Las asignaciones se guardan en PostgreSQL y Desktop las sincroniza al reconectar
      if (source === 'mobile') {
        const roomName = `branch_${branch_id}`;
        const roomSockets = io.sockets.adapter.rooms.get(roomName);
        let desktopFound = false;
        let clientTypes = [];

        if (roomSockets) {
          for (const socketId of roomSockets) {
            const s = io.sockets.sockets.get(socketId);
            if (s) {
              clientTypes.push(s.clientType || 'unknown');
              if (s.clientType !== 'mobile') desktopFound = true;
            }
          }
        }

        console.log(`[RepartidorAssignments] 📡 Desktop check for branch_${branch_id}: found=${desktopFound}, clients=[${clientTypes.join(', ')}]`);

        if (!desktopFound) {
          console.log(`[RepartidorAssignments] ⚠️ Desktop no conectado en branch_${branch_id} — asignación se guardará en PostgreSQL igualmente`);
        }
      }

      // Para asignaciones desde venta, venta_id y shift_id son requeridos
      // Para asignaciones directas (móvil), solo se requiere repartidor_shift
      if (!isDirectAssignment && (!shift_id && !shift_global_id)) {
        return res.status(400).json({
          success: false,
          message: 'shift_id/shift_global_id son requeridos para asignaciones desde venta'
        });
      }

      // Validar que al menos uno de employee_id o employee_global_id esté presente
      if (!employee_id && !employee_global_id) {
        return res.status(400).json({
          success: false,
          message: 'Se requiere employee_id o employee_global_id'
        });
      }

      // Validar que al menos uno de created_by_employee_id o created_by_employee_global_id esté presente
      if (!created_by_employee_id && !created_by_employee_global_id) {
        return res.status(400).json({
          success: false,
          message: 'Se requiere created_by_employee_id o created_by_employee_global_id'
        });
      }

      if (!assigned_quantity || assigned_quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: 'assigned_quantity debe ser mayor que 0'
        });
      }

      if (!assigned_amount || assigned_amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'assigned_amount debe ser mayor que 0'
        });
      }

      if (!global_id) {
        return res.status(400).json({
          success: false,
          message: 'global_id es requerido para idempotencia'
        });
      }

      // ✅ RESOLVER venta_id usando global_id (offline-first)
      // NOTA: venta_id es OPCIONAL para asignaciones directas (desde móvil)
      let resolvedVentaId = venta_id || null;

      if (venta_global_id) {
        console.log(`[RepartidorAssignments] 🔍 Resolviendo venta con global_id: ${venta_global_id}`);
        const saleLookup = await pool.query(
          'SELECT id_venta FROM ventas WHERE global_id = $1::uuid AND tenant_id = $2',
          [venta_global_id, tenant_id]
        );

        if (saleLookup.rows.length > 0) {
          resolvedVentaId = saleLookup.rows[0].id_venta;
          console.log(`[RepartidorAssignments] ✅ Venta resuelta: global_id ${venta_global_id} → id_venta ${resolvedVentaId}`);
        } else {
          console.log(`[RepartidorAssignments] ❌ Venta no encontrada con global_id: ${venta_global_id}`);
          return res.status(404).json({
            success: false,
            message: `Venta no encontrada con global_id: ${venta_global_id}. Asegúrate de sincronizar la venta primero.`
          });
        }
      } else if (venta_id) {
        // Verificar que la venta existe usando venta_id numérico
        const saleCheck = await pool.query(
          'SELECT id_venta FROM ventas WHERE id_venta = $1 AND tenant_id = $2',
          [venta_id, tenant_id]
        );

        if (saleCheck.rows.length === 0) {
          return res.status(404).json({
            success: false,
            message: `Venta ${venta_id} no encontrada en tenant ${tenant_id}`
          });
        }
      } else {
        // ✅ Asignación directa (sin venta) - esto es válido para móvil
        console.log(`[RepartidorAssignments] ℹ️ Asignación DIRECTA (sin venta asociada)`);
      }

      // ✅ RESOLVER repartidor_shift_id usando global_id (offline-first)
      // Si Desktop envía repartidor_shift_global_id (UUID), resolver al ID correcto en PostgreSQL
      let resolvedRepartidorShiftId = repartidor_shift_id;

      if (repartidor_shift_global_id) {
        console.log(`[RepartidorAssignments] 🔍 Resolviendo turno con global_id: ${repartidor_shift_global_id}`);
        const shiftLookup = await pool.query(
          'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
          [repartidor_shift_global_id, tenant_id]
        );

        if (shiftLookup.rows.length > 0) {
          resolvedRepartidorShiftId = shiftLookup.rows[0].id;
          console.log(`[RepartidorAssignments] ✅ Turno resuelto: global_id ${repartidor_shift_global_id} → id ${resolvedRepartidorShiftId}`);
        } else {
          console.log(`[RepartidorAssignments] ⚠️ Turno no encontrado con global_id: ${repartidor_shift_global_id}`);
          // Continuar sin repartidor_shift_id (será NULL)
          resolvedRepartidorShiftId = null;
        }
      }

      // ✅ RESOLVER employee_id usando global_id (offline-first)
      let resolvedEmployeeId = employee_id;
      if (employee_global_id) {
        console.log(`[RepartidorAssignments] 🔍 Resolviendo empleado con global_id: ${employee_global_id}`);
        const employeeLookup = await pool.query(
          'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
          [employee_global_id, tenant_id]
        );

        if (employeeLookup.rows.length > 0) {
          resolvedEmployeeId = employeeLookup.rows[0].id;
          console.log(`[RepartidorAssignments] ✅ Empleado resuelto: global_id ${employee_global_id} → id ${resolvedEmployeeId}`);
        } else {
          console.log(`[RepartidorAssignments] ❌ Empleado no encontrado con global_id: ${employee_global_id}`);
          return res.status(404).json({
            success: false,
            message: `Empleado no encontrado con global_id: ${employee_global_id}`
          });
        }
      }

      // ✅ RESOLVER created_by_employee_id usando global_id (offline-first)
      let resolvedCreatedByEmployeeId = created_by_employee_id;
      if (created_by_employee_global_id) {
        console.log(`[RepartidorAssignments] 🔍 Resolviendo empleado autorizador con global_id: ${created_by_employee_global_id}`);
        const createdByLookup = await pool.query(
          'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
          [created_by_employee_global_id, tenant_id]
        );

        if (createdByLookup.rows.length > 0) {
          resolvedCreatedByEmployeeId = createdByLookup.rows[0].id;
          console.log(`[RepartidorAssignments] ✅ Empleado autorizador resuelto: global_id ${created_by_employee_global_id} → id ${resolvedCreatedByEmployeeId}`);
        } else {
          console.log(`[RepartidorAssignments] ❌ Empleado autorizador no encontrado con global_id: ${created_by_employee_global_id}`);
          return res.status(404).json({
            success: false,
            message: `Empleado autorizador no encontrado con global_id: ${created_by_employee_global_id}`
          });
        }
      }

      // ✅ RESOLVER shift_id usando global_id (offline-first)
      // NOTA: shift_id (turno del vendedor) es OPCIONAL para asignaciones directas
      let resolvedShiftId = shift_id || null;
      if (shift_global_id) {
        console.log(`[RepartidorAssignments] 🔍 Resolviendo turno del vendedor con global_id: ${shift_global_id}`);
        const shiftLookup = await pool.query(
          'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
          [shift_global_id, tenant_id]
        );

        if (shiftLookup.rows.length > 0) {
          resolvedShiftId = shiftLookup.rows[0].id;
          console.log(`[RepartidorAssignments] ✅ Turno del vendedor resuelto: global_id ${shift_global_id} → id ${resolvedShiftId}`);
        } else {
          console.log(`[RepartidorAssignments] ❌ Turno del vendedor no encontrado con global_id: ${shift_global_id}`);
          return res.status(404).json({
            success: false,
            message: `Turno del vendedor no encontrado con global_id: ${shift_global_id}`
          });
        }
      } else if (isDirectAssignment) {
        // ✅ Para asignaciones directas, usar el repartidor_shift_id como shift_id
        console.log(`[RepartidorAssignments] ℹ️ Asignación directa: usando repartidor_shift como shift`);
      }

      // ✅ RESOLVER product_id usando global_id (offline-first)
      let resolvedProductId = product_id || null;
      if (product_global_id) {
        console.log(`[RepartidorAssignments] 🔍 Resolviendo producto con global_id: ${product_global_id}`);
        const productLookup = await pool.query(
          'SELECT id FROM productos WHERE global_id = $1',
          [product_global_id]
        );

        if (productLookup.rows.length > 0) {
          resolvedProductId = productLookup.rows[0].id;
          console.log(`[RepartidorAssignments] ✅ Producto resuelto: global_id ${product_global_id} → id ${resolvedProductId}`);
        } else {
          console.log(`[RepartidorAssignments] ⚠️ Producto no encontrado con global_id: ${product_global_id}`);
          // Continuar sin product_id (será NULL)
        }
      }

      // ✅ RESOLVER liquidated_by_employee_id usando global_id (offline-first)
      let resolvedLiquidatedByEmployeeId = null;
      if (liquidated_by_employee_global_id) {
        console.log(`[RepartidorAssignments] 🔍 Resolviendo empleado liquidador con global_id: ${liquidated_by_employee_global_id}`);
        const liquidatedByLookup = await pool.query(
          'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
          [liquidated_by_employee_global_id, tenant_id]
        );

        if (liquidatedByLookup.rows.length > 0) {
          resolvedLiquidatedByEmployeeId = liquidatedByLookup.rows[0].id;
          console.log(`[RepartidorAssignments] ✅ Empleado liquidador resuelto: global_id ${liquidated_by_employee_global_id} → id ${resolvedLiquidatedByEmployeeId}`);
        } else {
          console.log(`[RepartidorAssignments] ⚠️ Empleado liquidador no encontrado con global_id: ${liquidated_by_employee_global_id}`);
          // Continuar sin liquidated_by_employee_id (será NULL)
        }
      }

      // ✅ RESOLVER last_edited_by_employee_id usando global_id (para auditoría de ediciones)
      let resolvedLastEditedByEmployeeId = null;
      if (last_edited_by_employee_global_id) {
        const editedByLookup = await pool.query(
          'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
          [last_edited_by_employee_global_id, tenant_id]
        );
        if (editedByLookup.rows.length > 0) {
          resolvedLastEditedByEmployeeId = editedByLookup.rows[0].id;
        }
      }

      // ✅ RESOLVER cancelled_by_employee_id usando global_id (para auditoría de cancelaciones)
      let resolvedCancelledByEmployeeId = null;
      if (cancelled_by_employee_global_id) {
        const cancelledByLookup = await pool.query(
          'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
          [cancelled_by_employee_global_id, tenant_id]
        );
        if (cancelledByLookup.rows.length > 0) {
          resolvedCancelledByEmployeeId = cancelledByLookup.rows[0].id;
        }
      }

      // ✅ IDEMPOTENTE: Insertar con global_id único
      // ON CONFLICT: Permite updates de datos si el registro NO está liquidado
      // Si ya está liquidado, solo se actualizan campos de pago (para correcciones post-liquidación)
      // RETURNING xmax=0 indica INSERT nuevo, xmax>0 indica UPDATE de registro existente
      const query = `
        INSERT INTO repartidor_assignments (
          tenant_id, branch_id, venta_id, employee_id,
          created_by_employee_id, shift_id, repartidor_shift_id,
          assigned_quantity, assigned_amount, unit_price, unit_abbreviation,
          status, fecha_asignacion, fecha_liquidacion, observaciones,
          global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw,
          product_id, product_name, venta_detalle_id,
          payment_method_id, cash_amount, card_amount, credit_amount,
          amount_received, is_credit, payment_reference, liquidated_by_employee_id,
          source,
          was_edited, edit_reason, last_edited_at, last_edited_by_employee_id,
          original_quantity_before_edit, original_amount_before_edit,
          cancel_reason, cancelled_at, cancelled_by_employee_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16::uuid, $17::uuid, $18, $19, $20,
          $21, $22, $23,
          $24, $25, $26, $27, $28, $29, $30, $31, $32,
          $33, $34, $35, $36, $37, $38,
          $39, $40, $41
        )
        ON CONFLICT (global_id) DO UPDATE
        SET status = EXCLUDED.status,
            fecha_liquidacion = EXCLUDED.fecha_liquidacion,
            observaciones = EXCLUDED.observaciones,
            product_name = COALESCE(EXCLUDED.product_name, repartidor_assignments.product_name),
            -- ✅ EDICIÓN: Permitir cambio de cantidad/monto si:
            --    1. NO está liquidado, O
            --    2. was_edited = true (edición explícita desde UI, incluso post-liquidación)
            assigned_quantity = CASE
              WHEN repartidor_assignments.status != 'liquidated'
                   OR EXCLUDED.was_edited = true
              THEN EXCLUDED.assigned_quantity
              ELSE repartidor_assignments.assigned_quantity
            END,
            assigned_amount = CASE
              WHEN repartidor_assignments.status != 'liquidated'
                   OR EXCLUDED.was_edited = true
              THEN EXCLUDED.assigned_amount
              ELSE repartidor_assignments.assigned_amount
            END,
            unit_price = CASE
              WHEN repartidor_assignments.status != 'liquidated'
                   OR EXCLUDED.was_edited = true
              THEN EXCLUDED.unit_price
              ELSE repartidor_assignments.unit_price
            END,
            -- Campos de pago (siempre actualizables para correcciones)
            payment_method_id = COALESCE(EXCLUDED.payment_method_id, repartidor_assignments.payment_method_id),
            cash_amount = COALESCE(EXCLUDED.cash_amount, repartidor_assignments.cash_amount),
            card_amount = COALESCE(EXCLUDED.card_amount, repartidor_assignments.card_amount),
            credit_amount = COALESCE(EXCLUDED.credit_amount, repartidor_assignments.credit_amount),
            amount_received = COALESCE(EXCLUDED.amount_received, repartidor_assignments.amount_received),
            is_credit = COALESCE(EXCLUDED.is_credit, repartidor_assignments.is_credit),
            payment_reference = COALESCE(EXCLUDED.payment_reference, repartidor_assignments.payment_reference),
            liquidated_by_employee_id = COALESCE(EXCLUDED.liquidated_by_employee_id, repartidor_assignments.liquidated_by_employee_id),
            -- ✅ Campos de auditoría de ediciones (siempre actualizables)
            was_edited = COALESCE(EXCLUDED.was_edited, repartidor_assignments.was_edited),
            edit_reason = COALESCE(EXCLUDED.edit_reason, repartidor_assignments.edit_reason),
            last_edited_at = COALESCE(EXCLUDED.last_edited_at, repartidor_assignments.last_edited_at),
            last_edited_by_employee_id = COALESCE(EXCLUDED.last_edited_by_employee_id, repartidor_assignments.last_edited_by_employee_id),
            original_quantity_before_edit = COALESCE(EXCLUDED.original_quantity_before_edit, repartidor_assignments.original_quantity_before_edit),
            original_amount_before_edit = COALESCE(EXCLUDED.original_amount_before_edit, repartidor_assignments.original_amount_before_edit),
            -- ✅ Campos de auditoría de cancelaciones (siempre actualizables)
            cancel_reason = COALESCE(EXCLUDED.cancel_reason, repartidor_assignments.cancel_reason),
            cancelled_at = COALESCE(EXCLUDED.cancelled_at, repartidor_assignments.cancelled_at),
            cancelled_by_employee_id = COALESCE(EXCLUDED.cancelled_by_employee_id, repartidor_assignments.cancelled_by_employee_id),
            -- ✅ Permitir vincular venta/turno desde Desktop cuando procesa asignación de móvil
            venta_id = COALESCE(EXCLUDED.venta_id, repartidor_assignments.venta_id),
            shift_id = COALESCE(EXCLUDED.shift_id, repartidor_assignments.shift_id),
            updated_at = NOW()
        RETURNING *, (xmax = 0) AS inserted
      `;

      const result = await pool.query(query, [
        tenant_id,
        branch_id,
        resolvedVentaId,                // ✅ Usar ID resuelto desde global_id
        resolvedEmployeeId,             // ✅ Usar ID resuelto desde global_id
        resolvedCreatedByEmployeeId,    // ✅ Usar ID resuelto desde global_id
        resolvedShiftId,                // ✅ Usar ID resuelto desde global_id
        resolvedRepartidorShiftId,      // ✅ Usar ID resuelto desde global_id
        parseFloat(assigned_quantity),
        parseFloat(assigned_amount),
        parseFloat(unit_price),
        unit_abbreviation || 'kg',      // ✅ Unidad del producto (default 'kg')
        status || 'pending',
        fecha_asignacion || new Date().toISOString(),
        fecha_liquidacion || null,
        observaciones || null,
        global_id,
        terminal_id,
        local_op_seq || null,
        created_local_utc || new Date().toISOString(),
        device_event_raw || null,
        resolvedProductId,              // ✅ ID del producto resuelto desde global_id
        product_name || null,           // ✅ Nombre del producto (denormalizado)
        venta_detalle_id || null,       // ✅ ID del detalle de venta
        // 🆕 Payment tracking fields
        payment_method_id || null,
        cash_amount ? parseFloat(cash_amount) : null,
        card_amount ? parseFloat(card_amount) : null,
        credit_amount ? parseFloat(credit_amount) : null,
        amount_received ? parseFloat(amount_received) : null,
        is_credit || false,
        payment_reference || null,
        resolvedLiquidatedByEmployeeId,  // ✅ ID del empleado que liquidó resuelto desde global_id
        source || 'desktop',             // ✅ Origen de la asignación: 'desktop' o 'mobile'
        // Edit tracking fields
        was_edited || false,
        edit_reason || null,
        last_edited_at || null,
        resolvedLastEditedByEmployeeId,
        original_quantity_before_edit ? parseFloat(original_quantity_before_edit) : null,
        original_amount_before_edit ? parseFloat(original_amount_before_edit) : null,
        // Cancel tracking fields
        cancel_reason || null,
        cancelled_at || null,
        resolvedCancelledByEmployeeId
      ]);

      const assignment = result.rows[0];
      const wasInserted = assignment.inserted; // true = nueva asignación, false = actualización

      // Si resolvedVentaId era null (móvil no lo envió), tomarlo del registro existente
      if (!resolvedVentaId && assignment.venta_id) {
        resolvedVentaId = assignment.venta_id;
        console.log(`[RepartidorAssignments] 📎 venta_id recuperado del registro existente: ${resolvedVentaId}`);
      }

      // ═══════════════════════════════════════════════════════════════════════════════
      // INVENTARIO: Descontar stock al crear asignación (fuente de verdad: PostgreSQL)
      // Solo en INSERT nuevo con status pending/in_progress y producto inventariable
      // NOTA: POST /api/ventas NO descuenta inventario para venta_tipo_id=2 (Repartidor),
      //       así que la deducción siempre ocurre aquí, sea con o sin venta asociada.
      // ═══════════════════════════════════════════════════════════════════════════════
      if (wasInserted && resolvedProductId && ['pending', 'in_progress'].includes(assignment.status)) {
        try {
          const productCheck = await pool.query(
            `SELECT id, global_id, inventariar, inventario, descripcion, precio_venta, bascula, unidad_medida_id
             FROM productos WHERE id = $1 AND tenant_id = $2`,
            [resolvedProductId, tenant_id]
          );
          const prod = productCheck.rows[0];
          if (prod && prod.inventariar) {
            const qty = parseFloat(assigned_quantity);
            const { stockBefore, stockAfter } = await deductBranchStock(
              pool, tenant_id, branch_id,
              prod.global_id, qty,
              parseFloat(prod.inventario)
            );

            // Create kardex entry
            const kardexGlobalId = require('crypto').randomUUID();
            await pool.query(
              `INSERT INTO kardex_entries (
                  tenant_id, branch_id, product_id, product_global_id,
                  timestamp, movement_type, employee_id, employee_global_id,
                  quantity_before, quantity_change, quantity_after,
                  description, global_id, terminal_id, source
              ) VALUES ($1, $2, $3, $4, NOW(), 'AsignacionRepartidor', $5, $6, $7, $8, $9, $10, $11, $12, $13)
              ON CONFLICT (global_id) DO NOTHING`,
              [
                tenant_id, branch_id, resolvedProductId, prod.global_id,
                resolvedCreatedByEmployeeId, created_by_employee_global_id,
                stockBefore, -qty, stockAfter,
                `Asignación repartidor: ${product_name || prod.descripcion} x${qty}`,
                kardexGlobalId, terminal_id || null, source || 'desktop'
              ]
            );

            console.log(`[RepartidorAssignments] 📦 Inventario descontado: ${prod.descripcion} ${stockBefore} → ${stockAfter} (-${qty})`);

            // Emit product_updated + kardex_entries_created via Socket.IO
            if (io) {
              try {
                const branches = await pool.query(
                  'SELECT id FROM branches WHERE tenant_id = $1 AND is_active = true', [tenant_id]
                );
                const p = prod;
                for (const b of branches.rows) {
                  const branchInv = await getBranchInventarioForEmit(
                    pool, tenant_id, b.id, p.global_id, parseFloat(p.inventario)
                  );
                  const productPayload = {
                    id_producto: String(p.id), global_id: p.global_id,
                    descripcion: p.descripcion, inventario: branchInv,
                    precio_venta: parseFloat(p.precio_venta || 0), inventariar: p.inventariar,
                    pesable: p.bascula, unidad_medida: p.unidad_medida_id,
                    action: 'updated', updatedAt: new Date().toISOString()
                  };
                  io.to(`branch_${b.id}`).emit('product_updated', productPayload);
                }
                const kardexPayload = {
                  entries: [{
                    global_id: kardexGlobalId, product_global_id: prod.global_id,
                    product_id: resolvedProductId, descripcion: prod.descripcion,
                    movement_type: 'AsignacionRepartidor',
                    quantity_before: stockBefore, quantity_change: -qty, quantity_after: stockAfter,
                    description: `Asignación repartidor: ${product_name || prod.descripcion} x${qty}`,
                    employee_global_id: created_by_employee_global_id,
                    employee_id: resolvedCreatedByEmployeeId,
                    timestamp: new Date().toISOString(), terminal_id: terminal_id || null,
                    source: source || 'desktop'
                  }]
                };
                for (const b of branches.rows) {
                  io.to(`branch_${b.id}`).emit('kardex_entries_created', kardexPayload);
                }
                console.log(`[RepartidorAssignments] 📡 product_updated + kardex emitidos`);
              } catch (emitErr) {
                console.error('[RepartidorAssignments] ⚠️ Error emitting socket events:', emitErr.message);
              }
            }
          }
        } catch (invErr) {
          console.error('[RepartidorAssignments] ⚠️ Error descontando inventario:', invErr.message);
        }
      }

      // ═══════════════════════════════════════════════════════════════════════════════
      // INVENTARIO: Restaurar stock al cancelar asignación
      // Solo cuando es UPDATE (no INSERT) y status cambia a 'cancelled'
      // ═══════════════════════════════════════════════════════════════════════════════
      if (!wasInserted && assignment.status === 'cancelled' && resolvedProductId) {
        try {
          const productCheck = await pool.query(
            `SELECT id, global_id, inventariar, inventario, descripcion, precio_venta, bascula, unidad_medida_id
             FROM productos WHERE id = $1 AND tenant_id = $2`,
            [resolvedProductId, tenant_id]
          );
          const prod = productCheck.rows[0];
          if (prod && prod.inventariar) {
            const qty = parseFloat(assignment.assigned_quantity);
            const { stockBefore, stockAfter } = await restoreBranchStock(
              pool, tenant_id, branch_id,
              prod.global_id, qty,
              parseFloat(prod.inventario)
            );

            const kardexGlobalId = require('crypto').randomUUID();
            await pool.query(
              `INSERT INTO kardex_entries (
                  tenant_id, branch_id, product_id, product_global_id,
                  timestamp, movement_type, employee_id, employee_global_id,
                  quantity_before, quantity_change, quantity_after,
                  description, global_id, terminal_id, source
              ) VALUES ($1, $2, $3, $4, NOW(), 'CancelacionAsignacion', $5, $6, $7, $8, $9, $10, $11, $12, $13)
              ON CONFLICT (global_id) DO NOTHING`,
              [
                tenant_id, branch_id, resolvedProductId, prod.global_id,
                resolvedCancelledByEmployeeId || resolvedCreatedByEmployeeId,
                cancelled_by_employee_global_id || created_by_employee_global_id,
                stockBefore, qty, stockAfter,
                `Cancelación asignación: ${product_name || prod.descripcion} +${qty}`,
                kardexGlobalId, terminal_id || null, source || 'desktop'
              ]
            );

            console.log(`[RepartidorAssignments] 🔄 Inventario restaurado (cancelación): ${prod.descripcion} ${stockBefore} → ${stockAfter} (+${qty})`);

            if (io) {
              try {
                const branches = await pool.query(
                  'SELECT id FROM branches WHERE tenant_id = $1 AND is_active = true', [tenant_id]
                );
                const p = prod;
                for (const b of branches.rows) {
                  const branchInv = await getBranchInventarioForEmit(
                    pool, tenant_id, b.id, p.global_id, parseFloat(p.inventario)
                  );
                  const productPayload = {
                    id_producto: String(p.id), global_id: p.global_id,
                    descripcion: p.descripcion, inventario: branchInv,
                    precio_venta: parseFloat(p.precio_venta || 0), inventariar: p.inventariar,
                    pesable: p.bascula, unidad_medida: p.unidad_medida_id,
                    action: 'updated', updatedAt: new Date().toISOString()
                  };
                  io.to(`branch_${b.id}`).emit('product_updated', productPayload);
                }
                const kardexPayload = {
                  entries: [{
                    global_id: kardexGlobalId, product_global_id: prod.global_id,
                    product_id: resolvedProductId, descripcion: prod.descripcion,
                    movement_type: 'CancelacionAsignacion',
                    quantity_before: stockBefore, quantity_change: qty, quantity_after: stockAfter,
                    description: `Cancelación asignación: ${product_name || prod.descripcion} +${qty}`,
                    employee_global_id: cancelled_by_employee_global_id || created_by_employee_global_id,
                    timestamp: new Date().toISOString(), source: source || 'desktop'
                  }]
                };
                for (const b of branches.rows) {
                  io.to(`branch_${b.id}`).emit('kardex_entries_created', kardexPayload);
                }
              } catch (emitErr) {
                console.error('[RepartidorAssignments] ⚠️ Error emitting cancel socket events:', emitErr.message);
              }
            }
          }
        } catch (invErr) {
          console.error('[RepartidorAssignments] ⚠️ Error restaurando inventario (cancelación):', invErr.message);
        }
      }

      // ═══════════════════════════════════════════════════════════════════════════════
      // 🆕 ACTUALIZAR VENTA: tipo_pago_id cuando se liquida con método de pago específico
      // Esto es CRÍTICO para que el corte de caja calcule correctamente efectivo/tarjeta/crédito
      // ═══════════════════════════════════════════════════════════════════════════════
      // Determinar si hay info de pago (payment_method_id O montos de pago)
      const hasPaymentInfo = payment_method_id || cash_amount || card_amount || credit_amount;

      if (status === 'liquidated' && resolvedVentaId && hasPaymentInfo) {
        try {
          // Recalcular totales de TODAS las asignaciones liquidadas de esta venta
          const assignmentTotals = await pool.query(
            `SELECT
               COALESCE(SUM(cash_amount), 0) as total_cash,
               COALESCE(SUM(card_amount), 0) as total_card,
               COALESCE(SUM(credit_amount), 0) as total_credit,
               COALESCE(SUM(amount_received), 0) as total_amount
             FROM repartidor_assignments
             WHERE venta_id = $1 AND tenant_id = $2 AND status = 'liquidated'`,
            [resolvedVentaId, tenant_id]
          );

          const totals = assignmentTotals.rows[0];
          const totalPagado = parseFloat(totals.total_cash) + parseFloat(totals.total_card);
          const totalCredito = parseFloat(totals.total_credit);
          const totalVenta = parseFloat(totals.total_amount);

          // Redeterminar tipo_pago_id basado en totales de TODAS las asignaciones
          const ventaHasCash = parseFloat(totals.total_cash) > 0;
          const ventaHasCard = parseFloat(totals.total_card) > 0;
          const ventaHasCredit = parseFloat(totals.total_credit) > 0;
          const ventaPaymentTypes = [ventaHasCash, ventaHasCard, ventaHasCredit].filter(Boolean).length;

          let finalTipoPagoId;
          if (ventaPaymentTypes > 1) {
            finalTipoPagoId = 4; // Mixto
          } else if (ventaHasCredit && !ventaHasCash && !ventaHasCard) {
            finalTipoPagoId = 3; // Crédito
          } else if (ventaHasCard && !ventaHasCash && !ventaHasCredit) {
            finalTipoPagoId = 2; // Tarjeta
          } else {
            finalTipoPagoId = 1; // Efectivo (default)
          }

          // Leer credito_original ANTES del update para calcular delta
          const prevVentaResult = await pool.query(
            `SELECT id_cliente, COALESCE(credito_original, 0) as old_credito
             FROM ventas WHERE id_venta = $1 AND tenant_id = $2`,
            [resolvedVentaId, tenant_id]
          );
          const oldCredito = parseFloat(prevVentaResult.rows[0]?.old_credito || 0);
          const ventaClienteId = prevVentaResult.rows[0]?.id_cliente;

          // Actualizar la venta con totales recalculados
          const updateVentaResult = await pool.query(
            `UPDATE ventas
             SET tipo_pago_id = $1,
                 monto_pagado = $2,
                 total = CASE WHEN $5 > 0 THEN $5 ELSE total END,
                 credito_original = $6,
                 estado_venta_id = 5,
                 updated_at = NOW()
             WHERE id_venta = $3 AND tenant_id = $4
             RETURNING id_venta, tipo_pago_id, monto_pagado, total`,
            [finalTipoPagoId, totalPagado, resolvedVentaId, tenant_id, totalVenta, totalCredito]
          );

          if (updateVentaResult.rows.length > 0) {
            const v = updateVentaResult.rows[0];
            console.log(`[RepartidorAssignments] 💰 Venta #${resolvedVentaId} actualizada:`);
            console.log(`   tipo_pago_id=${finalTipoPagoId} | monto_pagado=$${totalPagado.toFixed(2)} | credito=$${totalCredito.toFixed(2)}`);

            // ═══════════════════════════════════════════════════════════════════
            // 💳 ACTUALIZAR SALDO DE CLIENTE cuando liquidación incluye crédito
            // El trigger update_customer_balance solo funciona en INSERT de ventas
            // con tipo_pago_id=3, pero la venta ya existía como tipo_pago_id=1
            // al crear la asignación. Debemos actualizar manualmente.
            // ═══════════════════════════════════════════════════════════════════
            if (totalCredito > 0 && ventaClienteId) {
              const creditDelta = totalCredito - oldCredito;
              if (creditDelta !== 0) {
                try {
                  if (creditDelta > 0) {
                    await pool.query(
                      `UPDATE customers
                       SET saldo_deudor = saldo_deudor + $1, updated_at = NOW()
                       WHERE id = $2 AND tenant_id = $3`,
                      [creditDelta, ventaClienteId, tenant_id]
                    );
                  } else {
                    await pool.query(
                      `UPDATE customers
                       SET saldo_deudor = GREATEST(saldo_deudor + $1, 0), updated_at = NOW()
                       WHERE id = $2 AND tenant_id = $3`,
                      [creditDelta, ventaClienteId, tenant_id]
                    );
                  }
                  console.log(`[RepartidorAssignments] 💳 Cliente #${ventaClienteId} saldo actualizado: ${creditDelta > 0 ? '+' : ''}$${creditDelta.toFixed(2)} (prev=$${oldCredito.toFixed(2)}, total=$${totalCredito.toFixed(2)})`);
                } catch (creditErr) {
                  console.error(`[RepartidorAssignments] ⚠️ Error actualizando saldo cliente:`, creditErr.message);
                }
              }
            } else if (totalCredito > 0 && !ventaClienteId) {
              console.warn(`[RepartidorAssignments] ⚠️ Liquidación a crédito pero venta #${resolvedVentaId} no tiene id_cliente`);
            }
          }
        } catch (ventaUpdateError) {
          // No fallar la liquidación si la actualización de venta falla
          console.error(`[RepartidorAssignments] ⚠️ Error actualizando venta ${resolvedVentaId}:`, ventaUpdateError.message);
        }
      }

      // Emitir evento en tiempo real
      if (wasInserted) {
        // Nueva asignación - siempre emitir para notificar a móvil
        // ✅ Enriquecer con global_ids para que Desktop pueda resolver entidades locales
        const enrichedAssignment = {
          ...assignment,
          employee_global_id: employee_global_id || null,
          created_by_employee_global_id: created_by_employee_global_id || null,
          product_global_id: product_global_id || null
        };
        console.log(`[RepartidorAssignments] 📡 assignment_created emitido a branch_${branch_id}: id=${assignment.id}, employee_id=${assignment.employee_id}, source=${source}`);
        io.to(`branch_${branch_id}`).emit('assignment_created', {
          assignment: enrichedAssignment,
          timestamp: new Date().toISOString()
        });
      } else {
        // Asignación actualizada (ej: liquidada)
        // ✅ CRÍTICO: Notificar a la app móvil cuando se liquida desde desktop
        const enrichedAssignment = {
          ...assignment,
          employee_global_id: employee_global_id || null,
          created_by_employee_global_id: created_by_employee_global_id || null,
          product_global_id: product_global_id || null
        };
        io.to(`branch_${branch_id}`).emit('assignment_updated', {
          assignment: enrichedAssignment,
          previousStatus: status !== 'liquidated' ? 'pending' : null,
          isLiquidation: status === 'liquidated',
          timestamp: new Date().toISOString()
        });
        console.log(`[RepartidorAssignments] 📡 assignment_updated emitido: ${assignment.id} -> ${status}`);
      }

      // 🆕 Enviar notificación push SOLO si es una asignación NUEVA (no actualización)
      // ✅ Y SOLO si suppress_notification es false/undefined (anti-spam para operaciones batch)
      if (wasInserted && !suppress_notification) {
        try {
          // Obtener nombre de la sucursal
          const branchResult = await pool.query(
            'SELECT name FROM branches WHERE id = $1',
            [branch_id]
          );
          const branchName = branchResult.rows[0]?.name || 'Sucursal';

          // Obtener nombre del repartidor (usando ID resuelto)
          const employeeResult = await pool.query(
            "SELECT CONCAT(first_name, ' ', last_name) as full_name FROM employees WHERE id = $1",
            [resolvedEmployeeId]
          );
          const employeeName = employeeResult.rows[0]?.full_name || 'Repartidor';

          // Obtener nombre del empleado que autorizó la asignación (usando ID resuelto)
          const createdByResult = await pool.query(
            "SELECT CONCAT(first_name, ' ', last_name) as full_name FROM employees WHERE id = $1",
            [resolvedCreatedByEmployeeId]
          );
          const createdByName = createdByResult.rows[0]?.full_name || 'Empleado';

          // Determinar si es asignación consolidada (con venta) o individual (sin venta)
          let notificationData;

          if (resolvedVentaId) {
            // ✅ CONSOLIDADA: Múltiples productos en una venta - incluir desglose
            const totalsResult = await pool.query(
              `SELECT COUNT(*) as item_count, COALESCE(SUM(assigned_amount), 0) as total_amount
               FROM repartidor_assignments
               WHERE venta_id = $1 AND tenant_id = $2`,
              [resolvedVentaId, tenant_id]
            );
            const totalItems = parseInt(totalsResult.rows[0]?.item_count) || 1;
            const totalAmount = parseFloat(totalsResult.rows[0]?.total_amount) || parseFloat(assigned_amount);

            // Obtener desglose de productos para el mensaje
            const itemsResult = await pool.query(
              `SELECT product_name, assigned_quantity, unit_abbreviation, assigned_amount
               FROM repartidor_assignments
               WHERE venta_id = $1 AND tenant_id = $2
               ORDER BY id`,
              [resolvedVentaId, tenant_id]
            );
            const itemsBreakdown = itemsResult.rows.map(row => {
              const qty = parseFloat(row.assigned_quantity).toFixed(2);
              const unit = row.unit_abbreviation || 'kg';
              return `• ${qty} ${unit} - ${row.product_name}`;
            });

            console.log(`[RepartidorAssignments] 📨 Enviando notificación para venta #${resolvedVentaId} (${totalItems} item(s))`);
            console.log(`   📦 Total: ${totalItems} producto(s), Monto total: $${totalAmount.toFixed(2)}`);

            if (totalItems === 1 && itemsResult.rows.length === 1) {
              // Un solo producto con venta: usar datos reales del producto
              const singleItem = itemsResult.rows[0];
              notificationData = {
                assignmentId: assignment.id,
                quantity: parseFloat(singleItem.assigned_quantity),
                amount: parseFloat(singleItem.assigned_amount),
                unitAbbreviation: singleItem.unit_abbreviation || 'kg',
                productName: singleItem.product_name,
                branchName,
                branchId: branch_id,
                employeeName,
                createdByName,
                isConsolidated: false,
                itemCount: 1
              };
            } else {
              // Múltiples productos: notificación consolidada con desglose
              notificationData = {
                assignmentId: assignment.id,
                quantity: totalItems,
                amount: totalAmount,
                branchName,
                branchId: branch_id,
                employeeName,
                createdByName,
                isConsolidated: true,
                itemCount: totalItems,
                itemsBreakdown
              };
            }
          } else {
            // ✅ INDIVIDUAL: Un solo producto sin venta asociada
            console.log(`[RepartidorAssignments] 📨 Enviando notificación INDIVIDUAL`);
            console.log(`   📦 Producto: ${product_name}, Cantidad: ${assigned_quantity} ${unit_abbreviation || 'kg'}, Monto: $${parseFloat(assigned_amount).toFixed(2)}`);

            notificationData = {
              assignmentId: assignment.id,
              quantity: parseFloat(assigned_quantity),    // Cantidad REAL del producto
              amount: parseFloat(assigned_amount),
              unitAbbreviation: unit_abbreviation || 'kg', // Unidad de medida
              productName: product_name,
              branchName,
              branchId: branch_id,
              employeeName,
              createdByName,
              isConsolidated: false,
              itemCount: 1
            };
          }

          console.log(`   Repartidor: ${employeeName} (GlobalId: ${employee_global_id})`);
          console.log(`   Autorizado por: ${createdByName} (GlobalId: ${created_by_employee_global_id})`);

          // Enviar notificaciones usando GlobalId (UUID) para idempotencia
          await notifyAssignmentCreated(employee_global_id, notificationData);

          console.log(`[RepartidorAssignments] ✅ Notificaciones enviadas exitosamente`);
        } catch (notifError) {
          console.error('[RepartidorAssignments] ⚠️ Error enviando notificación push:', notifError.message);
          // No fallar la operación si la notificación falla
        }
      } else if (wasInserted && suppress_notification) {
        console.log(`[RepartidorAssignments] 🔕 Notificación SUPRIMIDA (batch mode): GlobalId=${global_id}`);
      } else {
        console.log(`[RepartidorAssignments] ℹ️ Asignación actualizada (no se envía notificación): GlobalId=${global_id}, Status=${status}`);
      }

      console.log(`[RepartidorAssignments] ✅ Assignment synced: ${product_name || 'N/A'} - ${assignment.assigned_quantity} ${unit_abbreviation || 'kg'}, GlobalId: ${global_id}`);

      res.status(201).json({
        success: true,
        data: assignment,
        message: 'Asignación sincronizada exitosamente'
      });

    } catch (error) {
      console.error('[RepartidorAssignments] ❌ Error sincronizando asignación:', error.message);
      console.error(error.stack);
      res.status(500).json({
        success: false,
        message: 'Error al sincronizar asignación de repartidor',
        error: undefined
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/repartidor-assignments/:id/liquidate
  // Liquidar una asignación (procesar devoluciones y entregar dinero)
  // ═══════════════════════════════════════════════════════════════
  router.post('/:id/liquidate', async (req, res) => {
    const { id } = req.params;
    const {
      cantidad_devuelta,
      monto_devuelto,
      total_gastos,
      neto_a_entregar,
      diferencia_dinero,
      observaciones
    } = req.body;

    const client = await pool.connect();

    try {
      console.log('[API] 💰 POST /api/repartidor-assignments/:id/liquidate - Liquidar asignación');
      console.log(`  Assignment ID: ${id}, Devuelto: ${cantidad_devuelta}, Diferencia: $${diferencia_dinero}`);

      // Obtener asignación actual
      const assignmentQuery = `
        SELECT * FROM repartidor_assignments WHERE id = $1
      `;
      const assignmentResult = await client.query(assignmentQuery, [id]);

      if (assignmentResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Asignación no encontrada'
        });
      }

      const assignment = assignmentResult.rows[0];
      const { employee_id, branch_id, tenant_id, cantidad_asignada, monto_asignado } = assignment;

      // Iniciar transacción
      await client.query('BEGIN');

      // 1. Actualizar asignación con devoluciones
      const updateAssignmentQuery = `
        UPDATE repartidor_assignments
        SET cantidad_devuelta = $1,
            monto_devuelto = $2,
            estado = CASE
              WHEN $1::NUMERIC = 0 THEN 'completada'
              WHEN $1::NUMERIC > 0 AND $1::NUMERIC < cantidad_asignada THEN 'parcialmente_devuelta'
              ELSE 'devuelta_completa'
            END,
            fecha_devoluciones = CURRENT_TIMESTAMP,
            fecha_liquidacion = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *
      `;

      const updateResult = await client.query(updateAssignmentQuery, [
        cantidad_devuelta,
        monto_devuelto,
        id
      ]);

      const updatedAssignment = updateResult.rows[0];

      // 2. Crear registro de liquidación
      const liquidationQuery = `
        INSERT INTO repartidor_liquidations (
          employee_id, branch_id, tenant_id,
          total_kilos_asignados, total_kilos_devueltos,
          monto_total_asignado, monto_total_devuelto,
          total_gastos, neto_a_entregar, diferencia_dinero,
          observaciones, fecha_liquidacion
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP
        )
        RETURNING id, employee_id, total_kilos_asignados, total_kilos_vendidos,
                  neto_a_entregar, diferencia_dinero
      `;

      const liquidationResult = await client.query(liquidationQuery, [
        employee_id,
        branch_id,
        tenant_id,
        cantidad_asignada,
        cantidad_devuelta,
        monto_asignado,
        monto_devuelto,
        total_gastos || 0,
        neto_a_entregar,
        diferencia_dinero || 0,
        observaciones
      ]);

      const liquidation = liquidationResult.rows[0];

      // 3. Si hay deuda (diferencia negativa), crear registro de deuda
      if (diferencia_dinero && diferencia_dinero < 0) {
        const debtQuery = `
          INSERT INTO repartidor_debts (
            employee_id, branch_id, tenant_id, liquidation_id,
            monto_deuda, estado, fecha_deuda
          ) VALUES (
            $1, $2, $3, $4, $5, 'pendiente', CURRENT_TIMESTAMP
          )
          RETURNING id, monto_deuda, estado
        `;

        const debtResult = await client.query(debtQuery, [
          employee_id,
          branch_id,
          tenant_id,
          liquidation.id,
          Math.abs(diferencia_dinero)
        ]);

        console.log(`⚠️  Deuda registrada: ID=${debtResult.rows[0].id}, Monto=$${debtResult.rows[0].monto_deuda}`);
      }

      // 4. Restaurar inventario por devolución del repartidor
      if (parseFloat(cantidad_devuelta) > 0 && assignment.product_id) {
        try {
          const prodCheck = await client.query(
            `SELECT id, global_id, inventariar, inventario, descripcion FROM productos WHERE id = $1 AND tenant_id = $2`,
            [assignment.product_id, tenant_id]
          );
          const prod = prodCheck.rows[0];
          if (prod && prod.inventariar) {
            const returnQty = parseFloat(cantidad_devuelta);

            const { stockBefore, stockAfter } = await restoreBranchStock(
              client, tenant_id, branch_id,
              prod.global_id, returnQty,
              parseFloat(prod.inventario)
            );

            const kardexGlobalId = require('crypto').randomUUID();
            await client.query(
              `INSERT INTO kardex_entries (
                  tenant_id, branch_id, product_id, product_global_id,
                  timestamp, movement_type, employee_id,
                  quantity_before, quantity_change, quantity_after,
                  description, global_id, source
              ) VALUES ($1, $2, $3, $4, NOW(), 'DevolucionRepartidor', $5, $6, $7, $8, $9, $10, 'server')
              ON CONFLICT (global_id) DO NOTHING`,
              [
                tenant_id, branch_id, assignment.product_id, prod.global_id,
                employee_id,
                stockBefore, returnQty, stockAfter,
                `Devolución repartidor: ${prod.descripcion} +${returnQty}`,
                kardexGlobalId
              ]
            );

            console.log(`[RepartidorAssignments] 🔄 Inventario restaurado (devolución): ${prod.descripcion} ${stockBefore} → ${stockAfter} (+${returnQty})`);
          }
        } catch (invErr) {
          console.error('[RepartidorAssignments] ⚠️ Error restaurando inventario (liquidación):', invErr.message);
        }
      }

      // Confirmar transacción
      await client.query('COMMIT');

      // Emitir evento en tiempo real
      io.to(`branch_${branch_id}`).emit('assignment_liquidated', {
        assignment: updatedAssignment,
        liquidation,
        timestamp: new Date().toISOString()
      });

      // Emitir product_updated si se devolvió inventario
      if (parseFloat(cantidad_devuelta) > 0 && assignment.product_id) {
        try {
          const branches = await pool.query(
            'SELECT id FROM branches WHERE tenant_id = $1 AND is_active = true', [tenant_id]
          );
          const prodForEmit = await pool.query(
            `SELECT id, global_id, descripcion, inventario, precio_venta, inventariar, bascula, unidad_medida_id
             FROM productos WHERE id = $1`, [assignment.product_id]
          );
          if (prodForEmit.rows.length > 0) {
            const p = prodForEmit.rows[0];
            for (const b of branches.rows) {
              const branchInv = await getBranchInventarioForEmit(
                pool, tenant_id, b.id, p.global_id, parseFloat(p.inventario)
              );
              const productPayload = {
                id_producto: String(p.id), global_id: p.global_id,
                descripcion: p.descripcion, inventario: branchInv,
                precio_venta: parseFloat(p.precio_venta), inventariar: p.inventariar,
                pesable: p.bascula, unidad_medida: p.unidad_medida_id,
                action: 'updated', updatedAt: new Date().toISOString()
              };
              io.to(`branch_${b.id}`).emit('product_updated', productPayload);
            }
            console.log(`[RepartidorAssignments] 📡 product_updated emitido (devolución)`);
          }
        } catch (emitErr) {
          console.error('[RepartidorAssignments] ⚠️ Error emitting liquidation socket events:', emitErr.message);
        }
      }

      console.log(`✅ Liquidación completada: ID=${liquidation.id}, Neto=$${neto_a_entregar}`);

      res.json({
        success: true,
        data: {
          assignment: updatedAssignment,
          liquidation
        },
        message: 'Liquidación completada exitosamente'
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error liquidando asignación:', error.message);
      res.status(500).json({
        success: false,
        error: undefined
      });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-assignments/employee/:employeeId
  // Obtener asignaciones de un repartidor (usado por Desktop para pull)
  // Soporta filtro por repartidor_shift_id para obtener solo del turno actual
  // ═══════════════════════════════════════════════════════════════
  router.get('/employee/:employeeId', async (req, res) => {
    const { employeeId } = req.params;
    const { branch_id, tenant_id, estado, repartidor_shift_id, repartidor_shift_global_id } = req.query;

    try {
      console.log('[API] 📊 GET /api/repartidor-assignments/employee/:employeeId');
      console.log(`  Query params: employeeId=${employeeId}, branch_id=${branch_id}, tenant_id=${tenant_id}, estado=${estado}`);
      console.log(`  Shift filter: repartidor_shift_id=${repartidor_shift_id}, repartidor_shift_global_id=${repartidor_shift_global_id}`);

      // ✅ Campos completos para Desktop pull (incluyendo GlobalIds para offline-first)
      let query = `
        SELECT
          ra.id,
          ra.tenant_id,
          ra.branch_id,
          ra.venta_id,
          ra.employee_id,
          ra.created_by_employee_id,
          ra.shift_id,
          ra.repartidor_shift_id,
          ra.product_id,
          ra.product_name,
          ra.venta_detalle_id,
          ra.assigned_quantity,
          ra.assigned_amount,
          ra.unit_price,
          COALESCE(ra.unit_abbreviation, 'kg') as unit_abbreviation,
          ra.status,
          ra.fecha_asignacion,
          ra.fecha_liquidacion,
          ra.observaciones,
          ra.global_id,
          ra.terminal_id,
          ra.local_op_seq,
          ra.created_local_utc,
          ra.device_event_raw,
          -- Payment fields
          ra.payment_method_id,
          ra.cash_amount,
          ra.card_amount,
          ra.credit_amount,
          ra.amount_received,
          ra.is_credit,
          ra.payment_reference,
          ra.liquidated_by_employee_id,
          ra.source,
          -- Joins para display
          CONCAT(e.first_name, ' ', e.last_name) as employee_name,
          b.name as branch_name,
          -- GlobalIds para resolución
          v.global_id as venta_global_id,
          e.global_id as employee_global_id,
          cb.global_id as created_by_employee_global_id,
          s.global_id as shift_global_id,
          rs.global_id as repartidor_shift_global_id,
          pr.global_id as product_global_id
        FROM repartidor_assignments ra
        LEFT JOIN employees e ON e.id = ra.employee_id
        LEFT JOIN employees cb ON cb.id = ra.created_by_employee_id
        LEFT JOIN branches b ON b.id = ra.branch_id
        LEFT JOIN ventas v ON v.id_venta = ra.venta_id
        LEFT JOIN shifts s ON s.id = ra.shift_id
        LEFT JOIN shifts rs ON rs.id = ra.repartidor_shift_id
        LEFT JOIN productos pr ON pr.id = ra.product_id
        WHERE ra.employee_id = $1
      `;

      const params = [employeeId];

      if (branch_id) {
        query += ` AND ra.branch_id = $${params.length + 1}`;
        params.push(branch_id);
      }

      // FIX: Only filter by tenant_id if it's provided and not 0
      if (tenant_id && tenant_id !== '0' && Number(tenant_id) !== 0) {
        query += ` AND ra.tenant_id = $${params.length + 1}`;
        params.push(tenant_id);
      }

      if (estado) {
        query += ` AND ra.status = $${params.length + 1}`;
        params.push(estado);
      }

      // ✅ Filtro por turno del repartidor (crítico para Desktop)
      if (repartidor_shift_id) {
        query += ` AND ra.repartidor_shift_id = $${params.length + 1}`;
        params.push(repartidor_shift_id);
      } else if (repartidor_shift_global_id) {
        query += ` AND rs.global_id = $${params.length + 1}`;
        params.push(repartidor_shift_global_id);
      }

      query += ` ORDER BY ra.fecha_asignacion DESC`;

      console.log('[API] 🔍 Executing query with params:', params);
      const result = await pool.query(query, params);

      console.log(`[API] ✅ Query returned ${result.rows.length} assignments`);
      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length
      });

    } catch (error) {
      console.error('❌ Error obteniendo asignaciones:', error.message);
      res.status(500).json({
        success: false,
        error: undefined
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-assignments/by-employee-global
  // Obtener asignaciones usando employee_global_id (UUID) en lugar de ID numérico
  // IMPORTANTE: NO filtra por turno, permite sync entre múltiples PCs
  // ═══════════════════════════════════════════════════════════════
  router.get('/by-employee-global', async (req, res) => {
    const { employee_global_id, branch_id, status } = req.query;

    if (!employee_global_id) {
      return res.status(400).json({
        success: false,
        error: 'employee_global_id is required'
      });
    }

    try {
      console.log('[API] 📊 GET /api/repartidor-assignments/by-employee-global');
      console.log(`  Query params: employee_global_id=${employee_global_id}, branch_id=${branch_id}, status=${status}`);

      // Primero obtener el employee_id desde el global_id
      const empResult = await pool.query(
        'SELECT id FROM employees WHERE global_id = $1',
        [employee_global_id]
      );

      if (empResult.rows.length === 0) {
        console.log(`[API] ⚠️ Employee not found with global_id: ${employee_global_id}`);
        return res.json({
          success: true,
          data: [],
          count: 0
        });
      }

      const employeeId = empResult.rows[0].id;
      console.log(`[API] 🔗 Resolved employee_global_id ${employee_global_id} -> employee_id ${employeeId}`);

      // Construir query sin filtro de turno
      let query = `
        SELECT
          ra.id,
          ra.tenant_id,
          ra.branch_id,
          ra.venta_id,
          ra.employee_id,
          ra.created_by_employee_id,
          ra.shift_id,
          ra.repartidor_shift_id,
          ra.product_id,
          ra.product_name,
          ra.venta_detalle_id,
          ra.assigned_quantity,
          ra.assigned_amount,
          ra.unit_price,
          COALESCE(ra.unit_abbreviation, 'kg') as unit_abbreviation,
          ra.status,
          ra.fecha_asignacion,
          ra.fecha_liquidacion,
          ra.observaciones,
          ra.global_id,
          ra.terminal_id,
          ra.source,
          -- GlobalIds para resolución
          e.global_id as employee_global_id,
          cb.global_id as created_by_employee_global_id,
          pr.global_id as product_global_id
        FROM repartidor_assignments ra
        LEFT JOIN employees e ON e.id = ra.employee_id
        LEFT JOIN employees cb ON cb.id = ra.created_by_employee_id
        LEFT JOIN productos pr ON pr.id = ra.product_id
        WHERE ra.employee_id = $1
      `;

      const params = [employeeId];

      if (branch_id) {
        query += ` AND ra.branch_id = $${params.length + 1}`;
        params.push(branch_id);
      }

      if (status) {
        query += ` AND ra.status = $${params.length + 1}`;
        params.push(status);
      }

      query += ` ORDER BY ra.fecha_asignacion DESC`;

      console.log('[API] 🔍 Executing query with params:', params);
      const result = await pool.query(query, params);

      console.log(`[API] ✅ Query returned ${result.rows.length} assignments`);
      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length
      });

    } catch (error) {
      console.error('❌ Error obteniendo asignaciones por global_id:', error.message);
      res.status(500).json({
        success: false,
        error: undefined
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-liquidations/employee/:employeeId
  // Obtener historial de liquidaciones de un repartidor
  // ═══════════════════════════════════════════════════════════════
  router.get('/liquidations/employee/:employeeId', async (req, res) => {
    const { employeeId } = req.params;
    const { branch_id, tenant_id, limit = 50, offset = 0 } = req.query;

    try {
      console.log('[API] 📋 GET /api/repartidor-liquidations/employee/:employeeId');
      console.log(`  Query params: employeeId=${employeeId}, branch_id=${branch_id}, tenant_id=${tenant_id}, limit=${limit}, offset=${offset}`);

      let query = `
        SELECT
          rl.id,
          rl.employee_id,
          CONCAT(e.first_name, ' ', e.last_name) as employee_name,
          rl.branch_id,
          b.name as branch_name,
          rl.total_kilos_asignados,
          rl.total_kilos_devueltos,
          rl.total_kilos_vendidos,
          rl.monto_total_asignado,
          rl.monto_total_devuelto,
          rl.monto_total_vendido,
          rl.total_gastos,
          rl.neto_a_entregar,
          rl.diferencia_dinero,
          rl.fecha_liquidacion,
          rl.observaciones,
          (SELECT COUNT(*) FROM repartidor_debts WHERE liquidation_id = rl.id AND estado = 'pendiente') as deudas_pendientes
        FROM repartidor_liquidations rl
        LEFT JOIN employees e ON e.id = rl.employee_id
        LEFT JOIN branches b ON b.id = rl.branch_id
        WHERE rl.employee_id = $1
      `;

      const params = [employeeId];

      if (branch_id) {
        query += ` AND rl.branch_id = $${params.length + 1}`;
        params.push(branch_id);
      }

      // FIX: Only filter by tenant_id if it's provided and not 0
      // tenant_id=0 means "use any tenant" (for backwards compatibility with mobile app)
      if (tenant_id && tenant_id !== '0' && tenant_id !== 0) {
        query += ` AND rl.tenant_id = $${params.length + 1}`;
        params.push(tenant_id);
      }

      query += ` ORDER BY rl.fecha_liquidacion DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      console.log('[API] 🔍 Executing liquidations query with params:', params);
      const result = await pool.query(query, params);

      console.log(`[API] ✅ Liquidations query returned ${result.rows.length} records`);
      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length,
        pagination: { limit: parseInt(limit), offset: parseInt(offset) }
      });

    } catch (error) {
      console.error('❌ Error obteniendo liquidaciones:', error.message);
      res.status(500).json({
        success: false,
        error: undefined
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-liquidations/branch/:branchId/summary
  // Obtener resumen de liquidaciones por sucursal
  // ═══════════════════════════════════════════════════════════════
  router.get('/liquidations/branch/:branchId/summary', async (req, res) => {
    const { branchId } = req.params;
    const { tenant_id, date_from, date_to } = req.query;

    try {
      console.log('[API] 📊 GET /api/repartidor-liquidations/branch/:branchId/summary');
      console.log(`  Branch: ${branchId}, From: ${date_from}, To: ${date_to}`);

      let query = `
        SELECT
          rl.branch_id,
          b.name as branch_name,
          COUNT(*) as total_liquidaciones,
          SUM(rl.total_kilos_asignados) as total_kilos_asignados,
          SUM(rl.total_kilos_devueltos) as total_kilos_devueltos,
          SUM(rl.total_kilos_vendidos) as total_kilos_vendidos,
          SUM(rl.monto_total_asignado) as monto_total_asignado,
          SUM(rl.monto_total_devuelto) as monto_total_devuelto,
          SUM(rl.monto_total_vendido) as monto_total_vendido,
          SUM(rl.total_gastos) as total_gastos,
          SUM(rl.neto_a_entregar) as total_entregado,
          MIN(rl.fecha_liquidacion) as fecha_inicio,
          MAX(rl.fecha_liquidacion) as fecha_fin
        FROM repartidor_liquidations rl
        LEFT JOIN branches b ON b.id = rl.branch_id
        WHERE rl.branch_id = $1
      `;

      const params = [branchId];

      if (tenant_id) {
        query += ` AND rl.tenant_id = $${params.length + 1}`;
        params.push(tenant_id);
      }

      if (date_from) {
        query += ` AND rl.fecha_liquidacion >= $${params.length + 1}`;
        params.push(date_from);
      }

      if (date_to) {
        query += ` AND rl.fecha_liquidacion <= $${params.length + 1}`;
        params.push(date_to);
      }

      query += ` GROUP BY rl.branch_id, b.name`;

      const result = await pool.query(query, params);

      const summary = result.rows[0] || {
        total_liquidaciones: 0,
        total_kilos_asignados: 0,
        total_kilos_devueltos: 0,
        total_kilos_vendidos: 0,
        monto_total_asignado: 0,
        monto_total_devuelto: 0,
        monto_total_vendido: 0,
        total_gastos: 0,
        total_entregado: 0
      };

      res.json({
        success: true,
        data: summary
      });

    } catch (error) {
      console.error('❌ Error obteniendo resumen:', error.message);
      res.status(500).json({
        success: false,
        error: undefined
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-assignments/branch/:branchId/repartidores
  // Devuelve empleados con asignaciones activas (pending/in_progress)
  // en turnos abiertos de la sucursal. Usado por Desktop multi-caja
  // para mostrar la lista de repartidores en LiquidacionPage.
  // ═══════════════════════════════════════════════════════════════
  router.get('/branch/:branchId/repartidores', async (req, res) => {
    const { branchId } = req.params;
    const { tenant_id } = req.query;

    try {
      console.log(`[RepartidorAssignments] GET /branch/${branchId}/repartidores tenant=${tenant_id}`);

      const result = await pool.query(`
        SELECT
          e.id as employee_id,
          e.global_id as employee_global_id,
          CONCAT(e.first_name, ' ', e.last_name) as employee_name,
          s.id as shift_id,
          s.global_id as shift_global_id,
          s.start_time as shift_start_time,
          COUNT(*) FILTER (WHERE ra.status NOT IN ('liquidated', 'cancelled')) as pending_count,
          COUNT(*) FILTER (WHERE ra.status = 'liquidated') as liquidated_count,
          COUNT(*) as total_count
        FROM repartidor_assignments ra
        JOIN employees e ON e.id = ra.employee_id
        LEFT JOIN shifts s ON s.id = ra.repartidor_shift_id
        WHERE ra.branch_id = $1
          AND ra.status != 'cancelled'
          AND (s.end_time IS NULL OR s.id IS NULL)
        ${tenant_id ? 'AND ra.tenant_id = $2' : ''}
        GROUP BY e.id, e.global_id, e.first_name, e.last_name,
                 s.id, s.global_id, s.start_time
        HAVING COUNT(*) FILTER (WHERE ra.status NOT IN ('liquidated', 'cancelled')) > 0
            OR COUNT(*) FILTER (WHERE ra.status = 'liquidated') > 0
        ORDER BY COUNT(*) FILTER (WHERE ra.status NOT IN ('liquidated', 'cancelled')) DESC
      `, tenant_id ? [branchId, tenant_id] : [branchId]);

      console.log(`[RepartidorAssignments] Found ${result.rows.length} repartidores with assignments`);

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length
      });
    } catch (error) {
      console.error('[RepartidorAssignments] Error getting repartidores:', error.message);
      res.status(500).json({ success: false, error: undefined });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-assignments/branch/:branchId/summary
  // Obtener resumen de asignaciones por repartidor (kilos asignados, devueltos, vendidos)
  // ═══════════════════════════════════════════════════════════════
  router.get('/branch/:branchId/summary', async (req, res) => {
    const { branchId } = req.params;
    const { tenant_id, date_from, date_to } = req.query;

    try {
      console.log('[API] 📊 GET /api/repartidor-assignments/branch/:branchId/summary');
      console.log(`  Branch: ${branchId}, From: ${date_from}, To: ${date_to}`);

      let query = `
        SELECT
          ra.employee_id,
          CONCAT(e.first_name, ' ', e.last_name) as employee_name,
          COUNT(DISTINCT ra.id) as total_asignaciones,
          SUM(ra.cantidad_asignada) as kilos_asignados,
          COALESCE(SUM(rl.cantidad_devuelta), 0) as kilos_devueltos,
          SUM(ra.cantidad_asignada) - COALESCE(SUM(rl.cantidad_devuelta), 0) as kilos_vendidos,
          COALESCE(SUM(rl.gastos), 0) as gastos_totales,
          SUM(ra.monto_asignado) as monto_asignado,
          COALESCE(SUM(rl.monto_devuelto), 0) as monto_devuelto,
          SUM(ra.monto_asignado) - COALESCE(SUM(rl.monto_devuelto), 0) as monto_vendido
        FROM repartidor_assignments ra
        LEFT JOIN repartidor_liquidations rl ON ra.id = rl.assignment_id
        LEFT JOIN employees e ON ra.employee_id = e.id
        WHERE ra.branch_id = $1
      `;

      const params = [branchId];
      let paramIndex = 2;

      if (tenant_id) {
        query += ` AND ra.tenant_id = $${paramIndex}`;
        params.push(tenant_id);
        paramIndex++;
      }

      if (date_from) {
        query += ` AND ra.created_at::date >= $${paramIndex}::date`;
        params.push(date_from);
        paramIndex++;
      }

      if (date_to) {
        query += ` AND ra.created_at::date <= $${paramIndex}::date`;
        params.push(date_to);
        paramIndex++;
      }

      query += ` GROUP BY ra.employee_id, e.first_name, e.last_name ORDER BY kilos_asignados DESC`;

      const result = await pool.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length
      });

    } catch (error) {
      console.error('❌ Error obteniendo resumen de asignaciones:', error.message);
      res.status(500).json({
        success: false,
        error: undefined
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PATCH /api/repartidor-assignments/:globalId/change-client
  // Cambiar el cliente de una asignación (actualiza la venta asociada y recalcula precios)
  // ═══════════════════════════════════════════════════════════════
  router.patch('/:globalId/change-client', extractJwtData, async (req, res) => {
    const { globalId } = req.params;
    const { new_customer_id } = req.body;
    const tenant_id = req.jwtData?.tenantId;

    if (!new_customer_id) {
      return res.status(400).json({ success: false, message: 'new_customer_id es requerido' });
    }

    try {
      // 1. Buscar la asignación y su venta asociada
      const assignmentResult = await pool.query(
        `SELECT ra.id, ra.venta_id, ra.assigned_quantity, ra.assigned_amount, ra.unit_price, ra.status,
                ra.product_id, p.base_price, p.global_id as product_global_id
         FROM repartidor_assignments ra
         LEFT JOIN products p ON p.id = ra.product_id
         WHERE ra.global_id = $1 AND ra.tenant_id = $2`,
        [globalId, tenant_id]
      );

      if (assignmentResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Asignación no encontrada' });
      }

      const assignment = assignmentResult.rows[0];

      if (assignment.status === 'liquidated' || assignment.status === 'cancelled') {
        return res.status(400).json({ success: false, message: 'No se puede cambiar cliente en asignación liquidada o cancelada' });
      }

      // 2. Obtener datos del nuevo cliente (descuentos)
      const customerResult = await pool.query(
        `SELECT id, name, discount_percentage, tipo_descuento, monto_descuento_fijo, aplicar_redondeo
         FROM customers WHERE id = $1 AND tenant_id = $2`,
        [new_customer_id, tenant_id]
      );

      if (customerResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
      }

      const customer = customerResult.rows[0];

      // 3. Calcular nuevo precio según tipo de descuento del cliente
      let newUnitPrice = assignment.base_price || assignment.unit_price;
      const basePrice = assignment.base_price || assignment.unit_price;

      // Buscar precio especial por producto
      if (assignment.product_global_id) {
        const specialPrice = await pool.query(
          `SELECT special_price, discount_percentage FROM customer_product_prices
           WHERE customer_global_id = (SELECT global_id FROM customers WHERE id = $1)
             AND product_global_id = $2 AND is_active = true`,
          [new_customer_id, assignment.product_global_id]
        );
        if (specialPrice.rows.length > 0 && specialPrice.rows[0].special_price) {
          newUnitPrice = parseFloat(specialPrice.rows[0].special_price);
        } else if (specialPrice.rows.length > 0 && specialPrice.rows[0].discount_percentage > 0) {
          newUnitPrice = basePrice * (1 - specialPrice.rows[0].discount_percentage / 100);
        } else {
          // Aplicar descuento general del cliente
          switch (customer.tipo_descuento) {
            case 1: // Porcentaje
              newUnitPrice = basePrice * (1 - (customer.discount_percentage || 0) / 100);
              break;
            case 2: // Monto fijo
              newUnitPrice = basePrice - (customer.monto_descuento_fijo || 0);
              break;
            // tipo_descuento 3 = por producto (ya manejado arriba)
            default:
              newUnitPrice = basePrice;
          }
        }
      }

      if (customer.aplicar_redondeo) {
        newUnitPrice = Math.round(newUnitPrice);
      }
      newUnitPrice = Math.max(0, newUnitPrice);

      const newAmount = parseFloat((assignment.assigned_quantity * newUnitPrice).toFixed(2));

      // 4. Actualizar asignación
      await pool.query(
        `UPDATE repartidor_assignments
         SET unit_price = $1, assigned_amount = $2, needs_update = true,
             last_modified_local_utc = NOW()
         WHERE id = $3`,
        [newUnitPrice, newAmount, assignment.id]
      );

      // 5. Actualizar la venta asociada si existe
      if (assignment.venta_id) {
        await pool.query(
          `UPDATE ventas SET id_cliente = $1, needs_update = true WHERE id = $2 AND tenant_id = $3`,
          [new_customer_id, assignment.venta_id, tenant_id]
        );

        // Actualizar detalle de venta si hay product_id
        if (assignment.product_id) {
          await pool.query(
            `UPDATE venta_detalles
             SET precio_unitario = $1, total_linea = $2, needs_update = true
             WHERE venta_id = $3 AND producto_id = $4`,
            [newUnitPrice, newAmount, assignment.venta_id, assignment.product_id]
          );

          // Recalcular total de la venta
          await pool.query(
            `UPDATE ventas SET subtotal = sub.total, total = sub.total, needs_update = true
             FROM (SELECT SUM(total_linea) as total FROM venta_detalles WHERE venta_id = $1) sub
             WHERE ventas.id = $1`,
            [assignment.venta_id]
          );
        }
      }

      console.log(`[ChangeClient] ✅ Asignación ${globalId}: cliente cambiado a ${customer.name} (ID: ${new_customer_id}), precio: $${assignment.unit_price} → $${newUnitPrice}`);

      res.json({
        success: true,
        data: {
          assignment_global_id: globalId,
          new_customer_id: new_customer_id,
          new_customer_name: customer.name,
          new_unit_price: newUnitPrice,
          new_assigned_amount: newAmount,
          old_unit_price: assignment.unit_price,
          old_assigned_amount: parseFloat(assignment.assigned_amount),
        }
      });

    } catch (error) {
      console.error('[ChangeClient] ❌ Error:', error.message);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/repartidor-assignments/:globalId/cancel-liquidation
  // Cancelar una liquidación existente y revertir a 'pending'
  // Revierte crédito de cliente y tipo_pago de la venta
  // ═══════════════════════════════════════════════════════════════
  router.post('/:globalId/cancel-liquidation', extractJwtData, async (req, res) => {
    const { globalId } = req.params;
    const { cancel_reason, cancelled_by_employee_global_id } = req.body;
    const tenant_id = req.jwtData?.tenantId;

    if (!cancel_reason) {
      return res.status(400).json({ success: false, message: 'cancel_reason es requerido' });
    }
    if (!cancelled_by_employee_global_id) {
      return res.status(400).json({ success: false, message: 'cancelled_by_employee_global_id es requerido' });
    }
    if (!tenant_id) {
      return res.status(401).json({ success: false, message: 'Token JWT inválido o ausente' });
    }

    const client = await pool.connect();

    try {
      console.log('[CancelLiquidation] 🔄 POST /api/repartidor-assignments/:globalId/cancel-liquidation');
      console.log(`  global_id: ${globalId}, reason: ${cancel_reason}`);

      // 1. Buscar asignación y verificar status
      const assignmentResult = await client.query(
        `SELECT * FROM repartidor_assignments WHERE global_id = $1 AND tenant_id = $2`,
        [globalId, tenant_id]
      );

      if (assignmentResult.rows.length === 0) {
        client.release();
        return res.status(404).json({ success: false, message: 'Asignación no encontrada' });
      }

      const assignment = assignmentResult.rows[0];

      if (assignment.status !== 'liquidated') {
        client.release();
        return res.status(400).json({
          success: false,
          message: "Solo se pueden cancelar liquidaciones con status 'liquidated'"
        });
      }

      // 2. Resolver cancelled_by_employee_id desde global_id
      let cancelledByEmployeeId = null;
      try {
        const empResult = await client.query(
          `SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2`,
          [cancelled_by_employee_global_id, tenant_id]
        );
        if (empResult.rows.length > 0) {
          cancelledByEmployeeId = empResult.rows[0].id;
        }
      } catch (empErr) {
        console.warn('[CancelLiquidation] ⚠️ No se pudo resolver employee:', empErr.message);
      }

      await client.query('BEGIN');

      // 3. Revertir assignment a pending
      const updateResult = await client.query(
        `UPDATE repartidor_assignments
         SET status = 'pending',
             fecha_liquidacion = NULL,
             payment_method_id = NULL,
             cash_amount = NULL,
             card_amount = NULL,
             credit_amount = NULL,
             amount_received = NULL,
             is_credit = NULL,
             payment_reference = NULL,
             liquidated_by_employee_id = NULL,
             cancel_reason = $2,
             cancelled_at = NOW(),
             cancelled_by_employee_id = $3,
             updated_at = NOW()
         WHERE global_id = $1 AND tenant_id = $4
         RETURNING *`,
        [globalId, cancel_reason, cancelledByEmployeeId, tenant_id]
      );

      const updatedAssignment = updateResult.rows[0];
      console.log(`[CancelLiquidation] ✅ Asignación ${updatedAssignment.id} revertida a pending`);

      // 4. Revertir crédito de cliente si la asignación tenía crédito
      if (assignment.venta_id) {
        try {
          // Leer venta y su crédito actual
          const ventaResult = await client.query(
            `SELECT id_cliente, COALESCE(credito_original, 0) as old_credito
             FROM ventas WHERE id_venta = $1 AND tenant_id = $2`,
            [assignment.venta_id, tenant_id]
          );

          if (ventaResult.rows.length > 0) {
            const ventaClienteId = ventaResult.rows[0].id_cliente;
            const oldCredito = parseFloat(ventaResult.rows[0].old_credito);

            // Recalcular totales de TODAS las asignaciones liquidadas restantes (excluyendo la cancelada)
            const remainingTotals = await client.query(
              `SELECT
                 COALESCE(SUM(cash_amount), 0) as total_cash,
                 COALESCE(SUM(card_amount), 0) as total_card,
                 COALESCE(SUM(credit_amount), 0) as total_credit,
                 COALESCE(SUM(amount_received), 0) as total_amount
               FROM repartidor_assignments
               WHERE venta_id = $1 AND tenant_id = $2 AND status = 'liquidated'`,
              [assignment.venta_id, tenant_id]
            );

            const totals = remainingTotals.rows[0];
            const totalPagado = parseFloat(totals.total_cash) + parseFloat(totals.total_card);
            const totalCredito = parseFloat(totals.total_credit);
            const totalVenta = parseFloat(totals.total_amount);

            // Redeterminar tipo_pago_id basado en asignaciones restantes
            const ventaHasCash = parseFloat(totals.total_cash) > 0;
            const ventaHasCard = parseFloat(totals.total_card) > 0;
            const ventaHasCredit = parseFloat(totals.total_credit) > 0;
            const ventaPaymentTypes = [ventaHasCash, ventaHasCard, ventaHasCredit].filter(Boolean).length;

            let finalTipoPagoId;
            if (ventaPaymentTypes > 1) {
              finalTipoPagoId = 4; // Mixto
            } else if (ventaHasCredit && !ventaHasCash && !ventaHasCard) {
              finalTipoPagoId = 3; // Crédito
            } else if (ventaHasCard && !ventaHasCash && !ventaHasCredit) {
              finalTipoPagoId = 2; // Tarjeta
            } else {
              finalTipoPagoId = 1; // Efectivo (default)
            }

            // Actualizar la venta con totales recalculados
            await client.query(
              `UPDATE ventas
               SET tipo_pago_id = $1,
                   monto_pagado = $2,
                   total = CASE WHEN $5 > 0 THEN $5 ELSE total END,
                   credito_original = $6,
                   updated_at = NOW()
               WHERE id_venta = $3 AND tenant_id = $4`,
              [finalTipoPagoId, totalPagado, assignment.venta_id, tenant_id, totalVenta, totalCredito]
            );

            console.log(`[CancelLiquidation] 💰 Venta #${assignment.venta_id} actualizada: tipo_pago_id=${finalTipoPagoId}, monto_pagado=$${totalPagado.toFixed(2)}, credito=$${totalCredito.toFixed(2)}`);

            // Ajustar saldo de cliente si cambió el crédito
            if (ventaClienteId) {
              const creditDelta = totalCredito - oldCredito;
              if (creditDelta !== 0) {
                if (creditDelta < 0) {
                  // Crédito disminuyó → reducir saldo_deudor
                  await client.query(
                    `UPDATE customers
                     SET saldo_deudor = GREATEST(saldo_deudor + $1, 0), updated_at = NOW()
                     WHERE id = $2 AND tenant_id = $3`,
                    [creditDelta, ventaClienteId, tenant_id]
                  );
                } else {
                  // Crédito aumentó (caso raro en cancelación, pero por seguridad)
                  await client.query(
                    `UPDATE customers
                     SET saldo_deudor = saldo_deudor + $1, updated_at = NOW()
                     WHERE id = $2 AND tenant_id = $3`,
                    [creditDelta, ventaClienteId, tenant_id]
                  );
                }
                console.log(`[CancelLiquidation] 💳 Cliente #${ventaClienteId} saldo ajustado: ${creditDelta > 0 ? '+' : ''}$${creditDelta.toFixed(2)}`);
              }
            }
          }
        } catch (ventaErr) {
          console.error('[CancelLiquidation] ⚠️ Error revirtiendo crédito de venta:', ventaErr.message);
          // No fallar la cancelación por error en reversion de crédito
        }
      }

      await client.query('COMMIT');

      // 5. Emitir evento Socket.IO
      const branchId = updatedAssignment.branch_id;
      if (io && branchId) {
        io.to(`branch_${branchId}`).emit('assignment_updated', {
          assignment: updatedAssignment,
          previousStatus: 'liquidated',
          isLiquidationCancelled: true,
          timestamp: new Date().toISOString()
        });
        console.log(`[CancelLiquidation] 📡 assignment_updated emitido: ${updatedAssignment.id} -> pending (liquidation cancelled)`);
      }

      // 6. Respuesta exitosa
      res.json({
        success: true,
        message: 'Liquidación cancelada exitosamente',
        assignment: updatedAssignment
      });

    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[CancelLiquidation] ❌ Error:', error.message);
      res.status(500).json({ success: false, message: error.message });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = createRepartidorAssignmentRoutes;
