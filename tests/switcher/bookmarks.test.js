// The bookmarks view (the bookmark button after History, Ctrl+Shift+O): every Chrome bookmark as a tree with previews;
// open (here, behind), big preview, the ⋯ menus; edit (with its note), add, delete (one, ticked ones, a folder with its
// contents; asking first for many; Undo), move (drag, Move to…, Ctrl+↑ ↓), sort; the search box (name, site, address,
// note; typos forgiven); Duplicates, stars; a bookmark's own note (not the page's), on this computer only;
// what comes back next time; the keys.
import { describe, it, expect } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, toastText, toastButton } from './quiet-boot.js';
import { t } from '../../utils/translations.js';

const AB = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const PV = 'data:image/jpeg;base64,BBBB';
// Bookmarks bar: Docs (bookmark), Work (folder: Wiki, Tracker); Other bookmarks: Recipes (bookmark).
function seed() {
  const docs = chrome._addBookmark({ parentId: '1', title: 'Docs', url: 'https://docs.example/' });
  const work = chrome._addBookmark({ parentId: '1', title: 'Work' });
  const wiki = chrome._addBookmark({ parentId: work.id, title: 'Wiki', url: 'https://wiki.example/page' });
  const tracker = chrome._addBookmark({ parentId: work.id, title: 'Tracker', url: 'https://tracker.example/' });
  const recipes = chrome._addBookmark({ parentId: '2', title: 'Recipes', url: 'https://food.example/recipes' });
  return { docs, work, wiki, tracker, recipes };
}
const rows = () => [...tid('bookmarks-tree').children];
const titles = () => rows().map((r) => tid('bmv-title', r).textContent);
const row = (title) => rows().find((r) => tid('bmv-title', r).textContent === title);
const sel = () => tid('bmv-title', rows().find((r) => r.getAttribute('aria-selected') === 'true')).textContent;
const menuLabels = () => tids('menu-item').map((b) => b.textContent);
const menuItem = (label) => tids('menu-item').find((b) => b.textContent === label);
const mark = (id) => chrome._findBookmark(id);
const kidTitles = (id) => mark(id).children.map((n) => n.title);
async function open(sw) {
  tid('bookmarks-btn').click();
  await waitFor(() => sw.bookmarksOpen() && tid('bookmarks-tree'));
  await tick(10);
}
async function find(text) {
  const box = tid('bookmarks-search');
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(130); // (it waits for a pause in typing)
}
const submit = (testid) => tid(testid).dispatchEvent(new Event('submit', { cancelable: true }));

describe('the bookmarks button', () => {
  it('is in the menu (☰), after History, with its icon, name and key; Ctrl+Shift+O opens and closes it', async () => {
    const sw = await boot({ tabs: AB });
    const b = tid('bookmarks-btn');
    expect(tid('history-btn-item').nextElementSibling).toBe(tid('bookmarks-btn-item'));
    expect(tid('bookmarks-btn-label').textContent).toBe(t('bmvTitle'));
    expect(tid('bookmarks-btn-key').textContent).toBe('Ctrl+Shift+O');
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
    key('O', { code: 'KeyO', ctrlKey: true, shiftKey: true });
    await waitFor(() => sw.bookmarksOpen());
    key('O', { code: 'KeyO', ctrlKey: true, shiftKey: true, target: tid('bookmarks-search') });
    expect(sw.bookmarksOpen()).toBe(false);
    expect(sw.PAL_ACTIONS.some((a) => a.id === 'open-bookmarks')).toBe(true);
  });
});

describe('the tree', () => {
  it('Chrome\'s folders start open; a folder opens and closes with a click (its rows indented by depth)', async () => {
    seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(titles()).toEqual(['Bookmarks bar', 'Docs', 'Work', 'Other bookmarks', 'Recipes']);
    expect(row('Work').getAttribute('aria-expanded')).toBe('false');
    row('Work').click();
    expect(titles()).toEqual(['Bookmarks bar', 'Docs', 'Work', 'Wiki', 'Tracker', 'Other bookmarks', 'Recipes']);
    expect(row('Wiki').getAttribute('aria-level')).toBe('3');
    expect(row('Work').getAttribute('aria-expanded')).toBe('true');
    expect(tid('bmv-count', row('Work')).textContent).toBe(t('bmvItems', { count: 2 }));
    expect(tid('bookmarks-count').textContent).toBe('4');
    row('Work').click();
    expect(titles()).not.toContain('Wiki');
  });

  it('what was open, the selected row and the search come back next time', async () => {
    seed();
    let sw = await boot({ tabs: AB });
    await open(sw);
    row('Work').click();
    sw.bmvSelect(titles().indexOf('Tracker'));
    sw.closeBookmarks();
    await tick(20);
    sw = await boot({ tabs: AB });
    await open(sw);
    expect(titles()).toContain('Tracker');
    expect(sel()).toBe('Tracker');
    await find('recipes');
    sw.closeBookmarks();
    await tick(20);
    sw = await boot({ tabs: AB });
    await open(sw);
    expect(tid('bookmarks-search').value).toBe('recipes');
    expect(titles()).toEqual(['Other bookmarks', 'Recipes']);
  });

  it('a bookmark shows its preview when there is one, else its icon; its site; a click opens it, a middle-click behind', async () => {
    seed();
    await chrome.storage.local.set({ 'pv:https://docs.example/': { img: PV, t: Date.now() } });
    const sw = await boot({ tabs: AB });
    await open(sw);
    await waitFor(() => tid('bmv-preview', row('Docs')));
    expect(tid('bmv-preview', row('Docs')).src).toBe(PV);
    expect(tid('bmv-favicon', row('Recipes'))).not.toBe(null);
    expect(tid('bmv-address', row('Recipes')).textContent).toBe('food.example');
    row('Recipes').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    await waitFor(() => chrome.tabs.create.mock.calls.length === 1);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://food.example/recipes', active: false }));
    expect(sw.state.done).toBe(false);
    row('Recipes').click();
    await waitFor(() => sw.state.done);
  });

  it('the Tabs Archive folder says what it is, and its menu opens the Archive view', async () => {
    seed();
    const arch = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: arch.id, title: 'Old page', url: 'https://old.example/' });
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(tid('bmv-archive-tag', row('Tabs Archive')).textContent).toBe(t('bmvArchiveTag'));
    tid('quick-more', row('Tabs Archive')).click();
    expect(menuLabels()[0]).toBe(t('palOpenArchive'));
    menuItem(t('palOpenArchive')).click();
    await waitFor(() => sw.archiveOpen());
    expect(sw.bookmarksOpen()).toBe(false);
  });

  it('nothing bookmarked: says so', async () => {
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(tid('bookmarks-empty').hidden).toBe(false);
    expect(tid('bookmarks-empty').textContent).toBe(t('bmvEmpty'));
  });
});

describe('the search box', () => {
  it('finds bookmarks by name, site, address or note (typos forgiven) with their folder path, words marked; Esc empties it', async () => {
    const s = seed();
    await chrome.storage.local.set({ bmNotes: { [s.recipes.id]: { u: 'https://food.example/recipes', n: 'grandma lasagna', t: Date.now() } } });
    const sw = await boot({ tabs: AB });
    await open(sw);
    await find('wiki');
    expect(titles()).toEqual(['Bookmarks bar', 'Work', 'Wiki']); // inside the closed folder: shown with it
    expect(tid('bmv-path', row('Wiki')).textContent).toBe(' · Bookmarks bar › Work');
    expect(tids('search-highlight', row('Wiki')).length).toBeGreaterThan(0);
    await find('tracker.example');
    expect(titles()).toEqual(['Bookmarks bar', 'Work', 'Tracker']);
    await find('lasagna');
    expect(titles()).toEqual(['Other bookmarks', 'Recipes']);
    expect(row('Recipes').getAttribute('aria-selected')).toBe('true'); // the first bookmark found, not its folder
    await find('recipse'); // a typo
    expect(titles()).toContain('Recipes');
    await find('zzzzqqq');
    expect(tid('bookmarks-empty').textContent).toBe(t('bmvNoMatch'));
    key('Escape');
    expect(tid('bookmarks-search').value).toBe('');
    expect(sw.bookmarksOpen()).toBe(true);
    key('Escape');
    expect(sw.bookmarksOpen()).toBe(false);
    expect(document.activeElement).toBe(tid('menu-btn'));
  });

  it('Enter right after typing (before the search\'s pause) opens what the typed text finds', async () => {
    seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(sel()).toBe('Bookmarks bar');
    const box = tid('bookmarks-search');
    box.value = 'recipes';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    key('Enter', { target: box }); // no pause: the search hasn't run yet
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://food.example/recipes', active: true }));
  });
});

describe('editing and adding', () => {
  it('Edit: name, address, folder (a move) and its note; Undo puts it all back', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('bmv-edit', row('Docs')).click();
    await waitFor(() => tid('bmv-edit-form'));
    expect(tid('bmv-edit-name').value).toBe('Docs');
    expect(tid('bmv-edit-url').value).toBe('https://docs.example/');
    tid('bmv-edit-name').value = 'Team docs';
    tid('bmv-edit-url').value = 'docs.example/team';
    tid('bmv-edit-folder').value = s.work.id;
    tid('bmv-edit-note').value = 'the handbook';
    submit('bmv-edit-form');
    await waitFor(() => row('Team docs'));
    expect(mark(s.docs.id)).toMatchObject({ title: 'Team docs', url: 'https://docs.example/team', parentId: s.work.id });
    expect(titles()).toEqual(['Bookmarks bar', 'Work', 'Wiki', 'Tracker', 'Team docs', 'Other bookmarks', 'Recipes']); // its folder opened
    expect(tid('bmv-note-text', row('Team docs')).textContent).toBe('the handbook');
    expect(toastText()).toBe(t('bmvSaved'));
    toastButton().click();
    await waitFor(() => row('Docs'));
    expect(mark(s.docs.id)).toMatchObject({ title: 'Docs', url: 'https://docs.example/', parentId: '1' });
    expect(kidTitles('1')[0]).toBe('Docs');
    expect(sw.bmNoteOf(s.docs.id)).toBe('');
  });

  it('an address that isn\'t one is refused, with a message', async () => {
    seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('bmv-edit', row('Docs')).click();
    await waitFor(() => tid('bmv-edit-form'));
    tid('bmv-edit-url').value = 'http://exa mple';
    submit('bmv-edit-form');
    await tick(10);
    expect(tid('bmv-edit-error').hidden).toBe(false);
    expect(tid('bmv-edit-error').textContent).toBe(t('bmvBadUrl'));
    expect(chrome.bookmarks.update).not.toHaveBeenCalled();
  });

  it('Add bookmark starts as the page Tabazing was opened over, says where it is bookmarked already; Undo takes it out', async () => {
    const s = seed();
    chrome._addBookmark({ parentId: '2', title: 'A again', url: 'https://a.example/' });
    const sw = await boot({ tabs: AB });
    await open(sw);
    row('Work').click(); // selects it (and opens it)
    tid('bookmarks-add').click();
    await waitFor(() => tid('bmv-edit-form'));
    expect(tid('bmv-edit-url').value).toBe('https://a.example/');
    expect(tid('bmv-edit-folder').value).toBe(s.work.id);
    await waitFor(() => !tid('bmv-edit-have').hidden);
    expect(tid('bmv-edit-have').textContent).toBe(t('markHave', { folders: 'Other bookmarks' }));
    submit('bmv-edit-form');
    await waitFor(() => mark(s.work.id).children.length === 3);
    expect(mark(s.work.id).children[2]).toMatchObject({ title: 'A', url: 'https://a.example/' });
    await waitFor(() => toastText() === t('bmvMade'));
    toastButton().click();
    await waitFor(() => mark(s.work.id).children.length === 2);
  });

  it('New folder, inside the selected one', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    row('Work').click();
    tid('bookmarks-new-folder').click();
    await waitFor(() => tid('bmv-edit-form') && !tid('bmv-edit-url'));
    tid('bmv-edit-name').value = 'Later';
    submit('bmv-edit-form');
    await waitFor(() => row('Later'));
    expect(row('Later').dataset.testid).toBe('bmv-folder');
    expect(kidTitles(s.work.id)).toEqual(['Wiki', 'Tracker', 'Later']);
  });
});

describe('deleting', () => {
  it('a bookmark (its trash, or Del): gone; Undo puts it back where it was, with its note', async () => {
    const s = seed();
    await chrome.storage.local.set({ bmNotes: { [s.docs.id]: { u: 'https://docs.example/', n: 'the handbook', t: Date.now() } } });
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('bmv-delete', row('Docs')).click();
    await waitFor(() => !row('Docs'));
    expect(chrome.bookmarks.remove).toHaveBeenCalledWith(s.docs.id);
    expect(toastText()).toBe(t('bmvDeleted', { count: 1 }));
    expect((await chrome.storage.local.get('bmNotes')).bmNotes[s.docs.id]).toBe(undefined);
    toastButton().click();
    await waitFor(() => row('Docs'));
    const back = mark('1').children[0];
    expect(back).toMatchObject({ title: 'Docs', url: 'https://docs.example/' }); // first again
    expect((await chrome.storage.local.get('bmNotes')).bmNotes[back.id].n).toBe('the handbook');
  });

  it('ticked ones together: tick boxes (folders too), Shift+click for a range, Ctrl+A; the bar deletes them', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(tid('bmv-pick', row('Bookmarks bar'))).toBe(null); // Chrome's own folders can't be ticked
    tid('bmv-pick', row('Docs')).click();
    tid('bmv-pick', row('Recipes')).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(['Docs', 'Work', 'Recipes'].map((x) => row(x).getAttribute('aria-checked'))).toEqual(['true', 'true', 'true']);
    expect(tid('bookmarks-selected').textContent).toBe(t('bmvSelected', { count: 3 }));
    tid('bookmarks-delete-selected').click();
    await waitFor(() => !row('Docs') && !row('Recipes') && !row('Work'));
    expect(toastText()).toBe(t('bmvDeleted', { count: 4 })); // Docs, Recipes and Work's two
    toastButton().click();
    await waitFor(() => row('Docs') && row('Recipes') && row('Work'));
    expect(kidTitles(mark('1').children.find((n) => n.title === 'Work').id)).toEqual(['Wiki', 'Tracker']);
    tid('bookmarks-close').focus();
    key('a', { code: 'KeyA', ctrlKey: true });
    expect(tid('bookmarks-selected').textContent).toBe(t('bmvSelected', { count: 3 })); // the rows shown, but Chrome's own
    key('Escape');
    expect(tid('bookmarks-selection').hidden).toBe(true);
    expect(sw.bookmarksOpen()).toBe(true);
  });

  it('a folder with what it holds; ten bookmarks or more ask first', async () => {
    const s = seed();
    const big = chrome._addBookmark({ parentId: '2', title: 'Big' });
    for (let i = 0; i < 12; i++) chrome._addBookmark({ parentId: big.id, title: 'Item ' + i, url: `https://i${i}.example/` });
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('bmv-delete', row('Work')).click();
    await waitFor(() => !row('Work'));
    expect(chrome.bookmarks.removeTree).toHaveBeenCalledWith(s.work.id);
    expect(toastText()).toBe(t('bmvFolderDeleted', { name: 'Work' }));
    tid('bmv-delete', row('Big')).click();
    await waitFor(() => tid('bmv-delete-ask'));
    expect(tid('dialog-title', tid('bmv-delete-ask')).textContent).toBe(t('bmvDeleteFolderAsk', { name: 'Big' }));
    tid('bmv-delete-ask-cancel').click();
    expect(row('Big')).not.toBe(undefined);
    tid('bmv-delete', row('Big')).click();
    await waitFor(() => tid('bmv-delete-ask-ok'));
    tid('bmv-delete-ask-ok').click();
    await waitFor(() => !row('Big'));
  });
});

describe('moving and sorting', () => {
  it('Move to… the ticked rows; Undo puts them back', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('bmv-pick', row('Docs')).click();
    tid('bmv-pick', row('Recipes')).click();
    tid('bookmarks-move-selected').click();
    await waitFor(() => tid('bmv-move-form'));
    tid('bmv-move-folder').value = s.work.id;
    submit('bmv-move-form');
    await waitFor(() => kidTitles(s.work.id).length === 4);
    expect(kidTitles(s.work.id)).toEqual(['Wiki', 'Tracker', 'Docs', 'Recipes']);
    expect(toastText()).toBe(t('bmvMoved', { count: 2 }));
    toastButton().click();
    await waitFor(() => kidTitles(s.work.id).length === 2);
    expect(kidTitles('1')).toEqual(['Docs', 'Work']);
    expect(kidTitles('2')).toEqual(['Recipes']);
  });

  it('dragging a row onto a folder puts it in; above another row, before it', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    const drag = (from, to, y) => {
      const dt = { setData() {}, effectAllowed: '', dropEffect: '' };
      to.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40, left: 0, width: 100 });
      for (const [node, type] of [[from, 'dragstart'], [to, 'dragover'], [to, 'drop'], [from, 'dragend']]) {
        const e = new Event(type, { bubbles: true, cancelable: true });
        e.dataTransfer = dt;
        e.clientY = y;
        node.dispatchEvent(e);
      }
    };
    drag(row('Recipes'), row('Work'), 20); // the middle of a folder
    await waitFor(() => kidTitles(s.work.id).length === 3);
    expect(kidTitles(s.work.id)).toEqual(['Wiki', 'Tracker', 'Recipes']);
    await waitFor(() => row('Recipes'));
    drag(row('Recipes'), row('Docs'), 5); // the top of a row
    await waitFor(() => kidTitles('1').length === 3);
    expect(kidTitles('1')).toEqual(['Recipes', 'Docs', 'Work']);
  });

  it('Ctrl+↑ ↓ moves the selected row in its folder; a folder sorts by name or date added', async () => {
    const s = seed();
    const zed = chrome._addBookmark({ parentId: s.work.id, title: 'Alpha', url: 'https://alpha.example/' });
    const sw = await boot({ tabs: AB });
    await open(sw);
    sw.bmvSelect(titles().indexOf('Docs'));
    key('ArrowDown', { ctrlKey: true });
    await waitFor(() => kidTitles('1')[0] === 'Work');
    expect(kidTitles('1')).toEqual(['Work', 'Docs']);
    expect(sel()).toBe('Docs');
    key('ArrowUp', { ctrlKey: true });
    await waitFor(() => kidTitles('1')[0] === 'Docs');
    tid('quick-more', row('Work')).click();
    menuItem(t('bmvSortName')).click();
    await waitFor(() => kidTitles(s.work.id)[0] === 'Alpha');
    expect(kidTitles(s.work.id)).toEqual(['Alpha', 'Tracker', 'Wiki']);
    await waitFor(() => toastText() === t('bmvSorted', { name: 'Work' }));
    toastButton().click();
    await waitFor(() => kidTitles(s.work.id).join() === 'Wiki,Tracker,Alpha');
    expect(zed.id).toBeTruthy();
  });
});

describe('opening many', () => {
  it('a folder\'s Open all: behind Tabazing, in a new window, or as a tab group named after it', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('quick-more', row('Work')).click();
    expect(menuLabels()).toEqual([t('bmvAddHere'), t('bmvFolderHere'), t('bmvOpenAll', { count: 2 }), t('bmvOpenAllWindow'), t('bmvOpenAllGroup'),
      t('bmvSortName'), t('bmvSortDate'), t('bmvSelect'), t('bmvRename'), t('bmvDeleteFolder')]);
    menuItem(t('bmvOpenAllGroup')).click();
    await waitFor(() => chrome.tabGroups.update.mock.calls.length === 1);
    expect(chrome.tabs.create.mock.calls.map(([p]) => [p.url, p.active])).toEqual([['https://wiki.example/page', false], ['https://tracker.example/', false]]);
    expect(chrome.tabGroups.update.mock.calls[0][1]).toEqual({ title: 'Work' });
    tid('quick-more', row('Work')).click();
    menuItem(t('bmvOpenAllWindow')).click();
    await waitFor(() => chrome.windows.create.mock.calls.length === 1);
    expect(chrome.windows.create.mock.calls[0][0]).toEqual({ url: ['https://wiki.example/page', 'https://tracker.example/'], focused: false });
    expect(s.work.id).toBeTruthy();
  });

  it('more than 15 tabs at once asks first', async () => {
    const big = chrome._addBookmark({ parentId: '2', title: 'Big' });
    for (let i = 0; i < 20; i++) chrome._addBookmark({ parentId: big.id, title: 'Item ' + i, url: `https://i${i}.example/` });
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('quick-more', row('Big')).click();
    menuItem(t('bmvOpenAll', { count: 20 })).click();
    await waitFor(() => tid('bmv-open-ask'));
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    tid('bmv-open-ask-ok').click();
    await waitFor(() => chrome.tabs.create.mock.calls.length === 20);
  });
});

describe('Duplicates and stars', () => {
  it('Duplicates shows only the bookmarks of an address bookmarked twice or more, each with how many', async () => {
    seed();
    chrome._addBookmark({ parentId: '2', title: 'Docs again', url: 'https://docs.example/' });
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(tid('bookmarks-dupes').hidden).toBe(false);
    tid('bookmarks-dupes').click();
    await tick(130);
    expect(titles()).toEqual(['Bookmarks bar', 'Docs', 'Other bookmarks', 'Docs again']);
    expect(tid('bmv-dupe', row('Docs')).textContent).toBe(t('bmvDupeTag', { count: 2 }));
    key('Escape'); // the filter goes first
    await tick(130);
    expect(titles()).toContain('Recipes');
    expect(sw.bookmarksOpen()).toBe(true);
  });

  it('starred pages not bookmarked yet go into a "Tabazing stars" folder; Undo takes it out', async () => {
    seed();
    await chrome.storage.local.set({ stars: {
      'https://starred.example/': { u: 'https://starred.example/', ti: 'Starred one', t: Date.now() },
      'https://docs.example/': { u: 'https://docs.example/', ti: 'Docs', t: Date.now() },
    } });
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(tid('bookmarks-stars-label').textContent).toBe(t('bmvImportStars', { count: 1 }));
    tid('bookmarks-stars').click();
    await waitFor(() => row(t('bmvStarsFolder')));
    expect(titles()).toContain('Starred one');
    expect(tid('bookmarks-stars').hidden).toBe(true);
    toastButton().click();
    await waitFor(() => !row(t('bmvStarsFolder')));
  });
});

describe('a bookmark\'s note', () => {
  it('is the bookmark\'s own (kept by its id), not the page\'s note; shown under its address; on this computer only', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('quick-note', row('Docs')).click();
    const box = tid('note-input');
    expect(tid('note-label').textContent).toBe(t('bmvNoteTitle'));
    box.value = 'read the onboarding';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    tid('note-close').click();
    await waitFor(() => tid('bmv-note-text', row('Docs')).textContent === 'read the onboarding');
    expect((await chrome.storage.local.get('bmNotes')).bmNotes[s.docs.id].n).toBe('read the onboarding');
    expect((await chrome.storage.local.get('notes')).notes || {}).toEqual({}); // the page has no note
    expect(Object.keys(await chrome.storage.sync.get(null))).toEqual([]); // on this computer only
  });

  it('notes of bookmarks that are gone (deleted in Chrome\u2019s own manager) go', async () => {
    seed();
    await chrome.storage.local.set({ bmNotes: { 12345: { u: 'https://gone.example/', n: 'orphan', t: Date.now() } } });
    const sw = await boot({ tabs: AB });
    await open(sw);
    await waitFor(async () => true);
    await tick(20);
    expect((await chrome.storage.local.get('bmNotes')).bmNotes[12345]).toBe(undefined);
    expect(sw.bmNoteOf('12345')).toBe('');
  });
});

describe('the menu and the keys', () => {
  it('a bookmark\'s ⋯', async () => {
    seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('quick-more', row('Docs')).click();
    expect(menuLabels()).toEqual([
      t('historyOpen'), t('historyNewWindow'), t('historyBehind'), t('historyBig'), t('copyLink'), t('star'), t('noteAdd'),
      t('historySnooze'), t('bmvSelect'), t('bmvEdit'), t('bmvDelete'),
    ]);
  });

  it('↑ ↓ from the box, → opens a folder, ← closes it, * opens those beside, Enter opens, Ctrl+Enter behind, Space previews, Del deletes', async () => {
    const s = seed();
    chrome._addBookmark({ parentId: '1', title: 'Play' });
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(document.activeElement).toBe(tid('bookmarks-search'));
    expect(sel()).toBe('Bookmarks bar');
    key('ArrowDown'); key('ArrowDown');
    expect(sel()).toBe('Work');
    key('ArrowRight');
    expect(titles()).toContain('Wiki');
    key('ArrowLeft');
    expect(titles()).not.toContain('Wiki');
    tid('bookmarks-close').focus();
    key('*'); // every folder beside Work opens
    expect(row('Work').getAttribute('aria-expanded')).toBe('true');
    expect(row('Play').getAttribute('aria-expanded')).toBe('true');
    key('End');
    expect(sel()).toBe('Recipes');
    key('Home');
    expect(sel()).toBe('Bookmarks bar');
    key('ArrowDown');
    expect(sel()).toBe('Docs');
    key(' ', { ctrlKey: true });
    expect(row('Docs').getAttribute('aria-checked')).toBe('true');
    key(' ');
    expect(tid('big-preview-title').textContent).toBe('Docs');
    expect(tids('big-preview-info-line').map((x) => x.textContent)).toContain('Bookmarks bar');
    key('Escape');
    expect(document.activeElement).toBe(tid('bookmarks-search'));
    key('Enter', { ctrlKey: true });
    await waitFor(() => chrome.tabs.create.mock.calls.length === 1);
    expect(sw.state.done).toBe(false);
    tid('bookmarks-close').focus();
    key('Delete'); // the ticked one
    await waitFor(() => !row('Docs'));
    expect(chrome.bookmarks.remove).toHaveBeenCalledWith(s.docs.id);
    tid('bookmarks-search').focus();
    sw.bmvSelect(titles().indexOf('Recipes'));
    key('Enter');
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://food.example/recipes', active: true }));
  });

  it('F2 edits from the box too; while it is open the rest is inert; an edit dialog over it takes the keys', async () => {
    seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(tid('header').hasAttribute('inert')).toBe(true);
    sw.bmvSelect(titles().indexOf('Docs'));
    key('F2');
    await waitFor(() => tid('bmv-edit-form'));
    expect(tid('bookmarks-overlay').hasAttribute('inert')).toBe(true);
    key('Escape'); // the dialog's
    expect(tid('modal').hidden).toBe(true);
    expect(sw.bookmarksOpen()).toBe(true);
  });
});

describe('webAddress', () => {
  it('adds https:// to a bare address; refuses what isn\'t one', async () => {
    const sw = await boot({ tabs: AB });
    expect(sw.webAddress('example.com/x')).toBe('https://example.com/x');
    expect(sw.webAddress('http://a.example')).toBe('http://a.example/');
    expect(sw.webAddress('  ')).toBe('');
    expect(sw.webAddress('http://exa mple')).toBe('');
  });
});

describe('layers and narrow windows (styles/switcher.css)', () => {
  it('a dialog opens over the full-screen views, a select\'s list over the dialog; narrow rows keep only ⋯', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8').replace(/\r\n/g, '\n');
    const z = (selector) => { const i = css.indexOf('\n' + selector + ' {'); return +css.slice(i, css.indexOf('}', i)).match(/z-index: (\d+)/)[1]; };
    expect(z('.modal-back')).toBeGreaterThan(z('.arch'));
    expect(z('.menu')).toBeGreaterThan(z('.modal-back'));
    expect(z('.toast')).toBeGreaterThan(z('.modal-back'));
    expect(z('.bigback')).toBeGreaterThan(z('.menu'));
    expect(css).toMatch(/@media \(max-width: 760px\) \{[^@]*\.bmvacts > :not\(\[data-testid="quick-more"\]\):not\(\.note\.on\) \{ display: none; \}/);
    expect(css).toMatch(/\.bmvtree > \.bmvrow, \.histlist > \.bmvrow \{ content-visibility: auto;/);
  });
});
