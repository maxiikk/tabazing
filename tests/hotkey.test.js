import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MSG } from '../lib/constants.js';

// hotkey.js is a classic content script (an IIFE, no imports): run its source in the jsdom window.
const SRC = readFileSync(resolve(process.cwd(), 'hotkey.js'), 'utf8');
const load = () => new Function(SRC)();
const EXT_ID = chrome.runtime.id;

// jsdom's events are untrusted, as a page's synthetic ones are, and isTrusted can't be redefined on them.
// So window's listeners are wrapped (for this file only): an event marked as a real key press reaches
// them through a view that reports isTrusted: true. Everything else reaches them as is.
const trusted = new WeakSet();
const wrappers = new WeakMap();
const { addEventListener: add, removeEventListener: remove } = window;
const asTrusted = (e) => new Proxy(e, {
  get: (t, p) => (p === 'isTrusted' ? true : typeof t[p] === 'function' ? t[p].bind(t) : t[p]),
});
const wrap = (fn) => {
  if (typeof fn !== 'function') return fn;
  if (!wrappers.has(fn)) wrappers.set(fn, (e) => fn(trusted.has(e) ? asTrusted(e) : e));
  return wrappers.get(fn);
};
beforeAll(() => {
  window.addEventListener = function (type, fn, opts) { return add.call(this, type, wrap(fn), opts); };
  window.removeEventListener = function (type, fn, opts) { return remove.call(this, type, wrap(fn), opts); };
});
afterAll(() => {
  window.addEventListener = add;
  window.removeEventListener = remove;
});

function key(type, init, isTrusted = true) {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  if (isTrusted) trusted.add(e);
  window.dispatchEvent(e);
  return e;
}
const press = (code, mods = {}, trusted) => key('keydown', { code, key: code.slice(3).toLowerCase(), altKey: true, ...mods }, trusted);
const sent = () => chrome.runtime.sendMessage.mock.calls.map((c) => c[0]);

function unload() {
  const h = window.__tabazingHotkey;
  if (!h) return;
  window.removeEventListener('keydown', h.onKey, true);
  window.removeEventListener('keydown', h.onAlt, true);
  window.removeEventListener('keyup', h.onAlt, true);
  window.removeEventListener('blur', h.onBlur, true);
  delete window.__tabazingHotkey;
}

beforeEach(() => load());
afterEach(() => {
  unload();
  chrome.runtime.id = EXT_ID;
  vi.useRealTimers();
});

describe('hotkey.js', () => {
  it('Alt+Q / Alt+W hold-to-switch backwards / forwards; Alt+E opens and stays', () => {
    press('KeyQ');
    press('KeyW');
    press('KeyE');
    expect(sent()).toEqual([
      { type: MSG.HOTKEY, dir: -1, hold: true },
      { type: MSG.HOTKEY, dir: 1, hold: true },
      { type: MSG.HOTKEY, dir: 0, hold: false },
    ]);
  });

  it('Shift turns the direction around (Alt+E has none)', () => {
    press('KeyQ', { shiftKey: true });
    press('KeyW', { shiftKey: true });
    press('KeyE', { shiftKey: true });
    expect(sent().map((m) => m.dir)).toEqual([1, -1, 0]);
  });

  it('takes the key from the page', () => {
    const seen = vi.fn();
    document.body.addEventListener('keydown', seen);
    const e = press('KeyQ');
    expect(e.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', seen);
  });

  it('Ctrl+Shift+Space (Cmd+Shift+Space on a Mac) asks for the command palette', () => {
    const space = (mods) => key('keydown', { code: 'Space', key: ' ', shiftKey: true, ...mods });
    const e = space({ ctrlKey: true });
    space({ metaKey: true });
    expect(sent()).toEqual([
      { type: MSG.HOTKEY, dir: 0, hold: false, palette: true },
      { type: MSG.HOTKEY, dir: 0, hold: false, palette: true },
    ]);
    expect(e.defaultPrevented).toBe(true);
  });

  it('but not Space with other modifiers, repeats, or a page’s own (untrusted) events', () => {
    const space = (mods, trusted) => key('keydown', { code: 'Space', key: ' ', ...mods }, trusted);
    space({ ctrlKey: true }); // no Shift
    space({ shiftKey: true }); // no Ctrl
    space({ ctrlKey: true, metaKey: true, shiftKey: true }); // both
    space({ ctrlKey: true, shiftKey: true, altKey: true });
    space({ ctrlKey: true, shiftKey: true, repeat: true });
    const e = space({ ctrlKey: true, shiftKey: true }, false);
    expect(sent()).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('ignores events the page dispatches itself (untrusted)', () => {
    const e = press('KeyQ', {}, false);
    expect(e.isTrusted).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('ignores other keys, Ctrl/Meta combos, no Alt, and auto-repeat', () => {
    press('KeyR');
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
    expect(sent()).toEqual([{ type: MSG.HOTKEY, dir: 0, hold: false }, { type: MSG.HOTKEY, dir: 0, hold: false }]);
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
      chrome.runtime.id = EXT_ID;
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
