// Boot the real switcher page (markup/switcher.html + switcher.js) in jsdom, the way the background opens it:
// a launch token in storage.session and in the page's address (popup-window mode, so no web page and no
// clickjacking guard are involved). Resolves to the module's exports once the first draw is done.
//
//   const sw = await bootSwitcher({ tabs: [{ title: 'A', url: 'https://a.com/' }, ...], ctx: { dir: 0 } });
//   switcher.state.entries, document.querySelectorAll('[data-testid="card-tab"]'), switcher.onKeyDown(...)
//
// Tabs are created in window 1 (the first one active, unless one says `active`); context.sourceTab defaults to the
// active tab. `prefs` goes to storage.local before boot, `beforeImport` runs just before the module loads.
import { vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HTML = readFileSync(resolve(process.cwd(), 'markup/switcher.html'), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');

// The switcher a test booted keeps timers (the redraw after the opening animation, Chrome's history
// search, ...). After each test it is marked finished, which those timers check, so none of them runs
// once the test's page is gone.
let current = null;
export function stopSwitcher() {
  if (current && current.state) current.state.done = true;
  current = null;
}
afterEach(stopSwitcher);

export const tick = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export async function waitFor(test, { timeout = 2000, step = 5 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = test();
    if (value) return value;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await tick(step);
  }
}

export function loadPage() {
  document.documentElement.className = '';
  document.documentElement.removeAttribute('lang');
  document.body.innerHTML = BODY;
}

export async function bootSwitcher({ tabs, context = {}, preferences, beforeImport } = {}) {
  loadPage();
  if (!chrome._data.windows.length) chrome._addWindow({ id: 1, focused: true });
  const list = tabs || [{ title: 'First', url: 'https://first.example/' }, { title: 'Second', url: 'https://second.example/' }];
  const made = list.map((tab, i) => chrome._addTab({ windowId: 1, active: tab.active ?? (i === 0 && !list.some((x) => x.active)), ...tab }));
  if (preferences) await chrome.storage.local.set({ prefs: preferences });
  const active = made.find((tab) => tab.active) || made[0];
  const token = 'test-token-' + Math.random().toString(36).slice(2);
  await chrome.storage.session.set({
    launch: { token, t: Date.now(), context: { sourceTab: active ? active.id : 0, window: 1, direction: 1, via: 'key', hold: false, state: 'normal', mode: 'window', ...context } },
  });
  history.replaceState(null, '', '/switcher.html?t=' + token);
  if (beforeImport) await beforeImport();
  vi.resetModules();
  chrome._clearListeners();
  stopSwitcher(); // a second boot in the same test: the first one stops listening
  const module = await import('../../switcher.js');
  current = module;
  await waitFor(() => !document.querySelector('[data-testid="app"]').hidden);
  await tick(20); // loadExtras and the first refresh after it
  return module;
}

/** A keydown on the window (where the switcher listens), returning the event. */
export function key(keyName, init = {}) {
  const codes = { Escape: 'Escape', Enter: 'Enter', Delete: 'Delete', Tab: 'Tab', ' ': 'Space' };
  const event = new KeyboardEvent('keydown', { key: keyName, code: init.code || codes[keyName] || (keyName.length === 1 ? 'Key' + keyName.toUpperCase() : keyName), bubbles: true, cancelable: true, ...init });
  (init.target || document.activeElement || window).dispatchEvent(event);
  return event;
}
