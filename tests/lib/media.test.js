// lib/media.js: the media player's buttons (run in the page's main world) and its list of what plays where.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KEY } from '../../lib/constants.js';
import { MEDIA_ACTIONS, mediaAction, pageMediaAction, mediaEntries, loadMedia } from '../../lib/media.js';

const HOOK = Symbol.for('tabazing.media');
const S = chrome.storage.session;

describe('mediaAction', () => {
  it('runs pageMediaAction in the page\'s main world, in that one frame', async () => {
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    expect(await mediaAction(7, 3, 'nexttrack')).toBe(true);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [3] }, world: 'MAIN', func: pageMediaAction, args: ['nexttrack'],
    });
  });

  it('true only when the page says it acted', async () => {
    for (const r of [[{ result: false }], [{ result: 'yes' }], [{}], []]) {
      chrome.scripting.executeScript.mockResolvedValueOnce(r);
      expect(await mediaAction(1, 0, 'play')).toBe(false);
    }
  });

  it('a bad frame id is the top frame; an unknown action runs nothing', async () => {
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    await mediaAction(1, -2, 'pause');
    expect(chrome.scripting.executeScript.mock.calls[0][0].target).toEqual({ tabId: 1, frameIds: [0] });
    expect(await mediaAction(1, 0, 'seekto')).toBe(false);
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(MEDIA_ACTIONS).toEqual(['play', 'pause', 'previoustrack', 'nexttrack']);
  });

  it('rejects when Chrome can\'t run it there (the caller says so)', async () => {
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('No tab with id: 9.'));
    await expect(mediaAction(9, 0, 'play')).rejects.toThrow('No tab');
  });
});

describe('pageMediaAction (in the page)', () => {
  const P = HTMLMediaElement.prototype;
  const ORIGINAL = { play: P.play, pause: P.pause };
  function media(tag, { duration = 100, paused = true, src = 'https://cdn.example/m' } = {}) {
    const el = document.createElement(tag);
    const st = { paused, duration };
    Object.defineProperty(el, 'paused', { get: () => st.paused });
    Object.defineProperty(el, 'duration', { get: () => st.duration });
    el._st = st;
    if (src) el.setAttribute('src', src);
    document.body.append(el);
    return el;
  }
  beforeEach(() => {
    P.play = vi.fn(function () { this._st.paused = false; return Promise.resolve(); });
    P.pause = vi.fn(function () { this._st.paused = true; });
  });
  afterEach(() => {
    delete window[HOOK];
    Object.assign(P, ORIGINAL);
    document.body.replaceChildren();
  });

  it('asks media-hook.js when the page has it', () => {
    window[HOOK] = vi.fn(() => true);
    expect(pageMediaAction('previoustrack')).toBe(true);
    expect(window[HOOK]).toHaveBeenCalledWith('previoustrack');
    window[HOOK] = () => 'yes'; // a page's own stand-in: only true counts
    expect(pageMediaAction('play')).toBe(false);
    window[HOOK] = () => { throw new Error('page'); };
    expect(pageMediaAction('play')).toBe(false);
  });

  it('without it (a tab open from before): plays the longest, pauses the playing one', () => {
    const short = media('audio', { duration: 40 });
    const long = media('video', { duration: 900 });
    media('video', { duration: 5000, src: '' }); // nothing loaded: not a candidate
    expect(pageMediaAction('play')).toBe(true);
    expect(P.play.mock.contexts).toEqual([long]);
    long._st.paused = true;
    short._st.paused = false;
    expect(pageMediaAction('pause')).toBe(true);
    expect(P.pause.mock.contexts).toEqual([short]);
  });

  it('a live stream counts as the longest; no previous / next and no media mean false', () => {
    media('audio', { duration: 600 });
    const live = media('video', { duration: Infinity });
    expect(pageMediaAction('nexttrack')).toBe(false);
    expect(pageMediaAction('previoustrack')).toBe(false);
    expect(pageMediaAction('play')).toBe(true);
    expect(P.play.mock.contexts).toEqual([live]);
    document.body.replaceChildren();
    expect(pageMediaAction('play')).toBe(false);
  });

  it('a play() the page refuses is no unhandled rejection', async () => {
    media('video');
    P.play.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));
    expect(pageMediaAction('play')).toBe(true);
    await Promise.resolve();
  });

  it('is self-contained (Chrome serializes it into the page)', () => {
    const src = pageMediaAction.toString();
    expect(src).not.toMatch(/\b(getMedia|chrome|mediaEntries|MEDIA_ACTIONS)\b/);
  });
});

describe('mediaEntries', () => {
  const tab = (id, p = {}) => ({ id, windowId: 1, title: 'Tab ' + id, url: `https://www.site${id}.example/watch`, audible: false, incognito: false, lastAccessed: 100, ...p });
  const st = (p = {}) => ({ media: true, playing: false, kind: 'video', title: 'T', artist: '', canPrev: false, canNext: false, muted: false, t: 1000, ...p });

  it('one entry per tab, with what the switcher shows', () => {
    const t1 = tab(1);
    const [e] = mediaEntries({ 1: { 0: st({ playing: true, title: 'Song', artist: 'Band', canNext: true }) } }, [t1]);
    expect(e).toEqual({ tabId: 1, frameId: 0, title: 'Song', artist: 'Band', site: 'site1.example', playing: true, canPrev: false, canNext: true, kind: 'video', t: 1000, tab: t1 });
  });

  it('per tab: the frame that plays, else the top frame, else the latest', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    const list = mediaEntries({
      1: { 0: st({ title: 'top', t: 9000 }), 5: st({ title: 'embed', playing: true, t: 10 }) },
      2: { 0: st({ title: 'top', t: 10 }), 6: st({ title: 'embed', t: 9000 }) },
      3: { 4: st({ title: 'old', t: 10 }), 8: st({ title: 'new', t: 20 }) },
    }, tabs);
    const by = Object.fromEntries(list.map((e) => [e.tabId, [e.frameId, e.title]]));
    expect(by).toEqual({ 1: [5, 'embed'], 2: [0, 'top'], 3: [8, 'new'] });
  });

  it('playing first, then the most recent; tabs that are gone are left out', () => {
    const list = mediaEntries({
      1: { 0: st({ t: 50 }) }, 2: { 0: st({ playing: true, t: 10 }) }, 3: { 0: st({ t: 90 }) }, 99: { 0: st({ playing: true }) },
    }, [tab(1), tab(2), tab(3)]);
    expect(list.map((e) => e.tabId)).toEqual([2, 3, 1]);
  });

  it('a tab making sound without a report (open from before) is listed with what Chrome knows', () => {
    const quiet = tab(4, { audible: true, title: 'Old radio', url: 'https://radio.example/', lastAccessed: 70 });
    const list = mediaEntries({ 1: { 0: st({ playing: true, t: 5 }) } }, [tab(1, { audible: true }), quiet, tab(5)]);
    expect(list.map((e) => e.tabId)).toEqual([4, 1]); // both playing, the radio more recent
    expect(list[0]).toEqual({ tabId: 4, frameId: 0, title: 'Old radio', artist: '', site: 'radio.example', playing: true, canPrev: false, canNext: false, kind: 'audio', t: 70, tab: quiet });
  });

  it('falls back to the tab\'s title, leaves out incognito tabs, and copes with a pending URL', () => {
    const list = mediaEntries({ 1: { 0: st({ title: '' }) }, 2: { 0: st() } }, [tab(1, { url: '', pendingUrl: 'https://p.example/' }), tab(2, { incognito: true }), tab(3, { audible: true, incognito: true })]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Tab 1', site: 'p.example' });
  });
});

describe('loadMedia', () => {
  it('reads what is stored and every window\'s tabs, and merges them', async () => {
    chrome._addWindow({ id: 1 });
    chrome._addWindow({ id: 2 });
    const a = chrome._addTab({ windowId: 1, title: 'A', url: 'https://a.example/' });
    const b = chrome._addTab({ windowId: 2, title: 'B', url: 'https://b.example/', audible: true });
    await S.set({ [KEY.MEDIA]: { [a.id]: { 0: { media: true, playing: false, kind: 'audio', title: 'Song', artist: '', canPrev: true, canNext: true, muted: false, t: 5 } } } });
    const list = await loadMedia();
    expect(chrome.tabs.query).toHaveBeenCalledWith({ windowType: 'normal' });
    expect(list.map((e) => [e.tabId, e.title, e.playing])).toEqual([[b.id, 'B', true], [a.id, 'Song', false]]);
  });

  it('nothing stored, nothing audible: an empty list', async () => {
    chrome._addTab({ title: 'A' });
    expect(await loadMedia()).toEqual([]);
  });
});
