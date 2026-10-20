// Keyboard access and screen readers: Tab through the controls (cards only while Alt is held), Enter/Space
// on a focused button, focus kept in Settings / dialogs / the archive / the big preview and given back, the
// card's menu (Shift+F10), the search box as a combobox, roles and states, the live regions.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, tid, tids, cardOf, tabByTitle, toastButton } from './quiet-boot.js';
import { t } from '../../utils/translations.js';

const ABC = [
  { title: 'A', url: 'https://a.example/' },
  { title: 'B', url: 'https://b.example/' },
  { title: 'C', url: 'https://c.example/' },
];
const selected = () => tids('card-tab').find((c) => c.getAttribute('aria-selected') === 'true');
const selectedTitle = () => tid('card-title', selected()).textContent;
const menuLabels = () => tids('menu-item').map((b) => b.textContent);
const menuItem = (label) => tids('menu-item').find((b) => b.textContent === label);
const focused = () => document.activeElement;
// The rest of the switcher, made inert while a dialog, the archive or a big preview is open.
const REST = ['header', 'tools', 'body', 'acts'];
const inert = () => REST.filter((id) => tid(id).hasAttribute('inert'));
function type(sw, text) {
  const s = tid('search');
  s.focus();
  s.value = text;
  s.dispatchEvent(new Event('input', { bubbles: true }));
  sw.flushSearch();
}

describe('Tab', () => {
  it('is the page\'s own while Alt is not held: not prevented, the selection stays', async () => {
    const sw = await boot({ tabs: ABC, ctx: { dir: 0 } });
    const e = key('Tab');
    expect(e.defaultPrevented).toBe(false);
    expect(selectedTitle()).toBe('A');
    expect(sw.state.done).toBe(false);
  });

  it('steps through the cards while Alt is held from Alt+Q / Alt+W', async () => {
    const sw = await boot({ tabs: ABC, ctx: { dir: 0 } });
    sw.state.holding = true;
    expect(key('Tab', { altKey: true }).defaultPrevented).toBe(true);
    expect(selectedTitle()).toBe('B');
    expect(key('Tab', { altKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(selectedTitle()).toBe('A');
  });

  it('wraps around at the ends instead of leaving the page (which would close the switcher)', async () => {
    const sw = await boot({ tabs: ABC });
    const list = sw.tabbables(tid('app'));
    expect(list[0]).toBe(tid('settings-btn'));
    expect(list).toContain(tid('search'));
    list[0].focus();
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(focused()).toBe(list[list.length - 1]);
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(list[0]);
  });

  it('reaches the header, the toolbar, the windows and their merge buttons, the toast\'s Undo and the alert\'s button', async () => {
    const sw = await boot({
      tabs: ABC, prefs: { allWindows: true },
      beforeImport: () => { chrome._addTab({ windowId: 2, title: 'D', url: 'https://d.example/', active: true }); },
    });
    sw.toast('Closed', null, { label: 'Undo', fn: () => {} });
    sw.showAlert('Problem', 'Fix', () => {});
    const list = sw.tabbables(tid('app'));
    for (const id of ['settings-btn', 'newtab', 'search', 'archive-btn', 'select-sort', 'star-filter', 'window-all', 'window-merge', 'toast-action', 'alert-btn']) {
      expect(list, id).toContain(tid(id));
    }
    // The merge button is a real button beside the window's (not inside it).
    const merge = tid('window-merge');
    expect(merge.tagName).toBe('BUTTON');
    expect(merge.closest('[data-testid="window-item"]')).toBe(null);
    expect(merge.parentElement).toBe(tids('window-item')[1].parentElement);
    // Buttons inside cards are not stops: the card's menu has their actions.
    expect(list.some((n) => n.closest('[data-testid="card-tab"]'))).toBe(false);
  });
});

describe('Enter and Space on a focused button', () => {
  it('press the button (the browser does), they do not open the selected card or its preview', async () => {
    const sw = await boot({ tabs: ABC });
    tid('star-filter').focus();
    const enter = key('Enter');
    expect(enter.defaultPrevented).toBe(false);
    const space = key(' ');
    expect(space.defaultPrevented).toBe(false);
    expect(tid('big-preview')).toBe(null);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(sw.state.done).toBe(false);
  });

  it('a checkbox-like or menu button too; Esc still works there', async () => {
    const sw = await boot({ tabs: ABC });
    type(sw, 'b');
    tid('newtab').focus();
    expect(key('Enter').defaultPrevented).toBe(false);
    expect(sw.state.done).toBe(false);
    key('Escape'); // clears the search, as from the box
    expect(tid('search').value).toBe('');
    expect(sw.state.done).toBe(false);
  });

  it('typing a letter on a button still goes to the search box', async () => {
    await boot({ tabs: ABC });
    tid('star-filter').focus();
    key('x');
    expect(focused()).toBe(tid('search'));
  });

  it('Enter in the search box still opens the selected card', async () => {
    const sw = await boot({ tabs: ABC });
    tid('search').focus();
    key('Enter');
    await waitFor(() => sw.state.done);
  });

  it('a redraw puts the focus back on the button that was pressed', async () => {
    const sw = await boot({ tabs: ABC });
    tid('star-filter').focus();
    sw.toggleStarFilter(); // what its click does: a redraw
    expect(focused()).toBe(tid('star-filter'));
  });
});

describe('Settings', () => {
  async function openSettings() {
    tid('settings-btn').click();
    await waitFor(() => tid('settings'));
    await tick();
    return tid('settings');
  }

  it('takes the focus (on its selected category) as it opens and keeps Tab inside', async () => {
    const sw = await boot({ tabs: ABC });
    const dlg = await openSettings();
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(focused()).toBe(tid('settings-tab-look'));
    for (const id of REST) expect(tid(id).hasAttribute('inert'), id).toBe(true);
    const list = sw.tabbables(dlg);
    expect(list[0]).toBe(tid('settings-close'));
    expect(list).toContain(tid('settings-tab-look'));
    expect(list).not.toContain(tid('settings-tab-cards')); // one tab stop for the tab list
    expect(list).not.toContain(tid('settings-pinned-first')); // nor the hidden categories' controls
    list[0].focus();
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(focused()).toBe(list[list.length - 1]);
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(list[0]);
    tid('search').focus(); // the focus somehow outside: Tab brings it back in
    key('Tab');
    expect(focused()).toBe(list[0]);
  });

  it('Esc closes it and gives the focus back to the gear', async () => {
    const sw = await boot({ tabs: ABC });
    await openSettings();
    key('Escape');
    expect(tid('settings')).toBe(null);
    expect(focused()).toBe(tid('settings-btn'));
    expect(sw.state.done).toBe(false);
  });

  it('so does the gear again, and a click on the backdrop', async () => {
    const sw = await boot({ tabs: ABC });
    await openSettings();
    await sw.openSettings(tid('settings-btn'));
    expect(tid('settings')).toBe(null);
    expect(focused()).toBe(tid('settings-btn'));
    await openSettings();
    const back = tid('settings-backdrop');
    back.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(tid('settings')).toBe(null);
    expect(focused()).toBe(tid('settings-btn'));
    expect(sw.state.done).toBe(false);
  });

  it('typing a letter there stays there, and the switcher\'s keys don\'t reach behind it', async () => {
    const sw = await boot({ tabs: ABC });
    const dlg = await openSettings();
    key('x');
    expect(dlg.contains(focused())).toBe(true);
    key('k', { code: 'KeyK', ctrlKey: true }); // the palette's key
    expect(sw.state.palette).toBeFalsy();
    key('Delete');
    expect(sw.state.tabs).toHaveLength(3);
  });

  it('its tabs are buttons of at least 24 px with a visible focus ring (styles/switcher.css)', async () => {
    await boot({ tabs: ABC });
    await openSettings();
    for (const id of ['settings-tab-look', 'settings-close']) expect(tid(id).tagName, id).toBe('BUTTON');
    const css = readFileSync(resolve(process.cwd(), 'styles/switcher.css'), 'utf8');
    expect(css).toMatch(/\.settab \{[^}]*min-height: 40px/);
    expect(css).toMatch(/\.setx, \.noteclose, \.bigx \{[^}]*width: 36px; height: 36px/);
    expect(css).toMatch(/:focus-visible \{ outline: 3px solid var\(--focus\)/);
  });
});

describe("the card's menu (Shift+F10, the menu key)", () => {
  it('lists every action of the card\'s buttons, starting with Select', async () => {
    const sw = await boot({ tabs: ABC, ctx: { dir: 0 } });
    sw.select(1);
    const e = key('F10', { shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(tid('menu')).not.toBe(null);
    expect(menuLabels()).toEqual([
      t('menuSelect'), t('star'), t('copyLink'), t('capturePreview'), t('tabReload'), t('tabDuplicate'), t('sleepThis'),
      t('tabMute'), t('tabPin'), t('snoozeThis'), t('tabArchive'), t('noteAdd'), t('groupAddTo'), t('markMenu'), t('tabClose'),
    ]);
    expect(focused()).toBe(tids('menu-item')[0]);
  });

  it('Select ticks the card (aria-checked), and the focus goes back to the search box', async () => {
    const sw = await boot({ tabs: ABC, ctx: { dir: 0 } });
    sw.select(1);
    key('ContextMenu');
    menuItem(t('menuSelect')).click();
    expect(sw.state.picked.has(tabByTitle(sw, 'B').id)).toBe(true);
    expect(cardOf('B').getAttribute('aria-checked')).toBe('true');
    expect(cardOf('A').getAttribute('aria-checked')).toBe('false');
    expect(tid('menu')).toBe(null);
    expect(focused()).toBe(tid('search'));
    key('F10', { shiftKey: true });
    expect(menuItem(t('menuUnselect'))).not.toBe(undefined);
    menuItem(t('menuUnselect')).click();
    expect(sw.state.picked.size).toBe(0);
    expect(cardOf('B').getAttribute('aria-checked')).toBe('false');
  });

  it('its items call what the buttons call: star, pin, close', async () => {
    const sw = await boot({ tabs: ABC, ctx: { dir: 0 } });
    sw.select(1);
    key('F10', { shiftKey: true });
    menuItem(t('star')).click();
    await waitFor(() => sw.isStarred('https://b.example/'));
    sw.selectKey('t' + tabByTitle(sw, 'B').id);
    key('F10', { shiftKey: true });
    expect(menuItem(t('unstar'))).not.toBe(undefined);
    menuItem(t('tabPin')).click();
    await waitFor(() => chrome.tabs.update.mock.calls.some(([id, p]) => id === tabByTitle(sw, 'B').id && p.pinned === true));
    sw.selectKey('t' + tabByTitle(sw, 'B').id);
    key('F10', { shiftKey: true });
    menuItem(t('tabClose')).click();
    await waitFor(() => chrome.tabs.remove.mock.calls.length > 0);
  });

  it('Esc closes it, back to the search box; Chrome\'s own context menu is held back', async () => {
    await boot({ tabs: ABC });
    key('ContextMenu');
    expect(tid('menu')).not.toBe(null);
    const cm = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    window.dispatchEvent(cm);
    expect(cm.defaultPrevented).toBe(true);
    key('Escape');
    expect(tid('menu')).toBe(null);
    expect(focused()).toBe(tid('search'));
  });

  it('Snooze opens its choices, and the note item the note card (× back to the search box)', async () => {
    const sw = await boot({ tabs: ABC, ctx: { dir: 0 } });
    sw.select(1);
    key('F10', { shiftKey: true });
    menuItem(t('snoozeThis')).click();
    expect(tids('menu-item').length).toBe(sw.snoozeChoices().length + 1); // and "Pick a time…"
    key('Escape');
    expect(focused()).toBe(tid('search'));
    key('F10', { shiftKey: true });
    menuItem(t('noteAdd')).click();
    expect(tid('note-popover')).not.toBe(null);
    tid('note-close').click();
    expect(focused()).toBe(tid('search'));
  });

  it('a closed card: reopen it (here, in a new window, behind), copy, star, note, bookmark, snooze, archive, remove', async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.closed = [{ id: 'l1', kind: 'tab', url: 'https://gone.example/', title: 'Gone', ts: Date.now(), count: 1, session: null, fields: [['Gone', 'https://gone.example/']] }];
    sw.refresh();
    sw.select(sw.state.entries.findIndex((e) => e.kind === 'closed'));
    key('F10', { shiftKey: true });
    expect(menuLabels()).toEqual([
      t('closedReopen'), t('closedNewWindow'), t('closedBackground'), t('copyLink'), t('star'), t('noteAdd'), t('markMenu'),
      t('closedSnooze'), t('tabArchive'), t('closedRemove'),
    ]);
  });

  it('a closed window: reopen it, copy its links, bookmark them, remove it', async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.closed = [{ id: 's9', kind: 'window', url: 'https://one.example/', title: 'Window', ts: Date.now(), count: 2, session: { window: { sessionId: '9' } }, fields: [['One', 'https://one.example/'], ['Two', 'https://two.example/']] }];
    sw.refresh();
    sw.select(sw.state.entries.findIndex((e) => e.kind === 'closed'));
    key('F10', { shiftKey: true });
    expect(menuLabels()).toEqual([t('closedReopenWindow'), t('actCopy'), t('markMenu'), t('closedRemove')]);
  });
});

describe('the search box is a combobox', () => {
  it('points at the selected card, and at the dropdown\'s row while that shows', async () => {
    const sw = await boot({ tabs: ABC, ctx: { dir: 0 } });
    const s = tid('search');
    expect(s.getAttribute('role')).toBe('combobox');
    expect(s.getAttribute('aria-autocomplete')).toBe('list');
    expect(s.getAttribute('aria-controls').split(' ')).toEqual(['open-grid', 'snoozed-grid', 'closed-grid']);
    expect(s.getAttribute('aria-expanded')).toBe('false');
    expect(s.getAttribute('aria-activedescendant')).toBe(selected().id);
    sw.select(2);
    expect(s.getAttribute('aria-activedescendant')).toBe(selected().id);
    type(sw, 'b');
    expect(tid('search-dropdown')).not.toBe(null);
    expect(s.getAttribute('aria-expanded')).toBe('true');
    expect(s.getAttribute('aria-activedescendant')).toBe('dd-0');
    key('Escape'); // clears the search: the dropdown goes
    expect(tid('search-dropdown')).toBe(null);
    expect(s.getAttribute('aria-expanded')).toBe('false');
    expect(s.getAttribute('aria-activedescendant')).toBe(selected().id); // not a stale dd-N
  });

  it('source icons are labelled images; the Google "G" is hidden', async () => {
    const sw = await boot({ tabs: ABC });
    type(sw, 'b');
    const icon = tid('dd-source-tab');
    expect(icon.getAttribute('role')).toBe('img');
    expect(icon.getAttribute('aria-label')).toBe(t('srcTab'));
    type(sw, 'zzzqqq');
    expect(tid('dd-google-icon').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('roles and states', () => {
  it('each section\'s cards are a listbox; the open tabs area is a group, not multiselectable', async () => {
    await boot({ tabs: ABC });
    const grid = tid('open-grid');
    expect(grid.getAttribute('role')).toBe('group');
    expect(grid.hasAttribute('aria-multiselectable')).toBe(false);
    const list = tid('section-grid');
    expect(list.getAttribute('role')).toBe('listbox');
    expect(list.getAttribute('aria-labelledby')).toBe('open-h');
    expect(list.getAttribute('aria-activedescendant')).toBe(selected().id);
  });

  it('section headers sit outside the lists, which are named after them', async () => {
    const sw = await boot({ tabs: [...ABC, { title: 'A again', url: 'https://a.example/' }] });
    sw.dupesView(true);
    const head = tid('section-toggle');
    expect(head.closest('[role=listbox]')).toBe(null);
    const list = tid('section-grid');
    expect(document.getElementById(list.getAttribute('aria-labelledby'))).toBe(tid('section-name'));
    expect(tid('section-grid').getAttribute('aria-activedescendant')).toBe(selected().id);
  });

  it('buttons inside a card are hidden from the keyboard and screen readers, but still click', async () => {
    const sw = await boot({ tabs: ABC });
    const c = cardOf('B');
    const btns = [...c.querySelectorAll('button')];
    expect(btns.length).toBeGreaterThan(5);
    for (const b of btns) {
      expect(b.tabIndex, b.dataset.testid).toBe(-1);
      expect(b.getAttribute('aria-hidden'), b.dataset.testid).toBe('true');
    }
    tid('card-star-button', c).click();
    await waitFor(() => sw.isStarred('https://b.example/'));
  });

  it('pressing one keeps the focus where it was; given the focus anyway, it isn\'t aria-hidden while it has it', async () => {
    await boot({ tabs: ABC });
    const x = tid('card-close', cardOf('B'));
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    x.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true); // (a button press would otherwise focus it)
    x.focus(); // as a note card closing gives the focus back to its button
    expect(document.activeElement).toBe(x);
    expect(x.hasAttribute('aria-hidden')).toBe(false); // Chrome blocks aria-hidden on the focused element, and warns
    tid('search').focus();
    expect(x.getAttribute('aria-hidden')).toBe('true');
  });

  it('a ticked card says so with aria-checked; aria-selected is the cursor', async () => {
    const sw = await boot({ tabs: ABC, ctx: { dir: 0 } });
    sw.pick(sw.state.entries[2]);
    sw.select(0);
    expect(cardOf('C').getAttribute('aria-checked')).toBe('true');
    expect(cardOf('C').getAttribute('aria-selected')).toBe('false');
    expect(cardOf('A').getAttribute('aria-checked')).toBe('false');
  });

  it('every card is described by its site', async () => {
    await boot({ tabs: ABC });
    const c = cardOf('B');
    const desc = document.getElementById(c.getAttribute('aria-describedby'));
    expect(desc).toBe(tid('card-description', c));
    expect(desc.textContent).toBe('b.example');
  });

  it('a select button says whether its list is open, and the focus comes back to it', async () => {
    await boot({ tabs: ABC });
    const b = tid('select-sort');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    b.click();
    expect(b.getAttribute('aria-expanded')).toBe('true');
    tids('menu-item')[0].click();
    expect(b.getAttribute('aria-expanded')).toBe('false');
    b.click();
    key('Escape');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(focused()).toBe(b);
  });

  it('a menu gives the focus back to its button after an item is chosen', async () => {
    const sw = await boot({ tabs: ABC });
    const anchor = sw.h('button', '', 'Anchor', 'test-anchor');
    tid('tools').append(anchor);
    const fn = vi.fn();
    sw.menu(anchor, [{ label: 'One', fn }]);
    tids('menu-item')[0].click();
    await tick();
    expect(fn).toHaveBeenCalled();
    expect(focused()).toBe(anchor);
  });
});

describe('live regions', () => {
  it('the toast is read from a status region that is always there', async () => {
    const sw = await boot({ tabs: ABC });
    const live = tid('live-status');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.hidden).toBe(false);
    vi.useFakeTimers();
    try {
      sw.toast('Copied 2 links');
      expect(live.textContent).toBe('Copied 2 links');
      vi.advanceTimersByTime(3000);
      expect(tid('toast').hidden).toBe(true);
      expect(live.isConnected && !live.hidden).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('the alert is read from an alert region that is always there', async () => {
    const sw = await boot({ tabs: ABC });
    const live = tid('live-alert');
    expect(live.getAttribute('role')).toBe('alert');
    sw.showAlert('Problem', 'Fix', () => {});
    expect(live.textContent).toBe('Problem');
    expect(live.hidden).toBe(false);
  });
});

describe('dialogs, the archive and the big preview keep the focus', () => {
  it('a dialog makes the rest inert and gives the focus back to what had it', async () => {
    const sw = await boot({ tabs: ABC });
    tid('star-filter').focus();
    sw.askStep1();
    expect(inert()).toEqual(REST);
    expect(tid('modal').hasAttribute('inert')).toBe(false);
    expect(tid('toast').hasAttribute('inert')).toBe(false);
    expect(tid('dialog').contains(focused())).toBe(true);
    const list = sw.tabbables(tid('modal'));
    list[list.length - 1].focus();
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(list[0]);
    key('Escape');
    expect(inert()).toEqual([]);
    expect(focused()).toBe(tid('star-filter'));
  });

  it('the big preview: the rest inert, Tab stays on it, the focus back to the search box', async () => {
    const sw = await boot({ tabs: ABC });
    sw.openBig(sw.state.entries[1]);
    expect(inert()).toEqual(REST);
    expect(tid('big-preview').hasAttribute('inert')).toBe(false);
    expect(focused()).toBe(tid('big-preview-close'));
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(focused()).toBe(tid('big-preview-close'));
    key('Escape');
    expect(inert()).toEqual([]);
    expect(focused()).toBe(tid('search'));
  });

  it('the archive: the rest inert (not the toast), the focus back to the Archive button', async () => {
    chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    const sw = await boot({ tabs: ABC });
    tid('archive-btn').click();
    await waitFor(() => sw.archiveOpen());
    expect(inert()).toEqual(REST);
    expect(tid('toast').hasAttribute('inert')).toBe(false);
    expect(key('Tab').defaultPrevented).toBe(true);
    expect(tid('archive-overlay').contains(focused())).toBe(true);
    key('Escape');
    expect(inert()).toEqual([]);
    expect(focused()).toBe(tid('archive-btn'));
  });

  it('in the archive, Ctrl+Z runs the toast\'s Undo', async () => {
    const folder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: folder.id, title: 'Old', url: 'https://old.example/' });
    const sw = await boot({ tabs: ABC });
    tid('archive-btn').click();
    await waitFor(() => tids('card-archived').length === 1);
    key('Delete');
    await waitFor(() => tids('card-archived').length === 0 && toastButton());
    const z = key('z', { ctrlKey: true, code: 'KeyZ' });
    expect(z.defaultPrevented).toBe(true);
    await waitFor(() => tids('card-archived').length === 1);
    expect(tid('toast').hidden).toBe(true);
    expect(sw.state.done).toBe(false);
  });

  it("the note card's × gives the focus back to the note button that opened it", async () => {
    await boot({ tabs: ABC });
    const b = tid('quick-note', cardOf('B'));
    b.focus();
    b.click();
    tid('note-close').click();
    expect(focused()).toBe(b);
  });
});

describe('the note tooltip', () => {
  const withNote = { tabs: ABC, beforeImport: () => chrome.storage.local.set({ notes: { 'https://b.example/': { u: 'https://b.example/', n: 'remember', t: 1 } } }) };

  it('Esc hides it (and nothing else)', async () => {
    const sw = await boot(withNote);
    tid('quick-note', cardOf('B')).dispatchEvent(new Event('mouseenter'));
    await waitFor(() => tid('note-tooltip'));
    const e = key('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(tid('note-tooltip')).toBe(null);
    expect(sw.state.done).toBe(false);
  });

  it('stays while the pointer is on it, goes once it leaves', async () => {
    const sw = await boot(withNote);
    const b = tid('quick-note', cardOf('B'));
    b.dispatchEvent(new Event('mouseenter'));
    const tip = await waitFor(() => tid('note-tooltip'));
    b.dispatchEvent(new Event('mouseleave'));
    tip.dispatchEvent(new Event('mouseenter'));
    await tick(sw.TIP_DELAY_MS + 50);
    expect(tid('note-tooltip')).toBe(tip);
    tip.dispatchEvent(new Event('mouseleave'));
    await waitFor(() => !tid('note-tooltip'));
  });
});

describe('where menus and small cards open (switcher.js dropFrom)', () => {
  // jsdom lays nothing out: each test gives the node and the trigger their sizes.
  const sized = (w, h) => { const n = document.createElement('div'); Object.defineProperty(n, 'offsetWidth', { value: w }); Object.defineProperty(n, 'offsetHeight', { get: () => (n.style.maxHeight ? Math.min(h, parseFloat(n.style.maxHeight)) : h) }); return n; };
  const at = (n) => ({ left: parseFloat(n.style.left), top: parseFloat(n.style.top), up: n.classList.contains('up'), max: n.style.maxHeight });

  it('drops down from just under its trigger, its end edge on the trigger\'s end, or its start on the start (a select)', async () => {
    const sw = await boot({ tabs: ABC });
    const n = sized(200, 300);
    sw.dropFrom(n, { left: 400, right: 500, top: 100, bottom: 130 });
    expect(at(n)).toEqual({ left: 300, top: 134, up: false, max: '' });
    sw.dropFrom(n, { left: 400, right: 500, top: 100, bottom: 130 }, { alignLeft: true });
    expect(at(n)).toEqual({ left: 400, top: 134, up: false, max: '' });
  });

  it('with no room below and more above, it opens just above its trigger, dropping up (.up)', async () => {
    const sw = await boot({ tabs: ABC });
    const n = sized(200, 300);
    const H = window.innerHeight;
    sw.dropFrom(n, { left: 400, right: 500, top: H - 150, bottom: H - 120 });
    expect(at(n)).toEqual({ left: 300, top: H - 150 - 4 - 300, up: true, max: '' });
    sw.dropFrom(n, { left: 400, right: 500, top: 100, bottom: 130 }); // and down again from a trigger higher up
    expect(at(n).up).toBe(false);
  });

  it('kept inside the window; too tall for its side, a menu scrolls inside (fit)', async () => {
    const sw = await boot({ tabs: ABC });
    const n = sized(200, 5000);
    const H = window.innerHeight;
    sw.dropFrom(n, { left: 2, right: 40, top: 100, bottom: 130 }, { fit: true });
    expect(at(n)).toEqual({ left: 8, top: 134, up: false, max: (H - 130 - 4 - 8) + 'px' });
    const wide = sized(300, 50);
    sw.dropFrom(wide, { left: window.innerWidth - 20, right: window.innerWidth - 10, top: 100, bottom: 130 }, { alignLeft: true });
    expect(at(wide).left).toBe(window.innerWidth - 300 - 8);
  });

  it('a card\'s menu from the keyboard drops from the card\'s ⋯ button (as a click on it would), not from under the card', async () => {
    const sw = await boot({ tabs: ABC, ctx: { dir: 0 } });
    sw.select(1);
    const more = tid('quick-more', cardOf('B'));
    more.getClientRects = () => [{ width: 30, height: 30 }];
    more.getBoundingClientRect = () => ({ left: 300, right: 330, top: 100, bottom: 130, width: 30, height: 30 });
    key('F10', { shiftKey: true });
    expect(tid('menu').anchor).toBe(more);
    expect(at(tid('menu'))).toMatchObject({ top: 134, up: false });
    key('Escape');
    more.getClientRects = () => []; // not shown (a list row): from the card's header
    key('F10', { shiftKey: true });
    expect(tid('menu').anchor).toBe(tid('card-head', cardOf('B')));
  });

  it('a right-click opens it at the pointer, rightwards', async () => {
    await boot({ tabs: ABC });
    cardOf('B').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 210, clientY: 120 }));
    expect(at(tid('menu'))).toMatchObject({ left: 210, top: 122, up: false });
  });
});
