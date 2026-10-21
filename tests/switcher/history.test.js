// The browsing history (the clock button beside Settings): Chrome's history over the switcher, newest first, 50 at a
// time ("Show 50 more"); previews, or just the page's icon; open, big preview, remove from the history, the ⋯ menu,
// the keys. And a recently closed card's delete button (where its star was).
import { describe, it, expect } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, toastText } from './quiet-boot.js';
import { t } from '../../utils/translations.js';

const AB = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const PV = 'data:image/jpeg;base64,HHHH';
const NOW = Date.now();
// `n` visited pages, page 1 the newest; and a chrome:// page Tabazing can't open (left out).
function seedHistory(n) {
  for (let i = 1; i <= n; i++) chrome._data.history.push({ url: `https://p${i}.example/`, title: 'Page ' + i, lastVisitTime: NOW - i * 60000, visitCount: 1 });
  chrome._data.history.push({ url: 'chrome://settings/', title: 'Settings', lastVisitTime: NOW, visitCount: 1 });
}
const cards = () => tids('card-history');
const titles = () => cards().map((c) => tid('card-title', c).textContent);
const menuLabels = () => tids('menu-item').map((b) => b.textContent);
async function openHistory(sw) {
  tid('history-btn').click();
  await waitFor(() => sw.historyOpen() && cards().length > 0 || tid('history-empty')?.hidden === false);
  return tid('history-overlay');
}

describe('the history button', () => {
  it('sits right of New tab (then the bookmarks button), a labelled icon button that opens a dialog', async () => {
    await boot({ tabs: AB });
    const b = tid('history-btn');
    expect(tid('newtab').nextElementSibling).toBe(b);
    expect(b.nextElementSibling).toBe(tid('bookmarks-btn'));
    expect(b.getAttribute('aria-label')).toBe(t('historyBtn'));
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
  });
});

describe('the history overlay', () => {
  it('shows the newest 50 pages first (only pages Tabazing can open), then 50 more at a time', async () => {
    seedHistory(120);
    const sw = await boot({ tabs: AB });
    const o = await openHistory(sw);
    expect(o.getAttribute('role')).toBe('dialog');
    expect(o.getAttribute('aria-modal')).toBe('true');
    expect(cards()).toHaveLength(50);
    expect(titles().slice(0, 3)).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(titles()).not.toContain('Settings');
    expect(tid('history-count').textContent).toBe('50');
    const more = tid('history-more');
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe(t('historyMore', { count: 50 }));
    more.click();
    await waitFor(() => cards().length === 100);
    expect(titles()[50]).toBe('Page 51');
    more.click();
    await waitFor(() => cards().length === 120);
    await waitFor(() => tid('history-more').hidden);
    expect(tid('history-count').textContent).toBe('120');
    expect(new Set(titles()).size).toBe(120); // none twice
  });

  it('a page with a preview shows it; one without shows just its icon (no "No preview yet")', async () => {
    seedHistory(2);
    await chrome.storage.local.set({ 'pv:https://p1.example/': { img: PV, t: NOW } });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(tid('card-preview', cards()[0]).src).toBe(PV);
    const none = tid('card-no-preview', cards()[1]);
    expect(none.classList.contains('bare')).toBe(true);
    expect(tid('card-tile-favicon', none)).not.toBe(null);
    expect(tid('card-no-preview-label', none)).toBe(null);
    expect(tid('card-tile-badge', none)).toBe(null);
  });

  it('nothing in the history: says so, no "Show more"', async () => {
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(tid('history-empty').hidden).toBe(false);
    expect(tid('history-empty').textContent).toBe(t('historyEmpty'));
    expect(tid('history-more').hidden).toBe(true);
  });

  it('a click opens the page: its tab when one is open, else a new tab beside the page', async () => {
    seedHistory(1);
    chrome._data.history.push({ url: 'https://a.example/', title: 'A visit', lastVisitTime: NOW, visitCount: 3 });
    let sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(titles()[0]).toBe('A visit');
    cards()[0].click();
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(sw.state.tabs.find((x) => x.title === 'A').id, { active: true });
    sw = await boot({ tabs: AB });
    await openHistory(sw);
    cards()[1].click();
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p1.example/', active: true }));
  });

  it('its trash removes the page from Chrome\'s history and from the list', async () => {
    seedHistory(3);
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('card-history-remove', cards()[1]).click();
    await waitFor(() => cards().length === 2);
    expect(chrome.history.deleteUrl).toHaveBeenCalledWith({ url: 'https://p2.example/' });
    expect(titles()).toEqual(['Page 1', 'Page 3']);
    expect(tid('history-count').textContent).toBe('2');
    expect(toastText()).toBe(t('historyRemoved'));
  });

  it('its ⋯ lists what can be done with a page, and Remove from history', async () => {
    seedHistory(2);
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('quick-more', cards()[0]).click();
    expect(menuLabels()).toEqual([
      t('historyOpen'), t('historyNewWindow'), t('historyBehind'), t('historyBig'), t('copyLink'), t('star'), t('noteAdd'),
      t('markMenu'), t('historySnooze'), t('tabArchive'), t('historyRemove'),
    ]);
    tids('menu-item').find((b) => b.textContent === t('historyBehind')).click();
    await waitFor(() => chrome.tabs.create.mock.calls.length > 0);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p1.example/', active: false }));
    expect(sw.state.done).toBe(false); // Tabazing stays
  });

  it('the big preview: the zoom button or Space; ← → step through the history, Esc goes back to it', async () => {
    seedHistory(3);
    await chrome.storage.local.set({ 'pv:https://p1.example/': { img: PV, t: NOW } });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('quick-big', cards()[0]).click();
    expect(tid('big-preview-image').src).toBe(PV);
    key('ArrowRight');
    expect(tid('big-preview-title').textContent).toBe('Page 2');
    expect(tid('big-preview-none')).not.toBe(null); // no preview: its icon
    expect(cards()[1].getAttribute('aria-selected')).toBe('true');
    key('Escape');
    expect(tid('big-preview')).toBe(null);
    expect(sw.historyOpen()).toBe(true);
    expect(document.activeElement).toBe(tid('history-close'));
    key(' ');
    expect(tid('big-preview-title').textContent).toBe('Page 2');
    key('Enter'); // opens that page
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p2.example/' }));
  });

  it('the keys: arrows move, Del removes, Shift+F10 opens the menu, Enter opens, Esc closes (back to the button)', async () => {
    seedHistory(4);
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(cards()[0].getAttribute('aria-selected')).toBe('true');
    key('ArrowRight');
    expect(cards()[1].getAttribute('aria-selected')).toBe('true');
    expect(tid('history-grid').getAttribute('aria-activedescendant')).toBe(cards()[1].id);
    key('Delete');
    await waitFor(() => cards().length === 3);
    expect(chrome.history.deleteUrl).toHaveBeenCalledWith({ url: 'https://p2.example/' });
    expect(cards()[1].getAttribute('aria-selected')).toBe('true'); // the next one
    key('F10', { shiftKey: true });
    expect(tid('menu')).not.toBe(null);
    key('Escape'); // the menu's
    await tick();
    expect(tid('menu')).toBe(null);
    expect(sw.historyOpen()).toBe(true);
    key('Escape');
    expect(sw.historyOpen()).toBe(false);
    expect(document.activeElement).toBe(tid('history-btn'));
  });

  it('"Show 50 more" works from the keyboard too: Enter on it, or ↓ past the last row', async () => {
    seedHistory(130);
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('history-more').focus();
    const e = key('Enter');
    expect(e.defaultPrevented).toBe(false); // the button's own Enter (it clicks)
    tid('history-more').click();
    await waitFor(() => cards().length === 100);
    cards().forEach((c, k) => { c.getBoundingClientRect = () => ({ top: k * 100, bottom: k * 100 + 90, left: 0, width: 300, height: 90 }); }); // one per row (jsdom lays nothing out)
    sw.histSelect(99, false);
    key('ArrowDown'); // no row below the last: the next 50
    await waitFor(() => cards().length === 130);
  });

  it('its search box finds pages by title, site, address or the page note, typos forgiven; Esc empties it', async () => {
    seedHistory(60);
    chrome._data.history.push({ url: 'https://news.example/today', title: 'Morning news', lastVisitTime: NOW - 999999, visitCount: 1 });
    await chrome.storage.local.set({ notes: { 'https://p55.example/': { u: 'https://p55.example/', n: 'invoice for march', t: NOW } } });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    const search = async (text) => { tid('history-search').value = text; await sw.findHistory(text); };
    await search('mornin nwes'); // typos
    expect(titles()).toEqual(['Morning news']);
    await search('news.example');
    expect(titles()).toEqual(['Morning news']);
    await search('invoice');
    expect(titles()).toEqual(['Page 55']);
    expect(tid('history-more').hidden).toBe(true);
    await search('qqqzzz');
    expect(tid('history-empty').hidden).toBe(false);
    expect(tid('history-empty').textContent).toBe(t('historyNoMatch'));
    tid('history-search').focus();
    key('Escape');
    await waitFor(() => cards().length === 50);
    expect(tid('history-search').value).toBe('');
    expect(sw.historyOpen()).toBe(true);
  });

  it('while it is open the rest of the switcher is inert', async () => {
    seedHistory(1);
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    for (const id of ['header', 'body']) expect(tid(id).hasAttribute('inert'), id).toBe(true);
    expect(tid('history-overlay').hasAttribute('inert')).toBe(false);
    sw.closeHistory();
    expect(tid('header').hasAttribute('inert')).toBe(false);
  });
});

describe('a recently closed card\'s delete button', () => {
  it('stands where its star was, and takes the entry off the list (Undo puts it back)', async () => {
    const sw = await boot({ tabs: AB, beforeImport: () => { chrome._data.closed = [{ lastModified: Math.floor(NOW / 1000) - 60, tab: { sessionId: 'c1', url: 'https://gone.example/', title: 'Gone' } }]; } });
    const card = cardOf('Gone', 'closed');
    expect(tid('card-star-button', card)).toBe(null);
    const del = tid('card-closed-remove', card);
    expect(del.getAttribute('aria-label')).toBe(t('closedRemove'));
    del.click();
    await waitFor(() => !cardOf('Gone', 'closed'));
    expect(toastText()).toBe(t('closedRemoved'));
    expect(sw.state.entries.some((e) => e.kind === 'closed')).toBe(false);
  });
});
