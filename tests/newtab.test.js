import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KEY, MSG, FRAME_MSG, LIMITS } from '../lib/constants.js';
import { t } from '../lib/translations.js';

// The New Tab page: newtab.js runs at import (top-level await), against newtab.html's own markup.
// Elements are found by data-testid only. Expected text comes from t(), so it holds in any dictionary state.
const BODY = readFileSync(resolve(process.cwd(), 'newtab.html'), 'utf8')
  .match(/<body[^>]*>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, '');
const OWN = `chrome-extension://${chrome.runtime.id}/`;
const DAY = 864e5;

const tid = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
const all = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// Each page load adds listeners to window and document; they are taken away after each test, so loads don't pile up.
const added = [];
const addWin = window.addEventListener, addDoc = document.addEventListener;
beforeEach(() => {
  window.addEventListener = function (...a) { added.push([window, a]); return addWin.apply(this, a); };
  document.addEventListener = function (...a) { added.push([document, a]); return addDoc.apply(this, a); };
});
afterEach(() => {
  window.addEventListener = addWin;
  document.addEventListener = addDoc;
  for (const [target, a] of added.splice(0)) target.removeEventListener(...a);
  if (window.__tabazingOverlay) window.__tabazingOverlay.cleanup();
  delete window.__tabazingHotkey;
  document.documentElement.className = '';
  delete document.hidden;
});

let tab;
async function open({ prefs, history, stars, hidden, shortcut } = {}) {
  const w = chrome._addWindow();
  tab = chrome._addTab({ windowId: w.id, url: 'chrome://newtab/', active: true });
  chrome.tabs.getCurrent = vi.fn(async () => structuredClone(tab));
  if (prefs) await chrome.storage.local.set({ [KEY.PREFS]: prefs });
  if (stars) await chrome.storage.local.set({ [KEY.STARS]: stars });
  if (hidden) await chrome.storage.local.set({ [KEY.NTP_HIDDEN]: hidden });
  if (history) chrome._data.history.push(...history);
  if (shortcut !== undefined) chrome.commands.getAll.mockResolvedValue([{ name: 'open-switcher', shortcut }]);
  document.body.innerHTML = BODY;
  chrome._clearListeners();
  vi.resetModules();
  const page = await import('../newtab.js');
  await flush();
  return page;
}
const visit = (url, visitCount, title = url, ago = DAY) => ({ url, title, visitCount, lastVisitTime: Date.now() - ago });
const fromBg = { id: chrome.runtime.id, url: OWN + 'background.js' };
const deliver = (msg, sender = fromBg) => {
  const respond = vi.fn();
  chrome.runtime.onMessage._emit(msg, sender, respond);
  return respond;
};
const submit = (text) => {
  tid('ntp-search').value = text;
  tid('ntp-search-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};
const tiles = () => all('ntp-tile-title').map((n) => n.textContent);

describe('the page', () => {
  it('is localized, titled "New Tab", with the search box named for screen readers', async () => {
    await open();
    expect(document.title).toBe(t('ntpTitle'));
    expect(tid('ntp-search').placeholder).toBe(t('ntpSearch'));
    expect(tid('ntp-search').getAttribute('aria-label')).toBe(t('ntpSearch'));
    expect(tid('ntp-top-heading').textContent).toBe(t('ntpMostVisited'));
    expect(document.documentElement.lang).toBe('en');
  });

  it('speaks the language chosen in Settings', async () => {
    await open({ prefs: { lang: 'es' } });
    const page = await import('../lib/translations.js'); // the page's copy, now in Spanish
    expect(document.documentElement.lang).toBe('es');
    expect(page.getLocale()).toBe('es');
    expect(document.title).toBe(page.t('ntpTitle'));
    expect(tid('ntp-stars-heading').textContent).toBe(page.t('starred'));
    expect(page.t('starred')).not.toBe(t('starred'));
  });

  it('uses the accent colour and the theme from Settings', async () => {
    await open({ prefs: { accent: '#FCA5A5', theme: 'light' } });
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#FCA5A5');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('dark theme: no html.light; system theme follows the OS', async () => {
    const page = await open({ prefs: { theme: 'dark' } });
    expect(document.documentElement.classList.contains('light')).toBe(false);
    const mm = globalThis.matchMedia;
    globalThis.matchMedia = vi.fn(() => ({ matches: true, addEventListener: () => {} }));
    try {
      await open({ prefs: { theme: 'system' } });
      expect(document.documentElement.classList.contains('light')).toBe(true);
    } finally { globalThis.matchMedia = mm; }
    page.applyTheme('dark');
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('follows a change of Settings while open', async () => {
    await open();
    await chrome.storage.local.set({ [KEY.PREFS]: { theme: 'light', lang: 'ru' } });
    await flush();
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.lang).toBe('ru');
  });
});

describe('the search box', () => {
  it('Enter on an address opens it in this tab', async () => {
    await open();
    submit('example.com/path');
    expect(chrome.tabs.update).toHaveBeenCalledWith(tab.id, { url: 'https://example.com/path' });
    submit('localhost:3000');
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(tab.id, { url: 'http://localhost:3000' });
  });

  it('Enter on anything else searches Google (the same as the switcher)', async () => {
    await open();
    submit('  how to cook rice ');
    expect(chrome.tabs.update).toHaveBeenCalledWith(tab.id, { url: 'https://www.google.com/search?q=how%20to%20cook%20rice' });
  });

  it('never runs a javascript: address, and does nothing when empty', async () => {
    const page = await open();
    expect(page.destination('javascript://%0Aalert(1)')).toMatch(/^https:\/\/www\.google\.com\/search\?q=/);
    expect(page.destination('   ')).toBeNull();
    submit('');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('Esc clears it', async () => {
    await open();
    const box = tid('ntp-search');
    box.value = 'abc';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(box.value).toBe('');
  });
});

describe('Most visited', () => {
  it('counts history per address over the last 90 days, most visited first, at most 8', async () => {
    const history = [
      visit('https://a.com/', 3, 'A'), visit('https://a.com', 4, 'A2', DAY / 2), visit('https://a.com/#top', 1, ''),
      visit('https://b.com/x', 6, 'B'),
      visit('https://old.com/', 99, 'Old', 91 * DAY),
      ...Array.from({ length: 10 }, (_, i) => visit(`https://s${i}.org/`, 2, 'S' + i, DAY * (i + 2))),
    ];
    await open({ history });
    expect(tiles()).toHaveLength(LIMITS.NTP_TILES);
    expect(tiles().slice(0, 4)).toEqual(['A2', 'B', 'S0', 'S1']); // a.com: 3 + 4 + 1 = 8; ties: the more recent first
    expect(tiles()).not.toContain('Old');
    expect(tid('ntp-top').hidden).toBe(false);
    const link = tid('ntp-tile-link');
    expect(link.getAttribute('href')).toBe('https://a.com'); // the variant visited most
    expect(tid('ntp-tile-favicon').src).toBe(OWN + '_favicon/?pageUrl=' + encodeURIComponent('https://a.com') + '&size=32');
    expect(tid('ntp-tile-favicon').alt).toBe('');
  });

  it('leaves out Tabazing\'s own pages, chrome:// and other non-web addresses', async () => {
    const page = await open();
    const out = page.mostVisited([
      visit(OWN + 'newtab.html', 50), visit(OWN + 'switcher.html', 50), visit('chrome://settings/', 50),
      visit('chrome-extension://other/x.html', 50), visit('file:///C:/a.txt', 50), visit('about:blank', 50),
      { url: 42 }, null, visit('https://ok.com/', 1, ''),
    ]);
    expect(out).toEqual([{ key: 'https://ok.com/', url: 'https://ok.com/', title: 'ok.com' }]); // no title: the site's name
  });

  it('nothing to show: the section is hidden', async () => {
    await open();
    expect(tid('ntp-top').hidden).toBe(true);
  });

  it('× removes a tile for good; the next one moves up; the focus stays on the tiles', async () => {
    await open({ history: [visit('https://a.com/', 9, 'A'), visit('https://b.com/', 5, 'B'), visit('https://c.com/', 1, 'C')] });
    const x = tid('ntp-tile-remove');
    expect(x.getAttribute('aria-label')).toBe(t('ntpRemove', { title: 'A' }));
    x.click();
    await flush();
    expect(tiles()).toEqual(['B', 'C']);
    expect((await chrome.storage.local.get(KEY.NTP_HIDDEN))[KEY.NTP_HIDDEN]).toEqual(['https://a.com/']);
    expect(document.activeElement).toBe(tid('ntp-tile-link'));
    expect(tid('ntp-status-text').textContent).toBe(t('ntpRemoved', { title: 'A' }));
  });

  it('Undo brings it back', async () => {
    await open({ history: [visit('https://a.com/', 9, 'A'), visit('https://b.com/', 5, 'B')] });
    tid('ntp-tile-remove').click();
    await flush();
    tid('ntp-undo').click();
    await flush();
    expect(tiles()).toEqual(['A', 'B']);
    expect((await chrome.storage.local.get(KEY.NTP_HIDDEN))[KEY.NTP_HIDDEN]).toEqual([]);
  });

  it('Delete on a focused tile removes it; the last one gone puts the focus in the search box', async () => {
    await open({ history: [visit('https://a.com/', 9, 'A')] });
    tid('ntp-tile-link').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await flush();
    expect(tiles()).toEqual([]);
    expect(tid('ntp-top').hidden).toBe(true);
    expect(document.activeElement).toBe(tid('ntp-search'));
  });

  it('removed addresses stay removed (variants too), newest first, and the list is capped', async () => {
    const page = await open({ history: [visit('https://a.com/#x', 9, 'A'), visit('https://b.com/', 5, 'B')], hidden: ['https://a.com/'] });
    expect(tiles()).toEqual(['B']);
    for (let i = 0; i < LIMITS.NTP_HIDDEN_MAX + 5; i++) await page.hide('https://x' + i + '.com/');
    const list = await page.getHidden();
    expect(list).toHaveLength(LIMITS.NTP_HIDDEN_MAX);
    expect(list[0]).toBe(`https://x${LIMITS.NTP_HIDDEN_MAX + 4}.com/`);
  });

  it('a plain click opens the tile in this tab; with Ctrl the link does what links do', async () => {
    await open({ history: [visit('https://a.com/', 9, 'A')] });
    const link = tid('ntp-tile-link');
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(chrome.tabs.update).toHaveBeenCalledWith(tab.id, { url: 'https://a.com/' });
    const ctrl = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    link.addEventListener('click', (e) => e.preventDefault(), { once: true }); // jsdom would navigate
    chrome.tabs.update.mockClear();
    link.dispatchEvent(ctrl);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('Starred', () => {
  it('shows the starred pages, newest first, without ×', async () => {
    const now = Date.now();
    await open({
      stars: {
        'https://old.com/': { u: 'https://old.com/', ti: 'Old', t: now - 5000 },
        'https://new.com/': { u: 'https://new.com/', ti: 'New', t: now },
        'chrome://x/': { u: 'chrome://x/', ti: 'Inner', t: now },
      },
    });
    expect(tid('ntp-stars').hidden).toBe(false);
    expect(all('ntp-star-title').map((n) => n.textContent)).toEqual(['New', 'Old']);
    expect(tid('ntp-star-remove')).toBeNull();
    expect(tid('ntp-star-link').getAttribute('href')).toBe('https://new.com/');
  });

  it('none: no row; a star added while open appears', async () => {
    await open();
    expect(tid('ntp-stars').hidden).toBe(true);
    await chrome.storage.local.set({ [KEY.STARS]: { 'https://a.com/': { u: 'https://a.com/', ti: 'A', t: Date.now() } } });
    await flush();
    expect(all('ntp-star-title').map((n) => n.textContent)).toEqual(['A']);
  });
});

describe('the shortcut hint', () => {
  it('says the shortcut Chrome has for opening the switcher, and how holding it works', async () => {
    await open({ shortcut: 'Alt+Q' });
    expect(tid('ntp-hint-key').textContent).toBe('Alt+Q');
    expect(tid('ntp-hint').textContent.startsWith(t('ntpHint', { key: 'Alt+Q' }))).toBe(true);
    expect(tid('ntp-hint-hold').textContent).toBe(t('ntpHintHold', { mod: 'Alt', letter: 'Q' }));
  });

  it('a changed shortcut, the Mac way of writing it', async () => {
    await open({ shortcut: '⌥⇧Y' });
    expect(tid('ntp-hint-key').textContent).toBe('⌥⇧Y');
    expect(tid('ntp-hint-hold').textContent).toBe(t('ntpHintHold', { mod: '⌥⇧', letter: 'Y' }));
  });

  it('unassigned: says so, names the in-page key, and offers to choose one', async () => {
    await open({ shortcut: '' });
    expect(tid('ntp-hint').textContent).toContain(t('ntpHintUnset', { key: 'Alt+Q' }));
    expect(tid('ntp-hint-hold')).toBeNull();
    tid('ntp-set-shortcut').click();
    expect(chrome.tabs.update).toHaveBeenCalledWith(tab.id, { url: 'chrome://extensions/shortcuts' });
  });
});

describe('keyboard and focus', () => {
  const keydown = (target, init) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

  it('typing anywhere on the page goes to the search box', async () => {
    await open();
    expect(document.activeElement).not.toBe(tid('ntp-search'));
    keydown(document.body, { key: 'g' });
    expect(document.activeElement).toBe(tid('ntp-search'));
  });

  it('not with Ctrl / Alt, not for keys like Tab, and Space still presses a focused button', async () => {
    await open({ history: [visit('https://a.com/', 9, 'A')] });
    keydown(document.body, { key: 'a', ctrlKey: true });
    keydown(document.body, { key: 'Tab' });
    const x = tid('ntp-tile-remove');
    x.focus();
    keydown(x, { key: ' ' });
    expect(document.activeElement).toBe(x);
  });

  it('a click on the empty page puts the focus in the search box', async () => {
    await open();
    tid('ntp-main').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(document.activeElement).toBe(tid('ntp-search'));
  });
});

describe('Alt+Q on this page (no content script runs here)', () => {
  const ev = (code, more = {}) => ({ isTrusted: true, code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...more });

  it('Alt+Q / Alt+W / Alt+E send the same message as hotkey.js', async () => {
    const page = await open();
    page.onHotkey(ev('KeyQ'));
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: MSG.HOTKEY, dir: -1, hold: true });
    page.onHotkey(ev('KeyW'));
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: MSG.HOTKEY, dir: 1, hold: true });
    page.onHotkey(ev('KeyQ', { shiftKey: true }));
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: MSG.HOTKEY, dir: 1, hold: true });
    const e = ev('KeyE');
    page.onHotkey(e);
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: MSG.HOTKEY, dir: 0, hold: false });
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('ignores synthetic presses, repeats, other keys and other modifiers', async () => {
    const page = await open();
    page.onHotkey(ev('KeyQ', { isTrusted: false }));
    page.onHotkey(ev('KeyQ', { repeat: true }));
    page.onHotkey(ev('KeyZ'));
    page.onHotkey(ev('KeyQ', { ctrlKey: true }));
    page.onHotkey(ev('KeyQ', { altKey: false }));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('Alt+R (⌥R) asks for the command palette, like hotkey.js; not untrusted, repeated or with other keys', async () => {
    const page = await open();
    const r = (more) => ev('KeyR', { altKey: true, ...more });
    const e = r({});
    page.onHotkey(e);
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith({ type: MSG.HOTKEY, dir: 0, hold: false, palette: true });
    expect(e.preventDefault).toHaveBeenCalled();
    for (const bad of [r({ isTrusted: false }), r({ repeat: true }), r({ altKey: false }), r({ shiftKey: true }), r({ ctrlKey: true }), r({ metaKey: true })]) page.onHotkey(bad);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('retries once when the worker was asleep', async () => {
    const page = await open();
    chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist.'));
    await page.sendHotkey(-1, true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('tells the overlay host whether Alt is held', async () => {
    const page = await open();
    expect(window.__tabazingHotkey.altState()).toBe('unknown');
    page.onAlt({ isTrusted: true, key: 'Alt', type: 'keydown' });
    expect(window.__tabazingHotkey.altState()).toBe('down');
    page.onAlt({ isTrusted: true, key: 'Alt', type: 'keyup' });
    expect(window.__tabazingHotkey.altState()).toBe('up');
  });
});

describe('the switcher over this page', () => {
  const frame = () => tid('overlay-frame');

  it('prepares an invisible switcher frame on load, on the switcher page', async () => {
    const page = await open();
    expect(frame()).not.toBeNull();
    expect(frame().src.startsWith(page.SWITCHER_URL + '?standby=')).toBe(true);
    expect(frame().inert).toBe(true);
    expect(frame().getAttribute('aria-label')).toBe(t('overlayLabel'));
  });

  it('"always in its own window": nothing is prepared', async () => {
    await open({ prefs: { ownWindow: true } });
    expect(frame()).toBeNull();
  });

  it('prepares it again when the tab is shown after its frame was dropped', async () => {
    await open();
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 0));
    window.__tabazingOverlay.cleanup(); // what the host does after STANDBY_DROP_MS hidden
    expect(frame()).toBeNull();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frame()).not.toBeNull();
  });

  it('a launch from the background for this tab shows it, with the token posted to the extension origin', async () => {
    const page = await open();
    const post = vi.spyOn(frame().contentWindow, 'postMessage').mockImplementation(() => {});
    const respond = deliver({ type: MSG.NTP_LAUNCH, tabId: tab.id, token: 'tok', hold: true });
    expect(respond).toHaveBeenCalledWith({ ok: true });
    expect(window.__tabazingOverlay.active).toBe(true);
    window.dispatchEvent(new MessageEvent('message', { data: { tabazing: FRAME_MSG.STANDBY }, source: frame().contentWindow }));
    expect(post).toHaveBeenCalledWith({ tabazing: FRAME_MSG.LAUNCH, token: 'tok' }, page.EXT_ORIGIN);
  });

  it('launches for another tab, from a tab (a content script or the switcher), or malformed, are ignored without an answer', async () => {
    await open();
    const senders = [
      { ...fromBg, tab: { id: 9 } },
      { id: chrome.runtime.id, url: OWN + 'switcher.html', tab },
      { id: 'otherextensionotherextensionabcd', url: 'chrome-extension://otherextensionotherextensionabcd/background.js' },
      { id: chrome.runtime.id, url: OWN + 'sweep.html' },
    ];
    for (const s of senders) expect(deliver({ type: MSG.NTP_LAUNCH, tabId: tab.id, token: 'tok' }, s)).not.toHaveBeenCalled();
    expect(deliver({ type: MSG.NTP_LAUNCH, tabId: tab.id + 1, token: 'tok' })).not.toHaveBeenCalled();
    expect(deliver({ type: MSG.NTP_LAUNCH, tabId: tab.id, token: 5 })).not.toHaveBeenCalled();
    expect(deliver({ type: MSG.CYCLE, dir: 1 })).not.toHaveBeenCalled(); // that one is the open switcher's to answer
    expect(window.__tabazingOverlay.active).toBe(false);
  });

  it('NTP_DROP from the background takes the overlay away', async () => {
    await open();
    deliver({ type: MSG.NTP_LAUNCH, tabId: tab.id, token: 'tok' });
    deliver({ type: MSG.NTP_DROP, tabId: tab.id });
    expect(frame()).toBeNull();
    expect(window.__tabazingOverlay).toBeUndefined();
  });

  it('closing the switcher gives the focus back to the search box', async () => {
    await open();
    deliver({ type: MSG.NTP_LAUNCH, tabId: tab.id, token: 'tok' });
    const src = frame().contentWindow;
    window.dispatchEvent(new MessageEvent('message', { data: { tabazing: FRAME_MSG.READY }, source: src }));
    window.dispatchEvent(new MessageEvent('message', { data: { tabazing: FRAME_MSG.CLOSE }, source: src }));
    expect(window.__tabazingOverlay.active).toBe(false);
    expect(document.activeElement).toBe(tid('ntp-search'));
  });

  it('a CLOSE from anything but the switcher frame does not move the focus', async () => {
    await open();
    window.dispatchEvent(new MessageEvent('message', { data: { tabazing: FRAME_MSG.CLOSE }, source: window }));
    expect(document.activeElement).not.toBe(tid('ntp-search'));
  });
});
