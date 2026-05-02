/**
 * Thumbnail Generator
 * Uses Sharp for high-quality, fast server-side image resizing
 */
const sharp = require('sharp');

/**
 * Generate a JPEG thumbnail from a Buffer
 * @param {Buffer} inputBuffer  — original image buffer
 * @param {number} maxWidth     — max width in pixels (default 600)
 * @param {number} maxHeight    — max height in pixels (default 400)
 * @returns {Promise<Buffer>}   — JPEG thumbnail buffer
 */
async function generateThumbnail(inputBuffer, maxWidth = 600, maxHeight = 400) {
  return sharp(inputBuffer)
    .resize(maxWidth, maxHeight, {
      fit:       'inside',         // preserve aspect ratio
      withoutEnlargement: true,    // don't upscale small images
    })
    .jpeg({
      quality:     80,
      progressive: true,
      mozjpeg:     true,           // better compression
    })
    .toBuffer();
}

/**
 * Generate a square thumbnail (e.g. for grid cards)
 */
async function generateSquareThumbnail(inputBuffer, size = 400) {
  return sharp(inputBuffer)
    .resize(size, size, {
      fit:      'cover',
      position: 'attention', // smart crop using attention-based detection
    })
    .jpeg({ quality: 80, progressive: true, mozjpeg: true })
    .toBuffer();
}

/**
 * Get image metadata (dimensions, format, etc.)
 */
async function getImageMetadata(buffer) {
  const meta = await sharp(buffer).metadata();
  return {
    width:  meta.width,
    height: meta.height,
    format: meta.format,
    size:   meta.size,
  };
}

module.exports = { generateThumbnail, generateSquareThumbnail, getImageMetadata };