// In-page fallback for Alt+Q / Alt+W / Alt+E and Alt+R (classic content script, can't use imports), and the
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
  const HOTKEY = 'tabazing:hotkey'; // keep in sync with MESSAGE.HOTKEY in utils/constants.js
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
  // Alt going down starts every shortcut: the background takes the page's screenshot now, while nothing covers it,
  // so the switcher doesn't wait for one when the letter comes (it also wakes a worker that was asleep).
  const ALT_DOWN = 'tabazing:alt-down'; // keep in sync with MESSAGE.ALT_DOWN in utils/constants.js
  function onAlt(event) {
    if (!event.isTrusted || event.key !== 'Alt') return;
    const pressed = event.type === 'keydown' && !event.repeat;
    altDown = event.type === 'keydown';
    altAt = Date.now();
    if (pressed && alive()) chrome.runtime.sendMessage({ type: ALT_DOWN }).catch(() => {});
  }
  const onBlur = () => { altAt = 0; };
  // What this frame saw of Alt, and when: the background asks every frame of the page, as the focus may be in one
  // the overlay doesn't hear (an embedded editor or player).
  const altSeen = () => ({ state: altState(), at: altAt });

  // Alt+Q: open, card before the current tab; Alt+W: the card after it (both: letting go of Alt switches);
  // Alt+E: open and stay. Shift turns the direction around.
  const KEYS = { KeyQ: [-1, true], KeyW: [1, true], KeyE: [0, false] };
  // Alt+R (Option+R on a Mac): the command palette.
  const isPalette = (event) => event.code === 'KeyR' && event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey;
  function onKey(event) {
    if (!event.isTrusted || event.repeat) return;
    const palette = isPalette(event);
    if (!palette && (!KEYS[event.code] || !event.altKey || event.ctrlKey || event.metaKey)) return;
    if (!alive()) { window.removeEventListener('keydown', onKey, true); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (palette) return send({ type: HOTKEY, direction: 0, hold: false, palette: true });
    const [direction, hold] = KEYS[event.code];
    send({ type: HOTKEY, direction: event.shiftKey && direction ? -direction : direction, hold });
  }

  // The service worker can be asleep or still starting when the key is pressed. Sending a
  // message normally wakes it, but if it isn't listening yet the call is rejected, and a
  // silently swallowed rejection looks like "Alt+Q does nothing". So retry once after a
  // moment, by which time the worker has woken.
  function send(message) {
    chrome.runtime.sendMessage(message).catch(() => new Promise((resolve) => setTimeout(resolve, 50))
      .then(() => { if (alive()) return chrome.runtime.sendMessage(message); })
      .catch(() => {}));
  }

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keydown', onAlt, true);
  window.addEventListener('keyup', onAlt, true);
  window.addEventListener('blur', onBlur, true);
  window.__tabazingHotkey = { alive, onKey, onAlt, onBlur, altState, altSeen };
})();
