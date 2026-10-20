// Draws the extension's icon (icons/icon{16,32,48,128}.png, and icons/icon.svg, its source) with Puppeteer's Chrome:
// `npm run icons`. A dark rounded square holding a 2x2 grid of rounded tiles in the accent's blues (tabs, as the
// switcher lays them out), one of them lit and ringed: the tab you are switching to. The small sizes drop the ring
// and round less, so the four tiles stay apart at 16 px.
import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer';

export function iconSvg(size = 128) {
  const small = size <= 32;
  const tile = (x, y, fill, extra = '') => `<rect x="${x}" y="${y}" width="32" height="32" rx="${small ? 6 : 8}" fill="${fill}"${extra}/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f2a3c"/><stop offset="1" stop-color="#0b1019"/></linearGradient>
    <linearGradient id="tiles" gradientUnits="userSpaceOnUse" x1="28" y1="28" x2="100" y2="100"><stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#2f6fe4"/></linearGradient>
    <linearGradient id="lit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cdeefe"/></linearGradient>
  </defs>
  <rect x="${small ? 2 : 4}" y="${small ? 2 : 4}" width="${small ? 124 : 120}" height="${small ? 124 : 120}" rx="${small ? 24 : 28}" fill="url(#bg)"/>
  <rect x="${small ? 2.5 : 4.5}" y="${small ? 2.5 : 4.5}" width="${small ? 123 : 119}" height="${small ? 123 : 119}" rx="${small ? 23.5 : 27.5}" fill="none" stroke="#ffffff" stroke-opacity=".1"/>
  ${small ? '' : '<rect x="63" y="23" width="42" height="42" rx="12" fill="none" stroke="#7dd3fc" stroke-opacity=".45" stroke-width="4"/>'}
  ${tile(28, 28, 'url(#tiles)')}
  ${tile(28, 68, 'url(#tiles)')}
  ${tile(68, 68, 'url(#tiles)')}
  ${tile(68, 28, 'url(#lit)')}
</svg>`;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('icons.js')) {
  writeFileSync('icons/icon.svg', iconSvg(128) + '\n');
  const browser = await puppeteer.launch();
  try {
    const page = await browser.newPage();
    for (const size of [16, 32, 48, 128]) {
      await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${iconSvg(size)}`);
      await page.screenshot({ path: `icons/icon${size}.png`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    }
  } finally { await browser.close(); }
}
