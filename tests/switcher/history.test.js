// The browsing history (the clock button right of New tab, Ctrl+H): Chrome's history over the switcher, newest first
// and by day, 50 at a time ("Show 50 more"); rows (or cards) with previews or the page's icon; the search box (typos
// forgiven, notes too), the range, ticks and the bar, remove with Undo, the ⋯ menu, the keys. And a recently closed
// card's delete button (where its star was).
import { describe, it, expect } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, toastText, toastButton } from './quiet-boot.js';
import { t } from '../../utils/translations.js';

const AB = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const PV = 'data:image/jpeg;base64,HHHH';
const NOW = Date.now();
// `n` visited pages, page 1 the newest (a minute apart); and a chrome:// page Tabazing can't open (left out).
function seedHistory(n, step = 60000) {
  for (let i = 1; i <= n; i++) chrome._data.history.push({ url: `https://p${i}.example/`, title: 'Page ' + i, lastVisitTime: NOW - i * step, visitCount: i });
  chrome._data.history.push({ url: 'chrome://settings/', title: 'Settings', lastVisitTime: NOW, visitCount: 1 });
}
const cards = () => tids('card-history');
const titles = () => cards().map((c) => tid('card-title', c).textContent);
const sel = () => tid('card-title', cards().find((c) => c.getAttribute('aria-selected') === 'true')).textContent;
const menuLabels = () => tids('menu-item').map((b) => b.textContent);
const menuItem = (label) => tids('menu-item').find((b) => b.textContent === label);
async function openHistory(sw) {
  tid('history-btn').click();
  await waitFor(() => sw.historyOpen() && (cards().length > 0 || tid('history-empty')?.hidden === false));
  return tid('history-overlay');
}
const search = async (sw, text) => { tid('history-search').value = text; await sw.findHistory(text); };

describe('the history button', () => {
  it('is in the menu (☰), first, with its icon, its name and its key', async () => {
    await boot({ tabs: AB });
    const b = tid('history-btn');
    expect(tid('drawer').contains(b)).toBe(true);
    expect(tid('header').contains(b)).toBe(false);
    expect(tid('history-btn-label').textContent).toBe(t('historyTitle'));
    expect(tid('history-btn-key').textContent).toBe('Ctrl+H');
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('Ctrl+H opens it and closes it again; the palette has it too', async () => {
    seedHistory(2);
    const sw = await boot({ tabs: AB });
    key('h', { code: 'KeyH', ctrlKey: true });
    await waitFor(() => sw.historyOpen());
    key('h', { code: 'KeyH', ctrlKey: true, target: tid('history-search') });
    expect(sw.historyOpen()).toBe(false);
    expect(sw.PAL_ACTIONS.some((a) => a.id === 'open-history')).toBe(true);
  });
});

describe('the history view', () => {
  it('the newest 50 pages, by day, in rows; "50 shown" while there are more; 50 more at a time', async () => {
    seedHistory(120, 30 * 60000); // half an hour apart: today and the days before
    const sw = await boot({ tabs: AB });
    const o = await openHistory(sw);
    expect(tid('history-panel', o).getAttribute('role')).toBe('dialog');
    expect(tid('history-panel', o).getAttribute('aria-modal')).toBe('true');
    expect(cards()).toHaveLength(50);
    expect(cards()[0].classList.contains('bmvrow')).toBe(true); // a list by default
    expect(titles().slice(0, 3)).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(titles()).not.toContain('Settings');
    expect(tids('history-day')[0].textContent).toBe(sw.dayLabel(NOW - 30 * 60000));
    expect(tids('history-day').length).toBeGreaterThan(1);
    expect(tid('history-count').textContent).toBe(t('historyShown', { count: 50 }));
    tid('history-more').click();
    await waitFor(() => cards().length === 100);
    expect(titles()[50]).toBe('Page 51');
    tid('history-more').click();
    await waitFor(() => cards().length === 120);
    await waitFor(() => tid('history-more').hidden);
    expect(tid('history-count').textContent).toBe('120'); // all of it: the number
    expect(new Set(titles()).size).toBe(120);
    expect(new Set(tids('history-day').map((d) => d.textContent)).size).toBe(tids('history-day').length); // each day once
  });

  it('the focus starts in the search box; a page with a preview shows it, one without its icon', async () => {
    seedHistory(2);
    await chrome.storage.local.set({ 'pv:https://p1.example/': { img: PV, t: NOW } });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(document.activeElement).toBe(tid('history-search'));
    expect(tid('card-preview', cards()[0]).src).toBe(PV);
    const none = tid('card-no-preview', cards()[1]);
    expect(none.classList.contains('bare')).toBe(true);
    expect(tid('card-tile-favicon', none)).not.toBe(null);
    expect(cards()[1].title).toContain(t('historyVisits', { count: 2 })); // how often, and when (its tooltip)
  });

  it('cards instead of rows (remembered), the same pages', async () => {
    seedHistory(3);
    let sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('history-layout').click();
    expect(cards()[0].classList.contains('card')).toBe(true);
    expect(titles()).toEqual(['Page 1', 'Page 2', 'Page 3']);
    await tick(20);
    sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(cards()[0].classList.contains('card')).toBe(true);
  });

  it('nothing in the history: says so, no "Show more"', async () => {
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(tid('history-empty').hidden).toBe(false);
    expect(tid('history-empty').textContent).toBe(t('historyEmpty'));
    expect(tid('history-more').hidden).toBe(true);
  });

  it('a click opens the page (its tab when one is open); a middle-click opens it behind, Tabazing staying', async () => {
    seedHistory(2);
    chrome._data.history.push({ url: 'https://a.example/', title: 'A visit', lastVisitTime: NOW, visitCount: 3 });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    cards()[1].dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    await waitFor(() => chrome.tabs.create.mock.calls.length > 0);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p1.example/', active: false }));
    expect(sw.state.done).toBe(false);
    cards()[0].click();
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(sw.state.tabs.find((x) => x.title === 'A').id, { active: true });
  });
});

describe('the search box and the range', () => {
  it('finds pages by title, site, address or the page note, typos forgiven, the words marked; Esc empties it, then closes', async () => {
    seedHistory(60);
    chrome._data.history.push({ url: 'https://news.example/today', title: 'Morning news', lastVisitTime: NOW - 999999, visitCount: 1 });
    await chrome.storage.local.set({ notes: { 'https://p55.example/': { u: 'https://p55.example/', n: 'invoice for march', t: NOW } } });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    await search(sw, 'mornin nwes');
    expect(titles()).toEqual(['Morning news']);
    expect(tids('search-highlight', cards()[0]).length).toBeGreaterThan(0);
    await search(sw, 'news.example');
    expect(titles()).toEqual(['Morning news']);
    await search(sw, 'invoice');
    expect(titles()).toEqual(['Page 55']);
    expect(tid('card-history-note', cards()[0]).textContent).toBe('invoice for march');
    await search(sw, 'qqqzzz');
    expect(tid('history-empty').textContent).toBe(t('historyNoMatch'));
    tid('history-close').focus(); // wherever the focus is, Esc empties the box first
    key('Escape');
    await waitFor(() => cards().length === 50);
    expect(tid('history-search').value).toBe('');
    expect(sw.historyOpen()).toBe(true);
    key('Escape');
    expect(sw.historyOpen()).toBe(false);
    expect(document.activeElement).toBe(tid('menu-btn'));
  });

  it('the last search comes back next time, selected (typing replaces it)', async () => {
    seedHistory(5);
    let sw = await boot({ tabs: AB });
    await openHistory(sw);
    await search(sw, 'Page 3');
    await tick(20);
    sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(tid('history-search').value).toBe('Page 3');
    expect(titles()).toContain('Page 3');
  });

  it('the range keeps to a time: today, the last 7 or 30 days', async () => {
    chrome._data.history.push({ url: 'https://now.example/', title: 'Now', lastVisitTime: NOW - 60000, visitCount: 1 });
    chrome._data.history.push({ url: 'https://old.example/', title: 'Old', lastVisitTime: NOW - 20 * 864e5, visitCount: 1 });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(titles()).toEqual(['Now', 'Old']);
    const range = tid('history-range');
    range.value = 'week';
    range.dispatchEvent(new Event('change'));
    await waitFor(() => titles().length === 1);
    expect(titles()).toEqual(['Now']);
    range.value = 'month';
    range.dispatchEvent(new Event('change'));
    await waitFor(() => titles().length === 2);
  });

  it('says when a search could only look through the newest 5000 visits', async () => {
    for (let i = 0; i < 5000; i++) chrome._data.history.push({ url: `https://many${i}.example/`, title: 'Many ' + i, lastVisitTime: NOW - i * 1000, visitCount: 1 });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(tid('history-pool-note').hidden).toBe(true);
    await search(sw, 'many 4999');
    expect(tid('history-pool-note').hidden).toBe(false);
  });
});

describe('removing and ticking', () => {
  it('a page’s trash removes it from Chrome’s history and the list; Undo puts it back', async () => {
    seedHistory(3);
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('card-history-remove', cards()[1]).click();
    await waitFor(() => cards().length === 2);
    expect(chrome.history.deleteUrl).toHaveBeenCalledWith({ url: 'https://p2.example/' });
    expect(titles()).toEqual(['Page 1', 'Page 3']);
    expect(toastText()).toBe(t('historyRemovedN', { count: 1 }));
    toastButton().click();
    await waitFor(() => cards().length === 3);
    expect(chrome.history.addUrl).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p2.example/', title: 'Page 2' }));
  });

  it('tick boxes, Shift+click for a range, Ctrl+A for all; the bar opens and removes them; Esc unticks', async () => {
    seedHistory(5);
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('hist-pick', cards()[0]).click();
    tid('hist-pick', cards()[2]).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(cards().map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'false', 'false']);
    expect(tid('history-selection').hidden).toBe(false);
    expect(tid('history-selected').textContent).toBe(t('bmvSelected', { count: 3 }));
    tid('history-open-selected').click();
    await waitFor(() => chrome.tabs.create.mock.calls.length === 3);
    expect(chrome.tabs.create.mock.calls.every(([p]) => p.active === false)).toBe(true);
    tid('history-close').focus();
    key('a', { code: 'KeyA', ctrlKey: true });
    expect(tid('history-selected').textContent).toBe(t('bmvSelected', { count: 5 }));
    key('Escape');
    expect(tid('history-selection').hidden).toBe(true);
    expect(sw.historyOpen()).toBe(true);
    tid('hist-pick', cards()[3]).click();
    tid('hist-pick', cards()[4]).click();
    tid('history-remove-selected').click();
    await waitFor(() => cards().length === 3);
    expect(toastText()).toBe(t('historyRemovedN', { count: 2 }));
  });

  it('"Remove all from this site" asks first, with how many', async () => {
    chrome._data.history.push({ url: 'https://shop.example/a', title: 'Shop A', lastVisitTime: NOW - 1000, visitCount: 1 });
    chrome._data.history.push({ url: 'https://shop.example/b', title: 'Shop B', lastVisitTime: NOW - 2000, visitCount: 1 });
    chrome._data.history.push({ url: 'https://other.example/', title: 'Other', lastVisitTime: NOW - 3000, visitCount: 1 });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('quick-more', cards()[0]).click();
    menuItem(t('historyForgetSite')).click();
    await waitFor(() => tid('history-forget-site'));
    expect(tid('dialog-text', tid('history-forget-site')).textContent).toBe(t('historyForgetSiteText', { count: 2 }));
    tid('history-forget-site-ok').click();
    await waitFor(() => titles().length === 1);
    expect(titles()).toEqual(['Other']);
  });
});

describe('the menu and the keys', () => {
  it('its ⋯ lists what can be done with a page; More from this site searches its site', async () => {
    seedHistory(2);
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('quick-more', cards()[0]).click();
    expect(menuLabels()).toEqual([
      t('historyOpen'), t('historyNewWindow'), t('historyBehind'), t('historyBig'), t('copyLink'), t('star'), t('noteAdd'),
      t('markMenu'), t('historySnooze'), t('tabArchive'), t('bmvSelect'), t('historyMoreFrom'), t('historyRemove'), t('historyForgetSite'),
    ]);
    menuItem(t('historyMoreFrom')).click();
    await waitFor(() => tid('history-search').value === 'p1.example');
    await waitFor(() => titles().length === 1);
  });

  it('the big preview: Space or its button; ← → step through; a page without a picture says what is known; Esc back to the box', async () => {
    seedHistory(3);
    await chrome.storage.local.set({ 'pv:https://p1.example/': { img: PV, t: NOW } });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('quick-big', cards()[0]).click();
    expect(tid('big-preview-image').src).toBe(PV);
    key('ArrowRight');
    expect(tid('big-preview-title').textContent).toBe('Page 2');
    expect(tids('big-preview-info-line').map((x) => x.textContent)).toContain(t('historyVisits', { count: 2 }));
    expect(sel()).toBe('Page 2');
    key('Escape');
    expect(tid('big-preview')).toBe(null);
    expect(document.activeElement).toBe(tid('history-search'));
    tid('history-close').focus();
    key(' ');
    expect(tid('big-preview-title').textContent).toBe('Page 2');
    key('Enter');
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p2.example/' }));
  });

  it('↑ ↓ from the box, End / Home / PgUp, Ctrl+Space ticks, Del removes, Ctrl+Enter opens behind, Shift+F10 the menu', async () => {
    seedHistory(14);
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(sel()).toBe('Page 1');
    key('ArrowDown');
    expect(sel()).toBe('Page 2');
    expect(tid('history-search').getAttribute('aria-activedescendant')).toBe(cards()[1].id);
    key('End');
    expect(sel()).toBe('Page 14');
    key('PageUp');
    expect(sel()).toBe('Page 4');
    key('Home');
    expect(sel()).toBe('Page 1');
    key(' ', { ctrlKey: true });
    expect(cards()[0].getAttribute('aria-checked')).toBe('true');
    key(' ', { ctrlKey: true });
    key('ArrowDown');
    tid('history-close').focus();
    key('Delete');
    await waitFor(() => cards().length === 13);
    expect(chrome.history.deleteUrl).toHaveBeenCalledWith({ url: 'https://p2.example/' });
    expect(sel()).toBe('Page 3');
    key('F10', { shiftKey: true });
    expect(tid('menu')).not.toBe(null);
    key('Escape');
    await tick();
    expect(sw.historyOpen()).toBe(true);
    key('Enter', { ctrlKey: true });
    await waitFor(() => chrome.tabs.create.mock.calls.length === 1);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p3.example/', active: false }));
    expect(sw.state.done).toBe(false);
  });

  it('"Show 50 more" from the keyboard too: Enter on it, or ↓ past the last page', async () => {
    seedHistory(130);
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    tid('history-more').focus();
    expect(key('Enter').defaultPrevented).toBe(false); // the button's own Enter (it clicks)
    tid('history-more').click();
    await waitFor(() => cards().length === 100);
    sw.histSelect(99, false);
    tid('history-search').focus();
    key('ArrowDown');
    await waitFor(() => cards().length === 130);
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

describe('a recently closed card’s delete button', () => {
  it('stands where its star was, and takes the entry off the list', async () => {
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

describe('a page\u2019s "last opened" tag and loading more by itself', () => {
  it('says how long ago ("5m ago", "1 year ago"); hovering it shows the full date', async () => {
    chrome._data.history.push({ url: 'https://new.example/', title: 'New', lastVisitTime: NOW - 5 * 60000, visitCount: 1 });
    chrome._data.history.push({ url: 'https://old.example/', title: 'Old', lastVisitTime: NOW - 400 * 864e5, visitCount: 1 });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    const tags = cards().map((c) => tid('card-history-ago', c));
    expect(tags.map((x) => x.textContent)).toEqual([t('agoMin', { n: 5 }), t('agoYear', { count: 1 })]);
    expect(t('agoMin', { n: 5 })).toBe('5m ago');
    expect(t('agoYear', { count: 1 })).toBe('1 year ago');
    tags[1].dispatchEvent(new MouseEvent('mouseenter'));
    await waitFor(() => tid('history-date-tooltip'));
    expect(tid('history-date-tooltip-title').textContent).toBe(t('historyLastOpened'));
    expect(tid('history-date-tooltip-text').textContent).toBe(new Date(NOW - 400 * 864e5).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }));
    expect(tags[1].title).toBe(''); // its own tooltip, not the row's
  });

  it('the date tooltip opens only after 500 ms on the tag; leaving sooner, it never opens', async () => {
    chrome._data.history.push({ url: 'https://new.example/', title: 'New', lastVisitTime: NOW - 5 * 60000, visitCount: 1 });
    const sw = await boot({ tabs: AB });
    await openHistory(sw);
    expect(sw.DATE_TIP_DELAY_MS).toBe(500);
    const tag = tid('card-history-ago', cards()[0]);
    tag.dispatchEvent(new MouseEvent('mouseenter'));
    await tick(300);
    tag.dispatchEvent(new MouseEvent('mouseleave'));
    await tick(400);
    expect(tid('history-date-tooltip')).toBe(null);
    const from = Date.now();
    tag.dispatchEvent(new MouseEvent('mouseenter'));
    await tick(350);
    expect(tid('history-date-tooltip')).toBe(null);
    await waitFor(() => tid('history-date-tooltip'));
    expect(Date.now() - from).toBeGreaterThanOrEqual(480);
  });

  it('agoShort: minutes, hours, days, weeks, months, years', async () => {
    const sw = await boot({ tabs: AB });
    const ago = (ms) => sw.agoShort(Date.now() - ms);
    expect([ago(10e3), ago(3 * 3600e3), ago(2 * 864e5), ago(15 * 864e5), ago(90 * 864e5), ago(800 * 864e5)])
      .toEqual([t('justNow'), '3h ago', '2d ago', '2w ago', '3 months ago', '2 years ago']);
  });

  it('reaching the bottom of the list loads the next 50 by itself', async () => {
    seedHistory(120);
    const seen = [];
    const IO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = window.IntersectionObserver = class { constructor(cb) { this.cb = cb; seen.push(this); } observe(n) { this.n = n; } unobserve() {} disconnect() {} takeRecords() { return []; } };
    try {
      const sw = await boot({ tabs: AB });
      await openHistory(sw);
      const io = seen.find((x) => x.n === tid('history-more'));
      expect(io).toBeTruthy();
      io.cb([{ isIntersecting: true, target: tid('history-more') }]);
      await waitFor(() => cards().length === 100);
      io.cb([{ isIntersecting: true, target: tid('history-more') }]);
      await waitFor(() => cards().length === 120);
    } finally { globalThis.IntersectionObserver = window.IntersectionObserver = IO; }
  });
});
