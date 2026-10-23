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

import { MESSAGE, KEY, FRAME_MESSAGE, LIMITS, REVIEW_URL, REPO_URL, siteUrl } from './utils/constants.js';
import { getNoCapture, getMru, getPreviews, getClosedLog, getSlept, consumeLaunch, getReview, updateReview, getOnboard, updateOnboard, getCaptureNote, getStars, toggleStar, getNotes, setNote, getSharpPreview, getSnoozed, addSnoozed, removeSnoozed, getWoken, getView, updateView, setResume, takeResume, getPreferences, updatePreferences, getPaletteRecent, notePaletteRecent, getGroup, setGroup, getClosedHidden, hideClosed, closedKey, getBookmarkNotes, putBookmarkNotes, setBookmarkNote, checkStandby } from './utils/store.js';
import { reviewPrompt, dayOf } from './utils/review.js';
import { timeAgo, localizePage, setLang, languageLoaded, uiLang, isRtl } from './utils/i18n.js';
import { translate, getLocale, setLocale } from './utils/translations.js';
import { isOwnUrl, normalizeUrl, isWorthReopening, isCapturableUrl } from './utils/extension.js';
import { applyAccent, ACCENTS } from './utils/accent.js';
import { ARCHIVE_FOLDER, getArchived, addArchived, removeArchived } from './utils/archive.js';
import { makeBackup, restoreBackup, readBackup, unzipFiles, zipFiles, backupName } from './utils/backup.js';
import { loadMedia, mediaAction } from './utils/media.js';
import { asUrl, googleUrl } from './utils/web.js';
import { quick } from './utils/quick.js';
import { GROUP_COLORS, putInGroup, cleanGroup, groupOf } from './utils/groups.js';

// ----------------------------------------------------------------- timings
// How long opening takes, as performance marks and measures (DevTools > Performance, or timings() below):
//   tabazing:module    page start -> this script running (loading and parsing the code and the dictionaries)
//   tabazing:cards     launched -> the first cards drawn (an overlay is prepared ahead and waits for its launch)
//   tabazing:prepare   a prepared frame reading and drawing everything ahead (before any launch)
//   tabazing:render    the first draw itself (building the cards and laying them out), launched or not
//   tabazing:visible   launched -> the first frame after the switcher said it is ready (on screen from then)
//   tabazing:previews  launched -> every open tab's preview drawn
//   tabazing:search    a keystroke in the search box -> its results drawn (the last one)
const mark = (name) => { try { performance.clearMarks('tabazing:' + name); performance.mark('tabazing:' + name); } catch {} };
const measure = (name, from) => { try { performance.clearMeasures('tabazing:' + name); performance.measure('tabazing:' + name, from && 'tabazing:' + from, 'tabazing:' + name + '-end'); } catch {} };
const markEnd = (name, from) => { mark(name + '-end'); measure(name, from); };
/** The measured times in milliseconds (rounded), by name: { module, render, cards, previews, search }. */
function timings() {
  const out = {};
  for (const entry of performance.getEntriesByType('measure')) if (entry.name.startsWith('tabazing:')) out[entry.name.slice(9)] = Math.round(entry.duration);
  return out;
}
markEnd('module');

let CONTEXT = null; // set once the launch token has been verified (see boot)

const byId = (id) => document.getElementById(id);
const elements = {
  app: byId('app'), bar: document.querySelector('.bar'), search: byId('search'), count: byId('count'),
  windows: byId('windows'), tools: byId('tools'), scroller: byId('scroller'), newTab: byId('new-tab'),
  starFilter: byId('star-filter'), starCount: byId('star-count'), quickFilters: byId('quick-filters'), mergeButton: byId('merge-button'), mergeText: byId('merge-text'),
  snoozedSection: byId('snoozed-section'), snoozedGrid: byId('snoozed-grid'), sort: byId('sort'), sweepText: byId('sweep-text'), closedHeading: byId('closed-heading'),
  openGrid: byId('open-grid'), openEmpty: byId('open-empty'),
  closedSection: byId('closed-section'), closedGrid: byId('closed-grid'),
  keysButton: byId('keys-button'), closedMore: byId('closed-more'),
  sweepButton: byId('sweep-button'),
  duplicatesButton: byId('duplicates-button'), duplicatesText: byId('duplicates-text'),
  alert: byId('alert'), alertText: byId('alert-text'), alertButton: byId('alert-button'),
  actions: byId('actions'), actionsCount: byId('actions-count'), actionsButtons: byId('actions-buttons'), selectAll: byId('select-all'), selectNone: byId('select-none'), actionsHint: byId('actions-hint'),
  body: byId('body'),
  toast: byId('toast'), clip: byId('clip'), modal: byId('modal'), dialog: byId('dialog'),
  live: byId('live-status'), liveAlert: byId('live-alert'), archiveButton: byId('archive-button'), menuButton: byId('menu-button'), drawerBack: byId('drawer-back'),
  player: byId('player'), playerPicture: byId('player-picture'), playerTitle: byId('player-title'), playerSubtitle: byId('player-subtitle'),
  playerPrevious: byId('player-previous'), playerToggle: byId('player-toggle'), playerNext: byId('player-next'), playerMore: byId('player-more'),
  palette: byId('palette'), paletteInput: byId('palette-input'), paletteList: byId('palette-list'), paletteFoot: byId('palette-foot'),
  openHeading: byId('open-heading'), groupLeave: byId('group-leave'), groupDot: byId('group-dot'), groupCount: byId('group-count'),
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
  selected: 0,
  holding: false,  // Alt still held from Alt+Q / Alt+W? They work like Alt+Tab: letting go of Alt switches
  done: false,
  cardWidth: 320,      // current open-card width (px), set by render()
  slept: new Set(), // ids of tabs we saw Chrome discard in this browser session
  sections: [],    // derived: [{ key, title, entries }] for the open tabs (one plain list, or one per page in the duplicates view)
  mruOrder: [],    // derived: open entries in most-recently-used order (what Alt+Q cycles through)
  savedCount: 0,
  hostAllowed: true,   // does Tabazing have access to all sites (not withheld by Chrome's Site access setting)?
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
  historyQuery: { query: '', items: [] }, // Chrome's own history search for the current text (reaches further back)
  foundClosed: [], // derived: recently closed tabs matching the search (the dropdown)
  foundQuery: '',      // the text `found` and `foundClosed` are for (trimmed, lower case)
  palette: null,   // the command palette, while it shows: { from: 'shortcut' | 'switcher', saved, hi, items }
  paletteRecent: [],   // ids of the palette's actions, most recently run first (utils/store.js getPaletteRecent)
  dropdown: { items: [], highlighted: 0, hidden: false }, // the dropdown under the search box: rows, the highlighted one
  collapsed: new Set(), // section keys the user collapsed (kept between opens)
  peek: new Set(),      // collapsed sections opened for this visit only (Alt+Q landed on a tab inside)
  capturing: null,      // tab id whose preview is being captured from its card
  starPreviews: {},     // normalized URL -> preview, for starred pages that aren't open
  matchCount: 0,        // open tabs that match the filters, collapsed or not
  picked: new Set(),    // tab ids ticked for a quick action (close, copy, move...)
  undo: [],             // what can be undone, last at the end: [{ kind: 'close'|'merge'|'move', tabs: undoRecord(...), at }] (Ctrl+Z)
  lastPick: null,       // the last card ticked: where a Shift+click on a tick box, or Shift+arrows, range from
  shiftBase: null,      // the ticks before a run of Shift+arrows began (the run's range is added to them)
  preferences: null,    // the settings (utils/store.js getPreferences), as load() last read them
  woken: {},            // tab id -> when a snooze brought it back (utils/store.js getWoken): "Back from snooze"
  hits: null,           // derived while searching: keys of the cards that match it (the others are dimmed)
  closedMore: false,    // "Show more" under Recently closed: everything up to the search's limit
  noCapture: new Set(),     // pages Chrome refused to screenshot: no "Capture preview" there
  toSleep: new Set(),   // tab ids to unload when the switcher closes
  duplicatesView: false,     // showing only the duplicate copies, before closing them
  matches: [],          // derived: the open tabs the filters let through
  archived: null,       // the "Tabs Archive" bookmarks folder: [{ id, url, title, t }] newest first (utils/archive.js)
  archivePreviews: {},  // normalized URL -> preview, for archived pages
  archiveSelected: 0,           // the selected card in the archive overlay
  historyView: null,           // the history overlay while it is open: its pages (entries), the selected one, its parts
  bookmarksView: null,            // the bookmarks overlay while it is open: the tree by id, open folders, picked bookmarks, the rows shown
  bookmarkNotes: {},    // notes on bookmarks, by bookmark id (utils/store.js getBookmarkNotes)
  backup: null,         // the Backup & Restore dialog while it is open
  urlTabs: new Map(),   // normalized URL -> ids of the tabs open there (load())
  previewPending: new Set(), // tab ids whose previews aren't read yet (boot: the first cards' come first)
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
  markdown: '<svg viewBox="0 0 16 16" width="15" height="13" aria-hidden="true"><rect x="1" y="3.5" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M3.5 10V6l1.8 2 1.8-2v4M10.5 6v4M9 8.5l1.5 1.5L12 8.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M6 2.5h4l-.6 4 2.6 2.5H4l2.6-2.5zM8 9v4.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  reload: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M13.2 8.2A5.2 5.2 0 1 1 11.6 4.4M13.2 2.4v3.2H10" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  duplicate: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  muted: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor"/><path d="M10.5 6l4 4M14.5 6l-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  tab: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.8 13.5V5.2c0-.7.5-1.2 1.2-1.2h3.4l1.4 2h5.2c.7 0 1.2.5 1.2 1.2v6.3zM1.8 13.5h12.4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>',
  bookmark: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 2.2h8v11.6L8 10.9l-4 2.9z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/></svg>',
  visited: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="5.8" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M8 4.8V8l2.3 1.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  archive: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.8 3h12.4v3H1.8zM2.8 6v7h10.4V6M6.3 8.6h3.4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  previous: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3v10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13 3.6v8.8a.5.5 0 0 1-.8.4L5.9 8.4a.5.5 0 0 1 0-.8l6.3-4.4a.5.5 0 0 1 .8.4Z" fill="currentColor"/></svg>',
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
  calculator: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="3" y="1.8" width="10" height="12.4" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M5.3 4.5h5.4M5.5 8h1M9.5 8h1M5.5 11h1M9.5 11h1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
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
  try { const parsedUrl = new URL(url); return parsedUrl.host || parsedUrl.protocol.replace(':', ''); } catch { return ''; }
}
function makeElement(tag, className, text, testid) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  if (testid) element.dataset.testid = testid; // what the tests select elements by (tests/: never by class, id or role)
  return element;
}
// An icon (ICON markup) as nodes: parsed once per icon, then cloned. A redraw draws thousands of them, and
// parsing the SVG text for each one (innerHTML) was most of a card's cost.
const svgTemplates = new Map();
function svgOf(markup) {
  let template = svgTemplates.get(markup);
  if (!template) { template = document.createElement('template'); template.innerHTML = markup; svgTemplates.set(markup, template); }
  return template.content.cloneNode(true);
}

// ------------------------------------------------------------------- data
// What the cards need, all read at once (each read is a round trip to Chrome's storage). "Recently
// closed" and starred pages that aren't open come after the first draw: loadExtras().
// `prefs`: already read (at boot), so the tabs are asked for at once. `previews: false` leaves the previews
// out (state.pvPending): at boot only the first cards' are read before the first draw (loadPreviews).
const PREFERENCES_FALLBACK = {
  lang: 'auto', cardSize: 'default', allWindows: false, theme: 'system', pinnedFirst: true, showClosed: true, showSnoozed: true, showGroups: true, groupWrap: false,
  showAge: true, ownWindow: false, titleLines: 2, searchHistory: true, searchBookmarks: true, lite: false, iconTips: 0,
};
// Settings -> Lite mode: each card shows its page's icon, never a screenshot (none are read, or taken), and
// nothing animates. For slow computers and windows with hundreds of tabs.
const isLite = () => preference('lite') === true;
const readPreviews = (urls) => (isLite() ? Promise.resolve({}) : getPreviews(urls));
// By recent use (`mru`: tab ids, most recent first), the current tab first of all; then by window and position.
function sortByUse(tabs, mru) {
  const rank = new Map(mru.map((id, i) => [id, i]));
  const rankOf = (tab) => (tab.id === CONTEXT.sourceTab ? -1 : rank.has(tab.id) ? rank.get(tab.id) : Infinity);
  const inSourceWindow = (tab) => (tab.windowId === CONTEXT.sourceWindow ? 0 : 1);
  return tabs.sort((firstTab, secondTab) => rankOf(firstTab) - rankOf(secondTab) || inSourceWindow(firstTab) - inSourceWindow(secondTab) || firstTab.windowId - secondTab.windowId || firstTab.index - secondTab.index);
}

async function load(preferences = null, { previews = true } = {}) {
  const preferencesRead = preferences ? Promise.resolve(preferences) : getPreferences().catch(() => PREFERENCES_FALLBACK);
  const tabsRead = preferencesRead.then((resolvedPreferences) => chrome.tabs.query(resolvedPreferences.allWindows ? { windowType: 'normal' } : { windowId: CONTEXT.sourceWindow }));
  const [allTabs, mru, slept, , noCapture, stars, view, notes, byUrl, browserWindows, snoozed, woken, groups, group] = await Promise.all([
    tabsRead,
    getMru(),
    getSlept().catch(() => []),
    preferencesRead,
    getNoCapture().catch(() => new Set()),
    getStars().catch(() => ({})),
    getView().catch(() => null),
    getNotes().catch(() => ({})),
    previews ? Promise.all([tabsRead, preferencesRead]).then(([all, read]) => (read.lite ? {} : getPreviews(all.map(urlOf)))).catch(() => ({})) : {}, // previews are stored by URL
    chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []),
    getSnoozed().catch(() => []),
    getWoken().catch(() => ({})),
    chrome.tabGroups ? chrome.tabGroups.query({}).catch(() => []) : [],
    getGroup().catch(() => null),
  ]);
  preferences = { ...PREFERENCES_FALLBACK, ...(await preferencesRead) };
  state.groups = new Map(groups.map((tabGroup) => [tabGroup.id, tabGroup]));
  // Inside a group that is gone (its last tab closed, or ungrouped): out of it for good.
  state.group = group !== null && state.groups.has(group) && group !== state.leftGroup ? group : null;
  if (group !== null && state.group === null) setGroup(null).catch(() => {});
  state.preferences = preferences;
  state.woken = woken;
  state.cardSize = preferences.cardSize;
  applyLines();
  state.allWindows = preferences.allWindows;
  state.otherWindows = browserWindows.filter((browserWindow) => browserWindow.id !== CONTEXT.sourceWindow && !browserWindow.incognito).map((browserWindow) => browserWindow.id);
  state.snoozed = snoozed;
  state.slept = new Set(slept);
  state.noCapture = noCapture;
  state.stars = stars;
  state.notes = notes;
  if (view) {
    state.sort = view.sort;
    state.collapsed = new Set(view.collapsed);
  }
  // This window, or all of them (Settings); Tabazing's own pages left out.
  const tabs = sortByUse(allTabs.filter((tab) => !isOwnUrl(urlOf(tab))), mru);
  state.tabs = tabs;

  // Hand each tab the preview for its current URL. The tabs of each address are kept, for a preview saved
  // while the switcher is open (listen(): storage.onChanged).
  state.previews = {};
  state.urlTabs = new Map();
  for (const tab of tabs) {
    const key = normalizeUrl(urlOf(tab));
    const preview = byUrl[key];
    if (preview) state.previews[tab.id] = preview;
    if (!state.urlTabs.has(key)) state.urlTabs.set(key, []);
    state.urlTabs.get(key).push(tab.id);
  }
  state.previewPending = new Set(previews ? [] : tabs.map((tab) => tab.id));

  // Windows in "most recently used" order, the current one first. Numbers
  // follow the order the windows were opened in, so "Window 2" stays
  // "Window 2" however you move between them.
  const order = [CONTEXT.sourceWindow];
  for (const tab of tabs) if (!order.includes(tab.windowId)) order.push(tab.windowId);
  const byAge = order.filter((id) => id !== CONTEXT.sourceWindow).sort((firstWindowId, secondWindowId) => firstWindowId - secondWindowId);
  state.windows = order
    .map((id) => {
      const windowTabs = tabs.filter((tab) => tab.windowId === id);
      const active = windowTabs.find((tab) => tab.active) || windowTabs[0];
      return {
        id,
        label: id === CONTEXT.sourceWindow ? translate('thisWindow') : translate('windowCount', { number: byAge.indexOf(id) + 2 }),
        count: windowTabs.length,
        activeTitle: active ? active.title || '' : '',
        activeId: active ? active.id : null,
        activeUrl: active ? urlOf(active) : '',
      };
    })
    .filter((windowEntry) => windowEntry.count > 0);
}
// The previews of these tabs (of those still pending), read in one go. A preview saved meanwhile (storage.onChanged) is newer: kept.
async function loadPreviews(tabs) {
  tabs = tabs.filter((x) => state.previewPending.has(x.id));
  if (!tabs.length) return [];
  const byUrl = await readPreviews(tabs.map(urlOf)).catch(() => ({}));
  for (const x of tabs) {
    state.previewPending.delete(x.id);
    const preview = byUrl[normalizeUrl(urlOf(x))];
    if (preview && !state.previews[x.id]) state.previews[x.id] = preview;
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
  const availableWidth = Math.max(0, width - 88 - (state.windows.length > 1 ? 220 : 0)); // the side paddings, the window list
  const { columns, width: columnWidth } = gridColumns(availableWidth);
  const cardH = state.cardSize === 'list' ? 40 : columnWidth * 10 / 16 + 50;
  const rows = Math.ceil(Math.max(0, height - 130) / (cardH + 16)) + 1;
  return Math.max(columns, Math.min(120, columns * rows));
}
function firstShown() {
  const out = new Set(state.entries.slice(0, previewBatch()).flatMap((entry) => (entry.kind === 'tab' ? [entry.tab] : entry.kind === 'group' ? entry.tabs.slice(0, 4) : [])));
  const currentEntry = state.entries[state.selected];
  if (currentEntry && currentEntry.kind === 'tab') out.add(currentEntry.tab);
  const tabIds = new Set([CONTEXT.sourceTab, ...state.windows.map((windowEntry) => windowEntry.activeId)]);
  for (const x of state.tabs) if (tabIds.has(x.id)) out.add(x);
  return [...out];
}

async function loadExtras() {
  const archivedPromise = loadArchived(); // archived pages are left out of "Recently closed": loadClosed waits for it
  await Promise.all([archivedPromise, loadClosed(archivedPromise), loadStarPreviews(), loadSnoozePreviews(), loadMediaPreviews()]);
}
async function loadSnoozePreviews() {
  state.snoozePreviews = await readPreviews(state.snoozed.map((x) => x.url)).catch(() => ({}));
}

// Previews of starred pages that no tab has open (shown under the Starred filter).
async function loadStarPreviews() {
  const open = new Set(state.tabs.map((tab) => normalizeUrl(urlOf(tab))));
  const urls = Object.entries(state.stars).filter(([key]) => !open.has(key)).map(([, starEntry]) => starEntry.u).slice(0, LIMITS.CLOSED_PREVIEW_LOOKUP);
  state.starPreviews = await readPreviews(urls).catch(() => ({}));
}

// "Recently closed" merges Chrome's list (only the last 25, restores a tab with
// its history) with our own 7-day log (survives Chrome's cap and restarts).
const hashOf = (text) => { let x = 5381; for (let i = 0; i < text.length; i++) x = ((x << 5) + x + text.charCodeAt(i)) | 0; return (x >>> 0).toString(36); };

// `before`: a read to wait for before using state.archived (loadExtras reads the archive alongside).
async function loadClosed(before) {
  const [sessions, closedLog, hidden] = await Promise.all([
    (async () => { try { return await chrome.sessions.getRecentlyClosed({ maxResults: 25 }); } catch { return []; } })(),
    getClosedLog().catch(() => []),
    getClosedHidden().catch(() => ({})),
    Promise.resolve(before).catch(() => {}),
  ]);
  state.closedHidden = hidden;
  const now = Date.now();
  const stamp = (session) => (session.lastModified > 0 ? session.lastModified * 1000 : 0); // 0 = Chrome gave no time (e.g. some closed windows)
  const rank = (closedEntry) => closedEntry.timestamp || now;                                         // ...which we treat as "just now" for sorting

  const items = [];
  const covered = new Set(); // pages inside a closed window that Chrome still lists as one "Window" card
  // Closed by archiving or snoozing: listed in the archive or under "Snoozed", not here (in Chrome's list either).
  const elsewhere = new Set([...(state.archived || []), ...state.snoozed].map((x) => normalizeUrl(x.url)));
  for (const session of sessions) {
    if (session.tab) {
      const url = urlOf(session.tab);
      if (!isWorthReopening(url) || elsewhere.has(normalizeUrl(url))) continue;
      items.push({ id: 's' + session.tab.sessionId, kind: 'tab', url, title: session.tab.title || '', timestamp: stamp(session), count: 1, session, fields: [[session.tab.title, url]] });
    } else if (session.window && session.window.tabs && session.window.tabs.length) {
      const tabs = session.window.tabs;
      tabs.forEach((tab) => covered.add(normalizeUrl(urlOf(tab))));
      items.push({
        id: 's' + session.window.sessionId, kind: 'window', url: urlOf(tabs[0]), title: translate('closedWindow', { tabs: translate('tabs', { count: tabs.length }) }),
        timestamp: stamp(session), count: tabs.length, session, fields: tabs.map((tab) => [tab.title, urlOf(tab)]),
      });
    }
  }
  const open = new Set(state.tabs.map((tab) => normalizeUrl(urlOf(tab))));
  elsewhere.forEach((key) => open.add(key));
  for (const logEntry of closedLog) {
    const key = normalizeUrl(logEntry.url);
    // Already open again, or part of a closed window shown as one card: skip.
    if (!isWorthReopening(logEntry.url) || covered.has(key) || open.has(key)) continue;
    items.push({ id: 'l' + logEntry.closedAt + hashOf(logEntry.url), kind: 'tab', url: logEntry.url, title: logEntry.title, timestamp: logEntry.closedAt, count: 1, session: null, fields: [[logEntry.title, logEntry.url]], group: cleanGroup(logEntry.group) });
  }

  // One entry per page: the most recent wins; within 5 s it's the same closing, so keep Chrome's (restores history).
  const best = new Map();
  for (const it of items) {
    if (it.kind === 'window') continue;
    const key = normalizeUrl(it.url) || it.url;
    const existingItem = best.get(key);
    const rankDifference = existingItem ? rank(it) - rank(existingItem) : 1;
    if (!existingItem || rankDifference > 5000 || (rankDifference >= -5000 && it.session)) best.set(key, it);
  }
  // Removed from the list (closedRemove): what was closed by then under that key stays out (one with no time, always).
  const shows = (it) => { const at = hidden[closedKey(it)]; return !at || (it.timestamp > 0 && it.timestamp > at); };
  const merged = [...items.filter((it) => it.kind === 'window'), ...best.values()].filter(shows).sort((firstItem, secondItem) => rank(secondItem) - rank(firstItem));

  const previews = await readPreviews(merged.slice(0, LIMITS.CLOSED_PREVIEW_LOOKUP).map((it) => it.url));
  for (const it of merged) it.preview = previews[normalizeUrl(it.url)] || null;
  state.closed = merged;
}

// What the "Recently closed" section shows. Normally the last few hours, a few
// entries, few whole windows; while searching, anything from the last 7 days.
// "Show more" (state.closedMore) reaches as far as a search does.
function closedFor(query) {
  if (query) return state.closed.filter((closedItem) => closedItem.fields.some(([title, url]) => matches(query, title, url, noteOf(url), pageStatus(url, 'closed')))).slice(0, LIMITS.RECENTLY_CLOSED_SEARCH);
  if (state.closedMore) return state.closed.slice(0, LIMITS.RECENTLY_CLOSED_SEARCH);
  const cutoff = Date.now() - LIMITS.RECENTLY_CLOSED_MAX_AGE_SECONDS * 1000;
  let windows = 0;
  return state.closed
    .filter((closedItem) => !closedItem.timestamp || closedItem.timestamp >= cutoff)
    .filter((closedItem) => closedItem.kind !== 'window' || ++windows <= LIMITS.RECENTLY_CLOSED_WINDOWS)
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
const foldChar = (character) => { let foldedCharacter = foldMemo.get(character); if (foldedCharacter === undefined) { foldedCharacter = character.normalize('NFD').replace(/\p{M}+/gu, ''); if (foldedCharacter.length !== character.length) foldedCharacter = character; foldMemo.set(character, foldedCharacter); } return foldedCharacter; };
const fold = (text) => { const lower = text.toLowerCase(); return /[^\x00-\x7f]/.test(lower) ? lower.replace(/[^\x00-\x7f]/g, foldChar) : lower; };
function fieldOf(text) {
  let x = fieldIndex.get(text);
  if (!x) {
    const lower = fold(text);
    const words = lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    x = { text: lower, words, initials: words.map((word) => word[0]).join(''), scores: new Map() };
    if (fieldIndex.size > 50000) fieldIndex.clear(); // big enough for all of history and the bookmarks
    fieldIndex.set(text, x);
  }
  return x;
}
// Edit distance with swaps (optimal string alignment), giving up once it is over `max`.
function typoDistance(firstWord, secondWord, maxDistance) {
  if (Math.abs(firstWord.length - secondWord.length) > maxDistance) return maxDistance + 1;
  let previousPreviousRow = null, previousRow = Array.from({ length: secondWord.length + 1 }, (_, j) => j);
  for (let i = 1; i <= firstWord.length; i++) {
    const currentRow = [i];
    let low = i;
    for (let j = 1; j <= secondWord.length; j++) {
      let value = Math.min(previousRow[j] + 1, currentRow[j - 1] + 1, previousRow[j - 1] + (firstWord[i - 1] === secondWord[j - 1] ? 0 : 1));
      if (previousPreviousRow && i > 1 && j > 1 && firstWord[i - 1] === secondWord[j - 2] && firstWord[i - 2] === secondWord[j - 1]) value = Math.min(value, previousPreviousRow[j - 2] + 1);
      currentRow.push(value);
      low = Math.min(low, value);
    }
    if (low > maxDistance) return maxDistance + 1;
    previousPreviousRow = previousRow;
    previousRow = currentRow;
  }
  return previousRow[secondWord.length];
}
// Is `word` (a word of a title or address) within a typo of the typed word `w`: the whole word, or its start
// (a word still being typed)? The same words turn up in thousands of titles, so each pair is worked out once.
const typoMemo = new Map(); // typed word -> Map(word -> boolean)
function typoNear(typedWord, word) {
  let wordCache = typoMemo.get(typedWord);
  if (!wordCache) { if (typoMemo.size > 40) typoMemo.clear(); typoMemo.set(typedWord, (wordCache = new Map())); }
  let ok = wordCache.get(word);
  if (ok === undefined) {
    const maxDistance = typedWord.length >= 8 ? 2 : 1;
    ok = [word, word.slice(0, typedWord.length), word.slice(0, typedWord.length + 1)].some((y) => y.length >= typedWord.length - maxDistance && typoDistance(typedWord, y, maxDistance) <= maxDistance);
    wordCache.set(word, ok);
  }
  return ok;
}
const inOrder = (typedWord, word) => { let i = 0; for (const character of word) if (character === typedWord[i] && ++i === typedWord.length) return true; return false; };
// One typed word against one field, remembered on the field: on the next keystroke only the word being typed is new.
function wordScore(typedWord, field) {
  let score = field.scores.get(typedWord);
  if (score === undefined) {
    score = scoreWord(typedWord, field);
    if (field.scores.size > 16) field.scores.clear();
    field.scores.set(typedWord, score);
  }
  return score;
}
function scoreWord(typedWord, field) {
  if (field.words.some((x) => x.startsWith(typedWord))) return 5;
  if (typedWord.length >= 2 && field.initials.includes(typedWord)) return 4;
  if (field.text.includes(typedWord)) return 3;
  if (typedWord.length >= 2 && field.words.some((x) => x[0] === typedWord[0] && inOrder(typedWord, x))) return 2;
  if (typedWord.length >= 4 && !/\d/.test(typedWord) && field.words.some((x) => typoNear(typedWord, x))) return 1;
  return 0;
}
// A field may be a page's state ({ status }: pageStatus, tabStatus): its words count only as typed, from their start
// (three letters or more), never as a typo, so "plain" doesn't find the tabs that are "playing".
function searchScore(query, ...fields) {
  const fs = [], statusWords = [];
  for (const field of fields) if (field && typeof field === 'object') statusWords.push(...fold(field.status).split(/\s+/).filter(Boolean)); else if (field) fs.push(fieldOf(field));
  let total = 0;
  for (const typedWord of queryWords(query)) {
    let best = Math.max(0, ...fs.map((field) => wordScore(typedWord, field)));
    if (!best && typedWord.length >= 3 && statusWords.some((statusWord) => statusWord.startsWith(typedWord))) best = 1;
    if (!best) return 0;
    total += best;
  }
  return total;
}
const matches = (query, ...fields) => searchScore(query, ...fields) > 0;
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
  const word = (statusKey) => (statusMemo.words[statusKey] ??= lang === 'en' ? translate(STATUS[statusKey].label) : translate(STATUS[statusKey].label) + ' ' + inEnglish(() => translate(STATUS[statusKey].label)));
  return kinds.filter(Boolean).map(word).join(' ');
}
const tabStatus = (x) => ({ status: statusText(x.pinned && 'pinned', x.discarded && 'asleep', x.audible && 'playing', isMuted(x) && 'muted',
  isStarred(urlOf(x)) && 'starred', noteOf(urlOf(x)) && 'note', x.groupId >= 0 && 'grouped') });
const pageStatus = (url, where = null) => ({ status: statusText(where, isStarred(url) && 'starred', noteOf(url) && 'note') });
// Where a tab matched decides its place first: its note (3), then its title (2), then its address (1);
// within each, how well it matched. A field counts if any word typed is found in it.
// A title that starts with what was typed (or with its first word) comes before one that has it elsewhere.
const queryWords = (query) => fold(query).split(/\s+/).filter(Boolean);
const fieldHit = (query, text) => !!text && queryWords(query).some((typedWord) => wordScore(typedWord, fieldOf(text)) > 0);
function matchTier(query, tab) {
  if (fieldHit(query, noteOf(urlOf(tab)))) return 4;
  const title = fold(tab.title || '').trim();
  if (title && (title.startsWith(fold(query)) || title.startsWith(queryWords(query)[0]))) return 3;
  return fieldHit(query, tab.title) ? 2 : 1;
}

// The search's words marked in `text` (for the dropdown): where they appear as typed, or, for a word with a
// typo, the word it matched. Built with text nodes and <mark> elements only (page text is never HTML).
function highlight(text, query) {
  const out = document.createDocumentFragment();
  if (!text) return out;
  const lower = fold(text);
  const ranges = [];
  for (const typedWord of queryWords(query)) {
    let found = false;
    for (let i = lower.indexOf(typedWord); i >= 0 && typedWord; i = lower.indexOf(typedWord, i + typedWord.length)) { ranges.push([i, i + typedWord.length]); found = true; }
    if (found || typedWord.length < 4 || /\d/.test(typedWord)) continue;
    const maxDistance = typedWord.length >= 8 ? 2 : 1;
    for (const match of lower.matchAll(/[\p{L}\p{N}]+/gu)) {
      const word = match[0];
      if ([word, word.slice(0, typedWord.length), word.slice(0, typedWord.length + 1)].some((y) => y.length >= typedWord.length - maxDistance && typoDistance(typedWord, y, maxDistance) <= maxDistance)) {
        ranges.push([match.index, match.index + word.length]);
      }
    }
  }
  ranges.sort((firstRange, secondRange) => firstRange[0] - secondRange[0]);
  let at = 0;
  for (const [start, end] of ranges) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    if (from > at) out.append(text.slice(at, from));
    const markElement = document.createElement('mark');
    markElement.dataset.testid = 'search-highlight';
    markElement.className = 'dropdown-mark';
    markElement.textContent = text.slice(from, end);
    out.append(markElement);
    at = end;
  }
  if (at < text.length) out.append(text.slice(at));
  return out;
}
const HIGHLIGHT_TEST_IDS = { 'dropdown-title': 'dropdown-title', 'dropdown-subtitle': 'dropdown-subtitle', 'dropdown-subtitle dropdown-note-line': 'dropdown-note' };
const highlightSpan = (className, text, query) => { const span = makeElement('span', className, null, HIGHLIGHT_TEST_IDS[className]); span.append(highlight(text, query)); return span; };

const isStarred = (url) => !!state.stars[normalizeUrl(url)];
const siteOf = (url) => hostOf(url).replace(/^www\./, '');
const byTitle = (firstEntry, secondEntry) => (firstEntry.tab.title || siteOf(urlOf(firstEntry.tab))).localeCompare(secondEntry.tab.title || siteOf(urlOf(secondEntry.tab)), undefined, { sensitivity: 'base', numeric: true });
const windowRank = (tab) => (tab.windowId === CONTEXT.sourceWindow ? -1 : tab.windowId);
// Quick filters (chips next to Starred). One at a time; each shows only while some tab matches.
const FILTERS = {
  audio: { icon: 'speaker', label: 'filterAudio', test: (x) => x.audible || isMuted(x) },
  pinned: { icon: 'pin', label: 'filterPinned', test: (x) => x.pinned },
  asleep: { icon: 'moon', label: 'filterAsleep', test: (x) => x.discarded || state.toSleep.has(x.id) },
  note: { icon: 'note', label: 'filterNotes', test: (x) => !!noteOf(urlOf(x)) },
};
// The Sort dropdown. 'recent' needs no sorter: state.tabs is already most recently used first.
const SORTERS = {
  order: (firstEntry, secondEntry) => windowRank(firstEntry.tab) - windowRank(secondEntry.tab) || firstEntry.tab.index - secondEntry.tab.index, // the tab strip's order (this window first)
  name: byTitle,
};

// The sections the open tabs are shown in. Each has a stable `key` (what collapsing remembers).
function sectionsFor(open) {
  const sections = new Map();
  const add = (key, information, entry) => {
    if (!sections.has(key)) sections.set(key, { key, ...information, entries: [] });
    entry.section = key;
    sections.get(key).entries.push(entry);
  };
  if (state.duplicatesView) { // one section per page that is open more than once, the copy that stays first
    const close = duplicateIds();
    for (const entry of open) add('d:' + normalizeUrl(urlOf(entry.tab)), { title: entry.tab.title || siteOf(urlOf(entry.tab)), site: urlOf(entry.tab) }, entry);
    const out = [...sections.values()];
    out.forEach((x) => x.entries.sort((firstEntry, secondEntry) => close.has(firstEntry.tab.id) - close.has(secondEntry.tab.id)));
    return out;
  }
  for (const entry of open) add('u', { title: translate('openTabs') }, entry); // one plain list, in the chosen sort
  return [...sections.values()];
}

// The search's results, for the dropdown: open tabs that match (where they matched first: note, title,
// address; then how well; then recent use), and recently closed ones (the last 7 days). `q`: trimmed, lower case.
function searchFor(query) {
  if (!query) return { found: [], foundClosed: [] };
  const score = new Map(), tier = new Map();
  const found = state.tabs
    .filter((x) => { const tabScore = searchScore(query, x.title, urlOf(x), noteOf(urlOf(x)), tabStatus(x)); if (tabScore > 0) { score.set(x.id, tabScore); tier.set(x.id, matchTier(query, x)); } return tabScore > 0; })
    .sort((firstTab, secondTab) => tier.get(secondTab.id) - tier.get(firstTab.id) || score.get(secondTab.id) - score.get(firstTab.id)) // stable: recent use within
    .map((tab) => ({ kind: 'tab', key: 't' + tab.id, tab, preview: state.previews[tab.id] || null }));
  return { found, foundClosed: closedFor(query) };
}
function deriveSearch() {
  const query = state.query.trim().toLowerCase();
  const searchResult = searchFor(query);
  state.found = searchResult.found;
  state.foundClosed = searchResult.foundClosed;
  state.foundQuery = query;
}
// The same for any text (the command palette's): the search box's own when it is that text, else worked out
// once per text and list of tabs.
let foundMemo = { query: null, tabs: null, closed: null, result: null };
function foundFor(query) {
  if (query === state.foundQuery) return { found: state.found, foundClosed: state.foundClosed };
  if (foundMemo.query !== query || foundMemo.tabs !== state.tabs || foundMemo.closed !== state.closed) foundMemo = { query, tabs: state.tabs, closed: state.closed, result: searchFor(query) };
  return foundMemo.result;
}
// While searching, the cards that don't match are dimmed (they keep their places): which ones do.
function deriveHits() {
  const query = state.query.trim().toLowerCase();
  if (!query) { state.hits = null; return; }
  const found = new Set(state.found.map((entry) => entry.key));
  state.hits = new Set(state.entries.filter((entry) => (entry.kind === 'tab' ? found.has(entry.key)
    : entry.kind === 'group' ? entry.tabs.some((x) => found.has('t' + x.id)) || matches(query, groupName(entry.group))
    : entry.kind === 'closed' ? entry.item.fields.some(([title, url]) => matches(query, title, url, noteOf(url), pageStatus(url, 'closed')))
    : matches(query, entry.item.title, entry.item.url, noteOf(entry.item.url), pageStatus(entry.item.url, entry.kind === 'snoozed' ? 'snoozed' : null)))).map((entry) => entry.key));
}
// Mark the cards on screen as matching or not (a keystroke doesn't build them again).
function markHits() {
  for (const card of document.querySelectorAll('#scroller .card')) {
    const entry = state.entries[card._i];
    card.classList.toggle('no-match', !!state.hits && !!entry && !state.hits.has(entry.key));
  }
}
const preference = (key) => (state.preferences || PREFERENCES_FALLBACK)[key];

function derive() {
  duplicateMemo = null;
  deriveSearch();
  const query = ''; // the cards, "Snoozed" and "Recently closed" don't follow the search: its results are in the dropdown
  if (state.scope !== 'all' && !state.windows.some((windowEntry) => windowEntry.id === state.scope)) state.scope = 'all';

  const duplicateKeys = state.duplicatesView ? duplicateUrls() : null;
  // Inside a tab group (its tile was opened): only its tabs, whatever window it is in. Settings -> Show tab groups
  // as tiles off: no tiles and no group view, every tab its own card (tagged with its group).
  const groups = preference('showGroups');
  const inGroup = groups && state.group !== null && state.tabs.some((x) => x.groupId === state.group) ? state.group : null;
  state.inGroup = inGroup;
  const open = state.tabs
    .filter((x) => !duplicateKeys || duplicateKeys.has(normalizeUrl(urlOf(x))))
    .filter((tab) => (inGroup !== null ? tab.groupId === inGroup : state.scope === 'all' || tab.windowId === state.scope))
    .filter((tab) => !state.starOnly || isStarred(urlOf(tab)))
    .filter((tab) => !state.filter || FILTERS[state.filter].test(tab))
    .map((tab) => ({ kind: 'tab', key: 't' + tab.id, tab, preview: state.previews[tab.id] || null }));
  state.mruOrder = open.slice(); // what Alt+Q cycles through: always recent use
  if (SORTERS[state.sort]) open.sort(SORTERS[state.sort]);
  // Pinned tabs first (Settings), then the rest, each in the chosen sort ([pinned, pinned, current, ...] by recent use).
  const pinnedFirst = (firstEntry, secondEntry) => (secondEntry.tab && secondEntry.tab.pinned ? 1 : 0) - (firstEntry.tab && firstEntry.tab.pinned ? 1 : 0);
  if (preference('pinnedFirst')) open.sort(pinnedFirst);
  // A tab group's tabs show as one tile, where its first tab would be (by name: where its name goes); filters and the
  // Starred filter narrow a tile to the tabs they let through. Not inside a group, nor in the duplicates view.
  const tile = (list) => {
    const out = groups && inGroup === null && !state.duplicatesView ? groupTiles(list) : null;
    if (out && state.sort === 'name') out.sort((firstEntry, secondEntry) => (preference('pinnedFirst') ? pinnedFirst(firstEntry, secondEntry) : 0) || cardName(firstEntry).localeCompare(cardName(secondEntry), undefined, { sensitivity: 'base', numeric: true }));
    return out;
  };
  const tiled = tile(open);
  const cards = tiled || open;
  state.tileOf = new Map();
  if (tiled) for (const entry of tiled) if (entry.kind === 'group') for (const x of entry.tabs) state.tileOf.set('t' + x.id, entry.key);
  // What Alt+Q / Alt+W step through: the cards in the order they are shown (pinned tabs first), so none is left for
  // the far end of the list. (The first Alt+W by recent use goes to the tab used just before, wherever it is: boot.)
  state.steps = cards;
  state.cardCount = cards.length;

  const all = sectionsFor(cards);
  // A collapsed section keeps its header and hides its cards, except while searching.
  for (const section of all) section.collapsed = !query && state.collapsed.has(section.key) && !state.peek.has(section.key);
  // One plain list (no headers) when there's nothing to group by.
  state.sections = all.length === 1 && !state.duplicatesView ? [{ ...all[0], plain: true, collapsed: false }] : all;
  const shown = state.sections.flatMap((x) => (x.collapsed ? [] : x.entries));

  let closed = [];
  if (inGroup !== null) { /* the group view is the group's tabs only */ }
  else if (state.starOnly) {
    // Starred pages no tab has open right now: reopen them from here.
    const openUrls = new Set(state.tabs.map((tab) => normalizeUrl(urlOf(tab))));
    closed = Object.entries(state.stars)
      .filter(([key, starEntry]) => !openUrls.has(key) && (!query || matches(query, starEntry.ti, starEntry.u, noteOf(starEntry.u), pageStatus(starEntry.u))))
      .sort((firstStarEntry, secondStarEntry) => secondStarEntry[1].t - firstStarEntry[1].t)
      .map(([key, starEntry]) => ({ kind: 'star', key: 'st' + key, item: { id: key, url: starEntry.u, title: starEntry.ti, timestamp: starEntry.t }, preview: state.starPreviews[key] || null }));
  } else if (preference('showClosed')) {
    closed = closedFor(query).map((item) => ({ kind: 'closed', key: 'c' + item.id, item, preview: item.preview }));
  }

  // Snoozed tabs (soonest first) get their own section; not while a filter narrows things to open tabs.
  const snoozed = state.starOnly || state.filter || state.duplicatesView || inGroup !== null || !preference('showSnoozed') ? [] : state.snoozed
    .filter((x) => !query || matches(query, x.title, x.url, noteOf(x.url), pageStatus(x.url, 'snoozed')))
    .sort((firstSnoozed, secondSnoozed) => firstSnoozed.at - secondSnoozed.at)
    .map((x) => ({ kind: 'snoozed', key: 'z' + x.id, item: { id: x.id, url: x.url, title: x.title, timestamp: x.at, snooze: x }, preview: state.snoozePreviews[normalizeUrl(x.url)] || null }));

  state.entries = [...shown, ...snoozed, ...closed];
  state.snoozeCount = snoozed.length;
  state.openCount = shown.length;
  state.matchCount = open.length;
  state.matches = open; // every open tab the filters let through (collapsed sections too): "Select all" takes these
  // Ticked tabs that closed, or that the filters now hide, stay ticked only if they still exist.
  const tabIds = new Set(state.tabs.map((x) => x.id));
  for (const id of state.picked) if (!tabIds.has(id)) state.picked.delete(id);
  deriveHits();
}

// The open tabs (sorted) with each tab group's tabs replaced by one tile, at the place of its first tab there;
// null when no tab is in a group. A tile's tabs are in tab-strip order (its picture shows the first four), and
// `recent` has them most recently used first.
function groupTiles(open) {
  const out = [], tiles = new Map();
  for (const entry of open) {
    const groupId = entry.tab.groupId;
    if (!(groupId >= 0) || !state.groups.has(groupId)) { out.push(entry); continue; }
    let tile = tiles.get(groupId);
    if (!tile) { tile = { kind: 'group', key: 'g' + groupId, group: state.groups.get(groupId), tabs: [], recent: [], url: '' }; tiles.set(groupId, tile); out.push(tile); }
    tile.tabs.push(entry.tab);
  }
  if (!tiles.size) return null;
  const rank = new Map(state.tabs.map((x, i) => [x.id, i])); // state.tabs: most recently used first
  for (const tile of tiles.values()) {
    tile.recent = tile.tabs.slice().sort((firstTab, secondTab) => rank.get(firstTab.id) - rank.get(secondTab.id));
    tile.tabs.sort((firstTab, secondTab) => firstTab.windowId - secondTab.windowId || firstTab.index - secondTab.index);
  }
  return out;
}
// Where a tab is on screen: its own card, or the tile of its group.
const cardKey = (key) => state.tileOf.get(key) || key;
// What a card is sorted by under "By name": a tab's title (or site), a group's name.
const cardName = (entry) => (entry.kind === 'group' ? groupName(entry.group) : entry.tab.title || siteOf(urlOf(entry.tab)));
// The tabs a card stands for: its own, or its group's.
const cardTabs = (entry) => (entry.kind === 'tab' ? [entry.tab] : entry.kind === 'group' ? entry.tabs : NONE);
// Did a change of ticks (`before`, then state.picked) touch this card?
const tickChanged = (before) => (entry) => cardTabs(entry).some((x) => before.has(x.id) !== state.picked.has(x.id));

// ------------------------------------------------------------------ render
// Cards fill the whole width of the card area: as many per row as fit near the preferred size
// (Settings -> Card size), then stretched so each full row reaches the right edge. A few tabs that
// can't fill one row keep a sensible size instead of stretching across the screen.
const GRID_GAP = 18;  // .grid column gap in switcher.css
const CARD_SIZES = { default: [320, 240, 420], small: [210, 160, 240], list: [300, 220, 360] }; // [preferred, smallest, few tabs]
// Past this many cards the default size prefers narrower cards (MANY_CARDS_WIDTH): more fit on the screen, and each
// picture costs less to draw.
const MANY_CARDS = 48, MANY_CARDS_WIDTH = 260;
function cardWidth(cardCount) {
  // The layout width, fractional and rounded down: clientWidth rounds (half a pixel too many wraps the last
  // card), and getBoundingClientRect() is the on-screen size, which the opening pop-in scales to 96%.
  const availableWidth = Math.max(0, Math.floor(parseFloat(getComputedStyle(elements.openGrid).width) || 0));
  const { columns, width: columnWidth } = gridColumns(availableWidth);
  return cardCount < columns ? Math.min(columnWidth, (CARD_SIZES[state.cardSize] || CARD_SIZES.default)[2]) : columnWidth;
}
// How many cards fit across `avail` px near the preferred size, and how wide each then is.
function gridColumns(availableWidth) {
  const [preferred, minimumWidth] = CARD_SIZES[state.cardSize] || CARD_SIZES.default;
  const want = state.cardSize === 'default' && state.cardCount > MANY_CARDS ? MANY_CARDS_WIDTH : preferred;
  let columns = Math.max(1, Math.round((availableWidth + GRID_GAP) / (want + GRID_GAP)));
  while (columns > 1 && (availableWidth - GRID_GAP * (columns - 1)) / columns < minimumWidth) columns--;
  return { columns, width: (availableWidth - GRID_GAP * (columns - 1)) / columns };
}

// The window list on the left: "Merge all into this window", "All windows", then each window with a small
// picture of the tab it shows.
function renderWindows() {
  const hasMultipleWindows = state.windows.length > 1 && state.inGroup === null; // (a group is in one window)
  elements.windows.hidden = !hasMultipleWindows;
  elements.body.classList.toggle('with-windows', hasMultipleWindows);
  if (!hasMultipleWindows) return elements.windows.replaceChildren();
  const rows = [{ id: 'all', label: translate('allWindows'), count: state.tabs.length, activeTitle: '' }, ...state.windows];
  const top = [];
  if (state.otherWindows.length) { // every other window's tabs into this one (Undo puts them back)
    const all = makeElement('button', 'window-merge-all', null, 'windows-merge-all');
    all.type = 'button';
    all.title = translate('mergeCount', { count: state.otherWindows.length });
    all.setAttribute('aria-label', translate('mergeAll'));
    all.append(svgOf(ICON.merge), makeElement('span', 'window-label', translate('mergeAll'), 'windows-merge-all-label'));
    all.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) mergeWindows(state.otherWindows); });
    top.push(all);
  }
  elements.windows.replaceChildren(...top, ...rows.map((windowEntry) => {
    const row = makeElement('div', 'window-row', null, 'window-row'); // the window's button, and its merge button beside it (not inside: a button in a button is unreachable)
    const button = makeElement('button', 'window-button', null, windowEntry.id === 'all' ? 'window-all' : 'window-item');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.scope === windowEntry.id));
    if (windowEntry.activeTitle) button.title = translate('activeTab', { title: windowEntry.activeTitle });
    const picture = makeElement('span', 'window-picture', null, 'window-picture');
    if (windowEntry.id === 'all') picture.append(svgOf(ICON.windows));
    else {
      const preview = windowEntry.activeId && state.previews[windowEntry.activeId];
      if (preview && preview.img) { const image = makeElement('img', '', null, 'window-preview'); image.src = preview.img; image.alt = ''; picture.append(image); }
      else { const image = makeElement('img', 'window-favicon', null, 'window-favicon'); image.src = favicon(windowEntry.activeUrl || ''); image.alt = ''; picture.append(image); }
    }
    const text = makeElement('span', 'window-text', null, 'window-text');
    text.append(makeElement('span', 'window-label', windowEntry.label, 'window-label'), makeElement('span', 'window-subtitle', translate('tabs', { count: windowEntry.count }), 'window-count'));
    button.append(picture, text);
    row.append(button);
    if (windowEntry.id !== 'all' && windowEntry.id !== CONTEXT.sourceWindow) { // pull this window's tabs into the current one (Undo puts them back)
      const mergeButton = makeElement('button', 'window-merge', null, 'window-merge');
      mergeButton.type = 'button';
      mergeButton.title = translate('mergeThis');
      mergeButton.setAttribute('aria-label', translate('mergeThis'));
      mergeButton.append(svgOf(ICON.merge));
      mergeButton.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) mergeWindows([windowEntry.id]); });
      row.append(mergeButton);
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!pointerAllowed()) return;
      setScope(windowEntry.id);
      elements.search.focus();
    });
    // Dropped on: tabs (or a group) move to this window, a page opens in it (see dragToMove).
    if (windowEntry.id !== 'all') {
      const there = (tabIds) => tabIds.every((id) => (state.tabs.find((x) => x.id === id) || {}).windowId === windowEntry.id);
      dropZone(row, (dropData) => (dropData.ids ? !there(dropData.ids) : dropData.group !== undefined ? (state.groups.get(dropData.group) || {}).windowId !== windowEntry.id : dropData.page || dropData.link),
        (dropData, event) => (dropData.ids || dropData.group !== undefined ? moveToWindow(dropData, windowEntry.id) : openDropped(dropData.page || droppedLinks(event), { windowId: windowEntry.id })), 'drop-into');
    }
    return row;
  }));
}

function windowTag(tab) {
  if (state.scope !== 'all' || state.windows.length < 2 || tab.windowId === CONTEXT.sourceWindow) return null;
  const windowEntry = state.windows.find((x) => x.id === tab.windowId);
  return windowEntry ? makeElement('span', 'tag', windowEntry.label, 'card-window-tag') : null;
}
// A tab a snooze just brought back (the background reopens them unannounced), until it has been looked at.
function wokenTag(tab) {
  return state.woken[tab.id] ? makeElement('span', 'tag woken', translate('wokenTag'), 'card-woken') : null;
}
function pinnedBadge() {
  const badge = makeElement('span', 'badge', null, 'card-pinned');
  badge.append(svgOf(ICON.pin));
  badge.title = translate('pinned');
  return badge;
}

// A card's screenshot, kept from one redraw to the next (by card and capture), so its data URL isn't read and
// decoded again each time. A full redraw keeps only the ones it used (render()), so they don't pile up.
let shots = new Map(), shotsNext = null;
function shotImage(entry) {
  const preview = entry.preview;
  const cacheKey = (entry.key || entry.kind + ':' + (entry.item ? entry.item.id : entry.url)) + '|' + (preview.t || 0) + '|' + preview.img.length;
  let image = shots.get(cacheKey);
  if (!image) {
    image = makeElement('img', 'shot', null, 'card-preview');
    image.decoding = 'async';
    image.src = preview.img;
    image.alt = '';
    if (shots.size > 1000) shots.clear();
    shots.set(cacheKey, image);
  }
  if (shotsNext) shotsNext.set(cacheKey, image);
  return image;
}
// `loading`: its preview is still being read (just after the first draw): the favicon on a plain tile, nothing
// that says "no preview" or offers to capture one.
function thumbFor(entry, { label, subtitle, icon, action, loading = false, bare = false }) {
  const thumb = makeElement('div', 'thumb', null, 'card-thumb');
  if (loading || isLite()) { // (Lite mode: always the page's icon on a plain tile)
    const box = makeElement('div', 'no-preview loading', null, isLite() ? 'card-icon-only' : 'card-loading');
    const tile = makeElement('div', 'tile', null, 'card-tile');
    const image = makeElement('img', '', null, 'card-tile-favicon');
    image.src = favicon(entry.url);
    image.alt = '';
    tile.append(image);
    box.append(tile);
    thumb.append(box);
  } else if (entry.preview && entry.preview.img) {
    thumb.append(shotImage(entry));
    if (label) {
      const pill = makeElement('span', 'pill', null, 'card-pill');
      pill.append(svgOf(icon));
      pill.append(label);
      thumb.append(pill);
    }
  } else {
    const box = makeElement('div', 'no-preview', null, 'card-no-preview');
    const tile = makeElement('div', 'tile', null, 'card-tile');
    const image = makeElement('img', '', null, 'card-tile-favicon');
    image.src = favicon(entry.url);
    image.alt = '';
    if (bare) { // just the page's icon (the history: no "No preview yet", nothing can be captured there)
      tile.append(image);
      box.classList.add('bare');
      box.append(tile);
      thumb.append(box);
      return thumb;
    }
    const badge = makeElement('span', 'icon', null, 'card-tile-badge');
    badge.append(svgOf(icon));
    tile.append(image, badge);
    box.append(tile, makeElement('div', 'label', label || translate('noPreview'), 'card-no-preview-label'), makeElement('div', 'subtitle', subtitle || '', 'card-no-preview-subtitle'));
    if (action) box.append(action);
    thumb.append(box);
  }
  return thumb;
}

// Star / unstar the page a card shows. Stars live only in Tabazing (not Chrome's bookmarks).
function starButton(entry) {
  const on = isStarred(entry.url);
  const button = makeElement('button', 'star' + (on ? ' on' : ''), null, 'card-star-button');
  button.type = 'button';
  button.title = translate(on ? 'unstar' : 'star') + (IS_MAC ? ' (⌥S)' : ' (Alt+S)');
  button.setAttribute('aria-label', translate(on ? 'unstarAria' : 'starAria'));
  button.setAttribute('aria-pressed', String(on));
  button.append(svgOf(ICON.star));
  button.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) star(entry); });
  return button;
}

// "Capture preview" on a card that has none: shows that tab for a moment, then comes back.
const canCapture = (tab) => !tab.discarded && isCapturableUrl(urlOf(tab)) && !state.noCapture.has(normalizeUrl(urlOf(tab))) && state.hostAllowed;
function captureButton(entry) {
  const busy = state.capturing === entry.tab.id;
  const button = makeElement('button', 'snap', translate(busy ? 'capturing' : 'capturePreview'), 'card-capture');
  button.type = 'button';
  button.disabled = busy;
  button.title = translate('captureTitle') + (IS_MAC ? ' (⌥P)' : ' (Alt+P)');
  button.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) captureOne(entry); });
  return button;
}

// How long ago a tab was last viewed, once that is a whole day or more ("3 days ago"). Chrome keeps
// that time itself (tab.lastAccessed, Chrome 121 and later); without it nothing is shown.
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
function tabAge(tab) {
  if (!preference('showAge')) return null; // Settings: Show "days ago" tags
  const days = tab.lastAccessed > 0 ? Math.floor((Date.now() - tab.lastAccessed) / DAY_MILLISECONDS) : 0;
  return days >= 1 ? makeElement('span', 'tag age', translate('ageDays', { count: days }), 'card-age') : null;
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
  const card = makeElement('div', 'card' + (entry.kind === 'closed' || entry.kind === 'star' ? ' closed' : '') + (asleep || willSleep ? ' asleep' : '') + (picked ? ' picked' : '') + (dim ? ' no-match' : ''), null, 'card-' + entry.kind);
  card.id = 'opt-' + entry.key;
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', String(index === state.selected)); // the cursor (one card)
  card._i = index; // its place in state.entries (select() and the mouse find cards by it)
  if (index === state.selected) selectedCard = card;
  if (entry.kind === 'tab') card.setAttribute('aria-checked', String(picked)); // ticked for a quick action (any number)

  const head = makeElement('div', 'head', null, 'card-head');
  const faviconImage = makeElement('img', 'favicon', null, 'card-favicon');
  faviconImage.alt = '';

  if (entry.kind === 'tab') {
    const tab = entry.tab;
    entry.url = urlOf(tab);
    faviconImage.src = favicon(entry.url);
    const host = hostOf(entry.url);
    if (index < 9) head.append(makeElement('span', 'key-number', String(index + 1), 'card-number')); // the first nine are numbered: press 1-9 to switch to them
    head.append(pickBox(entry, picked), faviconImage, makeElement('span', 'title', tab.title || host || translate('untitled'), 'card-title'));
    // Its tags (days since it was used, its window, pinned, back from snooze) sit on the picture, top left, as
    // small pills; in a list, compact in the row. The header keeps its room for the title.
    const flags = makeElement('span', 'flags', null, 'card-flags');
    flags.append(...[groupTag(tab, 'tag', 'card-group-tag'), tabAge(tab), windowTag(tab), wokenTag(tab), tab.pinned && pinnedBadge()].filter(Boolean));
    // The site name only fits next to the title on wider cards, and only when no tags compete with it; narrow
    // ones keep the title readable (the full URL is in the tooltip).
    if (!flags.firstChild && tab.title && host && state.cardWidth >= 300 && state.cardSize !== 'list') head.append(makeElement('span', 'host', host.replace(/^www\./, ''), 'card-host'));
    if (state.duplicatesView) { const goes = duplicateIds().has(tab.id); head.append(makeElement('span', 'tag ' + (goes ? 'goes' : 'stays'), translate(goes ? 'duplicateCloses' : 'duplicateStays'), goes ? 'card-duplicate-closes' : 'card-duplicate-stays')); }
    if (tab.audible || isMuted(tab)) head.append(audioBadge(tab)); // playing sound (or muted): click to mute / unmute
    const x = makeElement('button', 'close-button', null, 'card-close');
    x.type = 'button';
    x.title = translate('closeTabTitle');
    x.setAttribute('aria-label', translate('closeTab'));
    x.append(svgOf(ICON.close));
    x.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeTab(entry); });
    head.append(headButtons(starButton(entry), x));
    card.title = (tab.title || '') + '\n' + entry.url + (asleep ? '\n' + translate('sleepingTip') : '');
    if (state.cardSize === 'list') { // List: one line, no screenshot; the tags and the quick buttons sit in the row
      if (flags.firstChild) head.querySelector('.title').after(flags);
      head.insertBefore(quickActions(entry), head.querySelector('.head-buttons'));
      card.append(head);
      return finishCard(card, entry);
    }
    // No preview just means Chrome only lets us screenshot the visible tab and
    // we haven't seen this one yet; it's an awake background tab, not asleep.
    // The placeholder shows the domain, since narrow cards hide it in the header.
    const subtitle = host;
    const thumb = thumbFor(entry, asleep || willSleep
      ? { label: translate(willSleep ? 'willSleep' : 'sleeping'), subtitle, icon: ICON.moon }
      : !entry.preview && state.previewPending.has(tab.id) ? { loading: true }
      : { label: entry.preview ? '' : translate('noPreview'), subtitle, icon: ICON.camera, action: !entry.preview && canCapture(tab) ? captureButton(entry) : null });
    if (flags.firstChild) thumb.append(flags);
    thumb.append(quickActions(entry));
    card.append(head, thumb);
  } else {
    const item = entry.item;
    entry.url = item.url;
    faviconImage.src = favicon(entry.url);
    const title = item.title || hostOf(item.url);
    // Some entries (e.g. closed windows) come without a time: no time tag then.
    const ago = timeAgo(item.timestamp / 1000);
    head.append(faviconImage, makeElement('span', 'title', title, 'card-title'));
    if (ago && entry.kind === 'closed') head.append(makeElement('span', 'tag', ago, 'card-closed-ago'));
    if (entry.kind === 'snoozed') head.append(makeElement('span', 'tag snooze', translate('wakesAt', { time: whenLabel(item.timestamp) }), 'card-wakes'));
    const buttons = [];
    if (entry.kind === 'closed') buttons.push(deleteButton(translate('closedRemove'), 'card-closed-remove', () => forgetClosed(entry))); // (its star is in its ⋯)
    else if (item.kind !== 'window') buttons.push(starButton(entry));
    if (entry.kind === 'snoozed') { // × cancels the snooze (the tab is not reopened)
      const x = makeElement('button', 'close-button', null, 'card-cancel-snooze');
      x.type = 'button';
      x.title = translate('cancelSnooze');
      x.setAttribute('aria-label', translate('cancelSnooze'));
      x.append(svgOf(ICON.close));
      x.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeTab(entry); });
      buttons.push(x);
    }
    if (buttons.length) head.append(headButtons(...buttons));
    card.title = entry.kind === 'snoozed' ? translate('snoozedTip', { title }) + '\n' + item.url : translate('reopenTip', { title }) + (item.kind !== 'window' ? '\n' + item.url : '');
    const quick = entry.kind === 'closed' ? closedQuick(entry) : null; // its note and ⋯ (everything else it can do)
    if (state.cardSize === 'list') { if (quick) head.insertBefore(quick, head.querySelector('.head-buttons')); card.append(head); return finishCard(card, entry); }
    const thumb = entry.kind === 'snoozed'
      ? thumbFor(entry, { label: translate('snoozedLabel'), subtitle: hostOf(entry.url), icon: ICON.clock })
      : entry.kind === 'star'
      ? thumbFor(entry, { label: translate('starred'), subtitle: hostOf(entry.url), icon: ICON.star })
      : thumbFor(entry, { label: translate('closedLabel'), subtitle: hostOf(entry.url), icon: ICON.history });
    if (quick) thumb.append(quick);
    card.append(head, thumb);
  }
  return finishCard(card, entry);
}

// ---- tab groups: Chrome's groups as tiles among the cards (derive: groupTiles). A tile's picture is its first
// tabs (up to four), in the group's colour; opening it (click, Enter, its number) shows only that group's tabs
// (the group view), and every open of Tabazing shows them until the group is left (its "All tabs" button, or
// Backspace in the empty search box).
const groupColor = (group) => (group && GROUP_COLORS.includes(group.color) ? group.color : 'grey');
// A group without a name is called by its colour ("Blue group"), as Chrome shows it: by its colour only.
const groupName = (group) => (group && group.title) || translate('groupUnnamed', { color: groupColor(group) });
function renderGroupCard(entry, index) {
  const group = entry.group, tabCount = entry.tabs.length, name = groupName(group);
  const dim = !!state.hits && !state.hits.has(entry.key);
  // Its tabs' ticks: all of them (the tile looks ticked), some (its box shows a dash), or none.
  const ticked = entry.tabs.filter((x) => state.picked.has(x.id)).length;
  const on = ticked && ticked === tabCount ? true : ticked ? 'mixed' : false;
  const card = makeElement('div', 'card group-tile' + (dim ? ' no-match' : '') + (on === true ? ' picked' : ''), null, 'card-group');
  card.id = 'opt-' + entry.key;
  card.dataset.groupColor = groupColor(group);
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', String(index === state.selected));
  card.setAttribute('aria-checked', String(on));
  card.setAttribute('aria-label', translate('groupAria', { name, tabs: translate('tabs', { count: tabCount }) }));
  card._i = index;
  if (index === state.selected) selectedCard = card;
  const head = makeElement('div', 'head', null, 'card-head');
  if (index < 9) head.append(makeElement('span', 'key-number', String(index + 1), 'card-number'));
  head.append(pickBox(entry, on), makeElement('span', 'group-dot', null, 'card-group-dot'), makeElement('span', 'title', name, 'card-title'), makeElement('span', 'tag group-count', translate('tabs', { count: tabCount }), 'card-group-count'));
  // × closes the group's tabs, as on a tab's card (Undo brings them back, in their group).
  const x = makeElement('button', 'close-button', null, 'card-close');
  x.type = 'button';
  x.title = translate('groupClose');
  x.setAttribute('aria-label', translate('groupClose'));
  x.append(svgOf(ICON.close));
  x.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeTab(entry); });
  head.append(headButtons(x));
  card.title = [translate('groupTip', { name }), ...entry.tabs.slice(0, 12).map((x) => '· ' + (x.title || siteOf(urlOf(x)))), ...(tabCount > 12 ? ['…'] : [])].join('\n');
  const more = makeElement('button', 'quick-button', null, 'quick-more');
  more.type = 'button';
  more.title = translate('cardMenu');
  more.setAttribute('aria-label', translate('cardMenu'));
  more.setAttribute('aria-haspopup', 'menu');
  more.append(svgOf(ICON.more));
  more.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) cardMenu(entry, { anchor: more }); });
  const quick = makeElement('div', 'quick', null, 'card-quick-actions');
  quick.append(more);
  const flags = groupFlags(entry);
  if (state.cardSize === 'list') { // a row: its colour, name, count, what its tabs are doing, the first four favicons
    const peek = makeElement('span', 'peek', null, 'card-group-peek');
    for (const x of entry.tabs.slice(0, 4)) { const i = makeElement('img', '', null, 'card-group-favicon'); i.src = favicon(urlOf(x)); i.alt = ''; peek.append(i); }
    if (flags.firstChild) head.querySelector('.group-count').after(flags);
    head.insertBefore(peek, head.querySelector('.head-buttons'));
    head.insertBefore(quick, head.querySelector('.head-buttons'));
    card.append(head);
    return finishCard(card, entry);
  }
  // As many cells as it has tabs, up to four (switcher.css .group-mosaic.n1-n4): one fills the picture, two sit side by
  // side, three are one big and two small, four two by two. No empty placeholders.
  const shown = entry.tabs.slice(0, 4);
  const thumb = makeElement('div', 'thumb group-mosaic n' + shown.length, null, 'card-thumb');
  for (const x of shown) {
    const cell = makeElement('div', 'group-cell', null, 'card-group-cell');
    const preview = state.previews[x.id];
    if (preview && preview.img) cell.append(shotImage({ key: 'gt' + x.id, preview }));
    else { const image = makeElement('img', 'group-favicon', null, 'card-group-favicon'); image.src = favicon(urlOf(x)); image.alt = ''; cell.append(image); }
    thumb.append(cell);
  }
  if (tabCount > 4) thumb.append(makeElement('span', 'pill', translate('groupMoreCount', { count: tabCount - 4 }), 'card-group-more'));
  if (flags.firstChild) thumb.append(flags);
  thumb.append(quick);
  card.append(head, thumb);
  return finishCard(card, entry);
}
// What a tile says about its tabs, as small pills on its picture (in a list, in its row): the current tab is in it,
// its window (with Show all windows), collapsed in Chrome's tab strip, and how many of its tabs play sound (or are
// muted), sleep, have a note or a star.
function groupFlags(entry) {
  const box = makeElement('span', 'flags', null, 'card-flags');
  const tabs = entry.tabs;
  if (tabs.some((x) => x.id === CONTEXT.sourceTab)) box.append(makeElement('span', 'tag here', translate('groupHere'), 'card-group-here'));
  const windowTagElement = windowTag({ windowId: entry.group.windowId });
  if (windowTagElement) box.append(windowTagElement);
  if (entry.group.collapsed) box.append(makeElement('span', 'tag', translate('groupCollapsed'), 'card-group-collapsed'));
  const count = (icon, amount, label, testid) => {
    if (!amount) return;
    const badge = makeElement('span', 'badge group-flag', null, testid);
    badge.append(svgOf(ICON[icon]), makeElement('span', 'count-badge', String(amount), testid + '-count'));
    badge.title = label;
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', label);
    box.append(badge);
  };
  const sound = tabs.filter((x) => x.audible || isMuted(x)).length;
  const asleep = tabs.filter((x) => x.discarded || state.toSleep.has(x.id)).length;
  const notes = tabs.filter((x) => noteOf(urlOf(x))).length;
  const stars = tabs.filter((x) => isStarred(urlOf(x))).length;
  count(tabs.some((x) => x.audible && !isMuted(x)) ? 'speaker' : 'muted', sound, translate('groupFlagSound', { count: sound }), 'card-group-sound');
  count('moon', asleep, translate('groupFlagAsleep', { count: asleep }), 'card-group-asleep');
  count('note', notes, translate('groupFlagNotes', { count: notes }), 'card-group-notes');
  count('star', stars, translate('groupFlagStars', { count: stars }), 'card-group-stars');
  return box;
}

// The group view's title row: "‹ All tabs" (with its key), the group's colour and name (the section's heading), how many tabs.
function renderGroupBar() {
  const group = state.inGroup !== null ? state.groups.get(state.inGroup) : null;
  elements.body.classList.toggle('in-group', !!group);
  elements.groupLeave.hidden = elements.groupDot.hidden = elements.groupCount.hidden = !group;
  elements.openHeading.textContent = group ? groupName(group) : translate('openTabs');
  if (!group) { delete elements.body.dataset.groupColor; return; }
  elements.body.dataset.groupColor = groupColor(group);
  elements.groupCount.textContent = translate('tabs', { count: state.matchCount });
  elements.groupLeave.title = translate('groupLeaveTitle');
}

// The star and × of a card's header: laid over the end of the title (they show on hover, on the selected card
// and with the focus), so while hidden they take none of its room.
// A card's delete button (a trash can, red on hover): a recently closed entry off the list, a page out of the history.
function deleteButton(label, testid, onDelete) {
  const button = makeElement('button', 'close-button delete', null, testid);
  button.type = 'button';
  button.title = label + (IS_MAC ? ' (⌘⌫)' : ' (Del)');
  button.setAttribute('aria-label', label);
  button.append(svgOf(ICON.trash));
  button.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) onDelete(); });
  return button;
}

// Middle-click (the mouse wheel) on `node` runs `fn`. Pressing the wheel would start Chrome's auto-scroll first,
// which swallows the click, so that is turned off on it.
function onMiddleClick(node, callback) {
  node.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault(); });
  node.addEventListener('auxclick', (event) => { if (event.button !== 1) return; event.preventDefault(); event.stopPropagation(); if (pointerAllowed()) callback(); });
}

function headButtons(...buttons) {
  const box = makeElement('span', 'head-buttons' + (buttons.length > 1 ? ' two' : ''), null, 'card-head-buttons');
  box.append(...buttons);
  return box;
}

// What every card does, whatever it shows: click to open, drag to move, right-click for its menu (hovering selects nothing).
function finishCard(card, entry) {
  // Its address, for screen readers (on screen it is only in the tooltip): the card's description.
  const description = makeElement('span', '', entry.kind === 'group' ? entry.tabs.map((x) => x.title || siteOf(urlOf(x))).join(', ') : siteOf(entry.url) || entry.url, 'card-description');
  description.id = 'description-' + card.id;
  description.hidden = true;
  card.append(description);
  card.setAttribute('aria-describedby', description.id);
  mouseOnly(card);
  card.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!pointerAllowed()) return;
    // Ctrl+click (Cmd+click on a Mac) ticks a tab, Shift+click shows the preview big. A plain click always
    // switches, ticks or not (the tick box itself ticks, and Shift+click on it ticks a range).
    if ((event.ctrlKey || event.metaKey) && (entry.kind === 'tab' || entry.kind === 'group')) return pick(entry);
    if (event.shiftKey) return openBig(entry);
    choose(state.entries.indexOf(entry));
  });
  // Right-click: the card's own menu at the pointer (the same as ⋯ and Shift+F10), not Chrome's.
  card.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!pointerAllowed()) return;
    select(card._i, { scroll: false });
    cardMenu(entry, { at: { x: event.clientX, y: event.clientY } });
  });
  // Drag (see dragToMove): a tab onto a group's tile, a window, Snoozed or Recently closed; By order, also before /
  // after other cards. A page that isn't open: onto the open tabs, a tile or a window, to open it there.
  if ((entry.kind === 'tab' || entry.kind === 'group') && !state.duplicatesView) dragToMove(card, entry);
  else if (entry.kind === 'closed' || entry.kind === 'snoozed' || entry.kind === 'star') dragToOpen(card, entry);
  // Middle-click (the mouse wheel): what Del does - a tab (or a tile's tabs) closes, a recently closed page leaves the
  // list, a snoozed one its snooze; a starred page that isn't open opens behind Tabazing, as a link would.
  onMiddleClick(card, () => (entry.kind === 'star' ? historyBehind(entry.item).catch((error) => toast(translate('actionFailed'), error)) : closeTab(entry)));
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
  card.querySelectorAll('button').forEach((button) => {
    button.tabIndex = -1;
    button.setAttribute('aria-hidden', 'true');
    button.addEventListener('mousedown', (event) => { if (event.button === 0) event.preventDefault(); });
    button.addEventListener('focus', () => button.removeAttribute('aria-hidden'));
    button.addEventListener('blur', () => button.setAttribute('aria-hidden', 'true'));
  });
}

function renderSection(section, startIndex) {
  const box = makeElement('div', 'group-section' + (section.collapsed ? ' collapsed' : ''), null, 'section');
  box.setAttribute('role', 'group');
  if (!section.plain) {
    box.setAttribute('aria-label', section.title);
    const head = makeElement('button', 'group-head', null, 'section-toggle');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(!section.collapsed));
    head.title = translate(section.collapsed ? 'sectionShow' : 'sectionCollapse');
    const chevron = makeElement('span', 'chevron', null, 'section-chevron');
    chevron.append(svgOf(ICON.chevron));
    head.append(chevron);
    if (section.site) {
      const faviconImage = makeElement('img', 'section-favicon', null, 'section-favicon');
      faviconImage.src = favicon(section.site);
      faviconImage.alt = '';
      head.append(faviconImage);
    }
    const name = makeElement('span', 'group-name', section.title, 'section-name');
    name.id = 'section-' + hashOf(section.key);
    head.append(name, makeElement('span', 'count-badge', String(section.entries.length), 'section-count'));
    if (section.collapsed) { // a peek at what's inside
      const peek = makeElement('span', 'peek', null, 'section-peek');
      for (const entry of section.entries.slice(0, 8)) { const i = makeElement('img', '', null, 'section-peek-favicon'); i.src = favicon(urlOf(entry.tab || entry.tabs[0])); i.alt = ''; peek.append(i); }
      head.append(peek);
    }
    head.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) toggleSection(section.key); });
    const headerRow = makeElement('div', 'header-row', null, 'section-header');
    headerRow.append(head);
    box.append(headerRow);
  }
  if (!section.collapsed) {
    const grid = makeElement('div', 'grid' + (state.cardSize === 'default' ? '' : ' ' + state.cardSize), null, 'section-grid');
    grid.setAttribute('role', 'listbox'); // one list per section: its header button stays outside the list
    grid.setAttribute('aria-labelledby', section.plain ? 'open-heading' : 'section-' + hashOf(section.key));
    grid.style.setProperty('--card-width', state.cardWidth + 'px');
    grid.append(...section.entries.map((entry, i) => renderCard(entry, startIndex + i)));
    box.append(grid);
  }
  return box;
}

function renderTools() {
  // Quick filters: a chip per filter some tab matches (or that is on), with how many.
  const inScope = state.tabs.filter((x) => state.scope === 'all' || x.windowId === state.scope);
  elements.quickFilters.replaceChildren(...Object.entries(FILTERS).map(([id, filter]) => {
    const count = inScope.filter(filter.test).length;
    if (!count && state.filter !== id) return null;
    // Just the icon and how many: the name is the tooltip, and with the count what screen readers say.
    const button = makeElement('button', 'chip', null, 'filter-' + id);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.filter === id));
    button.setAttribute('aria-label', translate('chipAria', { name: translate(filter.label), count }));
    button.title = translate(filter.label);
    button.append(svgOf(ICON[filter.icon]));
    button.append(makeElement('span', 'count-badge', String(count), 'filter-count'));
    button.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) setFilter(state.filter === id ? null : id); });
    return button;
  }).filter(Boolean));
  // Merge: pull every other window's tabs into this one. Only with "Show tabs from all windows" on (else the
  // other windows aren't in view), and only while the window list, which has its own, doesn't show.
  elements.mergeButton.hidden = !state.otherWindows.length || !state.allWindows || !elements.windows.hidden || state.inGroup !== null;
  elements.mergeText.textContent = translate('mergeCount', { count: state.otherWindows.length });
  elements.sort.value = state.sort;
  if (elements.sort._fancy) elements.sort._fancy.sync();
  elements.starFilter.setAttribute('aria-pressed', String(state.starOnly));
  const stars = Object.keys(state.stars).length;
  elements.starCount.textContent = String(stars);
  elements.starFilter.setAttribute('aria-label', translate('chipAria', { name: translate('starred'), count: stars }));
  elements.starFilter.title = translate('starred');
  const duplicateCount = duplicates().length;
  elements.duplicatesButton.hidden = duplicateCount === 0 || state.inGroup !== null; // (about every tab, not the group's)
  elements.duplicatesText.textContent = translate('duplicatesButton', { count: duplicateCount });
  elements.duplicatesButton.setAttribute('aria-pressed', String(state.duplicatesView));
  elements.duplicatesButton.title = translate('duplicatesTitle');
  updateSweepButton();
}

// `only` (redraw()): build again just the cards it picks, leaving the others as they are.
function render(only) {
  const previousFocus = focusMark();
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
  renderActions();
  renderPlayer();
  renderGroupBar();
  if (!only) state.cardWidth = Math.floor(cardWidth(state.cardCount));
  elements.body.style.setProperty('--top', topOf() + 'px');
  if (only) redrawCards(only);
  else {
    shotsNext = new Map();
    elements.openGrid.classList.toggle('has-groups', state.sections.some((x) => !x.plain));
    let at = 0;
    elements.openGrid.replaceChildren(...state.sections.map((section) => { const box = renderSection(section, at); if (!section.collapsed) at += section.entries.length; return box; }));
    elements.closedGrid.className = elements.snoozedGrid.className = state.cardSize === 'list' ? 'grid list' : 'grid small';
    elements.snoozedGrid.replaceChildren(...snoozedPart.map((entry, i) => renderCard(entry, i + state.openCount)));
    elements.closedGrid.replaceChildren(...closed.map((entry, i) => renderCard(entry, i + state.openCount + state.snoozeCount)));
    shots = shotsNext; // the screenshots this draw used: the rest can go
    shotsNext = null;
    cardList = [...document.querySelectorAll('#scroller .card')];
  }
  elements.snoozedSection.hidden = snoozedPart.length === 0;
  // While searching, "Recently closed" reaches back 7 days: say so, so nobody expects more.
  elements.closedHeading.textContent = state.starOnly ? translate('starredNotOpen') : state.query ? translate('closedSearchHeading') : translate('recentlyClosed');
  // Nothing found: say what Enter does with the text (open it as an address, or search the web for it).
  const trimmedQuery = state.query.trim();
  elements.openEmpty.textContent = state.starOnly && !trimmedQuery ? translate('noStarredOpen')
    : trimmedQuery && !state.entries.length ? (asUrl(trimmedQuery) ? translate('enterOpen', { address: trimmedQuery }) : translate('enterSearch', { text: trimmedQuery }))
    : trimmedQuery ? translate('noMatchShift') : translate('noMatch');
  elements.openEmpty.hidden = state.matchCount > 0;
  elements.closedSection.hidden = closed.length === 0;
  // "Show more" when Recently closed holds more than it shows (and "Show fewer" once it shows them).
  elements.closedMore.hidden = state.starOnly || !(state.closedMore ? state.closed.length > LIMITS.RECENTLY_CLOSED : state.closed.length > closed.length);
  elements.closedMore.textContent = translate(state.closedMore ? 'closedFewer' : 'closedMore');
  elements.closedMore.setAttribute('aria-expanded', String(state.closedMore));

  renderDropdown();
  markHits();
  searchPlaceholder();
  select(state.selected, { scroll: true });
  if (state.palette) renderPalette(); // what it offers follows the tabs (the current one, duplicates, windows...)
  refocus(previousFocus);
  requestAnimationFrame(tipTruncated);
}
// Build again the cards `only` picks (same entries, same places): a tick, a star, mute, a new preview.
function redrawCards(only) {
  state.entries.forEach((entry, i) => {
    if (!only(entry)) return;
    const old = cardAt(i);
    if (!old) return;
    if (entry.kind === 'tab') entry.preview = state.previews[entry.tab.id] || null; // as derive() hands it out
    const card = renderCard(entry, i);
    old.replaceWith(card);
    cardList[i] = card;
  });
}
// After a change of layout only (Alt let go shows the search box, the window was resized): the cards are
// built again only when their width changes.
function relayout() {
  if (Math.floor(cardWidth(state.cardCount)) !== state.cardWidth) render();
  else redraw(null);
}
// Draw again after a change that keeps the same cards in the same order (refresh() otherwise): the cards
// `only` picks (none when null) are built again, everything around them as render() does.
function redraw(only, { keepKey } = {}) {
  if (keepKey) { const i = state.entries.findIndex((entry) => entry.key === keepKey); state.selected = i >= 0 ? i : 0; }
  deriveSearch(); // the dropdown's rows carry previews too
  deriveHits();
  render(only || (() => false));
}

// A redraw replaces the buttons it draws (chips, section headers, windows, the actions bar): put the focus
// back on the same one, found by its testid and place, so pressing one with the keyboard doesn't drop the
// focus (Tab would then start again from the top). If it is gone, the search box.
function focusMark() {
  const focusedElement = document.activeElement;
  if (!focusedElement || focusedElement === elements.search || !elements.app.contains(focusedElement) || !focusedElement.dataset.testid) return null;
  const same = [...elements.app.querySelectorAll(`[data-testid="${focusedElement.dataset.testid}"]`)];
  return { f: focusedElement, id: focusedElement.dataset.testid, nth: same.indexOf(focusedElement) };
}
function refocus(savedFocus) {
  if (!savedFocus || savedFocus.f.isConnected) return;
  const same = elements.app.querySelectorAll(`[data-testid="${savedFocus.id}"]`);
  const matchedElement = same[Math.min(savedFocus.nth, same.length - 1)];
  (matchedElement && matchedElement.tabIndex >= 0 && !matchedElement.closest('[hidden]') ? matchedElement : elements.search).focus({ preventScroll: true });
}

// The count in the search box: how many tabs are shown, or how many open and closed tabs the search found.
function renderCount() {
  elements.count.textContent = state.query.trim() ? translate('countSearch', { open: state.found.length, closed: state.foundClosed.length }) : translate('tabs', { count: state.matchCount });
}

// Text cut short with "…" gets its full wording as a tooltip.
function tipTruncated() {
  for (const element of document.querySelectorAll('.group-name, .host, .window-label')) {
    if (element.scrollWidth > element.clientWidth + 1) element.title = element.textContent; else if (element.title === element.textContent) element.removeAttribute('title');
  }
}

// The header wraps on a narrow window: below 1100 px the media player gets its own row under the search box
// (and as wide), below 900 px the buttons around them show only their icons. The card area follows its height (setTop).
const NARROW_WIDTH = 1100, TIGHT_WIDTH = 900;
function layoutHeader(width = window.innerWidth) {
  elements.bar.classList.toggle('narrow', width < NARROW_WIDTH);
  elements.bar.classList.toggle('tight', width < TIGHT_WIDTH);
}

// The card area starts below the header, the toolbar, the alert bar and the quick-actions bar (if shown).
const topOf = () => elements.bar.offsetHeight + elements.tools.offsetHeight + (elements.alert.hidden ? 0 : elements.alert.offsetHeight + 4); // the actions pill floats: not counted
function setTop() {
  elements.body.style.setProperty('--top', topOf() + 'px');
}

function toTop() { elements.scroller.scrollTop = 0; }
function refresh({ keepKey } = {}) {
  const previousKey = keepKey || (state.entries[state.selected] || {}).key;
  derive();
  const i = state.entries.findIndex((entry) => entry.key === cardKey(previousKey)); // (a tab now in a tile: the tile)
  state.selected = i >= 0 ? i : 0;
  render();
}

// -------------------------------------------------------------- selection
// The cards on screen in state.entries order (render() and redrawCards() keep it), and the one marked selected
// and the list that points at it: a hover only touches the card it leaves and the one it reaches.
let cardList = [], selectedCard = null, selectedList = null;
function cardAt(i) {
  let card = cardList[i];
  if (!card || !card.isConnected || card._i !== i) { cardList = [...document.querySelectorAll('#scroller .card')]; card = cardList[i]; } // (not the archive overlay's)
  return card || null;
}
function select(i, { scroll = true } = {}) {
  const entryCount = state.entries.length;
  if (!entryCount) { state.selected = 0; return syncCombo(); }
  state.selected = ((i % entryCount) + entryCount) % entryCount;
  const currentCard = cardAt(state.selected);
  if (!selectedCard || !selectedCard.isConnected) { // drawn some other way: check them all, as once
    document.querySelectorAll('#scroller .card').forEach((card) => card.setAttribute('aria-selected', String(card === currentCard)));
    document.querySelectorAll('#scroller [role=listbox]').forEach((listElement) => listElement.removeAttribute('aria-activedescendant'));
    selectedList = null;
  } else if (selectedCard !== currentCard) selectedCard.setAttribute('aria-selected', 'false');
  if (currentCard) currentCard.setAttribute('aria-selected', 'true');
  selectedCard = currentCard;
  syncCombo();
  if (!currentCard) return;
  const list = currentCard.closest('[role=listbox]');
  if (selectedList && selectedList !== list) selectedList.removeAttribute('aria-activedescendant');
  list.setAttribute('aria-activedescendant', currentCard.id);
  selectedList = list;
  if (scroll) currentCard.scrollIntoView({ block: 'nearest' });
}
// The search box is a combobox: the focus stays in it, so screen readers follow its aria-activedescendant,
// the dropdown's highlighted row while that shows, else the selected card.
function syncCombo() {
  const row = document.querySelector('.dropdown') && document.getElementById('dropdown-' + state.dropdown.highlighted);
  elements.search.setAttribute('aria-expanded', String(!!row));
  const currentCard = row || cardAt(state.selected);
  if (currentCard) elements.search.setAttribute('aria-activedescendant', currentCard.id);
  else elements.search.removeAttribute('aria-activedescendant');
}

// Alt+Q / Tab cycle through open tabs only; arrows can reach "Recently closed".
// The sort orders the cards on screen, so this follows recent use (like Alt+Tab), not screen order.
// Alt+Q / Alt+W, the wheel while holding Alt, and Tab step through the open tabs in the order the cards
// are shown (pinned first, then the chosen sort), wrapping around at the ends: d = +1 is the next card,
// -1 the one before. From the selected card, or from the current tab when something else is selected.
function stepKey(from, direction) {
  // every open tab the filters show (collapsed ones too), as Alt+Q / Alt+W step (derive); a group tile stands for its tabs
  const list = (state.steps || state.matches).map((entry) => entry.key);
  const count = list.length;
  if (!count) return null;
  let here = list.indexOf(from && cardKey(from));
  if (here < 0) here = list.indexOf(cardKey('t' + CONTEXT.sourceTab));
  if (here < 0) here = direction > 0 ? -1 : count;
  return list[(((here + direction) % count) + count) % count];
}
function cycle(direction) {
  const currentEntry = state.entries[state.selected];
  const step = stepFrom(currentEntry && (currentEntry.kind === 'tab' || currentEntry.kind === 'group') ? currentEntry.key : null, direction);
  if (step.leave) return refresh({ keepKey: stepOutOfGroup(direction) });
  if (step.key) selectKey(step.key);
}
// Where a step goes from the card `from` (d = +1 next, -1 previous). Among all the cards a group is its tile, one
// step like any card (letting go of Alt on it opens it: choose). In the group view, the group's tabs; past its
// first or last one the step leaves the group: { leave: true } (stepOutOfGroup goes on from there).
// Settings -> "Alt+Q / Alt+W go round inside a group": they wrap at its ends instead of stepping out.
function stepFrom(from, direction) {
  if (state.inGroup === null) return { key: stepKey(from, direction) };
  const list = (state.steps || state.matches).map((entry) => entry.key);
  if (!list.length) return { leave: true };
  let here = list.indexOf(from);
  if (here < 0) here = list.indexOf('t' + CONTEXT.sourceTab);
  const to = here < 0 ? (direction > 0 ? 0 : list.length - 1) : here + direction;
  if (preference('groupWrap')) return { key: list[((to % list.length) + list.length) % list.length] };
  return to >= 0 && to < list.length ? { key: list[to] } : { leave: true };
}
// Out of the group view by a step past its ends: the step lands on the card before or after the group's tile among
// all the cards, which may be another group's tile (not opened: only letting go of Alt there does). Returns that
// card's key. The group stays remembered (Esc then still finds it next time); switching to a tab outside it leaves
// it at the next open (boot), and opening another group replaces it.
function stepOutOfGroup(direction) {
  const id = state.inGroup;
  state.group = null;
  state.leftGroup = id; // (a reload this open doesn't bring it back)
  derive();
  const list = (state.steps || state.matches).map((entry) => entry.key);
  if (!list.length) return null;
  const at = list.indexOf('g' + id);
  return at < 0 ? list[direction > 0 ? 0 : list.length - 1] : list[(((at + direction) % list.length) + list.length) % list.length];
}

// Select an open tab by key; if it sits in a collapsed section, open that section for this visit.
function selectKey(key) {
  key = cardKey(key);
  let i = state.entries.findIndex((entry) => entry.key === key);
  if (i < 0) {
    const entry = state.mruOrder.find((x) => x.key === key);
    if (!entry || !entry.section) return;
    state.peek.add(entry.section);
    refresh({ keepKey: key });
    return;
  }
  select(i);
}

// ← / → by where they point on screen: +1 toward the next card. Right-to-left (Arabic, Hebrew), the next one is on the left.
const ahead = (arrowKey) => ((arrowKey === 'ArrowRight') !== isRtl() ? 1 : -1);
function moveSpatial(deltaX, deltaY) {
  const cards = [...document.querySelectorAll('#scroller .card')];
  if (!cards[state.selected]) return;
  if (deltaX) return select(state.selected + deltaX);
  const best = cardToward(cards, state.selected, deltaY);
  if (best >= 0) select(best);
}
// The card above (dy < 0) or below (dy > 0) cards[from]: the nearest row that way, the closest across. -1 if none.
function cardToward(cards, from, deltaY) {
  const fromBounds = cards[from].getBoundingClientRect();
  const centerX = fromBounds.left + fromBounds.width / 2;
  let best = -1, bestScore = Infinity;
  cards.forEach((card, index) => {
    if (index === from) return;
    const bounds = card.getBoundingClientRect();
    const gap = deltaY > 0 ? bounds.top - fromBounds.bottom : fromBounds.top - bounds.bottom;
    if (gap < -4) return; // not in that direction
    const score = gap * 4 + Math.abs(bounds.left + bounds.width / 2 - centerX);
    if (score < bestScore) { bestScore = score; best = index; }
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
  state.selected = 0;
  refresh({ keepKey: '-' });
  toTop();
}

function toggleStarFilter() {
  state.starOnly = !state.starOnly;
  state.selected = 0;
  refresh({ keepKey: '-' });
  toTop();
}

// Whether Tabazing can keep a star or a note for this address (it keeps them by address, up to a length).
const canKeep = (url) => { const key = normalizeUrl(url); return !!key && key.length <= LIMITS.MAX_URL_KEY; };
async function star(entry) {
  if (!entry || !entry.url || (entry.item && entry.item.kind === 'window')) return;
  if (!canKeep(entry.url)) return toast(translate('urlTooLong'));
  const on = await toggleStar(entry.url, entry.tab ? entry.tab.title : entry.item.title).catch(() => null);
  if (on === null || state.done) return;
  state.stars = await getStars().catch(() => state.stars);
  if (on) await loadStarPreviews();
  // Unstarring a starred-not-open card removes it from the list: keep the selection near it.
  const i = state.entries.indexOf(entry);
  // (Starred in the history or bookmarks view: not a card, so the selection stays where it is.)
  const next = i < 0 ? state.entries[state.selected] : !on && entry.kind === 'star' ? [state.entries[i + 1], state.entries[i - 1]].find((candidate) => candidate && candidate !== entry) : entry;
  // Only the Starred filter shows or hides cards by their star: else just the cards of that page change.
  const key = normalizeUrl(entry.url);
  if (state.starOnly) refresh({ keepKey: next && next.key });
  else redraw((candidate) => normalizeUrl(candidate.kind === 'tab' ? urlOf(candidate.tab) : candidate.item ? candidate.item.url : '') === key, { keepKey: next && next.key });
}

// Take one tab's preview now. Showing a tab in the window the overlay sits in hides the page the
// overlay lives on (which closes it), so then the background opens the switcher again afterwards.
async function captureOne(entry) {
  if (!entry || entry.kind !== 'tab' || state.capturing || state.done || !canCapture(entry.tab)) return;
  const tab = entry.tab;
  const leaves = CONTEXT.mode === 'overlay' && tab.windowId === CONTEXT.sourceWindow;
  if (leaves) {
    await setResume({ query: state.query, scope: state.scope, starred: state.starOnly, key: entry.key }).catch(() => {});
    chrome.runtime.sendMessage({ type: MESSAGE.CAPTURE_ONE, tabId: tab.id, reopen: CONTEXT.sourceTab }).catch(() => {});
    return finish('switch');
  }
  state.capturing = tab.id;
  asking = true; // the tab switch may move focus for a moment: don't close
  refresh({ keepKey: entry.key });
  try { await chrome.runtime.sendMessage({ type: MESSAGE.CAPTURE_ONE, tabId: tab.id }); } catch {}
  asking = false;
  state.capturing = null;
  if (state.done) return;
  window.focus();
  const fetchedPreviews = await readPreviews([urlOf(tab)]).catch(() => ({}));
  const preview = fetchedPreviews[normalizeUrl(urlOf(tab))];
  if (preview) state.previews[tab.id] = preview;
  else { // Chrome refused (or the page never finished loading): say so instead of doing nothing
    state.noCapture = await getNoCapture().catch(() => state.noCapture);
    toast(translate(state.noCapture.has(normalizeUrl(urlOf(tab))) ? 'captureBlocked' : 'captureFailed'));
  }
  refresh({ keepKey: entry.key });
}

function setScope(scope) {
  state.scope = scope;
  state.selected = 0;
  refresh({ keepKey: '-' });
  toTop();
}
function cycleScope(direction) {
  if (state.windows.length < 2) return;
  const scopeIds = ['all', ...state.windows.map((windowEntry) => windowEntry.id)];
  const i = scopeIds.indexOf(state.scope);
  setScope(scopeIds[(((i + direction) % scopeIds.length) + scopeIds.length) % scopeIds.length]);
}

// ---------------------------------------------------------------- actions
// Single exit path, runs at most once. `reason` tells the background what
// to do with focus: 'cancel' puts the original window back in front.
async function finish(reason) {
  if (state.done || !launched) return; // (a prepared frame was never open)
  state.done = true;
  if (state.toSleep.size) chrome.runtime.sendMessage({ type: MESSAGE.SLEEP, tabIds: [...state.toSleep] }).catch(() => {});
  chrome.runtime.sendMessage({
    type: MESSAGE.CLOSED, reason, sourceTab: CONTEXT.sourceTab, window: CONTEXT.sourceWindow, state: CONTEXT.sourceState,
  }).catch(() => {});
  if (CONTEXT.mode === 'overlay') {
    // Target '*': the host page's origin isn't known here, and the message
    // carries nothing but "close".
    parent.postMessage({ tabazing: FRAME_MESSAGE.CLOSE }, '*');
  } else {
    if (reason === 'cancel') {
      try { await chrome.windows.update(CONTEXT.sourceWindow, { focused: true }); } catch {}
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
      if (CONTEXT.mode === 'window') await chrome.windows.update(CONTEXT.sourceWindow, { focused: true }).catch(() => {});
      await chrome.tabs.create({ url: entry.item.url, windowId: CONTEXT.sourceWindow, active: true });
      return finish('switch');
    }
    if (entry.kind === 'star') { // a starred page that isn't open: open it
      if (CONTEXT.mode === 'window') await chrome.windows.update(CONTEXT.sourceWindow, { focused: true }).catch(() => {});
      await chrome.tabs.create({ url: entry.item.url, windowId: CONTEXT.sourceWindow, active: true });
      return finish('switch');
    }
    if (entry.kind === 'tab') return await switchToTab(entry.tab);
    // Recently closed: restore into the window the user came from.
    if (CONTEXT.mode === 'window') await chrome.windows.update(CONTEXT.sourceWindow, { focused: true }).catch(() => {});
    const item = entry.item;
    if (item.session) await chrome.sessions.restore((item.session.tab || item.session.window).sessionId);
    else await reopenPage(item, { active: true }); // from our own log: reopen the page (in its group)
    return finish('restore');
  } catch (error) {
    console.warn('[Tabazing] could not open entry:', error && error.message);
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
  elements.search.value = state.query = ''; // the group's cards, none of them dimmed
  state.dropdown.hidden = true;
  await setGroup(id).catch(() => {});
  if (state.done) return;
  const recent = state.tabs.filter((x) => x.groupId === id);
  const pick = recent.find((x) => x.id !== CONTEXT.sourceTab) || recent[0];
  refresh({ keepKey: pick ? 't' + pick.id : '-' });
  toTop();
  elements.search.focus({ preventScroll: true });
  elements.live.textContent = translate('groupEntered', { name: groupName(state.groups.get(id)), tabs: translate('tabs', { count: state.matchCount }) });
}
// Out of the group view, back to every tab, with the group's tile selected.
async function leaveGroup() {
  if (state.done || state.group === null) return;
  const id = state.group;
  state.group = null;
  await setGroup(null).catch(() => {});
  if (state.done) return;
  refresh({ keepKey: 'g' + id });
  elements.search.focus({ preventScroll: true });
  elements.live.textContent = translate('groupLeft');
}

// Show an open tab and close the switcher (a card, or "Go to tab" in the media list). Rejects when Chrome can't.
async function switchToTab(tab) {
  if (tab.id === CONTEXT.sourceTab && CONTEXT.mode === 'overlay') return finish('cancel');
  await chrome.tabs.update(tab.id, { active: true });
  if (CONTEXT.mode === 'window' || tab.windowId !== CONTEXT.sourceWindow) {
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
    const next = [state.entries[i + 1], state.entries[i - 1]].find((candidate) => candidate && candidate !== entry);
    state.snoozed = await removeSnoozed([entry.item.id]).catch(() => state.snoozed);
    toast(translate('snoozeCancelled'));
    return refresh({ keepKey: next && next.key });
  }
  if (!entry || entry.kind !== 'tab' || state.done) return;
  const id = entry.tab.id;
  const i = state.entries.indexOf(entry);
  const neighbour = [state.entries[i + 1], state.entries[i - 1]].find((candidate) => candidate && candidate.kind === 'tab');
  const undo = undoRecord([entry.tab]);
  try { await chrome.tabs.remove(id); } catch { return; }
  if (id === CONTEXT.sourceTab && CONTEXT.mode === 'overlay') return; // overlay closes with its tab
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
  const goes = (entry) => (entry.kind === 'tab' && entry.tab.id === id)
    || (entry.kind === 'group' && entry.tabs.some((x) => x.id === id) && entry.tabs.every((x) => x.id === id || !state.tabs.some((y) => y.id === x.id)));
  const i = state.entries.findIndex(goes);
  if (!keepKey && i >= 0 && i === state.selected) {
    const next = [state.entries[i + 1], state.entries[i - 1]].find((entry) => entry && (entry.kind === 'tab' || entry.kind === 'group'));
    keepKey = next && next.key;
  }
  state.tabs = state.tabs.filter((x) => x.id !== id);
  state.picked.delete(id);
  state.windows = state.windows
    .map((windowEntry) => (windowEntry.id === tab.windowId ? { ...windowEntry, count: windowEntry.count - 1 } : windowEntry))
    .filter((windowEntry) => windowEntry.count > 0);
  refresh({ keepKey });
}

// ------------------------------------------------------------ quick actions
// Tick tabs (the box on a card, Ctrl/Cmd+click, Shift+click for a range, or "Select all" while
// searching), then act on all of them at once. With nothing ticked, the bar acts on every tab the
// search found. Everything here only calls Chrome's own tab APIs.
// `on`: true, false, or 'mixed' (a group tile with some of its tabs ticked).
function pickBox(entry, on) {
  const button = makeElement('button', 'pick' + (on === true ? ' on' : on === 'mixed' ? ' mixed' : ''), null, 'card-pick');
  button.type = 'button';
  button.setAttribute('role', 'checkbox');
  button.setAttribute('aria-checked', String(on));
  button.setAttribute('aria-label', translate('pickAria'));
  button.title = translate('pickTitle');
  button.append(svgOf(ICON.check));
  button.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) pick(entry, { range: event.shiftKey }); });
  return button;
}
function pick(entry, { range = false } = {}) {
  state.shiftBase = null; // a tick by hand ends a run of Shift+arrows
  if (entry.kind === 'group') { // a tile: all of its tabs, or (all ticked already) none of them
    const before = new Set(state.picked);
    const tabIds = entry.tabs.map((x) => x.id);
    const all = tabIds.every((x) => state.picked.has(x));
    tabIds.forEach((x) => (all ? state.picked.delete(x) : state.picked.add(x)));
    state.lastPick = null;
    return redraw(tickChanged(before), { keepKey: entry.key });
  }
  const id = entry.tab.id;
  const onScreen = state.entries.filter((entry) => entry.kind === 'tab').map((entry) => entry.tab.id);
  const fromIndex = range && state.lastPick !== null ? onScreen.indexOf(state.lastPick) : -1;
  const toIndex = onScreen.indexOf(id);
  const before = new Set(state.picked);
  if (fromIndex >= 0 && toIndex >= 0) onScreen.slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1).forEach((x) => state.picked.add(x));
  else if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  state.lastPick = id;
  redraw(tickChanged(before), { keepKey: entry.key }); // only the cards that changed
}
const pickPool = () => (state.query.trim() ? state.found : state.matches); // what "Select all" ticks: the search's matches, or the cards
// (Ticks don't change which cards show: only the ticked or unticked ones are drawn again.)
// (A group tile shows its tabs' ticks: all of them ticked, or some.)
function selectAll() { const before = new Set(state.picked); state.shiftBase = null; pickPool().forEach((entry) => state.picked.add(entry.tab.id)); redraw(tickChanged(before)); }
function clearPicks() { const before = new Set(state.picked); state.picked.clear(); state.lastPick = null; state.shiftBase = null; redraw(tickChanged(before)); }
// Shift+arrows: tick from the card the run started on to the one the arrow reaches, like a file list. The run
// keeps the ticks there were before it and lays its range over them, so stepping back shrinks the range again.
function extendPick(key) {
  const from = state.entries[state.selected];
  if (!from) return;
  const across = key === 'ArrowRight' || key === 'ArrowLeft';
  if (across && !state.entries[state.selected + ahead(key)]) return; // at the first or last card: the range stays (no wrapping round)
  if (from.kind === 'tab' && !state.shiftBase) { state.shiftBase = new Set(state.picked); state.lastPick = from.tab.id; }
  if (across) moveSpatial(ahead(key), 0);
  else moveSpatial(0, key === 'ArrowDown' ? 1 : -1);
  const to = state.entries[state.selected];
  if (from.kind !== 'tab' || !to || to.kind !== 'tab') return; // from a tile or a closed card: it only moves
  const onScreen = state.entries.filter((entry) => entry.kind === 'tab').map((entry) => entry.tab.id);
  const fromIndex = onScreen.indexOf(state.lastPick), toIndex = onScreen.indexOf(to.tab.id);
  if (fromIndex < 0) return;
  const before = new Set(state.picked);
  state.picked = new Set([...state.shiftBase, ...onScreen.slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex) + 1)]);
  redraw(tickChanged(before), { keepKey: to.key });
}

// Quick actions act only on ticked tabs. While searching, "Select all N matching tabs" ticks the matches.
function targets() { return state.tabs.filter((x) => state.picked.has(x.id)); }

// `err`: what the note says when Chrome refuses. Closing has Undo, so it doesn't ask "sure?" first.
const ACTIONS = [
  { id: 'close', icon: 'close', label: () => translate('actionClose'), title: () => translate('actionCloseTitle'), run: closeMany, error: () => translate('errorClose') },
  { id: 'copy', icon: 'link', label: () => translate('actionCopy'), title: () => translate('actionCopyTitle'), run: (tabs) => copyLinks(tabs, 'plain'), error: () => translate('copyFailed') },
  // In "More" (⋯): used less often.
  { id: 'markdown', more: true, label: () => translate('actionCopyMarkdown'), title: () => translate('actionCopyMarkdownTitle'), run: (tabs) => copyLinks(tabs, 'markdown'), error: () => translate('copyFailed') },
  { id: 'window', more: true, label: () => translate('actionNewWindow'), run: moveToNewWindow, error: () => translate('errorMove') },
  { id: 'sleep', more: true, label: () => translate('actionSleep'), run: sleepTabs, error: () => translate('errorSleep') },
  { id: 'snooze', more: true, label: () => translate('actionSnooze'), run: (tabs, button) => snoozeMenu(tabs, button), error: () => translate('errorSnooze') },
  { id: 'archive', more: true, label: () => translate('actionArchive'), run: archiveTabs, error: () => translate('errorArchive') },
  { id: 'group', more: true, label: () => translate('groupAddTo'), run: (tabs, button) => groupMenu(tabs, button), error: () => translate('actionFailed') },
  { id: 'bookmark', more: true, label: () => translate('markMenu'), run: (tabs) => bookmarkDialog(tabs.filter((x) => isWorthReopening(urlOf(x))).map(pageOf)), error: () => translate('markError') },
  { id: 'pin', more: true, label: (tabs) => translate(tabs.length && tabs.every((x) => x.pinned) ? 'actionUnpin' : 'actionPin'), run: pinTabs, error: () => translate('errorPin') },
  { id: 'mute', more: true, label: (tabs) => translate(tabs.length && tabs.every((x) => x.mutedInfo && x.mutedInfo.muted) ? 'actionUnmute' : 'actionMute'), run: muteTabs, error: () => translate('errorMute') },
];

// The floating pill at the bottom: shows while searching (to tick every match), once tabs are ticked,
// and in the duplicates view (to confirm). It floats over the cards, so nothing below it moves.
function renderActions() {
  document.documentElement.classList.toggle('picking', state.picked.size > 0);
  if (state.duplicatesView) return renderDuplicatesBar();
  const tabs = targets();
  const count = tabs.length;
  const show = count > 0 || (!!state.query.trim() && state.found.length > 1);
  elements.actions.hidden = !show;
  elements.actions.classList.remove('duplicates');
  if (!show) return placeToast();
  const pool = pickPool();
  const allPicked = pool.length > 0 && pool.every((entry) => state.picked.has(entry.tab.id));
  elements.actionsCount.textContent = count ? translate('pickedCount', { count }) : '';
  elements.actionsCount.hidden = !count;
  elements.selectAll.hidden = allPicked || !pool.length;
  elements.selectAll.textContent = state.query.trim() ? translate('selectAllMatches', { count: pool.length }) : translate('selectAllTabs', { count: pool.length });
  elements.selectNone.hidden = count === 0;
  elements.actionsHint.hidden = count === 0; // a plain click switches: say how to tick more
  elements.actionsHint.textContent = translate('pickMoreHint', { key: IS_MAC ? '⌘' : 'Ctrl' });
  elements.actionsButtons.hidden = count === 0; // nothing to act on yet: only the "Select all" button shows
  const more = makeElement('button', 'quick-action more', null, 'actions-more');
  more.type = 'button';
  more.title = translate('actionMore');
  more.setAttribute('aria-label', translate('actionMore'));
  more.append(svgOf(ICON.more));
  more.append(makeElement('span', '', translate('actionMore'), 'actions-more-label'));
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!pointerAllowed() || !count) return;
    menu(more, ACTIONS.filter((action) => action.more).map((action) => ({ label: action.label(tabs), error: action.error(), run: () => action.run(targets(), more) })));
  });
  elements.actionsButtons.replaceChildren(...ACTIONS.filter((action) => !action.more).map((action) => {
    const button = makeElement('button', 'quick-action' + (action.id === 'close' ? ' danger' : ''), null, 'action-' + action.id);
    button.type = 'button';
    button.append(svgOf(ICON[action.icon]));
    button.append(makeElement('span', '', action.label(tabs), 'action-label'));
    if (action.title) button.title = action.title();
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!pointerAllowed() || !count) return;
      Promise.resolve(action.run(targets(), button)).catch((error) => toast(action.error(), error));
    });
    return button;
  }), more);
  placeToast();
}

// Duplicates: first a view of just the copies (each card says whether it stays or closes), then confirm.
function renderDuplicatesBar() {
  const duplicateList = duplicates();
  elements.actions.hidden = false;
  elements.actions.classList.add('duplicates');
  elements.actionsCount.hidden = false;
  elements.actionsCount.textContent = duplicateList.length ? translate('duplicatesSummary', { count: duplicateList.length }) : translate('duplicatesNone');
  elements.selectAll.hidden = true;
  elements.selectNone.hidden = true;
  elements.actionsHint.hidden = true;
  elements.actionsButtons.hidden = false;
  const close = makeElement('button', 'quick-action danger', null, 'duplicates-close'); // no "sure?": Undo brings them back
  close.type = 'button';
  close.append(svgOf(ICON.close));
  close.append(makeElement('span', '', translate('duplicatesClose', { count: duplicateList.length }), 'duplicates-close-label'));
  close.disabled = !duplicateList.length;
  close.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeDuplicates(); });
  const back = makeElement('button', 'quick-action', null, 'duplicates-back');
  back.type = 'button';
  back.append(makeElement('span', '', translate('duplicatesBack'), 'duplicates-back-label'));
  back.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) duplicatesView(false); });
  elements.actionsButtons.replaceChildren(close, back);
  placeToast();
}
function duplicatesView(on) {
  state.duplicatesView = on;
  state.picked.clear();
  refresh({ keepKey: '-' });
  toTop();
}

// Small note at the bottom of the switcher ("Copied 5 links"), optionally with one button ("Undo"). It sits
// above the actions bar while that shows (never over it), and waits while the pointer or the focus is on it,
// so its Undo can't run away. Screen readers hear it from the live region (#live-status), which is always
// there: one that shows up together with its text is often not read.
let toastTimer = null;
let toastAction = null; // the shown toast's button action (Undo), while it shows
let toastLeft = 0;   // how long the shown toast still stays (paused while hovered or focused)
let toastFrom = 0;
function toast(text, error, action) {
  if (error) console.warn('[Tabazing]', error && error.message);
  elements.toast.textContent = text;
  elements.live.textContent = action ? text + '. ' + action.label : text;
  toastAction = action ? action.run : null;
  if (action) {
    const button = makeElement('button', 'toast-action', action.label, 'toast-action');
    button.type = 'button';
    button.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) toastUndo(); });
    elements.toast.append(button);
  }
  elements.toast.hidden = false;
  placeToast();
  toastLeft = action ? 5000 : 2600;
  toastRun();
}
function toastRun() {
  clearTimeout(toastTimer);
  toastFrom = performance.now();
  toastTimer = setTimeout(() => { elements.toast.hidden = true; toastAction = null; }, toastLeft);
}
function toastPause() {
  if (elements.toast.hidden || toastLeft <= 0) return;
  clearTimeout(toastTimer);
  toastTimer = null;
  toastLeft = Math.max(1500, toastLeft - (performance.now() - toastFrom)); // a moment to read it once let go
}
function toastResume() {
  if (elements.toast.hidden || toastTimer || elements.toast.matches(':hover') || elements.toast.contains(document.activeElement)) return;
  toastRun();
}
// Above the actions bar while it shows, else at the bottom.
function placeToast() {
  elements.toast.style.bottom = (elements.actions.hidden ? 20 : 20 + elements.actions.offsetHeight + 12) + 'px';
  elements.toast.classList.toggle('lifted', !elements.actions.hidden);
}
// The shown toast's button (Undo), from its click or a key. False when no toast offers one.
function toastUndo() {
  const action = toastAction;
  if (!action || elements.toast.hidden) return false;
  elements.toast.hidden = true;
  toastAction = null;
  action();
  return true;
}

// ---- undo: Ctrl+Z (or Undo in the note that follows) takes back what was last done here: closing tabs,
// merging windows, moving tabs to a new window. Several tabs at once come back together, each in its own
// window and place, pinned as before. `kind`: 'close' | 'merge' | 'move'.
// A tab in a group keeps the group's id, name and colour: it goes back into it (regroup).
const undoRecord = (tabs) => tabs.map((x) => {
  const group = x.groupId >= 0 ? state.groups.get(x.groupId) : null;
  return { id: x.id, url: urlOf(x), windowId: x.windowId, index: x.index, pinned: !!x.pinned, ...(group ? { group: { id: group.id, title: group.title || '', color: groupColor(group) } } : {}) };
});
function pushUndo(tabs, kind = 'close', said = null) {
  if (!tabs.length) return;
  state.undo.push({ kind, tabs, at: Date.now(), inGroup: state.group }); // (the group view it was done in: Undo goes back to it)
  if (state.undo.length > 20) state.undo.shift();
  const text = said || (kind === 'close' ? translate('closedCount', { count: tabs.length }) : kind === 'merge' ? translate('mergedCount', { count: tabs.length }) : translate('movedCount', { count: tabs.length }));
  toast(text, null, { label: translate('undo') + (IS_MAC ? ' (⌘Z)' : ' (Ctrl+Z)'), run: undoLast });
}
async function undoLast() {
  const undoEntry = state.undo.pop();
  if (!undoEntry || state.done) return toast(translate('undoNothing'));
  const closed = undoEntry.kind === 'close';
  try {
    const groups = closed ? await reopenAt(undoEntry.tabs, undoEntry.at) : await moveBack(undoEntry.tabs);
    // Done in a group view whose group went with it (its last tab closed): back in the group as it is again.
    if (undoEntry.inGroup !== null && undoEntry.inGroup !== undefined && groups && groups.has(undoEntry.inGroup)) { state.group = groups.get(undoEntry.inGroup); await setGroup(state.group).catch(() => {}); }
    toast(translate(closed ? 'reopenedCount' : 'movedBackCount', { count: undoEntry.tabs.length }));
  } catch (error) { toast(translate('errorUndo'), error); }
  await loadClosed();
  await reload();
}
// Reopen closed tabs (undoRecord) where they were. One Chrome still lists as recently closed, closed within
// UNDO_SESSION_MILLISECONDS of `at` (when Tabazing closed it), comes back through Chrome, with its back/forward history.
// Chrome shows a tab it restores, so each window then shows the tab it showed before. The others are opened
// afresh, in the background.
const UNDO_SESSION_MILLISECONDS = 10000;
async function reopenAt(group, at = 0) {
  const sessions = at ? await chrome.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []) : [];
  const used = new Set();
  const restoredWindows = new Set(); // windows a restore showed a tab in
  const made = []; // [{ x, tab }] what came back, for regroup
  for (const x of [...group].sort((firstTab, secondTab) => firstTab.index - secondTab.index)) {
    const session = sessions.find((session) => session.tab && !used.has(session.tab.sessionId) && normalizeUrl(urlOf(session.tab)) === normalizeUrl(x.url)
      && Math.abs((session.lastModified || 0) * 1000 - at) <= UNDO_SESSION_MILLISECONDS);
    if (session) {
      used.add(session.tab.sessionId);
      asking = true; // Chrome shows the restored tab for a moment: that is not the user leaving
      try { const restoredSession = await chrome.sessions.restore(session.tab.sessionId); restoredWindows.add(x.windowId); made.push({ x, tab: restoredSession && restoredSession.tab }); continue; } catch {}
    }
    try { made.push({ x, tab: await chrome.tabs.create({ url: x.url, windowId: x.windowId, index: x.index, pinned: x.pinned, active: false }) }); }
    catch { made.push({ x, tab: await chrome.tabs.create({ url: x.url, windowId: CONTEXT.sourceWindow, active: false }).catch(() => null) }); } // its window is gone
  }
  const groups = await regroup(made);
  for (const x of state.tabs) if (x.active && restoredWindows.has(x.windowId)) await chrome.tabs.update(x.id, { active: true }).catch(() => {});
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
    const groupKey = x.group.id + ':' + now.windowId;
    if (!byGroup.has(groupKey)) byGroup.set(groupKey, { g: x.group, window: now.windowId, ids: [] });
    byGroup.get(groupKey).ids.push(tab.id);
  }
  for (const { g: group, window: windowId, ids: tabIds } of byGroup.values()) {
    try { out.set(group.id, await putInGroup(tabIds, group, windowId)); }
    catch (error) { console.warn('[Tabazing] could not put tabs back in their group:', error && error.message); }
  }
  return out;
}
// Put moved tabs (undoRecord) back in their windows and places: the undo of a merge or of "Move to new window".
// A window that closed meanwhile (a merge empties it) is made again, behind Tabazing.
async function moveBack(tabs) {
  const open = new Set((await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => [])).map((browserWindow) => browserWindow.id));
  const tabsByWindow = new Map();
  for (const x of tabs) { if (!tabsByWindow.has(x.windowId)) tabsByWindow.set(x.windowId, []); tabsByWindow.get(x.windowId).push(x); }
  for (const [windowId, list] of tabsByWindow) {
    list.sort((firstTab, secondTab) => firstTab.index - secondTab.index);
    let target = windowId, rest = list;
    if (!open.has(windowId)) {
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
const showsTab = (entry, tabIds) => (entry.kind === 'tab' ? tabIds.has(entry.tab.id) : entry.kind === 'group' && entry.tabs.slice(0, 4).some((x) => tabIds.has(x.id)));
// Draw what arrived meanwhile: some tabs' cards (`ids`, new previews), or everything (refresh).
function drawLater(tabIds) {
  if (!tabIds) return refresh();
  const set = new Set(tabIds);
  redraw((entry) => showsTab(entry, set));
}

// Reload the tab list after Chrome has acted (pin, mute, move...), keeping the selection.
async function reload() {
  if (state.done) return;
  const key = (state.entries[state.selected] || {}).key;
  await load();
  await loadExtras();
  if (!state.done) refresh({ keepKey: key });
}

async function closeMany(tabs) {
  const tabIds = tabs.map((x) => x.id);
  const includesOwnTab = CONTEXT.mode === 'overlay' && tabIds.includes(CONTEXT.sourceTab); // closing the tab we sit on closes us: do it last
  const undo = undoRecord(tabs);
  await chrome.tabs.remove(tabIds.filter((id) => !includesOwnTab || id !== CONTEXT.sourceTab));
  state.picked.clear();
  if (includesOwnTab) return chrome.tabs.remove(CONTEXT.sourceTab);
  tabIds.forEach((id) => { state.tabs = state.tabs.filter((x) => x.id !== id); });
  pushUndo(undo);
  setTimeout(async () => { await loadClosed(); await reload(); }, 200);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // Inside a web page's frame the page may not allow the clipboard API: the old way still works.
  const back = state.palette ? elements.paletteInput : elements.search; // where the focus goes back to
  elements.clip.value = text;
  elements.clip.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  elements.clip.value = '';
  back.focus({ preventScroll: true });
  return ok;
}
async function copyLinks(tabs, format) {
  const escapeMarkdown = (text) => String(text || '').replace(/([\[\]])/g, '\\$1');
  const text = tabs.map((x) => (format === 'markdown' ? `- [${escapeMarkdown(x.title || hostOf(urlOf(x)))}](${urlOf(x)})` : urlOf(x))).join('\n');
  toast((await copyText(text)) ? translate('copiedCount', { count: tabs.length }) : translate('copyFailed'));
}

// Move tabs to a new window, in their order. It opens behind Tabazing, which stays, so the move can be undone;
// in an overlay, with the tab Tabazing is drawn over among them, Tabazing goes along to the new window and closes.
async function moveToNewWindow(tabs) {
  const undo = undoRecord(tabs);
  const includesOwnTab = CONTEXT.mode === 'overlay' && tabs.some((x) => x.id === CONTEXT.sourceTab);
  const [first, ...rest] = tabs;
  asking = true; // the new window may take the focus for a moment
  try {
    const newWindow = await chrome.windows.create({ tabId: first.id, focused: includesOwnTab });
    if (rest.length) await chrome.tabs.move(rest.map((x) => x.id), { windowId: newWindow.id, index: -1 });
    await regroup(undo.map((x) => ({ x, tab: { id: x.id } }))); // their groups go along (one of each, in the new window)
  } finally { asking = false; }
  state.picked.clear();
  if (includesOwnTab) return finish('switch');
  window.focus();
  await reload();
  pushUndo(undo, 'move');
}

// The header's "New tab" (and the palette's): a new tab in the window Tabazing was opened from. In the group view
// the header's goes into that group (and its window).
async function openNewTab({ group = null } = {}) {
  const targetGroup = group !== null ? state.groups.get(group) : null;
  const windowId = targetGroup ? targetGroup.windowId : CONTEXT.sourceWindow;
  try {
    if (CONTEXT.mode === 'window' || windowId !== CONTEXT.sourceWindow) await chrome.windows.update(windowId, { focused: true }).catch(() => {});
    const tab = await chrome.tabs.create({ windowId, active: true });
    if (targetGroup && chrome.tabs.group) await chrome.tabs.group({ tabIds: tab.id, groupId: targetGroup.id }).catch(() => {});
  } catch {}
  finish('switch');
}
// "Capture all previews" (the camera in the toolbar, or the palette): the background shows each tab without a
// preview for a moment, then opens Tabazing again; with nothing to capture, a note says so.
function captureAll() {
  const tabIds = missingPreviews().map((x) => x.id).slice(0, LIMITS.SWEEP_MAX_TABS);
  asking = true; // the progress window takes focus: that is not the user leaving
  return chrome.runtime.sendMessage({ type: MESSAGE.SWEEP, tabIds, reopen: CONTEXT.mode === 'overlay' ? CONTEXT.sourceTab : null })
    .then((response) => { asking = false; if (response && response.n) finish('switch'); else toast(translate('sweepNothing')); })
    .catch(() => { asking = false; toast(translate('errorCapture')); });
}
// A search began or changed (the box's or the palette's): the first one reads the bookmarks and recent history
// (once, unless Settings -> Search leaves them out); Chrome's history search reaches older pages a moment later.
function startSearch(query) {
  if (query && state.marks === null && preference('searchBookmarks')) loadMarks();
  if (query && state.history === null && preference('searchHistory')) loadHistory();
  searchHistory(query);
}

// ---- open or search from the box: what was typed, when nothing matches it (or Shift+Enter).

// Something that looks like an address opens as one; anything else is searched on Google (utils/web.js).
async function openFromBox(text) {
  const url = asUrl(text);
  try {
    if (CONTEXT.mode === 'window') await chrome.windows.update(CONTEXT.sourceWindow, { focused: true }).catch(() => {});
    await chrome.tabs.create({ url: url || googleUrl(text), windowId: CONTEXT.sourceWindow, active: true });
  } catch (error) { console.warn('[Tabazing] could not open from the search box:', error && error.message); }
  finish('switch');
}

// ---- the search dropdown: as you type, under the search box, one list of everything that matches (open
// tabs, archived tabs, bookmarks, recently closed, history), best match first, each with an icon saying where
// it comes from. With nothing found: a Google search (and "Open ..." first when the text looks like an
// address). ↑/↓ move, Enter opens, the mouse too.
const DROPDOWN_MAX = 14;
// Where a result comes from: its icon at the end of the title row, and which one comes first when two
// match equally well (lowest first): open tabs, then recently closed, archived, bookmarks, history.
const DROPDOWN_SOURCES = {
  tab: { rank: 0, icon: 'tab', label: 'sourceTab' },
  closed: { rank: 1, icon: 'history', label: 'recentlyClosed' },
  archived: { rank: 2, icon: 'archive', label: 'archivedLabel' },
  mark: { rank: 3, icon: 'bookmark', label: 'sourceMark' },
  visit: { rank: 4, icon: 'visited', label: 'dropdownHistory' },
  group: { rank: 0, icon: 'tab', label: 'sourceGroup' },
};
async function loadMarks() {
  state.marks = [];
  if (!chrome.bookmarks) return;
  try {
    const out = [];
    const [tree, bookmarkNotes] = await Promise.all([chrome.bookmarks.getTree(), getBookmarkNotes().catch(() => state.bookmarkNotes || {})]);
    state.bookmarkNotes = bookmarkNotes;
    // Archived tabs have their own section: leave out the "Tabs Archive" folder in "Other bookmarks" (as utils/archive.js finds it).
    const kids = (tree[0] && tree[0].children) || [];
    const other = kids.find((node) => node.folderType === 'other') || kids.find((node) => node.id === '2') || kids[1] || kids[0];
    const archiveFolder = other && (other.children || []).find((node) => !node.url && node.title === ARCHIVE_FOLDER);
    const walk = (node, path) => {
      if (archiveFolder && node.id === archiveFolder.id) return;
      if (node.url) { if (/^(https?|file|ftp):/i.test(node.url)) out.push({ id: node.id, title: node.title || '', url: node.url, path: path.join(' › ') }); return; }
      for (const child of node.children || []) walk(child, node.title ? [...path, node.title] : path);
    };
    tree.forEach((root) => walk(root, []));
    state.marks = out;
  } catch { state.marks = []; }
  if (!state.done && searchText()) renderSearch();
}
// History (needs the history permission): the last 90 days read once and matched like everything else
// (typos and all), plus Chrome's own history search for what was typed, which reaches further back.
const historyEntryOf = (x) => ({ url: x.url, title: x.title || '', t: x.lastVisitTime || 0, n: x.visitCount || 0 });
async function loadHistory() {
  state.history = [];
  if (!chrome.history) return;
  try {
    const items = await chrome.history.search({ text: '', startTime: Date.now() - 90 * 864e5, maxResults: 5000 });
    state.history = items.filter((x) => /^(https?|file|ftp):/i.test(x.url || '')).map(historyEntryOf);
  } catch { state.history = []; }
  if (!state.done && searchText()) renderSearch();
}
let historyTimer = null;
function searchHistory(query) {
  clearTimeout(historyTimer);
  if (!query || !chrome.history || !preference('searchHistory')) { state.historyQuery = { query: '', items: [] }; return; }
  historyTimer = setTimeout(async () => {
    try {
      const items = await chrome.history.search({ text: query, startTime: 0, maxResults: 60 });
      if (searchText() !== query || state.done) return;
      state.historyQuery = { query, items: items.filter((x) => /^(https?|file|ftp):/i.test(x.url || '')).map(historyEntryOf) };
      renderSearch();
    } catch {}
  }, 120);
}
// What is being searched for: the palette's text while it shows, else the search box's (trimmed).
const searchText = () => (state.palette ? elements.paletteInput.value : state.query).trim();
// Draw the results again (a source finished loading): in the palette while it shows, else the dropdown.
const renderSearch = () => (state.palette ? renderPalette() : renderDropdown());
// Every history entry (the last 90 days, and Chrome's own search for the text), once per page, newest first.
// Built again only when one of the two lists changes. `text`: the text searched for (trimmed).
let historyMemo = { history: undefined, historyQuery: undefined, items: [] };
function historyItems(text = state.query.trim()) {
  const historyQuery = state.historyQuery.query === text ? state.historyQuery : null;
  if (historyMemo.history === state.history && historyMemo.historyQuery === historyQuery) return historyMemo.items;
  const byUrl = new Map();
  for (const x of [...(state.history || []), ...(historyQuery ? historyQuery.items : [])]) {
    const key = urlKey(x.url);
    if (key && !byUrl.has(key)) byUrl.set(key, x);
  }
  historyMemo = { history: state.history, historyQuery, items: [...byUrl.values()].sort((firstEntry, secondEntry) => secondEntry.t - firstEntry.t) };
  return historyMemo.items;
}
// normalizeUrl, remembered (it parses the URL): the same thousands of addresses come up on every keystroke.
const urlKeys = new Map();
function urlKey(url) {
  let key = urlKeys.get(url);
  if (key === undefined) {
    key = normalizeUrl(url) || url;
    if (urlKeys.size > 50000) urlKeys.clear();
    urlKeys.set(url, key);
  }
  return key;
}
// Bookmarks and history can be thousands of pages. While the text only grows (another letter or word), the
// pages that matched before are the ones worth scoring; once typing pauses, all of them are scored again
// (a typo match can show up only then). [{ item, score }] in the list's own order.
const bigHits = {}; // source -> { items, q, hits }
let fullTimer = null;
function scoreBig(name, items, query, score) {
  const cached = bigHits[name];
  if (cached && cached.items === items && cached.query === query && cached.notes === state.notes) return cached.hits;
  const narrow = !!cached && cached.items === items && cached.notes === state.notes && !!cached.query && query.startsWith(cached.query); // (a note written meanwhile: all again)
  const hits = [];
  for (const it of narrow ? cached.hits.map((x) => x.item) : items) { const scoreValue = score(it); if (scoreValue > 0) hits.push({ item: it, score: scoreValue }); }
  bigHits[name] = { items, query, hits, notes: state.notes };
  if (narrow) { clearTimeout(fullTimer); fullTimer = setTimeout(fullPass, 160); }
  return hits;
}
function fullPass() {
  if (state.done) return;
  for (const cached of Object.values(bigHits)) cached.query = ''; // the next scoring reads every page
  renderSearch();
}
const NONE = [];

// All the sources in one list, scored the same way (searchScore: more and better word matches, more points).
// A page found in several places is listed once, as the most useful of them (an open tab before its
// bookmark, ...), with the best score any of them got. Ties: that order, then each source's own order.
// `text`: what was typed (the search box's, or the command palette's: both show the same results).
function dropdownRows(text = state.query) {
  const typed = text.trim();
  const query = typed.toLowerCase();
  if (!query) return [];
  const { found, foundClosed } = foundFor(query);
  const best = new Map();
  let order = 0;
  const add = (key, score, row) => {
    if (score <= 0) return;
    const x = { ...row, key, score, rank: DROPDOWN_SOURCES[row.kind].rank, order: order++ };
    const current = best.get(key);
    if (!current) return best.set(key, x);
    if (x.rank < current.rank) best.set(key, { ...x, score: Math.max(score, current.score) });
    else current.score = Math.max(score, current.score);
  };
  for (const entry of found) add(urlKey(urlOf(entry.tab)), searchScore(query, entry.tab.title, urlOf(entry.tab), noteOf(urlOf(entry.tab)), tabStatus(entry.tab)), { kind: 'tab', entry });
  // Tab groups by their name (Enter opens the group), just above their tabs that match as well.
  if (preference('showGroups')) {
    for (const group of state.groups.values()) {
      const score = searchScore(query, groupName(group));
      const tabs = score > 0 ? state.tabs.filter((x) => x.groupId === group.id) : NONE;
      if (tabs.length) add('g' + group.id, score + 1, { kind: 'group', group, tabs });
    }
  }
  for (const closedEntry of foundClosed) {
    const score = Math.max(0, ...closedEntry.fields.map(([title, url]) => searchScore(query, title, url, noteOf(url), pageStatus(url, 'closed'))));
    add(closedEntry.kind === 'window' ? 'w:' + closedEntry.id : urlKey(closedEntry.url), score, { kind: 'closed', closed: closedEntry });
  }
  // A note is found wherever its page turns up (archived, bookmarked, visited), as on an open tab.
  for (const archivedEntry of state.archived || NONE) { const score = searchScore(query, archivedEntry.title, archivedEntry.url, noteOf(archivedEntry.url), pageStatus(archivedEntry.url, 'archived')); if (score > 0) add(urlKey(archivedEntry.url), score, { kind: 'archived', archived: archivedEntry }); }
  // Bookmarks and history only while Settings -> Search includes them.
  const marks = preference('searchBookmarks'), historyEnabled = preference('searchHistory');
  if (marks) for (const { item: bookmark, score } of scoreBig('marks', state.marks || NONE, query, (bookmark) => searchScore(query, bookmark.title, bookmark.url, bookmark.path, noteOf(bookmark.url), bookmarkNoteOf(bookmark.id), pageStatus(bookmark.url, 'bookmarked')))) add(urlKey(bookmark.url), score, { kind: 'mark', bookmark });
  if (historyEnabled) for (const { item: x, score } of scoreBig('history', historyItems(typed), query, (x) => searchScore(query, x.title, x.url, noteOf(x.url), pageStatus(x.url, 'visited')))) add(urlKey(x.url), score, { kind: 'visit', visit: x });
  // In the group view the group's own tabs come first.
  const mine = (row) => (state.inGroup !== null && row.kind === 'tab' && row.entry.tab.groupId === state.inGroup ? 1 : 0);
  const rows = [...best.values()].sort((firstRow, secondRow) => mine(secondRow) - mine(firstRow) || secondRow.score - firstRow.score || firstRow.rank - secondRow.rank || firstRow.order - secondRow.order).slice(0, DROPDOWN_MAX);
  if (!rows.length) {
    const url = asUrl(typed);
    if (url) rows.push({ kind: 'url', url, key: 'url:' + url });
    rows.push({ kind: 'google', key: 'google' });
  }
  // No access to bookmarks or history: Chrome only turns on a new permission when the extension itself is
  // reloaded (an unpacked one picks up changed pages without that), so say so instead of skipping them silently.
  if (marks && !chrome.bookmarks) rows.push({ note: translate('dropdownNoMarks') });
  if (historyEnabled && !chrome.history) rows.push({ note: translate('dropdownNoHistory') });
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
  renderActions();
  markEnd('search', 'keystroke');
}
const dropdownShown = () => !state.palette && !state.dropdown.hidden && state.dropdown.items.length > 0 && !!state.query.trim() && !document.documentElement.classList.contains('alttab');

function dropdownMove(delta) {
  const itemCount = state.dropdown.items.length;
  state.dropdown.highlighted = (((state.dropdown.highlighted + delta) % itemCount) + itemCount) % itemCount;
  state.dropdown.highlightedKey = rowKey(state.dropdown.items[state.dropdown.highlighted]);
  dropdownHighlight();
}
// A result row's identity (its page, its action): the highlight moved onto a row stays on it when results that
// come in late (Chrome's history, the bookmarks) reorder the list, so Enter opens the row that was chosen.
const rowKey = (row) => (!row ? null : row.key || (row.kind === 'action' ? 'a:' + row.action.id : row.kind));
const keepHighlight = (dropdownState) => { if (!dropdownState.highlightedKey) return; const j = dropdownState.items.findIndex((row) => rowKey(row) === dropdownState.highlightedKey); if (j >= 0) dropdownState.highlighted = j; };
// Move the highlight without building the list again.
function dropdownHighlight(scroll = true) {
  const dropdownElement = document.querySelector('.dropdown');
  if (!dropdownElement) return;
  dropdownElement.querySelectorAll('.dropdown-row').forEach((x, index) => { x.classList.toggle('on', index === state.dropdown.highlighted); x.setAttribute('aria-selected', String(index === state.dropdown.highlighted)); });
  syncCombo();
  const on = dropdownElement.querySelector('.dropdown-row.on');
  if (on && scroll) on.scrollIntoView({ block: 'nearest' });
}
// A row's picture (its preview, else its favicon), made once per page and reused as the list is redrawn
// on every keystroke, so screenshots aren't decoded again and again.
const dropdownPictures = new Map();
function dropdownPicture(key, url, preview, className = 'dropdown-picture') {
  const cacheKey = className + '|' + key + '|' + (preview && preview.img ? preview.t || preview.img.length : '');
  let picture = dropdownPictures.get(cacheKey);
  if (!picture) {
    if (className === 'dropdown-icon') { picture = makeElement('img', 'dropdown-icon', null, 'dropdown-favicon'); picture.src = favicon(url); picture.alt = ''; }
    else {
      picture = makeElement('span', 'dropdown-picture', null, 'dropdown-picture');
      if (preview && preview.img) { const image = makeElement('img', '', null, 'dropdown-preview'); image.decoding = 'async'; image.src = preview.img; image.alt = ''; picture.append(image); }
      else { const image = makeElement('img', 'dropdown-favicon', null, 'dropdown-picture-favicon'); image.src = favicon(url); image.alt = ''; picture.append(image); }
    }
    if (dropdownPictures.size > 100) dropdownPictures.clear(); // each keeps its picture decoded
    dropdownPictures.set(cacheKey, picture);
  }
  return picture;
}
// A result's title row: the title, then any tags, then (at the far right) the icon of where it comes from
// (`src`: { icon, label }, DROPDOWN_SOURCES or the palette's own). `ql`: the search's words, marked in the title.
function dropdownTitleRow(title, source, queryLower, testid, ...tags) {
  const line = makeElement('span', 'dropdown-title-row', null, 'dropdown-title-row');
  line.append(typeof title === 'string' ? highlightSpan('dropdown-title', title, queryLower) : title, ...tags.filter(Boolean)); // (or a node of its own)
  const icon = makeElement('span', 'dropdown-source', null, testid);
  icon.append(svgOf(ICON[source.icon]));
  icon.title = translate(source.label);
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', translate(source.label));
  line.append(icon);
  return line;
}
// The note on a result's page, whatever the page is now (open, recently closed, archived, bookmarked, visited):
// when the search found the words in it, its text under the title (why it came up); else a "Note" tag by the title.
// `more`: other notes that count (a bookmark's own).
function noteBits(urls, queryLower, more = []) {
  const notes = [...urls.map(noteOf), ...more].filter(Boolean);
  const hit = notes.find((note) => fieldHit(queryLower, note));
  return {
    tag: notes.length && !hit ? makeElement('span', 'dropdown-tag', translate('noteTitle'), 'dropdown-note-tag') : null,
    line: hit ? highlightSpan('dropdown-subtitle dropdown-note-line', hit, queryLower) : null,
  };
}
// The tab group a tab is in, as a tag in the group's colour (not in the group view: they all are).
function groupTag(tab, className, testid) {
  const group = tab.groupId >= 0 && state.inGroup !== tab.groupId ? state.groups.get(tab.groupId) : null;
  if (!group) return null;
  const tag = makeElement('span', className + ' group-tag', groupName(group), testid);
  tag.dataset.groupColor = groupColor(group);
  return tag;
}
// One search result (a dropdownRows() row) as an option: the dropdown's and the command palette's are the same.
// `q`: the text searched for; `on`: highlighted; `id`: the option's id (aria-activedescendant points at it).
function dropdownRowElement(rowData, query, on, id) {
  const queryLower = query.toLowerCase();
  const titleRow = (title, kind, ...tags) => dropdownTitleRow(title, DROPDOWN_SOURCES[kind], queryLower, 'dropdown-source-' + kind, ...tags);
  const row = makeElement('div', 'dropdown-row' + (on ? ' on' : ''), null, 'dropdown-row-' + rowData.kind);
  row.id = id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(on));
  if (rowData.kind === 'tab') {
    const tab = rowData.entry.tab;
    const picture = dropdownPicture('t' + tab.id, urlOf(tab), rowData.entry.preview);
    const textElement = makeElement('span', 'dropdown-text', null, 'dropdown-text');
    const noteDetails = noteBits([urlOf(tab)], queryLower);
    const tabWindow = tab.windowId !== CONTEXT.sourceWindow && state.windows.find((x) => x.id === tab.windowId);
    textElement.append(titleRow(tab.title || siteOf(urlOf(tab)) || translate('untitled'), 'tab', noteDetails.tag, groupTag(tab, 'dropdown-tag', 'dropdown-group-tag'), tabWindow && makeElement('span', 'dropdown-tag', tabWindow.label, 'dropdown-window-tag')),
      highlightSpan('dropdown-subtitle', siteOf(urlOf(tab)), queryLower));
    if (noteDetails.line) textElement.append(noteDetails.line);
    row.append(picture, textElement);
  } else if (rowData.kind === 'mark') {
    const icon = dropdownPicture(rowData.bookmark.url, rowData.bookmark.url, null, 'dropdown-icon');
    const textElement = makeElement('span', 'dropdown-text', null, 'dropdown-text');
    const noteDetails = noteBits([rowData.bookmark.url], queryLower, [bookmarkNoteOf(rowData.bookmark.id)]);
    textElement.append(titleRow(rowData.bookmark.title || siteOf(rowData.bookmark.url), 'mark', noteDetails.tag), highlightSpan('dropdown-subtitle', [siteOf(rowData.bookmark.url), rowData.bookmark.path].filter(Boolean).join(' · '), queryLower));
    if (noteDetails.line) textElement.append(noteDetails.line);
    row.append(icon, textElement);
  } else if (rowData.kind === 'archived') {
    const picture = dropdownPicture('a' + rowData.archived.id, rowData.archived.url, state.archivePreviews[urlKey(rowData.archived.url)]);
    const textElement = makeElement('span', 'dropdown-text', null, 'dropdown-text');
    const ago = rowData.archived.t ? timeAgo(rowData.archived.t / 1000) : '';
    const noteDetails = noteBits([rowData.archived.url], queryLower);
    textElement.append(titleRow(rowData.archived.title || siteOf(rowData.archived.url), 'archived', noteDetails.tag), highlightSpan('dropdown-subtitle', [siteOf(rowData.archived.url), ago].filter(Boolean).join(' · '), queryLower));
    if (noteDetails.line) textElement.append(noteDetails.line);
    row.append(picture, textElement);
  } else if (rowData.kind === 'closed') {
    const picture = dropdownPicture('c' + rowData.closed.id, rowData.closed.url, rowData.closed.preview);
    const textElement = makeElement('span', 'dropdown-text', null, 'dropdown-text');
    const ago = rowData.closed.timestamp ? timeAgo(rowData.closed.timestamp / 1000) : '';
    const noteDetails = noteBits(rowData.closed.fields.map(([, url]) => url), queryLower); // (a closed window: any of its tabs' notes)
    textElement.append(titleRow(rowData.closed.title || siteOf(rowData.closed.url), 'closed', noteDetails.tag), highlightSpan('dropdown-subtitle', [rowData.closed.kind === 'window' ? '' : siteOf(rowData.closed.url), ago].filter(Boolean).join(' · '), queryLower));
    if (noteDetails.line) textElement.append(noteDetails.line);
    row.append(picture, textElement);
  } else if (rowData.kind === 'visit') {
    const icon = dropdownPicture(rowData.visit.url, rowData.visit.url, null, 'dropdown-icon');
    const textElement = makeElement('span', 'dropdown-text', null, 'dropdown-text');
    const when = rowData.visit.t ? translate('visitedAgo', { when: timeAgo(rowData.visit.t / 1000) }) : '';
    const noteDetails = noteBits([rowData.visit.url], queryLower);
    textElement.append(titleRow(rowData.visit.title || siteOf(rowData.visit.url), 'visit', noteDetails.tag), highlightSpan('dropdown-subtitle', [siteOf(rowData.visit.url), when].filter(Boolean).join(' · '), queryLower));
    if (noteDetails.line) textElement.append(noteDetails.line);
    row.append(icon, textElement);
  } else if (rowData.kind === 'group') { // its colour, its name, how many tabs, the first ones' titles
    const picture = makeElement('span', 'dropdown-picture dropdown-group', null, 'dropdown-group-picture');
    picture.dataset.groupColor = groupColor(rowData.group);
    picture.append(makeElement('span', 'group-dot', null, 'dropdown-group-dot'));
    const textElement = makeElement('span', 'dropdown-text', null, 'dropdown-text');
    textElement.append(titleRow(groupName(rowData.group), 'group', makeElement('span', 'dropdown-tag', translate('tabs', { count: rowData.tabs.length }), 'dropdown-group-count')),
      highlightSpan('dropdown-subtitle', rowData.tabs.slice(0, 4).map((x) => x.title || siteOf(urlOf(x))).join(' · '), queryLower));
    row.append(picture, textElement);
  } else if (rowData.kind === 'url') {
    const icon = makeElement('img', 'dropdown-icon', null, 'dropdown-favicon');
    icon.src = favicon(rowData.url);
    icon.alt = '';
    row.append(icon, makeElement('span', 'dropdown-text dropdown-one-line', translate('dropdownOpen', { address: query }), 'dropdown-text'));
  } else {
    const icon = makeElement('span', 'dropdown-icon dropdown-google', 'G', 'dropdown-google-icon');
    icon.setAttribute('aria-hidden', 'true');
    row.append(icon, makeElement('span', 'dropdown-text dropdown-one-line', translate('dropdownGoogle', { text: query }), 'dropdown-text'));
  }
  return row;
}
function renderDropdown() {
  let dropdownElement = document.querySelector('.dropdown');
  const rows = state.query.trim() ? dropdownRows() : [];
  state.dropdown.items = rows.filter((row) => row.kind);
  keepHighlight(state.dropdown);
  if (state.dropdown.highlighted >= state.dropdown.items.length) state.dropdown.highlighted = 0;
  if (!dropdownShown()) { if (dropdownElement) dropdownElement.remove(); return syncCombo(); }
  if (!dropdownElement) {
    dropdownElement = makeElement('div', 'dropdown', null, 'search-dropdown');
    dropdownElement.setAttribute('role', 'listbox');
    dropdownElement.id = 'dropdown';
    dropdownElement.addEventListener('mousedown', (event) => event.preventDefault()); // keep the focus (and the caret) in the search box
    elements.app.append(dropdownElement);
  }
  const query = state.query.trim();
  let rowIndex = -1;
  // Like the cards, the pointer doesn't move the highlight (only ↑ / ↓ do): a row under it shows only its hover tint,
  // and a click opens it.
  dropdownElement.replaceChildren(...rows.map((rowData) => {
    if (rowData.note) return makeElement('div', 'dropdown-note', rowData.note, 'dropdown-notice');
    const i = ++rowIndex;
    const row = dropdownRowElement(rowData, query, i === state.dropdown.highlighted, 'dropdown-' + i);
    row.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) dropdownActivate(rowData); });
    onMiddleClick(row, () => dropdownMiddleClick(rowData));
    return row;
  }));
  syncCombo();
  // Under the search box, as wide as it (at least 460 px), within the window.
  const box = elements.search.closest('.search').getBoundingClientRect();
  const width = Math.min(window.innerWidth - 24, Math.max(460, box.width));
  dropdownElement.style.width = width + 'px';
  dropdownElement.style.left = Math.max(12, Math.min(window.innerWidth - width - 12, box.left + box.width / 2 - width / 2)) + 'px';
  dropdownElement.style.top = (box.bottom + 6) + 'px';
  dropdownElement.style.maxHeight = Math.max(160, window.innerHeight - box.bottom - 24) + 'px';
  const on = dropdownElement.querySelector('.dropdown-row.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
// `text`: what was typed (the search box's, or the palette's), for "Open …" and "Search Google for …".
async function dropdownActivate(row, text = state.query.trim()) {
  if (!row || state.done) return;
  if (row.kind === 'closed') return restoreClosed(row.closed);
  if (row.kind === 'group') { if (state.palette) exitPalette(); return enterGroup(row.group.id); }
  if (row.kind === 'archived') return openArchived(row.archived);
  if (row.kind === 'tab') {
    const i = state.entries.findIndex((entry) => entry.key === row.entry.key); // its card, when the cards show it
    if (i >= 0) return choose(i);
    try { await chrome.tabs.update(row.entry.tab.id, { active: true }); await chrome.windows.update(row.entry.tab.windowId, { focused: true }); } catch {}
    return finish('switch');
  }
  if (row.kind === 'mark') return openPage(row.bookmark.url);
  if (row.kind === 'visit') return openPage(row.visit.url);
  return openFromBox(text); // 'url' and 'google'

}
// A middle-click on a result: as on its card, a tab (or a group's tabs) closes and a recently closed page leaves the
// list; a bookmark or a visited page opens behind Tabazing, which stays.
function dropdownMiddleClick(row) {
  if (state.done) return;
  if (row.kind === 'tab') return closeTab(row.entry);
  if (row.kind === 'group') return closeTab(groupEntry(row.group));
  if (row.kind === 'closed') return forgetClosed({ item: row.closed });
  const url = row.kind === 'mark' ? row.bookmark.url : row.kind === 'visit' ? row.visit.url : null;
  if (url) historyBehind({ url }).catch((error) => toast(translate('actionFailed'), error));
}
// A recently closed page from Tabazing's own log (no history to restore): a new tab in the window Tabazing was
// opened from, back in the tab group it was in (Chrome's own restore does that itself).
async function reopenPage(closedEntry, { active }) {
  const tab = await chrome.tabs.create({ url: closedEntry.url, windowId: CONTEXT.sourceWindow, active });
  if (closedEntry.group) await putInGroup([tab.id], closedEntry.group, CONTEXT.sourceWindow).catch(() => {});
  return tab;
}
// The group a tab is in, as kept for it to come back to (a snooze, the closed-tabs log): { id, title, color } or null.
const groupFor = (tab) => (tab.groupId >= 0 ? groupOf(state.groups.get(tab.groupId)) : null);

// Reopen a recently closed tab (or window), into the window Tabazing was opened from; Chrome's own
// entries come back with their history.
async function restoreClosed(closedEntry) {
  try {
    if (CONTEXT.mode === 'window') await chrome.windows.update(CONTEXT.sourceWindow, { focused: true }).catch(() => {});
    if (closedEntry.session) await chrome.sessions.restore((closedEntry.session.tab || closedEntry.session.window).sessionId);
    else await reopenPage(closedEntry, { active: true });
    finish('restore');
  } catch (error) {
    console.warn('[Tabazing] could not reopen:', error && error.message);
    finish('cancel');
  }
}
// A page by address: its tab if one is open, else a new tab in the window Tabazing was opened from.
async function openPage(url) {
  const key = normalizeUrl(url);
  const tab = state.tabs.find((x) => normalizeUrl(urlOf(x)) === key);
  try {
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      if (CONTEXT.mode === 'window' || tab.windowId !== CONTEXT.sourceWindow) await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      if (CONTEXT.mode === 'window') await chrome.windows.update(CONTEXT.sourceWindow, { focused: true }).catch(() => {});
      await chrome.tabs.create({ url, windowId: CONTEXT.sourceWindow, active: true });
    }
  } catch {}
  finish('switch');
}

// ---- merge windows: pull every tab of other windows (`ids`) into this one, after the tabs it has, in their order.
// Pinned tabs stay pinned, and tab groups move as groups (chrome.tabGroups.move: moving tabs one by one to another
// window takes them out of their group). The emptied windows close by themselves; Undo makes them again.
async function mergeWindows(windowIds) {
  if (!windowIds.length) return;
  const undo = [];
  for (const id of windowIds) {
    let tabs = [];
    try { tabs = (await chrome.tabs.query({ windowId: id })).sort((firstTab, secondTab) => firstTab.index - secondTab.index); } catch { continue; }
    if (!tabs.length) continue;
    try {
      const record = undoRecord(tabs); // (before they move: their groups' names and colours)
      // In their order: each run of tabs outside a group in one move, each group as a whole.
      const moved = new Set();
      let run = [];
      const flush = async () => { if (run.length) await chrome.tabs.move(run, { windowId: CONTEXT.sourceWindow, index: -1 }); run = []; };
      for (const x of tabs) {
        if (!(x.groupId >= 0 && chrome.tabGroups)) { run.push(x.id); continue; }
        await flush();
        if (!moved.has(x.groupId)) { moved.add(x.groupId); await chrome.tabGroups.move(x.groupId, { windowId: CONTEXT.sourceWindow, index: -1 }); }
      }
      await flush();
      for (const x of tabs) if (x.pinned) await chrome.tabs.update(x.id, { pinned: true }).catch(() => {});
      undo.push(...record);
    } catch (error) { console.warn('[Tabazing] could not merge a window:', error && error.message); }
  }
  if (state.scope !== 'all') state.scope = 'all';
  await reload();
  if (undo.length) pushUndo(undo, 'merge');
  else toast(translate('errorMerge'));
}

// ---- snooze: close tabs now and have the background reopen them later (chrome.alarms).
function snoozeChoices(now = new Date()) {
  const at = (dayOffset, hour) => { const x = new Date(now); x.setDate(x.getDate() + dayOffset); x.setHours(hour, 0, 0, 0); return x.getTime(); };
  const out = [
    { label: translate('snoozeOneHour'), at: now.getTime() + 3600e3 },
    { label: translate('snoozeThreeHours'), at: now.getTime() + 3 * 3600e3 },
  ];
  if (now.getHours() < 17) out.push({ label: translate('snoozeEvening'), at: at(0, 18) });
  out.push({ label: translate('snoozeTomorrow'), at: at(1, 9) });
  if (now.getHours() >= 17) out.push({ label: translate('snoozeTomorrowEvening'), at: at(1, 18) }); // too late for this evening
  out.push({ label: translate('snoozeWeek'), at: at(((8 - now.getDay()) % 7) || 7, 9) }); // next Monday
  return out.map((choice) => ({ ...choice, label: choice.label + ' · ' + whenLabel(choice.at) }));
}
// "Fri 09:00", or just "18:00" today.
function whenLabel(timestamp) {
  const date = new Date(timestamp), today = new Date();
  const time = date.toLocaleTimeString(uiLang(), { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === today.toDateString() ? time : date.toLocaleDateString(uiLang(), { weekday: 'short' }) + ' ' + time;
}
// `run(at)`: what snoozing does (a recently closed tab: snoozeClosed); else the tabs close until then.
// `opts`: menu()'s (`at`: at the pointer, as for a drop on Snoozed).
function snoozeMenu(tabs, anchor, run = (at) => snoozeTabs(tabs, at), options = {}) {
  menu(anchor, [
    ...snoozeChoices().map((choice) => ({ label: choice.label, error: translate('errorSnooze'), run: () => run(choice.at) })),
    null,
    { label: translate('snoozePick'), run: () => snoozePicker(tabs, anchor, run) },
  ], options);
}
// "Pick a time…": a small card with a date and time box, below `anchor`. Only a time still to come is taken.
// Like the other cards it has the focus and Tab until it closes (Esc, a press outside, Cancel), and gives the
// focus back to what had it.
const localInput = (milliseconds) => { const date = new Date(milliseconds); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); };
function snoozePicker(tabs, anchor, run = (at) => snoozeTabs(tabs, at)) {
  closePops();
  const back = document.activeElement && document.activeElement !== document.body ? document.activeElement : elements.search;
  const popover = makeElement('form', 'popover snooze-popover', null, 'snooze-picker');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'true');
  popover.setAttribute('aria-labelledby', 'snooze-pick-heading');
  const title = makeElement('label', '', translate('snoozePickTitle'), 'snooze-picker-label');
  title.id = 'snooze-pick-heading';
  title.htmlFor = 'snooze-at';
  const input = makeElement('input', '', null, 'snooze-picker-input');
  input.type = 'datetime-local';
  input.id = 'snooze-at';
  input.required = true;
  const soon = Date.now() + 3600e3;
  input.min = localInput(Date.now());
  input.value = localInput(soon - (soon % 900e3) + 900e3); // an hour or so from now, on a quarter hour
  const errorElement = makeElement('p', 'popover-fine-print popover-error', null, 'snooze-picker-error');
  errorElement.setAttribute('role', 'alert');
  errorElement.hidden = true;
  const row = makeElement('div', 'row', null, 'snooze-picker-buttons');
  const cancel = makeElement('button', 'button quiet', translate('cancel'), 'snooze-picker-cancel');
  cancel.type = 'button';
  const ok = makeElement('button', 'button primary', translate('snoozeDo'), 'snooze-picker-ok');
  ok.type = 'submit';
  row.append(makeElement('span', 'grow', null, 'snooze-picker-spacer'), cancel, ok);
  popover.append(title, input, errorElement, row);
  const outside = (event) => { if (!popover.contains(event.target)) popover.close(); };
  popover.close = (refocus = true) => {
    if (!popover.isConnected) return;
    popover.remove();
    document.removeEventListener('mousedown', outside, true);
    if (refocus) (back.isConnected && back.tabIndex >= 0 ? back : elements.search).focus({ preventScroll: true });
  };
  popover.addEventListener('click', (event) => event.stopPropagation());
  popover.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popover.close(); } });
  cancel.addEventListener('click', (event) => { event.stopPropagation(); popover.close(); });
  popover.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pointerAllowed()) return;
    const at = input.value ? new Date(input.value).getTime() : NaN;
    if (!(at > Date.now())) { errorElement.textContent = translate('snoozePast'); errorElement.hidden = false; input.focus(); return; }
    popover.close();
    Promise.resolve(run(at)).catch((x) => toast(translate('errorSnooze'), x));
  });
  elements.app.append(popover);
  dropFrom(popover, (anchor && anchor.isConnected ? anchor : elements.search).getBoundingClientRect());
  setTimeout(() => { if (popover.isConnected) document.addEventListener('mousedown', outside, true); }, 0);
  input.focus({ preventScroll: true });
}
async function snoozeTabs(tabs, at) {
  const reopenableTabs = tabs.filter((x) => isWorthReopening(urlOf(x)));
  if (!reopenableTabs.length) return toast(translate('snoozeCant'));
  const now = Date.now();
  const items = reopenableTabs.map((x, i) => ({ id: `${x.id}-${now}-${i}`, url: urlOf(x), title: x.title || '', at, windowId: x.windowId, pinned: !!x.pinned, t: now, group: groupFor(x) })); // (it wakes in its group)
  state.snoozed = await addSnoozed(items);
  const tabIds = reopenableTabs.map((x) => x.id);
  const includesOwnTab = CONTEXT.mode === 'overlay' && tabIds.includes(CONTEXT.sourceTab); // closing the tab we sit on closes us: do it last
  await chrome.tabs.remove(tabIds.filter((id) => !includesOwnTab || id !== CONTEXT.sourceTab)).catch(() => {});
  state.picked.clear();
  if (includesOwnTab) return chrome.tabs.remove(CONTEXT.sourceTab);
  tabIds.forEach((id) => forgetTab(id));
  toast(translate('snoozedCount', { count: items.length, time: whenLabel(at) }), null, { label: translate('undo'), run: () => unsnooze(items) });
}
// Undo a snooze: forget it and reopen the tabs where they were.
async function unsnooze(items) {
  state.snoozed = await removeSnoozed(items.map((x) => x.id)).catch(() => state.snoozed);
  for (const x of items) {
    let tab = null;
    try { tab = await chrome.tabs.create({ url: x.url, windowId: x.windowId, active: false, pinned: x.pinned }); }
    catch { tab = await chrome.tabs.create({ url: x.url, windowId: CONTEXT.sourceWindow, active: false }).catch(() => null); }
    if (tab && x.group && !x.pinned) await putInGroup([tab.id], x.group, tab.windowId).catch(() => {});
  }
  toast(translate('reopenedCount', { count: items.length }));
  await reload();
}

// ---- more for a recently closed tab (its menu): reopen it elsewhere, snooze or archive it, take it off the list.
// Reopen in a new window of its own. Chrome's restore can't choose the window: the page opens afresh there.
async function reopenInWindow(closedEntry) {
  await chrome.windows.create({ url: closedEntry.url, focused: true });
  finish('restore');
}
// Reopen behind Tabazing, which stays: the tab joins the open ones, and the entry leaves the list.
async function reopenBehind(closedEntry) {
  await reopenPage(closedEntry, { active: false });
  await hideClosed({ [closedKey(closedEntry)]: closedEntry.timestamp || Date.now() }).catch(() => {}); // Chrome's own entry would stay
  toast(translate('reopenedCount', { count: 1 }));
  await reload();
}
// Snooze it: it opens again at `at`, as a snoozed tab does (and shows under Snoozed meanwhile, not here).
async function snoozeClosed(closedEntry, at) {
  const now = Date.now();
  const item = { id: `c${hashOf(closedEntry.url)}-${now}`, url: closedEntry.url, title: closedEntry.title || '', at, windowId: CONTEXT.sourceWindow, pinned: false, t: now, group: closedEntry.group || null };
  state.snoozed = await addSnoozed([item]);
  await afterClosedChange();
  toast(translate('snoozedCount', { count: 1, time: whenLabel(at) }), null, { label: translate('undo'), run: async () => { state.snoozed = await removeSnoozed([item.id]).catch(() => state.snoozed); await afterClosedChange(); } });
}
// Archive it (the "Tabs Archive" bookmarks folder): it is listed there from now on, not here.
async function archiveClosed(closedEntry) {
  if (!chrome.bookmarks) return toast(translate('dropdownNoMarks'));
  const added = await addArchived([{ url: closedEntry.url, title: closedEntry.title || '' }]);
  await afterClosedChange();
  toast(translate('archivedCount', { count: added.length }), null, { label: translate('undo'), run: async () => { await removeArchived(added.map((x) => x.id)); await afterClosedChange(); } });
}
// Take it off the list (its ⋯, or Del). Undo puts it back.
async function forgetClosed(entry) {
  const closedEntry = entry.item;
  const i = state.entries.indexOf(entry);
  const next = [state.entries[i + 1], state.entries[i - 1]].find((candidate) => candidate && candidate !== entry);
  const keys = { [closedKey(closedEntry)]: closedEntry.timestamp || Date.now() };
  state.closedHidden = await hideClosed(keys);
  await afterClosedChange(next && next.key);
  toast(translate('closedRemoved'), null, { label: translate('undo'), run: async () => { state.closedHidden = await hideClosed(keys, true); await afterClosedChange(); } });
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
  toast(translate('groupUngrouped', { name: groupName(entry.group) }));
  await reload();
}

// ---- what can be done to tab groups (a tab's menu, the ticked tabs' More, a tile's menu, the palette)
// The group the tab Tabazing was opened over is in, or null.
const sourceGroup = () => { const tab = sourceTab(); return tab && tab.groupId >= 0 ? state.groups.get(tab.groupId) || null : null; };
// A group as a tile's entry has it ({ group, tabs }), for what takes one.
const groupEntry = (group) => ({ kind: 'group', key: 'g' + group.id, group, tabs: state.tabs.filter((x) => x.groupId === group.id) });
// "Add to group…": the groups of the tabs' window (those they aren't all in already), then "New group…".
function groupMenu(tabs, anchor) {
  if (!tabs.length || !chrome.tabs.group) return;
  const windowId = tabs[0].windowId;
  const there = [...state.groups.values()].filter((group) => group.windowId === windowId && !tabs.every((x) => x.groupId === group.id));
  menu(anchor, [
    ...there.map((group) => ({ icon: 'tab', label: groupName(group), error: translate('actionFailed'), run: () => addToGroup(tabs.map((x) => x.id), group) })),
    ...(there.length ? [null] : []),
    { icon: 'plus', label: translate('groupNew'), run: () => newGroup(tabs, anchor) },
  ]);
}
// A colour the window's groups don't use yet (Chrome does the same for a new group).
function nextColor(windowId) {
  const used = new Set([...state.groups.values()].filter((group) => group.windowId === windowId).map((group) => group.color));
  return GROUP_COLORS.find((color) => color !== 'grey' && !used.has(color)) || 'blue';
}
// "New group…": its name and colour first, then the tabs go into it (into the first one's window).
function newGroup(tabs, anchor) {
  const windowId = tabs[0].windowId;
  groupEditor(anchor, { title: '', color: nextColor(windowId), heading: translate('groupNewTitle') }, async ({ title, color }) => {
    const id = await chrome.tabs.group({ tabIds: tabs.map((x) => x.id), createProperties: { windowId } });
    await chrome.tabGroups.update(id, { title, color });
    state.picked.clear();
    toast(translate('groupAddedCount', { count: tabs.length, name: title || translate('groupUnnamed', { color }) }));
    await reload();
  });
}
// "Name and colour…" on a tile.
function editGroup(group, anchor) {
  groupEditor(anchor, { title: group.title || '', color: groupColor(group), heading: translate('groupEditTitle') }, async (values) => {
    await chrome.tabGroups.update(group.id, values);
    await reload();
  });
}
// A small card for a group's name and colour, below `anchor`, like the snooze time picker: a name box and Chrome's
// nine colours, then Save (Enter) or Cancel (Esc). `save({ title, color })` does the rest.
function groupEditor(anchor, { title, color, heading }, save) {
  closePops();
  const back = document.activeElement && document.activeElement !== document.body ? document.activeElement : elements.search;
  const popover = makeElement('form', 'popover group-popover', null, 'group-editor');
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'true');
  popover.setAttribute('aria-labelledby', 'group-editor-heading');
  const label = makeElement('label', '', heading, 'group-editor-title');
  label.id = 'group-editor-heading';
  label.htmlFor = 'group-editor-name';
  const input = makeElement('input', '', null, 'group-editor-name');
  input.id = 'group-editor-name';
  input.value = title;
  input.placeholder = translate('groupNamePlaceholder');
  input.maxLength = 200;
  input.autocomplete = 'off';
  let chosen = GROUP_COLORS.includes(color) ? color : 'blue';
  const colors = makeElement('div', 'group-colors', null, 'group-editor-colors');
  colors.setAttribute('role', 'radiogroup');
  colors.setAttribute('aria-label', translate('groupColorLabel'));
  const paint = () => colors.querySelectorAll('.group-swatch').forEach((swatch) => swatch.setAttribute('aria-checked', String(swatch.dataset.groupColor === chosen)));
  for (const swatchColor of GROUP_COLORS) {
    const swatch = makeElement('button', 'group-swatch', null, 'group-editor-color');
    swatch.type = 'button';
    swatch.dataset.groupColor = swatchColor;
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-label', translate('groupColorName', { color: swatchColor }));
    swatch.title = translate('groupColorName', { color: swatchColor });
    swatch.addEventListener('click', (event) => { event.stopPropagation(); chosen = swatchColor; paint(); });
    colors.append(swatch);
  }
  paint();
  const row = makeElement('div', 'row', null, 'group-editor-buttons');
  const cancel = makeElement('button', 'button quiet', translate('cancel'), 'group-editor-cancel');
  cancel.type = 'button';
  const ok = makeElement('button', 'button primary', translate('groupSave'), 'group-editor-save');
  ok.type = 'submit';
  row.append(makeElement('span', 'grow', null, 'group-editor-spacer'), cancel, ok);
  popover.append(label, input, colors, row);
  const outside = (event) => { if (!popover.contains(event.target)) popover.close(); };
  popover.close = (refocus = true) => {
    if (!popover.isConnected) return;
    popover.remove();
    document.removeEventListener('mousedown', outside, true);
    if (refocus) (back.isConnected && back.tabIndex >= 0 ? back : elements.search).focus({ preventScroll: true });
  };
  popover.addEventListener('click', (event) => event.stopPropagation());
  popover.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popover.close(); } });
  cancel.addEventListener('click', (event) => { event.stopPropagation(); popover.close(); });
  popover.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pointerAllowed()) return;
    popover.close();
    Promise.resolve(save({ title: input.value.trim(), color: chosen })).catch((x) => toast(translate('actionFailed'), x));
  });
  elements.app.append(popover);
  dropFrom(popover, (anchor && anchor.isConnected ? anchor : elements.search).getBoundingClientRect());
  setTimeout(() => { if (popover.isConnected) document.addEventListener('mousedown', outside, true); }, 0);
  input.focus({ preventScroll: true });
  input.select();
}
// "Remove from group": the tabs stay open, where they are.
async function ungroupTabs(tabs) {
  await chrome.tabs.ungroup(tabs.map((x) => x.id));
  toast(translate('groupRemovedCount', { count: tabs.length }));
  await reload();
}
// "Move group to new window": the whole group, as a group (Undo puts its tabs back, in it). With the tab Tabazing is
// drawn over among them, Tabazing goes along and closes.
async function groupToWindow(entry) {
  const undo = undoRecord(entry.tabs);
  const includesOwnTab = CONTEXT.mode === 'overlay' && entry.tabs.some((x) => x.id === CONTEXT.sourceTab);
  asking = true; // the new window may take the focus for a moment
  try {
    const newWindow = await chrome.windows.create({ focused: includesOwnTab });
    const blank = (newWindow.tabs || [])[0]; // (a window comes with a New Tab)
    await chrome.tabGroups.move(entry.group.id, { windowId: newWindow.id, index: -1 });
    if (blank) await chrome.tabs.remove(blank.id).catch(() => {});
  } finally { asking = false; }
  if (includesOwnTab) return finish('switch');
  window.focus();
  await reload();
  pushUndo(undo, 'move');
}
// Collapse or expand the group in Chrome's tab strip.
async function collapseGroup(group) {
  await chrome.tabGroups.update(group.id, { collapsed: !group.collapsed });
  await reload();
}
// Space or Shift+click on a tile: its tabs' pictures big (up to eight), each with its title. Enter opens the group,
// ← / → the cards beside it, Esc or the × closes it.
function openBigGroup(entry) {
  closePops();
  closeBig();
  hideTip();
  bigEntry = entry;
  const group = entry.group, name = groupName(group);
  const back = makeElement('div', 'big-backdrop', null, 'big-preview');
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  back.setAttribute('aria-label', translate('bigTitle', { title: name }));
  const box = makeElement('div', 'big-box big-group', null, 'big-preview-box');
  box.dataset.groupColor = groupColor(group);
  const head = makeElement('div', 'big-head', null, 'big-preview-header');
  head.append(makeElement('span', 'group-dot', null, 'big-preview-group-dot'), makeElement('span', 'title', name, 'big-preview-title'), makeElement('span', 'host', translate('tabs', { count: entry.tabs.length }), 'big-preview-host'));
  const x = makeElement('button', 'big-close', null, 'big-preview-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = translate('bigClose') + ' (Esc)';
  x.setAttribute('aria-label', translate('bigClose'));
  x.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeBig(); });
  const grid = makeElement('div', 'big-grid', null, 'big-preview-group');
  grid.style.setProperty('--columns', Math.min(4, entry.tabs.length));
  for (const tab of entry.tabs.slice(0, 8)) {
    const cell = makeElement('figure', 'big-cell', null, 'big-preview-group-tab');
    const preview = state.previews[tab.id];
    const picture = makeElement('div', 'big-picture', null, 'big-preview-group-picture');
    if (preview && preview.img) { const image = makeElement('img', '', null, 'big-preview-image'); image.src = preview.img; image.alt = ''; picture.append(image); }
    else { const image = makeElement('img', 'group-favicon', null, 'big-preview-none-favicon'); image.src = favicon(urlOf(tab)); image.alt = ''; picture.append(image); }
    cell.append(picture, makeElement('figcaption', '', tab.title || siteOf(urlOf(tab)) || translate('untitled'), 'big-preview-group-title'));
    grid.append(cell);
  }
  if (entry.tabs.length > 8) grid.append(makeElement('p', 'big-more', translate('groupMoreCount', { count: entry.tabs.length - 8 }), 'big-preview-group-more'));
  box.append(head, x, grid);
  box.addEventListener('click', (event) => event.stopPropagation());
  back.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeBig(); });
  back.append(box);
  elements.app.append(back);
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
const clearDrop = () => document.querySelectorAll(DROP_CLASSES.map((className) => '.' + className).join(', ')).forEach((node) => node.classList.remove(...DROP_CLASSES));
const showDrop = (node, className) => { if (node.classList.contains(className)) return; clearDrop(); node.classList.add(className); };
// A drop on the card's half toward the end goes after it: its right half, or its left half right to left.
const dropAfter = (card, event) => { const bounds = card.getBoundingClientRect(); return (event.clientX > bounds.left + bounds.width / 2) !== isRtl(); };
// What is dragged: ours, or a link from elsewhere (only its kind can be read until it is dropped).
const dragged = (event) => drag || (event.dataTransfer && [...(event.dataTransfer.types || [])].includes('text/uri-list') ? { link: true } : null);
// The address(es) a dropped link carries: web pages only.
const droppedLinks = (event) => String(event.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).map((address) => address.trim()).filter((address) => address && !address.startsWith('#') && /^(https?|ftp|file):/i.test(address)).slice(0, 20);
function startDrag(what, card, event, text) {
  drag = what;
  event.dataTransfer.effectAllowed = what.page ? 'copyMove' : 'move';
  event.dataTransfer.setData('text/plain', text);
  card.classList.add('dragging');
  document.querySelectorAll('.droppable').forEach((node) => node.classList.toggle('drop-ok', !!node._takes(what)));
}
function endDrag() {
  drag = null;
  clearDrop();
  document.querySelectorAll('.dragging, .drop-ok').forEach((node) => node.classList.remove('dragging', 'drop-ok'));
}
// A place that takes drops: `takes(what)` says whether it takes this (truthy), `run(what, e)` does the drop.
function dropZone(node, takes, run, className = 'drop-zone') {
  node.classList.add('droppable');
  node._takes = takes;
  // (dragenter too: Chrome takes a drop only where both were cancelled)
  const over = (event) => {
    const what = dragged(event);
    if (!what || !takes(what) || event.defaultPrevented) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = what.ids || what.group !== undefined ? 'move' : 'copy';
    showDrop(node, className);
  };
  node.addEventListener('dragenter', over);
  node.addEventListener('dragover', over);
  node.addEventListener('dragleave', (event) => { if (!node.contains(event.relatedTarget)) node.classList.remove(className); });
  node.addEventListener('drop', (event) => {
    const what = dragged(event);
    if (!what || !takes(what) || event.defaultPrevented) return;
    event.preventDefault();
    endDrag();
    if (pointerAllowed()) Promise.resolve(run(what, event)).catch((error) => toast(translate('errorMove'), error));
  });
}
// What a drop on this card does: 'into' (a group's tile), 'before' / 'after' (By order), or null (the list around
// it may take it instead).
function cardDrop(entry, card, event, what) {
  if (!what) return null;
  const tile = entry.kind === 'group', reorder = state.sort === 'order';
  const side = reorder ? (dropAfter(card, event) ? 'after' : 'before') : null;
  if (what.ids) return what.ids.some((id) => cardTabs(entry).some((x) => x.id === id)) ? null : tile ? 'into' : side;
  if (what.group !== undefined) return tile && what.group === entry.group.id ? null : side;
  return tile ? 'into' : side; // a page, a link
}
function dragToMove(card, entry) {
  const tile = entry.kind === 'group';
  card.draggable = true;
  card.addEventListener('dragstart', (event) => {
    startDrag(tile ? { group: entry.group.id } : { ids: state.picked.has(entry.tab.id) ? [...state.picked] : [entry.tab.id] }, card, event, tile ? groupName(entry.group) : urlOf(entry.tab));
  });
  card.addEventListener('dragend', endDrag);
  const over = (event) => {
    const action = cardDrop(entry, card, event, dragged(event));
    if (!action) return; // (the open tabs around it may take it)
    event.preventDefault();
    event.dataTransfer.dropEffect = drag && (drag.ids || drag.group !== undefined) ? 'move' : 'copy';
    showDrop(card, 'drop-' + action);
  };
  card.addEventListener('dragenter', over); // (both: Chrome takes a drop only where both were cancelled)
  card.addEventListener('dragover', over);
  card.addEventListener('dragleave', (event) => { if (!card.contains(event.relatedTarget)) card.classList.remove(...DROP_CLASSES); });
  card.addEventListener('drop', (event) => {
    const what = dragged(event), action = cardDrop(entry, card, event, what);
    if (!action) return;
    event.preventDefault();
    const links = what.link ? droppedLinks(event) : null;
    endDrag();
    if (!pointerAllowed()) return;
    const after = action === 'after';
    const done = what.ids ? (tile ? addToGroup(what.ids, entry.group) : moveTabs(what.ids, entry.tab, after))
      : what.group !== undefined ? moveGroup(what.group, entry, after)
      : openDropped(what.page || links, tile ? { group: entry.group } : { near: entry.tab, after });
    done.catch((error) => toast(translate('errorMove'), error));
  });
}
// A page's card (recently closed, snoozed, starred): dragged to be opened somewhere. A closed window isn't (Chrome
// alone brings one back).
function dragToOpen(card, entry) {
  if (entry.kind === 'closed' && entry.item.kind === 'window') return;
  card.draggable = true;
  card.addEventListener('dragstart', (event) => startDrag({ page: entry }, card, event, entry.item.url));
  card.addEventListener('dragend', endDrag);
}
// Open what was dropped (a page's card entry, or links), behind Tabazing, which stays: next to a tab (`near`, `after`),
// at the end of a group, or at the end of a window (`windowId`, else the one Tabazing was opened from). A recently
// closed tab then leaves that list, a snoozed one its snooze.
async function openDropped(what, { near = null, after = true, group = null, windowId = null } = {}) {
  const urls = Array.isArray(what) ? what : [what.item.url];
  if (!urls.length) return;
  let targetWindowId = windowId || CONTEXT.sourceWindow, index;
  if (group) {
    const members = (await chrome.tabs.query({ groupId: group.id })).sort((firstTab, secondTab) => firstTab.index - secondTab.index);
    const last = members[members.length - 1];
    if (last) { targetWindowId = last.windowId; index = last.index + 1; } else group = null; // (the group is gone)
  } else if (near) {
    const at = await chrome.tabs.get(near.id);
    targetWindowId = at.windowId;
    index = at.index + (after ? 1 : 0);
  }
  const made = [];
  for (const url of urls) {
    const tab = await chrome.tabs.create({ url, windowId: targetWindowId, active: false, ...(index !== undefined ? { index: index++ } : {}) });
    made.push(tab.id);
  }
  if (group && chrome.tabs.group) await chrome.tabs.group({ tabIds: made, groupId: group.id });
  if (!Array.isArray(what)) {
    if (what.kind === 'closed') await hideClosed({ [closedKey(what.item)]: what.item.timestamp || Date.now() }).catch(() => {}); // Chrome's own entry would stay
    if (what.kind === 'snoozed') state.snoozed = await removeSnoozed([what.item.id]).catch(() => state.snoozed);
  }
  const back = !Array.isArray(what) && (what.kind === 'closed' || what.kind === 'snoozed');
  toast(group ? translate('groupAddedCount', { count: made.length, name: groupName(group) }) : translate(back ? 'reopenedCount' : 'openedCount', { count: made.length }));
  if (!Array.isArray(what) && what.kind === 'closed') await loadClosed();
  await reload();
}
// Tabs (or a group) dropped on a window in the list on the left: to the end of that window. Undo moves them back. The
// tab Tabazing is drawn over, among them: it goes along, to that window, and Tabazing closes.
async function moveToWindow(what, windowId) {
  const tabs = what.group !== undefined ? state.tabs.filter((x) => x.groupId === what.group) : state.tabs.filter((x) => what.ids.includes(x.id));
  const moving = tabs.filter((x) => x.windowId !== windowId).sort((firstTab, secondTab) => firstTab.windowId - secondTab.windowId || firstTab.index - secondTab.index);
  if (!moving.length) return;
  const undo = undoRecord(moving);
  const includesOwnTab = CONTEXT.mode === 'overlay' && moving.some((x) => x.id === CONTEXT.sourceTab);
  if (what.group !== undefined) await chrome.tabGroups.move(what.group, { windowId, index: -1 });
  else {
    await chrome.tabs.move(moving.map((x) => x.id), { windowId, index: -1 });
    await regroup(undo.map((x) => ({ x, tab: { id: x.id } }))); // their groups go along (one of each, there)
  }
  state.picked.clear();
  if (includesOwnTab) { await chrome.tabs.update(CONTEXT.sourceTab, { active: true }).catch(() => {}); await chrome.windows.update(windowId, { focused: true }).catch(() => {}); return finish('switch'); }
  await reload();
  const targetWindow = state.windows.find((x) => x.id === windowId);
  pushUndo(undo, 'move', translate('movedToCount', { count: undo.length, window: targetWindow ? targetWindow.label : '' }));
}
// The lists that take drops (set up once: they stay as the cards change).
function setupDropZones() {
  const openSection = elements.openGrid.closest('section');
  dropZone(openSection, (what) => what.page || what.link, (what, event) => {
    const group = state.inGroup !== null ? state.groups.get(state.inGroup) : null;
    return openDropped(what.page || droppedLinks(event), group ? { group: { id: group.id, title: group.title } } : { windowId: typeof state.scope === 'number' ? state.scope : CONTEXT.sourceWindow });
  });
  // (the snooze choices at the pointer; "Pick a time…" below the section's title)
  dropZone(elements.snoozedSection, (what) => what.ids || (what.page && what.page.kind !== 'snoozed'), (what, event) => {
    const anchor = byId('snoozed-heading'), at = { at: { x: event.clientX, y: event.clientY } };
    if (what.ids) return snoozeMenu(state.tabs.filter((x) => what.ids.includes(x.id)), anchor, undefined, at);
    const pageItem = what.page.item;
    return snoozeMenu([], anchor, (when) => snoozeClosed(pageItem, when), at);
  });
  dropZone(elements.closedSection, (what) => what.ids || what.group !== undefined, (what) => closeMany(what.group !== undefined ? state.tabs.filter((x) => x.groupId === what.group) : state.tabs.filter((x) => what.ids.includes(x.id))));
}
// Move tabs, in their tab-strip order, to just before or after `target`. One at a time, each placed
// right after the one before it, reading fresh positions every step (each move shifts the others).
async function moveTabs(tabIds, target, after) {
  const moving = state.tabs.filter((x) => tabIds.includes(x.id) && x.id !== target.id).sort((firstTab, secondTab) => firstTab.index - secondTab.index);
  let anchor = target.id, behind = after;
  for (const x of moving) {
    const [currentTab, at] = await Promise.all([chrome.tabs.get(x.id), chrome.tabs.get(anchor)]);
    let index = at.index + (behind ? 1 : 0);
    if (currentTab.windowId === at.windowId && currentTab.index < index) index--; // it leaves its old place first
    await chrome.tabs.move(x.id, { windowId: at.windowId, index }); // (into another window, with Show all windows)
    anchor = x.id; behind = true;
  }
  state.picked.clear();
  await reload();
}
// Move a whole group to just before or after `target` (a tab's card, or another group's tile), as one block.
async function moveGroup(id, target, after) {
  const strip = (groupId) => chrome.tabs.query({ groupId }).then((list) => list.sort((firstTab, secondTab) => firstTab.index - secondTab.index));
  const mine = await strip(id);
  if (!mine.length) return;
  let windowId, index;
  if (target.kind === 'group') {
    const theirs = await strip(target.group.id);
    windowId = theirs[0].windowId;
    index = after ? theirs[theirs.length - 1].index + 1 : theirs[0].index;
  } else {
    const at = await chrome.tabs.get(target.tab.id);
    windowId = at.windowId;
    index = at.index + (after ? 1 : 0);
  }
  if (mine[0].windowId === windowId && mine[0].index < index) index -= mine.length; // it leaves its old place first
  await chrome.tabGroups.move(id, { windowId, index });
  await reload();
}
// Tabs into a group (dropped on its tile, or "Add to group"), appended: each goes after the group's last tab (into its
// window, in the tab strip's order), then joins it. A pinned tab is unpinned first (a group holds none).
async function addToGroup(tabIds, group) {
  const tabs = state.tabs.filter((x) => tabIds.includes(x.id) && x.groupId !== group.id).sort((firstTab, secondTab) => firstTab.windowId - secondTab.windowId || firstTab.index - secondTab.index);
  if (!tabs.length) return;
  for (const x of tabs) {
    if (x.pinned) await chrome.tabs.update(x.id, { pinned: false });
    const members = (await chrome.tabs.query({ groupId: group.id })).sort((firstTab, secondTab) => firstTab.index - secondTab.index);
    const last = members[members.length - 1];
    if (last) {
      const currentTab = await chrome.tabs.get(x.id);
      let index = last.index + 1;
      if (currentTab.windowId === last.windowId && currentTab.index < index) index--; // it leaves its old place first
      await chrome.tabs.move(x.id, { windowId: last.windowId, index });
    }
    await chrome.tabs.group({ tabIds: [x.id], groupId: group.id });
  }
  state.picked.clear();
  toast(translate('groupAddedCount', { count: tabs.length, name: groupName(group) }));
  await reload();
}

// Unloading a tab makes Chrome swap it out for a moment, which would jolt the switcher. So a tab put to
// sleep here is only marked (a moon on its card); it is unloaded as Tabazing closes. Clicking again unmarks.
async function sleepTabs(tabs) {
  const sleepableTabs = tabs.filter((x) => !x.active && !x.discarded); // Chrome won't unload the tab you're looking at
  if (!sleepableTabs.length) return toast(translate('sleptNone'));
  const undo = sleepableTabs.every((x) => state.toSleep.has(x.id));
  sleepableTabs.forEach((x) => (undo ? state.toSleep.delete(x.id) : state.toSleep.add(x.id)));
  const changed = new Set([...state.picked, ...sleepableTabs.map((x) => x.id)]);
  state.picked.clear();
  toast(undo ? translate('sleepUndone') : translate('sleepLaterCount', { count: sleepableTabs.length }));
  if (state.filter) refresh(); // (the Asleep filter may show or hide them now)
  else redraw((entry) => entry.kind === 'tab' && changed.has(entry.tab.id));
}

async function pinTabs(tabs) {
  const pin = !tabs.every((x) => x.pinned);
  for (const x of tabs) await chrome.tabs.update(x.id, { pinned: pin }).catch(() => {});
  toast(translate(pin ? 'pinnedCount' : 'unpinnedCount', { count: tabs.length }));
  await reload();
}

async function muteTabs(tabs) {
  const mute = !tabs.every((x) => x.mutedInfo && x.mutedInfo.muted);
  for (const x of tabs) await chrome.tabs.update(x.id, { muted: mute }).catch(() => {});
  toast(translate(mute ? 'mutedCount' : 'unmutedCount', { count: tabs.length }));
  await reload();
}

// Pages open more than once (same address, ignoring the #part and a trailing slash).
function duplicateUrls() {
  const counts = new Map();
  for (const x of state.tabs) { const key = normalizeUrl(urlOf(x)); if (key && /^https?:|^file:/.test(urlOf(x))) counts.set(key, (counts.get(key) || 0) + 1); }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}
// The same page open more than once: keep one (pinned first, then the most recently used), close the rest.
// Worked out once per list of tabs (a redraw asks for every card in the duplicates view); derive() starts afresh.
let duplicateMemo = null; // { tabs, list, ids }
function duplicates() {
  if (duplicateMemo && duplicateMemo.tabs === state.tabs) return duplicateMemo.list;
  const seen = new Map();
  const duplicateTabs = [];
  // The one kept: pinned first, then one in a tab group, then the most recently used (state.tabs is most recent first).
  const order = [...state.tabs].sort((firstTab, secondTab) => (secondTab.pinned ? 1 : 0) - (firstTab.pinned ? 1 : 0) || (secondTab.groupId >= 0 ? 1 : 0) - (firstTab.groupId >= 0 ? 1 : 0));
  for (const x of order) {
    const key = normalizeUrl(urlOf(x));
    if (!key || !/^https?:|^file:/.test(urlOf(x))) continue;
    if (seen.has(key)) duplicateTabs.push(x); else seen.set(key, x);
  }
  duplicateMemo = { tabs: state.tabs, list: duplicateTabs, ids: new Set(duplicateTabs.map((x) => x.id)) };
  return duplicateTabs;
}
const duplicateIds = () => (duplicates(), duplicateMemo.ids); // the ids of the copies that close
async function closeDuplicates() {
  if (!state.duplicatesView) return duplicatesView(true); // first show which tabs are copies
  const duplicateTabs = duplicates();
  if (!duplicateTabs.length) return;
  state.duplicatesView = false;
  await closeMany(duplicateTabs);
}

// ---- sound: a speaker in the header of a tab that is playing (a crossed-out one when muted), and a
// mute button among every card's quick buttons. Both mute or unmute just that tab.
const isMuted = (tab) => !!(tab.mutedInfo && tab.mutedInfo.muted);
function audioBadge(tab) {
  const muted = isMuted(tab);
  const button = makeElement('button', 'badge audio' + (muted ? '' : ' on'), null, 'card-audio');
  button.type = 'button';
  button.append(svgOf(muted ? ICON.muted : ICON.speaker));
  button.title = translate(muted ? 'tabUnmute' : 'tabMute');
  button.setAttribute('aria-label', button.title);
  button.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) toggleMute(tab).catch((error) => toast(translate('errorMute'), error)); });
  return button;
}
// Pin / unpin one tab. Chrome moves it to (or out of) the pinned tabs at the start of the tab strip,
// so the list is read again.
async function togglePin(tab) {
  const pinned = !tab.pinned;
  try {
    await chrome.tabs.update(tab.id, { pinned });
  } catch (error) {
    // "Tabs cannot be edited right now": Chrome is busy with the tab strip for a moment. Once more.
    await new Promise((resolve) => setTimeout(resolve, 150));
    try { await chrome.tabs.update(tab.id, { pinned }); }
    catch (retryError) { await reload(); return toast(translate('errorPin'), retryError); }
  }
  await reload(); // what Chrome now has, whatever happened
  const now = state.tabs.find((x) => x.id === tab.id);
  toast(translate(now && now.pinned ? 'pinnedOne' : 'unpinnedOne', { title: tab.title || siteOf(urlOf(tab)) }));
}
async function toggleMute(tab) {
  const muted = !isMuted(tab);
  await chrome.tabs.update(tab.id, { muted });
  tab.mutedInfo = { ...(tab.mutedInfo || {}), muted }; // show it right away
  if (state.filter) refresh({ keepKey: 't' + tab.id }); // (the Audio filter may hide it now)
  else redraw((entry) => entry.kind === 'tab' && entry.tab.id === tab.id, { keepKey: 't' + tab.id });
}

// Reload a tab (a sleeping one wakes up). The page Tabazing is drawn over (overlay) reloads with it gone.
async function reloadTab(tab) {
  await chrome.tabs.reload(tab.id);
  if (CONTEXT.mode === 'overlay' && tab.id === CONTEXT.sourceTab) return finish('cancel');
  toast(translate('reloadingOne', { title: tab.title || siteOf(urlOf(tab)) }));
}
// Duplicate a tab: the copy opens right after it, in the background, so Tabazing stays open and shows it.
async function duplicateTab(tab) {
  await chrome.tabs.create({ url: urlOf(tab), windowId: tab.windowId, index: tab.index + 1, active: false, pinned: !!tab.pinned, openerTabId: tab.id });
  await reload();
  toast(translate('duplicatedOne', { title: tab.title || siteOf(urlOf(tab)) }));
}

// ---- the media player, right of the search box: what plays in the tabs (its picture, title and buttons), and
// the chevron's list of everything playable in every tab. The pages say what they play (media-hook.js), the
// background keeps it (KEY.MEDIA), and every change of it is read again here (listen(): refreshMedia). The
// buttons act in the page itself (utils/media.js) and show the change at once; the page's report confirms it.
const currentMedia = () => state.media.find((mediaItem) => mediaItem.tabId === state.mediaCurrent) || state.media[0] || null;
const mediaPreview = (mediaItem) => state.previews[mediaItem.tabId] || state.mediaPreviews[normalizeUrl(urlOf(mediaItem.tab))] || null;
// The picture (the tab's screenshot, else its icon), made once per tab and capture and reused by every redraw.
const mediaPictures = new Map();
function mediaPicture(mediaItem, testid) {
  const preview = mediaPreview(mediaItem);
  const cacheKey = testid + '|' + mediaItem.tabId + '|' + (preview && preview.img ? (preview.t || 0) + ':' + preview.img.length : urlOf(mediaItem.tab));
  let picture = mediaPictures.get(cacheKey);
  if (!picture) {
    if (preview && preview.img) { picture = makeElement('img', 'media-shot', null, testid + '-preview'); picture.decoding = 'async'; picture.src = preview.img; }
    else { picture = makeElement('img', 'media-favicon', null, testid + '-favicon'); picture.src = favicon(urlOf(mediaItem.tab)); }
    picture.alt = '';
    if (mediaPictures.size > 100) mediaPictures.clear();
    mediaPictures.set(cacheKey, picture);
  }
  return picture;
}
// Previews of media tabs the cards don't show (other windows): read once each.
async function loadMediaPreviews() {
  const want = state.media.filter((mediaItem) => !state.previews[mediaItem.tabId] && !state.previewPending.has(mediaItem.tabId) && !(normalizeUrl(urlOf(mediaItem.tab)) in state.mediaPreviews));
  if (!want.length) return;
  const previews = await readPreviews(want.map((mediaItem) => urlOf(mediaItem.tab))).catch(() => ({}));
  for (const mediaItem of want) { const key = normalizeUrl(urlOf(mediaItem.tab)); state.mediaPreviews[key] = previews[key] || null; }
}
function paintToggle(button, playing) {
  button.replaceChildren(svgOf(playing ? ICON.pause : ICON.play));
  button.title = translate(playing ? 'mediaPause' : 'mediaPlay'); // the label says what a press does
  button.setAttribute('aria-label', button.title);
}
// Drawn with every render(), so only a change touches the page.
let playerSignature = '';
function renderPlayer() {
  const mediaItem = currentMedia();
  if (!mediaItem) {
    if (elements.player.contains(document.activeElement)) elements.search.focus({ preventScroll: true });
    elements.player.hidden = true;
    playerSignature = '';
    return;
  }
  elements.player.hidden = false;
  const preview = mediaPreview(mediaItem);
  const signature = [mediaItem.tabId, mediaItem.frameId, mediaItem.title, mediaItem.artist, mediaItem.site, mediaItem.playing, mediaItem.canPrevious, mediaItem.canNext, preview ? preview.t : 0, uiLang()].join('\n');
  if (signature === playerSignature) return;
  playerSignature = signature;
  if (!elements.playerPrevious.firstChild) { elements.playerPrevious.append(svgOf(ICON.previous)); elements.playerNext.append(svgOf(ICON.next)); elements.playerMore.append(svgOf(ICON.chevron)); }
  elements.playerPicture.replaceChildren(mediaPicture(mediaItem, 'player'));
  elements.playerTitle.textContent = mediaItem.title || mediaItem.site || translate('untitled');
  elements.playerSubtitle.textContent = mediaItem.artist || mediaItem.site;
  elements.playerTitle.parentElement.title = mediaItem.title;
  elements.playerPrevious.disabled = !mediaItem.canPrevious;
  elements.playerNext.disabled = !mediaItem.canNext;
  paintToggle(elements.playerToggle, mediaItem.playing);
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
async function mediaCommand(mediaItem, action) {
  if (action === 'toggle') action = mediaItem.playing ? 'pause' : 'play';
  const wasPlaying = mediaItem.playing;
  if (action === 'play' || action === 'pause') { mediaItem.playing = action === 'play'; renderMedia(); }
  let ok = false, error = null;
  try { ok = await mediaAction(mediaItem.tabId, mediaItem.frameId, action); } catch (caughtError) { error = caughtError; }
  if (ok || state.done) return;
  mediaItem.playing = wasPlaying;
  renderMedia();
  toast(translate('mediaFailed'), error);
}
// The player's own buttons act on what it shows, and keep showing it (the list puts what plays first,
// which would otherwise swap it for another tab's media the moment it is paused).
function playerCommand(action) {
  const mediaItem = currentMedia();
  if (!mediaItem) return;
  state.mediaCurrent = mediaItem.tabId;
  mediaCommand(mediaItem, action);
}
function pickMedia(mediaItem) {
  state.mediaCurrent = mediaItem.tabId;
  renderMedia();
}
async function goToMedia(mediaItem) {
  if (state.done) return;
  try { await switchToTab(mediaItem.tab); } catch (error) { console.warn('[Tabazing] could not open the tab:', error && error.message); finish('cancel'); }
}

// The chevron's list: like Settings, a card that takes the focus, keeps Tab inside, and closes with Esc,
// a press outside or the chevron again, giving the focus back to the chevron.
let mediaOrder = []; // tab ids in the order the open list shows them: rows don't jump while you use them
function openMediaList() {
  const open = document.querySelector('.popover.media-popover');
  closePops();
  if (open || !state.media.length) return;
  const anchor = elements.playerMore;
  const popover = makeElement('div', 'popover media-popover', null, 'media-list');
  popover.id = 'media-list';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'true'); // Tab stays in it (keepFocusIn) until it closes
  popover.setAttribute('aria-label', translate('mediaList'));
  const rows = makeElement('div', 'media-list', null, 'media-rows');
  popover.append(makeElement('h4', '', translate('mediaList'), 'media-list-title'), rows);
  popover.addEventListener('click', (event) => event.stopPropagation());
  popover.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popover.close(); } });
  const outside = (event) => { if (!popover.contains(event.target) && !anchor.contains(event.target)) popover.close(); };
  popover.close = () => {
    if (!popover.isConnected) return;
    popover.remove();
    mediaOrder = [];
    document.removeEventListener('mousedown', outside, true);
    anchor.setAttribute('aria-expanded', 'false');
    anchor.removeAttribute('aria-controls');
    (elements.player.hidden ? elements.search : anchor).focus({ preventScroll: true });
  };
  elements.app.append(popover);
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', popover.id);
  renderMediaList();
  dropFrom(popover, anchor.getBoundingClientRect()); // drops down from the player
  setTimeout(() => { if (popover.isConnected) document.addEventListener('mousedown', outside, true); }, 0);
  const focusTarget = popover.querySelector('.media-row.on [data-testid="media-row-toggle"]') || tabbables(popover)[0];
  if (focusTarget) focusTarget.focus({ preventScroll: true });
}
function renderMediaList() {
  const popover = document.querySelector('.popover.media-popover');
  if (!popover) return;
  if (!state.media.length) return popover.close();
  const rank = new Map(mediaOrder.map((id, i) => [id, i]));
  const at = (mediaItem) => (rank.has(mediaItem.tabId) ? rank.get(mediaItem.tabId) : rank.size); // new ones go last, in their own order
  const list = [...state.media].sort((firstMedia, secondMedia) => at(firstMedia) - at(secondMedia));
  mediaOrder = list.map((mediaItem) => mediaItem.tabId);
  // The rows are built again: the focus goes back to the same button of the same row.
  const activeElement = document.activeElement;
  const row0 = activeElement && popover.contains(activeElement) ? activeElement.closest('.media-row') : null;
  const back = row0 ? { tab: row0.dataset.tab, id: activeElement.dataset.testid } : null;
  const rows = popover.querySelector('.media-list');
  const current = currentMedia();
  rows.replaceChildren(...list.map((mediaItem) => mediaRow(mediaItem, mediaItem === current)));
  if (!back) return;
  const row = [...rows.children].find((x) => x.dataset.tab === back.tab);
  const control = row && row.querySelector(`[data-testid="${back.id}"]`);
  (control && !control.disabled ? control : row ? row.querySelector('[data-testid="media-row-toggle"]') : tabbables(popover)[0] || popover).focus({ preventScroll: true });
}
// One row: picture, title, site and whether it plays, then its own previous / play-pause / next, and "Go to tab".
// Only those buttons take the focus: the row itself isn't a control and has no look of its own when it is the
// one the player shows (aria-current says so); a press on it shows it there.
function mediaRow(mediaItem, current) {
  const row = makeElement('div', 'media-row' + (current ? ' on' : ''), null, 'media-row');
  row.dataset.tab = String(mediaItem.tabId);
  if (current) row.setAttribute('aria-current', 'true');
  const pick = makeElement('span', 'media-pick', null, 'media-row-pick');
  const picture = makeElement('span', 'media-picture', null, 'media-row-picture');
  picture.append(mediaPicture(mediaItem, 'media-row'));
  const text = makeElement('span', 'media-text', null, 'media-row-text');
  text.append(makeElement('span', 'media-title', mediaItem.title || mediaItem.site || translate('untitled'), 'media-row-title'), makeElement('span', 'media-site', mediaItem.site, 'media-row-site'));
  const equalizer = makeElement('span', 'media-equalizer' + (mediaItem.playing ? ' on' : ''), null, 'media-row-eq');
  equalizer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) equalizer.append(makeElement('i', '', null, 'media-row-eq-bar'));
  pick.append(picture, text, equalizer, makeElement('span', 'screen-reader-only', translate(mediaItem.playing ? 'mediaPlaying' : 'mediaPaused'), 'media-row-state'));
  pick.title = mediaItem.title;
  const go = makeElement('button', 'player-button', null, 'media-row-goto');
  go.type = 'button';
  go.title = translate('mediaGoTo');
  go.setAttribute('aria-label', go.title);
  go.append(svgOf(ICON.goto));
  go.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) goToMedia(mediaItem); });
  row.append(pick, mediaButton('media-row-previous', mediaItem, 'previoustrack'), mediaButton('media-row-toggle', mediaItem, 'toggle'), mediaButton('media-row-next', mediaItem, 'nexttrack'), go);
  // A press on the row (anywhere but its buttons): show it in the player. A second one soon after
  // (a double click) plays or pauses it. Counted by tab, not by element: the first press redraws the list,
  // so the second lands on a new row.
  row.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!pointerAllowed()) return;
    const now = performance.now();
    const again = lastRowPress.tabId === mediaItem.tabId && now - lastRowPress.at < DOUBLE_PRESS_MILLISECONDS;
    lastRowPress = again ? { tabId: null, at: 0 } : { tabId: mediaItem.tabId, at: now };
    if (again) mediaCommand(mediaItem, 'toggle'); else pickMedia(mediaItem);
  });
  return row;
}
const DOUBLE_PRESS_MILLISECONDS = 400;
let lastRowPress = { tabId: null, at: 0 };
function mediaButton(testid, mediaItem, action) {
  const button = makeElement('button', 'player-button' + (action === 'toggle' ? ' main' : ''), null, testid);
  button.type = 'button';
  if (action === 'toggle') paintToggle(button, mediaItem.playing);
  else {
    const isPrevious = action === 'previoustrack';
    button.title = translate(isPrevious ? 'mediaPrevious' : 'mediaNext');
    button.setAttribute('aria-label', button.title);
    button.append(svgOf(isPrevious ? ICON.previous : ICON.next));
    button.disabled = !(isPrevious ? mediaItem.canPrevious : mediaItem.canNext); // the page offers no previous / next
  }
  button.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) mediaCommand(mediaItem, action); });
  return button;
}

// ---- the archive: tabs moved into the "Tabs Archive" bookmarks folder (in "Other bookmarks", utils/archive.js).
// Archiving bookmarks a tab there and closes it; opening it from the archive (its overlay, or the search's
// "Archived" section) takes it out of the folder and opens it in a new tab.
async function loadArchived() {
  state.archived = await getArchived().catch(() => []);
  state.archivePreviews = await readPreviews(state.archived.map((x) => x.url)).catch(() => ({}));
}
async function archiveTabs(tabs) {
  const reopenableTabs = tabs.filter((x) => isWorthReopening(urlOf(x)));
  if (!reopenableTabs.length) return toast(translate('archiveCant'));
  if (!chrome.bookmarks) return toast(translate('dropdownNoMarks'));
  const undo = undoRecord(reopenableTabs);
  const added = await addArchived(reopenableTabs.map((x) => ({ url: urlOf(x), title: x.title || '' })));
  await loadArchived(); // before the tabs close, so "Recently closed" leaves them out
  const tabIds = reopenableTabs.map((x) => x.id);
  const includesOwnTab = CONTEXT.mode === 'overlay' && tabIds.includes(CONTEXT.sourceTab); // closing the tab we sit on closes us: do it last
  await chrome.tabs.remove(tabIds.filter((id) => !includesOwnTab || id !== CONTEXT.sourceTab)).catch(() => {});
  state.picked.clear();
  if (includesOwnTab) return chrome.tabs.remove(CONTEXT.sourceTab);
  tabIds.forEach((id) => forgetTab(id));
  toast(translate('archivedCount', { count: added.length }), null, { label: translate('undo'), run: () => unarchive(added, undo) });
}
// Undo an archive: out of the folder, and the tabs back where they were.
async function unarchive(added, group) {
  await removeArchived(added.map((x) => x.id));
  await reopenAt(group);
  toast(translate('reopenedCount', { count: group.length }));
  await reload();
}
// Open an archived page: out of the archive, into a new tab in the window Tabazing was opened from.
async function openArchived(item) {
  if (state.done) return;
  try {
    await removeArchived([item.id]);
    if (CONTEXT.mode === 'window') await chrome.windows.update(CONTEXT.sourceWindow, { focused: true }).catch(() => {});
    await chrome.tabs.create({ url: item.url, windowId: CONTEXT.sourceWindow, active: true });
    finish('switch');
  } catch (error) {
    console.warn('[Tabazing] could not open an archived tab:', error && error.message);
    finish('cancel');
  }
}

// The archive overlay (the Archive button, top right): every archived tab, over the switcher. The red ×
// or Esc closes it; clicking a card opens that tab, its × (or Del) takes it out of the archive without
// opening it. Arrows move, Enter opens. `sel` is the card to select (redrawn after a removal).
const ARCHIVE_SELECTOR = '.archive-dialog.archive-view'; // the archive dialog (the history's and the bookmarks' share its look, .archive-dialog)
const archiveOpen = () => !!document.querySelector(ARCHIVE_SELECTOR);
async function openArchive(selectedIndex = 0) {
  closeDrawer(false);
  closePops();
  closeBig();
  hideTip();
  state.dropdown.hidden = true;
  renderDropdown();
  await loadArchived();
  if (state.done) return;
  let back = document.querySelector(ARCHIVE_SELECTOR);
  if (!back) {
    back = viewDialog('archive-view', 'archive-overlay', 'archive-heading', closeArchive).back;
    elements.app.append(back);
  }
  const panel = back.firstChild;
  const head = makeElement('div', 'archive-head', null, 'archive-header');
  const title = makeElement('h2', 'archive-title', translate('archiveTitle'), 'archive-title');
  title.id = 'archive-heading';
  title.append(makeElement('span', 'count-badge', String(state.archived.length), 'archive-count'));
  const x = makeElement('button', 'archive-close', null, 'archive-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = translate('archiveClose') + ' (Esc)';
  x.setAttribute('aria-label', translate('archiveClose'));
  x.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeArchive(); });
  head.append(title, makeElement('span', 'archive-subtitle', translate('archiveWhere'), 'archive-location'), x);
  const body = makeElement('div', 'archive-body', null, 'archive-body');
  if (!chrome.bookmarks) body.append(makeElement('p', 'empty', translate('dropdownNoMarks'), 'archive-no-bookmarks'));
  else if (!state.archived.length) body.append(makeElement('p', 'empty', translate('archiveEmpty'), 'archive-empty'));
  else {
    const grid = makeElement('div', 'history-list', null, 'archive-grid');
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-labelledby', 'archive-heading');
    grid.append(...state.archived.map((item, i) => archiveCard(item, i)));
    body.append(grid);
  }
  panel.replaceChildren(head, body);
  updateInert();
  archiveSelect(selectedIndex);
  x.focus({ preventScroll: true });
}
// An archived page as a row: its preview (or its icon), its title, its site and when it was archived, and its button
// that takes it out of the archive. A click (Enter) opens it, and takes it out; a middle-click (Ctrl+Enter) the same,
// behind Tabazing, which stays.
function archiveCard(item, i) {
  const entry = { kind: 'archived', item, url: item.url, preview: state.archivePreviews[normalizeUrl(item.url)] || null };
  const title = item.title || hostOf(item.url) || translate('untitled');
  const row = makeElement('div', 'bookmarks-view-row mark', null, 'card-archived');
  row.id = 'archive-' + item.id;
  row.setAttribute('role', 'option');
  row.title = translate('archiveOpenTip', { title }) + '\n' + item.url;
  const picture = makeElement('div', 'bookmarks-view-picture' + (entry.preview ? '' : ' bare'), null, entry.preview ? 'card-thumb' : 'card-no-preview');
  const image = makeElement('img', entry.preview ? 'shot' : 'favicon', null, entry.preview ? 'card-preview' : 'card-tile-favicon');
  image.src = entry.preview ? entry.preview.img : favicon(item.url);
  image.alt = '';
  picture.append(image);
  const text = makeElement('div', 'bookmarks-view-text', null, 'card-text');
  const subtitle = makeElement('span', 'bookmarks-view-subtitle', siteOf(item.url) || item.url, 'card-archived-site');
  const ago = timeAgo(item.t / 1000);
  if (ago) subtitle.append(' · ', makeElement('span', '', ago, 'card-archived-ago'));
  text.append(makeElement('span', 'bookmarks-view-title', title, 'card-title'), subtitle);
  const actions = makeElement('div', 'bookmarks-view-actions', null, 'card-quick-actions');
  const x = deleteButton(translate('archiveRemove'), 'card-unarchive', () => dropArchived(item, i).catch((error) => toast(translate('errorUnarchive'), error)));
  x.classList.add('quick-button');
  actions.append(x);
  row.append(...(state.cardSize === 'list' ? [] : [picture]), text, actions); // (Settings -> Card size: List, no pictures)
  mouseOnly(row); // its button is Del
  row.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) openArchived(item); });
  onMiddleClick(row, () => archivedBehind(item, i).catch((error) => toast(translate('actionFailed'), error)));
  return row;
}
// Open an archived page in a new tab behind Tabazing, which stays (a middle-click, Ctrl+Enter): it leaves the archive,
// as when it is opened. Undo puts it back there and closes that tab.
async function archivedBehind(item, i) {
  const tab = await chrome.tabs.create({ url: item.url, windowId: CONTEXT.sourceWindow, active: false });
  await removeArchived([item.id]);
  if (archiveOpen()) await openArchive(i);
  toast(translate('openedCount', { count: 1 }), null, { label: translate('undo'), run: async () => {
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
  toast(translate('archiveRemoved'), null, { label: translate('undo'), run: async () => { await addArchived([item]); if (archiveOpen()) await openArchive(i); } });
}
function archiveSelect(i, scroll = true) {
  const cards = [...document.querySelectorAll(ARCHIVE_SELECTOR + ' [role=option]')];
  if (!cards.length) return;
  state.archiveSelected = Math.max(0, Math.min(cards.length - 1, i));
  cards.forEach((card, index) => card.setAttribute('aria-selected', String(index === state.archiveSelected)));
  cards[state.archiveSelected].closest('[role=listbox]').setAttribute('aria-activedescendant', cards[state.archiveSelected].id);
  if (scroll) cards[state.archiveSelected].scrollIntoView({ block: 'nearest' });
}
function closeArchive() {
  document.querySelectorAll(ARCHIVE_SELECTOR).forEach((node) => node.remove());
  updateInert();
  viewBack(elements.archiveButton).focus({ preventScroll: true }); // back to what opened it
}
// While the archive is open it has the keyboard.
function archiveKey(event) {
  const key = event.key;
  if (MODIFIERS.has(key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (key === 'Escape') return closeArchive();
  // Ctrl+Z (⌘Z): the Undo of the note at the bottom ("Removed from the archive · Undo").
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === 'KeyZ') { if (!event.repeat) toastUndo(); return; }
  const cards = [...document.querySelectorAll(ARCHIVE_SELECTOR + ' [role=option]')];
  if (!cards.length) return;
  if (key === 'Delete' || (IS_MAC && event.metaKey && key === 'Backspace')) {
    if (event.repeat) return;
    if (!keysAllowed()) return finish('cancel');
    return dropArchived(state.archived[state.archiveSelected], state.archiveSelected).catch((error) => toast(translate('errorUnarchive'), error));
  }
  if (key === 'Enter') {
    if (!keysAllowed()) return finish('cancel');
    if (event.ctrlKey || event.metaKey) { if (!event.repeat) archivedBehind(state.archived[state.archiveSelected], state.archiveSelected).catch((error) => toast(translate('actionFailed'), error)); return; } // behind, Tabazing stays
    return openArchived(state.archived[state.archiveSelected]);
  }
  if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(key)) return archiveSelect(state.archiveSelected + (key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : ahead(key))); // a list: one row at a time
  if (key === 'Home' || key === 'End') return archiveSelect(key === 'Home' ? 0 : cards.length - 1);
}

// ---- the menu (☰, top left): a drawer from the left, over the dimmed switcher, with History, Bookmarks, Archive and
// Settings. A press on one closes it and opens that dialog; Esc, × or a press beside it close it (back to ☰). ↑ ↓ move
// between its buttons. A dialog opened from it gives the focus back to ☰ when it closes.
const drawerOpen = () => !elements.drawerBack.hidden;
function openDrawer() {
  if (drawerOpen()) return closeDrawer();
  closePops();
  hideTip();
  state.dropdown.hidden = true;
  renderDropdown();
  elements.drawerBack.hidden = false;
  elements.menuButton.setAttribute('aria-expanded', 'true');
  updateInert();
  byId('history-button').focus({ preventScroll: true });
}
function closeDrawer(refocus = true) {
  if (!drawerOpen()) return;
  elements.drawerBack.hidden = true;
  elements.menuButton.setAttribute('aria-expanded', 'false');
  updateInert();
  if (refocus) elements.menuButton.focus({ preventScroll: true });
}
// Where the focus goes back to when a dialog closes: the button that opened it while it can have the focus (shown),
// else ☰ (the button was in the menu, closed since).
const viewBack = (button) => (button && button.isConnected && button.getClientRects().length && !button.closest('[hidden]') ? button : elements.menuButton);
function drawerKey(event) {
  const key = event.key;
  if (MODIFIERS.has(key)) return;
  const items = [...elements.drawerBack.querySelectorAll('button.drawer-item')];
  const i = items.indexOf(document.activeElement);
  if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); return closeDrawer(); }
  if (key === 'ArrowDown' || key === 'ArrowUp') { event.preventDefault(); return items[(i + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
  if (key === 'Home' || key === 'End') { event.preventDefault(); return items[key === 'Home' ? 0 : items.length - 1].focus(); }
  if (key === 'Enter' || key === ' ' || key === 'Tab') return; // its buttons' own
  event.preventDefault(); // (nothing else reaches the switcher behind it)
}
// The History, Bookmarks and Archive dialogs, as Settings: a dimmed backdrop (a press on it closes the dialog) and a
// panel with a title bar. Returns { back, panel }.
function viewDialog(className, testid, labelledby, close) {
  const back = makeElement('div', 'archive-dialog ' + className, null, testid);
  back.addEventListener('click', (event) => { event.stopPropagation(); if (event.target === back && pointerAllowed()) close(); }); // (never closes the switcher)
  const panel = makeElement('div', 'archive-panel', null, testid.replace('-overlay', '-panel'));
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', labelledby);
  back.append(panel);
  return { back, panel };
}

// ---- Backup & Restore (in the menu): everything Tabazing keeps, downloaded as one zip (utils/backup.js), and back
// from the backup folder (or the zip). A restore only adds: what is here stays, nothing is made twice; the backup's
// notes go on the same pages and bookmarks. A dialog like Settings; after a restore it says what it did, per kind.
const backupOpen = () => !!document.querySelector('.backup-view');
// What a restore did, per kind, in that order (`label`: the kind's name).
const BACKUP_KINDS = [
  { key: 'bookmarks', label: 'backupKindBookmarks' }, { key: 'folders', label: 'backupKindFolders' }, { key: 'archive', label: 'backupKindArchive' },
  { key: 'notes', label: 'backupKindNotes' }, { key: 'bookmarkNotes', label: 'backupKindBookmarkNotes' }, { key: 'stars', label: 'backupKindStars' }, { key: 'snoozed', label: 'backupKindSnoozed' },
];
function openBackup() {
  closePops();
  closeDrawer(false);
  hideTip();
  document.querySelectorAll('.backup-view').forEach((node) => node.remove());
  const { back, panel } = viewDialog('backup-view', 'backup-overlay', 'backup-heading', closeBackup);
  const head = makeElement('div', 'archive-head', null, 'backup-header');
  const title = makeElement('h2', 'archive-title', translate('backupTitle'), 'backup-title');
  title.id = 'backup-heading';
  const x = makeElement('button', 'archive-close', null, 'backup-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = translate('backupClose') + ' (Esc)';
  x.setAttribute('aria-label', translate('backupClose'));
  x.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeBackup(); });
  head.append(title, makeElement('span', 'archive-subtitle', translate('backupSubtitle'), 'backup-subtitle'), x);
  const body = makeElement('div', 'archive-body backup-body', null, 'backup-body');
  // back up
  const name = backupName();
  const out = makeElement('section', 'backup-section', null, 'backup-export');
  const exportButton = button('backup-export-button', translate('backupExport'), 'primary', () => exportBackup(exportButton).catch((error) => toast(translate('backupExportError'), error)));
  out.append(makeElement('h3', '', translate('backupExportHeading'), 'backup-export-title'), paragraph(translate('backupExportText', { name: name + '.zip' })), exportButton);
  // restore
  const importSection = makeElement('section', 'backup-section', null, 'backup-import');
  const folder = makeElement('input', 'fancy-select-native', null, 'backup-folder-input');
  folder.type = 'file';
  folder.webkitdirectory = true;
  folder.multiple = true;
  folder.tabIndex = -1;
  const zip = makeElement('input', 'fancy-select-native', null, 'backup-zip-input');
  zip.type = 'file';
  zip.accept = '.zip,application/zip';
  zip.tabIndex = -1;
  // The system's file dialog takes the focus: that is not the user leaving Tabazing (asking), until it closes.
  const choose = (input) => { asking = true; input.value = ''; input.click(); };
  for (const input of [folder, zip]) {
    input.addEventListener('cancel', () => { asking = false; window.focus(); });
    input.addEventListener('change', () => { asking = false; window.focus(); importBackup(input).catch(() => {}); });
  }
  const setLabel = makeElement('label', 'check', null, 'backup-settings-label');
  const setBox = makeElement('input', '', null, 'backup-settings');
  setBox.type = 'checkbox';
  setLabel.append(setBox, makeElement('span', '', translate('backupSettings'), 'backup-settings-text'));
  const row = makeElement('div', 'row', null, 'backup-import-buttons');
  row.append(button('backup-folder-button', translate('backupChooseFolder'), 'primary', () => choose(folder)), button('backup-zip-button', translate('backupChooseZip'), '', () => choose(zip)));
  const report = makeElement('div', 'backup-report', null, 'backup-report');
  report.hidden = true;
  importSection.append(makeElement('h3', '', translate('backupImportHeading'), 'backup-import-title'), paragraph(translate('backupImportText')), setLabel, row, folder, zip, report);
  body.append(out, importSection);
  panel.append(head, body);
  elements.app.append(back);
  state.backup = { back, x, setBox, report, busy: false };
  updateInert();
  exportButton.focus({ preventScroll: true });
}
function closeBackup() {
  document.querySelectorAll('.backup-view').forEach((node) => node.remove());
  state.backup = null;
  updateInert();
  viewBack(byId('backup-button')).focus({ preventScroll: true });
}
// The zip, downloaded (as the browser downloads: its own place, or where you choose).
async function exportBackup(button) {
  button.disabled = true;
  try {
    const { files, counts } = await makeBackup({ version: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '' });
    const name = backupName() + '.zip';
    const url = URL.createObjectURL(new Blob([zipFiles(files)], { type: 'application/zip' }));
    const anchor = makeElement('a', '', null, 'backup-download');
    anchor.href = url;
    anchor.download = name;
    asking = true; // a "Save as" dialog may take the focus for a moment
    setTimeout(() => { if (document.hasFocus()) asking = false; }, 1500);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(translate('backupExported', { name, notes: counts.notes + counts.bookmarkNotes, stars: counts.stars, bookmarks: counts.bookmarks }));
  } finally { button.disabled = false; }
}
// The chosen folder's files (or the zip's), read and restored; what was done shown in the dialog.
async function importBackup(input) {
  const backup = state.backup;
  if (!backup || backup.busy || !input.files || !input.files.length) return;
  backup.busy = true;
  backup.report.hidden = false;
  backup.report.replaceChildren(makeElement('p', 'popover-fine-print', translate('backupWorking'), 'backup-working'));
  try {
    let files = null;
    const list = [...input.files];
    if (list.length === 1 && /\.zip$/i.test(list[0].name)) files = await unzipFiles(new Uint8Array(await list[0].arrayBuffer())).catch(() => null); // (not a zip, or a damaged one)
    else {
      files = new Map();
      for (const file of list) if (/\.json$/i.test(file.name) && file.size <= 50 * 1024 * 1024) files.set(file.webkitRelativePath || file.name, await file.text());
    }
    let data = null;
    try { if (files) data = readBackup(files); } catch { /* no backup in it */ }
    if (!data) { backup.report.replaceChildren(makeElement('p', 'popover-error', translate('backupBad'), 'backup-bad')); return; }
    const done = await restoreBackup(data, { settings: backup.setBox.checked });
    if (state.backup !== backup) return;
    const lines = BACKUP_KINDS.map(({ key, label }) => makeElement('li', '', translate('backupLine', { what: translate(label), added: done[key].added, updated: done[key].updated, skipped: done[key].skipped }), 'backup-report-line'));
    if (done.settings) lines.push(makeElement('li', '', translate('backupSettingsDone'), 'backup-report-settings'));
    const reportList = makeElement('ul', '', null, 'backup-report-list');
    reportList.append(...lines);
    backup.report.replaceChildren(makeElement('p', 'backup-done', translate('backupDone'), 'backup-done'), reportList);
    state.marks = null; // the search reads them again
    await reload();
    if (done.settings) { const preferences = await getPreferences(); state.preferences = preferences; applyAccent(preferences.accent); applyTheme(preferences.theme); } // (the language: at the next open)
  } catch (error) {
    if (state.backup === backup) backup.report.replaceChildren(makeElement('p', 'popover-error', translate('backupError'), 'backup-error'));
    console.warn('[Tabazing] restore failed:', error && error.message);
  } finally { backup.busy = false; }
}
function backupKey(event) {
  const key = event.key;
  if (MODIFIERS.has(key)) return;
  if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); return closeBackup(); }
  const target = event.target instanceof Element ? event.target : null;
  if (target && target.closest('.backup-view') && (key === 'Enter' || key === ' ') && target.matches('button, input')) return; // its buttons and box
  if (key === 'Tab') return;
  event.preventDefault(); // (nothing reaches the switcher behind it)
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
const historyOpen = () => !!document.querySelector('.history');
const openable = (url) => /^(https?|file|ftp):/i.test(url || '');
const DAY = 864e5;
const RANGES = { all: 0, today: 'today', week: 7, month: 30 };
const rangeStart = (range) => { const rangeValue = RANGES[range]; if (!rangeValue) return 0; if (rangeValue === 'today') { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime(); } return Date.now() - rangeValue * DAY; };
let historySequence = 0; // the rows' ids
let historyPool = null; // { start, list } the newest visits a search looks through, read once per open (and range)
// The newest `limit` pages Chrome has that Tabazing can open (chrome://… left out: a few more are asked for, so a page of
// the list is still 50), since `start`, and whether it has more. `text`: only the pages it finds, newest first, matched
// as the search box matches (typos forgiven) on their title, site, address and note (the note left on the page as a
// tab: a closed tab keeps it). `capped`: the search looked through its 5000 visits and there are more.
async function fetchHistory(limit, text = '', start = 0) {
  if (!chrome.history) return { items: [], more: false, capped: false };
  if (!text) {
    const ask = limit + HISTORY_PAGE;
    const searchResults = await chrome.history.search({ text: '', startTime: start, maxResults: ask });
    const items = searchResults.filter((x) => openable(x.url)).map(historyEntryOf);
    return { items: items.slice(0, limit), more: items.length > limit || searchResults.length >= ask, capped: false };
  }
  if (!historyPool || historyPool.start !== start) {
    historyPool = { start, list: chrome.history.search({ text: '', startTime: start, maxResults: HISTORY_POOL }).then((poolResults) => ({ all: poolResults.length, items: poolResults.filter((x) => openable(x.url)).map(historyEntryOf) })) };
  }
  const [pool, theirs] = await Promise.all([historyPool.list, chrome.history.search({ text, startTime: start, maxResults: 500 }).catch(() => [])]);
  const byUrl = new Map();
  for (const x of [...pool.items, ...theirs.filter((y) => openable(y.url)).map(historyEntryOf)]) if (!byUrl.has(x.url) || byUrl.get(x.url).t < x.t) byUrl.set(x.url, x);
  const found = [...byUrl.values()].filter((x) => matches(text, x.title, hostOf(x.url), x.url, noteOf(x.url), pageStatus(x.url, 'visited'))).sort((firstEntry, secondEntry) => secondEntry.t - firstEntry.t);
  return { items: found.slice(0, limit), more: found.length > limit, capped: pool.all >= HISTORY_POOL };
}
// A page of the history as an entry: what the rows, the menu and the big preview read.
const historyEntry = (x, previews) => ({
  kind: 'history', key: 'h' + (++historySequence), url: x.url, n: x.n || 0, preview: previews[normalizeUrl(x.url)] || null,
  item: { url: x.url, title: x.title || '', timestamp: x.t, session: null, fields: [[x.title || '', x.url]] },
});
// "Today", "Yesterday", or the day's date; and a time of day, in the language of the page.
function dayLabel(timestamp) {
  const date = new Date(timestamp), today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const daysAgo = Math.round((today - day) / DAY);
  if (daysAgo === 0) return translate('historyToday');
  if (daysAgo === 1) return translate('historyYesterday');
  return date.toLocaleDateString(uiLang(), { weekday: 'long', day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
// How long ago, short: "just now", "5m ago", "3h ago", "2d ago", "3w ago", "4 months ago", "1 year ago".
function agoShort(timestamp) {
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (!timestamp || seconds < 60) return translate('justNow');
  if (seconds < 3600) return translate('agoMinute', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return translate('agoHour', { n: Math.floor(seconds / 3600) });
  if (seconds < 7 * 86400) return translate('agoDay', { n: Math.floor(seconds / 86400) });
  if (seconds < 30 * 86400) return translate('agoWeek', { n: Math.floor(seconds / (7 * 86400)) });
  if (seconds < 365 * 86400) return translate('agoMonth', { count: Math.floor(seconds / (30 * 86400)) });
  return translate('agoYear', { count: Math.floor(seconds / (365 * 86400)) });
}
// A page's "last opened" tag: how long ago; hovering it shows the full date and time.
function agoTag(timestamp) {
  const tag = makeElement('span', 'tag history-ago', agoShort(timestamp), 'card-history-ago');
  tag.title = ''; // (not the row's tooltip: its own)
  tag.setAttribute('aria-label', translate('historyLastOpened') + ': ' + fullTime(timestamp));
  tag.addEventListener('mouseenter', () => showTip(tag, translate('historyLastOpened'), fullTime(timestamp), 'history-date-tooltip', DATE_TIP_DELAY_MILLISECONDS));
  tag.addEventListener('mouseleave', hideTipSoon);
  return tag;
}
const fullTime = (timestamp) => new Date(timestamp).toLocaleString(uiLang(), { dateStyle: 'medium', timeStyle: 'short' });
// A dialog that asks first: a title, a sentence, Cancel, and its actions ({ label, cls, fn, testid }).
function confirmDialog({ title, text, testid, actions }) {
  const box = makeElement('div', 'bookmark-form', null, testid);
  const heading = makeElement('h3', '', title, 'dialog-title');
  heading.id = 'dlg-title';
  const row = makeElement('div', 'row', null, testid + '-buttons');
  row.append(makeElement('span', 'grow', null, testid + '-spacer'), button(testid + '-cancel', translate('cancel'), 'quiet', closeDialog),
    ...actions.map((action) => button(action.testid, action.label, action.className || '', () => { closeDialog(); Promise.resolve(action.run()).catch((error) => toast(action.error || translate('actionFailed'), error)); })));
  box.append(heading, paragraph(text), row);
  showDialog('bookmark-edit', [box]);
  const main = row.querySelector('.primary, .danger');
  if (main) main.focus({ preventScroll: true });
}
async function openHistory() {
  closeDrawer(false);
  if (settingsOpen()) closeSettings(); // (Ctrl+H over Settings: the history comes in its place)
  closePops();
  closeBig();
  hideTip();
  state.dropdown.hidden = true;
  renderDropdown();
  if (archiveOpen()) closeArchive();
  if (bookmarksOpen()) closeBookmarks();
  historyPool = null; // read again: the history may have grown since
  const view = await getView().catch(() => ({}));
  if (state.done) return;
  document.querySelectorAll('.history').forEach((element) => element.remove());
  const { back, panel } = viewDialog('history', 'history-overlay', 'history-heading', closeHistory);
  const head = makeElement('div', 'archive-head', null, 'history-header');
  const title = makeElement('h2', 'archive-title', translate('historyTitle'), 'history-title');
  title.id = 'history-heading';
  const count = makeElement('span', 'count-badge', '', 'history-count');
  title.append(count);
  const x = makeElement('button', 'archive-close', null, 'history-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = translate('historyClose') + ' (Esc)';
  x.setAttribute('aria-label', translate('historyClose'));
  x.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeHistory(); });
  head.append(title, makeElement('span', 'archive-subtitle', translate('historySubtitle'), 'history-subtitle'), x);
  // the bar: the search box (it waits for a pause in typing), the range, the layout, Clear browsing data; with pages
  // picked, how many and what can be done to them
  const tools = makeElement('div', 'bookmarks-view-tools', null, 'history-tools');
  const find = searchField('history-search', translate('historySearch'), translate('historySearchAria'));
  find.input.setAttribute('aria-controls', 'history-list');
  let findTimer = null;
  find.input.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => { findTimer = null; findHistory(find.input.value.trim()).catch(() => {}); }, 180); });
  // The search the box still waits to run, at once (Enter right after typing opens what it finds); null if none waits.
  const flushFind = () => { if (!findTimer) return null; clearTimeout(findTimer); findTimer = null; return findHistory(find.input.value.trim()).catch(() => {}); };
  const range = makeElement('select', '', null, 'history-range');
  range.setAttribute('aria-label', translate('historyRangeAria'));
  for (const { v: value, label } of [{ v: 'all', label: 'historyRangeAll' }, { v: 'today', label: 'historyRangeToday' }, { v: 'week', label: 'historyRangeWeek' }, { v: 'month', label: 'historyRangeMonth' }]) {
    const option = makeElement('option', '', translate(label), 'history-range-option');
    option.value = value;
    range.append(option);
  }
  range.value = RANGES[view.historyRange] !== undefined ? view.historyRange : 'all';
  range.addEventListener('change', () => { updateView({ historyRange: range.value }).catch(() => {}); refreshHistory().catch(() => {}); });
  const layout = makeElement('button', 'chip', null, 'history-layout');
  layout.type = 'button';
  layout.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) setHistoryLayout(state.historyView.layout === 'list' ? 'grid' : 'list'); });
  const clear = makeElement('button', 'action', null, 'history-clear-data');
  clear.type = 'button';
  clear.append(svgOf(ICON.eraser), makeElement('span', '', translate('historyClearData'), 'history-clear-data-label'));
  clear.title = 'chrome://settings/clearBrowserData';
  clear.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) chromePage('chrome://settings/clearBrowserData')(); });
  const selectionBar = makeElement('div', 'bookmarks-view-selected', null, 'history-selection');
  const selectedCount = makeElement('span', '', '', 'history-selected');
  const picked = () => state.historyView.items.filter((entry) => state.historyView.picked.has(entry.key));
  selectionBar.append(selectedCount,
    button('history-open-selected', translate('historyOpenSelect'), 'small', () => historyBehindMany(picked()).catch((error) => toast(translate('actionFailed'), error))),
    button('history-copy-selected', translate('actionCopy'), 'small', () => copyLinks(picked().map((entry) => ({ title: entry.item.title, url: entry.url })), 'plain').catch((error) => toast(translate('copyFailed'), error))),
    button('history-remove-selected', translate('historyRemoveSelect'), 'small danger', () => removeHistory(picked()).catch((error) => toast(translate('historyRemoveError'), error))),
    button('history-clear-selected', translate('bookmarksViewClearSelect'), 'small quiet', () => { state.historyView.picked.clear(); syncHistory(); }));
  tools.append(find.box, range, layout, clear, selectionBar);
  const notice = makeElement('p', 'history-note', translate('historyPoolNote', { count: HISTORY_POOL }), 'history-pool-note');
  notice.hidden = true;
  const body = makeElement('div', 'archive-body', null, 'history-body');
  const list = makeElement('div', '', null, 'history-grid');
  list.id = 'history-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', 'history-heading');
  list.setAttribute('aria-multiselectable', 'true');
  const more = makeElement('button', 'button history-more', null, 'history-more');
  more.type = 'button';
  more.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) moreHistory().catch((error) => toast(translate('actionFailed'), error)); });
  const empty = makeElement('p', 'empty', '', 'history-empty');
  body.append(notice, empty, list, more);
  panel.append(head, tools, body);
  elements.app.append(back);
  state.historyView = { items: [], limit: HISTORY_PAGE, more: false, selected: 0, back, list, body, count, moreButton: more, empty, x, query: '', find: find.input, picked: new Set(), anchor: -1, flushFind,
    layout: view.historyLayout === 'grid' ? 'grid' : 'list', range, layoutButton: layout, selectionBar, selectedCount, notice };
  fancySelect(range);
  // Reaching the bottom of the list loads the next 50 by itself ("Show 50 more" is there, and stays for the keyboard).
  state.historyView.observer = new IntersectionObserver((seen) => {
    const historyView = state.historyView;
    if (historyView && seen.some((x) => x.isIntersecting) && historyView.more && !historyView.busy) moreHistory({ select: false }).catch(() => {}); // (scrolled to: the selection stays)
  }, { root: body, rootMargin: '0px 0px 240px 0px' });
  state.historyView.observer.observe(more);
  updateInert();
  find.input.focus({ preventScroll: true });
  find.input.select();
  await refreshHistory({ keepQ: true });
}
// The list again from the top: the newest 50 pages for the box's text and the range (the rows shown are dropped).
async function refreshHistory({ keepQ = false } = {}) {
  const historyView = state.historyView;
  if (!historyView) return;
  const query = keepQ ? historyView.query : historyView.find.value.trim();
  historyView.query = query;
  historyView.limit = HISTORY_PAGE;
  const result = await fetchHistory(historyView.limit, query, rangeStart(historyView.range.value)).catch(() => ({ items: [], more: false, capped: false }));
  const previews = await readPreviews(result.items.map((x) => x.url)).catch(() => ({}));
  if (state.historyView !== historyView || historyView.query !== query) return; // typed on meanwhile
  historyView.items = [];
  historyView.picked.clear();
  historyView.anchor = -1; // (a Shift+click range starts again in the new list)
  historyView.list.replaceChildren();
  historyView.more = result.more;
  historyView.notice.hidden = !(query && result.capped);
  addHistory(result.items, previews);
  historySelect(0, false);
  historyView.body.scrollTop = 0;
}
// The search box's text: the list starts again with the newest 50 pages that have it. (The box starts empty each
// time the history opens: a search is for now, not for next time.)
async function findHistory(query) {
  const historyView = state.historyView;
  if (!historyView || query === historyView.query) return;
  historyView.find.value = historyView.find.value.trim() === query ? historyView.find.value : query;
  await refreshHistory();
}
// Rows (or cards) for these pages, the ones not shown yet, at the end, under a heading for each new day.
function addHistory(items, previews) {
  const historyView = state.historyView;
  const have = new Set(historyView.items.map((entry) => entry.url));
  const add = items.filter((x) => !have.has(x.url)).map((x) => historyEntry(x, previews));
  let day = historyView.items.length ? dayLabel(historyView.items[historyView.items.length - 1].item.timestamp) : '';
  for (const entry of add) {
    const dayText = dayLabel(entry.item.timestamp);
    if (dayText !== day) { historyView.list.append(makeElement('h3', 'history-day', dayText, 'history-day')); day = dayText; }
    historyView.items.push(entry);
    historyView.list.append(historyItem(entry));
  }
  syncHistory();
  return add;
}
function syncHistory() {
  const historyView = state.historyView;
  historyView.list.className = historyView.layout === 'grid' ? 'grid' + (state.cardSize === 'default' ? '' : ' ' + state.cardSize) + ' history-grid' : 'history-list';
  historyView.back.classList.toggle('picking', historyView.picked.size > 0);
  historyView.count.textContent = historyView.more ? translate('historyShown', { count: historyView.items.length }) : String(historyView.items.length);
  historyView.empty.textContent = translate(!chrome.history ? 'historyNone' : historyView.query ? 'historyNoMatch' : 'historyEmpty');
  historyView.empty.hidden = historyView.items.length > 0;
  historyView.list.hidden = !historyView.items.length;
  historyView.moreButton.hidden = !historyView.more;
  historyView.moreButton.textContent = translate('historyMore', { count: HISTORY_PAGE });
  const other = historyView.layout === 'list' ? translate('historyGrid') : translate('historyList'); // the look a press switches to
  historyView.layoutButton.replaceChildren(svgOf(ICON[historyView.layout === 'list' ? 'cards' : 'sort']), makeElement('span', '', other, 'history-layout-label'));
  historyView.layoutButton.setAttribute('aria-label', other);
  historyView.selectionBar.hidden = !historyView.picked.size;
  historyView.selectedCount.textContent = translate('bookmarksViewSelected', { count: historyView.picked.size });
  for (const entry of historyView.items) {
    const on = historyView.picked.has(entry.key);
    entry.element.classList.toggle('picked', on);
    entry.element.setAttribute('aria-checked', String(on));
    const box = entry.element.querySelector('[data-testid="history-pick"]');
    if (box) { box.classList.toggle('on', on); box.setAttribute('aria-checked', String(on)); }
  }
}
// Rows or cards (the bar's layout button; remembered): the rows drawn again in the other look.
function setHistoryLayout(layout) {
  const historyView = state.historyView;
  historyView.layout = layout;
  updateView({ historyLayout: layout }).catch(() => {});
  const items = historyView.items;
  historyView.items = [];
  historyView.list.replaceChildren();
  let day = '';
  for (const entry of items) {
    const dayText = dayLabel(entry.item.timestamp);
    if (dayText !== day) { historyView.list.append(makeElement('h3', 'history-day', dayText, 'history-day')); day = dayText; }
    historyView.items.push(entry);
    historyView.list.append(historyItem(entry));
  }
  syncHistory();
  historySelect(historyView.selected, false);
}
// "Show 50 more": the next 50 visits, under the ones shown (the page stays where it was).
// `select`: the first of them is selected (↓ past the last page, "Show 50 more"), not when they come by scrolling.
async function moreHistory({ select = true } = {}) {
  const historyView = state.historyView;
  if (!historyView || historyView.busy || !historyView.more) return;
  historyView.busy = true;
  historyView.moreButton.disabled = true;
  try {
    historyView.limit += HISTORY_PAGE;
    const query = historyView.query;
    const result = await fetchHistory(historyView.limit, query, rangeStart(historyView.range.value));
    const previews = await readPreviews(result.items.map((x) => x.url)).catch(() => ({}));
    if (state.historyView !== historyView || !historyOpen() || historyView.query !== query) return;
    historyView.more = result.more;
    const first = historyView.items.length;
    const add = addHistory(result.items, previews);
    if (add.length && select) historySelect(first, false);
    if (historyView.moreButton.hidden && document.activeElement === historyView.moreButton) historyView.find.focus({ preventScroll: true });
  } finally {
    historyView.busy = false;
    historyView.moreButton.disabled = false;
    // still in view after these (a tall window): watched again, so the next 50 come too
    if (historyView.observer && historyView.more) { historyView.observer.unobserve(historyView.moreButton); historyView.observer.observe(historyView.moreButton); }
  }
}
// What a page says about itself: where it is, when it was last visited, how often (the tooltip; the big preview).
const historyInformation = (entry) => [entry.url, translate('historyLastVisit', { time: fullTime(entry.item.timestamp) }), translate('historyVisits', { count: entry.n || 1 })];
// (the history's rows no longer show the time of day: their "last opened" tag says how long ago, its tooltip when)
// A page as a row (the list) or a card (the grid): its tick box, its picture, its title, site and time, its note,
// and its buttons (note, big preview, remove, ⋯).
function historyItem(entry) {
  const historyView = state.historyView, item = entry.item, query = historyView.query;
  const title = item.title || hostOf(item.url) || translate('untitled');
  entry.info = historyInformation(entry);
  const pick = makeElement('button', 'bookmarks-view-pick', null, 'history-pick');
  pick.type = 'button';
  pick.setAttribute('role', 'checkbox');
  pick.setAttribute('aria-checked', 'false');
  pick.setAttribute('aria-label', translate('bookmarksViewSelect'));
  pick.append(svgOf(ICON.check));
  pick.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) historyPick(entry, { range: event.shiftKey }); });
  const quickButton = (testid, icon, label, action, className = '') => {
    const buttonElement = makeElement('button', 'quick-button' + className, null, testid);
    buttonElement.type = 'button';
    buttonElement.title = label;
    buttonElement.setAttribute('aria-label', label);
    buttonElement.append(svgOf(ICON[icon]));
    buttonElement.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) { historySelect(historyView.items.indexOf(entry), false); action(buttonElement); } });
    return buttonElement;
  };
  const bigButton = quickButton('quick-big', 'expand', translate('historyBig') + ' (Space)', () => openBig(entry));
  const more = quickButton('quick-more', 'more', translate('cardMenu'), (anchorButton) => historyMenu(entry, { anchor: anchorButton }));
  more.setAttribute('aria-haspopup', 'menu');
  const remove = deleteButton(translate('historyRemove'), 'card-history-remove', () => removeHistory([entry]).catch((error) => toast(translate('historyRemoveError'), error)));
  const titleElement = makeElement('span', historyView.layout === 'list' ? 'bookmarks-view-title' : 'title', null, 'card-title');
  titleElement.append(query ? highlight(title, query) : title);
  const note = noteOf(item.url);
  let element;
  if (historyView.layout === 'list') {
    element = makeElement('div', 'bookmarks-view-row mark histrow', null, 'card-history');
    const picture = makeElement('div', 'bookmarks-view-picture' + (entry.preview ? '' : ' bare'), null, entry.preview ? 'card-thumb' : 'card-no-preview');
    const image = makeElement('img', entry.preview ? 'shot' : 'favicon', null, entry.preview ? 'card-preview' : 'card-tile-favicon');
    image.src = entry.preview ? entry.preview.img : favicon(item.url);
    image.alt = '';
    picture.append(image);
    const text = makeElement('div', 'bookmarks-view-text', null, 'card-text');
    const titleRow = makeElement('span', 'bookmarks-view-title-line', null, 'card-history-title-row');
    titleRow.append(titleElement, agoTag(item.timestamp));
    const subtitle = makeElement('span', 'bookmarks-view-subtitle', null, 'card-history-subtitle');
    subtitle.append(query ? highlight(siteOf(item.url) || item.url, query) : siteOf(item.url) || item.url);
    text.append(titleRow, subtitle);
    if (note) { const noteElement = makeElement('span', 'bookmarks-view-note', null, 'card-history-note'); noteElement.append(query ? highlight(note, query) : note); text.append(noteElement); }
    const actionsRow = makeElement('div', 'bookmarks-view-actions', null, 'card-quick-actions');
    const noteButtonElement = noteButton(entry);
    actionsRow.append(noteButtonElement, bigButton, remove, more);
    remove.classList.add('quick-button');
    element.append(pick, picture, text, actionsRow);
  } else {
    element = makeElement('div', 'card', null, 'card-history');
    const head = makeElement('div', 'head', null, 'card-head');
    const faviconImage = makeElement('img', 'favicon', null, 'card-favicon');
    faviconImage.src = favicon(item.url);
    faviconImage.alt = '';
    head.append(pick, faviconImage, titleElement, agoTag(item.timestamp), headButtons(remove));
    const quick = makeElement('div', 'quick', null, 'card-quick-actions');
    quick.append(noteButton(entry), bigButton, more);
    const thumb = entry.preview ? thumbFor(entry, { label: '' }) : thumbFor(entry, { bare: true });
    thumb.append(quick);
    element.append(head, thumb);
  }
  element.id = 'history-' + entry.key;
  element.setAttribute('role', 'option');
  element.setAttribute('aria-selected', 'false');
  element.setAttribute('aria-checked', 'false');
  element.title = translate('historyOpenTip', { title }) + '\n' + entry.info.join('\n');
  entry.element = entry.card = element;
  mouseOnly(element); // the keyboard has Enter, Space, Del, Ctrl+Space and the menu (Shift+F10)
  element.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!pointerAllowed()) return;
    const i = historyView.items.indexOf(entry);
    if (event.ctrlKey || event.metaKey) return historyPick(entry);
    if (event.shiftKey) { if (historyView.picked.size) return historyPick(entry, { range: true }); historySelect(i, false); return openBig(entry); }
    openPage(item.url);
  });
  onMiddleClick(element, () => historyBehind(item).catch((error) => toast(translate('actionFailed'), error)));
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!pointerAllowed()) return;
    historySelect(historyView.items.indexOf(entry), false);
    historyMenu(entry, { at: { x: event.clientX, y: event.clientY } });
  });
  return element;
}
// Tick a page, or (`range`) every page from the last one ticked to it.
function historyPick(entry, { range = false } = {}) {
  const historyView = state.historyView;
  const i = historyView.items.indexOf(entry);
  if (range && historyView.anchor >= 0 && historyView.anchor < historyView.items.length) {
    const [start, end] = historyView.anchor < i ? [historyView.anchor, i] : [i, historyView.anchor];
    for (let index = start; index <= end; index++) historyView.picked.add(historyView.items[index].key);
  } else if (historyView.picked.has(entry.key)) historyView.picked.delete(entry.key);
  else historyView.picked.add(entry.key);
  historyView.anchor = i;
  historySelect(i, false);
  syncHistory();
  elements.live.textContent = translate('bookmarksViewSelected', { count: historyView.picked.size });
}
function historySelect(i, scroll = true) {
  const historyView = state.historyView;
  if (!historyView || !historyView.items.length) return;
  historyView.selected = Math.max(0, Math.min(historyView.items.length - 1, i));
  historyView.items.forEach((entry, index) => entry.element.setAttribute('aria-selected', String(index === historyView.selected)));
  const it = historyView.items[historyView.selected].element;
  historyView.list.setAttribute('aria-activedescendant', it.id);
  historyView.find.setAttribute('aria-activedescendant', it.id);
  if (scroll) it.scrollIntoView({ block: 'nearest' });
}
function closeHistory() {
  closePops();
  if (state.historyView && state.historyView.observer) state.historyView.observer.disconnect();
  if (state.historyView) state.historyView.find.value = ''; // (a search still waiting then finds no history to run in)
  document.querySelectorAll('.history').forEach((element) => element.remove());
  state.historyView = null;
  updateInert();
  viewBack(byId('history-button')).focus({ preventScroll: true }); // back to what opened it
}
// Out of Chrome's history (every visit to them), and off the list here; the search forgets them too. Undo puts them
// back (as a visit now: Chrome can't bring the old visits back).
async function removeHistory(entries) {
  const historyView = state.historyView;
  entries = entries.filter(Boolean);
  if (!entries.length) return;
  for (const entry of entries) await chrome.history.deleteUrl({ url: entry.url });
  forgetHistory(entries.map((entry) => entry.url));
  if (historyView && state.historyView === historyView) {
    const first = Math.min(...entries.map((entry) => historyView.items.indexOf(entry)).filter((i) => i >= 0));
    for (const entry of entries) {
      const i = historyView.items.indexOf(entry);
      if (i >= 0) historyView.items.splice(i, 1);
      historyView.picked.delete(entry.key);
      entry.element.remove();
    }
    historyView.list.querySelectorAll('.history-day').forEach((dayHeading) => { const next = dayHeading.nextElementSibling; if (!next || next.classList.contains('history-day')) dayHeading.remove(); }); // a day left empty
    syncHistory();
    historySelect(Math.min(Number.isFinite(first) ? first : 0, historyView.items.length - 1), false);
  }
  const pages = entries.map((entry) => ({ url: entry.url, title: entry.item.title, t: entry.item.timestamp }));
  toast(translate('historyRemovedCount', { count: entries.length }), null, { label: translate('undo'), run: () => unremoveHistory(pages) });
}
// What the search and the history list keep, without these addresses.
function forgetHistory(urls) {
  const gone = new Set(urls.map(urlKey));
  if (state.history) state.history = state.history.filter((x) => !gone.has(urlKey(x.url)));
  if (historyPool) historyPool = { ...historyPool, list: historyPool.list.then((pool) => ({ ...pool, items: pool.items.filter((x) => !gone.has(urlKey(x.url))) })) };
  if (state.historyQuery && state.historyQuery.items) state.historyQuery = { ...state.historyQuery, items: state.historyQuery.items.filter((x) => !gone.has(urlKey(x.url))) };
}
async function unremoveHistory(pages) {
  for (const page of pages) {
    // A title and the time of the visit, where Chrome takes them; else only the address (a Chrome that doesn't know
    // those refuses the call itself, before it returns: hence try, not .catch).
    try { await chrome.history.addUrl({ url: page.url, title: page.title, visitTime: page.t }); }
    catch { try { await chrome.history.addUrl({ url: page.url }); } catch {} }
  }
  historyPool = null;
  state.history = null;
  toast(translate('historyRestoredCount', { count: pages.length }));
  if (historyOpen()) await refreshHistory();
}
// Open pages of the history behind Tabazing, which stays (the new tabs join the open ones).
async function historyBehind(item) {
  await reopenPage(item, { active: false });
  toast(translate('openedCount', { count: 1 }));
  await reload();
}
async function historyBehindMany(entries) {
  for (const entry of entries) await chrome.tabs.create({ url: entry.url, windowId: CONTEXT.sourceWindow, active: false });
  if (state.historyView) { state.historyView.picked.clear(); syncHistory(); }
  toast(translate('openedCount', { count: entries.length }));
  await reload();
}
// "More from this site": the search box set to the page's site.
function historyMoreFrom(entry) {
  const historyView = state.historyView;
  const host = hostOf(entry.url).replace(/^www\./, '');
  if (!historyView || !host) return;
  historyView.find.value = host;
  historyView.find.focus({ preventScroll: true });
  findHistory(host).catch(() => {});
}
// "Remove all from this site": every visit to its site's pages, after saying how many (Undo puts them back).
async function historyForgetSite(entry) {
  const host = hostOf(entry.url);
  if (!host) return;
  const searchResults = await chrome.history.search({ text: host.replace(/^www\./, ''), startTime: 0, maxResults: 100000 });
  const pages = searchResults.filter((x) => hostOf(x.url) === host);
  if (!pages.length) return;
  confirmDialog({
    title: translate('historyForgetSiteTitle', { site: host.replace(/^www\./, '') }), text: translate('historyForgetSiteText', { count: pages.length }), testid: 'history-forget-site',
    actions: [{ label: translate('historyRemove'), className: 'danger', testid: 'history-forget-site-ok', error: translate('historyRemoveError'), run: async () => {
      for (const page of pages) await chrome.history.deleteUrl({ url: page.url });
      forgetHistory(pages.map((page) => page.url));
      if (historyOpen()) await refreshHistory();
      const back = pages.map((page) => ({ url: page.url, title: page.title || '', t: page.lastVisitTime || Date.now() }));
      toast(translate('historyRemovedCount', { count: pages.length }), null, { label: translate('undo'), run: () => unremoveHistory(back) });
    } }],
  });
}
// A page's ⋯ (a right-click, Shift+F10): everything a page can have done to it.
function historyMenu(entry, { anchor = null, at = null } = {}) {
  const item = entry.item, card = entry.element;
  if (!card || !card.isConnected) return;
  if (at) anchor = card;
  else if (!anchor) {
    const more = card.querySelector('[data-testid="quick-more"]');
    anchor = more && more.getClientRects().length ? more : card;
  }
  const historyView = state.historyView;
  const note = card.querySelector('.quick-button.note');
  const pages = [{ title: item.title, url: item.url }];
  const items = [
    { icon: 'goto', label: translate('historyOpen'), run: () => openPage(item.url) },
    { icon: 'window', label: translate('historyNewWindow'), error: translate('actionFailed'), run: () => reopenInWindow(item) },
    { icon: 'tab', label: translate('historyBehind'), error: translate('actionFailed'), run: () => historyBehind(item) },
    { icon: 'expand', label: translate('historyBig'), run: () => openBig(entry) },
    null,
    { icon: 'link', label: translate('copyLink'), error: translate('copyFailed'), run: () => copyLinks(pages, 'plain') },
    { icon: 'star', label: translate(isStarred(item.url) ? 'unstar' : 'star'), run: () => star(entry) },
  ];
  if (note) items.push({ icon: 'note', label: translate(noteOf(item.url) ? 'noteEdit' : 'noteAdd'), run: () => notePopover(item.url, note) });
  items.push(
    { icon: 'bookmark', label: translate('markMenu'), error: translate('markError'), run: () => bookmarkDialog(pages) },
    { icon: 'clock', label: translate('historySnooze'), error: translate('errorSnooze'), run: () => snoozeMenu([], anchor, (when) => snoozeClosed(item, when)) },
    { icon: 'archive', label: translate('tabArchive'), error: translate('errorArchive'), run: () => archiveClosed(item) },
    null,
    { icon: 'check', label: translate(historyView.picked.has(entry.key) ? 'bookmarksViewUnselect' : 'bookmarksViewSelect'), run: () => historyPick(entry) },
    { icon: 'globe', label: translate('historyMoreFrom'), run: () => historyMoreFrom(entry) },
    null,
    { icon: 'trash', label: translate('historyRemove'), danger: true, error: translate('historyRemoveError'), run: () => removeHistory([entry]) },
    { icon: 'trash', label: translate('historyForgetSite'), danger: true, error: translate('historyRemoveError'), run: () => historyForgetSite(entry) },
  );
  menu(anchor, items, { back: historyView.find, at });
}
// While the history is open it has the keyboard (a menu, a small card or a dialog over it keeps its own keys). In
// the search box the keys type, except ↑ ↓ PgUp PgDn (and Home / End while it is empty), Enter, Ctrl+Enter,
// Ctrl+Space, Shift+F10 and Esc. Out of it, Space shows a page big and Del removes the ticked pages or the selected one.
// Esc empties the box first, then unticks, then closes. Typing anywhere goes to the box.
function historyKey(event) {
  const key = event.key, historyView = state.historyView;
  const target = event.target instanceof Element ? event.target : null;
  if (!historyView || (target && target.closest('.menu, .popover'))) return;
  if (MODIFIERS.has(key)) return;
  if (target && target.closest('.history-more, .bookmarks-view-tools button, .bookmarks-view-tools .fancy-select') && (key === 'Enter' || key === ' ')) return; // its buttons press
  const inBox = target === historyView.find;
  const empty = !historyView.find.value;
  const ctrlPressed = event.ctrlKey || event.metaKey;
  const stop = () => { event.preventDefault(); event.stopPropagation(); };
  if (key === 'Escape') {
    stop();
    if (historyView.find.value) { historyView.find.value = ''; findHistory('').catch(() => {}); historyView.find.focus({ preventScroll: true }); return; }
    if (historyView.picked.size) { historyView.picked.clear(); syncHistory(); return; }
    return closeHistory();
  }
  const navigationKey = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Enter'].includes(key) || ((key === 'Home' || key === 'End') && (!inBox || empty))
    || (key === ' ' && ctrlPressed) || (key === 'F10' && event.shiftKey) || key === 'ContextMenu' || (ctrlPressed && key.toLowerCase() === 'a' && (!inBox || empty));
  if (inBox && !navigationKey) return; // typing
  if (!inBox && key.length === 1 && key !== ' ' && !ctrlPressed && !event.altKey) { historyView.find.focus({ preventScroll: true }); return; } // typing goes to the box
  stop();
  const waiting = key === 'Enter' && historyView.flushFind();
  if (waiting) { waiting.then(() => { if (state.historyView === historyView) historyKey(event); }); return; } // the search typed first, then its first page
  if (ctrlPressed && !event.shiftKey && !event.altKey && event.code === 'KeyZ') { if (!event.repeat) toastUndo(); return; }
  if (!historyView.items.length) return;
  const entry = historyView.items[historyView.selected];
  if (ctrlPressed && key.toLowerCase() === 'a') { historyView.items.forEach((x) => historyView.picked.add(x.key)); syncHistory(); elements.live.textContent = translate('bookmarksViewSelected', { count: historyView.picked.size }); return; }
  if (key === ' ' && ctrlPressed) return historyPick(entry);
  if (key === 'Delete' || (IS_MAC && event.metaKey && key === 'Backspace')) {
    if (event.repeat) return;
    if (!keysAllowed()) return finish('cancel');
    return removeHistory(historyView.picked.size ? historyView.items.filter((x) => historyView.picked.has(x.key)) : [entry]).catch((error) => toast(translate('historyRemoveError'), error));
  }
  if (key === 'Enter') {
    if (!keysAllowed()) return finish('cancel');
    if (ctrlPressed) return historyBehind(entry.item).catch((error) => toast(translate('actionFailed'), error)); // Ctrl+Enter: behind, Tabazing stays
    return openPage(entry.url);
  }
  if (key === ' ') return openBig(entry);
  if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) { if (!event.repeat) historyMenu(entry); return; }
  if (key === 'Home') return historySelect(0);
  if (key === 'End') return historySelect(historyView.items.length - 1);
  if (key === 'PageDown' || key === 'PageUp') return historySelect(historyView.selected + (key === 'PageDown' ? 10 : -10));
  const grid = historyView.layout === 'grid';
  if (key === 'ArrowRight' || key === 'ArrowLeft') { if (grid) historySelect(historyView.selected + ahead(key)); return; }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const down = key === 'ArrowDown';
    const j = grid && !inBox ? cardToward(historyView.items.map((x) => x.element), historyView.selected, down ? 1 : -1) : historyView.selected + (down ? 1 : -1) < historyView.items.length ? historyView.selected + (down ? 1 : -1) : -1;
    if (j >= 0) historySelect(j);
    else if (down && historyView.more) moreHistory().catch(() => {}); // past the last one: the next 50
  }
}

// A search box in the history's and the bookmarks' bar: a magnifier and the field. { box, input }.
function searchField(testid, placeholder, aria) {
  const box = makeElement('label', 'bookmarks-view-search', null, testid + '-box');
  box.append(svgOf(ICON.zoom));
  const input = makeElement('input', '', null, testid);
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
const bookmarksOpen = () => !!document.querySelector('.bookmarks-view');
const bookmarkNoteOf = (id) => ((state.bookmarkNotes || {})[id] || {}).n || '';
const BOOKMARKS_VIEW_CONFIRM = 15; // opening more tabs than this at once asks first (as Chrome does); deleting 10 bookmarks or more too
const BOOKMARKS_VIEW_CONFIRM_DELETE = 10;
const BOOKMARKS_VIEW_EAGER = 80; // the rows whose previews are read at once (the others when they scroll into view)
let bookmarksViewObserver = null;
async function openBookmarks() {
  closeDrawer(false);
  if (!chrome.bookmarks) return toast(translate('dropdownNoMarks'));
  if (settingsOpen()) closeSettings();
  closePops();
  closeBig();
  hideTip();
  state.dropdown.hidden = true;
  renderDropdown();
  if (archiveOpen()) closeArchive();
  if (historyOpen()) closeHistory();
  const [tree, notes, view] = await Promise.all([chrome.bookmarks.getTree(), getBookmarkNotes().catch(() => ({})), getView().catch(() => ({}))]);
  if (state.done) return;
  state.bookmarkNotes = notes;
  document.querySelectorAll('.bookmarks-view').forEach((element) => element.remove());
  const { back, panel } = viewDialog('bookmarks-view', 'bookmarks-overlay', 'bookmarks-view-heading', closeBookmarks);
  const head = makeElement('div', 'archive-head', null, 'bookmarks-header');
  const title = makeElement('h2', 'archive-title', translate('bookmarksViewTitle'), 'bookmarks-title');
  title.id = 'bookmarks-view-heading';
  const count = makeElement('span', 'count-badge', '', 'bookmarks-count');
  title.append(count);
  const x = makeElement('button', 'archive-close', null, 'bookmarks-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = translate('bookmarksViewClose') + ' (Esc)';
  x.setAttribute('aria-label', translate('bookmarksViewClose'));
  x.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeBookmarks(); });
  head.append(title, makeElement('span', 'archive-subtitle', translate('bookmarksViewSubtitle'), 'bookmarks-subtitle'), x);
  // the bar: the search box, Add bookmark, New folder, Duplicates, the stars; with rows ticked, how many
  // and what can be done to them
  const tools = makeElement('div', 'bookmarks-view-tools', null, 'bookmarks-tools');
  const find = searchField('bookmarks-search', translate('bookmarksViewSearch'), translate('bookmarksViewSearchAria'));
  find.input.setAttribute('role', 'combobox');
  find.input.setAttribute('aria-controls', 'bookmarks-view-tree');
  find.input.setAttribute('aria-expanded', 'true');
  let findTimer = null;
  find.input.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => { findTimer = null; bookmarksViewFind(find.input.value); }, 100); });
  // The search the box still waits to run, at once (Enter right after typing opens what it finds).
  const flushFind = () => { if (findTimer) { clearTimeout(findTimer); findTimer = null; bookmarksViewFind(find.input.value); } };
  const tool = (testid, icon, label, action, className = 'action') => {
    const buttonElement = makeElement('button', className, null, testid);
    buttonElement.type = 'button';
    buttonElement.append(svgOf(ICON[icon]), makeElement('span', '', label, testid + '-label'));
    buttonElement.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) Promise.resolve(action(buttonElement)).catch((error) => toast(translate('bookmarksViewError'), error)); });
    return buttonElement;
  };
  const add = tool('bookmarks-add', 'plus', translate('bookmarksViewAdd'), () => bookmarksViewEdit(null, { parentId: bookmarksViewHere() }));
  const folder = tool('bookmarks-new-folder', 'folder', translate('bookmarksViewNewFolder'), () => bookmarksViewEdit(null, { parentId: bookmarksViewHere(), folder: true }));
  const duplicatesButton = tool('bookmarks-duplicates', 'duplicate', '', () => bookmarksViewFilter('duplicates'), 'chip');
  const stars = tool('bookmarks-stars', 'star', '', () => bookmarksViewImportStars());
  const selectionBar = makeElement('div', 'bookmarks-view-selected', null, 'bookmarks-selection');
  const selectedCount = makeElement('span', '', '', 'bookmarks-selected');
  const pickedNodes = () => [...state.bookmarksView.picked].map((id) => state.bookmarksView.byId.get(id)).filter(Boolean);
  selectionBar.append(selectedCount,
    button('bookmarks-open-selected', translate('historyOpenSelect'), 'small', () => bookmarksViewOpenAll(pickedNodes().flatMap(bookmarksViewMarksIn)).catch((error) => toast(translate('actionFailed'), error))),
    button('bookmarks-move-selected', translate('bookmarksViewMoveSelect'), 'small', () => bookmarksViewMoveDialog(pickedNodes()).catch((error) => toast(translate('bookmarksViewError'), error))),
    button('bookmarks-copy-selected', translate('actionCopy'), 'small', () => copyLinks(pickedNodes().flatMap(bookmarksViewMarksIn).map((mark) => ({ title: mark.title, url: mark.url })), 'plain').catch((error) => toast(translate('copyFailed'), error))),
    button('bookmarks-delete-selected', translate('bookmarksViewDeleteSelect'), 'small danger', () => bookmarksViewDelete(pickedNodes()).catch((error) => toast(translate('bookmarksViewError'), error))),
    button('bookmarks-clear-selected', translate('bookmarksViewClearSelect'), 'small quiet', () => { state.bookmarksView.picked.clear(); drawBookmarks(); }));
  tools.append(find.box, add, folder, duplicatesButton, stars, selectionBar);
  const body = makeElement('div', 'archive-body', null, 'bookmarks-body');
  const treeElement = makeElement('div', 'bookmarks-view-tree', null, 'bookmarks-tree');
  treeElement.id = 'bookmarks-view-tree';
  treeElement.setAttribute('role', 'tree');
  treeElement.setAttribute('aria-labelledby', 'bookmarks-view-heading');
  treeElement.setAttribute('aria-multiselectable', 'true');
  const empty = makeElement('p', 'empty', '', 'bookmarks-empty');
  body.append(empty, treeElement);
  panel.append(head, tools, body);
  elements.app.append(back);
  const bookmarksView = state.bookmarksView = {
    back, body, tree: treeElement, empty, count, find: find.input, flushFind, selected: selectionBar, selectedCount, x, query: '', current: 0, currentId: null, rows: [], open: new Set(), picked: new Set(), anchorId: null,
    previews: {}, byId: new Map(), tops: [], filter: null, duplicates: new Map(), duplicatesButton, starsButton: stars,
  };
  bookmarksViewIndex(bookmarksView, tree);
  // What was open and the selected row come back (the folders that are still there); the first time, Chrome's own
  // folders are open. The search box starts empty.
  const kept = (view.bookmarksViewOpen || []).filter((id) => bookmarksView.byId.has(id));
  (kept.length ? kept : bookmarksView.tops).forEach((id) => bookmarksView.open.add(id));
  if (view.bookmarksViewSelected && bookmarksView.byId.has(view.bookmarksViewSelected)) bookmarksView.currentId = view.bookmarksViewSelected;
  pruneBookmarkNotes(bookmarksView).catch(() => {});
  drawBookmarks();
  updateInert();
  find.input.focus({ preventScroll: true });
  find.input.select();
  bookmarksViewSelect(bookmarksView.current);
}
// The tree, by id: { id, parentId, title, url, kids (ids, in order), top (Chrome's own folders: fixed), dateAdded, archive }.
function bookmarksViewIndex(bookmarksView, tree) {
  bookmarksView.byId = new Map();
  bookmarksView.tops = [];
  const walk = (rawNode) => {
    const node = { id: rawNode.id, parentId: rawNode.parentId, title: rawNode.title || '', url: rawNode.url || '', dateAdded: rawNode.dateAdded || 0, top: rawNode.parentId === '0', fixed: rawNode.parentId === '0' || !!rawNode.unmodifiable, kids: [] };
    bookmarksView.byId.set(rawNode.id, node);
    for (const child of rawNode.children || []) { node.kids.push(child.id); walk(child); }
  };
  for (const top of (tree[0] && tree[0].children) || []) { bookmarksView.tops.push(top.id); walk(top); }
  const other = bookmarksView.tops.map((id) => bookmarksView.byId.get(id)).find((node) => /other/i.test(node.title)) || bookmarksView.byId.get('2');
  for (const id of (other && other.kids) || []) { const node = bookmarksView.byId.get(id); if (node && !node.url && node.title === ARCHIVE_FOLDER) node.archive = true; }
  // the same address bookmarked more than once (Duplicates), by its normalized address
  const by = new Map();
  for (const node of bookmarksView.byId.values()) if (node.url) { const key = normalizeUrl(node.url) || node.url; by.set(key, (by.get(key) || 0) + 1); }
  bookmarksView.duplicates = new Map([...by].filter(([, count]) => count > 1));
}
const bookmarksViewDuplicateCount = (node) => (node.url ? state.bookmarksView.duplicates.get(normalizeUrl(node.url) || node.url) || 0 : 0);
const bookmarksViewPath = (node) => { const out = []; for (let parent = state.bookmarksView.byId.get(node.parentId); parent; parent = state.bookmarksView.byId.get(parent.parentId)) out.unshift(parent.title || translate('untitled')); return out.join(' › '); };
const bookmarksViewMarksIn = (node) => (!node ? [] : node.url ? [node] : node.kids.flatMap((childId) => bookmarksViewMarksIn(state.bookmarksView.byId.get(childId))));
// Notes on bookmarks that are no longer there (deleted in Chrome's own manager) go.
async function pruneBookmarkNotes(bookmarksView) {
  const gone = Object.keys(state.bookmarkNotes || {}).filter((id) => !bookmarksView.byId.has(id));
  if (gone.length) state.bookmarkNotes = await putBookmarkNotes(Object.fromEntries(gone.map((id) => [id, null])));
}
// After a change: the tree read again; what was open, picked and selected stays so (if it still is there).
async function reloadBookmarks() {
  const bookmarksView = state.bookmarksView;
  state.marks = null; // the search reads them again
  if (!bookmarksView) return;
  const tree = await chrome.bookmarks.getTree();
  if (state.bookmarksView !== bookmarksView) return;
  bookmarksViewIndex(bookmarksView, tree);
  for (const id of [...bookmarksView.picked]) if (!bookmarksView.byId.has(id)) bookmarksView.picked.delete(id);
  drawBookmarks();
}
// A bookmark as an entry (what the menu, the big preview, a star and a snooze read), kept with its node.
function bookmarkEntry(node) {
  const bookmarksView = state.bookmarksView;
  const preview = (bookmarksView && bookmarksView.previews[normalizeUrl(node.url)]) || null;
  if (!node.entry) node.entry = { kind: 'bmk', key: 'b' + node.id, url: node.url, node, item: { url: node.url, title: node.title, timestamp: node.dateAdded, session: null, fields: [[node.title, node.url]] } };
  node.entry.preview = preview;
  node.entry.info = [node.url, bookmarksViewPath(node), node.dateAdded ? translate('bookmarksViewAdded', { time: fullTime(node.dateAdded) }) : ''].filter(Boolean);
  return node.entry;
}
// The rows shown, in order: each folder's contents while it is open; searching or filtering, the matches and the
// folders they are in.
function bookmarksViewRows() {
  const bookmarksView = state.bookmarksView, query = bookmarksView.query.trim();
  const rows = [];
  if (!query && !bookmarksView.filter) {
    const walk = (id, depth) => { const node = bookmarksView.byId.get(id); rows.push({ n: node, depth }); if (!node.url && bookmarksView.open.has(id)) node.kids.forEach((childId) => walk(childId, depth + 1)); };
    bookmarksView.tops.forEach((id) => walk(id, 0));
    return rows;
  }
  const matchedIds = new Set();
  for (const node of bookmarksView.byId.values()) {
    if (node.top) continue;
    if (bookmarksView.filter === 'duplicates' && !bookmarksViewDuplicateCount(node)) continue;
    if (bookmarksView.filter && !node.url) continue;
    const found = !query || (node.url ? matches(query, node.title, hostOf(node.url), node.url, bookmarkNoteOf(node.id), { status: statusText('bookmarked', isStarred(node.url) && 'starred', bookmarkNoteOf(node.id) && 'note') }) : matches(query, node.title));
    if (!found) continue;
    matchedIds.add(node.id);
    for (let parent = bookmarksView.byId.get(node.parentId); parent; parent = bookmarksView.byId.get(parent.parentId)) matchedIds.add(parent.id);
  }
  const walk = (id, depth) => { if (!matchedIds.has(id)) return; const node = bookmarksView.byId.get(id); rows.push({ n: node, depth }); if (!node.url) node.kids.forEach((childId) => walk(childId, depth + 1)); };
  bookmarksView.tops.forEach((id) => walk(id, 0));
  return rows;
}
// The search box's text (it waits for a pause in typing): its first bookmark found is selected.
function bookmarksViewFind(text) {
  const bookmarksView = state.bookmarksView;
  if (!bookmarksView) return;
  bookmarksView.query = text;
  bookmarksView.currentId = null;
  bookmarksView.current = 0;
  drawBookmarks();
  const first = bookmarksView.rows.findIndex((row) => row.n.url);
  if ((bookmarksView.query.trim() || bookmarksView.filter) && first >= 0) bookmarksViewSelect(first);
}
function bookmarksViewFilter(kind) {
  const bookmarksView = state.bookmarksView;
  bookmarksView.filter = bookmarksView.filter === kind ? null : kind;
  bookmarksViewFind(bookmarksView.find.value);
}
function drawBookmarks() {
  const bookmarksView = state.bookmarksView;
  if (!bookmarksView) return;
  bookmarksView.rows = bookmarksViewRows();
  const at = bookmarksView.currentId ? bookmarksView.rows.findIndex((row) => row.n.id === bookmarksView.currentId) : -1;
  bookmarksView.current = at >= 0 ? at : Math.max(0, Math.min(bookmarksView.current, bookmarksView.rows.length - 1));
  if (bookmarksViewObserver) bookmarksViewObserver.disconnect();
  bookmarksViewObserver = new IntersectionObserver((seen) => { const ids = seen.filter((entry) => entry.isIntersecting).map((entry) => entry.target.dataset.bookmark); if (ids.length) loadBookmarksViewPreviews(ids); }, { root: bookmarksView.body, rootMargin: '400px 0px' });
  bookmarksView.tree.replaceChildren(...bookmarksView.rows.map(bookmarksViewRow));
  const marks = [...bookmarksView.byId.values()].filter((node) => node.url).length;
  bookmarksView.count.textContent = String(marks);
  const searching = !!bookmarksView.query.trim() || !!bookmarksView.filter;
  const shown = searching ? bookmarksView.rows.some((row) => row.n.url || !row.n.top) : marks > 0 || bookmarksView.rows.length > bookmarksView.tops.length;
  bookmarksView.empty.textContent = translate(searching ? 'bookmarksViewNoMatch' : 'bookmarksViewEmpty');
  bookmarksView.empty.hidden = shown;
  bookmarksView.selected.hidden = !bookmarksView.picked.size;
  bookmarksView.selectedCount.textContent = translate('bookmarksViewSelected', { count: bookmarksView.picked.size });
  bookmarksView.back.classList.toggle('picking', bookmarksView.picked.size > 0);
  const duplicateCount = [...bookmarksView.byId.values()].filter((node) => bookmarksViewDuplicateCount(node)).length;
  bookmarksView.duplicatesButton.hidden = !duplicateCount && bookmarksView.filter !== 'duplicates';
  bookmarksView.duplicatesButton.setAttribute('aria-pressed', String(bookmarksView.filter === 'duplicates'));
  bookmarksView.duplicatesButton.lastChild.textContent = translate('bookmarksViewDuplicates', { count: duplicateCount });
  const starsLeft = bookmarksViewStarsToImport();
  bookmarksView.starsButton.hidden = !starsLeft.length;
  bookmarksView.starsButton.lastChild.textContent = translate('bookmarksViewImportStars', { count: starsLeft.length });
  bookmarksView.starsButton.title = translate('bookmarksViewStarsTip');
  bookmarksViewSelect(bookmarksView.current, false);
  // the previews of the first rows at once; the others as they scroll into view
  loadBookmarksViewPreviews(bookmarksView.rows.slice(0, BOOKMARKS_VIEW_EAGER).filter((row) => row.n.url).map((row) => row.n.id));
}
// Read the previews of these bookmarks (the ones not read yet) and put them in their rows.
async function loadBookmarksViewPreviews(ids) {
  const bookmarksView = state.bookmarksView;
  if (!bookmarksView) return;
  bookmarksView.asked = bookmarksView.asked || new Set();
  const want = ids.map((id) => bookmarksView.byId.get(id)).filter((node) => node && node.url && !bookmarksView.asked.has(node.id));
  if (!want.length) return;
  want.forEach((node) => bookmarksView.asked.add(node.id));
  const previews = await readPreviews(want.map((node) => node.url)).catch(() => ({}));
  if (state.bookmarksView !== bookmarksView) return;
  Object.assign(bookmarksView.previews, previews);
  for (const node of want) {
    const preview = previews[normalizeUrl(node.url)];
    const row = document.getElementById('bookmarks-view-' + node.id);
    if (!preview || !preview.img || !row) continue;
    const image = row.querySelector('[data-testid="bookmarks-view-favicon"]');
    if (!image) continue;
    image.className = 'shot';
    image.dataset.testid = 'bookmarks-view-preview';
    image.src = preview.img;
  }
}
function bookmarksViewRow({ n: node, depth }, i) {
  const bookmarksView = state.bookmarksView;
  const query = bookmarksView.query.trim();
  const searching = !!query || !!bookmarksView.filter;
  const open = !node.url && (searching || bookmarksView.open.has(node.id));
  const picked = bookmarksView.picked.has(node.id);
  const row = makeElement('div', 'bookmarks-view-row ' + (node.url ? 'mark' : 'folder') + (!node.url && !open ? ' shut' : '') + (picked ? ' picked' : '') + (node.archive ? ' archive' : ''), null, node.url ? 'bookmarks-view-mark' : 'bookmarks-view-folder');
  row.id = 'bookmarks-view-' + node.id;
  row.dataset.bookmark = node.id;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));
  row.setAttribute('aria-selected', 'false');
  if (!node.fixed) row.setAttribute('aria-checked', String(picked));
  row.style.setProperty('--depth', depth);
  const title = node.title || (node.url ? hostOf(node.url) : '') || translate('untitled');
  const titleElement = makeElement('span', 'bookmarks-view-title', null, 'bookmarks-view-title');
  titleElement.append(query ? highlight(title, query) : title);
  const actionsRow = makeElement('div', 'bookmarks-view-actions', null, 'bookmarks-view-actions');
  const rowAction = (testid, icon, label, action, className = '') => {
    const buttonElement = makeElement('button', 'quick-button' + className, null, testid);
    buttonElement.type = 'button';
    buttonElement.title = label;
    buttonElement.setAttribute('aria-label', label);
    buttonElement.append(svgOf(ICON[icon]));
    buttonElement.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) { bookmarksView.currentId = node.id; bookmarksViewSelect(i, false); Promise.resolve(action(buttonElement)).catch((error) => toast(translate('bookmarksViewError'), error)); } });
    return buttonElement;
  };
  const more = rowAction('quick-more', 'more', translate('cardMenu'), (anchorButton) => bookmarksViewMenu(node, { anchor: anchorButton }));
  more.setAttribute('aria-haspopup', 'menu');
  let pick = null;
  if (!node.fixed) {
    pick = makeElement('button', 'bookmarks-view-pick' + (picked ? ' on' : ''), null, 'bookmarks-view-pick');
    pick.type = 'button';
    pick.setAttribute('role', 'checkbox');
    pick.setAttribute('aria-checked', String(picked));
    pick.setAttribute('aria-label', translate('bookmarksViewSelect'));
    pick.append(svgOf(ICON.check));
    pick.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) bookmarksViewPick(node.id, { range: event.shiftKey }); });
  }
  if (!node.url) {
    row.setAttribute('aria-expanded', String(open));
    const chevron = makeElement('span', 'bookmarks-view-chevron', null, 'bookmarks-view-chevron');
    chevron.append(svgOf(ICON.chevron));
    const folderIcon = makeElement('span', 'bookmarks-view-folder', null, 'bookmarks-view-folder-icon');
    folderIcon.append(svgOf(ICON[node.archive ? 'archive' : 'folder']));
    row.append(...[chevron, pick, folderIcon].filter(Boolean), titleElement, makeElement('span', 'tag', translate('bookmarksViewItems', { count: node.kids.length }), 'bookmarks-view-count'));
    if (node.archive) row.append(makeElement('span', 'tag snooze', translate('bookmarksViewArchiveTag'), 'bookmarks-view-archive-tag'));
    actionsRow.append(rowAction('bookmarks-view-add-here', 'plus', translate('bookmarksViewAddHere'), () => bookmarksViewEdit(null, { parentId: node.id })));
    if (!node.fixed) actionsRow.append(rowAction('bookmarks-view-rename', 'brush', translate('bookmarksViewRename'), () => bookmarksViewEdit(node)), rowAction('bookmarks-view-delete', 'trash', translate('bookmarksViewDeleteFolder'), () => bookmarksViewDelete([node]), ' delete'));
    actionsRow.append(more);
    row.append(actionsRow);
    row.title = node.archive ? title + '\n' + translate('bookmarksViewArchiveTip') : title;
  } else {
    const entry = bookmarkEntry(node);
    const picture = makeElement('div', 'bookmarks-view-picture', null, 'bookmarks-view-picture');
    const image = makeElement('img', entry.preview && entry.preview.img ? 'shot' : 'favicon', null, entry.preview && entry.preview.img ? 'bookmarks-view-preview' : 'bookmarks-view-favicon');
    image.src = entry.preview && entry.preview.img ? entry.preview.img : favicon(node.url);
    image.alt = '';
    picture.append(image);
    const text = makeElement('div', 'bookmarks-view-text', null, 'bookmarks-view-text');
    const titleRow = makeElement('span', 'bookmarks-view-title-line', null, 'bookmarks-view-title-row');
    titleRow.append(titleElement);
    const duplicateCount = bookmarksViewDuplicateCount(node);
    if (duplicateCount) titleRow.append(makeElement('span', 'tag', translate('bookmarksViewDuplicateTag', { count: duplicateCount }), 'bookmarks-view-duplicate'));
    const subtitle = makeElement('span', 'bookmarks-view-subtitle', null, 'bookmarks-view-address');
    const site = siteOf(node.url) || node.url;
    subtitle.append(query ? highlight(site, query) : site);
    if (searching) subtitle.append(makeElement('span', 'bookmarks-view-path', ' · ' + bookmarksViewPath(node), 'bookmarks-view-path')); // where it is, the tree being cut down to the matches
    const note = bookmarkNoteOf(node.id);
    const noteLine = makeElement('span', 'bookmarks-view-note', null, 'bookmarks-view-note-text');
    noteLine.append(query && note ? highlight(note, query) : note);
    noteLine.hidden = !note;
    text.append(titleRow, subtitle, noteLine);
    const noteButtonElement = rowAction('quick-note', 'note', translate('noteAdd'), (anchorButton) => bookmarksViewNote(node, anchorButton), ' note');
    paintNote(noteButtonElement, note);
    noteButtonElement.addEventListener('mouseenter', () => noteTip(noteButtonElement));
    noteButtonElement.addEventListener('mouseleave', hideTipSoon);
    actionsRow.append(noteButtonElement, rowAction('quick-big', 'expand', translate('historyBig'), () => openBig(bookmarkEntry(node))), rowAction('bookmarks-view-edit', 'brush', translate('bookmarksViewEdit'), () => bookmarksViewEdit(node)),
      rowAction('bookmarks-view-delete', 'trash', translate('bookmarksViewDelete'), () => bookmarksViewDelete([node]), ' delete'), more);
    row.append(pick, picture, text, actionsRow);
    row.title = translate('bookmarksViewOpenTip', { title }) + '\n' + entry.info.join('\n');
    if (i >= BOOKMARKS_VIEW_EAGER && bookmarksViewObserver) bookmarksViewObserver.observe(row);
  }
  mouseOnly(row);
  row.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!pointerAllowed()) return;
    bookmarksView.currentId = node.id;
    if ((event.ctrlKey || event.metaKey) && !node.fixed) return bookmarksViewPick(node.id);
    if (event.shiftKey && bookmarksView.picked.size && !node.fixed) return bookmarksViewPick(node.id, { range: true });
    if (!node.url) return bookmarksViewToggle(node.id);
    if (event.shiftKey) { bookmarksViewSelect(i, false); return openBig(bookmarkEntry(node)); }
    openPage(node.url);
  });
  onMiddleClick(row, () => { if (node.url) historyBehind(bookmarkEntry(node).item).catch((error) => toast(translate('actionFailed'), error)); });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!pointerAllowed()) return;
    bookmarksView.currentId = node.id;
    bookmarksViewSelect(i, false);
    bookmarksViewMenu(node, { at: { x: event.clientX, y: event.clientY } });
  });
  if (!node.fixed) bookmarksViewDrag(row, node);
  else if (!node.url) bookmarksViewDrop(row, node);
  return row;
}
// Drag rows to move them: onto a folder (its middle) puts them in it, above or below a row puts them beside it. The
// ticked rows go together when the one dragged is ticked. Undo puts them back.
function bookmarksViewDrag(row, node) {
  row.draggable = true;
  row.addEventListener('dragstart', (event) => {
    const bookmarksView = state.bookmarksView;
    bookmarksView.drag = bookmarksView.picked.has(node.id) ? [...bookmarksView.picked] : [node.id];
    event.dataTransfer.effectAllowed = 'move';
    try { event.dataTransfer.setData('text/plain', node.url || node.title); } catch {}
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => { row.classList.remove('dragging'); document.querySelectorAll('.bookmarks-view-row.drop-before, .bookmarks-view-row.drop-after, .bookmarks-view-row.drop-into').forEach((otherRow) => otherRow.classList.remove('drop-before', 'drop-after', 'drop-into')); if (state.bookmarksView) state.bookmarksView.drag = null; });
  bookmarksViewDrop(row, node);
}
function bookmarksViewDrop(row, node) {
  const where = (event) => {
    const bounds = row.getBoundingClientRect(), y = (event.clientY - bounds.top) / (bounds.height || 1);
    if (!node.url && (node.fixed || (y > 0.25 && y < 0.75))) return 'into';
    return y < 0.5 ? 'before' : 'after';
  };
  const allowed = (position) => {
    const bookmarksView = state.bookmarksView;
    if (!bookmarksView || !bookmarksView.drag) return false;
    const target = position === 'into' ? node : bookmarksView.byId.get(node.parentId);
    if (!target) return false;
    // never into itself or into a folder inside it
    for (let parent = target; parent; parent = bookmarksView.byId.get(parent.parentId)) if (bookmarksView.drag.includes(parent.id)) return false;
    return !bookmarksView.drag.includes(node.id);
  };
  row.addEventListener('dragover', (event) => {
    const position = where(event);
    if (!allowed(position)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    row.classList.toggle('drop-into', position === 'into');
    row.classList.toggle('drop-before', position === 'before');
    row.classList.toggle('drop-after', position === 'after');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-into'));
  row.addEventListener('drop', (event) => {
    const position = where(event);
    row.classList.remove('drop-before', 'drop-after', 'drop-into');
    const bookmarksView = state.bookmarksView;
    if (!allowed(position)) return;
    event.preventDefault();
    const ids = bookmarksView.drag;
    bookmarksView.drag = null;
    const parent = position === 'into' ? node : bookmarksView.byId.get(node.parentId);
    const index = position === 'into' ? parent.kids.length : parent.kids.indexOf(node.id) + (position === 'after' ? 1 : 0);
    if (position === 'into') bookmarksView.open.add(parent.id);
    bookmarksViewMove(ids.map((id) => bookmarksView.byId.get(id)).filter(Boolean), parent.id, index).catch((error) => toast(translate('bookmarksViewError'), error));
  });
}
// Where each node is now (its folder, its place): what Undo of a move puts back.
const bookmarksViewPlace = (node) => { const parent = state.bookmarksView.byId.get(node.parentId); return { id: node.id, parentId: node.parentId, index: parent ? parent.kids.indexOf(node.id) : 0 }; };
// Put places back (in order, so each lands where it was).
async function bookmarksViewUnmove(places) {
  for (const place of [...places].sort((firstPlace, secondPlace) => firstPlace.index - secondPlace.index)) await chrome.bookmarks.move(place.id, { parentId: place.parentId, index: place.index }).catch(() => {});
  await reloadBookmarks();
}
// Move nodes into a folder at `index` (Chrome's meaning: as if put before the node now there), in their order.
async function bookmarksViewMove(nodes, parentId, index = null) {
  const bookmarksView = state.bookmarksView;
  nodes = nodes.filter((node) => node && !node.fixed);
  const ids = new Set(nodes.map((node) => node.id));
  nodes = nodes.filter((node) => { for (let parent = bookmarksView.byId.get(node.parentId); parent; parent = bookmarksView.byId.get(parent.parentId)) if (ids.has(parent.id)) return false; return true; });
  if (!nodes.length) return;
  const places = nodes.map(bookmarksViewPlace);
  let at = index;
  for (const node of nodes) {
    if (at === null) await chrome.bookmarks.move(node.id, { parentId });
    else {
      const previousPlace = bookmarksViewPlace(node);
      await chrome.bookmarks.move(node.id, { parentId, index: at });
      // the next goes after it: one further on, unless this one was before `at` in the same folder (its place freed)
      if (!(previousPlace.parentId === parentId && previousPlace.index < at)) at++;
      await reloadBookmarks();
    }
  }
  bookmarksView.currentId = nodes[0].id;
  for (let parent = bookmarksView.byId.get(parentId); parent; parent = bookmarksView.byId.get(parent.parentId)) bookmarksView.open.add(parent.id);
  await reloadBookmarks();
  bookmarksViewRemember();
  toast(translate('bookmarksViewMoved', { count: nodes.length }), null, { label: translate('undo'), run: () => bookmarksViewUnmove(places) });
}
// "Move to…": the picked rows into the folder chosen in a dialog.
async function bookmarksViewMoveDialog(nodes) {
  const bookmarksView = state.bookmarksView;
  nodes = nodes.filter((node) => node && !node.fixed);
  if (!nodes.length) return;
  const tree = await chrome.bookmarks.getTree();
  const inside = (id) => { for (let parent = bookmarksView.byId.get(id); parent; parent = bookmarksView.byId.get(parent.parentId)) if (nodes.some((node) => node.id === parent.id)) return true; return false; };
  const folders = markFolders(tree).filter((folder) => !inside(folder.id));
  const box = makeElement('form', 'bookmark-form', null, 'bookmarks-view-move-form');
  const heading = makeElement('h3', '', translate('bookmarksViewMoveTitle', { count: nodes.length }), 'dialog-title');
  heading.id = 'dlg-title';
  const folderField = folderSelect(folders, bookmarksView.byId.get(nodes[0].parentId) ? nodes[0].parentId : '', 'bookmarks-view-move-folder');
  const row = makeElement('div', 'row', null, 'bookmarks-view-move-buttons');
  const ok = makeElement('button', 'button primary', translate('bookmarksViewMoveSelect'), 'bookmarks-view-move-save');
  ok.type = 'submit';
  row.append(makeElement('span', 'grow', null, 'bookmarks-view-move-spacer'), button('bookmarks-view-move-cancel', translate('cancel'), 'quiet', closeDialog), ok);
  box.append(heading, folderField.label, folderField.select, row);
  box.addEventListener('submit', (event) => { event.preventDefault(); if (!pointerAllowed()) return; closeDialog(); bookmarksView.picked.clear(); bookmarksViewMove(nodes, folderField.select.value).catch((error) => toast(translate('bookmarksViewError'), error)); });
  showDialog('bookmark-edit', [box]);
  fancySelect(folderField.select);
  ok.focus({ preventScroll: true });
}
// A select of folders (their paths): { label, select }.
function folderSelect(folders, value, testid) {
  const label = makeElement('label', 'bookmark-label', translate('bookmarksViewFolder'), testid + '-label');
  const select = makeElement('select', '', null, testid);
  select.id = 'f-' + testid;
  label.htmlFor = select.id;
  select.setAttribute('aria-label', translate('bookmarksViewFolder'));
  for (const folder of folders) { const option = makeElement('option', '', folder.path, testid + '-option'); option.value = folder.id; select.append(option); }
  select.value = folders.some((folder) => folder.id === value) ? value : (folders.find((folder) => folder.other) || folders[0] || {}).id || '';
  return { label, select };
}
function bookmarksViewSelect(i, scroll = true) {
  const bookmarksView = state.bookmarksView;
  if (!bookmarksView) return;
  const rows = [...bookmarksView.tree.children];
  if (!rows.length) { bookmarksView.find.removeAttribute('aria-activedescendant'); return; }
  bookmarksView.current = Math.max(0, Math.min(rows.length - 1, i));
  bookmarksView.currentId = bookmarksView.rows[bookmarksView.current].n.id;
  rows.forEach((row, index) => row.setAttribute('aria-selected', String(index === bookmarksView.current)));
  bookmarksView.tree.setAttribute('aria-activedescendant', rows[bookmarksView.current].id);
  bookmarksView.find.setAttribute('aria-activedescendant', rows[bookmarksView.current].id);
  if (scroll) rows[bookmarksView.current].scrollIntoView({ block: 'nearest' });
  clearTimeout(bookmarksView.saveTimer);
  bookmarksView.saveTimer = setTimeout(() => { if (state.bookmarksView === bookmarksView && bookmarksView.back.isConnected) bookmarksViewRemember(); }, 400);
}
// What comes back next time: the open folders and the selected row.
function bookmarksViewRemember() {
  const bookmarksView = state.bookmarksView;
  if (!bookmarksView) return;
  updateView({ bookmarksViewOpen: [...bookmarksView.open].slice(-500), bookmarksViewSelected: bookmarksView.currentId || '' }).catch(() => {});
}
function bookmarksViewToggle(id, open = null) {
  const bookmarksView = state.bookmarksView;
  if (bookmarksView.query.trim() || bookmarksView.filter) return; // searching, every folder with a match is open
  const on = open === null ? !bookmarksView.open.has(id) : open;
  if (on) bookmarksView.open.add(id); else bookmarksView.open.delete(id);
  bookmarksView.currentId = id;
  drawBookmarks();
  bookmarksViewRemember();
}
// "*": every folder beside the selected row opens (the ARIA tree's own key).
function bookmarksViewOpenSiblings() {
  const bookmarksView = state.bookmarksView;
  const row = bookmarksView.rows[bookmarksView.current];
  if (!row || bookmarksView.query.trim() || bookmarksView.filter) return;
  const parent = bookmarksView.byId.get(row.n.parentId);
  const siblings = parent ? parent.kids : bookmarksView.tops;
  siblings.forEach((id) => { const sibling = bookmarksView.byId.get(id); if (sibling && !sibling.url) bookmarksView.open.add(id); });
  drawBookmarks();
  bookmarksViewRemember();
}
// Tick a row, or (`range`) every row from the last one ticked to it; the number is said out loud.
function bookmarksViewPick(id, { range = false } = {}) {
  const bookmarksView = state.bookmarksView;
  const node = bookmarksView.byId.get(id);
  if (!node || node.fixed) return;
  const i = bookmarksView.rows.findIndex((row) => row.n.id === id);
  const anchorIndex = bookmarksView.anchorId ? bookmarksView.rows.findIndex((row) => row.n.id === bookmarksView.anchorId) : -1;
  if (range && anchorIndex >= 0 && i >= 0) {
    const [start, end] = anchorIndex < i ? [anchorIndex, i] : [i, anchorIndex];
    for (let index = start; index <= end; index++) if (!bookmarksView.rows[index].n.fixed) bookmarksView.picked.add(bookmarksView.rows[index].n.id);
  } else if (bookmarksView.picked.has(id)) bookmarksView.picked.delete(id);
  else bookmarksView.picked.add(id);
  bookmarksView.anchorId = id;
  bookmarksView.currentId = id;
  drawBookmarks();
  elements.live.textContent = translate('bookmarksViewSelected', { count: bookmarksView.picked.size });
}
// The folder a new bookmark or folder goes into: the selected folder, or the selected bookmark's; else Other bookmarks.
function bookmarksViewHere() {
  const bookmarksView = state.bookmarksView;
  const row = bookmarksView.rows[bookmarksView.current];
  if (row) return row.n.url ? row.n.parentId : row.n.id;
  return (bookmarksView.tops.map((id) => bookmarksView.byId.get(id)).find((node) => /other/i.test(node.title)) || {}).id || bookmarksView.tops[1] || bookmarksView.tops[0];
}
function closeBookmarks() {
  closePops();
  if (state.bookmarksView) { clearTimeout(state.bookmarksView.saveTimer); state.bookmarksView.find.value = ''; state.bookmarksView.query = ''; }
  bookmarksViewRemember();
  if (bookmarksViewObserver) { bookmarksViewObserver.disconnect(); bookmarksViewObserver = null; }
  document.querySelectorAll('.bookmarks-view').forEach((element) => element.remove());
  state.bookmarksView = null;
  updateInert();
  viewBack(byId('bookmarks-button')).focus({ preventScroll: true });
}
// A bookmark's note: the note card, writing to the bookmark's own notes (not the page's).
function bookmarksViewNote(node, anchor) {
  notePopover(node.url, anchor, {
    label: translate('bookmarksViewNoteTitle'), hint: translate('bookmarksViewNoteHint'), get: () => bookmarkNoteOf(node.id),
    set: async (text) => {
      state.bookmarkNotes = await setBookmarkNote(node.id, text, node.url);
      const row = document.getElementById('bookmarks-view-' + node.id);
      const line = row && row.querySelector('[data-testid="bookmarks-view-note-text"]');
      if (line) { line.textContent = bookmarkNoteOf(node.id); line.hidden = !line.textContent; }
    },
  });
}
// What it takes to put deleted bookmarks back (Undo): each with its place, its note, and a folder's contents.
function bookmarksViewSnapshot(node) {
  const bookmarksView = state.bookmarksView;
  const parent = bookmarksView.byId.get(node.parentId);
  const snap = (entryNode, index) => ({ title: entryNode.title, url: entryNode.url, parentId: entryNode.parentId, index, note: entryNode.url ? bookmarkNoteOf(entryNode.id) : '', kids: entryNode.url ? null : entryNode.kids.map((childId, i) => snap(bookmarksView.byId.get(childId), i)) });
  return snap(node, parent ? parent.kids.indexOf(node.id) : 0);
}
// Delete bookmarks and folders (a folder with all it holds). Ten bookmarks or more ask first. Undo makes them again,
// where they were, notes and all.
async function bookmarksViewDelete(nodes, { asked = false } = {}) {
  const bookmarksView = state.bookmarksView;
  if (!bookmarksView) return;
  nodes = nodes.filter((node) => node && !node.fixed);
  const ids = new Set(nodes.map((node) => node.id));
  nodes = nodes.filter((node) => { for (let parent = bookmarksView.byId.get(node.parentId); parent; parent = bookmarksView.byId.get(parent.parentId)) if (ids.has(parent.id)) return false; return true; }); // (inside a folder that goes too)
  if (!nodes.length) return;
  const marks = nodes.flatMap(bookmarksViewMarksIn);
  const isSingleFolder = nodes.length === 1 && !nodes[0].url;
  if (!asked && marks.length >= BOOKMARKS_VIEW_CONFIRM_DELETE) {
    return confirmDialog({
      title: isSingleFolder ? translate('bookmarksViewDeleteFolderAsk', { name: nodes[0].title || translate('untitled') }) : translate('bookmarksViewDeleteAsk', { count: marks.length }),
      text: translate('bookmarksViewDeleteAskText', { count: marks.length }), testid: 'bookmarks-view-delete-ask',
      actions: [{ label: translate('bookmarksViewDelete'), className: 'danger', testid: 'bookmarks-view-delete-ask-ok', error: translate('bookmarksViewError'), run: () => bookmarksViewDelete(nodes, { asked: true }) }],
    });
  }
  const snaps = nodes.map(bookmarksViewSnapshot);
  const row = bookmarksView.rows.findIndex((row) => ids.has(row.n.id));
  for (const node of nodes) await (node.url ? chrome.bookmarks.remove(node.id) : chrome.bookmarks.removeTree(node.id));
  if (marks.some((mark) => bookmarkNoteOf(mark.id))) state.bookmarkNotes = await putBookmarkNotes(Object.fromEntries(marks.map((mark) => [mark.id, { n: '', u: mark.url }])));
  nodes.forEach((node) => bookmarksView.picked.delete(node.id));
  marks.forEach((mark) => bookmarksView.picked.delete(mark.id));
  bookmarksView.currentId = null;
  bookmarksView.current = Math.max(0, row);
  await reloadBookmarks();
  toast(isSingleFolder ? translate('bookmarksViewFolderDeleted', { name: nodes[0].title || translate('untitled') }) : translate('bookmarksViewDeleted', { count: marks.length }), null, { label: translate('undo'), run: async () => { await bookmarksViewRestore(snaps); await reloadBookmarks(); } });
}
async function bookmarksViewRestore(snaps) {
  const notes = {};
  const make = async (snapshot, parentId, index) => {
    const made = await chrome.bookmarks.create({ parentId, index, title: snapshot.title, ...(snapshot.url ? { url: snapshot.url } : {}) });
    if (snapshot.url && snapshot.note) notes[made.id] = { n: snapshot.note, u: snapshot.url };
    for (const [i, childSnapshot] of (snapshot.kids || []).entries()) await make(childSnapshot, made.id, i);
  };
  for (const snapshot of [...snaps].sort((firstSnapshot, secondSnapshot) => firstSnapshot.index - secondSnapshot.index)) await make(snapshot, snapshot.parentId, snapshot.index);
  if (Object.keys(notes).length) state.bookmarkNotes = await putBookmarkNotes(notes);
}
// An address as typed ("example.com"): with https:// when it has no scheme; '' when it isn't one.
function webAddress(text) {
  let url = String(text || '').trim();
  if (!url) return '';
  if (!/^[a-z][\w+.-]*:/i.test(url)) url = 'https://' + url;
  try { return new URL(url).href; } catch { return ''; }
}
// Edit a bookmark (name, address, folder, note) or a folder (name, where it is); with no node, add one into
// `parentId` (a new bookmark starts as the page Tabazing was opened over, and says where that page is bookmarked
// already). The note at the bottom has Undo.
async function bookmarksViewEdit(node = null, { parentId = null, folder = false } = {}) {
  const bookmarksView = state.bookmarksView;
  if (!bookmarksView || (node && node.fixed)) return;
  const isFolder = node ? !node.url : folder;
  const tree = await chrome.bookmarks.getTree();
  if (state.done || state.bookmarksView !== bookmarksView) return;
  const inside = (id) => { for (let parent = bookmarksView.byId.get(id); parent; parent = bookmarksView.byId.get(parent.parentId)) if (node && parent.id === node.id) return true; return false; };
  const folders = markFolders(tree).filter((folder) => !(node && !node.url && inside(folder.id)));
  const form = makeElement('form', 'bookmark-form', null, 'bookmarks-view-edit-form');
  const heading = makeElement('h3', '', translate(node ? (isFolder ? 'bookmarksViewRenameTitle' : 'bookmarksViewEditTitle') : (isFolder ? 'bookmarksViewFolderTitle' : 'bookmarksViewAddTitle')), 'dialog-title');
  heading.id = 'dlg-title';
  form.append(heading);
  const field = (testid, label, value, tag = 'input') => {
    const labelElement = makeElement('label', 'bookmark-label', label, testid + '-label');
    const input = makeElement(tag, 'bookmark-input', null, testid);
    input.id = 'f-' + testid;
    labelElement.htmlFor = input.id;
    input.value = value;
    input.maxLength = tag === 'textarea' ? LIMITS.NOTE_MAX : 2000;
    input.spellcheck = tag === 'textarea';
    form.append(labelElement, input);
    return input;
  };
  const page = !node && !isFolder ? sourceTab() : null;
  const usable = page && !isOwnUrl(urlOf(page)) && /^(https?|file|ftp):/i.test(urlOf(page));
  const name = field('bookmarks-view-edit-name', translate('bookmarksViewName'), node ? node.title : usable ? page.title || '' : '');
  const url = isFolder ? null : field('bookmarks-view-edit-url', translate('bookmarksViewUrl'), node ? node.url : usable ? urlOf(page) : '');
  if (url) url.type = 'url';
  const have = makeElement('p', 'note', '', 'bookmarks-view-edit-have');
  have.hidden = true;
  if (url) form.append(have);
  const folderField = folderSelect(folders, node ? node.parentId : parentId, 'bookmarks-view-edit-folder');
  form.append(folderField.label, folderField.select);
  const note = isFolder ? null : field('bookmarks-view-edit-note', translate('bookmarksViewNoteTitle'), node ? bookmarkNoteOf(node.id) : '', 'textarea');
  const errorElement = makeElement('p', 'popover-error', '', 'bookmarks-view-edit-error');
  errorElement.hidden = true;
  const row = makeElement('div', 'row', null, 'bookmarks-view-edit-buttons');
  const save = makeElement('button', 'button primary', translate('bookmarksViewSave'), 'bookmarks-view-edit-save');
  save.type = 'submit';
  row.append(makeElement('span', 'grow', null, 'bookmarks-view-edit-spacer'), button('bookmarks-view-edit-cancel', translate('cancel'), 'quiet', closeDialog), save);
  form.append(errorElement, row);
  // "Already bookmarked in …": the address's other bookmarks, as it is typed
  let haveTimer = null;
  const sayHave = async () => {
    const address = webAddress(url.value);
    const found = address ? (await chrome.bookmarks.search({ url: address }).catch(() => [])).filter((bookmark) => !node || bookmark.id !== node.id) : [];
    if (state.bookmarksView !== bookmarksView) return;
    const where = [...new Set(found.map((bookmark) => { const parent = bookmarksView.byId.get(bookmark.parentId); return parent ? [bookmarksViewPath(parent), parent.title].filter(Boolean).join(' › ') : ''; }).filter(Boolean))];
    have.textContent = where.length ? translate('markHave', { folders: where.join(', ') }) : '';
    have.hidden = !where.length;
  };
  if (url) { url.addEventListener('input', () => { clearTimeout(haveTimer); haveTimer = setTimeout(sayHave, 250); }); sayHave(); }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pointerAllowed()) return;
    const title = name.value.trim();
    const address = url ? (node && url.value.trim() === node.url ? node.url : webAddress(url.value)) : '';
    if (url && !address) { errorElement.textContent = translate('bookmarksViewBadUrl'); errorElement.hidden = false; url.focus(); return; }
    if (isFolder && !title) { name.focus(); return; }
    save.disabled = true;
    try {
      const to = folderField.select.value;
      let id, undo;
      if (node) {
        const before = { title: node.title, url: node.url, note: bookmarkNoteOf(node.id), place: bookmarksViewPlace(node) };
        await chrome.bookmarks.update(node.id, isFolder ? { title } : { title, url: address });
        if (to && to !== node.parentId) await chrome.bookmarks.move(node.id, { parentId: to });
        id = node.id;
        undo = async () => {
          await chrome.bookmarks.update(id, isFolder ? { title: before.title } : { title: before.title, url: before.url });
          if (to !== before.place.parentId) await chrome.bookmarks.move(id, { parentId: before.place.parentId, index: before.place.index });
          if (note) state.bookmarkNotes = await setBookmarkNote(id, before.note, before.url);
          await reloadBookmarks();
        };
      } else {
        const made = await chrome.bookmarks.create({ parentId: to, title: title || (address ? siteOf(address) : ''), ...(isFolder ? {} : { url: address }) });
        id = made.id;
        undo = async () => { await (isFolder ? chrome.bookmarks.removeTree(id) : chrome.bookmarks.remove(id)).catch(() => {}); if (note) state.bookmarkNotes = await setBookmarkNote(id, '', address); await reloadBookmarks(); };
      }
      if (note) state.bookmarkNotes = await setBookmarkNote(id, note.value, address);
      bookmarksView.currentId = id;
      for (let parent = bookmarksView.byId.get(to); parent; parent = bookmarksView.byId.get(parent.parentId)) bookmarksView.open.add(parent.id); // where it went is shown
      if (bookmarksView.query || bookmarksView.filter) { bookmarksView.query = ''; bookmarksView.find.value = ''; bookmarksView.filter = null; }
      closeDialog();
      await reloadBookmarks();
      bookmarksViewSelect(bookmarksView.current);
      bookmarksViewRemember();
      toast(translate(node ? 'bookmarksViewSaved' : isFolder ? 'bookmarksViewFolderMade' : 'bookmarksViewMade'), null, { label: translate('undo'), run: undo });
    } catch (x) { save.disabled = false; toast(translate('bookmarksViewError'), x); }
  });
  showDialog('bookmark-edit', [form]);
  fancySelect(folderField.select);
  name.focus({ preventScroll: true });
  name.select();
}
// A folder's contents in order: by name (folders first, as Chrome sorts) or by when they were added (newest first).
async function bookmarksViewSort(node, by) {
  const bookmarksView = state.bookmarksView;
  const kids = node.kids.map((id) => bookmarksView.byId.get(id));
  const before = kids.map(bookmarksViewPlace);
  const collator = new Intl.Collator(uiLang(), { sensitivity: 'base', numeric: true });
  const sorted = [...kids].sort(by === 'name'
    ? (firstNode, secondNode) => (!firstNode.url !== !secondNode.url ? (firstNode.url ? 1 : -1) : collator.compare(firstNode.title, secondNode.title))
    : (firstNode, secondNode) => (secondNode.dateAdded || 0) - (firstNode.dateAdded || 0));
  for (const [i, childNode] of sorted.entries()) await chrome.bookmarks.move(childNode.id, { parentId: node.id, index: i });
  bookmarksView.open.add(node.id);
  bookmarksView.currentId = node.id;
  await reloadBookmarks();
  toast(translate('bookmarksViewSorted', { name: node.title || translate('untitled') }), null, { label: translate('undo'), run: () => bookmarksViewUnmove(before) });
}
// Ctrl+↑ / Ctrl+↓: the selected row one place up or down in its folder.
async function bookmarksViewNudge(bookmarkNode, direction) {
  const bookmarksView = state.bookmarksView;
  if (!bookmarkNode || bookmarkNode.fixed) return;
  // the folder's order as Chrome has it now (a quick second press can come before the tree is drawn again)
  const [node] = await chrome.bookmarks.get(bookmarkNode.id);
  const kids = await chrome.bookmarks.getChildren(node.parentId);
  const i = kids.findIndex((child) => child.id === bookmarkNode.id), j = i + direction;
  if (i < 0 || j < 0 || j >= kids.length) return;
  await chrome.bookmarks.move(bookmarkNode.id, { parentId: node.parentId, index: direction > 0 ? j + 1 : j }); // (Chrome's index: before the node now there)
  bookmarksView.currentId = bookmarkNode.id;
  await reloadBookmarks();
}
// A bookmark's ⋯ (a right-click, Shift+F10): open it (here, a new window, behind), see it big, copy, star, its note,
// snooze, tick it, edit, delete. A folder's: add a bookmark or a folder in it, open all (here, in a new window, as a tab
// group), sort, tick it, rename, delete; the archive's folder: the Archive view.
function bookmarksViewMenu(node, { anchor = null, at = null } = {}) {
  const bookmarksView = state.bookmarksView;
  const row = document.getElementById('bookmarks-view-' + node.id);
  if (!bookmarksView || !row) return;
  if (at) anchor = row;
  else if (!anchor) anchor = row.querySelector('[data-testid="quick-more"]') || row;
  const items = [];
  const pickItem = () => ({ icon: 'check', label: translate(bookmarksView.picked.has(node.id) ? 'bookmarksViewUnselect' : 'bookmarksViewSelect'), run: () => bookmarksViewPick(node.id) });
  if (node.url) {
    const entry = bookmarkEntry(node), item = entry.item;
    const noteButtonElement = row.querySelector('[data-testid="quick-note"]');
    items.push(
      { icon: 'goto', label: translate('historyOpen'), run: () => openPage(node.url) },
      { icon: 'window', label: translate('historyNewWindow'), error: translate('actionFailed'), run: () => reopenInWindow(item) },
      { icon: 'tab', label: translate('historyBehind'), error: translate('actionFailed'), run: () => historyBehind(item) },
      { icon: 'expand', label: translate('historyBig'), run: () => openBig(entry) },
      null,
      { icon: 'link', label: translate('copyLink'), error: translate('copyFailed'), run: () => copyLinks([{ title: node.title, url: node.url }], 'plain') },
      { icon: 'star', label: translate(isStarred(node.url) ? 'unstar' : 'star'), run: () => star(entry) },
      { icon: 'note', label: translate(bookmarkNoteOf(node.id) ? 'noteEdit' : 'noteAdd'), run: () => bookmarksViewNote(node, noteButtonElement || anchor) },
      { icon: 'clock', label: translate('historySnooze'), error: translate('errorSnooze'), run: () => snoozeMenu([], anchor, (when) => snoozeClosed(item, when)) },
      null,
      pickItem(),
      { icon: 'brush', label: translate('bookmarksViewEdit'), error: translate('bookmarksViewError'), run: () => bookmarksViewEdit(node) },
      { icon: 'trash', label: translate('bookmarksViewDelete'), danger: true, error: translate('bookmarksViewError'), run: () => bookmarksViewDelete([node]) },
    );
  } else {
    const marks = bookmarksViewMarksIn(node).filter((mark) => openable(mark.url));
    if (node.archive) items.push({ icon: 'archive', label: translate('paletteOpenArchive'), error: translate('errorArchiveOpen'), run: () => { closeBookmarks(); return openArchive(); } }, null);
    items.push({ icon: 'plus', label: translate('bookmarksViewAddHere'), error: translate('bookmarksViewError'), run: () => bookmarksViewEdit(null, { parentId: node.id }) },
      { icon: 'folder', label: translate('bookmarksViewFolderHere'), error: translate('bookmarksViewError'), run: () => bookmarksViewEdit(null, { parentId: node.id, folder: true }) });
    if (marks.length) items.push(null,
      { icon: 'tab', label: translate('bookmarksViewOpenAll', { count: marks.length }), error: translate('actionFailed'), run: () => bookmarksViewOpenAll(marks) },
      { icon: 'window', label: translate('bookmarksViewOpenAllWindow'), error: translate('actionFailed'), run: () => bookmarksViewOpenAll(marks, { where: 'window' }) },
      { icon: 'plus', label: translate('bookmarksViewOpenAllGroup'), error: translate('actionFailed'), run: () => bookmarksViewOpenAll(marks, { where: 'group', name: node.title }) });
    if (node.kids.length > 1) items.push(null,
      { icon: 'sort', label: translate('bookmarksViewSortName'), error: translate('bookmarksViewError'), run: () => bookmarksViewSort(node, 'name') },
      { icon: 'clock', label: translate('bookmarksViewSortDate'), error: translate('bookmarksViewError'), run: () => bookmarksViewSort(node, 'date') });
    if (!node.fixed) items.push(null, pickItem(), { icon: 'brush', label: translate('bookmarksViewRename'), error: translate('bookmarksViewError'), run: () => bookmarksViewEdit(node) },
      { icon: 'trash', label: translate('bookmarksViewDeleteFolder'), danger: true, error: translate('bookmarksViewError'), run: () => bookmarksViewDelete([node]) });
  }
  menu(anchor, items, { back: bookmarksView.find, at });
}
// Open bookmarks: behind Tabazing, which stays (they join the open tabs), in a new window, or as a new tab group
// named after the folder. More than 15 at once asks first, and offers the other two ways.
async function bookmarksViewOpenAll(marks, { where = 'here', name = '', asked = false } = {}) {
  marks = marks.filter((mark) => mark && openable(mark.url));
  if (!marks.length) return;
  if (!asked && marks.length > BOOKMARKS_VIEW_CONFIRM) {
    return confirmDialog({
      title: translate('bookmarksViewOpenAsk', { count: marks.length }), text: translate('bookmarksViewOpenAskText'), testid: 'bookmarks-view-open-ask',
      actions: [
        { label: translate('bookmarksViewOpenAllWindow'), testid: 'bookmarks-view-open-ask-window', run: () => bookmarksViewOpenAll(marks, { where: 'window', name, asked: true }) },
        { label: translate('bookmarksViewOpenAllGroup'), testid: 'bookmarks-view-open-ask-group', run: () => bookmarksViewOpenAll(marks, { where: 'group', name, asked: true }) },
        { label: translate('bookmarksViewOpenAsk', { count: marks.length }), className: 'primary', testid: 'bookmarks-view-open-ask-ok', run: () => bookmarksViewOpenAll(marks, { where, name, asked: true }) },
      ],
    });
  }
  if (where === 'window') {
    await chrome.windows.create({ url: marks.map((mark) => mark.url), focused: false });
  } else {
    const ids = [];
    for (const mark of marks) ids.push((await chrome.tabs.create({ url: mark.url, windowId: CONTEXT.sourceWindow, active: false })).id);
    if (where === 'group' && chrome.tabGroups) {
      const group = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: CONTEXT.sourceWindow } });
      await chrome.tabGroups.update(group, { title: name || '' }).catch(() => {});
    }
  }
  if (state.bookmarksView) { state.bookmarksView.picked.clear(); drawBookmarks(); }
  toast(where === 'window' ? translate('bookmarksViewOpenedWindow', { count: marks.length }) : translate('openedCount', { count: marks.length }));
  await reload();
}
// Stars are Tabazing's own (on this computer); bookmarks are Chrome's (they sync). "Bookmark stars": every starred page
// not bookmarked yet, into a "Tabazing stars" folder in Other bookmarks. Undo takes the folder out again.
function bookmarksViewStarsToImport() {
  const bookmarksView = state.bookmarksView;
  const have = new Set([...bookmarksView.byId.values()].filter((node) => node.url).map((node) => normalizeUrl(node.url)));
  return Object.values(state.stars || {}).filter((star) => star && star.u && openable(star.u) && !have.has(normalizeUrl(star.u)));
}
async function bookmarksViewImportStars() {
  const bookmarksView = state.bookmarksView;
  const stars = bookmarksViewStarsToImport();
  if (!stars.length) return;
  const other = bookmarksView.tops.map((id) => bookmarksView.byId.get(id)).find((node) => /other/i.test(node.title)) || bookmarksView.byId.get(bookmarksView.tops[bookmarksView.tops.length - 1]);
  const folder = await chrome.bookmarks.create({ parentId: other.id, title: translate('bookmarksViewStarsFolder') });
  for (const star of stars) await chrome.bookmarks.create({ parentId: folder.id, title: star.ti || siteOf(star.u), url: star.u });
  bookmarksView.open.add(other.id);
  bookmarksView.open.add(folder.id);
  bookmarksView.currentId = folder.id;
  await reloadBookmarks();
  toast(translate('bookmarksViewStarsDone', { count: stars.length }), null, { label: translate('undo'), run: async () => { await chrome.bookmarks.removeTree(folder.id).catch(() => {}); await reloadBookmarks(); } });
}
// While the bookmarks are open they have the keyboard (a menu, a small card or a dialog over them keeps its own). The
// search box types, except ↑ ↓ PgUp PgDn (Home / End and ← → while it is empty), Enter, Ctrl+Enter, Ctrl+Space,
// Ctrl+↑ ↓, Shift+F10 and Esc. Out of it, Space shows a bookmark big (opens a folder), Del deletes (the ticked rows, or
// the selected one), F2 edits, * opens every folder beside. Esc empties the box (or the filter), then unticks, then
// closes. Typing anywhere goes to the box.
function bookmarksViewKey(event) {
  const key = event.key, bookmarksView = state.bookmarksView;
  const target = event.target instanceof Element ? event.target : null;
  if (!bookmarksView || (target && target.closest('.menu, .popover'))) return;
  if (MODIFIERS.has(key)) return;
  if (target && target.closest('.bookmarks-view-tools button') && (key === 'Enter' || key === ' ')) return; // the bar's buttons press
  const inBox = target === bookmarksView.find;
  const empty = !bookmarksView.find.value;
  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  const stop = () => { event.preventDefault(); event.stopPropagation(); };
  if (key === 'Escape') {
    stop();
    if (bookmarksView.find.value || bookmarksView.filter) { bookmarksView.find.value = ''; bookmarksView.filter = null; bookmarksViewFind(''); bookmarksView.find.focus({ preventScroll: true }); return; }
    if (bookmarksView.picked.size) { bookmarksView.picked.clear(); drawBookmarks(); return; }
    return closeBookmarks();
  }
  const isNavigationKey = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Enter'].includes(key) || ((key === 'Home' || key === 'End' || key === 'ArrowLeft' || key === 'ArrowRight') && (!inBox || empty))
    || (key === ' ' && ctrlOrMeta) || (key === 'F10' && event.shiftKey) || key === 'ContextMenu' || key === 'F2' || (ctrlOrMeta && key.toLowerCase() === 'a' && (!inBox || empty));
  if (inBox && !isNavigationKey) return; // typing
  if (!inBox && key.length === 1 && key !== ' ' && key !== '*' && !ctrlOrMeta && !event.altKey) { bookmarksView.find.focus({ preventScroll: true }); return; } // typing goes to the box
  stop();
  if (ctrlOrMeta && !event.shiftKey && !event.altKey && event.code === 'KeyZ') { if (!event.repeat) toastUndo(); return; }
  if (key === 'Enter') bookmarksView.flushFind(); // typed just now: the search first, then what it found
  const row = bookmarksView.rows[bookmarksView.current];
  if (ctrlOrMeta && (key === 'ArrowUp' || key === 'ArrowDown')) { if (row && !event.repeat) bookmarksViewNudge(row.n, key === 'ArrowDown' ? 1 : -1).catch((error) => toast(translate('bookmarksViewError'), error)); return; }
  if (key === 'ArrowDown' || key === 'ArrowUp') return bookmarksViewSelect(bookmarksView.current + (key === 'ArrowDown' ? 1 : -1));
  if (key === 'PageDown' || key === 'PageUp') return bookmarksViewSelect(bookmarksView.current + (key === 'PageDown' ? 10 : -10));
  if (key === 'Home') return bookmarksViewSelect(0);
  if (key === 'End') return bookmarksViewSelect(bookmarksView.rows.length - 1);
  if (ctrlOrMeta && key.toLowerCase() === 'a') { bookmarksView.rows.forEach((x) => { if (!x.n.fixed) bookmarksView.picked.add(x.n.id); }); drawBookmarks(); elements.live.textContent = translate('bookmarksViewSelected', { count: bookmarksView.picked.size }); return; }
  if (!row) return;
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    const node = row.n, open = !node.url && (bookmarksView.query.trim() || bookmarksView.filter || bookmarksView.open.has(node.id));
    if (ahead(key) > 0) { if (!node.url && !open) return bookmarksViewToggle(node.id, true); if (!node.url && node.kids.length) return bookmarksViewSelect(bookmarksView.current + 1); return; }
    if (!node.url && open && !bookmarksView.query.trim() && !bookmarksView.filter) return bookmarksViewToggle(node.id, false);
    const up = bookmarksView.rows.findIndex((x) => x.n.id === node.parentId);
    if (up >= 0) bookmarksViewSelect(up);
    return;
  }
  if (key === 'Enter') {
    if (!row.n.url) return bookmarksViewToggle(row.n.id);
    if (!keysAllowed()) return finish('cancel');
    if (ctrlOrMeta) return historyBehind(bookmarkEntry(row.n).item).catch((error) => toast(translate('actionFailed'), error)); // Ctrl+Enter: behind, Tabazing stays
    return openPage(row.n.url);
  }
  if (key === ' ' && ctrlOrMeta) return bookmarksViewPick(row.n.id);
  if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) { if (!event.repeat) bookmarksViewMenu(row.n); return; }
  if (key === 'F2') return bookmarksViewEdit(row.n).catch((error) => toast(translate('bookmarksViewError'), error));
  if (inBox) return;
  if (key === ' ') return row.n.url ? openBig(bookmarkEntry(row.n)) : bookmarksViewToggle(row.n.id);
  if (key === '*') return bookmarksViewOpenSiblings();
  if (key === 'Delete' || (IS_MAC && event.metaKey && key === 'Backspace')) {
    if (event.repeat) return;
    return bookmarksViewDelete(bookmarksView.picked.size ? [...bookmarksView.picked].map((id) => bookmarksView.byId.get(id)) : [row.n]).catch((error) => toast(translate('bookmarksViewError'), error));
  }
}

// The quick buttons on a tab's card (shown on hover): the ones used most, pin,
// snooze, archive and the note, then ⋯ for everything else (its menu). Pin is the contextual fourth: a tab
// that plays sound already has its mute button in the header (the speaker), so a second one here would only
// repeat it, and a silent tab has nothing to mute.
function quickActions(entry) {
  const tab = entry.tab;
  const box = makeElement('div', 'quick', null, 'card-quick-actions');
  const makeButton = (icon, title, action, errorMessage) => {
    const button = makeElement('button', 'quick-button', null, 'quick-' + icon);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.append(svgOf(ICON[icon]));
    button.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) action().catch((x) => toast(errorMessage, x)); });
    return button;
  };
  const pin = makeButton('pin', translate(tab.pinned ? 'tabUnpin' : 'tabPin'), () => togglePin(tab), translate('errorPin'));
  const snooze = makeButton('clock', translate('snoozeThis'), async () => snoozeMenu([tab], snooze), translate('errorSnooze'));
  const archive = makeButton('archive', translate('tabArchiveTip'), () => archiveTabs([tab]), translate('errorArchive'));
  const more = makeButton('more', translate('cardMenu'), async () => cardMenu(entry, { anchor: more }), translate('actionFailed'));
  more.setAttribute('aria-haspopup', 'menu');
  if (tab.pinned) pin.classList.add('on'); // on: like a note button with a note
  box.append(pin, snooze, archive, noteButton(entry), more); // ⋯ last: always in the same place
  return box;
}

// A recently closed card's quick buttons: its note (a closed tab keeps the note of its page) and ⋯ for its menu.
function closedQuick(entry) {
  const box = makeElement('div', 'quick', null, 'card-quick-actions');
  if (entry.item.kind !== 'window') box.append(noteButton(entry));
  const more = makeElement('button', 'quick-button', null, 'quick-more');
  more.type = 'button';
  more.title = translate('cardMenu');
  more.setAttribute('aria-label', translate('cardMenu'));
  more.setAttribute('aria-haspopup', 'menu');
  more.append(svgOf(ICON.more));
  more.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) cardMenu(entry, { anchor: more }); });
  box.append(more);
  return box;
}

// A card's menu: everything its buttons do and more (copy, reload, duplicate, sleep, mute...), plus ticking it.
// For the keyboard on the selected card (Shift+F10 or the menu key), for the mouse from its ⋯ button (`anchor`)
// or a right-click (`at`, the pointer). Each item calls the same function as its button. The focus goes back
// to the search box.
let menuKeyAt = 0; // when the key that opens it was last pressed
function cardMenu(entry = state.entries[state.selected], { anchor = null, at = null } = {}) {
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
  const starItem = () => ({ icon: 'star', label: translate(isStarred(entry.url) ? 'unstar' : 'star'), run: () => star(entry) });
  if (entry.kind === 'tab') {
    const tab = entry.tab;
    const note = card.querySelector('.quick-button.note'); // the note card opens at its button, which shows the note too
    items.push({ icon: 'check', label: translate(state.picked.has(tab.id) ? 'menuUnselect' : 'menuSelect'), run: () => pick(entry) }, starItem(), null);
    items.push({ icon: 'link', label: translate('copyLink'), error: translate('copyFailed'), run: () => copyLinks([tab], 'plain') });
    if (!entry.preview && canCapture(tab) && !state.previewPending.has(tab.id)) items.push({ icon: 'camera', label: translate('capturePreview'), error: translate('captureFailed'), run: () => captureOne(entry) });
    // The menu is about this card's tab: its items say what they do, not to which tab ("Reload", not "Reload this tab").
    items.push({ icon: 'reload', label: translate('tabReload'), error: translate('errorReload'), run: () => reloadTab(tab) }, { icon: 'duplicate', label: translate('tabDuplicate'), error: translate('errorDuplicate'), run: () => duplicateTab(tab) });
    if (!tab.active && !tab.discarded) items.push({ icon: 'moon', label: translate(state.toSleep.has(tab.id) ? 'sleepUndo' : 'sleepThis'), error: translate('errorSleep'), run: () => sleepTabs([tab]) });
    items.push(
      { icon: isMuted(tab) ? 'speaker' : 'muted', label: translate(isMuted(tab) ? 'tabUnmute' : 'tabMute'), error: translate('errorMute'), run: () => toggleMute(tab) },
      { icon: 'pin', label: translate(tab.pinned ? 'tabUnpin' : 'tabPin'), error: translate('errorPin'), run: () => togglePin(tab) },
      { icon: 'clock', label: translate('snoozeThis'), error: translate('errorSnooze'), run: () => snoozeMenu([tab], anchor || card) },
      { icon: 'archive', label: translate('tabArchive'), error: translate('errorArchive'), run: () => archiveTabs([tab]) },
    );
    if (note) items.push({ icon: 'note', label: translate(noteOf(entry.url) ? 'noteEdit' : 'noteAdd'), run: () => notePopover(entry.url, note) });
    items.push({ icon: 'plus', label: translate('groupAddTo'), run: () => groupMenu([tab], anchor || card) });
    if (tab.groupId >= 0 && state.groups.has(tab.groupId)) items.push({ icon: 'tab', label: translate('groupRemoveFrom'), error: translate('actionFailed'), run: () => ungroupTabs([tab]) });
    if (isWorthReopening(entry.url)) items.push({ icon: 'bookmark', label: translate('markMenu'), error: translate('markError'), run: () => bookmarkDialog([pageOf(tab)]) });
    items.push(null, { icon: 'close', label: translate('tabClose'), danger: true, error: translate('errorClose'), run: () => closeTab(entry) });
  } else if (entry.kind === 'group') {
    const tabs = entry.tabs, group = entry.group;
    const allMuted = tabs.every(isMuted);
    items.push(
      { icon: 'goto', label: translate('groupOpen'), run: () => enterGroup(group.id) },
      { icon: 'brush', label: translate('groupEdit'), run: () => editGroup(group, anchor || card) },
      null,
      { icon: 'link', label: translate('actionCopy'), error: translate('copyFailed'), run: () => copyLinks(tabs, 'plain') },
      { icon: 'bookmark', label: translate('markMenu'), error: translate('markError'), run: () => bookmarkDialog(tabs.filter((x) => isWorthReopening(urlOf(x))).map(pageOf), { folder: groupName(group) }) },
      { icon: 'window', label: translate('groupToWindow'), error: translate('errorMove'), run: () => groupToWindow(entry) },
      { icon: 'chevron', label: translate(group.collapsed ? 'groupExpand' : 'groupCollapse'), error: translate('actionFailed'), run: () => collapseGroup(group) },
      { icon: 'moon', label: translate('actionSleep'), error: translate('errorSleep'), run: () => sleepTabs(tabs) },
      { icon: allMuted ? 'speaker' : 'muted', label: translate(allMuted ? 'actionUnmute' : 'actionMute'), error: translate('errorMute'), run: () => muteTabs(tabs) },
      { icon: 'clock', label: translate('actionSnooze'), error: translate('errorSnooze'), run: () => snoozeMenu(tabs, anchor || card) },
      { icon: 'archive', label: translate('actionArchive'), error: translate('errorArchive'), run: () => archiveTabs(tabs) },
      null,
      { icon: 'tab', label: translate('groupUngroup'), error: translate('actionFailed'), run: () => ungroup(entry) },
      { icon: 'close', label: translate('groupClose'), danger: true, error: translate('errorClose'), run: () => closeMany(tabs) },
    );
  } else if (entry.kind === 'closed') {
    const closedItem = entry.item, isWindow = closedItem.kind === 'window';
    const note = card.querySelector('.quick-button.note');
    const pages = closedItem.fields.map(([title, url]) => ({ title: title || '', url }));
    items.push({ icon: 'history', label: translate(isWindow ? 'closedReopenWindow' : 'closedReopen'), run: () => restoreClosed(closedItem) });
    if (!isWindow) items.push({ icon: 'window', label: translate('closedNewWindow'), error: translate('actionFailed'), run: () => reopenInWindow(closedItem) }, { icon: 'tab', label: translate(closedItem.session ? 'closedBackgroundFresh' : 'closedBackground'), error: translate('actionFailed'), run: () => reopenBehind(closedItem) }); // (behind Tabazing it opens afresh: Chrome's restore, with the history, would show it)
    items.push(null, { icon: 'link', label: translate(isWindow ? 'actionCopy' : 'copyLink'), error: translate('copyFailed'), run: () => copyLinks(pages, 'plain') });
    if (!isWindow) items.push(starItem());
    if (note) items.push({ icon: 'note', label: translate(noteOf(closedItem.url) ? 'noteEdit' : 'noteAdd'), run: () => notePopover(closedItem.url, note) });
    items.push({ icon: 'bookmark', label: translate('markMenu'), error: translate('markError'), run: () => bookmarkDialog(pages) });
    if (!isWindow) items.push(
      { icon: 'clock', label: translate('closedSnooze'), error: translate('errorSnooze'), run: () => snoozeMenu([], anchor, (at) => snoozeClosed(closedItem, at)) },
      { icon: 'archive', label: translate('tabArchive'), error: translate('errorArchive'), run: () => archiveClosed(closedItem) },
    );
    items.push(null, { icon: 'close', label: translate('closedRemove'), danger: true, run: () => forgetClosed(entry) });
  } else {
    if (!(entry.item && entry.item.kind === 'window')) items.push(starItem());
    if (entry.kind === 'snoozed') items.push({ icon: 'close', label: translate('cancelSnooze'), danger: true, run: () => closeTab(entry) });
  }
  if (items.length) menu(anchor, items, { back: elements.search, at });
}

// ---- a note on a tab (kept by its address, like stars). The button is accent-coloured while there is
// a note and hovering it shows the note; with no note it shows no tooltip at all (not even the card's).
const noteOf = (url) => ((url && state.notes[urlKey(url)]) || {}).n || '';
function paintNote(button, text) {
  button.classList.toggle('on', !!text);
  button.dataset.note = text; // shown by our own tooltip (noteTip), quicker than Chrome's and in Tabazing's style
  button.title = ''; // no Chrome tooltip here, not even the card's
  button.setAttribute('aria-label', text ? translate('noteEdit') + ': ' + text : translate('noteAdd'));
}
function noteButton(entry) {
  const button = makeElement('button', 'quick-button note', null, 'quick-note');
  button.type = 'button';
  button.append(svgOf(ICON.note));
  paintNote(button, noteOf(entry.url));
  button.addEventListener('click', (event) => { event.stopPropagation(); hideTip(); if (pointerAllowed()) notePopover(entry.url, button); });
  button.addEventListener('mouseenter', () => noteTip(button));
  button.addEventListener('focus', () => { if (button.matches(':focus-visible')) noteTip(button); });
  button.addEventListener('mouseleave', hideTipSoon); // a moment to move onto the tooltip itself (it stays while hovered)
  button.addEventListener('blur', hideTip);
  return button;
}

// The note tooltip: shows 150 ms after the pointer reaches a note button that has a note (Chrome's
// own waits about half a second), below the button, or above it when there is no room. It stays while
// the pointer is on it (to read or select a long note), and Esc hides it.
const TIP_DELAY_MILLISECONDS = 150;
const DATE_TIP_DELAY_MILLISECONDS = 500; // the history's "last opened" tag: only when the pointer stays on it
let tipTimer = null;
let tipHide = null;
function noteTip(button) {
  if (document.querySelector('.note-popover')) return;
  showTip(button, translate('noteTitle'), button.dataset.note, 'note-tooltip');
}
// Our tooltip under (or over) `b`, a moment (`delay` ms) after the pointer reaches it: a heading and a text. It stays
// while the pointer is on it. `testid` names its parts (`testid`, -title, -text).
function showTip(anchor, title, text, testid, delay = TIP_DELAY_MILLISECONDS) {
  clearTimeout(tipTimer);
  clearTimeout(tipHide);
  if (!text) return;
  tipTimer = setTimeout(() => {
    if (!anchor.isConnected) return;
    hideTip();
    const tip = makeElement('div', 'tip', null, testid);
    tip.setAttribute('role', 'tooltip');
    tip.append(makeElement('span', 'tip-heading', title, testid + '-title'), makeElement('span', 'tip-text', text, testid + '-text'));
    tip.addEventListener('mouseenter', () => clearTimeout(tipHide));
    tip.addEventListener('mouseleave', hideTipSoon);
    elements.app.append(tip);
    const bounds = anchor.getBoundingClientRect(), tipWidth = tip.offsetWidth, tipHeight = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - tipWidth - 8, bounds.left + bounds.width / 2 - tipWidth / 2)) + 'px';
    const below = bounds.bottom + 8 + tipHeight <= window.innerHeight - 8;
    tip.style.top = (below ? bounds.bottom + 8 : Math.max(8, bounds.top - tipHeight - 8)) + 'px';
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
  tipHide = setTimeout(hideTip, TIP_DELAY_MILLISECONDS);
}
// Click the note button: a small card with a text box opens below it. Closing it (click elsewhere,
// Esc, or the button again) saves what is written; it is also saved while typing, because picking
// a tab closes Tabazing straight away. An empty box removes the note.
// `io`: whose note it is, for a bookmark's (kept by the bookmark: { get, set, label, hint }); else the page's (url).
function notePopover(url, anchor, noteStore = null) {
  if (!noteStore && !canKeep(url)) { closePops(); return toast(translate('urlTooLong')); } // (what was written would be lost)
  const get = noteStore ? noteStore.get : () => noteOf(url);
  const put = noteStore ? noteStore.set : (text) => setNote(url, text).then((notes) => { state.notes = notes; });
  const label = noteStore ? noteStore.label : translate('noteTitle');
  const open = document.querySelector('.note-popover');
  closePops();
  if (open && open.anchor === anchor) return; // the same button again: just close it
  const popover = makeElement('div', 'popover note-popover', null, 'note-popover');
  popover.anchor = anchor;
  // × goes back to what had the focus: its note button (clicked), or the search box (the card's menu).
  const back = document.activeElement && document.activeElement !== document.body ? document.activeElement : elements.search;
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', label);
  const box = makeElement('textarea', '', null, 'note-input');
  box.value = get();
  box.placeholder = translate('notePlaceholder');
  box.maxLength = LIMITS.NOTE_MAX;
  box.setAttribute('aria-label', label);
  // Top right: "Clear" (red; removes the note, the card stays open to write a new one; shown while there is
  // text), then × (closes the card, keeping what was written).
  const clear = makeElement('button', 'note-clear', translate('noteClearButton'), 'note-clear');
  clear.type = 'button';
  clear.title = translate('noteClear');
  clear.hidden = !box.value;
  clear.addEventListener('click', (event) => { event.stopPropagation(); box.value = ''; clear.hidden = true; clearTimeout(timer); save(); box.focus(); });
  const x = makeElement('button', 'note-close', null, 'note-close');
  x.type = 'button';
  x.title = translate('noteCloseButton');
  x.setAttribute('aria-label', translate('noteCloseButton'));
  x.append(svgOf(ICON.close));
  x.addEventListener('click', (event) => { event.stopPropagation(); popover.close(); (back.isConnected ? back : elements.search).focus({ preventScroll: true }); });
  const tools = makeElement('div', 'note-tools', null, 'note-tools');
  tools.append(clear, x);
  popover.append(makeElement('label', '', label, 'note-label'), tools, box, makeElement('p', 'popover-fine-print', noteStore ? noteStore.hint : translate('noteHint'), 'note-hint'));
  const save = () => put(box.value).then(() => paintNote(anchor, get())).catch(() => {});
  let timer = null;
  box.addEventListener('input', () => { clear.hidden = !box.value; clearTimeout(timer); timer = setTimeout(save, 400); });
  const outside = (event) => { if (!popover.contains(event.target) && event.target !== anchor && !anchor.contains(event.target)) popover.close(); };
  popover.close = () => {
    clearTimeout(timer);
    document.removeEventListener('mousedown', outside, true);
    popover.remove();
    save();
  };
  popover.addEventListener('click', (event) => event.stopPropagation());
  popover.addEventListener('keydown', (event) => { if (event.key === 'Escape' && event.target !== box) { event.preventDefault(); popover.close(); (back.isConnected ? back : elements.search).focus({ preventScroll: true }); } });
  elements.app.append(popover);
  dropFrom(popover, anchor.getBoundingClientRect());
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
  const title = (entry.tab ? entry.tab.title : entry.item.title) || hostOf(url) || translate('untitled');
  const back = makeElement('div', 'big-backdrop', null, 'big-preview');
  back.setAttribute('role', 'dialog');
  back.setAttribute('aria-modal', 'true');
  back.setAttribute('aria-label', translate('bigTitle', { title }));
  const box = makeElement('div', 'big-box', null, 'big-preview-box');
  const head = makeElement('div', 'big-head', null, 'big-preview-header');
  const faviconImage = makeElement('img', 'favicon', null, 'big-preview-favicon');
  faviconImage.src = favicon(url);
  faviconImage.alt = '';
  head.append(faviconImage, makeElement('span', 'title', title, 'big-preview-title'), makeElement('span', 'host', siteOf(url), 'big-preview-host'));
  const x = makeElement('button', 'big-close', null, 'big-preview-close');
  x.type = 'button';
  x.append(svgOf(ICON.close));
  x.title = translate('bigClose') + ' (Esc)';
  x.setAttribute('aria-label', translate('bigClose'));
  x.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeBig(); });
  let shot;
  if (!isLite() && entry.preview && entry.preview.img) {
    // The card's small copy at once, then the sharp copy of the same capture as soon as it is read.
    shot = makeElement('img', 'big-shot', null, 'big-preview-image');
    shot.src = entry.preview.img;
    shot.alt = translate('bigTitle', { title });
    getSharpPreview(url).then((preview) => {
      if (!preview || !shot.isConnected) return;
      const sharp = new Image();
      sharp.onload = () => { if (shot.isConnected) shot.src = preview.img; };
      sharp.src = preview.img;
    }).catch(() => {});
  } else {
    shot = makeElement('div', 'big-none', null, 'big-preview-none');
    const image = makeElement('img', '', null, 'big-preview-none-favicon');
    image.src = favicon(url);
    image.alt = '';
    shot.append(image, makeElement('span', '', translate('noPreview'), 'big-preview-none-label'));
    // a page of the history or a bookmark: where it is, when, how often (nothing to capture there)
    if (entry.info) { const information = makeElement('div', 'big-information', null, 'big-preview-information'); for (const line of entry.info) information.append(makeElement('span', '', line, 'big-preview-information-line')); shot.append(information); }
  }
  box.append(head, x, shot);
  box.addEventListener('click', (event) => event.stopPropagation());
  back.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeBig(); });
  back.append(box);
  elements.app.append(back);
  updateInert();
  x.focus({ preventScroll: true });
}
function closeBig() {
  const open = document.querySelectorAll('.big-backdrop');
  open.forEach((node) => node.remove());
  if (open.length) updateInert();
  if (bigEntry) { // the focus back where it was: the history, or the search box
    const was = bigEntry;
    bigEntry = null;
    (was.kind === 'history' && state.historyView && historyOpen() ? state.historyView.find : was.kind === 'bmk' && state.bookmarksView && bookmarksOpen() ? state.bookmarksView.find : elements.search).focus({ preventScroll: true });
  }
}

// While a dialog, Settings, the archive, a big preview or the command palette is open, the rest of the switcher is
// inert: Tab, clicks and screen readers stay in it. Not the toast (its Undo works over the archive), the live
// regions, or a select's list (a menu: Settings opens them over itself).
function updateInert() {
  const top = document.querySelector('#app > .big-backdrop') || (!elements.modal.hidden && elements.modal) || (drawerOpen() && elements.drawerBack) || document.querySelector('#app > .backup-view') || document.querySelector('#app > .settings-back')
    || document.querySelector('#app > .bookmarks-view') || document.querySelector('#app > .history') || document.querySelector('#app > .archive-dialog') || (state.palette && elements.palette);
  for (const child of elements.app.children) child.toggleAttribute('inert', !!top && child !== top && child !== elements.toast && !child.classList.contains('live') && !child.classList.contains('menu') && !child.classList.contains('popover'));
}

// Tab moves through the controls of the top layer (a big preview, a dialog, a menu, Settings, a card like a note,
// the archive, else the whole switcher) and wraps around at its ends: past the last one Chrome would move
// the focus out of the page, and losing the focus closes the switcher.
const TABBABLE = 'button, input, select, textarea, a[href], [tabindex]';
function tabbables(root) {
  return [...root.querySelectorAll(TABBABLE)].filter((element) => element.tabIndex >= 0 && !element.disabled && !element.closest('[hidden], [inert]') && (!element.checkVisibility || element.checkVisibility()));
}
function focusLayer() {
  return document.querySelector('#app > .big-backdrop') || (!elements.modal.hidden && elements.modal) || (drawerOpen() && elements.drawerBack) || document.querySelector('#app > .menu') || document.querySelector('#app > .backup-view')
    || document.querySelector('#app > .settings-back') || document.querySelector('#app > .popover') || (state.palette && elements.palette) || document.querySelector('#app > .bookmarks-view') || document.querySelector('#app > .history') || document.querySelector('#app > .archive-dialog') || elements.app;
}
function keepFocusIn(event) {
  const root = focusLayer();
  const list = tabbables(root);
  const i = list.indexOf(document.activeElement);
  const next = !list.length ? null
    : !root.contains(document.activeElement) ? list[0] // the focus is outside the layer: into it
    : event.shiftKey && i === 0 ? list[list.length - 1]
    : !event.shiftKey && i === list.length - 1 ? list[0]
    : undefined; // in the middle: Chrome's own Tab
  if (next !== undefined) event.preventDefault();
  if (next) next.focus();
}

// Close the open menu or card (a note card saves itself as it closes; the ⓘ card gives the focus back to ⓘ).
function closePops() { document.querySelectorAll('.popover, .menu').forEach((x) => (x.close ? x.close() : x.remove())); }

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
function dropFrom(node, bounds, { alignLeft = false, gap = 4, fit = false } = {}) {
  node.classList.remove('up');
  node.style.maxHeight = '';
  const width = node.offsetWidth, windowHeight = window.innerHeight;
  node.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, alignLeft ? bounds.left : bounds.right - width)) + 'px';
  const below = windowHeight - bounds.bottom - gap - 8, above = bounds.top - gap - 8;
  let height = node.offsetHeight;
  const up = height > below && above > below;
  const room = Math.max(0, up ? above : below);
  if (fit && height > room) { node.style.maxHeight = room + 'px'; height = room; }
  node.style.top = (up ? Math.max(8, bounds.top - gap - height) : Math.max(8, Math.min(bounds.bottom + gap, windowHeight - 8 - height))) + 'px';
  node.classList.toggle('up', up);
}

function menu(anchor, items, options = {}) {
  // Its button again while it is open: just close it (a toggle).
  const open = [...document.querySelectorAll('.menu')].find((x) => x.anchor === anchor);
  if (options.keepPops) document.querySelectorAll('.menu').forEach((x) => x.close()); else closePops();
  if (open && !options.at) return; // (a right-click again opens it anew, at the pointer)
  const back = options.back || (anchor.closest('.card') ? elements.search : anchor);
  const menuElement = makeElement('div', 'menu', null, 'menu');
  menuElement.anchor = anchor;
  menuElement.setAttribute('role', 'menu');
  // A press outside closes it; on its own button the click that follows does (above), or it would reopen at once.
  const outside = (event) => { if (!menuElement.contains(event.target) && !anchor.contains(event.target)) menuElement.close(); };
  menuElement.close = (refocus = false) => {
    if (!menuElement.isConnected) return;
    menuElement.remove();
    document.removeEventListener('mousedown', outside, true);
    if (options.onClose) options.onClose();
    if (refocus && back.isConnected) back.focus({ preventScroll: true });
  };
  for (const it of items) {
    if (!it) { menuElement.append(makeElement('hr', '', null, 'menu-separator')); continue; }
    const button = makeElement('button', 'menu-item' + (it.danger ? ' danger' : '') + (it.on ? ' on' : '') + (it.icon ? ' iconed' : ''), it.icon ? null : it.label, 'menu-item');
    // `icon`: a name in ICON, drawn before the label (the label in its own span, so it takes the row's width).
    if (it.icon) button.append(makeElement('span', 'menu-item-icon', null, 'menu-item-icon'), makeElement('span', 'menu-item-label', it.label, 'menu-item-label')), button.firstChild.append(svgOf(ICON[it.icon]));
    button.type = 'button';
    button.setAttribute('role', it.on !== undefined ? 'menuitemradio' : 'menuitem');
    if (it.on !== undefined) { button.setAttribute('aria-checked', String(!!it.on)); if (it.on) button.append(svgOf(ICON.check)); }
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!pointerAllowed()) return;
      menuElement.close(true);
      try { await it.run(); } catch (error) { toast(it.error || translate('actionFailed'), error); }
    });
    menuElement.append(button);
  }
  menuElement.addEventListener('click', (event) => event.stopPropagation());
  menuElement.addEventListener('keydown', (event) => {
    const buttons = [...menuElement.querySelectorAll('.menu-item')];
    const i = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1].focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); menuElement.close(true); }
  });
  elements.app.append(menuElement);
  if (options.width) menuElement.style.width = options.width + 'px';
  // At the pointer (a right-click): from that point, rightwards. Otherwise from its trigger, dropping down.
  if (options.at) dropFrom(menuElement, { left: options.at.x, right: options.at.x, top: options.at.y, bottom: options.at.y }, { alignLeft: true, gap: 2, fit: true });
  else dropFrom(menuElement, anchor.getBoundingClientRect(), { alignLeft: !!options.alignLeft, fit: true });
  setTimeout(() => { if (menuElement.isConnected) document.addEventListener('mousedown', outside, true); }, 0);
  (menuElement.querySelector('.menu-item.on') || menuElement.querySelector('button')).focus({ preventScroll: true });
}

// A themed stand-in for a <select> (Chrome draws a select's list itself, unstyleable): a button showing
// the choice that opens a menu of the options, the current one ticked in the accent colour. The real
// <select> stays, hidden, and still gets the value and the change event, so everything else is unchanged.
function fancySelect(select, { inPop = false } = {}) {
  if (select._fancy) return select._fancy;
  select.classList.add('fancy-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const button = makeElement('button', 'fancy-select', null, 'select-' + (select.dataset.testid || 'button'));
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const label = makeElement('span', 'fancy-select-label', null, 'select-label');
  const chevron = makeElement('span', 'fancy-select-chevron', null, 'select-chevron');
  chevron.append(svgOf(ICON.chevron));
  button.append(label, chevron);
  const sync = () => {
    label.textContent = (select.options[select.selectedIndex] || {}).textContent || '';
    button.setAttribute('aria-label', (select.getAttribute('aria-label') || '') + ': ' + label.textContent);
  };
  const open = () => {
    menu(button, [...select.options].map((option) => ({
      label: option.textContent, on: option.value === select.value,
      run: () => { if (select.value !== option.value) { select.value = option.value; select.dispatchEvent(new Event('change')); } sync(); if (button.isConnected) button.focus({ preventScroll: true }); },
    })), { keepPops: inPop, alignLeft: true, width: Math.max(button.offsetWidth, 190), onClose: () => button.setAttribute('aria-expanded', 'false') });
    button.setAttribute('aria-expanded', String([...document.querySelectorAll('.menu')].some((x) => x.anchor === button)));
  };
  button.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) open(); });
  button.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); } });
  select.after(button);
  sync();
  select._fancy = { sync, button };
  return select._fancy;
}

// ---------------------------------------------------------------- the command palette
// Alt+R from any page (background.js: the 'open-palette' command), or inside Tabazing '>' as the
// first character in the search box, or Ctrl+K (⌘K). A panel at the top centre (html.palette-open: the rest is
// dimmed and inert) with one box and one list, mixing a quick answer (utils/quick.js: sums, conversions,
// colours, time zones, dates), actions (Chrome's and Tabazing's, matched like the search: searchScore on
// their titles and keywords, in this language and in English) and the very results the search dropdown shows
// for the same text (dropdownRows / dropdownRowElement). ↑/↓ move, Enter runs, Shift+Enter runs and stays in the palette, Esc
// goes back to the switcher (or closes Tabazing when the palette was opened straight from the shortcut).
//
// What an action does afterwards (`after`): 'close' gives the page back (it acts on the page or Chrome: reload,
// zoom, media...), 'switcher' shows the switcher (its result, and the Undo of closing tabs, are there), 'stay'
// keeps the palette (copying: the note says it worked). `ui`: it opens something of Tabazing's (Settings, the
// archive...), so the palette goes first. A failure keeps the palette, with a note saying so.
const PALETTE_SOURCES = {
  chrome: { icon: 'globe', label: 'paletteSourceChrome' },
  tab: { icon: 'tab', label: 'paletteSourceTab' },
  tabazing: { icon: 'bolt', label: 'paletteSourceTabazing' },
  quick: { icon: 'calculator', label: 'paletteSourceQuick' },
};
const PALETTE_TYPED_MAX = 8; // actions shown while typing (the search results and the quick answer come with them)
const PALETTE_USEFUL = ['new-tab', 'new-window', 'incognito', 'reopen', 'dupes', 'settings']; // first with nothing typed
// Chrome's own zoom steps (its menu's − and +).
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
let sourceTabInformation = null; // the tab Tabazing was opened over, read when the palette opens before the tabs are
const sourceTab = () => state.tabs.find((x) => x.id === CONTEXT.sourceTab) || sourceTabInformation;
const sourceEntry = (tab) => state.entries.find((entry) => entry.kind === 'tab' && entry.tab.id === tab.id) || { kind: 'tab', key: 't' + tab.id, tab };
const tabName = (tab) => tab.title || siteOf(urlOf(tab)) || translate('untitled');
const isWeb = (tab) => /^(https?|file):/i.test(urlOf(tab));
// Tabs not looked at for a week (Chrome's tab.lastAccessed), that can sleep: "Sleep tabs not used for a week".
const staleTabs = () => state.tabs.filter((x) => !x.active && !x.discarded && x.lastAccessed > 0 && Date.now() - x.lastAccessed >= 7 * DAY_MILLISECONDS && !state.toSleep.has(x.id));
const otherTabs = () => state.tabs.filter((x) => x.windowId === CONTEXT.sourceWindow && x.id !== CONTEXT.sourceTab && !x.pinned);
const chromePage = (url) => () => openPage(url);
const isFullscreen = () => CONTEXT.sourceState === 'fullscreen'; // the window Tabazing was opened from, as it opened

// Every action. `title` and `kw` (words it is also found by) are messages; `when`: offered only then;
// `sub`: a second line (which tab, which page). Each one calls the function its button or menu item calls.
const PALETTE_ACTIONS = [
  // Chrome
  { id: 'new-tab', group: 'chrome', icon: 'plus', after: 'close', title: () => translate('newTab'), keywords: () => translate('paletteKeywordsNewTab'), run: () => openNewTab({ group: state.inGroup }) }, // (in the group view: into it, as the header's)
  { id: 'new-window', group: 'chrome', icon: 'window', after: 'close', title: () => translate('paletteNewWindow'), keywords: () => translate('paletteKeywordsNewWindow'),
    run: async () => { await chrome.windows.create({ focused: true }); finish('switch'); } },
  { id: 'incognito', group: 'chrome', icon: 'incognito', after: 'close', title: () => translate('paletteIncognito'), keywords: () => translate('paletteKeywordsIncognito'), error: () => translate('paletteErrorIncognito'),
    run: async () => { await chrome.windows.create({ incognito: true, focused: true }); finish('switch'); } },
  { id: 'reopen', group: 'chrome', icon: 'history', after: 'close', title: () => translate('paletteReopen'), keywords: () => translate('paletteKeywordsReopen'), error: () => translate('paletteErrorReopen'),
    run: async () => {
      if (CONTEXT.mode === 'window') await chrome.windows.update(CONTEXT.sourceWindow, { focused: true }).catch(() => {});
      await chrome.sessions.restore(); // the most recently closed tab or window, with its history
      finish('restore');
    } },
  { id: 'chrome-settings', group: 'chrome', icon: 'gear', after: 'close', title: () => translate('paletteChromeSettings'), keywords: () => translate('paletteKeywordsChromeSettings'), subtitle: () => 'chrome://settings', run: chromePage('chrome://settings') },
  { id: 'ext-page', group: 'chrome', icon: 'puzzle', after: 'close', title: () => translate('paletteExtensionPage'), keywords: () => translate('paletteKeywordsExtensionPage'), subtitle: () => 'chrome://extensions/?id=' + chrome.runtime.id,
    run: () => openPage('chrome://extensions/?id=' + chrome.runtime.id) },
  { id: 'extensions', group: 'chrome', icon: 'puzzle', after: 'close', title: () => translate('paletteExtensions'), keywords: () => translate('paletteKeywordsExtensions'), subtitle: () => 'chrome://extensions', run: chromePage('chrome://extensions') },
  { id: 'chrome-shortcuts', group: 'chrome', icon: 'keyboard', after: 'close', title: () => translate('paletteChromeShortcuts'), keywords: () => translate('paletteKeywordsChromeShortcuts'), subtitle: () => 'chrome://extensions/shortcuts', run: chromePage('chrome://extensions/shortcuts') },
  { id: 'history', group: 'chrome', icon: 'visited', after: 'close', title: () => translate('paletteHistory'), keywords: () => translate('paletteKeywordsHistory'), subtitle: () => 'chrome://history', run: chromePage('chrome://history') },
  { id: 'downloads', group: 'chrome', icon: 'download', after: 'close', title: () => translate('paletteDownloads'), keywords: () => translate('paletteKeywordsDownloads'), subtitle: () => 'chrome://downloads', run: chromePage('chrome://downloads') },
  { id: 'bookmarks', group: 'chrome', icon: 'bookmark', after: 'close', title: () => translate('paletteBookmarks'), keywords: () => translate('paletteKeywordsBookmarks'), subtitle: () => 'chrome://bookmarks', run: chromePage('chrome://bookmarks') },
  { id: 'clear-data', group: 'chrome', icon: 'eraser', after: 'close', title: () => translate('paletteClearData'), keywords: () => translate('paletteKeywordsClearData'), subtitle: () => 'chrome://settings/clearBrowserData', run: chromePage('chrome://settings/clearBrowserData') },
  { id: 'passwords', group: 'chrome', icon: 'key', after: 'close', title: () => translate('palettePasswords'), keywords: () => translate('paletteKeywordsPasswords'), subtitle: () => 'chrome://password-manager/passwords', run: chromePage('chrome://password-manager/passwords') },
  // The tab Tabazing was opened over
  { id: 'reload', group: 'tab', icon: 'reload', after: 'close', tab: true, title: () => translate('reloadThis'), keywords: () => translate('paletteKeywordsReload'), error: () => translate('errorReload'), run: (tab) => reloadTab(tab) },
  { id: 'duplicate', group: 'tab', icon: 'duplicate', after: 'switcher', tab: true, title: () => translate('duplicateThis'), keywords: () => translate('paletteKeywordsDuplicate'), error: () => translate('errorDuplicate'), run: (tab) => duplicateTab(tab) },
  { id: 'pin', group: 'tab', icon: 'pin', after: 'switcher', tab: true, title: () => translate(sourceTab().pinned ? 'unpinThis' : 'pinThis'), keywords: () => translate('paletteKeywordsPin'), error: () => translate('errorPin'), run: (tab) => togglePin(tab) },
  { id: 'mute', group: 'tab', icon: 'muted', after: 'switcher', tab: true, title: () => translate(isMuted(sourceTab()) ? 'unmuteThis' : 'muteThis'), keywords: () => translate('paletteKeywordsMute'), error: () => translate('errorMute'),
    run: async (tab) => { const mute = !isMuted(tab); await toggleMute(tab); toast(translate(mute ? 'mutedCount' : 'unmutedCount', { count: 1 })); } },
  { id: 'close-tab', group: 'tab', icon: 'close', after: 'switcher', tab: true, title: () => translate('closeTab'), keywords: () => translate('paletteKeywordsCloseTab'), error: () => translate('errorClose'), run: (tab) => closeTab(sourceEntry(tab)) },
  { id: 'close-others', group: 'tab', icon: 'close', after: 'switcher', tab: true, when: () => otherTabs().length > 0, title: () => translate('paletteCloseOthers'), keywords: () => translate('paletteKeywordsCloseOthers'),
    subtitle: () => translate('tabs', { count: otherTabs().length }), error: () => translate('errorClose'), run: () => closeMany(otherTabs()) },
  { id: 'move-window', group: 'tab', icon: 'window', after: 'switcher', tab: true, title: () => translate('paletteMoveWindow'), keywords: () => translate('paletteKeywordsMoveWindow'), error: () => translate('errorMove'), run: (tab) => moveToNewWindow([tab]) },
  { id: 'zoom-in', group: 'tab', icon: 'zoomIn', after: 'close', tab: true, title: () => translate('paletteZoomIn'), keywords: () => translate('paletteKeywordsZoom'), error: () => translate('paletteErrorZoom'), run: (tab) => zoomTab(tab, 1) },
  { id: 'zoom-out', group: 'tab', icon: 'zoomOut', after: 'close', tab: true, title: () => translate('paletteZoomOut'), keywords: () => translate('paletteKeywordsZoom'), error: () => translate('paletteErrorZoom'), run: (tab) => zoomTab(tab, -1) },
  { id: 'zoom-reset', group: 'tab', icon: 'zoom', after: 'close', tab: true, title: () => translate('paletteZoomReset'), keywords: () => translate('paletteKeywordsZoom'), error: () => translate('paletteErrorZoom'), run: (tab) => zoomTab(tab, 0) },
  { id: 'fullscreen', group: 'tab', icon: 'expand', after: 'close', tab: true, title: () => translate(isFullscreen() ? 'paletteFullscreenOff' : 'paletteFullscreenOn'), keywords: () => translate('paletteKeywordsFullscreen'), error: () => translate('paletteErrorFullscreen'), run: toggleFullscreen },
  { id: 'copy-link', group: 'tab', icon: 'link', after: 'stay', tab: true, title: () => translate('copyLink'), keywords: () => translate('paletteKeywordsCopyLink'), error: () => translate('copyFailed'), run: (tab) => copyLinks([tab], 'plain') },
  { id: 'copy-md', group: 'tab', icon: 'markdown', after: 'stay', tab: true, title: () => translate('paletteCopyMarkdown'), keywords: () => translate('paletteKeywordsCopyMarkdown'), error: () => translate('copyFailed'), run: (tab) => copyLinks([tab], 'markdown') },
  { id: 'bookmark', group: 'tab', icon: 'bookmark', opensView: true, tab: true, when: () => isWeb(sourceTab()), title: () => translate('paletteBookmarkThis'), keywords: () => translate('paletteKeywordsBookmark'), error: () => translate('paletteErrorBookmark'), run: (tab) => bookmarkDialog([pageOf(tab)]) },
  // Tabazing
  { id: 'dupes', group: 'tabazing', icon: 'duplicate', after: 'switcher', when: () => duplicates().length > 0, title: () => translate('paletteDuplicates'), keywords: () => translate('paletteKeywordsDuplicates'), subtitle: () => translate('duplicatesButton', { count: duplicates().length }), error: () => translate('errorClose'), run: () => closeDuplicates() },
  { id: 'merge', group: 'tabazing', icon: 'merge', after: 'switcher', when: () => state.otherWindows.length > 0, title: () => translate('mergeAll'), keywords: () => translate('paletteKeywordsMerge'), subtitle: () => translate('mergeCount', { count: state.otherWindows.length }), error: () => translate('errorMerge'), run: () => mergeWindows(state.otherWindows) },
  { id: 'sleep-old', group: 'tabazing', icon: 'moon', after: 'switcher', when: () => staleTabs().length > 0, title: () => translate('paletteSleepOld'), keywords: () => translate('paletteKeywordsSleepOld'), subtitle: () => translate('tabs', { count: staleTabs().length }), error: () => translate('errorSleep'), run: () => sleepTabs(staleTabs()) },
  { id: 'snooze', group: 'tabazing', icon: 'clock', opensView: true, tab: true, when: () => isWorthReopening(urlOf(sourceTab())), title: () => translate('paletteSnooze'), keywords: () => translate('paletteKeywordsSnooze'), error: () => translate('errorSnooze'),
    run: (tab) => { const i = state.entries.findIndex((entry) => entry.kind === 'tab' && entry.tab.id === tab.id); snoozeMenu([tab], (i >= 0 && cardAt(i)) || elements.search); } },
  { id: 'archive', group: 'tabazing', icon: 'archive', after: 'switcher', tab: true, when: () => isWorthReopening(urlOf(sourceTab())), title: () => translate('paletteArchive'), keywords: () => translate('paletteKeywordsArchive'), error: () => translate('errorArchive'), run: (tab) => archiveTabs([tab]) },
  { id: 'leave-group', group: 'tabazing', icon: 'back', after: 'switcher', when: () => state.inGroup !== null, title: () => translate('paletteLeaveGroup'), keywords: () => translate('paletteKeywordsLeaveGroup'),
    subtitle: () => groupName(state.groups.get(state.inGroup)), run: () => leaveGroup() },
  { id: 'open-group', group: 'tabazing', icon: 'goto', opensView: true, when: () => preference('showGroups') && !!sourceGroup() && state.inGroup !== sourceGroup().id, title: () => translate('paletteOpenGroup'), keywords: () => translate('paletteKeywordsGroup'),
    subtitle: () => groupName(sourceGroup()), run: () => enterGroup(sourceGroup().id) },
  { id: 'group-tab', group: 'tab', icon: 'plus', opensView: true, tab: true, title: () => translate('paletteAddToGroup'), keywords: () => translate('paletteKeywordsGroup'), run: (tab) => groupMenu([tab], elements.search) },
  { id: 'ungroup-tab', group: 'tab', icon: 'tab', after: 'switcher', tab: true, when: () => !!sourceGroup(), title: () => translate('paletteRemoveFromGroup'), keywords: () => translate('paletteKeywordsGroup'), error: () => translate('actionFailed'), run: (tab) => ungroupTabs([tab]) },
  { id: 'ungroup-group', group: 'tabazing', icon: 'tab', after: 'switcher', when: () => !!sourceGroup(), title: () => translate('paletteUngroup'), keywords: () => translate('paletteKeywordsGroup'),
    subtitle: () => groupName(sourceGroup()), error: () => translate('actionFailed'), run: () => ungroup(groupEntry(sourceGroup())) },
  { id: 'close-group', group: 'tabazing', icon: 'close', after: 'switcher', when: () => !!sourceGroup(), title: () => translate('paletteCloseGroup'), keywords: () => translate('paletteKeywordsGroup'),
    subtitle: () => groupName(sourceGroup()), error: () => translate('errorClose'), run: () => closeMany(groupEntry(sourceGroup()).tabs) },
  { id: 'open-archive', group: 'tabazing', icon: 'archive', opensView: true, title: () => translate('paletteOpenArchive'), keywords: () => translate('paletteKeywordsOpenArchive'), error: () => translate('errorArchiveOpen'), run: () => openArchive() },
  { id: 'open-history', group: 'tabazing', icon: 'history', opensView: true, when: () => !!chrome.history, title: () => translate('paletteOpenHistory'), keywords: () => translate('paletteKeywordsOpenHistory'), subtitle: () => (IS_MAC ? '⌘Y' : 'Ctrl+H'), error: () => translate('actionFailed'), run: () => openHistory() },
  { id: 'open-bookmarks', group: 'tabazing', icon: 'bookmark', opensView: true, when: () => !!chrome.bookmarks, title: () => translate('paletteOpenBookmarks'), keywords: () => translate('paletteKeywordsOpenBookmarks'), subtitle: () => (IS_MAC ? '⌘⌥B' : 'Ctrl+Shift+O'), error: () => translate('bookmarksViewError'), run: () => openBookmarks() },
  { id: 'settings', group: 'tabazing', icon: 'gear', opensView: true, title: () => translate('paletteSettings'), keywords: () => translate('paletteKeywordsSettings'), run: () => openSettings(elements.menuButton) },
  { id: 'keys', group: 'tabazing', icon: 'keyboard', opensView: true, title: () => translate('keysTitle'), keywords: () => translate('paletteKeywordsKeys'), run: () => openShortcuts() },
  { id: 'theme-dark', group: 'tabazing', icon: 'moon', after: 'switcher', when: () => preference('theme') !== 'dark', title: () => translate('paletteThemeDark'), keywords: () => translate('paletteKeywordsTheme'), run: () => setTheme('dark') },
  { id: 'theme-light', group: 'tabazing', icon: 'sun', after: 'switcher', when: () => preference('theme') !== 'light', title: () => translate('paletteThemeLight'), keywords: () => translate('paletteKeywordsTheme'), run: () => setTheme('light') },
  { id: 'theme-system', group: 'tabazing', icon: 'sun', after: 'switcher', when: () => preference('theme') !== 'system', title: () => translate('paletteThemeSystem'), keywords: () => translate('paletteKeywordsTheme'), run: () => setTheme('system') },
  { id: 'sort-recent', group: 'tabazing', icon: 'sort', after: 'switcher', when: () => state.sort !== 'recent', title: () => translate('paletteSortRecent'), keywords: () => translate('paletteKeywordsSort'), run: () => setSort('recent') },
  { id: 'sort-order', group: 'tabazing', icon: 'sort', after: 'switcher', when: () => state.sort !== 'order', title: () => translate('paletteSortOrder'), keywords: () => translate('paletteKeywordsSort'), run: () => setSort('order') },
  { id: 'sort-name', group: 'tabazing', icon: 'sort', after: 'switcher', when: () => state.sort !== 'name', title: () => translate('paletteSortName'), keywords: () => translate('paletteKeywordsSort'), run: () => setSort('name') },
  { id: 'capture-all', group: 'tabazing', icon: 'camera', after: 'switcher', when: () => state.hostAllowed && missingPreviews().length > 0, title: () => translate('paletteCaptureAll'), keywords: () => translate('paletteKeywordsCapture'),
    subtitle: () => translate('tabs', { count: missingPreviews().length }), error: () => translate('errorCapture'), run: () => captureAll() },
  { id: 'tour', group: 'tabazing', icon: 'bolt', opensView: true, title: () => translate('settingsTour'), keywords: () => translate('paletteKeywordsTour'), run: () => tourStep(0) },
  { id: 'media-toggle', group: 'tabazing', icon: 'play', after: 'close', when: () => !!currentMedia(), title: () => translate(currentMedia().playing ? 'paletteMediaPause' : 'paletteMediaPlay'), keywords: () => translate('paletteKeywordsMedia'),
    subtitle: () => [currentMedia().title, currentMedia().site].filter(Boolean).join(' · '), error: () => translate('mediaFailed'), run: () => playerCommand('toggle') },
  { id: 'media-next', group: 'tabazing', icon: 'next', after: 'close', when: () => !!currentMedia() && currentMedia().canNext, title: () => translate('paletteMediaNext'), keywords: () => translate('paletteKeywordsMedia'),
    subtitle: () => currentMedia().title, error: () => translate('mediaFailed'), run: () => playerCommand('nexttrack') },
  { id: 'media-prev', group: 'tabazing', icon: 'previous', after: 'close', when: () => !!currentMedia() && currentMedia().canPrevious, title: () => translate('paletteMediaPrevious'), keywords: () => translate('paletteKeywordsMedia'),
    subtitle: () => currentMedia().title, error: () => translate('mediaFailed'), run: () => playerCommand('previoustrack') },
];
const PALETTE_BY_ID = new Map(PALETTE_ACTIONS.map((action) => [action.id, action]));
// The actions that can run now: one about the current tab needs that tab (it may still be loading).
const paletteActions = () => PALETTE_ACTIONS.filter((action) => (!action.tab || !!sourceTab()) && (!action.when || action.when()));
// What an action is found by: its title and keywords in the interface language, and in English (so "new tab"
// finds it in every language). The words are scored like the search (searchScore, remembered per field).
function inEnglish(callback) {
  const currentLocale = getLocale();
  if (currentLocale === 'en') return callback();
  setLocale('en');
  try { return callback(); } finally { setLocale(currentLocale); }
}
function actionFields(action) {
  const [title, keywords] = [action.title(), action.keywords()];
  return [title, keywords, ...inEnglish(() => [action.title(), action.keywords()])];
}
// Every row the palette shows for `text`, best first: the quick answer, then actions and search results by
// score (an action first when they score the same), then "Open …" / "Search Google for …" as the dropdown has
// them. With nothing typed: the most useful actions, the recently run ones, then all the rest.
function paletteItems(text) {
  const typed = String(text || '').trim();
  const query = typed.toLowerCase();
  const availableActions = paletteActions();
  if (!query) {
    const rank = (action) => { const usefulIndex = PALETTE_USEFUL.indexOf(action.id); if (usefulIndex >= 0) return usefulIndex; const recentIndex = state.paletteRecent.indexOf(action.id); return recentIndex >= 0 ? 100 + recentIndex : 1000; };
    return availableActions.map((action, i) => ({ kind: 'action', action, recent: !PALETTE_USEFUL.includes(action.id) && state.paletteRecent.includes(action.id), index: i }))
      .sort((x, y) => rank(x.action) - rank(y.action) || x.index - y.index);
  }
  const out = [];
  const result = quick(typed, { lang: uiLang() });
  if (result) out.push(result.kind === 'currency' ? { kind: 'currency' } : { kind: 'quick', result });
  const actions = availableActions.map((action) => ({ kind: 'action', action, score: searchScore(query, ...actionFields(action)) })).filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score).slice(0, PALETTE_TYPED_MAX);
  const rows = dropdownRows(typed);
  const scored = rows.filter((row) => row.kind && row.score > 0);
  const rest = rows.filter((row) => !(row.kind && row.score > 0)); // "Open …", "Search Google for …", and notes
  out.push(...[...actions, ...scored].sort((x, y) => y.score - x.score || (x.kind === 'action' ? 0 : 1) - (y.kind === 'action' ? 0 : 1)), ...rest);
  return out;
}

const PALETTE_ICON = (name, testid) => { const icon = makeElement('span', 'palette-icon', null, testid); icon.append(svgOf(ICON[name])); return icon; };
// An action's row: its icon, title (with "Recent"), where it acts (the source icon), and which tab or page.
function paletteActionRow(it, query, on, id) {
  const action = it.action;
  const row = makeElement('div', 'dropdown-row palette-row' + (on ? ' on' : ''), null, 'palette-row-action');
  row.id = id;
  row.dataset.action = action.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(on));
  const textColumn = makeElement('span', 'dropdown-text', null, 'dropdown-text');
  textColumn.append(dropdownTitleRow(action.title(), PALETTE_SOURCES[action.group], query, 'palette-source-' + action.group, it.recent && makeElement('span', 'dropdown-tag', translate('paletteRecent'), 'palette-recent-tag')));
  const subtitle = action.subtitle ? action.subtitle() : action.tab ? tabName(sourceTab()) : '';
  if (subtitle) textColumn.append(highlightSpan('dropdown-subtitle', subtitle, query));
  row.append(PALETTE_ICON(action.icon, 'palette-action-icon'), textColumn);
  return row;
}
// A quick answer: the result big (a colour's swatch beside it), what it is and the whole expression below,
// and a button that copies the whole expression (the keyboard has Shift+Enter for that).
function paletteQuickRow(result, on, id) {
  const row = makeElement('div', 'dropdown-row palette-row palette-quick' + (on ? ' on' : ''), null, 'palette-row-quick');
  row.id = id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(on));
  let icon;
  if (result.swatch) { icon = makeElement('span', 'palette-icon palette-swatch', null, 'palette-swatch'); icon.style.background = result.swatch; }
  else icon = PALETTE_ICON('calculator', 'palette-quick-icon');
  const value = result.kind === 'days' ? translate('paletteDays', { count: result.count }) : result.value;
  const caption = result.kind === 'calculation' ? translate('paletteQuickCalculation') : result.kind === 'unit' ? translate('paletteQuickUnit') : result.kind === 'base' ? translate('paletteQuickBase')
    : result.kind === 'color' ? translate('paletteQuickColor') : result.kind === 'time' ? translate('paletteQuickTime', { place: result.place }) : translate('paletteQuickDate');
  const textColumn = makeElement('span', 'dropdown-text', null, 'dropdown-text');
  const big = makeElement('span', 'dropdown-title palette-value', value, 'palette-quick-value');
  const detail = [caption, result.expression, ...(result.alts || []), result.offset].filter(Boolean).join(' · ');
  textColumn.append(dropdownTitleRow(big, PALETTE_SOURCES.quick, '', 'palette-source-quick'), makeElement('span', 'dropdown-subtitle', detail, 'palette-quick-expr'));
  const copy = makeElement('button', 'palette-copy', null, 'palette-copy-expr');
  copy.type = 'button';
  copy.title = translate('paletteCopyExpression') + ' (Shift+Enter)';
  copy.setAttribute('aria-label', translate('paletteCopyExpression'));
  copy.append(svgOf(ICON.duplicate));
  copy.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) copyQuick(result, true); });
  row.append(icon, textColumn, copy);
  mouseOnly(row); // an option holds no buttons for the keyboard: Shift+Enter does the same
  row.setAttribute('aria-description', translate('paletteCopyHint'));
  return row;
}
function paletteCurrencyRow(on, id) {
  const row = makeElement('div', 'dropdown-row palette-row palette-off' + (on ? ' on' : ''), null, 'palette-row-currency');
  row.id = id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(on));
  row.setAttribute('aria-disabled', 'true');
  const textColumn = makeElement('span', 'dropdown-text', null, 'dropdown-text');
  textColumn.append(makeElement('span', 'dropdown-title', translate('paletteCurrency'), 'palette-currency-text'), makeElement('span', 'dropdown-subtitle', translate('paletteCurrencyWhy'), 'palette-currency-why'));
  row.append(PALETTE_ICON('calculator', 'palette-quick-icon'), textColumn);
  return row;
}

let paletteFrame = 0;
function renderPalette() {
  const palette = state.palette;
  if (!palette || state.done) return;
  cancelAnimationFrame(paletteFrame);
  paletteFrame = 0;
  const text = elements.paletteInput.value;
  const query = text.trim().toLowerCase();
  const rows = paletteItems(text);
  palette.items = rows.filter((item) => item.kind);
  keepHighlight(palette);
  if (palette.highlighted >= palette.items.length) palette.highlighted = 0;
  let index = -1;
  // The pointer doesn't move the highlight (only ↑ / ↓ do), as in the search's results: a click runs the row.
  const nodes = rows.map((item) => {
    if (!item.kind) return makeElement('div', 'dropdown-note', item.note, 'dropdown-notice');
    const i = ++index, on = i === palette.highlighted, id = 'pal-' + i;
    const row = item.kind === 'action' ? paletteActionRow(item, query, on, id) : item.kind === 'quick' ? paletteQuickRow(item.result, on, id)
      : item.kind === 'currency' ? paletteCurrencyRow(on, id) : dropdownRowElement(item, text.trim(), on, id);
    row.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) paletteRun(item, { shift: event.shiftKey }); });
    return row;
  });
  if (!palette.items.length) nodes.push(makeElement('p', 'palette-none', translate('paletteNothing'), 'palette-empty'));
  elements.paletteList.replaceChildren(...nodes);
  const direct = palette.from === 'shortcut'; // Esc closes Tabazing (else it goes back to the switcher)
  elements.paletteFoot.textContent = translate(direct ? 'paletteFootClose' : 'paletteFootBack');
  paletteHighlight();
}
// Move the highlight without building the list again; the box points screen readers at it.
function paletteHighlight(scroll = true) {
  const palette = state.palette;
  if (!palette) return;
  const rows = [...elements.paletteList.querySelectorAll('.palette-row, .dropdown-row')];
  rows.forEach((x, index) => { x.classList.toggle('on', index === palette.highlighted); x.setAttribute('aria-selected', String(index === palette.highlighted)); });
  const on = rows[palette.highlighted];
  elements.paletteInput.setAttribute('aria-expanded', String(rows.length > 0));
  if (on) elements.paletteInput.setAttribute('aria-activedescendant', on.id); else elements.paletteInput.removeAttribute('aria-activedescendant');
  if (on && scroll) on.scrollIntoView({ block: 'nearest' });
}
function paletteMove(delta) {
  const palette = state.palette;
  const count = palette.items.length;
  if (!count) return;
  palette.highlighted = (((palette.highlighted + delta) % count) + count) % count;
  palette.highlightedKey = rowKey(palette.items[palette.highlighted]);
  paletteHighlight();
}

// Open it. `from`: 'shortcut' (Alt+R: Esc then closes Tabazing) or 'switcher' (Esc goes back to it);
// `text`: what the box starts with; `saved`: the search box's text, put back on the way out.
function openPalette({ from = 'switcher', text = '', saved = elements.search.value } = {}) {
  if (state.done) return;
  if (state.palette) { elements.paletteInput.focus({ preventScroll: true }); elements.paletteInput.select(); return; }
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
  state.palette = { from, saved, highlighted: 0, items: [] };
  state.dropdown.hidden = true;
  renderDropdown();
  document.documentElement.classList.add('palette-open'); // not 'palette': that is the panel's class, and its rule would lay out the whole page
  // From Alt+R it opens on its own: just the dimmed backdrop and the palette, the switcher isn't shown at all.
  document.documentElement.classList.toggle('palette-solo', from === 'shortcut');
  elements.palette.hidden = false;
  elements.paletteInput.value = text;
  updateInert();
  elements.paletteInput.focus({ preventScroll: true });
  elements.paletteInput.setSelectionRange(text.length, text.length);
  if (text.trim()) startSearch(text.trim());
  renderPalette();
  getPaletteRecent().then((recent) => { state.paletteRecent = recent; if (state.palette && !elements.paletteInput.value.trim()) renderPalette(); }).catch(() => {});
  if (!sourceTab() && Number.isInteger(CONTEXT.sourceTab)) chrome.tabs.get(CONTEXT.sourceTab).then((tab) => { sourceTabInformation = tab; renderPalette(); }).catch(() => {});
}
// Back to the switcher, with the search box as it was.
function exitPalette() {
  const palette = state.palette;
  if (!palette) return;
  state.palette = null;
  cancelAnimationFrame(paletteFrame);
  paletteFrame = 0;
  document.documentElement.classList.remove('palette-open', 'palette-solo');
  elements.palette.hidden = true;
  elements.paletteList.replaceChildren();
  elements.paletteInput.value = '';
  elements.paletteInput.removeAttribute('aria-activedescendant');
  updateInert();
  elements.search.value = state.query = palette.saved;
  state.dropdown.hidden = !palette.saved.trim();
  state.dropdown.highlighted = 0;
  state.dropdown.highlightedKey = null;
  flushSearch();
  elements.search.focus({ preventScroll: true });
}
// What a row does: a quick answer is copied, the currency row does nothing, an action runs, a search result
// opens as it would from the dropdown.
async function paletteRun(it, { shift = false } = {}) {
  if (!it || state.done) return;
  if (it.kind === 'currency') return;
  if (it.kind === 'quick') return copyQuick(it.result, shift);
  if (it.kind === 'action') return runAction(it.action, { keep: shift });
  return dropdownActivate(it, elements.paletteInput.value.trim());
}
// Enter: the result; Shift+Enter (or the row's button): the whole expression.
async function copyQuick(result, whole = false) {
  const text = whole ? result.expression : result.copy;
  toast((await copyText(text)) ? translate('paletteCopied', { text }) : translate('copyFailed'));
}
async function runAction(action, { keep = false } = {}) {
  if (state.done) return;
  notePaletteRecent(action.id).then((recent) => { state.paletteRecent = recent; }).catch(() => {});
  const tab = action.tab ? sourceTab() : null;
  if (action.tab && !tab) return;
  if (action.opensView) exitPalette(); // what it opens takes the focus and the top layer
  try { await action.run(tab); } catch (error) { if (!state.done) toast(action.error ? action.error() : translate('actionFailed'), error); return; }
  if (state.done) return;
  const after = action.opensView ? 'switcher' : keep ? 'stay' : action.after;
  if (after === 'close') return finish('cancel');
  if (after === 'switcher') return exitPalette();
  renderPalette(); // stays: titles may have changed (Pin -> Unpin)
}
function paletteKey(event) {
  const key = event.key;
  const palette = state.palette;
  if (MODIFIERS.has(key) || key === 'Shift') return;
  if (paletteFrame && (key === 'Enter' || key.startsWith('Arrow'))) renderPalette(); // act on what was just typed
  if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); return palette.from === 'shortcut' ? finish('cancel') : exitPalette(); }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'KeyK') {
    event.preventDefault();
    if (palette.from === 'shortcut') { elements.paletteInput.focus({ preventScroll: true }); elements.paletteInput.select(); } else exitPalette();
    return;
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') { event.preventDefault(); return paletteMove(key === 'ArrowDown' ? 1 : -1); }
  if (key === 'Enter') {
    event.preventDefault();
    if (event.repeat || event.isComposing) return;
    if (!keysAllowed()) return finish('cancel');
    return paletteRun(palette.items[palette.highlighted], { shift: event.shiftKey });
  }
  if (key === 'Backspace' && !elements.paletteInput.value && palette.from === 'switcher' && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); return exitPalette(); }
  if (event.target !== elements.paletteInput && key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) elements.paletteInput.focus({ preventScroll: true });
}
function onPaletteInput() {
  if (!state.palette) return;
  state.palette.highlighted = 0;
  state.palette.highlightedKey = null;
  startSearch(elements.paletteInput.value.trim());
  if (!paletteFrame) paletteFrame = requestAnimationFrame(() => { paletteFrame = 0; renderPalette(); });
}

// ---- what the palette's actions call that had no function of their own
// Zoom the tab in or out one of Chrome's steps (d = 1 / -1), or back to 100 % (d = 0).
function nextZoom(zoom, direction) {
  if (!direction) return 1;
  const list = direction > 0 ? ZOOMS : [...ZOOMS].reverse();
  return list.find((x) => (direction > 0 ? x > zoom + 0.001 : x < zoom - 0.001)) ?? list[list.length - 1];
}
async function zoomTab(tab, direction) {
  const next = nextZoom(await chrome.tabs.getZoom(tab.id), direction);
  await chrome.tabs.setZoom(tab.id, next);
  toast(translate('paletteZoomed', { level: new Intl.NumberFormat(uiLang(), { style: 'percent' }).format(next) }));
}
// Full screen on or off for the window Tabazing was opened from.
async function toggleFullscreen() {
  const browserWindow = await chrome.windows.get(CONTEXT.sourceWindow);
  await chrome.windows.update(CONTEXT.sourceWindow, { state: browserWindow.state === 'fullscreen' ? 'normal' : 'fullscreen' });
}
// ---------------------------------------------------------------- dialogs
// Two dialogs live in the switcher: the first-run tour and the review prompt. While one is
// open it owns the keyboard (Esc closes it, not the switcher). Neither is shown while Alt is
// still held from the shortcut, so a quick Alt+Q flick is never interrupted.
let asking = false; // a browser permission prompt is open: its focus change must not close us

const keyLabel = (windowsLabel, mac) => makeElement('kbd', '', IS_MAC && mac ? mac : windowsLabel, 'dialog-key');
const paragraph = (...parts) => { const paragraphElement = makeElement('p', '', null, 'dialog-text'); paragraphElement.append(...parts); return paragraphElement; };
const button = (testid, label, className, action) => { const buttonElement = makeElement('button', 'button ' + (className || ''), label, testid); buttonElement.type = 'button'; buttonElement.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) action(); }); return buttonElement; };

let dialogBack = null; // what had the focus before the dialog opened: it gets it back
function showDialog(kind, nodes) {
  if (!state.modal) dialogBack = document.activeElement;
  state.modal = kind;
  elements.dialog.replaceChildren(...nodes);
  elements.modal.hidden = false;
  elements.modal.classList.toggle('tour', kind === 'tour');
  elements.dialog.classList.toggle('manual', kind === 'tour');
  elements.dialog.classList.toggle('bookmark-dialog', kind === 'bookmark' || kind === 'bookmark-edit');
  updateInert();
  const first = elements.dialog.querySelector('textarea, .primary') || elements.dialog.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}
function closeDialog() {
  state.modal = null;
  elements.modal.hidden = true;
  updateInert();
  document.querySelectorAll('.tour-highlight').forEach((element) => element.classList.remove('tour-highlight'));
  document.documentElement.classList.remove('tour-picking');
  const back = dialogBack;
  dialogBack = null;
  (back && back !== document.body && back.isConnected ? back : elements.search).focus({ preventScroll: true });
}
function whenTapMode(callback) {
  const startTime = performance.now();
  const tick = () => {
    if (state.done || state.modal || state.palette || settingsOpen() || elements.search.value) return; // closed, or already busy: don't interrupt
    if (!state.holding) return callback();
    if (performance.now() - startTime < 10000) setTimeout(tick, 150); // Alt still held from the shortcut: wait for the release
  };
  setTimeout(tick, 350);
}

// ---- first-run tour: short cards in the accent colour, each pointing at what it explains.
const keyRows = (...rows) => { const container = makeElement('div', 'keys', null, 'dialog-keys'); rows.forEach(([keys, word]) => { const comboElement = makeElement('span', '', null, 'dialog-keys-combo'); comboElement.append(...keys); container.append(comboElement, makeElement('span', '', word, 'dialog-keys-action')); }); return container; };
const ALT = IS_MAC ? '⌥' : 'Alt+';
const PALETTE_KEY = IS_MAC ? '⌥R' : 'Alt+R'; // the 'open-palette' command's suggested key (manifest.json)

// `when`: shown only if that is on screen. `picking`: the step shows every card's tick box.
const TOUR_ALL = [
  { id: 'switch', title: () => translate('tourSwitchTitle'), highlight: '.card[aria-selected="true"]', body: () => [
    paragraph(translate('tourSwitchBody')),
    keyRows([[keyLabel(ALT + 'Q')], translate('keyPreviousTab')], [[keyLabel(ALT + 'W')], translate('keyNextTab')], [[keyLabel(ALT + 'E')], translate('keyStay')])] },
  { id: 'move', title: () => translate('tour2Title'), highlight: '.card[aria-selected="true"]', body: () => [
    keyRows([[keyLabel('←'), keyLabel('→'), keyLabel('↑'), keyLabel('↓')], translate('keyPick')], [[keyLabel(ALT + '1'), keyLabel('…'), keyLabel(ALT + '9')], translate('keyNumber')], [[keyLabel('Enter')], translate('keyOpen')], [[keyLabel('Space')], translate('keyPreview')],
      [[keyLabel('Del', '⌘⌫')], translate('keyClose')], [[keyLabel('Ctrl+Z', '⌘Z')], translate('keyUndo')], [[keyLabel('Shift+F10')], translate('keyActions')], [[keyLabel('Esc')], translate('keyLeave')]),
    paragraph(translate('tourKeysMore'))] },
  { id: 'search', title: () => translate('tour3Title'), highlight: '.search', body: () => [paragraph(translate('tour3Body')), keyRows([[keyLabel('Ctrl+F', '⌘F')], translate('keySearch')])] },
  { id: 'palette', title: () => translate('tourPaletteTitle'), highlight: '.search', body: () => [paragraph(translate('tourPaletteBody', { key: PALETTE_KEY })), keyRows([[keyLabel('>'), keyLabel('Ctrl+K', '⌘K')], translate('keyPaletteIn')])] },
  { id: 'groups', title: () => translate('tourGroupsTitle'), highlight: '.group-tile', when: () => !!document.querySelector('.group-tile'), body: () => [paragraph(translate('tourGroupsBody'))] },
  { id: 'cards', title: () => translate('tourCardsTitle'), highlight: '.card[aria-selected="true"]', body: () => [paragraph(translate('tourCardsBody')), paragraph(translate('tourCardsMouse', { key: IS_MAC ? '⌘' : 'Ctrl' }))] },
  { id: 'later', title: () => translate('tourLaterTitle'), highlight: '#menu-button', body: () => [paragraph(translate('tourLaterBody'))] },
  { id: 'views', title: () => translate('tourViewsTitle'), highlight: '#menu-button', body: () => [paragraph(translate('tourViewsBody')), keyRows([[keyLabel('Ctrl+H', '⌘Y')], translate('keyHistory')], [[keyLabel('Ctrl+Shift+O', '⌘⌥B')], translate('keyBookmarks')])] },
  { id: 'many', title: () => translate('tourManyTitle'), highlight: '.card[aria-selected="true"] .pick', picking: true, body: () => [paragraph(translate('tourManyBody', { key: IS_MAC ? '⌘' : 'Ctrl' }))] },
  { id: 'sort', title: () => translate('tourSortTitle'), highlight: '.sort-box', body: () => [paragraph(translate('tourSortBody'))] },
  { id: 'windows', title: () => translate('tourWindowTitle'), highlight: '#windows', when: () => !elements.windows.hidden, body: () => [paragraph(translate('tourWindowBody'))] },
  { id: 'player', title: () => translate('tourPlayerTitle'), highlight: '#player', when: () => !elements.player.hidden, body: () => [paragraph(translate('tourPlayerBody'))] },
  { id: 'settings', title: () => translate('tourSettingsTitle'), highlight: '#menu-button', body: () => [paragraph(translate('tourSettingsBody'))] },
];
let TOUR = TOUR_ALL;
let tourAt = 0;
function tourStep(i) {
  if (i === 0) TOUR = TOUR_ALL.filter((x) => !x.when || x.when());
  tourAt = Math.max(0, Math.min(TOUR.length - 1, i));
  const step = TOUR[tourAt];
  const last = tourAt === TOUR.length - 1;
  document.querySelectorAll('.tour-highlight').forEach((element) => element.classList.remove('tour-highlight'));
  document.documentElement.classList.toggle('tour-picking', !!step.picking); // (before the tick box is looked for)
  const selector = typeof step.highlight === 'function' ? step.highlight() : step.highlight;
  const target = selector && document.querySelector(selector);
  if (target) target.classList.add('tour-highlight');
  const row = makeElement('div', 'row', null, 'tour-buttons');
  row.append(makeElement('span', 'step-of', `${tourAt + 1} / ${TOUR.length}`, 'tour-step-of'), makeElement('span', 'grow', null, 'tour-spacer'));
  if (tourAt > 0) row.append(button('tour-back', translate('back'), 'quiet', () => tourStep(tourAt - 1)));
  if (!last) row.append(button('tour-skip', translate('skip'), 'quiet', endTour));
  row.append(button(last ? 'tour-done' : 'tour-next', translate(last ? 'done' : 'next'), 'primary', () => (last ? endTour() : tourStep(tourAt + 1))));
  const title = makeElement('h3', '', step.title(), 'dialog-title');
  title.id = 'dlg-title';
  const stepNumber = makeElement('span', 'num', String(tourAt + 1), 'tour-step-number');
  showDialog('tour', [stepNumber, title, ...step.body(), row]);
  placeTour(target);
}

// The tour card sits next to what it talks about, on the side with the most room, so it covers as
// little of the switcher as it can. With nothing to point at, it sits in the middle.
function placeTour(target) {
  const dialog = elements.dialog;
  dialog.style.left = dialog.style.top = '';
  dialog.removeAttribute('data-side');
  if (!target) return;
  if (target.scrollIntoViewIfNeeded) target.scrollIntoViewIfNeeded(false);
  const bounds = target.getBoundingClientRect(), windowWidth = window.innerWidth, windowHeight = window.innerHeight;
  const dialogWidth = dialog.offsetWidth, dialogHeight = dialog.offsetHeight, gap = 18;
  const room = { right: windowWidth - bounds.right, left: bounds.left, below: windowHeight - bounds.bottom, above: bounds.top };
  // Things along the top strip (the search box, the toolbar) get the card below them; others beside.
  const topStrip = bounds.bottom < 150 && room.below >= dialogHeight + gap;
  const side = topStrip ? 'below' : room.right >= dialogWidth + gap ? 'right' : room.left >= dialogWidth + gap ? 'left' : room.below >= dialogHeight + gap ? 'below' : room.above >= dialogHeight + gap ? 'above' : 'right';
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  let x, y;
  if (side === 'right' || side === 'left') { x = side === 'right' ? bounds.right + gap : bounds.left - gap - dialogWidth; y = clamp(bounds.top + bounds.height / 2 - dialogHeight / 2, 12, windowHeight - dialogHeight - 12); }
  else { y = side === 'below' ? bounds.bottom + gap : bounds.top - gap - dialogHeight; x = clamp(bounds.left + bounds.width / 2 - dialogWidth / 2, 12, windowWidth - dialogWidth - 12); }
  dialog.style.left = clamp(x, 12, windowWidth - dialogWidth - 12) + 'px';
  dialog.style.top = clamp(y, 12, windowHeight - dialogHeight - 12) + 'px';
  dialog.dataset.side = side;
  // the arrow points at the middle of the target
  dialog.style.setProperty('--anchor-x', clamp(bounds.left + bounds.width / 2 - parseFloat(dialog.style.left), 48, dialogWidth - 18) + 'px');
  dialog.style.setProperty('--anchor-y', clamp(bounds.top + bounds.height / 2 - parseFloat(dialog.style.top), 48, dialogHeight - 18) + 'px'); // below the step number in the corner
}
function endTour() {
  updateOnboard({ tour: true, flyout: true }).catch(() => {});
  closeDialog();
}

// ---- "How is Tabazing working for you?": two steps, at most twice (utils/review.js has the timing).
// Same rules for everyone, and every answer still offers the store review. The answer itself stays
// on this computer; the buttons only open pages on the site, where people send what they choose.
const openUrl = async (url) => { try { await chrome.tabs.create({ url, windowId: CONTEXT.sourceWindow, active: true }); } catch {} finish('switch'); };
const reviewDone = () => updateReview((review) => ({ ...review, done: true })).catch(() => {});
const goReview = async () => { await reviewDone(); openUrl(REVIEW_URL); };

function askStep1() {
  const title = makeElement('h3', '', translate('askTitle'), 'dialog-title');
  title.id = 'dlg-title';
  const faces = makeElement('div', 'faces', null, 'ask-moods');
  for (const [label, mood] of [['moodGood', 'good'], ['moodOkay', 'okay'], ['moodBad', 'bad']]) faces.append(button('ask-mood-' + mood, translate(label), '', () => askStep2(mood)));
  const row = makeElement('div', 'row', null, 'ask-buttons');
  row.append(button('ask-dont-ask', translate('dontAsk'), 'quiet', () => { reviewDone(); closeDialog(); }), makeElement('span', 'grow', null, 'ask-spacer'), button('ask-not-now', translate('notNow'), 'quiet', closeDialog));
  showDialog('ask', [title, paragraph(translate('askBody')), faces, row]);
}
function askStep2(mood) {
  const good = mood === 'good';
  const title = makeElement('h3', '', translate(good ? 'askGoodTitle' : 'askBadTitle'), 'dialog-title');
  title.id = 'dlg-title';
  const row = makeElement('div', 'row', null, 'ask-buttons');
  if (good) row.append(button('ask-review', translate('reviewButton'), 'primary', goReview));
  else row.append(button('ask-survey', translate('surveyButton'), 'primary', async () => { await reviewDone(); openUrl(siteUrl('/survey', 'extension-prompt', '&mood=' + mood)); }), button('ask-review', translate('reviewButton'), '', goReview));
  row.append(makeElement('span', 'grow', null, 'ask-spacer'), button('ask-not-now', translate('notNow'), 'quiet', closeDialog));
  showDialog('ask', [title, paragraph(translate(good ? 'askGoodBody' : 'askBadBody')), row, makeElement('p', 'note', translate('askNote'), 'ask-note')]);
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
  const other = tops.find((node) => node.folderType === 'other') || tops.find((node) => node.id === '2');
  const archiveFolder = other && (other.children || []).find((node) => !node.url && node.title === ARCHIVE_FOLDER);
  const walk = (node, depth, path) => {
    if (node.url || node.unmodifiable || (archiveFolder && node.id === archiveFolder.id)) return;
    const title = node.title || translate('untitled');
    out.push({ id: node.id, title, depth, path: [...path, title].join(' › '), other: node === other });
    for (const child of node.children || []) walk(child, depth + 1, [...path, title]);
  };
  tops.forEach((node) => walk(node, 0, []));
  return out;
}
// `folder`: the name "New folder" starts with (a group's).
async function bookmarkDialog(pages, { folder: newName = '' } = {}) {
  if (!chrome.bookmarks) return toast(translate('dropdownNoMarks'));
  pages = pages.filter((page) => page.url && !isOwnUrl(page.url));
  if (!pages.length) return toast(translate('markCant'));
  closePops();
  const [tree, view, have] = await Promise.all([
    chrome.bookmarks.getTree(), getView().catch(() => null),
    pages.length === 1 ? chrome.bookmarks.search({ url: pages[0].url }).catch(() => []) : [],
  ]);
  if (state.done) return;
  let folders = markFolders(tree);
  if (!folders.length) return toast(translate('markError'));
  const byId = (id) => folders.find((folder) => folder.id === id);
  let selectedId = view && byId(view.markFolder) ? view.markFolder : have[0] && byId(have[0].parentId) ? have[0].parentId : (folders.find((folder) => folder.other) || folders[0]).id;
  let shown = folders;

  const form = makeElement('form', 'bookmark-form', null, 'bookmark-form');
  const title = makeElement('h3', '', pages.length === 1 ? translate('markTitle') : translate('markTitleCount', { count: pages.length }), 'dialog-title');
  title.id = 'dlg-title';
  form.append(title);
  let name = null;
  if (pages.length === 1) {
    const nameLabel = makeElement('label', 'bookmark-label', translate('markName'), 'bookmark-name-label');
    nameLabel.htmlFor = 'bookmark-name';
    name = makeElement('input', 'bookmark-input', null, 'bookmark-name');
    name.id = 'bookmark-name';
    name.value = pages[0].title || siteOf(pages[0].url);
    name.maxLength = 500;
    form.append(nameLabel, name);
  } else form.append(paragraph(translate('markPagesNote', { count: pages.length })));
  const folderLabel = makeElement('span', 'bookmark-label', translate('markFolder'), 'bookmark-folder-label');
  folderLabel.id = 'bookmark-folders-heading';
  const find = makeElement('input', 'bookmark-input', null, 'bookmark-find');
  find.type = 'search';
  find.placeholder = translate('markFind');
  find.setAttribute('aria-label', translate('markFindAria'));
  find.setAttribute('aria-controls', 'bookmark-tree');
  find.autocomplete = 'off';
  find.spellcheck = false;
  const list = makeElement('div', 'bookmark-tree', null, 'bookmark-folders');
  list.id = 'bookmark-tree';
  list.tabIndex = 0;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', 'bookmark-folders-heading');
  const none = makeElement('p', 'bookmark-none', translate('markNoFolder'), 'bookmark-no-folder');
  none.hidden = true;
  form.append(folderLabel, find, list, none);
  if (have.length) {
    const where = have.map((bookmark) => (byId(bookmark.parentId) || {}).path).filter(Boolean);
    if (where.length) form.append(makeElement('p', 'note', translate('markHave', { folders: where.join(', ') }), 'bookmark-have'));
  }
  // "New folder": a name box and Create, inside the chosen folder.
  const newRow = makeElement('div', 'bookmark-new', null, 'bookmark-new-row');
  newRow.hidden = true;
  const newBox = makeElement('input', 'bookmark-input', null, 'bookmark-new-name');
  newBox.placeholder = translate('markNewFolderPlaceholder');
  newBox.setAttribute('aria-label', translate('markNewFolderPlaceholder'));
  newBox.maxLength = 200;
  newBox.value = newName;
  newRow.append(newBox, button('bookmark-new-create', translate('markCreate'), 'small', () => makeFolder()));
  form.append(newRow);
  const row = makeElement('div', 'row', null, 'bookmark-buttons');
  const save = makeElement('button', 'button primary', translate('markSave'), 'bookmark-save');
  save.type = 'submit';
  row.append(button('bookmark-new', translate('markNewFolder'), 'quiet', () => { newRow.hidden = false; newBox.focus(); newBox.select(); }),
    makeElement('span', 'grow', null, 'bookmark-spacer'), button('bookmark-cancel', translate('cancel'), 'quiet', closeDialog), save);
  form.append(row);

  // The folders (only those the box finds, with their place), the chosen one marked; it follows the box's first find.
  const draw = () => {
    const query = find.value.trim().toLowerCase();
    shown = query ? folders.filter((folder) => matches(query, folder.title, folder.path)) : folders;
    if (shown.length && !shown.some((folder) => folder.id === selectedId)) selectedId = shown[0].id;
    list.replaceChildren(...shown.map((folder) => {
      const folderRow = makeElement('div', 'bookmark-row' + (folder.id === selectedId ? ' on' : ''), null, 'bookmark-folder');
      folderRow.id = 'bookmark-folder-' + folder.id;
      folderRow.setAttribute('role', 'option');
      folderRow.setAttribute('aria-selected', String(folder.id === selectedId));
      folderRow.style.setProperty('--depth', query ? 0 : folder.depth);
      const icon = makeElement('span', 'bookmark-icon', null, 'bookmark-folder-icon');
      icon.append(svgOf(ICON.folder));
      folderRow.append(icon, makeElement('span', 'bookmark-name', folder.title, 'bookmark-folder-name'));
      if (query && folder.depth) folderRow.append(makeElement('span', 'bookmark-path', folder.path, 'bookmark-folder-path'));
      folderRow.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) { selectedId = folder.id; draw(); } });
      return folderRow;
    }));
    none.hidden = shown.length > 0;
    save.disabled = !shown.length;
    if (shown.length) list.setAttribute('aria-activedescendant', 'bookmark-folder-' + selectedId); else list.removeAttribute('aria-activedescendant');
    const on = list.querySelector('.bookmark-row.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  // ↑/↓ in the box or the list choose the folder above or below; Home / End in the list the first or last.
  const move = (event) => {
    const i = shown.findIndex((folder) => folder.id === selectedId);
    const inList = event.currentTarget === list;
    const j = event.key === 'ArrowDown' ? i + 1 : event.key === 'ArrowUp' ? i - 1 : inList && event.key === 'Home' ? 0 : inList && event.key === 'End' ? shown.length - 1 : null;
    if (j === null || !shown.length) return;
    event.preventDefault();
    selectedId = shown[Math.max(0, Math.min(shown.length - 1, j))].id;
    draw();
  };
  find.addEventListener('input', draw);
  find.addEventListener('keydown', move);
  list.addEventListener('keydown', move);
  newBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); makeFolder(); } });
  async function makeFolder() {
    const label = newBox.value.trim();
    if (!label) return newBox.focus();
    try {
      const newFolder = await chrome.bookmarks.create({ parentId: selectedId, title: label });
      folders = markFolders(await chrome.bookmarks.getTree());
      selectedId = newFolder.id;
      find.value = newBox.value = '';
      newRow.hidden = true;
      draw();
      list.focus({ preventScroll: true });
    } catch (error) { toast(translate('markFolderError'), error); }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const folder = byId(selectedId);
    if (!folder || !pointerAllowed()) return;
    save.disabled = true;
    try {
      const made = [];
      for (const page of pages) {
        const label = (name && name.value.trim()) || page.title || siteOf(page.url) || page.url;
        const there = (await chrome.bookmarks.search({ url: page.url }).catch(() => [])).find((bookmark) => bookmark.parentId === folder.id);
        if (there) { if (there.title !== label) await chrome.bookmarks.update(there.id, { title: label }); }
        else made.push((await chrome.bookmarks.create({ parentId: folder.id, title: label, url: page.url })).id);
      }
      updateView({ markFolder: folder.id }).catch(() => {});
      state.marks = null; // the search reads them again
      closeDialog();
      toast(translate('markSaved', { count: pages.length, folder: folder.title }), null, made.length ? { label: translate('undo'), run: async () => {
        for (const id of made) await chrome.bookmarks.remove(id).catch(() => {});
        state.marks = null;
        toast(translate('markUndone', { count: made.length }));
      } } : undefined);
    } catch (error) { save.disabled = false; toast(translate('markError'), error); }
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
function showAlert(text, label, action, detail = '') {
  elements.alertText.textContent = text;
  elements.liveAlert.textContent = text; // read out from the always-present live region (#alert itself comes and goes)
  elements.alert.title = detail;
  elements.alertButton.hidden = !label;
  elements.alertButton.onclick = label ? (event) => { event.stopPropagation(); if (pointerAllowed()) action(); } : null;
  if (label) elements.alertButton.textContent = label;
  elements.alert.hidden = false;
  setTop();
}
async function requestHostAccess() {
  asking = true;
  let ok = false;
  try { ok = await chrome.permissions.request({ origins: ['<all_urls>'] }); } catch {}
  asking = false;
  window.focus();
  if (!ok || state.done) return;
  showAlert(translate('hostThanks'));
  setTimeout(() => { if (!state.done) { elements.alert.hidden = true; elements.liveAlert.textContent = ''; render(); } }, 3500);
}
// Tabs the current view shows (window, star filter, search) that have no preview yet.
function missingPreviews() {
  return state.sections.flatMap((x) => x.entries).flatMap((entry) => (entry.kind === 'group' ? entry.tabs : [entry.tab]))
    .filter((x) => !x.active && canCapture(x) && !state.previews[x.id] && !state.previewPending.has(x.id));
}
// "Capture all": a small camera with how many cards have no preview; its tooltip and label say the rest.
function updateSweepButton() {
  const count = missingPreviews().length;
  const max = LIMITS.SWEEP_MAX_TABS;
  const scoped = state.scope !== 'all' || state.starOnly || state.query;
  elements.sweepButton.hidden = !state.hostAllowed || count === 0 || isLite();
  const label = count > max ? translate('sweepFirst', { count, max }) : translate(scoped ? 'sweepThese' : 'sweepAll', { count });
  elements.sweepText.textContent = String(count);
  elements.sweepButton.setAttribute('aria-label', label);
  elements.sweepButton.title = label + '\n' + translate(scoped ? 'sweepTitleThese' : 'sweepTitleAll') + (count > max ? ' ' + translate('sweepTitleMaximum', { max }) : '') + ' ' + translate('sweepTitleOne');
}
// Chrome's error text for a failed screenshot, in plain words (null = not worth mentioning).
function plainCaptureError(message) {
  const text = String(message || '');
  if (/MAX_CAPTURE|quota|per second/i.test(text)) return null; // we just went too fast: it retries by itself
  if (/invoked|activeTab|permission|host/i.test(text)) return { text: translate('captureErrorHost'), fix: true };
  if (/chrome:|extensions gallery|cannot access/i.test(text)) return { text: translate('captureErrorPage') };
  return { text: translate('captureErrorOther') };
}
const ICON_TIPS = 3; // times the toolbar-icon tip shows (prefs.iconTips counts them)
async function healthCheck() {
  try { state.hostAllowed = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch { state.hostAllowed = true; }
  // Alt+Q itself can be left unassigned by Chrome (another app or extension owns it): say so, with the fix.
  let shortcut = 'assigned';
  try { const command = (await chrome.commands.getAll()).find((x) => x.name === 'open-switcher'); if (command && !command.shortcut) shortcut = 'missing'; } catch {}
  if (shortcut === 'missing') return showAlert(translate('shortcutMissing'), translate('settingsShortcut'), () => openUrl(SHORTCUTS_URL));
  // Opened with the toolbar icon: the tip about Alt+Q, the first few times only (it has made its point by then).
  if (CONTEXT.via === 'icon' && preference('iconTips') < ICON_TIPS) {
    toast(translate('iconTip', { key: IS_MAC ? 'Option+Q' : 'Alt+Q' }));
    const iconTips = preference('iconTips') + 1;
    state.preferences = { ...(state.preferences || PREFERENCES_FALLBACK), iconTips };
    updatePreferences({ iconTips }).catch(() => {});
  }
  if (!state.hostAllowed) showAlert(translate('hostBlocked'), translate('hostAllow'), requestHostAccess, translate('hostBlockedTip'));
  else {
    const currentEntry = state.entries.find((entry) => entry.kind === 'tab' && entry.tab.id === CONTEXT.sourceTab);
    if (currentEntry && !currentEntry.preview && /^https?:/.test(urlOf(currentEntry.tab))) {
      const note = await getCaptureNote().catch(() => null);
      const say = note && note.stage === 'error' && Date.now() - note.t < 120000 ? plainCaptureError(note.message) : null;
      if (say) showAlert(say.text, say.fix ? translate('hostAllow') : '', requestHostAccess, `${note.host || translate('thisPage')}: ${note.message}`);
    }
  }
  updateSweepButton();
}

// ---- the theme (Settings): html.light switches the colours (switcher.css). "System" (the default) follows the
// OS and changes with it.
const lightMediaQuery = matchMedia('(prefers-color-scheme: light)');
let themePreference = 'system';
// Lite mode on the page: html.lite turns off the animations and the shadows (switcher.css).
function applyLite(on = isLite()) { document.documentElement.classList.toggle('lite', on); }
function applyTheme(value) {
  themePreference = ['light', 'dark'].includes(value) ? value : 'system';
  document.documentElement.classList.toggle('light', themePreference === 'light' || (themePreference === 'system' && lightMediaQuery.matches));
}
lightMediaQuery.addEventListener('change', () => applyTheme(themePreference));
// Settings -> Theme (or the palette): apply, keep, and tell the page hosting the overlay, whose shade follows it.
function setTheme(value) {
  applyTheme(value);
  state.preferences = { ...(state.preferences || PREFERENCES_FALLBACK), theme: themePreference };
  updatePreferences({ theme: themePreference }).catch(() => {});
  if (CONTEXT.mode === 'overlay') parent.postMessage({ tabazing: FRAME_MESSAGE.READY, light: document.documentElement.classList.contains('light') }, '*'); // the page's shade
}
// Settings -> Title lines: two lines of title on the default-size cards (html.lines2), else one.
function applyLines() {
  document.documentElement.classList.toggle('lines2', preference('titleLines') === 2);
}
// The search box says what it searches (Settings can leave out history and bookmarks).
function searchPlaceholder() {
  const includeHistory = preference('searchHistory'), marks = preference('searchBookmarks');
  elements.search.placeholder = translate(includeHistory && marks ? 'searchPlaceholder' : includeHistory ? 'searchPlaceholderNoMarks' : marks ? 'searchPlaceholderNoHistory' : 'searchPlaceholderTabs');
}

// ---- Settings (the gear at the left of the header): a dialog over the switcher, which is inert meanwhile. A header
// (the title, its ×), the categories as tabs down the left (a row above the content in a narrow window) and the
// chosen category's controls, which scroll inside. The last category opened is remembered (view.settingsTab).
// Esc, ×, a click on the dimmed backdrop or the gear again (openSettings while open) close it; the focus goes back
// to the gear. Every control saves at once (prefs); a new language redraws it open, on the same category.
const SETTINGS_CATEGORIES = [ // the ids are utils/store.js SETTINGS_TABS
  { id: 'look', label: 'settingsGroupLook', icon: 'brush' }, { id: 'cards', label: 'settingsGroupCards', icon: 'cards' },
  { id: 'search', label: 'settingsGroupSearch', icon: 'zoom' }, { id: 'behave', label: 'settingsGroupBehave', icon: 'gear' },
  { id: 'keys', label: 'settingsGroupKeys', icon: 'keyboard' },
];
// Tabazing's commands (manifest.json), as Settings -> Shortcuts lists them; `key`: the letter the in-page
// fallback (hotkey.js) answers to with Alt when Chrome has no shortcut for the command.
const COMMANDS = [
  { name: 'open-switcher', label: 'settingsKeyPrevious', description: 'commandOpen', key: 'Q' },
  { name: 'open-switcher-reverse', label: 'settingsKeyNext', description: 'commandReverse', key: 'W' },
  { name: 'open-switcher-stay', label: 'settingsKeyStay', description: 'commandStay', key: 'E' },
  { name: 'open-palette', label: 'settingsKeyPalette', description: 'commandPalette', key: 'R' },
];
const SHORTCUTS_URL = 'chrome://extensions/shortcuts'; // the only place Chrome lets anyone change them
const SETTINGS_NARROW_WIDTH = 640; // below this the categories are a row of tabs above the content
let settingsTab = 'look';
let settingsAnchor = null; // what opened Settings: it gets the focus back
const settingsOpen = () => !!document.querySelector('#app > .settings-back');

async function openSettings(anchor = elements.menuButton, redraw = false) {
  if (settingsOpen() && !redraw) return closeSettings();
  closeDrawer(false);
  closePops();
  const [stored, view] = await Promise.all([getPreferences().catch(() => ({})), redraw ? null : getView().catch(() => null)]);
  if (state.done || (settingsOpen() && !redraw)) return; // (a second click while the first was still reading)
  if (view) settingsTab = view.settingsTab;
  settingsAnchor = anchor;
  const preferences = { ...PREFERENCES_FALLBACK, startup: false, accent: ACCENTS[0], ...stored };
  const panel = makeElement('div', 'settings-panel', null, 'settings');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true'); // Tab stays in it (keepFocusIn) until it closes
  panel.setAttribute('aria-labelledby', 'settings-heading');
  const title = makeElement('h2', '', translate('settings'), 'settings-title');
  title.id = 'settings-heading';
  const x = makeElement('button', 'settings-close', null, 'settings-close');
  x.type = 'button';
  x.title = translate('settingsClose') + ' (Esc)';
  x.setAttribute('aria-label', translate('settingsClose'));
  x.append(svgOf(ICON.close));
  x.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) closeSettings(); });
  const head = makeElement('div', 'settings-head', null, 'settings-header');
  head.append(title, x);
  const tabs = makeElement('div', 'settings-tabs', null, 'settings-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', translate('settingsCategoriesAria'));
  tabs.addEventListener('keydown', settingsTabKey);
  const body = makeElement('div', 'settings-body', null, 'settings-body');
  const panes = settingsPanes(preferences, anchor);
  for (const { id, label, icon } of SETTINGS_CATEGORIES) {
    const tab = makeElement('button', 'settings-tab', null, 'settings-tab-' + id);
    tab.type = 'button';
    tab.id = 'set-tab-' + id;
    tab.dataset.cat = id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'set-pane-' + id);
    const iconElement = makeElement('span', 'settings-icon', null, 'settings-tab-icon');
    iconElement.append(svgOf(ICON[icon]));
    tab.append(iconElement, makeElement('span', '', translate(label), 'settings-tab-label'));
    tab.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) settingsSelect(id); });
    tabs.append(tab);
    const pane = panes[id];
    pane.id = 'set-pane-' + id;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', tab.id);
    body.append(pane);
  }
  panel.append(head, tabs, body);
  const back = makeElement('div', 'settings-back', null, 'settings-backdrop');
  back.append(panel);
  // A click on the backdrop closes it when the press began there too: not a text selection dragged out of the
  // panel, nor the press that only closed a select's open list (this listener runs before the list's own).
  let downOnBack = false;
  back.onDown = (event) => { downOnBack = event.target === back && !document.querySelector('.menu'); };
  back.addEventListener('click', (event) => { event.stopPropagation(); if (event.target === back && downOnBack && pointerAllowed()) closeSettings(); });
  // Back from Chrome's shortcuts page (perhaps in another window): show the keys as they are now.
  back.onFocus = () => { if (back.isConnected) settingsCommands(); };
  const old = document.querySelector('#app > .settings-back');
  if (old) { settingsDetach(old); old.replaceWith(back); } else elements.app.append(back);
  document.addEventListener('mousedown', back.onDown, true);
  window.addEventListener('focus', back.onFocus);
  settingsLayout();
  settingsSelect(settingsTab, { focus: !redraw, save: false });
  updateInert();
  settingsCommands();
  if (redraw) { const lang = byId('set-lang'); if (lang && lang._fancy) lang._fancy.button.focus({ preventScroll: true }); } // where the change was made
}
function settingsDetach(back) {
  document.removeEventListener('mousedown', back.onDown, true);
  window.removeEventListener('focus', back.onFocus);
}
function closeSettings() {
  const back = document.querySelector('#app > .settings-back');
  if (!back) return;
  settingsDetach(back);
  document.querySelectorAll('.menu').forEach((menuElement) => menuElement.close()); // a select's list
  back.remove();
  updateInert();
  viewBack(settingsAnchor).focus({ preventScroll: true });
}

// Show one category: its tab selected (the only one Tab reaches, as in any tab list), its panel shown.
function settingsSelect(id, { focus = true, save = true } = {}) {
  if (!SETTINGS_CATEGORIES.some((category) => category.id === id)) id = 'look';
  settingsTab = id;
  for (const tab of document.querySelectorAll('.settings-back .settings-tab')) {
    const on = tab.dataset.cat === id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    const pane = byId(tab.getAttribute('aria-controls'));
    if (pane) pane.hidden = !on;
    if (on && focus) tab.focus({ preventScroll: true });
  }
  const body = document.querySelector('.settings-back .settings-body');
  if (body) body.scrollTop = 0;
  if (save) updateView({ settingsTab: id }).catch(() => {});
}
// The tab list's keys: ↑/↓ (and ←/→ when the tabs are a row), Home and End move and show at once.
function settingsTabKey(event) {
  const list = event.currentTarget;
  const tabs = [...list.querySelectorAll('.settings-tab')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
  const across = list.getAttribute('aria-orientation') === 'horizontal';
  const key = event.key, count = tabs.length;
  const side = across && (key === 'ArrowRight' || key === 'ArrowLeft') ? ahead(key) : 0;
  const j = key === 'ArrowDown' || side > 0 ? (i + 1) % count
    : key === 'ArrowUp' || side < 0 ? (i - 1 + count) % count
    : key === 'Home' ? 0 : key === 'End' ? count - 1 : -1;
  if (j < 0) return;
  event.preventDefault();
  settingsSelect(tabs[j].dataset.cat);
}
// A narrow window: the categories become a row of tabs above the content (switcher.css .settings-panel.narrow).
function settingsLayout(width = window.innerWidth) {
  const panel = document.querySelector('.settings-back .settings-panel');
  if (!panel) return;
  const narrow = width < SETTINGS_NARROW_WIDTH;
  panel.classList.toggle('narrow', narrow);
  panel.querySelector('.settings-tabs').setAttribute('aria-orientation', narrow ? 'horizontal' : 'vertical');
}
// While Settings is open it has the keyboard: Esc closes it (an open select list closes itself first), and every
// other key belongs to the focused control, never to the switcher behind.
function settingsKey(event) {
  if (event.target instanceof Element && event.target.closest('.menu')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSettings(); }
}

// The categories' contents: { look, cards, search, behave, keys }, each a panel of controls that save themselves.
function settingsPanes(preferences, anchor) {
  const pane = (id, ...nodes) => { const paneElement = makeElement('div', 'settings-pane', null, 'settings-panel-' + id); paneElement.append(...nodes); return paneElement; };
  const fine = (text, testid) => makeElement('p', 'popover-fine-print', text, testid);
  // A labelled control; a <select> gets its themed list.
  const field = (label, testid, control) => {
    const fieldElement = makeElement('div', 'settings-field', null, 'settings-field');
    fieldElement.append(makeElement('label', '', label, testid), control);
    if (control.tagName === 'SELECT') fancySelect(control, { inPop: true });
    return fieldElement;
  };
  const select = (testid, label, options, chosen) => {
    const selectElement = makeElement('select', '', null, 'settings-' + testid);
    selectElement.setAttribute('aria-label', label);
    for (const [value, text] of options) { const option = makeElement('option', '', text, 'settings-' + testid + '-' + value); option.value = value; if (value === chosen) option.selected = true; selectElement.append(option); }
    return selectElement;
  };
  const lang = select('language', translate('settingsLanguage'), [['auto', translate('settingsLanguageAuto')], ['en', 'English'], ['el', 'Ελληνικά'], ['de', 'Deutsch'], ['it', 'Italiano'], ['fr', 'Français'], ['es', 'Español'], ['ru', 'Русский'], ['ar', 'العربية'], ['he', 'עברית'], ['ro', 'Română']], preferences.lang);
  lang.id = 'set-lang';
  lang.addEventListener('change', async () => {
    await updatePreferences({ lang: lang.value }).catch(() => {});
    setLang(lang.value);
    await languageLoaded();
    localizePage();
    render();
    openSettings(anchor, true); // redraw it in the new language, on the same category
  });
  // A switch that saves itself (prefs[key]), then `then` shows the change.
  const check = (key, label, testid, then) => {
    const box = makeElement('input', '', null, 'settings-' + testid);
    box.type = 'checkbox';
    box.checked = !!preferences[key];
    box.addEventListener('change', async () => {
      await updatePreferences({ [key]: box.checked }).catch(() => {});
      state.preferences = { ...(state.preferences || PREFERENCES_FALLBACK), [key]: box.checked };
      if (then && !state.done) await then();
    });
    const labelElement = makeElement('label', 'check', label, 'settings-' + testid + '-label');
    labelElement.prepend(box);
    return labelElement;
  };
  const shows = (key, label, testid) => check(key, label, testid, () => refresh());
  const searches = (key, label, testid) => check(key, label, testid, () => { searchPlaceholder(); if (state.query.trim()) renderDropdown(); });
  // Accent colour: a few ready-made ones, and any colour from Chrome's picker (the last circle).
  const accents = makeElement('div', 'accents', null, 'settings-accents');
  accents.setAttribute('role', 'radiogroup');
  accents.setAttribute('aria-label', translate('settingsAccent'));
  const custom = makeElement('input', 'custom', null, 'settings-accent-custom');
  const pickAccent = (color, save = true) => {
    const now = applyAccent(color);
    accents.querySelectorAll('.swatch').forEach((swatch) => swatch.setAttribute('aria-checked', String(swatch.dataset.c === now)));
    custom.classList.toggle('on', !ACCENTS.includes(now));
    if (save) updatePreferences({ accent: now }).catch(() => {});
  };
  for (const color of ACCENTS) {
    const swatch = makeElement('button', 'swatch', null, 'settings-accent');
    swatch.type = 'button';
    swatch.dataset.c = color;
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-label', color);
    swatch.style.setProperty('--swatch-color', color);
    swatch.addEventListener('click', (event) => { event.stopPropagation(); pickAccent(color); });
    accents.append(swatch);
  }
  custom.type = 'color';
  custom.value = preferences.accent.toLowerCase();
  custom.title = translate('settingsAccentCustom');
  custom.setAttribute('aria-label', translate('settingsAccentCustom'));
  // Chrome's colour picker takes the focus for a moment: that is not the user leaving Tabazing.
  custom.addEventListener('click', () => { asking = true; });
  custom.addEventListener('input', () => pickAccent(custom.value, false)); // try it live...
  custom.addEventListener('change', () => { asking = false; pickAccent(custom.value); window.focus(); }); // ...keep it when chosen
  accents.append(custom);
  pickAccent(preferences.accent, false);
  const theme = select('theme', translate('settingsTheme'), [['dark', translate('settingsThemeDark')], ['light', translate('settingsThemeLight')], ['system', translate('settingsThemeSystem')]], preferences.theme);
  theme.addEventListener('change', () => setTheme(theme.value));
  const size = select('card-size', translate('settingsSize'), [['default', translate('settingsSizeDefault')], ['small', translate('settingsSizeSmall')], ['list', translate('settingsSizeList')]], preferences.cardSize);
  size.addEventListener('change', () => {
    state.cardSize = size.value;
    updatePreferences({ cardSize: size.value }).catch(() => {});
    refresh();
  });
  const lines = select('title-lines', translate('settingsLines'), [['2', translate('settingsLines2')], ['1', translate('settingsLines1')]], String(preferences.titleLines));
  lines.addEventListener('change', () => {
    const titleLines = Number(lines.value);
    state.preferences = { ...(state.preferences || PREFERENCES_FALLBACK), titleLines };
    updatePreferences({ titleLines }).catch(() => {});
    applyLines();
    relayout();
  });
  // Shortcuts: Chrome's (filled in by settingsCommands), then the keys inside Tabazing, as the ⓘ card has them.
  const chromeH = makeElement('h3', '', translate('settingsKeysChrome'), 'settings-keys-chrome-title');
  chromeH.id = 'settings-keys-chrome';
  const chromeHead = makeElement('div', 'settings-section-head', null, 'settings-keys-chrome-header');
  chromeHead.append(chromeH, button('settings-keys-change-all', translate('settingsKeysChangeAll'), 'small', () => openUrl(SHORTCUTS_URL)));
  const commandList = makeElement('ul', 'command-list', null, 'settings-command-list');
  commandList.setAttribute('aria-labelledby', 'settings-keys-chrome');
  const chromeSection = makeElement('section', 'settings-section', null, 'settings-keys-chrome');
  chromeSection.setAttribute('aria-labelledby', 'settings-keys-chrome');
  chromeSection.append(chromeHead, fine(translate('settingsKeysChromeNote'), 'settings-keys-chrome-note'), commandList);
  const insideH = makeElement('h3', '', translate('settingsKeysInside'), 'settings-keys-inside-title');
  insideH.id = 'settings-keys-inside';
  const inside = makeElement('section', 'settings-section', null, 'settings-keys-inside');
  inside.setAttribute('aria-labelledby', 'settings-keys-inside');
  inside.append(insideH, ...shortcutSections('skg-'));
  return {
    look: pane('look', field(translate('settingsLanguage'), 'settings-language-label', lang), field(translate('settingsTheme'), 'settings-theme-label', theme),
      field(translate('settingsAccent'), 'settings-accent-label', accents), field(translate('settingsSize'), 'settings-card-size-label', size),
      field(translate('settingsLines'), 'settings-title-lines-label', lines)),
    cards: pane('cards', check('lite', translate('settingsLite'), 'lite', async () => { applyLite(); await reload(); }), fine(translate('settingsLiteNote'), 'settings-lite-note'),
      check('pinnedFirst', translate('settingsPinnedFirst'), 'pinned-first', () => refresh()), shows('showAge', translate('settingsShowAge'), 'show-age'),
      shows('showClosed', translate('settingsShowClosed'), 'show-closed'), shows('showSnoozed', translate('settingsShowSnoozed'), 'show-snoozed'),
      // Off: out of the group view too, for good (turned on again later, it doesn't jump back into a group).
      check('showGroups', translate('settingsShowGroups'), 'show-groups', async () => { if (state.group !== null) { state.group = null; await setGroup(null).catch(() => {}); } refresh(); }),
      fine(translate('settingsShowGroupsNote'), 'settings-show-groups-note'),
      check('groupWrap', translate('settingsGroupWrap'), 'group-wrap'), fine(translate('settingsGroupWrapNote'), 'settings-group-wrap-note'),
      check('allWindows', translate('settingsAllWindows'), 'all-windows', async () => { state.scope = 'all'; await reload(); }), fine(translate('settingsAllWindowsNote'), 'settings-all-windows-note')),
    search: pane('search', searches('searchHistory', translate('settingsSearchHistory'), 'search-history'), searches('searchBookmarks', translate('settingsSearchBookmarks'), 'search-bookmarks')),
    behave: pane('behave', check('ownWindow', translate('settingsOwnWindow'), 'own-window'), fine(translate('settingsOwnWindowNote'), 'settings-own-window-note'),
      check('startup', translate('settingsStartup'), 'startup'), fine(translate('settingsStartupNote'), 'settings-startup-note'),
      button('settings-tour', translate('settingsTour'), 'settings-button', () => { closeSettings(); tourStep(0); })),
    keys: pane('keys', chromeSection, inside),
  };
}

// Settings -> Shortcuts: each command with the key Chrome has for it now, or "Not set" (then only the in-page
// fallback answers, on web pages). Read anew each time, as the keys change on Chrome's page, not here.
async function settingsCommands() {
  const list = document.querySelector('.settings-back .command-list');
  if (!list) return;
  let commands = [];
  try { commands = await chrome.commands.getAll(); } catch {}
  if (!list.isConnected) return;
  list.replaceChildren(...COMMANDS.map((command) => commandRow(command, (commands.find((x) => x.name === command.name) || {}).shortcut || '')));
}
// "Alt+Q" (Windows, Linux) or "⌥Q" (Chrome's Mac form): one keycap per key.
const keyCaps = (shortcut) => (shortcut.includes('+') ? shortcut.split('+') : [...shortcut]).filter(Boolean);
function commandRow(command, shortcut) {
  const name = translate(command.label);
  const row = makeElement('li', 'command-row' + (shortcut ? '' : ' unset'), null, 'settings-command');
  const text = makeElement('div', 'command-text', null, 'settings-command-text');
  text.append(makeElement('span', 'command-name', name, 'settings-command-name'), makeElement('span', 'command-description', translate(command.description), 'settings-command-description'));
  if (!shortcut) text.append(makeElement('span', 'command-note', translate('settingsKeysUnsetNote', { key: ALT + command.key }), 'settings-command-unset-note'));
  const keys = makeElement('span', 'command-keys', null, 'settings-command-keys');
  if (shortcut) keys.append(...keyCaps(shortcut).map((key) => makeElement('kbd', '', key, 'settings-command-key')));
  else keys.append(makeElement('span', 'command-unset', translate('settingsKeysUnset'), 'settings-command-unset'));
  const change = button('settings-command-change', translate('settingsKeysChange'), 'small', () => openUrl(SHORTCUTS_URL));
  change.setAttribute('aria-label', translate('settingsKeysChangeAria', { name }));
  row.append(text, keys, change);
  return row;
}

// ---- the shortcuts card (ⓘ in the header): every key and mouse action, in groups (Settings -> Shortcuts lists
// them too). It takes the focus, keeps Tab inside, and closes with Esc, a press outside, its × or ⓘ again; the
// focus goes back to ⓘ.
function shortcutGroups() {
  const altPrefix = IS_MAC ? '⌥' : 'Alt+', ctrlPrefix = IS_MAC ? '⌘' : 'Ctrl+', ALT_KEY = IS_MAC ? '⌥' : 'Alt', CTRL_KEY = IS_MAC ? '⌘' : 'Ctrl';
  return [
    ['open', translate('keysGroupOpen'), [
      [[altPrefix + 'Q'], translate('keyPreviousTab')], [[altPrefix + 'W'], translate('keyNextTab')], [['Shift+' + altPrefix + 'Q', 'Shift+' + altPrefix + 'W'], translate('keyReverse')],
      [[altPrefix + 'E'], translate('keyStay')], [[translate('keyboardLetGo', { key: ALT_KEY })], translate('keyRelease')],
      [[translate('keyboardWheel', { key: ALT_KEY })], translate('keyWheel')], [[altPrefix + 'Tab', 'Shift+' + altPrefix + 'Tab'], translate('keyTabHeld')],
    ]],
    ['move', translate('keysGroupMove'), [
      [['←', '→', '↑', '↓'], translate('keyPick')], [[altPrefix + '1', '…', altPrefix + '9'], translate('keyNumber')], [['1', '…', '9'], translate('keyNumberPlain')],
      [[IS_MAC ? '⌃←' : 'Ctrl+←', IS_MAC ? '⌃→' : 'Ctrl+→'], translate('keyWindow')], [[IS_MAC ? '⌫' : 'Backspace'], translate('keyLeaveGroup')],
    ]],
    ['action', translate('keysGroupAction'), [
      [['Enter'], translate('keyOpen')], [['Shift+Enter'], translate('keyOpenTyped')], [['Space'], translate('keyPreview')], [[translate('keyboardClick', { key: 'Shift' })], translate('keyBigClick')],
      [[IS_MAC ? '⌘⌫' : 'Del', translate('keyboardMiddle')], translate('keyClose')], [[ctrlPrefix + 'Z'], translate('keyUndo')], [[altPrefix + 'S'], translate('keyStar')], [[altPrefix + 'P'], translate('keyCapture')],
      [['Shift+F10', translate('keyboardMenuKey'), translate('keyboardRight')], translate('keyActions')],
      [[translate('keyboardClick', { key: CTRL_KEY }), ctrlPrefix + 'Space'], translate('keyTick')], [[translate('keyboardClickBox', { key: 'Shift' })], translate('keyRange')], [['Shift+←→↑↓'], translate('keyExtend')],
      [[translate('keyboardDrag')], translate('keyDrag')],
    ]],
    ['search', translate('keysGroupSearch'), [[[ctrlPrefix + 'F'], translate('keySearch')], [[translate('keyboardType')], translate('keyType')], [['↑', '↓'], translate('keyResults')]]],
    ['palette', translate('keysGroupPalette'), [[[PALETTE_KEY], translate('keyPalette')], [['>', ctrlPrefix + 'K'], translate('keyPaletteIn')], [['Shift+Enter'], translate('keyPaletteStay')]]],
    ['views', translate('keysGroupViews'), [
      [[IS_MAC ? '⌘Y' : 'Ctrl+H'], translate('keyHistory')], [[IS_MAC ? '⌘⌥B' : 'Ctrl+Shift+O'], translate('keyBookmarks')],
      [['Enter'], translate('keyViewOpen')], [[ctrlPrefix + 'Enter', translate('keyboardMiddle')], translate('keyViewBehind')], [['Space', translate('keyboardClick', { key: 'Shift' })], translate('keyPreview')],
      [[ctrlPrefix + 'Space', translate('keyboardClick', { key: CTRL_KEY })], translate('keyTick')], [[translate('keyboardClickBox', { key: 'Shift' })], translate('keyRange')], [[ctrlPrefix + 'A'], translate('keyViewAll')],
      [[IS_MAC ? '⌘⌫' : 'Del'], translate('keyViewDelete')], [['F2'], translate('keyViewEdit')], [['→', '←'], translate('keyViewFolder')], [['*'], translate('keyViewSiblings')],
      [[ctrlPrefix + '↑', ctrlPrefix + '↓'], translate('keyViewNudge')], [['Home', 'End', 'PgUp', 'PgDn'], translate('keyViewJump')], [[translate('keyboardDrag')], translate('keyViewDrag')],
      [['Esc'], translate('keyViewEscape')],
    ]],
    ['esc', translate('keysGroupEscape'), [[['Esc'], translate('keyEscape')]]],
  ];
}
// shortcutGroups() as sections of keys and what they do: the ⓘ card's body, and Settings -> Shortcuts.
// `idPrefix` keeps the headings' ids apart.
function shortcutSections(idPrefix) {
  return shortcutGroups().map(([id, name, rows]) => {
    const groupSection = makeElement('section', 'keys-group', null, 'keys-group');
    const groupHeading = makeElement('h5', '', name, 'keys-group-title');
    groupHeading.id = idPrefix + id;
    groupSection.setAttribute('aria-labelledby', groupHeading.id);
    const descriptionList = makeElement('dl', '', null, 'keys-list');
    for (const [keys, what] of rows) {
      const comboElement = makeElement('dt', '', null, 'keys-combo');
      keys.forEach((key, i) => { if (i) comboElement.append(makeElement('span', 'key-or', ' / ', 'keys-or')); comboElement.append(makeElement('kbd', '', key, 'keys-key')); });
      descriptionList.append(comboElement, makeElement('dd', '', what, 'keys-action'));
    }
    groupSection.append(groupHeading, descriptionList);
    return groupSection;
  });
}
function openShortcuts(anchor = elements.keysButton) {
  const open = document.querySelector('.popover.keys-popover');
  closePops();
  if (open) return;
  const popover = makeElement('div', 'popover keys-popover', null, 'keys-popover');
  popover.id = 'keys-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'true'); // Tab stays in it (keepFocusIn) until it closes
  popover.setAttribute('aria-labelledby', 'keys-heading');
  const title = makeElement('h4', '', translate('keysTitle'), 'keys-title');
  title.id = 'keys-heading';
  const x = makeElement('button', 'note-close', null, 'keys-close');
  x.type = 'button';
  x.title = translate('keysClose');
  x.setAttribute('aria-label', translate('keysClose'));
  x.append(svgOf(ICON.close));
  x.addEventListener('click', (event) => { event.stopPropagation(); popover.close(); });
  const body = makeElement('div', 'keys-body', null, 'keys-body');
  body.append(...shortcutSections('kg-'), makeElement('p', 'popover-fine-print', translate('keysInSettings'), 'keys-settings-note'));
  const head = makeElement('div', 'keys-head', null, 'keys-header');
  head.append(title, x);
  popover.append(head, body);
  popover.addEventListener('click', (event) => event.stopPropagation());
  popover.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popover.close(); } });
  const outside = (event) => { if (!popover.contains(event.target) && !anchor.contains(event.target)) popover.close(); };
  popover.close = () => {
    if (!popover.isConnected) return;
    popover.remove();
    document.removeEventListener('mousedown', outside, true);
    anchor.setAttribute('aria-expanded', 'false');
    anchor.focus({ preventScroll: true });
  };
  elements.app.append(popover);
  anchor.setAttribute('aria-expanded', 'true');
  dropFrom(popover, anchor.getBoundingClientRect(), { fit: true });
  setTimeout(() => { if (popover.isConnected) document.addEventListener('mousedown', outside, true); }, 0);
  x.focus({ preventScroll: true });
}

// Runs once per open, after the first render.
async function firstRun() {
  let onboard = { tour: true }, review = null, firstToday = false;
  const today = dayOf();
  try {
    [onboard, review] = await Promise.all([getOnboard(), updateReview((currentReview) => { firstToday = currentReview.day !== today; return { ...currentReview, opens: currentReview.opens + 1, day: today }; })]);
    if (!onboard.flyout) updateOnboard({ flyout: true }).catch(() => {}); // opened once: the "press Alt+Q" flyout has done its job
  } catch { return; }
  if (!onboard.tour) return whenTapMode(() => tourStep(0));
  const plan = reviewPrompt(review, Date.now(), { firstToday });
  if (plan === 'ask') {
    updateReview((currentReview) => ({ ...currentReview, asks: currentReview.asks + 1, lastAsk: Date.now() })).catch(() => {});
    whenTapMode(askStep1);
  }
}

// While a dialog is open it takes the keyboard: Esc closes it, the tour has arrow keys,
// everything else (Tab, Enter, typing in the feedback box) works on the dialog itself.
// Ctrl+H (⌘Y on a Mac, as Chrome there) the history, Ctrl+Shift+O (⌘⌥B) the bookmarks, from the switcher or from
// one view to the other. True when the key was one of them.
function viewKey(event) {
  if (event.altKey && !IS_MAC) return false;
  const ctrlOrMeta = IS_MAC ? event.metaKey : event.ctrlKey;
  if (!ctrlOrMeta) return false;
  const isHistoryKey = IS_MAC ? event.code === 'KeyY' && !event.shiftKey : event.code === 'KeyH' && !event.shiftKey;
  const marks = IS_MAC ? event.code === 'KeyB' && event.altKey : event.code === 'KeyO' && event.shiftKey;
  if (!isHistoryKey && !marks) return false;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return true;
  if (isHistoryKey) { if (historyOpen()) closeHistory(); else openHistory().catch((error) => toast(translate('actionFailed'), error)); }
  else if (bookmarksOpen()) closeBookmarks(); else openBookmarks().catch((error) => toast(translate('bookmarksViewError'), error));
  return true;
}
function dialogKey(event) {
  if (event.target instanceof Element && event.target.closest('.menu')) return; // a select's list over the dialog: its own keys
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return state.modal === 'tour' ? endTour() : askLater(); }
  if (state.modal === 'tour' && !event.altKey && !event.ctrlKey && !event.metaKey) {
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? ahead(event.key) : 0;
    if (direction > 0) { event.preventDefault(); tourAt < TOUR.length - 1 ? tourStep(tourAt + 1) : endTour(); }
    else if (direction < 0) { event.preventDefault(); tourStep(tourAt - 1); }
  }
}

// ------------------------------------------------------------------ input
const MODIFIERS = new Set(['Alt', 'Control', 'Meta']);

// Is Option/Alt down right now (without Ctrl, so AltGr typing still works)?
// On a Mac, Option+letter types a symbol (Option+W is "∑") through the
// system's text input, which can slip past a cancelled keydown and even
// start a composition. So the search box also refuses text while it's down.
let altDown = false;
function trackAlt(event) { altDown = event.altKey && !event.ctrlKey; }

function onKeyDown(event) {
  if (state.done || !launched) return;
  if (refreshing) { // (a prepared frame just shown, reading the tabs again: acts once they are current)
    if (!MODIFIERS.has(event.key)) { event.preventDefault(); event.stopPropagation(); }
    return whenCurrent(() => onKeyDown(event));
  }
  trackAlt(event);
  // Tab moves the focus through the page's controls, within the top layer; only while Alt is still held
  // from Alt+Q / Alt+W does it step through the cards, like Alt+Tab (below).
  if (event.key === 'Tab' && !state.holding) return keepFocusIn(event);
  if (state.palette) return paletteKey(event); // the command palette has the keyboard
  if (!(event.shiftKey && event.key.startsWith('Arrow')) && !MODIFIERS.has(event.key) && event.key !== 'Shift') state.shiftBase = null; // a run of Shift+arrows ends
  if (event.key === 'Escape' && document.querySelector('.tip')) { event.preventDefault(); event.stopPropagation(); return hideTip(); } // the note tooltip first
  if (document.querySelector('.big-backdrop')) { // the big preview has the keyboard: Esc closes it, Enter opens that tab
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeBig(); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = bigEntry, i = state.entries.indexOf(entry);
      closeBig();
      if (entry.kind === 'history' || entry.kind === 'bmk') { if (keysAllowed()) openPage(entry.url); else finish('cancel'); } else if (i >= 0) choose(i);
    }
    else if (event.key === ' ') { event.preventDefault(); closeBig(); } // Space again: close
    else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { // the next / previous card's preview
      event.preventDefault();
      const isHistory = bigEntry.kind === 'history' && state.historyView;
      const isBookmark = bigEntry.kind === 'bmk' && state.bookmarksView;
      const list = isHistory ? state.historyView.items : isBookmark ? state.bookmarksView.rows.filter((row) => row.n.url).map((row) => bookmarkEntry(row.n)) : state.entries;
      const count = list.length, i = list.indexOf(bigEntry);
      if (count && i >= 0) {
        const j = (((i + ahead(event.key)) % count) + count) % count;
        if (isHistory) historySelect(j); else if (isBookmark) bookmarksViewSelect(state.bookmarksView.rows.findIndex((row) => row.n === list[j].node)); else select(j);
        openBig(list[j]);
      }
    }
    else if (!MODIFIERS.has(event.key)) event.preventDefault();
    return;
  }
  if (state.modal) return dialogKey(event);
  if (viewKey(event)) return;
  if (drawerOpen()) return drawerKey(event);
  if (backupOpen()) return backupKey(event);
  if (bookmarksOpen()) return bookmarksViewKey(event);
  if (historyOpen()) return historyKey(event);
  if (archiveOpen()) return archiveKey(event);
  if (settingsOpen()) return settingsKey(event);
  // Typing in any field other than the search box (a note, the Sort list), or pressing a button
  // in a card or a menu: the key belongs to that field or button, not to the switcher.
  const target = event.target instanceof Element ? event.target : null;
  const own = target && target.closest('.popover, .menu');
  if (target && target !== elements.search && target.matches('input, select, textarea')) {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      closePops();
      elements.search.focus({ preventScroll: true });
    }
    return;
  }
  // In a menu or a card (a note, the ⓘ card) every plain key stays there: Esc closes it, Enter/Space press, typing
  // doesn't jump to the search box behind it.
  if (own && !event.altKey && !event.ctrlKey && !event.metaKey) return;
  // A button, link, checkbox... focused from the keyboard (Tab reaches them): Enter and Space press it, they
  // don't open the selected card; ↑/↓ on a select button open its list. (One that only has the focus because
  // it was clicked leaves Enter to the card, as before.)
  const control = target && target !== elements.search && target.closest('button, a[href], [role=button], [role=checkbox], [role=menuitem], [role=radio], [role=switch]');
  if (control && control.matches(':focus-visible') && (event.key === 'Enter' || event.key === ' ')) return;
  if (control && control.matches('.fancy-select') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) return;
  const typing = document.activeElement === elements.search && elements.search.value !== '';
  const key = event.key;
  if (searchFrame && (key === 'Enter' || key === 'Tab' || key.startsWith('Arrow'))) flushSearch(); // act on what was just typed
  const altOnly = event.altKey && !event.ctrlKey && !event.metaKey;
  // Our Alt shortcuts must work even if the text system thinks it's composing.
  if (event.isComposing && !(altOnly && ['KeyQ', 'KeyW', 'KeyE', 'KeyS', 'KeyP', 'KeyR'].includes(event.code))) return;
  // A fresh modifier press, or any key without a modifier, means the user
  // had already let go of the shortcut: from now on it's "tap" mode.
  if ((MODIFIERS.has(key) && !event.repeat) || (!event.altKey && !event.ctrlKey && !event.metaKey)) stopHolding();

  // Close the selected tab: Del, or Cmd+Backspace on a Mac (its "delete"
  // key is Backspace, which the search box needs).
  const closeKey = !typing && (key === 'Delete' || (IS_MAC && event.metaKey && key === 'Backspace'));

  // Hidden or covered by the page: don't act on keys the user can't see the
  // effect of - just get out of the way.
  const willAct = key === 'Enter' || closeKey || (altOnly && ['KeyQ', 'KeyW', 'KeyE', 'KeyS', 'KeyP', 'KeyR'].includes(event.code));
  if (willAct && !keysAllowed()) { event.preventDefault(); finish('cancel'); return; }

  // Holding the key sends repeats: close one tab per press, not one per repeat.
  if (closeKey) { event.preventDefault(); if (event.repeat) return; return closeTab(state.entries[state.selected]); }
  if (altOnly && event.code === 'KeyQ') { event.preventDefault(); return cyclePress(event.shiftKey ? 1 : -1); } // back a card
  if (altOnly && event.code === 'KeyW') { event.preventDefault(); return cyclePress(event.shiftKey ? -1 : 1); } // forward a card
  if (altOnly && event.code === 'KeyE') { event.preventDefault(); stopHolding(); return; } // stay open
  // Alt+R: the command palette (Chrome's shortcut opens it from pages; this is for when it is unassigned).
  if (altOnly && !event.shiftKey && event.code === 'KeyR') { event.preventDefault(); if (!event.repeat) openPalette({ from: 'switcher' }); return; }
  if (altOnly && event.code === 'KeyS') { event.preventDefault(); if (!event.repeat) star(state.entries[state.selected]); return; }
  if (altOnly && event.code === 'KeyP') { event.preventDefault(); if (!event.repeat) captureOne(state.entries[state.selected]); return; }
  if (event.ctrlKey && (key === 'ArrowLeft' || key === 'ArrowRight')) { event.preventDefault(); return cycleScope(ahead(key)); }
  // Shift+F10 or the menu key: the selected card's menu (everything its buttons do, and ticking it).
  if ((key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) || key === 'ContextMenu') {
    event.preventDefault();
    menuKeyAt = performance.now(); // Chrome's own context menu follows the key: not this time
    if (!event.repeat) cardMenu();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.code === 'KeyF') { event.preventDefault(); elements.search.focus(); elements.search.select(); return; }
  // Ctrl+K (⌘K): the command palette (Esc comes back here).
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'KeyK') { event.preventDefault(); if (!event.repeat) openPalette({ from: 'switcher' }); return; }
  // Ctrl+Z undoes what was last done here: a close, a merge, a move (in a search box with text, it stays the box's own undo).
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.code === 'KeyZ' && !elements.search.value) { event.preventDefault(); if (!event.repeat) undoLast(); return; }
  // Ctrl+Space (⌘Space) ticks or unticks the selected card; Space alone is its big preview.
  if (key === ' ' && (event.ctrlKey || event.metaKey) && !event.altKey) {
    event.preventDefault();
    const currentEntry = state.entries[state.selected];
    if (!event.repeat && currentEntry && (currentEntry.kind === 'tab' || currentEntry.kind === 'group')) pick(currentEntry);
    return;
  }
  // Shift+arrows tick a range from the selected card (not while typing, where they select text, nor in the dropdown).
  if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && key.startsWith('Arrow') && !typing && !((key === 'ArrowUp' || key === 'ArrowDown') && dropdownShown())) {
    event.preventDefault();
    return extendPick(key);
  }
  // 1-9 switch straight to the card with that number: Alt+number always (Alt may still be held from
  // Alt+Q), a plain number only while the search box doesn't have the focus: there it is search text, so a
  // title that starts with a number can be found ("2024 report").
  const searchFocused = document.activeElement === elements.search;
  if (/^Digit[1-9]$/.test(event.code) && !event.ctrlKey && !event.metaKey && (altOnly || (!event.altKey && !event.shiftKey && !searchFocused && !elements.search.value))) {
    event.preventDefault();
    if (event.repeat) return;
    if (!keysAllowed()) return finish('cancel');
    const i = Number(event.code.slice(5)) - 1;
    if (i < state.openCount) choose(i);
    return;
  }

  // Backspace in the empty search box: out of the group view (like going up a folder).
  if (key === 'Backspace' && state.inGroup !== null && !elements.search.value && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    if (!event.repeat) leaveGroup();
    return;
  }

  switch (key) {
    case 'Escape':
      event.preventDefault();
      event.stopPropagation();
      if (elements.search.value) { elements.search.value = ''; state.query = ''; refresh(); }
      else if (state.duplicatesView) duplicatesView(false);
      else if (state.picked.size) clearPicks();
      else if (state.inGroup !== null) leaveGroup(); // the group view, back to all the tabs (Esc again closes Tabazing)
      else finish('cancel');
      return;
    case 'Enter':
      event.preventDefault();
      // Shift+Enter: what was typed, as an address or a Google search. With the dropdown up: its row.
      if (state.query.trim() && event.shiftKey) return openFromBox(state.query.trim());
      if (dropdownShown()) return dropdownActivate(state.dropdown.items[state.dropdown.highlighted]); // only the row you can see (a hidden dropdown is not a choice)
      return choose(state.selected);
    case ' ': // Space, with nothing typed: the selected card's big preview
      if (!elements.search.value && !event.altKey && !event.ctrlKey && !event.metaKey && state.entries[state.selected]) { event.preventDefault(); openBig(state.entries[state.selected]); }
      return;
    case 'Tab': event.preventDefault(); return cycle(event.shiftKey ? -1 : 1); // (Alt held: see the top)
    case 'ArrowRight': case 'ArrowLeft': if (!typing) { event.preventDefault(); moveSpatial(ahead(key), 0); } return;
    case 'ArrowDown': event.preventDefault(); return dropdownShown() ? dropdownMove(1) : moveSpatial(0, 1);
    case 'ArrowUp': event.preventDefault(); return dropdownShown() ? dropdownMove(-1) : moveSpatial(0, -1);
    default:
      if (MODIFIERS.has(key)) { event.preventDefault(); return; }
      // Option/Alt + a key types symbols on a Mac (Option+Shift+4 is "›").
      // With Alt still down from the shortcut, that's a slip, not a search.
      if (altOnly && key.length === 1 && !elements.search.value) { event.preventDefault(); return; }
      if (document.activeElement !== elements.search && key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        elements.search.focus(); // typing anywhere goes into the search box
      }
  }
}

// Alt+Q and Alt+W work like Alt+Tab: they open the switcher on the card before (Q) or after (W) the
// current tab, each further press while Alt is held moves on that way, and letting go of Alt switches to
// the selected tab. Alt+E opens it to stay (as do the toolbar icon and the rest): arrows, typing, the mouse,
// Enter and Esc. Pressing Alt+Q / Alt+W in an open switcher makes it an Alt+Tab one again.
function cyclePress(direction, hold = true) {
  if (hold) state.holding = true;
  cycle(direction);
}
// Alt was let go: here, or in the page before the switcher had the focus (FRAME_MESSAGE.RELEASED).
function altReleased() {
  if (!state.holding) return;
  if (state.modal || document.querySelector('.big-backdrop') || archiveOpen() || historyOpen() || bookmarksOpen() || drawerOpen() || backupOpen() || settingsOpen() || elements.search.value || !state.entries.length) return stopHolding();
  state.holding = false;
  keysAllowed() ? choose(state.selected) : finish('cancel');
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
    if (!state.palette) elements.search.focus({ preventScroll: true });
  }, 60);
}

function onKeyUp(event) {
  if (state.done || !launched) return;
  if (refreshing) return whenCurrent(() => onKeyUp(event));
  trackAlt(event);
  if (event.key === 'Alt') altDown = false;
  if (state.modal) return;
  if (!MODIFIERS.has(event.key)) return;
  event.preventDefault();
  if (event.key === 'Alt') altReleased();
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
  if (CONTEXT.mode !== 'overlay') return;
  try {
    new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry.isVisible) everVisible = true;
      visibleSince = entry.isVisible ? (visibleSince || performance.now()) : 0;
    }, { trackVisibility: true, delay: 100 }).observe(elements.app);
  } catch {
    visibleSince = 0; // unsupported: fail closed
  }
}
function pointerAllowed() {
  if (!launched) return false;
  if (CONTEXT.mode !== 'overlay') return true;
  const ok = visibleSince > 0 && performance.now() - visibleSince >= LIMITS.POINTER_VISIBLE_MILLISECONDS;
  if (!ok) stuckFallback();
  return ok;
}
// Shown a while ago, yet Chrome has never seen the overlay as visible (something on the page covers it
// or hides it from Chrome), so every click and key would be ignored: the first one that is reopens the
// switcher in its own window instead (background.js, MESSAGE.FALLBACK).
let readyAt = 0;
function stuckFallback() {
  if (!readyAt || everVisible || state.done || document.hidden || performance.now() - readyAt < LIMITS.OVERLAY_VISIBLE_MILLISECONDS) return;
  console.warn('[Tabazing] the overlay is not visible to Chrome on this page: using the popup window');
  state.done = true;
  chrome.runtime.sendMessage({ type: MESSAGE.FALLBACK }).catch(() => {});
}
// Keys may act while the overlay is visible, and during the first moments
// before Chrome has reported visibility (so a quick Alt+Q flick still works).
function keysAllowed() {
  if (CONTEXT.mode !== 'overlay' || visibleSince > 0) return true;
  const ok = !everVisible && performance.now() - bootedAt < LIMITS.KEYS_GRACE_MILLISECONDS;
  if (!ok) stuckFallback();
  return ok;
}

let resizeFrame = 0;
let listening = false;
function listen() {
  if (listening) return; // (a prepared frame listens from then on)
  listening = true;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  elements.search.addEventListener('beforeinput', (event) => { if (altDown) event.preventDefault(); });
  elements.search.addEventListener('input', () => {
    mark('keystroke');
    if (altDown && elements.search.value !== state.query) { elements.search.value = state.query; return; } // slipped through anyway
    // '>' first: the command palette, with whatever followed it; the box keeps what it had.
    if (elements.search.value.startsWith('>')) {
      const rest = elements.search.value.slice(1).trimStart();
      elements.search.value = state.query;
      return openPalette({ from: 'switcher', text: rest, saved: state.query });
    }
    state.query = elements.search.value; state.dropdown.hidden = false; state.dropdown.highlighted = 0; state.dropdown.highlightedKey = null;
    startSearch(state.query.trim());
    if (!searchFrame) searchFrame = requestAnimationFrame(flushSearch); // once per frame, however fast the typing
  });
  elements.paletteInput.addEventListener('input', onPaletteInput);
  elements.paletteList.addEventListener('mousedown', (event) => event.preventDefault()); // keep the focus (and the caret) in the palette's box
  // A click anywhere but the search box or its dropdown closes the dropdown (typing brings it back).
  document.addEventListener('mousedown', (event) => {
    if (!(event.target instanceof Element) || event.target.closest('.search, .dropdown')) return;
    if (!state.dropdown.hidden && state.dropdown.items.length) { state.dropdown.hidden = true; renderDropdown(); }
  }, true);
  elements.newTab.addEventListener('click', (event) => {
    event.stopPropagation();
    if (pointerAllowed()) openNewTab({ group: state.inGroup });
  });
  elements.sweepButton.addEventListener('click', (event) => {
    event.stopPropagation();
    if (pointerAllowed()) captureAll();
  });
  elements.starFilter.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) toggleStarFilter(); });
  elements.sort.addEventListener('click', (event) => event.stopPropagation());
  elements.sort.addEventListener('change', () => { setSort(elements.sort.value); elements.search.focus(); });
  const on = (node, handler) => node.addEventListener('click', (event) => { event.stopPropagation(); if (pointerAllowed()) handler(event); });
  on(elements.menuButton, () => openDrawer());
  on(byId('drawer-close'), () => closeDrawer());
  elements.drawerBack.addEventListener('click', (event) => { event.stopPropagation(); if (event.target === elements.drawerBack && pointerAllowed()) closeDrawer(); }); // beside it: closes it, not the switcher
  byId('drawer').addEventListener('click', (event) => event.stopPropagation());
  // the shortcuts the menu's buttons have (as the browser's own: the history, the bookmark manager)
  byId('history-button-key').textContent = IS_MAC ? '⌘Y' : 'Ctrl+H';
  byId('bookmarks-button-key').textContent = IS_MAC ? '⌘⌥B' : 'Ctrl+Shift+O';
  on(byId('settings-button'), () => openSettings(elements.menuButton));
  on(byId('backup-button'), () => openBackup());
  on(byId('archive-button'), () => openArchive().catch((error) => toast(translate('errorArchiveOpen'), error)));
  on(byId('history-button'), () => openHistory().catch((error) => toast(translate('actionFailed'), error)));
  on(byId('bookmarks-button'), () => openBookmarks().catch((error) => toast(translate('bookmarksViewError'), error)));
  on(elements.keysButton, () => openShortcuts());
  on(byId('github-button'), () => openUrl(REPO_URL)); // a new tab, beside the page Tabazing was opened from
  on(elements.duplicatesButton, closeDuplicates);
  on(elements.mergeButton, () => mergeWindows(state.otherWindows));
  on(elements.closedMore, () => { state.closedMore = !state.closedMore; refresh(); });
  on(elements.groupLeave, leaveGroup);
  // The note at the bottom waits while the pointer or the focus is on it (its Undo stays reachable).
  elements.toast.addEventListener('mouseenter', toastPause);
  elements.toast.addEventListener('focusin', toastPause);
  elements.toast.addEventListener('mouseleave', () => setTimeout(toastResume, 0));
  elements.toast.addEventListener('focusout', () => setTimeout(toastResume, 0));
  on(elements.selectAll, selectAll);
  on(elements.selectNone, clearPicks);
  on(elements.playerPrevious, () => playerCommand('previoustrack'));
  on(elements.playerToggle, () => playerCommand('toggle'));
  on(elements.playerNext, () => playerCommand('nexttrack'));
  on(elements.playerMore, openMediaList);
  // A click on empty space never closes Tabazing (Esc does): it is too easy to hit between the cards and the
  // header's controls. Only the palette leaves on a click beside it, as a dialog does: with it up everything
  // else is inert (or, opened with Alt+R, not shown at all).
  elements.app.addEventListener('click', (event) => {
    if (state.palette && !elements.palette.contains(event.target) && pointerAllowed()) { if (state.palette.from === 'shortcut') finish('cancel'); else exitPalette(); }
  });
  window.addEventListener('mousemove', (event) => {
    if (!event.altKey && !event.ctrlKey && !event.metaKey) stopHolding();
  });
  // Focus left the switcher (address bar, another app...): close quietly.
  // Only once we actually had focus, so a window that opens unfocused (or a
  // focus hiccup while it opens) doesn't make the switcher vanish instantly.
  let hadFocus = document.hasFocus();
  window.addEventListener('focus', () => { hadFocus = true; altDown = false; if (document.activeElement && document.activeElement.type === 'color') asking = false; });
  window.addEventListener('blur', () => setTimeout(() => {
    if (launched && hadFocus && !asking && !document.hasFocus()) finish('blur');
  }, 80));
  // Dragging a window's edge sends a resize event per mouse move: one redraw per frame is enough.
  window.addEventListener('resize', () => {
    if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; if (!state.done) { relayout(); settingsLayout(); } });
  });
  window.addEventListener('contextmenu', (event) => { if (menuKeyAt && performance.now() - menuKeyAt < 1000) event.preventDefault(); }); // the card's menu took that key
  elements.scroller.addEventListener('scroll', hideTip, { passive: true });
  setupDropZones();
  document.addEventListener('dragend', endDrag); // (its card may be gone by then: a drop redraws the cards)
  document.addEventListener('drop', (event) => { if (!event.defaultPrevented) { event.preventDefault(); endDrag(); } }); // (a link dropped anywhere else isn't opened as a page in Tabazing's frame)
  for (const type of ['dragenter', 'dragover']) document.addEventListener(type, (event) => { const draggedItem = dragged(event); if (draggedItem && draggedItem.link) event.preventDefault(); });
  // Holding Alt after Alt+Q / Alt+W, the wheel steps through the tabs: down to the next card (like W), up to the one before (like Q); letting
  // go of Alt still switches. A mouse wheel moves one tab per notch; a touchpad's small scrolls add up.
  let wheelSum = 0, wheelAt = 0;
  const WHEEL_STEP = 80;
  window.addEventListener('wheel', (event) => {
    if (state.holding && event.altKey) {
      event.preventDefault();
      const deltaY = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY; // lines -> pixels
      if (Math.abs(deltaY) >= 50) { wheelSum = 0; cyclePress(Math.sign(deltaY)); return; } // a notch
      if (performance.now() - wheelAt > 250) wheelSum = 0;
      wheelAt = performance.now();
      wheelSum += deltaY;
      while (Math.abs(wheelSum) >= WHEEL_STEP) { const direction = Math.sign(wheelSum); wheelSum -= direction * WHEEL_STEP; cyclePress(direction); }
      return;
    }
    // In the overlay, a wheel over anything that can't scroll would scroll the web page underneath.
    // Every area that scrolls on its own must be listed here, or the wheel does nothing over it (the palette's list was missing once).
    if (!(event.target instanceof Element) || !event.target.closest('#scroller, .windows, .modal-back, .dropdown, .menu, .archive-body, .media-list, .settings-body, .settings-tabs, .palette-list, .big-grid')) event.preventDefault();
  }, { passive: false });

  // Only the background service worker may move the selection (content
  // scripts always have sender.tab; the worker doesn't).
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (state.done || !launched || sender.id !== chrome.runtime.id || sender.tab) return; // (a prepared frame isn't open)
    if (message && message.type === MESSAGE.CYCLE) {
      whenCurrent(() => {
        if (message.palette === true) openPalette({ from: state.palette ? state.palette.from : 'switcher' }); // Alt+R
        else if (message.direction === 0) stopHolding(); // Alt+E: stay open
        else cyclePress(message.direction === -1 ? -1 : 1, message.hold === true);
      });
      respond({ ok: true });
    }
  });
  // (A prepared frame doesn't follow what changes meanwhile: its launch reads everything again.)
  chrome.tabs.onRemoved.addListener((id) => { if (!state.done && launched) forgetTab(id); });
  // Groups made, renamed, recoloured, collapsed or gone, and tabs moved into or out of one, in Chrome while
  // Tabazing is open: read again (once for a burst).
  let groupsTimer = 0;
  const groupsChanged = () => { if (!launched) return; clearTimeout(groupsTimer); groupsTimer = setTimeout(() => { if (!state.done) reload(); }, 150); };
  if (chrome.tabGroups) for (const eventName of ['onCreated', 'onUpdated', 'onRemoved']) if (chrome.tabGroups[eventName]) chrome.tabGroups[eventName].addListener(groupsChanged);
  chrome.tabs.onUpdated.addListener((id, changes) => { if (!state.done && changes && changes.groupId !== undefined) groupsChanged(); });
  // A preview saved while we are open (the current tab's, grabbed just before we opened, is stored as we
  // load): show it on its cards.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!launched) return;
    if (area === 'session' && changes[KEY.MEDIA] && !state.done) refreshMedia(); // a page started, stopped or changed its media
    if (area !== 'local' || state.done) return;
    const hit = [];
    if (changes[KEY.SNOOZED]) { getSnoozed().then((list) => { state.snoozed = list; drawLater(); }).catch(() => {}); }
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith('pv:') || !change.newValue || typeof change.newValue.img !== 'string') continue;
      for (const id of state.urlTabs.get(key.slice(3)) || NONE) { state.previews[id] = change.newValue; state.previewPending.delete(id); hit.push(id); }
    }
    if (hit.length) drawLater(hit); // just those cards (and the window list's pictures)
  });
  // The page saw Alt let go before we had the focus (see injectOverlay in background.js).
  window.addEventListener('message', (event) => {
    if (!state.done && launched && CONTEXT.mode === 'overlay' && event.source === window.parent && event.data && event.data.tabazing === FRAME_MESSAGE.RELEASED) whenCurrent(altReleased);
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
    return urlToken ? consumeLaunch(urlToken).then((launch) => (launch && launch.mode === 'window' ? launch : null)) : Promise.resolve(null);
  }
  // In a page: a prepared frame, loaded ahead and invisible. Say so to the page's overlay host, then wait
  // (for as long as it takes) for the launch it passes on when a shortcut is pressed.
  return new Promise((resolve) => {
    let attempts = 0, prepareAttempts = 0;
    const onMessage = async (event) => {
      const data = event.data;
      if (event.source !== window.parent || !data || typeof data.token !== 'string') return;
      if (data.tabazing === FRAME_MESSAGE.PREPARE) {
        if (preparing || ++prepareAttempts > 5) return;
        const standby = await checkStandby(data.token);
        // When the computer has a moment: preparing ahead must not slow down what is being done now.
        const whenIdle = (done) => (window.requestIdleCallback ? requestIdleCallback(done, { timeout: 1500 }) : setTimeout(done, 0));
        if (standby && !preparing) preparing = new Promise((start) => { hurryPrepare = start; whenIdle(start); }).then(() => prepare(standby));
        return;
      }
      if (data.tabazing !== FRAME_MESSAGE.LAUNCH) return;
      if (++attempts > 5) { window.removeEventListener('message', onMessage); return resolve(null); } // someone is guessing
      const launch = await consumeLaunch(data.token);
      if (launch && launch.mode === 'overlay') { window.removeEventListener('message', onMessage); resolve(launch); }
    };
    window.addEventListener('message', onMessage);
    parent.postMessage({ tabazing: FRAME_MESSAGE.STANDBY }, '*');
  });
}

// Drawn: the overlay may show now (its page reveals it on READY). `visible` marks the first frame after that.
function tellReady() {
  if (readyAt) return;
  if (CONTEXT.mode === 'overlay') parent.postMessage({ tabazing: FRAME_MESSAGE.READY, light: document.documentElement.classList.contains('light') }, '*');
  readyAt = performance.now();
  requestAnimationFrame(() => markEnd('visible', 'launched'));
}

// ------------------------------------------------------------- prepared frame
// A frame the page's overlay host loaded ahead (invisible, inert) reads and draws everything before any key is
// pressed, once its standby token checks out (the background issued it for this tab: checkStandby). The launch
// then only picks the card to select and shows it (showPrepared), and makes sure, right after, that what it
// drew is still current. Until the launch token checks out it does nothing a page could see or use: it stays
// invisible (the host shows it only after READY, which only a launch sends), keys and clicks are ignored
// (launched), and the background's "is one open?" goes unanswered.
let launched = false;   // the launch token checked out: it may show now, and act
let preparing = null;   // prepare() under way or done (resolves to the settings it drew with), or null
let preparedFor = null; // { tabId, windowId } it was prepared for
let hurryPrepare = null; // starts prepare() now, if it is still waiting for an idle moment
let refreshing = false; // showing a prepared frame, while it reads the tabs again: keys wait for it (waiting)
const waiting = [];
const whenCurrent = (callback) => { if (refreshing) waiting.push(callback); else callback(); };

async function applySettings(preferences) {
  setLang(preferences.lang);
  await languageLoaded(); // (its dictionary is read now: the only one of the ten this page needs, with English)
  applyAccent(preferences.accent);
  applyTheme(preferences.theme);
  applyLite(preferences.lite === true);
  localizePage();
}
let decorated = false;
function decorate() { if (decorated) return; decorated = true; fancySelect(elements.sort); }

async function prepare({ tabId, windowId }) {
  mark('prepare-start');
  preparedFor = { tabId, windowId };
  CONTEXT = Object.freeze({ sourceTab: tabId, sourceWindow: windowId, sourceState: 'normal', direction: 1, hold: false, mode: 'overlay', via: 'key', palette: false });
  const preferences = await getPreferences().catch(() => PREFERENCES_FALLBACK);
  await applySettings(preferences);
  decorate();
  listen();
  await load(preferences, { previews: false });
  searchPlaceholder();
  derive();
  await loadPreviews(firstShown());
  derive();
  state.media = await loadMedia().catch(() => []);
  elements.app.hidden = false;
  mark('render-start');
  render();
  markEnd('render', 'render-start');
  await loadPreviews(state.tabs).then((ids) => { if (ids.length) drawLater(ids); }).catch(() => {});
  await loadExtras().then(() => drawLater()).catch(() => {});
  markEnd('prepare', 'prepare-start');
  return preferences;
}

// Opened from a tab outside the group Tabazing was inside of (you went elsewhere, in Chrome itself or by picking
// a tab outside it here): the group is left, and every way of opening shows all the cards.
function leaveGroupIfElsewhere() {
  if (state.inGroup !== null && !state.tabs.some((x) => x.id === CONTEXT.sourceTab && x.groupId === state.inGroup)) {
    state.group = null;
    setGroup(null).catch(() => {});
    derive();
  }
}
// The card to select first, as an index of state.entries (`resume`: back after capturing one tab's preview).
function firstSelection(resume = null) {
  const mru = state.mruOrder;
  // By recent use, the first Alt+W goes to the tab used just before this one, as Alt+Tab does, even when it is pinned
  // (shown first); every other step follows the cards as shown.
  const before = state.sort === 'recent' && state.inGroup === null && CONTEXT.direction > 0 ? mru.find((entry) => entry.key !== 't' + CONTEXT.sourceTab) : null;
  const firstStep = () => { if (before) return before.key; const step = stepFrom('t' + CONTEXT.sourceTab, CONTEXT.direction); return step.leave ? stepOutOfGroup(CONTEXT.direction) : step.key; };
  // Alt+Q / Alt+W start one card before / after the current tab (in the group view, past its ends out of it),
  // Alt+E (dir 0) on the current tab itself; anything else (the toolbar icon, opening with Chrome) on the tab
  // used before it.
  const first = resume && typeof resume.key === 'string' ? resume.key
    : CONTEXT.hold ? firstStep()
    : CONTEXT.direction === 0 ? 't' + CONTEXT.sourceTab
    : mru.length > 1 ? mru[1].key : null;
  const at = first ? state.entries.findIndex((entry) => entry.key === cardKey(first)) : -1;
  if (first && at < 0) { const entry = mru.find((x) => x.key === first); if (entry && entry.section) { state.peek.add(entry.section); derive(); } }
  return Math.max(0, first ? state.entries.findIndex((entry) => entry.key === cardKey(first)) : 0);
}
// What decides how the cards look, for telling whether a prepared frame's are still current.
const drawnSignature = () => JSON.stringify([
  state.entries.map((entry) => [entry.key, entry.tab ? [entry.tab.title, urlOf(entry.tab), entry.tab.favIconUrl, entry.tab.pinned, entry.tab.discarded, entry.tab.audible, isMuted(entry.tab), entry.tab.groupId, entry.tab.active] : entry.kind,
    entry.preview ? entry.preview.t : 0, entry.tabs ? entry.tabs.length : 0]),
  Object.keys(state.stars).length, Object.keys(state.notes).length, state.snoozed.length, Object.keys(state.woken).length, [...state.groups.values()].map((group) => [group.id, group.title, group.color, group.collapsed]),
]);

// The launch of a prepared frame: shown at once, as it was drawn; then read again, and drawn again if anything changed.
async function showPrepared(preparedPreferences) {
  state.holding = CONTEXT.hold;
  document.documentElement.classList.toggle('alttab', CONTEXT.hold);
  document.documentElement.classList.add(CONTEXT.mode);
  watchVisibility();
  refreshing = true;
  const drawn = drawnSignature();
  // The order of use as it is now: switching to this tab since it was drawn changed it, and Alt+Q / Alt+W start from it.
  const mru = await getMru().catch(() => null);
  if (mru) { sortByUse(state.tabs, mru); derive(); }
  leaveGroupIfElsewhere();
  const at = firstSelection(); // (may open a section, to select a card in it)
  if (drawnSignature() !== drawn) refresh({ keepKey: (state.entries[at] || {}).key });
  else if (CONTEXT.hold) relayout(); // (html.alttab hides the search box)
  if (CONTEXT.palette) openPalette({ from: 'shortcut' });
  else select(at, { scroll: true });
  const shownAt = CONTEXT.palette ? -1 : state.selected;
  tellReady();
  window.focus();
  (state.palette ? elements.paletteInput : elements.search).focus({ preventScroll: true });
  chrome.runtime.sendMessage({ type: MESSAGE.MEDIA_CHECK }).catch(() => {});
  try {
    const preferences = await getPreferences().catch(() => preparedPreferences);
    const settingsChanged = JSON.stringify(preferences) !== JSON.stringify(preparedPreferences);
    if (settingsChanged) await applySettings(preferences);
    const before = drawnSignature();
    const shownKey = (state.entries[state.selected] || {}).key;
    await load(preferences);
    derive();
    // Keys wait meanwhile, so the first card is still selected (unless the mouse moved on): picked again from what was just read.
    const selectedKey = state.selected === shownAt ? (state.entries[firstSelection()] || {}).key : shownKey;
    if (settingsChanged || drawnSignature() !== before || selectedKey !== shownKey) refresh({ keepKey: selectedKey });
  } catch {}
  refreshMedia();
  refreshing = false;
  for (const callback of waiting.splice(0)) callback();
  loadExtras().then(() => drawLater()).catch(() => {});
  firstRun();
  healthCheck();
  await handOver();
}

// Keys pressed while it was still opening, as when it is open: Alt+E keeps it open, Alt+R opens the palette.
async function handOver() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE.READY });
    const extra = response && Number.isInteger(response.extra) ? response.extra : 0;
    for (let i = 0; i < Math.abs(extra); i++) cyclePress(Math.sign(extra));
    if (response && response.stay === true) stopHolding();
    if (response && response.palette === true) openPalette({ from: state.palette ? state.palette.from : 'switcher' });
  } catch {}
}

// A frame (or window) launched without being prepared: everything is read and drawn now.
async function boot(resume) {
  state.holding = CONTEXT.hold; // Alt+Q / Alt+W: letting go of Alt will switch...
  document.documentElement.classList.toggle('alttab', CONTEXT.hold); // ...and what needs typing is hidden meanwhile
  document.documentElement.classList.add(CONTEXT.mode);
  // The settings are read once, here: the language, the colours, and (load) which tabs to ask Chrome for.
  const bootPreferences = await getPreferences().catch(() => PREFERENCES_FALLBACK);
  await applySettings(bootPreferences);
  decorate();
  listen();
  watchVisibility();
  // Alt+R: the palette shows at once, before any tab is read (they fill it in as they come).
  if (CONTEXT.palette) {
    elements.app.hidden = false;
    openPalette({ from: 'shortcut' });
    tellReady();
    window.focus();
  }
  const mediaRead = loadMedia().catch(() => []); // the player's list, read alongside the tabs
  chrome.runtime.sendMessage({ type: MESSAGE.MEDIA_CHECK }).catch(() => {}); // ...and checked with the pages (the list follows)
  await load(bootPreferences, { previews: false });
  searchPlaceholder();
  if (resume) { // back after capturing one tab's preview: show what was there before
    state.query = elements.search.value = typeof resume.query === 'string' ? resume.query : '';
    state.scope = resume.scope === 'all' || Number.isInteger(resume.scope) ? resume.scope : 'all';
    state.starOnly = !!resume.starred;
  }
  derive();
  leaveGroupIfElsewhere();
  state.selected = firstSelection(resume);
  // The previews of what the first draw shows (reading all of them, 50 KB each, kept it waiting); the rest
  // right after it.
  await loadPreviews(firstShown());
  derive(); // (the cards' entries carry their previews)
  state.media = await mediaRead;
  elements.app.hidden = false;
  mark('render-start');
  render();
  markEnd('render', 'render-start');
  requestAnimationFrame(() => markEnd('cards', 'launched'));
  loadPreviews(state.tabs).then((ids) => { if (ids.length) drawLater(ids); requestAnimationFrame(() => markEnd('previews', 'launched')); });
  tellReady();
  window.focus();
  (state.palette ? elements.paletteInput : elements.search).focus({ preventScroll: true });
  // Then "Recently closed" and starred pages that aren't open; drawn once the opening animation is over,
  // so it doesn't restart on the cards.
  loadExtras().then(() => drawLater()).catch(() => {});
  if (!resume) firstRun();
  healthCheck();
  await handOver();
}

(async () => {
  // Anything that loads this page without the token the background just issued (e.g. a website framing it)
  // shows nothing and acts on nothing (a prepared frame has drawn the tabs, invisible, but stays inert).
  const launch = await getLaunch();
  if (!launch) return;
  mark('launched');
  if (hurryPrepare) hurryPrepare();
  const preparedPreferences = preparing ? await preparing.catch(() => null) : null;
  const resume = await takeResume().catch(() => null);
  CONTEXT = launch;
  launched = true;
  if (preparedPreferences && !resume && preparedFor && launch.sourceTab === preparedFor.tabId && launch.sourceWindow === preparedFor.windowId) return showPrepared(preparedPreferences);
  return boot(resume);
})();

// For the unit tests (tests/): everything above, by name. Nothing in the extension imports this file.
export {
  CONTEXT, byId, elements, IS_MAC, state, ICON, urlOf, favicon, hostOf, makeElement, load, loadExtras, loadStarPreviews, hashOf,
  loadClosed, closedFor, fieldIndex, fieldOf, typoDistance, typoMemo, typoNear, inOrder, wordScore, scoreWord,
  searchScore, matches, queryWords, fieldHit, matchTier, highlight, highlightSpan, isStarred, siteOf, byTitle,
  windowRank, FILTERS, SORTERS, STATUS, statusText, tabStatus, pageStatus, sectionsFor, deriveSearch, derive, GRID_GAP, CARD_SIZES, cardWidth, renderWindows,
  windowTag, thumbFor, starButton, canCapture, captureButton, DAY_MILLISECONDS, tabAge, renderCard, finishCard,
  onMiddleClick, dropdownMiddleClick, renderSection, renderTools, render, renderCount, tipTruncated, setTop, toTop, refresh, select, stepKey,
  cycle, selectKey, moveSpatial, cardToward, toggleSection, setSort, setFilter, toggleStarFilter, star,
  captureOne, setScope, cycleScope, finish, choose, closeTab, forgetTab, pickBox, pick, pickPool,
  selectAll, clearPicks, targets, ACTIONS, renderActions, renderDuplicatesBar, duplicatesView, toastTimer, toast,
  undoRecord, pushUndo, undoLast, reopenAt, reload, closeMany, copyText, copyLinks,
  moveToNewWindow, googleUrl, asUrl, openFromBox, DROPDOWN_MAX, DROPDOWN_SOURCES, loadMarks, historyEntryOf, loadHistory, historyTimer,
  searchHistory, historyMemo, historyItems, urlKeys, urlKey, bigHits, fullTimer, scoreBig, fullPass, NONE, dropdownRows,
  searchFrame, flushSearch, dropdownShown, dropdownMove, dropdownHighlight, dropdownPictures, dropdownPicture, renderDropdown, dropdownActivate,
  restoreClosed, openPage, mergeWindows, snoozeChoices, whenLabel, snoozeMenu, snoozeTabs, unsnooze, drag,
  clearDrop, dropAfter, dragToMove, dragToOpen, cardDrop, openDropped, moveToWindow, startDrag, endDrag, moveTabs, moveGroup, addToGroup, groupFlags, sleepTabs, pinTabs, muteTabs, duplicateUrls, duplicates, closeDuplicates,
  isMuted, audioBadge, togglePin, toggleMute, reloadTab, duplicateTab, loadArchived, archiveTabs, unarchive,
  openArchived, archiveOpen, openArchive, archiveCard, dropArchived, archivedBehind, archiveSelect, closeArchive, archiveKey,
  viewKey, backupOpen, openBackup, closeBackup, exportBackup, importBackup, backupKey, BACKUP_KINDS, drawerOpen, openDrawer, closeDrawer, drawerKey, viewBack, viewDialog, historyOpen, openHistory, moreHistory, historyItem, historySelect, closeHistory, removeHistory, historyMenu, historyKey, HISTORY_PAGE, deleteButton, findHistory, searchField,
  refreshHistory, setHistoryLayout, historyPick, agoShort, agoTag, showTip, historyMoreFrom, historyForgetSite, dayLabel, confirmDialog, fetchHistory,
  bookmarksOpen, openBookmarks, closeBookmarks, drawBookmarks, bookmarksViewRows, bookmarksViewSelect, bookmarksViewToggle, bookmarksViewPick, bookmarksViewDelete, bookmarksViewEdit, bookmarksViewMenu, bookmarksViewKey, bookmarksViewNote, webAddress, bookmarkNoteOf, reloadBookmarks,
  bookmarksViewMove, bookmarksViewSort, bookmarksViewNudge, bookmarksViewOpenAll, bookmarksViewImportStars, bookmarksViewFilter, bookmarksViewFind, bookmarksViewOpenSiblings, bookmarksViewMoveDialog,
  quickActions, noteOf, paintNote, noteButton, TIP_DELAY_MILLISECONDS, DATE_TIP_DELAY_MILLISECONDS, tipTimer, noteTip, hideTip, notePopover, bigEntry,
  openBig, closeBig, closePops, menu, fancySelect, asking, keyLabel, paragraph, button, showDialog, closeDialog,
  whenTapMode, keyRows, ALT, TOUR_ALL, TOUR, tourAt, tourStep, placeTour, endTour, openUrl, reviewDone,
  goReview, askStep1, askStep2, askLater, showAlert, requestHostAccess, missingPreviews, updateSweepButton,
  plainCaptureError, healthCheck, lightMediaQuery, themePreference, applyTheme, openSettings, closeSettings, settingsOpen, settingsSelect, settingsTabKey, settingsLayout, settingsKey, settingsPanes,
  settingsCommands, settingsDetach, commandRow, keyCaps, COMMANDS, SHORTCUTS_URL, SETTINGS_NARROW_WIDTH, SETTINGS_CATEGORIES, shortcutSections, firstRun, dialogKey, MODIFIERS,
  altDown, trackAlt, onKeyDown, cyclePress, altReleased, stopHolding, onKeyUp, visibleSince, everVisible, bootedAt,
  timings, prepare, showPrepared, sortByUse, boot, firstSelection, drawnSignature, applySettings, isLite, applyLite, readPreviews, MANY_CARDS, MANY_CARDS_WIDTH, watchVisibility, pointerAllowed, readyAt, stuckFallback, keysAllowed, listen, getLaunch, syncCombo, focusMark,
  refocus, mouseOnly, toastAction, toastUndo, tipHide, hideTipSoon, updateInert, TABBABLE, tabbables, focusLayer,
  keepFocusIn, menuKeyAt, cardMenu, dialogBack, svgTemplates, svgOf, PREFERENCES_FALLBACK, loadPreviews, FIRST_PREVIEWS,
  firstShown, loadSnoozePreviews, shots, shotImage, redrawCards, redraw, topOf, cardList, selectedCard, cardAt,
  drawLater, duplicateMemo, duplicateIds, resizeFrame, relayout, switchToTab, currentMedia, mediaPreview, mediaPictures, mediaPicture,
  loadMediaPreviews, DOUBLE_PRESS_MILLISECONDS, paintToggle, playerSignature, renderPlayer, renderMedia, mediaLoading, refreshMedia, mediaCommand, playerCommand,
  pickMedia, goToMedia, mediaOrder, openMediaList, renderMediaList, mediaRow, mediaButton,
  previewBatch, gridColumns, deriveHits, markHits, preference, wokenTag, pinnedBadge, headButtons, layoutHeader, NARROW_WIDTH, TIGHT_WIDTH,
  toastRun, toastPause, toastResume, placeToast, toastLeft, moveBack, UNDO_SESSION_MILLISECONDS, localInput, snoozePicker, extendPick,
  applyLines, searchPlaceholder, shortcutGroups, openShortcuts, ICON_TIPS,
  searchFor, foundFor, foundMemo, searchText, renderSearch, dropdownTitleRow, dropdownRowElement, openNewTab, captureAll, startSearch, setTheme,
  PALETTE_SOURCES, PALETTE_TYPED_MAX, PALETTE_USEFUL, ZOOMS, sourceTabInformation, sourceTab, sourceEntry, tabName, isWeb, staleTabs, otherTabs, chromePage,
  PALETTE_ACTIONS, PALETTE_BY_ID, paletteActions, inEnglish, actionFields, paletteItems, PALETTE_ICON, paletteActionRow, paletteQuickRow,
  paletteCurrencyRow, paletteFrame, renderPalette, paletteHighlight, paletteMove, openPalette, exitPalette, paletteRun, copyQuick, runAction,
  paletteKey, onPaletteInput, nextZoom, zoomTab, toggleFullscreen, PALETTE_KEY, dropFrom,
  groupTiles, cardKey, stepFrom, stepOutOfGroup, GROUP_COLORS, groupColor, groupName, renderGroupCard, renderGroupBar, showsTab, enterGroup, leaveGroup,
  cardName, cardTabs, tickChanged, regroup, reopenPage, groupFor, closedQuick, reopenInWindow, reopenBehind, snoozeClosed, archiveClosed, forgetClosed, afterClosedChange, ungroup,
  pageOf, markFolders, bookmarkDialog, noteBits, groupTag, groupMenu, newGroup, editGroup, groupEditor, ungroupTabs, groupToWindow, collapseGroup, sourceGroup, groupEntry, openBigGroup, nextColor,
};
