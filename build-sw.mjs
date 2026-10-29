#!/usr/bin/env node
/**
 * Dopo "vite build": genera dist/sw.js con l'elenco dei file statici da
 * mettere in cache e un identificativo di versione (hash dei contenuti).
 * Ogni build con contenuti diversi produce un nuovo service worker →
 * l'app propone "Aggiorna".
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error(`build-sw: ${dist}/index.html non trovato. Esegui prima "vite build".`);
  process.exit(1);
}

const files = [];
const walk = (dir) => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else files.push('/' + path.relative(dist, p).split(path.sep).join('/'));
  }
};
walk(dist);

const precache = files
  .filter((f) => !/^\/(sw\.js|robots\.txt|_headers|_redirects|api-404\.json)$/.test(f))
  .filter((f) => !f.startsWith('/splash/')) // le splash iOS non servono offline
  .filter((f) => !f.endsWith('.map'))
  .sort();

const hash = createHash('sha256');
for (const f of precache) hash.update(f).update(fs.readFileSync(path.join(dist, f)));
const version = hash.digest('hex').slice(0, 12);

const template = fs.readFileSync(path.join(root, 'scripts/sw-template.js'), 'utf8');
const sw = template.replace('__BUILD_ID__', version).replace('__PRECACHE__', JSON.stringify(precache, null, 2));
fs.writeFileSync(path.join(dist, 'sw.js'), sw);
console.log(`build-sw: sw.js versione ${version}, ${precache.length} file in cache.`);
