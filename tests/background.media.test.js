// background.js: what pages play (MSG.MEDIA from media-relay.js), kept per tab and frame for the switcher's
// player, and forgotten when the tab closes or loads a new page.
import { describe, it, expect, vi } from 'vitest';
import { MSG, KEY, LIMITS } from '../lib/constants.js';
import { flush, freshWorker, seed, fromSwitcherPage, fromPage, send } from './background.shared.js';

freshWorker();
const media = () => chrome.storage.session._data.get(KEY.MEDIA);
const STATE = { media: true, playing: true, kind: 'audio', title: 'Song', artist: 'Band', canPrev: true, canNext: true, muted: false };
const report = (state, sender) => send({ type: MSG.MEDIA, state: typeof state === 'string' ? state : JSON.stringify(state) }, sender);

describe('MSG.MEDIA', () => {
  it('keeps a page\'s report under its own tab and frame', async () => {
    const { tab } = seed();
    const { ret, respond } = report(STATE, { ...fromPage(tab), frameId: 3 });
    await flush();
    expect(ret).toBeUndefined();
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
    for (const bad of ['{nope', JSON.stringify({ ...STATE, kind: 'gif' }), JSON.stringify({ ...STATE, playing: 'yes' }), 'x'.repeat(LIMITS.MEDIA_STATE_MAX + 1)]) report(bad, fromPage(tab));
    send({ type: MSG.MEDIA, state: STATE }, fromPage(tab)); // an object, not the page's text
    send({ type: MSG.MEDIA }, fromPage(tab));
    await flush();
    expect(media()).toBeUndefined();
  });

  it('trims and caps the text a page sends', async () => {
    const { tab } = seed();
    report({ ...STATE, title: '  ' + 'x'.repeat(1000), artist: ' A ' }, fromPage(tab));
    await flush();
    const e = media()[tab.id][0];
    expect(e.title).toHaveLength(LIMITS.MEDIA_TEXT_MAX);
    expect(e.artist).toBe('A');
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
    const resyncs = () => chrome.scripting.executeScript.mock.calls.filter(([o]) => o.world === 'MAIN' && o.func && !o.files);
    expect(resyncs()).toEqual([]); // not while loading
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab);
    chrome.tabs.onUpdated._emit(other.id, { status: 'complete' }, other); // had media, but didn't load: not asked
    await flush();
    expect(resyncs().map(([o]) => o.target)).toEqual([{ tabId: tab.id, allFrames: true }]);
    // what it runs in the page: the hook's sync, if the page has the hook
    const sync = vi.fn();
    window[Symbol.for('tabazing.media')] = Object.assign(() => true, { sync });
    resyncs()[0][0].func();
    expect(sync).toHaveBeenCalledTimes(1);
    delete window[Symbol.for('tabazing.media')];
    expect(() => resyncs()[0][0].func()).not.toThrow(); // no hook: nothing
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab); // asked once per load
    await flush();
    expect(resyncs()).toHaveLength(1);
  });

  it('a tab that had no media is not asked after it loads', async () => {
    const { tab } = seed();
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading' }, { ...tab, status: 'loading' });
    await flush();
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab);
    await flush();
    expect(chrome.scripting.executeScript.mock.calls.filter(([o]) => o.world === 'MAIN' && o.func)).toEqual([]);
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
