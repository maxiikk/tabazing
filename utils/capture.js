// Thumbnail capture. Chrome can only screenshot the *visible* tab of a
// window, so we grab one whenever a tab becomes visible or finishes loading.
// Tabs never shown since the browser started have no preview ("inactive").
// Images never leave the device: they go straight into storage.local (on disk,
// keyed by URL, deleted after 7 days) and are never sent anywhere.

import { LIMITS, PREVIEW_PREFIX } from './constants.js';
import { savePreview, isOverlayTab, noteCapture } from './store.js';
import { isOwnUrl, normalizeUrl } from './ext.js';

let lastCaptureAt = 0;
const timers = new Map(); // windowId -> timeout id (debounce per window)

export function scheduleCapture(windowId, delay = 350) {
  cancelCapture(windowId);
  timers.set(windowId, setTimeout(() => {
    timers.delete(windowId);
    captureWindow(windowId).catch(() => {});
  }, delay));
}

export function cancelCapture(windowId) {
  clearTimeout(timers.get(windowId));
  timers.delete(windowId);
}

// `force` waits out the rate limit instead of rescheduling (used right
// before opening the switcher so the current tab's preview is fresh).
export async function captureWindow(windowId, { force = false } = {}) {
  const wait = lastCaptureAt + LIMITS.CAPTURE_GAP_MS - Date.now();
  if (wait > 0) {
    if (!force) return scheduleCapture(windowId, wait + 10);
    await new Promise((r) => setTimeout(r, wait + 10));
  }

  let tab, win;
  try {
    [tab] = await chrome.tabs.query({ active: true, windowId });
    win = await chrome.windows.get(windowId);
  } catch {
    return; // window closed meanwhile
  }
  if (!tab || !tab.url || isOwnUrl(tab.url)) return noteCapture('skip', 'no page to capture');
  if (win.type !== 'normal' || win.state === 'minimized' || win.incognito) return noteCapture('skip', 'window is minimized or not a normal window');
  if (await isOverlayTab(tab.id)) return noteCapture('skip', 'Tabazing was open over this tab');
  return captureTab(windowId, tab);
}

// Screenshot the visible tab of `windowId` (which must be `tab`) and store it.
// Every outcome is noted (storage.session) so the switcher can say why a preview is missing.
export async function captureTab(windowId, tab) {
  const dataUrl = await grabTab(windowId, tab);
  if (dataUrl) await storeShot(tab, dataUrl);
}

// Opening the switcher: grab the current tab's screenshot before anything covers the page, without
// waiting (null if Chrome's rate limit says not now). Storing it (storeShot) is slower and can follow.
export async function grabForOpen(windowId) {
  if (Date.now() - lastCaptureAt < LIMITS.CAPTURE_GAP_MS) return null;
  let tab, win;
  try {
    [tab] = await chrome.tabs.query({ active: true, windowId });
    win = await chrome.windows.get(windowId);
  } catch {
    return null;
  }
  if (!tab || !tab.url || isOwnUrl(tab.url) || win.type !== 'normal' || win.state === 'minimized' || win.incognito) return null;
  const dataUrl = await grabTab(windowId, tab);
  return dataUrl ? { tab, dataUrl } : null;
}

// The screenshot itself: quick. Null (and a note) if Chrome refused or the tab changed meanwhile.
async function grabTab(windowId, tab) {
  lastCaptureAt = Date.now();
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 });
  } catch (e) {
    // chrome:// pages, the Web Store and the PDF viewer can't be captured; so can nothing at all if
    // Chrome withholds the extension's site access ("On click" in chrome://extensions).
    noteCapture('error', String((e && e.message) || e).slice(0, 200), tab.url);
    return null;
  }
  // The user may have switched tabs or navigated while the capture was in flight.
  const [still] = await chrome.tabs.query({ active: true, windowId });
  if (!still || still.id !== tab.id || normalizeUrl(still.url) !== normalizeUrl(tab.url)) {
    noteCapture('skip', 'the tab changed during the capture', tab.url);
    return null;
  }
  return dataUrl;
}

// Shrink a screenshot into its two stored copies and save them: a small one for the cards, a sharp one
// for the big preview. The slow part (two JPEG encodes), so opening the switcher doesn't wait for it.
// The screenshot is decoded once and both copies are drawn from that one bitmap.
export async function storeShot(tab, dataUrl) {
  const bmp = await decode(dataUrl);
  const [img, sharp] = bmp ? await Promise.all([encode(bmp), encode(bmp, LIMITS.SHARP_MAX, 0.82)]) : [null, null];
  if (bmp) bmp.close();
  if (!img) return noteCapture('error', 'could not shrink the screenshot', tab.url);
  try {
    await savePreview(tab.url, { img, t: Date.now(), sharp });
  } catch (e) {
    return noteCapture('error', 'could not save the preview: ' + String((e && e.message) || e).slice(0, 150), tab.url);
  }
  return noteCapture('ok', '', tab.url);
}

// Downscale to at most `max` px on the longest side (the cards' size by default).
export async function shrink(dataUrl, max = LIMITS.THUMB_MAX, quality = 0.72) {
  const bmp = await decode(dataUrl);
  if (!bmp) return null;
  try { return await encode(bmp, max, quality); } finally { bmp.close(); }
}

// Decodes the data URL by hand rather than with the Fetch API, so the extension's CSP can forbid all
// network access (connect-src 'none'). Null if it isn't an image.
async function decode(dataUrl) {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const bin = atob(dataUrl.slice(comma + 1));
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    return await createImageBitmap(new Blob([raw], { type: 'image/jpeg' }));
  } catch {
    return null;
  }
}

// One JPEG copy of `bmp` (left open: the caller closes it). Null on failure.
async function encode(bmp, max = LIMITS.THUMB_MAX, quality = 0.72) {
  try {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);

    const out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
    let s = '';
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    return PREVIEW_PREFIX + btoa(s);
  } catch {
    return null; // never store a full-size screenshot as a fallback
  }
}
