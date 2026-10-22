import { describe, it, expect, vi, afterEach } from 'vitest';
import { ARCHIVE_FOLDER, archiveFolder, getArchived, addArchived, removeArchived } from '../../utils/archive.js';

const other = () => chrome._findBookmark('2');
const folderIn = (parent) => parent.children.filter((child) => !child.url && child.title === ARCHIVE_FOLDER);

afterEach(() => vi.useRealTimers());

describe('archiveFolder', () => {
  it('is null when there is no folder yet, without creating one', async () => {
    expect(await archiveFolder()).toBe(null);
    expect(chrome.bookmarks.create).not.toHaveBeenCalled();
    expect(folderIn(other())).toHaveLength(0);
  });
  it('creates the folder in Other bookmarks when asked, once', async () => {
    const folder = await archiveFolder(true);
    expect(folder).toMatchObject({ parentId: '2', title: ARCHIVE_FOLDER });
    expect((await archiveFolder(true)).id).toBe(folder.id);
    expect((await archiveFolder()).id).toBe(folder.id);
    expect(folderIn(other())).toHaveLength(1);
  });
  it('finds an existing folder, ignoring a bookmark with the same title', async () => {
    chrome._addBookmark({ title: ARCHIVE_FOLDER, url: 'https://a.com/' });
    const folder = chrome._addBookmark({ title: ARCHIVE_FOLDER });
    expect((await archiveFolder()).id).toBe(folder.id);
  });
  it('ignores an archive folder outside Other bookmarks', async () => {
    chrome._addBookmark({ parentId: '1', title: ARCHIVE_FOLDER });
    expect(await archiveFolder()).toBe(null);
  });
  it('prefers the folder typed "other", then id "2", then the second root child', async () => {
    let roots;
    chrome.bookmarks.getChildren.mockImplementation(async (id) => (id === '0' ? roots : []));
    const tree = (kids) => { roots = kids; };
    tree([{ id: '1' }, { id: '2' }, { id: '9', folderType: 'other' }]);
    await archiveFolder();
    tree([{ id: '1' }, { id: '7' }, { id: '2' }]);
    await archiveFolder();
    tree([{ id: '5' }, { id: '6' }]);
    await archiveFolder();
    tree([{ id: '5' }]);
    await archiveFolder();
    expect(chrome.bookmarks.getChildren.mock.calls.map((call) => call[0])).toEqual(['0', '9', '0', '2', '0', '6', '0', '5']);
  });
  it('reads only the root folders, never the whole tree', async () => {
    chrome._addBookmark({ title: ARCHIVE_FOLDER });
    await getArchived();
    expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
  });
  it('is null when the tree is empty or bookmarks are unavailable', async () => {
    chrome.bookmarks.getChildren.mockResolvedValueOnce([]);
    expect(await archiveFolder(true)).toBe(null);
    chrome.bookmarks.getChildren.mockResolvedValueOnce(undefined);
    expect(await archiveFolder(true)).toBe(null);
    const saved = chrome.bookmarks;
    chrome.bookmarks = undefined;
    try { expect(await archiveFolder(true)).toBe(null); } finally { chrome.bookmarks = saved; }
  });
});

describe('getArchived', () => {
  it('is empty without a folder', async () => {
    expect(await getArchived()).toEqual([]);
  });
  it('lists pages newest first, skipping subfolders', async () => {
    const folder = chrome._addBookmark({ title: ARCHIVE_FOLDER });
    chrome._addBookmark({ parentId: folder.id, id: 'a', title: 'Old', url: 'https://old.com/', dateAdded: 100 });
    chrome._addBookmark({ parentId: folder.id, id: 'b', title: '', url: 'https://new.com/', dateAdded: 300 });
    chrome._addBookmark({ parentId: folder.id, id: 'c', title: 'Sub folder' });
    chrome._addBookmark({ parentId: folder.id, id: 'd', title: 'Mid', url: 'https://mid.com/', dateAdded: 200 });
    expect(await getArchived()).toEqual([
      { id: 'b', url: 'https://new.com/', title: '', t: 300 },
      { id: 'd', url: 'https://mid.com/', title: 'Mid', t: 200 },
      { id: 'a', url: 'https://old.com/', title: 'Old', t: 100 },
    ]);
  });
  it('treats a missing dateAdded as 0 and a missing title as ""', async () => {
    const folder = chrome._addBookmark({ title: ARCHIVE_FOLDER });
    chrome.bookmarks.getChildren.mockImplementation(async (id) => (id === folder.id ? [{ id: 'x', url: 'https://x.com/' }] : id === '0' ? [{ id: '2', folderType: 'other' }] : [folder]));
    expect(await getArchived()).toEqual([{ id: 'x', url: 'https://x.com/', title: '', t: 0 }]);
  });
});

describe('addArchived', () => {
  it('creates the folder and bookmarks each page in it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(5000);
    const out = await addArchived([{ url: 'https://a.com/', title: 'A' }, { url: 'https://b.com/' }]);
    expect(out).toEqual([
      { id: expect.any(String), url: 'https://a.com/', title: 'A', t: 5000 },
      { id: expect.any(String), url: 'https://b.com/', title: 'https://b.com/', t: 5000 }, // no title: the URL stands in
    ]);
    const folder = folderIn(other())[0];
    expect(folder.children.map((bookmark) => bookmark.url)).toEqual(['https://a.com/', 'https://b.com/']);
    expect((await getArchived()).map((x) => x.id).sort()).toEqual(out.map((x) => x.id).sort());
  });
  it('reuses an existing folder', async () => {
    const folder = chrome._addBookmark({ title: ARCHIVE_FOLDER });
    await addArchived([{ url: 'https://a.com/', title: 'A' }]);
    expect(folderIn(other())).toHaveLength(1);
    expect(chrome.bookmarks.create).toHaveBeenCalledTimes(1);
    expect(chrome.bookmarks.create).toHaveBeenCalledWith({ parentId: folder.id, title: 'A', url: 'https://a.com/' });
  });
  it('falls back to now when Chrome gives no dateAdded', async () => {
    vi.useFakeTimers(); vi.setSystemTime(7777);
    await archiveFolder(true);
    chrome.bookmarks.create.mockResolvedValueOnce({ id: 'z', url: 'https://z.com/', title: 'Z' });
    expect(await addArchived([{ url: 'https://z.com/', title: 'Z' }])).toEqual([{ id: 'z', url: 'https://z.com/', title: 'Z', t: 7777 }]);
  });
  it('with no pages, only makes sure the folder exists', async () => {
    expect(await addArchived([])).toEqual([]);
    expect(folderIn(other())).toHaveLength(1);
  });
  it('throws when bookmarks are unavailable', async () => {
    chrome.bookmarks.getChildren.mockResolvedValueOnce([]);
    await expect(addArchived([{ url: 'https://a.com/' }])).rejects.toThrow('bookmarks unavailable');
  });
  it('passes on a bookmark error', async () => {
    await archiveFolder(true);
    chrome.bookmarks.create.mockRejectedValueOnce(new Error('quota'));
    await expect(addArchived([{ url: 'https://a.com/' }])).rejects.toThrow('quota');
  });
});

describe('removeArchived', () => {
  it('removes the given bookmarks and ignores ones already gone', async () => {
    const [firstArchived, secondArchived] = await addArchived([{ url: 'https://a.com/', title: 'A' }, { url: 'https://b.com/', title: 'B' }]);
    await expect(removeArchived(['nope', firstArchived.id])).resolves.toBeUndefined();
    expect((await getArchived()).map((x) => x.id)).toEqual([secondArchived.id]);
    expect(chrome.bookmarks.remove).toHaveBeenCalledTimes(2);
  });
  it('does nothing for an empty list', async () => {
    await removeArchived([]);
    expect(chrome.bookmarks.remove).not.toHaveBeenCalled();
  });
});
