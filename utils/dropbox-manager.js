// ═══════════════════════════════════════════════════════════════
// DROPBOX MANAGER: Manejo automático de tokens y operaciones
// ═══════════════════════════════════════════════════════════════

const { Dropbox } = require('dropbox');
const fetch = require('node-fetch');
const axios = require('axios');

class DropboxManager {
    constructor() {
        this.accessToken = process.env.DROPBOX_ACCESS_TOKEN;
        this.refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
        this.appKey = process.env.DROPBOX_APP_KEY;
        this.appSecret = process.env.DROPBOX_APP_SECRET;
        this.dbx = null;
        this.tokenExpiresAt = null;
    }

    /**
     * Refresca el access token usando el refresh token
     */
    async refreshAccessToken() {
        try {
            console.log('[Dropbox Manager] Refrescando access token...');

            const response = await axios.post('https://api.dropbox.com/oauth2/token',
                new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: this.refreshToken,
                    client_id: this.appKey,
                    client_secret: this.appSecret
                }),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            const { access_token, expires_in } = response.data;

            this.accessToken = access_token;
            this.tokenExpiresAt = Date.now() + (expires_in * 1000) - (5 * 60 * 1000); // 5 minutos antes de expirar

            // Recrear instancia de Dropbox con nuevo token
            this.dbx = new Dropbox({
                accessToken: this.accessToken,
                fetch: fetch
            });

            console.log(`[Dropbox Manager] ✅ Token refrescado. Expira en ${(expires_in / 3600).toFixed(2)} horas`);

            return access_token;
        } catch (error) {
            console.error('[Dropbox Manager] ❌ Error al refrescar token:', error.message);
            throw error;
        }
    }

    /**
     * Verifica si el token necesita ser refrescado
     */
    needsRefresh() {
        if (!this.tokenExpiresAt) {
            // Si no tenemos tiempo de expiración, asumir que necesita refresh
            return true;
        }
        return Date.now() >= this.tokenExpiresAt;
    }

    /**
     * Obtiene una instancia válida de Dropbox, refrescando el token si es necesario
     */
    async getClient() {
        if (!this.dbx || this.needsRefresh()) {
            await this.refreshAccessToken();
        }
        return this.dbx;
    }

    /**
     * Sube un archivo a Dropbox
     * @param {string} path - Ruta completa en Dropbox (ej: /SYA Backups/tenant_123/branch_456/backup.zip)
     * @param {Buffer|string} contents - Contenido del archivo
     * @param {boolean} overwrite - Si debe sobrescribir el archivo existente
     */
    async uploadFile(path, contents, overwrite = true) {
        try {
            const client = await this.getClient();

            const result = await client.filesUpload({
                path: path,
                contents: contents,
                mode: overwrite ? { '.tag': 'overwrite' } : { '.tag': 'add' },
                autorename: !overwrite,
                mute: false
            });

            console.log(`[Dropbox Manager] ✅ Archivo subido: ${path}`);
            return result;
        } catch (error) {
            console.error(`[Dropbox Manager] ❌ Error subiendo archivo ${path}:`, error.message);
            throw error;
        }
    }

    /**
     * Crea una carpeta en Dropbox (crea carpetas padre si no existen)
     * @param {string} path - Ruta de la carpeta (ej: /SYA Backups/tenant_123/branch_456)
     */
    async createFolder(path) {
        try {
            const client = await this.getClient();

            // Crear carpetas recursivamente
            const pathParts = path.split('/').filter(p => p);
            let currentPath = '';

            for (const part of pathParts) {
                currentPath += '/' + part;

                try {
                    await client.filesCreateFolderV2({ path: currentPath });
                    console.log(`[Dropbox Manager] ✅ Carpeta creada: ${currentPath}`);
                } catch (error) {
                    if (error.error?.error['.tag'] === 'path' &&
                        error.error?.error.path['.tag'] === 'conflict') {
                        // La carpeta ya existe, continuar
                    } else {
                        throw error;
                    }
                }
            }

            return { success: true, path };
        } catch (error) {
            console.error(`[Dropbox Manager] ❌ Error creando carpeta ${path}:`, error.message);
            throw error;
        }
    }

    /**
     * Lista archivos en una carpeta
     * @param {string} path - Ruta de la carpeta
     */
    async listFiles(path) {
        try {
            const client = await this.getClient();
            const result = await client.filesListFolder({ path });
            return result.result.entries;
        } catch (error) {
            console.error(`[Dropbox Manager] ❌ Error listando archivos en ${path}:`, error.message);
            throw error;
        }
    }

    /**
     * Elimina un archivo o carpeta
     * @param {string} path - Ruta del archivo o carpeta
     */
    async deleteFile(path) {
        try {
            const client = await this.getClient();
            await client.filesDeleteV2({ path });
            console.log(`[Dropbox Manager] ✅ Eliminado: ${path}`);
            return { success: true };
        } catch (error) {
            console.error(`[Dropbox Manager] ❌ Error eliminando ${path}:`, error.message);
            throw error;
        }
    }

    /**
     * Obtiene información de la cuenta de Dropbox
     */
    async getAccountInfo() {
        try {
            const client = await this.getClient();
            const result = await client.usersGetCurrentAccount();
            return result.result;
        } catch (error) {
            console.error('[Dropbox Manager] ❌ Error obteniendo info de cuenta:', error.message);
            throw error;
        }
    }
}

// Singleton: exportar una única instancia
const dropboxManager = new DropboxManager();

module.exports = dropboxManager;
