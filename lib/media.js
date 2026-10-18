// The switcher's media player: what plays in which tab (reported by media-hook.js, kept by the
// background in storage.session), and its buttons, which run in the page's own world.
import { getMedia } from './store.js';
import { LIMITS } from './constants.js';

export const MEDIA_ACTIONS = Object.freeze(['play', 'pause', 'previoustrack', 'nexttrack']);

// Play, pause or skip in one frame of a tab. Resolves to true when the page acted; rejects when Chrome
// can't run anything there (the tab is gone, or site access was withheld).
export async function mediaAction(tabId, frameId, action) {
  if (!MEDIA_ACTIONS.includes(action)) return false;
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [Number.isInteger(frameId) && frameId >= 0 ? frameId : 0] },
    world: 'MAIN', func: pageMediaAction, args: [action],
  });
  return !!r && r.result === true;
}

// Runs inside the page (its main world), serialized by Chrome: nothing from this module is in reach.
// Through media-hook.js when the page has it (the page's own previous / next buttons work then); a tab
// that was open before Tabazing was installed or updated doesn't: its longest (or playing) <video> or
// <audio> can still play and pause.
export function pageMediaAction(action) {
  const hook = window[Symbol.for('tabazing.media')];
  if (typeof hook === 'function') { try { return hook(action) === true; } catch { return false; } }
  if (action !== 'play' && action !== 'pause') return false;
  const secs = (m) => (m.duration === Infinity ? Infinity : Number.isFinite(m.duration) ? m.duration : 0);
  const all = [...document.querySelectorAll('video, audio')].filter((m) => m.currentSrc || m.src || m.srcObject);
  const el = all.find((m) => !m.paused && !m.ended) || all.sort((a, b) => secs(b) - secs(a))[0];
  if (!el) return false;
  if (action === 'pause') el.pause();
  else { const p = el.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); }
  return true;
}

const siteOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };

// The player's list, one entry per tab (as in Chrome's own media controls): the frame that plays, else
// the top frame, else the one heard from last. Media paused for an hour drops out, as Chrome's controls
// dismiss it. Tabs that make sound without a report (pages loaded before Tabazing was installed) are
// listed too, with what Chrome knows. Playing first, then the latest.
// `stored`: getMedia(); `tabs`: every open tab.
export function mediaEntries(stored, tabs, now = Date.now()) {
  const out = [];
  const reported = new Set();
  for (const tab of tabs) {
    const frames = stored[tab.id];
    if (!frames || tab.incognito) continue;
    const live = Object.entries(frames).filter(([, s]) => s.playing || now - s.t < LIMITS.MEDIA_PAUSED_MS);
    if (!live.length) continue;
    const [frameId, s] = live
      .sort(([fa, a], [fb, b]) => (b.playing - a.playing) || ((fb === '0') - (fa === '0')) || (b.t - a.t))[0];
    reported.add(tab.id);
    out.push({
      tabId: tab.id, frameId: Number(frameId), title: s.title || tab.title || '', artist: s.artist, site: siteOf(tab.url || tab.pendingUrl),
      playing: s.playing, canPrev: s.canPrev, canNext: s.canNext, kind: s.kind, t: s.t, tab,
    });
  }
  for (const tab of tabs) {
    if (!tab.audible || reported.has(tab.id) || tab.incognito) continue;
    out.push({
      tabId: tab.id, frameId: 0, title: tab.title || '', artist: '', site: siteOf(tab.url || tab.pendingUrl),
      playing: true, canPrev: false, canNext: false, kind: 'audio', t: tab.lastAccessed || 0, tab,
    });
  }
  return out.sort((a, b) => (b.playing - a.playing) || (b.t - a.t));
}

// Read both (in parallel) and merge. Every window's tabs: the player lists media wherever it plays.
export async function loadMedia() {
  const [stored, tabs] = await Promise.all([getMedia(), chrome.tabs.query({ windowType: 'normal' })]);
  return mediaEntries(stored, tabs);
}
