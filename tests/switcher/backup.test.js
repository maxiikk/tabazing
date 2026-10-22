// Backup & Restore (in the menu): its dialog; "Back up" downloads tabazing-backup-<date>.zip; choosing the folder (or
// the zip) restores what it holds, without deleting or doubling anything, and says what was added, updated and skipped.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitFor, key } from '../helpers/switcher.js';
import { boot, tid, tids, toastText } from '../helpers/quiet-boot.js';
import { t } from '../../utils/translations.js';
import { zipFiles, unzipFiles, backupName } from '../../utils/backup.js';

const AB = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const NOW = Date.now();
let clicked; // the downloads: { name, href }
const realURL = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
let blobs;
beforeEach(() => {
  clicked = [];
  blobs = new Map();
  URL.createObjectURL = (b) => { const u = 'blob:tabazing/' + blobs.size; blobs.set(u, b); return u; };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicked.push({ name: this.download, href: this.href }); });
});
afterEach(() => { URL.createObjectURL = realURL.create; URL.revokeObjectURL = realURL.revoke; vi.restoreAllMocks(); });

async function openBackup(sw) {
  tid('backup-btn').click();
  await waitFor(() => sw.backupOpen());
  return tid('backup-overlay');
}
// The input given these files (as the browser gives a chosen folder's: their path in it), then "change".
function choose(input, files) {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change'));
}
// A chosen file, as the browser gives it (jsdom's can't be read back: a stand-in that can).
const fileOf = (path, data) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return { name: path.split('/').pop(), webkitRelativePath: path.includes('/') ? path : '', size: bytes.length,
    text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
};
// What a Blob holds (jsdom's has no arrayBuffer()).
const bytesOf = (blob) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(new Uint8Array(r.result)); r.readAsArrayBuffer(blob); });
// Every bookmark's address (each time it is bookmarked).
const markUrls = () => { const out = []; const walk = (n) => { if (n.url) out.push(n.url); (n.children || []).forEach(walk); }; walk(chrome._data.bookmarks); return out.sort(); };
const reportLines = () => tids('backup-report-line').map((x) => x.textContent);
const line = (label, added, updated, skipped) => t('backupLine', { what: t(label), added, updated, skipped });

describe('the Backup & Restore button', () => {
  it('is in the menu (☰), before Settings, with its icon and name', async () => {
    await boot({ tabs: AB });
    const b = tid('backup-btn');
    expect(tid('drawer').contains(b)).toBe(true);
    expect(tid('backup-btn-label').textContent).toBe(t('backupTitle'));
    expect(t('backupTitle')).toBe('Backup & Restore');
    expect(b.querySelector('svg')).toBeTruthy();
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('opens its dialog (as Settings opens), the menu closed; Esc closes it, the focus back on the menu', async () => {
    const sw = await boot({ tabs: AB });
    sw.openDrawer();
    const o = await openBackup(sw);
    expect(tid('backup-panel', o).getAttribute('role')).toBe('dialog');
    expect(tid('backup-panel', o).getAttribute('aria-labelledby')).toBe('bk-h');
    expect(tid('backup-title').textContent).toBe(t('backupTitle'));
    expect(sw.drawerOpen()).toBe(false);
    expect(document.activeElement).toBe(tid('backup-export-btn'));
    expect(tid('backup-export').textContent).toContain(backupName() + '.zip');
    document.dispatchEvent(key('Escape'));
    expect(sw.backupOpen()).toBe(false);
  });

  it('keys don\'t reach the switcher behind it', async () => {
    const sw = await boot({ tabs: AB });
    await openBackup(sw);
    const before = sw.state.sel;
    document.dispatchEvent(key('ArrowRight'));
    document.dispatchEvent(key('a'));
    expect(sw.state.sel).toBe(before);
    expect(tid('search').value).toBe('');
    expect(sw.backupOpen()).toBe(true);
  });
});

describe('backing up', () => {
  it('downloads tabazing-backup-<date>.zip, a "backup" folder of JSON files with everything in it', async () => {
    chrome._addBookmark({ parentId: '1', title: 'Docs', url: 'https://docs.example/' });
    await chrome.storage.local.set({
      notes: { 'https://a.example/': { u: 'https://a.example/', n: 'a note', t: NOW } },
      stars: { 'https://b.example/': { u: 'https://b.example/', ti: 'B', t: NOW } },
    });
    const sw = await boot({ tabs: AB });
    await openBackup(sw);
    await sw.exportBackup(tid('backup-export-btn'));
    expect(clicked).toHaveLength(1);
    expect(clicked[0].name).toBe(backupName() + '.zip');
    expect(clicked[0].name).toMatch(/^tabazing-backup-\d{4}-\d\d-\d\d\.zip$/);
    const zip = await unzipFiles(await bytesOf(blobs.get(clicked[0].href)));
    expect([...zip.keys()].every((k) => /^backup\/[a-z-]+\.json$/.test(k))).toBe(true);
    expect(JSON.parse(zip.get('backup/notes.json'))).toEqual([{ url: 'https://a.example/', note: 'a note', t: NOW }]);
    expect(JSON.parse(zip.get('backup/stars.json'))).toEqual([{ url: 'https://b.example/', title: 'B', t: NOW }]);
    expect(zip.get('backup/bookmarks.json')).toContain('https://docs.example/');
    expect(toastText()).toBe(t('backupExported', { name: clicked[0].name, notes: 1, stars: 1, bookmarks: 1 }));
  });
});

describe('restoring', () => {
  const backup = () => [
    { name: 'backup/info.json', data: JSON.stringify({ app: 'Tabazing', version: '6.12.0' }) },
    { name: 'backup/notes.json', data: JSON.stringify([{ url: 'https://a.example/', note: 'from the backup', t: NOW }, { url: 'https://new.example/', note: 'new note', t: NOW }]) },
    { name: 'backup/stars.json', data: JSON.stringify([{ url: 'https://b.example/', title: 'B', t: NOW }]) },
    { name: 'backup/bookmarks.json', data: JSON.stringify([{ type: 'bookmarks-bar', title: 'Bookmarks bar', children: [{ title: 'Docs', url: 'https://docs.example/' }, { title: 'Mail', url: 'https://mail.example/' }] }]) },
    { name: 'backup/settings.json', data: JSON.stringify({ theme: 'dark' }) },
  ];
  async function seeded() {
    const mine = chrome._addBookmark({ parentId: '1', title: 'My docs', url: 'https://docs.example/' });
    chrome._addBookmark({ parentId: '1', title: 'Only mine', url: 'https://only.example/' });
    await chrome.storage.local.set({ notes: { 'https://a.example/': { u: 'https://a.example/', n: 'old note', t: NOW }, 'https://keep.example/': { u: 'https://keep.example/', n: 'keep me', t: NOW } } });
    return mine;
  }

  it('from the chosen folder: adds what is new, the backup\'s notes over the old, deletes nothing, says what it did', async () => {
    const mine = await seeded();
    const sw = await boot({ tabs: AB });
    await openBackup(sw);
    choose(tid('backup-folder-input'), [...backup().map((f) => fileOf('tabazing-backup-2026-10-21/' + f.name, f.data)), fileOf('tabazing-backup-2026-10-21/backup/readme.txt', 'x')]);
    await waitFor(() => tid('backup-done'));
    expect(markUrls()).toEqual(['https://docs.example/', 'https://mail.example/', 'https://only.example/']);
    expect((await chrome.bookmarks.get(mine.id))[0].title).toBe('My docs'); // the one there, as it was
    const notes = (await chrome.storage.local.get('notes')).notes;
    expect(notes['https://a.example/'].n).toBe('from the backup');
    expect(notes['https://keep.example/'].n).toBe('keep me');
    expect(notes['https://new.example/'].n).toBe('new note');
    expect(reportLines()).toEqual(expect.arrayContaining([line('backupKindBookmarks', 1, 0, 1), line('backupKindNotes', 1, 1, 0), line('backupKindStars', 1, 0, 0)]));
    expect(tid('backup-report-settings')).toBe(null); // not asked for
    expect((await chrome.storage.local.get('prefs')).prefs?.theme).not.toBe('dark');
  });

  it('from the zip, settings too when ticked; a second time adds nothing', async () => {
    await seeded();
    const sw = await boot({ tabs: AB });
    await openBackup(sw);
    tid('backup-settings').checked = true;
    const zip = fileOf('tabazing-backup-2026-10-21.zip', zipFiles(backup()));
    choose(tid('backup-zip-input'), [zip]);
    await waitFor(() => tid('backup-done'));
    expect(tid('backup-report-settings').textContent).toBe(t('backupSettingsDone'));
    expect((await chrome.storage.local.get('prefs')).prefs.theme).toBe('dark');
    const count = markUrls().length;
    choose(tid('backup-zip-input'), [zip]);
    await waitFor(() => tid('backup-done') && reportLines().includes(line('backupKindNotes', 0, 0, 2)));
    expect(markUrls().length).toBe(count);
    expect(count).toBe(3);
    expect(reportLines()).toEqual(expect.arrayContaining([line('backupKindBookmarks', 0, 0, 2), line('backupKindStars', 0, 0, 1)]));
  });

  it('a folder that isn\'t a backup: says so, changes nothing', async () => {
    await seeded();
    const sw = await boot({ tabs: AB });
    await openBackup(sw);
    const before = JSON.stringify(await chrome.storage.local.get(null));
    choose(tid('backup-folder-input'), [fileOf('photos/a.json', '{}'), fileOf('photos/b.txt', 'x')]);
    await waitFor(() => tid('backup-bad'));
    expect(tid('backup-bad').textContent).toBe(t('backupBad'));
    expect(JSON.stringify(await chrome.storage.local.get(null))).toBe(before);
  });

  it('a .zip that isn\'t one (or is damaged): says it isn\'t a backup, changes nothing', async () => {
    await seeded();
    const sw = await boot({ tabs: AB });
    await openBackup(sw);
    const before = JSON.stringify(await chrome.storage.local.get(null));
    choose(tid('backup-zip-input'), [fileOf('tabazing-backup-2026-10-21.zip', 'just some text, not a zip')]);
    await waitFor(() => tid('backup-bad'));
    expect(tid('backup-error')).toBe(null);
    choose(tid('backup-zip-input'), [fileOf('tabazing-backup-2026-10-21.zip', zipFiles(backup()).slice(0, 60))]); // cut short
    await waitFor(() => tid('backup-bad'));
    expect(JSON.stringify(await chrome.storage.local.get(null))).toBe(before);
  });

  it('choosing keeps Tabazing open while the system\'s file dialog has the focus', async () => {
    const sw = await boot({ tabs: AB });
    await openBackup(sw);
    const input = tid('backup-folder-input');
    const opened = vi.spyOn(input, 'click').mockImplementation(() => {});
    tid('backup-folder-btn').click();
    expect(opened).toHaveBeenCalled();
    window.dispatchEvent(new Event('blur'));
    expect(sw.backupOpen()).toBe(true);
    input.dispatchEvent(new Event('cancel'));
  });
});
