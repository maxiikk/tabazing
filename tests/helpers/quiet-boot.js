// bootSwitcher, but quiet: the first-run tour is marked done (it would pop up 350 ms in), the delayed redraw
// after the opening animation is cancelled (it would close a big preview mid-test), and the module is marked
// done after each test, so its window key listeners stay out of the next test's page.
// `overlay: true` boots it as the in-page overlay: window.parent becomes a fake page that hands over the
// launch token when the switcher says it is standing by (frame() is that page, to check what it was sent).
import { afterEach, vi } from 'vitest';
import { bootSwitcher, tick } from './switcher.js';

let currentSwitcher = null;
let frameParent = null;
let parentDescriptor = null;

export async function boot({ overlay = false, ...options } = {}) {
  const switcher = await bootSwitcher({
    ...options,
    context: overlay ? { ...options.context, mode: 'overlay' } : options.context,
    beforeImport: async () => {
      await chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } });
      if (overlay) {
        const { launch } = await chrome.storage.session.get('launch');
        const page = {
          postMessage: vi.fn((message) => {
            if (!message || message.tabazing !== 'standby') return;
            setTimeout(() => {
              const event = new Event('message');
              Object.defineProperties(event, { data: { value: { tabazing: 'launch', token: launch.token } }, source: { value: page } });
              window.dispatchEvent(event);
            }, 0);
          }),
        };
        parentDescriptor = parentDescriptor || Object.getOwnPropertyDescriptor(window, 'parent');
        Object.defineProperty(window, 'parent', { get: () => page, configurable: true, enumerable: true });
        frameParent = page;
      }
      if (options.beforeImport) await options.beforeImport();
    },
  });
  currentSwitcher = switcher;
  await tick(10);
  switcher.refresh();
  return switcher;
}
export const frame = () => frameParent;

afterEach(() => {
  if (currentSwitcher) currentSwitcher.state.done = true;
  currentSwitcher = null;
  if (parentDescriptor) { Object.defineProperty(window, 'parent', parentDescriptor); parentDescriptor = null; frameParent = null; }
  for (const id of ['archive-overlay', 'note-popover', 'settings-backdrop', 'settings', 'menu', 'big-preview', 'note-tooltip']) allByTestId(id).forEach((element) => element.remove());
  if (window.close.mockClear) window.close.mockClear();
});

// Elements are found by their data-testid only.
export const byTestId = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
export const allByTestId = (id, root = document) => [...root.querySelectorAll(`[data-testid="${id}"]`)];
/** The card of the open tab with this title. */
export const cardOf = (title, kind = 'tab') => allByTestId('card-' + kind).find((card) => byTestId('card-title', card)?.textContent === title);

export const tabByTitle = (switcher, title) => switcher.state.tabs.find((x) => x.title === title);
export const entryByTitle = (switcher, title) => switcher.state.entries.find((entry) => entry.kind === 'tab' && entry.tab.title === title);
export const toastText = () => byTestId('toast').firstChild?.textContent ?? '';
export const toastButton = () => byTestId('toast-action');
/** The last CLOSED message finish() sent, or undefined. */
export const closedMessage = () => chrome.runtime.sendMessage.mock.calls.map((call) => call[0]).filter((message) => message && message.type === 'tabazing:closed').at(-1);
