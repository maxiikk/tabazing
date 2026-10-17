// In-page fallback for Alt+Q / Alt+W / Alt+E (classic content script, can't use imports), and the
// state of the Alt key, which the overlay reads when it opens (a quick Alt+Q tap may be over by then).
// Chrome's shortcut system can leave a key unassigned when another extension
// or app already owns it; this makes Alt+Q work on web pages anyway.
//
// Security: this runs on every page, so the page is untrusted. It reads
// nothing from the page and only reacts to *real* key presses (isTrusted), so
// a page can't open the switcher by dispatching fake keyboard events.
//
// Idempotent: the script is both declared in the manifest and injected on
// install/reload. A live copy makes later copies no-ops; a copy orphaned by
// an extension reload (chrome.runtime.id is gone) is replaced.
(() => {
  const HOTKEY = 'tabazing:hotkey'; // keep in sync with MSG.HOTKEY in lib/constants.js
  const alive = () => { try { return !!chrome.runtime.id; } catch { return false; } };

  const existing = window.__tabazingHotkey;
  if (existing && existing.alive()) return;
  if (existing) {
    window.removeEventListener('keydown', existing.onKey, true);
    if (existing.onAlt) { window.removeEventListener('keydown', existing.onAlt, true); window.removeEventListener('keyup', existing.onAlt, true); }
    if (existing.onBlur) window.removeEventListener('blur', existing.onBlur, true);
  }

  // Is Alt held? 'unknown' unless this frame saw it go down recently (it may have been pressed in a
  // subframe, or before the page had the focus).
  let altDown = false;
  let altAt = 0;
  const altState = () => (Date.now() - altAt > 10000 ? 'unknown' : altDown ? 'down' : 'up');
  function onAlt(e) {
    if (!e.isTrusted || e.key !== 'Alt') return;
    altDown = e.type === 'keydown';
    altAt = Date.now();
  }
  const onBlur = () => { altAt = 0; };

  // Alt+Q: open, card before the current tab; Alt+W: the card after it (both: letting go of Alt switches);
  // Alt+E: open and stay. Shift turns the direction around.
  const KEYS = { KeyQ: [-1, true], KeyW: [1, true], KeyE: [0, false] };
  function onKey(e) {
    if (!e.isTrusted || !KEYS[e.code] || !e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    if (!alive()) { window.removeEventListener('keydown', onKey, true); return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    const [dir, hold] = KEYS[e.code];
    send(e.shiftKey && dir ? -dir : dir, hold);
  }

  // The service worker can be asleep or still starting when the key is pressed. Sending a
  // message normally wakes it, but if it isn't listening yet the call is rejected, and a
  // silently swallowed rejection looks like "Alt+Q does nothing". So retry once after a
  // moment, by which time the worker has woken.
  function send(dir, hold) {
    const msg = { type: HOTKEY, dir, hold };
    chrome.runtime.sendMessage(msg).catch(() => new Promise((r) => setTimeout(r, 50))
      .then(() => { if (alive()) return chrome.runtime.sendMessage(msg); })
      .catch(() => {}));
  }

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keydown', onAlt, true);
  window.addEventListener('keyup', onAlt, true);
  window.addEventListener('blur', onBlur, true);
  window.__tabazingHotkey = { alive, onKey, onAlt, onBlur, altState };
})();
