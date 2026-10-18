// background.js: start-up work, setup/install/startup, tab and window events (MRU), badge, snoozed tabs.
import { describe, it, expect, vi } from 'vitest';
import { MSG, KEY, LIMITS, SNOOZE_ALARM } from '../lib/constants.js';
import { env, flush, freshWorker, seed, launch, patternQuery } from './background.shared.js';

freshWorker();
const bg = () => env.bg;
const S = () => chrome.storage.session._data;
const L = () => chrome.storage.local._data;
const mru = () => S().get(KEY.MRU);
const hotkeyInjections = () => chrome.scripting.executeScript.mock.calls.filter(([o]) => o.files && o.files[0] === 'hotkey.js').map(([o]) => o.target);

describe('worker start', () => {
  // These run on import, so the worker is imported again here, after seeding.
  async function reimport() {
    chrome._clearListeners();
    vi.resetModules();
    env.bg = await import('../background.js');
    await flush();
  }

  it('marks the session start, colours the badge and counts the tabs', async () => {
    seed();
    await reimport();
    expect(S().get(KEY.BOOT_AT)).toBe(Date.now());
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#1B2A4A' });
    expect(chrome.action.setBadgeTextColor).toHaveBeenCalledWith({ color: '#D2FF3C' });
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '1' });
  });

  it('keeps an existing session start', async () => {
    S().set(KEY.BOOT_AT, 123);
    await reimport();
    expect(S().get(KEY.BOOT_AT)).toBe(123);
  });

  it('clears a "sweep running" flag a dead worker left behind', async () => {
    S().set(KEY.SWEEP, { running: true, done: 3, total: 9 });
    await reimport();
    expect(S().get(KEY.SWEEP)).toEqual({ running: false, done: 0, total: 0 });
  });

  it('prepares the switcher in the active web tabs', async () => {
    const { tab } = seed();
    await reimport();
    vi.advanceTimersByTime(0);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: tab.id }, func: bg().overlayHost }));
  });

  it('wakes snoozed tabs that came due while Chrome was closed', async () => {
    const { w } = seed();
    L().set(KEY.SNOOZED, [{ id: 'a', url: 'https://later.com/', at: Date.now() - 1000, windowId: w.id }]);
    await reimport();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://later.com/', windowId: w.id, active: false, pinned: false });
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
    const { w } = seed();
    chrome._addTab({ windowId: w.id });
    const pop = chrome._addWindow({ type: 'popup' });
    chrome._addTab({ windowId: pop.id });
    bg().updateBadge();
    bg().updateBadge();
    expect(bg().badgeTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.action.setBadgeText.mock.calls).toEqual([[{ text: '2' }]]);
  });

  it('caps the text at 999+', async () => {
    chrome.tabs.query.mockResolvedValueOnce(Array(1000).fill({}));
    bg().updateBadge();
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '999+' });
  });

  it('swallows errors', async () => {
    chrome.tabs.query.mockRejectedValueOnce(new Error('no'));
    bg().updateBadge();
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
    await bg().checkShortcut();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Alt+Q shortcut is not assigned'));
    warn.mockClear();
    chrome.commands.getAll.mockResolvedValueOnce([]);
    await bg().checkShortcut();
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('is quiet when it is assigned, or when the lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chrome.commands.getAll.mockResolvedValueOnce([{ name: 'open-switcher', shortcut: 'Alt+Q' }]);
    await bg().checkShortcut();
    chrome.commands.getAll.mockRejectedValueOnce(new Error('no'));
    await bg().checkShortcut();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('setup', () => {
  it('seeds the MRU with the active tabs, remembers every tab and captures the focused one', async () => {
    const { tab, w } = seed('https://a.com/');
    chrome._addTab({ windowId: w.id, url: 'https://b.com/' });
    const w2 = chrome._addWindow({ focused: false });
    const t3 = chrome._addTab({ windowId: w2.id, url: 'https://c.com/', active: true });
    await bg().setup();
    await flush();
    expect(mru()).toEqual([tab.id, t3.id]);
    expect(S().get('m:2')).toEqual({ u: 'https://b.com/', ti: 'Example', f: '' });
    expect(chrome.commands.getAll).toHaveBeenCalled();
    expect(L().has(KEY.PREVIEW_CLEAN)).toBe(false); // previews are only expired after install/update
    await vi.advanceTimersByTimeAsync(200);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(w.id, expect.anything());
  });

  it('leaves an existing MRU alone', async () => {
    seed();
    S().set(KEY.MRU, [9, 8]);
    await bg().setup();
    expect(mru()).toEqual([9, 8]);
  });

  it('fresh: also expires old previews', async () => {
    seed();
    await bg().setup({ fresh: true });
    await flush();
    expect(L().get(KEY.PREVIEW_CLEAN)).toBe(Date.now());
  });

  it('trims the closed-tab log', async () => {
    L().set(KEY.CLOSED_LOG, [{ url: 'https://old.com/', title: '', favIconUrl: '', closedAt: Date.now() - LIMITS.CLOSED_LOG_TTL_MS - 1 }]);
    await bg().setup();
    await flush();
    expect(L().get(KEY.CLOSED_LOG)).toEqual([]);
  });
});

describe('onInstalled', () => {
  it('install: first-run flags, the flyout, and the content script in open tabs', async () => {
    patternQuery();
    const { tab, w } = seed('https://a.com/');
    const f = chrome._addTab({ windowId: w.id, url: 'file:///C:/x.html' });
    chrome._addTab({ windowId: w.id, url: 'chrome://settings/' });
    await chrome.runtime.onInstalled._emit({ reason: 'install' })[0];
    await flush();
    expect(L().get(KEY.ONBOARD)).toEqual({ at: Date.now(), flyout: false, tour: false });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: tab.id }, func: bg().injectFlyout }));
    expect(hotkeyInjections()).toEqual([{ tabId: tab.id, allFrames: true }, { tabId: f.id, allFrames: true }]);
    expect(L().get(KEY.PREVIEW_CLEAN)).toBe(Date.now()); // setup({ fresh: true })
  });

  it('puts the media scripts into open tabs too: the relay first, then the hook in the page world', async () => {
    patternQuery();
    const { tab } = seed('https://a.com/');
    await chrome.runtime.onInstalled._emit({ reason: 'update' })[0];
    await flush();
    const files = chrome.scripting.executeScript.mock.calls.filter(([o]) => o.files && o.target.tabId === tab.id).map(([o]) => [o.files[0], o.world || 'ISOLATED', o.target.allFrames]);
    expect(files).toEqual([['hotkey.js', 'ISOLATED', true], ['media-relay.js', 'ISOLATED', true], ['media-hook.js', 'MAIN', true]]);
  });

  it('update: no first-run flags or flyout, but the content script all the same', async () => {
    patternQuery();
    const { tab } = seed('https://a.com/');
    await chrome.runtime.onInstalled._emit({ reason: 'update' })[0];
    await flush();
    expect(L().has(KEY.ONBOARD)).toBe(false);
    expect(chrome.scripting.executeScript.mock.calls.some(([o]) => o.func === bg().injectFlyout)).toBe(false);
    expect(hotkeyInjections()).toEqual([{ tabId: tab.id, allFrames: true }]);
  });

  it('a tab that refuses the script does not stop the others', async () => {
    patternQuery();
    const { tab, w } = seed('https://a.com/');
    const b = chrome._addTab({ windowId: w.id, url: 'https://b.com/' });
    chrome.scripting.executeScript.mockImplementation(async (o) => { if (o.target.tabId === tab.id) throw new Error('no'); return []; });
    await expect(chrome.runtime.onInstalled._emit({ reason: 'update' })[0]).resolves.toBeUndefined();
    expect(hotkeyInjections()).toContainEqual({ tabId: b.id, allFrames: true });
  });
});

describe('onStartup', () => {
  it('marks a new session and sets up', async () => {
    const { tab } = seed();
    S().set(KEY.BOOT_AT, 1);
    await chrome.runtime.onStartup._emit()[0];
    expect(S().get(KEY.BOOT_AT)).toBe(Date.now());
    expect(mru()).toEqual([tab.id]);
    await vi.advanceTimersByTimeAsync(LIMITS.STARTUP_OPEN_MS);
    expect(launch()).toBeUndefined(); // "open at start" is off
  });

  it('opens Tabazing once the tabs are back, when the setting is on', async () => {
    const { tab } = seed();
    L().set(KEY.PREFS, { startup: true });
    await chrome.runtime.onStartup._emit()[0];
    await vi.advanceTimersByTimeAsync(LIMITS.STARTUP_OPEN_MS - 1);
    expect(launch()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG.CYCLE, dir: 1, hold: false });
    expect(launch().ctx).toMatchObject({ src: tab.id, via: 'startup', dir: 1 });
  });
});

describe('permissions.onAdded', () => {
  it('new site access: content script into open web tabs and a first preview', async () => {
    patternQuery();
    const { tab, w } = seed('https://a.com/');
    chrome.permissions.onAdded._emit({ origins: ['<all_urls>'] });
    await flush();
    expect(hotkeyInjections()).toEqual([{ tabId: tab.id, allFrames: true }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(w.id, expect.anything());
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
    const { tab, w } = seed();
    const b = chrome._addTab({ windowId: w.id, url: 'https://b.com/' });
    S().set(KEY.MRU, [tab.id]);
    S().set(KEY.OVERLAY, { tabId: tab.id, t: Date.now() });
    await chrome.tabs.onActivated._emit({ tabId: b.id, windowId: w.id })[0];
    await flush();
    expect(mru()).toEqual([b.id, tab.id]);
    expect(S().has(KEY.OVERLAY)).toBe(false);
    expect(bg().steps.get(w.id)).toMatchObject({ index: 1, n: 0 });
    await vi.advanceTimersByTimeAsync(350);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalled();
  });

  it('our own pages are not tabs the user used', async () => {
    const w = chrome._addWindow();
    const own = chrome._addTab({ windowId: w.id, url: env.bg.SWITCHER_URL, active: true });
    const pending = chrome._addTab({ windowId: w.id, url: '', pendingUrl: env.bg.SWITCHER_URL });
    await chrome.tabs.onActivated._emit({ tabId: own.id, windowId: w.id })[0];
    await chrome.tabs.onActivated._emit({ tabId: pending.id, windowId: w.id })[0];
    await flush();
    expect(mru()).toBeUndefined();
  });

  it('a tab that is already gone is ignored', async () => {
    await expect(chrome.tabs.onActivated._emit({ tabId: 99, windowId: 1 })[0]).resolves.toBeUndefined();
    expect(mru()).toBeUndefined();
  });

  it('prepares the switcher in the newly shown tab', async () => {
    const { tab, w } = seed();
    await chrome.tabs.onActivated._emit({ tabId: tab.id, windowId: w.id })[0];
    vi.advanceTimersByTime(0);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: tab.id }, args: expect.arrayContaining(['standby']) }));
  });
});

describe('tabs.onCreated / onUpdated / onRemoved / onReplaced', () => {
  it('onCreated remembers the tab and quiets the nudge', async () => {
    const { tab } = seed('https://a.com/');
    chrome.tabs.onCreated._emit(tab);
    await flush();
    expect(S().get('m:' + tab.id)).toMatchObject({ u: 'https://a.com/' });
    expect(bg().quietAt).toBe(Date.now());
  });

  it('onUpdated remembers url/title/icon changes', async () => {
    const tab = seed('https://a.com/').tab;
    chrome.tabs.onUpdated._emit(tab.id, { title: 'New' }, { ...tab, title: 'New' });
    await flush();
    expect(S().get('m:' + tab.id)).toMatchObject({ ti: 'New' });
    S().delete('m:' + tab.id);
    chrome.tabs.onUpdated._emit(tab.id, { audible: true }, { ...tab, title: 'Other' });
    await flush();
    expect(S().has('m:' + tab.id)).toBe(false);
  });

  it('onUpdated prepares the switcher as an active page loads, and again when it has', async () => {
    const tab = seed().tab;
    const standby = () => chrome.scripting.executeScript.mock.calls.filter(([o]) => o.args && o.args[3] === 'standby').length;
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading' }, { ...tab, status: 'loading' });
    vi.advanceTimersByTime(249);
    expect(standby()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(standby()).toBe(1);
    chrome.tabs.onUpdated._emit(tab.id, { status: 'loading' }, { ...tab, active: false });
    vi.advanceTimersByTime(300);
    expect(standby()).toBe(1);
  });

  it('onUpdated: a finished load in the active tab is captured and may show the flyout', async () => {
    const tab = seed().tab;
    L().set(KEY.ONBOARD, { at: Date.now(), flyout: false, tour: false });
    chrome.tabs.onUpdated._emit(tab.id, { status: 'complete' }, tab);
    await flush();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ func: bg().injectFlyout }));
    await vi.advanceTimersByTimeAsync(450);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalled();
  });

  it('onUpdated tracks Chrome discarding a tab', async () => {
    const tab = seed().tab;
    chrome.tabs.onUpdated._emit(tab.id, { discarded: true }, tab);
    await flush();
    expect(S().get(KEY.SLEPT)).toEqual([tab.id]);
    chrome.tabs.onUpdated._emit(tab.id, { discarded: false }, tab);
    await flush();
    expect(S().get(KEY.SLEPT)).toEqual([]);
  });

  it('onRemoved drops the tab from the MRU and the slept list, and logs it as closed', async () => {
    const { tab, w } = seed('https://a.com/');
    chrome.tabs.onCreated._emit(tab);
    S().set(KEY.MRU, [tab.id, 5]);
    S().set(KEY.SLEPT, [tab.id]);
    await flush();
    vi.advanceTimersByTime(1000);
    const closedAt = Date.now();
    chrome.tabs.onRemoved._emit(tab.id, { windowId: w.id, isWindowClosing: false });
    await flush();
    expect(mru()).toEqual([5]);
    expect(S().get(KEY.SLEPT)).toEqual([]);
    expect(L().has(KEY.CLOSED_LOG)).toBe(false); // closes are logged in batches, a moment later
    await vi.advanceTimersByTimeAsync(100);
    expect(L().get(KEY.CLOSED_LOG)).toEqual([{ url: 'https://a.com/', title: 'Example', favIconUrl: '', closedAt }]);
    expect(bg().quietAt).toBe(closedAt);
  });

  it('tabs closed together (a window) are logged with one write', async () => {
    const { w } = seed('https://a.com/');
    chrome._addTab({ windowId: w.id, url: 'https://b.com/' });
    chrome._addTab({ windowId: w.id, url: 'https://c.com/' });
    for (const t of chrome._data.tabs) chrome.tabs.onCreated._emit(structuredClone(t));
    await flush();
    chrome.storage.local.set.mockClear();
    for (const t of [...chrome._data.tabs]) chrome.tabs.onRemoved._emit(t.id, { windowId: w.id, isWindowClosing: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(chrome.storage.local.set.mock.calls.filter(([o]) => KEY.CLOSED_LOG in o)).toHaveLength(1);
    expect(L().get(KEY.CLOSED_LOG).map((e) => e.url)).toEqual(['https://c.com/', 'https://b.com/', 'https://a.com/']);
  });

  it('a waiting batch of closes is written when Chrome suspends the worker', async () => {
    const onSuspend = { ls: new Set(), addListener(fn) { this.ls.add(fn); } };
    chrome.runtime.onSuspend = onSuspend;
    try {
      chrome._clearListeners();
      vi.resetModules();
      env.bg = await import('../background.js');
      const { tab, w } = seed('https://a.com/');
      chrome.tabs.onCreated._emit(tab);
      await flush();
      chrome.tabs.onRemoved._emit(tab.id, { windowId: w.id, isWindowClosing: false });
      await flush();
      expect(L().has(KEY.CLOSED_LOG)).toBe(false);
      onSuspend.ls.forEach((fn) => fn());
      await flush();
      expect(L().get(KEY.CLOSED_LOG).map((e) => e.url)).toEqual(['https://a.com/']);
    } finally {
      delete chrome.runtime.onSuspend;
    }
  });

  it('onReplaced swaps the ids in the MRU and slept list and remembers the new tab', async () => {
    const { tab, w } = seed('https://a.com/');
    const added = chrome._addTab({ windowId: w.id, url: 'https://b.com/' });
    S().set(KEY.MRU, [tab.id, 7]);
    S().set(KEY.SLEPT, [tab.id]);
    S().set('m:' + tab.id, { u: 'https://a.com/', ti: '', f: '' });
    chrome.tabs.onReplaced._emit(added.id, tab.id);
    await flush();
    expect(mru()).toEqual([added.id, 7]);
    expect(S().get(KEY.SLEPT)).toEqual([added.id]);
    expect(S().has('m:' + tab.id)).toBe(false);
    expect(S().get('m:' + added.id)).toMatchObject({ u: 'https://b.com/' });
  });
});

describe('windows.onFocusChanged', () => {
  it('a focused window\'s active tab goes to the front of the MRU', async () => {
    const { tab, w } = seed();
    await chrome.windows.onFocusChanged._emit(w.id)[0];
    await flush();
    expect(mru()).toEqual([tab.id]);
    await vi.advanceTimersByTimeAsync(350);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalled();
  });
  it('ignores focus leaving Chrome and our own pages', async () => {
    const w = chrome._addWindow();
    chrome._addTab({ windowId: w.id, url: env.bg.SWITCHER_URL, active: true });
    await chrome.windows.onFocusChanged._emit(chrome.windows.WINDOW_ID_NONE)[0];
    await chrome.windows.onFocusChanged._emit(w.id)[0];
    await flush();
    expect(mru()).toBeUndefined();
  });
});

describe('snoozed tabs', () => {
  const snooze = (p) => ({ id: 'a', url: 'https://later.com/', at: Date.now() - 1, ...p });

  it('the snooze alarm reopens due tabs in their window, in the background', async () => {
    const { w } = seed();
    L().set(KEY.SNOOZED, [snooze({ windowId: w.id, pinned: true }), snooze({ id: 'b', url: 'https://notyet.com/', at: Date.now() + 60000 })]);
    await chrome.alarms.onAlarm._emit({ name: SNOOZE_ALARM })[0];
    await flush();
    expect(chrome.tabs.create.mock.calls).toEqual([[{ url: 'https://later.com/', windowId: w.id, active: false, pinned: true }]]);
    expect(L().get(KEY.SNOOZED).map((x) => x.id)).toEqual(['b']);
  });

  it('other alarms do nothing', async () => {
    seed();
    L().set(KEY.SNOOZED, [snooze()]);
    chrome.alarms.onAlarm._emit({ name: 'something' });
    await flush();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('a window that is gone: the last focused one', async () => {
    const { w } = seed();
    L().set(KEY.SNOOZED, [snooze({ windowId: 77 })]);
    await bg().wakeSnoozed();
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ windowId: w.id }));
  });

  it('no window at all: a new one', async () => {
    L().set(KEY.SNOOZED, [snooze({ windowId: null })]);
    await bg().wakeSnoozed();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.windows.create).toHaveBeenCalledWith({ url: 'https://later.com/' });
  });

  it('one failure does not stop the rest', async () => {
    const { w } = seed();
    L().set(KEY.SNOOZED, [snooze({ windowId: w.id }), snooze({ id: 'b', url: 'https://two.com/', windowId: w.id })]);
    chrome.tabs.create.mockRejectedValueOnce(new Error('no'));
    await bg().wakeSnoozed();
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
  });

  it('nothing due: nothing opens', async () => {
    await bg().wakeSnoozed();
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('notes each woken tab (in a window or a new one) for the switcher', async () => {
    const { w } = seed();
    L().set(KEY.SNOOZED, [snooze({ windowId: w.id })]);
    await bg().wakeSnoozed();
    const tab = await chrome.tabs.create.mock.results[0].value;
    L().set(KEY.SNOOZED, [snooze({ id: 'b', windowId: null })]);
    chrome.windows.getLastFocused.mockRejectedValueOnce(new Error('none'));
    await bg().wakeSnoozed();
    const win = await chrome.windows.create.mock.results[0].value;
    expect(S().get(KEY.WOKEN)).toEqual({ [tab.id]: Date.now(), [win.tabs[0].id]: Date.now() });
  });

  it('a woken tab is forgotten once looked at, or closed', async () => {
    const { w, tab } = seed();
    const other = chrome._addTab({ windowId: w.id, url: 'https://b.com/' });
    S().set(KEY.WOKEN, { [tab.id]: Date.now(), [other.id]: Date.now() });
    await chrome.tabs.onActivated._emit({ tabId: tab.id, windowId: w.id })[0];
    await flush();
    expect(S().get(KEY.WOKEN)).toEqual({ [other.id]: Date.now() });
    chrome.tabs.onRemoved._emit(other.id, { windowId: w.id, isWindowClosing: false });
    await flush();
    expect(S().get(KEY.WOKEN)).toEqual({});
  });
});
