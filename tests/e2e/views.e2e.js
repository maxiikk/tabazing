// The History and Bookmarks views in real Chrome, where jsdom can't follow: Ctrl+H and Ctrl+Shift+O reach the switcher
// (Chrome lets a page have them); removing a history page and its Undo (Chrome refuses a title and a time in
// history.addUrl on some versions, by throwing at once); dragging a bookmark onto a folder (native drag and drop).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch, sleep } from './helpers/harness.js';

let server, browser, extension;
beforeAll(async () => {
  server = await startServers();
  ({ browser, extension } = await launch());
  await extension.run(() => chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } })); // no tour over the switcher
});
afterAll(async () => { await browser?.close(); await server?.close(); });

const frameOf = (page) => page.frames().find((frame) => frame.url().includes('markup/switcher.html'));
async function openSwitcher(name) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${server.main}/p/${name}`);
  await page.bringToFront();
  await sleep(1500);
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyE'); await page.keyboard.up('Alt');
  await sleep(1500);
  const frame = frameOf(page);
  // a first-run card may still come: dismiss it
  for (let i = 0; i < 3; i++) if (await frame.evaluate(() => !!document.querySelector('[data-testid="modal"]:not([hidden])'))) { await page.keyboard.press('Escape'); await sleep(400); }
  return { page, f: frame };
}
const chord = async (page, keys) => { for (const keyName of keys) await page.keyboard.down(keyName); for (const keyName of [...keys].reverse()) await page.keyboard.up(keyName); };

describe('the History and Bookmarks views in Chrome', () => {
  it('Ctrl+H opens the history; a removed page comes back with Undo', async () => {
    await extension.run(async (base) => { for (const pageName of ['One', 'Two']) await chrome.history.addUrl({ url: `${base}/p/${pageName}` }); }, server.main);
    const { page, f: frame } = await openSwitcher('Home');
    await chord(page, ['Control', 'KeyH']);
    await sleep(1200);
    expect(await frame.evaluate(() => !!document.querySelector('[data-testid="history-overlay"]'))).toBe(true);
    const url = `${server.main}/p/Two`;
    await frame.evaluate((url) => {
      const row = [...document.querySelectorAll('[data-testid="card-history"]')].find((entry) => entry.title.includes(url));
      row.querySelector('[data-testid="card-history-remove"]').click();
    }, url);
    await sleep(800);
    expect(await extension.run((url) => chrome.history.search({ text: '', startTime: 0, maxResults: 100 }).then((x) => x.some((entry) => entry.url === url)), url)).toBe(false);
    await frame.evaluate(() => document.querySelector('[data-testid="toast-action"]').click());
    await sleep(800);
    expect(await extension.run((url) => chrome.history.search({ text: '', startTime: 0, maxResults: 100 }).then((x) => x.some((entry) => entry.url === url)), url)).toBe(true);
    await page.close();
  });

  it('Ctrl+Shift+O opens the bookmarks; a bookmark dragged onto a folder goes into it', async () => {
    const bookmarkIds = await extension.run(async (base) => {
      const folder = await chrome.bookmarks.create({ parentId: '1', title: 'Drop here' });
      const mark = await chrome.bookmarks.create({ parentId: '1', title: 'Drag me', url: `${base}/p/Drag` });
      return { folder: folder.id, mark: mark.id };
    }, server.main);
    const { page, f: frame } = await openSwitcher('Home');
    await chord(page, ['Control', 'Shift', 'KeyO']);
    await sleep(1200);
    expect(await frame.evaluate(() => !!document.querySelector('[data-testid="bookmarks-overlay"]'))).toBe(true);
    const at = (id) => frame.evaluate((id) => { const bounds = document.getElementById('bookmarks-view-' + id).getBoundingClientRect(); return { x: bounds.x + 260, y: bounds.y + bounds.height / 2 }; }, id);
    await page.setDragInterception(true);
    await page.mouse.dragAndDrop(await at(bookmarkIds.mark), await at(bookmarkIds.folder), { delay: 100 });
    await sleep(1000);
    expect(await extension.run((bookmarkIds) => chrome.bookmarks.get(bookmarkIds.mark).then(([bookmark]) => bookmark.parentId), bookmarkIds)).toBe(bookmarkIds.folder);
    await page.close();
  });

  it('a tab dragged onto a tab group tile joins the group, in the default order (by recent use)', async () => {
    const pages = [];
    for (const pageName of ['Loose', 'G1', 'G2']) { const tabPage = await browser.newPage(); await tabPage.goto(`${server.main}/p/${pageName}`); pages.push(tabPage); }
    const groupId = await extension.run(async () => {
      const tabIds = (await chrome.tabs.query({})).filter((tab) => /\/p\/G\d/.test(tab.url)).map((tab) => tab.id);
      const id = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(id, { title: 'Drop group', color: 'green' });
      return id;
    });
    const { page, f: frame } = await openSwitcher('Home2');
    const at = (selector) => frame.evaluate((selector) => { const element = selector === 'tile' ? document.querySelector('[data-testid="card-group"]') : [...document.querySelectorAll('[data-testid="card-tab"]')].find((candidate) => candidate.querySelector('[data-testid="card-title"]').textContent === 'Loose'); const bounds = element.getBoundingClientRect(); return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }; }, selector);
    await page.setDragInterception(true);
    await page.mouse.dragAndDrop(await at('tab'), await at('tile'), { delay: 100 });
    await sleep(1200);
    expect(await extension.run(async () => (await chrome.tabs.query({ title: 'Loose' }))[0].groupId)).toBe(groupId);
    for (const tabPage of pages) await tabPage.close().catch(() => {});
    await page.close();
  });
});
