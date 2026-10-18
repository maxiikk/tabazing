// background.js: the functions it injects into pages (nudge, flyout), run here in jsdom. The overlay host is
// tests/lib/overlay-host.test.js.
// Elements are found by data-testid only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MSG } from '../lib/constants.js';
import { env, freshWorker } from './background.shared.js';

freshWorker();
const bg = () => env.bg;
const $ = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);

// The nudge and the flyout live in closed shadow roots: keep a handle on each one created.
let roots;
beforeEach(() => {
  roots = [];
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (o) { const r = attach.call(this, o); roots.push(r); return r; });
});
afterEach(() => {
  for (const id of ['nudge-host', 'flyout-host', 'overlay-shade', 'overlay-frame']) document.querySelectorAll(`[data-testid="${id}"]`).forEach((n) => n.remove());
  for (const k of ['__tabazingNudge', '__tabazingFlyout', '__tabazingOverlay', '__tabazingHotkey']) delete window[k];
  delete document.hidden;
});
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })); // isTrusted: false, like a page script's click

describe('injectNudge', () => {
  const text = { title: 'Looking?', body: 'Alt+Q shows them all.', tryIt: 'Try', ok: 'OK', never: 'Never', close: 'Close' };
  const show = () => bg().injectNudge(MSG.NUDGE, 12000, text, 'Alt+Q');

  it('shows the note with the key in it, in a closed shadow root', () => {
    show();
    const host = $('nudge-host');
    expect(host).not.toBeNull();
    expect(host.shadowRoot).toBeNull(); // closed: the page can't reach in
    const root = roots[0];
    expect($('nudge-title', root).textContent).toBe('Looking?');
    expect($('nudge-body', root).textContent).toBe('Alt+Q shows them all.');
    expect($('nudge-key', root).textContent).toBe('Alt+Q');
    expect([...$('nudge-buttons', root).children].map((b) => b.dataset.testid)).toEqual(['nudge-try', 'nudge-ok', 'nudge-never']);
    expect($('nudge-close', root).getAttribute('aria-label')).toBe('Close');
  });

  it('only once per page', () => {
    show();
    show();
    expect(document.querySelectorAll('[data-testid="nudge-host"]')).toHaveLength(1);
  });

  it('goes away after its time, and can be shown again', () => {
    show();
    vi.advanceTimersByTime(11999);
    expect($('nudge-host')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect($('nudge-host')).toBeNull();
    expect(window.__tabazingNudge).toBeUndefined();
  });

  it('the close button removes it without answering', () => {
    show();
    click($('nudge-close', roots[0]));
    expect($('nudge-host')).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('is a dialog named by its title; Esc closes it', () => {
    show();
    const box = $('nudge', roots[0]);
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-label')).toBe('Looking?');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('nudge-host')).toBeNull();
  });

  it('stays while the pointer or the keyboard focus is on it, then runs its full time again', () => {
    show();
    const box = $('nudge', roots[0]);
    box.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(30000);
    expect($('nudge-host')).not.toBeNull();
    box.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(11999);
    expect($('nudge-host')).not.toBeNull();
    box.dispatchEvent(new FocusEvent('focusin'));
    vi.advanceTimersByTime(30000);
    expect($('nudge-host')).not.toBeNull();
  });

  it('answer buttons ignore clicks a page script makes', () => {
    show();
    for (const id of ['nudge-try', 'nudge-ok', 'nudge-never']) click($(id, roots[0]));
    expect($('nudge-host')).not.toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('injectFlyout', () => {
  const text = { title: 'Tabazing is ready', body: 'Press $KEY$ to see all your tabs.', sub: 'Small print', close: 'Dismiss' };
  const show = () => bg().injectFlyout(MSG.FLYOUT_DONE, 20000, text);

  it('shows the card with the key for this platform', () => {
    show();
    const root = roots[0];
    expect($('flyout-host').shadowRoot).toBeNull();
    expect($('flyout-title', root).textContent).toBe('Tabazing is ready');
    expect($('flyout-body', root).textContent).toBe('Press Alt+Q to see all your tabs.');
    expect($('flyout-key', root).textContent).toBe('Alt+Q');
    expect($('flyout-sub', root).textContent).toBe('Small print');
    expect($('flyout-close', root).getAttribute('aria-label')).toBe('Dismiss');
  });

  it('says Option+Q on a Mac', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    show();
    expect($('flyout-key', roots[0]).textContent).toBe('Option+Q');
  });

  it('only once per page', () => {
    show();
    show();
    expect(document.querySelectorAll('[data-testid="flyout-host"]')).toHaveLength(1);
  });

  it('dismissing it tells the worker (so it is not offered again)', () => {
    show();
    click($('flyout-close', roots[0]));
    expect($('flyout-host')).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG.FLYOUT_DONE });
  });

  it('is a dialog named by its title; Esc dismisses it like the ×', () => {
    show();
    const box = $('flyout', roots[0]);
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-label')).toBe('Tabazing is ready');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('flyout-host')).toBeNull();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG.FLYOUT_DONE });
  });

  it('does not go away while hovered', () => {
    show();
    $('flyout', roots[0]).dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(60000);
    expect($('flyout-host')).not.toBeNull();
  });

  it('left alone it goes away quietly (offered again on the next page)', () => {
    show();
    vi.advanceTimersByTime(20000);
    expect($('flyout-host')).toBeNull();
    expect(window.__tabazingFlyout).toBeUndefined();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
