// Tabazing in real Firefox, as in Chrome: over a page (the overlay, whose frame Firefox gives only a content script's
// APIs: utils/api-bridge.js), Alt+E / Alt+Q / Alt+W, clicks (the overlay's host vouches that it is visible), search,
// closing and Undo, the command palette, and its own window on pages no extension may enter.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers } from '../helpers/harness.js';
import { launchFirefox, sleep } from '../helpers/firefox.js';

let servers, browser, extension;
const pages = [];
beforeAll(async () => {
  servers = await startServers();
  ({ browser, extension } = await launchFirefox());
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${servers.main}/p/${name}`);
    pages.push(page);
  }
  await pages[3].bringToFront();
  await sleep(2500);
}, 120_000);
afterAll(async () => { await browser?.close(); await servers?.close(); });

// The tab Firefox shows (headless Firefox doesn't always tell a page it is shown when an extension switches to it), and its page.
const activeTab = () => extension.run(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab && { title: tab.title, url: tab.url }));
const visiblePage = async () => { const tab = await activeTab(); return pages.find((page) => tab && page.url() === tab.url) || null; };
const activeTitle = async () => (await activeTab())?.title;
async function altKey(page, code, holdMilliseconds = 100) { await page.keyboard.down('Alt'); await page.keyboard.press(code); await sleep(holdMilliseconds); await page.keyboard.up('Alt'); }
// Alt+E over the page shown; resolves to { page, frame } once the switcher shows.
async function openOver() {
  const page = await visiblePage();
  await altKey(page, 'KeyE');
  let frame = null;
  for (let wait = 0; wait < 60 && !frame; wait++) {
    await sleep(100);
    const candidate = await extension.overlayFrame(page);
    if (candidate && await page.evaluate(() => document.querySelector('[data-testid="overlay-frame"]')?.style.visibility === 'visible')) frame = candidate;
  }
  await sleep(400);
  return { page, frame };
}
const cardTitles = (frame) => frame.evaluate(() => [...document.querySelectorAll('[data-testid="open-grid"] [data-testid="card-tab"] [data-testid="card-title"]')].map((title) => title.textContent));
const selectedTitle = (frame) => frame.evaluate(() => document.querySelector('[data-testid="scroller"] [aria-selected="true"] [data-testid="card-title"]')?.textContent);
const overlayShown = (page) => page.evaluate(() => document.querySelector('[data-testid="overlay-frame"]')?.style.visibility === 'visible');

describe('Tabazing in Firefox', () => {
  it('Alt+E opens it over the page: every tab a card, the current one selected; Esc closes it', async () => {
    const { page, frame } = await openOver();
    expect(frame).not.toBe(null);
    expect(await cardTitles(frame)).toEqual(expect.arrayContaining(['Alpha', 'Bravo', 'Charlie', 'Delta'])); // (and Firefox's first tab)
    expect(await selectedTitle(frame)).toBe('Delta');
    await page.keyboard.press('Escape');
    await sleep(500);
    expect(await overlayShown(page)).toBe(false);
  });

  it('Alt+W, held or tapped, goes to the tab used before; Alt+Q to the one used longest ago', async () => {
    const order = ['Delta', 'Charlie', 'Bravo', 'Alpha']; // by recent use (each loaded after the one before)
    const outcomes = [];
    let used = [...order];
    for (const [code, hold] of [['KeyW', 600], ['KeyW', 30], ['KeyQ', 600], ['KeyQ', 30]]) {
      const expected = code === 'KeyW' ? used[1] : used[used.length - 1];
      const page = await visiblePage();
      if (!page) { outcomes.push('no page for ' + JSON.stringify(await activeTab()) + ' (expected ' + expected + ')'); break; }
      const before = await activeTitle();
      await altKey(page, code, hold);
      let landed = before;
      for (let wait = 0; wait < 40 && landed === before; wait++) { await sleep(100); landed = (await activeTitle()) || before; }
      outcomes.push(`${code} ${hold} ms: ${landed}${landed === expected ? '' : ` (expected ${expected})`}`);
      used = [landed, ...used.filter((title) => title !== landed)];
      await sleep(1500);
    }
    expect(outcomes.filter((outcome) => outcome.includes('expected')), outcomes.join('\n')).toEqual([]);
  });

  it('a click on a card switches to it (the page’s host vouches that the overlay is visible)', async () => {
    const { page, frame } = await openOver();
    const current = await activeTitle();
    const target = (await cardTitles(frame)).find((title) => title !== current && ['Alpha', 'Bravo', 'Charlie', 'Delta'].includes(title));
    const bounds = await frame.evaluate((title) => {
      const card = [...document.querySelectorAll('[data-testid="card-tab"]')].find((element) => element.querySelector('[data-testid="card-title"]').textContent === title);
      const box = card.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }, target);
    await sleep(500); // (clicks count once it has been visible a moment)
    await page.mouse.click(bounds.x, bounds.y);
    await sleep(1500);
    expect(await activeTitle()).toBe(target);
  });

  it('typing searches; Enter switches to what it found', async () => {
    const { page } = await openOver();
    await page.keyboard.type('brav');
    await sleep(400);
    await page.keyboard.press('Enter');
    await sleep(1500);
    expect(await activeTitle()).toBe('Bravo');
  });

  it('Delete closes the selected tab; Ctrl+Z brings it back', async () => {
    const { page, frame } = await openOver();
    const selected = await selectedTitle(frame); // (Alt+E: the current tab; the next card is closed instead)
    await page.keyboard.press('ArrowRight');
    await sleep(200);
    const closing = await selectedTitle(frame);
    expect(closing).not.toBe(selected);
    await page.keyboard.press('Delete');
    await sleep(800);
    const titlesAfter = await extension.run(() => chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.title)));
    expect(titlesAfter).not.toContain(closing);
    expect(await overlayShown(page)).toBe(true); // (Tabazing stays)
    await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
    await sleep(1500);
    expect(await extension.run(() => chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.title)))).toContain(closing);
    expect(await overlayShown(page)).toBe(true);
    await page.keyboard.press('Escape');
    await sleep(500);
  });

  it('Alt+R opens the command palette; typing finds an action', async () => {
    const page = await visiblePage();
    await altKey(page, 'KeyR');
    await sleep(1500);
    const frame = await extension.overlayFrame(page);
    expect(await frame.evaluate(() => !document.querySelector('[data-testid="palette"]').hidden)).toBe(true);
    await page.keyboard.type('shortcuts');
    await sleep(400);
    expect(await frame.evaluate(() => [...document.querySelectorAll('[data-testid="palette-row-action"]')].map((row) => row.dataset.action))).toContain('chrome-shortcuts');
    await page.keyboard.press('Escape');
    await sleep(500);
  });

  it('where no extension may go (about:blank), it opens in its own window, and works there', async () => {
    const blank = await browser.newPage();
    await blank.goto('about:blank');
    pages.push(blank);
    await blank.bringToFront();
    await sleep(1000);
    await blank.keyboard.down('Alt'); await blank.keyboard.press('KeyE'); await blank.keyboard.up('Alt'); // (hotkey.js runs on about:blank too)
    let window = null;
    for (let wait = 0; wait < 50 && !window; wait++) { await sleep(100); window = await extension.switcherWindow(); }
    expect(window).not.toBe(null);
    await sleep(800);
    expect(await window.evaluate(() => document.querySelectorAll('[data-testid="card-tab"]').length)).toBeGreaterThan(3);
    // (Firefox lets no test type into an extension's window: a click on a card, as the mouse does)
    await window.evaluate(() => [...document.querySelectorAll('[data-testid="card-tab"]')].find((card) => card.querySelector('[data-testid="card-title"]').textContent === 'Alpha').click());
    await sleep(1500);
    expect(await activeTitle()).toBe('Alpha');
    expect(await extension.switcherWindow()).toBe(null);
  });
});
