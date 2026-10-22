// Keyboard access and screen readers: Tab through the controls (cards only while Alt is held), Enter/Space
// on a focused button, focus kept in Settings / dialogs / the archive / the big preview and given back, the
// card's menu (Shift+F10), the search box as a combobox, roles and states, the live regions.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, byTestId, allByTestId, cardOf, tabByTitle, toastButton } from '../helpers/quiet-boot.js';
import { translate } from '../../utils/translations.js';

const defaultTabs = [
  { title: 'A', url: 'https://a.example/' },
  { title: 'B', url: 'https://b.example/' },
  { title: 'C', url: 'https://c.example/' },
];
const selected = () => allByTestId('card-tab').find((card) => card.getAttribute('aria-selected') === 'true');
const selectedTitle = () => byTestId('card-title', selected()).textContent;
const menuLabels = () => allByTestId('menu-item').map((button) => button.textContent);
const menuItem = (label) => allByTestId('menu-item').find((button) => button.textContent === label);
const focused = () => document.activeElement;
// The rest of the switcher, made inert while a dialog, the archive or a big preview is open.
const REST = ['header', 'tools', 'body', 'actions'];
const inert = () => REST.filter((id) => byTestId(id).hasAttribute('inert'));
function type(switcher, text) {
  const searchInput = byTestId('search');
  searchInput.focus();
  searchInput.value = text;
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  switcher.flushSearch();
}

describe('Tab', () => {
  it('is the page\'s own while Alt is not held: not prevented, the selection stays', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { direction: 0 } });
    const event = key('Tab');
    expect(event.defaultPrevented).toBe(false);
    expect(selectedTitle()).toBe('A');
    expect(switcher.state.done).toBe(false);
  });

  it('steps through the cards while Alt is held from Alt+Q / Alt+W', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { direction: 0 } });
    switcher.state.holding = true;
    expect(key('Tab', { altKey: true }).defaultPrevented).toBe(true);
    expect(selectedTitle()).toBe('B');
    expect(key('Tab', { altKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(selectedTitle()).toBe('A');
  });

  it('wraps around at the ends instead of leaving the page (which would close the switcher)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const list = switcher.tabbables(byTestId('app'));
    expect(list[0]).toBe(byTestId('menu-button'));
    expect(list).toContain(byTestId('search'));
    list[0].focus();
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(focused()).toBe(list[list.length - 1]);
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(list[0]);
  });

  it('reaches the header, the toolbar, the windows and their merge buttons, the toast\'s Undo and the alert\'s button', async () => {
    const switcher = await boot({
      tabs: defaultTabs, preferences: { allWindows: true },
      beforeImport: () => { chrome._addTab({ windowId: 2, title: 'D', url: 'https://d.example/', active: true }); },
    });
    switcher.toast('Closed', null, { label: 'Undo', run: () => {} });
    switcher.showAlert('Problem', 'Fix', () => {});
    const list = switcher.tabbables(byTestId('app'));
    for (const id of ['menu-button', 'new-tab', 'search', 'keys-button', 'select-sort', 'star-filter', 'window-all', 'window-merge', 'toast-action', 'alert-button']) {
      expect(list, id).toContain(byTestId(id));
    }
    // The merge button is a real button beside the window's (not inside it).
    const merge = byTestId('window-merge');
    expect(merge.tagName).toBe('BUTTON');
    expect(merge.closest('[data-testid="window-item"]')).toBe(null);
    expect(merge.parentElement).toBe(allByTestId('window-item')[1].parentElement);
    // Buttons inside cards are not stops: the card's menu has their actions.
    expect(list.some((element) => element.closest('[data-testid="card-tab"]'))).toBe(false);
  });
});

describe('Enter and Space on a focused button', () => {
  it('press the button (the browser does), they do not open the selected card or its preview', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('star-filter').focus();
    const enter = key('Enter');
    expect(enter.defaultPrevented).toBe(false);
    const space = key(' ');
    expect(space.defaultPrevented).toBe(false);
    expect(byTestId('big-preview')).toBe(null);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(switcher.state.done).toBe(false);
  });

  it('a checkbox-like or menu button too; Esc still works there', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    type(switcher, 'b');
    byTestId('new-tab').focus();
    expect(key('Enter').defaultPrevented).toBe(false);
    expect(switcher.state.done).toBe(false);
    key('Escape'); // clears the search, as from the box
    expect(byTestId('search').value).toBe('');
    expect(switcher.state.done).toBe(false);
  });

  it('typing a letter on a button still goes to the search box', async () => {
    await boot({ tabs: defaultTabs });
    byTestId('star-filter').focus();
    key('x');
    expect(focused()).toBe(byTestId('search'));
  });

  it('Enter in the search box still opens the selected card', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('search').focus();
    key('Enter');
    await waitFor(() => switcher.state.done);
  });

  it('a redraw puts the focus back on the button that was pressed', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('star-filter').focus();
    switcher.toggleStarFilter(); // what its click does: a redraw
    expect(focused()).toBe(byTestId('star-filter'));
  });
});

describe('Settings', () => {
  async function openSettings() {
    byTestId('settings-button').click();
    await waitFor(() => byTestId('settings'));
    await tick();
    return byTestId('settings');
  }

  it('takes the focus (on its selected category) as it opens and keeps Tab inside', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const dialog = await openSettings();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(focused()).toBe(byTestId('settings-tab-look'));
    for (const id of REST) expect(byTestId(id).hasAttribute('inert'), id).toBe(true);
    const list = switcher.tabbables(dialog);
    expect(list[0]).toBe(byTestId('settings-close'));
    expect(list).toContain(byTestId('settings-tab-look'));
    expect(list).not.toContain(byTestId('settings-tab-cards')); // one tab stop for the tab list
    expect(list).not.toContain(byTestId('settings-pinned-first')); // nor the hidden categories' controls
    list[0].focus();
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(focused()).toBe(list[list.length - 1]);
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(list[0]);
    byTestId('search').focus(); // the focus somehow outside: Tab brings it back in
    key('Tab');
    expect(focused()).toBe(list[0]);
  });

  it('Esc closes it and gives the focus back to the gear', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await openSettings();
    key('Escape');
    expect(byTestId('settings')).toBe(null);
    expect(focused()).toBe(byTestId('menu-button'));
    expect(switcher.state.done).toBe(false);
  });

  it('so does the gear again, and a click on the backdrop', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await openSettings();
    await switcher.openSettings(byTestId('settings-button'));
    expect(byTestId('settings')).toBe(null);
    expect(focused()).toBe(byTestId('menu-button'));
    await openSettings();
    const back = byTestId('settings-backdrop');
    back.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(byTestId('settings')).toBe(null);
    expect(focused()).toBe(byTestId('menu-button'));
    expect(switcher.state.done).toBe(false);
  });

  it('typing a letter there stays there, and the switcher\'s keys don\'t reach behind it', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const dialog = await openSettings();
    key('x');
    expect(dialog.contains(focused())).toBe(true);
    key('k', { code: 'KeyK', ctrlKey: true }); // the palette's key
    expect(switcher.state.palette).toBeFalsy();
    key('Delete');
    expect(switcher.state.tabs).toHaveLength(3);
  });

  it('its tabs are buttons of at least 24 px with a visible focus ring (styles/switcher.css)', async () => {
    await boot({ tabs: defaultTabs });
    await openSettings();
    for (const id of ['settings-tab-look', 'settings-close']) expect(byTestId(id).tagName, id).toBe('BUTTON');
    const css = readFileSync(resolve(process.cwd(), 'styles/switcher.css'), 'utf8');
    expect(css).toMatch(/\.settings-tab \{[^}]*min-height: 40px/);
    expect(css).toMatch(/\.settings-close, \.note-close, \.big-close \{[^}]*width: 36px; height: 36px/);
    expect(css).toMatch(/:focus-visible \{ outline: 3px solid var\(--focus\)/);
  });
});

describe("the card's menu (Shift+F10, the menu key)", () => {
  it('lists every action of the card\'s buttons, starting with Select', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { direction: 0 } });
    switcher.select(1);
    const event = key('F10', { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(byTestId('menu')).not.toBe(null);
    expect(menuLabels()).toEqual([
      translate('menuSelect'), translate('star'), translate('copyLink'), translate('capturePreview'), translate('tabReload'), translate('tabDuplicate'), translate('sleepThis'),
      translate('tabMute'), translate('tabPin'), translate('snoozeThis'), translate('tabArchive'), translate('noteAdd'), translate('groupAddTo'), translate('markMenu'), translate('tabClose'),
    ]);
    expect(focused()).toBe(allByTestId('menu-item')[0]);
  });

  it('Select ticks the card (aria-checked), and the focus goes back to the search box', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { direction: 0 } });
    switcher.select(1);
    key('ContextMenu');
    menuItem(translate('menuSelect')).click();
    expect(switcher.state.picked.has(tabByTitle(switcher, 'B').id)).toBe(true);
    expect(cardOf('B').getAttribute('aria-checked')).toBe('true');
    expect(cardOf('A').getAttribute('aria-checked')).toBe('false');
    expect(byTestId('menu')).toBe(null);
    expect(focused()).toBe(byTestId('search'));
    key('F10', { shiftKey: true });
    expect(menuItem(translate('menuUnselect'))).not.toBe(undefined);
    menuItem(translate('menuUnselect')).click();
    expect(switcher.state.picked.size).toBe(0);
    expect(cardOf('B').getAttribute('aria-checked')).toBe('false');
  });

  it('its items call what the buttons call: star, pin, close', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { direction: 0 } });
    switcher.select(1);
    key('F10', { shiftKey: true });
    menuItem(translate('star')).click();
    await waitFor(() => switcher.isStarred('https://b.example/'));
    switcher.selectKey('t' + tabByTitle(switcher, 'B').id);
    key('F10', { shiftKey: true });
    expect(menuItem(translate('unstar'))).not.toBe(undefined);
    menuItem(translate('tabPin')).click();
    await waitFor(() => chrome.tabs.update.mock.calls.some(([id, properties]) => id === tabByTitle(switcher, 'B').id && properties.pinned === true));
    switcher.selectKey('t' + tabByTitle(switcher, 'B').id);
    key('F10', { shiftKey: true });
    menuItem(translate('tabClose')).click();
    await waitFor(() => chrome.tabs.remove.mock.calls.length > 0);
  });

  it('Esc closes it, back to the search box; Chrome\'s own context menu is held back', async () => {
    await boot({ tabs: defaultTabs });
    key('ContextMenu');
    expect(byTestId('menu')).not.toBe(null);
    const contextMenuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    window.dispatchEvent(contextMenuEvent);
    expect(contextMenuEvent.defaultPrevented).toBe(true);
    key('Escape');
    expect(byTestId('menu')).toBe(null);
    expect(focused()).toBe(byTestId('search'));
  });

  it('Snooze opens its choices, and the note item the note card (× back to the search box)', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { direction: 0 } });
    switcher.select(1);
    key('F10', { shiftKey: true });
    menuItem(translate('snoozeThis')).click();
    expect(allByTestId('menu-item').length).toBe(switcher.snoozeChoices().length + 1); // and "Pick a time…"
    key('Escape');
    expect(focused()).toBe(byTestId('search'));
    key('F10', { shiftKey: true });
    menuItem(translate('noteAdd')).click();
    expect(byTestId('note-popover')).not.toBe(null);
    byTestId('note-close').click();
    expect(focused()).toBe(byTestId('search'));
  });

  it('a closed card: reopen it (here, in a new window, behind), copy, star, note, bookmark, snooze, archive, remove', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.state.closed = [{ id: 'l1', kind: 'tab', url: 'https://gone.example/', title: 'Gone', timestamp: Date.now(), count: 1, session: null, fields: [['Gone', 'https://gone.example/']] }];
    switcher.refresh();
    switcher.select(switcher.state.entries.findIndex((entry) => entry.kind === 'closed'));
    key('F10', { shiftKey: true });
    expect(menuLabels()).toEqual([
      translate('closedReopen'), translate('closedNewWindow'), translate('closedBackground'), translate('copyLink'), translate('star'), translate('noteAdd'), translate('markMenu'),
      translate('closedSnooze'), translate('tabArchive'), translate('closedRemove'),
    ]);
  });

  it('a closed window: reopen it, copy its links, bookmark them, remove it', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.state.closed = [{ id: 's9', kind: 'window', url: 'https://one.example/', title: 'Window', timestamp: Date.now(), count: 2, session: { window: { sessionId: '9' } }, fields: [['One', 'https://one.example/'], ['Two', 'https://two.example/']] }];
    switcher.refresh();
    switcher.select(switcher.state.entries.findIndex((entry) => entry.kind === 'closed'));
    key('F10', { shiftKey: true });
    expect(menuLabels()).toEqual([translate('closedReopenWindow'), translate('actionCopy'), translate('markMenu'), translate('closedRemove')]);
  });
});

describe('the search box is a combobox', () => {
  it('points at the selected card, and at the dropdown\'s row while that shows', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { direction: 0 } });
    const searchInput = byTestId('search');
    expect(searchInput.getAttribute('role')).toBe('combobox');
    expect(searchInput.getAttribute('aria-autocomplete')).toBe('list');
    expect(searchInput.getAttribute('aria-controls').split(' ')).toEqual(['open-grid', 'snoozed-grid', 'closed-grid']);
    expect(searchInput.getAttribute('aria-expanded')).toBe('false');
    expect(searchInput.getAttribute('aria-activedescendant')).toBe(selected().id);
    switcher.select(2);
    expect(searchInput.getAttribute('aria-activedescendant')).toBe(selected().id);
    type(switcher, 'b');
    expect(byTestId('search-dropdown')).not.toBe(null);
    expect(searchInput.getAttribute('aria-expanded')).toBe('true');
    expect(searchInput.getAttribute('aria-activedescendant')).toBe('dropdown-0');
    key('Escape'); // clears the search: the dropdown goes
    expect(byTestId('search-dropdown')).toBe(null);
    expect(searchInput.getAttribute('aria-expanded')).toBe('false');
    expect(searchInput.getAttribute('aria-activedescendant')).toBe(selected().id); // not a stale dd-N
  });

  it('source icons are labelled images; the Google "G" is hidden', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    type(switcher, 'b');
    const icon = byTestId('dropdown-source-tab');
    expect(icon.getAttribute('role')).toBe('img');
    expect(icon.getAttribute('aria-label')).toBe(translate('sourceTab'));
    type(switcher, 'zzzqqq');
    expect(byTestId('dropdown-google-icon').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('roles and states', () => {
  it('each section\'s cards are a listbox; the open tabs area is a group, not multiselectable', async () => {
    await boot({ tabs: defaultTabs });
    const grid = byTestId('open-grid');
    expect(grid.getAttribute('role')).toBe('group');
    expect(grid.hasAttribute('aria-multiselectable')).toBe(false);
    const list = byTestId('section-grid');
    expect(list.getAttribute('role')).toBe('listbox');
    expect(list.getAttribute('aria-labelledby')).toBe('open-heading');
    expect(list.getAttribute('aria-activedescendant')).toBe(selected().id);
  });

  it('section headers sit outside the lists, which are named after them', async () => {
    const switcher = await boot({ tabs: [...defaultTabs, { title: 'A again', url: 'https://a.example/' }] });
    switcher.duplicatesView(true);
    const head = byTestId('section-toggle');
    expect(head.closest('[role=listbox]')).toBe(null);
    const list = byTestId('section-grid');
    expect(document.getElementById(list.getAttribute('aria-labelledby'))).toBe(byTestId('section-name'));
    expect(byTestId('section-grid').getAttribute('aria-activedescendant')).toBe(selected().id);
  });

  it('buttons inside a card are hidden from the keyboard and screen readers, but still click', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const card = cardOf('B');
    const buttons = [...card.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(5);
    for (const button of buttons) {
      expect(button.tabIndex, button.dataset.testid).toBe(-1);
      expect(button.getAttribute('aria-hidden'), button.dataset.testid).toBe('true');
    }
    byTestId('card-star-button', card).click();
    await waitFor(() => switcher.isStarred('https://b.example/'));
  });

  it('pressing one keeps the focus where it was; given the focus anyway, it isn\'t aria-hidden while it has it', async () => {
    await boot({ tabs: defaultTabs });
    const x = byTestId('card-close', cardOf('B'));
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    x.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true); // (a button press would otherwise focus it)
    x.focus(); // as a note card closing gives the focus back to its button
    expect(document.activeElement).toBe(x);
    expect(x.hasAttribute('aria-hidden')).toBe(false); // Chrome blocks aria-hidden on the focused element, and warns
    byTestId('search').focus();
    expect(x.getAttribute('aria-hidden')).toBe('true');
  });

  it('a ticked card says so with aria-checked; aria-selected is the cursor', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { direction: 0 } });
    switcher.pick(switcher.state.entries[2]);
    switcher.select(0);
    expect(cardOf('C').getAttribute('aria-checked')).toBe('true');
    expect(cardOf('C').getAttribute('aria-selected')).toBe('false');
    expect(cardOf('A').getAttribute('aria-checked')).toBe('false');
  });

  it('every card is described by its site', async () => {
    await boot({ tabs: defaultTabs });
    const card = cardOf('B');
    const description = document.getElementById(card.getAttribute('aria-describedby'));
    expect(description).toBe(byTestId('card-description', card));
    expect(description.textContent).toBe('b.example');
  });

  it('a select button says whether its list is open, and the focus comes back to it', async () => {
    await boot({ tabs: defaultTabs });
    const button = byTestId('select-sort');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    allByTestId('menu-item')[0].click();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    key('Escape');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(focused()).toBe(button);
  });

  it('a menu gives the focus back to its button after an item is chosen', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const anchor = switcher.makeElement('button', '', 'Anchor', 'test-anchor');
    byTestId('tools').append(anchor);
    const callback = vi.fn();
    switcher.menu(anchor, [{ label: 'One', run: callback }]);
    allByTestId('menu-item')[0].click();
    await tick();
    expect(callback).toHaveBeenCalled();
    expect(focused()).toBe(anchor);
  });
});

describe('live regions', () => {
  it('the toast is read from a status region that is always there', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const live = byTestId('live-status');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.hidden).toBe(false);
    vi.useFakeTimers();
    try {
      switcher.toast('Copied 2 links');
      expect(live.textContent).toBe('Copied 2 links');
      vi.advanceTimersByTime(3000);
      expect(byTestId('toast').hidden).toBe(true);
      expect(live.isConnected && !live.hidden).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('the alert is read from an alert region that is always there', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const live = byTestId('live-alert');
    expect(live.getAttribute('role')).toBe('alert');
    switcher.showAlert('Problem', 'Fix', () => {});
    expect(live.textContent).toBe('Problem');
    expect(live.hidden).toBe(false);
  });
});

describe('dialogs, the archive and the big preview keep the focus', () => {
  it('a dialog makes the rest inert and gives the focus back to what had it', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('star-filter').focus();
    switcher.askStep1();
    expect(inert()).toEqual(REST);
    expect(byTestId('modal').hasAttribute('inert')).toBe(false);
    expect(byTestId('toast').hasAttribute('inert')).toBe(false);
    expect(byTestId('dialog').contains(focused())).toBe(true);
    const list = switcher.tabbables(byTestId('modal'));
    list[list.length - 1].focus();
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(list[0]);
    key('Escape');
    expect(inert()).toEqual([]);
    expect(focused()).toBe(byTestId('star-filter'));
  });

  it('the big preview: the rest inert, Tab stays on it, the focus back to the search box', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    switcher.openBig(switcher.state.entries[1]);
    expect(inert()).toEqual(REST);
    expect(byTestId('big-preview').hasAttribute('inert')).toBe(false);
    expect(focused()).toBe(byTestId('big-preview-close'));
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(byTestId('big-preview-close'));
    key('Escape');
    expect(inert()).toEqual([]);
    expect(focused()).toBe(byTestId('search'));
  });

  it('the archive: the rest inert (not the toast), the focus back to the Archive button', async () => {
    chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('archive-button').click();
    await waitFor(() => switcher.archiveOpen());
    expect(inert()).toEqual(REST);
    expect(byTestId('toast').hasAttribute('inert')).toBe(false);
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(byTestId('archive-overlay').contains(focused())).toBe(true);
    key('Escape');
    expect(inert()).toEqual([]);
    expect(focused()).toBe(byTestId('menu-button'));
  });

  it('in the archive, Ctrl+Z runs the toast\'s Undo', async () => {
    const folder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: folder.id, title: 'Old', url: 'https://old.example/' });
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('archive-button').click();
    await waitFor(() => allByTestId('card-archived').length === 1);
    key('Delete');
    await waitFor(() => allByTestId('card-archived').length === 0 && toastButton());
    const event = key('z', { ctrlKey: true, code: 'KeyZ' });
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => allByTestId('card-archived').length === 1);
    expect(byTestId('toast').hidden).toBe(true);
    expect(switcher.state.done).toBe(false);
  });

  it("the note card's × gives the focus back to the note button that opened it", async () => {
    await boot({ tabs: defaultTabs });
    const noteButton = byTestId('quick-note', cardOf('B'));
    noteButton.focus();
    noteButton.click();
    byTestId('note-close').click();
    expect(focused()).toBe(noteButton);
  });
});

describe('the note tooltip', () => {
  const withNote = { tabs: defaultTabs, beforeImport: () => chrome.storage.local.set({ notes: { 'https://b.example/': { u: 'https://b.example/', n: 'remember', t: 1 } } }) };

  it('Esc hides it (and nothing else)', async () => {
    const switcher = await boot(withNote);
    byTestId('quick-note', cardOf('B')).dispatchEvent(new Event('mouseenter'));
    await waitFor(() => byTestId('note-tooltip'));
    const event = key('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(byTestId('note-tooltip')).toBe(null);
    expect(switcher.state.done).toBe(false);
  });

  it('stays while the pointer is on it, goes once it leaves', async () => {
    const switcher = await boot(withNote);
    const noteButton = byTestId('quick-note', cardOf('B'));
    noteButton.dispatchEvent(new Event('mouseenter'));
    const tooltip = await waitFor(() => byTestId('note-tooltip'));
    noteButton.dispatchEvent(new Event('mouseleave'));
    tooltip.dispatchEvent(new Event('mouseenter'));
    await tick(switcher.TIP_DELAY_MILLISECONDS + 50);
    expect(byTestId('note-tooltip')).toBe(tooltip);
    tooltip.dispatchEvent(new Event('mouseleave'));
    await waitFor(() => !byTestId('note-tooltip'));
  });
});

describe('where menus and small cards open (switcher.js dropFrom)', () => {
  // jsdom lays nothing out: each test gives the node and the trigger their sizes.
  const sized = (width, height) => { const element = document.createElement('div'); Object.defineProperty(element, 'offsetWidth', { value: width }); Object.defineProperty(element, 'offsetHeight', { get: () => (element.style.maxHeight ? Math.min(height, parseFloat(element.style.maxHeight)) : height) }); return element; };
  const at = (element) => ({ left: parseFloat(element.style.left), top: parseFloat(element.style.top), up: element.classList.contains('up'), max: element.style.maxHeight });

  it('drops down from just under its trigger, its end edge on the trigger\'s end, or its start on the start (a select)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const element = sized(200, 300);
    switcher.dropFrom(element, { left: 400, right: 500, top: 100, bottom: 130 });
    expect(at(element)).toEqual({ left: 300, top: 134, up: false, max: '' });
    switcher.dropFrom(element, { left: 400, right: 500, top: 100, bottom: 130 }, { alignLeft: true });
    expect(at(element)).toEqual({ left: 400, top: 134, up: false, max: '' });
  });

  it('with no room below and more above, it opens just above its trigger, dropping up (.up)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const element = sized(200, 300);
    const windowHeight = window.innerHeight;
    switcher.dropFrom(element, { left: 400, right: 500, top: windowHeight - 150, bottom: windowHeight - 120 });
    expect(at(element)).toEqual({ left: 300, top: windowHeight - 150 - 4 - 300, up: true, max: '' });
    switcher.dropFrom(element, { left: 400, right: 500, top: 100, bottom: 130 }); // and down again from a trigger higher up
    expect(at(element).up).toBe(false);
  });

  it('kept inside the window; too tall for its side, a menu scrolls inside (fit)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    const element = sized(200, 5000);
    const windowHeight = window.innerHeight;
    switcher.dropFrom(element, { left: 2, right: 40, top: 100, bottom: 130 }, { fit: true });
    expect(at(element)).toEqual({ left: 8, top: 134, up: false, max: (windowHeight - 130 - 4 - 8) + 'px' });
    const wide = sized(300, 50);
    switcher.dropFrom(wide, { left: window.innerWidth - 20, right: window.innerWidth - 10, top: 100, bottom: 130 }, { alignLeft: true });
    expect(at(wide).left).toBe(window.innerWidth - 300 - 8);
  });

  it('a card\'s menu from the keyboard drops from the card\'s ⋯ button (as a click on it would), not from under the card', async () => {
    const switcher = await boot({ tabs: defaultTabs, context: { direction: 0 } });
    switcher.select(1);
    const more = byTestId('quick-more', cardOf('B'));
    more.getClientRects = () => [{ width: 30, height: 30 }];
    more.getBoundingClientRect = () => ({ left: 300, right: 330, top: 100, bottom: 130, width: 30, height: 30 });
    key('F10', { shiftKey: true });
    expect(byTestId('menu').anchor).toBe(more);
    expect(at(byTestId('menu'))).toMatchObject({ top: 134, up: false });
    key('Escape');
    more.getClientRects = () => []; // not shown (a list row): from the card's header
    key('F10', { shiftKey: true });
    expect(byTestId('menu').anchor).toBe(byTestId('card-head', cardOf('B')));
  });

  it('a right-click opens it at the pointer, rightwards', async () => {
    await boot({ tabs: defaultTabs });
    cardOf('B').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 210, clientY: 120 }));
    expect(at(byTestId('menu'))).toMatchObject({ left: 210, top: 122, up: false });
  });
});

describe('the menu (☰)', () => {
  const items = () => [...byTestId('drawer').querySelectorAll('button.drawer-item')];
  it('a drawer from the left with History, Bookmarks, Archive and Settings, each with its icon and name', async () => {
    await boot({ tabs: defaultTabs });
    expect(byTestId('header').firstElementChild).toBe(byTestId('menu-button'));
    for (const id of ['settings-button', 'archive-button', 'history-button', 'bookmarks-button']) expect(byTestId('header').contains(byTestId(id)), id).toBe(false);
    expect(byTestId('drawer-back').hidden).toBe(true);
    expect(byTestId('menu-button').getAttribute('aria-expanded')).toBe('false');
    byTestId('menu-button').click();
    expect(byTestId('drawer-back').hidden).toBe(false);
    expect(byTestId('menu-button').getAttribute('aria-expanded')).toBe('true');
    expect(items().map((button) => button.dataset.testid)).toEqual(['history-button', 'bookmarks-button', 'archive-button', 'backup-button', 'settings-button']);
    expect(items().every((button) => button.querySelector('svg') && button.querySelector('.drawer-label').textContent)).toBe(true);
    expect(focused()).toBe(byTestId('history-button'));
    for (const id of REST) expect(byTestId(id).hasAttribute('inert'), id).toBe(true);
  });

  it('↓ ↑ move between its buttons; Esc closes it, back to ☰; so do × and a press beside it (not closing Tabazing)', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('menu-button').click();
    key('ArrowDown');
    expect(focused()).toBe(byTestId('bookmarks-button'));
    key('ArrowUp'); key('ArrowUp');
    expect(focused()).toBe(byTestId('settings-button'));
    key('Escape');
    expect(byTestId('drawer-back').hidden).toBe(true);
    expect(focused()).toBe(byTestId('menu-button'));
    byTestId('menu-button').click();
    byTestId('drawer-close').click();
    expect(byTestId('drawer-back').hidden).toBe(true);
    byTestId('menu-button').click();
    byTestId('drawer-back').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(byTestId('drawer-back').hidden).toBe(true);
    expect(switcher.state.done).toBe(false);
  });

  it('a button closes it and opens its dialog, which gives the focus back to ☰', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    byTestId('menu-button').click();
    byTestId('settings-button').click();
    await waitFor(() => byTestId('settings'));
    expect(byTestId('drawer-back').hidden).toBe(true);
    key('Escape');
    expect(focused()).toBe(byTestId('menu-button'));
    byTestId('menu-button').click();
    byTestId('history-button').click();
    await waitFor(() => switcher.historyOpen());
    expect(byTestId('drawer-back').hidden).toBe(true);
  });
});

describe('the History, Bookmarks and Archive dialogs', () => {
  it('open as Settings does: a panel over the dimmed switcher; a press on the backdrop closes it, not Tabazing', async () => {
    const switcher = await boot({ tabs: defaultTabs });
    await switcher.openBookmarks();
    expect(byTestId('bookmarks-panel').getAttribute('role')).toBe('dialog');
    byTestId('bookmarks-overlay').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(switcher.bookmarksOpen()).toBe(false);
    expect(switcher.state.done).toBe(false);
    const css = readFileSync(resolve(process.cwd(), 'styles/switcher.css'), 'utf8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/\n\.archive-dialog \{[^}]*background: var\(--md-scrim\)/);
    expect(css).toMatch(/\n\.archive-panel \{[^}]*border-radius: var\(--radius-extra-large\)/);
  });
});
