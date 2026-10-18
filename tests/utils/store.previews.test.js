// Previews: thumbnails + sharp copies, the index, caps, eviction order, 7-day cleanup.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KEY, LIMITS, PREVIEW_PREFIX, previewKey, sharpKey } from '../../utils/constants.js';

const L = chrome.storage.local;
const S = chrome.storage.session;
const MB = 1024 * 1024;
const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;
const img = (n = 8, ch = 'A') => PREVIEW_PREFIX + ch.repeat(n);
const flush = () => new Promise((r) => setTimeout(r, 0));
const index = () => L._data.get(KEY.PREVIEW_INDEX) || {};
const sharpIndex = () => L._data.get(KEY.SHARP_INDEX) || {};

// Put a preview (and its index entry) straight into storage. `k` is an already normalized URL.
function seed(k, { t = NOW, n = 10, s } = {}, idxKey = KEY.PREVIEW_INDEX, keyFn = previewKey) {
  const idx = L._data.get(idxKey) || {};
  idx[k] = s === undefined ? { t, n } : { t, n, s };
  L._data.set(idxKey, idx);
  L._data.set(keyFn(k), { img: img(), t });
}

let s;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  s = await import('../../utils/store.js');
  L._data.set(KEY.PREVIEW_CLEAN, NOW); // keep the automatic cleanup out of the way unless a test wants it
});
afterEach(() => vi.useRealTimers());

describe('getPreview / getPreviews / getSharpPreview', () => {
  it('reads by normalized URL and ignores the fragment and trailing slash', async () => {
    L._data.set(previewKey('https://a.com/x'), { img: img(), t: 5 });
    expect(await s.getPreview('https://a.com/x/#top')).toEqual({ img: img(), t: 5 });
    expect(await s.getPreview('https://a.com/y')).toBeNull();
  });

  it('rejects bad stored values and unusable URLs', async () => {
    L._data.set(previewKey('https://a.com/'), { img: 'data:image/png;base64,AA', t: 5 });
    L._data.set(previewKey('https://b.com/'), { img: img(), t: 0 });
    L._data.set(previewKey('https://c.com/'), 'nope');
    for (const u of ['https://a.com', 'https://b.com', 'https://c.com', '', 'not a url', 'https://d.com/' + 'x'.repeat(LIMITS.MAX_URL_KEY)]) {
      expect(await s.getPreview(u)).toBeNull();
    }
    expect(L.get).toHaveBeenCalledTimes(3); // the unusable URLs never reach storage
  });

  it('getPreviews returns only valid ones, keyed by normalized URL, deduplicated', async () => {
    L._data.set(previewKey('https://a.com/'), { img: img(), t: 1 });
    L._data.set(previewKey('https://b.com/'), { img: 'bad', t: 1 });
    expect(await s.getPreviews(['https://a.com', 'https://a.com/#x', 'https://b.com', 'https://c.com', ''])).toEqual({ 'https://a.com/': { img: img(), t: 1 } });
    expect(L.get).toHaveBeenCalledWith(['pv:https://a.com/', 'pv:https://b.com/', 'pv:https://c.com/']);
  });

  it('getPreviews of nothing usable does not touch storage', async () => {
    expect(await s.getPreviews(['', 'garbage'])).toEqual({});
    expect(L.get).not.toHaveBeenCalled();
  });

  it('getSharpPreview reads the sharp copy', async () => {
    L._data.set(sharpKey('https://a.com/'), { img: img(), t: 3 });
    expect(await s.getSharpPreview('https://a.com')).toEqual({ img: img(), t: 3 });
    expect(await s.getSharpPreview('https://b.com')).toBeNull();
    expect(await s.getSharpPreview('')).toBeNull();
  });
});

describe('previewTimes / previewFresh', () => {
  it('previewTimes reads capture times from the index alone', async () => {
    seed('https://a.com/x', { t: 42 });
    const at = await s.previewTimes();
    expect(at('https://a.com/x/#top')).toBe(42);
    expect(at('https://b.com/')).toBe(0);
    expect(at('')).toBe(0);
    expect(L.get).toHaveBeenCalledTimes(1);
    expect(L.get).toHaveBeenCalledWith(KEY.PREVIEW_INDEX);
  });

  it('previewFresh answers from the saves this context made, without reading the image', async () => {
    vi.setSystemTime(NOW + 5000); // the context is older than the window asked about
    await s.savePreview('https://a.com/x', { img: img(), t: NOW + 4000 });
    L.get.mockClear();
    expect(await s.previewFresh('https://a.com/x#y', 1500)).toBe(true);
    vi.setSystemTime(NOW + 5501);
    expect(await s.previewFresh('https://a.com/x', 1500)).toBe(false);
    L._data.set(previewKey('https://b.com/'), { img: img(), t: NOW + 5500 }); // saved by no one in this context
    expect(await s.previewFresh('https://b.com/', 1500)).toBe(false);
    expect(await s.previewFresh('', 1500)).toBe(false);
    expect(L.get).not.toHaveBeenCalled();
  });

  it('previewFresh reads storage while the context is younger than the window (a restarted worker)', async () => {
    L._data.set(previewKey('https://b.com/'), { img: img(), t: NOW - 1000 });
    expect(await s.previewFresh('https://b.com/', 1500)).toBe(true);
    expect(await s.previewFresh('https://c.com/', 1500)).toBe(false);
    vi.setSystemTime(NOW + 600);
    expect(await s.previewFresh('https://b.com/', 1500)).toBe(false);
  });
});

describe('savePreview', () => {
  it('stores the image and an index entry', async () => {
    await s.savePreview('https://a.com/#x', { img: img(20), t: 100, junk: 1 });
    expect(L._data.get(previewKey('https://a.com/'))).toEqual({ img: img(20), t: 100 });
    expect(index()).toEqual({ 'https://a.com/': { t: 100, n: img(20).length, s: NOW } });
  });

  it('ignores invalid data and unusable URLs', async () => {
    await s.savePreview('https://a.com', { img: 'nope', t: 1 });
    await s.savePreview('https://a.com', { img: img(), t: -1 });
    await s.savePreview('', { img: img(), t: 1 });
    await s.savePreview('https://a.com', null);
    expect(L.set).not.toHaveBeenCalled();
  });

  it('drops index entries that are malformed', async () => {
    L._data.set(KEY.PREVIEW_INDEX, { 'https://bad/': { t: 'x', n: 1 }, 'https://neg/': { t: 1, n: -1 }, 'https://old/': { t: 7, n: 3 }, ['https://' + 'l'.repeat(LIMITS.MAX_URL_KEY)]: { t: 1, n: 1 } });
    await s.savePreview('https://a.com', { img: img(), t: 9 });
    expect(Object.keys(index()).sort()).toEqual(['https://a.com/', 'https://old/']);
    expect(index()['https://old/']).toEqual({ t: 7, n: 3, s: 7 }); // `s` defaults to `t`
  });

  it('a non-object index is treated as empty', async () => {
    L._data.set(KEY.PREVIEW_INDEX, ['x']);
    await s.savePreview('https://a.com', { img: img(), t: 9 });
    expect(Object.keys(index())).toEqual(['https://a.com/']);
  });

  it('over the size cap, evicts previews no open tab uses first, oldest seen first', async () => {
    chrome._addTab({ url: 'https://open.com/' });
    seed('https://u1/', { t: NOW - 3000, n: 2 * MB });
    seed('https://u2/', { t: NOW - 5000, n: 2 * MB, s: NOW - 1000 }); // captured earlier but seen later than u1
    seed('https://open.com/', { t: NOW - 9000, n: 2 * MB });
    await s.savePreview('https://new.com', { img: img(), t: NOW });
    expect(Object.keys(index()).sort()).toEqual(['https://new.com/', 'https://open.com/', 'https://u2/']);
    expect(L._data.has(previewKey('https://u1/'))).toBe(false);
  });

  it('then evicts previews of open tabs, oldest capture first, never the one being saved', async () => {
    chrome._addTab({ url: 'https://o1/' });
    chrome._addTab({ url: 'https://o2/' });
    seed('https://o1/', { t: NOW - 1000, n: 3 * MB, s: NOW });
    seed('https://o2/', { t: NOW - 2000, n: 3 * MB, s: NOW });
    await s.savePreview('https://new.com', { img: img(), t: NOW });
    expect(Object.keys(index()).sort()).toEqual(['https://new.com/', 'https://o1/']);
  });

  it('respects the count cap', async () => {
    for (let i = 0; i < LIMITS.MAX_PREVIEWS; i++) seed(`https://p${i}/`, { t: NOW - 10000 + i });
    await s.savePreview('https://new.com', { img: img(), t: NOW });
    const keys = Object.keys(index());
    expect(keys).toHaveLength(LIMITS.MAX_PREVIEWS);
    expect(keys).toContain('https://new.com/');
    expect(keys).not.toContain('https://p0/'); // the oldest went
  });

  it('when the tabs cannot be listed while over a cap, evicts as if only this page were open', async () => {
    chrome._addTab({ url: 'https://o1/' });
    chrome.tabs.query.mockRejectedValue(new Error('no'));
    seed('https://o1/', { t: NOW - 1000, n: 4 * MB });
    seed('https://u1/', { t: NOW - 500, n: 2.5 * MB });
    await s.savePreview('https://new.com', { img: img(), t: NOW });
    expect(Object.keys(index()).sort()).toEqual(['https://new.com/', 'https://u1/']);
  });

  it('on a quota error, drops the first half of the eviction order and retries once', async () => {
    seed('https://u1/', { t: NOW - 4000 });
    seed('https://u2/', { t: NOW - 3000 });
    seed('https://u3/', { t: NOW - 2000 });
    seed('https://u4/', { t: NOW - 1000 });
    L.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await s.savePreview('https://new.com', { img: img(), t: NOW });
    expect(Object.keys(index()).sort()).toEqual(['https://new.com/', 'https://u3/', 'https://u4/']);
    expect(L._data.has(previewKey('https://u1/'))).toBe(false);
    expect(L._data.has(previewKey('https://new.com/'))).toBe(true);
  });

  it('rejects when the retry fails too, and the queue keeps working', async () => {
    L.set.mockRejectedValueOnce(new Error('quota')).mockRejectedValueOnce(new Error('quota'));
    await expect(s.savePreview('https://a.com', { img: img(), t: NOW })).rejects.toThrow('quota');
    await s.savePreview('https://b.com', { img: img(), t: NOW });
    expect(Object.keys(index())).toEqual(['https://b.com/']);
  });

  it('concurrent saves all land in the index', async () => {
    await Promise.all(Array.from({ length: 15 }, (_, i) => s.savePreview(`https://p${i}.com`, { img: img(), t: NOW })));
    expect(Object.keys(index())).toHaveLength(15);
  });
});

describe('sharp copies', () => {
  it('are saved alongside the small one and indexed', async () => {
    await s.savePreview('https://a.com', { img: img(), t: 50, sharp: img(40, 'B') });
    expect(L._data.get(sharpKey('https://a.com/'))).toEqual({ img: img(40, 'B'), t: 50 });
    expect(sharpIndex()).toEqual({ 'https://a.com/': { t: 50, n: img(40, 'B').length, s: NOW } });
    expect(await s.getSharpPreview('https://a.com')).toEqual({ img: img(40, 'B'), t: 50 });
  });

  it('a capture without a sharp copy drops the older sharp one', async () => {
    await s.savePreview('https://a.com', { img: img(), t: 50, sharp: img(40, 'B') });
    await s.savePreview('https://a.com', { img: img(), t: 60 });
    expect(L._data.has(sharpKey('https://a.com/'))).toBe(false);
    expect(sharpIndex()).toEqual({});
  });

  it('an invalid sharp image is ignored, the small one is still saved', async () => {
    await s.savePreview('https://a.com', { img: img(), t: 50, sharp: 'data:image/png;base64,AA' });
    expect(L._data.has(previewKey('https://a.com/'))).toBe(true);
    expect(L._data.has(sharpKey('https://a.com/'))).toBe(false);
  });

  it('follow the small copy when it is evicted', async () => {
    seed('https://u1/', { t: NOW - 1000, n: 6 * MB });
    seed('https://u1/', { t: NOW - 1000, n: 10 }, KEY.SHARP_INDEX, sharpKey);
    await s.savePreview('https://new.com', { img: img(), t: NOW });
    expect(L._data.has(sharpKey('https://u1/'))).toBe(false);
    expect(sharpIndex()).toEqual({});
  });

  it('have their own count cap', async () => {
    for (let i = 0; i < LIMITS.MAX_SHARP; i++) {
      seed(`https://p${i}/`, { t: NOW - 10000 + i });
      seed(`https://p${i}/`, { t: NOW - 10000 + i }, KEY.SHARP_INDEX, sharpKey);
    }
    await s.savePreview('https://new.com', { img: img(), t: NOW, sharp: img() });
    const keys = Object.keys(sharpIndex());
    expect(keys).toHaveLength(LIMITS.MAX_SHARP);
    expect(keys).toContain('https://new.com/');
    expect(keys).not.toContain('https://p0/');
    expect(L._data.has(sharpKey('https://p0/'))).toBe(false);
    expect(L._data.has(previewKey('https://p0/'))).toBe(true); // the small copy stays
  });

  it('a save over both caps asks Chrome for the open tabs and the archive once', async () => {
    for (let i = 0; i < LIMITS.MAX_PREVIEWS; i++) seed(`https://p${i}/`, { t: NOW - 10000 + i });
    for (let i = 0; i < LIMITS.MAX_SHARP; i++) seed(`https://p${i}/`, { t: NOW - 10000 + i }, KEY.SHARP_INDEX, sharpKey);
    await s.savePreview('https://new.com', { img: img(), t: NOW, sharp: img() });
    expect(Object.keys(index())).toHaveLength(LIMITS.MAX_PREVIEWS);
    expect(Object.keys(sharpIndex())).toHaveLength(LIMITS.MAX_SHARP);
    expect(chrome.tabs.query).toHaveBeenCalledTimes(1);
    expect(chrome.bookmarks.getChildren.mock.calls.filter(([id]) => id === '0')).toHaveLength(1);
    expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
  });

  it('a save under the caps does not ask for the open tabs at all', async () => {
    await s.savePreview('https://a.com', { img: img(), t: 50, sharp: img() });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it('are given up when there is no room, the small copy is kept', async () => {
    L.set.mockImplementation(async (items) => {
      if (sharpKey('https://a.com/') in items) throw new Error('quota');
      for (const [k, v] of Object.entries(items)) L._data.set(k, structuredClone(v));
    });
    await s.savePreview('https://a.com', { img: img(), t: 50, sharp: img() });
    expect(L._data.has(previewKey('https://a.com/'))).toBe(true);
    expect(L._data.has(sharpKey('https://a.com/'))).toBe(false);
    expect(sharpIndex()).toEqual({});
  });
});

describe('cleanupPreviews', () => {
  it('deletes previews no open tab uses after 7 days, keeps open, starred and archived ones', async () => {
    const old = NOW - LIMITS.PREVIEW_TTL_MS - 1;
    chrome._addTab({ url: 'https://open.com/#a' });
    await s.toggleStar('https://star.com/', 'Star');
    const folder = chrome._addBookmark({ title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: folder.id, url: 'https://arch.com/', title: 'Arch' });
    for (const k of ['https://open.com/', 'https://star.com/', 'https://arch.com/', 'https://gone.com/']) seed(k, { t: old });
    seed('https://recent.com/', { t: old, s: NOW - DAY }); // seen by an open tab yesterday
    seed('https://gone.com/', { t: old }, KEY.SHARP_INDEX, sharpKey);
    await s.cleanupPreviews();
    expect(Object.keys(index()).sort()).toEqual(['https://arch.com/', 'https://open.com/', 'https://recent.com/', 'https://star.com/']);
    expect(L._data.has(previewKey('https://gone.com/'))).toBe(false);
    expect(L._data.has(sharpKey('https://gone.com/'))).toBe(false);
    expect(index()['https://open.com/'].s).toBe(NOW); // open ones are marked as seen now
    expect(L._data.get(KEY.PREVIEW_CLEAN)).toBe(NOW);
  });

  it('the 7-day cutoff is inclusive', async () => {
    seed('https://edge/', { t: NOW - LIMITS.PREVIEW_TTL_MS });
    seed('https://inside/', { t: NOW - LIMITS.PREVIEW_TTL_MS + 1 });
    await s.cleanupPreviews();
    expect(Object.keys(index())).toEqual(['https://inside/']);
  });

  it('deletes nothing when Chrome cannot list the tabs', async () => {
    chrome.tabs.query.mockRejectedValueOnce(new Error('no'));
    seed('https://gone.com/', { t: 1 });
    await s.cleanupPreviews();
    expect(index()).toHaveProperty(['https://gone.com/']);
    expect(L.remove).not.toHaveBeenCalled();
  });

  it('trims to the caps, unused first', async () => {
    chrome._addTab({ url: 'https://o1/' });
    seed('https://o1/', { t: NOW - 5000, n: 4 * MB });
    seed('https://u1/', { t: NOW - 1000, n: 3 * MB });
    await s.cleanupPreviews();
    expect(Object.keys(index())).toEqual(['https://o1/']);
  });
});

describe('automatic cleanup after a save (maybeCleanup) and boot markers', () => {
  const stale = () => seed('https://stale/', { t: NOW - LIMITS.PREVIEW_TTL_MS - 1 });

  it('runs when it never ran and the browser started over a minute ago', async () => {
    L._data.delete(KEY.PREVIEW_CLEAN);
    S._data.set(KEY.BOOT_AT, NOW - LIMITS.CLEANUP_BOOT_DELAY_MS - 1);
    stale();
    await s.savePreview('https://a.com', { img: img(), t: NOW });
    await flush();
    expect(index()).not.toHaveProperty(['https://stale/']);
    expect(L._data.get(KEY.PREVIEW_CLEAN)).toBe(NOW);
  });

  it('waits a minute after the browser starts', async () => {
    L._data.delete(KEY.PREVIEW_CLEAN);
    await s.markBoot();
    expect(S._data.get(KEY.BOOT_AT)).toBe(NOW);
    stale();
    await s.savePreview('https://a.com', { img: img(), t: NOW });
    await flush();
    expect(index()).toHaveProperty(['https://stale/']);
  });

  it('runs at most every 6 hours', async () => {
    L._data.set(KEY.PREVIEW_CLEAN, NOW - LIMITS.CLEANUP_EVERY_MS + 1000);
    stale();
    await s.savePreview('https://a.com', { img: img(), t: NOW });
    await flush();
    expect(index()).toHaveProperty(['https://stale/']);
    vi.setSystemTime(NOW + 1000);
    await s.savePreview('https://a.com', { img: img(), t: NOW });
    await flush();
    expect(index()).not.toHaveProperty(['https://stale/']);
  });

  it('ensureBoot marks the session start only once', async () => {
    await s.ensureBoot();
    expect(S._data.get(KEY.BOOT_AT)).toBe(NOW);
    vi.setSystemTime(NOW + 5000);
    await s.ensureBoot();
    expect(S._data.get(KEY.BOOT_AT)).toBe(NOW);
  });
});
