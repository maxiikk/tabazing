// The History and Bookmarks views in real Chrome, where jsdom can't follow: Ctrl+H and Ctrl+Shift+O reach the switcher
// (Chrome lets a page have them); removing a history page and its Undo (Chrome refuses a title and a time in
// history.addUrl on some versions, by throwing at once); dragging a bookmark onto a folder (native drag and drop).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch, sleep } from './harness.js';

let srv, browser, ext;
beforeAll(async () => {
  srv = await startServers();
  ({ browser, ext } = await launch());
  await ext.run(() => chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } })); // no tour over the switcher
});
afterAll(async () => { await browser?.close(); await srv?.close(); });

const frameOf = (page) => page.frames().find((f) => f.url().includes('markup/switcher.html'));
async function openSwitcher(name) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${srv.main}/p/${name}`);
  await page.bringToFront();
  await sleep(1500);
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyE'); await page.keyboard.up('Alt');
  await sleep(1500);
  const f = frameOf(page);
  // a first-run card may still come: dismiss it
  for (let i = 0; i < 3; i++) if (await f.evaluate(() => !!document.querySelector('[data-testid="modal"]:not([hidden])'))) { await page.keyboard.press('Escape'); await sleep(400); }
  return { page, f };
}
const chord = async (page, keys) => { for (const k of keys) await page.keyboard.down(k); for (const k of [...keys].reverse()) await page.keyboard.up(k); };

describe('the History and Bookmarks views in Chrome', () => {
  it('Ctrl+H opens the history; a removed page comes back with Undo', async () => {
    await ext.run(async (base) => { for (const n of ['One', 'Two']) await chrome.history.addUrl({ url: `${base}/p/${n}` }); }, srv.main);
    const { page, f } = await openSwitcher('Home');
    await chord(page, ['Control', 'KeyH']);
    await sleep(1200);
    expect(await f.evaluate(() => !!document.querySelector('[data-testid="history-overlay"]'))).toBe(true);
    const url = `${srv.main}/p/Two`;
    await f.evaluate((url) => {
      const row = [...document.querySelectorAll('[data-testid="card-history"]')].find((r) => r.title.includes(url));
      row.querySelector('[data-testid="card-history-remove"]').click();
    }, url);
    await sleep(800);
    expect(await ext.run((url) => chrome.history.search({ text: '', startTime: 0, maxResults: 100 }).then((x) => x.some((v) => v.url === url)), url)).toBe(false);
    await f.evaluate(() => document.querySelector('[data-testid="toast-action"]').click());
    await sleep(800);
    expect(await ext.run((url) => chrome.history.search({ text: '', startTime: 0, maxResults: 100 }).then((x) => x.some((v) => v.url === url)), url)).toBe(true);
    await page.close();
  });

  it('Ctrl+Shift+O opens the bookmarks; a bookmark dragged onto a folder goes into it', async () => {
    const ids = await ext.run(async (base) => {
      const folder = await chrome.bookmarks.create({ parentId: '1', title: 'Drop here' });
      const mark = await chrome.bookmarks.create({ parentId: '1', title: 'Drag me', url: `${base}/p/Drag` });
      return { folder: folder.id, mark: mark.id };
    }, srv.main);
    const { page, f } = await openSwitcher('Home');
    await chord(page, ['Control', 'Shift', 'KeyO']);
    await sleep(1200);
    expect(await f.evaluate(() => !!document.querySelector('[data-testid="bookmarks-overlay"]'))).toBe(true);
    const at = (id) => f.evaluate((id) => { const b = document.getElementById('bmv-' + id).getBoundingClientRect(); return { x: b.x + 260, y: b.y + b.height / 2 }; }, id);
    await page.setDragInterception(true);
    await page.mouse.dragAndDrop(await at(ids.mark), await at(ids.folder), { delay: 100 });
    await sleep(1000);
    expect(await ext.run((ids) => chrome.bookmarks.get(ids.mark).then(([m]) => m.parentId), ids)).toBe(ids.folder);
    await page.close();
  });

  it('a tab dragged onto a tab group tile joins the group, in the default order (by recent use)', async () => {
    const pages = [];
    for (const n of ['Loose', 'G1', 'G2']) { const p = await browser.newPage(); await p.goto(`${srv.main}/p/${n}`); pages.push(p); }
    const g = await ext.run(async () => {
      const ids = (await chrome.tabs.query({})).filter((t) => /\/p\/G\d/.test(t.url)).map((t) => t.id);
      const id = await chrome.tabs.group({ tabIds: ids });
      await chrome.tabGroups.update(id, { title: 'Drop group', color: 'green' });
      return id;
    });
    const { page, f } = await openSwitcher('Home2');
    const at = (sel) => f.evaluate((sel) => { const n = sel === 'tile' ? document.querySelector('[data-testid="card-group"]') : [...document.querySelectorAll('[data-testid="card-tab"]')].find((c) => c.querySelector('[data-testid="card-title"]').textContent === 'Loose'); const b = n.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, sel);
    await page.setDragInterception(true);
    await page.mouse.dragAndDrop(await at('tab'), await at('tile'), { delay: 100 });
    await sleep(1200);
    expect(await ext.run(async () => (await chrome.tabs.query({ title: 'Loose' }))[0].groupId)).toBe(g);
    for (const p of pages) await p.close().catch(() => {});
    await page.close();
  });
});
