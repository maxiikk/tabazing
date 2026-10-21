// Drawing the switcher: cards, sections, the toolbar, the window list, selection, and the small UI pieces.
import { describe, it, expect, vi } from 'vitest';
import { tick, waitFor } from '../helpers/switcher.js';
import { boot, ABC, cards, openCards, titles, titleOf, selectedTitle, tid, tids } from './_ui.js';
import { t } from '../../utils/translations.js';

const IMG = 'data:image/jpeg;base64,AAAA';
const preview = (url) => ({ ['pv:' + url]: { img: IMG, t: Date.now() } });
const card = (title) => openCards().find((c) => titleOf(c) === title);
const many = (n) => Array.from({ length: n }, (_, i) => ({ title: 'Tab ' + (i + 1), url: `https://t${i + 1}.example/` }));

describe('renderCard: open tabs', () => {
  it('one card per tab: title, id, option role, close and star buttons, a tick box', async () => {
    const sw = await boot({ tabs: ABC() });
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    const c = card('Bravo');
    expect(c.dataset.testid).toBe('card-tab');
    expect(c.id).toBe('opt-t2');
    expect(c.getAttribute('role')).toBe('option');
    expect(tid('card-close', c)).not.toBe(null);
    expect(tid('card-star-button', c).getAttribute('aria-pressed')).toBe('false');
    expect(tid('card-pick', c).getAttribute('aria-checked')).toBe('false');
    expect(c.title).toBe('Bravo\nhttps://bravo.example/');
    expect(sw.state.entries[1].url).toBe('https://bravo.example/');
  });

  it('numbers the first nine cards only', async () => {
    await boot({ tabs: many(11) });
    const nums = openCards().map((c) => tid('card-number', c)?.textContent ?? null);
    expect(nums).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', null, null]);
  });

  it('pinned tabs come first and carry a pin badge, on the picture', async () => {
    const tabs = ABC();
    tabs[2].pinned = true;
    await boot({ tabs });
    expect(titles()[0]).toBe('Charlie');
    expect(tid('card-pinned', tid('card-flags', tid('card-thumb', card('Charlie'))))).not.toBe(null);
    expect(tid('card-pinned', tid('card-head', card('Charlie')))).toBe(null);
    expect(tid('card-pinned', card('Bravo'))).toBe(null);
  });

  it('Settings -> Pinned tabs first off: pinned tabs stay in the chosen sort', async () => {
    const tabs = ABC();
    tabs[2].pinned = true;
    await boot({ tabs, prefs: { pinnedFirst: false } });
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('the tags (days ago, window, back from snooze) sit on the picture, top left; the site name only shows without them', async () => {
    const old = Date.now() - 3 * 86400e3;
    const sw = await boot({
      tabs: [ABC()[0], { ...ABC()[1], lastAccessed: old }, ABC()[2]],
      beforeImport: () => chrome.storage.session.set({ woken: { 3: Date.now() - 1000 } }),
    });
    const flags = tid('card-flags', tid('card-thumb', card('Bravo')));
    expect(tid('card-age', flags).textContent).toBe('3 days ago');
    expect(tid('card-age', tid('card-head', card('Bravo')))).toBe(null);
    expect(tid('card-woken', tid('card-thumb', card('Charlie'))).textContent).toBe('Back from snooze');
    expect(tid('card-woken', card('Alpha'))).toBe(null);
    expect(tid('card-flags', card('Alpha'))).toBe(null); // no tags: no empty pill
    sw.state.cardW = 320;
    sw.redraw(() => true);
    expect(tid('card-host', card('Bravo'))).toBe(null); // tags shown: no site name
    expect(tid('card-host', card('Alpha')).textContent).toBe('alpha.example');
  });

  it('Settings -> Show "days ago" tags off: no age tag', async () => {
    await boot({ tabs: [ABC()[0], { ...ABC()[1], lastAccessed: Date.now() - 5 * 86400e3 }], prefs: { showAge: false } });
    expect(tid('card-age', card('Bravo'))).toBe(null);
  });

  it('list size: the tags stay in the row, compact', async () => {
    await boot({ tabs: [ABC()[0], { ...ABC()[1], pinned: true }], prefs: { cardSize: 'list' } });
    expect(tid('card-pinned', tid('card-flags', tid('card-head', card('Bravo'))))).not.toBe(null);
  });

  it('a card\'s buttons show only while the pointer is on the card, not on the selected card (styles/switcher.css)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8');
    // the keyboard can't reach them (it has the card's menu and the keys): no selected-card rule shows any of them
    expect(css).not.toMatch(/\.card\[aria-selected="true"\] (\.head:has\(\.hbtns|\.star|\.x\b|\.qbtn|\.snap|\.flags)/);
    expect(css).not.toMatch(/\.grid\.list \.card\[aria-selected="true"\] \.qbtn/);
    expect(css).toMatch(/\.card:hover \.star, \.card:hover \.x \{ opacity: 1; \}/);
    expect(css).toMatch(/\.card:hover \.qbtn, \.qbtn:focus-visible, \.qbtn\.note\.on \{ opacity: 1; \}/); // a note's button stays: it says there is one
    expect(css).toMatch(/\.star\.on \{ opacity: 1;/); // so does a starred page's star
  });

  it('while Alt is held (no search field), the header\'s two button groups still sit at its two ends (styles/switcher.css)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8');
    expect(css).toMatch(/html\.alttab \.search, html\.alttab \.qbtn\.note \{ display: none !important; \}/);
    expect(css).toMatch(/html\.alttab #keys-btn \{ margin-inline-start: auto; \}/); // the wide header: it takes the free room
    expect(css).toMatch(/html\.alttab \.bar\.narrow #keys-btn \{ grid-column: 4; \}/); // narrow: the search's column stays, empty
    await boot({ tabs: ABC() });
    const head = [...tid('header').children].filter((n) => n.tagName === 'BUTTON').map((n) => n.dataset.testid);
    expect(head).toEqual(['menu-btn', 'newtab', 'keys-btn', 'github-btn']); // keys-btn starts the end group
  });

  it('the star and × sit in one box over the end of the header (they take no room while hidden)', async () => {
    await boot({ tabs: ABC() });
    const box = tid('card-head-buttons', card('Bravo'));
    expect(box.parentElement).toBe(tid('card-head', card('Bravo')));
    expect([...box.children].map((b) => b.dataset.testid)).toEqual(['card-star-button', 'card-close']);
    expect(box.classList.contains('two')).toBe(true);
  });

  it('two title lines by default (html.lines2); Settings -> Title lines: one', async () => {
    let sw = await boot({ tabs: ABC() });
    expect(document.documentElement.classList.contains('lines2')).toBe(true);
    sw = await boot({ tabs: ABC(), prefs: { titleLines: 1 } });
    expect(document.documentElement.classList.contains('lines2')).toBe(false);
    expect(sw.state.prefs.titleLines).toBe(1);
  });

  it('audio badge: speaker while playing, crossed out while muted', async () => {
    const tabs = ABC();
    tabs[1].audible = true;
    tabs[2].mutedInfo = { muted: true };
    await boot({ tabs });
    expect(tid('card-audio', card('Bravo')).classList.contains('on')).toBe(true);
    expect(tid('card-audio', card('Charlie')).classList.contains('on')).toBe(false);
    expect(tid('card-audio', card('Alpha'))).toBe(null);
  });

  it('a starred page has its star on', async () => {
    await chrome.storage.local.set({ stars: { 'https://bravo.example/': { u: 'https://bravo.example/', ti: 'Bravo', t: Date.now() } } });
    await boot({ tabs: ABC() });
    const b = tid('card-star-button', card('Bravo'));
    expect(b.classList.contains('on')).toBe(true);
    expect(b.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the stored preview, else a placeholder with "Capture preview"', async () => {
    await chrome.storage.local.set(preview('https://bravo.example/'));
    await boot({ tabs: ABC() });
    expect(tid('card-preview', card('Bravo')).src).toBe(IMG);
    expect(tid('card-no-preview', card('Bravo'))).toBe(null);
    const ph = tid('card-no-preview', card('Charlie'));
    expect(tid('card-no-preview-sub', ph).textContent).toBe('charlie.example');
    expect(tid('card-capture', ph)).not.toBe(null);
  });

  it('no "Capture preview" on pages Chrome will not screenshot', async () => {
    await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'Ext', url: 'chrome://extensions/' }] });
    expect(tid('card-no-preview', card('Ext'))).not.toBe(null);
    expect(tid('card-capture', card('Ext'))).toBe(null);
  });

  it('sleeping: only a tab Chrome discarded while we watched', async () => {
    const tabs = ABC();
    tabs[1].discarded = true; // seen being discarded
    tabs[2].discarded = true; // restored lazily after a restart: not sleeping
    await chrome.storage.session.set({ slept: [2] });
    await boot({ tabs });
    expect(card('Bravo').classList.contains('asleep')).toBe(true);
    expect(tid('card-no-preview-label', card('Bravo')).textContent).toBe('Asleep');
    expect(card('Charlie').classList.contains('asleep')).toBe(false);
  });

  it('marked to sleep on close: asleep look before it happens', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.state.toSleep.add(3);
    sw.refresh();
    expect(card('Charlie').classList.contains('asleep')).toBe(true);
  });

  it('list size: one line per tab, no picture, quick buttons in the header', async () => {
    await boot({ tabs: ABC(), prefs: { cardSize: 'list' } });
    const c = card('Bravo');
    expect(tid('card-thumb', c)).toBe(null);
    expect(tid('card-quick-actions', tid('card-head', c))).not.toBe(null);
    expect(tid('section-grid').classList.contains('list')).toBe(true);
  });

  it('a ticked tab looks picked', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.state.picked.add(2);
    sw.refresh();
    expect(card('Bravo').classList.contains('picked')).toBe(true);
    expect(tid('card-pick', card('Bravo')).getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.classList.contains('picking')).toBe(true);
  });
});

describe('renderCard: closed, snoozed and starred cards', () => {
  it('recently closed: a card under "Recently closed" with how long ago', async () => {
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 120, tab: { sessionId: 'x1', url: 'https://gone.example/', title: 'Gone' } }];
    const sw = await boot({ tabs: ABC() });
    const [c] = cards(tid('closed-grid'));
    expect(c.dataset.testid).toBe('card-closed');
    expect(titleOf(c)).toBe('Gone');
    expect(tid('card-closed-ago', c).textContent).toMatch(/2/);
    expect(tid('card-number', c)).toBe(null);
    expect(tid('closed-section').hidden).toBe(false);
    expect(tid('closed-h').textContent).toBe('Recently closed');
    expect(sw.state.entries.at(-1).kind).toBe('closed');
  });

  it('snoozed: its own section, when it wakes, × cancels the snooze', async () => {
    const at = Date.now() + 3600e3;
    await chrome.storage.local.set({ snoozed: [{ id: 'z1', url: 'https://later.example/', title: 'Later', at, windowId: 1, pinned: false, t: Date.now() }] });
    const sw = await boot({ tabs: ABC() });
    expect(tid('snoozed-section').hidden).toBe(false);
    const [c] = cards(tid('snoozed-grid'));
    expect(c.dataset.testid).toBe('card-snoozed');
    expect(tid('card-wakes', c)).not.toBe(null);
    tid('card-cancel-snooze', c).click();
    await waitFor(() => !cards(tid('snoozed-grid')).length);
    expect(await chrome.storage.local.get('snoozed')).toEqual({ snoozed: [] });
    expect(sw.state.snoozed).toEqual([]);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('starred, not open: shown under the Starred filter, opens in a new tab', async () => {
    await chrome.storage.local.set({ stars: { 'https://far.example/': { u: 'https://far.example/', ti: 'Far', t: Date.now() } } });
    const sw = await boot({ tabs: ABC() });
    sw.toggleStarFilter();
    expect(openCards().length).toBe(0);
    expect(tid('open-empty').hidden).toBe(false);
    expect(tid('closed-h').textContent).not.toBe('Recently closed');
    const [c] = cards(tid('closed-grid'));
    expect(c.dataset.testid).toBe('card-star');
    expect(titleOf(c)).toBe('Far');
    expect(tid('card-star-button', c).classList.contains('on')).toBe(true);
    c.click();
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://far.example/', windowId: 1, active: true });
  });

  it('middle-click: a recently closed card leaves the list, a snoozed one its snooze, a starred one opens behind', async () => {
    const middle = (c) => {
      const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
      c.dispatchEvent(md);
      expect(md.defaultPrevented).toBe(true); // no auto-scroll
      c.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    };
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 120, tab: { sessionId: 'x1', url: 'https://gone.example/', title: 'Gone' } }];
    await chrome.storage.local.set({ snoozed: [{ id: 'z1', url: 'https://later.example/', title: 'Later', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() }] });
    const sw = await boot({ tabs: ABC() });
    middle(cards(tid('closed-grid'))[0]);
    await waitFor(() => !cards(tid('closed-grid')).length);
    expect(tid('toast').firstChild.textContent).toBe(t('closedRemoved'));
    middle(cards(tid('snoozed-grid'))[0]);
    await waitFor(() => !cards(tid('snoozed-grid')).length);
    expect(sw.state.snoozed).toEqual([]);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    await chrome.storage.local.set({ stars: { 'https://far.example/': { u: 'https://far.example/', ti: 'Far', t: Date.now() } } });
    await sw.reload();
    sw.toggleStarFilter();
    middle(cards(tid('closed-grid'))[0]);
    await waitFor(() => chrome.tabs.create.mock.calls.length);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://far.example/', windowId: 1, active: false });
    expect(sw.state.done).toBe(false);
  });
});

describe('finishCard: the mouse on a card', () => {
  it('click opens that tab and closes the switcher', async () => {
    const sw = await boot({ tabs: ABC() });
    card('Charlie').click();
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tabazing:closed', reason: 'switch' }));
    expect(window.close).toHaveBeenCalled();
  });

  it('Shift+click on the preview shows it big', async () => {
    const sw = await boot({ tabs: ABC() });
    tid('card-thumb', card('Bravo')).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(tid('big-preview-title').textContent).toBe('Bravo');
    expect(sw.state.done).toBe(false);
    expect(sw.state.picked.size).toBe(0);
  });

  it('Ctrl+click (⌘-click) ticks and unticks a card; Shift+click on a tick box ticks the range from the last one', async () => {
    const sw = await boot({ tabs: ABC() });
    card('Alpha').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect([...sw.state.picked]).toEqual([1]);
    card('Bravo').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    expect([...sw.state.picked].sort()).toEqual([1, 2]);
    card('Bravo').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); // untick
    expect([...sw.state.picked]).toEqual([1]);
    tid('card-pick', card('Charlie')).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); // from Bravo (the last one clicked)
    expect([...sw.state.picked].sort()).toEqual([1, 2, 3]);
    expect(sw.state.done).toBe(false);
    expect(tid('big-preview')).toBe(null);
  });

  it('a plain click switches to the tab even while others are ticked; the bar says how to tick more', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.pick(sw.state.entries[0]);
    expect(tid('acts-hint').hidden).toBe(false);
    expect(tid('acts-hint').textContent).toBe('Ctrl+click cards to select more');
    card('Charlie').click();
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('right-click opens the card menu at the pointer, not Chrome’s', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 60 });
    card('Charlie').dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(selectedTitle()).toBe('Charlie');
    expect(tid('menu')).not.toBe(null);
    expect(tid('menu').style.left).toBe('150px');
    const labels = tids('menu-item').map((b) => b.textContent);
    expect(labels).toContain('Close'); // the menu is about this tab: no "this tab" / "tab" in its items
    expect(labels.filter((l) => /\b(this )?tab\b/i.test(l))).toEqual([]);
  });

  it('middle-click closes the tab', async () => {
    const sw = await boot({ tabs: ABC() });
    const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
    card('Bravo').dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true); // no auto-scroll
    card('Bravo').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => !card('Bravo'));
    expect(chrome.tabs.remove).toHaveBeenCalledWith(2);
    expect(sw.state.done).toBe(false);
  });

  it('hovering a card doesn\'t select it (nor switch to it); a click switches to its tab', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    for (const type of ['mouseover', 'mouseenter', 'mousemove', 'mousemove']) card('Charlie').dispatchEvent(new MouseEvent(type, { bubbles: true }));
    expect(selectedTitle()).toBe('Alpha'); // the selection stays where it was
    expect(card('Charlie').getAttribute('aria-selected')).toBe('false');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    card('Charlie').click();
    await waitFor(() => chrome.tabs.update.mock.calls.some(([id, p]) => id === sw.state.tabs.find((x) => x.title === 'Charlie').id && p.active));
  });

  it('nor in the archive overlay', async () => {
    const sw = await boot({ tabs: ABC(), beforeImport: () => {
      const arch = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
      for (const n of ['One', 'Two']) chrome._addBookmark({ parentId: arch.id, title: n, url: `https://${n.toLowerCase()}.example/` });
    } });
    await sw.openArchive();
    const cards = tids('card-archived');
    const before = sw.state.archSel;
    cards[1 - before].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(sw.state.archSel).toBe(before);
  });

  it('a click on empty space anywhere (the backdrop, between cards, a heading, the toolbar, the window list, the header) does not close it', async () => {
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'x1', url: 'https://gone.example/', title: 'Gone' } }];
    const sw = await boot({ tabs: ABC(), prefs: { allWindows: true }, beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/' }); } });
    for (const id of ['section-grid', 'open-grid', 'open-h', 'closed-h', 'closed-section', 'open-section', 'tools', 'view-toolbar', 'wins', 'qfilters',
      'header', 'search-box', 'player', 'open-head', 'open-end', 'open-actions', 'scroller', 'body', 'app']) { // the backdrop and the header's empty space too
      tid(id).click();
      expect(sw.state.done, id).toBe(false);
    }
  });
});

describe('thumbFor / starButton / captureButton', () => {
  it('thumbFor: picture with a pill, or a placeholder with label, site and action', async () => {
    const sw = await boot();
    const withPic = sw.thumbFor({ url: 'https://a.example/', preview: { img: IMG } }, { label: 'Sleeping', icon: sw.ICON.moon });
    expect(tid('card-preview', withPic).src).toBe(IMG);
    expect(tid('card-pill', withPic).textContent).toBe('Sleeping');
    const plain = sw.thumbFor({ url: 'https://a.example/', preview: { img: IMG } }, { label: '', icon: '' });
    expect(tid('card-pill', plain)).toBe(null);
    const btn = document.createElement('button');
    const none = sw.thumbFor({ url: 'https://a.example/', preview: null }, { label: '', sub: 'a.example', icon: sw.ICON.camera, action: btn });
    expect(tid('card-no-preview-label', none).textContent).toBe('No preview yet');
    expect(tid('card-no-preview-sub', none).textContent).toBe('a.example');
    expect(tid('card-tile-favicon', none).src).toContain('_favicon');
    expect(none.contains(btn)).toBe(true);
  });

  it('starButton: click stars the page, and the card shows it', async () => {
    const sw = await boot({ tabs: ABC() });
    tid('card-star-button', card('Bravo')).click();
    await waitFor(() => tid('card-star-button', card('Bravo')).classList.contains('on'));
    const { stars } = await chrome.storage.local.get('stars');
    expect(stars['https://bravo.example/']).toMatchObject({ u: 'https://bravo.example/', ti: 'Bravo' });
    expect(tid('star-n').textContent).toBe('1');
    expect(sw.state.done).toBe(false); // the click did not open the tab
  });

  it('captureButton: says "Capturing…" and is disabled while busy', async () => {
    const sw = await boot({ tabs: ABC() });
    const entry = sw.state.entries[1];
    const idle = sw.captureButton(entry);
    expect(idle.disabled).toBe(false);
    sw.state.capturing = entry.tab.id;
    const busy = sw.captureButton(entry);
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).not.toBe(idle.textContent);
  });
});

describe('windows: renderWindows, windowTag, setScope, cycleScope', () => {
  const twoWindows = () => boot({
    tabs: ABC(), prefs: { allWindows: true },
    beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/', active: true }); },
  });

  it('one window: no window list', async () => {
    await boot({ tabs: ABC() });
    expect(tid('wins').hidden).toBe(true);
    expect(tid('wins').children.length).toBe(0);
  });

  it('several: "Merge all into this window", "All windows", then each window; tabs elsewhere get a window tag', async () => {
    const sw = await twoWindows();
    expect(tid('wins').hidden).toBe(false);
    expect(tid('wins').firstChild).toBe(tid('windows-merge-all'));
    expect(tid('windows-merge-all-label').textContent).toBe('Merge all into this window');
    expect(tid('merge-btn').hidden).toBe(true); // the window list's own takes over
    expect(tid('body').classList.contains('with-wins')).toBe(true);
    expect(tids('window-label').map((x) => x.textContent)).toEqual(['All windows', 'This window', 'Window 2']);
    expect(tid('window-all').getAttribute('aria-pressed')).toBe('true');
    expect(tids('window-merge').length).toBe(1); // only on the other window
    expect(tid('card-window-tag', card('Delta')).textContent).toBe('Window 2');
    expect(tid('card-window-tag', card('Alpha'))).toBe(null);
    expect(sw.windowTag(sw.state.tabs.find((x) => x.title === 'Delta')).textContent).toBe('Window 2');
  });

  it('"Merge all into this window" merges at once, with Undo', async () => {
    const sw = await twoWindows();
    tid('windows-merge-all').click();
    await waitFor(() => tid('toast-action'));
    expect(chrome.tabs.move).toHaveBeenCalledWith([4], { windowId: 1, index: -1 });
    expect(sw.state.undo.at(-1).kind).toBe('merge');
  });

  it("a window's own merge button merges just that one, at once", async () => {
    const sw = await twoWindows();
    tid('window-merge').click();
    await waitFor(() => chrome.tabs.move.mock.calls.length);
    expect(chrome.tabs.move).toHaveBeenCalledWith([4], { windowId: 1, index: -1 });
    expect(sw.state.done).toBe(false);
  });

  it('clicking a window shows only its tabs (no window tags then)', async () => {
    const sw = await twoWindows();
    tids('window-item')[1].click();
    expect(sw.state.scope).toBe(2);
    expect(titles()).toEqual(['Delta']);
    expect(tid('card-window-tag', card('Delta'))).toBe(null);
    expect(tids('window-item')[1].getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(tid('search'));
  });

  it('cycleScope steps All -> this -> Window 2 -> All', async () => {
    const sw = await twoWindows();
    sw.cycleScope(1);
    expect(sw.state.scope).toBe(1);
    sw.cycleScope(1);
    expect(sw.state.scope).toBe(2);
    sw.cycleScope(1);
    expect(sw.state.scope).toBe('all');
    sw.cycleScope(-1);
    expect(sw.state.scope).toBe(2);
    expect(sw.state.sel).toBe(0);
  });

  it('cycleScope does nothing with one window', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.cycleScope(1);
    expect(sw.state.scope).toBe('all');
  });
});

describe('renderSection / toggleSection (the duplicates view has headers)', () => {
  const dupes = () => boot({ tabs: [
    { title: 'Doc', url: 'https://doc.example/' }, { title: 'Doc', url: 'https://doc.example/#x' },
    { title: 'News', url: 'https://news.example/' }, { title: 'News', url: 'https://news.example/' },
    { title: 'Solo', url: 'https://solo.example/' },
  ] });

  it('a plain list has no header', async () => {
    await boot({ tabs: ABC() });
    expect(tid('section-toggle')).toBe(null);
    expect(tids('section').length).toBe(1);
  });

  it('one section per duplicated page, each card saying whether it stays or closes', async () => {
    const sw = await dupes();
    sw.dupesView(true);
    expect(tids('section-name').map((x) => x.textContent)).toEqual(['Doc', 'News']);
    expect(tids('section-count')[0].textContent).toBe('2');
    expect(tids('card-dupe-stays').length).toBe(2);
    expect(tids('card-dupe-closes').length).toBe(2);
    expect(titles()).not.toContain('Solo');
  });

  it('a header click collapses it (remembered), shows favicons as a peek, and opens again', async () => {
    const sw = await dupes();
    sw.dupesView(true);
    tid('section-toggle').click();
    const sec = tid('section');
    expect(sec.classList.contains('collapsed')).toBe(true);
    expect(tid('section-toggle', sec).getAttribute('aria-expanded')).toBe('false');
    expect(tids('section-peek-favicon', sec).length).toBe(2);
    expect(tid('section-grid', sec)).toBe(null);
    await tick(5);
    expect((await chrome.storage.local.get('view')).view.collapsed).toEqual(['d:https://doc.example/']);
    sw.toggleSection('d:https://doc.example/');
    expect(tid('section').classList.contains('collapsed')).toBe(false);
  });

  it('renderSection: cards numbered from startIndex', async () => {
    const sw = await boot({ tabs: ABC() });
    const box = sw.renderSection({ key: 'k', title: 'T', entries: sw.state.entries.slice(0, 2), collapsed: false }, 5);
    expect(tid('section-name', box).textContent).toBe('T');
    expect(tids('card-number', box).map((x) => x.textContent)).toEqual(['6', '7']);
  });
});

describe('renderTools: filters, Starred, duplicates, merge', () => {
  it('a chip per quick filter some tab matches, with how many; clicking filters the cards', async () => {
    const tabs = ABC();
    tabs[1].pinned = true;
    tabs[2].audible = true;
    const sw = await boot({ tabs });
    expect([...tid('qfilters').children].map((c) => c.dataset.testid)).toEqual(['filter-audio', 'filter-pinned']);
    const pinned = tid('filter-pinned');
    expect(tid('filter-count', pinned).textContent).toBe('1');
    // only the icon and the count show: the name is the tooltip and, with the count, the accessible name
    expect(pinned.textContent).toBe('1');
    expect(pinned.getAttribute('aria-label')).toBe(t('chipAria', { name: t('fPinned'), count: 1 }));
    expect(pinned.getAttribute('aria-label')).toBe('Pinned: 1');
    expect(pinned.title).toBe('Pinned');
    expect(pinned.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
    pinned.click();
    expect(sw.state.filter).toBe('pinned');
    expect(titles()).toEqual(['Bravo']);
    expect(tid('filter-pinned').getAttribute('aria-pressed')).toBe('true');
    tid('filter-pinned').click();
    expect(sw.state.filter).toBe(null);
    expect(openCards().length).toBe(3);
  });

  it('setFilter selects the first card and scrolls to the top', async () => {
    const tabs = ABC();
    tabs[2].audible = true;
    const sw = await boot({ tabs, ctx: { dir: 0 } });
    tid('scroller').scrollTop = 50;
    sw.setFilter('audio');
    expect(titles()).toEqual(['Charlie']);
    expect(sw.state.sel).toBe(0);
    expect(tid('scroller').scrollTop).toBe(0);
  });

  it('the Starred chip shows only its icon and count; its name is the tooltip and, with the count, the accessible name', async () => {
    await chrome.storage.local.set({ stars: { 'https://charlie.example/': { u: 'https://charlie.example/', ti: 'Charlie', t: Date.now() } } });
    await boot({ tabs: ABC() });
    const chip = tid('star-filter');
    expect(chip.textContent.trim()).toBe('1');
    expect(chip.getAttribute('aria-label')).toBe('Starred: 1');
    expect(chip.title).toBe('Starred');
  });

  it('Sort and the filter chips sit at the end of the Open tabs row, as a toolbar beside its heading', async () => {
    await boot({ tabs: ABC() });
    const head = tid('open-head');
    const bar = tid('view-toolbar');
    expect(head.contains(tid('open-h'))).toBe(true);
    expect([...head.children]).toEqual([tid('open-title'), tid('open-end')]); // the title first, then (at the other end) what acts on the open tabs
    expect([...tid('open-title').children]).toEqual([tid('group-leave'), tid('group-dot'), tid('open-h'), tid('group-count')]); // (the group view's parts hidden)
    for (const id of ['group-leave', 'group-dot', 'group-count']) expect(tid(id).hidden, id).toBe(true);
    expect(bar.parentElement).toBe(tid('open-end'));
    expect([...tid('open-end').children]).toEqual([tid('open-actions'), bar]); // merge / duplicates, then sort and the chips
    for (const id of ['merge-btn', 'dupes-btn']) expect(tid('open-actions').contains(tid(id)), id).toBe(true);
    expect(tid('open-h').tagName).toBe('H2');
    expect(bar.getAttribute('role')).toBe('toolbar');
    expect(bar.getAttribute('aria-label')).toBe(t('viewAria'));
    for (const id of ['sort', 'select-sort', 'star-filter', 'qfilters']) expect(bar.contains(tid(id)), id).toBe(true);
    expect(tid('tools').contains(bar)).toBe(false);
    expect(tid('tools').contains(tid('setup-actions'))).toBe(true); // "Capture all" stays up there
    expect([...tid('setup-actions').children]).toEqual([tid('sweep-btn')]);
  });

  it('the toolbar row takes no room while none of its buttons shows; the row of the Open tabs title spreads its ends apart', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8');
    expect(css).toMatch(/\.tools:not\(:has\(> \.setup > :not\(\[hidden\]\)\)\) \{ display: none; \}/);
    expect(css).toMatch(/\.open-head \{[^}]*justify-content: space-between;[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.chip \{[^}]*height: 32px; min-width: 32px;/); // a target of 24 px or more (Material's filter chip)
  });

  it('Starred filter: pressed state and only starred tabs', async () => {
    await chrome.storage.local.set({ stars: { 'https://charlie.example/': { u: 'https://charlie.example/', ti: 'Charlie', t: Date.now() } } });
    const sw = await boot({ tabs: ABC() });
    expect(tid('star-n').textContent).toBe('1');
    tid('star-filter').click();
    expect(sw.state.starOnly).toBe(true);
    expect(tid('star-filter').getAttribute('aria-pressed')).toBe('true');
    expect(titles()).toEqual(['Charlie']);
    sw.toggleStarFilter();
    expect(openCards().length).toBe(3);
  });

  it('duplicates button only when some page is open twice', async () => {
    await boot({ tabs: ABC() });
    expect(tid('dupes-btn').hidden).toBe(true);
  });

  it('duplicates button: count, and a click opens the duplicates view with its bar', async () => {
    const sw = await boot({ tabs: [...ABC(), { title: 'Alpha again', url: 'https://alpha.example/' }] });
    const btn = tid('dupes-btn');
    expect(btn.hidden).toBe(false);
    expect(tid('dupes-text').textContent).toMatch(/1/);
    btn.click();
    expect(sw.state.dupesView).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(tid('acts').hidden).toBe(false);
    expect(tid('acts').classList.contains('dupes')).toBe(true);
    expect(tid('dupes-close').disabled).toBe(false);
    tid('dupes-back').click();
    expect(sw.state.dupesView).toBe(false);
    expect(tid('acts').hidden).toBe(true);
  });

  it('no merge button while only this window is shown (Settings: all windows off)', async () => {
    await boot({ tabs: ABC(), beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/' }); } });
    expect(tid('merge-btn').hidden).toBe(true);
    expect(tid('merge-text').textContent).toMatch(/1/);
  });

  it('with all windows on, the merge button shows only while the window list does not', async () => {
    const sw = await boot({ tabs: ABC(), prefs: { allWindows: true }, beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/' }); } });
    expect(tid('merge-btn').hidden).toBe(true);
    sw.state.windows = sw.state.windows.slice(0, 1); // (say its tabs are all Tabazing's own pages)
    sw.render();
    expect(tid('merge-btn').hidden).toBe(false);
  });

  it('"Capture all" is a small camera with the count', async () => {
    await boot({ tabs: ABC() });
    expect(tid('sweep-btn').classList.contains('compact')).toBe(true);
    expect(tid('sweep-text').textContent).toBe('2');
  });
});

describe('sort', () => {
  const tabs = () => [{ title: 'Mike', url: 'https://m.example/' }, { title: 'alpha', url: 'https://a.example/' }, { title: 'Zulu', url: 'https://z.example/' }];

  it('setSort orders the cards, remembers it, and goes back to the top', async () => {
    await chrome.storage.session.set({ mru: [1, 3, 2] });
    const sw = await boot({ tabs: tabs() });
    expect(titles()).toEqual(['Mike', 'Zulu', 'alpha']); // recent use
    sw.setSort('name');
    expect(titles()).toEqual(['alpha', 'Mike', 'Zulu']);
    sw.setSort('order');
    expect(titles()).toEqual(['Mike', 'alpha', 'Zulu']);
    await tick(5);
    expect((await chrome.storage.local.get('view')).view.sort).toBe('order');
    expect(tid('select-label', tid('select-sort')).textContent).toBe('By order');
  });

  it('keeps the selected tab selected', async () => {
    const sw = await boot({ tabs: tabs(), ctx: { dir: 0 } });
    sw.selectKey('t3');
    sw.setSort('name');
    expect(selectedTitle()).toBe('Zulu');
  });

  it('the themed select: shows the choice, opens a menu with it ticked, and picking one sorts', async () => {
    const sw = await boot({ tabs: tabs() });
    const fs = tid('select-sort');
    expect(tid('select-label', fs).textContent).toBe('By recently used');
    expect(tid('sort').classList.contains('fs-native')).toBe(true);
    expect(sw.fancySelect(tid('sort'))).toBe(tid('sort')._fancy); // made once only
    fs.click();
    const items = tids('menu-item');
    expect(items.map((x) => x.textContent)).toEqual(['By order', 'By recently used', 'By name']);
    expect(items[1].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(items[1]);
    items[2].click();
    await tick(0);
    expect(sw.state.sort).toBe('name');
    expect(tid('menu')).toBe(null);
    expect(tid('select-label', fs).textContent).toBe('By name');
  });
});

describe('selection', () => {
  it('select wraps around and marks the card and its list', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.select(-1);
    expect(sw.state.sel).toBe(2);
    expect(selectedTitle()).toBe('Charlie');
    expect(tid('section-grid').getAttribute('aria-activedescendant')).toBe('opt-t3'); // the section's list
    expect(tid('search').getAttribute('aria-activedescendant')).toBe('opt-t3'); // the combobox, which has the focus
    sw.select(4);
    expect(selectedTitle()).toBe('Bravo');
    expect(cards().filter((c) => c.getAttribute('aria-selected') === 'true').length).toBe(1);
  });

  it('refresh keeps the selected tab by key when the list changes', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.selectKey('t3');
    sw.state.tabs.unshift({ ...sw.state.tabs[0], id: 99, title: 'New', url: 'https://new.example/' });
    sw.refresh();
    expect(titles()[0]).toBe('New');
    expect(selectedTitle()).toBe('Charlie');
    sw.refresh({ keepKey: 'gone' });
    expect(sw.state.sel).toBe(0);
  });

  it('cycle: next / previous open tab in screen order, wrapping', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    sw.cycle(1);
    expect(selectedTitle()).toBe('Bravo');
    sw.cycle(1);
    sw.cycle(1);
    expect(selectedTitle()).toBe('Alpha');
    sw.cycle(-1);
    expect(selectedTitle()).toBe('Charlie');
  });

  it('cycle from a closed card starts at the current tab', async () => {
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000), tab: { sessionId: 'x', url: 'https://gone.example/', title: 'Gone' } }];
    const sw = await boot({ tabs: ABC() });
    sw.select(sw.state.entries.length - 1);
    expect(sw.state.entries[sw.state.sel].kind).toBe('closed');
    sw.cycle(1);
    expect(selectedTitle()).toBe('Bravo');
  });

  it('selectKey opens a collapsed section for this visit', async () => {
    const sw = await boot({ tabs: [{ title: 'Doc', url: 'https://doc.example/' }, { title: 'Doc 2', url: 'https://doc.example/' }] });
    sw.dupesView(true);
    sw.toggleSection('d:https://doc.example/');
    expect(openCards().length).toBe(0);
    sw.selectKey('t2');
    expect(sw.state.peek.has('d:https://doc.example/')).toBe(true);
    expect(selectedTitle()).toBe('Doc 2');
    expect(sw.state.collapsed.has('d:https://doc.example/')).toBe(true); // still collapsed next time
  });

  it('selectKey of an unknown key does nothing', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    sw.selectKey('t42');
    expect(sw.state.sel).toBe(0);
  });

  describe('moveSpatial / cardToward on a 3-column grid', () => {
    // Cards laid out at 100 px steps: row 0 = 0,1,2; row 1 = 3,4,5; row 2 = 6.
    const layout = () => openCards().forEach((c, i) => {
      const x = (i % 3) * 100, y = Math.floor(i / 3) * 100;
      c.getBoundingClientRect = () => ({ left: x, top: y, width: 90, height: 90, right: x + 90, bottom: y + 90 });
    });

    it('down / up go to the nearest card in the next row, closest across', async () => {
      const sw = await boot({ tabs: many(7), ctx: { dir: 0 } });
      layout();
      sw.select(1);
      sw.moveSpatial(0, 1);
      expect(sw.state.sel).toBe(4);
      sw.moveSpatial(0, -1);
      expect(sw.state.sel).toBe(1);
      sw.select(5);
      sw.moveSpatial(0, 1); // the last row has only the first column
      expect(sw.state.sel).toBe(6);
      sw.moveSpatial(0, 1); // nothing below: stays
      expect(sw.state.sel).toBe(6);
    });

    it('left / right step one card, wrapping', async () => {
      const sw = await boot({ tabs: many(7), ctx: { dir: 0 } });
      sw.moveSpatial(-1, 0);
      expect(sw.state.sel).toBe(6);
      sw.moveSpatial(1, 0);
      expect(sw.state.sel).toBe(0);
    });

    it('cardToward returns -1 when nothing lies that way', async () => {
      const sw = await boot({ tabs: many(3) });
      layout();
      expect(sw.cardToward(openCards(), 0, -1)).toBe(-1);
      expect(sw.cardToward(openCards(), 0, 1)).toBe(-1);
    });
  });
});

describe('renderCount / renderActs', () => {
  it('the count: tabs shown, or what the search found', async () => {
    const sw = await boot({ tabs: ABC() });
    const count = tid('count');
    expect(count.textContent).toBe('3 tabs');
    sw.state.query = 'bravo';
    sw.deriveSearch();
    sw.renderCount();
    expect(count.textContent).toMatch(/1/);
    expect(count.textContent).not.toBe('3 tabs');
  });

  it('the actions bar: hidden with nothing ticked or searched', async () => {
    await boot({ tabs: ABC() });
    expect(tid('acts').hidden).toBe(true);
  });

  it('ticked tabs: how many, Clear, and the action buttons (Close closes at once: Undo brings them back)', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.state.picked.add(2).add(3);
    sw.refresh();
    expect(tid('acts').hidden).toBe(false);
    expect(tid('acts-n').textContent).toMatch(/2/);
    expect(tid('sel-none').hidden).toBe(false);
    expect([...tid('acts-btns').children].map((b) => b.dataset.testid)).toEqual(['action-close', 'action-copy', 'actions-more']);
    tid('action-close').click();
    await waitFor(() => chrome.tabs.remove.mock.calls.length);
    expect(chrome.tabs.remove).toHaveBeenCalledWith([2, 3]);
  });

  it('"More" opens a menu of the other actions', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.state.picked.add(2);
    sw.refresh();
    tid('actions-more').click();
    expect(tids('menu-item').length).toBe(sw.ACTIONS.filter((a) => a.more).length);
  });

  it('searching with several matches offers "Select all N"', async () => {
    const sw = await boot({ tabs: [...ABC(), { title: 'Alpha two', url: 'https://alpha2.example/' }] });
    sw.state.query = 'alpha';
    sw.refresh();
    expect(tid('acts').hidden).toBe(false);
    const all = tid('sel-all');
    expect(all.hidden).toBe(false);
    expect(all.textContent).toMatch(/2/);
    expect(all.className).toBe('lnk'); // a secondary link, not the bar's main button
    expect(tid('acts-btns').hidden).toBe(true);
    all.click();
    expect([...sw.state.picked].sort()).toEqual([1, 4]);
    expect(all.hidden).toBe(true); // all ticked already
  });
});

describe('toast', () => {
  it('shows text, and hides after a while', async () => {
    const sw = await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      sw.toast('Hello');
      expect(tid('toast').hidden).toBe(false);
      expect(tid('toast').textContent).toBe('Hello');
      vi.advanceTimersByTime(2500);
      expect(tid('toast').hidden).toBe(false);
      vi.advanceTimersByTime(200);
      expect(tid('toast').hidden).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('waits while hovered or focused (so Undo stays reachable), then hides', async () => {
    const sw = await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      sw.toast('Closed 1 tab', null, { label: 'Undo', fn: () => {} });
      tid('toast').dispatchEvent(new MouseEvent('mouseenter'));
      vi.advanceTimersByTime(20000);
      expect(tid('toast').hidden).toBe(false);
      tid('toast').dispatchEvent(new MouseEvent('mouseleave'));
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(6000);
      expect(tid('toast').hidden).toBe(true);
      sw.toast('Closed 2 tabs', null, { label: 'Undo', fn: () => {} });
      tid('toast').dispatchEvent(new FocusEvent('focusin'));
      vi.advanceTimersByTime(20000);
      expect(tid('toast').hidden).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('sits above the actions bar while that shows (never over it)', async () => {
    const sw = await boot({ tabs: ABC() });
    sw.toast('Hello');
    expect(tid('toast').style.bottom).toBe('20px');
    expect(tid('toast').classList.contains('lifted')).toBe(false);
    sw.pick(sw.state.entries[1]);
    expect(tid('acts').hidden).toBe(false);
    expect(parseFloat(tid('toast').style.bottom)).toBeGreaterThan(20);
    expect(tid('toast').classList.contains('lifted')).toBe(true);
  });

  it('with an action: a button that runs it and hides the note', async () => {
    const sw = await boot();
    const fn = vi.fn();
    sw.toast('Closed 1 tab', null, { label: 'Undo', fn });
    const b = tid('toast-action');
    expect(b.textContent).toBe('Undo');
    b.click();
    expect(fn).toHaveBeenCalledOnce();
    expect(tid('toast').hidden).toBe(true);
  });
});

describe('small pieces', () => {
  it('no opening animation: the switcher and the cards show at once (and the palette too)', async () => {
    await boot();
    expect(document.documentElement.classList.contains('intro')).toBe(false);
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8').replace(/\r\n/g, '\n');
    expect(css).not.toMatch(/html\.intro|\.intro \.card/);
    const i = css.indexOf('\n.palette {');
    expect(css.slice(i, css.indexOf('}', i))).not.toMatch(/animation/);
  });

  it('applyTheme: light, dark, and anything else follows the system', async () => {
    const sw = await boot();
    const html = document.documentElement;
    sw.applyTheme('light');
    expect(html.classList.contains('light')).toBe(true);
    sw.applyTheme('dark');
    expect(html.classList.contains('light')).toBe(false);
    sw.applyTheme('purple');
    expect(sw.themePref).toBe('system');
    expect(html.classList.contains('light')).toBe(false); // the fake OS prefers dark
    sw.applyTheme('system');
    expect(html.classList.contains('light')).toBe(false);
  });

  it('with no theme saved, it follows the system', async () => {
    const sw = await boot({ beforeImport: () => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} })) });
    expect(sw.themePref).toBe('system');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    sw.applyTheme('dark');
  });

  it('applyTheme: "system" follows a light OS', async () => {
    const sw = await boot({ beforeImport: () => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} })) });
    sw.applyTheme('system');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    sw.applyTheme('dark');
  });

  it('the theme saved in Settings is applied at boot', async () => {
    await boot({ prefs: { theme: 'light' } });
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('layoutHeader: below 1100 px the player moves under the search box (.narrow), below 900 px icons only (.tight)', async () => {
    const sw = await boot();
    const bar = tid('header');
    sw.layoutHeader(1400);
    expect([bar.classList.contains('narrow'), bar.classList.contains('tight')]).toEqual([false, false]);
    sw.layoutHeader(1000);
    expect([bar.classList.contains('narrow'), bar.classList.contains('tight')]).toEqual([true, false]);
    sw.layoutHeader(800);
    expect([bar.classList.contains('narrow'), bar.classList.contains('tight')]).toEqual([true, true]);
    // a resize lays it out again, and the card area follows the header's new height
    Object.defineProperty(window, 'innerWidth', { value: 1500, configurable: true });
    Object.defineProperty(bar, 'offsetHeight', { value: 108, configurable: true });
    sw.render();
    expect(bar.classList.contains('narrow')).toBe(false);
    expect(tid('body').style.getPropertyValue('--top')).toBe('108px');
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  });

  it('the header has no shortcut row any more: an ⓘ button instead', async () => {
    await boot();
    expect(tid('hint')).toBe(null);
    expect(tid('keys-btn').getAttribute('aria-label')).toBe('Keyboard and mouse shortcuts');
    expect(tid('keys-btn').getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('a GitHub button, last, just right of ⓘ, opens the repository in a new tab beside the page and closes Tabazing', async () => {
    const sw = await boot();
    const gh = tid('github-btn');
    expect(gh.previousElementSibling).toBe(tid('keys-btn'));
    expect(gh.nextElementSibling).toBe(null); // the header's last: the one link out of Tabazing
    expect(gh.getAttribute('aria-label')).toBe('Tabazing on GitHub');
    expect(gh.title).toBe('Tabazing on GitHub');
    gh.click();
    await waitFor(() => chrome.tabs.create.mock.calls.length > 0);
    expect(chrome.tabs.create.mock.calls[0][0]).toMatchObject({ url: 'https://github.com/maxiikk/tabazing', active: true });
  });

  it('the light theme draws rings and outlines with the darkened accent (--ring), for 3:1 on a light ground', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8');
    expect(css).toMatch(/html\.light \{[^}]*--ring: var\(--accent-ink\)/);
    expect(css).toMatch(/:root \{[^}]*--md-primary: var\(--accent\);[^}]*--ring: var\(--md-primary\)/); // dark: the accent itself (the scheme's primary)
    expect(css).toMatch(/html\.light \{[^}]*--md-primary: var\(--accent-ink\)/);
    expect(css).toMatch(/^:focus-visible \{ outline: 3px solid var\(--focus\); outline-offset: 2px; \}/m); // MUI's halo: the accent, translucent
    expect(css).toMatch(/:root \{[^}]*--focus: color-mix\(in srgb, var\(--accent\) 50%, transparent\)/);
    expect(css).toMatch(/\.card\[aria-selected="true"\] \{[^}]*box-shadow: 0 0 0 2px var\(--ring\)/);
    expect(css).toMatch(/\.tour-hl \{ outline: 3px solid var\(--ring\)/);
  });

  it('setTop: the card area starts under the header, the toolbar and a shown alert', async () => {
    const sw = await boot();
    const def = (n, v) => Object.defineProperty(n, 'offsetHeight', { value: v, configurable: true });
    def(tid('header'), 50); def(tid('tools'), 30); def(tid('alert'), 20);
    sw.setTop();
    expect(tid('body').style.getPropertyValue('--top')).toBe('80px');
    tid('alert').hidden = false;
    sw.setTop();
    expect(tid('body').style.getPropertyValue('--top')).toBe('104px');
  });

  it('tipTruncated: text cut short gets a tooltip, which goes when it fits again', async () => {
    const sw = await boot();
    const label = tids('window-label')[0] || document.body.appendChild(Object.assign(document.createElement('span'), { className: 'wlabel', textContent: 'A long window name' }));
    Object.defineProperty(label, 'clientWidth', { value: 20, configurable: true });
    Object.defineProperty(label, 'scrollWidth', { value: 60, configurable: true });
    sw.tipTruncated();
    expect(label.title).toBe(label.textContent);
    Object.defineProperty(label, 'scrollWidth', { value: 20, configurable: true });
    sw.tipTruncated();
    expect(label.hasAttribute('title')).toBe(false);
  });

  it('noteTip / hideTip: a note button shows its note shortly after hover', async () => {
    const sw = await boot({ tabs: ABC() });
    const b = document.createElement('button');
    document.body.append(b);
    b.dataset.note = 'remember this';
    sw.noteTip(b);
    expect(tid('note-tooltip')).toBe(null);
    await waitFor(() => tid('note-tooltip'));
    expect(tid('note-tooltip-text').textContent).toBe('remember this');
    sw.hideTip();
    expect(tid('note-tooltip')).toBe(null);
    sw.noteTip(b);
    sw.hideTip(); // before it shows: cancelled
    await tick(200);
    expect(tid('note-tooltip')).toBe(null);
    b.dataset.note = '';
    sw.noteTip(b);
    await tick(200);
    expect(tid('note-tooltip')).toBe(null);
    b.remove();
  });
});

describe('menu / closePops', () => {
  const setup = async () => {
    const sw = await boot();
    const anchor = document.createElement('button');
    tid('app').append(anchor);
    const fns = [vi.fn(), vi.fn(), vi.fn()];
    const items = [{ label: 'One', fn: fns[0] }, null, { label: 'Two', fn: fns[1] }, { label: 'Three', fn: fns[2], danger: true, sure: 'Sure?' }];
    return { sw, anchor, fns, items };
  };

  it('lists the items (null is a divider) and focuses the first', async () => {
    const { sw, anchor, items } = await setup();
    sw.menu(anchor, items);
    const m = tid('menu');
    expect(m.getAttribute('role')).toBe('menu');
    expect(tids('menu-item', m).map((x) => x.textContent)).toEqual(['One', 'Two', 'Three']);
    expect(tids('menu-separator', m).length).toBe(1);
    expect(tids('menu-item', m).filter((x) => x.classList.contains('danger')).map((x) => x.textContent)).toEqual(['Three']);
    expect(document.activeElement.textContent).toBe('One');
  });

  it('a click runs the item at once and closes the menu', async () => {
    const { sw, anchor, fns, items } = await setup();
    sw.menu(anchor, items);
    const [, , three] = tids('menu-item');
    three.click();
    expect(fns[2]).toHaveBeenCalledOnce();
    expect(tid('menu')).toBe(null);
  });

  it('its own button again closes it, and does not reopen', async () => {
    const { sw, anchor, items } = await setup();
    anchor.addEventListener('click', () => sw.menu(anchor, items));
    anchor.click();
    expect(tids('menu').length).toBe(1);
    await tick(5); // the outside-press listener is armed
    anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(tids('menu').length).toBe(1); // a press on its button is not "outside"
    anchor.click();
    expect(tids('menu').length).toBe(0);
    anchor.click(); // a third click opens it again
    expect(tids('menu').length).toBe(1);
  });

  it('a press outside closes it', async () => {
    const { sw, anchor, items } = await setup();
    sw.menu(anchor, items);
    await tick(5);
    tid('menu-item').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(tid('menu')).not.toBe(null); // inside: stays
    tid('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(tid('menu')).toBe(null);
  });

  it('arrow keys, Home and End move the focus; Esc closes and goes back to the button', async () => {
    const { sw, anchor, items } = await setup();
    sw.menu(anchor, items);
    const m = tid('menu');
    const press = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    press('ArrowDown');
    expect(document.activeElement.textContent).toBe('Two');
    press('ArrowUp');
    press('ArrowUp'); // wraps
    expect(document.activeElement.textContent).toBe('Three');
    press('Home');
    expect(document.activeElement.textContent).toBe('One');
    press('End');
    expect(document.activeElement.textContent).toBe('Three');
    press('Escape');
    expect(m.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(sw.state.done).toBe(false); // Esc in the menu does not close the switcher
  });

  it('an item marked on is ticked and focused first', async () => {
    const { sw, anchor } = await setup();
    sw.menu(anchor, [{ label: 'A', on: false, fn() {} }, { label: 'B', on: true, fn() {} }]);
    const [a, b] = tids('menu-item');
    expect(a.getAttribute('role')).toBe('menuitemradio');
    expect(b.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(b);
  });

  it('closePops closes menus and cards, saving a card through its close()', async () => {
    const { sw, anchor, items } = await setup();
    sw.menu(anchor, items);
    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.close = vi.fn(() => pop.remove());
    tid('app').append(pop);
    sw.closePops();
    expect(tid('menu')).toBe(null);
    expect(pop.close).toHaveBeenCalledOnce();
  });
});

describe('"Show more" under Recently closed', () => {
  it('is a text button: the primary colour on nothing, a state layer of it when pointed at or focused', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8').replace(/\r\n/g, '\n');
    const rule = (sel) => { const i = css.indexOf(sel + ' {'); return i < 0 ? '' : css.slice(i + sel.length + 2, css.indexOf('}', i)); };
    const rest = rule('#closed-more');
    expect(rest).toMatch(/background:\s*transparent/);
    expect(rest).toMatch(/text-decoration:\s*none/);
    const hover = rule('#closed-more:hover, #closed-more:focus-visible');
    expect(rest).toMatch(/color:\s*var\(--md-primary\)/);
    expect(hover).toMatch(/background:\s*color-mix\(in srgb, var\(--md-primary\) 8%, transparent\)/);
  });
});

describe('the Material look (styles/switcher.css)', () => {
  it('Roboto is bundled (extension pages load nothing from the web), in every alphabet the dictionaries use', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8');
    for (const f of ['roboto-latin-wght-normal.woff2', 'roboto-latin-ext-wght-normal.woff2', 'roboto-cyrillic-wght-normal.woff2']) {
      expect(css).toContain(`url(fonts/${f})`);
      expect(existsSync('styles/fonts/' + f), f).toBe(true);
    }
    expect(existsSync('styles/fonts/OFL.txt')).toBe(true); // its licence goes with it
    expect(css).toMatch(/html, body \{[^}]*font: 400 14px\/1\.43 'Roboto'/);
  });

  it('no press ripple (today\'s Material UI draws none): a press shows only its state colour', async () => {
    const { readFileSync } = await import('node:fs');
    await boot({ tabs: ABC() });
    const b = tid('settings-btn');
    b.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 30 }));
    expect(tid('ripple')).toBe(null);
    expect(readFileSync('styles/switcher.css', 'utf8')).not.toMatch(/\.rip\b/);
  });

  it('menus, the search\'s results and the small cards drop down (revealed from the top edge), or up (.up), not grow', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8');
    expect(css).toMatch(/\.menu \{[^}]*animation: drop \.2s/);
    expect(css).toMatch(/\.menu\.up \{ animation-name: drop-up; \}/);
    expect(css).toMatch(/\.pop \{[^}]*animation: drop \.2s/);
    expect(css).toMatch(/\.pop\.up \{ animation-name: drop-up; \}/);
    expect(css).toMatch(/\.dd \{[^}]*animation: drop \.2s/);
    expect(css).toMatch(/@keyframes drop \{ from \{[^}]*clip-path: inset\(-24px -24px 100% -24px\)/);
    expect(css).not.toMatch(/scaleY/);
  });
});
