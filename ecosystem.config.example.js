/**
 * PM2 ecosystem config — TEMPLATE / EXAMPLE
 *
 * 1. Copy this file to "ecosystem.config.js" on the production server:
 *      cp ecosystem.config.example.js ecosystem.config.js
 *
 * 2. Replace CHANGE_THIS_SECRET below with a strong, randomly generated
 *    secret (e.g. `openssl rand -hex 24`).
 *
 * 3. Start / restart the process:
 *      pm2 start ecosystem.config.js
 *      pm2 save
 *
 * IMPORTANT: "ecosystem.config.js" (without ".example") is gitignored and
 * must NEVER be committed — it contains the real production secret.
 * Only this ".example" file (with the placeholder) is versioned.
 */

module.exports = {
  apps: [{
    name: 'magna-api',
    script: 'save-artworks.js',
    cwd: '/home/brainboxmed/magna',
    env: {
      MAGNA_API_SECRET: 'CHANGE_THIS_SECRET'
    }
  }]
};