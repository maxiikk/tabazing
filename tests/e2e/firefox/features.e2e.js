// More of Tabazing in real Firefox: previews and site icons (Firefox has no favicon service: utils/favicons.js), tab
// groups, the History and Bookmarks views, the archive (Firefox's "Other Bookmarks" folder), the palette's Firefox pages,
// media playing in a page, and the overlay refusing clicks while the page covers it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers } from '../helpers/harness.js';
import { launchFirefox, sleep } from '../helpers/firefox.js';

// A 16 px red square, as a page's favicon.
const FAVICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4z8BAEmIY1TCqYfhqAAAz9n8B5FvG8gAAAABJRU5ErkJggg==', 'base64');
let servers, browser, extension;
const pages = {};
beforeAll(async () => {
  servers = await startServers();
  servers.serve('/fav.png', FAVICON, 'image/png');
  servers.serve('/iconic', Buffer.from('<!doctype html><meta charset="utf-8"><title>Iconic</title><link rel="icon" href="/fav.png"><body style="background:#3a7">iconic'), 'text/html; charset=utf-8');
  ({ browser, extension } = await launchFirefox());
  for (const name of ['Work1', 'Work2', 'Plain']) {
    pages[name] = await browser.newPage();
    await pages[name].setViewport({ width: 1280, height: 800 });
    await pages[name].goto(`${servers.main}/p/${name}`);
  }
  pages.Iconic = await browser.newPage();
  await pages.Iconic.setViewport({ width: 1280, height: 800 });
  await pages.Iconic.goto(`${servers.main}/iconic`);
  await sleep(2500);
}, 120_000);
afterAll(async () => { await browser?.close(); await servers?.close(); });

const activeTab = () => extension.run(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab && { id: tab.id, title: tab.title, url: tab.url }));
async function front(name) { await pages[name].bringToFront(); await sleep(1500); return pages[name]; }
async function altKey(page, code) { await page.keyboard.down('Alt'); await page.keyboard.press(code); await sleep(80); await page.keyboard.up('Alt'); }
async function openOver(page) {
  await altKey(page, 'KeyE');
  for (let wait = 0; wait < 60; wait++) {
    await sleep(100);
    const frame = await extension.overlayFrame(page);
    if (frame && await page.evaluate(() => document.querySelector('[data-testid="overlay-frame"]')?.style.visibility === 'visible')) { await sleep(400); return frame; }
  }
  throw new Error('the overlay did not show');
}
async function close(page) { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await sleep(600); }
const cardOf = (frame, title) => frame.evaluate((wanted) => {
  const card = [...document.querySelectorAll('[data-testid="scroller"] [data-testid^="card-"]')].find((element) => element.querySelector('[data-testid="card-title"]')?.textContent === wanted);
  return card ? { favicon: card.querySelector('[data-testid="card-favicon"]')?.src || '', picture: card.querySelector('[data-testid="card-thumb"] img')?.src || '', kind: card.dataset.testid } : null;
}, title);

describe('Tabazing in Firefox, feature by feature', () => {
  it('a site’s icon is kept and shown on its card (a data: picture, as the page may show no other)', async () => {
    await front('Iconic');
    await sleep(1500);
    expect(Object.keys(await extension.run(() => chrome.storage.local.get('favicons').then((stored) => stored.favicons || {})))).toContain(new URL(servers.main).host);
    const page = await front('Plain');
    const frame = await openOver(page);
    expect((await cardOf(frame, 'Iconic')).favicon).toMatch(/^data:image\/png;base64,/);
    expect((await cardOf(frame, 'Work1')).favicon).toMatch(/^data:image\//); // (the same site: one icon per site)
    await close(page);
  });

  it('a page looked at gets its preview, as in Chrome (Firefox takes the screenshot)', async () => {
    await front('Iconic');
    await sleep(2500); // (the screenshot is taken once the page has been looked at a moment)
    const page = await front('Plain');
    const frame = await openOver(page);
    expect((await cardOf(frame, 'Iconic')).picture).toMatch(/^data:image\/(webp|jpeg|png)/);
    await close(page);
  });

  it('“Capture all previews” visits the tabs without one and gives each its preview, then opens Tabazing again', async () => {
    const page = await front('Iconic');
    const frame = await openOver(page);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
    await sleep(500);
    await frame.evaluate(() => document.querySelector('[data-testid="palette-row-action"][data-action="capture-all"]').click());
    const missing = async () => extension.run(async () => {
      const tabs = (await chrome.tabs.query({})).filter((tab) => /^https?:/.test(tab.url));
      const stored = await chrome.storage.local.get(null);
      return tabs.filter((tab) => !Object.keys(stored).some((key) => key.startsWith('pv:') && key.includes(new URL(tab.url).pathname))).map((tab) => tab.title);
    });
    let left = await missing();
    for (let wait = 0; wait < 60 && left.length; wait++) { await sleep(500); left = await missing(); }
    expect(left).toEqual([]);
    await sleep(1500);
    await close(await front('Iconic'));
  });

  it('a tab group shows as one tile; Enter opens it, its tabs as cards', async () => {
    await extension.run(async () => {
      const tabs = await chrome.tabs.query({});
      const ids = tabs.filter((tab) => /Work/.test(tab.title)).map((tab) => tab.id);
      const groupId = await chrome.tabs.group({ tabIds: ids });
      await chrome.tabGroups.update(groupId, { title: 'Work', color: 'blue' });
    });
    const page = await front('Plain');
    const frame = await openOver(page);
    expect(await frame.evaluate(() => document.querySelector('[data-testid="card-group"] [data-testid="card-title"]')?.textContent)).toBe('Work');
    await frame.evaluate(() => document.querySelector('[data-testid="card-group"]').click());
    await sleep(800);
    expect(await frame.evaluate(() => [...document.querySelectorAll('[data-testid="open-grid"] [data-testid="card-tab"] [data-testid="card-title"]')].map((title) => title.textContent).sort())).toEqual(['Work1', 'Work2']);
    await close(page);
  });

  it('Ctrl+H shows Firefox’s history; Ctrl+Shift+O its bookmarks', async () => {
    await extension.run(() => chrome.bookmarks.create({ title: 'Mozilla bookmark', url: 'https://example.org/bookmarked' }));
    const page = await front('Plain');
    const frame = await openOver(page);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyH'); await page.keyboard.up('Control');
    await sleep(1200);
    const visited = await frame.evaluate(() => [...document.querySelectorAll('[data-testid="card-history"] [data-testid="card-title"], [data-testid="history-row"] [data-testid="card-title"]')].map((title) => title.textContent));
    expect(visited).toEqual(expect.arrayContaining(['Plain']));
    await page.keyboard.press('Escape');
    await sleep(400);
    await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyO'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
    await sleep(1200);
    expect(await frame.evaluate(() => document.body.textContent.includes('Mozilla bookmark'))).toBe(true);
    await close(page);
  });

  it('archiving a tab bookmarks it in Firefox’s Other Bookmarks, in “Tabs Archive”, and closes it', async () => {
    const page = await front('Iconic');
    const frame = await openOver(page);
    await frame.evaluate(() => {
      const card = [...document.querySelectorAll('[data-testid="card-tab"]')].find((element) => element.querySelector('[data-testid="card-title"]').textContent === 'Plain');
      card.querySelector('[data-testid="quick-archive"]').click();
    });
    await sleep(1500);
    const archive = await extension.run(async () => {
      const [unfiled] = await chrome.bookmarks.getSubTree('unfiled_____');
      const folder = (unfiled.children || []).find((node) => node.title === 'Tabs Archive');
      return folder ? folder.children.map((node) => node.url) : null;
    });
    expect(archive).toEqual([expect.stringContaining('/p/Plain')]);
    expect(await extension.run(() => chrome.tabs.query({}).then((tabs) => tabs.some((tab) => tab.title === 'Plain')))).toBe(false);
    await close(page);
  });

  it('the palette offers only what Firefox lets an extension open: its shortcuts dialog, and Tabazing’s own History', async () => {
    const page = await front('Iconic');
    const frame = await openOver(page);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
    await sleep(500);
    const offered = await frame.evaluate(() => [...document.querySelectorAll('[data-testid="palette-row-action"]')].map((row) => row.dataset.action));
    expect(offered).toContain('chrome-shortcuts');
    expect(offered).toContain('history');
    for (const hidden of ['chrome-settings', 'downloads', 'passwords', 'clear-data', 'extensions']) expect(offered).not.toContain(hidden); // (about: pages: illegal for an extension)
    await page.keyboard.type('history');
    await sleep(400);
    await frame.evaluate(() => document.querySelector('[data-testid="palette-row-action"][data-action="history"]').click());
    await sleep(1200);
    expect(await frame.evaluate(() => !!document.querySelector('[data-testid="history-overlay"]'))).toBe(true);
    await close(page);
  });

  it('a page covering the overlay (its own popover over it) gets no click through: the click is refused', async () => {
    const page = await front('Iconic');
    const frame = await openOver(page);
    const before = (await activeTab()).title;
    await page.evaluate(() => { // the page draws something on top of the overlay's frame
      const cover = document.createElement('div');
      cover.popover = 'manual';
      cover.style.cssText = 'position:fixed;inset:0;margin:0;width:100vw;height:100vh;opacity:0;border:0';
      document.body.append(cover);
      cover.showPopover();
    });
    await sleep(600);
    const shown = await frame.evaluate(() => { const card = document.querySelectorAll('[data-testid="open-grid"] [data-testid="card-tab"], [data-testid="open-grid"] [data-testid="card-group"]')[1].getBoundingClientRect(); return { x: card.x + card.width / 2, y: card.y + card.height / 2 }; });
    await page.mouse.click(shown.x, shown.y);
    await sleep(1200);
    expect((await activeTab()).title).toBe(before);
  });
});
