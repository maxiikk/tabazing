// Shared names and limits used by the background worker and the switcher UI.
import { uiLang } from './i18n.js';
// (hotkey.js is a classic content script and can't import this, so it
// repeats MSG.HOTKEY as a string literal. Keep them in sync.)

export const MSG = Object.freeze({
  HOTKEY: 'tabazing:hotkey', // content script -> background: user pressed Alt+Q / W / E in a page: { dir, hold }
  CYCLE: 'tabazing:cycle',   // background -> open switcher: move selection
  READY: 'tabazing:ready',   // switcher -> background: UI loaded, send queued moves
  CLOSED: 'tabazing:closed', // switcher -> background: UI closed (with reason)
  SWEEP: 'tabazing:sweep',   // switcher -> background: capture previews of every tab now
  SWEEP_CANCEL: 'tabazing:sweep-cancel', // sweep window -> background
  CAPTURE_ONE: 'tabazing:capture-one', // switcher -> background: show one tab for a moment and capture it
  FLYOUT_DONE: 'tabazing:flyout-done', // first-run flyout dismissed (content script -> background)
  NUDGE: 'tabazing:nudge',   // "use Alt+Q" toast answered (content script -> background): { act: 'try'|'ok'|'never' }
  OPENED: 'tabazing:opened', // switcher -> background: it opened (the nudge keeps quiet for a while after)
  SLEEP: 'tabazing:sleep',   // switcher -> background, as it closes: unload these tabs ({ tabIds })
  FALLBACK: 'tabazing:fallback', // overlay -> background: Chrome never saw it as visible (clicks would be ignored): use the popup window
});

// Messages between the overlay iframe and the content-script code that hosts it.
// RELEASED: the page saw Alt let go (Alt+Q / Alt+W were held) before the switcher had the focus.
// STANDBY: the switcher frame has loaded and waits for a launch (it is prepared ahead, invisible).
export const FRAME_MSG = Object.freeze({ LAUNCH: 'launch', READY: 'ready', CLOSE: 'close', RELEASED: 'released', STANDBY: 'standby' });

export const KEY = Object.freeze({
  MRU: 'mru',                 // number[] tab ids, most recent first
  BOOT_AT: 'bootAt',          // storage.session: when this browser session started (set on onStartup)
  PREVIEW_CLEAN: 'pvclean',   // storage.local: when preview cleanup last ran
  SLEPT: 'slept',             // storage.session: number[] ids of tabs we saw Chrome discard in this browser session
  CLOSED_LOG: 'closedlog',    // storage.local: [{ url, title, favIconUrl, closedAt }] tabs closed in the last 7 days
  SHARP_INDEX: 'pvhdidx',     // storage.local: { [normalizedUrl]: { t, n, s } } like PREVIEW_INDEX, for the sharp copies
  PREVIEW_INDEX: 'pvidx',     // storage.local: { [normalizedUrl]: { t, n, s } } captured-at, size, and when an open tab last had this URL
  ONBOARD: 'onb',             // storage.local: { at, flyout, tour } first-run flags
  REVIEW: 'rv',               // storage.local: { since, opens, soft, lastSoft, asks, lastAsk, done } review-prompt counters (never sent anywhere)
  CAPDIAG: 'capdiag',         // storage.session: { t, stage, msg, host } outcome of the last preview attempt
  SWEEP: 'sweep',             // storage.session: { running, done, total } progress of "Capture all previews"
  SNOOZED: 'snoozed',         // storage.local: [{ id, url, title, at, windowId, pinned, t }] tabs closed for now, reopened at `at`
  NOTES: 'notes',             // storage.local: { [normalizedUrl]: { u, n, t } } notes the user wrote on tabs
  STARS: 'stars',             // storage.local: { [normalizedUrl]: { u, ti, t } } pages the user starred
  VIEW: 'view',               // storage.local: { sort, collapsed: string[] } how the switcher lays tabs out
  NUDGE: 'nudge',             // storage.local: { day, runs, shown, last, never } the "use Alt+Q" nudge (never sent anywhere)
  LAST_OPEN: 'lastOpen',      // storage.session: when the switcher last opened
  PREFS: 'prefs',             // storage.local: { lang: 'auto'|'en'|'ru'|'es', startup: boolean, cardSize: 'default'|'small'|'list', accent: '#rrggbb', allWindows: boolean } Settings
  NOCAP: 'nocap',             // storage.session: normalized URLs Chrome refused to screenshot (the Web Store, some built-in pages)
  RESUME: 'resume',           // storage.session: { t, query, scope, sort, starred, key } reopen the switcher where it was (after a one-tab capture)
  OVERLAY: 'overlay',         // { tabId, t } tab currently covered by the overlay
  LAUNCH: 'launch',           // { token, t, ctx } one-time launch for the next switcher
});

export const SNOOZE_ALARM = 'tabazing:snooze'; // chrome.alarms name: the next snoozed tab's wake-up time
export const previewKey = (url) => 'pv:' + url; // storage.local, `url` already normalized
export const sharpKey = (url) => 'pvhd:' + url; // storage.local: the sharp copy of the same capture (big preview)
export const tabMetaKey = (tabId) => 'm:' + tabId; // storage.session: { u, ti, f } last known url/title/icon of an open tab
export const PREVIEW_PREFIX = 'data:image/jpeg;base64,';

export const WINDOW_STATES = Object.freeze(['normal', 'maximized', 'fullscreen']);
export const MODES = Object.freeze(['overlay', 'window']);
export const CLOSE_REASONS = Object.freeze(['cancel', 'switch', 'restore', 'blur']);

export const LIMITS = Object.freeze({
  THUMB_MAX: 560,               // px, longest side of a stored thumbnail (the cards)
  SHARP_MAX: 1920,              // px, longest side of the sharp copy of the same capture (the big preview)
  MAX_SHARP: 80,                // most sharp copies kept (the oldest, and those of closed tabs, go first)
  MAX_SHARP_BYTES: 40 * 1024 * 1024, // ...and in total (the unlimitedStorage permission lifts the 10 MB quota)
  MAX_PREVIEWS: 300,            // most previews kept on disk (storage.local)
  MAX_PREVIEW_BYTES: 6 * 1024 * 1024, // ...and in total, well under storage.local's 10 MB quota
  PREVIEW_TTL_MS: 7 * 24 * 60 * 60 * 1000, // a preview no open tab uses is deleted 7 days after it was last captured or used
  CLEANUP_EVERY_MS: 6 * 60 * 60 * 1000,    // preview cleanup runs at most this often (from the save path, no alarms permission)
  CLEANUP_BOOT_DELAY_MS: 60 * 1000,        // ...and not in the first minute after browser start, while Chrome is still restoring tabs
  MAX_SLEPT: 2000,              // most discarded-tab ids remembered
  MAX_URL_KEY: 2048,            // longer URLs are not used as preview keys
  CLOSED_LOG_TTL_MS: 7 * 24 * 60 * 60 * 1000, // our own closed-tab log keeps 7 days
  MAX_CLOSED_LOG: 200,          // ...and at most this many entries
  CLOSED_PREVIEW_LOOKUP: 60,    // previews are looked up for the newest this-many closed entries
  MAX_MRU: 500,
  CAPTURE_GAP_MS: 520,          // Chrome allows ~2 captureVisibleTab calls per second
  LAUNCH_TTL_MS: 15000,         // how long a launch token stays valid
  OPENING_LOCK_MS: 1500,        // presses during this window are queued, not re-opened
  STANDBY_DROP_MS: 60 * 1000,   // a prepared (invisible) switcher frame is dropped after its tab has been hidden this long
  OVERLAY_WATCHDOG_MS: 2500,
  OVERLAY_VISIBLE_MS: 1200,     // shown this long and Chrome has never reported it visible: a blocked click or key opens the popup window instead    // no READY by then -> overlay failed, use the popup window
  POINTER_VISIBLE_MS: 300,      // overlay must be fully visible this long before clicks count
  KEYS_GRACE_MS: 800,           // keys work right away (quick Alt+Q flick) until visibility is known
  RECENTLY_CLOSED: 8,           // most "Recently closed" entries shown
  RECENTLY_CLOSED_SEARCH: 24,   // ...or this many while searching (search reaches the whole 7-day log)
  RECENTLY_CLOSED_WINDOWS: 2,   // of which at most this many whole windows
  RECENTLY_CLOSED_MAX_AGE_S: 4 * 3600, // only things closed in the last 4 hours
  NOTE_MAX: 1000,               // characters in one tab note
  MAX_NOTES: 500,
  MAX_SNOOZED: 300,             // most snoozed tabs kept               // most tab notes kept (the oldest go first)
  MAX_STARS: 300,               // most starred pages kept (their previews are kept like an open tab's)
  MAX_COLLAPSED: 200,           // most collapsed sections remembered
  RESUME_TTL_MS: 15000,         // a resume note older than this is ignored
  SWEEP_MAX_TABS: 100,          // most tabs one "Capture all previews" run visits
  SWEEP_STALE_MS: 6 * 60 * 60 * 1000, // tabs whose preview is newer than this are skipped
  SWEEP_PAINT_MS: 300,         // wait after a tab finishes loading, so the screenshot isn't blank
  SWEEP_LOAD_MS: 2500,         // ...and give up waiting for a slow page after this long
  FLYOUT_WINDOW_MS: 30 * 60 * 1000, // the first-run flyout is offered for this long after install
  FLYOUT_SHOW_MS: 20000,        // ...and stays on a page this long unless dismissed
  STARTUP_OPEN_MS: 3500,        // "Open Tabazing when Chrome starts" waits this long for Chrome to restore the tabs
});

// The "use Alt+Q" nudge: Chrome never tells extensions about Ctrl+Tab, so a run of quick
// next/previous-tab switches is what it looks for. Counted on this device only.
export const NUDGE = Object.freeze({
  STEP_MS: 1500,                // a step is a switch to the tab right next to the last one, this soon after it
  RUN_STEPS: 3,                 // ...and this many steps in a row make a "run"
  SETTLE_MS: 900,               // the note waits until the switching has stopped this long
  QUIET_AFTER_EVENT_MS: 400,    // switches right after a tab was opened or closed don't count (Chrome picks the neighbour)
  RUNS_BEFORE: 2,               // shown on the second run of a day, not the first
  GAP_MS: 24 * 3600 * 1000,     // at most once a day
  MAX: 3,                       // and three times ever
  AFTER_USE_MS: 10 * 60 * 1000, // never within 10 minutes of opening Tabazing
  HABIT_OPENS: 30,              // after this many opens the habit is there: stop for good
  SHOW_MS: 12000,
});

// "How is Tabazing working for you?" timing. Counted on this device only (storage.local), same rules for everyone.
export const REVIEW = Object.freeze({
  ASK_AFTER_OPENS: 15,          // not before this many switcher opens...
  ASK_AFTER_MS: 3 * 24 * 3600 * 1000,  // ...and this long after install
  ASK_GAP_MS: 14 * 24 * 3600 * 1000,   // at most one ask per this long
  ASK_MAX: 0,                   // never: Tabazing is not on the Chrome Web Store
});

export const REVIEW_URL = 'https://chromewebstore.google.com/detail/edjglhlabdmgacehahfdjjffapbkaekk/reviews?utm_source=extension';
// The website (tabatha-vert.vercel.app). Links only: the extension never sends anything there itself.
export const SITE_URL = 'https://tabatha-vert.vercel.app';
export const HELP_URL = SITE_URL + '/manual';
const VERSION = chrome.runtime.getManifest().version;
// Pages on the site that Tabazing opens. Only where the click came from, the version and the
// language go in the URL; whatever people write is typed on the page itself, never put in a link.
// The language is the one Tabazing is shown in (its own setting, see lib/i18n.js), read at the moment of the click.
export const siteUrl = (path, from, extra = '') => `${SITE_URL}${path}?from=${from}&v=${VERSION}&lang=${uiLang()}${extra}`;
// "Send feedback" opens the site's feedback form; `from` and the version are prefilled from the URL.
export const feedbackUrl = () => siteUrl('/feedback', 'extension');
// Chrome opens this after someone removes Tabazing (chrome.runtime.setUninstallURL). Nothing is sent by the removal itself.
export const uninstallUrl = () => siteUrl('/uninstall', 'uninstall');

export const SWITCHER_PAGE = 'switcher.html';
export const SWEEP_PAGE = 'sweep.html';
