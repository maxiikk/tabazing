// Shared by the switcher UI tests (render / keyboard / boot). Not a test file itself.
// boot() is bootSwitcher with the first-run tour marked as seen (else it pops up 350 ms in and takes the
// keyboard), and every booted module is retired after its test: each boot imports the module afresh, and
// the old copy's window listeners would otherwise keep reacting to the next test's keys.
import { vi, afterEach } from 'vitest';
import { bootSwitcher, waitFor, tick } from '../helpers/switcher.js';

const booted = [];
afterEach(() => {
  for (const m of booted.splice(0)) { m.state.done = true; m.state.holding = false; }
  vi.unstubAllGlobals();
});

export async function boot(opts = {}) {
  const sw = await bootSwitcher({
    ...opts,
    beforeImport: async () => {
      await chrome.storage.local.set({ onb: { tour: true, flyout: true, at: Date.now() } });
      if (opts.beforeImport) await opts.beforeImport();
    },
  });
  booted.push(sw);
  // What arrives right after the first draw ("Recently closed" etc.) is drawn now, so it can't land in the
  // middle of a test and replace the cards (or close a big preview).
  if (opts.settle !== false) {
    await tick(10);
    sw.refresh();
  }
  return sw;
}

/** Tabs A, B, C (A active, the current one) unless given. */
export const ABC = () => [
  { title: 'Alpha', url: 'https://alpha.example/' },
  { title: 'Bravo', url: 'https://bravo.example/' },
  { title: 'Charlie', url: 'https://charlie.example/' },
];

// Elements are selected by data-testid only.
export const tid = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
export const tids = (id, root = document) => [...root.querySelectorAll(`[data-testid="${id}"]`)];
const CARD = ['tab', 'closed', 'snoozed', 'star'].map((k) => `[data-testid="card-${k}"]`).join(', ');
export const cards = (root = tid('scroller')) => [...root.querySelectorAll(CARD)];
export const openCards = () => cards(tid('open-grid'));
export const titleOf = (c) => tid('card-title', c).textContent;
export const titles = (list = openCards()) => list.map(titleOf);
export const selectedCard = () => cards().find((c) => c.getAttribute('aria-selected') === 'true');
export const selectedTitle = () => { const c = selectedCard(); return c && titleOf(c); };

/**
 * Boot in overlay mode: a fake parent page receives our postMessages and hands over the launch token,
 * and IntersectionObserver is a stand-in whose callback the test drives (io.fire(true|false)).
 */
export async function bootOverlay(opts = {}) {
  const parent = { postMessage: vi.fn() };
  const io = { cb: null, fire(visible) { this.cb([{ isVisible: visible }]); } };
  vi.stubGlobal('IntersectionObserver', class { constructor(cb) { io.cb = cb; } observe() {} disconnect() {} });
  const sw = await boot({
    ...opts,
    ctx: { mode: 'overlay', ...opts.ctx },
    beforeImport: async () => {
      Object.defineProperty(window, 'parent', { value: parent, configurable: true });
      const { token } = chrome.storage.session._data.get('launch');
      // Like the content script: answer the frame's "standby" with the launch.
      parent.postMessage.mockImplementation((msg) => {
        if (msg && msg.tabazing === 'standby') setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { tabazing: 'launch', token }, source: parent })), 0);
      });
      if (opts.beforeImport) await opts.beforeImport();
    },
  });
  return { sw, parent, io };
}
export function restoreParent() { delete window.parent; }
