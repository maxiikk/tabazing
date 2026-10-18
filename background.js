// Tabazing background service worker (ES module).
// Responsibilities:
//   1. Track tab usage order (MRU) and screenshots  -> utils/store.js, utils/capture.js
//   2. Open the switcher when the shortcut is pressed -> openSwitcher()
//   3. Put focus back where it belongs when the switcher closes
//
// Trust: messages can come from the content script on any page (untrusted
// page context, possibly a compromised renderer) or from our own switcher
// page. Every message is checked for sender and shape; content scripts can
// only ask "open the switcher" and say what their own frame plays, nothing else.
//
// Everything here must be safe to run more than once: the worker can be
// suspended and restarted at any moment, and install/reload re-runs setup.

import { MSG, KEY, FRAME_MSG, LIMITS, NUDGE, SWITCHER_PAGE, SWEEP_PAGE, WINDOW_STATES, CLOSE_REASONS, SNOOZE_ALARM } from './utils/constants.js';
import {
  touchMru, removeFromMru, replaceInMru, seedMru, previewFresh, cleanupPreviews, markBoot,
  markDiscarded, moveDiscarded, ensureBoot,
  rememberTab, rememberTabs, forgetTabMeta, logClosedTab, flushClosedTabs, cleanupClosedLog,
  setOverlayTab, clearOverlayTab, createLaunch, getOnboard, updateOnboard,
  getNudge, updateNudge, getReview, getPrefs,
  takeDueSnoozed, markWoken, forgetWoken, parseMedia, setMedia, forgetMedia, replaceMedia, getMedia,
} from './utils/store.js';
import { dayOf } from './utils/review.js';
import { loadLang } from './utils/i18n.js';
import { t } from './utils/translations.js';
import { runSweep, cancelSweep, isSweeping, sweepJobs } from './utils/sweep.js';
import { scheduleCapture, cancelCapture, grabForOpen, storeShot } from './utils/capture.js';
import { isOwnUrl } from './utils/ext.js';
import { overlayHost, removeOverlay } from './utils/overlay-host.js';

// With use_dynamic_url this is a per-session random origin, so pages can't
// probe for the extension's permanent id.
const SWITCHER_URL = chrome.runtime.getURL(SWITCHER_PAGE);
// The origin extension frames actually run in (the real id). Used as the
// postMessage target so the launch token can only ever reach our own frame.
const EXT_REAL_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
const INJECTABLE = /^(https?|file):/;
// Tabazing's own pages (the switcher's window, the sweep window) aren't tabs the user works in.
const ownPage = (url) => isOwnUrl(url);

// First worker start of a browser session: remember when it began (see maybeCleanup in store.js).
ensureBoot().catch(() => {});
// Tabazing is a local, unlisted copy: no uninstall page is opened on removal.

// ---------------------------------------------------------- tab count on the toolbar icon
let badgeTimer = null;
function updateBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      const n = (await chrome.tabs.query({ windowType: 'normal' })).length;
      await chrome.action.setBadgeText({ text: n > 999 ? '999+' : String(n) });
    } catch {}
  }, 300);
}
Promise.resolve().then(() => chrome.action.setBadgeBackgroundColor({ color: '#1B2A4A' })).catch(() => {});
Promise.resolve().then(() => chrome.action.setBadgeTextColor({ color: '#D2FF3C' })).catch(() => {});
updateBadge();
// A worker that has just started is not sweeping: clear a "running" flag a dead worker left behind.
chrome.storage.session.get(KEY.SWEEP).then((o) => {
  if (o[KEY.SWEEP] && o[KEY.SWEEP].running && !isSweeping()) chrome.storage.session.set({ [KEY.SWEEP]: { running: false, done: 0, total: 0 } });
}).catch(() => {});

chrome.permissions.onAdded.addListener((p) => {
  // The user just allowed site access they had withheld ("On click" in chrome://extensions):
  // put the shortcut listener into the tabs that are already open, and take a first preview.
  if (p.origins && p.origins.length) {
    chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] }).then(injectPageScripts).catch(() => {});
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t && scheduleCapture(t.windowId, 300)).catch(() => {});
  }
});

// ---------------------------------------------------------------- tab events
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (isSweeping()) return; // "Capture all previews" is visiting tabs: that is not the user's order of use
  clearOverlayTab();
  forgetWoken(tabId).catch(() => {}); // a tab back from snooze has now been seen
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  prepareSwitcher(tab);
  if (ownPage(tab.url) || ownPage(tab.pendingUrl)) return;
  touchMru(tabId);
  scheduleCapture(windowId);
  watchCycling(tab);
});

chrome.tabs.onCreated.addListener((tab) => { rememberTab(tab).catch(() => {}); quietAt = Date.now(); updateBadge(); });

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.title || info.favIconUrl) rememberTab(tab).catch(() => {});
  // A new page in the tab being looked at: prepare the switcher in it as soon as it exists (a moment after
  // the load starts, when the new document is usually there), and again once loaded in case it wasn't.
  if (tab.active && info.status === 'loading') prepareSwitcher(tab, 250);
  else if (tab.active && info.status === 'complete') prepareSwitcher(tab);
  // Chrome unloaded (or reloaded) this tab while we were running: that's a real "Sleeping" tab.
  if (typeof info.discarded === 'boolean') markDiscarded(tabId, info.discarded).catch(() => {});
  if (info.discarded === true) forgetMedia(tabId).catch(() => {}); // unloaded: its media is gone (Chrome's controls drop it too)
  // Loading (a new page, a reload, or a page changing its own address, which Chrome may also count): what
  // was known about its media may be out of date. Forget it, and once loaded ask the tab's media-hook.js
  // copies what they play now: a new page has nothing (yet), a page that only changed its address still
  // has its media. Only tabs that had media are asked.
  // The forgetting is asynchronous, and 'complete' can come before it is done (a page changing its own
  // address loads in a few milliseconds): the tab is noted at once, and asked once both are done.
  if (info.status === 'loading') {
    const before = mediaResync.get(tabId) || false;
    mediaResync.set(tabId, Promise.all([before, forgetMedia(tabId).catch(() => false)]).then(([a, b]) => a || b));
  }
  if (info.status === 'complete' && mediaResync.has(tabId)) {
    const had = mediaResync.get(tabId);
    mediaResync.delete(tabId);
    had.then((yes) => { if (yes) resyncMedia(tabId); });
  }
  if (info.status === 'complete' && tab.active && !isSweeping()) {
    scheduleCapture(tab.windowId, 450);
    offerFlyout(tab);
  }
});
chrome.windows.onRemoved.addListener(updateBadge);

// Previews are keyed by URL, so a closed or replaced tab keeps its preview
// (it's what "Recently closed" shows); old ones expire in cleanupPreviews().
// Every closed tab goes into our own 7-day log, including tabs that close with
// their window (isWindowClosing): the switcher drops those from the list when
// Chrome still holds the whole window as one "Window" card.
chrome.tabs.onRemoved.addListener((tabId) => {
  quietAt = Date.now(); // Chrome now shows the closed tab's neighbour: not a Ctrl+Tab step
  updateBadge();
  removeFromMru(tabId);
  markDiscarded(tabId, false).catch(() => {});
  logClosedTab(tabId).catch(() => {});
  forgetMedia(tabId).catch(() => {});
  mediaResync.delete(tabId);
  forgetWoken(tabId).catch(() => {});
});
// Closes are logged in batches a moment later (logClosedTab): write a waiting one before Chrome stops the worker.
if (chrome.runtime.onSuspend) chrome.runtime.onSuspend.addListener(() => { flushClosedTabs().catch(() => {}); });

chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  replaceInMru(removedId, addedId);
  forgetTabMeta(removedId).catch(() => {});
  moveDiscarded(removedId, addedId).catch(() => {});
  chrome.tabs.get(addedId).then((t) => rememberTab(t)).catch(() => {});
});

// ------------------------------------------------------------- the "use Alt+Q" nudge
// Chrome never tells extensions about Ctrl+Tab / Ctrl+PgDn. What it looks like from here: several
// switches in a row, each to the tab right next to the previous one, each within a moment. When
// that happens a second time in a day, a small note says Alt+Q shows every tab at once. Rare by
// design: once a day at most, three times ever, never soon after using Tabazing, never again once
// the habit is there (NUDGE in constants.js), and "Don't show again" ends it.
let quietAt = 0;   // a tab was just opened or closed, or Tabazing just switched: the next activation isn't the user cycling
const steps = new Map(); // windowId -> { index, t, n }
async function watchCycling(tab) {
  const now = Date.now();
  const prev = steps.get(tab.windowId);
  let n = 0;
  if (prev && now - prev.t < NUDGE.STEP_MS && now - quietAt > NUDGE.QUIET_AFTER_EVENT_MS && tab.index !== prev.index) {
    const d = Math.abs(tab.index - prev.index);
    let adjacent = d === 1;
    if (!adjacent && (tab.index === 0 || prev.index === 0)) { // Ctrl+Tab wraps from the last tab to the first
      const count = await chrome.tabs.query({ windowId: tab.windowId }).then((x) => x.length).catch(() => 0);
      adjacent = d === count - 1;
    }
    if (adjacent) n = prev.n + 1;
  }
  steps.set(tab.windowId, { index: tab.index, t: now, n });
  // A run: wait until the switching stops, then speak up on the tab the user landed on.
  if (n >= NUDGE.RUN_STEPS || (settleTimer && settleWin === tab.windowId)) {
    clearTimeout(settleTimer);
    settleWin = tab.windowId;
    settleTimer = setTimeout(async () => {
      settleTimer = null;
      const [t] = await chrome.tabs.query({ active: true, windowId: settleWin }).catch(() => []);
      if (t) onCyclingRun(t).catch(() => {});
    }, NUDGE.SETTLE_MS);
  }
}
let settleTimer = null, settleWin = null;
async function onCyclingRun(tab) {
  const now = Date.now();
  const today = dayOf(now);
  const nd = await updateNudge((x) => ({ ...x, day: today, runs: x.day === today ? x.runs + 1 : 1 }));
  if (nd.never || nd.shown >= NUDGE.MAX || now - nd.last < NUDGE.GAP_MS || nd.runs < NUDGE.RUNS_BEFORE) return;
  const [rv, onb, lo] = await Promise.all([getReview(), getOnboard(), chrome.storage.session.get(KEY.LAST_OPEN)]);
  if (rv.opens >= NUDGE.HABIT_OPENS) return updateNudge((x) => ({ ...x, never: true }));
  if (now - (lo[KEY.LAST_OPEN] || 0) < NUDGE.AFTER_USE_MS) return;
  if (onb.at && now - onb.at < LIMITS.FLYOUT_WINDOW_MS) return; // the first-run flyout is still doing this job
  if (!tab.active || !INJECTABLE.test(tab.url || '') || tab.incognito) return;
  const mac = await chrome.runtime.getPlatformInfo().then((p) => p.os === 'mac').catch(() => false);
  await loadLang();
  const key = mac ? 'Option+Q' : 'Alt+Q';
  const text = { title: t('nudgeTitle'), body: t('nudgeBody', { key }), tryIt: t('nudgeTry'), ok: t('nudgeOk'), never: t('nudgeNever'), close: t('dismiss') };
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectNudge, args: [MSG.NUDGE, NUDGE.SHOW_MS, text, key] });
  await updateNudge((x) => ({ ...x, shown: x.shown + 1, last: now }));
}

// Runs inside the page (isolated world), like the first-run flyout: closed shadow root, textContent only.
function injectNudge(type, showMs, text, key) {
  if (window.__tabazingNudge) return;
  const host = document.createElement('div');
  host.dataset.testid = 'nudge-host';
  host.style.cssText = 'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483646';
  const root = host.attachShadow({ mode: 'closed' });
  const css = `
    .c{font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1B2A4A;background:#EBFFA6;width:300px;padding:14px 16px 12px;
       border:3px solid #1B2A4A;border-radius:4px;box-shadow:4px 4px 0 #1B2A4A;animation:in .25s steps(4) both}
    @keyframes in{from{transform:translateY(10px);opacity:0}to{transform:none;opacity:1}}
    .t{font-weight:700;font-size:15px;margin:0 22px 6px 0}.p{margin:0 0 10px}
    kbd{font:inherit;font-weight:700;background:#7DD3FC;border:2px solid #1B2A4A;border-radius:3px;padding:1px 7px}
    .r{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .b{font:inherit;font-weight:700;font-size:13px;border:2px solid #1B2A4A;background:#EAF6FF;color:#1B2A4A;padding:4px 10px;cursor:pointer}
    .b.p1{background:#7DD3FC}.q{border:0;background:none;text-decoration:underline;padding:4px 2px;font-weight:400;opacity:.75}
    .x{position:absolute;top:4px;right:6px;min-width:24px;min-height:24px;border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#1B2A4A}
    button:focus-visible{outline:2px solid #1B2A4A;outline-offset:2px}`;
  try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; }
  catch { const style = document.createElement('style'); style.textContent = css; root.append(style); }
  const box = document.createElement('div'); box.className = 'c'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', text.title); box.dataset.testid = 'nudge';
  const h = document.createElement('p'); h.className = 't'; h.textContent = text.title; h.dataset.testid = 'nudge-title';
  const p = document.createElement('p'); p.className = 'p'; p.dataset.testid = 'nudge-body';
  const [before, after] = text.body.split(key);
  const k = document.createElement('kbd'); k.textContent = key; k.dataset.testid = 'nudge-key';
  p.append(before || '', k, after || '');
  const row = document.createElement('div'); row.className = 'r'; row.dataset.testid = 'nudge-buttons';
  const btn = (label, cls, act) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label; b.dataset.testid = 'nudge-' + act;
    b.addEventListener('click', (e) => { if (!e.isTrusted) return; done(); chrome.runtime.sendMessage({ type, act }).catch(() => {}); });
    return b;
  };
  row.append(btn(text.tryIt, 'b p1', 'try'), btn(text.ok, 'b', 'ok'), btn(text.never, 'b q', 'never'));
  const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.setAttribute('aria-label', text.close); x.textContent = '\u00d7'; x.dataset.testid = 'nudge-close';
  x.addEventListener('click', () => done());
  box.append(h, p, row, x); root.append(box);
  // It goes away by itself, but not while the pointer or the keyboard focus is on it; Esc closes it.
  let timer = setTimeout(() => done(), showMs);
  const hold = () => clearTimeout(timer);
  const release = () => { clearTimeout(timer); if (!box.matches(':hover') && !box.contains(root.activeElement)) timer = setTimeout(() => done(), showMs); };
  box.addEventListener('mouseenter', hold); box.addEventListener('focusin', hold);
  box.addEventListener('mouseleave', release); box.addEventListener('focusout', () => setTimeout(release, 0));
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
  function done() { clearTimeout(timer); host.remove(); delete window.__tabazingNudge; }
  window.__tabazingNudge = { host };
  (document.body || document.documentElement).append(host);
}

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE || isSweeping()) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab && !ownPage(tab.url)) {
      touchMru(tab.id);
      scheduleCapture(windowId);
    }
  } catch {}
});

// ------------------------------------------------------------- setup (idempotent)
// If Chrome left the shortcut unassigned (another extension or app owns it, or a policy
// blocks it), say so in the worker console instead of failing silently.
async function checkShortcut() {
  try {
    const cmds = await chrome.commands.getAll();
    const main = cmds.find((c) => c.name === 'open-switcher');
    if (!main || !main.shortcut) console.warn('[Tabazing] The Alt+Q shortcut is not assigned. Set it at chrome://extensions/shortcuts (the in-page Alt+Q fallback still works on web pages).');
  } catch {}
}

async function setup({ fresh = false } = {}) {
  checkShortcut();
  // After an install/update every tab already exists, so it's safe to expire old previews now.
  // At browser start Chrome may still be restoring tabs (their previews must count as "in use"),
  // so there the cleanup is left to the save path, which waits a minute (maybeCleanup in store.js).
  if (fresh) cleanupPreviews().catch(() => {});
  cleanupClosedLog().catch(() => {}); // ...and the 7-day closed-tab log
  chrome.tabs.query({ windowType: 'normal' }).then(rememberTabs).catch(() => {}); // what each open tab is, for the log
  const active = await chrome.tabs.query({ active: true, windowType: 'normal' });
  await seedMru(active.map((t) => t.id));
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused) scheduleCapture(focused.windowId, 200);
}

chrome.runtime.onStartup.addListener(async () => {
  await markBoot().catch(() => {}); // start of a browser session: tab ids and the "slept" list are new
  await setup();
  // Settings → "Open Tabazing when Chrome starts": once Chrome has put the tabs back, show them all.
  const prefs = await getPrefs().catch(() => ({ startup: false }));
  if (prefs.startup) setTimeout(() => trigger(1, null, 'startup'), LIMITS.STARTUP_OPEN_MS);
});
chrome.runtime.onInstalled.addListener(async (details) => {
  await setup({ fresh: true });
  chrome.storage.local.remove('ntpHidden').catch(() => {}); // left by the New Tab page (removed in 6.0.0)
  if (details.reason === 'install') {
    await updateOnboard({ at: Date.now(), flyout: false, tour: false }).catch(() => {});
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    if (t) offerFlyout(t);
  }
  await injectPageScripts(await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] }));
});

const mediaResync = new Map(); // tabId -> Promise<whether it had media>: tabs to ask again once they finish loading

// What every tab with media really plays now, asked of its frames (media-hook.js: state). Reports can be
// lost: an embedded player's frame removed (its last message goes with it), a crashed or unloaded tab. The
// answers replace what was known. A tab that can't run scripts any more (closed, crashed, unloaded) has
// nothing; one that doesn't answer in time (frozen in the background) keeps what was known.
const CHECK_MS = 600;
async function checkMedia() {
  const stored = await getMedia().catch(() => ({}));
  await Promise.all(Object.keys(stored).map(async (id) => {
    const tabId = Number(id);
    let results;
    try {
      results = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: pageMediaState }),
        new Promise((r) => setTimeout(() => r(null), CHECK_MS)),
      ]);
    } catch { results = []; }
    if (!results) return;
    const states = {};
    for (const r of results) {
      const s = r && typeof r.result === 'string' ? parseMedia(r.result) : null;
      if (s && s.media && Number.isInteger(r.frameId)) states[r.frameId] = s;
    }
    await replaceMedia(tabId, states).catch(() => {});
  }));
}
// Runs in the page (its main world): what this frame's media-hook.js says it plays, or null without one.
function pageMediaState() {
  const h = window[Symbol.for('tabazing.media')];
  try { return h && typeof h.state === 'function' ? h.state() : null; } catch { return null; }
}
// Ask every media-hook.js in a tab to say again what it plays: the event its sync listens for (see
// media-hook.js: sync), which also tells media-relay.js to pass the answer on even when it is the same text
// as the last one it sent (the background has just forgotten it).
function resyncMedia(tabId) {
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: 'MAIN',
    func: () => { document.dispatchEvent(new CustomEvent('tabazing:media-sync')); },
  }).catch(() => {});
}

// Tabs that were open before install/reload (or before site access was allowed) don't have the content
// scripts yet: put them in. Each guards itself, so injecting twice is harmless. The media relay goes in before
// the media hook, so it is listening when the hook says what the page already plays.
function injectPageScripts(tabs) {
  return Promise.allSettled(tabs.map(async (t) => {
    const target = { tabId: t.id, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['hotkey.js'] }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ['media-relay.js'] }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ['media-hook.js'], world: 'MAIN' }).catch(() => {});
  }));
}

// ------------------------------------------------------------ opening the switcher
let opening = null;   // { t, extra } while a switcher is loading (dedupes rapid presses)
let watchdog = null;  // { token, timer } for an overlay that hasn't reported READY yet
let overlayOpen = null; // { tabId, win, ctx } of the last overlay opened (MSG.FALLBACK reopens it as a popup)
let lastTrigger = 0;

// `hold`: opened by Alt+Q / Alt+W, which work like Alt+Tab (letting go of Alt switches to the selected
// tab). Alt+E, the toolbar icon and the rest open it to stay. dir 0 (Alt+E) moves nothing.
// `palette`: Alt+R, straight into the command palette (dir 0, never held).
function trigger(dir, tab, via = 'key', hold = false, palette = false) {
  // Both Chrome's shortcut and the in-page listener may see the same press;
  // this also rate-limits a misbehaving sender.
  if (Date.now() - lastTrigger < 120) return;
  lastTrigger = Date.now();
  openSwitcher(dir, tab, via, hold, palette).catch((e) => console.warn('[Tabazing] could not open the switcher:', e && e.message));
}

async function openSwitcher(dir, fromTab, via = 'key', hold = false, palette = false) {
  // 1. Already open anywhere? Just move its selection (or show its palette).
  // `palette` is only added when set, so every other message and launch stays exactly as it was.
  const pal = palette ? { palette: true } : {};
  try {
    const r = await chrome.runtime.sendMessage({ type: MSG.CYCLE, dir, hold, ...pal });
    if (r && r.ok) return;
  } catch { /* no switcher open */ }

  // 2. Still loading from a press a moment ago? Queue the move for it.
  if (opening && Date.now() - opening.t < LIMITS.OPENING_LOCK_MS) {
    opening.extra += dir;
    return;
  }
  opening = { t: Date.now(), extra: 0 };
  chrome.storage.session.set({ [KEY.LAST_OPEN]: Date.now() }).catch(() => {});

  let tab = fromTab;
  if (!tab || !tab.active) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.incognito) { opening = null; return; }

  // 3. Refresh the current tab's screenshot before anything covers it. Only the grab itself is waited
  //    for (quick); shrinking and saving it runs while the switcher opens, which shows it once saved
  //    (storage.onChanged in switcher.js). The overlay stays invisible until it is READY, but a grab
  //    that takes too long is dropped all the same, so it can never picture the overlay.
  cancelCapture(tab.windowId);
  const [win, fresh, prefs] = await Promise.all([
    chrome.windows.get(tab.windowId).catch(() => ({})),
    previewFresh(tab.url, 1500).catch(() => false),
    getPrefs().catch(() => ({})),
  ]);
  const ctx = {
    src: tab.id, win: tab.windowId, dir, via, hold,
    state: WINDOW_STATES.includes(win.state) ? win.state : 'normal', ...pal,
  };
  // The launch token and overlay note are only storage writes, nothing on screen: made during the grab.
  // Injecting waits for it (step 4), so the screenshot never has the overlay in it.
  const inPage = INJECTABLE.test(tab.url || '') && !prefs.ownWindow; // Settings: "always in its own window"
  const prep = inPage ? Promise.all([createLaunch({ ...ctx, mode: 'overlay' }), setOverlayTab(tab.id)]) : null;
  if (prep) prep.catch(() => {}); // awaited below; this only keeps an early failure from counting as unhandled
  if (!fresh) {
    let late = false;
    const shot = await Promise.race([
      grabForOpen(tab.windowId).then((s) => (late ? null : s)).catch(() => null),
      new Promise((r) => setTimeout(() => { late = true; r(null); }, 400)),
    ]);
    if (shot) storeShot(shot.tab, shot.dataUrl).catch(() => {});
  }

  // 4. Show it inside the page; fall back to a popup window where extensions
  //    can't inject (chrome://, Chrome's own New Tab, Web Store) or the overlay fails.
  if (inPage) {
    try {
      const [token] = await prep;
      armWatchdog(token, tab.id, win, ctx); // before injecting: READY can arrive very quickly
      overlayOpen = { tabId: tab.id, win, ctx };
      await injectInto(tab.id, token, hold);
      return;
    } catch {
      disarmWatchdog();
      await clearOverlayTab();
    }
  }
  await openPopupWindow(win, await createLaunch({ ...ctx, mode: 'window' }));
}

// Some pages block the overlay's scripts (e.g. a "Content-Security-Policy:
// sandbox" header) or never render it. If the switcher hasn't said READY in
// time, remove the overlay and use the popup window instead.
// Put the overlay into the page right away: injectImmediately, so a page that is still loading (just
// switched to, or being reloaded after Chrome unloaded it) doesn't make it wait for the whole page.
function injectInto(tabId, token, hold) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: overlayHost,
    args: [SWITCHER_URL, EXT_REAL_ORIGIN, FRAME_MSG, 'launch', token, hold, LIMITS.STANDBY_DROP_MS, t('overlayLabel')],
    injectImmediately: true,
  });
}

// Take a failed overlay away from the page it was injected into.
function dropOverlay(tabId) {
  return chrome.scripting.executeScript({ target: { tabId }, func: removeOverlay, injectImmediately: true }).catch(() => {});
}

// Keep a prepared switcher (invisible, inert) in the tab being looked at, so opening is instant: done when
// a tab is shown, when its page starts or finishes loading, and at start-up. Nothing happens in a page that
// already has one, or where Chrome lets no extension in (those open the popup window).
const standbyTimers = new Map(); // tabId -> timeout (bursts of tab events become one)
function prepareSwitcher(tab, delay = 0) {
  if (!tab || !tab.active || tab.incognito || !INJECTABLE.test(tab.url || '')) return;
  clearTimeout(standbyTimers.get(tab.id));
  standbyTimers.set(tab.id, setTimeout(() => {
    standbyTimers.delete(tab.id);
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: overlayHost,
      args: [SWITCHER_URL, EXT_REAL_ORIGIN, FRAME_MSG, 'standby', null, false, LIMITS.STANDBY_DROP_MS, t('overlayLabel')],
      injectImmediately: true,
    }).catch(() => {});
  }, delay));
}
const prepareActiveTabs = () => chrome.tabs.query({ active: true, windowType: 'normal' }).then((tabs) => tabs.forEach((t) => prepareSwitcher(t))).catch(() => {});

// Chrome stops an idle extension worker after about 30 s, and the next shortcut then has to start it
// (and load its code) first. Any extension call resets that timer, so a cheap one now and then keeps it
// ready, the same as it is while you use it.
setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20 * 1000);
prepareActiveTabs();

// ---------------------------------------------------------------- snoozed tabs
// Reopen the tabs whose time has come, in the window they were snoozed from (or the last one used),
// in the background. Also at every worker start, for any that came due while Chrome was closed.
async function wakeSnoozed() {
  const due = await takeDueSnoozed(Date.now()).catch(() => []);
  for (const x of due) {
    let windowId = x.windowId;
    if (windowId !== null) { try { await chrome.windows.get(windowId); } catch { windowId = null; } }
    if (windowId === null) { try { windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id; } catch {} }
    try {
      // Reopened unannounced: noted so the switcher can say which tabs are back (until they are looked at).
      if (windowId === null || windowId === undefined) await markWoken(((await chrome.windows.create({ url: x.url })).tabs || [])[0]?.id);
      else await markWoken((await chrome.tabs.create({ url: x.url, windowId, active: false, pinned: x.pinned })).id);
    } catch {}
  }
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === SNOOZE_ALARM) wakeSnoozed(); });
wakeSnoozed();

// No READY in time. A page that was still loading may have replaced the document the overlay went
// into: then it goes into the new one (a fresh launch token; the old one may have been used). One that
// is just slow gets one more moment. After that, or if the page can't take it, the popup window.
const WATCH_FIRST_MS = 1000;
function armWatchdog(token, tabId, win, ctx, tries = 0) {
  disarmWatchdog();
  watchdog = {
    token,
    timer: setTimeout(async () => {
      if (!watchdog || watchdog.token !== token) return;
      if (tries < 2) {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!(window.__tabazingOverlay && window.__tabazingOverlay.active), injectImmediately: true }).catch(() => []);
        if (!watchdog || watchdog.token !== token) return; // READY came meanwhile
        if (r && r.result === false) {
          try {
            const fresh = await createLaunch({ ...ctx, mode: 'overlay' });
            armWatchdog(fresh, tabId, win, ctx, tries + 1);
            await injectInto(tabId, fresh, ctx.hold);
            return;
          } catch { /* the page can't take it now: popup below */ }
        } else if (r && r.result === true && tries === 0) {
          return armWatchdog(token, tabId, win, ctx, tries + 1);
        }
      }
      if (!watchdog) return;
      watchdog = null;
      await dropOverlay(tabId);
      await clearOverlayTab();
      opening = null;
      await openPopupWindow(win, await createLaunch({ ...ctx, mode: 'window' })).catch(() => {});
    }, tries ? LIMITS.OVERLAY_WATCHDOG_MS : WATCH_FIRST_MS),
  };
}

function disarmWatchdog() {
  if (watchdog) clearTimeout(watchdog.timer);
  watchdog = null;
}

// The popup covers the window it was opened from, as the overlay would: same bounds, or maximized
// when that one is maximized or fullscreen (Chrome takes no bounds together with a state). A small source
// window (a narrow, snapped or app window) would give a cramped Tabazing, barely wider than the command
// palette: the popup is then at least POPUP_MIN_W x POPUP_MIN_H, centred on that window.
const POPUP_MIN_W = 1000, POPUP_MIN_H = 680;
async function openPopupWindow(win, token) {
  const url = SWITCHER_URL + '?t=' + token;
  try {
    if (win.state === 'maximized' || win.state === 'fullscreen') {
      await chrome.windows.create({ url, type: 'popup', focused: true, state: 'maximized' });
      return;
    }
    const w = win.width || 1280, h = win.height || 800;
    const width = Math.max(POPUP_MIN_W, w), height = Math.max(POPUP_MIN_H, h);
    await chrome.windows.create({
      url, type: 'popup', focused: true,
      width: Math.round(width), height: Math.round(height),
      // Grown past the source window: centred on it (Chrome refuses bounds far off-screen: see below).
      left: Math.round((win.left || 0) - (width - w) / 2), top: Math.round(Math.max(0, (win.top || 0) - (height - h) / 2)),
    });
  } catch {
    // Bounds rejected (window partly off-screen, odd multi-monitor layout):
    // let Chrome place it.
    await chrome.windows.create({ url, type: 'popup', focused: true });
  }
}

// ------------------------------------------------------------ closing the switcher
// Windows treats Alt+Esc as "send this window to the back", so pressing Esc
// while still holding Alt made Chrome look minimised. After a cancel we put
// the window back in front (and un-minimise it if needed).
async function restoreWindow(windowId, state) {
  try {
    const w = await chrome.windows.get(windowId);
    if (w.state === 'minimized') {
      await chrome.windows.update(windowId, { state: WINDOW_STATES.includes(state) ? state : 'normal' });
    }
    await chrome.windows.update(windowId, { focused: true });
  } catch {}
}

// ------------------------------------------------------------ first-run flyout
// Right after a fresh install a small card on the page says "Press Alt+Q". Pages
// extensions can't touch (the Web Store, chrome://) can't show it, so it is offered
// again on the next ordinary page the user loads, for a short while. It goes away
// when dismissed, after 20 s, or as soon as the switcher has been opened once.
let flyoutOver = false; // once true it stays true for this worker: no storage read per page load
async function offerFlyout(tab) {
  try {
    if (flyoutOver || !tab || !INJECTABLE.test(tab.url || '') || tab.incognito) return;
    const o = await getOnboard();
    if (!o.at || o.flyout || o.tour || Date.now() - o.at > LIMITS.FLYOUT_WINDOW_MS) { if (o.at) flyoutOver = true; return; }
    await loadLang();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: injectFlyout,
      args: [MSG.FLYOUT_DONE, LIMITS.FLYOUT_SHOW_MS, { title: t('flyoutTitle'), body: t('flyoutBody', { key: '$KEY$' }), sub: t('flyoutSub'), close: t('dismiss') }],
    });
  } catch {}
}

// Runs inside the page (isolated world). A closed shadow root keeps the page's CSS out and
// its scripts away from our nodes; text is set with textContent only.
function injectFlyout(doneType, showMs, text) {
  if (window.__tabazingFlyout) return;
  const mac = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  const host = document.createElement('div');
  host.dataset.testid = 'flyout-host';
  host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483646';
  const root = host.attachShadow({ mode: 'closed' });
  const css = `
    .c{font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1B2A4A;background:#EAF6FF;width:280px;padding:14px 16px 14px;
       border:3px solid #1B2A4A;border-radius:4px;box-shadow:4px 4px 0 #1B2A4A;animation:in .25s steps(4) both}
    @keyframes in{from{transform:translateY(-10px);opacity:0}to{transform:none;opacity:1}}
    .t{font-weight:700;font-size:15px;margin:0 22px 6px 0}.p{margin:0 0 10px}
    kbd{font:inherit;font-weight:700;background:#7DD3FC;border:2px solid #1B2A4A;border-radius:3px;padding:1px 7px}
    .s{font-size:12px;opacity:.75;margin:0}
    button{position:absolute;top:4px;right:6px;min-width:24px;min-height:24px;border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#1B2A4A}
    button:focus-visible{outline:2px solid #1B2A4A;outline-offset:2px}`;
  // A constructable stylesheet is not blocked by a page's Content-Security-Policy (an inline <style> can be).
  try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; }
  catch { const style = document.createElement('style'); style.textContent = css; root.append(style); }
  const box = document.createElement('div'); box.className = 'c'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', text.title); box.dataset.testid = 'flyout';
  const t = document.createElement('p'); t.className = 't'; t.textContent = text.title; t.dataset.testid = 'flyout-title';
  const p = document.createElement('p'); p.className = 'p'; p.dataset.testid = 'flyout-body';
  const k = document.createElement('kbd'); k.textContent = mac ? 'Option+Q' : 'Alt+Q'; k.dataset.testid = 'flyout-key';
  const [before, after] = text.body.split('$KEY$');
  p.append(before || '', k, after || '');
  const s = document.createElement('p'); s.className = 's'; s.textContent = text.sub; s.dataset.testid = 'flyout-sub';
  const x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', text.close); x.textContent = '\u00d7'; x.dataset.testid = 'flyout-close';
  box.append(t, p, s, x); root.append(box);
  const done = () => {
    clearTimeout(timer); host.remove(); delete window.__tabazingFlyout;
    chrome.runtime.sendMessage({ type: doneType }).catch(() => {});
  };
  x.addEventListener('click', done);
  // Left alone, it goes (and is offered again on the next page); not while the pointer or the keyboard
  // focus is on it. Esc dismisses it, like the ×.
  const expire = () => { host.remove(); delete window.__tabazingFlyout; };
  let timer = setTimeout(expire, showMs);
  const hold = () => clearTimeout(timer);
  const release = () => { clearTimeout(timer); if (!box.matches(':hover') && !box.contains(root.activeElement)) timer = setTimeout(expire, showMs); };
  box.addEventListener('mouseenter', hold); box.addEventListener('focusin', hold);
  box.addEventListener('mouseleave', release); box.addEventListener('focusout', () => setTimeout(release, 0));
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } });
  window.__tabazingFlyout = { host };
  (document.body || document.documentElement).append(host);
}

// --------------------------------------------------------------- entry points
// MV3 note: this worker is not persistent; Chrome stops it when idle and starts it again for
// an event. Keep every listener registered at the top level, synchronously (nothing awaited
// before it), or the event that woke the worker can be missed. If a user reports "Alt+Q
// does nothing until I click the toolbar icon": (1) is the shortcut assigned? (checkShortcut
// logs a warning, and chrome://extensions/shortcuts shows it); (2) managed browsers can
// restrict extension shortcuts by policy; (3) hotkey.js is the fallback and retries once
// (see send() there). A keep-alive alarm would need the `alarms` permission: last resort.
chrome.commands.onCommand.addListener((command, tab) => {
  // Alt+Q / Alt+W step through the cards as shown, from the current tab: Q back (-1), W forward (+1).
  if (command === 'open-switcher') trigger(-1, tab, 'key', true);              // Alt+Q: the card before the current one
  else if (command === 'open-switcher-reverse') trigger(1, tab, 'key', true);  // Alt+W: the card after it
  else if (command === 'open-switcher-stay') trigger(0, tab);                // Alt+E: open and stay open
  else if (command === 'open-palette') trigger(0, tab, 'key', false, true);  // Alt+R: the command palette
});

chrome.action.onClicked.addListener((tab) => trigger(1, tab, 'icon'));

async function captureOne(tabId, reopenTab) {
  const n = await runSweep({ only: [tabId], force: true, quiet: true });
  await reopenOver(reopenTab);
  return { ok: n > 0 };
}
// Open the switcher again over a tab (after Tabazing had to step aside to take screenshots).
async function reopenOver(tabId) {
  if (tabId === null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    opening = null;
    await openSwitcher(1, tab);
  } catch {}
}

const fromContentScript = (s) => !!s.tab && Number.isInteger(s.tab.id) && !isOwnUrl(s.url);
const fromSwitcher = (s) => isOwnUrl(s.url, SWITCHER_PAGE);

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case MSG.HOTKEY:
      // The only thing a page's content script may ask for.
      if (!fromContentScript(sender)) return;
      if (msg.palette === true) trigger(0, sender.tab, 'key', false, true); // Alt+R: nothing else is taken from it
      else trigger(msg.dir === -1 ? -1 : msg.dir === 0 ? 0 : 1, sender.tab, 'key', msg.hold === true);
      return;
    case MSG.READY:
      if (!fromSwitcher(sender)) return;
      disarmWatchdog();
      respond({ extra: opening ? Math.max(-20, Math.min(20, opening.extra)) : 0 });
      opening = null;
      return;
    case MSG.SWEEP: {
      // Answer first (how many tabs need a picture), so the switcher can say "nothing to capture"
      // instead of closing for nothing; then run, and open the switcher again over the tab it came from.
      if (!fromSwitcher(sender)) return;
      const only = Array.isArray(msg.tabIds) ? msg.tabIds.filter(Number.isInteger).slice(0, LIMITS.SWEEP_MAX_TABS) : null;
      sweepJobs({ only }).then((jobs) => {
        respond({ n: jobs.length });
        if (!jobs.length) return;
        setTimeout(() => runSweep({ only })
          .then(() => reopenOver(Number.isInteger(msg.reopen) ? msg.reopen : null))
          .catch((e) => console.warn('[Tabazing] preview sweep failed:', e && e.message)), 150);
      }, () => respond({ n: 0 }));
      return true;
    }
    case MSG.SLEEP: {
      // Tabs the user put to sleep in the switcher: unloaded once it has closed, so the switcher stays smooth.
      if (!fromSwitcher(sender) || !Array.isArray(msg.tabIds)) return;
      const ids = msg.tabIds.filter(Number.isInteger).slice(0, 500);
      setTimeout(async () => {
        for (const id of ids) {
          try { const t = await chrome.tabs.get(id); if (!t.active && !t.discarded) await chrome.tabs.discard(id); } catch {}
        }
      }, 400);
      return;
    }
    case MSG.CAPTURE_ONE:
      // One card's "Capture preview". If the tab is in the window the overlay sits in, showing it
      // closes the overlay; `reopen` then brings the switcher back over the original tab.
      if (!fromSwitcher(sender) || !Number.isInteger(msg.tabId)) return;
      captureOne(msg.tabId, Number.isInteger(msg.reopen) ? msg.reopen : null).then(respond, () => respond({ ok: false }));
      return true;
    case MSG.SWEEP_CANCEL:
      if (isOwnUrl(sender.url, SWEEP_PAGE)) cancelSweep();
      return;
    case MSG.MEDIA: {
      // What a frame plays (media-relay.js): only about the tab and frame it comes from, checked, kept in
      // memory for the switcher's player. A page can claim anything here, but only for itself.
      if (!fromContentScript(sender) || !Number.isInteger(sender.frameId) || sender.frameId < 0 || sender.tab.incognito) return;
      const state = parseMedia(msg.state);
      if (state) setMedia(sender.tab.id, sender.frameId, state).catch(() => {});
      return;
    }
    case MSG.MEDIA_CHECK:
      if (fromSwitcher(sender)) checkMedia().catch(() => {});
      return;
    case MSG.FLYOUT_DONE:
      if (fromContentScript(sender)) updateOnboard({ flyout: true }).catch(() => {});
      return;
    case MSG.NUDGE:
      if (!fromContentScript(sender)) return;
      if (msg.act === 'try') trigger(1, sender.tab);
      else if (msg.act === 'never') updateNudge((x) => ({ ...x, never: true })).catch(() => {});
      return;
    case MSG.FALLBACK: {
      // The overlay was drawn but Chrome never reported it visible, so it can't take clicks or keys (the
      // page covers it somehow). Take it away and show the switcher in its own window instead.
      if (!fromSwitcher(sender) || !overlayOpen || !sender.tab || sender.tab.id !== overlayOpen.tabId) return;
      const { tabId, win, ctx } = overlayOpen;
      overlayOpen = null;
      disarmWatchdog();
      opening = null;
      (async () => {
        await dropOverlay(tabId);
        await clearOverlayTab();
        await openPopupWindow(win, await createLaunch({ ...ctx, hold: false, mode: 'window' }));
      })().catch(() => {});
      return;
    }
    case MSG.CLOSED:
      if (!fromSwitcher(sender)) return;
      disarmWatchdog();
      opening = null;
      clearOverlayTab();
      quietAt = Date.now(); // the switch Tabazing just made isn't the user cycling with Ctrl+Tab
      if (msg.reason === 'cancel' && Number.isInteger(msg.win)) {
        const state = WINDOW_STATES.includes(msg.state) ? msg.state : 'normal';
        restoreWindow(msg.win, state);
        setTimeout(() => restoreWindow(msg.win, state), 250); // after the OS acts on Alt+Esc
      } else if (!CLOSE_REASONS.includes(msg.reason)) {
        console.warn('[Tabazing] unexpected close reason');
      }
      return;
  }
});

// For the unit tests (tests/): everything above, by name. Nothing in the extension imports this file.
export {
  SWITCHER_URL, EXT_REAL_ORIGIN, INJECTABLE, badgeTimer, updateBadge, quietAt, steps, watchCycling,
  settleTimer, onCyclingRun, injectNudge, checkShortcut, setup, opening, watchdog, overlayOpen, lastTrigger,
  trigger, openSwitcher, injectInto, dropOverlay, ownPage, standbyTimers, prepareSwitcher, prepareActiveTabs, wakeSnoozed,
  WATCH_FIRST_MS, armWatchdog, disarmWatchdog, openPopupWindow, overlayHost, removeOverlay, restoreWindow,
  flyoutOver, offerFlyout, injectFlyout, injectPageScripts, mediaResync, resyncMedia, checkMedia, pageMediaState, CHECK_MS, captureOne, reopenOver, fromContentScript, fromSwitcher,
};
