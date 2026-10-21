// Backup & Restore (utils/backup.js): the zip (made and read back, stored or deflated), the backup's files, and above
// all the restore's promise: nothing that is there is ever deleted, nothing is ever made twice, a backup's notes go on
// the same pages and bookmarks (over the ones there), and restoring the same backup again changes nothing.
import { describe, it, expect, beforeEach } from 'vitest';
import { LIMITS } from '../../utils/constants.js';

const L = chrome.storage.local;
const NOW = Date.now();
let b, store;
beforeEach(async () => {
  b = await import('../../utils/backup.js');
  store = await import('../../utils/store.js');
});

// ---- a profile: bookmarks (bar: Docs, Work/[Wiki]; other: Recipes, the archive [Kept]), notes, stars, snoozed tabs
function seedProfile() {
  const docs = chrome._addBookmark({ parentId: '1', title: 'Docs', url: 'https://docs.example/' });
  const work = chrome._addBookmark({ parentId: '1', title: 'Work' });
  const wiki = chrome._addBookmark({ parentId: work.id, title: 'Wiki', url: 'https://wiki.example/' });
  const recipes = chrome._addBookmark({ parentId: '2', title: 'Recipes', url: 'https://food.example/' });
  const arch = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
  const kept = chrome._addBookmark({ parentId: arch.id, title: 'Kept', url: 'https://kept.example/' });
  return { docs, work, wiki, recipes, arch, kept };
}
async function seedData(m) {
  await L.set({
    notes: { 'https://note.example/': { u: 'https://note.example/', n: 'tab note', t: NOW } },
    bmNotes: { [m.wiki.id]: { u: 'https://wiki.example/', n: 'wiki note', t: NOW } },
    stars: { 'https://star.example/': { u: 'https://star.example/', ti: 'Star', t: NOW } },
    snoozed: [{ id: 's1', url: 'https://later.example/', title: 'Later', at: NOW + 864e5, windowId: 1, pinned: false, t: NOW, group: null }],
    prefs: { theme: 'light', accent: '#F87171', cardSize: 'small' },
  });
}
// Every bookmark: "path > title url", sorted (the tree as text, to compare).
function allMarks() {
  const out = [];
  const walk = (n, path) => { for (const c of n.children || []) { if (c.url) out.push([...path, c.title].join(' > ') + ' ' + c.url); else walk(c, [...path, c.title]); } };
  walk(chrome._data.bookmarks, []);
  return out.sort();
}
const folders = () => { const out = []; const walk = (n, path) => { for (const c of n.children || []) if (!c.url) { out.push([...path, c.title].join(' > ')); walk(c, [...path, c.title]); } }; walk(chrome._data.bookmarks, []); return out.sort(); };
const asFiles = (files) => new Map(files.map((f) => [f.name, typeof f.data === 'string' ? f.data : new TextDecoder().decode(f.data)]));
async function backupOfProfile() {
  const m = seedProfile();
  await seedData(m);
  const { files } = await b.makeBackup({ version: '9.9.9' });
  return { m, files, data: b.readBackup(asFiles(files)) };
}
// A fresh profile (Chrome's own empty folders and nothing stored), as on another computer.
function freshProfile() { chrome._reset(); }

describe('the zip', () => {
  it('crc32 is the standard one', () => {
    expect(b.crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('what zipFiles makes, unzipFiles reads back (UTF-8 names and text)', async () => {
    const zip = b.zipFiles([{ name: 'backup/notes.json', data: '[{"note":"ünïcode — ok"}]' }, { name: 'backup/stars.json', data: '[]' }]);
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]); // "PK"
    const back = await b.unzipFiles(zip);
    expect([...back.keys()]).toEqual(['backup/notes.json', 'backup/stars.json']);
    expect(back.get('backup/notes.json')).toBe('[{"note":"ünïcode — ok"}]');
  });

  it('reads a deflated zip too (made again by the system\'s own zip tool)', async () => {
    const text = JSON.stringify({ a: 'x'.repeat(2000) });
    const raw = new TextEncoder().encode(text);
    const deflated = new Uint8Array(await new Response(new Response(raw).body.pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    // a stored zip, then its one entry rewritten as deflated (method 8, the compressed size)
    const stored = b.zipFiles([{ name: 'backup/info.json', data: text }]);
    const name = new TextEncoder().encode('backup/info.json');
    const crc = b.crc32(raw);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, 8, true); local.setUint32(14, crc, true);
    local.setUint32(18, deflated.length, true); local.setUint32(22, raw.length, true); local.setUint16(26, name.length, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(10, 8, true); cen.setUint32(16, crc, true); cen.setUint32(20, deflated.length, true);
    cen.setUint32(24, raw.length, true); cen.setUint16(28, name.length, true); cen.setUint32(42, 0, true);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true);
    end.setUint32(12, 46 + name.length, true); end.setUint32(16, 30 + name.length + deflated.length, true);
    const parts = [new Uint8Array(local.buffer), name, deflated, new Uint8Array(cen.buffer), name, new Uint8Array(end.buffer)];
    const zip = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { zip.set(p, at); at += p.length; }
    expect(stored.length).toBeGreaterThan(zip.length); // (it did compress)
    expect((await b.unzipFiles(zip)).get('backup/info.json')).toBe(text);
  });

  it('something that isn\'t a zip is refused', async () => {
    await expect(b.unzipFiles(new TextEncoder().encode('hello'))).rejects.toThrow();
  });
});

describe('making a backup', () => {
  it('is named tabazing-backup-<date> and has one "backup" folder with a JSON file per kind', async () => {
    expect(b.backupName(new Date(2026, 9, 21))).toBe('tabazing-backup-2026-10-21');
    const { files } = await backupOfProfile();
    expect(files.map((f) => f.name)).toEqual(['backup/info.json', 'backup/settings.json', 'backup/notes.json', 'backup/bookmark-notes.json',
      'backup/stars.json', 'backup/bookmarks.json', 'backup/archive.json', 'backup/snoozed.json']);
    const info = JSON.parse(files[0].data);
    expect(info).toMatchObject({ app: 'Tabazing', version: '9.9.9' });
  });

  it('holds every kind of data: notes, bookmark notes (by address and folder), stars, bookmarks, the archive, snoozed tabs, settings', async () => {
    const { data } = await backupOfProfile();
    expect(data.notes).toEqual([{ url: 'https://note.example/', note: 'tab note', t: NOW }]);
    expect(data['bookmark-notes']).toEqual([{ url: 'https://wiki.example/', title: 'Wiki', path: ['Bookmarks bar', 'Work'], note: 'wiki note', t: NOW }]);
    expect(data.stars).toEqual([{ url: 'https://star.example/', title: 'Star', t: NOW }]);
    expect(data.archive.map((x) => x.url)).toEqual(['https://kept.example/']);
    expect(data.snoozed).toEqual([{ url: 'https://later.example/', title: 'Later', at: NOW + 864e5, pinned: false, group: null }]);
    expect(data.settings).toMatchObject({ theme: 'light', accent: '#F87171', cardSize: 'small' });
    expect(data.settings.iconTips).toBe(undefined);
    const bar = data.bookmarks.find((x) => x.type === 'bookmarks-bar');
    expect(bar.children).toEqual([{ title: 'Docs', url: 'https://docs.example/' }, { title: 'Work', children: [{ title: 'Wiki', url: 'https://wiki.example/' }] }]);
  });

  it('readBackup takes the files from the folder chosen (any path before "backup/"), leaves broken or other files out', () => {
    const got = b.readBackup(new Map([['Downloads/backup/notes.json', '[]'], ['Downloads/backup/stars.json', '{bad json'], ['Downloads/backup/notes.txt', 'x'], ['Downloads\\backup\\snoozed.json', '[]']]));
    expect(Object.keys(got).sort()).toEqual(['notes', 'snoozed']);
    expect(Object.keys(b.readBackup(new Map([['notes.json', '[]']])))).toEqual(['notes']); // the backup folder itself chosen
    expect(() => b.readBackup(new Map([['backup/info.json', '{}']]))).toThrow(); // nothing to restore
    expect(() => b.readBackup(new Map([['photo.json', '{}']]))).toThrow();
  });
});

describe('restoring', () => {
  it('into an empty profile: everything comes back as it was', async () => {
    const { data } = await backupOfProfile();
    const before = { marks: allMarks(), folders: folders() };
    freshProfile();
    const r = await b.restoreBackup(data);
    expect(allMarks()).toEqual(before.marks);
    expect(folders()).toEqual(before.folders);
    expect(r.bookmarks).toEqual({ added: 4, updated: 0, skipped: 0 });
    expect(r.folders.added).toBe(2); // Work, Tabs Archive
    expect(r.archive).toEqual({ added: 0, updated: 0, skipped: 1 }); // (in the bookmarks already)
    expect(Object.values(await store.getNotes()).map((x) => x.n)).toEqual(['tab note']);
    expect(Object.values(await store.getStars()).map((x) => x.u)).toEqual(['https://star.example/']);
    expect((await store.getSnoozed()).map((x) => x.url)).toEqual(['https://later.example/']);
    // the bookmark note is on the new Wiki bookmark (its new id)
    const wiki = (await chrome.bookmarks.search({ url: 'https://wiki.example/' }))[0];
    expect((await store.getBmNotes())[wiki.id].n).toBe('wiki note');
    expect(r.settings).toBe(false);
    expect((await store.getPrefs()).theme).toBe('system'); // settings only when asked
  });

  it('restoring the same backup again changes nothing: no duplicates of anything', async () => {
    const { data } = await backupOfProfile();
    await b.restoreBackup(data); // into the same profile it came from
    const once = { marks: allMarks(), folders: folders(), notes: await store.getNotes(), bm: await store.getBmNotes(), stars: await store.getStars(), snoozed: await store.getSnoozed() };
    const r = await b.restoreBackup(data);
    expect(allMarks()).toEqual(once.marks);
    expect(folders()).toEqual(once.folders);
    expect(Object.keys(await store.getNotes())).toEqual(Object.keys(once.notes));
    expect(Object.keys(await store.getBmNotes())).toEqual(Object.keys(once.bm));
    expect(Object.keys(await store.getStars())).toEqual(Object.keys(once.stars));
    expect((await store.getSnoozed()).length).toBe(once.snoozed.length);
    for (const k of ['bookmarks', 'folders', 'archive', 'notes', 'bmNotes', 'stars', 'snoozed']) expect(r[k].added, k).toBe(0);
  });

  it('never deletes: what is here and not in the backup stays, untouched', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const mine = chrome._addBookmark({ parentId: '1', title: 'Mine', url: 'https://mine.example/' });
    const myFolder = chrome._addBookmark({ parentId: '2', title: 'Projects' });
    chrome._addBookmark({ parentId: myFolder.id, title: 'Plan', url: 'https://plan.example/' });
    await L.set({
      notes: { 'https://mynote.example/': { u: 'https://mynote.example/', n: 'my note', t: NOW } },
      bmNotes: { [mine.id]: { u: 'https://mine.example/', n: 'mine note', t: NOW } },
      stars: { 'https://mystar.example/': { u: 'https://mystar.example/', ti: 'Mine', t: NOW } },
      snoozed: [{ id: 'm1', url: 'https://mysnooze.example/', title: 'Mine', at: NOW + 3600e3, windowId: 1, pinned: false, t: NOW, group: null }],
      prefs: { theme: 'dark' },
    });
    await b.restoreBackup(data);
    expect(allMarks()).toEqual(expect.arrayContaining(['Bookmarks bar > Mine https://mine.example/', 'Other bookmarks > Projects > Plan https://plan.example/']));
    expect((await store.getNotes())['https://mynote.example/'].n).toBe('my note');
    expect((await store.getBmNotes())[mine.id].n).toBe('mine note');
    expect((await store.getStars())['https://mystar.example/']).toBeTruthy();
    expect((await store.getSnoozed()).map((x) => x.url)).toContain('https://mysnooze.example/');
    expect((await store.getPrefs()).theme).toBe('dark');
  });

  it('a bookmark of an address that is bookmarked anywhere already is not made again', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const there = chrome._addBookmark({ parentId: '2', title: 'My docs', url: 'https://docs.example/' }); // in another folder
    const r = await b.restoreBackup(data);
    expect((await chrome.bookmarks.search({ url: 'https://docs.example/' })).map((x) => x.id)).toEqual([there.id]);
    expect(r.bookmarks.skipped).toBe(1);
  });

  it('a folder is the one of the same name in the same place: no second "Work"', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const work = chrome._addBookmark({ parentId: '1', title: 'Work' });
    chrome._addBookmark({ parentId: work.id, title: 'Board', url: 'https://board.example/' });
    await b.restoreBackup(data);
    expect(folders().filter((x) => x === 'Bookmarks bar > Work')).toHaveLength(1);
    expect(allMarks()).toEqual(expect.arrayContaining(['Bookmarks bar > Work > Board https://board.example/', 'Bookmarks bar > Work > Wiki https://wiki.example/']));
  });

  it('the backup\'s notes go over the ones there: on the same page, and on the same bookmark', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const wiki = chrome._addBookmark({ parentId: '1', title: 'Work' });
    const w = chrome._addBookmark({ parentId: wiki.id, title: 'Wiki', url: 'https://wiki.example/' });
    await L.set({
      notes: { 'https://note.example/': { u: 'https://note.example/', n: 'old tab note', t: NOW } },
      bmNotes: { [w.id]: { u: 'https://wiki.example/', n: 'old wiki note', t: NOW } },
    });
    const r = await b.restoreBackup(data);
    expect((await store.getNotes())['https://note.example/'].n).toBe('tab note');
    expect((await store.getBmNotes())[w.id].n).toBe('wiki note');
    expect(r.notes).toMatchObject({ updated: 1 });
    expect(r.bmNotes).toMatchObject({ updated: 1 });
  });

  it('a bookmark note goes on the bookmark of that address in that folder, when there are several', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const other = chrome._addBookmark({ parentId: '2', title: 'Wiki elsewhere', url: 'https://wiki.example/' });
    const work = chrome._addBookmark({ parentId: '1', title: 'Work' });
    const right = chrome._addBookmark({ parentId: work.id, title: 'Wiki', url: 'https://wiki.example/' });
    await b.restoreBackup(data);
    const notes = await store.getBmNotes();
    expect(notes[right.id].n).toBe('wiki note');
    expect(notes[other.id]).toBe(undefined);
  });

  it('the caps never drop what is there: what doesn\'t fit is left out', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const stars = {}, notes = {};
    for (let i = 0; i < LIMITS.MAX_STARS; i++) stars[`https://s${i}.example/`] = { u: `https://s${i}.example/`, ti: '', t: NOW - i };
    for (let i = 0; i < LIMITS.MAX_NOTES; i++) notes[`https://n${i}.example/`] = { u: `https://n${i}.example/`, n: 'n' + i, t: NOW - i };
    await L.set({ stars, notes });
    const r = await b.restoreBackup(data);
    expect(Object.keys(await store.getStars())).toHaveLength(LIMITS.MAX_STARS);
    expect(Object.keys(await store.getStars())).toEqual(Object.keys(stars)); // every one that was there
    expect(Object.keys(await store.getNotes()).sort()).toEqual(Object.keys(notes).sort());
    expect(r.stars).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(r.notes).toEqual({ added: 0, updated: 0, skipped: 1 });
  });

  it('snoozed tabs: one of a page snoozed already is skipped, one whose time has passed too (it would open at once)', async () => {
    freshProfile();
    await L.set({ snoozed: [{ id: 'x', url: 'https://same.example/', title: 'Same', at: NOW + 1000e3, windowId: 1, pinned: false, t: NOW, group: null }] });
    const r = await b.restoreBackup({ snoozed: [
      { url: 'https://same.example/', title: 'Same', at: NOW + 5000e3 },
      { url: 'https://past.example/', title: 'Past', at: NOW - 1000 },
      { url: 'https://new.example/', title: 'New', at: NOW + 2000e3, pinned: true },
    ] });
    const list = await store.getSnoozed();
    expect(list.map((x) => x.url).sort()).toEqual(['https://new.example/', 'https://same.example/']);
    expect(list.find((x) => x.url === 'https://same.example/').at).toBe(NOW + 1000e3); // the one there, as it was
    expect(r.snoozed).toEqual({ added: 1, updated: 0, skipped: 2 });
  });

  it('settings only when asked, and only the ones Tabazing knows', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    data.settings.evil = 'x';
    const r = await b.restoreBackup(data, { settings: true });
    expect(r.settings).toBe(true);
    const p = await store.getPrefs();
    expect(p).toMatchObject({ theme: 'light', accent: '#F87171', cardSize: 'small' });
    expect((await L.get('prefs')).prefs.evil).toBe(undefined);
  });

  it('broken entries are left out, the rest restored, nothing thrown', async () => {
    freshProfile();
    const r = await b.restoreBackup({
      notes: [null, { url: 'not a url', note: 'x' }, { url: 'https://ok.example/', note: 7 }, { url: 'https://ok.example/', note: 'fine' }],
      stars: ['x', { url: 5 }, { url: 'https://star.example/', title: 'S' }],
      bookmarks: [{ type: 'bookmarks-bar', children: [{ title: 'Bad', url: 'javascript' }, { title: 'Good', url: 'https://good.example/' }, 'junk'] }],
      snoozed: [{ url: 'https://z.example/' }],
      'bookmark-notes': [{ url: 'https://good.example/', note: '' }],
    });
    expect(Object.values(await store.getNotes()).map((x) => x.n)).toEqual(['fine']);
    expect(Object.keys(await store.getStars())).toEqual(['https://star.example/']);
    expect(allMarks()).toEqual(['Bookmarks bar > Good https://good.example/']);
    expect(r.bookmarks).toEqual({ added: 1, updated: 0, skipped: 1 });
  });

  it('the whole way round: a zip made here, restored on a fresh profile, gives the same data', async () => {
    const { files } = await backupOfProfile();
    const before = { marks: allMarks(), notes: await store.getNotes(), stars: await store.getStars() };
    const zip = b.zipFiles(files);
    freshProfile();
    await b.restoreBackup(b.readBackup(await b.unzipFiles(zip)));
    expect(allMarks()).toEqual(before.marks);
    expect(Object.keys(await store.getNotes())).toEqual(Object.keys(before.notes));
    expect(Object.keys(await store.getStars())).toEqual(Object.keys(before.stars));
  });
});

describe('restoring: the hard cases', () => {
  const sum = (x) => x.added + x.updated + x.skipped;
  const roundTrip = async () => { const { files } = await b.makeBackup(); const data = b.readBackup(asFiles(files)); freshProfile(); return data; };

  it('a folder of several backups gives the newest one, never a mix', () => {
    const got = b.readBackup(new Map([
      ['Downloads/tabazing-backup-2026-09-01/backup/info.json', JSON.stringify({ made: '2026-09-01T10:00:00Z' })],
      ['Downloads/tabazing-backup-2026-09-01/backup/notes.json', '["old"]'],
      ['Downloads/tabazing-backup-2026-09-01/backup/stars.json', '["old"]'],
      ['Downloads/tabazing-backup-2026-10-21/backup/info.json', JSON.stringify({ made: '2026-10-21T10:00:00Z' })],
      ['Downloads/tabazing-backup-2026-10-21/backup/notes.json', '["new"]'],
    ]));
    expect(got.notes).toEqual(['new']);
    expect(got.stars).toBe(undefined); // not the older one's
  });

  it('addresses are told apart exactly: #inbox and #sent are two bookmarks, each with its own note', async () => {
    const inbox = chrome._addBookmark({ parentId: '1', title: 'Inbox', url: 'https://mail.example/#inbox' });
    chrome._addBookmark({ parentId: '1', title: 'Sent', url: 'https://mail.example/#sent' });
    chrome._addBookmark({ parentId: '1', title: 'Slash', url: 'https://mail.example/a/' });
    chrome._addBookmark({ parentId: '1', title: 'No slash', url: 'https://mail.example/a' });
    const before = allMarks();
    const data = await roundTrip();
    await b.restoreBackup(data);
    expect(allMarks()).toEqual(before);
    // and a note for #sent never lands on #inbox
    freshProfile();
    const mine = chrome._addBookmark({ parentId: '1', title: 'Inbox', url: inbox.url });
    await L.set({ bmNotes: { [mine.id]: { u: inbox.url, n: 'my inbox note', t: NOW } } });
    await b.restoreBackup({ bookmarks: [{ type: 'bookmarks-bar', children: [{ title: 'Sent', url: 'https://mail.example/#sent' }] }],
      'bookmark-notes': [{ url: 'https://mail.example/#sent', path: ['Bookmarks bar'], note: 'sent note' }] });
    const notes = await store.getBmNotes();
    expect(notes[mine.id].n).toBe('my inbox note');
    expect(Object.values(notes).map((x) => x.n).sort()).toEqual(['my inbox note', 'sent note']);
  });

  it('a page kept in two folders comes back in both, each with its own note; again, nothing more', async () => {
    const f1 = chrome._addBookmark({ parentId: '1', title: 'A' }), f2 = chrome._addBookmark({ parentId: '1', title: 'B' });
    const x1 = chrome._addBookmark({ parentId: f1.id, title: 'X', url: 'https://x.example/' });
    const x2 = chrome._addBookmark({ parentId: f2.id, title: 'X', url: 'https://x.example/' });
    await L.set({ bmNotes: { [x1.id]: { u: x1.url, n: 'note A', t: NOW }, [x2.id]: { u: x2.url, n: 'note B', t: NOW } } });
    const before = allMarks();
    const data = await roundTrip();
    const r = await b.restoreBackup(data);
    expect(allMarks()).toEqual(before);
    expect(r.bmNotes.added).toBe(2);
    const notes = await store.getBmNotes();
    const noteIn = async (folder) => { const [f] = (await chrome.bookmarks.getChildren('1')).filter((c) => c.title === folder); return notes[(await chrome.bookmarks.getChildren(f.id))[0].id].n; };
    expect([await noteIn('A'), await noteIn('B')]).toEqual(['note A', 'note B']);
    await b.restoreBackup(data);
    expect(allMarks()).toEqual(before);
  });

  it('two restores at once make nothing twice', async () => {
    const data = { bookmarks: [{ type: 'bookmarks-bar', children: [{ title: 'F', children: [{ title: 'A', url: 'https://a.example/' }] }, { title: 'B', url: 'https://b.example/' }] }],
      archive: [{ url: 'https://arch.example/', title: 'Arch' }] };
    await Promise.all([b.restoreBackup(data), b.restoreBackup(data)]);
    expect(allMarks()).toEqual(['Bookmarks bar > B https://b.example/', 'Bookmarks bar > F > A https://a.example/', 'Other bookmarks > Tabs Archive > Arch https://arch.example/']);
    expect(folders()).toEqual(['Bookmarks bar', 'Bookmarks bar > F', 'Other bookmarks', 'Other bookmarks > Tabs Archive']);
  });

  it('a folder moved since doesn\'t come back empty; one empty in the backup does', async () => {
    const work = chrome._addBookmark({ parentId: '2', title: 'Work' });
    chrome._addBookmark({ parentId: work.id, title: 'Wiki', url: 'https://wiki.example/' });
    const r = await b.restoreBackup({ bookmarks: [{ type: 'bookmarks-bar', children: [{ title: 'Work', children: [{ title: 'Wiki', url: 'https://wiki.example/' }] }, { title: 'Empty', children: [] }] }] });
    expect(folders()).toEqual(['Bookmarks bar', 'Bookmarks bar > Empty', 'Other bookmarks', 'Other bookmarks > Work']);
    expect(r.folders).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(r.bookmarks).toEqual({ added: 0, updated: 0, skipped: 1 });
  });

  it('a bookmark Chrome refuses is left out, and the rest is still restored', async () => {
    const real = chrome.bookmarks.create;
    chrome.bookmarks.create = async (p) => { if (p.url !== undefined) new URL(p.url); return real(p); }; // like Chrome: "Invalid URL."
    let r;
    try {
      r = await b.restoreBackup({ bookmarks: [{ type: 'bookmarks-bar', children: [{ title: 'Bad', url: 'http://' }, { title: 'Good', url: 'https://good.example/' }] }],
        notes: [{ url: 'https://n.example/', note: 'n' }] });
    } finally { chrome.bookmarks.create = real; }
    expect(allMarks()).toEqual(['Bookmarks bar > Good https://good.example/']);
    expect(r.bookmarks).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(Object.keys(await store.getNotes())).toEqual(['https://n.example/']);
  });

  it('managed bookmarks (an organization\'s) are never copied', async () => {
    const r = await b.restoreBackup({ bookmarks: [{ type: 'managed', title: 'Company', children: [{ title: 'Intranet', url: 'https://intra.example/' }] }] });
    expect(allMarks()).toEqual([]);
    expect(r.bookmarks.skipped).toBe(1);
  });

  it('every entry is counted: broken ones and a second note for the same page as left out', async () => {
    const r = await b.restoreBackup({ notes: [null, { url: 'bad', note: 'x' }, { url: 'https://ok.example/', note: 7 }, { url: 'https://ok.example/', note: 'fine' }, { url: 'https://ok.example/', note: 'again' }],
      stars: ['x', { url: 5 }, { url: 'https://star.example/' }], snoozed: [{ url: 'https://z.example/', at: String(NOW + 1e7) }, { url: 'https://y.example/', at: NOW + 1e7 }],
      archive: [{ url: 'nope' }, { url: 'https://a.example/' }] });
    expect([sum(r.notes), sum(r.stars), sum(r.snoozed), sum(r.archive)]).toEqual([5, 3, 2, 2]);
    expect(r.notes).toEqual({ added: 1, updated: 0, skipped: 4 });
    expect((await store.getNotes())['https://ok.example/'].n).toBe('fine');
  });

  it('bookmarks deep in folders come back too', async () => {
    let node = { title: 'leaf', url: 'https://deep.example/' };
    for (let i = 45; i > 0; i--) node = { title: 'f' + i, children: [node] };
    const r = await b.restoreBackup({ bookmarks: [{ type: 'bookmarks-bar', children: [node] }] });
    expect(r.bookmarks.added).toBe(1);
    expect(allMarks()).toHaveLength(1);
  });

  it('settings: only valid values; an invalid one leaves the current setting as it is', async () => {
    await L.set({ prefs: { theme: 'dark', titleLines: 1, accent: '#F87171' } });
    await b.restoreBackup({ settings: { theme: 'purple', titleLines: '1', accent: '#abcdef', showAge: false, lang: 'el', bogus: 1 }, notes: [] }, { settings: true });
    const p = await store.getPrefs();
    expect([p.theme, p.titleLines, p.accent, p.showAge, p.lang]).toEqual(['dark', 1, '#ABCDEF', false, 'el']);
    expect('bogus' in p).toBe(false);
  });

  it('notes keep the time they were written', async () => {
    const m = chrome._addBookmark({ parentId: '1', title: 'M', url: 'https://m.example/' });
    await L.set({ notes: { 'https://n.example/': { u: 'https://n.example/', n: 'n', t: 1000 } }, bmNotes: { [m.id]: { u: m.url, n: 'b', t: 2000 } } });
    await b.restoreBackup(await roundTrip());
    expect((await store.getNotes())['https://n.example/'].t).toBe(1000);
    expect(Object.values(await store.getBmNotes())[0].t).toBe(2000);
  });
});
