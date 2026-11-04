/**
 * situations-lib.js — situação temporária das obras (público)
 * ============================================================
 * Lê situations.json (escrito pelo admin "Situações") e diz, para cada obra,
 * em que situação está HOJE: em exposição, reservada ou em restauro.
 * Cada situação é um período [startDate, endDate]; fora do período deixa de
 * se aplicar sozinha — não há nada para "reverter".
 * Usado por index.html, artwork.html, verify-original.html e admin/certificate.html.
 */
(function (global) {
    const LABELS = {
        en: { exhibition: 'On exhibition', reserved: 'Reserved', restoration: 'In restoration',
              until: 'until', untilFurther: 'until further notice', current: 'Current status',
              inquire: 'Reserved — enquire', exhibitionEvent: 'Exhibition' },
        pt: { exhibition: 'Em exposição', reserved: 'Reservada', restoration: 'Em restauro',
              until: 'até', untilFurther: 'até nova indicação', current: 'Situação atual',
              inquire: 'Reservada — pedir informações', exhibitionEvent: 'Exposição' },
        es: { exhibition: 'En exposición', reserved: 'Reservada', restoration: 'En restauración',
              until: 'hasta', untilFurther: 'hasta nuevo aviso', current: 'Situación actual',
              inquire: 'Reservada — solicitar información', exhibitionEvent: 'Exposición' }
    };
    const ORDER = { exhibition: 1, reserved: 2, restoration: 3 };
    const pad = n => String(n).padStart(2, '0');

    // Data de hoje no fuso de quem visita (AAAA-MM-DD)
    function today() {
        const d = new Date();
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    async function load(base) {
        try {
            const r = await fetch((base || '') + 'situations.json?v=' + Date.now());
            if (!r.ok) return [];
            const j = await r.json();
            return Array.isArray(j.situations) ? j.situations : [];
        } catch (e) {
            return [];
        }
    }

    function isActive(s, t) {
        t = t || today();
        return !!s.startDate && s.startDate <= t && (!s.endDate || t <= s.endDate);
    }

    function activeFor(list, slug, t) {
        return (list || [])
            .filter(s => (s.artworks || []).includes(slug) && isActive(s, t))
            .sort((a, b) => (ORDER[a.type] || 9) - (ORDER[b.type] || 9));
    }

    function hasActive(list, slug, type, t) {
        return activeFor(list, slug, t).some(s => s.type === type);
    }

    // Exposições já terminadas — entram na proveniência do certificado
    function endedExhibitionsFor(list, slug, t) {
        t = t || today();
        return (list || []).filter(s => s.type === 'exhibition' && (s.artworks || []).includes(slug) && s.endDate && s.endDate < t);
    }

    function labels(lang) { return LABELS[lang] || LABELS.en; }

    function formatDate(iso, lang) {
        if (!iso) return '';
        const loc = lang === 'pt' ? 'pt-PT' : (lang === 'es' ? 'es-ES' : 'en-GB');
        return new Date(iso + 'T12:00:00').toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
    }

    // "Em exposição — Forte de Albarquel · até 30 de novembro de 2026"
    function describe(s, lang) {
        const L = labels(lang);
        let txt = L[s.type] || s.type;
        if (s.place) txt += ` — ${s.place}`;
        txt += s.endDate ? ` · ${L.until} ${formatDate(s.endDate, lang)}` : ` · ${L.untilFurther}`;
        return txt;
    }

    // Situação atual de uma obra (linha "Collection" da proveniência) — sempre em inglês.
    // Coleção pública: mostra o nome. Coleção privada: mostra só o país (o detentor
    // fica no registo interno). Sem data "desde" não se mostra nada.
    function collectionEntry(art) {
        if (!art || !art.collectionSince) return null;
        const type = art.collectionType || (art.publicCollection ? 'public' : '');
        if (type === 'public' && art.publicCollection)
            return { date: art.collectionSince, event: 'Collection', location: `Public collection — ${art.publicCollection}` };
        if (type === 'private')
            return { date: art.collectionSince, event: 'Collection', location: 'Private collection' + (art.collectionCountry ? ` — ${art.collectionCountry}` : '') };
        return null;
    }

    // exhibitions.json (páginas de exposição do site) — também alimenta a proveniência.
    async function loadExhibitions(base) {
        try {
            const r = await fetch((base || '') + 'exhibitions.json?v=' + Date.now());
            if (!r.ok) return {};
            const j = await r.json();
            return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
        } catch (e) {
            return {};
        }
    }

    // Todas as exposições JÁ TERMINADAS de uma obra, vindas de exhibitions.json e de
    // situations.json, sem duplicar entre si nem com as escritas à mão no histórico.
    // Duplicado = mesma data de início, ou mesmo ano e mesmo local (ignorando acentos,
    // maiúsculas e pontuação: "Setúbal" = "Setubal").
    function provenanceExhibitions(situations, exhibitions, slug, manual, t) {
        t = t || today();
        const key   = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const same  = (a, b) => (!!a.date && a.date === b.date) ||
                                (String(a.date || '').slice(0, 4) === String(b.date || '').slice(0, 4) && key(a.location) === key(b.location));
        const range = (s, e) => (e && e !== s) ? `${s} → ${e}` : s;
        const seen  = (manual || []).filter(h => h && h.event === 'Exhibition');
        const out   = [];
        const add   = e => { if (![...seen, ...out].some(h => same(h, e))) out.push(e); };
        const low   = String(slug || '').trim().toLowerCase();

        Object.values(exhibitions || {}).forEach(x => {
            if (!x || !x.startDate || !(x.artworks || []).some(a => String(a).trim().toLowerCase() === low)) return;
            const end = x.endDate || x.startDate;
            if (end >= t) return; // ainda a decorrer ou futura
            add({ date: x.startDate, event: 'Exhibition', location: x.location || x.title || '',
                  details: [x.title, range(x.startDate, end)].filter(Boolean).join(' · ') });
        });
        endedExhibitionsFor(situations, slug, t).forEach(s =>
            add({ date: s.startDate, event: 'Exhibition', location: s.place || '', details: range(s.startDate, s.endDate) }));
        return out;
    }

    global.MagnaSituations = { load, today, isActive, activeFor, hasActive, endedExhibitionsFor, labels, describe, formatDate, collectionEntry, loadExhibitions, provenanceExhibitions };
})(window);
