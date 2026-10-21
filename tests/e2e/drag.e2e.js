// Drag and drop in real Chrome (jsdom only sends the events by hand): a recently closed tab dragged with the mouse
// onto the open tabs opens in the background, Tabazing stays open over the page it was opened on, and the tab
// leaves Recently closed; dragged onto a group's tile, it opens at that group's end.
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
async function openSwitcher(page) {
  await page.bringToFront();
  await sleep(1200);
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyE'); await page.keyboard.up('Alt');
  await sleep(1500);
  const f = frameOf(page);
  for (let i = 0; i < 3; i++) if (await f.evaluate(() => !!document.querySelector('[data-testid="modal"]:not([hidden])'))) { await page.keyboard.press('Escape'); await sleep(400); }
  return f;
}
const tabsNow = () => ext.run(async () => (await chrome.tabs.query({})).map((x) => ({ url: x.url, active: x.active, groupId: x.groupId, index: x.index, windowId: x.windowId })));
// A recently closed tab: a page opened, then closed.
async function closeOne(name) {
  const p = await browser.newPage();
  await p.goto(`${srv.main}/p/${name}`);
  await sleep(300);
  await p.close();
  await sleep(500);
}
const card = (f, kind, title) => f.evaluateHandle((kind, title) => [...document.querySelectorAll(`[data-testid="card-${kind}"]`)]
  .find((c) => c.querySelector('[data-testid="card-title"]')?.textContent === title), kind, title);

describe('drag and drop in Chrome', () => {
  it('a recently closed tab dragged onto the open tabs opens in the background; Tabazing stays', async () => {
    await closeOne('Gone');
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${srv.main}/p/Home`);
    const f = await openSwitcher(page);
    const gone = await card(f, 'closed', 'Gone');
    expect(await gone.evaluate((n) => !!n && n.draggable)).toBe(true);
    const open = await f.$('[data-testid="open-grid"]');
    await gone.drag(open);
    await sleep(150);
    // while dragging: the open tabs are outlined as a place that takes it
    expect(await f.evaluate(() => document.querySelector('[data-testid="open-section"]').classList.contains('drop-ok'))).toBe(true);
    await open.drop(gone); // (the mouse lets go over the open tabs)
    await sleep(1500);
    const tabs = await tabsNow();
    const made = tabs.find((x) => x.url === `${srv.main}/p/Gone`);
    expect(made).toBeTruthy();
    expect(made.active).toBe(false);
    expect(tabs.find((x) => x.url === `${srv.main}/p/Home`).active).toBe(true); // still on the page Tabazing is over
    expect(frameOf(page)).toBeTruthy(); // and Tabazing is still open there
    expect(await f.evaluate(() => [...document.querySelectorAll('[data-testid="card-closed"]')].map((c) => c.querySelector('[data-testid="card-title"]')?.textContent))).not.toContain('Gone');
    expect(await f.evaluate(() => [...document.querySelectorAll('.drop-ok, .drop-zone, .dragging')].length)).toBe(0);
    await page.close();
  });

  it('dragged onto a group\'s tile, it opens at the end of that group', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${srv.main}/p/Home2`);
    const gid = await ext.run(async (base) => {
      const [w1, w2] = [await chrome.tabs.create({ url: `${base}/p/W1`, active: false }), await chrome.tabs.create({ url: `${base}/p/W2`, active: false })];
      const id = await chrome.tabs.group({ tabIds: [w1.id, w2.id] });
      await chrome.tabGroups.update(id, { title: 'Work' });
      return id;
    }, srv.main);
    await sleep(500);
    await closeOne('Later');
    const f = await openSwitcher(page);
    const later = await card(f, 'closed', 'Later');
    const tile = await f.$('[data-testid="card-group"]');
    expect(tile).toBeTruthy();
    await later.drag(tile);
    await sleep(150);
    await tile.drop(later);
    await sleep(1500);
    const tabs = await tabsNow();
    const made = tabs.find((x) => x.url === `${srv.main}/p/Later`);
    expect(made).toBeTruthy();
    expect(made.groupId).toBe(gid);
    expect(made.active).toBe(false);
    const group = tabs.filter((x) => x.groupId === gid).sort((a, b) => a.index - b.index).map((x) => x.url.split('/p/')[1]);
    expect(group).toEqual(['W1', 'W2', 'Later']);
    expect(frameOf(page)).toBeTruthy();
    await page.close();
  });
});
