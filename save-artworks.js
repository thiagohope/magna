/**
 * Magna API — save-artworks.js
 * Managed by PM2. Listens on 127.0.0.1:3100 (local only, not public).
 *
 * Endpoints:
 *   GET  /health
 *   POST /save-artworks            { ...artworks object... }            -> artworks.json
 *   POST /save-exhibitions         { ...exhibitions object... }         -> exhibitions.json
 *   POST /upload-painting-image    { filename, type, imageData }        -> assets/paintings/<full|thumbnails>/<filename>
 *   POST /upload-exhibition-flyer  { filename, imageData }              -> assets/exhibition/flyers/<filename>
 *   POST /upload-exhibition-gallery{ slug, filename, imageData }        -> assets/exhibition/img/<slug>/<filename>
 *
 * Nginx proxies /magna/api/* → this server (one location block per endpoint).
 *
 * Start:  pm2 start ecosystem.config.js
 * Logs:   pm2 logs magna-api
 * Stop:   pm2 stop magna-api
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const PORT         = 3100;
const HOST         = '127.0.0.1';                          // local only, never public
const ARTWORKS_PATH    = path.join(__dirname, 'artworks.json');
const EXHIBITIONS_PATH = path.join(__dirname, 'exhibitions.json');
const COLLECTIONS_PATH = path.join(__dirname, 'collections.json');
const BACKUP_DIR   = path.join(__dirname, 'backups');
const ASSETS_DIR   = path.join(__dirname, 'assets');
const PAINTINGS_FULL_DIR      = path.join(ASSETS_DIR, 'paintings', 'full');
const PAINTINGS_THUMBS_DIR    = path.join(ASSETS_DIR, 'paintings', 'thumbnails');
const DOWNLOADS_DIR           = path.join(ASSETS_DIR, 'downloads');
const EXHIBITION_FLYERS_DIR   = path.join(ASSETS_DIR, 'exhibition', 'flyers');
const EXHIBITION_GALLERY_DIR  = path.join(ASSETS_DIR, 'exhibition', 'img');
const ABOUT_DIR               = path.join(ASSETS_DIR, 'img', 'about');
const MAX_JSON_SIZE  = 2 * 1024 * 1024;   // 2MB — for artworks.json / exhibitions.json bodies
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;  // 10MB — for base64 image uploads
const API_SECRET   = process.env.MAGNA_API_SECRET || 'CHANGE_THIS_SECRET';
// Set secret via ecosystem.config.js (not committed to git):
//   env: { MAGNA_API_SECRET: 'your_strong_secret' }
// Then restart: pm2 restart magna-api

// ── HELPERS ─────────────────────────────────────────────────────────────────
function ensureBackupDir() {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function makeBackup(filePath, prefix) {
    ensureBackupDir();
    if (!fs.existsSync(filePath)) return;
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `${prefix}-${ts}.json`);
    fs.copyFileSync(filePath, dest);

    // Keep only 20 most recent backups per prefix
    const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith(`${prefix}-`) && f.endsWith('.json'))
        .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
    files.slice(20).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f.name)));
}

// Allowed image extensions and a strict filename pattern (no paths, no traversal)
const FILENAME_PATTERN = /^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/i;
const SLUG_PATTERN     = /^[a-z0-9-]+$/;

function isValidFilename(name) {
    return typeof name === 'string' && FILENAME_PATTERN.test(name);
}

function isValidSlug(slug) {
    return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

// Decode a base64 data URL or raw base64 string and write atomically to destPath
function saveBase64Image(imageData, destPath) {
    if (typeof imageData !== 'string' || imageData.length === 0) {
        throw new Error('imageData ausente ou inválido');
    }
    // Strip data URL prefix if present (e.g. "data:image/jpeg;base64,...")
    const base64 = imageData.includes(',') ? imageData.split(',')[1] : imageData;
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) {
        throw new Error('Imagem decodificada está vazia');
    }
    if (buffer.length > MAX_IMAGE_SIZE) {
        throw new Error(`Imagem excede o limite de ${MAX_IMAGE_SIZE / (1024*1024)}MB`);
    }
    const tmpPath = destPath + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, destPath);
    return buffer.length;
}

function respond(res, status, body) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': req.headers.origin === 'https://magnaleite.com'
            ? 'https://magnaleite.com'
            : 'https://brainboxmed.com',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Magna-Secret'
    });
    res.end(JSON.stringify(body));
}

// Reads and parses a JSON request body, enforcing a max size and calling
// onSuccess(parsedObj) accordingly. Responds with errors itself on failure.
function readJsonBody(req, res, maxSize, onSuccess) {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
        body += chunk.toString();
        if (body.length > maxSize) {
            tooLarge = true;
            respond(res, 413, { error: 'Payload too large' });
            req.destroy();
        }
    });
    req.on('end', () => {
        if (tooLarge) return;
        try {
            const parsed = JSON.parse(body);
            onSuccess(parsed);
        } catch (err) {
            respond(res, 400, { error: 'JSON inválido: ' + err.message });
        }
    });
}

function checkAuth(req, res) {
    const secret = req.headers['x-magna-secret'];
    if (!secret || secret !== API_SECRET) {
        respond(res, 403, { error: 'Forbidden' });
        console.warn(`[${new Date().toISOString()}] Rejected request — bad secret (${req.url})`);
        return false;
    }
    return true;
}

// ── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

    // CORS preflight
    if (req.method === 'OPTIONS') {
        respond(res, 204, {});
        return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
        respond(res, 200, { status: 'ok', time: new Date().toISOString() });
        return;
    }

    // ── SAVE ARTWORKS ────────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/save-artworks') {
        if (!checkAuth(req, res)) return;

        readJsonBody(req, res, MAX_JSON_SIZE, (parsed) => {
            try {
                if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('Root must be a JSON object');
                }

                makeBackup(ARTWORKS_PATH, 'artworks');

                const tmpPath = ARTWORKS_PATH + '.tmp';
                fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), 'utf8');
                fs.renameSync(tmpPath, ARTWORKS_PATH);

                console.log(`[${new Date().toISOString()}] artworks.json saved — ${Object.keys(parsed).length} artworks`);
                respond(res, 200, { success: true, artworks: Object.keys(parsed).length });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Save error (artworks):`, err.message);
                respond(res, 400, { error: err.message });
            }
        });
        return;
    }

    // ── SAVE EXHIBITIONS ─────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/save-exhibitions') {
        if (!checkAuth(req, res)) return;

        readJsonBody(req, res, MAX_JSON_SIZE, (parsed) => {
            try {
                if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('Root must be a JSON object');
                }

                makeBackup(EXHIBITIONS_PATH, 'exhibitions');

                const tmpPath = EXHIBITIONS_PATH + '.tmp';
                fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), 'utf8');
                fs.renameSync(tmpPath, EXHIBITIONS_PATH);

                console.log(`[${new Date().toISOString()}] exhibitions.json saved — ${Object.keys(parsed).length} exhibitions`);
                respond(res, 200, { success: true, exhibitions: Object.keys(parsed).length });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Save error (exhibitions):`, err.message);
                respond(res, 400, { error: err.message });
            }
        });
        return;
    }

    // ── SAVE COLLECTIONS ─────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/save-collections') {
        if (!checkAuth(req, res)) return;

        readJsonBody(req, res, MAX_JSON_SIZE, (parsed) => {
            try {
                if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('Root must be a JSON object');
                }

                makeBackup(COLLECTIONS_PATH, 'collections');

                const tmpPath = COLLECTIONS_PATH + '.tmp';
                fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), 'utf8');
                fs.renameSync(tmpPath, COLLECTIONS_PATH);

                console.log(`[${new Date().toISOString()}] collections.json saved — ${Object.keys(parsed).length} collections`);
                respond(res, 200, { success: true, collections: Object.keys(parsed).length });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Save error (collections):`, err.message);
                respond(res, 400, { error: err.message });
            }
        });
        return;
    }

    // ── UPLOAD PAINTING IMAGE (full or thumbnail) ───────────────────────────
    if (req.method === 'POST' && req.url === '/upload-painting-image') {
        if (!checkAuth(req, res)) return;

        readJsonBody(req, res, MAX_IMAGE_SIZE * 2, (parsed) => {
            try {
                const { filename, type, imageData, slug } = parsed;

                if (!isValidFilename(filename)) {
                    throw new Error('Nome de ficheiro inválido. Use apenas letras, números, "-", "_" e extensão jpg/jpeg/png/webp.');
                }
                if (type !== 'full' && type !== 'thumbnail') {
                    throw new Error('Campo "type" deve ser "full" ou "thumbnail".');
                }

                const targetDir = (type === 'full') ? PAINTINGS_FULL_DIR : PAINTINGS_THUMBS_DIR;
                if (!fs.existsSync(targetDir)) {
                    throw new Error(`Pasta de destino não existe: ${targetDir}`);
                }

                const destPath = path.join(targetDir, filename);
                const bytes = saveBase64Image(imageData, destPath);

                const relPath = `assets/paintings/${type === 'full' ? 'full' : 'thumbnails'}/${filename}`;
                console.log(`[${new Date().toISOString()}] Painting image saved — ${relPath} (${(bytes/1024).toFixed(0)}KB)`);

                // Auto-copy full-res to downloads/ as <slug>-print.<ext>
                let downloadPath = null;
                if (type === 'full' && slug && isValidSlug(slug)) {
                    if (!fs.existsSync(DOWNLOADS_DIR)) {
                        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
                    }
                    const ext = filename.split('.').pop().toLowerCase();
                    const downloadFilename = `${slug}-print.${ext}`;
                    downloadPath = path.join(DOWNLOADS_DIR, downloadFilename);
                    fs.copyFileSync(destPath, downloadPath);
                    console.log(`[${new Date().toISOString()}] Download copy saved — assets/downloads/${downloadFilename}`);
                }

                respond(res, 200, {
                    success: true,
                    path: relPath,
                    bytes,
                    downloadPath: downloadPath ? `assets/downloads/${slug}-print.${filename.split('.').pop().toLowerCase()}` : null
                });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Upload error (painting):`, err.message);
                respond(res, 400, { error: err.message });
            }
        });
        return;
    }

    // ── UPLOAD EXHIBITION FLYER ──────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/upload-exhibition-flyer') {
        if (!checkAuth(req, res)) return;

        readJsonBody(req, res, MAX_IMAGE_SIZE * 2, (parsed) => {
            try {
                const { filename, imageData } = parsed;

                if (!isValidFilename(filename)) {
                    throw new Error('Nome de ficheiro inválido. Use apenas letras, números, "-", "_" e extensão jpg/jpeg/png/webp.');
                }
                if (!fs.existsSync(EXHIBITION_FLYERS_DIR)) {
                    fs.mkdirSync(EXHIBITION_FLYERS_DIR, { recursive: true });
                }

                const destPath = path.join(EXHIBITION_FLYERS_DIR, filename);
                const bytes = saveBase64Image(imageData, destPath);

                const relPath = `assets/exhibition/flyers/${filename}`;
                console.log(`[${new Date().toISOString()}] Exhibition flyer saved — ${relPath} (${(bytes/1024).toFixed(0)}KB)`);
                respond(res, 200, { success: true, path: relPath, bytes });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Upload error (flyer):`, err.message);
                respond(res, 400, { error: err.message });
            }
        });
        return;
    }

    // ── UPLOAD EXHIBITION GALLERY IMAGE ──────────────────────────────────────
    if (req.method === 'POST' && req.url === '/upload-exhibition-gallery') {
        if (!checkAuth(req, res)) return;

        readJsonBody(req, res, MAX_IMAGE_SIZE * 2, (parsed) => {
            try {
                const { slug, filename, imageData } = parsed;

                if (!isValidSlug(slug)) {
                    throw new Error('Slug inválido. Use apenas letras minúsculas, números e "-".');
                }
                if (!isValidFilename(filename)) {
                    throw new Error('Nome de ficheiro inválido. Use apenas letras, números, "-", "_" e extensão jpg/jpeg/png/webp.');
                }

                const targetDir = path.join(EXHIBITION_GALLERY_DIR, slug);
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                }

                const destPath = path.join(targetDir, filename);
                const bytes = saveBase64Image(imageData, destPath);

                const relPath = `assets/exhibition/img/${slug}/${filename}`;
                console.log(`[${new Date().toISOString()}] Exhibition gallery image saved — ${relPath} (${(bytes/1024).toFixed(0)}KB)`);
                respond(res, 200, { success: true, path: relPath, bytes });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Upload error (gallery):`, err.message);
                respond(res, 400, { error: err.message });
            }
        });
        return;
    }

    // ── LIST ABOUT PHOTOS ────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/about-photos') {
        try {
            if (!fs.existsSync(ABOUT_DIR)) {
                respond(res, 200, { photos: [] });
                return;
            }
            const ALLOWED_EXT = /\.(jpg|jpeg|png|webp)$/i;
            const photos = fs.readdirSync(ABOUT_DIR)
                .filter(f => ALLOWED_EXT.test(f))
                .sort();
            respond(res, 200, { photos });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] Error listing about photos:`, err.message);
            respond(res, 500, { error: err.message });
        }
        return;
    }

    // 404 for everything else
    respond(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
    console.log(`[${new Date().toISOString()}] Magna API listening on ${HOST}:${PORT}`);
    console.log(`  ARTWORKS_PATH:          ${ARTWORKS_PATH}`);
    console.log(`  EXHIBITIONS_PATH:       ${EXHIBITIONS_PATH}`);
    console.log(`  BACKUP_DIR:             ${BACKUP_DIR}`);
    console.log(`  PAINTINGS_FULL_DIR:     ${PAINTINGS_FULL_DIR}`);
    console.log(`  PAINTINGS_THUMBS_DIR:   ${PAINTINGS_THUMBS_DIR}`);
    console.log(`  EXHIBITION_FLYERS_DIR:  ${EXHIBITION_FLYERS_DIR}`);
    console.log(`  EXHIBITION_GALLERY_DIR: ${EXHIBITION_GALLERY_DIR}`);
    if (API_SECRET === 'CHANGE_THIS_SECRET') {
        console.warn('  ⚠  WARNING: Using default secret. Set MAGNA_API_SECRET via ecosystem.config.js before using in production.');
    }
});

process.on('uncaughtException', err => console.error('Uncaught:', err));
process.on('unhandledRejection', err => console.error('Unhandled:', err));