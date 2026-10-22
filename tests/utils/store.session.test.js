// storage.session state: MRU, discarded tabs, tab meta + closed-tab log, launch tokens, overlay, resume, capture notes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KEY, LIMITS, tabMetaKey } from '../../utils/constants.js';

const localArea = chrome.storage.local;
const sessionArea = chrome.storage.session;
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

let store;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.resetModules(); // fresh queue and tab-meta cache
  store = await import('../../utils/store.js');
});
afterEach(() => vi.useRealTimers());

describe('withLock', () => {
  it('uses Web Locks when there are any', async () => {
    const request = vi.fn((name, callback) => callback());
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    try {
      expect(await store.withLock('x', async () => 42)).toBe(42);
      expect(request).toHaveBeenCalledWith('tabazing:x', expect.any(Function));
    } finally {
      delete navigator.locks;
    }
  });

  it('falls back to the in-page queue: runs one at a time, in order', async () => {
    expect(navigator.locks).toBeUndefined();
    const log = [];
    const job = (id, milliseconds) => store.withLock('y', () => new Promise((resolve) => setTimeout(() => { log.push(id); resolve(id); }, milliseconds)));
    expect(await Promise.all([job(1, 20), job(2, 0), job(3, 5)])).toEqual([1, 2, 3]);
    expect(log).toEqual([1, 2, 3]);
  });

  it('a failing job does not block the queue', async () => {
    await expect(store.withLock('z', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await store.withLock('z', async () => 'ok')).toBe('ok');
  });
});

describe('MRU', () => {
  it('getMru validates and caps what is stored', async () => {
    expect(await store.getMru()).toEqual([]);
    sessionArea._data.set(KEY.MRU, 'nope');
    expect(await store.getMru()).toEqual([]);
    sessionArea._data.set(KEY.MRU, [3, -1, 1.5, '4', null, 2]);
    expect(await store.getMru()).toEqual([3, 2]);
    sessionArea._data.set(KEY.MRU, Array.from({ length: LIMITS.MAX_MRU + 10 }, (unused, i) => i));
    expect(await store.getMru()).toHaveLength(LIMITS.MAX_MRU);
  });

  it('touchMru moves a tab to the front, once', async () => {
    await store.touchMru(1);
    await store.touchMru(2);
    await store.touchMru(1);
    expect(await store.getMru()).toEqual([1, 2]);
  });

  it('touchMru keeps the cap', async () => {
    await store.setMru(Array.from({ length: LIMITS.MAX_MRU }, (unused, i) => i));
    await store.touchMru(9999);
    const mru = await store.getMru();
    expect(mru).toHaveLength(LIMITS.MAX_MRU);
    expect(mru[0]).toBe(9999);
    expect(mru).not.toContain(LIMITS.MAX_MRU - 1);
  });

  it('concurrent updates are not lost', async () => {
    await Promise.all(Array.from({ length: 20 }, (unused, i) => store.touchMru(i)));
    expect((await store.getMru()).sort((first, second) => first - second)).toEqual(Array.from({ length: 20 }, (unused, i) => i));
    await Promise.all([store.removeFromMru(3), store.removeFromMru(4), store.touchMru(100)]);
    const mru = await store.getMru();
    expect(mru[0]).toBe(100);
    expect(mru).not.toContain(3);
    expect(mru).not.toContain(4);
  });

  it('a failed update does not block the next ones', async () => {
    sessionArea.get.mockRejectedValueOnce(new Error('gone'));
    await expect(store.touchMru(1)).rejects.toThrow('gone');
    await store.touchMru(2);
    expect(await store.getMru()).toEqual([2]);
  });

  it('removeFromMru', async () => {
    await store.setMru([1, 2, 3]);
    await store.removeFromMru(2);
    expect(await store.getMru()).toEqual([1, 3]);
  });

  it('replaceInMru swaps an id in place and drops an older copy of the new one', async () => {
    await store.setMru([1, 2, 3, 4]);
    await store.replaceInMru(2, 4);
    expect(await store.getMru()).toEqual([1, 4, 3]);
  });

  it('seedMru only fills an empty list, with valid ids', async () => {
    await store.seedMru([5, -1, 6]);
    expect(await store.getMru()).toEqual([5, 6]);
    await store.seedMru([7]);
    expect(await store.getMru()).toEqual([5, 6]);
  });

  it('setMru validates and caps', async () => {
    await store.setMru([1, 'x', 2, ...Array.from({ length: LIMITS.MAX_MRU }, (unused, i) => 10 + i)]);
    const storedMru = sessionArea._data.get(KEY.MRU);
    expect(storedMru).toHaveLength(LIMITS.MAX_MRU);
    expect(storedMru.slice(0, 2)).toEqual([1, 2]);
  });
});

describe('discarded tabs', () => {
  it('getSlept validates', async () => {
    sessionArea._data.set(KEY.SLEPT, [1, 'a', -2, 3]);
    expect(await store.getSlept()).toEqual([1, 3]);
    sessionArea._data.set(KEY.SLEPT, {});
    expect(await store.getSlept()).toEqual([]);
  });

  it('markDiscarded adds and removes, and skips no-op writes', async () => {
    await store.markDiscarded(1, true);
    await store.markDiscarded(2, true);
    await store.markDiscarded(1, true);
    expect(await store.getSlept()).toEqual([1, 2]);
    expect(sessionArea.set).toHaveBeenCalledTimes(2);
    await store.markDiscarded(1, false);
    await store.markDiscarded(9, false);
    expect(await store.getSlept()).toEqual([2]);
    expect(sessionArea.set).toHaveBeenCalledTimes(3);
  });

  it('markDiscarded ignores bad ids and keeps the newest MAX_SLEPT', async () => {
    await store.markDiscarded(-1, true);
    await store.markDiscarded('3', true);
    expect(sessionArea.set).not.toHaveBeenCalled();
    sessionArea._data.set(KEY.SLEPT, Array.from({ length: LIMITS.MAX_SLEPT }, (unused, i) => i));
    await store.markDiscarded(99999, true);
    const slept = await store.getSlept();
    expect(slept).toHaveLength(LIMITS.MAX_SLEPT);
    expect(slept[0]).toBe(1);
    expect(slept.at(-1)).toBe(99999);
  });

  it('moveDiscarded follows a replaced tab, only if the old one slept', async () => {
    sessionArea._data.set(KEY.SLEPT, [1, 2, 5]);
    await store.moveDiscarded(2, 5);
    expect(await store.getSlept()).toEqual([1, 5]);
    await store.moveDiscarded(7, 8);
    expect(await store.getSlept()).toEqual([1, 5]);
    await store.moveDiscarded(1, -1);
    expect(await store.getSlept()).toEqual([1, 5]);
  });
});

describe('tab meta and the closed-tab log', () => {
  const tab = (overrides = {}) => ({ id: 1, url: 'https://a.com/x', title: 'A', favIconUrl: 'https://a.com/f.ico', incognito: false, ...overrides });

  it('rememberTab stores url/title/icon, and skips repeats', async () => {
    await store.rememberTab(tab());
    expect(sessionArea._data.get(tabMetaKey(1))).toEqual({ u: 'https://a.com/x', ti: 'A', f: 'https://a.com/f.ico' });
    await store.rememberTab(tab());
    expect(sessionArea.set).toHaveBeenCalledTimes(1);
    await store.rememberTab(tab({ title: 'B' }));
    expect(sessionArea.set).toHaveBeenCalledTimes(2);
  });

  it('rememberTab cleans what it stores, and stores nothing for tabs not worth logging', async () => {
    await store.rememberTab(tab({ title: 'x'.repeat(400), favIconUrl: 'data:image/png;base64,AA' }));
    expect(sessionArea._data.get(tabMetaKey(1))).toEqual({ u: 'https://a.com/x', ti: 'x'.repeat(300), f: '' });
    await store.rememberTab(tab({ id: 2, url: '', pendingUrl: 'https://p.com/' }));
    expect(sessionArea._data.get(tabMetaKey(2)).u).toBe('https://p.com/');
    for (const bad of [tab({ id: 3, incognito: true }), tab({ id: 4, url: 'chrome://newtab/' }), tab({ id: 5, url: 'javascript:alert(1)' }),
      tab({ id: 6, url: chrome.runtime.getURL('markup/switcher.html') }), tab({ id: -1 }), null]) await store.rememberTab(bad);
    expect([...sessionArea._data.keys()].sort()).toEqual([tabMetaKey(1), tabMetaKey(2)]);
  });

  it('rememberTab of a tab now on a page not worth logging forgets the page it was on before (once)', async () => {
    await store.rememberTab(tab());
    for (const url of ['chrome://newtab/', 'about:blank', 'data:text/html,x', chrome.runtime.getURL('markup/switcher.html'), 'https://a.com/' + 'x'.repeat(LIMITS.MAX_URL_KEY)]) {
      await store.rememberTab(tab());
      expect(sessionArea._data.has(tabMetaKey(1))).toBe(true);
      await store.rememberTab(tab({ url }));
      expect(sessionArea._data.has(tabMetaKey(1))).toBe(false);
    }
    sessionArea.remove.mockClear();
    await store.rememberTab(tab({ url: 'chrome://newtab/', title: 'New Tab' }));
    expect(sessionArea.remove).not.toHaveBeenCalled(); // already gone: no write
    await store.rememberTab(tab());
    expect(sessionArea._data.get(tabMetaKey(1))).toMatchObject({ u: 'https://a.com/x' }); // back on a page: remembered again
  });

  it('rememberTabs writes many at once', async () => {
    await store.rememberTabs([tab(), tab({ id: 2, url: 'https://b.com/' }), tab({ id: 3, incognito: true })]);
    expect(sessionArea.set).toHaveBeenCalledTimes(1);
    expect(Object.keys(sessionArea.set.mock.calls[0][0])).toEqual([tabMetaKey(1), tabMetaKey(2)]);
    await store.rememberTab(tab()); // already known
    expect(sessionArea.set).toHaveBeenCalledTimes(1);
  });

  it('forgetTabMeta removes it, so the next remember writes again', async () => {
    await store.rememberTab(tab());
    await store.forgetTabMeta(1);
    expect(sessionArea._data.has(tabMetaKey(1))).toBe(false);
    await store.rememberTab(tab());
    expect(sessionArea._data.has(tabMetaKey(1))).toBe(true);
  });

  it('logClosedTab moves the meta into the log, newest first, one entry per page', async () => {
    await store.rememberTabs([tab(), tab({ id: 2, url: 'https://b.com/', title: 'B', favIconUrl: '' }), tab({ id: 3, url: 'https://a.com/x/#frag', title: 'A2' })]);
    await store.logClosedTab(1);
    vi.setSystemTime(NOW + 1000);
    await store.logClosedTab(2);
    vi.setSystemTime(NOW + 2000);
    await store.logClosedTab(3);
    expect(sessionArea._data.has(tabMetaKey(1))).toBe(false);
    expect(await store.getClosedLog()).toEqual([
      { url: 'https://a.com/x/#frag', title: 'A2', favIconUrl: 'https://a.com/f.ico', closedAt: NOW + 2000 },
      { url: 'https://b.com/', title: 'B', favIconUrl: '', closedAt: NOW + 1000 },
    ]);
  });

  it('logClosedTab of an unknown tab, or bad meta, logs nothing', async () => {
    await store.logClosedTab(42);
    sessionArea._data.set(tabMetaKey(7), { u: 'javascript:x' });
    await store.logClosedTab(7);
    expect(sessionArea._data.has(tabMetaKey(7))).toBe(false);
    expect(localArea._data.has(KEY.CLOSED_LOG)).toBe(false);
  });

  it('logClosedTab fills in a missing title or icon, and caps the log', async () => {
    localArea._data.set(KEY.CLOSED_LOG, Array.from({ length: LIMITS.MAX_CLOSED_LOG }, (unused, i) => ({ url: `https://p${i}.com/`, title: '', favIconUrl: '', closedAt: NOW - i })));
    sessionArea._data.set(tabMetaKey(7), { u: 'https://new.com/', ti: 5 });
    await store.logClosedTab(7);
    const log = await store.getClosedLog();
    expect(log).toHaveLength(LIMITS.MAX_CLOSED_LOG);
    expect(log[0]).toEqual({ url: 'https://new.com/', title: '', favIconUrl: '', closedAt: NOW });
    expect(log.at(-1).url).toBe(`https://p${LIMITS.MAX_CLOSED_LOG - 2}.com/`);
  });

  it('logClosedTab gathers closes made together into one write, in closing order', async () => {
    await store.rememberTabs([tab(), tab({ id: 2, url: 'https://b.com/', title: 'B', favIconUrl: '' }), tab({ id: 3, url: 'https://a.com/x#2', title: 'A2' })]);
    localArea._data.set(KEY.CLOSED_LOG, [{ url: 'https://b.com', title: 'old B', favIconUrl: '', closedAt: NOW - 5000 }]);
    localArea.set.mockClear();
    sessionArea.get.mockClear();
    const promises = [store.logClosedTab(1)];
    vi.setSystemTime(NOW + 10);
    promises.push(store.logClosedTab(2));
    vi.setSystemTime(NOW + 20);
    promises.push(store.logClosedTab(3), store.logClosedTab(42));
    await Promise.all(promises);
    expect(localArea.set).toHaveBeenCalledTimes(1);
    expect(sessionArea.get).toHaveBeenCalledTimes(1);
    expect(await store.getClosedLog()).toEqual([
      { url: 'https://a.com/x#2', title: 'A2', favIconUrl: 'https://a.com/f.ico', closedAt: NOW + 20 },
      { url: 'https://b.com/', title: 'B', favIconUrl: '', closedAt: NOW + 10 },
    ]);
    expect([1, 2, 3].some((id) => sessionArea._data.has(tabMetaKey(id)))).toBe(false);
  });

  it('flushClosedTabs writes the waiting closes at once (the worker is being suspended)', async () => {
    await store.rememberTab(tab());
    const logged = store.logClosedTab(1);
    await store.flushClosedTabs();
    expect((await store.getClosedLog()).map((entry) => entry.url)).toEqual(['https://a.com/x']);
    await logged;
    await store.flushClosedTabs(); // nothing waiting: nothing to do
    expect(localArea.set).toHaveBeenCalledTimes(1);
  });

  it('getClosedLog drops invalid and week-old entries', async () => {
    const ok = { url: 'https://a.com/', title: 'A', favIconUrl: '', closedAt: NOW - 1000 };
    localArea._data.set(KEY.CLOSED_LOG, [ok,
      { ...ok, closedAt: NOW - LIMITS.CLOSED_LOG_TIME_TO_LIVE_MILLISECONDS }, { ...ok, url: 'javascript:1' }, { ...ok, title: 1 }, { ...ok, favIconUrl: null },
      { ...ok, closedAt: 'x' }, { ...ok, url: 'https://a.com/' + 'x'.repeat(LIMITS.MAX_URL_KEY) }, null, 'x']);
    expect(await store.getClosedLog()).toEqual([ok]);
    localArea._data.set(KEY.CLOSED_LOG, { not: 'a list' });
    expect(await store.getClosedLog()).toEqual([]);
  });

  it('cleanupClosedLog rewrites the log only when something was dropped', async () => {
    const ok = { url: 'https://a.com/', title: 'A', favIconUrl: '', closedAt: NOW - 1000 };
    localArea._data.set(KEY.CLOSED_LOG, [ok]);
    await store.cleanupClosedLog();
    expect(localArea.set).not.toHaveBeenCalled();
    localArea._data.set(KEY.CLOSED_LOG, [ok, { ...ok, closedAt: NOW - 8 * DAY }]);
    await store.cleanupClosedLog();
    expect(localArea._data.get(KEY.CLOSED_LOG)).toEqual([ok]);
    localArea._data.delete(KEY.CLOSED_LOG);
    await store.cleanupClosedLog();
    expect(localArea._data.get(KEY.CLOSED_LOG)).toEqual([]);
  });
});

describe('launch tokens', () => {
  const launchContext = { sourceTab: 4, window: 2, state: 'maximized', direction: -1, hold: true, mode: 'overlay', via: 'icon' };

  it('createLaunch stores a random token with the context; consumeLaunch returns it once', async () => {
    const token = await store.createLaunch(launchContext);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(sessionArea._data.get(KEY.LAUNCH)).toEqual({ token, t: NOW, context: launchContext });
    const launch = await store.consumeLaunch(token);
    expect(launch).toEqual({ sourceTab: 4, sourceWindow: 2, sourceState: 'maximized', direction: -1, hold: true, mode: 'overlay', via: 'icon', palette: false });
    expect(Object.isFrozen(launch)).toBe(true);
    expect(await store.consumeLaunch(token)).toBeNull();
  });

  it('each launch gets a new token, and only the latest is valid', async () => {
    const firstToken = await store.createLaunch(launchContext);
    const secondToken = await store.createLaunch(launchContext);
    expect(firstToken).not.toBe(secondToken);
    expect(await store.consumeLaunch(firstToken)).toBeNull();
    expect(await store.consumeLaunch(secondToken)).not.toBeNull();
  });

  it('a wrong token does not invalidate the real one', async () => {
    const token = await store.createLaunch(launchContext);
    for (const bad of ['nope', '', null, undefined, 5, { token }]) expect(await store.consumeLaunch(bad)).toBeNull();
    expect(await store.consumeLaunch(token)).not.toBeNull();
  });

  it('expires after LAUNCH_TTL_MS (and is used up anyway)', async () => {
    const token = await store.createLaunch(launchContext);
    vi.setSystemTime(NOW + LIMITS.LAUNCH_TIME_TO_LIVE_MILLISECONDS + 1);
    expect(await store.consumeLaunch(token)).toBeNull();
    expect(sessionArea._data.has(KEY.LAUNCH)).toBe(false);
  });

  it('is still valid exactly at the TTL', async () => {
    const token = await store.createLaunch(launchContext);
    vi.setSystemTime(NOW + LIMITS.LAUNCH_TIME_TO_LIVE_MILLISECONDS);
    expect(await store.consumeLaunch(token)).not.toBeNull();
  });

  it('defaults bad optional fields', async () => {
    const token = await store.createLaunch({ sourceTab: 0, window: 0, state: 'minimized', direction: 7, hold: 'yes', mode: 'popup', via: 'evil' });
    expect(await store.consumeLaunch(token)).toEqual({ sourceTab: 0, sourceWindow: 0, sourceState: 'normal', direction: 1, hold: false, mode: 'window', via: 'key', palette: false });
    const secondToken = await store.createLaunch({ sourceTab: 1, window: 1, direction: 0, via: 'startup' });
    expect(await store.consumeLaunch(secondToken)).toMatchObject({ direction: 0, via: 'startup' });
  });

  it('rejects a context without valid tab and window ids, or a bad stored launch', async () => {
    for (const context of [{ sourceTab: -1, window: 1 }, { sourceTab: 1, window: 'x' }, {}, null]) {
      const token = await store.createLaunch(context);
      expect(await store.consumeLaunch(token)).toBeNull();
    }
    sessionArea._data.set(KEY.LAUNCH, { token: 'tok', t: 'when', context: launchContext });
    expect(await store.consumeLaunch('tok')).toBeNull();
    sessionArea._data.set(KEY.LAUNCH, { token: 5, t: NOW, context: launchContext });
    expect(await store.consumeLaunch(5)).toBeNull();
  });
});

describe('overlay tab', () => {
  it('is remembered for 10 minutes', async () => {
    await store.setOverlayTab(3);
    expect(await store.isOverlayTab(3)).toBe(true);
    expect(await store.isOverlayTab(4)).toBe(false);
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    expect(await store.isOverlayTab(3)).toBe(false);
  });

  it('clearOverlayTab forgets it', async () => {
    await store.setOverlayTab(3);
    await store.clearOverlayTab();
    expect(await store.isOverlayTab(3)).toBe(false);
  });

  it('ignores a bad stored value', async () => {
    sessionArea._data.set(KEY.OVERLAY, { tabId: 3, t: 'x' });
    expect(await store.isOverlayTab(3)).toBe(false);
  });
});

describe('resume note', () => {
  it('is taken once, with its time', async () => {
    await store.setResume({ query: 'abc', scope: 'all' });
    expect(await store.takeResume()).toEqual({ query: 'abc', scope: 'all', t: NOW });
    expect(await store.takeResume()).toBeNull();
  });

  it('expires after RESUME_TTL_MS, and is removed anyway', async () => {
    await store.setResume({ query: 'abc' });
    vi.setSystemTime(NOW + LIMITS.RESUME_TIME_TO_LIVE_MILLISECONDS);
    expect(await store.takeResume()).toBeNull();
    expect(sessionArea._data.has(KEY.RESUME)).toBe(false);
  });

  it('ignores a bad stored value', async () => {
    sessionArea._data.set(KEY.RESUME, { query: 'x', t: -5 });
    expect(await store.takeResume()).toBeNull();
  });
});

describe('capture notes', () => {
  it('noteCapture stores the stage, message and host only', async () => {
    await store.noteCapture('error', new Error('Failed'), 'https://a.com/secret?q=1');
    expect(await store.getCaptureNote()).toEqual({ t: NOW, stage: 'error', message: 'Error: Failed', host: 'a.com' });
    await store.noteCapture('skip');
    expect(await store.getCaptureNote()).toEqual({ t: NOW, stage: 'skip', message: '', host: '' });
  });

  it('getCaptureNote validates', async () => {
    expect(await store.getCaptureNote()).toBeNull();
    sessionArea._data.set(KEY.CAPTURE_DIAGNOSIS, { t: 0, stage: 'ok' });
    expect(await store.getCaptureNote()).toBeNull();
    sessionArea._data.set(KEY.CAPTURE_DIAGNOSIS, { t: 5, stage: 3, message: null });
    expect(await store.getCaptureNote()).toEqual({ t: 5, stage: '3', message: '', host: '' });
  });

  it('pages Chrome blocks are remembered; a later success forgets them', async () => {
    await store.noteCapture('error', 'The extensions gallery cannot be scripted.', 'https://chromewebstore.google.com/x#y');
    await store.noteCapture('error', 'Cannot access contents of url', 'https://b.com/');
    await store.noteCapture('error', 'some other failure', 'https://c.com/');
    expect(await store.getNoCapture()).toEqual(new Set(['https://b.com/', 'https://chromewebstore.google.com/x']));
    await store.noteCapture('ok', '', 'https://b.com');
    expect(await store.getNoCapture()).toEqual(new Set(['https://chromewebstore.google.com/x']));
  });

  it('a success on a page that is not listed writes nothing', async () => {
    await store.noteCapture('ok', '', 'https://a.com/');
    expect(sessionArea._data.has(KEY.NO_CAPTURE)).toBe(false);
    sessionArea._data.set(KEY.NO_CAPTURE, ['https://b.com/']);
    sessionArea.set.mockClear();
    await store.noteCapture('ok', '', 'https://a.com/');
    expect(sessionArea.set.mock.calls.filter(([items]) => KEY.NO_CAPTURE in items)).toHaveLength(0);
    expect(sessionArea._data.get(KEY.NO_CAPTURE)).toEqual(['https://b.com/']);
  });

  it('the blocked list holds each page once, newest first, at most 300', async () => {
    sessionArea._data.set(KEY.NO_CAPTURE, Array.from({ length: 300 }, (unused, i) => `https://p${i}/`));
    await store.noteCapture('error', 'cannot access', 'https://p5/');
    await store.noteCapture('error', 'cannot access', 'https://new/');
    const blockedList = sessionArea._data.get(KEY.NO_CAPTURE);
    expect(blockedList).toHaveLength(300);
    expect(blockedList.slice(0, 2)).toEqual(['https://new/', 'https://p5/']);
    expect(blockedList.filter((x) => x === 'https://p5/')).toHaveLength(1);
  });

  it('getNoCapture validates', async () => {
    expect(await store.getNoCapture()).toEqual(new Set());
    sessionArea._data.set(KEY.NO_CAPTURE, ['https://a/', 3, null]);
    expect(await store.getNoCapture()).toEqual(new Set(['https://a/']));
  });

  it('never throws, even when storage fails', async () => {
    sessionArea.set.mockRejectedValue(new Error('gone'));
    await expect(store.noteCapture('error', 'cannot access', 'https://a.com/')).resolves.toBeUndefined();
  });

  // BUG: utils/store.js:559 only guards with `|| []`, so a stored non-array NO_CAPTURE (e.g. {}) makes `.filter`
  // throw; the error is swallowed and the blocked page is never recorded, for the rest of the session.
  // Every other reader in store.js treats bad stored data as empty.
  it('a bad stored blocked list is treated as empty', async () => {
    sessionArea._data.set(KEY.NO_CAPTURE, { bad: true });
    await store.noteCapture('error', 'cannot access', 'https://a.com/');
    expect(await store.getNoCapture()).toEqual(new Set(['https://a.com/']));
  });
});

describe('woken snoozed tabs', () => {
  it('records each woken tab with when it woke', async () => {
    expect(await store.getWoken()).toEqual({});
    await store.markWoken(5);
    await store.markWoken(7, NOW - 1000);
    expect(await store.getWoken()).toEqual({ 5: NOW, 7: NOW - 1000 });
    expect(sessionArea._data.get(KEY.WOKEN)).toEqual({ 5: NOW, 7: NOW - 1000 });
  });

  it('ignores a bad tab id', async () => {
    await store.markWoken(undefined);
    await store.markWoken(-1);
    expect(sessionArea._data.has(KEY.WOKEN)).toBe(false);
  });

  it('drops entries older than a day, and invalid ones, on read', async () => {
    sessionArea._data.set(KEY.WOKEN, { 1: NOW - LIMITS.WOKEN_TIME_TO_LIVE_MILLISECONDS, 2: NOW - LIMITS.WOKEN_TIME_TO_LIVE_MILLISECONDS + 1, x: NOW, 3: 'soon', 4: -5 });
    expect(await store.getWoken()).toEqual({ 2: NOW - LIMITS.WOKEN_TIME_TO_LIVE_MILLISECONDS + 1 });
    for (const value of [null, [], 'x']) { sessionArea._data.set(KEY.WOKEN, value); expect(await store.getWoken()).toEqual({}); }
  });

  it('forgetWoken removes one, and writes nothing for a tab that is not there', async () => {
    await store.markWoken(5);
    await store.markWoken(6);
    await store.forgetWoken(5);
    expect(await store.getWoken()).toEqual({ 6: NOW });
    sessionArea.set.mockClear();
    await store.forgetWoken(99);
    expect(sessionArea.set).not.toHaveBeenCalled();
  });
});

describe('the tab group the switcher is inside of', () => {
  it('setGroup keeps it, getGroup reads it back; null (or anything but an id) forgets it', async () => {
    expect(await store.getGroup()).toBe(null);
    await store.setGroup(12);
    expect(await store.getGroup()).toBe(12);
    expect(sessionArea._data.get(KEY.GROUP)).toEqual({ id: 12, t: NOW });
    await store.setGroup(null);
    expect(await store.getGroup()).toBe(null);
    expect(sessionArea._data.has(KEY.GROUP)).toBe(false);
    sessionArea._data.set(KEY.GROUP, { id: 'x' });
    expect(await store.getGroup()).toBe(null);
  });
});
