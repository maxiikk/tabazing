// The tab archive: tabs bookmarked into Other bookmarks › "Tabs Archive" and closed, and the overlay that
// lists them (open one, take one out, keys).
import { describe, it, expect, vi } from 'vitest';
import { waitFor, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, tabByTitle, toastText, toastButton, closedMsg } from './quiet-boot.js';
import { getTranslation } from '../../lib/translations.js';

const ABC = [
  { title: 'A', url: 'https://a.example/' },
  { title: 'B', url: 'https://b.example/' },
  { title: 'C', url: 'https://c.example/' },
];
const PV = 'data:image/jpeg;base64,PPPP';
const live = (id) => chrome._data.tabs.find((x) => x.id === id);
const folders = () => chrome._findBookmark('2').children.filter((n) => !n.url && n.title === 'Tabs Archive');
const archivedUrls = () => (folders()[0]?.children || []).map((n) => n.url);

// Seed the archive (oldest first in `pages`), with a preview for the first page.
function seedArchive(pages) {
  const folder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
  const now = Date.now();
  const made = pages.map((p, i) => chrome._addBookmark({ parentId: folder.id, title: p.title, url: p.url, dateAdded: now - (pages.length - i) * 60000 }));
  return { folder, made, preview: chrome.storage.local.set({ ['pv:' + pages[0].url]: { img: PV, t: now } }) };
}
const OLD = [{ title: 'Old one', url: 'https://old.example/' }, { title: 'Mid one', url: 'https://mid.example/' }, { title: 'New one', url: 'https://new.example/' }];

async function bootArchived(pages = OLD, opts = {}) {
  const s = seedArchive(pages);
  await s.preview;
  const sw = await boot({ tabs: ABC, ...opts });
  return { sw, ...s };
}
async function openOverlay(sw) {
  tid('archive-btn').click();
  await waitFor(() => tid('archive-overlay') && sw.archiveOpen());
  return tid('archive-overlay');
}

describe('loadArchived', () => {
  it('reads the archive folder, newest first, with previews by address', async () => {
    const { sw } = await bootArchived();
    await sw.loadArchived();
    expect(sw.state.archived.map((x) => x.title)).toEqual(['New one', 'Mid one', 'Old one']);
    expect(Object.keys(sw.state.archivePreviews)).toEqual(['https://old.example/']);
  });

  it('is empty without a folder', async () => {
    const sw = await boot({ tabs: ABC });
    await sw.loadArchived();
    expect(sw.state.archived).toEqual([]);
  });
});

describe('archiveTabs', () => {
  it('bookmarks the tabs into a new "Tabs Archive" folder and closes them', async () => {
    const sw = await boot({ tabs: ABC });
    const [b, c] = [tabByTitle(sw, 'B'), tabByTitle(sw, 'C')];
    await sw.archiveTabs([b, c]);
    expect(folders()).toHaveLength(1);
    expect(folders()[0].children.map((n) => [n.title, n.url])).toEqual([['B', 'https://b.example/'], ['C', 'https://c.example/']]);
    expect([live(b.id), live(c.id)]).toEqual([undefined, undefined]);
    expect(sw.state.tabs.map((x) => x.title)).toEqual(['A']);
    expect(sw.state.archived.map((x) => x.url).sort()).toEqual(['https://b.example/', 'https://c.example/']);
    expect(toastText()).toBe(getTranslation('archivedN', { count: 2 }));
  });

  it('makes the folder only once', async () => {
    const sw = await boot({ tabs: ABC });
    await sw.archiveTabs([tabByTitle(sw, 'B')]);
    await sw.archiveTabs([tabByTitle(sw, 'C')]);
    expect(folders()).toHaveLength(1);
    expect(archivedUrls()).toEqual(['https://b.example/', 'https://c.example/']);
  });

  it('Undo takes the bookmarks out and reopens the tabs where they were', async () => {
    const sw = await boot({ tabs: ABC });
    await sw.archiveTabs([tabByTitle(sw, 'B'), tabByTitle(sw, 'C')]);
    chrome.tabs.create.mockClear();
    toastButton().click();
    await waitFor(() => toastText() === getTranslation('reopenedN', { count: 2 }));
    expect(archivedUrls()).toEqual([]);
    expect(chrome.tabs.create.mock.calls.map((c) => c[0])).toEqual([
      { url: 'https://b.example/', windowId: 1, index: 1, pinned: false, active: false },
      { url: 'https://c.example/', windowId: 1, index: 2, pinned: false, active: false },
    ]);
    expect(sw.state.tabs.map((x) => x.url)).toEqual(expect.arrayContaining(['https://b.example/', 'https://c.example/']));
  });

  it('archived pages stay out of "Recently closed"', async () => {
    const sw = await boot({ tabs: ABC });
    chrome._data.closed = [{ lastModified: Date.now() / 1000, tab: { sessionId: 's1', url: 'https://b.example/', title: 'B' } }];
    await sw.archiveTabs([tabByTitle(sw, 'B')]);
    await sw.loadClosed();
    expect(sw.state.closed).toEqual([]);
  });

  it("won't archive pages that can't be reopened", async () => {
    const sw = await boot({ tabs: [...ABC, { title: 'New', url: 'chrome://newtab/' }] });
    await sw.archiveTabs([tabByTitle(sw, 'New')]);
    expect(toastText()).toBe(getTranslation('archiveCant'));
    expect(chrome.bookmarks.create).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('says so when Chrome gives no bookmarks access', async () => {
    const sw = await boot({ tabs: ABC });
    const bookmarks = chrome.bookmarks;
    delete chrome.bookmarks;
    try {
      await sw.archiveTabs([tabByTitle(sw, 'B')]);
    } finally { chrome.bookmarks = bookmarks; }
    expect(toastText()).toBe(getTranslation('ddNoMarks'));
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('in an overlay closes the tab it sits on last', async () => {
    const sw = await boot({ tabs: ABC, overlay: true });
    const [a, b] = [tabByTitle(sw, 'A'), tabByTitle(sw, 'B')];
    await sw.archiveTabs([a, b]);
    expect(chrome.tabs.remove.mock.calls).toEqual([[[b.id]], [a.id]]);
    expect(archivedUrls()).toEqual(['https://a.example/', 'https://b.example/']);
  });

  it("a card's archive quick button archives that tab", async () => {
    const sw = await boot({ tabs: ABC });
    tid('quick-archive', cardOf('C')).click();
    await waitFor(() => !cardOf('C'));
    expect(archivedUrls()).toEqual(['https://c.example/']);
    expect(cardOf('C')).toBeUndefined();
  });
});

describe('openArchived', () => {
  it('takes the page out of the archive and opens it in this window', async () => {
    const { sw, made } = await bootArchived();
    await sw.loadArchived();
    await sw.openArchived(sw.state.archived[0]);
    expect(chrome._findBookmark(made[2].id)).toBe(null);
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://new.example/', windowId: 1, active: true });
    expect(closedMsg().reason).toBe('switch');
  });

  it('cancels when the tab cannot be opened, and does nothing once closed', async () => {
    const { sw } = await bootArchived();
    await sw.loadArchived();
    chrome.tabs.create.mockRejectedValueOnce(new Error('no'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sw.openArchived(sw.state.archived[0]);
    expect(closedMsg().reason).toBe('cancel');
    chrome.bookmarks.remove.mockClear();
    await sw.openArchived(sw.state.archived[1]);
    expect(chrome.bookmarks.remove).not.toHaveBeenCalled();
  });
});

describe('the archive overlay', () => {
  it('lists every archived tab, newest first, with its preview or a placeholder', async () => {
    const { sw } = await bootArchived();
    const o = await openOverlay(sw);
    expect(tid('archive-title', o).firstChild.textContent).toBe(getTranslation('archiveTitle'));
    expect(tid('archive-count', o).textContent).toBe('3');
    expect(tid('archive-location', o).textContent).toBe(getTranslation('archiveWhere'));
    const cards = tids('card-archived', o);
    expect(cards.map((c) => tid('card-title', c).textContent)).toEqual(['New one', 'Mid one', 'Old one']);
    expect(tid('card-preview', cards[2]).src).toBe(PV);
    expect(tid('card-no-preview-label', cards[0]).textContent).toBe(getTranslation('archivedLabel'));
    expect(tid('card-archived-ago', cards[0]).textContent).not.toBe('');
    expect(cards.map((c) => c.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(document.activeElement).toBe(tid('archive-close', o));
  });

  it('has no previews in list size', async () => {
    const { sw } = await bootArchived(OLD, { prefs: { cardSize: 'list' } });
    const o = await openOverlay(sw);
    expect(tid('card-thumb', o)).toBe(null);
  });

  it('closes with its red × or Esc, back to the Archive button that opened it', async () => {
    const { sw } = await bootArchived();
    let o = await openOverlay(sw);
    tid('archive-close', o).click();
    expect(tid('archive-overlay')).toBe(null);
    expect(sw.archiveOpen()).toBe(false);
    expect(document.activeElement).toBe(tid('archive-btn'));
    o = await openOverlay(sw);
    const e = key('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(tid('archive-overlay')).toBe(null);
    expect(sw.state.done).toBe(false); // Esc closed the archive, not the switcher
  });

  it('says when the archive is empty', async () => {
    const sw = await boot({ tabs: ABC });
    const o = await openOverlay(sw);
    expect(tid('archive-empty', o).textContent).toBe(getTranslation('archiveEmpty'));
    expect(tid('archive-grid', o)).toBe(null);
  });

  it('says when Chrome gives no bookmarks access', async () => {
    const sw = await boot({ tabs: ABC });
    const bookmarks = chrome.bookmarks;
    delete chrome.bookmarks;
    try {
      await sw.openArchive();
    } finally { chrome.bookmarks = bookmarks; }
    expect(tid('archive-no-bookmarks').textContent).toBe(getTranslation('ddNoMarks'));
  });

  it('a click on its empty space does not close the switcher', async () => {
    const { sw } = await bootArchived();
    const o = await openOverlay(sw);
    o.click();
    expect(sw.state.done).toBe(false);
  });

  it('clicking a card opens that tab', async () => {
    const { sw, made } = await bootArchived();
    const o = await openOverlay(sw);
    tids('card-archived', o)[1].click();
    await waitFor(() => closedMsg());
    expect(chrome._findBookmark(made[1].id)).toBe(null);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://mid.example/', windowId: 1, active: true });
  });

  it("a card's × takes it out without opening it, and Undo puts it back", async () => {
    const { sw } = await bootArchived();
    const o = await openOverlay(sw);
    tid('card-unarchive', tids('card-archived', o)[1]).click();
    await waitFor(() => tids('card-archived').length === 2);
    expect(archivedUrls()).toEqual(['https://old.example/', 'https://new.example/']);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(sw.state.done).toBe(false);
    expect(sw.state.archSel).toBe(1); // the card that took its place
    expect(toastText()).toBe(getTranslation('archiveRemoved'));
    toastButton().click();
    await waitFor(() => tids('card-archived').length === 3);
    expect(archivedUrls()).toContain('https://mid.example/');
  });

  it('dropArchived redraws an open overlay without that page', async () => {
    const { sw } = await bootArchived();
    await openOverlay(sw);
    await sw.dropArchived(sw.state.archived[2], 2);
    expect(tid('archive-count').textContent).toBe('2');
    expect(sw.state.archSel).toBe(1); // clamped to the last card
  });

  it('archSelect keeps the selection on a card', async () => {
    const { sw } = await bootArchived();
    const o = await openOverlay(sw);
    sw.archSelect(9);
    expect(sw.state.archSel).toBe(2);
    const cards = tids('card-archived', o);
    expect(cards[2].getAttribute('aria-selected')).toBe('true');
    expect(tid('archive-grid', o).getAttribute('aria-activedescendant')).toBe(cards[2].id);
    sw.archSelect(-4);
    expect(sw.state.archSel).toBe(0);
  });

  it('closeArchive removes it', async () => {
    const { sw } = await bootArchived();
    await openOverlay(sw);
    sw.closeArchive();
    expect(tid('archive-overlay')).toBe(null);
  });
});

describe('archive keys', () => {
  it('←/→ move along the cards', async () => {
    const { sw } = await bootArchived();
    await openOverlay(sw);
    key('ArrowRight');
    key('ArrowRight');
    expect(sw.state.archSel).toBe(2);
    key('ArrowLeft');
    expect(sw.state.archSel).toBe(1);
  });

  it('↓ goes to the card below', async () => {
    const { sw } = await bootArchived();
    const o = await openOverlay(sw);
    const at = (top) => () => ({ top, bottom: top + 50, left: 0, right: 100, width: 100, height: 50 });
    const cards = tids('card-archived', o);
    [0, 0, 100].forEach((top, i) => { cards[i].getBoundingClientRect = at(top); });
    key('ArrowDown');
    expect(sw.state.archSel).toBe(2);
  });

  it('Enter opens the selected card', async () => {
    const { sw } = await bootArchived();
    await openOverlay(sw);
    key('ArrowRight');
    key('Enter');
    await waitFor(() => closedMsg());
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://mid.example/', windowId: 1, active: true });
  });

  it('Del takes the selected card out (not on key repeat)', async () => {
    const { sw } = await bootArchived();
    await openOverlay(sw);
    key('Delete', { repeat: true });
    expect(chrome.bookmarks.remove).not.toHaveBeenCalled();
    key('Delete');
    await waitFor(() => tids('card-archived').length === 2);
    expect(archivedUrls()).toEqual(['https://old.example/', 'https://mid.example/']);
  });

  it('other keys stay inside the archive', async () => {
    const { sw } = await bootArchived();
    await openOverlay(sw);
    const e = key('x');
    expect(e.defaultPrevented).toBe(true);
    expect(tid('search').value).toBe('');
    expect(key('Control').defaultPrevented).toBe(false); // modifiers are let through
  });
});
