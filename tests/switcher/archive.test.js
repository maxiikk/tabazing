// The tab archive: tabs bookmarked into Other bookmarks › "Tabs Archive" and closed, and the overlay that
// lists them (open one, take one out, keys).
import { describe, it, expect, vi } from 'vitest';
import { waitFor, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, cardOf, tabByTitle, toastText, toastButton, closedMessage } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';

const defaultTabs = [
  { title: 'A', url: 'https://a.example/' },
  { title: 'B', url: 'https://b.example/' },
  { title: 'C', url: 'https://c.example/' },
];
const PREVIEW = 'data:image/jpeg;base64,PPPP';
const live = (id) => chrome._data.tabs.find((x) => x.id === id);
const folders = () => chrome._findBookmark('2').children.filter((child) => !child.url && child.title === 'Tabs Archive');
const archivedUrls = () => (folders()[0]?.children || []).map((child) => child.url);

// Seed the archive (oldest first in `pages`), with a preview for the first page.
function seedArchive(pages) {
  const folder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
  const now = Date.now();
  const made = pages.map((page, i) => chrome._addBookmark({ parentId: folder.id, title: page.title, url: page.url, dateAdded: now - (pages.length - i) * 60000 }));
  return { folder, made, preview: chrome.storage.local.set({ ['pv:' + pages[0].url]: { img: PREVIEW, t: now } }) };
}
const OLD = [{ title: 'Old one', url: 'https://old.example/' }, { title: 'Mid one', url: 'https://mid.example/' }, { title: 'New one', url: 'https://new.example/' }];

async function bootArchived(pages = OLD, options = {}) {
  const seeded = seedArchive(pages);
  await seeded.preview;
  const switcher = await boot({ tabs: defaultTabs, ...options });
  return { switcher, ...seeded };
}
async function openOverlay(switcher) {
  byTestId('archive-button').click();
  await waitFor(() => byTestId('archive-overlay') && switcher.archiveOpen());
  return byTestId('archive-overlay');
}

describe('loadArchived', () => {
  it('reads the archive folder, newest first, with previews by address', async () => {
    const { switcher } = await bootArchived();
    await switcher.loadArchived();
    expect(switcher.state.archived.map((x) => x.title)).toEqual(['New one', 'Mid one', 'Old one']);
    expect(Object.keys(switcher.state.archivePreviews)).toEqual(['https://old.example/']);
  });

  it('is empty without a folder', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await switcher.loadArchived();
    expect(switcher.state.archived).toEqual([]);
  });
});

describe('archiveTabs', () => {
  it('bookmarks the tabs into a new "Tabs Archive" folder and closes them', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const [tabB, tabC] = [tabByTitle(switcher, 'B'), tabByTitle(switcher, 'C')];
    await switcher.archiveTabs([tabB, tabC]);
    expect(folders()).toHaveLength(1);
    expect(folders()[0].children.map((child) => [child.title, child.url])).toEqual([['B', 'https://b.example/'], ['C', 'https://c.example/']]);
    expect([live(tabB.id), live(tabC.id)]).toEqual([undefined, undefined]);
    expect(switcher.state.tabs.map((x) => x.title)).toEqual(['A']);
    expect(switcher.state.archived.map((x) => x.url).sort()).toEqual(['https://b.example/', 'https://c.example/']);
    expect(toastText()).toBe(translate('archivedCount', { count: 2 }));
  });

  it('makes the folder only once', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await switcher.archiveTabs([tabByTitle(switcher, 'B')]);
    await switcher.archiveTabs([tabByTitle(switcher, 'C')]);
    expect(folders()).toHaveLength(1);
    expect(archivedUrls()).toEqual(['https://b.example/', 'https://c.example/']);
  });

  it('Undo takes the bookmarks out and reopens the tabs where they were', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await switcher.archiveTabs([tabByTitle(switcher, 'B'), tabByTitle(switcher, 'C')]);
    chrome.tabs.create.mockClear();
    toastButton().click();
    await waitFor(() => toastText() === translate('reopenedCount', { count: 2 }));
    expect(archivedUrls()).toEqual([]);
    expect(chrome.tabs.create.mock.calls.map((call) => call[0])).toEqual([
      { url: 'https://b.example/', windowId: 1, index: 1, pinned: false, active: false },
      { url: 'https://c.example/', windowId: 1, index: 2, pinned: false, active: false },
    ]);
    expect(switcher.state.tabs.map((x) => x.url)).toEqual(expect.arrayContaining(['https://b.example/', 'https://c.example/']));
  });

  it('archived pages stay out of "Recently closed"', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    chrome._data.closed = [{ lastModified: Date.now() / 1000, tab: { sessionId: 's1', url: 'https://b.example/', title: 'B' } }];
    await switcher.archiveTabs([tabByTitle(switcher, 'B')]);
    await switcher.loadClosed();
    expect(switcher.state.closed).toEqual([]);
  });

  it("won't archive pages that can't be reopened", async () => {
    const switcher = await boot({ tabs: [...defaultTabs, { title: 'New', url: 'chrome://newtab/' }] });
    await switcher.archiveTabs([tabByTitle(switcher, 'New')]);
    expect(toastText()).toBe(translate('archiveCant'));
    expect(chrome.bookmarks.create).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('says so when Chrome gives no bookmarks access', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const bookmarks = chrome.bookmarks;
    delete chrome.bookmarks;
    try {
      await switcher.archiveTabs([tabByTitle(switcher, 'B')]);
    } finally { chrome.bookmarks = bookmarks; }
    expect(toastText()).toBe(translate('dropdownNoMarks'));
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('in an overlay closes the tab it sits on last', async () => {
    const switcher = await boot({ tabs: defaultTabs, overlay: true });
    const [tabA, tabB] = [tabByTitle(switcher, 'A'), tabByTitle(switcher, 'B')];
    await switcher.archiveTabs([tabA, tabB]);
    expect(chrome.tabs.remove.mock.calls).toEqual([[[tabB.id]], [tabA.id]]);
    expect(archivedUrls()).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it("a card's archive quick button archives that tab", async () => {
    await boot({ tabs: defaultTabs });
    byTestId('quick-archive', cardOf('C')).click();
    await waitFor(() => !cardOf('C'));
    expect(archivedUrls()).toEqual(['https://c.example/']);
    expect(cardOf('C')).toBeUndefined();
  });
});

describe('openArchived', () => {
  it('takes the page out of the archive and opens it in this window', async () => {
    const { switcher, made } = await bootArchived();
    await switcher.loadArchived();
    await switcher.openArchived(switcher.state.archived[0]);
    expect(chrome._findBookmark(made[2].id)).toBe(null);
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://new.example/', windowId: 1, active: true });
    expect(closedMessage().reason).toBe('switch');
  });

  it('cancels when the tab cannot be opened, and does nothing once closed', async () => {
    const { switcher } = await bootArchived();
    await switcher.loadArchived();
    chrome.tabs.create.mockRejectedValueOnce(new Error('no'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await switcher.openArchived(switcher.state.archived[0]);
    expect(closedMessage().reason).toBe('cancel');
    chrome.bookmarks.remove.mockClear();
    await switcher.openArchived(switcher.state.archived[1]);
    expect(chrome.bookmarks.remove).not.toHaveBeenCalled();
  });
});

describe('the archive overlay', () => {
  it('lists every archived tab, newest first, with its preview or a placeholder', async () => {
    const { switcher } = await bootArchived();
    const overlay = await openOverlay(switcher);
    expect(byTestId('archive-title', overlay).firstChild.textContent).toBe(translate('archiveTitle'));
    expect(byTestId('archive-count', overlay).textContent).toBe('3');
    expect(byTestId('archive-location', overlay).textContent).toBe(translate('archiveWhere'));
    const cards = allByTestId('card-archived', overlay);
    expect(cards.map((card) => byTestId('card-title', card).textContent)).toEqual(['New one', 'Mid one', 'Old one']);
    expect(byTestId('card-preview', cards[2]).src).toBe(PREVIEW);
    expect(byTestId('card-tile-favicon', byTestId('card-no-preview', cards[0]))).not.toBe(null); // no preview: its icon
    expect(byTestId('card-archived-ago', cards[0]).textContent).not.toBe('');
    expect(cards.map((card) => card.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(document.activeElement).toBe(byTestId('archive-grid', overlay)); // the list: the keys move its selection, Enter opens it
  });

  it('has no previews in list size', async () => {
    const { switcher } = await bootArchived(OLD, { preferences: { cardSize: 'list' } });
    const overlay = await openOverlay(switcher);
    expect(byTestId('card-thumb', overlay)).toBe(null);
    expect(byTestId('card-no-preview', overlay)).toBe(null);
  });

  it('closes with its red × or Esc, back to the Archive button that opened it', async () => {
    const { switcher } = await bootArchived();
    let overlay = await openOverlay(switcher);
    byTestId('archive-close', overlay).click();
    expect(byTestId('archive-overlay')).toBe(null);
    expect(switcher.archiveOpen()).toBe(false);
    expect(document.activeElement).toBe(byTestId('menu-button'));
    overlay = await openOverlay(switcher);
    const event = key('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(byTestId('archive-overlay')).toBe(null);
    expect(switcher.state.done).toBe(false); // Esc closed the archive, not the switcher
  });

  it('says when the archive is empty', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const overlay = await openOverlay(switcher);
    expect(byTestId('archive-empty', overlay).textContent).toBe(translate('archiveEmpty'));
    expect(byTestId('archive-grid', overlay)).toBe(null);
  });

  it('says when Chrome gives no bookmarks access', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const bookmarks = chrome.bookmarks;
    delete chrome.bookmarks;
    try {
      await switcher.openArchive();
    } finally { chrome.bookmarks = bookmarks; }
    expect(byTestId('archive-no-bookmarks').textContent).toBe(translate('dropdownNoMarks'));
  });

  it('a click on its empty space does not close the switcher', async () => {
    const { switcher } = await bootArchived();
    const overlay = await openOverlay(switcher);
    overlay.click();
    expect(switcher.state.done).toBe(false);
  });

  it('clicking a card opens that tab', async () => {
    const { switcher, made } = await bootArchived();
    const overlay = await openOverlay(switcher);
    allByTestId('card-archived', overlay)[1].click();
    await waitFor(() => closedMessage());
    expect(chrome._findBookmark(made[1].id)).toBe(null);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://mid.example/', windowId: 1, active: true });
  });

  it("a card's × takes it out without opening it, and Undo puts it back", async () => {
    const { switcher } = await bootArchived();
    const overlay = await openOverlay(switcher);
    byTestId('card-unarchive', allByTestId('card-archived', overlay)[1]).click();
    await waitFor(() => allByTestId('card-archived').length === 2);
    expect(archivedUrls()).toEqual(['https://old.example/', 'https://new.example/']);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(switcher.state.done).toBe(false);
    expect(switcher.state.archiveSelected).toBe(1); // the card that took its place
    expect(toastText()).toBe(translate('archiveRemoved'));
    toastButton().click();
    await waitFor(() => allByTestId('card-archived').length === 3);
    expect(archivedUrls()).toContain('https://mid.example/');
  });

  it('a middle-click on a card opens it behind Tabazing, which stays; it leaves the archive; Undo puts it back', async () => {
    const { switcher } = await bootArchived();
    const overlay = await openOverlay(switcher);
    allByTestId('card-archived', overlay)[1].dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => allByTestId('card-archived').length === 2);
    expect(archivedUrls()).toEqual(['https://old.example/', 'https://new.example/']);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://mid.example/', active: false }));
    expect(switcher.state.done).toBe(false);
    expect(switcher.archiveOpen()).toBe(true);
    expect(toastText()).toBe(translate('openedCount', { count: 1 }));
    toastButton().click();
    await waitFor(() => allByTestId('card-archived').length === 3);
    expect(archivedUrls()).toContain('https://mid.example/');
    expect(chrome._data.tabs.some((x) => x.url === 'https://mid.example/')).toBe(false); // the tab it opened closed again
  });

  it('Ctrl+Enter opens the selected one behind Tabazing too', async () => {
    const { switcher } = await bootArchived();
    await openOverlay(switcher);
    switcher.archiveSelect(0);
    key('Enter', { ctrlKey: true });
    await waitFor(() => allByTestId('card-archived').length === 2);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
    expect(switcher.state.done).toBe(false);
  });

  it('dropArchived redraws an open overlay without that page', async () => {
    const { switcher } = await bootArchived();
    await openOverlay(switcher);
    await switcher.dropArchived(switcher.state.archived[2], 2);
    expect(byTestId('archive-count').textContent).toBe('2');
    expect(switcher.state.archiveSelected).toBe(1); // clamped to the last card
  });

  it('archSelect keeps the selection on a card', async () => {
    const { switcher } = await bootArchived();
    const overlay = await openOverlay(switcher);
    switcher.archiveSelect(9);
    expect(switcher.state.archiveSelected).toBe(2);
    const cards = allByTestId('card-archived', overlay);
    expect(cards[2].getAttribute('aria-selected')).toBe('true');
    expect(byTestId('archive-grid', overlay).getAttribute('aria-activedescendant')).toBe(cards[2].id);
    switcher.archiveSelect(-4);
    expect(switcher.state.archiveSelected).toBe(0);
  });

  it('closeArchive removes it', async () => {
    const { switcher } = await bootArchived();
    await openOverlay(switcher);
    switcher.closeArchive();
    expect(byTestId('archive-overlay')).toBe(null);
  });
});

describe('archive keys', () => {
  it('←/→ move along the cards', async () => {
    const { switcher } = await bootArchived();
    await openOverlay(switcher);
    key('ArrowRight');
    key('ArrowRight');
    expect(switcher.state.archiveSelected).toBe(2);
    key('ArrowLeft');
    expect(switcher.state.archiveSelected).toBe(1);
  });

  it('↓ ↑ move one row at a time (a list), Home / End to the ends', async () => {
    const { switcher } = await bootArchived();
    await openOverlay(switcher);
    key('ArrowDown');
    expect(switcher.state.archiveSelected).toBe(1);
    key('End');
    expect(switcher.state.archiveSelected).toBe(2);
    key('ArrowUp');
    expect(switcher.state.archiveSelected).toBe(1);
    key('Home');
    expect(switcher.state.archiveSelected).toBe(0);
  });

  it('Enter opens the selected card', async () => {
    const { switcher } = await bootArchived();
    await openOverlay(switcher);
    key('ArrowRight');
    key('Enter');
    await waitFor(() => closedMessage());
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://mid.example/', windowId: 1, active: true });
  });

  it('Del takes the selected card out (not on key repeat)', async () => {
    const { switcher } = await bootArchived();
    await openOverlay(switcher);
    key('Delete', { repeat: true });
    expect(chrome.bookmarks.remove).not.toHaveBeenCalled();
    key('Delete');
    await waitFor(() => allByTestId('card-archived').length === 2);
    expect(archivedUrls()).toEqual(['https://old.example/', 'https://mid.example/']);
  });

  it('other keys stay inside the archive', async () => {
    const { switcher } = await bootArchived();
    await openOverlay(switcher);
    const event = key('x');
    expect(event.defaultPrevented).toBe(true);
    expect(byTestId('search').value).toBe('');
    expect(key('Control').defaultPrevented).toBe(false); // modifiers are let through
  });
});
