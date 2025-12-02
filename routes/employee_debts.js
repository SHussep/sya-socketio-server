/**
 * Rutas API para Deudas de Empleados (faltantes de corte de caja)
 *
 * Endpoints:
 *   POST /api/employee-debts/sync - Sincronizar deudas desde Desktop (idempotente via global_id)
 *   GET /api/employee-debts/employee/:employeeId - Obtener deudas de empleado
 *   GET /api/employee-debts/branch/:branchId/summary - Obtener resumen de deudas por sucursal
 *
 * Columnas PostgreSQL: id, global_id, tenant_id, branch_id, employee_id, cash_cut_id,
 *                      shift_id, monto_deuda, monto_pagado, estado, fecha_deuda, fecha_pago,
 *                      notas, terminal_id, local_op_seq, device_event_raw, created_local_utc,
 *                      created_at, updated_at
 */

const express = require('express');
const { pool } = require('../database');

function createEmployeeDebtsRoutes(io) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════
  // POST /api/employee-debts/sync
  // Sincronizar deudas desde Desktop (sin autenticación - offline-first)
  // ✅ Usa GlobalIds para resolver relaciones (idempotencia)
  // ═══════════════════════════════════════════════════════════════
  router.post('/sync', async (req, res) => {
    try {
      const debts = Array.isArray(req.body) ? req.body : [req.body];

      if (debts.length === 0 || !debts[0].tenantId) {
        return res.status(400).json({ success: false, message: 'tenantId es requerido' });
      }

      const { tenantId } = debts[0];
      console.log(`[EmployeeDebts/Sync] Syncing ${debts.length} debts for tenant ${tenantId}`);

      const results = [];

      for (const debt of debts) {
        try {
          const {
            tenantId: debtTenantId, branchId,
            // GlobalIds para resolución offline-first
            employee_global_id, cash_drawer_session_global_id, shift_global_id,
            // Datos de la deuda
            monto_deuda, monto_pagado, estado, fecha_deuda, fecha_pago, notas,
            // Campos offline-first para idempotencia
            global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
          } = debt;

          const effectiveTenantId = debtTenantId || tenantId;

          // ✅ Validar global_id
          if (!global_id) {
            results.push({ success: false, error: 'global_id es requerido para idempotencia' });
            continue;
          }

          // ✅ RESOLVER employee_global_id → PostgreSQL ID
          let finalEmployeeId = null;
          if (employee_global_id) {
            const empResult = await pool.query(
              'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
              [employee_global_id, effectiveTenantId]
            );
            if (empResult.rows.length > 0) {
              finalEmployeeId = empResult.rows[0].id;
              console.log(`[EmployeeDebts/Sync] ✅ Empleado resuelto: ${employee_global_id} → ${finalEmployeeId}`);
            } else {
              console.log(`[EmployeeDebts/Sync] ❌ Empleado no encontrado: ${employee_global_id}`);
              results.push({ success: false, error: `Empleado no encontrado: ${employee_global_id}`, global_id });
              continue;
            }
          }

          if (!finalEmployeeId) {
            results.push({ success: false, error: 'employee_global_id es requerido', global_id });
            continue;
          }

          // ✅ RESOLVER cash_drawer_session_global_id → cash_cuts.id en PostgreSQL
          // Desktop usa CashDrawerSession localmente, pero sincroniza a cash_cuts en PG
          let finalCashCutId = null;
          if (cash_drawer_session_global_id) {
            const sessionResult = await pool.query(
              'SELECT id FROM cash_cuts WHERE global_id = $1 AND tenant_id = $2',
              [cash_drawer_session_global_id, effectiveTenantId]
            );
            if (sessionResult.rows.length > 0) {
              finalCashCutId = sessionResult.rows[0].id;
              console.log(`[EmployeeDebts/Sync] ✅ CashCut resuelto: ${cash_drawer_session_global_id} → ${finalCashCutId}`);
            } else {
              console.log(`[EmployeeDebts/Sync] ⚠️ CashCut no encontrado: ${cash_drawer_session_global_id}`);
            }
          }

          // ✅ RESOLVER shift_global_id → PostgreSQL ID
          let finalShiftId = null;
          if (shift_global_id) {
            const shiftResult = await pool.query(
              'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
              [shift_global_id, effectiveTenantId]
            );
            if (shiftResult.rows.length > 0) {
              finalShiftId = shiftResult.rows[0].id;
              console.log(`[EmployeeDebts/Sync] ✅ Turno resuelto: ${shift_global_id} → ${finalShiftId}`);
            } else {
              console.log(`[EmployeeDebts/Sync] ⚠️ Turno no encontrado: ${shift_global_id}`);
            }
          }

          // ✅ UPSERT con global_id para idempotencia
          const result = await pool.query(
            `INSERT INTO employee_debts (
              tenant_id, branch_id, employee_id, cash_cut_id, shift_id,
              monto_deuda, monto_pagado, estado, fecha_deuda, fecha_pago, notas,
              global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            ON CONFLICT (global_id)
            DO UPDATE SET
              monto_pagado = EXCLUDED.monto_pagado,
              estado = EXCLUDED.estado,
              fecha_pago = EXCLUDED.fecha_pago,
              notas = EXCLUDED.notas,
              updated_at = NOW()
            RETURNING *`,
            [
              effectiveTenantId, branchId, finalEmployeeId, finalCashCutId, finalShiftId,
              parseFloat(monto_deuda), parseFloat(monto_pagado || 0), estado || 'pendiente',
              fecha_deuda, fecha_pago || null, notas || null,
              global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
            ]
          );

          results.push({ success: true, data: result.rows[0] });
          console.log(`[EmployeeDebts/Sync] ✅ Deuda sincronizada: $${monto_deuda} empleado ${finalEmployeeId} (global_id: ${global_id})`);

        } catch (error) {
          results.push({ success: false, error: error.message, global_id: debt.global_id });
          console.error(`[EmployeeDebts/Sync] ❌ Error:`, error.message);
        }
      }

      const successCount = results.filter(r => r.success).length;
      res.json({
        success: true,
        message: `${successCount}/${debts.length} debts synced`,
        results
      });

    } catch (error) {
      console.error('[EmployeeDebts/Sync] ❌ Error:', error.message);
      res.status(500).json({ success: false, message: 'Error syncing employee debts', error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/employee-debts/employee/:employeeId
  // Obtener deudas de un empleado
  // ═══════════════════════════════════════════════════════════════
  router.get('/employee/:employeeId', async (req, res) => {
    const { employeeId } = req.params;
    const { branch_id, tenant_id, estado, limit = 50, offset = 0 } = req.query;

    try {
      console.log(`[EmployeeDebts] GET /employee/${employeeId}`);

      let query = `
        SELECT
          ed.id, ed.global_id,
          ed.employee_id,
          CONCAT(e.first_name, ' ', e.last_name) as employee_name,
          ed.branch_id,
          b.name as branch_name,
          ed.cash_cut_id,
          ed.shift_id,
          ed.monto_deuda,
          ed.monto_pagado,
          (ed.monto_deuda - COALESCE(ed.monto_pagado, 0)) as monto_pendiente,
          ed.estado,
          ed.fecha_deuda,
          ed.fecha_pago,
          ed.notas,
          ed.created_at
        FROM employee_debts ed
        LEFT JOIN employees e ON e.id = ed.employee_id
        LEFT JOIN branches b ON b.id = ed.branch_id
        WHERE ed.employee_id = $1
      `;

      const params = [employeeId];

      if (branch_id) {
        query += ` AND ed.branch_id = $${params.length + 1}`;
        params.push(branch_id);
      }

      if (tenant_id) {
        query += ` AND ed.tenant_id = $${params.length + 1}`;
        params.push(tenant_id);
      }

      if (estado) {
        query += ` AND ed.estado = $${params.length + 1}`;
        params.push(estado);
      }

      query += ` ORDER BY ed.fecha_deuda DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length,
        pagination: { limit: parseInt(limit), offset: parseInt(offset) }
      });

    } catch (error) {
      console.error('[EmployeeDebts] ❌ Error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/employee-debts/branch/:branchId/summary
  // Obtener resumen de deudas por sucursal
  // ═══════════════════════════════════════════════════════════════
  router.get('/branch/:branchId/summary', async (req, res) => {
    const { branchId } = req.params;
    const { tenant_id } = req.query;

    try {
      console.log(`[EmployeeDebts] GET /branch/${branchId}/summary`);

      let query = `
        SELECT
          ed.branch_id,
          b.name as branch_name,
          ed.estado,
          COUNT(*) as total_deudas,
          SUM(ed.monto_deuda) as monto_total_deudas,
          SUM(ed.monto_pagado) as monto_total_pagado,
          SUM(ed.monto_deuda - COALESCE(ed.monto_pagado, 0)) as monto_total_pendiente
        FROM employee_debts ed
        LEFT JOIN branches b ON b.id = ed.branch_id
        WHERE ed.branch_id = $1
      `;

      const params = [branchId];

      if (tenant_id) {
        query += ` AND ed.tenant_id = $${params.length + 1}`;
        params.push(tenant_id);
      }

      query += ` GROUP BY ed.branch_id, b.name, ed.estado`;

      const result = await pool.query(query, params);

      const summary = {
        branch_id: branchId,
        total_deudas: 0,
        monto_total_deudas: 0,
        monto_total_pagado: 0,
        monto_total_pendiente: 0,
        por_estado: result.rows
      };

      result.rows.forEach(row => {
        summary.total_deudas += parseInt(row.total_deudas || 0);
        summary.monto_total_deudas += parseFloat(row.monto_total_deudas || 0);
        summary.monto_total_pagado += parseFloat(row.monto_total_pagado || 0);
        summary.monto_total_pendiente += parseFloat(row.monto_total_pendiente || 0);
      });

      res.json({
        success: true,
        data: summary
      });

    } catch (error) {
      console.error('[EmployeeDebts] ❌ Error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = createEmployeeDebtsRoutes;
