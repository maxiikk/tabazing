// background.js: start-up work, setup/install/startup, tab and window events (MRU), badge, snoozed tabs.
import { describe, it, expect, vi } from 'vitest';
import { MESSAGE, KEY, LIMITS, SNOOZE_ALARM } from '../utils/constants.js';
import { environment, flush, freshWorker, seed, launch, patternQuery } from './helpers/background.js';

freshWorker();
const background = () => environment.background;
const sessionData = () => chrome.storage.session._data;
const localData = () => chrome.storage.local._data;
const mru = () => sessionData().get(KEY.MRU);
const hotkeyInjections = () => chrome.scripting.executeScript.mock.calls.filter(([options]) => options.files && options.files[0] === 'hotkey.js').map(([options]) => options.target);

describe('worker start', () => {
  // These run on import, so the worker is imported again here, after seeding.
  async function reimport() {
    chrome._clearListeners();
    vi.resetModules();
    environment.background = await import('../background.js');
    await flush();
  }

  it('marks the session start, colours the badge and counts the tabs', async () => {
    seed();
    await reimport();
    expect(sessionData().get(KEY.BOOT_AT)).toBe(Date.now());
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#1B2A4A' });
    expect(chrome.action.setBadgeTextColor).toHaveBeenCalledWith({ color: '#D2FF3C' });
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '1' });
  });

  it('keeps an existing session start', async () => {
    sessionData().set(KEY.BOOT_AT, 123);
    await reimport();
    expect(sessionData().get(KEY.BOOT_AT)).toBe(123);
  });

  it('clears a "sweep running" flag a dead worker left behind', async () => {
    sessionData().set(KEY.SWEEP, { running: true, done: 3, total: 9 });
    await reimport();
    expect(sessionData().get(KEY.SWEEP)).toEqual({ running: false, done: 0, total: 0 });
  });

  it('prepares the switcher in the active web tabs', async () => {
    const { tab } = seed();
    await reimport();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: tab.id }, func: background().overlayHost }));
  });

  it('wakes snoozed tabs that came due while Chrome was closed', async () => {
    const { w: chromeWindow } = seed();
    localData().set(KEY.SNOOZED, [{ id: 'a', url: 'https://later.com/', at: Date.now() - 1000, windowId: chromeWindow.id }]);
    await reimport();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://later.com/', windowId: chromeWindow.id, active: false, pinned: false });
  });

  it('keeps the worker warm with a cheap call every 20 s', async () => {
    await vi.advanceTimersByTimeAsync(20000);
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(2);
  });
});

describe('updateBadge', () => {
  it('debounces to one count of the normal windows\' tabs', async () => {
    const { w: chromeWindow } = seed();
    chrome._addTab({ windowId: chromeWindow.id });
    const popupWindow = chrome._addWindow({ type: 'popup' });
    chrome._addTab({ windowId: popupWindow.id });
    background().updateBadge();
    background().updateBadge();
    expect(background().badgeTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.action.setBadgeText.mock.calls).toEqual([[{ text: '2' }]]);
  });

  it('caps the text at 999+', async () => {
    chrome.tabs.query.mockResolvedValueOnce(Array(1000).fill({}));
    background().updateBadge();
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '999+' });
  });

  it('swallows errors', async () => {
    chrome.tabs.query.mockRejectedValueOnce(new Error('no'));
    background().updateBadge();
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.action.setBadgeText).not.toHaveBeenCalled();
  });

  it('follows tabs and windows opening and closing', async () => {
    const { tab } = seed();
    chrome.tabs.onCreated._emit(tab);
    await vi.advanceTimersByTimeAsync(300);
    chrome.tabs.onRemoved._emit(tab.id, { windowId: tab.windowId });
    await vi.advanceTimersByTimeAsync(300);
    chrome.windows.onRemoved._emit(tab.windowId);
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.action.setBadgeText).toHaveBeenCalledTimes(3);
  });
});

describe('checkShortcut', () => {
  it('warns when Alt+Q is unassigned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chrome.commands.getAll.mockResolvedValueOnce([{ name: 'open-switcher', shortcut: '' }]);
    await background().checkShortcut();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Alt+Q shortcut is not assigned'));
    warn.mockClear();
    chrome.commands.getAll.mockResolvedValueOnce([]);
    await background().checkShortcut();
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('is quiet when it is assigned, or when the lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chrome.commands.getAll.mockResolvedValueOnce([{ name: 'open-switcher', shortcut: 'Alt+Q' }]);
    await background().checkShortcut();
    chrome.commands.getAll.mockRejectedValueOnce(new Error('no'));
    await background().checkShortcut();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('setup', () => {
  it('seeds the MRU with the active tabs, remembers every tab and captures the focused one', async () => {
    const { tab, w: chromeWindow } = seed('https://a.com/');
    chrome._addTab({ windowId: chromeWindow.id, url: 'https://b.com/' });
    const secondChromeWindow = chrome._addWindow({ focused: false });
    const thirdTab = chrome._addTab({ windowId: secondChromeWindow.id, url: 'https://c.com/', active: true });
    await background().setup();
    await flush();
    expect(mru()).toEqual([tab.id, thirdTab.id]);
    expect(sessionData().get('m:2')).toEqual({ u: 'https://b.com/', ti: 'Example', f: '' });
    expect(chrome.commands.getAll).toHaveBeenCalled();
    expect(localData().has(KEY.PREVIEW_CLEANUP)).toBe(false); // previews are only expired after install/update
    await vi.advanceTimersByTimeAsync(200);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(chromeWindow.id, expect.anything());
  });

  it('leaves an existing MRU alone', async () => {
    seed();
    sessionData().set(KEY.MRU, [9, 8]);
    await background().setup();
    expect(mru()).toEqual([9, 8]);
  });

  it('fresh: also expires old previews', async () => {
    seed();
    await background().setup({ fresh: true });
    await flush();
    expect(localData().get(KEY.PREVIEW_CLEANUP)).toBe(Date.now());
  });

  it('trims the closed-tab log', async () => {
    localData().set(KEY.CLOSED_LOG, [{ url: 'https://old.com/', title: '', favIconUrl: '', closedAt: Date.now() - LIMITS.CLOSED_LOG_TIME_TO_LIVE_MILLISECONDS - 1 }]);
    await background().setup();
    await flush();
    expect(localData().get(KEY.CLOSED_LOG)).toEqual([]);
  });
});

describe('onInstalled', () => {
  it('install: first-run flags, the flyout, and the content script in open tabs', async () => {
    patternQuery();
    const { tab, w: chromeWindow } = seed('https://a.com/');
    const fileTab = chrome._addTab({ windowId: chromeWindow.id, url: 'file:///C:/x.html' });
    chrome._addTab({ windowId: chromeWindow.id, url: 'chrome://settings/' });
    await chrome.runtime.onInstalled._emit({ reason: 'install' })[0];
    await flush();
    expect(localData().get(KEY.ONBOARD)).toEqual({ at: Date.now(), flyout: false, tour: false });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: tab.id }, func: background().injectFlyout }));
    expect(hotkeyInjections()).toEqual([{ tabId: tab.id, allFrames: true }, { tabId: fileTab.id, allFrames: true }]);
    expect(localData().get(KEY.PREVIEW_CLEANUP)).toBe(Date.now()); // setup({ fresh: true })
  });

  it('puts the media scripts into open tabs too: the relay first, then the hook in the page world', async () => {
    patternQuery();
    const { tab } = seed('https://a.com/');
    await chrome.runtime.onInstalled._emit({ reason: 'update' })[0];
    await flush();
    const files = chrome.scripting.executeScript.mock.calls.filter(([options]) => options.files && options.target.tabId === tab.id).map(([options]) => [options.files[0], options.world || 'ISOLATED', options.target.allFrames]);
    expect(files).toEqual([['hotkey.js', 'ISOLATED', true], ['media-relay.js', 'ISOLATED', true], ['media-hook.js', 'MAIN', true]]);
  });

  it('update: no first-run flags or flyout, but the content script all the same', async () => {
    patternQuery();
    const { tab } = seed('https://a.com/');
    await chrome.runtime.onInstalled._emit({ reason: 'update' })[0];
    await flush();
    expect(localData().has(KEY.ONBOARD)).toBe(false);
    expect(chrome.scripting.executeScript.mock.calls.some(([options]) => options.func === background().injectFlyout)).toBe(false);
    expect(hotkeyInjections()).toEqual([{ tabId: tab.id, allFrames: true }]);
  });

  it('a tab that refuses the script does not stop the others', async () => {
    patternQuery();
    const { tab, w: chromeWindow } = seed('https://a.com/');
    const otherTab = chrome._addTab({ windowId: chromeWindow.id, url: 'https://b.com/' });
    chrome.scripting.executeScript.mockImplementation(async (options) => { if (options.target.tabId === tab.id) throw new Error('no'); return []; });
    await expect(chrome.runtime.onInstalled._emit({ reason: 'update' })[0]).resolves.toBeUndefined();
    expect(hotkeyInjections()).toContainEqual({ tabId: otherTab.id, allFrames: true });
  });
});

describe('onStartup', () => {
  it('marks a new session and sets up', async () => {
    const { tab } = seed();
    sessionData().set(KEY.BOOT_AT, 1);
    await chrome.runtime.onStartup._emit()[0];
    expect(sessionData().get(KEY.BOOT_AT)).toBe(Date.now());
    expect(mru()).toEqual([tab.id]);
    await vi.advanceTimersByTimeAsync(LIMITS.STARTUP_OPEN_MILLISECONDS);
    expect(launch()).toBeUndefined(); // "open at start" is off
  });

  it('opens Tabazing once the tabs are back, when the setting is on', async () => {
    const { tab } = seed();
    localData().set(KEY.PREFERENCES, { startup: true });
    await chrome.runtime.onStartup._emit()[0];
    await vi.advanceTimersByTimeAsync(LIMITS.STARTUP_OPEN_MILLISECONDS - 1);
    expect(launch()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.CYCLE, direction: 1, hold: false });
    expect(launch().context).toMatchObject({ sourceTab: tab.id, via: 'startup', direction: 1 });
  });
});

describe('permissions.onAdded', () => {
  it('new site access: content script into open web tabs and a first preview', async () => {
    patternQuery();
    const { tab, w: chromeWindow } = seed('https://a.com/');
    chrome.permissions.onAdded._emit({ origins: ['<all_urls>'] });
    await flush();
    expect(hotkeyInjections()).toEqual([{ tabId: tab.id, allFrames: true }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(chromeWindow.id, expect.anything());
  });
  it('ignores API permissions without origins', async () => {
    seed();
    chrome.permissions.onAdded._emit({ permissions: ['bookmarks'] });
    chrome.permissions.onAdded._emit({ origins: [] });
    await flush();
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });
});

describe('tabs.onActivated', () => {
  it('moves the tab to the front of the MRU and captures it', async () => {
    const { tab, w: chromeWindow } = seed();
    const otherTab = chrome._addTab({ windowId: chromeWindow.id, url: 'https://b.com/' });
    sessionData().set(KEY.MRU, [tab.id]);
    sessionData().set(KEY.OVERLAY, { tabId: tab.id, t: Date.now() });
    await chrome.tabs.onActivated._emit({ tabId: otherTab.id, windowId: chromeWindow.id })[0];
    await flush();
    expect(mru()).toEqual([otherTab.id, tab.id]);
    expect(sessionData().has(KEY.OVERLAY)).toBe(false);
    expect(background().steps.get(chromeWindow.id)).toMatchObject({ index: 1, n: 0 });
    await vi.advanceTimersByTimeAsync(350);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalled();
  });

  it('our own pages are not tabs the user used', async () => {
    const chromeWindow = chrome._addWindow();
    const own = chrome._addTab({ windowId: chromeWindow.id, url: environment.background.SWITCHER_URL, active: true });
    const pending = chrome._addTab({ windowId: chromeWindow.id, url: '', pendingUrl: environment.background.SWITCHER_URL });
    await chrome.tabs.onActivated._emit({ tabId: own.id, windowId: chromeWindow.id })[0];
    await chrome.tabs.onActivated._emit({ tabId: pending.id, windowId: chromeWindow.id })[0];
    await flush();
    expect(mru()).toBeUndefined();
  });

  it('a tab that is already gone is ignored', async () => {
    await expect(chrome.tabs.onActivated._emit({ tabId: 99, windowId: 1 })[0]).resolves.toBeUndefined();
    expect(mru()).toBeUndefined();
  });

  it('prepares the switcher in the newly shown tab', async () => {
    const { tab, w: chromeWindow } = seed();
    await chrome.tabs.onActivated._emit({ tabId: tab.id, windowId: chromeWindow.id })[0];
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: tab.id }, args: expect.arrayContaining(['standby']) }));
  });
});

describe('tabs.onCreated / onUpdated / onRemoved / onReplaced', () => {
  it('onCreated remembers the tab and quiets the nudge', async () => {
    const { tab } = seed('https://a.com/');
    chrome.tabs.onCreated._emit(tab);
    await flush();
    expect(sessionData().get('m:' + tab.id)).toMatchObject({ u: 'https://a.com/' });
    expect(background().quietAt).toBe(Date.now());
  });

  it('onUpdated remembers url/title/icon changes', async () => {
    const tab = seed('https://a.com/').tab;
    chrome.tabs.onUpdated._emit(tab.id, { title: 'New' }, { ...tab, title: 'New' });
    await flush();
    expect(sessionData().get('m:' + tab.id)).toMatchObject({ ti: 'New' });
    sessionData().delete('m:' + tab.id);
    chrome.tabs.onUpdated._emit(tab.id, { audible: true }, { ...tab, title: 'Other' });
    await flush();
    expect(sessionData().has('m:' + tab.id)).toBe(false);
  });

  it('onUpdated prepares the switcher as an active page loads, and again when it has', async () => {
    const tab = seed().tab;
    const standby = () => chrome.scripting.executeScript.mock.calls.filter(([options]) => options.args && options.args[3] === 'standby').length;
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading' }, { ...tab, status: 'loading' });
    await vi.advanceTimersByTimeAsync(249);
    expect(standby()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(standby()).toBe(1);
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading' }, { ...tab, active: false });
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(standby()).toBe(1);
  });

  it('onUpdated: a finished load in the active tab is captured and may show the flyout', async () => {
    const tab = seed().tab;
    localData().set(KEY.ONBOARD, { at: Date.now(), flyout: false, tour: false });
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab);
    await flush();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ func: background().injectFlyout }));
    await vi.advanceTimersByTimeAsync(450);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalled();
  });

  it('onUpdated tracks Chrome discarding a tab', async () => {
    const tab = seed().tab;
    chrome.tabs.onUpdated._emit(tab.id, { discarded: true }, tab);
    await flush();
    expect(sessionData().get(KEY.SLEPT)).toEqual([tab.id]);
    chrome.tabs.onUpdated._emit(tab.id, { discarded: false }, tab);
    await flush();
    expect(sessionData().get(KEY.SLEPT)).toEqual([]);
  });

  it('onRemoved drops the tab from the MRU and the slept list, and logs it as closed', async () => {
    const { tab, w: chromeWindow } = seed('https://a.com/');
    chrome.tabs.onCreated._emit(tab);
    sessionData().set(KEY.MRU, [tab.id, 5]);
    sessionData().set(KEY.SLEPT, [tab.id]);
    await flush();
    vi.advanceTimersByTime(1000);
    const closedAt = Date.now();
    chrome.tabs.onRemoved._emit(tab.id, { windowId: chromeWindow.id, isWindowClosing: false });
    await flush();
    expect(mru()).toEqual([5]);
    expect(sessionData().get(KEY.SLEPT)).toEqual([]);
    expect(localData().has(KEY.CLOSED_LOG)).toBe(false); // closes are logged in batches, a moment later
    await vi.advanceTimersByTimeAsync(100);
    expect(localData().get(KEY.CLOSED_LOG)).toEqual([{ url: 'https://a.com/', title: 'Example', favIconUrl: '', closedAt }]);
    expect(background().quietAt).toBe(closedAt);
  });

  it('tabs closed together (a window) are logged with one write', async () => {
    const { w: chromeWindow } = seed('https://a.com/');
    chrome._addTab({ windowId: chromeWindow.id, url: 'https://b.com/' });
    chrome._addTab({ windowId: chromeWindow.id, url: 'https://c.com/' });
    for (const tab of chrome._data.tabs) chrome.tabs.onCreated._emit(structuredClone(tab));
    await flush();
    chrome.storage.local.set.mockClear();
    for (const tab of [...chrome._data.tabs]) chrome.tabs.onRemoved._emit(tab.id, { windowId: chromeWindow.id, isWindowClosing: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(chrome.storage.local.set.mock.calls.filter(([options]) => KEY.CLOSED_LOG in options)).toHaveLength(1);
    expect(localData().get(KEY.CLOSED_LOG).map((entry) => entry.url)).toEqual(['https://c.com/', 'https://b.com/', 'https://a.com/']);
  });

  it('a waiting batch of closes is written when Chrome suspends the worker', async () => {
    const onSuspend = { listeners: new Set(), addListener(listener) { this.listeners.add(listener); } };
    chrome.runtime.onSuspend = onSuspend;
    try {
      chrome._clearListeners();
      vi.resetModules();
      environment.background = await import('../background.js');
      const { tab, w: chromeWindow } = seed('https://a.com/');
      chrome.tabs.onCreated._emit(tab);
      await flush();
      chrome.tabs.onRemoved._emit(tab.id, { windowId: chromeWindow.id, isWindowClosing: false });
      await flush();
      expect(localData().has(KEY.CLOSED_LOG)).toBe(false);
      onSuspend.listeners.forEach((listener) => listener());
      await flush();
      expect(localData().get(KEY.CLOSED_LOG).map((entry) => entry.url)).toEqual(['https://a.com/']);
    } finally {
      delete chrome.runtime.onSuspend;
    }
  });

  it('a tab that ends on a blank page logs nothing when it closes, not the page it showed before', async () => {
    const { tab } = seed('https://a.com/');
    chrome.tabs.onUpdated._emit(tab.id, { title: 'A' }, { ...tab, title: 'A' });
    await flush();
    expect(sessionData().get('m:' + tab.id)).toMatchObject({ u: 'https://a.com/' });
    await chrome.tabs.update(tab.id, { url: 'chrome://newtab/' }); // Chrome says { url } in onUpdated
    await flush();
    expect(sessionData().has('m:' + tab.id)).toBe(false);
    await chrome.tabs.remove(tab.id);
    await vi.advanceTimersByTimeAsync(200);
    expect(localData().get(KEY.CLOSED_LOG) || []).toEqual([]);
  });

  it('onReplaced swaps the ids in the MRU and slept list and remembers the new tab', async () => {
    const { tab, w: chromeWindow } = seed('https://a.com/');
    const added = chrome._addTab({ windowId: chromeWindow.id, url: 'https://b.com/' });
    sessionData().set(KEY.MRU, [tab.id, 7]);
    sessionData().set(KEY.SLEPT, [tab.id]);
    sessionData().set('m:' + tab.id, { u: 'https://a.com/', ti: '', f: '' });
    chrome.tabs.onReplaced._emit(added.id, tab.id);
    await flush();
    expect(mru()).toEqual([added.id, 7]);
    expect(sessionData().get(KEY.SLEPT)).toEqual([added.id]);
    expect(sessionData().has('m:' + tab.id)).toBe(false);
    expect(sessionData().get('m:' + added.id)).toMatchObject({ u: 'https://b.com/' });
  });
});

describe('windows.onFocusChanged', () => {
  it('a focused window\'s active tab goes to the front of the MRU', async () => {
    const { tab, w: chromeWindow } = seed();
    await chrome.windows.onFocusChanged._emit(chromeWindow.id)[0];
    await flush();
    expect(mru()).toEqual([tab.id]);
    await vi.advanceTimersByTimeAsync(350);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalled();
  });
  it('ignores focus leaving Chrome and our own pages', async () => {
    const chromeWindow = chrome._addWindow();
    chrome._addTab({ windowId: chromeWindow.id, url: environment.background.SWITCHER_URL, active: true });
    await chrome.windows.onFocusChanged._emit(chrome.windows.WINDOW_ID_NONE)[0];
    await chrome.windows.onFocusChanged._emit(chromeWindow.id)[0];
    await flush();
    expect(mru()).toBeUndefined();
  });
});

describe('snoozed tabs', () => {
  const snooze = (overrides) => ({ id: 'a', url: 'https://later.com/', at: Date.now() - 1, ...overrides });

  it('the snooze alarm reopens due tabs in their window, in the background', async () => {
    const { w: chromeWindow } = seed();
    localData().set(KEY.SNOOZED, [snooze({ windowId: chromeWindow.id, pinned: true }), snooze({ id: 'b', url: 'https://notyet.com/', at: Date.now() + 60000 })]);
    await chrome.alarms.onAlarm._emit({ name: SNOOZE_ALARM })[0];
    await flush();
    expect(chrome.tabs.create.mock.calls).toEqual([[{ url: 'https://later.com/', windowId: chromeWindow.id, active: false, pinned: true }]]);
    expect(localData().get(KEY.SNOOZED).map((x) => x.id)).toEqual(['b']);
  });

  it('other alarms do nothing', async () => {
    seed();
    localData().set(KEY.SNOOZED, [snooze()]);
    chrome.alarms.onAlarm._emit({ name: 'something' });
    await flush();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('a window that is gone: the last focused one', async () => {
    const { w: chromeWindow } = seed();
    localData().set(KEY.SNOOZED, [snooze({ windowId: 77 })]);
    await background().wakeSnoozed();
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: chromeWindow.id }));
  });

  it('no window at all: a new one', async () => {
    localData().set(KEY.SNOOZED, [snooze({ windowId: null })]);
    await background().wakeSnoozed();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.windows.create).toHaveBeenCalledWith({ url: 'https://later.com/' });
  });

  it('one failure does not stop the rest', async () => {
    const { w: chromeWindow } = seed();
    localData().set(KEY.SNOOZED, [snooze({ windowId: chromeWindow.id }), snooze({ id: 'b', url: 'https://two.com/', windowId: chromeWindow.id })]);
    chrome.tabs.create.mockRejectedValueOnce(new Error('no'));
    await background().wakeSnoozed();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
  });

  it('a tab its window refuses (closed in between) opens in another window', async () => {
    const { w: chromeWindow } = seed();
    const secondChromeWindow = chrome._addWindow();
    localData().set(KEY.SNOOZED, [snooze({ windowId: chromeWindow.id })]);
    chrome.tabs.create.mockRejectedValueOnce(new Error(`No window with id: ${chromeWindow.id}.`));
    chrome.windows.getLastFocused.mockResolvedValueOnce({ id: secondChromeWindow.id });
    await background().wakeSnoozed();
    expect(chrome.tabs.create.mock.calls.map(([options]) => options.windowId)).toEqual([chromeWindow.id, secondChromeWindow.id]);
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(localData().get(KEY.SNOOZED)).toEqual([]);
  });

  it('...or, with no other window, in a new one', async () => {
    const { w: chromeWindow } = seed();
    localData().set(KEY.SNOOZED, [snooze({ windowId: chromeWindow.id })]);
    chrome.tabs.create.mockRejectedValueOnce(new Error('no'));
    await background().wakeSnoozed();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1); // the last focused window is the one that refused
    expect(chrome.windows.create).toHaveBeenCalledWith({ url: 'https://later.com/' });
    expect(localData().get(KEY.SNOOZED)).toEqual([]);
  });

  it('one that cannot be opened anywhere stays snoozed (same id, once), and the next alarm tries again', async () => {
    const { w: chromeWindow } = seed();
    localData().set(KEY.SNOOZED, [snooze({ windowId: chromeWindow.id }), snooze({ id: 'b', url: 'https://two.com/', windowId: chromeWindow.id })]);
    chrome.tabs.create.mockRejectedValueOnce(new Error('no'));
    chrome.windows.create.mockRejectedValueOnce(new Error('no'));
    await background().wakeSnoozed();
    const urls = () => chrome.tabs.create.mock.calls.map(([options]) => options.url);
    expect(urls()).toEqual(['https://later.com/', 'https://two.com/']); // tried once in this run, the rest went on
    expect(localData().get(KEY.SNOOZED).map((x) => x.id)).toEqual(['a']);
    expect(chrome._data.alarms.get(SNOOZE_ALARM)).toBeDefined();
    await chrome.alarms.onAlarm._emit({ name: SNOOZE_ALARM })[0];
    await flush();
    expect(urls()).toEqual(['https://later.com/', 'https://two.com/', 'https://later.com/']);
    expect(localData().get(KEY.SNOOZED)).toEqual([]);
  });

  it('takes them one at a time: a worker stopped while one opens loses none of the others', async () => {
    const { w: chromeWindow } = seed();
    localData().set(KEY.SNOOZED, [snooze({ windowId: chromeWindow.id }), snooze({ id: 'b', url: 'https://two.com/', windowId: chromeWindow.id })]);
    chrome.tabs.create.mockReturnValueOnce(new Promise(() => {})); // never settles: the worker stops here
    background().wakeSnoozed();
    await flush(10);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(localData().get(KEY.SNOOZED).map((x) => x.id)).toEqual(['b']);
  });

  it('nothing due: nothing opens', async () => {
    await background().wakeSnoozed();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('notes each woken tab (in a window or a new one) for the switcher', async () => {
    const { w: chromeWindow } = seed();
    localData().set(KEY.SNOOZED, [snooze({ windowId: chromeWindow.id })]);
    await background().wakeSnoozed();
    const tab = await chrome.tabs.create.mock.results[0].value;
    localData().set(KEY.SNOOZED, [snooze({ id: 'b', windowId: null })]);
    chrome.windows.getLastFocused.mockRejectedValueOnce(new Error('none'));
    await background().wakeSnoozed();
    const createdWindow = await chrome.windows.create.mock.results[0].value;
    expect(sessionData().get(KEY.WOKEN)).toEqual({ [tab.id]: Date.now(), [createdWindow.tabs[0].id]: Date.now() });
  });

  it('a woken tab is forgotten once looked at, or closed', async () => {
    const { w: chromeWindow, tab } = seed();
    const other = chrome._addTab({ windowId: chromeWindow.id, url: 'https://b.com/' });
    sessionData().set(KEY.WOKEN, { [tab.id]: Date.now(), [other.id]: Date.now() });
    await chrome.tabs.onActivated._emit({ tabId: tab.id, windowId: chromeWindow.id })[0];
    await flush();
    expect(sessionData().get(KEY.WOKEN)).toEqual({ [other.id]: Date.now() });
    chrome.tabs.onRemoved._emit(other.id, { windowId: chromeWindow.id, isWindowClosing: false });
    await flush();
    expect(sessionData().get(KEY.WOKEN)).toEqual({});
  });
});

describe('tab groups', () => {
  it('a snoozed tab that was in a group wakes up in it (one of the same name and colour, or a new one)', async () => {
    const { w: chromeWindow } = seed();
    chrome._addGroup({ id: 40, title: 'Work', color: 'blue', windowId: chromeWindow.id });
    const there = chrome._addTab({ windowId: chromeWindow.id, url: 'https://there.com/', groupId: 40 });
    localData().set(KEY.SNOOZED, [{ id: 'a', url: 'https://later.com/', at: Date.now() - 1, windowId: chromeWindow.id, group: { id: 3, title: 'Work', color: 'blue' } }]);
    await background().wakeSnoozed();
    const tab = await chrome.tabs.create.mock.results[0].value;
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [tab.id], groupId: 40 });
    expect(there.groupId).toBe(40);
  });

  it('the closed-tabs log keeps the group a tab was in', async () => {
    const { w: chromeWindow, tab } = seed('https://a.com/');
    chrome._addGroup({ id: 41, title: 'Reading', color: 'green', windowId: chromeWindow.id });
    tab.groupId = 41;
    chrome.tabs.onUpdated._emit(tab.id, { groupId: 41 }, { ...tab });
    await flush(10);
    expect(sessionData().get('m:' + tab.id)).toMatchObject({ u: 'https://a.com/', g: { id: 41, title: 'Reading', color: 'green' } });
    chrome.tabs.onRemoved._emit(tab.id, { windowId: chromeWindow.id, isWindowClosing: false });
    await vi.advanceTimersByTimeAsync(200);
    await flush(10);
    expect(localData().get(KEY.CLOSED_LOG)[0]).toMatchObject({ url: 'https://a.com/', group: { id: 41, title: 'Reading', color: 'green' } });
  });

  it('a tab leaving its group right after another change is remembered out of the group (the older write is dropped)', async () => {
    const { w: chromeWindow, tab } = seed('https://a.com/');
    chrome._addGroup({ id: 43, title: 'Work', color: 'blue', windowId: chromeWindow.id });
    chrome.tabs.onUpdated._emit(tab.id, { title: 'T' }, { ...tab, title: 'T', groupId: 43 }); // waits for its group
    chrome.tabs.onUpdated._emit(tab.id, { groupId: -1 }, { ...tab, title: 'T', groupId: -1 });
    await flush(10);
    expect(sessionData().get('m:' + tab.id)).toEqual({ u: 'https://a.com/', ti: 'T', f: '' });
  });

  it('a group renamed: its tabs\' entries follow', async () => {
    const { w: chromeWindow, tab } = seed('https://a.com/');
    chrome._addGroup({ id: 42, title: 'Old', color: 'red', windowId: chromeWindow.id });
    tab.groupId = 42;
    chrome.tabGroups.onUpdated._emit({ id: 42, title: 'New', color: 'red', windowId: chromeWindow.id });
    await flush(10);
    expect(sessionData().get('m:' + tab.id).g).toEqual({ id: 42, title: 'New', color: 'red' });
  });
});
