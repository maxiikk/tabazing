// media-hook.js: what a frame plays, worked out in the page's own world, reported as a DOM event with a JSON
// string, and the play / pause / previous / next it offers the switcher. jsdom has no Media Session and no
// media playback, so both are stood in for here (play/pause/paused/duration).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(process.cwd(), 'media-hook.js'), 'utf8');
const KEY = Symbol.for('tabazing.media');
const P = HTMLMediaElement.prototype;
const ORIGINAL = { play: P.play, pause: P.pause };
const KNOWN_ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'stop'];

// ---- stand-ins
const states = new WeakMap(); // element -> { paused, duration, ended }
let setHandler; // the "browser's" setActionHandler, under the hook's wrapper
let nativePlay;  // ...and its HTMLMediaElement.prototype.play
class MediaSession {
  constructor() { this._meta = null; }
  get metadata() { return this._meta; }
  set metadata(v) { this._meta = v; }
}
function media(tag = 'video', { duration = 120, paused = true, src = 'https://cdn.example/a.mp4', muted = false, loop = false, root = document.body } = {}) {
  const el = document.createElement(tag);
  const st = { paused, duration, ended: false };
  states.set(el, st);
  for (const k of ['paused', 'duration', 'ended']) Object.defineProperty(el, k, { get: () => st[k], configurable: true });
  Object.defineProperty(el, 'muted', { value: muted, writable: true, configurable: true });
  Object.defineProperty(el, 'loop', { value: loop, writable: true, configurable: true });
  if (src) el.setAttribute('src', src);
  if (root) root.append(el);
  return el;
}
const fire = (el, type) => el.dispatchEvent(new Event(type));

// ---- loading the hook, and taking every trace of it away again
let added = [];
function load() {
  const add = window.addEventListener;
  window.addEventListener = function (type, fn, opts) { added.push([type, fn, opts]); return add.call(this, type, fn, opts); };
  try { new Function(SRC)(); } finally { window.addEventListener = add; }
}
let reports = [];
const onReport = (e) => reports.push(e.detail);
const last = () => JSON.parse(reports.at(-1));
const settle = () => vi.advanceTimersByTime(150);

beforeEach(() => {
  vi.useFakeTimers();
  document.title = 'Page title';
  setHandler = vi.fn(function (action) { if (!KNOWN_ACTIONS.includes(action)) throw new TypeError(`'${action}' is not a valid MediaSessionAction`); });
  MediaSession.prototype.setActionHandler = setHandler;
  Object.defineProperty(MediaSession.prototype, 'metadata', Object.getOwnPropertyDescriptor(class { get metadata() { return this._meta; } set metadata(v) { this._meta = v; } }.prototype, 'metadata'));
  window.MediaSession = MediaSession;
  Object.defineProperty(navigator, 'mediaSession', { value: new MediaSession(), configurable: true });
  P.play = nativePlay = vi.fn(function () { states.get(this).paused = false; fire(this, 'play'); fire(this, 'playing'); return Promise.resolve(); });
  P.pause = vi.fn(function () { states.get(this).paused = true; fire(this, 'pause'); });
  reports = [];
  document.addEventListener('tabazing:media', onReport);
  load();
});
afterEach(() => {
  for (const [type, fn, opts] of added) window.removeEventListener(type, fn, opts);
  added = [];
  document.removeEventListener('tabazing:media', onReport);
  delete window[KEY];
  delete window.MediaSession;
  delete navigator.mediaSession;
  P.play = ORIGINAL.play;
  P.pause = ORIGINAL.pause;
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('reports', () => {
  it('nothing while there is no media, then one report with a JSON string for the detail', () => {
    settle();
    expect(reports).toEqual([]);
    const v = media('video');
    v.play();
    settle();
    expect(reports).toHaveLength(1);
    expect(typeof reports[0]).toBe('string');
    expect(last()).toEqual({ media: true, playing: true, kind: 'video', title: 'Page title', artist: '', canPrev: false, canNext: false, muted: false });
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
    const a = media('audio');
    fire(a, 'loadedmetadata');
    vi.advanceTimersByTime(100);
    fire(a, 'durationchange');
    vi.advanceTimersByTime(100);
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(reports).toHaveLength(1);
    expect(last()).toMatchObject({ media: true, playing: false, kind: 'audio' });
    fire(a, 'volumechange');
    settle();
    expect(reports).toHaveLength(1);
    a.play();
    settle();
    expect(reports).toHaveLength(2);
    expect(last().playing).toBe(true);
    a.muted = true;
    fire(a, 'volumechange');
    settle();
    expect(last()).toMatchObject({ playing: true, muted: true });
  });

  it('says { media: false } once the media is gone (taken out of the page: Chrome pauses it)', () => {
    const v = media('video');
    v.play();
    settle();
    v.remove();
    v.pause();
    settle();
    expect(last()).toEqual({ media: false });
    expect(reports).toHaveLength(2);
  });

  it('says { media: false } at once when the frame goes away, and again what it plays when it comes back', () => {
    const v = media('video');
    v.play();
    settle();
    window.dispatchEvent(new Event('pagehide'));
    expect(last()).toEqual({ media: false });
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
    const prev = vi.fn();
    media('video').play();
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('nexttrack', () => {});
    settle();
    expect(setHandler).toHaveBeenCalledWith('previoustrack', prev);
    expect(last()).toMatchObject({ canPrev: true, canNext: true });
    navigator.mediaSession.setActionHandler('nexttrack', null);
    settle();
    expect(last()).toMatchObject({ canPrev: true, canNext: false });
  });

  it('an action the browser refuses throws as before and is not recorded', () => {
    media('video').play();
    expect(() => navigator.mediaSession.setActionHandler('bogus', () => {})).toThrow(TypeError);
    settle();
    expect(last()).toMatchObject({ canPrev: false, canNext: false });
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

describe('which media', () => {
  it('the playing one, else the one played last, else the longest', () => {
    const v = media('video', { duration: 60 });
    media('audio', { duration: 600 });
    fire(v, 'loadedmetadata');
    settle();
    expect(last()).toMatchObject({ kind: 'audio', playing: false }); // the longest
    v.play();
    settle();
    expect(last()).toMatchObject({ kind: 'video', playing: true });
    v.pause();
    settle();
    expect(last()).toMatchObject({ kind: 'video', playing: false }); // played last, though shorter
  });

  it('the one started last when two play', () => {
    const a = media('audio', { duration: 600 });
    const v = media('video', { duration: 60 });
    a.play();
    v.play();
    settle();
    expect(last()).toMatchObject({ kind: 'video' });
  });

  it.each([
    ['shorter than 30 s', { duration: 12 }],
    ['a muted loop (a background video)', { muted: true, loop: true }],
    ['nothing loaded', { src: '' }],
    ['no duration yet', { duration: NaN }],
  ])('leaves out %s', (_, opts) => {
    const v = media('video', opts);
    fire(v, 'loadedmetadata');
    settle();
    expect(reports).toEqual([]);
  });

  it.each([
    ['live (an endless stream)', { duration: Infinity }],
    ['muted, but not looping', { muted: true }],
    ['looping, but not muted', { loop: true }],
    ['exactly 30 s', { duration: 30 }],
  ])('counts %s', (_, opts) => {
    const v = media('video', opts);
    fire(v, 'loadedmetadata');
    settle();
    expect(last().media).toBe(true);
  });

  it('a short clip counts when the page describes it in its Media Session', () => {
    const v = media('audio', { duration: 8 });
    fire(v, 'loadedmetadata');
    settle();
    expect(reports).toEqual([]);
    navigator.mediaSession.metadata = { title: 'Clip', artist: '' };
    settle();
    expect(last()).toMatchObject({ media: true, title: 'Clip' });
  });

  it('finds media in a shadow root and media never added to the page (new Audio()) once they play', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    const v = media('video', { root: shadow });
    v.play();
    settle();
    expect(last()).toMatchObject({ kind: 'video', playing: true });
    v.pause(); // its events don't reach the window: it is listened to directly
    settle();
    expect(last()).toMatchObject({ kind: 'video', playing: false });
    host.remove();
    const a = media('audio', { root: null });
    a.play();
    settle();
    expect(last()).toMatchObject({ kind: 'audio', playing: true });
  });

  it('an element never added nor played is not this page\'s media', () => {
    const a = media('audio', { root: null });
    fire(a, 'loadedmetadata');
    settle();
    expect(reports).toEqual([]);
  });
});

describe('window[Symbol.for("tabazing.media")]', () => {
  const act = (a) => window[KEY](a);

  it('is a hidden (non-enumerable) function', () => {
    expect(typeof window[KEY]).toBe('function');
    expect(Object.prototype.propertyIsEnumerable.call(window, KEY)).toBe(false);
  });

  it('plays and pauses the media itself when the page has no handler', () => {
    const v = media('video');
    expect(act('play')).toBe(true);
    expect(v.paused).toBe(false);
    expect(act('pause')).toBe(true);
    expect(v.paused).toBe(true);
  });

  it('uses the page\'s own handler when it has one', () => {
    const v = media('video');
    const play = vi.fn(), next = vi.fn(), prev = vi.fn();
    navigator.mediaSession.setActionHandler('play', play);
    navigator.mediaSession.setActionHandler('nexttrack', next);
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    expect(act('play')).toBe(true);
    expect(play).toHaveBeenCalledWith({ action: 'play' });
    expect(nativePlay).not.toHaveBeenCalled();
    expect(v.paused).toBe(true);
    expect(act('nexttrack')).toBe(true);
    expect(next).toHaveBeenCalledWith({ action: 'nexttrack' });
    expect(act('previoustrack')).toBe(true);
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it('no previous / next without the page\'s handler; nothing without media; nothing for other actions; a throwing handler is a failure', () => {
    expect(act('play')).toBe(false); // no media
    media('video');
    expect(act('nexttrack')).toBe(false);
    expect(act('previoustrack')).toBe(false);
    expect(act('seekto')).toBe(false);
    expect(act('stop')).toBe(false);
    navigator.mediaSession.setActionHandler('pause', () => { throw new Error('page bug'); });
    expect(act('pause')).toBe(false);
  });

  it('reports the change that follows', () => {
    media('video');
    act('play');
    settle();
    expect(last()).toMatchObject({ playing: true });
  });

  it('a play() the page refuses (autoplay rules) is not an unhandled rejection', async () => {
    media('video');
    nativePlay.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));
    expect(act('play')).toBe(true);
    await Promise.resolve();
  });
});

describe('idempotence', () => {
  it('a second copy in the same page changes nothing', () => {
    const hook = window[KEY];
    const play = P.play, set = MediaSession.prototype.setActionHandler;
    load();
    expect(window[KEY]).toBe(hook);
    expect(P.play).toBe(play);
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
    expect(last()).toMatchObject({ media: true, canPrev: false, title: 'Page title' });
  });
});

// The beforeEach's copy, gone (for a test that loads its own).
function afterEachCleanup() {
  for (const [type, fn, opts] of added) window.removeEventListener(type, fn, opts);
  added = [];
  delete window[KEY];
  P.play = vi.fn(function () { states.get(this).paused = false; fire(this, 'play'); return Promise.resolve(); });
}
