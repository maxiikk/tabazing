// The switcher's media player: what plays in which tab (reported by media-hook.js, kept by the
// background in storage.session), and its buttons, which run in the page's own world.
import { getMedia } from './store.js';
import { LIMITS } from './constants.js';

export const MEDIA_ACTIONS = Object.freeze(['play', 'pause', 'previoustrack', 'nexttrack']);

// Play, pause or skip in one frame of a tab. Resolves to true when the page acted; rejects when Chrome
// can't run anything there (the tab is gone, or site access was withheld).
export async function mediaAction(tabId, frameId, action) {
  if (!MEDIA_ACTIONS.includes(action)) return false;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [Number.isInteger(frameId) && frameId >= 0 ? frameId : 0] },
    world: 'MAIN', func: pageMediaAction, args: [action],
  });
  return !!result && result.result === true;
}

// Runs inside the page (its main world), serialized by Chrome: nothing from this module is in reach.
// Through media-hook.js when the page has it (the page's own previous / next buttons work then); a tab
// that was open before Tabazing was installed or updated doesn't: its longest (or playing) <video> or
// <audio> can still play and pause.
export function pageMediaAction(action) {
  const hook = window[Symbol.for('tabazing.media')];
  if (typeof hook === 'function') { try { return hook(action) === true; } catch { return false; } }
  if (action !== 'play' && action !== 'pause') return false;
  const seconds = (element) => (element.duration === Infinity ? Infinity : Number.isFinite(element.duration) ? element.duration : 0);
  const all = [...document.querySelectorAll('video, audio')].filter((element) => element.currentSrc || element.src || element.srcObject);
  const chosenElement = all.find((element) => !element.paused && !element.ended) || all.sort((firstElement, secondElement) => seconds(secondElement) - seconds(firstElement))[0];
  if (!chosenElement) return false;
  if (action === 'pause') chosenElement.pause();
  else { const playPromise = chosenElement.play(); if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {}); }
  return true;
}

const siteOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };

// The player's list, one entry per tab (as in Chrome's own media controls): the frame that plays, else
// the top frame, else the one heard from last. Media paused for an hour drops out, as Chrome's controls
// dismiss it, and so does a tab Chrome unloaded. A tab making sound without media (a game, a call: Web
// Audio, WebRTC) isn't listed, as in Chrome. Playing first, then the latest.
// `stored`: getMedia(); `tabs`: every open tab.
export function mediaEntries(stored, tabs, now = Date.now()) {
  const out = [];
  for (const tab of tabs) {
    const frames = stored[tab.id];
    if (!frames || tab.incognito || tab.discarded) continue;
    const live = Object.entries(frames).filter(([, frameState]) => frameState.playing || now - frameState.t < LIMITS.MEDIA_PAUSED_MILLISECONDS);
    if (!live.length) continue;
    const [frameId, frameState] = live
      .sort(([firstFrameId, firstState], [secondFrameId, secondState]) => (secondState.playing - firstState.playing) || ((secondFrameId === '0') - (firstFrameId === '0')) || (secondState.t - firstState.t))[0];
    out.push({
      tabId: tab.id, frameId: Number(frameId), title: frameState.title || tab.title || '', artist: frameState.artist, site: siteOf(tab.url || tab.pendingUrl),
      playing: frameState.playing, canPrevious: frameState.canPrevious, canNext: frameState.canNext, kind: frameState.kind, t: frameState.t, tab,
    });
  }
  return out.sort((firstEntry, secondEntry) => (secondEntry.playing - firstEntry.playing) || (secondEntry.t - firstEntry.t));
}

// Read both (in parallel) and merge. Every window's tabs, popups and app windows too: the player lists media
// wherever it plays (a site's mini-player window, an installed web app), as Chrome's controls do.
export async function loadMedia() {
  const [stored, tabs] = await Promise.all([getMedia(), chrome.tabs.query({})]);
  return mediaEntries(stored, tabs);
}
