#!/usr/bin/env node
/**
 * migrate-exhibitions.js — corre UMA vez no servidor (Nov 2026)
 * ============================================================
 * Passa as exposições que ainda estão em situations.json para exhibitions.json,
 * que passou a ser a fonte única das exposições.
 *
 *  - Se já existir no exhibitions.json uma exposição com a mesma data de início
 *    e pelo menos uma obra em comum (ou o mesmo local), junta-lhe as obras que
 *    faltarem — não cria duplicado.
 *  - Senão cria uma exposição nova em RASCUNHO (published:false), com o local
 *    como título provisório, para depois completar no gestor de Exposições.
 *  - Remove essas exposições do situations.json (reservada/restauro ficam).
 *  - Faz cópia de segurança dos dois ficheiros em backups/ antes de escrever.
 *
 * Uso:
 *   node migrate-exhibitions.js           # só mostra o que faria (não escreve nada)
 *   node migrate-exhibitions.js --apply   # aplica
 */
const fs   = require('fs');
const path = require('path');

const ROOT        = __dirname;
const SIT_PATH    = path.join(ROOT, 'situations.json');
const EXH_PATH    = path.join(ROOT, 'exhibitions.json');
const BACKUP_DIR  = path.join(ROOT, 'backups');
const APPLY       = process.argv.includes('--apply');

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const key = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slugify = v => key(v).replace(/ /g, '-').slice(0, 60);
const low = list => (list || []).map(a => String(a).trim().toLowerCase());

function dateLabel(s, e) {
    if (!s) return '';
    const sd = new Date(s + 'T00:00:00');
    if (e && e !== s) {
        const ed = new Date(e + 'T00:00:00');
        return sd.getFullYear() === ed.getFullYear()
            ? `${MONTHS[sd.getMonth()]},${sd.getDate()} - ${MONTHS[ed.getMonth()]},${ed.getDate()}, ${ed.getFullYear()}`
            : `${MONTHS[sd.getMonth()]},${sd.getDate()}, ${sd.getFullYear()} - ${MONTHS[ed.getMonth()]},${ed.getDate()}, ${ed.getFullYear()}`;
    }
    return `${MONTHS[sd.getMonth()]}, ${sd.getFullYear()}`;
}

function writeAtomic(p, obj) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
}

if (!fs.existsSync(SIT_PATH)) { console.log('situations.json não existe — nada a migrar.'); process.exit(0); }
const sitFile = JSON.parse(fs.readFileSync(SIT_PATH, 'utf8'));
const sits    = Array.isArray(sitFile.situations) ? sitFile.situations : [];
const exh     = fs.existsSync(EXH_PATH) ? JSON.parse(fs.readFileSync(EXH_PATH, 'utf8')) : {};

const toMove = sits.filter(s => s && s.type === 'exhibition');
const keep   = sits.filter(s => !(s && s.type === 'exhibition'));
if (!toMove.length) { console.log('Nenhuma exposição em situations.json — nada a migrar.'); process.exit(0); }

console.log(`${toMove.length} exposição(ões) em situations.json:\n`);
for (const s of toMove) {
    const match = Object.entries(exh).find(([, x]) => x && x.startDate === s.startDate &&
        (low(x.artworks).some(a => low(s.artworks).includes(a)) || key(x.location) === key(s.place)));
    if (match) {
        const [slug, x] = match;
        const have = new Set(low(x.artworks));
        const add = (s.artworks || []).filter(a => !have.has(String(a).toLowerCase()));
        x.artworks = [...(x.artworks || []), ...add];
        if (!x.endDate && s.endDate) { x.endDate = s.endDate; x.date = dateLabel(x.startDate, x.endDate); }
        console.log(`  • ${s.place} (${s.startDate}) → junta à exposição existente "${slug}"` +
            (add.length ? ` (+${add.length} obra(s): ${add.join(', ')})` : ' (nenhuma obra nova)'));
    } else {
        const base = [String(s.startDate || '').slice(0, 4), slugify(s.place)].filter(Boolean).join('-') || 'exposicao';
        let slug = base, i = 2;
        while (exh[slug]) slug = `${base}-${i++}`;
        exh[slug] = {
            title: s.place, date: dateLabel(s.startDate, s.endDate),
            startDate: s.startDate, endDate: s.endDate || '',
            location: s.place, image: '',
            description: { pt: '', en: '', es: '' },
            gallery: [], artworks: [...(s.artworks || [])],
            published: false
        };
        console.log(`  • ${s.place} (${s.startDate}) → nova exposição em RASCUNHO "${slug}" (${(s.artworks || []).length} obra(s)) — complete título, cartaz e fotos no gestor`);
    }
}

if (!APPLY) {
    console.log('\nNada foi escrito. Para aplicar: node migrate-exhibitions.js --apply');
    process.exit(0);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(SIT_PATH, path.join(BACKUP_DIR, `situations-pre-migracao-${stamp}.json`));
if (fs.existsSync(EXH_PATH)) fs.copyFileSync(EXH_PATH, path.join(BACKUP_DIR, `exhibitions-pre-migracao-${stamp}.json`));

writeAtomic(EXH_PATH, exh);
writeAtomic(SIT_PATH, { ...sitFile, situations: keep });
console.log(`\n✅ Migração aplicada. Cópias de segurança em backups/*-pre-migracao-${stamp}.json`);
