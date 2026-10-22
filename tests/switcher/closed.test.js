// Recently closed tabs: their quick buttons and menu (reopen elsewhere, snooze, archive, take off the list), and
// their notes: a closed page's note is found by the search and shown in its result, as an open tab's is (so are
// an archived, bookmarked or visited page's).
import { describe, it, expect, vi } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, cardOf, toastText, toastButton, closedMessage } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';

const twoTabs = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const GONE = 'https://gone.example/';
const closedTab = (ago = 60) => ({ lastModified: Math.floor(Date.now() / 1000) - ago, tab: { sessionId: 'c1', url: GONE, title: 'Gone' } });
const note = (url, text) => ({ [url]: { u: url, n: text, t: Date.now() } });
const withClosed = (more = {}) => ({ tabs: twoTabs, ...more, beforeImport: async () => { chrome._data.closed = [closedTab()]; if (more.notes) await chrome.storage.local.set({ notes: more.notes }); } });
const gone = () => cardOf('Gone', 'closed');
const titles = (switcher) => switcher.state.entries.filter((entry) => entry.kind === 'closed').map((entry) => entry.item.title);
const pick = (switcher) => switcher.select(switcher.state.entries.findIndex((entry) => entry.kind === 'closed'));
const menuItem = (label) => allByTestId('menu-item').find((button) => button.textContent === label);
const openMenu = (switcher) => { pick(switcher); key('F10', { shiftKey: true }); };
async function search(switcher, text) {
  byTestId('search').focus();
  byTestId('search').value = text;
  byTestId('search').dispatchEvent(new Event('input', { bubbles: true }));
  switcher.flushSearch();
  await tick(20);
}

describe('a recently closed card', () => {
  it('has its note button and ⋯ (its menu) among its quick buttons', async () => {
    const switcher = await boot(withClosed({ notes: note(GONE, 'read later') }));
    const quick = byTestId('card-quick-actions', gone());
    expect(byTestId('quick-note', quick).dataset.note).toBe('read later');
    expect(byTestId('quick-more', quick).getAttribute('aria-haspopup')).toBe('menu');
    byTestId('quick-more', quick).click();
    expect(allByTestId('menu-item')[0].textContent).toBe(translate('closedReopen'));
    expect(switcher.state.done).toBe(false);
  });

  it('Remove from list (or Del) takes it off, for good; Undo puts it back', async () => {
    const switcher = await boot(withClosed());
    expect(titles(switcher)).toEqual(['Gone']);
    pick(switcher);
    key('Delete');
    await waitFor(() => !titles(switcher).length);
    expect(toastText()).toBe(translate('closedRemoved'));
    expect(Object.keys((await chrome.storage.local.get('closedHidden')).closedHidden)).toEqual([GONE]);
    await switcher.loadClosed(); // read again (another open): still left out
    expect(switcher.state.closed).toEqual([]);
    toastButton().click();
    await waitFor(() => titles(switcher).length === 1);
  });

  it('a later closing of the same page shows again', async () => {
    const switcher = await boot(withClosed());
    openMenu(switcher);
    menuItem(translate('closedRemove')).click();
    await waitFor(() => !titles(switcher).length);
    chrome._data.closed = [{ ...closedTab(-5), tab: { sessionId: 'c2', url: GONE, title: 'Gone' } }];
    await switcher.loadClosed();
    expect(switcher.state.closed.map((item) => item.title)).toEqual(['Gone']);
  });

  it('Reopen in a new window: a window of its own, and Tabazing closes', async () => {
    const switcher = await boot(withClosed());
    openMenu(switcher);
    menuItem(translate('closedNewWindow')).click();
    await waitFor(() => closedMessage());
    expect(chrome.windows.create).toHaveBeenCalledWith({ url: GONE, focused: true });
    expect(closedMessage().reason).toBe('restore');
  });

  it('Reopen in the background: a tab behind Tabazing, which stays; the entry leaves the list', async () => {
    const switcher = await boot(withClosed());
    openMenu(switcher);
    menuItem(translate('closedBackgroundFresh')).click(); // (one Chrome remembers: a fresh tab, without its history)
    await waitFor(() => switcher.state.tabs.some((x) => x.url === GONE));
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: GONE, windowId: 1, active: false });
    expect(titles(switcher)).toEqual([]);
    expect(switcher.state.done).toBe(false);
  });

  it('Snooze: it moves to Snoozed and opens again then; Undo brings it back here', async () => {
    const switcher = await boot(withClosed());
    openMenu(switcher);
    menuItem(translate('closedSnooze')).click();
    allByTestId('menu-item')[0].click(); // in an hour
    await waitFor(() => switcher.state.snoozed.length === 1);
    expect(switcher.state.snoozed[0]).toMatchObject({ url: GONE, title: 'Gone', windowId: 1 });
    expect(titles(switcher)).toEqual([]);
    expect(byTestId('snoozed-section').hidden).toBe(false);
    toastButton().click();
    await waitFor(() => titles(switcher).length === 1 && !switcher.state.snoozed.length);
  });

  it('Archive: into the "Tabs Archive" folder, listed there from now on, not here', async () => {
    const switcher = await boot(withClosed());
    openMenu(switcher);
    menuItem(translate('tabArchive')).click();
    await waitFor(() => !titles(switcher).length);
    expect(switcher.state.archived.map((x) => x.url)).toEqual([GONE]);
    expect(toastText()).toBe(translate('archivedCount', { count: 1 }));
  });

  it('Copy link copies its address', async () => {
    const clip = { writeText: vi.fn(async () => {}) };
    Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true });
    const switcher = await boot(withClosed());
    openMenu(switcher);
    menuItem(translate('copyLink')).click();
    await waitFor(() => clip.writeText.mock.calls.length);
    expect(clip.writeText).toHaveBeenCalledWith(GONE);
  });
});

describe('notes, whatever state the page is in', () => {
  it('a closed tab found by its note says so in its result (the note, marked)', async () => {
    const switcher = await boot(withClosed({ notes: note(GONE, 'quarterly budget') }));
    await search(switcher, 'budget');
    const row = allByTestId('dropdown-row-closed')[0];
    expect(row).not.toBe(undefined);
    expect(byTestId('dropdown-note', row).textContent).toBe('quarterly budget');
    expect(byTestId('search-highlight', byTestId('dropdown-note', row)).textContent).toBe('budget');
    expect(byTestId('dropdown-note-tag', row)).toBe(null);
  });

  it('found by its title, a closed tab with a note gets the "Note" tag instead', async () => {
    const switcher = await boot(withClosed({ notes: note(GONE, 'quarterly budget') }));
    await search(switcher, 'gone');
    const row = allByTestId('dropdown-row-closed')[0];
    expect(byTestId('dropdown-note-tag', row).textContent).toBe(translate('noteTitle'));
    expect(byTestId('dropdown-note', row)).toBe(null);
  });

  it('a middle-click on a closed result takes it off the list; on a bookmark or a visited page, opens it behind', async () => {
    const MARK = 'https://mark.example/', SEEN = 'https://seen.example/';
    const middle = (row) => row.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    const switcher = await boot({ ...withClosed(), beforeImport: async () => {
      chrome._data.closed = [closedTab()];
      chrome._addBookmark({ title: 'Gone mark', url: MARK });
      chrome._data.history = [{ url: SEEN, title: 'Gone seen', lastVisitTime: Date.now() - 1000, visitCount: 1 }];
    } });
    await search(switcher, 'gone');
    await waitFor(() => allByTestId('dropdown-row-closed').length && allByTestId('dropdown-row-mark').length && allByTestId('dropdown-row-visit').length);
    middle(allByTestId('dropdown-row-closed')[0]);
    await waitFor(() => !titles(switcher).length && !allByTestId('dropdown-row-closed').length);
    expect(toastText()).toBe(translate('closedRemoved'));
    middle(allByTestId('dropdown-row-mark')[0]);
    await waitFor(() => chrome.tabs.create.mock.calls.length === 1);
    middle(allByTestId('dropdown-row-visit')[0]);
    await waitFor(() => chrome.tabs.create.mock.calls.length === 2);
    expect(chrome.tabs.create.mock.calls.map(([options]) => [options.url, options.active])).toEqual([[MARK, false], [SEEN, false]]);
    expect(switcher.state.done).toBe(false);
  });

  it('bookmarked and visited pages are found by their notes too', async () => {
    const MARK = 'https://mark.example/', SEEN = 'https://seen.example/';
    const switcher = await boot({ tabs: twoTabs, beforeImport: async () => {
      chrome._addBookmark({ title: 'Some bookmark', url: MARK });
      chrome._data.history = [{ url: SEEN, title: 'Some page', lastVisitTime: Date.now() - 1000, visitCount: 1 }];
      await chrome.storage.local.set({ notes: { ...note(MARK, 'invoice template'), ...note(SEEN, 'invoice archive') } });
    } });
    await search(switcher, 'invoice');
    await waitFor(() => allByTestId('dropdown-row-mark').length && allByTestId('dropdown-row-visit').length);
    expect(byTestId('dropdown-note', allByTestId('dropdown-row-mark')[0]).textContent).toBe('invoice template');
    expect(byTestId('dropdown-note', allByTestId('dropdown-row-visit')[0]).textContent).toBe('invoice archive');
  });

  it('a note written on a closed card is kept by its page', async () => {
    await boot(withClosed());
    byTestId('quick-note', gone()).click();
    const box = byTestId('note-input');
    box.value = 'call back';
    box.dispatchEvent(new Event('input'));
    await vi.waitFor(async () => expect((await chrome.storage.local.get('notes')).notes?.[GONE]?.n).toBe('call back'));
  });
});
