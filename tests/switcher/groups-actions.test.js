// Tab groups kept whole and worked on: merging windows and moving tabs keep groups (and Undo brings them back),
// a tile's ticks and gestures, what it says about its tabs, sorting, search, dragging, the menus and the palette's
// group actions, the name-and-colour card, the big preview of a group, and the settings around them.
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, cardOf, tabByTitle, entryByTitle, toastText, toastButton } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';

const sessionStore = chrome.storage.session;
const GROUP = 7;
const work = (count = 3) => Array.from({ length: count }, (_, i) => ({ title: 'W' + (i + 1), url: `https://w${i + 1}.example/`, groupId: GROUP }));
const TABS = (count = 3) => [{ title: 'A', url: 'https://a.example/' }, ...work(count), { title: 'B', url: 'https://b.example/' }];
const INSIDE = (count = 3) => TABS(count).map((x) => ({ ...x, active: x.title === 'W1' }));
const withGroup = (extra = {}) => ({
  beforeImport: async () => {
    chrome._addGroup({ id: GROUP, title: 'Work', color: 'blue', windowId: 1, ...(extra.group || {}) });
    if (extra.inside) await sessionStore.set({ group: { id: GROUP, t: Date.now() } });
    if (extra.more) await extra.more();
  },
});
const tile = () => byTestId('card-group');
const kinds = (switcher) => switcher.state.entries.filter((entry) => entry.kind === 'tab' || entry.kind === 'group').map((entry) => (entry.kind === 'group' ? 'G' : entry.tab.title));
const tileEntry = (switcher) => switcher.state.entries.find((entry) => entry.kind === 'group');
const groupOfTab = (title) => chrome._data.groups.find((group) => group.id === chrome._data.tabs.find((x) => x.title === title).groupId);
const menuItem = (label) => allByTestId('menu-item').find((item) => item.textContent === label);
const openMenu = (switcher, i) => { switcher.select(i); key('F10', { shiftKey: true }); };

describe('groups stay groups', () => {
  it('Merge windows moves a group as a group, in its place among the window\'s tabs', async () => {
    const switcher = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }], preferences: { allWindows: true }, beforeImport: () => {
      chrome._addWindow({ id: 2 });
      chrome._addTab({ windowId: 2, title: 'X', url: 'https://x.example/' });
      chrome._addGroup({ id: 9, title: 'Far', color: 'red', windowId: 2 });
      chrome._addTab({ windowId: 2, title: 'F1', url: 'https://f1.example/', groupId: 9 });
      chrome._addTab({ windowId: 2, title: 'F2', url: 'https://f2.example/', groupId: 9 });
      chrome._addTab({ windowId: 2, title: 'Y', url: 'https://y.example/' });
    } });
    await switcher.mergeWindows([2]);
    const strip = chrome._data.tabs.filter((x) => x.windowId === 1).sort((first, second) => first.index - second.index);
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
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    await switcher.moveToNewWindow([tabByTitle(switcher, 'W1'), tabByTitle(switcher, 'W2')]);
    const group = groupOfTab('W1');
    expect(group).toMatchObject({ title: 'Work', color: 'blue' });
    expect(group.windowId).not.toBe(1);
    expect(groupOfTab('W2')).toBe(group);
    expect(groupOfTab('W3').id).toBe(GROUP); // the one left behind stays in the original
    toastButton().click();
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'W1').windowId === 1 && groupOfTab('W1') && groupOfTab('W1').windowId === 1);
    expect(groupOfTab('W1').id).toBe(GROUP); // the group still there in window 1: back into it
  });

  it('Undo after closing every tab of the group view brings the tabs back in their group, and the view with them', async () => {
    const switcher = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    switcher.select(0);
    switcher.selectAll();
    byTestId('action-close').click();
    await waitFor(() => !chrome._data.groups.length);
    await waitFor(() => switcher.state.inGroup === null);
    toastButton().click();
    await waitFor(() => switcher.state.inGroup !== null);
    const shown = switcher.state.entries.filter((entry) => entry.kind === 'tab').map((entry) => entry.tab);
    expect(shown.map((x) => x.url).sort()).toEqual(work().map((x) => x.url)); // the group view, with its three tabs again
    expect(chrome._data.groups[0]).toMatchObject({ title: 'Work', color: 'blue' });
    expect((await sessionStore.get('group')).group.id).toBe(chrome._data.groups[0].id);
  });

  it('Snoozing a grouped tab keeps its group, for it to wake up in', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    await switcher.snoozeTabs([tabByTitle(switcher, 'W2')], Date.now() + 3600e3);
    expect(switcher.state.snoozed[0].group).toEqual({ id: GROUP, title: 'Work', color: 'blue' });
  });

  it('A closed tab reopened from Tabazing\'s own log goes back into its group', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup({ more: () => chrome.storage.local.set({ closedlog: [{ url: 'https://gone.example/', title: 'Gone', favIconUrl: '', closedAt: Date.now() - 1000, group: { id: GROUP, title: 'Work', color: 'blue' } }] }) }) });
    const i = switcher.state.entries.findIndex((entry) => entry.kind === 'closed');
    expect(switcher.state.entries[i].item.group).toEqual({ id: GROUP, title: 'Work', color: 'blue' });
    switcher.choose(i);
    await waitFor(() => chrome._data.tabs.some((x) => x.url === 'https://gone.example/' && x.groupId === GROUP));
  });

  it('Chrome changing a group while Tabazing is open (renamed here) shows at once', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    chrome._data.groups[0].title = 'Renamed';
    chrome.tabGroups.onUpdated._emit({ ...chrome._data.groups[0] });
    await waitFor(() => byTestId('card-title', tile())?.textContent === 'Renamed');
    const secondWorkTab = chrome._data.tabs.find((x) => x.title === 'W2');
    secondWorkTab.groupId = -1; // moved out of the group in Chrome
    chrome.tabs.onUpdated._emit(secondWorkTab.id, { groupId: -1 }, { ...secondWorkTab });
    await waitFor(() => kinds(switcher).includes('W2'));
  });
});

describe('a tile and its tabs\' ticks', () => {
  it('ticking a tile ticks its tabs; some ticked shows a dash; "Select all" shows on the tile', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    tile().dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); // Ctrl+click, as on a tab's card
    expect([...switcher.state.picked].sort()).toEqual(work().map((x) => tabByTitle(switcher, x.title).id).sort());
    expect(tile().classList.contains('picked')).toBe(true);
    expect(byTestId('card-pick', tile()).getAttribute('aria-checked')).toBe('true');
    switcher.state.picked.delete(tabByTitle(switcher, 'W1').id);
    switcher.refresh();
    expect(byTestId('card-pick', tile()).getAttribute('aria-checked')).toBe('mixed');
    expect(tile().classList.contains('picked')).toBe(false);
    byTestId('card-pick', tile()).click(); // some ticked: all of them
    expect(byTestId('card-pick', tile()).getAttribute('aria-checked')).toBe('true');
    byTestId('card-pick', tile()).click(); // all: none
    expect(switcher.state.picked.size).toBe(0);
    switcher.selectAll();
    expect(tile().classList.contains('picked')).toBe(true); // what is ticked is in view
  });

  it('Ctrl+Space on a selected tile ticks it', async () => {
    const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup() });
    switcher.select(switcher.state.entries.indexOf(tileEntry(switcher)));
    key(' ', { ctrlKey: true });
    expect(switcher.state.picked.size).toBe(3);
  });

  it('Shift+→ / Shift+← on a selected tile move the selection off it, ticking nothing', async () => {
    const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup() });
    switcher.selectKey('g' + GROUP);
    expect(switcher.state.entries[switcher.state.selected].kind).toBe('group');
    byTestId('scroller').focus();
    key('ArrowRight', { shiftKey: true });
    expect(switcher.state.entries[switcher.state.selected].kind).toBe('tab');
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('B');
    expect(switcher.state.picked.size).toBe(0);
    switcher.selectKey('g' + GROUP);
    key('ArrowLeft', { shiftKey: true });
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('A');
    expect(switcher.state.picked.size).toBe(0);
  });

  it('Shift+← on a selected recently closed card moves the selection, ticking nothing', async () => {
    const switcher = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }], context: { direction: 0 }, beforeImport: () => {
      chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'c1', url: 'https://gone.example/', title: 'Gone' } }];
    } });
    const i = switcher.state.entries.findIndex((entry) => entry.kind === 'closed');
    expect(i).toBeGreaterThan(0);
    switcher.select(i);
    byTestId('scroller').focus();
    key('ArrowLeft', { shiftKey: true });
    expect(switcher.state.selected).not.toBe(i);
    expect(switcher.state.picked.size).toBe(0);
  });
});

describe('a tile\'s gestures, as a card\'s', () => {
  it('Del closes the group\'s tabs; Undo brings them back in it', async () => {
    const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup() });
    switcher.select(switcher.state.entries.indexOf(tileEntry(switcher)));
    key('Delete');
    await waitFor(() => chrome._data.tabs.length === 2);
    toastButton().click();
    await waitFor(() => chrome._data.tabs.length === 5 && chrome._data.groups.length === 1);
    expect(chrome._data.groups[0]).toMatchObject({ title: 'Work' });
  });

  it('closing the selected tile selects its neighbour, not the first card', async () => {
    const tabs = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }, ...work(2), { title: 'C', url: 'https://c.example/' }, { title: 'D', url: 'https://d.example/' }];
    const switcher = await boot({ tabs, context: { direction: 0 }, ...withGroup() });
    expect(kinds(switcher)).toEqual(['A', 'B', 'G', 'C', 'D']);
    switcher.selectKey('g' + GROUP);
    key('Delete');
    await tick(400);
    expect(chrome._data.tabs.map((x) => x.title)).toEqual(['A', 'B', 'C', 'D']);
    expect(kinds(switcher)).toEqual(['A', 'B', 'C', 'D']);
    const now = switcher.state.entries[switcher.state.selected];
    expect(now.kind).toBe('tab');
    expect(['B', 'C']).toContain(now.tab.title);
  });

  it('middle-click and its × close it too', async () => {
    await boot({ tabs: TABS(), ...withGroup() });
    tile().dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    await waitFor(() => chrome._data.tabs.length === 2);
    chrome._reset();
    await boot({ tabs: TABS(), ...withGroup() });
    expect(byTestId('card-close', tile()).title).toBe(translate('groupClose'));
    byTestId('card-close', tile()).click();
    await waitFor(() => chrome._data.tabs.length === 2);
  });

  it('Space (or Shift+click) shows its tabs\' pictures big; Enter there opens the group', async () => {
    const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup() });
    switcher.select(switcher.state.entries.indexOf(tileEntry(switcher)));
    key(' ');
    const bigPreview = byTestId('big-preview');
    expect(bigPreview).not.toBe(null);
    expect(byTestId('big-preview-title', bigPreview).textContent).toBe('Work');
    expect(allByTestId('big-preview-group-tab', bigPreview).map((x) => byTestId('big-preview-group-title', x).textContent)).toEqual(['W1', 'W2', 'W3']);
    expect(switcher.state.inGroup).toBe(null);
    key('Enter');
    await waitFor(() => switcher.state.inGroup === GROUP);
  });
});

describe('what a tile says about its tabs', () => {
  it('the current tab is in it; how many play sound, sleep, have a note or a star', async () => {
    const switcher = await boot({
      tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'W1', url: 'https://w1.example/', groupId: GROUP, active: true, audible: true }, { title: 'W2', url: 'https://w2.example/', groupId: GROUP, discarded: true }],
      ...withGroup({ more: () => chrome.storage.local.set({ notes: { 'https://w2.example/': { u: 'https://w2.example/', n: 'x', t: 1 } }, stars: { 'https://w1.example/': { u: 'https://w1.example/', ti: 'W1', t: 1 } } }) }),
    });
    expect(byTestId('card-group-here', tile()).textContent).toBe(translate('groupHere'));
    expect(byTestId('card-group-sound-count', tile()).textContent).toBe('1');
    expect(byTestId('card-group-sound', tile()).getAttribute('aria-label')).toBe(translate('groupFlagSound', { count: 1 }));
    expect(byTestId('card-group-asleep-count', tile()).textContent).toBe('1');
    expect(byTestId('card-group-notes-count', tile()).textContent).toBe('1');
    expect(byTestId('card-group-stars-count', tile()).textContent).toBe('1');
    expect(switcher.state.inGroup).toBe(null);
  });

  it('collapsed in Chrome\'s tab strip, and (with all windows shown) which window', async () => {
    await boot({ tabs: TABS(), preferences: { allWindows: true }, ...withGroup({ group: { collapsed: true, windowId: 2 }, more: () => {
      chrome._addWindow({ id: 2 });
      for (const x of chrome._data.tabs.filter((x) => x.groupId === GROUP)) { x.windowId = 2; }
    } }) });
    expect(byTestId('card-group-collapsed', tile()).textContent).toBe(translate('groupCollapsed'));
    expect(byTestId('card-window-tag', tile())).not.toBe(null);
  });
});

describe('sorting and stepping', () => {
  it('By name, a tile goes where its group\'s name does', async () => {
    const switcher = await boot({ tabs: [{ title: 'Mango', url: 'https://m.example/' }, { title: 'Zebra', url: 'https://z.example/', groupId: GROUP }, { title: 'Apple', url: 'https://ap.example/' }],
      ...withGroup({ group: { title: 'Aardvark' }, more: () => chrome.storage.local.set({ view: { sort: 'name', collapsed: [] } }) }) });
    expect(kinds(switcher)).toEqual(['G', 'Apple', 'Mango']);
  });

  it('By recent use, the tab used just before is one Alt+W away even when it is pinned (and shown first)', async () => {
    const switcher = await boot({ tabs: [{ title: 'P', url: 'https://p.example/', pinned: true }, { title: 'A', url: 'https://a.example/', active: true }, { title: 'B', url: 'https://b.example/' }],
      context: { hold: true, direction: 1 }, beforeImport: () => sessionStore.set({ mru: [2, 1, 3] }) });
    expect(switcher.state.entries.map((entry) => entry.tab.title)).toEqual(['P', 'A', 'B']); // shown: pinned first
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('P');
  });

  // used: A (now), B, C, D, and the pinned P long ago: shown P, A, B, C, D
  const STALE = () => [{ title: 'P', url: 'https://p.example/', pinned: true }, { title: 'A', url: 'https://a.example/', active: true },
    { title: 'B', url: 'https://b.example/' }, { title: 'C', url: 'https://c.example/' }, { title: 'D', url: 'https://d.example/' }];
  it('a pinned tab not used for long is one Alt+Q away (the card before the current one), not last', async () => {
    const switcher = await boot({ tabs: STALE(), context: { hold: true, direction: -1 }, beforeImport: () => sessionStore.set({ mru: [2, 3, 4, 5, 1] }) });
    expect(switcher.state.entries.map((entry) => entry.tab.title)).toEqual(['P', 'A', 'B', 'C', 'D']);
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('P');
  });

  it('Alt+W goes to the tab used before, then on round the cards as shown, the pinned one in its place', async () => {
    const switcher = await boot({ tabs: STALE(), context: { hold: true, direction: 1 }, beforeImport: () => sessionStore.set({ mru: [2, 3, 4, 5, 1] }) });
    const selectedTitle = () => switcher.state.entries[switcher.state.selected].tab.title;
    expect(selectedTitle()).toBe('B');
    const seen = [];
    for (let i = 0; i < 4; i++) { switcher.cyclePress(1); seen.push(selectedTitle()); }
    expect(seen).toEqual(['C', 'D', 'P', 'A']);
  });

  it('a pinned tab used just before: the first Alt+W goes to it, the next ones on from there as shown', async () => {
    const tabs = [{ title: 'P', url: 'https://p.example/', pinned: true }, { title: 'A', url: 'https://a.example/', active: true }, { title: 'B', url: 'https://b.example/' }];
    const switcher = await boot({ tabs, context: { hold: true, direction: 1 }, beforeImport: () => sessionStore.set({ mru: [2, 1, 3] }) });
    const selectedTitle = () => switcher.state.entries[switcher.state.selected].tab.title;
    expect(selectedTitle()).toBe('P');
    switcher.cyclePress(1);
    expect(selectedTitle()).toBe('A');
    switcher.cyclePress(1);
    expect(selectedTitle()).toBe('B');
  });

  it('Close duplicates keeps the copy that is in a group', async () => {
    const switcher = await boot({ tabs: [{ title: 'Loose', url: 'https://same.example/', active: true }, { title: 'Grouped', url: 'https://same.example/', groupId: GROUP }], ...withGroup() });
    expect(switcher.duplicates().map((x) => x.title)).toEqual(['Loose']);
  });

  it('Settings -> "go round inside a group": Alt+W wraps at the group\'s end instead of stepping out', async () => {
    const switcher = await boot({ tabs: INSIDE(2), context: { hold: true, direction: 1 }, preferences: { groupWrap: true }, ...withGroup({ inside: true }) });
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('W2');
    switcher.cyclePress(1);
    expect(switcher.state.inGroup).toBe(GROUP);
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('W1');
  });

  it('the setting is in Settings -> Cards, off by default', async () => {
    await boot({ tabs: TABS() });
    byTestId('settings-button').click();
    await waitFor(() => byTestId('settings-group-wrap'));
    expect(byTestId('settings-group-wrap').checked).toBe(false);
    expect(byTestId('settings-panel-cards').contains(byTestId('settings-group-wrap'))).toBe(true);
    expect(byTestId('settings-group-wrap-note').textContent).toBe(translate('settingsGroupWrapNote'));
  });
});

describe('search', () => {
  const type = async (switcher, text) => { byTestId('search').value = switcher.state.query = text; switcher.flushSearch(); await tick(10); };

  it('a group is found by its name; Enter on it opens the group', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    await type(switcher, 'work');
    const row = allByTestId('dropdown-row-group')[0];
    expect(row).not.toBe(undefined);
    expect(byTestId('dropdown-group-count', row).textContent).toBe(translate('tabs', { count: 3 }));
    expect(switcher.state.dropdown.items[0].kind).toBe('group');
    key('Enter');
    await waitFor(() => switcher.state.inGroup === GROUP);
  });

  it('in the group view the group\'s own tabs come first', async () => {
    const switcher = await boot({ tabs: [{ title: 'Report one', url: 'https://r1.example/' }, { title: 'Report two', url: 'https://r2.example/', groupId: GROUP, active: true }], ...withGroup({ inside: true }) });
    await type(switcher, 'report');
    expect(switcher.state.dropdown.items.filter((row) => row.kind === 'tab').map((row) => row.entry.tab.title)).toEqual(['Report two', 'Report one']);
  });
});

describe('dragging ("By order")', () => {
  const byOrder = (more) => ({ ...withGroup({ more: async () => { await chrome.storage.local.set({ view: { sort: 'order', collapsed: [] } }); if (more) await more(); } }) });
  const dragEvent = (type, clientX = 0) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { setData: vi.fn(), effectAllowed: '', dropEffect: '' } });
    Object.defineProperty(event, 'clientX', { value: clientX });
    return event;
  };
  const stubBounds = (card) => { card.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 50, right: 100, bottom: 50 }); return card; };

  it('a tab dropped on a tile goes into the group', async () => {
    await boot({ tabs: TABS(), ...byOrder() });
    const alphaCard = stubBounds(cardOf('A')), groupTile = stubBounds(tile());
    expect(groupTile.draggable).toBe(true);
    alphaCard.dispatchEvent(dragEvent('dragstart'));
    const over = dragEvent('dragover', 50);
    groupTile.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(groupTile.classList.contains('drop-into')).toBe(true);
    groupTile.dispatchEvent(dragEvent('drop', 50));
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'A').groupId === GROUP);
    expect(toastText()).toBe(translate('groupAddedCount', { count: 1, name: 'Work' }));
    // appended: after the group's last tab (A was before the group)
    const strip = chrome._data.tabs.filter((x) => x.windowId === 1).sort((x, y) => x.index - y.index).map((x) => x.title + (x.groupId === GROUP ? '*' : ''));
    expect(strip.filter((x) => x !== 'about:blank')).toEqual(['W1*', 'W2*', 'W3*', 'A*', 'B']);
  });

  it('ticked tabs dropped on a tile all go to its end, in their order; a pinned one is unpinned first', async () => {
    const tabs = [{ title: 'P', url: 'https://p.example/', pinned: true }, ...TABS()];
    const switcher = await boot({ tabs, ...byOrder() });
    switcher.pick(switcher.state.entries.find((entry) => entry.kind === 'tab' && entry.tab.title === 'P'));
    switcher.pick(switcher.state.entries.find((entry) => entry.kind === 'tab' && entry.tab.title === 'B'));
    const bravoCard = stubBounds(cardOf('B')), groupTile = stubBounds(tile());
    bravoCard.dispatchEvent(dragEvent('dragstart'));
    groupTile.dispatchEvent(dragEvent('dragover', 50));
    groupTile.dispatchEvent(dragEvent('drop', 50));
    await waitFor(() => chrome._data.tabs.filter((x) => x.groupId === GROUP).length === 5);
    const strip = chrome._data.tabs.filter((x) => x.windowId === 1).sort((x, y) => x.index - y.index).map((x) => x.title + (x.groupId === GROUP ? '*' : ''));
    expect(strip.filter((x) => x !== 'about:blank')).toEqual(['A', 'W1*', 'W2*', 'W3*', 'P*', 'B*']);
    expect(chrome._data.tabs.find((x) => x.title === 'P').pinned).toBe(false);
  });

  it('in any other order too (by recent use, the default), a tab dragged onto a tile goes into the group', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    expect(switcher.state.sort).toBe('recent');
    const alphaCard = stubBounds(cardOf('A')), bravoCard = stubBounds(cardOf('B')), groupTile = stubBounds(tile());
    expect(alphaCard.draggable).toBe(true);
    expect(groupTile.draggable).toBe(true); // (onto a window, or Recently closed; among the cards only By order)
    alphaCard.dispatchEvent(dragEvent('dragstart'));
    const onTab = dragEvent('dragover', 50);
    bravoCard.dispatchEvent(onTab);
    expect(onTab.defaultPrevented).toBe(false); // nothing to drop on but a group
    const over = dragEvent('dragover', 50);
    groupTile.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(groupTile.classList.contains('drop-into')).toBe(true);
    groupTile.dispatchEvent(dragEvent('drop', 50));
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'A').groupId === GROUP);
    expect(chrome.tabs.move).toHaveBeenCalled(); // (to the group's end)
  });

  it('a tile dropped on a tab moves the whole group there', async () => {
    const switcher = await boot({ tabs: TABS(), ...byOrder() });
    await switcher.moveGroup(GROUP, entryByTitle(switcher, 'B'), true); // after B
    const strip = chrome._data.tabs.filter((x) => x.windowId === 1).sort((first, second) => first.index - second.index).map((x) => x.title);
    expect(strip).toEqual(['A', 'B', 'W1', 'W2', 'W3']);
    await switcher.moveGroup(GROUP, entryByTitle(switcher, 'A'), false); // before A
    expect(chrome._data.tabs.sort((first, second) => first.index - second.index).map((x) => x.title)).toEqual(['W1', 'W2', 'W3', 'A', 'B']);
  });
});

describe('the menus', () => {
  it('a tab\'s menu: "Add to group…" lists the window\'s groups and "New group…"; "Remove from group" for a grouped one', async () => {
    const switcher = await boot({ tabs: [...TABS(), { title: 'C', url: 'https://c.example/' }], preferences: { showGroups: false }, context: { direction: 0 }, ...withGroup() });
    openMenu(switcher, switcher.state.entries.indexOf(entryByTitle(switcher, 'A')));
    expect(menuItem(translate('groupRemoveFrom'))).toBe(undefined);
    menuItem(translate('groupAddTo')).click();
    await tick();
    expect(allByTestId('menu-item').map((menuItem) => menuItem.textContent)).toEqual(['Work', translate('groupNew')]);
    menuItem('Work').click();
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'A').groupId === GROUP);
    openMenu(switcher, switcher.state.entries.indexOf(entryByTitle(switcher, 'W2')));
    menuItem(translate('groupRemoveFrom')).click();
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'W2').groupId === -1);
    expect(toastText()).toBe(translate('groupRemovedCount', { count: 1 }));
  });

  it('"New group…": a name and one of Chrome\'s colours, then the tabs go into it', async () => {
    const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup() });
    openMenu(switcher, switcher.state.entries.indexOf(entryByTitle(switcher, 'B')));
    menuItem(translate('groupAddTo')).click();
    await tick();
    menuItem(translate('groupNew')).click();
    const popup = byTestId('group-editor');
    expect(popup.getAttribute('role')).toBe('dialog');
    expect(byTestId('group-editor-title', popup).textContent).toBe(translate('groupNewTitle'));
    expect(allByTestId('group-editor-color', popup)).toHaveLength(9);
    expect(allByTestId('group-editor-color', popup).find((colorButton) => colorButton.getAttribute('aria-checked') === 'true').dataset.groupColor).toBe('red'); // a colour not used yet
    byTestId('group-editor-name', popup).value = 'Later';
    allByTestId('group-editor-color', popup).find((colorButton) => colorButton.dataset.groupColor === 'green').click();
    popup.requestSubmit();
    await waitFor(() => groupOfTab('B') && groupOfTab('B').title === 'Later');
    expect(groupOfTab('B')).toMatchObject({ title: 'Later', color: 'green' });
    expect(byTestId('group-editor')).toBe(null);
  });

  it('the ticked tabs\' More: "Add to group…"', async () => {
    const switcher = await boot({ tabs: TABS(), preferences: { showGroups: false }, ...withGroup() });
    switcher.pick(entryByTitle(switcher, 'A'));
    switcher.pick(entryByTitle(switcher, 'B'));
    byTestId('actions-more').click();
    menuItem(translate('groupAddTo')).click();
    await tick();
    menuItem('Work').click();
    await waitFor(() => ['A', 'B'].every((x) => chrome._data.tabs.find((y) => y.title === x).groupId === GROUP));
  });

  it('a tile\'s "Name and colour…" renames and recolours the group', async () => {
    const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup() });
    openMenu(switcher, switcher.state.entries.indexOf(tileEntry(switcher)));
    menuItem(translate('groupEdit')).click();
    const popup = byTestId('group-editor');
    expect(byTestId('group-editor-name', popup).value).toBe('Work');
    byTestId('group-editor-name', popup).value = 'Job';
    allByTestId('group-editor-color', popup).find((colorButton) => colorButton.dataset.groupColor === 'pink').click();
    popup.requestSubmit();
    await waitFor(() => byTestId('card-title', tile())?.textContent === 'Job');
    expect(chrome._data.groups[0]).toMatchObject({ title: 'Job', color: 'pink' });
  });

  it('a tile\'s "Move group to new window" moves it as a group; Undo puts it back', async () => {
    const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup() });
    openMenu(switcher, switcher.state.entries.indexOf(tileEntry(switcher)));
    menuItem(translate('groupToWindow')).click();
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'W1').windowId !== 1);
    const windowId = chrome._data.tabs.find((x) => x.title === 'W1').windowId;
    expect(chrome._data.tabs.filter((x) => x.windowId === windowId).map((x) => x.title)).toEqual(['W1', 'W2', 'W3']); // (its blank New Tab gone)
    expect(groupOfTab('W1').id).toBe(GROUP);
    toastButton().click();
    await waitFor(() => chrome._data.tabs.filter((x) => x.windowId === 1).length === 5 && groupOfTab('W1') && groupOfTab('W1').windowId === 1);
    expect(groupOfTab('W1')).toMatchObject({ title: 'Work', color: 'blue' });
  });

  it('a tile\'s Collapse / Expand in Chrome, Sleep, Mute, Archive action on the whole group', async () => {
    const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup() });
    openMenu(switcher, switcher.state.entries.indexOf(tileEntry(switcher)));
    menuItem(translate('groupCollapse')).click();
    await waitFor(() => byTestId('card-group-collapsed', tile())); // (read again: the tile says so)
    expect(chrome._data.groups[0].collapsed).toBe(true);
    openMenu(switcher, switcher.state.entries.indexOf(tileEntry(switcher)));
    expect(menuItem(translate('groupExpand'))).not.toBe(undefined);
    menuItem(translate('actionMute')).click();
    await waitFor(() => chrome._data.tabs.filter((x) => x.groupId === GROUP).every((x) => x.mutedInfo.muted));
    openMenu(switcher, switcher.state.entries.indexOf(tileEntry(switcher)));
    menuItem(translate('actionSleep')).click();
    await waitFor(() => work().every((x) => switcher.state.toSleep.has(tabByTitle(switcher, x.title).id)));
  });
});

describe('the palette\'s group actions', () => {
  it('for the current tab\'s group: open it, ungroup it, close it; the current tab: add to a group, remove from its group', async () => {
    let switcher = await boot({ tabs: TABS().map((x) => ({ ...x, active: x.title === 'W2' })), ...withGroup() });
    const actionIds = switcher.paletteActions().map((action) => action.id);
    for (const id of ['open-group', 'group-tab', 'ungroup-tab', 'ungroup-group', 'close-group']) expect(actionIds, id).toContain(id);
    await switcher.runAction(switcher.PALETTE_BY_ID.get('open-group'));
    await waitFor(() => switcher.state.inGroup === GROUP);
    expect(switcher.paletteActions().map((action) => action.id)).not.toContain('open-group'); // (already in it)
    await switcher.runAction(switcher.PALETTE_BY_ID.get('ungroup-tab'));
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'W2').groupId === -1);
    chrome._reset();
    switcher = await boot({ tabs: TABS(), ...withGroup() });
    expect(switcher.paletteActions().map((action) => action.id)).not.toContain('ungroup-group'); // A isn't in a group
  });
});

describe('the tour', () => {
  it('has a step about groups, while a tile is on screen', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    switcher.tourStep(0);
    expect(switcher.TOUR.map((x) => x.id)).toContain('groups');
    switcher.closeDialog();
    chrome._reset();
    const secondSwitcher = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }] });
    secondSwitcher.tourStep(0);
    expect(secondSwitcher.TOUR.map((x) => x.id)).not.toContain('groups');
  });
});
