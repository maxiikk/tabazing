// Shared by tests/background.*.test.js: a fresh copy of the worker per test, with fake timers.
import { beforeEach, afterEach, vi } from 'vitest';

export const env = { bg: null };

// Let pending promise chains (storage, tabs, ...) run to the end. setImmediate is left real for this.
export const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// Each test gets its own worker: listeners from the last import dropped, module state (opening, watchdog...) new.
export function freshWorker() {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    chrome._clearListeners();
    vi.resetModules();
    env.bg = await import('../background.js');
    await flush();
    vi.clearAllMocks(); // forget what the import itself called
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
}

// A focused window with one active tab on `url`.
export function seed(url = 'https://example.com/', winProps = {}) {
  const w = chrome._addWindow(winProps);
  const tab = chrome._addTab({ windowId: w.id, url, active: true });
  return { w, tab };
}

// Senders, as Chrome reports them.
export const fromSwitcherPage = (tab) => ({ id: chrome.runtime.id, url: env.bg.SWITCHER_URL, ...(tab ? { tab } : {}) });
export const fromPage = (tab) => ({ id: chrome.runtime.id, url: tab.url, tab, frameId: 0 });

// Deliver a runtime message; returns the listener's return value and the respond spy.
export function send(msg, sender) {
  const respond = vi.fn();
  const [ret] = chrome.runtime.onMessage._emit(msg, sender, respond);
  return { ret, respond };
}

// The fake tabs.query matches `url` literally; Chrome treats these as match patterns (only used for "every web
// tab" here). vitest doesn't expose the original implementation after mockReset, so other queries briefly reset
// to it, which also clears query's call history.
export function patternQuery() {
  const q = chrome.tabs.query;
  const impl = async (o = {}) => {
    if (o.url !== undefined) return structuredClone(chrome._data.tabs.filter((t) => /^(https?|file):/.test(t.url)));
    q.mockReset();
    const p = q(o);
    q.mockImplementation(impl);
    return p;
  };
  q.mockImplementation(impl);
}

export const launch = () => chrome.storage.session._data.get('launch');
