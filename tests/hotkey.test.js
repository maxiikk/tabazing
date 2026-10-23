import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MESSAGE } from '../utils/constants.js';

// hotkey.js is a classic content script (an IIFE, no imports): run its source in the jsdom window.
const SOURCE = readFileSync(resolve(process.cwd(), 'hotkey.js'), 'utf8');
const load = () => new Function(SOURCE)();
const EXTENSION_ID = chrome.runtime.id;

// jsdom's events are untrusted, as a page's synthetic ones are, and isTrusted can't be redefined on them.
// So window's listeners are wrapped (for this file only): an event marked as a real key press reaches
// them through a view that reports isTrusted: true. Everything else reaches them as is.
const trusted = new WeakSet();
const wrappers = new WeakMap();
const { addEventListener: add, removeEventListener: remove } = window;
const asTrusted = (event) => new Proxy(event, {
  get: (target, property) => (property === 'isTrusted' ? true : typeof target[property] === 'function' ? target[property].bind(target) : target[property]),
});
const wrap = (listener) => {
  if (typeof listener !== 'function') return listener;
  if (!wrappers.has(listener)) wrappers.set(listener, (event) => listener(trusted.has(event) ? asTrusted(event) : event));
  return wrappers.get(listener);
};
beforeAll(() => {
  window.addEventListener = function (type, listener, options) { return add.call(this, type, wrap(listener), options); };
  window.removeEventListener = function (type, listener, options) { return remove.call(this, type, wrap(listener), options); };
});
afterAll(() => {
  window.addEventListener = add;
  window.removeEventListener = remove;
});

function key(type, init, isTrusted = true) {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  if (isTrusted) trusted.add(event);
  window.dispatchEvent(event);
  return event;
}
const press = (code, modifiers = {}, trusted) => key('keydown', { code, key: code.slice(3).toLowerCase(), altKey: true, ...modifiers }, trusted);
const sent = () => chrome.runtime.sendMessage.mock.calls.map((call) => call[0]);

function unload() {
  const hotkey = window.__tabazingHotkey;
  if (!hotkey) return;
  window.removeEventListener('keydown', hotkey.onKey, true);
  window.removeEventListener('keydown', hotkey.onAlt, true);
  window.removeEventListener('keyup', hotkey.onAlt, true);
  window.removeEventListener('blur', hotkey.onBlur, true);
  delete window.__tabazingHotkey;
}

beforeEach(() => load());
afterEach(() => {
  unload();
  chrome.runtime.id = EXTENSION_ID;
  vi.useRealTimers();
});

describe('hotkey.js', () => {
  it('Alt+Q / Alt+W hold-to-switch backwards / forwards; Alt+E opens and stays', () => {
    press('KeyQ');
    press('KeyW');
    press('KeyE');
    expect(sent()).toEqual([
      { type: MESSAGE.HOTKEY, direction: -1, hold: true },
      { type: MESSAGE.HOTKEY, direction: 1, hold: true },
      { type: MESSAGE.HOTKEY, direction: 0, hold: false },
    ]);
  });

  it('Shift turns the direction around (Alt+E has none)', () => {
    press('KeyQ', { shiftKey: true });
    press('KeyW', { shiftKey: true });
    press('KeyE', { shiftKey: true });
    expect(sent().map((message) => message.direction)).toEqual([1, -1, 0]);
  });

  it('takes the key from the page', () => {
    const seen = vi.fn();
    document.body.addEventListener('keydown', seen);
    const event = press('KeyQ');
    expect(event.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', seen);
  });

  it('Alt+R (Option+R on a Mac) asks for the command palette', () => {
    const event = press('KeyR');
    expect(sent()).toEqual([{ type: MESSAGE.HOTKEY, direction: 0, hold: false, palette: true }]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('but not R without Alt, with other modifiers, repeats, or a page’s own (untrusted) events', () => {
    const pressR = (modifiers, trusted) => key('keydown', { code: 'KeyR', key: 'r', altKey: true, ...modifiers }, trusted);
    pressR({ altKey: false }); // plain R: typing
    pressR({ shiftKey: true });
    pressR({ ctrlKey: true });
    pressR({ metaKey: true });
    pressR({ repeat: true });
    const event = pressR({}, false);
    expect(sent()).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores events the page dispatches itself (untrusted)', () => {
    const event = press('KeyQ', {}, false);
    expect(event.isTrusted).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores other keys, Ctrl/Meta combos, no Alt, and auto-repeat', () => {
    press('KeyT');
    press('KeyQ', { altKey: false });
    press('KeyQ', { ctrlKey: true });
    press('KeyQ', { metaKey: true });
    press('KeyQ', { repeat: true });
    key('keyup', { code: 'KeyQ', altKey: true });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('retries once if the service worker was not listening yet', async () => {
    vi.useFakeTimers();
    chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist.'));
    press('KeyE');
    await vi.advanceTimersByTimeAsync(49);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent()).toEqual([{ type: MESSAGE.HOTKEY, direction: 0, hold: false }, { type: MESSAGE.HOTKEY, direction: 0, hold: false }]);
  });

  it('a second failure is swallowed, and no retry once the extension is gone', async () => {
    vi.useFakeTimers();
    chrome.runtime.sendMessage.mockRejectedValue(new Error('nope'));
    press('KeyE');
    await vi.advanceTimersByTimeAsync(100);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);

    chrome.runtime.sendMessage.mockClear();
    press('KeyE');
    chrome.runtime.id = undefined; // reloaded while the first try was in flight
    await vi.advanceTimersByTimeAsync(100);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('an orphaned copy (extension reloaded) sends nothing and unhooks itself', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    chrome.runtime.id = undefined;
    press('KeyQ');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('keydown', window.__tabazingHotkey.onKey, true);
  });

  describe('Alt state', () => {
    const state = () => window.__tabazingHotkey.altState();

    it('is unknown until this frame sees Alt, then tracks it', () => {
      expect(state()).toBe('unknown');
      key('keydown', { key: 'Alt', code: 'AltLeft', altKey: true });
      expect(state()).toBe('down');
      key('keyup', { key: 'Alt', code: 'AltLeft' });
      expect(state()).toBe('up');
    });

    it('altSeen says what this frame saw of Alt, and when (the background asks every frame)', () => {
      expect(window.__tabazingHotkey.altSeen()).toEqual({ state: 'unknown', at: 0 });
      key('keydown', { key: 'Alt', code: 'AltLeft', altKey: true });
      key('keyup', { key: 'Alt', code: 'AltLeft' });
      expect(window.__tabazingHotkey.altSeen()).toEqual({ state: 'up', at: expect.any(Number) });
    });

    it('ignores untrusted Alt events', () => {
      key('keydown', { key: 'Alt', altKey: true }, false);
      expect(state()).toBe('unknown');
    });

    it('goes back to unknown after 10 s, or when the window loses focus', () => {
      vi.useFakeTimers();
      key('keydown', { key: 'Alt', altKey: true });
      vi.advanceTimersByTime(10000);
      expect(state()).toBe('down');
      vi.advanceTimersByTime(1);
      expect(state()).toBe('unknown');

      key('keydown', { key: 'Alt', altKey: true });
      window.dispatchEvent(new Event('blur'));
      expect(state()).toBe('unknown');
    });
  });

  describe('idempotence', () => {
    it('a second injection is a no-op while the first copy is alive', () => {
      const first = window.__tabazingHotkey;
      load();
      expect(window.__tabazingHotkey).toBe(first);
      press('KeyQ');
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('replaces an orphaned copy and removes its listeners', () => {
      const old = window.__tabazingHotkey;
      chrome.runtime.id = undefined; // the extension was reloaded: the old copy is orphaned
      const remove = vi.spyOn(window, 'removeEventListener');
      load();
      const now = window.__tabazingHotkey;
      expect(now).not.toBe(old);
      expect(remove).toHaveBeenCalledWith('keydown', old.onKey, true);
      expect(remove).toHaveBeenCalledWith('keydown', old.onAlt, true);
      expect(remove).toHaveBeenCalledWith('keyup', old.onAlt, true);
      expect(remove).toHaveBeenCalledWith('blur', old.onBlur, true);

      // Both copies share this `chrome`, so bring it back: had the old listeners stayed, this would send twice.
      chrome.runtime.id = EXTENSION_ID;
      press('KeyQ');
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('an orphan from an older version without the Alt tracker is replaced too', () => {
      const onKey = vi.fn();
      window.addEventListener('keydown', onKey, true);
      unload();
      window.__tabazingHotkey = { alive: () => false, onKey };
      load();
      press('KeyQ');
      expect(onKey).not.toHaveBeenCalled();
      expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
