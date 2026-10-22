// Right to left in real Chrome (jsdom applies no CSS): in Hebrew the switcher is mirrored. The cards run from the
// right, the menu button is at the top right and its drawer slides in from there, Settings has its categories on
// the right, and ← goes to the next card; an English title keeps its punctuation in place ("Hello, world!", not
// "!Hello, world") and still lines up on the right. In English, all of it is back on the left.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch, sleep } from './helpers/harness.js';

let srv, browser, ext;
beforeAll(async () => {
  srv = await startServers();
  ({ browser, ext } = await launch());
  await ext.run(() => chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } })); // no tour over the switcher
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    const p = await browser.newPage();
    await p.goto(`${srv.main}/p/${name}`);
  }
  srv.serve('/hello', Buffer.from('<!doctype html><meta charset="utf-8"><title>Hello, world!</title><body>x</body>'), 'text/html; charset=utf-8');
  await (await browser.newPage()).goto(`${srv.main}/hello`);
});
afterAll(async () => { await browser?.close(); await srv?.close(); });

const frameOf = (page) => page.frames().find((f) => f.url().includes('markup/switcher.html'));
async function openSwitcher(lang) {
  await ext.run((l) => chrome.storage.local.set({ prefs: { lang: l } }), lang);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${srv.main}/p/Home`);
  await page.bringToFront();
  await sleep(1500);
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyE'); await page.keyboard.up('Alt');
  await sleep(1500);
  const f = frameOf(page);
  for (let i = 0; i < 3; i++) if (await f.evaluate(() => !!document.querySelector('[data-testid="modal"]:not([hidden])'))) { await page.keyboard.press('Escape'); await sleep(400); }
  return { page, f };
}
const box = (f, id) => f.evaluate((id) => {
  const r = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
  return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right), vw: innerWidth };
}, id);
const cards = (f) => f.evaluate(() => [...document.querySelectorAll('[data-testid="card-tab"]')].map((c) => Math.round(c.getBoundingClientRect().x)));
const selectedIndex = (f) => f.evaluate(() => [...document.querySelectorAll('[data-testid="card-tab"]')].findIndex((c) => c.getAttribute('aria-selected') === 'true'));

describe('right to left', () => {
  it('Hebrew: mirrored cards, header, menu and Settings; ← is the next card', async () => {
    const { page, f } = await openSwitcher('he');
    expect(await f.evaluate(() => [document.documentElement.lang, document.documentElement.dir])).toEqual(['he', 'rtl']);
    const xs = await cards(f);
    expect(xs.length).toBeGreaterThanOrEqual(3);
    expect(xs[0]).toBeGreaterThan(xs[1]); // the first card on the right, the next to its left
    expect(xs[1]).toBeGreaterThan(xs[2]);
    const menu = await box(f, 'menu-btn'), keys = await box(f, 'keys-btn');
    expect(menu.x).toBeGreaterThan(menu.vw / 2); // ☰ at the top right
    expect(keys.x).toBeLessThan(keys.vw / 2); // ⓘ and GitHub at the top left
    // The card's title "Hello, world!": "!" drawn after (right of) the "H", the text against the title box's right side.
    const hello = await f.evaluate(() => {
      const title = [...document.querySelectorAll('[data-testid="card-title"]')].find((n) => n.textContent === 'Hello, world!');
      const at = (i) => { const r = document.createRange(); r.setStart(title.firstChild, i); r.setEnd(title.firstChild, i + 1); return r.getBoundingClientRect(); };
      const box = title.getBoundingClientRect(), all = document.createRange();
      all.selectNodeContents(title);
      return { h: at(0).x, bang: at(12).x, textRight: all.getBoundingClientRect().right, boxRight: box.right };
    });
    expect(hello.bang).toBeGreaterThan(hello.h);
    expect(Math.abs(hello.textRight - hello.boxRight)).toBeLessThanOrEqual(2);
    const before = await selectedIndex(f);
    await page.keyboard.press('ArrowLeft');
    await sleep(200);
    expect(await selectedIndex(f)).toBe(before + 1);
    await page.keyboard.press('ArrowRight');
    await sleep(200);
    expect(await selectedIndex(f)).toBe(before);

    await (await f.$('[data-testid="menu-btn"]')).click();
    await sleep(600);
    const drawer = await box(f, 'drawer');
    expect(drawer.right).toBe(drawer.vw); // slid in from the right edge
    await (await f.$('[data-testid="settings-btn"]')).click();
    await sleep(600);
    const panel = await box(f, 'settings'), cat = await box(f, 'settings-tab-look');
    expect(cat.x + cat.w / 2).toBeGreaterThan(panel.x + panel.w / 2); // the categories down the right
    await page.close();
  });

  it('English: everything back on the left', async () => {
    const { page, f } = await openSwitcher('en');
    expect(await f.evaluate(() => document.documentElement.dir)).toBe('ltr');
    const xs = await cards(f);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect((await box(f, 'menu-btn')).x).toBeLessThan(640);
    await (await f.$('[data-testid="menu-btn"]')).click();
    await sleep(600);
    expect((await box(f, 'drawer')).x).toBe(0);
    await page.close();
  });
});
