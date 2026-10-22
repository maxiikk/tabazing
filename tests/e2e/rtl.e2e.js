// Right to left in real Chrome (jsdom applies no CSS): in Hebrew the switcher is mirrored. The cards run from the
// right, the menu button is at the top right and its drawer slides in from there, Settings has its categories on
// the right, and ← goes to the next card; an English title keeps its punctuation in place ("Hello, world!", not
// "!Hello, world") and still lines up on the right. In English, all of it is back on the left.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch, sleep } from './helpers/harness.js';

let server, browser, extension;
beforeAll(async () => {
  server = await startServers();
  ({ browser, extension } = await launch());
  await extension.run(() => chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } })); // no tour over the switcher
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    const seedPage = await browser.newPage();
    await seedPage.goto(`${server.main}/p/${name}`);
  }
  server.serve('/hello', Buffer.from('<!doctype html><meta charset="utf-8"><title>Hello, world!</title><body>x</body>'), 'text/html; charset=utf-8');
  await (await browser.newPage()).goto(`${server.main}/hello`);
});
afterAll(async () => { await browser?.close(); await server?.close(); });

const frameOf = (page) => page.frames().find((frame) => frame.url().includes('markup/switcher.html'));
async function openSwitcher(lang) {
  await extension.run((lang) => chrome.storage.local.set({ prefs: { lang } }), lang);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${server.main}/p/Home`);
  await page.bringToFront();
  await sleep(1500);
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyE'); await page.keyboard.up('Alt');
  await sleep(1500);
  const frame = frameOf(page);
  for (let i = 0; i < 3; i++) if (await frame.evaluate(() => !!document.querySelector('[data-testid="modal"]:not([hidden])'))) { await page.keyboard.press('Escape'); await sleep(400); }
  return { page, f: frame };
}
const box = (frame, id) => frame.evaluate((id) => {
  const bounds = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
  return { x: Math.round(bounds.x), w: Math.round(bounds.width), right: Math.round(bounds.right), vw: innerWidth };
}, id);
const cards = (frame) => frame.evaluate(() => [...document.querySelectorAll('[data-testid="card-tab"]')].map((element) => Math.round(element.getBoundingClientRect().x)));
const selectedIndex = (frame) => frame.evaluate(() => [...document.querySelectorAll('[data-testid="card-tab"]')].findIndex((element) => element.getAttribute('aria-selected') === 'true'));

describe('right to left', () => {
  it('Hebrew: mirrored cards, header, menu and Settings; ← is the next card', async () => {
    const { page, f: frame } = await openSwitcher('he');
    expect(await frame.evaluate(() => [document.documentElement.lang, document.documentElement.dir])).toEqual(['he', 'rtl']);
    const xPositions = await cards(frame);
    expect(xPositions.length).toBeGreaterThanOrEqual(3);
    expect(xPositions[0]).toBeGreaterThan(xPositions[1]); // the first card on the right, the next to its left
    expect(xPositions[1]).toBeGreaterThan(xPositions[2]);
    const menu = await box(frame, 'menu-button'), keys = await box(frame, 'keys-button');
    expect(menu.x).toBeGreaterThan(menu.vw / 2); // ☰ at the top right
    expect(keys.x).toBeLessThan(keys.vw / 2); // ⓘ and GitHub at the top left
    // The card's title "Hello, world!": "!" drawn after (right of) the "H", the text against the title box's right side.
    const hello = await frame.evaluate(() => {
      const title = [...document.querySelectorAll('[data-testid="card-title"]')].find((element) => element.textContent === 'Hello, world!');
      const at = (i) => { const range = document.createRange(); range.setStart(title.firstChild, i); range.setEnd(title.firstChild, i + 1); return range.getBoundingClientRect(); };
      const box = title.getBoundingClientRect(), all = document.createRange();
      all.selectNodeContents(title);
      return { h: at(0).x, bang: at(12).x, textRight: all.getBoundingClientRect().right, boxRight: box.right };
    });
    expect(hello.bang).toBeGreaterThan(hello.h);
    expect(Math.abs(hello.textRight - hello.boxRight)).toBeLessThanOrEqual(2);
    const before = await selectedIndex(frame);
    await page.keyboard.press('ArrowLeft');
    await sleep(200);
    expect(await selectedIndex(frame)).toBe(before + 1);
    await page.keyboard.press('ArrowRight');
    await sleep(200);
    expect(await selectedIndex(frame)).toBe(before);

    await (await frame.$('[data-testid="menu-button"]')).click();
    await sleep(600);
    const drawer = await box(frame, 'drawer');
    expect(drawer.right).toBe(drawer.vw); // slid in from the right edge
    await (await frame.$('[data-testid="settings-button"]')).click();
    await sleep(600);
    const panel = await box(frame, 'settings'), category = await box(frame, 'settings-tab-look');
    expect(category.x + category.w / 2).toBeGreaterThan(panel.x + panel.w / 2); // the categories down the right
    await page.close();
  });

  it('English: everything back on the left', async () => {
    const { page, f: frame } = await openSwitcher('en');
    expect(await frame.evaluate(() => document.documentElement.dir)).toBe('ltr');
    const xPositions = await cards(frame);
    expect(xPositions[0]).toBeLessThan(xPositions[1]);
    expect((await box(frame, 'menu-button')).x).toBeLessThan(640);
    await (await frame.$('[data-testid="menu-button"]')).click();
    await sleep(600);
    expect((await box(frame, 'drawer')).x).toBe(0);
    await page.close();
  });
});
