// ═══════════════════════════════════════════════════════════════
// RUTA: Super-Admin Login
// POST /api/auth/super-admin/login
// Body: { username, password, super_admin_pin }
//
// Flujo:
//   1. Buscar employee por email (tratamos "username" como email ya que
//      el schema de employees usa `email` como identificador único).
//   2. Verificar password_hash con bcryptjs (misma estrategia que
//      controllers/auth/loginMethods.js).
//   3. Verificar que employees.super_admin_pin esté seteado y que
//      coincida con el PIN provisto (bcrypt compare).
//   4. Resolver authorizedTenants = SELECT id FROM tenants.
//   5. Firmar JWT RS256 con SUPER_ADMIN_PRIVATE_KEY_PATH.
//   6. Devolver { token, expiresAt }.
//
// Rate limiting agresivo (superadminRateLimiter: 3 intentos / 1h lockout).
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const crypto = require('crypto');

const { pool } = require('../database');
const { superadminRateLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

const EXPECTED_AUD = 'sync-diagnostics-admin';
const TOKEN_TTL_MINUTES = 60;

let PRIVATE_KEY = null;
function loadPrivateKey() {
    if (PRIVATE_KEY) return PRIVATE_KEY;
    const p = process.env.SUPER_ADMIN_PRIVATE_KEY_PATH;
    if (!p) throw new Error('SUPER_ADMIN_PRIVATE_KEY_PATH not set');
    PRIVATE_KEY = fs.readFileSync(p, 'utf8');
    return PRIVATE_KEY;
}

router.post('/login', superadminRateLimiter, async (req, res) => {
    const { username, password, super_admin_pin } = req.body || {};

    if (!username || !password || !super_admin_pin) {
        if (typeof req.registerFailedSuperadminAttempt === 'function') {
            req.registerFailedSuperadminAttempt();
        }
        return res.status(400).json({ success: false, error: 'missing_fields' });
    }

    try {
        // 1. Buscar employee por email (tratando `username` como email)
        const userResult = await pool.query(
            `SELECT id, email, password_hash, super_admin_pin, is_active
             FROM employees
             WHERE LOWER(email) = LOWER($1)
             LIMIT 1`,
            [username]
        );

        if (userResult.rowCount === 0) {
            if (typeof req.registerFailedSuperadminAttempt === 'function') {
                req.registerFailedSuperadminAttempt();
            }
            console.warn('[SuperAdminLogin] ❌ Usuario no encontrado');
            return res.status(401).json({ success: false, error: 'invalid_credentials' });
        }

        const employee = userResult.rows[0];

        if (employee.is_active === false) {
            if (typeof req.registerFailedSuperadminAttempt === 'function') {
                req.registerFailedSuperadminAttempt();
            }
            console.warn(`[SuperAdminLogin] ❌ Empleado inactivo id=${employee.id}`);
            return res.status(401).json({ success: false, error: 'invalid_credentials' });
        }

        if (!employee.password_hash || !employee.super_admin_pin) {
            if (typeof req.registerFailedSuperadminAttempt === 'function') {
                req.registerFailedSuperadminAttempt();
            }
            console.warn(`[SuperAdminLogin] ❌ Empleado ${employee.id} sin password_hash o super_admin_pin`);
            return res.status(401).json({ success: false, error: 'invalid_credentials' });
        }

        // 2. Verificar password
        const passwordOk = await bcrypt.compare(password, employee.password_hash);
        if (!passwordOk) {
            if (typeof req.registerFailedSuperadminAttempt === 'function') {
                req.registerFailedSuperadminAttempt();
            }
            console.warn(`[SuperAdminLogin] ❌ Password inválido para employee ${employee.id}`);
            return res.status(401).json({ success: false, error: 'invalid_credentials' });
        }

        // 3. Verificar super_admin_pin
        const pinOk = await bcrypt.compare(String(super_admin_pin), employee.super_admin_pin);
        if (!pinOk) {
            if (typeof req.registerFailedSuperadminAttempt === 'function') {
                req.registerFailedSuperadminAttempt();
            }
            console.warn(`[SuperAdminLogin] ❌ PIN inválido para employee ${employee.id}`);
            return res.status(401).json({ success: false, error: 'invalid_credentials' });
        }

        // 4. Resolver authorizedTenants = todos los tenants
        const tenantsResult = await pool.query('SELECT id FROM tenants ORDER BY id ASC');
        const authorizedTenants = tenantsResult.rows.map(r => Number(r.id));

        // 5. Firmar JWT RS256
        const jti = crypto.randomUUID();
        const expiresInSeconds = TOKEN_TTL_MINUTES * 60;
        const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

        const token = jwt.sign(
            {
                sub: employee.id,
                role: 'super_admin',
                authorizedTenants,
                jti,
                aud: EXPECTED_AUD
            },
            loadPrivateKey(),
            { algorithm: 'RS256', expiresIn: `${TOKEN_TTL_MINUTES}m` }
        );

        if (typeof req.clearSuperadminAttempts === 'function') {
            req.clearSuperadminAttempts();
        }

        console.log(`[SuperAdminLogin] ✅ Login exitoso employee=${employee.id} jti=${jti} tenants=${authorizedTenants.length}`);

        return res.json({
            success: true,
            token,
            expiresAt
        });
    } catch (err) {
        console.error('[SuperAdminLogin] Error inesperado:', err);
        return res.status(500).json({ success: false, error: 'internal_error' });
    }
});

module.exports = router;
