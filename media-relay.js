// Passes what this frame plays (media-hook.js, in the page's world) on to the background (classic
// content script, isolated world: the only side that can talk to the extension).
//
// Security: the page can dispatch this event itself, with anything in it. The text is passed on as is,
// and the background treats it as untrusted: it parses and checks it, and keeps it for this tab only.
//
// Idempotent, like hotkey.js: a live copy makes later copies no-ops; a copy orphaned by an extension
// reload (chrome.runtime.id is gone) is replaced.
(() => {
  const MEDIA = 'tabazing:media'; // keep in sync with MSG.MEDIA in utils/constants.js (also media-hook.js's event name)
  const MAX = 4096;               // keep in sync with LIMITS.MEDIA_STATE_MAX
  const SYNC = 'tabazing:media-sync'; // media-hook.js says everything again when asked
  const MIN_VERSION = 2;          // media-hook.js's VERSION: copies older than that (left in pages open from
                                  // before an update) can't be retired, and their rules are out of date
  const alive = () => { try { return !!chrome.runtime.id; } catch { return false; } };

  const existing = window.__tabazingMedia;
  if (existing && existing.alive()) return;
  if (existing) {
    document.removeEventListener(MEDIA, existing.onMedia, true);
    if (existing.onSync) document.removeEventListener(SYNC, existing.onSync, true);
  }

  let last = '';
  function onMedia(e) {
    if (!alive()) { document.removeEventListener(MEDIA, onMedia, true); document.removeEventListener(SYNC, onSync, true); return; }
    const state = e.detail;
    if (typeof state !== 'string' || !state || state.length > MAX || state === last) return;
    let v = 0;
    try { v = JSON.parse(state).v; } catch {}
    if (!(v >= MIN_VERSION)) return;
    last = state;
    chrome.runtime.sendMessage({ type: MEDIA, state }).catch(() => {});
  }

  // Everything is said again (this relay starting, or the background asking after the tab loaded, having
  // forgotten what it knew): the answer goes through even when it is the text sent last.
  function onSync() { last = ''; }

  document.addEventListener(MEDIA, onMedia, true);
  document.addEventListener(SYNC, onSync, true);
  window.__tabazingMedia = { alive, onMedia, onSync };
  // Started after the page did (installed, updated, reloaded: what the background knew is gone): ask the
  // page's media-hook.js for what it plays now. At the start of a page there is no hook yet, and nothing to say.
  document.dispatchEvent(new CustomEvent(SYNC));
})();
