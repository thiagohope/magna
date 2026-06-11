/**
 * Magna Save API — save-artworks.js
 * Managed by PM2. Listens on 127.0.0.1:3100 (local only, not public).
 * Receives POST /save-artworks with JSON body, writes to artworks.json.
 * Nginx proxies /magna/api/save-artworks → this server.
 *
 * Start:  pm2 start save-artworks.js --name magna-api
 * Logs:   pm2 logs magna-api
 * Stop:   pm2 stop magna-api
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const PORT         = 3100;
const HOST         = '127.0.0.1';                          // local only, never public
const ARTWORKS_PATH = path.join(__dirname, 'artworks.json');
const BACKUP_DIR   = path.join(__dirname, 'backups');
const API_SECRET   = process.env.MAGNA_API_SECRET || 'CHANGE_THIS_SECRET';
// Set secret on server: export MAGNA_API_SECRET=your_strong_secret
// Then restart: pm2 restart magna-api

// ── HELPERS ─────────────────────────────────────────────────────────────────
function ensureBackupDir() {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function makeBackup() {
    ensureBackupDir();
    if (!fs.existsSync(ARTWORKS_PATH)) return;
    const ts      = new Date().toISOString().replace(/[:.]/g, '-');
    const dest    = path.join(BACKUP_DIR, `artworks-${ts}.json`);
    fs.copyFileSync(ARTWORKS_PATH, dest);

    // Keep only 20 most recent backups
    const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('artworks-') && f.endsWith('.json'))
        .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
    files.slice(20).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f.name)));
}

function respond(res, status, body) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'https://brainboxmed.com',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Magna-Secret'
    });
    res.end(JSON.stringify(body));
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

    // Save endpoint
    if (req.method === 'POST' && req.url === '/save-artworks') {

        // Auth check
        const secret = req.headers['x-magna-secret'];
        if (!secret || secret !== API_SECRET) {
            respond(res, 403, { error: 'Forbidden' });
            console.warn(`[${new Date().toISOString()}] Rejected request — bad secret`);
            return;
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 2 * 1024 * 1024) { // 2MB limit
                respond(res, 413, { error: 'Payload too large' });
                req.destroy();
            }
        });

        req.on('end', () => {
            try {
                // Validate JSON before writing
                const parsed = JSON.parse(body);
                if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('Root must be a JSON object');
                }

                // Backup current file
                makeBackup();

                // Write new file (atomic: write to temp, then rename)
                const tmpPath = ARTWORKS_PATH + '.tmp';
                fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), 'utf8');
                fs.renameSync(tmpPath, ARTWORKS_PATH);

                console.log(`[${new Date().toISOString()}] artworks.json saved — ${Object.keys(parsed).length} artworks`);
                respond(res, 200, { success: true, artworks: Object.keys(parsed).length });

            } catch (err) {
                console.error(`[${new Date().toISOString()}] Save error:`, err.message);
                respond(res, 400, { error: err.message });
            }
        });

        return;
    }

    // 404 for everything else
    respond(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
    console.log(`[${new Date().toISOString()}] Magna API listening on ${HOST}:${PORT}`);
    console.log(`  ARTWORKS_PATH: ${ARTWORKS_PATH}`);
    console.log(`  BACKUP_DIR:    ${BACKUP_DIR}`);
    if (API_SECRET === 'CHANGE_THIS_SECRET') {
        console.warn('  ⚠  WARNING: Using default secret. Set MAGNA_API_SECRET env var before using in production.');
    }
});

process.on('uncaughtException', err => console.error('Uncaught:', err));
process.on('unhandledRejection', err => console.error('Unhandled:', err));