// Drawing the switcher: cards, sections, the toolbar, the window list, selection, and the small UI pieces.
import { describe, it, expect, vi } from 'vitest';
import { tick, waitFor } from '../helpers/switcher.js';
import { boot, ABC, cards, openCards, titles, titleOf, selectedTitle, byTestId, allByTestId } from '../helpers/switcher-ui.js';
import { translate } from '../../utils/translations.js';

const IMAGE = 'data:image/jpeg;base64,AAAA';
const preview = (url) => ({ ['pv:' + url]: { img: IMAGE, t: Date.now() } });
const card = (title) => openCards().find((cardElement) => titleOf(cardElement) === title);
const many = (count) => Array.from({ length: count }, (_, i) => ({ title: 'Tab ' + (i + 1), url: `https://t${i + 1}.example/` }));

describe('renderCard: open tabs', () => {
  it('one card per tab: title, id, option role, close and star buttons, a tick box', async () => {
    const switcher = await boot({ tabs: ABC() });
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    const bravoCard = card('Bravo');
    expect(bravoCard.dataset.testid).toBe('card-tab');
    expect(bravoCard.id).toBe('opt-t2');
    expect(bravoCard.getAttribute('role')).toBe('option');
    expect(byTestId('card-close', bravoCard)).not.toBe(null);
    expect(byTestId('card-star-button', bravoCard).getAttribute('aria-pressed')).toBe('false');
    expect(byTestId('card-pick', bravoCard).getAttribute('aria-checked')).toBe('false');
    expect(bravoCard.title).toBe('Bravo\nhttps://bravo.example/');
    expect(switcher.state.entries[1].url).toBe('https://bravo.example/');
  });

  it('numbers the first nine cards only', async () => {
    await boot({ tabs: many(11) });
    const numbers = openCards().map((cardElement) => byTestId('card-number', cardElement)?.textContent ?? null);
    expect(numbers).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', null, null]);
  });

  it('pinned tabs come first and carry a pin badge, on the picture', async () => {
    const tabs = ABC();
    tabs[2].pinned = true;
    await boot({ tabs });
    expect(titles()[0]).toBe('Charlie');
    expect(byTestId('card-pinned', byTestId('card-flags', byTestId('card-thumb', card('Charlie'))))).not.toBe(null);
    expect(byTestId('card-pinned', byTestId('card-head', card('Charlie')))).toBe(null);
    expect(byTestId('card-pinned', card('Bravo'))).toBe(null);
  });

  it('Settings -> Pinned tabs first off: pinned tabs stay in the chosen sort', async () => {
    const tabs = ABC();
    tabs[2].pinned = true;
    await boot({ tabs, preferences: { pinnedFirst: false } });
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('the tags (days ago, window, back from snooze) sit on the picture, top left; the site name only shows without them', async () => {
    const old = Date.now() - 3 * 86400e3;
    const switcher = await boot({
      tabs: [ABC()[0], { ...ABC()[1], lastAccessed: old }, ABC()[2]],
      beforeImport: () => chrome.storage.session.set({ woken: { 3: Date.now() - 1000 } }),
    });
    const flags = byTestId('card-flags', byTestId('card-thumb', card('Bravo')));
    expect(byTestId('card-age', flags).textContent).toBe('3 days ago');
    expect(byTestId('card-age', byTestId('card-head', card('Bravo')))).toBe(null);
    expect(byTestId('card-woken', byTestId('card-thumb', card('Charlie'))).textContent).toBe('Back from snooze');
    expect(byTestId('card-woken', card('Alpha'))).toBe(null);
    expect(byTestId('card-flags', card('Alpha'))).toBe(null); // no tags: no empty pill
    switcher.state.cardWidth = 320;
    switcher.redraw(() => true);
    expect(byTestId('card-host', card('Bravo'))).toBe(null); // tags shown: no site name
    expect(byTestId('card-host', card('Alpha')).textContent).toBe('alpha.example');
  });

  it('Settings -> Show "days ago" tags off: no age tag', async () => {
    await boot({ tabs: [ABC()[0], { ...ABC()[1], lastAccessed: Date.now() - 5 * 86400e3 }], preferences: { showAge: false } });
    expect(byTestId('card-age', card('Bravo'))).toBe(null);
  });

  it('list size: the tags stay in the row, compact', async () => {
    await boot({ tabs: [ABC()[0], { ...ABC()[1], pinned: true }], preferences: { cardSize: 'list' } });
    expect(byTestId('card-pinned', byTestId('card-flags', byTestId('card-head', card('Bravo'))))).not.toBe(null);
  });

  it('a card\'s buttons show only while the pointer is on the card, not on the selected card (styles/switcher.css)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8');
    // the keyboard can't reach them (it has the card's menu and the keys): no selected-card rule shows any of them
    expect(css).not.toMatch(/\.card\[aria-selected="true"\] (\.head:has\(\.head-buttons|\.star|\.x\b|\.quick-button|\.snap|\.flags)/);
    expect(css).not.toMatch(/\.grid\.list \.card\[aria-selected="true"\] \.quick-button/);
    expect(css).toMatch(/\.card:hover \.star, \.card:hover \.close-button \{ opacity: 1; \}/);
    expect(css).toMatch(/\.card:hover \.quick-button, \.quick-button:focus-visible, \.quick-button\.note\.on \{ opacity: 1; \}/); // a note's button stays: it says there is one
    expect(css).toMatch(/\.star\.on \{ opacity: 1;/); // so does a starred page's star
  });

  it('while Alt is held (no search field), the header\'s two button groups still sit at its two ends (styles/switcher.css)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8');
    expect(css).toMatch(/html\.alttab \.search, html\.alttab \.quick-button\.note \{ display: none !important; \}/);
    expect(css).toMatch(/html\.alttab #keys-button \{ margin-inline-start: auto; \}/); // the wide header: it takes the free room
    expect(css).toMatch(/html\.alttab \.bar\.narrow #keys-button \{ grid-column: 4; \}/); // narrow: the search's column stays, empty
    await boot({ tabs: ABC() });
    const head = [...byTestId('header').children].filter((child) => child.tagName === 'BUTTON').map((button) => button.dataset.testid);
    expect(head).toEqual(['menu-button', 'new-tab', 'keys-button', 'github-button']); // keys-button starts the end group
  });

  it('the star and × sit in one box over the end of the header (they take no room while hidden)', async () => {
    await boot({ tabs: ABC() });
    const box = byTestId('card-head-buttons', card('Bravo'));
    expect(box.parentElement).toBe(byTestId('card-head', card('Bravo')));
    expect([...box.children].map((button) => button.dataset.testid)).toEqual(['card-star-button', 'card-close']);
    expect(box.classList.contains('two')).toBe(true);
  });

  it('two title lines by default (html.lines2); Settings -> Title lines: one', async () => {
    let switcher = await boot({ tabs: ABC() });
    expect(document.documentElement.classList.contains('lines2')).toBe(true);
    switcher = await boot({ tabs: ABC(), preferences: { titleLines: 1 } });
    expect(document.documentElement.classList.contains('lines2')).toBe(false);
    expect(switcher.state.preferences.titleLines).toBe(1);
  });

  it('audio badge: speaker while playing, crossed out while muted', async () => {
    const tabs = ABC();
    tabs[1].audible = true;
    tabs[2].mutedInfo = { muted: true };
    await boot({ tabs });
    expect(byTestId('card-audio', card('Bravo')).classList.contains('on')).toBe(true);
    expect(byTestId('card-audio', card('Charlie')).classList.contains('on')).toBe(false);
    expect(byTestId('card-audio', card('Alpha'))).toBe(null);
  });

  it('a starred page has its star on', async () => {
    await chrome.storage.local.set({ stars: { 'https://bravo.example/': { u: 'https://bravo.example/', ti: 'Bravo', t: Date.now() } } });
    await boot({ tabs: ABC() });
    const starButton = byTestId('card-star-button', card('Bravo'));
    expect(starButton.classList.contains('on')).toBe(true);
    expect(starButton.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the stored preview, else a placeholder with "Capture preview"', async () => {
    await chrome.storage.local.set(preview('https://bravo.example/'));
    await boot({ tabs: ABC() });
    expect(byTestId('card-preview', card('Bravo')).src).toBe(IMAGE);
    expect(byTestId('card-no-preview', card('Bravo'))).toBe(null);
    const placeholder = byTestId('card-no-preview', card('Charlie'));
    expect(byTestId('card-no-preview-subtitle', placeholder).textContent).toBe('charlie.example');
    expect(byTestId('card-capture', placeholder)).not.toBe(null);
  });

  it('no "Capture preview" on pages Chrome will not screenshot', async () => {
    await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'Ext', url: 'chrome://extensions/' }] });
    expect(byTestId('card-no-preview', card('Ext'))).not.toBe(null);
    expect(byTestId('card-capture', card('Ext'))).toBe(null);
  });

  it('sleeping: only a tab Chrome discarded while we watched', async () => {
    const tabs = ABC();
    tabs[1].discarded = true; // seen being discarded
    tabs[2].discarded = true; // restored lazily after a restart: not sleeping
    await chrome.storage.session.set({ slept: [2] });
    await boot({ tabs });
    expect(card('Bravo').classList.contains('asleep')).toBe(true);
    expect(byTestId('card-no-preview-label', card('Bravo')).textContent).toBe('Asleep');
    expect(card('Charlie').classList.contains('asleep')).toBe(false);
  });

  it('marked to sleep on close: asleep look before it happens', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.state.toSleep.add(3);
    switcher.refresh();
    expect(card('Charlie').classList.contains('asleep')).toBe(true);
  });

  it('list size: one line per tab, no picture, quick buttons in the header', async () => {
    await boot({ tabs: ABC(), preferences: { cardSize: 'list' } });
    const bravoCard = card('Bravo');
    expect(byTestId('card-thumb', bravoCard)).toBe(null);
    expect(byTestId('card-quick-actions', byTestId('card-head', bravoCard))).not.toBe(null);
    expect(byTestId('section-grid').classList.contains('list')).toBe(true);
  });

  it('a ticked tab looks picked', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.state.picked.add(2);
    switcher.refresh();
    expect(card('Bravo').classList.contains('picked')).toBe(true);
    expect(byTestId('card-pick', card('Bravo')).getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.classList.contains('picking')).toBe(true);
  });
});

describe('renderCard: closed, snoozed and starred cards', () => {
  it('recently closed: a card under "Recently closed" with how long ago', async () => {
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 120, tab: { sessionId: 'x1', url: 'https://gone.example/', title: 'Gone' } }];
    const switcher = await boot({ tabs: ABC() });
    const [closedCard] = cards(byTestId('closed-grid'));
    expect(closedCard.dataset.testid).toBe('card-closed');
    expect(titleOf(closedCard)).toBe('Gone');
    expect(byTestId('card-closed-ago', closedCard).textContent).toMatch(/2/);
    expect(byTestId('card-number', closedCard)).toBe(null);
    expect(byTestId('closed-section').hidden).toBe(false);
    expect(byTestId('closed-heading').textContent).toBe('Recently closed');
    expect(switcher.state.entries.at(-1).kind).toBe('closed');
  });

  it('snoozed: its own section, when it wakes, × cancels the snooze', async () => {
    const at = Date.now() + 3600e3;
    await chrome.storage.local.set({ snoozed: [{ id: 'z1', url: 'https://later.example/', title: 'Later', at, windowId: 1, pinned: false, t: Date.now() }] });
    const switcher = await boot({ tabs: ABC() });
    expect(byTestId('snoozed-section').hidden).toBe(false);
    const [snoozedCard] = cards(byTestId('snoozed-grid'));
    expect(snoozedCard.dataset.testid).toBe('card-snoozed');
    expect(byTestId('card-wakes', snoozedCard)).not.toBe(null);
    byTestId('card-cancel-snooze', snoozedCard).click();
    await waitFor(() => !cards(byTestId('snoozed-grid')).length);
    expect(await chrome.storage.local.get('snoozed')).toEqual({ snoozed: [] });
    expect(switcher.state.snoozed).toEqual([]);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('starred, not open: shown under the Starred filter, opens in a new tab', async () => {
    await chrome.storage.local.set({ stars: { 'https://far.example/': { u: 'https://far.example/', ti: 'Far', t: Date.now() } } });
    const switcher = await boot({ tabs: ABC() });
    switcher.toggleStarFilter();
    expect(openCards().length).toBe(0);
    expect(byTestId('open-empty').hidden).toBe(false);
    expect(byTestId('closed-heading').textContent).not.toBe('Recently closed');
    const [starCard] = cards(byTestId('closed-grid'));
    expect(starCard.dataset.testid).toBe('card-star');
    expect(titleOf(starCard)).toBe('Far');
    expect(byTestId('card-star-button', starCard).classList.contains('on')).toBe(true);
    starCard.click();
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://far.example/', windowId: 1, active: true });
  });

  it('middle-click: a recently closed card leaves the list, a snoozed one its snooze, a starred one opens behind', async () => {
    const middle = (cardElement) => {
      const mouseDownEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
      cardElement.dispatchEvent(mouseDownEvent);
      expect(mouseDownEvent.defaultPrevented).toBe(true); // no auto-scroll
      cardElement.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    };
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 120, tab: { sessionId: 'x1', url: 'https://gone.example/', title: 'Gone' } }];
    await chrome.storage.local.set({ snoozed: [{ id: 'z1', url: 'https://later.example/', title: 'Later', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() }] });
    const switcher = await boot({ tabs: ABC() });
    middle(cards(byTestId('closed-grid'))[0]);
    await waitFor(() => !cards(byTestId('closed-grid')).length);
    expect(byTestId('toast').firstChild.textContent).toBe(translate('closedRemoved'));
    middle(cards(byTestId('snoozed-grid'))[0]);
    await waitFor(() => !cards(byTestId('snoozed-grid')).length);
    expect(switcher.state.snoozed).toEqual([]);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    await chrome.storage.local.set({ stars: { 'https://far.example/': { u: 'https://far.example/', ti: 'Far', t: Date.now() } } });
    await switcher.reload();
    switcher.toggleStarFilter();
    middle(cards(byTestId('closed-grid'))[0]);
    await waitFor(() => chrome.tabs.create.mock.calls.length);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://far.example/', windowId: 1, active: false });
    expect(switcher.state.done).toBe(false);
  });
});

describe('finishCard: the mouse on a card', () => {
  it('click opens that tab and closes the switcher', async () => {
    const switcher = await boot({ tabs: ABC() });
    card('Charlie').click();
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tabazing:closed', reason: 'switch' }));
    expect(window.close).toHaveBeenCalled();
  });

  it('Shift+click on the preview shows it big', async () => {
    const switcher = await boot({ tabs: ABC() });
    byTestId('card-thumb', card('Bravo')).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(byTestId('big-preview-title').textContent).toBe('Bravo');
    expect(switcher.state.done).toBe(false);
    expect(switcher.state.picked.size).toBe(0);
  });

  it('Ctrl+click (⌘-click) ticks and unticks a card; Shift+click on a tick box ticks the range from the last one', async () => {
    const switcher = await boot({ tabs: ABC() });
    card('Alpha').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect([...switcher.state.picked]).toEqual([1]);
    card('Bravo').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    expect([...switcher.state.picked].sort()).toEqual([1, 2]);
    card('Bravo').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); // untick
    expect([...switcher.state.picked]).toEqual([1]);
    byTestId('card-pick', card('Charlie')).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); // from Bravo (the last one clicked)
    expect([...switcher.state.picked].sort()).toEqual([1, 2, 3]);
    expect(switcher.state.done).toBe(false);
    expect(byTestId('big-preview')).toBe(null);
  });

  it('a plain click switches to the tab even while others are ticked; the bar says how to tick more', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.pick(switcher.state.entries[0]);
    expect(byTestId('actions-hint').hidden).toBe(false);
    expect(byTestId('actions-hint').textContent).toBe('Ctrl+click cards to select more');
    card('Charlie').click();
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
  });

  it('right-click opens the card menu at the pointer, not Chrome’s', async () => {
    await boot({ tabs: ABC(), context: { direction: 0 } });
    const contextMenuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 60 });
    card('Charlie').dispatchEvent(contextMenuEvent);
    expect(contextMenuEvent.defaultPrevented).toBe(true);
    expect(selectedTitle()).toBe('Charlie');
    expect(byTestId('menu')).not.toBe(null);
    expect(byTestId('menu').style.left).toBe('150px');
    const labels = allByTestId('menu-item').map((menuItem) => menuItem.textContent);
    expect(labels).toContain('Close'); // the menu is about this tab: no "this tab" / "tab" in its items
    expect(labels.filter((label) => /\b(this )?tab\b/i.test(label))).toEqual([]);
  });

  it('middle-click closes the tab', async () => {
    const switcher = await boot({ tabs: ABC() });
    const mouseDownEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
    card('Bravo').dispatchEvent(mouseDownEvent);
    expect(mouseDownEvent.defaultPrevented).toBe(true); // no auto-scroll
    card('Bravo').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => !card('Bravo'));
    expect(chrome.tabs.remove).toHaveBeenCalledWith(2);
    expect(switcher.state.done).toBe(false);
  });

  it('hovering a card doesn\'t select it (nor switch to it); a click switches to its tab', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    for (const type of ['mouseover', 'mouseenter', 'mousemove', 'mousemove']) card('Charlie').dispatchEvent(new MouseEvent(type, { bubbles: true }));
    expect(selectedTitle()).toBe('Alpha'); // the selection stays where it was
    expect(card('Charlie').getAttribute('aria-selected')).toBe('false');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    card('Charlie').click();
    await waitFor(() => chrome.tabs.update.mock.calls.some(([id, properties]) => id === switcher.state.tabs.find((x) => x.title === 'Charlie').id && properties.active));
  });

  it('nor in the archive overlay', async () => {
    const switcher = await boot({ tabs: ABC(), beforeImport: () => {
      const archiveFolder = chrome._addBookmark({ parentId: '2', title: 'Tabs Archive' });
      for (const bookmarkTitle of ['One', 'Two']) chrome._addBookmark({ parentId: archiveFolder.id, title: bookmarkTitle, url: `https://${bookmarkTitle.toLowerCase()}.example/` });
    } });
    await switcher.openArchive();
    const cards = allByTestId('card-archived');
    const before = switcher.state.archiveSelected;
    cards[1 - before].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(switcher.state.archiveSelected).toBe(before);
  });

  it('a click on empty space anywhere (the backdrop, between cards, a heading, the toolbar, the window list, the header) does not close it', async () => {
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000) - 60, tab: { sessionId: 'x1', url: 'https://gone.example/', title: 'Gone' } }];
    const switcher = await boot({ tabs: ABC(), preferences: { allWindows: true }, beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/' }); } });
    for (const id of ['section-grid', 'open-grid', 'open-heading', 'closed-heading', 'closed-section', 'open-section', 'tools', 'view-toolbar', 'windows', 'quick-filters',
      'header', 'search-box', 'player', 'open-head', 'open-end', 'open-actions', 'scroller', 'body', 'app']) { // the backdrop and the header's empty space too
      byTestId(id).click();
      expect(switcher.state.done, id).toBe(false);
    }
  });
});

describe('thumbFor / starButton / captureButton', () => {
  it('thumbFor: picture with a pill, or a placeholder with label, site and action', async () => {
    const switcher = await boot();
    const thumbWithPreview = switcher.thumbFor({ url: 'https://a.example/', preview: { img: IMAGE } }, { label: 'Sleeping', icon: switcher.ICON.moon });
    expect(byTestId('card-preview', thumbWithPreview).src).toBe(IMAGE);
    expect(byTestId('card-pill', thumbWithPreview).textContent).toBe('Sleeping');
    const plain = switcher.thumbFor({ url: 'https://a.example/', preview: { img: IMAGE } }, { label: '', icon: '' });
    expect(byTestId('card-pill', plain)).toBe(null);
    const actionButton = document.createElement('button');
    const none = switcher.thumbFor({ url: 'https://a.example/', preview: null }, { label: '', subtitle: 'a.example', icon: switcher.ICON.camera, action: actionButton });
    expect(byTestId('card-no-preview-label', none).textContent).toBe('No preview yet');
    expect(byTestId('card-no-preview-subtitle', none).textContent).toBe('a.example');
    expect(byTestId('card-tile-favicon', none).src).toContain('_favicon');
    expect(none.contains(actionButton)).toBe(true);
  });

  it('starButton: click stars the page, and the card shows it', async () => {
    const switcher = await boot({ tabs: ABC() });
    byTestId('card-star-button', card('Bravo')).click();
    await waitFor(() => byTestId('card-star-button', card('Bravo')).classList.contains('on'));
    const { stars } = await chrome.storage.local.get('stars');
    expect(stars['https://bravo.example/']).toMatchObject({ u: 'https://bravo.example/', ti: 'Bravo' });
    expect(byTestId('star-count').textContent).toBe('1');
    expect(switcher.state.done).toBe(false); // the click did not open the tab
  });

  it('captureButton: says "Capturing…" and is disabled while busy', async () => {
    const switcher = await boot({ tabs: ABC() });
    const entry = switcher.state.entries[1];
    const idle = switcher.captureButton(entry);
    expect(idle.disabled).toBe(false);
    switcher.state.capturing = entry.tab.id;
    const busy = switcher.captureButton(entry);
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).not.toBe(idle.textContent);
  });
});

describe('windows: renderWindows, windowTag, setScope, cycleScope', () => {
  const twoWindows = () => boot({
    tabs: ABC(), preferences: { allWindows: true },
    beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/', active: true }); },
  });

  it('one window: no window list', async () => {
    await boot({ tabs: ABC() });
    expect(byTestId('windows').hidden).toBe(true);
    expect(byTestId('windows').children.length).toBe(0);
  });

  it('several: "Merge all into this window", "All windows", then each window; tabs elsewhere get a window tag', async () => {
    const switcher = await twoWindows();
    expect(byTestId('windows').hidden).toBe(false);
    expect(byTestId('windows').firstChild).toBe(byTestId('windows-merge-all'));
    expect(byTestId('windows-merge-all-label').textContent).toBe('Merge all into this window');
    expect(byTestId('merge-button').hidden).toBe(true); // the window list's own takes over
    expect(byTestId('body').classList.contains('with-windows')).toBe(true);
    expect(allByTestId('window-label').map((x) => x.textContent)).toEqual(['All windows', 'This window', 'Window 2']);
    expect(byTestId('window-all').getAttribute('aria-pressed')).toBe('true');
    expect(allByTestId('window-merge').length).toBe(1); // only on the other window
    expect(byTestId('card-window-tag', card('Delta')).textContent).toBe('Window 2');
    expect(byTestId('card-window-tag', card('Alpha'))).toBe(null);
    expect(switcher.windowTag(switcher.state.tabs.find((x) => x.title === 'Delta')).textContent).toBe('Window 2');
  });

  it('"Merge all into this window" merges at once, with Undo', async () => {
    const switcher = await twoWindows();
    byTestId('windows-merge-all').click();
    await waitFor(() => byTestId('toast-action'));
    expect(chrome.tabs.move).toHaveBeenCalledWith([4], { windowId: 1, index: -1 });
    expect(switcher.state.undo.at(-1).kind).toBe('merge');
  });

  it("a window's own merge button merges just that one, at once", async () => {
    const switcher = await twoWindows();
    byTestId('window-merge').click();
    await waitFor(() => chrome.tabs.move.mock.calls.length);
    expect(chrome.tabs.move).toHaveBeenCalledWith([4], { windowId: 1, index: -1 });
    expect(switcher.state.done).toBe(false);
  });

  it('clicking a window shows only its tabs (no window tags then)', async () => {
    const switcher = await twoWindows();
    allByTestId('window-item')[1].click();
    expect(switcher.state.scope).toBe(2);
    expect(titles()).toEqual(['Delta']);
    expect(byTestId('card-window-tag', card('Delta'))).toBe(null);
    expect(allByTestId('window-item')[1].getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(byTestId('search'));
  });

  it('cycleScope steps All -> this -> Window 2 -> All', async () => {
    const switcher = await twoWindows();
    switcher.cycleScope(1);
    expect(switcher.state.scope).toBe(1);
    switcher.cycleScope(1);
    expect(switcher.state.scope).toBe(2);
    switcher.cycleScope(1);
    expect(switcher.state.scope).toBe('all');
    switcher.cycleScope(-1);
    expect(switcher.state.scope).toBe(2);
    expect(switcher.state.selected).toBe(0);
  });

  it('cycleScope does nothing with one window', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.cycleScope(1);
    expect(switcher.state.scope).toBe('all');
  });
});

describe('renderSection / toggleSection (the duplicates view has headers)', () => {
  const duplicateTabs = () => boot({ tabs: [
    { title: 'Doc', url: 'https://doc.example/' }, { title: 'Doc', url: 'https://doc.example/#x' },
    { title: 'News', url: 'https://news.example/' }, { title: 'News', url: 'https://news.example/' },
    { title: 'Solo', url: 'https://solo.example/' },
  ] });

  it('a plain list has no header', async () => {
    await boot({ tabs: ABC() });
    expect(byTestId('section-toggle')).toBe(null);
    expect(allByTestId('section').length).toBe(1);
  });

  it('one section per duplicated page, each card saying whether it stays or closes', async () => {
    const switcher = await duplicateTabs();
    switcher.duplicatesView(true);
    expect(allByTestId('section-name').map((x) => x.textContent)).toEqual(['Doc', 'News']);
    expect(allByTestId('section-count')[0].textContent).toBe('2');
    expect(allByTestId('card-duplicate-stays').length).toBe(2);
    expect(allByTestId('card-duplicate-closes').length).toBe(2);
    expect(titles()).not.toContain('Solo');
  });

  it('a header click collapses it (remembered), shows favicons as a peek, and opens again', async () => {
    const switcher = await duplicateTabs();
    switcher.duplicatesView(true);
    byTestId('section-toggle').click();
    const section = byTestId('section');
    expect(section.classList.contains('collapsed')).toBe(true);
    expect(byTestId('section-toggle', section).getAttribute('aria-expanded')).toBe('false');
    expect(allByTestId('section-peek-favicon', section).length).toBe(2);
    expect(byTestId('section-grid', section)).toBe(null);
    await tick(5);
    expect((await chrome.storage.local.get('view')).view.collapsed).toEqual(['d:https://doc.example/']);
    switcher.toggleSection('d:https://doc.example/');
    expect(byTestId('section').classList.contains('collapsed')).toBe(false);
  });

  it('renderSection: cards numbered from startIndex', async () => {
    const switcher = await boot({ tabs: ABC() });
    const box = switcher.renderSection({ key: 'k', title: 'T', entries: switcher.state.entries.slice(0, 2), collapsed: false }, 5);
    expect(byTestId('section-name', box).textContent).toBe('T');
    expect(allByTestId('card-number', box).map((x) => x.textContent)).toEqual(['6', '7']);
  });
});

describe('renderTools: filters, Starred, duplicates, merge', () => {
  it('a chip per quick filter some tab matches, with how many; clicking filters the cards', async () => {
    const tabs = ABC();
    tabs[1].pinned = true;
    tabs[2].audible = true;
    const switcher = await boot({ tabs });
    expect([...byTestId('quick-filters').children].map((chip) => chip.dataset.testid)).toEqual(['filter-audio', 'filter-pinned']);
    const pinned = byTestId('filter-pinned');
    expect(byTestId('filter-count', pinned).textContent).toBe('1');
    // only the icon and the count show: the name is the tooltip and, with the count, the accessible name
    expect(pinned.textContent).toBe('1');
    expect(pinned.getAttribute('aria-label')).toBe(translate('chipAria', { name: translate('filterPinned'), count: 1 }));
    expect(pinned.getAttribute('aria-label')).toBe('Pinned: 1');
    expect(pinned.title).toBe('Pinned');
    expect(pinned.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
    pinned.click();
    expect(switcher.state.filter).toBe('pinned');
    expect(titles()).toEqual(['Bravo']);
    expect(byTestId('filter-pinned').getAttribute('aria-pressed')).toBe('true');
    byTestId('filter-pinned').click();
    expect(switcher.state.filter).toBe(null);
    expect(openCards().length).toBe(3);
  });

  it('setFilter selects the first card and scrolls to the top', async () => {
    const tabs = ABC();
    tabs[2].audible = true;
    const switcher = await boot({ tabs, context: { direction: 0 } });
    byTestId('scroller').scrollTop = 50;
    switcher.setFilter('audio');
    expect(titles()).toEqual(['Charlie']);
    expect(switcher.state.selected).toBe(0);
    expect(byTestId('scroller').scrollTop).toBe(0);
  });

  it('the Starred chip shows only its icon and count; its name is the tooltip and, with the count, the accessible name', async () => {
    await chrome.storage.local.set({ stars: { 'https://charlie.example/': { u: 'https://charlie.example/', ti: 'Charlie', t: Date.now() } } });
    await boot({ tabs: ABC() });
    const chip = byTestId('star-filter');
    expect(chip.textContent.trim()).toBe('1');
    expect(chip.getAttribute('aria-label')).toBe('Starred: 1');
    expect(chip.title).toBe('Starred');
  });

  it('Sort and the filter chips sit at the end of the Open tabs row, as a toolbar beside its heading', async () => {
    await boot({ tabs: ABC() });
    const head = byTestId('open-head');
    const toolbar = byTestId('view-toolbar');
    expect(head.contains(byTestId('open-heading'))).toBe(true);
    expect([...head.children]).toEqual([byTestId('open-title'), byTestId('open-end')]); // the title first, then (at the other end) what acts on the open tabs
    expect([...byTestId('open-title').children]).toEqual([byTestId('group-leave'), byTestId('group-dot'), byTestId('open-heading'), byTestId('group-count')]); // (the group view's parts hidden)
    for (const id of ['group-leave', 'group-dot', 'group-count']) expect(byTestId(id).hidden, id).toBe(true);
    expect(toolbar.parentElement).toBe(byTestId('open-end'));
    expect([...byTestId('open-end').children]).toEqual([byTestId('open-actions'), toolbar]); // merge / duplicates, then sort and the chips
    for (const id of ['merge-button', 'duplicates-button']) expect(byTestId('open-actions').contains(byTestId(id)), id).toBe(true);
    expect(byTestId('open-heading').tagName).toBe('H2');
    expect(toolbar.getAttribute('role')).toBe('toolbar');
    expect(toolbar.getAttribute('aria-label')).toBe(translate('viewAria'));
    for (const id of ['sort', 'select-sort', 'star-filter', 'quick-filters']) expect(toolbar.contains(byTestId(id)), id).toBe(true);
    expect(byTestId('tools').contains(toolbar)).toBe(false);
    expect(byTestId('tools').contains(byTestId('setup-actions'))).toBe(true); // "Capture all" stays up there
    expect([...byTestId('setup-actions').children]).toEqual([byTestId('sweep-button')]);
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
    const switcher = await boot({ tabs: ABC() });
    expect(byTestId('star-count').textContent).toBe('1');
    byTestId('star-filter').click();
    expect(switcher.state.starOnly).toBe(true);
    expect(byTestId('star-filter').getAttribute('aria-pressed')).toBe('true');
    expect(titles()).toEqual(['Charlie']);
    switcher.toggleStarFilter();
    expect(openCards().length).toBe(3);
  });

  it('duplicates button only when some page is open twice', async () => {
    await boot({ tabs: ABC() });
    expect(byTestId('duplicates-button').hidden).toBe(true);
  });

  it('duplicates button: count, and a click opens the duplicates view with its bar', async () => {
    const switcher = await boot({ tabs: [...ABC(), { title: 'Alpha again', url: 'https://alpha.example/' }] });
    const duplicatesButton = byTestId('duplicates-button');
    expect(duplicatesButton.hidden).toBe(false);
    expect(byTestId('duplicates-text').textContent).toMatch(/1/);
    duplicatesButton.click();
    expect(switcher.state.duplicatesView).toBe(true);
    expect(duplicatesButton.getAttribute('aria-pressed')).toBe('true');
    expect(byTestId('actions').hidden).toBe(false);
    expect(byTestId('actions').classList.contains('duplicates')).toBe(true);
    expect(byTestId('duplicates-close').disabled).toBe(false);
    byTestId('duplicates-back').click();
    expect(switcher.state.duplicatesView).toBe(false);
    expect(byTestId('actions').hidden).toBe(true);
  });

  it('no merge button while only this window is shown (Settings: all windows off)', async () => {
    await boot({ tabs: ABC(), beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/' }); } });
    expect(byTestId('merge-button').hidden).toBe(true);
    expect(byTestId('merge-text').textContent).toMatch(/1/);
  });

  it('with all windows on, the merge button shows only while the window list does not', async () => {
    const switcher = await boot({ tabs: ABC(), preferences: { allWindows: true }, beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/' }); } });
    expect(byTestId('merge-button').hidden).toBe(true);
    switcher.state.windows = switcher.state.windows.slice(0, 1); // (say its tabs are all Tabazing's own pages)
    switcher.render();
    expect(byTestId('merge-button').hidden).toBe(false);
  });

  it('"Capture all" is a small camera with the count', async () => {
    await boot({ tabs: ABC() });
    expect(byTestId('sweep-button').classList.contains('compact')).toBe(true);
    expect(byTestId('sweep-text').textContent).toBe('2');
  });
});

describe('sort', () => {
  const tabs = () => [{ title: 'Mike', url: 'https://m.example/' }, { title: 'alpha', url: 'https://a.example/' }, { title: 'Zulu', url: 'https://z.example/' }];

  it('setSort orders the cards, remembers it, and goes back to the top', async () => {
    await chrome.storage.session.set({ mru: [1, 3, 2] });
    const switcher = await boot({ tabs: tabs() });
    expect(titles()).toEqual(['Mike', 'Zulu', 'alpha']); // recent use
    switcher.setSort('name');
    expect(titles()).toEqual(['alpha', 'Mike', 'Zulu']);
    switcher.setSort('order');
    expect(titles()).toEqual(['Mike', 'alpha', 'Zulu']);
    await tick(5);
    expect((await chrome.storage.local.get('view')).view.sort).toBe('order');
    expect(byTestId('select-label', byTestId('select-sort')).textContent).toBe('By order');
  });

  it('keeps the selected tab selected', async () => {
    const switcher = await boot({ tabs: tabs(), context: { direction: 0 } });
    switcher.selectKey('t3');
    switcher.setSort('name');
    expect(selectedTitle()).toBe('Zulu');
  });

  it('the themed select: shows the choice, opens a menu with it ticked, and picking one sorts', async () => {
    const switcher = await boot({ tabs: tabs() });
    const fs = byTestId('select-sort');
    expect(byTestId('select-label', fs).textContent).toBe('By recently used');
    expect(byTestId('sort').classList.contains('fancy-select-native')).toBe(true);
    expect(switcher.fancySelect(byTestId('sort'))).toBe(byTestId('sort')._fancy); // made once only
    fs.click();
    const items = allByTestId('menu-item');
    expect(items.map((x) => x.textContent)).toEqual(['By order', 'By recently used', 'By name']);
    expect(items[1].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(items[1]);
    items[2].click();
    await tick(0);
    expect(switcher.state.sort).toBe('name');
    expect(byTestId('menu')).toBe(null);
    expect(byTestId('select-label', fs).textContent).toBe('By name');
  });
});

describe('selection', () => {
  it('select wraps around and marks the card and its list', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.select(-1);
    expect(switcher.state.selected).toBe(2);
    expect(selectedTitle()).toBe('Charlie');
    expect(byTestId('section-grid').getAttribute('aria-activedescendant')).toBe('opt-t3'); // the section's list
    expect(byTestId('search').getAttribute('aria-activedescendant')).toBe('opt-t3'); // the combobox, which has the focus
    switcher.select(4);
    expect(selectedTitle()).toBe('Bravo');
    expect(cards().filter((cardElement) => cardElement.getAttribute('aria-selected') === 'true').length).toBe(1);
  });

  it('refresh keeps the selected tab by key when the list changes', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.selectKey('t3');
    switcher.state.tabs.unshift({ ...switcher.state.tabs[0], id: 99, title: 'New', url: 'https://new.example/' });
    switcher.refresh();
    expect(titles()[0]).toBe('New');
    expect(selectedTitle()).toBe('Charlie');
    switcher.refresh({ keepKey: 'gone' });
    expect(switcher.state.selected).toBe(0);
  });

  it('cycle: next / previous open tab in screen order, wrapping', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    switcher.cycle(1);
    expect(selectedTitle()).toBe('Bravo');
    switcher.cycle(1);
    switcher.cycle(1);
    expect(selectedTitle()).toBe('Alpha');
    switcher.cycle(-1);
    expect(selectedTitle()).toBe('Charlie');
  });

  it('cycle from a closed card starts at the current tab', async () => {
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000), tab: { sessionId: 'x', url: 'https://gone.example/', title: 'Gone' } }];
    const switcher = await boot({ tabs: ABC() });
    switcher.select(switcher.state.entries.length - 1);
    expect(switcher.state.entries[switcher.state.selected].kind).toBe('closed');
    switcher.cycle(1);
    expect(selectedTitle()).toBe('Bravo');
  });

  it('selectKey opens a collapsed section for this visit', async () => {
    const switcher = await boot({ tabs: [{ title: 'Doc', url: 'https://doc.example/' }, { title: 'Doc 2', url: 'https://doc.example/' }] });
    switcher.duplicatesView(true);
    switcher.toggleSection('d:https://doc.example/');
    expect(openCards().length).toBe(0);
    switcher.selectKey('t2');
    expect(switcher.state.peek.has('d:https://doc.example/')).toBe(true);
    expect(selectedTitle()).toBe('Doc 2');
    expect(switcher.state.collapsed.has('d:https://doc.example/')).toBe(true); // still collapsed next time
  });

  it('selectKey of an unknown key does nothing', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    switcher.selectKey('t42');
    expect(switcher.state.selected).toBe(0);
  });

  describe('moveSpatial / cardToward on a 3-column grid', () => {
    // Cards laid out at 100 px steps: row 0 = 0,1,2; row 1 = 3,4,5; row 2 = 6.
    const layout = () => openCards().forEach((cardElement, i) => {
      const x = (i % 3) * 100, y = Math.floor(i / 3) * 100;
      cardElement.getBoundingClientRect = () => ({ left: x, top: y, width: 90, height: 90, right: x + 90, bottom: y + 90 });
    });

    it('down / up go to the nearest card in the next row, closest across', async () => {
      const switcher = await boot({ tabs: many(7), context: { direction: 0 } });
      layout();
      switcher.select(1);
      switcher.moveSpatial(0, 1);
      expect(switcher.state.selected).toBe(4);
      switcher.moveSpatial(0, -1);
      expect(switcher.state.selected).toBe(1);
      switcher.select(5);
      switcher.moveSpatial(0, 1); // the last row has only the first column
      expect(switcher.state.selected).toBe(6);
      switcher.moveSpatial(0, 1); // nothing below: stays
      expect(switcher.state.selected).toBe(6);
    });

    it('left / right step one card, wrapping', async () => {
      const switcher = await boot({ tabs: many(7), context: { direction: 0 } });
      switcher.moveSpatial(-1, 0);
      expect(switcher.state.selected).toBe(6);
      switcher.moveSpatial(1, 0);
      expect(switcher.state.selected).toBe(0);
    });

    it('cardToward returns -1 when nothing lies that way', async () => {
      const switcher = await boot({ tabs: many(3) });
      layout();
      expect(switcher.cardToward(openCards(), 0, -1)).toBe(-1);
      expect(switcher.cardToward(openCards(), 0, 1)).toBe(-1);
    });
  });
});

describe('renderCount / renderActs', () => {
  it('the count: tabs shown, or what the search found', async () => {
    const switcher = await boot({ tabs: ABC() });
    const count = byTestId('count');
    expect(count.textContent).toBe('3 tabs');
    switcher.state.query = 'bravo';
    switcher.deriveSearch();
    switcher.renderCount();
    expect(count.textContent).toMatch(/1/);
    expect(count.textContent).not.toBe('3 tabs');
  });

  it('the actions bar: hidden with nothing ticked or searched', async () => {
    await boot({ tabs: ABC() });
    expect(byTestId('actions').hidden).toBe(true);
  });

  it('ticked tabs: how many, Clear, and the action buttons (Close closes at once: Undo brings them back)', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.state.picked.add(2).add(3);
    switcher.refresh();
    expect(byTestId('actions').hidden).toBe(false);
    expect(byTestId('actions-count').textContent).toMatch(/2/);
    expect(byTestId('select-none').hidden).toBe(false);
    expect([...byTestId('actions-buttons').children].map((button) => button.dataset.testid)).toEqual(['action-close', 'action-copy', 'actions-more']);
    byTestId('action-close').click();
    await waitFor(() => chrome.tabs.remove.mock.calls.length);
    expect(chrome.tabs.remove).toHaveBeenCalledWith([2, 3]);
  });

  it('"More" opens a menu of the other actions', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.state.picked.add(2);
    switcher.refresh();
    byTestId('actions-more').click();
    expect(allByTestId('menu-item').length).toBe(switcher.ACTIONS.filter((action) => action.more).length);
  });

  it('searching with several matches offers "Select all N"', async () => {
    const switcher = await boot({ tabs: [...ABC(), { title: 'Alpha two', url: 'https://alpha2.example/' }] });
    switcher.state.query = 'alpha';
    switcher.refresh();
    expect(byTestId('actions').hidden).toBe(false);
    const all = byTestId('select-all');
    expect(all.hidden).toBe(false);
    expect(all.textContent).toMatch(/2/);
    expect(all.className).toBe('link'); // a secondary link, not the bar's main button
    expect(byTestId('actions-buttons').hidden).toBe(true);
    all.click();
    expect([...switcher.state.picked].sort()).toEqual([1, 4]);
    expect(all.hidden).toBe(true); // all ticked already
  });
});

describe('toast', () => {
  it('shows text, and hides after a while', async () => {
    const switcher = await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      switcher.toast('Hello');
      expect(byTestId('toast').hidden).toBe(false);
      expect(byTestId('toast').textContent).toBe('Hello');
      vi.advanceTimersByTime(2500);
      expect(byTestId('toast').hidden).toBe(false);
      vi.advanceTimersByTime(200);
      expect(byTestId('toast').hidden).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('waits while hovered or focused (so Undo stays reachable), then hides', async () => {
    const switcher = await boot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      switcher.toast('Closed 1 tab', null, { label: 'Undo', run: () => {} });
      byTestId('toast').dispatchEvent(new MouseEvent('mouseenter'));
      vi.advanceTimersByTime(20000);
      expect(byTestId('toast').hidden).toBe(false);
      byTestId('toast').dispatchEvent(new MouseEvent('mouseleave'));
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(6000);
      expect(byTestId('toast').hidden).toBe(true);
      switcher.toast('Closed 2 tabs', null, { label: 'Undo', run: () => {} });
      byTestId('toast').dispatchEvent(new FocusEvent('focusin'));
      vi.advanceTimersByTime(20000);
      expect(byTestId('toast').hidden).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('sits above the actions bar while that shows (never over it)', async () => {
    const switcher = await boot({ tabs: ABC() });
    switcher.toast('Hello');
    expect(byTestId('toast').style.bottom).toBe('20px');
    expect(byTestId('toast').classList.contains('lifted')).toBe(false);
    switcher.pick(switcher.state.entries[1]);
    expect(byTestId('actions').hidden).toBe(false);
    expect(parseFloat(byTestId('toast').style.bottom)).toBeGreaterThan(20);
    expect(byTestId('toast').classList.contains('lifted')).toBe(true);
  });

  it('with an action: a button that runs it and hides the note', async () => {
    const switcher = await boot();
    const callback = vi.fn();
    switcher.toast('Closed 1 tab', null, { label: 'Undo', run: callback });
    const toastActionButton = byTestId('toast-action');
    expect(toastActionButton.textContent).toBe('Undo');
    toastActionButton.click();
    expect(callback).toHaveBeenCalledOnce();
    expect(byTestId('toast').hidden).toBe(true);
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
    const switcher = await boot();
    const html = document.documentElement;
    switcher.applyTheme('light');
    expect(html.classList.contains('light')).toBe(true);
    switcher.applyTheme('dark');
    expect(html.classList.contains('light')).toBe(false);
    switcher.applyTheme('purple');
    expect(switcher.themePreference).toBe('system');
    expect(html.classList.contains('light')).toBe(false); // the fake OS prefers dark
    switcher.applyTheme('system');
    expect(html.classList.contains('light')).toBe(false);
  });

  it('with no theme saved, it follows the system', async () => {
    const switcher = await boot({ beforeImport: () => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} })) });
    expect(switcher.themePreference).toBe('system');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    switcher.applyTheme('dark');
  });

  it('applyTheme: "system" follows a light OS', async () => {
    const switcher = await boot({ beforeImport: () => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} })) });
    switcher.applyTheme('system');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    switcher.applyTheme('dark');
  });

  it('the theme saved in Settings is applied at boot', async () => {
    await boot({ preferences: { theme: 'light' } });
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('layoutHeader: below 1100 px the player moves under the search box (.narrow), below 900 px icons only (.tight)', async () => {
    const switcher = await boot();
    const header = byTestId('header');
    switcher.layoutHeader(1400);
    expect([header.classList.contains('narrow'), header.classList.contains('tight')]).toEqual([false, false]);
    switcher.layoutHeader(1000);
    expect([header.classList.contains('narrow'), header.classList.contains('tight')]).toEqual([true, false]);
    switcher.layoutHeader(800);
    expect([header.classList.contains('narrow'), header.classList.contains('tight')]).toEqual([true, true]);
    // a resize lays it out again, and the card area follows the header's new height
    Object.defineProperty(window, 'innerWidth', { value: 1500, configurable: true });
    Object.defineProperty(header, 'offsetHeight', { value: 108, configurable: true });
    switcher.render();
    expect(header.classList.contains('narrow')).toBe(false);
    expect(byTestId('body').style.getPropertyValue('--top')).toBe('108px');
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  });

  it('the header has no shortcut row any more: an ⓘ button instead', async () => {
    await boot();
    expect(byTestId('hint')).toBe(null);
    expect(byTestId('keys-button').getAttribute('aria-label')).toBe('Keyboard and mouse shortcuts');
    expect(byTestId('keys-button').getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('a GitHub button, last, just right of ⓘ, opens the repository in a new tab beside the page and closes Tabazing', async () => {
    await boot();
    const githubButton = byTestId('github-button');
    expect(githubButton.previousElementSibling).toBe(byTestId('keys-button'));
    expect(githubButton.nextElementSibling).toBe(null); // the header's last: the one link out of Tabazing
    expect(githubButton.getAttribute('aria-label')).toBe('Tabazing on GitHub');
    expect(githubButton.title).toBe('Tabazing on GitHub');
    githubButton.click();
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
    expect(css).toMatch(/\.tour-highlight \{ outline: 3px solid var\(--ring\)/);
  });

  it('setTop: the card area starts under the header, the toolbar and a shown alert', async () => {
    const switcher = await boot();
    const stubOffsetHeight = (element, value) => Object.defineProperty(element, 'offsetHeight', { value, configurable: true });
    stubOffsetHeight(byTestId('header'), 50); stubOffsetHeight(byTestId('tools'), 30); stubOffsetHeight(byTestId('alert'), 20);
    switcher.setTop();
    expect(byTestId('body').style.getPropertyValue('--top')).toBe('80px');
    byTestId('alert').hidden = false;
    switcher.setTop();
    expect(byTestId('body').style.getPropertyValue('--top')).toBe('104px');
  });

  it('tipTruncated: text cut short gets a tooltip, which goes when it fits again', async () => {
    const switcher = await boot();
    const label = allByTestId('window-label')[0] || document.body.appendChild(Object.assign(document.createElement('span'), { className: 'window-label', textContent: 'A long window name' }));
    Object.defineProperty(label, 'clientWidth', { value: 20, configurable: true });
    Object.defineProperty(label, 'scrollWidth', { value: 60, configurable: true });
    switcher.tipTruncated();
    expect(label.title).toBe(label.textContent);
    Object.defineProperty(label, 'scrollWidth', { value: 20, configurable: true });
    switcher.tipTruncated();
    expect(label.hasAttribute('title')).toBe(false);
  });

  it('noteTip / hideTip: a note button shows its note shortly after hover', async () => {
    const switcher = await boot({ tabs: ABC() });
    const noteButton = document.createElement('button');
    document.body.append(noteButton);
    noteButton.dataset.note = 'remember this';
    switcher.noteTip(noteButton);
    expect(byTestId('note-tooltip')).toBe(null);
    await waitFor(() => byTestId('note-tooltip'));
    expect(byTestId('note-tooltip-text').textContent).toBe('remember this');
    switcher.hideTip();
    expect(byTestId('note-tooltip')).toBe(null);
    switcher.noteTip(noteButton);
    switcher.hideTip(); // before it shows: cancelled
    await tick(200);
    expect(byTestId('note-tooltip')).toBe(null);
    noteButton.dataset.note = '';
    switcher.noteTip(noteButton);
    await tick(200);
    expect(byTestId('note-tooltip')).toBe(null);
    noteButton.remove();
  });
});

describe('menu / closePops', () => {
  const setup = async () => {
    const switcher = await boot();
    const anchor = document.createElement('button');
    byTestId('app').append(anchor);
    const callbacks = [vi.fn(), vi.fn(), vi.fn()];
    const items = [{ label: 'One', run: callbacks[0] }, null, { label: 'Two', run: callbacks[1] }, { label: 'Three', run: callbacks[2], danger: true, sure: 'Sure?' }];
    return { switcher, anchor, callbacks, items };
  };

  it('lists the items (null is a divider) and focuses the first', async () => {
    const { switcher, anchor, items } = await setup();
    switcher.menu(anchor, items);
    const menu = byTestId('menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(allByTestId('menu-item', menu).map((x) => x.textContent)).toEqual(['One', 'Two', 'Three']);
    expect(allByTestId('menu-separator', menu).length).toBe(1);
    expect(allByTestId('menu-item', menu).filter((x) => x.classList.contains('danger')).map((x) => x.textContent)).toEqual(['Three']);
    expect(document.activeElement.textContent).toBe('One');
  });

  it('a click runs the item at once and closes the menu', async () => {
    const { switcher, anchor, callbacks, items } = await setup();
    switcher.menu(anchor, items);
    const [, , three] = allByTestId('menu-item');
    three.click();
    expect(callbacks[2]).toHaveBeenCalledOnce();
    expect(byTestId('menu')).toBe(null);
  });

  it('its own button again closes it, and does not reopen', async () => {
    const { switcher, anchor, items } = await setup();
    anchor.addEventListener('click', () => switcher.menu(anchor, items));
    anchor.click();
    expect(allByTestId('menu').length).toBe(1);
    await tick(5); // the outside-press listener is armed
    anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(allByTestId('menu').length).toBe(1); // a press on its button is not "outside"
    anchor.click();
    expect(allByTestId('menu').length).toBe(0);
    anchor.click(); // a third click opens it again
    expect(allByTestId('menu').length).toBe(1);
  });

  it('a press outside closes it', async () => {
    const { switcher, anchor, items } = await setup();
    switcher.menu(anchor, items);
    await tick(5);
    byTestId('menu-item').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(byTestId('menu')).not.toBe(null); // inside: stays
    byTestId('scroller').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(byTestId('menu')).toBe(null);
  });

  it('arrow keys, Home and End move the focus; Esc closes and goes back to the button', async () => {
    const { switcher, anchor, items } = await setup();
    switcher.menu(anchor, items);
    const menu = byTestId('menu');
    const press = (keyName) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }));
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
    expect(menu.isConnected).toBe(false);
    expect(document.activeElement).toBe(anchor);
    expect(switcher.state.done).toBe(false); // Esc in the menu does not close the switcher
  });

  it('an item marked on is ticked and focused first', async () => {
    const { switcher, anchor } = await setup();
    switcher.menu(anchor, [{ label: 'A', on: false, run() {} }, { label: 'B', on: true, run() {} }]);
    const [firstMenuItem, secondMenuItem] = allByTestId('menu-item');
    expect(firstMenuItem.getAttribute('role')).toBe('menuitemradio');
    expect(secondMenuItem.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(secondMenuItem);
  });

  it('closePops closes menus and cards, saving a card through its close()', async () => {
    const { switcher, anchor, items } = await setup();
    switcher.menu(anchor, items);
    const popup = document.createElement('div');
    popup.className = 'popover';
    popup.close = vi.fn(() => popup.remove());
    byTestId('app').append(popup);
    switcher.closePops();
    expect(byTestId('menu')).toBe(null);
    expect(popup.close).toHaveBeenCalledOnce();
  });
});

describe('"Show more" under Recently closed', () => {
  it('is a text button: the primary colour on nothing, a state layer of it when pointed at or focused', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8').replace(/\r\n/g, '\n');
    const rule = (selector) => { const i = css.indexOf(selector + ' {'); return i < 0 ? '' : css.slice(i + selector.length + 2, css.indexOf('}', i)); };
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
    for (const fontFile of ['roboto-latin-wght-normal.woff2', 'roboto-latin-ext-wght-normal.woff2', 'roboto-cyrillic-wght-normal.woff2']) {
      expect(css).toContain(`url(fonts/${fontFile})`);
      expect(existsSync('styles/fonts/' + fontFile), fontFile).toBe(true);
    }
    expect(existsSync('styles/fonts/OFL.txt')).toBe(true); // its licence goes with it
    expect(css).toMatch(/html, body \{[^}]*font: 400 14px\/1\.43 'Roboto'/);
  });

  it('no press ripple (today\'s Material UI draws none): a press shows only its state colour', async () => {
    const { readFileSync } = await import('node:fs');
    await boot({ tabs: ABC() });
    const settingsButton = byTestId('settings-button');
    settingsButton.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 30 }));
    expect(byTestId('ripple')).toBe(null);
    expect(readFileSync('styles/switcher.css', 'utf8')).not.toMatch(/\.rip\b/);
  });

  it('menus, the search\'s results and the small cards drop down (revealed from the top edge), or up (.up), not grow', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('styles/switcher.css', 'utf8');
    expect(css).toMatch(/\.menu \{[^}]*animation: drop \.2s/);
    expect(css).toMatch(/\.menu\.up \{ animation-name: drop-up; \}/);
    expect(css).toMatch(/\.popover \{[^}]*animation: drop \.2s/);
    expect(css).toMatch(/\.popover\.up \{ animation-name: drop-up; \}/);
    expect(css).toMatch(/\.dropdown \{[^}]*animation: drop \.2s/);
    expect(css).toMatch(/@keyframes drop \{ from \{[^}]*clip-path: inset\(-24px -24px 100% -24px\)/);
    expect(css).not.toMatch(/scaleY/);
  });
});
