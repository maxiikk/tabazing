// What Tabazing relies on in Chrome's tab groups, in real Chrome (the unit tests' fake follows these rules):
// moving tabs one by one to another window takes them out of their group (so Merge and "Move to new window" move
// groups as groups, or put the tabs back in one); chrome.tabGroups.move moves a group as one block, its index
// counted among the other tabs (moveGroup's arithmetic); a group moves into a new window whole; a tab restored from
// Chrome's recently closed list goes back into its group by itself (regroup leaves it).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServers, launch } from './helpers/harness.js';

let server, browser, extension;
beforeAll(async () => {
  server = await startServers();
  ({ browser, extension } = await launch());
});
afterAll(async () => { await browser?.close(); await server?.close(); });

// A window with tabs a, w1, w2, w3, b (w1-w3 in a group), in the worker: returns its id and the group's.
const setUp = (base) => extension.run(async (base) => {
  const createdWindow = await chrome.windows.create({ url: ['a', 'w1', 'w2', 'w3', 'b'].map((pageName) => `${base}/p/${pageName}`) });
  for (let i = 0; i < 50 && (await chrome.tabs.query({ windowId: createdWindow.id })).some((tab) => tab.status !== 'complete'); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const tabs = (await chrome.tabs.query({ windowId: createdWindow.id })).sort((first, second) => first.index - second.index);
  const groupId = await chrome.tabs.group({ tabIds: [tabs[1].id, tabs[2].id, tabs[3].id] });
  await chrome.tabGroups.update(groupId, { title: 'Work', color: 'blue' });
  return { window: createdWindow.id, g: groupId };
}, base);
const strip = (windowId) => extension.run(async (windowId) => (await chrome.tabs.query({ windowId })).sort((first, second) => first.index - second.index)
  .map((tab) => tab.title + (tab.groupId >= 0 ? '*' : '')), windowId);

describe('tab groups in Chrome', () => {
  it('chrome.tabGroups.move: one block, at an index counted among the other tabs', async () => {
    const { window: windowId, g: groupId } = await setUp(server.main);
    await extension.run((groupId) => chrome.tabGroups.move(groupId, { index: 2 }), groupId); // after b: b's index + 1 - the group's 3 tabs
    expect((await strip(windowId)).map((x) => x.replace(/^.*\/p\//, ''))).toEqual(['a', 'b', 'w1*', 'w2*', 'w3*']);
    await extension.run((groupId) => chrome.tabGroups.move(groupId, { index: 0 }), groupId); // before a
    expect((await strip(windowId)).map((x) => x.replace(/^.*\/p\//, ''))).toEqual(['w1*', 'w2*', 'w3*', 'a', 'b']);
  });

  it('tabs.move to another window takes a tab out of its group; tabGroups.move into a new window keeps it whole', async () => {
    const { window: windowId, g: groupId } = await setUp(server.main);
    const result = await extension.run(async ({ window: windowId, g: groupId }) => {
      const other = await chrome.windows.create({});
      const [firstTab] = (await chrome.tabs.query({ groupId })).sort((first, second) => first.index - second.index);
      await chrome.tabs.move(firstTab.id, { windowId: other.id, index: -1 });
      const moved = await chrome.tabs.get(firstTab.id);
      await chrome.tabGroups.move(groupId, { windowId: other.id, index: -1 });
      const group = await chrome.tabGroups.get(groupId);
      const left = (await chrome.tabs.query({ windowId })).length;
      return { movedGroup: moved.groupId, groupWindow: group.windowId, other: other.id, inGroup: (await chrome.tabs.query({ groupId })).length, left };
    }, { window: windowId, g: groupId });
    expect(result.movedGroup).toBe(-1);
    expect(result.groupWindow).toBe(result.other);
    expect(result.inGroup).toBe(2);
    expect(result.left).toBe(2); // a and b
  });

  it('a grouped tab restored from Chrome\'s recently closed list comes back in its group', async () => {
    const { g: groupId } = await setUp(server.main);
    const back = await extension.run(async (groupId) => {
      const [firstTab] = await chrome.tabs.query({ groupId });
      await chrome.tabs.remove(firstTab.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const [session] = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
      const restored = await chrome.sessions.restore(session.tab.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return (await chrome.tabs.get(restored.tab.id)).groupId;
    }, groupId);
    expect(back).toBe(groupId);
  });

  it('a tab moved just after the last tab of a group and grouped joins it at its end (what dropping on a tile does)', async () => {
    const { window: windowId, g: groupId } = await setUp(server.main);
    const order = await extension.run(async ({ window: windowId, g: groupId }) => {
      const [firstTab] = (await chrome.tabs.query({ windowId })).sort((x, y) => x.index - y.index);
      const members = (await chrome.tabs.query({ groupId })).sort((x, y) => x.index - y.index);
      const last = members[members.length - 1];
      const current = await chrome.tabs.get(firstTab.id);
      let index = last.index + 1;
      if (current.index < index) index--;
      await chrome.tabs.move(firstTab.id, { windowId, index });
      await chrome.tabs.group({ tabIds: [firstTab.id], groupId });
      return null;
    }, { window: windowId, g: groupId });
    expect(order).toBe(null);
    expect((await strip(windowId)).map((x) => x.replace(/^.*\/p\//, ''))).toEqual(['w1*', 'w2*', 'w3*', 'a*', 'b']);
  });
});
