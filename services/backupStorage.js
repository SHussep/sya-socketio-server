/**
 * services/backupStorage.js
 *
 * Storage adapter para full-backups encriptados (Fase 5 — Task 25).
 *
 * Interfaz mínima:
 *   putObjectEncrypted(key, buffer)  → { key, sizeBytes }
 *   getSignedUrl(key, ttlSec)        → string (URL firmada)
 *   deleteObject(key)                → void
 *
 * Driver seleccionado vía env:
 *   BACKUP_STORAGE_DRIVER = 'fs' (default) | 's3'
 *
 * Driver 'fs' (default):
 *   - Escribe el blob encriptado bajo BACKUP_STORAGE_DIR (default: './backups').
 *   - `getSignedUrl` devuelve una URL hacia el endpoint local
 *     `GET /api/sync-diagnostics/backup-download?token=<jwt>` donde el token
 *     HS256 (BACKUP_DOWNLOAD_SECRET) incluye la `key` y un `exp` corto.
 *   - El blob NO es "signed" en el sentido S3; la firma la hace el JWT
 *     validado por el endpoint. Suficiente para hosting self-managed.
 *
 * Driver 's3':
 *   - Stub — lanza 'not_implemented'. Se conecta en Task 32 (pre-deploy)
 *     cuando se decida bucket definitivo (AWS / Cloudflare R2 / Backblaze B2).
 *
 * NOTA DE SEGURIDAD:
 *   Los blobs YA vienen encriptados desde el desktop (AES-256-GCM + PBKDF2,
 *   Task 26). Este servicio NO vuelve a encriptar — solo persiste el blob
 *   cifrado tal cual llegó. El nombre `putObjectEncrypted` refleja que lo
 *   que se guarda está encriptado (no que esta capa lo encripte).
 */

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const DRIVER = (process.env.BACKUP_STORAGE_DRIVER || 'fs').toLowerCase();
const FS_DIR = process.env.BACKUP_STORAGE_DIR || path.join(process.cwd(), 'backups');

function buildFsAdapter() {
    // Asegura que el directorio raíz exista al iniciar — falla rápido si el
    // filesystem es read-only o la ruta no es válida.
    try {
        fs.mkdirSync(FS_DIR, { recursive: true });
    } catch (e) {
        console.error(`[backupStorage] ❌ No se pudo crear ${FS_DIR}: ${e.message}`);
        throw e;
    }

    function resolveKey(key) {
        // Previene path traversal: rechaza '..' y rutas absolutas.
        if (!key || typeof key !== 'string') throw new Error('invalid_key');
        if (key.includes('..')) throw new Error('invalid_key');
        if (path.isAbsolute(key)) throw new Error('invalid_key');
        const resolved = path.resolve(FS_DIR, key);
        if (!resolved.startsWith(path.resolve(FS_DIR) + path.sep) &&
            resolved !== path.resolve(FS_DIR)) {
            throw new Error('invalid_key');
        }
        return resolved;
    }

    return {
        driver: 'fs',

        async putObjectEncrypted(key, buffer) {
            const full = resolveKey(key);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            await fs.promises.writeFile(full, buffer);
            const stat = await fs.promises.stat(full);
            return { key, sizeBytes: stat.size };
        },

        async getSignedUrl(key, ttlSec) {
            resolveKey(key); // validación; no usa el resolved
            const secret = process.env.BACKUP_DOWNLOAD_SECRET;
            if (!secret) throw new Error('BACKUP_DOWNLOAD_SECRET not set');
            const token = jwt.sign(
                { key, scope: 'backup_download' },
                secret,
                { expiresIn: `${Math.max(60, Math.min(3600, Number(ttlSec) || 900))}s`, algorithm: 'HS256' }
            );
            const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
            const path = '/api/sync-diagnostics/backup-download';
            return base
                ? `${base}${path}?token=${encodeURIComponent(token)}`
                : `${path}?token=${encodeURIComponent(token)}`;
        },

        async deleteObject(key) {
            const full = resolveKey(key);
            try {
                await fs.promises.unlink(full);
            } catch (e) {
                if (e.code !== 'ENOENT') throw e;
            }
        },

        // Extra: usado por el endpoint de descarga del driver 'fs'.
        _resolveKeyForDownload(key) {
            return resolveKey(key);
        }
    };
}

function buildS3Adapter() {
    // TODO Task 32: integrar @aws-sdk/client-s3 con presigned URLs nativos.
    const notImpl = (_fnName) => { throw new Error('s3_driver_not_implemented'); };
    return {
        driver: 's3',
        putObjectEncrypted: () => notImpl('putObjectEncrypted'),
        getSignedUrl: () => notImpl('getSignedUrl'),
        deleteObject: () => notImpl('deleteObject'),
        _resolveKeyForDownload: () => notImpl('download')
    };
}

const adapter = DRIVER === 's3' ? buildS3Adapter() : buildFsAdapter();

module.exports = adapter;
