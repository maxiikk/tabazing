// background.js: the functions it injects into pages (nudge, flyout), run here in jsdom. The overlay host is
// tests/utils/overlay-host.test.js.
// Elements are found by data-testid only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MESSAGE } from '../utils/constants.js';
import { environment, freshWorker } from './helpers/background.js';

freshWorker();
const background = () => environment.background;
const queryTestId = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);

// The nudge and the flyout live in closed shadow roots: keep a handle on each one created.
let roots;
beforeEach(() => {
  roots = [];
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (options) { const root = attach.call(this, options); roots.push(root); return root; });
});
afterEach(() => {
  for (const id of ['nudge-host', 'flyout-host', 'overlay-shade', 'overlay-frame']) document.querySelectorAll(`[data-testid="${id}"]`).forEach((element) => element.remove());
  for (const propertyName of ['__tabazingNudge', '__tabazingFlyout', '__tabazingOverlay', '__tabazingHotkey']) delete window[propertyName];
  delete document.hidden;
});
const click = (element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true })); // isTrusted: false, like a page script's click

describe('injectNudge', () => {
  const text = { title: 'Looking?', body: 'Alt+Q shows them all.', tryIt: 'Try', ok: 'OK', never: 'Never', close: 'Close' };
  const show = () => background().injectNudge(MESSAGE.NUDGE, 12000, text, 'Alt+Q');

  it('shows the note with the key in it, in a closed shadow root', () => {
    show();
    const host = queryTestId('nudge-host');
    expect(host).not.toBeNull();
    expect(host.shadowRoot).toBeNull(); // closed: the page can't reach in
    const root = roots[0];
    expect(queryTestId('nudge-title', root).textContent).toBe('Looking?');
    expect(queryTestId('nudge-body', root).textContent).toBe('Alt+Q shows them all.');
    expect(queryTestId('nudge-key', root).textContent).toBe('Alt+Q');
    expect([...queryTestId('nudge-buttons', root).children].map((button) => button.dataset.testid)).toEqual(['nudge-try', 'nudge-ok', 'nudge-never']);
    expect(queryTestId('nudge-close', root).getAttribute('aria-label')).toBe('Close');
  });

  it('only once per page', () => {
    show();
    show();
    expect(document.querySelectorAll('[data-testid="nudge-host"]')).toHaveLength(1);
  });

  it('goes away after its time, and can be shown again', () => {
    show();
    vi.advanceTimersByTime(11999);
    expect(queryTestId('nudge-host')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(queryTestId('nudge-host')).toBeNull();
    expect(window.__tabazingNudge).toBeUndefined();
  });

  it('the close button removes it without answering', () => {
    show();
    click(queryTestId('nudge-close', roots[0]));
    expect(queryTestId('nudge-host')).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('is a dialog named by its title; Esc closes it', () => {
    show();
    const box = queryTestId('nudge', roots[0]);
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-label')).toBe('Looking?');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(queryTestId('nudge-host')).toBeNull();
  });

  it('stays while the pointer or the keyboard focus is on it, then runs its full time again', () => {
    show();
    const box = queryTestId('nudge', roots[0]);
    box.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(30000);
    expect(queryTestId('nudge-host')).not.toBeNull();
    box.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(11999);
    expect(queryTestId('nudge-host')).not.toBeNull();
    box.dispatchEvent(new FocusEvent('focusin'));
    vi.advanceTimersByTime(30000);
    expect(queryTestId('nudge-host')).not.toBeNull();
  });

  it('answer buttons ignore clicks a page script makes', () => {
    show();
    for (const id of ['nudge-try', 'nudge-ok', 'nudge-never']) click(queryTestId(id, roots[0]));
    expect(queryTestId('nudge-host')).not.toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('injectFlyout', () => {
  const text = { title: 'Tabazing is ready', body: 'Press $KEY$ to see all your tabs.', subtitle: 'Small print', close: 'Dismiss' };
  const show = () => background().injectFlyout(MESSAGE.FLYOUT_DONE, 20000, text);

  it('shows the card with the key for this platform', () => {
    show();
    const root = roots[0];
    expect(queryTestId('flyout-host').shadowRoot).toBeNull();
    expect(queryTestId('flyout-title', root).textContent).toBe('Tabazing is ready');
    expect(queryTestId('flyout-body', root).textContent).toBe('Press Alt+Q to see all your tabs.');
    expect(queryTestId('flyout-key', root).textContent).toBe('Alt+Q');
    expect(queryTestId('flyout-subtitle', root).textContent).toBe('Small print');
    expect(queryTestId('flyout-close', root).getAttribute('aria-label')).toBe('Dismiss');
  });

  it('says Option+Q on a Mac', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    show();
    expect(queryTestId('flyout-key', roots[0]).textContent).toBe('Option+Q');
  });

  it('only once per page', () => {
    show();
    show();
    expect(document.querySelectorAll('[data-testid="flyout-host"]')).toHaveLength(1);
  });

  it('dismissing it tells the worker (so it is not offered again)', () => {
    show();
    click(queryTestId('flyout-close', roots[0]));
    expect(queryTestId('flyout-host')).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.FLYOUT_DONE });
  });

  it('is a dialog named by its title; Esc dismisses it like the ×', () => {
    show();
    const box = queryTestId('flyout', roots[0]);
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-label')).toBe('Tabazing is ready');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(queryTestId('flyout-host')).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MESSAGE.FLYOUT_DONE });
  });

  it('does not go away while hovered', () => {
    show();
    queryTestId('flyout', roots[0]).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(60000);
    expect(queryTestId('flyout-host')).not.toBeNull();
  });

  it('left alone it goes away quietly (offered again on the next page)', () => {
    show();
    vi.advanceTimersByTime(20000);
    expect(queryTestId('flyout-host')).toBeNull();
    expect(window.__tabazingFlyout).toBeUndefined();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
