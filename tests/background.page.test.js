// background.js: the functions it injects into pages (nudge, flyout, overlay host), run here in jsdom.
// Elements are found by data-testid only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MSG, FRAME_MSG } from '../lib/constants.js';
import { env, freshWorker } from './background.shared.js';

freshWorker();
const bg = () => env.bg;
const $ = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);

// The nudge and the flyout live in closed shadow roots: keep a handle on each one created.
let roots;
beforeEach(() => {
  roots = [];
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (o) { const r = attach.call(this, o); roots.push(r); return r; });
});
afterEach(() => {
  for (const id of ['nudge-host', 'flyout-host', 'overlay-shade', 'overlay-frame']) document.querySelectorAll(`[data-testid="${id}"]`).forEach((n) => n.remove());
  for (const k of ['__tabazingNudge', '__tabazingFlyout', '__tabazingOverlay', '__tabazingHotkey']) delete window[k];
  delete document.hidden;
});
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })); // isTrusted: false, like a page script's click

describe('injectNudge', () => {
  const text = { title: 'Looking?', body: 'Alt+Q shows them all.', tryIt: 'Try', ok: 'OK', never: 'Never', close: 'Close' };
  const show = () => bg().injectNudge(MSG.NUDGE, 12000, text, 'Alt+Q');

  it('shows the note with the key in it, in a closed shadow root', () => {
    show();
    const host = $('nudge-host');
    expect(host).not.toBeNull();
    expect(host.shadowRoot).toBeNull(); // closed: the page can't reach in
    const root = roots[0];
    expect($('nudge-title', root).textContent).toBe('Looking?');
    expect($('nudge-body', root).textContent).toBe('Alt+Q shows them all.');
    expect($('nudge-key', root).textContent).toBe('Alt+Q');
    expect([...$('nudge-buttons', root).children].map((b) => b.dataset.testid)).toEqual(['nudge-try', 'nudge-ok', 'nudge-never']);
    expect($('nudge-close', root).getAttribute('aria-label')).toBe('Close');
  });

  it('only once per page', () => {
    show();
    show();
    expect(document.querySelectorAll('[data-testid="nudge-host"]')).toHaveLength(1);
  });

  it('goes away after its time, and can be shown again', () => {
    show();
    vi.advanceTimersByTime(11999);
    expect($('nudge-host')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect($('nudge-host')).toBeNull();
    expect(window.__tabazingNudge).toBeUndefined();
  });

  it('the close button removes it without answering', () => {
    show();
    click($('nudge-close', roots[0]));
    expect($('nudge-host')).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('is a dialog named by its title; Esc closes it', () => {
    show();
    const box = $('nudge', roots[0]);
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-label')).toBe('Looking?');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('nudge-host')).toBeNull();
  });

  it('stays while the pointer or the keyboard focus is on it, then runs its full time again', () => {
    show();
    const box = $('nudge', roots[0]);
    box.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(30000);
    expect($('nudge-host')).not.toBeNull();
    box.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(11999);
    expect($('nudge-host')).not.toBeNull();
    box.dispatchEvent(new FocusEvent('focusin'));
    vi.advanceTimersByTime(30000);
    expect($('nudge-host')).not.toBeNull();
  });

  it('answer buttons ignore clicks a page script makes', () => {
    show();
    for (const id of ['nudge-try', 'nudge-ok', 'nudge-never']) click($(id, roots[0]));
    expect($('nudge-host')).not.toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('injectFlyout', () => {
  const text = { title: 'Tabazing is ready', body: 'Press $KEY$ to see all your tabs.', sub: 'Small print', close: 'Dismiss' };
  const show = () => bg().injectFlyout(MSG.FLYOUT_DONE, 20000, text);

  it('shows the card with the key for this platform', () => {
    show();
    const root = roots[0];
    expect($('flyout-host').shadowRoot).toBeNull();
    expect($('flyout-title', root).textContent).toBe('Tabazing is ready');
    expect($('flyout-body', root).textContent).toBe('Press Alt+Q to see all your tabs.');
    expect($('flyout-key', root).textContent).toBe('Alt+Q');
    expect($('flyout-sub', root).textContent).toBe('Small print');
    expect($('flyout-close', root).getAttribute('aria-label')).toBe('Dismiss');
  });

  it('says Option+Q on a Mac', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    show();
    expect($('flyout-key', roots[0]).textContent).toBe('Option+Q');
  });

  it('only once per page', () => {
    show();
    show();
    expect(document.querySelectorAll('[data-testid="flyout-host"]')).toHaveLength(1);
  });

  it('dismissing it tells the worker (so it is not offered again)', () => {
    show();
    click($('flyout-close', roots[0]));
    expect($('flyout-host')).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG.FLYOUT_DONE });
  });

  it('is a dialog named by its title; Esc dismisses it like the ×', () => {
    show();
    const box = $('flyout', roots[0]);
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-label')).toBe('Tabazing is ready');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('flyout-host')).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG.FLYOUT_DONE });
  });

  it('does not go away while hovered', () => {
    show();
    $('flyout', roots[0]).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(60000);
    expect($('flyout-host')).not.toBeNull();
  });

  it('left alone it goes away quietly (offered again on the next page)', () => {
    show();
    vi.advanceTimersByTime(20000);
    expect($('flyout-host')).toBeNull();
    expect(window.__tabazingFlyout).toBeUndefined();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('overlayHost', () => {
  const SRC = 'chrome-extension://abc/switcher.html';
  const ORIGIN = 'chrome-extension://abc';
  const host = (mode, token = null, hold = false) => bg().overlayHost(SRC, ORIGIN, FRAME_MSG, mode, token, hold, 60000);
  const frame = () => $('overlay-frame');
  const shade = () => $('overlay-shade');
  const fromFrame = (data, source = frame().contentWindow) => window.dispatchEvent(new MessageEvent('message', { data, source }));
  const spyPost = () => vi.spyOn(frame().contentWindow, 'postMessage').mockImplementation(() => {});
  const shown = () => frame().style.visibility === 'visible' && frame().style.opacity === '1' && frame().style.pointerEvents === 'auto';

  it('names the frame for screen readers with the label it is given', () => {
    bg().overlayHost(SRC, ORIGIN, FRAME_MSG, 'standby', null, false, 60000, 'Selector de pestañas Tabazing');
    expect(frame().getAttribute('aria-label')).toBe('Selector de pestañas Tabazing');
  });

  it('standby: an invisible, inert frame on the switcher page', () => {
    host('standby');
    expect(shade()).not.toBeNull();
    expect(frame().src).toMatch(new RegExp('^' + SRC + '\\?standby=\\d+$'));
    expect(frame().inert).toBe(true);
    expect(frame().tabIndex).toBe(-1);
    expect(frame().getAttribute('aria-hidden')).toBe('true');
    expect(frame().style.visibility).toBe('hidden');
    expect(frame().style.pointerEvents).toBe('none');
    expect(window.__tabazingOverlay).toMatchObject({ ready: false, active: false });
  });

  it('standby again keeps the frame that is there', () => {
    host('standby');
    const f = frame();
    host('standby');
    expect(frame()).toBe(f);
    expect(document.querySelectorAll('[data-testid="overlay-frame"]')).toHaveLength(1);
  });

  it('launch: hands the token to the frame once it has loaded, addressed to the extension origin', () => {
    host('standby');
    const post = spyPost();
    host('launch', 'tok');
    expect(window.__tabazingOverlay.active).toBe(true);
    expect(frame().inert).toBe(false);
    expect(post).not.toHaveBeenCalled(); // not loaded yet
    fromFrame({ tabazing: FRAME_MSG.STANDBY });
    expect(post).toHaveBeenCalledWith({ tabazing: FRAME_MSG.LAUNCH, token: 'tok' }, ORIGIN);
    fromFrame({ tabazing: FRAME_MSG.STANDBY });
    expect(post).toHaveBeenCalledTimes(1); // only once
  });

  it('a prepared frame that is ready gets the token straight away', () => {
    host('standby');
    const post = spyPost();
    fromFrame({ tabazing: FRAME_MSG.STANDBY });
    host('launch', 'tok');
    expect(post).toHaveBeenCalledWith({ tabazing: FRAME_MSG.LAUNCH, token: 'tok' }, ORIGIN);
  });

  it('stays invisible until the switcher says READY, then shows', () => {
    host('launch', 'tok');
    expect(shown()).toBe(false);
    fromFrame({ tabazing: FRAME_MSG.READY });
    expect(shown()).toBe(true);
    expect(shade().style.visibility).toBe('visible');
  });

  it('a light switcher gets a light shade', () => {
    host('launch', 'tok');
    fromFrame({ tabazing: FRAME_MSG.READY, light: true });
    expect(shade().style.backdropFilter).toContain('brightness(1.06)');
  });

  it('ignores messages from anything but its frame, and malformed ones', () => {
    host('launch', 'tok');
    fromFrame({ tabazing: FRAME_MSG.READY }, window);
    fromFrame({ tabazing: 5 });
    fromFrame(null);
    expect(shown()).toBe(false);
  });

  it('READY without a launch does not show the standby frame', () => {
    host('standby');
    fromFrame({ tabazing: FRAME_MSG.READY });
    expect(shown()).toBe(false);
  });

  it('CLOSE hides it, gives the page its focus back and prepares a fresh frame', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    host('launch', 'tok');
    const src = frame().src;
    fromFrame({ tabazing: FRAME_MSG.READY });
    vi.advanceTimersByTime(5);
    fromFrame({ tabazing: FRAME_MSG.CLOSE });
    expect(shown()).toBe(false);
    expect(frame().inert).toBe(true);
    expect(window.__tabazingOverlay.active).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(frame().src).not.toBe(src);
    input.remove();
  });

  it('a second launch while one is open replaces the host', () => {
    host('launch', 'a');
    const first = window.__tabazingOverlay;
    host('launch', 'b');
    expect(window.__tabazingOverlay).not.toBe(first);
    expect(document.querySelectorAll('[data-testid="overlay-frame"]')).toHaveLength(1);
  });

  it('a frame the page removed is rebuilt', () => {
    host('standby');
    frame().remove();
    host('standby');
    expect(frame()).not.toBeNull();
    expect(window.__tabazingOverlay.frame.isConnected).toBe(true);
  });

  it('hold: a quick tap already over is passed on once the switcher has drawn', () => {
    window.__tabazingHotkey = { altState: () => 'up' };
    host('launch', 'tok', true);
    const post = spyPost();
    fromFrame({ tabazing: FRAME_MSG.READY });
    expect(post).toHaveBeenCalledWith({ tabazing: FRAME_MSG.RELEASED }, ORIGIN);
  });

  it('hold: Alt still down, and a synthetic Alt key-up from the page, release nothing', () => {
    window.__tabazingHotkey = { altState: () => 'down' };
    host('launch', 'tok', true);
    const post = spyPost();
    fromFrame({ tabazing: FRAME_MSG.READY });
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    expect(post).not.toHaveBeenCalledWith({ tabazing: FRAME_MSG.RELEASED }, ORIGIN);
  });

  it('without hold nothing is released', () => {
    window.__tabazingHotkey = { altState: () => 'up' };
    host('launch', 'tok', false);
    const post = spyPost();
    fromFrame({ tabazing: FRAME_MSG.READY });
    expect(post).not.toHaveBeenCalledWith({ tabazing: FRAME_MSG.RELEASED }, ORIGIN);
  });

  it('a hidden tab closes the switcher, and drops the frame after a while', () => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    host('launch', 'tok');
    fromFrame({ tabazing: FRAME_MSG.READY });
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(window.__tabazingOverlay.active).toBe(false);
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(60000);
    expect(frame()).toBeNull();
    expect(shade()).toBeNull();
    expect(window.__tabazingOverlay).toBeUndefined();
  });

  it('a tab shown again in time keeps its frame', () => {
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    host('standby');
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(30000);
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(60000);
    expect(frame()).not.toBeNull();
  });

  it('removeOverlay takes it all away and stops listening', () => {
    host('launch', 'tok');
    const h = window.__tabazingOverlay;
    bg().removeOverlay();
    expect(frame()).toBeNull();
    expect(shade()).toBeNull();
    expect(window.__tabazingOverlay).toBeUndefined();
    expect(h.active).toBe(false);
    expect(() => bg().removeOverlay()).not.toThrow(); // nothing there
  });
});
