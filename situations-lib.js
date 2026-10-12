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

    global.MagnaSituations = { load, today, isActive, activeFor, hasActive, endedExhibitionsFor, labels, describe, formatDate };
})(window);
