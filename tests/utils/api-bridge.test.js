// utils/api-bridge.js: the switcher framed in a page in Firefox, which gets a content script's APIs only. Run here
// with a chrome.* like Firefox gives that frame (runtime, i18n, storage without its session area): the missing calls
// go through a port to the background, the events and its questions come back that way. Where the APIs are all
// there (Chrome, the rest of the tests) it changes nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let saved, port, posted, listeners, storageListeners;
beforeEach(() => {
  saved = globalThis.chrome;
  posted = [];
  listeners = new Set();
  storageListeners = [];
  port = {
    name: null,
    postMessage: vi.fn((message) => posted.push(message)),
    onMessage: { addListener: (listener) => listeners.add(listener) },
    onDisconnect: { addListener: () => {} },
  };
  globalThis.chrome = {
    runtime: { id: 'tabazing@test', connect: vi.fn(({ name }) => { port.name = name; return port; }), onMessage: { addListener: vi.fn() }, getURL: (path = '') => `moz-extension://u/${path}` },
    i18n: { getUILanguage: () => 'en' },
    storage: { local: {}, onChanged: { addListener: (listener) => storageListeners.push(listener) } },
  };
  vi.resetModules();
});
afterEach(() => { globalThis.chrome = saved; vi.resetModules(); });
const fromBackground = (message) => listeners.forEach((listener) => listener(message));

describe('in a frame with a content script’s APIs', () => {
  it('puts the missing namespaces in place, and storage.session; opens its port at once', async () => {
    const bridge = await import('../../utils/api-bridge.js');
    for (const namespace of ['tabs', 'windows', 'tabGroups', 'sessions', 'history', 'bookmarks', 'scripting', 'commands', 'permissions', 'alarms']) expect(typeof chrome[namespace], namespace).toBe('object');
    expect(typeof chrome.tabs.query).toBe('function');
    expect(typeof chrome.tabs.onRemoved.addListener).toBe('function');
    expect(typeof chrome.storage.session.get).toBe('function');
    expect(chrome.runtime.connect).toHaveBeenCalledWith({ name: bridge.BRIDGE_PORT });
  });

  it('a call goes to the background with an id; its answer, or its error, comes back to it', async () => {
    await import('../../utils/api-bridge.js');
    const query = chrome.tabs.query({ active: true });
    const update = chrome.tabs.update(3, { active: true });
    expect(posted).toEqual([{ id: 1, call: 'tabs.query', args: [{ active: true }] }, { id: 2, call: 'tabs.update', args: [3, { active: true }] }]);
    fromBackground({ id: 2, error: 'No tab with id: 3.' });
    fromBackground({ id: 1, result: [{ id: 7 }] });
    await expect(query).resolves.toEqual([{ id: 7 }]);
    await expect(update).rejects.toThrow('No tab with id: 3.');
  });

  it('a function to run in a page goes by its name (a function can’t go by message)', async () => {
    await import('../../utils/api-bridge.js');
    function pageMediaAction() {}
    chrome.scripting.executeScript({ target: { tabId: 1 }, world: 'MAIN', func: pageMediaAction, args: ['pause'] });
    expect(posted[0]).toEqual({ id: 1, call: 'scripting.executeScript', args: [{ target: { tabId: 1 }, world: 'MAIN', func: 'pageMediaAction', args: ['pause'] }] });
  });

  it('the events it listens to come back by the port; storage changes of the session area too', async () => {
    const bridge = await import('../../utils/api-bridge.js');
    const removed = vi.fn(), changed = vi.fn();
    chrome.tabs.onRemoved.addListener(removed);
    bridge.onStorageChange(changed);
    fromBackground({ event: 'tabs.onRemoved', args: [5, { windowId: 1 }] });
    fromBackground({ event: 'storage.onChanged', args: [{ media: { newValue: {} } }, 'session'] });
    expect(removed).toHaveBeenCalledWith(5, { windowId: 1 });
    expect(changed).toHaveBeenCalledWith({ media: { newValue: {} } }, 'session');
    expect(storageListeners).toEqual([changed]); // (the local area it hears itself)
  });

  it('the background’s question ("are you open?") reaches what onBackgroundMessage was given; the first answer goes back', async () => {
    const bridge = await import('../../utils/api-bridge.js');
    bridge.onBackgroundMessage((message, sender, respond) => { if (message.type === 'tabazing:cycle' && sender.id === 'tabazing@test') respond({ ok: true }); });
    fromBackground({ question: 9, body: { type: 'tabazing:cycle', direction: 1 } });
    expect(posted).toContainEqual({ answer: 9, value: { ok: true } });
    bridge.onBackgroundMessage(() => {}); // (one that doesn't answer: the answer is still the first one)
    fromBackground({ question: 10, body: { type: 'other' } });
    expect(posted).toContainEqual({ answer: 10, value: null });
  });
});

describe('where every API is there', () => {
  it('changes nothing and opens no port', async () => {
    globalThis.chrome = saved;
    const tabs = chrome.tabs;
    const connect = vi.fn();
    chrome.runtime.connect = connect;
    await import('../../utils/api-bridge.js');
    expect(chrome.tabs).toBe(tabs);
    expect(connect).not.toHaveBeenCalled();
    delete chrome.runtime.connect;
  });
});
