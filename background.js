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

import { MESSAGE, KEY, FRAME_MESSAGE, LIMITS, NUDGE, SWITCHER_PAGE, SWEEP_PAGE, WINDOW_STATES, CLOSE_REASONS, SNOOZE_ALARM } from './utils/constants.js';
import {
  touchMru, removeFromMru, replaceInMru, seedMru, previewFresh, cleanupPreviews, markBoot,
  markDiscarded, moveDiscarded, ensureBoot,
  rememberTab, rememberTabs, forgetTabMeta, logClosedTab, flushClosedTabs, cleanupClosedLog,
  setOverlayTab, clearOverlayTab, createLaunch, createStandby, getOnboard, updateOnboard,
  getNudge, updateNudge, getReview, getPreferences,
  takeDueSnoozed, putBackSnoozed, markWoken, forgetWoken, parseMedia, setMedia, forgetMedia, replaceMedia, getMedia,
} from './utils/store.js';
import { dayOf } from './utils/review.js';
import { loadLang, isRtl, uiLang } from './utils/i18n.js';
import { translate, addDictionaries } from './utils/translations.js';
import BACKGROUND_MESSAGES from './utils/background-messages.js';
import { runSweep, cancelSweep, isSweeping, sweepJobs } from './utils/sweep.js';
import { scheduleCapture, cancelCapture, grabForOpen, storeShot } from './utils/capture.js';
import { isOwnUrl } from './utils/extension.js';
import { overlayHost, removeOverlay } from './utils/overlay-host.js';
import { IS_FIREFOX, EXTENSION_ORIGIN } from './utils/browser.js';
import { keepFavicon } from './utils/favicons.js';
import { BRIDGED_CALLS, BRIDGED_EVENTS, BRIDGE_PORT } from './utils/api-bridge.js';
import { pageMediaAction } from './utils/media.js';
import { groupOf, putInGroup } from './utils/groups.js';
// The texts this worker shows, in every language (it can't read the dictionaries: Chrome can't start a service worker
// again after it was idle if it imports JSON).
addDictionaries(BACKGROUND_MESSAGES);

// With use_dynamic_url this is a per-session random origin, so pages can't
// probe for the extension's permanent id.
const SWITCHER_URL = chrome.runtime.getURL(SWITCHER_PAGE);
// The origin extension frames actually run in (Chrome: the real id; Firefox: its moz-extension uuid). Used as the
// postMessage target so the launch token can only ever reach our own frame.
const EXTENSION_REAL_ORIGIN = EXTENSION_ORIGIN;
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
      const tabCount = (await chrome.tabs.query({ windowType: 'normal' })).length;
      await chrome.action.setBadgeText({ text: tabCount > 999 ? '999+' : String(tabCount) });
    } catch {}
  }, 300);
}
Promise.resolve().then(() => chrome.action.setBadgeBackgroundColor({ color: '#1B2A4A' })).catch(() => {});
Promise.resolve().then(() => chrome.action.setBadgeTextColor({ color: '#D2FF3C' })).catch(() => {});
updateBadge();
// A worker that has just started is not sweeping: clear a "running" flag a dead worker left behind.
chrome.storage.session.get(KEY.SWEEP).then((sweepStorage) => {
  if (sweepStorage[KEY.SWEEP] && sweepStorage[KEY.SWEEP].running && !isSweeping()) chrome.storage.session.set({ [KEY.SWEEP]: { running: false, done: 0, total: 0 } });
}).catch(() => {});

chrome.permissions.onAdded.addListener((permissions) => {
  // The user just allowed site access they had withheld ("On click" in chrome://extensions):
  // put the shortcut listener into the tabs that are already open, and take a first preview.
  if (permissions.origins && permissions.origins.length) {
    chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] }).then(injectPageScripts).catch(() => {});
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab && scheduleCapture(tab.windowId, 300)).catch(() => {});
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

chrome.tabs.onCreated.addListener((tab) => { remember(tab); quietAt = Date.now(); updateBadge(); });

// What the closed-tabs log needs of a tab, with its group's name and colour when it is in one.
// A grouped tab waits for its group, one out of a group doesn't: an older snapshot can come in after a newer
// one, and is then dropped (only the latest remember() of each tab writes).
const rememberSequence = new Map(); // tabId -> number of its latest remember()
function remember(tab) {
  const sequence = (rememberSequence.get(tab.id) || 0) + 1;
  rememberSequence.set(tab.id, sequence);
  const groupPromise = tab.groupId >= 0 && chrome.tabGroups ? chrome.tabGroups.get(tab.groupId).catch(() => null) : null;
  Promise.resolve(groupPromise).then((group) => { if (rememberSequence.get(tab.id) === sequence) return rememberTab(tab, groupOf(group)); }).catch(() => {});
}
chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.url || changes.title || changes.favIconUrl || changes.groupId !== undefined) remember(tab);
  // Firefox: the site's icon, kept for the switcher (utils/favicons.js); Chrome draws them itself.
  if (IS_FIREFOX && tab.favIconUrl && (changes.favIconUrl || changes.status === 'complete')) keepFavicon(tab).catch(() => {});
  // A new page in the tab being looked at: prepare the switcher in it as soon as it exists (a moment after
  // the load starts, when the new document is usually there), and again once loaded in case it wasn't.
  if (tab.active && changes.status === 'loading') prepareSwitcher(tab, 250);
  else if (tab.active && changes.status === 'complete') prepareSwitcher(tab);
  // Chrome unloaded (or reloaded) this tab while we were running: that's a real "Sleeping" tab.
  if (typeof changes.discarded === 'boolean') markDiscarded(tabId, changes.discarded).catch(() => {});
  if (changes.discarded === true) forgetMedia(tabId).catch(() => {}); // unloaded: its media is gone (Chrome's controls drop it too)
  // Loading (a new page, a reload, or a page changing its own address, which Chrome may also count): what
  // was known about its media may be out of date. Forget it, and once loaded ask the tab's media-hook.js
  // copies what they play now: a new page has nothing (yet), a page that only changed its address still
  // has its media. Only tabs that had media are asked.
  // The forgetting is asynchronous, and 'complete' can come before it is done (a page changing its own
  // address loads in a few milliseconds): the tab is noted at once, and asked once both are done.
  if (changes.status === 'loading') {
    const before = mediaResync.get(tabId) || false;
    mediaResync.set(tabId, Promise.all([before, forgetMedia(tabId).catch(() => false)]).then(([hadMediaBefore, hadMediaNow]) => hadMediaBefore || hadMediaNow));
  }
  if (changes.status === 'complete' && mediaResync.has(tabId)) {
    const hadMediaPromise = mediaResync.get(tabId);
    mediaResync.delete(tabId);
    hadMediaPromise.then((hadMedia) => { if (hadMedia) resyncMedia(tabId); });
  }
  if (changes.status === 'complete' && tab.active && !isSweeping()) {
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
  rememberSequence.delete(tabId); // a remember() still waiting for its group writes nothing now
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
  rememberSequence.delete(removedId);
  forgetTabMeta(removedId).catch(() => {});
  moveDiscarded(removedId, addedId).catch(() => {});
  chrome.tabs.get(addedId).then(remember).catch(() => {});
});
// A group renamed or recoloured: its tabs' entries follow.
if (chrome.tabGroups) chrome.tabGroups.onUpdated.addListener((group) => {
  chrome.tabs.query({ groupId: group.id }).then((tabs) => tabs.forEach((tab) => rememberTab(tab, groupOf(group)).catch(() => {}))).catch(() => {});
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
  const previousStep = steps.get(tab.windowId);
  let runLength = 0;
  if (previousStep && now - previousStep.t < NUDGE.STEP_MILLISECONDS && now - quietAt > NUDGE.QUIET_AFTER_EVENT_MILLISECONDS && tab.index !== previousStep.index) {
    const distance = Math.abs(tab.index - previousStep.index);
    let adjacent = distance === 1;
    if (!adjacent && (tab.index === 0 || previousStep.index === 0)) { // Ctrl+Tab wraps from the last tab to the first
      const count = await chrome.tabs.query({ windowId: tab.windowId }).then((x) => x.length).catch(() => 0);
      adjacent = distance === count - 1;
    }
    if (adjacent) runLength = previousStep.n + 1;
  }
  steps.set(tab.windowId, { index: tab.index, t: now, n: runLength });
  // A run: wait until the switching stops, then speak up on the tab the user landed on.
  if (runLength >= NUDGE.RUN_STEPS || (settleTimer && settleWindow === tab.windowId)) {
    clearTimeout(settleTimer);
    settleWindow = tab.windowId;
    settleTimer = setTimeout(async () => {
      settleTimer = null;
      const [activeTab] = await chrome.tabs.query({ active: true, windowId: settleWindow }).catch(() => []);
      if (activeTab) onCyclingRun(activeTab).catch(() => {});
    }, NUDGE.SETTLE_MILLISECONDS);
  }
}
let settleTimer = null, settleWindow = null;
// The language of the cards put on pages (the nudge, the first-run flyout), and its direction: Arabic and Hebrew right to left.
const pageDirection = () => ({ dir: isRtl() ? 'rtl' : 'ltr', lang: uiLang() });
async function onCyclingRun(tab) {
  const now = Date.now();
  const today = dayOf(now);
  const nudgeState = await updateNudge((x) => ({ ...x, day: today, runs: x.day === today ? x.runs + 1 : 1 }));
  if (nudgeState.never || nudgeState.shown >= NUDGE.MAX || now - nudgeState.last < NUDGE.GAP_MILLISECONDS || nudgeState.runs < NUDGE.RUNS_BEFORE) return;
  const [reviewState, onboardState, lastOpenStorage] = await Promise.all([getReview(), getOnboard(), chrome.storage.session.get(KEY.LAST_OPEN)]);
  if (reviewState.opens >= NUDGE.HABIT_OPENS) return updateNudge((x) => ({ ...x, never: true }));
  if (now - (lastOpenStorage[KEY.LAST_OPEN] || 0) < NUDGE.AFTER_USE_MILLISECONDS) return;
  if (onboardState.at && now - onboardState.at < LIMITS.FLYOUT_WINDOW_MILLISECONDS) return; // the first-run flyout is still doing this job
  if (!tab.active || !INJECTABLE.test(tab.url || '') || tab.incognito) return;
  const isMac = await chrome.runtime.getPlatformInfo().then((platform) => platform.os === 'mac').catch(() => false);
  await loadLang();
  const key = isMac ? 'Option+Q' : 'Alt+Q';
  const text = { title: translate('nudgeTitle'), body: translate('nudgeBody', { key }), tryIt: translate('nudgeTry'), ok: translate('nudgeOk'), never: translate('nudgeNever'), close: translate('dismiss'), ...pageDirection() };
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectNudge, args: [MESSAGE.NUDGE, NUDGE.SHOW_MILLISECONDS, text, key] });
  await updateNudge((x) => ({ ...x, shown: x.shown + 1, last: now }));
}

// Runs inside the page (isolated world), like the first-run flyout: closed shadow root, textContent only.
function injectNudge(type, showMilliseconds, text, key) {
  if (window.__tabazingNudge) return;
  const host = document.createElement('div');
  host.dataset.testid = 'nudge-host';
  host.style.cssText = 'all:initial;position:fixed;bottom:20px;z-index:2147483646;' + (text.dir === 'rtl' ? 'left:20px' : 'right:20px');
  const root = host.attachShadow({ mode: 'closed' });
  // A card in the switcher's look (today's Material UI, dark), the same on every page.
  const css = `
    .c{position:relative;font:400 14px/1.43 Roboto,"Segoe UI",system-ui,-apple-system,sans-serif;color:#f2f4f8;background:#151b25;border:1px solid #242c39;
       width:320px;padding:18px 18px 14px;border-radius:14px;box-shadow:0 4px 10px rgba(0,0,0,.35),0 14px 36px rgba(0,0,0,.55);
       animation:in .25s cubic-bezier(.05,.7,.1,1) both}
    @keyframes in{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
    .t{font-weight:600;font-size:16px;line-height:24px;margin-block:0 6px;margin-inline:0 32px}.p{margin:0 0 14px;color:#a2acbd}
    kbd{font:500 12px ui-monospace,Consolas,monospace;background:#1e2532;color:#f2f4f8;border:1px solid #3a4557;border-bottom-width:2px;border-radius:5px;padding:1px 6px}
    .r{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    .b{font:inherit;font-weight:500;font-size:13px;height:32px;padding:0 12px;border:1px solid #242c39;border-radius:8px;background:#11161e;color:#f2f4f8;cursor:pointer}
    .b:hover{background:#1e2532;border-color:#3a4557}
    .b.p1{background:linear-gradient(to bottom,#a4e0fc,#7DD3FC);border-color:#4f9fc2;color:#0b2733;box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}.b.p1:hover{background:#7DD3FC}
    .q{background:none;border-color:transparent;color:#a2acbd}.q:hover{background:rgba(162,172,189,.1);border-color:transparent}
    .x{position:absolute;top:10px;inset-inline-end:10px;width:32px;height:32px;border:0;border-radius:8px;background:none;font-size:18px;line-height:1;cursor:pointer;color:#a2acbd}
    .x:hover{background:rgba(162,172,189,.1);color:#f2f4f8}
    button:focus-visible{outline:3px solid rgba(125,211,252,.5);outline-offset:2px}`;
  try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; }
  catch { const style = document.createElement('style'); style.textContent = css; root.append(style); }
  const box = document.createElement('div'); box.className = 'c'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', text.title); box.dataset.testid = 'nudge';
  box.dir = text.dir || 'ltr'; box.lang = text.lang || ''; // (all:initial on the host resets the page's direction)
  const titleParagraph = document.createElement('p'); titleParagraph.className = 't'; titleParagraph.textContent = text.title; titleParagraph.dataset.testid = 'nudge-title';
  const bodyParagraph = document.createElement('p'); bodyParagraph.className = 'p'; bodyParagraph.dataset.testid = 'nudge-body';
  const [before, after] = text.body.split(key);
  const keyElement = document.createElement('kbd'); keyElement.textContent = key; keyElement.dataset.testid = 'nudge-key';
  bodyParagraph.append(before || '', keyElement, after || '');
  const row = document.createElement('div'); row.className = 'r'; row.dataset.testid = 'nudge-buttons';
  const makeButton = (label, className, action) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.dataset.testid = 'nudge-' + action;
    button.addEventListener('click', (event) => { if (!event.isTrusted) return; done(); chrome.runtime.sendMessage({ type, action }).catch(() => {}); });
    return button;
  };
  row.append(makeButton(text.tryIt, 'b p1', 'try'), makeButton(text.ok, 'b', 'ok'), makeButton(text.never, 'b q', 'never'));
  const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.setAttribute('aria-label', text.close); x.textContent = '\u00d7'; x.dataset.testid = 'nudge-close';
  x.addEventListener('click', () => done());
  box.append(titleParagraph, bodyParagraph, row, x); root.append(box);
  // It goes away by itself, but not while the pointer or the keyboard focus is on it; Esc closes it.
  let timer = setTimeout(() => done(), showMilliseconds);
  const hold = () => clearTimeout(timer);
  const release = () => { clearTimeout(timer); if (!box.matches(':hover') && !box.contains(root.activeElement)) timer = setTimeout(() => done(), showMilliseconds); };
  box.addEventListener('mouseenter', hold); box.addEventListener('focusin', hold);
  box.addEventListener('mouseleave', release); box.addEventListener('focusout', () => setTimeout(release, 0));
  box.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); done(); } });
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
    const commands = await chrome.commands.getAll();
    const main = commands.find((command) => command.name === 'open-switcher');
    if (!main || !main.shortcut) console.warn('[Tabazing] The Alt+Q shortcut is not assigned. Set it at chrome://extensions/shortcuts (the in-page Alt+Q fallback still works on web pages).');
  } catch {}
}

// One at a time, so a window of many tabs doesn't fetch all their icons at once.
async function keepFavicons(tabs) {
  for (const tab of tabs) await keepFavicon(tab).catch(() => {});
}
async function setup({ fresh = false } = {}) {
  checkShortcut();
  // After an install/update every tab already exists, so it's safe to expire old previews now.
  // At browser start Chrome may still be restoring tabs (their previews must count as "in use"),
  // so there the cleanup is left to the save path, which waits a minute (maybeCleanup in store.js).
  if (fresh) cleanupPreviews().catch(() => {});
  cleanupClosedLog().catch(() => {}); // ...and the 7-day closed-tab log
  Promise.all([chrome.tabs.query({ windowType: 'normal' }), chrome.tabGroups ? chrome.tabGroups.query({}).catch(() => []) : []]) // what each open tab is, for the log
    .then(([tabs, groups]) => {
      if (IS_FIREFOX) keepFavicons(tabs); // (Firefox: the icons of the sites already open)
      return rememberTabs(tabs, new Map(groups.map((group) => [group.id, groupOf(group)])));
    }).catch(() => {});
  const active = await chrome.tabs.query({ active: true, windowType: 'normal' });
  await seedMru(active.map((tab) => tab.id));
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused) scheduleCapture(focused.windowId, 200);
}

chrome.runtime.onStartup.addListener(async () => {
  await markBoot().catch(() => {}); // start of a browser session: tab ids and the "slept" list are new
  await setup();
  // Settings → "Open Tabazing when Chrome starts": once Chrome has put the tabs back, show them all.
  const preferences = await getPreferences().catch(() => ({ startup: false }));
  if (preferences.startup) setTimeout(() => trigger(1, null, 'startup'), LIMITS.STARTUP_OPEN_MILLISECONDS);
});
chrome.runtime.onInstalled.addListener(async (details) => {
  await setup({ fresh: true });
  chrome.storage.local.remove('ntpHidden').catch(() => {}); // left by the New Tab page (removed in 6.0.0)
  if (details.reason === 'install') {
    await updateOnboard({ at: Date.now(), flyout: false, tour: false }).catch(() => {});
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    if (tab) offerFlyout(tab);
  }
  await injectPageScripts(await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] }));
});

const mediaResync = new Map(); // tabId -> Promise<whether it had media>: tabs to ask again once they finish loading

// What every tab with media really plays now, asked of its frames (media-hook.js: state). Reports can be
// lost: an embedded player's frame removed (its last message goes with it), a crashed or unloaded tab. The
// answers replace what was known. A tab that can't run scripts any more (closed, crashed, unloaded) has
// nothing; one that doesn't answer in time (frozen in the background) keeps what was known.
const CHECK_MILLISECONDS = 600;
async function checkMedia() {
  const stored = await getMedia().catch(() => ({}));
  await Promise.all(Object.keys(stored).map(async (id) => {
    const tabId = Number(id);
    let results;
    try {
      results = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: pageMediaState }),
        new Promise((resolve) => setTimeout(() => resolve(null), CHECK_MILLISECONDS)),
      ]);
    } catch { results = []; }
    if (!results) return;
    const states = {};
    for (const frameResult of results) {
      const mediaState = frameResult && typeof frameResult.result === 'string' ? parseMedia(frameResult.result) : null;
      if (mediaState && mediaState.media && Number.isInteger(frameResult.frameId)) states[frameResult.frameId] = mediaState;
    }
    await replaceMedia(tabId, states).catch(() => {});
  }));
}
// Runs in the page (its main world): what this frame's media-hook.js says it plays, or null without one.
function pageMediaState() {
  const mediaHook = window[Symbol.for('tabazing.media')];
  try { return mediaHook && typeof mediaHook.state === 'function' ? mediaHook.state() : null; } catch { return null; }
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
  return Promise.allSettled(tabs.map(async (tab) => {
    const target = { tabId: tab.id, allFrames: true };
    await chrome.scripting.executeScript({ target, files: ['hotkey.js'] }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ['media-relay.js'] }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ['media-hook.js'], world: 'MAIN' }).catch(() => {});
  }));
}

// ------------------------------------------------------------ opening the switcher
let opening = null;   // { t, extra, palette, stay } while a switcher is loading (dedupes rapid presses, keeps them for READY)
let watchdog = null;  // { token, timer } for an overlay that hasn't reported READY yet
let overlayOpen = null; // { tabId, win, ctx } of the last overlay opened (MESSAGE.FALLBACK reopens it as a popup)
let lastTrigger = 0;
// Less than `ms` ago. A time after now (the system clock was set back since) counts as long ago, or one
// press too soon would block every press until the clock caught up again.
const within = (age, milliseconds) => age >= 0 && age < milliseconds;

// `hold`: opened by Alt+Q / Alt+W, which work like Alt+Tab (letting go of Alt switches to the selected
// tab). Alt+E, the toolbar icon and the rest open it to stay. dir 0 (Alt+E) moves nothing.
// `palette`: Alt+R, straight into the command palette (dir 0, never held).
function trigger(direction, tab, via = 'key', hold = false, palette = false) {
  // Both Chrome's shortcut and the in-page listener may see the same press;
  // this also rate-limits a misbehaving sender. A last press "in the future" (the clock was set back) is long ago.
  if (within(Date.now() - lastTrigger, 120)) return;
  lastTrigger = Date.now();
  openSwitcher(direction, tab, via, hold, palette).catch((error) => console.warn('[Tabazing] could not open the switcher:', error && error.message));
}

async function openSwitcher(direction, fromTab, via = 'key', hold = false, palette = false) {
  // 1. Already open anywhere? Just move its selection (or show its palette).
  // `palette` is only added when set, so every other message and launch stays exactly as it was.
  const paletteOption = palette ? { palette: true } : {};
  const cycle = { type: MESSAGE.CYCLE, direction, hold, ...paletteOption };
  const answers = await Promise.all([chrome.runtime.sendMessage(cycle).catch(() => null), askBridged(cycle)]); // (no switcher open: none answers)
  if (answers.some((response) => response && response.ok)) return;

  // 2. Still loading from a press a moment ago? Queue the move for it, and an Alt+R (palette) or Alt+E
  //    (stay open), which move nothing: READY hands them all over.
  if (opening && within(Date.now() - opening.t, LIMITS.OPENING_LOCK_MILLISECONDS)) {
    opening.extra += direction;
    if (palette) opening.palette = true;
    else if (direction === 0) opening.stay = true;
    return;
  }
  opening = { t: Date.now(), extra: 0, palette: false, stay: false };
  chrome.storage.session.set({ [KEY.LAST_OPEN]: Date.now() }).catch(() => {});

  let tab = fromTab;
  if (!tab || !tab.active) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.incognito) { opening = null; return; }

  // 3. Refresh the current tab's screenshot, alongside opening (not before it: it took up to 400 ms). The
  //    overlay stays invisible until the switcher has drawn AND the page is told the screenshot is taken
  //    ('shot-taken'); a grab that takes longer than 400 ms is thrown away, and the page shows the overlay
  //    then anyway, so the screenshot can never picture it. Shrinking and saving it run while the switcher
  //    opens, which shows it once saved (storage.onChanged in switcher.js).
  cancelCapture(tab.windowId);
  const [browserWindow, fresh, preferences] = await Promise.all([
    chrome.windows.get(tab.windowId).catch(() => ({})),
    previewFresh(tab.url, 1500).catch(() => false),
    getPreferences().catch(() => ({})),
  ]);
  const launchContext = {
    sourceTab: tab.id, window: tab.windowId, direction, via, hold,
    state: WINDOW_STATES.includes(browserWindow.state) ? browserWindow.state : 'normal', ...paletteOption,
  };
  const inPage = INJECTABLE.test(tab.url || '') && !preferences.ownWindow; // Settings: "always in its own window"
  const preparation = inPage ? Promise.all([createLaunch({ ...launchContext, mode: 'overlay' }), setOverlayTab(tab.id)]) : null;
  if (preparation) preparation.catch(() => {}); // awaited below; this only keeps an early failure from counting as unhandled
  let shotTaken = Promise.resolve();
  if (!fresh) {
    let late = false;
    shotTaken = Promise.race([
      grabForOpen(tab.windowId).then((capturedShot) => (late ? null : capturedShot)).catch(() => null),
      new Promise((resolve) => setTimeout(() => { late = true; resolve(null); }, 400)),
    ]).then((shot) => { if (shot) storeShot(shot.tab, shot.dataUrl).catch(() => {}); });
  }

  // 4. Show it inside the page; fall back to a popup window where extensions can't inject (chrome://, Chrome's
  //    own New Tab, Web Store), where the overlay fails, or where the page is frozen (too busy to run the
  //    overlay's code within PAGE_FROZEN_MILLISECONDS: it couldn't show it anyway). The popup's launch replaces
  //    the overlay's (one launch at a time), so an overlay the page runs late finds its token gone, and stays hidden.
  if (inPage) {
    try {
      const [token] = await preparation;
      armWatchdog(token, tab.id, browserWindow, launchContext); // before injecting: READY can arrive very quickly
      overlayOpen = { tabId: tab.id, window: browserWindow, context: launchContext };
      await Promise.race([
        injectInto(tab.id, token, hold, !fresh),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('page frozen')), LIMITS.PAGE_FROZEN_MILLISECONDS)),
      ]);
      shotTaken.then(() => tellShotTaken(tab.id, token));
      if (hold) altLetGo(tab.id).then((letGo) => { if (letGo) tellAltLetGo(tab.id, token); });
      return;
    } catch {
      disarmWatchdog();
      overlayOpen = null;
      await clearOverlayTab();
    }
  }
  // A quick tap is over by the time the window opens, which never hears that key-up: it is told.
  const released = hold && (await altLetGo(tab.id));
  await openPopupWindow(browserWindow, await createLaunch({ ...launchContext, mode: 'window', ...(released ? { released: true } : {}) }));
}

// Some pages block the overlay's scripts (e.g. a "Content-Security-Policy:
// sandbox" header) or never render it. If the switcher hasn't said READY in
// time, remove the overlay and use the popup window instead.
// Put the overlay into the page right away: injectImmediately, so a page that is still loading (just
// switched to, or being reloaded after Chrome unloaded it) doesn't make it wait for the whole page.
function injectInto(tabId, token, hold, shotPending = false) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: overlayHost,
    args: [SWITCHER_URL, EXTENSION_REAL_ORIGIN, FRAME_MESSAGE, 'launch', token, hold, LIMITS.STANDBY_DROP_MILLISECONDS, translate('overlayLabel'), shotPending],
    injectImmediately: true,
  });
}
// The page's screenshot is taken: the overlay it launched with `token` may show once drawn.
function tellShotTaken(tabId, token) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: overlayHost,
    args: [SWITCHER_URL, EXTENSION_REAL_ORIGIN, FRAME_MESSAGE, 'shot-taken', token, false, LIMITS.STANDBY_DROP_MILLISECONDS],
    injectImmediately: true,
  }).catch(() => {});
}

// Alt+Q / Alt+W: had the page already seen Alt let go, in any of its frames (the focus may be in an embedded one,
// whose key-up the overlay never hears)? The frame that saw Alt last tells; false when that can't be known in time.
// Still down there: asked again a few times, a moment apart (that frame may not have had the key-up yet; by the time
// it is asked last the overlay has the focus, and hears a key-up itself).
async function altLetGo(tabId, tries = 4) {
  const latest = await Promise.race([
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, injectImmediately: true,
      func: () => { const hotkey = window.__tabazingHotkey; return hotkey && typeof hotkey.altSeen === 'function' ? hotkey.altSeen() : null; },
    }).catch(() => []),
    new Promise((resolve) => setTimeout(() => resolve([]), 100)),
  ]).then((results) => (results || []).map((result) => result && result.result).filter((seen) => seen && Number.isFinite(seen.at) && seen.at > 0).sort((first, second) => second.at - first.at)[0]);
  if (latest && latest.state === 'up') return true;
  if (!latest || latest.state !== 'down' || tries <= 1) return false;
  await new Promise((resolve) => setTimeout(resolve, 60));
  return altLetGo(tabId, tries - 1);
}
// ...then the overlay launched with `token` is told, as if its page had seen it.
function tellAltLetGo(tabId, token) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: overlayHost,
    args: [SWITCHER_URL, EXTENSION_REAL_ORIGIN, FRAME_MESSAGE, 'released', token, false, LIMITS.STANDBY_DROP_MILLISECONDS],
    injectImmediately: true,
  }).catch(() => {});
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
  standbyTimers.set(tab.id, setTimeout(async () => {
    standbyTimers.delete(tab.id);
    // Its standby token lets the frame read and draw the tabs ahead (invisible): opening then only shows it.
    const token = await createStandby(tab.id, tab.windowId).catch(() => null);
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: overlayHost,
      args: [SWITCHER_URL, EXTENSION_REAL_ORIGIN, FRAME_MESSAGE, 'standby', token, false, LIMITS.STANDBY_DROP_MILLISECONDS, translate('overlayLabel')],
      injectImmediately: true,
    }).catch(() => {});
  }, delay));
}
const prepareActiveTabs = () => chrome.tabs.query({ active: true, windowType: 'normal' }).then((tabs) => tabs.forEach((tab) => prepareSwitcher(tab))).catch(() => {});

// Chrome stops an idle extension worker after about 30 s, and the next shortcut then has to start it
// (and load its code) first. Any extension call resets that timer, so a cheap one now and then keeps it
// ready, the same as it is while you use it.
setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20 * 1000);
prepareActiveTabs();

// ---------------------------------------------------------------- snoozed tabs
// Reopen the tabs whose time has come, in the window they were snoozed from (or the last one used),
// in the background. Also at every worker start, for any that came due while Chrome was closed.
// Taken from the list one at a time, so a worker stopped halfway loses none it hadn't got to; one that can't
// be opened anywhere goes back into the list, for the next alarm (each is tried once per run).
async function wakeSnoozed() {
  const now = Date.now();
  const failed = [];
  for (;;) {
    const [x] = await takeDueSnoozed(now, { max: 1, skip: failed }).catch(() => []);
    if (!x) return;
    if (await wakeOne(x)) continue;
    failed.push(x.id);
    await putBackSnoozed(x).catch(() => {});
  }
}
const lastNormalWindow = () => chrome.windows.getLastFocused({ windowTypes: ['normal'] }).then((foundWindow) => (foundWindow && Number.isInteger(foundWindow.id) ? foundWindow.id : null)).catch(() => null);
// Open one snoozed tab: in its window, else the last one used, else a new window. Resolves to whether it opened.
async function wakeOne(x) {
  let windowId = x.windowId;
  if (windowId !== null) { try { await chrome.windows.get(windowId); } catch { windowId = null; } }
  if (windowId === null) windowId = await lastNormalWindow();
  // Reopened unannounced: noted so the switcher can say which tabs are back (until they are looked at).
  const inWindow = async (id) => {
    const tab = await chrome.tabs.create({ url: x.url, windowId: id, active: false, pinned: x.pinned });
    await markWoken(tab.id).catch(() => {});
    if (x.group && !x.pinned) await putInGroup([tab.id], x.group, id).catch(() => {}); // back in its group
  };
  if (Number.isInteger(windowId)) {
    try { await inWindow(windowId); return true; } catch {}
    // The window closed in between (or refused the tab): another one, if there is one.
    const other = await lastNormalWindow();
    if (Number.isInteger(other) && other !== windowId) { try { await inWindow(other); return true; } catch {} }
  }
  try {
    const createdWindow = await chrome.windows.create({ url: x.url });
    await markWoken(((createdWindow && createdWindow.tabs) || [])[0]?.id).catch(() => {});
    return true;
  } catch { return false; }
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === SNOOZE_ALARM) wakeSnoozed(); });
wakeSnoozed();

// No READY in time. A page that was still loading may have replaced the document the overlay went
// into: then it goes into the new one (a fresh launch token; the old one may have been used). One that
// is just slow gets one more moment. After that, or if the page can't take it, the popup window.
const WATCH_FIRST_MILLISECONDS = 1000;
function armWatchdog(token, tabId, browserWindow, launchContext, tries = 0) {
  disarmWatchdog();
  watchdog = {
    token,
    timer: setTimeout(async () => {
      if (!watchdog || watchdog.token !== token) return;
      if (tries < 2) {
        const [scriptResult] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!(window.__tabazingOverlay && window.__tabazingOverlay.active), injectImmediately: true }).catch(() => []);
        if (!watchdog || watchdog.token !== token) return; // READY came meanwhile
        if (scriptResult && scriptResult.result === false) {
          try {
            const fresh = await createLaunch({ ...launchContext, mode: 'overlay' });
            armWatchdog(fresh, tabId, browserWindow, launchContext, tries + 1);
            await injectInto(tabId, fresh, launchContext.hold);
            return;
          } catch { /* the page can't take it now: popup below */ }
        } else if (scriptResult && scriptResult.result === true && tries === 0) {
          return armWatchdog(token, tabId, browserWindow, launchContext, tries + 1);
        }
      }
      if (!watchdog) return;
      watchdog = null;
      await dropOverlay(tabId);
      await clearOverlayTab();
      opening = null;
      await openPopupWindow(browserWindow, await createLaunch({ ...launchContext, mode: 'window' })).catch(() => {});
    }, tries ? LIMITS.OVERLAY_WATCHDOG_MILLISECONDS : WATCH_FIRST_MILLISECONDS),
  };
}

function disarmWatchdog() {
  if (watchdog) clearTimeout(watchdog.timer);
  watchdog = null;
}

// The popup covers the window it was opened from, as the overlay would: same bounds, or maximized
// when that one is maximized or fullscreen (Chrome takes no bounds together with a state). A small source
// window (a narrow, snapped or app window) would give a cramped Tabazing, barely wider than the command
// palette: the popup is then at least POPUP_MIN_WIDTH x POPUP_MIN_HEIGHT, centred on that window.
const POPUP_MIN_WIDTH = 1000, POPUP_MIN_HEIGHT = 680;
async function openPopupWindow(browserWindow, token) {
  const url = SWITCHER_URL + '?t=' + token;
  try {
    if (browserWindow.state === 'maximized' || browserWindow.state === 'fullscreen') {
      await chrome.windows.create({ url, type: 'popup', focused: true, state: 'maximized' });
      return;
    }
    const sourceWidth = browserWindow.width || 1280, sourceHeight = browserWindow.height || 800;
    const width = Math.max(POPUP_MIN_WIDTH, sourceWidth), height = Math.max(POPUP_MIN_HEIGHT, sourceHeight);
    await chrome.windows.create({
      url, type: 'popup', focused: true,
      width: Math.round(width), height: Math.round(height),
      // Grown past the source window: centred on it (Chrome refuses bounds far off-screen: see below).
      left: Math.round((browserWindow.left || 0) - (width - sourceWidth) / 2), top: Math.round(Math.max(0, (browserWindow.top || 0) - (height - sourceHeight) / 2)),
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
    const browserWindow = await chrome.windows.get(windowId);
    if (browserWindow.state === 'minimized') {
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
    const onboardState = await getOnboard();
    if (!onboardState.at || onboardState.flyout || onboardState.tour || Date.now() - onboardState.at > LIMITS.FLYOUT_WINDOW_MILLISECONDS) { if (onboardState.at) flyoutOver = true; return; }
    await loadLang();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: injectFlyout,
      args: [MESSAGE.FLYOUT_DONE, LIMITS.FLYOUT_SHOW_MILLISECONDS, { title: translate('flyoutTitle'), body: translate('flyoutBody', { key: '$KEY$' }), subtitle: translate('flyoutSubtitle'), close: translate('dismiss'), ...pageDirection() }],
    });
  } catch {}
}

// Runs inside the page (isolated world). A closed shadow root keeps the page's CSS out and
// its scripts away from our nodes; text is set with textContent only.
function injectFlyout(doneType, showMilliseconds, text) {
  if (window.__tabazingFlyout) return;
  const isMac = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  const host = document.createElement('div');
  host.dataset.testid = 'flyout-host';
  host.style.cssText = 'all:initial;position:fixed;top:16px;z-index:2147483646;' + (text.dir === 'rtl' ? 'left:16px' : 'right:16px');
  const root = host.attachShadow({ mode: 'closed' });
  // A card in the switcher's look (today's Material UI, dark), the same on every page.
  const css = `
    .c{position:relative;font:400 14px/1.43 Roboto,"Segoe UI",system-ui,-apple-system,sans-serif;color:#f2f4f8;background:#151b25;border:1px solid #242c39;
       width:300px;padding:18px 18px 16px;border-radius:14px;box-shadow:0 4px 10px rgba(0,0,0,.35),0 14px 36px rgba(0,0,0,.55);
       animation:in .25s cubic-bezier(.05,.7,.1,1) both}
    @keyframes in{from{transform:translateY(-12px);opacity:0}to{transform:none;opacity:1}}
    .t{font-weight:600;font-size:16px;line-height:24px;margin-block:0 6px;margin-inline:0 32px}.p{margin:0 0 10px;color:#a2acbd}
    kbd{font:500 12px ui-monospace,Consolas,monospace;background:#7DD3FC;color:#0b2733;border:1px solid #4f9fc2;border-bottom-width:2px;border-radius:5px;padding:1px 6px}
    .s{font-size:12px;color:#8d98ab;margin:0}
    button{position:absolute;top:10px;inset-inline-end:10px;width:32px;height:32px;border:0;border-radius:8px;background:none;font-size:18px;line-height:1;cursor:pointer;color:#a2acbd}
    button:hover{background:rgba(162,172,189,.1);color:#f2f4f8}
    button:focus-visible{outline:3px solid rgba(125,211,252,.5);outline-offset:2px}`;
  // A constructable stylesheet is not blocked by a page's Content-Security-Policy (an inline <style> can be).
  try { const sheet = new CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; }
  catch { const style = document.createElement('style'); style.textContent = css; root.append(style); }
  const box = document.createElement('div'); box.className = 'c'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', text.title); box.dataset.testid = 'flyout';
  box.dir = text.dir || 'ltr'; box.lang = text.lang || ''; // (all:initial on the host resets the page's direction)
  const titleParagraph = document.createElement('p'); titleParagraph.className = 't'; titleParagraph.textContent = text.title; titleParagraph.dataset.testid = 'flyout-title';
  const bodyParagraph = document.createElement('p'); bodyParagraph.className = 'p'; bodyParagraph.dataset.testid = 'flyout-body';
  const keyElement = document.createElement('kbd'); keyElement.textContent = isMac ? 'Option+Q' : 'Alt+Q'; keyElement.dataset.testid = 'flyout-key';
  const [before, after] = text.body.split('$KEY$');
  bodyParagraph.append(before || '', keyElement, after || '');
  const subtitleParagraph = document.createElement('p'); subtitleParagraph.className = 's'; subtitleParagraph.textContent = text.subtitle; subtitleParagraph.dataset.testid = 'flyout-subtitle';
  const x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', text.close); x.textContent = '\u00d7'; x.dataset.testid = 'flyout-close';
  box.append(titleParagraph, bodyParagraph, subtitleParagraph, x); root.append(box);
  const done = () => {
    clearTimeout(timer); host.remove(); delete window.__tabazingFlyout;
    chrome.runtime.sendMessage({ type: doneType }).catch(() => {});
  };
  x.addEventListener('click', done);
  // Left alone, it goes (and is offered again on the next page); not while the pointer or the keyboard
  // focus is on it. Esc dismisses it, like the ×.
  const expire = () => { host.remove(); delete window.__tabazingFlyout; };
  let timer = setTimeout(expire, showMilliseconds);
  const hold = () => clearTimeout(timer);
  const release = () => { clearTimeout(timer); if (!box.matches(':hover') && !box.contains(root.activeElement)) timer = setTimeout(expire, showMilliseconds); };
  box.addEventListener('mouseenter', hold); box.addEventListener('focusin', hold);
  box.addEventListener('mouseleave', release); box.addEventListener('focusout', () => setTimeout(release, 0));
  box.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); done(); } });
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
  const sweptCount = await runSweep({ only: [tabId], force: true, quiet: true });
  await reopenOver(reopenTab);
  return { ok: sweptCount > 0 };
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

const fromContentScript = (sender) => !!sender.tab && Number.isInteger(sender.tab.id) && !isOwnUrl(sender.url);
const fromSwitcher = (sender) => isOwnUrl(sender.url, SWITCHER_PAGE);

// ---------------------------------------------------------- the switcher framed in a page, in Firefox (utils/api-bridge.js)
// It has the APIs of a content script only, and hears nothing broadcast: through its port (only the switcher page may open
// one) this worker makes the calls it asks for (BRIDGED_CALLS, nothing else), passes on the events it listens to, and asks
// it what the switcher in a window hears as a message (MESSAGE.CYCLE).
const bridgePorts = new Set();
// The functions the switcher has run in pages (a function can't go by message: it is named).
const INJECTED = { pageMediaAction };
async function callBridged(path, args) {
  const dot = path.lastIndexOf('.');
  const namespacePath = path.slice(0, dot), method = path.slice(dot + 1);
  if (!Object.hasOwn(BRIDGED_CALLS, namespacePath) || !BRIDGED_CALLS[namespacePath].includes(method) || !Array.isArray(args)) throw new Error('not allowed: ' + path);
  const namespace = namespacePath.split('.').reduce((object, part) => object && object[part], chrome);
  if (!namespace || typeof namespace[method] !== 'function') throw new Error('not available: ' + path);
  if (path === 'scripting.executeScript') {
    const func = args[0] && INJECTED[args[0].func];
    if (!func) throw new Error('not allowed: that function');
    args = [{ ...args[0], func }];
  }
  return namespace[method](...args);
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BRIDGE_PORT || !port.sender || !fromSwitcher(port.sender)) return port.disconnect();
  bridgePorts.add(port);
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (Number.isInteger(message.id) && typeof message.call === 'string') {
      callBridged(message.call, message.args)
        .then((result) => port.postMessage({ id: message.id, result: result === undefined ? null : result }))
        .catch((error) => port.postMessage({ id: message.id, error: String((error && error.message) || error) }));
    } else if (message.answer !== undefined) {
      const waiting = bridgeQuestions.get(message.answer);
      if (waiting) waiting(message.value);
    }
  });
  port.onDisconnect.addListener(() => bridgePorts.delete(port));
});
const bridgeQuestions = new Map(); // question id -> what takes an answer
let nextQuestion = 1;
// What the framed switchers answer `body`: the first answer that is { ok: true }, or null (none open, none answers in time).
function askBridged(body) {
  if (!bridgePorts.size) return Promise.resolve(null);
  return new Promise((resolve) => {
    let left = bridgePorts.size;
    const ids = [];
    const done = (value) => { ids.forEach((id) => bridgeQuestions.delete(id)); clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => done(null), 300);
    for (const port of bridgePorts) {
      const id = nextQuestion++;
      ids.push(id);
      bridgeQuestions.set(id, (value) => { if (value && value.ok) done(value); else if (--left === 0) done(null); });
      try { port.postMessage({ question: id, body }); } catch { if (--left === 0) done(null); }
    }
  });
}
// The events they listen to. Registered at once (a worker that starts again must have its listeners at the start).
if (IS_FIREFOX) {
  for (const name of BRIDGED_EVENTS) {
    const [namespace, event] = name.split('.');
    if (!chrome[namespace] || !chrome[namespace][event]) continue;
    chrome[namespace][event].addListener((...args) => {
      if (name === 'storage.onChanged' && args[1] !== 'session') return; // (the local area they hear themselves)
      for (const port of bridgePorts) { try { port.postMessage({ event: name, args }); } catch {} }
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || typeof message.type !== 'string') return;
  switch (message.type) {
    case MESSAGE.HOTKEY:
      // The only thing a page's content script may ask for.
      if (!fromContentScript(sender)) return;
      if (message.palette === true) trigger(0, sender.tab, 'key', false, true); // Alt+R: nothing else is taken from it
      else trigger(message.direction === -1 ? -1 : message.direction === 0 ? 0 : 1, sender.tab, 'key', message.hold === true);
      return;
    case MESSAGE.READY:
      if (!fromSwitcher(sender)) return;
      disarmWatchdog();
      // `palette` / `stay`: an Alt+R / Alt+E pressed while it loaded (only added when there was one).
      respond({
        extra: opening ? Math.max(-20, Math.min(20, opening.extra)) : 0,
        ...(opening && opening.palette ? { palette: true } : {}), ...(opening && opening.stay ? { stay: true } : {}),
      });
      opening = null;
      return;
    case MESSAGE.SWEEP: {
      // Answer first (how many tabs need a picture), so the switcher can say "nothing to capture"
      // instead of closing for nothing; then run, and open the switcher again over the tab it came from.
      if (!fromSwitcher(sender)) return;
      const only = Array.isArray(message.tabIds) ? message.tabIds.filter(Number.isInteger).slice(0, LIMITS.SWEEP_MAX_TABS) : null;
      sweepJobs({ only }).then((jobs) => {
        respond({ n: jobs.length });
        if (!jobs.length) return;
        setTimeout(() => runSweep({ only })
          .then(() => reopenOver(Number.isInteger(message.reopen) ? message.reopen : null))
          .catch((error) => console.warn('[Tabazing] preview sweep failed:', error && error.message)), 150);
      }, () => respond({ n: 0 }));
      return true;
    }
    case MESSAGE.SLEEP: {
      // Tabs the user put to sleep in the switcher: unloaded once it has closed, so the switcher stays smooth.
      if (!fromSwitcher(sender) || !Array.isArray(message.tabIds)) return;
      const ids = message.tabIds.filter(Number.isInteger).slice(0, 500);
      setTimeout(async () => {
        for (const id of ids) {
          try { const tab = await chrome.tabs.get(id); if (!tab.active && !tab.discarded) await chrome.tabs.discard(id); } catch {}
        }
      }, 400);
      return;
    }
    case MESSAGE.CAPTURE_ONE:
      // One card's "Capture preview". If the tab is in the window the overlay sits in, showing it
      // closes the overlay; `reopen` then brings the switcher back over the original tab.
      if (!fromSwitcher(sender) || !Number.isInteger(message.tabId)) return;
      captureOne(message.tabId, Number.isInteger(message.reopen) ? message.reopen : null).then(respond, () => respond({ ok: false }));
      return true;
    case MESSAGE.SWEEP_CANCEL:
      if (isOwnUrl(sender.url, SWEEP_PAGE)) cancelSweep();
      return;
    case MESSAGE.MEDIA: {
      // What a frame plays (media-relay.js): only about the tab and frame it comes from, checked, kept in
      // memory for the switcher's player. A page can claim anything here, but only for itself.
      if (!fromContentScript(sender) || !Number.isInteger(sender.frameId) || sender.frameId < 0 || sender.tab.incognito) return;
      const state = parseMedia(message.state);
      if (state) setMedia(sender.tab.id, sender.frameId, state).catch(() => {});
      return;
    }
    case MESSAGE.MEDIA_CHECK:
      if (fromSwitcher(sender)) checkMedia().catch(() => {});
      return;
    case MESSAGE.FLYOUT_DONE:
      if (fromContentScript(sender)) updateOnboard({ flyout: true }).catch(() => {});
      return;
    case MESSAGE.NUDGE:
      if (!fromContentScript(sender)) return;
      if (message.action === 'try') trigger(1, sender.tab);
      else if (message.action === 'never') updateNudge((x) => ({ ...x, never: true })).catch(() => {});
      return;
    case MESSAGE.FALLBACK: {
      // The overlay was drawn but Chrome never reported it visible, so it can't take clicks or keys (the
      // page covers it somehow). Take it away and show the switcher in its own window instead.
      if (!fromSwitcher(sender) || !overlayOpen || !sender.tab || sender.tab.id !== overlayOpen.tabId) return;
      const { tabId, window: browserWindow, context: launchContext } = overlayOpen;
      overlayOpen = null;
      disarmWatchdog();
      opening = null;
      (async () => {
        await dropOverlay(tabId);
        await clearOverlayTab();
        await openPopupWindow(browserWindow, await createLaunch({ ...launchContext, hold: false, mode: 'window' }));
      })().catch(() => {});
      return;
    }
    case MESSAGE.CLOSED:
      if (!fromSwitcher(sender)) return;
      disarmWatchdog();
      opening = null;
      clearOverlayTab();
      quietAt = Date.now(); // the switch Tabazing just made isn't the user cycling with Ctrl+Tab
      if (message.reason === 'cancel' && Number.isInteger(message.window)) {
        const state = WINDOW_STATES.includes(message.state) ? message.state : 'normal';
        restoreWindow(message.window, state);
        setTimeout(() => restoreWindow(message.window, state), 250); // after the OS acts on Alt+Esc
      } else if (!CLOSE_REASONS.includes(message.reason)) {
        console.warn('[Tabazing] unexpected close reason');
      }
      return;
  }
});

// For the unit tests (tests/): everything above, by name. Nothing in the extension imports this file.
export {
  SWITCHER_URL, EXTENSION_REAL_ORIGIN, INJECTABLE, badgeTimer, updateBadge, quietAt, steps, watchCycling,
  settleTimer, onCyclingRun, injectNudge, checkShortcut, setup, opening, watchdog, overlayOpen, lastTrigger,
  trigger, openSwitcher, injectInto, dropOverlay, ownPage, standbyTimers, prepareSwitcher, prepareActiveTabs, wakeSnoozed, wakeOne, lastNormalWindow,
  WATCH_FIRST_MILLISECONDS, altLetGo, tellAltLetGo, callBridged, askBridged, bridgePorts, armWatchdog, disarmWatchdog, openPopupWindow, overlayHost, removeOverlay, restoreWindow,
  flyoutOver, offerFlyout, injectFlyout, injectPageScripts, mediaResync, resyncMedia, checkMedia, pageMediaState, CHECK_MILLISECONDS, captureOne, reopenOver, fromContentScript, fromSwitcher,
};
