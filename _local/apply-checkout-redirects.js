/**
 * apply-checkout-redirects.js — configura o redirect pós-pagamento dos
 * Payment Links (download digital + prints Gallery/Collector).
 * =====================================================================
 * Sem o redirect, depois de pagar o comprador fica na página de confirmação
 * da Stripe e o site nunca recebe o session_id — o download digital não é
 * libertado e o print não recebe número de cópia automaticamente.
 *
 * Destinos:
 *   digital         → download-page.html?art=<slug>&session_id={CHECKOUT_SESSION_ID}
 *   printGallery    → digital-token.html?art=<slug>&type=gallery&session_id={CHECKOUT_SESSION_ID}
 *   printCollector  → digital-token.html?art=<slug>&type=collector&session_id={CHECKOUT_SESSION_ID}
 *
 * Uso (no servidor, depois do deploy):
 *   cd /home/brainboxmed/magna
 *   node _local/apply-checkout-redirects.js            # só mostra o diagnóstico
 *   node _local/apply-checkout-redirects.js --apply    # corrige os links ativos com redirect errado
 *
 * Idempotente. Substitui o antigo apply-download-redirects.js (só digital,
 * com lista fixa de links).
 */
const path = require('path');
const http = require('http');

const ROOT  = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const eco   = require(path.join(ROOT, 'ecosystem.config.js'));
const app   = (eco.apps || []).find(a => a.name === 'magna-api') || (eco.apps || [])[0] || {};
const SECRET = (app.env && app.env.MAGNA_API_SECRET) || process.env.MAGNA_API_SECRET;
if (!SECRET) { console.error('MAGNA_API_SECRET não encontrado no ecosystem.config.js'); process.exit(1); }

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
    const check = await api('GET', '/check-download-redirects');
    const results = check.results || [];
    const ok        = results.filter(r => r.ok);
    const fixable   = results.filter(r => !r.ok && r.linkId && r.active !== false);
    const inactive  = results.filter(r => !r.ok && r.linkId && r.active === false);
    const missing   = results.filter(r => !r.ok && !r.linkId);

    console.log(`Links verificados: ${results.length} · corretos: ${ok.length} · a corrigir: ${fixable.length} · inativos (ignorados): ${inactive.length} · não encontrados na Stripe: ${missing.length}\n`);
    fixable.forEach(r => console.log(`  A CORRIGIR  ${r.env.padEnd(4)} ${r.slug} / ${r.variation}\n              atual:    ${r.currentUrl}\n              esperado: ${r.expectedUrl}`));
    missing.forEach(r => console.log(`  NÃO EXISTE  ${r.env.padEnd(4)} ${r.slug} / ${r.variation} — ${r.reason}`));

    if (!APPLY) {
        console.log(fixable.length ? '\nNada foi alterado. Para aplicar: node _local/apply-checkout-redirects.js --apply' : '\nNada a corrigir.');
        return;
    }
    if (!fixable.length) { console.log('\nNada a corrigir.'); return; }
    const out = await api('POST', '/apply-download-redirects', { fixes: fixable });
    console.log(`\n✓ Aplicados: ${out.appliedCount} · ignorados: ${out.skippedCount}`);
    (out.skipped || []).forEach(s => console.log(`  ignorado: ${s.env} ${s.slug} — ${s.reason}`));
})().catch(err => { console.error('✗ Falhou:', err.message); process.exit(1); });
