#!/usr/bin/env node
/**
 * Script para proteger endpoints peligrosos en server.js
 * Agrega middleware de autenticación admin a 3 endpoints sensibles
 */

const fs = require('fs');
const path = require('path');

const serverJsPath = path.join(__dirname, 'server.js');

// Leer el archivo
let content = fs.readFileSync(serverJsPath, 'utf-8');

// 1. Agregar import del middleware después de los otros imports
const importSection = "const notificationHelper = require('./utils/notificationHelper');";
const newImport = "const { requireAdminCredentials } = require('./middleware/adminAuth');";

if (!content.includes(newImport)) {
    content = content.replace(importSection, importSection + `\n${newImport}`);
    console.log('[SECURITY] Added admin middleware import');
}

// 2. Reemplazar los 3 endpoints peligrosos para que usen requireAdminCredentials

// Endpoint 1: /api/database/view
const oldView = "app.get('/api/database/view', async (req, res) => {";
const newView = "app.get('/api/database/view', requireAdminCredentials, async (req, res) => {";
if (content.includes(oldView)) {
    content = content.replace(oldView, newView);
    console.log('[SECURITY] Protected: GET /api/database/view');
}

// Endpoint 2: /api/database/fix-old-tenants
const oldFix = "app.post('/api/database/fix-old-tenants', async (req, res) => {";
const newFix = "app.post('/api/database/fix-old-tenants', requireAdminCredentials, async (req, res) => {";
if (content.includes(oldFix)) {
    content = content.replace(oldFix, newFix);
    console.log('[SECURITY] Protected: POST /api/database/fix-old-tenants');
}

// Endpoint 3: /api/database/delete-tenant-by-email
const oldDelete = "app.post('/api/database/delete-tenant-by-email', async (req, res) => {";
const newDelete = "app.post('/api/database/delete-tenant-by-email', requireAdminCredentials, async (req, res) => {";
if (content.includes(oldDelete)) {
    content = content.replace(oldDelete, newDelete);
    console.log('[SECURITY] Protected: POST /api/database/delete-tenant-by-email');
}

// Guardar el archivo actualizado
fs.writeFileSync(serverJsPath, content, 'utf-8');

console.log('\n[SUCCESS] Security fixes applied!');
console.log('[REMINDER] Set ADMIN_PASSWORD in Render Dashboard > Environment');
