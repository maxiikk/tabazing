import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KEY, LIMITS, PREVIEW_PREFIX, previewKey, sharpKey } from '../../utils/constants.js';

// capture.js keeps the time of the last screenshot in module state, so each test imports it afresh.
let cap;
let canvases; // every OffscreenCanvas shrink() made: { w, h, quality, ctx }
let bitmap;   // size of the next decoded screenshot

const S = () => chrome.storage.session._data;
const L = () => chrome.storage.local._data;
const note = () => S().get(KEY.CAPDIAG);

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date('2026-10-17T12:00:00Z') });
  canvases = [];
  bitmap = { width: 1600, height: 1000 };
  // jsdom has no image decoding or OffscreenCanvas: fake just enough for shrink().
  vi.stubGlobal('createImageBitmap', vi.fn(async (blob) => {
    expect(blob.type).toBe('image/jpeg');
    return { ...bitmap, close: vi.fn() };
  }));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(w, h) {
      this.rec = { w, h, ctx: { drawImage: vi.fn() } };
      canvases.push(this.rec);
    }
    getContext() { return this.rec.ctx; }
    async convertToBlob({ type, quality }) {
      this.rec.quality = quality;
      expect(type).toBe('image/jpeg');
      const bytes = new TextEncoder().encode(`jpg${this.rec.w}x${this.rec.h}`);
      return { type, arrayBuffer: async () => bytes.buffer };
    }
  });
  vi.resetModules();
  cap = await import('../../utils/capture.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function page(p = {}) {
  const w = chrome._addWindow({ focused: true, ...p.win });
  const t = chrome._addTab({ windowId: w.id, url: 'https://a.com/x', active: true, ...p.tab });
  return { w, t };
}

describe('captureWindow', () => {
  it('screenshots the active tab and stores a card copy and a sharp copy', async () => {
    const { w } = page();
    await cap.captureWindow(w.id);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(w.id, { format: 'jpeg', quality: 80 });
    const small = L().get(previewKey('https://a.com/x'));
    const sharp = L().get(sharpKey('https://a.com/x'));
    expect(small.img).toBe(PREVIEW_PREFIX + btoa('jpg560x350'));
    expect(sharp.img).toBe(PREVIEW_PREFIX + btoa('jpg1600x1000')); // already under SHARP_MAX: not upscaled
    expect(small.t).toBe(Date.now());
    expect(note()).toMatchObject({ stage: 'ok', host: 'a.com' });
  });

  it('shrinks to the longest side with the right JPEG quality', async () => {
    bitmap = { width: 1000, height: 4000 };
    const { w } = page();
    await cap.captureWindow(w.id);
    expect(canvases).toEqual([
      expect.objectContaining({ w: 140, h: LIMITS.THUMB_MAX, quality: 0.72 }),
      expect.objectContaining({ w: 480, h: LIMITS.SHARP_MAX, quality: 0.82 }),
    ]);
    expect(canvases[0].ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 140, 560);
  });

  it('skips its own pages, minimized / incognito / popup windows, and tabs under the overlay', async () => {
    const own = page({ tab: { url: chrome.runtime.getURL('markup/switcher.html') } });
    await cap.captureWindow(own.w.id);
    expect(note().msg).toBe('no page to capture');

    for (const win of [{ state: 'minimized' }, { incognito: true }, { type: 'popup' }]) {
      const { w } = page({ win });
      await cap.captureWindow(w.id);
      expect(note().msg).toBe('window is minimized or not a normal window');
    }

    const { w, t } = page();
    await chrome.storage.session.set({ [KEY.OVERLAY]: { tabId: t.id, t: Date.now() } });
    await cap.captureWindow(w.id);
    expect(note().msg).toBe('Tabazing was open over this tab');
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('gives up quietly when the window is gone', async () => {
    await cap.captureWindow(99);
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(note()).toBeUndefined();
  });

  it('keeps the rate gap: a capture too soon after the last is rescheduled', async () => {
    const { w } = page();
    await cap.captureWindow(w.id);
    vi.advanceTimersByTime(100);
    await cap.captureWindow(w.id);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIMITS.CAPTURE_GAP_MS - 100); // remaining gap + 10 ms not yet over
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('with force, waits out the rate gap instead', async () => {
    const { w } = page();
    await cap.captureWindow(w.id);
    const p = cap.captureWindow(w.id, { force: true });
    await vi.advanceTimersByTimeAsync(LIMITS.CAPTURE_GAP_MS - 1);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    await p;
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('drops the shot if the tab changed while it was taken', async () => {
    const { w, t } = page();
    chrome.tabs.captureVisibleTab.mockImplementationOnce(async () => {
      chrome._data.tabs.find((x) => x.id === t.id).url = 'https://a.com/elsewhere';
      return 'data:image/jpeg;base64,AAAA';
    });
    await cap.captureWindow(w.id);
    expect(note()).toMatchObject({ stage: 'skip', msg: 'the tab changed during the capture' });
    expect(L().has(previewKey('https://a.com/x'))).toBe(false);
  });

  it('treats the same page with another #fragment as unchanged', async () => {
    const { w, t } = page();
    chrome.tabs.captureVisibleTab.mockImplementationOnce(async () => {
      chrome._data.tabs.find((x) => x.id === t.id).url = 'https://a.com/x#top';
      return 'data:image/jpeg;base64,AAAA';
    });
    await cap.captureWindow(w.id);
    expect(note().stage).toBe('ok');
  });
});

describe('capture failures and the no-capture list', () => {
  it('notes Chrome refusing, and remembers pages Chrome never lets us capture', async () => {
    const { w } = page({ tab: { url: 'https://chromewebstore.google.com/detail/x' } });
    chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('The extensions gallery cannot be scripted.'));
    await cap.captureWindow(w.id);
    expect(note()).toMatchObject({ stage: 'error', msg: 'The extensions gallery cannot be scripted.', host: 'chromewebstore.google.com' });
    expect(S().get(KEY.NOCAP)).toEqual(['https://chromewebstore.google.com/detail/x']);
  });

  it('a later success takes the page off the list', async () => {
    const { w } = page();
    await chrome.storage.session.set({ [KEY.NOCAP]: ['https://a.com/x', 'https://b.com/'] });
    await cap.captureWindow(w.id);
    expect(S().get(KEY.NOCAP)).toEqual(['https://b.com/']);
  });

  it('a passing error (not a blocked page) is noted but not listed', async () => {
    const { w } = page();
    chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('Too many calls'));
    await cap.captureWindow(w.id);
    expect(note()).toMatchObject({ stage: 'error', msg: 'Too many calls' });
    expect(S().has(KEY.NOCAP)).toBe(false);
  });

  it('a failed capture still counts towards the rate gap', async () => {
    const { w } = page();
    chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('nope'));
    await cap.captureWindow(w.id);
    expect(await cap.grabForOpen(w.id)).toBeNull();
  });
});

describe('scheduleCapture / cancelCapture', () => {
  it('captures after the delay, debounced per window', async () => {
    const { w } = page();
    cap.scheduleCapture(w.id);
    await vi.advanceTimersByTimeAsync(300);
    cap.scheduleCapture(w.id); // restarts the wait
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it('keeps separate timers for separate windows', async () => {
    const a = page(), b = page();
    cap.scheduleCapture(a.w.id, 100);
    cap.scheduleCapture(b.w.id, 100);
    await vi.advanceTimersByTimeAsync(100);
    // The second one hits the rate gap and is rescheduled; it still happens.
    await vi.advanceTimersByTimeAsync(LIMITS.CAPTURE_GAP_MS + 10);
    expect(chrome.tabs.captureVisibleTab.mock.calls.map((c) => c[0])).toEqual([a.w.id, b.w.id]);
  });

  it('cancelCapture stops a pending capture', async () => {
    const { w } = page();
    cap.scheduleCapture(w.id, 100);
    cap.cancelCapture(w.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });
});

describe('grabForOpen', () => {
  it('returns the tab and the raw screenshot without storing it', async () => {
    const { w, t } = page();
    const got = await cap.grabForOpen(w.id);
    expect(got).toEqual({ tab: expect.objectContaining({ id: t.id }), dataUrl: 'data:image/jpeg;base64,AAAA' });
    expect(L().has(previewKey('https://a.com/x'))).toBe(false);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('is null inside the rate gap, without waiting', async () => {
    const { w } = page();
    await cap.grabForOpen(w.id);
    vi.advanceTimersByTime(LIMITS.CAPTURE_GAP_MS - 1);
    expect(await cap.grabForOpen(w.id)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(await cap.grabForOpen(w.id)).not.toBeNull();
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('is null for own pages, odd windows, a missing window, or a refused capture', async () => {
    expect(await cap.grabForOpen(99)).toBeNull();
    expect(await cap.grabForOpen(page({ tab: { url: chrome.runtime.getURL('markup/sweep.html') } }).w.id)).toBeNull();
    expect(await cap.grabForOpen(page({ win: { state: 'minimized' } }).w.id)).toBeNull();
    expect(await cap.grabForOpen(page({ win: { incognito: true } }).w.id)).toBeNull();
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('denied'));
    expect(await cap.grabForOpen(page().w.id)).toBeNull();
    expect(note()).toMatchObject({ stage: 'error', msg: 'denied' });
  });
});

describe('shrink', () => {
  it('makes one copy, at the card size by default, and frees the bitmap', async () => {
    const close = vi.fn();
    createImageBitmap.mockImplementation(async () => ({ ...bitmap, close }));
    expect(await cap.shrink('data:image/jpeg;base64,AAAA')).toBe(PREVIEW_PREFIX + btoa('jpg560x350'));
    expect(close).toHaveBeenCalledTimes(1);
    expect(await cap.shrink('garbage')).toBeNull();
  });
});

describe('storeShot', () => {
  const tab = { id: 1, url: 'https://a.com/x' };

  it('notes a screenshot that cannot be decoded and stores nothing', async () => {
    createImageBitmap.mockRejectedValueOnce(new Error('bad image'));
    await cap.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(note()).toMatchObject({ stage: 'error', msg: 'could not shrink the screenshot' });
    expect(L().has(previewKey('https://a.com/x'))).toBe(false);
  });

  it('rejects a data URL without a payload', async () => {
    await cap.storeShot(tab, 'garbage');
    expect(note().msg).toBe('could not shrink the screenshot');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('notes a failed save', async () => {
    chrome.storage.local.set.mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'));
    await cap.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(note()).toMatchObject({ stage: 'error', msg: 'could not save the preview: QUOTA_BYTES quota exceeded' });
  });

  it('decodes the screenshot once for both copies, and frees the bitmap', async () => {
    const close = vi.fn();
    createImageBitmap.mockImplementation(async () => ({ ...bitmap, close }));
    await cap.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(canvases).toHaveLength(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('frees the bitmap when the card copy fails to encode, and stores nothing', async () => {
    const close = vi.fn();
    createImageBitmap.mockImplementation(async () => ({ ...bitmap, close }));
    OffscreenCanvas.prototype.convertToBlob = async () => { throw new Error('out of memory'); };
    await cap.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(close).toHaveBeenCalledTimes(1);
    expect(note().msg).toBe('could not shrink the screenshot');
    expect(L().has(previewKey('https://a.com/x'))).toBe(false);
  });

  it('still saves the card copy if only the sharp copy fails to shrink', async () => {
    const encode = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = async function (o) {
      if (this.rec.w > LIMITS.THUMB_MAX) throw new Error('out of memory');
      return encode.call(this, o);
    };
    await cap.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(L().get(previewKey('https://a.com/x')).img).toMatch(/^data:image\/jpeg;base64,/);
    expect(L().has(sharpKey('https://a.com/x'))).toBe(false);
    expect(note().stage).toBe('ok');
  });
});
