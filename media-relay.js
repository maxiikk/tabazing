// Passes what this frame plays (media-hook.js, in the page's world) on to the background (classic
// content script, isolated world: the only side that can talk to the extension).
//
// Security: the page can dispatch this event itself, with anything in it. The text is passed on as is,
// and the background treats it as untrusted: it parses and checks it, and keeps it for this tab only.
//
// Idempotent, like hotkey.js: a live copy makes later copies no-ops; a copy orphaned by an extension
// reload (chrome.runtime.id is gone) is replaced.
(() => {
  const MEDIA = 'tabazing:media'; // keep in sync with MSG.MEDIA in lib/constants.js (also media-hook.js's event name)
  const MAX = 4096;               // keep in sync with LIMITS.MEDIA_STATE_MAX
  const alive = () => { try { return !!chrome.runtime.id; } catch { return false; } };

  const existing = window.__tabazingMedia;
  if (existing && existing.alive()) return;
  if (existing) document.removeEventListener(MEDIA, existing.onMedia, true);

  let last = '';
  function onMedia(e) {
    if (!alive()) { document.removeEventListener(MEDIA, onMedia, true); return; }
    const state = e.detail;
    if (typeof state !== 'string' || !state || state.length > MAX || state === last) return;
    last = state;
    chrome.runtime.sendMessage({ type: MEDIA, state }).catch(() => {});
  }

  document.addEventListener(MEDIA, onMedia, true);
  window.__tabazingMedia = { alive, onMedia };
})();
