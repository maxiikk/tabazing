// Site icons for Firefox, which gives extensions no favicon service (Chrome draws them from its /_favicon/ page). Firefox
// hands each tab's icon over as a data: URL (tab.favIconUrl): the background keeps each site's, made 32 px, by host
// (utils/store.js putFavicon), and the switcher reads them all when it opens (favicon() in switcher.js). Nothing is
// downloaded: the extension's pages may connect nowhere (connect-src 'none'), so an icon given as a web address is left out.
import { faviconSource, putFavicon } from './store.js';
import { LIMITS } from './constants.js';

const SIZE = 32;
const KEEP_MILLISECONDS = 7 * 24 * 60 * 60 * 1000; // an icon is taken again after a week (or when it changes)
const MAX_SOURCE = 512 * 1024; // a data: URL longer than this isn't a site's icon

/** The host a page's icon is kept under ('' for pages without one: about:, data:, the extension's own). */
export function faviconHost(url) {
  try { const parsed = new URL(url); return /^(https?|file):$/.test(parsed.protocol) ? parsed.host || 'file' : ''; } catch { return ''; }
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});
// The picture, made SIZE px square (a PNG); as it came if it can't be decoded here (an SVG) and is small enough.
async function shrink(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, SIZE, SIZE);
    bitmap.close();
    return await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
  } catch {
    const dataUrl = blob.type.startsWith('image/') ? await blobToDataUrl(blob) : '';
    return dataUrl.length <= LIMITS.FAVICON_MAX_LENGTH ? dataUrl : '';
  }
}

/** Keep the icon of this tab's site, unless it was kept from the same address less than a week ago. */
export async function keepFavicon(tab) {
  const host = tab && faviconHost(tab.url);
  const source = tab && tab.favIconUrl;
  if (!host || typeof source !== 'string' || !source.startsWith('data:image/') || source.length > MAX_SOURCE) return;
  const kept = await faviconSource(host);
  if (kept && kept.s === source.slice(0, 512) && Date.now() - kept.t < KEEP_MILLISECONDS) return;
  const blob = dataUrlBlob(source);
  if (!blob || !blob.size) return;
  const dataUrl = await shrink(blob);
  if (dataUrl) await putFavicon(host, dataUrl, source);
}
// The picture a data: URL holds (base64 or percent-encoded), or null.
export function dataUrlBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(5, comma), payload = dataUrl.slice(comma + 1);
  try {
    const bytes = /;base64$/i.test(header) ? Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(payload));
    return new Blob([bytes], { type: header.split(';')[0] });
  } catch { return null; }
}
