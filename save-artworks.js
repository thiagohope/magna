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
 *   GET  /check-payment-links      (header only, sem body)              -> diagnóstico: links mortos/inativos
 *   GET  /suggest-payment-link-fixes (header only, sem body)            -> sugere correções, NÃO escreve nada
 *   POST /apply-payment-link-fixes { fixes: [...] }                     -> aplica correções revistas, com verificação e backup
 *   GET  /check-download-redirects (header only)                        -> diagnóstico: redirects pós-pagamento do tier digital
 *   POST /apply-download-redirects { fixes: [...] }                     -> configura o after_completion.redirect dos Payment Links digitais
 *   POST /upload-painting-image    { filename, type, imageData }        -> assets/paintings/<full|thumbnails>/<filename>
 *        (a full-res upload also produces a resized + watermarked assets/downloads/<slug>-print.jpg)
 *   GET  /verify-download        ?art=&session_id=                    -> confirma compra paga na Stripe, devolve token assinado (público)
 *   GET  /download-file          ?token=                               -> entrega o ficheiro assets/downloads/<slug>-print.jpg (público, token obrigatório)
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
const { processDownloadImage } = require('./watermark-lib');

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

// ── DOWNLOAD TOKEN — assina/valida os links de /download-file ──────────────
// Usa um secret dedicado se existir (DOWNLOAD_TOKEN_SECRET em ecosystem.config.js);
// cai para o MAGNA_API_SECRET como fallback para não bloquear o deploy inicial.
// Recomendado definir DOWNLOAD_TOKEN_SECRET próprio mais tarde.
const DOWNLOAD_TOKEN_SECRET = process.env.DOWNLOAD_TOKEN_SECRET || API_SECRET;
const DOWNLOAD_TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48h para baixar após a compra

function signDownloadToken(payload) {
    const json = JSON.stringify(payload);
    const b64 = Buffer.from(json, 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', DOWNLOAD_TOKEN_SECRET).update(b64).digest('base64url');
    return `${b64}.${sig}`;
}

function verifyDownloadToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', DOWNLOAD_TOKEN_SECRET).update(b64).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    let payload;
    try {
        payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    } catch (e) {
        return null;
    }
    if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
}
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

// ── LOCK por slug para /update-stripe-price ─────────────────────────────────
// Evita que dois pedidos concorrentes (duplo clique, retry depois de um
// "Failed to fetch", ou um pedido a chegar mesmo à volta de um `pm2 restart`)
// processem a MESMA obra ao mesmo tempo. Sem isto, um 2º pedido pode resolver
// o Payment Link "antigo" que o 1º pedido acabou de desativar — antes de o
// artworks.json ter sido atualizado com o novo URL — e criar um Price novo a
// mais, sem nunca corrigir o default (foi exatamente isto que aconteceu com
// "Tempo" em 17/09). Ver diagnóstico completo no histórico do projeto.
const busySlugs = new Set();

// Mapeia a variação de preço para o campo correspondente em artworks.json —
// tem de ficar em sync com FIELD_BY_VARIATION no admin/magna-manager-x9z2-safe.html
const FIELD_BY_VARIATION = {
    original:       'priceOriginal',
    printGallery:   'pricePrintGallery',
    printCollector: 'pricePrintCollector',
    digital:        'priceDigital'
};

// Depois de um swap bem-sucedido no Stripe, grava o(s) novo(s) URL(s) de
// Payment Link diretamente no artworks.json em disco — sem depender de um
// 2º pedido HTTP separado vindo do browser (o Manager também faz esse 2º
// pedido, por segurança/redundância, mas já não é a ÚNICA forma de os novos
// URLs ficarem persistidos). Lê sempre uma cópia fresca do ficheiro em disco
// para não pisar alterações concorrentes de outro pedido.
function persistStripeUrlUpdates(results) {
    const successesWithUrl = results.filter(r => r.success && r.newUrl);
    if (!successesWithUrl.length) return;

    try {
        const raw = fs.readFileSync(ARTWORKS_PATH, 'utf8');
        const artworksOnDisk = JSON.parse(raw);
        let changed = false;

        successesWithUrl.forEach(r => {
            const field = FIELD_BY_VARIATION[r.variation];
            const art = artworksOnDisk[r.slug];
            if (field && art && art[field]) {
                art[field][r.env] = r.newUrl;
                changed = true;
            }
        });

        if (changed) {
            makeBackup(ARTWORKS_PATH, 'artworks');
            const tmpPath = ARTWORKS_PATH + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(artworksOnDisk, null, 2), 'utf8');
            fs.renameSync(tmpPath, ARTWORKS_PATH);
            console.log(`[${new Date().toISOString()}] artworks.json atualizado automaticamente após update-stripe-price — ${successesWithUrl.length} URL(s)`);
        }
    } catch (err) {
        // Os swaps no Stripe já aconteceram — não falhamos o pedido por causa
        // disto. O frontend recebe os newUrl nos results e tenta gravá-los
        // por si (POST /save-artworks), como já fazia antes.
        console.error(`[${new Date().toISOString()}] AVISO: falha ao persistir novos URLs no artworks.json após swap Stripe bem-sucedido:`, err.message);
    }
}

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

// Lista TODOS os Products de um cliente Stripe (live ou test), com paginação.
// Usado como último recurso, quando o Payment Link antigo em si já não pode
// ser lido (ex.: "coraldueto"/"barcos" — a Stripe devolve erro ao tentar
// listar os line items desse link específico) e por isso não há forma de
// descobrir o productId a partir dele. Nesse caso, tentamos encontrar o
// Product pelo NOME (Products na Magna são criados com o título da obra).
async function listAllProducts(stripeClient) {
    let all = [];
    let startingAfter;
    while (true) {
        const page = await stripeClient.products.list({ limit: 100, starting_after: startingAfter });
        all = all.concat(page.data);
        if (!page.has_more) break;
        startingAfter = page.data[page.data.length - 1].id;
    }
    return all;
}

// Normaliza um nome para comparação tolerante (minúsculas, sem acentos, sem
// espaços/pontuação a mais) — títulos de obras podem ter sido escritos de
// formas ligeiramente diferentes no artworks.json vs. no nome do Product.
function normalizeTitleForMatch(str) {
    return (str || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

// Tenta encontrar o Product certo pelo título da obra (artworks[slug].title)
// quando o link antigo não pôde ser lido. Aceita nome EXATO (normalizado) ou,
// na falta desse, um único Product cujo nome CONTENHA o título — nunca
// escolhe entre vários candidatos por adivinhação.
function findProductByTitle(allProducts, title) {
    const target = normalizeTitleForMatch(title);
    if (!target) return { product: null, reason: 'Obra sem título em artworks.json — impossível procurar por nome.' };

    const exact = allProducts.filter(p => normalizeTitleForMatch(p.name) === target);
    if (exact.length === 1) return { product: exact[0], reason: null };
    if (exact.length > 1) return { product: null, reason: `${exact.length} Products no Stripe têm exatamente o nome "${title}" — ambíguo, precisa de decisão manual.` };

    const partial = allProducts.filter(p => normalizeTitleForMatch(p.name).includes(target) || target.includes(normalizeTitleForMatch(p.name)));
    if (partial.length === 1) return { product: partial[0], reason: null };
    if (partial.length > 1) return { product: null, reason: `${partial.length} Products no Stripe têm nome parecido com "${title}" — ambíguo, precisa de decisão manual.` };

    return { product: null, reason: `Nenhum Product no Stripe com nome igual ou parecido com "${title}".` };
}

// Lê o line item (price + product, com nickname) de UM Payment Link já
// conhecido (objeto devolvido por listAllPaymentLinks). Usado pela sugestão
// de correção de links mortos — devolve null se o link não tiver line items
// (não deveria acontecer, mas não pode rebentar o diagnóstico todo por causa
// de um caso estranho).
async function getLinkPriceInfo(stripeClient, link) {
    try {
        const lineItems = await stripeClient.paymentLinks.listLineItems(link.id, {
            limit: 1,
            expand: ['data.price.product']
        });
        const item = lineItems.data[0];
        if (!item) return null;
        const price = item.price;
        const product = price.product;
        const productId = typeof product === 'string' ? product : product.id;
        return { productId, priceId: price.id, nickname: price.nickname || '', url: link.url, active: link.active, unitAmount: price.unit_amount, created: price.created };
    } catch (err) {
        return null;
    }
}

// Corre um array de tarefas assíncronas com um limite de concorrência — evita
// disparar centenas de pedidos ao Stripe todos de uma vez (rate limit) mas
// sem ficar tudo em série, um a um.
async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function runNext() {
        while (next < items.length) {
            const i = next++;
            results[i] = await worker(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
    return results;
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

    const oldPrice = item.price;
    const product  = oldPrice.product; // expandido acima

    // default_price no objeto product vem só como string (o id) a menos que
    // seja explicitamente expandido — cobre os dois casos.
    const productDefaultPriceId = typeof product.default_price === 'string'
        ? product.default_price
        : (product.default_price ? product.default_price.id : null);

    return {
        paymentLinkId: link.id,
        lineItemId: item.id,
        oldPriceId: oldPrice.id,
        oldPriceNickname: oldPrice.nickname || null,
        oldPriceMetadata: oldPrice.metadata || null,
        oldPriceTaxBehavior: (oldPrice.tax_behavior && oldPrice.tax_behavior !== 'unspecified') ? oldPrice.tax_behavior : null,
        productId: product.id,
        productDefaultPriceId,
        currency: oldPrice.currency,
        quantity: item.quantity || 1
    };
}

// Cria um novo Price + um novo Payment Link (a Stripe API não permite trocar
// o price de um Payment Link existente nem alterar o valor de um Price já
// criado — ver manual, secção Stripe), desativa o Payment Link antigo e
// tenta arquivar o Price antigo.
//
// O novo Price herda do antigo o nickname (aparece como "Description" na
// lista de Prices do Dashboard), o tax_behavior e o metadata — sem isto, a
// troca "esquecia" a descrição/características do price antigo (ex.:
// "Original", "Print Fine Art | Limited Edition...") e o novo ficava sem
// nenhuma. Só o valor (unit_amount) deve mudar.
//
// IMPORTANTE: se o Price antigo for o "default price" do Product, a Stripe
// recusa-se a arquivá-lo ("This price cannot be archived because it is the
// default price of its product."). Isso NÃO pode abortar a troca: a essa
// altura o novo Price e o novo Payment Link já existem e o antigo já foi
// desativado — se deixássemos a exceção propagar, o servidor devolvia
// "falhou" sem nunca reportar o novo URL, o site ficava a apontar para o
// link antigo (agora desativado) e ninguém conseguia comprar. Por isso:
// 1) só reatribuímos o default price do Product quando o Price antigo era
//    de facto o default (nunca incondicionalmente — um Product da Magna
//    tem várias variações de preço, "original"/"print gallery"/"print
//    collector"/"digital", todas no MESMO Product; reatribuir o default a
//    cada troca, mesmo quando a variação trocada não era a default,
//    corrompia silenciosamente qual price aparece como principal no
//    Dashboard), e
// 2) mesmo que o arquivamento do Price antigo falhe por outro motivo
//    qualquer, isso é tratado como aviso (fica órfão e inativo no
//    Dashboard, sem efeito no checkout) e não impede o sucesso da troca.
async function swapPaymentLinkPrice(stripeClient, url, newAmountUnits) {
    const {
        paymentLinkId: oldPaymentLinkId,
        oldPriceId,
        oldPriceNickname,
        oldPriceMetadata,
        oldPriceTaxBehavior,
        productId,
        productDefaultPriceId,
        currency,
        quantity
    } = await findPaymentLinkAndPrice(stripeClient, url);

    const newPriceParams = {
        product: productId,
        unit_amount: Math.round(newAmountUnits * 100),
        currency
    };
    if (oldPriceNickname)   newPriceParams.nickname     = oldPriceNickname;
    if (oldPriceTaxBehavior) newPriceParams.tax_behavior = oldPriceTaxBehavior;
    if (oldPriceMetadata && Object.keys(oldPriceMetadata).length) newPriceParams.metadata = oldPriceMetadata;

    const newPrice = await stripeClient.prices.create(newPriceParams);

    const newLink = await stripeClient.paymentLinks.create({
        line_items: [{ price: newPrice.id, quantity }]
    });

    await stripeClient.paymentLinks.update(oldPaymentLinkId, {
        active: false,
        inactive_message: 'Este link deixou de estar ativo — o preço foi atualizado. Visita magnaleite.com para o preço e link atuais.'
    });

    const wasDefault = productDefaultPriceId === oldPriceId;
    let oldPriceArchived = false;
    let archiveWarning = null;
    try {
        // Só toca no default price do Product se o price trocado era de
        // facto o default — nunca para as outras variações.
        if (wasDefault) {
            await stripeClient.products.update(productId, { default_price: newPrice.id });
        }
        await stripeClient.prices.update(oldPriceId, { active: false });
        oldPriceArchived = true;
    } catch (err) {
        archiveWarning = err.message;
        console.warn(`[${new Date().toISOString()}] Aviso: não foi possível arquivar o Price antigo ${oldPriceId} (fica inativo/órfão no Dashboard, sem efeito no checkout): ${err.message}`);
    }

    return {
        oldPaymentLinkId,
        newPaymentLinkId: newLink.id,
        newUrl: newLink.url,
        oldPriceId,
        newPriceId: newPrice.id,
        oldPriceArchived,
        archiveWarning
    };
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

    // ── VERIFY DOWNLOAD (público, chamado pelo browser do comprador — sem X-Magna-Secret) ──
    // Confirma junto da Stripe que a session_id devolvida no redirect após
    // pagamento corresponde a uma compra PAGA do tier "digital" desta obra
    // (client_reference_id = "<slug>__digital", ver artwork.html). Só então
    // devolve um token assinado e de curta validade para /download-file.
    if (req.method === 'GET' && req.url.startsWith('/verify-download')) {
        (async () => {
            try {
                const parsedUrl = new URL(req.url, `http://${req.headers.host || HOST}`);
                const slug = parsedUrl.searchParams.get('art');
                const sessionId = parsedUrl.searchParams.get('session_id');

                if (!slug || !isValidSlug(slug) || !sessionId) {
                    respond(req, res, 400, { error: 'Parâmetros em falta ou inválidos.' });
                    return;
                }

                const isTestSession = sessionId.startsWith('cs_test_');
                const stripeClient = isTestSession ? stripeTest : stripeLive;
                if (!stripeClient) {
                    respond(req, res, 500, { error: 'Stripe não configurada para este ambiente.' });
                    return;
                }

                let session;
                try {
                    session = await stripeClient.checkout.sessions.retrieve(sessionId);
                } catch (stripeErr) {
                    console.warn(`[${new Date().toISOString()}] verify-download — session inválida: ${stripeErr.message}`);
                    respond(req, res, 403, { error: 'Sessão de pagamento não encontrada.' });
                    return;
                }

                if (session.payment_status !== 'paid') {
                    respond(req, res, 403, { error: 'Pagamento não confirmado.' });
                    return;
                }

                const expectedRef = `${slug}__digital`;
                if (session.client_reference_id !== expectedRef) {
                    console.warn(`[${new Date().toISOString()}] verify-download — client_reference_id não corresponde (esperado ${expectedRef}, recebido ${session.client_reference_id})`);
                    respond(req, res, 403, { error: 'Esta compra não corresponde a esta obra.' });
                    return;
                }

                const downloadFilename = `${slug}-print.jpg`;
                const downloadPath = path.join(DOWNLOADS_DIR, downloadFilename);
                if (!fs.existsSync(downloadPath)) {
                    respond(req, res, 404, { error: 'Ficheiro de download ainda não disponível para esta obra. Contacte o suporte.' });
                    return;
                }

                const exp = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
                const token = signDownloadToken({ slug, exp });

                console.log(`[${new Date().toISOString()}] Download verificado e liberado — slug=${slug} session=${sessionId}`);
                respond(req, res, 200, { success: true, token, filename: downloadFilename, expiresAt: exp });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Erro verify-download:`, err.message);
                respond(req, res, 400, { error: 'Não foi possível verificar esta compra.' });
            }
        })();
        return;
    }

    // ── DOWNLOAD FILE (público, exige token assinado válido de /verify-download) ──
    // assets/downloads/ deixa de ser servido estaticamente pelo Nginx — este é
    // o único caminho para obter o ficheiro (ver secção 8 do manual / Nginx).
    if (req.method === 'GET' && req.url.startsWith('/download-file')) {
        try {
            const parsedUrl = new URL(req.url, `http://${req.headers.host || HOST}`);
            const token = parsedUrl.searchParams.get('token');
            const payload = token ? verifyDownloadToken(token) : null;

            if (!payload || !isValidSlug(payload.slug)) {
                respond(req, res, 403, { error: 'Link de download inválido ou expirado. Volte à página da obra e conclua a compra novamente se necessário.' });
                return;
            }

            const downloadFilename = `${payload.slug}-print.jpg`;
            const downloadPath = path.join(DOWNLOADS_DIR, downloadFilename);
            if (!fs.existsSync(downloadPath)) {
                respond(req, res, 404, { error: 'Ficheiro não encontrado.' });
                return;
            }

            console.log(`[${new Date().toISOString()}] Download entregue — ${downloadFilename}`);
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Disposition': `attachment; filename="${downloadFilename}"`,
                'Cache-Control': 'no-store',
            });
            fs.createReadStream(downloadPath).pipe(res);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] Erro download-file:`, err.message);
            respond(req, res, 400, { error: 'Erro ao entregar o ficheiro.' });
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

        readJsonBody(req, res, MAX_IMAGE_SIZE * 2, async (parsed) => {
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

                // Auto-copy full-res to downloads/ as <slug>-print.jpg — resized to
                // MAX_DIMENSION and watermarked (proteção contra impressão em alta
                // qualidade), nunca uma cópia 1:1 do original. Ver watermark-lib.js.
                let downloadPath = null;
                if (type === 'full' && slug && isValidSlug(slug)) {
                    if (!fs.existsSync(DOWNLOADS_DIR)) {
                        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
                    }
                    const downloadFilename = `${slug}-print.jpg`;
                    downloadPath = path.join(DOWNLOADS_DIR, downloadFilename);
                    await processDownloadImage(destPath, downloadPath);
                    console.log(`[${new Date().toISOString()}] Download copy saved (resized + watermarked) — assets/downloads/${downloadFilename}`);

                    // Limpa cópias antigas com outra extensão do mesmo slug, para não
                    // deixar um ficheiro sem watermark/sem resize órfão no servidor.
                    for (const staleExt of ['jpeg', 'png', 'webp', 'JPG', 'JPEG', 'PNG', 'WEBP']) {
                        const stalePath = path.join(DOWNLOADS_DIR, `${slug}-print.${staleExt}`);
                        if (stalePath !== downloadPath && fs.existsSync(stalePath)) {
                            fs.unlinkSync(stalePath);
                            console.log(`[${new Date().toISOString()}] Cópia antiga removida — assets/downloads/${slug}-print.${staleExt}`);
                        }
                    }
                }

                respond(req, res, 200, {
                    success: true,
                    path: relPath,
                    bytes,
                    downloadPath: downloadPath ? `assets/downloads/${slug}-print.jpg` : null
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

    // ── CHECK PAYMENT LINKS (diagnóstico, só leitura) ────────────────────────
    // Varre o artworks.json inteiro e confirma, obra a obra e variação a
    // variação, se o URL do Payment Link guardado (live e test) ainda existe
    // e está ativo no Stripe. Não altera nada — só reporta. Serve para saber
    // em segundos quais obras ficaram com um link morto depois de qualquer
    // confusão nos swaps de preço, em vez de vasculhar o Dashboard obra a
    // obra. Preços/Payment Links "a mais" (duplicados, já inativos) NÃO
    // aparecem aqui como problema — só o que está realmente referenciado no
    // artworks.json é que importa para o checkout funcionar.
    if (req.method === 'GET' && req.url === '/check-payment-links') {
        if (!checkAuth(req, res)) return;
        (async () => {
            try {
                const raw = fs.readFileSync(ARTWORKS_PATH, 'utf8');
                const artworks = JSON.parse(raw);

                const [liveLinks, testLinks] = await Promise.all([
                    stripeLive ? listAllPaymentLinks(stripeLive) : Promise.resolve([]),
                    stripeTest ? listAllPaymentLinks(stripeTest) : Promise.resolve([])
                ]);
                const liveByUrl = new Map(liveLinks.map(l => [l.url, l]));
                const testByUrl = new Map(testLinks.map(l => [l.url, l]));

                const problems = [];
                let checkedLinks = 0;

                Object.entries(artworks).forEach(([slug, art]) => {
                    Object.entries(FIELD_BY_VARIATION).forEach(([variation, field]) => {
                        const links = art[field];
                        if (!links) return;
                        ['live', 'test'].forEach(env => {
                            const url = links[env];
                            if (!url) return;
                            checkedLinks++;
                            const map = env === 'live' ? liveByUrl : testByUrl;
                            const link = map.get(url);
                            if (!link) {
                                problems.push({ slug, variation, env, url, issue: 'URL não encontrado no Stripe (link nunca existiu ou foi apagado)' });
                            } else if (!link.active) {
                                problems.push({ slug, variation, env, url, issue: 'Payment Link INATIVO — checkout desta variação está morto' });
                            }
                        });
                    });
                });

                respond(req, res, 200, {
                    artworksChecked: Object.keys(artworks).length,
                    linksChecked: checkedLinks,
                    problemsFound: problems.length,
                    problems
                });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Erro check-payment-links:`, err.message);
                respond(req, res, 500, { error: err.message });
            }
        })();
        return;
    }

    // ── SUGGEST PAYMENT LINK FIXES (diagnóstico, só leitura, NÃO escreve nada) ─
    // Para cada link marcado como problema por /check-payment-links, tenta
    // encontrar o Payment Link ATIVO correto — do MESMO Product e da MESMA
    // variação (por nickname: "Original", "...Gallery...", "...Collector...",
    // "Digital Download") — e devolve isso como SUGESTÃO. Nunca escreve no
    // artworks.json. Dado o volume de duplicados acumulados nesta conta, se
    // houver mais do que uma Price ativa plausível para a mesma variação,
    // marca como "ambíguo" em vez de adivinhar — corrigir automaticamente o
    // link errado pode fazer um cliente pagar o valor errado ou comprar a
    // obra errada, o que nunca vale a pena arriscar.
    if (req.method === 'GET' && req.url === '/suggest-payment-link-fixes') {
        if (!checkAuth(req, res)) return;
        (async () => {
            try {
                const raw = fs.readFileSync(ARTWORKS_PATH, 'utf8');
                const artworks = JSON.parse(raw);

                const NICKNAME_HINT = {
                    original:       /original/i,
                    printGallery:   /gallery/i,
                    printCollector: /collector/i,
                    digital:        /digital/i
                };

                async function processEnv(stripeClient, env) {
                    if (!stripeClient) return { suggestions: [], unresolved: [] };

                    const allLinks = await listAllPaymentLinks(stripeClient);
                    const activeLinks = allLinks.filter(l => l.active);

                    // Recolhe info (productId, nickname) de todos os links ativos —
                    // é este universo que serve de "candidatos a correção".
                    const activeInfos = (await runWithConcurrency(activeLinks, 8, l => getLinkPriceInfo(stripeClient, l)))
                        .filter(Boolean);
                    const activeByProduct = new Map();
                    activeInfos.forEach(info => {
                        if (!activeByProduct.has(info.productId)) activeByProduct.set(info.productId, []);
                        activeByProduct.get(info.productId).push(info);
                    });

                    // Para cada entrada problemática desta env, resolve o link
                    // antigo (mesmo inativo) só para saber a que Product pertencia.
                    const brokenEntries = [];
                    Object.entries(artworks).forEach(([slug, art]) => {
                        Object.entries(FIELD_BY_VARIATION).forEach(([variation, field]) => {
                            const links = art[field];
                            if (!links || !links[env]) return;
                            brokenEntries.push({ slug, variation, oldUrl: links[env] });
                        });
                    });

                    const oldLinkByUrl = new Map(allLinks.map(l => [l.url, l]));
                    const suggestions = [];
                    const unresolved = [];

                    // Lista de Products só é buscada se e quando for mesmo precisa
                    // (fallback abaixo) — evita uma chamada extra à Stripe sempre
                    // que todos os links antigos são legíveis normalmente.
                    let allProductsCache = null;
                    async function getAllProductsCached() {
                        if (!allProductsCache) allProductsCache = await listAllProducts(stripeClient);
                        return allProductsCache;
                    }

                    await runWithConcurrency(brokenEntries, 8, async (entry) => {
                        const oldLink = oldLinkByUrl.get(entry.oldUrl);
                        if (!oldLink || oldLink.active) return; // não é um problema — já está ativo

                        let oldInfo = await getLinkPriceInfo(stripeClient, oldLink);
                        let resolvedByTitle = false;

                        if (!oldInfo) {
                            // Fallback: o link antigo em si não pôde ser lido (aconteceu
                            // com "coraldueto" e "barcos"/printCollector) — tenta achar
                            // o Product certo pelo TÍTULO da obra em vez de desistir.
                            const title = artworks[entry.slug]?.title;
                            const allProducts = await getAllProductsCached();
                            const { product, reason } = findProductByTitle(allProducts, title);
                            if (!product) {
                                unresolved.push({ ...entry, env, reason: `Não foi possível ler o Payment Link antigo (produto desconhecido), e a busca por título falhou: ${reason}` });
                                return;
                            }
                            oldInfo = { productId: product.id };
                            resolvedByTitle = true;
                        }

                        let candidates = (activeByProduct.get(oldInfo.productId) || [])
                            .filter(c => NICKNAME_HINT[entry.variation].test(c.nickname));

                        // Desempate por preço: se houver mais do que uma Price ativa
                        // com o nickname certo (comum aqui — arquivamentos que
                        // falharam silenciosamente ao longo de meses deixaram várias
                        // "ativas" em simultâneo), usa o valor que o próprio
                        // artworks.json diz que É o preço atual desta variação
                        // (priceDisplay, em euros) para escolher a Price certa por
                        // valor em cêntimos — nunca por ordem/data, que não é fiável.
                        let priceMatchedTiebreak = false;
                        let duplicateSameAmountTiebreak = false;
                        const expectedEuros = artworks[entry.slug]?.priceDisplay?.[entry.variation];

                        if (candidates.length > 1 && typeof expectedEuros === 'number') {
                            const expectedCents = Math.round(expectedEuros * 100);
                            const byPrice = candidates.filter(c => c.unitAmount === expectedCents);
                            // >= 1 (não só === 1): mesmo quando batem VÁRIAS candidatas
                            // com o preço esperado — o que é comum aqui, há Prices
                            // duplicadas com o valor certo por trás — já vale a pena
                            // descartar as que têm um valor claramente errado, e deixar
                            // o desempate por "mesmo valor → mais recente" a seguir
                            // resolver entre as que sobraram (todas com o preço certo).
                            if (byPrice.length >= 1) {
                                candidates = byPrice;
                                priceMatchedTiebreak = true;
                            }
                        }

                        // Ainda há mais do que uma candidata (ou porque nenhuma bateu
                        // com o priceDisplay, ou porque bateram várias ao mesmo
                        // tempo — duas Prices "iguais" ativas em simultâneo, o que
                        // aconteceu bastante nesta conta por causa dos arquivamentos
                        // que falharam silenciosamente ao longo de meses). Se todas
                        // as que sobram tiverem exatamente o MESMO valor entre si,
                        // não há ambiguidade real quanto ao que o cliente paga — só
                        // sujidade de duplicados por trás — então escolhe-se a mais
                        // recente, e assinala-se isso claramente para revisão do
                        // Dashboard (não é o mesmo que "confirmado pelo preço").
                        if (candidates.length > 1) {
                            const amounts = new Set(candidates.map(c => c.unitAmount));
                            if (amounts.size === 1) {
                                candidates = [...candidates].sort((a, b) => (b.created || 0) - (a.created || 0)).slice(0, 1);
                                duplicateSameAmountTiebreak = true;
                            }
                        }

                        if (candidates.length === 1) {
                            suggestions.push({
                                slug: entry.slug,
                                variation: entry.variation,
                                env,
                                oldUrl: entry.oldUrl,
                                suggestedUrl: candidates[0].url,
                                suggestedNickname: candidates[0].nickname,
                                confirmadoPeloPreco: priceMatchedTiebreak,
                                duplicadoMesmoValorEscolhidoPelaMaisRecente: duplicateSameAmountTiebreak,
                                productEncontradoPeloTitulo: resolvedByTitle,
                                priceDisplayNaoBateuCerto: duplicateSameAmountTiebreak && !priceMatchedTiebreak
                                    ? { expectedEuros: expectedEuros ?? null, valorEscolhidoCents: candidates[0].unitAmount }
                                    : undefined
                            });
                        } else if (candidates.length === 0) {
                            unresolved.push({ ...entry, env, reason: `Nenhuma Price ativa encontrada no Product ${oldInfo.productId}${resolvedByTitle ? ' (encontrado pelo título)' : ''} com nickname compatível com "${entry.variation}"` });
                        } else {
                            unresolved.push({
                                ...entry, env,
                                reason: `AMBÍGUO DE VERDADE — ${candidates.length} Prices ativas no Product ${oldInfo.productId} para "${entry.variation}", com VALORES DIFERENTES entre si, e nenhuma bate com o priceDisplay guardado — precisa de decisão manual`,
                                expectedEuros: expectedEuros ?? null,
                                candidates: candidates.map(c => ({ url: c.url, nickname: c.nickname, priceId: c.priceId, unitAmountCents: c.unitAmount }))
                            });
                        }
                    });

                    return { suggestions, unresolved };
                }

                const [liveResult, testResult] = await Promise.all([
                    processEnv(stripeLive, 'live'),
                    processEnv(stripeTest, 'test')
                ]);

                respond(req, res, 200, {
                    suggestions: [...liveResult.suggestions, ...testResult.suggestions],
                    unresolved: [...liveResult.unresolved, ...testResult.unresolved],
                    note: 'Isto é só uma SUGESTÃO — nada foi escrito no artworks.json. Reveja antes de aplicar.'
                });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Erro suggest-payment-link-fixes:`, err.message);
                respond(req, res, 500, { error: err.message });
            }
        })();
        return;
    }

    // ── APPLY PAYMENT LINK FIXES (escreve — mas só depois de revisão humana) ──
    // Recebe um array `fixes` no mesmo formato dos itens de `suggestions`
    // devolvidos por /suggest-payment-link-fixes: { slug, variation, env,
    // oldUrl, suggestedUrl }. NÃO confia cegamente no `oldUrl` recebido: antes
    // de escrever, relê o artworks.json do disco e confirma que o valor
    // atualmente guardado em [slug][field][env] é EXATAMENTE igual ao oldUrl
    // da sugestão. Isto evita:
    //   1) aplicar uma sugestão "stale" se algo mudou entre o diagnóstico e a
    //      aplicação (ex.: outra troca de preço no meio, ou já ter sido
    //      corrigido manualmente);
    //   2) aplicar a mesma sugestão duas vezes sem dar por isso.
    // Se o valor em disco não bater certo, a entrada fica em `skipped` com o
    // motivo — nunca sobrescreve às cegas. Um só backup é feito antes da
    // escrita (se houver pelo menos uma alteração real a aplicar).
    if (req.method === 'POST' && req.url === '/apply-payment-link-fixes') {
        if (!checkAuth(req, res)) return;

        readJsonBody(req, res, MAX_JSON_SIZE, (parsed) => {
            try {
                const fixes = Array.isArray(parsed.fixes) ? parsed.fixes : null;
                if (!fixes || !fixes.length) {
                    respond(req, res, 400, { error: 'Corpo deve conter { fixes: [...] }' });
                    return;
                }

                const raw = fs.readFileSync(ARTWORKS_PATH, 'utf8');
                const artworksOnDisk = JSON.parse(raw);

                const applied = [];
                const skipped = [];

                fixes.forEach(fix => {
                    const { slug, variation, env, oldUrl, suggestedUrl } = fix || {};
                    const field = FIELD_BY_VARIATION[variation];

                    if (!slug || !field || (env !== 'live' && env !== 'test') || !oldUrl || !suggestedUrl) {
                        skipped.push({ ...fix, reason: 'Entrada incompleta ou inválida (slug/variation/env/oldUrl/suggestedUrl em falta).' });
                        return;
                    }

                    const art = artworksOnDisk[slug];
                    if (!art || !art[field]) {
                        skipped.push({ ...fix, reason: `Obra ou campo "${field}" não encontrado em artworks.json.` });
                        return;
                    }

                    const currentUrl = art[field][env];
                    if (currentUrl !== oldUrl) {
                        skipped.push({ ...fix, reason: `URL atual em disco não corresponde ao oldUrl esperado (já foi alterado entretanto). Atual: ${currentUrl || '(vazio)'}` });
                        return;
                    }

                    art[field][env] = suggestedUrl;
                    applied.push({ slug, variation, env, oldUrl, newUrl: suggestedUrl });
                });

                if (applied.length) {
                    makeBackup(ARTWORKS_PATH, 'artworks');
                    const tmpPath = ARTWORKS_PATH + '.tmp';
                    fs.writeFileSync(tmpPath, JSON.stringify(artworksOnDisk, null, 2), 'utf8');
                    fs.renameSync(tmpPath, ARTWORKS_PATH);
                }

                console.log(`[${new Date().toISOString()}] apply-payment-link-fixes — ${applied.length} aplicadas, ${skipped.length} ignoradas`);
                respond(req, res, 200, { success: true, appliedCount: applied.length, skippedCount: skipped.length, applied, skipped });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Erro apply-payment-link-fixes:`, err.message);
                respond(req, res, 500, { error: err.message });
            }
        });
        return;
    }

    // ── CHECK DOWNLOAD REDIRECTS (diagnóstico, não escreve nada) ────────────
    // Confirma se os Payment Links do tier "digital" de cada obra já
    // redirecionam, após o pagamento, para download-page.html com o slug
    // certo + {CHECKOUT_SESSION_ID} — pré-requisito do sistema de download
    // verificado (ver /verify-download e /download-file). Sem isso, o
    // redirect padrão da Stripe não leva o comprador a lugar nenhum útil.
    if (req.method === 'GET' && req.url === '/check-download-redirects') {
        if (!checkAuth(req, res)) return;
        (async () => {
            try {
                const raw = fs.readFileSync(ARTWORKS_PATH, 'utf8');
                const artworks = JSON.parse(raw);

                const results = [];
                for (const env of ['live', 'test']) {
                    const stripeClient = env === 'live' ? stripeLive : stripeTest;
                    if (!stripeClient) continue;
                    const allLinks = await listAllPaymentLinks(stripeClient);
                    const linksByUrl = new Map(allLinks.map(l => [l.url, l]));

                    for (const [slug, art] of Object.entries(artworks)) {
                        const digitalUrl = art.priceDigital && art.priceDigital[env];
                        if (!digitalUrl) continue;
                        const link = linksByUrl.get(digitalUrl);
                        if (!link) {
                            results.push({ slug, env, ok: false, reason: 'Payment Link não encontrado na Stripe (URL desatualizada em artworks.json?)' });
                            continue;
                        }
                        const expectedUrl = `https://magnaleite.com/download-page.html?art=${slug}&session_id={CHECKOUT_SESSION_ID}`;
                        const current = link.after_completion || {};
                        const currentUrl = current.type === 'redirect' ? (current.redirect && current.redirect.url) : null;
                        const ok = currentUrl === expectedUrl;
                        results.push({ slug, env, ok, linkId: link.id, currentUrl: currentUrl || `(sem redirect — usa a confirmação padrão da Stripe)`, expectedUrl });
                    }
                }

                const problems = results.filter(r => !r.ok);
                respond(req, res, 200, { checked: results.length, problemsFound: problems.length, results });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Erro check-download-redirects:`, err.message);
                respond(req, res, 500, { error: err.message });
            }
        })();
        return;
    }

    // ── APPLY DOWNLOAD REDIRECTS (escreve na Stripe — after_completion.redirect) ──
    // Corpo: { fixes: [...] } — usa diretamente a saída de results de
    // /check-download-redirects (cada entrada já traz slug/env/linkId/expectedUrl).
    if (req.method === 'POST' && req.url === '/apply-download-redirects') {
        if (!checkAuth(req, res)) return;
        readJsonBody(req, res, MAX_JSON_SIZE, async (parsed) => {
            try {
                const fixes = Array.isArray(parsed.fixes) ? parsed.fixes : null;
                if (!fixes || !fixes.length) {
                    respond(req, res, 400, { error: 'Corpo deve conter { fixes: [...] } — usa a saída de /check-download-redirects.' });
                    return;
                }

                const applied = [];
                const skipped = [];

                for (const fix of fixes) {
                    const { slug, env, linkId, expectedUrl } = fix || {};
                    const stripeClient = env === 'live' ? stripeLive : (env === 'test' ? stripeTest : null);
                    if (!slug || !linkId || !expectedUrl || !stripeClient) {
                        skipped.push({ ...fix, reason: 'Entrada incompleta ou inválida.' });
                        continue;
                    }
                    try {
                        await stripeClient.paymentLinks.update(linkId, {
                            after_completion: { type: 'redirect', redirect: { url: expectedUrl } },
                        });
                        applied.push({ slug, env, linkId, expectedUrl });
                    } catch (err) {
                        skipped.push({ slug, env, linkId, reason: err.message });
                    }
                }

                console.log(`[${new Date().toISOString()}] apply-download-redirects — ${applied.length} aplicados, ${skipped.length} ignorados`);
                respond(req, res, 200, { success: true, appliedCount: applied.length, skippedCount: skipped.length, applied, skipped });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Erro apply-download-redirects:`, err.message);
                respond(req, res, 500, { error: err.message });
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
            const lockedSlugs = [];
            try {
                const updates = Array.isArray(parsed.updates) ? parsed.updates : null;
                if (!updates || !updates.length) {
                    respond(req, res, 400, { error: 'Corpo deve conter { updates: [...] }' });
                    return;
                }

                // Bloqueia obras já em atualização noutro pedido concorrente
                // (ver comentário junto a `busySlugs` mais acima).
                const requestedSlugs = [...new Set(updates.map(u => u.slug))];
                const blockedSlugs   = new Set(requestedSlugs.filter(s => busySlugs.has(s)));
                requestedSlugs.forEach(s => {
                    if (!blockedSlugs.has(s)) {
                        busySlugs.add(s);
                        lockedSlugs.push(s);
                    }
                });

                const results = [];

                for (const upd of updates) {
                    const { slug, variation, amount, liveUrl, testUrl } = upd;

                    if (blockedSlugs.has(slug)) {
                        const busyMsg = 'Já existe uma atualização em curso para esta obra — aguarde a anterior terminar e tente de novo.';
                        if (liveUrl) results.push({ slug, variation, env: 'live', success: false, error: busyMsg });
                        if (testUrl) results.push({ slug, variation, env: 'test', success: false, error: busyMsg });
                        continue;
                    }

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

                // Grava já os novos URLs em artworks.json — não depende do
                // Manager fazer um 2º pedido depois deste responder.
                persistStripeUrlUpdates(results);

                const failed = results.filter(r => !r.success).length;
                console.log(`[${new Date().toISOString()}] update-stripe-price — ${results.length - failed} ok, ${failed} falhas`);
                respond(req, res, 200, { success: failed === 0, results });
            } catch (err) {
                console.error(`[${new Date().toISOString()}] Erro update-stripe-price:`, err.message);
                respond(req, res, 500, { error: err.message });
            } finally {
                lockedSlugs.forEach(s => busySlugs.delete(s));
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