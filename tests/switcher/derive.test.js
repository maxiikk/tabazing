// What the switcher reads (tabs, windows, recently closed) and how it turns that into cards: filters, sorts,
// sections, snoozed and closed parts, duplicates, card sizes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootSwitcher } from '../helpers/switcher.js';

let sw;
const HOUR = 3600e3;
const tab = (title, url, more = {}) => ({ title, url, ...more });
const keys = () => sw.state.entries.map((e) => e.key);
const titles = (list = sw.state.entries) => list.map((e) => (e.tab || e.item).title);
const preview = (t = 1) => ({ img: 'data:image/jpeg;base64,AAAA', t });
// Retire each booted module: its delayed redraw (after the opening animation) must not run once the test's page is gone.
afterEach(() => { if (sw) sw.state.done = true; });

describe('helpers', () => {
  beforeEach(async () => { sw = await bootSwitcher(); });

  it('urlOf, hostOf, siteOf, favicon', () => {
    expect(sw.urlOf({ url: 'https://a.com/' })).toBe('https://a.com/');
    expect(sw.urlOf({ url: '', pendingUrl: 'https://p.com/' })).toBe('https://p.com/');
    expect(sw.urlOf(null)).toBe('');
    expect(sw.hostOf('https://www.a.com:8080/x')).toBe('www.a.com:8080');
    expect(sw.hostOf('file:///c/x.txt')).toBe('file');
    expect(sw.hostOf('nope')).toBe('');
    expect(sw.siteOf('https://www.a.com/x')).toBe('a.com');
    expect(sw.favicon('https://a.com/?q=1&b')).toBe(chrome.runtime.getURL('/_favicon/') + '?pageUrl=https%3A%2F%2Fa.com%2F%3Fq%3D1%26b&size=32');
  });

  it('h builds an element with text, never HTML', () => {
    const n = sw.h('div', 'a b', '<i>x</i>');
    expect(n.className).toBe('a b');
    expect(n.textContent).toBe('<i>x</i>');
    expect(n.children.length).toBe(0);
    expect(sw.h('span').textContent).toBe('');
  });

  it('hashOf is stable and short', () => {
    expect(sw.hashOf('https://a.com/')).toBe(sw.hashOf('https://a.com/'));
    expect(sw.hashOf('https://a.com/')).not.toBe(sw.hashOf('https://b.com/'));
    expect(sw.hashOf('')).toBe((5381).toString(36));
    expect(sw.hashOf('x'.repeat(5000))).toMatch(/^[0-9a-z]+$/);
  });

  it('isStarred and noteOf go by the normalized address', () => {
    sw.state.stars = { 'https://a.com/x': { u: 'https://a.com/x/', ti: 'A', t: 1 } };
    sw.state.notes = { 'https://a.com/x': { u: 'https://a.com/x', n: 'hi', t: 1 } };
    expect(sw.isStarred('https://a.com/x/#top')).toBe(true);
    expect(sw.isStarred('https://b.com/')).toBe(false);
    expect(sw.noteOf('https://a.com/x/')).toBe('hi');
    expect(sw.noteOf('https://b.com/')).toBe('');
  });

  it('byTitle sorts by title (or site), ignoring case, numbers by value', () => {
    const e = (title, url = 'https://z.com/') => ({ tab: { title, url } });
    const list = [e('b'), e('c10'), e('A'), e('c9'), e('', 'https://www.m.com/')];
    expect(list.sort(sw.byTitle).map((x) => x.tab.title || 'site')).toEqual(['A', 'b', 'c9', 'c10', 'site']);
  });

  it('winRank puts this window first; SORTERS.order follows the tab strip', () => {
    expect(sw.winRank({ windowId: 1 })).toBe(-1);
    expect(sw.winRank({ windowId: 7 })).toBe(7);
    const e = (windowId, index) => ({ tab: { windowId, index } });
    const list = [e(3, 0), e(2, 1), e(1, 2), e(2, 0), e(1, 0)];
    expect(list.sort(sw.SORTERS.order).map((x) => [x.tab.windowId, x.tab.index])).toEqual([[1, 0], [1, 2], [2, 0], [2, 1], [3, 0]]);
    expect(sw.SORTERS.recent).toBeUndefined(); // state.tabs is already in recent-use order
  });

  it('FILTERS test tabs', () => {
    const F = sw.FILTERS;
    expect(F.audio.test({ audible: true })).toBe(true);
    expect(F.audio.test({ audible: false, mutedInfo: { muted: true } })).toBe(true);
    expect(F.audio.test({ audible: false, mutedInfo: { muted: false } })).toBe(false);
    expect(F.pinned.test({ pinned: true })).toBe(true);
    expect(F.asleep.test({ id: 5, discarded: true })).toBe(true);
    sw.state.toSleep.add(6);
    expect(F.asleep.test({ id: 6, discarded: false })).toBe(true);
    expect(F.asleep.test({ id: 7, discarded: false })).toBe(false);
    sw.state.notes = { 'https://n.com/': { u: 'https://n.com/', n: 'x', t: 1 } };
    expect(F.note.test({ url: 'https://n.com/' })).toBe(true);
    expect(F.note.test({ url: 'https://o.com/' })).toBe(false);
  });

  it('tabAge shows whole days since last viewed, else nothing', () => {
    expect(sw.tabAge({ lastAccessed: Date.now() - 3 * sw.DAY_MS - 1000 }).textContent).toBe('3 days ago');
    expect(sw.tabAge({ lastAccessed: Date.now() - 1.5 * sw.DAY_MS }).textContent).toBe('1 day ago');
    expect(sw.tabAge({ lastAccessed: Date.now() - 23 * HOUR })).toBeNull();
    expect(sw.tabAge({})).toBeNull();
  });

  it('canCapture: a web page that isn’t asleep, refused or without site access', () => {
    const t = { url: 'https://a.com/', discarded: false };
    expect(sw.canCapture(t)).toBe(true);
    expect(sw.canCapture({ ...t, discarded: true })).toBe(false);
    expect(sw.canCapture({ url: 'chrome://settings/' })).toBe(false);
    expect(sw.canCapture({ url: 'https://chromewebstore.google.com/detail/x' })).toBe(false);
    sw.state.nocap = new Set(['https://a.com/']);
    expect(sw.canCapture(t)).toBe(false);
    sw.state.nocap = new Set();
    sw.state.hostOk = false;
    expect(sw.canCapture(t)).toBe(false);
  });

  it('plainCaptureError puts Chrome’s errors in plain words', () => {
    expect(sw.plainCaptureError('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND exceeded')).toBeNull();
    expect(sw.plainCaptureError('Either the \'<all_urls>\' or \'activeTab\' permission is required.')).toMatchObject({ fix: true });
    expect(sw.plainCaptureError('Cannot access a chrome:// URL')).toEqual({ text: expect.stringMatching(/kind of page/) });
    expect(sw.plainCaptureError(undefined)).toEqual({ text: expect.stringMatching(/couldn’t/) });
  });

  it('snoozeChoices: in 1 h, 3 h, this evening (before 17:00) or tomorrow evening (after), tomorrow 9:00, next Monday 9:00', () => {
    const wed = new Date(2026, 9, 14, 10, 30); // a Wednesday morning
    const c = sw.snoozeChoices(wed);
    const at = (d, h) => new Date(2026, 9, 14 + d, h).getTime();
    expect(c.map((x) => x.at)).toEqual([wed.getTime() + HOUR, wed.getTime() + 3 * HOUR, at(0, 18), at(1, 9), at(5, 9)]);
    expect(c[2].label).toMatch(/^This evening · /);

    const lateAt = new Date(2026, 9, 14, 17, 5);
    const late = sw.snoozeChoices(lateAt);
    // after 17:00 no "this evening": tomorrow evening (18:00) instead, after tomorrow morning
    expect(late.map((x) => x.at)).toEqual([lateAt.getTime() + HOUR, lateAt.getTime() + 3 * HOUR, at(1, 9), at(1, 18), at(5, 9)]);
    expect(late[3].label).toMatch(/^Tomorrow evening · /);
    const mon = sw.snoozeChoices(new Date(2026, 9, 19, 8)); // a Monday: next Monday is a week on
    expect(mon.at(-1).at).toBe(new Date(2026, 9, 26, 9).getTime());
    const sun = sw.snoozeChoices(new Date(2026, 9, 18, 8));
    expect(sun.at(-1).at).toBe(new Date(2026, 9, 19, 9).getTime());
  });

  it('whenLabel: just the time today, the weekday too otherwise', () => {
    const today = new Date(); today.setHours(18, 0, 0, 0);
    const time = today.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
    expect(sw.whenLabel(today.getTime())).toBe(time);
    const other = new Date(today); other.setDate(other.getDate() + 2);
    expect(sw.whenLabel(other.getTime())).toBe(other.toLocaleDateString('en', { weekday: 'short' }) + ' ' + time);
  });
});

describe('load', () => {
  it('reads this window’s tabs, the current one first, then by recent use and position, leaving out our own pages', async () => {
    await chrome.storage.session.set({ mru: [3, 2] });
    sw = await bootSwitcher({
      tabs: [
        tab('One', 'https://1.com/'), tab('Two', 'https://2.com/'), tab('Three', 'https://3.com/', { active: true }),
        tab('Four', 'https://4.com/'), tab('Own', chrome.runtime.getURL('markup/switcher.html')), tab('Five', 'https://5.com/'),
      ],
    });
    expect(sw.state.tabs.map((t) => t.title)).toEqual(['Three', 'Two', 'One', 'Four', 'Five']);
    expect(sw.state.windows).toEqual([expect.objectContaining({ id: 1, label: 'This window', count: 5, activeTitle: 'Three' })]);
  });

  it('hands each tab the preview stored for its address', async () => {
    await chrome.storage.local.set({ 'pv:https://a.com/x': preview(5) });
    sw = await bootSwitcher({ tabs: [tab('A', 'https://a.com/x/#frag'), tab('B', 'https://b.com/')] });
    const [a, b] = sw.state.tabs;
    expect(sw.state.previews[a.id]).toEqual(preview(5));
    expect(sw.state.previews[b.id]).toBeUndefined();
  });

  it('with "all windows": every window’s tabs, numbered in the order they were opened', async () => {
    chrome._addWindow({ id: 1, focused: true });
    chrome._addWindow({ id: 5 });
    chrome._addWindow({ id: 3 });
    chrome._addWindow({ id: 9, incognito: true });
    sw = await bootSwitcher({
      prefs: { allWindows: true },
      tabs: [tab('Here', 'https://h.com/', { active: true }), tab('In 5', 'https://5.com/', { windowId: 5, active: true }), tab('In 3', 'https://3.com/', { windowId: 3 })],
    });
    expect(sw.state.tabs.map((t) => t.title)).toEqual(['Here', 'In 3', 'In 5']);
    expect(sw.state.windows.map((w) => [w.id, w.label])).toEqual([[1, 'This window'], [3, 'Window 2'], [5, 'Window 3']]);
    expect(sw.state.otherWindows).toEqual([5, 3]); // not the incognito one
  });

  it('reads stars, notes, snoozed tabs and the saved sort', async () => {
    await chrome.storage.local.set({
      stars: { 'https://s.com/': { u: 'https://s.com/', ti: 'S', t: 1 } },
      notes: { 'https://n.com/': { u: 'https://n.com/', n: 'note', t: 1 } },
      snoozed: [{ id: 'z1', url: 'https://z.com/', title: 'Z', at: Date.now() + HOUR }],
      view: { sort: 'name', collapsed: ['u'] },
    });
    sw = await bootSwitcher();
    expect(Object.keys(sw.state.stars)).toEqual(['https://s.com/']);
    expect(sw.noteOf('https://n.com/')).toBe('note');
    expect(sw.state.snoozed.map((x) => x.id)).toEqual(['z1']);
    expect(sw.state.sort).toBe('name');
    expect([...sw.state.collapsed]).toEqual(['u']);
  });
});

describe('recently closed', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const sTab = (id, url, title, ago = 60) => ({ lastModified: now() - ago, tab: { sessionId: id, url, title } });
  const logged = (url, title, ago = 60e3) => ({ url, title, favIconUrl: '', closedAt: Date.now() - ago });

  beforeEach(async () => { sw = await bootSwitcher({ tabs: [tab('Open', 'https://open.com/')] }); });

  it('merges Chrome’s list with our log, newest first', async () => {
    chrome._data.closed = [sTab('a', 'https://a.com/', 'A', 120)];
    await chrome.storage.local.set({ closedlog: [logged('https://b.com/', 'B', 60e3), logged('https://c.com/', 'C', 600e3)] });
    await sw.loadClosed();
    expect(sw.state.closed.map((c) => [c.id.slice(0, 1), c.title])).toEqual([['l', 'B'], ['s', 'A'], ['l', 'C']]);
    expect(sw.state.closed[1]).toMatchObject({ kind: 'tab', url: 'https://a.com/', count: 1, fields: [['A', 'https://a.com/']] });
    expect(sw.state.closed[0].session).toBeNull();
  });

  it('one entry per page: within 5 s it is the same closing and Chrome’s (with history) wins', async () => {
    chrome._data.closed = [sTab('a', 'https://a.com/', 'Chrome A', 60), sTab('b', 'https://b.com/', 'Chrome B', 600)];
    await chrome.storage.local.set({ closedlog: [logged('https://a.com/#x', 'Log A', 58e3), logged('https://b.com/', 'Log B', 30e3)] });
    await sw.loadClosed();
    // a.com: 2 s apart, Chrome's kept. b.com: closed again later, the newer log entry wins (and, 30 s ago, is
    // clearly newer than Chrome A: Chrome's times are whole seconds, so equal times would tie at random).
    expect(sw.state.closed.map((c) => c.title)).toEqual(['Log B', 'Chrome A']);
  });

  it('leaves out pages open again, blank pages, archived and snoozed pages (log)', async () => {
    sw.state.snoozed = [{ id: 'z', url: 'https://snoozed.com/', title: 'Z', at: Date.now() + HOUR }];
    sw.state.archived = [{ id: '9', url: 'https://arch.com/', title: 'Ar', t: 1 }];
    await chrome.storage.local.set({
      closedlog: ['https://open.com/', 'chrome://newtab/', 'https://snoozed.com/', 'https://arch.com/', 'https://keep.com/'].map((u) => logged(u, u)),
    });
    chrome._data.closed = [sTab('n', 'about:blank', 'Blank'), sTab('ar', 'https://arch.com/', 'Ar')];
    await sw.loadClosed();
    expect(sw.state.closed.map((c) => c.url)).toEqual(['https://keep.com/']);
  });

  // Snoozing closes the tab, so Chrome lists it as recently closed too: it must show only under "Snoozed".
  it('leaves snoozed pages out of Chrome’s list too', async () => {
    sw.state.snoozed = [{ id: 'z', url: 'https://snoozed.com/', title: 'Z', at: Date.now() + HOUR }];
    chrome._data.closed = [sTab('z', 'https://snoozed.com/', 'Z')];
    await sw.loadClosed();
    expect(sw.state.closed).toEqual([]);
  });

  it('a closed window is one card, and its pages aren’t listed again from the log', async () => {
    chrome._data.closed = [{ lastModified: 0, window: { sessionId: 'w', tabs: [{ url: 'https://w1.com/', title: 'W1' }, { url: 'https://w2.com/', title: 'W2' }] } }];
    await chrome.storage.local.set({ closedlog: [logged('https://w1.com/', 'W1'), logged('https://x.com/', 'X')] });
    await sw.loadClosed();
    expect(sw.state.closed.map((c) => [c.kind, c.title, c.count])).toEqual([['window', 'Window · 2 tabs', 2], ['tab', 'X', 1]]);
    expect(sw.state.closed[0]).toMatchObject({ ts: 0, url: 'https://w1.com/', fields: [['W1', 'https://w1.com/'], ['W2', 'https://w2.com/']] });
  });

  it('Chrome failing still leaves our log; previews are attached', async () => {
    chrome.sessions.getRecentlyClosed.mockRejectedValueOnce(new Error('no'));
    await chrome.storage.local.set({ closedlog: [logged('https://x.com/', 'X')], 'pv:https://x.com/': preview() });
    await sw.loadClosed();
    expect(sw.state.closed.map((c) => [c.title, c.preview])).toEqual([['X', preview()]]);
  });

  it('closedFor: without a search the last 4 hours, at most 2 windows and 8 entries', () => {
    const win = (id, ts) => ({ id, kind: 'window', ts, fields: [] });
    const tb = (id, ts) => ({ id, kind: 'tab', ts, fields: [['T' + id, `https://${id}.com/`]] });
    const t = Date.now();
    sw.state.closed = [win('w1', t), win('w2', t), win('w3', t), tb('a', 0), ...[1, 2, 3, 4, 5, 6, 7].map((i) => tb('t' + i, t - i)), tb('old', t - 5 * HOUR)];
    expect(sw.closedFor('').map((c) => c.id)).toEqual(['w1', 'w2', 'a', 't1', 't2', 't3', 't4', 't5']);
    // Searching reaches every age, every window, up to 24 entries.
    expect(sw.closedFor('told').map((c) => c.id)).toEqual(['old']);
    sw.state.closed = Array.from({ length: 30 }, (_, i) => tb('m' + i, t));
    expect(sw.closedFor('tm')).toHaveLength(24);
  });

  it('loadStarPreviews looks up starred pages that aren’t open', async () => {
    sw.state.stars = {
      'https://open.com/': { u: 'https://open.com/', ti: 'Open', t: 1 },
      'https://s.com/': { u: 'https://s.com/', ti: 'S', t: 1 },
    };
    await chrome.storage.local.set({ 'pv:https://s.com/': preview(), 'pv:https://open.com/': preview() });
    await sw.loadStarPreviews();
    expect(sw.state.starPreviews).toEqual({ 'https://s.com/': preview() });
  });

  it('loadExtras reads the archive first, then recently closed (without archived pages) and snoozed previews', async () => {
    const arch = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: arch.id, title: 'Ar', url: 'https://arch.com/' });
    chrome._data.closed = [sTab('ar', 'https://arch.com/', 'Ar'), sTab('k', 'https://k.com/', 'K')];
    sw.state.snoozed = [{ id: 'z', url: 'https://z.com/', title: 'Z', at: 1 }];
    await chrome.storage.local.set({ 'pv:https://z.com/': preview() });
    await sw.loadExtras();
    expect(sw.state.archived.map((x) => x.url)).toEqual(['https://arch.com/']);
    expect(sw.state.closed.map((c) => c.url)).toEqual(['https://k.com/']);
    expect(sw.state.snoozePreviews).toEqual({ 'https://z.com/': preview() });
  });
});

describe('derive', () => {
  const boot = (tabs, prefs) => bootSwitcher({ tabs, prefs }).then((m) => { sw = m; sw.state.closed = []; sw.state.snoozed = []; });

  it('pinned tabs first, each part in recent-use order', async () => {
    await boot([tab('A', 'https://a.com/'), tab('B', 'https://b.com/'), tab('P1', 'https://p1.com/', { pinned: true }), tab('C', 'https://c.com/'), tab('P2', 'https://p2.com/', { pinned: true })]);
    sw.derive();
    expect(titles()).toEqual(['P1', 'P2', 'A', 'B', 'C']);
    expect(titles(sw.state.mruOrder)).toEqual(['A', 'B', 'P1', 'C', 'P2']); // Alt+Q: recent use only
    expect(sw.state.sections).toEqual([expect.objectContaining({ key: 'u', plain: true, collapsed: false })]);
    expect(sw.state.openCount).toBe(5);
  });

  it('sorts by name, pinned still first', async () => {
    await boot([tab('b', 'https://b.com/'), tab('C', 'https://c.com/'), tab('z', 'https://z.com/', { pinned: true }), tab('a', 'https://a.com/')]);
    sw.state.sort = 'name';
    sw.derive();
    expect(titles()).toEqual(['z', 'a', 'b', 'C']);
  });

  it('the Starred filter: starred open tabs, then starred pages that aren’t open, newest first', async () => {
    await boot([tab('A', 'https://a.com/'), tab('B', 'https://b.com/')]);
    sw.state.stars = {
      'https://b.com/': { u: 'https://b.com/', ti: 'B', t: 1 },
      'https://old.com/': { u: 'https://old.com/', ti: 'Old', t: 2 },
      'https://new.com/': { u: 'https://new.com/', ti: 'New', t: 3 },
    };
    sw.state.starPreviews = { 'https://new.com/': preview() };
    sw.state.starOnly = true;
    sw.state.snoozed = [{ id: 'z', url: 'https://z.com/', title: 'Z', at: 1 }];
    sw.derive();
    expect(sw.state.entries.map((e) => [e.kind, (e.tab || e.item).title])).toEqual([['tab', 'B'], ['star', 'New'], ['star', 'Old']]);
    expect(sw.state.entries[1]).toMatchObject({ key: 'sthttps://new.com/', preview: preview(), item: { url: 'https://new.com/', ts: 3 } });
  });

  it('a quick filter shows only the tabs it matches, and hides the snoozed ones', async () => {
    await boot([tab('A', 'https://a.com/'), tab('Loud', 'https://l.com/', { audible: true }), tab('P', 'https://p.com/', { pinned: true })]);
    sw.state.snoozed = [{ id: 'z', url: 'https://z.com/', title: 'Z', at: 1 }];
    sw.state.filter = 'audio';
    sw.derive();
    expect(titles()).toEqual(['Loud']);
    expect(sw.state.snoozeCount).toBe(0);
    sw.state.filter = 'pinned';
    sw.derive();
    expect(titles()).toEqual(['P']);
  });

  it('a window scope shows that window’s tabs; an unknown one falls back to all', async () => {
    chrome._addWindow({ id: 1, focused: true });
    await boot([tab('Here', 'https://h.com/'), tab('There', 'https://t.com/', { windowId: 2 })], { allWindows: true });
    sw.state.scope = 2;
    sw.derive();
    expect(titles()).toEqual(['There']);
    sw.state.scope = 99;
    sw.derive();
    expect(sw.state.scope).toBe('all');
    expect(titles()).toEqual(['Here', 'There']);
  });

  it('snoozed (soonest first) then recently closed follow the open tabs; the search doesn’t narrow the cards', async () => {
    await boot([tab('A', 'https://a.com/'), tab('B', 'https://b.com/')]);
    sw.state.snoozed = [{ id: 'z2', url: 'https://z2.com/', title: 'Later', at: 20 }, { id: 'z1', url: 'https://z1.com/', title: 'Soon', at: 10 }];
    sw.state.closed = [{ id: 'l1', kind: 'tab', url: 'https://c.com/', title: 'Closed', ts: Date.now(), fields: [['Closed', 'https://c.com/']], preview: null }];
    sw.state.query = 'zzz';
    sw.derive();
    expect(keys().slice(2)).toEqual(['zz1', 'zz2', 'cl1']);
    expect(titles()).toEqual(['A', 'B', 'Soon', 'Later', 'Closed']);
    expect(sw.state.snoozeCount).toBe(2);
    expect(sw.state.openCount).toBe(2);
  });

  it('a collapsed section keeps its header and hides its cards', async () => {
    await boot([tab('A', 'https://a.com/'), tab('B', 'https://b.com/', { url: 'https://a.com/#2' }), tab('C', 'https://c.com/')]);
    sw.state.dupesView = true;
    sw.state.collapsed = new Set(['d:https://a.com/']);
    sw.derive();
    expect(sw.state.sections.map((s) => [s.key, s.collapsed])).toEqual([['d:https://a.com/', true]]);
    expect(sw.state.openCount).toBe(0);
    expect(sw.state.matchCount).toBe(2); // collapsed or not, they match
  });

  it('forgets ticks of tabs that closed', async () => {
    await boot([tab('A', 'https://a.com/'), tab('B', 'https://b.com/')]);
    const [a] = sw.state.tabs;
    sw.state.picked = new Set([a.id, 999]);
    sw.derive();
    expect([...sw.state.picked]).toEqual([a.id]);
  });
});

describe('duplicates', () => {
  beforeEach(async () => {
    sw = await bootSwitcher({
      tabs: [
        tab('A1', 'https://a.com/'), tab('B1', 'https://b.com/x'), tab('A2', 'https://a.com/#top'),
        tab('B2', 'https://b.com/x/', { pinned: true }), tab('C', 'https://c.com/'),
        tab('N1', 'chrome://newtab/'), tab('N2', 'chrome://newtab/'),
      ],
    });
    sw.state.closed = []; sw.state.snoozed = [];
  });

  it('dupeUrls: web pages open more than once, ignoring #part and trailing slash', () => {
    expect([...sw.dupeUrls()].sort()).toEqual(['https://a.com/', 'https://b.com/x']);
  });

  it('duplicates: the copies to close, keeping the pinned one, else the most recently used', () => {
    expect(sw.duplicates().map((x) => x.title)).toEqual(['B1', 'A2']);
  });

  it('the duplicates view: one section per page, the copy that stays first', () => {
    sw.state.dupesView = true;
    sw.derive();
    expect(sw.state.sections.map((s) => [s.key, s.title, titles(s.entries)])).toEqual([
      ['d:https://b.com/x', 'B2', ['B2', 'B1']],
      ['d:https://a.com/', 'A1', ['A1', 'A2']],
    ]);
    expect(sw.state.sections.every((s) => !s.plain)).toBe(true);
    expect(sw.state.snoozeCount).toBe(0);
  });

  it('sectionsFor marks each entry with its section', () => {
    const open = sw.state.tabs.slice(0, 2).map((t) => ({ tab: t }));
    const secs = sw.sectionsFor(open);
    expect(secs).toHaveLength(1);
    expect(secs[0]).toMatchObject({ key: 'u', title: 'Open tabs' });
    expect(open.every((e) => e.sec === 'u')).toBe(true);
  });
});

describe('navigation and layout', () => {
  beforeEach(async () => {
    sw = await bootSwitcher({ tabs: [tab('A', 'https://a.com/'), tab('B', 'https://b.com/'), tab('C', 'https://c.com/', { active: true })] });
  });

  it('stepKey moves along the cards, wrapping at the ends', () => {
    const list = sw.state.steps.map((e) => e.key);
    expect(list).toHaveLength(3);
    expect(sw.stepKey(list[0], 1)).toBe(list[1]);
    expect(sw.stepKey(list[2], 1)).toBe(list[0]);
    expect(sw.stepKey(list[0], -1)).toBe(list[2]);
    // From something that isn't a card: from the current tab (first here)
    expect(sw.stepKey('nope', 1)).toBe(list[1]);
    sw.state.steps = [];
    expect(sw.stepKey('x', 1)).toBeNull();
  });

  it('missingPreviews: shown tabs that could have a preview but don’t', () => {
    const [cur, a, b] = sw.state.tabs; // the current tab (active) never counts
    expect(cur.title).toBe('C');
    sw.state.previews = { [a.id]: preview() };
    expect(sw.missingPreviews().map((x) => x.title)).toEqual([b.title]);
    sw.state.hostOk = false;
    expect(sw.missingPreviews()).toEqual([]);
  });

  it('cardWidth fits as many cards as near the preferred size, stretched to the full width', () => {
    const at = (px, size, n) => { sw.el.openGrid.style.width = px + 'px'; sw.state.cardSize = size; return sw.cardWidth(n); };
    expect(at(1000, 'default', 10)).toBeCloseTo((1000 - 2 * sw.GRID_GAP) / 3);
    expect(at(700, 'default', 10)).toBeCloseTo((700 - sw.GRID_GAP) / 2);
    expect(at(330, 'small', 10)).toBe(330);        // two would be under the smallest size
    expect(at(776, 'list', 10)).toBeCloseTo(379);
    expect(at(776, 'list', 1)).toBe(360);          // a few tabs: no wider than this
    expect(at(1000, 'nonsense', 10)).toBeCloseTo((1000 - 2 * sw.GRID_GAP) / 3);
    expect(sw.CARD_SIZES.default).toEqual([320, 240, 420]);
  });
});
