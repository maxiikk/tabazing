// The command palette (switcher.js openPalette and around): opening it every way, leaving it every way, the
// keyboard and the mouse, every action, the search results it shares with the dropdown, quick answers, and the
// recently run actions. Against the real switcher page and the fake chrome.* API; elements by data-testid only.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tick, waitFor, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, tabByTitle, toastText, closedMessage } from '../helpers/quiet-boot.js';
import { MESSAGE, KEY } from '../../utils/constants.js';
import { translate } from '../../utils/translations.js';

const defaultTabs = [
  { title: 'Alpha', url: 'https://alpha.example/' },
  { title: 'Bravo', url: 'https://bravo.example/' },
  { title: 'Charlie', url: 'https://charlie.example/' },
];
const live = (id) => chrome._data.tabs.find((x) => x.id === id);
const shown = () => !byTestId('palette').hidden;
const input = () => byTestId('palette-input');
const options = () => [...byTestId('palette-list').querySelectorAll('[role="option"]')];
const actionRows = () => allByTestId('palette-row-action');
const actionIds = () => actionRows().map((row) => row.dataset.action);
const rowOf = (id) => actionRows().find((row) => row.dataset.action === id);
const titleIn = (row) => byTestId('dropdown-title', row).textContent;
// Type into the palette's box as a person would: the value, then the input event (drawn on the next frame).
async function type(text) {
  input().value = text;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await tick(40); // drawn on the next frame
}
async function typeInSearch(text) {
  const searchInput = byTestId('search');
  searchInput.focus();
  searchInput.value = text;
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(40);
}
// Run one action by its id, from the keyboard (highlight it, Enter).
async function runAction(switcher, id, init = {}) {
  const i = switcher.state.palette.items.findIndex((x) => x.kind === 'action' && x.action.id === id);
  expect(i, id).toBeGreaterThanOrEqual(0);
  switcher.state.palette.highlighted = i;
  switcher.paletteHighlight();
  key('Enter', init);
  await tick(30);
}

let clipboard;
beforeEach(() => {
  clipboard = { writeText: vi.fn(async () => {}) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});

describe('opening and leaving', () => {
  it('Alt+R (a palette launch) opens straight into it; Esc then closes Tabazing', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { palette: true, direction: 0 } });
    expect(shown()).toBe(true);
    expect(document.documentElement.classList.contains('palette-open')).toBe(true);
    expect(document.documentElement.classList.contains('palette')).toBe(false); // the panel's class: its rule would size the whole page
    expect(document.documentElement.classList.contains('palette-solo')).toBe(true); // on its own: the switcher isn't shown behind it
    expect(document.activeElement).toBe(input());
    expect(switcher.state.palette.from).toBe('shortcut');
    // Everything else is inert (not the toast or the live regions).
    expect(byTestId('header').hasAttribute('inert')).toBe(true);
    expect(byTestId('body').hasAttribute('inert')).toBe(true);
    expect(byTestId('toast').hasAttribute('inert')).toBe(false);
    expect(byTestId('palette-foot').textContent).toBe(translate('paletteFootClose'));
    key('Escape');
    await tick();
    expect(closedMessage()).toMatchObject({ reason: 'cancel' });
  });

  it('the panel shows before the tabs are read; the tab actions join it once they are', async () => {
    const waiting = [];
    const switcher = await boot({
      tabs: defaultTabs, context: { palette: true, direction: 0 },
      beforeImport: () => {
        const mine = () => structuredClone(chrome._data.tabs.filter((x) => x.windowId === 1));
        chrome.tabs.query.mockImplementation(() => new Promise((resolve) => waiting.push(() => resolve(mine()))));
        chrome.tabs.get.mockImplementation(() => new Promise(() => {})); // nor the current tab, for now
      },
    });
    expect(shown()).toBe(true);
    expect(switcher.state.tabs).toEqual([]);
    expect(actionIds()).toContain('new-tab');
    expect(actionIds()).not.toContain('reload');
    chrome.tabs.query.mockReset();
    waiting.forEach((go) => go());
    await waitFor(() => switcher.state.tabs.length === 3);
    await waitFor(() => actionIds().includes('reload'));
    expect(document.activeElement).toBe(input());
  });

  it("'>' as the first character in the search box opens it from the switcher; Esc comes back with the box as it was", async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await typeInSearch('br');
    await typeInSearch('>br');
    expect(shown()).toBe(true);
    expect(switcher.state.palette.from).toBe('switcher');
    expect(document.documentElement.classList.contains('palette-solo')).toBe(false); // over the switcher, dimmed
    expect(input().value).toBe('br');
    expect(byTestId('palette-foot').textContent).toBe(translate('paletteFootBack'));
    key('Escape');
    expect(shown()).toBe(false);
    expect(document.documentElement.classList.contains('palette-open')).toBe(false);
    expect(document.documentElement.classList.contains('palette-solo')).toBe(false);
    expect(byTestId('search').value).toBe('br');
    expect(switcher.state.query).toBe('br');
    expect(document.activeElement).toBe(byTestId('search'));
    expect(byTestId('header').hasAttribute('inert')).toBe(false);
    expect(switcher.state.done).toBe(false);
  });

  it('Ctrl+K (⌘K) opens it, and again goes back', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(shown()).toBe(true);
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(shown()).toBe(false);
    key('k', { code: 'KeyK', metaKey: true });
    expect(shown()).toBe(true);
    expect(switcher.state.done).toBe(false);
  });

  it('Alt+R inside Tabazing opens it too (when Chrome left the shortcut unassigned), without typing an r', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const event = key('r', { code: 'KeyR', altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(shown()).toBe(true);
    expect(byTestId('search').value).toBe('');
    expect(switcher.state.done).toBe(false);
  });

  it('the wheel scrolls its list (the overlay blocks the wheel everywhere else, so the page under it stays put)', async () => {
    await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    const wheel = (target) => { const event = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }); target.dispatchEvent(event); return event; };
    expect(wheel(byTestId('palette-list')).defaultPrevented).toBe(false);
    const row = allByTestId('palette-row-action')[0];
    expect(row).toBeTruthy();
    expect(wheel(row).defaultPrevented).toBe(false); // over a row inside it
    expect(wheel(byTestId('palette-bar')).defaultPrevented).toBe(true); // the input bar doesn't scroll
  });

  it('Backspace in the empty box goes back to the switcher; with text it only deletes', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('x');
    const event = key('Backspace');
    expect(event.defaultPrevented).toBe(false);
    expect(shown()).toBe(true);
    await type('');
    key('Backspace');
    expect(shown()).toBe(false);
    expect(switcher.state.done).toBe(false);
  });

  it('Backspace in the empty box does not close a palette opened straight from the shortcut', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { palette: true, direction: 0 } });
    key('Backspace');
    expect(shown()).toBe(true);
    expect(switcher.state.done).toBe(false);
  });

  it('the shortcut in an open switcher (MSG.CYCLE with palette) opens it there', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const respond = vi.fn();
    chrome.runtime.onMessage._emit({ type: MESSAGE.CYCLE, direction: 0, hold: false, palette: true }, { id: chrome.runtime.id }, respond);
    expect(respond).toHaveBeenCalledWith({ ok: true });
    expect(shown()).toBe(true);
    expect(switcher.state.palette.from).toBe('switcher');
  });

  it('the shortcut while Settings is open: Settings closes and the palette is usable', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('settings-button').click();
    await waitFor(() => byTestId('settings'));
    await tick();
    chrome.runtime.onMessage._emit({ type: MESSAGE.CYCLE, direction: 0, hold: false, palette: true }, { id: chrome.runtime.id }, vi.fn());
    await tick(10);
    expect(switcher.state.palette).toBeTruthy();
    expect(shown()).toBe(true);
    expect(byTestId('settings')).toBe(null);
    expect(byTestId('settings-backdrop')).toBe(null);
    expect(byTestId('palette').closest('[inert]')).toBe(null);
    expect(document.activeElement).toBe(input());
  });

  it('a click beside the panel leaves it, like Esc', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    byTestId('app').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(shown()).toBe(false);
    expect(switcher.state.done).toBe(false);
  });
});

describe('the keyboard and the mouse', () => {
  it('↑/↓ move the highlight (wrapping), and the box points screen readers at it', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    const count = options().length;
    expect(count).toBeGreaterThan(3);
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    key('ArrowDown');
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1].id);
    key('ArrowUp');
    key('ArrowUp');
    expect(switcher.state.palette.highlighted).toBe(count - 1);
    expect(byTestId('palette-list').getAttribute('role')).toBe('listbox');
    expect(input().getAttribute('role')).toBe('combobox');
  });

  it('hovering a row does not move the highlight (only ↑ / ↓ do); a click runs the row clicked', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) options()[2].dispatchEvent(new MouseEvent(type, { bubbles: true }));
    expect(switcher.state.palette.highlighted).toBe(0);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    expect(options()[2].getAttribute('aria-selected')).toBe('false');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    await type('downloads');
    const row = rowOf('downloads');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(20);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome://downloads', windowId: 1, active: true });
    expect(switcher.state.done).toBe(true);
  });

  it('the highlight stays on its row when late results (Chrome\'s history search) reorder the list; new text resets it', async () => {
    // 200 days old: past the 90 days read up front, so only Chrome's search (after a pause) finds it, as the best match.
    chrome._data.history.push({ url: 'https://old.example/', title: 'Alpha old page', lastVisitTime: Date.now() - 200 * 864e5, visitCount: 3 });
    const switcher = await boot({ tabs: [{ title: 'Xalphax', url: 'https://x.example/' }, { title: 'Yalphay', url: 'https://y.example/' }] });
    const highlightedRow = () => options().find((row) => row.getAttribute('aria-selected') === 'true');
    switcher.openPalette({ from: 'switcher', text: 'alpha' });
    await tick(40);
    expect(options().map(titleIn).slice(0, 2)).toEqual(['Xalphax', 'Yalphay']);
    key('ArrowDown', { target: input() });
    expect(titleIn(highlightedRow())).toBe('Yalphay');
    await tick(300);
    expect(options().map(titleIn)[0]).toBe('Alpha old page'); // came in late, first
    expect(titleIn(highlightedRow())).toBe('Yalphay');
    await type('alph');
    expect(switcher.state.palette.highlighted).toBe(0);
    expect(highlightedRow()).toBe(options()[0]);
  });

  it('in an overlay that is not visible, clicks do nothing (pointerAllowed)', async () => {
    const switcher = await boot({ tabs: defaultTabs, overlay: true });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('downloads');
    rowOf('downloads').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(20);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(switcher.state.done).toBe(false);
  });

  it('Tab stays in the panel', async () => {
    await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    const event = key('Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
  });
});

describe('what it lists', () => {
  it('with nothing typed: the most useful actions first, then the recently run ones (tagged), then the rest', async () => {
    const switcher = await boot({ tabs: defaultTabs, beforeImport: () => chrome.storage.local.set({ [KEY.PALETTE_RECENT]: ['downloads', 'bogus id!', 'history'] }) });
    key('k', { code: 'KeyK', ctrlKey: true });
    await tick(10);
    const ids = actionIds();
    expect(ids.slice(0, 5)).toEqual(['new-tab', 'new-window', 'incognito', 'reopen', 'settings']);
    expect(ids.slice(5, 7)).toEqual(['downloads', 'history']);
    expect(byTestId('palette-recent-tag', rowOf('downloads')).textContent).toBe(translate('paletteRecent'));
    expect(byTestId('palette-recent-tag', rowOf('new-tab'))).toBeNull();
    expect(ids.length).toBe(switcher.paletteActions().length); // everything that can run now
    // each row: its icon, and where it acts at the end of the title row
    expect(byTestId('palette-action-icon', rowOf('new-tab'))).not.toBeNull();
    expect(byTestId('palette-source-chrome', rowOf('new-tab')).getAttribute('aria-label')).toBe(translate('paletteSourceChrome'));
    expect(byTestId('palette-source-tab', rowOf('reload')).getAttribute('aria-label')).toBe(translate('paletteSourceTab'));
    expect(byTestId('palette-source-tabazing', rowOf('keys')).getAttribute('aria-label')).toBe(translate('paletteSourceTabazing'));
    expect(byTestId('dropdown-subtitle', rowOf('reload')).textContent).toBe('Alpha'); // which tab
  });

  it('running an action remembers it first among the recent ones (capped)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'copy-link');
    await waitFor(() => switcher.state.paletteRecent[0] === 'copy-link');
    expect(chrome.storage.local._data.get(KEY.PALETTE_RECENT)[0]).toBe('copy-link');
  });

  it('only what can be done now: no merge with one window, no media without media, no duplicates action without copies', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const ids = switcher.paletteActions().map((action) => action.id);
    for (const id of ['merge', 'media-toggle', 'media-next', 'dupes', 'close-others', 'theme-system', 'sort-recent']) {
      if (id === 'close-others') expect(ids).toContain(id); // two other tabs here
      else expect(ids, id).not.toContain(id);
    }
  });

  it('quick match: typed words find actions by title, keywords and typos; an action beats a search result on the same score', async () => {
    const switcher = await boot({ tabs: [...defaultTabs, { title: 'New tab tips', url: 'https://tips.example/' }] });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('new tab');
    expect(switcher.state.palette.items[0]).toMatchObject({ kind: 'action', action: { id: 'new-tab' } });
    await type('refresh');
    expect(switcher.state.palette.items[0].action.id).toBe('reload');
    await type('incognto'); // a typo
    expect(switcher.state.palette.items[0].action.id).toBe('incognito');
    await type('zoom');
    expect(actionIds().slice(0, 3).sort()).toEqual(['zoom-in', 'zoom-out', 'zoom-reset']);
    expect(byTestId('search-highlight', rowOf('zoom-in')).textContent).toBe('Zoom');
  });

  it('in Spanish, English words still find the actions, and so do the Spanish ones', async () => {
    const switcher = await boot({ tabs: defaultTabs, preferences: { lang: 'es' } });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('new tab');
    expect(switcher.state.palette.items[0].action.id).toBe('new-tab');
    expect(titleIn(rowOf('new-tab'))).toBe('Nueva pestaña');
    await type('incógnito');
    expect(switcher.state.palette.items[0].action.id).toBe('incognito');
    await type('recargar');
    expect(switcher.state.palette.items[0].action.id).toBe('reload');
    expect(switcher.actionFields(switcher.PALETTE_BY_ID.get('incognito'))[2]).toBe('New Incognito window'); // matched in English too...
    await type('');
    expect(titleIn(rowOf('incognito'))).toBe('Nueva ventana de incógnito'); // ...and shown in Spanish
  });

  it('in Russian too', async () => {
    const switcher = await boot({ tabs: defaultTabs, preferences: { lang: 'ru' } });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('history');
    expect(switcher.state.palette.items[0].action.id).toBe('history');
    await type('загрузки');
    expect(switcher.state.palette.items[0].action.id).toBe('downloads');
  });

  it('shows exactly the search dropdown’s results for the same text, in the same order, with the same pictures and sources', async () => {
    chrome._addBookmark({ title: 'Bravo docs', url: 'https://docs.bravo.example/' });
    chrome._data.history.push({ url: 'https://bravo.example/old', title: 'Bravo archive page', lastVisitTime: Date.now() - 1000, visitCount: 3 });
    const switcher = await boot({ tabs: defaultTabs });
    await typeInSearch('bravo');
    await waitFor(() => switcher.state.marks && switcher.state.history);
    await tick(200); // Chrome's own history search for the text
    switcher.flushSearch();
    const signature = (root) => [...root.querySelectorAll('[role="option"]')].filter((row) => /^dropdown-row-/.test(row.dataset.testid))
      .map((row) => [row.dataset.testid, row.textContent, row.querySelector('img') && row.querySelector('img').getAttribute('src')]);
    const dropdown = signature(byTestId('search-dropdown'));
    expect(dropdown.length).toBeGreaterThanOrEqual(3);
    switcher.openPalette({ from: 'switcher', text: 'bravo' });
    switcher.renderPalette();
    expect(signature(byTestId('palette-list'))).toEqual(dropdown);
    // and Enter on one opens it as the dropdown would
    const i = switcher.state.palette.items.findIndex((item) => item.kind === 'tab');
    switcher.state.palette.highlighted = i;
    key('Enter');
    await tick(20);
    expect(live(tabByTitle(switcher, 'Bravo').id).active).toBe(true);
  });

  it('nothing at all: says so, with the dropdown’s Google search', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('qqqzzzxxx');
    expect(byTestId('dropdown-row-google', byTestId('palette-list'))).not.toBeNull();
    switcher.state.palette.highlighted = switcher.state.palette.items.findIndex((item) => item.kind === 'google');
    key('Enter');
    await tick(20);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://www.google.com/search?q=qqqzzzxxx', windowId: 1, active: true });
  });

  it('matches actions in well under 5 ms for typical input (remembered scores)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    const actions = switcher.paletteActions();
    const words = ['n', 'ne', 'new', 'new t', 'new ta', 'new tab', 'zo', 'zoom i', 'clo', 'close ot', 'theme', 'incog'];
    for (const word of words) actions.forEach((action) => switcher.searchScore(word, ...switcher.actionFields(action))); // warm up
    const startTime = performance.now();
    for (let round = 0; round < 20; round++) for (const word of words) actions.forEach((action) => switcher.searchScore(word, ...switcher.actionFields(action)));
    expect((performance.now() - startTime) / (20 * words.length)).toBeLessThan(5);
  });
});

describe('quick answers', () => {
  it('a conversion shows its result big; Enter copies it with a note, Shift+Enter and the button the whole expression', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('10 km in mi');
    const row = byTestId('palette-row-quick');
    expect(switcher.state.palette.items[0].kind).toBe('quick');
    expect(byTestId('palette-quick-value', row).textContent).toBe('6.21371 mi');
    expect(byTestId('palette-quick-expr', row).textContent).toContain(translate('paletteQuickUnit'));
    expect(byTestId('palette-quick-expr', row).textContent).toContain('10 km = 6.21371 mi');
    key('Enter');
    await tick(10);
    expect(clipboard.writeText).toHaveBeenLastCalledWith('6.21371 mi');
    expect(toastText()).toBe(translate('paletteCopied', { text: '6.21371 mi' }));
    expect(shown()).toBe(true); // stays: the note says it worked
    key('Enter', { shiftKey: true });
    await tick(10);
    expect(clipboard.writeText).toHaveBeenLastCalledWith('10 km = 6.21371 mi');
    const button = byTestId('palette-copy-expr', row);
    expect(button.tabIndex).toBe(-1); // for the mouse: the keyboard has Shift+Enter
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(10);
    expect(clipboard.writeText).toHaveBeenCalledTimes(3);
    expect(switcher.state.paletteRecent).toEqual([]); // copying isn't an action
  });

  it('sums, colours (with a swatch), bases, days', async () => {
    await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('80 + 15%');
    expect(byTestId('palette-quick-value').textContent).toBe('92');
    expect(byTestId('palette-quick-expr').textContent).toContain(translate('paletteQuickCalculation'));
    await type('#ff8800');
    expect(byTestId('palette-quick-value').textContent).toBe('rgb(255, 136, 0)');
    expect(byTestId('palette-swatch').style.background).toMatch(/rgb\(255, 136, 0\)|#ff8800/);
    await type('255 in hex');
    expect(byTestId('palette-quick-value').textContent).toBe('0xFF');
    await type('days between 2026-01-01 and 2026-01-11');
    expect(byTestId('palette-quick-value').textContent).toBe(translate('paletteDays', { count: 10 }));
  });

  it('currency: one disabled row saying why, and Enter does nothing', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('10 usd in eur');
    const row = byTestId('palette-row-currency');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain(translate('paletteCurrency'));
    expect(row.textContent).toContain(translate('paletteCurrencyWhy'));
    expect(switcher.state.palette.highlighted).toBe(0);
    key('Enter');
    await tick(10);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(switcher.state.done).toBe(false);
  });
});

describe('Chrome actions', () => {
  it.each([
    ['chrome-settings', 'chrome://settings'],
    ['extensions', 'chrome://extensions'],
    ['chrome-shortcuts', 'chrome://extensions/shortcuts'],
    ['history', 'chrome://history'],
    ['downloads', 'chrome://downloads'],
    ['bookmarks', 'chrome://bookmarks'],
    ['clear-data', 'chrome://settings/clearBrowserData'],
    ['passwords', 'chrome://password-manager/passwords'],
    ['ext-page', 'chrome://extensions/?id=' + chrome.runtime.id],
  ])('%s opens %s in a new tab and closes Tabazing', async (id, url) => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, id);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url, windowId: 1, active: true });
    expect(closedMessage()).toMatchObject({ reason: 'switch' });
  });

  it('New tab, New window, New Incognito window, Reopen', async () => {
    let switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'new-tab');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ windowId: 1, active: true });
    expect(switcher.state.done).toBe(true);
    for (const [id, call] of [['new-window', { focused: true }], ['incognito', { incognito: true, focused: true }]]) {
      switcher = await boot({ tabs: defaultTabs });
      key('k', { code: 'KeyK', ctrlKey: true });
      await runAction(switcher, id);
      expect(chrome.windows.create).toHaveBeenLastCalledWith(call);
      expect(switcher.state.done).toBe(true);
    }
    switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'reopen');
    expect(chrome.sessions.restore).toHaveBeenCalledWith();
    expect(closedMessage()).toMatchObject({ reason: 'restore' });
  });

  it('Incognito refused (turned off by policy): a clear note, and the palette stays', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    chrome.windows.create.mockRejectedValueOnce(new Error('Incognito mode is disabled.'));
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'incognito');
    expect(toastText()).toBe(translate('paletteErrorIncognito'));
    expect(shown()).toBe(true);
    expect(switcher.state.done).toBe(false);
  });

  it('Reopen with nothing to reopen says so', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    chrome.sessions.restore.mockRejectedValueOnce(new Error('nothing'));
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'reopen');
    expect(toastText()).toBe(translate('paletteErrorReopen'));
    expect(switcher.state.done).toBe(false);
  });
});

describe('actions on the current tab', () => {
  it('Reload reloads it and gives the page back', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'reload');
    expect(chrome.tabs.reload).toHaveBeenCalledWith(tabByTitle(switcher, 'Alpha').id);
    expect(closedMessage()).toMatchObject({ reason: 'cancel' });
  });

  it('Duplicate, Pin, Mute: done, then the switcher shows the result', async () => {
    let switcher = await boot({ tabs: defaultTabs });
    const alpha = tabByTitle(switcher, 'Alpha');
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'duplicate');
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://alpha.example/', index: alpha.index + 1, active: false }));
    expect(shown()).toBe(false);
    expect(switcher.state.done).toBe(false);
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(titleIn(rowOf('pin'))).toBe(translate('pinThis'));
    await runAction(switcher, 'pin');
    expect(live(alpha.id).pinned).toBe(true);
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(titleIn(rowOf('pin'))).toBe(translate('unpinThis'));
    await runAction(switcher, 'mute');
    expect(live(alpha.id).mutedInfo.muted).toBe(true);
    expect(toastText()).toBe(translate('mutedCount', { count: 1 }));
    switcher = null;
  });

  it('Close tab keeps the Undo; Close other tabs closes the rest of the window (not pinned ones), with Undo', async () => {
    const switcher = await boot({ tabs: [...defaultTabs, { title: 'Pinned', url: 'https://p.example/', pinned: true }] });
    const ids = chrome._data.tabs.map((x) => x.id);
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'close-others');
    expect(chrome.tabs.remove).toHaveBeenCalledWith([tabByTitle(switcher, 'Bravo')?.id ?? ids[1], ids[2]]);
    expect(chrome._data.tabs.map((x) => x.title).sort()).toEqual(['Alpha', 'Pinned']);
    expect(shown()).toBe(false);
    expect(byTestId('toast-action').textContent).toContain(translate('undo'));
  });

  it('Close tab closes it with Undo (in a popup window Tabazing stays)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const alpha = tabByTitle(switcher, 'Alpha');
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'close-tab');
    expect(chrome.tabs.remove).toHaveBeenCalledWith(alpha.id);
    expect(toastText()).toBe(translate('closedCount', { count: 1 }));
    expect(switcher.state.undo.length).toBe(1);
  });

  it('Move to a new window, with Undo', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const alpha = tabByTitle(switcher, 'Alpha');
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'move-window');
    expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: alpha.id, focused: false });
    expect(toastText()).toBe(translate('movedCount', { count: 1 }));
  });

  it('Zoom in / out / reset step through Chrome’s zoom levels; Shift+Enter stays in the palette', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const id = tabByTitle(switcher, 'Alpha').id;
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'zoom-in', { shiftKey: true });
    expect(chrome.tabs.setZoom).toHaveBeenLastCalledWith(id, 1.1);
    expect(toastText()).toBe(translate('paletteZoomed', { level: '110%' }));
    expect(shown()).toBe(true);
    await runAction(switcher, 'zoom-in', { shiftKey: true });
    expect(chrome.tabs.setZoom).toHaveBeenLastCalledWith(id, 1.25);
    await runAction(switcher, 'zoom-out', { shiftKey: true });
    expect(chrome.tabs.setZoom).toHaveBeenLastCalledWith(id, 1.1);
    await runAction(switcher, 'zoom-reset');
    expect(chrome.tabs.setZoom).toHaveBeenLastCalledWith(id, 1);
    expect(closedMessage()).toMatchObject({ reason: 'cancel' }); // Enter: back to the page
    expect(switcher.nextZoom(5, 1)).toBe(5);
    expect(switcher.nextZoom(0.25, -1)).toBe(0.25);
    expect(switcher.nextZoom(1.05, -1)).toBe(1);
  });

  it('a zoom Chrome refuses: a note, and the palette stays', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    chrome.tabs.setZoom.mockRejectedValueOnce(new Error('Cannot zoom a chrome:// page'));
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'zoom-in');
    expect(toastText()).toBe(translate('paletteErrorZoom'));
    expect(switcher.state.done).toBe(false);
  });

  it('Full screen on, and off when the window is in full screen', async () => {
    let switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(titleIn(rowOf('fullscreen'))).toBe(translate('paletteFullscreenOn'));
    await runAction(switcher, 'fullscreen');
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { state: 'fullscreen' });
    chrome._reset();
    chrome._addWindow({ id: 1, focused: true, state: 'fullscreen' });
    switcher = await boot({ tabs: defaultTabs, context: { state: 'fullscreen' } });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(titleIn(rowOf('fullscreen'))).toBe(translate('paletteFullscreenOff'));
    await runAction(switcher, 'fullscreen');
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { state: 'normal' });
  });

  it('Copy link and Copy title and link: copied, a note, and the palette stays', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'copy-link');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('https://alpha.example/');
    expect(toastText()).toBe(translate('copiedCount', { count: 1 }));
    await runAction(switcher, 'copy-md');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('- [Alpha](https://alpha.example/)');
    expect(shown()).toBe(true);
  });

  it('Bookmark this page: the palette makes way for the Bookmark dialog, for the current tab', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'bookmark');
    await waitFor(() => byTestId('bookmark-form'));
    expect(shown()).toBe(false);
    expect(switcher.state.modal).toBe('bookmark');
    expect(byTestId('bookmark-name').value).toBe('Alpha');
    byTestId('bookmark-save').click();
    await waitFor(() => chrome.bookmarks.create.mock.calls.length > 0);
    expect(chrome.bookmarks.create).toHaveBeenCalledWith({ parentId: '2', title: 'Alpha', url: 'https://alpha.example/' });
  });

  it('no tab actions until the current tab is known, and none that page can’t take', async () => {
    const switcher = await boot({ tabs: [{ title: 'New Tab', url: 'chrome://newtab/' }] });
    const ids = switcher.paletteActions().map((action) => action.id);
    expect(ids).toContain('reload');
    expect(ids).not.toContain('bookmark');
    expect(ids).not.toContain('archive');
    expect(ids).not.toContain('snooze');
  });
});

describe('Tabazing actions', () => {
  it('Close duplicates shows the duplicates view (to confirm, as its button does)', async () => {
    const switcher = await boot({ tabs: [...defaultTabs, { title: 'Alpha 2', url: 'https://alpha.example/' }] });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'dupes');
    expect(switcher.state.duplicatesView).toBe(true);
    expect(shown()).toBe(false);
  });

  it('Merge windows pulls the other windows’ tabs in, with Undo', async () => {
    chrome._addWindow({ id: 1, focused: true });
    chrome._addTab({ windowId: 2, title: 'Far', url: 'https://far.example/' });
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'merge');
    expect(chrome.tabs.move).toHaveBeenCalled();
    expect(chrome._data.tabs.find((x) => x.title === 'Far').windowId).toBe(1);
    expect(toastText()).toBe(translate('mergedCount', { count: 1 }));
  });

  it('Sleep tabs not used for a week marks those (they sleep as Tabazing closes)', async () => {
    const old = Date.now() - 8 * 864e5;
    const switcher = await boot({ tabs: [...defaultTabs.map((x, i) => (i === 2 ? { ...x, lastAccessed: old } : x))] });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(byTestId('dropdown-subtitle', rowOf('sleep-old')).textContent).toBe(translate('tabs', { count: 1 }));
    await runAction(switcher, 'sleep-old');
    expect([...switcher.state.toSleep]).toEqual([tabByTitle(switcher, 'Charlie').id]);
  });

  it('Snooze this tab… opens the snooze choices; Archive this tab archives it', async () => {
    let switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'snooze');
    expect(shown()).toBe(false);
    expect(allByTestId('menu-item').length).toBeGreaterThan(3);
    switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'archive');
    await waitFor(() => toastText() === translate('archivedCount', { count: 1 }));
  });

  it('Open the archive, Settings, Keyboard shortcuts, Replay the tour open their cards', async () => {
    for (const [id, testid] of [['open-archive', 'archive-overlay'], ['settings', 'settings'], ['keys', 'keys-popover'], ['tour', 'dialog']]) {
      const switcher = await boot({ tabs: defaultTabs });
      key('k', { code: 'KeyK', ctrlKey: true });
      await runAction(switcher, id);
      await waitFor(() => byTestId(testid) && !byTestId(testid).hidden);
      expect(shown(), id).toBe(false);
      allByTestId('settings').concat(allByTestId('keys-popover'), allByTestId('archive-overlay')).forEach((element) => element.remove());
    }
  });

  it('Theme and Sort change the setting (the current choice isn’t offered)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(actionIds()).not.toContain('theme-system');
    await runAction(switcher, 'theme-light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    await waitFor(() => (chrome.storage.local._data.get(KEY.PREFERENCES) || {}).theme === 'light');
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'sort-name');
    expect(switcher.state.sort).toBe('name');
    await runAction(switcher, 'theme-system').catch(() => {});
  });

  it('Capture all previews asks the background, as the camera button does', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    chrome.runtime.sendMessage.mockImplementation(async (message) => (message.type === MESSAGE.SWEEP ? { n: 2 } : undefined));
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(switcher, 'capture-all');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: MESSAGE.SWEEP }));
    expect(switcher.state.done).toBe(true);
  });

  it('Media: play/pause, next, previous action on what the player shows', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.state.media = [{ tabId: tabByTitle(switcher, 'Bravo').id, frameId: 0, title: 'Song', artist: '', site: 'bravo.example', playing: true, canPrevious: true, canNext: true, kind: 'audio', t: Date.now(), tab: tabByTitle(switcher, 'Bravo') }];
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(titleIn(rowOf('media-toggle'))).toBe(translate('paletteMediaPause'));
    await runAction(switcher, 'media-next', { shiftKey: true });
    await runAction(switcher, 'media-prev', { shiftKey: true });
    await runAction(switcher, 'media-toggle');
    expect(chrome.scripting.executeScript.mock.calls.map(([options]) => options.args[0])).toEqual(['nexttrack', 'previoustrack', 'pause']);
    expect(closedMessage()).toMatchObject({ reason: 'cancel' });
  });
});

describe('the highlighted result (styles/switcher.css)', () => {
  it('is tinted with the accent, its edge and picture in it; no lift, no glow (styles/switcher.css)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(process.cwd() + '/styles/switcher.css', 'utf8');
    const rule = (selector) => { const at = css.indexOf('\n' + selector + ' {'); return at < 0 ? '' : css.slice(at, css.indexOf('}', at)); };
    expect(rule('.dropdown-row.on')).toMatch(/background: var\(--md-secondary-container\); border-color: color-mix\(in srgb, var\(--md-primary\) 45%, transparent\)/);
    expect(rule('.dropdown-row.on')).not.toMatch(/translate|scale|box-shadow/);
    expect(rule('.dropdown-row.on .dropdown-picture')).toMatch(/box-shadow: 0 0 0 2px var\(--md-primary\)/);
  });

  it('the media list\'s rows have no hover or "current" look of their own (only their buttons do)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(process.cwd() + '/styles/switcher.css', 'utf8');
    expect(css).not.toMatch(/\.media-row:hover|\.media-row\.on \{|\.media-pick:focus/);
  });
});

describe('keys that belong elsewhere, and actions that fail', () => {
  it('Esc and the arrows during a composition belong to the input method (as in the search box), not to the palette', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { palette: true, direction: 0 } });
    key('ArrowDown', { isComposing: true });
    expect(switcher.state.palette.highlighted).toBe(0);
    key('Escape', { isComposing: true });
    await tick();
    expect(switcher.state.done).toBe(false);
    expect(shown()).toBe(true);
  });

  it('a held Esc leaves the palette and stops there (the search and the switcher stay)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('search').value = switcher.state.query = 'bra';
    switcher.flushSearch();
    switcher.openPalette({ from: 'switcher', saved: 'bra' });
    key('Escape');
    key('Escape', { repeat: true });
    key('Escape', { repeat: true });
    await tick();
    expect(switcher.state.palette).toBe(null);
    expect(byTestId('search').value).toBe('bra');
    expect(switcher.state.done).toBe(false);
    expect(closedMessage()).toBe(undefined);
  });

  it('a held Backspace empties the palette’s box but does not leave the palette', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.openPalette({ from: 'switcher', text: '' });
    const event = key('Backspace', { repeat: true });
    expect(event.defaultPrevented).toBe(true);
    expect(switcher.state.palette).not.toBe(null);
  });

  it('a media action the page doesn’t act on says so and keeps the palette, as every other action does', async () => {
    const switcher = await boot({ tabs: [...defaultTabs, { title: 'Song', url: 'https://music.example/', audible: true }] });
    const song = tabByTitle(switcher, 'Song');
    switcher.state.media = [{ tabId: song.id, frameId: 0, playing: true, title: 'Song', site: 'music.example', canNext: true, canPrevious: true, tab: song }];
    chrome.scripting.executeScript = vi.fn(async () => [{ result: false }]);
    await switcher.runAction(switcher.PALETTE_BY_ID.get('media-toggle'));
    expect(switcher.state.done).toBe(false);
    expect(toastText()).toContain(translate('mediaFailed'));
  });
});
