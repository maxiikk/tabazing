// Tabazing switcher UI. Runs as an extension page, either in an iframe on
// top of the current web page (mode "overlay") or in a small popup window on
// pages extensions can't touch (mode "window").
//
// Data flow: load() reads tabs/windows/sessions + stored previews once ->
// derive() builds the visible, selectable `entries` from state + filters ->
// render() draws them. Every user action updates state and calls refresh().
//
// Security: in overlay mode this page is embedded in an untrusted web page.
// The page can't read our DOM or storage, but it CAN see and restyle the
// <iframe> element (e.g. make it invisible and trick you into clicking). So:
//   - nothing runs until the one-time launch token checks out. In a popup
//     window it's in our URL; in an overlay it arrives by postMessage from
//     the content script, so the page never sees it;
//   - mouse clicks only count while the overlay is fully visible and
//     unobstructed (IntersectionObserver v2); if the page hides or covers it,
//     action keys close it instead of acting on something you can't see;
//   - all page-provided text (titles, URLs) is rendered with textContent.

import { MSG, KEY, FRAME_MSG, LIMITS, REVIEW_URL, siteUrl } from './lib/constants.js';
import { getNoCapture, getMru, getPreviews, getClosedLog, getSlept, consumeLaunch, getReview, updateReview, getOnboard, updateOnboard, getCaptureNote, getStars, toggleStar, getNotes, setNote, getSharpPreview, getSnoozed, addSnoozed, removeSnoozed, getView, updateView, setResume, takeResume, getPrefs, updatePrefs } from './lib/store.js';
import { reviewPrompt, dayOf } from './lib/review.js';
import { t, tn, timeAgo, localizePage, loadLang, setLang, uiLang } from './lib/i18n.js';
import { isOwnUrl, normalizeUrl, isWorthReopening, isCapturableUrl } from './lib/ext.js';
import { applyAccent, ACCENTS } from './lib/accent.js';
import { archiveFolder, getArchived, addArchived, removeArchived } from './lib/archive.js';

let CTX = null; // set once the launch token has been verified (see boot)

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), bar: document.querySelector('.bar'), search: $('search'), count: $('count'),
  wins: $('wins'), tools: $('tools'), scroller: $('scroller'), newtab: $('newtab'),
  starFilter: $('star-filter'), starN: $('star-n'), qfilters: $('qfilters'), mergeBtn: $('merge-btn'), mergeText: $('merge-text'),
  snoozedSection: $('snoozed-section'), snoozedGrid: $('snoozed-grid'), sort: $('sort'), sweepText: $('sweep-text'), closedH: $('closed-h'),
  openGrid: $('open-grid'), openEmpty: $('open-empty'),
  closedSection: $('closed-section'), closedGrid: $('closed-grid'),
  winHint: $('hint-win'),
  sweepBtn: $('sweep-btn'),
  dupesBtn: $('dupes-btn'), dupesText: $('dupes-text'),
  alert: $('alert'), alertText: $('alert-text'), alertBtn: $('alert-btn'),
  acts: $('acts'), actsN: $('acts-n'), actsBtns: $('acts-btns'), selAll: $('sel-all'), selNone: $('sel-none'),
  body: $('body'),
  toast: $('toast'), clip: $('clip'), modal: $('modal'), dialog: $('dialog'),
};

// Mac keyboards: Option instead of Alt, and the "delete" key is Backspace.
const IS_MAC = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');

// -------------------------------------------------------------------- state
const state = {
  tabs: [],        // chrome.tabs.Tab[], most recently used first
  previews: {},    // tabId -> { img, url, t }
  closed: [],      // every closed tab/window we know of, newest first: [{ id, kind: 'tab'|'window', url, title, ts, count, session, fields, preview }]
  windows: [],     // [{ id, label, count, activeTitle }]
  scope: 'all',    // 'all' or a windowId
  query: '',
  entries: [],     // derived: [{ kind: 'tab'|'closed', key, tab?, item?, preview }]
  openCount: 0,
  sel: 0,
  holding: false,  // Alt still held from Alt+Q / Alt+W? They work like Alt+Tab: letting go of Alt switches
  done: false,
  mouseReady: false,
  cardW: 320,      // current open-card width (px), set by render()
  slept: new Set(), // ids of tabs we saw Chrome discard in this browser session
  sections: [],    // derived: [{ key, title, entries }] for the open tabs (one plain list, or one per page in the duplicates view)
  mruOrder: [],    // derived: open entries in most-recently-used order (what Alt+Q cycles through)
  savedCount: 0,
  hostOk: true,   // does Tabazing have access to all sites (not withheld by Chrome's Site access setting)?
  armed: null,     // key of a quick action waiting for a second click
  modal: null,     // 'tour' | 'ask' while a dialog is open
  sort: 'recent',  // the Sort dropdown: 'recent' | 'order' | 'name' (Alt+Q always cycles by recent use)
  cardSize: 'default', // Settings: 'default' | 'small' | 'list' cards
  starOnly: false, // the Starred filter is on
  stars: {},       // normalized URL -> { u, ti, t } starred pages
  notes: {},       // normalized URL -> { u, n, t } notes on tabs
  allWindows: false, // Settings: show the tabs of every window (else only the one Tabazing was opened in)
  otherWindows: [], // ids of the other normal windows ("Merge" pulls their tabs in)
  filter: null,    // quick filter: null | 'audio' | 'pinned' | 'asleep' | 'note'
  snoozed: [],     // [{ id, url, title, at, windowId, pinned }] closed for now, reopened later
  snoozePreviews: {}, // normalized URL -> preview, for the snoozed section
  snoozeCount: 0,  // derived: snoozed cards shown (they follow the open tabs in state.entries)
  marks: null,     // the bookmarks, flat: [{ title, url, path }] (read on the first search)
  found: [],       // derived: open tabs matching the search, best first (the dropdown)
  history: null,   // recent history (90 days), read on the first search: [{ url, title, t, n }]
  histQ: { q: '', items: [] }, // Chrome's own history search for the current text (reaches further back)
  foundClosed: [], // derived: recently closed tabs matching the search (the dropdown)
  dd: { items: [], hi: 0, hidden: false }, // the dropdown under the search box: rows, the highlighted one
  collapsed: new Set(), // section keys the user collapsed (kept between opens)
  peek: new Set(),      // collapsed sections opened for this visit only (Alt+Q landed on a tab inside)
  capturing: null,      // tab id whose preview is being captured from its card
  starPreviews: {},     // normalized URL -> preview, for starred pages that aren't open
  matchCount: 0,        // open tabs that match the filters, collapsed or not
  picked: new Set(),    // tab ids ticked for a quick action (close, copy, move...)
  undo: [],             // what was closed here, last at the end: [[{ url, windowId, index, pinned }]] (Ctrl+Z)
  lastPick: null,       // the last card ticked, for Shift+click ranges
  nocap: new Set(),     // pages Chrome refused to screenshot: no "Capture preview" there
  toSleep: new Set(),   // tab ids to unload when the switcher closes
  dupesView: false,     // showing only the duplicate copies, before closing them
  matches: [],          // derived: the open tabs the filters let through
  archived: null,       // the "Tabs Archive" bookmarks folder: [{ id, url, title, t }] newest first (lib/archive.js)
  archivePreviews: {},  // normalized URL -> preview, for archived pages
  archSel: 0,           // the selected card in the archive overlay
};

// ---------------------------------------------------------------- icons
const ICON = {
  moon: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13.5 10.2A5.8 5.8 0 0 1 5.8 2.5a5.8 5.8 0 1 0 7.7 7.7Z" fill="currentColor"/></svg>',
  history: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.8h2.8M8 5v3.2l2.2 1.4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  speaker: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.3 3.8a6 6 0 0 1 0 8.4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  camera: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2.5 5.5h2.2l1.2-1.8h4.2l1.2 1.8h2.2v7h-11z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/><circle cx="8" cy="8.8" r="2" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  window: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M2 6h12" stroke="currentColor" stroke-width="1.3"/></svg>',
  star: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="var(--star-fill, none)"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  windows: '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><rect x="1.5" y="4" width="9" height="8" rx="1.3" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5.5 4V2.8a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-3" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  more: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="12.5" cy="8" r="1.4" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  note: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 2.5h10v7l-4 4H3z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/><path d="M9 13.5v-4h4M5.5 5.5h5M5.5 7.5h3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 5.5v3.2l2 1.3M5 1.8 3 3.4M11 1.8l2 1.6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  merge: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 3.5h6.5M3 8h10M3 12.5h6.5M10.5 5.5 13 8l-2.5 2.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  link: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.8.8M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.8-.8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  md: '<svg viewBox="0 0 16 16" width="15" height="13" aria-hidden="true"><rect x="1" y="3.5" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M3.5 10V6l1.8 2 1.8-2v4M10.5 6v4M9 8.5l1.5 1.5L12 8.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6 2.5h4l-.6 4 2.6 2.5H4l2.6-2.5zM8 9v4.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  reload: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13.2 8.2A5.2 5.2 0 1 1 11.6 4.4M13.2 2.4v3.2H10" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dupe: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  muted: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor"/><path d="M10.5 6l4 4M14.5 6l-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  archive: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.8 3h12.4v3H1.8zM2.8 6v7h10.4V6M6.3 8.6h3.4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ---------------------------------------------------------------- helpers
const urlOf = (tab) => (tab && (tab.url || tab.pendingUrl)) || '';
const favicon = (url) => chrome.runtime.getURL('/_favicon/') + '?pageUrl=' + encodeURIComponent(url) + '&size=32';
function hostOf(url) {
  try { const u = new URL(url); return u.host || u.protocol.replace(':', ''); } catch { return ''; }
}
function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

// ------------------------------------------------------------------- data
// What the cards need, all read at once (each read is a round trip to Chrome's storage). "Recently
// closed" and starred pages that aren't open come after the first draw: loadExtras().
async function load() {
  const prefsRead = getPrefs().catch(() => ({ cardSize: 'default', allWindows: false }));
  const tabsRead = prefsRead.then((p) => chrome.tabs.query(p.allWindows ? { windowType: 'normal' } : { windowId: CTX.srcWin }));
  const [allTabs, mru, slept, prefs, nocap, stars, view, notes, byUrl, wins, snoozed] = await Promise.all([
    tabsRead,
    getMru(),
    getSlept().catch(() => []),
    prefsRead,
    getNoCapture().catch(() => new Set()),
    getStars().catch(() => ({})),
    getView().catch(() => null),
    getNotes().catch(() => ({})),
    tabsRead.then((all) => getPreviews(all.map(urlOf))).catch(() => ({})), // previews are stored by URL
    chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []),
    getSnoozed().catch(() => []),
  ]);
  state.cardSize = prefs.cardSize;
  state.allWindows = prefs.allWindows;
  state.otherWindows = wins.filter((w) => w.id !== CTX.srcWin && !w.incognito).map((w) => w.id);
  state.snoozed = snoozed;
  state.slept = new Set(slept);
  state.nocap = nocap;
  state.stars = stars;
  state.notes = notes;
  if (view) {
    state.sort = view.sort;
    state.collapsed = new Set(view.collapsed);
  }
  const tabs = allTabs.filter((t) => !isOwnUrl(urlOf(t))); // this window, or all of them (Settings)

  const rank = new Map(mru.map((id, i) => [id, i]));
  const r = (t) => (t.id === CTX.srcTab ? -1 : rank.has(t.id) ? rank.get(t.id) : Infinity);
  const inSrc = (t) => (t.windowId === CTX.srcWin ? 0 : 1);
  tabs.sort((a, b) => r(a) - r(b) || inSrc(a) - inSrc(b) || a.windowId - b.windowId || a.index - b.index);
  state.tabs = tabs;

  // Hand each tab the preview for its current URL.
  state.previews = {};
  for (const t of tabs) {
    const p = byUrl[normalizeUrl(urlOf(t))];
    if (p) state.previews[t.id] = p;
  }

  // Windows in "most recently used" order, the current one first. Numbers
  // follow the order the windows were opened in, so "Window 2" stays
  // "Window 2" however you move between them.
  const order = [CTX.srcWin];
  for (const t of tabs) if (!order.includes(t.windowId)) order.push(t.windowId);
  const byAge = order.filter((id) => id !== CTX.srcWin).sort((a, b) => a - b);
  state.windows = order
    .map((id) => {
      const wt = tabs.filter((t) => t.windowId === id);
      const active = wt.find((t) => t.active) || wt[0];
      return {
        id,
        label: id === CTX.srcWin ? t('thisWindow') : t('windowN', byAge.indexOf(id) + 2),
        count: wt.length,
        activeTitle: active ? active.title || '' : '',
        activeId: active ? active.id : null,
        activeUrl: active ? urlOf(active) : '',
      };
    })
    .filter((w) => w.count > 0);
}
async function loadExtras() {
  await loadArchived(); // first: archived pages are left out of "Recently closed"
  await loadClosed();
  await loadStarPreviews();
  state.snoozePreviews = await getPreviews(state.snoozed.map((x) => x.url)).catch(() => ({}));
}

// Previews of starred pages that no tab has open (shown under the Starred filter).
async function loadStarPreviews() {
  const open = new Set(state.tabs.map((t) => normalizeUrl(urlOf(t))));
  const urls = Object.entries(state.stars).filter(([k]) => !open.has(k)).map(([, st]) => st.u).slice(0, LIMITS.CLOSED_PREVIEW_LOOKUP);
  state.starPreviews = await getPreviews(urls).catch(() => ({}));
}

// "Recently closed" merges Chrome's list (only the last 25, restores a tab with
// its history) with our own 7-day log (survives Chrome's cap and restarts).
const hashOf = (str) => { let x = 5381; for (let i = 0; i < str.length; i++) x = ((x << 5) + x + str.charCodeAt(i)) | 0; return (x >>> 0).toString(36); };

async function loadClosed() {
  let sessions = [];
  try { sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 }); } catch {}
  const log = await getClosedLog().catch(() => []);
  const now = Date.now();
  const stamp = (s) => (s.lastModified > 0 ? s.lastModified * 1000 : 0); // 0 = Chrome gave no time (e.g. some closed windows)
  const rank = (c) => c.ts || now;                                         // ...which we treat as "just now" for sorting

  const items = [];
  const covered = new Set(); // pages inside a closed window that Chrome still lists as one "Window" card
  const archived = new Set((state.archived || []).map((x) => normalizeUrl(x.url))); // closed by archiving: listed in the archive
  for (const s of sessions) {
    if (s.tab) {
      const url = urlOf(s.tab);
      if (!isWorthReopening(url) || archived.has(normalizeUrl(url))) continue;
      items.push({ id: 's' + s.tab.sessionId, kind: 'tab', url, title: s.tab.title || '', ts: stamp(s), count: 1, session: s, fields: [[s.tab.title, url]] });
    } else if (s.window && s.window.tabs && s.window.tabs.length) {
      const tabs = s.window.tabs;
      tabs.forEach((t) => covered.add(normalizeUrl(urlOf(t))));
      items.push({
        id: 's' + s.window.sessionId, kind: 'window', url: urlOf(tabs[0]), title: t('closedWindow', tn('tabs', tabs.length)),
        ts: stamp(s), count: tabs.length, session: s, fields: tabs.map((t) => [t.title, urlOf(t)]),
      });
    }
  }
  const open = new Set(state.tabs.map((t) => normalizeUrl(urlOf(t))));
  state.snoozed.forEach((x) => open.add(normalizeUrl(x.url))); // snoozed: listed under "Snoozed", not here
  archived.forEach((k) => open.add(k)); // archived: in the archive, not here
  for (const e of log) {
    const key = normalizeUrl(e.url);
    // Already open again, or part of a closed window shown as one card: skip.
    if (!isWorthReopening(e.url) || covered.has(key) || open.has(key)) continue;
    items.push({ id: 'l' + e.closedAt + hashOf(e.url), kind: 'tab', url: e.url, title: e.title, ts: e.closedAt, count: 1, session: null, fields: [[e.title, e.url]] });
  }

  // One entry per page: the most recent wins; within 5 s it's the same closing, so keep Chrome's (restores history).
  const best = new Map();
  for (const it of items) {
    if (it.kind === 'window') continue;
    const k = normalizeUrl(it.url) || it.url;
    const cur = best.get(k);
    const d = cur ? rank(it) - rank(cur) : 1;
    if (!cur || d > 5000 || (d >= -5000 && it.session)) best.set(k, it);
  }
  const merged = [...items.filter((it) => it.kind === 'window'), ...best.values()].sort((a, b) => rank(b) - rank(a));

  const previews = await getPreviews(merged.slice(0, LIMITS.CLOSED_PREVIEW_LOOKUP).map((it) => it.url));
  for (const it of merged) it.preview = previews[normalizeUrl(it.url)] || null;
  state.closed = merged;
}

// What the "Recently closed" section shows. Normally the last few hours, a few
// entries, few whole windows; while searching, anything from the last 7 days.
function closedFor(q) {
  if (q) return state.closed.filter((c) => c.fields.some(([title, url]) => matches(q, title, url, noteOf(url)))).slice(0, LIMITS.RECENTLY_CLOSED_SEARCH);
  const cutoff = Date.now() - LIMITS.RECENTLY_CLOSED_MAX_AGE_S * 1000;
  let windows = 0;
  return state.closed
    .filter((c) => !c.ts || c.ts >= cutoff)
    .filter((c) => c.kind !== 'window' || ++windows <= LIMITS.RECENTLY_CLOSED_WINDOWS)
    .slice(0, LIMITS.RECENTLY_CLOSED);
}

// ------------------------------------------------------------ derive/filter
// Typo-tolerant search. Every word typed must be found in one of the fields (title, address, note), in one
// of these ways, best first: at the start of a word (5), as initials ("pr" in "Pull request", 4),
// anywhere (3), as letters in order within a word that starts the same ("gh" in "GitHub", 2), or with a
// typo (1): one letter wrong, missing, extra or swapped, two in words of 8+ letters; not in words with
// digits ("v2", "42"), which are meant as typed. The words' scores add up: 0 = no match. While
// searching, the best matches come first.
const fieldIndex = new Map(); // text -> { text, words, initials } (titles and addresses repeat on every keystroke)
function fieldOf(text) {
  let x = fieldIndex.get(text);
  if (!x) {
    const lower = text.toLowerCase();
    const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    x = { text: lower, words, initials: words.map((w) => w[0]).join('') };
    if (fieldIndex.size > 4000) fieldIndex.clear();
    fieldIndex.set(text, x);
  }
  return x;
}
// Edit distance with swaps (optimal string alignment), giving up once it is over `max`.
function typoDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      low = Math.min(low, v);
    }
    if (low > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}
const inOrder = (w, word) => { let i = 0; for (const ch of word) if (ch === w[i] && ++i === w.length) return true; return false; };
function wordScore(w, f) {
  if (f.words.some((x) => x.startsWith(w))) return 5;
  if (w.length >= 2 && f.initials.includes(w)) return 4;
  if (f.text.includes(w)) return 3;
  if (w.length >= 2 && f.words.some((x) => x[0] === w[0] && inOrder(w, x))) return 2;
  if (w.length >= 4 && !/\d/.test(w)) {
    const max = w.length >= 8 ? 2 : 1;
    // the whole word, or its start (a word still being typed)
    if (f.words.some((x) => [x, x.slice(0, w.length), x.slice(0, w.length + 1)].some((y) => y.length >= w.length - max && typoDistance(w, y, max) <= max))) return 1;
  }
  return 0;
}
function searchScore(q, ...fields) {
  const fs = fields.filter(Boolean).map(fieldOf);
  let total = 0;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    const best = Math.max(0, ...fs.map((f) => wordScore(w, f)));
    if (!best) return 0;
    total += best;
  }
  return total;
}
const matches = (q, ...fields) => searchScore(q, ...fields) > 0;
// Where a tab matched decides its place first: its note (3), then its title (2), then its address (1);
// within each, how well it matched. A field counts if any word typed is found in it.
// A title that starts with what was typed (or with its first word) comes before one that has it elsewhere.
const queryWords = (q) => q.split(/\s+/).filter(Boolean);
const fieldHit = (q, text) => !!text && queryWords(q).some((w) => wordScore(w, fieldOf(text)) > 0);
function matchTier(q, tab) {
  if (fieldHit(q, noteOf(urlOf(tab)))) return 4;
  const title = (tab.title || '').toLowerCase().trim();
  if (title && (title.startsWith(q) || title.startsWith(queryWords(q)[0]))) return 3;
  return fieldHit(q, tab.title) ? 2 : 1;
}

// The search's words marked in `text` (for the dropdown): where they appear as typed, or, for a word with a
// typo, the word it matched. Built with text nodes and <mark> elements only (page text is never HTML).
function highlight(text, q) {
  const out = document.createDocumentFragment();
  if (!text) return out;
  const lower = text.toLowerCase();
  const ranges = [];
  for (const w of queryWords(q)) {
    let found = false;
    for (let i = lower.indexOf(w); i >= 0 && w; i = lower.indexOf(w, i + w.length)) { ranges.push([i, i + w.length]); found = true; }
    if (found || w.length < 4 || /\d/.test(w)) continue;
    const max = w.length >= 8 ? 2 : 1;
    for (const m of lower.matchAll(/[\p{L}\p{N}]+/gu)) {
      const word = m[0];
      if ([word, word.slice(0, w.length), word.slice(0, w.length + 1)].some((y) => y.length >= w.length - max && typoDistance(w, y, max) <= max)) {
        ranges.push([m.index, m.index + word.length]);
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (const [s, e] of ranges) {
    if (e <= at) continue;
    const from = Math.max(s, at);
    if (from > at) out.append(text.slice(at, from));
    const mk = document.createElement('mark');
    mk.className = 'ddm';
    mk.textContent = text.slice(from, e);
    out.append(mk);
    at = e;
  }
  if (at < text.length) out.append(text.slice(at));
  return out;
}
const hlSpan = (cls, text, q) => { const s = h('span', cls); s.append(highlight(text, q)); return s; };

const isStarred = (url) => !!state.stars[normalizeUrl(url)];
const siteOf = (url) => hostOf(url).replace(/^www\./, '');
const byTitle = (a, b) => (a.tab.title || siteOf(urlOf(a.tab))).localeCompare(b.tab.title || siteOf(urlOf(b.tab)), undefined, { sensitivity: 'base', numeric: true });
const winRank = (tab) => (tab.windowId === CTX.srcWin ? -1 : tab.windowId);
// Quick filters (chips next to Starred). One at a time; each shows only while some tab matches.
const FILTERS = {
  audio: { icon: 'speaker', label: 'fAudio', test: (x) => x.audible || isMuted(x) },
  pinned: { icon: 'pin', label: 'fPinned', test: (x) => x.pinned },
  asleep: { icon: 'moon', label: 'fAsleep', test: (x) => x.discarded || state.toSleep.has(x.id) },
  note: { icon: 'note', label: 'fNotes', test: (x) => !!noteOf(urlOf(x)) },
};
// The Sort dropdown. 'recent' needs no sorter: state.tabs is already most recently used first.
const SORTERS = {
  order: (a, b) => winRank(a.tab) - winRank(b.tab) || a.tab.index - b.tab.index, // the tab strip's order (this window first)
  name: byTitle,
};

// The sections the open tabs are shown in. Each has a stable `key` (what collapsing remembers).
function sectionsFor(open) {
  const secs = new Map();
  const add = (key, info, e) => {
    if (!secs.has(key)) secs.set(key, { key, ...info, entries: [] });
    e.sec = key;
    secs.get(key).entries.push(e);
  };
  if (state.dupesView) { // one section per page that is open more than once, the copy that stays first
    const close = new Set(duplicates().map((x) => x.id));
    for (const e of open) add('d:' + normalizeUrl(urlOf(e.tab)), { title: e.tab.title || siteOf(urlOf(e.tab)), site: urlOf(e.tab) }, e);
    const out = [...secs.values()];
    out.forEach((x) => x.entries.sort((a, b) => close.has(a.tab.id) - close.has(b.tab.id)));
    return out;
  }
  for (const e of open) add('u', { title: t('openTabs') }, e); // one plain list, in the chosen sort
  return [...secs.values()];
}

// The search's results, for the dropdown: open tabs that match (where they matched first: note, title,
// address; then how well; then recent use), and recently closed ones (the last 7 days).
function deriveSearch() {
  const q = state.query.trim().toLowerCase();
  state.found = [];
  state.foundClosed = [];
  if (!q) return;
  const score = new Map(), tier = new Map();
  state.found = state.tabs
    .filter((x) => { const s = searchScore(q, x.title, urlOf(x), noteOf(urlOf(x))); if (s > 0) { score.set(x.id, s); tier.set(x.id, matchTier(q, x)); } return s > 0; })
    .sort((a, b) => tier.get(b.id) - tier.get(a.id) || score.get(b.id) - score.get(a.id)) // stable: recent use within
    .map((tab) => ({ kind: 'tab', key: 't' + tab.id, tab, preview: state.previews[tab.id] || null }));
  state.foundClosed = closedFor(q);
}

function derive() {
  deriveSearch();
  const q = ''; // the cards, "Snoozed" and "Recently closed" don't follow the search: its results are in the dropdown
  if (state.scope !== 'all' && !state.windows.some((w) => w.id === state.scope)) state.scope = 'all';

  const dupeKeys = state.dupesView ? dupeUrls() : null;
  const open = state.tabs
    .filter((x) => !dupeKeys || dupeKeys.has(normalizeUrl(urlOf(x))))
    .filter((t) => state.scope === 'all' || t.windowId === state.scope)
    .filter((t) => !state.starOnly || isStarred(urlOf(t)))
    .filter((t) => !state.filter || FILTERS[state.filter].test(t))
    .map((tab) => ({ kind: 'tab', key: 't' + tab.id, tab, preview: state.previews[tab.id] || null }));
  state.mruOrder = open.slice(); // what Alt+Q cycles through: always recent use
  if (SORTERS[state.sort]) open.sort(SORTERS[state.sort]);
  // Pinned tabs first, then the rest, each in the chosen sort ([pinned, pinned, current, ...] by recent use).
  open.sort((a, b) => (b.tab.pinned ? 1 : 0) - (a.tab.pinned ? 1 : 0));

  const all = sectionsFor(open);
  // A collapsed section keeps its header and hides its cards, except while searching.
  for (const sec of all) sec.collapsed = !q && state.collapsed.has(sec.key) && !state.peek.has(sec.key);
  // One plain list (no headers) when there's nothing to group by.
  state.sections = all.length === 1 && !state.dupesView ? [{ ...all[0], plain: true, collapsed: false }] : all;
  const shown = state.sections.flatMap((x) => (x.collapsed ? [] : x.entries));

  let closed = [];
  if (state.starOnly) {
    // Starred pages no tab has open right now: reopen them from here.
    const openUrls = new Set(state.tabs.map((t) => normalizeUrl(urlOf(t))));
    closed = Object.entries(state.stars)
      .filter(([k, st]) => !openUrls.has(k) && (!q || matches(q, st.ti, st.u, noteOf(st.u))))
      .sort((a, b) => b[1].t - a[1].t)
      .map(([k, st]) => ({ kind: 'star', key: 'st' + k, item: { id: k, url: st.u, title: st.ti, ts: st.t }, preview: state.starPreviews[k] || null }));
  } else {
    closed = closedFor(q).map((item) => ({ kind: 'closed', key: 'c' + item.id, item, preview: item.preview }));
  }

  // Snoozed tabs (soonest first) get their own section; not while a filter narrows things to open tabs.
  const snoozed = state.starOnly || state.filter || state.dupesView ? [] : state.snoozed
    .filter((x) => !q || matches(q, x.title, x.url, noteOf(x.url)))
    .sort((a, b) => a.at - b.at)
    .map((x) => ({ kind: 'snoozed', key: 'z' + x.id, item: { id: x.id, url: x.url, title: x.title, ts: x.at, snooze: x }, preview: state.snoozePreviews[normalizeUrl(x.url)] || null }));

  state.entries = [...shown, ...snoozed, ...closed];
  state.snoozeCount = snoozed.length;
  state.openCount = shown.length;
  state.matchCount = open.length;
  state.matches = open; // every open tab the filters let through (collapsed sections too): "Select all" takes these
  // Ticked tabs that closed, or that the filters now hide, stay ticked only if they still exist.
  const ids = new Set(state.tabs.map((x) => x.id));
  for (const id of state.picked) if (!ids.has(id)) state.picked.delete(id);
}

// ------------------------------------------------------------------ render
// Cards fill the whole width of the card area: as many per row as fit near the preferred size
// (Settings -> Card size), then stretched so each full row reaches the right edge. A few tabs that
// can't fill one row keep a sensible size instead of stretching across the screen.
const GRID_GAP = 18;  // .grid column gap in switcher.css
const CARD_SIZES = { default: [320, 240, 420], small: [210, 160, 240], list: [300, 220, 360] }; // [preferred, smallest, few tabs]
function cardWidth(n) {
  // The layout width, fractional and rounded down: clientWidth rounds (half a pixel too many wraps the last
  // card), and getBoundingClientRect() is the on-screen size, which the opening pop-in scales to 96%.
  const avail = Math.max(0, Math.floor(parseFloat(getComputedStyle(el.openGrid).width) || 0));
  const [want, min, few] = CARD_SIZES[state.cardSize] || CARD_SIZES.default;
  let cols = Math.max(1, Math.round((avail + GRID_GAP) / (want + GRID_GAP)));
  while (cols > 1 && (avail - GRID_GAP * (cols - 1)) / cols < min) cols--;
  const w = (avail - GRID_GAP * (cols - 1)) / cols;
  return n < cols ? Math.min(w, few) : w;
}

// The window list on the left: "All windows", then each window with a small picture of the tab it shows.
function renderWindows() {
  const multi = state.windows.length > 1;
  el.wins.hidden = !multi;
  el.winHint.hidden = !multi;
  el.body.classList.toggle('with-wins', multi);
  if (!multi) return el.wins.replaceChildren();
  const rows = [{ id: 'all', label: t('allWindows'), count: state.tabs.length, activeTitle: '' }, ...state.windows];
  el.wins.replaceChildren(...rows.map((w) => {
    const b = h('button', 'win');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.scope === w.id));
    if (w.activeTitle) b.title = t('activeTab', w.activeTitle);
    const pic = h('span', 'wpic');
    if (w.id === 'all') pic.innerHTML = ICON.windows;
    else {
      const p = w.activeId && state.previews[w.activeId];
      if (p && p.img) { const img = h('img'); img.src = p.img; img.alt = ''; pic.append(img); }
      else { const img = h('img', 'wfav'); img.src = favicon(w.activeUrl || ''); img.alt = ''; pic.append(img); }
    }
    const text = h('span', 'wtext');
    text.append(h('span', 'wlabel', w.label), h('span', 'wsub', tn('tabs', w.count)));
    b.append(pic, text);
    if (w.id !== 'all' && w.id !== CTX.srcWin) { // pull this window's tabs into the current one (a second click confirms)
      const key = 'merge:' + w.id;
      const m = h('span', 'wmerge' + (state.armed === key ? ' armed' : ''), state.armed === key ? t('mergeSure') : '');
      m.setAttribute('role', 'button');
      m.title = t('mergeThis');
      m.setAttribute('aria-label', t('mergeThis'));
      if (state.armed !== key) m.innerHTML = ICON.merge;
      m.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) mergeWindows([w.id], key); });
      b.append(m);
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!pointerAllowed()) return;
      setScope(w.id);
      el.search.focus();
    });
    return b;
  }));
}

function windowTag(tab) {
  if (state.scope !== 'all' || state.windows.length < 2 || tab.windowId === CTX.srcWin) return null;
  const w = state.windows.find((x) => x.id === tab.windowId);
  return w ? h('span', 'tag', w.label) : null;
}

function thumbFor(entry, { label, sub, icon, action }) {
  const thumb = h('div', 'thumb');
  if (entry.preview && entry.preview.img) {
    const img = h('img', 'shot');
    img.decoding = 'async';
    img.src = entry.preview.img;
    img.alt = '';
    thumb.append(img);
    if (label) {
      const pill = h('span', 'pill');
      pill.innerHTML = icon;
      pill.append(label);
      thumb.append(pill);
    }
  } else {
    const box = h('div', 'nopreview');
    const tile = h('div', 'tile');
    const img = h('img');
    img.src = favicon(entry.url);
    img.alt = '';
    const badge = h('span', 'icon');
    badge.innerHTML = icon;
    tile.append(img, badge);
    box.append(tile, h('div', 'label', label || t('noPreview')), h('div', 'sub', sub || ''));
    if (action) box.append(action);
    thumb.append(box);
  }
  return thumb;
}

// Star / unstar the page a card shows. Stars live only in Tabazing (not Chrome's bookmarks).
function starButton(entry) {
  const on = isStarred(entry.url);
  const b = h('button', 'star' + (on ? ' on' : ''));
  b.type = 'button';
  b.title = t(on ? 'unstar' : 'star') + (IS_MAC ? ' (⌥S)' : ' (Alt+S)');
  b.setAttribute('aria-label', t(on ? 'unstarAria' : 'starAria'));
  b.setAttribute('aria-pressed', String(on));
  b.innerHTML = ICON.star;
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) star(entry); });
  return b;
}

// "Capture preview" on a card that has none: shows that tab for a moment, then comes back.
const canCapture = (tab) => !tab.discarded && isCapturableUrl(urlOf(tab)) && !state.nocap.has(normalizeUrl(urlOf(tab))) && state.hostOk;
function captureButton(entry) {
  const busy = state.capturing === entry.tab.id;
  const b = h('button', 'snap', t(busy ? 'capturing' : 'capturePreview'));
  b.type = 'button';
  b.disabled = busy;
  b.title = t('captureTitle') + (IS_MAC ? ' (⌥P)' : ' (Alt+P)');
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) captureOne(entry); });
  return b;
}

// How long ago a tab was last viewed, once that is a whole day or more ("3 days ago"). Chrome keeps
// that time itself (tab.lastAccessed, Chrome 121 and later); without it nothing is shown.
const DAY_MS = 24 * 60 * 60 * 1000;
function tabAge(tab) {
  const days = tab.lastAccessed > 0 ? Math.floor((Date.now() - tab.lastAccessed) / DAY_MS) : 0;
  return days >= 1 ? h('span', 'tag age', tn('ageDays', days)) : null;
}

function renderCard(entry, index) {
  // "Sleeping" is only for tabs Chrome unloaded while we were watching (Memory Saver
  // etc.): discarded now AND seen being discarded in this browser session. A tab that
  // is merely discarded because Chrome restored it lazily after a restart is not
  // sleeping: it shows its stored preview normally. Neither is a tab with no preview.
  const asleep = entry.kind === 'tab' && !!entry.tab.discarded && state.slept.has(entry.tab.id);
  const picked = entry.kind === 'tab' && state.picked.has(entry.tab.id);
  const willSleep = entry.kind === 'tab' && state.toSleep.has(entry.tab.id);
  const card = h('div', 'card' + (entry.kind === 'closed' || entry.kind === 'star' ? ' closed' : '') + (asleep || willSleep ? ' asleep' : '') + (picked ? ' picked' : ''));
  card.id = 'opt-' + entry.key;
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', String(index === state.sel));
  card.style.setProperty('--i', index); // its place in the opening cascade (switcher.css, .intro)

  const head = h('div', 'head');
  const fav = h('img', 'fav');
  fav.alt = '';

  if (entry.kind === 'tab') {
    const tab = entry.tab;
    entry.url = urlOf(tab);
    fav.src = favicon(entry.url);
    const host = hostOf(entry.url);
    if (index < 9) head.append(h('span', 'knum', String(index + 1))); // the first nine are numbered: press 1-9 to switch to them
    head.append(pickBox(entry, picked), fav, h('span', 'title', tab.title || host || t('untitled')));
    // The site name only fits next to the title on wider cards; narrow ones
    // keep the title readable (the full URL is in the tooltip).
    if (tab.title && host && state.cardW >= 300 && state.cardSize !== 'list') head.append(h('span', 'host', host.replace(/^www\./, '')));
    const age = tabAge(tab);
    if (age) head.append(age);
    const tag = windowTag(tab);
    if (tag) head.append(tag);
    if (state.dupesView) { const goes = duplicates().some((x) => x.id === tab.id); head.append(h('span', 'tag ' + (goes ? 'goes' : 'stays'), t(goes ? 'dupeCloses' : 'dupeStays'))); }
    if (tab.pinned) { const b = h('span', 'badge'); b.innerHTML = ICON.pin; b.title = t('pinned'); head.append(b); }
    if (tab.audible || isMuted(tab)) head.append(audioBadge(tab)); // playing sound (or muted): click to mute / unmute
    head.append(starButton(entry));
    const x = h('button', 'x');
    x.type = 'button';
    x.title = t('closeTabTitle');
    x.setAttribute('aria-label', t('closeTab'));
    x.innerHTML = ICON.close;
    x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeTab(entry); });
    head.append(x);
    card.title = (tab.title || '') + '\n' + entry.url + (asleep ? '\n' + t('sleepingTip') : '');
    // No preview just means Chrome only lets us screenshot the visible tab and
    // we haven't seen this one yet; it's an awake background tab, not asleep.
    // The placeholder shows the domain, since narrow cards hide it in the header.
    if (state.cardSize === 'list') { // List: one line, no screenshot; the quick buttons sit before the star
      head.insertBefore(quickActions(entry), head.querySelector('.star'));
      card.append(head);
      return finishCard(card, entry);
    }
    const sub = host;
    const thumb = thumbFor(entry, asleep || willSleep
      ? { label: t(willSleep ? 'willSleep' : 'sleeping'), sub, icon: ICON.moon }
      : { label: entry.preview ? '' : t('noPreview'), sub, icon: ICON.camera, action: !entry.preview && canCapture(tab) ? captureButton(entry) : null });
    thumb.append(quickActions(entry));
    card.append(head, thumb);
  } else {
    const c = entry.item;
    entry.url = c.url;
    fav.src = favicon(entry.url);
    const title = c.title || hostOf(c.url);
    // Some entries (e.g. closed windows) come without a time: no time tag then.
    const ago = timeAgo(c.ts / 1000);
    head.append(fav, h('span', 'title', title));
    if (ago && entry.kind === 'closed') head.append(h('span', 'tag', ago));
    if (entry.kind === 'snoozed') head.append(h('span', 'tag snz', t('wakesAt', whenLabel(c.ts))));
    if (c.kind !== 'window') head.append(starButton(entry));
    if (entry.kind === 'snoozed') { // × cancels the snooze (the tab is not reopened)
      const x = h('button', 'x');
      x.type = 'button';
      x.title = t('cancelSnooze');
      x.setAttribute('aria-label', t('cancelSnooze'));
      x.innerHTML = ICON.close;
      x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeTab(entry); });
      head.append(x);
    }
    card.title = entry.kind === 'snoozed' ? t('snoozedTip', title) + '\n' + c.url : t('reopenTip', title) + (c.kind !== 'window' ? '\n' + c.url : '');
    if (state.cardSize === 'list') { card.append(head); return finishCard(card, entry); }
    card.append(head, entry.kind === 'snoozed'
      ? thumbFor(entry, { label: t('snoozedLabel'), sub: hostOf(entry.url), icon: ICON.clock })
      : entry.kind === 'star'
      ? thumbFor(entry, { label: t('starred'), sub: hostOf(entry.url), icon: ICON.star })
      : thumbFor(entry, { label: t('closedLabel'), sub: hostOf(entry.url), icon: ICON.history }));
  }
  return finishCard(card, entry);
}

// What every card does, whatever it shows: click to open, drag to move, hover to select.
function finishCard(card, entry) {
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pointerAllowed()) return;
    // Ctrl+click (Cmd+click on a Mac) shows the preview big. Shift+click ticks a range, like a file list.
    if (e.ctrlKey || e.metaKey) return openBig(entry);
    if (entry.kind === 'tab' && (e.shiftKey || state.picked.size)) return pick(entry, { range: e.shiftKey });
    choose(state.entries.indexOf(entry));
  });
  if (entry.kind === 'tab' && state.sort === 'order' && !state.dupesView) dragToMove(card, entry.tab);
  // Middle-click (the mouse wheel) closes the tab. Pressing the wheel would start Chrome's auto-scroll
  // first, which swallows the click, so that is turned off on cards.
  card.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  card.addEventListener('auxclick', (e) => {
    if (e.button === 1 && entry.kind === 'tab') { e.preventDefault(); e.stopPropagation(); if (pointerAllowed()) closeTab(entry); }
  });
  card.addEventListener('mousemove', () => {
    const i = state.entries.indexOf(entry);
    if (state.mouseReady && i !== state.sel) select(i, { scroll: false });
  });
  return card;
}

// A section: a header you can click to collapse it (remembered between opens), then its cards.
function renderSection(sec, startIndex) {
  const box = h('div', 'gsec' + (sec.collapsed ? ' collapsed' : ''));
  box.setAttribute('role', 'group');
  if (!sec.plain) {
    box.setAttribute('aria-label', sec.title);
    const head = h('button', 'ghead');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(!sec.collapsed));
    head.title = t(sec.collapsed ? 'sectionShow' : 'sectionCollapse');
    const chev = h('span', 'chev');
    chev.innerHTML = ICON.chevron;
    head.append(chev);
    if (sec.site) {
      const fav = h('img', 'sfav');
      fav.src = favicon(sec.site);
      fav.alt = '';
      head.append(fav);
    }
    head.append(h('span', 'gname', sec.title), h('span', 'n', String(sec.entries.length)));
    if (sec.collapsed) { // a peek at what's inside
      const peek = h('span', 'peek');
      for (const e of sec.entries.slice(0, 8)) { const i = h('img'); i.src = favicon(urlOf(e.tab)); i.alt = ''; peek.append(i); }
      head.append(peek);
    }
    head.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) toggleSection(sec.key); });
    const hrow = h('div', 'hrow');
    hrow.append(head);
    box.append(hrow);
  }
  if (!sec.collapsed) {
    const grid = h('div', 'grid' + (state.cardSize === 'default' ? '' : ' ' + state.cardSize));
    grid.style.setProperty('--w', state.cardW + 'px');
    grid.append(...sec.entries.map((e, i) => renderCard(e, startIndex + i)));
    box.append(grid);
  }
  return box;
}

function renderTools() {
  // Quick filters: a chip per filter some tab matches (or that is on), with how many.
  const inScope = state.tabs.filter((x) => state.scope === 'all' || x.windowId === state.scope);
  el.qfilters.replaceChildren(...Object.entries(FILTERS).map(([id, f]) => {
    const n = inScope.filter(f.test).length;
    if (!n && state.filter !== id) return null;
    const b = h('button', 'chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.filter === id));
    b.innerHTML = ICON[f.icon];
    b.append(h('span', 'label', t(f.label)), h('span', 'n', String(n)));
    b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) setFilter(state.filter === id ? null : id); });
    return b;
  }).filter(Boolean));
  // Merge: pull every other window's tabs into this one (a second click confirms).
  el.mergeBtn.hidden = !state.otherWindows.length;
  el.mergeText.textContent = state.armed === 'act:merge' ? t('mergeSure') : tn('mergeN', state.otherWindows.length);
  el.mergeBtn.classList.toggle('armed', state.armed === 'act:merge');
  el.sort.value = state.sort;
  if (el.sort._fancy) el.sort._fancy.sync();
  el.starFilter.setAttribute('aria-pressed', String(state.starOnly));
  el.starN.textContent = String(Object.keys(state.stars).length);
  const d = duplicates().length;
  el.dupesBtn.hidden = d === 0;
  el.dupesText.textContent = tn('dupesBtn', d);
  el.dupesBtn.setAttribute('aria-pressed', String(state.dupesView));
  el.dupesBtn.title = t('dupesTitle');
  updateSweepButton();
}

function render() {
  hideTip();
  closeBig();
  const snoozedPart = state.entries.slice(state.openCount, state.openCount + state.snoozeCount);
  const closed = state.entries.slice(state.openCount + state.snoozeCount);

  // The window list first: the cards are sized from the space it leaves.
  renderWindows();
  state.cardW = Math.floor(cardWidth(state.matchCount));
  el.openGrid.classList.toggle('has-groups', state.sections.some((x) => !x.plain));
  let at = 0;
  el.openGrid.replaceChildren(...state.sections.map((sec) => { const box = renderSection(sec, at); if (!sec.collapsed) at += sec.entries.length; return box; }));
  el.closedGrid.className = el.snoozedGrid.className = state.cardSize === 'list' ? 'grid list' : 'grid small';
  el.snoozedGrid.replaceChildren(...snoozedPart.map((e, i) => renderCard(e, i + state.openCount)));
  el.snoozedSection.hidden = snoozedPart.length === 0;
  el.closedGrid.replaceChildren(...closed.map((e, i) => renderCard(e, i + state.openCount + state.snoozeCount)));
  // While searching, "Recently closed" reaches back 7 days: say so, so nobody expects more.
  el.closedH.textContent = state.starOnly ? t('starredNotOpen') : state.query ? t('closedSearchH') : t('recentlyClosed');
  // Nothing found: say what Enter does with the text (open it as an address, or search the web for it).
  const q0 = state.query.trim();
  el.openEmpty.textContent = state.starOnly && !q0 ? t('noStarredOpen')
    : q0 && !state.entries.length ? (asUrl(q0) ? t('enterOpen', q0) : t('enterSearch', q0))
    : q0 ? t('noMatchShift') : t('noMatch');
  el.openEmpty.hidden = state.matchCount > 0;
  el.closedSection.hidden = closed.length === 0;

  const n = state.matchCount;
  renderCount();
  renderTools();
  renderActs();
  renderDropdown();
  setTop();
  select(state.sel, { scroll: true });
  requestAnimationFrame(tipTruncated);
}

// The count in the search box: how many tabs are shown, or how many open and closed tabs the search found.
function renderCount() {
  el.count.textContent = state.query.trim() ? t('countSearch', state.found.length, state.foundClosed.length) : tn('tabs', state.matchCount);
}

// Text cut short with "…" gets its full wording as a tooltip.
function tipTruncated() {
  for (const n of document.querySelectorAll('.ltitle, .gname, .host, .lname .n, .mname .n, .litem span, .chip .label, .wlabel')) {
    if (n.scrollWidth > n.clientWidth + 1) n.title = n.textContent; else if (n.title === n.textContent) n.removeAttribute('title');
  }
}

// The card area starts below the header, the toolbar, the alert bar and the quick-actions bar (if shown).
function setTop() {
  const top = el.bar.offsetHeight + el.tools.offsetHeight + (el.alert.hidden ? 0 : el.alert.offsetHeight + 4); // the actions pill floats: not counted
  el.body.style.setProperty('--top', top + 'px');
}

function toTop() { el.scroller.scrollTop = 0; }
function refresh({ keepKey } = {}) {
  const prevKey = keepKey || (state.entries[state.sel] || {}).key;
  derive();
  const i = state.entries.findIndex((e) => e.key === prevKey);
  state.sel = i >= 0 ? i : 0;
  render();
}

// -------------------------------------------------------------- selection
function select(i, { scroll = true } = {}) {
  const n = state.entries.length;
  if (!n) { state.sel = 0; return; }
  state.sel = ((i % n) + n) % n;
  const cards = document.querySelectorAll('#scroller .card'); // (not the archive overlay's)
  cards.forEach((c, k) => c.setAttribute('aria-selected', String(k === state.sel)));
  const cur = cards[state.sel];
  if (!cur) return;
  document.querySelectorAll('[role=listbox]').forEach((l) => l.removeAttribute('aria-activedescendant'));
  cur.closest('[role=listbox]').setAttribute('aria-activedescendant', cur.id);
  if (scroll) cur.scrollIntoView({ block: 'nearest' });
}

// Alt+Q / Tab cycle through open tabs only; arrows can reach "Recently closed".
// The sort orders the cards on screen, so this follows recent use (like Alt+Tab), not screen order.
// Alt+Q / Alt+W, the wheel while holding Alt, and Tab step through the open tabs in the order the cards
// are shown (pinned first, then the chosen sort), wrapping around at the ends: d = +1 is the next card,
// -1 the one before. From the selected card, or from the current tab when something else is selected.
function stepKey(from, d) {
  const list = state.matches.map((e) => e.key); // every open tab the filters show, in screen order (collapsed ones too)
  const n = list.length;
  if (!n) return null;
  let here = list.indexOf(from);
  if (here < 0) here = list.indexOf('t' + CTX.srcTab);
  if (here < 0) here = d > 0 ? -1 : n;
  return list[(((here + d) % n) + n) % n];
}
function cycle(d) {
  const cur = state.entries[state.sel];
  const key = stepKey(cur && cur.kind === 'tab' ? cur.key : null, d);
  if (key) selectKey(key);
}

// Select an open tab by key; if it sits in a collapsed section, open that section for this visit.
function selectKey(key) {
  let i = state.entries.findIndex((e) => e.key === key);
  if (i < 0) {
    const e = state.mruOrder.find((x) => x.key === key);
    if (!e || !e.sec) return;
    state.peek.add(e.sec);
    refresh({ keepKey: key });
    return;
  }
  select(i);
}

function moveSpatial(dx, dy) {
  const cards = [...document.querySelectorAll('#scroller .card')];
  if (!cards[state.sel]) return;
  if (dx) return select(state.sel + dx);
  const best = cardToward(cards, state.sel, dy);
  if (best >= 0) select(best);
}
// The card above (dy < 0) or below (dy > 0) cards[from]: the nearest row that way, the closest across. -1 if none.
function cardToward(cards, from, dy) {
  const c = cards[from].getBoundingClientRect();
  const cx = c.left + c.width / 2;
  let best = -1, bestScore = Infinity;
  cards.forEach((card, k) => {
    if (k === from) return;
    const r = card.getBoundingClientRect();
    const gap = dy > 0 ? r.top - c.bottom : c.top - r.bottom;
    if (gap < -4) return; // not in that direction
    const score = gap * 4 + Math.abs(r.left + r.width / 2 - cx);
    if (score < bestScore) { bestScore = score; best = k; }
  });
  return best;
}

function toggleSection(key) {
  if (state.collapsed.has(key) && !state.peek.has(key)) state.collapsed.delete(key);
  else { state.collapsed.add(key); state.peek.delete(key); }
  updateView({ collapsed: [...state.collapsed] }).catch(() => {});
  refresh();
}

function setSort(sort) {
  if (sort === state.sort) return;
  state.sort = sort;
  updateView({ sort }).catch(() => {});
  refresh();
  toTop();
}

function setFilter(id) {
  state.filter = id;
  state.sel = 0;
  refresh({ keepKey: '-' });
  toTop();
}

function toggleStarFilter() {
  state.starOnly = !state.starOnly;
  state.sel = 0;
  refresh({ keepKey: '-' });
  toTop();
}

async function star(entry) {
  if (!entry || !entry.url || (entry.item && entry.item.kind === 'window')) return;
  const on = await toggleStar(entry.url, entry.tab ? entry.tab.title : entry.item.title).catch(() => null);
  if (on === null || state.done) return;
  state.stars = await getStars().catch(() => state.stars);
  if (on) await loadStarPreviews();
  // Unstarring a starred-not-open card removes it from the list: keep the selection near it.
  const i = state.entries.indexOf(entry);
  const next = !on && entry.kind === 'star' ? [state.entries[i + 1], state.entries[i - 1]].find((e) => e && e !== entry) : entry;
  refresh({ keepKey: next && next.key });
}

// Take one tab's preview now. Showing a tab in the window the overlay sits in hides the page the
// overlay lives on (which closes it), so then the background opens the switcher again afterwards.
async function captureOne(entry) {
  if (!entry || entry.kind !== 'tab' || state.capturing || state.done || !canCapture(entry.tab)) return;
  const tab = entry.tab;
  const leaves = CTX.mode === 'overlay' && tab.windowId === CTX.srcWin;
  if (leaves) {
    await setResume({ query: state.query, scope: state.scope, starred: state.starOnly, key: entry.key }).catch(() => {});
    chrome.runtime.sendMessage({ type: MSG.CAPTURE_ONE, tabId: tab.id, reopen: CTX.srcTab }).catch(() => {});
    return finish('switch');
  }
  state.capturing = tab.id;
  asking = true; // the tab switch may move focus for a moment: don't close
  refresh({ keepKey: entry.key });
  try { await chrome.runtime.sendMessage({ type: MSG.CAPTURE_ONE, tabId: tab.id }); } catch {}
  asking = false;
  state.capturing = null;
  if (state.done) return;
  window.focus();
  const got = await getPreviews([urlOf(tab)]).catch(() => ({}));
  const p = got[normalizeUrl(urlOf(tab))];
  if (p) state.previews[tab.id] = p;
  else { // Chrome refused (or the page never finished loading): say so instead of doing nothing
    state.nocap = await getNoCapture().catch(() => state.nocap);
    toast(t(state.nocap.has(normalizeUrl(urlOf(tab))) ? 'captureBlocked' : 'captureFailed'));
  }
  refresh({ keepKey: entry.key });
}

function setScope(scope) {
  state.scope = scope;
  state.sel = 0;
  refresh({ keepKey: '-' });
  toTop();
}
function cycleScope(d) {
  if (state.windows.length < 2) return;
  const ids = ['all', ...state.windows.map((w) => w.id)];
  const i = ids.indexOf(state.scope);
  setScope(ids[(((i + d) % ids.length) + ids.length) % ids.length]);
}

// ---------------------------------------------------------------- actions
// Single exit path, runs at most once. `reason` tells the background what
// to do with focus: 'cancel' puts the original window back in front.
async function finish(reason) {
  if (state.done) return;
  state.done = true;
  if (state.toSleep.size) chrome.runtime.sendMessage({ type: MSG.SLEEP, tabIds: [...state.toSleep] }).catch(() => {});
  chrome.runtime.sendMessage({
    type: MSG.CLOSED, reason, src: CTX.srcTab, win: CTX.srcWin, state: CTX.srcState,
  }).catch(() => {});
  if (CTX.mode === 'overlay') {
    // Target '*': the host page's origin isn't known here, and the message
    // carries nothing but "close".
    parent.postMessage({ tabazing: FRAME_MSG.CLOSE }, '*');
  } else {
    if (reason === 'cancel') {
      try { await chrome.windows.update(CTX.srcWin, { focused: true }); } catch {}
    }
    window.close();
  }
}

async function choose(i) {
  const entry = state.entries[i];
  if (state.done || !entry) return;
  try {
    if (entry.kind === 'snoozed') { // wake it now
      await removeSnoozed([entry.item.id]).catch(() => {});
      if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
      await chrome.tabs.create({ url: entry.item.url, windowId: CTX.srcWin, active: true });
      return finish('switch');
    }
    if (entry.kind === 'star') { // a starred page that isn't open: open it
      if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
      await chrome.tabs.create({ url: entry.item.url, windowId: CTX.srcWin, active: true });
      return finish('switch');
    }
    if (entry.kind === 'tab') {
      const tab = entry.tab;
      if (tab.id === CTX.srcTab && CTX.mode === 'overlay') return finish('cancel');
      await chrome.tabs.update(tab.id, { active: true });
      if (CTX.mode === 'window' || tab.windowId !== CTX.srcWin) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return finish('switch');
    }
    // Recently closed: restore into the window the user came from.
    if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
    const c = entry.item;
    if (c.session) await chrome.sessions.restore((c.session.tab || c.session.window).sessionId);
    else await chrome.tabs.create({ url: c.url, windowId: CTX.srcWin, active: true }); // from our own log: reopen the page
    return finish('restore');
  } catch (e) {
    console.warn('[Tabazing] could not open entry:', e && e.message);
    finish('cancel');
  }
}

// Anything destructive takes two presses: the first arms it (the button asks "sure?"), the second acts.
// `key` names the quick action that is armed.
function armed(key) {
  if (state.armed === key) { state.armed = null; return true; }
  state.armed = key;
  refresh();
  setTimeout(() => { if (state.armed === key) { state.armed = null; if (!state.done) refresh(); } }, 3500);
  return false;
}

async function closeTab(entry) {
  if (entry && entry.kind === 'star') return star(entry); // Del on a starred, not-open page unstars it
  if (entry && entry.kind === 'snoozed') { // Del / × on a snoozed tab: cancel the snooze
    const i = state.entries.indexOf(entry);
    const next = [state.entries[i + 1], state.entries[i - 1]].find((e) => e && e !== entry);
    state.snoozed = await removeSnoozed([entry.item.id]).catch(() => state.snoozed);
    toast(t('snoozeCancelled'));
    return refresh({ keepKey: next && next.key });
  }
  if (!entry || entry.kind !== 'tab' || state.done) return;
  const id = entry.tab.id;
  const i = state.entries.indexOf(entry);
  const neighbour = [state.entries[i + 1], state.entries[i - 1]].find((e) => e && e.kind === 'tab');
  const undo = undoRecord([entry.tab]);
  try { await chrome.tabs.remove(id); } catch { return; }
  if (id === CTX.srcTab && CTX.mode === 'overlay') return; // overlay closes with its tab
  forgetTab(id, neighbour && neighbour.key);
  pushUndo(undo);
  // Give Chrome a moment to add it to "Recently closed", then show it there.
  setTimeout(async () => { await loadClosed(); if (!state.done) refresh(); }, 200);
}

function forgetTab(id, keepKey) {
  const tab = state.tabs.find((x) => x.id === id);
  if (!tab) return;
  // The tabs after it in its window move up one (keeps "By order", and undo's positions, right).
  state.tabs.forEach((x) => { if (x.windowId === tab.windowId && x.index > tab.index) x.index--; });
  // Chrome's onRemoved can arrive before our own close call returns (and tabs close from elsewhere too):
  // if the tab that goes is the selected one, select its neighbour, so the view stays where it is
  // instead of jumping back to the first card.
  const i = state.entries.findIndex((e) => e.kind === 'tab' && e.tab.id === id);
  if (!keepKey && i >= 0 && i === state.sel) {
    const next = [state.entries[i + 1], state.entries[i - 1]].find((e) => e && e.kind === 'tab');
    keepKey = next && next.key;
  }
  state.tabs = state.tabs.filter((x) => x.id !== id);
  state.picked.delete(id);
  state.windows = state.windows
    .map((w) => (w.id === tab.windowId ? { ...w, count: w.count - 1 } : w))
    .filter((w) => w.count > 0);
  refresh({ keepKey });
}

// ------------------------------------------------------------ quick actions
// Tick tabs (the box on a card, Ctrl/Cmd+click, Shift+click for a range, or "Select all" while
// searching), then act on all of them at once. With nothing ticked, the bar acts on every tab the
// search found. Everything here only calls Chrome's own tab APIs.
function pickBox(entry, on) {
  const b = h('button', 'pick' + (on ? ' on' : ''));
  b.type = 'button';
  b.setAttribute('role', 'checkbox');
  b.setAttribute('aria-checked', String(on));
  b.setAttribute('aria-label', t('pickAria'));
  b.title = t('pickTitle');
  b.innerHTML = ICON.check;
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) pick(entry, { range: e.shiftKey }); });
  return b;
}
function pick(entry, { range = false } = {}) {
  const id = entry.tab.id;
  const onScreen = state.entries.filter((e) => e.kind === 'tab').map((e) => e.tab.id);
  const a = range && state.lastPick !== null ? onScreen.indexOf(state.lastPick) : -1;
  const b = onScreen.indexOf(id);
  if (a >= 0 && b >= 0) onScreen.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => state.picked.add(x));
  else if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  state.lastPick = id;
  refresh({ keepKey: entry.key });
}
const pickPool = () => (state.query.trim() ? state.found : state.matches); // what "Select all" ticks: the search's matches, or the cards
function selectAll() { pickPool().forEach((e) => state.picked.add(e.tab.id)); refresh(); }
function clearPicks() { state.picked.clear(); state.lastPick = null; refresh(); }

// Quick actions act only on ticked tabs. While searching, "Select all N matching tabs" ticks the matches.
function targets() { return state.tabs.filter((x) => state.picked.has(x.id)); }

const ACTIONS = [
  { id: 'close', icon: 'close', label: () => t('actClose'), title: () => t('actCloseTitle'), run: closeMany, confirm: (n) => n > 1 },
  { id: 'copy', icon: 'link', label: () => t('actCopy'), title: () => t('actCopyTitle'), run: (tabs) => copyLinks(tabs, 'plain') },
  // In "More" (⋯): used less often.
  { id: 'md', more: true, label: () => t('actCopyMd'), title: () => t('actCopyMdTitle'), run: (tabs) => copyLinks(tabs, 'md') },
  { id: 'win', more: true, label: () => t('actNewWindow'), run: moveToWindow },
  { id: 'sleep', more: true, label: () => t('actSleep'), run: sleepTabs },
  { id: 'snooze', more: true, label: () => t('actSnooze'), run: (tabs, btn) => snoozeMenu(tabs, btn) },
  { id: 'archive', more: true, label: () => t('actArchive'), run: archiveTabs },
  { id: 'pin', more: true, label: (tabs) => t(tabs.length && tabs.every((x) => x.pinned) ? 'actUnpin' : 'actPin'), run: pinTabs },
  { id: 'mute', more: true, label: (tabs) => t(tabs.length && tabs.every((x) => x.mutedInfo && x.mutedInfo.muted) ? 'actUnmute' : 'actMute'), run: muteTabs },
];

// The floating pill at the bottom: shows while searching (to tick every match), once tabs are ticked,
// and in the duplicates view (to confirm). It floats over the cards, so nothing below it moves.
function renderActs() {
  document.documentElement.classList.toggle('picking', state.picked.size > 0);
  if (state.dupesView) return renderDupesBar();
  const tabs = targets();
  const n = tabs.length;
  const show = n > 0 || (!!state.query.trim() && state.found.length > 1);
  el.acts.hidden = !show;
  el.acts.classList.remove('dupes');
  if (!show) return;
  const pool = pickPool();
  const allPicked = pool.length > 0 && pool.every((e) => state.picked.has(e.tab.id));
  el.actsN.textContent = n ? tn('pickedN', n) : '';
  el.actsN.hidden = !n;
  el.selAll.hidden = allPicked || !pool.length;
  el.selAll.className = n ? 'lnk' : 'qa primary';
  el.selAll.textContent = state.query.trim() ? tn('selAllMatches', pool.length) : tn('selAllTabs', pool.length);
  el.selNone.hidden = n === 0;
  el.actsBtns.hidden = n === 0; // nothing to act on yet: only the "Select all" button shows
  const more = h('button', 'qa more');
  more.type = 'button';
  more.title = t('actMore');
  more.setAttribute('aria-label', t('actMore'));
  more.innerHTML = ICON.more;
  more.append(h('span', '', t('actMore')));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pointerAllowed() || !n) return;
    menu(more, ACTIONS.filter((a) => a.more).map((a) => ({ label: a.label(tabs), fn: () => a.run(targets(), more) })));
  });
  el.actsBtns.replaceChildren(...ACTIONS.filter((a) => !a.more).map((a) => {
    const key = 'act:' + a.id;
    const sure = state.armed === key;
    const b = h('button', 'qa' + (sure ? ' armed' : '') + (a.id === 'close' ? ' danger' : ''));
    b.type = 'button';
    b.insertAdjacentHTML('beforeend', ICON[a.icon]);
    b.append(h('span', '', sure ? t('sureN', n) : a.label(tabs)));
    if (a.title) b.title = a.title();
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!pointerAllowed() || !n) return;
      if (a.confirm && a.confirm(n) && !armed(key)) return;
      Promise.resolve(a.run(targets(), b)).catch((err) => toast(t('actFailed'), err));
    });
    return b;
  }), more);
}

// Duplicates: first a view of just the copies (each card says whether it stays or closes), then confirm.
function renderDupesBar() {
  const d = duplicates();
  el.acts.hidden = false;
  el.acts.classList.add('dupes');
  el.actsN.hidden = false;
  el.actsN.textContent = d.length ? tn('dupesSummary', d.length) : t('dupesNone');
  el.selAll.hidden = true;
  el.selNone.hidden = true;
  el.actsBtns.hidden = false;
  const close = h('button', 'qa danger' + (state.armed === 'act:dupes' ? ' armed' : ''));
  close.type = 'button';
  close.insertAdjacentHTML('beforeend', ICON.close);
  close.append(h('span', '', state.armed === 'act:dupes' ? t('sureN', d.length) : tn('dupesClose', d.length)));
  close.disabled = !d.length;
  close.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeDupes(); });
  const back = h('button', 'qa');
  back.type = 'button';
  back.append(h('span', '', t('dupesBack')));
  back.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) dupesView(false); });
  el.actsBtns.replaceChildren(close, back);
}
function dupesView(on) {
  state.dupesView = on;
  state.armed = null;
  state.picked.clear();
  refresh({ keepKey: '-' });
  toTop();
}

// Small note at the bottom of the switcher ("Copied 5 links"), optionally with one button ("Undo").
let toastTimer = null;
function toast(text, err, action) {
  if (err) console.warn('[Tabazing]', err && err.message);
  el.toast.textContent = text;
  if (action) {
    const b = h('button', 'tact', action.label);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); if (!pointerAllowed()) return; el.toast.hidden = true; action.fn(); });
    el.toast.append(b);
  }
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, action ? 5000 : 2600);
}

// ---- undo close: Ctrl+Z (or Undo in the note that follows a close) reopens what was last closed here,
// in the same window and place, pinned as before. Several closed at once come back together. The tab
// is opened afresh, in the background, so the switcher stays open (its back/forward history is not kept).
const undoRecord = (tabs) => tabs.map((x) => ({ url: urlOf(x), windowId: x.windowId, index: x.index, pinned: !!x.pinned }));
function pushUndo(group) {
  if (!group.length) return;
  state.undo.push(group);
  if (state.undo.length > 20) state.undo.shift();
  toast(tn('closedN', group.length), null, { label: t('undo') + (IS_MAC ? ' (⌘Z)' : ' (Ctrl+Z)'), fn: undoClose });
}
async function undoClose() {
  const group = state.undo.pop();
  if (!group || state.done) return toast(t('undoNothing'));
  await reopenAt(group);
  toast(tn('reopenedN', group.length));
  await loadClosed();
  await reload();
}
// Reopen tabs (undoRecord) in the background, where they were.
async function reopenAt(group) {
  for (const x of [...group].sort((a, b) => a.index - b.index)) {
    try { await chrome.tabs.create({ url: x.url, windowId: x.windowId, index: x.index, pinned: x.pinned, active: false }); }
    catch { await chrome.tabs.create({ url: x.url, windowId: CTX.srcWin, active: false }).catch(() => {}); } // its window is gone
  }
}

// Run `fn` now, or once the opening animation is over (a redraw during it would restart it on every card).
let introWait = null;
function afterIntro(fn) {
  if (!document.documentElement.classList.contains('intro')) return fn();
  clearTimeout(introWait);
  introWait = setTimeout(() => { if (!state.done) fn(); }, 340);
}

// Reload the tab list after Chrome has acted (pin, mute, move...), keeping the selection.
async function reload() {
  if (state.done) return;
  const key = (state.entries[state.sel] || {}).key;
  await load();
  await loadExtras();
  if (!state.done) refresh({ keepKey: key });
}

async function closeMany(tabs) {
  const ids = tabs.map((x) => x.id);
  const own = CTX.mode === 'overlay' && ids.includes(CTX.srcTab); // closing the tab we sit on closes us: do it last
  const undo = undoRecord(tabs);
  await chrome.tabs.remove(ids.filter((id) => !own || id !== CTX.srcTab));
  state.picked.clear();
  if (own) return chrome.tabs.remove(CTX.srcTab);
  ids.forEach((id) => { state.tabs = state.tabs.filter((x) => x.id !== id); });
  pushUndo(undo);
  setTimeout(async () => { await loadClosed(); await reload(); }, 200);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // Inside a web page's frame the page may not allow the clipboard API: the old way still works.
  el.clip.value = text;
  el.clip.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  el.clip.value = '';
  el.search.focus({ preventScroll: true });
  return ok;
}
async function copyLinks(tabs, fmt) {
  const md = (s) => String(s || '').replace(/([\[\]])/g, '\\$1');
  const text = tabs.map((x) => (fmt === 'md' ? `- [${md(x.title || hostOf(urlOf(x)))}](${urlOf(x)})` : urlOf(x))).join('\n');
  toast((await copyText(text)) ? tn('copiedN', tabs.length) : t('copyFailed'));
}

async function moveToWindow(tabs) {
  const [first, ...rest] = tabs;
  const w = await chrome.windows.create({ tabId: first.id, focused: true });
  if (rest.length) await chrome.tabs.move(rest.map((x) => x.id), { windowId: w.id, index: -1 });
  state.picked.clear();
  finish('switch');
}

// ---- open or search from the box: what was typed, when nothing matches it (or Shift+Enter).
// Something that looks like an address opens as one; anything else is searched on Google.
const googleUrl = (text) => 'https://www.google.com/search?q=' + encodeURIComponent(text);
function asUrl(s) {
  if (!s || /\s/.test(s)) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(s)) return s;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(s)) return 'http://' + s;
  if (/^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(s)) return 'https://' + s;
  return null;
}
async function openFromBox(text) {
  const url = asUrl(text);
  try {
    if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
    await chrome.tabs.create({ url: url || googleUrl(text), windowId: CTX.srcWin, active: true });
  } catch (e) { console.warn('[Tabazing] could not open from the search box:', e && e.message); }
  finish('switch');
}

// ---- the search dropdown: as you type, under the search box, in this order: the open tabs that match
// (a small preview each), then matching bookmarks (their icon), then, with nothing found, a Google search
// (and "Open ..." first when the text looks like an address). ↑/↓ move, Enter opens, the mouse too.
const DD_TABS = 6, DD_ARCHIVED = 5, DD_MARKS = 6, DD_CLOSED = 5, DD_HISTORY = 6;
async function loadMarks() {
  state.marks = [];
  if (!chrome.bookmarks) return;
  try {
    const out = [];
    const arch = await archiveFolder().catch(() => null); // archived tabs have their own section
    const walk = (n, path) => {
      if (arch && n.id === arch.id) return;
      if (n.url) { if (/^(https?|file|ftp):/i.test(n.url)) out.push({ title: n.title || '', url: n.url, path: path.join(' › ') }); return; }
      for (const c of n.children || []) walk(c, n.title ? [...path, n.title] : path);
    };
    (await chrome.bookmarks.getTree()).forEach((root) => walk(root, []));
    state.marks = out;
  } catch { state.marks = []; }
  if (!state.done && state.query.trim()) renderDropdown();
}
// History (needs the history permission): the last 90 days read once and matched like everything else
// (typos and all), plus Chrome's own history search for what was typed, which reaches further back.
const hist = (x) => ({ url: x.url, title: x.title || '', t: x.lastVisitTime || 0, n: x.visitCount || 0 });
async function loadHistory() {
  state.history = [];
  if (!chrome.history) return;
  try {
    const items = await chrome.history.search({ text: '', startTime: Date.now() - 90 * 864e5, maxResults: 5000 });
    state.history = items.filter((x) => /^(https?|file|ftp):/i.test(x.url || '')).map(hist);
  } catch { state.history = []; }
  if (!state.done && state.query.trim()) renderDropdown();
}
let histTimer = null;
function searchHistory(q) {
  clearTimeout(histTimer);
  if (!q || !chrome.history) { state.histQ = { q: '', items: [] }; return; }
  histTimer = setTimeout(async () => {
    try {
      const items = await chrome.history.search({ text: q, startTime: 0, maxResults: 60 });
      if (state.query.trim() !== q || state.done) return;
      state.histQ = { q, items: items.filter((x) => /^(https?|file|ftp):/i.test(x.url || '')).map(hist) };
      renderDropdown();
    } catch {}
  }, 120);
}
function historyRows(q, shown) {
  const byUrl = new Map();
  for (const x of [...(state.history || []), ...(state.histQ.q === state.query.trim() ? state.histQ.items : [])]) {
    const k = normalizeUrl(x.url);
    if (!k || shown.has(k) || byUrl.has(k)) continue;
    byUrl.set(k, x);
  }
  return [...byUrl.values()]
    .map((x) => ({ x, s: searchScore(q, x.title, x.url) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || b.x.t - a.x.t)
    .slice(0, DD_HISTORY)
    .map((r) => r.x);
}

function ddRows() {
  const q = state.query.trim().toLowerCase();
  if (!q) return [];
  const rows = [];
  const tabs = state.found.slice(0, DD_TABS);
  if (tabs.length) {
    rows.push({ head: t('ddTabs') });
    tabs.forEach((e) => rows.push({ kind: 'tab', entry: e }));
    if (state.found.length > DD_TABS) rows.push({ note: tn('ddMoreFound', state.found.length - DD_TABS) });
  }
  const archived = (state.archived || [])
    .map((a) => ({ a, s: searchScore(q, a.title, a.url) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, DD_ARCHIVED);
  if (archived.length) {
    rows.push({ head: t('ddArchived') });
    archived.forEach(({ a }) => rows.push({ kind: 'archived', a }));
  }
  const marks = (state.marks || [])
    .map((b) => ({ b, s: searchScore(q, b.title, b.url, b.path) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, DD_MARKS);
  if (marks.length) {
    rows.push({ head: t('ddMarks') });
    marks.forEach(({ b }) => rows.push({ kind: 'mark', b }));
  }
  // No access to bookmarks: Chrome only turns on a new permission when the extension itself is reloaded
  // (an unpacked one picks up changed pages without that), so say so instead of skipping them silently.
  if (!chrome.bookmarks) rows.push({ note: t('ddNoMarks') });
  const closed = state.foundClosed.slice(0, DD_CLOSED);
  if (closed.length) {
    rows.push({ head: t('recentlyClosed') });
    closed.forEach((c) => rows.push({ kind: 'closed', c }));
  }
  // History last: pages not already listed above (or open in a tab).
  const shown = new Set([
    ...state.tabs.map((x) => normalizeUrl(urlOf(x))), ...marks.map(({ b }) => normalizeUrl(b.url)), ...closed.map((c) => normalizeUrl(c.url)),
    ...archived.map(({ a }) => normalizeUrl(a.url)),
  ]);
  const visited = historyRows(q, shown);
  if (visited.length) {
    rows.push({ head: t('ddHistory') });
    visited.forEach((x) => rows.push({ kind: 'visit', x }));
  }
  if (!chrome.history) rows.push({ note: t('ddNoHistory') });
  if (!tabs.length && !archived.length && !marks.length && !closed.length && !visited.length) {
    const url = asUrl(state.query.trim());
    if (url) rows.push({ kind: 'url', url });
    rows.push({ kind: 'google' });
  }
  return rows;
}
const ddShown = () => !state.dd.hidden && state.dd.items.length > 0 && !!state.query.trim() && !document.documentElement.classList.contains('alttab');
function ddMove(d) {
  const n = state.dd.items.length;
  state.dd.hi = (((state.dd.hi + d) % n) + n) % n;
  renderDropdown();
}
function renderDropdown() {
  let dd = document.querySelector('.dd');
  const rows = state.query.trim() ? ddRows() : [];
  state.dd.items = rows.filter((r) => r.kind);
  if (state.dd.hi >= state.dd.items.length) state.dd.hi = 0;
  if (!ddShown()) { if (dd) dd.remove(); return; }
  if (!dd) {
    dd = h('div', 'dd');
    dd.setAttribute('role', 'listbox');
    dd.id = 'dd';
    dd.addEventListener('mousedown', (e) => e.preventDefault()); // keep the focus (and the caret) in the search box
    el.app.append(dd);
  }
  const q = state.query.trim();
  let n = -1;
  dd.replaceChildren(...rows.map((r) => {
    if (r.head) return h('div', 'ddh', r.head);
    if (r.note) return h('div', 'ddnote', r.note);
    const i = ++n;
    const row = h('div', 'ddr' + (i === state.dd.hi ? ' on' : ''));
    row.id = 'dd-' + i;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === state.dd.hi));
    if (r.kind === 'tab') {
      const tab = r.entry.tab;
      const pic = h('span', 'ddpic');
      if (r.entry.preview && r.entry.preview.img) { const img = h('img'); img.decoding = 'async'; img.src = r.entry.preview.img; img.alt = ''; pic.append(img); }
      else { const img = h('img', 'ddfav'); img.src = favicon(urlOf(tab)); img.alt = ''; pic.append(img); }
      const txt = h('span', 'ddtxt');
      const note = noteOf(urlOf(tab));
      const noteHit = fieldHit(q.toLowerCase(), note);
      txt.append(hlSpan('ddtitle', tab.title || siteOf(urlOf(tab)) || t('untitled'), q.toLowerCase()), hlSpan('ddsub', siteOf(urlOf(tab)), q.toLowerCase()));
      if (noteHit) txt.append(hlSpan('ddsub ddnote2', note, q.toLowerCase())); // why it came up: its note
      row.append(pic, txt);
      if (note && !noteHit) row.append(h('span', 'ddtag', t('noteTitle')));
      if (tab.windowId !== CTX.srcWin) { const w = state.windows.find((x) => x.id === tab.windowId); if (w) row.append(h('span', 'ddtag', w.label)); }
    } else if (r.kind === 'mark') {
      const icon = h('img', 'ddicon');
      icon.src = favicon(r.b.url);
      icon.alt = '';
      const txt = h('span', 'ddtxt');
      txt.append(hlSpan('ddtitle', r.b.title || siteOf(r.b.url), q.toLowerCase()), hlSpan('ddsub', [siteOf(r.b.url), r.b.path].filter(Boolean).join(' · '), q.toLowerCase()));
      row.append(icon, txt);
      if (state.tabs.some((x) => normalizeUrl(urlOf(x)) === normalizeUrl(r.b.url))) row.append(h('span', 'ddtag', t('ddOpenTab')));
    } else if (r.kind === 'archived') {
      const pic = h('span', 'ddpic');
      const p = state.archivePreviews[normalizeUrl(r.a.url)];
      if (p && p.img) { const img = h('img'); img.decoding = 'async'; img.src = p.img; img.alt = ''; pic.append(img); }
      else { const img = h('img', 'ddfav'); img.src = favicon(r.a.url); img.alt = ''; pic.append(img); }
      const txt = h('span', 'ddtxt');
      const ago = r.a.t ? timeAgo(r.a.t / 1000) : '';
      txt.append(hlSpan('ddtitle', r.a.title || siteOf(r.a.url), q.toLowerCase()), hlSpan('ddsub', [siteOf(r.a.url), ago].filter(Boolean).join(' · '), q.toLowerCase()));
      row.append(pic, txt);
    } else if (r.kind === 'closed') {
      const pic = h('span', 'ddpic');
      if (r.c.preview && r.c.preview.img) { const img = h('img'); img.decoding = 'async'; img.src = r.c.preview.img; img.alt = ''; pic.append(img); }
      else { const img = h('img', 'ddfav'); img.src = favicon(r.c.url); img.alt = ''; pic.append(img); }
      const txt = h('span', 'ddtxt');
      const ago = r.c.ts ? timeAgo(r.c.ts / 1000) : '';
      txt.append(hlSpan('ddtitle', r.c.title || siteOf(r.c.url), q.toLowerCase()), hlSpan('ddsub', [r.c.kind === 'window' ? '' : siteOf(r.c.url), ago].filter(Boolean).join(' · '), q.toLowerCase()));
      row.append(pic, txt);
    } else if (r.kind === 'visit') {
      const icon = h('img', 'ddicon');
      icon.src = favicon(r.x.url);
      icon.alt = '';
      const txt = h('span', 'ddtxt');
      const when = r.x.t ? t('visitedAgo', timeAgo(r.x.t / 1000)) : '';
      txt.append(hlSpan('ddtitle', r.x.title || siteOf(r.x.url), q.toLowerCase()), hlSpan('ddsub', [siteOf(r.x.url), when].filter(Boolean).join(' · '), q.toLowerCase()));
      row.append(icon, txt);
    } else if (r.kind === 'url') {
      const icon = h('img', 'ddicon');
      icon.src = favicon(r.url);
      icon.alt = '';
      row.append(icon, h('span', 'ddtxt ddone', t('ddOpen', q)));
    } else {
      const icon = h('span', 'ddicon ddg', 'G');
      row.append(icon, h('span', 'ddtxt ddone', t('ddGoogle', q)));
    }
    row.addEventListener('mousemove', () => { if (state.dd.hi !== i) { state.dd.hi = i; dd.querySelectorAll('.ddr').forEach((x, k) => { x.classList.toggle('on', k === i); x.setAttribute('aria-selected', String(k === i)); }); } });
    row.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) ddActivate(r); });
    return row;
  }));
  el.search.setAttribute('aria-activedescendant', 'dd-' + state.dd.hi);
  // Under the search box, as wide as it (at least 460 px), within the window.
  const box = el.search.closest('.search').getBoundingClientRect();
  const w = Math.min(window.innerWidth - 24, Math.max(460, box.width));
  dd.style.width = w + 'px';
  dd.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, box.left + box.width / 2 - w / 2)) + 'px';
  dd.style.top = (box.bottom + 6) + 'px';
  dd.style.maxHeight = Math.max(160, window.innerHeight - box.bottom - 24) + 'px';
  const on = dd.querySelector('.ddr.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
async function ddActivate(r) {
  if (!r || state.done) return;
  if (r.kind === 'closed') return restoreClosed(r.c);
  if (r.kind === 'archived') return openArchived(r.a);
  if (r.kind === 'tab') {
    const i = state.entries.findIndex((e) => e.key === r.entry.key); // its card, when the cards show it
    if (i >= 0) return choose(i);
    try { await chrome.tabs.update(r.entry.tab.id, { active: true }); await chrome.windows.update(r.entry.tab.windowId, { focused: true }); } catch {}
    return finish('switch');
  }
  if (r.kind === 'mark') return openPage(r.b.url);
  if (r.kind === 'visit') return openPage(r.x.url);
  return openFromBox(state.query.trim()); // 'url' and 'google'
}
// Reopen a recently closed tab (or window), into the window Tabazing was opened from; Chrome's own
// entries come back with their history.
async function restoreClosed(c) {
  try {
    if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
    if (c.session) await chrome.sessions.restore((c.session.tab || c.session.window).sessionId);
    else await chrome.tabs.create({ url: c.url, windowId: CTX.srcWin, active: true });
    finish('restore');
  } catch (e) {
    console.warn('[Tabazing] could not reopen:', e && e.message);
    finish('cancel');
  }
}
// A page by address: its tab if one is open, else a new tab in the window Tabazing was opened from.
async function openPage(url) {
  const k = normalizeUrl(url);
  const tab = state.tabs.find((x) => normalizeUrl(urlOf(x)) === k);
  try {
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      if (CTX.mode === 'window' || tab.windowId !== CTX.srcWin) await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
      await chrome.tabs.create({ url, windowId: CTX.srcWin, active: true });
    }
  } catch {}
  finish('switch');
}

// ---- merge windows: pull every tab of other windows (`ids`) into this one, after the tabs it has.
// Pinned tabs stay pinned. The emptied windows close by themselves. Two clicks (`key` arms it).
async function mergeWindows(ids, key) {
  if (!ids.length || !armed(key)) return;
  let moved = 0;
  for (const id of ids) {
    let tabs = [];
    try { tabs = await chrome.tabs.query({ windowId: id }); } catch { continue; }
    if (!tabs.length) continue;
    try {
      await chrome.tabs.move(tabs.map((x) => x.id), { windowId: CTX.srcWin, index: -1 });
      for (const x of tabs) if (x.pinned) await chrome.tabs.update(x.id, { pinned: true }).catch(() => {});
      moved += tabs.length;
    } catch (e) { console.warn('[Tabazing] could not merge a window:', e && e.message); }
  }
  toast(tn('mergedN', moved));
  if (state.scope !== 'all') state.scope = 'all';
  await reload();
}

// ---- snooze: close tabs now and have the background reopen them later (chrome.alarms).
function snoozeChoices(now = new Date()) {
  const at = (d, h) => { const x = new Date(now); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x.getTime(); };
  const out = [
    { label: t('snooze1h'), at: now.getTime() + 3600e3 },
    { label: t('snooze3h'), at: now.getTime() + 3 * 3600e3 },
  ];
  if (now.getHours() < 17) out.push({ label: t('snoozeEvening'), at: at(0, 18) });
  out.push({ label: t('snoozeTomorrow'), at: at(1, 9) });
  out.push({ label: t('snoozeWeek'), at: at(((8 - now.getDay()) % 7) || 7, 9) }); // next Monday
  return out.map((c) => ({ ...c, label: c.label + ' · ' + whenLabel(c.at) }));
}
// "Fri 09:00", or just "18:00" today.
function whenLabel(ts) {
  const d = new Date(ts), today = new Date();
  const time = d.toLocaleTimeString(uiLang(), { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : d.toLocaleDateString(uiLang(), { weekday: 'short' }) + ' ' + time;
}
function snoozeMenu(tabs, anchor) {
  menu(anchor, snoozeChoices().map((c) => ({ label: c.label, fn: () => snoozeTabs(tabs, c.at) })));
}
async function snoozeTabs(tabs, at) {
  const can = tabs.filter((x) => isWorthReopening(urlOf(x)));
  if (!can.length) return toast(t('snoozeCant'));
  const now = Date.now();
  const items = can.map((x, i) => ({ id: `${x.id}-${now}-${i}`, url: urlOf(x), title: x.title || '', at, windowId: x.windowId, pinned: !!x.pinned, t: now }));
  state.snoozed = await addSnoozed(items);
  const ids = can.map((x) => x.id);
  const own = CTX.mode === 'overlay' && ids.includes(CTX.srcTab); // closing the tab we sit on closes us: do it last
  await chrome.tabs.remove(ids.filter((id) => !own || id !== CTX.srcTab)).catch(() => {});
  state.picked.clear();
  if (own) return chrome.tabs.remove(CTX.srcTab);
  ids.forEach((id) => forgetTab(id));
  toast(tn('snoozedN', items.length, whenLabel(at)), null, { label: t('undo'), fn: () => unsnooze(items) });
}
// Undo a snooze: forget it and reopen the tabs where they were.
async function unsnooze(items) {
  state.snoozed = await removeSnoozed(items.map((x) => x.id)).catch(() => state.snoozed);
  for (const x of items) {
    try { await chrome.tabs.create({ url: x.url, windowId: x.windowId, active: false, pinned: x.pinned }); }
    catch { await chrome.tabs.create({ url: x.url, windowId: CTX.srcWin, active: false }).catch(() => {}); }
  }
  toast(tn('reopenedN', items.length));
  await reload();
}

// ---- drag to reorder ("By order" only: there the cards are the tab strip, so a drop is a real move).
// Drag a card (or the ticked cards) onto the left or right half of another to put it before or after.
let dragIds = null; // tab ids being dragged
const clearDrop = () => document.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
const dropAfter = (card, e) => { const r = card.getBoundingClientRect(); return e.clientX > r.left + r.width / 2; };
function dragToMove(card, tab) {
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    dragIds = state.picked.has(tab.id) ? [...state.picked] : [tab.id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', urlOf(tab));
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => { dragIds = null; card.classList.remove('dragging'); clearDrop(); });
  card.addEventListener('dragover', (e) => {
    if (!dragIds || dragIds.includes(tab.id)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const after = dropAfter(card, e);
    if (card.classList.contains(after ? 'drop-after' : 'drop-before')) return;
    clearDrop();
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });
  card.addEventListener('dragleave', (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove('drop-before', 'drop-after'); });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    const ids = dragIds, after = dropAfter(card, e);
    clearDrop();
    if (ids && pointerAllowed()) moveTabs(ids, tab, after).catch((err) => toast(t('actFailed'), err));
  });
}
// Move tabs, in their tab-strip order, to just before or after `target`. One at a time, each placed
// right after the one before it, reading fresh positions every step (each move shifts the others).
async function moveTabs(ids, target, after) {
  const moving = state.tabs.filter((x) => ids.includes(x.id) && x.id !== target.id).sort((a, b) => a.index - b.index);
  let anchor = target.id, behind = after;
  for (const x of moving) {
    const [cur, at] = await Promise.all([chrome.tabs.get(x.id), chrome.tabs.get(anchor)]);
    let index = at.index + (behind ? 1 : 0);
    if (cur.windowId === at.windowId && cur.index < index) index--; // it leaves its old place first
    await chrome.tabs.move(x.id, { windowId: at.windowId, index }); // (into another window, with Show all windows)
    anchor = x.id; behind = true;
  }
  state.picked.clear();
  await reload();
}

// Unloading a tab makes Chrome swap it out for a moment, which would jolt the switcher. So a tab put to
// sleep here is only marked (a moon on its card); it is unloaded as Tabazing closes. Clicking again unmarks.
async function sleepTabs(tabs) {
  const can = tabs.filter((x) => !x.active && !x.discarded); // Chrome won't unload the tab you're looking at
  if (!can.length) return toast(t('sleptNone'));
  const undo = can.every((x) => state.toSleep.has(x.id));
  can.forEach((x) => (undo ? state.toSleep.delete(x.id) : state.toSleep.add(x.id)));
  state.picked.clear();
  toast(undo ? t('sleepUndone') : tn('sleepLaterN', can.length));
  refresh();
}

async function pinTabs(tabs) {
  const pin = !tabs.every((x) => x.pinned);
  for (const x of tabs) await chrome.tabs.update(x.id, { pinned: pin }).catch(() => {});
  toast(tn(pin ? 'pinnedN' : 'unpinnedN', tabs.length));
  await reload();
}

async function muteTabs(tabs) {
  const mute = !tabs.every((x) => x.mutedInfo && x.mutedInfo.muted);
  for (const x of tabs) await chrome.tabs.update(x.id, { muted: mute }).catch(() => {});
  toast(tn(mute ? 'mutedN' : 'unmutedN', tabs.length));
  await reload();
}

// Pages open more than once (same address, ignoring the #part and a trailing slash).
function dupeUrls() {
  const n = new Map();
  for (const x of state.tabs) { const k = normalizeUrl(urlOf(x)); if (k && /^https?:|^file:/.test(urlOf(x))) n.set(k, (n.get(k) || 0) + 1); }
  return new Set([...n].filter(([, c]) => c > 1).map(([k]) => k));
}
// The same page open more than once: keep one (pinned first, then the most recently used), close the rest.
function duplicates() {
  const seen = new Map();
  const dupes = [];
  const order = [...state.tabs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)); // state.tabs is most recent first
  for (const x of order) {
    const k = normalizeUrl(urlOf(x));
    if (!k || !/^https?:|^file:/.test(urlOf(x))) continue;
    if (seen.has(k)) dupes.push(x); else seen.set(k, x);
  }
  return dupes;
}
async function closeDupes() {
  if (!state.dupesView) return dupesView(true); // first show which tabs are copies
  const d = duplicates();
  if (!d.length || !armed('act:dupes')) return;
  state.dupesView = false;
  await closeMany(d);
}

// ---- sound: a speaker in the header of a tab that is playing (a crossed-out one when muted), and a
// mute button among every card's quick buttons. Both mute or unmute just that tab.
const isMuted = (tab) => !!(tab.mutedInfo && tab.mutedInfo.muted);
function audioBadge(tab) {
  const muted = isMuted(tab);
  const b = h('button', 'badge audio' + (muted ? '' : ' on'));
  b.type = 'button';
  b.innerHTML = muted ? ICON.muted : ICON.speaker;
  b.title = t(muted ? 'unmuteThis' : 'muteThis');
  b.setAttribute('aria-label', b.title);
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) toggleMute(tab).catch((err) => toast(t('actFailed'), err)); });
  return b;
}
// Pin / unpin one tab. Chrome moves it to (or out of) the pinned tabs at the start of the tab strip,
// so the list is read again.
async function togglePin(tab) {
  const pinned = !tab.pinned;
  try {
    await chrome.tabs.update(tab.id, { pinned });
  } catch (e) {
    // "Tabs cannot be edited right now": Chrome is busy with the tab strip for a moment. Once more.
    await new Promise((r) => setTimeout(r, 150));
    try { await chrome.tabs.update(tab.id, { pinned }); }
    catch (e2) { await reload(); return toast(t('actFailed') + ': ' + String((e2 && e2.message) || e2).slice(0, 120), e2); }
  }
  await reload(); // what Chrome now has, whatever happened
  const now = state.tabs.find((x) => x.id === tab.id);
  toast(t(now && now.pinned ? 'pinnedOne' : 'unpinnedOne', tab.title || siteOf(urlOf(tab))));
}
async function toggleMute(tab) {
  const muted = !isMuted(tab);
  await chrome.tabs.update(tab.id, { muted });
  tab.mutedInfo = { ...(tab.mutedInfo || {}), muted }; // show it right away
  refresh({ keepKey: 't' + tab.id });
}

// Reload a tab (a sleeping one wakes up). The page Tabazing is drawn over (overlay) reloads with it gone.
async function reloadTab(tab) {
  await chrome.tabs.reload(tab.id);
  if (CTX.mode === 'overlay' && tab.id === CTX.srcTab) return finish('cancel');
  toast(t('reloadingOne', tab.title || siteOf(urlOf(tab))));
}
// Duplicate a tab: the copy opens right after it, in the background, so Tabazing stays open and shows it.
async function duplicateTab(tab) {
  await chrome.tabs.create({ url: urlOf(tab), windowId: tab.windowId, index: tab.index + 1, active: false, pinned: !!tab.pinned, openerTabId: tab.id });
  await reload();
  toast(t('duplicatedOne', tab.title || siteOf(urlOf(tab))));
}

// ---- the archive: tabs moved into the "Tabs Archive" bookmarks folder (in "Other bookmarks", lib/archive.js).
// Archiving bookmarks a tab there and closes it; opening it from the archive (its overlay, or the search's
// "Archived" section) takes it out of the folder and opens it in a new tab.
async function loadArchived() {
  state.archived = await getArchived().catch(() => []);
  state.archivePreviews = await getPreviews(state.archived.map((x) => x.url)).catch(() => ({}));
}
async function archiveTabs(tabs) {
  const can = tabs.filter((x) => isWorthReopening(urlOf(x)));
  if (!can.length) return toast(t('archiveCant'));
  if (!chrome.bookmarks) return toast(t('ddNoMarks'));
  const undo = undoRecord(can);
  const added = await addArchived(can.map((x) => ({ url: urlOf(x), title: x.title || '' })));
  await loadArchived(); // before the tabs close, so "Recently closed" leaves them out
  const ids = can.map((x) => x.id);
  const own = CTX.mode === 'overlay' && ids.includes(CTX.srcTab); // closing the tab we sit on closes us: do it last
  await chrome.tabs.remove(ids.filter((id) => !own || id !== CTX.srcTab)).catch(() => {});
  state.picked.clear();
  if (own) return chrome.tabs.remove(CTX.srcTab);
  ids.forEach((id) => forgetTab(id));
  toast(tn('archivedN', added.length), null, { label: t('undo'), fn: () => unarchive(added, undo) });
}
// Undo an archive: out of the folder, and the tabs back where they were.
async function unarchive(added, group) {
  await removeArchived(added.map((x) => x.id));
  await reopenAt(group);
  toast(tn('reopenedN', group.length));
  await reload();
}
// Open an archived page: out of the archive, into a new tab in the window Tabazing was opened from.
async function openArchived(item) {
  if (state.done) return;
  try {
    await removeArchived([item.id]);
    if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
    await chrome.tabs.create({ url: item.url, windowId: CTX.srcWin, active: true });
    finish('switch');
  } catch (e) {
    console.warn('[Tabazing] could not open an archived tab:', e && e.message);
    finish('cancel');
  }
}

// The archive overlay (the Archive button, top right): every archived tab, over the switcher. The red ×
// or Esc closes it; clicking a card opens that tab, its × (or Del) takes it out of the archive without
// opening it. Arrows move, Enter opens. `sel` is the card to select (redrawn after a removal).
const archiveOpen = () => !!document.querySelector('.arch');
async function openArchive(sel = 0) {
  closePops();
  closeBig();
  hideTip();
  state.dd.hidden = true;
  renderDropdown();
  await loadArchived();
  if (state.done) return;
  let back = document.querySelector('.arch');
  if (!back) {
    back = h('div', 'arch');
    back.setAttribute('role', 'dialog');
    back.setAttribute('aria-modal', 'true');
    back.setAttribute('aria-labelledby', 'arch-h');
    back.addEventListener('click', (e) => e.stopPropagation()); // its empty space doesn't close the switcher
    el.app.append(back);
  }
  const head = h('div', 'archhead');
  const title = h('h2', 'archtitle', t('archiveTitle'));
  title.id = 'arch-h';
  title.append(h('span', 'n', String(state.archived.length)));
  const x = h('button', 'archx');
  x.type = 'button';
  x.innerHTML = ICON.close;
  x.title = t('archiveClose') + ' (Esc)';
  x.setAttribute('aria-label', t('archiveClose'));
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeArchive(); });
  head.append(title, h('span', 'archsub', t('archiveWhere')), x);
  const body = h('div', 'archbody');
  if (!chrome.bookmarks) body.append(h('p', 'empty', t('ddNoMarks')));
  else if (!state.archived.length) body.append(h('p', 'empty', t('archiveEmpty')));
  else {
    const grid = h('div', 'grid' + (state.cardSize === 'default' ? '' : ' ' + state.cardSize));
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-labelledby', 'arch-h');
    grid.append(...state.archived.map((item, i) => archiveCard(item, i)));
    body.append(grid);
  }
  back.replaceChildren(head, body);
  archSelect(sel);
  x.focus({ preventScroll: true });
}
function archiveCard(item, i) {
  const entry = { kind: 'archived', item, url: item.url, preview: state.archivePreviews[normalizeUrl(item.url)] || null };
  const title = item.title || hostOf(item.url) || t('untitled');
  const card = h('div', 'card');
  card.id = 'arch-' + item.id;
  card.setAttribute('role', 'option');
  card.title = t('archiveOpenTip', title) + '\n' + item.url;
  const head = h('div', 'head');
  const fav = h('img', 'fav');
  fav.src = favicon(item.url);
  fav.alt = '';
  head.append(fav, h('span', 'title', title));
  const ago = timeAgo(item.t / 1000);
  if (ago) head.append(h('span', 'tag', ago));
  const x = h('button', 'x');
  x.type = 'button';
  x.title = t('archiveRemove') + (IS_MAC ? ' (⌘⌫)' : ' (Del)');
  x.setAttribute('aria-label', t('archiveRemove'));
  x.innerHTML = ICON.close;
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) dropArchived(item, i).catch((err) => toast(t('actFailed'), err)); });
  head.append(x);
  card.append(head);
  if (state.cardSize !== 'list') card.append(thumbFor(entry, { label: entry.preview ? '' : t('archivedLabel'), sub: hostOf(item.url), icon: ICON.archive }));
  card.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) openArchived(item); });
  card.addEventListener('mousemove', () => { if (state.archSel !== i) archSelect(i, false); });
  return card;
}
// Take a page out of the archive without opening it (the × on its card, or Del). Undo puts it back.
async function dropArchived(item, i) {
  await removeArchived([item.id]);
  await openArchive(i);
  toast(t('archiveRemoved'), null, { label: t('undo'), fn: async () => { await addArchived([item]); if (archiveOpen()) await openArchive(i); } });
}
function archSelect(i, scroll = true) {
  const cards = [...document.querySelectorAll('.arch .card')];
  if (!cards.length) return;
  state.archSel = Math.max(0, Math.min(cards.length - 1, i));
  cards.forEach((c, k) => c.setAttribute('aria-selected', String(k === state.archSel)));
  cards[state.archSel].closest('[role=listbox]').setAttribute('aria-activedescendant', cards[state.archSel].id);
  if (scroll) cards[state.archSel].scrollIntoView({ block: 'nearest' });
}
function closeArchive() {
  document.querySelectorAll('.arch').forEach((n) => n.remove());
  el.search.focus({ preventScroll: true });
}
// While the archive is open it has the keyboard.
function archiveKey(e) {
  const k = e.key;
  if (MODIFIERS.has(k)) return;
  e.preventDefault();
  e.stopPropagation();
  if (k === 'Escape') return closeArchive();
  const cards = [...document.querySelectorAll('.arch .card')];
  if (!cards.length) return;
  if (k === 'Delete' || (IS_MAC && e.metaKey && k === 'Backspace')) {
    if (e.repeat) return;
    if (!keysAllowed()) return finish('cancel');
    return dropArchived(state.archived[state.archSel], state.archSel).catch((err) => toast(t('actFailed'), err));
  }
  if (k === 'Enter') {
    if (!keysAllowed()) return finish('cancel');
    return openArchived(state.archived[state.archSel]);
  }
  if (k === 'ArrowRight' || k === 'ArrowLeft') return archSelect(state.archSel + (k === 'ArrowRight' ? 1 : -1));
  if (k === 'ArrowDown' || k === 'ArrowUp') { const j = cardToward(cards, state.archSel, k === 'ArrowDown' ? 1 : -1); if (j >= 0) archSelect(j); }
}

function quickActions(entry) {
  const box = h('div', 'quick');
  const mk = (icon, title, fn) => {
    const b = h('button', 'qbtn');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = ICON[icon];
    b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) fn().catch((err) => toast(t('actFailed'), err)); });
    return b;
  };
  box.append(mk('link', t('copyLink'), () => copyLinks([entry.tab], 'plain')));
  box.append(mk('reload', t('reloadThis'), () => reloadTab(entry.tab)), mk('dupe', t('duplicateThis'), () => duplicateTab(entry.tab)));
  const mute = mk(isMuted(entry.tab) ? 'muted' : 'speaker', t(isMuted(entry.tab) ? 'unmuteThis' : 'muteThis'), () => toggleMute(entry.tab));
  const pin = mk('pin', t(entry.tab.pinned ? 'unpinThis' : 'pinThis'), () => togglePin(entry.tab));
  const snooze = mk('clock', t('snoozeThis'), async () => snoozeMenu([entry.tab], snooze));
  const archive = mk('archive', t('archiveThis'), () => archiveTabs([entry.tab]));
  if (entry.tab.pinned) pin.classList.add('on'); // on: like a note button with a note
  if (isMuted(entry.tab)) mute.classList.add('on');
  if (!entry.tab.active && !entry.tab.discarded) box.append(mk('moon', t(state.toSleep.has(entry.tab.id) ? 'sleepUndo' : 'sleepThis'), () => sleepTabs([entry.tab])));
  box.append(mute, pin, snooze, archive, noteButton(entry)); // the note last: always in the same place, sleep or not
  return box;
}

// ---- a note on a tab (kept by its address, like stars). The button is accent-coloured while there is
// a note and hovering it shows the note; with no note it shows no tooltip at all (not even the card's).
const noteOf = (url) => (state.notes[normalizeUrl(url)] || {}).n || '';
function paintNote(b, text) {
  b.classList.toggle('on', !!text);
  b.dataset.note = text; // shown by our own tooltip (noteTip), quicker than Chrome's and in Tabazing's style
  b.title = ''; // no Chrome tooltip here, not even the card's
  b.setAttribute('aria-label', text ? t('noteEdit') + ': ' + text : t('noteAdd'));
}
function noteButton(entry) {
  const b = h('button', 'qbtn note');
  b.type = 'button';
  b.innerHTML = ICON.note;
  paintNote(b, noteOf(entry.url));
  b.addEventListener('click', (e) => { e.stopPropagation(); hideTip(); if (pointerAllowed()) notePopover(entry.url, b); });
  b.addEventListener('mouseenter', () => noteTip(b));
  b.addEventListener('focus', () => { if (b.matches(':focus-visible')) noteTip(b); });
  b.addEventListener('mouseleave', hideTip);
  b.addEventListener('blur', hideTip);
  return b;
}

// The note tooltip: shows 150 ms after the pointer reaches a note button that has a note (Chrome's
// own waits about half a second), below the button, or above it when there is no room.
const TIP_DELAY_MS = 150;
let tipTimer = null;
function noteTip(b) {
  clearTimeout(tipTimer);
  const text = b.dataset.note;
  if (!text || document.querySelector('.notepop')) return;
  tipTimer = setTimeout(() => {
    if (!b.isConnected) return;
    hideTip();
    const tip = h('div', 'tip');
    tip.setAttribute('role', 'tooltip');
    tip.append(h('span', 'tiph', t('noteTitle')), h('span', 'tipt', text));
    el.app.append(tip);
    const r = b.getBoundingClientRect(), w = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    const below = r.bottom + 8 + th <= window.innerHeight - 8;
    tip.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - th - 8)) + 'px';
    tip.classList.add(below ? 'below' : 'above');
  }, TIP_DELAY_MS);
}
function hideTip() {
  clearTimeout(tipTimer);
  document.querySelectorAll('.tip').forEach((x) => x.remove());
}
// Click the note button: a small card with a text box opens below it. Closing it (click elsewhere,
// Esc, or the button again) saves what is written; it is also saved while typing, because picking
// a tab closes Tabazing straight away. An empty box removes the note.
function notePopover(url, anchor) {
  const open = document.querySelector('.notepop');
  closePops();
  if (open && open.anchor === anchor) return; // the same button again: just close it
  const pop = h('div', 'pop notepop');
  pop.anchor = anchor;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('noteTitle'));
  const box = h('textarea');
  box.value = noteOf(url);
  box.placeholder = t('notePh');
  box.maxLength = LIMITS.NOTE_MAX;
  box.setAttribute('aria-label', t('noteTitle'));
  // Top right: "Clear" (red; removes the note, the card stays open to write a new one; shown while there is
  // text), then × (closes the card, keeping what was written).
  const clear = h('button', 'noteclear', t('noteClearBtn'));
  clear.type = 'button';
  clear.title = t('noteClear');
  clear.hidden = !box.value;
  clear.addEventListener('click', (e) => { e.stopPropagation(); box.value = ''; clear.hidden = true; clearTimeout(timer); save(); box.focus(); });
  const x = h('button', 'noteclose');
  x.type = 'button';
  x.title = t('noteCloseBtn');
  x.setAttribute('aria-label', t('noteCloseBtn'));
  x.innerHTML = ICON.close;
  x.addEventListener('click', (e) => { e.stopPropagation(); pop.close(); el.search.focus({ preventScroll: true }); });
  const tools = h('div', 'notetools');
  tools.append(clear, x);
  pop.append(h('label', '', t('noteTitle')), tools, box, h('p', 'pfine', t('noteHint')));
  const save = () => setNote(url, box.value).then((notes) => { state.notes = notes; paintNote(anchor, noteOf(url)); }).catch(() => {});
  let timer = null;
  box.addEventListener('input', () => { clear.hidden = !box.value; clearTimeout(timer); timer = setTimeout(save, 400); });
  const outside = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) pop.close(); };
  pop.close = () => {
    clearTimeout(timer);
    document.removeEventListener('mousedown', outside, true);
    pop.remove();
    save();
  };
  pop.addEventListener('click', (e) => e.stopPropagation());
  el.app.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(12, Math.min(window.innerWidth - 302, r.right - 290)) + 'px';
  const ph = pop.offsetHeight;
  pop.style.top = (r.bottom + 6 + ph > window.innerHeight - 8 ? Math.max(8, r.top - ph - 6) : r.bottom + 6) + 'px';
  setTimeout(() => { document.addEventListener('mousedown', outside, true); box.focus(); box.setSelectionRange(box.value.length, box.value.length); }, 0);
}

// ---- big preview: Ctrl+click a card to see its screenshot large in the middle of the screen.
// The × in its corner, Esc, or a click on the dark area around it closes it; Enter opens that tab.
let bigEntry = null;
function openBig(entry) {
  closePops();
  closeBig();
  hideTip();
  bigEntry = entry;
  const url = entry.url || (entry.tab ? urlOf(entry.tab) : entry.item.url);
  const title = (entry.tab ? entry.tab.title : entry.item.title) || hostOf(url) || t('untitled');
  const back = h('div', 'bigback');
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  back.setAttribute('aria-label', t('bigTitle', title));
  const box = h('div', 'bigbox');
  const head = h('div', 'bighead');
  const fav = h('img', 'fav');
  fav.src = favicon(url);
  fav.alt = '';
  head.append(fav, h('span', 'title', title), h('span', 'host', siteOf(url)));
  const x = h('button', 'bigx');
  x.type = 'button';
  x.innerHTML = ICON.close;
  x.title = t('bigClose') + ' (Esc)';
  x.setAttribute('aria-label', t('bigClose'));
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeBig(); });
  let shot;
  if (entry.preview && entry.preview.img) {
    // The card's small copy at once, then the sharp copy of the same capture as soon as it is read.
    shot = h('img', 'bigshot');
    shot.src = entry.preview.img;
    shot.alt = t('bigTitle', title);
    getSharpPreview(url).then((p) => {
      if (!p || !shot.isConnected) return;
      const sharp = new Image();
      sharp.onload = () => { if (shot.isConnected) shot.src = p.img; };
      sharp.src = p.img;
    }).catch(() => {});
  } else {
    shot = h('div', 'bignone');
    const img = h('img');
    img.src = favicon(url);
    img.alt = '';
    shot.append(img, h('span', '', t('noPreview')));
  }
  box.append(head, x, shot);
  box.addEventListener('click', (e) => e.stopPropagation());
  back.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeBig(); });
  back.append(box);
  el.app.append(back);
  x.focus({ preventScroll: true });
}
function closeBig() {
  document.querySelectorAll('.bigback').forEach((n) => n.remove());
  if (bigEntry) { bigEntry = null; el.search.focus({ preventScroll: true }); }
}

// Close the open menu or card (a note card saves itself as it closes).
function closePops() { document.querySelectorAll('.pop, .menu').forEach((x) => (x.close ? x.close() : x.remove())); }

// A small menu next to a button: [{ label, fn, danger, sure }]; `sure` items ask again before acting.
// opts: { keepPops } leaves an open card (Settings) open; { width, alignLeft } for a select's list.
// Items may be { on: true } (ticked: the current choice). ↑/↓ move, Esc closes and goes back to `anchor`.
function menu(anchor, items, opts = {}) {
  // Its button again while it is open: just close it (a toggle).
  const open = [...document.querySelectorAll('.menu')].find((x) => x.anchor === anchor);
  if (opts.keepPops) document.querySelectorAll('.menu').forEach((x) => x.remove()); else closePops();
  if (open) return;
  const m = h('div', 'menu');
  m.anchor = anchor;
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (!it) { m.append(h('hr')); continue; }
    const b = h('button', 'mi' + (it.danger ? ' danger' : '') + (it.on ? ' on' : ''), it.label);
    b.type = 'button';
    b.setAttribute('role', it.on !== undefined ? 'menuitemradio' : 'menuitem');
    if (it.on !== undefined) { b.setAttribute('aria-checked', String(!!it.on)); if (it.on) b.insertAdjacentHTML('beforeend', ICON.check); }
    let armedOnce = false;
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!pointerAllowed()) return;
      if (it.sure && !armedOnce) { armedOnce = true; b.textContent = it.sure; b.classList.add('armed'); return; }
      m.remove();
      try { await it.fn(); } catch (err) { toast(t('actFailed'), err); }
    });
    m.append(b);
  }
  m.addEventListener('click', (e) => e.stopPropagation());
  m.addEventListener('keydown', (e) => {
    const bs = [...m.querySelectorAll('.mi')];
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); bs[e.key === 'Home' ? 0 : bs.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); m.remove(); anchor.focus({ preventScroll: true }); }
  });
  el.app.append(m);
  const r = anchor.getBoundingClientRect();
  if (opts.width) m.style.width = opts.width + 'px';
  const w = m.offsetWidth;
  m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, opts.alignLeft ? r.left : r.right - w)) + 'px';
  const below = r.bottom + 6, h0 = m.offsetHeight;
  m.style.top = (below + h0 > window.innerHeight - 8 ? Math.max(8, r.top - h0 - 6) : below) + 'px';
  // A press outside closes it; on its own button the click that follows does (above), or it would reopen at once.
  const close = (e) => {
    if (!m.isConnected) return document.removeEventListener('mousedown', close, true);
    if (!m.contains(e.target) && !anchor.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', close, true); }
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  (m.querySelector('.mi.on') || m.querySelector('button')).focus({ preventScroll: true });
}

// A themed stand-in for a <select> (Chrome draws a select's list itself, unstyleable): a button showing
// the choice that opens a menu of the options, the current one ticked in the accent colour. The real
// <select> stays, hidden, and still gets the value and the change event, so everything else is unchanged.
function fancySelect(sel, { inPop = false } = {}) {
  if (sel._fancy) return sel._fancy;
  sel.classList.add('fs-native');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');
  const b = h('button', 'fs');
  b.type = 'button';
  b.setAttribute('aria-haspopup', 'menu');
  const label = h('span', 'fsl');
  const chev = h('span', 'fsc');
  chev.innerHTML = ICON.chevron;
  b.append(label, chev);
  const sync = () => {
    label.textContent = (sel.options[sel.selectedIndex] || {}).textContent || '';
    b.setAttribute('aria-label', (sel.getAttribute('aria-label') || '') + ': ' + label.textContent);
  };
  const open = () => menu(b, [...sel.options].map((o) => ({
    label: o.textContent, on: o.value === sel.value,
    fn: () => { if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change')); } sync(); b.focus({ preventScroll: true }); },
  })), { keepPops: inPop, alignLeft: true, width: Math.max(b.offsetWidth, 190) });
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) open(); });
  b.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
  sel.after(b);
  sync();
  sel._fancy = { sync, button: b };
  return sel._fancy;
}

// ---------------------------------------------------------------- dialogs
// Two dialogs live in the switcher: the first-run tour and the review prompt. While one is
// open it owns the keyboard (Esc closes it, not the switcher). Neither is shown while Alt is
// still held from the shortcut, so a quick Alt+Q flick is never interrupted.
let asking = false; // a browser permission prompt is open: its focus change must not close us

const K = (win, mac) => h('kbd', '', IS_MAC && mac ? mac : win);
const para = (...parts) => { const p = h('p'); p.append(...parts); return p; };
const list = (...items) => { const u = h('ul'); items.forEach((it) => { const li = h('li'); li.append(...[].concat(it)); u.append(li); }); return u; };
const button = (label, cls, fn) => { const b = h('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) fn(); }); return b; };

function showDialog(kind, nodes) {
  state.modal = kind;
  el.dialog.replaceChildren(...nodes);
  el.modal.hidden = false;
  el.modal.classList.toggle('tour', kind === 'tour');
  el.dialog.classList.toggle('manual', kind === 'tour');
  const first = el.dialog.querySelector('textarea, .primary') || el.dialog.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}
function closeDialog() {
  state.modal = null;
  el.modal.hidden = true;
  document.querySelectorAll('.tour-hl').forEach((n) => n.classList.remove('tour-hl'));
  el.search.focus({ preventScroll: true });
}
function whenTapMode(fn) {
  const t0 = performance.now();
  const tick = () => {
    if (state.done || state.modal || el.search.value) return; // closed, or already busy: don't interrupt
    if (!state.holding) return fn();
    if (performance.now() - t0 < 10000) setTimeout(tick, 150); // Alt still held from the shortcut: wait for the release
  };
  setTimeout(tick, 350);
}

// ---- first-run tour: short cards in the accent colour, each pointing at what it explains.
const keyRows = (...rows) => { const d = h('div', 'keys'); rows.forEach(([keys, word]) => { const k = h('span'); k.append(...keys); d.append(k, h('span', '', word)); }); return d; };
const ALT = IS_MAC ? '⌥' : 'Alt+';
const TOUR_ALL = [
  { id: 'switch', title: () => t('tourSwitchTitle'), hl: '.card[aria-selected="true"]', body: () => [
    para(t('tourSwitchBody')),
    keyRows([[K(ALT + 'Q')], t('keyPrevTab')], [[K(ALT + 'W')], t('keyNextTab')], [[K(ALT + 'E')], t('keyStay')])] },
  { id: 'move', title: () => t('tour2Title'), hl: '.card[aria-selected="true"]', body: () => [
    keyRows([[K('←'), K('→'), K('↑'), K('↓')], t('keyPick')], [[K('1'), K('…'), K('9')], t('keyNumber')], [[K('Enter')], t('keyOpen')], [[K('Space')], t('keyPreview')],
      [[K('Del', '⌘⌫')], t('keyClose')], [[K('Ctrl+Z', '⌘Z')], t('keyUndo')], [[K('Esc')], t('keyLeave')])] },
  { id: 'search', title: () => t('tour3Title'), hl: '.search', body: () => [para(t('tour3Body')), keyRows([[K('Ctrl+F', '⌘F')], t('keySearch')])] },
  { id: 'cards', title: () => t('tourCardsTitle'), hl: '.card[aria-selected="true"]', body: () => [para(t('tourCardsBody')), para(t('tourCardsMouse'))] },
  { id: 'many', title: () => t('tourManyTitle'), hl: '.card[aria-selected="true"] .head', body: () => [para(t('tourManyBody'))] },
  { id: 'sort', title: () => t('tourSortTitle'), hl: '.sortbox', body: () => [para(t('tourSortBody'))] },
  { id: 'settings', title: () => t('tourSetTitle'), hl: '#settings-btn', body: () => [para(t('tourSetBody'))] },
];
let TOUR = TOUR_ALL;
let tourAt = 0;
function tourStep(i) {
  if (i === 0) TOUR = TOUR_ALL.filter((x) => !x.when || x.when());
  tourAt = Math.max(0, Math.min(TOUR.length - 1, i));
  const step = TOUR[tourAt];
  const last = tourAt === TOUR.length - 1;
  document.querySelectorAll('.tour-hl').forEach((n) => n.classList.remove('tour-hl'));
  const sel = typeof step.hl === 'function' ? step.hl() : step.hl;
  const target = sel && document.querySelector(sel);
  if (target) target.classList.add('tour-hl');
  const row = h('div', 'row');
  row.append(h('span', 'stepof', `${tourAt + 1} / ${TOUR.length}`), h('span', 'grow'));
  if (tourAt > 0) row.append(button(t('back'), 'quiet', () => tourStep(tourAt - 1)));
  if (!last) row.append(button(t('skip'), 'quiet', endTour));
  row.append(button(t(last ? 'done' : 'next'), 'primary', () => (last ? endTour() : tourStep(tourAt + 1))));
  const title = h('h3', '', step.title());
  title.id = 'dlg-title';
  const num = h('span', 'num', String(tourAt + 1));
  showDialog('tour', [num, title, ...step.body(), row]);
  placeTour(target);
}

// The tour card sits next to what it talks about, on the side with the most room, so it covers as
// little of the switcher as it can. With nothing to point at, it sits in the middle.
function placeTour(target) {
  const d = el.dialog;
  d.style.left = d.style.top = '';
  d.removeAttribute('data-side');
  if (!target) return;
  if (target.scrollIntoViewIfNeeded) target.scrollIntoViewIfNeeded(false);
  const r = target.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight;
  const w = d.offsetWidth, h = d.offsetHeight, gap = 18;
  const room = { right: W - r.right, left: r.left, below: H - r.bottom, above: r.top };
  // Things along the top strip (the search box, the toolbar) get the card below them; others beside.
  const topStrip = r.bottom < 150 && room.below >= h + gap;
  const side = topStrip ? 'below' : room.right >= w + gap ? 'right' : room.left >= w + gap ? 'left' : room.below >= h + gap ? 'below' : room.above >= h + gap ? 'above' : 'right';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let x, y;
  if (side === 'right' || side === 'left') { x = side === 'right' ? r.right + gap : r.left - gap - w; y = clamp(r.top + r.height / 2 - h / 2, 12, H - h - 12); }
  else { y = side === 'below' ? r.bottom + gap : r.top - gap - h; x = clamp(r.left + r.width / 2 - w / 2, 12, W - w - 12); }
  d.style.left = clamp(x, 12, W - w - 12) + 'px';
  d.style.top = clamp(y, 12, H - h - 12) + 'px';
  d.dataset.side = side;
  // the arrow points at the middle of the target
  d.style.setProperty('--ax', clamp(r.left + r.width / 2 - parseFloat(d.style.left), 48, w - 18) + 'px');
  d.style.setProperty('--ay', clamp(r.top + r.height / 2 - parseFloat(d.style.top), 48, h - 18) + 'px'); // below the step number in the corner
}
function endTour() {
  updateOnboard({ tour: true, flyout: true }).catch(() => {});
  closeDialog();
}

// ---- "How is Tabazing working for you?": two steps, at most twice (lib/review.js has the timing).
// Same rules for everyone, and every answer still offers the store review. The answer itself stays
// on this computer; the buttons only open pages on the site, where people send what they choose.
const openUrl = async (url) => { try { await chrome.tabs.create({ url, windowId: CTX.srcWin, active: true }); } catch {} finish('switch'); };
const reviewDone = () => updateReview((r) => ({ ...r, done: true })).catch(() => {});
const goReview = async () => { await reviewDone(); openUrl(REVIEW_URL); };

function askStep1() {
  const title = h('h3', '', t('askTitle'));
  title.id = 'dlg-title';
  const faces = h('div', 'faces');
  for (const [label, mood] of [['moodGood', 'good'], ['moodOkay', 'okay'], ['moodBad', 'bad']]) faces.append(button(t(label), '', () => askStep2(mood)));
  const row = h('div', 'row');
  row.append(button(t('dontAsk'), 'quiet', () => { reviewDone(); closeDialog(); }), h('span', 'grow'), button(t('notNow'), 'quiet', closeDialog));
  showDialog('ask', [title, para(t('askBody')), faces, row]);
}
function askStep2(mood) {
  const good = mood === 'good';
  const title = h('h3', '', t(good ? 'askGoodTitle' : 'askBadTitle'));
  title.id = 'dlg-title';
  const row = h('div', 'row');
  if (good) row.append(button(t('reviewBtn'), 'primary', goReview));
  else row.append(button(t('surveyBtn'), 'primary', async () => { await reviewDone(); openUrl(siteUrl('/survey', 'extension-prompt', '&mood=' + mood)); }), button(t('reviewBtn'), '', goReview));
  row.append(h('span', 'grow'), button(t('notNow'), 'quiet', closeDialog));
  showDialog('ask', [title, para(t(good ? 'askGoodBody' : 'askBadBody')), row, h('p', 'note', t('askNote'))]);
}
function askLater() { closeDialog(); }

// ---- is capturing working? Say so when it isn't, and offer the fix.
// Chrome lets users set an extension's "Site access" to "On click", which withholds the access
// Tabazing needs to screenshot pages and to react to Alt+Q on them. Detect that, and say why a
// preview is missing when the screenshot itself failed.
// `detail` (Chrome's own wording, for whoever wants it) goes in the tooltip, never on screen.
function showAlert(text, label, fn, detail = '') {
  el.alertText.textContent = text;
  el.alert.title = detail;
  el.alertBtn.hidden = !label;
  el.alertBtn.onclick = label ? (e) => { e.stopPropagation(); if (pointerAllowed()) fn(); } : null;
  if (label) el.alertBtn.textContent = label;
  el.alert.hidden = false;
  setTop();
}
async function requestHostAccess() {
  asking = true;
  let ok = false;
  try { ok = await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch {}
  asking = false;
  window.focus();
  if (!ok || state.done) return;
  showAlert(t('hostThanks'));
  setTimeout(() => { if (!state.done) { el.alert.hidden = true; render(); } }, 3500);
}
// Tabs the current view shows (window, star filter, search) that have no preview yet.
function missingPreviews() {
  return state.sections.flatMap((x) => x.entries).map((e) => e.tab)
    .filter((x) => !x.active && canCapture(x) && !state.previews[x.id]);
}
function updateSweepButton() {
  const n = missingPreviews().length;
  const max = LIMITS.SWEEP_MAX_TABS;
  const scoped = state.scope !== 'all' || state.starOnly || state.query;
  el.sweepBtn.hidden = !state.hostOk || n === 0;
  el.sweepText.textContent = n > max ? tn('sweepFirst', n, max) : tn(scoped ? 'sweepThese' : 'sweepAll', n);
  el.sweepBtn.title = t(scoped ? 'sweepTitleThese' : 'sweepTitleAll') + (n > max ? ' ' + t('sweepTitleMax', max) : '') + ' ' + t('sweepTitleOne');
}
// Chrome's error text for a failed screenshot, in plain words (null = not worth mentioning).
function plainCaptureError(msg) {
  const m = String(msg || '');
  if (/MAX_CAPTURE|quota|per second/i.test(m)) return null; // we just went too fast: it retries by itself
  if (/invoked|activeTab|permission|host/i.test(m)) return { text: t('capErrHost'), fix: true };
  if (/chrome:|extensions gallery|cannot access/i.test(m)) return { text: t('capErrPage') };
  return { text: t('capErrOther') };
}
async function healthCheck() {
  try { state.hostOk = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch { state.hostOk = true; }
  // Alt+Q itself can be left unassigned by Chrome (another app or extension owns it): say so, with the fix.
  let shortcut = 'assigned';
  try { const c = (await chrome.commands.getAll()).find((x) => x.name === 'open-switcher'); if (c && !c.shortcut) shortcut = 'missing'; } catch {}
  if (shortcut === 'missing') return showAlert(t('shortcutMissing'), t('setShortcut'), () => openUrl('chrome://extensions/shortcuts'));
  if (CTX.via === 'icon') toast(t('iconTip', IS_MAC ? 'Option+Q' : 'Alt+Q'));
  if (!state.hostOk) showAlert(t('hostBlocked'), t('hostAllow'), requestHostAccess, t('hostBlockedTip'));
  else {
    const cur = state.entries.find((e) => e.kind === 'tab' && e.tab.id === CTX.srcTab);
    if (cur && !cur.preview && /^https?:/.test(urlOf(cur.tab))) {
      const n = await getCaptureNote().catch(() => null);
      const say = n && n.stage === 'error' && Date.now() - n.t < 120000 ? plainCaptureError(n.msg) : null;
      if (say) showAlert(say.text, say.fix ? t('hostAllow') : '', requestHostAccess, `${n.host || t('thisPage')}: ${n.msg}`);
    }
  }
  updateSweepButton();
}

// ---- the theme (Settings): html.light switches the colours (switcher.css). "System" follows the OS and changes with it.
const lightMq = matchMedia('(prefers-color-scheme: light)');
let themePref = 'dark';
function applyTheme(v) {
  themePref = ['light', 'system'].includes(v) ? v : 'dark';
  document.documentElement.classList.toggle('light', themePref === 'light' || (themePref === 'system' && lightMq.matches));
}
lightMq.addEventListener('change', () => applyTheme(themePref));

// ---- Settings (the gear at the left of the header): language, card size, accent colour, and opening Tabazing when Chrome starts.
// The gear again while the card is open closes it; `redraw` keeps it open (a new language).
async function openSettings(anchor, redraw = false) {
  const open = document.querySelector('.pop.settings');
  closePops();
  if (open && !redraw) return;
  const prefs = await getPrefs().catch(() => ({ lang: 'auto', startup: false, cardSize: 'default', accent: ACCENTS[0], allWindows: false, theme: 'dark' }));
  const pop = h('div', 'pop settings');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('settings'));
  const lang = h('select');
  lang.setAttribute('aria-label', t('setLang'));
  for (const [v, label] of [['auto', t('setLangAuto')], ['en', 'English'], ['ru', 'Русский'], ['es', 'Español']]) {
    const o = h('option', '', label); o.value = v; if (v === prefs.lang) o.selected = true; lang.append(o);
  }
  lang.addEventListener('change', async () => {
    await updatePrefs({ lang: lang.value }).catch(() => {});
    setLang(lang.value);
    localizePage();
    render();
    openSettings(anchor, true); // redraw this card in the new language
  });
  const start = h('input');
  start.type = 'checkbox';
  start.id = 'set-startup';
  start.checked = prefs.startup;
  start.addEventListener('change', () => updatePrefs({ startup: start.checked }).catch(() => {}));
  const startLabel = h('label', 'check', t('setStartup'));
  startLabel.prepend(start);
  const allWins = h('input');
  allWins.type = 'checkbox';
  allWins.id = 'set-allwin';
  allWins.checked = prefs.allWindows;
  allWins.addEventListener('change', async () => {
    await updatePrefs({ allWindows: allWins.checked }).catch(() => {});
    state.scope = 'all';
    await reload();
  });
  const allWinsLabel = h('label', 'check', t('setAllWindows'));
  allWinsLabel.prepend(allWins);
  // Accent colour: a few ready-made ones, and any colour from Chrome's picker (the last circle).
  const accents = h('div', 'accents');
  accents.setAttribute('role', 'radiogroup');
  accents.setAttribute('aria-label', t('setAccent'));
  const pickAccent = (c, save = true) => {
    const now = applyAccent(c);
    accents.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.c === now)));
    custom.classList.toggle('on', !ACCENTS.includes(now));
    if (save) updatePrefs({ accent: now }).catch(() => {});
  };
  for (const c of ACCENTS) {
    const b = h('button', 'swatch');
    b.type = 'button';
    b.dataset.c = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c);
    b.style.setProperty('--c', c);
    b.addEventListener('click', (e) => { e.stopPropagation(); pickAccent(c); });
    accents.append(b);
  }
  const custom = h('input', 'custom');
  custom.type = 'color';
  custom.value = prefs.accent.toLowerCase();
  custom.title = t('setAccentCustom');
  custom.setAttribute('aria-label', t('setAccentCustom'));
  // Chrome's colour picker takes the focus for a moment: that is not the user leaving Tabazing.
  custom.addEventListener('click', () => { asking = true; });
  custom.addEventListener('input', () => pickAccent(custom.value, false)); // try it live...
  custom.addEventListener('change', () => { asking = false; pickAccent(custom.value); window.focus(); }); // ...keep it when chosen
  accents.append(custom);
  pickAccent(prefs.accent, false);
  const size = h('select');
  size.setAttribute('aria-label', t('setSize'));
  for (const [v, label] of [['default', t('setSizeDefault')], ['small', t('setSizeSmall')], ['list', t('setSizeList')]]) {
    const o = h('option', '', label); o.value = v; if (v === prefs.cardSize) o.selected = true; size.append(o);
  }
  const theme = h('select');
  theme.setAttribute('aria-label', t('setTheme'));
  for (const [v, label] of [['dark', t('setThemeDark')], ['light', t('setThemeLight')], ['system', t('setThemeSystem')]]) {
    const o = h('option', '', label); o.value = v; if (v === prefs.theme) o.selected = true; theme.append(o);
  }
  theme.addEventListener('change', () => {
    applyTheme(theme.value);
    updatePrefs({ theme: theme.value }).catch(() => {});
    if (CTX.mode === 'overlay') parent.postMessage({ tabazing: FRAME_MSG.READY, light: document.documentElement.classList.contains('light') }, '*'); // the page's shade
  });
  size.addEventListener('change', () => {
    state.cardSize = size.value;
    updatePrefs({ cardSize: size.value }).catch(() => {});
    refresh();
  });
  const sc = h('button', 'lnk', t('setShortcut'));
  sc.type = 'button';
  sc.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) openUrl('chrome://extensions/shortcuts'); });
  pop.append(h('h4', '', t('settings')), h('label', '', t('setLang')), lang, h('label', '', t('setTheme')), theme, h('label', '', t('setSize')), size, h('label', '', t('setAccent')), accents, allWinsLabel, h('p', 'pfine', t('setAllWindowsNote')), startLabel, h('p', 'pfine', t('setStartupNote')), sc);
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pop.remove(); el.search.focus(); } });
  el.app.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(12, r.left) + 'px';
  pop.style.top = (r.bottom + 8) + 'px'; // opens below the gear
  fancySelect(lang, { inPop: true });
  fancySelect(size, { inPop: true });
  fancySelect(theme, { inPop: true });
  // A press outside closes it; on the gear the click that follows does (above), or it would reopen at once.
  const close = (e) => {
    if (!pop.isConnected) return document.removeEventListener('mousedown', close, true);
    if (!pop.contains(e.target) && !anchor.contains(e.target) && !e.target.closest('.menu')) { pop.remove(); document.removeEventListener('mousedown', close, true); }
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

// Runs once per open, after the first render.
async function firstRun() {
  let onb = { tour: true }, rv = null, firstToday = false;
  const today = dayOf();
  try {
    [onb, rv] = await Promise.all([getOnboard(), updateReview((r) => { firstToday = r.day !== today; return { ...r, opens: r.opens + 1, day: today }; })]);
    if (!onb.flyout) updateOnboard({ flyout: true }).catch(() => {}); // opened once: the "press Alt+Q" flyout has done its job
  } catch { return; }
  if (!onb.tour) return whenTapMode(() => tourStep(0));
  const plan = reviewPrompt(rv, Date.now(), { firstToday });
  if (plan === 'ask') {
    updateReview((r) => ({ ...r, asks: r.asks + 1, lastAsk: Date.now() })).catch(() => {});
    whenTapMode(askStep1);
  }
}

// While a dialog is open it takes the keyboard: Esc closes it, the tour has arrow keys,
// everything else (Tab, Enter, typing in the feedback box) works on the dialog itself.
function dialogKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return state.modal === 'tour' ? endTour() : askLater(); }
  if (state.modal === 'tour' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === 'ArrowRight') { e.preventDefault(); tourAt < TOUR.length - 1 ? tourStep(tourAt + 1) : endTour(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); tourStep(tourAt - 1); }
  }
}

// ------------------------------------------------------------------ input
const MODIFIERS = new Set(['Alt', 'Control', 'Meta']);

// Is Option/Alt down right now (without Ctrl, so AltGr typing still works)?
// On a Mac, Option+letter types a symbol (Option+W is "∑") through the
// system's text input, which can slip past a cancelled keydown and even
// start a composition. So the search box also refuses text while it's down.
let altDown = false;
function trackAlt(e) { altDown = e.altKey && !e.ctrlKey; }

function onKeyDown(e) {
  if (state.done) return;
  trackAlt(e);
  if (document.querySelector('.bigback')) { // the big preview has the keyboard: Esc closes it, Enter opens that tab
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBig(); }
    else if (e.key === 'Enter') { e.preventDefault(); const i = state.entries.indexOf(bigEntry); closeBig(); if (i >= 0) choose(i); }
    else if (e.key === ' ') { e.preventDefault(); closeBig(); } // Space again: close
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { // the next / previous card's preview
      e.preventDefault();
      const n = state.entries.length, i = state.entries.indexOf(bigEntry);
      if (n && i >= 0) { const j = (((i + (e.key === 'ArrowRight' ? 1 : -1)) % n) + n) % n; select(j); openBig(state.entries[j]); }
    }
    else if (!MODIFIERS.has(e.key)) e.preventDefault();
    return;
  }
  if (state.modal) return dialogKey(e);
  if (archiveOpen()) return archiveKey(e);
  // Typing in any field other than the search box (Settings, the Sort list), or pressing a button
  // in a card or a menu: the key belongs to that field or button, not to the switcher.
  const target = e.target instanceof Element ? e.target : null;
  const own = target && target.closest('.pop, .menu');
  if (target && target !== el.search && target.matches('input, select, textarea')) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      closePops();
      el.search.focus({ preventScroll: true });
    }
    return;
  }
  if (own && (e.key === 'Enter' || e.key === ' ')) return;
  if (own && (e.key === 'Escape' || (target.closest('.menu') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)))) return;
  const typing = document.activeElement === el.search && el.search.value !== '';
  const k = e.key;
  const altOnly = e.altKey && !e.ctrlKey && !e.metaKey;
  // Our Alt shortcuts must work even if the text system thinks it's composing.
  if (e.isComposing && !(altOnly && ['KeyQ', 'KeyW', 'KeyE', 'KeyS', 'KeyP'].includes(e.code))) return;
  // A fresh modifier press, or any key without a modifier, means the user
  // had already let go of the shortcut: from now on it's "tap" mode.
  if ((MODIFIERS.has(k) && !e.repeat) || (!e.altKey && !e.ctrlKey && !e.metaKey)) stopHolding();

  // Close the selected tab: Del, or Cmd+Backspace on a Mac (its "delete"
  // key is Backspace, which the search box needs).
  const closeKey = !typing && (k === 'Delete' || (IS_MAC && e.metaKey && k === 'Backspace'));

  // Hidden or covered by the page: don't act on keys the user can't see the
  // effect of - just get out of the way.
  const acts = k === 'Enter' || closeKey || (altOnly && ['KeyQ', 'KeyW', 'KeyE', 'KeyS', 'KeyP'].includes(e.code));
  if (acts && !keysAllowed()) { e.preventDefault(); finish('cancel'); return; }

  // Holding the key sends repeats: close one tab per press, not one per repeat.
  if (closeKey) { e.preventDefault(); if (e.repeat) return; return closeTab(state.entries[state.sel]); }
  if (altOnly && e.code === 'KeyQ') { e.preventDefault(); return qPress(e.shiftKey ? 1 : -1); } // back a card
  if (altOnly && e.code === 'KeyW') { e.preventDefault(); return qPress(e.shiftKey ? -1 : 1); } // forward a card
  if (altOnly && e.code === 'KeyE') { e.preventDefault(); stopHolding(); return; } // stay open
  if (altOnly && e.code === 'KeyS') { e.preventDefault(); if (!e.repeat) star(state.entries[state.sel]); return; }
  if (altOnly && e.code === 'KeyP') { e.preventDefault(); if (!e.repeat) captureOne(state.entries[state.sel]); return; }
  if (e.ctrlKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); return cycleScope(k === 'ArrowRight' ? 1 : -1); }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') { e.preventDefault(); el.search.focus(); el.search.select(); return; }
  // Ctrl+Z reopens what was last closed here (in a search box with text, it stays the box's own undo).
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyZ' && !el.search.value) { e.preventDefault(); if (!e.repeat) undoClose(); return; }
  // 1-9 switch straight to the card with that number: Alt+number always (Alt may still be held from
  // Alt+Q), a plain number while the search box is empty (once you type, numbers are search text).
  if (/^Digit[1-9]$/.test(e.code) && !e.ctrlKey && !e.metaKey && (altOnly || (!e.altKey && !e.shiftKey && !el.search.value))) {
    e.preventDefault();
    if (e.repeat) return;
    if (!keysAllowed()) return finish('cancel');
    const i = Number(e.code.slice(5)) - 1;
    if (i < state.openCount) choose(i);
    return;
  }

  switch (k) {
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      if (el.search.value) { el.search.value = ''; state.query = ''; refresh(); }
      else if (state.dupesView) dupesView(false);
      else if (state.picked.size) clearPicks();
      else finish('cancel');
      return;
    case 'Enter':
      e.preventDefault();
      // Shift+Enter: what was typed, as an address or a Google search. With the dropdown up: its row.
      if (state.query.trim() && e.shiftKey) return openFromBox(state.query.trim());
      if (state.query.trim() && state.dd.items.length) return ddActivate(state.dd.items[state.dd.hi]);
      return choose(state.sel);
    case ' ': // Space, with nothing typed: the selected card's big preview
      if (!el.search.value && !e.altKey && !e.ctrlKey && !e.metaKey && state.entries[state.sel]) { e.preventDefault(); openBig(state.entries[state.sel]); }
      return;
    case 'Tab': e.preventDefault(); return cycle(e.shiftKey ? -1 : 1);
    case 'ArrowRight': if (!typing) { e.preventDefault(); moveSpatial(1, 0); } return;
    case 'ArrowLeft': if (!typing) { e.preventDefault(); moveSpatial(-1, 0); } return;
    case 'ArrowDown': e.preventDefault(); return ddShown() ? ddMove(1) : moveSpatial(0, 1);
    case 'ArrowUp': e.preventDefault(); return ddShown() ? ddMove(-1) : moveSpatial(0, -1);
    default:
      if (MODIFIERS.has(k)) { e.preventDefault(); return; }
      // Option/Alt + a key types symbols on a Mac (Option+Shift+4 is "›").
      // With Alt still down from the shortcut, that's a slip, not a search.
      if (altOnly && k.length === 1 && !el.search.value) { e.preventDefault(); return; }
      if (document.activeElement !== el.search && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        el.search.focus(); // typing anywhere goes into the search box
      }
  }
}

// Alt+Q and Alt+W work like Alt+Tab: they open the switcher on the card before (Q) or after (W) the
// current tab, each further press while Alt is held moves on that way, and letting go of Alt switches to
// the selected tab. Alt+E opens it to stay (as do the toolbar icon and the rest): arrows, typing, the mouse,
// Enter and Esc. Pressing Alt+Q / Alt+W in an open switcher makes it an Alt+Tab one again.
function qPress(d, hold = true) {
  if (hold) state.holding = true;
  cycle(d);
}
// Alt was let go: here, or in the page before the switcher had the focus (FRAME_MSG.RELEASED).
function altReleased() {
  if (!state.holding) return;
  if (state.modal || document.querySelector('.bigback') || archiveOpen() || el.search.value || !state.entries.length) return stopHolding();
  state.holding = false;
  keysAllowed() ? choose(state.sel) : finish('cancel');
}
// Alt is no longer held but the switcher stays open: opened with Alt+Q / Alt+W it hid what needs typing
// (html.alttab: the search box, note buttons), so bring that back. A moment later, and only if still open,
// so a key that closes it at once (Esc, Enter) doesn't flash the search box first.
function stopHolding() {
  state.holding = false;
  if (!document.documentElement.classList.contains('alttab')) return;
  setTimeout(() => {
    if (state.done || state.holding) return;
    document.documentElement.classList.remove('alttab');
    render();
    el.search.focus({ preventScroll: true });
  }, 60);
}

function onKeyUp(e) {
  if (state.done) return;
  trackAlt(e);
  if (e.key === 'Alt') altDown = false;
  if (state.modal) return;
  if (!MODIFIERS.has(e.key)) return;
  e.preventDefault();
  if (e.key === 'Alt') altReleased();
}

// ------------------------------------------------------ clickjacking guard
// A hostile page can make our iframe transparent, cover it, or move it, then
// get you to click somewhere. IntersectionObserver v2 tells us whether the
// overlay is actually visible and unobstructed; clicks are ignored unless it
// has been for a moment. A popup window can't be tampered with by a page.
let visibleSince = 0;   // when the overlay last became fully visible (0 = not visible)
let everVisible = false;
let bootedAt = 0;
function watchVisibility() {
  bootedAt = performance.now();
  if (CTX.mode !== 'overlay') return;
  try {
    new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e.isVisible) everVisible = true;
      visibleSince = e.isVisible ? (visibleSince || performance.now()) : 0;
    }, { trackVisibility: true, delay: 100 }).observe(el.app);
  } catch {
    visibleSince = 0; // unsupported: fail closed
  }
}
function pointerAllowed() {
  if (CTX.mode !== 'overlay') return true;
  const ok = visibleSince > 0 && performance.now() - visibleSince >= LIMITS.POINTER_VISIBLE_MS;
  if (!ok) stuckFallback();
  return ok;
}
// Shown a while ago, yet Chrome has never seen the overlay as visible (something on the page covers it
// or hides it from Chrome), so every click and key would be ignored: the first one that is reopens the
// switcher in its own window instead (background.js, MSG.FALLBACK).
let readyAt = 0;
function stuckFallback() {
  if (!readyAt || everVisible || state.done || document.hidden || performance.now() - readyAt < LIMITS.OVERLAY_VISIBLE_MS) return;
  console.warn('[Tabazing] the overlay is not visible to Chrome on this page: using the popup window');
  state.done = true;
  chrome.runtime.sendMessage({ type: MSG.FALLBACK }).catch(() => {});
}
// Keys may act while the overlay is visible, and during the first moments
// before Chrome has reported visibility (so a quick Alt+Q flick still works).
function keysAllowed() {
  if (CTX.mode !== 'overlay' || visibleSince > 0) return true;
  const ok = !everVisible && performance.now() - bootedAt < LIMITS.KEYS_GRACE_MS;
  if (!ok) stuckFallback();
  return ok;
}

function listen() {
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  el.search.addEventListener('beforeinput', (e) => { if (altDown) e.preventDefault(); });
  el.search.addEventListener('input', () => {
    if (altDown && el.search.value !== state.query) { el.search.value = state.query; return; } // slipped through anyway
    state.query = el.search.value; state.dd.hidden = false; state.dd.hi = 0;
    if (state.query.trim() && state.marks === null) loadMarks(); // first search: read the bookmarks (once)
    if (state.query.trim() && state.history === null) loadHistory(); // ...and recent history
    searchHistory(state.query.trim()); // Chrome's history search for older pages (a moment after typing stops)
    deriveSearch(); // the cards don't follow the search, so only the dropdown, the count and the actions bar change
    renderDropdown();
    renderCount();
    renderActs();
  });
  // A click anywhere but the search box or its dropdown closes the dropdown (typing brings it back).
  document.addEventListener('mousedown', (e) => {
    if (!(e.target instanceof Element) || e.target.closest('.search, .dd')) return;
    if (!state.dd.hidden && state.dd.items.length) { state.dd.hidden = true; renderDropdown(); }
  }, true);
  el.newtab.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!pointerAllowed()) return;
    try { await chrome.tabs.create({ windowId: CTX.srcWin, active: true }); } catch {}
    finish('switch');
  });
  el.sweepBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pointerAllowed()) return;
    const tabIds = missingPreviews().map((x) => x.id).slice(0, LIMITS.SWEEP_MAX_TABS);
    asking = true; // the progress window takes focus: that is not the user leaving
    chrome.runtime.sendMessage({ type: MSG.SWEEP, tabIds, reopen: CTX.mode === 'overlay' ? CTX.srcTab : null })
      .then((r) => { asking = false; if (r && r.n) finish('switch'); else toast(t('sweepNothing')); })
      .catch(() => { asking = false; toast(t('actFailed')); });
  });
  el.starFilter.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) toggleStarFilter(); });
  el.sort.addEventListener('click', (e) => e.stopPropagation());
  el.sort.addEventListener('change', () => { setSort(el.sort.value); el.search.focus(); });
  const on = (node, fn) => node.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) fn(e); });
  on($('settings-btn'), (e) => openSettings(e.currentTarget));
  on($('archive-btn'), () => openArchive().catch((err) => toast(t('actFailed'), err)));
  on(el.dupesBtn, closeDupes);
  on(el.mergeBtn, () => mergeWindows(state.otherWindows, 'act:merge'));
  on(el.selAll, selectAll);
  on(el.selNone, clearPicks);
  // Clicking empty space (not a card, chip, button, dialog or the search box) cancels.
  el.app.addEventListener('click', (e) => {
    if (!e.target.closest('.card, .chip, button, .search, .modal-back, .tools, .acts, .toast, .wins, .dd')) finish('cancel');
  });
  window.addEventListener('mousemove', (e) => {
    state.mouseReady = true;
    if (!e.altKey && !e.ctrlKey && !e.metaKey) stopHolding();
  });
  // Focus left the switcher (address bar, another app...): close quietly.
  // Only once we actually had focus, so a window that opens unfocused (or a
  // focus hiccup while it opens) doesn't make the switcher vanish instantly.
  let hadFocus = document.hasFocus();
  window.addEventListener('focus', () => { hadFocus = true; altDown = false; if (document.activeElement && document.activeElement.type === 'color') asking = false; });
  window.addEventListener('blur', () => setTimeout(() => {
    if (hadFocus && !asking && !document.hasFocus()) finish('blur');
  }, 80));
  window.addEventListener('resize', () => { if (!state.done) render(); });
  el.scroller.addEventListener('scroll', hideTip, { passive: true });
  // Holding Alt after Alt+Q / Alt+W, the wheel steps through the tabs like Q (down) and W (up); letting
  // go of Alt still switches. A mouse wheel moves one tab per notch; a touchpad's small scrolls add up.
  let wheelSum = 0, wheelAt = 0;
  const WHEEL_STEP = 80;
  window.addEventListener('wheel', (e) => {
    if (state.holding && e.altKey) {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY; // lines -> pixels
      if (Math.abs(dy) >= 50) { wheelSum = 0; qPress(Math.sign(dy)); return; } // a notch
      if (performance.now() - wheelAt > 250) wheelSum = 0;
      wheelAt = performance.now();
      wheelSum += dy;
      while (Math.abs(wheelSum) >= WHEEL_STEP) { const d = Math.sign(wheelSum); wheelSum -= d * WHEEL_STEP; qPress(d); }
      return;
    }
    // In the overlay, a wheel over anything that can't scroll would scroll the web page underneath.
    if (!(e.target instanceof Element) || !e.target.closest('#scroller, .wins, .modal-back, .dd, .archbody')) e.preventDefault();
  }, { passive: false });

  // Only the background service worker may move the selection (content
  // scripts always have sender.tab; the worker doesn't).
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (state.done || sender.id !== chrome.runtime.id || sender.tab) return;
    if (msg && msg.type === MSG.CYCLE) {
      if (msg.dir === 0) stopHolding(); // Alt+E: stay open
      else qPress(msg.dir === -1 ? -1 : 1, msg.hold === true);
      respond({ ok: true });
    }
  });
  chrome.tabs.onRemoved.addListener((id) => { if (!state.done) forgetTab(id); });
  // A preview saved while we are open (the current tab's, grabbed just before we opened, is stored as we
  // load): show it on its cards.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || state.done) return;
    let hit = false;
    if (changes[KEY.SNOOZED]) { getSnoozed().then((list) => { state.snoozed = list; afterIntro(() => refresh()); }).catch(() => {}); }
    for (const [k, ch] of Object.entries(changes)) {
      if (!k.startsWith('pv:') || !ch.newValue || typeof ch.newValue.img !== 'string') continue;
      for (const x of state.tabs) if (normalizeUrl(urlOf(x)) === k.slice(3)) { state.previews[x.id] = ch.newValue; hit = true; }
    }
    if (hit) afterIntro(() => refresh());
  });
  // The page saw Alt let go before we had the focus (see injectOverlay in background.js).
  window.addEventListener('message', (e) => {
    if (!state.done && CTX.mode === 'overlay' && e.source === window.parent && e.data && e.data.tabazing === FRAME_MSG.RELEASED) altReleased();
  });
}

// ------------------------------------------------------------------- boot
// Popup window: the token is in our URL (no web page can see or frame that
// window). Overlay: the content script posts it to us after we load; the
// iframe URL carries nothing. A token for one mode is refused in the other.
function getLaunch() {
  const inFrame = window.parent !== window;
  const urlToken = new URLSearchParams(location.search).get('t');
  if (!inFrame) {
    return urlToken ? consumeLaunch(urlToken).then((c) => (c && c.mode === 'window' ? c : null)) : Promise.resolve(null);
  }
  // In a page: a prepared frame, loaded ahead and invisible. Say so to the page's overlay host, then wait
  // (for as long as it takes) for the launch it passes on when a shortcut is pressed.
  return new Promise((resolve) => {
    let attempts = 0;
    const onMsg = async (e) => {
      const d = e.data;
      if (e.source !== window.parent || !d || d.tabazing !== FRAME_MSG.LAUNCH || typeof d.token !== 'string') return;
      if (++attempts > 5) { window.removeEventListener('message', onMsg); return resolve(null); } // someone is guessing
      const c = await consumeLaunch(d.token);
      if (c && c.mode === 'overlay') { window.removeEventListener('message', onMsg); resolve(c); }
    };
    window.addEventListener('message', onMsg);
    parent.postMessage({ tabazing: FRAME_MSG.STANDBY }, '*');
  });
}

(async () => {
  // Anything that loads this page without the token the background just
  // issued (e.g. a website framing it) gets an empty page and no listeners.
  CTX = await getLaunch();
  if (!CTX) return;
  state.holding = CTX.hold; // Alt+Q / Alt+W: letting go of Alt will switch...
  document.documentElement.classList.toggle('alttab', CTX.hold); // ...and what needs typing is hidden meanwhile
  document.documentElement.classList.add(CTX.mode);
  const [, bootPrefs, resume] = await Promise.all([loadLang(), getPrefs().catch(() => ({})), takeResume().catch(() => null)]);
  applyAccent(bootPrefs.accent);
  applyTheme(bootPrefs.theme);
  localizePage();
  fancySelect(el.sort);
  if (IS_MAC) {
    document.querySelectorAll('kbd[data-mac]').forEach((k) => { k.textContent = k.dataset.mac; });
  }
  listen();
  watchVisibility();
  await load();
  if (resume) { // back after capturing one tab's preview: show what was there before
    state.query = el.search.value = typeof resume.query === 'string' ? resume.query : '';
    state.scope = resume.scope === 'all' || Number.isInteger(resume.scope) ? resume.scope : 'all';
    state.starOnly = !!resume.starred;
  }
  derive();
  const mru = state.mruOrder;
  // Alt+Q / Alt+W start one card before / after the current tab; anything else on the tab used before it.
  const first = resume && typeof resume.key === 'string' ? resume.key
    : CTX.hold ? stepKey('t' + CTX.srcTab, CTX.dir)
    : mru.length > 1 ? mru[1].key : null;
  const at = first ? state.entries.findIndex((e) => e.key === first) : -1;
  if (first && at < 0) { const e = mru.find((x) => x.key === first); if (e && e.sec) { state.peek.add(e.sec); derive(); } }
  state.sel = Math.max(0, first ? state.entries.findIndex((e) => e.key === first) : 0);
  el.app.hidden = false;
  document.documentElement.classList.add('intro'); // the opening animation, on the first draw only, not on every redraw
  setTimeout(() => document.documentElement.classList.remove('intro'), 320); // once it has popped in
  render();
  if (CTX.mode === 'overlay') {
    parent.postMessage({ tabazing: FRAME_MSG.READY, light: document.documentElement.classList.contains('light') }, '*');
    readyAt = performance.now();
  }
  window.focus();
  el.search.focus({ preventScroll: true });
  // Then "Recently closed" and starred pages that aren't open; drawn once the opening animation is over,
  // so it doesn't restart on the cards.
  loadExtras().then(() => afterIntro(() => refresh())).catch(() => {});
  if (!resume) firstRun();
  healthCheck();
  try {
    const r = await chrome.runtime.sendMessage({ type: MSG.READY });
    const extra = r && Number.isInteger(r.extra) ? r.extra : 0;
    for (let i = 0; i < Math.abs(extra); i++) qPress(Math.sign(extra));
  } catch {}
})();
