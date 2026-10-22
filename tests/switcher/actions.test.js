// Actions on tabs in the switcher: opening, closing (with undo), ticking, the quick-actions bar and the
// per-card quick buttons. Everything runs against the real switcher page and the fake chrome.* API.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tick, waitFor } from '../helpers/switcher.js';
import { boot, frame, tid, tids, cardOf, tabByTitle, entryByTitle, toastText, toastButton, closedMsg } from '../helpers/quiet-boot.js';
import { MSG } from '../../utils/constants.js';
import { t } from '../../utils/translations.js';

const ABC = [
  { title: 'A', url: 'https://a.example/' },
  { title: 'B', url: 'https://b.example/' },
  { title: 'C', url: 'https://c.example/' },
];
const live = (id) => chrome._data.tabs.find((x) => x.id === id);
const order = (win = 1) => chrome._data.tabs.filter((x) => x.windowId === win).sort((a, b) => a.index - b.index).map((x) => x.title);

let clipboard;
beforeEach(() => {
  clipboard = { writeText: vi.fn(async () => {}) };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
});

describe('finish', () => {
  it('tells the background once, refocuses the source window on cancel, and closes the popup', async () => {
    const sw = await boot({ tabs: ABC });
    chrome.runtime.sendMessage.mockClear();
    await sw.finish('cancel');
    await sw.finish('switch'); // runs once
    const msgs = chrome.runtime.sendMessage.mock.calls.map((c) => c[0]);
    expect(msgs).toEqual([expect.objectContaining({ type: MSG.CLOSED, reason: 'cancel', src: tabByTitle(sw, 'A').id, win: 1 })]);
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(window.close).toHaveBeenCalledTimes(1);
    expect(sw.state.done).toBe(true);
  });

  it('sends the tabs marked for sleep along', async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.toSleep.add(tabByTitle(sw, 'B').id);
    await sw.finish('switch');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG.SLEEP, tabIds: [tabByTitle(sw, 'B').id] });
    expect(chrome.windows.update).not.toHaveBeenCalled(); // only 'cancel' refocuses
  });

  it('in an overlay posts "close" to the page instead of closing a window', async () => {
    const sw = await boot({ tabs: ABC, overlay: true });
    
    await sw.finish('cancel');
    expect(frame().postMessage).toHaveBeenCalledWith({ tabazing: 'close' }, '*');
    expect(window.close).not.toHaveBeenCalled();
  });
});

describe('choose', () => {
  it('switches to an open tab and focuses its window', async () => {
    const sw = await boot({ tabs: ABC });
    const b = tabByTitle(sw, 'B');
    await sw.choose(sw.state.entries.findIndex((e) => e.tab && e.tab.id === b.id));
    expect(chrome.tabs.update).toHaveBeenCalledWith(b.id, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(live(b.id).active).toBe(true);
    expect(closedMsg().reason).toBe('switch');
  });

  it('on the current tab in an overlay just cancels', async () => {
    const sw = await boot({ tabs: ABC, overlay: true });
    await sw.choose(sw.state.entries.findIndex((e) => e.tab && e.tab.title === 'A'));
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(closedMsg().reason).toBe('cancel');
  });

  it('wakes a snoozed tab: out of the list, into a new tab', async () => {
    const snz = { id: 'z1', url: 'https://snz.example/', title: 'Snz', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() };
    const sw = await boot({ tabs: ABC, beforeImport: () => chrome.storage.local.set({ snoozed: [snz] }) });
    const i = sw.state.entries.findIndex((e) => e.kind === 'snoozed');
    expect(i).toBeGreaterThan(0);
    await sw.choose(i);
    expect((await chrome.storage.local.get('snoozed')).snoozed).toEqual([]);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: snz.url, windowId: 1, active: true });
    expect(closedMsg().reason).toBe('switch');
  });

  it('opens a starred page that is not open', async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.entries.push({ kind: 'star', key: 'stx', item: { id: 'x', url: 'https://star.example/', title: 'S' } });
    await sw.choose(sw.state.entries.length - 1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://star.example/', windowId: 1, active: true });
    expect(closedMsg().reason).toBe('switch');
  });

  it("restores a recently closed tab through Chrome's session when it has one", async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.entries.push({ kind: 'closed', key: 'c1', item: { url: 'https://gone.example/', session: { tab: { sessionId: 's9' } } } });
    await sw.choose(sw.state.entries.length - 1);
    expect(chrome.sessions.restore).toHaveBeenCalledWith('s9');
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(closedMsg().reason).toBe('restore');
  });

  it('reopens a closed page from our own log (no session) as a new tab', async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.entries.push({ kind: 'closed', key: 'c2', item: { url: 'https://log.example/', session: null } });
    await sw.choose(sw.state.entries.length - 1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://log.example/', windowId: 1, active: true });
    expect(closedMsg().reason).toBe('restore');
  });

  it('cancels when Chrome refuses, and does nothing once done', async () => {
    const sw = await boot({ tabs: ABC });
    chrome.tabs.update.mockRejectedValueOnce(new Error('gone'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sw.choose(1);
    expect(closedMsg().reason).toBe('cancel');
    chrome.tabs.update.mockClear();
    await sw.choose(1);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});

describe('no "click again" confirmations', () => {
  it('everything that closes or moves tabs has Undo instead, so nothing asks twice', async () => {
    const sw = await boot({ tabs: ABC });
    expect(sw.armed).toBeUndefined();
    expect('armed' in sw.state).toBe(false);
  });
});

describe('closeTab', () => {
  it('closes the tab, keeps the selection next to it, and offers Undo', async () => {
    const sw = await boot({ tabs: ABC });
    const b = entryByTitle(sw, 'B');
    sw.select(sw.state.entries.indexOf(b));
    await sw.closeTab(b);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(b.tab.id);
    expect(live(b.tab.id)).toBeUndefined();
    expect(sw.state.tabs.map((x) => x.title)).toEqual(['A', 'C']);
    expect(sw.state.entries[sw.state.sel].tab.title).toBe('C');
    expect(sw.state.undo.at(-1)).toMatchObject({ kind: 'close', tabs: [{ id: b.tab.id, url: 'https://b.example/', windowId: 1, index: 1, pinned: false }] });
    expect(toastText()).toBe(t('closedN', { count: 1 }));
    expect(toastButton().textContent).toMatch(/^Undo/);
  });

  it('cancels a snooze on a snoozed card (the tab is not reopened)', async () => {
    const snz = { id: 'z1', url: 'https://snz.example/', title: 'Snz', at: Date.now() + 3600e3, windowId: 1, pinned: false, t: Date.now() };
    const sw = await boot({ tabs: ABC, beforeImport: () => chrome.storage.local.set({ snoozed: [snz] }) });
    await sw.closeTab(sw.state.entries.find((e) => e.kind === 'snoozed'));
    expect(sw.state.snoozed).toEqual([]);
    expect((await chrome.storage.local.get('snoozed')).snoozed).toEqual([]);
    expect(sw.state.entries.some((e) => e.kind === 'snoozed')).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(toastText()).toBe(t('snoozeCancelled'));
  });

  it('unstars a starred page that is not open', async () => {
    const stars = { 'https://star.example/': { u: 'https://star.example/', ti: 'S', t: Date.now() } };
    const sw = await boot({ tabs: ABC, beforeImport: () => chrome.storage.local.set({ stars }) });
    await sw.closeTab({ kind: 'star', key: 'st1', url: 'https://star.example/', item: { url: 'https://star.example/', title: 'S' } });
    expect((await chrome.storage.local.get('stars')).stars).toEqual({});
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it("in an overlay, closing the tab it sits on pushes no undo (it closes with it)", async () => {
    const sw = await boot({ tabs: ABC, overlay: true });
    await sw.closeTab(entryByTitle(sw, 'A'));
    expect(chrome.tabs.remove).toHaveBeenCalled();
    expect(sw.state.undo).toEqual([]);
  });
});

describe('forgetTab', () => {
  it('drops the tab, shifts the ones after it, unticks it, and selects its neighbour', async () => {
    const sw = await boot({ tabs: ABC });
    const b = tabByTitle(sw, 'B');
    sw.state.picked.add(b.id);
    sw.select(sw.state.entries.findIndex((e) => e.tab === b));
    sw.forgetTab(b.id);
    expect(sw.state.tabs.map((x) => x.title)).toEqual(['A', 'C']);
    expect(tabByTitle(sw, 'C').index).toBe(1);
    expect(sw.state.picked.has(b.id)).toBe(false);
    expect(sw.state.windows[0].count).toBe(2);
    expect(sw.state.entries[sw.state.sel].tab.title).toBe('C');
    sw.forgetTab(999); // unknown: nothing happens
    expect(sw.state.tabs).toHaveLength(2);
  });
});

describe('ticking tabs', () => {
  it('pickBox draws a checkbox that ticks its card', async () => {
    const sw = await boot({ tabs: ABC });
    const e = entryByTitle(sw, 'C');
    const b = sw.pickBox(e, false);
    expect(b.getAttribute('role')).toBe('checkbox');
    expect(b.getAttribute('aria-checked')).toBe('false');
    expect(sw.pickBox(e, true).className).toBe('pick on');
    b.click();
    expect(sw.state.picked.has(e.tab.id)).toBe(true);
    expect(cardOf('C').classList.contains('picked')).toBe(true);
  });

  it('pick toggles one card, and a range from the last one', async () => {
    const sw = await boot({ tabs: ABC });
    const [a, b, c] = ['A', 'B', 'C'].map((x) => entryByTitle(sw, x));
    sw.pick(a);
    sw.pick(entryByTitle(sw, 'C'), { range: true });
    expect([...sw.state.picked].sort()).toEqual([a.tab.id, b.tab.id, c.tab.id].sort());
    sw.pick(entryByTitle(sw, 'B'));
    expect(sw.state.picked.has(b.tab.id)).toBe(false);
    expect(sw.state.lastPick).toBe(b.tab.id);
  });

  it('selectAll ticks the cards, or only the search matches; clearPicks unticks', async () => {
    const sw = await boot({ tabs: ABC });
    expect(sw.pickPool()).toBe(sw.state.matches);
    sw.selectAll();
    expect(sw.state.picked.size).toBe(3);
    sw.clearPicks();
    expect(sw.state.picked.size).toBe(0);
    expect(sw.state.lastPick).toBe(null);
    const sw2 = await boot({ tabs: [{ title: 'Alpha', url: 'https://alpha.test/' }, { title: 'Bravo', url: 'https://bravo.test/' }] });
    sw2.state.query = 'bravo';
    sw2.refresh();
    expect(sw2.pickPool()).toBe(sw2.state.found);
    sw2.selectAll();
    expect(sw2.targets().map((x) => x.title)).toEqual(['Bravo']);
  });

  it('targets are the ticked tabs, in list order', async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.picked.add(tabByTitle(sw, 'C').id).add(tabByTitle(sw, 'A').id);
    expect(sw.targets().map((x) => x.title)).toEqual(['A', 'C']);
  });
});

describe('the quick-actions bar', () => {
  it('shows with tabs ticked; Close closes them at once (Undo brings them back)', async () => {
    const sw = await boot({ tabs: ABC });
    sw.pick(entryByTitle(sw, 'B'));
    sw.pick(entryByTitle(sw, 'C'));
    expect(tid('acts').hidden).toBe(false);
    expect(tid('acts-n').textContent).toBe(t('pickedN', { count: 2 }));
    tid('action-close').click();
    await waitFor(() => chrome.tabs.remove.mock.calls.length);
    expect(order()).toEqual(['A']);
    expect(toastButton().textContent).toMatch(/^Undo/);
  });

  it('lists every action, the rarer ones under More, each with its own error note', async () => {
    const sw = await boot({ tabs: ABC });
    expect(sw.ACTIONS.map((a) => a.id)).toEqual(['close', 'copy', 'md', 'win', 'sleep', 'snooze', 'archive', 'group', 'bookmark', 'pin', 'mute']);
    expect(sw.ACTIONS.filter((a) => !a.more).map((a) => a.id)).toEqual(['close', 'copy']);
    expect(sw.ACTIONS.every((a) => !a.confirm)).toBe(true);
    expect(Object.fromEntries(sw.ACTIONS.map((a) => [a.id, a.err()]))).toEqual({
      close: t('errClose'), copy: t('copyFailed'), md: t('copyFailed'), win: t('errMove'), sleep: t('errSleep'),
      snooze: t('errSnooze'), archive: t('errArchive'), group: t('actFailed'), bookmark: t('markErr'), pin: t('errPin'), mute: t('errMute'),
    });
    const pin = sw.ACTIONS.find((a) => a.id === 'pin');
    expect(pin.label([{ pinned: true }])).toBe(t('actUnpin'));
    expect(pin.label([{ pinned: true }, { pinned: false }])).toBe(t('actPin'));
    const mute = sw.ACTIONS.find((a) => a.id === 'mute');
    expect(mute.label([{ mutedInfo: { muted: true } }])).toBe(t('actUnmute'));
    expect(mute.label([])).toBe(t('actMute'));
  });

  it("More opens a menu of the rarer actions, and its items act on the ticked tabs", async () => {
    const sw = await boot({ tabs: ABC });
    sw.pick(entryByTitle(sw, 'B'));
    tid('actions-more').click();
    const items = tids('menu-item').map((b) => b.textContent);
    expect(items).toEqual([t('actCopyMd'), t('actNewWindow'), t('actSleep'), t('actSnooze'), t('actArchive'), t('groupAddTo'), t('markMenu'), t('actPin'), t('actMute')]);
    tids('menu-item')[7].click(); // Pin
    await waitFor(() => live(tabByTitle(sw, 'B')?.id ?? 2).pinned);
  });

  it.each([
    ['copy', (tabs) => expect(clipboard.writeText).toHaveBeenCalledWith(tabs.map((x) => x.url).join('\n'))],
    ['md', () => expect(clipboard.writeText).toHaveBeenCalledWith('- [B](https://b.example/)\n- [C](https://c.example/)')],
    ['sleep', (tabs, sw) => expect([...sw.state.toSleep]).toEqual(tabs.map((x) => x.id))],
    ['pin', (tabs) => expect(tabs.map((x) => live(x.id).pinned)).toEqual([true, true])],
    ['mute', (tabs) => expect(tabs.map((x) => live(x.id).mutedInfo.muted)).toEqual([true, true])],
    ['close', (tabs) => expect(tabs.map((x) => live(x.id))).toEqual([undefined, undefined])],
    ['win', (tabs) => { expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: tabs[0].id, focused: false }); expect(closedMsg()).toBeUndefined(); }],
    ['archive', (tabs) => expect(chrome.bookmarks.create).toHaveBeenCalledWith(expect.objectContaining({ url: tabs[1].url }))],
    ['snooze', () => expect(tids('menu-item').length).toBeGreaterThanOrEqual(4)],
  ])('%s runs on the tabs it is given', async (id, check) => {
    const sw = await boot({ tabs: ABC });
    const tabs = [tabByTitle(sw, 'B'), tabByTitle(sw, 'C')];
    const anchor = document.body.appendChild(document.createElement('button'));
    await sw.ACTIONS.find((a) => a.id === id).run(tabs, anchor);
    check(tabs, sw);
  });
});

describe('undo', () => {
  it('undoRecord keeps where each tab was', async () => {
    const sw = await boot({ tabs: [...ABC, { title: 'P', url: 'https://p.example/', pinned: true }] });
    const p = tabByTitle(sw, 'P');
    expect(sw.undoRecord([p])).toEqual([{ id: p.id, url: 'https://p.example/', windowId: 1, index: 3, pinned: true }]);
  });

  it('pushUndo keeps the last 20 and ignores empty ones; the note says what it undoes', async () => {
    const sw = await boot({ tabs: ABC });
    sw.pushUndo([]);
    expect(sw.state.undo).toEqual([]);
    for (let i = 0; i < 21; i++) sw.pushUndo([{ url: 'https://x/' + i, windowId: 1, index: 0, pinned: false }]);
    expect(sw.state.undo).toHaveLength(20);
    expect(sw.state.undo[0].tabs[0].url).toBe('https://x/1');
    expect(sw.state.undo[0].kind).toBe('close');
    sw.pushUndo([{ id: 1, url: 'https://x/', windowId: 2, index: 0, pinned: false }], 'merge');
    expect(toastText()).toBe(t('mergedN', { count: 1 }));
    sw.pushUndo([{ id: 1, url: 'https://x/', windowId: 1, index: 0, pinned: false }], 'move');
    expect(toastText()).toBe(t('movedN', { count: 1 }));
  });

  it('undoLast reopens the last closing where it was, in the background, when Chrome no longer lists it', async () => {
    const sw = await boot({ tabs: ABC });
    await sw.closeTab(entryByTitle(sw, 'B'));
    chrome.tabs.create.mockClear();
    await sw.undoLast();
    expect(chrome.sessions.restore).not.toHaveBeenCalled();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://b.example/', windowId: 1, index: 1, pinned: false, active: false });
    expect(sw.state.tabs.map((x) => x.url)).toContain('https://b.example/');
    expect(toastText()).toBe(t('reopenedN', { count: 1 }));
    await sw.undoLast();
    expect(toastText()).toBe(t('undoNothing'));
  });

  it("undoLast brings a tab Chrome closed just now back through Chrome's sessions (its history too), and shows the tab that was showing", async () => {
    const sw = await boot({ tabs: ABC });
    const b = entryByTitle(sw, 'B');
    await sw.closeTab(b);
    const now = Math.floor(Date.now() / 1000);
    chrome._data.closed = [
      { lastModified: now - 3600, tab: { sessionId: 'old', url: 'https://b.example/', title: 'B' } }, // the same page, long ago: not this one
      { lastModified: now, tab: { sessionId: 's-b', url: 'https://b.example/', title: 'B' } },
    ];
    chrome.tabs.create.mockClear();
    chrome.tabs.update.mockClear();
    await sw.undoLast();
    expect(chrome.sessions.restore).toHaveBeenCalledWith('s-b');
    expect(chrome.sessions.restore).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabByTitle(sw, 'A').id, { active: true }); // the window shows its tab again
    expect(sw.asking).toBe(false);
  });

  it('a restore Chrome refuses falls back to opening the page', async () => {
    const sw = await boot({ tabs: ABC });
    await sw.closeTab(entryByTitle(sw, 'C'));
    chrome._data.closed = [{ lastModified: Math.floor(Date.now() / 1000), tab: { sessionId: 's-c', url: 'https://c.example/', title: 'C' } }];
    chrome.sessions.restore.mockRejectedValueOnce(new Error('gone'));
    await sw.undoLast();
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://c.example/', active: false }));
    expect(sw.asking).toBe(false);
  });

  it("the toast's Undo button undoes", async () => {
    const sw = await boot({ tabs: ABC });
    await sw.closeTab(entryByTitle(sw, 'C'));
    toastButton().click();
    await waitFor(() => toastText() === t('reopenedN', { count: 1 }));
    expect(chrome._data.tabs.some((x) => x.url === 'https://c.example/')).toBe(true);
  });

  it('reopenAt goes left to right, and falls back to the source window when the old one is gone', async () => {
    const sw = await boot({ tabs: ABC });
    chrome.tabs.create.mockRejectedValueOnce(new Error('No window with id: 9.'));
    await sw.reopenAt([{ url: 'https://two/', windowId: 1, index: 2, pinned: false }, { url: 'https://zero/', windowId: 9, index: 0, pinned: true }]);
    const calls = chrome.tabs.create.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { url: 'https://zero/', windowId: 9, index: 0, pinned: true, active: false },
      { url: 'https://zero/', windowId: 1, active: false },
      { url: 'https://two/', windowId: 1, index: 2, pinned: false, active: false },
    ]);
  });
});

describe('reload', () => {
  it("reads Chrome's tabs again, keeping the selected card", async () => {
    const sw = await boot({ tabs: ABC });
    sw.select(sw.state.entries.findIndex((e) => e.tab && e.tab.title === 'C'));
    chrome._addTab({ windowId: 1, title: 'D', url: 'https://d.example/' });
    await sw.reload();
    expect(sw.state.tabs.map((x) => x.title)).toContain('D');
    expect(sw.state.entries[sw.state.sel].tab.title).toBe('C');
  });
});

describe('closeMany', () => {
  it('closes the tabs, unticks them, and offers one Undo for all', async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.picked.add(tabByTitle(sw, 'B').id);
    await sw.closeMany([tabByTitle(sw, 'B'), tabByTitle(sw, 'C')]);
    expect(order()).toEqual(['A']);
    expect(sw.state.picked.size).toBe(0);
    expect(sw.state.undo.at(-1).tabs.map((x) => x.url)).toEqual(['https://b.example/', 'https://c.example/']);
    expect(toastText()).toBe(t('closedN', { count: 2 }));
  });

  it('in an overlay closes the tab it sits on last', async () => {
    const sw = await boot({ tabs: ABC, overlay: true });
    const a = tabByTitle(sw, 'A'), b = tabByTitle(sw, 'B');
    await sw.closeMany([a, b]);
    expect(chrome.tabs.remove.mock.calls).toEqual([[[b.id]], [a.id]]);
    expect(sw.state.undo).toEqual([]);
  });
});

describe('copying', () => {
  it('copyText uses the clipboard API', async () => {
    const sw = await boot({ tabs: ABC });
    expect(await sw.copyText('hi')).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith('hi');
  });

  it("copyText falls back to execCommand('copy') when the clipboard API is refused", async () => {
    const sw = await boot({ tabs: ABC });
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    const clip = tid('clip');
    let copied = null;
    const had = document.execCommand;
    document.execCommand = vi.fn(() => { copied = clip.value; return true; });
    try {
      expect(await sw.copyText('fallback')).toBe(true);
    } finally { document.execCommand = had; }
    expect(copied).toBe('fallback');
    expect(clip.value).toBe('');
    expect(document.activeElement).toBe(tid('search'));
  });

  it('copyLinks: plain addresses, or a Markdown list with brackets escaped and the host for no title', async () => {
    const sw = await boot({ tabs: ABC });
    const tabs = [{ title: 'Docs [v2] guide', url: 'https://d.example/x' }, { title: '', url: 'https://www.e.example/' }];
    await sw.copyLinks(tabs, 'plain');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('https://d.example/x\nhttps://www.e.example/');
    await sw.copyLinks(tabs, 'md');
    expect(clipboard.writeText).toHaveBeenLastCalledWith('- [Docs \\[v2\\] guide](https://d.example/x)\n- [www.e.example](https://www.e.example/)');
    expect(toastText()).toBe(t('copiedN', { count: 2 }));
    clipboard.writeText.mockRejectedValueOnce(new Error('no'));
    await sw.copyLinks(tabs, 'plain');
    expect(toastText()).toBe(t('copyFailed'));
  });
});

describe('opening things', () => {
  it('moveToWindow puts the tabs in a new window behind Tabazing, in order, and Undo moves them back', async () => {
    const sw = await boot({ tabs: ABC });
    const [b, c] = [tabByTitle(sw, 'B'), tabByTitle(sw, 'C')];
    await sw.moveToWindow([b, c]);
    const w = chrome._data.windows.at(-1);
    expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: b.id, focused: false });
    expect(live(b.id).windowId).toBe(w.id);
    expect(live(c.id).windowId).toBe(w.id);
    expect(order(w.id)).toEqual(['B', 'C']);
    expect(closedMsg()).toBeUndefined(); // still open, to offer Undo
    expect(toastText()).toBe(t('movedN', { count: 2 }));
    toastButton().click();
    await waitFor(() => toastText() === t('movedBackN', { count: 2 }));
    expect(order()).toEqual(['A', 'B', 'C']);
  });

  it('moveToWindow from an overlay, with the tab it sits on, goes along and closes', async () => {
    const sw = await boot({ tabs: ABC, overlay: true });
    await sw.moveToWindow([tabByTitle(sw, 'A'), tabByTitle(sw, 'B')]);
    expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: tabByTitle(sw, 'A').id, focused: true });
    expect(closedMsg().reason).toBe('switch');
  });

  it('moveBack makes a window that is gone again, behind Tabazing, and puts the tabs in their places', async () => {
    const sw = await boot({ tabs: ABC });
    const [b, c] = [tabByTitle(sw, 'B'), tabByTitle(sw, 'C')];
    await sw.moveBack([{ id: c.id, windowId: 9, index: 1, pinned: false }, { id: b.id, windowId: 9, index: 0, pinned: true }]);
    const w = chrome._data.windows.at(-1);
    expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: b.id, focused: false });
    expect(order(w.id)).toEqual(['B', 'C']);
    expect(live(b.id).pinned).toBe(true);
  });

  it('openFromBox opens an address as one, anything else as a Google search', async () => {
    let sw = await boot({ tabs: ABC });
    await sw.openFromBox('example.org/path');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.org/path', windowId: 1, active: true });
    expect(closedMsg().reason).toBe('switch');
    sw = await boot({ tabs: ABC });
    await sw.openFromBox('cats & dogs');
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: 'https://www.google.com/search?q=cats%20%26%20dogs', windowId: 1, active: true });
  });

  it('restoreClosed uses the session, else opens the page, and cancels on failure', async () => {
    let sw = await boot({ tabs: ABC });
    await sw.restoreClosed({ url: 'https://w/', session: { window: { sessionId: 'w1' } } });
    expect(chrome.sessions.restore).toHaveBeenCalledWith('w1');
    expect(closedMsg().reason).toBe('restore');

    sw = await boot({ tabs: ABC });
    await sw.restoreClosed({ url: 'https://log/', session: null });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://log/', windowId: 1, active: true });

    sw = await boot({ tabs: ABC });
    chrome.sessions.restore.mockRejectedValueOnce(new Error('gone'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sw.restoreClosed({ url: 'https://w/', session: { tab: { sessionId: 'x' } } });
    expect(closedMsg().reason).toBe('cancel');
  });

  it('openPage switches to an open tab with that address, else opens one', async () => {
    let sw = await boot({ tabs: ABC });
    await sw.openPage('https://c.example/#part');
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabByTitle(sw, 'C').id, { active: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    sw = await boot({ tabs: ABC });
    await sw.openPage('https://new.example/');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://new.example/', windowId: 1, active: true });
    expect(closedMsg().reason).toBe('switch');
  });
});

describe('mergeWindows', () => {
  it("pulls another window's tabs in at once, keeping pins; Undo puts them back in a new window", async () => {
    let w2tab;
    const sw = await boot({
      tabs: ABC,
      beforeImport: () => { w2tab = chrome._addTab({ windowId: 2, title: 'W2', url: 'https://w2.example/', pinned: true }); },
    });
    expect(sw.state.otherWindows).toEqual([2]);
    await sw.mergeWindows([2]);
    expect(chrome.tabs.move).toHaveBeenCalledWith([w2tab.id], { windowId: 1, index: -1 });
    expect(chrome.tabs.update).toHaveBeenCalledWith(w2tab.id, { pinned: true });
    expect(live(w2tab.id).windowId).toBe(1);
    expect(toastText()).toBe(t('mergedN', { count: 1 }));
    expect(sw.state.tabs.some((x) => x.title === 'W2')).toBe(true); // reloaded
    expect(sw.state.undo.at(-1)).toMatchObject({ kind: 'merge', tabs: [{ id: w2tab.id, windowId: 2, index: 0, pinned: true }] });
    await chrome.windows.remove(2); // Chrome closes a window a merge empties
    chrome.windows.create.mockClear();
    await sw.undoLast();
    expect(chrome.windows.create).toHaveBeenCalledWith({ tabId: w2tab.id, focused: false });
    expect(toastText()).toBe(t('movedBackN', { count: 1 }));
    expect(live(w2tab.id).windowId).not.toBe(1);
    expect(live(w2tab.id).pinned).toBe(true);
  });

  it('says so when nothing could be merged', async () => {
    const sw = await boot({ tabs: ABC });
    await sw.mergeWindows([42]);
    expect(toastText()).toBe(t('errMerge'));
    expect(sw.state.undo).toEqual([]);
  });
});

describe('snooze', () => {
  it('snoozeMenu offers times; picking one closes the tabs until then, with Undo', async () => {
    const sw = await boot({ tabs: ABC });
    const b = tabByTitle(sw, 'B');
    const anchor = document.body.appendChild(document.createElement('button'));
    const before = Date.now();
    sw.snoozeMenu([b], anchor);
    const items = tids('menu-item');
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(items.at(-1).textContent).toBe(t('snoozePick'));
    expect(items[0].textContent.startsWith(t('snooze1h') + ' · ')).toBe(true);
    items[0].click();
    await waitFor(() => !live(b.id));
    const stored = (await chrome.storage.local.get('snoozed')).snoozed;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ url: 'https://b.example/', title: 'B', windowId: 1, pinned: false });
    expect(stored[0].at).toBeGreaterThanOrEqual(before + 3600e3);
    expect(sw.state.tabs.some((x) => x.id === b.id)).toBe(false);
    toastButton().click(); // Undo
    await waitFor(() => chrome._data.tabs.some((x) => x.url === 'https://b.example/'));
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://b.example/', windowId: 1, active: false, pinned: false });
    expect((await chrome.storage.local.get('snoozed')).snoozed).toEqual([]);
  });

  it('"Pick a time…" opens a date and time box; a time in the past is refused, a later one snoozes', async () => {
    const sw = await boot({ tabs: ABC });
    const b = tabByTitle(sw, 'B');
    const anchor = document.body.appendChild(document.createElement('button'));
    sw.snoozeMenu([b], anchor);
    tids('menu-item').at(-1).click();
    await waitFor(() => tid('snooze-picker'));
    const pop = tid('snooze-picker');
    const input = tid('snooze-picker-input', pop);
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(input.type).toBe('datetime-local');
    expect(document.activeElement).toBe(input);
    expect(new Date(input.value).getTime()).toBeGreaterThan(Date.now()); // starts on a time to come
    input.value = sw.localInput(Date.now() - 3600e3);
    pop.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(tid('snooze-picker-error').hidden).toBe(false);
    expect(tid('snooze-picker-error').textContent).toBe(t('snoozePast'));
    expect(live(b.id)).toBeDefined();
    const at = Date.now() + 2 * 86400e3;
    input.value = sw.localInput(at);
    pop.dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor(() => !live(b.id));
    expect(tid('snooze-picker')).toBe(null);
    const stored = (await chrome.storage.local.get('snoozed')).snoozed;
    expect(Math.abs(stored[0].at - at)).toBeLessThan(60e3); // to the minute
  });

  it('the time box closes with Esc or Cancel, giving the focus back', async () => {
    const sw = await boot({ tabs: ABC });
    const anchor = document.body.appendChild(document.createElement('button'));
    anchor.focus();
    sw.snoozePicker([tabByTitle(sw, 'B')], anchor);
    tid('snooze-picker-cancel').click();
    expect(tid('snooze-picker')).toBe(null);
    expect(document.activeElement).toBe(anchor);
    sw.snoozePicker([tabByTitle(sw, 'B')], anchor);
    tid('snooze-picker').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tid('snooze-picker')).toBe(null);
  });

  it("won't snooze pages that can't be reopened", async () => {
    const sw = await boot({ tabs: [...ABC, { title: 'New', url: 'chrome://newtab/' }] });
    await sw.snoozeTabs([tabByTitle(sw, 'New')], Date.now() + 1000);
    expect(toastText()).toBe(t('snoozeCant'));
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });

  it('unsnooze reopens where the tab was, or in this window if that one is gone', async () => {
    const sw = await boot({ tabs: ABC });
    chrome.tabs.create.mockRejectedValueOnce(new Error('No window'));
    await sw.unsnooze([{ id: 'q', url: 'https://q.example/', windowId: 7, pinned: true }]);
    expect(chrome.tabs.create.mock.calls.map((c) => c[0])).toEqual([
      { url: 'https://q.example/', windowId: 7, active: false, pinned: true },
      { url: 'https://q.example/', windowId: 1, active: false },
    ]);
    expect(toastText()).toBe(t('reopenedN', { count: 1 }));
  });
});

describe('drag to reorder', () => {
  const dragEvent = (type, clientX = 0) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { setData: vi.fn(), effectAllowed: '', dropEffect: '' } });
    Object.defineProperty(e, 'clientX', { value: clientX });
    return e;
  };
  const rect = (card) => { card.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 50, right: 100, bottom: 50 }); return card; };

  it('dropAfter: the right half of a card means after it', async () => {
    const sw = await boot({ tabs: ABC });
    const card = rect(document.createElement('div'));
    expect(sw.dropAfter(card, { clientX: 70 })).toBe(true);
    expect(sw.dropAfter(card, { clientX: 30 })).toBe(false);
  });

  it('dragging one card onto the left half of another moves it there', async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.sort = 'order'; // (By order: cards move before / after others)
    const c = tabByTitle(sw, 'C');
    const from = rect(document.body.appendChild(document.createElement('div')));
    const to = rect(document.body.appendChild(document.createElement('div')));
    sw.dragToMove(from, entryByTitle(sw, 'C'));
    sw.dragToMove(to, entryByTitle(sw, 'A'));
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
    expect(chrome.tabs.move).toHaveBeenCalledWith(c.id, { windowId: 1, index: 0 });
    await waitFor(() => order().join() === 'C,A,B');
  });

  it("dragover on a card that is itself being dragged doesn't mark a drop", async () => {
    const sw = await boot({ tabs: ABC });
    sw.state.sort = 'order'; // (By order: cards move before / after others)
    const card = rect(document.body.appendChild(document.createElement('div')));
    sw.dragToMove(card, entryByTitle(sw, 'A'));
    card.dispatchEvent(dragEvent('dragstart'));
    const over = dragEvent('dragover', 80);
    card.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    card.dispatchEvent(dragEvent('dragend'));
    expect(card.classList.contains('dragging')).toBe(false);
  });

  it('clearDrop removes every drop marker', async () => {
    const sw = await boot({ tabs: ABC });
    const n = document.body.appendChild(document.createElement('div'));
    n.className = 'drop-after x';
    sw.clearDrop();
    expect(n.className).toBe('x');
  });

  it('moveTabs puts several tabs, in strip order, one after another before the target', async () => {
    const sw = await boot({ tabs: [...ABC, { title: 'D', url: 'https://d.example/' }] });
    const [a, c, d] = ['A', 'C', 'D'].map((x) => tabByTitle(sw, x));
    sw.state.picked.add(d.id);
    await sw.moveTabs([d.id, c.id], a, false);
    expect(chrome.tabs.move.mock.calls).toEqual([[c.id, { windowId: 1, index: 0 }], [d.id, { windowId: 1, index: 1 }]]);
    expect(order()).toEqual(['C', 'D', 'A', 'B']);
    expect(sw.state.picked.size).toBe(0);
  });

  it('moveTabs counts the gap a tab leaves when it moves right', async () => {
    const sw = await boot({ tabs: ABC });
    const [a, c] = [tabByTitle(sw, 'A'), tabByTitle(sw, 'C')];
    await sw.moveTabs([a.id], c, true);
    expect(chrome.tabs.move).toHaveBeenCalledWith(a.id, { windowId: 1, index: 2 }); // after C, which is the last place
  });
});

describe('sleep, pin, mute', () => {
  it('sleepTabs marks background tabs (not the current one), and again unmarks', async () => {
    const sw = await boot({ tabs: ABC });
    const [a, b] = [tabByTitle(sw, 'A'), tabByTitle(sw, 'B')];
    await sw.sleepTabs([a, b]);
    expect([...sw.state.toSleep]).toEqual([b.id]);
    expect(toastText()).toBe(t('sleepLaterN', { count: 1 }));
    expect(cardOf('B').classList.contains('asleep')).toBe(true);
    await sw.sleepTabs([b]);
    expect(sw.state.toSleep.size).toBe(0);
    expect(toastText()).toBe(t('sleepUndone'));
    await sw.sleepTabs([a]);
    expect(toastText()).toBe(t('sleptNone'));
  });

  it('pinTabs pins them all, or unpins when all are pinned', async () => {
    const sw = await boot({ tabs: ABC });
    const tabs = [tabByTitle(sw, 'B'), tabByTitle(sw, 'C')];
    await sw.pinTabs(tabs);
    expect(tabs.map((x) => live(x.id).pinned)).toEqual([true, true]);
    expect(toastText()).toBe(t('pinnedN', { count: 2 }));
    await sw.pinTabs(sw.state.tabs.filter((x) => x.pinned));
    expect(tabs.map((x) => live(x.id).pinned)).toEqual([false, false]);
  });

  it('muteTabs mutes them all, or unmutes when all are muted', async () => {
    const sw = await boot({ tabs: [ABC[0], { ...ABC[1], mutedInfo: { muted: true } }, ABC[2]] });
    const tabs = [tabByTitle(sw, 'B'), tabByTitle(sw, 'C')];
    await sw.muteTabs(tabs);
    expect(chrome.tabs.update).toHaveBeenCalledWith(tabs[0].id, { muted: true });
    expect(toastText()).toBe(t('mutedN', { count: 2 }));
    await sw.muteTabs([tabByTitle(sw, 'B'), tabByTitle(sw, 'C')]);
    expect(tabs.map((x) => live(x.id).mutedInfo.muted)).toEqual([false, false]);
  });

  it('isMuted reads mutedInfo', async () => {
    const sw = await boot({ tabs: ABC });
    expect(sw.isMuted({ mutedInfo: { muted: true } })).toBe(true);
    expect(sw.isMuted({ mutedInfo: { muted: false } })).toBe(false);
    expect(sw.isMuted({})).toBe(false);
  });

  it('audioBadge: a speaker that mutes, a crossed-out one that unmutes', async () => {
    const sw = await boot({ tabs: [ABC[0], { ...ABC[1], audible: true }] });
    const b = tabByTitle(sw, 'B');
    const badge = sw.audioBadge(b);
    expect(badge.className).toBe('badge audio on');
    expect(badge.title).toBe(t('tabMute'));
    expect(sw.audioBadge({ mutedInfo: { muted: true } }).title).toBe(t('tabUnmute'));
    expect(tid('card-audio', cardOf('B'))).not.toBe(null); // drawn on playing tabs
    badge.click();
    await waitFor(() => live(b.id).mutedInfo.muted);
  });

  it('toggleMute flips one tab and shows it at once', async () => {
    const sw = await boot({ tabs: ABC });
    const b = tabByTitle(sw, 'B');
    await sw.toggleMute(b);
    expect(chrome.tabs.update).toHaveBeenCalledWith(b.id, { muted: true });
    expect(sw.isMuted(tabByTitle(sw, 'B'))).toBe(true);
    expect(tid('card-audio', cardOf('B'))).not.toBe(null);
  });

  it('togglePin tries once more when Chrome is busy', async () => {
    const sw = await boot({ tabs: ABC });
    const b = tabByTitle(sw, 'B');
    chrome.tabs.update.mockRejectedValueOnce(new Error('Tabs cannot be edited right now'));
    await sw.togglePin(b);
    expect(chrome.tabs.update).toHaveBeenCalledTimes(2);
    expect(live(b.id).pinned).toBe(true);
    expect(toastText()).toBe(t('pinnedOne', { title: 'B' }));
  });

  it('togglePin says what failed when Chrome refuses twice', async () => {
    const sw = await boot({ tabs: ABC });
    chrome.tabs.update.mockRejectedValueOnce(new Error('busy')).mockRejectedValueOnce(new Error('still busy'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sw.togglePin(tabByTitle(sw, 'B'));
    expect(toastText()).toBe(t('errPin'));
  });

  it('a speaker Chrome refuses to mute says so', async () => {
    await boot({ tabs: [ABC[0], { ...ABC[1], audible: true }] });
    chrome.tabs.update.mockRejectedValueOnce(new Error('no'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tid('card-audio', cardOf('B')).click();
    await waitFor(() => toastText() === t('errMute'));
  });
});

describe('one-tab quick buttons', () => {
  it('reloadTab reloads and says so; on the overlay tab it closes the switcher', async () => {
    let sw = await boot({ tabs: ABC });
    await sw.reloadTab(tabByTitle(sw, 'B'));
    expect(chrome.tabs.reload).toHaveBeenCalledWith(tabByTitle(sw, 'B').id);
    expect(toastText()).toBe(t('reloadingOne', { title: 'B' }));
    expect(sw.state.done).toBe(false);
    sw = await boot({ tabs: ABC, overlay: true });
    await sw.reloadTab(tabByTitle(sw, 'A'));
    expect(closedMsg().reason).toBe('cancel');
  });

  it('duplicateTab opens a copy right after it, in the background', async () => {
    const sw = await boot({ tabs: ABC });
    const b = tabByTitle(sw, 'B');
    await sw.duplicateTab(b);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://b.example/', windowId: 1, index: 2, active: false, pinned: false, openerTabId: b.id });
    expect(sw.state.tabs.filter((x) => x.url === 'https://b.example/')).toHaveLength(2);
    expect(toastText()).toBe(t('duplicatedOne', { title: 'B' }));
  });

  it('quickActions: only pin, snooze, archive, the note and ⋯ (its menu has the rest)', async () => {
    const sw = await boot({ tabs: [ABC[0], { ...ABC[1], pinned: true }, { ...ABC[2], audible: true }] });
    const labels = (e) => [...sw.quickActions(e).children].map((b) => b.dataset.testid);
    const bEntry = entryByTitle(sw, 'B');
    expect(labels(bEntry)).toEqual(['quick-pin', 'quick-clock', 'quick-archive', 'quick-note', 'quick-more']);
    expect(labels(entryByTitle(sw, 'C'))).toEqual(labels(bEntry)); // a playing tab mutes with its speaker, in the header
    const box = sw.quickActions(bEntry);
    expect(tid('quick-pin', box).title).toBe(t('tabUnpin'));
    expect(tid('quick-pin', box).classList.contains('on')).toBe(true);
    expect(tid('quick-more', box).title).toBe(t('cardMenu'));
    expect(tid('quick-more', box).getAttribute('aria-haspopup')).toBe('menu');
  });

  it('⋯ opens the card menu at the button, the same one as Shift+F10', async () => {
    await boot({ tabs: ABC });
    tid('quick-more', cardOf('B')).click();
    await waitFor(() => tid('menu'));
    expect(tid('menu').anchor).toBe(tid('quick-more', cardOf('B')));
    const items = tids('menu-item').map((b) => b.textContent);
    expect(items).toContain(t('copyLink'));
    expect(items).toContain(t('tabReload'));
    expect(items).toContain(t('tabClose'));
    tids('menu-item').find((b) => b.textContent === t('copyLink')).click();
    await waitFor(() => clipboard.writeText.mock.calls.length);
    expect(clipboard.writeText).toHaveBeenCalledWith('https://b.example/');
  });

  it('every item of the card menu has an icon before its label', async () => {
    const sw = await boot({ tabs: ABC });
    sw.cardMenu(entryByTitle(sw, 'B'));
    const items = tids('menu-item');
    expect(items.length).toBeGreaterThan(8);
    for (const b of items) {
      const icon = tid('menu-item-icon', b);
      expect(icon, b.textContent).toBeTruthy();
      expect(icon.querySelector('svg')).toBeTruthy();
      expect(b.firstElementChild).toBe(icon);
      expect(tid('menu-item-label', b).textContent).toBe(b.textContent); // the icon adds no text
    }
  });

  it('a failing quick button says what failed', async () => {
    await boot({ tabs: ABC });
    chrome.tabs.update.mockRejectedValue(new Error('nope'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    tid('quick-pin', cardOf('B')).click();
    await waitFor(() => toastText() === t('errPin'));
  });

  it('a failing menu item says what failed', async () => {
    const sw = await boot({ tabs: ABC });
    chrome.tabs.reload.mockRejectedValueOnce(new Error('nope'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sw.cardMenu(entryByTitle(sw, 'B'));
    tids('menu-item').find((b) => b.textContent === t('tabReload')).click();
    await waitFor(() => toastText() === t('errReload'));
  });
});

describe('duplicates', () => {
  const DUPES = [ABC[0], { title: 'D1', url: 'https://dup.example/' }, { title: 'D2', url: 'https://dup.example/#x' }];

  it('closeDupes first shows the copies, then closes all but one (with Undo)', async () => {
    const sw = await boot({ tabs: DUPES });
    await sw.closeDupes();
    expect(sw.state.dupesView).toBe(true);
    expect(sw.state.entries.map((e) => e.tab.title)).toEqual(['D1', 'D2']);
    expect(tid('acts').classList.contains('dupes')).toBe(true);
    expect(tid('dupes-close-label').textContent).toBe(t('dupesClose', { count: 1 }));
    await sw.closeDupes();
    expect(order()).toEqual(['A', 'D1']); // the most recently used copy stays
    expect(sw.state.dupesView).toBe(false);
    expect(toastButton().textContent).toMatch(/^Undo/);
  });

  it('dupesView(false) goes back and drops ticks', async () => {
    const sw = await boot({ tabs: DUPES });
    sw.dupesView(true);
    sw.state.picked.add(1);
    sw.dupesView(false);
    expect(sw.state.picked.size).toBe(0);
    expect(sw.state.entries).toHaveLength(3);
  });
});

describe('star and capture', () => {
  it('star toggles the page in Tabazing’s stars', async () => {
    const sw = await boot({ tabs: ABC });
    await sw.star(entryByTitle(sw, 'B'));
    expect(Object.keys((await chrome.storage.local.get('stars')).stars)).toEqual(['https://b.example/']);
    expect(sw.isStarred('https://b.example/')).toBe(true);
    expect(tid('card-star-button', cardOf('B')).classList.contains('on')).toBe(true);
    await sw.star(entryByTitle(sw, 'B'));
    expect(sw.state.stars).toEqual({});
  });

  it('star ignores closed windows', async () => {
    const sw = await boot({ tabs: ABC });
    await sw.star({ kind: 'closed', url: 'https://w/', item: { kind: 'window', url: 'https://w/', title: 'W' } });
    expect((await chrome.storage.local.get('stars')).stars).toBeUndefined();
  });

  it('captureOne asks the background for a preview and shows it', async () => {
    const sw = await boot({ tabs: ABC });
    const b = entryByTitle(sw, 'B');
    chrome.runtime.sendMessage.mockImplementation(async (m) => {
      if (m.type === MSG.CAPTURE_ONE) await chrome.storage.local.set({ 'pv:https://b.example/': { img: 'data:image/jpeg;base64,BBBB', t: Date.now() } });
    });
    await sw.captureOne(b);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG.CAPTURE_ONE, tabId: b.tab.id });
    expect(sw.state.previews[b.tab.id].img).toBe('data:image/jpeg;base64,BBBB');
    expect(sw.state.capturing).toBe(null);
    expect(tid('card-preview', cardOf('B')).src).toBe('data:image/jpeg;base64,BBBB');
  });

  it('captureOne says so when no preview came back', async () => {
    const sw = await boot({ tabs: ABC });
    await sw.captureOne(entryByTitle(sw, 'B'));
    expect(toastText()).toBe(t('captureFailed'));
  });

  it('captureOne from an overlay in the same window leaves and asks to be reopened where it was', async () => {
    const sw = await boot({ tabs: ABC, overlay: true });
    const b = entryByTitle(sw, 'B');
    await sw.captureOne(b);
    expect((await chrome.storage.session.get('resume')).resume).toMatchObject({ key: b.key, query: '', scope: 'all', starred: false });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG.CAPTURE_ONE, tabId: b.tab.id, reopen: tabByTitle(sw, 'A').id });
    expect(closedMsg().reason).toBe('switch');
  });

  it("captureOne skips pages it can't capture", async () => {
    const sw = await boot({ tabs: [...ABC, { title: 'Ext', url: 'chrome://extensions/' }] });
    chrome.runtime.sendMessage.mockClear();
    await sw.captureOne(entryByTitle(sw, 'Ext'));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
