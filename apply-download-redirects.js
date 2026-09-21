/**
 * apply-download-redirects.js — ONE-OFF script.
 *
 * Runs the /apply-download-redirects call directly from Node on the server,
 * with the fixes list baked in below — avoids pasting a big JSON body into
 * the SSH terminal (which was getting corrupted on paste).
 *
 * Usage (on the server, from the project root):
 *   MAGNA_API_SECRET=xxxx node apply-download-redirects.js
 * (or edit SECRET below directly and just run `node apply-download-redirects.js`)
 */

const https = require('https');

const SECRET = process.env.MAGNA_API_SECRET || 'PASTE_SECRET_HERE';

const fixes = [
  {"slug":"choco","env":"live","linkId":"plink_1UGp9jK0ENtmk4UItZFJ78J7","expectedUrl":"https://magnaleite.com/download-page.html?art=choco&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"figueirinha","env":"live","linkId":"plink_1UGpcCK0ENtmk4UIULPUWpjG","expectedUrl":"https://magnaleite.com/download-page.html?art=figueirinha&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"forte-albarquel","env":"live","linkId":"plink_1UGpAbK0ENtmk4UIussO0fKs","expectedUrl":"https://magnaleite.com/download-page.html?art=forte-albarquel&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"trabalho","env":"live","linkId":"plink_1UGpd9K0ENtmk4UI6sWr8G1M","expectedUrl":"https://magnaleite.com/download-page.html?art=trabalho&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"coral","env":"live","linkId":"plink_1UGpPLK0ENtmk4UITUojvZ6O","expectedUrl":"https://magnaleite.com/download-page.html?art=coral&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"anfora","env":"live","linkId":"plink_1UGpBwK0ENtmk4UIt7UWDMFY","expectedUrl":"https://magnaleite.com/download-page.html?art=anfora&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"mertola","env":"live","linkId":"plink_1UGomyK0ENtmk4UIXfhbNmAw","expectedUrl":"https://magnaleite.com/download-page.html?art=mertola&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"rainha","env":"live","linkId":"plink_1UGpRPK0ENtmk4UI6ZDrGmWP","expectedUrl":"https://magnaleite.com/download-page.html?art=rainha&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"Time","env":"live","linkId":"plink_1UGokjK0ENtmk4UIcgXfrYY2","expectedUrl":"https://magnaleite.com/download-page.html?art=Time&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"mente1","env":"live","linkId":"plink_1UGolJK0ENtmk4UIz5EswNUG","expectedUrl":"https://magnaleite.com/download-page.html?art=mente1&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"alcube","env":"live","linkId":"plink_1UGpJWK0ENtmk4UIjodaB820","expectedUrl":"https://magnaleite.com/download-page.html?art=alcube&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"mosaic","env":"live","linkId":"plink_1UGpGAK0ENtmk4UISzvTPlfD","expectedUrl":"https://magnaleite.com/download-page.html?art=mosaic&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"mosaic02","env":"live","linkId":"plink_1UGpIpK0ENtmk4UIQCWiwCAP","expectedUrl":"https://magnaleite.com/download-page.html?art=mosaic02&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"bandeirola","env":"live","linkId":"plink_1U1vrXK0ENtmk4UIPdOeQfZW","expectedUrl":"https://magnaleite.com/download-page.html?art=bandeirola&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"nova_anfora","env":"live","linkId":"plink_1UGpQYK0ENtmk4UIuYcOtX96","expectedUrl":"https://magnaleite.com/download-page.html?art=nova_anfora&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"barcos","env":"live","linkId":"plink_1UGokxK0ENtmk4UI3a3puvR0","expectedUrl":"https://magnaleite.com/download-page.html?art=barcos&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"coraldueto","env":"live","linkId":"plink_1UGol8K0ENtmk4UIAs3Oo9F7","expectedUrl":"https://magnaleite.com/download-page.html?art=coraldueto&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"choco","env":"test","linkId":"plink_1UGp9lGYhXbBzvRK0amjm7cY","expectedUrl":"https://magnaleite.com/download-page.html?art=choco&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"figueirinha","env":"test","linkId":"plink_1UGpcFGYhXbBzvRK6s4NSRDW","expectedUrl":"https://magnaleite.com/download-page.html?art=figueirinha&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"forte-albarquel","env":"test","linkId":"plink_1UGpAeGYhXbBzvRKd6VarD2q","expectedUrl":"https://magnaleite.com/download-page.html?art=forte-albarquel&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"trabalho","env":"test","linkId":"plink_1UGpdBGYhXbBzvRKivlTdiEc","expectedUrl":"https://magnaleite.com/download-page.html?art=trabalho&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"coral","env":"test","linkId":"plink_1UGpPOGYhXbBzvRK4WN8ckQ0","expectedUrl":"https://magnaleite.com/download-page.html?art=coral&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"anfora","env":"test","linkId":"plink_1UGpBzGYhXbBzvRKxJUDeTCn","expectedUrl":"https://magnaleite.com/download-page.html?art=anfora&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"mertola","env":"test","linkId":"plink_1UGon0GYhXbBzvRKXs5mdXrx","expectedUrl":"https://magnaleite.com/download-page.html?art=mertola&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"rainha","env":"test","linkId":"plink_1UGpRRGYhXbBzvRKKJeEvBP8","expectedUrl":"https://magnaleite.com/download-page.html?art=rainha&session_id={CHECKOUT_SESSION_ID}"},
  {"slug":"Time","env":"test","linkId":"plink_1UGoklGYhXbBzvRKmLeSAJ8X","expectedUrl":"https://magnaleite.com/download-page.html?art=Time&session_id={CHECKOUT_SESSION_ID}"}
];

const body = JSON.stringify({ fixes });

const req = https.request(
  'https://brainboxmed.com/magna/api/apply-download-redirects',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Magna-Secret': SECRET,
    },
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      console.log('HTTP', res.statusCode);
      try {
        console.log(JSON.stringify(JSON.parse(data), null, 2));
      } catch (e) {
        console.log(data);
      }
    });
  }
);

req.on('error', (err) => {
  console.error('Erro na requisição:', err.message);
});

req.write(body);
req.end();
