// storage.session state: MRU, discarded tabs, tab meta + closed-tab log, launch tokens, overlay, resume, capture notes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KEY, LIMITS, tabMetaKey } from '../../lib/constants.js';

const L = chrome.storage.local;
const S = chrome.storage.session;
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

let s;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.resetModules(); // fresh queue and tab-meta cache
  s = await import('../../lib/store.js');
});
afterEach(() => vi.useRealTimers());

describe('withLock', () => {
  it('uses Web Locks when there are any', async () => {
    const request = vi.fn((name, fn) => fn());
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    try {
      expect(await s.withLock('x', async () => 42)).toBe(42);
      expect(request).toHaveBeenCalledWith('tabazing:x', expect.any(Function));
    } finally {
      delete navigator.locks;
    }
  });

  it('falls back to the in-page queue: runs one at a time, in order', async () => {
    expect(navigator.locks).toBeUndefined();
    const log = [];
    const job = (n, ms) => s.withLock('y', () => new Promise((r) => setTimeout(() => { log.push(n); r(n); }, ms)));
    expect(await Promise.all([job(1, 20), job(2, 0), job(3, 5)])).toEqual([1, 2, 3]);
    expect(log).toEqual([1, 2, 3]);
  });

  it('a failing job does not block the queue', async () => {
    await expect(s.withLock('z', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await s.withLock('z', async () => 'ok')).toBe('ok');
  });
});

describe('MRU', () => {
  it('getMru validates and caps what is stored', async () => {
    expect(await s.getMru()).toEqual([]);
    S._data.set(KEY.MRU, 'nope');
    expect(await s.getMru()).toEqual([]);
    S._data.set(KEY.MRU, [3, -1, 1.5, '4', null, 2]);
    expect(await s.getMru()).toEqual([3, 2]);
    S._data.set(KEY.MRU, Array.from({ length: LIMITS.MAX_MRU + 10 }, (_, i) => i));
    expect(await s.getMru()).toHaveLength(LIMITS.MAX_MRU);
  });

  it('touchMru moves a tab to the front, once', async () => {
    await s.touchMru(1);
    await s.touchMru(2);
    await s.touchMru(1);
    expect(await s.getMru()).toEqual([1, 2]);
  });

  it('touchMru keeps the cap', async () => {
    await s.setMru(Array.from({ length: LIMITS.MAX_MRU }, (_, i) => i));
    await s.touchMru(9999);
    const mru = await s.getMru();
    expect(mru).toHaveLength(LIMITS.MAX_MRU);
    expect(mru[0]).toBe(9999);
    expect(mru).not.toContain(LIMITS.MAX_MRU - 1);
  });

  it('concurrent updates are not lost', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.touchMru(i)));
    expect((await s.getMru()).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    await Promise.all([s.removeFromMru(3), s.removeFromMru(4), s.touchMru(100)]);
    const mru = await s.getMru();
    expect(mru[0]).toBe(100);
    expect(mru).not.toContain(3);
    expect(mru).not.toContain(4);
  });

  it('a failed update does not block the next ones', async () => {
    S.get.mockRejectedValueOnce(new Error('gone'));
    await expect(s.touchMru(1)).rejects.toThrow('gone');
    await s.touchMru(2);
    expect(await s.getMru()).toEqual([2]);
  });

  it('removeFromMru', async () => {
    await s.setMru([1, 2, 3]);
    await s.removeFromMru(2);
    expect(await s.getMru()).toEqual([1, 3]);
  });

  it('replaceInMru swaps an id in place and drops an older copy of the new one', async () => {
    await s.setMru([1, 2, 3, 4]);
    await s.replaceInMru(2, 4);
    expect(await s.getMru()).toEqual([1, 4, 3]);
  });

  it('seedMru only fills an empty list, with valid ids', async () => {
    await s.seedMru([5, -1, 6]);
    expect(await s.getMru()).toEqual([5, 6]);
    await s.seedMru([7]);
    expect(await s.getMru()).toEqual([5, 6]);
  });

  it('setMru validates and caps', async () => {
    await s.setMru([1, 'x', 2, ...Array.from({ length: LIMITS.MAX_MRU }, (_, i) => 10 + i)]);
    const v = S._data.get(KEY.MRU);
    expect(v).toHaveLength(LIMITS.MAX_MRU);
    expect(v.slice(0, 2)).toEqual([1, 2]);
  });
});

describe('discarded tabs', () => {
  it('getSlept validates', async () => {
    S._data.set(KEY.SLEPT, [1, 'a', -2, 3]);
    expect(await s.getSlept()).toEqual([1, 3]);
    S._data.set(KEY.SLEPT, {});
    expect(await s.getSlept()).toEqual([]);
  });

  it('markDiscarded adds and removes, and skips no-op writes', async () => {
    await s.markDiscarded(1, true);
    await s.markDiscarded(2, true);
    await s.markDiscarded(1, true);
    expect(await s.getSlept()).toEqual([1, 2]);
    expect(S.set).toHaveBeenCalledTimes(2);
    await s.markDiscarded(1, false);
    await s.markDiscarded(9, false);
    expect(await s.getSlept()).toEqual([2]);
    expect(S.set).toHaveBeenCalledTimes(3);
  });

  it('markDiscarded ignores bad ids and keeps the newest MAX_SLEPT', async () => {
    await s.markDiscarded(-1, true);
    await s.markDiscarded('3', true);
    expect(S.set).not.toHaveBeenCalled();
    S._data.set(KEY.SLEPT, Array.from({ length: LIMITS.MAX_SLEPT }, (_, i) => i));
    await s.markDiscarded(99999, true);
    const v = await s.getSlept();
    expect(v).toHaveLength(LIMITS.MAX_SLEPT);
    expect(v[0]).toBe(1);
    expect(v.at(-1)).toBe(99999);
  });

  it('moveDiscarded follows a replaced tab, only if the old one slept', async () => {
    S._data.set(KEY.SLEPT, [1, 2, 5]);
    await s.moveDiscarded(2, 5);
    expect(await s.getSlept()).toEqual([1, 5]);
    await s.moveDiscarded(7, 8);
    expect(await s.getSlept()).toEqual([1, 5]);
    await s.moveDiscarded(1, -1);
    expect(await s.getSlept()).toEqual([1, 5]);
  });
});

describe('tab meta and the closed-tab log', () => {
  const tab = (p = {}) => ({ id: 1, url: 'https://a.com/x', title: 'A', favIconUrl: 'https://a.com/f.ico', incognito: false, ...p });

  it('rememberTab stores url/title/icon, and skips repeats', async () => {
    await s.rememberTab(tab());
    expect(S._data.get(tabMetaKey(1))).toEqual({ u: 'https://a.com/x', ti: 'A', f: 'https://a.com/f.ico' });
    await s.rememberTab(tab());
    expect(S.set).toHaveBeenCalledTimes(1);
    await s.rememberTab(tab({ title: 'B' }));
    expect(S.set).toHaveBeenCalledTimes(2);
  });

  it('rememberTab cleans what it stores, and skips tabs not worth logging', async () => {
    await s.rememberTab(tab({ title: 'x'.repeat(400), favIconUrl: 'data:image/png;base64,AA' }));
    expect(S._data.get(tabMetaKey(1))).toEqual({ u: 'https://a.com/x', ti: 'x'.repeat(300), f: '' });
    await s.rememberTab(tab({ id: 2, url: '', pendingUrl: 'https://p.com/' }));
    expect(S._data.get(tabMetaKey(2)).u).toBe('https://p.com/');
    for (const bad of [tab({ id: 3, incognito: true }), tab({ id: 4, url: 'chrome://newtab/' }), tab({ id: 5, url: 'javascript:alert(1)' }),
      tab({ id: 6, url: chrome.runtime.getURL('switcher.html') }), tab({ id: -1 }), null]) await s.rememberTab(bad);
    expect([...S._data.keys()].sort()).toEqual([tabMetaKey(1), tabMetaKey(2)]);
  });

  it('rememberTabs writes many at once', async () => {
    await s.rememberTabs([tab(), tab({ id: 2, url: 'https://b.com/' }), tab({ id: 3, incognito: true })]);
    expect(S.set).toHaveBeenCalledTimes(1);
    expect(Object.keys(S.set.mock.calls[0][0])).toEqual([tabMetaKey(1), tabMetaKey(2)]);
    await s.rememberTab(tab()); // already known
    expect(S.set).toHaveBeenCalledTimes(1);
  });

  it('forgetTabMeta removes it, so the next remember writes again', async () => {
    await s.rememberTab(tab());
    await s.forgetTabMeta(1);
    expect(S._data.has(tabMetaKey(1))).toBe(false);
    await s.rememberTab(tab());
    expect(S._data.has(tabMetaKey(1))).toBe(true);
  });

  it('logClosedTab moves the meta into the log, newest first, one entry per page', async () => {
    await s.rememberTabs([tab(), tab({ id: 2, url: 'https://b.com/', title: 'B', favIconUrl: '' }), tab({ id: 3, url: 'https://a.com/x/#frag', title: 'A2' })]);
    await s.logClosedTab(1);
    vi.setSystemTime(NOW + 1000);
    await s.logClosedTab(2);
    vi.setSystemTime(NOW + 2000);
    await s.logClosedTab(3);
    expect(S._data.has(tabMetaKey(1))).toBe(false);
    expect(await s.getClosedLog()).toEqual([
      { url: 'https://a.com/x/#frag', title: 'A2', favIconUrl: 'https://a.com/f.ico', closedAt: NOW + 2000 },
      { url: 'https://b.com/', title: 'B', favIconUrl: '', closedAt: NOW + 1000 },
    ]);
  });

  it('logClosedTab of an unknown tab, or bad meta, logs nothing', async () => {
    await s.logClosedTab(42);
    S._data.set(tabMetaKey(7), { u: 'javascript:x' });
    await s.logClosedTab(7);
    expect(S._data.has(tabMetaKey(7))).toBe(false);
    expect(L._data.has(KEY.CLOSED_LOG)).toBe(false);
  });

  it('logClosedTab fills in a missing title or icon, and caps the log', async () => {
    L._data.set(KEY.CLOSED_LOG, Array.from({ length: LIMITS.MAX_CLOSED_LOG }, (_, i) => ({ url: `https://p${i}.com/`, title: '', favIconUrl: '', closedAt: NOW - i })));
    S._data.set(tabMetaKey(7), { u: 'https://new.com/', ti: 5 });
    await s.logClosedTab(7);
    const log = await s.getClosedLog();
    expect(log).toHaveLength(LIMITS.MAX_CLOSED_LOG);
    expect(log[0]).toEqual({ url: 'https://new.com/', title: '', favIconUrl: '', closedAt: NOW });
    expect(log.at(-1).url).toBe(`https://p${LIMITS.MAX_CLOSED_LOG - 2}.com/`);
  });

  it('logClosedTab gathers closes made together into one write, in closing order', async () => {
    await s.rememberTabs([tab(), tab({ id: 2, url: 'https://b.com/', title: 'B', favIconUrl: '' }), tab({ id: 3, url: 'https://a.com/x#2', title: 'A2' })]);
    L._data.set(KEY.CLOSED_LOG, [{ url: 'https://b.com', title: 'old B', favIconUrl: '', closedAt: NOW - 5000 }]);
    L.set.mockClear();
    S.get.mockClear();
    const ps = [s.logClosedTab(1)];
    vi.setSystemTime(NOW + 10);
    ps.push(s.logClosedTab(2));
    vi.setSystemTime(NOW + 20);
    ps.push(s.logClosedTab(3), s.logClosedTab(42));
    await Promise.all(ps);
    expect(L.set).toHaveBeenCalledTimes(1);
    expect(S.get).toHaveBeenCalledTimes(1);
    expect(await s.getClosedLog()).toEqual([
      { url: 'https://a.com/x#2', title: 'A2', favIconUrl: 'https://a.com/f.ico', closedAt: NOW + 20 },
      { url: 'https://b.com/', title: 'B', favIconUrl: '', closedAt: NOW + 10 },
    ]);
    expect([1, 2, 3].some((id) => S._data.has(tabMetaKey(id)))).toBe(false);
  });

  it('flushClosedTabs writes the waiting closes at once (the worker is being suspended)', async () => {
    await s.rememberTab(tab());
    const logged = s.logClosedTab(1);
    await s.flushClosedTabs();
    expect((await s.getClosedLog()).map((e) => e.url)).toEqual(['https://a.com/x']);
    await logged;
    await s.flushClosedTabs(); // nothing waiting: nothing to do
    expect(L.set).toHaveBeenCalledTimes(1);
  });

  it('getClosedLog drops invalid and week-old entries', async () => {
    const ok = { url: 'https://a.com/', title: 'A', favIconUrl: '', closedAt: NOW - 1000 };
    L._data.set(KEY.CLOSED_LOG, [ok,
      { ...ok, closedAt: NOW - LIMITS.CLOSED_LOG_TTL_MS }, { ...ok, url: 'javascript:1' }, { ...ok, title: 1 }, { ...ok, favIconUrl: null },
      { ...ok, closedAt: 'x' }, { ...ok, url: 'https://a.com/' + 'x'.repeat(LIMITS.MAX_URL_KEY) }, null, 'x']);
    expect(await s.getClosedLog()).toEqual([ok]);
    L._data.set(KEY.CLOSED_LOG, { not: 'a list' });
    expect(await s.getClosedLog()).toEqual([]);
  });

  it('cleanupClosedLog rewrites the log only when something was dropped', async () => {
    const ok = { url: 'https://a.com/', title: 'A', favIconUrl: '', closedAt: NOW - 1000 };
    L._data.set(KEY.CLOSED_LOG, [ok]);
    await s.cleanupClosedLog();
    expect(L.set).not.toHaveBeenCalled();
    L._data.set(KEY.CLOSED_LOG, [ok, { ...ok, closedAt: NOW - 8 * DAY }]);
    await s.cleanupClosedLog();
    expect(L._data.get(KEY.CLOSED_LOG)).toEqual([ok]);
    L._data.delete(KEY.CLOSED_LOG);
    await s.cleanupClosedLog();
    expect(L._data.get(KEY.CLOSED_LOG)).toEqual([]);
  });
});

describe('launch tokens', () => {
  const ctx = { src: 4, win: 2, state: 'maximized', dir: -1, hold: true, mode: 'overlay', via: 'icon' };

  it('createLaunch stores a random token with the context; consumeLaunch returns it once', async () => {
    const token = await s.createLaunch(ctx);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(S._data.get(KEY.LAUNCH)).toEqual({ token, t: NOW, ctx });
    const l = await s.consumeLaunch(token);
    expect(l).toEqual({ srcTab: 4, srcWin: 2, srcState: 'maximized', dir: -1, hold: true, mode: 'overlay', via: 'icon' });
    expect(Object.isFrozen(l)).toBe(true);
    expect(await s.consumeLaunch(token)).toBeNull();
  });

  it('each launch gets a new token, and only the latest is valid', async () => {
    const a = await s.createLaunch(ctx);
    const b = await s.createLaunch(ctx);
    expect(a).not.toBe(b);
    expect(await s.consumeLaunch(a)).toBeNull();
    expect(await s.consumeLaunch(b)).not.toBeNull();
  });

  it('a wrong token does not invalidate the real one', async () => {
    const token = await s.createLaunch(ctx);
    for (const bad of ['nope', '', null, undefined, 5, { token }]) expect(await s.consumeLaunch(bad)).toBeNull();
    expect(await s.consumeLaunch(token)).not.toBeNull();
  });

  it('expires after LAUNCH_TTL_MS (and is used up anyway)', async () => {
    const token = await s.createLaunch(ctx);
    vi.setSystemTime(NOW + LIMITS.LAUNCH_TTL_MS + 1);
    expect(await s.consumeLaunch(token)).toBeNull();
    expect(S._data.has(KEY.LAUNCH)).toBe(false);
  });

  it('is still valid exactly at the TTL', async () => {
    const token = await s.createLaunch(ctx);
    vi.setSystemTime(NOW + LIMITS.LAUNCH_TTL_MS);
    expect(await s.consumeLaunch(token)).not.toBeNull();
  });

  it('defaults bad optional fields', async () => {
    const token = await s.createLaunch({ src: 0, win: 0, state: 'minimized', dir: 7, hold: 'yes', mode: 'popup', via: 'evil' });
    expect(await s.consumeLaunch(token)).toEqual({ srcTab: 0, srcWin: 0, srcState: 'normal', dir: 1, hold: false, mode: 'window', via: 'key' });
    const t2 = await s.createLaunch({ src: 1, win: 1, dir: 0, via: 'startup' });
    expect(await s.consumeLaunch(t2)).toMatchObject({ dir: 0, via: 'startup' });
  });

  it('rejects a context without valid tab and window ids, or a bad stored launch', async () => {
    for (const c of [{ src: -1, win: 1 }, { src: 1, win: 'x' }, {}, null]) {
      const token = await s.createLaunch(c);
      expect(await s.consumeLaunch(token)).toBeNull();
    }
    S._data.set(KEY.LAUNCH, { token: 'tok', t: 'when', ctx });
    expect(await s.consumeLaunch('tok')).toBeNull();
    S._data.set(KEY.LAUNCH, { token: 5, t: NOW, ctx });
    expect(await s.consumeLaunch(5)).toBeNull();
  });
});

describe('overlay tab', () => {
  it('is remembered for 10 minutes', async () => {
    await s.setOverlayTab(3);
    expect(await s.isOverlayTab(3)).toBe(true);
    expect(await s.isOverlayTab(4)).toBe(false);
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    expect(await s.isOverlayTab(3)).toBe(false);
  });

  it('clearOverlayTab forgets it', async () => {
    await s.setOverlayTab(3);
    await s.clearOverlayTab();
    expect(await s.isOverlayTab(3)).toBe(false);
  });

  it('ignores a bad stored value', async () => {
    S._data.set(KEY.OVERLAY, { tabId: 3, t: 'x' });
    expect(await s.isOverlayTab(3)).toBe(false);
  });
});

describe('resume note', () => {
  it('is taken once, with its time', async () => {
    await s.setResume({ query: 'abc', scope: 'all' });
    expect(await s.takeResume()).toEqual({ query: 'abc', scope: 'all', t: NOW });
    expect(await s.takeResume()).toBeNull();
  });

  it('expires after RESUME_TTL_MS, and is removed anyway', async () => {
    await s.setResume({ query: 'abc' });
    vi.setSystemTime(NOW + LIMITS.RESUME_TTL_MS);
    expect(await s.takeResume()).toBeNull();
    expect(S._data.has(KEY.RESUME)).toBe(false);
  });

  it('ignores a bad stored value', async () => {
    S._data.set(KEY.RESUME, { query: 'x', t: -5 });
    expect(await s.takeResume()).toBeNull();
  });
});

describe('capture notes', () => {
  it('noteCapture stores the stage, message and host only', async () => {
    await s.noteCapture('error', new Error('Failed'), 'https://a.com/secret?q=1');
    expect(await s.getCaptureNote()).toEqual({ t: NOW, stage: 'error', msg: 'Error: Failed', host: 'a.com' });
    await s.noteCapture('skip');
    expect(await s.getCaptureNote()).toEqual({ t: NOW, stage: 'skip', msg: '', host: '' });
  });

  it('getCaptureNote validates', async () => {
    expect(await s.getCaptureNote()).toBeNull();
    S._data.set(KEY.CAPDIAG, { t: 0, stage: 'ok' });
    expect(await s.getCaptureNote()).toBeNull();
    S._data.set(KEY.CAPDIAG, { t: 5, stage: 3, msg: null });
    expect(await s.getCaptureNote()).toEqual({ t: 5, stage: '3', msg: '', host: '' });
  });

  it('pages Chrome blocks are remembered; a later success forgets them', async () => {
    await s.noteCapture('error', 'The extensions gallery cannot be scripted.', 'https://chromewebstore.google.com/x#y');
    await s.noteCapture('error', 'Cannot access contents of url', 'https://b.com/');
    await s.noteCapture('error', 'some other failure', 'https://c.com/');
    expect(await s.getNoCapture()).toEqual(new Set(['https://b.com/', 'https://chromewebstore.google.com/x']));
    await s.noteCapture('ok', '', 'https://b.com');
    expect(await s.getNoCapture()).toEqual(new Set(['https://chromewebstore.google.com/x']));
  });

  it('a success on a page that is not listed writes nothing', async () => {
    await s.noteCapture('ok', '', 'https://a.com/');
    expect(S._data.has(KEY.NOCAP)).toBe(false);
    S._data.set(KEY.NOCAP, ['https://b.com/']);
    S.set.mockClear();
    await s.noteCapture('ok', '', 'https://a.com/');
    expect(S.set.mock.calls.filter(([o]) => KEY.NOCAP in o)).toHaveLength(0);
    expect(S._data.get(KEY.NOCAP)).toEqual(['https://b.com/']);
  });

  it('the blocked list holds each page once, newest first, at most 300', async () => {
    S._data.set(KEY.NOCAP, Array.from({ length: 300 }, (_, i) => `https://p${i}/`));
    await s.noteCapture('error', 'cannot access', 'https://p5/');
    await s.noteCapture('error', 'cannot access', 'https://new/');
    const v = S._data.get(KEY.NOCAP);
    expect(v).toHaveLength(300);
    expect(v.slice(0, 2)).toEqual(['https://new/', 'https://p5/']);
    expect(v.filter((x) => x === 'https://p5/')).toHaveLength(1);
  });

  it('getNoCapture validates', async () => {
    expect(await s.getNoCapture()).toEqual(new Set());
    S._data.set(KEY.NOCAP, ['https://a/', 3, null]);
    expect(await s.getNoCapture()).toEqual(new Set(['https://a/']));
  });

  it('never throws, even when storage fails', async () => {
    S.set.mockRejectedValue(new Error('gone'));
    await expect(s.noteCapture('error', 'cannot access', 'https://a.com/')).resolves.toBeUndefined();
  });

  // BUG: lib/store.js:559 only guards with `|| []`, so a stored non-array NOCAP (e.g. {}) makes `.filter`
  // throw; the error is swallowed and the blocked page is never recorded, for the rest of the session.
  // Every other reader in store.js treats bad stored data as empty.
  it('a bad stored blocked list is treated as empty', async () => {
    S._data.set(KEY.NOCAP, { bad: true });
    await s.noteCapture('error', 'cannot access', 'https://a.com/');
    expect(await s.getNoCapture()).toEqual(new Set(['https://a.com/']));
  });
});
