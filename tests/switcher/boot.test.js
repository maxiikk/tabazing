// Boot: the launch token, the opening selection, resume notes, and the overlay's clickjacking guard.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadPage, tick, waitFor, key } from '../helpers/switcher.js';
import { boot, bootOverlay, restoreParent, ABC, selectedTitle, openCards, cards, tid } from './_ui.js';

// Load the page with a launch that is wrong somehow, and let the module run.
async function bootBad({ urlToken = 'tok', stored = { token: 'tok', t: Date.now(), ctx: { src: 1, win: 1, dir: 1, mode: 'window' } } } = {}) {
  loadPage();
  chrome._addWindow({ id: 1, focused: true });
  chrome._addTab({ windowId: 1, active: true, title: 'A', url: 'https://a.example/' });
  if (stored) await chrome.storage.session.set({ launch: stored });
  history.replaceState(null, '', '/switcher.html' + (urlToken ? '?t=' + urlToken : ''));
  const add = vi.spyOn(window, 'addEventListener');
  vi.resetModules();
  chrome._clearListeners();
  const mod = await import('../../switcher.js');
  await tick(30);
  return { mod, keyListeners: add.mock.calls.filter(([type]) => type === 'keydown').length };
}

describe('getLaunch: a launch that does not check out', () => {
  const nothingRuns = ({ mod, keyListeners }) => {
    expect(mod.CTX).toBe(null);
    expect(tid('app').hidden).toBe(true);
    expect(cards(document).length).toBe(0);
    expect(keyListeners).toBe(0);
    expect(chrome.runtime.onMessage.hasListeners()).toBe(false);
    expect(chrome.tabs.onRemoved.hasListeners()).toBe(false);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  };
  it('no token in the address', async () => nothingRuns(await bootBad({ urlToken: '' })));
  it('a wrong token', async () => nothingRuns(await bootBad({ urlToken: 'guess' })));
  it('no launch stored', async () => nothingRuns(await bootBad({ stored: null })));
  it('an expired token', async () => nothingRuns(await bootBad({ stored: { token: 'tok', t: Date.now() - 60000, ctx: { src: 1, win: 1, mode: 'window' } } })));
  it('an overlay token used in a popup window', async () => nothingRuns(await bootBad({ stored: { token: 'tok', t: Date.now(), ctx: { src: 1, win: 1, mode: 'overlay' } } })));
  it('the token is one-time: it is used up', async () => {
    const sw = await boot();
    expect(sw.CTX.mode).toBe('window');
    expect(chrome.storage.session._data.has('launch')).toBe(false);
  });
});

describe('opening selection', () => {
  it('toolbar icon / other: the tab used before the current one', async () => {
    await chrome.storage.session.set({ mru: [1, 3, 2] }); // ids: Alpha 1 (current), Bravo 2, Charlie 3
    const sw = await boot({ tabs: ABC(), ctx: { via: 'icon', dir: 1 } });
    expect(sw.state.tabs.map((x) => x.title)).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(selectedTitle()).toBe('Charlie');
  });
  it('Alt+E (dir 0): the current tab itself', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { dir: 0 } });
    expect(sw.state.entries[sw.state.sel].tab.id).toBe(sw.CTX.srcTab);
    expect(selectedTitle()).toBe('Alpha');
  });
  it('Alt+W held: the card after the current tab', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { hold: true, dir: 1 } });
    expect(selectedTitle()).toBe('Bravo');
    expect(sw.state.holding).toBe(true);
    expect(document.documentElement.classList.contains('alttab')).toBe(true);
  });
  it('Alt+Q held: the card before the current tab (wrapping around)', async () => {
    await boot({ tabs: ABC(), ctx: { hold: true, dir: -1 } });
    expect(selectedTitle()).toBe('Charlie');
  });
  it('Alt+Q held in "By order": the tab to the left of the current one', async () => {
    await chrome.storage.local.set({ view: { sort: 'order', collapsed: [] } });
    const tabs = ABC();
    tabs[1].active = true; // Bravo is current
    await boot({ tabs, ctx: { hold: true, dir: -1 } });
    expect(selectedTitle()).toBe('Alpha');
  });
  it('one tab only: selects it', async () => {
    const sw = await boot({ tabs: [{ title: 'Solo', url: 'https://solo.example/' }], ctx: { via: 'icon' } });
    expect(sw.state.sel).toBe(0);
    expect(selectedTitle()).toBe('Solo');
  });
  it('a queued move from the background (READY reply) moves on from there', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { hold: true, dir: 1 }, beforeImport: () => chrome.runtime.sendMessage.mockResolvedValue({ extra: 1 }) });
    await waitFor(() => selectedTitle() === 'Charlie');
    expect(sw.state.holding).toBe(true);
  });
  it('Alt+E or Alt+R pressed while it was still loading (READY reply): it stays open, or the palette opens', async () => {
    const sw = await boot({ tabs: ABC(), ctx: { hold: true, dir: 1 }, beforeImport: () => chrome.runtime.sendMessage.mockResolvedValue({ extra: 0, stay: true }) });
    await waitFor(() => !sw.state.holding);
    expect(sw.state.palette).toBeFalsy();
    const sw2 = await boot({ tabs: ABC(), ctx: { hold: true, dir: 1 }, beforeImport: () => chrome.runtime.sendMessage.mockResolvedValue({ extra: 0, palette: true }) });
    await waitFor(() => !!sw2.state.palette);
    expect(tid('palette').hidden).toBe(false);
  });
  it('a resume note (back from capturing one tab): search, scope, star filter and selection come back; no first-run', async () => {
    const sw = await boot({
      tabs: ABC(), ctx: { dir: 1 },
      beforeImport: () => chrome.storage.session.set({ resume: { t: Date.now(), query: 'char', scope: 'all', starred: false, key: 't3' } }),
    });
    expect(sw.state.query).toBe('char');
    expect(tid('search').value).toBe('char');
    expect(selectedTitle()).toBe('Charlie');
    expect(chrome.storage.session._data.has('resume')).toBe(false); // taken once
    expect(chrome.storage.local.get).not.toHaveBeenCalledWith('rv'); // firstRun skipped (no review counting)
  });
  it('a stale resume note is ignored', async () => {
    await boot({
      tabs: ABC(), ctx: { dir: 0 },
      beforeImport: () => chrome.storage.session.set({ resume: { t: Date.now() - 60000, query: 'char', key: 't3' } }),
    });
    expect(tid('search').value).toBe('');
    expect(selectedTitle()).toBe('Alpha');
  });
  it('renders the cards, focuses the search box and tells the background it is ready', async () => {
    await boot({ tabs: ABC() });
    expect(openCards().length).toBe(3);
    expect(document.activeElement).toBe(tid('search'));
    expect(window.focus).toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'tabazing:ready' });
    expect(document.documentElement.classList.contains('window')).toBe(true);
    expect(chrome.storage.local.get).toHaveBeenCalledWith('rv'); // firstRun counted the open
  });
});

describe('clickjacking guard', () => {
  afterEach(restoreParent);

  it('window mode: pointer and keys always allowed', async () => {
    const sw = await boot();
    expect(sw.pointerAllowed()).toBe(true);
    expect(sw.keysAllowed()).toBe(true);
  });

  it('overlay: launched by the parent page, says READY, and closes by message', async () => {
    const { sw, parent } = await bootOverlay({ tabs: ABC() });
    expect(sw.CTX.mode).toBe('overlay');
    expect(parent.postMessage).toHaveBeenCalledWith({ tabazing: 'standby' }, '*');
    expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ tabazing: 'ready' }), '*');
    await sw.finish('cancel');
    expect(parent.postMessage).toHaveBeenCalledWith({ tabazing: 'close' }, '*');
    expect(window.close).not.toHaveBeenCalled();
  });

  it('overlay: clicks are ignored until Chrome has seen it visible for a moment', async () => {
    const { sw, io } = await bootOverlay({ tabs: ABC() });
    const now = vi.spyOn(performance, 'now');
    const t0 = Math.floor(performance.now()); // whole ms: (t0 + 300) - t0 can come out a hair under 300 otherwise
    expect(sw.pointerAllowed()).toBe(false);
    openCards()[1].click();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    now.mockReturnValue(t0);
    io.fire(true);
    expect(sw.pointerAllowed()).toBe(false); // just became visible
    now.mockReturnValue(t0 + 300);
    expect(sw.pointerAllowed()).toBe(true);
    io.fire(false); // covered again
    expect(sw.pointerAllowed()).toBe(false);
  });

  it('overlay: keys act during the first moments, then only while visible', async () => {
    const { sw, io } = await bootOverlay({ tabs: ABC() });
    const now = vi.spyOn(performance, 'now');
    const t0 = sw.bootedAt;
    now.mockReturnValue(t0 + 100);
    expect(sw.keysAllowed()).toBe(true); // grace period
    now.mockReturnValue(t0 + 900);
    expect(sw.keysAllowed()).toBe(false);
    io.fire(true);
    expect(sw.keysAllowed()).toBe(true);
    io.fire(false); // seen once, now hidden: no grace any more
    now.mockReturnValue(t0 + 100);
    expect(sw.keysAllowed()).toBe(false);
  });

  it('overlay: an action key while hidden closes instead of acting', async () => {
    const { sw, parent } = await bootOverlay({ tabs: ABC() });
    vi.spyOn(performance, 'now').mockReturnValue(sw.bootedAt + 900);
    key('Enter');
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(sw.state.done).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith({ tabazing: 'close' }, '*');
  });

  it('overlay never seen visible: a blocked click falls back to the popup window', async () => {
    const { sw } = await bootOverlay({ tabs: ABC() });
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(sw.readyAt + 500);
    expect(sw.pointerAllowed()).toBe(false);
    expect(sw.state.done).toBe(false); // too early to tell
    now.mockReturnValue(sw.readyAt + 1300);
    expect(sw.pointerAllowed()).toBe(false);
    expect(sw.state.done).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'tabazing:fallback' });
  });

  it('overlay seen visible once: no fallback', async () => {
    const { sw, io } = await bootOverlay({ tabs: ABC() });
    io.fire(true);
    io.fire(false);
    vi.spyOn(performance, 'now').mockReturnValue(sw.readyAt + 5000);
    sw.stuckFallback();
    expect(sw.state.done).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'tabazing:fallback' });
  });

  it('overlay: Alt let go in the page (RELEASED from the parent) switches', async () => {
    const { sw, parent } = await bootOverlay({ tabs: ABC(), ctx: { hold: true, dir: 1 } });
    window.dispatchEvent(new MessageEvent('message', { data: { tabazing: 'released' }, source: parent }));
    await waitFor(() => sw.state.done);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true }); // Bravo
  });

  it('overlay: RELEASED from anyone else is ignored', async () => {
    const { sw } = await bootOverlay({ tabs: ABC(), ctx: { hold: true, dir: 1 } });
    window.dispatchEvent(new MessageEvent('message', { data: { tabazing: 'released' }, source: null }));
    await tick(10);
    expect(sw.state.done).toBe(false);
    expect(sw.state.holding).toBe(true);
  });
});
