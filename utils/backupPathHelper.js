/**
 * Utilidades para construir rutas de backup en Dropbox
 * Estructura: /SYA_Backups/{tenantId}_{tenantCode}/{branchId}_{branchCode}/backup_{backupId}_{timestamp}.zip
 */

function constructBackupDirectory(tenantId, tenantCode, branchId, branchCode) {
    // Sanitize codes to avoid path issues
    const safeTenantCode = sanitizePathSegment(tenantCode);
    const safeBranchCode = sanitizePathSegment(branchCode);
    
    return `/SYA_Backups/${tenantId}_${safeTenantCode}/${branchId}_${safeBranchCode}`;
}

function constructBackupFilename(backupId, timestamp = null) {
    const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '').slice(0, -4);
    return `backup_${backupId}_${ts}.zip`;
}

function constructBackupMetadataFilename(backupId, timestamp = null) {
    const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '').slice(0, -4);
    return `backup_${backupId}_${ts}.json`;
}

function constructFullBackupPath(tenantId, tenantCode, branchId, branchCode, backupId, timestamp = null) {
    const dir = constructBackupDirectory(tenantId, tenantCode, branchId, branchCode);
    const filename = constructBackupFilename(backupId, timestamp);
    return `${dir}/${filename}`;
}

function constructFullMetadataPath(tenantId, tenantCode, branchId, branchCode, backupId, timestamp = null) {
    const dir = constructBackupDirectory(tenantId, tenantCode, branchId, branchCode);
    const filename = constructBackupMetadataFilename(backupId, timestamp);
    return `${dir}/${filename}`;
}

function sanitizePathSegment(segment) {
    // Remove or replace invalid characters for Dropbox paths
    return segment
        .replace(/[\/\:*?"<>|]/g, '_') // Replace invalid path characters
        .replace(/\s+/g, '_') // Replace spaces with underscores
        .slice(0, 50); // Limit length
}

function extractIdsFromPath(backupPath) {
    // Parse: /SYA_Backups/2_LETICIA/4_LETICIA-BR4/backup_8_20251021_004147.zip
    const match = backupPath.match(/\/SYA_Backups\/(\d+)_[^\/]+\/(\d+)_[^\/]+\/backup_(\d+)_/);
    if (match) {
        return {
            tenantId: parseInt(match[1]),
            branchId: parseInt(match[2]),
            backupId: parseInt(match[3])
        };
    }
    return null;
}

module.exports = {
    constructBackupDirectory,
    constructBackupFilename,
    constructBackupMetadataFilename,
    constructFullBackupPath,
    constructFullMetadataPath,
    sanitizePathSegment,
    extractIdsFromPath
};
