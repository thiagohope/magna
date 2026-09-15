/**
 * Magna API — save-artworks.js
 * Managed by PM2. Listens on 127.0.0.1:3100 (local only, not public).
 *
 * Endpoints:
 *   GET  /health
 *   GET  /verify-secret            (header only)                        -> valida X-Magna-Secret, usado pelo login do Manager
 *   GET  /check-image              ?filename=&type=                     -> { exists: bool }
 *   POST /save-artworks            { ...artworks object... }            -> artworks.json
 *   POST /save-exhibitions         { ...exhibitions object... }         -> exhibitions.json
 *   POST /save-collections         { ...collections object... }         -> collections.json
 *   POST /save-price-tiers         [ ...price tiers array... ]          -> price-tiers.json
 *   POST /update-stripe-price      { updates: [...] }                   -> Stripe (live + test)
 *   POST /upload-painting-image    { filename, type, imageData }        -> assets/paintings/<full|thumbnails>/<filename>
 *   POST /upload-exhibition-flyer  { filename, imageData }              -> assets/exhibition/flyers/<filename>
 *   POST /upload-exhibition-gallery{ slug, filename, imageData }        -> assets/exhibition/img/<slug>/<filename>
 *
 * Nginx proxies /magna/api/* → this server (one location block per endpoint,
 * NOS DOIS vhosts — brainboxmed e magnaleite. Ver secção 8 do manual).
 *
 * Start:  pm2 start ecosystem.config.js
 * Logs:   pm2 logs magna-api
 * Stop:   pm2 stop magna-api
 *
 * IMPORTANTE — MAGNA_API_SECRET é obrigatório (ver mais abaixo): o processo
 * recusa-se a arrancar sem um secret forte definido em ecosystem.config.js.
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const PORT         = 3100;
const HOST         = '127.0.0.1';                          // local only, never public
const ARTWORKS_PATH    = path.join(__dirname, 'artworks.json');
const EXHIBITIONS_PATH = path.join(__dirname, 'exhibitions.json');
const COLLECTIONS_PATH = path.join(__dirname, 'collections.json');
const PRICE_TIERS_PATH = path.join(__dirname, 'price-tiers.json');
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

// ── SECRET — obrigatório, sem fallback inseguro ─────────────────────────────
// Antes, um MAGNA_API_SECRET em falta caía silenciosamente para o valor
// público 'CHANGE_THIS_SECRET' e o servidor arrancava na mesma, só avisando
// na consola do PM2. Isso permitia um deploy mal configurado ficar "a
// funcionar" com uma fechadura cuja chave está escrita no próprio código.
// Agora o processo recusa-se a arrancar nesse cenário.
const API_SECRET = process.env.MAGNA_API_SECRET;
if (!API_SECRET || API_SECRET === 'CHANGE_THIS_SECRET' || API_SECRET.length < 16) {
    console.error('FATAL: MAGNA_API_SECRET não está definido, é o valor de exemplo, ou tem menos de 16 caracteres.');
    console.error('Define um valor forte em ecosystem.config.js (ex.: openssl rand -hex 24), depois: pm2 restart magna-api');
    process.exit(1);
}
const API_SECRET_BUF = Buffer.from(API_SECRET, 'utf8');
// Set secret via ecosystem.config.js (not committed to git):
//   env: { MAGNA_API_SECRET: 'your_strong_secret' }
// Then restart: pm2 restart magna-api
const Stripe = require('stripe');
const stripeLive = process.env.STRIPE_SECRET_KEY_LIVE ? Stripe(process.env.STRIPE_SECRET_KEY_LIVE) : null;
const stripeTest = process.env.STRIPE_SECRET_KEY_TEST ? Stripe(process.env.STRIPE_SECRET_KEY_TEST) : null;

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

// Lista TODOS os Payment Links de um cliente Stripe (live ou test), com paginação.
async function listAllPaymentLinks(stripeClient) {
    let all = [];
    let startingAfter;
    while (true) {
        const page = await stripeClient.paymentLinks.list({ limit: 100, starting_after: startingAfter });
        all = all.concat(page.data);
        if (!page.has_more) break;
        startingAfter = page.data[page.data.length - 1].id;
    }
    return all;
}

// Encontra o Payment Link pelo URL exato e devolve o seu line item (price + product).
async function findPaymentLinkAndPrice(stripeClient, url) {
    const links = await listAllPaymentLinks(stripeClient);
    const link = links.find(l => l.url === url);
    if (!link) throw new Error(`Payment Link não encontrado para URL: ${url}`);

    const lineItems = await stripeClient.paymentLinks.listLineItems(link.id, {
        limit: 1,
        expand: ['data.price.product']
    });
    const item = lineItems.data[0];
    if (!item) throw new Error(`Payment Link ${link.id} não tem line items`);

    return {
        paymentLinkId: link.id,
        lineItemId: item.id,
        oldPriceId: item.price.id,
        productId: item.price.product.id,
        currency: item.price.currency
    };
}

// Cria novo price no mesmo produto, troca-o no Payment Link (URL não muda), arquiva o antigo.
async function swapPaymentLinkPrice(stripeClient, url, newAmountUnits) {
    const { paymentLinkId, lineItemId, oldPriceId, productId, currency } = await findPaymentLinkAndPrice(stripeClient, url);

    const newPrice = await stripeClient.prices.create({
        product: productId,
        unit_amount: Math.round(newAmountUnits * 100),
        currency
    });

    await stripeClient.paymentLinks.update(paymentLinkId, {
        line_items: [{ id: lineItemId, price: newPrice.id }]
    });

    await stripeClient.prices.update(oldPriceId, { active: false });

    return { paymentLinkId, oldPriceId, newPriceId: newPrice.id };
}

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

function respond(req, res, status, body) {
    const origin = req?.headers?.origin;
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin === 'https://magnaleite.com'
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
            respond(req, res, 413, { error: 'Payload too large' });
            req.destroy();
        }
    });
    req.on('end', () => {
        if (tooLarge) return;
        try {
            const parsed = JSON.parse(body);
            onSuccess(parsed);
        } catch (err) {
            respond(req, res, 400, { error: 'JSON inválido: ' + err.message });
        }
    });
}

// Comparação em tempo constante — evita dar a um atacante um sinal de
// temporização sobre quantos caracteres do secret já acertou.
function secretMatches(provided) {
    if (typeof provided !== 'string' || provided.length === 0) return false;
    const providedBuf = Buffer.from(provided, 'utf8');
    if (providedBuf.length !== API_SECRET_BUF.length) return false;
    return crypto.timingSafeEqual(providedBuf, API_SECRET_BUF);
}

function checkAuth(req, res) {
    const secret = req.headers['x-magna-secret'];
    if (!secretMatches(secret)) {
        respond(req, res, 403, { error: 'Forbidden' });
        console.warn(`[${new Date().toISOString()}] Rejected request — bad secret (${req.url})`);
        return false;
    }
    return true;
}

// ── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

    // CORS preflight
    if (req.method === 'OPTIONS') {
        respond(req, res, 204, {});
        return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
        respond(req, res, 200, { status: 'ok', time: new Date().toISOString() });
        return;
    }

    // ── VERIFY SECRET ────────────────────────────────────────────────────────
    // Usado pelo ecrã de login do Manager para validar o MAGNA_API_SECRET
    // introduzido contra o servidor real, em vez de comparar com um hash
    // fixo embutido no HTML. Não lê nem escreve nada — só confirma o header.
    if (req.method === 'GET' && req.url === '/verify-secret') {
        if (!checkAuth(req, res)) return;
        respond(req, res, 200, { valid: true });
        return;
    }

    // ── CHECK IMAGE EXISTS ───────────────────────────────────────────────────
    if (req.method === 'GET' && req.url.startsWith('/check-image')) {
        if (!checkAuth(req, res)) return;
        try {
            const parsedUrl = new URL(req.url, `http://${req.headers.host || HOST}`);
            const filename  = parsedUrl.searchParams.get('filename');
            const type      = parsedUrl.searchParams.get('type');

            if (!isValidFilename(filename)) {
                respond(req, res, 400, { error: 'Nome de ficheiro inválido.' });
                return;
            }
            if (type !== 'full' && type !== 'thumbnail') {
                respond(req, res, 400, { error: 'Parâmetro "type" deve ser "full" ou "thumbnail".' });
                return;
            }

            const targetDir = (type === 'full') ? PAINTINGS_FULL_DIR : PAINTINGS_THUMBS_DIR;
            const exists = fs.existsSync(path.join(targetDir, filename));
            respond(req, res, 200, { exists });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] Erro check-image:`, err.message);
            respond(req, res, 500, { error: err.message });
        }
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
                respond(req, res, 200, { success: true, artworks: Object.keys(parsed).length });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Save error (artworks):`, err.message);
                respond(req, res, 400, { error: err.message });
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
                respond(req, res, 200, { success: true, exhibitions: Object.keys(parsed).length });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Save error (exhibitions):`, err.message);
                respond(req, res, 400, { error: err.message });
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
                respond(req, res, 200, { success: true, collections: Object.keys(parsed).length });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Save error (collections):`, err.message);
                respond(req, res, 400, { error: err.message });
            }
        });
        return;
    }

    // ── SAVE PRICE TIERS ─────────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/save-price-tiers') {
        if (!checkAuth(req, res)) return;

        readJsonBody(req, res, MAX_JSON_SIZE, (parsed) => {
            try {
                if (!Array.isArray(parsed)) {
                    throw new Error('Root must be a JSON array');
                }

                makeBackup(PRICE_TIERS_PATH, 'price-tiers');

                const tmpPath = PRICE_TIERS_PATH + '.tmp';
                fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), 'utf8');
                fs.renameSync(tmpPath, PRICE_TIERS_PATH);

                console.log(`[${new Date().toISOString()}] price-tiers.json saved — ${parsed.length} tiers`);
                respond(req, res, 200, { success: true, tiers: parsed.length });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Save error (price-tiers):`, err.message);
                respond(req, res, 400, { error: err.message });
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

                respond(req, res, 200, {
                    success: true,
                    path: relPath,
                    bytes,
                    downloadPath: downloadPath ? `assets/downloads/${slug}-print.${filename.split('.').pop().toLowerCase()}` : null
                });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Upload error (painting):`, err.message);
                respond(req, res, 400, { error: err.message });
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
                respond(req, res, 200, { success: true, path: relPath, bytes });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Upload error (flyer):`, err.message);
                respond(req, res, 400, { error: err.message });
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
                respond(req, res, 200, { success: true, path: relPath, bytes });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Upload error (gallery):`, err.message);
                respond(req, res, 400, { error: err.message });
            }
        });
        return;
    }

    // ── LIST ABOUT PHOTOS ────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/about-photos') {
        try {
            if (!fs.existsSync(ABOUT_DIR)) {
                respond(req, res, 200, { photos: [] });
                return;
            }
            const ALLOWED_EXT = /\.(jpg|jpeg|png|webp)$/i;
            const photos = fs.readdirSync(ABOUT_DIR)
                .filter(f => ALLOWED_EXT.test(f))
                .sort();
            respond(req, res, 200, { photos });
        } catch (err) {
            console.error(`[${new Date().toISOString()}] Error listing about photos:`, err.message);
            respond(req, res, 500, { error: err.message });
        }
        return;
    }

    // ── UPDATE STRIPE PRICE (live + test) ───────────────────────────────────────
    if (req.method === 'POST' && req.url === '/update-stripe-price') {
        if (!checkAuth(req, res)) return;

        readJsonBody(req, res, MAX_JSON_SIZE, async (parsed) => {
            try {
                const updates = Array.isArray(parsed.updates) ? parsed.updates : null;
                if (!updates || !updates.length) {
                    respond(req, res, 400, { error: 'Corpo deve conter { updates: [...] }' });
                    return;
                }

                const results = [];

                for (const upd of updates) {
                    const { slug, variation, amount, liveUrl, testUrl } = upd;

                    if (typeof amount !== 'number' || amount <= 0) {
                        results.push({ slug, variation, env: 'live', success: false, error: 'amount inválido' });
                        continue;
                    }

                    if (liveUrl) {
                        if (!stripeLive) {
                            results.push({ slug, variation, env: 'live', success: false, error: 'STRIPE_SECRET_KEY_LIVE não configurada' });
                        } else {
                            try {
                                const r = await swapPaymentLinkPrice(stripeLive, liveUrl, amount);
                                results.push({ slug, variation, env: 'live', success: true, ...r });
                            } catch (err) {
                                results.push({ slug, variation, env: 'live', success: false, error: err.message });
                            }
                        }
                    }

                    if (testUrl) {
                        if (!stripeTest) {
                            results.push({ slug, variation, env: 'test', success: false, error: 'STRIPE_SECRET_KEY_TEST não configurada' });
                        } else {
                            try {
                                const r = await swapPaymentLinkPrice(stripeTest, testUrl, amount);
                                results.push({ slug, variation, env: 'test', success: true, ...r });
                            } catch (err) {
                                results.push({ slug, variation, env: 'test', success: false, error: err.message });
                            }
                        }
                    }
                }

                const failed = results.filter(r => !r.success).length;
                console.log(`[${new Date().toISOString()}] update-stripe-price — ${results.length - failed} ok, ${failed} falhas`);
                respond(req, res, 200, { success: failed === 0, results });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Erro update-stripe-price:`, err.message);
                respond(req, res, 500, { error: err.message });
            }
        });
        return;
    }
    
    // 404 for everything else
    respond(req, res, 404, { error: 'Not found' });
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
    console.log('  MAGNA_API_SECRET:       definido e validado (mínimo 16 caracteres) ✓');
});

process.on('uncaughtException', err => console.error('Uncaught:', err));
process.on('unhandledRejection', err => console.error('Unhandled:', err));