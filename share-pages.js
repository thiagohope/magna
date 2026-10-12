/**
 * share-pages.js — páginas de partilha com pré-visualização (Open Graph)
 * =====================================================================
 * artwork.html e exhibition.html montam título e imagem em JavaScript, mas
 * WhatsApp / Facebook / X / Pinterest / LinkedIn NÃO executam JavaScript:
 * leem só o <head> estático. Sem isto, uma obra partilhada aparece como
 * "Magna — Artwork" sem imagem.
 *
 * Este módulo gera, para cada obra e cada exposição e para cada idioma, uma
 * página estática com as meta tags certas, que redireciona (só por JS — os
 * robots não seguem) para a página normal:
 *
 *   share/art/<slug>.<lang>.html         -> artwork.html?id=<slug>&lang=<lang>
 *   share/exhibition/<slug>.<lang>.html  -> exhibition.html?id=<slug>&lang=<lang>
 *   share/img/art-<slug>.jpg             -> imagem de pré-visualização (máx. 1200 px, JPEG)
 *   share/img/exhibition-<slug>.jpg
 *   share/img/site-home.jpg              -> og:image da página inicial (index.html aponta para aqui)
 *
 * É ESTE link (share/...) que os botões de partilha (share-lib.js) usam.
 *
 * Quando corre:
 *   - ao arrancar o save-artworks.js (pm2 start/restart)
 *   - sempre que artworks.json ou exhibitions.json mudam no disco — seja pelo
 *     admin, pela atualização de preços Stripe ou por SCP/WinSCP (watchFile)
 *   - manualmente: node share-pages.js
 *
 * A pasta share/ é gerada — não vai para o Git (ver .gitignore).
 *
 * O que NUNCA entra numa página de partilha: preços, estado de venda, motivo
 * da indisponibilidade, detentor. Só título, ano, técnica, dimensões, texto
 * da artista e imagem — o mesmo que qualquer visitante já vê.
 */

const fs   = require('fs');
const path = require('path');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* sem sharp: usa a thumbnail tal como está */ }

const SITE       = 'https://magnaleite.com';
const ROOT       = __dirname;
const SHARE_DIR  = path.join(ROOT, 'share');
const DIRS       = {
    art:        path.join(SHARE_DIR, 'art'),
    exhibition: path.join(SHARE_DIR, 'exhibition'),
    img:        path.join(SHARE_DIR, 'img'),
};
const ARTWORKS_PATH    = path.join(ROOT, 'artworks.json');
const EXHIBITIONS_PATH = path.join(ROOT, 'exhibitions.json');
const FALLBACK_IMAGE   = 'assets/img/magna-portrait.jpg';
const HOME_IMAGES      = ['assets/img/magna02.jpeg', FALLBACK_IMAGE];   // foto do hero primeiro (horizontal)
const LANGS            = ['en', 'pt', 'es'];
const OG_LOCALE        = { en: 'en_GB', pt: 'pt_PT', es: 'es_ES' };
const SLUG_PATTERN     = /^[A-Za-z0-9_-]{1,100}$/;
const OG_MAX_SIDE      = 1200;
const OG_MAX_BYTES     = 300 * 1024;   // acima disto o WhatsApp pode não mostrar a imagem
const DESC_MAX         = 220;

const L = {
    en: { open: 'Open', exhibition: 'Exhibition' },
    pt: { open: 'Abrir', exhibition: 'Exposição' },
    es: { open: 'Abrir', exhibition: 'Exposición' },
};

// ── helpers ─────────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const loc = (v, lang) => (v && typeof v === 'object') ? (v[lang] || v.en || v.pt || '') : (v || '');

function clip(s, max) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max - 1);
    const sp  = cut.lastIndexOf(' ');
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}

const cleanRel = p => String(p || '').trim().replace(/^\/+/, '');
const urlPath  = rel => rel.split('/').map(encodeURIComponent).join('/');

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { return null; }
}

function writeIfChanged(file, content) {
    try { if (fs.readFileSync(file, 'utf8') === content) return false; } catch (e) { /* novo */ }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
    return true;
}

function artworkSourceImage(art) {
    const first = Array.isArray(art.image) ? art.image[0] : art.image;
    const full  = cleanRel(first);
    const thumb = cleanRel(art.thumbnail) ||
                  full.replace('assets/paintings/full/', 'assets/paintings/thumbnails/');
    return { full, thumb };
}

function exhibitionSourceImage(slug, ex) {
    const f = cleanRel(ex.image);
    if (f) return f.toLowerCase().includes('assets/') ? f : `assets/exhibition/flyers/${f}`;
    const g = Array.isArray(ex.gallery) && ex.gallery[0] ? cleanRel(ex.gallery[0]) : '';
    if (g) return `assets/exhibition/img/${slug}/${g}`;
    return FALLBACK_IMAGE;
}

const exists = rel => !!rel && fs.existsSync(path.join(ROOT, rel));

// Imagem de pré-visualização: redimensiona para no máx. 1200 px (JPEG até ~300 KB,
// abaixo do limite do WhatsApp). Só refaz se a origem for mais recente.
// Sem sharp ou se falhar, devolve a imagem de origem tal como está.
async function ogImage(kind, slug, sourceCandidates) {
    const src = sourceCandidates.find(exists);
    if (!src) return { rel: FALLBACK_IMAGE };
    if (!sharp) return { rel: src };

    const outRel = `share/img/${kind}-${slug}.jpg`;
    const outAbs = path.join(ROOT, outRel);
    try {
        const srcStat = fs.statSync(path.join(ROOT, src));
        let fresh = false;
        try { fresh = fs.statSync(outAbs).mtimeMs >= srcStat.mtimeMs; } catch (e) { /* não existe */ }
        if (!fresh) {
            const encode = quality => sharp(path.join(ROOT, src))
                .rotate()
                .resize(OG_MAX_SIDE, OG_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
                .flatten({ background: '#ffffff' })
                .jpeg({ quality, mozjpeg: true })
                .toBuffer();
            let buf = await encode(80);
            if (buf.length > OG_MAX_BYTES) buf = await encode(65);
            fs.writeFileSync(outAbs + '.tmp', buf);
            fs.renameSync(outAbs + '.tmp', outAbs);
        }
        const meta = await sharp(outAbs).metadata();
        return { rel: outRel, width: meta.width, height: meta.height };
    } catch (err) {
        console.warn(`[share-pages] imagem ${kind}/${slug} — ${err.message}; a usar a original`);
        return { rel: src };
    }
}

function pageHtml({ lang, title, description, shareRel, targetRel, image, imageAlt, ogType }) {
    const shareUrl = `${SITE}/${shareRel}`;
    const imgUrl   = `${SITE}/${urlPath(image.rel)}`;
    const dims     = image.width ? `
<meta property="og:image:width" content="${image.width}">
<meta property="og:image:height" content="${image.height}">` : '';
    const alternates = LANGS.filter(l => l !== lang)
        .map(l => `\n<meta property="og:locale:alternate" content="${OG_LOCALE[l]}">`).join('');

    return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex, follow">
<meta property="og:site_name" content="Magna Leite">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(shareUrl)}">
<meta property="og:image" content="${esc(imgUrl)}">
<meta property="og:image:secure_url" content="${esc(imgUrl)}">
<meta property="og:image:type" content="image/jpeg">${dims}
<meta property="og:image:alt" content="${esc(imageAlt)}">
<meta property="og:locale" content="${OG_LOCALE[lang]}">${alternates}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(imgUrl)}">
<meta name="twitter:image:alt" content="${esc(imageAlt)}">
<link rel="icon" href="../../assets/icons/favicon.ico" sizes="any">
<script>location.replace(${JSON.stringify('../../' + targetRel)});</script>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#fdfbf7;color:#1a1a1a;text-align:center}img{max-width:min(320px,80vw);max-height:50vh;box-shadow:0 10px 30px rgba(0,0,0,.2)}a{color:inherit}p{margin:1.25rem 0 0}</style>
</head>
<body>
<main>
<img src="../../${esc(urlPath(image.rel))}" alt="${esc(imageAlt)}">
<p><a href="../../${esc(targetRel)}">${esc(L[lang].open)}: ${esc(title)}</a></p>
</main>
</body>
</html>
`;
}

// ── geração ─────────────────────────────────────────────────────────────────
async function generate() {
    const started = Date.now();
    Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));

    const artworks    = readJson(ARTWORKS_PATH)    || {};
    const exhibitions = readJson(EXHIBITIONS_PATH) || {};
    const keep = { art: new Set(), exhibition: new Set(), img: new Set() };
    let written = 0;

    // Imagem da página inicial — o index.html aponta sempre para share/img/site-home.jpg
    const home = await ogImage('site', 'home', HOME_IMAGES);
    if (!home.rel.startsWith('share/img/') && exists(home.rel)) {
        fs.copyFileSync(path.join(ROOT, home.rel), path.join(DIRS.img, 'site-home.jpg'));
    }
    keep.img.add('site-home.jpg');

    for (const [slug, art] of Object.entries(artworks)) {
        if (!SLUG_PATTERN.test(slug) || !art || typeof art !== 'object') continue;
        const { full, thumb } = artworkSourceImage(art);
        const image = await ogImage('art', slug, [full, thumb]);
        if (image.rel.startsWith('share/img/')) keep.img.add(path.basename(image.rel));

        for (const lang of LANGS) {
            const meta  = [art.year, loc(art.technique, lang), art.dimensions].filter(Boolean).join(' · ');
            const story = loc(art.story, lang);
            const file  = `${slug}.${lang}.html`;
            keep.art.add(file);
            const html = pageHtml({
                lang,
                ogType:      'article',
                title:       `${art.title || slug} — Magna Leite`,
                description: clip(story ? `${meta}. ${story}` : meta, DESC_MAX),
                shareRel:    `share/art/${file}`,
                targetRel:   `artwork.html?id=${encodeURIComponent(slug)}&lang=${lang}`,
                image,
                imageAlt:    `${art.title || slug} — Magna Leite`,
            });
            if (writeIfChanged(path.join(DIRS.art, file), html)) written++;
        }
    }

    for (const [slug, ex] of Object.entries(exhibitions)) {
        if (!SLUG_PATTERN.test(slug) || !ex || typeof ex !== 'object') continue;
        const image = await ogImage('exhibition', slug, [exhibitionSourceImage(slug, ex), FALLBACK_IMAGE]);
        if (image.rel.startsWith('share/img/')) keep.img.add(path.basename(image.rel));

        for (const lang of LANGS) {
            const meta = [ex.date, ex.location].filter(Boolean).join(' · ');
            const desc = loc(ex.description, lang);
            const file = `${slug}.${lang}.html`;
            keep.exhibition.add(file);
            const html = pageHtml({
                lang,
                ogType:      'website',
                title:       `${ex.title || slug} — Magna Leite`,
                description: clip(desc ? `${meta}. ${desc}` : `${L[lang].exhibition} · ${meta}`, DESC_MAX),
                shareRel:    `share/exhibition/${file}`,
                targetRel:   `exhibition.html?id=${encodeURIComponent(slug)}&lang=${lang}`,
                image,
                imageAlt:    ex.title || slug,
            });
            if (writeIfChanged(path.join(DIRS.exhibition, file), html)) written++;
        }
    }

    // Remove páginas/imagens de obras e exposições que já não existem
    let removed = 0;
    for (const [kind, set] of Object.entries(keep)) {
        for (const f of fs.readdirSync(DIRS[kind])) {
            if (set.has(f)) continue;
            try { fs.unlinkSync(path.join(DIRS[kind], f)); removed++; }
            catch (err) { console.warn(`[share-pages] não consegui remover ${kind}/${f} — ${err.code || err.message}`); }
        }
    }

    console.log(`[${new Date().toISOString()}] share-pages: ${Object.keys(artworks).length} obras, ` +
        `${Object.keys(exhibitions).length} exposições — ${written} página(s) atualizada(s), ${removed} removida(s)` +
        `${sharp ? '' : ' (sem sharp: imagens originais)'} em ${Date.now() - started} ms`);
}

// Serializa execuções: se mudar algo durante uma geração, corre outra no fim.
let running = false, again = false;
async function regenerate() {
    if (running) { again = true; return; }
    running = true;
    try { await generate(); }
    catch (err) { console.error(`[${new Date().toISOString()}] share-pages: erro —`, err.message); }
    finally {
        running = false;
        if (again) { again = false; regenerate(); }
    }
}

// Observa artworks.json / exhibitions.json por polling (resiste a gravações
// atómicas por rename e a uploads via SCP, ao contrário de fs.watch).
function watch() {
    let timer = null;
    const onChange = (cur, prev) => {
        if (cur.mtimeMs === prev.mtimeMs) return;
        clearTimeout(timer);
        timer = setTimeout(regenerate, 1500);
    };
    fs.watchFile(ARTWORKS_PATH,    { interval: 3000 }, onChange);
    fs.watchFile(EXHIBITIONS_PATH, { interval: 3000 }, onChange);
}

module.exports = { regenerate, watch };

if (require.main === module) regenerate();
