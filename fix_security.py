#!/usr/bin/env python3
"""
Script para proteger endpoints peligrosos en server.js
Agrega middleware de autenticación admin
"""

import re

server_js_path = 'server.js'

# Leer el archivo
with open(server_js_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Agregar import del middleware después de los otros imports
import_section = "const notificationHelper = require('./utils/notificationHelper');"
new_import = "const { requireAdminCredentials } = require('./middleware/adminAuth');"

if new_import not in content:
    content = content.replace(import_section, import_section + f"\n{new_import}")
    print("✅ Agregado import del middleware admin")

# 2. Reemplazar los 3 endpoints peligrosos para que usen requireAdminCredentials

# Endpoint 1: /api/database/view
old_view = "app.get('/api/database/view', async (req, res) => {"
new_view = "app.get('/api/database/view', requireAdminCredentials, async (req, res) => {"
content = content.replace(old_view, new_view)
print("✅ Protegido: GET /api/database/view")

# Endpoint 2: /api/database/fix-old-tenants
old_fix = "app.post('/api/database/fix-old-tenants', async (req, res) => {"
new_fix = "app.post('/api/database/fix-old-tenants', requireAdminCredentials, async (req, res) => {"
content = content.replace(old_fix, new_fix)
print("✅ Protegido: POST /api/database/fix-old-tenants")

# Endpoint 3: /api/database/delete-tenant-by-email
old_delete = "app.post('/api/database/delete-tenant-by-email', async (req, res) => {"
new_delete = "app.post('/api/database/delete-tenant-by-email', requireAdminCredentials, async (req, res) => {"
content = content.replace(old_delete, new_delete)
print("✅ Protegido: POST /api/database/delete-tenant-by-email")

# Guardar el archivo actualizado
with open(server_js_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("\n✅ SEGURIDAD: Se protegieron los 3 endpoints peligrosos")
print("Los endpoints ahora requieren ADMIN_PASSWORD en el body/query")
print("\nNOTA: Asegúrate de configurar ADMIN_PASSWORD en Render Dashboard > Environment")
