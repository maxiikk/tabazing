// Tab groups: a tile per Chrome tab group among the cards (its first four tabs as its picture), the group view
// its tile opens (only that group's tabs, remembered for every open until it is left), and what a tile's menu does.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, cardOf, tabByTitle, toastButton } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';

const session = chrome.storage.session;
const GROUP = 7;
const work = (count = 3) => Array.from({ length: count }, (value, i) => ({ title: 'W' + (i + 1), url: `https://w${i + 1}.example/`, groupId: GROUP }));
const TABS = (count = 3) => [{ title: 'A', url: 'https://a.example/' }, ...work(count), { title: 'B', url: 'https://b.example/' }];
// The same, the current tab one in the group (opened from outside it, Tabazing leaves a remembered group).
const INSIDE = (count = 3) => TABS(count).map((x) => ({ ...x, active: x.title === 'W1' }));
const withGroup = (extra = {}) => ({
  beforeImport: async () => {
    chrome._addGroup({ id: GROUP, title: 'Work', color: 'blue', windowId: 1 });
    if (extra.inside) await session.set({ group: { id: GROUP, t: Date.now() } });
  },
});
const tile = () => byTestId('card-group');
const kinds = (switcher) => switcher.state.entries.filter((entry) => entry.kind === 'tab' || entry.kind === 'group').map((entry) => (entry.kind === 'group' ? 'G' : entry.tab.title));
const stored = async () => (await session.get('group')).group;

describe('group tiles', () => {
  it('a group\'s tabs show as one tile, where its first tab would be', async () => {
    const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup() });
    expect(kinds(switcher)).toEqual(['A', 'G', 'B']);
    expect(allByTestId('card-group')).toHaveLength(1);
    expect(byTestId('card-title', tile()).textContent).toBe('Work');
    expect(byTestId('card-group-count', tile()).textContent).toBe(translate('tabs', { count: 3 }));
    expect(tile().dataset.groupColor).toBe('blue');
    expect(tile().getAttribute('aria-label')).toBe(translate('groupAria', { name: 'Work', tabs: translate('tabs', { count: 3 }) }));
    expect(tile().getAttribute('role')).toBe('option');
    expect(cardOf('W1')).toBe(undefined); // its tabs have no cards of their own
    expect(switcher.state.matchCount).toBe(5); // ...but they count, and "Select all" takes them
  });

  it.each([1, 2, 3, 4])('its picture with %i tab(s): that many cells, no empty placeholders', async (tabCount) => {
    await boot({ tabs: TABS(tabCount), ...withGroup() });
    expect(allByTestId('card-group-cell', tile())).toHaveLength(tabCount);
    expect(byTestId('card-thumb', tile()).classList.contains('n' + tabCount)).toBe(true); // (switcher.css lays each count out)
    expect(byTestId('card-group-more', tile())).toBe(null);
  });

  it('its picture: the first four tabs, two by two, "+N" for the rest', async () => {
    await boot({ tabs: TABS(6), ...withGroup() });
    expect(allByTestId('card-group-cell', tile())).toHaveLength(4);
    expect(byTestId('card-group-more', tile()).textContent).toBe(translate('groupMoreCount', { count: 2 }));
    expect(tile().title.split('\n')[0]).toBe(translate('groupTip', { name: 'Work' }));
  });

  it('the stylesheet fills the picture with one cell, two side by side, three as one big and two small', () => {
    const css = readFileSync(resolve(process.cwd(), 'styles/switcher.css'), 'utf8');
    expect(css).toContain('.group-tile .group-mosaic.n1 { grid-template: 1fr / 1fr; }');
    expect(css).toContain('.group-tile .group-mosaic.n2 { grid-template: 1fr / 1fr 1fr; }');
    expect(css).toContain('.group-tile .group-mosaic.n3 > .group-cell:first-child { grid-row: span 2; }');
    expect(css).not.toContain('.group-cell.empty');
  });

  it('a group without a name is called by its colour, as Chrome shows it ("Green group")', async () => {
    await boot({ tabs: TABS(), beforeImport: () => { chrome._addGroup({ id: GROUP, title: '', color: 'green', windowId: 1 }); } });
    expect(byTestId('card-title', tile()).textContent).toBe(translate('groupUnnamed', { color: 'green' }));
    expect(byTestId('card-title', tile()).textContent).toBe('Green group');
    expect(tile().dataset.groupColor).toBe('green');
  });

  it('a colour Tabazing doesn\'t know is grey', async () => {
    await boot({ tabs: TABS(), beforeImport: () => { chrome._addGroup({ id: GROUP, title: '', color: 'nope', windowId: 1 }); } });
    expect(tile().dataset.groupColor).toBe('grey');
    expect(byTestId('card-title', tile()).textContent).toBe('Grey group');
  });

  it('a filter (or the Starred filter) keeps the tiles, narrowed to the tabs it lets through', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    switcher.state.filter = 'asleep';
    switcher.state.toSleep.add(tabByTitle(switcher, 'W2').id);
    switcher.state.toSleep.add(tabByTitle(switcher, 'B').id);
    switcher.refresh();
    expect(kinds(switcher)).toEqual(['G', 'B']);
    expect(switcher.state.entries[0].tabs.map((x) => x.title)).toEqual(['W2']);
    expect(byTestId('card-group-count', tile()).textContent).toBe(translate('tabs', { count: 1 }));
  });

  it('Alt+Q steps over a tile as one card; a grouped current tab is "on" its tile', async () => {
    const switcher = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, ...work(2).map((x, i) => ({ ...x, active: i === 0 })), { title: 'B', url: 'https://b.example/' }], ...withGroup() });
    const keys = switcher.state.steps.map((step) => step.key);
    expect(keys).toContain('g' + GROUP);
    expect(switcher.cardKey('t' + tabByTitle(switcher, 'W1').id)).toBe('g' + GROUP);
    const next = switcher.stepKey('t' + tabByTitle(switcher, 'W1').id, 1);
    expect(next).toBe(keys[(keys.indexOf('g' + GROUP) + 1) % keys.length]);
  });

  it('the dropdown tags a grouped tab with its group', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    switcher.state.query = 'w2';
    byTestId('search').value = 'w2';
    switcher.flushSearch();
    const row = allByTestId('dropdown-row-tab')[0];
    expect(byTestId('dropdown-group-tag', row).textContent).toBe('Work');
  });
});

describe('the group view', () => {
  it('a tile\'s click opens it: only its tabs, the group as the heading, nothing else around; it is remembered', async () => {
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'c1', url: 'https://gone.example/', title: 'Gone' } }];
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    expect(byTestId('closed-section').hidden).toBe(false);
    tile().click();
    await waitFor(() => switcher.state.inGroup === GROUP);
    expect(kinds(switcher)).toEqual(['W1', 'W2', 'W3']);
    expect(byTestId('closed-section').hidden).toBe(true);
    expect(byTestId('open-heading').textContent).toBe('Work');
    expect(byTestId('group-leave').hidden).toBe(false);
    expect(byTestId('group-dot').hidden).toBe(false);
    expect(byTestId('group-count').textContent).toBe(translate('tabs', { count: 3 }));
    expect(byTestId('body').classList.contains('in-group')).toBe(true);
    expect(byTestId('body').dataset.groupColor).toBe('blue');
    expect(switcher.state.done).toBe(false); // Tabazing stays
    expect((await stored()).id).toBe(GROUP);
    expect(byTestId('card-group-tag', cardOf('W1'))).toBe(null); // (they are all in it)
  });

  it('Enter and a number key on the tile open it too', async () => {
    for (const press of [() => key('Enter'), () => key('2', { code: 'Digit2', altKey: true })]) {
      chrome._reset();
      const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup() });
      switcher.select(switcher.state.entries.findIndex((entry) => entry.kind === 'group'));
      press();
      await waitFor(() => switcher.state.inGroup === GROUP);
    }
  });

  it('the next open shows the group again, until it is left with "All tabs" (its tile then selected)', async () => {
    const switcher = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    expect(switcher.state.inGroup).toBe(GROUP);
    expect(kinds(switcher)).toEqual(['W1', 'W2', 'W3']);
    byTestId('group-leave').click();
    await waitFor(() => switcher.state.inGroup === null);
    expect(kinds(switcher)).toEqual(['G', 'A', 'B']); // (the current tab is in the group: its tile first)
    expect(switcher.state.entries[switcher.state.selected].kind).toBe('group');
    expect(await stored()).toBe(undefined);
    expect(byTestId('open-heading').textContent).toBe(translate('openTabs'));
    expect(byTestId('group-leave').hidden).toBe(true);
  });

  it('Backspace in the empty search box leaves it; with text it is the box\'s own', async () => {
    const switcher = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    byTestId('search').value = switcher.state.query = 'w';
    expect(key('Backspace').defaultPrevented).toBe(false);
    expect(switcher.state.inGroup).toBe(GROUP);
    byTestId('search').value = switcher.state.query = '';
    expect(key('Backspace').defaultPrevented).toBe(true);
    await waitFor(() => switcher.state.inGroup === null);
  });

  it('Esc goes back one level: out of the group view (as "All tabs"), then Tabazing closes', async () => {
    const switcher = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    expect(byTestId('group-leave-key').textContent).toBe('Esc'); // the "All tabs" button says so
    expect(byTestId('group-leave').title).toBe(translate('groupLeaveTitle'));
    key('Escape');
    await waitFor(() => switcher.state.inGroup === null);
    expect(switcher.state.done).toBe(false);
    await vi.waitFor(async () => expect(await stored()).toBe(undefined));
    key('Escape');
    expect(switcher.state.done).toBe(true);
  });

  it('entering and leaving are said to screen readers', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    tile().click();
    await waitFor(() => switcher.state.inGroup === GROUP);
    expect(byTestId('live-status').textContent).toBe(translate('groupEntered', { name: 'Work', tabs: translate('tabs', { count: 3 }) }));
    byTestId('group-leave').click();
    await waitFor(() => switcher.state.inGroup === null);
    expect(byTestId('live-status').textContent).toBe(translate('groupLeft'));
  });

  it('opened (any way) from a tab outside the remembered group, Tabazing leaves it and shows all the tabs', async () => {
    const switcher = await boot({ tabs: TABS(), context: { direction: 0 }, ...withGroup({ inside: true }) });
    expect(switcher.state.inGroup).toBe(null);
    expect(kinds(switcher)).toEqual(['A', 'G', 'B']);
    await vi.waitFor(async () => expect(await stored()).toBe(undefined));
  });

  it('a remembered group that is gone (ungrouped, its tabs closed) is forgotten', async () => {
    const switcher = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }], beforeImport: () => session.set({ group: { id: 99, t: Date.now() } }) });
    expect(switcher.state.inGroup).toBe(null);
    await waitFor(async () => !(await stored()));
  });

  it('"New tab" in the header opens the tab in the group', async () => {
    await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    byTestId('new-tab').click();
    await waitFor(() => chrome.tabs.group.mock.calls.length > 0);
    const made = chrome.tabs.create.mock.results.at(-1).value;
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: (await made).id, groupId: GROUP });
  });

  it('the palette\'s New tab does the same', async () => {
    const switcher = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    await switcher.runAction(switcher.PALETTE_BY_ID.get('new-tab'));
    await waitFor(() => chrome.tabs.group.mock.calls.length > 0);
    expect(chrome.tabs.group.mock.calls[0][0].groupId).toBe(GROUP);
  });

  it('the palette can leave it', async () => {
    const switcher = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    expect(switcher.paletteActions().map((action) => action.id)).toContain('leave-group');
    await switcher.runAction(switcher.PALETTE_BY_ID.get('leave-group'));
    await waitFor(() => switcher.state.inGroup === null);
    expect(switcher.paletteActions().map((action) => action.id)).not.toContain('leave-group');
  });
});

describe('Alt+Q / Alt+W (Alt held)', () => {
  // The strip: A, W1 W2 (group 7, "Work"), B, V1 V2 (group 8, "Other"). The current tab comes first, then the strip's order.
  const OTHER = 8;
  const STRIP = (active) => [
    { title: 'A', url: 'https://a.example/' },
    { title: 'W1', url: 'https://w1.example/', groupId: GROUP }, { title: 'W2', url: 'https://w2.example/', groupId: GROUP },
    { title: 'B', url: 'https://b.example/' },
    { title: 'V1', url: 'https://v1.example/', groupId: OTHER }, { title: 'V2', url: 'https://v2.example/', groupId: OTHER },
  ].map((x) => ({ ...x, active: x.title === active }));
  const two = (extra = {}) => ({
    beforeImport: async () => {
      chrome._addGroup({ id: GROUP, title: 'Work', color: 'blue', windowId: 1 });
      chrome._addGroup({ id: OTHER, title: 'Other', color: 'red', windowId: 1 });
      if (extra.inside) await session.set({ group: { id: extra.inside, t: Date.now() } });
    },
  });
  const selectedLabel = (switcher) => { const entry = switcher.state.entries[switcher.state.selected]; return entry.kind === 'group' ? 'G' + entry.group.id : entry.tab.title; };

  it('among all the cards a group stays a tile, one step; letting go of Alt on it opens it (and switches to nothing)', async () => {
    const switcher = await boot({ tabs: STRIP('A'), context: { hold: true, direction: 1 }, ...two() });
    expect(kinds(switcher)).toEqual(['A', 'G', 'B', 'G']);
    expect(selectedLabel(switcher)).toBe('G' + GROUP); // the step after A
    switcher.cyclePress(1);
    expect(selectedLabel(switcher)).toBe('B');
    switcher.cyclePress(-1);
    switcher.altReleased();
    await waitFor(() => switcher.state.inGroup === GROUP);
    expect(kinds(switcher)).toEqual(['W1', 'W2']);
    expect(chrome.tabs.update.mock.calls.some(([, properties]) => properties.active)).toBe(false);
    expect(switcher.state.done).toBe(false);
  });

  // ids by creation: A 1, W1 2, W2 3, B 4. From A, W1 was used before it; from W2 (on its group's tile), A was.
  it.each([['A', [1, 2, 4], 1], ['W2', [3, 1, 2], -1]])('letting go of Alt on a tile selects the first of the group\'s cards (from %s)', async (active, mru, direction) => {
    const switcher = await boot({ tabs: STRIP(active), context: { hold: true, direction }, beforeImport: async () => { await two().beforeImport(); await session.set({ mru }); } });
    if (active === 'W2') switcher.cyclePress(1); // from the card before the tile, back onto it
    expect(selectedLabel(switcher)).toBe('G' + GROUP);
    switcher.altReleased();
    await waitFor(() => switcher.state.inGroup === GROUP);
    expect(switcher.state.selected).toBe(0);
    expect(selectedLabel(switcher)).toBe(kinds(switcher)[0]);
  });

  it('inside a group they step through its tabs; letting go switches to that tab', async () => {
    const switcher = await boot({ tabs: STRIP('W1'), context: { hold: true, direction: 1 }, ...two({ inside: GROUP }) });
    expect(switcher.state.inGroup).toBe(GROUP);
    expect(selectedLabel(switcher)).toBe('W2');
    switcher.altReleased();
    await waitFor(() => chrome.tabs.update.mock.calls.some(([id, properties]) => id === tabByTitle(switcher, 'W2').id && properties.active));
    expect((await stored()).id).toBe(GROUP); // still inside it
  });

  it('past the group\'s last tab: out of it, to the card after its tile (a tab: letting go switches there)', async () => {
    const switcher = await boot({ tabs: STRIP('W1'), context: { hold: true, direction: 1 }, ...two({ inside: GROUP }) });
    switcher.cyclePress(1); // past W2, the last one
    expect(switcher.state.inGroup).toBe(null);
    expect(kinds(switcher)).toEqual(['G', 'A', 'B', 'G']); // all the cards again (the current tab's group first)
    expect(selectedLabel(switcher)).toBe('A');
    expect(byTestId('body').classList.contains('in-group')).toBe(false);
    expect((await stored()).id).toBe(GROUP); // still remembered: only switching outside it (next open) or Esc there leaves it
    switcher.altReleased();
    await waitFor(() => chrome.tabs.update.mock.calls.some(([id, properties]) => id === tabByTitle(switcher, 'A').id && properties.active));
  });

  it('before the group\'s first tab: out of it, to the card before its tile, here another group, not opened until Alt is let go', async () => {
    const switcher = await boot({ tabs: STRIP('W1'), context: { hold: true, direction: -1 }, ...two({ inside: GROUP }) });
    // From W1, the group's first tab, the opening Alt+Q steps out: before the tile (first) comes, wrapping, the last card.
    expect(switcher.state.inGroup).toBe(null);
    expect(selectedLabel(switcher)).toBe('G' + OTHER);
    expect(tile()).not.toBe(null);
    switcher.altReleased();
    await waitFor(() => switcher.state.inGroup === OTHER);
    expect(kinds(switcher)).toEqual(['V1', 'V2']);
    expect((await stored()).id).toBe(OTHER);
  });

  // By recent use (the Sort's default), inside a group as anywhere: the tab you just came to is first, so "next"
  // (Alt+W) goes back to the one you were on before it, then on to the less recently used ones, then out.
  it('inside a group, by recent use: after going from W1 to W3, Alt+W goes back to W1, then W2, then out', async () => {
    const tabs = [{ title: 'A', url: 'https://a.example/' }, ...['W1', 'W2', 'W3'].map((title) => ({ title, url: `https://${title.toLowerCase()}.example/`, groupId: GROUP, active: title === 'W3' }))];
    // ids by creation: A 1, W1 2, W2 3, W3 4. Used last: W3 (now), W1 before it, then A, then W2.
    const switcher = await boot({ tabs, context: { hold: true, direction: 1 }, beforeImport: async () => { await two({ inside: GROUP }).beforeImport(); await session.set({ mru: [4, 2, 1, 3] }); } });
    expect(kinds(switcher)).toEqual(['W3', 'W1', 'W2']); // the group view, most recently used first
    expect(selectedLabel(switcher)).toBe('W1'); // the opening Alt+W: the tab used before this one
    switcher.cyclePress(1);
    expect(selectedLabel(switcher)).toBe('W2');
    switcher.cyclePress(1); // past the group's last tab: out, to the card after its tile
    expect(switcher.state.inGroup).toBe(null);
    expect(selectedLabel(switcher)).toBe('A');
    switcher.cyclePress(-1); // and back: the tile (not opened while Alt is held)
    expect(selectedLabel(switcher)).toBe('G' + GROUP);
  });

  it('a group of one tab: either way out of it', async () => {
    const switcher = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'W1', url: 'https://w1.example/', groupId: GROUP, active: true }, { title: 'B', url: 'https://b.example/' }], context: { hold: true, direction: 1 }, ...two({ inside: GROUP }) });
    expect(switcher.state.inGroup).toBe(null);
    expect(selectedLabel(switcher)).toBe('A');
  });

  it('pressed in an open group view, the same: within it, then out at its ends', async () => {
    const switcher = await boot({ tabs: STRIP('W1'), context: { direction: 0 }, ...two({ inside: GROUP }) });
    expect(selectedLabel(switcher)).toBe('W1');
    switcher.cyclePress(1);
    expect(selectedLabel(switcher)).toBe('W2');
    switcher.cyclePress(-1);
    switcher.cyclePress(-1); // before W1
    expect(switcher.state.inGroup).toBe(null);
    expect(selectedLabel(switcher)).toBe('G' + OTHER);
  });

  it('from a tab outside the group it was inside of (you went elsewhere in Chrome): among all the cards, the group left', async () => {
    const switcher = await boot({ tabs: STRIP('B'), context: { hold: true, direction: 1 }, ...two({ inside: GROUP }) });
    expect(switcher.state.inGroup).toBe(null);
    expect(kinds(switcher)).toEqual(['B', 'A', 'G', 'G']);
    expect(selectedLabel(switcher)).toBe('A');
    await vi.waitFor(async () => expect(await stored()).toBe(undefined));
  });
});

describe('Settings -> Show tab groups as tiles', () => {
  const toggle = async (on) => {
    if (!byTestId('settings-show-groups')) byTestId('settings-button').click(); // (the gear again would close it)
    await waitFor(() => byTestId('settings-show-groups'));
    const box = byTestId('settings-show-groups');
    box.checked = on;
    box.dispatchEvent(new Event('change'));
  };

  it('on by default, in the Cards category, with a note', async () => {
    await boot({ tabs: TABS(), ...withGroup() });
    byTestId('settings-button').click();
    await waitFor(() => byTestId('settings-show-groups'));
    expect(byTestId('settings-show-groups').checked).toBe(true);
    expect(byTestId('settings-panel-cards').contains(byTestId('settings-show-groups'))).toBe(true);
    expect(byTestId('settings-show-groups-label').textContent).toBe(translate('settingsShowGroups'));
    expect(byTestId('settings-show-groups-note').textContent).toBe(translate('settingsShowGroupsNote'));
  });

  it('off: every tab its own card again (tagged with its group), and it is saved', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    await toggle(false);
    await waitFor(() => !tile());
    expect(kinds(switcher)).toEqual(['A', 'W1', 'W2', 'W3', 'B']);
    expect(byTestId('card-group-tag', cardOf('W1')).textContent).toBe('Work');
    expect(switcher.state.steps.every((step) => step.kind === 'tab')).toBe(true);
    await vi.waitFor(async () => expect((await chrome.storage.local.get('prefs')).prefs.showGroups).toBe(false));
    await toggle(true);
    await waitFor(() => tile());
  });

  it('off while inside a group: out of it, for good (on again, it doesn\'t jump back in)', async () => {
    const switcher = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    expect(switcher.state.inGroup).toBe(GROUP);
    await toggle(false);
    await waitFor(() => switcher.state.inGroup === null && !byTestId('body').classList.contains('in-group'));
    await vi.waitFor(async () => expect(await stored()).toBe(undefined));
    await toggle(true);
    await waitFor(() => tile());
    expect(switcher.state.inGroup).toBe(null);
  });

  it('off from the start: a remembered group isn\'t shown either', async () => {
    const switcher = await boot({ tabs: INSIDE(), preferences: { showGroups: false }, ...withGroup({ inside: true }) });
    expect(switcher.state.inGroup).toBe(null);
    expect(tile()).toBe(null);
  });
});

describe('a tile\'s menu', () => {
  const openMenu = (switcher) => { switcher.select(switcher.state.entries.findIndex((entry) => entry.kind === 'group')); key('F10', { shiftKey: true }); };
  const item = (label) => allByTestId('menu-item').find((button) => button.textContent === label);

  it('open, name and colour, copy, bookmark, move to a new window, collapse, sleep, mute, snooze, archive, ungroup, close', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    openMenu(switcher);
    expect(allByTestId('menu-item').map((button) => button.textContent)).toEqual([
      translate('groupOpen'), translate('groupEdit'), translate('actionCopy'), translate('markMenu'), translate('groupToWindow'), translate('groupCollapse'), translate('actionSleep'), translate('actionMute'),
      translate('actionSnooze'), translate('actionArchive'), translate('groupUngroup'), translate('groupClose'),
    ]);
  });

  it('Ungroup: the tabs stay open, as cards of their own', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    openMenu(switcher);
    item(translate('groupUngroup')).click();
    await waitFor(() => !tile());
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith(work().map((x) => tabByTitle(switcher, x.title).id));
    expect(kinds(switcher)).toEqual(['A', 'W1', 'W2', 'W3', 'B']);
  });

  it('Close group closes its tabs; Undo opens them again, in a group of the same name and colour', async () => {
    const switcher = await boot({ tabs: TABS(), ...withGroup() });
    openMenu(switcher);
    item(translate('groupClose')).click();
    await waitFor(() => chrome._data.tabs.length === 2);
    toastButton().click();
    await waitFor(() => chrome._data.tabs.length === 5 && chrome._data.groups.length === 1);
    const group = chrome._data.groups[0];
    expect(group).toMatchObject({ title: 'Work', color: 'blue' });
    expect(chrome._data.tabs.filter((x) => x.groupId === group.id).map((x) => x.url).sort()).toEqual(work().map((x) => x.url));
    await tick(50);
  });
});

describe('a tile looks like a tab group (styles/switcher.css)', () => {
  it('framed in the group colour, its name on a chip of that colour; its picture has no frame of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/\.card\.group-tile \{ border: 2px solid var\(--group-color\);/);
    expect(css).toMatch(/\.group-tile \.head \.title, html\.lines2[^{]*\{[^}]*background: var\(--group-color\); color: var\(--on-group-color\);/);
    expect(css).not.toMatch(/\.group-tile \.group-mosaic \{[^}]*box-shadow/);
    expect(css).toMatch(/html\.light \[data-group-color\] \{ --on-group-color: #fff; \}/);
  });
});
