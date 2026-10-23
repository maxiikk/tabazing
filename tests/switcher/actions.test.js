// Actions on tabs in the switcher: opening, closing (with undo), ticking, the quick-actions bar and the
// per-card quick buttons. Everything runs against the real switcher page and the fake chrome.* API.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tick, waitFor, key } from '../helpers/switcher.js';
import { boot, frame, byTestId, allByTestId, cardOf, tabByTitle, entryByTitle, toastText, toastButton, closedMessage } from '../helpers/quiet-boot.js';
import { MESSAGE } from '../../utils/constants.js';
import { translate } from '../../utils/translations.js';

const THREE_TABS = [
  { title: 'A', url: 'https://a.example/' },
  { title: 'B', url: 'https://b.example/' },
  { title: 'C', url: 'https://c.example/' },
];
const live = (id) => chrome._data.tabs.find((x) => x.id === id);
const order = (windowId = 1) => chrome._data.tabs.filter((x) => x.windowId === windowId).sort((first, second) => first.index - second.index).map((x) => x.title);

let clipboard;
beforeEach(() => {
  clipboard = { writeText: vi.fn(async () => {}) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});

describe('finish', () => {
  it('tells the background once, refocuses the source window on cancel, and closes the popup', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    chrome.runtime.sendMessage.mockClear();
    await switcher.finish('cancel');
    await switcher.finish('switch'); // runs once
    const messages = chrome.runtime.sendMessage.mock.calls.map((call) => call[0]);
    expect(messages).toEqual([expect.objectContaining({ type: MESSAGE.CLOSED, reason: 'cancel', sourceTab: tabByTitle(switcher, 'A').id, window: 1 })]);
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(window.close).toHaveBeenCalledTimes(1);
    expect(switcher.state.done).toBe(true);
  });

  it('sends the tabs marked for sleep along', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.state.toSleep.add(tabByTitle(switcher, 'B').id);
    await switcher.finish('switch');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.SLEEP, tabIds: [tabByTitle(switcher, 'B').id] });
    expect(chrome.windows.update).not.toHaveBeenCalled(); // only 'cancel' refocuses
  });

  it('in an overlay posts "close" to the page instead of closing a window', async () => {
    const switcher = await boot({ tabs: THREE_TABS, overlay: true });
    
    await switcher.finish('cancel');
    expect(frame().postMessage).toHaveBeenCalledWith({ tabazing: 'close' }, '*');
    expect(window.close).not.toHaveBeenCalled();
  });
});

describe('choose', () => {
  it('switches to an open tab and focuses its window', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const bravo = tabByTitle(switcher, 'B');
    await switcher.choose(switcher.state.entries.findIndex((entry) => entry.tab && entry.tab.id === bravo.id));
    expect(chrome.tabs.update).toHaveBeenCalledWith(bravo.id, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(live(bravo.id).active).toBe(true);
    expect(closedMessage().reason).toBe('switch');
  });

  it('on the current tab in an overlay just cancels', async () => {
    const switcher = await boot({ tabs: THREE_TABS, overlay: true });
    await switcher.choose(switcher.state.entries.findIndex((entry) => entry.tab && entry.tab.title === 'A'));
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(closedMessage().reason).toBe('cancel');
  });

  it('wakes a snoozed tab: out of the list, into a new tab', async () => {
    const snoozedTab = { id: 'z1', url: 'https://snooze.example/', title: 'Snz', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() };
    const switcher = await boot({ tabs: THREE_TABS, beforeImport: () => chrome.storage.local.set({ snoozed: [snoozedTab] }) });
    const i = switcher.state.entries.findIndex((entry) => entry.kind === 'snoozed');
    expect(i).toBeGreaterThan(0);
    await switcher.choose(i);
    expect((await chrome.storage.local.get('snoozed')).snoozed).toEqual([]);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: snoozedTab.url, windowId: 1, active: true, pinned: false });
    expect(closedMessage().reason).toBe('switch');
  });

  it('opens a starred page that is not open', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.state.entries.push({ kind: 'star', key: 'stx', item: { id: 'x', url: 'https://star.example/', title: 'S' } });
    await switcher.choose(switcher.state.entries.length - 1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://star.example/', windowId: 1, active: true });
    expect(closedMessage().reason).toBe('switch');
  });

  it("restores a recently closed tab through Chrome's session when it has one", async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.state.entries.push({ kind: 'closed', key: 'c1', item: { url: 'https://gone.example/', session: { tab: { sessionId: 's9' } } } });
    await switcher.choose(switcher.state.entries.length - 1);
    expect(chrome.sessions.restore).toHaveBeenCalledWith('s9');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(closedMessage().reason).toBe('restore');
  });

  it('reopens a closed page from our own log (no session) as a new tab', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.state.entries.push({ kind: 'closed', key: 'c2', item: { url: 'https://log.example/', session: null } });
    await switcher.choose(switcher.state.entries.length - 1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://log.example/', windowId: 1, active: true });
    expect(closedMessage().reason).toBe('restore');
  });

  it('cancels when Chrome refuses, and does nothing once done', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    chrome.tabs.update.mockRejectedValueOnce(new Error('gone'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await switcher.choose(1);
    expect(closedMessage().reason).toBe('cancel');
    chrome.tabs.update.mockClear();
    await switcher.choose(1);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('no "click again" confirmations', () => {
  it('everything that closes or moves tabs has Undo instead, so nothing asks twice', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    expect(switcher.armed).toBeUndefined();
    expect('armed' in switcher.state).toBe(false);
  });
});

describe('closeTab', () => {
  it('closes the tab, keeps the selection next to it, and offers Undo', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const bravoEntry = entryByTitle(switcher, 'B');
    switcher.select(switcher.state.entries.indexOf(bravoEntry));
    await switcher.closeTab(bravoEntry);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(bravoEntry.tab.id);
    expect(live(bravoEntry.tab.id)).toBeUndefined();
    expect(switcher.state.tabs.map((x) => x.title)).toEqual(['A', 'C']);
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('C');
    expect(switcher.state.undo.at(-1)).toMatchObject({ kind: 'close', tabs: [{ id: bravoEntry.tab.id, url: 'https://b.example/', windowId: 1, index: 1, pinned: false }] });
    expect(toastText()).toBe(translate('closedCount', { count: 1 }));
    expect(toastButton().textContent).toMatch(/^Undo/);
  });

  it('cancels a snooze on a snoozed card (the tab is not reopened)', async () => {
    const snoozedTab = { id: 'z1', url: 'https://snooze.example/', title: 'Snz', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() };
    const switcher = await boot({ tabs: THREE_TABS, beforeImport: () => chrome.storage.local.set({ snoozed: [snoozedTab] }) });
    await switcher.closeTab(switcher.state.entries.find((entry) => entry.kind === 'snoozed'));
    expect(switcher.state.snoozed).toEqual([]);
    expect((await chrome.storage.local.get('snoozed')).snoozed).toEqual([]);
    expect(switcher.state.entries.some((entry) => entry.kind === 'snoozed')).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(toastText()).toBe(translate('snoozeCancelled'));
  });

  it('unstars a starred page that is not open', async () => {
    const stars = { 'https://star.example/': { u: 'https://star.example/', ti: 'S', t: Date.now() } };
    const switcher = await boot({ tabs: THREE_TABS, beforeImport: () => chrome.storage.local.set({ stars }) });
    await switcher.closeTab({ kind: 'star', key: 'st1', url: 'https://star.example/', item: { url: 'https://star.example/', title: 'S' } });
    expect((await chrome.storage.local.get('stars')).stars).toEqual({});
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it("in an overlay, closing the tab it sits on pushes no undo (it closes with it)", async () => {
    const switcher = await boot({ tabs: THREE_TABS, overlay: true });
    await switcher.closeTab(entryByTitle(switcher, 'A'));
    expect(chrome.tabs.remove).toHaveBeenCalled();
    expect(switcher.state.undo).toEqual([]);
  });
});

describe('forgetTab', () => {
  it('drops the tab, shifts the ones after it, unticks it, and selects its neighbour', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const bravo = tabByTitle(switcher, 'B');
    switcher.state.picked.add(bravo.id);
    switcher.select(switcher.state.entries.findIndex((entry) => entry.tab === bravo));
    switcher.forgetTab(bravo.id);
    expect(switcher.state.tabs.map((x) => x.title)).toEqual(['A', 'C']);
    expect(tabByTitle(switcher, 'C').index).toBe(1);
    expect(switcher.state.picked.has(bravo.id)).toBe(false);
    expect(switcher.state.windows[0].count).toBe(2);
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('C');
    switcher.forgetTab(999); // unknown: nothing happens
    expect(switcher.state.tabs).toHaveLength(2);
  });
});

describe('ticking tabs', () => {
  it('pickBox draws a checkbox that ticks its card', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const charlieEntry = entryByTitle(switcher, 'C');
    const checkbox = switcher.pickBox(charlieEntry, false);
    expect(checkbox.getAttribute('role')).toBe('checkbox');
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect(switcher.pickBox(charlieEntry, true).className).toBe('pick on');
    checkbox.click();
    expect(switcher.state.picked.has(charlieEntry.tab.id)).toBe(true);
    expect(cardOf('C').classList.contains('picked')).toBe(true);
  });

  it('pick toggles one card, and a range from the last one', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const [alphaEntry, bravoEntry, charlieEntry] = ['A', 'B', 'C'].map((x) => entryByTitle(switcher, x));
    switcher.pick(alphaEntry);
    switcher.pick(entryByTitle(switcher, 'C'), { range: true });
    expect([...switcher.state.picked].sort()).toEqual([alphaEntry.tab.id, bravoEntry.tab.id, charlieEntry.tab.id].sort());
    switcher.pick(entryByTitle(switcher, 'B'));
    expect(switcher.state.picked.has(bravoEntry.tab.id)).toBe(false);
    expect(switcher.state.lastPick).toBe(bravoEntry.tab.id);
  });

  it('selectAll ticks the cards, or only the search matches; clearPicks unticks', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    expect(switcher.pickPool()).toBe(switcher.state.matches);
    switcher.selectAll();
    expect(switcher.state.picked.size).toBe(3);
    switcher.clearPicks();
    expect(switcher.state.picked.size).toBe(0);
    expect(switcher.state.lastPick).toBe(null);
    const secondSwitcher = await boot({ tabs: [{ title: 'Alpha', url: 'https://alpha.test/' }, { title: 'Bravo', url: 'https://bravo.test/' }] });
    secondSwitcher.state.query = 'bravo';
    secondSwitcher.refresh();
    expect(secondSwitcher.pickPool()).toBe(secondSwitcher.state.found);
    secondSwitcher.selectAll();
    expect(secondSwitcher.targets().map((x) => x.title)).toEqual(['Bravo']);
  });

  it('targets are the ticked tabs, in list order', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.state.picked.add(tabByTitle(switcher, 'C').id).add(tabByTitle(switcher, 'A').id);
    expect(switcher.targets().map((x) => x.title)).toEqual(['A', 'C']);
  });
});

describe('the quick-actions bar', () => {
  it('shows with tabs ticked; Close closes them at once (Undo brings them back)', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.pick(entryByTitle(switcher, 'B'));
    switcher.pick(entryByTitle(switcher, 'C'));
    expect(byTestId('actions').hidden).toBe(false);
    expect(byTestId('actions-count').textContent).toBe(translate('pickedCount', { count: 2 }));
    byTestId('action-close').click();
    await waitFor(() => chrome.tabs.remove.mock.calls.length);
    expect(order()).toEqual(['A']);
    expect(toastButton().textContent).toMatch(/^Undo/);
  });

  it('lists every action, the rarer ones under More, each with its own error note', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    expect(switcher.ACTIONS.map((action) => action.id)).toEqual(['close', 'copy', 'markdown', 'window', 'sleep', 'snooze', 'archive', 'group', 'bookmark', 'pin', 'mute']);
    expect(switcher.ACTIONS.filter((action) => !action.more).map((action) => action.id)).toEqual(['close', 'copy']);
    expect(switcher.ACTIONS.every((action) => !action.confirm)).toBe(true);
    expect(Object.fromEntries(switcher.ACTIONS.map((action) => [action.id, action.error()]))).toEqual({
      close: translate('errorClose'), copy: translate('copyFailed'), markdown: translate('copyFailed'), window: translate('errorMove'), sleep: translate('errorSleep'),
      snooze: translate('errorSnooze'), archive: translate('errorArchive'), group: translate('actionFailed'), bookmark: translate('markError'), pin: translate('errorPin'), mute: translate('errorMute'),
    });
    const pin = switcher.ACTIONS.find((action) => action.id === 'pin');
    expect(pin.label([{ pinned: true }])).toBe(translate('actionUnpin'));
    expect(pin.label([{ pinned: true }, { pinned: false }])).toBe(translate('actionPin'));
    const mute = switcher.ACTIONS.find((action) => action.id === 'mute');
    expect(mute.label([{ mutedInfo: { muted: true } }])).toBe(translate('actionUnmute'));
    expect(mute.label([])).toBe(translate('actionMute'));
  });

  it("More opens a menu of the rarer actions, and its items action on the ticked tabs", async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.pick(entryByTitle(switcher, 'B'));
    byTestId('actions-more').click();
    const items = allByTestId('menu-item').map((menuItem) => menuItem.textContent);
    expect(items).toEqual([translate('actionCopyMarkdown'), translate('actionNewWindow'), translate('actionSleep'), translate('actionSnooze'), translate('actionArchive'), translate('groupAddTo'), translate('markMenu'), translate('actionPin'), translate('actionMute')]);
    allByTestId('menu-item')[7].click(); // Pin
    await waitFor(() => live(tabByTitle(switcher, 'B')?.id ?? 2).pinned);
  });

  it.each([
    ['copy', (tabs) => expect(clipboard.writeText).toHaveBeenCalledWith(tabs.map((x) => x.url).join('\n'))],
    ['markdown', () => expect(clipboard.writeText).toHaveBeenCalledWith('- [B](https://b.example/)\n- [C](https://c.example/)')],
    ['sleep', (tabs, switcher) => expect([...switcher.state.toSleep]).toEqual(tabs.map((x) => x.id))],
    ['pin', (tabs) => expect(tabs.map((x) => live(x.id).pinned)).toEqual([true, true])],
    ['mute', (tabs) => expect(tabs.map((x) => live(x.id).mutedInfo.muted)).toEqual([true, true])],
    ['close', (tabs) => expect(tabs.map((x) => live(x.id))).toEqual([undefined, undefined])],
    ['window', (tabs) => { expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: tabs[0].id, focused: false }); expect(closedMessage()).toBeUndefined(); }],
    ['archive', (tabs) => expect(chrome.bookmarks.create).toHaveBeenCalledWith(expect.objectContaining({ url: tabs[1].url }))],
    ['snooze', () => expect(allByTestId('menu-item').length).toBeGreaterThanOrEqual(4)],
  ])('%s runs on the tabs it is given', async (id, check) => {
    const switcher = await boot({ tabs: THREE_TABS });
    const tabs = [tabByTitle(switcher, 'B'), tabByTitle(switcher, 'C')];
    const anchor = document.body.appendChild(document.createElement('button'));
    await switcher.ACTIONS.find((action) => action.id === id).run(tabs, anchor);
    check(tabs, switcher);
  });
});

describe('undo', () => {
  it('undoRecord keeps where each tab was', async () => {
    const switcher = await boot({ tabs: [...THREE_TABS, { title: 'P', url: 'https://p.example/', pinned: true }] });
    const pinnedTab = tabByTitle(switcher, 'P');
    expect(switcher.undoRecord([pinnedTab])).toEqual([{ id: pinnedTab.id, url: 'https://p.example/', windowId: 1, index: 3, pinned: true }]);
  });

  it('pushUndo keeps the last 20 and ignores empty ones; the note says what it undoes', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.pushUndo([]);
    expect(switcher.state.undo).toEqual([]);
    for (let i = 0; i < 21; i++) switcher.pushUndo([{ url: 'https://x/' + i, windowId: 1, index: 0, pinned: false }]);
    expect(switcher.state.undo).toHaveLength(20);
    expect(switcher.state.undo[0].tabs[0].url).toBe('https://x/1');
    expect(switcher.state.undo[0].kind).toBe('close');
    switcher.pushUndo([{ id: 1, url: 'https://x/', windowId: 2, index: 0, pinned: false }], 'merge');
    expect(toastText()).toBe(translate('mergedCount', { count: 1 }));
    switcher.pushUndo([{ id: 1, url: 'https://x/', windowId: 1, index: 0, pinned: false }], 'move');
    expect(toastText()).toBe(translate('movedCount', { count: 1 }));
  });

  it('undoLast reopens the last closing where it was, in the background, when Chrome no longer lists it', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    await switcher.closeTab(entryByTitle(switcher, 'B'));
    chrome.tabs.create.mockClear();
    await switcher.undoLast();
    expect(chrome.sessions.restore).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://b.example/', windowId: 1, index: 1, pinned: false, active: false });
    expect(switcher.state.tabs.map((x) => x.url)).toContain('https://b.example/');
    expect(toastText()).toBe(translate('reopenedCount', { count: 1 }));
    await switcher.undoLast();
    expect(toastText()).toBe(translate('undoNothing'));
  });

  it("undoLast brings a tab Chrome closed just now back through Chrome's sessions (its history too), and shows the tab that was showing", async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const bravoEntry = entryByTitle(switcher, 'B');
    await switcher.closeTab(bravoEntry);
    const now = Math.floor(Date.now() / 1000);
    chrome._data.closed = [
      { lastModified: now - 3600, tab: { sessionId: 'old', url: 'https://b.example/', title: 'B' } }, // the same page, long ago: not this one
      { lastModified: now, tab: { sessionId: 's-b', url: 'https://b.example/', title: 'B' } },
    ];
    chrome.tabs.create.mockClear();
    chrome.tabs.update.mockClear();
    await switcher.undoLast();
    expect(chrome.sessions.restore).toHaveBeenCalledWith('s-b');
    expect(chrome.sessions.restore).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabByTitle(switcher, 'A').id, { active: true }); // the window shows its tab again
    expect(switcher.asking).toBe(false);
  });

  it('a restore Chrome refuses falls back to opening the page', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    await switcher.closeTab(entryByTitle(switcher, 'C'));
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000), tab: { sessionId: 's-c', url: 'https://c.example/', title: 'C' } }];
    chrome.sessions.restore.mockRejectedValueOnce(new Error('gone'));
    await switcher.undoLast();
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://c.example/', active: false }));
    expect(switcher.asking).toBe(false);
  });

  it("the toast's Undo button undoes", async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    await switcher.closeTab(entryByTitle(switcher, 'C'));
    toastButton().click();
    await waitFor(() => toastText() === translate('reopenedCount', { count: 1 }));
    expect(chrome._data.tabs.some((x) => x.url === 'https://c.example/')).toBe(true);
  });

  it('reopenAt goes left to right, and falls back to the source window when the old one is gone', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    chrome.tabs.create.mockRejectedValueOnce(new Error('No window with id: 9.'));
    await switcher.reopenAt([{ url: 'https://two/', windowId: 1, index: 2, pinned: false }, { url: 'https://zero/', windowId: 9, index: 0, pinned: true }]);
    const calls = chrome.tabs.create.mock.calls.map((call) => call[0]);
    expect(calls).toEqual([
      { url: 'https://zero/', windowId: 9, index: 0, pinned: true, active: false },
      { url: 'https://zero/', windowId: 1, active: false },
      { url: 'https://two/', windowId: 1, index: 2, pinned: false, active: false },
    ]);
  });
});

describe('reload', () => {
  it("reads Chrome's tabs again, keeping the selected card", async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.select(switcher.state.entries.findIndex((entry) => entry.tab && entry.tab.title === 'C'));
    chrome._addTab({ windowId: 1, title: 'D', url: 'https://d.example/' });
    await switcher.reload();
    expect(switcher.state.tabs.map((x) => x.title)).toContain('D');
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('C');
  });
});

describe('closeMany', () => {
  it('closes the tabs, unticks them, and offers one Undo for all', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.state.picked.add(tabByTitle(switcher, 'B').id);
    await switcher.closeMany([tabByTitle(switcher, 'B'), tabByTitle(switcher, 'C')]);
    expect(order()).toEqual(['A']);
    expect(switcher.state.picked.size).toBe(0);
    expect(switcher.state.undo.at(-1).tabs.map((x) => x.url)).toEqual(['https://b.example/', 'https://c.example/']);
    expect(toastText()).toBe(translate('closedCount', { count: 2 }));
  });

  it('in an overlay closes the tab it sits on last', async () => {
    const switcher = await boot({ tabs: THREE_TABS, overlay: true });
    const alpha = tabByTitle(switcher, 'A'), bravo = tabByTitle(switcher, 'B');
    await switcher.closeMany([alpha, bravo]);
    expect(chrome.tabs.remove.mock.calls).toEqual([[[bravo.id]], [alpha.id]]);
    expect(switcher.state.undo).toEqual([]);
  });
});

describe('copying', () => {
  it('copyText uses the clipboard API', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    expect(await switcher.copyText('hi')).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('hi');
  });

  it("copyText falls back to execCommand('copy') when the clipboard API is refused", async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    const clip = byTestId('clip');
    let copied = null;
    const originalExecCommand = document.execCommand;
    document.execCommand = vi.fn(() => { copied = clip.value; return true; });
    try {
      expect(await switcher.copyText('fallback')).toBe(true);
    } finally { document.execCommand = originalExecCommand; }
    expect(copied).toBe('fallback');
    expect(clip.value).toBe('');
    expect(document.activeElement).toBe(byTestId('search'));
  });

  it('copyLinks: plain addresses, or a Markdown list with brackets escaped and the host for no title', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const tabs = [{ title: 'Docs [v2] guide', url: 'https://d.example/x' }, { title: '', url: 'https://www.e.example/' }];
    await switcher.copyLinks(tabs, 'plain');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('https://d.example/x\nhttps://www.e.example/');
    await switcher.copyLinks(tabs, 'markdown');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('- [Docs \\[v2\\] guide](https://d.example/x)\n- [www.e.example](https://www.e.example/)');
    expect(toastText()).toBe(translate('copiedCount', { count: 2 }));
    clipboard.writeText.mockRejectedValueOnce(new Error('no'));
    await switcher.copyLinks(tabs, 'plain');
    expect(toastText()).toBe(translate('copyFailed'));
  });
});

describe('opening things', () => {
  it('moveToWindow puts the tabs in a new window behind Tabazing, in order, and Undo moves them back', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const [bravo, charlie] = [tabByTitle(switcher, 'B'), tabByTitle(switcher, 'C')];
    await switcher.moveToNewWindow([bravo, charlie]);
    const newWindow = chrome._data.windows.at(-1);
    expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: bravo.id, focused: false });
    expect(live(bravo.id).windowId).toBe(newWindow.id);
    expect(live(charlie.id).windowId).toBe(newWindow.id);
    expect(order(newWindow.id)).toEqual(['B', 'C']);
    expect(closedMessage()).toBeUndefined(); // still open, to offer Undo
    expect(toastText()).toBe(translate('movedCount', { count: 2 }));
    toastButton().click();
    await waitFor(() => toastText() === translate('movedBackCount', { count: 2 }));
    expect(order()).toEqual(['A', 'B', 'C']);
  });

  it('moveToWindow from an overlay, with the tab it sits on, goes along and closes', async () => {
    const switcher = await boot({ tabs: THREE_TABS, overlay: true });
    await switcher.moveToNewWindow([tabByTitle(switcher, 'A'), tabByTitle(switcher, 'B')]);
    expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: tabByTitle(switcher, 'A').id, focused: true });
    expect(closedMessage().reason).toBe('switch');
  });

  it('moveBack makes a window that is gone again, behind Tabazing, and puts the tabs in their places', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const [bravo, charlie] = [tabByTitle(switcher, 'B'), tabByTitle(switcher, 'C')];
    await switcher.moveBack([{ id: charlie.id, windowId: 9, index: 1, pinned: false }, { id: bravo.id, windowId: 9, index: 0, pinned: true }]);
    const newWindow = chrome._data.windows.at(-1);
    expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: bravo.id, focused: false });
    expect(order(newWindow.id)).toEqual(['B', 'C']);
    expect(live(bravo.id).pinned).toBe(true);
  });

  it('openFromBox opens an address as one, anything else as a Google search', async () => {
    let switcher = await boot({ tabs: THREE_TABS });
    await switcher.openFromBox('example.org/path');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.org/path', windowId: 1, active: true });
    expect(closedMessage().reason).toBe('switch');
    switcher = await boot({ tabs: THREE_TABS });
    await switcher.openFromBox('cats & dogs');
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: 'https://www.google.com/search?q=cats%20%26%20dogs', windowId: 1, active: true });
  });

  it('restoreClosed uses the session, else opens the page, and cancels on failure', async () => {
    let switcher = await boot({ tabs: THREE_TABS });
    await switcher.restoreClosed({ url: 'https://w/', session: { window: { sessionId: 'w1' } } });
    expect(chrome.sessions.restore).toHaveBeenCalledWith('w1');
    expect(closedMessage().reason).toBe('restore');

    switcher = await boot({ tabs: THREE_TABS });
    await switcher.restoreClosed({ url: 'https://log/', session: null });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://log/', windowId: 1, active: true });

    switcher = await boot({ tabs: THREE_TABS });
    chrome.sessions.restore.mockRejectedValueOnce(new Error('gone'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await switcher.restoreClosed({ url: 'https://w/', session: { tab: { sessionId: 'x' } } });
    expect(closedMessage().reason).toBe('cancel');
  });

  it('openPage switches to an open tab with that address, else opens one', async () => {
    let switcher = await boot({ tabs: THREE_TABS });
    await switcher.openPage('https://c.example/#part');
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabByTitle(switcher, 'C').id, { active: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    switcher = await boot({ tabs: THREE_TABS });
    await switcher.openPage('https://new.example/');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://new.example/', windowId: 1, active: true });
    expect(closedMessage().reason).toBe('switch');
  });
});

describe('mergeWindows', () => {
  it("pulls another window's tabs in at once, keeping pins; Undo puts them back in a new window", async () => {
    let otherWindowTab;
    const switcher = await boot({
      tabs: THREE_TABS,
      beforeImport: () => { otherWindowTab = chrome._addTab({ windowId: 2, title: 'W2', url: 'https://w2.example/', pinned: true }); },
    });
    expect(switcher.state.otherWindows).toEqual([2]);
    await switcher.mergeWindows([2]);
    expect(chrome.tabs.move).toHaveBeenCalledWith([otherWindowTab.id], { windowId: 1, index: -1 });
    expect(chrome.tabs.update).toHaveBeenCalledWith(otherWindowTab.id, { pinned: true });
    expect(live(otherWindowTab.id).windowId).toBe(1);
    expect(toastText()).toBe(translate('mergedCount', { count: 1 }));
    expect(switcher.state.tabs.some((x) => x.title === 'W2')).toBe(true); // reloaded
    expect(switcher.state.undo.at(-1)).toMatchObject({ kind: 'merge', tabs: [{ id: otherWindowTab.id, windowId: 2, index: 0, pinned: true }] });
    await chrome.windows.remove(2); // Chrome closes a window a merge empties
    chrome.windows.create.mockClear();
    await switcher.undoLast();
    expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: otherWindowTab.id, focused: false });
    expect(toastText()).toBe(translate('movedBackCount', { count: 1 }));
    expect(live(otherWindowTab.id).windowId).not.toBe(1);
    expect(live(otherWindowTab.id).pinned).toBe(true);
  });

  it('says so when nothing could be merged', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    await switcher.mergeWindows([42]);
    expect(toastText()).toBe(translate('errorMerge'));
    expect(switcher.state.undo).toEqual([]);
  });
});

describe('snooze', () => {
  it('snoozeMenu offers times; picking one closes the tabs until then, with Undo', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const bravo = tabByTitle(switcher, 'B');
    const anchor = document.body.appendChild(document.createElement('button'));
    const before = Date.now();
    switcher.snoozeMenu([bravo], anchor);
    const items = allByTestId('menu-item');
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.at(-1).textContent).toBe(translate('snoozePick'));
    expect(items[0].textContent.startsWith(translate('snoozeOneHour') + ' · ')).toBe(true);
    items[0].click();
    await waitFor(() => !live(bravo.id));
    const stored = (await chrome.storage.local.get('snoozed')).snoozed;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ url: 'https://b.example/', title: 'B', windowId: 1, pinned: false });
    expect(stored[0].at).toBeGreaterThanOrEqual(before + 3600e3);
    expect(switcher.state.tabs.some((x) => x.id === bravo.id)).toBe(false);
    toastButton().click(); // Undo
    await waitFor(() => chrome._data.tabs.some((x) => x.url === 'https://b.example/'));
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://b.example/', windowId: 1, index: 1, active: false, pinned: false }); // in its place
    expect((await chrome.storage.local.get('snoozed')).snoozed).toEqual([]);
  });

  it('"Pick a time…" opens a date and time box; a time in the past is refused, a later one snoozes', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const bravo = tabByTitle(switcher, 'B');
    const anchor = document.body.appendChild(document.createElement('button'));
    switcher.snoozeMenu([bravo], anchor);
    allByTestId('menu-item').at(-1).click();
    await waitFor(() => byTestId('snooze-picker'));
    const popup = byTestId('snooze-picker');
    const input = byTestId('snooze-picker-input', popup);
    expect(popup.getAttribute('role')).toBe('dialog');
    expect(input.type).toBe('datetime-local');
    expect(document.activeElement).toBe(input);
    expect(new Date(input.value).getTime()).toBeGreaterThan(Date.now()); // starts on a time to come
    input.value = switcher.localInput(Date.now() - 3600e3);
    popup.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(byTestId('snooze-picker-error').hidden).toBe(false);
    expect(byTestId('snooze-picker-error').textContent).toBe(translate('snoozePast'));
    expect(live(bravo.id)).toBeDefined();
    const at = Date.now() + 2 * 86400e3;
    input.value = switcher.localInput(at);
    popup.dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor(() => !live(bravo.id));
    expect(byTestId('snooze-picker')).toBe(null);
    const stored = (await chrome.storage.local.get('snoozed')).snoozed;
    expect(Math.abs(stored[0].at - at)).toBeLessThan(60e3); // to the minute
  });

  it('the time box closes with Esc or Cancel, giving the focus back', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const anchor = document.body.appendChild(document.createElement('button'));
    anchor.focus();
    switcher.snoozePicker([tabByTitle(switcher, 'B')], anchor);
    byTestId('snooze-picker-cancel').click();
    expect(byTestId('snooze-picker')).toBe(null);
    expect(document.activeElement).toBe(anchor);
    switcher.snoozePicker([tabByTitle(switcher, 'B')], anchor);
    byTestId('snooze-picker').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(byTestId('snooze-picker')).toBe(null);
  });

  it("won't snooze pages that can't be reopened", async () => {
    const switcher = await boot({ tabs: [...THREE_TABS, { title: 'New', url: 'chrome://newtab/' }] });
    await switcher.snoozeTabs([tabByTitle(switcher, 'New')], Date.now() + 1000);
    expect(toastText()).toBe(translate('snoozeCant'));
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('unsnooze reopens where the tab was, or in this window if that one is gone', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    chrome.tabs.create.mockRejectedValueOnce(new Error('No window'));
    await switcher.unsnooze([{ id: 'q' }], [{ url: 'https://q.example/', windowId: 7, index: 2, pinned: true }], 0);
    expect(chrome.tabs.create.mock.calls.map((call) => call[0])).toEqual([
      { url: 'https://q.example/', windowId: 7, index: 2, active: false, pinned: true },
      { url: 'https://q.example/', windowId: 1, active: false },
    ]);
    expect(toastText()).toBe(translate('reopenedCount', { count: 1 }));
  });
});

describe('drag to reorder', () => {
  const dragEvent = (type, clientX = 0) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { setData: vi.fn(), effectAllowed: '', dropEffect: '' } });
    Object.defineProperty(event, 'clientX', { value: clientX });
    return event;
  };
  const stubBounds = (card) => { card.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 50, right: 100, bottom: 50 }); return card; };

  it('dropAfter: the right half of a card means after it', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const card = stubBounds(document.createElement('div'));
    expect(switcher.dropAfter(card, { clientX: 70 })).toBe(true);
    expect(switcher.dropAfter(card, { clientX: 30 })).toBe(false);
  });

  it('dragging one card onto the left half of another moves it there', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.state.sort = 'order'; // (By order: cards move before / after others)
    const charlie = tabByTitle(switcher, 'C');
    const from = stubBounds(document.body.appendChild(document.createElement('div')));
    const to = stubBounds(document.body.appendChild(document.createElement('div')));
    switcher.dragToMove(from, entryByTitle(switcher, 'C'));
    switcher.dragToMove(to, entryByTitle(switcher, 'A'));
    expect(from.draggable).toBe(true);
    const start = dragEvent('dragstart');
    from.dispatchEvent(start);
    expect(start.dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'https://c.example/');
    expect(from.classList.contains('dragging')).toBe(true);
    const over = dragEvent('dragover', 20);
    to.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(to.classList.contains('drop-before')).toBe(true);
    to.dispatchEvent(dragEvent('drop', 20));
    expect(to.classList.contains('drop-before')).toBe(false); // clearDrop
    await waitFor(() => chrome.tabs.move.mock.calls.length);
    expect(chrome.tabs.move).toHaveBeenCalledWith(charlie.id, { windowId: 1, index: 0 });
    await waitFor(() => order().join() === 'C,A,B');
  });

  it("dragover on a card that is itself being dragged doesn't mark a drop", async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.state.sort = 'order'; // (By order: cards move before / after others)
    const card = stubBounds(document.body.appendChild(document.createElement('div')));
    switcher.dragToMove(card, entryByTitle(switcher, 'A'));
    card.dispatchEvent(dragEvent('dragstart'));
    const over = dragEvent('dragover', 80);
    card.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    card.dispatchEvent(dragEvent('dragend'));
    expect(card.classList.contains('dragging')).toBe(false);
  });

  it('clearDrop removes every drop marker', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const element = document.body.appendChild(document.createElement('div'));
    element.className = 'drop-after x';
    switcher.clearDrop();
    expect(element.className).toBe('x');
  });

  it('moveTabs puts several tabs, in strip order, one after another before the target', async () => {
    const switcher = await boot({ tabs: [...THREE_TABS, { title: 'D', url: 'https://d.example/' }] });
    const [alpha, charlie, delta] = ['A', 'C', 'D'].map((x) => tabByTitle(switcher, x));
    switcher.state.picked.add(delta.id);
    await switcher.moveTabs([delta.id, charlie.id], alpha, false);
    expect(chrome.tabs.move.mock.calls).toEqual([[charlie.id, { windowId: 1, index: 0 }], [delta.id, { windowId: 1, index: 1 }]]);
    expect(order()).toEqual(['C', 'D', 'A', 'B']);
    expect(switcher.state.picked.size).toBe(0);
  });

  it('moveTabs counts the gap a tab leaves when it moves right', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const [alpha, charlie] = [tabByTitle(switcher, 'A'), tabByTitle(switcher, 'C')];
    await switcher.moveTabs([alpha.id], charlie, true);
    expect(chrome.tabs.move).toHaveBeenCalledWith(alpha.id, { windowId: 1, index: 2 }); // after C, which is the last place
  });
});

describe('sleep, pin, mute', () => {
  it('sleepTabs marks background tabs (not the current one), and again unmarks', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const [alpha, bravo] = [tabByTitle(switcher, 'A'), tabByTitle(switcher, 'B')];
    await switcher.sleepTabs([alpha, bravo]);
    expect([...switcher.state.toSleep]).toEqual([bravo.id]);
    expect(toastText()).toBe(translate('sleepLaterCount', { count: 1 }));
    expect(cardOf('B').classList.contains('asleep')).toBe(true);
    await switcher.sleepTabs([bravo]);
    expect(switcher.state.toSleep.size).toBe(0);
    expect(toastText()).toBe(translate('sleepUndone'));
    await switcher.sleepTabs([alpha]);
    expect(toastText()).toBe(translate('sleptNone'));
  });

  it('pinTabs pins them all, or unpins when all are pinned', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const tabs = [tabByTitle(switcher, 'B'), tabByTitle(switcher, 'C')];
    await switcher.pinTabs(tabs);
    expect(tabs.map((x) => live(x.id).pinned)).toEqual([true, true]);
    expect(toastText()).toBe(translate('pinnedCount', { count: 2 }));
    await switcher.pinTabs(switcher.state.tabs.filter((x) => x.pinned));
    expect(tabs.map((x) => live(x.id).pinned)).toEqual([false, false]);
  });

  it('muteTabs mutes them all, or unmutes when all are muted', async () => {
    const switcher = await boot({ tabs: [THREE_TABS[0], { ...THREE_TABS[1], mutedInfo: { muted: true } }, THREE_TABS[2]] });
    const tabs = [tabByTitle(switcher, 'B'), tabByTitle(switcher, 'C')];
    await switcher.muteTabs(tabs);
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabs[0].id, { muted: true });
    expect(toastText()).toBe(translate('mutedCount', { count: 2 }));
    await switcher.muteTabs([tabByTitle(switcher, 'B'), tabByTitle(switcher, 'C')]);
    expect(tabs.map((x) => live(x.id).mutedInfo.muted)).toEqual([false, false]);
  });

  it('isMuted reads mutedInfo', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    expect(switcher.isMuted({ mutedInfo: { muted: true } })).toBe(true);
    expect(switcher.isMuted({ mutedInfo: { muted: false } })).toBe(false);
    expect(switcher.isMuted({})).toBe(false);
  });

  it('audioBadge: a speaker that mutes, a crossed-out one that unmutes', async () => {
    const switcher = await boot({ tabs: [THREE_TABS[0], { ...THREE_TABS[1], audible: true }] });
    const bravo = tabByTitle(switcher, 'B');
    const badge = switcher.audioBadge(bravo);
    expect(badge.className).toBe('badge audio on');
    expect(badge.title).toBe(translate('tabMute'));
    expect(switcher.audioBadge({ mutedInfo: { muted: true } }).title).toBe(translate('tabUnmute'));
    expect(byTestId('card-audio', cardOf('B'))).not.toBe(null); // drawn on playing tabs
    badge.click();
    await waitFor(() => live(bravo.id).mutedInfo.muted);
  });

  it('toggleMute flips one tab and shows it at once', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const bravo = tabByTitle(switcher, 'B');
    await switcher.toggleMute(bravo);
    expect(chrome.tabs.update).toHaveBeenCalledWith(bravo.id, { muted: true });
    expect(switcher.isMuted(tabByTitle(switcher, 'B'))).toBe(true);
    expect(byTestId('card-audio', cardOf('B'))).not.toBe(null);
  });

  it('togglePin tries once more when Chrome is busy', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const bravo = tabByTitle(switcher, 'B');
    chrome.tabs.update.mockRejectedValueOnce(new Error('Tabs cannot be edited right now'));
    await switcher.togglePin(bravo);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(2);
    expect(live(bravo.id).pinned).toBe(true);
    expect(toastText()).toBe(translate('pinnedOne', { title: 'B' }));
  });

  it('togglePin says what failed when Chrome refuses twice', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    chrome.tabs.update.mockRejectedValueOnce(new Error('busy')).mockRejectedValueOnce(new Error('still busy'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await switcher.togglePin(tabByTitle(switcher, 'B'));
    expect(toastText()).toBe(translate('errorPin'));
  });

  it('a speaker Chrome refuses to mute says so', async () => {
    await boot({ tabs: [THREE_TABS[0], { ...THREE_TABS[1], audible: true }] });
    chrome.tabs.update.mockRejectedValueOnce(new Error('no'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    byTestId('card-audio', cardOf('B')).click();
    await waitFor(() => toastText() === translate('errorMute'));
  });
});

describe('one-tab quick buttons', () => {
  it('reloadTab reloads and says so; on the overlay tab it closes the switcher', async () => {
    let switcher = await boot({ tabs: THREE_TABS });
    await switcher.reloadTab(tabByTitle(switcher, 'B'));
    expect(chrome.tabs.reload).toHaveBeenCalledWith(tabByTitle(switcher, 'B').id);
    expect(toastText()).toBe(translate('reloadingOne', { title: 'B' }));
    expect(switcher.state.done).toBe(false);
    switcher = await boot({ tabs: THREE_TABS, overlay: true });
    await switcher.reloadTab(tabByTitle(switcher, 'A'));
    expect(closedMessage().reason).toBe('cancel');
  });

  it('duplicateTab opens a copy right after it, in the background', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const bravo = tabByTitle(switcher, 'B');
    await switcher.duplicateTab(bravo);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://b.example/', windowId: 1, index: 2, active: false, pinned: false, openerTabId: bravo.id });
    expect(switcher.state.tabs.filter((x) => x.url === 'https://b.example/')).toHaveLength(2);
    expect(toastText()).toBe(translate('duplicatedOne', { title: 'B' }));
  });

  it('quickActions: only pin, snooze, archive, the note and ⋯ (its menu has the rest)', async () => {
    const switcher = await boot({ tabs: [THREE_TABS[0], { ...THREE_TABS[1], pinned: true }, { ...THREE_TABS[2], audible: true }] });
    const labels = (entry) => [...switcher.quickActions(entry).children].map((button) => button.dataset.testid);
    const bravoEntry = entryByTitle(switcher, 'B');
    expect(labels(bravoEntry)).toEqual(['quick-pin', 'quick-clock', 'quick-archive', 'quick-note', 'quick-more']);
    expect(labels(entryByTitle(switcher, 'C'))).toEqual(labels(bravoEntry)); // a playing tab mutes with its speaker, in the header
    const box = switcher.quickActions(bravoEntry);
    expect(byTestId('quick-pin', box).title).toBe(translate('tabUnpin'));
    expect(byTestId('quick-pin', box).classList.contains('on')).toBe(true);
    expect(byTestId('quick-more', box).title).toBe(translate('cardMenu'));
    expect(byTestId('quick-more', box).getAttribute('aria-haspopup')).toBe('menu');
  });

  it('⋯ opens the card menu at the button, the same one as Shift+F10', async () => {
    await boot({ tabs: THREE_TABS });
    byTestId('quick-more', cardOf('B')).click();
    await waitFor(() => byTestId('menu'));
    expect(byTestId('menu').anchor).toBe(byTestId('quick-more', cardOf('B')));
    const items = allByTestId('menu-item').map((menuItem) => menuItem.textContent);
    expect(items).toContain(translate('copyLink'));
    expect(items).toContain(translate('tabReload'));
    expect(items).toContain(translate('tabClose'));
    allByTestId('menu-item').find((menuItem) => menuItem.textContent === translate('copyLink')).click();
    await waitFor(() => clipboard.writeText.mock.calls.length);
    expect(clipboard.writeText).toHaveBeenCalledWith('https://b.example/');
  });

  it('every item of the card menu has an icon before its label', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    switcher.cardMenu(entryByTitle(switcher, 'B'));
    const items = allByTestId('menu-item');
    expect(items.length).toBeGreaterThan(8);
    for (const menuItem of items) {
      const icon = byTestId('menu-item-icon', menuItem);
      expect(icon, menuItem.textContent).toBeTruthy();
      expect(icon.querySelector('svg')).toBeTruthy();
      expect(menuItem.firstElementChild).toBe(icon);
      expect(byTestId('menu-item-label', menuItem).textContent).toBe(menuItem.textContent); // the icon adds no text
    }
  });

  it('a failing quick button says what failed', async () => {
    await boot({ tabs: THREE_TABS });
    chrome.tabs.update.mockRejectedValue(new Error('nope'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    byTestId('quick-pin', cardOf('B')).click();
    await waitFor(() => toastText() === translate('errorPin'));
  });

  it('a failing menu item says what failed', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    chrome.tabs.reload.mockRejectedValueOnce(new Error('nope'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    switcher.cardMenu(entryByTitle(switcher, 'B'));
    allByTestId('menu-item').find((menuItem) => menuItem.textContent === translate('tabReload')).click();
    await waitFor(() => toastText() === translate('errorReload'));
  });
});

describe('duplicates', () => {
  const DUPLICATE_TABS = [THREE_TABS[0], { title: 'D1', url: 'https://dup.example/' }, { title: 'D2', url: 'https://dup.example/#x' }];

  it('closeDupes first shows the copies, then closes all but one (with Undo)', async () => {
    const switcher = await boot({ tabs: DUPLICATE_TABS });
    await switcher.closeDuplicates();
    expect(switcher.state.duplicatesView).toBe(true);
    expect(switcher.state.entries.map((entry) => entry.tab.title)).toEqual(['D1', 'D2']);
    expect(byTestId('actions').classList.contains('duplicates')).toBe(true);
    expect(byTestId('duplicates-close-label').textContent).toBe(translate('duplicatesClose', { count: 1 }));
    await switcher.closeDuplicates();
    expect(order()).toEqual(['A', 'D1']); // the most recently used copy stays
    expect(switcher.state.duplicatesView).toBe(false);
    expect(toastButton().textContent).toMatch(/^Undo/);
  });

  it('dupesView(false) goes back and drops ticks', async () => {
    const switcher = await boot({ tabs: DUPLICATE_TABS });
    switcher.duplicatesView(true);
    switcher.state.picked.add(1);
    switcher.duplicatesView(false);
    expect(switcher.state.picked.size).toBe(0);
    expect(switcher.state.entries).toHaveLength(3);
  });
});

describe('star and capture', () => {
  it('star toggles the page in Tabazing’s stars', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    await switcher.star(entryByTitle(switcher, 'B'));
    expect(Object.keys((await chrome.storage.local.get('stars')).stars)).toEqual(['https://b.example/']);
    expect(switcher.isStarred('https://b.example/')).toBe(true);
    expect(byTestId('card-star-button', cardOf('B')).classList.contains('on')).toBe(true);
    await switcher.star(entryByTitle(switcher, 'B'));
    expect(switcher.state.stars).toEqual({});
  });

  it('star ignores closed windows', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    await switcher.star({ kind: 'closed', url: 'https://w/', item: { kind: 'window', url: 'https://w/', title: 'W' } });
    expect((await chrome.storage.local.get('stars')).stars).toBeUndefined();
  });

  it('captureOne asks the background for a preview and shows it', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    const bravoEntry = entryByTitle(switcher, 'B');
    chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.type === MESSAGE.CAPTURE_ONE) await chrome.storage.local.set({ 'pv:https://b.example/': { img: 'data:image/jpeg;base64,BBBB', t: Date.now() } });
    });
    await switcher.captureOne(bravoEntry);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.CAPTURE_ONE, tabId: bravoEntry.tab.id });
    expect(switcher.state.previews[bravoEntry.tab.id].img).toBe('data:image/jpeg;base64,BBBB');
    expect(switcher.state.capturing).toBe(null);
    expect(byTestId('card-preview', cardOf('B')).src).toBe('data:image/jpeg;base64,BBBB');
  });

  it('captureOne says so when no preview came back', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    await switcher.captureOne(entryByTitle(switcher, 'B'));
    expect(toastText()).toBe(translate('captureFailed'));
  });

  it('captureOne from an overlay in the same window leaves and asks to be reopened where it was', async () => {
    const switcher = await boot({ tabs: THREE_TABS, overlay: true });
    const bravoEntry = entryByTitle(switcher, 'B');
    await switcher.captureOne(bravoEntry);
    expect((await chrome.storage.session.get('resume')).resume).toMatchObject({ key: bravoEntry.key, query: '', scope: 'all', starred: false });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.CAPTURE_ONE, tabId: bravoEntry.tab.id, reopen: tabByTitle(switcher, 'A').id });
    expect(closedMessage().reason).toBe('switch');
  });

  it("captureOne skips pages it can't capture", async () => {
    const switcher = await boot({ tabs: [...THREE_TABS, { title: 'Ext', url: 'chrome://extensions/' }] });
    chrome.runtime.sendMessage.mockClear();
    await switcher.captureOne(entryByTitle(switcher, 'Ext'));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('undo and ticks after snoozing, archiving and other actions', () => {
  const GROUPED = [{ title: 'A', url: 'https://a.example/' }, { title: 'W1', url: 'https://w1.example/', groupId: 7 }, { title: 'W2', url: 'https://w2.example/', groupId: 7 }, { title: 'C', url: 'https://c.example/' }];
  const FOUR_TABS = [...THREE_TABS, { title: 'D', url: 'https://d.example/' }];
  const urlOrder = () => chrome._data.tabs.filter((x) => x.windowId === 1).sort((first, second) => first.index - second.index).map((x) => x.url);

  it('a tab whose address is too long to keep is left open, not lost', async () => {
    const longUrl = 'https://long.example/?q=' + 'x'.repeat(3000);
    const switcher = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'Long', url: longUrl }] });
    await switcher.snoozeTabs([tabByTitle(switcher, 'Long')], Date.now() + 3600e3);
    expect(chrome._data.tabs.some((x) => x.url === longUrl)).toBe(true);
    expect(toastText()).toBe(translate('snoozeCant'));
  });

  it('Undo of a snooze puts the tabs back in their place, an unnamed group as one group', async () => {
    const switcher = await boot({ tabs: GROUPED, beforeImport: () => { chrome._addGroup({ id: 7, title: '', color: 'blue', windowId: 1 }); } });
    await switcher.snoozeTabs([tabByTitle(switcher, 'W1'), tabByTitle(switcher, 'W2')], Date.now() + 3600e3);
    toastButton().click();
    await waitFor(() => toastText() === translate('reopenedCount', { count: 2 }));
    expect(urlOrder()).toEqual(['https://a.example/', 'https://w1.example/', 'https://w2.example/', 'https://c.example/']);
    expect(new Set(chrome._data.tabs.filter((x) => x.url.startsWith('https://w')).map((x) => x.groupId)).size).toBe(1);
    expect((await chrome.storage.local.get('snoozed')).snoozed || []).toEqual([]);
  });

  it('Undo of an archive brings the tab back through Chrome (its history; it leaves Recently closed)', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    await switcher.archiveTabs([tabByTitle(switcher, 'B')]);
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000), tab: { sessionId: 's-b', url: 'https://b.example/', title: 'B' } }];
    toastButton().click();
    await waitFor(() => toastText() === translate('reopenedCount', { count: 1 }));
    expect(chrome.sessions.restore).toHaveBeenCalledWith('s-b');
  });

  it('in an overlay, Undo reopens a tab of its own window without Chrome showing it (that would close the overlay)', async () => {
    const switcher = await boot({ tabs: THREE_TABS, overlay: true });
    await switcher.closeTab(entryByTitle(switcher, 'B'));
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000), tab: { sessionId: 's-b', url: 'https://b.example/', title: 'B' } }];
    await switcher.undoLast();
    expect(chrome.sessions.restore).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://b.example/', index: 1, active: false }));
    expect(switcher.state.done).toBe(false);
    expect(Object.keys((await chrome.storage.local.get('closedHidden')).closedHidden || {})).toHaveLength(1); // Chrome's entry: off the list
  });

  it('Ctrl+Z after archiving takes the archive back, not a close made before it', async () => {
    const switcher = await boot({ tabs: THREE_TABS });
    await switcher.closeTab(entryByTitle(switcher, 'A'));
    await switcher.archiveTabs([tabByTitle(switcher, 'C')]);
    byTestId('search').focus();
    key('z', { code: 'KeyZ', ctrlKey: true });
    await waitFor(() => toastText() === translate('reopenedCount', { count: 1 }));
    expect(urlOrder()).toEqual(['https://b.example/', 'https://c.example/']);
  });

  it('archiving one card from its button keeps the other ticks working', async () => {
    await boot({ tabs: FOUR_TABS });
    byTestId('card-pick', cardOf('A')).click();
    byTestId('card-pick', cardOf('C')).click();
    byTestId('quick-archive', cardOf('B')).click();
    await waitFor(() => !cardOf('B'));
    byTestId('action-close').click();
    await waitFor(() => chrome._data.tabs.length === 1);
    expect(chrome._data.tabs.map((x) => x.title)).toEqual(['D']);
  });

  it('Sleep from one card’s menu keeps the other ticks', async () => {
    const switcher = await boot({ tabs: FOUR_TABS });
    byTestId('card-pick', cardOf('A')).click();
    byTestId('card-pick', cardOf('C')).click();
    byTestId('quick-more', cardOf('D')).click();
    allByTestId('menu-item').find((item) => item.textContent === translate('sleepThis')).click();
    await tick(20);
    expect(switcher.state.picked.size).toBe(2);
  });

  it('a copy of the last tab of a group stays in the group', async () => {
    const switcher = await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'W1', url: 'https://w1.example/', groupId: 7 }], beforeImport: () => { chrome._addGroup({ id: 7, title: 'Work', color: 'blue', windowId: 1 }); } });
    chrome.tabs.create.mockImplementationOnce(async (properties) => ({ ...chrome._addTab({ url: properties.url, windowId: properties.windowId }), groupId: -1 })); // (as Chrome does after a group's last tab)
    await switcher.duplicateTab(tabByTitle(switcher, 'W1'));
    expect(chrome.tabs.group).toHaveBeenCalledWith(expect.objectContaining({ groupId: 7 }));
  });

  it('a snoozed tab woken from its card goes back into its group', async () => {
    const snoozed = { id: 'z1', url: 'https://snooze.example/', title: 'Snz', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now(), group: { id: 7, title: 'Work', color: 'blue' } };
    await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'W1', url: 'https://w1.example/', groupId: 7 }], beforeImport: async () => { chrome._addGroup({ id: 7, title: 'Work', color: 'blue', windowId: 1 }); await chrome.storage.local.set({ snoozed: [snoozed] }); } });
    cardOf('Snz', 'snoozed').click();
    await waitFor(() => chrome._data.tabs.some((x) => x.url === 'https://snooze.example/' && x.groupId === 7));
  });

  it('the × of a snoozed card offers Undo, which snoozes it again', async () => {
    const snoozed = { id: 'z1', url: 'https://snooze.example/', title: 'Snz', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() };
    await boot({ tabs: THREE_TABS, beforeImport: () => chrome.storage.local.set({ snoozed: [snoozed] }) });
    byTestId('card-cancel-snooze').click();
    await waitFor(() => !byTestId('card-snoozed'));
    toastButton().click();
    await waitFor(() => byTestId('card-snoozed'));
    expect((await chrome.storage.local.get('snoozed')).snoozed.map((x) => x.id)).toEqual(['z1']);
  });

  it('Shift+click ticks a group tile that lies inside the range', async () => {
    await boot({ tabs: [{ title: 'A', url: 'https://a.example/' }, { title: 'W1', url: 'https://w1.example/', groupId: 7 }, { title: 'W2', url: 'https://w2.example/', groupId: 7 }, { title: 'B', url: 'https://b.example/' }],
      preferences: { sort: 'order' }, beforeImport: () => { chrome._addGroup({ id: 7, title: 'Work', color: 'blue', windowId: 1 }); } });
    byTestId('card-pick', cardOf('A')).click();
    byTestId('card-pick', cardOf('B')).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(byTestId('card-group').getAttribute('aria-checked')).toBe('true');
  });
});
