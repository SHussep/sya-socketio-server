/**
 * Rutas API para Devoluciones de Repartidores
 *
 * Endpoints:
 *   POST   /api/repartidor-returns/sync - Sincronizar devolución desde Desktop/Mobile
 *   GET    /api/repartidor-returns/assignment/:assignmentId - Obtener devoluciones por asignación
 *   GET    /api/repartidor-returns/employee/:employeeId - Obtener devoluciones por empleado
 */

const express = require('express');
const { pool } = require('../database');

function createRepartidorReturnRoutes(io) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════
  // POST /api/repartidor-returns/sync
  // Sincronizar una devolución individual desde Desktop o Mobile
  // Idempotente con global_id (3NF - sin redundancia)
  // ═══════════════════════════════════════════════════════════════
  router.post('/sync', async (req, res) => {
    const {
      tenant_id,
      branch_id,
      assignment_global_id,  // ✅ OFFLINE-FIRST: Usar GlobalId en lugar de ID numérico
      employee_id,
      registered_by_employee_id,
      shift_id,
      quantity,
      unit_price,
      amount,
      return_date,
      source,
      notes,
      // Offline-first fields
      global_id,
      terminal_id,
      local_op_seq,
      created_local_utc,
      device_event_raw
    } = req.body;

    try {
      console.log('[RepartidorReturns] 📦 POST /api/repartidor-returns/sync');
      console.log(`  GlobalId: ${global_id}, AssignmentGlobalId: ${assignment_global_id}, Quantity: ${quantity} kg, Source: ${source}`);

      // Validar campos requeridos
      if (!tenant_id || !branch_id || !assignment_global_id || !employee_id || !registered_by_employee_id) {
        return res.status(400).json({
          success: false,
          message: 'tenant_id, branch_id, assignment_global_id, employee_id, registered_by_employee_id son requeridos'
        });
      }

      if (!quantity || quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: 'quantity debe ser mayor que 0'
        });
      }

      if (!unit_price || unit_price <= 0) {
        return res.status(400).json({
          success: false,
          message: 'unit_price debe ser mayor que 0'
        });
      }

      if (!global_id) {
        return res.status(400).json({
          success: false,
          message: 'global_id es requerido para idempotencia'
        });
      }

      if (!source || !['desktop', 'mobile'].includes(source)) {
        return res.status(400).json({
          success: false,
          message: 'source debe ser "desktop" o "mobile"'
        });
      }

      // ✅ OFFLINE-FIRST: Buscar asignación por GlobalId en lugar de ID numérico
      const assignmentCheck = await pool.query(
        'SELECT id, assigned_quantity, unit_price, global_id FROM repartidor_assignments WHERE global_id = $1::uuid AND tenant_id = $2',
        [assignment_global_id, tenant_id]
      );

      if (assignmentCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Asignación con GlobalId ${assignment_global_id} no encontrada en tenant ${tenant_id}`
        });
      }

      const assignment = assignmentCheck.rows[0];
      const assignment_id = assignment.id;  // ID de PostgreSQL para la FK

      // Calcular amount si no viene (por seguridad)
      const calculatedAmount = parseFloat(quantity) * parseFloat(unit_price);
      const finalAmount = amount || calculatedAmount;

      // ✅ IDEMPOTENTE: Insertar con global_id único
      // ON CONFLICT: Si ya existe, actualizamos la información (por si hubo cambios)
      const query = `
        INSERT INTO repartidor_returns (
          tenant_id, branch_id, assignment_id, employee_id, registered_by_employee_id, shift_id,
          quantity, unit_price, amount, return_date, source, notes,
          global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13::uuid, $14::uuid, $15, $16, $17
        )
        ON CONFLICT (global_id, terminal_id) DO UPDATE
        SET quantity = EXCLUDED.quantity,
            amount = EXCLUDED.amount,
            notes = EXCLUDED.notes
        RETURNING *
      `;

      const result = await pool.query(query, [
        tenant_id,
        branch_id,
        assignment_id,
        employee_id,
        registered_by_employee_id,
        shift_id || null,
        parseFloat(quantity),
        parseFloat(unit_price),
        parseFloat(finalAmount),
        return_date || new Date().toISOString(),
        source,
        notes || null,
        global_id,
        terminal_id,
        local_op_seq || null,
        created_local_utc || new Date().toISOString(),
        device_event_raw || null
      ]);

      const returnRecord = result.rows[0];

      // Emitir evento en tiempo real
      io.to(`branch_${branch_id}`).emit('return_created', {
        return: returnRecord,
        assignment_id,
        timestamp: new Date().toISOString()
      });

      console.log(`[RepartidorReturns] ✅ Return synced: ${returnRecord.quantity} kg, GlobalId: ${global_id}, Source: ${source}`);

      res.status(201).json({
        success: true,
        data: returnRecord,
        message: 'Devolución sincronizada exitosamente'
      });

    } catch (error) {
      console.error('[RepartidorReturns] ❌ Error sincronizando devolución:', error.message);
      console.error(error.stack);
      res.status(500).json({
        success: false,
        message: 'Error al sincronizar devolución',
        error: error.message
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-returns/assignment/:assignmentId
  // Obtener todas las devoluciones de una asignación específica
  // ═══════════════════════════════════════════════════════════════
  router.get('/assignment/:assignmentId', async (req, res) => {
    const { assignmentId } = req.params;
    const { tenant_id } = req.query;

    try {
      console.log('[RepartidorReturns] 📊 GET /api/repartidor-returns/assignment/:assignmentId');
      console.log(`  AssignmentId: ${assignmentId}, TenantId: ${tenant_id}`);

      let query = `
        SELECT
          r.*,
          CONCAT(e.first_name, ' ', e.last_name) as employee_name,
          CONCAT(reg.first_name, ' ', reg.last_name) as registered_by_name
        FROM repartidor_returns r
        LEFT JOIN employees e ON e.id = r.employee_id
        LEFT JOIN employees reg ON reg.id = r.registered_by_employee_id
        WHERE r.assignment_id = $1
      `;

      const params = [assignmentId];

      if (tenant_id) {
        query += ` AND r.tenant_id = $2`;
        params.push(tenant_id);
      }

      query += ` ORDER BY r.return_date DESC`;

      const result = await pool.query(query, params);

      // Calcular totales
      const totalQuantity = result.rows.reduce((sum, r) => sum + parseFloat(r.quantity), 0);
      const totalAmount = result.rows.reduce((sum, r) => sum + parseFloat(r.amount), 0);

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length,
        totals: {
          total_quantity: totalQuantity,
          total_amount: totalAmount
        }
      });

    } catch (error) {
      console.error('[RepartidorReturns] ❌ Error obteniendo devoluciones:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-returns/employee/:employeeId
  // Obtener todas las devoluciones de un empleado (historial)
  // ═══════════════════════════════════════════════════════════════
  router.get('/employee/:employeeId', async (req, res) => {
    const { employeeId } = req.params;
    const { tenant_id, branch_id, limit = 50, offset = 0 } = req.query;

    try {
      console.log('[RepartidorReturns] 📊 GET /api/repartidor-returns/employee/:employeeId');
      console.log(`  EmployeeId: ${employeeId}, Limit: ${limit}, Offset: ${offset}`);

      let query = `
        SELECT
          r.*,
          a.venta_id,
          a.assigned_quantity,
          a.assigned_amount,
          reg.full_name as registered_by_name
        FROM repartidor_returns r
        LEFT JOIN repartidor_assignments a ON a.id = r.assignment_id
        LEFT JOIN employees reg ON reg.id = r.registered_by_employee_id
        WHERE r.employee_id = $1
      `;

      const params = [employeeId];
      let paramIndex = 2;

      if (tenant_id) {
        query += ` AND r.tenant_id = $${paramIndex}`;
        params.push(tenant_id);
        paramIndex++;
      }

      if (branch_id) {
        query += ` AND r.branch_id = $${paramIndex}`;
        params.push(branch_id);
        paramIndex++;
      }

      query += ` ORDER BY r.return_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length,
        pagination: { limit: parseInt(limit), offset: parseInt(offset) }
      });

    } catch (error) {
      console.error('[RepartidorReturns] ❌ Error obteniendo devoluciones por empleado:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = createRepartidorReturnRoutes;
