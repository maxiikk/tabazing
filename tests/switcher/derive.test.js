// What the switcher reads (tabs, windows, recently closed) and how it turns that into cards: filters, sorts,
// sections, snoozed and closed parts, duplicates, card sizes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootSwitcher } from '../helpers/switcher.js';

let switcher;
const HOUR = 3600e3;
const tab = (title, url, more = {}) => ({ title, url, ...more });
const keys = () => switcher.state.entries.map((entry) => entry.key);
const titles = (list = switcher.state.entries) => list.map((entry) => (entry.tab || entry.item).title);
const preview = (timestamp = 1) => ({ img: 'data:image/jpeg;base64,AAAA', t: timestamp });
// Retire each booted module: its delayed redraw (after the opening animation) must not run once the test's page is gone.
afterEach(() => { if (switcher) switcher.state.done = true; });

describe('helpers', () => {
  beforeEach(async () => { switcher = await bootSwitcher(); });

  it('urlOf, hostOf, siteOf, favicon', () => {
    expect(switcher.urlOf({ url: 'https://a.com/' })).toBe('https://a.com/');
    expect(switcher.urlOf({ url: '', pendingUrl: 'https://p.com/' })).toBe('https://p.com/');
    expect(switcher.urlOf(null)).toBe('');
    expect(switcher.hostOf('https://www.a.com:8080/x')).toBe('www.a.com:8080');
    expect(switcher.hostOf('file:///c/x.txt')).toBe('file');
    expect(switcher.hostOf('nope')).toBe('');
    expect(switcher.siteOf('https://www.a.com/x')).toBe('a.com');
    expect(switcher.favicon('https://a.com/?q=1&b')).toBe(chrome.runtime.getURL('/_favicon/') + '?pageUrl=https%3A%2F%2Fa.com%2F%3Fq%3D1%26b&size=32');
  });

  it('h builds an element with text, never HTML', () => {
    const element = switcher.makeElement('div', 'a b', '<i>x</i>');
    expect(element.className).toBe('a b');
    expect(element.textContent).toBe('<i>x</i>');
    expect(element.children.length).toBe(0);
    expect(switcher.makeElement('span').textContent).toBe('');
  });

  it('hashOf is stable and short', () => {
    expect(switcher.hashOf('https://a.com/')).toBe(switcher.hashOf('https://a.com/'));
    expect(switcher.hashOf('https://a.com/')).not.toBe(switcher.hashOf('https://b.com/'));
    expect(switcher.hashOf('')).toBe((5381).toString(36));
    expect(switcher.hashOf('x'.repeat(5000))).toMatch(/^[0-9a-z]+$/);
  });

  it('isStarred and noteOf go by the normalized address', () => {
    switcher.state.stars = { 'https://a.com/x': { u: 'https://a.com/x/', ti: 'A', t: 1 } };
    switcher.state.notes = { 'https://a.com/x': { u: 'https://a.com/x', n: 'hi', t: 1 } };
    expect(switcher.isStarred('https://a.com/x/#top')).toBe(true);
    expect(switcher.isStarred('https://b.com/')).toBe(false);
    expect(switcher.noteOf('https://a.com/x/')).toBe('hi');
    expect(switcher.noteOf('https://b.com/')).toBe('');
  });

  it('byTitle sorts by title (or site), ignoring case, numbers by value', () => {
    const entry = (title, url = 'https://z.com/') => ({ tab: { title, url } });
    const list = [entry('b'), entry('c10'), entry('A'), entry('c9'), entry('', 'https://www.m.com/')];
    expect(list.sort(switcher.byTitle).map((x) => x.tab.title || 'site')).toEqual(['A', 'b', 'c9', 'c10', 'site']);
  });

  it('winRank puts this window first; SORTERS.order follows the tab strip', () => {
    expect(switcher.windowRank({ windowId: 1 })).toBe(-1);
    expect(switcher.windowRank({ windowId: 7 })).toBe(7);
    const entry = (windowId, index) => ({ tab: { windowId, index } });
    const list = [entry(3, 0), entry(2, 1), entry(1, 2), entry(2, 0), entry(1, 0)];
    expect(list.sort(switcher.SORTERS.order).map((x) => [x.tab.windowId, x.tab.index])).toEqual([[1, 0], [1, 2], [2, 0], [2, 1], [3, 0]]);
    expect(switcher.SORTERS.recent).toBeUndefined(); // state.tabs is already in recent-use order
  });

  it('FILTERS test tabs', () => {
    const filters = switcher.FILTERS;
    expect(filters.audio.test({ audible: true })).toBe(true);
    expect(filters.audio.test({ audible: false, mutedInfo: { muted: true } })).toBe(true);
    expect(filters.audio.test({ audible: false, mutedInfo: { muted: false } })).toBe(false);
    expect(filters.pinned.test({ pinned: true })).toBe(true);
    expect(filters.asleep.test({ id: 5, discarded: true })).toBe(true);
    switcher.state.toSleep.add(6);
    expect(filters.asleep.test({ id: 6, discarded: false })).toBe(true);
    expect(filters.asleep.test({ id: 7, discarded: false })).toBe(false);
    switcher.state.notes = { 'https://n.com/': { u: 'https://n.com/', n: 'x', t: 1 } };
    expect(filters.note.test({ url: 'https://n.com/' })).toBe(true);
    expect(filters.note.test({ url: 'https://o.com/' })).toBe(false);
  });

  it('tabAge shows whole days since last viewed, else nothing', () => {
    expect(switcher.tabAge({ lastAccessed: Date.now() - 3 * switcher.DAY_MILLISECONDS - 1000 }).textContent).toBe('3 days ago');
    expect(switcher.tabAge({ lastAccessed: Date.now() - 1.5 * switcher.DAY_MILLISECONDS }).textContent).toBe('1 day ago');
    expect(switcher.tabAge({ lastAccessed: Date.now() - 23 * HOUR })).toBeNull();
    expect(switcher.tabAge({})).toBeNull();
  });

  it('canCapture: a web page that isn’t asleep, refused or without site access', () => {
    const page = { url: 'https://a.com/', discarded: false };
    expect(switcher.canCapture(page)).toBe(true);
    expect(switcher.canCapture({ ...page, discarded: true })).toBe(false);
    expect(switcher.canCapture({ url: 'chrome://settings/' })).toBe(false);
    expect(switcher.canCapture({ url: 'https://chromewebstore.google.com/detail/x' })).toBe(false);
    switcher.state.noCapture = new Set(['https://a.com/']);
    expect(switcher.canCapture(page)).toBe(false);
    switcher.state.noCapture = new Set();
    switcher.state.hostAllowed = false;
    expect(switcher.canCapture(page)).toBe(false);
  });

  it('plainCaptureError puts Chrome’s errors in plain words', () => {
    expect(switcher.plainCaptureError('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND exceeded')).toBeNull();
    expect(switcher.plainCaptureError('Either the \'<all_urls>\' or \'activeTab\' permission is required.')).toMatchObject({ fix: true });
    expect(switcher.plainCaptureError('Cannot access a chrome:// URL')).toEqual({ text: expect.stringMatching(/kind of page/) });
    expect(switcher.plainCaptureError(undefined)).toEqual({ text: expect.stringMatching(/couldn’t/) });
  });

  it('snoozeChoices: in 1 h, 3 h, this evening (before 17:00) or tomorrow evening (after), tomorrow 9:00, next Monday 9:00', () => {
    const wednesday = new Date(2026, 9, 14, 10, 30); // a Wednesday morning
    const choices = switcher.snoozeChoices(wednesday);
    const at = (dayOffset, hour) => new Date(2026, 9, 14 + dayOffset, hour).getTime();
    expect(choices.map((x) => x.at)).toEqual([wednesday.getTime() + HOUR, wednesday.getTime() + 3 * HOUR, at(0, 18), at(1, 9), at(5, 9)]);
    expect(choices[2].label).toMatch(/^This evening · /);

    const lateAt = new Date(2026, 9, 14, 17, 5);
    const late = switcher.snoozeChoices(lateAt);
    // after 17:00 no "this evening": tomorrow evening (18:00) instead, after tomorrow morning
    expect(late.map((x) => x.at)).toEqual([lateAt.getTime() + HOUR, lateAt.getTime() + 3 * HOUR, at(1, 9), at(1, 18), at(5, 9)]);
    expect(late[3].label).toMatch(/^Tomorrow evening · /);
    const mondayChoices = switcher.snoozeChoices(new Date(2026, 9, 19, 8)); // a Monday: next Monday is a week on
    expect(mondayChoices.at(-1).at).toBe(new Date(2026, 9, 26, 9).getTime());
    const sundayChoices = switcher.snoozeChoices(new Date(2026, 9, 18, 8));
    expect(sundayChoices.at(-1).at).toBe(new Date(2026, 9, 19, 9).getTime());
  });

  it('whenLabel: just the time today, the weekday too otherwise', () => {
    const today = new Date(); today.setHours(18, 0, 0, 0);
    const time = today.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
    expect(switcher.whenLabel(today.getTime())).toBe(time);
    const other = new Date(today); other.setDate(other.getDate() + 2);
    expect(switcher.whenLabel(other.getTime())).toBe(other.toLocaleDateString('en', { weekday: 'short' }) + ' ' + time);
  });
});

describe('load', () => {
  it('reads this window’s tabs, the current one first, then by recent use and position, leaving out our own pages', async () => {
    await chrome.storage.session.set({ mru: [3, 2] });
    switcher = await bootSwitcher({
      tabs: [
        tab('One', 'https://1.com/'), tab('Two', 'https://2.com/'), tab('Three', 'https://3.com/', { active: true }),
        tab('Four', 'https://4.com/'), tab('Own', chrome.runtime.getURL('markup/switcher.html')), tab('Five', 'https://5.com/'),
      ],
    });
    expect(switcher.state.tabs.map((openTab) => openTab.title)).toEqual(['Three', 'Two', 'One', 'Four', 'Five']);
    expect(switcher.state.windows).toEqual([expect.objectContaining({ id: 1, label: 'This window', count: 5, activeTitle: 'Three' })]);
  });

  it('hands each tab the preview stored for its address', async () => {
    await chrome.storage.local.set({ 'pv:https://a.com/x': preview(5) });
    switcher = await bootSwitcher({ tabs: [tab('A', 'https://a.com/x/#frag'), tab('B', 'https://b.com/')] });
    const [tabA, tabB] = switcher.state.tabs;
    expect(switcher.state.previews[tabA.id]).toEqual(preview(5));
    expect(switcher.state.previews[tabB.id]).toBeUndefined();
  });

  it('with "all windows": every window’s tabs, numbered in the order they were opened', async () => {
    chrome._addWindow({ id: 1, focused: true });
    chrome._addWindow({ id: 5 });
    chrome._addWindow({ id: 3 });
    chrome._addWindow({ id: 9, incognito: true });
    switcher = await bootSwitcher({
      preferences: { allWindows: true },
      tabs: [tab('Here', 'https://h.com/', { active: true }), tab('In 5', 'https://5.com/', { windowId: 5, active: true }), tab('In 3', 'https://3.com/', { windowId: 3 })],
    });
    expect(switcher.state.tabs.map((openTab) => openTab.title)).toEqual(['Here', 'In 3', 'In 5']);
    expect(switcher.state.windows.map((windowEntry) => [windowEntry.id, windowEntry.label])).toEqual([[1, 'This window'], [3, 'Window 2'], [5, 'Window 3']]);
    expect(switcher.state.otherWindows).toEqual([5, 3]); // not the incognito one
  });

  it('reads stars, notes, snoozed tabs and the saved sort', async () => {
    await chrome.storage.local.set({
      stars: { 'https://s.com/': { u: 'https://s.com/', ti: 'S', t: 1 } },
      notes: { 'https://n.com/': { u: 'https://n.com/', n: 'note', t: 1 } },
      snoozed: [{ id: 'z1', url: 'https://z.com/', title: 'Z', at: Date.now() + HOUR }],
      view: { sort: 'name', collapsed: ['u'] },
    });
    switcher = await bootSwitcher();
    expect(Object.keys(switcher.state.stars)).toEqual(['https://s.com/']);
    expect(switcher.noteOf('https://n.com/')).toBe('note');
    expect(switcher.state.snoozed.map((x) => x.id)).toEqual(['z1']);
    expect(switcher.state.sort).toBe('name');
    expect([...switcher.state.collapsed]).toEqual(['u']);
  });
});

describe('recently closed', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const closedTab = (id, url, title, ago = 60) => ({ lastModified: now() - ago, tab: { sessionId: id, url, title } });
  const logged = (url, title, ago = 60e3) => ({ url, title, favIconUrl: '', closedAt: Date.now() - ago });

  beforeEach(async () => { switcher = await bootSwitcher({ tabs: [tab('Open', 'https://open.com/')] }); });

  it('merges Chrome’s list with our log, newest first', async () => {
    chrome._data.closed = [closedTab('a', 'https://a.com/', 'A', 120)];
    await chrome.storage.local.set({ closedlog: [logged('https://b.com/', 'B', 60e3), logged('https://c.com/', 'C', 600e3)] });
    await switcher.loadClosed();
    expect(switcher.state.closed.map((entry) => [entry.id.slice(0, 1), entry.title])).toEqual([['l', 'B'], ['s', 'A'], ['l', 'C']]);
    expect(switcher.state.closed[1]).toMatchObject({ kind: 'tab', url: 'https://a.com/', count: 1, fields: [['A', 'https://a.com/']] });
    expect(switcher.state.closed[0].session).toBeNull();
  });

  it('one entry per page: within 5 s it is the same closing and Chrome’s (with history) windows', async () => {
    chrome._data.closed = [closedTab('a', 'https://a.com/', 'Chrome A', 60), closedTab('b', 'https://b.com/', 'Chrome B', 600)];
    await chrome.storage.local.set({ closedlog: [logged('https://a.com/#x', 'Log A', 58e3), logged('https://b.com/', 'Log B', 30e3)] });
    await switcher.loadClosed();
    // a.com: 2 s apart, Chrome's kept. b.com: closed again later, the newer log entry wins (and, 30 s ago, is
    // clearly newer than Chrome A: Chrome's times are whole seconds, so equal times would tie at random).
    expect(switcher.state.closed.map((entry) => entry.title)).toEqual(['Log B', 'Chrome A']);
  });

  it('leaves out pages open again, blank pages, archived and snoozed pages (log)', async () => {
    switcher.state.snoozed = [{ id: 'z', url: 'https://snoozed.com/', title: 'Z', at: Date.now() + HOUR }];
    switcher.state.archived = [{ id: '9', url: 'https://arch.com/', title: 'Ar', t: 1 }];
    await chrome.storage.local.set({
      closedlog: ['https://open.com/', 'chrome://newtab/', 'https://snoozed.com/', 'https://arch.com/', 'https://keep.com/'].map((url) => logged(url, url)),
    });
    chrome._data.closed = [closedTab('n', 'about:blank', 'Blank'), closedTab('ar', 'https://arch.com/', 'Ar')];
    await switcher.loadClosed();
    expect(switcher.state.closed.map((entry) => entry.url)).toEqual(['https://keep.com/']);
  });

  // Snoozing closes the tab, so Chrome lists it as recently closed too: it must show only under "Snoozed".
  it('leaves snoozed pages out of Chrome’s list too', async () => {
    switcher.state.snoozed = [{ id: 'z', url: 'https://snoozed.com/', title: 'Z', at: Date.now() + HOUR }];
    chrome._data.closed = [closedTab('z', 'https://snoozed.com/', 'Z')];
    await switcher.loadClosed();
    expect(switcher.state.closed).toEqual([]);
  });

  it('a closed window is one card, and its pages aren’t listed again from the log', async () => {
    chrome._data.closed = [{ lastModified: 0, window: { sessionId: 'w', tabs: [{ url: 'https://w1.com/', title: 'W1' }, { url: 'https://w2.com/', title: 'W2' }] } }];
    await chrome.storage.local.set({ closedlog: [logged('https://w1.com/', 'W1'), logged('https://x.com/', 'X')] });
    await switcher.loadClosed();
    expect(switcher.state.closed.map((entry) => [entry.kind, entry.title, entry.count])).toEqual([['window', 'Window · 2 tabs', 2], ['tab', 'X', 1]]);
    expect(switcher.state.closed[0]).toMatchObject({ timestamp: 0, url: 'https://w1.com/', fields: [['W1', 'https://w1.com/'], ['W2', 'https://w2.com/']] });
  });

  it('Chrome failing still leaves our log; previews are attached', async () => {
    chrome.sessions.getRecentlyClosed.mockRejectedValueOnce(new Error('no'));
    await chrome.storage.local.set({ closedlog: [logged('https://x.com/', 'X')], 'pv:https://x.com/': preview() });
    await switcher.loadClosed();
    expect(switcher.state.closed.map((entry) => [entry.title, entry.preview])).toEqual([['X', preview()]]);
  });

  it('closedFor: without a search the last 4 hours, at most 2 windows and 8 entries', () => {
    const windowEntry = (id, timestamp) => ({ id, kind: 'window', timestamp, fields: [] });
    const tabEntry = (id, timestamp) => ({ id, kind: 'tab', timestamp, fields: [['T' + id, `https://${id}.com/`]] });
    const currentTime = Date.now();
    switcher.state.closed = [windowEntry('w1', currentTime), windowEntry('w2', currentTime), windowEntry('w3', currentTime), tabEntry('a', 0), ...[1, 2, 3, 4, 5, 6, 7].map((i) => tabEntry('t' + i, currentTime - i)), tabEntry('old', currentTime - 5 * HOUR)];
    expect(switcher.closedFor('').map((entry) => entry.id)).toEqual(['w1', 'w2', 'a', 't1', 't2', 't3', 't4', 't5']);
    // Searching reaches every age, every window, up to 24 entries.
    expect(switcher.closedFor('told').map((entry) => entry.id)).toEqual(['old']);
    switcher.state.closed = Array.from({ length: 30 }, (value, i) => tabEntry('m' + i, currentTime));
    expect(switcher.closedFor('tm')).toHaveLength(24);
  });

  it('loadStarPreviews looks up starred pages that aren’t open', async () => {
    switcher.state.stars = {
      'https://open.com/': { u: 'https://open.com/', ti: 'Open', t: 1 },
      'https://s.com/': { u: 'https://s.com/', ti: 'S', t: 1 },
    };
    await chrome.storage.local.set({ 'pv:https://s.com/': preview(), 'pv:https://open.com/': preview() });
    await switcher.loadStarPreviews();
    expect(switcher.state.starPreviews).toEqual({ 'https://s.com/': preview() });
  });

  it('loadExtras reads the archive first, then recently closed (without archived pages) and snoozed previews', async () => {
    const archiveFolder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: archiveFolder.id, title: 'Ar', url: 'https://arch.com/' });
    chrome._data.closed = [closedTab('ar', 'https://arch.com/', 'Ar'), closedTab('k', 'https://k.com/', 'K')];
    switcher.state.snoozed = [{ id: 'z', url: 'https://z.com/', title: 'Z', at: 1 }];
    await chrome.storage.local.set({ 'pv:https://z.com/': preview() });
    await switcher.loadExtras();
    expect(switcher.state.archived.map((x) => x.url)).toEqual(['https://arch.com/']);
    expect(switcher.state.closed.map((entry) => entry.url)).toEqual(['https://k.com/']);
    expect(switcher.state.snoozePreviews).toEqual({ 'https://z.com/': preview() });
  });
});

describe('derive', () => {
  const boot = (tabs, preferences) => bootSwitcher({ tabs, preferences }).then((bootedSwitcher) => { switcher = bootedSwitcher; switcher.state.closed = []; switcher.state.snoozed = []; });

  it('pinned tabs first, each part in recent-use order', async () => {
    await boot([tab('A', 'https://a.com/'), tab('B', 'https://b.com/'), tab('P1', 'https://p1.com/', { pinned: true }), tab('C', 'https://c.com/'), tab('P2', 'https://p2.com/', { pinned: true })]);
    switcher.derive();
    expect(titles()).toEqual(['P1', 'P2', 'A', 'B', 'C']);
    expect(titles(switcher.state.mruOrder)).toEqual(['A', 'B', 'P1', 'C', 'P2']); // Alt+Q: recent use only
    expect(switcher.state.sections).toEqual([expect.objectContaining({ key: 'u', plain: true, collapsed: false })]);
    expect(switcher.state.openCount).toBe(5);
  });

  it('sorts by name, pinned still first', async () => {
    await boot([tab('b', 'https://b.com/'), tab('C', 'https://c.com/'), tab('z', 'https://z.com/', { pinned: true }), tab('a', 'https://a.com/')]);
    switcher.state.sort = 'name';
    switcher.derive();
    expect(titles()).toEqual(['z', 'a', 'b', 'C']);
  });

  it('the Starred filter: starred open tabs, then starred pages that aren’t open, newest first', async () => {
    await boot([tab('A', 'https://a.com/'), tab('B', 'https://b.com/')]);
    switcher.state.stars = {
      'https://b.com/': { u: 'https://b.com/', ti: 'B', t: 1 },
      'https://old.com/': { u: 'https://old.com/', ti: 'Old', t: 2 },
      'https://new.com/': { u: 'https://new.com/', ti: 'New', t: 3 },
    };
    switcher.state.starPreviews = { 'https://new.com/': preview() };
    switcher.state.starOnly = true;
    switcher.state.snoozed = [{ id: 'z', url: 'https://z.com/', title: 'Z', at: 1 }];
    switcher.derive();
    expect(switcher.state.entries.map((entry) => [entry.kind, (entry.tab || entry.item).title])).toEqual([['tab', 'B'], ['star', 'New'], ['star', 'Old']]);
    expect(switcher.state.entries[1]).toMatchObject({ key: 'sthttps://new.com/', preview: preview(), item: { url: 'https://new.com/', timestamp: 3 } });
  });

  it('a quick filter shows only the tabs it matches, and hides the snoozed ones', async () => {
    await boot([tab('A', 'https://a.com/'), tab('Loud', 'https://l.com/', { audible: true }), tab('P', 'https://p.com/', { pinned: true })]);
    switcher.state.snoozed = [{ id: 'z', url: 'https://z.com/', title: 'Z', at: 1 }];
    switcher.state.filter = 'audio';
    switcher.derive();
    expect(titles()).toEqual(['Loud']);
    expect(switcher.state.snoozeCount).toBe(0);
    switcher.state.filter = 'pinned';
    switcher.derive();
    expect(titles()).toEqual(['P']);
  });

  it('a window scope shows that window’s tabs; an unknown one falls back to all', async () => {
    chrome._addWindow({ id: 1, focused: true });
    await boot([tab('Here', 'https://h.com/'), tab('There', 'https://t.com/', { windowId: 2 })], { allWindows: true });
    switcher.state.scope = 2;
    switcher.derive();
    expect(titles()).toEqual(['There']);
    switcher.state.scope = 99;
    switcher.derive();
    expect(switcher.state.scope).toBe('all');
    expect(titles()).toEqual(['Here', 'There']);
  });

  it('snoozed (soonest first) then recently closed follow the open tabs; the search doesn’t narrow the cards', async () => {
    await boot([tab('A', 'https://a.com/'), tab('B', 'https://b.com/')]);
    switcher.state.snoozed = [{ id: 'z2', url: 'https://z2.com/', title: 'Later', at: 20 }, { id: 'z1', url: 'https://z1.com/', title: 'Soon', at: 10 }];
    switcher.state.closed = [{ id: 'l1', kind: 'tab', url: 'https://c.com/', title: 'Closed', timestamp: Date.now(), fields: [['Closed', 'https://c.com/']], preview: null }];
    switcher.state.query = 'zzz';
    switcher.derive();
    expect(keys().slice(2)).toEqual(['zz1', 'zz2', 'cl1']);
    expect(titles()).toEqual(['A', 'B', 'Soon', 'Later', 'Closed']);
    expect(switcher.state.snoozeCount).toBe(2);
    expect(switcher.state.openCount).toBe(2);
  });

  it('a collapsed section keeps its header and hides its cards', async () => {
    await boot([tab('A', 'https://a.com/'), tab('B', 'https://b.com/', { url: 'https://a.com/#2' }), tab('C', 'https://c.com/')]);
    switcher.state.duplicatesView = true;
    switcher.state.collapsed = new Set(['d:https://a.com/']);
    switcher.derive();
    expect(switcher.state.sections.map((section) => [section.key, section.collapsed])).toEqual([['d:https://a.com/', true]]);
    expect(switcher.state.openCount).toBe(0);
    expect(switcher.state.matchCount).toBe(2); // collapsed or not, they match
  });

  it('forgets ticks of tabs that closed', async () => {
    await boot([tab('A', 'https://a.com/'), tab('B', 'https://b.com/')]);
    const [tabA] = switcher.state.tabs;
    switcher.state.picked = new Set([tabA.id, 999]);
    switcher.derive();
    expect([...switcher.state.picked]).toEqual([tabA.id]);
  });
});

describe('duplicates', () => {
  beforeEach(async () => {
    switcher = await bootSwitcher({
      tabs: [
        tab('A1', 'https://a.com/'), tab('B1', 'https://b.com/x'), tab('A2', 'https://a.com/#top'),
        tab('B2', 'https://b.com/x/', { pinned: true }), tab('C', 'https://c.com/'),
        tab('N1', 'chrome://newtab/'), tab('N2', 'chrome://newtab/'),
      ],
    });
    switcher.state.closed = []; switcher.state.snoozed = [];
  });

  it('dupeUrls: web pages open more than once, ignoring #part and trailing slash', () => {
    expect([...switcher.duplicateUrls()].sort()).toEqual(['https://a.com/', 'https://b.com/x']);
  });

  it('duplicates: the copies to close, keeping the pinned one, else the most recently used', () => {
    expect(switcher.duplicates().map((x) => x.title)).toEqual(['B1', 'A2']);
  });

  it('the duplicates view: one section per page, the copy that stays first', () => {
    switcher.state.duplicatesView = true;
    switcher.derive();
    expect(switcher.state.sections.map((section) => [section.key, section.title, titles(section.entries)])).toEqual([
      ['d:https://b.com/x', 'B2', ['B2', 'B1']],
      ['d:https://a.com/', 'A1', ['A1', 'A2']],
    ]);
    expect(switcher.state.sections.every((section) => !section.plain)).toBe(true);
    expect(switcher.state.snoozeCount).toBe(0);
  });

  it('sectionsFor marks each entry with its section', () => {
    const open = switcher.state.tabs.slice(0, 2).map((openTab) => ({ tab: openTab }));
    const sections = switcher.sectionsFor(open);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: 'u', title: 'Open tabs' });
    expect(open.every((entry) => entry.section === 'u')).toBe(true);
  });
});

describe('navigation and layout', () => {
  beforeEach(async () => {
    switcher = await bootSwitcher({ tabs: [tab('A', 'https://a.com/'), tab('B', 'https://b.com/'), tab('C', 'https://c.com/', { active: true })] });
  });

  it('stepKey moves along the cards, wrapping at the ends', () => {
    const list = switcher.state.steps.map((step) => step.key);
    expect(list).toHaveLength(3);
    expect(switcher.stepKey(list[0], 1)).toBe(list[1]);
    expect(switcher.stepKey(list[2], 1)).toBe(list[0]);
    expect(switcher.stepKey(list[0], -1)).toBe(list[2]);
    // From something that isn't a card: from the current tab (first here)
    expect(switcher.stepKey('nope', 1)).toBe(list[1]);
    switcher.state.steps = [];
    expect(switcher.stepKey('x', 1)).toBeNull();
  });

  it('missingPreviews: shown tabs that could have a preview but don’t', () => {
    const [currentTab, tabA, tabB] = switcher.state.tabs; // the current tab (active) never counts
    expect(currentTab.title).toBe('C');
    switcher.state.previews = { [tabA.id]: preview() };
    expect(switcher.missingPreviews().map((x) => x.title)).toEqual([tabB.title]);
    switcher.state.hostAllowed = false;
    expect(switcher.missingPreviews()).toEqual([]);
  });

  it('cardWidth fits as many cards as near the preferred size, stretched to the full width', () => {
    const at = (pixelWidth, size, tabCount) => { switcher.elements.openGrid.style.width = pixelWidth + 'px'; switcher.state.cardSize = size; return switcher.cardWidth(tabCount); };
    expect(at(1000, 'default', 10)).toBeCloseTo((1000 - 2 * switcher.GRID_GAP) / 3);
    expect(at(700, 'default', 10)).toBeCloseTo((700 - switcher.GRID_GAP) / 2);
    expect(at(330, 'small', 10)).toBe(330);        // two would be under the smallest size
    expect(at(776, 'list', 10)).toBeCloseTo(379);
    expect(at(776, 'list', 1)).toBe(360);          // a few tabs: no wider than this
    expect(at(1000, 'nonsense', 10)).toBeCloseTo((1000 - 2 * switcher.GRID_GAP) / 3);
    expect(switcher.CARD_SIZES.default).toEqual([320, 240, 420]);
  });
});
