// The tab archive: a "Tabs Archive" folder in Chrome's "Other bookmarks". Archiving a tab bookmarks it
// there and closes it; opening it from the archive removes the bookmark again. Being plain bookmarks,
// archived tabs sync with Chrome and survive removing Tabazing.

import { BOOKMARKS_ROOT, topFolder } from './browser.js';

export const ARCHIVE_FOLDER = 'Tabs Archive';

// "Other bookmarks" (Firefox: "Other Bookmarks"), whatever its id in this browser (utils/browser.js folderTypeOf).
// Only the root's own children are read (not getTree): this runs on every save over the preview caps.
async function otherBookmarks() {
  const kids = (await chrome.bookmarks.getChildren(BOOKMARKS_ROOT)) || [];
  return topFolder(kids, 'other') || kids[1] || kids[0] || null;
}

/** The archive folder, or null when there is none yet (`create` makes it). */
export async function archiveFolder(create = false) {
  if (!chrome.bookmarks) return null;
  const other = await otherBookmarks();
  if (!other) return null;
  const found = (await chrome.bookmarks.getChildren(other.id)).find((node) => !node.url && node.title === ARCHIVE_FOLDER);
  if (found || !create) return found || null;
  return chrome.bookmarks.create({ parentId: other.id, title: ARCHIVE_FOLDER });
}

/** Archived pages, newest first: [{ id, url, title, t }] (`id` is the bookmark's, `t` when it was archived). */
export async function getArchived() {
  const folder = await archiveFolder();
  if (!folder) return [];
  return (await chrome.bookmarks.getChildren(folder.id))
    .filter((node) => node.url)
    .map((node) => ({ id: node.id, url: node.url, title: node.title || '', t: node.dateAdded || 0 }))
    .sort((first, second) => second.t - first.t);
}

/** Bookmark pages ([{ url, title }]) into the archive. Resolves to what was added, like getArchived(). */
export async function addArchived(pages) {
  const folder = await archiveFolder(true);
  if (!folder) throw new Error('bookmarks unavailable');
  const out = [];
  for (const page of pages) {
    const node = await chrome.bookmarks.create({ parentId: folder.id, title: page.title || page.url, url: page.url });
    out.push({ id: node.id, url: node.url, title: node.title || '', t: node.dateAdded || Date.now() });
  }
  return out;
}

/** Take pages out of the archive (by bookmark id). */
export async function removeArchived(ids) {
  for (const id of ids) await chrome.bookmarks.remove(id).catch(() => {}); // already gone (removed in Chrome itself)
}
