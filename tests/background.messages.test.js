// background.js: runtime.onMessage. Every message is checked for sender and shape; pages may only ask to open.
import { describe, it, expect, vi } from 'vitest';
import { MESSAGE, KEY, LIMITS } from '../utils/constants.js';
import { environment, flush, freshWorker, seed, launch, fromSwitcherPage, fromPage, send } from './helpers/background.js';

freshWorker();
const background = () => environment.background;
const cycleCalls = () => chrome.runtime.sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === MESSAGE.CYCLE);

describe('sender checks', () => {
  it('fromContentScript: a tab with an integer id, not one of our own pages', () => {
    const { fromContentScript } = background();
    expect(fromContentScript({ tab: { id: 3 }, url: 'https://a.com/' })).toBe(true);
    expect(fromContentScript({ tab: { id: 3 } })).toBe(true); // no url: still a page
    expect(fromContentScript({ url: 'https://a.com/' })).toBe(false);
    expect(fromContentScript({ tab: { id: '3' }, url: 'https://a.com/' })).toBe(false);
    expect(fromContentScript({ tab: { id: 3 }, url: background().SWITCHER_URL })).toBe(false);
  });

  it('fromSwitcher: the switcher page only', () => {
    const { fromSwitcher } = background();
    expect(fromSwitcher({ url: background().SWITCHER_URL })).toBe(true);
    expect(fromSwitcher({ url: background().SWITCHER_URL + '?t=x' })).toBe(true);
    expect(fromSwitcher({ url: `chrome-extension://${chrome.runtime.id}/markup/sweep.html` })).toBe(false);
    expect(fromSwitcher({ url: 'https://evil.com/markup/switcher.html' })).toBe(false);
    expect(fromSwitcher({ url: 'chrome-extension://otherextensionidxxxxxxxxxxxxxxxxx/markup/switcher.html' })).toBe(false);
    expect(fromSwitcher({})).toBe(false);
  });

  it('ignores other extensions and malformed messages', async () => {
    const { tab } = seed();
    for (const [message, sender] of [
      [{ type: MESSAGE.HOTKEY, direction: 1 }, { ...fromPage(tab), id: 'otherextension' }],
      [null, fromPage(tab)],
      ['tabazing:hotkey', fromPage(tab)],
      [{ type: 5 }, fromPage(tab)],
      [{ type: 'tabazing:unknown' }, fromPage(tab)],
    ]) expect(send(message, sender).result).toBeUndefined();
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('MSG.OPENED has no handler in the worker', () => {
    const { result, respond } = send({ type: MESSAGE.OPENED }, fromSwitcherPage());
    expect(result).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
  });
});

describe('HOTKEY', () => {
  it.each([[-1, -1], [0, 0], [1, 1], [7, 1], ['x', 1]])('dir %s from a page opens with dir %s', async (direction, want) => {
    const { tab } = seed();
    send({ type: MESSAGE.HOTKEY, direction, hold: true }, fromPage(tab));
    await flush();
    expect(cycleCalls()).toEqual([{ type: MESSAGE.CYCLE, direction: want, hold: true }]);
    expect(launch().context).toMatchObject({ sourceTab: tab.id, via: 'key', hold: true });
  });

  it('hold only when it is exactly true', async () => {
    const { tab } = seed();
    send({ type: MESSAGE.HOTKEY, direction: 1, hold: 'yes' }, fromPage(tab));
    await flush();
    expect(cycleCalls()[0].hold).toBe(false);
  });

  it('palette: true (Alt+R in a page) opens the palette; the rest of the message is ignored', async () => {
    const { tab } = seed();
    send({ type: MESSAGE.HOTKEY, direction: -1, hold: true, palette: true }, fromPage(tab));
    await flush();
    expect(cycleCalls()).toEqual([{ type: MESSAGE.CYCLE, direction: 0, hold: false, palette: true }]);
    expect(launch().context).toMatchObject({ sourceTab: tab.id, direction: 0, hold: false, palette: true });
  });

  it('palette only when it is exactly true', async () => {
    const { tab } = seed();
    send({ type: MESSAGE.HOTKEY, direction: 1, hold: false, palette: 'yes' }, fromPage(tab));
    await flush();
    expect(cycleCalls()).toEqual([{ type: MESSAGE.CYCLE, direction: 1, hold: false }]);
    expect(launch().context.palette).toBeUndefined();
  });

  it('palette from the switcher page is ignored too', async () => {
    const { tab } = seed();
    send({ type: MESSAGE.HOTKEY, palette: true }, fromSwitcherPage(tab));
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('is ignored from the switcher page or a sender without a tab', async () => {
    const { tab } = seed();
    send({ type: MESSAGE.HOTKEY, direction: 1 }, fromSwitcherPage(tab));
    send({ type: MESSAGE.HOTKEY, direction: 1 }, { id: chrome.runtime.id, url: 'https://a.com/' });
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('READY', () => {
  it('answers with the queued moves, clamped to ±20', async () => {
    const { tab } = seed('chrome://newtab/');
    for (let i = 0; i < 26; i++) await background().openSwitcher(-1, tab);
    expect(background().opening.extra).toBe(-25);
    const { respond } = send({ type: MESSAGE.READY }, fromSwitcherPage());
    expect(respond).toHaveBeenCalledWith({ extra: -20 });
    expect(background().opening).toBeNull();
  });

  it('answers extra 0 when nothing is opening', () => {
    expect(send({ type: MESSAGE.READY }, fromSwitcherPage()).respond).toHaveBeenCalledWith({ extra: 0 });
  });

  it('is ignored from a page', async () => {
    const { tab } = seed();
    await background().openSwitcher(1, tab);
    const { respond } = send({ type: MESSAGE.READY }, fromPage(tab));
    expect(respond).not.toHaveBeenCalled();
    expect(background().watchdog).not.toBeNull();
    expect(background().opening).not.toBeNull();
  });
});

describe('CLOSED', () => {
  it('resets the opening state and the overlay mark', async () => {
    const { tab } = seed();
    await background().openSwitcher(1, tab);
    send({ type: MESSAGE.CLOSED, reason: 'switch' }, fromSwitcherPage(tab));
    await flush();
    expect(background().watchdog).toBeNull();
    expect(background().opening).toBeNull();
    expect(background().quietAt).toBe(Date.now());
    expect(chrome.storage.session._data.has(KEY.OVERLAY)).toBe(false);
  });

  it('after a cancel, puts the window back (now and again after 250 ms)', async () => {
    const chromeWindow = chrome._addWindow({ state: 'minimized', focused: false });
    send({ type: MESSAGE.CLOSED, reason: 'cancel', window: chromeWindow.id, state: 'maximized' }, fromSwitcherPage());
    await flush();
    expect(chrome.windows.update).toHaveBeenCalledWith(chromeWindow.id, { state: 'maximized' });
    expect(chrome.windows.update).toHaveBeenCalledWith(chromeWindow.id, { focused: true });
    chrome.windows.update.mockClear();
    await vi.advanceTimersByTimeAsync(250);
    expect(chrome.windows.update).toHaveBeenCalledWith(chromeWindow.id, { focused: true });
  });

  it('a cancel with a bad state restores to normal; one without a window restores nothing', async () => {
    const chromeWindow = chrome._addWindow({ state: 'minimized' });
    send({ type: MESSAGE.CLOSED, reason: 'cancel', window: chromeWindow.id, state: 'minimized' }, fromSwitcherPage());
    send({ type: MESSAGE.CLOSED, reason: 'cancel', window: 'x' }, fromSwitcherPage());
    await flush();
    expect(chrome.windows.update).toHaveBeenCalledWith(chromeWindow.id, { state: 'normal' });
    expect(chrome.windows.update.mock.calls.every(([id]) => id === chromeWindow.id)).toBe(true);
  });

  it('warns about a reason it does not know', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    send({ type: MESSAGE.CLOSED, reason: 'weird' }, fromSwitcherPage());
    expect(warn).toHaveBeenCalledWith('[Tabazing] unexpected close reason');
    warn.mockClear();
    for (const reason of ['switch', 'restore', 'blur']) send({ type: MESSAGE.CLOSED, reason }, fromSwitcherPage());
    expect(warn).not.toHaveBeenCalled();
  });

  it('is ignored from a page', async () => {
    const { tab } = seed();
    await background().openSwitcher(1, tab);
    send({ type: MESSAGE.CLOSED, reason: 'cancel', window: tab.windowId }, fromPage(tab));
    await flush();
    expect(background().opening).not.toBeNull();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });
});

describe('restoreWindow', () => {
  it('only un-minimises a minimised window, and always focuses it', async () => {
    const chromeWindow = chrome._addWindow({ state: 'normal', focused: false });
    await background().restoreWindow(chromeWindow.id, 'maximized');
    expect(chrome.windows.update.mock.calls).toEqual([[chromeWindow.id, { focused: true }]]);
  });
  it('swallows a window that is gone', async () => {
    await expect(background().restoreWindow(42, 'normal')).resolves.toBeUndefined();
  });
});

describe('SWEEP', () => {
  function twoTabs() {
    const { tab, w: chromeWindow } = seed('https://a.com/');
    const otherTab = chrome._addTab({ windowId: chromeWindow.id, url: 'https://b.com/' });
    return { tab, b: otherTab };
  }

  it('says how many tabs need a picture, then visits them and reopens over the tab it came from', async () => {
    const { tab, b: otherTab } = twoTabs();
    const { result, respond } = send({ type: MESSAGE.SWEEP, tabIds: null, reopen: tab.id }, fromSwitcherPage());
    expect(result).toBe(true); // answered asynchronously
    await flush();
    expect(respond).toHaveBeenCalledWith({ n: 1 });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(chrome.tabs.update).toHaveBeenCalledWith(otherTab.id, { active: true });
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(cycleCalls()).toEqual([{ type: MESSAGE.CYCLE, direction: 1, hold: false }]);
    expect(launch().context.sourceTab).toBe(tab.id);
  });

  it('keeps to integer tab ids, at most SWEEP_MAX_TABS of them', async () => {
    const { b: otherTab } = twoTabs();
    const { respond } = send({ type: MESSAGE.SWEEP, tabIds: ['x', 1.5, otherTab.id] }, fromSwitcherPage());
    await flush();
    expect(respond).toHaveBeenCalledWith({ n: 1 });
    const { respond: secondRespond } = send({ type: MESSAGE.SWEEP, tabIds: [...Array(LIMITS.SWEEP_MAX_TABS).fill(999), otherTab.id] }, fromSwitcherPage());
    await flush();
    expect(secondRespond).toHaveBeenCalledWith({ n: 0 }); // b is past the cap
  });

  it('nothing to capture: answers 0 and runs nothing', async () => {
    seed();
    const { respond } = send({ type: MESSAGE.SWEEP }, fromSwitcherPage());
    await flush();
    expect(respond).toHaveBeenCalledWith({ n: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('answers 0 when listing the tabs fails', async () => {
    chrome.windows.getAll.mockRejectedValueOnce(new Error('no'));
    const { respond } = send({ type: MESSAGE.SWEEP }, fromSwitcherPage());
    await flush();
    expect(respond).toHaveBeenCalledWith({ n: 0 });
  });

  it('is ignored from a page', () => {
    const { tab } = twoTabs();
    const { result, respond } = send({ type: MESSAGE.SWEEP }, fromPage(tab));
    expect(result).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it('SWEEP_CANCEL from the sweep window stops a run; from anywhere else it does not', async () => {
    const { w: chromeWindow } = seed('https://a.com/');
    for (const url of ['https://b.com/', 'https://c.com/', 'https://d.com/']) chrome._addTab({ windowId: chromeWindow.id, url });
    send({ type: MESSAGE.SWEEP }, fromSwitcherPage());
    await flush();
    await vi.advanceTimersByTimeAsync(150);
    const shown = () => chrome.tabs.update.mock.calls.filter(([, options]) => options.active).map(([id]) => id); // (the sweep also mutes each visit)
    expect(shown()).toEqual([2]);
    send({ type: MESSAGE.SWEEP_CANCEL }, fromSwitcherPage()); // not the sweep window
    send({ type: MESSAGE.SWEEP_CANCEL }, { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/markup/sweep.html` });
    await vi.advanceTimersByTimeAsync(10000);
    // the first visit, then only putting the window back on its tab
    expect(shown()).toEqual([2, 1]);
  });
});

describe('CAPTURE_ONE', () => {
  it('captures one tab and answers whether it worked', async () => {
    const { tab, w: chromeWindow } = seed();
    const otherTab = chrome._addTab({ windowId: chromeWindow.id, url: 'https://b.com/' });
    const { result, respond } = send({ type: MESSAGE.CAPTURE_ONE, tabId: otherTab.id, reopen: tab.id }, fromSwitcherPage());
    expect(result).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(respond).toHaveBeenCalledWith({ ok: true });
    expect(launch().context.sourceTab).toBe(tab.id); // reopened over the original tab
  });

  it('answers ok:false when the capture fails', async () => {
    seed();
    chrome.windows.getAll.mockRejectedValue(new Error('no'));
    const { respond } = send({ type: MESSAGE.CAPTURE_ONE, tabId: 1 }, fromSwitcherPage());
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(respond).toHaveBeenCalledWith({ ok: false });
  });

  it('needs an integer tab id and the switcher as sender', () => {
    const { tab } = seed();
    expect(send({ type: MESSAGE.CAPTURE_ONE, tabId: '1' }, fromSwitcherPage()).result).toBeUndefined();
    expect(send({ type: MESSAGE.CAPTURE_ONE, tabId: tab.id }, fromPage(tab)).result).toBeUndefined();
  });
});

describe('SLEEP', () => {
  it('unloads the listed background tabs after the switcher has closed', async () => {
    const { tab, w: chromeWindow } = seed();
    const otherTab = chrome._addTab({ windowId: chromeWindow.id, url: 'https://b.com/' });
    const thirdTab = chrome._addTab({ windowId: chromeWindow.id, url: 'https://c.com/', discarded: true });
    send({ type: MESSAGE.SLEEP, tabIds: [tab.id, otherTab.id, thirdTab.id, 999, 'x'] }, fromSwitcherPage());
    await flush();
    expect(chrome.tabs.discard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(chrome.tabs.discard.mock.calls).toEqual([[otherTab.id]]); // not the active one, not one already asleep
  });

  it('needs an array of ids from the switcher', async () => {
    const { tab, w: chromeWindow } = seed();
    const otherTab = chrome._addTab({ windowId: chromeWindow.id, url: 'https://b.com/' });
    send({ type: MESSAGE.SLEEP, tabIds: otherTab.id }, fromSwitcherPage());
    send({ type: MESSAGE.SLEEP, tabIds: [otherTab.id] }, fromPage(tab));
    await vi.advanceTimersByTimeAsync(1000);
    expect(chrome.tabs.discard).not.toHaveBeenCalled();
  });
});

describe('FLYOUT_DONE', () => {
  it('a page marks the first-run flyout as done', async () => {
    const { tab } = seed();
    send({ type: MESSAGE.FLYOUT_DONE }, fromPage(tab));
    await flush();
    expect(chrome.storage.local._data.get(KEY.ONBOARD)).toMatchObject({ flyout: true });
  });
  it('is ignored from the switcher', async () => {
    send({ type: MESSAGE.FLYOUT_DONE }, fromSwitcherPage());
    await flush();
    expect(chrome.storage.local._data.has(KEY.ONBOARD)).toBe(false);
  });
});

describe('NUDGE answers', () => {
  it('"try" opens the switcher over that tab', async () => {
    const { tab } = seed();
    send({ type: MESSAGE.NUDGE, action: 'try' }, fromPage(tab));
    await flush();
    expect(cycleCalls()).toEqual([{ type: MESSAGE.CYCLE, direction: 1, hold: false }]);
    expect(launch().context).toMatchObject({ sourceTab: tab.id, via: 'key' });
  });
  it('"never" turns it off for good; "ok" changes nothing', async () => {
    const { tab } = seed();
    send({ type: MESSAGE.NUDGE, action: 'ok' }, fromPage(tab));
    await flush();
    expect(chrome.storage.local._data.has(KEY.NUDGE)).toBe(false);
    send({ type: MESSAGE.NUDGE, action: 'never' }, fromPage(tab));
    await flush();
    expect(chrome.storage.local._data.get(KEY.NUDGE)).toMatchObject({ never: true });
  });
  it('is ignored from the switcher', async () => {
    send({ type: MESSAGE.NUDGE, action: 'never' }, fromSwitcherPage());
    send({ type: MESSAGE.NUDGE, action: 'try' }, fromSwitcherPage(seed().tab));
    await flush();
    expect(chrome.storage.local._data.has(KEY.NUDGE)).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('FALLBACK', () => {
  async function openOverlay() {
    const seeded = seed();
    await background().openSwitcher(-1, seeded.tab, 'key', true);
    chrome.scripting.executeScript.mockClear();
    return seeded;
  }

  it('swaps the overlay for the popup window (without hold)', async () => {
    const { tab, w: chromeWindow } = await openOverlay();
    send({ type: MESSAGE.FALLBACK }, fromSwitcherPage(tab));
    expect(background().overlayOpen).toBeNull();
    expect(background().watchdog).toBeNull();
    expect(background().opening).toBeNull();
    await flush();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: tab.id }, func: background().removeOverlay, injectImmediately: true });
    expect(launch().context).toEqual({ sourceTab: tab.id, window: chromeWindow.id, direction: -1, via: 'key', hold: false, state: 'normal', mode: 'window' });
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ url: background().SWITCHER_URL + '?t=' + launch().token }));
  });

  it('only for the tab the overlay is in, and only from the switcher', async () => {
    const { tab } = await openOverlay();
    send({ type: MESSAGE.FALLBACK }, fromSwitcherPage({ ...tab, id: tab.id + 1 }));
    send({ type: MESSAGE.FALLBACK }, fromSwitcherPage());
    send({ type: MESSAGE.FALLBACK }, fromPage(tab));
    await flush();
    expect(background().overlayOpen).not.toBeNull();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('does nothing with no overlay open', async () => {
    send({ type: MESSAGE.FALLBACK }, fromSwitcherPage(seed().tab));
    await flush();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });
});
