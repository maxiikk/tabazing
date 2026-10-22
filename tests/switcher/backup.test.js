// Backup & Restore (in the menu): its dialog; "Back up" downloads tabazing-backup-<date>.zip; choosing the folder (or
// the zip) restores what it holds, without deleting or doubling anything, and says what was added, updated and skipped.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitFor, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, toastText } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';
import { zipFiles, unzipFiles, backupName } from '../../utils/backup.js';

const twoTabs = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const NOW = Date.now();
let clicked; // the downloads: { name, href }
const realURL = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
let blobs;
beforeEach(() => {
  clicked = [];
  blobs = new Map();
  URL.createObjectURL = (blob) => { const blobUrl = 'blob:tabazing/' + blobs.size; blobs.set(blobUrl, blob); return blobUrl; };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicked.push({ name: this.download, href: this.href }); });
});
afterEach(() => { URL.createObjectURL = realURL.create; URL.revokeObjectURL = realURL.revoke; vi.restoreAllMocks(); });

async function openBackup(switcher) {
  byTestId('backup-button').click();
  await waitFor(() => switcher.backupOpen());
  return byTestId('backup-overlay');
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
const bytesOf = (blob) => new Promise((ok) => { const reader = new FileReader(); reader.onload = () => ok(new Uint8Array(reader.result)); reader.readAsArrayBuffer(blob); });
// Every bookmark's address (each time it is bookmarked).
const markUrls = () => { const out = []; const walk = (node) => { if (node.url) out.push(node.url); (node.children || []).forEach(walk); }; walk(chrome._data.bookmarks); return out.sort(); };
const reportLines = () => allByTestId('backup-report-line').map((x) => x.textContent);
const line = (label, added, updated, skipped) => translate('backupLine', { what: translate(label), added, updated, skipped });

describe('the Backup & Restore button', () => {
  it('is in the menu (☰), before Settings, with its icon and name', async () => {
    await boot({ tabs: twoTabs });
    const button = byTestId('backup-button');
    expect(byTestId('drawer').contains(button)).toBe(true);
    expect(byTestId('backup-button-label').textContent).toBe(translate('backupTitle'));
    expect(translate('backupTitle')).toBe('Backup & Restore');
    expect(button.querySelector('svg')).toBeTruthy();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('opens its dialog (as Settings opens), the menu closed; Esc closes it, the focus back on the menu', async () => {
    const switcher = await boot({ tabs: twoTabs });
    switcher.openDrawer();
    const overlay = await openBackup(switcher);
    expect(byTestId('backup-panel', overlay).getAttribute('role')).toBe('dialog');
    expect(byTestId('backup-panel', overlay).getAttribute('aria-labelledby')).toBe('backup-heading');
    expect(byTestId('backup-title').textContent).toBe(translate('backupTitle'));
    expect(switcher.drawerOpen()).toBe(false);
    expect(document.activeElement).toBe(byTestId('backup-export-button'));
    expect(byTestId('backup-export').textContent).toContain(backupName() + '.zip');
    document.dispatchEvent(key('Escape'));
    expect(switcher.backupOpen()).toBe(false);
  });

  it('keys don\'t reach the switcher behind it', async () => {
    const switcher = await boot({ tabs: twoTabs });
    await openBackup(switcher);
    const before = switcher.state.selected;
    document.dispatchEvent(key('ArrowRight'));
    document.dispatchEvent(key('a'));
    expect(switcher.state.selected).toBe(before);
    expect(byTestId('search').value).toBe('');
    expect(switcher.backupOpen()).toBe(true);
  });
});

describe('backing up', () => {
  it('downloads tabazing-backup-<date>.zip, a "backup" folder of JSON files with everything in it', async () => {
    chrome._addBookmark({ parentId: '1', title: 'Docs', url: 'https://docs.example/' });
    await chrome.storage.local.set({
      notes: { 'https://a.example/': { u: 'https://a.example/', n: 'a note', t: NOW } },
      stars: { 'https://b.example/': { u: 'https://b.example/', ti: 'B', t: NOW } },
    });
    const switcher = await boot({ tabs: twoTabs });
    await openBackup(switcher);
    await switcher.exportBackup(byTestId('backup-export-button'));
    expect(clicked).toHaveLength(1);
    expect(clicked[0].name).toBe(backupName() + '.zip');
    expect(clicked[0].name).toMatch(/^tabazing-backup-\d{4}-\d\d-\d\d\.zip$/);
    const zip = await unzipFiles(await bytesOf(blobs.get(clicked[0].href)));
    expect([...zip.keys()].every((path) => /^backup\/[a-z-]+\.json$/.test(path))).toBe(true);
    expect(JSON.parse(zip.get('backup/notes.json'))).toEqual([{ url: 'https://a.example/', note: 'a note', t: NOW }]);
    expect(JSON.parse(zip.get('backup/stars.json'))).toEqual([{ url: 'https://b.example/', title: 'B', t: NOW }]);
    expect(zip.get('backup/bookmarks.json')).toContain('https://docs.example/');
    expect(toastText()).toBe(translate('backupExported', { name: clicked[0].name, notes: 1, stars: 1, bookmarks: 1 }));
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
    const switcher = await boot({ tabs: twoTabs });
    await openBackup(switcher);
    choose(byTestId('backup-folder-input'), [...backup().map((file) => fileOf('tabazing-backup-2026-10-21/' + file.name, file.data)), fileOf('tabazing-backup-2026-10-21/backup/readme.txt', 'x')]);
    await waitFor(() => byTestId('backup-done'));
    expect(markUrls()).toEqual(['https://docs.example/', 'https://mail.example/', 'https://only.example/']);
    expect((await chrome.bookmarks.get(mine.id))[0].title).toBe('My docs'); // the one there, as it was
    const notes = (await chrome.storage.local.get('notes')).notes;
    expect(notes['https://a.example/'].n).toBe('from the backup');
    expect(notes['https://keep.example/'].n).toBe('keep me');
    expect(notes['https://new.example/'].n).toBe('new note');
    expect(reportLines()).toEqual(expect.arrayContaining([line('backupKindBookmarks', 1, 0, 1), line('backupKindNotes', 1, 1, 0), line('backupKindStars', 1, 0, 0)]));
    expect(byTestId('backup-report-settings')).toBe(null); // not asked for
    expect((await chrome.storage.local.get('prefs')).prefs?.theme).not.toBe('dark');
  });

  it('from the zip, settings too when ticked; a second time adds nothing', async () => {
    await seeded();
    const switcher = await boot({ tabs: twoTabs });
    await openBackup(switcher);
    byTestId('backup-settings').checked = true;
    const zip = fileOf('tabazing-backup-2026-10-21.zip', zipFiles(backup()));
    choose(byTestId('backup-zip-input'), [zip]);
    await waitFor(() => byTestId('backup-done'));
    expect(byTestId('backup-report-settings').textContent).toBe(translate('backupSettingsDone'));
    expect((await chrome.storage.local.get('prefs')).prefs.theme).toBe('dark');
    const count = markUrls().length;
    choose(byTestId('backup-zip-input'), [zip]);
    await waitFor(() => byTestId('backup-done') && reportLines().includes(line('backupKindNotes', 0, 0, 2)));
    expect(markUrls().length).toBe(count);
    expect(count).toBe(3);
    expect(reportLines()).toEqual(expect.arrayContaining([line('backupKindBookmarks', 0, 0, 2), line('backupKindStars', 0, 0, 1)]));
  });

  it('a folder that isn\'t a backup: says so, changes nothing', async () => {
    await seeded();
    const switcher = await boot({ tabs: twoTabs });
    await openBackup(switcher);
    const before = JSON.stringify(await chrome.storage.local.get(null));
    choose(byTestId('backup-folder-input'), [fileOf('photos/a.json', '{}'), fileOf('photos/b.txt', 'x')]);
    await waitFor(() => byTestId('backup-bad'));
    expect(byTestId('backup-bad').textContent).toBe(translate('backupBad'));
    expect(JSON.stringify(await chrome.storage.local.get(null))).toBe(before);
  });

  it('a .zip that isn\'t one (or is damaged): says it isn\'t a backup, changes nothing', async () => {
    await seeded();
    const switcher = await boot({ tabs: twoTabs });
    await openBackup(switcher);
    const before = JSON.stringify(await chrome.storage.local.get(null));
    choose(byTestId('backup-zip-input'), [fileOf('tabazing-backup-2026-10-21.zip', 'just some text, not a zip')]);
    await waitFor(() => byTestId('backup-bad'));
    expect(byTestId('backup-error')).toBe(null);
    choose(byTestId('backup-zip-input'), [fileOf('tabazing-backup-2026-10-21.zip', zipFiles(backup()).slice(0, 60))]); // cut short
    await waitFor(() => byTestId('backup-bad'));
    expect(JSON.stringify(await chrome.storage.local.get(null))).toBe(before);
  });

  it('choosing keeps Tabazing open while the system\'s file dialog has the focus', async () => {
    const switcher = await boot({ tabs: twoTabs });
    await openBackup(switcher);
    const input = byTestId('backup-folder-input');
    const opened = vi.spyOn(input, 'click').mockImplementation(() => {});
    byTestId('backup-folder-button').click();
    expect(opened).toHaveBeenCalled();
    window.dispatchEvent(new Event('blur'));
    expect(switcher.backupOpen()).toBe(true);
    input.dispatchEvent(new Event('cancel'));
  });
});
