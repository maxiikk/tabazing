// The keyboard (onKeyDown / onKeyUp, Alt+Q-style holding) and the search box with its dropdown.
import { describe, it, expect, vi } from 'vitest';
import { tick, waitFor, key } from '../helpers/switcher.js';
import { boot, ABC, openCards, titleOf, selectedTitle, byTestId, allByTestId } from '../helpers/switcher-ui.js';

const keyUp = (keyName, init = {}) => window.dispatchEvent(new KeyboardEvent('keyup', { key: keyName, bubbles: true, cancelable: true, ...init }));
const closedWith = (reason) => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tabazing:closed', reason }));
// Type into the search box like a user: the value, then the input event.
function type(switcher, text) {
  const searchBox = byTestId('search');
  searchBox.focus();
  searchBox.value = text;
  searchBox.dispatchEvent(new Event('input', { bubbles: true }));
}
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const dropdownRows = () => [...(byTestId('search-dropdown')?.children || [])].filter((row) => row.dataset.testid.startsWith('dropdown-row-'));

describe('Esc', () => {
  it('clears the search first, then leaves the duplicates view, then clears ticks, then closes', async () => {
    const switcher = await boot({ tabs: [...ABC(), { title: 'Alpha 2', url: 'https://alpha.example/' }] });
    type(switcher, 'bra');
    switcher.duplicatesView(true);
    switcher.state.picked.add(2);
    key('Escape');
    expect(byTestId('search').value).toBe('');
    expect(switcher.state.query).toBe('');
    expect(switcher.state.duplicatesView).toBe(true);
    key('Escape');
    expect(switcher.state.duplicatesView).toBe(false); // (leaving it clears the ticks too)
    switcher.state.picked.add(2);
    key('Escape');
    expect(switcher.state.picked.size).toBe(0);
    expect(switcher.state.done).toBe(false);
    const escapeEvent = key('Escape');
    expect(escapeEvent.defaultPrevented).toBe(true);
    await waitFor(() => window.close.mock.calls.length);
    closedWith('cancel');
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true }); // back to the window it came from
  });

  it('keys do nothing once closed', async () => {
    const switcher = await boot({ tabs: ABC() });
    await switcher.finish('cancel');
    key('Enter');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('Enter', () => {
  it('opens the selected tab', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.selectKey('t3');
    key('Enter');
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    closedWith('switch');
  });

  it('with search text: opens the highlighted dropdown row', async () => {
    const switcher = await boot({ tabs: ABC() });
    type(switcher, 'charlie');
    key('Enter'); // right away: what was typed is acted on first
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('Shift+Enter opens what was typed: an address as itself', async () => {
    const switcher = await boot({ tabs: ABC() });
    type(switcher, 'charlie.example');
    key('Enter', { shiftKey: true });
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://charlie.example', windowId: 1, active: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('Shift+Enter: anything else as a Google search', async () => {
    const switcher = await boot({ tabs: ABC() });
    type(switcher, 'how to tab');
    key('Enter', { shiftKey: true });
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://www.google.com/search?q=how%20to%20tab', windowId: 1, active: true });
  });

  it('opening a tab that Chrome refuses closes quietly ("cancel")', async () => {
    const switcher = await boot({ tabs: ABC() });
    chrome.tabs.update.mockRejectedValueOnce(new Error('gone'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    switcher.selectKey('t2');
    key('Enter');
    await waitFor(() => switcher.state.done);
    closedWith('cancel');
  });
});

describe('Space: the big preview', () => {
  it('opens for the selected card; Space again closes it', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.selectKey('t2');
    key(' ');
    expect(byTestId('big-preview-title').textContent).toBe('Bravo');
    key(' ');
    expect(byTestId('big-preview')).toBe(null);
    expect(document.activeElement).toBe(byTestId('search'));
  });

  it('while open it has the keyboard: arrows flip through cards, Esc closes it (not the switcher), Enter opens', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.selectKey('t2');
    key(' ');
    key('ArrowRight');
    expect(byTestId('big-preview-title').textContent).toBe('Charlie');
    expect(selectedTitle()).toBe('Charlie');
    key('ArrowLeft');
    key('ArrowLeft');
    expect(byTestId('big-preview-title').textContent).toBe('Alpha');
    const other = key('x');
    expect(other.defaultPrevented).toBe(true); // no typing behind it
    expect(byTestId('search').value).toBe('');
    key('Escape');
    expect(byTestId('big-preview')).toBe(null);
    expect(switcher.state.done).toBe(false);
    key(' ');
    key('Enter');
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { active: true });
  });

  it('not while typing: Space is a space in the search', async () => {
    const switcher = await boot({ tabs: ABC() });
    type(switcher, 'a');
    const spaceEvent = key(' ');
    expect(spaceEvent.defaultPrevented).toBe(false);
    expect(byTestId('big-preview')).toBe(null);
  });

  it('the × or a click around it closes it', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.openBig(switcher.state.entries[1]);
    byTestId('big-preview-close').click();
    expect(byTestId('big-preview')).toBe(null);
    switcher.openBig(switcher.state.entries[1]);
    byTestId('big-preview-box').click();
    expect(byTestId('big-preview')).not.toBe(null); // inside: stays
    byTestId('big-preview').click();
    expect(byTestId('big-preview')).toBe(null);
    expect(switcher.state.done).toBe(false);
  });
});

describe('moving the selection', () => {
  it('Tab / Shift+Tab cycle through the open tabs while Alt is held from Alt+Q (like Alt+Tab)', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    switcher.state.holding = true;
    expect(key('Tab', { altKey: true }).defaultPrevented).toBe(true);
    expect(selectedTitle()).toBe('Bravo');
    key('Tab', { shiftKey: true, altKey: true });
    key('Tab', { shiftKey: true, altKey: true });
    expect(selectedTitle()).toBe('Charlie');
  });

  it("without Alt held, Tab is the page's own: it moves the focus, not the selection", async () => {
    await boot({ tabs: ABC(), context: { direction: 0 } });
    expect(key('Tab').defaultPrevented).toBe(false); // from the search box, in the middle of the controls
    expect(selectedTitle()).toBe('Alpha');
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(selectedTitle()).toBe('Alpha');
  });

  it('arrows move between cards; left/right are the caret\'s while typing', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    key('ArrowRight');
    expect(selectedTitle()).toBe('Bravo');
    key('ArrowLeft');
    expect(selectedTitle()).toBe('Alpha');
    type(switcher, 'zzzz');
    await nextFrame();
    const arrowRightEvent = key('ArrowRight');
    expect(arrowRightEvent.defaultPrevented).toBe(false);
    expect(selectedTitle()).toBe('Alpha');
  });

  it('Ctrl+arrows switch the window shown', async () => {
    const switcher = await boot({
      tabs: ABC(), preferences: { allWindows: true },
      beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/' }); },
    });
    key('ArrowRight', { ctrlKey: true });
    expect(switcher.state.scope).toBe(1);
    key('ArrowLeft', { ctrlKey: true });
    key('ArrowLeft', { ctrlKey: true });
    expect(switcher.state.scope).toBe(2);
    expect(openCards().map(titleOf)).toEqual(['Delta']);
  });
});

describe('1-9', () => {
  // Plain digits switch only with the focus off the (empty) search box; Alt+digit always.
  const focusOff = () => { byTestId('scroller').tabIndex = -1; byTestId('scroller').focus(); };

  it('focus elsewhere, box empty: a digit opens the card with that number', async () => {
    const switcher = await boot({ tabs: ABC() });
    focusOff();
    const digitEvent = key('2', { code: 'Digit2' });
    expect(digitEvent.defaultPrevented).toBe(true);
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
  });

  it('search box focused and empty: a digit is search text, not a switch', async () => {
    const switcher = await boot({ tabs: ABC() });
    expect(document.activeElement).toBe(byTestId('search'));
    expect(byTestId('search').value).toBe('');
    const digitEvent = key('3', { code: 'Digit3' });
    expect(digitEvent.defaultPrevented).toBe(false); // the box types it
    await tick(10);
    expect(switcher.state.done).toBe(false);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('Alt+digit always switches, even from the search box with text in it', async () => {
    const switcher = await boot({ tabs: ABC() });
    type(switcher, 'x');
    key('3', { code: 'Digit3', altKey: true });
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('focus elsewhere but text in the box: a digit does not switch', async () => {
    const switcher = await boot({ tabs: ABC() });
    type(switcher, 'x');
    focusOff();
    key('2', { code: 'Digit2' });
    await tick(10);
    expect(switcher.state.done).toBe(false);
  });

  it('a number past the open cards does nothing; repeats are ignored', async () => {
    const switcher = await boot({ tabs: ABC() });
    focusOff();
    key('7', { code: 'Digit7' });
    key('1', { code: 'Digit1', repeat: true });
    key('1', { code: 'Digit1', altKey: true, repeat: true });
    await tick(10);
    expect(switcher.state.done).toBe(false);
  });
});

describe('Del, Ctrl+Z, Ctrl+F', () => {
  it('Del closes the selected tab and selects its neighbour; Ctrl+Z reopens it where it was', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.selectKey('t2');
    key('Delete');
    await waitFor(() => !openCards().some((cardElement) => titleOf(cardElement) === 'Bravo'));
    expect(chrome.tabs.remove).toHaveBeenCalledWith(2);
    expect(selectedTitle()).toBe('Charlie');
    expect(byTestId('toast-action')).not.toBe(null); // "Undo"
    key('z', { code: 'KeyZ', ctrlKey: true });
    await waitFor(() => chrome.tabs.create.mock.calls.length);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://bravo.example/', windowId: 1, index: 1, pinned: false, active: false });
    expect(switcher.state.done).toBe(false);
  });

  it('Del: one tab per press, not one per repeat; not while typing', async () => {
    const switcher = await boot({ tabs: ABC() });
    key('Delete', { repeat: true });
    type(switcher, 'a');
    key('Delete');
    await tick(10);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('Ctrl+Z with nothing to undo says so; in a search box with text it is the box\'s own undo', async () => {
    const switcher = await boot({ tabs: ABC() });
    key('z', { code: 'KeyZ', ctrlKey: true });
    await waitFor(() => !byTestId('toast').hidden);
    expect(byTestId('toast').textContent).not.toBe('');
    type(switcher, 'abc');
    const undoKeyEvent = key('z', { code: 'KeyZ', ctrlKey: true });
    expect(undoKeyEvent.defaultPrevented).toBe(false);
  });

  it('Ctrl+F focuses and selects the search box', async () => {
    await boot({ tabs: ABC() });
    byTestId('scroller').tabIndex = -1;
    byTestId('scroller').focus();
    const selectSpy = vi.spyOn(byTestId('search'), 'select');
    key('f', { code: 'KeyF', ctrlKey: true });
    expect(document.activeElement).toBe(byTestId('search'));
    expect(selectSpy).toHaveBeenCalled();
  });
});

describe('Alt shortcuts', () => {
  it('Alt+S stars the selected tab', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.selectKey('t3');
    key('s', { code: 'KeyS', altKey: true });
    await waitFor(() => switcher.state.stars['https://charlie.example/']);
    expect((await chrome.storage.local.get('stars')).stars['https://charlie.example/'].ti).toBe('Charlie');
  });

  it('Alt+P captures the selected tab\'s preview (and says so when it fails)', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.selectKey('t2');
    key('p', { code: 'KeyP', altKey: true });
    await waitFor(() => chrome.runtime.sendMessage.mock.calls.some(([message]) => message.type === 'tabazing:capture-one'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'tabazing:capture-one', tabId: 2 });
    await waitFor(() => !byTestId('toast').hidden);
    expect(switcher.state.capturing).toBe(null);
    expect(switcher.state.done).toBe(false);
  });

  it('Alt+Q / Alt+W step back / forward and hold; letting go of Alt switches', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    key('w', { code: 'KeyW', altKey: true });
    expect(selectedTitle()).toBe('Bravo');
    expect(switcher.state.holding).toBe(true);
    key('w', { code: 'KeyW', altKey: true });
    key('q', { code: 'KeyQ', altKey: true });
    expect(selectedTitle()).toBe('Bravo');
    key('q', { code: 'KeyQ', altKey: true, shiftKey: true }); // Shift reverses Q
    expect(selectedTitle()).toBe('Charlie');
    keyUp('Alt');
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('Alt+E stops holding: letting go of Alt then does nothing', async () => {
    const switcher = await boot({ tabs: ABC(), context: { hold: true, direction: 1 } });
    key('e', { code: 'KeyE', altKey: true });
    expect(switcher.state.holding).toBe(false);
    keyUp('Alt');
    await tick(80);
    expect(switcher.state.done).toBe(false);
    expect(document.documentElement.classList.contains('alttab')).toBe(false); // the search box is back
    expect(document.activeElement).toBe(byTestId('search'));
  });

  it('any key without a modifier means Alt was already let go', async () => {
    const switcher = await boot({ tabs: ABC(), context: { hold: true, direction: 1 } });
    key('ArrowRight');
    expect(switcher.state.holding).toBe(false);
    expect(selectedTitle()).toBe('Charlie');
    keyUp('Alt');
    await tick(10);
    expect(switcher.state.done).toBe(false);
  });

  it('altReleased with search text just stops holding', async () => {
    const switcher = await boot({ tabs: ABC() });
    byTestId('search').value = 'x';
    switcher.cyclePress(1);
    switcher.altReleased();
    expect(switcher.state.holding).toBe(false);
    expect(switcher.state.done).toBe(false);
  });

  it('a stray Alt+letter (a symbol on a Mac) is not typed', async () => {
    await boot({ tabs: ABC() });
    const strayKeyEvent = key('å', { code: 'KeyA', altKey: true });
    expect(strayKeyEvent.defaultPrevented).toBe(true);
  });

  it('while Alt is down the search box refuses text (beforeinput), and reverts any that slips in', async () => {
    const switcher = await boot({ tabs: ABC() });
    key('Alt', { code: 'AltLeft', altKey: true });
    const beforeInputEvent = new InputEvent('beforeinput', { cancelable: true, data: '∑' });
    byTestId('search').dispatchEvent(beforeInputEvent);
    expect(beforeInputEvent.defaultPrevented).toBe(true);
    type(switcher, '∑');
    expect(byTestId('search').value).toBe('');
    expect(switcher.state.query).toBe('');
    keyUp('Alt');
    type(switcher, 'b');
    expect(switcher.state.query).toBe('b');
  });

  it('the background\'s CYCLE message moves the selection (dir 0 = stay open)', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    const send = (message, sender = { id: chrome.runtime.id }) => { const respond = vi.fn(); chrome.runtime.onMessage._emit(message, sender, respond); return respond; };
    expect(send({ type: 'tabazing:cycle', direction: 1, hold: true })).toHaveBeenCalledWith({ ok: true });
    expect(selectedTitle()).toBe('Bravo');
    expect(switcher.state.holding).toBe(true);
    send({ type: 'tabazing:cycle', direction: 0 });
    expect(switcher.state.holding).toBe(false);
    send({ type: 'tabazing:cycle', direction: 1 }, { id: chrome.runtime.id, tab: { id: 9 } }); // a content script: ignored
    expect(selectedTitle()).toBe('Bravo');
  });
});

describe('typing anywhere', () => {
  it('a letter typed with the focus elsewhere goes to the search box', async () => {
    await boot({ tabs: ABC() });
    byTestId('scroller').tabIndex = -1;
    byTestId('scroller').focus();
    key('k');
    expect(document.activeElement).toBe(byTestId('search'));
  });

  it('keys in another field are that field\'s; Esc there closes the card and gives the focus back to the gear', async () => {
    const switcher = await boot({ tabs: ABC() });
    byTestId('settings-button').click();
    await waitFor(() => byTestId('settings'));
    const lang = byTestId('settings-language');
    key('Enter', { target: lang });
    expect(switcher.state.done).toBe(false);
    key('Escape', { target: lang });
    expect(byTestId('settings')).toBe(null);
    expect(document.activeElement).toBe(byTestId('menu-button')); // what opened it
    expect(switcher.state.done).toBe(false);
  });
});

describe('keys while a dialog or the archive is open', () => {
  it('a dialog takes the keyboard: Esc closes it, not the switcher', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.askStep1();
    expect(byTestId('modal').hidden).toBe(false);
    key('Enter');
    key('2', { code: 'Digit2' });
    expect(switcher.state.done).toBe(false);
    key('Escape');
    expect(byTestId('modal').hidden).toBe(true);
    expect(switcher.state.modal).toBe(null);
    expect(switcher.state.done).toBe(false);
  });

  it('the tour: arrows step through it', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.tourStep(0);
    expect(byTestId('tour-step-of').textContent).toMatch(/^1 \//);
    key('ArrowRight');
    expect(byTestId('tour-step-of').textContent).toMatch(/^2 \//);
    key('ArrowLeft');
    expect(byTestId('tour-step-of').textContent).toMatch(/^1 \//);
    key('Escape');
    expect(switcher.state.modal).toBe(null);
  });

  it('the archive overlay: Esc closes it only; Enter opens the archived page', async () => {
    const folder = chrome._addBookmark({ title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: folder.id, title: 'Old', url: 'https://old.example/' });
    const switcher = await boot({ tabs: ABC() });
    byTestId('archive-button').click();
    await waitFor(() => byTestId('archive-overlay') && byTestId('card-archived'));
    key('Escape');
    expect(byTestId('archive-overlay')).toBe(null);
    expect(switcher.state.done).toBe(false);
    byTestId('archive-button').click();
    await waitFor(() => byTestId('card-archived'));
    key('Enter');
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://old.example/', windowId: 1, active: true });
  });
});

describe('the search box and its dropdown', () => {
  it('typing is drawn once per frame: dropdown, count and actions bar', async () => {
    const switcher = await boot({ tabs: [...ABC(), { title: 'Bravo two', url: 'https://bravo2.example/' }] });
    type(switcher, 'b');
    type(switcher, 'br');
    type(switcher, 'bravo');
    expect(switcher.state.query).toBe('bravo');
    expect(byTestId('search-dropdown')).toBe(null); // not yet
    expect(switcher.searchFrame).not.toBe(0);
    await nextFrame();
    expect(switcher.searchFrame).toBe(0);
    expect(dropdownRows().map((row) => row.dataset.testid)).toEqual(['dropdown-row-tab', 'dropdown-row-tab']);
    expect(allByTestId('dropdown-title').map((x) => x.textContent)).toEqual(['Bravo', 'Bravo two']);
    expect(byTestId('count').textContent).toMatch(/2/);
    expect(byTestId('actions').hidden).toBe(false); // "Select all 2"
    expect(allByTestId('search-highlight')[0].textContent).toBe('Bravo');
    expect(openCards().length).toBe(4); // the cards don't follow the search
  });

  it('nothing found: "Open <address>" and a Google search', async () => {
    const switcher = await boot({ tabs: ABC() });
    type(switcher, 'zzz.example');
    await nextFrame();
    expect(dropdownRows().map((row) => row.dataset.testid)).toEqual(['dropdown-row-url', 'dropdown-row-google']);
    type(switcher, 'qqqq xxxx');
    await nextFrame();
    expect(dropdownRows().map((row) => row.dataset.testid)).toEqual(['dropdown-row-google']);
  });

  it('↑/↓ move the highlight (wrapping) without rebuilding the rows', async () => {
    const switcher = await boot({ tabs: [...ABC(), { title: 'Bravo two', url: 'https://bravo2.example/' }] });
    type(switcher, 'bravo');
    await nextFrame();
    const [firstRow, secondRow] = dropdownRows();
    expect(firstRow.getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    expect(switcher.state.dropdown.highlighted).toBe(1);
    expect(dropdownRows()[1]).toBe(secondRow);
    expect(secondRow.getAttribute('aria-selected')).toBe('true');
    expect(firstRow.getAttribute('aria-selected')).toBe('false');
    expect(byTestId('search').getAttribute('aria-activedescendant')).toBe('dropdown-1');
    key('ArrowDown');
    expect(switcher.state.dropdown.highlighted).toBe(0);
    key('ArrowUp');
    expect(switcher.state.dropdown.highlighted).toBe(1);
    key('Enter');
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(4, { active: true });
  });

  it('hovering a row does not move the highlight (only ↑ / ↓ do, as with the cards); a click opens the row clicked', async () => {
    const switcher = await boot({ tabs: [...ABC(), { title: 'Bravo two', url: 'https://bravo2.example/' }] });
    type(switcher, 'bravo');
    await nextFrame();
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) dropdownRows()[1].dispatchEvent(new MouseEvent(type, { bubbles: true }));
    expect(switcher.state.dropdown.highlighted).toBe(0);
    expect(dropdownRows()[0].classList.contains('on')).toBe(true);
    expect(dropdownRows()[1].classList.contains('on')).toBe(false);
    dropdownRows()[1].click();
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(4, { active: true });
  });

  it('a press elsewhere hides the dropdown; typing brings it back', async () => {
    const switcher = await boot({ tabs: ABC() });
    type(switcher, 'bravo');
    await nextFrame();
    byTestId('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(byTestId('search-dropdown')).toBe(null);
    expect(switcher.dropdownShown()).toBe(false);
    type(switcher, 'bravo ');
    await nextFrame();
    expect(byTestId('search-dropdown')).not.toBe(null);
  });

  it('ddPic: one picture node per page, reused as the list is redrawn', async () => {
    const switcher = await boot({ tabs: ABC() });
    type(switcher, 'bra');
    await nextFrame();
    const picture = byTestId('dropdown-picture', dropdownRows()[0]);
    type(switcher, 'brav');
    await nextFrame();
    expect(byTestId('dropdown-picture', dropdownRows()[0])).toBe(picture);
    expect(switcher.dropdownPicture('x', 'https://x.example/', null, 'dropdown-icon')).toBe(switcher.dropdownPicture('x', 'https://x.example/', null, 'dropdown-icon'));
    expect(switcher.dropdownPicture('x', 'https://x.example/', { img: 'data:image/jpeg;base64,AAAA', t: 1 })).not.toBe(switcher.dropdownPicture('x', 'https://x.example/', null));
  });

  it('the highlight stays on its row when late results (Chrome\'s history search) reorder the list; new text resets it', async () => {
    // 200 days old: past the 90 days read up front, so only Chrome's search (after a pause) finds it, as the best match.
    chrome._data.history.push({ url: 'https://old.example/', title: 'Alpha old page', lastVisitTime: Date.now() - 200 * 864e5, visitCount: 3 });
    const switcher = await boot({ tabs: [{ title: 'Xalphax', url: 'https://x.example/' }, { title: 'Yalphay', url: 'https://y.example/' }] });
    const highlightedRow = () => document.querySelector('[data-testid^="dropdown-row-"][aria-selected="true"]');
    const highlightedTitle = () => byTestId('dropdown-title', highlightedRow()).textContent;
    type(switcher, 'alpha');
    await nextFrame();
    expect(allByTestId('dropdown-title').map((x) => x.textContent)).toEqual(['Xalphax', 'Yalphay']);
    key('ArrowDown');
    expect(highlightedTitle()).toBe('Yalphay');
    await tick(300);
    expect(allByTestId('dropdown-title').map((x) => x.textContent)[0]).toBe('Alpha old page'); // came in late, first
    expect(highlightedTitle()).toBe('Yalphay');
    expect(switcher.state.dropdown.items[switcher.state.dropdown.highlighted].entry.tab.title).toBe('Yalphay');
    type(switcher, 'alph');
    await nextFrame();
    expect(switcher.state.dropdown.highlighted).toBe(0);
    expect(highlightedRow()).toBe(dropdownRows()[0]);
  });

  it('bookmarks and history are read on the first search, once, and listed', async () => {
    chrome._addBookmark({ parentId: '1', title: 'Zebra docs', url: 'https://zebra.example/' });
    chrome._data.history = [{ url: 'https://yak.example/', title: 'Yak farm', lastVisitTime: Date.now() - 1000, visitCount: 3 }];
    const switcher = await boot({ tabs: ABC() });
    expect(switcher.state.marks).toBe(null);
    expect(switcher.state.history).toBe(null);
    type(switcher, 'zebra');
    await waitFor(() => byTestId('dropdown-row-mark'));
    const trees = chrome.bookmarks.getTree.mock.calls.length;
    expect(byTestId('dropdown-title', byTestId('dropdown-row-mark')).textContent).toBe('Zebra docs');
    type(switcher, 'yak');
    await waitFor(() => byTestId('dropdown-row-visit'));
    expect(chrome.bookmarks.getTree).toHaveBeenCalledTimes(trees);
    expect(chrome.history.search).toHaveBeenCalledWith(expect.objectContaining({ text: '', maxResults: 5000 }));
  });
});

describe('ddActivate: each kind of row', () => {
  it('tab: its card when shown, else switches to the tab directly', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.setFilter('pinned'); // no cards
    switcher.state.query = 'bravo';
    switcher.deriveSearch();
    await switcher.dropdownActivate({ kind: 'tab', entry: switcher.state.found[0] });
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(switcher.state.done).toBe(true);
  });

  it('closed: restores Chrome\'s session', async () => {
    const switcher = await boot({ tabs: ABC() });
    await switcher.dropdownActivate({ kind: 'closed', closed: { url: 'https://gone.example/', session: { tab: { sessionId: 's9' } } } });
    expect(chrome.sessions.restore).toHaveBeenCalledWith('s9');
    closedWith('restore');
  });

  it('closed from our own log: reopens the page', async () => {
    const switcher = await boot({ tabs: ABC() });
    await switcher.dropdownActivate({ kind: 'closed', closed: { url: 'https://gone.example/', session: null } });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://gone.example/', windowId: 1, active: true });
  });

  it('archived: out of the archive, into a new tab', async () => {
    const folder = chrome._addBookmark({ title: 'Tabs Archive' });
    const oldBookmark = chrome._addBookmark({ parentId: folder.id, title: 'Old', url: 'https://old.example/' });
    const switcher = await boot({ tabs: ABC() });
    await switcher.dropdownActivate({ kind: 'archived', archived: { id: oldBookmark.id, url: oldBookmark.url } });
    expect(chrome._findBookmark(oldBookmark.id)).toBe(null);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://old.example/', windowId: 1, active: true });
  });

  it('bookmark / history: switches to the tab that has it open, else opens it', async () => {
    const switcher = await boot({ tabs: ABC() });
    await switcher.dropdownActivate({ kind: 'mark', bookmark: { url: 'https://bravo.example/#top' } });
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('history page not open: a new tab', async () => {
    const switcher = await boot({ tabs: ABC() });
    await switcher.dropdownActivate({ kind: 'visit', visit: { url: 'https://yak.example/' } });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://yak.example/', windowId: 1, active: true });
  });

  it('url / google: what was typed', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.state.query = 'localhost:3000';
    await switcher.dropdownActivate({ kind: 'url', url: 'http://localhost:3000' });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'http://localhost:3000', windowId: 1, active: true });
  });

  it('nothing after closing', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.state.done = true;
    await switcher.dropdownActivate({ kind: 'google' });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe('searching dims the cards that do not match', () => {
  it('while there is text, the others step back (they keep their places), and come back when it is cleared', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    type(switcher, 'brav');
    await nextFrame();
    const dimmedTitles = () => openCards().filter((cardElement) => cardElement.classList.contains('no-match')).map(titleOf);
    expect(dimmedTitles()).toEqual(['Alpha', 'Charlie']);
    expect(openCards().map(titleOf)).toEqual(['Alpha', 'Bravo', 'Charlie']); // same cards, same order
    expect(switcher.state.hits.has('t2')).toBe(true);
    switcher.refresh(); // a redraw keeps it
    expect(dimmedTitles()).toEqual(['Alpha', 'Charlie']);
    key('Escape');
    expect(dimmedTitles()).toEqual([]);
    expect(switcher.state.hits).toBe(null);
  });
});

describe('Enter with search text', () => {
  it('uses the dropdown only while it shows: with it hidden, Enter opens the selected card', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    type(switcher, 'charlie');
    await nextFrame();
    byTestId('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); // hides the dropdown
    expect(switcher.dropdownShown()).toBe(false);
    expect(switcher.state.dropdown.items.length).toBeGreaterThan(0); // (its rows are still known)
    byTestId('search').focus();
    key('Enter');
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { active: true }); // Alpha, the selected card, not Charlie's row
  });
});

describe('Settings -> Search', () => {
  it('the placeholder says what is searched', async () => {
    let switcher = await boot({ tabs: ABC() });
    expect(byTestId('search').placeholder).toBe('Search tabs, history, bookmarks and the archive');
    switcher = await boot({ tabs: ABC(), preferences: { searchHistory: false } });
    expect(byTestId('search').placeholder).toBe('Search tabs, bookmarks and the archive');
    switcher = await boot({ tabs: ABC(), preferences: { searchBookmarks: false } });
    expect(byTestId('search').placeholder).toBe('Search tabs, history and the archive');
    switcher = await boot({ tabs: ABC(), preferences: { searchBookmarks: false, searchHistory: false } });
    expect(byTestId('search').placeholder).toBe('Search tabs and the archive');
  });

  it('history and bookmarks left out are neither read nor listed', async () => {
    chrome._addBookmark({ title: 'Zebra docs', url: 'https://zebra.example/' });
    chrome._data.history = [{ url: 'https://zebra-history.example/', title: 'Zebra history', lastVisitTime: Date.now(), visitCount: 1 }];
    const switcher = await boot({ tabs: ABC(), preferences: { searchBookmarks: false, searchHistory: false } });
    type(switcher, 'zebra');
    await nextFrame();
    await tick(200);
    expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
    expect(chrome.history.search).not.toHaveBeenCalled();
    expect(dropdownRows().map((row) => row.dataset.testid)).toEqual(['dropdown-row-google']);
  });
});

describe('ticking from the keyboard', () => {
  const picked = (switcher) => switcher.state.tabs.filter((x) => switcher.state.picked.has(x.id)).map((x) => x.title);
  const many = () => [...ABC(), { title: 'Delta', url: 'https://delta.example/' }, { title: 'Echo', url: 'https://echo.example/' }];

  it('Shift+→ / Shift+← tick a range from the selected card; stepping back shrinks it', async () => {
    const switcher = await boot({ tabs: many(), context: { direction: 0 } });
    switcher.select(1); // Bravo
    byTestId('scroller').focus();
    key('ArrowRight', { shiftKey: true });
    expect(selectedTitle()).toBe('Charlie');
    expect(picked(switcher)).toEqual(['Bravo', 'Charlie']);
    key('ArrowRight', { shiftKey: true });
    expect(picked(switcher)).toEqual(['Bravo', 'Charlie', 'Delta']);
    key('ArrowLeft', { shiftKey: true });
    expect(picked(switcher)).toEqual(['Bravo', 'Charlie']);
    key('ArrowLeft', { shiftKey: true });
    key('ArrowLeft', { shiftKey: true }); // past the start: the other way
    expect(picked(switcher)).toEqual(['Alpha', 'Bravo']);
  });

  it('Shift+→ at the last card stops there: no wrapping round to the first', async () => {
    const switcher = await boot({ tabs: many(), context: { direction: 0 }, preferences: { showClosed: false } });
    switcher.select(3); // Delta
    byTestId('scroller').focus();
    key('ArrowRight', { shiftKey: true });
    expect(picked(switcher)).toEqual(['Delta', 'Echo']);
    key('ArrowRight', { shiftKey: true }); // at the last card
    expect(picked(switcher)).toEqual(['Delta', 'Echo']);
    expect(selectedTitle()).toBe('Echo');
  });

  it('Shift+← at the first card stops there too', async () => {
    const switcher = await boot({ tabs: many(), context: { direction: 0 }, preferences: { showClosed: false } });
    switcher.select(1); // Bravo
    byTestId('scroller').focus();
    key('ArrowLeft', { shiftKey: true });
    key('ArrowLeft', { shiftKey: true });
    expect(picked(switcher)).toEqual(['Alpha', 'Bravo']);
    expect(selectedTitle()).toBe('Alpha');
  });

  it('a run keeps the ticks made before it; any other key ends it', async () => {
    const switcher = await boot({ tabs: many(), context: { direction: 0 } });
    switcher.pick(switcher.state.entries[4]); // Echo
    switcher.select(0);
    byTestId('scroller').focus();
    key('ArrowRight', { shiftKey: true });
    expect(picked(switcher)).toEqual(['Alpha', 'Bravo', 'Echo']);
    key('ArrowRight'); // ends the run
    expect(switcher.state.shiftBase).toBe(null);
  });

  it('Ctrl+Space ticks and unticks the selected card; Space alone is still its big preview', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    switcher.select(1);
    const ctrlSpaceEvent = key(' ', { ctrlKey: true });
    expect(ctrlSpaceEvent.defaultPrevented).toBe(true);
    expect(picked(switcher)).toEqual(['Bravo']);
    expect(byTestId('big-preview')).toBe(null);
    key(' ', { metaKey: true });
    expect(picked(switcher)).toEqual([]);
    key(' ');
    expect(byTestId('big-preview')).not.toBe(null);
  });

  it('Shift+arrows in the search box with text stay the box’s own (text selection)', async () => {
    const switcher = await boot({ tabs: ABC() });
    type(switcher, 'al');
    const shiftArrowLeftEvent = key('ArrowLeft', { shiftKey: true });
    expect(shiftArrowLeftEvent.defaultPrevented).toBe(false);
    expect(switcher.state.picked.size).toBe(0);
  });
});

describe('moving far, sorting and undoing: where the selection goes', () => {
  const named = (...names) => names.map((title) => ({ title, url: `https://${title.toLowerCase()}.example/` }));

  it('Home and End (search box empty) select the first and the last card', async () => {
    await boot({ tabs: named('Alpha', 'Bravo', 'Charlie', 'Delta'), context: { direction: 0 } });
    byTestId('search').focus();
    expect(key('End').defaultPrevented).toBe(true);
    expect(selectedTitle()).toBe('Delta');
    key('Home');
    expect(selectedTitle()).toBe('Alpha');
  });

  it('PgDn and PgUp move the selection (as far as there are cards that way)', async () => {
    await boot({ tabs: named('Alpha', 'Bravo', 'Charlie'), context: { direction: 0 } });
    byTestId('search').focus();
    expect(key('PageDown').defaultPrevented).toBe(true);
    expect(key('PageUp').defaultPrevented).toBe(true);
    expect(selectedTitle()).toBe('Alpha');
  });

  it('changing the sort keeps the selected card in view (its scroll into view comes last)', async () => {
    const switcher = await boot({ tabs: named('Zulu', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'), context: { direction: 0 } });
    const scrolls = [];
    Object.defineProperty(byTestId('scroller'), 'scrollTop', { configurable: true, get: () => 0, set: (value) => scrolls.push('top ' + value) });
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function () { scrolls.push('into view ' + byTestId('card-title', this)?.textContent); });
    switcher.setSort('name');
    scrollIntoView.mockRestore();
    expect(selectedTitle()).toBe('Zulu');
    expect(scrolls.at(-1)).toBe('into view Zulu');
  });

  it('Ctrl+Z after Del selects the tab it brought back', async () => {
    const switcher = await boot({ tabs: named('Alpha', 'Bravo', 'Charlie', 'Delta') });
    switcher.selectKey('t2');
    key('Delete');
    await waitFor(() => !openCards().some((card) => titleOf(card) === 'Bravo'));
    expect(selectedTitle()).toBe('Charlie');
    key('z', { code: 'KeyZ', ctrlKey: true });
    await waitFor(() => openCards().length === 4);
    await tick(20);
    const reopened = chrome._data.tabs.find((x) => x.url === 'https://bravo.example/');
    expect(switcher.state.entries[switcher.state.selected].tab.id).toBe(reopened.id);
  });
});
