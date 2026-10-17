import { describe, it, expect } from 'vitest';
import { bootSwitcher } from './helpers/switcher.js';

describe('harness', () => {
  it('boots the switcher with fake tabs', async () => {
    const sw = await bootSwitcher();
    expect(document.querySelectorAll('[data-testid="card-tab"]').length).toBe(2);
    expect(sw.state.tabs.map((t) => t.title)).toEqual(['First', 'Second']);
  });
  it('imports the background worker', async () => {
    chrome._clearListeners();
    const bg = await import('../background.js');
    expect(typeof bg.openSwitcher).toBe('function');
    expect(chrome.commands.onCommand.hasListeners()).toBe(true);
  });
});
