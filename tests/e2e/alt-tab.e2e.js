// Alt+Q / Alt+W in real Chrome, as Alt+Tab: held a moment or tapped, letting go of Alt switches to the selected
// tab; Alt+W goes to the tab used just before this one, Alt+Q to the one used longest ago (the card before the
// current tab, from the end). Each page keeps a switcher prepared ahead, drawn while the tabs were in another
// order: once, it started from that old order and landed on the wrong tab most of the time.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch, sleep } from './helpers/harness.js';

const TABS = 5;
let servers, browser;
const pages = [];
beforeAll(async () => {
  servers = await startServers();
  let extension;
  ({ browser, extension } = await launch());
  for (const page of await browser.pages()) if (page.url() === 'about:blank') await page.close();
  const extensionPage = await extension.extensionPage();
  await extensionPage.evaluate(() => chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } })); // no tour over the switcher
  for (let i = 0; i < TABS; i++) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${servers.main}/p/Page${i}`);
    pages.push(page);
  }
  await extensionPage.close();
  await pages[TABS - 1].bringToFront();
  await sleep(2000);
});
afterAll(async () => { await browser?.close(); await servers?.close(); });

async function shownPage() {
  for (const page of pages) if (await page.evaluate(() => document.visibilityState === 'visible').catch(() => false)) return page;
  return null;
}
// Alt+`code`, Alt held `holdMilliseconds`; resolves to the title of the tab shown afterwards (once it changed, or after 2 s).
async function press(code, holdMilliseconds) {
  const page = await shownPage();
  const before = await page.title();
  await page.keyboard.down('Alt'); await page.keyboard.press(code); await sleep(holdMilliseconds); await page.keyboard.up('Alt');
  for (let wait = 0; wait < 40; wait++) {
    await sleep(50);
    const shown = await shownPage();
    const title = shown ? await shown.title() : '';
    if (title !== before) return title;
  }
  return before;
}

describe('Alt+Q / Alt+W in Chrome', () => {
  it('held or tapped, quickly one after another or not, each lands on the tab it should', async () => {
    let order = Array.from({ length: TABS }, (unused, i) => `Page${TABS - 1 - i}`); // by recent use: Page4 (shown) first
    const presses = [['KeyW', 600], ['KeyQ', 600], ['KeyW', 30], ['KeyQ', 30]];
    const pauses = [300, 1500, 3000];
    const outcomes = [];
    for (const pause of pauses) {
      for (const [code, holdMilliseconds] of presses) {
        const expected = code === 'KeyW' ? order[1] : order[order.length - 1];
        const landed = await press(code, holdMilliseconds);
        outcomes.push(`${code} held ${holdMilliseconds} ms after ${pause} ms: ${landed}${landed === expected ? '' : ` (expected ${expected})`}`);
        order = [landed, ...order.filter((title) => title !== landed)];
        await sleep(pause);
      }
    }
    expect(outcomes.filter((outcome) => outcome.includes('expected')), outcomes.join('\n')).toEqual([]);
  }, 120_000);
});
