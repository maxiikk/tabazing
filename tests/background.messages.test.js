// background.js: runtime.onMessage. Every message is checked for sender and shape; pages may only ask to open.
import { describe, it, expect, vi } from 'vitest';
import { MSG, KEY, LIMITS } from '../lib/constants.js';
import { env, flush, freshWorker, seed, launch, fromSwitcherPage, fromPage, send } from './background.shared.js';

freshWorker();
const bg = () => env.bg;
const cycleCalls = () => chrome.runtime.sendMessage.mock.calls.map(([m]) => m).filter((m) => m.type === MSG.CYCLE);

describe('sender checks', () => {
  it('fromContentScript: a tab with an integer id, not one of our own pages', () => {
    const { fromContentScript } = bg();
    expect(fromContentScript({ tab: { id: 3 }, url: 'https://a.com/' })).toBe(true);
    expect(fromContentScript({ tab: { id: 3 } })).toBe(true); // no url: still a page
    expect(fromContentScript({ url: 'https://a.com/' })).toBe(false);
    expect(fromContentScript({ tab: { id: '3' }, url: 'https://a.com/' })).toBe(false);
    expect(fromContentScript({ tab: { id: 3 }, url: bg().SWITCHER_URL })).toBe(false);
  });

  it('fromSwitcher: the switcher page only', () => {
    const { fromSwitcher } = bg();
    expect(fromSwitcher({ url: bg().SWITCHER_URL })).toBe(true);
    expect(fromSwitcher({ url: bg().SWITCHER_URL + '?t=x' })).toBe(true);
    expect(fromSwitcher({ url: `chrome-extension://${chrome.runtime.id}/sweep.html` })).toBe(false);
    expect(fromSwitcher({ url: 'https://evil.com/switcher.html' })).toBe(false);
    expect(fromSwitcher({ url: 'chrome-extension://otherextensionidxxxxxxxxxxxxxxxxx/switcher.html' })).toBe(false);
    expect(fromSwitcher({})).toBe(false);
  });

  it('ignores other extensions and malformed messages', async () => {
    const { tab } = seed();
    for (const [msg, sender] of [
      [{ type: MSG.HOTKEY, dir: 1 }, { ...fromPage(tab), id: 'otherextension' }],
      [null, fromPage(tab)],
      ['tabazing:hotkey', fromPage(tab)],
      [{ type: 5 }, fromPage(tab)],
      [{ type: 'tabazing:unknown' }, fromPage(tab)],
    ]) expect(send(msg, sender).ret).toBeUndefined();
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('MSG.OPENED has no handler in the worker', () => {
    const { ret, respond } = send({ type: MSG.OPENED }, fromSwitcherPage());
    expect(ret).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
  });
});

describe('HOTKEY', () => {
  it.each([[-1, -1], [0, 0], [1, 1], [7, 1], ['x', 1]])('dir %s from a page opens with dir %s', async (dir, want) => {
    const { tab } = seed();
    send({ type: MSG.HOTKEY, dir, hold: true }, fromPage(tab));
    await flush();
    expect(cycleCalls()).toEqual([{ type: MSG.CYCLE, dir: want, hold: true }]);
    expect(launch().ctx).toMatchObject({ src: tab.id, via: 'key', hold: true });
  });

  it('hold only when it is exactly true', async () => {
    const { tab } = seed();
    send({ type: MSG.HOTKEY, dir: 1, hold: 'yes' }, fromPage(tab));
    await flush();
    expect(cycleCalls()[0].hold).toBe(false);
  });

  it('palette: true (Alt+R in a page) opens the palette; the rest of the message is ignored', async () => {
    const { tab } = seed();
    send({ type: MSG.HOTKEY, dir: -1, hold: true, palette: true }, fromPage(tab));
    await flush();
    expect(cycleCalls()).toEqual([{ type: MSG.CYCLE, dir: 0, hold: false, palette: true }]);
    expect(launch().ctx).toMatchObject({ src: tab.id, dir: 0, hold: false, palette: true });
  });

  it('palette only when it is exactly true', async () => {
    const { tab } = seed();
    send({ type: MSG.HOTKEY, dir: 1, hold: false, palette: 'yes' }, fromPage(tab));
    await flush();
    expect(cycleCalls()).toEqual([{ type: MSG.CYCLE, dir: 1, hold: false }]);
    expect(launch().ctx.palette).toBeUndefined();
  });

  it('palette from the switcher page is ignored too', async () => {
    const { tab } = seed();
    send({ type: MSG.HOTKEY, palette: true }, fromSwitcherPage(tab));
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('is ignored from the switcher page or a sender without a tab', async () => {
    const { tab } = seed();
    send({ type: MSG.HOTKEY, dir: 1 }, fromSwitcherPage(tab));
    send({ type: MSG.HOTKEY, dir: 1 }, { id: chrome.runtime.id, url: 'https://a.com/' });
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('READY', () => {
  it('answers with the queued moves, clamped to ±20', async () => {
    const { tab } = seed('chrome://newtab/');
    for (let i = 0; i < 26; i++) await bg().openSwitcher(-1, tab);
    expect(bg().opening.extra).toBe(-25);
    const { respond } = send({ type: MSG.READY }, fromSwitcherPage());
    expect(respond).toHaveBeenCalledWith({ extra: -20 });
    expect(bg().opening).toBeNull();
  });

  it('answers extra 0 when nothing is opening', () => {
    expect(send({ type: MSG.READY }, fromSwitcherPage()).respond).toHaveBeenCalledWith({ extra: 0 });
  });

  it('is ignored from a page', async () => {
    const { tab } = seed();
    await bg().openSwitcher(1, tab);
    const { respond } = send({ type: MSG.READY }, fromPage(tab));
    expect(respond).not.toHaveBeenCalled();
    expect(bg().watchdog).not.toBeNull();
    expect(bg().opening).not.toBeNull();
  });
});

describe('CLOSED', () => {
  it('resets the opening state and the overlay mark', async () => {
    const { tab } = seed();
    await bg().openSwitcher(1, tab);
    send({ type: MSG.CLOSED, reason: 'switch' }, fromSwitcherPage(tab));
    await flush();
    expect(bg().watchdog).toBeNull();
    expect(bg().opening).toBeNull();
    expect(bg().quietAt).toBe(Date.now());
    expect(chrome.storage.session._data.has(KEY.OVERLAY)).toBe(false);
  });

  it('after a cancel, puts the window back (now and again after 250 ms)', async () => {
    const w = chrome._addWindow({ state: 'minimized', focused: false });
    send({ type: MSG.CLOSED, reason: 'cancel', win: w.id, state: 'maximized' }, fromSwitcherPage());
    await flush();
    expect(chrome.windows.update).toHaveBeenCalledWith(w.id, { state: 'maximized' });
    expect(chrome.windows.update).toHaveBeenCalledWith(w.id, { focused: true });
    chrome.windows.update.mockClear();
    await vi.advanceTimersByTimeAsync(250);
    expect(chrome.windows.update).toHaveBeenCalledWith(w.id, { focused: true });
  });

  it('a cancel with a bad state restores to normal; one without a window restores nothing', async () => {
    const w = chrome._addWindow({ state: 'minimized' });
    send({ type: MSG.CLOSED, reason: 'cancel', win: w.id, state: 'minimized' }, fromSwitcherPage());
    send({ type: MSG.CLOSED, reason: 'cancel', win: 'x' }, fromSwitcherPage());
    await flush();
    expect(chrome.windows.update).toHaveBeenCalledWith(w.id, { state: 'normal' });
    expect(chrome.windows.update.mock.calls.every(([id]) => id === w.id)).toBe(true);
  });

  it('warns about a reason it does not know', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    send({ type: MSG.CLOSED, reason: 'weird' }, fromSwitcherPage());
    expect(warn).toHaveBeenCalledWith('[Tabazing] unexpected close reason');
    warn.mockClear();
    for (const reason of ['switch', 'restore', 'blur']) send({ type: MSG.CLOSED, reason }, fromSwitcherPage());
    expect(warn).not.toHaveBeenCalled();
  });

  it('is ignored from a page', async () => {
    const { tab } = seed();
    await bg().openSwitcher(1, tab);
    send({ type: MSG.CLOSED, reason: 'cancel', win: tab.windowId }, fromPage(tab));
    await flush();
    expect(bg().opening).not.toBeNull();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });
});

describe('restoreWindow', () => {
  it('only un-minimises a minimised window, and always focuses it', async () => {
    const w = chrome._addWindow({ state: 'normal', focused: false });
    await bg().restoreWindow(w.id, 'maximized');
    expect(chrome.windows.update.mock.calls).toEqual([[w.id, { focused: true }]]);
  });
  it('swallows a window that is gone', async () => {
    await expect(bg().restoreWindow(42, 'normal')).resolves.toBeUndefined();
  });
});

describe('SWEEP', () => {
  function twoTabs() {
    const { tab, w } = seed('https://a.com/');
    const b = chrome._addTab({ windowId: w.id, url: 'https://b.com/' });
    return { tab, b };
  }

  it('says how many tabs need a picture, then visits them and reopens over the tab it came from', async () => {
    const { tab, b } = twoTabs();
    const { ret, respond } = send({ type: MSG.SWEEP, tabIds: null, reopen: tab.id }, fromSwitcherPage());
    expect(ret).toBe(true); // answered asynchronously
    await flush();
    expect(respond).toHaveBeenCalledWith({ n: 1 });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(chrome.tabs.update).toHaveBeenCalledWith(b.id, { active: true });
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(cycleCalls()).toEqual([{ type: MSG.CYCLE, dir: 1, hold: false }]);
    expect(launch().ctx.src).toBe(tab.id);
  });

  it('keeps to integer tab ids, at most SWEEP_MAX_TABS of them', async () => {
    const { b } = twoTabs();
    const { respond } = send({ type: MSG.SWEEP, tabIds: ['x', 1.5, b.id] }, fromSwitcherPage());
    await flush();
    expect(respond).toHaveBeenCalledWith({ n: 1 });
    const { respond: r2 } = send({ type: MSG.SWEEP, tabIds: [...Array(LIMITS.SWEEP_MAX_TABS).fill(999), b.id] }, fromSwitcherPage());
    await flush();
    expect(r2).toHaveBeenCalledWith({ n: 0 }); // b is past the cap
  });

  it('nothing to capture: answers 0 and runs nothing', async () => {
    seed();
    const { respond } = send({ type: MSG.SWEEP }, fromSwitcherPage());
    await flush();
    expect(respond).toHaveBeenCalledWith({ n: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });

  it('answers 0 when listing the tabs fails', async () => {
    chrome.windows.getAll.mockRejectedValueOnce(new Error('no'));
    const { respond } = send({ type: MSG.SWEEP }, fromSwitcherPage());
    await flush();
    expect(respond).toHaveBeenCalledWith({ n: 0 });
  });

  it('is ignored from a page', () => {
    const { tab } = twoTabs();
    const { ret, respond } = send({ type: MSG.SWEEP }, fromPage(tab));
    expect(ret).toBeUndefined();
    expect(respond).not.toHaveBeenCalled();
  });

  it('SWEEP_CANCEL from the sweep window stops a run; from anywhere else it does not', async () => {
    const { w } = seed('https://a.com/');
    for (const u of ['https://b.com/', 'https://c.com/', 'https://d.com/']) chrome._addTab({ windowId: w.id, url: u });
    send({ type: MSG.SWEEP }, fromSwitcherPage());
    await flush();
    await vi.advanceTimersByTimeAsync(150);
    const shown = () => chrome.tabs.update.mock.calls.filter(([, p]) => p.active).map(([id]) => id); // (the sweep also mutes each visit)
    expect(shown()).toEqual([2]);
    send({ type: MSG.SWEEP_CANCEL }, fromSwitcherPage()); // not the sweep window
    send({ type: MSG.SWEEP_CANCEL }, { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/sweep.html` });
    await vi.advanceTimersByTimeAsync(10000);
    // the first visit, then only putting the window back on its tab
    expect(shown()).toEqual([2, 1]);
  });
});

describe('CAPTURE_ONE', () => {
  it('captures one tab and answers whether it worked', async () => {
    const { tab, w } = seed();
    const b = chrome._addTab({ windowId: w.id, url: 'https://b.com/' });
    const { ret, respond } = send({ type: MSG.CAPTURE_ONE, tabId: b.id, reopen: tab.id }, fromSwitcherPage());
    expect(ret).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(respond).toHaveBeenCalledWith({ ok: true });
    expect(launch().ctx.src).toBe(tab.id); // reopened over the original tab
  });

  it('answers ok:false when the capture fails', async () => {
    seed();
    chrome.windows.getAll.mockRejectedValue(new Error('no'));
    const { respond } = send({ type: MSG.CAPTURE_ONE, tabId: 1 }, fromSwitcherPage());
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(respond).toHaveBeenCalledWith({ ok: false });
  });

  it('needs an integer tab id and the switcher as sender', () => {
    const { tab } = seed();
    expect(send({ type: MSG.CAPTURE_ONE, tabId: '1' }, fromSwitcherPage()).ret).toBeUndefined();
    expect(send({ type: MSG.CAPTURE_ONE, tabId: tab.id }, fromPage(tab)).ret).toBeUndefined();
  });
});

describe('SLEEP', () => {
  it('unloads the listed background tabs after the switcher has closed', async () => {
    const { tab, w } = seed();
    const b = chrome._addTab({ windowId: w.id, url: 'https://b.com/' });
    const c = chrome._addTab({ windowId: w.id, url: 'https://c.com/', discarded: true });
    send({ type: MSG.SLEEP, tabIds: [tab.id, b.id, c.id, 999, 'x'] }, fromSwitcherPage());
    await flush();
    expect(chrome.tabs.discard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(chrome.tabs.discard.mock.calls).toEqual([[b.id]]); // not the active one, not one already asleep
  });

  it('needs an array of ids from the switcher', async () => {
    const { tab, w } = seed();
    const b = chrome._addTab({ windowId: w.id, url: 'https://b.com/' });
    send({ type: MSG.SLEEP, tabIds: b.id }, fromSwitcherPage());
    send({ type: MSG.SLEEP, tabIds: [b.id] }, fromPage(tab));
    await vi.advanceTimersByTimeAsync(1000);
    expect(chrome.tabs.discard).not.toHaveBeenCalled();
  });
});

describe('FLYOUT_DONE', () => {
  it('a page marks the first-run flyout as done', async () => {
    const { tab } = seed();
    send({ type: MSG.FLYOUT_DONE }, fromPage(tab));
    await flush();
    expect(chrome.storage.local._data.get(KEY.ONBOARD)).toMatchObject({ flyout: true });
  });
  it('is ignored from the switcher', async () => {
    send({ type: MSG.FLYOUT_DONE }, fromSwitcherPage());
    await flush();
    expect(chrome.storage.local._data.has(KEY.ONBOARD)).toBe(false);
  });
});

describe('NUDGE answers', () => {
  it('"try" opens the switcher over that tab', async () => {
    const { tab } = seed();
    send({ type: MSG.NUDGE, act: 'try' }, fromPage(tab));
    await flush();
    expect(cycleCalls()).toEqual([{ type: MSG.CYCLE, dir: 1, hold: false }]);
    expect(launch().ctx).toMatchObject({ src: tab.id, via: 'key' });
  });
  it('"never" turns it off for good; "ok" changes nothing', async () => {
    const { tab } = seed();
    send({ type: MSG.NUDGE, act: 'ok' }, fromPage(tab));
    await flush();
    expect(chrome.storage.local._data.has(KEY.NUDGE)).toBe(false);
    send({ type: MSG.NUDGE, act: 'never' }, fromPage(tab));
    await flush();
    expect(chrome.storage.local._data.get(KEY.NUDGE)).toMatchObject({ never: true });
  });
  it('is ignored from the switcher', async () => {
    send({ type: MSG.NUDGE, act: 'never' }, fromSwitcherPage());
    send({ type: MSG.NUDGE, act: 'try' }, fromSwitcherPage(seed().tab));
    await flush();
    expect(chrome.storage.local._data.has(KEY.NUDGE)).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('FALLBACK', () => {
  async function openOverlay() {
    const s = seed();
    await bg().openSwitcher(-1, s.tab, 'key', true);
    chrome.scripting.executeScript.mockClear();
    return s;
  }

  it('swaps the overlay for the popup window (without hold)', async () => {
    const { tab, w } = await openOverlay();
    send({ type: MSG.FALLBACK }, fromSwitcherPage(tab));
    expect(bg().overlayOpen).toBeNull();
    expect(bg().watchdog).toBeNull();
    expect(bg().opening).toBeNull();
    await flush();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: tab.id }, func: bg().removeOverlay, injectImmediately: true });
    expect(launch().ctx).toEqual({ src: tab.id, win: w.id, dir: -1, via: 'key', hold: false, state: 'normal', mode: 'window' });
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ url: bg().SWITCHER_URL + '?t=' + launch().token }));
  });

  it('only for the tab the overlay is in, and only from the switcher', async () => {
    const { tab } = await openOverlay();
    send({ type: MSG.FALLBACK }, fromSwitcherPage({ ...tab, id: tab.id + 1 }));
    send({ type: MSG.FALLBACK }, fromSwitcherPage());
    send({ type: MSG.FALLBACK }, fromPage(tab));
    await flush();
    expect(bg().overlayOpen).not.toBeNull();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('does nothing with no overlay open', async () => {
    send({ type: MSG.FALLBACK }, fromSwitcherPage(seed().tab));
    await flush();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });
});
