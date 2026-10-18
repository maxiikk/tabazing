// lib/store.js, what each tab plays (storage.session, KEY.MEDIA): reports from untrusted pages, checked when
// they arrive (parseMedia) and on every read (getMedia).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KEY, LIMITS } from '../../lib/constants.js';

const S = chrome.storage.session;
const NOW = 1_800_000_000_000;
const STATE = { media: true, playing: true, kind: 'video', title: 'Song', artist: 'Band', canPrev: false, canNext: true, muted: false };
const stored = () => S._data.get(KEY.MEDIA);

let s;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.resetModules(); // a fresh write queue
  s = await import('../../lib/store.js');
});
afterEach(() => vi.useRealTimers());

describe('parseMedia', () => {
  it('a good report, trimmed and capped', () => {
    expect(s.parseMedia(JSON.stringify(STATE))).toEqual(STATE);
    const long = s.parseMedia(JSON.stringify({ ...STATE, title: '  ' + 'x'.repeat(500) + '  ', artist: ' A ' }));
    expect(long.title).toBe('x'.repeat(LIMITS.MEDIA_TEXT_MAX));
    expect(long.artist).toBe('A');
  });

  it('nothing playing is just { media: false }, whatever else it says', () => {
    expect(s.parseMedia('{"media":false,"title":5}')).toEqual({ media: false });
  });

  it('drops extra fields', () => {
    expect(s.parseMedia(JSON.stringify({ ...STATE, evil: '<img>', t: 5 }))).toEqual(STATE);
  });

  it.each([
    ['not a string', { media: true }],
    ['too long', JSON.stringify({ ...STATE, title: 'x'.repeat(LIMITS.MEDIA_STATE_MAX) })],
    ['not JSON', '{media'],
    ['not an object', '"media"'],
    ['an array', '[true]'],
    ['null', 'null'],
    ['no media flag', JSON.stringify({ ...STATE, media: 'yes' })],
    ['a flag that is not a boolean', JSON.stringify({ ...STATE, playing: 1 })],
    ['canNext missing', JSON.stringify({ ...STATE, canNext: undefined })],
    ['an unknown kind', JSON.stringify({ ...STATE, kind: 'image' })],
    ['a title that is not text', JSON.stringify({ ...STATE, title: { x: 1 } })],
    ['an artist that is not text', JSON.stringify({ ...STATE, artist: null })],
  ])('refuses %s', (_, v) => {
    expect(s.parseMedia(v)).toBe(null);
  });
});

describe('setMedia / getMedia / forgetMedia', () => {
  it('keeps each frame of each tab, with when it was heard from', async () => {
    await s.setMedia(4, 0, STATE);
    await s.setMedia(4, 7, { ...STATE, playing: false });
    await s.setMedia(9, 0, STATE);
    expect(await s.getMedia()).toEqual({
      4: { 0: { ...STATE, t: NOW }, 7: { ...STATE, playing: false, t: NOW } },
      9: { 0: { ...STATE, t: NOW } },
    });
  });

  it('a frame that plays nothing any more goes, and a tab with nothing left', async () => {
    await s.setMedia(4, 0, STATE);
    await s.setMedia(4, 7, STATE);
    await s.setMedia(4, 0, { media: false });
    expect(Object.keys((await s.getMedia())[4])).toEqual(['7']);
    await s.setMedia(4, 7, { media: false });
    expect(await s.getMedia()).toEqual({});
  });

  it('nothing to forget: no write', async () => {
    await s.setMedia(4, 0, { media: false });
    expect(S.set).not.toHaveBeenCalled();
    await s.forgetMedia(4);
    expect(S.set).not.toHaveBeenCalled();
  });

  it('ignores bad ids and a missing state', async () => {
    for (const [tab, frame, st] of [[-1, 0, STATE], [1.5, 0, STATE], ['3', 0, STATE], [3, -1, STATE], [3, null, STATE], [3, 0, null]]) await s.setMedia(tab, frame, st);
    expect(S.set).not.toHaveBeenCalled();
  });

  it('keeps the latest few frames of a tab', async () => {
    for (let f = 0; f < LIMITS.MEDIA_FRAMES_MAX + 3; f++) { vi.setSystemTime(NOW + f); await s.setMedia(1, f, STATE); }
    const frames = Object.keys((await s.getMedia())[1]).map(Number).sort((a, b) => a - b);
    expect(frames).toHaveLength(LIMITS.MEDIA_FRAMES_MAX);
    expect(frames[0]).toBe(3);
  });

  it('writes one at a time: reports arriving together are all kept', async () => {
    await Promise.all([s.setMedia(1, 0, STATE), s.setMedia(2, 0, STATE), s.setMedia(1, 3, STATE)]);
    expect(Object.keys(await s.getMedia())).toEqual(['1', '2']);
    expect(Object.keys((await s.getMedia())[1])).toEqual(['0', '3']);
  });

  it('forgetMedia drops one tab', async () => {
    await s.setMedia(1, 0, STATE);
    await s.setMedia(2, 0, STATE);
    await s.forgetMedia(1);
    expect(Object.keys(stored())).toEqual(['2']);
  });

  it('getMedia checks what is stored: bad tabs, frames and entries are left out', async () => {
    const good = { ...STATE, t: NOW };
    S._data.set(KEY.MEDIA, {
      1: { 0: good, x: good, 2: { ...good, t: 0 }, 3: { ...good, kind: 'gif' }, 4: { ...good, media: false }, 5: null, 6: { ...good, title: 'y'.repeat(400) } },
      abc: { 0: good },
      7: [good],
      8: { 0: 'nope' },
      9: null,
    });
    const got = await s.getMedia();
    expect(Object.keys(got)).toEqual(['1']);
    expect(Object.keys(got[1])).toEqual(['0', '6']);
    expect(got[1][6].title).toHaveLength(LIMITS.MEDIA_TEXT_MAX);
    for (const bad of ['nope', [1, 2], null, 5]) {
      S._data.set(KEY.MEDIA, bad);
      expect(await s.getMedia()).toEqual({});
    }
  });
});
