#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// SCRIPT: create-super-admin
// Uso:
//   node scripts/create-super-admin.js --employee-id=42 --pin=1234
//
// Asume que la fila de `employees` ya existe (falla si no). Sólo
// establece el campo `super_admin_pin` (bcrypt hash) que autoriza al
// empleado a solicitar un JWT super-admin vía
// /api/auth/super-admin/login.
// ═══════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const { pool } = require('../database');

function parseArgs(argv) {
    const out = {};
    for (const raw of argv) {
        if (!raw.startsWith('--')) continue;
        const eq = raw.indexOf('=');
        if (eq === -1) {
            out[raw.slice(2)] = true;
        } else {
            out[raw.slice(2, eq)] = raw.slice(eq + 1);
        }
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const employeeIdRaw = args['employee-id'];
    const pin = args['pin'];

    if (!employeeIdRaw || !pin) {
        console.error('Uso: node scripts/create-super-admin.js --employee-id=N --pin=XXXX');
        process.exit(1);
    }

    const employeeId = Number(employeeIdRaw);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
        console.error(`--employee-id inválido: ${employeeIdRaw}`);
        process.exit(1);
    }

    if (String(pin).length < 4) {
        console.error('--pin debe tener al menos 4 caracteres');
        process.exit(1);
    }

    try {
        const existing = await pool.query(
            'SELECT id, email FROM employees WHERE id = $1 LIMIT 1',
            [employeeId]
        );
        if (existing.rowCount === 0) {
            console.error(`Empleado con id=${employeeId} no existe`);
            process.exit(1);
        }

        const hash = await bcrypt.hash(String(pin), 10);

        const result = await pool.query(
            'UPDATE employees SET super_admin_pin = $1 WHERE id = $2',
            [hash, employeeId]
        );

        if (result.rowCount !== 1) {
            console.error(`No se pudo actualizar empleado id=${employeeId}`);
            process.exit(1);
        }

        console.log(`✅ super_admin_pin configurado para empleado id=${employeeId} (${existing.rows[0].email})`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    } finally {
        try { await pool.end(); } catch (e) { /* ignore */ }
    }
}

main();
