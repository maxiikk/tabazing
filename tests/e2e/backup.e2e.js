// Backup & Restore in real Chrome: "Back up" downloads tabazing-backup-<date>.zip (a "backup" folder of JSON files);
// after the data is gone, choosing that zip, or the unzipped folder's files, brings it all back; a second restore
// makes nothing twice; and what was there before a restore stays.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServers, launch, sleep } from './helpers/harness.js';

// The zip's files (Tabazing's zip stores them: no compression), read here (utils/backup.js needs the extension's chrome).
async function unzipFiles(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let end = buffer.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const out = new Map();
  let at = view.getUint32(end + 16, true);
  for (let i = view.getUint16(end + 10, true); i > 0; i--) {
    const size = view.getUint32(at + 20, true), nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true), commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    expect(view.getUint16(at + 10, true)).toBe(0);
    const name = Buffer.from(buffer.subarray(at + 46, at + 46 + nameLength)).toString('utf8');
    const data = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    out.set(name, Buffer.from(buffer.subarray(data, data + size)).toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

let server, browser, extension, temporaryDirectory;
beforeAll(async () => {
  server = await startServers();
  ({ browser, extension } = await launch());
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tabazing-backup-'));
  const cdpSession = await browser.target().createCDPSession();
  await cdpSession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: temporaryDirectory });
  await extension.run(() => chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } })); // no tour over the switcher
});
afterAll(async () => { await browser?.close(); await server?.close(); if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true }); });

const frameOf = (page) => page.frames().find((frame) => frame.url().includes('markup/switcher.html'));
async function openSwitcher(name) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${server.main}/p/${name}`);
  await page.bringToFront();
  await sleep(1500);
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyE'); await page.keyboard.up('Alt');
  await sleep(1500);
  const frame = frameOf(page);
  for (let i = 0; i < 3; i++) if (await frame.evaluate(() => !!document.querySelector('[data-testid="modal"]:not([hidden])'))) { await page.keyboard.press('Escape'); await sleep(400); }
  return { page, f: frame };
}
const by = (frame, id) => frame.$(`[data-testid="${id}"]`);
async function openBackup(frame) {
  await (await by(frame, 'menu-button')).click();
  await sleep(500);
  await (await by(frame, 'backup-button')).click();
  await sleep(600);
  expect(await frame.evaluate(() => !!document.querySelector('[data-testid="backup-overlay"]'))).toBe(true);
}
// What Tabazing keeps and the bookmarks, as text to compare.
const snapshot = () => extension.run(async () => {
  const marks = [];
  const walk = (node, trail) => { for (const child of node.children || []) { if (child.url) marks.push(trail + ' > ' + child.title + ' ' + child.url); else walk(child, trail + ' > ' + child.title); } };
  walk((await chrome.bookmarks.getTree())[0], '');
  const { notes = {}, stars = {}, bmNotes: bookmarkNotes = {} } = await chrome.storage.local.get(['notes', 'stars', 'bmNotes']);
  return { marks: marks.sort(), notes: Object.values(notes).map((x) => x.u + ' ' + x.n).sort(), stars: Object.keys(stars).sort(), bmNotes: Object.values(bookmarkNotes).map((x) => x.u + ' ' + x.n).sort() };
});
const waitDone = async (frame) => { for (let i = 0; i < 40; i++) { if (await frame.evaluate(() => !!document.querySelector('[data-testid="backup-done"], [data-testid="backup-error"], [data-testid="backup-bad"]'))) break; await sleep(250); } };

describe('Backup & Restore in Chrome', () => {
  let zipPath, before;
  it('backs up everything into tabazing-backup-<date>.zip', async () => {
    await extension.run(async (base) => {
      const work = await chrome.bookmarks.create({ parentId: '1', title: 'Work' });
      const wiki = await chrome.bookmarks.create({ parentId: work.id, title: 'Wiki', url: `${base}/p/Wiki` });
      await chrome.bookmarks.create({ parentId: '2', title: 'Docs', url: `${base}/p/Docs` });
      const now = Date.now();
      await chrome.storage.local.set({
        notes: { [`${base}/p/Note`]: { u: `${base}/p/Note`, n: 'a tab note', t: now } },
        bmNotes: { [wiki.id]: { u: `${base}/p/Wiki`, n: 'a wiki note', t: now } },
        stars: { [`${base}/p/Star`]: { u: `${base}/p/Star`, ti: 'Star', t: now } },
      });
    }, server.main);
    before = await snapshot();
    const { page, f: frame } = await openSwitcher('Home');
    await openBackup(frame);
    await (await by(frame, 'backup-export-button')).click();
    for (let i = 0; i < 40 && !fs.readdirSync(temporaryDirectory).some((x) => x.endsWith('.zip')); i++) await sleep(250);
    const name = fs.readdirSync(temporaryDirectory).find((x) => x.endsWith('.zip'));
    expect(name).toMatch(/^tabazing-backup-\d{4}-\d\d-\d\d\.zip$/);
    zipPath = path.join(temporaryDirectory, name);
    const files = await unzipFiles(new Uint8Array(fs.readFileSync(zipPath)));
    expect([...files.keys()].every((entryName) => entryName.startsWith('backup/') && entryName.endsWith('.json'))).toBe(true);
    expect(files.get('backup/notes.json')).toContain('a tab note');
    expect(files.get('backup/bookmark-notes.json')).toContain('a wiki note');
    expect(await frame.evaluate(() => !!document.querySelector('[data-testid="backup-overlay"]'))).toBe(true); // still open
    await page.close();
  });

  it('after the data is gone, the zip brings it all back; restoring again makes nothing twice', async () => {
    await extension.run(async () => {
      for (const id of ['1', '2']) for (const child of await chrome.bookmarks.getChildren(id)) await chrome.bookmarks.removeTree(child.id);
      await chrome.storage.local.remove(['notes', 'bmNotes', 'stars']);
    });
    expect((await snapshot()).marks).toEqual([]);
    const { page, f: frame } = await openSwitcher('Home');
    await openBackup(frame);
    const input = await by(frame, 'backup-zip-input');
    await input.uploadFile(zipPath);
    await waitDone(frame);
    expect(await frame.evaluate(() => !!document.querySelector('[data-testid="backup-done"]'))).toBe(true);
    expect(await snapshot()).toEqual(before);
    await input.uploadFile(zipPath);
    await sleep(300);
    await waitDone(frame);
    expect(await snapshot()).toEqual(before);
    await page.close();
  });

  it('from the unzipped folder\'s files too, keeping what was added since', async () => {
    const out = path.join(temporaryDirectory, 'unzipped', 'backup');
    fs.mkdirSync(out, { recursive: true });
    const files = await unzipFiles(new Uint8Array(fs.readFileSync(zipPath)));
    for (const [fileName, content] of files) fs.writeFileSync(path.join(out, path.basename(fileName)), content);
    await extension.run(async (base) => {
      await chrome.bookmarks.create({ parentId: '1', title: 'Since', url: `${base}/p/Since` });
      const { notes } = await chrome.storage.local.get('notes');
      notes[`${base}/p/Note`].n = 'changed since';
      await chrome.storage.local.set({ notes });
    }, server.main);
    const { page, f: frame } = await openSwitcher('Home');
    await openBackup(frame);
    // (Chrome gives a folder input the folder: its files, each with its path in it)
    await (await by(frame, 'backup-folder-input')).uploadFile(out);
    await waitDone(frame);
    expect(await frame.evaluate(() => !!document.querySelector('[data-testid="backup-done"]'))).toBe(true);
    const now = await snapshot();
    expect(now.marks).toEqual([...before.marks, ` > Bookmarks bar > Since ${server.main}/p/Since`].sort());
    expect(now.notes).toEqual(before.notes); // the backup's note over the one changed since
    await page.close();
  });
});
