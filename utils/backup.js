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
import { mergeStars, mergeNotes, mergeBmNotes, mergeSnoozed, getStars, getNotes, getBmNotes, getSnoozed, getPrefs, updatePrefs, validPrefs } from './store.js';
import { getArchived, addArchived, ARCHIVE_FOLDER } from './archive.js';

export const BACKUP_DIR = 'backup';
export const BACKUP_FILES = ['info', 'settings', 'notes', 'bookmark-notes', 'stars', 'bookmarks', 'archive', 'snoozed'];
const MAX_FILE = 50 * 1024 * 1024; // a backup file bigger than this isn't one of ours
const MAX_DEPTH = 100; // folders in folders: deeper than this isn't a real bookmarks tree
const urlOk = (u) => typeof u === 'string' && u.length > 0 && u.length <= 8192 && /^[a-z][\w+.-]*:/i.test(u);
const text = (s, max = 1000) => (typeof s === 'string' ? s.slice(0, max) : '');
const canon = (u) => { try { return new URL(u).href; } catch { return u; } }; // as Chrome keeps it ("https://x.com" is "https://x.com/")
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
/**
 * The backup's JSON files by kind ({ notes: [...], ... }) from a Map(path -> text): the zip's, or a chosen folder's.
 * They are one folder's files: a folder holding several backups gives the newest one (by its info.json, else the
 * name that sorts last: tabazing-backup-<date>), never a mix of them; a folder named "backup" before any other.
 */
export function readBackup(files) {
  const dirs = new Map(); // folder ("" or "…/") -> { kind: data }
  for (const [path, body] of files) {
    const m = /^(.*\/)?([\w-]+)\.json$/.exec(path.replace(/\\/g, '/'));
    if (!m || !BACKUP_FILES.includes(m[2]) || body.length > MAX_FILE) continue;
    let data;
    try { data = JSON.parse(body); } catch { continue; } // a broken file is left out
    const dir = m[1] || '';
    if (!dirs.has(dir)) dirs.set(dir, {});
    dirs.get(dir)[m[2]] = data;
  }
  const made = (d) => { const t = Date.parse(d.info && d.info.made); return Number.isFinite(t) ? t : 0; };
  const named = (dir) => /(?:^|\/)backup\/$/.test(dir);
  const found = [...dirs].filter(([, d]) => Object.keys(d).some((k) => k !== 'info'))
    .sort(([a, x], [b, y]) => named(a) - named(b) || made(x) - made(y) || (a < b ? -1 : a > b ? 1 : 0));
  if (!found.length) throw new Error('no backup files');
  return found[found.length - 1][1];
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
// One restore at a time, in every Tabazing page: two at once would each find the other's bookmarks missing and make
// them too (a second Backup & Restore dialog, or another window's, waits for the first). Its own queue where there
// are no Web Locks: store.js's single queue would have it wait for the merges it starts itself.
let restoring = Promise.resolve();
export function restoreBackup(b, opts = {}) {
  if (globalThis.navigator && navigator.locks) return navigator.locks.request('tabazing:restore', () => restore(b, opts));
  const run = restoring.then(() => restore(b, opts));
  restoring = run.catch(() => {});
  return run;
}
async function restore(b, { settings = false, now = Date.now() } = {}) {
  const report = { bookmarks: empty(), folders: empty(), archive: empty(), notes: empty(), bmNotes: empty(), stars: empty(), snoozed: empty(), settings: false };
  const list = (k) => (Array.isArray(b[k]) ? b[k] : []);
  // ---- bookmarks and folders
  // Every bookmark here and each one made, by its address as Chrome keeps it (so "#inbox" and "#sent" are two):
  // { id, top, rel (the folder names under its top folder), used (it stands for one of the backup's) }.
  const marks = new Map();
  const keep = (id, url, top, rel) => { const k = canon(url), m = { id, top, rel: rel.join('\u0000'), used: false }; if (!marks.has(k)) marks.set(k, []); marks.get(k).push(m); return m; };
  const marksOf = (url) => marks.get(canon(url)) || [];
  let tops = [];
  if (chrome.bookmarks) {
    const tree = await chrome.bookmarks.getTree();
    tops = (tree[0] && tree[0].children) || [];
    const walk = (n, top, rel) => { for (const c of n.children || []) { if (c.url) keep(c.id, c.url, top, rel); else walk(c, top, [...rel, c.title || '']); } };
    for (const top of tops) walk(top, top.id, []);
    // Chrome's own folders (the bookmarks bar, Other bookmarks, Mobile): by their kind, else their name, else Other.
    // Managed bookmarks (set by an organization) are Chrome's to keep: never copied.
    const other = tops.find((n) => n.folderType === 'other') || tops.find((n) => n.id === '2') || tops[1] || tops[0];
    const topFor = (t) => tops.find((n) => t.type && (n.folderType === t.type || (t.type === 'bookmarks-bar' && n.id === '1') || (t.type === 'other' && n.id === '2') || (t.type === 'mobile' && n.id === '3')))
      || tops.find((n) => n.title === t.title) || other;
    // The backup's bookmarks and folders in order, each with its place: { url, title, top, rel } or { folder, top, rel, empty }.
    const plan = [];
    const countMarks = (items) => (Array.isArray(items) ? items : []).reduce((n, it) => n + (!it || typeof it !== 'object' ? 0 : it.url !== undefined ? 1 : countMarks(it.children)), 0);
    const collect = (items, top, rel) => {
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it !== 'object') continue;
        if (it.url !== undefined) {
          if (urlOk(it.url)) plan.push({ url: it.url, title: text(it.title, 2000), top, rel });
          else report.bookmarks.skipped++;
        } else if (Array.isArray(it.children)) {
          if (rel.length >= MAX_DEPTH) { report.bookmarks.skipped += countMarks(it.children); continue; } // (deeper than any real tree)
          const path = [...rel, text(it.title, 2000)];
          plan.push({ folder: true, top, rel: path, empty: !it.children.length });
          collect(it.children, top, path);
        }
      }
    };
    for (const t of list('bookmarks')) {
      if (!t || !Array.isArray(t.children)) continue;
      if (t.type === 'managed' || !topFor(t)) { report.bookmarks.skipped += countMarks(t.children); continue; }
      collect(t.children, topFor(t).id, []);
    }
    // Which are here already: first one of that address in that same folder, then one anywhere (moved since). Each
    // bookmark here stands for one of the backup's: a page kept in two folders comes back in both.
    const marked = plan.filter((x) => !x.folder);
    for (const x of marked) { const m = marksOf(x.url).find((m) => !m.used && m.top === x.top && m.rel === x.rel.join('\u0000')); if (m) { m.used = true; x.at = m; } }
    for (const x of marked) if (!x.at) { const m = marksOf(x.url).find((m) => !m.used); if (m) { m.used = true; x.at = m; } }
    // The rest is made, in order. A folder is the one there of that name in that place, else made, and only when
    // something goes in it (or it is empty in the backup too): a folder moved since doesn't come back empty.
    const folderIds = new Map(); // top + names -> id
    const folderFor = async (top, rel) => {
      let id = top, key = top;
      for (const name of rel) {
        key += '\u0000' + name;
        let next = folderIds.get(key);
        if (!next) {
          const there = (await chrome.bookmarks.getChildren(id).catch(() => [])).find((c) => !c.url && c.title === name);
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
      if (x.folder) { if (x.empty) await folderFor(x.top, x.rel); continue; }
      if (x.at) { report.bookmarks.skipped++; continue; } // bookmarked already: no duplicate
      const parentId = await folderFor(x.top, x.rel);
      let made = null;
      if (parentId) try { made = await chrome.bookmarks.create({ parentId, title: x.title, url: x.url }); } catch { /* one Chrome refuses: left out */ }
      if (!made) { report.bookmarks.skipped++; continue; }
      x.at = keep(made.id, made.url || x.url, x.top, x.rel);
      x.at.used = true;
      report.bookmarks.added++;
    }
    report.folders.skipped = Math.max(0, plan.filter((x) => x.folder).length - report.folders.added);
    // ---- the archive (pages not bookmarked anywhere yet)
    const fresh = [];
    for (const p of list('archive')) {
      if (!p || !urlOk(p.url) || marksOf(p.url).length || fresh.some((f) => canon(f.url) === canon(p.url))) { report.archive.skipped++; continue; }
      fresh.push({ url: p.url, title: text(p.title, 2000) });
    }
    if (fresh.length) {
      const made = await addArchived(fresh);
      for (const m of made) keep(m.id, m.url, null, []);
      report.archive.added += made.length;
      report.archive.skipped += fresh.length - made.length;
    }
    // ---- notes on bookmarks: on the bookmark of that address in that folder, else one of that address anywhere;
    // never two of the backup's notes on one bookmark
    const changes = {};
    for (const x of list('bookmark-notes')) {
      if (!x || !urlOk(x.url) || typeof x.note !== 'string' || !x.note.trim()) { report.bmNotes.skipped++; continue; }
      const path = Array.isArray(x.path) ? x.path.map(String) : null;
      const top = path && (tops.find((n) => n.title === path[0]) || {}).id;
      const rel = path && path.slice(1).join('\u0000');
      const free = marksOf(x.url).filter((m) => !changes[m.id]);
      const target = free.find((m) => path && m.rel === rel && m.top === top) || free.find((m) => path && m.rel === rel) || free[0];
      if (!target) { report.bmNotes.skipped++; continue; }
      changes[target.id] = { n: text(x.note), u: x.url, t: x.t };
    }
    const bm = await mergeBmNotes(changes);
    report.bmNotes.added += bm.added; report.bmNotes.updated += bm.updated; report.bmNotes.skipped += bm.skipped;
  } else {
    report.bookmarks.skipped += list('bookmarks').reduce((n, t) => n + (t && Array.isArray(t.children) ? t.children.length : 0), 0);
  }
  // ---- notes on pages, stars, snoozed tabs (an entry that isn't one counts as left out)
  const merge = async (kind, items, ok, fn) => {
    const good = items.filter(ok);
    Object.assign(report[kind], await fn(good));
    report[kind].skipped += items.length - good.length;
  };
  const when = (t) => (Number.isFinite(t) && t > 0 && t <= now ? t : now);
  await merge('notes', list('notes'), (x) => x && urlOk(x.url) && typeof x.note === 'string',
    (good) => mergeNotes(good.map((x) => ({ url: x.url, note: x.note, t: when(x.t) }))));
  await merge('stars', list('stars'), (x) => x && urlOk(x.url),
    (good) => mergeStars(good.map((x) => ({ url: x.url, title: text(x.title, 300), t: when(x.t) }))));
  await merge('snoozed', list('snoozed'), (x) => x && urlOk(x.url) && Number.isFinite(x.at) && x.at > now, // (one whose time has passed: left out)
    (good) => mergeSnoozed(good.map((x, i) => ({ id: `r${now.toString(36)}-${i}`, url: x.url, title: text(x.title, 300), at: x.at, windowId: null, pinned: x.pinned === true, t: now, group: x.group || null }))));
  // ---- settings, only when asked: the ones the backup has a valid value for (another is left as it is)
  if (settings && b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings)) {
    const patch = validPrefs(b.settings);
    delete patch.iconTips;
    await updatePrefs(patch);
    report.settings = true;
  }
  return report;
}
export { ARCHIVE_FOLDER };
