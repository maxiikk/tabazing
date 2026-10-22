// utils/overlay-host.js: the switcher's overlay over a page, as background.js injects it into web pages and the
// New Tab page runs it itself. Run here in jsdom; elements are found by data-testid only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FRAME_MESSAGE } from '../../utils/constants.js';
import { overlayHost, removeOverlay } from '../../utils/overlay-host.js';

const queryTestId = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
afterEach(() => {
  if (window.__tabazingOverlay) window.__tabazingOverlay.cleanup();
  for (const id of ['overlay-shade', 'overlay-frame']) document.querySelectorAll(`[data-testid="${id}"]`).forEach((element) => element.remove());
  for (const propertyName of ['__tabazingOverlay', '__tabazingHotkey']) delete window[propertyName];
  delete document.hidden;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('self-contained', () => {
  // background.js hands these to chrome.scripting.executeScript, which sends only their source text.
  it('works rebuilt from its source alone (no imports, no outside variables)', () => {
    const host = new Function('return ' + overlayHost.toString().replace(/^export /, ''))();
    const remove = new Function('return ' + removeOverlay.toString())();
    host('chrome-extension://abc/markup/switcher.html', 'chrome-extension://abc', FRAME_MESSAGE, 'standby', null, false, 60000, 'Label');
    expect(queryTestId('overlay-frame')).not.toBeNull();
    remove();
    expect(queryTestId('overlay-frame')).toBeNull();
  });
  it('background.js uses this one', async () => {
    const background = await import('../../background.js');
    expect(background.overlayHost).toBe(overlayHost);
    expect(background.removeOverlay).toBe(removeOverlay);
  });
});

describe('overlayHost', () => {
  const SOURCE = 'chrome-extension://abc/markup/switcher.html';
  const ORIGIN = 'chrome-extension://abc';
  const host = (mode, token = null, hold = false) => overlayHost(SOURCE, ORIGIN, FRAME_MESSAGE, mode, token, hold, 60000);
  const frame = () => queryTestId('overlay-frame');
  const shade = () => queryTestId('overlay-shade');
  const fromFrame = (data, source = frame().contentWindow) => window.dispatchEvent(new MessageEvent('message', { data, source }));
  const spyPost = () => vi.spyOn(frame().contentWindow, 'postMessage').mockImplementation(() => {});
  const shown = () => frame().style.visibility === 'visible' && frame().style.opacity === '1' && frame().style.pointerEvents === 'auto';

  it('names the frame for screen readers with the label it is given', () => {
    overlayHost(SOURCE, ORIGIN, FRAME_MESSAGE, 'standby', null, false, 60000, 'Selector de pestañas Tabazing');
    expect(frame().getAttribute('aria-label')).toBe('Selector de pestañas Tabazing');
  });

  it('standby: an invisible, inert frame on the switcher page', () => {
    host('standby');
    expect(shade()).not.toBeNull();
    expect(frame().src).toMatch(new RegExp('^' + SOURCE + '\\?standby=\\d+$'));
    expect(frame().inert).toBe(true);
    expect(frame().tabIndex).toBe(-1);
    expect(frame().getAttribute('aria-hidden')).toBe('true');
    expect(frame().style.visibility).toBe('hidden');
    expect(frame().style.pointerEvents).toBe('none');
    expect(window.__tabazingOverlay).toMatchObject({ ready: false, active: false });
  });

  it('standby again keeps the frame that is there', () => {
    host('standby');
    const firstFrame = frame();
    host('standby');
    expect(frame()).toBe(firstFrame);
    expect(document.querySelectorAll('[data-testid="overlay-frame"]')).toHaveLength(1);
  });

  it('launch: hands the token to the frame once it has loaded, addressed to the extension origin', () => {
    host('standby');
    const post = spyPost();
    host('launch', 'tok');
    expect(window.__tabazingOverlay.active).toBe(true);
    expect(frame().inert).toBe(false);
    expect(post).not.toHaveBeenCalled(); // not loaded yet
    fromFrame({ tabazing: FRAME_MESSAGE.STANDBY });
    expect(post).toHaveBeenCalledWith({ tabazing: FRAME_MESSAGE.LAUNCH, token: 'tok' }, ORIGIN);
    fromFrame({ tabazing: FRAME_MESSAGE.STANDBY });
    expect(post).toHaveBeenCalledTimes(1); // only once
  });

  it('a prepared frame that is ready gets the token straight away', () => {
    host('standby');
    const post = spyPost();
    fromFrame({ tabazing: FRAME_MESSAGE.STANDBY });
    host('launch', 'tok');
    expect(post).toHaveBeenCalledWith({ tabazing: FRAME_MESSAGE.LAUNCH, token: 'tok' }, ORIGIN);
  });

  it('stays invisible until the switcher says READY, then shows', () => {
    host('launch', 'tok');
    expect(shown()).toBe(false);
    fromFrame({ tabazing: FRAME_MESSAGE.READY });
    expect(shown()).toBe(true);
    expect(shade().style.visibility).toBe('visible');
  });

  it('a light switcher gets a light shade', () => {
    host('launch', 'tok');
    fromFrame({ tabazing: FRAME_MESSAGE.READY, light: true });
    expect(shade().style.backdropFilter).toContain('brightness(1.06)');
  });

  it('ignores messages from anything but its frame, and malformed ones', () => {
    host('launch', 'tok');
    fromFrame({ tabazing: FRAME_MESSAGE.READY }, window);
    fromFrame({ tabazing: 5 });
    fromFrame(null);
    expect(shown()).toBe(false);
  });

  it('READY without a launch does not show the standby frame', () => {
    host('standby');
    fromFrame({ tabazing: FRAME_MESSAGE.READY });
    expect(shown()).toBe(false);
  });

  it('CLOSE hides it, gives the page its focus back and prepares a fresh frame', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    host('launch', 'tok');
    const originalSource = frame().src;
    fromFrame({ tabazing: FRAME_MESSAGE.READY });
    vi.advanceTimersByTime(5);
    fromFrame({ tabazing: FRAME_MESSAGE.CLOSE });
    expect(shown()).toBe(false);
    expect(frame().inert).toBe(true);
    expect(window.__tabazingOverlay.active).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(frame().src).not.toBe(originalSource);
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
    fromFrame({ tabazing: FRAME_MESSAGE.READY });
    expect(post).toHaveBeenCalledWith({ tabazing: FRAME_MESSAGE.RELEASED }, ORIGIN);
  });

  it('hold: Alt still down, and a synthetic Alt key-up from the page, release nothing', () => {
    window.__tabazingHotkey = { altState: () => 'down' };
    host('launch', 'tok', true);
    const post = spyPost();
    fromFrame({ tabazing: FRAME_MESSAGE.READY });
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    expect(post).not.toHaveBeenCalledWith({ tabazing: FRAME_MESSAGE.RELEASED }, ORIGIN);
  });

  it('without hold nothing is released', () => {
    window.__tabazingHotkey = { altState: () => 'up' };
    host('launch', 'tok', false);
    const post = spyPost();
    fromFrame({ tabazing: FRAME_MESSAGE.READY });
    expect(post).not.toHaveBeenCalledWith({ tabazing: FRAME_MESSAGE.RELEASED }, ORIGIN);
  });

  it('a hidden tab closes the switcher, and drops the frame after a while', () => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    host('launch', 'tok');
    fromFrame({ tabazing: FRAME_MESSAGE.READY });
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
    const overlay = window.__tabazingOverlay;
    removeOverlay();
    expect(frame()).toBeNull();
    expect(shade()).toBeNull();
    expect(window.__tabazingOverlay).toBeUndefined();
    expect(overlay.active).toBe(false);
    expect(() => removeOverlay()).not.toThrow(); // nothing there
  });
});
