#!/usr/bin/env node
/**
 * Genera icone PWA e schermate di avvio iOS dal monogramma SVG.
 * Per usare il logo ufficiale: sostituisci public/icons/monogram.svg
 * (vettoriale, quadrato 512x512) e rilancia:  npm run icons
 * In alternativa sostituisci direttamente i PNG in public/icons.
 * Richiede "sharp" (npm i -D sharp).
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const INK = '#1D1A17';
const CHAMPAGNE = '#C8AD7F';
const IVORY = '#F7F2E8';
const mono = fs.readFileSync(path.join(root, 'public/icons/monogram.svg'), 'utf8');
const inner = mono.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const icon = ({ bg, fg, scale = 1, radius = 0 }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="${radius}" fill="${bg}"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)" color="${fg}" style="color:${fg}">${inner.replace(/currentColor/g, fg)}</g>
</svg>`;

const out = (f) => path.join(root, 'public', f);
const png = (svg, size, file) => sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(out(file));

await png(icon({ bg: INK, fg: CHAMPAGNE, scale: 1.05 }), 192, 'icons/icon-192.png');
await png(icon({ bg: INK, fg: CHAMPAGNE, scale: 1.05 }), 512, 'icons/icon-512.png');
// maskable: area sicura (80%) rispettata riducendo il monogramma
await png(icon({ bg: INK, fg: CHAMPAGNE, scale: 0.8 }), 192, 'icons/maskable-192.png');
await png(icon({ bg: INK, fg: CHAMPAGNE, scale: 0.8 }), 512, 'icons/maskable-512.png');
await png(icon({ bg: INK, fg: CHAMPAGNE, scale: 1 }), 180, 'icons/apple-touch-icon.png');
fs.writeFileSync(out('favicon.svg'), icon({ bg: INK, fg: CHAMPAGNE, scale: 1.05, radius: 112 }));

// Schermate di avvio iOS (portrait): avorio con monogramma
export const SPLASH = [
  [750, 1334, 2], [828, 1792, 2], [1125, 2436, 3], [1242, 2688, 3], [1170, 2532, 3],
  [1179, 2556, 3], [1284, 2778, 3], [1290, 2796, 3], [1206, 2622, 3], [1320, 2868, 3],
];
for (const [w, h] of SPLASH) {
  const s = Math.round(Math.min(w, h) * 0.28);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${IVORY}"/>
    <g transform="translate(${(w - s) / 2} ${(h - s) / 2}) scale(${s / 512})">${inner.replace(/currentColor/g, INK)}</g></svg>`;
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out(`splash/splash-${w}x${h}.png`));
}
console.log('Icone e splash generate.');
