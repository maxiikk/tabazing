// The browsing history (the clock button right of New tab, Ctrl+H): Chrome's history over the switcher, newest first
// and by day, 50 at a time ("Show 50 more"); rows (or cards) with previews or the page's icon; the search box (typos
// forgiven, notes too), the range, ticks and the bar, remove with Undo, the ⋯ menu, the keys. And a recently closed
// card's delete button (where its star was).
import { describe, it, expect } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, cardOf, tabByTitle, toastText, toastButton } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';

const defaultTabs = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const PREVIEW = 'data:image/jpeg;base64,HHHH';
const NOW = Date.now();
// `n` visited pages, page 1 the newest (a minute apart); and a chrome:// page Tabazing can't open (left out).
function seedHistory(count, step = 60000) {
  for (let i = 1; i <= count; i++) chrome._data.history.push({ url: `https://p${i}.example/`, title: 'Page ' + i, lastVisitTime: NOW - i * step, visitCount: i });
  chrome._data.history.push({ url: 'chrome://settings/', title: 'Settings', lastVisitTime: NOW, visitCount: 1 });
}
const cards = () => allByTestId('card-history');
const titles = () => cards().map((card) => byTestId('card-title', card).textContent);
const selectedTitle = () => byTestId('card-title', cards().find((card) => card.getAttribute('aria-selected') === 'true')).textContent;
const menuLabels = () => allByTestId('menu-item').map((button) => button.textContent);
const menuItem = (label) => allByTestId('menu-item').find((button) => button.textContent === label);
async function openHistory(switcher) {
  byTestId('history-button').click();
  await waitFor(() => switcher.historyOpen() && (cards().length > 0 || byTestId('history-empty')?.hidden === false));
  return byTestId('history-overlay');
}
const search = async (switcher, text) => { byTestId('history-search').value = text; await switcher.findHistory(text); };

describe('the history button', () => {
  it('is in the menu (☰), first, with its icon, its name and its key', async () => {
    await boot({ tabs: defaultTabs });
    const button = byTestId('history-button');
    expect(byTestId('drawer').contains(button)).toBe(true);
    expect(byTestId('header').contains(button)).toBe(false);
    expect(byTestId('history-button-label').textContent).toBe(translate('historyTitle'));
    expect(byTestId('history-button-key').textContent).toBe('Ctrl+H');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('Ctrl+H opens it and closes it again; the palette has it too', async () => {
    seedHistory(2);
    const switcher = await boot({ tabs: defaultTabs });
    key('h', { code: 'KeyH', ctrlKey: true });
    await waitFor(() => switcher.historyOpen());
    key('h', { code: 'KeyH', ctrlKey: true, target: byTestId('history-search') });
    expect(switcher.historyOpen()).toBe(false);
    expect(switcher.PALETTE_ACTIONS.some((action) => action.id === 'open-history')).toBe(true);
  });
});

describe('the history view', () => {
  it('the newest 50 pages, by day, in rows; "50 shown" while there are more; 50 more at a time', async () => {
    seedHistory(120, 30 * 60000); // half an hour apart: today and the days before
    const switcher = await boot({ tabs: defaultTabs });
    const overlay = await openHistory(switcher);
    expect(byTestId('history-panel', overlay).getAttribute('role')).toBe('dialog');
    expect(byTestId('history-panel', overlay).getAttribute('aria-modal')).toBe('true');
    expect(cards()).toHaveLength(50);
    expect(cards()[0].classList.contains('bookmarks-view-row')).toBe(true); // a list by default
    expect(titles().slice(0, 3)).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(titles()).not.toContain('Settings');
    expect(allByTestId('history-day')[0].textContent).toBe(switcher.dayLabel(NOW - 30 * 60000));
    expect(allByTestId('history-day').length).toBeGreaterThan(1);
    expect(byTestId('history-count').textContent).toBe(translate('historyShown', { count: 50 }));
    byTestId('history-more').click();
    await waitFor(() => cards().length === 100);
    expect(titles()[50]).toBe('Page 51');
    byTestId('history-more').click();
    await waitFor(() => cards().length === 120);
    await waitFor(() => byTestId('history-more').hidden);
    expect(byTestId('history-count').textContent).toBe('120'); // all of it: the number
    expect(new Set(titles()).size).toBe(120);
    expect(new Set(allByTestId('history-day').map((dayElement) => dayElement.textContent)).size).toBe(allByTestId('history-day').length); // each day once
  });

  it('the focus starts in the search box; a page with a preview shows it, one without its icon', async () => {
    seedHistory(2);
    await chrome.storage.local.set({ 'pv:https://p1.example/': { img: PREVIEW, t: NOW } });
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    expect(document.activeElement).toBe(byTestId('history-search'));
    expect(byTestId('card-preview', cards()[0]).src).toBe(PREVIEW);
    const none = byTestId('card-no-preview', cards()[1]);
    expect(none.classList.contains('bare')).toBe(true);
    expect(byTestId('card-tile-favicon', none)).not.toBe(null);
    expect(cards()[1].title).toContain(translate('historyVisits', { count: 2 })); // how often, and when (its tooltip)
  });

  it('cards instead of rows (remembered), the same pages', async () => {
    seedHistory(3);
    let switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    byTestId('history-layout').click();
    expect(cards()[0].classList.contains('card')).toBe(true);
    expect(titles()).toEqual(['Page 1', 'Page 2', 'Page 3']);
    await tick(20);
    switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    expect(cards()[0].classList.contains('card')).toBe(true);
  });

  it('nothing in the history: says so, no "Show more"', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    expect(byTestId('history-empty').hidden).toBe(false);
    expect(byTestId('history-empty').textContent).toBe(translate('historyEmpty'));
    expect(byTestId('history-more').hidden).toBe(true);
  });

  it('a click opens the page (its tab when one is open); a middle-click opens it behind, Tabazing staying', async () => {
    seedHistory(2);
    chrome._data.history.push({ url: 'https://a.example/', title: 'A visit', lastVisitTime: NOW, visitCount: 3 });
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    cards()[1].dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    await waitFor(() => chrome.tabs.create.mock.calls.length > 0);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p1.example/', active: false }));
    expect(switcher.state.done).toBe(false);
    cards()[0].click();
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(switcher.state.tabs.find((x) => x.title === 'A').id, { active: true });
  });
});

describe('the search box and the range', () => {
  it('finds pages by title, site, address or the page note, typos forgiven, the words marked; Esc empties it, then closes', async () => {
    seedHistory(60);
    chrome._data.history.push({ url: 'https://news.example/today', title: 'Morning news', lastVisitTime: NOW - 999999, visitCount: 1 });
    await chrome.storage.local.set({ notes: { 'https://p55.example/': { u: 'https://p55.example/', n: 'invoice for march', t: NOW } } });
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    await search(switcher, 'mornin nwes');
    expect(titles()).toEqual(['Morning news']);
    expect(allByTestId('search-highlight', cards()[0]).length).toBeGreaterThan(0);
    await search(switcher, 'news.example');
    expect(titles()).toEqual(['Morning news']);
    await search(switcher, 'invoice');
    expect(titles()).toEqual(['Page 55']);
    expect(byTestId('card-history-note', cards()[0]).textContent).toBe('invoice for march');
    await search(switcher, 'qqqzzz');
    expect(byTestId('history-empty').textContent).toBe(translate('historyNoMatch'));
    byTestId('history-close').focus(); // wherever the focus is, Esc empties the box first
    key('Escape');
    await waitFor(() => cards().length === 50);
    expect(byTestId('history-search').value).toBe('');
    expect(switcher.historyOpen()).toBe(true);
    key('Escape');
    expect(switcher.historyOpen()).toBe(false);
    expect(document.activeElement).toBe(byTestId('menu-button'));
  });

  it('the search box starts empty each time: closing empties it, and nothing of it comes back next time', async () => {
    seedHistory(5);
    let switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    await search(switcher, 'Page 3');
    await tick(20);
    expect(titles()).toEqual(['Page 3']);
    const box = byTestId('history-search');
    key('Escape', { target: box }); // (empties the box first)
    key('Escape', { target: box });
    expect(switcher.historyOpen()).toBe(false);
    expect(box.value).toBe('');
    await openHistory(switcher);
    expect(byTestId('history-search').value).toBe('');
    expect(titles()).toHaveLength(5);
    // closed while a search still waits (typed, no pause): it doesn't come back either
    byTestId('history-search').value = 'Page 2';
    byTestId('history-search').dispatchEvent(new Event('input', { bubbles: true }));
    switcher.closeHistory();
    await tick(300);
    switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    expect(byTestId('history-search').value).toBe('');
    expect(titles()).toHaveLength(5);
    expect((await chrome.storage.local.get('view')).view?.historyQuery).toBe(undefined);
  });

  it('the range keeps to a time: today, the last 7 or 30 days', async () => {
    chrome._data.history.push({ url: 'https://now.example/', title: 'Now', lastVisitTime: NOW - 60000, visitCount: 1 });
    chrome._data.history.push({ url: 'https://old.example/', title: 'Old', lastVisitTime: NOW - 20 * 864e5, visitCount: 1 });
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    expect(titles()).toEqual(['Now', 'Old']);
    const range = byTestId('history-range');
    range.value = 'week';
    range.dispatchEvent(new Event('change'));
    await waitFor(() => titles().length === 1);
    expect(titles()).toEqual(['Now']);
    range.value = 'month';
    range.dispatchEvent(new Event('change'));
    await waitFor(() => titles().length === 2);
  });

  it('Enter right after typing (before the search\'s pause) opens what the typed text finds', async () => {
    seedHistory(10);
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    expect(selectedTitle()).toBe('Page 1');
    const box = byTestId('history-search');
    box.value = 'Page 7';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    key('Enter', { target: box }); // no pause: the search hasn't run yet
    await tick(300);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p7.example/' }));
    expect(switcher.state.done).toBe(true);
  });

  it('says when a search could only look through the newest 5000 visits', async () => {
    for (let i = 0; i < 5000; i++) chrome._data.history.push({ url: `https://many${i}.example/`, title: 'Many ' + i, lastVisitTime: NOW - i * 1000, visitCount: 1 });
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    expect(byTestId('history-pool-note').hidden).toBe(true);
    await search(switcher, 'many 4999');
    expect(byTestId('history-pool-note').hidden).toBe(false);
  });
});

describe('removing and ticking', () => {
  it('a page’s trash removes it from Chrome’s history and the list; Undo puts it back', async () => {
    seedHistory(3);
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    byTestId('card-history-remove', cards()[1]).click();
    await waitFor(() => cards().length === 2);
    expect(chrome.history.deleteUrl).toHaveBeenCalledWith({ url: 'https://p2.example/' });
    expect(titles()).toEqual(['Page 1', 'Page 3']);
    expect(toastText()).toBe(translate('historyRemovedCount', { count: 1 }));
    toastButton().click();
    await waitFor(() => cards().length === 3);
    expect(chrome.history.addUrl).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p2.example/', title: 'Page 2' }));
  });

  it('tick boxes, Shift+click for a range, Ctrl+A for all; the bar opens and removes them; Esc unticks', async () => {
    seedHistory(5);
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    byTestId('history-pick', cards()[0]).click();
    byTestId('history-pick', cards()[2]).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(cards().map((card) => card.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true', 'false', 'false']);
    expect(byTestId('history-selection').hidden).toBe(false);
    expect(byTestId('history-selected').textContent).toBe(translate('bookmarksViewSelected', { count: 3 }));
    byTestId('history-open-selected').click();
    await waitFor(() => chrome.tabs.create.mock.calls.length === 3);
    expect(chrome.tabs.create.mock.calls.every(([properties]) => properties.active === false)).toBe(true);
    byTestId('history-close').focus();
    key('a', { code: 'KeyA', ctrlKey: true });
    expect(byTestId('history-selected').textContent).toBe(translate('bookmarksViewSelected', { count: 5 }));
    key('Escape');
    expect(byTestId('history-selection').hidden).toBe(true);
    expect(switcher.historyOpen()).toBe(true);
    byTestId('history-pick', cards()[3]).click();
    byTestId('history-pick', cards()[4]).click();
    byTestId('history-remove-selected').click();
    await waitFor(() => cards().length === 3);
    expect(toastText()).toBe(translate('historyRemovedCount', { count: 2 }));
  });

  it('a Shift+click range starts again after a search replaced the list', async () => {
    seedHistory(20);
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    byTestId('history-pick', cards()[2]).click(); // ticked, then unticked: the range's start is set
    byTestId('history-pick', cards()[2]).click();
    expect(switcher.state.historyView.picked.size).toBe(0);
    byTestId('history-search').value = 'Page 1';
    await switcher.findHistory('Page 1');
    expect(titles()).toContain('Page 1');
    expect(cards().length).toBeGreaterThan(3);
    byTestId('history-pick', cards().at(-1)).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(switcher.state.historyView.picked.size).toBe(1);
    expect(cards().map((card) => card.getAttribute('aria-checked')).filter((x) => x === 'true')).toHaveLength(1);
    expect(cards().at(-1).getAttribute('aria-checked')).toBe('true');
  });

  it('"Remove all from this site" asks first, with how many', async () => {
    chrome._data.history.push({ url: 'https://shop.example/a', title: 'Shop A', lastVisitTime: NOW - 1000, visitCount: 1 });
    chrome._data.history.push({ url: 'https://shop.example/b', title: 'Shop B', lastVisitTime: NOW - 2000, visitCount: 1 });
    chrome._data.history.push({ url: 'https://other.example/', title: 'Other', lastVisitTime: NOW - 3000, visitCount: 1 });
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    byTestId('quick-more', cards()[0]).click();
    menuItem(translate('historyForgetSite')).click();
    await waitFor(() => byTestId('history-forget-site'));
    expect(byTestId('dialog-text', byTestId('history-forget-site')).textContent).toBe(translate('historyForgetSiteText', { count: 2 }));
    byTestId('history-forget-site-ok').click();
    await waitFor(() => titles().length === 1);
    expect(titles()).toEqual(['Other']);
  });
});

describe('the menu and the keys', () => {
  it('its ⋯ lists what can be done with a page; More from this site searches its site', async () => {
    seedHistory(2);
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    byTestId('quick-more', cards()[0]).click();
    expect(menuLabels()).toEqual([
      translate('historyOpen'), translate('historyNewWindow'), translate('historyBehind'), translate('historyBig'), translate('copyLink'), translate('star'), translate('noteAdd'),
      translate('markMenu'), translate('historySnooze'), translate('tabArchive'), translate('bookmarksViewSelect'), translate('historyMoreFrom'), translate('historyRemove'), translate('historyForgetSite'),
    ]);
    menuItem(translate('historyMoreFrom')).click();
    await waitFor(() => byTestId('history-search').value === 'p1.example');
    await waitFor(() => titles().length === 1);
  });

  it('the big preview: Space or its button; ← → step through; a page without a picture says what is known; Esc back to the box', async () => {
    seedHistory(3);
    await chrome.storage.local.set({ 'pv:https://p1.example/': { img: PREVIEW, t: NOW } });
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    byTestId('quick-big', cards()[0]).click();
    expect(byTestId('big-preview-image').src).toBe(PREVIEW);
    key('ArrowRight');
    expect(byTestId('big-preview-title').textContent).toBe('Page 2');
    expect(allByTestId('big-preview-information-line').map((x) => x.textContent)).toContain(translate('historyVisits', { count: 2 }));
    expect(selectedTitle()).toBe('Page 2');
    key('Escape');
    expect(byTestId('big-preview')).toBe(null);
    expect(document.activeElement).toBe(byTestId('history-search'));
    byTestId('history-close').focus();
    key(' ');
    expect(byTestId('big-preview-title').textContent).toBe('Page 2');
    key('Enter');
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p2.example/' }));
  });

  it('↑ ↓ from the box, End / Home / PgUp, Ctrl+Space ticks, Del removes, Ctrl+Enter opens behind, Shift+F10 the menu', async () => {
    seedHistory(14);
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    expect(selectedTitle()).toBe('Page 1');
    key('ArrowDown');
    expect(selectedTitle()).toBe('Page 2');
    expect(byTestId('history-search').getAttribute('aria-activedescendant')).toBe(cards()[1].id);
    key('End');
    expect(selectedTitle()).toBe('Page 14');
    key('PageUp');
    expect(selectedTitle()).toBe('Page 4');
    key('Home');
    expect(selectedTitle()).toBe('Page 1');
    key(' ', { ctrlKey: true });
    expect(cards()[0].getAttribute('aria-checked')).toBe('true');
    key(' ', { ctrlKey: true });
    key('ArrowDown');
    byTestId('history-close').focus();
    key('Delete');
    await waitFor(() => cards().length === 13);
    expect(chrome.history.deleteUrl).toHaveBeenCalledWith({ url: 'https://p2.example/' });
    expect(selectedTitle()).toBe('Page 3');
    key('F10', { shiftKey: true });
    expect(byTestId('menu')).not.toBe(null);
    key('Escape');
    await tick();
    expect(switcher.historyOpen()).toBe(true);
    key('Enter', { ctrlKey: true });
    await waitFor(() => chrome.tabs.create.mock.calls.length === 1);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://p3.example/', active: false }));
    expect(switcher.state.done).toBe(false);
  });

  it('"Show 50 more" from the keyboard too: Enter on it, or ↓ past the last page', async () => {
    seedHistory(130);
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    byTestId('history-more').focus();
    expect(key('Enter').defaultPrevented).toBe(false); // the button's own Enter (it clicks)
    byTestId('history-more').click();
    await waitFor(() => cards().length === 100);
    switcher.historySelect(99, false);
    byTestId('history-search').focus();
    key('ArrowDown');
    await waitFor(() => cards().length === 130);
  });

  it('starring a page from its menu keeps the main selection where it was', async () => {
    seedHistory(5);
    const switcher = await boot({ tabs: [...defaultTabs, { title: 'C', url: 'https://c.example/' }, { title: 'D', url: 'https://d.example/' }], context: { direction: 0 } });
    switcher.selectKey('t' + tabByTitle(switcher, 'C').id);
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('C');
    await openHistory(switcher);
    switcher.historyMenu(switcher.state.historyView.items[1]);
    menuItem(translate('star')).click();
    await waitFor(() => switcher.isStarred('https://p2.example/'));
    await tick(30);
    key('Escape', { target: byTestId('history-search') });
    expect(switcher.historyOpen()).toBe(false);
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('C');
    expect(byTestId('card-title', allByTestId('card-tab').find((card) => card.getAttribute('aria-selected') === 'true')).textContent).toBe('C');
  });

  it('while it is open the rest of the switcher is inert', async () => {
    seedHistory(1);
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    for (const id of ['header', 'body']) expect(byTestId(id).hasAttribute('inert'), id).toBe(true);
    expect(byTestId('history-overlay').hasAttribute('inert')).toBe(false);
    switcher.closeHistory();
    expect(byTestId('header').hasAttribute('inert')).toBe(false);
  });
});

describe('a recently closed card’s delete button', () => {
  it('stands where its star was, and takes the entry off the list', async () => {
    const switcher = await boot({ tabs: defaultTabs, beforeImport: () => { chrome._data.closed = [{ lastModified: Math.floor(NOW / 1000) - 60, tab: { sessionId: 'c1', url: 'https://gone.example/', title: 'Gone' } }]; } });
    const card = cardOf('Gone', 'closed');
    expect(byTestId('card-star-button', card)).toBe(null);
    const removeButton = byTestId('card-closed-remove', card);
    expect(removeButton.getAttribute('aria-label')).toBe(translate('closedRemove'));
    removeButton.click();
    await waitFor(() => !cardOf('Gone', 'closed'));
    expect(toastText()).toBe(translate('closedRemoved'));
    expect(switcher.state.entries.some((entry) => entry.kind === 'closed')).toBe(false);
  });
});

describe('a page\u2019s "last opened" tag and loading more by itself', () => {
  it('says how long ago ("5m ago", "1 year ago"); hovering it shows the full date', async () => {
    chrome._data.history.push({ url: 'https://new.example/', title: 'New', lastVisitTime: NOW - 5 * 60000, visitCount: 1 });
    chrome._data.history.push({ url: 'https://old.example/', title: 'Old', lastVisitTime: NOW - 400 * 864e5, visitCount: 1 });
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    const tags = cards().map((card) => byTestId('card-history-ago', card));
    expect(tags.map((x) => x.textContent)).toEqual([translate('agoMinute', { n: 5 }), translate('agoYear', { count: 1 })]);
    expect(translate('agoMinute', { n: 5 })).toBe('5m ago');
    expect(translate('agoYear', { count: 1 })).toBe('1 year ago');
    tags[1].dispatchEvent(new MouseEvent('mouseenter'));
    await waitFor(() => byTestId('history-date-tooltip'));
    expect(byTestId('history-date-tooltip-title').textContent).toBe(translate('historyLastOpened'));
    expect(byTestId('history-date-tooltip-text').textContent).toBe(new Date(NOW - 400 * 864e5).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }));
    expect(tags[1].title).toBe(''); // its own tooltip, not the row's
  });

  it('the date tooltip opens only after 500 ms on the tag; leaving sooner, it never opens', async () => {
    chrome._data.history.push({ url: 'https://new.example/', title: 'New', lastVisitTime: NOW - 5 * 60000, visitCount: 1 });
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    expect(switcher.DATE_TIP_DELAY_MILLISECONDS).toBe(500);
    const tag = byTestId('card-history-ago', cards()[0]);
    tag.dispatchEvent(new MouseEvent('mouseenter'));
    await tick(300);
    tag.dispatchEvent(new MouseEvent('mouseleave'));
    await tick(400);
    expect(byTestId('history-date-tooltip')).toBe(null);
    const from = Date.now();
    tag.dispatchEvent(new MouseEvent('mouseenter'));
    await tick(350);
    expect(byTestId('history-date-tooltip')).toBe(null);
    await waitFor(() => byTestId('history-date-tooltip'));
    expect(Date.now() - from).toBeGreaterThanOrEqual(480);
  });

  it('agoShort: minutes, hours, days, weeks, months, years', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const ago = (milliseconds) => switcher.agoShort(Date.now() - milliseconds);
    expect([ago(10e3), ago(3 * 3600e3), ago(2 * 864e5), ago(15 * 864e5), ago(90 * 864e5), ago(800 * 864e5)])
      .toEqual([translate('justNow'), '3h ago', '2d ago', '2w ago', '3 months ago', '2 years ago']);
  });

  it('reaching the bottom of the list loads the next 50 by itself', async () => {
    seedHistory(120);
    const seen = [];
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = window.IntersectionObserver = class { constructor(callback) { this.callback = callback; seen.push(this); } observe(target) { this.n = target; } unobserve() {} disconnect() {} takeRecords() { return []; } };
    try {
      const switcher = await boot({ tabs: defaultTabs });
      await openHistory(switcher);
      const observer = seen.find((x) => x.n === byTestId('history-more'));
      expect(observer).toBeTruthy();
      observer.callback([{ isIntersecting: true, target: byTestId('history-more') }]);
      await waitFor(() => cards().length === 100);
      observer.callback([{ isIntersecting: true, target: byTestId('history-more') }]);
      await waitFor(() => cards().length === 120);
    } finally { globalThis.IntersectionObserver = window.IntersectionObserver = originalIntersectionObserver; }
  });

  it('the 50 that come by scrolling leave the selection where it was; ↓ past the last page selects the first new one', async () => {
    seedHistory(170);
    const seen = [];
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = window.IntersectionObserver = class { constructor(callback) { this.callback = callback; seen.push(this); } observe(target) { this.n = target; } unobserve() {} disconnect() {} takeRecords() { return []; } };
    try {
      const switcher = await boot({ tabs: defaultTabs });
      await openHistory(switcher);
      switcher.historySelect(3, false);
      expect(selectedTitle()).toBe('Page 4');
      const observer = seen.find((x) => x.n === byTestId('history-more'));
      observer.callback([{ isIntersecting: true, target: byTestId('history-more') }]); // scrolled to the bottom
      await waitFor(() => cards().length === 100);
      expect(switcher.state.historyView.selected).toBe(3);
      expect(selectedTitle()).toBe('Page 4');
      await switcher.moreHistory({ select: false }); // what the observer asks for
      expect(cards()).toHaveLength(150);
      expect(selectedTitle()).toBe('Page 4');
      switcher.historySelect(149, false);
      byTestId('history-search').focus();
      key('ArrowDown'); // past the last page
      await waitFor(() => cards().length === 170);
      await waitFor(() => switcher.state.historyView.selected === 150);
      expect(selectedTitle()).toBe('Page 151');
    } finally { globalThis.IntersectionObserver = window.IntersectionObserver = originalIntersectionObserver; }
  });

  it('moreHistory(): the first of the new pages is selected', async () => {
    seedHistory(70);
    const switcher = await boot({ tabs: defaultTabs });
    await openHistory(switcher);
    switcher.historySelect(3, false);
    await switcher.moreHistory();
    expect(cards()).toHaveLength(70);
    expect(switcher.state.historyView.selected).toBe(50);
    expect(selectedTitle()).toBe('Page 51');
  });
});
