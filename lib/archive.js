// The tab archive: a "Tabs Archive" folder in Chrome's "Other bookmarks". Archiving a tab bookmarks it
// there and closes it; opening it from the archive removes the bookmark again. Being plain bookmarks,
// archived tabs sync with Chrome and survive removing Tabazing.

export const ARCHIVE_FOLDER = 'Tabs Archive';

// "Other bookmarks": Chrome 134+ names it (folderType), older versions have it second, with id "2".
async function otherBookmarks() {
  const [root] = await chrome.bookmarks.getTree();
  const kids = (root && root.children) || [];
  return kids.find((n) => n.folderType === 'other') || kids.find((n) => n.id === '2') || kids[1] || kids[0] || null;
}

/** The archive folder, or null when there is none yet (`create` makes it). */
export async function archiveFolder(create = false) {
  if (!chrome.bookmarks) return null;
  const other = await otherBookmarks();
  if (!other) return null;
  const found = (await chrome.bookmarks.getChildren(other.id)).find((n) => !n.url && n.title === ARCHIVE_FOLDER);
  if (found || !create) return found || null;
  return chrome.bookmarks.create({ parentId: other.id, title: ARCHIVE_FOLDER });
}

/** Archived pages, newest first: [{ id, url, title, t }] (`id` is the bookmark's, `t` when it was archived). */
export async function getArchived() {
  const folder = await archiveFolder();
  if (!folder) return [];
  return (await chrome.bookmarks.getChildren(folder.id))
    .filter((n) => n.url)
    .map((n) => ({ id: n.id, url: n.url, title: n.title || '', t: n.dateAdded || 0 }))
    .sort((a, b) => b.t - a.t);
}

/** Bookmark pages ([{ url, title }]) into the archive. Resolves to what was added, like getArchived(). */
export async function addArchived(pages) {
  const folder = await archiveFolder(true);
  if (!folder) throw new Error('bookmarks unavailable');
  const out = [];
  for (const p of pages) {
    const n = await chrome.bookmarks.create({ parentId: folder.id, title: p.title || p.url, url: p.url });
    out.push({ id: n.id, url: n.url, title: n.title || '', t: n.dateAdded || Date.now() });
  }
  return out;
}

/** Take pages out of the archive (by bookmark id). */
export async function removeArchived(ids) {
  for (const id of ids) await chrome.bookmarks.remove(id).catch(() => {}); // already gone (removed in Chrome itself)
}
