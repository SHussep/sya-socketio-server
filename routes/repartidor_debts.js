/**
 * Rutas API para Deudas de Repartidores
 *
 * Endpoints:
 *   GET /api/repartidor-debts/employee/:employeeId - Obtener deudas de empleado
 *   GET /api/repartidor-debts/branch/:branchId/summary - Obtener resumen de deudas por sucursal
 */

const express = require('express');
const { pool } = require('../database');

function createRepartidorDebtsRoutes(io) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-debts/employee/:employeeId
  // Obtener deudas de un repartidor
  // ═══════════════════════════════════════════════════════════════
  router.get('/employee/:employeeId', async (req, res) => {
    const { employeeId } = req.params;
    const { branch_id, tenant_id, estado = 'pendiente', limit = 50, offset = 0 } = req.query;

    try {
      console.log('[API] 💳 GET /api/repartidor-debts/employee/:employeeId');
      console.log(`  Employee: ${employeeId}, Estado: ${estado}`);

      let query = `
        SELECT
          rd.id,
          rd.employee_id,
          e.full_name as employee_name,
          rd.branch_id,
          b.name as branch_name,
          rd.liquidation_id,
          rd.monto_deuda,
          rd.monto_pagado,
          (rd.monto_deuda - COALESCE(rd.monto_pagado, 0)) as monto_pendiente,
          rd.estado,
          rd.fecha_deuda,
          rd.fecha_pagado,
          rd.observaciones
        FROM repartidor_debts rd
        LEFT JOIN employees e ON e.id = rd.employee_id
        LEFT JOIN branches b ON b.id = rd.branch_id
        WHERE rd.employee_id = $1
      `;

      const params = [employeeId];

      if (branch_id) {
        query += ` AND rd.branch_id = $${params.length + 1}`;
        params.push(branch_id);
      }

      if (tenant_id) {
        query += ` AND rd.tenant_id = $${params.length + 1}`;
        params.push(tenant_id);
      }

      if (estado) {
        query += ` AND rd.estado = $${params.length + 1}`;
        params.push(estado);
      }

      query += ` ORDER BY rd.fecha_deuda DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length,
        pagination: { limit: parseInt(limit), offset: parseInt(offset) }
      });

    } catch (error) {
      console.error('❌ Error obteniendo deudas:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/repartidor-debts/branch/:branchId/summary
  // Obtener resumen de deudas por sucursal
  // ═══════════════════════════════════════════════════════════════
  router.get('/branch/:branchId/summary', async (req, res) => {
    const { branchId } = req.params;
    const { tenant_id, estado = 'pendiente' } = req.query;

    try {
      console.log('[API] 📊 GET /api/repartidor-debts/branch/:branchId/summary');
      console.log(`  Branch: ${branchId}, Estado: ${estado}`);

      let query = `
        SELECT
          rd.branch_id,
          b.name as branch_name,
          rd.estado,
          COUNT(*) as total_deudas,
          SUM(rd.monto_deuda) as monto_total_deudas,
          SUM(rd.monto_pagado) as monto_total_pagado,
          SUM(rd.monto_deuda - COALESCE(rd.monto_pagado, 0)) as monto_total_pendiente
        FROM repartidor_debts rd
        LEFT JOIN branches b ON b.id = rd.branch_id
        WHERE rd.branch_id = $1
      `;

      const params = [branchId];

      if (tenant_id) {
        query += ` AND rd.tenant_id = $${params.length + 1}`;
        params.push(tenant_id);
      }

      if (estado) {
        query += ` AND rd.estado = $${params.length + 1}`;
        params.push(estado);
      }

      query += ` GROUP BY rd.branch_id, b.name, rd.estado`;

      const result = await pool.query(query, params);

      const summary = {
        branch_id: branchId,
        total_deudas: 0,
        monto_total_deudas: 0,
        monto_total_pagado: 0,
        monto_total_pendiente: 0,
        por_estado: result.rows
      };

      // Calcular totales
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
      console.error('❌ Error obteniendo resumen de deudas:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return router;
}

module.exports = createRepartidorDebtsRoutes;
