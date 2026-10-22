// Recently closed tabs: their quick buttons and menu (reopen elsewhere, snooze, archive, take off the list), and
// their notes: a closed page's note is found by the search and shown in its result, as an open tab's is (so are
// an archived, bookmarked or visited page's).
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, toastText, toastButton, closedMsg } from '../helpers/quiet-boot.js';
import { t } from '../../utils/translations.js';

const AB = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const GONE = 'https://gone.example/';
const closedTab = (ago = 60) => ({ lastModified: Math.floor(Date.now() / 1000) - ago, tab: { sessionId: 'c1', url: GONE, title: 'Gone' } });
const note = (url, n) => ({ [url]: { u: url, n, t: Date.now() } });
const withClosed = (more = {}) => ({ tabs: AB, ...more, beforeImport: async () => { chrome._data.closed = [closedTab()]; if (more.notes) await chrome.storage.local.set({ notes: more.notes }); } });
const gone = () => cardOf('Gone', 'closed');
const titles = (sw) => sw.state.entries.filter((e) => e.kind === 'closed').map((e) => e.item.title);
const pick = (sw) => sw.select(sw.state.entries.findIndex((e) => e.kind === 'closed'));
const menuItem = (label) => tids('menu-item').find((b) => b.textContent === label);
const openMenu = (sw) => { pick(sw); key('F10', { shiftKey: true }); };
async function search(sw, text) {
  tid('search').focus();
  tid('search').value = text;
  tid('search').dispatchEvent(new Event('input', { bubbles: true }));
  sw.flushSearch();
  await tick(20);
}

describe('a recently closed card', () => {
  it('has its note button and ⋯ (its menu) among its quick buttons', async () => {
    const sw = await boot(withClosed({ notes: note(GONE, 'read later') }));
    const quick = tid('card-quick-actions', gone());
    expect(tid('quick-note', quick).dataset.note).toBe('read later');
    expect(tid('quick-more', quick).getAttribute('aria-haspopup')).toBe('menu');
    tid('quick-more', quick).click();
    expect(tids('menu-item')[0].textContent).toBe(t('closedReopen'));
    expect(sw.state.done).toBe(false);
  });

  it('Remove from list (or Del) takes it off, for good; Undo puts it back', async () => {
    const sw = await boot(withClosed());
    expect(titles(sw)).toEqual(['Gone']);
    pick(sw);
    key('Delete');
    await waitFor(() => !titles(sw).length);
    expect(toastText()).toBe(t('closedRemoved'));
    expect(Object.keys((await chrome.storage.local.get('closedHidden')).closedHidden)).toEqual([GONE]);
    await sw.loadClosed(); // read again (another open): still left out
    expect(sw.state.closed).toEqual([]);
    toastButton().click();
    await waitFor(() => titles(sw).length === 1);
  });

  it('a later closing of the same page shows again', async () => {
    const sw = await boot(withClosed());
    openMenu(sw);
    menuItem(t('closedRemove')).click();
    await waitFor(() => !titles(sw).length);
    chrome._data.closed = [{ ...closedTab(-5), tab: { sessionId: 'c2', url: GONE, title: 'Gone' } }];
    await sw.loadClosed();
    expect(sw.state.closed.map((c) => c.title)).toEqual(['Gone']);
  });

  it('Reopen in a new window: a window of its own, and Tabazing closes', async () => {
    const sw = await boot(withClosed());
    openMenu(sw);
    menuItem(t('closedNewWindow')).click();
    await waitFor(() => closedMsg());
    expect(chrome.windows.create).toHaveBeenCalledWith({ url: GONE, focused: true });
    expect(closedMsg().reason).toBe('restore');
  });

  it('Reopen in the background: a tab behind Tabazing, which stays; the entry leaves the list', async () => {
    const sw = await boot(withClosed());
    openMenu(sw);
    menuItem(t('closedBackgroundFresh')).click(); // (one Chrome remembers: a fresh tab, without its history)
    await waitFor(() => sw.state.tabs.some((x) => x.url === GONE));
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: GONE, windowId: 1, active: false });
    expect(titles(sw)).toEqual([]);
    expect(sw.state.done).toBe(false);
  });

  it('Snooze: it moves to Snoozed and opens again then; Undo brings it back here', async () => {
    const sw = await boot(withClosed());
    openMenu(sw);
    menuItem(t('closedSnooze')).click();
    tids('menu-item')[0].click(); // in an hour
    await waitFor(() => sw.state.snoozed.length === 1);
    expect(sw.state.snoozed[0]).toMatchObject({ url: GONE, title: 'Gone', windowId: 1 });
    expect(titles(sw)).toEqual([]);
    expect(tid('snoozed-section').hidden).toBe(false);
    toastButton().click();
    await waitFor(() => titles(sw).length === 1 && !sw.state.snoozed.length);
  });

  it('Archive: into the "Tabs Archive" folder, listed there from now on, not here', async () => {
    const sw = await boot(withClosed());
    openMenu(sw);
    menuItem(t('tabArchive')).click();
    await waitFor(() => !titles(sw).length);
    expect(sw.state.archived.map((x) => x.url)).toEqual([GONE]);
    expect(toastText()).toBe(t('archivedN', { count: 1 }));
  });

  it('Copy link copies its address', async () => {
    const clip = { writeText: vi.fn(async () => {}) };
    Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true });
    const sw = await boot(withClosed());
    openMenu(sw);
    menuItem(t('copyLink')).click();
    await waitFor(() => clip.writeText.mock.calls.length);
    expect(clip.writeText).toHaveBeenCalledWith(GONE);
  });
});

describe('notes, whatever state the page is in', () => {
  it('a closed tab found by its note says so in its result (the note, marked)', async () => {
    const sw = await boot(withClosed({ notes: note(GONE, 'quarterly budget') }));
    await search(sw, 'budget');
    const row = tids('dd-row-closed')[0];
    expect(row).not.toBe(undefined);
    expect(tid('dd-note', row).textContent).toBe('quarterly budget');
    expect(tid('search-highlight', tid('dd-note', row)).textContent).toBe('budget');
    expect(tid('dd-note-tag', row)).toBe(null);
  });

  it('found by its title, a closed tab with a note gets the "Note" tag instead', async () => {
    const sw = await boot(withClosed({ notes: note(GONE, 'quarterly budget') }));
    await search(sw, 'gone');
    const row = tids('dd-row-closed')[0];
    expect(tid('dd-note-tag', row).textContent).toBe(t('noteTitle'));
    expect(tid('dd-note', row)).toBe(null);
  });

  it('a middle-click on a closed result takes it off the list; on a bookmark or a visited page, opens it behind', async () => {
    const MARK = 'https://mark.example/', SEEN = 'https://seen.example/';
    const middle = (row) => row.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    const sw = await boot({ ...withClosed(), beforeImport: async () => {
      chrome._data.closed = [closedTab()];
      chrome._addBookmark({ title: 'Gone mark', url: MARK });
      chrome._data.history = [{ url: SEEN, title: 'Gone seen', lastVisitTime: Date.now() - 1000, visitCount: 1 }];
    } });
    await search(sw, 'gone');
    await waitFor(() => tids('dd-row-closed').length && tids('dd-row-mark').length && tids('dd-row-visit').length);
    middle(tids('dd-row-closed')[0]);
    await waitFor(() => !titles(sw).length && !tids('dd-row-closed').length);
    expect(toastText()).toBe(t('closedRemoved'));
    middle(tids('dd-row-mark')[0]);
    await waitFor(() => chrome.tabs.create.mock.calls.length === 1);
    middle(tids('dd-row-visit')[0]);
    await waitFor(() => chrome.tabs.create.mock.calls.length === 2);
    expect(chrome.tabs.create.mock.calls.map(([o]) => [o.url, o.active])).toEqual([[MARK, false], [SEEN, false]]);
    expect(sw.state.done).toBe(false);
  });

  it('bookmarked and visited pages are found by their notes too', async () => {
    const MARK = 'https://mark.example/', SEEN = 'https://seen.example/';
    const sw = await boot({ tabs: AB, beforeImport: async () => {
      chrome._addBookmark({ title: 'Some bookmark', url: MARK });
      chrome._data.history = [{ url: SEEN, title: 'Some page', lastVisitTime: Date.now() - 1000, visitCount: 1 }];
      await chrome.storage.local.set({ notes: { ...note(MARK, 'invoice template'), ...note(SEEN, 'invoice archive') } });
    } });
    await search(sw, 'invoice');
    await waitFor(() => tids('dd-row-mark').length && tids('dd-row-visit').length);
    expect(tid('dd-note', tids('dd-row-mark')[0]).textContent).toBe('invoice template');
    expect(tid('dd-note', tids('dd-row-visit')[0]).textContent).toBe('invoice archive');
  });

  it('a note written on a closed card is kept by its page', async () => {
    await boot(withClosed());
    tid('quick-note', gone()).click();
    const box = tid('note-input');
    box.value = 'call back';
    box.dispatchEvent(new Event('input'));
    await vi.waitFor(async () => expect((await chrome.storage.local.get('notes')).notes?.[GONE]?.n).toBe('call back'));
  });
});
