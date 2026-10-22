// What this frame is playing, for the switcher's media player (classic content script, "world": "MAIN").
// It runs in the page's own JavaScript world, the only place that can see the page's Media Session
// handlers (its own previous / next track buttons). It reports through a DOM event that media-relay.js
// (the isolated world) passes to the background, and offers window[Symbol.for('tabazing.media')](action)
// for the switcher to play, pause or skip (utils/media.js).
//
// Security: the page sees and can fake all of this (same world). That only changes what Tabazing shows
// for this tab and what its buttons do here; the background validates every report (utils/store.js).
//
// Idempotent: a second copy of the same version in the same page (declared and injected) finds the first and
// does nothing. A newer version (injected into open tabs after an update) retires an older one and takes over;
// copies from before versions existed can't be retired, so media-relay.js ignores reports without a version.
(() => {
  const KEY = Symbol.for('tabazing.media');
  const VERSION = 4; // in every report as "v"; media-relay.js passes on reports from VERSION 2 on
  const previousHook = window[KEY];
  if (previousHook && previousHook.version >= VERSION) return;
  if (previousHook && typeof previousHook.retire === 'function') previousHook.retire();
  let retired = false;
  const EVENT = 'tabazing:media'; // media-relay.js listens for this
  const SYNC = 'tabazing:media-sync'; // ...and asks with this for everything again (when it starts)
  const ACTIONS = ['previoustrack', 'nexttrack', 'play', 'pause'];
  const EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'durationchange', 'volumechange', 'timeupdate'];
  // Which media count is Chrome's own rule (its media controls, MediaSessionImpl): only media that has PLAYED
  // WITH SOUND joins, and then stays, paused or not, until it is taken out of the page (or the page goes).
  // A player that unloads its source keeps its place: YouTube does that to the video in one tab when you start
  // another, and Chrome still lists the first one, paused.
  // Media that never played, muted autoplay (feeds, backgrounds, GIF stand-ins) and sounds shorter than
  // 5 s ("transient" in Chrome) never show; nor does a page that only sets Media Session metadata.
  // One thing more than Chrome: the page's own player joins muted or at zero volume too (see meant()), so a
  // YouTube video watched with its sound off is still in the player.
  const MIN_SECONDS = 5;
  const MAX_KNOWN = 32;

  const handlers = new Map(); // action -> the page's Media Session handler
  const active = new Set();   // elements that have played with sound (or on purpose: meant()): this frame's media, oldest first
  const watched = new WeakSet(); // elements with listeners of their own (see watch())
  const inDocument = new WeakSet();   // elements seen in the document: taken out of it, they are gone
  let lastPlayed = null;
  let last = JSON.stringify({ v: VERSION, media: false }); // nothing is reported until there is something to say
  let timer = 0;

  const session = () => navigator.mediaSession || null;
  const metadata = () => { const mediaSession = session(); return (mediaSession && mediaSession.metadata) || null; };

  // ---- the page's Media Session: its handlers, and its metadata (what Chrome's own media controls show)
  const mediaSessionPrototype = window.MediaSession && window.MediaSession.prototype;
  if (mediaSessionPrototype && typeof mediaSessionPrototype.setActionHandler === 'function') {
    const set = mediaSessionPrototype.setActionHandler;
    mediaSessionPrototype.setActionHandler = function (action, handler) {
      const result = set.apply(this, arguments); // throws for an action Chrome doesn't know: then nothing is recorded
      if (ACTIONS.includes(action)) { if (typeof handler === 'function') handlers.set(action, handler); else handlers.delete(action); }
      schedule();
      return result;
    };
  }
  // Its metadata (the title Chrome shows) and its playbackState (playing / paused, when the page says so
  // itself): both report when they change.
  for (const name of ['metadata', 'playbackState']) {
    const descriptor = mediaSessionPrototype && Object.getOwnPropertyDescriptor(mediaSessionPrototype, name);
    if (!descriptor || !descriptor.set || !descriptor.configurable) continue;
    Object.defineProperty(mediaSessionPrototype, name, {
      configurable: true, enumerable: descriptor.enumerable, get: descriptor.get,
      set(value) { descriptor.set.call(this, value); schedule(); },
    });
  }

  // ---- media elements: the document's events reach the window; play() tells us about the others
  // Events of an element outside the document (in a shadow root, never added, or just taken out: Chrome
  // pauses it then) don't reach the window, so every element heard from gets listeners of its own too. Each
  // event is handled once (a feed of muted videos fires many): by the window while the element is in the
  // document, by its own listener while it isn't.
  function watch(element) {
    if (watched.has(element)) return;
    watched.add(element);
    for (const eventName of EVENTS) element.addEventListener(eventName, onOwn);
  }
  function onOwn(event) {
    if (event.currentTarget.getRootNode() !== document) onMedia(event); // else the window heard it
  }
  function onWindow(event) {
    const element = event.target;
    if (watched.has(element) && element.getRootNode() !== document) return; // its own listener has it
    onMedia(event);
  }
  // Shadow roots, even closed ones, as the page makes them: media inside that starts by itself (autoplay,
  // no play() call) is heard there.
  const elementPrototype = window.Element && window.Element.prototype;
  if (elementPrototype && typeof elementPrototype.attachShadow === 'function') {
    const attach = elementPrototype.attachShadow;
    elementPrototype.attachShadow = function () {
      const root = attach.apply(this, arguments);
      try { for (const eventName of EVENTS) root.addEventListener(eventName, onWindow, true); } catch {}
      return root;
    };
  }
  const mediaElementPrototype = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  if (mediaElementPrototype && typeof mediaElementPrototype.play === 'function') {
    const play = mediaElementPrototype.play;
    mediaElementPrototype.play = function () {
      watch(this);
      schedule();
      return play.apply(this, arguments);
    };
  }
  function onMedia(event) {
    const element = event.target;
    if (!(element instanceof HTMLMediaElement) || retired) return;
    watch(element);
    // timeupdate (a few times a second while playing) only matters until the element has joined: its sound
    // may be decoded, or its duration known, only a moment after it starts.
    if (event.type === 'timeupdate') { if (join(element)) { lastPlayed = element; schedule(); } return; }
    join(element);
    // "Played last" is about this frame's media only: a muted preview starting doesn't hide which video you used.
    if ((event.type === 'play' || event.type === 'playing') && active.has(element)) lastPlayed = element;
    schedule();
  }
  for (const eventName of EVENTS) window.addEventListener(eventName, onWindow, true);

  // A source, but not a live call (a MediaStream: Meet, Zoom...), which Chrome's media controls leave out.
  const isStream = (source) => !!source && typeof MediaStream === 'function' && source instanceof MediaStream;
  const hasSource = (element) => !isStream(element.srcObject) && !!(element.currentSrc || element.src || element.srcObject);
  const playing = (element) => !element.paused && !element.ended;
  // Sound: not muted, not at zero volume, and an audio track: an <audio>, or a video whose sound Chrome has
  // decoded (webkitAudioDecodedByteCount; a video without sound never joins). Where that counter doesn't
  // exist, a video is taken to have sound.
  function withSound(element) {
    if (element.muted || element.volume === 0) return false;
    if (element instanceof HTMLAudioElement) return true;
    const decodedByteCount = element.webkitAudioDecodedByteCount;
    return typeof decodedByteCount !== 'number' || decodedByteCount > 0;
  }
  // The page's own player counts with no sound too: it tells Chrome what it plays (Media Session metadata with a
  // title) and it is big in the page (a video of 400×225 or more; an <audio>). Muted autoplay (feeds, backgrounds,
  // hover previews) is neither. Not "started by a click": a click's user activation lasts seconds, long enough
  // for a feed's muted videos to start under it.
  function meant(element) {
    const sessionMetadata = metadata();
    if (!sessionMetadata || !text(sessionMetadata.title)) return false;
    if (element instanceof HTMLAudioElement) return true;
    const bounds = element.getBoundingClientRect();
    return bounds.width >= 400 && bounds.height >= 225;
  }
  // Long enough: 5 s or more, or live (endless). An unknown duration waits until it is known, or until it
  // has played 5 s (some streams never say how long they are).
  const longEnough = (element) => element.duration === Infinity || (Number.isFinite(element.duration) ? element.duration >= MIN_SECONDS : element.currentTime >= MIN_SECONDS);
  // Was in the page and is out of it now. Only for now: a player moved elsewhere in the page (a mini player)
  // is back as soon as it is put back in.
  const gone = (element) => !element.isConnected && inDocument.has(element);
  // Playing with sound (or on purpose: meant) right now: it joins this frame's media (and stays). Returns whether it just joined.
  // `before`: it doesn't have to be playing now if it has played (element.played): for a hook injected into a page
  // that is already open, which wasn't there to see it.
  function join(element, before = false) {
    if (element.isConnected) inDocument.add(element);
    const played = playing(element) || (before && element.played && element.played.length > 0);
    if (active.has(element) || gone(element) || !played || !hasSource(element) || !(withSound(element) || meant(element)) || !longEnough(element)) return false;
    active.add(element);
    if (active.size > MAX_KNOWN) { // too many: those out of the page go first, then the oldest
      const out = [...active].find(gone);
      active.delete(out || active.values().next().value);
    }
    return true;
  }
  // This frame's one media: the playing one (the one started last, if several), else the one played last,
  // else the one that joined last.
  function primary() {
    const here = [...active].filter((element) => !gone(element));
    if (!here.length) return null;
    if (lastPlayed && playing(lastPlayed) && here.includes(lastPlayed)) return lastPlayed;
    const newestFirst = here.reverse();
    return newestFirst.find(playing) || (here.includes(lastPlayed) ? lastPlayed : null) || newestFirst[0];
  }
  const text = (value) => (typeof value === 'string' ? value : '');
  function current() {
    const element = primary();
    if (!element) return { v: VERSION, media: false };
    const sessionMetadata = metadata();
    // Playing or paused: what the page declares in its Media Session, if it does (Chrome's controls show
    // that too), else the element itself.
    const declared = session() && session().playbackState;
    return {
      v: VERSION,
      media: true,
      playing: declared === 'playing' ? true : declared === 'paused' ? false : playing(element),
      // A <video> with no picture (a radio stream, a podcast) is sound.
      kind: element instanceof HTMLVideoElement && !(element.readyState >= 1 && element.videoWidth === 0) ? 'video' : 'audio',
      title: text(sessionMetadata && sessionMetadata.title) || document.title || '',
      artist: text(sessionMetadata && sessionMetadata.artist),
      canPrevious: handlers.has('previoustrack'),
      canNext: handlers.has('nexttrack'),
      muted: !!element.muted,
    };
  }

  // A burst of events (play, playing, durationchange...) becomes one report, and only a change is sent.
  // The detail is a string: an object made in this world doesn't reach the isolated world's listener.
  function report() {
    timer = 0;
    if (retired) return;
    const json = JSON.stringify(current());
    if (json === last) return;
    last = json;
    document.dispatchEvent(new CustomEvent(EVENT, { detail: json }));
  }
  function schedule() {
    if (retired) return;
    clearTimeout(timer);
    timer = setTimeout(report, 150);
  }
  // Say everything again, changed or not: the relay just started (the extension was reloaded, and with it
  // what the background knew), or the background asks after the tab loaded.
  function sync() {
    last = '';
    schedule();
  }
  document.addEventListener(SYNC, sync);
  // The frame goes away (navigation, an iframe removed): it plays nothing any more. Back from the
  // back/forward cache: say again what it plays.
  const NONE = JSON.stringify({ v: VERSION, media: false });
  window.addEventListener('pagehide', () => {
    clearTimeout(timer);
    if (retired || last === NONE || last === JSON.stringify({ media: false })) return;
    last = NONE;
    document.dispatchEvent(new CustomEvent(EVENT, { detail: last }));
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { last = ''; schedule(); } });

  // The switcher's buttons (utils/media.js). The page's own handler when it has one (as Chrome's media
  // controls do), else the element itself; there is no previous / next without the page's handler.
  function performAction(action) {
    if (retired || !ACTIONS.includes(action)) return false;
    const handler = handlers.get(action);
    if (handler) {
      try { handler({ action }); } catch { return false; }
      schedule();
      return true;
    }
    const element = primary();
    if (!element || (action !== 'play' && action !== 'pause')) return false;
    if (action === 'pause') element.pause();
    else { const playPromise = element.play(); if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {}); }
    schedule();
    return true;
  }
  // A newer copy takes over (see the top): this one stops reporting and acting.
  performAction.version = VERSION;
  performAction.sync = sync;
  performAction.state = () => JSON.stringify(current()); // what this frame plays now (the background checks with it)
  performAction.retire = () => { retired = true; clearTimeout(timer); document.removeEventListener(SYNC, sync); };
  performAction.handoff = () => ({ handlers, active, lastPlayed }); // what a newer copy takes over (see below)
  Object.defineProperty(window, KEY, { value: performAction, configurable: true, enumerable: false, writable: false });
  // Taking over from an older copy: the page's handlers and the media it knew (the page set them up before us).
  if (previousHook && typeof previousHook.handoff === 'function') {
    try {
      const old = previousHook.handoff();
      old.handlers.forEach((handler, action) => handlers.set(action, handler));
      old.active.forEach((element) => { active.add(element); watch(element); });
      lastPlayed = old.lastPlayed;
    } catch {}
  }
  // Injected into a page that is already open (install, update): what plays there, or has played, joins at once.
  for (const element of document.querySelectorAll('video, audio')) { watch(element); join(element, true); }
  schedule();
})();
