// The switcher's layout in real Chrome, where jsdom applies no CSS: a long search without spaces stays inside its
// results, the selected card stays clear of the floating actions bar while ticking, and the search box's hint fits
// in the long languages.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch, sleep } from './helpers/harness.js';

let servers, browser, extension;
beforeAll(async () => {
  servers = await startServers();
  ({ browser, extension } = await launch());
  const extensionPage = await extension.extensionPage();
  const urls = Array.from({ length: 40 }, (unused, i) => `${servers.main}/p/Page${i}`);
  await extensionPage.evaluate((list) => Promise.all(list.map((url) => chrome.tabs.create({ url, active: false }))), urls);
  await extensionPage.close();
}, 120_000);
afterAll(async () => { await browser?.close(); await servers?.close(); });

const switcherFrame = (page) => page.frames().find((frame) => frame.url().includes('markup/switcher.html'));
// Opens the switcher (Alt+E) over a fresh page, with these settings; resolves to { page, frame } once it is drawn.
async function openSwitcher(preferences = {}) {
  await extension.run((prefs) => chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true }, prefs }), preferences);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${servers.main}/p/Start`);
  await page.bringToFront();
  await sleep(1500);
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyE'); await page.keyboard.up('Alt');
  let frame = null;
  for (let wait = 0; wait < 100; wait++) {
    await sleep(50);
    frame = switcherFrame(page);
    if (frame && await frame.evaluate(() => document.documentElement.classList.contains('overlay') && !document.querySelector('[data-testid="app"]').hidden).catch(() => false)) break;
  }
  await sleep(300);
  return { page, frame };
}

describe('layout in Chrome', () => {
  it('a long search without spaces stays inside its results', async () => {
    const { page, frame } = await openSwitcher();
    await page.keyboard.type('x'.repeat(250));
    await sleep(300);
    const [scrollWidth, clientWidth] = await frame.evaluate(() => { const element = document.querySelector('[data-testid="search-dropdown"]'); return [element.scrollWidth, element.clientWidth]; });
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    await page.close();
  });

  it('while ticking, the selected card stays clear of the actions bar', async () => {
    const { page, frame } = await openSwitcher({ cardSize: 'list' });
    await page.keyboard.down('Control'); await page.keyboard.press('Space'); await page.keyboard.up('Control');
    await page.keyboard.down('Shift');
    for (let i = 0; i < 12; i++) { await page.keyboard.press('ArrowDown'); await sleep(60); }
    await page.keyboard.up('Shift');
    await sleep(400);
    const { cardBottom, barTop } = await frame.evaluate(() => ({
      cardBottom: document.querySelector('[data-testid="scroller"] [aria-selected="true"]').getBoundingClientRect().bottom, // (a tab's card, or a closed one further down)
      barTop: document.querySelector('[data-testid="actions"]').getBoundingClientRect().top,
    }));
    expect(cardBottom).toBeLessThanOrEqual(barTop);
    await page.close();
  });

  it.each(['el', 'ar', 'de', 'ru', 'fr'])('%s: the search box’s hint fits at 1280 px', async (lang) => {
    const { page, frame } = await openSwitcher({ lang });
    const { textWidth, boxWidth } = await frame.evaluate(() => {
      const input = document.querySelector('[data-testid="search"]'), style = getComputedStyle(input);
      const context = document.createElement('canvas').getContext('2d');
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return { textWidth: context.measureText(input.placeholder).width, boxWidth: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    });
    expect(textWidth).toBeLessThanOrEqual(boxWidth);
    await page.close();
  });
});
