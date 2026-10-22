// Browser APIs jsdom doesn't have but Tabazing's pages use. Kept minimal: enough for the code to run.
import { vi } from 'vitest';

if (!window.matchMedia) {
  window.matchMedia = vi.fn((query) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}
globalThis.matchMedia = window.matchMedia;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
if (!window.IntersectionObserver) {
  window.IntersectionObserver = class { constructor(callback) { this.callback = callback; } observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  globalThis.IntersectionObserver = window.IntersectionObserver;
}
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}
// Closing the switcher's own window would tear down the test page.
window.close = vi.fn();
window.focus = vi.fn();
