// utils/media.js: the media player's buttons (run in the page's main world) and its list of what plays where.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KEY, LIMITS } from '../../utils/constants.js';
import { MEDIA_ACTIONS, mediaAction, pageMediaAction, mediaEntries, loadMedia } from '../../utils/media.js';

const HOOK = Symbol.for('tabazing.media');
const sessionArea = chrome.storage.session;

describe('mediaAction', () => {
  it('runs pageMediaAction in the page\'s main world, in that one frame', async () => {
    chrome.scripting.executeScript.mockResolvedValue([{ result: true }]);
    expect(await mediaAction(7, 3, 'nexttrack')).toBe(true);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [3] }, world: 'MAIN', func: pageMediaAction, args: ['nexttrack'],
    });
  });

  it('true only when the page says it acted', async () => {
    for (const response of [[{ result: false }], [{ result: 'yes' }], [{}], []]) {
      chrome.scripting.executeScript.mockResolvedValueOnce(response);
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
  const mediaElementPrototype = HTMLMediaElement.prototype;
  const ORIGINAL = { play: mediaElementPrototype.play, pause: mediaElementPrototype.pause };
  function media(tag, { duration = 100, paused = true, src: source = 'https://cdn.example/m' } = {}) {
    const element = document.createElement(tag);
    const mediaState = { paused, duration };
    Object.defineProperty(element, 'paused', { get: () => mediaState.paused });
    Object.defineProperty(element, 'duration', { get: () => mediaState.duration });
    element._state = mediaState;
    if (source) element.setAttribute('src', source);
    document.body.append(element);
    return element;
  }
  beforeEach(() => {
    mediaElementPrototype.play = vi.fn(function () { this._state.paused = false; return Promise.resolve(); });
    mediaElementPrototype.pause = vi.fn(function () { this._state.paused = true; });
  });
  afterEach(() => {
    delete window[HOOK];
    Object.assign(mediaElementPrototype, ORIGINAL);
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
    expect(mediaElementPrototype.play.mock.contexts).toEqual([long]);
    long._state.paused = true;
    short._state.paused = false;
    expect(pageMediaAction('pause')).toBe(true);
    expect(mediaElementPrototype.pause.mock.contexts).toEqual([short]);
  });

  it('a live stream counts as the longest; no previous / next and no media mean false', () => {
    media('audio', { duration: 600 });
    const live = media('video', { duration: Infinity });
    expect(pageMediaAction('nexttrack')).toBe(false);
    expect(pageMediaAction('previoustrack')).toBe(false);
    expect(pageMediaAction('play')).toBe(true);
    expect(mediaElementPrototype.play.mock.contexts).toEqual([live]);
    document.body.replaceChildren();
    expect(pageMediaAction('play')).toBe(false);
  });

  it('a play() the page refuses is no unhandled rejection', async () => {
    media('video');
    mediaElementPrototype.play.mockImplementationOnce(() => Promise.reject(new Error('NotAllowedError')));
    expect(pageMediaAction('play')).toBe(true);
    await Promise.resolve();
  });

  it('is self-contained (Chrome serializes it into the page)', () => {
    const source = pageMediaAction.toString();
    expect(source).not.toMatch(/\b(getMedia|chrome|mediaEntries|MEDIA_ACTIONS)\b/);
  });
});

describe('mediaEntries', () => {
  const tab = (id, overrides = {}) => ({ id, windowId: 1, title: 'Tab ' + id, url: `https://www.site${id}.example/watch`, audible: false, incognito: false, lastAccessed: 100, ...overrides });
  const mediaState = (overrides = {}) => ({ media: true, playing: false, kind: 'video', title: 'T', artist: '', canPrevious: false, canNext: false, muted: false, t: 1000, ...overrides });
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(20000); }); // the reports above are a few seconds old
  afterEach(() => vi.useRealTimers());

  it('media paused for an hour drops out (as in Chrome); playing media stays however old its report', () => {
    const HOUR = LIMITS.MEDIA_PAUSED_MILLISECONDS;
    const now = 10 * HOUR;
    const list = mediaEntries({
      1: { 0: mediaState({ t: now - HOUR }) },                  // paused an hour ago: gone
      2: { 0: mediaState({ t: now - HOUR + 1000 }) },           // paused just under an hour ago: still there
      3: { 0: mediaState({ playing: true, t: now - 5 * HOUR }) }, // playing all along
      4: { 0: mediaState({ t: now - 2 * HOUR }), 3: mediaState({ title: 'embed', t: now - 60000 }) }, // an old frame and a recent one
    }, [tab(1), tab(2), tab(3), tab(4)], now);
    expect(list.map((entry) => [entry.tabId, entry.frameId])).toEqual([[3, 0], [4, 3], [2, 0]]);
  });

  it('a tab Chrome unloaded (discarded) is left out: its media is gone', () => {
    const list = mediaEntries({ 1: { 0: mediaState() }, 2: { 0: mediaState() } }, [tab(1, { discarded: true }), tab(2)]);
    expect(list.map((entry) => entry.tabId)).toEqual([2]);
  });

  it('one entry per tab, with what the switcher shows', () => {
    const firstTab = tab(1);
    const [entry] = mediaEntries({ 1: { 0: mediaState({ playing: true, title: 'Song', artist: 'Band', canNext: true }) } }, [firstTab]);
    expect(entry).toEqual({ tabId: 1, frameId: 0, title: 'Song', artist: 'Band', site: 'site1.example', playing: true, canPrevious: false, canNext: true, kind: 'video', t: 1000, tab: firstTab });
  });

  it('per tab: the frame that plays, else the top frame, else the latest', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    const list = mediaEntries({
      1: { 0: mediaState({ title: 'top', t: 9000 }), 5: mediaState({ title: 'embed', playing: true, t: 10 }) },
      2: { 0: mediaState({ title: 'top', t: 10 }), 6: mediaState({ title: 'embed', t: 9000 }) },
      3: { 4: mediaState({ title: 'old', t: 10 }), 8: mediaState({ title: 'new', t: 20 }) },
    }, tabs);
    const by = Object.fromEntries(list.map((entry) => [entry.tabId, [entry.frameId, entry.title]]));
    expect(by).toEqual({ 1: [5, 'embed'], 2: [0, 'top'], 3: [8, 'new'] });
  });

  it('playing first, then the most recent; tabs that are gone are left out', () => {
    const list = mediaEntries({
      1: { 0: mediaState({ t: 50 }) }, 2: { 0: mediaState({ playing: true, t: 10 }) }, 3: { 0: mediaState({ t: 90 }) }, 99: { 0: mediaState({ playing: true }) },
    }, [tab(1), tab(2), tab(3)]);
    expect(list.map((entry) => entry.tabId)).toEqual([2, 3, 1]);
  });

  it('a tab making sound without media (a game, a call: Web Audio, WebRTC) is not listed, as in Chrome', () => {
    const game = tab(4, { audible: true, title: 'A game' });
    const list = mediaEntries({ 1: { 0: mediaState({ playing: true, t: 5 }) } }, [tab(1, { audible: true }), game]);
    expect(list.map((entry) => entry.tabId)).toEqual([1]);
  });

  it('falls back to the tab\'s title, leaves out incognito tabs, and copes with a pending URL', () => {
    const list = mediaEntries({ 1: { 0: mediaState({ title: '' }) }, 2: { 0: mediaState() } }, [tab(1, { url: '', pendingUrl: 'https://p.example/' }), tab(2, { incognito: true }), tab(3, { audible: true, incognito: true })]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Tab 1', site: 'p.example' });
  });
});

describe('loadMedia', () => {
  it('reads what is stored and every window\'s tabs, and merges them', async () => {
    chrome._addWindow({ id: 1 });
    chrome._addWindow({ id: 2 });
    const tabA = chrome._addTab({ windowId: 1, title: 'A', url: 'https://a.example/' });
    chrome._addWindow({ id: 3, type: 'popup' }); // a site's mini-player window, an installed web app
    const tabB = chrome._addTab({ windowId: 2, title: 'B', url: 'https://b.example/', audible: true }); // sound, no media
    const tabC = chrome._addTab({ windowId: 3, title: 'C', url: 'https://c.example/' });
    const mediaState = (title, playing) => ({ 0: { media: true, playing, kind: 'audio', title, artist: '', canPrevious: true, canNext: true, muted: false, t: Date.now() } });
    await sessionArea.set({ [KEY.MEDIA]: { [tabA.id]: mediaState('Song', false), [tabC.id]: mediaState('Popup song', true) } });
    const list = await loadMedia();
    expect(chrome.tabs.query).toHaveBeenCalledWith({}); // every window, popups and apps too
    expect(list.map((entry) => [entry.tabId, entry.title, entry.playing])).toEqual([[tabC.id, 'Popup song', true], [tabA.id, 'Song', false]]);
    expect(list.some((entry) => entry.tabId === tabB.id)).toBe(false);
  });

  it('nothing stored, nothing audible: an empty list', async () => {
    chrome._addTab({ title: 'A' });
    expect(await loadMedia()).toEqual([]);
  });
});
