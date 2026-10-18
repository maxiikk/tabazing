// What this frame is playing, for the switcher's media player (classic content script, "world": "MAIN").
// It runs in the page's own JavaScript world, the only place that can see the page's Media Session
// handlers (its own previous / next track buttons). It reports through a DOM event that media-relay.js
// (the isolated world) passes to the background, and offers window[Symbol.for('tabazing.media')](action)
// for the switcher to play, pause or skip (lib/media.js).
//
// Security: the page sees and can fake all of this (same world). That only changes what Tabazing shows
// for this tab and what its buttons do here; the background validates every report (lib/store.js).
//
// Idempotent: a second copy in the same page (declared and injected) finds the first and does nothing.
(() => {
  const KEY = Symbol.for('tabazing.media');
  if (window[KEY]) return;
  const EVENT = 'tabazing:media'; // media-relay.js listens for this
  const ACTIONS = ['previoustrack', 'nexttrack', 'play', 'pause'];
  const EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'durationchange', 'volumechange'];
  const MIN_SECONDS = 30; // shorter clips (sounds, previews, looping GIF-like videos) aren't "media" unless the page says so
  const MAX_KNOWN = 32;

  const handlers = new Map(); // action -> the page's Media Session handler
  const known = new Set();    // elements seen through play(): also those in shadow roots or never in the document (new Audio())
  const watched = new WeakSet(); // elements with listeners of their own (see watch())
  const inDoc = new WeakSet();   // elements seen in the document: taken out of it, they are gone
  let lastPlayed = null;
  let last = JSON.stringify({ media: false }); // nothing is reported until there is something to say
  let timer = 0;

  const session = () => navigator.mediaSession || null;
  const metadata = () => { const s = session(); return (s && s.metadata) || null; };

  // ---- the page's Media Session: its handlers, and its metadata (what Chrome's own media controls show)
  const MS = window.MediaSession && window.MediaSession.prototype;
  if (MS && typeof MS.setActionHandler === 'function') {
    const set = MS.setActionHandler;
    MS.setActionHandler = function (action, fn) {
      const r = set.apply(this, arguments); // throws for an action Chrome doesn't know: then nothing is recorded
      if (ACTIONS.includes(action)) { if (typeof fn === 'function') handlers.set(action, fn); else handlers.delete(action); }
      schedule();
      return r;
    };
  }
  const meta = MS && Object.getOwnPropertyDescriptor(MS, 'metadata');
  if (meta && meta.set && meta.configurable) {
    Object.defineProperty(MS, 'metadata', {
      configurable: true, enumerable: meta.enumerable, get: meta.get,
      set(v) { meta.set.call(this, v); schedule(); },
    });
  }

  // ---- media elements: the document's are found when needed; play() tells us about the others
  function remember(el) {
    watch(el);
    if (known.has(el)) return;
    known.add(el);
    if (known.size > MAX_KNOWN) known.delete(known.values().next().value);
  }
  // Events of an element outside the document (in a shadow root, never added, or just removed: Chrome
  // pauses it then) don't reach the window: so every element heard from gets listeners of its own.
  function watch(el) {
    if (watched.has(el)) return;
    watched.add(el);
    for (const e of EVENTS) el.addEventListener(e, onMedia);
  }
  const P = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  if (P && typeof P.play === 'function') {
    const play = P.play;
    P.play = function () {
      remember(this);
      lastPlayed = this;
      schedule();
      return play.apply(this, arguments);
    };
  }
  function onMedia(e) {
    const el = e.target;
    if (!(el instanceof HTMLMediaElement)) return;
    watch(el);
    if (e.type === 'play' || e.type === 'playing') lastPlayed = el;
    schedule();
  }
  for (const e of EVENTS) window.addEventListener(e, onMedia, true);

  const hasSource = (el) => !!(el.currentSrc || el.src || el.srcObject);
  const playing = (el) => !el.paused && !el.ended;
  const seconds = (el) => (el.duration === Infinity ? Infinity : Number.isFinite(el.duration) ? el.duration : 0);
  // Worth a player: in the page (or started by it), with something loaded, not a muted loop (a background
  // video, a GIF stand-in), and long enough (or live) unless the page described it in its Media Session.
  function qualifies(el) {
    if (el.isConnected) inDoc.add(el);
    else if (!known.has(el) || inDoc.has(el)) return false; // removed from the page, or never in it nor played
    if (!hasSource(el) || (el.muted && el.loop)) return false;
    return seconds(el) >= MIN_SECONDS || !!metadata();
  }
  // This frame's one media: the playing one, else the one played last, else the longest.
  function primary() {
    const all = [...new Set([...document.querySelectorAll('video, audio'), ...known])].filter(qualifies);
    if (!all.length) return null;
    if (lastPlayed && playing(lastPlayed) && all.includes(lastPlayed)) return lastPlayed;
    return all.find(playing) || (all.includes(lastPlayed) ? lastPlayed : null) || all.sort((a, b) => seconds(b) - seconds(a))[0];
  }
  const text = (v) => (typeof v === 'string' ? v : '');
  function current() {
    const el = primary();
    if (!el) return { media: false };
    const m = metadata();
    return {
      media: true,
      playing: playing(el),
      kind: el instanceof HTMLVideoElement ? 'video' : 'audio',
      title: text(m && m.title) || document.title || '',
      artist: text(m && m.artist),
      canPrev: handlers.has('previoustrack'),
      canNext: handlers.has('nexttrack'),
      muted: !!el.muted,
    };
  }

  // A burst of events (play, playing, durationchange...) becomes one report, and only a change is sent.
  // The detail is a string: an object made in this world doesn't reach the isolated world's listener.
  function report() {
    timer = 0;
    const json = JSON.stringify(current());
    if (json === last) return;
    last = json;
    document.dispatchEvent(new CustomEvent(EVENT, { detail: json }));
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(report, 150);
  }
  // The frame goes away (navigation, an iframe removed): it plays nothing any more. Back from the
  // back/forward cache: say again what it plays.
  window.addEventListener('pagehide', () => {
    clearTimeout(timer);
    if (last === JSON.stringify({ media: false })) return;
    last = JSON.stringify({ media: false });
    document.dispatchEvent(new CustomEvent(EVENT, { detail: last }));
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) { last = ''; schedule(); } });

  // The switcher's buttons (lib/media.js). The page's own handler when it has one (as Chrome's media
  // controls do), else the element itself; there is no previous / next without the page's handler.
  function act(action) {
    if (!ACTIONS.includes(action)) return false;
    const fn = handlers.get(action);
    if (fn) {
      try { fn({ action }); } catch { return false; }
      schedule();
      return true;
    }
    const el = primary();
    if (!el || (action !== 'play' && action !== 'pause')) return false;
    if (action === 'pause') el.pause();
    else { const p = el.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); }
    schedule();
    return true;
  }
  Object.defineProperty(window, KEY, { value: act, configurable: true, enumerable: false, writable: false });
  // Injected into a page that is already open (install, update): say what it plays now, not at the next event.
  schedule();
})();
