// Previews: thumbnails + sharp copies, the index, caps, eviction order, 7-day cleanup.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KEY, LIMITS, PREVIEW_PREFIX, previewKey, sharpKey } from '../../utils/constants.js';

const localArea = chrome.storage.local;
const sessionArea = chrome.storage.session;
const MB = 1024 * 1024;
const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;
const image = (count = 8, character = 'A') => PREVIEW_PREFIX + character.repeat(count);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const index = () => localArea._data.get(KEY.PREVIEW_INDEX) || {};
const sharpIndex = () => localArea._data.get(KEY.SHARP_INDEX) || {};

// Put a preview (and its index entry) straight into storage. `k` is an already normalized URL.
function seed(url, { t: time = NOW, n: size = 10, s: seen } = {}, indexKey = KEY.PREVIEW_INDEX, keyFunction = previewKey) {
  const indexData = localArea._data.get(indexKey) || {};
  indexData[url] = seen === undefined ? { t: time, n: size } : { t: time, n: size, s: seen };
  localArea._data.set(indexKey, indexData);
  localArea._data.set(keyFunction(url), { img: image(), t: time });
}

let store;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.resetModules();
  store = await import('../../utils/store.js');
  localArea._data.set(KEY.PREVIEW_CLEANUP, NOW); // keep the automatic cleanup out of the way unless a test wants it
});
afterEach(() => vi.useRealTimers());

describe('getPreview / getPreviews / getSharpPreview', () => {
  it('reads by normalized URL and ignores the fragment and trailing slash', async () => {
    localArea._data.set(previewKey('https://a.com/x'), { img: image(), t: 5 });
    expect(await store.getPreview('https://a.com/x/#top')).toEqual({ img: image(), t: 5 });
    expect(await store.getPreview('https://a.com/y')).toBeNull();
  });

  it('rejects bad stored values and unusable URLs', async () => {
    localArea._data.set(previewKey('https://a.com/'), { img: 'data:image/png;base64,AA', t: 5 });
    localArea._data.set(previewKey('https://b.com/'), { img: image(), t: 0 });
    localArea._data.set(previewKey('https://c.com/'), 'nope');
    for (const url of ['https://a.com', 'https://b.com', 'https://c.com', '', 'not a url', 'https://d.com/' + 'x'.repeat(LIMITS.MAX_URL_KEY)]) {
      expect(await store.getPreview(url)).toBeNull();
    }
    expect(localArea.get).toHaveBeenCalledTimes(3); // the unusable URLs never reach storage
  });

  it('getPreviews returns only valid ones, keyed by normalized URL, deduplicated', async () => {
    localArea._data.set(previewKey('https://a.com/'), { img: image(), t: 1 });
    localArea._data.set(previewKey('https://b.com/'), { img: 'bad', t: 1 });
    expect(await store.getPreviews(['https://a.com', 'https://a.com/#x', 'https://b.com', 'https://c.com', ''])).toEqual({ 'https://a.com/': { img: image(), t: 1 } });
    expect(localArea.get).toHaveBeenCalledWith(['pv:https://a.com/', 'pv:https://b.com/', 'pv:https://c.com/']);
  });

  it('a JPEG preview stored before (previews are WebP now) is still read; other image types are not', async () => {
    localArea._data.set(previewKey('https://old.com/'), { img: 'data:image/jpeg;base64,OLD', t: 1 });
    localArea._data.set(previewKey('https://png.com/'), { img: 'data:image/png;base64,PNG', t: 1 });
    expect(await store.getPreviews(['https://old.com', 'https://png.com'])).toEqual({ 'https://old.com/': { img: 'data:image/jpeg;base64,OLD', t: 1 } });
  });

  it('getPreviews of nothing usable does not touch storage', async () => {
    expect(await store.getPreviews(['', 'garbage'])).toEqual({});
    expect(localArea.get).not.toHaveBeenCalled();
  });

  it('getSharpPreview reads the sharp copy', async () => {
    localArea._data.set(sharpKey('https://a.com/'), { img: image(), t: 3 });
    expect(await store.getSharpPreview('https://a.com')).toEqual({ img: image(), t: 3 });
    expect(await store.getSharpPreview('https://b.com')).toBeNull();
    expect(await store.getSharpPreview('')).toBeNull();
  });
});

describe('previewTimes / previewFresh', () => {
  it('previewTimes reads capture times from the index alone', async () => {
    seed('https://a.com/x', { t: 42 });
    const at = await store.previewTimes();
    expect(at('https://a.com/x/#top')).toBe(42);
    expect(at('https://b.com/')).toBe(0);
    expect(at('')).toBe(0);
    expect(localArea.get).toHaveBeenCalledTimes(1);
    expect(localArea.get).toHaveBeenCalledWith(KEY.PREVIEW_INDEX);
  });

  it('previewFresh answers from the saves this context made, without reading the image', async () => {
    vi.setSystemTime(NOW + 5000); // the context is older than the window asked about
    await store.savePreview('https://a.com/x', { img: image(), t: NOW + 4000 });
    localArea.get.mockClear();
    expect(await store.previewFresh('https://a.com/x#y', 1500)).toBe(true);
    vi.setSystemTime(NOW + 5501);
    expect(await store.previewFresh('https://a.com/x', 1500)).toBe(false);
    localArea._data.set(previewKey('https://b.com/'), { img: image(), t: NOW + 5500 }); // saved by no one in this context
    expect(await store.previewFresh('https://b.com/', 1500)).toBe(false);
    expect(await store.previewFresh('', 1500)).toBe(false);
    expect(localArea.get).not.toHaveBeenCalled();
  });

  it('previewFresh reads storage while the context is younger than the window (a restarted worker)', async () => {
    localArea._data.set(previewKey('https://b.com/'), { img: image(), t: NOW - 1000 });
    expect(await store.previewFresh('https://b.com/', 1500)).toBe(true);
    expect(await store.previewFresh('https://c.com/', 1500)).toBe(false);
    vi.setSystemTime(NOW + 600);
    expect(await store.previewFresh('https://b.com/', 1500)).toBe(false);
  });

  it('previewFresh: a preview "from the future" (the clock was set back) is not fresh', async () => {
    vi.setSystemTime(NOW + 5000);
    await store.savePreview('https://a.com/x', { img: image(), t: NOW + 4000 });
    vi.setSystemTime(NOW + 1000); // the clock goes back 4 s
    expect(await store.previewFresh('https://a.com/x', 1500)).toBe(false);
    localArea._data.set(previewKey('https://b.com/'), { img: image(), t: NOW + 3000 });
    expect(await store.previewFresh('https://b.com/', 1500)).toBe(false); // read from storage: the same
    vi.setSystemTime(NOW - 1000); // back past the moment this context started
    expect(await store.previewFresh('https://b.com/', 1500)).toBe(false);
  });
});

describe('savePreview', () => {
  it('stores the image and an index entry', async () => {
    await store.savePreview('https://a.com/#x', { img: image(20), t: 100, junk: 1 });
    expect(localArea._data.get(previewKey('https://a.com/'))).toEqual({ img: image(20), t: 100 });
    expect(index()).toEqual({ 'https://a.com/': { t: 100, n: image(20).length, s: NOW } });
  });

  it('ignores invalid data and unusable URLs', async () => {
    await store.savePreview('https://a.com', { img: 'nope', t: 1 });
    await store.savePreview('https://a.com', { img: image(), t: -1 });
    await store.savePreview('', { img: image(), t: 1 });
    await store.savePreview('https://a.com', null);
    expect(localArea.set).not.toHaveBeenCalled();
  });

  it('drops index entries that are malformed', async () => {
    localArea._data.set(KEY.PREVIEW_INDEX, { 'https://bad/': { t: 'x', n: 1 }, 'https://neg/': { t: 1, n: -1 }, 'https://old/': { t: 7, n: 3 }, ['https://' + 'l'.repeat(LIMITS.MAX_URL_KEY)]: { t: 1, n: 1 } });
    await store.savePreview('https://a.com', { img: image(), t: 9 });
    expect(Object.keys(index()).sort()).toEqual(['https://a.com/', 'https://old/']);
    expect(index()['https://old/']).toEqual({ t: 7, n: 3, s: 7 }); // `s` defaults to `t`
  });

  it('a non-object index is treated as empty', async () => {
    localArea._data.set(KEY.PREVIEW_INDEX, ['x']);
    await store.savePreview('https://a.com', { img: image(), t: 9 });
    expect(Object.keys(index())).toEqual(['https://a.com/']);
  });

  it('over the size cap, evicts previews no open tab uses first, oldest seen first', async () => {
    chrome._addTab({ url: 'https://open.com/' });
    seed('https://u1/', { t: NOW - 3000, n: 2 * MB });
    seed('https://u2/', { t: NOW - 5000, n: 2 * MB, s: NOW - 1000 }); // captured earlier but seen later than u1
    seed('https://open.com/', { t: NOW - 9000, n: 2 * MB });
    await store.savePreview('https://new.com', { img: image(), t: NOW });
    expect(Object.keys(index()).sort()).toEqual(['https://new.com/', 'https://open.com/', 'https://u2/']);
    expect(localArea._data.has(previewKey('https://u1/'))).toBe(false);
  });

  it('then evicts previews of open tabs, oldest capture first, never the one being saved', async () => {
    chrome._addTab({ url: 'https://o1/' });
    chrome._addTab({ url: 'https://o2/' });
    seed('https://o1/', { t: NOW - 1000, n: 3 * MB, s: NOW });
    seed('https://o2/', { t: NOW - 2000, n: 3 * MB, s: NOW });
    await store.savePreview('https://new.com', { img: image(), t: NOW });
    expect(Object.keys(index()).sort()).toEqual(['https://new.com/', 'https://o1/']);
  });

  it('respects the count cap', async () => {
    for (let i = 0; i < LIMITS.MAX_PREVIEWS; i++) seed(`https://p${i}/`, { t: NOW - 10000 + i });
    await store.savePreview('https://new.com', { img: image(), t: NOW });
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
    await store.savePreview('https://new.com', { img: image(), t: NOW });
    expect(Object.keys(index()).sort()).toEqual(['https://new.com/', 'https://u1/']);
  });

  it('on a quota error, drops the first half of the eviction order and retries once', async () => {
    seed('https://u1/', { t: NOW - 4000 });
    seed('https://u2/', { t: NOW - 3000 });
    seed('https://u3/', { t: NOW - 2000 });
    seed('https://u4/', { t: NOW - 1000 });
    localArea.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await store.savePreview('https://new.com', { img: image(), t: NOW });
    expect(Object.keys(index()).sort()).toEqual(['https://new.com/', 'https://u3/', 'https://u4/']);
    expect(localArea._data.has(previewKey('https://u1/'))).toBe(false);
    expect(localArea._data.has(previewKey('https://new.com/'))).toBe(true);
  });

  it('rejects when the retry fails too, and the queue keeps working', async () => {
    localArea.set.mockRejectedValueOnce(new Error('quota')).mockRejectedValueOnce(new Error('quota'));
    await expect(store.savePreview('https://a.com', { img: image(), t: NOW })).rejects.toThrow('quota');
    await store.savePreview('https://b.com', { img: image(), t: NOW });
    expect(Object.keys(index())).toEqual(['https://b.com/']);
  });

  it('concurrent saves all land in the index', async () => {
    await Promise.all(Array.from({ length: 15 }, (unused, i) => store.savePreview(`https://p${i}.com`, { img: image(), t: NOW })));
    expect(Object.keys(index())).toHaveLength(15);
  });
});

describe('sharp copies', () => {
  it('are saved alongside the small one and indexed', async () => {
    await store.savePreview('https://a.com', { img: image(), t: 50, sharp: image(40, 'B') });
    expect(localArea._data.get(sharpKey('https://a.com/'))).toEqual({ img: image(40, 'B'), t: 50 });
    expect(sharpIndex()).toEqual({ 'https://a.com/': { t: 50, n: image(40, 'B').length, s: NOW } });
    expect(await store.getSharpPreview('https://a.com')).toEqual({ img: image(40, 'B'), t: 50 });
  });

  it('a capture without a sharp copy drops the older sharp one', async () => {
    await store.savePreview('https://a.com', { img: image(), t: 50, sharp: image(40, 'B') });
    await store.savePreview('https://a.com', { img: image(), t: 60 });
    expect(localArea._data.has(sharpKey('https://a.com/'))).toBe(false);
    expect(sharpIndex()).toEqual({});
  });

  it('an invalid sharp image is ignored, the small one is still saved', async () => {
    await store.savePreview('https://a.com', { img: image(), t: 50, sharp: 'data:image/png;base64,AA' });
    expect(localArea._data.has(previewKey('https://a.com/'))).toBe(true);
    expect(localArea._data.has(sharpKey('https://a.com/'))).toBe(false);
  });

  it('follow the small copy when it is evicted', async () => {
    seed('https://u1/', { t: NOW - 1000, n: 6 * MB });
    seed('https://u1/', { t: NOW - 1000, n: 10 }, KEY.SHARP_INDEX, sharpKey);
    await store.savePreview('https://new.com', { img: image(), t: NOW });
    expect(localArea._data.has(sharpKey('https://u1/'))).toBe(false);
    expect(sharpIndex()).toEqual({});
  });

  it('have their own count cap', async () => {
    for (let i = 0; i < LIMITS.MAX_SHARP; i++) {
      seed(`https://p${i}/`, { t: NOW - 10000 + i });
      seed(`https://p${i}/`, { t: NOW - 10000 + i }, KEY.SHARP_INDEX, sharpKey);
    }
    await store.savePreview('https://new.com', { img: image(), t: NOW, sharp: image() });
    const keys = Object.keys(sharpIndex());
    expect(keys).toHaveLength(LIMITS.MAX_SHARP);
    expect(keys).toContain('https://new.com/');
    expect(keys).not.toContain('https://p0/');
    expect(localArea._data.has(sharpKey('https://p0/'))).toBe(false);
    expect(localArea._data.has(previewKey('https://p0/'))).toBe(true); // the small copy stays
  });

  it('a save over both caps asks Chrome for the open tabs and the archive once', async () => {
    for (let i = 0; i < LIMITS.MAX_PREVIEWS; i++) seed(`https://p${i}/`, { t: NOW - 10000 + i });
    for (let i = 0; i < LIMITS.MAX_SHARP; i++) seed(`https://p${i}/`, { t: NOW - 10000 + i }, KEY.SHARP_INDEX, sharpKey);
    await store.savePreview('https://new.com', { img: image(), t: NOW, sharp: image() });
    expect(Object.keys(index())).toHaveLength(LIMITS.MAX_PREVIEWS);
    expect(Object.keys(sharpIndex())).toHaveLength(LIMITS.MAX_SHARP);
    expect(chrome.tabs.query).toHaveBeenCalledTimes(1);
    expect(chrome.bookmarks.getChildren.mock.calls.filter(([id]) => id === '0')).toHaveLength(1);
    expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
  });

  it('a save under the caps does not ask for the open tabs at all', async () => {
    await store.savePreview('https://a.com', { img: image(), t: 50, sharp: image() });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it('are given up when there is no room, the small copy is kept', async () => {
    localArea.set.mockImplementation(async (items) => {
      if (sharpKey('https://a.com/') in items) throw new Error('quota');
      for (const [storageKey, value] of Object.entries(items)) localArea._data.set(storageKey, structuredClone(value));
    });
    await store.savePreview('https://a.com', { img: image(), t: 50, sharp: image() });
    expect(localArea._data.has(previewKey('https://a.com/'))).toBe(true);
    expect(localArea._data.has(sharpKey('https://a.com/'))).toBe(false);
    expect(sharpIndex()).toEqual({});
  });
});

describe('cleanupPreviews', () => {
  it('deletes previews no open tab uses after 7 days, keeps open, starred and archived ones', async () => {
    const old = NOW - LIMITS.PREVIEW_TIME_TO_LIVE_MILLISECONDS - 1;
    chrome._addTab({ url: 'https://open.com/#a' });
    await store.toggleStar('https://star.com/', 'Star');
    const folder = chrome._addBookmark({ title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: folder.id, url: 'https://arch.com/', title: 'Arch' });
    for (const url of ['https://open.com/', 'https://star.com/', 'https://arch.com/', 'https://gone.com/']) seed(url, { t: old });
    seed('https://recent.com/', { t: old, s: NOW - DAY }); // seen by an open tab yesterday
    seed('https://gone.com/', { t: old }, KEY.SHARP_INDEX, sharpKey);
    await store.cleanupPreviews();
    expect(Object.keys(index()).sort()).toEqual(['https://arch.com/', 'https://open.com/', 'https://recent.com/', 'https://star.com/']);
    expect(localArea._data.has(previewKey('https://gone.com/'))).toBe(false);
    expect(localArea._data.has(sharpKey('https://gone.com/'))).toBe(false);
    expect(index()['https://open.com/'].s).toBe(NOW); // open ones are marked as seen now
    expect(localArea._data.get(KEY.PREVIEW_CLEANUP)).toBe(NOW);
  });

  it('the 7-day cutoff is inclusive', async () => {
    seed('https://edge/', { t: NOW - LIMITS.PREVIEW_TIME_TO_LIVE_MILLISECONDS });
    seed('https://inside/', { t: NOW - LIMITS.PREVIEW_TIME_TO_LIVE_MILLISECONDS + 1 });
    await store.cleanupPreviews();
    expect(Object.keys(index())).toEqual(['https://inside/']);
  });

  it('deletes nothing when Chrome cannot list the tabs', async () => {
    chrome.tabs.query.mockRejectedValueOnce(new Error('no'));
    seed('https://gone.com/', { t: 1 });
    await store.cleanupPreviews();
    expect(index()).toHaveProperty(['https://gone.com/']);
    expect(localArea.remove).not.toHaveBeenCalled();
  });

  it('trims to the caps, unused first', async () => {
    chrome._addTab({ url: 'https://o1/' });
    seed('https://o1/', { t: NOW - 5000, n: 4 * MB });
    seed('https://u1/', { t: NOW - 1000, n: 3 * MB });
    await store.cleanupPreviews();
    expect(Object.keys(index())).toEqual(['https://o1/']);
  });
});

describe('automatic cleanup after a save (maybeCleanup) and boot markers', () => {
  const stale = () => seed('https://stale/', { t: NOW - LIMITS.PREVIEW_TIME_TO_LIVE_MILLISECONDS - 1 });

  it('runs when it never ran and the browser started over a minute ago', async () => {
    localArea._data.delete(KEY.PREVIEW_CLEANUP);
    sessionArea._data.set(KEY.BOOT_AT, NOW - LIMITS.CLEANUP_BOOT_DELAY_MILLISECONDS - 1);
    stale();
    await store.savePreview('https://a.com', { img: image(), t: NOW });
    await flush();
    expect(index()).not.toHaveProperty(['https://stale/']);
    expect(localArea._data.get(KEY.PREVIEW_CLEANUP)).toBe(NOW);
  });

  it('waits a minute after the browser starts', async () => {
    localArea._data.delete(KEY.PREVIEW_CLEANUP);
    await store.markBoot();
    expect(sessionArea._data.get(KEY.BOOT_AT)).toBe(NOW);
    stale();
    await store.savePreview('https://a.com', { img: image(), t: NOW });
    await flush();
    expect(index()).toHaveProperty(['https://stale/']);
  });

  it('runs at most every 6 hours', async () => {
    localArea._data.set(KEY.PREVIEW_CLEANUP, NOW - LIMITS.CLEANUP_EVERY_MILLISECONDS + 1000);
    stale();
    await store.savePreview('https://a.com', { img: image(), t: NOW });
    await flush();
    expect(index()).toHaveProperty(['https://stale/']);
    vi.setSystemTime(NOW + 1000);
    await store.savePreview('https://a.com', { img: image(), t: NOW });
    await flush();
    expect(index()).not.toHaveProperty(['https://stale/']);
  });

  it('ensureBoot marks the session start only once', async () => {
    await store.ensureBoot();
    expect(sessionArea._data.get(KEY.BOOT_AT)).toBe(NOW);
    vi.setSystemTime(NOW + 5000);
    await store.ensureBoot();
    expect(sessionArea._data.get(KEY.BOOT_AT)).toBe(NOW);
  });
});
