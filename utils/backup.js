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
//   - bookmarks: a folder is the existing one of the same name in the same place, else made; a bookmark whose
//     address is bookmarked anywhere already is skipped (no duplicates), else made in its folder;
//   - archive: a page not bookmarked anywhere goes into the archive folder;
//   - notes on pages and on bookmarks: the backup's note goes on the page / bookmark, over the one there (the only
//     thing a restore replaces); a bookmark's note is put on the bookmark of that address in that folder, or else on
//     one of that address anywhere;
//   - stars and snoozed tabs: added when the page has none yet; a snooze whose time has passed is left out (it would
//     open at once);
//   - settings: only with `settings: true`.
// The caps on stars, notes and snoozed tabs never drop anything that is there: what doesn't fit is left out.
import { mergeStars, mergeNotes, mergeBmNotes, mergeSnoozed, getStars, getNotes, getBmNotes, getSnoozed, getPrefs, updatePrefs } from './store.js';
import { getArchived, addArchived, ARCHIVE_FOLDER } from './archive.js';
import { normalizeUrl } from './ext.js';

export const BACKUP_DIR = 'backup';
export const BACKUP_FILES = ['info', 'settings', 'notes', 'bookmark-notes', 'stars', 'bookmarks', 'archive', 'snoozed'];
const MAX_FILE = 50 * 1024 * 1024; // a backup file bigger than this isn't one of ours
const urlOk = (u) => typeof u === 'string' && u.length > 0 && u.length <= 8192 && /^[a-z][\w+.-]*:/i.test(u);
const text = (s, max = 1000) => (typeof s === 'string' ? s.slice(0, max) : '');
const keyOf = (u) => normalizeUrl(u) || u;
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const backupName = (d = new Date()) => `tabazing-backup-${day(d)}`;

// ---------------------------------------------------------------- zip (stored or deflated entries)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** A zip of these files ([{ name, data }]: data a string or bytes), stored (not compressed: JSON is small). */
export function zipFiles(files, when = new Date()) {
  const enc = new TextEncoder();
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
async function inflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** The files of a zip: Map(name -> text). Stored and deflated entries (a zip made again by the system's own tool). */
export async function unzipFiles(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip');
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const dec = new TextDecoder();
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('bad zip');
    const method = v.getUint16(at + 10, true), size = v.getUint32(at + 20, true), nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true), commentLen = v.getUint16(at + 32, true), local = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || size > MAX_FILE) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    const data = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
    if (data) out.set(name, dec.decode(data));
  }
  return out;
}
/** The backup's JSON files by kind ({ notes: [...], ... }) from a Map(path -> text): the zip's, or a chosen folder's. */
export function readBackup(files) {
  const out = {};
  for (const [path, body] of files) {
    const m = /(?:^|\/)([\w-]+)\.json$/.exec(path.replace(/\\/g, '/'));
    if (!m || !BACKUP_FILES.includes(m[1]) || body.length > MAX_FILE) continue;
    try { out[m[1]] = JSON.parse(body); } catch { /* a broken file is left out */ }
  }
  if (!Object.keys(out).some((k) => k !== 'info')) throw new Error('no backup files');
  return out;
}

// ---------------------------------------------------------------- export
/** Everything Tabazing keeps, as the backup's files ([{ name, data }], their paths in the zip). */
export async function makeBackup({ version = '' } = {}) {
  const [prefs, notes, bmNotes, stars, snoozed, archived, tree] = await Promise.all([
    getPrefs(), getNotes(), getBmNotes(), getStars(), getSnoozed(), chrome.bookmarks ? getArchived().catch(() => []) : [],
    chrome.bookmarks ? chrome.bookmarks.getTree().catch(() => []) : [],
  ]);
  const { iconTips, ...settings } = prefs; // (a counter, not a setting)
  // bookmarks as a tree of titles (ids are this computer's own); the notes on them by their address and folders
  const marks = [], bmList = [];
  const walk = (n, path) => {
    if (n.url) {
      const note = bmNotes[n.id];
      if (note && note.n) bmList.push({ url: n.url, title: n.title || '', path, note: note.n, t: note.t });
      return { title: n.title || '', url: n.url };
    }
    return { title: n.title || '', ...(n.folderType ? { type: n.folderType } : {}), children: (n.children || []).map((c) => walk(c, [...path, n.title || ''])) };
  };
  for (const top of (tree[0] && tree[0].children) || []) marks.push({ ...walk(top, []), type: top.folderType || (top.id === '1' ? 'bookmarks-bar' : top.id === '2' ? 'other' : top.id === '3' ? 'mobile' : undefined) });
  const data = {
    settings,
    notes: Object.values(notes).map((x) => ({ url: x.u, note: x.n, t: x.t })),
    'bookmark-notes': bmList,
    stars: Object.values(stars).map((x) => ({ url: x.u, title: x.ti, t: x.t })),
    bookmarks: marks,
    archive: archived.map((x) => ({ url: x.url, title: x.title, t: x.t })),
    snoozed: snoozed.map((x) => ({ url: x.url, title: x.title, at: x.at, pinned: x.pinned, group: x.group })),
  };
  const info = { app: 'Tabazing', version, made: new Date().toISOString(), files: Object.keys(data).map((k) => k + '.json') };
  const files = [{ name: `${BACKUP_DIR}/info.json`, data: JSON.stringify(info, null, 2) }];
  for (const [k, v] of Object.entries(data)) files.push({ name: `${BACKUP_DIR}/${k}.json`, data: JSON.stringify(v, null, 2) });
  const counts = { notes: data.notes.length, bmNotes: bmList.length, stars: data.stars.length, archive: data.archive.length, snoozed: data.snoozed.length, bookmarks: 0 };
  const count = (n) => { for (const c of n.children || []) { if (c.url) counts.bookmarks++; else count(c); } };
  marks.forEach(count);
  return { files, counts };
}

// ---------------------------------------------------------------- restore
const empty = () => ({ added: 0, updated: 0, skipped: 0 });
/**
 * Add a backup's data to what is here (readBackup's output). Resolves to what happened, per kind:
 * { bookmarks, folders, archive, notes, bmNotes, stars, snoozed: { added, updated, skipped }, settings: boolean }.
 */
export async function restoreBackup(b, { settings = false, now = Date.now() } = {}) {
  const report = { bookmarks: empty(), folders: empty(), archive: empty(), notes: empty(), bmNotes: empty(), stars: empty(), snoozed: empty(), settings: false };
  const list = (k) => (Array.isArray(b[k]) ? b[k] : []);
  // ---- bookmarks and folders
  const where = new Map(); // normalized address -> [{ id, parentId }]
  const remember = (n, parentId) => { const k = keyOf(n.url); if (!where.has(k)) where.set(k, []); where.get(k).push({ id: n.id, parentId }); };
  let tops = [];
  if (chrome.bookmarks) {
    const tree = await chrome.bookmarks.getTree();
    const walk = (n) => { for (const c of n.children || []) { if (c.url) remember(c, n.id); else walk(c); } };
    tops = (tree[0] && tree[0].children) || [];
    tops.forEach(walk);
    const kids = async (id) => chrome.bookmarks.getChildren(id).catch(() => []);
    const into = async (folderId, items, depth) => {
      if (depth > 40) return;
      let here = await kids(folderId);
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it !== 'object') continue;
        if (it.url !== undefined) {
          if (!urlOk(it.url)) { report.bookmarks.skipped++; continue; }
          if (where.has(keyOf(it.url))) { report.bookmarks.skipped++; continue; } // bookmarked already: no duplicate
          const made = await chrome.bookmarks.create({ parentId: folderId, title: text(it.title, 2000), url: it.url });
          remember(made, folderId);
          report.bookmarks.added++;
        } else if (Array.isArray(it.children)) {
          const title = text(it.title, 2000);
          let folder = here.find((c) => !c.url && c.title === title);
          if (folder) report.folders.skipped++;
          else { folder = await chrome.bookmarks.create({ parentId: folderId, title }); here = await kids(folderId); report.folders.added++; }
          await into(folder.id, it.children, depth + 1);
        }
      }
    };
    // Chrome's own folders (the bookmarks bar, Other bookmarks, Mobile): by their kind, else their name, else Other.
    const other = tops.find((n) => n.folderType === 'other') || tops.find((n) => n.id === '2') || tops[1] || tops[0];
    const topFor = (t) => tops.find((n) => t.type && (n.folderType === t.type || (t.type === 'bookmarks-bar' && n.id === '1') || (t.type === 'other' && n.id === '2') || (t.type === 'mobile' && n.id === '3')))
      || tops.find((n) => n.title === t.title) || other;
    for (const t of list('bookmarks')) if (t && Array.isArray(t.children) && topFor(t)) await into(topFor(t).id, t.children, 0);
    // ---- the archive (pages not bookmarked anywhere yet)
    const pages = list('archive').filter((x) => x && urlOk(x.url));
    const fresh = [];
    for (const p of pages) {
      if (where.has(keyOf(p.url)) || fresh.some((f) => keyOf(f.url) === keyOf(p.url))) { report.archive.skipped++; continue; }
      fresh.push({ url: p.url, title: text(p.title, 2000) });
    }
    if (fresh.length) {
      const made = await addArchived(fresh);
      for (const m of made) remember({ id: m.id, url: m.url }, null);
      report.archive.added += made.length;
    }
    // ---- notes on bookmarks: on the bookmark of that address in that folder, else one of that address anywhere
    const pathOf = async (parentId) => {
      const names = [];
      for (let id = parentId, k = 0; id && k < 50; k++) {
        const [n] = await chrome.bookmarks.get(id).catch(() => []);
        if (!n || n.parentId === undefined || n.id === '0') break;
        names.unshift(n.title || '');
        id = n.parentId;
      }
      return names;
    };
    const changes = {};
    for (const x of list('bookmark-notes')) {
      if (!x || !urlOk(x.url) || typeof x.note !== 'string' || !x.note.trim()) { report.bmNotes.skipped++; continue; }
      const there = where.get(keyOf(x.url)) || [];
      if (!there.length) { report.bmNotes.skipped++; continue; }
      let target = there[0];
      if (Array.isArray(x.path) && there.length > 1) {
        for (const c of there) if (c.parentId && (await pathOf(c.parentId)).join('\u0000') === x.path.map(String).join('\u0000')) { target = c; break; }
      }
      changes[target.id] = { n: text(x.note), u: x.url };
    }
    const bm = await mergeBmNotes(changes);
    report.bmNotes.added += bm.added; report.bmNotes.updated += bm.updated; report.bmNotes.skipped += bm.skipped;
  } else {
    report.bookmarks.skipped += list('bookmarks').length;
  }
  // ---- notes on pages, stars, snoozed tabs
  const n = await mergeNotes(list('notes').filter((x) => x && urlOk(x.url) && typeof x.note === 'string').map((x) => ({ url: x.url, note: x.note })));
  Object.assign(report.notes, n);
  const s = await mergeStars(list('stars').filter((x) => x && urlOk(x.url)).map((x) => ({ url: x.url, title: text(x.title, 300), t: Number.isFinite(x.t) ? x.t : now })));
  Object.assign(report.stars, s);
  const due = list('snoozed').filter((x) => x && urlOk(x.url) && Number.isFinite(x.at));
  const later = due.filter((x) => x.at > now);
  const z = await mergeSnoozed(later.map((x, i) => ({ id: `r${now.toString(36)}-${i}`, url: x.url, title: text(x.title, 300), at: x.at, windowId: null, pinned: x.pinned === true, t: now, group: x.group || null })));
  Object.assign(report.snoozed, z);
  report.snoozed.skipped += due.length - later.length; // (their time has passed)
  // ---- settings, only when asked
  if (settings && b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings)) {
    const known = Object.keys(await getPrefs()).filter((k) => k !== 'iconTips');
    const patch = Object.fromEntries(Object.entries(b.settings).filter(([k]) => known.includes(k)));
    await updatePrefs(patch);
    report.settings = true;
  }
  return report;
}
export { ARCHIVE_FOLDER };
