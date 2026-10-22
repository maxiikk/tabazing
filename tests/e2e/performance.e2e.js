// How fast Tabazing opens in real Chrome, with 60 open tabs that all have stored previews: the switcher's own
// timings (switcher.js "timings": page start -> script running, the first draw, launch -> first cards on screen,
// launch -> every preview, a keystroke -> its results), taken over a few opens. The numbers are printed for comparison between versions; the
// budgets are loose, to catch a change that makes opening much slower, not to time the machine.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch, sleep } from './helpers/harness.js';

const TABS = 60;
const OPENS = 3;
const BUDGET = { module: 1500, render: 600, cards: 1500, previews: 4000, search: 150 }; // milliseconds

let server, browser, extension;
beforeAll(async () => {
  server = await startServers();
  ({ browser, extension } = await launch());
  await extension.run(() => chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } })); // no tour over the switcher
  const urls = Array.from({ length: TABS }, (unused, i) => `${server.main}/p/Page${i}`);
  await extension.run((list) => Promise.all(list.map((url) => chrome.tabs.create({ url, active: false }))), urls);
  // A preview for each, as a capture stores it: a 560 x 350 WebP drawn and saved by the extension's own code.
  const page = await extension.extensionPage();
  // (as text: vitest rewrites an import() written in this file, and this runs in the extension's page)
  await page.evaluate(`(async (list) => {
    const { savePreview } = await import('/utils/store.js');
    for (const [i, url] of list.entries()) {
      const canvas = new OffscreenCanvas(560, 350), context = canvas.getContext('2d');
      context.fillStyle = 'hsl(' + ((i * 37) % 360) + ' 60% 70%)'; context.fillRect(0, 0, 560, 350);
      for (let line = 0; line < 30; line++) { context.fillStyle = '#333'; context.fillRect(20, 20 + line * 11, 100 + ((i * 13 + line * 29) % 400), 6); }
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.72 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      await savePreview(url, { img: 'data:image/webp;base64,' + btoa(binary), t: Date.now(), sharp: null });
    }
  })(${JSON.stringify(urls)})`);
  await page.close();
}, 180_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const frameOf = (page) => page.frames().find((frame) => frame.url().includes('markup/switcher.html'));
const measures = (frame) => frame.evaluate(() => Object.fromEntries(performance.getEntriesByType('measure')
  .filter((entry) => entry.name.startsWith('tabazing:')).map((entry) => [entry.name.slice(9), Math.round(entry.duration)])));
const median = (values) => [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)];

describe('performance', () => {
  it(`opens with ${TABS} tabs and their previews, and searches, within the budgets`, async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${server.main}/p/Start`);
    await page.bringToFront();
    await sleep(1500);
    const runs = [];
    for (let open = 0; open < OPENS; open++) {
      await page.keyboard.down('Alt'); await page.keyboard.press('KeyE'); await page.keyboard.up('Alt');
      let frame = null, times = {};
      for (let wait = 0; wait < 100 && !(times.cards && times.previews); wait++) {
        await sleep(100);
        frame = frameOf(page);
        if (frame) times = await measures(frame).catch(() => ({}));
      }
      for (const character of 'page4') { await page.keyboard.type(character); await sleep(120); }
      times = { ...times, ...(await measures(frame)) };
      runs.push(times);
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      await sleep(1200);
    }
    const result = Object.fromEntries(Object.keys(BUDGET).map((name) => [name, median(runs.map((times) => times[name] ?? Infinity))]));
    console.log(`Tabazing timings (median of ${OPENS} opens, ${TABS} tabs, milliseconds):`, JSON.stringify(result), '\n  each open:', JSON.stringify(runs));
    for (const [name, budget] of Object.entries(BUDGET)) expect(result[name], name).toBeLessThan(budget);
    // The page Tabazing was opened over was captured as it opened, by the service worker: as WebP.
    const startPreview = await extension.run((url) => chrome.storage.local.get('pv:' + url).then((stored) => stored['pv:' + url]), `${server.main}/p/Start`);
    expect(startPreview && startPreview.img.slice(0, 23)).toBe('data:image/webp;base64,');
  }, 120_000);
});
