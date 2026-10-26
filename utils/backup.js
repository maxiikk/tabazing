// Backup & Restore: everything Tabazing keeps, as one zip ("tabazing-backup-<date>.zip") with a "backup" folder of JSON
// files, and back. A restore only ever adds: nothing there is deleted, and nothing is made twice.
//
//   backup/info.json            what this is: { app, version, made, files }
//   backup/settings.json        Settings (restored only when asked: it replaces the current ones)
//   backup/notes.json           notes on pages (tabs): [{ url, note, t }]
//   backup/bookmark-notes.json  notes on bookmarks: [{ url, title, path, note, t }] (the bookmark: its address in that folder)
//   backup/stars.json           starred pages: [{ url, title, t }]
//   backup/bookmarks.json       every bookmark and folder: [{ title, type, children: [{ title, url } | { title, children }] }]
//   backup/archive.json         the archived tabs (also in bookmarks.json, under the archive folder): [{ url, title, t }]
//   backup/snoozed.json         snoozed tabs: [{ url, title, at, pinned, group }]
//
// Restoring, per kind:
//   - bookmarks: a bookmark already here is skipped (no duplicates): one of the same address (exactly: "#inbox" and
//     "#sent" are two pages) in the same folder, else one anywhere (moved since). Each one here stands for one of the
//     backup's, so a page kept in two folders comes back in both. The others are made in their folder: the existing
//     one of the same name in the same place, else made, and only when something goes in it. One Chrome refuses
//     is left out; managed bookmarks (an organization's) are never copied;
//   - archive: a page not bookmarked anywhere goes into the archive folder;
//   - notes on pages and on bookmarks: the backup's note goes on the page / bookmark, over the one there (the only
//     thing a restore replaces), with its time; a bookmark's note is put on the bookmark of that address in that
//     folder, or else on one of that address anywhere;
//   - stars and snoozed tabs: added when the page has none yet; a snooze whose time has passed is left out (it would
//     open at once);
//   - settings: only with `settings: true`, and only the valid ones.
// The caps on stars, notes and snoozed tabs never drop anything that is there: what doesn't fit is left out. An entry
// that isn't one (no address, a note that isn't text) is counted as left out.
import { mergeStars, mergeNotes, mergeBookmarkNotes, mergeSnoozed, getStars, getNotes, getBookmarkNotes, getSnoozed, getPreferences, updatePreferences, validPreferences } from './store.js';
import { getArchived, addArchived, ARCHIVE_FOLDER } from './archive.js';
export { zipFiles, unzipFiles } from './zip.js';
import { folderTypeOf, topFolder } from './browser.js';

export const BACKUP_DIRECTORY = 'backup';
export const BACKUP_FILES = ['info', 'settings', 'notes', 'bookmark-notes', 'stars', 'bookmarks', 'archive', 'snoozed'];
const MAX_FILE = 50 * 1024 * 1024; // a backup file bigger than this isn't one of ours
const MAX_DEPTH = 100; // folders in folders: deeper than this isn't a real bookmarks tree
const isUrlAllowed = (url) => typeof url === 'string' && url.length > 0 && url.length <= 8192 && /^[a-z][\w+.-]*:/i.test(url);
const text = (value, maxLength = 1000) => (typeof value === 'string' ? value.slice(0, maxLength) : '');
const canonical = (url) => { try { return new URL(url).href; } catch { return url; } }; // as Chrome keeps it ("https://x.com" is "https://x.com/")
const day = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const backupName = (date = new Date()) => `tabazing-backup-${day(date)}`;

/**
 * The backup's JSON files by kind ({ notes: [...], ... }) from a Map(path -> text): the zip's, or a chosen folder's.
 * They are one folder's files: a folder holding several backups gives the newest one (by its info.json, else the
 * name that sorts last: tabazing-backup-<date>), never a mix of them; a folder named "backup" before any other.
 */
export function readBackup(files) {
  const directories = new Map(); // folder ("" or "…/") -> { kind: data }
  for (const [path, body] of files) {
    const match = /^(.*\/)?([\w-]+)\.json$/.exec(path.replace(/\\/g, '/'));
    if (!match || !BACKUP_FILES.includes(match[2]) || body.length > MAX_FILE) continue;
    let data;
    try { data = JSON.parse(body); } catch { continue; } // a broken file is left out
    const directory = match[1] || '';
    if (!directories.has(directory)) directories.set(directory, {});
    directories.get(directory)[match[2]] = data;
  }
  const made = (folder) => { const timestamp = Date.parse(folder.info && folder.info.made); return Number.isFinite(timestamp) ? timestamp : 0; };
  const named = (directory) => /(?:^|\/)backup\/$/.test(directory);
  const found = [...directories].filter(([, folder]) => Object.keys(folder).some((key) => key !== 'info'))
    .sort(([firstDirectory, x], [secondDirectory, y]) => named(firstDirectory) - named(secondDirectory) || made(x) - made(y) || (firstDirectory < secondDirectory ? -1 : firstDirectory > secondDirectory ? 1 : 0));
  if (!found.length) throw new Error('no backup files');
  return found[found.length - 1][1];
}

// ---------------------------------------------------------------- export
/** Everything Tabazing keeps, as the backup's files ([{ name, data }], their paths in the zip). */
export async function makeBackup({ version = '' } = {}) {
  const [preferences, notes, bookmarkNotes, stars, snoozed, archived, tree] = await Promise.all([
    getPreferences(), getNotes(), getBookmarkNotes(), getStars(), getSnoozed(), chrome.bookmarks ? getArchived().catch(() => []) : [],
    chrome.bookmarks ? chrome.bookmarks.getTree().catch(() => []) : [],
  ]);
  const { iconTips, ...settings } = preferences; // (a counter, not a setting)
  // bookmarks as a tree of titles (ids are this computer's own); the notes on them by their address and folders
  const marks = [], bookmarkNoteList = [];
  const walk = (node, path) => {
    if (node.url) {
      const note = bookmarkNotes[node.id];
      if (note && note.n) bookmarkNoteList.push({ url: node.url, title: node.title || '', path, note: note.n, t: note.t });
      return { title: node.title || '', url: node.url };
    }
    return { title: node.title || '', ...(node.folderType ? { type: node.folderType } : {}), children: (node.children || []).map((child) => walk(child, [...path, node.title || ''])) };
  };
  for (const top of (tree[0] && tree[0].children) || []) marks.push({ ...walk(top, []), type: folderTypeOf(top) || undefined });
  const data = {
    settings,
    notes: Object.values(notes).map((x) => ({ url: x.u, note: x.n, t: x.t })),
    'bookmark-notes': bookmarkNoteList,
    stars: Object.values(stars).map((x) => ({ url: x.u, title: x.ti, t: x.t })),
    bookmarks: marks,
    archive: archived.map((x) => ({ url: x.url, title: x.title, t: x.t })),
    snoozed: snoozed.map((x) => ({ url: x.url, title: x.title, at: x.at, pinned: x.pinned, group: x.group })),
  };
  const info = { app: 'Tabazing', version, made: new Date().toISOString(), files: Object.keys(data).map((key) => key + '.json') };
  const files = [{ name: `${BACKUP_DIRECTORY}/info.json`, data: JSON.stringify(info, null, 2) }];
  for (const [key, value] of Object.entries(data)) files.push({ name: `${BACKUP_DIRECTORY}/${key}.json`, data: JSON.stringify(value, null, 2) });
  const counts = { notes: data.notes.length, bookmarkNotes: bookmarkNoteList.length, stars: data.stars.length, archive: data.archive.length, snoozed: data.snoozed.length, bookmarks: 0 };
  const count = (node) => { for (const child of node.children || []) { if (child.url) counts.bookmarks++; else count(child); } };
  marks.forEach(count);
  return { files, counts };
}

// ---------------------------------------------------------------- restore
const empty = () => ({ added: 0, updated: 0, skipped: 0 });
/**
 * Add a backup's data to what is here (readBackup's output). Resolves to what happened, per kind:
 * { bookmarks, folders, archive, notes, bmNotes, stars, snoozed: { added, updated, skipped }, settings: boolean }.
 */
// One restore at a time, in every Tabazing page: two at once would each find the other's bookmarks missing and make
// them too (a second Backup & Restore dialog, or another window's, waits for the first). Its own queue where there
// are no Web Locks: store.js's single queue would have it wait for the merges it starts itself.
let restoring = Promise.resolve();
export function restoreBackup(backup, options = {}) {
  if (globalThis.navigator && navigator.locks) return navigator.locks.request('tabazing:restore', () => restore(backup, options));
  const run = restoring.then(() => restore(backup, options));
  restoring = run.catch(() => {});
  return run;
}
async function restore(backup, { settings = false, now = Date.now() } = {}) {
  const report = { bookmarks: empty(), folders: empty(), archive: empty(), notes: empty(), bookmarkNotes: empty(), stars: empty(), snoozed: empty(), settings: false };
  const list = (key) => (Array.isArray(backup[key]) ? backup[key] : []);
  // ---- bookmarks and folders
  // Every bookmark here and each one made, by its address as Chrome keeps it (so "#inbox" and "#sent" are two):
  // { id, top, rel (the folder names under its top folder), used (it stands for one of the backup's) }.
  const marks = new Map();
  const keep = (id, url, top, folderPath) => { const canonicalUrl = canonical(url), mark = { id, top, relativePath: folderPath.join('\u0000'), used: false }; if (!marks.has(canonicalUrl)) marks.set(canonicalUrl, []); marks.get(canonicalUrl).push(mark); return mark; };
  const marksOf = (url) => marks.get(canonical(url)) || [];
  let tops = [];
  if (chrome.bookmarks) {
    const tree = await chrome.bookmarks.getTree();
    tops = (tree[0] && tree[0].children) || [];
    const walk = (node, top, folderPath) => { for (const child of node.children || []) { if (child.url) keep(child.id, child.url, top, folderPath); else walk(child, top, [...folderPath, child.title || '']); } };
    for (const top of tops) walk(top, top.id, []);
    // The browser's own folders (the bookmarks bar, Other bookmarks, Mobile; Firefox's Bookmarks Menu): by their kind,
    // else their name, else Other (a backup from Firefox restored in Chrome: its menu's bookmarks go into Other bookmarks).
    // Managed bookmarks (set by an organization) are Chrome's to keep: never copied.
    const other = topFolder(tops, 'other') || tops[1] || tops[0];
    const topFor = (item) => (item.type && topFolder(tops, item.type))
      || tops.find((folder) => folder.title === item.title) || other;
    // The backup's bookmarks and folders in order, each with its place: { url, title, top, rel } or { folder, top, rel, empty }.
    const plan = [];
    const countMarks = (items) => (Array.isArray(items) ? items : []).reduce((total, it) => total + (!it || typeof it !== 'object' ? 0 : it.url !== undefined ? 1 : countMarks(it.children)), 0);
    const collect = (items, top, folderPath) => {
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it !== 'object') continue;
        if (it.url !== undefined) {
          if (isUrlAllowed(it.url)) plan.push({ url: it.url, title: text(it.title, 2000), top, relativePath: folderPath });
          else report.bookmarks.skipped++;
        } else if (Array.isArray(it.children)) {
          if (folderPath.length >= MAX_DEPTH) { report.bookmarks.skipped += countMarks(it.children); continue; } // (deeper than any real tree)
          const path = [...folderPath, text(it.title, 2000)];
          plan.push({ folder: true, top, relativePath: path, empty: !it.children.length });
          collect(it.children, top, path);
        }
      }
    };
    for (const topEntry of list('bookmarks')) {
      if (!topEntry || !Array.isArray(topEntry.children)) continue;
      if (topEntry.type === 'managed' || !topFor(topEntry)) { report.bookmarks.skipped += countMarks(topEntry.children); continue; }
      collect(topEntry.children, topFor(topEntry).id, []);
    }
    // Which are here already: first one of that address in that same folder, then one anywhere (moved since). Each
    // bookmark here stands for one of the backup's: a page kept in two folders comes back in both.
    const marked = plan.filter((x) => !x.folder);
    for (const x of marked) { const match = marksOf(x.url).find((candidate) => !candidate.used && candidate.top === x.top && candidate.relativePath === x.relativePath.join('\u0000')); if (match) { match.used = true; x.at = match; } }
    for (const x of marked) if (!x.at) { const match = marksOf(x.url).find((candidate) => !candidate.used); if (match) { match.used = true; x.at = match; } }
    // The rest is made, in order. A folder is the one there of that name in that place, else made, and only when
    // something goes in it (or it is empty in the backup too): a folder moved since doesn't come back empty.
    const folderIds = new Map(); // top + names -> id
    const folderFor = async (top, folderPath) => {
      let id = top, key = top;
      for (const name of folderPath) {
        key += '\u0000' + name;
        let next = folderIds.get(key);
        if (!next) {
          const there = (await chrome.bookmarks.getChildren(id).catch(() => [])).find((child) => !child.url && child.title === name);
          if (there) next = there.id;
          else {
            try { next = (await chrome.bookmarks.create({ parentId: id, title: name })).id; } catch { return null; }
            report.folders.added++;
          }
          folderIds.set(key, next);
        }
        id = next;
      }
      return id;
    };
    for (const x of plan) {
      if (x.folder) { if (x.empty) await folderFor(x.top, x.relativePath); continue; }
      if (x.at) { report.bookmarks.skipped++; continue; } // bookmarked already: no duplicate
      const parentId = await folderFor(x.top, x.relativePath);
      let made = null;
      if (parentId) try { made = await chrome.bookmarks.create({ parentId, title: x.title, url: x.url }); } catch { /* one Chrome refuses: left out */ }
      if (!made) { report.bookmarks.skipped++; continue; }
      x.at = keep(made.id, made.url || x.url, x.top, x.relativePath);
      x.at.used = true;
      report.bookmarks.added++;
    }
    report.folders.skipped = Math.max(0, plan.filter((x) => x.folder).length - report.folders.added);
    // ---- the archive (pages not bookmarked anywhere yet)
    const fresh = [];
    for (const page of list('archive')) {
      if (!page || !isUrlAllowed(page.url) || marksOf(page.url).length || fresh.some((entry) => canonical(entry.url) === canonical(page.url))) { report.archive.skipped++; continue; }
      fresh.push({ url: page.url, title: text(page.title, 2000) });
    }
    if (fresh.length) {
      const made = await addArchived(fresh);
      for (const created of made) keep(created.id, created.url, null, []);
      report.archive.added += made.length;
      report.archive.skipped += fresh.length - made.length;
    }
    // ---- notes on bookmarks: on the bookmark of that address in that folder, else one of that address anywhere;
    // never two of the backup's notes on one bookmark
    const changes = {};
    for (const x of list('bookmark-notes')) {
      if (!x || !isUrlAllowed(x.url) || typeof x.note !== 'string' || !x.note.trim()) { report.bookmarkNotes.skipped++; continue; }
      const path = Array.isArray(x.path) ? x.path.map(String) : null;
      const top = path && (tops.find((folder) => folder.title === path[0]) || {}).id;
      const relativePath = path && path.slice(1).join('\u0000');
      const free = marksOf(x.url).filter((mark) => !changes[mark.id]);
      const target = free.find((mark) => path && mark.relativePath === relativePath && mark.top === top) || free.find((mark) => path && mark.relativePath === relativePath) || free[0];
      if (!target) { report.bookmarkNotes.skipped++; continue; }
      changes[target.id] = { n: text(x.note), u: x.url, t: x.t };
    }
    const result = await mergeBookmarkNotes(changes);
    report.bookmarkNotes.added += result.added; report.bookmarkNotes.updated += result.updated; report.bookmarkNotes.skipped += result.skipped;
  } else {
    report.bookmarks.skipped += list('bookmarks').reduce((total, topEntry) => total + (topEntry && Array.isArray(topEntry.children) ? topEntry.children.length : 0), 0);
  }
  // ---- notes on pages, stars, snoozed tabs (an entry that isn't one counts as left out)
  const merge = async (kind, items, ok, mergeItems) => {
    const good = items.filter(ok);
    Object.assign(report[kind], await mergeItems(good));
    report[kind].skipped += items.length - good.length;
  };
  const when = (time) => (Number.isFinite(time) && time > 0 && time <= now ? time : now);
  await merge('notes', list('notes'), (x) => x && isUrlAllowed(x.url) && typeof x.note === 'string',
    (good) => mergeNotes(good.map((x) => ({ url: x.url, note: x.note, t: when(x.t) }))));
  await merge('stars', list('stars'), (x) => x && isUrlAllowed(x.url),
    (good) => mergeStars(good.map((x) => ({ url: x.url, title: text(x.title, 300), t: when(x.t) }))));
  await merge('snoozed', list('snoozed'), (x) => x && isUrlAllowed(x.url) && Number.isFinite(x.at) && x.at > now, // (one whose time has passed: left out)
    (good) => mergeSnoozed(good.map((x, i) => ({ id: `r${now.toString(36)}-${i}`, url: x.url, title: text(x.title, 300), at: x.at, windowId: null, pinned: x.pinned === true, t: now, group: x.group || null }))));
  // ---- settings, only when asked: the ones the backup has a valid value for (another is left as it is)
  if (settings && backup.settings && typeof backup.settings === 'object' && !Array.isArray(backup.settings)) {
    const patch = validPreferences(backup.settings);
    delete patch.iconTips;
    await updatePreferences(patch);
    report.settings = true;
  }
  return report;
}
export { ARCHIVE_FOLDER };
