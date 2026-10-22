// media-hook.js: what a frame plays, worked out in the page's own world, reported as a DOM event with a JSON
// string, and the play / pause / previous / next it offers the switcher. jsdom has no Media Session and no
// media playback, so both are stood in for here (play/pause/paused/duration).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(process.cwd(), 'media-hook.js'), 'utf8');
const KEY = Symbol.for('tabazing.media');
const mediaPrototype = HTMLMediaElement.prototype;
const ORIGINAL = { play: mediaPrototype.play, pause: mediaPrototype.pause };
const KNOWN_ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'stop'];

// ---- stand-ins
const states = new WeakMap(); // element -> { paused, duration, ended }
let setHandler; // the "browser's" setActionHandler, under the hook's wrapper
let nativePlay;  // ...and its HTMLMediaElement.prototype.play
class MediaSession {
  constructor() { this._meta = null; }
  get metadata() { return this._meta; }
  set metadata(value) { this._meta = value; }
}
function media(tag = 'video', { duration = 120, paused = true, src: source = 'https://cdn.example/a.mp4', muted = false, loop = false, root = document.body } = {}) {
  const element = document.createElement(tag);
  const elementState = { paused, duration, ended: false };
  states.set(element, elementState);
  for (const propertyName of ['paused', 'duration', 'ended']) Object.defineProperty(element, propertyName, { get: () => elementState[propertyName], configurable: true });
  Object.defineProperty(element, 'muted', { value: muted, writable: true, configurable: true });
  Object.defineProperty(element, 'loop', { value: loop, writable: true, configurable: true });
  if (source) element.setAttribute('src', source);
  if (root) root.append(element);
  return element;
}
const fire = (element, type) => element.dispatchEvent(new Event(type));

// ---- loading the hook, and taking every trace of it away again
let added = [];
function load() {
  const add = window.addEventListener, addDocumentListener = document.addEventListener;
  window.addEventListener = function (type, listener, options) { added.push([window, type, listener, options]); return add.call(this, type, listener, options); };
  document.addEventListener = function (type, listener, options) { added.push([document, type, listener, options]); return addDocumentListener.call(this, type, listener, options); };
  try { new Function(SOURCE)(); } finally { window.addEventListener = add; document.addEventListener = addDocumentListener; }
}
let reports = [];
const onReport = (event) => reports.push(event.detail);
const last = () => JSON.parse(reports.at(-1));
const settle = () => vi.advanceTimersByTime(150);

beforeEach(() => {
  vi.useFakeTimers();
  document.title = 'Page title';
  setHandler = vi.fn(function (action) { if (!KNOWN_ACTIONS.includes(action)) throw new TypeError(`'${action}' is not a valid MediaSessionAction`); });
  MediaSession.prototype.setActionHandler = setHandler;
  Object.defineProperty(MediaSession.prototype, 'metadata', Object.getOwnPropertyDescriptor(class { get metadata() { return this._meta; } set metadata(value) { this._meta = value; } }.prototype, 'metadata'));
  // Chrome's playbackState is an accessor too ('none' until the page says otherwise)
  Object.defineProperty(MediaSession.prototype, 'playbackState', { configurable: true, get() { return this._state || 'none'; }, set(value) { this._state = value; } });
  window.MediaSession = MediaSession;
  Object.defineProperty(navigator, 'mediaSession', { value: new MediaSession(), configurable: true });
  mediaPrototype.play = nativePlay = vi.fn(function () { states.get(this).paused = false; fire(this, 'play'); fire(this, 'playing'); return Promise.resolve(); });
  mediaPrototype.pause = vi.fn(function () { states.get(this).paused = true; fire(this, 'pause'); });
  reports = [];
  document.addEventListener('tabazing:media', onReport);
  load();
});
afterEach(() => {
  for (const [target, type, listener, options] of added) target.removeEventListener(type, listener, options);
  added = [];
  document.removeEventListener('tabazing:media', onReport);
  delete window[KEY];
  delete window.MediaSession;
  delete navigator.mediaSession;
  mediaPrototype.play = ORIGINAL.play;
  mediaPrototype.pause = ORIGINAL.pause;
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('reports', () => {
  it('nothing while there is no media, then one report with a JSON string for the detail', () => {
    settle();
    expect(reports).toEqual([]);
    const video = media('video');
    video.play();
    settle();
    expect(reports).toHaveLength(1);
    expect(typeof reports[0]).toBe('string');
    expect(last()).toEqual({ v: 4, media: true, playing: true, kind: 'video', title: 'Page title', artist: '', canPrevious: false, canNext: false, muted: false });
  });

  it('injected into a page that is already playing (install, update), it says so without waiting for an event', () => {
    settle(); // the copy loaded with the page: nothing to say yet
    media('video', { paused: false }); // then a video starts without this copy hearing about it
    settle();
    expect(reports).toEqual([]);
    delete window[KEY]; // a fresh copy, as background.js injects into open tabs
    load();
    settle();
    expect(last()).toMatchObject({ media: true, playing: true, kind: 'video' });
  });

  it('a burst of events is one report, 150 ms after the last; an unchanged state is not sent again', () => {
    const audio = media('audio');
    audio.play(); // play + playing
    vi.advanceTimersByTime(100);
    fire(audio, 'durationchange');
    vi.advanceTimersByTime(100);
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(reports).toHaveLength(1);
    expect(last()).toMatchObject({ media: true, playing: true, kind: 'audio' });
    fire(audio, 'volumechange');
    settle();
    expect(reports).toHaveLength(1);
    audio.pause();
    settle();
    expect(reports).toHaveLength(2);
    expect(last().playing).toBe(false);
    audio.muted = true;
    fire(audio, 'volumechange');
    settle();
    expect(last()).toMatchObject({ playing: false, muted: true }); // muted later: it stays, as in Chrome
  });

  it('says { media: false } once the media is gone (taken out of the page: Chrome pauses it)', () => {
    const video = media('video');
    video.play();
    settle();
    video.remove();
    video.pause();
    settle();
    expect(last()).toEqual({ v: 4, media: false });
    expect(reports).toHaveLength(2);
  });

  it('says { media: false } at once when the frame goes away, and again what it plays when it comes back', () => {
    const video = media('video');
    video.play();
    settle();
    window.dispatchEvent(new Event('pagehide'));
    expect(last()).toEqual({ v: 4, media: false });
    window.dispatchEvent(new Event('pagehide'));
    expect(reports).toHaveLength(2); // said once
    const back = new Event('pageshow');
    back.persisted = true;
    window.dispatchEvent(back);
    settle();
    expect(last()).toMatchObject({ media: true, playing: true });
  });
});

describe('the Media Session', () => {
  it('remembers the page\'s previous / next handlers, and still hands them to the browser', () => {
    const previousHandler = vi.fn();
    media('video').play();
    navigator.mediaSession.setActionHandler('previoustrack', previousHandler);
    navigator.mediaSession.setActionHandler('nexttrack', () => {});
    settle();
    expect(setHandler).toHaveBeenCalledWith('previoustrack', previousHandler);
    expect(last()).toMatchObject({ canPrevious: true, canNext: true });
    navigator.mediaSession.setActionHandler('nexttrack', null);
    settle();
    expect(last()).toMatchObject({ canPrevious: true, canNext: false });
  });

  it('an action the browser refuses throws as before and is not recorded', () => {
    media('video').play();
    expect(() => navigator.mediaSession.setActionHandler('bogus', () => {})).toThrow(TypeError);
    settle();
    expect(last()).toMatchObject({ canPrevious: false, canNext: false });
  });

  it('metadata gives the title and artist, and setting it reports (the browser still gets it)', () => {
    media('audio').play();
    settle();
    const meta = { title: 'Song', artist: 'Band' };
    navigator.mediaSession.metadata = meta;
    expect(navigator.mediaSession.metadata).toBe(meta);
    settle();
    expect(last()).toMatchObject({ title: 'Song', artist: 'Band' });
    navigator.mediaSession.metadata = null;
    settle();
    expect(last()).toMatchObject({ title: 'Page title', artist: '' });
  });
});

describe('which media: Chrome\'s own rule (only media that played with sound)', () => {
  it('nothing for media that is there but never played', () => {
    const video = media('video', { duration: 600 });
    fire(video, 'loadedmetadata');
    fire(video, 'durationchange');
    settle();
    expect(reports).toEqual([]);
  });

  it('joins once it plays with sound, and stays when paused, muted or finished', () => {
    const video = media('video');
    video.play();
    settle();
    expect(last()).toMatchObject({ media: true, playing: true });
    video.pause();
    settle();
    expect(last()).toMatchObject({ media: true, playing: false });
    video.muted = true;
    fire(video, 'volumechange');
    states.get(video).ended = true;
    fire(video, 'ended');
    settle();
    expect(last()).toMatchObject({ media: true, playing: false, muted: true });
  });

  it.each([
    ['muted (autoplay in a feed)', { muted: true }],
    ['a muted loop (a background video)', { muted: true, loop: true }],
    ['at zero volume', { volume: 0 }],
    ['shorter than 5 s (a sound)', { duration: 4 }],
    ['nothing loaded', { src: '' }],
  ])('never joins while %s', (unused, options) => {
    const video = media('video', options);
    if ('volume' in options) Object.defineProperty(video, 'volume', { value: options.volume, configurable: true });
    video.play();
    settle();
    expect(reports).toEqual([]);
  });

  it('a video whose sound Chrome has not decoded (no audio track) does not join until it has', () => {
    const video = media('video');
    let bytes = 0;
    Object.defineProperty(video, 'webkitAudioDecodedByteCount', { get: () => bytes, configurable: true });
    video.play();
    settle();
    expect(reports).toEqual([]);
    bytes = 4096; // the sound arrives a moment after it starts
    fire(video, 'timeupdate');
    settle();
    expect(last()).toMatchObject({ media: true, playing: true });
  });

  it('a muted video joins when it is unmuted while playing', () => {
    const video = media('video', { muted: true });
    video.play();
    settle();
    expect(reports).toEqual([]);
    video.muted = false;
    fire(video, 'volumechange');
    settle();
    expect(last()).toMatchObject({ media: true, playing: true, muted: false });
  });

  // The page's own player counts without sound too (more than Chrome does): a YouTube video watched muted.
  describe('muted or at zero volume, the page\'s own player', () => {
    const size = (element, width, height) => { element.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height }); };

    it.each([['muted', { muted: true }], ['at zero volume', { volume: 0 }]])('it says what it plays (Media Session) and it is big, %s: it joins', (unused, options) => {
      navigator.mediaSession.metadata = { title: 'A video', artist: 'A channel' };
      const video = media('video', options);
      if ('volume' in options) Object.defineProperty(video, 'volume', { value: 0, configurable: true });
      size(video, 960, 540);
      video.play();
      settle();
      expect(last()).toMatchObject({ media: true, playing: true, kind: 'video', title: 'A video', muted: !!options.muted });
    });

    it('an <audio> the page names joins muted too', () => {
      navigator.mediaSession.metadata = { title: 'A podcast' };
      media('audio', { muted: true }).play();
      settle();
      expect(last()).toMatchObject({ media: true, kind: 'audio', title: 'A podcast' });
    });

    it('a small one (a hover preview) stays out; so does a big one the page doesn\'t name (muted autoplay)', () => {
      navigator.mediaSession.metadata = { title: 'A video' };
      const preview = media('video', { muted: true });
      size(preview, 320, 180);
      preview.play();
      settle();
      expect(reports).toEqual([]);
      navigator.mediaSession.metadata = { title: '' };
      const feed = media('video', { muted: true });
      size(feed, 960, 540);
      feed.play();
      settle();
      expect(reports).toEqual([]);
    });
  });

  it('an unknown duration waits until it is known; live streams count', () => {
    const video = media('video', { duration: NaN });
    video.play();
    settle();
    expect(reports).toEqual([]);
    states.get(video).duration = 300;
    fire(video, 'durationchange');
    settle();
    expect(last().media).toBe(true);
    const live = media('audio', { duration: Infinity });
    live.play();
    settle();
    expect(last()).toMatchObject({ kind: 'audio', playing: true });
  });

  it('5 s exactly is enough', () => {
    media('audio', { duration: 5 }).play();
    settle();
    expect(last().media).toBe(true);
  });

  it('Media Session metadata alone adds nothing (it only names media that played)', () => {
    navigator.mediaSession.metadata = { title: 'Clip', artist: 'Band' };
    media('audio', { duration: 8 });
    settle();
    expect(reports).toEqual([]);
  });

  it("a player that unloads its source stays, paused (YouTube stops one tab's video when another starts)", () => {
    const video = media('video');
    video.play();
    settle();
    states.get(video).paused = true;
    video.removeAttribute('src'); // stopVideo(): the source goes
    fire(video, 'pause');
    fire(video, 'emptied');
    settle();
    expect(last()).toMatchObject({ media: true, playing: false, kind: 'video' });
  });

  it('the playing one, else the one played last, else the one that joined last', () => {
    const audio = media('audio', { duration: 600 });
    const video = media('video', { duration: 60 });
    audio.play();
    audio.pause();
    video.play();
    settle();
    expect(last()).toMatchObject({ kind: 'video', playing: true });
    video.pause();
    settle();
    expect(last()).toMatchObject({ kind: 'video', playing: false }); // played last
    audio.play();
    settle();
    expect(last()).toMatchObject({ kind: 'audio', playing: true });
  });

  it('the one started last when two play', () => {
    const audio = media('audio', { duration: 600 });
    const video = media('video', { duration: 60 });
    audio.play();
    video.play();
    settle();
    expect(last()).toMatchObject({ kind: 'video' });
  });

  it('finds media in a shadow root and media never added to the page (new Audio()) once they play', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const video = media('video', { root: shadow });
    video.play();
    settle();
    expect(last()).toMatchObject({ kind: 'video', playing: true });
    video.pause(); // its events don't reach the window: it is listened to directly
    settle();
    expect(last()).toMatchObject({ kind: 'video', playing: false });
    host.remove();
    const audio = media('audio', { root: null });
    audio.play();
    settle();
    expect(last()).toMatchObject({ kind: 'audio', playing: true });
  });

  it('timeupdate after joining sends nothing new (it fires several times a second)', () => {
    const video = media('video');
    video.play();
    settle();
    const count = reports.length;
    for (let i = 0; i < 10; i++) fire(video, 'timeupdate');
    settle();
    expect(reports).toHaveLength(count);
  });
});

describe('window[Symbol.for("tabazing.media")]', () => {
  const act = (action) => window[KEY](action);

  it('is a hidden (non-enumerable) function', () => {
    expect(typeof window[KEY]).toBe('function');
    expect(Object.prototype.propertyIsEnumerable.call(window, KEY)).toBe(false);
  });

  it('plays and pauses the media itself when the page has no handler', () => {
    const video = media('video');
    video.play();
    expect(act('pause')).toBe(true);
    expect(video.paused).toBe(true);
    expect(act('play')).toBe(true);
    expect(video.paused).toBe(false);
  });

  it('uses the page\'s own handler when it has one', () => {
    const video = media('video');
    const play = vi.fn(), next = vi.fn(), previous = vi.fn();
    navigator.mediaSession.setActionHandler('play', play);
    navigator.mediaSession.setActionHandler('nexttrack', next);
    navigator.mediaSession.setActionHandler('previoustrack', previous);
    expect(act('play')).toBe(true);
    expect(play).toHaveBeenCalledWith({ action: 'play' });
    expect(nativePlay).not.toHaveBeenCalled();
    expect(video.paused).toBe(true);
    expect(act('nexttrack')).toBe(true);
    expect(next).toHaveBeenCalledWith({ action: 'nexttrack' });
    expect(act('previoustrack')).toBe(true);
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it('no previous / next without the page\'s handler; nothing without media; nothing for other actions; a throwing handler is a failure', () => {
    expect(act('play')).toBe(false); // no media
    const video = media('video');
    expect(act('play')).toBe(false); // there, but never played with sound: not this frame's media
    video.play();
    expect(act('nexttrack')).toBe(false);
    expect(act('previoustrack')).toBe(false);
    expect(act('seekto')).toBe(false);
    expect(act('stop')).toBe(false);
    navigator.mediaSession.setActionHandler('pause', () => { throw new Error('page bug'); });
    expect(act('pause')).toBe(false);
  });

  it('reports the change that follows', () => {
    media('video').play();
    settle();
    act('pause');
    settle();
    expect(last()).toMatchObject({ playing: false });
  });

  it('a play() the page refuses (autoplay rules) is not an unhandled rejection', async () => {
    const video = media('video');
    video.play();
    video.pause();
    nativePlay.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));
    expect(act('play')).toBe(true);
    await Promise.resolve();
  });
});

describe('idempotence', () => {
  it('a second copy in the same page changes nothing', () => {
    const hook = window[KEY];
    const play = mediaPrototype.play, set = MediaSession.prototype.setActionHandler;
    load();
    expect(window[KEY]).toBe(hook);
    expect(mediaPrototype.play).toBe(play);
    expect(MediaSession.prototype.setActionHandler).toBe(set);
    media('video').play();
    settle();
    expect(reports).toHaveLength(1);
  });

  it('runs in a page without a Media Session (or one where it was taken away)', () => {
    afterEachCleanup();
    delete window.MediaSession;
    delete navigator.mediaSession;
    load();
    media('video').play();
    settle();
    expect(last()).toMatchObject({ media: true, canPrevious: false, title: 'Page title' });
  });
});

// The beforeEach's copy, gone (for a test that loads its own).
function afterEachCleanup() {
  for (const [target, type, listener, options] of added) target.removeEventListener(type, listener, options);
  added = [];
  delete window[KEY];
  mediaPrototype.play = vi.fn(function () { states.get(this).paused = false; fire(this, 'play'); return Promise.resolve(); });
}

describe('keeping the background up to date', () => {
  it('a sync request (the relay started) says everything again, changed or not', () => {
    media('video').play();
    settle();
    const count = reports.length;
    document.dispatchEvent(new CustomEvent('tabazing:media-sync'));
    settle();
    expect(reports).toHaveLength(count + 1);
    expect(last()).toMatchObject({ v: 4, media: true, playing: true });
    window[KEY].sync(); // the background's way in, after a tab loaded
    settle();
    expect(reports).toHaveLength(count + 2);
  });

  it('injected later, it also counts media that played before it came (el.played), even paused now', () => {
    settle();
    const video = media('video');
    Object.defineProperty(video, 'played', { value: { length: 1 }, configurable: true }); // it played, then paused
    const never = media('audio');
    Object.defineProperty(never, 'played', { value: { length: 0 }, configurable: true });
    delete window[KEY];
    load();
    settle();
    expect(last()).toMatchObject({ media: true, playing: false, kind: 'video' });
  });

  it('a copy from before versions existed is taken over; the same version is left alone', () => {
    const old = vi.fn(() => true); // an old hook: a plain function, no version
    Object.defineProperty(window, KEY, { value: old, configurable: true, enumerable: false, writable: false });
    load();
    expect(window[KEY]).not.toBe(old);
    expect(window[KEY].version).toBe(4);
    const current = window[KEY];
    load();
    expect(window[KEY]).toBe(current);
  });

  it('a newer copy retires the one it replaces and takes over its handlers and media', () => {
    const next = vi.fn();
    navigator.mediaSession.setActionHandler('nexttrack', next);
    const video = media('video');
    video.play();
    video.pause();
    settle();
    const older = window[KEY];
    Object.defineProperty(older, 'version', { value: 1 }); // pretend it is older
    load();
    const newer = window[KEY];
    expect(newer).not.toBe(older);
    expect(older('pause')).toBe(false); // retired: it no longer acts
    expect(newer('nexttrack')).toBe(true); // the page's handler, set up before the newer copy came
    expect(next).toHaveBeenCalledTimes(1);
    reports = [];
    newer.sync();
    settle();
    expect(reports).toHaveLength(1); // one report: only the newer copy speaks
    expect(last()).toMatchObject({ media: true, playing: false, canNext: true });
  });
});

describe('edge cases', () => {
  it('a player moved elsewhere in the page (a mini player) keeps its place; taken out, it is gone until put back', () => {
    const video = media('video');
    video.play();
    video.pause();
    settle();
    const box = document.createElement('div');
    document.body.append(box);
    box.append(video); // moved: never reported as gone
    settle();
    expect(last()).toMatchObject({ media: true, kind: 'video' });
    video.remove();
    fire(video, 'pause'); // Chrome pauses media taken out of the page
    settle();
    expect(last()).toEqual({ v: 4, media: false });
    box.append(video); // put back (a page restoring its player)
    fire(video, 'loadedmetadata');
    fire(video, 'pause');
    settle();
    expect(last()).toMatchObject({ media: true, playing: false, kind: 'video' });
  });

  it('a muted preview starting does not hide which media you used last', () => {
    const song = media('audio', { duration: 300 });
    const clip = media('video', { duration: 300 });
    song.play(); song.pause();
    clip.play(); clip.pause();
    song.play(); song.pause(); // the song was used last
    settle();
    expect(last()).toMatchObject({ kind: 'audio' });
    const preview = media('video', { muted: true }); // a feed's hover preview
    preview.play();
    settle();
    expect(last()).toMatchObject({ kind: 'audio', playing: false });
  });

  it('a call (a MediaStream: Meet, Zoom) is not media, as in Chrome\'s controls', () => {
    class MediaStream {}
    vi.stubGlobal('MediaStream', MediaStream);
    try {
      const audio = media('audio', { src: '', duration: Infinity });
      audio.srcObject = new MediaStream();
      audio.play();
      settle();
      expect(reports).toEqual([]);
      const secondAudio = media('audio', { src: '', duration: Infinity });
      secondAudio.srcObject = {}; // a MediaSource-like object (a streaming site): that is media
      secondAudio.play();
      settle();
      expect(last()).toMatchObject({ media: true, kind: 'audio' });
    } finally { vi.unstubAllGlobals(); }
  });

  it('a stream that never says how long it is joins after playing 5 s with sound', () => {
    const video = media('video', { duration: NaN });
    let time = 0;
    Object.defineProperty(video, 'currentTime', { get: () => time, configurable: true });
    video.play();
    settle();
    expect(reports).toEqual([]);
    time = 4.9;
    fire(video, 'timeupdate');
    settle();
    expect(reports).toEqual([]);
    time = 5;
    fire(video, 'timeupdate');
    settle();
    expect(last()).toMatchObject({ media: true, playing: true });
  });

  it('playing / paused follows what the page declares in its Media Session (as Chrome shows it), and reports its change', () => {
    const video = media('video');
    video.play();
    settle();
    expect(last().playing).toBe(true);
    navigator.mediaSession.playbackState = 'paused'; // e.g. a player that keeps its element running between tracks
    settle();
    expect(last().playing).toBe(false);
    navigator.mediaSession.playbackState = 'none'; // no say: the element decides again
    settle();
    expect(last().playing).toBe(true);
  });

  it('media starting by itself inside a closed shadow root (autoplay, no play() call) is heard', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'closed' }); // made after the hook: it listens there
    const video = media('video', { root });
    states.get(video).paused = false;
    fire(video, 'play'); // not composed: never reaches the window
    fire(video, 'playing');
    settle();
    expect(last()).toMatchObject({ media: true, playing: true, kind: 'video' });
  });

  it('a <video> with no picture (a radio stream, a podcast) is sound', () => {
    const video = media('video');
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    Object.defineProperty(video, 'videoWidth', { value: 0, configurable: true });
    video.play();
    settle();
    expect(last()).toMatchObject({ kind: 'audio' });
  });

  it('state() says what this frame plays now, for the background to check', () => {
    expect(JSON.parse(window[KEY].state())).toEqual({ v: 4, media: false });
    media('audio').play();
    expect(JSON.parse(window[KEY].state())).toMatchObject({ v: 4, media: true, playing: true, kind: 'audio' });
  });
});
