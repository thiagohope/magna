/**
 * share-lib.js — botão "Partilhar" (público)
 * ============================================================
 * Usado por index.html, artwork.html e exhibition.html.
 *
 * - Telemóvel/tablet: abre o menu nativo do sistema (navigator.share), que já
 *   inclui WhatsApp, Instagram, Mensagens, etc.
 * - Desktop (ou se o menu nativo não existir/falhar): painel próprio com
 *   WhatsApp, Facebook, X, Pinterest, Email e Copiar link.
 *
 * Obras e exposições partilham o link share/... gerado no servidor por
 * share-pages.js — é ele que tem as meta tags Open Graph (imagem, título,
 * texto) que o WhatsApp/Facebook/X/Pinterest leem para a pré-visualização.
 */
(function (global) {
    const SITE = 'https://magnaleite.com';

    const LABELS = {
        en: { share: 'Share', title: 'Share', copy: 'Copy link', copied: 'Link copied',
              copyFail: 'Could not copy — select the link above', email: 'Email',
              more: 'More options…', close: 'Close' },
        pt: { share: 'Partilhar', title: 'Partilhar', copy: 'Copiar link', copied: 'Link copiado',
              copyFail: 'Não foi possível copiar — selecione o link acima', email: 'Email',
              more: 'Mais opções…', close: 'Fechar' },
        es: { share: 'Compartir', title: 'Compartir', copy: 'Copiar enlace', copied: 'Enlace copiado',
              copyFail: 'No se pudo copiar — seleccione el enlace de arriba', email: 'Email',
              more: 'Más opciones…', close: 'Cerrar' }
    };
    const lbl = lang => LABELS[lang] || LABELS.en;
    const normLang = lang => (LABELS[lang] ? lang : 'en');

    // ── URLs partilháveis ────────────────────────────────────────────────────
    const enc = encodeURIComponent;
    const absImage = rel => {
        if (!rel) return SITE + '/assets/img/magna-portrait.jpg';
        if (/^https?:\/\//i.test(rel)) return rel;
        return SITE + '/' + String(rel).replace(/^\/+/, '').split('/').map(enc).join('/');
    };
    const artUrl        = (slug, lang) => `${SITE}/share/art/${enc(slug)}.${normLang(lang)}.html`;
    const exhibitionUrl = (slug, lang) => `${SITE}/share/exhibition/${enc(slug)}.${normLang(lang)}.html`;
    const homeUrl       = lang => `${SITE}/` + (normLang(lang) === 'en' ? '' : `?lang=${normLang(lang)}`);

    // ── estilos (injetados uma vez) ──────────────────────────────────────────
    const CSS = `
.mshare-overlay,.mshare-overlay *{box-sizing:border-box}
.mshare-overlay{position:fixed;inset:0;z-index:9999;background:rgba(15,15,15,.45);display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity .18s ease}
.mshare-overlay.open{opacity:1}
.mshare-card{background:#fff;color:#1a1a1a;width:100%;max-width:380px;border-radius:14px;box-shadow:0 24px 60px -12px rgba(0,0,0,.35);padding:20px;font-family:Inter,'Plus Jakarta Sans',system-ui,sans-serif;transform:translateY(8px);transition:transform .18s ease}
.mshare-overlay.open .mshare-card{transform:none}
.mshare-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.mshare-head h3{margin:0;font-size:.7rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#9ca3af;font-family:inherit}
.mshare-x{border:0;background:none;font-size:22px;line-height:1;color:#9ca3af;cursor:pointer;padding:4px 6px;border-radius:6px}
.mshare-x:hover{color:#111}
.mshare-what{font-family:'Playfair Display',serif;font-size:1.15rem;margin:0 0 14px;line-height:1.3}
.mshare-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mshare-btn{display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;color:#1a1a1a;font-size:.85rem;font-weight:500;text-decoration:none;cursor:pointer;font-family:inherit;text-align:left;transition:border-color .15s,background .15s}
.mshare-btn:hover,.mshare-btn:focus-visible{border-color:#111;background:#fafafa;outline:none}
.mshare-btn svg{width:18px;height:18px;flex-shrink:0}
.mshare-wide{grid-column:1/-1;justify-content:center}
.mshare-link{display:flex;gap:6px;margin-top:12px}
.mshare-link input{flex:1;min-width:0;font-size:.75rem;color:#6b7280;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;background:#f9fafb;font-family:inherit}
.mshare-status{min-height:1.1em;margin:8px 0 0;font-size:.75rem;color:#15803d;text-align:center}
@media (max-width:480px){.mshare-overlay{align-items:flex-end;padding:0}.mshare-card{max-width:none;border-radius:16px 16px 0 0;padding-bottom:calc(20px + env(safe-area-inset-bottom))}}
.mshare-trigger svg{width:16px;height:16px}
`;
    function injectCss() {
        if (document.getElementById('mshare-css')) return;
        const st = document.createElement('style');
        st.id = 'mshare-css';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    const ICON = {
        share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
        whatsapp: '<svg viewBox="0 0 24 24" fill="none" stroke="#25D366" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 20.5l1.3-4.2A8.5 8.5 0 1 1 8 19.4z"/><path d="M9 8.5c0 3.5 3 6.5 6.5 6.5l1-1.6-2-1-1 1c-1.3-.5-2.4-1.6-2.9-2.9l1-1-1-2z"/></svg>',
        facebook: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#1877F2"/><path d="M13.2 19v-5.6h1.9l.3-2.2h-2.2V9.8c0-.6.2-1.1 1.1-1.1h1.2v-2a16 16 0 0 0-1.7-.1c-1.7 0-2.9 1-2.9 3v1.6H9v2.2h1.9V19z" fill="#fff"/></svg>',
        x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h4.6l11.4 16h-4.6z" fill="none" stroke="#111" stroke-width="1.8" stroke-linejoin="round"/><path d="M19.5 4L13.4 10.9M4.5 20l6.1-6.9" stroke="#111" stroke-width="1.8" stroke-linecap="round"/></svg>',
        pinterest: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#E60023"/><path d="M12.3 6.5c-3 0-4.6 2-4.6 3.9 0 1 .4 2 1.2 2.3.1.1.3 0 .3-.1l.2-.6c0-.1 0-.2-.1-.3-.3-.4-.5-.8-.5-1.4 0-1.8 1.3-3.4 3.5-3.4 1.9 0 2.9 1.2 2.9 2.7 0 2-.9 3.7-2.2 3.7-.7 0-1.3-.6-1.1-1.4.2-.9.6-1.9.6-2.5 0-.6-.3-1-1-1-.8 0-1.4.8-1.4 1.9 0 .7.2 1.1.2 1.1l-1 4.1c-.2.9-.1 2.2 0 2.9h.2c.3-.5 1.1-1.7 1.3-2.4l.5-1.8c.3.5 1 .9 1.8.9 2.4 0 4-2.2 4-5.1 0-2.2-1.9-4.3-4.8-4.3z" fill="#fff"/></svg>',
        email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/></svg>',
        link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>'
    };

    // ── copiar ───────────────────────────────────────────────────────────────
    async function copyText(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) { /* tenta o método antigo */ }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e) {
            return false;
        }
    }

    // ── painel ───────────────────────────────────────────────────────────────
    let openPanel = null;

    function closePanel() {
        if (!openPanel) return;
        const { overlay, returnFocus, onKey } = openPanel;
        document.removeEventListener('keydown', onKey);
        overlay.classList.remove('open');
        setTimeout(() => overlay.remove(), 180);
        openPanel = null;
        if (returnFocus && returnFocus.focus) returnFocus.focus();
    }

    function showPanel(d, returnFocus) {
        injectCss();
        closePanel();
        const L = lbl(d.lang);
        const msg = d.text ? `${d.title} — ${d.text}` : d.title;

        const links = [
            { key: 'whatsapp',  name: 'WhatsApp',  href: `https://wa.me/?text=${enc(msg + '\n' + d.url)}` },
            { key: 'facebook',  name: 'Facebook',  href: `https://www.facebook.com/sharer/sharer.php?u=${enc(d.url)}` },
            { key: 'x',         name: 'X',         href: `https://x.com/intent/tweet?text=${enc(msg)}&url=${enc(d.url)}` },
            { key: 'pinterest', name: 'Pinterest', href: `https://pinterest.com/pin/create/button/?url=${enc(d.url)}&media=${enc(d.image)}&description=${enc(msg)}` },
            { key: 'email',     name: L.email,     href: `mailto:?subject=${enc(d.title)}&body=${enc(msg + '\n\n' + d.url)}`, self: true },
        ];

        const overlay = document.createElement('div');
        overlay.className = 'mshare-overlay';
        overlay.innerHTML = `
<div class="mshare-card" role="dialog" aria-modal="true" aria-labelledby="mshare-h">
  <div class="mshare-head"><h3 id="mshare-h"></h3><button type="button" class="mshare-x"></button></div>
  <p class="mshare-what"></p>
  <div class="mshare-grid"></div>
  <div class="mshare-link"><input type="text" readonly></div>
  <p class="mshare-status" role="status" aria-live="polite"></p>
</div>`;
        overlay.querySelector('#mshare-h').textContent = L.title;
        overlay.querySelector('.mshare-what').textContent = d.title;
        const xBtn = overlay.querySelector('.mshare-x');
        xBtn.textContent = '×';
        xBtn.setAttribute('aria-label', L.close);
        const input = overlay.querySelector('.mshare-link input');
        input.value = d.url;
        input.addEventListener('focus', () => input.select());
        const status = overlay.querySelector('.mshare-status');
        const grid = overlay.querySelector('.mshare-grid');

        links.forEach(l => {
            const a = document.createElement('a');
            a.className = 'mshare-btn';
            a.href = l.href;
            if (!l.self) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
            a.innerHTML = ICON[l.key] + '<span></span>';
            a.querySelector('span').textContent = l.name;
            a.addEventListener('click', () => setTimeout(closePanel, 50));
            grid.appendChild(a);
        });

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'mshare-btn';
        copyBtn.innerHTML = ICON.link + '<span></span>';
        copyBtn.querySelector('span').textContent = L.copy;
        copyBtn.addEventListener('click', async () => {
            const ok = await copyText(d.url);
            status.style.color = ok ? '#15803d' : '#b91c1c';
            status.textContent = ok ? L.copied : L.copyFail;
            if (!ok) { input.focus(); input.select(); }
        });
        grid.appendChild(copyBtn);

        if (navigator.share) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'mshare-btn mshare-wide';
            more.innerHTML = ICON.share + '<span></span>';
            more.querySelector('span').textContent = L.more;
            more.addEventListener('click', async () => {
                try { await navigator.share({ title: d.title, text: msg, url: d.url }); closePanel(); }
                catch (e) { /* cancelado */ }
            });
            grid.appendChild(more);
        }

        overlay.addEventListener('click', e => { if (e.target === overlay) closePanel(); });
        xBtn.addEventListener('click', closePanel);
        const onKey = e => { if (e.key === 'Escape') closePanel(); };
        document.addEventListener('keydown', onKey);

        document.body.appendChild(overlay);
        openPanel = { overlay, returnFocus, onKey };
        requestAnimationFrame(() => overlay.classList.add('open'));
        const first = grid.querySelector('.mshare-btn');
        if (first) first.focus();
    }

    // ── API ──────────────────────────────────────────────────────────────────
    // d = { url, title, text?, image?, lang }
    async function share(d, trigger) {
        const data = {
            url:   d.url,
            title: d.title || 'Magna Leite',
            text:  d.text || '',
            image: absImage(d.image),
            lang:  normLang(d.lang)
        };
        const touch = global.matchMedia && global.matchMedia('(hover: none) and (pointer: coarse)').matches;
        if (touch && navigator.share) {
            try {
                await navigator.share({
                    title: data.title,
                    text:  data.text ? `${data.title} — ${data.text}` : data.title,
                    url:   data.url
                });
                return;
            } catch (e) {
                if (e && e.name === 'AbortError') return;   // a pessoa cancelou
                /* outro erro: cai para o painel */
            }
        }
        showPanel(data, trigger);
    }

    // Injeta já os estilos, para o ícone do botão ter o tamanho certo antes do 1.º clique
    if (document.head) injectCss(); else document.addEventListener('DOMContentLoaded', injectCss);

    global.MagnaShare = { share, artUrl, exhibitionUrl, homeUrl, absImage, labels: lbl, icon: ICON.share, injectCss };
})(window);
