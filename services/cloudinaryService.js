/**
 * Servicio de Cloudinary para subir imágenes de recibos
 * Organiza las imágenes por tenant/branch/employee
 */

const cloudinary = require('cloudinary').v2;

// Configurar Cloudinary con variables de entorno
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Sube una imagen de recibo a Cloudinary
 * @param {string} base64Image - Imagen en Base64 (con o sin prefijo data:image/...)
 * @param {object} options - Opciones de organización
 * @param {number} options.tenantId - ID del tenant
 * @param {number} options.branchId - ID de la sucursal
 * @param {number} options.employeeId - ID del empleado
 * @param {string} options.expenseGlobalId - Global ID del gasto (para nombre único)
 * @returns {Promise<{url: string, publicId: string}>} URL pública y public_id de Cloudinary
 */
async function uploadReceiptImage(base64Image, options) {
  const { tenantId, branchId, employeeId, expenseGlobalId } = options;

  // Verificar que Cloudinary está configurado
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('[Cloudinary] ❌ Variables de entorno no configuradas');
    throw new Error('Cloudinary no está configurado. Verifique las variables de entorno.');
  }

  // Asegurar que la imagen tenga el prefijo correcto para Cloudinary
  let imageData = base64Image;
  if (!base64Image.startsWith('data:')) {
    // Asumir JPEG si no tiene prefijo
    imageData = `data:image/jpeg;base64,${base64Image}`;
  }

  // Crear la carpeta organizada: sya-receipts/tenant_{id}/branch_{id}/
  const folder = `sya-receipts/tenant_${tenantId}/branch_${branchId}`;

  // Usar el global_id del gasto como nombre único
  const publicId = `${folder}/expense_${expenseGlobalId}`;

  console.log(`[Cloudinary] 📤 Subiendo imagen a ${publicId}...`);
  const startTime = Date.now();

  try {
    const result = await cloudinary.uploader.upload(imageData, {
      public_id: publicId,
      overwrite: true, // Sobrescribir si ya existe (para actualizaciones)
      resource_type: 'image',
      // Transformaciones para optimizar
      transformation: [
        { width: 1200, height: 1600, crop: 'limit' }, // Limitar tamaño máximo
        { quality: 'auto:good' }, // Calidad automática
        { fetch_format: 'auto' }, // Formato óptimo (WebP si el navegador lo soporta)
      ],
      // Tags para facilitar búsquedas
      tags: [`tenant_${tenantId}`, `branch_${branchId}`, `employee_${employeeId}`, 'receipt'],
      // Contexto adicional (metadata)
      context: {
        tenant_id: String(tenantId),
        branch_id: String(branchId),
        employee_id: String(employeeId),
        expense_global_id: expenseGlobalId,
      },
    });

    const elapsed = Date.now() - startTime;
    console.log(`[Cloudinary] ✅ Imagen subida en ${elapsed}ms`);
    console.log(`[Cloudinary] URL: ${result.secure_url}`);
    console.log(`[Cloudinary] Tamaño: ${Math.round(result.bytes / 1024)}KB`);

    return {
      url: result.secure_url,
      publicId: result.public_id,
    };
  } catch (error) {
    console.error('[Cloudinary] ❌ Error subiendo imagen:', error.message);
    throw error;
  }
}

/**
 * Elimina una imagen de Cloudinary
 * @param {string} publicId - Public ID de la imagen a eliminar
 * @returns {Promise<boolean>} true si se eliminó exitosamente
 */
async function deleteReceiptImage(publicId) {
  if (!publicId) {
    console.log('[Cloudinary] ⚠️ No hay publicId para eliminar');
    return false;
  }

  try {
    console.log(`[Cloudinary] 🗑️ Eliminando imagen: ${publicId}`);
    const result = await cloudinary.uploader.destroy(publicId);

    if (result.result === 'ok') {
      console.log('[Cloudinary] ✅ Imagen eliminada');
      return true;
    } else {
      console.log(`[Cloudinary] ⚠️ Resultado: ${result.result}`);
      return false;
    }
  } catch (error) {
    console.error('[Cloudinary] ❌ Error eliminando imagen:', error.message);
    return false;
  }
}

/**
 * Genera una URL optimizada para una imagen existente
 * @param {string} publicId - Public ID de la imagen
 * @param {object} options - Opciones de transformación
 * @returns {string} URL optimizada
 */
function getOptimizedUrl(publicId, options = {}) {
  const { width = 800, height = 1000, quality = 'auto:good' } = options;

  return cloudinary.url(publicId, {
    secure: true,
    transformation: [
      { width, height, crop: 'limit' },
      { quality },
      { fetch_format: 'auto' },
    ],
  });
}

/**
 * Verifica si Cloudinary está correctamente configurado
 * @returns {boolean}
 */
function isConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

module.exports = {
  uploadReceiptImage,
  deleteReceiptImage,
  getOptimizedUrl,
  isConfigured,
};
