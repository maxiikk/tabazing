// Boot: the launch token, the opening selection, resume notes, and the overlay's clickjacking guard.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadPage, tick, waitFor, key } from '../helpers/switcher.js';
import { boot, bootOverlay, restoreParent, ABC, selectedTitle, openCards, cards, byTestId } from '../helpers/switcher-ui.js';
import { MESSAGE } from '../../utils/constants.js';

// Load the page with a launch that is wrong somehow, and let the module run.
async function bootBad({ urlToken = 'tok', stored = { token: 'tok', t: Date.now(), context: { sourceTab: 1, window: 1, direction: 1, mode: 'window' } } } = {}) {
  loadPage();
  chrome._addWindow({ id: 1, focused: true });
  chrome._addTab({ windowId: 1, active: true, title: 'A', url: 'https://a.example/' });
  if (stored) await chrome.storage.session.set({ launch: stored });
  history.replaceState(null, '', '/switcher.html' + (urlToken ? '?t=' + urlToken : ''));
  const add = vi.spyOn(window, 'addEventListener');
  vi.resetModules();
  chrome._clearListeners();
  const module = await import('../../switcher.js');
  await tick(30);
  return { module, keyListeners: add.mock.calls.filter(([type]) => type === 'keydown').length };
}

describe('getLaunch: a launch that does not check out', () => {
  const nothingRuns = ({ module, keyListeners }) => {
    expect(module.CONTEXT).toBe(null);
    expect(byTestId('app').hidden).toBe(true);
    expect(cards(document).length).toBe(0);
    expect(keyListeners).toBe(0);
    expect(chrome.runtime.onMessage.hasListeners()).toBe(false);
    expect(chrome.tabs.onRemoved.hasListeners()).toBe(false);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  };
  it('no token in the address', async () => nothingRuns(await bootBad({ urlToken: '' })));
  it('a wrong token', async () => nothingRuns(await bootBad({ urlToken: 'guess' })));
  it('no launch stored', async () => nothingRuns(await bootBad({ stored: null })));
  it('an expired token', async () => nothingRuns(await bootBad({ stored: { token: 'tok', t: Date.now() - 60000, context: { sourceTab: 1, window: 1, mode: 'window' } } })));
  it('an overlay token used in a popup window', async () => nothingRuns(await bootBad({ stored: { token: 'tok', t: Date.now(), context: { sourceTab: 1, window: 1, mode: 'overlay' } } })));
  it('the token is one-time: it is used up', async () => {
    const switcher = await boot();
    expect(switcher.CONTEXT.mode).toBe('window');
    expect(chrome.storage.session._data.has('launch')).toBe(false);
  });
});

describe('opening selection', () => {
  it('toolbar icon / other: the tab used before the current one', async () => {
    await chrome.storage.session.set({ mru: [1, 3, 2] }); // ids: Alpha 1 (current), Bravo 2, Charlie 3
    const switcher = await boot({ tabs: ABC(), context: { via: 'icon', direction: 1 } });
    expect(switcher.state.tabs.map((x) => x.title)).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(selectedTitle()).toBe('Charlie');
  });
  it('Alt+E (dir 0): the current tab itself', async () => {
    const switcher = await boot({ tabs: ABC(), context: { direction: 0 } });
    expect(switcher.state.entries[switcher.state.selected].tab.id).toBe(switcher.CONTEXT.sourceTab);
    expect(selectedTitle()).toBe('Alpha');
  });
  it('Alt+W held: the card after the current tab', async () => {
    const switcher = await boot({ tabs: ABC(), context: { hold: true, direction: 1 } });
    expect(selectedTitle()).toBe('Bravo');
    expect(switcher.state.holding).toBe(true);
    expect(document.documentElement.classList.contains('alttab')).toBe(true);
  });
  it('Alt+Q held: the card before the current tab (wrapping around)', async () => {
    await boot({ tabs: ABC(), context: { hold: true, direction: -1 } });
    expect(selectedTitle()).toBe('Charlie');
  });
  it('Alt+Q held in "By order": the tab to the left of the current one', async () => {
    await chrome.storage.local.set({ view: { sort: 'order', collapsed: [] } });
    const tabs = ABC();
    tabs[1].active = true; // Bravo is current
    await boot({ tabs, context: { hold: true, direction: -1 } });
    expect(selectedTitle()).toBe('Alpha');
  });
  it('one tab only: selects it', async () => {
    const switcher = await boot({ tabs: [{ title: 'Solo', url: 'https://solo.example/' }], context: { via: 'icon' } });
    expect(switcher.state.selected).toBe(0);
    expect(selectedTitle()).toBe('Solo');
  });
  it('a queued move from the background (READY reply) moves on from there', async () => {
    const switcher = await boot({ tabs: ABC(), context: { hold: true, direction: 1 }, beforeImport: () => chrome.runtime.sendMessage.mockResolvedValue({ extra: 1 }) });
    await waitFor(() => selectedTitle() === 'Charlie');
    expect(switcher.state.holding).toBe(true);
  });
  it('Alt+E or Alt+R pressed while it was still loading (READY reply): it stays open, or the palette opens', async () => {
    const switcher = await boot({ tabs: ABC(), context: { hold: true, direction: 1 }, beforeImport: () => chrome.runtime.sendMessage.mockResolvedValue({ extra: 0, stay: true }) });
    await waitFor(() => !switcher.state.holding);
    expect(switcher.state.palette).toBeFalsy();
    const secondSwitcher = await boot({ tabs: ABC(), context: { hold: true, direction: 1 }, beforeImport: () => chrome.runtime.sendMessage.mockResolvedValue({ extra: 0, palette: true }) });
    await waitFor(() => !!secondSwitcher.state.palette);
    expect(byTestId('palette').hidden).toBe(false);
  });
  it('a resume note (back from capturing one tab): search, scope, star filter and selection come back; no first-run', async () => {
    const switcher = await boot({
      tabs: ABC(), context: { direction: 1 },
      beforeImport: () => chrome.storage.session.set({ resume: { t: Date.now(), query: 'char', scope: 'all', starred: false, key: 't3' } }),
    });
    expect(switcher.state.query).toBe('char');
    expect(byTestId('search').value).toBe('char');
    expect(selectedTitle()).toBe('Charlie');
    expect(chrome.storage.session._data.has('resume')).toBe(false); // taken once
    expect(chrome.storage.local.get).not.toHaveBeenCalledWith('rv'); // firstRun skipped (no review counting)
  });
  it('a stale resume note is ignored', async () => {
    await boot({
      tabs: ABC(), context: { direction: 0 },
      beforeImport: () => chrome.storage.session.set({ resume: { t: Date.now() - 60000, query: 'char', key: 't3' } }),
    });
    expect(byTestId('search').value).toBe('');
    expect(selectedTitle()).toBe('Alpha');
  });
  it('renders the cards, focuses the search box and tells the background it is ready', async () => {
    await boot({ tabs: ABC() });
    expect(openCards().length).toBe(3);
    expect(document.activeElement).toBe(byTestId('search'));
    expect(window.focus).toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'tabazing:ready' });
    expect(document.documentElement.classList.contains('window')).toBe(true);
    expect(chrome.storage.local.get).toHaveBeenCalledWith('rv'); // firstRun counted the open
  });
});

describe('clickjacking guard', () => {
  afterEach(restoreParent);

  it('window mode: pointer and keys always allowed', async () => {
    const switcher = await boot();
    expect(switcher.pointerAllowed()).toBe(true);
    expect(switcher.keysAllowed()).toBe(true);
  });

  it('overlay: launched by the parent page, says READY, and closes by message', async () => {
    const { switcher, parent } = await bootOverlay({ tabs: ABC() });
    expect(switcher.CONTEXT.mode).toBe('overlay');
    expect(parent.postMessage).toHaveBeenCalledWith({ tabazing: 'standby' }, '*');
    expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ tabazing: 'ready' }), '*');
    await switcher.finish('cancel');
    expect(parent.postMessage).toHaveBeenCalledWith({ tabazing: 'close' }, '*');
    expect(window.close).not.toHaveBeenCalled();
  });

  it('overlay: clicks are ignored until Chrome has seen it visible for a moment', async () => {
    const { switcher, observer } = await bootOverlay({ tabs: ABC() });
    const now = vi.spyOn(performance, 'now');
    const startTime = Math.floor(performance.now()); // whole ms: (t0 + 300) - t0 can come out a hair under 300 otherwise
    expect(switcher.pointerAllowed()).toBe(false);
    openCards()[1].click();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    now.mockReturnValue(startTime);
    observer.fire(true);
    expect(switcher.pointerAllowed()).toBe(false); // just became visible
    now.mockReturnValue(startTime + 300);
    expect(switcher.pointerAllowed()).toBe(true);
    observer.fire(false); // covered again
    expect(switcher.pointerAllowed()).toBe(false);
  });

  it('overlay: keys action during the first moments, then only while visible', async () => {
    const { switcher, observer } = await bootOverlay({ tabs: ABC() });
    const now = vi.spyOn(performance, 'now');
    const startTime = switcher.bootedAt;
    now.mockReturnValue(startTime + 100);
    expect(switcher.keysAllowed()).toBe(true); // grace period
    now.mockReturnValue(startTime + 900);
    expect(switcher.keysAllowed()).toBe(false);
    observer.fire(true);
    expect(switcher.keysAllowed()).toBe(true);
    observer.fire(false); // seen once, now hidden: no grace any more
    now.mockReturnValue(startTime + 100);
    expect(switcher.keysAllowed()).toBe(false);
  });

  it('overlay: an action key while hidden closes instead of acting', async () => {
    const { switcher, parent } = await bootOverlay({ tabs: ABC() });
    vi.spyOn(performance, 'now').mockReturnValue(switcher.bootedAt + 900);
    key('Enter');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(switcher.state.done).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith({ tabazing: 'close' }, '*');
  });

  it('overlay never seen visible: a blocked click falls back to the popup window', async () => {
    const { switcher } = await bootOverlay({ tabs: ABC() });
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(switcher.readyAt + 500);
    expect(switcher.pointerAllowed()).toBe(false);
    expect(switcher.state.done).toBe(false); // too early to tell
    now.mockReturnValue(switcher.readyAt + 1300);
    expect(switcher.pointerAllowed()).toBe(false);
    expect(switcher.state.done).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'tabazing:fallback' });
  });

  it('overlay seen visible once: no fallback', async () => {
    const { switcher, observer } = await bootOverlay({ tabs: ABC() });
    observer.fire(true);
    observer.fire(false);
    vi.spyOn(performance, 'now').mockReturnValue(switcher.readyAt + 5000);
    switcher.stuckFallback();
    expect(switcher.state.done).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'tabazing:fallback' });
  });

  it('overlay: Alt let go in the page (RELEASED from the parent) switches', async () => {
    const { switcher, parent } = await bootOverlay({ tabs: ABC(), context: { hold: true, direction: 1 } });
    window.dispatchEvent(new MessageEvent('message', { data: { tabazing: 'released' }, source: parent }));
    await waitFor(() => switcher.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true }); // Bravo
  });

  it('overlay: RELEASED from anyone else is ignored', async () => {
    const { switcher } = await bootOverlay({ tabs: ABC(), context: { hold: true, direction: 1 } });
    window.dispatchEvent(new MessageEvent('message', { data: { tabazing: 'released' }, source: null }));
    await tick(10);
    expect(switcher.state.done).toBe(false);
    expect(switcher.state.holding).toBe(true);
  });
});

describe('presses while it starts up, and a tap already over', () => {
  // A window launch over Alpha, Bravo, Charlie, Delta (most recently used in that order); `hold`: Alt+W.
  async function bootWindow(context = {}, beforeImport = () => {}) {
    loadPage();
    chrome._addWindow({ id: 1, focused: true });
    const made = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((title, i) => chrome._addTab({ windowId: 1, active: i === 0, title, url: `https://${title.toLowerCase()}.example/` }));
    await chrome.storage.local.set({ onb: { tour: true, flyout: true, at: Date.now() } });
    await chrome.storage.session.set({ mru: made.map((tab) => tab.id), launch: { token: 'token-x', t: Date.now(), context: { sourceTab: made[0].id, window: 1, direction: 1, via: 'key', hold: true, state: 'normal', mode: 'window', ...context } } });
    history.replaceState(null, '', '/switcher.html?t=token-x');
    Object.defineProperty(window, 'parent', { value: window, configurable: true }); // its own window, not a frame
    beforeImport();
    vi.resetModules();
    chrome._clearListeners();
    return { switcher: await import('../../switcher.js'), made };
  }

  it('a second Alt+W that arrives while it is still reading the tabs counts (lands on the next card)', async () => {
    let release = null;
    const realQuery = chrome.tabs.query;
    const { switcher } = await bootWindow({}, () => {
      chrome.tabs.query = (...values) => (!release && values[0] && values[0].windowId === 1
        ? new Promise((resolve) => { release = () => { chrome.tabs.query = realQuery; resolve(realQuery(...values)); }; })
        : realQuery(...values));
    });
    await waitFor(() => release);
    chrome.runtime.onMessage._emit({ type: MESSAGE.CYCLE, direction: 1, hold: true }, { id: chrome.runtime.id }, vi.fn());
    release();
    await waitFor(() => !byTestId('app').hidden);
    await tick(30);
    expect(switcher.state.entries[switcher.state.selected].tab.title).toBe('Charlie');
    switcher.state.done = true;
  });

  it('in its own window, a quick tap the page saw end (released) switches to the selected tab once drawn', async () => {
    const { switcher, made } = await bootWindow({ released: true });
    await waitFor(() => chrome.tabs.update.mock.calls.length > 0);
    expect(chrome.tabs.update).toHaveBeenCalledWith(made[1].id, { active: true });
    switcher.state.done = true;
  });
});
