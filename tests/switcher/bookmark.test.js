// "Bookmark…": a dialog to save a tab (or several) as Chrome bookmarks in a folder of your choice, reached from
// a tab's menu, a recently closed one's, a group tile's, the ticked tabs' ⋯ and the palette.
import { describe, it, expect } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, entryByTitle, toastText, toastButton } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';

const threeTabs = [{ title: 'A', url: 'https://a.example/' }, { title: 'B', url: 'https://b.example/' }, { title: 'C', url: 'https://c.example/' }];
const folders = () => allByTestId('bookmark-folder').map((row) => byTestId('bookmark-folder-name', row).textContent);
const chosen = () => byTestId('bookmark-folder-name', allByTestId('bookmark-folder').find((row) => row.getAttribute('aria-selected') === 'true')).textContent;
const marksIn = (id) => (chrome._findBookmark(id).children || []).filter((node) => node.url);
const seed = () => {
  const work = chrome._addBookmark({ parentId: '1', title: 'Work' });
  chrome._addBookmark({ parentId: work.id, title: 'Projects' });
  chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' }); // Tabazing's own: not offered
  return work;
};
async function openFor(switcher, title) {
  switcher.select(switcher.state.entries.indexOf(entryByTitle(switcher, title)));
  key('F10', { shiftKey: true });
  allByTestId('menu-item').find((button) => button.textContent === translate('markMenu')).click();
  await waitFor(() => byTestId('bookmark-form'));
}
const type = (box, text) => { box.value = text; box.dispatchEvent(new Event('input')); };

describe('the Bookmark dialog', () => {
  it('a modal dialog: the name, every folder as a tree (not the archive), "Other bookmarks" chosen at first', async () => {
    let work;
    const switcher = await boot({ tabs: threeTabs, beforeImport: () => { work = seed(); } });
    await openFor(switcher, 'B');
    expect(switcher.state.modal).toBe('bookmark');
    expect(byTestId('dialog').getAttribute('aria-modal')).toBe('true');
    expect(byTestId('dialog-title').textContent).toBe(translate('markTitle'));
    expect(byTestId('bookmark-name').value).toBe('B');
    expect(document.activeElement).toBe(byTestId('bookmark-name'));
    expect(folders()).toEqual(['Bookmarks bar', 'Work', 'Projects', 'Other bookmarks']);
    expect(allByTestId('bookmark-folder')[2].style.getPropertyValue('--depth')).toBe('2');
    expect(chosen()).toBe('Other bookmarks');
    expect(byTestId('bookmark-folders').getAttribute('role')).toBe('listbox');
    expect(work).toBeTruthy();
  });

  it('Save: a bookmark with that name in the chosen folder, a note with Undo, and the folder is remembered', async () => {
    let work;
    let switcher = await boot({ tabs: threeTabs, beforeImport: () => { work = seed(); } });
    await openFor(switcher, 'B');
    allByTestId('bookmark-folder')[1].click(); // Work
    byTestId('bookmark-name').value = 'Bee';
    byTestId('bookmark-save').click();
    await waitFor(() => !switcher.state.modal);
    expect(marksIn(work.id).map((node) => [node.title, node.url])).toEqual([['Bee', 'https://b.example/']]);
    expect(toastText()).toBe(translate('markSaved', { count: 1, folder: 'Work' }));
    toastButton().click();
    await waitFor(() => !marksIn(work.id).length);
    await tick(20);
    await openFor(switcher, 'C');
    expect(chosen()).toBe('Work'); // where the last one went
  });

  it('the box finds a folder by name (the first find chosen); ↑/↓ choose another; Enter saves', async () => {
    let work;
    const switcher = await boot({ tabs: threeTabs, beforeImport: () => { work = seed(); } });
    await openFor(switcher, 'A');
    const find = byTestId('bookmark-find');
    type(find, 'proj');
    expect(folders()).toEqual(['Projects']);
    expect(byTestId('bookmark-folder-path').textContent).toBe('Bookmarks bar › Work › Projects');
    type(find, 'zzz');
    expect(folders()).toEqual([]);
    expect(byTestId('bookmark-no-folder').hidden).toBe(false);
    expect(byTestId('bookmark-save').disabled).toBe(true);
    type(find, '');
    expect(chosen()).toBe('Projects'); // still the one found
    find.focus();
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(chosen()).toBe('Work');
    byTestId('bookmark-folders').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(chosen()).toBe('Other bookmarks');
    byTestId('bookmark-folders').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(chosen()).toBe('Work');
    byTestId('bookmark-form').requestSubmit();
    await waitFor(() => !switcher.state.modal);
    expect(marksIn(work.id).map((node) => node.url)).toEqual(['https://a.example/']);
  });

  it('New folder: made inside the chosen one, and chosen', async () => {
    const switcher = await boot({ tabs: threeTabs });
    await openFor(switcher, 'A');
    byTestId('bookmark-new').click();
    expect(byTestId('bookmark-new-row').hidden).toBe(false);
    byTestId('bookmark-new-name').value = 'Reading';
    byTestId('bookmark-new-create').click();
    await waitFor(() => folders().includes('Reading'));
    expect(chosen()).toBe('Reading');
    expect(chrome._findBookmark('2').children.map((node) => node.title)).toContain('Reading');
    expect(byTestId('bookmark-new-row').hidden).toBe(true);
  });

  it('a page already in that folder is renamed, not added twice; where it already is, the dialog says', async () => {
    const switcher = await boot({ tabs: threeTabs, beforeImport: () => { chrome._addBookmark({ parentId: '2', title: 'old', url: 'https://b.example/' }); } });
    await openFor(switcher, 'B');
    expect(byTestId('bookmark-have').textContent).toBe(translate('markHave', { folders: 'Other bookmarks' }));
    byTestId('bookmark-save').click();
    await waitFor(() => !switcher.state.modal);
    expect(marksIn('2').map((node) => node.title)).toEqual(['B']);
    expect(toastButton()).toBe(null); // nothing new to undo
  });

  it('Esc and Cancel close it without saving, the focus back to the search box', async () => {
    const switcher = await boot({ tabs: threeTabs });
    await openFor(switcher, 'A');
    key('Escape');
    expect(switcher.state.modal).toBe(null);
    expect(document.activeElement).toBe(byTestId('search'));
    await openFor(switcher, 'A');
    byTestId('bookmark-cancel').click();
    expect(switcher.state.modal).toBe(null);
    expect(chrome.bookmarks.create).not.toHaveBeenCalled();
  });

  it('several ticked tabs at once (the actions bar\'s ⋯): no name box, all of them into the folder', async () => {
    const switcher = await boot({ tabs: threeTabs });
    switcher.pick(entryByTitle(switcher, 'A'));
    switcher.pick(entryByTitle(switcher, 'C'));
    byTestId('actions-more').click();
    allByTestId('menu-item').find((button) => button.textContent === translate('markMenu')).click();
    await waitFor(() => byTestId('bookmark-form'));
    expect(byTestId('dialog-title').textContent).toBe(translate('markTitleCount', { count: 2 }));
    expect(byTestId('bookmark-name')).toBe(null);
    byTestId('bookmark-save').click();
    await waitFor(() => !switcher.state.modal);
    expect(marksIn('2').map((node) => node.url)).toEqual(['https://a.example/', 'https://c.example/']);
    expect(toastText()).toBe(translate('markSaved', { count: 2, folder: 'Other bookmarks' }));
  });

  it('a recently closed tab can be bookmarked from its menu', async () => {
    const switcher = await boot({ tabs: threeTabs, beforeImport: () => { chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'c1', url: 'https://gone.example/', title: 'Gone' } }]; } });
    switcher.select(switcher.state.entries.findIndex((entry) => entry.kind === 'closed'));
    key('F10', { shiftKey: true });
    allByTestId('menu-item').find((button) => button.textContent === translate('markMenu')).click();
    await waitFor(() => byTestId('bookmark-form'));
    expect(byTestId('bookmark-name').value).toBe('Gone');
  });

  it('pages that can\'t be bookmarked (Tabazing\'s own) are left out; none left: a note instead', async () => {
    const switcher = await boot({ tabs: threeTabs });
    await switcher.bookmarkDialog([{ title: 'x', url: chrome.runtime.getURL('markup/switcher.html') }]);
    expect(byTestId('bookmark-form')).toBe(null);
    expect(toastText()).toBe(translate('markCant'));
  });
});
