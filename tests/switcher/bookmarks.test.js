// The bookmarks view (the bookmark button beside History): every Chrome bookmark as a tree with previews; open,
// big preview, the ⋯ menu; edit, add, delete (one, picked ones, a folder with its contents; Undo); the search box
// (name, site, address, note; typos forgiven); a bookmark's own note (not the page's); the keys.
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
const marks = () => tids('bmv-mark');
const folders = () => tids('bmv-folder');
const titles = () => [...tid('bookmarks-tree').children].map((r) => tid('bmv-title', r).textContent);
const row = (title) => [...tid('bookmarks-tree').children].find((r) => tid('bmv-title', r).textContent === title);
const menuLabels = () => tids('menu-item').map((b) => b.textContent);
const menuItem = (label) => tids('menu-item').find((b) => b.textContent === label);
const mark = (id) => chrome._findBookmark(id);
async function open(sw) {
  tid('bookmarks-btn').click();
  await waitFor(() => sw.bookmarksOpen() && tid('bookmarks-tree'));
  await tick(10);
}
async function find(text) {
  const box = tid('bookmarks-search');
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
}

describe('the bookmarks button', () => {
  it('sits right of History, a labelled icon button that opens a dialog', async () => {
    await boot({ tabs: AB });
    const b = tid('bookmarks-btn');
    expect(tid('history-btn').nextElementSibling).toBe(b);
    expect(b.getAttribute('aria-label')).toBe(t('bmvBtn'));
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
  });
});

describe('the tree', () => {
  it('Chrome\'s folders start open; a folder opens and closes with a click (its rows indented by depth)', async () => {
    seed();
    const sw = await open2();
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
    async function open2() { const s = await boot({ tabs: AB }); await open(s); return s; }
  });

  it('a bookmark shows its preview when there is one, else its icon; its site; a click opens it', async () => {
    seed();
    await chrome.storage.local.set({ 'pv:https://docs.example/': { img: PV, t: Date.now() } });
    const sw = await boot({ tabs: AB });
    await open(sw);
    await waitFor(() => tid('bmv-preview', row('Docs')));
    expect(tid('bmv-preview', row('Docs')).src).toBe(PV);
    expect(tid('bmv-favicon', row('Recipes'))).not.toBe(null);
    expect(tid('bmv-address', row('Recipes')).textContent).toBe('food.example');
    row('Recipes').click();
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://food.example/recipes', active: true }));
  });

  it('nothing bookmarked: says so', async () => {
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(tid('bookmarks-empty').hidden).toBe(false);
    expect(tid('bookmarks-empty').textContent).toBe(t('bmvEmpty'));
  });
});

describe('the search box', () => {
  it('finds bookmarks by name, site, address or note (typos forgiven), with the folders they are in; Esc empties it', async () => {
    const s = seed();
    await chrome.storage.local.set({ bmNotes: { [s.recipes.id]: { u: 'https://food.example/recipes', n: 'grandma lasagna', t: Date.now() } } });
    const sw = await boot({ tabs: AB });
    await open(sw);
    await find('wiki');
    expect(titles()).toEqual(['Bookmarks bar', 'Work', 'Wiki']); // inside the closed folder: shown with it
    await find('tracker.example');
    expect(titles()).toEqual(['Bookmarks bar', 'Work', 'Tracker']);
    await find('lasagna');
    expect(titles()).toEqual(['Other bookmarks', 'Recipes']);
    expect(row('Recipes').getAttribute('aria-selected')).toBe('true'); // the first bookmark found, not its folder
    await find('recipse'); // a typo
    expect(titles()).toContain('Recipes');
    await find('zzzzqqq');
    expect(tid('bookmarks-empty').hidden).toBe(false);
    expect(tid('bookmarks-empty').textContent).toBe(t('bmvNoMatch'));
    key('Escape');
    expect(tid('bookmarks-search').value).toBe('');
    expect(sw.bookmarksOpen()).toBe(true);
    key('Escape');
    expect(sw.bookmarksOpen()).toBe(false);
    expect(document.activeElement).toBe(tid('bookmarks-btn'));
  });
});

describe('editing', () => {
  it('Edit: name, address and folder (a move)', async () => {
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
    tid('bmv-edit-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor(() => chrome.bookmarks.move.mock.calls.length > 0);
    await waitFor(() => row('Team docs'));
    expect(mark(s.docs.id)).toMatchObject({ title: 'Team docs', url: 'https://docs.example/team', parentId: s.work.id });
    expect(titles()).toEqual(['Bookmarks bar', 'Work', 'Wiki', 'Tracker', 'Team docs', 'Other bookmarks', 'Recipes']); // its folder opened
  });

  it('an address that isn\'t one is refused, with a message', async () => {
    seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('bmv-edit', row('Docs')).click();
    await waitFor(() => tid('bmv-edit-form'));
    tid('bmv-edit-url').value = 'http://exa mple';
    tid('bmv-edit-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick(10);
    expect(tid('bmv-edit-error').hidden).toBe(false);
    expect(tid('bmv-edit-error').textContent).toBe(t('bmvBadUrl'));
    expect(chrome.bookmarks.update).not.toHaveBeenCalled();
  });

  it('Add bookmark starts as the page Tabazing was opened over, into the selected folder; New folder too', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    row('Work').click(); // selects it (and opens it)
    tid('bookmarks-add').click();
    await waitFor(() => tid('bmv-edit-form'));
    expect(tid('bmv-edit-url').value).toBe('https://a.example/');
    expect(tid('bmv-edit-folder').value).toBe(s.work.id);
    tid('bmv-edit-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor(() => mark(s.work.id).children.length === 3);
    expect(mark(s.work.id).children[2]).toMatchObject({ title: 'A', url: 'https://a.example/' });
    tid('bookmarks-new-folder').click();
    await waitFor(() => tid('bmv-edit-form') && !tid('bmv-edit-url'));
    tid('bmv-edit-name').value = 'Later';
    tid('bmv-edit-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor(() => row('Later'));
    expect(row('Later').dataset.testid).toBe('bmv-folder');
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

  it('picked ones together (their tick boxes, then Delete in the bar)', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('bmv-pick', row('Docs')).click();
    tid('bmv-pick', row('Recipes')).click();
    expect(tid('bookmarks-selection').hidden).toBe(false);
    expect(tid('bookmarks-selected').textContent).toBe(t('bmvSelected', { count: 2 }));
    expect(tid('bmv-pick', row('Docs')).getAttribute('aria-checked')).toBe('true');
    tid('bookmarks-delete-selected').click();
    await waitFor(() => !row('Docs') && !row('Recipes'));
    expect(toastText()).toBe(t('bmvDeleted', { count: 2 }));
    expect(tid('bookmarks-selection').hidden).toBe(true);
    toastButton().click();
    await waitFor(() => row('Docs') && row('Recipes'));
    expect(mark(s.work.id).children).toHaveLength(2);
  });

  it('a folder, with what it holds; Undo brings it all back; Chrome\'s own folders can\'t be deleted', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(tid('bmv-delete', row('Bookmarks bar'))).toBe(null);
    tid('bmv-delete', row('Work')).click();
    await waitFor(() => !row('Work'));
    expect(chrome.bookmarks.removeTree).toHaveBeenCalledWith(s.work.id);
    expect(toastText()).toBe(t('bmvFolderDeleted', { name: 'Work' }));
    toastButton().click();
    await waitFor(() => row('Work'));
    const work = mark('1').children.find((n) => n.title === 'Work');
    expect(work.children.map((n) => n.title)).toEqual(['Wiki', 'Tracker']);
  });
});

describe('a bookmark\'s note', () => {
  it('is the bookmark\'s own (kept by its id), not the page\'s note; shown under its address', async () => {
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
    expect(tid('bmv-note-text', row('Docs')).textContent).toBe('read the onboarding');
  });
});

describe('the menu and the keys', () => {
  it('a bookmark\'s ⋯ and a folder\'s', async () => {
    seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    tid('quick-more', row('Docs')).click();
    expect(menuLabels()).toEqual([
      t('historyOpen'), t('historyNewWindow'), t('historyBehind'), t('historyBig'), t('copyLink'), t('star'), t('noteAdd'),
      t('historySnooze'), t('bmvSelect'), t('bmvEdit'), t('bmvDelete'),
    ]);
    key('Escape');
    tid('quick-more', row('Work')).click();
    expect(menuLabels()).toEqual([t('bmvAddHere'), t('bmvFolderHere'), t('bmvOpenAll', { count: 2 }), t('bmvRename'), t('bmvDeleteFolder')]);
    menuItem(t('bmvOpenAll', { count: 2 })).click();
    await waitFor(() => chrome.tabs.create.mock.calls.length === 2);
    expect(chrome.tabs.create.mock.calls.map(([p]) => [p.url, p.active])).toEqual([['https://wiki.example/page', false], ['https://tracker.example/', false]]);
  });

  it('↑ ↓ move from the search box, → opens a folder, ← closes it, Enter opens, Space previews, Ctrl+Space picks, Del deletes', async () => {
    const s = seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(document.activeElement).toBe(tid('bookmarks-search'));
    const sel = () => tid('bmv-title', [...tid('bookmarks-tree').children].find((r) => r.getAttribute('aria-selected') === 'true')).textContent;
    expect(sel()).toBe('Bookmarks bar');
    key('ArrowDown'); key('ArrowDown');
    expect(sel()).toBe('Work');
    key('ArrowRight');
    expect(titles()).toContain('Wiki');
    key('ArrowLeft');
    expect(titles()).not.toContain('Wiki');
    key('ArrowUp');
    expect(sel()).toBe('Docs');
    key(' ', { ctrlKey: true });
    expect(tid('bmv-pick', row('Docs')).getAttribute('aria-checked')).toBe('true');
    tid('bookmarks-close').focus(); // out of the box: Space and Del act on the rows
    key(' ');
    expect(tid('big-preview-title').textContent).toBe('Docs');
    key('Escape');
    expect(document.activeElement).toBe(tid('bookmarks-search'));
    tid('bookmarks-close').focus();
    key('Delete'); // the picked one
    await waitFor(() => !row('Docs'));
    expect(chrome.bookmarks.remove).toHaveBeenCalledWith(s.docs.id);
    tid('bookmarks-search').focus();
    sw.bmvSelect(titles().indexOf('Recipes'));
    key('Enter');
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://food.example/recipes' }));
  });

  it('while it is open the rest of the switcher is inert; an edit dialog over it takes the keys', async () => {
    seed();
    const sw = await boot({ tabs: AB });
    await open(sw);
    expect(tid('header').hasAttribute('inert')).toBe(true);
    expect(tid('bookmarks-overlay').hasAttribute('inert')).toBe(false);
    tid('bmv-edit', row('Docs')).click();
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

describe('layers (styles/switcher.css)', () => {
  it('a dialog opens over the full-screen views (an edit over the bookmarks), a select\'s list over the dialog', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8').replace(/\r\n/g, '\n');
    const z = (sel) => { const i = css.indexOf('\n' + sel + ' {'); return +css.slice(i, css.indexOf('}', i)).match(/z-index: (\d+)/)[1]; };
    expect(z('.modal-back')).toBeGreaterThan(z('.arch'));
    expect(z('.menu')).toBeGreaterThan(z('.modal-back'));
    expect(z('.toast')).toBeGreaterThan(z('.modal-back'));
    expect(z('.bigback')).toBeGreaterThan(z('.menu'));
  });
});

