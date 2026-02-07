/**
 * Script para subir imágenes de productos semilla a Cloudinary
 *
 * Uso:
 *   1. Coloca las 6 imágenes en la carpeta ./scripts/seed-images/
 *   2. Ejecuta: node scripts/uploadSeedProductImages.js
 *
 * Las imágenes deben llamarse:
 *   - tortilla_maiz.webp (o .png/.jpg)
 *   - masa.png
 *   - totopos.png
 *   - salsa_roja.png
 *   - salsa_verde.png
 *   - tortilla_harina.png
 */

require('dotenv').config();
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');

// Configurar Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Mapeo de productos semilla
const SEED_PRODUCTS = [
  { id: 9001, name: 'tortilla_maiz', description: 'Tortilla de Maíz' },
  { id: 9002, name: 'masa', description: 'Masa' },
  { id: 9003, name: 'totopos', description: 'Totopos' },
  { id: 9004, name: 'salsa_roja', description: 'Salsa Roja' },
  { id: 9005, name: 'salsa_verde', description: 'Salsa Verde' },
  { id: 9006, name: 'tortilla_harina', description: 'Tortilla de Harina' },
];

// Extensiones de imagen soportadas
const IMAGE_EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg'];

// Carpeta donde deben estar las imágenes
const IMAGES_FOLDER = path.join(__dirname, 'seed-images');

async function findImageFile(baseName) {
  for (const ext of IMAGE_EXTENSIONS) {
    const filePath = path.join(IMAGES_FOLDER, `${baseName}${ext}`);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

async function uploadImage(filePath, publicId, description) {
  console.log(`\n📤 Subiendo: ${description}`);
  console.log(`   Archivo: ${path.basename(filePath)}`);
  console.log(`   Public ID: ${publicId}`);

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      public_id: publicId,
      overwrite: true,
      resource_type: 'image',
      folder: '', // El public_id ya incluye la carpeta
      transformation: [
        { width: 400, height: 400, crop: 'limit' },
        { quality: 'auto:good' },
      ],
      tags: ['seed-product', 'producto-semilla'],
    });

    console.log(`   ✅ Subido exitosamente`);
    console.log(`   URL: ${result.secure_url}`);
    console.log(`   Tamaño: ${Math.round(result.bytes / 1024)}KB`);

    return result;
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SUBIR IMÁGENES DE PRODUCTOS SEMILLA A CLOUDINARY');
  console.log('═══════════════════════════════════════════════════════════════');

  // Verificar configuración de Cloudinary
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('\n❌ Error: Variables de entorno de Cloudinary no configuradas');
    console.error('   Asegúrate de tener CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET en .env');
    process.exit(1);
  }

  console.log(`\n☁️  Cloud Name: ${process.env.CLOUDINARY_CLOUD_NAME}`);

  // Verificar que existe la carpeta de imágenes
  if (!fs.existsSync(IMAGES_FOLDER)) {
    console.error(`\n❌ Error: No existe la carpeta de imágenes`);
    console.error(`   Crea la carpeta: ${IMAGES_FOLDER}`);
    console.error(`   Y coloca las 6 imágenes de productos semilla`);

    // Crear la carpeta para facilitar al usuario
    fs.mkdirSync(IMAGES_FOLDER, { recursive: true });
    console.log(`\n📁 Carpeta creada: ${IMAGES_FOLDER}`);
    console.log('   Coloca las siguientes imágenes:');
    SEED_PRODUCTS.forEach(p => {
      console.log(`   - ${p.name}.png (o .webp/.jpg) → ${p.description}`);
    });
    process.exit(1);
  }

  // Buscar y subir cada imagen
  let uploaded = 0;
  let failed = 0;
  let notFound = 0;

  for (const product of SEED_PRODUCTS) {
    const imagePath = await findImageFile(product.name);

    if (!imagePath) {
      console.log(`\n⚠️  No encontrada: ${product.description}`);
      console.log(`   Buscando: ${product.name}.{webp,png,jpg,jpeg}`);
      notFound++;
      continue;
    }

    const publicId = `sya-seed-products/${product.name}`;
    const result = await uploadImage(imagePath, publicId, product.description);

    if (result) {
      uploaded++;
    } else {
      failed++;
    }
  }

  // Resumen
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RESUMEN');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ✅ Subidas exitosamente: ${uploaded}`);
  console.log(`  ❌ Fallidas: ${failed}`);
  console.log(`  ⚠️  No encontradas: ${notFound}`);
  console.log('═══════════════════════════════════════════════════════════════');

  if (uploaded === SEED_PRODUCTS.length) {
    console.log('\n🎉 ¡Todas las imágenes de productos semilla están en Cloudinary!');
    console.log('   Los productos semilla ahora mostrarán imágenes en todas las apps.');
  } else if (notFound > 0) {
    console.log(`\n📁 Coloca las imágenes faltantes en: ${IMAGES_FOLDER}`);
    console.log('   Y ejecuta este script nuevamente.');
  }
}

main().catch(console.error);
