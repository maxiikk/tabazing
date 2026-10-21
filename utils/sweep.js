// "Capture all previews". Chrome only lets an extension screenshot the tab that is on screen, so the
// only way to preview a tab nobody has looked at is to show it for a moment. When the user asks, this
// visits each awake tab, captures it, and puts every window back on the tab it was showing.
//
// While it runs, normal tab-tracking is paused (isSweeping): the visits must not reorder the
// most-recently-used list, and the MRU is restored afterwards. Sleeping (discarded) tabs are skipped
// because showing them would reload them. Runs only on request; nothing here is automatic.

import { KEY, LIMITS, SWEEP_PAGE } from './constants.js';
import { getMru, setMru, previewTimes } from './store.js';
import { captureTab } from './capture.js';
import { isCapturableUrl } from './ext.js';

const S = chrome.storage.session;
const CAPTURABLE = /^https?:/;
let sweeping = false;
let cancelled = false;

export const isSweeping = () => sweeping;
export const cancelSweep = () => { cancelled = true; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const progress = (p) => S.set({ [KEY.SWEEP]: p }).catch(() => {});

// Tabs worth visiting: awake, capturable, not the one each window already shows, no recent preview.
// `only` limits the run to these tab ids (what the switcher shows right now, or one card);
// `force` captures them even if their preview is recent, and even the one a window shows.
export async function sweepJobs({ only = null, force = false } = {}) {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const now = Date.now();
  const want = only ? new Set(only) : null;
  const shotAt = force ? null : await previewTimes().catch(() => null); // one read of the index, not one per tab
  const jobs = [];
  for (const w of wins) {
    if (w.state === 'minimized' || w.incognito) continue;
    for (const t of w.tabs || []) {
      if (want && !want.has(t.id)) continue;
      if ((t.active && !force) || t.discarded || !isCapturableUrl(t.url || '')) continue;
      if (shotAt && now - shotAt(t.url) < LIMITS.SWEEP_STALE_MS) continue;
      jobs.push({ windowId: w.id, tabId: t.id, url: t.url });
    }
  }
  return jobs.slice(0, LIMITS.SWEEP_MAX_TABS);
}

async function waitLoaded(tabId) {
  const until = Date.now() + LIMITS.SWEEP_LOAD_MS;
  for (;;) {
    let t;
    try { t = await chrome.tabs.get(tabId); } catch { return null; }
    if (t.status === 'complete' || Date.now() > until) return t;
    await sleep(100);
  }
}

// `quiet`: no progress window (one card's "Capture preview"). Resolves to the number of tabs captured.
export async function runSweep({ only = null, force = false, quiet = false } = {}) {
  if (sweeping) return 0;
  sweeping = true;
  cancelled = false;
  let win = null;
  const originals = new Map(); // windowId -> tab it was showing
  let focusedWin = null;
  // The MRU is put back in the order it had, but tabs keep changing while the sweep runs: one Chrome replaces
  // (prerendering, a discarded tab coming back) goes back under its new id, one closed meanwhile stays out.
  const replaced = new Map(); // old id -> new id
  const removed = new Set();
  const onReplaced = (addedId, removedId) => { replaced.set(removedId, addedId); };
  const onRemoved = (tabId) => { removed.add(tabId); };
  const current = (id) => { for (let i = 0; i < 10 && replaced.has(id); i++) id = replaced.get(id); return id; }; // replaced again: the last id
  chrome.tabs.onReplaced.addListener(onReplaced);
  chrome.tabs.onRemoved.addListener(onRemoved);
  let mruBefore = null;
  let done = 0;
  try {
    mruBefore = await getMru();
    const jobs = await sweepJobs({ only, force });
    if (!jobs.length) { await progress({ running: false, done: 0, total: 0 }); return 0; }
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    for (const w of wins) {
      const a = (w.tabs || []).find((t) => t.active);
      if (a) originals.set(w.id, a.id);
      if (w.focused) focusedWin = w.id;
    }
    const startedAt = Date.now(); // the progress window estimates the time left from it
    await progress({ running: true, done: 0, total: jobs.length, startedAt });
    if (!quiet) { // a clear progress card in the middle of the window the user is looking at, with Stop
      const W = 460, H = 250;
      const fw = wins.find((w) => w.id === focusedWin) || wins[0] || {};
      const left = Math.round((fw.left || 0) + ((fw.width || 1280) - W) / 2), top = Math.round((fw.top || 0) + ((fw.height || 800) - H) / 2);
      try { win = await chrome.windows.create({ url: chrome.runtime.getURL(SWEEP_PAGE), type: 'popup', width: W, height: H, left, top, focused: true }); }
      catch { try { win = await chrome.windows.create({ url: chrome.runtime.getURL(SWEEP_PAGE), type: 'popup', width: W, height: H, focused: true }); } catch {} }
    }

    for (const j of jobs) {
      if (cancelled) break;
      // Shown, a tab may start media Chrome was holding back (autoplay waits for a visible tab): it is
      // muted for its moment on screen, and put back as it was however the visit ends.
      let unmute = false;
      try {
        const before = await chrome.tabs.get(j.tabId);
        if (!(before.mutedInfo && before.mutedInfo.muted)) { await chrome.tabs.update(j.tabId, { muted: true }); unmute = true; }
        await chrome.tabs.update(j.tabId, { active: true });
        const tab = await waitLoaded(j.tabId);
        if (tab && CAPTURABLE.test(tab.url || '')) {
          await sleep(LIMITS.SWEEP_PAINT_MS);
          await captureTab(j.windowId, tab);
        }
      } catch { /* tab closed meanwhile */ } finally {
        if (unmute) await chrome.tabs.update(j.tabId, { muted: false }).catch(() => {});
      }
      await progress({ running: true, done: ++done, total: jobs.length, startedAt });
      await sleep(LIMITS.CAPTURE_GAP_MS); // Chrome allows about 2 captures a second
    }
  } finally {
    for (const [windowId, tabId] of originals) {
      try { await chrome.tabs.update(current(tabId), { active: true }); } catch {}
    }
    if (focusedWin !== null) { try { await chrome.windows.update(focusedWin, { focused: true }); } catch {} }
    if (win && win.id !== undefined) { try { await chrome.windows.remove(win.id); } catch {} }
    if (mruBefore) await setMru([...new Set(mruBefore.map(current))].filter((id) => !removed.has(id))).catch(() => {});
    chrome.tabs.onReplaced.removeListener(onReplaced);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    await progress({ running: false, done: 0, total: 0 });
    sweeping = false;
  }
  return done;
}
