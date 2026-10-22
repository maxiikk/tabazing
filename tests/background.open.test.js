// background.js: opening the switcher (shortcuts, toolbar icon, overlay vs popup window, watchdog).
import { describe, it, expect, vi } from 'vitest';
import { MESSAGE, KEY, LIMITS, FRAME_MESSAGE, PREVIEW_PREFIX } from '../utils/constants.js';
import { environment, flush, freshWorker, seed, launch, fromSwitcherPage, send } from './helpers/background.js';

freshWorker();
const background = () => environment.background;
const launchInjections = () => chrome.scripting.executeScript.mock.calls.filter(([options]) => options.func === background().overlayHost && options.args[3] === 'launch');
const shotTakenCalls = () => chrome.scripting.executeScript.mock.calls.filter(([options]) => options.func === background().overlayHost && options.args[3] === 'shot-taken');
const cycleCalls = () => chrome.runtime.sendMessage.mock.calls.map(([message]) => message).filter((message) => message.type === MESSAGE.CYCLE);

describe('constants', () => {
  it('points at the switcher page and the real extension origin', () => {
    expect(background().SWITCHER_URL).toBe(`chrome-extension://${chrome.runtime.id}/markup/switcher.html`);
    expect(background().EXTENSION_REAL_ORIGIN).toBe(`chrome-extension://${chrome.runtime.id}`);
  });
  it('INJECTABLE: web and file pages only', () => {
    for (const url of ['http://a.com/', 'https://a.com/', 'file:///C:/x.html']) expect(background().INJECTABLE.test(url)).toBe(true);
    for (const url of ['chrome://newtab/', 'chrome-extension://x/y', 'about:blank', 'edge://settings', '']) expect(background().INJECTABLE.test(url)).toBe(false);
  });
});

describe('commands and the toolbar icon', () => {
  it.each([
    ['open-switcher', -1, true],
    ['open-switcher-reverse', 1, true],
    ['open-switcher-stay', 0, false],
  ])('%s moves %i, hold %s', async (command, direction, hold) => {
    const { tab, w: chromeWindow } = seed();
    chrome.commands.onCommand._emit(command, tab);
    await flush();
    expect(cycleCalls()).toEqual([{ type: MESSAGE.CYCLE, direction, hold }]);
    expect(launch().context).toEqual({ sourceTab: tab.id, window: chromeWindow.id, direction, via: 'key', hold, state: 'normal', mode: 'overlay' });
  });

  it('open-palette (Alt+R) opens on the current tab, to stay, straight into the command palette', async () => {
    const { tab, w: chromeWindow } = seed();
    chrome.commands.onCommand._emit('open-palette', tab);
    await flush();
    expect(cycleCalls()).toEqual([{ type: MESSAGE.CYCLE, direction: 0, hold: false, palette: true }]);
    expect(launch().context).toEqual({ sourceTab: tab.id, window: chromeWindow.id, direction: 0, via: 'key', hold: false, state: 'normal', mode: 'overlay', palette: true });
  });

  it('a switcher already open is asked to show its palette', async () => {
    const { tab } = seed();
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true });
    chrome.commands.onCommand._emit('open-palette', tab);
    await flush();
    expect(cycleCalls()).toEqual([{ type: MESSAGE.CYCLE, direction: 0, hold: false, palette: true }]);
    expect(launch()).toBeUndefined();
  });

  it('the palette opens in the popup window too, where the page can’t host it', async () => {
    const { tab } = seed('chrome://settings/');
    chrome.commands.onCommand._emit('open-palette', tab);
    await flush();
    expect(launch().context).toMatchObject({ mode: 'window', palette: true });
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'popup' }));
  });

  it('the manifest declares the command with Alt+R (Option+R on a Mac), four commands in all', () => {
    const { commands } = chrome.runtime.getManifest();
    expect(Object.keys(commands)).toHaveLength(4);
    expect(commands['open-palette']).toEqual({ description: '__MSG_commandPalette__', suggested_key: { default: 'Alt+R', mac: 'Alt+R' } });
  });

  it('ignores unknown commands', async () => {
    chrome.commands.onCommand._emit('something-else', seed().tab);
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('the icon opens to stay, forward, via "icon"', async () => {
    const { tab } = seed();
    chrome.action.onClicked._emit(tab);
    await flush();
    expect(cycleCalls()).toEqual([{ type: MESSAGE.CYCLE, direction: 1, hold: false }]);
    expect(launch().context).toMatchObject({ via: 'icon', direction: 1, hold: false });
  });
});

describe('trigger', () => {
  it('drops a second press within 120 ms (shortcut + in-page listener see the same press)', async () => {
    const { tab } = seed();
    background().trigger(1, tab);
    background().trigger(1, tab);
    vi.advanceTimersByTime(119);
    background().trigger(1, tab);
    await flush();
    expect(cycleCalls()).toHaveLength(1);
    expect(background().lastTrigger).toBe(Date.now() - 119);
  });

  it('accepts a press after 120 ms', async () => {
    const { tab } = seed();
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true }); // a switcher is open: only moves
    background().trigger(1, tab);
    vi.advanceTimersByTime(120);
    background().trigger(-1, tab);
    await flush();
    expect(cycleCalls().map((message) => message.direction)).toEqual([1, -1]);
  });

  it('a clock set back does not block the shortcut until it catches up', async () => {
    const { tab } = seed();
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true }); // a switcher is open: only moves
    background().trigger(1, tab);
    vi.setSystemTime(Date.now() - 3600 * 1000);
    background().trigger(-1, tab);
    await flush();
    expect(cycleCalls().map((message) => message.direction)).toEqual([1, -1]);
  });

  it('logs instead of throwing when opening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seed();
    chrome.tabs.query.mockRejectedValueOnce(new Error('boom'));
    background().trigger(1, null);
    await flush();
    expect(warn).toHaveBeenCalledWith('[Tabazing] could not open the switcher:', 'boom');
  });
});

describe('openSwitcher', () => {
  it('only moves the selection of a switcher that is already open', async () => {
    const { tab } = seed();
    chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: true });
    await background().openSwitcher(-1, tab, 'key', true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.CYCLE, direction: -1, hold: true });
    expect(launch()).toBeUndefined();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(background().opening).toBeNull();
  });

  it('carries on when no switcher answers (sendMessage rejects)', async () => {
    const { tab } = seed();
    chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist.'));
    await background().openSwitcher(1, tab);
    expect(launch()).toBeDefined();
  });

  it('injects the overlay into a web page, with a launch token for it', async () => {
    const { tab, w: chromeWindow } = seed('https://example.com/a');
    await background().openSwitcher(-1, tab, 'key', true);
    const launchDetails = launch();
    expect(launchDetails.context).toEqual({ sourceTab: tab.id, window: chromeWindow.id, direction: -1, via: 'key', hold: true, state: 'normal', mode: 'overlay' });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: tab.id }, func: background().overlayHost,
      args: [background().SWITCHER_URL, background().EXTENSION_REAL_ORIGIN, FRAME_MESSAGE, 'launch', launchDetails.token, true, LIMITS.STANDBY_DROP_MILLISECONDS, 'Tabazing tab switcher', true], // (its screenshot is being taken)
      injectImmediately: true,
    });
    expect(chrome.storage.session._data.get(KEY.OVERLAY)).toMatchObject({ tabId: tab.id });
    expect(chrome.storage.session._data.get(KEY.LAST_OPEN)).toBe(Date.now());
    expect(background().overlayOpen).toMatchObject({ tabId: tab.id, context: expect.objectContaining({ direction: -1 }) });
    expect(background().watchdog).toMatchObject({ token: launchDetails.token });
    expect(background().opening).toMatchObject({ extra: 0 });
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('opens a popup window over pages extensions cannot touch', async () => {
    const { tab, w: chromeWindow } = seed('chrome://settings/');
    await background().openSwitcher(1, tab, 'icon');
    const launchDetails = launch();
    expect(launchDetails.context).toEqual({ sourceTab: tab.id, window: chromeWindow.id, direction: 1, via: 'icon', hold: false, state: 'normal', mode: 'window' });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.windows.create).toHaveBeenCalledWith({
      url: background().SWITCHER_URL + '?t=' + launchDetails.token, type: 'popup', focused: true, width: 1200, height: 800, left: 0, top: 0,
    });
  });

  it('Settings "own window": the popup window even over a web page', async () => {
    const { tab } = seed('https://example.com/a');
    await chrome.storage.local.set({ [KEY.PREFERENCES]: { ownWindow: true } });
    await background().openSwitcher(1, tab);
    expect(launch().context.mode).toBe('window');
    expect(launchInjections()).toEqual([]);
    expect(chrome.storage.session._data.has(KEY.OVERLAY)).toBe(false);
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'popup', url: background().SWITCHER_URL + '?t=' + launch().token }));
  });

  it('falls back to the popup window when the overlay cannot be injected', async () => {
    const { tab } = seed();
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    await background().openSwitcher(1, tab);
    expect(launch().context.mode).toBe('window');
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'popup', url: expect.stringContaining('?t=' + launch().token) }));
    expect(background().watchdog).toBeNull();
    expect(chrome.storage.session._data.has(KEY.OVERLAY)).toBe(false);
  });

  it('uses the active tab of the last focused window when given none, or an inactive one', async () => {
    const { tab } = seed();
    const other = chrome._addTab({ windowId: tab.windowId, url: 'https://other.com/' }); // not active
    await background().openSwitcher(1, other);
    expect(launch().context.sourceTab).toBe(tab.id);
  });

  it('does nothing for incognito tabs, or with no tab at all', async () => {
    await background().openSwitcher(1, null);
    expect(launch()).toBeUndefined();
    expect(background().opening).toBeNull();
    const chromeWindow = chrome._addWindow({ incognito: true });
    const tab = chrome._addTab({ windowId: chromeWindow.id, active: true, incognito: true });
    await background().openSwitcher(1, tab);
    expect(launch()).toBeUndefined();
    expect(background().opening).toBeNull();
  });

  it('keeps the window state, unless it is one the switcher cannot restore', async () => {
    const { tab, w: chromeWindow } = seed('https://example.com/', { state: 'maximized' });
    await background().openSwitcher(1, tab);
    expect(launch().context.state).toBe('maximized');
    chromeWindow.state = 'minimized';
    vi.advanceTimersByTime(LIMITS.OPENING_LOCK_MILLISECONDS);
    await background().openSwitcher(1, tab);
    expect(launch().context.state).toBe('normal');
  });

  it('screenshots the page first unless its preview is fresh', async () => {
    const { tab } = seed('https://example.com/');
    await background().openSwitcher(1, tab);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);

    chrome.tabs.captureVisibleTab.mockClear();
    vi.advanceTimersByTime(LIMITS.OPENING_LOCK_MILLISECONDS);
    const { savePreview } = await import('../utils/store.js'); // the worker's own copy (one module per worker)
    await savePreview('https://example.com/', { img: PREVIEW_PREFIX + 'AAAA', t: Date.now() });
    chrome.storage.local.get.mockClear();
    await background().openSwitcher(1, tab);
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(chrome.storage.local.get.mock.calls.flat()).not.toContain('pv:https://example.com/'); // the image is not read

    vi.advanceTimersByTime(LIMITS.OPENING_LOCK_MILLISECONDS + 1); // that preview is no longer fresh
    await background().openSwitcher(1, tab);
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it('injects the overlay at once, while the screenshot is taken; the page may show it once told the screenshot is taken', async () => {
    const { tab } = seed();
    let shoot;
    chrome.tabs.captureVisibleTab.mockReturnValueOnce(new Promise((resolve) => { shoot = resolve; }));
    await background().openSwitcher(1, tab);
    expect(launch().context).toMatchObject({ sourceTab: tab.id, mode: 'overlay' });
    expect(launchInjections()).toHaveLength(1); // not waiting for the screenshot...
    expect(launchInjections()[0][0].args[4]).toBe(launch().token);
    expect(launchInjections()[0][0].args[8]).toBe(true); // ...but the page keeps it hidden until told
    expect(shotTakenCalls()).toHaveLength(0);
    shoot('data:image/jpeg;base64,AAAA');
    await flush();
    expect(shotTakenCalls()).toHaveLength(1);
    expect(shotTakenCalls()[0][0]).toMatchObject({ target: { tabId: tab.id } });
    expect(shotTakenCalls()[0][0].args[4]).toBe(launch().token);
  });

  it('a screenshot that takes over 400 ms is not waited for (nor kept): the page is told after 400 ms', async () => {
    const { tab } = seed();
    chrome.tabs.captureVisibleTab.mockReturnValueOnce(new Promise(() => {})); // never settles
    await background().openSwitcher(1, tab);
    expect(launchInjections()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(399);
    expect(shotTakenCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(shotTakenCalls()).toHaveLength(1);
  });

  it('a fresh screenshot is not taken again: the overlay may show as soon as it has drawn', async () => {
    const { tab } = seed('https://example.com/');
    const { savePreview } = await import('../utils/store.js');
    await savePreview('https://example.com/', { img: PREVIEW_PREFIX + 'AAAA', t: Date.now() });
    await background().openSwitcher(1, tab);
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(launchInjections()[0][0].args[8]).toBe(false);
  });

  it('a page too busy to run the overlay\'s code (frozen) gets the popup window instead, after PAGE_FROZEN_MILLISECONDS', async () => {
    expect(LIMITS.PAGE_FROZEN_MILLISECONDS).toBeLessThan(background().WATCH_FIRST_MILLISECONDS); // (first: it calls off the watchdog)
    const { tab } = seed();
    chrome.scripting.executeScript.mockImplementationOnce(() => new Promise(() => {})); // the page never runs it
    const promise = background().openSwitcher(1, tab);
    await flush();
    expect(chrome.windows.create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIMITS.PAGE_FROZEN_MILLISECONDS);
    await promise;
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(launch().context.mode).toBe('window'); // the overlay's launch is gone: if the page runs it late, it stays hidden
    expect(chrome.storage.session._data.get(KEY.OVERLAY)).toBeUndefined();
    expect(background().watchdog).toBeNull();
  });

  it('queues presses made while a switcher is still loading, and READY hands them over', async () => {
    const { tab } = seed('chrome://newtab/');
    await background().openSwitcher(1, tab);
    await background().openSwitcher(1, tab);
    await background().openSwitcher(-1, tab);
    await background().openSwitcher(1, tab);
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(background().opening.extra).toBe(1);
    const { respond } = send({ type: MESSAGE.READY }, fromSwitcherPage());
    expect(respond).toHaveBeenCalledWith({ extra: 1 });
    expect(background().opening).toBeNull();
  });

  it('an Alt+R (palette) or Alt+E (stay open) pressed while it loads is handed over by READY too', async () => {
    const { tab } = seed('chrome://newtab/');
    await background().openSwitcher(-1, tab, 'key', true);
    await background().openSwitcher(-1, tab, 'key', true);
    await background().openSwitcher(0, tab);                     // Alt+E
    await background().openSwitcher(0, tab, 'key', false, true); // Alt+R
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
    expect(send({ type: MESSAGE.READY }, fromSwitcherPage()).respond).toHaveBeenCalledWith({ extra: -1, palette: true, stay: true });
    await background().openSwitcher(1, tab);
    await background().openSwitcher(0, tab, 'key', false, true); // just the palette this time
    expect(send({ type: MESSAGE.READY }, fromSwitcherPage()).respond).toHaveBeenCalledWith({ extra: 0, palette: true });
  });

  it('the opening lock does not outlast a clock set back', async () => {
    const { tab } = seed('chrome://newtab/');
    await background().openSwitcher(1, tab);
    vi.setSystemTime(Date.now() - 3600 * 1000);
    await background().openSwitcher(1, tab);
    expect(chrome.windows.create).toHaveBeenCalledTimes(2);
  });

  it('opens again once the opening lock has run out', async () => {
    const { tab } = seed('chrome://newtab/');
    await background().openSwitcher(1, tab);
    vi.advanceTimersByTime(LIMITS.OPENING_LOCK_MILLISECONDS);
    await background().openSwitcher(1, tab);
    expect(chrome.windows.create).toHaveBeenCalledTimes(2);
  });
});

describe('injectInto', () => {
  it('launches the overlay right away with the token', async () => {
    await background().injectInto(7, 'tok', false);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 }, func: background().overlayHost,
      args: [background().SWITCHER_URL, background().EXTENSION_REAL_ORIGIN, FRAME_MESSAGE, 'launch', 'tok', false, LIMITS.STANDBY_DROP_MILLISECONDS, 'Tabazing tab switcher', false],
      injectImmediately: true,
    });
  });
});

describe('prepareSwitcher / prepareActiveTabs', () => {
  const standbyCalls = () => chrome.scripting.executeScript.mock.calls.filter(([options]) => options.func === background().overlayHost && options.args[3] === 'standby');

  it('puts a standby frame into the shown web page, once per burst', () => {
    const { tab } = seed();
    background().prepareSwitcher(tab, 250);
    background().prepareSwitcher(tab, 250);
    expect(background().standbyTimers.has(tab.id)).toBe(true);
    vi.advanceTimersByTime(250);
    expect(standbyCalls()).toHaveLength(1);
    expect(standbyCalls()[0][0]).toEqual({
      target: { tabId: tab.id }, func: background().overlayHost,
      args: [background().SWITCHER_URL, background().EXTENSION_REAL_ORIGIN, FRAME_MESSAGE, 'standby', null, false, LIMITS.STANDBY_DROP_MILLISECONDS, 'Tabazing tab switcher'],
      injectImmediately: true,
    });
    expect(background().standbyTimers.has(tab.id)).toBe(false);
  });

  it('skips hidden, incognito and non-web tabs', () => {
    const base = { id: 1, active: true, url: 'https://a.com/', incognito: false };
    for (const tab of [null, { ...base, active: false }, { ...base, incognito: true }, { ...base, url: 'chrome://newtab/' }, { ...base, url: undefined }]) background().prepareSwitcher(tab);
    vi.advanceTimersByTime(10);
    expect(standbyCalls()).toHaveLength(0);
  });

  it('a failed injection is swallowed', async () => {
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('no'));
    background().prepareSwitcher(seed().tab);
    vi.advanceTimersByTime(0);
    await flush();
    expect(standbyCalls()).toHaveLength(1);
  });

  it('prepareActiveTabs covers the active web tab of every normal window', async () => {
    seed('https://a.com/');
    seed('chrome://newtab/');
    const thirdChromeWindow = chrome._addWindow();
    chrome._addTab({ windowId: thirdChromeWindow.id, url: 'https://b.com/' }); // not active
    chrome._addTab({ windowId: thirdChromeWindow.id, url: 'https://c.com/', active: true });
    await background().prepareActiveTabs();
    vi.advanceTimersByTime(0);
    expect(standbyCalls().map(([options]) => options.target.tabId)).toEqual([1, 4]);
  });
});

describe('watchdog', () => {
  async function openOverlay(hold = false) {
    const seeded = seed();
    await background().openSwitcher(1, seeded.tab, 'key', hold);
    await flush(); // (the page is told the screenshot is taken)
    chrome.scripting.executeScript.mockClear();
    return seeded;
  }

  it('no READY and no sign of the overlay: removes it and opens the popup window', async () => {
    const { tab } = await openOverlay();
    await vi.advanceTimersByTimeAsync(background().WATCH_FIRST_MILLISECONDS);
    await flush();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: tab.id }, func: background().removeOverlay, injectImmediately: true });
    expect(launch().context.mode).toBe('window');
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'popup', url: background().SWITCHER_URL + '?t=' + launch().token }));
    expect(background().watchdog).toBeNull();
    expect(background().opening).toBeNull();
    expect(chrome.storage.session._data.has(KEY.OVERLAY)).toBe(false);
  });

  it('READY in time disarms it', async () => {
    await openOverlay();
    send({ type: MESSAGE.READY }, fromSwitcherPage());
    expect(background().watchdog).toBeNull();
    await vi.advanceTimersByTimeAsync(LIMITS.OVERLAY_WATCHDOG_MILLISECONDS * 3);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('an overlay that is there but slow gets one more moment', async () => {
    await openOverlay();
    chrome.scripting.executeScript.mockResolvedValueOnce([{ result: true }]);
    await vi.advanceTimersByTimeAsync(background().WATCH_FIRST_MILLISECONDS);
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(background().watchdog).not.toBeNull();
    await vi.advanceTimersByTimeAsync(LIMITS.OVERLAY_WATCHDOG_MILLISECONDS);
    await flush();
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('a page that replaced its document gets the overlay again, with a fresh token', async () => {
    const { tab } = await openOverlay(true);
    const first = launch().token;
    chrome.scripting.executeScript.mockResolvedValueOnce([{ result: false }]);
    await vi.advanceTimersByTimeAsync(background().WATCH_FIRST_MILLISECONDS);
    await flush();
    const fresh = launch();
    expect(fresh.token).not.toBe(first);
    expect(fresh.context).toMatchObject({ mode: 'overlay', hold: true });
    expect(chrome.scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { tabId: tab.id }, func: background().overlayHost, args: expect.arrayContaining(['launch', fresh.token, true]),
    }));
    expect(background().watchdog.token).toBe(fresh.token);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('gives up after two retries', async () => {
    await openOverlay();
    chrome.scripting.executeScript.mockResolvedValue([{ result: false }]);
    await vi.advanceTimersByTimeAsync(background().WATCH_FIRST_MILLISECONDS);
    await vi.advanceTimersByTimeAsync(LIMITS.OVERLAY_WATCHDOG_MILLISECONDS);
    expect(chrome.windows.create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LIMITS.OVERLAY_WATCHDOG_MILLISECONDS);
    await flush();
    expect(chrome.windows.create).toHaveBeenCalledTimes(1);
  });

  it('a newer arm replaces the old one; disarm stops it', async () => {
    const windowBounds = { width: 1000, height: 700 };
    background().armWatchdog('a', 1, windowBounds, { sourceTab: 1, window: 1, direction: 1 });
    background().armWatchdog('b', 1, windowBounds, { sourceTab: 1, window: 1, direction: 1 });
    expect(background().watchdog.token).toBe('b');
    background().disarmWatchdog();
    expect(background().watchdog).toBeNull();
    await vi.advanceTimersByTimeAsync(10000);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });
});

describe('openPopupWindow', () => {
  it('covers the window it came from', async () => {
    await background().openPopupWindow({ left: 100, top: 50, width: 1600, height: 1000, state: 'normal' }, 'tok');
    expect(chrome.windows.create).toHaveBeenCalledWith({
      url: background().SWITCHER_URL + '?t=tok', type: 'popup', focused: true, width: 1600, height: 1000, left: 100, top: 50,
    });
  });

  it('a small source window gives at least 1000x680, centred on it (not a window barely wider than the palette)', async () => {
    await background().openPopupWindow({ left: 400, top: 300.4, width: 600, height: 400 }, 'tok');
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ width: 1000, height: 680, left: 200, top: 160 }));
  });

  it('grown near the top of the screen, it never starts above it', async () => {
    await background().openPopupWindow({ left: 0, top: 10, width: 700, height: 300 }, 'tok');
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ width: 1000, height: 680, left: -150, top: 0 }));
  });

  it('a window wide enough but short only grows in height', async () => {
    await background().openPopupWindow({ left: 100, top: 400, width: 1400, height: 500 }, 'tok');
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ width: 1400, height: 680, left: 100, top: 310 }));
  });

  it('assumes 1280x800 at the corner when the window is unknown', async () => {
    await background().openPopupWindow({}, 'tok');
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ width: 1280, height: 800, left: 0, top: 0 }));
  });

  it.each(['maximized', 'fullscreen'])('over a %s window: maximized, without bounds', async (state) => {
    await background().openPopupWindow({ left: 0, top: 0, width: 1920, height: 1080, state }, 'tok');
    expect(chrome.windows.create).toHaveBeenCalledWith({ url: background().SWITCHER_URL + '?t=tok', type: 'popup', focused: true, state: 'maximized' });
  });

  it('lets Chrome place it when the bounds are rejected', async () => {
    chrome.windows.create.mockRejectedValueOnce(new Error('Invalid value for bounds'));
    await background().openPopupWindow({ width: 900, height: 600 }, 'tok');
    expect(chrome.windows.create).toHaveBeenLastCalledWith({ url: background().SWITCHER_URL + '?t=tok', type: 'popup', focused: true });
  });
});

describe('captureOne / reopenOver', () => {
  it('reopenOver(null) does nothing', async () => {
    await background().reopenOver(null);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('reopenOver opens the switcher over that tab, even while another opening is pending', async () => {
    const { tab } = seed('chrome://newtab/');
    await background().openSwitcher(-1, tab);
    await background().reopenOver(tab.id);
    expect(chrome.windows.create).toHaveBeenCalledTimes(2);
    expect(launch().context).toMatchObject({ sourceTab: tab.id, direction: 1 });
  });

  it('reopenOver ignores a tab that is gone', async () => {
    await expect(background().reopenOver(999)).resolves.toBeUndefined();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('captureOne visits the one tab, captures it and reports it', async () => {
    const { tab } = seed();
    const other = chrome._addTab({ windowId: tab.windowId, url: 'https://other.com/' });
    const promise = background().captureOne(other.id, null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await promise).toEqual({ ok: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(other.id, { active: true });
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalled();
  });

  it('captureOne says ok:false when there was nothing to capture', async () => {
    seed();
    const promise = background().captureOne(999, null);
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toEqual({ ok: false });
  });
});
