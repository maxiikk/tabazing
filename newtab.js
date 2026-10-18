// Tabazing's New Tab page (manifest.json chrome_url_overrides). Chrome lets no extension draw on its own New
// Tab page, so there the switcher could only open in a window of its own; on this page it opens over the page,
// as on any website. The page itself: a search box (an address opens, anything else is searched on Google),
// "Most visited" from this browser's history, the starred pages, and how to open the switcher.
// Nothing here goes over the network (the CSP has connect-src 'none'); favicons come from Chrome's cache.
//
// Trust: this page is an extension page in a tab. It takes orders (show the switcher) only from the
// background worker, only for its own tab; the background in turn accepts only "open the switcher" from it.
import { MSG, KEY, FRAME_MSG, LIMITS, SWITCHER_PAGE } from './lib/constants.js';
import { setLang, localizePage } from './lib/i18n.js';
import { t } from './lib/translations.js';
import { applyAccent } from './lib/accent.js';
import { getPrefs, getStars } from './lib/store.js';
import { isOwnUrl, normalizeUrl } from './lib/ext.js';
import { asUrl, googleUrl } from './lib/web.js';
import { overlayHost, removeOverlay } from './lib/overlay-host.js';

const $ = (id) => document.getElementById(id);
const el = {
  main: $('main'), form: $('search-form'), search: $('search'), top: $('top'), tiles: $('tiles'),
  stars: $('stars'), starList: $('star-list'), status: $('status'), hint: $('hint'),
};
const IS_MAC = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
const favicon = (url) => chrome.runtime.getURL('/_favicon/') + '?pageUrl=' + encodeURIComponent(url) + '&size=32';
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

// ---- settings: language, accent colour, theme (the switcher's, so it looks the same over this page)
const lightMq = matchMedia('(prefers-color-scheme: light)');
let themePref = 'system';
function applyTheme(v) {
  themePref = ['light', 'dark'].includes(v) ? v : 'system';
  document.documentElement.classList.toggle('light', themePref === 'light' || (themePref === 'system' && lightMq.matches));
}
lightMq.addEventListener('change', () => applyTheme(themePref));

let prefs = {};
async function applyPrefs() {
  prefs = await getPrefs().catch(() => ({}));
  setLang(prefs.lang || 'auto');
  applyAccent(prefs.accent);
  applyTheme(prefs.theme);
  localizePage();
  document.title = t('ntpTitle');
  return prefs;
}

// ---- the search box
// What Enter opens for `text`: the address it looks like, or a Google search. Never a javascript: or data:
// address (those would run in this tab, not open a page).
function destination(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const url = asUrl(s);
  return url && !/^(javascript|data|vbscript):/i.test(url) ? url : googleUrl(s);
}
// Open `url` in this tab. Through the tabs API, as chrome:// and file:// addresses can't be opened by the page itself.
function go(url) {
  return (Number.isInteger(myTabId) ? chrome.tabs.update(myTabId, { url }) : chrome.tabs.update({ url }))
    .catch((e) => console.warn('[Tabazing] could not open', url, e && e.message));
}
el.form.addEventListener('submit', (e) => {
  e.preventDefault(); // the CSP (form-action 'none') would block a real submit anyway
  const url = destination(el.search.value);
  if (url) go(url);
});
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.search.value) { e.preventDefault(); el.search.value = ''; }
});

// ---- "Most visited"
// The addresses visited most in the last NTP_HISTORY_DAYS days: history items counted together per address
// (normalizeUrl: https://a.com/, https://a.com and https://a.com/#x are one), web pages only (not Tabazing's
// own pages, chrome:// and the like), less the ones the user removed. Ties: the more recent first.
function mostVisited(items, hidden = [], n = LIMITS.NTP_TILES) {
  const skip = new Set(hidden);
  const by = new Map();
  for (const it of items || []) {
    const url = it && it.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || isOwnUrl(url)) continue;
    const key = normalizeUrl(url);
    if (!key || skip.has(key)) continue;
    const count = Number.isFinite(it.visitCount) ? Math.max(0, it.visitCount) : 0;
    const last = Number.isFinite(it.lastVisitTime) ? it.lastVisitTime : 0;
    const title = typeof it.title === 'string' ? it.title.trim() : '';
    const e = by.get(key);
    if (!e) { by.set(key, { key, url, title, count, last, most: count, titleAt: title ? last : -1 }); continue; }
    e.count += count;
    if (count > e.most) { e.most = count; e.url = url; } // the variant visited most is the one opened
    if (title && last > e.titleAt) { e.title = title; e.titleAt = last; } // the newest title
    e.last = Math.max(e.last, last);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, n)
    .map(({ key, url, title }) => ({ key, url, title: title || hostOf(url) }));
}

// Removed tiles: normalized addresses in storage.local, newest first, at most NTP_HIDDEN_MAX.
async function getHidden() {
  const v = (await chrome.storage.local.get(KEY.NTP_HIDDEN))[KEY.NTP_HIDDEN];
  return Array.isArray(v) ? v.filter((k) => typeof k === 'string' && k) : [];
}
async function setHidden(fn) {
  const list = fn(await getHidden()).slice(0, LIMITS.NTP_HIDDEN_MAX);
  await chrome.storage.local.set({ [KEY.NTP_HIDDEN]: list });
}
const hide = (key) => setHidden((h) => [key, ...h.filter((k) => k !== key)]);
const unhide = (key) => setHidden((h) => h.filter((k) => k !== key));

async function loadTiles() {
  const [items, hidden] = await Promise.all([
    chrome.history.search({ text: '', startTime: Date.now() - LIMITS.NTP_HISTORY_DAYS * 864e5, maxResults: 5000 }).catch(() => []),
    getHidden().catch(() => []),
  ]);
  renderTiles(mostVisited(items, hidden));
}

// One tile: a link (keyboard and middle-click work as on any link) with the site's icon and title.
function tile(entry, kind, removable) {
  const li = document.createElement('li');
  li.className = 'tile';
  li.dataset.testid = kind;
  const a = document.createElement('a');
  a.className = 'tlink';
  a.href = entry.url;
  a.title = entry.title === entry.url ? entry.url : entry.title + '\n' + entry.url;
  a.dataset.testid = kind + '-link';
  a.dataset.key = entry.key;
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.dataset.testid = kind + '-icon';
  const img = document.createElement('img');
  img.src = favicon(entry.url);
  img.alt = '';
  img.dataset.testid = kind + '-favicon';
  ico.append(img);
  const name = document.createElement('span');
  name.className = 'tname';
  name.textContent = entry.title;
  name.dataset.testid = kind + '-title';
  a.append(ico, name);
  // A plain click opens it through the tabs API (go), like Enter in the search box; with a modifier the link does what links do.
  a.addEventListener('click', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(entry.url);
  });
  li.append(a);
  if (removable) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.textContent = '×';
    x.setAttribute('aria-label', t('ntpRemove', { title: entry.title }));
    x.title = x.getAttribute('aria-label');
    x.dataset.testid = kind + '-remove';
    x.addEventListener('click', () => removeTile(entry));
    // Delete on the focused tile removes it too.
    a.addEventListener('keydown', (e) => { if (e.key === 'Delete') { e.preventDefault(); removeTile(entry); } });
    li.append(x);
  }
  return li;
}

function renderTiles(list) {
  el.tiles.replaceChildren(...list.map((e) => tile(e, 'ntp-tile', true)));
  el.top.hidden = !list.length;
}

// Removing a tile: remembered, the next site moves up, and "Removed ... Undo" is said (role=status) for a while.
// The keyboard focus stays where it was: on the tile that took its place (or the search box when none is left).
let statusTimer = null;
async function removeTile(entry) {
  const at = [...el.tiles.children].findIndex((li) => li.querySelector('a').dataset.key === entry.key);
  await hide(entry.key);
  await loadTiles();
  const links = el.tiles.querySelectorAll('a');
  (links[Math.min(at, links.length - 1)] || el.search).focus();
  say(t('ntpRemoved', { title: entry.title }), async () => { await unhide(entry.key); await loadTiles(); });
}
function say(text, undo) {
  clearTimeout(statusTimer);
  const span = document.createElement('span');
  span.textContent = text;
  span.dataset.testid = 'ntp-status-text';
  const parts = [span];
  if (undo) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t('ntpUndo');
    b.dataset.testid = 'ntp-undo';
    b.addEventListener('click', () => { el.status.replaceChildren(); undo().then(() => el.search.focus()); });
    parts.push(b);
  }
  el.status.replaceChildren(...parts);
  // Gone after a while, but not while the keyboard is on Undo.
  statusTimer = setTimeout(function clear() {
    if (el.status.contains(document.activeElement)) statusTimer = setTimeout(clear, 2000);
    else el.status.replaceChildren();
  }, 10000);
}

// ---- starred pages (Alt+S in the switcher), newest first
async function loadStars() {
  const stars = await getStars().catch(() => ({}));
  const list = Object.entries(stars)
    .filter(([, s]) => typeof s.u === 'string' && /^(https?|file):/i.test(s.u))
    .sort(([, a], [, b]) => (b.t || 0) - (a.t || 0))
    .map(([key, s]) => ({ key, url: s.u, title: s.ti || hostOf(s.u) }));
  el.starList.replaceChildren(...list.map((e) => tile(e, 'ntp-star', false)));
  el.stars.hidden = !list.length;
}

// ---- the shortcut hint: Chrome's actual shortcut for "open the switcher", or, when it has none, the in-page
// one (this page listens for it itself, below) and a way to choose one.
const MARK = '\u0001';
// "text {key} text" with the key in a <kbd>.
function withKey(text, key, testid) {
  const k = document.createElement('kbd');
  k.textContent = key;
  k.dataset.testid = testid;
  const [before, after] = text.split(MARK);
  return [before || '', k, after || ''];
}
async function renderHint() {
  const cmds = await chrome.commands.getAll().catch(() => []);
  const cmd = cmds.find((c) => c.name === 'open-switcher');
  const shortcut = cmd && cmd.shortcut;
  if (!shortcut) {
    const key = IS_MAC ? 'Option+Q' : 'Alt+Q';
    const set = document.createElement('button');
    set.type = 'button';
    set.textContent = t('ntpSetShortcut');
    set.dataset.testid = 'ntp-set-shortcut';
    set.addEventListener('click', () => go('chrome://extensions/shortcuts'));
    el.hint.replaceChildren(...withKey(t('ntpHintUnset', { key: MARK }), key, 'ntp-hint-key'), set);
    return;
  }
  // "Alt+Q" on Windows and Linux, "⌥Q" on a Mac: the modifiers, then the key.
  const parts = shortcut.includes('+') ? shortcut.split('+') : [...shortcut];
  const letter = parts.pop();
  const mod = parts.join(shortcut.includes('+') ? '+' : '');
  const nodes = withKey(t('ntpHint', { key: MARK }), shortcut, 'ntp-hint-key');
  if (mod) {
    // Alt+Q works like Alt+Tab: held, it steps through the tabs; letting go switches.
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.dataset.testid = 'ntp-hint-hold';
    sub.textContent = t('ntpHintHold', { mod, letter });
    nodes.push(sub);
  }
  el.hint.replaceChildren(...nodes);
}

// ---- keyboard: typing anywhere on the page goes into the search box; a click on the empty page puts the focus there.
// (Chrome gives a new tab's focus to the address bar, and no page can take it from there: only once the user is
// on the page.)
const typingIn = (n) => !!n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
function onPageKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || typingIn(e.target)) return;
  if (e.key.length !== 1 || (e.key === ' ' && e.target !== document.body)) return; // Space still presses buttons and links
  el.search.focus({ preventScroll: true }); // the key itself then lands in the box
}
window.addEventListener('keydown', onPageKey);
document.addEventListener('click', (e) => {
  if (e.button === 0 && !e.target.closest('a, button, input, [role="status"]')) el.search.focus({ preventScroll: true });
});

// ---- Alt+Q / Alt+W / Alt+E and Ctrl+Shift+Space (the command palette) on this page, when Chrome's shortcut is not assigned (on web pages hotkey.js does
// this; no content script runs on extension pages). The same message, and the same "is Alt held?" the overlay
// host reads (window.__tabazingHotkey.altState) to tell a quick tap from a hold.
const HOTKEYS = { KeyQ: [-1, true], KeyW: [1, true], KeyE: [0, false] };
let altDown = false;
let altAt = 0;
const altState = () => (Date.now() - altAt > 10000 ? 'unknown' : altDown ? 'down' : 'up');
function onAlt(e) {
  if (!e.isTrusted || e.key !== 'Alt') return;
  altDown = e.type === 'keydown';
  altAt = Date.now();
}
function onHotkey(e) {
  if (!e.isTrusted || e.repeat) return;
  const palette = e.code === 'Space' && e.shiftKey && !e.altKey && e.ctrlKey !== e.metaKey; // Ctrl+Shift+Space (⌘⇧Space)
  if (!palette && (!HOTKEYS[e.code] || !e.altKey || e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (palette) return sendHotkey(0, false, true);
  const [dir, hold] = HOTKEYS[e.code];
  sendHotkey(e.shiftKey && dir ? -dir : dir, hold);
}
// The worker may be asleep: if the first try finds nobody listening, once more a moment later (as hotkey.js).
function sendHotkey(dir, hold, palette = false) {
  const msg = palette ? { type: MSG.HOTKEY, dir: 0, hold: false, palette: true } : { type: MSG.HOTKEY, dir, hold };
  return chrome.runtime.sendMessage(msg).catch(() => new Promise((r) => setTimeout(r, 50))
    .then(() => chrome.runtime.sendMessage(msg)).catch(() => {}));
}
window.addEventListener('keydown', onHotkey, true);
window.addEventListener('keydown', onAlt, true);
window.addEventListener('keyup', onAlt, true);
window.addEventListener('blur', () => { altAt = 0; }, true);
window.__tabazingHotkey = { alive: () => true, onKey: onHotkey, onAlt, altState };

// ---- the switcher over this page: the same overlay host background.js injects into web pages, run here
// by the page itself (lib/overlay-host.js). Prepared ahead (invisible) so Alt+Q opens it at once.
const SWITCHER_URL = chrome.runtime.getURL(SWITCHER_PAGE);
const EXT_ORIGIN = `chrome-extension://${chrome.runtime.id}`; // where the switcher frame runs: the token goes there only
function host(mode, token = null, hold = false) {
  overlayHost(SWITCHER_URL, EXT_ORIGIN, FRAME_MSG, mode, token, hold, LIMITS.STANDBY_DROP_MS, t('overlayLabel'));
}
// Settings -> "always in its own window": nothing to prepare here.
const prepare = () => { if (!prefs.ownWindow && !document.hidden) host('standby'); };
// The overlay host drops its prepared frame when the tab has been hidden a while: prepare it again when it's back.
document.addEventListener('visibilitychange', () => { if (!document.hidden) prepare(); });

// Only the background worker gives orders: our own extension (no other can send here), not from a tab (content
// scripts and the switcher are in one), and, when Chrome says where from, from background.js.
const fromBackground = (s) => !!s && s.id === chrome.runtime.id && !s.tab && (s.url === undefined || isOwnUrl(s.url, 'background.js'));
let myTabId = null;
function onMessage(msg, sender, respond) {
  // Every New Tab page gets these: only the one in the tab they name answers (the first answer is the one that counts).
  if (!msg || !fromBackground(sender) || !Number.isInteger(myTabId) || msg.tabId !== myTabId) return;
  if (msg.type === MSG.NTP_LAUNCH && typeof msg.token === 'string') {
    // The host gives the focus back to what had it when the switcher opened: the search box, where one types next.
    el.search.focus({ preventScroll: true });
    host('launch', msg.token, msg.hold === true);
    respond({ ok: true });
  } else if (msg.type === MSG.NTP_DROP) removeOverlay();
}

// ---- boot
await applyPrefs();
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  if (c[KEY.PREFS]) applyPrefs().then(() => { renderHint(); loadTiles(); loadStars(); if (prefs.ownWindow) removeOverlay(); else prepare(); });
  else if (c[KEY.STARS]) loadStars();
});
await Promise.all([loadTiles().catch(() => {}), loadStars(), renderHint()]);
// The tab id first, then the listener: a page that doesn't know its tab yet can't tell whose launch it is, and
// must not keep the background waiting for an answer.
myTabId = await Promise.resolve().then(() => chrome.tabs.getCurrent()).then((tb) => (tb ? tb.id : null), () => null);
chrome.runtime.onMessage.addListener(onMessage);
prepare();

// For the unit tests (tests/newtab.test.js). Nothing imports this page.
export {
  el, applyTheme, applyPrefs, destination, go, mostVisited, getHidden, hide, unhide, loadTiles, renderTiles, removeTile,
  loadStars, renderHint, onPageKey, onHotkey, onAlt, altState, sendHotkey, host, prepare, fromBackground, onMessage,
  SWITCHER_URL, EXT_ORIGIN,
};
