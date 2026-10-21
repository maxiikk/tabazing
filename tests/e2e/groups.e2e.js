// What Tabazing relies on in Chrome's tab groups, in real Chrome (the unit tests' fake follows these rules):
// moving tabs one by one to another window takes them out of their group (so Merge and "Move to new window" move
// groups as groups, or put the tabs back in one); chrome.tabGroups.move moves a group as one block, its index
// counted among the other tabs (moveGroup's arithmetic); a group moves into a new window whole; a tab restored from
// Chrome's recently closed list goes back into its group by itself (regroup leaves it).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch } from './harness.js';

let srv, browser, ext;
beforeAll(async () => {
  srv = await startServers();
  ({ browser, ext } = await launch());
});
afterAll(async () => { await browser?.close(); await srv?.close(); });

// A window with tabs a, w1, w2, w3, b (w1-w3 in a group), in the worker: returns its id and the group's.
const setUp = (base) => ext.run(async (base) => {
  const w = await chrome.windows.create({ url: ['a', 'w1', 'w2', 'w3', 'b'].map((n) => `${base}/p/${n}`) });
  for (let i = 0; i < 50 && (await chrome.tabs.query({ windowId: w.id })).some((t) => t.status !== 'complete'); i++) await new Promise((r) => setTimeout(r, 100));
  const tabs = (await chrome.tabs.query({ windowId: w.id })).sort((a, b) => a.index - b.index);
  const g = await chrome.tabs.group({ tabIds: [tabs[1].id, tabs[2].id, tabs[3].id] });
  await chrome.tabGroups.update(g, { title: 'Work', color: 'blue' });
  return { win: w.id, g };
}, base);
const strip = (win) => ext.run(async (win) => (await chrome.tabs.query({ windowId: win })).sort((a, b) => a.index - b.index)
  .map((t) => t.title + (t.groupId >= 0 ? '*' : '')), win);

describe('tab groups in Chrome', () => {
  it('chrome.tabGroups.move: one block, at an index counted among the other tabs', async () => {
    const { win, g } = await setUp(srv.main);
    await ext.run((g) => chrome.tabGroups.move(g, { index: 2 }), g); // after b: b's index + 1 - the group's 3 tabs
    expect((await strip(win)).map((x) => x.replace(/^.*\/p\//, ''))).toEqual(['a', 'b', 'w1*', 'w2*', 'w3*']);
    await ext.run((g) => chrome.tabGroups.move(g, { index: 0 }), g); // before a
    expect((await strip(win)).map((x) => x.replace(/^.*\/p\//, ''))).toEqual(['w1*', 'w2*', 'w3*', 'a', 'b']);
  });

  it('tabs.move to another window takes a tab out of its group; tabGroups.move into a new window keeps it whole', async () => {
    const { win, g } = await setUp(srv.main);
    const r = await ext.run(async ({ win, g }) => {
      const other = await chrome.windows.create({});
      const [w1] = (await chrome.tabs.query({ groupId: g })).sort((a, b) => a.index - b.index);
      await chrome.tabs.move(w1.id, { windowId: other.id, index: -1 });
      const moved = await chrome.tabs.get(w1.id);
      await chrome.tabGroups.move(g, { windowId: other.id, index: -1 });
      const group = await chrome.tabGroups.get(g);
      const left = (await chrome.tabs.query({ windowId: win })).length;
      return { movedGroup: moved.groupId, groupWin: group.windowId, other: other.id, inGroup: (await chrome.tabs.query({ groupId: g })).length, left };
    }, { win, g });
    expect(r.movedGroup).toBe(-1);
    expect(r.groupWin).toBe(r.other);
    expect(r.inGroup).toBe(2);
    expect(r.left).toBe(2); // a and b
  });

  it('a grouped tab restored from Chrome\'s recently closed list comes back in its group', async () => {
    const { g } = await setUp(srv.main);
    const back = await ext.run(async (g) => {
      const [w1] = await chrome.tabs.query({ groupId: g });
      await chrome.tabs.remove(w1.id);
      await new Promise((r) => setTimeout(r, 300));
      const [s] = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
      const restored = await chrome.sessions.restore(s.tab.sessionId);
      await new Promise((r) => setTimeout(r, 300));
      return (await chrome.tabs.get(restored.tab.id)).groupId;
    }, g);
    expect(back).toBe(g);
  });

  it('a tab moved just after the last tab of a group and grouped joins it at its end (what dropping on a tile does)', async () => {
    const { win, g } = await setUp(srv.main);
    const order = await ext.run(async ({ win, g }) => {
      const [a] = (await chrome.tabs.query({ windowId: win })).sort((x, y) => x.index - y.index);
      const members = (await chrome.tabs.query({ groupId: g })).sort((x, y) => x.index - y.index);
      const last = members[members.length - 1];
      const cur = await chrome.tabs.get(a.id);
      let index = last.index + 1;
      if (cur.index < index) index--;
      await chrome.tabs.move(a.id, { windowId: win, index });
      await chrome.tabs.group({ tabIds: [a.id], groupId: g });
      return null;
    }, { win, g });
    expect(order).toBe(null);
    expect((await strip(win)).map((x) => x.replace(/^.*\/p\//, ''))).toEqual(['w1*', 'w2*', 'w3*', 'a*', 'b']);
  });
});
