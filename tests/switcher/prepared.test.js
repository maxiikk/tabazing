// The prepared frame: loaded ahead in the page (invisible), it reads and draws the tabs with its standby token
// before any key is pressed, stays inert until a launch checks out, and then only shows what it drew (and redraws
// if anything changed meanwhile).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadPage, waitFor, tick, key, stopSwitcher } from '../helpers/switcher.js';
import { byTestId, titles, selectedTitle } from '../helpers/switcher-ui.js';
import { createStandby } from '../../utils/store.js';
import { MESSAGE } from '../../utils/constants.js';

let switcher = null;
afterEach(() => {
  if (switcher) { switcher.state.done = true; switcher.state.holding = false; }
  switcher = null;
  stopSwitcher();
  delete window.parent;
  vi.unstubAllGlobals();
});

// Loads the frame as the overlay host does: it says "standby", the host answers with PREPARE and the standby token
// (`token`: another one, or none). Resolves once it has drawn (or after a while, if it doesn't).
async function loadPrepared({ tabs = ['Alpha', 'Bravo', 'Charlie'], token, preferences } = {}) {
  loadPage();
  chrome._addWindow({ id: 1, focused: true });
  const made = tabs.map((title, i) => chrome._addTab({ windowId: 1, active: i === 0, title, url: `https://${title.toLowerCase()}.example/` }));
  await chrome.storage.local.set({ onb: { tour: true, flyout: true, at: Date.now() }, ...(preferences ? { prefs: preferences } : {}) });
  const standby = token === undefined ? await createStandby(made[0].id, 1) : token;
  const parent = { postMessage: vi.fn() };
  const fromParent = (data) => window.dispatchEvent(new MessageEvent('message', { data, source: parent }));
  parent.postMessage.mockImplementation((message) => {
    if (message && message.tabazing === 'standby' && standby) setTimeout(() => fromParent({ tabazing: 'prepare', token: standby }), 0);
  });
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  history.replaceState(null, '', '/switcher.html?standby=1');
  vi.resetModules();
  chrome._clearListeners();
  switcher = await import('../../switcher.js');
  if (token === undefined) await waitFor(() => !byTestId('app').hidden && titles().length === tabs.length).catch(() => {});
  else await tick(60);
  // The launch: stored by the background, passed on by the host when a shortcut is pressed.
  const launch = async (context = {}) => {
    const launchToken = 'launch-' + Math.random().toString(36).slice(2);
    await chrome.storage.session.set({ launch: { token: launchToken, t: Date.now(), context: { sourceTab: made[0].id, window: 1, direction: 1, via: 'key', hold: false, state: 'normal', mode: 'overlay', ...context } } });
    fromParent({ tabazing: 'launch', token: launchToken });
    await waitFor(() => readyPosted(parent));
  };
  return { parent, made, launch };
}
const readyPosted = (parent) => parent.postMessage.mock.calls.some(([message]) => message && message.tabazing === 'ready');

describe('prepared frame', () => {
  it('reads and draws the tabs before any launch, but does not say READY (so the page never shows it)', async () => {
    const { parent } = await loadPrepared();
    expect(titles()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(readyPosted(parent)).toBe(false);
    expect(switcher.timings().prepare).toBeGreaterThanOrEqual(0);
  });

  it('without a standby token that checks out it reads nothing', async () => {
    await loadPrepared({ token: 'guess' });
    expect(byTestId('app').hidden).toBe(true);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it('is inert before the launch: keys do nothing, and the background\'s "is one open?" goes unanswered', async () => {
    await loadPrepared();
    const before = switcher.state.selected;
    key('ArrowRight');
    key('Enter');
    expect(switcher.state.selected).toBe(before);
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    const respond = vi.fn();
    chrome.runtime.onMessage._emit({ type: MESSAGE.CYCLE, direction: 1, hold: false }, { id: chrome.runtime.id }, respond);
    expect(respond).not.toHaveBeenCalled();
  });

  it('a launch shows what it drew, selecting the tab used before the current one', async () => {
    const { parent, launch } = await loadPrepared();
    await launch();
    expect(readyPosted(parent)).toBe(true);
    expect(switcher.CONTEXT.mode).toBe('overlay');
    expect(selectedTitle()).toBe('Bravo');
  });

  it('tabs used since it was drawn: Alt+W selects the one used just before this one, as of the launch', async () => {
    const { made, launch } = await loadPrepared();
    await chrome.storage.session.set({ mru: [made[0].id, made[1].id, made[2].id] });
    switcher.state.tabs.sort((first, second) => first.index - second.index); // drawn by that order: Alpha, Bravo, Charlie
    await chrome.storage.session.set({ mru: [made[0].id, made[2].id, made[1].id] }); // then Charlie, and back to Alpha
    await launch({ hold: true, direction: 1 });
    expect(selectedTitle()).toBe('Charlie'); // already when it shows
    await waitFor(() => !switcher.state.holding || titles()[1] === 'Charlie');
    expect(titles()).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(selectedTitle()).toBe('Charlie');
  });

  it('the first card is picked again from what is read after the launch (a tab it has not drawn)', async () => {
    const { made, launch } = await loadPrepared();
    const delta = chrome._addTab({ windowId: 1, title: 'Delta', url: 'https://delta.example/' }); // opened, used, and back
    await chrome.storage.session.set({ mru: [made[0].id, delta.id, made[1].id, made[2].id] });
    await launch({ hold: true, direction: 1 });
    await waitFor(() => selectedTitle() === 'Delta');
    expect(titles()).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);
  });

  it('Alt+E (direction 0) selects the current tab', async () => {
    const { launch } = await loadPrepared();
    await launch({ direction: 0 });
    expect(selectedTitle()).toBe('Alpha');
  });

  it('a tab opened between preparing and the launch is drawn right after the launch', async () => {
    const { launch } = await loadPrepared();
    chrome._addTab({ windowId: 1, title: 'Delta', url: 'https://delta.example/' });
    await launch();
    await waitFor(() => titles().includes('Delta'));
    expect(titles()).toContain('Delta');
  });

  it('settings changed meanwhile are applied after the launch', async () => {
    const { launch } = await loadPrepared();
    await chrome.storage.local.set({ prefs: { theme: 'light' } });
    await launch();
    await waitFor(() => !switcher.state.done && document.documentElement.classList.contains('light'));
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('after the launch, keys act and the background\'s "is one open?" is answered', async () => {
    const { launch } = await loadPrepared();
    await launch({ direction: 0 });
    await tick(20);
    key('ArrowRight');
    expect(selectedTitle()).toBe('Bravo');
    const respond = vi.fn();
    chrome.runtime.onMessage._emit({ type: MESSAGE.CYCLE, direction: 0, hold: false }, { id: chrome.runtime.id }, respond);
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });

  it('keys pressed while it reads the tabs again act once that is done', async () => {
    const { launch } = await loadPrepared();
    let release;
    // (the next call, once released, is answered as usual)
    chrome.tabs.query.mockImplementationOnce((...values) => new Promise((resolve) => { release = () => resolve(chrome.tabs.query(...values)); }));
    await launch({ direction: 0 });
    await waitFor(() => release);
    key('ArrowRight');
    expect(selectedTitle()).toBe('Alpha'); // waiting
    release();
    await waitFor(() => selectedTitle() === 'Bravo');
  });
});
