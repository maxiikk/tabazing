// Tab groups: a tile per Chrome tab group among the cards (its first four tabs as its picture), the group view
// its tile opens (only that group's tabs, remembered for every open until it is left), and what a tile's menu does.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, tabByTitle, toastButton } from './quiet-boot.js';
import { t } from '../../utils/translations.js';

const S = chrome.storage.session;
const GROUP = 7;
const work = (n = 3) => Array.from({ length: n }, (_, i) => ({ title: 'W' + (i + 1), url: `https://w${i + 1}.example/`, groupId: GROUP }));
const TABS = (n = 3) => [{ title: 'A', url: 'https://a.example/' }, ...work(n), { title: 'B', url: 'https://b.example/' }];
// The same, the current tab one in the group (opened from outside it, Tabazing leaves a remembered group).
const INSIDE = (n = 3) => TABS(n).map((x) => ({ ...x, active: x.title === 'W1' }));
const withGroup = (extra = {}) => ({
  beforeImport: async () => {
    chrome._addGroup({ id: GROUP, title: 'Work', color: 'blue', windowId: 1 });
    if (extra.inside) await S.set({ group: { id: GROUP, t: Date.now() } });
  },
});
const tile = () => tid('card-group');
const kinds = (sw) => sw.state.entries.filter((e) => e.kind === 'tab' || e.kind === 'group').map((e) => (e.kind === 'group' ? 'G' : e.tab.title));
const stored = async () => (await S.get('group')).group;

describe('group tiles', () => {
  it('a group\'s tabs show as one tile, where its first tab would be', async () => {
    const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup() });
    expect(kinds(sw)).toEqual(['A', 'G', 'B']);
    expect(tids('card-group')).toHaveLength(1);
    expect(tid('card-title', tile()).textContent).toBe('Work');
    expect(tid('card-group-count', tile()).textContent).toBe(t('tabs', { count: 3 }));
    expect(tile().dataset.gc).toBe('blue');
    expect(tile().getAttribute('aria-label')).toBe(t('groupAria', { name: 'Work', tabs: t('tabs', { count: 3 }) }));
    expect(tile().getAttribute('role')).toBe('option');
    expect(cardOf('W1')).toBe(undefined); // its tabs have no cards of their own
    expect(sw.state.matchCount).toBe(5); // ...but they count, and "Select all" takes them
  });

  it.each([1, 2, 3, 4])('its picture with %i tab(s): that many cells, no empty placeholders', async (n) => {
    await boot({ tabs: TABS(n), ...withGroup() });
    expect(tids('card-group-cell', tile())).toHaveLength(n);
    expect(tid('card-thumb', tile()).classList.contains('n' + n)).toBe(true); // (switcher.css lays each count out)
    expect(tid('card-group-more', tile())).toBe(null);
  });

  it('its picture: the first four tabs, two by two, "+N" for the rest', async () => {
    await boot({ tabs: TABS(6), ...withGroup() });
    expect(tids('card-group-cell', tile())).toHaveLength(4);
    expect(tid('card-group-more', tile()).textContent).toBe(t('groupMoreN', { count: 2 }));
    expect(tile().title.split('\n')[0]).toBe(t('groupTip', { name: 'Work' }));
  });

  it('the stylesheet fills the picture with one cell, two side by side, three as one big and two small', () => {
    const css = readFileSync(resolve(process.cwd(), 'styles/switcher.css'), 'utf8');
    expect(css).toContain('.gtile .gmosaic.n1 { grid-template: 1fr / 1fr; }');
    expect(css).toContain('.gtile .gmosaic.n2 { grid-template: 1fr / 1fr 1fr; }');
    expect(css).toContain('.gtile .gmosaic.n3 > .gcell:first-child { grid-row: span 2; }');
    expect(css).not.toContain('.gcell.empty');
  });

  it('a group without a name is called by its colour, as Chrome shows it ("Green group")', async () => {
    await boot({ tabs: TABS(), beforeImport: () => { chrome._addGroup({ id: GROUP, title: '', color: 'green', windowId: 1 }); } });
    expect(tid('card-title', tile()).textContent).toBe(t('groupUnnamed', { color: 'green' }));
    expect(tid('card-title', tile()).textContent).toBe('Green group');
    expect(tile().dataset.gc).toBe('green');
  });

  it('a colour Tabazing doesn\'t know is grey', async () => {
    await boot({ tabs: TABS(), beforeImport: () => { chrome._addGroup({ id: GROUP, title: '', color: 'nope', windowId: 1 }); } });
    expect(tile().dataset.gc).toBe('grey');
    expect(tid('card-title', tile()).textContent).toBe('Grey group');
  });

  it('a filter (or the Starred filter) keeps the tiles, narrowed to the tabs it lets through', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    sw.state.filter = 'asleep';
    sw.state.toSleep.add(tabByTitle(sw, 'W2').id);
    sw.state.toSleep.add(tabByTitle(sw, 'B').id);
    sw.refresh();
    expect(kinds(sw)).toEqual(['G', 'B']);
    expect(sw.state.entries[0].tabs.map((x) => x.title)).toEqual(['W2']);
    expect(tid('card-group-count', tile()).textContent).toBe(t('tabs', { count: 1 }));
  });

  it('Alt+Q steps over a tile as one card; a grouped current tab is "on" its tile', async () => {
    const sw = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, ...work(2).map((x, i) => ({ ...x, active: i === 0 })), { title: 'B', url: 'https://b.example/' }], ...withGroup() });
    const keys = sw.state.steps.map((e) => e.key);
    expect(keys).toContain('g' + GROUP);
    expect(sw.cardKey('t' + tabByTitle(sw, 'W1').id)).toBe('g' + GROUP);
    const next = sw.stepKey('t' + tabByTitle(sw, 'W1').id, 1);
    expect(next).toBe(keys[(keys.indexOf('g' + GROUP) + 1) % keys.length]);
  });

  it('the dropdown tags a grouped tab with its group', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    sw.state.query = 'w2';
    tid('search').value = 'w2';
    sw.flushSearch();
    const row = tids('dd-row-tab')[0];
    expect(tid('dd-group-tag', row).textContent).toBe('Work');
  });
});

describe('the group view', () => {
  it('a tile\'s click opens it: only its tabs, the group as the heading, nothing else around; it is remembered', async () => {
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'c1', url: 'https://gone.example/', title: 'Gone' } }];
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    expect(tid('closed-section').hidden).toBe(false);
    tile().click();
    await waitFor(() => sw.state.inGroup === GROUP);
    expect(kinds(sw)).toEqual(['W1', 'W2', 'W3']);
    expect(tid('closed-section').hidden).toBe(true);
    expect(tid('open-h').textContent).toBe('Work');
    expect(tid('group-leave').hidden).toBe(false);
    expect(tid('group-dot').hidden).toBe(false);
    expect(tid('group-count').textContent).toBe(t('tabs', { count: 3 }));
    expect(tid('body').classList.contains('in-group')).toBe(true);
    expect(tid('body').dataset.gc).toBe('blue');
    expect(sw.state.done).toBe(false); // Tabazing stays
    expect((await stored()).id).toBe(GROUP);
    expect(tid('card-group-tag', cardOf('W1'))).toBe(null); // (they are all in it)
  });

  it('Enter and a number key on the tile open it too', async () => {
    for (const press of [() => key('Enter'), () => key('2', { code: 'Digit2', altKey: true })]) {
      chrome._reset();
      const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup() });
      sw.select(sw.state.entries.findIndex((e) => e.kind === 'group'));
      press();
      await waitFor(() => sw.state.inGroup === GROUP);
    }
  });

  it('the next open shows the group again, until it is left with "All tabs" (its tile then selected)', async () => {
    const sw = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    expect(sw.state.inGroup).toBe(GROUP);
    expect(kinds(sw)).toEqual(['W1', 'W2', 'W3']);
    tid('group-leave').click();
    await waitFor(() => sw.state.inGroup === null);
    expect(kinds(sw)).toEqual(['G', 'A', 'B']); // (the current tab is in the group: its tile first)
    expect(sw.state.entries[sw.state.sel].kind).toBe('group');
    expect(await stored()).toBe(undefined);
    expect(tid('open-h').textContent).toBe(t('openTabs'));
    expect(tid('group-leave').hidden).toBe(true);
  });

  it('Backspace in the empty search box leaves it; with text it is the box\'s own', async () => {
    const sw = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    tid('search').value = sw.state.query = 'w';
    expect(key('Backspace').defaultPrevented).toBe(false);
    expect(sw.state.inGroup).toBe(GROUP);
    tid('search').value = sw.state.query = '';
    expect(key('Backspace').defaultPrevented).toBe(true);
    await waitFor(() => sw.state.inGroup === null);
  });

  it('Esc goes back one level: out of the group view (as "All tabs"), then Tabazing closes', async () => {
    const sw = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    expect(tid('group-leave-key').textContent).toBe('Esc'); // the "All tabs" button says so
    expect(tid('group-leave').title).toBe(t('groupLeaveTitle'));
    key('Escape');
    await waitFor(() => sw.state.inGroup === null);
    expect(sw.state.done).toBe(false);
    await vi.waitFor(async () => expect(await stored()).toBe(undefined));
    key('Escape');
    expect(sw.state.done).toBe(true);
  });

  it('entering and leaving are said to screen readers', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    tile().click();
    await waitFor(() => sw.state.inGroup === GROUP);
    expect(tid('live-status').textContent).toBe(t('groupEntered', { name: 'Work', tabs: t('tabs', { count: 3 }) }));
    tid('group-leave').click();
    await waitFor(() => sw.state.inGroup === null);
    expect(tid('live-status').textContent).toBe(t('groupLeft'));
  });

  it('opened (any way) from a tab outside the remembered group, Tabazing leaves it and shows all the tabs', async () => {
    const sw = await boot({ tabs: TABS(), ctx: { dir: 0 }, ...withGroup({ inside: true }) });
    expect(sw.state.inGroup).toBe(null);
    expect(kinds(sw)).toEqual(['A', 'G', 'B']);
    await vi.waitFor(async () => expect(await stored()).toBe(undefined));
  });

  it('a remembered group that is gone (ungrouped, its tabs closed) is forgotten', async () => {
    const sw = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }], beforeImport: () => S.set({ group: { id: 99, t: Date.now() } }) });
    expect(sw.state.inGroup).toBe(null);
    await waitFor(async () => !(await stored()));
  });

  it('"New tab" in the header opens the tab in the group', async () => {
    await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    tid('newtab').click();
    await waitFor(() => chrome.tabs.group.mock.calls.length > 0);
    const made = chrome.tabs.create.mock.results.at(-1).value;
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: (await made).id, groupId: GROUP });
  });

  it('the palette\'s New tab does the same', async () => {
    const sw = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    await sw.runAction(sw.PAL_BY_ID.get('new-tab'));
    await waitFor(() => chrome.tabs.group.mock.calls.length > 0);
    expect(chrome.tabs.group.mock.calls[0][0].groupId).toBe(GROUP);
  });

  it('the palette can leave it', async () => {
    const sw = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    expect(sw.paletteActions().map((a) => a.id)).toContain('leave-group');
    await sw.runAction(sw.PAL_BY_ID.get('leave-group'));
    await waitFor(() => sw.state.inGroup === null);
    expect(sw.paletteActions().map((a) => a.id)).not.toContain('leave-group');
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
      if (extra.inside) await S.set({ group: { id: extra.inside, t: Date.now() } });
    },
  });
  const sel = (sw) => { const e = sw.state.entries[sw.state.sel]; return e.kind === 'group' ? 'G' + e.group.id : e.tab.title; };

  it('among all the cards a group stays a tile, one step; letting go of Alt on it opens it (and switches to nothing)', async () => {
    const sw = await boot({ tabs: STRIP('A'), ctx: { hold: true, dir: 1 }, ...two() });
    expect(kinds(sw)).toEqual(['A', 'G', 'B', 'G']);
    expect(sel(sw)).toBe('G' + GROUP); // the step after A
    sw.qPress(1);
    expect(sel(sw)).toBe('B');
    sw.qPress(-1);
    sw.altReleased();
    await waitFor(() => sw.state.inGroup === GROUP);
    expect(kinds(sw)).toEqual(['W1', 'W2']);
    expect(chrome.tabs.update.mock.calls.some(([, p]) => p.active)).toBe(false);
    expect(sw.state.done).toBe(false);
  });

  it('inside a group they step through its tabs; letting go switches to that tab', async () => {
    const sw = await boot({ tabs: STRIP('W1'), ctx: { hold: true, dir: 1 }, ...two({ inside: GROUP }) });
    expect(sw.state.inGroup).toBe(GROUP);
    expect(sel(sw)).toBe('W2');
    sw.altReleased();
    await waitFor(() => chrome.tabs.update.mock.calls.some(([id, p]) => id === tabByTitle(sw, 'W2').id && p.active));
    expect((await stored()).id).toBe(GROUP); // still inside it
  });

  it('past the group\'s last tab: out of it, to the card after its tile (a tab: letting go switches there)', async () => {
    const sw = await boot({ tabs: STRIP('W1'), ctx: { hold: true, dir: 1 }, ...two({ inside: GROUP }) });
    sw.qPress(1); // past W2, the last one
    expect(sw.state.inGroup).toBe(null);
    expect(kinds(sw)).toEqual(['G', 'A', 'B', 'G']); // all the cards again (the current tab's group first)
    expect(sel(sw)).toBe('A');
    expect(tid('body').classList.contains('in-group')).toBe(false);
    expect((await stored()).id).toBe(GROUP); // still remembered: only switching outside it (next open) or Esc there leaves it
    sw.altReleased();
    await waitFor(() => chrome.tabs.update.mock.calls.some(([id, p]) => id === tabByTitle(sw, 'A').id && p.active));
  });

  it('before the group\'s first tab: out of it, to the card before its tile, here another group, not opened until Alt is let go', async () => {
    const sw = await boot({ tabs: STRIP('W1'), ctx: { hold: true, dir: -1 }, ...two({ inside: GROUP }) });
    // From W1, the group's first tab, the opening Alt+Q steps out: before the tile (first) comes, wrapping, the last card.
    expect(sw.state.inGroup).toBe(null);
    expect(sel(sw)).toBe('G' + OTHER);
    expect(tile()).not.toBe(null);
    sw.altReleased();
    await waitFor(() => sw.state.inGroup === OTHER);
    expect(kinds(sw)).toEqual(['V1', 'V2']);
    expect((await stored()).id).toBe(OTHER);
  });

  // By recent use (the Sort's default), inside a group as anywhere: the tab you just came to is first, so "next"
  // (Alt+W) goes back to the one you were on before it, then on to the less recently used ones, then out.
  it('inside a group, by recent use: after going from W1 to W3, Alt+W goes back to W1, then W2, then out', async () => {
    const tabs = [{ title: 'A', url: 'https://a.example/' }, ...['W1', 'W2', 'W3'].map((title) => ({ title, url: `https://${title.toLowerCase()}.example/`, groupId: GROUP, active: title === 'W3' }))];
    // ids by creation: A 1, W1 2, W2 3, W3 4. Used last: W3 (now), W1 before it, then A, then W2.
    const sw = await boot({ tabs, ctx: { hold: true, dir: 1 }, beforeImport: async () => { await two({ inside: GROUP }).beforeImport(); await S.set({ mru: [4, 2, 1, 3] }); } });
    expect(kinds(sw)).toEqual(['W3', 'W1', 'W2']); // the group view, most recently used first
    expect(sel(sw)).toBe('W1'); // the opening Alt+W: the tab used before this one
    sw.qPress(1);
    expect(sel(sw)).toBe('W2');
    sw.qPress(1); // past the group's last tab: out, to the card after its tile
    expect(sw.state.inGroup).toBe(null);
    expect(sel(sw)).toBe('A');
    sw.qPress(-1); // and back: the tile (not opened while Alt is held)
    expect(sel(sw)).toBe('G' + GROUP);
  });

  it('a group of one tab: either way out of it', async () => {
    const sw = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'W1', url: 'https://w1.example/', groupId: GROUP, active: true }, { title: 'B', url: 'https://b.example/' }], ctx: { hold: true, dir: 1 }, ...two({ inside: GROUP }) });
    expect(sw.state.inGroup).toBe(null);
    expect(sel(sw)).toBe('A');
  });

  it('pressed in an open group view, the same: within it, then out at its ends', async () => {
    const sw = await boot({ tabs: STRIP('W1'), ctx: { dir: 0 }, ...two({ inside: GROUP }) });
    expect(sel(sw)).toBe('W1');
    sw.qPress(1);
    expect(sel(sw)).toBe('W2');
    sw.qPress(-1);
    sw.qPress(-1); // before W1
    expect(sw.state.inGroup).toBe(null);
    expect(sel(sw)).toBe('G' + OTHER);
  });

  it('from a tab outside the group it was inside of (you went elsewhere in Chrome): among all the cards, the group left', async () => {
    const sw = await boot({ tabs: STRIP('B'), ctx: { hold: true, dir: 1 }, ...two({ inside: GROUP }) });
    expect(sw.state.inGroup).toBe(null);
    expect(kinds(sw)).toEqual(['B', 'A', 'G', 'G']);
    expect(sel(sw)).toBe('A');
    await vi.waitFor(async () => expect(await stored()).toBe(undefined));
  });
});

describe('Settings -> Show tab groups as tiles', () => {
  const toggle = async (on) => {
    if (!tid('settings-show-groups')) tid('settings-btn').click(); // (the gear again would close it)
    await waitFor(() => tid('settings-show-groups'));
    const box = tid('settings-show-groups');
    box.checked = on;
    box.dispatchEvent(new Event('change'));
  };

  it('on by default, in the Cards category, with a note', async () => {
    await boot({ tabs: TABS(), ...withGroup() });
    tid('settings-btn').click();
    await waitFor(() => tid('settings-show-groups'));
    expect(tid('settings-show-groups').checked).toBe(true);
    expect(tid('settings-panel-cards').contains(tid('settings-show-groups'))).toBe(true);
    expect(tid('settings-show-groups-label').textContent).toBe(t('setShowGroups'));
    expect(tid('settings-show-groups-note').textContent).toBe(t('setShowGroupsNote'));
  });

  it('off: every tab its own card again (tagged with its group), and it is saved', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    await toggle(false);
    await waitFor(() => !tile());
    expect(kinds(sw)).toEqual(['A', 'W1', 'W2', 'W3', 'B']);
    expect(tid('card-group-tag', cardOf('W1')).textContent).toBe('Work');
    expect(sw.state.steps.every((e) => e.kind === 'tab')).toBe(true);
    await vi.waitFor(async () => expect((await chrome.storage.local.get('prefs')).prefs.showGroups).toBe(false));
    await toggle(true);
    await waitFor(() => tile());
  });

  it('off while inside a group: out of it, for good (on again, it doesn\'t jump back in)', async () => {
    const sw = await boot({ tabs: INSIDE(), ...withGroup({ inside: true }) });
    expect(sw.state.inGroup).toBe(GROUP);
    await toggle(false);
    await waitFor(() => sw.state.inGroup === null && !tid('body').classList.contains('in-group'));
    await vi.waitFor(async () => expect(await stored()).toBe(undefined));
    await toggle(true);
    await waitFor(() => tile());
    expect(sw.state.inGroup).toBe(null);
  });

  it('off from the start: a remembered group isn\'t shown either', async () => {
    const sw = await boot({ tabs: INSIDE(), prefs: { showGroups: false }, ...withGroup({ inside: true }) });
    expect(sw.state.inGroup).toBe(null);
    expect(tile()).toBe(null);
  });
});

describe('a tile\'s menu', () => {
  const openMenu = (sw) => { sw.select(sw.state.entries.findIndex((e) => e.kind === 'group')); key('F10', { shiftKey: true }); };
  const item = (label) => tids('menu-item').find((b) => b.textContent === label);

  it('open, name and colour, copy, bookmark, move to a new window, collapse, sleep, mute, snooze, archive, ungroup, close', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    openMenu(sw);
    expect(tids('menu-item').map((b) => b.textContent)).toEqual([
      t('groupOpen'), t('groupEdit'), t('actCopy'), t('markMenu'), t('groupToWindow'), t('groupCollapse'), t('actSleep'), t('actMute'),
      t('actSnooze'), t('actArchive'), t('groupUngroup'), t('groupClose'),
    ]);
  });

  it('Ungroup: the tabs stay open, as cards of their own', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    openMenu(sw);
    item(t('groupUngroup')).click();
    await waitFor(() => !tile());
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith(work().map((x) => tabByTitle(sw, x.title).id));
    expect(kinds(sw)).toEqual(['A', 'W1', 'W2', 'W3', 'B']);
  });

  it('Close group closes its tabs; Undo opens them again, in a group of the same name and colour', async () => {
    const sw = await boot({ tabs: TABS(), ...withGroup() });
    openMenu(sw);
    item(t('groupClose')).click();
    await waitFor(() => chrome._data.tabs.length === 2);
    toastButton().click();
    await waitFor(() => chrome._data.tabs.length === 5 && chrome._data.groups.length === 1);
    const g = chrome._data.groups[0];
    expect(g).toMatchObject({ title: 'Work', color: 'blue' });
    expect(chrome._data.tabs.filter((x) => x.groupId === g.id).map((x) => x.url).sort()).toEqual(work().map((x) => x.url));
    await tick(50);
  });
});

describe('a tile looks like a tab group (styles/switcher.css)', () => {
  it('framed in the group colour, its name on a chip of that colour, its picture in a frame of it', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/\.card\.gtile \{ border: 2px solid var\(--gc\);/);
    expect(css).toMatch(/\.gtile \.head \.title, html\.lines2[^{]*\{[^}]*background: var\(--gc\); color: var\(--on-gc\);/);
    expect(css).toMatch(/\.gtile \.gmosaic \{[^}]*box-shadow: 0 0 0 2px color-mix\(in srgb, var\(--gc\) 70%/);
    expect(css).toMatch(/html\.light \[data-gc\] \{ --on-gc: #fff; \}/);
  });
});
