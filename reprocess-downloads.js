/**
 * reprocess-downloads.js — ONE-OFF script.
 *
 * Reprocesses every existing file in assets/downloads/ through the same
 * resize+watermark pipeline that /upload-painting-image now applies to new
 * uploads (see watermark-lib.js). Run this once on the server after
 * deploying the watermark-lib.js / save-artworks.js changes and running
 * `npm install` (for sharp).
 *
 * Safety:
 *   - Copies the current assets/downloads/ into backups/downloads-pre-watermark-<timestamp>/
 *     BEFORE touching anything, so the pre-resize files are recoverable.
 *   - assets/paintings/full/ (the gallery's real full-res originals) is
 *     never touched by this script.
 *
 * Usage (on the server, from the project root):
 *   node reprocess-downloads.js
 */

const fs = require('fs');
const path = require('path');
const { processDownloadImage, MAX_DIMENSION, JPEG_QUALITY, WATERMARK_TEXT } = require('./watermark-lib');

const DOWNLOADS_DIR = path.join(__dirname, 'assets', 'downloads');
const BACKUP_DIR = path.join(__dirname, 'backups', `downloads-pre-watermark-${new Date().toISOString().replace(/[:.]/g, '-')}`);

async function main() {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
        console.error(`Pasta não encontrada: ${DOWNLOADS_DIR}`);
        process.exit(1);
    }

    const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
    if (!files.length) {
        console.log('Nenhum ficheiro para reprocessar em assets/downloads/.');
        return;
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`Reprocessando ${files.length} ficheiro(s) — limite ${MAX_DIMENSION}px, JPEG q${JPEG_QUALITY}, watermark "${WATERMARK_TEXT}"`);
    console.log(`Backup dos originais em: ${BACKUP_DIR}\n`);

    const results = [];
    for (const file of files) {
        const srcPath = path.join(DOWNLOADS_DIR, file);
        const backupPath = path.join(BACKUP_DIR, file);
        const beforeBytes = fs.statSync(srcPath).size;

        try {
            fs.copyFileSync(srcPath, backupPath);
            const { bytes: afterBytes, width, height } = await processDownloadImage(srcPath, srcPath);
            results.push({ file, ok: true, beforeBytes, afterBytes, width, height });
            console.log(`OK   ${file}  ${(beforeBytes / 1024).toFixed(0)}KB -> ${(afterBytes / 1024).toFixed(0)}KB  (${width}x${height})`);
        } catch (err) {
            results.push({ file, ok: false, error: err.message });
            console.error(`FAIL ${file}  ${err.message}`);
        }
    }

    const okCount = results.filter(r => r.ok).length;
    const failCount = results.length - okCount;
    console.log(`\n${okCount} ok, ${failCount} falha(s).`);
    if (failCount > 0) {
        console.log('Ficheiros com falha (originais intactos, nada foi sobrescrito neles):');
        results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.file}: ${r.error}`));
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error('Erro fatal:', err);
    process.exit(1);
});
