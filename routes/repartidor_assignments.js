/**
 * Rutas API para Asignaciones a Repartidores y Liquidaciones
 *
 * Endpoints:
 *   POST   /api/repartidor-assignments - Crear asignación
 *   POST   /api/repartidor-assignments/:id/liquidate - Liquidar asignación
 *   GET    /api/repartidor-assignments/employee/:employeeId - Obtener asignaciones de empleado
 *   GET    /api/repartidor-liquidations/employee/:employeeId - Obtener liquidaciones de empleado
 *   GET    /api/repartidor-liquidations/branch/:branchId/summary - Resumen por sucursal
 */

const express = require('express');
const { pool } = require('../database');

function createRepartidorAssignmentRoutes(io) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════
  // POST /api/repartidor-assignments/sync
  // Sincronizar asignación desde Desktop (idempotente con global_id)
  // Esquema normalizado 3NF - Sin redundancia
  // ═══════════════════════════════════════════════════════════════
  router.post('/sync', async (req, res) => {
    const {
      tenant_id,
      branch_id,
      id_venta,
      employee_id,
      created_by_employee_id,
      shift_id,
      repartidor_shift_id,
      assigned_quantity,
      assigned_amount,
      unit_price,
      status,
      fecha_asignacion,
      fecha_liquidacion,
      observaciones,
      // Offline-first fields
      global_id,
      terminal_id,
      local_op_seq,
      created_local_utc,
      device_event_raw
    } = req.body;

    try {
      console.log('[RepartidorAssignments] 📦 POST /api/repartidor-assignments/sync');
      console.log(`  GlobalId: ${global_id}, Repartidor: ${employee_id}, Venta: ${id_venta}, Quantity: ${assigned_quantity} kg`);

      // Validar campos requeridos
      if (!tenant_id || !branch_id || !id_venta || !employee_id || !created_by_employee_id || !shift_id) {
        return res.status(400).json({
          success: false,
          message: 'tenant_id, branch_id, id_venta, employee_id, created_by_employee_id, shift_id son requeridos'
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

      // Verificar que la venta existe
      const saleCheck = await pool.query(
        'SELECT id_venta FROM ventas WHERE id_venta = $1 AND tenant_id = $2',
        [id_venta, tenant_id]
      );

      if (saleCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: `Venta ${id_venta} no encontrada en tenant ${tenant_id}`
        });
      }

      // ✅ IDEMPOTENTE: Insertar con global_id único
      // ON CONFLICT: Solo se permiten updates de status, fecha_liquidacion, observaciones
      // Los datos originales (assigned_quantity, assigned_amount) NO cambian
      const query = `
        INSERT INTO repartidor_assignments (
          tenant_id, branch_id, id_venta, employee_id,
          created_by_employee_id, shift_id, repartidor_shift_id,
          assigned_quantity, assigned_amount, unit_price,
          status, fecha_asignacion, fecha_liquidacion, observaciones,
          global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15::uuid, $16::uuid, $17, $18, $19
        )
        ON CONFLICT (global_id) DO UPDATE
        SET status = EXCLUDED.status,
            fecha_liquidacion = EXCLUDED.fecha_liquidacion,
            observaciones = EXCLUDED.observaciones
        RETURNING *
      `;

      const result = await pool.query(query, [
        tenant_id,
        branch_id,
        id_venta,
        employee_id,
        created_by_employee_id,
        shift_id,
        repartidor_shift_id,
        parseFloat(assigned_quantity),
        parseFloat(assigned_amount),
        parseFloat(unit_price),
        status || 'pending',
        fecha_asignacion || new Date().toISOString(),
        fecha_liquidacion || null,
        observaciones || null,
        global_id,
        terminal_id,
        local_op_seq || null,
        created_local_utc || new Date().toISOString(),
        device_event_raw || null
      ]);

      const assignment = result.rows[0];

      // Emitir evento en tiempo real
      io.to(`branch_${branch_id}`).emit('assignment_created', {
        assignment,
        timestamp: new Date().toISOString()
      });

      console.log(`[RepartidorAssignments] ✅ Assignment synced: ${assignment.assigned_quantity} kg, GlobalId: ${global_id}`);

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
        error: error.message
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

      // Confirmar transacción
      await client.query('COMMIT');

      // Emitir evento en tiempo real
      io.to(`branch_${branch_id}`).emit('assignment_liquidated', {
        assignment: updatedAssignment,
        liquidation,
        timestamp: new Date().toISOString()
      });

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
        error: error.message
      });
    } finally {
      client.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-assignments/employee/:employeeId
  // Obtener asignaciones activas de un repartidor
  // ═══════════════════════════════════════════════════════════════
  router.get('/employee/:employeeId', async (req, res) => {
    const { employeeId } = req.params;
    const { branch_id, tenant_id, estado } = req.query;

    try {
      console.log('[API] 📊 GET /api/repartidor-assignments/employee/:employeeId');
      console.log(`  Employee: ${employeeId}, Branch: ${branch_id}`);

      let query = `
        SELECT
          ra.id,
          ra.id_venta,
          ra.employee_id,
          e.full_name as employee_name,
          ra.branch_id,
          b.name as branch_name,
          ra.cantidad_asignada,
          ra.cantidad_devuelta,
          ra.cantidad_vendida,
          ra.monto_asignado,
          ra.monto_devuelto,
          ra.monto_vendido,
          ra.estado,
          ra.fecha_asignacion,
          ra.fecha_devoluciones,
          ra.fecha_liquidacion,
          ra.observaciones
        FROM repartidor_assignments ra
        LEFT JOIN employees e ON e.id = ra.employee_id
        LEFT JOIN branches b ON b.id = ra.branch_id
        WHERE ra.employee_id = $1
      `;

      const params = [employeeId];

      if (branch_id) {
        query += ` AND ra.branch_id = $${params.length + 1}`;
        params.push(branch_id);
      }

      if (tenant_id) {
        query += ` AND ra.tenant_id = $${params.length + 1}`;
        params.push(tenant_id);
      }

      if (estado) {
        query += ` AND ra.estado = $${params.length + 1}`;
        params.push(estado);
      }

      query += ` ORDER BY ra.fecha_asignacion DESC`;

      const result = await pool.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length
      });

    } catch (error) {
      console.error('❌ Error obteniendo asignaciones:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
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
      console.log(`  Employee: ${employeeId}, Limit: ${limit}, Offset: ${offset}`);

      let query = `
        SELECT
          rl.id,
          rl.employee_id,
          e.full_name as employee_name,
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

      if (tenant_id) {
        query += ` AND rl.tenant_id = $${params.length + 1}`;
        params.push(tenant_id);
      }

      query += ` ORDER BY rl.fecha_liquidacion DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

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
        error: error.message
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
        error: error.message
      });
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
          e.full_name as employee_name,
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

      query += ` GROUP BY ra.employee_id, e.full_name ORDER BY kilos_asignados DESC`;

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
        error: error.message
      });
    }
  });

  return router;
}

module.exports = createRepartidorAssignmentRoutes;
