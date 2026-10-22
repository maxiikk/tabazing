// bootSwitcher, but quiet: the first-run tour is marked done (it would pop up 350 ms in), the delayed redraw
// after the opening animation is cancelled (it would close a big preview mid-test), and the module is marked
// done after each test, so its window key listeners stay out of the next test's page.
// `overlay: true` boots it as the in-page overlay: window.parent becomes a fake page that hands over the
// launch token when the switcher says it is standing by (frame() is that page, to check what it was sent).
import { afterEach, vi } from 'vitest';
import { bootSwitcher, tick } from './switcher.js';

let cur = null;
let frameParent = null;
let parentDesc = null;

export async function boot({ overlay = false, ...opts } = {}) {
  const sw = await bootSwitcher({
    ...opts,
    ctx: overlay ? { ...opts.ctx, mode: 'overlay' } : opts.ctx,
    beforeImport: async () => {
      await chrome.storage.local.set({ onb: { at: 1, tour: true, flyout: true } });
      if (overlay) {
        const { launch } = await chrome.storage.session.get('launch');
        const page = {
          postMessage: vi.fn((m) => {
            if (!m || m.tabazing !== 'standby') return;
            setTimeout(() => {
              const e = new Event('message');
              Object.defineProperties(e, { data: { value: { tabazing: 'launch', token: launch.token } }, source: { value: page } });
              window.dispatchEvent(e);
            }, 0);
          }),
        };
        parentDesc = parentDesc || Object.getOwnPropertyDescriptor(window, 'parent');
        Object.defineProperty(window, 'parent', { get: () => page, configurable: true, enumerable: true });
        frameParent = page;
      }
      if (opts.beforeImport) await opts.beforeImport();
    },
  });
  cur = sw;
  await tick(10);
  sw.refresh();
  return sw;
}
export const frame = () => frameParent;

afterEach(() => {
  if (cur) cur.state.done = true;
  cur = null;
  if (parentDesc) { Object.defineProperty(window, 'parent', parentDesc); parentDesc = null; frameParent = null; }
  for (const id of ['archive-overlay', 'note-popover', 'settings-backdrop', 'settings', 'menu', 'big-preview', 'note-tooltip']) tids(id).forEach((n) => n.remove());
  if (window.close.mockClear) window.close.mockClear();
});

// Elements are found by their data-testid only.
export const tid = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);
export const tids = (id, root = document) => [...root.querySelectorAll(`[data-testid="${id}"]`)];
/** The card of the open tab with this title. */
export const cardOf = (title, kind = 'tab') => tids('card-' + kind).find((c) => tid('card-title', c)?.textContent === title);

export const tabByTitle = (sw, title) => sw.state.tabs.find((x) => x.title === title);
export const entryByTitle = (sw, title) => sw.state.entries.find((e) => e.kind === 'tab' && e.tab.title === title);
export const toastText = () => tid('toast').firstChild?.textContent ?? '';
export const toastButton = () => tid('toast-action');
/** The last CLOSED message finish() sent, or undefined. */
export const closedMsg = () => chrome.runtime.sendMessage.mock.calls.map((c) => c[0]).filter((m) => m && m.type === 'tabazing:closed').at(-1);
