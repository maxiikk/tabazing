import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KEY, LIMITS, PREVIEW_PREFIX, previewKey, sharpKey } from '../../utils/constants.js';

// capture.js keeps the time of the last screenshot in module state, so each test imports it afresh.
let capture;
let canvases; // every OffscreenCanvas the capture made: { w, h, quality, ctx }
let bitmap;   // size of the next decoded screenshot

const sessionData = () => chrome.storage.session._data;
const localData = () => chrome.storage.local._data;
const note = () => sessionData().get(KEY.CAPTURE_DIAGNOSIS);

let webp; // whether the fake canvas can write WebP (Chrome's can)
beforeEach(async () => {
  webp = true;
  vi.useFakeTimers({ now: new Date('2026-10-17T12:00:00Z') });
  canvases = [];
  bitmap = { width: 1600, height: 1000 };
  // jsdom has no image decoding or OffscreenCanvas: fake just enough for the capture.
  vi.stubGlobal('createImageBitmap', vi.fn(async (blob) => {
    expect(blob.type).toBe('image/jpeg');
    return { ...bitmap, close: vi.fn() };
  }));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(width, height) {
      this.recorder = { w: width, h: height, context: { drawImage: vi.fn() } };
      canvases.push(this.recorder);
    }
    getContext() { return this.recorder.context; }
    async convertToBlob({ type, quality }) {
      this.recorder.quality = quality;
      this.recorder.type = type;
      expect(['image/webp', 'image/jpeg']).toContain(type);
      const bytes = new TextEncoder().encode(`jpg${this.recorder.w}x${this.recorder.h}`);
      return { type: webp ? type : type === 'image/webp' ? 'image/png' : type, arrayBuffer: async () => bytes.buffer };
    }
  });
  vi.resetModules();
  capture = await import('../../utils/capture.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function page(overrides = {}) {
  const testWindow = chrome._addWindow({ focused: true, ...overrides.window });
  const tab = chrome._addTab({ windowId: testWindow.id, url: 'https://a.com/x', active: true, ...overrides.tab });
  return { w: testWindow, t: tab };
}

describe('captureWindow', () => {
  it('screenshots the active tab and stores a card copy and a sharp copy', async () => {
    const { w: testWindow } = page();
    await capture.captureWindow(testWindow.id);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(testWindow.id, { format: 'jpeg', quality: 80 });
    const small = localData().get(previewKey('https://a.com/x'));
    const sharp = localData().get(sharpKey('https://a.com/x'));
    expect(small.img).toBe(PREVIEW_PREFIX + btoa('jpg560x350'));
    expect(sharp.img).toBe('data:image/jpeg;base64,AAAA'); // no larger than SHARP_MAX: kept as it was taken
    expect(canvases).toHaveLength(1); // (not drawn or written again)
    expect(small.t).toBe(Date.now());
    expect(note()).toMatchObject({ stage: 'ok', host: 'a.com' });
  });

  it('shrinks to the longest side with the right JPEG quality', async () => {
    bitmap = { width: 1000, height: 4000 };
    const { w: testWindow } = page();
    await capture.captureWindow(testWindow.id);
    expect(canvases).toEqual([
      expect.objectContaining({ w: 140, h: LIMITS.THUMB_MAX, quality: 0.72, type: 'image/webp' }),
      expect.objectContaining({ w: 480, h: LIMITS.SHARP_MAX, quality: 0.82, type: 'image/jpeg' }),
    ]);
    expect(canvases[0].context.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 140, 560);
  });

  it('skips its own pages, minimized / incognito / popup windows, and tabs under the overlay', async () => {
    const own = page({ tab: { url: chrome.runtime.getURL('markup/switcher.html') } });
    await capture.captureWindow(own.w.id);
    expect(note().message).toBe('no page to capture');

    for (const windowOptions of [{ state: 'minimized' }, { incognito: true }, { type: 'popup' }]) {
      const { w: testWindow } = page({ window: windowOptions });
      await capture.captureWindow(testWindow.id);
      expect(note().message).toBe('window is minimized or not a normal window');
    }

    const { w: testWindow, t: tab } = page();
    await chrome.storage.session.set({ [KEY.OVERLAY]: { tabId: tab.id, t: Date.now() } });
    await capture.captureWindow(testWindow.id);
    expect(note().message).toBe('Tabazing was open over this tab');
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('gives up quietly when the window is gone', async () => {
    await capture.captureWindow(99);
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(note()).toBeUndefined();
  });

  it('keeps the rate gap: a capture too soon after the last is rescheduled', async () => {
    const { w: testWindow } = page();
    await capture.captureWindow(testWindow.id);
    vi.advanceTimersByTime(100);
    await capture.captureWindow(testWindow.id);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIMITS.CAPTURE_GAP_MILLISECONDS - 100); // remaining gap + 10 ms not yet over
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('with force, waits out the rate gap instead', async () => {
    const { w: testWindow } = page();
    await capture.captureWindow(testWindow.id);
    const promise = capture.captureWindow(testWindow.id, { force: true });
    await vi.advanceTimersByTimeAsync(LIMITS.CAPTURE_GAP_MILLISECONDS - 1);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    await promise;
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('drops the shot if the tab changed while it was taken', async () => {
    const { w: testWindow, t: tab } = page();
    chrome.tabs.captureVisibleTab.mockImplementationOnce(async () => {
      chrome._data.tabs.find((x) => x.id === tab.id).url = 'https://a.com/elsewhere';
      return 'data:image/jpeg;base64,AAAA';
    });
    await capture.captureWindow(testWindow.id);
    expect(note()).toMatchObject({ stage: 'skip', message: 'the tab changed during the capture' });
    expect(localData().has(previewKey('https://a.com/x'))).toBe(false);
  });

  it('treats the same page with another #fragment as unchanged', async () => {
    const { w: testWindow, t: tab } = page();
    chrome.tabs.captureVisibleTab.mockImplementationOnce(async () => {
      chrome._data.tabs.find((x) => x.id === tab.id).url = 'https://a.com/x#top';
      return 'data:image/jpeg;base64,AAAA';
    });
    await capture.captureWindow(testWindow.id);
    expect(note().stage).toBe('ok');
  });
});

describe('capture failures and the no-capture list', () => {
  it('notes Chrome refusing, and remembers pages Chrome never lets us capture', async () => {
    const { w: testWindow } = page({ tab: { url: 'https://chromewebstore.google.com/detail/x' } });
    chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('The extensions gallery cannot be scripted.'));
    await capture.captureWindow(testWindow.id);
    expect(note()).toMatchObject({ stage: 'error', message: 'The extensions gallery cannot be scripted.', host: 'chromewebstore.google.com' });
    expect(sessionData().get(KEY.NO_CAPTURE)).toEqual(['https://chromewebstore.google.com/detail/x']);
  });

  it('a later success takes the page off the list', async () => {
    const { w: testWindow } = page();
    await chrome.storage.session.set({ [KEY.NO_CAPTURE]: ['https://a.com/x', 'https://b.com/'] });
    await capture.captureWindow(testWindow.id);
    expect(sessionData().get(KEY.NO_CAPTURE)).toEqual(['https://b.com/']);
  });

  it('a passing error (not a blocked page) is noted but not listed', async () => {
    const { w: testWindow } = page();
    chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('Too many calls'));
    await capture.captureWindow(testWindow.id);
    expect(note()).toMatchObject({ stage: 'error', message: 'Too many calls' });
    expect(sessionData().has(KEY.NO_CAPTURE)).toBe(false);
  });

  it('a failed capture still counts towards the rate gap', async () => {
    const { w: testWindow } = page();
    chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('nope'));
    await capture.captureWindow(testWindow.id);
    expect(await capture.grabForOpen(testWindow.id)).toBeNull();
  });
});

describe('scheduleCapture / cancelCapture', () => {
  it('captures after the delay, debounced per window', async () => {
    const { w: testWindow } = page();
    capture.scheduleCapture(testWindow.id);
    await vi.advanceTimersByTimeAsync(300);
    capture.scheduleCapture(testWindow.id); // restarts the wait
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it('keeps separate timers for separate windows', async () => {
    const firstPage = page(), secondPage = page();
    capture.scheduleCapture(firstPage.w.id, 100);
    capture.scheduleCapture(secondPage.w.id, 100);
    await vi.advanceTimersByTimeAsync(100);
    // The second one hits the rate gap and is rescheduled; it still happens.
    await vi.advanceTimersByTimeAsync(LIMITS.CAPTURE_GAP_MILLISECONDS + 10);
    expect(chrome.tabs.captureVisibleTab.mock.calls.map((call) => call[0])).toEqual([firstPage.w.id, secondPage.w.id]);
  });

  it('cancelCapture stops a pending capture', async () => {
    const { w: testWindow } = page();
    capture.scheduleCapture(testWindow.id, 100);
    capture.cancelCapture(testWindow.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });
});

describe('Lite mode (Settings)', () => {
  it('takes no screenshot: not after a tab switch, not as Tabazing opens', async () => {
    const { w: testWindow } = page();
    localData().set('prefs', { lite: true });
    await capture.captureWindow(testWindow.id);
    expect(await capture.grabForOpen(testWindow.id)).toBe(null);
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(localData().has(previewKey('https://a.com/x'))).toBe(false);
  });
});

describe('grabForOpen', () => {
  it('returns the tab and the raw screenshot without storing it', async () => {
    const { w: testWindow, t: tab } = page();
    const got = await capture.grabForOpen(testWindow.id);
    expect(got).toEqual({ tab: expect.objectContaining({ id: tab.id }), dataUrl: 'data:image/jpeg;base64,AAAA' });
    expect(localData().has(previewKey('https://a.com/x'))).toBe(false);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('is null inside the rate gap, without waiting', async () => {
    const { w: testWindow } = page();
    await capture.grabForOpen(testWindow.id);
    vi.advanceTimersByTime(LIMITS.CAPTURE_GAP_MILLISECONDS - 1);
    expect(await capture.grabForOpen(testWindow.id)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(await capture.grabForOpen(testWindow.id)).not.toBeNull();
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('is null for own pages, odd windows, a missing window, or a refused capture', async () => {
    expect(await capture.grabForOpen(99)).toBeNull();
    expect(await capture.grabForOpen(page({ tab: { url: chrome.runtime.getURL('markup/sweep.html') } }).w.id)).toBeNull();
    expect(await capture.grabForOpen(page({ window: { state: 'minimized' } }).w.id)).toBeNull();
    expect(await capture.grabForOpen(page({ window: { incognito: true } }).w.id)).toBeNull();
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('denied'));
    expect(await capture.grabForOpen(page().w.id)).toBeNull();
    expect(note()).toMatchObject({ stage: 'error', message: 'denied' });
  });
});

describe('storeShot', () => {
  const tab = { id: 1, url: 'https://a.com/x' };

  it('notes a screenshot that cannot be decoded and stores nothing', async () => {
    createImageBitmap.mockRejectedValueOnce(new Error('bad image'));
    await capture.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(note()).toMatchObject({ stage: 'error', message: 'could not shrink the screenshot' });
    expect(localData().has(previewKey('https://a.com/x'))).toBe(false);
  });

  it('rejects a data URL without a payload', async () => {
    await capture.storeShot(tab, 'garbage');
    expect(note().message).toBe('could not shrink the screenshot');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('notes a failed save', async () => {
    chrome.storage.local.set.mockRejectedValue(new Error('QUOTA_BYTES quota exceeded'));
    await capture.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(note()).toMatchObject({ stage: 'error', message: 'could not save the preview: QUOTA_BYTES quota exceeded' });
  });

  it('decodes the screenshot once for both copies, and frees the bitmap', async () => {
    bitmap = { width: 3840, height: 2160 };
    const close = vi.fn();
    createImageBitmap.mockImplementation(async () => ({ ...bitmap, close }));
    await capture.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(createImageBitmap).toHaveBeenCalledTimes(1);
    expect(canvases).toHaveLength(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('frees the bitmap when the card copy fails to encode, and stores nothing', async () => {
    const close = vi.fn();
    createImageBitmap.mockImplementation(async () => ({ ...bitmap, close }));
    OffscreenCanvas.prototype.convertToBlob = async () => { throw new Error('out of memory'); };
    await capture.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(close).toHaveBeenCalledTimes(1);
    expect(note().message).toBe('could not shrink the screenshot');
    expect(localData().has(previewKey('https://a.com/x'))).toBe(false);
  });

  it('still saves the card copy if only the sharp copy fails to shrink', async () => {
    bitmap = { width: 3840, height: 2160 };
    const encode = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = async function (options) {
      if (this.recorder.w > LIMITS.THUMB_MAX) throw new Error('out of memory');
      return encode.call(this, options);
    };
    await capture.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(localData().get(previewKey('https://a.com/x')).img).toMatch(/^data:image\/webp;base64,/);
    expect(localData().has(sharpKey('https://a.com/x'))).toBe(false);
    expect(note().stage).toBe('ok');
  });

  it('stores the card copy as WebP, the sharp one as JPEG (quicker to write); a browser that can’t write WebP stores JPEG', async () => {
    bitmap = { width: 3840, height: 2160 };
    await capture.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(localData().get(previewKey('https://a.com/x')).img).toMatch(/^data:image\/webp;base64,/);
    expect(localData().get(sharpKey('https://a.com/x')).img).toBe('data:image/jpeg;base64,' + btoa('jpg1920x1080'));
    webp = false;
    await capture.storeShot(tab, 'data:image/jpeg;base64,AAAA');
    expect(localData().get(previewKey('https://a.com/x')).img).toMatch(/^data:image\/jpeg;base64,/);
  });
});
