// Shared by tests/background.*.test.js: a fresh copy of the worker per test, with fake timers.
import { beforeEach, afterEach, vi } from 'vitest';

export const environment = { background: null };

// Let pending promise chains (storage, tabs, ...) run to the end. setImmediate is left real for this.
export const flush = async (count = 5) => { for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve)); };

// Each test gets its own worker: listeners from the last import dropped, module state (opening, watchdog...) new.
export function freshWorker() {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    chrome._clearListeners();
    vi.resetModules();
    environment.background = await import('../../background.js');
    await flush();
    vi.clearAllMocks(); // forget what the import itself called
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
}

// A focused window with one active tab on `url`.
export function seed(url = 'https://example.com/', windowProps = {}) {
  const chromeWindow = chrome._addWindow(windowProps);
  const tab = chrome._addTab({ windowId: chromeWindow.id, url, active: true });
  return { w: chromeWindow, tab };
}

// Senders, as Chrome reports them.
export const fromSwitcherPage = (tab) => ({ id: chrome.runtime.id, url: environment.background.SWITCHER_URL, ...(tab ? { tab } : {}) });
export const fromPage = (tab) => ({ id: chrome.runtime.id, url: tab.url, tab, frameId: 0 });

// Deliver a runtime message; returns the listener's return value and the respond spy.
export function send(message, sender) {
  const respond = vi.fn();
  const [result] = chrome.runtime.onMessage._emit(message, sender, respond);
  return { result, respond };
}

// The fake tabs.query matches `url` literally; Chrome treats these as match patterns (only used for "every web
// tab" here). vitest doesn't expose the original implementation after mockReset, so other queries briefly reset
// to it, which also clears query's call history.
export function patternQuery() {
  const originalQuery = chrome.tabs.query;
  const implementation = async (options = {}) => {
    if (options.url !== undefined) return structuredClone(chrome._data.tabs.filter((tab) => /^(https?|file):/.test(tab.url)));
    originalQuery.mockReset();
    const promise = originalQuery(options);
    originalQuery.mockImplementation(implementation);
    return promise;
  };
  originalQuery.mockImplementation(implementation);
}

export const launch = () => chrome.storage.session._data.get('launch');
