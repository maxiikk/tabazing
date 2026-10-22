// Shared by the switcher UI tests (render / keyboard / boot). Not a test file itself.
// boot() is bootSwitcher with the first-run tour marked as seen (else it pops up 350 ms in and takes the
// keyboard), and every booted module is retired after its test: each boot imports the module afresh, and
// the old copy's window listeners would otherwise keep reacting to the next test's keys.
import { vi, afterEach } from 'vitest';
import { bootSwitcher, waitFor, tick } from './switcher.js';

const booted = [];
afterEach(() => {
  for (const switcherModule of booted.splice(0)) { switcherModule.state.done = true; switcherModule.state.holding = false; }
  vi.unstubAllGlobals();
});

export async function boot(options = {}) {
  const switcher = await bootSwitcher({
    ...options,
    beforeImport: async () => {
      await chrome.storage.local.set({ onb: { tour: true, flyout: true, at: Date.now() } });
      if (options.beforeImport) await options.beforeImport();
    },
  });
  booted.push(switcher);
  // What arrives right after the first draw ("Recently closed" etc.) is drawn now, so it can't land in the
  // middle of a test and replace the cards (or close a big preview).
  if (options.settle !== false) {
    await tick(10);
    switcher.refresh();
  }
  return switcher;
}

/** Tabs A, B, C (A active, the current one) unless given. */
export const ABC = () => [
  { title: 'Alpha', url: 'https://alpha.example/' },
  { title: 'Bravo', url: 'https://bravo.example/' },
  { title: 'Charlie', url: 'https://charlie.example/' },
];

// Elements are selected by data-testid only.
export const byTestId = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
export const allByTestId = (id, root = document) => [...root.querySelectorAll(`[data-testid="${id}"]`)];
const CARD = ['tab', 'closed', 'snoozed', 'star'].map((kind) => `[data-testid="card-${kind}"]`).join(', ');
export const cards = (root = byTestId('scroller')) => [...root.querySelectorAll(CARD)];
export const openCards = () => cards(byTestId('open-grid'));
export const titleOf = (card) => byTestId('card-title', card).textContent;
export const titles = (list = openCards()) => list.map(titleOf);
export const selectedCard = () => cards().find((card) => card.getAttribute('aria-selected') === 'true');
export const selectedTitle = () => { const card = selectedCard(); return card && titleOf(card); };

/**
 * Boot in overlay mode: a fake parent page receives our postMessages and hands over the launch token,
 * and IntersectionObserver is a stand-in whose callback the test drives (io.fire(true|false)).
 */
export async function bootOverlay(options = {}) {
  const parent = { postMessage: vi.fn() };
  const observer = { callback: null, fire(visible) { this.callback([{ isVisible: visible }]); } };
  vi.stubGlobal('IntersectionObserver', class { constructor(callback) { observer.callback = callback; } observe() {} disconnect() {} });
  const switcher = await boot({
    ...options,
    context: { mode: 'overlay', ...options.context },
    beforeImport: async () => {
      Object.defineProperty(window, 'parent', { value: parent, configurable: true });
      const { token } = chrome.storage.session._data.get('launch');
      // Like the content script: answer the frame's "standby" with the launch.
      parent.postMessage.mockImplementation((message) => {
        if (message && message.tabazing === 'standby') setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { tabazing: 'launch', token }, source: parent })), 0);
      });
      if (options.beforeImport) await options.beforeImport();
    },
  });
  return { switcher, parent, observer };
}
export function restoreParent() { delete window.parent; }
