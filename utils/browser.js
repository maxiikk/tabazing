// Which browser Tabazing runs in, and what differs between Chrome and Firefox where the code has to know. The same
// code runs in both (Firefox gets its own manifest: scripts/firefox.js); this module imports nothing, so every page,
// the background and the tests can use it.

/** Firefox (its extension pages are moz-extension:// pages; Chrome's chrome-extension://). */
export const IS_FIREFOX = typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.getURL === 'function'
  && chrome.runtime.getURL('').startsWith('moz-extension:');
/** The browser's name, as the texts say it ({browser} in the dictionaries). */
export const BROWSER_NAME = IS_FIREFOX ? 'Firefox' : 'Chrome';
/** The origin the extension's frames run in: in Chrome its real id (getURL may give the per-session one of
 * use_dynamic_url); in Firefox its moz-extension://<uuid>, which is not the add-on's id. */
export const EXTENSION_ORIGIN = IS_FIREFOX ? chrome.runtime.getURL('').replace(/\/+$/, '') // (moz-extension://<uuid>: a URL object may not say)
  : typeof chrome !== 'undefined' && chrome.runtime ? `chrome-extension://${chrome.runtime.id}` : '';

/** When a recently closed tab or window was closed, in milliseconds (0: unknown). Chrome gives seconds, Firefox milliseconds. */
export function closedTime(session) {
  const value = session && session.lastModified;
  if (!(value > 0)) return 0;
  return value > 1e11 ? value : value * 1000; // (1e11 seconds is the year 5138; 1e11 milliseconds is 1973)
}

// The top bookmark folders, which both browsers have under other ids (Firefox's also under no folderType).
const FIREFOX_FOLDERS = { toolbar_____: 'bookmarks-bar', unfiled_____: 'other', mobile______: 'mobile', menu________: 'menu' };
const CHROME_FOLDERS = { 1: 'bookmarks-bar', 2: 'other', 3: 'mobile' };
/** The bookmark tree's root, whose children are the top folders. */
export const BOOKMARKS_ROOT = IS_FIREFOX ? 'root________' : '0';
/** What a top bookmark folder is: 'bookmarks-bar', 'other' (Firefox: "Other Bookmarks"), 'mobile', 'menu' (Firefox's
 * Bookmarks Menu, which Chrome hasn't), or null. */
export const folderTypeOf = (node) => (node && (node.folderType || FIREFOX_FOLDERS[node.id] || CHROME_FOLDERS[node.id])) || null;
/** The top folder of this type among `nodes` (the root's children): one the browser names so first, then by its id. */
export const topFolder = (nodes, type) => nodes.find((node) => node.folderType === type) || nodes.find((node) => folderTypeOf(node) === type) || null;
