// How fast Tabazing opens in real Chrome, with 60 open tabs that all have stored previews, in three situations:
// an idle machine; a loaded one (every CPU core busy with threads spinning in this process, and the page and the
// switcher's frame slowed down 4x, as on a weak or overloaded computer); and loaded with the background service
// worker asleep (Chrome stops it after half a minute idle, and the next press has to start it again).
// Each open is timed from the key press to the moment it is on screen: the page shows the overlay (which waits for
// the switcher to have drawn AND for the page's screenshot), or the first frame after the switcher in its own window
// said it is ready; along with the switcher's own timings (switcher.js "timings"). Keys are pressed as a person
// does: Alt, a moment, then the letter (the page's screenshot is started as Alt goes down). The numbers are printed for
// comparison between versions; the budgets are loose, to catch a change that makes opening much slower, not to
// time the machine.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { startServers, launch, sleep } from './helpers/harness.js';

const TABS = 60;
const OPENS = 3;
const IDLE_BUDGET = { module: 1500, render: 600, search: 150, shown: 1500 }; // milliseconds
const LOADED_BUDGET = 10000; // press -> on screen, however busy the machine: it must still open

// Everything goes through an extension page, never the service worker itself: a DevTools session on the worker makes
// Chrome hold it, waiting for the debugger, when it starts again after being stopped (the "background asleep" case).
let server, browser, extension, extensionPage;
beforeAll(async () => {
  server = await startServers();
  ({ browser, extension } = await launch());
  extensionPage = await extension.extensionPage();
  await extensionPage.evaluate(() => chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } })); // no tour over the switcher
  const urls = Array.from({ length: TABS }, (unused, i) => `${server.main}/p/Page${i}`);
  await extensionPage.evaluate((list) => Promise.all(list.map((url) => chrome.tabs.create({ url, active: false }))), urls);
  // A preview for each, as a capture stores it: a 560 x 350 WebP drawn and saved by the extension's own code.
  const page = extensionPage;
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
}, 180_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

// The switcher: in the page (the overlay), or in its own window (where the page was too busy to show it).
async function switcherFrame(page) {
  const inPage = page.frames().find((frame) => frame.url().includes('markup/switcher.html'));
  const popupTarget = browser.targets().find((target) => target.type() === 'page' && target !== extensionPage.target() && target.url().includes('markup/switcher.html') && !target.url().includes('standby='));
  if (popupTarget) { const popup = await popupTarget.page(); return { frame: popup && popup.mainFrame(), popup }; }
  return { frame: inPage, popup: null };
}
// The switcher's timings, and when it was first on screen (epoch milliseconds, comparable with Date.now() here).
const measures = (frame) => frame.evaluate(() => {
  const out = Object.fromEntries(performance.getEntriesByType('measure').filter((entry) => entry.name.startsWith('tabazing:')).map((entry) => [entry.name.slice(9), Math.round(entry.duration)]));
  const visible = performance.getEntriesByName('tabazing:visible-end')[0];
  if (visible) out.visibleAt = performance.timeOrigin + visible.startTime;
  return out;
});
// When the page shows the overlay (epoch milliseconds), watched from before the press.
const watchReveal = (page) => page.evaluate(() => {
  window.revealedAt = 0;
  const shown = () => { const frame = document.querySelector('[data-testid="overlay-frame"]'); return !!frame && frame.style.visibility === 'visible'; };
  const observer = new MutationObserver(() => { if (shown()) { window.revealedAt = Date.now(); observer.disconnect(); } });
  observer.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['style'] });
});
const revealedAt = (page) => page.evaluate(() => window.revealedAt).catch(() => 0);
const ALT_PAUSE_MILLISECONDS = 120; // between Alt going down and the letter, as typed by hand
const median = (values) => [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)];
// Every core spinning (until stopped): the machine is as busy as it gets.
function busyCpu() {
  const workers = Array.from({ length: cpus().length }, () => new Worker('for (;;) {}', { eval: true }));
  return () => Promise.all(workers.map((worker) => worker.terminate()));
}
// The page and the switcher's frame (each its own process) run SLOWDOWN times slower, until the returned function is
// called (the sessions stay attached meanwhile: Chrome drops the slowdown with the session).
const SLOWDOWN = 4;
async function slowDown(page) {
  const targets = [page.target(), ...browser.targets().filter((target) => target.url().includes('markup/switcher.html'))];
  const sessions = [];
  for (const target of targets) {
    try { const session = await target.createCDPSession(); await session.send('Emulation.setCPUThrottlingRate', { rate: SLOWDOWN }); sessions.push(session); } catch {}
  }
  return () => Promise.all(sessions.map((session) => session.detach().catch(() => {})));
}
// As Chrome does after half a minute without events (not a crash): the next press has to start it again.
async function stopServiceWorker(page) {
  const session = await page.createCDPSession();
  await session.send('ServiceWorker.enable');
  await session.send('ServiceWorker.stopAllWorkers');
  await session.detach();
  await sleep(300);
}

// Opens the switcher OPENS times (Alt+E over a page) and times each open; `search` types into it once open.
async function measureOpens({ load = false, coldWorker = false, search = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${server.main}/p/Start`);
  await page.bringToFront();
  await sleep(1500);
  const runs = [];
  for (let open = 0; open < OPENS; open++) {
    await sleep(3000); // reading the page a while: its screenshot is no longer fresh
    if (coldWorker) await stopServiceWorker(page);
    const stop = load ? busyCpu() : null;
    const speedUp = load ? await slowDown(page) : null;
    if (load) await sleep(500);
    await watchReveal(page);
    await page.keyboard.down('Alt');
    await sleep(ALT_PAUSE_MILLISECONDS);
    const pressed = Date.now();
    await page.keyboard.press('KeyE'); await page.keyboard.up('Alt');
    let frame = null, popup = null, times = {}, onScreen = 0;
    for (let wait = 0; wait < 300 && !onScreen; wait++) {
      await sleep(50);
      ({ frame, popup } = await switcherFrame(page));
      if (frame) times = await measures(frame).catch(() => ({}));
      onScreen = popup ? times.visibleAt : await revealedAt(page);
    }
    if (stop) { await stop(); await speedUp(); }
    if (search && frame) { for (const character of 'page4') { await page.keyboard.type(character); await sleep(120); } times = { ...times, ...(await measures(frame)) }; }
    runs.push({ ...times, shown: onScreen ? Math.round(onScreen - pressed) : Infinity, popup: !!popup });
    if (popup) await popup.close().catch(() => {});
    else { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); }
    await sleep(1200);
  }
  await page.close();
  const pick = (name) => median(runs.map((times) => times[name] ?? Infinity));
  return { shown: pick('shown'), module: pick('module'), render: pick('render'), search: search ? pick('search') : undefined, each: runs.map((times) => times.shown + (times.popup ? ' (window)' : '')) };
}

describe('performance', () => {
  it(`opens with ${TABS} tabs and their previews, and searches, within the budgets (idle machine)`, async () => {
    const result = await measureOpens({ search: true });
    console.log('Tabazing, idle (median of', OPENS, 'opens, milliseconds):', JSON.stringify(result));
    for (const [name, budget] of Object.entries(IDLE_BUDGET)) expect(result[name], name).toBeLessThan(budget);
    // The page Tabazing was opened over was captured as it opened, by the service worker: as WebP.
    const startPreview = await extensionPage.evaluate((url) => chrome.storage.local.get('pv:' + url).then((stored) => stored['pv:' + url]), `${server.main}/p/Start`);
    expect(startPreview && startPreview.img.slice(0, 23)).toBe('data:image/webp;base64,');
  }, 180_000);

  it('still opens on a loaded machine', async () => {
    const result = await measureOpens({ load: true });
    console.log('Tabazing, loaded (median of', OPENS, 'opens, milliseconds):', JSON.stringify(result));
    expect(result.shown).toBeLessThan(LOADED_BUDGET);
  }, 180_000);

  it('still opens on a loaded machine with the background asleep', async () => {
    const result = await measureOpens({ load: true, coldWorker: true });
    console.log('Tabazing, loaded, background asleep (median of', OPENS, 'opens, milliseconds):', JSON.stringify(result));
    expect(result.shown).toBeLessThan(LOADED_BUDGET);
  }, 180_000);
});
