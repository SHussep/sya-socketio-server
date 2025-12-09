const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

// Configuración de versiones
// En producción, esto debería venir de la base de datos o un archivo de configuración
const RELEASES = {
  // Versión actual publicada
  latest: {
    version: '1.0.0',
    downloadUrl: 'https://syatortillerias.com.mx/downloads/SYATortilleriasBeta_1.0.0_Setup.exe',
    releaseNotes: `
## Versión 1.0.0 - Beta Inicial

### Nuevas funciones:
- Sistema de ventas con báscula integrada
- Gestión de clientes y créditos
- Control de gastos y compras
- Dashboard de métricas
- Sistema Guardian anti-robo

### Correcciones:
- Primera versión beta
    `.trim(),
    minimumVersion: '1.0.0',
    isMandatory: false,
    checksum: '', // SHA256 del archivo MSIX
    releasedAt: new Date().toISOString()
  },

  // Historial de versiones (para rollback si es necesario)
  history: []
};

/**
 * GET /api/desktop/updates/latest
 * Verifica si hay actualizaciones disponibles
 * Query params:
 *   - current: versión actual del cliente (ej: "1.0.0")
 */
router.get('/latest', (req, res) => {
  try {
    const currentVersion = req.query.current || '0.0.0';
    const latest = RELEASES.latest;

    console.log(`[UPDATES] Cliente v${currentVersion} verificando actualizaciones. Última: v${latest.version}`);

    // Comparar versiones
    const hasUpdate = compareVersions(latest.version, currentVersion) > 0;

    if (hasUpdate) {
      console.log(`[UPDATES] Actualización disponible: ${currentVersion} -> ${latest.version}`);
      res.json(latest);
    } else {
      console.log(`[UPDATES] Cliente ya tiene la última versión`);
      res.json({ version: currentVersion, upToDate: true });
    }
  } catch (error) {
    console.error('[UPDATES] Error:', error);
    res.status(500).json({ error: 'Error verificando actualizaciones' });
  }
});

/**
 * GET /api/desktop/updates/history
 * Obtiene historial de versiones
 */
router.get('/history', (req, res) => {
  res.json({
    current: RELEASES.latest,
    history: RELEASES.history
  });
});

/**
 * POST /api/desktop/updates/report-install
 * Reporta una instalación exitosa (para estadísticas)
 */
router.post('/report-install', (req, res) => {
  const { version, machineId, tenantId } = req.body;

  console.log(`[UPDATES] Instalación reportada: v${version} en tenant ${tenantId}`);

  // Aquí podrías guardar estadísticas en la BD
  // await pool.query('INSERT INTO desktop_installations ...')

  res.json({ success: true });
});

/**
 * POST /api/desktop/updates/report-error
 * Reporta un error de actualización
 */
router.post('/report-error', (req, res) => {
  const { version, error, machineId, tenantId } = req.body;

  console.error(`[UPDATES] Error de actualización reportado: v${version}`, error);

  // Aquí podrías guardar el error para análisis
  // await pool.query('INSERT INTO update_errors ...')

  res.json({ success: true });
});

// Utilidad para comparar versiones semánticas
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;

    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }

  return 0;
}

module.exports = router;
