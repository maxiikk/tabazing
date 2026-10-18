// The command palette (switcher.js openPalette and around): opening it every way, leaving it every way, the
// keyboard and the mouse, every action, the search results it shares with the dropdown, quick answers, and the
// recently run actions. Against the real switcher page and the fake chrome.* API; elements by data-testid only.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tick, waitFor, key } from '../helpers/switcher.js';
import { boot, tid, tids, tabByTitle, toastText, closedMsg } from './quiet-boot.js';
import { MSG, KEY } from '../../lib/constants.js';
import { t } from '../../lib/translations.js';

const ABC = [
  { title: 'Alpha', url: 'https://alpha.example/' },
  { title: 'Bravo', url: 'https://bravo.example/' },
  { title: 'Charlie', url: 'https://charlie.example/' },
];
const live = (id) => chrome._data.tabs.find((x) => x.id === id);
const shown = () => !tid('palette').hidden;
const input = () => tid('palette-input');
const options = () => [...tid('palette-list').querySelectorAll('[role="option"]')];
const actionRows = () => tids('palette-row-action');
const actionIds = () => actionRows().map((r) => r.dataset.action);
const rowOf = (id) => actionRows().find((r) => r.dataset.action === id);
const titleIn = (row) => tid('dd-title', row).textContent;
// Type into the palette's box as a person would: the value, then the input event (drawn on the next frame).
async function type(text) {
  input().value = text;
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await tick(40); // drawn on the next frame
}
async function typeInSearch(text) {
  const s = tid('search');
  s.focus();
  s.value = text;
  s.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(40);
}
// Run one action by its id, from the keyboard (highlight it, Enter).
async function runAction(sw, id, init = {}) {
  const i = sw.state.palette.items.findIndex((x) => x.kind === 'action' && x.a.id === id);
  expect(i, id).toBeGreaterThanOrEqual(0);
  sw.state.palette.hi = i;
  sw.palHighlight();
  key('Enter', init);
  await tick(30);
}

let clipboard;
beforeEach(() => {
  clipboard = { writeText: vi.fn(async () => {}) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});

describe('opening and leaving', () => {
  it('Ctrl+Shift+Space (a palette launch) opens straight into it; Esc then closes Tabazing', async () => {
    const sw = await boot({ tabs: ABC, ctx: { palette: true, dir: 0 } });
    expect(shown()).toBe(true);
    expect(document.documentElement.classList.contains('palette')).toBe(true);
    expect(document.activeElement).toBe(input());
    expect(sw.state.palette.from).toBe('shortcut');
    // Everything else is inert (not the toast or the live regions).
    expect(tid('header').hasAttribute('inert')).toBe(true);
    expect(tid('body').hasAttribute('inert')).toBe(true);
    expect(tid('toast').hasAttribute('inert')).toBe(false);
    expect(tid('palette-foot').textContent).toBe(t('palFootClose'));
    key('Escape');
    await tick();
    expect(closedMsg()).toMatchObject({ reason: 'cancel' });
  });

  it('the panel shows before the tabs are read; the tab actions join it once they are', async () => {
    const waiting = [];
    const sw = await boot({
      tabs: ABC, ctx: { palette: true, dir: 0 },
      beforeImport: () => {
        const mine = () => structuredClone(chrome._data.tabs.filter((x) => x.windowId === 1));
        chrome.tabs.query.mockImplementation(() => new Promise((r) => waiting.push(() => r(mine()))));
        chrome.tabs.get.mockImplementation(() => new Promise(() => {})); // nor the current tab, for now
      },
    });
    expect(shown()).toBe(true);
    expect(sw.state.tabs).toEqual([]);
    expect(actionIds()).toContain('new-tab');
    expect(actionIds()).not.toContain('reload');
    chrome.tabs.query.mockReset();
    waiting.forEach((go) => go());
    await waitFor(() => sw.state.tabs.length === 3);
    await waitFor(() => actionIds().includes('reload'));
    expect(document.activeElement).toBe(input());
  });

  it("'>' as the first character in the search box opens it from the switcher; Esc comes back with the box as it was", async () => {
    const sw = await boot({ tabs: ABC });
    await typeInSearch('br');
    await typeInSearch('>br');
    expect(shown()).toBe(true);
    expect(sw.state.palette.from).toBe('switcher');
    expect(input().value).toBe('br');
    expect(tid('palette-foot').textContent).toBe(t('palFootBack'));
    key('Escape');
    expect(shown()).toBe(false);
    expect(document.documentElement.classList.contains('palette')).toBe(false);
    expect(tid('search').value).toBe('br');
    expect(sw.state.query).toBe('br');
    expect(document.activeElement).toBe(tid('search'));
    expect(tid('header').hasAttribute('inert')).toBe(false);
    expect(sw.state.done).toBe(false);
  });

  it('Ctrl+K (⌘K) opens it, and again goes back', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(shown()).toBe(true);
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(shown()).toBe(false);
    key('k', { code: 'KeyK', metaKey: true });
    expect(shown()).toBe(true);
    expect(sw.state.done).toBe(false);
  });

  it('Backspace in the empty box goes back to the switcher; with text it only deletes', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('x');
    const e = key('Backspace');
    expect(e.defaultPrevented).toBe(false);
    expect(shown()).toBe(true);
    await type('');
    key('Backspace');
    expect(shown()).toBe(false);
    expect(sw.state.done).toBe(false);
  });

  it('Backspace in the empty box does not close a palette opened straight from the shortcut', async () => {
    const sw = await boot({ tabs: ABC, ctx: { palette: true, dir: 0 } });
    key('Backspace');
    expect(shown()).toBe(true);
    expect(sw.state.done).toBe(false);
  });

  it('the shortcut in an open switcher (MSG.CYCLE with palette) opens it there', async () => {
    const sw = await boot({ tabs: ABC });
    const respond = vi.fn();
    chrome.runtime.onMessage._emit({ type: MSG.CYCLE, dir: 0, hold: false, palette: true }, { id: chrome.runtime.id }, respond);
    expect(respond).toHaveBeenCalledWith({ ok: true });
    expect(shown()).toBe(true);
    expect(sw.state.palette.from).toBe('switcher');
  });

  it('a click beside the panel leaves it, like Esc', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    tid('app').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(shown()).toBe(false);
    expect(sw.state.done).toBe(false);
  });
});

describe('the keyboard and the mouse', () => {
  it('↑/↓ move the highlight (wrapping), and the box points screen readers at it', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    const n = options().length;
    expect(n).toBeGreaterThan(3);
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    key('ArrowDown');
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1].id);
    key('ArrowUp');
    key('ArrowUp');
    expect(sw.state.palette.hi).toBe(n - 1);
    expect(tid('palette-list').getAttribute('role')).toBe('listbox');
    expect(input().getAttribute('role')).toBe('combobox');
  });

  it('hovering highlights a row, a click runs it', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('downloads');
    const row = rowOf('downloads');
    row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(row.getAttribute('aria-selected')).toBe('true');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(20);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome://downloads', windowId: 1, active: true });
    expect(sw.state.done).toBe(true);
  });

  it('in an overlay that is not visible, clicks do nothing (pointerAllowed)', async () => {
    const sw = await boot({ tabs: ABC, overlay: true });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('downloads');
    rowOf('downloads').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(20);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(sw.state.done).toBe(false);
  });

  it('Tab stays in the panel', async () => {
    await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    const e = key('Tab');
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
  });
});

describe('what it lists', () => {
  it('with nothing typed: the most useful actions first, then the recently run ones (tagged), then the rest', async () => {
    const sw = await boot({ tabs: ABC, beforeImport: () => chrome.storage.local.set({ [KEY.PALETTE_RECENT]: ['downloads', 'bogus id!', 'history'] }) });
    key('k', { code: 'KeyK', ctrlKey: true });
    await tick(10);
    const ids = actionIds();
    expect(ids.slice(0, 5)).toEqual(['new-tab', 'new-window', 'incognito', 'reopen', 'settings']);
    expect(ids.slice(5, 7)).toEqual(['downloads', 'history']);
    expect(tid('palette-recent-tag', rowOf('downloads')).textContent).toBe(t('palRecent'));
    expect(tid('palette-recent-tag', rowOf('new-tab'))).toBeNull();
    expect(ids.length).toBe(sw.paletteActions().length); // everything that can run now
    // each row: its icon, and where it acts at the end of the title row
    expect(tid('palette-action-icon', rowOf('new-tab'))).not.toBeNull();
    expect(tid('palette-source-chrome', rowOf('new-tab')).getAttribute('aria-label')).toBe(t('palSrcChrome'));
    expect(tid('palette-source-tab', rowOf('reload')).getAttribute('aria-label')).toBe(t('palSrcTab'));
    expect(tid('palette-source-tabazing', rowOf('keys')).getAttribute('aria-label')).toBe(t('palSrcTabazing'));
    expect(tid('dd-sub', rowOf('reload')).textContent).toBe('Alpha'); // which tab
  });

  it('running an action remembers it first among the recent ones (capped)', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'copy-link');
    await waitFor(() => sw.state.palRecent[0] === 'copy-link');
    expect(chrome.storage.local._data.get(KEY.PALETTE_RECENT)[0]).toBe('copy-link');
  });

  it('only what can be done now: no merge with one window, no media without media, no duplicates action without copies', async () => {
    const sw = await boot({ tabs: ABC });
    const ids = sw.paletteActions().map((a) => a.id);
    for (const id of ['merge', 'media-toggle', 'media-next', 'dupes', 'close-others', 'theme-system', 'sort-recent']) {
      if (id === 'close-others') expect(ids).toContain(id); // two other tabs here
      else expect(ids, id).not.toContain(id);
    }
  });

  it('quick match: typed words find actions by title, keywords and typos; an action beats a search result on the same score', async () => {
    const sw = await boot({ tabs: [...ABC, { title: 'New tab tips', url: 'https://tips.example/' }] });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('new tab');
    expect(sw.state.palette.items[0]).toMatchObject({ kind: 'action', a: { id: 'new-tab' } });
    await type('refresh');
    expect(sw.state.palette.items[0].a.id).toBe('reload');
    await type('incognto'); // a typo
    expect(sw.state.palette.items[0].a.id).toBe('incognito');
    await type('zoom');
    expect(actionIds().slice(0, 3).sort()).toEqual(['zoom-in', 'zoom-out', 'zoom-reset']);
    expect(tid('search-highlight', rowOf('zoom-in')).textContent).toBe('Zoom');
  });

  it('in Spanish, English words still find the actions, and so do the Spanish ones', async () => {
    const sw = await boot({ tabs: ABC, prefs: { lang: 'es' } });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('new tab');
    expect(sw.state.palette.items[0].a.id).toBe('new-tab');
    expect(titleIn(rowOf('new-tab'))).toBe('Nueva pestaña');
    await type('incógnito');
    expect(sw.state.palette.items[0].a.id).toBe('incognito');
    await type('recargar');
    expect(sw.state.palette.items[0].a.id).toBe('reload');
    expect(sw.actionFields(sw.PAL_BY_ID.get('incognito'))[2]).toBe('New Incognito window'); // matched in English too...
    await type('');
    expect(titleIn(rowOf('incognito'))).toBe('Nueva ventana de incógnito'); // ...and shown in Spanish
  });

  it('in Russian too', async () => {
    const sw = await boot({ tabs: ABC, prefs: { lang: 'ru' } });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('history');
    expect(sw.state.palette.items[0].a.id).toBe('history');
    await type('загрузки');
    expect(sw.state.palette.items[0].a.id).toBe('downloads');
  });

  it('shows exactly the search dropdown’s results for the same text, in the same order, with the same pictures and sources', async () => {
    chrome._addBookmark({ title: 'Bravo docs', url: 'https://docs.bravo.example/' });
    chrome._data.history.push({ url: 'https://bravo.example/old', title: 'Bravo archive page', lastVisitTime: Date.now() - 1000, visitCount: 3 });
    const sw = await boot({ tabs: ABC });
    await typeInSearch('bravo');
    await waitFor(() => sw.state.marks && sw.state.history);
    await tick(200); // Chrome's own history search for the text
    sw.flushSearch();
    const sig = (root) => [...root.querySelectorAll('[role="option"]')].filter((r) => /^dd-row-/.test(r.dataset.testid))
      .map((r) => [r.dataset.testid, r.textContent, r.querySelector('img') && r.querySelector('img').getAttribute('src')]);
    const dropdown = sig(tid('search-dropdown'));
    expect(dropdown.length).toBeGreaterThanOrEqual(3);
    sw.openPalette({ from: 'switcher', text: 'bravo' });
    sw.renderPalette();
    expect(sig(tid('palette-list'))).toEqual(dropdown);
    // and Enter on one opens it as the dropdown would
    const i = sw.state.palette.items.findIndex((r) => r.kind === 'tab');
    sw.state.palette.hi = i;
    key('Enter');
    await tick(20);
    expect(live(tabByTitle(sw, 'Bravo').id).active).toBe(true);
  });

  it('nothing at all: says so, with the dropdown’s Google search', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('qqqzzzxxx');
    expect(tid('dd-row-google', tid('palette-list'))).not.toBeNull();
    sw.state.palette.hi = sw.state.palette.items.findIndex((r) => r.kind === 'google');
    key('Enter');
    await tick(20);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://www.google.com/search?q=qqqzzzxxx', windowId: 1, active: true });
  });

  it('matches actions in well under 5 ms for typical input (remembered scores)', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    const acts = sw.paletteActions();
    const words = ['n', 'ne', 'new', 'new t', 'new ta', 'new tab', 'zo', 'zoom i', 'clo', 'close ot', 'theme', 'incog'];
    for (const w of words) acts.forEach((a) => sw.searchScore(w, ...sw.actionFields(a))); // warm up
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) for (const w of words) acts.forEach((a) => sw.searchScore(w, ...sw.actionFields(a)));
    expect((performance.now() - t0) / (20 * words.length)).toBeLessThan(5);
  });
});

describe('quick answers', () => {
  it('a conversion shows its result big; Enter copies it with a note, Shift+Enter and the button the whole expression', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('10 km in mi');
    const row = tid('palette-row-quick');
    expect(sw.state.palette.items[0].kind).toBe('quick');
    expect(tid('palette-quick-value', row).textContent).toBe('6.21371 mi');
    expect(tid('palette-quick-expr', row).textContent).toContain(t('palQUnit'));
    expect(tid('palette-quick-expr', row).textContent).toContain('10 km = 6.21371 mi');
    key('Enter');
    await tick(10);
    expect(clipboard.writeText).toHaveBeenLastCalledWith('6.21371 mi');
    expect(toastText()).toBe(t('palCopied', { text: '6.21371 mi' }));
    expect(shown()).toBe(true); // stays: the note says it worked
    key('Enter', { shiftKey: true });
    await tick(10);
    expect(clipboard.writeText).toHaveBeenLastCalledWith('10 km = 6.21371 mi');
    const btn = tid('palette-copy-expr', row);
    expect(btn.tabIndex).toBe(-1); // for the mouse: the keyboard has Shift+Enter
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(10);
    expect(clipboard.writeText).toHaveBeenCalledTimes(3);
    expect(sw.state.palRecent).toEqual([]); // copying isn't an action
  });

  it('sums, colours (with a swatch), bases, days', async () => {
    await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('80 + 15%');
    expect(tid('palette-quick-value').textContent).toBe('92');
    expect(tid('palette-quick-expr').textContent).toContain(t('palQCalc'));
    await type('#ff8800');
    expect(tid('palette-quick-value').textContent).toBe('rgb(255, 136, 0)');
    expect(tid('palette-swatch').style.background).toMatch(/rgb\(255, 136, 0\)|#ff8800/);
    await type('255 in hex');
    expect(tid('palette-quick-value').textContent).toBe('0xFF');
    await type('days between 2026-01-01 and 2026-01-11');
    expect(tid('palette-quick-value').textContent).toBe(t('palDays', { count: 10 }));
  });

  it('currency: one disabled row saying why, and Enter does nothing', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await type('10 usd in eur');
    const row = tid('palette-row-currency');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain(t('palCurrency'));
    expect(row.textContent).toContain(t('palCurrencyWhy'));
    expect(sw.state.palette.hi).toBe(0);
    key('Enter');
    await tick(10);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(sw.state.done).toBe(false);
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
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, id);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url, windowId: 1, active: true });
    expect(closedMsg()).toMatchObject({ reason: 'switch' });
  });

  it('New tab, New window, New Incognito window, Reopen', async () => {
    let sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'new-tab');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ windowId: 1, active: true });
    expect(sw.state.done).toBe(true);
    for (const [id, call] of [['new-window', { focused: true }], ['incognito', { incognito: true, focused: true }]]) {
      sw = await boot({ tabs: ABC });
      key('k', { code: 'KeyK', ctrlKey: true });
      await runAction(sw, id);
      expect(chrome.windows.create).toHaveBeenLastCalledWith(call);
      expect(sw.state.done).toBe(true);
    }
    sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'reopen');
    expect(chrome.sessions.restore).toHaveBeenCalledWith();
    expect(closedMsg()).toMatchObject({ reason: 'restore' });
  });

  it('Incognito refused (turned off by policy): a clear note, and the palette stays', async () => {
    const sw = await boot({ tabs: ABC });
    chrome.windows.create.mockRejectedValueOnce(new Error('Incognito mode is disabled.'));
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'incognito');
    expect(toastText()).toBe(t('palErrIncognito'));
    expect(shown()).toBe(true);
    expect(sw.state.done).toBe(false);
  });

  it('Reopen with nothing to reopen says so', async () => {
    const sw = await boot({ tabs: ABC });
    chrome.sessions.restore.mockRejectedValueOnce(new Error('nothing'));
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'reopen');
    expect(toastText()).toBe(t('palErrReopen'));
    expect(sw.state.done).toBe(false);
  });
});

describe('actions on the current tab', () => {
  it('Reload reloads it and gives the page back', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'reload');
    expect(chrome.tabs.reload).toHaveBeenCalledWith(tabByTitle(sw, 'Alpha').id);
    expect(closedMsg()).toMatchObject({ reason: 'cancel' });
  });

  it('Duplicate, Pin, Mute: done, then the switcher shows the result', async () => {
    let sw = await boot({ tabs: ABC });
    const a = tabByTitle(sw, 'Alpha');
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'duplicate');
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://alpha.example/', index: a.index + 1, active: false }));
    expect(shown()).toBe(false);
    expect(sw.state.done).toBe(false);
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(titleIn(rowOf('pin'))).toBe(t('pinThis'));
    await runAction(sw, 'pin');
    expect(live(a.id).pinned).toBe(true);
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(titleIn(rowOf('pin'))).toBe(t('unpinThis'));
    await runAction(sw, 'mute');
    expect(live(a.id).mutedInfo.muted).toBe(true);
    expect(toastText()).toBe(t('mutedN', { count: 1 }));
    sw = null;
  });

  it('Close tab keeps the Undo; Close other tabs closes the rest of the window (not pinned ones), with Undo', async () => {
    const sw = await boot({ tabs: [...ABC, { title: 'Pinned', url: 'https://p.example/', pinned: true }] });
    const ids = chrome._data.tabs.map((x) => x.id);
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'close-others');
    expect(chrome.tabs.remove).toHaveBeenCalledWith([tabByTitle(sw, 'Bravo')?.id ?? ids[1], ids[2]]);
    expect(chrome._data.tabs.map((x) => x.title).sort()).toEqual(['Alpha', 'Pinned']);
    expect(shown()).toBe(false);
    expect(tid('toast-action').textContent).toContain(t('undo'));
  });

  it('Close tab closes it with Undo (in a popup window Tabazing stays)', async () => {
    const sw = await boot({ tabs: ABC });
    const a = tabByTitle(sw, 'Alpha');
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'close-tab');
    expect(chrome.tabs.remove).toHaveBeenCalledWith(a.id);
    expect(toastText()).toBe(t('closedN', { count: 1 }));
    expect(sw.state.undo.length).toBe(1);
  });

  it('Move to a new window, with Undo', async () => {
    const sw = await boot({ tabs: ABC });
    const a = tabByTitle(sw, 'Alpha');
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'move-window');
    expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: a.id, focused: false });
    expect(toastText()).toBe(t('movedN', { count: 1 }));
  });

  it('Zoom in / out / reset step through Chrome’s zoom levels; Shift+Enter stays in the palette', async () => {
    const sw = await boot({ tabs: ABC });
    const id = tabByTitle(sw, 'Alpha').id;
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'zoom-in', { shiftKey: true });
    expect(chrome.tabs.setZoom).toHaveBeenLastCalledWith(id, 1.1);
    expect(toastText()).toBe(t('palZoomed', { level: '110%' }));
    expect(shown()).toBe(true);
    await runAction(sw, 'zoom-in', { shiftKey: true });
    expect(chrome.tabs.setZoom).toHaveBeenLastCalledWith(id, 1.25);
    await runAction(sw, 'zoom-out', { shiftKey: true });
    expect(chrome.tabs.setZoom).toHaveBeenLastCalledWith(id, 1.1);
    await runAction(sw, 'zoom-reset');
    expect(chrome.tabs.setZoom).toHaveBeenLastCalledWith(id, 1);
    expect(closedMsg()).toMatchObject({ reason: 'cancel' }); // Enter: back to the page
    expect(sw.nextZoom(5, 1)).toBe(5);
    expect(sw.nextZoom(0.25, -1)).toBe(0.25);
    expect(sw.nextZoom(1.05, -1)).toBe(1);
  });

  it('a zoom Chrome refuses: a note, and the palette stays', async () => {
    const sw = await boot({ tabs: ABC });
    chrome.tabs.setZoom.mockRejectedValueOnce(new Error('Cannot zoom a chrome:// page'));
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'zoom-in');
    expect(toastText()).toBe(t('palErrZoom'));
    expect(sw.state.done).toBe(false);
  });

  it('Full screen on, and off when the window is in full screen', async () => {
    let sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(titleIn(rowOf('fullscreen'))).toBe(t('palFullscreenOn'));
    await runAction(sw, 'fullscreen');
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { state: 'fullscreen' });
    chrome._reset();
    chrome._addWindow({ id: 1, focused: true, state: 'fullscreen' });
    sw = await boot({ tabs: ABC, ctx: { state: 'fullscreen' } });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(titleIn(rowOf('fullscreen'))).toBe(t('palFullscreenOff'));
    await runAction(sw, 'fullscreen');
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { state: 'normal' });
  });

  it('Copy link and Copy title and link: copied, a note, and the palette stays', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'copy-link');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('https://alpha.example/');
    expect(toastText()).toBe(t('copiedN', { count: 1 }));
    await runAction(sw, 'copy-md');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('- [Alpha](https://alpha.example/)');
    expect(shown()).toBe(true);
  });

  it('Bookmark this page: once (a second time says it already is)', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'bookmark');
    expect(chrome.bookmarks.create).toHaveBeenCalledWith({ title: 'Alpha', url: 'https://alpha.example/' });
    expect(toastText()).toBe(t('palMarked', { title: 'Alpha' }));
    chrome.bookmarks.search.mockResolvedValueOnce([{ id: '9', url: 'https://alpha.example/' }]);
    await runAction(sw, 'bookmark');
    expect(chrome.bookmarks.create).toHaveBeenCalledTimes(1);
    expect(toastText()).toBe(t('palMarkedAlready'));
  });

  it('no tab actions until the current tab is known, and none that page can’t take', async () => {
    const sw = await boot({ tabs: [{ title: 'New Tab', url: 'chrome://newtab/' }] });
    const ids = sw.paletteActions().map((a) => a.id);
    expect(ids).toContain('reload');
    expect(ids).not.toContain('bookmark');
    expect(ids).not.toContain('archive');
    expect(ids).not.toContain('snooze');
  });
});

describe('Tabazing actions', () => {
  it('Close duplicates shows the duplicates view (to confirm, as its button does)', async () => {
    const sw = await boot({ tabs: [...ABC, { title: 'Alpha 2', url: 'https://alpha.example/' }] });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'dupes');
    expect(sw.state.dupesView).toBe(true);
    expect(shown()).toBe(false);
  });

  it('Merge windows pulls the other windows’ tabs in, with Undo', async () => {
    chrome._addWindow({ id: 1, focused: true });
    chrome._addTab({ windowId: 2, title: 'Far', url: 'https://far.example/' });
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'merge');
    expect(chrome.tabs.move).toHaveBeenCalled();
    expect(chrome._data.tabs.find((x) => x.title === 'Far').windowId).toBe(1);
    expect(toastText()).toBe(t('mergedN', { count: 1 }));
  });

  it('Sleep tabs not used for a week marks those (they sleep as Tabazing closes)', async () => {
    const old = Date.now() - 8 * 864e5;
    const sw = await boot({ tabs: [...ABC.map((x, i) => (i === 2 ? { ...x, lastAccessed: old } : x))] });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(tid('dd-sub', rowOf('sleep-old')).textContent).toBe(t('tabs', { count: 1 }));
    await runAction(sw, 'sleep-old');
    expect([...sw.state.toSleep]).toEqual([tabByTitle(sw, 'Charlie').id]);
  });

  it('Snooze this tab… opens the snooze choices; Archive this tab archives it', async () => {
    let sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'snooze');
    expect(shown()).toBe(false);
    expect(tids('menu-item').length).toBeGreaterThan(3);
    sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'archive');
    await waitFor(() => toastText() === t('archivedN', { count: 1 }));
  });

  it('Open the archive, Settings, Keyboard shortcuts, Replay the tour open their cards', async () => {
    for (const [id, testid] of [['open-archive', 'archive-overlay'], ['settings', 'settings'], ['keys', 'keys-popover'], ['tour', 'dialog']]) {
      const sw = await boot({ tabs: ABC });
      key('k', { code: 'KeyK', ctrlKey: true });
      await runAction(sw, id);
      await waitFor(() => tid(testid) && !tid(testid).hidden);
      expect(shown(), id).toBe(false);
      tids('settings').concat(tids('keys-popover'), tids('archive-overlay')).forEach((n) => n.remove());
    }
  });

  it('Theme and Sort change the setting (the current choice isn’t offered)', async () => {
    const sw = await boot({ tabs: ABC });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(actionIds()).not.toContain('theme-system');
    await runAction(sw, 'theme-light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    await waitFor(() => (chrome.storage.local._data.get(KEY.PREFS) || {}).theme === 'light');
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'sort-name');
    expect(sw.state.sort).toBe('name');
    await runAction(sw, 'theme-system').catch(() => {});
  });

  it('Capture all previews asks the background, as the camera button does', async () => {
    const sw = await boot({ tabs: ABC });
    chrome.runtime.sendMessage.mockImplementation(async (m) => (m.type === MSG.SWEEP ? { n: 2 } : undefined));
    key('k', { code: 'KeyK', ctrlKey: true });
    await runAction(sw, 'capture-all');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.SWEEP }));
    expect(sw.state.done).toBe(true);
  });

  it('Media: play/pause, next, previous act on what the player shows', async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.media = [{ tabId: tabByTitle(sw, 'Bravo').id, frameId: 0, title: 'Song', artist: '', site: 'bravo.example', playing: true, canPrev: true, canNext: true, kind: 'audio', t: Date.now(), tab: tabByTitle(sw, 'Bravo') }];
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(titleIn(rowOf('media-toggle'))).toBe(t('palMediaPause'));
    await runAction(sw, 'media-next', { shiftKey: true });
    await runAction(sw, 'media-prev', { shiftKey: true });
    await runAction(sw, 'media-toggle');
    expect(chrome.scripting.executeScript.mock.calls.map(([o]) => o.args[0])).toEqual(['nexttrack', 'previoustrack', 'pause']);
    expect(closedMsg()).toMatchObject({ reason: 'cancel' });
  });
});
