/**
 * watermark-lib.js
 * Shared image-processing for the "Digital Download" deliverable.
 *
 * Used by:
 *   - save-artworks.js (POST /upload-painting-image) — new uploads
 *   - reprocess-downloads.js — one-off pass over existing assets/downloads/*
 *
 * What it does to every file that becomes a paid digital download:
 *   1. Caps resolution to MAX_DIMENSION on the longest side (deters
 *      high-quality printing while keeping the file good on screen).
 *   2. Re-encodes as JPEG at JPEG_QUALITY.
 *   3. Burns in a centered, semi-transparent "magnaleite.com" watermark
 *      (visible on screen and on any print, hard to crop out since it's
 *      centered rather than in a corner).
 *
 * This does NOT touch assets/paintings/full/ (the gallery's own full-res
 * originals) — only the copy that gets served as the digital download.
 */

const fs = require('fs');
const sharp = require('sharp');

const MAX_DIMENSION = 1800;   // longest side, px
const JPEG_QUALITY = 85;
const WATERMARK_TEXT = 'magnaleite.com';

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildWatermarkSvg(width, height) {
    const fontSize = Math.round(Math.min(width, height) * 0.065);
    const cx = width / 2;
    const cy = height / 2;
    const text = escapeXml(WATERMARK_TEXT);
    return Buffer.from(`
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <text x="${cx}" y="${cy}"
                  text-anchor="middle" dominant-baseline="middle"
                  transform="rotate(-30 ${cx} ${cy})"
                  font-family="Arial, Helvetica, sans-serif"
                  font-size="${fontSize}"
                  font-weight="600"
                  fill="#ffffff" fill-opacity="0.35"
                  stroke="#000000" stroke-opacity="0.18" stroke-width="2"
                  paint-order="stroke">${text}</text>
        </svg>
    `);
}

/**
 * Reads srcPath, resizes + watermarks it, returns a JPEG Buffer.
 * Does not write anything — caller decides where/how to save.
 */
async function renderProtectedJpeg(srcPath) {
    const oriented = sharp(srcPath).rotate(); // auto-orient via EXIF, then strip it
    const { data: resizedData, info } = await oriented
        .resize({
            width: MAX_DIMENSION,
            height: MAX_DIMENSION,
            fit: 'inside',
            withoutEnlargement: true,
        })
        .toBuffer({ resolveWithObject: true });

    const svg = buildWatermarkSvg(info.width, info.height);

    const finalBuffer = await sharp(resizedData)
        .composite([{ input: svg, gravity: 'centre' }])
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toBuffer();

    return { buffer: finalBuffer, width: info.width, height: info.height };
}

/**
 * Renders srcPath and writes the result to destPath (safe even when
 * srcPath === destPath — the whole thing is rendered into memory first,
 * then written via a temp file + rename).
 */
async function processDownloadImage(srcPath, destPath) {
    const { buffer, width, height } = await renderProtectedJpeg(srcPath);
    const tmpPath = destPath + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, destPath);
    return { bytes: buffer.length, width, height };
}

module.exports = {
    MAX_DIMENSION,
    JPEG_QUALITY,
    WATERMARK_TEXT,
    renderProtectedJpeg,
    processDownloadImage,
};
