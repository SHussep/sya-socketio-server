// ═══════════════════════════════════════════════════════════════
// RUTAS DE BACKUP - Sistema Inteligente de Backup en la Nube
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { pool } = require('../database');
const jwt = require('jsonwebtoken');
const { Dropbox } = require('dropbox');
const fetch = require('node-fetch');

const JWT_SECRET = process.env.JWT_SECRET;

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE DE AUTENTICACIÓN
// ═══════════════════════════════════════════════════════════════

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token inválido o expirado' });
        }
        req.user = user;
        next();
    });
}

// ═══════════════════════════════════════════════════════════════
// CONFIGURACIÓN DE DROPBOX
// ═══════════════════════════════════════════════════════════════

let dropboxClient = null;

// ═══════════════════════════════════════════════════════════════
// HELPERS PARA ORGANIZACIÓN DE CARPETAS EN DROPBOX
// ═══════════════════════════════════════════════════════════════

/**
 * Obtiene el email del tenant desde la base de datos
 * @param {number} tenant_id - ID del tenant
 * @returns {Promise<string|null>} Email del tenant o null si no se encuentra
 */
async function getTenantEmail(tenant_id) {
    try {
        const result = await pool.query(
            `SELECT email FROM tenants WHERE id = $1`,
            [tenant_id]
        );

        if (result.rows.length > 0) {
            return result.rows[0].email;
        }
        return null;
    } catch (error) {
        console.error(`[Backup] Error al obtener email del tenant ${tenant_id}:`, error);
        return null;
    }
}

/**
 * Sanitiza el email para usarlo como nombre de carpeta en Dropbox
 * Ejemplo: "usuario@ejemplo.com" -> "usuario_ejemplo.com"
 * @param {string} email - Email a sanitizar
 * @returns {string} Email sanitizado para usar como carpeta
 */
function sanitizeEmailForPath(email) {
    if (!email) return 'unknown';

    // Reemplazar @ con _ y eliminar caracteres no permitidos en nombres de carpeta
    return email
        .toLowerCase()
        .replace('@', '_')
        .replace(/[<>:"/\\|?*]/g, '_') // Caracteres no permitidos en Windows/Dropbox
        .replace(/\s+/g, '_')          // Espacios
        .replace(/_+/g, '_')           // Múltiples underscores consecutivos
        .trim();
}

/**
 * Construye la ruta de Dropbox con la nueva estructura organizada
 * Estructura: /SYA Backups/{email_sanitizado}/{tenant_id}/{branch_id}/{filename}
 * @param {string} ownerEmail - Email del propietario del tenant
 * @param {number} tenant_id - ID del tenant
 * @param {number} branch_id - ID de la sucursal
 * @param {string} filename - Nombre del archivo
 * @returns {string} Ruta completa en Dropbox
 */
function buildDropboxPath(ownerEmail, tenant_id, branch_id, filename) {
    const sanitizedEmail = sanitizeEmailForPath(ownerEmail);
    return `/SYA Backups/${sanitizedEmail}/${tenant_id}/${branch_id}/${filename}`;
}

function getDropboxClient() {
    if (!dropboxClient) {
        dropboxClient = new Dropbox({
            accessToken: process.env.DROPBOX_ACCESS_TOKEN,
            fetch: fetch
        });
    }
    return dropboxClient;
}

// Refresh token si es necesario
async function refreshDropboxToken() {
    try {
        const response = await fetch('https://api.dropbox.com/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
                client_id: process.env.DROPBOX_APP_KEY,
                client_secret: process.env.DROPBOX_APP_SECRET
            })
        });

        const data = await response.json();

        if (data.access_token) {
            // Actualizar el token en memoria
            process.env.DROPBOX_ACCESS_TOKEN = data.access_token;
            dropboxClient = null; // Forzar recreación del cliente con nuevo token
            console.log('[Dropbox] ✅ Token refrescado exitosamente');
            return data.access_token;
        } else {
            throw new Error('No se pudo obtener access_token');
        }
    } catch (error) {
        console.error('[Dropbox] ❌ Error al refrescar token:', error);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// POST /api/backup/upload-desktop - Subir backup desde Desktop sin JWT (usa identificación de dispositivo)
router.post('/upload-desktop', async (req, res) => {
    try {
        const {
            tenant_id,
            branch_id,
            employee_id,
            backup_filename,
            backup_base64, // Backup en Base64 (Desktop lo envía así)
            device_name,
            device_id
        } = req.body;

        console.log(`[Backup Upload Desktop] Request - Tenant: ${tenant_id}, Branch: ${branch_id}, Device: ${device_name}`);

        // Validar datos requeridos
        if (!tenant_id || !branch_id || !backup_filename || !backup_base64) {
            return res.status(400).json({
                success: false,
                message: 'Faltan datos requeridos: tenant_id, branch_id, backup_filename, backup_base64'
            });
        }

        // Convertir Base64 a Buffer
        const backupBuffer = Buffer.from(backup_base64, 'base64');
        const file_size_bytes = backupBuffer.length;

        console.log(`[Backup Upload Desktop] Tamaño: ${(file_size_bytes / 1024 / 1024).toFixed(2)} MB`);

        // Usar nombre fijo por branch para sobrescribir backup anterior
        // Esto mantiene solo UN backup por branch, el más reciente
        const simpleFilename = `SYA_Backup_Branch_${branch_id}.zip`;

        // Obtener email del tenant para organizar carpetas
        const ownerEmail = await getTenantEmail(tenant_id);
        if (!ownerEmail) {
            console.warn(`[Backup Upload Desktop] ⚠️ No se encontró email para tenant ${tenant_id}, usando 'unknown'`);
        }

        // Construir ruta con nueva estructura: /SYA Backups/{email}/{tenant_id}/{branch_id}/{filename}
        const dropboxPath = buildDropboxPath(ownerEmail, tenant_id, branch_id, simpleFilename);
        console.log(`[Backup Upload Desktop] 📁 Ruta Dropbox: ${dropboxPath}`);

        try {
            // PRIMERO: Eliminar backups viejos de esta branch de la BD (mantener solo el más reciente)
            await pool.query(
                `DELETE FROM backup_metadata
                 WHERE tenant_id = $1 AND branch_id = $2`,
                [tenant_id, branch_id]
            );

            const dbx = getDropboxClient();
            const uploadResult = await dbx.filesUpload({
                path: dropboxPath,
                contents: backupBuffer,
                mode: { '.tag': 'overwrite' }, // Sobrescribir el backup anterior
                autorename: false,
                mute: false
            });

            console.log(`[Backup Upload Desktop] ✅ Subido a Dropbox: ${dropboxPath}`);

            // Registrar metadata en PostgreSQL
            const metadataResult = await pool.query(
                `INSERT INTO backup_metadata (
                    tenant_id, branch_id, employee_id, backup_filename, backup_path,
                    file_size_bytes, device_name, device_id, is_automatic, encryption_enabled
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING *`,
                [
                    tenant_id,
                    branch_id,
                    employee_id || null,
                    simpleFilename,
                    dropboxPath,
                    file_size_bytes,
                    device_name || 'Desktop',
                    device_id || 'unknown',
                    true, // is_automatic
                    false // encryption_enabled
                ]
            );

            const metadata = metadataResult.rows[0];

            console.log(`[Backup Upload Desktop] ✅ Metadata registrada - ID: ${metadata.id}`);

            res.json({
                success: true,
                data: {
                    backup_id: metadata.id,
                    dropbox_path: dropboxPath,
                    file_size_bytes: metadata.file_size_bytes,
                    created_at: metadata.created_at,
                    expires_at: metadata.expires_at
                },
                message: 'Backup subido exitosamente desde Desktop'
            });

        } catch (dropboxError) {
            // Si el token expiró, intentar refrescarlo
            if (dropboxError.status === 401) {
                console.log('[Backup Upload Desktop] Token expirado, refrescando...');
                await refreshDropboxToken();

                // Reintentar la subida
                const dbx = getDropboxClient();
                const uploadResult = await dbx.filesUpload({
                    path: dropboxPath,
                    contents: backupBuffer,
                    mode: { '.tag': 'overwrite' },
                    autorename: false
                });

                console.log(`[Backup Upload Desktop] ✅ Subido a Dropbox (reintento): ${dropboxPath}`);

                // Registrar metadata
                const metadataResult = await pool.query(
                    `INSERT INTO backup_metadata (
                        tenant_id, branch_id, employee_id, backup_filename, backup_path,
                        file_size_bytes, device_name, device_id, is_automatic, encryption_enabled
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    RETURNING *`,
                    [tenant_id, branch_id, employee_id || null, simpleFilename, dropboxPath, file_size_bytes,
                     device_name || 'Desktop', device_id || 'unknown', true, false]
                );

                const metadata = metadataResult.rows[0];

                return res.json({
                    success: true,
                    data: {
                        backup_id: metadata.id,
                        dropbox_path: dropboxPath,
                        file_size_bytes: metadata.file_size_bytes,
                        created_at: metadata.created_at,
                        expires_at: metadata.expires_at
                    },
                    message: 'Backup subido exitosamente desde Desktop (tras refrescar token)'
                });
            } else {
                throw dropboxError;
            }
        }

    } catch (error) {
        console.error('[Backup Upload Desktop] ❌ Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al subir backup desde Desktop',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET /api/backup/list-desktop/:tenant_id/:branch_id - Listar backups sin JWT (para Desktop)
// IMPORTANTE: Solo retorna backups de la sucursal específica (branch_id)
// El usuario debe ver únicamente los backups de la sucursal a la que se unió
router.get('/list-desktop/:tenant_id/:branch_id', async (req, res) => {
    try {
        const { tenant_id, branch_id } = req.params;
        const { limit = 15, offset = 0 } = req.query;

        console.log(`[Backup List Desktop] Request - Tenant: ${tenant_id}, Branch: ${branch_id}`);

        // Validar parámetros
        if (!tenant_id || !branch_id) {
            return res.status(400).json({
                success: false,
                message: 'tenant_id y branch_id son requeridos'
            });
        }

        // Filtrar SOLO por tenant_id Y branch_id específico
        // El usuario solo debe ver backups de SU sucursal
        const result = await pool.query(
            `SELECT
                bm.id,
                bm.backup_filename,
                bm.backup_path,
                bm.file_size_bytes,
                bm.device_name,
                bm.device_id,
                bm.encryption_enabled,
                bm.created_at,
                bm.branch_id,
                bm.tenant_id,
                EXTRACT(EPOCH FROM (NOW() - bm.created_at)) / 3600 as hours_ago,
                b.name as branch_name,
                b.branch_code
             FROM backup_metadata bm
             LEFT JOIN branches b ON bm.branch_id = b.id
             WHERE bm.tenant_id = $1 AND bm.branch_id = $2
             ORDER BY bm.created_at DESC
             LIMIT $3 OFFSET $4`,
            [tenant_id, branch_id, limit, offset]
        );

        console.log(`[Backup List Desktop] Found ${result.rows.length} backups for tenant ${tenant_id}, branch ${branch_id}`);

        res.json({
            success: true,
            data: result.rows.map(backup => ({
                id: backup.id,
                filename: backup.backup_filename,
                path: backup.backup_path,
                file_size_bytes: parseInt(backup.file_size_bytes),
                file_size_mb: (parseInt(backup.file_size_bytes) / 1024 / 1024).toFixed(2),
                device_name: backup.device_name,
                device_id: backup.device_id,
                encryption_enabled: backup.encryption_enabled,
                created_at: backup.created_at,
                hours_ago: Math.round(parseFloat(backup.hours_ago)),
                branch_id: backup.branch_id,
                tenant_id: backup.tenant_id,
                branch_name: backup.branch_name || 'Sucursal',
                branch_code: backup.branch_code || ''
            })),
            branch_id: parseInt(branch_id),
            tenant_id: parseInt(tenant_id)
        });

    } catch (error) {
        console.error('[Backup List Desktop] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al listar backups desde Desktop'
        });
    }
});

// GET /api/backup/download-desktop/:tenant_id/:branch_id/:id - Descargar backup sin JWT (para Desktop)
// Valida estrictamente que el backup pertenezca a la sucursal del usuario
router.get('/download-desktop/:tenant_id/:branch_id/:id', async (req, res) => {
    try {
        const { tenant_id, branch_id, id } = req.params;

        console.log(`[Backup Download Desktop] Request - Tenant: ${tenant_id}, Branch: ${branch_id}, Backup ID: ${id}`);

        // Obtener metadata del backup - Validar por tenant_id Y branch_id
        // Solo permitir descargar backups de la sucursal correcta
        const metadataResult = await pool.query(
            `SELECT bm.*, b.name as branch_name, b.branch_code
             FROM backup_metadata bm
             LEFT JOIN branches b ON bm.branch_id = b.id
             WHERE bm.id = $1 AND bm.tenant_id = $2 AND bm.branch_id = $3`,
            [id, tenant_id, branch_id]
        );

        if (metadataResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Backup no encontrado'
            });
        }

        const metadata = metadataResult.rows[0];
        const dropboxPath = metadata.backup_path;

        console.log(`[Backup Download Desktop] Descargando: ${dropboxPath}`);

        try {
            // Descargar desde Dropbox
            const dbx = getDropboxClient();
            const downloadResult = await dbx.filesDownload({ path: dropboxPath });

            // downloadResult.result.fileBinary contiene el archivo
            const fileBuffer = downloadResult.result.fileBinary;

            // Convertir a Base64 para enviarlo al Desktop
            const base64Data = fileBuffer.toString('base64');

            console.log(`[Backup Download Desktop] ✅ Descargado: ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`);

            res.json({
                success: true,
                data: {
                    id: metadata.id,
                    filename: metadata.backup_filename,
                    file_size_bytes: parseInt(metadata.file_size_bytes),
                    backup_base64: base64Data,
                    created_at: metadata.created_at,
                    branch_id: metadata.branch_id,
                    branch_name: metadata.branch_name || 'Sucursal',
                    branch_code: metadata.branch_code || ''
                },
                message: 'Backup descargado exitosamente'
            });

        } catch (dropboxError) {
            // Si el token expiró, refrescarlo y reintentar
            if (dropboxError.status === 401) {
                console.log('[Backup Download Desktop] Token expirado, refrescando...');
                await refreshDropboxToken();

                const dbx = getDropboxClient();
                const downloadResult = await dbx.filesDownload({ path: dropboxPath });
                const fileBuffer = downloadResult.result.fileBinary;
                const base64Data = fileBuffer.toString('base64');

                console.log(`[Backup Download Desktop] ✅ Descargado (reintento): ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`);

                return res.json({
                    success: true,
                    data: {
                        id: metadata.id,
                        filename: metadata.backup_filename,
                        file_size_bytes: parseInt(metadata.file_size_bytes),
                        backup_base64: base64Data,
                        created_at: metadata.created_at,
                        branch_id: metadata.branch_id,
                        branch_name: metadata.branch_name || 'Sucursal',
                        branch_code: metadata.branch_code || ''
                    },
                    message: 'Backup descargado exitosamente'
                });
            } else {
                throw dropboxError;
            }
        }

    } catch (error) {
        console.error('[Backup Download Desktop] ❌ Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al descargar backup desde Desktop',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// POST /api/backup/upload - Subir backup a Dropbox y registrar metadata (requiere JWT)
router.post('/upload', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId, employeeId } = req.user;
        const {
            backup_filename,
            backup_base64, // Backup en Base64 (Desktop lo envía así)
            device_name,
            device_id,
            encryption_enabled = true
        } = req.body;

        console.log(`[Backup Upload] Request - Branch: ${branchId}, Device: ${device_name}`);

        if (!backup_filename || !backup_base64) {
            return res.status(400).json({
                success: false,
                message: 'Faltan datos requeridos: backup_filename y backup_base64'
            });
        }

        // Convertir Base64 a Buffer
        const backupBuffer = Buffer.from(backup_base64, 'base64');
        const file_size_bytes = backupBuffer.length;

        console.log(`[Backup Upload] Tamaño: ${(file_size_bytes / 1024 / 1024).toFixed(2)} MB`);

        // Obtener email del tenant para organizar carpetas
        const ownerEmail = await getTenantEmail(tenantId);
        if (!ownerEmail) {
            console.warn(`[Backup Upload] ⚠️ No se encontró email para tenant ${tenantId}, usando 'unknown'`);
        }

        // Construir ruta con nueva estructura: /SYA Backups/{email}/{tenant_id}/{branch_id}/{filename}
        const dropboxPath = buildDropboxPath(ownerEmail, tenantId, branchId, backup_filename);
        console.log(`[Backup Upload] 📁 Ruta Dropbox: ${dropboxPath}`);

        try {
            const dbx = getDropboxClient();
            const uploadResult = await dbx.filesUpload({
                path: dropboxPath,
                contents: backupBuffer,
                mode: { '.tag': 'overwrite' },
                autorename: false,
                mute: false
            });

            console.log(`[Backup Upload] ✅ Subido a Dropbox: ${dropboxPath}`);

            // Registrar metadata en PostgreSQL
            const metadataResult = await pool.query(
                `INSERT INTO backup_metadata (
                    tenant_id, branch_id, employee_id, backup_filename, backup_path,
                    file_size_bytes, device_name, device_id, is_automatic, encryption_enabled
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                RETURNING *`,
                [
                    tenantId,
                    branchId,
                    employeeId,
                    backup_filename,
                    dropboxPath,
                    file_size_bytes,
                    device_name,
                    device_id,
                    true, // is_automatic
                    encryption_enabled
                ]
            );

            const metadata = metadataResult.rows[0];

            console.log(`[Backup Upload] ✅ Metadata registrada - ID: ${metadata.id}`);

            res.json({
                success: true,
                data: {
                    backup_id: metadata.id,
                    dropbox_path: dropboxPath,
                    file_size_bytes: metadata.file_size_bytes,
                    created_at: metadata.created_at,
                    expires_at: metadata.expires_at
                },
                message: 'Backup subido exitosamente'
            });

        } catch (dropboxError) {
            // Si el token expiró, intentar refrescarlo
            if (dropboxError.status === 401) {
                console.log('[Backup Upload] Token expirado, refrescando...');
                await refreshDropboxToken();

                // Reintentar la subida
                const dbx = getDropboxClient();
                const uploadResult = await dbx.filesUpload({
                    path: dropboxPath,
                    contents: backupBuffer,
                    mode: { '.tag': 'overwrite' }
                });

                console.log(`[Backup Upload] ✅ Subido a Dropbox (reintento): ${dropboxPath}`);

                // Registrar metadata
                const metadataResult = await pool.query(
                    `INSERT INTO backup_metadata (
                        tenant_id, branch_id, employee_id, backup_filename, backup_path,
                        file_size_bytes, device_name, device_id, is_automatic, encryption_enabled
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    RETURNING *`,
                    [tenantId, branchId, employeeId, backup_filename, dropboxPath, file_size_bytes,
                     device_name, device_id, true, encryption_enabled]
                );

                const metadata = metadataResult.rows[0];

                return res.json({
                    success: true,
                    data: {
                        backup_id: metadata.id,
                        dropbox_path: dropboxPath,
                        file_size_bytes: metadata.file_size_bytes,
                        created_at: metadata.created_at,
                        expires_at: metadata.expires_at
                    },
                    message: 'Backup subido exitosamente (tras refrescar token)'
                });
            } else {
                throw dropboxError;
            }
        }

    } catch (error) {
        console.error('[Backup Upload] ❌ Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al subir backup',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET /api/backup/list - Listar backups disponibles
router.get('/list', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId } = req.user;
        const { limit = 15, offset = 0 } = req.query;

        const result = await pool.query(
            `SELECT
                id, backup_filename, backup_path, file_size_bytes,
                device_name, device_id, encryption_enabled,
                created_at,
                EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 as hours_ago
             FROM backup_metadata
             WHERE tenant_id = $1 AND branch_id = $2
             ORDER BY created_at DESC
             LIMIT $3 OFFSET $4`,
            [tenantId, branchId, limit, offset]
        );

        console.log(`[Backup List] Found ${result.rows.length} backups for branch ${branchId}`);

        res.json({
            success: true,
            data: result.rows.map(backup => ({
                id: backup.id,
                filename: backup.backup_filename,
                path: backup.backup_path,
                file_size_bytes: parseInt(backup.file_size_bytes),
                file_size_mb: (parseInt(backup.file_size_bytes) / 1024 / 1024).toFixed(2),
                device_name: backup.device_name,
                device_id: backup.device_id,
                encryption_enabled: backup.encryption_enabled,
                created_at: backup.created_at,
                expires_at: backup.expires_at,
                hours_ago: Math.round(parseFloat(backup.hours_ago))
            }))
        });

    } catch (error) {
        console.error('[Backup List] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al listar backups'
        });
    }
});

// GET /api/backup/latest - Obtener el backup más reciente
router.get('/latest', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId } = req.user;

        const result = await pool.query(
            `SELECT
                id, backup_filename, backup_path, file_size_bytes,
                device_name, device_id, encryption_enabled,
                created_at,
                EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 as hours_ago
             FROM backup_metadata
             WHERE tenant_id = $1 AND branch_id = $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [tenantId, branchId]
        );

        if (result.rows.length === 0) {
            return res.json({
                success: true,
                data: null,
                message: 'No hay backups disponibles'
            });
        }

        const backup = result.rows[0];

        console.log(`[Backup Latest] Branch ${branchId}: ${backup.backup_filename} (${Math.round(backup.hours_ago)}h ago)`);

        res.json({
            success: true,
            data: {
                id: backup.id,
                filename: backup.backup_filename,
                path: backup.backup_path,
                file_size_bytes: parseInt(backup.file_size_bytes),
                file_size_mb: (parseInt(backup.file_size_bytes) / 1024 / 1024).toFixed(2),
                device_name: backup.device_name,
                device_id: backup.device_id,
                encryption_enabled: backup.encryption_enabled,
                created_at: backup.created_at,
                expires_at: backup.expires_at,
                hours_ago: Math.round(parseFloat(backup.hours_ago))
            }
        });

    } catch (error) {
        console.error('[Backup Latest] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al obtener último backup'
        });
    }
});

// GET /api/backup/download/:id - Descargar backup desde Dropbox
router.get('/download/:id', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId } = req.user;
        const { id } = req.params;

        // Obtener metadata del backup
        const metadataResult = await pool.query(
            `SELECT * FROM backup_metadata
             WHERE id = $1 AND tenant_id = $2 AND branch_id = $3`,
            [id, tenantId, branchId]
        );

        if (metadataResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Backup no encontrado'
            });
        }

        const metadata = metadataResult.rows[0];
        const dropboxPath = metadata.backup_path;

        console.log(`[Backup Download] Descargando: ${dropboxPath}`);

        try {
            // Descargar desde Dropbox
            const dbx = getDropboxClient();
            const downloadResult = await dbx.filesDownload({ path: dropboxPath });

            // downloadResult.result.fileBinary contiene el archivo
            const fileBuffer = downloadResult.result.fileBinary;

            // Enviar archivo al cliente
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${metadata.backup_filename}"`);
            res.setHeader('Content-Length', fileBuffer.length);

            console.log(`[Backup Download] ✅ Descargado: ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`);

            res.send(fileBuffer);

        } catch (dropboxError) {
            // Si el token expiró, refrescarlo y reintentar
            if (dropboxError.status === 401) {
                console.log('[Backup Download] Token expirado, refrescando...');
                await refreshDropboxToken();

                const dbx = getDropboxClient();
                const downloadResult = await dbx.filesDownload({ path: dropboxPath });
                const fileBuffer = downloadResult.result.fileBinary;

                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename="${metadata.backup_filename}"`);
                res.setHeader('Content-Length', fileBuffer.length);

                console.log(`[Backup Download] ✅ Descargado (reintento): ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`);

                return res.send(fileBuffer);
            } else {
                throw dropboxError;
            }
        }

    } catch (error) {
        console.error('[Backup Download] ❌ Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al descargar backup',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// DELETE /api/backup/:id - Eliminar backup (admin only)
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const { tenantId, branchId } = req.user;
        const { id } = req.params;

        // Obtener metadata
        const metadataResult = await pool.query(
            `SELECT * FROM backup_metadata
             WHERE id = $1 AND tenant_id = $2 AND branch_id = $3`,
            [id, tenantId, branchId]
        );

        if (metadataResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Backup no encontrado'
            });
        }

        const metadata = metadataResult.rows[0];
        const dropboxPath = metadata.backup_path;

        try {
            // Eliminar de Dropbox
            const dbx = getDropboxClient();
            await dbx.filesDeleteV2({ path: dropboxPath });

            console.log(`[Backup Delete] ✅ Eliminado de Dropbox: ${dropboxPath}`);
        } catch (dropboxError) {
            // Si el archivo ya no existe en Dropbox, continuar
            if (dropboxError.status !== 409) {
                console.warn(`[Backup Delete] ⚠️ Error al eliminar de Dropbox:`, dropboxError.message);
            }
        }

        // Eliminar metadata de PostgreSQL
        await pool.query(
            `DELETE FROM backup_metadata WHERE id = $1`,
            [id]
        );

        console.log(`[Backup Delete] ✅ Metadata eliminada - ID: ${id}`);

        res.json({
            success: true,
            message: 'Backup eliminado exitosamente'
        });

    } catch (error) {
        console.error('[Backup Delete] ❌ Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al eliminar backup'
        });
    }
});

// POST /api/backup/cleanup-expired - Limpiar backups expirados (cron job)
router.post('/cleanup-expired', async (req, res) => {
    try {
        // Obtener backups expirados
        const expiredResult = await pool.query(
            `SELECT id, backup_path FROM backup_metadata
             WHERE expires_at < NOW()`
        );

        const expiredCount = expiredResult.rows.length;

        if (expiredCount === 0) {
            return res.json({
                success: true,
                message: 'No hay backups expirados',
                deleted: 0
            });
        }

        console.log(`[Backup Cleanup] Eliminando ${expiredCount} backups expirados...`);

        const dbx = getDropboxClient();
        let deletedFromDropbox = 0;

        // Eliminar de Dropbox
        for (const backup of expiredResult.rows) {
            try {
                await dbx.filesDeleteV2({ path: backup.backup_path });
                deletedFromDropbox++;
            } catch (error) {
                console.warn(`[Backup Cleanup] No se pudo eliminar: ${backup.backup_path}`);
            }
        }

        // Eliminar metadata de PostgreSQL
        await pool.query(`DELETE FROM backup_metadata WHERE expires_at < NOW()`);

        console.log(`[Backup Cleanup] ✅ ${expiredCount} backups eliminados (${deletedFromDropbox} de Dropbox)`);

        res.json({
            success: true,
            message: 'Limpieza completada',
            deleted: expiredCount,
            deleted_from_dropbox: deletedFromDropbox
        });

    } catch (error) {
        console.error('[Backup Cleanup] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Error al limpiar backups expirados'
        });
    }
});

module.exports = router;
