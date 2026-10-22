// "Bookmark…": a dialog to save a tab (or several) as Chrome bookmarks in a folder of your choice, reached from
// a tab's menu, a recently closed one's, a group tile's, the ticked tabs' ⋯ and the palette.
import { describe, it, expect } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, entryByTitle, toastText, toastButton } from '../helpers/quiet-boot.js';
import { t } from '../../utils/translations.js';

const ABC = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }, { title: 'C', url: 'https://c.example/' }];
const folders = () => tids('bookmark-folder').map((r) => tid('bookmark-folder-name', r).textContent);
const chosen = () => tid('bookmark-folder-name', tids('bookmark-folder').find((r) => r.getAttribute('aria-selected') === 'true')).textContent;
const marksIn = (id) => (chrome._findBookmark(id).children || []).filter((n) => n.url);
const seed = () => {
  const work = chrome._addBookmark({ parentId: '1', title: 'Work' });
  chrome._addBookmark({ parentId: work.id, title: 'Projects' });
  chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' }); // Tabazing's own: not offered
  return work;
};
async function openFor(sw, title) {
  sw.select(sw.state.entries.indexOf(entryByTitle(sw, title)));
  key('F10', { shiftKey: true });
  tids('menu-item').find((b) => b.textContent === t('markMenu')).click();
  await waitFor(() => tid('bookmark-form'));
}
const type = (box, text) => { box.value = text; box.dispatchEvent(new Event('input')); };

describe('the Bookmark dialog', () => {
  it('a modal dialog: the name, every folder as a tree (not the archive), "Other bookmarks" chosen at first', async () => {
    let work;
    const sw = await boot({ tabs: ABC, beforeImport: () => { work = seed(); } });
    await openFor(sw, 'B');
    expect(sw.state.modal).toBe('bookmark');
    expect(tid('dialog').getAttribute('aria-modal')).toBe('true');
    expect(tid('dialog-title').textContent).toBe(t('markTitle'));
    expect(tid('bookmark-name').value).toBe('B');
    expect(document.activeElement).toBe(tid('bookmark-name'));
    expect(folders()).toEqual(['Bookmarks bar', 'Work', 'Projects', 'Other bookmarks']);
    expect(tids('bookmark-folder')[2].style.getPropertyValue('--d')).toBe('2');
    expect(chosen()).toBe('Other bookmarks');
    expect(tid('bookmark-folders').getAttribute('role')).toBe('listbox');
    expect(work).toBeTruthy();
  });

  it('Save: a bookmark with that name in the chosen folder, a note with Undo, and the folder is remembered', async () => {
    let work;
    let sw = await boot({ tabs: ABC, beforeImport: () => { work = seed(); } });
    await openFor(sw, 'B');
    tids('bookmark-folder')[1].click(); // Work
    tid('bookmark-name').value = 'Bee';
    tid('bookmark-save').click();
    await waitFor(() => !sw.state.modal);
    expect(marksIn(work.id).map((n) => [n.title, n.url])).toEqual([['Bee', 'https://b.example/']]);
    expect(toastText()).toBe(t('markSaved', { count: 1, folder: 'Work' }));
    toastButton().click();
    await waitFor(() => !marksIn(work.id).length);
    await tick(20);
    await openFor(sw, 'C');
    expect(chosen()).toBe('Work'); // where the last one went
  });

  it('the box finds a folder by name (the first find chosen); ↑/↓ choose another; Enter saves', async () => {
    let work;
    const sw = await boot({ tabs: ABC, beforeImport: () => { work = seed(); } });
    await openFor(sw, 'A');
    const find = tid('bookmark-find');
    type(find, 'proj');
    expect(folders()).toEqual(['Projects']);
    expect(tid('bookmark-folder-path').textContent).toBe('Bookmarks bar › Work › Projects');
    type(find, 'zzz');
    expect(folders()).toEqual([]);
    expect(tid('bookmark-no-folder').hidden).toBe(false);
    expect(tid('bookmark-save').disabled).toBe(true);
    type(find, '');
    expect(chosen()).toBe('Projects'); // still the one found
    find.focus();
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(chosen()).toBe('Work');
    tid('bookmark-folders').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(chosen()).toBe('Other bookmarks');
    tid('bookmark-folders').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(chosen()).toBe('Work');
    tid('bookmark-form').requestSubmit();
    await waitFor(() => !sw.state.modal);
    expect(marksIn(work.id).map((n) => n.url)).toEqual(['https://a.example/']);
  });

  it('New folder: made inside the chosen one, and chosen', async () => {
    const sw = await boot({ tabs: ABC });
    await openFor(sw, 'A');
    tid('bookmark-new').click();
    expect(tid('bookmark-new-row').hidden).toBe(false);
    tid('bookmark-new-name').value = 'Reading';
    tid('bookmark-new-create').click();
    await waitFor(() => folders().includes('Reading'));
    expect(chosen()).toBe('Reading');
    expect(chrome._findBookmark('2').children.map((n) => n.title)).toContain('Reading');
    expect(tid('bookmark-new-row').hidden).toBe(true);
  });

  it('a page already in that folder is renamed, not added twice; where it already is, the dialog says', async () => {
    const sw = await boot({ tabs: ABC, beforeImport: () => { chrome._addBookmark({ parentId: '2', title: 'old', url: 'https://b.example/' }); } });
    await openFor(sw, 'B');
    expect(tid('bookmark-have').textContent).toBe(t('markHave', { folders: 'Other bookmarks' }));
    tid('bookmark-save').click();
    await waitFor(() => !sw.state.modal);
    expect(marksIn('2').map((n) => n.title)).toEqual(['B']);
    expect(toastButton()).toBe(null); // nothing new to undo
  });

  it('Esc and Cancel close it without saving, the focus back to the search box', async () => {
    const sw = await boot({ tabs: ABC });
    await openFor(sw, 'A');
    key('Escape');
    expect(sw.state.modal).toBe(null);
    expect(document.activeElement).toBe(tid('search'));
    await openFor(sw, 'A');
    tid('bookmark-cancel').click();
    expect(sw.state.modal).toBe(null);
    expect(chrome.bookmarks.create).not.toHaveBeenCalled();
  });

  it('several ticked tabs at once (the actions bar\'s ⋯): no name box, all of them into the folder', async () => {
    const sw = await boot({ tabs: ABC });
    sw.pick(entryByTitle(sw, 'A'));
    sw.pick(entryByTitle(sw, 'C'));
    tid('actions-more').click();
    tids('menu-item').find((b) => b.textContent === t('markMenu')).click();
    await waitFor(() => tid('bookmark-form'));
    expect(tid('dialog-title').textContent).toBe(t('markTitleN', { count: 2 }));
    expect(tid('bookmark-name')).toBe(null);
    tid('bookmark-save').click();
    await waitFor(() => !sw.state.modal);
    expect(marksIn('2').map((n) => n.url)).toEqual(['https://a.example/', 'https://c.example/']);
    expect(toastText()).toBe(t('markSaved', { count: 2, folder: 'Other bookmarks' }));
  });

  it('a recently closed tab can be bookmarked from its menu', async () => {
    const sw = await boot({ tabs: ABC, beforeImport: () => { chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'c1', url: 'https://gone.example/', title: 'Gone' } }]; } });
    sw.select(sw.state.entries.findIndex((e) => e.kind === 'closed'));
    key('F10', { shiftKey: true });
    tids('menu-item').find((b) => b.textContent === t('markMenu')).click();
    await waitFor(() => tid('bookmark-form'));
    expect(tid('bookmark-name').value).toBe('Gone');
  });

  it('pages that can\'t be bookmarked (Tabazing\'s own) are left out; none left: a note instead', async () => {
    const sw = await boot({ tabs: ABC });
    await sw.bookmarkDialog([{ title: 'x', url: chrome.runtime.getURL('markup/switcher.html') }]);
    expect(tid('bookmark-form')).toBe(null);
    expect(toastText()).toBe(t('markCant'));
  });
});
