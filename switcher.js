// Tabazing switcher UI. Runs as an extension page, either in an iframe on
// top of the current web page (mode "overlay") or in a small popup window on
// pages extensions can't touch (mode "window").
//
// Data flow: load() reads tabs/windows/sessions + stored previews once ->
// derive() builds the visible, selectable `entries` from state + filters ->
// render() draws them. Every user action updates state and calls refresh(), or redraw() when the same
// cards stay in the same order (a tick, a star...): then only the cards it changed are built again.
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

import { MSG, KEY, FRAME_MSG, LIMITS, REVIEW_URL, REPO_URL, siteUrl } from './utils/constants.js';
import { getNoCapture, getMru, getPreviews, getClosedLog, getSlept, consumeLaunch, getReview, updateReview, getOnboard, updateOnboard, getCaptureNote, getStars, toggleStar, getNotes, setNote, getSharpPreview, getSnoozed, addSnoozed, removeSnoozed, getWoken, getView, updateView, setResume, takeResume, getPrefs, updatePrefs, getPaletteRecent, notePaletteRecent, getGroup, setGroup, getClosedHidden, hideClosed, closedKey, getBmNotes, putBmNotes, setBmNote } from './utils/store.js';
import { reviewPrompt, dayOf } from './utils/review.js';
import { timeAgo, localizePage, setLang, uiLang, isRtl } from './utils/i18n.js';
import { t, getLocale, setLocale } from './utils/translations.js';
import { isOwnUrl, normalizeUrl, isWorthReopening, isCapturableUrl } from './utils/ext.js';
import { applyAccent, ACCENTS } from './utils/accent.js';
import { ARCHIVE_FOLDER, getArchived, addArchived, removeArchived } from './utils/archive.js';
import { makeBackup, restoreBackup, readBackup, unzipFiles, zipFiles, backupName } from './utils/backup.js';
import { loadMedia, mediaAction } from './utils/media.js';
import { asUrl, googleUrl } from './utils/web.js';
import { quick } from './utils/quick.js';
import { GROUP_COLORS, putInGroup, cleanGroup, groupOf } from './utils/groups.js';

let CTX = null; // set once the launch token has been verified (see boot)

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), bar: document.querySelector('.bar'), search: $('search'), count: $('count'),
  wins: $('wins'), tools: $('tools'), scroller: $('scroller'), newtab: $('newtab'),
  starFilter: $('star-filter'), starN: $('star-n'), qfilters: $('qfilters'), mergeBtn: $('merge-btn'), mergeText: $('merge-text'),
  snoozedSection: $('snoozed-section'), snoozedGrid: $('snoozed-grid'), sort: $('sort'), sweepText: $('sweep-text'), closedH: $('closed-h'),
  openGrid: $('open-grid'), openEmpty: $('open-empty'),
  closedSection: $('closed-section'), closedGrid: $('closed-grid'),
  keysBtn: $('keys-btn'), closedMore: $('closed-more'),
  sweepBtn: $('sweep-btn'),
  dupesBtn: $('dupes-btn'), dupesText: $('dupes-text'),
  alert: $('alert'), alertText: $('alert-text'), alertBtn: $('alert-btn'),
  acts: $('acts'), actsN: $('acts-n'), actsBtns: $('acts-btns'), selAll: $('sel-all'), selNone: $('sel-none'), actsHint: $('acts-hint'),
  body: $('body'),
  toast: $('toast'), clip: $('clip'), modal: $('modal'), dialog: $('dialog'),
  live: $('live-status'), liveAlert: $('live-alert'), archiveBtn: $('archive-btn'), menuBtn: $('menu-btn'), drawerBack: $('drawer-back'),
  player: $('player'), playerPic: $('player-pic'), playerTitle: $('player-title'), playerSub: $('player-sub'),
  playerPrev: $('player-prev'), playerToggle: $('player-toggle'), playerNext: $('player-next'), playerMore: $('player-more'),
  palette: $('palette'), palInput: $('palette-input'), palList: $('palette-list'), palFoot: $('palette-foot'),
  openH: $('open-h'), groupLeave: $('group-leave'), groupDot: $('group-dot'), groupN: $('group-n'),
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
  cardW: 320,      // current open-card width (px), set by render()
  slept: new Set(), // ids of tabs we saw Chrome discard in this browser session
  sections: [],    // derived: [{ key, title, entries }] for the open tabs (one plain list, or one per page in the duplicates view)
  mruOrder: [],    // derived: open entries in most-recently-used order (what Alt+Q cycles through)
  savedCount: 0,
  hostOk: true,   // does Tabazing have access to all sites (not withheld by Chrome's Site access setting)?
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
  foundQ: '',      // the text `found` and `foundClosed` are for (trimmed, lower case)
  palette: null,   // the command palette, while it shows: { from: 'shortcut' | 'switcher', saved, hi, items }
  palRecent: [],   // ids of the palette's actions, most recently run first (utils/store.js getPaletteRecent)
  dd: { items: [], hi: 0, hidden: false }, // the dropdown under the search box: rows, the highlighted one
  collapsed: new Set(), // section keys the user collapsed (kept between opens)
  peek: new Set(),      // collapsed sections opened for this visit only (Alt+Q landed on a tab inside)
  capturing: null,      // tab id whose preview is being captured from its card
  starPreviews: {},     // normalized URL -> preview, for starred pages that aren't open
  matchCount: 0,        // open tabs that match the filters, collapsed or not
  picked: new Set(),    // tab ids ticked for a quick action (close, copy, move...)
  undo: [],             // what can be undone, last at the end: [{ kind: 'close'|'merge'|'move', tabs: undoRecord(...), at }] (Ctrl+Z)
  lastPick: null,       // the last card ticked: where a Shift+click on a tick box, or Shift+arrows, range from
  shiftBase: null,      // the ticks before a run of Shift+arrows began (the run's range is added to them)
  prefs: null,          // the settings (utils/store.js getPrefs), as load() last read them
  woken: {},            // tab id -> when a snooze brought it back (utils/store.js getWoken): "Back from snooze"
  hits: null,           // derived while searching: keys of the cards that match it (the others are dimmed)
  closedMore: false,    // "Show more" under Recently closed: everything up to the search's limit
  nocap: new Set(),     // pages Chrome refused to screenshot: no "Capture preview" there
  toSleep: new Set(),   // tab ids to unload when the switcher closes
  dupesView: false,     // showing only the duplicate copies, before closing them
  matches: [],          // derived: the open tabs the filters let through
  archived: null,       // the "Tabs Archive" bookmarks folder: [{ id, url, title, t }] newest first (utils/archive.js)
  archivePreviews: {},  // normalized URL -> preview, for archived pages
  archSel: 0,           // the selected card in the archive overlay
  hist: null,           // the history overlay while it is open: its pages (entries), the selected one, its parts
  bmv: null,            // the bookmarks overlay while it is open: the tree by id, open folders, picked bookmarks, the rows shown
  bmNotes: {},          // notes on bookmarks, by bookmark id (utils/store.js getBmNotes)
  backup: null,         // the Backup & Restore dialog while it is open
  urlTabs: new Map(),   // normalized URL -> ids of the tabs open there (load())
  pvPending: new Set(), // tab ids whose previews aren't read yet (boot: the first cards' come first)
  media: [],            // what plays in the tabs, playing first (utils/media.js mediaEntries): the player and its list
  mediaCurrent: null,   // tab id of the media the player shows (chosen in its list, or last used); else the first
  mediaPreviews: {},    // normalized URL -> preview (or null: none), for media tabs the cards don't show
  groups: new Map(),    // Chrome's tab groups: id -> { id, title, color, windowId }
  group: null,          // the tab group the switcher is inside of (utils/store.js getGroup), until it is left
  inGroup: null,        // derived: that group, while some of the loaded tabs are in it (the group view shows)
  tileOf: new Map(),    // derived: a grouped tab's key -> its group tile's key (where the tab is on screen)
  steps: null,          // derived: the cards Alt+Q steps through when group tiles stand for some tabs (else state.matches)
  cardCount: 0,         // derived: the open-tab cards shown (a group tile is one)
  closedHidden: {},     // "Recently closed" entries removed from the list (utils/store.js getClosedHidden)
  leftGroup: null,      // the group Alt+Q / Alt+W just stepped out of (this open only: not shown again on a reload)
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
  tab: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.8 13.5V5.2c0-.7.5-1.2 1.2-1.2h3.4l1.4 2h5.2c.7 0 1.2.5 1.2 1.2v6.3zM1.8 13.5h12.4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>',
  bookmark: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 2.2h8v11.6L8 10.9l-4 2.9z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>',
  visited: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="5.8" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 4.8V8l2.3 1.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  archive: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.8 3h12.4v3H1.8zM2.8 6v7h10.4V6M6.3 8.6h3.4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  prev: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3v10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13 3.6v8.8a.5.5 0 0 1-.8.4L5.9 8.4a.5.5 0 0 1 0-.8l6.3-4.4a.5.5 0 0 1 .8.4Z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M12.5 3v10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3 3.6v8.8a.5.5 0 0 0 .8.4l6.3-4.4a.5.5 0 0 0 0-.8L3.8 3.2a.5.5 0 0 0-.8.4Z" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 2.9v10.2a.6.6 0 0 0 .9.5l8-5.1a.6.6 0 0 0 0-1L5.4 2.4a.6.6 0 0 0-.9.5Z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3.8" y="2.8" width="3" height="10.4" rx=".8" fill="currentColor"/><rect x="9.2" y="2.8" width="3" height="10.4" rx=".8" fill="currentColor"/></svg>',
  back: '<svg class="mirror" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.8 4.2c0-.6.5-1 1-1h3.4l1.4 1.6h5.6c.6 0 1 .4 1 1v6.4c0 .6-.4 1-1 1H2.8c-.5 0-1-.4-1-1z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>',
  goto: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // the command palette's
  plus: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  globe: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="5.8" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M2.2 8h11.6M8 2.2c1.8 1.7 2.6 3.6 2.6 5.8S9.8 12.1 8 13.8C6.2 12.1 5.4 10.2 5.4 8S6.2 3.9 8 2.2Z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
  bolt: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9 1.8 3.5 9h4l-1 5.2L12.5 7h-4z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>',
  calc: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="3" y="1.8" width="10" height="12.4" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5.3 4.5h5.4M5.5 8h1M9.5 8h1M5.5 11h1M9.5 11h1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  incognito: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2 7.5h12M4 7.5l1.3-4.3h5.4L12 7.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round" stroke-linecap="round"/><circle cx="5" cy="11" r="1.9" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="11" cy="11" r="1.9" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M6.9 11h2.2" stroke="currentColor" stroke-width="1.3"/></svg>',
  gear: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="2.3" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  puzzle: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 5.5h2.2a1.6 1.6 0 1 1 3 0H10.5v2.3a1.6 1.6 0 1 1 0 3V13H3z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>',
  keyboard: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M4 6.8h.5M6.5 6.8h.5M9 6.8h.5M11.5 6.8h.5M5 10h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  download: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13.2h10" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trash: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4.2 4.2l.7 9h6.2l.7-9M6.7 6.6v4.4M9.3 6.6v4.4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  eraser: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M9.6 2.8 13.2 6.4 7.4 12.2H4.6L2.8 10.4zM6.2 6.2l3.6 3.6M7.4 13.2h6" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  key: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="5" cy="8" r="2.8" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M7.8 8H14M11.5 8v2.2M13.5 8v1.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  zoom: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  zoomIn: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M10.5 10.5 14 14M7 5v4M5 7h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  zoomOut: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M10.5 10.5 14 14M5 7h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  expand: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sun: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="2.8" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  // Settings' categories
  brush: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M13.6 2.4c-1.6.4-4.6 3-6.3 5.2l1.1 1.1c2.2-1.7 4.8-4.7 5.2-6.3ZM6.4 8.6c-1.5 0-2.6 1.1-2.6 2.5 0 .9-.6 1.6-1.4 1.9 2.6 1.3 5.5.2 5.4-2.4z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>',
  cards: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="2" y="2.5" width="5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/><rect x="9" y="2.5" width="5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/><rect x="2" y="9" width="5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/><rect x="9" y="9" width="5" height="4.5" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  sort: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M5 2.5v11M2.8 11.2 5 13.5l2.2-2.3M11 13.5v-11M8.8 4.8 11 2.5l2.2 2.3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ---------------------------------------------------------------- helpers
const urlOf = (tab) => (tab && (tab.url || tab.pendingUrl)) || '';
const favicon = (url) => chrome.runtime.getURL('/_favicon/') + '?pageUrl=' + encodeURIComponent(url) + '&size=32';
function hostOf(url) {
  try { const u = new URL(url); return u.host || u.protocol.replace(':', ''); } catch { return ''; }
}
function h(tag, cls, text, testid) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  if (testid) n.dataset.testid = testid; // what the tests select elements by (tests/: never by class, id or role)
  return n;
}
// An icon (ICON markup) as nodes: parsed once per icon, then cloned. A redraw draws thousands of them, and
// parsing the SVG text for each one (innerHTML) was most of a card's cost.
const svgTpl = new Map();
function svgOf(markup) {
  let tpl = svgTpl.get(markup);
  if (!tpl) { tpl = document.createElement('template'); tpl.innerHTML = markup; svgTpl.set(markup, tpl); }
  return tpl.content.cloneNode(true);
}

// ------------------------------------------------------------------- data
// What the cards need, all read at once (each read is a round trip to Chrome's storage). "Recently
// closed" and starred pages that aren't open come after the first draw: loadExtras().
// `prefs`: already read (at boot), so the tabs are asked for at once. `previews: false` leaves the previews
// out (state.pvPending): at boot only the first cards' are read before the first draw (loadPreviews).
const PREFS_FALLBACK = {
  lang: 'auto', cardSize: 'default', allWindows: false, theme: 'system', pinnedFirst: true, showClosed: true, showSnoozed: true, showGroups: true, groupWrap: false,
  showAge: true, ownWindow: false, titleLines: 2, searchHistory: true, searchBookmarks: true, iconTips: 0,
};
async function load(prefs = null, { previews = true } = {}) {
  const prefsRead = prefs ? Promise.resolve(prefs) : getPrefs().catch(() => PREFS_FALLBACK);
  const tabsRead = prefsRead.then((p) => chrome.tabs.query(p.allWindows ? { windowType: 'normal' } : { windowId: CTX.srcWin }));
  const [allTabs, mru, slept, , nocap, stars, view, notes, byUrl, wins, snoozed, woken, groups, group] = await Promise.all([
    tabsRead,
    getMru(),
    getSlept().catch(() => []),
    prefsRead,
    getNoCapture().catch(() => new Set()),
    getStars().catch(() => ({})),
    getView().catch(() => null),
    getNotes().catch(() => ({})),
    previews ? tabsRead.then((all) => getPreviews(all.map(urlOf))).catch(() => ({})) : {}, // previews are stored by URL
    chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []),
    getSnoozed().catch(() => []),
    getWoken().catch(() => ({})),
    chrome.tabGroups ? chrome.tabGroups.query({}).catch(() => []) : [],
    getGroup().catch(() => null),
  ]);
  prefs = { ...PREFS_FALLBACK, ...(await prefsRead) };
  state.groups = new Map(groups.map((g) => [g.id, g]));
  // Inside a group that is gone (its last tab closed, or ungrouped): out of it for good.
  state.group = group !== null && state.groups.has(group) && group !== state.leftGroup ? group : null;
  if (group !== null && state.group === null) setGroup(null).catch(() => {});
  state.prefs = prefs;
  state.woken = woken;
  state.cardSize = prefs.cardSize;
  applyLines();
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
  // This window, or all of them (Settings); Tabazing's own pages left out.
  const tabs = allTabs.filter((t) => !isOwnUrl(urlOf(t)));

  const rank = new Map(mru.map((id, i) => [id, i]));
  const r = (t) => (t.id === CTX.srcTab ? -1 : rank.has(t.id) ? rank.get(t.id) : Infinity);
  const inSrc = (t) => (t.windowId === CTX.srcWin ? 0 : 1);
  tabs.sort((a, b) => r(a) - r(b) || inSrc(a) - inSrc(b) || a.windowId - b.windowId || a.index - b.index);
  state.tabs = tabs;

  // Hand each tab the preview for its current URL. The tabs of each address are kept, for a preview saved
  // while the switcher is open (listen(): storage.onChanged).
  state.previews = {};
  state.urlTabs = new Map();
  for (const t of tabs) {
    const k = normalizeUrl(urlOf(t));
    const p = byUrl[k];
    if (p) state.previews[t.id] = p;
    if (!state.urlTabs.has(k)) state.urlTabs.set(k, []);
    state.urlTabs.get(k).push(t.id);
  }
  state.pvPending = new Set(previews ? [] : tabs.map((t) => t.id));

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
        label: id === CTX.srcWin ? t('thisWindow') : t('windowN', { number: byAge.indexOf(id) + 2 }),
        count: wt.length,
        activeTitle: active ? active.title || '' : '',
        activeId: active ? active.id : null,
        activeUrl: active ? urlOf(active) : '',
      };
    })
    .filter((w) => w.count > 0);
}
// The previews of these tabs (of those still pending), read in one go. A preview saved meanwhile (storage.onChanged) is newer: kept.
async function loadPreviews(tabs) {
  tabs = tabs.filter((x) => state.pvPending.has(x.id));
  if (!tabs.length) return [];
  const byUrl = await getPreviews(tabs.map(urlOf)).catch(() => ({}));
  for (const x of tabs) {
    state.pvPending.delete(x.id);
    const p = byUrl[normalizeUrl(urlOf(x))];
    if (p && !state.previews[x.id]) state.previews[x.id] = p;
  }
  return tabs.map((x) => x.id);
}
// What the first draw shows a preview for: the cards that fit on the screen (previewBatch), the selected one,
// the current tab (healthCheck looks at its preview) and each window's picture in the window list. The rest
// follow right after.
const FIRST_PREVIEWS = 32; // when the window's size isn't known
// How many cards fit on the screen at the chosen card size: the columns as cardWidth works them out, the rows
// from the height below the header (a card is its 16:10 picture plus its header), plus one row more.
function previewBatch(width = window.innerWidth, height = window.innerHeight) {
  if (!(width > 0 && height > 0)) return FIRST_PREVIEWS;
  const avail = Math.max(0, width - 88 - (state.windows.length > 1 ? 220 : 0)); // the side paddings, the window list
  const { cols, w } = gridColumns(avail);
  const cardH = state.cardSize === 'list' ? 40 : w * 10 / 16 + 50;
  const rows = Math.ceil(Math.max(0, height - 130) / (cardH + 16)) + 1;
  return Math.max(cols, Math.min(120, cols * rows));
}
function firstShown() {
  const out = new Set(state.entries.slice(0, previewBatch()).flatMap((e) => (e.kind === 'tab' ? [e.tab] : e.kind === 'group' ? e.tabs.slice(0, 4) : [])));
  const cur = state.entries[state.sel];
  if (cur && cur.kind === 'tab') out.add(cur.tab);
  const ids = new Set([CTX.srcTab, ...state.windows.map((w) => w.activeId)]);
  for (const x of state.tabs) if (ids.has(x.id)) out.add(x);
  return [...out];
}

async function loadExtras() {
  const arch = loadArchived(); // archived pages are left out of "Recently closed": loadClosed waits for it
  await Promise.all([arch, loadClosed(arch), loadStarPreviews(), loadSnoozePreviews(), loadMediaPreviews()]);
}
async function loadSnoozePreviews() {
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

// `before`: a read to wait for before using state.archived (loadExtras reads the archive alongside).
async function loadClosed(before) {
  const [sessions, log, hidden] = await Promise.all([
    (async () => { try { return await chrome.sessions.getRecentlyClosed({ maxResults: 25 }); } catch { return []; } })(),
    getClosedLog().catch(() => []),
    getClosedHidden().catch(() => ({})),
    Promise.resolve(before).catch(() => {}),
  ]);
  state.closedHidden = hidden;
  const now = Date.now();
  const stamp = (s) => (s.lastModified > 0 ? s.lastModified * 1000 : 0); // 0 = Chrome gave no time (e.g. some closed windows)
  const rank = (c) => c.ts || now;                                         // ...which we treat as "just now" for sorting

  const items = [];
  const covered = new Set(); // pages inside a closed window that Chrome still lists as one "Window" card
  // Closed by archiving or snoozing: listed in the archive or under "Snoozed", not here (in Chrome's list either).
  const elsewhere = new Set([...(state.archived || []), ...state.snoozed].map((x) => normalizeUrl(x.url)));
  for (const s of sessions) {
    if (s.tab) {
      const url = urlOf(s.tab);
      if (!isWorthReopening(url) || elsewhere.has(normalizeUrl(url))) continue;
      items.push({ id: 's' + s.tab.sessionId, kind: 'tab', url, title: s.tab.title || '', ts: stamp(s), count: 1, session: s, fields: [[s.tab.title, url]] });
    } else if (s.window && s.window.tabs && s.window.tabs.length) {
      const tabs = s.window.tabs;
      tabs.forEach((t) => covered.add(normalizeUrl(urlOf(t))));
      items.push({
        id: 's' + s.window.sessionId, kind: 'window', url: urlOf(tabs[0]), title: t('closedWindow', { tabs: t('tabs', { count: tabs.length }) }),
        ts: stamp(s), count: tabs.length, session: s, fields: tabs.map((t) => [t.title, urlOf(t)]),
      });
    }
  }
  const open = new Set(state.tabs.map((t) => normalizeUrl(urlOf(t))));
  elsewhere.forEach((k) => open.add(k));
  for (const e of log) {
    const key = normalizeUrl(e.url);
    // Already open again, or part of a closed window shown as one card: skip.
    if (!isWorthReopening(e.url) || covered.has(key) || open.has(key)) continue;
    items.push({ id: 'l' + e.closedAt + hashOf(e.url), kind: 'tab', url: e.url, title: e.title, ts: e.closedAt, count: 1, session: null, fields: [[e.title, e.url]], group: cleanGroup(e.group) });
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
  // Removed from the list (closedRemove): what was closed by then under that key stays out (one with no time, always).
  const shows = (it) => { const at = hidden[closedKey(it)]; return !at || (it.ts > 0 && it.ts > at); };
  const merged = [...items.filter((it) => it.kind === 'window'), ...best.values()].filter(shows).sort((a, b) => rank(b) - rank(a));

  const previews = await getPreviews(merged.slice(0, LIMITS.CLOSED_PREVIEW_LOOKUP).map((it) => it.url));
  for (const it of merged) it.preview = previews[normalizeUrl(it.url)] || null;
  state.closed = merged;
}

// What the "Recently closed" section shows. Normally the last few hours, a few
// entries, few whole windows; while searching, anything from the last 7 days.
// "Show more" (state.closedMore) reaches as far as a search does.
function closedFor(q) {
  if (q) return state.closed.filter((c) => c.fields.some(([title, url]) => matches(q, title, url, noteOf(url), pageStatus(url, 'closed')))).slice(0, LIMITS.RECENTLY_CLOSED_SEARCH);
  if (state.closedMore) return state.closed.slice(0, LIMITS.RECENTLY_CLOSED_SEARCH);
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
// searching, the best matches come first. Scores are remembered (per field, and typo checks per pair of
// words), so each keystroke only works out what the newest letters change.
const fieldIndex = new Map(); // text -> { text, words, initials, scores } (titles and addresses repeat on every keystroke)
// Lower case without accents, letter for letter (é → e, ά → α, ü → u): a word typed without its accents still finds
// it, as Greek, French or German are often typed. Each letter stays one letter, so a place in it is the text's too.
const foldMemo = new Map();
const foldChar = (c) => { let f = foldMemo.get(c); if (f === undefined) { f = c.normalize('NFD').replace(/\p{M}+/gu, ''); if (f.length !== c.length) f = c; foldMemo.set(c, f); } return f; };
const fold = (s) => { const lower = s.toLowerCase(); return /[^\x00-\x7f]/.test(lower) ? lower.replace(/[^\x00-\x7f]/g, foldChar) : lower; };
function fieldOf(text) {
  let x = fieldIndex.get(text);
  if (!x) {
    const lower = fold(text);
    const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    x = { text: lower, words, initials: words.map((w) => w[0]).join(''), scores: new Map() };
    if (fieldIndex.size > 50000) fieldIndex.clear(); // big enough for all of history and the bookmarks
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
// Is `word` (a word of a title or address) within a typo of the typed word `w`: the whole word, or its start
// (a word still being typed)? The same words turn up in thousands of titles, so each pair is worked out once.
const typoMemo = new Map(); // typed word -> Map(word -> boolean)
function typoNear(w, word) {
  let m = typoMemo.get(w);
  if (!m) { if (typoMemo.size > 40) typoMemo.clear(); typoMemo.set(w, (m = new Map())); }
  let ok = m.get(word);
  if (ok === undefined) {
    const max = w.length >= 8 ? 2 : 1;
    ok = [word, word.slice(0, w.length), word.slice(0, w.length + 1)].some((y) => y.length >= w.length - max && typoDistance(w, y, max) <= max);
    m.set(word, ok);
  }
  return ok;
}
const inOrder = (w, word) => { let i = 0; for (const ch of word) if (ch === w[i] && ++i === w.length) return true; return false; };
// One typed word against one field, remembered on the field: on the next keystroke only the word being typed is new.
function wordScore(w, f) {
  let s = f.scores.get(w);
  if (s === undefined) {
    s = scoreWord(w, f);
    if (f.scores.size > 16) f.scores.clear();
    f.scores.set(w, s);
  }
  return s;
}
function scoreWord(w, f) {
  if (f.words.some((x) => x.startsWith(w))) return 5;
  if (w.length >= 2 && f.initials.includes(w)) return 4;
  if (f.text.includes(w)) return 3;
  if (w.length >= 2 && f.words.some((x) => x[0] === w[0] && inOrder(w, x))) return 2;
  if (w.length >= 4 && !/\d/.test(w) && f.words.some((x) => typoNear(w, x))) return 1;
  return 0;
}
// A field may be a page's state ({ status }: pageStatus, tabStatus): its words count only as typed, from their start
// (three letters or more), never as a typo, so "plain" doesn't find the tabs that are "playing".
function searchScore(q, ...fields) {
  const fs = [], st = [];
  for (const f of fields) if (f && typeof f === 'object') st.push(...fold(f.status).split(/\s+/).filter(Boolean)); else if (f) fs.push(fieldOf(f));
  let total = 0;
  for (const w of queryWords(q)) {
    let best = Math.max(0, ...fs.map((f) => wordScore(w, f)));
    if (!best && w.length >= 3 && st.some((s) => s.startsWith(w))) best = 1;
    if (!best) return 0;
    total += best;
  }
  return total;
}
const matches = (q, ...fields) => searchScore(q, ...fields) > 0;
// What a page is, in words the searches find it by, in the page's language and in English (as the palette's actions
// are): pinned, asleep, playing, muted, starred, with a note, in a group, and where it is (closed, archived, snoozed,
// bookmarked, in the history). One more field to search: "pinned youtube" finds the pinned YouTube tabs, "asleep" the
// sleeping ones. (No word for "open": every tab is.)
const STATUS = {
  pinned: { label: 'statusPinned' }, asleep: { label: 'statusAsleep' }, playing: { label: 'statusPlaying' }, muted: { label: 'statusMuted' },
  starred: { label: 'statusStarred' }, note: { label: 'statusNote' }, grouped: { label: 'statusGrouped' }, closed: { label: 'statusClosed' },
  archived: { label: 'statusArchived' }, snoozed: { label: 'statusSnoozed' }, bookmarked: { label: 'statusBookmarked' }, visited: { label: 'statusVisited' },
};
let statusMemo = { lang: null, words: {} };
function statusText(...kinds) {
  const lang = getLocale();
  if (statusMemo.lang !== lang) statusMemo = { lang, words: {} };
  const word = (k) => (statusMemo.words[k] ??= lang === 'en' ? t(STATUS[k].label) : t(STATUS[k].label) + ' ' + inEnglish(() => t(STATUS[k].label)));
  return kinds.filter(Boolean).map(word).join(' ');
}
const tabStatus = (x) => ({ status: statusText(x.pinned && 'pinned', x.discarded && 'asleep', x.audible && 'playing', isMuted(x) && 'muted',
  isStarred(urlOf(x)) && 'starred', noteOf(urlOf(x)) && 'note', x.groupId >= 0 && 'grouped') });
const pageStatus = (url, where = null) => ({ status: statusText(where, isStarred(url) && 'starred', noteOf(url) && 'note') });
// Where a tab matched decides its place first: its note (3), then its title (2), then its address (1);
// within each, how well it matched. A field counts if any word typed is found in it.
// A title that starts with what was typed (or with its first word) comes before one that has it elsewhere.
const queryWords = (q) => fold(q).split(/\s+/).filter(Boolean);
const fieldHit = (q, text) => !!text && queryWords(q).some((w) => wordScore(w, fieldOf(text)) > 0);
function matchTier(q, tab) {
  if (fieldHit(q, noteOf(urlOf(tab)))) return 4;
  const title = fold(tab.title || '').trim();
  if (title && (title.startsWith(fold(q)) || title.startsWith(queryWords(q)[0]))) return 3;
  return fieldHit(q, tab.title) ? 2 : 1;
}

// The search's words marked in `text` (for the dropdown): where they appear as typed, or, for a word with a
// typo, the word it matched. Built with text nodes and <mark> elements only (page text is never HTML).
function highlight(text, q) {
  const out = document.createDocumentFragment();
  if (!text) return out;
  const lower = fold(text);
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
    mk.dataset.testid = 'search-highlight';
    mk.className = 'ddm';
    mk.textContent = text.slice(from, e);
    out.append(mk);
    at = e;
  }
  if (at < text.length) out.append(text.slice(at));
  return out;
}
const HL_TESTIDS = { ddtitle: 'dd-title', ddsub: 'dd-sub', 'ddsub ddnote2': 'dd-note' };
const hlSpan = (cls, text, q) => { const s = h('span', cls, null, HL_TESTIDS[cls]); s.append(highlight(text, q)); return s; };

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
    const close = dupeIds();
    for (const e of open) add('d:' + normalizeUrl(urlOf(e.tab)), { title: e.tab.title || siteOf(urlOf(e.tab)), site: urlOf(e.tab) }, e);
    const out = [...secs.values()];
    out.forEach((x) => x.entries.sort((a, b) => close.has(a.tab.id) - close.has(b.tab.id)));
    return out;
  }
  for (const e of open) add('u', { title: t('openTabs') }, e); // one plain list, in the chosen sort
  return [...secs.values()];
}

// The search's results, for the dropdown: open tabs that match (where they matched first: note, title,
// address; then how well; then recent use), and recently closed ones (the last 7 days). `q`: trimmed, lower case.
function searchFor(q) {
  if (!q) return { found: [], foundClosed: [] };
  const score = new Map(), tier = new Map();
  const found = state.tabs
    .filter((x) => { const s = searchScore(q, x.title, urlOf(x), noteOf(urlOf(x)), tabStatus(x)); if (s > 0) { score.set(x.id, s); tier.set(x.id, matchTier(q, x)); } return s > 0; })
    .sort((a, b) => tier.get(b.id) - tier.get(a.id) || score.get(b.id) - score.get(a.id)) // stable: recent use within
    .map((tab) => ({ kind: 'tab', key: 't' + tab.id, tab, preview: state.previews[tab.id] || null }));
  return { found, foundClosed: closedFor(q) };
}
function deriveSearch() {
  const q = state.query.trim().toLowerCase();
  const r = searchFor(q);
  state.found = r.found;
  state.foundClosed = r.foundClosed;
  state.foundQ = q;
}
// The same for any text (the command palette's): the search box's own when it is that text, else worked out
// once per text and list of tabs.
let foundMemo = { q: null, tabs: null, closed: null, r: null };
function foundFor(q) {
  if (q === state.foundQ) return { found: state.found, foundClosed: state.foundClosed };
  if (foundMemo.q !== q || foundMemo.tabs !== state.tabs || foundMemo.closed !== state.closed) foundMemo = { q, tabs: state.tabs, closed: state.closed, r: searchFor(q) };
  return foundMemo.r;
}
// While searching, the cards that don't match are dimmed (they keep their places): which ones do.
function deriveHits() {
  const q = state.query.trim().toLowerCase();
  if (!q) { state.hits = null; return; }
  const found = new Set(state.found.map((e) => e.key));
  state.hits = new Set(state.entries.filter((e) => (e.kind === 'tab' ? found.has(e.key)
    : e.kind === 'group' ? e.tabs.some((x) => found.has('t' + x.id)) || matches(q, groupName(e.group))
    : e.kind === 'closed' ? e.item.fields.some(([title, url]) => matches(q, title, url, noteOf(url), pageStatus(url, 'closed')))
    : matches(q, e.item.title, e.item.url, noteOf(e.item.url), pageStatus(e.item.url, e.kind === 'snoozed' ? 'snoozed' : null)))).map((e) => e.key));
}
// Mark the cards on screen as matching or not (a keystroke doesn't build them again).
function markHits() {
  for (const c of document.querySelectorAll('#scroller .card')) {
    const e = state.entries[c._i];
    c.classList.toggle('nomatch', !!state.hits && !!e && !state.hits.has(e.key));
  }
}
const pref = (k) => (state.prefs || PREFS_FALLBACK)[k];

function derive() {
  dupeMemo = null;
  deriveSearch();
  const q = ''; // the cards, "Snoozed" and "Recently closed" don't follow the search: its results are in the dropdown
  if (state.scope !== 'all' && !state.windows.some((w) => w.id === state.scope)) state.scope = 'all';

  const dupeKeys = state.dupesView ? dupeUrls() : null;
  // Inside a tab group (its tile was opened): only its tabs, whatever window it is in. Settings -> Show tab groups
  // as tiles off: no tiles and no group view, every tab its own card (tagged with its group).
  const groups = pref('showGroups');
  const inGroup = groups && state.group !== null && state.tabs.some((x) => x.groupId === state.group) ? state.group : null;
  state.inGroup = inGroup;
  const open = state.tabs
    .filter((x) => !dupeKeys || dupeKeys.has(normalizeUrl(urlOf(x))))
    .filter((t) => (inGroup !== null ? t.groupId === inGroup : state.scope === 'all' || t.windowId === state.scope))
    .filter((t) => !state.starOnly || isStarred(urlOf(t)))
    .filter((t) => !state.filter || FILTERS[state.filter].test(t))
    .map((tab) => ({ kind: 'tab', key: 't' + tab.id, tab, preview: state.previews[tab.id] || null }));
  state.mruOrder = open.slice(); // what Alt+Q cycles through: always recent use
  if (SORTERS[state.sort]) open.sort(SORTERS[state.sort]);
  // Pinned tabs first (Settings), then the rest, each in the chosen sort ([pinned, pinned, current, ...] by recent use).
  const pinnedFirst = (a, b) => (b.tab && b.tab.pinned ? 1 : 0) - (a.tab && a.tab.pinned ? 1 : 0);
  if (pref('pinnedFirst')) open.sort(pinnedFirst);
  // A tab group's tabs show as one tile, where its first tab would be (by name: where its name goes); filters and the
  // Starred filter narrow a tile to the tabs they let through. Not inside a group, nor in the duplicates view.
  const tile = (list) => {
    const out = groups && inGroup === null && !state.dupesView ? groupTiles(list) : null;
    if (out && state.sort === 'name') out.sort((a, b) => (pref('pinnedFirst') ? pinnedFirst(a, b) : 0) || cardName(a).localeCompare(cardName(b), undefined, { sensitivity: 'base', numeric: true }));
    return out;
  };
  const tiled = tile(open);
  const cards = tiled || open;
  state.tileOf = new Map();
  if (tiled) for (const e of tiled) if (e.kind === 'group') for (const x of e.tabs) state.tileOf.set('t' + x.id, e.key);
  // What Alt+Q / Alt+W step through: the cards in the order they are shown (pinned tabs first), so none is left for
  // the far end of the list. (The first Alt+W by recent use goes to the tab used just before, wherever it is: boot.)
  state.steps = cards;
  state.cardCount = cards.length;

  const all = sectionsFor(cards);
  // A collapsed section keeps its header and hides its cards, except while searching.
  for (const sec of all) sec.collapsed = !q && state.collapsed.has(sec.key) && !state.peek.has(sec.key);
  // One plain list (no headers) when there's nothing to group by.
  state.sections = all.length === 1 && !state.dupesView ? [{ ...all[0], plain: true, collapsed: false }] : all;
  const shown = state.sections.flatMap((x) => (x.collapsed ? [] : x.entries));

  let closed = [];
  if (inGroup !== null) { /* the group view is the group's tabs only */ }
  else if (state.starOnly) {
    // Starred pages no tab has open right now: reopen them from here.
    const openUrls = new Set(state.tabs.map((t) => normalizeUrl(urlOf(t))));
    closed = Object.entries(state.stars)
      .filter(([k, st]) => !openUrls.has(k) && (!q || matches(q, st.ti, st.u, noteOf(st.u), pageStatus(st.u))))
      .sort((a, b) => b[1].t - a[1].t)
      .map(([k, st]) => ({ kind: 'star', key: 'st' + k, item: { id: k, url: st.u, title: st.ti, ts: st.t }, preview: state.starPreviews[k] || null }));
  } else if (pref('showClosed')) {
    closed = closedFor(q).map((item) => ({ kind: 'closed', key: 'c' + item.id, item, preview: item.preview }));
  }

  // Snoozed tabs (soonest first) get their own section; not while a filter narrows things to open tabs.
  const snoozed = state.starOnly || state.filter || state.dupesView || inGroup !== null || !pref('showSnoozed') ? [] : state.snoozed
    .filter((x) => !q || matches(q, x.title, x.url, noteOf(x.url), pageStatus(x.url, 'snoozed')))
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
  deriveHits();
}

// The open tabs (sorted) with each tab group's tabs replaced by one tile, at the place of its first tab there;
// null when no tab is in a group. A tile's tabs are in tab-strip order (its picture shows the first four), and
// `recent` has them most recently used first.
function groupTiles(open) {
  const out = [], tiles = new Map();
  for (const e of open) {
    const g = e.tab.groupId;
    if (!(g >= 0) || !state.groups.has(g)) { out.push(e); continue; }
    let tile = tiles.get(g);
    if (!tile) { tile = { kind: 'group', key: 'g' + g, group: state.groups.get(g), tabs: [], recent: [], url: '' }; tiles.set(g, tile); out.push(tile); }
    tile.tabs.push(e.tab);
  }
  if (!tiles.size) return null;
  const rank = new Map(state.tabs.map((x, i) => [x.id, i])); // state.tabs: most recently used first
  for (const tile of tiles.values()) {
    tile.recent = tile.tabs.slice().sort((a, b) => rank.get(a.id) - rank.get(b.id));
    tile.tabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  }
  return out;
}
// Where a tab is on screen: its own card, or the tile of its group.
const cardKey = (key) => state.tileOf.get(key) || key;
// What a card is sorted by under "By name": a tab's title (or site), a group's name.
const cardName = (e) => (e.kind === 'group' ? groupName(e.group) : e.tab.title || siteOf(urlOf(e.tab)));
// The tabs a card stands for: its own, or its group's.
const cardTabs = (e) => (e.kind === 'tab' ? [e.tab] : e.kind === 'group' ? e.tabs : NONE);
// Did a change of ticks (`before`, then state.picked) touch this card?
const tickChanged = (before) => (e) => cardTabs(e).some((x) => before.has(x.id) !== state.picked.has(x.id));

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
  const { cols, w } = gridColumns(avail);
  return n < cols ? Math.min(w, (CARD_SIZES[state.cardSize] || CARD_SIZES.default)[2]) : w;
}
// How many cards fit across `avail` px near the preferred size, and how wide each then is.
function gridColumns(avail) {
  const [want, min] = CARD_SIZES[state.cardSize] || CARD_SIZES.default;
  let cols = Math.max(1, Math.round((avail + GRID_GAP) / (want + GRID_GAP)));
  while (cols > 1 && (avail - GRID_GAP * (cols - 1)) / cols < min) cols--;
  return { cols, w: (avail - GRID_GAP * (cols - 1)) / cols };
}

// The window list on the left: "Merge all into this window", "All windows", then each window with a small
// picture of the tab it shows.
function renderWindows() {
  const multi = state.windows.length > 1 && state.inGroup === null; // (a group is in one window)
  el.wins.hidden = !multi;
  el.body.classList.toggle('with-wins', multi);
  if (!multi) return el.wins.replaceChildren();
  const rows = [{ id: 'all', label: t('allWindows'), count: state.tabs.length, activeTitle: '' }, ...state.windows];
  const top = [];
  if (state.otherWindows.length) { // every other window's tabs into this one (Undo puts them back)
    const all = h('button', 'wmergeall', null, 'windows-merge-all');
    all.type = 'button';
    all.title = t('mergeN', { count: state.otherWindows.length });
    all.setAttribute('aria-label', t('mergeAll'));
    all.append(svgOf(ICON.merge), h('span', 'wlabel', t('mergeAll'), 'windows-merge-all-label'));
    all.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) mergeWindows(state.otherWindows); });
    top.push(all);
  }
  el.wins.replaceChildren(...top, ...rows.map((w) => {
    const row = h('div', 'wrow', null, 'window-row'); // the window's button, and its merge button beside it (not inside: a button in a button is unreachable)
    const b = h('button', 'win', null, w.id === 'all' ? 'window-all' : 'window-item');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.scope === w.id));
    if (w.activeTitle) b.title = t('activeTab', { title: w.activeTitle });
    const pic = h('span', 'wpic', null, 'window-pic');
    if (w.id === 'all') pic.append(svgOf(ICON.windows));
    else {
      const p = w.activeId && state.previews[w.activeId];
      if (p && p.img) { const img = h('img', '', null, 'window-preview'); img.src = p.img; img.alt = ''; pic.append(img); }
      else { const img = h('img', 'wfav', null, 'window-favicon'); img.src = favicon(w.activeUrl || ''); img.alt = ''; pic.append(img); }
    }
    const text = h('span', 'wtext', null, 'window-text');
    text.append(h('span', 'wlabel', w.label, 'window-label'), h('span', 'wsub', t('tabs', { count: w.count }), 'window-count'));
    b.append(pic, text);
    row.append(b);
    if (w.id !== 'all' && w.id !== CTX.srcWin) { // pull this window's tabs into the current one (Undo puts them back)
      const m = h('button', 'wmerge', null, 'window-merge');
      m.type = 'button';
      m.title = t('mergeThis');
      m.setAttribute('aria-label', t('mergeThis'));
      m.append(svgOf(ICON.merge));
      m.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) mergeWindows([w.id]); });
      row.append(m);
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!pointerAllowed()) return;
      setScope(w.id);
      el.search.focus();
    });
    // Dropped on: tabs (or a group) move to this window, a page opens in it (see dragToMove).
    if (w.id !== 'all') {
      const there = (ids) => ids.every((id) => (state.tabs.find((x) => x.id === id) || {}).windowId === w.id);
      dropZone(row, (d) => (d.ids ? !there(d.ids) : d.group !== undefined ? (state.groups.get(d.group) || {}).windowId !== w.id : d.page || d.link),
        (d, e) => (d.ids || d.group !== undefined ? moveToWin(d, w.id) : openDropped(d.page || droppedLinks(e), { windowId: w.id })), 'drop-into');
    }
    return row;
  }));
}

function windowTag(tab) {
  if (state.scope !== 'all' || state.windows.length < 2 || tab.windowId === CTX.srcWin) return null;
  const w = state.windows.find((x) => x.id === tab.windowId);
  return w ? h('span', 'tag', w.label, 'card-window-tag') : null;
}
// A tab a snooze just brought back (the background reopens them unannounced), until it has been looked at.
function wokenTag(tab) {
  return state.woken[tab.id] ? h('span', 'tag woken', t('wokenTag'), 'card-woken') : null;
}
function pinnedBadge() {
  const b = h('span', 'badge', null, 'card-pinned');
  b.append(svgOf(ICON.pin));
  b.title = t('pinned');
  return b;
}

// A card's screenshot, kept from one redraw to the next (by card and capture), so its data URL isn't read and
// decoded again each time. A full redraw keeps only the ones it used (render()), so they don't pile up.
let shots = new Map(), shotsNext = null;
function shotImg(entry) {
  const p = entry.preview;
  const k = (entry.key || entry.kind + ':' + (entry.item ? entry.item.id : entry.url)) + '|' + (p.t || 0) + '|' + p.img.length;
  let img = shots.get(k);
  if (!img) {
    img = h('img', 'shot', null, 'card-preview');
    img.decoding = 'async';
    img.src = p.img;
    img.alt = '';
    if (shots.size > 1000) shots.clear();
    shots.set(k, img);
  }
  if (shotsNext) shotsNext.set(k, img);
  return img;
}
// `loading`: its preview is still being read (just after the first draw): the favicon on a plain tile, nothing
// that says "no preview" or offers to capture one.
function thumbFor(entry, { label, sub, icon, action, loading = false, bare = false }) {
  const thumb = h('div', 'thumb', null, 'card-thumb');
  if (loading) {
    const box = h('div', 'nopreview loading', null, 'card-loading');
    const tile = h('div', 'tile', null, 'card-tile');
    const img = h('img', '', null, 'card-tile-favicon');
    img.src = favicon(entry.url);
    img.alt = '';
    tile.append(img);
    box.append(tile);
    thumb.append(box);
  } else if (entry.preview && entry.preview.img) {
    thumb.append(shotImg(entry));
    if (label) {
      const pill = h('span', 'pill', null, 'card-pill');
      pill.append(svgOf(icon));
      pill.append(label);
      thumb.append(pill);
    }
  } else {
    const box = h('div', 'nopreview', null, 'card-no-preview');
    const tile = h('div', 'tile', null, 'card-tile');
    const img = h('img', '', null, 'card-tile-favicon');
    img.src = favicon(entry.url);
    img.alt = '';
    if (bare) { // just the page's icon (the history: no "No preview yet", nothing can be captured there)
      tile.append(img);
      box.classList.add('bare');
      box.append(tile);
      thumb.append(box);
      return thumb;
    }
    const badge = h('span', 'icon', null, 'card-tile-badge');
    badge.append(svgOf(icon));
    tile.append(img, badge);
    box.append(tile, h('div', 'label', label || t('noPreview'), 'card-no-preview-label'), h('div', 'sub', sub || '', 'card-no-preview-sub'));
    if (action) box.append(action);
    thumb.append(box);
  }
  return thumb;
}

// Star / unstar the page a card shows. Stars live only in Tabazing (not Chrome's bookmarks).
function starButton(entry) {
  const on = isStarred(entry.url);
  const b = h('button', 'star' + (on ? ' on' : ''), null, 'card-star-button');
  b.type = 'button';
  b.title = t(on ? 'unstar' : 'star') + (IS_MAC ? ' (⌥S)' : ' (Alt+S)');
  b.setAttribute('aria-label', t(on ? 'unstarAria' : 'starAria'));
  b.setAttribute('aria-pressed', String(on));
  b.append(svgOf(ICON.star));
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) star(entry); });
  return b;
}

// "Capture preview" on a card that has none: shows that tab for a moment, then comes back.
const canCapture = (tab) => !tab.discarded && isCapturableUrl(urlOf(tab)) && !state.nocap.has(normalizeUrl(urlOf(tab))) && state.hostOk;
function captureButton(entry) {
  const busy = state.capturing === entry.tab.id;
  const b = h('button', 'snap', t(busy ? 'capturing' : 'capturePreview'), 'card-capture');
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
  if (!pref('showAge')) return null; // Settings: Show "days ago" tags
  const days = tab.lastAccessed > 0 ? Math.floor((Date.now() - tab.lastAccessed) / DAY_MS) : 0;
  return days >= 1 ? h('span', 'tag age', t('ageDays', { count: days }), 'card-age') : null;
}

function renderCard(entry, index) {
  if (entry.kind === 'group') return renderGroupCard(entry, index);
  // "Sleeping" is only for tabs Chrome unloaded while we were watching (Memory Saver
  // etc.): discarded now AND seen being discarded in this browser session. A tab that
  // is merely discarded because Chrome restored it lazily after a restart is not
  // sleeping: it shows its stored preview normally. Neither is a tab with no preview.
  const asleep = entry.kind === 'tab' && !!entry.tab.discarded && state.slept.has(entry.tab.id);
  const picked = entry.kind === 'tab' && state.picked.has(entry.tab.id);
  const willSleep = entry.kind === 'tab' && state.toSleep.has(entry.tab.id);
  const dim = !!state.hits && !state.hits.has(entry.key); // searching, and this card doesn't match
  const card = h('div', 'card' + (entry.kind === 'closed' || entry.kind === 'star' ? ' closed' : '') + (asleep || willSleep ? ' asleep' : '') + (picked ? ' picked' : '') + (dim ? ' nomatch' : ''), null, 'card-' + entry.kind);
  card.id = 'opt-' + entry.key;
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', String(index === state.sel)); // the cursor (one card)
  card._i = index; // its place in state.entries (select() and the mouse find cards by it)
  if (index === state.sel) selCard = card;
  if (entry.kind === 'tab') card.setAttribute('aria-checked', String(picked)); // ticked for a quick action (any number)

  const head = h('div', 'head', null, 'card-head');
  const fav = h('img', 'fav', null, 'card-favicon');
  fav.alt = '';

  if (entry.kind === 'tab') {
    const tab = entry.tab;
    entry.url = urlOf(tab);
    fav.src = favicon(entry.url);
    const host = hostOf(entry.url);
    if (index < 9) head.append(h('span', 'knum', String(index + 1), 'card-number')); // the first nine are numbered: press 1-9 to switch to them
    head.append(pickBox(entry, picked), fav, h('span', 'title', tab.title || host || t('untitled'), 'card-title'));
    // Its tags (days since it was used, its window, pinned, back from snooze) sit on the picture, top left, as
    // small pills; in a list, compact in the row. The header keeps its room for the title.
    const flags = h('span', 'flags', null, 'card-flags');
    flags.append(...[groupTag(tab, 'tag', 'card-group-tag'), tabAge(tab), windowTag(tab), wokenTag(tab), tab.pinned && pinnedBadge()].filter(Boolean));
    // The site name only fits next to the title on wider cards, and only when no tags compete with it; narrow
    // ones keep the title readable (the full URL is in the tooltip).
    if (!flags.firstChild && tab.title && host && state.cardW >= 300 && state.cardSize !== 'list') head.append(h('span', 'host', host.replace(/^www\./, ''), 'card-host'));
    if (state.dupesView) { const goes = dupeIds().has(tab.id); head.append(h('span', 'tag ' + (goes ? 'goes' : 'stays'), t(goes ? 'dupeCloses' : 'dupeStays'), goes ? 'card-dupe-closes' : 'card-dupe-stays')); }
    if (tab.audible || isMuted(tab)) head.append(audioBadge(tab)); // playing sound (or muted): click to mute / unmute
    const x = h('button', 'x', null, 'card-close');
    x.type = 'button';
    x.title = t('closeTabTitle');
    x.setAttribute('aria-label', t('closeTab'));
    x.append(svgOf(ICON.close));
    x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeTab(entry); });
    head.append(headButtons(starButton(entry), x));
    card.title = (tab.title || '') + '\n' + entry.url + (asleep ? '\n' + t('sleepingTip') : '');
    if (state.cardSize === 'list') { // List: one line, no screenshot; the tags and the quick buttons sit in the row
      if (flags.firstChild) head.querySelector('.title').after(flags);
      head.insertBefore(quickActions(entry), head.querySelector('.hbtns'));
      card.append(head);
      return finishCard(card, entry);
    }
    // No preview just means Chrome only lets us screenshot the visible tab and
    // we haven't seen this one yet; it's an awake background tab, not asleep.
    // The placeholder shows the domain, since narrow cards hide it in the header.
    const sub = host;
    const thumb = thumbFor(entry, asleep || willSleep
      ? { label: t(willSleep ? 'willSleep' : 'sleeping'), sub, icon: ICON.moon }
      : !entry.preview && state.pvPending.has(tab.id) ? { loading: true }
      : { label: entry.preview ? '' : t('noPreview'), sub, icon: ICON.camera, action: !entry.preview && canCapture(tab) ? captureButton(entry) : null });
    if (flags.firstChild) thumb.append(flags);
    thumb.append(quickActions(entry));
    card.append(head, thumb);
  } else {
    const c = entry.item;
    entry.url = c.url;
    fav.src = favicon(entry.url);
    const title = c.title || hostOf(c.url);
    // Some entries (e.g. closed windows) come without a time: no time tag then.
    const ago = timeAgo(c.ts / 1000);
    head.append(fav, h('span', 'title', title, 'card-title'));
    if (ago && entry.kind === 'closed') head.append(h('span', 'tag', ago, 'card-closed-ago'));
    if (entry.kind === 'snoozed') head.append(h('span', 'tag snz', t('wakesAt', { time: whenLabel(c.ts) }), 'card-wakes'));
    const btns = [];
    if (entry.kind === 'closed') btns.push(deleteButton(t('closedRemove'), 'card-closed-remove', () => forgetClosed(entry))); // (its star is in its ⋯)
    else if (c.kind !== 'window') btns.push(starButton(entry));
    if (entry.kind === 'snoozed') { // × cancels the snooze (the tab is not reopened)
      const x = h('button', 'x', null, 'card-cancel-snooze');
      x.type = 'button';
      x.title = t('cancelSnooze');
      x.setAttribute('aria-label', t('cancelSnooze'));
      x.append(svgOf(ICON.close));
      x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeTab(entry); });
      btns.push(x);
    }
    if (btns.length) head.append(headButtons(...btns));
    card.title = entry.kind === 'snoozed' ? t('snoozedTip', { title }) + '\n' + c.url : t('reopenTip', { title }) + (c.kind !== 'window' ? '\n' + c.url : '');
    const quick = entry.kind === 'closed' ? closedQuick(entry) : null; // its note and ⋯ (everything else it can do)
    if (state.cardSize === 'list') { if (quick) head.insertBefore(quick, head.querySelector('.hbtns')); card.append(head); return finishCard(card, entry); }
    const thumb = entry.kind === 'snoozed'
      ? thumbFor(entry, { label: t('snoozedLabel'), sub: hostOf(entry.url), icon: ICON.clock })
      : entry.kind === 'star'
      ? thumbFor(entry, { label: t('starred'), sub: hostOf(entry.url), icon: ICON.star })
      : thumbFor(entry, { label: t('closedLabel'), sub: hostOf(entry.url), icon: ICON.history });
    if (quick) thumb.append(quick);
    card.append(head, thumb);
  }
  return finishCard(card, entry);
}

// ---- tab groups: Chrome's groups as tiles among the cards (derive: groupTiles). A tile's picture is its first
// tabs (up to four), in the group's colour; opening it (click, Enter, its number) shows only that group's tabs
// (the group view), and every open of Tabazing shows them until the group is left (its "All tabs" button, or
// Backspace in the empty search box).
const groupColor = (g) => (g && GROUP_COLORS.includes(g.color) ? g.color : 'grey');
// A group without a name is called by its colour ("Blue group"), as Chrome shows it: by its colour only.
const groupName = (g) => (g && g.title) || t('groupUnnamed', { color: groupColor(g) });
function renderGroupCard(entry, index) {
  const g = entry.group, n = entry.tabs.length, name = groupName(g);
  const dim = !!state.hits && !state.hits.has(entry.key);
  // Its tabs' ticks: all of them (the tile looks ticked), some (its box shows a dash), or none.
  const ticked = entry.tabs.filter((x) => state.picked.has(x.id)).length;
  const on = ticked && ticked === n ? true : ticked ? 'mixed' : false;
  const card = h('div', 'card gtile' + (dim ? ' nomatch' : '') + (on === true ? ' picked' : ''), null, 'card-group');
  card.id = 'opt-' + entry.key;
  card.dataset.gc = groupColor(g);
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', String(index === state.sel));
  card.setAttribute('aria-checked', String(on));
  card.setAttribute('aria-label', t('groupAria', { name, tabs: t('tabs', { count: n }) }));
  card._i = index;
  if (index === state.sel) selCard = card;
  const head = h('div', 'head', null, 'card-head');
  if (index < 9) head.append(h('span', 'knum', String(index + 1), 'card-number'));
  head.append(pickBox(entry, on), h('span', 'gdot', null, 'card-group-dot'), h('span', 'title', name, 'card-title'), h('span', 'tag gcount', t('tabs', { count: n }), 'card-group-count'));
  // × closes the group's tabs, as on a tab's card (Undo brings them back, in their group).
  const x = h('button', 'x', null, 'card-close');
  x.type = 'button';
  x.title = t('groupClose');
  x.setAttribute('aria-label', t('groupClose'));
  x.append(svgOf(ICON.close));
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeTab(entry); });
  head.append(headButtons(x));
  card.title = [t('groupTip', { name }), ...entry.tabs.slice(0, 12).map((x) => '· ' + (x.title || siteOf(urlOf(x)))), ...(n > 12 ? ['…'] : [])].join('\n');
  const more = h('button', 'qbtn', null, 'quick-more');
  more.type = 'button';
  more.title = t('cardMenu');
  more.setAttribute('aria-label', t('cardMenu'));
  more.setAttribute('aria-haspopup', 'menu');
  more.append(svgOf(ICON.more));
  more.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) cardMenu(entry, { anchor: more }); });
  const quick = h('div', 'quick', null, 'card-quick-actions');
  quick.append(more);
  const flags = groupFlags(entry);
  if (state.cardSize === 'list') { // a row: its colour, name, count, what its tabs are doing, the first four favicons
    const peek = h('span', 'peek', null, 'card-group-peek');
    for (const x of entry.tabs.slice(0, 4)) { const i = h('img', '', null, 'card-group-favicon'); i.src = favicon(urlOf(x)); i.alt = ''; peek.append(i); }
    if (flags.firstChild) head.querySelector('.gcount').after(flags);
    head.insertBefore(peek, head.querySelector('.hbtns'));
    head.insertBefore(quick, head.querySelector('.hbtns'));
    card.append(head);
    return finishCard(card, entry);
  }
  // As many cells as it has tabs, up to four (switcher.css .gmosaic.n1-n4): one fills the picture, two sit side by
  // side, three are one big and two small, four two by two. No empty placeholders.
  const shown = entry.tabs.slice(0, 4);
  const thumb = h('div', 'thumb gmosaic n' + shown.length, null, 'card-thumb');
  for (const x of shown) {
    const cell = h('div', 'gcell', null, 'card-group-cell');
    const p = state.previews[x.id];
    if (p && p.img) cell.append(shotImg({ key: 'gt' + x.id, preview: p }));
    else { const img = h('img', 'gfav', null, 'card-group-favicon'); img.src = favicon(urlOf(x)); img.alt = ''; cell.append(img); }
    thumb.append(cell);
  }
  if (n > 4) thumb.append(h('span', 'pill', t('groupMoreN', { count: n - 4 }), 'card-group-more'));
  if (flags.firstChild) thumb.append(flags);
  thumb.append(quick);
  card.append(head, thumb);
  return finishCard(card, entry);
}
// What a tile says about its tabs, as small pills on its picture (in a list, in its row): the current tab is in it,
// its window (with Show all windows), collapsed in Chrome's tab strip, and how many of its tabs play sound (or are
// muted), sleep, have a note or a star.
function groupFlags(entry) {
  const box = h('span', 'flags', null, 'card-flags');
  const tabs = entry.tabs;
  if (tabs.some((x) => x.id === CTX.srcTab)) box.append(h('span', 'tag here', t('groupHere'), 'card-group-here'));
  const win = windowTag({ windowId: entry.group.windowId });
  if (win) box.append(win);
  if (entry.group.collapsed) box.append(h('span', 'tag', t('groupCollapsed'), 'card-group-collapsed'));
  const count = (icon, n, label, testid) => {
    if (!n) return;
    const b = h('span', 'badge gflag', null, testid);
    b.append(svgOf(ICON[icon]), h('span', 'n', String(n), testid + '-n'));
    b.title = label;
    b.setAttribute('role', 'img');
    b.setAttribute('aria-label', label);
    box.append(b);
  };
  const sound = tabs.filter((x) => x.audible || isMuted(x)).length;
  const asleep = tabs.filter((x) => x.discarded || state.toSleep.has(x.id)).length;
  const notes = tabs.filter((x) => noteOf(urlOf(x))).length;
  const stars = tabs.filter((x) => isStarred(urlOf(x))).length;
  count(tabs.some((x) => x.audible && !isMuted(x)) ? 'speaker' : 'muted', sound, t('groupFlagSound', { count: sound }), 'card-group-sound');
  count('moon', asleep, t('groupFlagAsleep', { count: asleep }), 'card-group-asleep');
  count('note', notes, t('groupFlagNotes', { count: notes }), 'card-group-notes');
  count('star', stars, t('groupFlagStars', { count: stars }), 'card-group-stars');
  return box;
}

// The group view's title row: "‹ All tabs" (with its key), the group's colour and name (the section's heading), how many tabs.
function renderGroupBar() {
  const g = state.inGroup !== null ? state.groups.get(state.inGroup) : null;
  el.body.classList.toggle('in-group', !!g);
  el.groupLeave.hidden = el.groupDot.hidden = el.groupN.hidden = !g;
  el.openH.textContent = g ? groupName(g) : t('openTabs');
  if (!g) { delete el.body.dataset.gc; return; }
  el.body.dataset.gc = groupColor(g);
  el.groupN.textContent = t('tabs', { count: state.matchCount });
  el.groupLeave.title = t('groupLeaveTitle');
}

// The star and × of a card's header: laid over the end of the title (they show on hover, on the selected card
// and with the focus), so while hidden they take none of its room.
// A card's delete button (a trash can, red on hover): a recently closed entry off the list, a page out of the history.
function deleteButton(label, testid, fn) {
  const b = h('button', 'x del', null, testid);
  b.type = 'button';
  b.title = label + (IS_MAC ? ' (⌘⌫)' : ' (Del)');
  b.setAttribute('aria-label', label);
  b.append(svgOf(ICON.trash));
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) fn(); });
  return b;
}

// Middle-click (the mouse wheel) on `node` runs `fn`. Pressing the wheel would start Chrome's auto-scroll first,
// which swallows the click, so that is turned off on it.
function onMiddleClick(node, fn) {
  node.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  node.addEventListener('auxclick', (e) => { if (e.button !== 1) return; e.preventDefault(); e.stopPropagation(); if (pointerAllowed()) fn(); });
}

function headButtons(...btns) {
  const box = h('span', 'hbtns' + (btns.length > 1 ? ' two' : ''), null, 'card-head-buttons');
  box.append(...btns);
  return box;
}

// What every card does, whatever it shows: click to open, drag to move, right-click for its menu (hovering selects nothing).
function finishCard(card, entry) {
  // Its address, for screen readers (on screen it is only in the tooltip): the card's description.
  const desc = h('span', '', entry.kind === 'group' ? entry.tabs.map((x) => x.title || siteOf(urlOf(x))).join(', ') : siteOf(entry.url) || entry.url, 'card-description');
  desc.id = 'desc-' + card.id;
  desc.hidden = true;
  card.append(desc);
  card.setAttribute('aria-describedby', desc.id);
  mouseOnly(card);
  card.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pointerAllowed()) return;
    // Ctrl+click (Cmd+click on a Mac) ticks a tab, Shift+click shows the preview big. A plain click always
    // switches, ticks or not (the tick box itself ticks, and Shift+click on it ticks a range).
    if ((e.ctrlKey || e.metaKey) && (entry.kind === 'tab' || entry.kind === 'group')) return pick(entry);
    if (e.shiftKey) return openBig(entry);
    choose(state.entries.indexOf(entry));
  });
  // Right-click: the card's own menu at the pointer (the same as ⋯ and Shift+F10), not Chrome's.
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pointerAllowed()) return;
    select(card._i, { scroll: false });
    cardMenu(entry, { at: { x: e.clientX, y: e.clientY } });
  });
  // Drag (see dragToMove): a tab onto a group's tile, a window, Snoozed or Recently closed; By order, also before /
  // after other cards. A page that isn't open: onto the open tabs, a tile or a window, to open it there.
  if ((entry.kind === 'tab' || entry.kind === 'group') && !state.dupesView) dragToMove(card, entry);
  else if (entry.kind === 'closed' || entry.kind === 'snoozed' || entry.kind === 'star') dragToOpen(card, entry);
  // Middle-click (the mouse wheel): what Del does - a tab (or a tile's tabs) closes, a recently closed page leaves the
  // list, a snoozed one its snooze; a starred page that isn't open opens behind Tabazing, as a link would.
  onMiddleClick(card, () => (entry.kind === 'star' ? historyBehind(entry.item).catch((err) => toast(t('actFailed'), err)) : closeTab(entry)));
  // Hovering doesn't select: the selection (the lifted card, what Enter opens) stays where the keyboard put it;
  // a click switches to the tab.
  return card;
}

// A section: a header you can click to collapse it (remembered between opens), then its cards.
// Buttons inside a card are for the mouse: an option can't hold buttons (screen readers drop them), and the
// keyboard reaches all of them through the card's menu (Shift+F10, cardMenu) and the keys.
// A press doesn't move the focus to one (it stays where it was, in the search box); when one is given the focus
// anyway (a note card closing gives it back to its button), it isn't hidden while it has it: Chrome refuses
// aria-hidden on the focused element.
function mouseOnly(card) {
  card.querySelectorAll('button').forEach((b) => {
    b.tabIndex = -1;
    b.setAttribute('aria-hidden', 'true');
    b.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
    b.addEventListener('focus', () => b.removeAttribute('aria-hidden'));
    b.addEventListener('blur', () => b.setAttribute('aria-hidden', 'true'));
  });
}

function renderSection(sec, startIndex) {
  const box = h('div', 'gsec' + (sec.collapsed ? ' collapsed' : ''), null, 'section');
  box.setAttribute('role', 'group');
  if (!sec.plain) {
    box.setAttribute('aria-label', sec.title);
    const head = h('button', 'ghead', null, 'section-toggle');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(!sec.collapsed));
    head.title = t(sec.collapsed ? 'sectionShow' : 'sectionCollapse');
    const chev = h('span', 'chev', null, 'section-chevron');
    chev.append(svgOf(ICON.chevron));
    head.append(chev);
    if (sec.site) {
      const fav = h('img', 'sfav', null, 'section-favicon');
      fav.src = favicon(sec.site);
      fav.alt = '';
      head.append(fav);
    }
    const name = h('span', 'gname', sec.title, 'section-name');
    name.id = 'sec-' + hashOf(sec.key);
    head.append(name, h('span', 'n', String(sec.entries.length), 'section-count'));
    if (sec.collapsed) { // a peek at what's inside
      const peek = h('span', 'peek', null, 'section-peek');
      for (const e of sec.entries.slice(0, 8)) { const i = h('img', '', null, 'section-peek-favicon'); i.src = favicon(urlOf(e.tab || e.tabs[0])); i.alt = ''; peek.append(i); }
      head.append(peek);
    }
    head.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) toggleSection(sec.key); });
    const hrow = h('div', 'hrow', null, 'section-header');
    hrow.append(head);
    box.append(hrow);
  }
  if (!sec.collapsed) {
    const grid = h('div', 'grid' + (state.cardSize === 'default' ? '' : ' ' + state.cardSize), null, 'section-grid');
    grid.setAttribute('role', 'listbox'); // one list per section: its header button stays outside the list
    grid.setAttribute('aria-labelledby', sec.plain ? 'open-h' : 'sec-' + hashOf(sec.key));
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
    // Just the icon and how many: the name is the tooltip, and with the count what screen readers say.
    const b = h('button', 'chip', null, 'filter-' + id);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.filter === id));
    b.setAttribute('aria-label', t('chipAria', { name: t(f.label), count: n }));
    b.title = t(f.label);
    b.append(svgOf(ICON[f.icon]));
    b.append(h('span', 'n', String(n), 'filter-count'));
    b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) setFilter(state.filter === id ? null : id); });
    return b;
  }).filter(Boolean));
  // Merge: pull every other window's tabs into this one. Only with "Show tabs from all windows" on (else the
  // other windows aren't in view), and only while the window list, which has its own, doesn't show.
  el.mergeBtn.hidden = !state.otherWindows.length || !state.allWindows || !el.wins.hidden || state.inGroup !== null;
  el.mergeText.textContent = t('mergeN', { count: state.otherWindows.length });
  el.sort.value = state.sort;
  if (el.sort._fancy) el.sort._fancy.sync();
  el.starFilter.setAttribute('aria-pressed', String(state.starOnly));
  const stars = Object.keys(state.stars).length;
  el.starN.textContent = String(stars);
  el.starFilter.setAttribute('aria-label', t('chipAria', { name: t('starred'), count: stars }));
  el.starFilter.title = t('starred');
  const d = duplicates().length;
  el.dupesBtn.hidden = d === 0 || state.inGroup !== null; // (about every tab, not the group's)
  el.dupesText.textContent = t('dupesBtn', { count: d });
  el.dupesBtn.setAttribute('aria-pressed', String(state.dupesView));
  el.dupesBtn.title = t('dupesTitle');
  updateSweepButton();
}

// `only` (redraw()): build again just the cards it picks, leaving the others as they are.
function render(only) {
  const f = focusMark();
  hideTip();
  closeBig();
  const snoozedPart = state.entries.slice(state.openCount, state.openCount + state.snoozeCount);
  const closed = state.entries.slice(state.openCount + state.snoozeCount);

  // The window list first: the cards are sized from the space it leaves. Then the bars (the cards don't
  // depend on them), then the layout is read once (card width, header height) before the cards are built:
  // a read after building them would lay out thousands of new nodes twice.
  layoutHeader();
  renderWindows();
  renderCount();
  renderTools();
  renderActs();
  renderPlayer();
  renderGroupBar();
  if (!only) state.cardW = Math.floor(cardWidth(state.cardCount));
  el.body.style.setProperty('--top', topOf() + 'px');
  if (only) redrawCards(only);
  else {
    shotsNext = new Map();
    el.openGrid.classList.toggle('has-groups', state.sections.some((x) => !x.plain));
    let at = 0;
    el.openGrid.replaceChildren(...state.sections.map((sec) => { const box = renderSection(sec, at); if (!sec.collapsed) at += sec.entries.length; return box; }));
    el.closedGrid.className = el.snoozedGrid.className = state.cardSize === 'list' ? 'grid list' : 'grid small';
    el.snoozedGrid.replaceChildren(...snoozedPart.map((e, i) => renderCard(e, i + state.openCount)));
    el.closedGrid.replaceChildren(...closed.map((e, i) => renderCard(e, i + state.openCount + state.snoozeCount)));
    shots = shotsNext; // the screenshots this draw used: the rest can go
    shotsNext = null;
    cardList = [...document.querySelectorAll('#scroller .card')];
  }
  el.snoozedSection.hidden = snoozedPart.length === 0;
  // While searching, "Recently closed" reaches back 7 days: say so, so nobody expects more.
  el.closedH.textContent = state.starOnly ? t('starredNotOpen') : state.query ? t('closedSearchH') : t('recentlyClosed');
  // Nothing found: say what Enter does with the text (open it as an address, or search the web for it).
  const q0 = state.query.trim();
  el.openEmpty.textContent = state.starOnly && !q0 ? t('noStarredOpen')
    : q0 && !state.entries.length ? (asUrl(q0) ? t('enterOpen', { address: q0 }) : t('enterSearch', { text: q0 }))
    : q0 ? t('noMatchShift') : t('noMatch');
  el.openEmpty.hidden = state.matchCount > 0;
  el.closedSection.hidden = closed.length === 0;
  // "Show more" when Recently closed holds more than it shows (and "Show fewer" once it shows them).
  el.closedMore.hidden = state.starOnly || !(state.closedMore ? state.closed.length > LIMITS.RECENTLY_CLOSED : state.closed.length > closed.length);
  el.closedMore.textContent = t(state.closedMore ? 'closedFewer' : 'closedMore');
  el.closedMore.setAttribute('aria-expanded', String(state.closedMore));

  renderDropdown();
  markHits();
  searchPlaceholder();
  select(state.sel, { scroll: true });
  if (state.palette) renderPalette(); // what it offers follows the tabs (the current one, duplicates, windows...)
  refocus(f);
  requestAnimationFrame(tipTruncated);
}
// Build again the cards `only` picks (same entries, same places): a tick, a star, mute, a new preview.
function redrawCards(only) {
  state.entries.forEach((e, i) => {
    if (!only(e)) return;
    const old = cardAt(i);
    if (!old) return;
    if (e.kind === 'tab') e.preview = state.previews[e.tab.id] || null; // as derive() hands it out
    const card = renderCard(e, i);
    old.replaceWith(card);
    cardList[i] = card;
  });
}
// After a change of layout only (Alt let go shows the search box, the window was resized): the cards are
// built again only when their width changes.
function relayout() {
  if (Math.floor(cardWidth(state.cardCount)) !== state.cardW) render();
  else redraw(null);
}
// Draw again after a change that keeps the same cards in the same order (refresh() otherwise): the cards
// `only` picks (none when null) are built again, everything around them as render() does.
function redraw(only, { keepKey } = {}) {
  if (keepKey) { const i = state.entries.findIndex((e) => e.key === keepKey); state.sel = i >= 0 ? i : 0; }
  deriveSearch(); // the dropdown's rows carry previews too
  deriveHits();
  render(only || (() => false));
}

// A redraw replaces the buttons it draws (chips, section headers, windows, the actions bar): put the focus
// back on the same one, found by its testid and place, so pressing one with the keyboard doesn't drop the
// focus (Tab would then start again from the top). If it is gone, the search box.
function focusMark() {
  const f = document.activeElement;
  if (!f || f === el.search || !el.app.contains(f) || !f.dataset.testid) return null;
  const same = [...el.app.querySelectorAll(`[data-testid="${f.dataset.testid}"]`)];
  return { f, id: f.dataset.testid, nth: same.indexOf(f) };
}
function refocus(m) {
  if (!m || m.f.isConnected) return;
  const same = el.app.querySelectorAll(`[data-testid="${m.id}"]`);
  const n = same[Math.min(m.nth, same.length - 1)];
  (n && n.tabIndex >= 0 && !n.closest('[hidden]') ? n : el.search).focus({ preventScroll: true });
}

// The count in the search box: how many tabs are shown, or how many open and closed tabs the search found.
function renderCount() {
  el.count.textContent = state.query.trim() ? t('countSearch', { open: state.found.length, closed: state.foundClosed.length }) : t('tabs', { count: state.matchCount });
}

// Text cut short with "…" gets its full wording as a tooltip.
function tipTruncated() {
  for (const n of document.querySelectorAll('.ltitle, .gname, .host, .lname .n, .mname .n, .litem span, .wlabel')) {
    if (n.scrollWidth > n.clientWidth + 1) n.title = n.textContent; else if (n.title === n.textContent) n.removeAttribute('title');
  }
}

// The header wraps on a narrow window: below 1100 px the media player gets its own row under the search box
// (and as wide), below 900 px the buttons around them show only their icons. The card area follows its height (setTop).
const NARROW_W = 1100, TIGHT_W = 900;
function layoutHeader(width = window.innerWidth) {
  el.bar.classList.toggle('narrow', width < NARROW_W);
  el.bar.classList.toggle('tight', width < TIGHT_W);
}

// The card area starts below the header, the toolbar, the alert bar and the quick-actions bar (if shown).
const topOf = () => el.bar.offsetHeight + el.tools.offsetHeight + (el.alert.hidden ? 0 : el.alert.offsetHeight + 4); // the actions pill floats: not counted
function setTop() {
  el.body.style.setProperty('--top', topOf() + 'px');
}

function toTop() { el.scroller.scrollTop = 0; }
function refresh({ keepKey } = {}) {
  const prevKey = keepKey || (state.entries[state.sel] || {}).key;
  derive();
  const i = state.entries.findIndex((e) => e.key === cardKey(prevKey)); // (a tab now in a tile: the tile)
  state.sel = i >= 0 ? i : 0;
  render();
}

// -------------------------------------------------------------- selection
// The cards on screen in state.entries order (render() and redrawCards() keep it), and the one marked selected
// and the list that points at it: a hover only touches the card it leaves and the one it reaches.
let cardList = [], selCard = null, selList = null;
function cardAt(i) {
  let c = cardList[i];
  if (!c || !c.isConnected || c._i !== i) { cardList = [...document.querySelectorAll('#scroller .card')]; c = cardList[i]; } // (not the archive overlay's)
  return c || null;
}
function select(i, { scroll = true } = {}) {
  const n = state.entries.length;
  if (!n) { state.sel = 0; return syncCombo(); }
  state.sel = ((i % n) + n) % n;
  const cur = cardAt(state.sel);
  if (!selCard || !selCard.isConnected) { // drawn some other way: check them all, as once
    document.querySelectorAll('#scroller .card').forEach((c) => c.setAttribute('aria-selected', String(c === cur)));
    document.querySelectorAll('#scroller [role=listbox]').forEach((l) => l.removeAttribute('aria-activedescendant'));
    selList = null;
  } else if (selCard !== cur) selCard.setAttribute('aria-selected', 'false');
  if (cur) cur.setAttribute('aria-selected', 'true');
  selCard = cur;
  syncCombo();
  if (!cur) return;
  const list = cur.closest('[role=listbox]');
  if (selList && selList !== list) selList.removeAttribute('aria-activedescendant');
  list.setAttribute('aria-activedescendant', cur.id);
  selList = list;
  if (scroll) cur.scrollIntoView({ block: 'nearest' });
}
// The search box is a combobox: the focus stays in it, so screen readers follow its aria-activedescendant,
// the dropdown's highlighted row while that shows, else the selected card.
function syncCombo() {
  const row = document.querySelector('.dd') && document.getElementById('dd-' + state.dd.hi);
  el.search.setAttribute('aria-expanded', String(!!row));
  const cur = row || cardAt(state.sel);
  if (cur) el.search.setAttribute('aria-activedescendant', cur.id);
  else el.search.removeAttribute('aria-activedescendant');
}

// Alt+Q / Tab cycle through open tabs only; arrows can reach "Recently closed".
// The sort orders the cards on screen, so this follows recent use (like Alt+Tab), not screen order.
// Alt+Q / Alt+W, the wheel while holding Alt, and Tab step through the open tabs in the order the cards
// are shown (pinned first, then the chosen sort), wrapping around at the ends: d = +1 is the next card,
// -1 the one before. From the selected card, or from the current tab when something else is selected.
function stepKey(from, d) {
  // every open tab the filters show (collapsed ones too), as Alt+Q / Alt+W step (derive); a group tile stands for its tabs
  const list = (state.steps || state.matches).map((e) => e.key);
  const n = list.length;
  if (!n) return null;
  let here = list.indexOf(from && cardKey(from));
  if (here < 0) here = list.indexOf(cardKey('t' + CTX.srcTab));
  if (here < 0) here = d > 0 ? -1 : n;
  return list[(((here + d) % n) + n) % n];
}
function cycle(d) {
  const cur = state.entries[state.sel];
  const s = stepFrom(cur && (cur.kind === 'tab' || cur.kind === 'group') ? cur.key : null, d);
  if (s.leave) return refresh({ keepKey: stepOutOfGroup(d) });
  if (s.key) selectKey(s.key);
}
// Where a step goes from the card `from` (d = +1 next, -1 previous). Among all the cards a group is its tile, one
// step like any card (letting go of Alt on it opens it: choose). In the group view, the group's tabs; past its
// first or last one the step leaves the group: { leave: true } (stepOutOfGroup goes on from there).
// Settings -> "Alt+Q / Alt+W go round inside a group": they wrap at its ends instead of stepping out.
function stepFrom(from, d) {
  if (state.inGroup === null) return { key: stepKey(from, d) };
  const list = (state.steps || state.matches).map((e) => e.key);
  if (!list.length) return { leave: true };
  let here = list.indexOf(from);
  if (here < 0) here = list.indexOf('t' + CTX.srcTab);
  const to = here < 0 ? (d > 0 ? 0 : list.length - 1) : here + d;
  if (pref('groupWrap')) return { key: list[((to % list.length) + list.length) % list.length] };
  return to >= 0 && to < list.length ? { key: list[to] } : { leave: true };
}
// Out of the group view by a step past its ends: the step lands on the card before or after the group's tile among
// all the cards, which may be another group's tile (not opened: only letting go of Alt there does). Returns that
// card's key. The group stays remembered (Esc then still finds it next time); switching to a tab outside it leaves
// it at the next open (boot), and opening another group replaces it.
function stepOutOfGroup(d) {
  const id = state.inGroup;
  state.group = null;
  state.leftGroup = id; // (a reload this open doesn't bring it back)
  derive();
  const list = (state.steps || state.matches).map((e) => e.key);
  if (!list.length) return null;
  const at = list.indexOf('g' + id);
  return at < 0 ? list[d > 0 ? 0 : list.length - 1] : list[(((at + d) % list.length) + list.length) % list.length];
}

// Select an open tab by key; if it sits in a collapsed section, open that section for this visit.
function selectKey(key) {
  key = cardKey(key);
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

// ← / → by where they point on screen: +1 toward the next card. Right-to-left (Arabic, Hebrew), the next one is on the left.
const ahead = (k) => ((k === 'ArrowRight') !== isRtl() ? 1 : -1);
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

// Whether Tabazing can keep a star or a note for this address (it keeps them by address, up to a length).
const canKeep = (url) => { const k = normalizeUrl(url); return !!k && k.length <= LIMITS.MAX_URL_KEY; };
async function star(entry) {
  if (!entry || !entry.url || (entry.item && entry.item.kind === 'window')) return;
  if (!canKeep(entry.url)) return toast(t('urlTooLong'));
  const on = await toggleStar(entry.url, entry.tab ? entry.tab.title : entry.item.title).catch(() => null);
  if (on === null || state.done) return;
  state.stars = await getStars().catch(() => state.stars);
  if (on) await loadStarPreviews();
  // Unstarring a starred-not-open card removes it from the list: keep the selection near it.
  const i = state.entries.indexOf(entry);
  // (Starred in the history or bookmarks view: not a card, so the selection stays where it is.)
  const next = i < 0 ? state.entries[state.sel] : !on && entry.kind === 'star' ? [state.entries[i + 1], state.entries[i - 1]].find((e) => e && e !== entry) : entry;
  // Only the Starred filter shows or hides cards by their star: else just the cards of that page change.
  const k = normalizeUrl(entry.url);
  if (state.starOnly) refresh({ keepKey: next && next.key });
  else redraw((e) => normalizeUrl(e.kind === 'tab' ? urlOf(e.tab) : e.item ? e.item.url : '') === k, { keepKey: next && next.key });
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
  if (entry.kind === 'group') return enterGroup(entry.group.id); // its tabs, and Tabazing stays
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
    if (entry.kind === 'tab') return await switchToTab(entry.tab);
    // Recently closed: restore into the window the user came from.
    if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
    const c = entry.item;
    if (c.session) await chrome.sessions.restore((c.session.tab || c.session.window).sessionId);
    else await reopenPage(c, { active: true }); // from our own log: reopen the page (in its group)
    return finish('restore');
  } catch (e) {
    console.warn('[Tabazing] could not open entry:', e && e.message);
    finish('cancel');
  }
}

// Into a tab group (its tile): the cards show only its tabs, remembered for every open until it is left. The
// group's most recently used tab other than the current one is selected (Enter goes back to where you were).
async function enterGroup(id) {
  if (state.done || !state.groups.has(id)) return;
  stopHolding();
  closePops();
  state.group = id;
  state.leftGroup = null;
  el.search.value = state.query = ''; // the group's cards, none of them dimmed
  state.dd.hidden = true;
  await setGroup(id).catch(() => {});
  if (state.done) return;
  const recent = state.tabs.filter((x) => x.groupId === id);
  const pick = recent.find((x) => x.id !== CTX.srcTab) || recent[0];
  refresh({ keepKey: pick ? 't' + pick.id : '-' });
  toTop();
  el.search.focus({ preventScroll: true });
  el.live.textContent = t('groupEntered', { name: groupName(state.groups.get(id)), tabs: t('tabs', { count: state.matchCount }) });
}
// Out of the group view, back to every tab, with the group's tile selected.
async function leaveGroup() {
  if (state.done || state.group === null) return;
  const id = state.group;
  state.group = null;
  await setGroup(null).catch(() => {});
  if (state.done) return;
  refresh({ keepKey: 'g' + id });
  el.search.focus({ preventScroll: true });
  el.live.textContent = t('groupLeft');
}

// Show an open tab and close the switcher (a card, or "Go to tab" in the media list). Rejects when Chrome can't.
async function switchToTab(tab) {
  if (tab.id === CTX.srcTab && CTX.mode === 'overlay') return finish('cancel');
  await chrome.tabs.update(tab.id, { active: true });
  if (CTX.mode === 'window' || tab.windowId !== CTX.srcWin) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return finish('switch');
}


async function closeTab(entry) {
  if (entry && entry.kind === 'star') return star(entry); // Del on a starred, not-open page unstars it
  if (entry && entry.kind === 'closed') return forgetClosed(entry); // Del on a recently closed one: off the list (Undo puts it back)
  if (entry && entry.kind === 'group') return closeMany(entry.tabs); // Del or middle-click on a tile: the group's tabs (Undo brings them back, in their group)
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
  // (A group's tile goes with its last tab.)
  const goes = (e) => (e.kind === 'tab' && e.tab.id === id)
    || (e.kind === 'group' && e.tabs.some((x) => x.id === id) && e.tabs.every((x) => x.id === id || !state.tabs.some((y) => y.id === x.id)));
  const i = state.entries.findIndex(goes);
  if (!keepKey && i >= 0 && i === state.sel) {
    const next = [state.entries[i + 1], state.entries[i - 1]].find((e) => e && (e.kind === 'tab' || e.kind === 'group'));
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
// `on`: true, false, or 'mixed' (a group tile with some of its tabs ticked).
function pickBox(entry, on) {
  const b = h('button', 'pick' + (on === true ? ' on' : on === 'mixed' ? ' mixed' : ''), null, 'card-pick');
  b.type = 'button';
  b.setAttribute('role', 'checkbox');
  b.setAttribute('aria-checked', String(on));
  b.setAttribute('aria-label', t('pickAria'));
  b.title = t('pickTitle');
  b.append(svgOf(ICON.check));
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) pick(entry, { range: e.shiftKey }); });
  return b;
}
function pick(entry, { range = false } = {}) {
  state.shiftBase = null; // a tick by hand ends a run of Shift+arrows
  if (entry.kind === 'group') { // a tile: all of its tabs, or (all ticked already) none of them
    const before = new Set(state.picked);
    const ids = entry.tabs.map((x) => x.id);
    const all = ids.every((x) => state.picked.has(x));
    ids.forEach((x) => (all ? state.picked.delete(x) : state.picked.add(x)));
    state.lastPick = null;
    return redraw(tickChanged(before), { keepKey: entry.key });
  }
  const id = entry.tab.id;
  const onScreen = state.entries.filter((e) => e.kind === 'tab').map((e) => e.tab.id);
  const a = range && state.lastPick !== null ? onScreen.indexOf(state.lastPick) : -1;
  const b = onScreen.indexOf(id);
  const before = new Set(state.picked);
  if (a >= 0 && b >= 0) onScreen.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => state.picked.add(x));
  else if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  state.lastPick = id;
  redraw(tickChanged(before), { keepKey: entry.key }); // only the cards that changed
}
const pickPool = () => (state.query.trim() ? state.found : state.matches); // what "Select all" ticks: the search's matches, or the cards
// (Ticks don't change which cards show: only the ticked or unticked ones are drawn again.)
// (A group tile shows its tabs' ticks: all of them ticked, or some.)
function selectAll() { const before = new Set(state.picked); state.shiftBase = null; pickPool().forEach((e) => state.picked.add(e.tab.id)); redraw(tickChanged(before)); }
function clearPicks() { const before = new Set(state.picked); state.picked.clear(); state.lastPick = null; state.shiftBase = null; redraw(tickChanged(before)); }
// Shift+arrows: tick from the card the run started on to the one the arrow reaches, like a file list. The run
// keeps the ticks there were before it and lays its range over them, so stepping back shrinks the range again.
function extendPick(k) {
  const from = state.entries[state.sel];
  if (!from) return;
  const across = k === 'ArrowRight' || k === 'ArrowLeft';
  if (across && !state.entries[state.sel + ahead(k)]) return; // at the first or last card: the range stays (no wrapping round)
  if (from.kind === 'tab' && !state.shiftBase) { state.shiftBase = new Set(state.picked); state.lastPick = from.tab.id; }
  if (across) moveSpatial(ahead(k), 0);
  else moveSpatial(0, k === 'ArrowDown' ? 1 : -1);
  const to = state.entries[state.sel];
  if (from.kind !== 'tab' || !to || to.kind !== 'tab') return; // from a tile or a closed card: it only moves
  const onScreen = state.entries.filter((e) => e.kind === 'tab').map((e) => e.tab.id);
  const a = onScreen.indexOf(state.lastPick), b = onScreen.indexOf(to.tab.id);
  if (a < 0) return;
  const before = new Set(state.picked);
  state.picked = new Set([...state.shiftBase, ...onScreen.slice(Math.min(a, b), Math.max(a, b) + 1)]);
  redraw(tickChanged(before), { keepKey: to.key });
}

// Quick actions act only on ticked tabs. While searching, "Select all N matching tabs" ticks the matches.
function targets() { return state.tabs.filter((x) => state.picked.has(x.id)); }

// `err`: what the note says when Chrome refuses. Closing has Undo, so it doesn't ask "sure?" first.
const ACTIONS = [
  { id: 'close', icon: 'close', label: () => t('actClose'), title: () => t('actCloseTitle'), run: closeMany, err: () => t('errClose') },
  { id: 'copy', icon: 'link', label: () => t('actCopy'), title: () => t('actCopyTitle'), run: (tabs) => copyLinks(tabs, 'plain'), err: () => t('copyFailed') },
  // In "More" (⋯): used less often.
  { id: 'md', more: true, label: () => t('actCopyMd'), title: () => t('actCopyMdTitle'), run: (tabs) => copyLinks(tabs, 'md'), err: () => t('copyFailed') },
  { id: 'win', more: true, label: () => t('actNewWindow'), run: moveToWindow, err: () => t('errMove') },
  { id: 'sleep', more: true, label: () => t('actSleep'), run: sleepTabs, err: () => t('errSleep') },
  { id: 'snooze', more: true, label: () => t('actSnooze'), run: (tabs, btn) => snoozeMenu(tabs, btn), err: () => t('errSnooze') },
  { id: 'archive', more: true, label: () => t('actArchive'), run: archiveTabs, err: () => t('errArchive') },
  { id: 'group', more: true, label: () => t('groupAddTo'), run: (tabs, btn) => groupMenu(tabs, btn), err: () => t('actFailed') },
  { id: 'bookmark', more: true, label: () => t('markMenu'), run: (tabs) => bookmarkDialog(tabs.filter((x) => isWorthReopening(urlOf(x))).map(pageOf)), err: () => t('markErr') },
  { id: 'pin', more: true, label: (tabs) => t(tabs.length && tabs.every((x) => x.pinned) ? 'actUnpin' : 'actPin'), run: pinTabs, err: () => t('errPin') },
  { id: 'mute', more: true, label: (tabs) => t(tabs.length && tabs.every((x) => x.mutedInfo && x.mutedInfo.muted) ? 'actUnmute' : 'actMute'), run: muteTabs, err: () => t('errMute') },
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
  if (!show) return placeToast();
  const pool = pickPool();
  const allPicked = pool.length > 0 && pool.every((e) => state.picked.has(e.tab.id));
  el.actsN.textContent = n ? t('pickedN', { count: n }) : '';
  el.actsN.hidden = !n;
  el.selAll.hidden = allPicked || !pool.length;
  el.selAll.textContent = state.query.trim() ? t('selAllMatches', { count: pool.length }) : t('selAllTabs', { count: pool.length });
  el.selNone.hidden = n === 0;
  el.actsHint.hidden = n === 0; // a plain click switches: say how to tick more
  el.actsHint.textContent = t('pickMoreHint', { key: IS_MAC ? '⌘' : 'Ctrl' });
  el.actsBtns.hidden = n === 0; // nothing to act on yet: only the "Select all" button shows
  const more = h('button', 'qa more', null, 'actions-more');
  more.type = 'button';
  more.title = t('actMore');
  more.setAttribute('aria-label', t('actMore'));
  more.append(svgOf(ICON.more));
  more.append(h('span', '', t('actMore'), 'actions-more-label'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pointerAllowed() || !n) return;
    menu(more, ACTIONS.filter((a) => a.more).map((a) => ({ label: a.label(tabs), err: a.err(), fn: () => a.run(targets(), more) })));
  });
  el.actsBtns.replaceChildren(...ACTIONS.filter((a) => !a.more).map((a) => {
    const b = h('button', 'qa' + (a.id === 'close' ? ' danger' : ''), null, 'action-' + a.id);
    b.type = 'button';
    b.append(svgOf(ICON[a.icon]));
    b.append(h('span', '', a.label(tabs), 'action-label'));
    if (a.title) b.title = a.title();
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!pointerAllowed() || !n) return;
      Promise.resolve(a.run(targets(), b)).catch((err) => toast(a.err(), err));
    });
    return b;
  }), more);
  placeToast();
}

// Duplicates: first a view of just the copies (each card says whether it stays or closes), then confirm.
function renderDupesBar() {
  const d = duplicates();
  el.acts.hidden = false;
  el.acts.classList.add('dupes');
  el.actsN.hidden = false;
  el.actsN.textContent = d.length ? t('dupesSummary', { count: d.length }) : t('dupesNone');
  el.selAll.hidden = true;
  el.selNone.hidden = true;
  el.actsHint.hidden = true;
  el.actsBtns.hidden = false;
  const close = h('button', 'qa danger', null, 'dupes-close'); // no "sure?": Undo brings them back
  close.type = 'button';
  close.append(svgOf(ICON.close));
  close.append(h('span', '', t('dupesClose', { count: d.length }), 'dupes-close-label'));
  close.disabled = !d.length;
  close.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeDupes(); });
  const back = h('button', 'qa', null, 'dupes-back');
  back.type = 'button';
  back.append(h('span', '', t('dupesBack'), 'dupes-back-label'));
  back.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) dupesView(false); });
  el.actsBtns.replaceChildren(close, back);
  placeToast();
}
function dupesView(on) {
  state.dupesView = on;
  state.picked.clear();
  refresh({ keepKey: '-' });
  toTop();
}

// Small note at the bottom of the switcher ("Copied 5 links"), optionally with one button ("Undo"). It sits
// above the actions bar while that shows (never over it), and waits while the pointer or the focus is on it,
// so its Undo can't run away. Screen readers hear it from the live region (#live-status), which is always
// there: one that shows up together with its text is often not read.
let toastTimer = null;
let toastAct = null; // the shown toast's button action (Undo), while it shows
let toastLeft = 0;   // how long the shown toast still stays (paused while hovered or focused)
let toastFrom = 0;
function toast(text, err, action) {
  if (err) console.warn('[Tabazing]', err && err.message);
  el.toast.textContent = text;
  el.live.textContent = action ? text + '. ' + action.label : text;
  toastAct = action ? action.fn : null;
  if (action) {
    const b = h('button', 'tact', action.label, 'toast-action');
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) toastUndo(); });
    el.toast.append(b);
  }
  el.toast.hidden = false;
  placeToast();
  toastLeft = action ? 5000 : 2600;
  toastRun();
}
function toastRun() {
  clearTimeout(toastTimer);
  toastFrom = performance.now();
  toastTimer = setTimeout(() => { el.toast.hidden = true; toastAct = null; }, toastLeft);
}
function toastPause() {
  if (el.toast.hidden || toastLeft <= 0) return;
  clearTimeout(toastTimer);
  toastTimer = null;
  toastLeft = Math.max(1500, toastLeft - (performance.now() - toastFrom)); // a moment to read it once let go
}
function toastResume() {
  if (el.toast.hidden || toastTimer || el.toast.matches(':hover') || el.toast.contains(document.activeElement)) return;
  toastRun();
}
// Above the actions bar while it shows, else at the bottom.
function placeToast() {
  el.toast.style.bottom = (el.acts.hidden ? 20 : 20 + el.acts.offsetHeight + 12) + 'px';
  el.toast.classList.toggle('lifted', !el.acts.hidden);
}
// The shown toast's button (Undo), from its click or a key. False when no toast offers one.
function toastUndo() {
  const fn = toastAct;
  if (!fn || el.toast.hidden) return false;
  el.toast.hidden = true;
  toastAct = null;
  fn();
  return true;
}

// ---- undo: Ctrl+Z (or Undo in the note that follows) takes back what was last done here: closing tabs,
// merging windows, moving tabs to a new window. Several tabs at once come back together, each in its own
// window and place, pinned as before. `kind`: 'close' | 'merge' | 'move'.
// A tab in a group keeps the group's id, name and colour: it goes back into it (regroup).
const undoRecord = (tabs) => tabs.map((x) => {
  const g = x.groupId >= 0 ? state.groups.get(x.groupId) : null;
  return { id: x.id, url: urlOf(x), windowId: x.windowId, index: x.index, pinned: !!x.pinned, ...(g ? { group: { id: g.id, title: g.title || '', color: groupColor(g) } } : {}) };
});
function pushUndo(tabs, kind = 'close', said = null) {
  if (!tabs.length) return;
  state.undo.push({ kind, tabs, at: Date.now(), inGroup: state.group }); // (the group view it was done in: Undo goes back to it)
  if (state.undo.length > 20) state.undo.shift();
  const text = said || (kind === 'close' ? t('closedN', { count: tabs.length }) : kind === 'merge' ? t('mergedN', { count: tabs.length }) : t('movedN', { count: tabs.length }));
  toast(text, null, { label: t('undo') + (IS_MAC ? ' (⌘Z)' : ' (Ctrl+Z)'), fn: undoLast });
}
async function undoLast() {
  const u = state.undo.pop();
  if (!u || state.done) return toast(t('undoNothing'));
  const closed = u.kind === 'close';
  try {
    const groups = closed ? await reopenAt(u.tabs, u.at) : await moveBack(u.tabs);
    // Done in a group view whose group went with it (its last tab closed): back in the group as it is again.
    if (u.inGroup !== null && u.inGroup !== undefined && groups && groups.has(u.inGroup)) { state.group = groups.get(u.inGroup); await setGroup(state.group).catch(() => {}); }
    toast(t(closed ? 'reopenedN' : 'movedBackN', { count: u.tabs.length }));
  } catch (e) { toast(t('errUndo'), e); }
  await loadClosed();
  await reload();
}
// Reopen closed tabs (undoRecord) where they were. One Chrome still lists as recently closed, closed within
// UNDO_SESSION_MS of `at` (when Tabazing closed it), comes back through Chrome, with its back/forward history.
// Chrome shows a tab it restores, so each window then shows the tab it showed before. The others are opened
// afresh, in the background.
const UNDO_SESSION_MS = 10000;
async function reopenAt(group, at = 0) {
  const sessions = at ? await chrome.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []) : [];
  const used = new Set();
  const wins = new Set(); // windows a restore showed a tab in
  const made = []; // [{ x, tab }] what came back, for regroup
  for (const x of [...group].sort((a, b) => a.index - b.index)) {
    const s = sessions.find((s) => s.tab && !used.has(s.tab.sessionId) && normalizeUrl(urlOf(s.tab)) === normalizeUrl(x.url)
      && Math.abs((s.lastModified || 0) * 1000 - at) <= UNDO_SESSION_MS);
    if (s) {
      used.add(s.tab.sessionId);
      asking = true; // Chrome shows the restored tab for a moment: that is not the user leaving
      try { const r = await chrome.sessions.restore(s.tab.sessionId); wins.add(x.windowId); made.push({ x, tab: r && r.tab }); continue; } catch {}
    }
    try { made.push({ x, tab: await chrome.tabs.create({ url: x.url, windowId: x.windowId, index: x.index, pinned: x.pinned, active: false }) }); }
    catch { made.push({ x, tab: await chrome.tabs.create({ url: x.url, windowId: CTX.srcWin, active: false }).catch(() => null) }); } // its window is gone
  }
  const groups = await regroup(made);
  for (const x of state.tabs) if (x.active && wins.has(x.windowId)) await chrome.tabs.update(x.id, { active: true }).catch(() => {});
  if (used.size) { asking = false; window.focus(); }
  return groups;
}
// Tabs an undo brought back or moved back ([{ x: undoRecord entry, tab }]) that were in a group go back into it, in
// the window they are in now (utils/groups.js putInGroup: the same group while it is still there, else one of the
// same name and colour, else a new one). One Chrome put in a group itself is left there. Resolves to old group id ->
// its id now.
async function regroup(made) {
  const out = new Map();
  if (!chrome.tabs.group || !chrome.tabGroups) return out;
  const byGroup = new Map(); // old id + window -> { g, win, ids }
  for (const { x, tab } of made) {
    if (!x.group || !tab || !Number.isInteger(tab.id)) continue;
    const now = await chrome.tabs.get(tab.id).catch(() => null);
    if (!now) continue;
    if (now.groupId >= 0) { out.set(x.group.id, now.groupId); continue; }
    const k = x.group.id + ':' + now.windowId;
    if (!byGroup.has(k)) byGroup.set(k, { g: x.group, win: now.windowId, ids: [] });
    byGroup.get(k).ids.push(tab.id);
  }
  for (const { g, win, ids } of byGroup.values()) {
    try { out.set(g.id, await putInGroup(ids, g, win)); }
    catch (e) { console.warn('[Tabazing] could not put tabs back in their group:', e && e.message); }
  }
  return out;
}
// Put moved tabs (undoRecord) back in their windows and places: the undo of a merge or of "Move to new window".
// A window that closed meanwhile (a merge empties it) is made again, behind Tabazing.
async function moveBack(tabs) {
  const open = new Set((await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => [])).map((w) => w.id));
  const byWin = new Map();
  for (const x of tabs) { if (!byWin.has(x.windowId)) byWin.set(x.windowId, []); byWin.get(x.windowId).push(x); }
  for (const [win, list] of byWin) {
    list.sort((a, b) => a.index - b.index);
    let target = win, rest = list;
    if (!open.has(win)) {
      asking = true; // a new window may take the focus for a moment
      try { target = (await chrome.windows.create({ tabId: list[0].id, focused: false })).id; rest = list.slice(1); }
      finally { asking = false; }
    }
    for (const x of rest) await chrome.tabs.move(x.id, { windowId: target, index: x.index });
    for (const x of list) if (x.pinned) await chrome.tabs.update(x.id, { pinned: true }).catch(() => {});
  }
  window.focus();
  return regroup(tabs.map((x) => ({ x, tab: { id: x.id } }))); // (moving a tab to another window takes it out of its group)
}

// Does this card show one of these tab ids (its own, or one in its group tile's picture)?
const showsTab = (e, ids) => (e.kind === 'tab' ? ids.has(e.tab.id) : e.kind === 'group' && e.tabs.slice(0, 4).some((x) => ids.has(x.id)));
// Draw what arrived meanwhile: some tabs' cards (`ids`, new previews), or everything (refresh).
function drawLater(ids) {
  if (!ids) return refresh();
  const set = new Set(ids);
  redraw((e) => showsTab(e, set));
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
  const back = state.palette ? el.palInput : el.search; // where the focus goes back to
  el.clip.value = text;
  el.clip.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  el.clip.value = '';
  back.focus({ preventScroll: true });
  return ok;
}
async function copyLinks(tabs, fmt) {
  const md = (s) => String(s || '').replace(/([\[\]])/g, '\\$1');
  const text = tabs.map((x) => (fmt === 'md' ? `- [${md(x.title || hostOf(urlOf(x)))}](${urlOf(x)})` : urlOf(x))).join('\n');
  toast((await copyText(text)) ? t('copiedN', { count: tabs.length }) : t('copyFailed'));
}

// Move tabs to a new window, in their order. It opens behind Tabazing, which stays, so the move can be undone;
// in an overlay, with the tab Tabazing is drawn over among them, Tabazing goes along to the new window and closes.
async function moveToWindow(tabs) {
  const undo = undoRecord(tabs);
  const own = CTX.mode === 'overlay' && tabs.some((x) => x.id === CTX.srcTab);
  const [first, ...rest] = tabs;
  asking = true; // the new window may take the focus for a moment
  try {
    const w = await chrome.windows.create({ tabId: first.id, focused: own });
    if (rest.length) await chrome.tabs.move(rest.map((x) => x.id), { windowId: w.id, index: -1 });
    await regroup(undo.map((x) => ({ x, tab: { id: x.id } }))); // their groups go along (one of each, in the new window)
  } finally { asking = false; }
  state.picked.clear();
  if (own) return finish('switch');
  window.focus();
  await reload();
  pushUndo(undo, 'move');
}

// The header's "New tab" (and the palette's): a new tab in the window Tabazing was opened from. In the group view
// the header's goes into that group (and its window).
async function openNewTab({ group = null } = {}) {
  const g = group !== null ? state.groups.get(group) : null;
  const win = g ? g.windowId : CTX.srcWin;
  try {
    if (CTX.mode === 'window' || win !== CTX.srcWin) await chrome.windows.update(win, { focused: true }).catch(() => {});
    const tab = await chrome.tabs.create({ windowId: win, active: true });
    if (g && chrome.tabs.group) await chrome.tabs.group({ tabIds: tab.id, groupId: g.id }).catch(() => {});
  } catch {}
  finish('switch');
}
// "Capture all previews" (the camera in the toolbar, or the palette): the background shows each tab without a
// preview for a moment, then opens Tabazing again; with nothing to capture, a note says so.
function captureAll() {
  const tabIds = missingPreviews().map((x) => x.id).slice(0, LIMITS.SWEEP_MAX_TABS);
  asking = true; // the progress window takes focus: that is not the user leaving
  return chrome.runtime.sendMessage({ type: MSG.SWEEP, tabIds, reopen: CTX.mode === 'overlay' ? CTX.srcTab : null })
    .then((r) => { asking = false; if (r && r.n) finish('switch'); else toast(t('sweepNothing')); })
    .catch(() => { asking = false; toast(t('errCapture')); });
}
// A search began or changed (the box's or the palette's): the first one reads the bookmarks and recent history
// (once, unless Settings -> Search leaves them out); Chrome's history search reaches older pages a moment later.
function startSearch(q) {
  if (q && state.marks === null && pref('searchBookmarks')) loadMarks();
  if (q && state.history === null && pref('searchHistory')) loadHistory();
  searchHistory(q);
}

// ---- open or search from the box: what was typed, when nothing matches it (or Shift+Enter).

// Something that looks like an address opens as one; anything else is searched on Google (utils/web.js).
async function openFromBox(text) {
  const url = asUrl(text);
  try {
    if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
    await chrome.tabs.create({ url: url || googleUrl(text), windowId: CTX.srcWin, active: true });
  } catch (e) { console.warn('[Tabazing] could not open from the search box:', e && e.message); }
  finish('switch');
}

// ---- the search dropdown: as you type, under the search box, one list of everything that matches (open
// tabs, archived tabs, bookmarks, recently closed, history), best match first, each with an icon saying where
// it comes from. With nothing found: a Google search (and "Open ..." first when the text looks like an
// address). ↑/↓ move, Enter opens, the mouse too.
const DD_MAX = 14;
// Where a result comes from: its icon at the end of the title row, and which one comes first when two
// match equally well (lowest first): open tabs, then recently closed, archived, bookmarks, history.
const DD_SOURCES = {
  tab: { rank: 0, icon: 'tab', label: 'srcTab' },
  closed: { rank: 1, icon: 'history', label: 'recentlyClosed' },
  archived: { rank: 2, icon: 'archive', label: 'archivedLabel' },
  mark: { rank: 3, icon: 'bookmark', label: 'srcMark' },
  visit: { rank: 4, icon: 'visited', label: 'ddHistory' },
  group: { rank: 0, icon: 'tab', label: 'srcGroup' },
};
async function loadMarks() {
  state.marks = [];
  if (!chrome.bookmarks) return;
  try {
    const out = [];
    const [tree, bmNotes] = await Promise.all([chrome.bookmarks.getTree(), getBmNotes().catch(() => state.bmNotes || {})]);
    state.bmNotes = bmNotes;
    // Archived tabs have their own section: leave out the "Tabs Archive" folder in "Other bookmarks" (as utils/archive.js finds it).
    const kids = (tree[0] && tree[0].children) || [];
    const other = kids.find((n) => n.folderType === 'other') || kids.find((n) => n.id === '2') || kids[1] || kids[0];
    const arch = other && (other.children || []).find((n) => !n.url && n.title === ARCHIVE_FOLDER);
    const walk = (n, path) => {
      if (arch && n.id === arch.id) return;
      if (n.url) { if (/^(https?|file|ftp):/i.test(n.url)) out.push({ id: n.id, title: n.title || '', url: n.url, path: path.join(' › ') }); return; }
      for (const c of n.children || []) walk(c, n.title ? [...path, n.title] : path);
    };
    tree.forEach((root) => walk(root, []));
    state.marks = out;
  } catch { state.marks = []; }
  if (!state.done && searchText()) renderSearch();
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
  if (!state.done && searchText()) renderSearch();
}
let histTimer = null;
function searchHistory(q) {
  clearTimeout(histTimer);
  if (!q || !chrome.history || !pref('searchHistory')) { state.histQ = { q: '', items: [] }; return; }
  histTimer = setTimeout(async () => {
    try {
      const items = await chrome.history.search({ text: q, startTime: 0, maxResults: 60 });
      if (searchText() !== q || state.done) return;
      state.histQ = { q, items: items.filter((x) => /^(https?|file|ftp):/i.test(x.url || '')).map(hist) };
      renderSearch();
    } catch {}
  }, 120);
}
// What is being searched for: the palette's text while it shows, else the search box's (trimmed).
const searchText = () => (state.palette ? el.palInput.value : state.query).trim();
// Draw the results again (a source finished loading): in the palette while it shows, else the dropdown.
const renderSearch = () => (state.palette ? renderPalette() : renderDropdown());
// Every history entry (the last 90 days, and Chrome's own search for the text), once per page, newest first.
// Built again only when one of the two lists changes. `text`: the text searched for (trimmed).
let histMemo = { h: undefined, hq: undefined, items: [] };
function historyItems(text = state.query.trim()) {
  const hq = state.histQ.q === text ? state.histQ : null;
  if (histMemo.h === state.history && histMemo.hq === hq) return histMemo.items;
  const byUrl = new Map();
  for (const x of [...(state.history || []), ...(hq ? hq.items : [])]) {
    const k = urlKey(x.url);
    if (k && !byUrl.has(k)) byUrl.set(k, x);
  }
  histMemo = { h: state.history, hq, items: [...byUrl.values()].sort((a, b) => b.t - a.t) };
  return histMemo.items;
}
// normalizeUrl, remembered (it parses the URL): the same thousands of addresses come up on every keystroke.
const urlKeys = new Map();
function urlKey(url) {
  let k = urlKeys.get(url);
  if (k === undefined) {
    k = normalizeUrl(url) || url;
    if (urlKeys.size > 50000) urlKeys.clear();
    urlKeys.set(url, k);
  }
  return k;
}
// Bookmarks and history can be thousands of pages. While the text only grows (another letter or word), the
// pages that matched before are the ones worth scoring; once typing pauses, all of them are scored again
// (a typo match can show up only then). [{ it, s }] in the list's own order.
const bigHits = {}; // source -> { items, q, hits }
let fullTimer = null;
function scoreBig(name, items, q, score) {
  const c = bigHits[name];
  if (c && c.items === items && c.q === q && c.notes === state.notes) return c.hits;
  const narrow = !!c && c.items === items && c.notes === state.notes && !!c.q && q.startsWith(c.q); // (a note written meanwhile: all again)
  const hits = [];
  for (const it of narrow ? c.hits.map((x) => x.it) : items) { const sc = score(it); if (sc > 0) hits.push({ it, s: sc }); }
  bigHits[name] = { items, q, hits, notes: state.notes };
  if (narrow) { clearTimeout(fullTimer); fullTimer = setTimeout(fullPass, 160); }
  return hits;
}
function fullPass() {
  if (state.done) return;
  for (const c of Object.values(bigHits)) c.q = ''; // the next scoring reads every page
  renderSearch();
}
const NONE = [];

// All the sources in one list, scored the same way (searchScore: more and better word matches, more points).
// A page found in several places is listed once, as the most useful of them (an open tab before its
// bookmark, ...), with the best score any of them got. Ties: that order, then each source's own order.
// `text`: what was typed (the search box's, or the command palette's: both show the same results).
function ddRows(text = state.query) {
  const typed = text.trim();
  const q = typed.toLowerCase();
  if (!q) return [];
  const { found, foundClosed } = foundFor(q);
  const best = new Map();
  let order = 0;
  const add = (key, s, row) => {
    if (s <= 0) return;
    const x = { ...row, key, s, rank: DD_SOURCES[row.kind].rank, order: order++ };
    const cur = best.get(key);
    if (!cur) return best.set(key, x);
    if (x.rank < cur.rank) best.set(key, { ...x, s: Math.max(s, cur.s) });
    else cur.s = Math.max(s, cur.s);
  };
  for (const e of found) add(urlKey(urlOf(e.tab)), searchScore(q, e.tab.title, urlOf(e.tab), noteOf(urlOf(e.tab)), tabStatus(e.tab)), { kind: 'tab', entry: e });
  // Tab groups by their name (Enter opens the group), just above their tabs that match as well.
  if (pref('showGroups')) {
    for (const g of state.groups.values()) {
      const s = searchScore(q, groupName(g));
      const tabs = s > 0 ? state.tabs.filter((x) => x.groupId === g.id) : NONE;
      if (tabs.length) add('g' + g.id, s + 1, { kind: 'group', g, tabs });
    }
  }
  for (const c of foundClosed) {
    const s = Math.max(0, ...c.fields.map(([title, url]) => searchScore(q, title, url, noteOf(url), pageStatus(url, 'closed'))));
    add(c.kind === 'window' ? 'w:' + c.id : urlKey(c.url), s, { kind: 'closed', c });
  }
  // A note is found wherever its page turns up (archived, bookmarked, visited), as on an open tab.
  for (const a of state.archived || NONE) { const s = searchScore(q, a.title, a.url, noteOf(a.url), pageStatus(a.url, 'archived')); if (s > 0) add(urlKey(a.url), s, { kind: 'archived', a }); }
  // Bookmarks and history only while Settings -> Search includes them.
  const marks = pref('searchBookmarks'), hist = pref('searchHistory');
  if (marks) for (const { it: b, s } of scoreBig('marks', state.marks || NONE, q, (b) => searchScore(q, b.title, b.url, b.path, noteOf(b.url), bmNoteOf(b.id), pageStatus(b.url, 'bookmarked')))) add(urlKey(b.url), s, { kind: 'mark', b });
  if (hist) for (const { it: x, s } of scoreBig('history', historyItems(typed), q, (x) => searchScore(q, x.title, x.url, noteOf(x.url), pageStatus(x.url, 'visited')))) add(urlKey(x.url), s, { kind: 'visit', x });
  // In the group view the group's own tabs come first.
  const mine = (r) => (state.inGroup !== null && r.kind === 'tab' && r.entry.tab.groupId === state.inGroup ? 1 : 0);
  const rows = [...best.values()].sort((a, b) => mine(b) - mine(a) || b.s - a.s || a.rank - b.rank || a.order - b.order).slice(0, DD_MAX);
  if (!rows.length) {
    const url = asUrl(typed);
    if (url) rows.push({ kind: 'url', url, key: 'url:' + url });
    rows.push({ kind: 'google', key: 'google' });
  }
  // No access to bookmarks or history: Chrome only turns on a new permission when the extension itself is
  // reloaded (an unpacked one picks up changed pages without that), so say so instead of skipping them silently.
  if (marks && !chrome.bookmarks) rows.push({ note: t('ddNoMarks') });
  if (hist && !chrome.history) rows.push({ note: t('ddNoHistory') });
  return rows;
}
// What a keystroke in the search box changes: the cards don't follow the search, so only the dropdown, the
// count and the actions bar.
let searchFrame = 0;
function flushSearch() {
  cancelAnimationFrame(searchFrame);
  searchFrame = 0;
  if (state.done) return;
  deriveSearch();
  deriveHits();
  markHits();
  renderDropdown();
  renderCount();
  renderActs();
}
const ddShown = () => !state.palette && !state.dd.hidden && state.dd.items.length > 0 && !!state.query.trim() && !document.documentElement.classList.contains('alttab');

function ddMove(d) {
  const n = state.dd.items.length;
  state.dd.hi = (((state.dd.hi + d) % n) + n) % n;
  state.dd.hiKey = rowKey(state.dd.items[state.dd.hi]);
  ddHighlight();
}
// A result row's identity (its page, its action): the highlight moved onto a row stays on it when results that
// come in late (Chrome's history, the bookmarks) reorder the list, so Enter opens the row that was chosen.
const rowKey = (r) => (!r ? null : r.key || (r.kind === 'action' ? 'a:' + r.a.id : r.kind));
const keepHighlight = (o) => { if (!o.hiKey) return; const j = o.items.findIndex((r) => rowKey(r) === o.hiKey); if (j >= 0) o.hi = j; };
// Move the highlight without building the list again.
function ddHighlight(scroll = true) {
  const dd = document.querySelector('.dd');
  if (!dd) return;
  dd.querySelectorAll('.ddr').forEach((x, k) => { x.classList.toggle('on', k === state.dd.hi); x.setAttribute('aria-selected', String(k === state.dd.hi)); });
  syncCombo();
  const on = dd.querySelector('.ddr.on');
  if (on && scroll) on.scrollIntoView({ block: 'nearest' });
}
// A row's picture (its preview, else its favicon), made once per page and reused as the list is redrawn
// on every keystroke, so screenshots aren't decoded again and again.
const ddPics = new Map();
function ddPic(key, url, preview, cls = 'ddpic') {
  const k = cls + '|' + key + '|' + (preview && preview.img ? preview.t || preview.img.length : '');
  let pic = ddPics.get(k);
  if (!pic) {
    if (cls === 'ddicon') { pic = h('img', 'ddicon', null, 'dd-favicon'); pic.src = favicon(url); pic.alt = ''; }
    else {
      pic = h('span', 'ddpic', null, 'dd-pic');
      if (preview && preview.img) { const img = h('img', '', null, 'dd-preview'); img.decoding = 'async'; img.src = preview.img; img.alt = ''; pic.append(img); }
      else { const img = h('img', 'ddfav', null, 'dd-pic-favicon'); img.src = favicon(url); img.alt = ''; pic.append(img); }
    }
    if (ddPics.size > 100) ddPics.clear(); // each keeps its picture decoded
    ddPics.set(k, pic);
  }
  return pic;
}
// A result's title row: the title, then any tags, then (at the far right) the icon of where it comes from
// (`src`: { icon, label }, DD_SOURCES or the palette's own). `ql`: the search's words, marked in the title.
function ddTitleRow(title, src, ql, testid, ...tags) {
  const line = h('span', 'ddtrow', null, 'dd-title-row');
  line.append(typeof title === 'string' ? hlSpan('ddtitle', title, ql) : title, ...tags.filter(Boolean)); // (or a node of its own)
  const icon = h('span', 'ddsrc', null, testid);
  icon.append(svgOf(ICON[src.icon]));
  icon.title = t(src.label);
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', t(src.label));
  line.append(icon);
  return line;
}
// The note on a result's page, whatever the page is now (open, recently closed, archived, bookmarked, visited):
// when the search found the words in it, its text under the title (why it came up); else a "Note" tag by the title.
// `more`: other notes that count (a bookmark's own).
function noteBits(urls, ql, more = []) {
  const notes = [...urls.map(noteOf), ...more].filter(Boolean);
  const hit = notes.find((n) => fieldHit(ql, n));
  return {
    tag: notes.length && !hit ? h('span', 'ddtag', t('noteTitle'), 'dd-note-tag') : null,
    line: hit ? hlSpan('ddsub ddnote2', hit, ql) : null,
  };
}
// The tab group a tab is in, as a tag in the group's colour (not in the group view: they all are).
function groupTag(tab, cls, testid) {
  const g = tab.groupId >= 0 && state.inGroup !== tab.groupId ? state.groups.get(tab.groupId) : null;
  if (!g) return null;
  const tag = h('span', cls + ' gtag', groupName(g), testid);
  tag.dataset.gc = groupColor(g);
  return tag;
}
// One search result (a ddRows() row) as an option: the dropdown's and the command palette's are the same.
// `q`: the text searched for; `on`: highlighted; `id`: the option's id (aria-activedescendant points at it).
function ddRowEl(r, q, on, id) {
  const ql = q.toLowerCase();
  const titleRow = (title, kind, ...tags) => ddTitleRow(title, DD_SOURCES[kind], ql, 'dd-source-' + kind, ...tags);
  const row = h('div', 'ddr' + (on ? ' on' : ''), null, 'dd-row-' + r.kind);
  row.id = id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(on));
  if (r.kind === 'tab') {
    const tab = r.entry.tab;
    const pic = ddPic('t' + tab.id, urlOf(tab), r.entry.preview);
    const txt = h('span', 'ddtxt', null, 'dd-text');
    const n = noteBits([urlOf(tab)], ql);
    const w = tab.windowId !== CTX.srcWin && state.windows.find((x) => x.id === tab.windowId);
    txt.append(titleRow(tab.title || siteOf(urlOf(tab)) || t('untitled'), 'tab', n.tag, groupTag(tab, 'ddtag', 'dd-group-tag'), w && h('span', 'ddtag', w.label, 'dd-window-tag')),
      hlSpan('ddsub', siteOf(urlOf(tab)), ql));
    if (n.line) txt.append(n.line);
    row.append(pic, txt);
  } else if (r.kind === 'mark') {
    const icon = ddPic(r.b.url, r.b.url, null, 'ddicon');
    const txt = h('span', 'ddtxt', null, 'dd-text');
    const n = noteBits([r.b.url], ql, [bmNoteOf(r.b.id)]);
    txt.append(titleRow(r.b.title || siteOf(r.b.url), 'mark', n.tag), hlSpan('ddsub', [siteOf(r.b.url), r.b.path].filter(Boolean).join(' · '), ql));
    if (n.line) txt.append(n.line);
    row.append(icon, txt);
  } else if (r.kind === 'archived') {
    const pic = ddPic('a' + r.a.id, r.a.url, state.archivePreviews[urlKey(r.a.url)]);
    const txt = h('span', 'ddtxt', null, 'dd-text');
    const ago = r.a.t ? timeAgo(r.a.t / 1000) : '';
    const n = noteBits([r.a.url], ql);
    txt.append(titleRow(r.a.title || siteOf(r.a.url), 'archived', n.tag), hlSpan('ddsub', [siteOf(r.a.url), ago].filter(Boolean).join(' · '), ql));
    if (n.line) txt.append(n.line);
    row.append(pic, txt);
  } else if (r.kind === 'closed') {
    const pic = ddPic('c' + r.c.id, r.c.url, r.c.preview);
    const txt = h('span', 'ddtxt', null, 'dd-text');
    const ago = r.c.ts ? timeAgo(r.c.ts / 1000) : '';
    const n = noteBits(r.c.fields.map(([, url]) => url), ql); // (a closed window: any of its tabs' notes)
    txt.append(titleRow(r.c.title || siteOf(r.c.url), 'closed', n.tag), hlSpan('ddsub', [r.c.kind === 'window' ? '' : siteOf(r.c.url), ago].filter(Boolean).join(' · '), ql));
    if (n.line) txt.append(n.line);
    row.append(pic, txt);
  } else if (r.kind === 'visit') {
    const icon = ddPic(r.x.url, r.x.url, null, 'ddicon');
    const txt = h('span', 'ddtxt', null, 'dd-text');
    const when = r.x.t ? t('visitedAgo', { when: timeAgo(r.x.t / 1000) }) : '';
    const n = noteBits([r.x.url], ql);
    txt.append(titleRow(r.x.title || siteOf(r.x.url), 'visit', n.tag), hlSpan('ddsub', [siteOf(r.x.url), when].filter(Boolean).join(' · '), ql));
    if (n.line) txt.append(n.line);
    row.append(icon, txt);
  } else if (r.kind === 'group') { // its colour, its name, how many tabs, the first ones' titles
    const pic = h('span', 'ddpic ddgroup', null, 'dd-group-pic');
    pic.dataset.gc = groupColor(r.g);
    pic.append(h('span', 'gdot', null, 'dd-group-dot'));
    const txt = h('span', 'ddtxt', null, 'dd-text');
    txt.append(titleRow(groupName(r.g), 'group', h('span', 'ddtag', t('tabs', { count: r.tabs.length }), 'dd-group-count')),
      hlSpan('ddsub', r.tabs.slice(0, 4).map((x) => x.title || siteOf(urlOf(x))).join(' · '), ql));
    row.append(pic, txt);
  } else if (r.kind === 'url') {
    const icon = h('img', 'ddicon', null, 'dd-favicon');
    icon.src = favicon(r.url);
    icon.alt = '';
    row.append(icon, h('span', 'ddtxt ddone', t('ddOpen', { address: q }), 'dd-text'));
  } else {
    const icon = h('span', 'ddicon ddg', 'G', 'dd-google-icon');
    icon.setAttribute('aria-hidden', 'true');
    row.append(icon, h('span', 'ddtxt ddone', t('ddGoogle', { text: q }), 'dd-text'));
  }
  return row;
}
function renderDropdown() {
  let dd = document.querySelector('.dd');
  const rows = state.query.trim() ? ddRows() : [];
  state.dd.items = rows.filter((r) => r.kind);
  keepHighlight(state.dd);
  if (state.dd.hi >= state.dd.items.length) state.dd.hi = 0;
  if (!ddShown()) { if (dd) dd.remove(); return syncCombo(); }
  if (!dd) {
    dd = h('div', 'dd', null, 'search-dropdown');
    dd.setAttribute('role', 'listbox');
    dd.id = 'dd';
    dd.addEventListener('mousedown', (e) => e.preventDefault()); // keep the focus (and the caret) in the search box
    el.app.append(dd);
  }
  const q = state.query.trim();
  let n = -1;
  // Like the cards, the pointer doesn't move the highlight (only ↑ / ↓ do): a row under it shows only its hover tint,
  // and a click opens it.
  dd.replaceChildren(...rows.map((r) => {
    if (r.note) return h('div', 'ddnote', r.note, 'dd-notice');
    const i = ++n;
    const row = ddRowEl(r, q, i === state.dd.hi, 'dd-' + i);
    row.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) ddActivate(r); });
    onMiddleClick(row, () => ddMiddle(r));
    return row;
  }));
  syncCombo();
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
// `text`: what was typed (the search box's, or the palette's), for "Open …" and "Search Google for …".
async function ddActivate(r, text = state.query.trim()) {
  if (!r || state.done) return;
  if (r.kind === 'closed') return restoreClosed(r.c);
  if (r.kind === 'group') { if (state.palette) exitPalette(); return enterGroup(r.g.id); }
  if (r.kind === 'archived') return openArchived(r.a);
  if (r.kind === 'tab') {
    const i = state.entries.findIndex((e) => e.key === r.entry.key); // its card, when the cards show it
    if (i >= 0) return choose(i);
    try { await chrome.tabs.update(r.entry.tab.id, { active: true }); await chrome.windows.update(r.entry.tab.windowId, { focused: true }); } catch {}
    return finish('switch');
  }
  if (r.kind === 'mark') return openPage(r.b.url);
  if (r.kind === 'visit') return openPage(r.x.url);
  return openFromBox(text); // 'url' and 'google'

}
// A middle-click on a result: as on its card, a tab (or a group's tabs) closes and a recently closed page leaves the
// list; a bookmark or a visited page opens behind Tabazing, which stays.
function ddMiddle(r) {
  if (state.done) return;
  if (r.kind === 'tab') return closeTab(r.entry);
  if (r.kind === 'group') return closeTab(groupEntry(r.g));
  if (r.kind === 'closed') return forgetClosed({ item: r.c });
  const url = r.kind === 'mark' ? r.b.url : r.kind === 'visit' ? r.x.url : null;
  if (url) historyBehind({ url }).catch((err) => toast(t('actFailed'), err));
}
// A recently closed page from Tabazing's own log (no history to restore): a new tab in the window Tabazing was
// opened from, back in the tab group it was in (Chrome's own restore does that itself).
async function reopenPage(c, { active }) {
  const tab = await chrome.tabs.create({ url: c.url, windowId: CTX.srcWin, active });
  if (c.group) await putInGroup([tab.id], c.group, CTX.srcWin).catch(() => {});
  return tab;
}
// The group a tab is in, as kept for it to come back to (a snooze, the closed-tabs log): { id, title, color } or null.
const groupFor = (tab) => (tab.groupId >= 0 ? groupOf(state.groups.get(tab.groupId)) : null);

// Reopen a recently closed tab (or window), into the window Tabazing was opened from; Chrome's own
// entries come back with their history.
async function restoreClosed(c) {
  try {
    if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
    if (c.session) await chrome.sessions.restore((c.session.tab || c.session.window).sessionId);
    else await reopenPage(c, { active: true });
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

// ---- merge windows: pull every tab of other windows (`ids`) into this one, after the tabs it has, in their order.
// Pinned tabs stay pinned, and tab groups move as groups (chrome.tabGroups.move: moving tabs one by one to another
// window takes them out of their group). The emptied windows close by themselves; Undo makes them again.
async function mergeWindows(ids) {
  if (!ids.length) return;
  const undo = [];
  for (const id of ids) {
    let tabs = [];
    try { tabs = (await chrome.tabs.query({ windowId: id })).sort((a, b) => a.index - b.index); } catch { continue; }
    if (!tabs.length) continue;
    try {
      const record = undoRecord(tabs); // (before they move: their groups' names and colours)
      // In their order: each run of tabs outside a group in one move, each group as a whole.
      const moved = new Set();
      let run = [];
      const flush = async () => { if (run.length) await chrome.tabs.move(run, { windowId: CTX.srcWin, index: -1 }); run = []; };
      for (const x of tabs) {
        if (!(x.groupId >= 0 && chrome.tabGroups)) { run.push(x.id); continue; }
        await flush();
        if (!moved.has(x.groupId)) { moved.add(x.groupId); await chrome.tabGroups.move(x.groupId, { windowId: CTX.srcWin, index: -1 }); }
      }
      await flush();
      for (const x of tabs) if (x.pinned) await chrome.tabs.update(x.id, { pinned: true }).catch(() => {});
      undo.push(...record);
    } catch (e) { console.warn('[Tabazing] could not merge a window:', e && e.message); }
  }
  if (state.scope !== 'all') state.scope = 'all';
  await reload();
  if (undo.length) pushUndo(undo, 'merge');
  else toast(t('errMerge'));
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
  if (now.getHours() >= 17) out.push({ label: t('snoozeTomorrowEvening'), at: at(1, 18) }); // too late for this evening
  out.push({ label: t('snoozeWeek'), at: at(((8 - now.getDay()) % 7) || 7, 9) }); // next Monday
  return out.map((c) => ({ ...c, label: c.label + ' · ' + whenLabel(c.at) }));
}
// "Fri 09:00", or just "18:00" today.
function whenLabel(ts) {
  const d = new Date(ts), today = new Date();
  const time = d.toLocaleTimeString(uiLang(), { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : d.toLocaleDateString(uiLang(), { weekday: 'short' }) + ' ' + time;
}
// `run(at)`: what snoozing does (a recently closed tab: snoozeClosed); else the tabs close until then.
// `opts`: menu()'s (`at`: at the pointer, as for a drop on Snoozed).
function snoozeMenu(tabs, anchor, run = (at) => snoozeTabs(tabs, at), opts = {}) {
  menu(anchor, [
    ...snoozeChoices().map((c) => ({ label: c.label, err: t('errSnooze'), fn: () => run(c.at) })),
    null,
    { label: t('snoozePick'), fn: () => snoozePicker(tabs, anchor, run) },
  ], opts);
}
// "Pick a time…": a small card with a date and time box, below `anchor`. Only a time still to come is taken.
// Like the other cards it has the focus and Tab until it closes (Esc, a press outside, Cancel), and gives the
// focus back to what had it.
const localInput = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function snoozePicker(tabs, anchor, run = (at) => snoozeTabs(tabs, at)) {
  closePops();
  const back = document.activeElement && document.activeElement !== document.body ? document.activeElement : el.search;
  const pop = h('form', 'pop snoozepop', null, 'snooze-picker');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-labelledby', 'snooze-pick-h');
  const title = h('label', '', t('snoozePickTitle'), 'snooze-picker-label');
  title.id = 'snooze-pick-h';
  title.htmlFor = 'snooze-at';
  const input = h('input', '', null, 'snooze-picker-input');
  input.type = 'datetime-local';
  input.id = 'snooze-at';
  input.required = true;
  const soon = Date.now() + 3600e3;
  input.min = localInput(Date.now());
  input.value = localInput(soon - (soon % 900e3) + 900e3); // an hour or so from now, on a quarter hour
  const err = h('p', 'pfine perr', null, 'snooze-picker-error');
  err.setAttribute('role', 'alert');
  err.hidden = true;
  const row = h('div', 'row', null, 'snooze-picker-buttons');
  const cancel = h('button', 'btn quiet', t('cancel'), 'snooze-picker-cancel');
  cancel.type = 'button';
  const ok = h('button', 'btn primary', t('snoozeDo'), 'snooze-picker-ok');
  ok.type = 'submit';
  row.append(h('span', 'grow', null, 'snooze-picker-spacer'), cancel, ok);
  pop.append(title, input, err, row);
  const outside = (e) => { if (!pop.contains(e.target)) pop.close(); };
  pop.close = (refocus = true) => {
    if (!pop.isConnected) return;
    pop.remove();
    document.removeEventListener('mousedown', outside, true);
    if (refocus) (back.isConnected && back.tabIndex >= 0 ? back : el.search).focus({ preventScroll: true });
  };
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pop.close(); } });
  cancel.addEventListener('click', (e) => { e.stopPropagation(); pop.close(); });
  pop.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pointerAllowed()) return;
    const at = input.value ? new Date(input.value).getTime() : NaN;
    if (!(at > Date.now())) { err.textContent = t('snoozePast'); err.hidden = false; input.focus(); return; }
    pop.close();
    Promise.resolve(run(at)).catch((x) => toast(t('errSnooze'), x));
  });
  el.app.append(pop);
  dropFrom(pop, (anchor && anchor.isConnected ? anchor : el.search).getBoundingClientRect());
  setTimeout(() => { if (pop.isConnected) document.addEventListener('mousedown', outside, true); }, 0);
  input.focus({ preventScroll: true });
}
async function snoozeTabs(tabs, at) {
  const can = tabs.filter((x) => isWorthReopening(urlOf(x)));
  if (!can.length) return toast(t('snoozeCant'));
  const now = Date.now();
  const items = can.map((x, i) => ({ id: `${x.id}-${now}-${i}`, url: urlOf(x), title: x.title || '', at, windowId: x.windowId, pinned: !!x.pinned, t: now, group: groupFor(x) })); // (it wakes in its group)
  state.snoozed = await addSnoozed(items);
  const ids = can.map((x) => x.id);
  const own = CTX.mode === 'overlay' && ids.includes(CTX.srcTab); // closing the tab we sit on closes us: do it last
  await chrome.tabs.remove(ids.filter((id) => !own || id !== CTX.srcTab)).catch(() => {});
  state.picked.clear();
  if (own) return chrome.tabs.remove(CTX.srcTab);
  ids.forEach((id) => forgetTab(id));
  toast(t('snoozedN', { count: items.length, time: whenLabel(at) }), null, { label: t('undo'), fn: () => unsnooze(items) });
}
// Undo a snooze: forget it and reopen the tabs where they were.
async function unsnooze(items) {
  state.snoozed = await removeSnoozed(items.map((x) => x.id)).catch(() => state.snoozed);
  for (const x of items) {
    let tab = null;
    try { tab = await chrome.tabs.create({ url: x.url, windowId: x.windowId, active: false, pinned: x.pinned }); }
    catch { tab = await chrome.tabs.create({ url: x.url, windowId: CTX.srcWin, active: false }).catch(() => null); }
    if (tab && x.group && !x.pinned) await putInGroup([tab.id], x.group, tab.windowId).catch(() => {});
  }
  toast(t('reopenedN', { count: items.length }));
  await reload();
}

// ---- more for a recently closed tab (its menu): reopen it elsewhere, snooze or archive it, take it off the list.
// Reopen in a new window of its own. Chrome's restore can't choose the window: the page opens afresh there.
async function reopenInWindow(c) {
  await chrome.windows.create({ url: c.url, focused: true });
  finish('restore');
}
// Reopen behind Tabazing, which stays: the tab joins the open ones, and the entry leaves the list.
async function reopenBehind(c) {
  await reopenPage(c, { active: false });
  await hideClosed({ [closedKey(c)]: c.ts || Date.now() }).catch(() => {}); // Chrome's own entry would stay
  toast(t('reopenedN', { count: 1 }));
  await reload();
}
// Snooze it: it opens again at `at`, as a snoozed tab does (and shows under Snoozed meanwhile, not here).
async function snoozeClosed(c, at) {
  const now = Date.now();
  const item = { id: `c${hashOf(c.url)}-${now}`, url: c.url, title: c.title || '', at, windowId: CTX.srcWin, pinned: false, t: now, group: c.group || null };
  state.snoozed = await addSnoozed([item]);
  await afterClosedChange();
  toast(t('snoozedN', { count: 1, time: whenLabel(at) }), null, { label: t('undo'), fn: async () => { state.snoozed = await removeSnoozed([item.id]).catch(() => state.snoozed); await afterClosedChange(); } });
}
// Archive it (the "Tabs Archive" bookmarks folder): it is listed there from now on, not here.
async function archiveClosed(c) {
  if (!chrome.bookmarks) return toast(t('ddNoMarks'));
  const added = await addArchived([{ url: c.url, title: c.title || '' }]);
  await afterClosedChange();
  toast(t('archivedN', { count: added.length }), null, { label: t('undo'), fn: async () => { await removeArchived(added.map((x) => x.id)); await afterClosedChange(); } });
}
// Take it off the list (its ⋯, or Del). Undo puts it back.
async function forgetClosed(entry) {
  const c = entry.item;
  const i = state.entries.indexOf(entry);
  const next = [state.entries[i + 1], state.entries[i - 1]].find((e) => e && e !== entry);
  const keys = { [closedKey(c)]: c.ts || Date.now() };
  state.closedHidden = await hideClosed(keys);
  await afterClosedChange(next && next.key);
  toast(t('closedRemoved'), null, { label: t('undo'), fn: async () => { state.closedHidden = await hideClosed(keys, true); await afterClosedChange(); } });
}
// "Recently closed", the archive and Snoozed read again, then drawn.
async function afterClosedChange(keepKey) {
  await Promise.all([loadArchived().catch(() => {}), loadSnoozePreviews()]);
  await loadClosed();
  if (!state.done) refresh(keepKey ? { keepKey } : {});
}
// A group's tabs out of it (they stay open, where they are).
async function ungroup(entry) {
  await chrome.tabs.ungroup(entry.tabs.map((x) => x.id));
  toast(t('groupUngrouped', { name: groupName(entry.group) }));
  await reload();
}

// ---- what can be done to tab groups (a tab's menu, the ticked tabs' More, a tile's menu, the palette)
// The group the tab Tabazing was opened over is in, or null.
const srcGroup = () => { const tab = srcTab(); return tab && tab.groupId >= 0 ? state.groups.get(tab.groupId) || null : null; };
// A group as a tile's entry has it ({ group, tabs }), for what takes one.
const groupEntry = (g) => ({ kind: 'group', key: 'g' + g.id, group: g, tabs: state.tabs.filter((x) => x.groupId === g.id) });
// "Add to group…": the groups of the tabs' window (those they aren't all in already), then "New group…".
function groupMenu(tabs, anchor) {
  if (!tabs.length || !chrome.tabs.group) return;
  const win = tabs[0].windowId;
  const there = [...state.groups.values()].filter((g) => g.windowId === win && !tabs.every((x) => x.groupId === g.id));
  menu(anchor, [
    ...there.map((g) => ({ icon: 'tab', label: groupName(g), err: t('actFailed'), fn: () => addToGroup(tabs.map((x) => x.id), g) })),
    ...(there.length ? [null] : []),
    { icon: 'plus', label: t('groupNew'), fn: () => newGroup(tabs, anchor) },
  ]);
}
// A colour the window's groups don't use yet (Chrome does the same for a new group).
function nextColor(win) {
  const used = new Set([...state.groups.values()].filter((g) => g.windowId === win).map((g) => g.color));
  return GROUP_COLORS.find((c) => c !== 'grey' && !used.has(c)) || 'blue';
}
// "New group…": its name and colour first, then the tabs go into it (into the first one's window).
function newGroup(tabs, anchor) {
  const win = tabs[0].windowId;
  groupEditor(anchor, { title: '', color: nextColor(win), heading: t('groupNewTitle') }, async ({ title, color }) => {
    const id = await chrome.tabs.group({ tabIds: tabs.map((x) => x.id), createProperties: { windowId: win } });
    await chrome.tabGroups.update(id, { title, color });
    state.picked.clear();
    toast(t('groupAddedN', { count: tabs.length, name: title || t('groupUnnamed', { color }) }));
    await reload();
  });
}
// "Name and colour…" on a tile.
function editGroup(g, anchor) {
  groupEditor(anchor, { title: g.title || '', color: groupColor(g), heading: t('groupEditTitle') }, async (v) => {
    await chrome.tabGroups.update(g.id, v);
    await reload();
  });
}
// A small card for a group's name and colour, below `anchor`, like the snooze time picker: a name box and Chrome's
// nine colours, then Save (Enter) or Cancel (Esc). `save({ title, color })` does the rest.
function groupEditor(anchor, { title, color, heading }, save) {
  closePops();
  const back = document.activeElement && document.activeElement !== document.body ? document.activeElement : el.search;
  const pop = h('form', 'pop grouppop', null, 'group-editor');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-labelledby', 'grp-ed-h');
  const label = h('label', '', heading, 'group-editor-title');
  label.id = 'grp-ed-h';
  label.htmlFor = 'grp-ed-name';
  const input = h('input', '', null, 'group-editor-name');
  input.id = 'grp-ed-name';
  input.value = title;
  input.placeholder = t('groupNamePh');
  input.maxLength = 200;
  input.autocomplete = 'off';
  let chosen = GROUP_COLORS.includes(color) ? color : 'blue';
  const colors = h('div', 'gcolors', null, 'group-editor-colors');
  colors.setAttribute('role', 'radiogroup');
  colors.setAttribute('aria-label', t('groupColorLabel'));
  const paint = () => colors.querySelectorAll('.gswatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.gc === chosen)));
  for (const c of GROUP_COLORS) {
    const b = h('button', 'gswatch', null, 'group-editor-color');
    b.type = 'button';
    b.dataset.gc = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', t('groupColorName', { color: c }));
    b.title = t('groupColorName', { color: c });
    b.addEventListener('click', (e) => { e.stopPropagation(); chosen = c; paint(); });
    colors.append(b);
  }
  paint();
  const row = h('div', 'row', null, 'group-editor-buttons');
  const cancel = h('button', 'btn quiet', t('cancel'), 'group-editor-cancel');
  cancel.type = 'button';
  const ok = h('button', 'btn primary', t('groupSave'), 'group-editor-save');
  ok.type = 'submit';
  row.append(h('span', 'grow', null, 'group-editor-spacer'), cancel, ok);
  pop.append(label, input, colors, row);
  const outside = (e) => { if (!pop.contains(e.target)) pop.close(); };
  pop.close = (refocus = true) => {
    if (!pop.isConnected) return;
    pop.remove();
    document.removeEventListener('mousedown', outside, true);
    if (refocus) (back.isConnected && back.tabIndex >= 0 ? back : el.search).focus({ preventScroll: true });
  };
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pop.close(); } });
  cancel.addEventListener('click', (e) => { e.stopPropagation(); pop.close(); });
  pop.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pointerAllowed()) return;
    pop.close();
    Promise.resolve(save({ title: input.value.trim(), color: chosen })).catch((x) => toast(t('actFailed'), x));
  });
  el.app.append(pop);
  dropFrom(pop, (anchor && anchor.isConnected ? anchor : el.search).getBoundingClientRect());
  setTimeout(() => { if (pop.isConnected) document.addEventListener('mousedown', outside, true); }, 0);
  input.focus({ preventScroll: true });
  input.select();
}
// "Remove from group": the tabs stay open, where they are.
async function ungroupTabs(tabs) {
  await chrome.tabs.ungroup(tabs.map((x) => x.id));
  toast(t('groupRemovedN', { count: tabs.length }));
  await reload();
}
// "Move group to new window": the whole group, as a group (Undo puts its tabs back, in it). With the tab Tabazing is
// drawn over among them, Tabazing goes along and closes.
async function groupToWindow(entry) {
  const undo = undoRecord(entry.tabs);
  const own = CTX.mode === 'overlay' && entry.tabs.some((x) => x.id === CTX.srcTab);
  asking = true; // the new window may take the focus for a moment
  try {
    const w = await chrome.windows.create({ focused: own });
    const blank = (w.tabs || [])[0]; // (a window comes with a New Tab)
    await chrome.tabGroups.move(entry.group.id, { windowId: w.id, index: -1 });
    if (blank) await chrome.tabs.remove(blank.id).catch(() => {});
  } finally { asking = false; }
  if (own) return finish('switch');
  window.focus();
  await reload();
  pushUndo(undo, 'move');
}
// Collapse or expand the group in Chrome's tab strip.
async function collapseGroup(g) {
  await chrome.tabGroups.update(g.id, { collapsed: !g.collapsed });
  await reload();
}
// Space or Shift+click on a tile: its tabs' pictures big (up to eight), each with its title. Enter opens the group,
// ← / → the cards beside it, Esc or the × closes it.
function openBigGroup(entry) {
  closePops();
  closeBig();
  hideTip();
  bigEntry = entry;
  const g = entry.group, name = groupName(g);
  const back = h('div', 'bigback', null, 'big-preview');
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  back.setAttribute('aria-label', t('bigTitle', { title: name }));
  const box = h('div', 'bigbox biggroup', null, 'big-preview-box');
  box.dataset.gc = groupColor(g);
  const head = h('div', 'bighead', null, 'big-preview-header');
  head.append(h('span', 'gdot', null, 'big-preview-group-dot'), h('span', 'title', name, 'big-preview-title'), h('span', 'host', t('tabs', { count: entry.tabs.length }), 'big-preview-host'));
  const x = h('button', 'bigx', null, 'big-preview-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = t('bigClose') + ' (Esc)';
  x.setAttribute('aria-label', t('bigClose'));
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeBig(); });
  const grid = h('div', 'biggrid', null, 'big-preview-group');
  grid.style.setProperty('--cols', Math.min(4, entry.tabs.length));
  for (const tab of entry.tabs.slice(0, 8)) {
    const cell = h('figure', 'bigcell', null, 'big-preview-group-tab');
    const p = state.previews[tab.id];
    const pic = h('div', 'bigpic', null, 'big-preview-group-pic');
    if (p && p.img) { const img = h('img', '', null, 'big-preview-image'); img.src = p.img; img.alt = ''; pic.append(img); }
    else { const img = h('img', 'gfav', null, 'big-preview-none-favicon'); img.src = favicon(urlOf(tab)); img.alt = ''; pic.append(img); }
    cell.append(pic, h('figcaption', '', tab.title || siteOf(urlOf(tab)) || t('untitled'), 'big-preview-group-title'));
    grid.append(cell);
  }
  if (entry.tabs.length > 8) grid.append(h('p', 'bigmore', t('groupMoreN', { count: entry.tabs.length - 8 }), 'big-preview-group-more'));
  box.append(head, x, grid);
  box.addEventListener('click', (e) => e.stopPropagation());
  back.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeBig(); });
  back.append(box);
  el.app.append(back);
  updateInert();
  x.focus({ preventScroll: true });
}

// ---- drag to reorder ("By order" only: there the cards are the tab strip, so a drop is a real move).
// ------------------------------------------------------------ drag and drop
// What can be dragged: open tabs (a card, or the ticked cards), a group's tile, a page that isn't open (a recently
// closed tab, a snoozed one, a starred page: its card), or a link from elsewhere (another window, another app).
// Where it goes, and what that does:
//   - a tab's card, By order: before or after it (tabs and groups move there; a page opens there, behind Tabazing);
//   - a group's tile: into the group (tabs join it at its end; a page opens at its end);
//   - the open tabs (anywhere on their list): a page opens there, at the end, behind Tabazing, which stays (in the
//     group view: in that group);
//   - a window in the list on the left: tabs and groups move to it (Undo moves them back); a page opens in it;
//   - Snoozed: the snooze choices open for the tabs (or the closed tab, the starred page);
//   - Recently closed: the tabs close (Undo reopens them).
// While something is dragged, the places that take it are outlined (.drop-ok), the one under the pointer more so.
let drag = null; // { ids } (tabs), { group } (a tile's group id), { page } (a card's entry), or null
const DROP_CLASSES = ['drop-before', 'drop-after', 'drop-into', 'drop-zone'];
const clearDrop = () => document.querySelectorAll(DROP_CLASSES.map((c) => '.' + c).join(', ')).forEach((n) => n.classList.remove(...DROP_CLASSES));
const showDrop = (node, cls) => { if (node.classList.contains(cls)) return; clearDrop(); node.classList.add(cls); };
// A drop on the card's half toward the end goes after it: its right half, or its left half right to left.
const dropAfter = (card, e) => { const r = card.getBoundingClientRect(); return (e.clientX > r.left + r.width / 2) !== isRtl(); };
// What is dragged: ours, or a link from elsewhere (only its kind can be read until it is dropped).
const dragged = (e) => drag || (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('text/uri-list') ? { link: true } : null);
// The address(es) a dropped link carries: web pages only.
const droppedLinks = (e) => String(e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && /^(https?|ftp|file):/i.test(s)).slice(0, 20);
function startDrag(what, card, e, text) {
  drag = what;
  e.dataTransfer.effectAllowed = what.page ? 'copyMove' : 'move';
  e.dataTransfer.setData('text/plain', text);
  card.classList.add('dragging');
  document.querySelectorAll('.dzone').forEach((n) => n.classList.toggle('drop-ok', !!n._takes(what)));
}
function endDrag() {
  drag = null;
  clearDrop();
  document.querySelectorAll('.dragging, .drop-ok').forEach((n) => n.classList.remove('dragging', 'drop-ok'));
}
// A place that takes drops: `takes(what)` says whether it takes this (truthy), `run(what, e)` does the drop.
function dropZone(node, takes, run, cls = 'drop-zone') {
  node.classList.add('dzone');
  node._takes = takes;
  // (dragenter too: Chrome takes a drop only where both were cancelled)
  const over = (e) => {
    const what = dragged(e);
    if (!what || !takes(what) || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = what.ids || what.group !== undefined ? 'move' : 'copy';
    showDrop(node, cls);
  };
  node.addEventListener('dragenter', over);
  node.addEventListener('dragover', over);
  node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove(cls); });
  node.addEventListener('drop', (e) => {
    const what = dragged(e);
    if (!what || !takes(what) || e.defaultPrevented) return;
    e.preventDefault();
    endDrag();
    if (pointerAllowed()) Promise.resolve(run(what, e)).catch((err) => toast(t('errMove'), err));
  });
}
// What a drop on this card does: 'into' (a group's tile), 'before' / 'after' (By order), or null (the list around
// it may take it instead).
function cardDrop(entry, card, e, what) {
  if (!what) return null;
  const tile = entry.kind === 'group', reorder = state.sort === 'order';
  const side = reorder ? (dropAfter(card, e) ? 'after' : 'before') : null;
  if (what.ids) return what.ids.some((id) => cardTabs(entry).some((x) => x.id === id)) ? null : tile ? 'into' : side;
  if (what.group !== undefined) return tile && what.group === entry.group.id ? null : side;
  return tile ? 'into' : side; // a page, a link
}
function dragToMove(card, entry) {
  const tile = entry.kind === 'group';
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    startDrag(tile ? { group: entry.group.id } : { ids: state.picked.has(entry.tab.id) ? [...state.picked] : [entry.tab.id] }, card, e, tile ? groupName(entry.group) : urlOf(entry.tab));
  });
  card.addEventListener('dragend', endDrag);
  const over = (e) => {
    const act = cardDrop(entry, card, e, dragged(e));
    if (!act) return; // (the open tabs around it may take it)
    e.preventDefault();
    e.dataTransfer.dropEffect = drag && (drag.ids || drag.group !== undefined) ? 'move' : 'copy';
    showDrop(card, 'drop-' + act);
  };
  card.addEventListener('dragenter', over); // (both: Chrome takes a drop only where both were cancelled)
  card.addEventListener('dragover', over);
  card.addEventListener('dragleave', (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove(...DROP_CLASSES); });
  card.addEventListener('drop', (e) => {
    const what = dragged(e), act = cardDrop(entry, card, e, what);
    if (!act) return;
    e.preventDefault();
    const links = what.link ? droppedLinks(e) : null;
    endDrag();
    if (!pointerAllowed()) return;
    const after = act === 'after';
    const done = what.ids ? (tile ? addToGroup(what.ids, entry.group) : moveTabs(what.ids, entry.tab, after))
      : what.group !== undefined ? moveGroup(what.group, entry, after)
      : openDropped(what.page || links, tile ? { group: entry.group } : { near: entry.tab, after });
    done.catch((err) => toast(t('errMove'), err));
  });
}
// A page's card (recently closed, snoozed, starred): dragged to be opened somewhere. A closed window isn't (Chrome
// alone brings one back).
function dragToOpen(card, entry) {
  if (entry.kind === 'closed' && entry.item.kind === 'window') return;
  card.draggable = true;
  card.addEventListener('dragstart', (e) => startDrag({ page: entry }, card, e, entry.item.url));
  card.addEventListener('dragend', endDrag);
}
// Open what was dropped (a page's card entry, or links), behind Tabazing, which stays: next to a tab (`near`, `after`),
// at the end of a group, or at the end of a window (`windowId`, else the one Tabazing was opened from). A recently
// closed tab then leaves that list, a snoozed one its snooze.
async function openDropped(what, { near = null, after = true, group = null, windowId = null } = {}) {
  const urls = Array.isArray(what) ? what : [what.item.url];
  if (!urls.length) return;
  let win = windowId || CTX.srcWin, index;
  if (group) {
    const members = (await chrome.tabs.query({ groupId: group.id })).sort((a, b) => a.index - b.index);
    const last = members[members.length - 1];
    if (last) { win = last.windowId; index = last.index + 1; } else group = null; // (the group is gone)
  } else if (near) {
    const at = await chrome.tabs.get(near.id);
    win = at.windowId;
    index = at.index + (after ? 1 : 0);
  }
  const made = [];
  for (const url of urls) {
    const tab = await chrome.tabs.create({ url, windowId: win, active: false, ...(index !== undefined ? { index: index++ } : {}) });
    made.push(tab.id);
  }
  if (group && chrome.tabs.group) await chrome.tabs.group({ tabIds: made, groupId: group.id });
  if (!Array.isArray(what)) {
    if (what.kind === 'closed') await hideClosed({ [closedKey(what.item)]: what.item.ts || Date.now() }).catch(() => {}); // Chrome's own entry would stay
    if (what.kind === 'snoozed') state.snoozed = await removeSnoozed([what.item.id]).catch(() => state.snoozed);
  }
  const back = !Array.isArray(what) && (what.kind === 'closed' || what.kind === 'snoozed');
  toast(group ? t('groupAddedN', { count: made.length, name: groupName(group) }) : t(back ? 'reopenedN' : 'openedN', { count: made.length }));
  if (!Array.isArray(what) && what.kind === 'closed') await loadClosed();
  await reload();
}
// Tabs (or a group) dropped on a window in the list on the left: to the end of that window. Undo moves them back. The
// tab Tabazing is drawn over, among them: it goes along, to that window, and Tabazing closes.
async function moveToWin(what, winId) {
  const tabs = what.group !== undefined ? state.tabs.filter((x) => x.groupId === what.group) : state.tabs.filter((x) => what.ids.includes(x.id));
  const moving = tabs.filter((x) => x.windowId !== winId).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  if (!moving.length) return;
  const undo = undoRecord(moving);
  const own = CTX.mode === 'overlay' && moving.some((x) => x.id === CTX.srcTab);
  if (what.group !== undefined) await chrome.tabGroups.move(what.group, { windowId: winId, index: -1 });
  else {
    await chrome.tabs.move(moving.map((x) => x.id), { windowId: winId, index: -1 });
    await regroup(undo.map((x) => ({ x, tab: { id: x.id } }))); // their groups go along (one of each, there)
  }
  state.picked.clear();
  if (own) { await chrome.tabs.update(CTX.srcTab, { active: true }).catch(() => {}); await chrome.windows.update(winId, { focused: true }).catch(() => {}); return finish('switch'); }
  await reload();
  const w = state.windows.find((x) => x.id === winId);
  pushUndo(undo, 'move', t('movedToN', { count: undo.length, window: w ? w.label : '' }));
}
// The lists that take drops (set up once: they stay as the cards change).
function setupDropZones() {
  const openSection = el.openGrid.closest('section');
  dropZone(openSection, (w) => w.page || w.link, (w, e) => {
    const g = state.inGroup !== null ? state.groups.get(state.inGroup) : null;
    return openDropped(w.page || droppedLinks(e), g ? { group: { id: g.id, title: g.title } } : { windowId: typeof state.scope === 'number' ? state.scope : CTX.srcWin });
  });
  // (the snooze choices at the pointer; "Pick a time…" below the section's title)
  dropZone(el.snoozedSection, (w) => w.ids || (w.page && w.page.kind !== 'snoozed'), (w, e) => {
    const anchor = $('snoozed-h'), at = { at: { x: e.clientX, y: e.clientY } };
    if (w.ids) return snoozeMenu(state.tabs.filter((x) => w.ids.includes(x.id)), anchor, undefined, at);
    const c = w.page.item;
    return snoozeMenu([], anchor, (when) => snoozeClosed(c, when), at);
  });
  dropZone(el.closedSection, (w) => w.ids || w.group !== undefined, (w) => closeMany(w.group !== undefined ? state.tabs.filter((x) => x.groupId === w.group) : state.tabs.filter((x) => w.ids.includes(x.id))));
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
// Move a whole group to just before or after `target` (a tab's card, or another group's tile), as one block.
async function moveGroup(id, target, after) {
  const strip = (gid) => chrome.tabs.query({ groupId: gid }).then((list) => list.sort((a, b) => a.index - b.index));
  const mine = await strip(id);
  if (!mine.length) return;
  let win, index;
  if (target.kind === 'group') {
    const theirs = await strip(target.group.id);
    win = theirs[0].windowId;
    index = after ? theirs[theirs.length - 1].index + 1 : theirs[0].index;
  } else {
    const at = await chrome.tabs.get(target.tab.id);
    win = at.windowId;
    index = at.index + (after ? 1 : 0);
  }
  if (mine[0].windowId === win && mine[0].index < index) index -= mine.length; // it leaves its old place first
  await chrome.tabGroups.move(id, { windowId: win, index });
  await reload();
}
// Tabs into a group (dropped on its tile, or "Add to group"), appended: each goes after the group's last tab (into its
// window, in the tab strip's order), then joins it. A pinned tab is unpinned first (a group holds none).
async function addToGroup(ids, g) {
  const tabs = state.tabs.filter((x) => ids.includes(x.id) && x.groupId !== g.id).sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  if (!tabs.length) return;
  for (const x of tabs) {
    if (x.pinned) await chrome.tabs.update(x.id, { pinned: false });
    const members = (await chrome.tabs.query({ groupId: g.id })).sort((a, b) => a.index - b.index);
    const last = members[members.length - 1];
    if (last) {
      const cur = await chrome.tabs.get(x.id);
      let index = last.index + 1;
      if (cur.windowId === last.windowId && cur.index < index) index--; // it leaves its old place first
      await chrome.tabs.move(x.id, { windowId: last.windowId, index });
    }
    await chrome.tabs.group({ tabIds: [x.id], groupId: g.id });
  }
  state.picked.clear();
  toast(t('groupAddedN', { count: tabs.length, name: groupName(g) }));
  await reload();
}

// Unloading a tab makes Chrome swap it out for a moment, which would jolt the switcher. So a tab put to
// sleep here is only marked (a moon on its card); it is unloaded as Tabazing closes. Clicking again unmarks.
async function sleepTabs(tabs) {
  const can = tabs.filter((x) => !x.active && !x.discarded); // Chrome won't unload the tab you're looking at
  if (!can.length) return toast(t('sleptNone'));
  const undo = can.every((x) => state.toSleep.has(x.id));
  can.forEach((x) => (undo ? state.toSleep.delete(x.id) : state.toSleep.add(x.id)));
  const changed = new Set([...state.picked, ...can.map((x) => x.id)]);
  state.picked.clear();
  toast(undo ? t('sleepUndone') : t('sleepLaterN', { count: can.length }));
  if (state.filter) refresh(); // (the Asleep filter may show or hide them now)
  else redraw((e) => e.kind === 'tab' && changed.has(e.tab.id));
}

async function pinTabs(tabs) {
  const pin = !tabs.every((x) => x.pinned);
  for (const x of tabs) await chrome.tabs.update(x.id, { pinned: pin }).catch(() => {});
  toast(t(pin ? 'pinnedN' : 'unpinnedN', { count: tabs.length }));
  await reload();
}

async function muteTabs(tabs) {
  const mute = !tabs.every((x) => x.mutedInfo && x.mutedInfo.muted);
  for (const x of tabs) await chrome.tabs.update(x.id, { muted: mute }).catch(() => {});
  toast(t(mute ? 'mutedN' : 'unmutedN', { count: tabs.length }));
  await reload();
}

// Pages open more than once (same address, ignoring the #part and a trailing slash).
function dupeUrls() {
  const n = new Map();
  for (const x of state.tabs) { const k = normalizeUrl(urlOf(x)); if (k && /^https?:|^file:/.test(urlOf(x))) n.set(k, (n.get(k) || 0) + 1); }
  return new Set([...n].filter(([, c]) => c > 1).map(([k]) => k));
}
// The same page open more than once: keep one (pinned first, then the most recently used), close the rest.
// Worked out once per list of tabs (a redraw asks for every card in the duplicates view); derive() starts afresh.
let dupeMemo = null; // { tabs, list, ids }
function duplicates() {
  if (dupeMemo && dupeMemo.tabs === state.tabs) return dupeMemo.list;
  const seen = new Map();
  const dupes = [];
  // The one kept: pinned first, then one in a tab group, then the most recently used (state.tabs is most recent first).
  const order = [...state.tabs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.groupId >= 0 ? 1 : 0) - (a.groupId >= 0 ? 1 : 0));
  for (const x of order) {
    const k = normalizeUrl(urlOf(x));
    if (!k || !/^https?:|^file:/.test(urlOf(x))) continue;
    if (seen.has(k)) dupes.push(x); else seen.set(k, x);
  }
  dupeMemo = { tabs: state.tabs, list: dupes, ids: new Set(dupes.map((x) => x.id)) };
  return dupes;
}
const dupeIds = () => (duplicates(), dupeMemo.ids); // the ids of the copies that close
async function closeDupes() {
  if (!state.dupesView) return dupesView(true); // first show which tabs are copies
  const d = duplicates();
  if (!d.length) return;
  state.dupesView = false;
  await closeMany(d);
}

// ---- sound: a speaker in the header of a tab that is playing (a crossed-out one when muted), and a
// mute button among every card's quick buttons. Both mute or unmute just that tab.
const isMuted = (tab) => !!(tab.mutedInfo && tab.mutedInfo.muted);
function audioBadge(tab) {
  const muted = isMuted(tab);
  const b = h('button', 'badge audio' + (muted ? '' : ' on'), null, 'card-audio');
  b.type = 'button';
  b.append(svgOf(muted ? ICON.muted : ICON.speaker));
  b.title = t(muted ? 'tabUnmute' : 'tabMute');
  b.setAttribute('aria-label', b.title);
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) toggleMute(tab).catch((err) => toast(t('errMute'), err)); });
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
    catch (e2) { await reload(); return toast(t('errPin'), e2); }
  }
  await reload(); // what Chrome now has, whatever happened
  const now = state.tabs.find((x) => x.id === tab.id);
  toast(t(now && now.pinned ? 'pinnedOne' : 'unpinnedOne', { title: tab.title || siteOf(urlOf(tab)) }));
}
async function toggleMute(tab) {
  const muted = !isMuted(tab);
  await chrome.tabs.update(tab.id, { muted });
  tab.mutedInfo = { ...(tab.mutedInfo || {}), muted }; // show it right away
  if (state.filter) refresh({ keepKey: 't' + tab.id }); // (the Audio filter may hide it now)
  else redraw((e) => e.kind === 'tab' && e.tab.id === tab.id, { keepKey: 't' + tab.id });
}

// Reload a tab (a sleeping one wakes up). The page Tabazing is drawn over (overlay) reloads with it gone.
async function reloadTab(tab) {
  await chrome.tabs.reload(tab.id);
  if (CTX.mode === 'overlay' && tab.id === CTX.srcTab) return finish('cancel');
  toast(t('reloadingOne', { title: tab.title || siteOf(urlOf(tab)) }));
}
// Duplicate a tab: the copy opens right after it, in the background, so Tabazing stays open and shows it.
async function duplicateTab(tab) {
  await chrome.tabs.create({ url: urlOf(tab), windowId: tab.windowId, index: tab.index + 1, active: false, pinned: !!tab.pinned, openerTabId: tab.id });
  await reload();
  toast(t('duplicatedOne', { title: tab.title || siteOf(urlOf(tab)) }));
}

// ---- the media player, right of the search box: what plays in the tabs (its picture, title and buttons), and
// the chevron's list of everything playable in every tab. The pages say what they play (media-hook.js), the
// background keeps it (KEY.MEDIA), and every change of it is read again here (listen(): refreshMedia). The
// buttons act in the page itself (utils/media.js) and show the change at once; the page's report confirms it.
const currentMedia = () => state.media.find((m) => m.tabId === state.mediaCurrent) || state.media[0] || null;
const mediaPreview = (m) => state.previews[m.tabId] || state.mediaPreviews[normalizeUrl(urlOf(m.tab))] || null;
// The picture (the tab's screenshot, else its icon), made once per tab and capture and reused by every redraw.
const mediaPics = new Map();
function mediaPic(m, testid) {
  const p = mediaPreview(m);
  const k = testid + '|' + m.tabId + '|' + (p && p.img ? (p.t || 0) + ':' + p.img.length : urlOf(m.tab));
  let pic = mediaPics.get(k);
  if (!pic) {
    if (p && p.img) { pic = h('img', 'mshot', null, testid + '-preview'); pic.decoding = 'async'; pic.src = p.img; }
    else { pic = h('img', 'mfav', null, testid + '-favicon'); pic.src = favicon(urlOf(m.tab)); }
    pic.alt = '';
    if (mediaPics.size > 100) mediaPics.clear();
    mediaPics.set(k, pic);
  }
  return pic;
}
// Previews of media tabs the cards don't show (other windows): read once each.
async function loadMediaPreviews() {
  const want = state.media.filter((m) => !state.previews[m.tabId] && !state.pvPending.has(m.tabId) && !(normalizeUrl(urlOf(m.tab)) in state.mediaPreviews));
  if (!want.length) return;
  const got = await getPreviews(want.map((m) => urlOf(m.tab))).catch(() => ({}));
  for (const m of want) { const k = normalizeUrl(urlOf(m.tab)); state.mediaPreviews[k] = got[k] || null; }
}
function paintToggle(b, playing) {
  b.replaceChildren(svgOf(playing ? ICON.pause : ICON.play));
  b.title = t(playing ? 'mediaPause' : 'mediaPlay'); // the label says what a press does
  b.setAttribute('aria-label', b.title);
}
// Drawn with every render(), so only a change touches the page.
let playerSig = '';
function renderPlayer() {
  const m = currentMedia();
  if (!m) {
    if (el.player.contains(document.activeElement)) el.search.focus({ preventScroll: true });
    el.player.hidden = true;
    playerSig = '';
    return;
  }
  el.player.hidden = false;
  const p = mediaPreview(m);
  const sig = [m.tabId, m.frameId, m.title, m.artist, m.site, m.playing, m.canPrev, m.canNext, p ? p.t : 0, uiLang()].join('\n');
  if (sig === playerSig) return;
  playerSig = sig;
  if (!el.playerPrev.firstChild) { el.playerPrev.append(svgOf(ICON.prev)); el.playerNext.append(svgOf(ICON.next)); el.playerMore.append(svgOf(ICON.chevron)); }
  el.playerPic.replaceChildren(mediaPic(m, 'player'));
  el.playerTitle.textContent = m.title || m.site || t('untitled');
  el.playerSub.textContent = m.artist || m.site;
  el.playerTitle.parentElement.title = m.title;
  el.playerPrev.disabled = !m.canPrev;
  el.playerNext.disabled = !m.canNext;
  paintToggle(el.playerToggle, m.playing);
}
const renderMedia = () => { renderPlayer(); renderMediaList(); };

// Read what plays again (a page reported a change). Changes during a read are read once more after it.
let mediaLoading = null, mediaAgain = false;
function refreshMedia() {
  if (mediaLoading) { mediaAgain = true; return mediaLoading; }
  mediaLoading = (async () => {
    do {
      mediaAgain = false;
      const list = await loadMedia().catch(() => null);
      if (state.done) return;
      if (list) state.media = list;
      await loadMediaPreviews();
      if (!state.done) renderMedia();
    } while (mediaAgain && !state.done);
  })().finally(() => { mediaLoading = null; });
  return mediaLoading;
}

// A button: play / pause ('toggle'), previous or next. The player and the list show the new state at once;
// if the page doesn't act, they go back and a note says so.
async function mediaDo(m, action) {
  if (action === 'toggle') action = m.playing ? 'pause' : 'play';
  const was = m.playing;
  if (action === 'play' || action === 'pause') { m.playing = action === 'play'; renderMedia(); }
  let ok = false, err = null;
  try { ok = await mediaAction(m.tabId, m.frameId, action); } catch (e) { err = e; }
  if (ok || state.done) return;
  m.playing = was;
  renderMedia();
  toast(t('mediaFailed'), err);
}
// The player's own buttons act on what it shows, and keep showing it (the list puts what plays first,
// which would otherwise swap it for another tab's media the moment it is paused).
function playerDo(action) {
  const m = currentMedia();
  if (!m) return;
  state.mediaCurrent = m.tabId;
  mediaDo(m, action);
}
function pickMedia(m) {
  state.mediaCurrent = m.tabId;
  renderMedia();
}
async function goToMedia(m) {
  if (state.done) return;
  try { await switchToTab(m.tab); } catch (e) { console.warn('[Tabazing] could not open the tab:', e && e.message); finish('cancel'); }
}

// The chevron's list: like Settings, a card that takes the focus, keeps Tab inside, and closes with Esc,
// a press outside or the chevron again, giving the focus back to the chevron.
let mediaOrder = []; // tab ids in the order the open list shows them: rows don't jump while you use them
function openMediaList() {
  const open = document.querySelector('.pop.mediapop');
  closePops();
  if (open || !state.media.length) return;
  const anchor = el.playerMore;
  const pop = h('div', 'pop mediapop', null, 'media-list');
  pop.id = 'media-list';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true'); // Tab stays in it (keepFocusIn) until it closes
  pop.setAttribute('aria-label', t('mediaList'));
  const rows = h('div', 'mlist', null, 'media-rows');
  pop.append(h('h4', '', t('mediaList'), 'media-list-title'), rows);
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pop.close(); } });
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) pop.close(); };
  pop.close = () => {
    if (!pop.isConnected) return;
    pop.remove();
    mediaOrder = [];
    document.removeEventListener('mousedown', outside, true);
    anchor.setAttribute('aria-expanded', 'false');
    anchor.removeAttribute('aria-controls');
    (el.player.hidden ? el.search : anchor).focus({ preventScroll: true });
  };
  el.app.append(pop);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', pop.id);
  renderMediaList();
  dropFrom(pop, anchor.getBoundingClientRect()); // drops down from the player
  setTimeout(() => { if (pop.isConnected) document.addEventListener('mousedown', outside, true); }, 0);
  const cur = pop.querySelector('.mrow.on [data-testid="media-row-toggle"]') || tabbables(pop)[0];
  if (cur) cur.focus({ preventScroll: true });
}
function renderMediaList() {
  const pop = document.querySelector('.pop.mediapop');
  if (!pop) return;
  if (!state.media.length) return pop.close();
  const rank = new Map(mediaOrder.map((id, i) => [id, i]));
  const at = (m) => (rank.has(m.tabId) ? rank.get(m.tabId) : rank.size); // new ones go last, in their own order
  const list = [...state.media].sort((a, b) => at(a) - at(b));
  mediaOrder = list.map((m) => m.tabId);
  // The rows are built again: the focus goes back to the same button of the same row.
  const f = document.activeElement;
  const row0 = f && pop.contains(f) ? f.closest('.mrow') : null;
  const back = row0 ? { tab: row0.dataset.tab, id: f.dataset.testid } : null;
  const rows = pop.querySelector('.mlist');
  const current = currentMedia();
  rows.replaceChildren(...list.map((m) => mediaRow(m, m === current)));
  if (!back) return;
  const row = [...rows.children].find((x) => x.dataset.tab === back.tab);
  const n = row && row.querySelector(`[data-testid="${back.id}"]`);
  (n && !n.disabled ? n : row ? row.querySelector('[data-testid="media-row-toggle"]') : tabbables(pop)[0] || pop).focus({ preventScroll: true });
}
// One row: picture, title, site and whether it plays, then its own previous / play-pause / next, and "Go to tab".
// Only those buttons take the focus: the row itself isn't a control and has no look of its own when it is the
// one the player shows (aria-current says so); a press on it shows it there.
function mediaRow(m, current) {
  const row = h('div', 'mrow' + (current ? ' on' : ''), null, 'media-row');
  row.dataset.tab = String(m.tabId);
  if (current) row.setAttribute('aria-current', 'true');
  const pick = h('span', 'mpick', null, 'media-row-pick');
  const pic = h('span', 'mpic', null, 'media-row-pic');
  pic.append(mediaPic(m, 'media-row'));
  const text = h('span', 'mtext', null, 'media-row-text');
  text.append(h('span', 'mtitle', m.title || m.site || t('untitled'), 'media-row-title'), h('span', 'msite', m.site, 'media-row-site'));
  const eq = h('span', 'meq' + (m.playing ? ' on' : ''), null, 'media-row-eq');
  eq.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) eq.append(h('i', '', null, 'media-row-eq-bar'));
  pick.append(pic, text, eq, h('span', 'sr-only', t(m.playing ? 'mediaPlaying' : 'mediaPaused'), 'media-row-state'));
  pick.title = m.title;
  const go = h('button', 'pbtn', null, 'media-row-goto');
  go.type = 'button';
  go.title = t('mediaGoTo');
  go.setAttribute('aria-label', go.title);
  go.append(svgOf(ICON.goto));
  go.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) goToMedia(m); });
  row.append(pick, mediaButton('media-row-prev', m, 'previoustrack'), mediaButton('media-row-toggle', m, 'toggle'), mediaButton('media-row-next', m, 'nexttrack'), go);
  // A press on the row (anywhere but its buttons): show it in the player. A second one soon after
  // (a double click) plays or pauses it. Counted by tab, not by element: the first press redraws the list,
  // so the second lands on a new row.
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pointerAllowed()) return;
    const now = performance.now();
    const again = lastRowPress.tabId === m.tabId && now - lastRowPress.at < DOUBLE_PRESS_MS;
    lastRowPress = again ? { tabId: null, at: 0 } : { tabId: m.tabId, at: now };
    if (again) mediaDo(m, 'toggle'); else pickMedia(m);
  });
  return row;
}
const DOUBLE_PRESS_MS = 400;
let lastRowPress = { tabId: null, at: 0 };
function mediaButton(testid, m, action) {
  const b = h('button', 'pbtn' + (action === 'toggle' ? ' main' : ''), null, testid);
  b.type = 'button';
  if (action === 'toggle') paintToggle(b, m.playing);
  else {
    const prev = action === 'previoustrack';
    b.title = t(prev ? 'mediaPrev' : 'mediaNext');
    b.setAttribute('aria-label', b.title);
    b.append(svgOf(prev ? ICON.prev : ICON.next));
    b.disabled = !(prev ? m.canPrev : m.canNext); // the page offers no previous / next
  }
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) mediaDo(m, action); });
  return b;
}

// ---- the archive: tabs moved into the "Tabs Archive" bookmarks folder (in "Other bookmarks", utils/archive.js).
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
  toast(t('archivedN', { count: added.length }), null, { label: t('undo'), fn: () => unarchive(added, undo) });
}
// Undo an archive: out of the folder, and the tabs back where they were.
async function unarchive(added, group) {
  await removeArchived(added.map((x) => x.id));
  await reopenAt(group);
  toast(t('reopenedN', { count: group.length }));
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
const ARCH = '.arch.archv'; // the archive dialog (the history's and the bookmarks' share its look, .arch)
const archiveOpen = () => !!document.querySelector(ARCH);
async function openArchive(sel = 0) {
  closeDrawer(false);
  closePops();
  closeBig();
  hideTip();
  state.dd.hidden = true;
  renderDropdown();
  await loadArchived();
  if (state.done) return;
  let back = document.querySelector(ARCH);
  if (!back) {
    back = viewDialog('archv', 'archive-overlay', 'arch-h', closeArchive).back;
    el.app.append(back);
  }
  const panel = back.firstChild;
  const head = h('div', 'archhead', null, 'archive-header');
  const title = h('h2', 'archtitle', t('archiveTitle'), 'archive-title');
  title.id = 'arch-h';
  title.append(h('span', 'n', String(state.archived.length), 'archive-count'));
  const x = h('button', 'archx', null, 'archive-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = t('archiveClose') + ' (Esc)';
  x.setAttribute('aria-label', t('archiveClose'));
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeArchive(); });
  head.append(title, h('span', 'archsub', t('archiveWhere'), 'archive-location'), x);
  const body = h('div', 'archbody', null, 'archive-body');
  if (!chrome.bookmarks) body.append(h('p', 'empty', t('ddNoMarks'), 'archive-no-bookmarks'));
  else if (!state.archived.length) body.append(h('p', 'empty', t('archiveEmpty'), 'archive-empty'));
  else {
    const grid = h('div', 'histlist', null, 'archive-grid');
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-labelledby', 'arch-h');
    grid.append(...state.archived.map((item, i) => archiveCard(item, i)));
    body.append(grid);
  }
  panel.replaceChildren(head, body);
  updateInert();
  archSelect(sel);
  x.focus({ preventScroll: true });
}
// An archived page as a row: its preview (or its icon), its title, its site and when it was archived, and its button
// that takes it out of the archive. A click (Enter) opens it, and takes it out; a middle-click (Ctrl+Enter) the same,
// behind Tabazing, which stays.
function archiveCard(item, i) {
  const entry = { kind: 'archived', item, url: item.url, preview: state.archivePreviews[normalizeUrl(item.url)] || null };
  const title = item.title || hostOf(item.url) || t('untitled');
  const row = h('div', 'bmvrow mark', null, 'card-archived');
  row.id = 'arch-' + item.id;
  row.setAttribute('role', 'option');
  row.title = t('archiveOpenTip', { title }) + '\n' + item.url;
  const pic = h('div', 'bmvpic' + (entry.preview ? '' : ' bare'), null, entry.preview ? 'card-thumb' : 'card-no-preview');
  const img = h('img', entry.preview ? 'shot' : 'fav', null, entry.preview ? 'card-preview' : 'card-tile-favicon');
  img.src = entry.preview ? entry.preview.img : favicon(item.url);
  img.alt = '';
  pic.append(img);
  const text = h('div', 'bmvtext', null, 'card-text');
  const sub = h('span', 'bmvsub', siteOf(item.url) || item.url, 'card-archived-site');
  const ago = timeAgo(item.t / 1000);
  if (ago) sub.append(' · ', h('span', '', ago, 'card-archived-ago'));
  text.append(h('span', 'bmvtitle', title, 'card-title'), sub);
  const acts = h('div', 'bmvacts', null, 'card-quick-actions');
  const x = deleteButton(t('archiveRemove'), 'card-unarchive', () => dropArchived(item, i).catch((err) => toast(t('errUnarchive'), err)));
  x.classList.add('qbtn');
  acts.append(x);
  row.append(...(state.cardSize === 'list' ? [] : [pic]), text, acts); // (Settings -> Card size: List, no pictures)
  mouseOnly(row); // its button is Del
  row.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) openArchived(item); });
  onMiddleClick(row, () => archivedBehind(item, i).catch((err) => toast(t('actFailed'), err)));
  return row;
}
// Open an archived page in a new tab behind Tabazing, which stays (a middle-click, Ctrl+Enter): it leaves the archive,
// as when it is opened. Undo puts it back there and closes that tab.
async function archivedBehind(item, i) {
  const tab = await chrome.tabs.create({ url: item.url, windowId: CTX.srcWin, active: false });
  await removeArchived([item.id]);
  if (archiveOpen()) await openArchive(i);
  toast(t('openedN', { count: 1 }), null, { label: t('undo'), fn: async () => {
    await addArchived([item]);
    await chrome.tabs.remove(tab.id).catch(() => {});
    if (archiveOpen()) await openArchive(i);
    await reload();
  } });
  await reload();
}
// Take a page out of the archive without opening it (the × on its card, or Del). Undo puts it back.
async function dropArchived(item, i) {
  await removeArchived([item.id]);
  await openArchive(i);
  toast(t('archiveRemoved'), null, { label: t('undo'), fn: async () => { await addArchived([item]); if (archiveOpen()) await openArchive(i); } });
}
function archSelect(i, scroll = true) {
  const cards = [...document.querySelectorAll(ARCH + ' [role=option]')];
  if (!cards.length) return;
  state.archSel = Math.max(0, Math.min(cards.length - 1, i));
  cards.forEach((c, k) => c.setAttribute('aria-selected', String(k === state.archSel)));
  cards[state.archSel].closest('[role=listbox]').setAttribute('aria-activedescendant', cards[state.archSel].id);
  if (scroll) cards[state.archSel].scrollIntoView({ block: 'nearest' });
}
function closeArchive() {
  document.querySelectorAll(ARCH).forEach((n) => n.remove());
  updateInert();
  viewBack(el.archiveBtn).focus({ preventScroll: true }); // back to what opened it
}
// While the archive is open it has the keyboard.
function archiveKey(e) {
  const k = e.key;
  if (MODIFIERS.has(k)) return;
  e.preventDefault();
  e.stopPropagation();
  if (k === 'Escape') return closeArchive();
  // Ctrl+Z (⌘Z): the Undo of the note at the bottom ("Removed from the archive · Undo").
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyZ') { if (!e.repeat) toastUndo(); return; }
  const cards = [...document.querySelectorAll(ARCH + ' [role=option]')];
  if (!cards.length) return;
  if (k === 'Delete' || (IS_MAC && e.metaKey && k === 'Backspace')) {
    if (e.repeat) return;
    if (!keysAllowed()) return finish('cancel');
    return dropArchived(state.archived[state.archSel], state.archSel).catch((err) => toast(t('errUnarchive'), err));
  }
  if (k === 'Enter') {
    if (!keysAllowed()) return finish('cancel');
    if (e.ctrlKey || e.metaKey) { if (!e.repeat) archivedBehind(state.archived[state.archSel], state.archSel).catch((err) => toast(t('actFailed'), err)); return; } // behind, Tabazing stays
    return openArchived(state.archived[state.archSel]);
  }
  if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(k)) return archSelect(state.archSel + (k === 'ArrowDown' ? 1 : k === 'ArrowUp' ? -1 : ahead(k))); // a list: one row at a time
  if (k === 'Home' || k === 'End') return archSelect(k === 'Home' ? 0 : cards.length - 1);
}

// ---- the menu (☰, top left): a drawer from the left, over the dimmed switcher, with History, Bookmarks, Archive and
// Settings. A press on one closes it and opens that dialog; Esc, × or a press beside it close it (back to ☰). ↑ ↓ move
// between its buttons. A dialog opened from it gives the focus back to ☰ when it closes.
const drawerOpen = () => !el.drawerBack.hidden;
function openDrawer() {
  if (drawerOpen()) return closeDrawer();
  closePops();
  hideTip();
  state.dd.hidden = true;
  renderDropdown();
  el.drawerBack.hidden = false;
  el.menuBtn.setAttribute('aria-expanded', 'true');
  updateInert();
  $('history-btn').focus({ preventScroll: true });
}
function closeDrawer(refocus = true) {
  if (!drawerOpen()) return;
  el.drawerBack.hidden = true;
  el.menuBtn.setAttribute('aria-expanded', 'false');
  updateInert();
  if (refocus) el.menuBtn.focus({ preventScroll: true });
}
// Where the focus goes back to when a dialog closes: the button that opened it while it can have the focus (shown),
// else ☰ (the button was in the menu, closed since).
const viewBack = (b) => (b && b.isConnected && b.getClientRects().length && !b.closest('[hidden]') ? b : el.menuBtn);
function drawerKey(e) {
  const k = e.key;
  if (MODIFIERS.has(k)) return;
  const items = [...el.drawerBack.querySelectorAll('button.draweritem')];
  const i = items.indexOf(document.activeElement);
  if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeDrawer(); }
  if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); return items[(i + (k === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
  if (k === 'Home' || k === 'End') { e.preventDefault(); return items[k === 'Home' ? 0 : items.length - 1].focus(); }
  if (k === 'Enter' || k === ' ' || k === 'Tab') return; // its buttons' own
  e.preventDefault(); // (nothing else reaches the switcher behind it)
}
// The History, Bookmarks and Archive dialogs, as Settings: a dimmed backdrop (a press on it closes the dialog) and a
// panel with a title bar. Returns { back, panel }.
function viewDialog(cls, testid, labelledby, close) {
  const back = h('div', 'arch ' + cls, null, testid);
  back.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === back && pointerAllowed()) close(); }); // (never closes the switcher)
  const panel = h('div', 'archpanel', null, testid.replace('-overlay', '-panel'));
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', labelledby);
  back.append(panel);
  return { back, panel };
}

// ---- Backup & Restore (in the menu): everything Tabazing keeps, downloaded as one zip (utils/backup.js), and back
// from the backup folder (or the zip). A restore only adds: what is here stays, nothing is made twice; the backup's
// notes go on the same pages and bookmarks. A dialog like Settings; after a restore it says what it did, per kind.
const backupOpen = () => !!document.querySelector('.backv');
// What a restore did, per kind, in that order (`label`: the kind's name).
const BACKUP_KINDS = [
  { key: 'bookmarks', label: 'backupKindBookmarks' }, { key: 'folders', label: 'backupKindFolders' }, { key: 'archive', label: 'backupKindArchive' },
  { key: 'notes', label: 'backupKindNotes' }, { key: 'bmNotes', label: 'backupKindBmNotes' }, { key: 'stars', label: 'backupKindStars' }, { key: 'snoozed', label: 'backupKindSnoozed' },
];
function openBackup() {
  closePops();
  closeDrawer(false);
  hideTip();
  document.querySelectorAll('.backv').forEach((n) => n.remove());
  const { back, panel } = viewDialog('backv', 'backup-overlay', 'bk-h', closeBackup);
  const head = h('div', 'archhead', null, 'backup-header');
  const title = h('h2', 'archtitle', t('backupTitle'), 'backup-title');
  title.id = 'bk-h';
  const x = h('button', 'archx', null, 'backup-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = t('backupClose') + ' (Esc)';
  x.setAttribute('aria-label', t('backupClose'));
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeBackup(); });
  head.append(title, h('span', 'archsub', t('backupSub'), 'backup-sub'), x);
  const body = h('div', 'archbody backbody', null, 'backup-body');
  // back up
  const name = backupName();
  const out = h('section', 'backsec', null, 'backup-export');
  const outBtn = button('backup-export-btn', t('backupExport'), 'primary', () => exportBackup(outBtn).catch((err) => toast(t('backupExportErr'), err)));
  out.append(h('h3', '', t('backupExportH'), 'backup-export-title'), para(t('backupExportText', { name: name + '.zip' })), outBtn);
  // restore
  const inn = h('section', 'backsec', null, 'backup-import');
  const folder = h('input', 'fs-native', null, 'backup-folder-input');
  folder.type = 'file';
  folder.webkitdirectory = true;
  folder.multiple = true;
  folder.tabIndex = -1;
  const zip = h('input', 'fs-native', null, 'backup-zip-input');
  zip.type = 'file';
  zip.accept = '.zip,application/zip';
  zip.tabIndex = -1;
  // The system's file dialog takes the focus: that is not the user leaving Tabazing (asking), until it closes.
  const choose = (input) => { asking = true; input.value = ''; input.click(); };
  for (const input of [folder, zip]) {
    input.addEventListener('cancel', () => { asking = false; window.focus(); });
    input.addEventListener('change', () => { asking = false; window.focus(); importBackup(input).catch(() => {}); });
  }
  const setLabel = h('label', 'check', null, 'backup-settings-label');
  const setBox = h('input', '', null, 'backup-settings');
  setBox.type = 'checkbox';
  setLabel.append(setBox, h('span', '', t('backupSettings'), 'backup-settings-text'));
  const row = h('div', 'row', null, 'backup-import-buttons');
  row.append(button('backup-folder-btn', t('backupChooseFolder'), 'primary', () => choose(folder)), button('backup-zip-btn', t('backupChooseZip'), '', () => choose(zip)));
  const report = h('div', 'backreport', null, 'backup-report');
  report.hidden = true;
  inn.append(h('h3', '', t('backupImportH'), 'backup-import-title'), para(t('backupImportText')), setLabel, row, folder, zip, report);
  body.append(out, inn);
  panel.append(head, body);
  el.app.append(back);
  state.backup = { back, x, setBox, report, busy: false };
  updateInert();
  outBtn.focus({ preventScroll: true });
}
function closeBackup() {
  document.querySelectorAll('.backv').forEach((n) => n.remove());
  state.backup = null;
  updateInert();
  viewBack($('backup-btn')).focus({ preventScroll: true });
}
// The zip, downloaded (as the browser downloads: its own place, or where you choose).
async function exportBackup(btn) {
  btn.disabled = true;
  try {
    const { files, counts } = await makeBackup({ version: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '' });
    const name = backupName() + '.zip';
    const url = URL.createObjectURL(new Blob([zipFiles(files)], { type: 'application/zip' }));
    const a = h('a', '', null, 'backup-download');
    a.href = url;
    a.download = name;
    asking = true; // a "Save as" dialog may take the focus for a moment
    setTimeout(() => { if (document.hasFocus()) asking = false; }, 1500);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(t('backupExported', { name, notes: counts.notes + counts.bmNotes, stars: counts.stars, bookmarks: counts.bookmarks }));
  } finally { btn.disabled = false; }
}
// The chosen folder's files (or the zip's), read and restored; what was done shown in the dialog.
async function importBackup(input) {
  const B = state.backup;
  if (!B || B.busy || !input.files || !input.files.length) return;
  B.busy = true;
  B.report.hidden = false;
  B.report.replaceChildren(h('p', 'pfine', t('backupWorking'), 'backup-working'));
  try {
    let files = null;
    const list = [...input.files];
    if (list.length === 1 && /\.zip$/i.test(list[0].name)) files = await unzipFiles(new Uint8Array(await list[0].arrayBuffer())).catch(() => null); // (not a zip, or a damaged one)
    else {
      files = new Map();
      for (const f of list) if (/\.json$/i.test(f.name) && f.size <= 50 * 1024 * 1024) files.set(f.webkitRelativePath || f.name, await f.text());
    }
    let data = null;
    try { if (files) data = readBackup(files); } catch { /* no backup in it */ }
    if (!data) { B.report.replaceChildren(h('p', 'perr', t('backupBad'), 'backup-bad')); return; }
    const done = await restoreBackup(data, { settings: B.setBox.checked });
    if (state.backup !== B) return;
    const lines = BACKUP_KINDS.map(({ key, label }) => h('li', '', t('backupLine', { what: t(label), added: done[key].added, updated: done[key].updated, skipped: done[key].skipped }), 'backup-report-line'));
    if (done.settings) lines.push(h('li', '', t('backupSettingsDone'), 'backup-report-settings'));
    const ul = h('ul', '', null, 'backup-report-list');
    ul.append(...lines);
    B.report.replaceChildren(h('p', 'backdone', t('backupDone'), 'backup-done'), ul);
    state.marks = null; // the search reads them again
    await reload();
    if (done.settings) { const p = await getPrefs(); state.prefs = p; applyAccent(p.accent); applyTheme(p.theme); } // (the language: at the next open)
  } catch (err) {
    if (state.backup === B) B.report.replaceChildren(h('p', 'perr', t('backupErr'), 'backup-error'));
    console.warn('[Tabazing] restore failed:', err && err.message);
  } finally { B.busy = false; }
}
function backupKey(e) {
  const k = e.key;
  if (MODIFIERS.has(k)) return;
  if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeBackup(); }
  const target = e.target instanceof Element ? e.target : null;
  if (target && target.closest('.backv') && (k === 'Enter' || k === ' ') && target.matches('button, input')) return; // its buttons and box
  if (k === 'Tab') return;
  e.preventDefault(); // (nothing reaches the switcher behind it)
}

// ---- the browsing history (in the menu, Ctrl+H): Chrome's history over the switcher, newest
// first and by day, 50 pages at a time ("Show 50 more" at the bottom, or ↓ past the last one). A list of rows (or
// cards: the bar's layout button), each with its preview when Tabazing has one, else its icon. A click (Enter) opens
// a page (its tab, when one is open), a middle-click (Ctrl+Enter) opens it behind, Shift+click (Space) shows it big,
// its trash (Del) removes it from Chrome's history (Undo puts it back, as a visit now). Tick boxes (Ctrl+click,
// Ctrl+Space, Shift+click for a range, Ctrl+A) pick pages for the bar: open, copy, remove. ⋯ (a right-click, Shift+F10)
// has the rest. The box finds pages by title, site, address or their note, typos forgiven; the range keeps to a time.
const HISTORY_PAGE = 50;
const HISTORY_POOL = 5000; // the visits a search looks through (and what Chrome's own search finds further back)
const historyOpen = () => !!document.querySelector('.hist');
const openable = (url) => /^(https?|file|ftp):/i.test(url || '');
const DAY = 864e5;
const RANGES = { all: 0, today: 'today', week: 7, month: 30 };
const rangeStart = (range) => { const r = RANGES[range]; if (!r) return 0; if (r === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); } return Date.now() - r * DAY; };
let histSeq = 0; // the rows' ids
let histPool = null; // { start, list } the newest visits a search looks through, read once per open (and range)
// The newest `limit` pages Chrome has that Tabazing can open (chrome://… left out: a few more are asked for, so a page of
// the list is still 50), since `start`, and whether it has more. `text`: only the pages it finds, newest first, matched
// as the search box matches (typos forgiven) on their title, site, address and note (the note left on the page as a
// tab: a closed tab keeps it). `capped`: the search looked through its 5000 visits and there are more.
async function fetchHistory(limit, text = '', start = 0) {
  if (!chrome.history) return { items: [], more: false, capped: false };
  if (!text) {
    const ask = limit + HISTORY_PAGE;
    const got = await chrome.history.search({ text: '', startTime: start, maxResults: ask });
    const items = got.filter((x) => openable(x.url)).map(hist);
    return { items: items.slice(0, limit), more: items.length > limit || got.length >= ask, capped: false };
  }
  if (!histPool || histPool.start !== start) {
    histPool = { start, list: chrome.history.search({ text: '', startTime: start, maxResults: HISTORY_POOL }).then((got) => ({ all: got.length, items: got.filter((x) => openable(x.url)).map(hist) })) };
  }
  const [pool, theirs] = await Promise.all([histPool.list, chrome.history.search({ text, startTime: start, maxResults: 500 }).catch(() => [])]);
  const byUrl = new Map();
  for (const x of [...pool.items, ...theirs.filter((y) => openable(y.url)).map(hist)]) if (!byUrl.has(x.url) || byUrl.get(x.url).t < x.t) byUrl.set(x.url, x);
  const found = [...byUrl.values()].filter((x) => matches(text, x.title, hostOf(x.url), x.url, noteOf(x.url), pageStatus(x.url, 'visited'))).sort((a, b) => b.t - a.t);
  return { items: found.slice(0, limit), more: found.length > limit, capped: pool.all >= HISTORY_POOL };
}
// A page of the history as an entry: what the rows, the menu and the big preview read.
const histEntry = (x, previews) => ({
  kind: 'hist', key: 'h' + (++histSeq), url: x.url, n: x.n || 0, preview: previews[normalizeUrl(x.url)] || null,
  item: { url: x.url, title: x.title || '', ts: x.t, session: null, fields: [[x.title || '', x.url]] },
});
// "Today", "Yesterday", or the day's date; and a time of day, in the language of the page.
function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const ago = Math.round((today - day) / DAY);
  if (ago === 0) return t('historyToday');
  if (ago === 1) return t('historyYesterday');
  return d.toLocaleDateString(uiLang(), { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
// How long ago, short: "just now", "5m ago", "3h ago", "2d ago", "3w ago", "4 months ago", "1 year ago".
function agoShort(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (!ts || s < 60) return t('justNow');
  if (s < 3600) return t('agoMin', { n: Math.floor(s / 60) });
  if (s < 86400) return t('agoHour', { n: Math.floor(s / 3600) });
  if (s < 7 * 86400) return t('agoDay', { n: Math.floor(s / 86400) });
  if (s < 30 * 86400) return t('agoWeek', { n: Math.floor(s / (7 * 86400)) });
  if (s < 365 * 86400) return t('agoMonth', { count: Math.floor(s / (30 * 86400)) });
  return t('agoYear', { count: Math.floor(s / (365 * 86400)) });
}
// A page's "last opened" tag: how long ago; hovering it shows the full date and time.
function agoTag(ts) {
  const tag = h('span', 'tag histago', agoShort(ts), 'card-history-ago');
  tag.title = ''; // (not the row's tooltip: its own)
  tag.setAttribute('aria-label', t('historyLastOpened') + ': ' + fullTime(ts));
  tag.addEventListener('mouseenter', () => showTip(tag, t('historyLastOpened'), fullTime(ts), 'history-date-tooltip', DATE_TIP_DELAY_MS));
  tag.addEventListener('mouseleave', hideTipSoon);
  return tag;
}
const fullTime = (ts) => new Date(ts).toLocaleString(uiLang(), { dateStyle: 'medium', timeStyle: 'short' });
// A dialog that asks first: a title, a sentence, Cancel, and its actions ({ label, cls, fn, testid }).
function confirmDialog({ title, text, testid, actions }) {
  const box = h('div', 'bmform', null, testid);
  const h3 = h('h3', '', title, 'dialog-title');
  h3.id = 'dlg-title';
  const row = h('div', 'row', null, testid + '-buttons');
  row.append(h('span', 'grow', null, testid + '-spacer'), button(testid + '-cancel', t('cancel'), 'quiet', closeDialog),
    ...actions.map((a) => button(a.testid, a.label, a.cls || '', () => { closeDialog(); Promise.resolve(a.fn()).catch((err) => toast(a.err || t('actFailed'), err)); })));
  box.append(h3, para(text), row);
  showDialog('bmedit', [box]);
  const main = row.querySelector('.primary, .danger');
  if (main) main.focus({ preventScroll: true });
}
async function openHistory() {
  closeDrawer(false);
  if (settingsOpen()) closeSettings(); // (Ctrl+H over Settings: the history comes in its place)
  closePops();
  closeBig();
  hideTip();
  state.dd.hidden = true;
  renderDropdown();
  if (archiveOpen()) closeArchive();
  if (bookmarksOpen()) closeBookmarks();
  histPool = null; // read again: the history may have grown since
  const view = await getView().catch(() => ({}));
  if (state.done) return;
  document.querySelectorAll('.hist').forEach((n) => n.remove());
  const { back, panel } = viewDialog('hist', 'history-overlay', 'hist-h', closeHistory);
  const head = h('div', 'archhead', null, 'history-header');
  const title = h('h2', 'archtitle', t('historyTitle'), 'history-title');
  title.id = 'hist-h';
  const count = h('span', 'n', '', 'history-count');
  title.append(count);
  const x = h('button', 'archx', null, 'history-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = t('historyClose') + ' (Esc)';
  x.setAttribute('aria-label', t('historyClose'));
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeHistory(); });
  head.append(title, h('span', 'archsub', t('historySub'), 'history-sub'), x);
  // the bar: the search box (it waits for a pause in typing), the range, the layout, Clear browsing data; with pages
  // picked, how many and what can be done to them
  const tools = h('div', 'bmvtools', null, 'history-tools');
  const find = searchField('history-search', t('historySearch'), t('historySearchAria'));
  find.input.setAttribute('aria-controls', 'hist-list');
  let findTimer = null;
  find.input.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => { findTimer = null; findHistory(find.input.value.trim()).catch(() => {}); }, 180); });
  // The search the box still waits to run, at once (Enter right after typing opens what it finds); null if none waits.
  const flushFind = () => { if (!findTimer) return null; clearTimeout(findTimer); findTimer = null; return findHistory(find.input.value.trim()).catch(() => {}); };
  const range = h('select', '', null, 'history-range');
  range.setAttribute('aria-label', t('historyRangeAria'));
  for (const { v, label } of [{ v: 'all', label: 'historyRangeAll' }, { v: 'today', label: 'historyRangeToday' }, { v: 'week', label: 'historyRangeWeek' }, { v: 'month', label: 'historyRangeMonth' }]) {
    const o = h('option', '', t(label), 'history-range-option');
    o.value = v;
    range.append(o);
  }
  range.value = RANGES[view.histRange] !== undefined ? view.histRange : 'all';
  range.addEventListener('change', () => { updateView({ histRange: range.value }).catch(() => {}); refreshHistory().catch(() => {}); });
  const layout = h('button', 'chip', null, 'history-layout');
  layout.type = 'button';
  layout.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) setHistoryLayout(state.hist.layout === 'list' ? 'grid' : 'list'); });
  const clear = h('button', 'act', null, 'history-clear-data');
  clear.type = 'button';
  clear.append(svgOf(ICON.eraser), h('span', '', t('historyClearData'), 'history-clear-data-label'));
  clear.title = 'chrome://settings/clearBrowserData';
  clear.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) chromePage('chrome://settings/clearBrowserData')(); });
  const sel = h('div', 'bmvsel', null, 'history-selection');
  const selN = h('span', '', '', 'history-selected');
  const picked = () => state.hist.items.filter((e) => state.hist.picked.has(e.key));
  sel.append(selN,
    button('history-open-selected', t('historyOpenSel'), 'small', () => historyBehindMany(picked()).catch((err) => toast(t('actFailed'), err))),
    button('history-copy-selected', t('actCopy'), 'small', () => copyLinks(picked().map((e) => ({ title: e.item.title, url: e.url })), 'plain').catch((err) => toast(t('copyFailed'), err))),
    button('history-remove-selected', t('historyRemoveSel'), 'small danger', () => removeHistory(picked()).catch((err) => toast(t('historyRemoveErr'), err))),
    button('history-clear-selected', t('bmvClearSel'), 'small quiet', () => { state.hist.picked.clear(); syncHistory(); }));
  tools.append(find.box, range, layout, clear, sel);
  const notice = h('p', 'histnote', t('historyPoolNote', { count: HISTORY_POOL }), 'history-pool-note');
  notice.hidden = true;
  const body = h('div', 'archbody', null, 'history-body');
  const list = h('div', '', null, 'history-grid');
  list.id = 'hist-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', 'hist-h');
  list.setAttribute('aria-multiselectable', 'true');
  const more = h('button', 'btn histmore', null, 'history-more');
  more.type = 'button';
  more.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) moreHistory().catch((err) => toast(t('actFailed'), err)); });
  const empty = h('p', 'empty', '', 'history-empty');
  body.append(notice, empty, list, more);
  panel.append(head, tools, body);
  el.app.append(back);
  state.hist = { items: [], limit: HISTORY_PAGE, more: false, sel: 0, back, list, body, count, moreBtn: more, empty, x, q: '', find: find.input, picked: new Set(), anchor: -1, flushFind,
    layout: view.histLayout === 'grid' ? 'grid' : 'list', range, layoutBtn: layout, selBar: sel, selN, notice };
  fancySelect(range);
  // Reaching the bottom of the list loads the next 50 by itself ("Show 50 more" is there, and stays for the keyboard).
  state.hist.io = new IntersectionObserver((seen) => {
    const H = state.hist;
    if (H && seen.some((x) => x.isIntersecting) && H.more && !H.busy) moreHistory({ select: false }).catch(() => {}); // (scrolled to: the selection stays)
  }, { root: body, rootMargin: '0px 0px 240px 0px' });
  state.hist.io.observe(more);
  updateInert();
  find.input.focus({ preventScroll: true });
  find.input.select();
  await refreshHistory({ keepQ: true });
}
// The list again from the top: the newest 50 pages for the box's text and the range (the rows shown are dropped).
async function refreshHistory({ keepQ = false } = {}) {
  const H = state.hist;
  if (!H) return;
  const q = keepQ ? H.q : H.find.value.trim();
  H.q = q;
  H.limit = HISTORY_PAGE;
  const res = await fetchHistory(H.limit, q, rangeStart(H.range.value)).catch(() => ({ items: [], more: false, capped: false }));
  const previews = await getPreviews(res.items.map((x) => x.url)).catch(() => ({}));
  if (state.hist !== H || H.q !== q) return; // typed on meanwhile
  H.items = [];
  H.picked.clear();
  H.anchor = -1; // (a Shift+click range starts again in the new list)
  H.list.replaceChildren();
  H.more = res.more;
  H.notice.hidden = !(q && res.capped);
  addHistory(res.items, previews);
  histSelect(0, false);
  H.body.scrollTop = 0;
}
// The search box's text: the list starts again with the newest 50 pages that have it. (The box starts empty each
// time the history opens: a search is for now, not for next time.)
async function findHistory(q) {
  const H = state.hist;
  if (!H || q === H.q) return;
  H.find.value = H.find.value.trim() === q ? H.find.value : q;
  await refreshHistory();
}
// Rows (or cards) for these pages, the ones not shown yet, at the end, under a heading for each new day.
function addHistory(items, previews) {
  const H = state.hist;
  const have = new Set(H.items.map((e) => e.url));
  const add = items.filter((x) => !have.has(x.url)).map((x) => histEntry(x, previews));
  let day = H.items.length ? dayLabel(H.items[H.items.length - 1].item.ts) : '';
  for (const e of add) {
    const d = dayLabel(e.item.ts);
    if (d !== day) { H.list.append(h('h3', 'histday', d, 'history-day')); day = d; }
    H.items.push(e);
    H.list.append(historyItem(e));
  }
  syncHistory();
  return add;
}
function syncHistory() {
  const H = state.hist;
  H.list.className = H.layout === 'grid' ? 'grid' + (state.cardSize === 'default' ? '' : ' ' + state.cardSize) + ' histgrid' : 'histlist';
  H.back.classList.toggle('picking', H.picked.size > 0);
  H.count.textContent = H.more ? t('historyShown', { count: H.items.length }) : String(H.items.length);
  H.empty.textContent = t(!chrome.history ? 'historyNone' : H.q ? 'historyNoMatch' : 'historyEmpty');
  H.empty.hidden = H.items.length > 0;
  H.list.hidden = !H.items.length;
  H.moreBtn.hidden = !H.more;
  H.moreBtn.textContent = t('historyMore', { count: HISTORY_PAGE });
  const other = H.layout === 'list' ? t('historyGrid') : t('historyList'); // the look a press switches to
  H.layoutBtn.replaceChildren(svgOf(ICON[H.layout === 'list' ? 'cards' : 'sort']), h('span', '', other, 'history-layout-label'));
  H.layoutBtn.setAttribute('aria-label', other);
  H.selBar.hidden = !H.picked.size;
  H.selN.textContent = t('bmvSelected', { count: H.picked.size });
  for (const e of H.items) {
    const on = H.picked.has(e.key);
    e.el.classList.toggle('picked', on);
    e.el.setAttribute('aria-checked', String(on));
    const box = e.el.querySelector('[data-testid="hist-pick"]');
    if (box) { box.classList.toggle('on', on); box.setAttribute('aria-checked', String(on)); }
  }
}
// Rows or cards (the bar's layout button; remembered): the rows drawn again in the other look.
function setHistoryLayout(layout) {
  const H = state.hist;
  H.layout = layout;
  updateView({ histLayout: layout }).catch(() => {});
  const items = H.items;
  H.items = [];
  H.list.replaceChildren();
  let day = '';
  for (const e of items) {
    const d = dayLabel(e.item.ts);
    if (d !== day) { H.list.append(h('h3', 'histday', d, 'history-day')); day = d; }
    H.items.push(e);
    H.list.append(historyItem(e));
  }
  syncHistory();
  histSelect(H.sel, false);
}
// "Show 50 more": the next 50 visits, under the ones shown (the page stays where it was).
// `select`: the first of them is selected (↓ past the last page, "Show 50 more"), not when they come by scrolling.
async function moreHistory({ select = true } = {}) {
  const H = state.hist;
  if (!H || H.busy || !H.more) return;
  H.busy = true;
  H.moreBtn.disabled = true;
  try {
    H.limit += HISTORY_PAGE;
    const q = H.q;
    const res = await fetchHistory(H.limit, q, rangeStart(H.range.value));
    const previews = await getPreviews(res.items.map((x) => x.url)).catch(() => ({}));
    if (state.hist !== H || !historyOpen() || H.q !== q) return;
    H.more = res.more;
    const first = H.items.length;
    const add = addHistory(res.items, previews);
    if (add.length && select) histSelect(first, false);
    if (H.moreBtn.hidden && document.activeElement === H.moreBtn) H.find.focus({ preventScroll: true });
  } finally {
    H.busy = false;
    H.moreBtn.disabled = false;
    // still in view after these (a tall window): watched again, so the next 50 come too
    if (H.io && H.more) { H.io.unobserve(H.moreBtn); H.io.observe(H.moreBtn); }
  }
}
// What a page says about itself: where it is, when it was last visited, how often (the tooltip; the big preview).
const histInfo = (e) => [e.url, t('historyLastVisit', { time: fullTime(e.item.ts) }), t('historyVisits', { count: e.n || 1 })];
// (the history's rows no longer show the time of day: their "last opened" tag says how long ago, its tooltip when)
// A page as a row (the list) or a card (the grid): its tick box, its picture, its title, site and time, its note,
// and its buttons (note, big preview, remove, ⋯).
function historyItem(entry) {
  const H = state.hist, c = entry.item, q = H.q;
  const title = c.title || hostOf(c.url) || t('untitled');
  entry.info = histInfo(entry);
  const pick = h('button', 'bmvpick', null, 'hist-pick');
  pick.type = 'button';
  pick.setAttribute('role', 'checkbox');
  pick.setAttribute('aria-checked', 'false');
  pick.setAttribute('aria-label', t('bmvSelect'));
  pick.append(svgOf(ICON.check));
  pick.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) histPick(entry, { range: e.shiftKey }); });
  const btn = (testid, icon, label, fn, cls = '') => {
    const b = h('button', 'qbtn' + cls, null, testid);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(svgOf(ICON[icon]));
    b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) { histSelect(H.items.indexOf(entry), false); fn(b); } });
    return b;
  };
  const big = btn('quick-big', 'expand', t('historyBig') + ' (Space)', () => openBig(entry));
  const more = btn('quick-more', 'more', t('cardMenu'), (b) => historyMenu(entry, { anchor: b }));
  more.setAttribute('aria-haspopup', 'menu');
  const remove = deleteButton(t('historyRemove'), 'card-history-remove', () => removeHistory([entry]).catch((err) => toast(t('historyRemoveErr'), err)));
  const titleEl = h('span', H.layout === 'list' ? 'bmvtitle' : 'title', null, 'card-title');
  titleEl.append(q ? highlight(title, q) : title);
  const note = noteOf(c.url);
  let el;
  if (H.layout === 'list') {
    el = h('div', 'bmvrow mark histrow', null, 'card-history');
    const pic = h('div', 'bmvpic' + (entry.preview ? '' : ' bare'), null, entry.preview ? 'card-thumb' : 'card-no-preview');
    const img = h('img', entry.preview ? 'shot' : 'fav', null, entry.preview ? 'card-preview' : 'card-tile-favicon');
    img.src = entry.preview ? entry.preview.img : favicon(c.url);
    img.alt = '';
    pic.append(img);
    const text = h('div', 'bmvtext', null, 'card-text');
    const tline = h('span', 'bmvtline', null, 'card-history-title-row');
    tline.append(titleEl, agoTag(c.ts));
    const sub = h('span', 'bmvsub', null, 'card-history-sub');
    sub.append(q ? highlight(siteOf(c.url) || c.url, q) : siteOf(c.url) || c.url);
    text.append(tline, sub);
    if (note) { const n = h('span', 'bmvnote', null, 'card-history-note'); n.append(q ? highlight(note, q) : note); text.append(n); }
    const acts = h('div', 'bmvacts', null, 'card-quick-actions');
    const noteBtn = noteButton(entry);
    acts.append(noteBtn, big, remove, more);
    remove.classList.add('qbtn');
    el.append(pick, pic, text, acts);
  } else {
    el = h('div', 'card', null, 'card-history');
    const head = h('div', 'head', null, 'card-head');
    const fav = h('img', 'fav', null, 'card-favicon');
    fav.src = favicon(c.url);
    fav.alt = '';
    head.append(pick, fav, titleEl, agoTag(c.ts), headButtons(remove));
    const quick = h('div', 'quick', null, 'card-quick-actions');
    quick.append(noteButton(entry), big, more);
    const thumb = entry.preview ? thumbFor(entry, { label: '' }) : thumbFor(entry, { bare: true });
    thumb.append(quick);
    el.append(head, thumb);
  }
  el.id = 'hist-' + entry.key;
  el.setAttribute('role', 'option');
  el.setAttribute('aria-selected', 'false');
  el.setAttribute('aria-checked', 'false');
  el.title = t('historyOpenTip', { title }) + '\n' + entry.info.join('\n');
  entry.el = entry.card = el;
  mouseOnly(el); // the keyboard has Enter, Space, Del, Ctrl+Space and the menu (Shift+F10)
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pointerAllowed()) return;
    const i = H.items.indexOf(entry);
    if (e.ctrlKey || e.metaKey) return histPick(entry);
    if (e.shiftKey) { if (H.picked.size) return histPick(entry, { range: true }); histSelect(i, false); return openBig(entry); }
    openPage(c.url);
  });
  onMiddleClick(el, () => historyBehind(c).catch((err) => toast(t('actFailed'), err)));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pointerAllowed()) return;
    histSelect(H.items.indexOf(entry), false);
    historyMenu(entry, { at: { x: e.clientX, y: e.clientY } });
  });
  return el;
}
// Tick a page, or (`range`) every page from the last one ticked to it.
function histPick(entry, { range = false } = {}) {
  const H = state.hist;
  const i = H.items.indexOf(entry);
  if (range && H.anchor >= 0 && H.anchor < H.items.length) {
    const [a, b] = H.anchor < i ? [H.anchor, i] : [i, H.anchor];
    for (let k = a; k <= b; k++) H.picked.add(H.items[k].key);
  } else if (H.picked.has(entry.key)) H.picked.delete(entry.key);
  else H.picked.add(entry.key);
  H.anchor = i;
  histSelect(i, false);
  syncHistory();
  el.live.textContent = t('bmvSelected', { count: H.picked.size });
}
function histSelect(i, scroll = true) {
  const H = state.hist;
  if (!H || !H.items.length) return;
  H.sel = Math.max(0, Math.min(H.items.length - 1, i));
  H.items.forEach((e, k) => e.el.setAttribute('aria-selected', String(k === H.sel)));
  const it = H.items[H.sel].el;
  H.list.setAttribute('aria-activedescendant', it.id);
  H.find.setAttribute('aria-activedescendant', it.id);
  if (scroll) it.scrollIntoView({ block: 'nearest' });
}
function closeHistory() {
  closePops();
  if (state.hist && state.hist.io) state.hist.io.disconnect();
  if (state.hist) state.hist.find.value = ''; // (a search still waiting then finds no history to run in)
  document.querySelectorAll('.hist').forEach((n) => n.remove());
  state.hist = null;
  updateInert();
  viewBack($('history-btn')).focus({ preventScroll: true }); // back to what opened it
}
// Out of Chrome's history (every visit to them), and off the list here; the search forgets them too. Undo puts them
// back (as a visit now: Chrome can't bring the old visits back).
async function removeHistory(entries) {
  const H = state.hist;
  entries = entries.filter(Boolean);
  if (!entries.length) return;
  for (const e of entries) await chrome.history.deleteUrl({ url: e.url });
  forgetHistory(entries.map((e) => e.url));
  if (H && state.hist === H) {
    const first = Math.min(...entries.map((e) => H.items.indexOf(e)).filter((i) => i >= 0));
    for (const e of entries) {
      const i = H.items.indexOf(e);
      if (i >= 0) H.items.splice(i, 1);
      H.picked.delete(e.key);
      e.el.remove();
    }
    H.list.querySelectorAll('.histday').forEach((d) => { const n = d.nextElementSibling; if (!n || n.classList.contains('histday')) d.remove(); }); // a day left empty
    syncHistory();
    histSelect(Math.min(Number.isFinite(first) ? first : 0, H.items.length - 1), false);
  }
  const pages = entries.map((e) => ({ url: e.url, title: e.item.title, t: e.item.ts }));
  toast(t('historyRemovedN', { count: entries.length }), null, { label: t('undo'), fn: () => unremoveHistory(pages) });
}
// What the search and the history list keep, without these addresses.
function forgetHistory(urls) {
  const gone = new Set(urls.map(urlKey));
  if (state.history) state.history = state.history.filter((x) => !gone.has(urlKey(x.url)));
  if (histPool) histPool = { ...histPool, list: histPool.list.then((p) => ({ ...p, items: p.items.filter((x) => !gone.has(urlKey(x.url))) })) };
  if (state.histQ && state.histQ.items) state.histQ = { ...state.histQ, items: state.histQ.items.filter((x) => !gone.has(urlKey(x.url))) };
}
async function unremoveHistory(pages) {
  for (const p of pages) {
    // A title and the time of the visit, where Chrome takes them; else only the address (a Chrome that doesn't know
    // those refuses the call itself, before it returns: hence try, not .catch).
    try { await chrome.history.addUrl({ url: p.url, title: p.title, visitTime: p.t }); }
    catch { try { await chrome.history.addUrl({ url: p.url }); } catch {} }
  }
  histPool = null;
  state.history = null;
  toast(t('historyRestoredN', { count: pages.length }));
  if (historyOpen()) await refreshHistory();
}
// Open pages of the history behind Tabazing, which stays (the new tabs join the open ones).
async function historyBehind(c) {
  await reopenPage(c, { active: false });
  toast(t('openedN', { count: 1 }));
  await reload();
}
async function historyBehindMany(entries) {
  for (const e of entries) await chrome.tabs.create({ url: e.url, windowId: CTX.srcWin, active: false });
  if (state.hist) { state.hist.picked.clear(); syncHistory(); }
  toast(t('openedN', { count: entries.length }));
  await reload();
}
// "More from this site": the search box set to the page's site.
function historyMoreFrom(entry) {
  const H = state.hist;
  const host = hostOf(entry.url).replace(/^www\./, '');
  if (!H || !host) return;
  H.find.value = host;
  H.find.focus({ preventScroll: true });
  findHistory(host).catch(() => {});
}
// "Remove all from this site": every visit to its site's pages, after saying how many (Undo puts them back).
async function historyForgetSite(entry) {
  const host = hostOf(entry.url);
  if (!host) return;
  const got = await chrome.history.search({ text: host.replace(/^www\./, ''), startTime: 0, maxResults: 100000 });
  const pages = got.filter((x) => hostOf(x.url) === host);
  if (!pages.length) return;
  confirmDialog({
    title: t('historyForgetSiteTitle', { site: host.replace(/^www\./, '') }), text: t('historyForgetSiteText', { count: pages.length }), testid: 'history-forget-site',
    actions: [{ label: t('historyRemove'), cls: 'danger', testid: 'history-forget-site-ok', err: t('historyRemoveErr'), fn: async () => {
      for (const p of pages) await chrome.history.deleteUrl({ url: p.url });
      forgetHistory(pages.map((p) => p.url));
      if (historyOpen()) await refreshHistory();
      const back = pages.map((p) => ({ url: p.url, title: p.title || '', t: p.lastVisitTime || Date.now() }));
      toast(t('historyRemovedN', { count: pages.length }), null, { label: t('undo'), fn: () => unremoveHistory(back) });
    } }],
  });
}
// A page's ⋯ (a right-click, Shift+F10): everything a page can have done to it.
function historyMenu(entry, { anchor = null, at = null } = {}) {
  const c = entry.item, card = entry.el;
  if (!card || !card.isConnected) return;
  if (at) anchor = card;
  else if (!anchor) {
    const more = card.querySelector('[data-testid="quick-more"]');
    anchor = more && more.getClientRects().length ? more : card;
  }
  const H = state.hist;
  const note = card.querySelector('.qbtn.note');
  const pages = [{ title: c.title, url: c.url }];
  const items = [
    { icon: 'goto', label: t('historyOpen'), fn: () => openPage(c.url) },
    { icon: 'window', label: t('historyNewWindow'), err: t('actFailed'), fn: () => reopenInWindow(c) },
    { icon: 'tab', label: t('historyBehind'), err: t('actFailed'), fn: () => historyBehind(c) },
    { icon: 'expand', label: t('historyBig'), fn: () => openBig(entry) },
    null,
    { icon: 'link', label: t('copyLink'), err: t('copyFailed'), fn: () => copyLinks(pages, 'plain') },
    { icon: 'star', label: t(isStarred(c.url) ? 'unstar' : 'star'), fn: () => star(entry) },
  ];
  if (note) items.push({ icon: 'note', label: t(noteOf(c.url) ? 'noteEdit' : 'noteAdd'), fn: () => notePopover(c.url, note) });
  items.push(
    { icon: 'bookmark', label: t('markMenu'), err: t('markErr'), fn: () => bookmarkDialog(pages) },
    { icon: 'clock', label: t('historySnooze'), err: t('errSnooze'), fn: () => snoozeMenu([], anchor, (when) => snoozeClosed(c, when)) },
    { icon: 'archive', label: t('tabArchive'), err: t('errArchive'), fn: () => archiveClosed(c) },
    null,
    { icon: 'check', label: t(H.picked.has(entry.key) ? 'bmvUnselect' : 'bmvSelect'), fn: () => histPick(entry) },
    { icon: 'globe', label: t('historyMoreFrom'), fn: () => historyMoreFrom(entry) },
    null,
    { icon: 'trash', label: t('historyRemove'), danger: true, err: t('historyRemoveErr'), fn: () => removeHistory([entry]) },
    { icon: 'trash', label: t('historyForgetSite'), danger: true, err: t('historyRemoveErr'), fn: () => historyForgetSite(entry) },
  );
  menu(anchor, items, { back: H.find, at });
}
// While the history is open it has the keyboard (a menu, a small card or a dialog over it keeps its own keys). In
// the search box the keys type, except ↑ ↓ PgUp PgDn (and Home / End while it is empty), Enter, Ctrl+Enter,
// Ctrl+Space, Shift+F10 and Esc. Out of it, Space shows a page big and Del removes the ticked pages or the selected one.
// Esc empties the box first, then unticks, then closes. Typing anywhere goes to the box.
function historyKey(e) {
  const k = e.key, H = state.hist;
  const target = e.target instanceof Element ? e.target : null;
  if (!H || (target && target.closest('.menu, .pop'))) return;
  if (MODIFIERS.has(k)) return;
  if (target && target.closest('.histmore, .bmvtools button, .bmvtools .fs') && (k === 'Enter' || k === ' ')) return; // its buttons press
  const inBox = target === H.find;
  const empty = !H.find.value;
  const C = e.ctrlKey || e.metaKey;
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (k === 'Escape') {
    stop();
    if (H.find.value) { H.find.value = ''; findHistory('').catch(() => {}); H.find.focus({ preventScroll: true }); return; }
    if (H.picked.size) { H.picked.clear(); syncHistory(); return; }
    return closeHistory();
  }
  const nav = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Enter'].includes(k) || ((k === 'Home' || k === 'End') && (!inBox || empty))
    || (k === ' ' && C) || (k === 'F10' && e.shiftKey) || k === 'ContextMenu' || (C && k.toLowerCase() === 'a' && (!inBox || empty));
  if (inBox && !nav) return; // typing
  if (!inBox && k.length === 1 && k !== ' ' && !C && !e.altKey) { H.find.focus({ preventScroll: true }); return; } // typing goes to the box
  stop();
  const waiting = k === 'Enter' && H.flushFind();
  if (waiting) { waiting.then(() => { if (state.hist === H) historyKey(e); }); return; } // the search typed first, then its first page
  if (C && !e.shiftKey && !e.altKey && e.code === 'KeyZ') { if (!e.repeat) toastUndo(); return; }
  if (!H.items.length) return;
  const entry = H.items[H.sel];
  if (C && k.toLowerCase() === 'a') { H.items.forEach((x) => H.picked.add(x.key)); syncHistory(); el.live.textContent = t('bmvSelected', { count: H.picked.size }); return; }
  if (k === ' ' && C) return histPick(entry);
  if (k === 'Delete' || (IS_MAC && e.metaKey && k === 'Backspace')) {
    if (e.repeat) return;
    if (!keysAllowed()) return finish('cancel');
    return removeHistory(H.picked.size ? H.items.filter((x) => H.picked.has(x.key)) : [entry]).catch((err) => toast(t('historyRemoveErr'), err));
  }
  if (k === 'Enter') {
    if (!keysAllowed()) return finish('cancel');
    if (C) return historyBehind(entry.item).catch((err) => toast(t('actFailed'), err)); // Ctrl+Enter: behind, Tabazing stays
    return openPage(entry.url);
  }
  if (k === ' ') return openBig(entry);
  if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) { if (!e.repeat) historyMenu(entry); return; }
  if (k === 'Home') return histSelect(0);
  if (k === 'End') return histSelect(H.items.length - 1);
  if (k === 'PageDown' || k === 'PageUp') return histSelect(H.sel + (k === 'PageDown' ? 10 : -10));
  const grid = H.layout === 'grid';
  if (k === 'ArrowRight' || k === 'ArrowLeft') { if (grid) histSelect(H.sel + ahead(k)); return; }
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    const down = k === 'ArrowDown';
    const j = grid && !inBox ? cardToward(H.items.map((x) => x.el), H.sel, down ? 1 : -1) : H.sel + (down ? 1 : -1) < H.items.length ? H.sel + (down ? 1 : -1) : -1;
    if (j >= 0) histSelect(j);
    else if (down && H.more) moreHistory().catch(() => {}); // past the last one: the next 50
  }
}

// A search box in the history's and the bookmarks' bar: a magnifier and the field. { box, input }.
function searchField(testid, placeholder, aria) {
  const box = h('label', 'bmvsearch', null, testid + '-box');
  box.append(svgOf(ICON.zoom));
  const input = h('input', '', null, testid);
  input.type = 'search';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', aria);
  input.autocomplete = 'off';
  input.spellcheck = false;
  box.append(input);
  return { box, input };
}

// ---- the bookmarks (the bookmark button after History, Ctrl+Shift+O): every Chrome bookmark as a tree, over the
// switcher as the history is. A folder opens and closes (click, ← →, * for all beside it); a bookmark shows its
// preview (or its icon), its address and its note. A click (Enter) opens it, a middle-click (Ctrl+Enter) behind,
// Shift+click (Space) shows it big. Tick boxes (Ctrl+click, Ctrl+Space, Shift+click for a range, Ctrl+A) pick
// bookmarks and folders for the bar: open, move, copy, delete. A row's buttons: its note (a bookmark's own: kept by
// the bookmark, not by its address, so a tab's note is another thing), big preview, Edit (F2), Delete (Del), ⋯. Drag
// rows to move them (Ctrl+↑ ↓ moves the selected one). Every change has Undo. The box at the top finds bookmarks by
// name, site, address or note, folders by name, typos forgiven; Duplicates shows only the addresses bookmarked more
// than once. What is open, the selected row and the search come back next time.
const bookmarksOpen = () => !!document.querySelector('.bmv');
const bmNoteOf = (id) => ((state.bmNotes || {})[id] || {}).n || '';
const BMV_CONFIRM = 15; // opening more tabs than this at once asks first (as Chrome does); deleting 10 bookmarks or more too
const BMV_CONFIRM_DELETE = 10;
const BMV_EAGER = 80; // the rows whose previews are read at once (the others when they scroll into view)
let bmvIO = null;
async function openBookmarks() {
  closeDrawer(false);
  if (!chrome.bookmarks) return toast(t('ddNoMarks'));
  if (settingsOpen()) closeSettings();
  closePops();
  closeBig();
  hideTip();
  state.dd.hidden = true;
  renderDropdown();
  if (archiveOpen()) closeArchive();
  if (historyOpen()) closeHistory();
  const [tree, notes, view] = await Promise.all([chrome.bookmarks.getTree(), getBmNotes().catch(() => ({})), getView().catch(() => ({}))]);
  if (state.done) return;
  state.bmNotes = notes;
  document.querySelectorAll('.bmv').forEach((n) => n.remove());
  const { back, panel } = viewDialog('bmv', 'bookmarks-overlay', 'bmv-h', closeBookmarks);
  const head = h('div', 'archhead', null, 'bookmarks-header');
  const title = h('h2', 'archtitle', t('bmvTitle'), 'bookmarks-title');
  title.id = 'bmv-h';
  const count = h('span', 'n', '', 'bookmarks-count');
  title.append(count);
  const x = h('button', 'archx', null, 'bookmarks-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = t('bmvClose') + ' (Esc)';
  x.setAttribute('aria-label', t('bmvClose'));
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeBookmarks(); });
  head.append(title, h('span', 'archsub', t('bmvSub'), 'bookmarks-sub'), x);
  // the bar: the search box, Add bookmark, New folder, Duplicates, the stars; with rows ticked, how many
  // and what can be done to them
  const tools = h('div', 'bmvtools', null, 'bookmarks-tools');
  const find = searchField('bookmarks-search', t('bmvSearch'), t('bmvSearchAria'));
  find.input.setAttribute('role', 'combobox');
  find.input.setAttribute('aria-controls', 'bmv-tree');
  find.input.setAttribute('aria-expanded', 'true');
  let findTimer = null;
  find.input.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => { findTimer = null; bmvFind(find.input.value); }, 100); });
  // The search the box still waits to run, at once (Enter right after typing opens what it finds).
  const flushFind = () => { if (findTimer) { clearTimeout(findTimer); findTimer = null; bmvFind(find.input.value); } };
  const tool = (testid, icon, label, fn, cls = 'act') => {
    const b = h('button', cls, null, testid);
    b.type = 'button';
    b.append(svgOf(ICON[icon]), h('span', '', label, testid + '-label'));
    b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) Promise.resolve(fn(b)).catch((err) => toast(t('bmvErr'), err)); });
    return b;
  };
  const add = tool('bookmarks-add', 'plus', t('bmvAdd'), () => bmvEdit(null, { parentId: bmvHere() }));
  const folder = tool('bookmarks-new-folder', 'folder', t('bmvNewFolder'), () => bmvEdit(null, { parentId: bmvHere(), folder: true }));
  const dupes = tool('bookmarks-dupes', 'dupe', '', () => bmvFilter('dupes'), 'chip');
  const stars = tool('bookmarks-stars', 'star', '', () => bmvImportStars());
  const sel = h('div', 'bmvsel', null, 'bookmarks-selection');
  const selN = h('span', '', '', 'bookmarks-selected');
  const pickedNodes = () => [...state.bmv.picked].map((id) => state.bmv.byId.get(id)).filter(Boolean);
  sel.append(selN,
    button('bookmarks-open-selected', t('historyOpenSel'), 'small', () => bmvOpenAll(pickedNodes().flatMap(bmvMarksIn)).catch((err) => toast(t('actFailed'), err))),
    button('bookmarks-move-selected', t('bmvMoveSel'), 'small', () => bmvMoveDialog(pickedNodes()).catch((err) => toast(t('bmvErr'), err))),
    button('bookmarks-copy-selected', t('actCopy'), 'small', () => copyLinks(pickedNodes().flatMap(bmvMarksIn).map((m) => ({ title: m.title, url: m.url })), 'plain').catch((err) => toast(t('copyFailed'), err))),
    button('bookmarks-delete-selected', t('bmvDeleteSel'), 'small danger', () => bmvDelete(pickedNodes()).catch((err) => toast(t('bmvErr'), err))),
    button('bookmarks-clear-selected', t('bmvClearSel'), 'small quiet', () => { state.bmv.picked.clear(); drawBookmarks(); }));
  tools.append(find.box, add, folder, dupes, stars, sel);
  const body = h('div', 'archbody', null, 'bookmarks-body');
  const treeEl = h('div', 'bmvtree', null, 'bookmarks-tree');
  treeEl.id = 'bmv-tree';
  treeEl.setAttribute('role', 'tree');
  treeEl.setAttribute('aria-labelledby', 'bmv-h');
  treeEl.setAttribute('aria-multiselectable', 'true');
  const empty = h('p', 'empty', '', 'bookmarks-empty');
  body.append(empty, treeEl);
  panel.append(head, tools, body);
  el.app.append(back);
  const B = state.bmv = {
    back, body, tree: treeEl, empty, count, find: find.input, flushFind, sel, selN, x, q: '', cur: 0, curId: null, rows: [], open: new Set(), picked: new Set(), anchorId: null,
    previews: {}, byId: new Map(), tops: [], filter: null, dupes: new Map(), dupesBtn: dupes, starsBtn: stars,
  };
  bmvIndex(B, tree);
  // What was open and the selected row come back (the folders that are still there); the first time, Chrome's own
  // folders are open. The search box starts empty.
  const kept = (view.bmvOpen || []).filter((id) => B.byId.has(id));
  (kept.length ? kept : B.tops).forEach((id) => B.open.add(id));
  if (view.bmvSel && B.byId.has(view.bmvSel)) B.curId = view.bmvSel;
  pruneBmNotes(B).catch(() => {});
  drawBookmarks();
  updateInert();
  find.input.focus({ preventScroll: true });
  find.input.select();
  bmvSelect(B.cur);
}
// The tree, by id: { id, parentId, title, url, kids (ids, in order), top (Chrome's own folders: fixed), dateAdded, archive }.
function bmvIndex(B, tree) {
  B.byId = new Map();
  B.tops = [];
  const walk = (n) => {
    const node = { id: n.id, parentId: n.parentId, title: n.title || '', url: n.url || '', dateAdded: n.dateAdded || 0, top: n.parentId === '0', fixed: n.parentId === '0' || !!n.unmodifiable, kids: [] };
    B.byId.set(n.id, node);
    for (const c of n.children || []) { node.kids.push(c.id); walk(c); }
  };
  for (const top of (tree[0] && tree[0].children) || []) { B.tops.push(top.id); walk(top); }
  const other = B.tops.map((id) => B.byId.get(id)).find((n) => /other/i.test(n.title)) || B.byId.get('2');
  for (const id of (other && other.kids) || []) { const n = B.byId.get(id); if (n && !n.url && n.title === ARCHIVE_FOLDER) n.archive = true; }
  // the same address bookmarked more than once (Duplicates), by its normalized address
  const by = new Map();
  for (const n of B.byId.values()) if (n.url) { const k = normalizeUrl(n.url) || n.url; by.set(k, (by.get(k) || 0) + 1); }
  B.dupes = new Map([...by].filter(([, c]) => c > 1));
}
const bmvDupeCount = (n) => (n.url ? state.bmv.dupes.get(normalizeUrl(n.url) || n.url) || 0 : 0);
const bmvPath = (n) => { const out = []; for (let p = state.bmv.byId.get(n.parentId); p; p = state.bmv.byId.get(p.parentId)) out.unshift(p.title || t('untitled')); return out.join(' › '); };
const bmvMarksIn = (n) => (!n ? [] : n.url ? [n] : n.kids.flatMap((k) => bmvMarksIn(state.bmv.byId.get(k))));
// Notes on bookmarks that are no longer there (deleted in Chrome's own manager) go.
async function pruneBmNotes(B) {
  const gone = Object.keys(state.bmNotes || {}).filter((id) => !B.byId.has(id));
  if (gone.length) state.bmNotes = await putBmNotes(Object.fromEntries(gone.map((id) => [id, null])));
}
// After a change: the tree read again; what was open, picked and selected stays so (if it still is there).
async function reloadBookmarks() {
  const B = state.bmv;
  state.marks = null; // the search reads them again
  if (!B) return;
  const tree = await chrome.bookmarks.getTree();
  if (state.bmv !== B) return;
  bmvIndex(B, tree);
  for (const id of [...B.picked]) if (!B.byId.has(id)) B.picked.delete(id);
  drawBookmarks();
}
// A bookmark as an entry (what the menu, the big preview, a star and a snooze read), kept with its node.
function bmEntry(n) {
  const B = state.bmv;
  const preview = (B && B.previews[normalizeUrl(n.url)]) || null;
  if (!n.entry) n.entry = { kind: 'bmk', key: 'b' + n.id, url: n.url, node: n, item: { url: n.url, title: n.title, ts: n.dateAdded, session: null, fields: [[n.title, n.url]] } };
  n.entry.preview = preview;
  n.entry.info = [n.url, bmvPath(n), n.dateAdded ? t('bmvAdded', { time: fullTime(n.dateAdded) }) : ''].filter(Boolean);
  return n.entry;
}
// The rows shown, in order: each folder's contents while it is open; searching or filtering, the matches and the
// folders they are in.
function bmvRows() {
  const B = state.bmv, q = B.q.trim();
  const rows = [];
  if (!q && !B.filter) {
    const walk = (id, depth) => { const n = B.byId.get(id); rows.push({ n, depth }); if (!n.url && B.open.has(id)) n.kids.forEach((k) => walk(k, depth + 1)); };
    B.tops.forEach((id) => walk(id, 0));
    return rows;
  }
  const hit = new Set();
  for (const n of B.byId.values()) {
    if (n.top) continue;
    if (B.filter === 'dupes' && !bmvDupeCount(n)) continue;
    if (B.filter && !n.url) continue;
    const found = !q || (n.url ? matches(q, n.title, hostOf(n.url), n.url, bmNoteOf(n.id), { status: statusText('bookmarked', isStarred(n.url) && 'starred', bmNoteOf(n.id) && 'note') }) : matches(q, n.title));
    if (!found) continue;
    hit.add(n.id);
    for (let p = B.byId.get(n.parentId); p; p = B.byId.get(p.parentId)) hit.add(p.id);
  }
  const walk = (id, depth) => { if (!hit.has(id)) return; const n = B.byId.get(id); rows.push({ n, depth }); if (!n.url) n.kids.forEach((k) => walk(k, depth + 1)); };
  B.tops.forEach((id) => walk(id, 0));
  return rows;
}
// The search box's text (it waits for a pause in typing): its first bookmark found is selected.
function bmvFind(text) {
  const B = state.bmv;
  if (!B) return;
  B.q = text;
  B.curId = null;
  B.cur = 0;
  drawBookmarks();
  const first = B.rows.findIndex((r) => r.n.url);
  if ((B.q.trim() || B.filter) && first >= 0) bmvSelect(first);
}
function bmvFilter(kind) {
  const B = state.bmv;
  B.filter = B.filter === kind ? null : kind;
  bmvFind(B.find.value);
}
function drawBookmarks() {
  const B = state.bmv;
  if (!B) return;
  B.rows = bmvRows();
  const at = B.curId ? B.rows.findIndex((r) => r.n.id === B.curId) : -1;
  B.cur = at >= 0 ? at : Math.max(0, Math.min(B.cur, B.rows.length - 1));
  if (bmvIO) bmvIO.disconnect();
  bmvIO = new IntersectionObserver((seen) => { const ids = seen.filter((s) => s.isIntersecting).map((s) => s.target.dataset.bm); if (ids.length) loadBmvPreviews(ids); }, { root: B.body, rootMargin: '400px 0px' });
  B.tree.replaceChildren(...B.rows.map(bmvRow));
  const marks = [...B.byId.values()].filter((n) => n.url).length;
  B.count.textContent = String(marks);
  const searching = !!B.q.trim() || !!B.filter;
  const shown = searching ? B.rows.some((r) => r.n.url || !r.n.top) : marks > 0 || B.rows.length > B.tops.length;
  B.empty.textContent = t(searching ? 'bmvNoMatch' : 'bmvEmpty');
  B.empty.hidden = shown;
  B.sel.hidden = !B.picked.size;
  B.selN.textContent = t('bmvSelected', { count: B.picked.size });
  B.back.classList.toggle('picking', B.picked.size > 0);
  const dupes = [...B.byId.values()].filter((n) => bmvDupeCount(n)).length;
  B.dupesBtn.hidden = !dupes && B.filter !== 'dupes';
  B.dupesBtn.setAttribute('aria-pressed', String(B.filter === 'dupes'));
  B.dupesBtn.lastChild.textContent = t('bmvDupes', { count: dupes });
  const starsLeft = bmvStarsToImport();
  B.starsBtn.hidden = !starsLeft.length;
  B.starsBtn.lastChild.textContent = t('bmvImportStars', { count: starsLeft.length });
  B.starsBtn.title = t('bmvStarsTip');
  bmvSelect(B.cur, false);
  // the previews of the first rows at once; the others as they scroll into view
  loadBmvPreviews(B.rows.slice(0, BMV_EAGER).filter((r) => r.n.url).map((r) => r.n.id));
}
// Read the previews of these bookmarks (the ones not read yet) and put them in their rows.
async function loadBmvPreviews(ids) {
  const B = state.bmv;
  if (!B) return;
  B.asked = B.asked || new Set();
  const want = ids.map((id) => B.byId.get(id)).filter((n) => n && n.url && !B.asked.has(n.id));
  if (!want.length) return;
  want.forEach((n) => B.asked.add(n.id));
  const got = await getPreviews(want.map((n) => n.url)).catch(() => ({}));
  if (state.bmv !== B) return;
  Object.assign(B.previews, got);
  for (const n of want) {
    const p = got[normalizeUrl(n.url)];
    const row = document.getElementById('bmv-' + n.id);
    if (!p || !p.img || !row) continue;
    const img = row.querySelector('[data-testid="bmv-favicon"]');
    if (!img) continue;
    img.className = 'shot';
    img.dataset.testid = 'bmv-preview';
    img.src = p.img;
  }
}
function bmvRow({ n, depth }, i) {
  const B = state.bmv;
  const q = B.q.trim();
  const searching = !!q || !!B.filter;
  const open = !n.url && (searching || B.open.has(n.id));
  const picked = B.picked.has(n.id);
  const row = h('div', 'bmvrow ' + (n.url ? 'mark' : 'folder') + (!n.url && !open ? ' shut' : '') + (picked ? ' picked' : '') + (n.archive ? ' archive' : ''), null, n.url ? 'bmv-mark' : 'bmv-folder');
  row.id = 'bmv-' + n.id;
  row.dataset.bm = n.id;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));
  row.setAttribute('aria-selected', 'false');
  if (!n.fixed) row.setAttribute('aria-checked', String(picked));
  row.style.setProperty('--d', depth);
  const title = n.title || (n.url ? hostOf(n.url) : '') || t('untitled');
  const titleEl = h('span', 'bmvtitle', null, 'bmv-title');
  titleEl.append(q ? highlight(title, q) : title);
  const acts = h('div', 'bmvacts', null, 'bmv-actions');
  const act = (testid, icon, label, fn, cls = '') => {
    const b = h('button', 'qbtn' + cls, null, testid);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(svgOf(ICON[icon]));
    b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) { B.curId = n.id; bmvSelect(i, false); Promise.resolve(fn(b)).catch((err) => toast(t('bmvErr'), err)); } });
    return b;
  };
  const more = act('quick-more', 'more', t('cardMenu'), (b) => bmvMenu(n, { anchor: b }));
  more.setAttribute('aria-haspopup', 'menu');
  let pick = null;
  if (!n.fixed) {
    pick = h('button', 'bmvpick' + (picked ? ' on' : ''), null, 'bmv-pick');
    pick.type = 'button';
    pick.setAttribute('role', 'checkbox');
    pick.setAttribute('aria-checked', String(picked));
    pick.setAttribute('aria-label', t('bmvSelect'));
    pick.append(svgOf(ICON.check));
    pick.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) bmvPick(n.id, { range: e.shiftKey }); });
  }
  if (!n.url) {
    row.setAttribute('aria-expanded', String(open));
    const chev = h('span', 'bmvchev', null, 'bmv-chevron');
    chev.append(svgOf(ICON.chevron));
    const ic = h('span', 'bmvfold', null, 'bmv-folder-icon');
    ic.append(svgOf(ICON[n.archive ? 'archive' : 'folder']));
    row.append(...[chev, pick, ic].filter(Boolean), titleEl, h('span', 'tag', t('bmvItems', { count: n.kids.length }), 'bmv-count'));
    if (n.archive) row.append(h('span', 'tag snz', t('bmvArchiveTag'), 'bmv-archive-tag'));
    acts.append(act('bmv-add-here', 'plus', t('bmvAddHere'), () => bmvEdit(null, { parentId: n.id })));
    if (!n.fixed) acts.append(act('bmv-rename', 'brush', t('bmvRename'), () => bmvEdit(n)), act('bmv-delete', 'trash', t('bmvDeleteFolder'), () => bmvDelete([n]), ' del'));
    acts.append(more);
    row.append(acts);
    row.title = n.archive ? title + '\n' + t('bmvArchiveTip') : title;
  } else {
    const entry = bmEntry(n);
    const pic = h('div', 'bmvpic', null, 'bmv-picture');
    const img = h('img', entry.preview && entry.preview.img ? 'shot' : 'fav', null, entry.preview && entry.preview.img ? 'bmv-preview' : 'bmv-favicon');
    img.src = entry.preview && entry.preview.img ? entry.preview.img : favicon(n.url);
    img.alt = '';
    pic.append(img);
    const text = h('div', 'bmvtext', null, 'bmv-text');
    const tline = h('span', 'bmvtline', null, 'bmv-title-row');
    tline.append(titleEl);
    const dup = bmvDupeCount(n);
    if (dup) tline.append(h('span', 'tag', t('bmvDupeTag', { count: dup }), 'bmv-dupe'));
    const sub = h('span', 'bmvsub', null, 'bmv-address');
    const site = siteOf(n.url) || n.url;
    sub.append(q ? highlight(site, q) : site);
    if (searching) sub.append(h('span', 'bmvpath', ' · ' + bmvPath(n), 'bmv-path')); // where it is, the tree being cut down to the matches
    const note = bmNoteOf(n.id);
    const noteLine = h('span', 'bmvnote', null, 'bmv-note-text');
    noteLine.append(q && note ? highlight(note, q) : note);
    noteLine.hidden = !note;
    text.append(tline, sub, noteLine);
    const noteBtn = act('quick-note', 'note', t('noteAdd'), (b) => bmvNote(n, b), ' note');
    paintNote(noteBtn, note);
    noteBtn.addEventListener('mouseenter', () => noteTip(noteBtn));
    noteBtn.addEventListener('mouseleave', hideTipSoon);
    acts.append(noteBtn, act('quick-big', 'expand', t('historyBig'), () => openBig(bmEntry(n))), act('bmv-edit', 'brush', t('bmvEdit'), () => bmvEdit(n)),
      act('bmv-delete', 'trash', t('bmvDelete'), () => bmvDelete([n]), ' del'), more);
    row.append(pick, pic, text, acts);
    row.title = t('bmvOpenTip', { title }) + '\n' + entry.info.join('\n');
    if (i >= BMV_EAGER && bmvIO) bmvIO.observe(row);
  }
  mouseOnly(row);
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pointerAllowed()) return;
    B.curId = n.id;
    if ((e.ctrlKey || e.metaKey) && !n.fixed) return bmvPick(n.id);
    if (e.shiftKey && B.picked.size && !n.fixed) return bmvPick(n.id, { range: true });
    if (!n.url) return bmvToggle(n.id);
    if (e.shiftKey) { bmvSelect(i, false); return openBig(bmEntry(n)); }
    openPage(n.url);
  });
  onMiddleClick(row, () => { if (n.url) historyBehind(bmEntry(n).item).catch((err) => toast(t('actFailed'), err)); });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pointerAllowed()) return;
    B.curId = n.id;
    bmvSelect(i, false);
    bmvMenu(n, { at: { x: e.clientX, y: e.clientY } });
  });
  if (!n.fixed) bmvDrag(row, n);
  else if (!n.url) bmvDrop(row, n);
  return row;
}
// Drag rows to move them: onto a folder (its middle) puts them in it, above or below a row puts them beside it. The
// ticked rows go together when the one dragged is ticked. Undo puts them back.
function bmvDrag(row, n) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    const B = state.bmv;
    B.drag = B.picked.has(n.id) ? [...B.picked] : [n.id];
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', n.url || n.title); } catch {}
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => { row.classList.remove('dragging'); document.querySelectorAll('.bmvrow.drop-before, .bmvrow.drop-after, .bmvrow.drop-into').forEach((r) => r.classList.remove('drop-before', 'drop-after', 'drop-into')); if (state.bmv) state.bmv.drag = null; });
  bmvDrop(row, n);
}
function bmvDrop(row, n) {
  const where = (e) => {
    const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / (r.height || 1);
    if (!n.url && (n.fixed || (y > 0.25 && y < 0.75))) return 'into';
    return y < 0.5 ? 'before' : 'after';
  };
  const allowed = (pos) => {
    const B = state.bmv;
    if (!B || !B.drag) return false;
    const target = pos === 'into' ? n : B.byId.get(n.parentId);
    if (!target) return false;
    // never into itself or into a folder inside it
    for (let p = target; p; p = B.byId.get(p.parentId)) if (B.drag.includes(p.id)) return false;
    return !B.drag.includes(n.id);
  };
  row.addEventListener('dragover', (e) => {
    const pos = where(e);
    if (!allowed(pos)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.toggle('drop-into', pos === 'into');
    row.classList.toggle('drop-before', pos === 'before');
    row.classList.toggle('drop-after', pos === 'after');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-into'));
  row.addEventListener('drop', (e) => {
    const pos = where(e);
    row.classList.remove('drop-before', 'drop-after', 'drop-into');
    const B = state.bmv;
    if (!allowed(pos)) return;
    e.preventDefault();
    const ids = B.drag;
    B.drag = null;
    const parent = pos === 'into' ? n : B.byId.get(n.parentId);
    const index = pos === 'into' ? parent.kids.length : parent.kids.indexOf(n.id) + (pos === 'after' ? 1 : 0);
    if (pos === 'into') B.open.add(parent.id);
    bmvMove(ids.map((id) => B.byId.get(id)).filter(Boolean), parent.id, index).catch((err) => toast(t('bmvErr'), err));
  });
}
// Where each node is now (its folder, its place): what Undo of a move puts back.
const bmvPlace = (n) => { const p = state.bmv.byId.get(n.parentId); return { id: n.id, parentId: n.parentId, index: p ? p.kids.indexOf(n.id) : 0 }; };
// Put places back (in order, so each lands where it was).
async function bmvUnmove(places) {
  for (const p of [...places].sort((a, b) => a.index - b.index)) await chrome.bookmarks.move(p.id, { parentId: p.parentId, index: p.index }).catch(() => {});
  await reloadBookmarks();
}
// Move nodes into a folder at `index` (Chrome's meaning: as if put before the node now there), in their order.
async function bmvMove(nodes, parentId, index = null) {
  const B = state.bmv;
  nodes = nodes.filter((n) => n && !n.fixed);
  const ids = new Set(nodes.map((n) => n.id));
  nodes = nodes.filter((n) => { for (let p = B.byId.get(n.parentId); p; p = B.byId.get(p.parentId)) if (ids.has(p.id)) return false; return true; });
  if (!nodes.length) return;
  const places = nodes.map(bmvPlace);
  let at = index;
  for (const n of nodes) {
    if (at === null) await chrome.bookmarks.move(n.id, { parentId });
    else {
      const was = bmvPlace(n);
      await chrome.bookmarks.move(n.id, { parentId, index: at });
      // the next goes after it: one further on, unless this one was before `at` in the same folder (its place freed)
      if (!(was.parentId === parentId && was.index < at)) at++;
      await reloadBookmarks();
    }
  }
  B.curId = nodes[0].id;
  for (let p = B.byId.get(parentId); p; p = B.byId.get(p.parentId)) B.open.add(p.id);
  await reloadBookmarks();
  bmvRemember();
  toast(t('bmvMoved', { count: nodes.length }), null, { label: t('undo'), fn: () => bmvUnmove(places) });
}
// "Move to…": the picked rows into the folder chosen in a dialog.
async function bmvMoveDialog(nodes) {
  const B = state.bmv;
  nodes = nodes.filter((n) => n && !n.fixed);
  if (!nodes.length) return;
  const tree = await chrome.bookmarks.getTree();
  const inside = (id) => { for (let p = B.byId.get(id); p; p = B.byId.get(p.parentId)) if (nodes.some((n) => n.id === p.id)) return true; return false; };
  const folders = markFolders(tree).filter((f) => !inside(f.id));
  const box = h('form', 'bmform', null, 'bmv-move-form');
  const h3 = h('h3', '', t('bmvMoveTitle', { count: nodes.length }), 'dialog-title');
  h3.id = 'dlg-title';
  const sel = folderSelect(folders, B.byId.get(nodes[0].parentId) ? nodes[0].parentId : '', 'bmv-move-folder');
  const row = h('div', 'row', null, 'bmv-move-buttons');
  const ok = h('button', 'btn primary', t('bmvMoveSel'), 'bmv-move-save');
  ok.type = 'submit';
  row.append(h('span', 'grow', null, 'bmv-move-spacer'), button('bmv-move-cancel', t('cancel'), 'quiet', closeDialog), ok);
  box.append(h3, sel.label, sel.select, row);
  box.addEventListener('submit', (e) => { e.preventDefault(); if (!pointerAllowed()) return; closeDialog(); B.picked.clear(); bmvMove(nodes, sel.select.value).catch((err) => toast(t('bmvErr'), err)); });
  showDialog('bmedit', [box]);
  fancySelect(sel.select);
  ok.focus({ preventScroll: true });
}
// A select of folders (their paths): { label, select }.
function folderSelect(folders, value, testid) {
  const label = h('label', 'bmlabel', t('bmvFolder'), testid + '-label');
  const select = h('select', '', null, testid);
  select.id = 'f-' + testid;
  label.htmlFor = select.id;
  select.setAttribute('aria-label', t('bmvFolder'));
  for (const f of folders) { const o = h('option', '', f.path, testid + '-option'); o.value = f.id; select.append(o); }
  select.value = folders.some((f) => f.id === value) ? value : (folders.find((f) => f.other) || folders[0] || {}).id || '';
  return { label, select };
}
function bmvSelect(i, scroll = true) {
  const B = state.bmv;
  if (!B) return;
  const rows = [...B.tree.children];
  if (!rows.length) { B.find.removeAttribute('aria-activedescendant'); return; }
  B.cur = Math.max(0, Math.min(rows.length - 1, i));
  B.curId = B.rows[B.cur].n.id;
  rows.forEach((r, k) => r.setAttribute('aria-selected', String(k === B.cur)));
  B.tree.setAttribute('aria-activedescendant', rows[B.cur].id);
  B.find.setAttribute('aria-activedescendant', rows[B.cur].id);
  if (scroll) rows[B.cur].scrollIntoView({ block: 'nearest' });
  clearTimeout(B.saveTimer);
  B.saveTimer = setTimeout(() => { if (state.bmv === B && B.back.isConnected) bmvRemember(); }, 400);
}
// What comes back next time: the open folders and the selected row.
function bmvRemember() {
  const B = state.bmv;
  if (!B) return;
  updateView({ bmvOpen: [...B.open].slice(-500), bmvSel: B.curId || '' }).catch(() => {});
}
function bmvToggle(id, open = null) {
  const B = state.bmv;
  if (B.q.trim() || B.filter) return; // searching, every folder with a match is open
  const on = open === null ? !B.open.has(id) : open;
  if (on) B.open.add(id); else B.open.delete(id);
  B.curId = id;
  drawBookmarks();
  bmvRemember();
}
// "*": every folder beside the selected row opens (the ARIA tree's own key).
function bmvOpenSiblings() {
  const B = state.bmv;
  const r = B.rows[B.cur];
  if (!r || B.q.trim() || B.filter) return;
  const parent = B.byId.get(r.n.parentId);
  const sibs = parent ? parent.kids : B.tops;
  sibs.forEach((id) => { const s = B.byId.get(id); if (s && !s.url) B.open.add(id); });
  drawBookmarks();
  bmvRemember();
}
// Tick a row, or (`range`) every row from the last one ticked to it; the number is said out loud.
function bmvPick(id, { range = false } = {}) {
  const B = state.bmv;
  const n = B.byId.get(id);
  if (!n || n.fixed) return;
  const i = B.rows.findIndex((r) => r.n.id === id);
  const a = B.anchorId ? B.rows.findIndex((r) => r.n.id === B.anchorId) : -1;
  if (range && a >= 0 && i >= 0) {
    const [s, e] = a < i ? [a, i] : [i, a];
    for (let k = s; k <= e; k++) if (!B.rows[k].n.fixed) B.picked.add(B.rows[k].n.id);
  } else if (B.picked.has(id)) B.picked.delete(id);
  else B.picked.add(id);
  B.anchorId = id;
  B.curId = id;
  drawBookmarks();
  el.live.textContent = t('bmvSelected', { count: B.picked.size });
}
// The folder a new bookmark or folder goes into: the selected folder, or the selected bookmark's; else Other bookmarks.
function bmvHere() {
  const B = state.bmv;
  const r = B.rows[B.cur];
  if (r) return r.n.url ? r.n.parentId : r.n.id;
  return (B.tops.map((id) => B.byId.get(id)).find((n) => /other/i.test(n.title)) || {}).id || B.tops[1] || B.tops[0];
}
function closeBookmarks() {
  closePops();
  if (state.bmv) { clearTimeout(state.bmv.saveTimer); state.bmv.find.value = ''; state.bmv.q = ''; }
  bmvRemember();
  if (bmvIO) { bmvIO.disconnect(); bmvIO = null; }
  document.querySelectorAll('.bmv').forEach((n) => n.remove());
  state.bmv = null;
  updateInert();
  viewBack($('bookmarks-btn')).focus({ preventScroll: true });
}
// A bookmark's note: the note card, writing to the bookmark's own notes (not the page's).
function bmvNote(n, anchor) {
  notePopover(n.url, anchor, {
    label: t('bmvNoteTitle'), hint: t('bmvNoteHint'), get: () => bmNoteOf(n.id),
    set: async (text) => {
      state.bmNotes = await setBmNote(n.id, text, n.url);
      const row = document.getElementById('bmv-' + n.id);
      const line = row && row.querySelector('[data-testid="bmv-note-text"]');
      if (line) { line.textContent = bmNoteOf(n.id); line.hidden = !line.textContent; }
    },
  });
}
// What it takes to put deleted bookmarks back (Undo): each with its place, its note, and a folder's contents.
function bmvSnap(n) {
  const B = state.bmv;
  const parent = B.byId.get(n.parentId);
  const snap = (m, index) => ({ title: m.title, url: m.url, parentId: m.parentId, index, note: m.url ? bmNoteOf(m.id) : '', kids: m.url ? null : m.kids.map((k, i) => snap(B.byId.get(k), i)) });
  return snap(n, parent ? parent.kids.indexOf(n.id) : 0);
}
// Delete bookmarks and folders (a folder with all it holds). Ten bookmarks or more ask first. Undo makes them again,
// where they were, notes and all.
async function bmvDelete(nodes, { asked = false } = {}) {
  const B = state.bmv;
  if (!B) return;
  nodes = nodes.filter((n) => n && !n.fixed);
  const ids = new Set(nodes.map((n) => n.id));
  nodes = nodes.filter((n) => { for (let p = B.byId.get(n.parentId); p; p = B.byId.get(p.parentId)) if (ids.has(p.id)) return false; return true; }); // (inside a folder that goes too)
  if (!nodes.length) return;
  const marks = nodes.flatMap(bmvMarksIn);
  const one = nodes.length === 1 && !nodes[0].url;
  if (!asked && marks.length >= BMV_CONFIRM_DELETE) {
    return confirmDialog({
      title: one ? t('bmvDeleteFolderAsk', { name: nodes[0].title || t('untitled') }) : t('bmvDeleteAsk', { count: marks.length }),
      text: t('bmvDeleteAskText', { count: marks.length }), testid: 'bmv-delete-ask',
      actions: [{ label: t('bmvDelete'), cls: 'danger', testid: 'bmv-delete-ask-ok', err: t('bmvErr'), fn: () => bmvDelete(nodes, { asked: true }) }],
    });
  }
  const snaps = nodes.map(bmvSnap);
  const row = B.rows.findIndex((r) => ids.has(r.n.id));
  for (const n of nodes) await (n.url ? chrome.bookmarks.remove(n.id) : chrome.bookmarks.removeTree(n.id));
  if (marks.some((m) => bmNoteOf(m.id))) state.bmNotes = await putBmNotes(Object.fromEntries(marks.map((m) => [m.id, { n: '', u: m.url }])));
  nodes.forEach((n) => B.picked.delete(n.id));
  marks.forEach((m) => B.picked.delete(m.id));
  B.curId = null;
  B.cur = Math.max(0, row);
  await reloadBookmarks();
  toast(one ? t('bmvFolderDeleted', { name: nodes[0].title || t('untitled') }) : t('bmvDeleted', { count: marks.length }), null, { label: t('undo'), fn: async () => { await bmvRestore(snaps); await reloadBookmarks(); } });
}
async function bmvRestore(snaps) {
  const notes = {};
  const make = async (s, parentId, index) => {
    const made = await chrome.bookmarks.create({ parentId, index, title: s.title, ...(s.url ? { url: s.url } : {}) });
    if (s.url && s.note) notes[made.id] = { n: s.note, u: s.url };
    for (const [i, c] of (s.kids || []).entries()) await make(c, made.id, i);
  };
  for (const s of [...snaps].sort((a, b) => a.index - b.index)) await make(s, s.parentId, s.index);
  if (Object.keys(notes).length) state.bmNotes = await putBmNotes(notes);
}
// An address as typed ("example.com"): with https:// when it has no scheme; '' when it isn't one.
function webAddress(text) {
  let u = String(text || '').trim();
  if (!u) return '';
  if (!/^[a-z][\w+.-]*:/i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch { return ''; }
}
// Edit a bookmark (name, address, folder, note) or a folder (name, where it is); with no node, add one into
// `parentId` (a new bookmark starts as the page Tabazing was opened over, and says where that page is bookmarked
// already). The note at the bottom has Undo.
async function bmvEdit(n = null, { parentId = null, folder = false } = {}) {
  const B = state.bmv;
  if (!B || (n && n.fixed)) return;
  const isFolder = n ? !n.url : folder;
  const tree = await chrome.bookmarks.getTree();
  if (state.done || state.bmv !== B) return;
  const inside = (id) => { for (let p = B.byId.get(id); p; p = B.byId.get(p.parentId)) if (n && p.id === n.id) return true; return false; };
  const folders = markFolders(tree).filter((f) => !(n && !n.url && inside(f.id)));
  const form = h('form', 'bmform', null, 'bmv-edit-form');
  const h3 = h('h3', '', t(n ? (isFolder ? 'bmvRenameTitle' : 'bmvEditTitle') : (isFolder ? 'bmvFolderTitle' : 'bmvAddTitle')), 'dialog-title');
  h3.id = 'dlg-title';
  form.append(h3);
  const field = (testid, label, value, tag = 'input') => {
    const l = h('label', 'bmlabel', label, testid + '-label');
    const input = h(tag, 'bminput', null, testid);
    input.id = 'f-' + testid;
    l.htmlFor = input.id;
    input.value = value;
    input.maxLength = tag === 'textarea' ? LIMITS.NOTE_MAX : 2000;
    input.spellcheck = tag === 'textarea';
    form.append(l, input);
    return input;
  };
  const page = !n && !isFolder ? srcTab() : null;
  const usable = page && !isOwnUrl(urlOf(page)) && /^(https?|file|ftp):/i.test(urlOf(page));
  const name = field('bmv-edit-name', t('bmvName'), n ? n.title : usable ? page.title || '' : '');
  const url = isFolder ? null : field('bmv-edit-url', t('bmvUrl'), n ? n.url : usable ? urlOf(page) : '');
  if (url) url.type = 'url';
  const have = h('p', 'note', '', 'bmv-edit-have');
  have.hidden = true;
  if (url) form.append(have);
  const sel = folderSelect(folders, n ? n.parentId : parentId, 'bmv-edit-folder');
  form.append(sel.label, sel.select);
  const note = isFolder ? null : field('bmv-edit-note', t('bmvNoteTitle'), n ? bmNoteOf(n.id) : '', 'textarea');
  const err = h('p', 'perr', '', 'bmv-edit-error');
  err.hidden = true;
  const row = h('div', 'row', null, 'bmv-edit-buttons');
  const save = h('button', 'btn primary', t('bmvSave'), 'bmv-edit-save');
  save.type = 'submit';
  row.append(h('span', 'grow', null, 'bmv-edit-spacer'), button('bmv-edit-cancel', t('cancel'), 'quiet', closeDialog), save);
  form.append(err, row);
  // "Already bookmarked in …": the address's other bookmarks, as it is typed
  let haveTimer = null;
  const sayHave = async () => {
    const address = webAddress(url.value);
    const found = address ? (await chrome.bookmarks.search({ url: address }).catch(() => [])).filter((b) => !n || b.id !== n.id) : [];
    if (state.bmv !== B) return;
    const where = [...new Set(found.map((b) => { const p = B.byId.get(b.parentId); return p ? [bmvPath(p), p.title].filter(Boolean).join(' › ') : ''; }).filter(Boolean))];
    have.textContent = where.length ? t('markHave', { folders: where.join(', ') }) : '';
    have.hidden = !where.length;
  };
  if (url) { url.addEventListener('input', () => { clearTimeout(haveTimer); haveTimer = setTimeout(sayHave, 250); }); sayHave(); }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pointerAllowed()) return;
    const title = name.value.trim();
    const address = url ? (n && url.value.trim() === n.url ? n.url : webAddress(url.value)) : '';
    if (url && !address) { err.textContent = t('bmvBadUrl'); err.hidden = false; url.focus(); return; }
    if (isFolder && !title) { name.focus(); return; }
    save.disabled = true;
    try {
      const to = sel.select.value;
      let id, undo;
      if (n) {
        const before = { title: n.title, url: n.url, note: bmNoteOf(n.id), place: bmvPlace(n) };
        await chrome.bookmarks.update(n.id, isFolder ? { title } : { title, url: address });
        if (to && to !== n.parentId) await chrome.bookmarks.move(n.id, { parentId: to });
        id = n.id;
        undo = async () => {
          await chrome.bookmarks.update(id, isFolder ? { title: before.title } : { title: before.title, url: before.url });
          if (to !== before.place.parentId) await chrome.bookmarks.move(id, { parentId: before.place.parentId, index: before.place.index });
          if (note) state.bmNotes = await setBmNote(id, before.note, before.url);
          await reloadBookmarks();
        };
      } else {
        const made = await chrome.bookmarks.create({ parentId: to, title: title || (address ? siteOf(address) : ''), ...(isFolder ? {} : { url: address }) });
        id = made.id;
        undo = async () => { await (isFolder ? chrome.bookmarks.removeTree(id) : chrome.bookmarks.remove(id)).catch(() => {}); if (note) state.bmNotes = await setBmNote(id, '', address); await reloadBookmarks(); };
      }
      if (note) state.bmNotes = await setBmNote(id, note.value, address);
      B.curId = id;
      for (let p = B.byId.get(to); p; p = B.byId.get(p.parentId)) B.open.add(p.id); // where it went is shown
      if (B.q || B.filter) { B.q = ''; B.find.value = ''; B.filter = null; }
      closeDialog();
      await reloadBookmarks();
      bmvSelect(B.cur);
      bmvRemember();
      toast(t(n ? 'bmvSaved' : isFolder ? 'bmvFolderMade' : 'bmvMade'), null, { label: t('undo'), fn: undo });
    } catch (x) { save.disabled = false; toast(t('bmvErr'), x); }
  });
  showDialog('bmedit', [form]);
  fancySelect(sel.select);
  name.focus({ preventScroll: true });
  name.select();
}
// A folder's contents in order: by name (folders first, as Chrome sorts) or by when they were added (newest first).
async function bmvSort(n, by) {
  const B = state.bmv;
  const kids = n.kids.map((id) => B.byId.get(id));
  const before = kids.map(bmvPlace);
  const coll = new Intl.Collator(uiLang(), { sensitivity: 'base', numeric: true });
  const sorted = [...kids].sort(by === 'name'
    ? (a, b) => (!a.url !== !b.url ? (a.url ? 1 : -1) : coll.compare(a.title, b.title))
    : (a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
  for (const [i, k] of sorted.entries()) await chrome.bookmarks.move(k.id, { parentId: n.id, index: i });
  B.open.add(n.id);
  B.curId = n.id;
  await reloadBookmarks();
  toast(t('bmvSorted', { name: n.title || t('untitled') }), null, { label: t('undo'), fn: () => bmvUnmove(before) });
}
// Ctrl+↑ / Ctrl+↓: the selected row one place up or down in its folder.
async function bmvNudge(n, dir) {
  const B = state.bmv;
  if (!n || n.fixed) return;
  // the folder's order as Chrome has it now (a quick second press can come before the tree is drawn again)
  const [node] = await chrome.bookmarks.get(n.id);
  const kids = await chrome.bookmarks.getChildren(node.parentId);
  const i = kids.findIndex((k) => k.id === n.id), j = i + dir;
  if (i < 0 || j < 0 || j >= kids.length) return;
  await chrome.bookmarks.move(n.id, { parentId: node.parentId, index: dir > 0 ? j + 1 : j }); // (Chrome's index: before the node now there)
  B.curId = n.id;
  await reloadBookmarks();
}
// A bookmark's ⋯ (a right-click, Shift+F10): open it (here, a new window, behind), see it big, copy, star, its note,
// snooze, tick it, edit, delete. A folder's: add a bookmark or a folder in it, open all (here, in a new window, as a tab
// group), sort, tick it, rename, delete; the archive's folder: the Archive view.
function bmvMenu(n, { anchor = null, at = null } = {}) {
  const B = state.bmv;
  const row = document.getElementById('bmv-' + n.id);
  if (!B || !row) return;
  if (at) anchor = row;
  else if (!anchor) anchor = row.querySelector('[data-testid="quick-more"]') || row;
  const items = [];
  const pickItem = () => ({ icon: 'check', label: t(B.picked.has(n.id) ? 'bmvUnselect' : 'bmvSelect'), fn: () => bmvPick(n.id) });
  if (n.url) {
    const entry = bmEntry(n), c = entry.item;
    const noteBtn = row.querySelector('[data-testid="quick-note"]');
    items.push(
      { icon: 'goto', label: t('historyOpen'), fn: () => openPage(n.url) },
      { icon: 'window', label: t('historyNewWindow'), err: t('actFailed'), fn: () => reopenInWindow(c) },
      { icon: 'tab', label: t('historyBehind'), err: t('actFailed'), fn: () => historyBehind(c) },
      { icon: 'expand', label: t('historyBig'), fn: () => openBig(entry) },
      null,
      { icon: 'link', label: t('copyLink'), err: t('copyFailed'), fn: () => copyLinks([{ title: n.title, url: n.url }], 'plain') },
      { icon: 'star', label: t(isStarred(n.url) ? 'unstar' : 'star'), fn: () => star(entry) },
      { icon: 'note', label: t(bmNoteOf(n.id) ? 'noteEdit' : 'noteAdd'), fn: () => bmvNote(n, noteBtn || anchor) },
      { icon: 'clock', label: t('historySnooze'), err: t('errSnooze'), fn: () => snoozeMenu([], anchor, (when) => snoozeClosed(c, when)) },
      null,
      pickItem(),
      { icon: 'brush', label: t('bmvEdit'), err: t('bmvErr'), fn: () => bmvEdit(n) },
      { icon: 'trash', label: t('bmvDelete'), danger: true, err: t('bmvErr'), fn: () => bmvDelete([n]) },
    );
  } else {
    const marks = bmvMarksIn(n).filter((m) => openable(m.url));
    if (n.archive) items.push({ icon: 'archive', label: t('palOpenArchive'), err: t('errArchiveOpen'), fn: () => { closeBookmarks(); return openArchive(); } }, null);
    items.push({ icon: 'plus', label: t('bmvAddHere'), err: t('bmvErr'), fn: () => bmvEdit(null, { parentId: n.id }) },
      { icon: 'folder', label: t('bmvFolderHere'), err: t('bmvErr'), fn: () => bmvEdit(null, { parentId: n.id, folder: true }) });
    if (marks.length) items.push(null,
      { icon: 'tab', label: t('bmvOpenAll', { count: marks.length }), err: t('actFailed'), fn: () => bmvOpenAll(marks) },
      { icon: 'window', label: t('bmvOpenAllWindow'), err: t('actFailed'), fn: () => bmvOpenAll(marks, { where: 'window' }) },
      { icon: 'plus', label: t('bmvOpenAllGroup'), err: t('actFailed'), fn: () => bmvOpenAll(marks, { where: 'group', name: n.title }) });
    if (n.kids.length > 1) items.push(null,
      { icon: 'sort', label: t('bmvSortName'), err: t('bmvErr'), fn: () => bmvSort(n, 'name') },
      { icon: 'clock', label: t('bmvSortDate'), err: t('bmvErr'), fn: () => bmvSort(n, 'date') });
    if (!n.fixed) items.push(null, pickItem(), { icon: 'brush', label: t('bmvRename'), err: t('bmvErr'), fn: () => bmvEdit(n) },
      { icon: 'trash', label: t('bmvDeleteFolder'), danger: true, err: t('bmvErr'), fn: () => bmvDelete([n]) });
  }
  menu(anchor, items, { back: B.find, at });
}
// Open bookmarks: behind Tabazing, which stays (they join the open tabs), in a new window, or as a new tab group
// named after the folder. More than 15 at once asks first, and offers the other two ways.
async function bmvOpenAll(marks, { where = 'here', name = '', asked = false } = {}) {
  marks = marks.filter((m) => m && openable(m.url));
  if (!marks.length) return;
  if (!asked && marks.length > BMV_CONFIRM) {
    return confirmDialog({
      title: t('bmvOpenAsk', { count: marks.length }), text: t('bmvOpenAskText'), testid: 'bmv-open-ask',
      actions: [
        { label: t('bmvOpenAllWindow'), testid: 'bmv-open-ask-window', fn: () => bmvOpenAll(marks, { where: 'window', name, asked: true }) },
        { label: t('bmvOpenAllGroup'), testid: 'bmv-open-ask-group', fn: () => bmvOpenAll(marks, { where: 'group', name, asked: true }) },
        { label: t('bmvOpenAsk', { count: marks.length }), cls: 'primary', testid: 'bmv-open-ask-ok', fn: () => bmvOpenAll(marks, { where, name, asked: true }) },
      ],
    });
  }
  if (where === 'window') {
    await chrome.windows.create({ url: marks.map((m) => m.url), focused: false });
  } else {
    const ids = [];
    for (const m of marks) ids.push((await chrome.tabs.create({ url: m.url, windowId: CTX.srcWin, active: false })).id);
    if (where === 'group' && chrome.tabGroups) {
      const g = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: CTX.srcWin } });
      await chrome.tabGroups.update(g, { title: name || '' }).catch(() => {});
    }
  }
  if (state.bmv) { state.bmv.picked.clear(); drawBookmarks(); }
  toast(where === 'window' ? t('bmvOpenedWindow', { count: marks.length }) : t('openedN', { count: marks.length }));
  await reload();
}
// Stars are Tabazing's own (on this computer); bookmarks are Chrome's (they sync). "Bookmark stars": every starred page
// not bookmarked yet, into a "Tabazing stars" folder in Other bookmarks. Undo takes the folder out again.
function bmvStarsToImport() {
  const B = state.bmv;
  const have = new Set([...B.byId.values()].filter((n) => n.url).map((n) => normalizeUrl(n.url)));
  return Object.values(state.stars || {}).filter((s) => s && s.u && openable(s.u) && !have.has(normalizeUrl(s.u)));
}
async function bmvImportStars() {
  const B = state.bmv;
  const stars = bmvStarsToImport();
  if (!stars.length) return;
  const other = B.tops.map((id) => B.byId.get(id)).find((n) => /other/i.test(n.title)) || B.byId.get(B.tops[B.tops.length - 1]);
  const folder = await chrome.bookmarks.create({ parentId: other.id, title: t('bmvStarsFolder') });
  for (const s of stars) await chrome.bookmarks.create({ parentId: folder.id, title: s.ti || siteOf(s.u), url: s.u });
  B.open.add(other.id);
  B.open.add(folder.id);
  B.curId = folder.id;
  await reloadBookmarks();
  toast(t('bmvStarsDone', { count: stars.length }), null, { label: t('undo'), fn: async () => { await chrome.bookmarks.removeTree(folder.id).catch(() => {}); await reloadBookmarks(); } });
}
// While the bookmarks are open they have the keyboard (a menu, a small card or a dialog over them keeps its own). The
// search box types, except ↑ ↓ PgUp PgDn (Home / End and ← → while it is empty), Enter, Ctrl+Enter, Ctrl+Space,
// Ctrl+↑ ↓, Shift+F10 and Esc. Out of it, Space shows a bookmark big (opens a folder), Del deletes (the ticked rows, or
// the selected one), F2 edits, * opens every folder beside. Esc empties the box (or the filter), then unticks, then
// closes. Typing anywhere goes to the box.
function bmvKey(e) {
  const k = e.key, B = state.bmv;
  const target = e.target instanceof Element ? e.target : null;
  if (!B || (target && target.closest('.menu, .pop'))) return;
  if (MODIFIERS.has(k)) return;
  if (target && target.closest('.bmvtools button') && (k === 'Enter' || k === ' ')) return; // the bar's buttons press
  const inBox = target === B.find;
  const empty = !B.find.value;
  const C = e.ctrlKey || e.metaKey;
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (k === 'Escape') {
    stop();
    if (B.find.value || B.filter) { B.find.value = ''; B.filter = null; bmvFind(''); B.find.focus({ preventScroll: true }); return; }
    if (B.picked.size) { B.picked.clear(); drawBookmarks(); return; }
    return closeBookmarks();
  }
  const nav = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Enter'].includes(k) || ((k === 'Home' || k === 'End' || k === 'ArrowLeft' || k === 'ArrowRight') && (!inBox || empty))
    || (k === ' ' && C) || (k === 'F10' && e.shiftKey) || k === 'ContextMenu' || k === 'F2' || (C && k.toLowerCase() === 'a' && (!inBox || empty));
  if (inBox && !nav) return; // typing
  if (!inBox && k.length === 1 && k !== ' ' && k !== '*' && !C && !e.altKey) { B.find.focus({ preventScroll: true }); return; } // typing goes to the box
  stop();
  if (C && !e.shiftKey && !e.altKey && e.code === 'KeyZ') { if (!e.repeat) toastUndo(); return; }
  if (k === 'Enter') B.flushFind(); // typed just now: the search first, then what it found
  const r = B.rows[B.cur];
  if (C && (k === 'ArrowUp' || k === 'ArrowDown')) { if (r && !e.repeat) bmvNudge(r.n, k === 'ArrowDown' ? 1 : -1).catch((err) => toast(t('bmvErr'), err)); return; }
  if (k === 'ArrowDown' || k === 'ArrowUp') return bmvSelect(B.cur + (k === 'ArrowDown' ? 1 : -1));
  if (k === 'PageDown' || k === 'PageUp') return bmvSelect(B.cur + (k === 'PageDown' ? 10 : -10));
  if (k === 'Home') return bmvSelect(0);
  if (k === 'End') return bmvSelect(B.rows.length - 1);
  if (C && k.toLowerCase() === 'a') { B.rows.forEach((x) => { if (!x.n.fixed) B.picked.add(x.n.id); }); drawBookmarks(); el.live.textContent = t('bmvSelected', { count: B.picked.size }); return; }
  if (!r) return;
  if (k === 'ArrowRight' || k === 'ArrowLeft') {
    const n = r.n, open = !n.url && (B.q.trim() || B.filter || B.open.has(n.id));
    if (ahead(k) > 0) { if (!n.url && !open) return bmvToggle(n.id, true); if (!n.url && n.kids.length) return bmvSelect(B.cur + 1); return; }
    if (!n.url && open && !B.q.trim() && !B.filter) return bmvToggle(n.id, false);
    const up = B.rows.findIndex((x) => x.n.id === n.parentId);
    if (up >= 0) bmvSelect(up);
    return;
  }
  if (k === 'Enter') {
    if (!r.n.url) return bmvToggle(r.n.id);
    if (!keysAllowed()) return finish('cancel');
    if (C) return historyBehind(bmEntry(r.n).item).catch((err) => toast(t('actFailed'), err)); // Ctrl+Enter: behind, Tabazing stays
    return openPage(r.n.url);
  }
  if (k === ' ' && C) return bmvPick(r.n.id);
  if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) { if (!e.repeat) bmvMenu(r.n); return; }
  if (k === 'F2') return bmvEdit(r.n).catch((err) => toast(t('bmvErr'), err));
  if (inBox) return;
  if (k === ' ') return r.n.url ? openBig(bmEntry(r.n)) : bmvToggle(r.n.id);
  if (k === '*') return bmvOpenSiblings();
  if (k === 'Delete' || (IS_MAC && e.metaKey && k === 'Backspace')) {
    if (e.repeat) return;
    return bmvDelete(B.picked.size ? [...B.picked].map((id) => B.byId.get(id)) : [r.n]).catch((err) => toast(t('bmvErr'), err));
  }
}

// The quick buttons on a tab's card (shown on hover): the ones used most, pin,
// snooze, archive and the note, then ⋯ for everything else (its menu). Pin is the contextual fourth: a tab
// that plays sound already has its mute button in the header (the speaker), so a second one here would only
// repeat it, and a silent tab has nothing to mute.
function quickActions(entry) {
  const tab = entry.tab;
  const box = h('div', 'quick', null, 'card-quick-actions');
  const mk = (icon, title, fn, err) => {
    const b = h('button', 'qbtn', null, 'quick-' + icon);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(svgOf(ICON[icon]));
    b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) fn().catch((x) => toast(err, x)); });
    return b;
  };
  const pin = mk('pin', t(tab.pinned ? 'tabUnpin' : 'tabPin'), () => togglePin(tab), t('errPin'));
  const snooze = mk('clock', t('snoozeThis'), async () => snoozeMenu([tab], snooze), t('errSnooze'));
  const archive = mk('archive', t('tabArchiveTip'), () => archiveTabs([tab]), t('errArchive'));
  const more = mk('more', t('cardMenu'), async () => cardMenu(entry, { anchor: more }), t('actFailed'));
  more.setAttribute('aria-haspopup', 'menu');
  if (tab.pinned) pin.classList.add('on'); // on: like a note button with a note
  box.append(pin, snooze, archive, noteButton(entry), more); // ⋯ last: always in the same place
  return box;
}

// A recently closed card's quick buttons: its note (a closed tab keeps the note of its page) and ⋯ for its menu.
function closedQuick(entry) {
  const box = h('div', 'quick', null, 'card-quick-actions');
  if (entry.item.kind !== 'window') box.append(noteButton(entry));
  const more = h('button', 'qbtn', null, 'quick-more');
  more.type = 'button';
  more.title = t('cardMenu');
  more.setAttribute('aria-label', t('cardMenu'));
  more.setAttribute('aria-haspopup', 'menu');
  more.append(svgOf(ICON.more));
  more.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) cardMenu(entry, { anchor: more }); });
  box.append(more);
  return box;
}

// A card's menu: everything its buttons do and more (copy, reload, duplicate, sleep, mute...), plus ticking it.
// For the keyboard on the selected card (Shift+F10 or the menu key), for the mouse from its ⋯ button (`anchor`)
// or a right-click (`at`, the pointer). Each item calls the same function as its button. The focus goes back
// to the search box.
let menuKeyAt = 0; // when the key that opens it was last pressed
function cardMenu(entry = state.entries[state.sel], { anchor = null, at = null } = {}) {
  const i = state.entries.indexOf(entry);
  const card = i >= 0 ? cardAt(i) : null;
  if (!entry || !card) return;
  // From the keyboard (Shift+F10, the menu key): it drops down from the card's ⋯ button, as a click on it would open
  // it, or from the card's header when that button isn't shown; never from under the whole card.
  if (at) anchor = card; // (a right-click: it opens at the pointer)
  else if (!anchor) {
    const more = card.querySelector('[data-testid="quick-more"]');
    anchor = more && more.getClientRects().length ? more : card.querySelector('.head') || card;
  }
  const items = [];
  const starItem = () => ({ icon: 'star', label: t(isStarred(entry.url) ? 'unstar' : 'star'), fn: () => star(entry) });
  if (entry.kind === 'tab') {
    const tab = entry.tab;
    const note = card.querySelector('.qbtn.note'); // the note card opens at its button, which shows the note too
    items.push({ icon: 'check', label: t(state.picked.has(tab.id) ? 'menuUnselect' : 'menuSelect'), fn: () => pick(entry) }, starItem(), null);
    items.push({ icon: 'link', label: t('copyLink'), err: t('copyFailed'), fn: () => copyLinks([tab], 'plain') });
    if (!entry.preview && canCapture(tab) && !state.pvPending.has(tab.id)) items.push({ icon: 'camera', label: t('capturePreview'), err: t('captureFailed'), fn: () => captureOne(entry) });
    // The menu is about this card's tab: its items say what they do, not to which tab ("Reload", not "Reload this tab").
    items.push({ icon: 'reload', label: t('tabReload'), err: t('errReload'), fn: () => reloadTab(tab) }, { icon: 'dupe', label: t('tabDuplicate'), err: t('errDuplicate'), fn: () => duplicateTab(tab) });
    if (!tab.active && !tab.discarded) items.push({ icon: 'moon', label: t(state.toSleep.has(tab.id) ? 'sleepUndo' : 'sleepThis'), err: t('errSleep'), fn: () => sleepTabs([tab]) });
    items.push(
      { icon: isMuted(tab) ? 'speaker' : 'muted', label: t(isMuted(tab) ? 'tabUnmute' : 'tabMute'), err: t('errMute'), fn: () => toggleMute(tab) },
      { icon: 'pin', label: t(tab.pinned ? 'tabUnpin' : 'tabPin'), err: t('errPin'), fn: () => togglePin(tab) },
      { icon: 'clock', label: t('snoozeThis'), err: t('errSnooze'), fn: () => snoozeMenu([tab], anchor || card) },
      { icon: 'archive', label: t('tabArchive'), err: t('errArchive'), fn: () => archiveTabs([tab]) },
    );
    if (note) items.push({ icon: 'note', label: t(noteOf(entry.url) ? 'noteEdit' : 'noteAdd'), fn: () => notePopover(entry.url, note) });
    items.push({ icon: 'plus', label: t('groupAddTo'), fn: () => groupMenu([tab], anchor || card) });
    if (tab.groupId >= 0 && state.groups.has(tab.groupId)) items.push({ icon: 'tab', label: t('groupRemoveFrom'), err: t('actFailed'), fn: () => ungroupTabs([tab]) });
    if (isWorthReopening(entry.url)) items.push({ icon: 'bookmark', label: t('markMenu'), err: t('markErr'), fn: () => bookmarkDialog([pageOf(tab)]) });
    items.push(null, { icon: 'close', label: t('tabClose'), danger: true, err: t('errClose'), fn: () => closeTab(entry) });
  } else if (entry.kind === 'group') {
    const tabs = entry.tabs, g = entry.group;
    const allMuted = tabs.every(isMuted);
    items.push(
      { icon: 'goto', label: t('groupOpen'), fn: () => enterGroup(g.id) },
      { icon: 'brush', label: t('groupEdit'), fn: () => editGroup(g, anchor || card) },
      null,
      { icon: 'link', label: t('actCopy'), err: t('copyFailed'), fn: () => copyLinks(tabs, 'plain') },
      { icon: 'bookmark', label: t('markMenu'), err: t('markErr'), fn: () => bookmarkDialog(tabs.filter((x) => isWorthReopening(urlOf(x))).map(pageOf), { folder: groupName(g) }) },
      { icon: 'window', label: t('groupToWindow'), err: t('errMove'), fn: () => groupToWindow(entry) },
      { icon: 'chevron', label: t(g.collapsed ? 'groupExpand' : 'groupCollapse'), err: t('actFailed'), fn: () => collapseGroup(g) },
      { icon: 'moon', label: t('actSleep'), err: t('errSleep'), fn: () => sleepTabs(tabs) },
      { icon: allMuted ? 'speaker' : 'muted', label: t(allMuted ? 'actUnmute' : 'actMute'), err: t('errMute'), fn: () => muteTabs(tabs) },
      { icon: 'clock', label: t('actSnooze'), err: t('errSnooze'), fn: () => snoozeMenu(tabs, anchor || card) },
      { icon: 'archive', label: t('actArchive'), err: t('errArchive'), fn: () => archiveTabs(tabs) },
      null,
      { icon: 'tab', label: t('groupUngroup'), err: t('actFailed'), fn: () => ungroup(entry) },
      { icon: 'close', label: t('groupClose'), danger: true, err: t('errClose'), fn: () => closeMany(tabs) },
    );
  } else if (entry.kind === 'closed') {
    const c = entry.item, win = c.kind === 'window';
    const note = card.querySelector('.qbtn.note');
    const pages = c.fields.map(([title, url]) => ({ title: title || '', url }));
    items.push({ icon: 'history', label: t(win ? 'closedReopenWindow' : 'closedReopen'), fn: () => restoreClosed(c) });
    if (!win) items.push({ icon: 'window', label: t('closedNewWindow'), err: t('actFailed'), fn: () => reopenInWindow(c) }, { icon: 'tab', label: t(c.session ? 'closedBackgroundFresh' : 'closedBackground'), err: t('actFailed'), fn: () => reopenBehind(c) }); // (behind Tabazing it opens afresh: Chrome's restore, with the history, would show it)
    items.push(null, { icon: 'link', label: t(win ? 'actCopy' : 'copyLink'), err: t('copyFailed'), fn: () => copyLinks(pages, 'plain') });
    if (!win) items.push(starItem());
    if (note) items.push({ icon: 'note', label: t(noteOf(c.url) ? 'noteEdit' : 'noteAdd'), fn: () => notePopover(c.url, note) });
    items.push({ icon: 'bookmark', label: t('markMenu'), err: t('markErr'), fn: () => bookmarkDialog(pages) });
    if (!win) items.push(
      { icon: 'clock', label: t('closedSnooze'), err: t('errSnooze'), fn: () => snoozeMenu([], anchor, (at) => snoozeClosed(c, at)) },
      { icon: 'archive', label: t('tabArchive'), err: t('errArchive'), fn: () => archiveClosed(c) },
    );
    items.push(null, { icon: 'close', label: t('closedRemove'), danger: true, fn: () => forgetClosed(entry) });
  } else {
    if (!(entry.item && entry.item.kind === 'window')) items.push(starItem());
    if (entry.kind === 'snoozed') items.push({ icon: 'close', label: t('cancelSnooze'), danger: true, fn: () => closeTab(entry) });
  }
  if (items.length) menu(anchor, items, { back: el.search, at });
}

// ---- a note on a tab (kept by its address, like stars). The button is accent-coloured while there is
// a note and hovering it shows the note; with no note it shows no tooltip at all (not even the card's).
const noteOf = (url) => ((url && state.notes[urlKey(url)]) || {}).n || '';
function paintNote(b, text) {
  b.classList.toggle('on', !!text);
  b.dataset.note = text; // shown by our own tooltip (noteTip), quicker than Chrome's and in Tabazing's style
  b.title = ''; // no Chrome tooltip here, not even the card's
  b.setAttribute('aria-label', text ? t('noteEdit') + ': ' + text : t('noteAdd'));
}
function noteButton(entry) {
  const b = h('button', 'qbtn note', null, 'quick-note');
  b.type = 'button';
  b.append(svgOf(ICON.note));
  paintNote(b, noteOf(entry.url));
  b.addEventListener('click', (e) => { e.stopPropagation(); hideTip(); if (pointerAllowed()) notePopover(entry.url, b); });
  b.addEventListener('mouseenter', () => noteTip(b));
  b.addEventListener('focus', () => { if (b.matches(':focus-visible')) noteTip(b); });
  b.addEventListener('mouseleave', hideTipSoon); // a moment to move onto the tooltip itself (it stays while hovered)
  b.addEventListener('blur', hideTip);
  return b;
}

// The note tooltip: shows 150 ms after the pointer reaches a note button that has a note (Chrome's
// own waits about half a second), below the button, or above it when there is no room. It stays while
// the pointer is on it (to read or select a long note), and Esc hides it.
const TIP_DELAY_MS = 150;
const DATE_TIP_DELAY_MS = 500; // the history's "last opened" tag: only when the pointer stays on it
let tipTimer = null;
let tipHide = null;
function noteTip(b) {
  if (document.querySelector('.notepop')) return;
  showTip(b, t('noteTitle'), b.dataset.note, 'note-tooltip');
}
// Our tooltip under (or over) `b`, a moment (`delay` ms) after the pointer reaches it: a heading and a text. It stays
// while the pointer is on it. `testid` names its parts (`testid`, -title, -text).
function showTip(b, title, text, testid, delay = TIP_DELAY_MS) {
  clearTimeout(tipTimer);
  clearTimeout(tipHide);
  if (!text) return;
  tipTimer = setTimeout(() => {
    if (!b.isConnected) return;
    hideTip();
    const tip = h('div', 'tip', null, testid);
    tip.setAttribute('role', 'tooltip');
    tip.append(h('span', 'tiph', title, testid + '-title'), h('span', 'tipt', text, testid + '-text'));
    tip.addEventListener('mouseenter', () => clearTimeout(tipHide));
    tip.addEventListener('mouseleave', hideTipSoon);
    el.app.append(tip);
    const r = b.getBoundingClientRect(), w = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    const below = r.bottom + 8 + th <= window.innerHeight - 8;
    tip.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - th - 8)) + 'px';
    tip.classList.add(below ? 'below' : 'above');
  }, delay);
}
function hideTip() {
  clearTimeout(tipTimer);
  clearTimeout(tipHide);
  document.querySelectorAll('.tip').forEach((x) => x.remove());
}
function hideTipSoon() {
  clearTimeout(tipTimer);
  clearTimeout(tipHide);
  tipHide = setTimeout(hideTip, TIP_DELAY_MS);
}
// Click the note button: a small card with a text box opens below it. Closing it (click elsewhere,
// Esc, or the button again) saves what is written; it is also saved while typing, because picking
// a tab closes Tabazing straight away. An empty box removes the note.
// `io`: whose note it is, for a bookmark's (kept by the bookmark: { get, set, label, hint }); else the page's (url).
function notePopover(url, anchor, io = null) {
  if (!io && !canKeep(url)) { closePops(); return toast(t('urlTooLong')); } // (what was written would be lost)
  const get = io ? io.get : () => noteOf(url);
  const put = io ? io.set : (text) => setNote(url, text).then((notes) => { state.notes = notes; });
  const label = io ? io.label : t('noteTitle');
  const open = document.querySelector('.notepop');
  closePops();
  if (open && open.anchor === anchor) return; // the same button again: just close it
  const pop = h('div', 'pop notepop', null, 'note-popover');
  pop.anchor = anchor;
  // × goes back to what had the focus: its note button (clicked), or the search box (the card's menu).
  const back = document.activeElement && document.activeElement !== document.body ? document.activeElement : el.search;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', label);
  const box = h('textarea', '', null, 'note-input');
  box.value = get();
  box.placeholder = t('notePh');
  box.maxLength = LIMITS.NOTE_MAX;
  box.setAttribute('aria-label', label);
  // Top right: "Clear" (red; removes the note, the card stays open to write a new one; shown while there is
  // text), then × (closes the card, keeping what was written).
  const clear = h('button', 'noteclear', t('noteClearBtn'), 'note-clear');
  clear.type = 'button';
  clear.title = t('noteClear');
  clear.hidden = !box.value;
  clear.addEventListener('click', (e) => { e.stopPropagation(); box.value = ''; clear.hidden = true; clearTimeout(timer); save(); box.focus(); });
  const x = h('button', 'noteclose', null, 'note-close');
  x.type = 'button';
  x.title = t('noteCloseBtn');
  x.setAttribute('aria-label', t('noteCloseBtn'));
  x.append(svgOf(ICON.close));
  x.addEventListener('click', (e) => { e.stopPropagation(); pop.close(); (back.isConnected ? back : el.search).focus({ preventScroll: true }); });
  const tools = h('div', 'notetools', null, 'note-tools');
  tools.append(clear, x);
  pop.append(h('label', '', label, 'note-label'), tools, box, h('p', 'pfine', io ? io.hint : t('noteHint'), 'note-hint'));
  const save = () => put(box.value).then(() => paintNote(anchor, get())).catch(() => {});
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
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target !== box) { e.preventDefault(); pop.close(); (back.isConnected ? back : el.search).focus({ preventScroll: true }); } });
  el.app.append(pop);
  dropFrom(pop, anchor.getBoundingClientRect());
  setTimeout(() => { document.addEventListener('mousedown', outside, true); box.focus(); box.setSelectionRange(box.value.length, box.value.length); }, 0);
}

// ---- big preview: Ctrl+click a card to see its screenshot large in the middle of the screen.
// The × in its corner, Esc, or a click on the dark area around it closes it; Enter opens that tab.
let bigEntry = null;
function openBig(entry) {
  if (entry && entry.kind === 'group') return openBigGroup(entry); // a tile: its tabs' pictures
  closePops();
  closeBig();
  hideTip();
  bigEntry = entry;
  const url = entry.url || (entry.tab ? urlOf(entry.tab) : entry.item.url);
  const title = (entry.tab ? entry.tab.title : entry.item.title) || hostOf(url) || t('untitled');
  const back = h('div', 'bigback', null, 'big-preview');
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  back.setAttribute('aria-label', t('bigTitle', { title }));
  const box = h('div', 'bigbox', null, 'big-preview-box');
  const head = h('div', 'bighead', null, 'big-preview-header');
  const fav = h('img', 'fav', null, 'big-preview-favicon');
  fav.src = favicon(url);
  fav.alt = '';
  head.append(fav, h('span', 'title', title, 'big-preview-title'), h('span', 'host', siteOf(url), 'big-preview-host'));
  const x = h('button', 'bigx', null, 'big-preview-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = t('bigClose') + ' (Esc)';
  x.setAttribute('aria-label', t('bigClose'));
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeBig(); });
  let shot;
  if (entry.preview && entry.preview.img) {
    // The card's small copy at once, then the sharp copy of the same capture as soon as it is read.
    shot = h('img', 'bigshot', null, 'big-preview-image');
    shot.src = entry.preview.img;
    shot.alt = t('bigTitle', { title });
    getSharpPreview(url).then((p) => {
      if (!p || !shot.isConnected) return;
      const sharp = new Image();
      sharp.onload = () => { if (shot.isConnected) shot.src = p.img; };
      sharp.src = p.img;
    }).catch(() => {});
  } else {
    shot = h('div', 'bignone', null, 'big-preview-none');
    const img = h('img', '', null, 'big-preview-none-favicon');
    img.src = favicon(url);
    img.alt = '';
    shot.append(img, h('span', '', t('noPreview'), 'big-preview-none-label'));
    // a page of the history or a bookmark: where it is, when, how often (nothing to capture there)
    if (entry.info) { const info = h('div', 'biginfo', null, 'big-preview-info'); for (const line of entry.info) info.append(h('span', '', line, 'big-preview-info-line')); shot.append(info); }
  }
  box.append(head, x, shot);
  box.addEventListener('click', (e) => e.stopPropagation());
  back.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeBig(); });
  back.append(box);
  el.app.append(back);
  updateInert();
  x.focus({ preventScroll: true });
}
function closeBig() {
  const open = document.querySelectorAll('.bigback');
  open.forEach((n) => n.remove());
  if (open.length) updateInert();
  if (bigEntry) { // the focus back where it was: the history, or the search box
    const was = bigEntry;
    bigEntry = null;
    (was.kind === 'hist' && state.hist && historyOpen() ? state.hist.find : was.kind === 'bmk' && state.bmv && bookmarksOpen() ? state.bmv.find : el.search).focus({ preventScroll: true });
  }
}

// While a dialog, Settings, the archive, a big preview or the command palette is open, the rest of the switcher is
// inert: Tab, clicks and screen readers stay in it. Not the toast (its Undo works over the archive), the live
// regions, or a select's list (a menu: Settings opens them over itself).
function updateInert() {
  const top = document.querySelector('#app > .bigback') || (!el.modal.hidden && el.modal) || (drawerOpen() && el.drawerBack) || document.querySelector('#app > .backv') || document.querySelector('#app > .setback')
    || document.querySelector('#app > .bmv') || document.querySelector('#app > .hist') || document.querySelector('#app > .arch') || (state.palette && el.palette);
  for (const n of el.app.children) n.toggleAttribute('inert', !!top && n !== top && n !== el.toast && !n.classList.contains('live') && !n.classList.contains('menu') && !n.classList.contains('pop'));
}

// Tab moves through the controls of the top layer (a big preview, a dialog, a menu, Settings, a card like a note,
// the archive, else the whole switcher) and wraps around at its ends: past the last one Chrome would move
// the focus out of the page, and losing the focus closes the switcher.
const TABBABLE = 'button, input, select, textarea, a[href], [tabindex]';
function tabbables(root) {
  return [...root.querySelectorAll(TABBABLE)].filter((n) => n.tabIndex >= 0 && !n.disabled && !n.closest('[hidden], [inert]') && (!n.checkVisibility || n.checkVisibility()));
}
function focusLayer() {
  return document.querySelector('#app > .bigback') || (!el.modal.hidden && el.modal) || (drawerOpen() && el.drawerBack) || document.querySelector('#app > .menu') || document.querySelector('#app > .backv')
    || document.querySelector('#app > .setback') || document.querySelector('#app > .pop') || (state.palette && el.palette) || document.querySelector('#app > .bmv') || document.querySelector('#app > .hist') || document.querySelector('#app > .arch') || el.app;
}
function keepFocusIn(e) {
  const root = focusLayer();
  const list = tabbables(root);
  const i = list.indexOf(document.activeElement);
  const next = !list.length ? null
    : !root.contains(document.activeElement) ? list[0] // the focus is outside the layer: into it
    : e.shiftKey && i === 0 ? list[list.length - 1]
    : !e.shiftKey && i === list.length - 1 ? list[0]
    : undefined; // in the middle: Chrome's own Tab
  if (next !== undefined) e.preventDefault();
  if (next) next.focus();
}

// Close the open menu or card (a note card saves itself as it closes; the ⓘ card gives the focus back to ⓘ).
function closePops() { document.querySelectorAll('.pop, .menu').forEach((x) => (x.close ? x.close() : x.remove())); }

// A small menu next to a button: [{ label, fn, danger, err }]; `err` is what the note says if `fn` fails.
// opts: { keepPops } leaves an open card open; { width, alignLeft } for a select's list; { at: {x, y} }
// opens it at that point (a right-click) instead of at the anchor.
// Items may be { on: true } (ticked: the current choice). ↑/↓ move; Esc, or choosing an item, closes it and
// gives the focus back to `opts.back` || `anchor` (for a card or its buttons, which take no focus: the search
// box), unless the item moves it on. opts.onClose runs however it closes.
// A menu or a small card opens at what opened it (`r`, its trigger's box), as a dropdown does: just below it, dropping
// down, its start edge on the trigger's start (`alignLeft`: a select, the pointer) or its end edge on the trigger's end
// (a button near the right). When it doesn't fit below and there is more room above, it opens just above instead,
// dropping up (.up, switcher.css: the reveal runs from that edge). `fit`: taller than the room on its side, it scrolls
// inside rather than run off the screen. Always inside the window, 8 px from its edges.
function dropFrom(node, r, { alignLeft = false, gap = 4, fit = false } = {}) {
  node.classList.remove('up');
  node.style.maxHeight = '';
  const w = node.offsetWidth, H = window.innerHeight;
  node.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, alignLeft ? r.left : r.right - w)) + 'px';
  const below = H - r.bottom - gap - 8, above = r.top - gap - 8;
  let ht = node.offsetHeight;
  const up = ht > below && above > below;
  const room = Math.max(0, up ? above : below);
  if (fit && ht > room) { node.style.maxHeight = room + 'px'; ht = room; }
  node.style.top = (up ? Math.max(8, r.top - gap - ht) : Math.max(8, Math.min(r.bottom + gap, H - 8 - ht))) + 'px';
  node.classList.toggle('up', up);
}

function menu(anchor, items, opts = {}) {
  // Its button again while it is open: just close it (a toggle).
  const open = [...document.querySelectorAll('.menu')].find((x) => x.anchor === anchor);
  if (opts.keepPops) document.querySelectorAll('.menu').forEach((x) => x.close()); else closePops();
  if (open && !opts.at) return; // (a right-click again opens it anew, at the pointer)
  const back = opts.back || (anchor.closest('.card') ? el.search : anchor);
  const m = h('div', 'menu', null, 'menu');
  m.anchor = anchor;
  m.setAttribute('role', 'menu');
  // A press outside closes it; on its own button the click that follows does (above), or it would reopen at once.
  const outside = (e) => { if (!m.contains(e.target) && !anchor.contains(e.target)) m.close(); };
  m.close = (refocus = false) => {
    if (!m.isConnected) return;
    m.remove();
    document.removeEventListener('mousedown', outside, true);
    if (opts.onClose) opts.onClose();
    if (refocus && back.isConnected) back.focus({ preventScroll: true });
  };
  for (const it of items) {
    if (!it) { m.append(h('hr', '', null, 'menu-separator')); continue; }
    const b = h('button', 'mi' + (it.danger ? ' danger' : '') + (it.on ? ' on' : '') + (it.icon ? ' iconed' : ''), it.icon ? null : it.label, 'menu-item');
    // `icon`: a name in ICON, drawn before the label (the label in its own span, so it takes the row's width).
    if (it.icon) b.append(h('span', 'mic', null, 'menu-item-icon'), h('span', 'mil', it.label, 'menu-item-label')), b.firstChild.append(svgOf(ICON[it.icon]));
    b.type = 'button';
    b.setAttribute('role', it.on !== undefined ? 'menuitemradio' : 'menuitem');
    if (it.on !== undefined) { b.setAttribute('aria-checked', String(!!it.on)); if (it.on) b.append(svgOf(ICON.check)); }
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!pointerAllowed()) return;
      m.close(true);
      try { await it.fn(); } catch (err) { toast(it.err || t('actFailed'), err); }
    });
    m.append(b);
  }
  m.addEventListener('click', (e) => e.stopPropagation());
  m.addEventListener('keydown', (e) => {
    const bs = [...m.querySelectorAll('.mi')];
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); bs[e.key === 'Home' ? 0 : bs.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); m.close(true); }
  });
  el.app.append(m);
  if (opts.width) m.style.width = opts.width + 'px';
  // At the pointer (a right-click): from that point, rightwards. Otherwise from its trigger, dropping down.
  if (opts.at) dropFrom(m, { left: opts.at.x, right: opts.at.x, top: opts.at.y, bottom: opts.at.y }, { alignLeft: true, gap: 2, fit: true });
  else dropFrom(m, anchor.getBoundingClientRect(), { alignLeft: !!opts.alignLeft, fit: true });
  setTimeout(() => { if (m.isConnected) document.addEventListener('mousedown', outside, true); }, 0);
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
  const b = h('button', 'fs', null, 'select-' + (sel.dataset.testid || 'button'));
  b.type = 'button';
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  const label = h('span', 'fsl', null, 'select-label');
  const chev = h('span', 'fsc', null, 'select-chevron');
  chev.append(svgOf(ICON.chevron));
  b.append(label, chev);
  const sync = () => {
    label.textContent = (sel.options[sel.selectedIndex] || {}).textContent || '';
    b.setAttribute('aria-label', (sel.getAttribute('aria-label') || '') + ': ' + label.textContent);
  };
  const open = () => {
    menu(b, [...sel.options].map((o) => ({
      label: o.textContent, on: o.value === sel.value,
      fn: () => { if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change')); } sync(); if (b.isConnected) b.focus({ preventScroll: true }); },
    })), { keepPops: inPop, alignLeft: true, width: Math.max(b.offsetWidth, 190), onClose: () => b.setAttribute('aria-expanded', 'false') });
    b.setAttribute('aria-expanded', String([...document.querySelectorAll('.menu')].some((x) => x.anchor === b)));
  };
  b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) open(); });
  b.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
  sel.after(b);
  sync();
  sel._fancy = { sync, button: b };
  return sel._fancy;
}

// ---------------------------------------------------------------- the command palette
// Alt+R from any page (background.js: the 'open-palette' command), or inside Tabazing '>' as the
// first character in the search box, or Ctrl+K (⌘K). A panel at the top centre (html.palette-open: the rest is
// dimmed and inert) with one box and one list, mixing a quick answer (utils/quick.js: sums, conversions,
// colours, time zones, dates), actions (Chrome's and Tabazing's, matched like the search: searchScore on
// their titles and keywords, in this language and in English) and the very results the search dropdown shows
// for the same text (ddRows / ddRowEl). ↑/↓ move, Enter runs, Shift+Enter runs and stays in the palette, Esc
// goes back to the switcher (or closes Tabazing when the palette was opened straight from the shortcut).
//
// What an action does afterwards (`after`): 'close' gives the page back (it acts on the page or Chrome: reload,
// zoom, media...), 'switcher' shows the switcher (its result, and the Undo of closing tabs, are there), 'stay'
// keeps the palette (copying: the note says it worked). `ui`: it opens something of Tabazing's (Settings, the
// archive...), so the palette goes first. A failure keeps the palette, with a note saying so.
const PAL_SOURCES = {
  chrome: { icon: 'globe', label: 'palSrcChrome' },
  tab: { icon: 'tab', label: 'palSrcTab' },
  tabazing: { icon: 'bolt', label: 'palSrcTabazing' },
  quick: { icon: 'calc', label: 'palSrcQuick' },
};
const PAL_TYPED_MAX = 8; // actions shown while typing (the search results and the quick answer come with them)
const PAL_USEFUL = ['new-tab', 'new-window', 'incognito', 'reopen', 'dupes', 'settings']; // first with nothing typed
// Chrome's own zoom steps (its menu's − and +).
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
let srcTabInfo = null; // the tab Tabazing was opened over, read when the palette opens before the tabs are
const srcTab = () => state.tabs.find((x) => x.id === CTX.srcTab) || srcTabInfo;
const srcEntry = (tab) => state.entries.find((e) => e.kind === 'tab' && e.tab.id === tab.id) || { kind: 'tab', key: 't' + tab.id, tab };
const tabName = (tab) => tab.title || siteOf(urlOf(tab)) || t('untitled');
const isWeb = (tab) => /^(https?|file):/i.test(urlOf(tab));
// Tabs not looked at for a week (Chrome's tab.lastAccessed), that can sleep: "Sleep tabs not used for a week".
const staleTabs = () => state.tabs.filter((x) => !x.active && !x.discarded && x.lastAccessed > 0 && Date.now() - x.lastAccessed >= 7 * DAY_MS && !state.toSleep.has(x.id));
const otherTabs = () => state.tabs.filter((x) => x.windowId === CTX.srcWin && x.id !== CTX.srcTab && !x.pinned);
const chromePage = (url) => () => openPage(url);
const isFullscreen = () => CTX.srcState === 'fullscreen'; // the window Tabazing was opened from, as it opened

// Every action. `title` and `kw` (words it is also found by) are messages; `when`: offered only then;
// `sub`: a second line (which tab, which page). Each one calls the function its button or menu item calls.
const PAL_ACTIONS = [
  // Chrome
  { id: 'new-tab', group: 'chrome', icon: 'plus', after: 'close', title: () => t('newTab'), kw: () => t('palKwNewTab'), run: () => openNewTab({ group: state.inGroup }) }, // (in the group view: into it, as the header's)
  { id: 'new-window', group: 'chrome', icon: 'window', after: 'close', title: () => t('palNewWindow'), kw: () => t('palKwNewWindow'),
    run: async () => { await chrome.windows.create({ focused: true }); finish('switch'); } },
  { id: 'incognito', group: 'chrome', icon: 'incognito', after: 'close', title: () => t('palIncognito'), kw: () => t('palKwIncognito'), err: () => t('palErrIncognito'),
    run: async () => { await chrome.windows.create({ incognito: true, focused: true }); finish('switch'); } },
  { id: 'reopen', group: 'chrome', icon: 'history', after: 'close', title: () => t('palReopen'), kw: () => t('palKwReopen'), err: () => t('palErrReopen'),
    run: async () => {
      if (CTX.mode === 'window') await chrome.windows.update(CTX.srcWin, { focused: true }).catch(() => {});
      await chrome.sessions.restore(); // the most recently closed tab or window, with its history
      finish('restore');
    } },
  { id: 'chrome-settings', group: 'chrome', icon: 'gear', after: 'close', title: () => t('palChromeSettings'), kw: () => t('palKwChromeSettings'), sub: () => 'chrome://settings', run: chromePage('chrome://settings') },
  { id: 'ext-page', group: 'chrome', icon: 'puzzle', after: 'close', title: () => t('palExtPage'), kw: () => t('palKwExtPage'), sub: () => 'chrome://extensions/?id=' + chrome.runtime.id,
    run: () => openPage('chrome://extensions/?id=' + chrome.runtime.id) },
  { id: 'extensions', group: 'chrome', icon: 'puzzle', after: 'close', title: () => t('palExtensions'), kw: () => t('palKwExtensions'), sub: () => 'chrome://extensions', run: chromePage('chrome://extensions') },
  { id: 'chrome-shortcuts', group: 'chrome', icon: 'keyboard', after: 'close', title: () => t('palChromeShortcuts'), kw: () => t('palKwChromeShortcuts'), sub: () => 'chrome://extensions/shortcuts', run: chromePage('chrome://extensions/shortcuts') },
  { id: 'history', group: 'chrome', icon: 'visited', after: 'close', title: () => t('palHistory'), kw: () => t('palKwHistory'), sub: () => 'chrome://history', run: chromePage('chrome://history') },
  { id: 'downloads', group: 'chrome', icon: 'download', after: 'close', title: () => t('palDownloads'), kw: () => t('palKwDownloads'), sub: () => 'chrome://downloads', run: chromePage('chrome://downloads') },
  { id: 'bookmarks', group: 'chrome', icon: 'bookmark', after: 'close', title: () => t('palBookmarks'), kw: () => t('palKwBookmarks'), sub: () => 'chrome://bookmarks', run: chromePage('chrome://bookmarks') },
  { id: 'clear-data', group: 'chrome', icon: 'eraser', after: 'close', title: () => t('palClearData'), kw: () => t('palKwClearData'), sub: () => 'chrome://settings/clearBrowserData', run: chromePage('chrome://settings/clearBrowserData') },
  { id: 'passwords', group: 'chrome', icon: 'key', after: 'close', title: () => t('palPasswords'), kw: () => t('palKwPasswords'), sub: () => 'chrome://password-manager/passwords', run: chromePage('chrome://password-manager/passwords') },
  // The tab Tabazing was opened over
  { id: 'reload', group: 'tab', icon: 'reload', after: 'close', tab: true, title: () => t('reloadThis'), kw: () => t('palKwReload'), err: () => t('errReload'), run: (tab) => reloadTab(tab) },
  { id: 'duplicate', group: 'tab', icon: 'dupe', after: 'switcher', tab: true, title: () => t('duplicateThis'), kw: () => t('palKwDuplicate'), err: () => t('errDuplicate'), run: (tab) => duplicateTab(tab) },
  { id: 'pin', group: 'tab', icon: 'pin', after: 'switcher', tab: true, title: () => t(srcTab().pinned ? 'unpinThis' : 'pinThis'), kw: () => t('palKwPin'), err: () => t('errPin'), run: (tab) => togglePin(tab) },
  { id: 'mute', group: 'tab', icon: 'muted', after: 'switcher', tab: true, title: () => t(isMuted(srcTab()) ? 'unmuteThis' : 'muteThis'), kw: () => t('palKwMute'), err: () => t('errMute'),
    run: async (tab) => { const mute = !isMuted(tab); await toggleMute(tab); toast(t(mute ? 'mutedN' : 'unmutedN', { count: 1 })); } },
  { id: 'close-tab', group: 'tab', icon: 'close', after: 'switcher', tab: true, title: () => t('closeTab'), kw: () => t('palKwCloseTab'), err: () => t('errClose'), run: (tab) => closeTab(srcEntry(tab)) },
  { id: 'close-others', group: 'tab', icon: 'close', after: 'switcher', tab: true, when: () => otherTabs().length > 0, title: () => t('palCloseOthers'), kw: () => t('palKwCloseOthers'),
    sub: () => t('tabs', { count: otherTabs().length }), err: () => t('errClose'), run: () => closeMany(otherTabs()) },
  { id: 'move-window', group: 'tab', icon: 'window', after: 'switcher', tab: true, title: () => t('palMoveWindow'), kw: () => t('palKwMoveWindow'), err: () => t('errMove'), run: (tab) => moveToWindow([tab]) },
  { id: 'zoom-in', group: 'tab', icon: 'zoomIn', after: 'close', tab: true, title: () => t('palZoomIn'), kw: () => t('palKwZoom'), err: () => t('palErrZoom'), run: (tab) => zoomTab(tab, 1) },
  { id: 'zoom-out', group: 'tab', icon: 'zoomOut', after: 'close', tab: true, title: () => t('palZoomOut'), kw: () => t('palKwZoom'), err: () => t('palErrZoom'), run: (tab) => zoomTab(tab, -1) },
  { id: 'zoom-reset', group: 'tab', icon: 'zoom', after: 'close', tab: true, title: () => t('palZoomReset'), kw: () => t('palKwZoom'), err: () => t('palErrZoom'), run: (tab) => zoomTab(tab, 0) },
  { id: 'fullscreen', group: 'tab', icon: 'expand', after: 'close', tab: true, title: () => t(isFullscreen() ? 'palFullscreenOff' : 'palFullscreenOn'), kw: () => t('palKwFullscreen'), err: () => t('palErrFullscreen'), run: toggleFullscreen },
  { id: 'copy-link', group: 'tab', icon: 'link', after: 'stay', tab: true, title: () => t('copyLink'), kw: () => t('palKwCopyLink'), err: () => t('copyFailed'), run: (tab) => copyLinks([tab], 'plain') },
  { id: 'copy-md', group: 'tab', icon: 'md', after: 'stay', tab: true, title: () => t('palCopyMd'), kw: () => t('palKwCopyMd'), err: () => t('copyFailed'), run: (tab) => copyLinks([tab], 'md') },
  { id: 'bookmark', group: 'tab', icon: 'bookmark', ui: true, tab: true, when: () => isWeb(srcTab()), title: () => t('palBookmarkThis'), kw: () => t('palKwBookmark'), err: () => t('palErrBookmark'), run: (tab) => bookmarkDialog([pageOf(tab)]) },
  // Tabazing
  { id: 'dupes', group: 'tabazing', icon: 'dupe', after: 'switcher', when: () => duplicates().length > 0, title: () => t('palDupes'), kw: () => t('palKwDupes'), sub: () => t('dupesBtn', { count: duplicates().length }), err: () => t('errClose'), run: () => closeDupes() },
  { id: 'merge', group: 'tabazing', icon: 'merge', after: 'switcher', when: () => state.otherWindows.length > 0, title: () => t('mergeAll'), kw: () => t('palKwMerge'), sub: () => t('mergeN', { count: state.otherWindows.length }), err: () => t('errMerge'), run: () => mergeWindows(state.otherWindows) },
  { id: 'sleep-old', group: 'tabazing', icon: 'moon', after: 'switcher', when: () => staleTabs().length > 0, title: () => t('palSleepOld'), kw: () => t('palKwSleepOld'), sub: () => t('tabs', { count: staleTabs().length }), err: () => t('errSleep'), run: () => sleepTabs(staleTabs()) },
  { id: 'snooze', group: 'tabazing', icon: 'clock', ui: true, tab: true, when: () => isWorthReopening(urlOf(srcTab())), title: () => t('palSnooze'), kw: () => t('palKwSnooze'), err: () => t('errSnooze'),
    run: (tab) => { const i = state.entries.findIndex((e) => e.kind === 'tab' && e.tab.id === tab.id); snoozeMenu([tab], (i >= 0 && cardAt(i)) || el.search); } },
  { id: 'archive', group: 'tabazing', icon: 'archive', after: 'switcher', tab: true, when: () => isWorthReopening(urlOf(srcTab())), title: () => t('palArchive'), kw: () => t('palKwArchive'), err: () => t('errArchive'), run: (tab) => archiveTabs([tab]) },
  { id: 'leave-group', group: 'tabazing', icon: 'back', after: 'switcher', when: () => state.inGroup !== null, title: () => t('palLeaveGroup'), kw: () => t('palKwLeaveGroup'),
    sub: () => groupName(state.groups.get(state.inGroup)), run: () => leaveGroup() },
  { id: 'open-group', group: 'tabazing', icon: 'goto', ui: true, when: () => pref('showGroups') && !!srcGroup() && state.inGroup !== srcGroup().id, title: () => t('palOpenGroup'), kw: () => t('palKwGroup'),
    sub: () => groupName(srcGroup()), run: () => enterGroup(srcGroup().id) },
  { id: 'group-tab', group: 'tab', icon: 'plus', ui: true, tab: true, title: () => t('palAddToGroup'), kw: () => t('palKwGroup'), run: (tab) => groupMenu([tab], el.search) },
  { id: 'ungroup-tab', group: 'tab', icon: 'tab', after: 'switcher', tab: true, when: () => !!srcGroup(), title: () => t('palRemoveFromGroup'), kw: () => t('palKwGroup'), err: () => t('actFailed'), run: (tab) => ungroupTabs([tab]) },
  { id: 'ungroup-group', group: 'tabazing', icon: 'tab', after: 'switcher', when: () => !!srcGroup(), title: () => t('palUngroup'), kw: () => t('palKwGroup'),
    sub: () => groupName(srcGroup()), err: () => t('actFailed'), run: () => ungroup(groupEntry(srcGroup())) },
  { id: 'close-group', group: 'tabazing', icon: 'close', after: 'switcher', when: () => !!srcGroup(), title: () => t('palCloseGroup'), kw: () => t('palKwGroup'),
    sub: () => groupName(srcGroup()), err: () => t('errClose'), run: () => closeMany(groupEntry(srcGroup()).tabs) },
  { id: 'open-archive', group: 'tabazing', icon: 'archive', ui: true, title: () => t('palOpenArchive'), kw: () => t('palKwOpenArchive'), err: () => t('errArchiveOpen'), run: () => openArchive() },
  { id: 'open-history', group: 'tabazing', icon: 'history', ui: true, when: () => !!chrome.history, title: () => t('palOpenHistory'), kw: () => t('palKwOpenHistory'), sub: () => (IS_MAC ? '⌘Y' : 'Ctrl+H'), err: () => t('actFailed'), run: () => openHistory() },
  { id: 'open-bookmarks', group: 'tabazing', icon: 'bookmark', ui: true, when: () => !!chrome.bookmarks, title: () => t('palOpenBookmarks'), kw: () => t('palKwOpenBookmarks'), sub: () => (IS_MAC ? '⌘⌥B' : 'Ctrl+Shift+O'), err: () => t('bmvErr'), run: () => openBookmarks() },
  { id: 'settings', group: 'tabazing', icon: 'gear', ui: true, title: () => t('palSettings'), kw: () => t('palKwSettings'), run: () => openSettings(el.menuBtn) },
  { id: 'keys', group: 'tabazing', icon: 'keyboard', ui: true, title: () => t('keysTitle'), kw: () => t('palKwKeys'), run: () => openShortcuts() },
  { id: 'theme-dark', group: 'tabazing', icon: 'moon', after: 'switcher', when: () => pref('theme') !== 'dark', title: () => t('palThemeDark'), kw: () => t('palKwTheme'), run: () => setTheme('dark') },
  { id: 'theme-light', group: 'tabazing', icon: 'sun', after: 'switcher', when: () => pref('theme') !== 'light', title: () => t('palThemeLight'), kw: () => t('palKwTheme'), run: () => setTheme('light') },
  { id: 'theme-system', group: 'tabazing', icon: 'sun', after: 'switcher', when: () => pref('theme') !== 'system', title: () => t('palThemeSystem'), kw: () => t('palKwTheme'), run: () => setTheme('system') },
  { id: 'sort-recent', group: 'tabazing', icon: 'sort', after: 'switcher', when: () => state.sort !== 'recent', title: () => t('palSortRecent'), kw: () => t('palKwSort'), run: () => setSort('recent') },
  { id: 'sort-order', group: 'tabazing', icon: 'sort', after: 'switcher', when: () => state.sort !== 'order', title: () => t('palSortOrder'), kw: () => t('palKwSort'), run: () => setSort('order') },
  { id: 'sort-name', group: 'tabazing', icon: 'sort', after: 'switcher', when: () => state.sort !== 'name', title: () => t('palSortName'), kw: () => t('palKwSort'), run: () => setSort('name') },
  { id: 'capture-all', group: 'tabazing', icon: 'camera', after: 'switcher', when: () => state.hostOk && missingPreviews().length > 0, title: () => t('palCaptureAll'), kw: () => t('palKwCapture'),
    sub: () => t('tabs', { count: missingPreviews().length }), err: () => t('errCapture'), run: () => captureAll() },
  { id: 'tour', group: 'tabazing', icon: 'bolt', ui: true, title: () => t('setTour'), kw: () => t('palKwTour'), run: () => tourStep(0) },
  { id: 'media-toggle', group: 'tabazing', icon: 'play', after: 'close', when: () => !!currentMedia(), title: () => t(currentMedia().playing ? 'palMediaPause' : 'palMediaPlay'), kw: () => t('palKwMedia'),
    sub: () => [currentMedia().title, currentMedia().site].filter(Boolean).join(' · '), err: () => t('mediaFailed'), run: () => playerDo('toggle') },
  { id: 'media-next', group: 'tabazing', icon: 'next', after: 'close', when: () => !!currentMedia() && currentMedia().canNext, title: () => t('palMediaNext'), kw: () => t('palKwMedia'),
    sub: () => currentMedia().title, err: () => t('mediaFailed'), run: () => playerDo('nexttrack') },
  { id: 'media-prev', group: 'tabazing', icon: 'prev', after: 'close', when: () => !!currentMedia() && currentMedia().canPrev, title: () => t('palMediaPrev'), kw: () => t('palKwMedia'),
    sub: () => currentMedia().title, err: () => t('mediaFailed'), run: () => playerDo('previoustrack') },
];
const PAL_BY_ID = new Map(PAL_ACTIONS.map((a) => [a.id, a]));
// The actions that can run now: one about the current tab needs that tab (it may still be loading).
const paletteActions = () => PAL_ACTIONS.filter((a) => (!a.tab || !!srcTab()) && (!a.when || a.when()));
// What an action is found by: its title and keywords in the interface language, and in English (so "new tab"
// finds it in every language). The words are scored like the search (searchScore, remembered per field).
function inEnglish(fn) {
  const cur = getLocale();
  if (cur === 'en') return fn();
  setLocale('en');
  try { return fn(); } finally { setLocale(cur); }
}
function actionFields(a) {
  const [title, kw] = [a.title(), a.kw()];
  return [title, kw, ...inEnglish(() => [a.title(), a.kw()])];
}
// Every row the palette shows for `text`, best first: the quick answer, then actions and search results by
// score (an action first when they score the same), then "Open …" / "Search Google for …" as the dropdown has
// them. With nothing typed: the most useful actions, the recently run ones, then all the rest.
function paletteItems(text) {
  const typed = String(text || '').trim();
  const q = typed.toLowerCase();
  const acts = paletteActions();
  if (!q) {
    const rank = (a) => { const u = PAL_USEFUL.indexOf(a.id); if (u >= 0) return u; const r = state.palRecent.indexOf(a.id); return r >= 0 ? 100 + r : 1000; };
    return acts.map((a, i) => ({ kind: 'action', a, recent: !PAL_USEFUL.includes(a.id) && state.palRecent.includes(a.id), i }))
      .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i);
  }
  const out = [];
  const res = quick(typed, { lang: uiLang() });
  if (res) out.push(res.kind === 'currency' ? { kind: 'currency' } : { kind: 'quick', res });
  const actions = acts.map((a) => ({ kind: 'action', a, s: searchScore(q, ...actionFields(a)) })).filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s).slice(0, PAL_TYPED_MAX);
  const rows = ddRows(typed);
  const scored = rows.filter((r) => r.kind && r.s > 0);
  const rest = rows.filter((r) => !(r.kind && r.s > 0)); // "Open …", "Search Google for …", and notes
  out.push(...[...actions, ...scored].sort((x, y) => y.s - x.s || (x.kind === 'action' ? 0 : 1) - (y.kind === 'action' ? 0 : 1)), ...rest);
  return out;
}

const PAL_ICON = (name, testid) => { const s = h('span', 'palico', null, testid); s.append(svgOf(ICON[name])); return s; };
// An action's row: its icon, title (with "Recent"), where it acts (the source icon), and which tab or page.
function paletteActionRow(it, ql, on, id) {
  const a = it.a;
  const row = h('div', 'ddr palr' + (on ? ' on' : ''), null, 'palette-row-action');
  row.id = id;
  row.dataset.action = a.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(on));
  const txt = h('span', 'ddtxt', null, 'dd-text');
  txt.append(ddTitleRow(a.title(), PAL_SOURCES[a.group], ql, 'palette-source-' + a.group, it.recent && h('span', 'ddtag', t('palRecent'), 'palette-recent-tag')));
  const sub = a.sub ? a.sub() : a.tab ? tabName(srcTab()) : '';
  if (sub) txt.append(hlSpan('ddsub', sub, ql));
  row.append(PAL_ICON(a.icon, 'palette-action-icon'), txt);
  return row;
}
// A quick answer: the result big (a colour's swatch beside it), what it is and the whole expression below,
// and a button that copies the whole expression (the keyboard has Shift+Enter for that).
function paletteQuickRow(res, on, id) {
  const row = h('div', 'ddr palr palq' + (on ? ' on' : ''), null, 'palette-row-quick');
  row.id = id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(on));
  let pic;
  if (res.swatch) { pic = h('span', 'palico palswatch', null, 'palette-swatch'); pic.style.background = res.swatch; }
  else pic = PAL_ICON('calc', 'palette-quick-icon');
  const value = res.kind === 'days' ? t('palDays', { count: res.count }) : res.value;
  const caption = res.kind === 'calc' ? t('palQCalc') : res.kind === 'unit' ? t('palQUnit') : res.kind === 'base' ? t('palQBase')
    : res.kind === 'color' ? t('palQColor') : res.kind === 'time' ? t('palQTime', { place: res.place }) : t('palQDate');
  const txt = h('span', 'ddtxt', null, 'dd-text');
  const big = h('span', 'ddtitle palval', value, 'palette-quick-value');
  const detail = [caption, res.expr, ...(res.alts || []), res.offset].filter(Boolean).join(' · ');
  txt.append(ddTitleRow(big, PAL_SOURCES.quick, '', 'palette-source-quick'), h('span', 'ddsub', detail, 'palette-quick-expr'));
  const copy = h('button', 'palcopy', null, 'palette-copy-expr');
  copy.type = 'button';
  copy.title = t('palCopyExpr') + ' (Shift+Enter)';
  copy.setAttribute('aria-label', t('palCopyExpr'));
  copy.append(svgOf(ICON.dupe));
  copy.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) copyQuick(res, true); });
  row.append(pic, txt, copy);
  mouseOnly(row); // an option holds no buttons for the keyboard: Shift+Enter does the same
  row.setAttribute('aria-description', t('palCopyHint'));
  return row;
}
function paletteCurrencyRow(on, id) {
  const row = h('div', 'ddr palr paloff' + (on ? ' on' : ''), null, 'palette-row-currency');
  row.id = id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(on));
  row.setAttribute('aria-disabled', 'true');
  const txt = h('span', 'ddtxt', null, 'dd-text');
  txt.append(h('span', 'ddtitle', t('palCurrency'), 'palette-currency-text'), h('span', 'ddsub', t('palCurrencyWhy'), 'palette-currency-why'));
  row.append(PAL_ICON('calc', 'palette-quick-icon'), txt);
  return row;
}

let palFrame = 0;
function renderPalette() {
  const p = state.palette;
  if (!p || state.done) return;
  cancelAnimationFrame(palFrame);
  palFrame = 0;
  const text = el.palInput.value;
  const ql = text.trim().toLowerCase();
  const rows = paletteItems(text);
  p.items = rows.filter((r) => r.kind);
  keepHighlight(p);
  if (p.hi >= p.items.length) p.hi = 0;
  let n = -1;
  // The pointer doesn't move the highlight (only ↑ / ↓ do), as in the search's results: a click runs the row.
  const nodes = rows.map((r) => {
    if (!r.kind) return h('div', 'ddnote', r.note, 'dd-notice');
    const i = ++n, on = i === p.hi, id = 'pal-' + i;
    const row = r.kind === 'action' ? paletteActionRow(r, ql, on, id) : r.kind === 'quick' ? paletteQuickRow(r.res, on, id)
      : r.kind === 'currency' ? paletteCurrencyRow(on, id) : ddRowEl(r, text.trim(), on, id);
    row.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) palRun(r, { shift: e.shiftKey }); });
    return row;
  });
  if (!p.items.length) nodes.push(h('p', 'palnone', t('palNothing'), 'palette-empty'));
  el.palList.replaceChildren(...nodes);
  const direct = p.from === 'shortcut'; // Esc closes Tabazing (else it goes back to the switcher)
  el.palFoot.textContent = t(direct ? 'palFootClose' : 'palFootBack');
  palHighlight();
}
// Move the highlight without building the list again; the box points screen readers at it.
function palHighlight(scroll = true) {
  const p = state.palette;
  if (!p) return;
  const rows = [...el.palList.querySelectorAll('.palr, .ddr')];
  rows.forEach((x, k) => { x.classList.toggle('on', k === p.hi); x.setAttribute('aria-selected', String(k === p.hi)); });
  const on = rows[p.hi];
  el.palInput.setAttribute('aria-expanded', String(rows.length > 0));
  if (on) el.palInput.setAttribute('aria-activedescendant', on.id); else el.palInput.removeAttribute('aria-activedescendant');
  if (on && scroll) on.scrollIntoView({ block: 'nearest' });
}
function palMove(d) {
  const p = state.palette;
  const n = p.items.length;
  if (!n) return;
  p.hi = (((p.hi + d) % n) + n) % n;
  p.hiKey = rowKey(p.items[p.hi]);
  palHighlight();
}

// Open it. `from`: 'shortcut' (Alt+R: Esc then closes Tabazing) or 'switcher' (Esc goes back to it);
// `text`: what the box starts with; `saved`: the search box's text, put back on the way out.
function openPalette({ from = 'switcher', text = '', saved = el.search.value } = {}) {
  if (state.done) return;
  if (state.palette) { el.palInput.focus({ preventScroll: true }); el.palInput.select(); return; }
  closePops();
  closeBig();
  hideTip();
  if (archiveOpen()) closeArchive();
  if (historyOpen()) closeHistory();
  if (bookmarksOpen()) closeBookmarks();
  if (backupOpen()) closeBackup();
  if (settingsOpen()) closeSettings();
  closeDrawer(false);
  if (state.modal) closeDialog();
  stopHolding();
  state.palette = { from, saved, hi: 0, items: [] };
  state.dd.hidden = true;
  renderDropdown();
  document.documentElement.classList.add('palette-open'); // not 'palette': that is the panel's class, and its rule would lay out the whole page
  // From Alt+R it opens on its own: just the dimmed backdrop and the palette, the switcher isn't shown at all.
  document.documentElement.classList.toggle('palette-solo', from === 'shortcut');
  el.palette.hidden = false;
  el.palInput.value = text;
  updateInert();
  el.palInput.focus({ preventScroll: true });
  el.palInput.setSelectionRange(text.length, text.length);
  if (text.trim()) startSearch(text.trim());
  renderPalette();
  getPaletteRecent().then((r) => { state.palRecent = r; if (state.palette && !el.palInput.value.trim()) renderPalette(); }).catch(() => {});
  if (!srcTab() && Number.isInteger(CTX.srcTab)) chrome.tabs.get(CTX.srcTab).then((tab) => { srcTabInfo = tab; renderPalette(); }).catch(() => {});
}
// Back to the switcher, with the search box as it was.
function exitPalette() {
  const p = state.palette;
  if (!p) return;
  state.palette = null;
  cancelAnimationFrame(palFrame);
  palFrame = 0;
  document.documentElement.classList.remove('palette-open', 'palette-solo');
  el.palette.hidden = true;
  el.palList.replaceChildren();
  el.palInput.value = '';
  el.palInput.removeAttribute('aria-activedescendant');
  updateInert();
  el.search.value = state.query = p.saved;
  state.dd.hidden = !p.saved.trim();
  state.dd.hi = 0;
  state.dd.hiKey = null;
  flushSearch();
  el.search.focus({ preventScroll: true });
}
// What a row does: a quick answer is copied, the currency row does nothing, an action runs, a search result
// opens as it would from the dropdown.
async function palRun(it, { shift = false } = {}) {
  if (!it || state.done) return;
  if (it.kind === 'currency') return;
  if (it.kind === 'quick') return copyQuick(it.res, shift);
  if (it.kind === 'action') return runAction(it.a, { keep: shift });
  return ddActivate(it, el.palInput.value.trim());
}
// Enter: the result; Shift+Enter (or the row's button): the whole expression.
async function copyQuick(res, whole = false) {
  const text = whole ? res.expr : res.copy;
  toast((await copyText(text)) ? t('palCopied', { text }) : t('copyFailed'));
}
async function runAction(a, { keep = false } = {}) {
  if (state.done) return;
  notePaletteRecent(a.id).then((r) => { state.palRecent = r; }).catch(() => {});
  const tab = a.tab ? srcTab() : null;
  if (a.tab && !tab) return;
  if (a.ui) exitPalette(); // what it opens takes the focus and the top layer
  try { await a.run(tab); } catch (err) { if (!state.done) toast(a.err ? a.err() : t('actFailed'), err); return; }
  if (state.done) return;
  const after = a.ui ? 'switcher' : keep ? 'stay' : a.after;
  if (after === 'close') return finish('cancel');
  if (after === 'switcher') return exitPalette();
  renderPalette(); // stays: titles may have changed (Pin -> Unpin)
}
function paletteKey(e) {
  const k = e.key;
  const p = state.palette;
  if (MODIFIERS.has(k) || k === 'Shift') return;
  if (palFrame && (k === 'Enter' || k.startsWith('Arrow'))) renderPalette(); // act on what was just typed
  if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); return p.from === 'shortcut' ? finish('cancel') : exitPalette(); }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') {
    e.preventDefault();
    if (p.from === 'shortcut') { el.palInput.focus({ preventScroll: true }); el.palInput.select(); } else exitPalette();
    return;
  }
  if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); return palMove(k === 'ArrowDown' ? 1 : -1); }
  if (k === 'Enter') {
    e.preventDefault();
    if (e.repeat || e.isComposing) return;
    if (!keysAllowed()) return finish('cancel');
    return palRun(p.items[p.hi], { shift: e.shiftKey });
  }
  if (k === 'Backspace' && !el.palInput.value && p.from === 'switcher' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); return exitPalette(); }
  if (e.target !== el.palInput && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) el.palInput.focus({ preventScroll: true });
}
function onPaletteInput() {
  if (!state.palette) return;
  state.palette.hi = 0;
  state.palette.hiKey = null;
  startSearch(el.palInput.value.trim());
  if (!palFrame) palFrame = requestAnimationFrame(() => { palFrame = 0; renderPalette(); });
}

// ---- what the palette's actions call that had no function of their own
// Zoom the tab in or out one of Chrome's steps (d = 1 / -1), or back to 100 % (d = 0).
function nextZoom(z, d) {
  if (!d) return 1;
  const list = d > 0 ? ZOOMS : [...ZOOMS].reverse();
  return list.find((x) => (d > 0 ? x > z + 0.001 : x < z - 0.001)) ?? list[list.length - 1];
}
async function zoomTab(tab, d) {
  const next = nextZoom(await chrome.tabs.getZoom(tab.id), d);
  await chrome.tabs.setZoom(tab.id, next);
  toast(t('palZoomed', { level: new Intl.NumberFormat(uiLang(), { style: 'percent' }).format(next) }));
}
// Full screen on or off for the window Tabazing was opened from.
async function toggleFullscreen() {
  const w = await chrome.windows.get(CTX.srcWin);
  await chrome.windows.update(CTX.srcWin, { state: w.state === 'fullscreen' ? 'normal' : 'fullscreen' });
}
// ---------------------------------------------------------------- dialogs
// Two dialogs live in the switcher: the first-run tour and the review prompt. While one is
// open it owns the keyboard (Esc closes it, not the switcher). Neither is shown while Alt is
// still held from the shortcut, so a quick Alt+Q flick is never interrupted.
let asking = false; // a browser permission prompt is open: its focus change must not close us

const K = (win, mac) => h('kbd', '', IS_MAC && mac ? mac : win, 'dialog-key');
const para = (...parts) => { const p = h('p', '', null, 'dialog-text'); p.append(...parts); return p; };
const button = (testid, label, cls, fn) => { const b = h('button', 'btn ' + (cls || ''), label, testid); b.type = 'button'; b.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) fn(); }); return b; };

let dialogBack = null; // what had the focus before the dialog opened: it gets it back
function showDialog(kind, nodes) {
  if (!state.modal) dialogBack = document.activeElement;
  state.modal = kind;
  el.dialog.replaceChildren(...nodes);
  el.modal.hidden = false;
  el.modal.classList.toggle('tour', kind === 'tour');
  el.dialog.classList.toggle('manual', kind === 'tour');
  el.dialog.classList.toggle('bm', kind === 'bookmark' || kind === 'bmedit');
  updateInert();
  const first = el.dialog.querySelector('textarea, .primary') || el.dialog.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}
function closeDialog() {
  state.modal = null;
  el.modal.hidden = true;
  updateInert();
  document.querySelectorAll('.tour-hl').forEach((n) => n.classList.remove('tour-hl'));
  document.documentElement.classList.remove('tour-picking');
  const back = dialogBack;
  dialogBack = null;
  (back && back !== document.body && back.isConnected ? back : el.search).focus({ preventScroll: true });
}
function whenTapMode(fn) {
  const t0 = performance.now();
  const tick = () => {
    if (state.done || state.modal || state.palette || settingsOpen() || el.search.value) return; // closed, or already busy: don't interrupt
    if (!state.holding) return fn();
    if (performance.now() - t0 < 10000) setTimeout(tick, 150); // Alt still held from the shortcut: wait for the release
  };
  setTimeout(tick, 350);
}

// ---- first-run tour: short cards in the accent colour, each pointing at what it explains.
const keyRows = (...rows) => { const d = h('div', 'keys', null, 'dialog-keys'); rows.forEach(([keys, word]) => { const k = h('span', '', null, 'dialog-keys-combo'); k.append(...keys); d.append(k, h('span', '', word, 'dialog-keys-action')); }); return d; };
const ALT = IS_MAC ? '⌥' : 'Alt+';
const PALETTE_KEY = IS_MAC ? '⌥R' : 'Alt+R'; // the 'open-palette' command's suggested key (manifest.json)

// `when`: shown only if that is on screen. `picking`: the step shows every card's tick box.
const TOUR_ALL = [
  { id: 'switch', title: () => t('tourSwitchTitle'), hl: '.card[aria-selected="true"]', body: () => [
    para(t('tourSwitchBody')),
    keyRows([[K(ALT + 'Q')], t('keyPrevTab')], [[K(ALT + 'W')], t('keyNextTab')], [[K(ALT + 'E')], t('keyStay')])] },
  { id: 'move', title: () => t('tour2Title'), hl: '.card[aria-selected="true"]', body: () => [
    keyRows([[K('←'), K('→'), K('↑'), K('↓')], t('keyPick')], [[K(ALT + '1'), K('…'), K(ALT + '9')], t('keyNumber')], [[K('Enter')], t('keyOpen')], [[K('Space')], t('keyPreview')],
      [[K('Del', '⌘⌫')], t('keyClose')], [[K('Ctrl+Z', '⌘Z')], t('keyUndo')], [[K('Shift+F10')], t('keyActions')], [[K('Esc')], t('keyLeave')]),
    para(t('tourKeysMore'))] },
  { id: 'search', title: () => t('tour3Title'), hl: '.search', body: () => [para(t('tour3Body')), keyRows([[K('Ctrl+F', '⌘F')], t('keySearch')])] },
  { id: 'palette', title: () => t('tourPaletteTitle'), hl: '.search', body: () => [para(t('tourPaletteBody', { key: PALETTE_KEY })), keyRows([[K('>'), K('Ctrl+K', '⌘K')], t('keyPaletteIn')])] },
  { id: 'groups', title: () => t('tourGroupsTitle'), hl: '.gtile', when: () => !!document.querySelector('.gtile'), body: () => [para(t('tourGroupsBody'))] },
  { id: 'cards', title: () => t('tourCardsTitle'), hl: '.card[aria-selected="true"]', body: () => [para(t('tourCardsBody')), para(t('tourCardsMouse', { key: IS_MAC ? '⌘' : 'Ctrl' }))] },
  { id: 'later', title: () => t('tourLaterTitle'), hl: '#menu-btn', body: () => [para(t('tourLaterBody'))] },
  { id: 'views', title: () => t('tourViewsTitle'), hl: '#menu-btn', body: () => [para(t('tourViewsBody')), keyRows([[K('Ctrl+H', '⌘Y')], t('keyHistory')], [[K('Ctrl+Shift+O', '⌘⌥B')], t('keyBookmarks')])] },
  { id: 'many', title: () => t('tourManyTitle'), hl: '.card[aria-selected="true"] .pick', picking: true, body: () => [para(t('tourManyBody', { key: IS_MAC ? '⌘' : 'Ctrl' }))] },
  { id: 'sort', title: () => t('tourSortTitle'), hl: '.sortbox', body: () => [para(t('tourSortBody'))] },
  { id: 'windows', title: () => t('tourWinTitle'), hl: '#wins', when: () => !el.wins.hidden, body: () => [para(t('tourWinBody'))] },
  { id: 'player', title: () => t('tourPlayerTitle'), hl: '#player', when: () => !el.player.hidden, body: () => [para(t('tourPlayerBody'))] },
  { id: 'settings', title: () => t('tourSetTitle'), hl: '#menu-btn', body: () => [para(t('tourSetBody'))] },
];
let TOUR = TOUR_ALL;
let tourAt = 0;
function tourStep(i) {
  if (i === 0) TOUR = TOUR_ALL.filter((x) => !x.when || x.when());
  tourAt = Math.max(0, Math.min(TOUR.length - 1, i));
  const step = TOUR[tourAt];
  const last = tourAt === TOUR.length - 1;
  document.querySelectorAll('.tour-hl').forEach((n) => n.classList.remove('tour-hl'));
  document.documentElement.classList.toggle('tour-picking', !!step.picking); // (before the tick box is looked for)
  const sel = typeof step.hl === 'function' ? step.hl() : step.hl;
  const target = sel && document.querySelector(sel);
  if (target) target.classList.add('tour-hl');
  const row = h('div', 'row', null, 'tour-buttons');
  row.append(h('span', 'stepof', `${tourAt + 1} / ${TOUR.length}`, 'tour-step-of'), h('span', 'grow', null, 'tour-spacer'));
  if (tourAt > 0) row.append(button('tour-back', t('back'), 'quiet', () => tourStep(tourAt - 1)));
  if (!last) row.append(button('tour-skip', t('skip'), 'quiet', endTour));
  row.append(button(last ? 'tour-done' : 'tour-next', t(last ? 'done' : 'next'), 'primary', () => (last ? endTour() : tourStep(tourAt + 1))));
  const title = h('h3', '', step.title(), 'dialog-title');
  title.id = 'dlg-title';
  const num = h('span', 'num', String(tourAt + 1), 'tour-step-number');
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

// ---- "How is Tabazing working for you?": two steps, at most twice (utils/review.js has the timing).
// Same rules for everyone, and every answer still offers the store review. The answer itself stays
// on this computer; the buttons only open pages on the site, where people send what they choose.
const openUrl = async (url) => { try { await chrome.tabs.create({ url, windowId: CTX.srcWin, active: true }); } catch {} finish('switch'); };
const reviewDone = () => updateReview((r) => ({ ...r, done: true })).catch(() => {});
const goReview = async () => { await reviewDone(); openUrl(REVIEW_URL); };

function askStep1() {
  const title = h('h3', '', t('askTitle'), 'dialog-title');
  title.id = 'dlg-title';
  const faces = h('div', 'faces', null, 'ask-moods');
  for (const [label, mood] of [['moodGood', 'good'], ['moodOkay', 'okay'], ['moodBad', 'bad']]) faces.append(button('ask-mood-' + mood, t(label), '', () => askStep2(mood)));
  const row = h('div', 'row', null, 'ask-buttons');
  row.append(button('ask-dont-ask', t('dontAsk'), 'quiet', () => { reviewDone(); closeDialog(); }), h('span', 'grow', null, 'ask-spacer'), button('ask-not-now', t('notNow'), 'quiet', closeDialog));
  showDialog('ask', [title, para(t('askBody')), faces, row]);
}
function askStep2(mood) {
  const good = mood === 'good';
  const title = h('h3', '', t(good ? 'askGoodTitle' : 'askBadTitle'), 'dialog-title');
  title.id = 'dlg-title';
  const row = h('div', 'row', null, 'ask-buttons');
  if (good) row.append(button('ask-review', t('reviewBtn'), 'primary', goReview));
  else row.append(button('ask-survey', t('surveyBtn'), 'primary', async () => { await reviewDone(); openUrl(siteUrl('/survey', 'extension-prompt', '&mood=' + mood)); }), button('ask-review', t('reviewBtn'), '', goReview));
  row.append(h('span', 'grow', null, 'ask-spacer'), button('ask-not-now', t('notNow'), 'quiet', closeDialog));
  showDialog('ask', [title, para(t(good ? 'askGoodBody' : 'askBadBody')), row, h('p', 'note', t('askNote'), 'ask-note')]);
}
function askLater() { closeDialog(); }

// ---- "Bookmark…" (a tab's menu, a recently closed one's, a group's, the ticked tabs' ⋯, the palette): pages
// ([{ title, url }]) saved as Chrome bookmarks in the folder you choose. A dialog: the name (one page), the folders
// as a tree (a box finds one by name, ↑/↓ move, "New folder" makes one inside the chosen one), then Save. It starts
// on the folder last saved into (view.markFolder). A page already in that folder isn't added again, only renamed.
// The note that follows has Undo, which takes the new bookmarks out again.
const pageOf = (tab) => ({ title: tab.title || '', url: urlOf(tab) });
// The folders that can take a bookmark, in the tree's order: [{ id, title, depth, path, other }] (not the archive).
function markFolders(tree) {
  const out = [];
  const tops = (tree[0] && tree[0].children) || [];
  const other = tops.find((n) => n.folderType === 'other') || tops.find((n) => n.id === '2');
  const arch = other && (other.children || []).find((n) => !n.url && n.title === ARCHIVE_FOLDER);
  const walk = (n, depth, path) => {
    if (n.url || n.unmodifiable || (arch && n.id === arch.id)) return;
    const title = n.title || t('untitled');
    out.push({ id: n.id, title, depth, path: [...path, title].join(' › '), other: n === other });
    for (const c of n.children || []) walk(c, depth + 1, [...path, title]);
  };
  tops.forEach((n) => walk(n, 0, []));
  return out;
}
// `folder`: the name "New folder" starts with (a group's).
async function bookmarkDialog(pages, { folder: newName = '' } = {}) {
  if (!chrome.bookmarks) return toast(t('ddNoMarks'));
  pages = pages.filter((p) => p.url && !isOwnUrl(p.url));
  if (!pages.length) return toast(t('markCant'));
  closePops();
  const [tree, view, have] = await Promise.all([
    chrome.bookmarks.getTree(), getView().catch(() => null),
    pages.length === 1 ? chrome.bookmarks.search({ url: pages[0].url }).catch(() => []) : [],
  ]);
  if (state.done) return;
  let folders = markFolders(tree);
  if (!folders.length) return toast(t('markErr'));
  const byId = (id) => folders.find((f) => f.id === id);
  let sel = view && byId(view.markFolder) ? view.markFolder : have[0] && byId(have[0].parentId) ? have[0].parentId : (folders.find((f) => f.other) || folders[0]).id;
  let shown = folders;

  const form = h('form', 'bmform', null, 'bookmark-form');
  const title = h('h3', '', pages.length === 1 ? t('markTitle') : t('markTitleN', { count: pages.length }), 'dialog-title');
  title.id = 'dlg-title';
  form.append(title);
  let name = null;
  if (pages.length === 1) {
    const l = h('label', 'bmlabel', t('markName'), 'bookmark-name-label');
    l.htmlFor = 'bm-name';
    name = h('input', 'bminput', null, 'bookmark-name');
    name.id = 'bm-name';
    name.value = pages[0].title || siteOf(pages[0].url);
    name.maxLength = 500;
    form.append(l, name);
  } else form.append(para(t('markPagesNote', { count: pages.length })));
  const fl = h('span', 'bmlabel', t('markFolder'), 'bookmark-folder-label');
  fl.id = 'bm-folders-h';
  const find = h('input', 'bminput', null, 'bookmark-find');
  find.type = 'search';
  find.placeholder = t('markFind');
  find.setAttribute('aria-label', t('markFindAria'));
  find.setAttribute('aria-controls', 'bm-tree');
  find.autocomplete = 'off';
  find.spellcheck = false;
  const list = h('div', 'bmtree', null, 'bookmark-folders');
  list.id = 'bm-tree';
  list.tabIndex = 0;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', 'bm-folders-h');
  const none = h('p', 'bmnone', t('markNoFolder'), 'bookmark-no-folder');
  none.hidden = true;
  form.append(fl, find, list, none);
  if (have.length) {
    const where = have.map((b) => (byId(b.parentId) || {}).path).filter(Boolean);
    if (where.length) form.append(h('p', 'note', t('markHave', { folders: where.join(', ') }), 'bookmark-have'));
  }
  // "New folder": a name box and Create, inside the chosen folder.
  const newRow = h('div', 'bmnew', null, 'bookmark-new-row');
  newRow.hidden = true;
  const newBox = h('input', 'bminput', null, 'bookmark-new-name');
  newBox.placeholder = t('markNewFolderPh');
  newBox.setAttribute('aria-label', t('markNewFolderPh'));
  newBox.maxLength = 200;
  newBox.value = newName;
  newRow.append(newBox, button('bookmark-new-create', t('markCreate'), 'small', () => makeFolder()));
  form.append(newRow);
  const row = h('div', 'row', null, 'bookmark-buttons');
  const save = h('button', 'btn primary', t('markSave'), 'bookmark-save');
  save.type = 'submit';
  row.append(button('bookmark-new', t('markNewFolder'), 'quiet', () => { newRow.hidden = false; newBox.focus(); newBox.select(); }),
    h('span', 'grow', null, 'bookmark-spacer'), button('bookmark-cancel', t('cancel'), 'quiet', closeDialog), save);
  form.append(row);

  // The folders (only those the box finds, with their place), the chosen one marked; it follows the box's first find.
  const draw = () => {
    const q = find.value.trim().toLowerCase();
    shown = q ? folders.filter((f) => matches(q, f.title, f.path)) : folders;
    if (shown.length && !shown.some((f) => f.id === sel)) sel = shown[0].id;
    list.replaceChildren(...shown.map((f) => {
      const o = h('div', 'bmrow' + (f.id === sel ? ' on' : ''), null, 'bookmark-folder');
      o.id = 'bm-f-' + f.id;
      o.setAttribute('role', 'option');
      o.setAttribute('aria-selected', String(f.id === sel));
      o.style.setProperty('--d', q ? 0 : f.depth);
      const ic = h('span', 'bmico', null, 'bookmark-folder-icon');
      ic.append(svgOf(ICON.folder));
      o.append(ic, h('span', 'bmname', f.title, 'bookmark-folder-name'));
      if (q && f.depth) o.append(h('span', 'bmpath', f.path, 'bookmark-folder-path'));
      o.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) { sel = f.id; draw(); } });
      return o;
    }));
    none.hidden = shown.length > 0;
    save.disabled = !shown.length;
    if (shown.length) list.setAttribute('aria-activedescendant', 'bm-f-' + sel); else list.removeAttribute('aria-activedescendant');
    const on = list.querySelector('.bmrow.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  // ↑/↓ in the box or the list choose the folder above or below; Home / End in the list the first or last.
  const move = (e) => {
    const i = shown.findIndex((f) => f.id === sel);
    const inList = e.currentTarget === list;
    const j = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : inList && e.key === 'Home' ? 0 : inList && e.key === 'End' ? shown.length - 1 : null;
    if (j === null || !shown.length) return;
    e.preventDefault();
    sel = shown[Math.max(0, Math.min(shown.length - 1, j))].id;
    draw();
  };
  find.addEventListener('input', draw);
  find.addEventListener('keydown', move);
  list.addEventListener('keydown', move);
  newBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); makeFolder(); } });
  async function makeFolder() {
    const label = newBox.value.trim();
    if (!label) return newBox.focus();
    try {
      const n = await chrome.bookmarks.create({ parentId: sel, title: label });
      folders = markFolders(await chrome.bookmarks.getTree());
      sel = n.id;
      find.value = newBox.value = '';
      newRow.hidden = true;
      draw();
      list.focus({ preventScroll: true });
    } catch (err) { toast(t('markFolderErr'), err); }
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = byId(sel);
    if (!f || !pointerAllowed()) return;
    save.disabled = true;
    try {
      const made = [];
      for (const p of pages) {
        const label = (name && name.value.trim()) || p.title || siteOf(p.url) || p.url;
        const there = (await chrome.bookmarks.search({ url: p.url }).catch(() => [])).find((b) => b.parentId === f.id);
        if (there) { if (there.title !== label) await chrome.bookmarks.update(there.id, { title: label }); }
        else made.push((await chrome.bookmarks.create({ parentId: f.id, title: label, url: p.url })).id);
      }
      updateView({ markFolder: f.id }).catch(() => {});
      state.marks = null; // the search reads them again
      closeDialog();
      toast(t('markSaved', { count: pages.length, folder: f.title }), null, made.length ? { label: t('undo'), fn: async () => {
        for (const id of made) await chrome.bookmarks.remove(id).catch(() => {});
        state.marks = null;
        toast(t('markUndone', { count: made.length }));
      } } : undefined);
    } catch (err) { save.disabled = false; toast(t('markErr'), err); }
  });
  showDialog('bookmark', [form]);
  draw();
  (name || find).focus({ preventScroll: true });
  if (name) name.select();
}

// ---- is capturing working? Say so when it isn't, and offer the fix.
// Chrome lets users set an extension's "Site access" to "On click", which withholds the access
// Tabazing needs to screenshot pages and to react to Alt+Q on them. Detect that, and say why a
// preview is missing when the screenshot itself failed.
// `detail` (Chrome's own wording, for whoever wants it) goes in the tooltip, never on screen.
function showAlert(text, label, fn, detail = '') {
  el.alertText.textContent = text;
  el.liveAlert.textContent = text; // read out from the always-present live region (#alert itself comes and goes)
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
  setTimeout(() => { if (!state.done) { el.alert.hidden = true; el.liveAlert.textContent = ''; render(); } }, 3500);
}
// Tabs the current view shows (window, star filter, search) that have no preview yet.
function missingPreviews() {
  return state.sections.flatMap((x) => x.entries).flatMap((e) => (e.kind === 'group' ? e.tabs : [e.tab]))
    .filter((x) => !x.active && canCapture(x) && !state.previews[x.id] && !state.pvPending.has(x.id));
}
// "Capture all": a small camera with how many cards have no preview; its tooltip and label say the rest.
function updateSweepButton() {
  const n = missingPreviews().length;
  const max = LIMITS.SWEEP_MAX_TABS;
  const scoped = state.scope !== 'all' || state.starOnly || state.query;
  el.sweepBtn.hidden = !state.hostOk || n === 0;
  const label = n > max ? t('sweepFirst', { count: n, max }) : t(scoped ? 'sweepThese' : 'sweepAll', { count: n });
  el.sweepText.textContent = String(n);
  el.sweepBtn.setAttribute('aria-label', label);
  el.sweepBtn.title = label + '\n' + t(scoped ? 'sweepTitleThese' : 'sweepTitleAll') + (n > max ? ' ' + t('sweepTitleMax', { max }) : '') + ' ' + t('sweepTitleOne');
}
// Chrome's error text for a failed screenshot, in plain words (null = not worth mentioning).
function plainCaptureError(msg) {
  const m = String(msg || '');
  if (/MAX_CAPTURE|quota|per second/i.test(m)) return null; // we just went too fast: it retries by itself
  if (/invoked|activeTab|permission|host/i.test(m)) return { text: t('capErrHost'), fix: true };
  if (/chrome:|extensions gallery|cannot access/i.test(m)) return { text: t('capErrPage') };
  return { text: t('capErrOther') };
}
const ICON_TIPS = 3; // times the toolbar-icon tip shows (prefs.iconTips counts them)
async function healthCheck() {
  try { state.hostOk = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch { state.hostOk = true; }
  // Alt+Q itself can be left unassigned by Chrome (another app or extension owns it): say so, with the fix.
  let shortcut = 'assigned';
  try { const c = (await chrome.commands.getAll()).find((x) => x.name === 'open-switcher'); if (c && !c.shortcut) shortcut = 'missing'; } catch {}
  if (shortcut === 'missing') return showAlert(t('shortcutMissing'), t('setShortcut'), () => openUrl(SHORTCUTS_URL));
  // Opened with the toolbar icon: the tip about Alt+Q, the first few times only (it has made its point by then).
  if (CTX.via === 'icon' && pref('iconTips') < ICON_TIPS) {
    toast(t('iconTip', { key: IS_MAC ? 'Option+Q' : 'Alt+Q' }));
    const iconTips = pref('iconTips') + 1;
    state.prefs = { ...(state.prefs || PREFS_FALLBACK), iconTips };
    updatePrefs({ iconTips }).catch(() => {});
  }
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

// ---- the theme (Settings): html.light switches the colours (switcher.css). "System" (the default) follows the
// OS and changes with it.
const lightMq = matchMedia('(prefers-color-scheme: light)');
let themePref = 'system';
function applyTheme(v) {
  themePref = ['light', 'dark'].includes(v) ? v : 'system';
  document.documentElement.classList.toggle('light', themePref === 'light' || (themePref === 'system' && lightMq.matches));
}
lightMq.addEventListener('change', () => applyTheme(themePref));
// Settings -> Theme (or the palette): apply, keep, and tell the page hosting the overlay, whose shade follows it.
function setTheme(v) {
  applyTheme(v);
  state.prefs = { ...(state.prefs || PREFS_FALLBACK), theme: themePref };
  updatePrefs({ theme: themePref }).catch(() => {});
  if (CTX.mode === 'overlay') parent.postMessage({ tabazing: FRAME_MSG.READY, light: document.documentElement.classList.contains('light') }, '*'); // the page's shade
}
// Settings -> Title lines: two lines of title on the default-size cards (html.lines2), else one.
function applyLines() {
  document.documentElement.classList.toggle('lines2', pref('titleLines') === 2);
}
// The search box says what it searches (Settings can leave out history and bookmarks).
function searchPlaceholder() {
  const hist = pref('searchHistory'), marks = pref('searchBookmarks');
  el.search.placeholder = t(hist && marks ? 'searchPlaceholder' : hist ? 'searchPhNoMarks' : marks ? 'searchPhNoHistory' : 'searchPhTabs');
}

// ---- Settings (the gear at the left of the header): a dialog over the switcher, which is inert meanwhile. A header
// (the title, its ×), the categories as tabs down the left (a row above the content in a narrow window) and the
// chosen category's controls, which scroll inside. The last category opened is remembered (view.settingsTab).
// Esc, ×, a click on the dimmed backdrop or the gear again (openSettings while open) close it; the focus goes back
// to the gear. Every control saves at once (prefs); a new language redraws it open, on the same category.
const SETTINGS_CATS = [ // the ids are utils/store.js SETTINGS_TABS
  { id: 'look', label: 'setGroupLook', icon: 'brush' }, { id: 'cards', label: 'setGroupCards', icon: 'cards' },
  { id: 'search', label: 'setGroupSearch', icon: 'zoom' }, { id: 'behave', label: 'setGroupBehave', icon: 'gear' },
  { id: 'keys', label: 'setGroupKeys', icon: 'keyboard' },
];
// Tabazing's commands (manifest.json), as Settings -> Shortcuts lists them; `key`: the letter the in-page
// fallback (hotkey.js) answers to with Alt when Chrome has no shortcut for the command.
const COMMANDS = [
  { name: 'open-switcher', label: 'setKeyPrev', desc: 'cmdOpen', key: 'Q' },
  { name: 'open-switcher-reverse', label: 'setKeyNext', desc: 'cmdReverse', key: 'W' },
  { name: 'open-switcher-stay', label: 'setKeyStay', desc: 'cmdStay', key: 'E' },
  { name: 'open-palette', label: 'setKeyPalette', desc: 'cmdPalette', key: 'R' },
];
const SHORTCUTS_URL = 'chrome://extensions/shortcuts'; // the only place Chrome lets anyone change them
const SETTINGS_NARROW_W = 640; // below this the categories are a row of tabs above the content
let settingsTab = 'look';
let settingsAnchor = null; // what opened Settings: it gets the focus back
const settingsOpen = () => !!document.querySelector('#app > .setback');

async function openSettings(anchor = el.menuBtn, redraw = false) {
  if (settingsOpen() && !redraw) return closeSettings();
  closeDrawer(false);
  closePops();
  const [stored, view] = await Promise.all([getPrefs().catch(() => ({})), redraw ? null : getView().catch(() => null)]);
  if (state.done || (settingsOpen() && !redraw)) return; // (a second click while the first was still reading)
  if (view) settingsTab = view.settingsTab;
  settingsAnchor = anchor;
  const prefs = { ...PREFS_FALLBACK, startup: false, accent: ACCENTS[0], ...stored };
  const panel = h('div', 'setpanel', null, 'settings');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true'); // Tab stays in it (keepFocusIn) until it closes
  panel.setAttribute('aria-labelledby', 'set-h');
  const title = h('h2', '', t('settings'), 'settings-title');
  title.id = 'set-h';
  const x = h('button', 'setx', null, 'settings-close');
  x.type = 'button';
  x.title = t('setClose') + ' (Esc)';
  x.setAttribute('aria-label', t('setClose'));
  x.append(svgOf(ICON.close));
  x.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) closeSettings(); });
  const head = h('div', 'sethead', null, 'settings-header');
  head.append(title, x);
  const tabs = h('div', 'settabs', null, 'settings-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', t('setCatsAria'));
  tabs.addEventListener('keydown', settingsTabKey);
  const body = h('div', 'setbody', null, 'settings-body');
  const panes = settingsPanes(prefs, anchor);
  for (const { id, label, icon } of SETTINGS_CATS) {
    const tab = h('button', 'settab', null, 'settings-tab-' + id);
    tab.type = 'button';
    tab.id = 'set-tab-' + id;
    tab.dataset.cat = id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'set-pane-' + id);
    const ic = h('span', 'setico', null, 'settings-tab-icon');
    ic.append(svgOf(ICON[icon]));
    tab.append(ic, h('span', '', t(label), 'settings-tab-label'));
    tab.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) settingsSelect(id); });
    tabs.append(tab);
    const pane = panes[id];
    pane.id = 'set-pane-' + id;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', tab.id);
    body.append(pane);
  }
  panel.append(head, tabs, body);
  const back = h('div', 'setback', null, 'settings-backdrop');
  back.append(panel);
  // A click on the backdrop closes it when the press began there too: not a text selection dragged out of the
  // panel, nor the press that only closed a select's open list (this listener runs before the list's own).
  let downOnBack = false;
  back.onDown = (e) => { downOnBack = e.target === back && !document.querySelector('.menu'); };
  back.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === back && downOnBack && pointerAllowed()) closeSettings(); });
  // Back from Chrome's shortcuts page (perhaps in another window): show the keys as they are now.
  back.onFocus = () => { if (back.isConnected) settingsCommands(); };
  const old = document.querySelector('#app > .setback');
  if (old) { settingsDetach(old); old.replaceWith(back); } else el.app.append(back);
  document.addEventListener('mousedown', back.onDown, true);
  window.addEventListener('focus', back.onFocus);
  settingsLayout();
  settingsSelect(settingsTab, { focus: !redraw, save: false });
  updateInert();
  settingsCommands();
  if (redraw) { const lang = $('set-lang'); if (lang && lang._fancy) lang._fancy.button.focus({ preventScroll: true }); } // where the change was made
}
function settingsDetach(back) {
  document.removeEventListener('mousedown', back.onDown, true);
  window.removeEventListener('focus', back.onFocus);
}
function closeSettings() {
  const back = document.querySelector('#app > .setback');
  if (!back) return;
  settingsDetach(back);
  document.querySelectorAll('.menu').forEach((m) => m.close()); // a select's list
  back.remove();
  updateInert();
  viewBack(settingsAnchor).focus({ preventScroll: true });
}

// Show one category: its tab selected (the only one Tab reaches, as in any tab list), its panel shown.
function settingsSelect(id, { focus = true, save = true } = {}) {
  if (!SETTINGS_CATS.some((c) => c.id === id)) id = 'look';
  settingsTab = id;
  for (const tab of document.querySelectorAll('.setback .settab')) {
    const on = tab.dataset.cat === id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    const pane = $(tab.getAttribute('aria-controls'));
    if (pane) pane.hidden = !on;
    if (on && focus) tab.focus({ preventScroll: true });
  }
  const body = document.querySelector('.setback .setbody');
  if (body) body.scrollTop = 0;
  if (save) updateView({ settingsTab: id }).catch(() => {});
}
// The tab list's keys: ↑/↓ (and ←/→ when the tabs are a row), Home and End move and show at once.
function settingsTabKey(e) {
  const list = e.currentTarget;
  const tabs = [...list.querySelectorAll('.settab')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
  const across = list.getAttribute('aria-orientation') === 'horizontal';
  const k = e.key, n = tabs.length;
  const side = across && (k === 'ArrowRight' || k === 'ArrowLeft') ? ahead(k) : 0;
  const j = k === 'ArrowDown' || side > 0 ? (i + 1) % n
    : k === 'ArrowUp' || side < 0 ? (i - 1 + n) % n
    : k === 'Home' ? 0 : k === 'End' ? n - 1 : -1;
  if (j < 0) return;
  e.preventDefault();
  settingsSelect(tabs[j].dataset.cat);
}
// A narrow window: the categories become a row of tabs above the content (switcher.css .setpanel.narrow).
function settingsLayout(width = window.innerWidth) {
  const panel = document.querySelector('.setback .setpanel');
  if (!panel) return;
  const narrow = width < SETTINGS_NARROW_W;
  panel.classList.toggle('narrow', narrow);
  panel.querySelector('.settabs').setAttribute('aria-orientation', narrow ? 'horizontal' : 'vertical');
}
// While Settings is open it has the keyboard: Esc closes it (an open select list closes itself first), and every
// other key belongs to the focused control, never to the switcher behind.
function settingsKey(e) {
  if (e.target instanceof Element && e.target.closest('.menu')) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSettings(); }
}

// The categories' contents: { look, cards, search, behave, keys }, each a panel of controls that save themselves.
function settingsPanes(prefs, anchor) {
  const pane = (id, ...nodes) => { const p = h('div', 'setpane', null, 'settings-panel-' + id); p.append(...nodes); return p; };
  const fine = (text, testid) => h('p', 'pfine', text, testid);
  // A labelled control; a <select> gets its themed list.
  const field = (label, testid, control) => {
    const f = h('div', 'sfield', null, 'settings-field');
    f.append(h('label', '', label, testid), control);
    if (control.tagName === 'SELECT') fancySelect(control, { inPop: true });
    return f;
  };
  const select = (testid, label, options, chosen) => {
    const s = h('select', '', null, 'settings-' + testid);
    s.setAttribute('aria-label', label);
    for (const [v, text] of options) { const o = h('option', '', text, 'settings-' + testid + '-' + v); o.value = v; if (v === chosen) o.selected = true; s.append(o); }
    return s;
  };
  const lang = select('language', t('setLang'), [['auto', t('setLangAuto')], ['en', 'English'], ['el', 'Ελληνικά'], ['de', 'Deutsch'], ['it', 'Italiano'], ['fr', 'Français'], ['es', 'Español'], ['ru', 'Русский'], ['ar', 'العربية'], ['he', 'עברית'], ['ro', 'Română']], prefs.lang);
  lang.id = 'set-lang';
  lang.addEventListener('change', async () => {
    await updatePrefs({ lang: lang.value }).catch(() => {});
    setLang(lang.value);
    localizePage();
    render();
    openSettings(anchor, true); // redraw it in the new language, on the same category
  });
  // A switch that saves itself (prefs[key]), then `then` shows the change.
  const check = (key, label, testid, then) => {
    const box = h('input', '', null, 'settings-' + testid);
    box.type = 'checkbox';
    box.checked = !!prefs[key];
    box.addEventListener('change', async () => {
      await updatePrefs({ [key]: box.checked }).catch(() => {});
      state.prefs = { ...(state.prefs || PREFS_FALLBACK), [key]: box.checked };
      if (then && !state.done) await then();
    });
    const l = h('label', 'check', label, 'settings-' + testid + '-label');
    l.prepend(box);
    return l;
  };
  const shows = (key, label, testid) => check(key, label, testid, () => refresh());
  const searches = (key, label, testid) => check(key, label, testid, () => { searchPlaceholder(); if (state.query.trim()) renderDropdown(); });
  // Accent colour: a few ready-made ones, and any colour from Chrome's picker (the last circle).
  const accents = h('div', 'accents', null, 'settings-accents');
  accents.setAttribute('role', 'radiogroup');
  accents.setAttribute('aria-label', t('setAccent'));
  const custom = h('input', 'custom', null, 'settings-accent-custom');
  const pickAccent = (c, save = true) => {
    const now = applyAccent(c);
    accents.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.c === now)));
    custom.classList.toggle('on', !ACCENTS.includes(now));
    if (save) updatePrefs({ accent: now }).catch(() => {});
  };
  for (const c of ACCENTS) {
    const b = h('button', 'swatch', null, 'settings-accent');
    b.type = 'button';
    b.dataset.c = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c);
    b.style.setProperty('--c', c);
    b.addEventListener('click', (e) => { e.stopPropagation(); pickAccent(c); });
    accents.append(b);
  }
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
  const theme = select('theme', t('setTheme'), [['dark', t('setThemeDark')], ['light', t('setThemeLight')], ['system', t('setThemeSystem')]], prefs.theme);
  theme.addEventListener('change', () => setTheme(theme.value));
  const size = select('card-size', t('setSize'), [['default', t('setSizeDefault')], ['small', t('setSizeSmall')], ['list', t('setSizeList')]], prefs.cardSize);
  size.addEventListener('change', () => {
    state.cardSize = size.value;
    updatePrefs({ cardSize: size.value }).catch(() => {});
    refresh();
  });
  const lines = select('title-lines', t('setLines'), [['2', t('setLines2')], ['1', t('setLines1')]], String(prefs.titleLines));
  lines.addEventListener('change', () => {
    const titleLines = Number(lines.value);
    state.prefs = { ...(state.prefs || PREFS_FALLBACK), titleLines };
    updatePrefs({ titleLines }).catch(() => {});
    applyLines();
    relayout();
  });
  // Shortcuts: Chrome's (filled in by settingsCommands), then the keys inside Tabazing, as the ⓘ card has them.
  const chromeH = h('h3', '', t('setKeysChrome'), 'settings-keys-chrome-title');
  chromeH.id = 'sk-chrome';
  const chromeHead = h('div', 'ssechead', null, 'settings-keys-chrome-header');
  chromeHead.append(chromeH, button('settings-keys-change-all', t('setKeysChangeAll'), 'small', () => openUrl(SHORTCUTS_URL)));
  const cmds = h('ul', 'cmdlist', null, 'settings-command-list');
  cmds.setAttribute('aria-labelledby', 'sk-chrome');
  const chromeSec = h('section', 'ssec', null, 'settings-keys-chrome');
  chromeSec.setAttribute('aria-labelledby', 'sk-chrome');
  chromeSec.append(chromeHead, fine(t('setKeysChromeNote'), 'settings-keys-chrome-note'), cmds);
  const insideH = h('h3', '', t('setKeysInside'), 'settings-keys-inside-title');
  insideH.id = 'sk-inside';
  const inside = h('section', 'ssec', null, 'settings-keys-inside');
  inside.setAttribute('aria-labelledby', 'sk-inside');
  inside.append(insideH, ...shortcutSections('skg-'));
  return {
    look: pane('look', field(t('setLang'), 'settings-language-label', lang), field(t('setTheme'), 'settings-theme-label', theme),
      field(t('setAccent'), 'settings-accent-label', accents), field(t('setSize'), 'settings-card-size-label', size),
      field(t('setLines'), 'settings-title-lines-label', lines)),
    cards: pane('cards', check('pinnedFirst', t('setPinnedFirst'), 'pinned-first', () => refresh()), shows('showAge', t('setShowAge'), 'show-age'),
      shows('showClosed', t('setShowClosed'), 'show-closed'), shows('showSnoozed', t('setShowSnoozed'), 'show-snoozed'),
      // Off: out of the group view too, for good (turned on again later, it doesn't jump back into a group).
      check('showGroups', t('setShowGroups'), 'show-groups', async () => { if (state.group !== null) { state.group = null; await setGroup(null).catch(() => {}); } refresh(); }),
      fine(t('setShowGroupsNote'), 'settings-show-groups-note'),
      check('groupWrap', t('setGroupWrap'), 'group-wrap'), fine(t('setGroupWrapNote'), 'settings-group-wrap-note'),
      check('allWindows', t('setAllWindows'), 'all-windows', async () => { state.scope = 'all'; await reload(); }), fine(t('setAllWindowsNote'), 'settings-all-windows-note')),
    search: pane('search', searches('searchHistory', t('setSearchHistory'), 'search-history'), searches('searchBookmarks', t('setSearchBookmarks'), 'search-bookmarks')),
    behave: pane('behave', check('ownWindow', t('setOwnWindow'), 'own-window'), fine(t('setOwnWindowNote'), 'settings-own-window-note'),
      check('startup', t('setStartup'), 'startup'), fine(t('setStartupNote'), 'settings-startup-note'),
      button('settings-tour', t('setTour'), 'setbtn', () => { closeSettings(); tourStep(0); })),
    keys: pane('keys', chromeSec, inside),
  };
}

// Settings -> Shortcuts: each command with the key Chrome has for it now, or "Not set" (then only the in-page
// fallback answers, on web pages). Read anew each time, as the keys change on Chrome's page, not here.
async function settingsCommands() {
  const list = document.querySelector('.setback .cmdlist');
  if (!list) return;
  let cmds = [];
  try { cmds = await chrome.commands.getAll(); } catch {}
  if (!list.isConnected) return;
  list.replaceChildren(...COMMANDS.map((c) => commandRow(c, (cmds.find((x) => x.name === c.name) || {}).shortcut || '')));
}
// "Alt+Q" (Windows, Linux) or "⌥Q" (Chrome's Mac form): one keycap per key.
const keyCaps = (shortcut) => (shortcut.includes('+') ? shortcut.split('+') : [...shortcut]).filter(Boolean);
function commandRow(c, shortcut) {
  const name = t(c.label);
  const row = h('li', 'cmdrow' + (shortcut ? '' : ' unset'), null, 'settings-command');
  const text = h('div', 'cmdtext', null, 'settings-command-text');
  text.append(h('span', 'cmdname', name, 'settings-command-name'), h('span', 'cmddesc', t(c.desc), 'settings-command-desc'));
  if (!shortcut) text.append(h('span', 'cmdnote', t('setKeysUnsetNote', { key: ALT + c.key }), 'settings-command-unset-note'));
  const keys = h('span', 'cmdkeys', null, 'settings-command-keys');
  if (shortcut) keys.append(...keyCaps(shortcut).map((k) => h('kbd', '', k, 'settings-command-key')));
  else keys.append(h('span', 'cmdunset', t('setKeysUnset'), 'settings-command-unset'));
  const change = button('settings-command-change', t('setKeysChange'), 'small', () => openUrl(SHORTCUTS_URL));
  change.setAttribute('aria-label', t('setKeysChangeAria', { name }));
  row.append(text, keys, change);
  return row;
}

// ---- the shortcuts card (ⓘ in the header): every key and mouse action, in groups (Settings -> Shortcuts lists
// them too). It takes the focus, keeps Tab inside, and closes with Esc, a press outside, its × or ⓘ again; the
// focus goes back to ⓘ.
function shortcutGroups() {
  const A = IS_MAC ? '⌥' : 'Alt+', C = IS_MAC ? '⌘' : 'Ctrl+', ALT_KEY = IS_MAC ? '⌥' : 'Alt', CTRL_KEY = IS_MAC ? '⌘' : 'Ctrl';
  return [
    ['open', t('keysGroupOpen'), [
      [[A + 'Q'], t('keyPrevTab')], [[A + 'W'], t('keyNextTab')], [['Shift+' + A + 'Q', 'Shift+' + A + 'W'], t('keyReverse')],
      [[A + 'E'], t('keyStay')], [[t('kbdLetGo', { key: ALT_KEY })], t('keyRelease')],
      [[t('kbdWheel', { key: ALT_KEY })], t('keyWheel')], [[A + 'Tab', 'Shift+' + A + 'Tab'], t('keyTabHeld')],
    ]],
    ['move', t('keysGroupMove'), [
      [['←', '→', '↑', '↓'], t('keyPick')], [[A + '1', '…', A + '9'], t('keyNumber')], [['1', '…', '9'], t('keyNumberPlain')],
      [[IS_MAC ? '⌃←' : 'Ctrl+←', IS_MAC ? '⌃→' : 'Ctrl+→'], t('keyWindow')], [[IS_MAC ? '⌫' : 'Backspace'], t('keyLeaveGroup')],
    ]],
    ['act', t('keysGroupAct'), [
      [['Enter'], t('keyOpen')], [['Shift+Enter'], t('keyOpenTyped')], [['Space'], t('keyPreview')], [[t('kbdClick', { key: 'Shift' })], t('keyBigClick')],
      [[IS_MAC ? '⌘⌫' : 'Del', t('kbdMiddle')], t('keyClose')], [[C + 'Z'], t('keyUndo')], [[A + 'S'], t('keyStar')], [[A + 'P'], t('keyCapture')],
      [['Shift+F10', t('kbdMenuKey'), t('kbdRight')], t('keyActions')],
      [[t('kbdClick', { key: CTRL_KEY }), C + 'Space'], t('keyTick')], [[t('kbdClickBox', { key: 'Shift' })], t('keyRange')], [['Shift+←→↑↓'], t('keyExtend')],
      [[t('kbdDrag')], t('keyDrag')],
    ]],
    ['search', t('keysGroupSearch'), [[[C + 'F'], t('keySearch')], [[t('kbdType')], t('keyType')], [['↑', '↓'], t('keyResults')]]],
    ['palette', t('keysGroupPalette'), [[[PALETTE_KEY], t('keyPalette')], [['>', C + 'K'], t('keyPaletteIn')], [['Shift+Enter'], t('keyPaletteStay')]]],
    ['views', t('keysGroupViews'), [
      [[IS_MAC ? '⌘Y' : 'Ctrl+H'], t('keyHistory')], [[IS_MAC ? '⌘⌥B' : 'Ctrl+Shift+O'], t('keyBookmarks')],
      [['Enter'], t('keyViewOpen')], [[C + 'Enter', t('kbdMiddle')], t('keyViewBehind')], [['Space', t('kbdClick', { key: 'Shift' })], t('keyPreview')],
      [[C + 'Space', t('kbdClick', { key: CTRL_KEY })], t('keyTick')], [[t('kbdClickBox', { key: 'Shift' })], t('keyRange')], [[C + 'A'], t('keyViewAll')],
      [[IS_MAC ? '⌘⌫' : 'Del'], t('keyViewDelete')], [['F2'], t('keyViewEdit')], [['→', '←'], t('keyViewFolder')], [['*'], t('keyViewSiblings')],
      [[C + '↑', C + '↓'], t('keyViewNudge')], [['Home', 'End', 'PgUp', 'PgDn'], t('keyViewJump')], [[t('kbdDrag')], t('keyViewDrag')],
      [['Esc'], t('keyViewEsc')],
    ]],
    ['esc', t('keysGroupEsc'), [[['Esc'], t('keyEsc')]]],
  ];
}
// shortcutGroups() as sections of keys and what they do: the ⓘ card's body, and Settings -> Shortcuts.
// `idPrefix` keeps the headings' ids apart.
function shortcutSections(idPrefix) {
  return shortcutGroups().map(([id, name, rows]) => {
    const g = h('section', 'kgroup', null, 'keys-group');
    const gh = h('h5', '', name, 'keys-group-title');
    gh.id = idPrefix + id;
    g.setAttribute('aria-labelledby', gh.id);
    const dl = h('dl', '', null, 'keys-list');
    for (const [keys, what] of rows) {
      const dt = h('dt', '', null, 'keys-combo');
      keys.forEach((k, i) => { if (i) dt.append(h('span', 'kor', ' / ', 'keys-or')); dt.append(h('kbd', '', k, 'keys-key')); });
      dl.append(dt, h('dd', '', what, 'keys-action'));
    }
    g.append(gh, dl);
    return g;
  });
}
function openShortcuts(anchor = el.keysBtn) {
  const open = document.querySelector('.pop.keyspop');
  closePops();
  if (open) return;
  const pop = h('div', 'pop keyspop', null, 'keys-popover');
  pop.id = 'keys-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true'); // Tab stays in it (keepFocusIn) until it closes
  pop.setAttribute('aria-labelledby', 'keys-h');
  const title = h('h4', '', t('keysTitle'), 'keys-title');
  title.id = 'keys-h';
  const x = h('button', 'noteclose', null, 'keys-close');
  x.type = 'button';
  x.title = t('keysClose');
  x.setAttribute('aria-label', t('keysClose'));
  x.append(svgOf(ICON.close));
  x.addEventListener('click', (e) => { e.stopPropagation(); pop.close(); });
  const body = h('div', 'keysbody', null, 'keys-body');
  body.append(...shortcutSections('kg-'), h('p', 'pfine', t('keysInSettings'), 'keys-settings-note'));
  const head = h('div', 'keyshead', null, 'keys-header');
  head.append(title, x);
  pop.append(head, body);
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pop.close(); } });
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) pop.close(); };
  pop.close = () => {
    if (!pop.isConnected) return;
    pop.remove();
    document.removeEventListener('mousedown', outside, true);
    anchor.setAttribute('aria-expanded', 'false');
    anchor.focus({ preventScroll: true });
  };
  el.app.append(pop);
  anchor.setAttribute('aria-expanded', 'true');
  dropFrom(pop, anchor.getBoundingClientRect(), { fit: true });
  setTimeout(() => { if (pop.isConnected) document.addEventListener('mousedown', outside, true); }, 0);
  x.focus({ preventScroll: true });
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
// Ctrl+H (⌘Y on a Mac, as Chrome there) the history, Ctrl+Shift+O (⌘⌥B) the bookmarks, from the switcher or from
// one view to the other. True when the key was one of them.
function viewKey(e) {
  if (e.altKey && !IS_MAC) return false;
  const C = IS_MAC ? e.metaKey : e.ctrlKey;
  if (!C) return false;
  const hist = IS_MAC ? e.code === 'KeyY' && !e.shiftKey : e.code === 'KeyH' && !e.shiftKey;
  const marks = IS_MAC ? e.code === 'KeyB' && e.altKey : e.code === 'KeyO' && e.shiftKey;
  if (!hist && !marks) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return true;
  if (hist) { if (historyOpen()) closeHistory(); else openHistory().catch((err) => toast(t('actFailed'), err)); }
  else if (bookmarksOpen()) closeBookmarks(); else openBookmarks().catch((err) => toast(t('bmvErr'), err));
  return true;
}
function dialogKey(e) {
  if (e.target instanceof Element && e.target.closest('.menu')) return; // a select's list over the dialog: its own keys
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return state.modal === 'tour' ? endTour() : askLater(); }
  if (state.modal === 'tour' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowLeft' ? ahead(e.key) : 0;
    if (d > 0) { e.preventDefault(); tourAt < TOUR.length - 1 ? tourStep(tourAt + 1) : endTour(); }
    else if (d < 0) { e.preventDefault(); tourStep(tourAt - 1); }
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
  // Tab moves the focus through the page's controls, within the top layer; only while Alt is still held
  // from Alt+Q / Alt+W does it step through the cards, like Alt+Tab (below).
  if (e.key === 'Tab' && !state.holding) return keepFocusIn(e);
  if (state.palette) return paletteKey(e); // the command palette has the keyboard
  if (!(e.shiftKey && e.key.startsWith('Arrow')) && !MODIFIERS.has(e.key) && e.key !== 'Shift') state.shiftBase = null; // a run of Shift+arrows ends
  if (e.key === 'Escape' && document.querySelector('.tip')) { e.preventDefault(); e.stopPropagation(); return hideTip(); } // the note tooltip first
  if (document.querySelector('.bigback')) { // the big preview has the keyboard: Esc closes it, Enter opens that tab
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBig(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const en = bigEntry, i = state.entries.indexOf(en);
      closeBig();
      if (en.kind === 'hist' || en.kind === 'bmk') { if (keysAllowed()) openPage(en.url); else finish('cancel'); } else if (i >= 0) choose(i);
    }
    else if (e.key === ' ') { e.preventDefault(); closeBig(); } // Space again: close
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { // the next / previous card's preview
      e.preventDefault();
      const hist = bigEntry.kind === 'hist' && state.hist;
      const bmk = bigEntry.kind === 'bmk' && state.bmv;
      const list = hist ? state.hist.items : bmk ? state.bmv.rows.filter((r) => r.n.url).map((r) => bmEntry(r.n)) : state.entries;
      const n = list.length, i = list.indexOf(bigEntry);
      if (n && i >= 0) {
        const j = (((i + ahead(e.key)) % n) + n) % n;
        if (hist) histSelect(j); else if (bmk) bmvSelect(state.bmv.rows.findIndex((r) => r.n === list[j].node)); else select(j);
        openBig(list[j]);
      }
    }
    else if (!MODIFIERS.has(e.key)) e.preventDefault();
    return;
  }
  if (state.modal) return dialogKey(e);
  if (viewKey(e)) return;
  if (drawerOpen()) return drawerKey(e);
  if (backupOpen()) return backupKey(e);
  if (bookmarksOpen()) return bmvKey(e);
  if (historyOpen()) return historyKey(e);
  if (archiveOpen()) return archiveKey(e);
  if (settingsOpen()) return settingsKey(e);
  // Typing in any field other than the search box (a note, the Sort list), or pressing a button
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
  // In a menu or a card (a note, the ⓘ card) every plain key stays there: Esc closes it, Enter/Space press, typing
  // doesn't jump to the search box behind it.
  if (own && !e.altKey && !e.ctrlKey && !e.metaKey) return;
  // A button, link, checkbox... focused from the keyboard (Tab reaches them): Enter and Space press it, they
  // don't open the selected card; ↑/↓ on a select button open its list. (One that only has the focus because
  // it was clicked leaves Enter to the card, as before.)
  const control = target && target !== el.search && target.closest('button, a[href], [role=button], [role=checkbox], [role=menuitem], [role=radio], [role=switch]');
  if (control && control.matches(':focus-visible') && (e.key === 'Enter' || e.key === ' ')) return;
  if (control && control.matches('.fs') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
  const typing = document.activeElement === el.search && el.search.value !== '';
  const k = e.key;
  if (searchFrame && (k === 'Enter' || k === 'Tab' || k.startsWith('Arrow'))) flushSearch(); // act on what was just typed
  const altOnly = e.altKey && !e.ctrlKey && !e.metaKey;
  // Our Alt shortcuts must work even if the text system thinks it's composing.
  if (e.isComposing && !(altOnly && ['KeyQ', 'KeyW', 'KeyE', 'KeyS', 'KeyP', 'KeyR'].includes(e.code))) return;
  // A fresh modifier press, or any key without a modifier, means the user
  // had already let go of the shortcut: from now on it's "tap" mode.
  if ((MODIFIERS.has(k) && !e.repeat) || (!e.altKey && !e.ctrlKey && !e.metaKey)) stopHolding();

  // Close the selected tab: Del, or Cmd+Backspace on a Mac (its "delete"
  // key is Backspace, which the search box needs).
  const closeKey = !typing && (k === 'Delete' || (IS_MAC && e.metaKey && k === 'Backspace'));

  // Hidden or covered by the page: don't act on keys the user can't see the
  // effect of - just get out of the way.
  const acts = k === 'Enter' || closeKey || (altOnly && ['KeyQ', 'KeyW', 'KeyE', 'KeyS', 'KeyP', 'KeyR'].includes(e.code));
  if (acts && !keysAllowed()) { e.preventDefault(); finish('cancel'); return; }

  // Holding the key sends repeats: close one tab per press, not one per repeat.
  if (closeKey) { e.preventDefault(); if (e.repeat) return; return closeTab(state.entries[state.sel]); }
  if (altOnly && e.code === 'KeyQ') { e.preventDefault(); return qPress(e.shiftKey ? 1 : -1); } // back a card
  if (altOnly && e.code === 'KeyW') { e.preventDefault(); return qPress(e.shiftKey ? -1 : 1); } // forward a card
  if (altOnly && e.code === 'KeyE') { e.preventDefault(); stopHolding(); return; } // stay open
  // Alt+R: the command palette (Chrome's shortcut opens it from pages; this is for when it is unassigned).
  if (altOnly && !e.shiftKey && e.code === 'KeyR') { e.preventDefault(); if (!e.repeat) openPalette({ from: 'switcher' }); return; }
  if (altOnly && e.code === 'KeyS') { e.preventDefault(); if (!e.repeat) star(state.entries[state.sel]); return; }
  if (altOnly && e.code === 'KeyP') { e.preventDefault(); if (!e.repeat) captureOne(state.entries[state.sel]); return; }
  if (e.ctrlKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); return cycleScope(ahead(k)); }
  // Shift+F10 or the menu key: the selected card's menu (everything its buttons do, and ticking it).
  if ((k === 'F10' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) || k === 'ContextMenu') {
    e.preventDefault();
    menuKeyAt = performance.now(); // Chrome's own context menu follows the key: not this time
    if (!e.repeat) cardMenu();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') { e.preventDefault(); el.search.focus(); el.search.select(); return; }
  // Ctrl+K (⌘K): the command palette (Esc comes back here).
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); if (!e.repeat) openPalette({ from: 'switcher' }); return; }
  // Ctrl+Z undoes what was last done here: a close, a merge, a move (in a search box with text, it stays the box's own undo).
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyZ' && !el.search.value) { e.preventDefault(); if (!e.repeat) undoLast(); return; }
  // Ctrl+Space (⌘Space) ticks or unticks the selected card; Space alone is its big preview.
  if (k === ' ' && (e.ctrlKey || e.metaKey) && !e.altKey) {
    e.preventDefault();
    const cur = state.entries[state.sel];
    if (!e.repeat && cur && (cur.kind === 'tab' || cur.kind === 'group')) pick(cur);
    return;
  }
  // Shift+arrows tick a range from the selected card (not while typing, where they select text, nor in the dropdown).
  if (e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && k.startsWith('Arrow') && !typing && !((k === 'ArrowUp' || k === 'ArrowDown') && ddShown())) {
    e.preventDefault();
    return extendPick(k);
  }
  // 1-9 switch straight to the card with that number: Alt+number always (Alt may still be held from
  // Alt+Q), a plain number only while the search box doesn't have the focus: there it is search text, so a
  // title that starts with a number can be found ("2024 report").
  const searchFocused = document.activeElement === el.search;
  if (/^Digit[1-9]$/.test(e.code) && !e.ctrlKey && !e.metaKey && (altOnly || (!e.altKey && !e.shiftKey && !searchFocused && !el.search.value))) {
    e.preventDefault();
    if (e.repeat) return;
    if (!keysAllowed()) return finish('cancel');
    const i = Number(e.code.slice(5)) - 1;
    if (i < state.openCount) choose(i);
    return;
  }

  // Backspace in the empty search box: out of the group view (like going up a folder).
  if (k === 'Backspace' && state.inGroup !== null && !el.search.value && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (!e.repeat) leaveGroup();
    return;
  }

  switch (k) {
    case 'Escape':
      e.preventDefault();
      e.stopPropagation();
      if (el.search.value) { el.search.value = ''; state.query = ''; refresh(); }
      else if (state.dupesView) dupesView(false);
      else if (state.picked.size) clearPicks();
      else if (state.inGroup !== null) leaveGroup(); // the group view, back to all the tabs (Esc again closes Tabazing)
      else finish('cancel');
      return;
    case 'Enter':
      e.preventDefault();
      // Shift+Enter: what was typed, as an address or a Google search. With the dropdown up: its row.
      if (state.query.trim() && e.shiftKey) return openFromBox(state.query.trim());
      if (ddShown()) return ddActivate(state.dd.items[state.dd.hi]); // only the row you can see (a hidden dropdown is not a choice)
      return choose(state.sel);
    case ' ': // Space, with nothing typed: the selected card's big preview
      if (!el.search.value && !e.altKey && !e.ctrlKey && !e.metaKey && state.entries[state.sel]) { e.preventDefault(); openBig(state.entries[state.sel]); }
      return;
    case 'Tab': e.preventDefault(); return cycle(e.shiftKey ? -1 : 1); // (Alt held: see the top)
    case 'ArrowRight': case 'ArrowLeft': if (!typing) { e.preventDefault(); moveSpatial(ahead(k), 0); } return;
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
  if (state.modal || document.querySelector('.bigback') || archiveOpen() || historyOpen() || bookmarksOpen() || drawerOpen() || backupOpen() || settingsOpen() || el.search.value || !state.entries.length) return stopHolding();
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
    relayout();
    if (!state.palette) el.search.focus({ preventScroll: true });
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

let resizeFrame = 0;
function listen() {
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  el.search.addEventListener('beforeinput', (e) => { if (altDown) e.preventDefault(); });
  el.search.addEventListener('input', () => {
    if (altDown && el.search.value !== state.query) { el.search.value = state.query; return; } // slipped through anyway
    // '>' first: the command palette, with whatever followed it; the box keeps what it had.
    if (el.search.value.startsWith('>')) {
      const rest = el.search.value.slice(1).trimStart();
      el.search.value = state.query;
      return openPalette({ from: 'switcher', text: rest, saved: state.query });
    }
    state.query = el.search.value; state.dd.hidden = false; state.dd.hi = 0; state.dd.hiKey = null;
    startSearch(state.query.trim());
    if (!searchFrame) searchFrame = requestAnimationFrame(flushSearch); // once per frame, however fast the typing
  });
  el.palInput.addEventListener('input', onPaletteInput);
  el.palList.addEventListener('mousedown', (e) => e.preventDefault()); // keep the focus (and the caret) in the palette's box
  // A click anywhere but the search box or its dropdown closes the dropdown (typing brings it back).
  document.addEventListener('mousedown', (e) => {
    if (!(e.target instanceof Element) || e.target.closest('.search, .dd')) return;
    if (!state.dd.hidden && state.dd.items.length) { state.dd.hidden = true; renderDropdown(); }
  }, true);
  el.newtab.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pointerAllowed()) openNewTab({ group: state.inGroup });
  });
  el.sweepBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pointerAllowed()) captureAll();
  });
  el.starFilter.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) toggleStarFilter(); });
  el.sort.addEventListener('click', (e) => e.stopPropagation());
  el.sort.addEventListener('change', () => { setSort(el.sort.value); el.search.focus(); });
  const on = (node, fn) => node.addEventListener('click', (e) => { e.stopPropagation(); if (pointerAllowed()) fn(e); });
  on(el.menuBtn, () => openDrawer());
  on($('drawer-close'), () => closeDrawer());
  el.drawerBack.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === el.drawerBack && pointerAllowed()) closeDrawer(); }); // beside it: closes it, not the switcher
  $('drawer').addEventListener('click', (e) => e.stopPropagation());
  // the shortcuts the menu's buttons have (as the browser's own: the history, the bookmark manager)
  $('history-btn-key').textContent = IS_MAC ? '⌘Y' : 'Ctrl+H';
  $('bookmarks-btn-key').textContent = IS_MAC ? '⌘⌥B' : 'Ctrl+Shift+O';
  on($('settings-btn'), () => openSettings(el.menuBtn));
  on($('backup-btn'), () => openBackup());
  on($('archive-btn'), () => openArchive().catch((err) => toast(t('errArchiveOpen'), err)));
  on($('history-btn'), () => openHistory().catch((err) => toast(t('actFailed'), err)));
  on($('bookmarks-btn'), () => openBookmarks().catch((err) => toast(t('bmvErr'), err)));
  on(el.keysBtn, () => openShortcuts());
  on($('github-btn'), () => openUrl(REPO_URL)); // a new tab, beside the page Tabazing was opened from
  on(el.dupesBtn, closeDupes);
  on(el.mergeBtn, () => mergeWindows(state.otherWindows));
  on(el.closedMore, () => { state.closedMore = !state.closedMore; refresh(); });
  on(el.groupLeave, leaveGroup);
  // The note at the bottom waits while the pointer or the focus is on it (its Undo stays reachable).
  el.toast.addEventListener('mouseenter', toastPause);
  el.toast.addEventListener('focusin', toastPause);
  el.toast.addEventListener('mouseleave', () => setTimeout(toastResume, 0));
  el.toast.addEventListener('focusout', () => setTimeout(toastResume, 0));
  on(el.selAll, selectAll);
  on(el.selNone, clearPicks);
  on(el.playerPrev, () => playerDo('previoustrack'));
  on(el.playerToggle, () => playerDo('toggle'));
  on(el.playerNext, () => playerDo('nexttrack'));
  on(el.playerMore, openMediaList);
  // A click on empty space never closes Tabazing (Esc does): it is too easy to hit between the cards and the
  // header's controls. Only the palette leaves on a click beside it, as a dialog does: with it up everything
  // else is inert (or, opened with Alt+R, not shown at all).
  el.app.addEventListener('click', (e) => {
    if (state.palette && !el.palette.contains(e.target) && pointerAllowed()) { if (state.palette.from === 'shortcut') finish('cancel'); else exitPalette(); }
  });
  window.addEventListener('mousemove', (e) => {
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
  // Dragging a window's edge sends a resize event per mouse move: one redraw per frame is enough.
  window.addEventListener('resize', () => {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; if (!state.done) { relayout(); settingsLayout(); } });
  });
  window.addEventListener('contextmenu', (e) => { if (menuKeyAt && performance.now() - menuKeyAt < 1000) e.preventDefault(); }); // the card's menu took that key
  el.scroller.addEventListener('scroll', hideTip, { passive: true });
  setupDropZones();
  document.addEventListener('dragend', endDrag); // (its card may be gone by then: a drop redraws the cards)
  document.addEventListener('drop', (e) => { if (!e.defaultPrevented) { e.preventDefault(); endDrag(); } }); // (a link dropped anywhere else isn't opened as a page in Tabazing's frame)
  for (const type of ['dragenter', 'dragover']) document.addEventListener(type, (e) => { const d = dragged(e); if (d && d.link) e.preventDefault(); });
  // Holding Alt after Alt+Q / Alt+W, the wheel steps through the tabs: down to the next card (like W), up to the one before (like Q); letting
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
    // Every area that scrolls on its own must be listed here, or the wheel does nothing over it (the palette's list was missing once).
    if (!(e.target instanceof Element) || !e.target.closest('#scroller, .wins, .modal-back, .dd, .menu, .archbody, .mlist, .setbody, .settabs, .pallist, .biggrid')) e.preventDefault();
  }, { passive: false });

  // Only the background service worker may move the selection (content
  // scripts always have sender.tab; the worker doesn't).
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (state.done || sender.id !== chrome.runtime.id || sender.tab) return;
    if (msg && msg.type === MSG.CYCLE) {
      if (msg.palette === true) openPalette({ from: state.palette ? state.palette.from : 'switcher' }); // Alt+R
      else if (msg.dir === 0) stopHolding(); // Alt+E: stay open
      else qPress(msg.dir === -1 ? -1 : 1, msg.hold === true);
      respond({ ok: true });
    }
  });
  chrome.tabs.onRemoved.addListener((id) => { if (!state.done) forgetTab(id); });
  // Groups made, renamed, recoloured, collapsed or gone, and tabs moved into or out of one, in Chrome while
  // Tabazing is open: read again (once for a burst).
  let groupsTimer = 0;
  const groupsChanged = () => { clearTimeout(groupsTimer); groupsTimer = setTimeout(() => { if (!state.done) reload(); }, 150); };
  if (chrome.tabGroups) for (const ev of ['onCreated', 'onUpdated', 'onRemoved']) if (chrome.tabGroups[ev]) chrome.tabGroups[ev].addListener(groupsChanged);
  chrome.tabs.onUpdated.addListener((id, info) => { if (!state.done && info && info.groupId !== undefined) groupsChanged(); });
  // A preview saved while we are open (the current tab's, grabbed just before we opened, is stored as we
  // load): show it on its cards.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[KEY.MEDIA] && !state.done) refreshMedia(); // a page started, stopped or changed its media
    if (area !== 'local' || state.done) return;
    const hit = [];
    if (changes[KEY.SNOOZED]) { getSnoozed().then((list) => { state.snoozed = list; drawLater(); }).catch(() => {}); }
    for (const [k, ch] of Object.entries(changes)) {
      if (!k.startsWith('pv:') || !ch.newValue || typeof ch.newValue.img !== 'string') continue;
      for (const id of state.urlTabs.get(k.slice(3)) || NONE) { state.previews[id] = ch.newValue; state.pvPending.delete(id); hit.push(id); }
    }
    if (hit.length) drawLater(hit); // just those cards (and the window list's pictures)
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
  // The settings are read once, here: the language, the colours, and (load) which tabs to ask Chrome for.
  const [bootPrefs, resume] = await Promise.all([getPrefs().catch(() => PREFS_FALLBACK), takeResume().catch(() => null)]);
  setLang(bootPrefs.lang);
  applyAccent(bootPrefs.accent);
  applyTheme(bootPrefs.theme);
  localizePage();
  fancySelect(el.sort);
  listen();
  watchVisibility();
  // Alt+R: the palette shows at once, before any tab is read (they fill it in as they come).
  if (CTX.palette) {
    el.app.hidden = false;
    openPalette({ from: 'shortcut' });
    if (CTX.mode === 'overlay') {
      parent.postMessage({ tabazing: FRAME_MSG.READY, light: document.documentElement.classList.contains('light') }, '*');
      readyAt = performance.now();
    }
    window.focus();
  }
  const mediaRead = loadMedia().catch(() => []); // the player's list, read alongside the tabs
  chrome.runtime.sendMessage({ type: MSG.MEDIA_CHECK }).catch(() => {}); // ...and checked with the pages (the list follows)
  await load(bootPrefs, { previews: false });
  searchPlaceholder();
  if (resume) { // back after capturing one tab's preview: show what was there before
    state.query = el.search.value = typeof resume.query === 'string' ? resume.query : '';
    state.scope = resume.scope === 'all' || Number.isInteger(resume.scope) ? resume.scope : 'all';
    state.starOnly = !!resume.starred;
  }
  derive();
  // Opened from a tab outside the group Tabazing was inside of (you went elsewhere, in Chrome itself or by picking
  // a tab outside it here): the group is left, and every way of opening shows all the cards.
  if (state.inGroup !== null && !state.tabs.some((x) => x.id === CTX.srcTab && x.groupId === state.inGroup)) {
    state.group = null;
    setGroup(null).catch(() => {});
    derive();
  }
  const mru = state.mruOrder;
  // By recent use, the first Alt+W goes to the tab used just before this one, as Alt+Tab does, even when it is pinned
  // (shown first); every other step follows the cards as shown.
  const before = state.sort === 'recent' && state.inGroup === null && CTX.dir > 0 ? mru.find((e) => e.key !== 't' + CTX.srcTab) : null;
  const firstStep = () => { if (before) return before.key; const s = stepFrom('t' + CTX.srcTab, CTX.dir); return s.leave ? stepOutOfGroup(CTX.dir) : s.key; };
  // Alt+Q / Alt+W start one card before / after the current tab (in the group view, past its ends out of it),
  // Alt+E (dir 0) on the current tab itself; anything else (the toolbar icon, opening with Chrome) on the tab
  // used before it.
  const first = resume && typeof resume.key === 'string' ? resume.key
    : CTX.hold ? firstStep()
    : CTX.dir === 0 ? 't' + CTX.srcTab
    : mru.length > 1 ? mru[1].key : null;
  const at = first ? state.entries.findIndex((e) => e.key === cardKey(first)) : -1;
  if (first && at < 0) { const e = mru.find((x) => x.key === first); if (e && e.sec) { state.peek.add(e.sec); derive(); } }
  state.sel = Math.max(0, first ? state.entries.findIndex((e) => e.key === cardKey(first)) : 0);
  // The previews of what the first draw shows (reading all of them, 50 KB each, kept it waiting); the rest
  // right after it.
  await loadPreviews(firstShown());
  derive(); // (the cards' entries carry their previews)
  state.media = await mediaRead;
  el.app.hidden = false;
  render();
  loadPreviews(state.tabs).then((ids) => { if (ids.length) drawLater(ids); });
  if (CTX.mode === 'overlay') {
    parent.postMessage({ tabazing: FRAME_MSG.READY, light: document.documentElement.classList.contains('light') }, '*');
    readyAt = performance.now();
  }
  window.focus();
  (state.palette ? el.palInput : el.search).focus({ preventScroll: true });
  // Then "Recently closed" and starred pages that aren't open; drawn once the opening animation is over,
  // so it doesn't restart on the cards.
  loadExtras().then(() => drawLater()).catch(() => {});
  if (!resume) firstRun();
  healthCheck();
  try {
    const r = await chrome.runtime.sendMessage({ type: MSG.READY });
    const extra = r && Number.isInteger(r.extra) ? r.extra : 0;
    for (let i = 0; i < Math.abs(extra); i++) qPress(Math.sign(extra));
    // Keys pressed while it was still loading, as when it is open: Alt+E keeps it open, Alt+R opens the palette.
    if (r && r.stay === true) stopHolding();
    if (r && r.palette === true) openPalette({ from: state.palette ? state.palette.from : 'switcher' });
  } catch {}
})();

// For the unit tests (tests/): everything above, by name. Nothing in the extension imports this file.
export {
  CTX, $, el, IS_MAC, state, ICON, urlOf, favicon, hostOf, h, load, loadExtras, loadStarPreviews, hashOf,
  loadClosed, closedFor, fieldIndex, fieldOf, typoDistance, typoMemo, typoNear, inOrder, wordScore, scoreWord,
  searchScore, matches, queryWords, fieldHit, matchTier, highlight, hlSpan, isStarred, siteOf, byTitle,
  winRank, FILTERS, SORTERS, STATUS, statusText, tabStatus, pageStatus, sectionsFor, deriveSearch, derive, GRID_GAP, CARD_SIZES, cardWidth, renderWindows,
  windowTag, thumbFor, starButton, canCapture, captureButton, DAY_MS, tabAge, renderCard, finishCard,
  onMiddleClick, ddMiddle, renderSection, renderTools, render, renderCount, tipTruncated, setTop, toTop, refresh, select, stepKey,
  cycle, selectKey, moveSpatial, cardToward, toggleSection, setSort, setFilter, toggleStarFilter, star,
  captureOne, setScope, cycleScope, finish, choose, closeTab, forgetTab, pickBox, pick, pickPool,
  selectAll, clearPicks, targets, ACTIONS, renderActs, renderDupesBar, dupesView, toastTimer, toast,
  undoRecord, pushUndo, undoLast, reopenAt, reload, closeMany, copyText, copyLinks,
  moveToWindow, googleUrl, asUrl, openFromBox, DD_MAX, DD_SOURCES, loadMarks, hist, loadHistory, histTimer,
  searchHistory, histMemo, historyItems, urlKeys, urlKey, bigHits, fullTimer, scoreBig, fullPass, NONE, ddRows,
  searchFrame, flushSearch, ddShown, ddMove, ddHighlight, ddPics, ddPic, renderDropdown, ddActivate,
  restoreClosed, openPage, mergeWindows, snoozeChoices, whenLabel, snoozeMenu, snoozeTabs, unsnooze, drag,
  clearDrop, dropAfter, dragToMove, dragToOpen, cardDrop, openDropped, moveToWin, startDrag, endDrag, moveTabs, moveGroup, addToGroup, groupFlags, sleepTabs, pinTabs, muteTabs, dupeUrls, duplicates, closeDupes,
  isMuted, audioBadge, togglePin, toggleMute, reloadTab, duplicateTab, loadArchived, archiveTabs, unarchive,
  openArchived, archiveOpen, openArchive, archiveCard, dropArchived, archivedBehind, archSelect, closeArchive, archiveKey,
  viewKey, backupOpen, openBackup, closeBackup, exportBackup, importBackup, backupKey, BACKUP_KINDS, drawerOpen, openDrawer, closeDrawer, drawerKey, viewBack, viewDialog, historyOpen, openHistory, moreHistory, historyItem, histSelect, closeHistory, removeHistory, historyMenu, historyKey, HISTORY_PAGE, deleteButton, findHistory, searchField,
  refreshHistory, setHistoryLayout, histPick, agoShort, agoTag, showTip, historyMoreFrom, historyForgetSite, dayLabel, confirmDialog, fetchHistory,
  bookmarksOpen, openBookmarks, closeBookmarks, drawBookmarks, bmvRows, bmvSelect, bmvToggle, bmvPick, bmvDelete, bmvEdit, bmvMenu, bmvKey, bmvNote, webAddress, bmNoteOf, reloadBookmarks,
  bmvMove, bmvSort, bmvNudge, bmvOpenAll, bmvImportStars, bmvFilter, bmvFind, bmvOpenSiblings, bmvMoveDialog,
  quickActions, noteOf, paintNote, noteButton, TIP_DELAY_MS, DATE_TIP_DELAY_MS, tipTimer, noteTip, hideTip, notePopover, bigEntry,
  openBig, closeBig, closePops, menu, fancySelect, asking, K, para, button, showDialog, closeDialog,
  whenTapMode, keyRows, ALT, TOUR_ALL, TOUR, tourAt, tourStep, placeTour, endTour, openUrl, reviewDone,
  goReview, askStep1, askStep2, askLater, showAlert, requestHostAccess, missingPreviews, updateSweepButton,
  plainCaptureError, healthCheck, lightMq, themePref, applyTheme, openSettings, closeSettings, settingsOpen, settingsSelect, settingsTabKey, settingsLayout, settingsKey, settingsPanes,
  settingsCommands, settingsDetach, commandRow, keyCaps, COMMANDS, SHORTCUTS_URL, SETTINGS_NARROW_W, SETTINGS_CATS, shortcutSections, firstRun, dialogKey, MODIFIERS,
  altDown, trackAlt, onKeyDown, qPress, altReleased, stopHolding, onKeyUp, visibleSince, everVisible, bootedAt,
  watchVisibility, pointerAllowed, readyAt, stuckFallback, keysAllowed, listen, getLaunch, syncCombo, focusMark,
  refocus, mouseOnly, toastAct, toastUndo, tipHide, hideTipSoon, updateInert, TABBABLE, tabbables, focusLayer,
  keepFocusIn, menuKeyAt, cardMenu, dialogBack, svgTpl, svgOf, PREFS_FALLBACK, loadPreviews, FIRST_PREVIEWS,
  firstShown, loadSnoozePreviews, shots, shotImg, redrawCards, redraw, topOf, cardList, selCard, cardAt,
  drawLater, dupeMemo, dupeIds, resizeFrame, relayout, switchToTab, currentMedia, mediaPreview, mediaPics, mediaPic,
  loadMediaPreviews, DOUBLE_PRESS_MS, paintToggle, playerSig, renderPlayer, renderMedia, mediaLoading, refreshMedia, mediaDo, playerDo,
  pickMedia, goToMedia, mediaOrder, openMediaList, renderMediaList, mediaRow, mediaButton,
  previewBatch, gridColumns, deriveHits, markHits, pref, wokenTag, pinnedBadge, headButtons, layoutHeader, NARROW_W, TIGHT_W,
  toastRun, toastPause, toastResume, placeToast, toastLeft, moveBack, UNDO_SESSION_MS, localInput, snoozePicker, extendPick,
  applyLines, searchPlaceholder, shortcutGroups, openShortcuts, ICON_TIPS,
  searchFor, foundFor, foundMemo, searchText, renderSearch, ddTitleRow, ddRowEl, openNewTab, captureAll, startSearch, setTheme,
  PAL_SOURCES, PAL_TYPED_MAX, PAL_USEFUL, ZOOMS, srcTabInfo, srcTab, srcEntry, tabName, isWeb, staleTabs, otherTabs, chromePage,
  PAL_ACTIONS, PAL_BY_ID, paletteActions, inEnglish, actionFields, paletteItems, PAL_ICON, paletteActionRow, paletteQuickRow,
  paletteCurrencyRow, palFrame, renderPalette, palHighlight, palMove, openPalette, exitPalette, palRun, copyQuick, runAction,
  paletteKey, onPaletteInput, nextZoom, zoomTab, toggleFullscreen, PALETTE_KEY, dropFrom,
  groupTiles, cardKey, stepFrom, stepOutOfGroup, GROUP_COLORS, groupColor, groupName, renderGroupCard, renderGroupBar, showsTab, enterGroup, leaveGroup,
  cardName, cardTabs, tickChanged, regroup, reopenPage, groupFor, closedQuick, reopenInWindow, reopenBehind, snoozeClosed, archiveClosed, forgetClosed, afterClosedChange, ungroup,
  pageOf, markFolders, bookmarkDialog, noteBits, groupTag, groupMenu, newGroup, editGroup, groupEditor, ungroupTabs, groupToWindow, collapseGroup, srcGroup, groupEntry, openBigGroup, nextColor,
};
