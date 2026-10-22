// The bookmarks view (the bookmark button after History, Ctrl+Shift+O): every Chrome bookmark as a tree with previews;
// open (here, behind), big preview, the ⋯ menus; edit (with its note), add, delete (one, ticked ones, a folder with its
// contents; asking first for many; Undo), move (drag, Move to…, Ctrl+↑ ↓), sort; the search box (name, site, address,
// note; typos forgiven); Duplicates, stars; a bookmark's own note (not the page's), on this computer only;
// what comes back next time; the keys.
import { describe, it, expect } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, toastText, toastButton } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';

const defaultTabs = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }];
const PREVIEW = 'data:image/jpeg;base64,BBBB';
// Bookmarks bar: Docs (bookmark), Work (folder: Wiki, Tracker); Other bookmarks: Recipes (bookmark).
function seed() {
  const docs = chrome._addBookmark({ parentId: '1', title: 'Docs', url: 'https://docs.example/' });
  const work = chrome._addBookmark({ parentId: '1', title: 'Work' });
  const wiki = chrome._addBookmark({ parentId: work.id, title: 'Wiki', url: 'https://wiki.example/page' });
  const tracker = chrome._addBookmark({ parentId: work.id, title: 'Tracker', url: 'https://tracker.example/' });
  const recipes = chrome._addBookmark({ parentId: '2', title: 'Recipes', url: 'https://food.example/recipes' });
  return { docs, work, wiki, tracker, recipes };
}
const rows = () => [...byTestId('bookmarks-tree').children];
const titles = () => rows().map((row) => byTestId('bookmarks-view-title', row).textContent);
const row = (title) => rows().find((candidate) => byTestId('bookmarks-view-title', candidate).textContent === title);
const selectedTitle = () => byTestId('bookmarks-view-title', rows().find((row) => row.getAttribute('aria-selected') === 'true')).textContent;
const menuLabels = () => allByTestId('menu-item').map((button) => button.textContent);
const menuItem = (label) => allByTestId('menu-item').find((button) => button.textContent === label);
const mark = (id) => chrome._findBookmark(id);
const kidTitles = (id) => mark(id).children.map((child) => child.title);
async function open(switcher) {
  byTestId('bookmarks-button').click();
  await waitFor(() => switcher.bookmarksOpen() && byTestId('bookmarks-tree'));
  await tick(10);
}
async function find(text) {
  const box = byTestId('bookmarks-search');
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await tick(130); // (it waits for a pause in typing)
}
const submit = (testid) => byTestId(testid).dispatchEvent(new Event('submit', { cancelable: true }));

describe('the bookmarks button', () => {
  it('is in the menu (☰), after History, with its icon, name and key; Ctrl+Shift+O opens and closes it', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const button = byTestId('bookmarks-button');
    expect(byTestId('history-button-item').nextElementSibling).toBe(byTestId('bookmarks-button-item'));
    expect(byTestId('bookmarks-button-label').textContent).toBe(translate('bookmarksViewTitle'));
    expect(byTestId('bookmarks-button-key').textContent).toBe('Ctrl+Shift+O');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    key('O', { code: 'KeyO', ctrlKey: true, shiftKey: true });
    await waitFor(() => switcher.bookmarksOpen());
    key('O', { code: 'KeyO', ctrlKey: true, shiftKey: true, target: byTestId('bookmarks-search') });
    expect(switcher.bookmarksOpen()).toBe(false);
    expect(switcher.PALETTE_ACTIONS.some((action) => action.id === 'open-bookmarks')).toBe(true);
  });
});

describe('the tree', () => {
  it('Chrome\'s folders start open; a folder opens and closes with a click (its rows indented by depth)', async () => {
    seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(titles()).toEqual(['Bookmarks bar', 'Docs', 'Work', 'Other bookmarks', 'Recipes']);
    expect(row('Work').getAttribute('aria-expanded')).toBe('false');
    row('Work').click();
    expect(titles()).toEqual(['Bookmarks bar', 'Docs', 'Work', 'Wiki', 'Tracker', 'Other bookmarks', 'Recipes']);
    expect(row('Wiki').getAttribute('aria-level')).toBe('3');
    expect(row('Work').getAttribute('aria-expanded')).toBe('true');
    expect(byTestId('bookmarks-view-count', row('Work')).textContent).toBe(translate('bookmarksViewItems', { count: 2 }));
    expect(byTestId('bookmarks-count').textContent).toBe('4');
    row('Work').click();
    expect(titles()).not.toContain('Wiki');
  });

  it('what was open and the selected row come back next time; the search box starts empty', async () => {
    seed();
    let switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    row('Work').click();
    switcher.bookmarksViewSelect(titles().indexOf('Tracker'));
    switcher.closeBookmarks();
    await tick(20);
    switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(titles()).toContain('Tracker');
    expect(selectedTitle()).toBe('Tracker');
    await find('recipes');
    expect(titles()).toEqual(['Other bookmarks', 'Recipes']);
    const box = byTestId('bookmarks-search');
    switcher.closeBookmarks();
    expect(box.value).toBe(''); // emptied as it closes
    await open(switcher);
    expect(byTestId('bookmarks-search').value).toBe('');
    expect(titles()).toContain('Docs'); // the whole tree again
    // typed, then closed before the pause: nothing of it comes back
    byTestId('bookmarks-search').value = 'wiki';
    byTestId('bookmarks-search').dispatchEvent(new Event('input', { bubbles: true }));
    switcher.closeBookmarks();
    await tick(130);
    switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(byTestId('bookmarks-search').value).toBe('');
    expect(titles()).toContain('Docs');
  });

  it('a bookmark shows its preview when there is one, else its icon; its site; a click opens it, a middle-click behind', async () => {
    seed();
    await chrome.storage.local.set({ 'pv:https://docs.example/': { img: PREVIEW, t: Date.now() } });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    await waitFor(() => byTestId('bookmarks-view-preview', row('Docs')));
    expect(byTestId('bookmarks-view-preview', row('Docs')).src).toBe(PREVIEW);
    expect(byTestId('bookmarks-view-favicon', row('Recipes'))).not.toBe(null);
    expect(byTestId('bookmarks-view-address', row('Recipes')).textContent).toBe('food.example');
    row('Recipes').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    await waitFor(() => chrome.tabs.create.mock.calls.length === 1);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://food.example/recipes', active: false }));
    expect(switcher.state.done).toBe(false);
    row('Recipes').click();
    await waitFor(() => switcher.state.done);
  });

  it('the Tabs Archive folder says what it is, and its menu opens the Archive view', async () => {
    seed();
    const archiveFolder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: archiveFolder.id, title: 'Old page', url: 'https://old.example/' });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(byTestId('bookmarks-view-archive-tag', row('Tabs Archive')).textContent).toBe(translate('bookmarksViewArchiveTag'));
    byTestId('quick-more', row('Tabs Archive')).click();
    expect(menuLabels()[0]).toBe(translate('paletteOpenArchive'));
    menuItem(translate('paletteOpenArchive')).click();
    await waitFor(() => switcher.archiveOpen());
    expect(switcher.bookmarksOpen()).toBe(false);
  });

  it('nothing bookmarked: says so', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(byTestId('bookmarks-empty').hidden).toBe(false);
    expect(byTestId('bookmarks-empty').textContent).toBe(translate('bookmarksViewEmpty'));
  });
});

describe('the search box', () => {
  it('finds bookmarks by name, site, address or note (typos forgiven) with their folder path, words marked; Esc empties it', async () => {
    const fixture = seed();
    await chrome.storage.local.set({ bmNotes: { [fixture.recipes.id]: { u: 'https://food.example/recipes', n: 'grandma lasagna', t: Date.now() } } });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    await find('wiki');
    expect(titles()).toEqual(['Bookmarks bar', 'Work', 'Wiki']); // inside the closed folder: shown with it
    expect(byTestId('bookmarks-view-path', row('Wiki')).textContent).toBe(' · Bookmarks bar › Work');
    expect(allByTestId('search-highlight', row('Wiki')).length).toBeGreaterThan(0);
    await find('tracker.example');
    expect(titles()).toEqual(['Bookmarks bar', 'Work', 'Tracker']);
    await find('lasagna');
    expect(titles()).toEqual(['Other bookmarks', 'Recipes']);
    expect(row('Recipes').getAttribute('aria-selected')).toBe('true'); // the first bookmark found, not its folder
    await find('recipse'); // a typo
    expect(titles()).toContain('Recipes');
    await find('zzzzqqq');
    expect(byTestId('bookmarks-empty').textContent).toBe(translate('bookmarksViewNoMatch'));
    key('Escape');
    expect(byTestId('bookmarks-search').value).toBe('');
    expect(switcher.bookmarksOpen()).toBe(true);
    key('Escape');
    expect(switcher.bookmarksOpen()).toBe(false);
    expect(document.activeElement).toBe(byTestId('menu-button'));
  });

  it('Enter right after typing (before the search\'s pause) opens what the typed text finds', async () => {
    seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(selectedTitle()).toBe('Bookmarks bar');
    const box = byTestId('bookmarks-search');
    box.value = 'recipes';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    key('Enter', { target: box }); // no pause: the search hasn't run yet
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://food.example/recipes', active: true }));
  });
});

describe('editing and adding', () => {
  it('Edit: name, address, folder (a move) and its note; Undo puts it all back', async () => {
    const fixture = seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    byTestId('bookmarks-view-edit', row('Docs')).click();
    await waitFor(() => byTestId('bookmarks-view-edit-form'));
    expect(byTestId('bookmarks-view-edit-name').value).toBe('Docs');
    expect(byTestId('bookmarks-view-edit-url').value).toBe('https://docs.example/');
    byTestId('bookmarks-view-edit-name').value = 'Team docs';
    byTestId('bookmarks-view-edit-url').value = 'docs.example/team';
    byTestId('bookmarks-view-edit-folder').value = fixture.work.id;
    byTestId('bookmarks-view-edit-note').value = 'the handbook';
    submit('bookmarks-view-edit-form');
    await waitFor(() => row('Team docs'));
    expect(mark(fixture.docs.id)).toMatchObject({ title: 'Team docs', url: 'https://docs.example/team', parentId: fixture.work.id });
    expect(titles()).toEqual(['Bookmarks bar', 'Work', 'Wiki', 'Tracker', 'Team docs', 'Other bookmarks', 'Recipes']); // its folder opened
    expect(byTestId('bookmarks-view-note-text', row('Team docs')).textContent).toBe('the handbook');
    expect(toastText()).toBe(translate('bookmarksViewSaved'));
    toastButton().click();
    await waitFor(() => row('Docs'));
    expect(mark(fixture.docs.id)).toMatchObject({ title: 'Docs', url: 'https://docs.example/', parentId: '1' });
    expect(kidTitles('1')[0]).toBe('Docs');
    expect(switcher.bookmarkNoteOf(fixture.docs.id)).toBe('');
  });

  it('an address that isn\'t one is refused, with a message', async () => {
    seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    byTestId('bookmarks-view-edit', row('Docs')).click();
    await waitFor(() => byTestId('bookmarks-view-edit-form'));
    byTestId('bookmarks-view-edit-url').value = 'http://exa mple';
    submit('bookmarks-view-edit-form');
    await tick(10);
    expect(byTestId('bookmarks-view-edit-error').hidden).toBe(false);
    expect(byTestId('bookmarks-view-edit-error').textContent).toBe(translate('bookmarksViewBadUrl'));
    expect(chrome.bookmarks.update).not.toHaveBeenCalled();
  });

  it('Add bookmark starts as the page Tabazing was opened over, says where it is bookmarked already; Undo takes it out', async () => {
    const fixture = seed();
    chrome._addBookmark({ parentId: '2', title: 'A again', url: 'https://a.example/' });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    row('Work').click(); // selects it (and opens it)
    byTestId('bookmarks-add').click();
    await waitFor(() => byTestId('bookmarks-view-edit-form'));
    expect(byTestId('bookmarks-view-edit-url').value).toBe('https://a.example/');
    expect(byTestId('bookmarks-view-edit-folder').value).toBe(fixture.work.id);
    await waitFor(() => !byTestId('bookmarks-view-edit-have').hidden);
    expect(byTestId('bookmarks-view-edit-have').textContent).toBe(translate('markHave', { folders: 'Other bookmarks' }));
    submit('bookmarks-view-edit-form');
    await waitFor(() => mark(fixture.work.id).children.length === 3);
    expect(mark(fixture.work.id).children[2]).toMatchObject({ title: 'A', url: 'https://a.example/' });
    await waitFor(() => toastText() === translate('bookmarksViewMade'));
    toastButton().click();
    await waitFor(() => mark(fixture.work.id).children.length === 2);
  });

  it('New folder, inside the selected one', async () => {
    const fixture = seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    row('Work').click();
    byTestId('bookmarks-new-folder').click();
    await waitFor(() => byTestId('bookmarks-view-edit-form') && !byTestId('bookmarks-view-edit-url'));
    byTestId('bookmarks-view-edit-name').value = 'Later';
    submit('bookmarks-view-edit-form');
    await waitFor(() => row('Later'));
    expect(row('Later').dataset.testid).toBe('bookmarks-view-folder');
    expect(kidTitles(fixture.work.id)).toEqual(['Wiki', 'Tracker', 'Later']);
  });
});

describe('deleting', () => {
  it('a bookmark (its trash, or Del): gone; Undo puts it back where it was, with its note', async () => {
    const fixture = seed();
    await chrome.storage.local.set({ bmNotes: { [fixture.docs.id]: { u: 'https://docs.example/', n: 'the handbook', t: Date.now() } } });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    byTestId('bookmarks-view-delete', row('Docs')).click();
    await waitFor(() => !row('Docs'));
    expect(chrome.bookmarks.remove).toHaveBeenCalledWith(fixture.docs.id);
    expect(toastText()).toBe(translate('bookmarksViewDeleted', { count: 1 }));
    expect((await chrome.storage.local.get('bmNotes')).bmNotes[fixture.docs.id]).toBe(undefined);
    toastButton().click();
    await waitFor(() => row('Docs'));
    const back = mark('1').children[0];
    expect(back).toMatchObject({ title: 'Docs', url: 'https://docs.example/' }); // first again
    expect((await chrome.storage.local.get('bmNotes')).bmNotes[back.id].n).toBe('the handbook');
  });

  it('ticked ones together: tick boxes (folders too), Shift+click for a range, Ctrl+A; the bar deletes them', async () => {
    seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(byTestId('bookmarks-view-pick', row('Bookmarks bar'))).toBe(null); // Chrome's own folders can't be ticked
    byTestId('bookmarks-view-pick', row('Docs')).click();
    byTestId('bookmarks-view-pick', row('Recipes')).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(['Docs', 'Work', 'Recipes'].map((x) => row(x).getAttribute('aria-checked'))).toEqual(['true', 'true', 'true']);
    expect(byTestId('bookmarks-selected').textContent).toBe(translate('bookmarksViewSelected', { count: 3 }));
    byTestId('bookmarks-delete-selected').click();
    await waitFor(() => !row('Docs') && !row('Recipes') && !row('Work'));
    expect(toastText()).toBe(translate('bookmarksViewDeleted', { count: 4 })); // Docs, Recipes and Work's two
    toastButton().click();
    await waitFor(() => row('Docs') && row('Recipes') && row('Work'));
    expect(kidTitles(mark('1').children.find((child) => child.title === 'Work').id)).toEqual(['Wiki', 'Tracker']);
    byTestId('bookmarks-close').focus();
    key('a', { code: 'KeyA', ctrlKey: true });
    expect(byTestId('bookmarks-selected').textContent).toBe(translate('bookmarksViewSelected', { count: 3 })); // the rows shown, but Chrome's own
    key('Escape');
    expect(byTestId('bookmarks-selection').hidden).toBe(true);
    expect(switcher.bookmarksOpen()).toBe(true);
  });

  it('a folder with what it holds; ten bookmarks or more ask first', async () => {
    const fixture = seed();
    const big = chrome._addBookmark({ parentId: '2', title: 'Big' });
    for (let i = 0; i < 12; i++) chrome._addBookmark({ parentId: big.id, title: 'Item ' + i, url: `https://i${i}.example/` });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    byTestId('bookmarks-view-delete', row('Work')).click();
    await waitFor(() => !row('Work'));
    expect(chrome.bookmarks.removeTree).toHaveBeenCalledWith(fixture.work.id);
    expect(toastText()).toBe(translate('bookmarksViewFolderDeleted', { name: 'Work' }));
    byTestId('bookmarks-view-delete', row('Big')).click();
    await waitFor(() => byTestId('bookmarks-view-delete-ask'));
    expect(byTestId('dialog-title', byTestId('bookmarks-view-delete-ask')).textContent).toBe(translate('bookmarksViewDeleteFolderAsk', { name: 'Big' }));
    byTestId('bookmarks-view-delete-ask-cancel').click();
    expect(row('Big')).not.toBe(undefined);
    byTestId('bookmarks-view-delete', row('Big')).click();
    await waitFor(() => byTestId('bookmarks-view-delete-ask-ok'));
    byTestId('bookmarks-view-delete-ask-ok').click();
    await waitFor(() => !row('Big'));
  });
});

describe('moving and sorting', () => {
  it('Move to… the ticked rows; Undo puts them back', async () => {
    const fixture = seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    byTestId('bookmarks-view-pick', row('Docs')).click();
    byTestId('bookmarks-view-pick', row('Recipes')).click();
    byTestId('bookmarks-move-selected').click();
    await waitFor(() => byTestId('bookmarks-view-move-form'));
    byTestId('bookmarks-view-move-folder').value = fixture.work.id;
    submit('bookmarks-view-move-form');
    await waitFor(() => kidTitles(fixture.work.id).length === 4);
    expect(kidTitles(fixture.work.id)).toEqual(['Wiki', 'Tracker', 'Docs', 'Recipes']);
    expect(toastText()).toBe(translate('bookmarksViewMoved', { count: 2 }));
    toastButton().click();
    await waitFor(() => kidTitles(fixture.work.id).length === 2);
    expect(kidTitles('1')).toEqual(['Docs', 'Work']);
    expect(kidTitles('2')).toEqual(['Recipes']);
  });

  it('dragging a row onto a folder puts it in; above another row, before it', async () => {
    const fixture = seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    const drag = (from, to, y) => {
      const dataTransfer = { setData() {}, effectAllowed: '', dropEffect: '' };
      to.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40, left: 0, width: 100 });
      for (const [node, type] of [[from, 'dragstart'], [to, 'dragover'], [to, 'drop'], [from, 'dragend']]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        event.dataTransfer = dataTransfer;
        event.clientY = y;
        node.dispatchEvent(event);
      }
    };
    drag(row('Recipes'), row('Work'), 20); // the middle of a folder
    await waitFor(() => kidTitles(fixture.work.id).length === 3);
    expect(kidTitles(fixture.work.id)).toEqual(['Wiki', 'Tracker', 'Recipes']);
    await waitFor(() => row('Recipes'));
    drag(row('Recipes'), row('Docs'), 5); // the top of a row
    await waitFor(() => kidTitles('1').length === 3);
    expect(kidTitles('1')).toEqual(['Recipes', 'Docs', 'Work']);
  });

  it('Ctrl+↑ ↓ moves the selected row in its folder; a folder sorts by name or date added', async () => {
    const fixture = seed();
    const alphaBookmark = chrome._addBookmark({ parentId: fixture.work.id, title: 'Alpha', url: 'https://alpha.example/' });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    switcher.bookmarksViewSelect(titles().indexOf('Docs'));
    key('ArrowDown', { ctrlKey: true });
    await waitFor(() => kidTitles('1')[0] === 'Work');
    expect(kidTitles('1')).toEqual(['Work', 'Docs']);
    expect(selectedTitle()).toBe('Docs');
    key('ArrowUp', { ctrlKey: true });
    await waitFor(() => kidTitles('1')[0] === 'Docs');
    byTestId('quick-more', row('Work')).click();
    menuItem(translate('bookmarksViewSortName')).click();
    await waitFor(() => kidTitles(fixture.work.id)[0] === 'Alpha');
    expect(kidTitles(fixture.work.id)).toEqual(['Alpha', 'Tracker', 'Wiki']);
    await waitFor(() => toastText() === translate('bookmarksViewSorted', { name: 'Work' }));
    toastButton().click();
    await waitFor(() => kidTitles(fixture.work.id).join() === 'Wiki,Tracker,Alpha');
    expect(alphaBookmark.id).toBeTruthy();
  });
});

describe('opening many', () => {
  it('a folder\'s Open all: behind Tabazing, in a new window, or as a tab group named after it', async () => {
    const fixture = seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    byTestId('quick-more', row('Work')).click();
    expect(menuLabels()).toEqual([translate('bookmarksViewAddHere'), translate('bookmarksViewFolderHere'), translate('bookmarksViewOpenAll', { count: 2 }), translate('bookmarksViewOpenAllWindow'), translate('bookmarksViewOpenAllGroup'),
      translate('bookmarksViewSortName'), translate('bookmarksViewSortDate'), translate('bookmarksViewSelect'), translate('bookmarksViewRename'), translate('bookmarksViewDeleteFolder')]);
    menuItem(translate('bookmarksViewOpenAllGroup')).click();
    await waitFor(() => chrome.tabGroups.update.mock.calls.length === 1);
    expect(chrome.tabs.create.mock.calls.map(([properties]) => [properties.url, properties.active])).toEqual([['https://wiki.example/page', false], ['https://tracker.example/', false]]);
    expect(chrome.tabGroups.update.mock.calls[0][1]).toEqual({ title: 'Work' });
    byTestId('quick-more', row('Work')).click();
    menuItem(translate('bookmarksViewOpenAllWindow')).click();
    await waitFor(() => chrome.windows.create.mock.calls.length === 1);
    expect(chrome.windows.create.mock.calls[0][0]).toEqual({ url: ['https://wiki.example/page', 'https://tracker.example/'], focused: false });
    expect(fixture.work.id).toBeTruthy();
  });

  it('more than 15 tabs at once asks first', async () => {
    const big = chrome._addBookmark({ parentId: '2', title: 'Big' });
    for (let i = 0; i < 20; i++) chrome._addBookmark({ parentId: big.id, title: 'Item ' + i, url: `https://i${i}.example/` });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    byTestId('quick-more', row('Big')).click();
    menuItem(translate('bookmarksViewOpenAll', { count: 20 })).click();
    await waitFor(() => byTestId('bookmarks-view-open-ask'));
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    byTestId('bookmarks-view-open-ask-ok').click();
    await waitFor(() => chrome.tabs.create.mock.calls.length === 20);
  });
});

describe('Duplicates and stars', () => {
  it('Duplicates shows only the bookmarks of an address bookmarked twice or more, each with how many', async () => {
    seed();
    chrome._addBookmark({ parentId: '2', title: 'Docs again', url: 'https://docs.example/' });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(byTestId('bookmarks-duplicates').hidden).toBe(false);
    byTestId('bookmarks-duplicates').click();
    await tick(130);
    expect(titles()).toEqual(['Bookmarks bar', 'Docs', 'Other bookmarks', 'Docs again']);
    expect(byTestId('bookmarks-view-duplicate', row('Docs')).textContent).toBe(translate('bookmarksViewDuplicateTag', { count: 2 }));
    key('Escape'); // the filter goes first
    await tick(130);
    expect(titles()).toContain('Recipes');
    expect(switcher.bookmarksOpen()).toBe(true);
  });

  it('starred pages not bookmarked yet go into a "Tabazing stars" folder; Undo takes it out', async () => {
    seed();
    await chrome.storage.local.set({ stars: {
      'https://starred.example/': { u: 'https://starred.example/', ti: 'Starred one', t: Date.now() },
      'https://docs.example/': { u: 'https://docs.example/', ti: 'Docs', t: Date.now() },
    } });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(byTestId('bookmarks-stars-label').textContent).toBe(translate('bookmarksViewImportStars', { count: 1 }));
    byTestId('bookmarks-stars').click();
    await waitFor(() => row(translate('bookmarksViewStarsFolder')));
    expect(titles()).toContain('Starred one');
    expect(byTestId('bookmarks-stars').hidden).toBe(true);
    toastButton().click();
    await waitFor(() => !row(translate('bookmarksViewStarsFolder')));
  });
});

describe('a bookmark\'s note', () => {
  it('is the bookmark\'s own (kept by its id), not the page\'s note; shown under its address; on this computer only', async () => {
    const fixture = seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    byTestId('quick-note', row('Docs')).click();
    const box = byTestId('note-input');
    expect(byTestId('note-label').textContent).toBe(translate('bookmarksViewNoteTitle'));
    box.value = 'read the onboarding';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    byTestId('note-close').click();
    await waitFor(() => byTestId('bookmarks-view-note-text', row('Docs')).textContent === 'read the onboarding');
    expect((await chrome.storage.local.get('bmNotes')).bmNotes[fixture.docs.id].n).toBe('read the onboarding');
    expect((await chrome.storage.local.get('notes')).notes || {}).toEqual({}); // the page has no note
    expect(Object.keys(await chrome.storage.sync.get(null))).toEqual([]); // on this computer only
  });

  it('notes of bookmarks that are gone (deleted in Chrome\u2019s own manager) go', async () => {
    seed();
    await chrome.storage.local.set({ bmNotes: { 12345: { u: 'https://gone.example/', n: 'orphan', t: Date.now() } } });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    await waitFor(async () => true);
    await tick(20);
    expect((await chrome.storage.local.get('bmNotes')).bmNotes[12345]).toBe(undefined);
    expect(switcher.bookmarkNoteOf('12345')).toBe('');
  });
});

describe('the menu and the keys', () => {
  it('a bookmark\'s ⋯', async () => {
    seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    byTestId('quick-more', row('Docs')).click();
    expect(menuLabels()).toEqual([
      translate('historyOpen'), translate('historyNewWindow'), translate('historyBehind'), translate('historyBig'), translate('copyLink'), translate('star'), translate('noteAdd'),
      translate('historySnooze'), translate('bookmarksViewSelect'), translate('bookmarksViewEdit'), translate('bookmarksViewDelete'),
    ]);
  });

  it('↑ ↓ from the box, → opens a folder, ← closes it, * opens those beside, Enter opens, Ctrl+Enter behind, Space previews, Del deletes', async () => {
    const fixture = seed();
    chrome._addBookmark({ parentId: '1', title: 'Play' });
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(document.activeElement).toBe(byTestId('bookmarks-search'));
    expect(selectedTitle()).toBe('Bookmarks bar');
    key('ArrowDown'); key('ArrowDown');
    expect(selectedTitle()).toBe('Work');
    key('ArrowRight');
    expect(titles()).toContain('Wiki');
    key('ArrowLeft');
    expect(titles()).not.toContain('Wiki');
    byTestId('bookmarks-close').focus();
    key('*'); // every folder beside Work opens
    expect(row('Work').getAttribute('aria-expanded')).toBe('true');
    expect(row('Play').getAttribute('aria-expanded')).toBe('true');
    key('End');
    expect(selectedTitle()).toBe('Recipes');
    key('Home');
    expect(selectedTitle()).toBe('Bookmarks bar');
    key('ArrowDown');
    expect(selectedTitle()).toBe('Docs');
    key(' ', { ctrlKey: true });
    expect(row('Docs').getAttribute('aria-checked')).toBe('true');
    key(' ');
    expect(byTestId('big-preview-title').textContent).toBe('Docs');
    expect(allByTestId('big-preview-information-line').map((x) => x.textContent)).toContain('Bookmarks bar');
    key('Escape');
    expect(document.activeElement).toBe(byTestId('bookmarks-search'));
    key('Enter', { ctrlKey: true });
    await waitFor(() => chrome.tabs.create.mock.calls.length === 1);
    expect(switcher.state.done).toBe(false);
    byTestId('bookmarks-close').focus();
    key('Delete'); // the ticked one
    await waitFor(() => !row('Docs'));
    expect(chrome.bookmarks.remove).toHaveBeenCalledWith(fixture.docs.id);
    byTestId('bookmarks-search').focus();
    switcher.bookmarksViewSelect(titles().indexOf('Recipes'));
    key('Enter');
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://food.example/recipes', active: true }));
  });

  it('F2 edits from the box too; while it is open the rest is inert; an edit dialog over it takes the keys', async () => {
    seed();
    const switcher = await boot({ tabs: defaultTabs });
    await open(switcher);
    expect(byTestId('header').hasAttribute('inert')).toBe(true);
    switcher.bookmarksViewSelect(titles().indexOf('Docs'));
    key('F2');
    await waitFor(() => byTestId('bookmarks-view-edit-form'));
    expect(byTestId('bookmarks-overlay').hasAttribute('inert')).toBe(true);
    key('Escape'); // the dialog's
    expect(byTestId('modal').hidden).toBe(true);
    expect(switcher.bookmarksOpen()).toBe(true);
  });
});

describe('webAddress', () => {
  it('adds https:// to a bare address; refuses what isn\'t one', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    expect(switcher.webAddress('example.com/x')).toBe('https://example.com/x');
    expect(switcher.webAddress('http://a.example')).toBe('http://a.example/');
    expect(switcher.webAddress('  ')).toBe('');
    expect(switcher.webAddress('http://exa mple')).toBe('');
  });
});

describe('layers and narrow windows (styles/switcher.css)', () => {
  it('a dialog opens over the full-screen views, a select\'s list over the dialog; narrow rows keep only ⋯', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8').replace(/\r\n/g, '\n');
    const zIndexOf = (selector) => { const i = css.indexOf('\n' + selector + ' {'); return +css.slice(i, css.indexOf('}', i)).match(/z-index: (\d+)/)[1]; };
    expect(zIndexOf('.modal-back')).toBeGreaterThan(zIndexOf('.archive-dialog'));
    expect(zIndexOf('.menu')).toBeGreaterThan(zIndexOf('.modal-back'));
    expect(zIndexOf('.toast')).toBeGreaterThan(zIndexOf('.modal-back'));
    expect(zIndexOf('.big-backdrop')).toBeGreaterThan(zIndexOf('.menu'));
    expect(css).toMatch(/@media \(max-width: 760px\) \{[^@]*\.bookmarks-view-actions > :not\(\[data-testid="quick-more"\]\):not\(\.note\.on\) \{ display: none; \}/);
    expect(css).toMatch(/\.bookmarks-view-tree > \.bookmarks-view-row, \.history-list > \.bookmarks-view-row \{ content-visibility: auto;/);
  });
});
