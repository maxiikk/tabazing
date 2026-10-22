// Drag and drop (switcher.js dragToMove): a page that isn't open (recently closed, snoozed, starred) dragged onto
// the open tabs opens there behind Tabazing, which stays; onto a group's tile, at the end of the group. Tabs and
// groups dropped on a window in the list on the left move there (Undo moves them back), on Snoozed get the snooze
// choices, on Recently closed close. A link from elsewhere opens where it is dropped. What takes the thing dragged
// is outlined while it is.
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, toastText, toastButton } from '../helpers/quiet-boot.js';
import { t } from '../../utils/translations.js';

const GROUP = 7;
const AB = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const WITH_GROUP = [...AB, { title: 'W1', url: 'https://w1.example/', groupId: GROUP }, { title: 'W2', url: 'https://w2.example/', groupId: GROUP }];
const GONE = 'https://gone.example/';
const closedTab = () => ({ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'c1', url: GONE, title: 'Gone' } });
const closedWin = () => ({ lastModified: Math.floor(Date.now() / 1000) - 30, window: { sessionId: 'w1', tabs: [{ url: 'https://x.example/', title: 'X' }, { url: 'https://y.example/', title: 'Y' }] } });
// A drag event as Chrome sends it: its dataTransfer (with the kinds of data, for a link from elsewhere), where the pointer is.
const ev = (type, { x = 50, y = 10, types = [], data = {} } = {}) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types, setData: vi.fn(), getData: (k) => data[k] || '', effectAllowed: '', dropEffect: '' } });
  Object.defineProperty(e, 'clientX', { value: x });
  Object.defineProperty(e, 'clientY', { value: y });
  return e;
};
const rect = (n) => { n.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 50, right: 100, bottom: 50, x: 0, y: 0 }); return n; };
// Drag `from` and drop it on `to` (dragover first, as Chrome does); the dragover event, to see if `to` took it.
function dragTo(from, to, at = {}) {
  from.dispatchEvent(ev('dragstart'));
  const over = ev('dragover', at);
  to.dispatchEvent(over);
  if (over.defaultPrevented) to.dispatchEvent(ev('drop', at));
  from.dispatchEvent(ev('dragend'));
  return over;
}
const openSection = () => tid('open-section');
const created = () => chrome.tabs.create.mock.calls.map((c) => c[0]);
const strip = (win = 1) => chrome._data.tabs.filter((x) => x.windowId === win).sort((a, b) => a.index - b.index).map((x) => (x.url === GONE ? 'Gone' : x.title || x.url)); // (a new tab has no title yet)
const withClosed = (more = {}) => ({ tabs: AB, ...more, beforeImport: async () => { chrome._data.closed = [closedTab(), closedWin()]; if (more.before) await more.before(); } });
const withGroup = (more = {}) => ({ tabs: WITH_GROUP, ...more, beforeImport: async () => { chrome._data.closed = [closedTab()]; chrome._addGroup({ id: GROUP, title: 'Work', color: 'blue', windowId: 1 }); if (more.before) await more.before(); } });
const byOrder = () => chrome.storage.local.set({ view: { sort: 'order', collapsed: [] } });

describe('a recently closed tab, dragged', () => {
  it('onto the open tabs: opens behind Tabazing, which stays open; it leaves the list', async () => {
    const sw = await boot(withClosed());
    const gone = cardOf('Gone', 'closed');
    expect(gone.draggable).toBe(true);
    const over = dragTo(gone, openSection());
    expect(over.defaultPrevented).toBe(true);
    await waitFor(() => created().length === 1);
    expect(created()[0]).toEqual(expect.objectContaining({ url: GONE, active: false, windowId: 1 }));
    expect(chrome.sessions.restore).not.toHaveBeenCalled(); // (Chrome's restore would switch to it)
    expect(sw.state.done).toBe(false);
    await waitFor(() => !sw.state.entries.some((e) => e.kind === 'closed' && e.item.url === GONE));
    expect(toastText()).toBe(t('reopenedN', { count: 1 }));
    expect(sw.state.entries.some((e) => e.kind === 'tab' && e.tab.url === GONE)).toBe(true);
  });

  it('onto a group\'s tile: opens at the end of that group, in the background', async () => {
    const sw = await boot(withGroup());
    const over = dragTo(cardOf('Gone', 'closed'), rect(tid('card-group')));
    expect(over.defaultPrevented).toBe(true);
    await waitFor(() => chrome._data.tabs.some((x) => x.url === GONE && x.groupId === GROUP));
    expect(created()[0]).toEqual(expect.objectContaining({ url: GONE, active: false }));
    expect(strip()).toEqual(['A', 'B', 'W1', 'W2', 'Gone']);
    expect(toastText()).toBe(t('groupAddedN', { count: 1, name: 'Work' }));
    expect(sw.state.done).toBe(false);
  });

  it('By order, onto a tab\'s card: opens right before or after it', async () => {
    await boot(withClosed({ before: byOrder }));
    dragTo(cardOf('Gone', 'closed'), rect(cardOf('A')), { x: 80 }); // its half toward the end: after it
    await waitFor(() => created().length === 1);
    expect(strip()).toEqual(['A', 'Gone', 'B']);
  });

  it('a closed window can\'t be dragged (Chrome alone brings one back)', async () => {
    const sw = await boot(withClosed());
    const win = tids('card-closed').find((c) => sw.state.entries.find((e) => e.key === c.dataset.key)?.item.kind === 'window')
      || tids('card-closed').find((c) => !c.draggable);
    expect(win).toBeTruthy();
    expect(win.draggable).toBe(false);
  });
});

describe('a snoozed or starred page, dragged onto the open tabs', () => {
  it('a snoozed tab opens now, behind Tabazing, and its snooze goes', async () => {
    const sw = await boot({ tabs: AB, beforeImport: () => chrome.storage.local.set({ snoozed: [{ id: 'z1', url: 'https://later.example/', title: 'Later', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() }] }) });
    dragTo(cardOf('Later', 'snoozed'), openSection());
    await waitFor(() => created().length === 1);
    expect(created()[0]).toEqual(expect.objectContaining({ url: 'https://later.example/', active: false }));
    await waitFor(() => !sw.state.snoozed.length);
    expect((await chrome.storage.local.get('snoozed')).snoozed).toEqual([]);
    expect(sw.state.done).toBe(false);
  });

  it('a starred page that isn\'t open opens', async () => {
    const sw = await boot({ tabs: AB, beforeImport: () => chrome.storage.local.set({ stars: { 'https://s.example/': { u: 'https://s.example/', ti: 'Saved', t: Date.now() } } }) });
    tid('star-filter').click();
    await waitFor(() => cardOf('Saved', 'star'));
    dragTo(cardOf('Saved', 'star'), openSection());
    await waitFor(() => created().length === 1);
    expect(created()[0]).toEqual(expect.objectContaining({ url: 'https://s.example/', active: false }));
    expect(toastText()).toBe(t('openedN', { count: 1 }));
    expect(sw.state.done).toBe(false);
  });
});

describe('the window list on the left', () => {
  const twoWindows = (more = {}) => ({ tabs: AB, prefs: { allWindows: true }, ...more, beforeImport: async () => {
    chrome._data.closed = [closedTab()];
    chrome._addWindow({ id: 2 });
    chrome._addTab({ windowId: 2, title: 'X', url: 'https://x.example/' });
    if (more.before) await more.before();
  } });
  const winRow = (n) => tids('window-row').filter((r) => tid('window-item', r))[n];

  it('tabs dropped on a window move to its end; Undo moves them back', async () => {
    const sw = await boot(twoWindows());
    const other = winRow(1);
    expect(tid('window-label', other).textContent).toBe(t('windowN', { number: 2 }));
    const over = dragTo(cardOf('B'), other);
    expect(over.defaultPrevented).toBe(true);
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'B').windowId === 2);
    expect(strip(2)).toEqual(['X', 'B']);
    await waitFor(() => toastText() === t('movedToN', { count: 1, window: t('windowN', { number: 2 }) }));
    toastButton().click();
    await waitFor(() => chrome._data.tabs.find((x) => x.title === 'B').windowId === 1);
    expect(sw.state.done).toBe(false);
  });

  it('its own window doesn\'t take a tab that is in it already', async () => {
    await boot(twoWindows());
    expect(dragTo(cardOf('B'), winRow(0)).defaultPrevented).toBe(false);
  });

  it('a recently closed tab dropped on a window opens in it, in the background', async () => {
    await boot(twoWindows());
    dragTo(cardOf('Gone', 'closed'), winRow(1));
    await waitFor(() => created().length === 1);
    expect(created()[0]).toEqual(expect.objectContaining({ url: GONE, windowId: 2, active: false }));
  });

  it('a group\'s tile dropped on a window moves the whole group there', async () => {
    await boot(twoWindows({ tabs: WITH_GROUP, before: () => chrome._addGroup({ id: GROUP, title: 'Work', color: 'blue', windowId: 1 }) }));
    dragTo(tid('card-group'), winRow(1));
    await waitFor(() => chrome.tabGroups.move.mock.calls.length === 1);
    expect(chrome.tabGroups.move).toHaveBeenCalledWith(GROUP, { windowId: 2, index: -1 });
  });
});

describe('Snoozed and Recently closed take tabs', () => {
  it('tabs dropped on Snoozed: its choices open; one snoozes them', async () => {
    const sw = await boot({ tabs: AB, beforeImport: () => chrome.storage.local.set({ snoozed: [{ id: 'z1', url: 'https://later.example/', title: 'Later', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() }] }) });
    const over = dragTo(cardOf('B'), tid('snoozed-section'));
    expect(over.defaultPrevented).toBe(true);
    await waitFor(() => tids('menu-item').length > 0);
    tids('menu-item')[0].click();
    await waitFor(() => sw.state.snoozed.some((x) => x.url === 'https://b.example/'));
    expect(chrome._data.tabs.some((x) => x.title === 'B')).toBe(false);
  });

  it('tabs dropped on Recently closed close; Undo reopens them', async () => {
    await boot(withClosed());
    dragTo(cardOf('B'), tid('closed-section'));
    await waitFor(() => !chrome._data.tabs.some((x) => x.title === 'B'));
    expect(toastText()).toBe(t('closedN', { count: 1 }));
  });

  it('a recently closed card can\'t be dropped on its own list', async () => {
    await boot(withClosed());
    expect(dragTo(cardOf('Gone', 'closed'), tid('closed-section')).defaultPrevented).toBe(false);
  });
});

describe('a link from elsewhere', () => {
  const link = { types: ['text/uri-list'], data: { 'text/uri-list': 'https://dropped.example/page\r\n# a comment\r\njavascript:alert(1)' } };
  it('dropped on the open tabs opens behind Tabazing (web pages only)', async () => {
    const sw = await boot({ tabs: AB });
    const over = ev('dragover', link);
    openSection().dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    openSection().dispatchEvent(ev('drop', link));
    await waitFor(() => created().length === 1);
    expect(created()[0]).toEqual(expect.objectContaining({ url: 'https://dropped.example/page', active: false }));
    expect(sw.state.done).toBe(false);
  });

  it('dropped on a group\'s tile joins the group', async () => {
    await boot(withGroup());
    const g = rect(tid('card-group'));
    g.dispatchEvent(ev('dragover', link));
    g.dispatchEvent(ev('drop', link));
    await waitFor(() => chrome._data.tabs.some((x) => x.url === 'https://dropped.example/page' && x.groupId === GROUP));
  });
});

describe('while dragging', () => {
  it('what takes the thing dragged is outlined, and nothing once it is dropped', async () => {
    await boot(withClosed({ prefs: { allWindows: true }, before: () => { chrome._addWindow({ id: 2 }); chrome._addTab({ windowId: 2, title: 'X', url: 'https://x.example/' }); } }));
    const ok = () => tids('window-row').concat([openSection(), tid('snoozed-section'), tid('closed-section')]).filter((n) => n.classList.contains('drop-ok')).map((n) => n.dataset.testid);
    cardOf('B').dispatchEvent(ev('dragstart'));
    expect(ok()).toEqual(['window-row', 'snoozed-section', 'closed-section']); // (its own window doesn't take it)
    cardOf('B').dispatchEvent(ev('dragend'));
    expect(ok()).toEqual([]);
    cardOf('Gone', 'closed').dispatchEvent(ev('dragstart'));
    expect(ok()).toEqual(['window-row', 'window-row', 'open-section', 'snoozed-section']);
    document.dispatchEvent(ev('dragend'));
    expect(ok()).toEqual([]);
    expect(tids('card-closed').some((c) => c.classList.contains('dragging'))).toBe(false);
  });
});
