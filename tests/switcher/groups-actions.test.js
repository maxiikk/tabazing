// Tab groups kept whole and worked on: merging windows and moving tabs keep groups (and Undo brings them back),
// a tile's ticks and gestures, what it says about its tabs, sorting, search, dragging, the menus and the palette's
// group actions, the name-and-colour card, the big preview of a group, and the settings around them.
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, tabByTitle, entryByTitle, toastText, toastButton } from './quiet-boot.js';
import { t } from '../../utils/translations.js';

const S = chrome.storage.session;
const GROUP = 7;
const work = (n = 3) => Array.from({ length: n }, (_, i) => ({ title: 'W' + (i + 1), url: `https://w${i + 1}.example/`, groupId: GROUP }));
const TABS = (n = 3) => [{ title: 'A', url: 'https://a.example/' }, ...work(n), { title: 'B', url: 'https://b.example/' }];
const INSIDE = (n = 3) => TABS(n).map((x) => ({ ...x, active: x.title === 'W1' }));
const withGroup = (extra = {}) => ({
  beforeImport: async () => {
    chrome._addGroup({ id: GROUP, title: 'Work', color: 'blue', windowId: 1, ...(extra.group || {}) });
    if (extra.inside) await S.set({ group: { id: GROUP, t: Date.now() } });
    if (extra.more) await extra.more();
  },
});
const tile = () => tid('card-group');
const kinds = (sw) => sw.state.entries.filter((e) => e.kind === 'tab' || e.kind === 'group').map((e) => (e.kind === 'group' ? 'G' : e.tab.title));
const tileEntry = (sw) => sw.state.entries.find((e) => e.kind === 'group');
const groupOfTab = (title) => chrome._data.groups.find((g) => g.id === chrome._data.tabs.find((x) => x.title === title).groupId);
const menuItem = (label) => tids('menu-item').find((b) => b.textContent === label);
const openMenu = (sw, i) => { sw.select(i); key('F10', { shiftKey: true }); };

describe('groups stay groups', () => {
  it('Merge windows moves a group as a group, in its place among the window\'s tabs', async () => {
    const sw = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }], prefs: { allWindows: true }, beforeImport: () => {
      chrome._addWindow({ id: 2 });
      chrome._addTab({ windowId: 2, title: 'X', url: 'https://x.example/' });
      chrome._addGroup({ id: 9, title: 'Far', color: 'red', windowId: 2 });
      chrome._addTab({ windowId: 2, title: 'F1', url: 'https://f1.example/', groupId: 9 });
      chrome._addTab({ windowId: 2, title: 'F2', url: 'https://f2.example/', groupId: 9 });
      chrome._addTab({ windowId: 2, title: 'Y', url: 'https://y.example/' });
    } });
    await sw.mergeWindows([2]);
    const strip = chrome._data.tabs.filter((x) => x.windowId === 1).sort((a, b) => a.index - b.index);
    expect(strip.map((x) => x.title)).toEqual(['A', 'X', 'F1', 'F2', 'Y']);
    expect(strip.filter((x) => x.groupId === 9).map((x) => x.title)).toEqual(['F1', 'F2']); // still in "Far"
    expect(chrome.tabGroups.move).toHaveBeenCalledWith(9, { windowId: 1, index: -1 });
    // Undo: back in window 2, in a group of the same name and colour.
    toastButton().click();
    await waitFor(() => chrome._data.tabs.filter((x) => x.windowId === 2).length === 4 && groupOfTab('F1'));
    expect(groupOfTab('F1')).toMatchObject({ title: 'Far', color: 'red', windowId: 2 });
    expect(groupOfTab('F2')).toBe(groupOfTab('F1'));
  });

  it('Move to new window takes the tabs\' group along (one of the same name and colour there); Undo puts them back in it', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    await sw.moveToWindow([tabByTitle(sw, 'W1'), tabByTitle(sw, 'W2')]);
    const g = groupOfTab('W1');
    expect(g).toMatchObject({ title: 'Work', color: 'blue' });
    expect(g.windowId).not.toBe(1);
    expect(groupOfTab('W2')).toBe(g);
    expect(groupOfTab('W3').id).toBe(GROUP); // the one left behind stays in the original
    toastButton().click();
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'W1').windowId === 1 && groupOfTab('W1') && groupOfTab('W1').windowId === 1);
    expect(groupOfTab('W1').id).toBe(GROUP); // the group still there in window 1: back into it
  });

  it('Undo after closing every tab of the group view brings the tabs back in their group, and the view with them', async () => {
    const sw = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    sw.select(0);
    sw.selectAll();
    tid('action-close').click();
    await waitFor(() => !chrome._data.groups.length);
    await waitFor(() => sw.state.inGroup === null);
    toastButton().click();
    await waitFor(() => sw.state.inGroup !== null);
    const shown = sw.state.entries.filter((e) => e.kind === 'tab').map((e) => e.tab);
    expect(shown.map((x) => x.url).sort()).toEqual(work().map((x) => x.url)); // the group view, with its three tabs again
    expect(chrome._data.groups[0]).toMatchObject({ title: 'Work', color: 'blue' });
    expect((await S.get('group')).group.id).toBe(chrome._data.groups[0].id);
  });

  it('Snoozing a grouped tab keeps its group, for it to wake up in', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    await sw.snoozeTabs([tabByTitle(sw, 'W2')], Date.now() + 3600e3);
    expect(sw.state.snoozed[0].group).toEqual({ id: GROUP, title: 'Work', color: 'blue' });
  });

  it('A closed tab reopened from Tabazing\'s own log goes back into its group', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup({ more: () => chrome.storage.local.set({ closedlog: [{ url: 'https://gone.example/', title: 'Gone', favIconUrl: '', closedAt: Date.now() - 1000, group: { id: GROUP, title: 'Work', color: 'blue' } }] }) }) });
    const i = sw.state.entries.findIndex((e) => e.kind === 'closed');
    expect(sw.state.entries[i].item.group).toEqual({ id: GROUP, title: 'Work', color: 'blue' });
    sw.choose(i);
    await waitFor(() => chrome._data.tabs.some((x) => x.url === 'https://gone.example/' && x.groupId === GROUP));
  });

  it('Chrome changing a group while Tabazing is open (renamed here) shows at once', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    chrome._data.groups[0].title = 'Renamed';
    chrome.tabGroups.onUpdated._emit({ ...chrome._data.groups[0] });
    await waitFor(() => tid('card-title', tile())?.textContent === 'Renamed');
    const w2 = chrome._data.tabs.find((x) => x.title === 'W2');
    w2.groupId = -1; // moved out of the group in Chrome
    chrome.tabs.onUpdated._emit(w2.id, { groupId: -1 }, { ...w2 });
    await waitFor(() => kinds(sw).includes('W2'));
  });
});

describe('a tile and its tabs\' ticks', () => {
  it('ticking a tile ticks its tabs; some ticked shows a dash; "Select all" shows on the tile', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    tile().dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); // Ctrl+click, as on a tab's card
    expect([...sw.state.picked].sort()).toEqual(work().map((x) => tabByTitle(sw, x.title).id).sort());
    expect(tile().classList.contains('picked')).toBe(true);
    expect(tid('card-pick', tile()).getAttribute('aria-checked')).toBe('true');
    sw.state.picked.delete(tabByTitle(sw, 'W1').id);
    sw.refresh();
    expect(tid('card-pick', tile()).getAttribute('aria-checked')).toBe('mixed');
    expect(tile().classList.contains('picked')).toBe(false);
    tid('card-pick', tile()).click(); // some ticked: all of them
    expect(tid('card-pick', tile()).getAttribute('aria-checked')).toBe('true');
    tid('card-pick', tile()).click(); // all: none
    expect(sw.state.picked.size).toBe(0);
    sw.selectAll();
    expect(tile().classList.contains('picked')).toBe(true); // what is ticked is in view
  });

  it('Ctrl+Space on a selected tile ticks it', async () => {
    const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup() });
    sw.select(sw.state.entries.indexOf(tileEntry(sw)));
    key(' ', { ctrlKey: true });
    expect(sw.state.picked.size).toBe(3);
  });

  it('Shift+→ / Shift+← on a selected tile move the selection off it, ticking nothing', async () => {
    const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup() });
    sw.selectKey('g' + GROUP);
    expect(sw.state.entries[sw.state.sel].kind).toBe('group');
    tid('scroller').focus();
    key('ArrowRight', { shiftKey: true });
    expect(sw.state.entries[sw.state.sel].kind).toBe('tab');
    expect(sw.state.entries[sw.state.sel].tab.title).toBe('B');
    expect(sw.state.picked.size).toBe(0);
    sw.selectKey('g' + GROUP);
    key('ArrowLeft', { shiftKey: true });
    expect(sw.state.entries[sw.state.sel].tab.title).toBe('A');
    expect(sw.state.picked.size).toBe(0);
  });

  it('Shift+← on a selected recently closed card moves the selection, ticking nothing', async () => {
    const sw = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }], ctx: { dir: 0 }, beforeImport: () => {
      chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'c1', url: 'https://gone.example/', title: 'Gone' } }];
    } });
    const i = sw.state.entries.findIndex((e) => e.kind === 'closed');
    expect(i).toBeGreaterThan(0);
    sw.select(i);
    tid('scroller').focus();
    key('ArrowLeft', { shiftKey: true });
    expect(sw.state.sel).not.toBe(i);
    expect(sw.state.picked.size).toBe(0);
  });
});

describe('a tile\'s gestures, as a card\'s', () => {
  it('Del closes the group\'s tabs; Undo brings them back in it', async () => {
    const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup() });
    sw.select(sw.state.entries.indexOf(tileEntry(sw)));
    key('Delete');
    await waitFor(() => chrome._data.tabs.length === 2);
    toastButton().click();
    await waitFor(() => chrome._data.tabs.length === 5 && chrome._data.groups.length === 1);
    expect(chrome._data.groups[0]).toMatchObject({ title: 'Work' });
  });

  it('closing the selected tile selects its neighbour, not the first card', async () => {
    const tabs = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }, ...work(2), { title: 'C', url: 'https://c.example/' }, { title: 'D', url: 'https://d.example/' }];
    const sw = await boot({ tabs, ctx: { dir: 0 }, ...withGroup() });
    expect(kinds(sw)).toEqual(['A', 'B', 'G', 'C', 'D']);
    sw.selectKey('g' + GROUP);
    key('Delete');
    await tick(400);
    expect(chrome._data.tabs.map((x) => x.title)).toEqual(['A', 'B', 'C', 'D']);
    expect(kinds(sw)).toEqual(['A', 'B', 'C', 'D']);
    const now = sw.state.entries[sw.state.sel];
    expect(now.kind).toBe('tab');
    expect(['B', 'C']).toContain(now.tab.title);
  });

  it('middle-click and its × close it too', async () => {
    await boot({ tabs: TABS(), ...withGroup() });
    tile().dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    await waitFor(() => chrome._data.tabs.length === 2);
    chrome._reset();
    await boot({ tabs: TABS(), ...withGroup() });
    expect(tid('card-close', tile()).title).toBe(t('groupClose'));
    tid('card-close', tile()).click();
    await waitFor(() => chrome._data.tabs.length === 2);
  });

  it('Space (or Shift+click) shows its tabs\' pictures big; Enter there opens the group', async () => {
    const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup() });
    sw.select(sw.state.entries.indexOf(tileEntry(sw)));
    key(' ');
    const big = tid('big-preview');
    expect(big).not.toBe(null);
    expect(tid('big-preview-title', big).textContent).toBe('Work');
    expect(tids('big-preview-group-tab', big).map((x) => tid('big-preview-group-title', x).textContent)).toEqual(['W1', 'W2', 'W3']);
    expect(sw.state.inGroup).toBe(null);
    key('Enter');
    await waitFor(() => sw.state.inGroup === GROUP);
  });
});

describe('what a tile says about its tabs', () => {
  it('the current tab is in it; how many play sound, sleep, have a note or a star', async () => {
    const sw = await boot({
      tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'W1', url: 'https://w1.example/', groupId: GROUP, active: true, audible: true }, { title: 'W2', url: 'https://w2.example/', groupId: GROUP, discarded: true }],
      ...withGroup({ more: () => chrome.storage.local.set({ notes: { 'https://w2.example/': { u: 'https://w2.example/', n: 'x', t: 1 } }, stars: { 'https://w1.example/': { u: 'https://w1.example/', ti: 'W1', t: 1 } } }) }),
    });
    expect(tid('card-group-here', tile()).textContent).toBe(t('groupHere'));
    expect(tid('card-group-sound-n', tile()).textContent).toBe('1');
    expect(tid('card-group-sound', tile()).getAttribute('aria-label')).toBe(t('groupFlagSound', { count: 1 }));
    expect(tid('card-group-asleep-n', tile()).textContent).toBe('1');
    expect(tid('card-group-notes-n', tile()).textContent).toBe('1');
    expect(tid('card-group-stars-n', tile()).textContent).toBe('1');
    expect(sw.state.inGroup).toBe(null);
  });

  it('collapsed in Chrome\'s tab strip, and (with all windows shown) which window', async () => {
    await boot({ tabs: TABS(), prefs: { allWindows: true }, ...withGroup({ group: { collapsed: true, windowId: 2 }, more: () => {
      chrome._addWindow({ id: 2 });
      for (const x of chrome._data.tabs.filter((x) => x.groupId === GROUP)) { x.windowId = 2; }
    } }) });
    expect(tid('card-group-collapsed', tile()).textContent).toBe(t('groupCollapsed'));
    expect(tid('card-window-tag', tile())).not.toBe(null);
  });
});

describe('sorting and stepping', () => {
  it('By name, a tile goes where its group\'s name does', async () => {
    const sw = await boot({ tabs: [{ title: 'Mango', url: 'https://m.example/' }, { title: 'Zebra', url: 'https://z.example/', groupId: GROUP }, { title: 'Apple', url: 'https://ap.example/' }],
      ...withGroup({ group: { title: 'Aardvark' }, more: () => chrome.storage.local.set({ view: { sort: 'name', collapsed: [] } }) }) });
    expect(kinds(sw)).toEqual(['G', 'Apple', 'Mango']);
  });

  it('By recent use, the tab used just before is one Alt+W away even when it is pinned (and shown first)', async () => {
    const sw = await boot({ tabs: [{ title: 'P', url: 'https://p.example/', pinned: true }, { title: 'A', url: 'https://a.example/', active: true }, { title: 'B', url: 'https://b.example/' }],
      ctx: { hold: true, dir: 1 }, beforeImport: () => S.set({ mru: [2, 1, 3] }) });
    expect(sw.state.entries.map((e) => e.tab.title)).toEqual(['P', 'A', 'B']); // shown: pinned first
    expect(sw.state.entries[sw.state.sel].tab.title).toBe('P');
  });

  // used: A (now), B, C, D, and the pinned P long ago: shown P, A, B, C, D
  const STALE = () => [{ title: 'P', url: 'https://p.example/', pinned: true }, { title: 'A', url: 'https://a.example/', active: true },
    { title: 'B', url: 'https://b.example/' }, { title: 'C', url: 'https://c.example/' }, { title: 'D', url: 'https://d.example/' }];
  it('a pinned tab not used for long is one Alt+Q away (the card before the current one), not last', async () => {
    const sw = await boot({ tabs: STALE(), ctx: { hold: true, dir: -1 }, beforeImport: () => S.set({ mru: [2, 3, 4, 5, 1] }) });
    expect(sw.state.entries.map((e) => e.tab.title)).toEqual(['P', 'A', 'B', 'C', 'D']);
    expect(sw.state.entries[sw.state.sel].tab.title).toBe('P');
  });

  it('Alt+W goes to the tab used before, then on round the cards as shown, the pinned one in its place', async () => {
    const sw = await boot({ tabs: STALE(), ctx: { hold: true, dir: 1 }, beforeImport: () => S.set({ mru: [2, 3, 4, 5, 1] }) });
    const sel = () => sw.state.entries[sw.state.sel].tab.title;
    expect(sel()).toBe('B');
    const seen = [];
    for (let i = 0; i < 4; i++) { sw.qPress(1); seen.push(sel()); }
    expect(seen).toEqual(['C', 'D', 'P', 'A']);
  });

  it('a pinned tab used just before: the first Alt+W goes to it, the next ones on from there as shown', async () => {
    const tabs = [{ title: 'P', url: 'https://p.example/', pinned: true }, { title: 'A', url: 'https://a.example/', active: true }, { title: 'B', url: 'https://b.example/' }];
    const sw = await boot({ tabs, ctx: { hold: true, dir: 1 }, beforeImport: () => S.set({ mru: [2, 1, 3] }) });
    const sel = () => sw.state.entries[sw.state.sel].tab.title;
    expect(sel()).toBe('P');
    sw.qPress(1);
    expect(sel()).toBe('A');
    sw.qPress(1);
    expect(sel()).toBe('B');
  });

  it('Close duplicates keeps the copy that is in a group', async () => {
    const sw = await boot({ tabs: [{ title: 'Loose', url: 'https://same.example/', active: true }, { title: 'Grouped', url: 'https://same.example/', groupId: GROUP }], ...withGroup() });
    expect(sw.duplicates().map((x) => x.title)).toEqual(['Loose']);
  });

  it('Settings -> "go round inside a group": Alt+W wraps at the group\'s end instead of stepping out', async () => {
    const sw = await boot({ tabs: INSIDE(2), ctx: { hold: true, dir: 1 }, prefs: { groupWrap: true }, ...withGroup({ inside: true }) });
    expect(sw.state.entries[sw.state.sel].tab.title).toBe('W2');
    sw.qPress(1);
    expect(sw.state.inGroup).toBe(GROUP);
    expect(sw.state.entries[sw.state.sel].tab.title).toBe('W1');
  });

  it('the setting is in Settings -> Cards, off by default', async () => {
    await boot({ tabs: TABS() });
    tid('settings-btn').click();
    await waitFor(() => tid('settings-group-wrap'));
    expect(tid('settings-group-wrap').checked).toBe(false);
    expect(tid('settings-panel-cards').contains(tid('settings-group-wrap'))).toBe(true);
    expect(tid('settings-group-wrap-note').textContent).toBe(t('setGroupWrapNote'));
  });
});

describe('search', () => {
  const type = async (sw, text) => { tid('search').value = sw.state.query = text; sw.flushSearch(); await tick(10); };

  it('a group is found by its name; Enter on it opens the group', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    await type(sw, 'work');
    const row = tids('dd-row-group')[0];
    expect(row).not.toBe(undefined);
    expect(tid('dd-group-count', row).textContent).toBe(t('tabs', { count: 3 }));
    expect(sw.state.dd.items[0].kind).toBe('group');
    key('Enter');
    await waitFor(() => sw.state.inGroup === GROUP);
  });

  it('in the group view the group\'s own tabs come first', async () => {
    const sw = await boot({ tabs: [{ title: 'Report one', url: 'https://r1.example/' }, { title: 'Report two', url: 'https://r2.example/', groupId: GROUP, active: true }], ...withGroup({ inside: true }) });
    await type(sw, 'report');
    expect(sw.state.dd.items.filter((r) => r.kind === 'tab').map((r) => r.entry.tab.title)).toEqual(['Report two', 'Report one']);
  });
});

describe('dragging ("By order")', () => {
  const byOrder = (more) => ({ ...withGroup({ more: async () => { await chrome.storage.local.set({ view: { sort: 'order', collapsed: [] } }); if (more) await more(); } }) });
  const dragEvent = (type, clientX = 0) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { setData: vi.fn(), effectAllowed: '', dropEffect: '' } });
    Object.defineProperty(e, 'clientX', { value: clientX });
    return e;
  };
  const rect = (card) => { card.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 50, right: 100, bottom: 50 }); return card; };

  it('a tab dropped on a tile goes into the group', async () => {
    const sw = await boot({ tabs: TABS(), ...byOrder() });
    const a = rect(cardOf('A')), g = rect(tile());
    expect(g.draggable).toBe(true);
    a.dispatchEvent(dragEvent('dragstart'));
    const over = dragEvent('dragover', 50);
    g.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(g.classList.contains('drop-into')).toBe(true);
    g.dispatchEvent(dragEvent('drop', 50));
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'A').groupId === GROUP);
    expect(toastText()).toBe(t('groupAddedN', { count: 1, name: 'Work' }));
    // appended: after the group's last tab (A was before the group)
    const strip = chrome._data.tabs.filter((x) => x.windowId === 1).sort((x, y) => x.index - y.index).map((x) => x.title + (x.groupId === GROUP ? '*' : ''));
    expect(strip.filter((x) => x !== 'about:blank')).toEqual(['W1*', 'W2*', 'W3*', 'A*', 'B']);
  });

  it('ticked tabs dropped on a tile all go to its end, in their order; a pinned one is unpinned first', async () => {
    const tabs = [{ title: 'P', url: 'https://p.example/', pinned: true }, ...TABS()];
    const sw = await boot({ tabs, ...byOrder() });
    sw.pick(sw.state.entries.find((e) => e.kind === 'tab' && e.tab.title === 'P'));
    sw.pick(sw.state.entries.find((e) => e.kind === 'tab' && e.tab.title === 'B'));
    const b = rect(cardOf('B')), g = rect(tile());
    b.dispatchEvent(dragEvent('dragstart'));
    g.dispatchEvent(dragEvent('dragover', 50));
    g.dispatchEvent(dragEvent('drop', 50));
    await waitFor(() => chrome._data.tabs.filter((x) => x.groupId === GROUP).length === 5);
    const strip = chrome._data.tabs.filter((x) => x.windowId === 1).sort((x, y) => x.index - y.index).map((x) => x.title + (x.groupId === GROUP ? '*' : ''));
    expect(strip.filter((x) => x !== 'about:blank')).toEqual(['A', 'W1*', 'W2*', 'W3*', 'P*', 'B*']);
    expect(chrome._data.tabs.find((x) => x.title === 'P').pinned).toBe(false);
  });

  it('in any other order too (by recent use, the default), a tab dragged onto a tile goes into the group', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    expect(sw.state.sort).toBe('recent');
    const a = rect(cardOf('A')), b = rect(cardOf('B')), g = rect(tile());
    expect(a.draggable).toBe(true);
    expect(g.draggable).toBe(true); // (onto a window, or Recently closed; among the cards only By order)
    a.dispatchEvent(dragEvent('dragstart'));
    const onTab = dragEvent('dragover', 50);
    b.dispatchEvent(onTab);
    expect(onTab.defaultPrevented).toBe(false); // nothing to drop on but a group
    const over = dragEvent('dragover', 50);
    g.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(g.classList.contains('drop-into')).toBe(true);
    g.dispatchEvent(dragEvent('drop', 50));
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'A').groupId === GROUP);
    expect(chrome.tabs.move).toHaveBeenCalled(); // (to the group's end)
  });

  it('a tile dropped on a tab moves the whole group there', async () => {
    const sw = await boot({ tabs: TABS(), ...byOrder() });
    await sw.moveGroup(GROUP, entryByTitle(sw, 'B'), true); // after B
    const strip = chrome._data.tabs.filter((x) => x.windowId === 1).sort((a, b) => a.index - b.index).map((x) => x.title);
    expect(strip).toEqual(['A', 'B', 'W1', 'W2', 'W3']);
    await sw.moveGroup(GROUP, entryByTitle(sw, 'A'), false); // before A
    expect(chrome._data.tabs.sort((a, b) => a.index - b.index).map((x) => x.title)).toEqual(['W1', 'W2', 'W3', 'A', 'B']);
  });
});

describe('the menus', () => {
  it('a tab\'s menu: "Add to group…" lists the window\'s groups and "New group…"; "Remove from group" for a grouped one', async () => {
    const sw = await boot({ tabs: [...TABS(), { title: 'C', url: 'https://c.example/' }], prefs: { showGroups: false }, ctx: { dir: 0 }, ...withGroup() });
    openMenu(sw, sw.state.entries.indexOf(entryByTitle(sw, 'A')));
    expect(menuItem(t('groupRemoveFrom'))).toBe(undefined);
    menuItem(t('groupAddTo')).click();
    await tick();
    expect(tids('menu-item').map((b) => b.textContent)).toEqual(['Work', t('groupNew')]);
    menuItem('Work').click();
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'A').groupId === GROUP);
    openMenu(sw, sw.state.entries.indexOf(entryByTitle(sw, 'W2')));
    menuItem(t('groupRemoveFrom')).click();
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'W2').groupId === -1);
    expect(toastText()).toBe(t('groupRemovedN', { count: 1 }));
  });

  it('"New group…": a name and one of Chrome\'s colours, then the tabs go into it', async () => {
    const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup() });
    openMenu(sw, sw.state.entries.indexOf(entryByTitle(sw, 'B')));
    menuItem(t('groupAddTo')).click();
    await tick();
    menuItem(t('groupNew')).click();
    const pop = tid('group-editor');
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(tid('group-editor-title', pop).textContent).toBe(t('groupNewTitle'));
    expect(tids('group-editor-color', pop)).toHaveLength(9);
    expect(tids('group-editor-color', pop).find((b) => b.getAttribute('aria-checked') === 'true').dataset.gc).toBe('red'); // a colour not used yet
    tid('group-editor-name', pop).value = 'Later';
    tids('group-editor-color', pop).find((b) => b.dataset.gc === 'green').click();
    pop.requestSubmit();
    await waitFor(() => groupOfTab('B') && groupOfTab('B').title === 'Later');
    expect(groupOfTab('B')).toMatchObject({ title: 'Later', color: 'green' });
    expect(tid('group-editor')).toBe(null);
  });

  it('the ticked tabs\' More: "Add to group…"', async () => {
    const sw = await boot({ tabs: TABS(), prefs: { showGroups: false }, ...withGroup() });
    sw.pick(entryByTitle(sw, 'A'));
    sw.pick(entryByTitle(sw, 'B'));
    tid('actions-more').click();
    menuItem(t('groupAddTo')).click();
    await tick();
    menuItem('Work').click();
    await waitFor(() => ['A', 'B'].every((x) => chrome._data.tabs.find((y) => y.title === x).groupId === GROUP));
  });

  it('a tile\'s "Name and colour…" renames and recolours the group', async () => {
    const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup() });
    openMenu(sw, sw.state.entries.indexOf(tileEntry(sw)));
    menuItem(t('groupEdit')).click();
    const pop = tid('group-editor');
    expect(tid('group-editor-name', pop).value).toBe('Work');
    tid('group-editor-name', pop).value = 'Job';
    tids('group-editor-color', pop).find((b) => b.dataset.gc === 'pink').click();
    pop.requestSubmit();
    await waitFor(() => tid('card-title', tile())?.textContent === 'Job');
    expect(chrome._data.groups[0]).toMatchObject({ title: 'Job', color: 'pink' });
  });

  it('a tile\'s "Move group to new window" moves it as a group; Undo puts it back', async () => {
    const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup() });
    openMenu(sw, sw.state.entries.indexOf(tileEntry(sw)));
    menuItem(t('groupToWindow')).click();
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'W1').windowId !== 1);
    const win = chrome._data.tabs.find((x) => x.title === 'W1').windowId;
    expect(chrome._data.tabs.filter((x) => x.windowId === win).map((x) => x.title)).toEqual(['W1', 'W2', 'W3']); // (its blank New Tab gone)
    expect(groupOfTab('W1').id).toBe(GROUP);
    toastButton().click();
    await waitFor(() => chrome._data.tabs.filter((x) => x.windowId === 1).length === 5 && groupOfTab('W1') && groupOfTab('W1').windowId === 1);
    expect(groupOfTab('W1')).toMatchObject({ title: 'Work', color: 'blue' });
  });

  it('a tile\'s Collapse / Expand in Chrome, Sleep, Mute, Archive act on the whole group', async () => {
    const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup() });
    openMenu(sw, sw.state.entries.indexOf(tileEntry(sw)));
    menuItem(t('groupCollapse')).click();
    await waitFor(() => tid('card-group-collapsed', tile())); // (read again: the tile says so)
    expect(chrome._data.groups[0].collapsed).toBe(true);
    openMenu(sw, sw.state.entries.indexOf(tileEntry(sw)));
    expect(menuItem(t('groupExpand'))).not.toBe(undefined);
    menuItem(t('actMute')).click();
    await waitFor(() => chrome._data.tabs.filter((x) => x.groupId === GROUP).every((x) => x.mutedInfo.muted));
    openMenu(sw, sw.state.entries.indexOf(tileEntry(sw)));
    menuItem(t('actSleep')).click();
    await waitFor(() => work().every((x) => sw.state.toSleep.has(tabByTitle(sw, x.title).id)));
  });
});

describe('the palette\'s group actions', () => {
  it('for the current tab\'s group: open it, ungroup it, close it; the current tab: add to a group, remove from its group', async () => {
    let sw = await boot({ tabs: TABS().map((x) => ({ ...x, active: x.title === 'W2' })), ...withGroup() });
    const ids = sw.paletteActions().map((a) => a.id);
    for (const id of ['open-group', 'group-tab', 'ungroup-tab', 'ungroup-group', 'close-group']) expect(ids, id).toContain(id);
    await sw.runAction(sw.PAL_BY_ID.get('open-group'));
    await waitFor(() => sw.state.inGroup === GROUP);
    expect(sw.paletteActions().map((a) => a.id)).not.toContain('open-group'); // (already in it)
    await sw.runAction(sw.PAL_BY_ID.get('ungroup-tab'));
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'W2').groupId === -1);
    chrome._reset();
    sw = await boot({ tabs: TABS(), ...withGroup() });
    expect(sw.paletteActions().map((a) => a.id)).not.toContain('ungroup-group'); // A isn't in a group
  });
});

describe('the tour', () => {
  it('has a step about groups, while a tile is on screen', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    sw.tourStep(0);
    expect(sw.TOUR.map((x) => x.id)).toContain('groups');
    sw.closeDialog();
    chrome._reset();
    const sw2 = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }] });
    sw2.tourStep(0);
    expect(sw2.TOUR.map((x) => x.id)).not.toContain('groups');
  });
});
