/**
 * migrate-unavailable.js — migração única: "vendido" → "indisponível"
 * ====================================================================
 * Corre NO SERVIDOR, depois do deploy do novo save-artworks.js (git pull +
 * pm2 delete/start). Usa a própria API local (127.0.0.1:3100), por isso as
 * mesmas regras do dia a dia aplicam-se: backup automático, registo privado
 * gravado ANTES do ficheiro público, nada se perde.
 *
 * O que faz:
 *   1. Grava no registo privado (../magna-private/registry.json) o motivo e
 *      o detentor das 3 obras indisponíveis.
 *   2. Põe "Coleção pública: Forte de Albarquel" na obra forte-albarquel.
 *   3. Regrava o artworks.json atual através de /save-artworks — o servidor
 *      converte sold_private/sold_public em "unavailable", retira o preço e
 *      os links do Original dessas obras e os eventos "Transfer", e
 *      arquiva-os no registo privado.
 *   4. Verifica o resultado.
 *
 * Uso (no servidor):
 *   cd /home/brainboxmed/magna
 *   node _local/migrate-unavailable.js --dry-run   # só mostra o que faria
 *   node _local/migrate-unavailable.js             # aplica
 *
 * É idempotente: correr duas vezes não duplica nada.
 */
const fs   = require('fs');
const path = require('path');
const http = require('http');

const ROOT     = path.join(__dirname, '..');
const ARTWORKS = path.join(ROOT, 'artworks.json');
const DRY_RUN  = process.argv.includes('--dry-run');

// O secret é lido do ecosystem.config.js (nunca escrito aqui nem na shell)
const eco    = require(path.join(ROOT, 'ecosystem.config.js'));
const app    = (eco.apps || []).find(a => a.name === 'magna-api') || (eco.apps || [])[0] || {};
const SECRET = (app.env && app.env.MAGNA_API_SECRET) || process.env.MAGNA_API_SECRET;
if (!SECRET) { console.error('MAGNA_API_SECRET não encontrado no ecosystem.config.js'); process.exit(1); }

const REGISTRY_ENTRIES = {
    'bandeirola': {
        reason: 'artist_collection', holderType: 'private', holderName: 'Acervo da família',
        date: '', notes: 'Selecionada pela família; fica na nossa casa. Não foi vendida.'
    },
    'alcube': {
        reason: 'donated', holderType: 'private', holderName: 'Quinta do Alcube',
        date: '', notes: 'Doada à Quinta do Alcube.'
    },
    'forte-albarquel': {
        reason: 'donated', holderType: 'institution', holderName: 'Forte de Albarquel',
        date: '', notes: 'Doada ao Forte de Albarquel (coleção pública).'
    }
};
const PUBLIC_COLLECTIONS = { 'forte-albarquel': 'Forte de Albarquel' };

function api(method, endpoint, body) {
    return new Promise((resolve, reject) => {
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request({
            host: '127.0.0.1', port: 3100, path: endpoint, method,
            headers: Object.assign({ 'X-Magna-Secret': SECRET },
                data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {})
        }, res => {
            let out = '';
            res.on('data', c => out += c);
            res.on('end', () => {
                let parsed; try { parsed = JSON.parse(out); } catch (e) { parsed = out; }
                if (res.statusCode >= 400) reject(new Error(`${endpoint} → HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
                else resolve(parsed);
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    const artworks = JSON.parse(fs.readFileSync(ARTWORKS, 'utf8'));
    for (const slug of Object.keys(REGISTRY_ENTRIES)) {
        if (!artworks[slug]) { console.error(`Obra "${slug}" não existe no artworks.json — abortado.`); process.exit(1); }
    }

    console.log('Estado atual:');
    Object.entries(artworks).filter(([, a]) => a.status && a.status !== 'available')
        .forEach(([s, a]) => console.log(`  ${s}: ${a.status}`));

    Object.entries(PUBLIC_COLLECTIONS).forEach(([slug, name]) => { artworks[slug].publicCollection = name; });

    if (DRY_RUN) {
        console.log('\n[dry-run] Registo privado a gravar:', JSON.stringify(REGISTRY_ENTRIES, null, 2));
        console.log('[dry-run] Coleções públicas:', PUBLIC_COLLECTIONS);
        console.log('[dry-run] Nada foi gravado.');
        return;
    }

    // Confirma que o servidor já tem a versão nova (com registo privado)
    await api('GET', '/private-registry');

    const reg = await api('POST', '/save-private-registry', REGISTRY_ENTRIES);
    console.log(`\n✓ Registo privado gravado (${reg.entries} obra(s)).`);

    const saved = await api('POST', '/save-artworks', artworks);
    console.log(`✓ artworks.json regravado (${saved.artworks} obras). Retirado para o registo privado: ${saved.movedToPrivate.join(', ') || 'nada'}.`);

    // Verificação
    const after    = JSON.parse(fs.readFileSync(ARTWORKS, 'utf8'));
    const registry = await api('GET', '/private-registry');
    const problems = [];
    Object.entries(after).forEach(([s, a]) => {
        if (!['available', 'unavailable'].includes(a.status)) problems.push(`${s}: estado "${a.status}"`);
        if (a.status === 'unavailable' && a.priceOriginal) problems.push(`${s}: ainda tem links do Original`);
        if (a.status === 'unavailable' && a.priceDisplay && 'original' in a.priceDisplay) problems.push(`${s}: ainda tem preço do Original`);
        if ((a.history || []).some(h => h.event === 'Transfer')) problems.push(`${s}: ainda tem evento Transfer`);
    });
    if (JSON.stringify(after).includes('sold_')) problems.push('o ficheiro ainda contém "sold_"');

    console.log('\nResultado:');
    Object.keys(REGISTRY_ENTRIES).forEach(s => {
        const a = after[s], r = registry[s] || {};
        console.log(`  ${s}: público=${a.status}${a.publicCollection ? ` (Coleção pública: ${a.publicCollection})` : ''} | ` +
            `interno=${r.reason || '—'} / ${r.holderType || '—'} / ${r.holderName || '—'} | ` +
            `arquivado: preço ${r.archived && r.archived.priceOriginalDisplay ? '€' + r.archived.priceOriginalDisplay : '—'}, ` +
            `links ${r.archived && r.archived.priceOriginal ? 'sim' : '—'}, transferências ${(r.archived && r.archived.transfers || []).length}`);
    });
    if (problems.length) { console.error('\n✗ PROBLEMAS:\n  ' + problems.join('\n  ')); process.exit(1); }
    console.log('\n✓ Verificação OK — nenhum dado privado no artworks.json público.');
})().catch(err => { console.error('✗ Falhou:', err.message); process.exit(1); });
