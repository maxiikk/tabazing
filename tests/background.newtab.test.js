// background.js and Tabazing's New Tab page: the switcher is hosted by the page itself (no injection there),
// launched by message; and the page may ask for the switcher (its own Alt+Q), nothing else.
import { describe, it, expect, vi } from 'vitest';
import { MSG, KEY, LIMITS } from '../lib/constants.js';
import { env, flush, freshWorker, seed, launch, fromSwitcherPage, fromPage, send } from './background.shared.js';

freshWorker();
const bg = () => env.bg;
const OWN = `chrome-extension://${chrome.runtime.id}/`;
const NTP = OWN + 'newtab.html';
const sent = (type) => chrome.runtime.sendMessage.mock.calls.map(([m]) => m).filter((m) => m.type === type);
// The New Tab page in that tab answers its launch (newtab.js onMessage).
const pageAnswers = () => chrome.runtime.sendMessage.mockImplementation(async (m) => (m.type === MSG.NTP_LAUNCH ? { ok: true } : undefined));
const fromNewTabPage = (tab, more = {}) => ({ id: chrome.runtime.id, url: NTP, tab, frameId: 0, ...more });

describe('which tabs are the New Tab page', () => {
  it('isNewTab: our newtab.html, or chrome://newtab/ as Chrome may report it', () => {
    for (const url of [NTP, NTP + '?x', 'chrome://newtab/', 'chrome://newtab']) expect(bg().isNewTab({ url }), url).toBe(true);
    expect(bg().isNewTab({ url: '', pendingUrl: NTP })).toBe(true);
    for (const url of [OWN + 'switcher.html', 'chrome://newtab/x', 'https://newtab.com/', 'chrome-extension://other/newtab.html', '']) expect(bg().isNewTab({ url }), url).toBe(false);
    expect(bg().isNewTab(null)).toBe(false);
  });

  it('fromNewTab: the page itself in a tab (top frame); not the switcher, web pages or other extensions', () => {
    const tab = { id: 4 };
    expect(bg().fromNewTab(fromNewTabPage(tab))).toBe(true);
    expect(bg().fromNewTab(fromNewTabPage(tab, { frameId: 3 }))).toBe(false);
    expect(bg().fromNewTab(fromNewTabPage(undefined))).toBe(false);
    expect(bg().fromNewTab(fromNewTabPage({ id: 'x' }))).toBe(false);
    expect(bg().fromNewTab({ ...fromNewTabPage(tab), url: OWN + 'switcher.html' })).toBe(false);
    expect(bg().fromNewTab({ ...fromNewTabPage(tab), url: OWN + 'sweep.html' })).toBe(false);
    expect(bg().fromNewTab({ ...fromNewTabPage(tab), url: 'https://evil.com/newtab.html' })).toBe(false);
    expect(bg().fromNewTab({ ...fromNewTabPage(tab), url: 'chrome-extension://otherotherotherotherotherotherot/newtab.html' })).toBe(false);
  });
});

describe('opening the switcher over the New Tab page', () => {
  it.each([NTP, 'chrome://newtab/'])('%s: sends the page the launch instead of injecting', async (url) => {
    const { tab, w } = seed(url);
    pageAnswers();
    await bg().openSwitcher(-1, tab, 'key', true);
    const l = launch();
    expect(l.ctx).toEqual({ src: tab.id, win: w.id, dir: -1, via: 'key', hold: true, state: 'normal', mode: 'overlay' });
    expect(sent(MSG.NTP_LAUNCH)).toEqual([{ type: MSG.NTP_LAUNCH, tabId: tab.id, token: l.token, hold: true }]);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(bg().overlayOpen).toMatchObject({ tabId: tab.id, ntp: true });
    expect(chrome.storage.session._data.get(KEY.OVERLAY)).toMatchObject({ tabId: tab.id });
  });

  it('no page answers (Chrome\'s own New Tab, or ours still loading): the popup window', async () => {
    const { tab } = seed('chrome://newtab/');
    await bg().openSwitcher(1, tab);
    expect(sent(MSG.NTP_LAUNCH)).toHaveLength(1);
    expect(launch().ctx.mode).toBe('window');
    expect(chrome.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'popup', url: bg().SWITCHER_URL + '?t=' + launch().token }));
    expect(bg().watchdog).toBeNull();
    expect(chrome.storage.session._data.has(KEY.OVERLAY)).toBe(false);
  });

  it('Settings "own window": the popup window, the page is not asked', async () => {
    const { tab } = seed(NTP);
    pageAnswers();
    await chrome.storage.local.set({ [KEY.PREFS]: { ownWindow: true } });
    await bg().openSwitcher(1, tab);
    expect(sent(MSG.NTP_LAUNCH)).toEqual([]);
    expect(launch().ctx.mode).toBe('window');
    expect(chrome.windows.create).toHaveBeenCalled();
  });

  it('no standby is injected into the New Tab page (it prepares its own)', () => {
    const { tab } = seed(NTP);
    bg().prepareSwitcher(tab);
    vi.advanceTimersByTime(1000);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('watchdog: no READY in time takes the overlay away by message, then the popup window', async () => {
    const { tab } = seed(NTP);
    pageAnswers();
    await bg().openSwitcher(1, tab);
    await vi.advanceTimersByTimeAsync(bg().WATCH_FIRST_MS);
    expect(chrome.windows.create).not.toHaveBeenCalled(); // the page gets the longer wait at once
    await vi.advanceTimersByTimeAsync(LIMITS.OVERLAY_WATCHDOG_MS - bg().WATCH_FIRST_MS);
    await flush();
    expect(sent(MSG.NTP_DROP)).toEqual([{ type: MSG.NTP_DROP, tabId: tab.id }]);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(launch().ctx.mode).toBe('window');
    expect(chrome.windows.create).toHaveBeenCalled();
  });

  it('READY in time disarms the watchdog', async () => {
    const { tab } = seed(NTP);
    pageAnswers();
    await bg().openSwitcher(1, tab);
    send({ type: MSG.READY }, fromSwitcherPage(tab));
    await vi.advanceTimersByTimeAsync(LIMITS.OVERLAY_WATCHDOG_MS * 2);
    expect(sent(MSG.NTP_DROP)).toEqual([]);
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  it('FALLBACK from the switcher on the New Tab page: dropped by message, the popup window instead', async () => {
    const { tab } = seed(NTP);
    pageAnswers();
    await bg().openSwitcher(-1, tab, 'key', true);
    send({ type: MSG.FALLBACK }, fromSwitcherPage(tab));
    await flush();
    expect(sent(MSG.NTP_DROP)).toEqual([{ type: MSG.NTP_DROP, tabId: tab.id }]);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(launch().ctx).toMatchObject({ mode: 'window', hold: false });
  });
});

describe('HOTKEY from the New Tab page', () => {
  it('opens the switcher over it', async () => {
    const { tab } = seed(NTP);
    pageAnswers();
    send({ type: MSG.HOTKEY, dir: -1, hold: true }, fromNewTabPage(tab));
    await flush();
    expect(sent(MSG.CYCLE)).toEqual([{ type: MSG.CYCLE, dir: -1, hold: true }]);
    expect(sent(MSG.NTP_LAUNCH)).toHaveLength(1);
  });

  it('is refused from other extension pages, a subframe, or without a tab', async () => {
    const { tab } = seed(NTP);
    send({ type: MSG.HOTKEY, dir: 1 }, fromSwitcherPage(tab));
    send({ type: MSG.HOTKEY, dir: 1 }, { ...fromNewTabPage(tab), url: OWN + 'sweep.html' });
    send({ type: MSG.HOTKEY, dir: 1 }, fromNewTabPage(tab, { frameId: 2 }));
    send({ type: MSG.HOTKEY, dir: 1 }, fromNewTabPage(undefined));
    send({ type: MSG.HOTKEY, dir: 1 }, { ...fromNewTabPage(tab), id: 'otherotherotherotherotherotherot' });
    await flush();
    expect(sent(MSG.CYCLE)).toEqual([]);
  });

  it('content scripts on web pages still may', async () => {
    const { tab } = seed('https://example.com/');
    send({ type: MSG.HOTKEY, dir: 1 }, fromPage(tab));
    await flush();
    expect(sent(MSG.CYCLE)).toHaveLength(1);
  });

  it('the New Tab page may ask for nothing else', async () => {
    const { tab } = seed(NTP);
    send({ type: MSG.FLYOUT_DONE }, fromNewTabPage(tab));
    send({ type: MSG.NUDGE, act: 'try' }, fromNewTabPage(tab));
    send({ type: MSG.MEDIA, state: '{}' }, fromNewTabPage(tab));
    send({ type: MSG.SWEEP }, fromNewTabPage(tab));
    await flush();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(chrome.storage.local._data.has(KEY.ONBOARD)).toBe(false);
  });
});

describe('the New Tab page is a tab the user works in', () => {
  it('goes into the order of use, unlike the switcher\'s own window', async () => {
    const { tab } = seed(NTP);
    chrome.tabs.onActivated._emit({ tabId: tab.id, windowId: tab.windowId });
    await flush();
    expect(chrome.storage.session._data.get(KEY.MRU)).toEqual([tab.id]);
    expect(bg().ownPage(NTP)).toBe(false);
    expect(bg().ownPage(OWN + 'switcher.html')).toBe(true);
  });
});
