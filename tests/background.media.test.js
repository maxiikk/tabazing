// background.js: what pages play (MESSAGE.MEDIA from media-relay.js), kept per tab and frame for the switcher's
// player, and forgotten when the tab closes or loads a new page.
import { describe, it, expect, vi } from 'vitest';
import { MESSAGE, KEY, LIMITS } from '../utils/constants.js';
import { flush, freshWorker, seed, fromSwitcherPage, fromPage, send, environment } from './helpers/background.js';

freshWorker();
const media = () => chrome.storage.session._data.get(KEY.MEDIA);
const STATE = { media: true, playing: true, kind: 'audio', title: 'Song', artist: 'Band', canPrevious: true, canNext: true, muted: false };
const report = (state, sender) => send({ type: MESSAGE.MEDIA, state: typeof state === 'string' ? state : JSON.stringify(state) }, sender);

describe('MSG.MEDIA', () => {
  it('keeps a page\'s report under its own tab and frame', async () => {
    const { tab } = seed();
    const { result, respond } = report(STATE, { ...fromPage(tab), frameId: 3 });
    await flush();
    expect(result).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
    expect(media()).toEqual({ [tab.id]: { 3: { ...STATE, t: Date.now() } } });
  });

  it('{ media: false } drops that frame (and the tab once nothing is left)', async () => {
    const { tab } = seed();
    report(STATE, fromPage(tab));
    await flush();
    report({ media: false }, fromPage(tab));
    await flush();
    expect(media()).toEqual({});
  });

  it('only from a page\'s content script with a frame: not the switcher, other extensions, or senders without a frame', async () => {
    const { tab } = seed();
    report(STATE, fromSwitcherPage(tab));
    report(STATE, { ...fromPage(tab), id: 'otherextension' });
    report(STATE, { ...fromPage(tab), frameId: undefined });
    report(STATE, { ...fromPage(tab), frameId: -1 });
    report(STATE, { ...fromPage(tab), tab: { ...tab, incognito: true } });
    report(STATE, { id: chrome.runtime.id, url: 'https://a.example/' }); // no tab
    await flush();
    expect(media()).toBeUndefined();
  });

  it('a report that doesn\'t check out is ignored', async () => {
    const { tab } = seed();
    for (const badState of ['{nope', JSON.stringify({ ...STATE, kind: 'gif' }), JSON.stringify({ ...STATE, playing: 'yes' }), 'x'.repeat(LIMITS.MEDIA_STATE_MAX + 1)]) report(badState, fromPage(tab));
    send({ type: MESSAGE.MEDIA, state: STATE }, fromPage(tab)); // an object, not the page's text
    send({ type: MESSAGE.MEDIA }, fromPage(tab));
    await flush();
    expect(media()).toBeUndefined();
  });

  it('trims and caps the text a page sends', async () => {
    const { tab } = seed();
    report({ ...STATE, title: '  ' + 'x'.repeat(1000), artist: ' A ' }, fromPage(tab));
    await flush();
    const entry = media()[tab.id][0];
    expect(entry.title).toHaveLength(LIMITS.MEDIA_TEXT_MAX);
    expect(entry.artist).toBe('A');
  });
});

describe('forgetting', () => {
  async function playing() {
    const { tab } = seed();
    const other = chrome._addTab({ url: 'https://b.example/' });
    report(STATE, fromPage(tab));
    report(STATE, fromPage(other));
    await flush();
    return { tab, other };
  }

  it('a closed tab\'s media goes', async () => {
    const { tab, other } = await playing();
    chrome.tabs.onRemoved._emit(tab.id, { windowId: tab.windowId, isWindowClosing: false });
    await flush();
    expect(Object.keys(media())).toEqual([String(other.id)]);
  });

  it('so does a tab\'s that loads a new page (or reloads)', async () => {
    const { tab, other } = await playing();
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading' }, { ...tab, status: 'loading' });
    await flush();
    expect(Object.keys(media())).toEqual([String(other.id)]);
  });

  it('once loaded, a tab that had media is asked what it plays now (a page that only changed its address still has it)', async () => {
    const { tab, other } = await playing();
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading' }, { ...tab, status: 'loading' });
    await flush();
    const resyncs = () => chrome.scripting.executeScript.mock.calls.filter(([options]) => options.world === 'MAIN' && options.func && !options.files);
    expect(resyncs()).toEqual([]); // not while loading
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab);
    chrome.tabs.onUpdated._emit(other.id, { status: 'complete' }, other); // had media, but didn't load: not asked
    await flush();
    expect(resyncs().map(([options]) => options.target)).toEqual([{ tabId: tab.id, allFrames: true }]);
    // what it runs in the page: the sync event, which media-hook.js answers and media-relay.js lets through
    const asked = vi.fn();
    document.addEventListener('tabazing:media-sync', asked);
    resyncs()[0][0].func();
    document.removeEventListener('tabazing:media-sync', asked);
    expect(asked).toHaveBeenCalledTimes(1);
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab); // asked once per load
    await flush();
    expect(resyncs()).toHaveLength(1);
  });

  it('asked even when the load completes before the forgetting is done (a page changing its own address)', async () => {
    const { tab } = await playing();
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading', url: 'https://example.com/next' }, { ...tab, status: 'loading' });
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab); // at once, as Chrome does for history.pushState
    await flush();
    expect(media()[tab.id]).toBeUndefined();
    const resyncs = chrome.scripting.executeScript.mock.calls.filter(([options]) => options.world === 'MAIN' && options.func && !options.files);
    expect(resyncs.map(([options]) => options.target)).toEqual([{ tabId: tab.id, allFrames: true }]);
  });

  it('two loads before it completes: still asked, once', async () => {
    const { tab } = await playing();
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading' }, { ...tab, status: 'loading' });
    await flush();
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading', url: 'https://example.com/b' }, { ...tab, status: 'loading' }); // nothing left to forget
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab);
    await flush();
    expect(chrome.scripting.executeScript.mock.calls.filter(([options]) => options.world === 'MAIN' && options.func && !options.files)).toHaveLength(1);
  });

  it('a tab that had no media is not asked after it loads', async () => {
    const { tab } = seed();
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading' }, { ...tab, status: 'loading' });
    await flush();
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab);
    await flush();
    expect(chrome.scripting.executeScript.mock.calls.filter(([options]) => options.world === 'MAIN' && options.func)).toEqual([]);
  });

  it('but not on other changes (a title, a page changing its own address, the load finishing)', async () => {
    const { tab } = await playing();
    chrome.tabs.onUpdated._emit(tab.id, { title: 'Next song' }, { ...tab, title: 'Next song' });
    chrome.tabs.onUpdated._emit(tab.id, { url: 'https://example.com/#2' }, { ...tab, url: 'https://example.com/#2' });
    chrome.tabs.onUpdated._emit(tab.id, { audible: false }, tab);
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab);
    await flush();
    expect(media()[tab.id]).toBeDefined();
  });
});

describe('checking with the pages (MSG.MEDIA_CHECK, as the switcher opens)', () => {
  const sessionArea = chrome.storage.session;
  const json = (overrides = {}) => JSON.stringify({ v: 3, ...STATE, ...overrides });
  // What each tab's frames answer: tabId -> [{ frameId, result }] | Error | 'hang'
  function pages(answers) {
    chrome.scripting.executeScript.mockImplementation(async ({ target, func: callback }) => {
      const answer = answers[target.tabId];
      if (answer instanceof Error) throw answer;
      if (answer === 'hang') return new Promise(() => {}); // a frozen tab: never answers
      return answer || [];
    });
  }
  async function stored(entries) {
    const at = Date.now() - 60000;
    await sessionArea.set({ [KEY.MEDIA]: Object.fromEntries(Object.entries(entries).map(([tab, frames]) => [tab, Object.fromEntries(Object.entries(frames).map(([frameId, overrides]) => [frameId, { ...STATE, ...overrides, t: at }]))])) });
    return at;
  }
  const check = async () => { send({ type: MESSAGE.MEDIA_CHECK }, fromSwitcherPage()); await flush(); vi.advanceTimersByTime(environment.background.CHECK_MILLISECONDS); await flush(); };

  it('replaces what was known with what the frames say now: a removed player\'s frame and a tab with nothing go', async () => {
    const tabA = chrome._addTab({ url: 'https://a.example/' });
    const tabB = chrome._addTab({ url: 'https://b.example/' });
    const at = await stored({ [tabA.id]: { 0: {}, 7: { title: 'Embed' } }, [tabB.id]: { 0: {} } });
    pages({ [tabA.id]: [{ frameId: 0, result: json() }], [tabB.id]: [{ frameId: 0, result: json({ media: false }) }, { frameId: 3, result: null }] });
    await check();
    expect(media()).toEqual({ [tabA.id]: { 0: { ...STATE, t: at } } }); // unchanged: its time is kept (paused media ages out)
    const call = chrome.scripting.executeScript.mock.calls[0][0];
    expect(call).toMatchObject({ target: { tabId: tabA.id, allFrames: true }, world: 'MAIN' });
  });

  it('a frame that now plays something else gets a fresh time', async () => {
    const tabA = chrome._addTab({ url: 'https://a.example/' });
    pages({ [tabA.id]: [{ frameId: 0, result: json({ playing: false, title: 'Paused' }) }] });
    const before = await stored({ [tabA.id]: { 0: { playing: true } } });
    await check();
    expect(media()[tabA.id][0]).toMatchObject({ playing: false, title: 'Paused' });
    expect(media()[tabA.id][0].t).toBeGreaterThan(before); // when the answer came
  });

  it('a tab that can\'t run scripts any more (closed, crashed) has nothing; one that doesn\'t answer in time (frozen) keeps what was known', async () => {
    const gone = chrome._addTab({ url: 'https://gone.example/' });
    const frozen = chrome._addTab({ url: 'https://frozen.example/' });
    await stored({ [gone.id]: { 0: {} }, [frozen.id]: { 0: {} } });
    pages({ [gone.id]: new Error('No tab with id'), [frozen.id]: 'hang' });
    await check();
    expect(Object.keys(media())).toEqual([String(frozen.id)]);
  });

  it('a report that doesn\'t check out counts as nothing', async () => {
    const tabA = chrome._addTab({ url: 'https://a.example/' });
    await stored({ [tabA.id]: { 0: {} } });
    pages({ [tabA.id]: [{ frameId: 0, result: '{"media":true,"playing":"yes"}' }, { frameId: 2, result: 42 }] });
    await check();
    expect(media()).toEqual({});
  });

  it('only the switcher can ask', async () => {
    const tabA = chrome._addTab({ url: 'https://a.example/' });
    await stored({ [tabA.id]: { 0: {} } });
    send({ type: MESSAGE.MEDIA_CHECK }, fromPage(tabA));
    await flush();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('what it runs in the page asks media-hook.js, and copes without it', () => {
    const { pageMediaState } = environment.background;
    expect(pageMediaState()).toBeNull();
    window[Symbol.for('tabazing.media')] = Object.assign(() => true, { state: () => json() });
    expect(pageMediaState()).toBe(json());
    window[Symbol.for('tabazing.media')] = Object.assign(() => true, { state: () => { throw new Error('page'); } });
    expect(pageMediaState()).toBeNull();
    delete window[Symbol.for('tabazing.media')];
  });
});

describe('unloaded tabs', () => {
  it('a tab Chrome discards loses its media (as in Chrome\'s controls)', async () => {
    const { tab } = seed();
    report(STATE, fromPage(tab));
    await flush();
    chrome.tabs.onUpdated._emit(tab.id, { discarded: true }, { ...tab, discarded: true });
    await flush();
    expect(media()).toEqual({});
  });
});
