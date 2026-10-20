// The keyboard (onKeyDown / onKeyUp, Alt+Q-style holding) and the search box with its dropdown.
import { describe, it, expect, vi } from 'vitest';
import { tick, waitFor, key } from '../helpers/switcher.js';
import { boot, ABC, openCards, titleOf, selectedTitle, tid, tids } from './_ui.js';

const keyUp = (k, init = {}) => window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true, ...init }));
const closedWith = (reason) => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tabazing:closed', reason }));
// Type into the search box like a user: the value, then the input event.
function type(sw, text) {
  const s = tid('search');
  s.focus();
  s.value = text;
  s.dispatchEvent(new Event('input', { bubbles: true }));
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const ddRows = () => [...(tid('search-dropdown')?.children || [])].filter((r) => r.dataset.testid.startsWith('dd-row-'));

describe('Esc', () => {
  it('clears the search first, then leaves the duplicates view, then clears ticks, then closes', async () => {
    const sw = await boot({ tabs: [...ABC(), { title: 'Alpha 2', url: 'https://alpha.example/' }] });
    type(sw, 'bra');
    sw.dupesView(true);
    sw.state.picked.add(2);
    key('Escape');
    expect(tid('search').value).toBe('');
    expect(sw.state.query).toBe('');
    expect(sw.state.dupesView).toBe(true);
    key('Escape');
    expect(sw.state.dupesView).toBe(false); // (leaving it clears the ticks too)
    sw.state.picked.add(2);
    key('Escape');
    expect(sw.state.picked.size).toBe(0);
    expect(sw.state.done).toBe(false);
    const e = key('Escape');
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => window.close.mock.calls.length);
    closedWith('cancel');
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true }); // back to the window it came from
  });

  it('keys do nothing once closed', async () => {
    const sw = await boot({ tabs: ABC() });
    await sw.finish('cancel');
    key('Enter');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('Enter', () => {
  it('opens the selected tab', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.selectKey('t3');
    key('Enter');
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    closedWith('switch');
  });

  it('with search text: opens the highlighted dropdown row', async () => {
    const sw = await boot({ tabs: ABC() });
    type(sw, 'charlie');
    key('Enter'); // right away: what was typed is acted on first
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('Shift+Enter opens what was typed: an address as itself', async () => {
    const sw = await boot({ tabs: ABC() });
    type(sw, 'charlie.example');
    key('Enter', { shiftKey: true });
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://charlie.example', windowId: 1, active: true });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('Shift+Enter: anything else as a Google search', async () => {
    const sw = await boot({ tabs: ABC() });
    type(sw, 'how to tab');
    key('Enter', { shiftKey: true });
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://www.google.com/search?q=how%20to%20tab', windowId: 1, active: true });
  });

  it('opening a tab that Chrome refuses closes quietly ("cancel")', async () => {
    const sw = await boot({ tabs: ABC() });
    chrome.tabs.update.mockRejectedValueOnce(new Error('gone'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sw.selectKey('t2');
    key('Enter');
    await waitFor(() => sw.state.done);
    closedWith('cancel');
  });
});

describe('Space: the big preview', () => {
  it('opens for the selected card; Space again closes it', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.selectKey('t2');
    key(' ');
    expect(tid('big-preview-title').textContent).toBe('Bravo');
    key(' ');
    expect(tid('big-preview')).toBe(null);
    expect(document.activeElement).toBe(tid('search'));
  });

  it('while open it has the keyboard: arrows flip through cards, Esc closes it (not the switcher), Enter opens', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.selectKey('t2');
    key(' ');
    key('ArrowRight');
    expect(tid('big-preview-title').textContent).toBe('Charlie');
    expect(selectedTitle()).toBe('Charlie');
    key('ArrowLeft');
    key('ArrowLeft');
    expect(tid('big-preview-title').textContent).toBe('Alpha');
    const other = key('x');
    expect(other.defaultPrevented).toBe(true); // no typing behind it
    expect(tid('search').value).toBe('');
    key('Escape');
    expect(tid('big-preview')).toBe(null);
    expect(sw.state.done).toBe(false);
    key(' ');
    key('Enter');
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { active: true });
  });

  it('not while typing: Space is a space in the search', async () => {
    const sw = await boot({ tabs: ABC() });
    type(sw, 'a');
    const e = key(' ');
    expect(e.defaultPrevented).toBe(false);
    expect(tid('big-preview')).toBe(null);
  });

  it('the × or a click around it closes it', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.openBig(sw.state.entries[1]);
    tid('big-preview-close').click();
    expect(tid('big-preview')).toBe(null);
    sw.openBig(sw.state.entries[1]);
    tid('big-preview-box').click();
    expect(tid('big-preview')).not.toBe(null); // inside: stays
    tid('big-preview').click();
    expect(tid('big-preview')).toBe(null);
    expect(sw.state.done).toBe(false);
  });
});

describe('moving the selection', () => {
  it('Tab / Shift+Tab cycle through the open tabs while Alt is held from Alt+Q (like Alt+Tab)', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    sw.state.holding = true;
    expect(key('Tab', { altKey: true }).defaultPrevented).toBe(true);
    expect(selectedTitle()).toBe('Bravo');
    key('Tab', { shiftKey: true, altKey: true });
    key('Tab', { shiftKey: true, altKey: true });
    expect(selectedTitle()).toBe('Charlie');
  });

  it("without Alt held, Tab is the page's own: it moves the focus, not the selection", async () => {
    await boot({ tabs: ABC(), ctx: { dir: 0 } });
    expect(key('Tab').defaultPrevented).toBe(false); // from the search box, in the middle of the controls
    expect(selectedTitle()).toBe('Alpha');
    expect(key('Tab', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(selectedTitle()).toBe('Alpha');
  });

  it('arrows move between cards; left/right are the caret\'s while typing', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    key('ArrowRight');
    expect(selectedTitle()).toBe('Bravo');
    key('ArrowLeft');
    expect(selectedTitle()).toBe('Alpha');
    type(sw, 'zzzz');
    await nextFrame();
    const e = key('ArrowRight');
    expect(e.defaultPrevented).toBe(false);
    expect(selectedTitle()).toBe('Alpha');
  });

  it('Ctrl+arrows switch the window shown', async () => {
    const sw = await boot({
      tabs: ABC(), prefs: { allWindows: true },
      beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/' }); },
    });
    key('ArrowRight', { ctrlKey: true });
    expect(sw.state.scope).toBe(1);
    key('ArrowLeft', { ctrlKey: true });
    key('ArrowLeft', { ctrlKey: true });
    expect(sw.state.scope).toBe(2);
    expect(openCards().map(titleOf)).toEqual(['Delta']);
  });
});

describe('1-9', () => {
  // Plain digits switch only with the focus off the (empty) search box; Alt+digit always.
  const focusOff = () => { tid('scroller').tabIndex = -1; tid('scroller').focus(); };

  it('focus elsewhere, box empty: a digit opens the card with that number', async () => {
    const sw = await boot({ tabs: ABC() });
    focusOff();
    const e = key('2', { code: 'Digit2' });
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
  });

  it('search box focused and empty: a digit is search text, not a switch', async () => {
    const sw = await boot({ tabs: ABC() });
    expect(document.activeElement).toBe(tid('search'));
    expect(tid('search').value).toBe('');
    const e = key('3', { code: 'Digit3' });
    expect(e.defaultPrevented).toBe(false); // the box types it
    await tick(10);
    expect(sw.state.done).toBe(false);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('Alt+digit always switches, even from the search box with text in it', async () => {
    const sw = await boot({ tabs: ABC() });
    type(sw, 'x');
    key('3', { code: 'Digit3', altKey: true });
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('focus elsewhere but text in the box: a digit does not switch', async () => {
    const sw = await boot({ tabs: ABC() });
    type(sw, 'x');
    focusOff();
    key('2', { code: 'Digit2' });
    await tick(10);
    expect(sw.state.done).toBe(false);
  });

  it('a number past the open cards does nothing; repeats are ignored', async () => {
    const sw = await boot({ tabs: ABC() });
    focusOff();
    key('7', { code: 'Digit7' });
    key('1', { code: 'Digit1', repeat: true });
    key('1', { code: 'Digit1', altKey: true, repeat: true });
    await tick(10);
    expect(sw.state.done).toBe(false);
  });
});

describe('Del, Ctrl+Z, Ctrl+F', () => {
  it('Del closes the selected tab and selects its neighbour; Ctrl+Z reopens it where it was', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.selectKey('t2');
    key('Delete');
    await waitFor(() => !openCards().some((c) => titleOf(c) === 'Bravo'));
    expect(chrome.tabs.remove).toHaveBeenCalledWith(2);
    expect(selectedTitle()).toBe('Charlie');
    expect(tid('toast-action')).not.toBe(null); // "Undo"
    key('z', { code: 'KeyZ', ctrlKey: true });
    await waitFor(() => chrome.tabs.create.mock.calls.length);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://bravo.example/', windowId: 1, index: 1, pinned: false, active: false });
    expect(sw.state.done).toBe(false);
  });

  it('Del: one tab per press, not one per repeat; not while typing', async () => {
    const sw = await boot({ tabs: ABC() });
    key('Delete', { repeat: true });
    type(sw, 'a');
    key('Delete');
    await tick(10);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('Ctrl+Z with nothing to undo says so; in a search box with text it is the box\'s own undo', async () => {
    const sw = await boot({ tabs: ABC() });
    key('z', { code: 'KeyZ', ctrlKey: true });
    await waitFor(() => !tid('toast').hidden);
    expect(tid('toast').textContent).not.toBe('');
    type(sw, 'abc');
    const e = key('z', { code: 'KeyZ', ctrlKey: true });
    expect(e.defaultPrevented).toBe(false);
  });

  it('Ctrl+F focuses and selects the search box', async () => {
    await boot({ tabs: ABC() });
    tid('scroller').tabIndex = -1;
    tid('scroller').focus();
    const sel = vi.spyOn(tid('search'), 'select');
    key('f', { code: 'KeyF', ctrlKey: true });
    expect(document.activeElement).toBe(tid('search'));
    expect(sel).toHaveBeenCalled();
  });
});

describe('Alt shortcuts', () => {
  it('Alt+S stars the selected tab', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.selectKey('t3');
    key('s', { code: 'KeyS', altKey: true });
    await waitFor(() => sw.state.stars['https://charlie.example/']);
    expect((await chrome.storage.local.get('stars')).stars['https://charlie.example/'].ti).toBe('Charlie');
  });

  it('Alt+P captures the selected tab\'s preview (and says so when it fails)', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.selectKey('t2');
    key('p', { code: 'KeyP', altKey: true });
    await waitFor(() => chrome.runtime.sendMessage.mock.calls.some(([m]) => m.type === 'tabazing:capture-one'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'tabazing:capture-one', tabId: 2 });
    await waitFor(() => !tid('toast').hidden);
    expect(sw.state.capturing).toBe(null);
    expect(sw.state.done).toBe(false);
  });

  it('Alt+Q / Alt+W step back / forward and hold; letting go of Alt switches', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    key('w', { code: 'KeyW', altKey: true });
    expect(selectedTitle()).toBe('Bravo');
    expect(sw.state.holding).toBe(true);
    key('w', { code: 'KeyW', altKey: true });
    key('q', { code: 'KeyQ', altKey: true });
    expect(selectedTitle()).toBe('Bravo');
    key('q', { code: 'KeyQ', altKey: true, shiftKey: true }); // Shift reverses Q
    expect(selectedTitle()).toBe('Charlie');
    keyUp('Alt');
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('Alt+E stops holding: letting go of Alt then does nothing', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { hold: true, dir: 1 } });
    key('e', { code: 'KeyE', altKey: true });
    expect(sw.state.holding).toBe(false);
    keyUp('Alt');
    await tick(80);
    expect(sw.state.done).toBe(false);
    expect(document.documentElement.classList.contains('alttab')).toBe(false); // the search box is back
    expect(document.activeElement).toBe(tid('search'));
  });

  it('any key without a modifier means Alt was already let go', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { hold: true, dir: 1 } });
    key('ArrowRight');
    expect(sw.state.holding).toBe(false);
    expect(selectedTitle()).toBe('Charlie');
    keyUp('Alt');
    await tick(10);
    expect(sw.state.done).toBe(false);
  });

  it('altReleased with search text just stops holding', async () => {
    const sw = await boot({ tabs: ABC() });
    tid('search').value = 'x';
    sw.qPress(1);
    sw.altReleased();
    expect(sw.state.holding).toBe(false);
    expect(sw.state.done).toBe(false);
  });

  it('a stray Alt+letter (a symbol on a Mac) is not typed', async () => {
    await boot({ tabs: ABC() });
    const e = key('å', { code: 'KeyA', altKey: true });
    expect(e.defaultPrevented).toBe(true);
  });

  it('while Alt is down the search box refuses text (beforeinput), and reverts any that slips in', async () => {
    const sw = await boot({ tabs: ABC() });
    key('Alt', { code: 'AltLeft', altKey: true });
    const bi = new InputEvent('beforeinput', { cancelable: true, data: '∑' });
    tid('search').dispatchEvent(bi);
    expect(bi.defaultPrevented).toBe(true);
    type(sw, '∑');
    expect(tid('search').value).toBe('');
    expect(sw.state.query).toBe('');
    keyUp('Alt');
    type(sw, 'b');
    expect(sw.state.query).toBe('b');
  });

  it('the background\'s CYCLE message moves the selection (dir 0 = stay open)', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    const send = (msg, sender = { id: chrome.runtime.id }) => { const respond = vi.fn(); chrome.runtime.onMessage._emit(msg, sender, respond); return respond; };
    expect(send({ type: 'tabazing:cycle', dir: 1, hold: true })).toHaveBeenCalledWith({ ok: true });
    expect(selectedTitle()).toBe('Bravo');
    expect(sw.state.holding).toBe(true);
    send({ type: 'tabazing:cycle', dir: 0 });
    expect(sw.state.holding).toBe(false);
    send({ type: 'tabazing:cycle', dir: 1 }, { id: chrome.runtime.id, tab: { id: 9 } }); // a content script: ignored
    expect(selectedTitle()).toBe('Bravo');
  });
});

describe('typing anywhere', () => {
  it('a letter typed with the focus elsewhere goes to the search box', async () => {
    await boot({ tabs: ABC() });
    tid('scroller').tabIndex = -1;
    tid('scroller').focus();
    key('k');
    expect(document.activeElement).toBe(tid('search'));
  });

  it('keys in another field are that field\'s; Esc there closes the card and gives the focus back to the gear', async () => {
    const sw = await boot({ tabs: ABC() });
    tid('settings-btn').click();
    await waitFor(() => tid('settings'));
    const lang = tid('settings-language');
    key('Enter', { target: lang });
    expect(sw.state.done).toBe(false);
    key('Escape', { target: lang });
    expect(tid('settings')).toBe(null);
    expect(document.activeElement).toBe(tid('settings-btn')); // what opened it
    expect(sw.state.done).toBe(false);
  });
});

describe('keys while a dialog or the archive is open', () => {
  it('a dialog takes the keyboard: Esc closes it, not the switcher', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.askStep1();
    expect(tid('modal').hidden).toBe(false);
    key('Enter');
    key('2', { code: 'Digit2' });
    expect(sw.state.done).toBe(false);
    key('Escape');
    expect(tid('modal').hidden).toBe(true);
    expect(sw.state.modal).toBe(null);
    expect(sw.state.done).toBe(false);
  });

  it('the tour: arrows step through it', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.tourStep(0);
    expect(tid('tour-step-of').textContent).toMatch(/^1 \//);
    key('ArrowRight');
    expect(tid('tour-step-of').textContent).toMatch(/^2 \//);
    key('ArrowLeft');
    expect(tid('tour-step-of').textContent).toMatch(/^1 \//);
    key('Escape');
    expect(sw.state.modal).toBe(null);
  });

  it('the archive overlay: Esc closes it only; Enter opens the archived page', async () => {
    const folder = chrome._addBookmark({ title: 'Tabs Archive' });
    chrome._addBookmark({ parentId: folder.id, title: 'Old', url: 'https://old.example/' });
    const sw = await boot({ tabs: ABC() });
    tid('archive-btn').click();
    await waitFor(() => tid('archive-overlay') && tid('card-archived'));
    key('Escape');
    expect(tid('archive-overlay')).toBe(null);
    expect(sw.state.done).toBe(false);
    tid('archive-btn').click();
    await waitFor(() => tid('card-archived'));
    key('Enter');
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://old.example/', windowId: 1, active: true });
  });
});

describe('the search box and its dropdown', () => {
  it('typing is drawn once per frame: dropdown, count and actions bar', async () => {
    const sw = await boot({ tabs: [...ABC(), { title: 'Bravo two', url: 'https://bravo2.example/' }] });
    type(sw, 'b');
    type(sw, 'br');
    type(sw, 'bravo');
    expect(sw.state.query).toBe('bravo');
    expect(tid('search-dropdown')).toBe(null); // not yet
    expect(sw.searchFrame).not.toBe(0);
    await nextFrame();
    expect(sw.searchFrame).toBe(0);
    expect(ddRows().map((r) => r.dataset.testid)).toEqual(['dd-row-tab', 'dd-row-tab']);
    expect(tids('dd-title').map((x) => x.textContent)).toEqual(['Bravo', 'Bravo two']);
    expect(tid('count').textContent).toMatch(/2/);
    expect(tid('acts').hidden).toBe(false); // "Select all 2"
    expect(tids('search-highlight')[0].textContent).toBe('Bravo');
    expect(openCards().length).toBe(4); // the cards don't follow the search
  });

  it('nothing found: "Open <address>" and a Google search', async () => {
    const sw = await boot({ tabs: ABC() });
    type(sw, 'zzz.example');
    await nextFrame();
    expect(ddRows().map((r) => r.dataset.testid)).toEqual(['dd-row-url', 'dd-row-google']);
    type(sw, 'qqqq xxxx');
    await nextFrame();
    expect(ddRows().map((r) => r.dataset.testid)).toEqual(['dd-row-google']);
  });

  it('↑/↓ move the highlight (wrapping) without rebuilding the rows', async () => {
    const sw = await boot({ tabs: [...ABC(), { title: 'Bravo two', url: 'https://bravo2.example/' }] });
    type(sw, 'bravo');
    await nextFrame();
    const [a, b] = ddRows();
    expect(a.getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    expect(sw.state.dd.hi).toBe(1);
    expect(ddRows()[1]).toBe(b);
    expect(b.getAttribute('aria-selected')).toBe('true');
    expect(a.getAttribute('aria-selected')).toBe('false');
    expect(tid('search').getAttribute('aria-activedescendant')).toBe('dd-1');
    key('ArrowDown');
    expect(sw.state.dd.hi).toBe(0);
    key('ArrowUp');
    expect(sw.state.dd.hi).toBe(1);
    key('Enter');
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(4, { active: true });
  });

  it('hovering a row does not move the highlight (only ↑ / ↓ do, as with the cards); a click opens the row clicked', async () => {
    const sw = await boot({ tabs: [...ABC(), { title: 'Bravo two', url: 'https://bravo2.example/' }] });
    type(sw, 'bravo');
    await nextFrame();
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) ddRows()[1].dispatchEvent(new MouseEvent(type, { bubbles: true }));
    expect(sw.state.dd.hi).toBe(0);
    expect(ddRows()[0].classList.contains('on')).toBe(true);
    expect(ddRows()[1].classList.contains('on')).toBe(false);
    ddRows()[1].click();
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(4, { active: true });
  });

  it('a press elsewhere hides the dropdown; typing brings it back', async () => {
    const sw = await boot({ tabs: ABC() });
    type(sw, 'bravo');
    await nextFrame();
    tid('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(tid('search-dropdown')).toBe(null);
    expect(sw.ddShown()).toBe(false);
    type(sw, 'bravo ');
    await nextFrame();
    expect(tid('search-dropdown')).not.toBe(null);
  });

  it('ddPic: one picture node per page, reused as the list is redrawn', async () => {
    const sw = await boot({ tabs: ABC() });
    type(sw, 'bra');
    await nextFrame();
    const pic = tid('dd-pic', ddRows()[0]);
    type(sw, 'brav');
    await nextFrame();
    expect(tid('dd-pic', ddRows()[0])).toBe(pic);
    expect(sw.ddPic('x', 'https://x.example/', null, 'ddicon')).toBe(sw.ddPic('x', 'https://x.example/', null, 'ddicon'));
    expect(sw.ddPic('x', 'https://x.example/', { img: 'data:image/jpeg;base64,AAAA', t: 1 })).not.toBe(sw.ddPic('x', 'https://x.example/', null));
  });

  it('bookmarks and history are read on the first search, once, and listed', async () => {
    chrome._addBookmark({ parentId: '1', title: 'Zebra docs', url: 'https://zebra.example/' });
    chrome._data.history = [{ url: 'https://yak.example/', title: 'Yak farm', lastVisitTime: Date.now() - 1000, visitCount: 3 }];
    const sw = await boot({ tabs: ABC() });
    expect(sw.state.marks).toBe(null);
    expect(sw.state.history).toBe(null);
    type(sw, 'zebra');
    await waitFor(() => tid('dd-row-mark'));
    const trees = chrome.bookmarks.getTree.mock.calls.length;
    expect(tid('dd-title', tid('dd-row-mark')).textContent).toBe('Zebra docs');
    type(sw, 'yak');
    await waitFor(() => tid('dd-row-visit'));
    expect(chrome.bookmarks.getTree).toHaveBeenCalledTimes(trees);
    expect(chrome.history.search).toHaveBeenCalledWith(expect.objectContaining({ text: '', maxResults: 5000 }));
  });
});

describe('ddActivate: each kind of row', () => {
  it('tab: its card when shown, else switches to the tab directly', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.setFilter('pinned'); // no cards
    sw.state.query = 'bravo';
    sw.deriveSearch();
    await sw.ddActivate({ kind: 'tab', entry: sw.state.found[0] });
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(sw.state.done).toBe(true);
  });

  it('closed: restores Chrome\'s session', async () => {
    const sw = await boot({ tabs: ABC() });
    await sw.ddActivate({ kind: 'closed', c: { url: 'https://gone.example/', session: { tab: { sessionId: 's9' } } } });
    expect(chrome.sessions.restore).toHaveBeenCalledWith('s9');
    closedWith('restore');
  });

  it('closed from our own log: reopens the page', async () => {
    const sw = await boot({ tabs: ABC() });
    await sw.ddActivate({ kind: 'closed', c: { url: 'https://gone.example/', session: null } });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://gone.example/', windowId: 1, active: true });
  });

  it('archived: out of the archive, into a new tab', async () => {
    const folder = chrome._addBookmark({ title: 'Tabs Archive' });
    const b = chrome._addBookmark({ parentId: folder.id, title: 'Old', url: 'https://old.example/' });
    const sw = await boot({ tabs: ABC() });
    await sw.ddActivate({ kind: 'archived', a: { id: b.id, url: b.url } });
    expect(chrome._findBookmark(b.id)).toBe(null);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://old.example/', windowId: 1, active: true });
  });

  it('bookmark / history: switches to the tab that has it open, else opens it', async () => {
    const sw = await boot({ tabs: ABC() });
    await sw.ddActivate({ kind: 'mark', b: { url: 'https://bravo.example/#top' } });
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('history page not open: a new tab', async () => {
    const sw = await boot({ tabs: ABC() });
    await sw.ddActivate({ kind: 'visit', x: { url: 'https://yak.example/' } });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://yak.example/', windowId: 1, active: true });
  });

  it('url / google: what was typed', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.state.query = 'localhost:3000';
    await sw.ddActivate({ kind: 'url', url: 'http://localhost:3000' });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'http://localhost:3000', windowId: 1, active: true });
  });

  it('nothing after closing', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.state.done = true;
    await sw.ddActivate({ kind: 'google' });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe('searching dims the cards that do not match', () => {
  it('while there is text, the others step back (they keep their places), and come back when it is cleared', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    type(sw, 'brav');
    await nextFrame();
    const dim = () => openCards().filter((c) => c.classList.contains('nomatch')).map(titleOf);
    expect(dim()).toEqual(['Alpha', 'Charlie']);
    expect(openCards().map(titleOf)).toEqual(['Alpha', 'Bravo', 'Charlie']); // same cards, same order
    expect(sw.state.hits.has('t2')).toBe(true);
    sw.refresh(); // a redraw keeps it
    expect(dim()).toEqual(['Alpha', 'Charlie']);
    key('Escape');
    expect(dim()).toEqual([]);
    expect(sw.state.hits).toBe(null);
  });
});

describe('Enter with search text', () => {
  it('uses the dropdown only while it shows: with it hidden, Enter opens the selected card', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    type(sw, 'charlie');
    await nextFrame();
    tid('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); // hides the dropdown
    expect(sw.ddShown()).toBe(false);
    expect(sw.state.dd.items.length).toBeGreaterThan(0); // (its rows are still known)
    tid('search').focus();
    key('Enter');
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { active: true }); // Alpha, the selected card, not Charlie's row
  });
});

describe('Settings -> Search', () => {
  it('the placeholder says what is searched', async () => {
    let sw = await boot({ tabs: ABC() });
    expect(tid('search').placeholder).toBe('Search tabs, history, bookmarks and the archive');
    sw = await boot({ tabs: ABC(), prefs: { searchHistory: false } });
    expect(tid('search').placeholder).toBe('Search tabs, bookmarks and the archive');
    sw = await boot({ tabs: ABC(), prefs: { searchBookmarks: false } });
    expect(tid('search').placeholder).toBe('Search tabs, history and the archive');
    sw = await boot({ tabs: ABC(), prefs: { searchBookmarks: false, searchHistory: false } });
    expect(tid('search').placeholder).toBe('Search tabs and the archive');
  });

  it('history and bookmarks left out are neither read nor listed', async () => {
    chrome._addBookmark({ title: 'Zebra docs', url: 'https://zebra.example/' });
    chrome._data.history = [{ url: 'https://zebra-history.example/', title: 'Zebra history', lastVisitTime: Date.now(), visitCount: 1 }];
    const sw = await boot({ tabs: ABC(), prefs: { searchBookmarks: false, searchHistory: false } });
    type(sw, 'zebra');
    await nextFrame();
    await tick(200);
    expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
    expect(chrome.history.search).not.toHaveBeenCalled();
    expect(ddRows().map((r) => r.dataset.testid)).toEqual(['dd-row-google']);
  });
});

describe('ticking from the keyboard', () => {
  const picked = (sw) => sw.state.tabs.filter((x) => sw.state.picked.has(x.id)).map((x) => x.title);
  const many = () => [...ABC(), { title: 'Delta', url: 'https://delta.example/' }, { title: 'Echo', url: 'https://echo.example/' }];

  it('Shift+→ / Shift+← tick a range from the selected card; stepping back shrinks it', async () => {
    const sw = await boot({ tabs: many(), ctx: { dir: 0 } });
    sw.select(1); // Bravo
    tid('scroller').focus();
    key('ArrowRight', { shiftKey: true });
    expect(selectedTitle()).toBe('Charlie');
    expect(picked(sw)).toEqual(['Bravo', 'Charlie']);
    key('ArrowRight', { shiftKey: true });
    expect(picked(sw)).toEqual(['Bravo', 'Charlie', 'Delta']);
    key('ArrowLeft', { shiftKey: true });
    expect(picked(sw)).toEqual(['Bravo', 'Charlie']);
    key('ArrowLeft', { shiftKey: true });
    key('ArrowLeft', { shiftKey: true }); // past the start: the other way
    expect(picked(sw)).toEqual(['Alpha', 'Bravo']);
  });

  it('a run keeps the ticks made before it; any other key ends it', async () => {
    const sw = await boot({ tabs: many(), ctx: { dir: 0 } });
    sw.pick(sw.state.entries[4]); // Echo
    sw.select(0);
    tid('scroller').focus();
    key('ArrowRight', { shiftKey: true });
    expect(picked(sw)).toEqual(['Alpha', 'Bravo', 'Echo']);
    key('ArrowRight'); // ends the run
    expect(sw.state.shiftBase).toBe(null);
  });

  it('Ctrl+Space ticks and unticks the selected card; Space alone is still its big preview', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    sw.select(1);
    const e = key(' ', { ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(picked(sw)).toEqual(['Bravo']);
    expect(tid('big-preview')).toBe(null);
    key(' ', { metaKey: true });
    expect(picked(sw)).toEqual([]);
    key(' ');
    expect(tid('big-preview')).not.toBe(null);
  });

  it('Shift+arrows in the search box with text stay the box’s own (text selection)', async () => {
    const sw = await boot({ tabs: ABC() });
    type(sw, 'al');
    const e = key('ArrowLeft', { shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(sw.state.picked.size).toBe(0);
  });
});
