// Backup & Restore (utils/backup.js): the zip (made and read back, stored or deflated), the backup's files, and above
// all the restore's promise: nothing that is there is ever deleted, nothing is ever made twice, a backup's notes go on
// the same pages and bookmarks (over the ones there), and restoring the same backup again changes nothing.
import { describe, it, expect, beforeEach } from 'vitest';
import { LIMITS } from '../../utils/constants.js';

const localArea = chrome.storage.local;
const NOW = Date.now();
let backup, store;
beforeEach(async () => {
  backup = await import('../../utils/backup.js');
  store = await import('../../utils/store.js');
});

// ---- a profile: bookmarks (bar: Docs, Work/[Wiki]; other: Recipes, the archive [Kept]), notes, stars, snoozed tabs
function seedProfile() {
  const docs = chrome._addBookmark({ parentId: '1', title: 'Docs', url: 'https://docs.example/' });
  const work = chrome._addBookmark({ parentId: '1', title: 'Work' });
  const wiki = chrome._addBookmark({ parentId: work.id, title: 'Wiki', url: 'https://wiki.example/' });
  const recipes = chrome._addBookmark({ parentId: '2', title: 'Recipes', url: 'https://food.example/' });
  const archiveFolder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
  const kept = chrome._addBookmark({ parentId: archiveFolder.id, title: 'Kept', url: 'https://kept.example/' });
  return { docs, work, wiki, recipes, archiveFolder, kept };
}
async function seedData(profile) {
  await localArea.set({
    notes: { 'https://note.example/': { u: 'https://note.example/', n: 'tab note', t: NOW } },
    bmNotes: { [profile.wiki.id]: { u: 'https://wiki.example/', n: 'wiki note', t: NOW } },
    stars: { 'https://star.example/': { u: 'https://star.example/', ti: 'Star', t: NOW } },
    snoozed: [{ id: 's1', url: 'https://later.example/', title: 'Later', at: NOW + 864e5, windowId: 1, pinned: false, t: NOW, group: null }],
    prefs: { theme: 'light', accent: '#F87171', cardSize: 'small' },
  });
}
// Every bookmark: "path > title url", sorted (the tree as text, to compare).
function allMarks() {
  const out = [];
  const walk = (node, path) => { for (const child of node.children || []) { if (child.url) out.push([...path, child.title].join(' > ') + ' ' + child.url); else walk(child, [...path, child.title]); } };
  walk(chrome._data.bookmarks, []);
  return out.sort();
}
const folders = () => { const out = []; const walk = (node, path) => { for (const child of node.children || []) if (!child.url) { out.push([...path, child.title].join(' > ')); walk(child, [...path, child.title]); } }; walk(chrome._data.bookmarks, []); return out.sort(); };
const asFiles = (files) => new Map(files.map((file) => [file.name, typeof file.data === 'string' ? file.data : new TextDecoder().decode(file.data)]));
async function backupOfProfile() {
  const profile = seedProfile();
  await seedData(profile);
  const { files } = await backup.makeBackup({ version: '9.9.9' });
  return { m: profile, files, data: backup.readBackup(asFiles(files)) };
}
// A fresh profile (Chrome's own empty folders and nothing stored), as on another computer.
function freshProfile() { chrome._reset(); }

describe('making a backup', () => {
  it('is named tabazing-backup-<date> and has one "backup" folder with a JSON file per kind', async () => {
    expect(backup.backupName(new Date(2026, 9, 21))).toBe('tabazing-backup-2026-10-21');
    const { files } = await backupOfProfile();
    expect(files.map((file) => file.name)).toEqual(['backup/info.json', 'backup/settings.json', 'backup/notes.json', 'backup/bookmark-notes.json',
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
    const got = backup.readBackup(new Map([['Downloads/backup/notes.json', '[]'], ['Downloads/backup/stars.json', '{bad json'], ['Downloads/backup/notes.txt', 'x'], ['Downloads\\backup\\snoozed.json', '[]']]));
    expect(Object.keys(got).sort()).toEqual(['notes', 'snoozed']);
    expect(Object.keys(backup.readBackup(new Map([['notes.json', '[]']])))).toEqual(['notes']); // the backup folder itself chosen
    expect(() => backup.readBackup(new Map([['backup/info.json', '{}']]))).toThrow(); // nothing to restore
    expect(() => backup.readBackup(new Map([['photo.json', '{}']]))).toThrow();
  });
});

describe('restoring', () => {
  it('into an empty profile: everything comes back as it was', async () => {
    const { data } = await backupOfProfile();
    const before = { marks: allMarks(), folders: folders() };
    freshProfile();
    const result = await backup.restoreBackup(data);
    expect(allMarks()).toEqual(before.marks);
    expect(folders()).toEqual(before.folders);
    expect(result.bookmarks).toEqual({ added: 4, updated: 0, skipped: 0 });
    expect(result.folders.added).toBe(2); // Work, Tabs Archive
    expect(result.archive).toEqual({ added: 0, updated: 0, skipped: 1 }); // (in the bookmarks already)
    expect(Object.values(await store.getNotes()).map((x) => x.n)).toEqual(['tab note']);
    expect(Object.values(await store.getStars()).map((x) => x.u)).toEqual(['https://star.example/']);
    expect((await store.getSnoozed()).map((x) => x.url)).toEqual(['https://later.example/']);
    // the bookmark note is on the new Wiki bookmark (its new id)
    const wiki = (await chrome.bookmarks.search({ url: 'https://wiki.example/' }))[0];
    expect((await store.getBookmarkNotes())[wiki.id].n).toBe('wiki note');
    expect(result.settings).toBe(false);
    expect((await store.getPreferences()).theme).toBe('system'); // settings only when asked
  });

  it('restoring the same backup again changes nothing: no duplicates of anything', async () => {
    const { data } = await backupOfProfile();
    await backup.restoreBackup(data); // into the same profile it came from
    const once = { marks: allMarks(), folders: folders(), notes: await store.getNotes(), bookmarkNotes: await store.getBookmarkNotes(), stars: await store.getStars(), snoozed: await store.getSnoozed() };
    const result = await backup.restoreBackup(data);
    expect(allMarks()).toEqual(once.marks);
    expect(folders()).toEqual(once.folders);
    expect(Object.keys(await store.getNotes())).toEqual(Object.keys(once.notes));
    expect(Object.keys(await store.getBookmarkNotes())).toEqual(Object.keys(once.bookmarkNotes));
    expect(Object.keys(await store.getStars())).toEqual(Object.keys(once.stars));
    expect((await store.getSnoozed()).length).toBe(once.snoozed.length);
    for (const field of ['bookmarks', 'folders', 'archive', 'notes', 'bookmarkNotes', 'stars', 'snoozed']) expect(result[field].added, field).toBe(0);
  });

  it('never deletes: what is here and not in the backup stays, untouched', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const mine = chrome._addBookmark({ parentId: '1', title: 'Mine', url: 'https://mine.example/' });
    const myFolder = chrome._addBookmark({ parentId: '2', title: 'Projects' });
    chrome._addBookmark({ parentId: myFolder.id, title: 'Plan', url: 'https://plan.example/' });
    await localArea.set({
      notes: { 'https://mynote.example/': { u: 'https://mynote.example/', n: 'my note', t: NOW } },
      bmNotes: { [mine.id]: { u: 'https://mine.example/', n: 'mine note', t: NOW } },
      stars: { 'https://mystar.example/': { u: 'https://mystar.example/', ti: 'Mine', t: NOW } },
      snoozed: [{ id: 'm1', url: 'https://mysnooze.example/', title: 'Mine', at: NOW + 3600e3, windowId: 1, pinned: false, t: NOW, group: null }],
      prefs: { theme: 'dark' },
    });
    await backup.restoreBackup(data);
    expect(allMarks()).toEqual(expect.arrayContaining(['Bookmarks bar > Mine https://mine.example/', 'Other bookmarks > Projects > Plan https://plan.example/']));
    expect((await store.getNotes())['https://mynote.example/'].n).toBe('my note');
    expect((await store.getBookmarkNotes())[mine.id].n).toBe('mine note');
    expect((await store.getStars())['https://mystar.example/']).toBeTruthy();
    expect((await store.getSnoozed()).map((x) => x.url)).toContain('https://mysnooze.example/');
    expect((await store.getPreferences()).theme).toBe('dark');
  });

  it('a bookmark of an address that is bookmarked anywhere already is not made again', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const there = chrome._addBookmark({ parentId: '2', title: 'My docs', url: 'https://docs.example/' }); // in another folder
    const result = await backup.restoreBackup(data);
    expect((await chrome.bookmarks.search({ url: 'https://docs.example/' })).map((x) => x.id)).toEqual([there.id]);
    expect(result.bookmarks.skipped).toBe(1);
  });

  it('a folder is the one of the same name in the same place: no second "Work"', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const work = chrome._addBookmark({ parentId: '1', title: 'Work' });
    chrome._addBookmark({ parentId: work.id, title: 'Board', url: 'https://board.example/' });
    await backup.restoreBackup(data);
    expect(folders().filter((x) => x === 'Bookmarks bar > Work')).toHaveLength(1);
    expect(allMarks()).toEqual(expect.arrayContaining(['Bookmarks bar > Work > Board https://board.example/', 'Bookmarks bar > Work > Wiki https://wiki.example/']));
  });

  it('the backup\'s notes go over the ones there: on the same page, and on the same bookmark', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const wiki = chrome._addBookmark({ parentId: '1', title: 'Work' });
    const wikiBookmark = chrome._addBookmark({ parentId: wiki.id, title: 'Wiki', url: 'https://wiki.example/' });
    await localArea.set({
      notes: { 'https://note.example/': { u: 'https://note.example/', n: 'old tab note', t: NOW } },
      bmNotes: { [wikiBookmark.id]: { u: 'https://wiki.example/', n: 'old wiki note', t: NOW } },
    });
    const result = await backup.restoreBackup(data);
    expect((await store.getNotes())['https://note.example/'].n).toBe('tab note');
    expect((await store.getBookmarkNotes())[wikiBookmark.id].n).toBe('wiki note');
    expect(result.notes).toMatchObject({ updated: 1 });
    expect(result.bookmarkNotes).toMatchObject({ updated: 1 });
  });

  it('a bookmark note goes on the bookmark of that address in that folder, when there are several', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const other = chrome._addBookmark({ parentId: '2', title: 'Wiki elsewhere', url: 'https://wiki.example/' });
    const work = chrome._addBookmark({ parentId: '1', title: 'Work' });
    const right = chrome._addBookmark({ parentId: work.id, title: 'Wiki', url: 'https://wiki.example/' });
    await backup.restoreBackup(data);
    const notes = await store.getBookmarkNotes();
    expect(notes[right.id].n).toBe('wiki note');
    expect(notes[other.id]).toBe(undefined);
  });

  it('the caps never drop what is there: what doesn\'t fit is left out', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    const stars = {}, notes = {};
    for (let i = 0; i < LIMITS.MAX_STARS; i++) stars[`https://s${i}.example/`] = { u: `https://s${i}.example/`, ti: '', t: NOW - i };
    for (let i = 0; i < LIMITS.MAX_NOTES; i++) notes[`https://n${i}.example/`] = { u: `https://n${i}.example/`, n: 'n' + i, t: NOW - i };
    await localArea.set({ stars, notes });
    const result = await backup.restoreBackup(data);
    expect(Object.keys(await store.getStars())).toHaveLength(LIMITS.MAX_STARS);
    expect(Object.keys(await store.getStars())).toEqual(Object.keys(stars)); // every one that was there
    expect(Object.keys(await store.getNotes()).sort()).toEqual(Object.keys(notes).sort());
    expect(result.stars).toEqual({ added: 0, updated: 0, skipped: 1 });
    expect(result.notes).toEqual({ added: 0, updated: 0, skipped: 1 });
  });

  it('snoozed tabs: one of a page snoozed already is skipped, one whose time has passed too (it would open at once)', async () => {
    freshProfile();
    await localArea.set({ snoozed: [{ id: 'x', url: 'https://same.example/', title: 'Same', at: NOW + 1000e3, windowId: 1, pinned: false, t: NOW, group: null }] });
    const result = await backup.restoreBackup({ snoozed: [
      { url: 'https://same.example/', title: 'Same', at: NOW + 5000e3 },
      { url: 'https://past.example/', title: 'Past', at: NOW - 1000 },
      { url: 'https://new.example/', title: 'New', at: NOW + 2000e3, pinned: true },
    ] });
    const list = await store.getSnoozed();
    expect(list.map((x) => x.url).sort()).toEqual(['https://new.example/', 'https://same.example/']);
    expect(list.find((x) => x.url === 'https://same.example/').at).toBe(NOW + 1000e3); // the one there, as it was
    expect(result.snoozed).toEqual({ added: 1, updated: 0, skipped: 2 });
  });

  it('settings only when asked, and only the ones Tabazing knows', async () => {
    const { data } = await backupOfProfile();
    freshProfile();
    data.settings.evil = 'x';
    const result = await backup.restoreBackup(data, { settings: true });
    expect(result.settings).toBe(true);
    const preferences = await store.getPreferences();
    expect(preferences).toMatchObject({ theme: 'light', accent: '#F87171', cardSize: 'small' });
    expect((await localArea.get('prefs')).prefs.evil).toBe(undefined);
  });

  it('broken entries are left out, the rest restored, nothing thrown', async () => {
    freshProfile();
    const result = await backup.restoreBackup({
      notes: [null, { url: 'not a url', note: 'x' }, { url: 'https://ok.example/', note: 7 }, { url: 'https://ok.example/', note: 'fine' }],
      stars: ['x', { url: 5 }, { url: 'https://star.example/', title: 'S' }],
      bookmarks: [{ type: 'bookmarks-bar', children: [{ title: 'Bad', url: 'javascript' }, { title: 'Good', url: 'https://good.example/' }, 'junk'] }],
      snoozed: [{ url: 'https://z.example/' }],
      'bookmark-notes': [{ url: 'https://good.example/', note: '' }],
    });
    expect(Object.values(await store.getNotes()).map((x) => x.n)).toEqual(['fine']);
    expect(Object.keys(await store.getStars())).toEqual(['https://star.example/']);
    expect(allMarks()).toEqual(['Bookmarks bar > Good https://good.example/']);
    expect(result.bookmarks).toEqual({ added: 1, updated: 0, skipped: 1 });
  });

  it('the whole way round: a zip made here, restored on a fresh profile, gives the same data', async () => {
    const { files } = await backupOfProfile();
    const before = { marks: allMarks(), notes: await store.getNotes(), stars: await store.getStars() };
    const zip = backup.zipFiles(files);
    freshProfile();
    await backup.restoreBackup(backup.readBackup(await backup.unzipFiles(zip)));
    expect(allMarks()).toEqual(before.marks);
    expect(Object.keys(await store.getNotes())).toEqual(Object.keys(before.notes));
    expect(Object.keys(await store.getStars())).toEqual(Object.keys(before.stars));
  });
});

describe('restoring: the hard cases', () => {
  const sum = (x) => x.added + x.updated + x.skipped;
  const roundTrip = async () => { const { files } = await backup.makeBackup(); const data = backup.readBackup(asFiles(files)); freshProfile(); return data; };

  it('a folder of several backups gives the newest one, never a mix', () => {
    const got = backup.readBackup(new Map([
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
    await backup.restoreBackup(data);
    expect(allMarks()).toEqual(before);
    // and a note for #sent never lands on #inbox
    freshProfile();
    const mine = chrome._addBookmark({ parentId: '1', title: 'Inbox', url: inbox.url });
    await localArea.set({ bmNotes: { [mine.id]: { u: inbox.url, n: 'my inbox note', t: NOW } } });
    await backup.restoreBackup({ bookmarks: [{ type: 'bookmarks-bar', children: [{ title: 'Sent', url: 'https://mail.example/#sent' }] }],
      'bookmark-notes': [{ url: 'https://mail.example/#sent', path: ['Bookmarks bar'], note: 'sent note' }] });
    const notes = await store.getBookmarkNotes();
    expect(notes[mine.id].n).toBe('my inbox note');
    expect(Object.values(notes).map((x) => x.n).sort()).toEqual(['my inbox note', 'sent note']);
  });

  it('a page kept in two folders comes back in both, each with its own note; again, nothing more', async () => {
    const folderA = chrome._addBookmark({ parentId: '1', title: 'A' }), folderB = chrome._addBookmark({ parentId: '1', title: 'B' });
    const bookmarkInFolderA = chrome._addBookmark({ parentId: folderA.id, title: 'X', url: 'https://x.example/' });
    const bookmarkInFolderB = chrome._addBookmark({ parentId: folderB.id, title: 'X', url: 'https://x.example/' });
    await localArea.set({ bmNotes: { [bookmarkInFolderA.id]: { u: bookmarkInFolderA.url, n: 'note A', t: NOW }, [bookmarkInFolderB.id]: { u: bookmarkInFolderB.url, n: 'note B', t: NOW } } });
    const before = allMarks();
    const data = await roundTrip();
    const result = await backup.restoreBackup(data);
    expect(allMarks()).toEqual(before);
    expect(result.bookmarkNotes.added).toBe(2);
    const notes = await store.getBookmarkNotes();
    const noteIn = async (folder) => { const [folderNode] = (await chrome.bookmarks.getChildren('1')).filter((child) => child.title === folder); return notes[(await chrome.bookmarks.getChildren(folderNode.id))[0].id].n; };
    expect([await noteIn('A'), await noteIn('B')]).toEqual(['note A', 'note B']);
    await backup.restoreBackup(data);
    expect(allMarks()).toEqual(before);
  });

  it('two restores at once make nothing twice', async () => {
    const data = { bookmarks: [{ type: 'bookmarks-bar', children: [{ title: 'F', children: [{ title: 'A', url: 'https://a.example/' }] }, { title: 'B', url: 'https://b.example/' }] }],
      archive: [{ url: 'https://arch.example/', title: 'Arch' }] };
    await Promise.all([backup.restoreBackup(data), backup.restoreBackup(data)]);
    expect(allMarks()).toEqual(['Bookmarks bar > B https://b.example/', 'Bookmarks bar > F > A https://a.example/', 'Other bookmarks > Tabs Archive > Arch https://arch.example/']);
    expect(folders()).toEqual(['Bookmarks bar', 'Bookmarks bar > F', 'Other bookmarks', 'Other bookmarks > Tabs Archive']);
  });

  it('a folder moved since doesn\'t come back empty; one empty in the backup does', async () => {
    const work = chrome._addBookmark({ parentId: '2', title: 'Work' });
    chrome._addBookmark({ parentId: work.id, title: 'Wiki', url: 'https://wiki.example/' });
    const result = await backup.restoreBackup({ bookmarks: [{ type: 'bookmarks-bar', children: [{ title: 'Work', children: [{ title: 'Wiki', url: 'https://wiki.example/' }] }, { title: 'Empty', children: [] }] }] });
    expect(folders()).toEqual(['Bookmarks bar', 'Bookmarks bar > Empty', 'Other bookmarks', 'Other bookmarks > Work']);
    expect(result.folders).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(result.bookmarks).toEqual({ added: 0, updated: 0, skipped: 1 });
  });

  it('a bookmark Chrome refuses is left out, and the rest is still restored', async () => {
    const real = chrome.bookmarks.create;
    chrome.bookmarks.create = async (properties) => { if (properties.url !== undefined) new URL(properties.url); return real(properties); }; // like Chrome: "Invalid URL."
    let result;
    try {
      result = await backup.restoreBackup({ bookmarks: [{ type: 'bookmarks-bar', children: [{ title: 'Bad', url: 'http://' }, { title: 'Good', url: 'https://good.example/' }] }],
        notes: [{ url: 'https://n.example/', note: 'n' }] });
    } finally { chrome.bookmarks.create = real; }
    expect(allMarks()).toEqual(['Bookmarks bar > Good https://good.example/']);
    expect(result.bookmarks).toEqual({ added: 1, updated: 0, skipped: 1 });
    expect(Object.keys(await store.getNotes())).toEqual(['https://n.example/']);
  });

  it('managed bookmarks (an organization\'s) are never copied', async () => {
    const result = await backup.restoreBackup({ bookmarks: [{ type: 'managed', title: 'Company', children: [{ title: 'Intranet', url: 'https://intra.example/' }] }] });
    expect(allMarks()).toEqual([]);
    expect(result.bookmarks.skipped).toBe(1);
  });

  it('every entry is counted: broken ones and a second note for the same page as left out', async () => {
    const result = await backup.restoreBackup({ notes: [null, { url: 'bad', note: 'x' }, { url: 'https://ok.example/', note: 7 }, { url: 'https://ok.example/', note: 'fine' }, { url: 'https://ok.example/', note: 'again' }],
      stars: ['x', { url: 5 }, { url: 'https://star.example/' }], snoozed: [{ url: 'https://z.example/', at: String(NOW + 1e7) }, { url: 'https://y.example/', at: NOW + 1e7 }],
      archive: [{ url: 'nope' }, { url: 'https://a.example/' }] });
    expect([sum(result.notes), sum(result.stars), sum(result.snoozed), sum(result.archive)]).toEqual([5, 3, 2, 2]);
    expect(result.notes).toEqual({ added: 1, updated: 0, skipped: 4 });
    expect((await store.getNotes())['https://ok.example/'].n).toBe('fine');
  });

  it('bookmarks deep in folders come back too', async () => {
    let node = { title: 'leaf', url: 'https://deep.example/' };
    for (let i = 45; i > 0; i--) node = { title: 'f' + i, children: [node] };
    const result = await backup.restoreBackup({ bookmarks: [{ type: 'bookmarks-bar', children: [node] }] });
    expect(result.bookmarks.added).toBe(1);
    expect(allMarks()).toHaveLength(1);
  });

  it('settings: only valid values; an invalid one leaves the current setting as it is', async () => {
    await localArea.set({ prefs: { theme: 'dark', titleLines: 1, accent: '#F87171' } });
    await backup.restoreBackup({ settings: { theme: 'purple', titleLines: '1', accent: '#abcdef', showAge: false, lang: 'el', bogus: 1 }, notes: [] }, { settings: true });
    const preferences = await store.getPreferences();
    expect([preferences.theme, preferences.titleLines, preferences.accent, preferences.showAge, preferences.lang]).toEqual(['dark', 1, '#ABCDEF', false, 'el']);
    expect('bogus' in preferences).toBe(false);
  });

  it('notes keep the time they were written', async () => {
    const bookmark = chrome._addBookmark({ parentId: '1', title: 'M', url: 'https://m.example/' });
    await localArea.set({ notes: { 'https://n.example/': { u: 'https://n.example/', n: 'n', t: 1000 } }, bmNotes: { [bookmark.id]: { u: bookmark.url, n: 'b', t: 2000 } } });
    await backup.restoreBackup(await roundTrip());
    expect((await store.getNotes())['https://n.example/'].t).toBe(1000);
    expect(Object.values(await store.getBookmarkNotes())[0].t).toBe(2000);
  });
});
