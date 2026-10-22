import { describe, it, expect } from 'vitest';
import { bootSwitcher } from './helpers/switcher.js';

describe('harness', () => {
  it('boots the switcher with fake tabs', async () => {
    const switcher = await bootSwitcher();
    expect(document.querySelectorAll('[data-testid="card-tab"]').length).toBe(2);
    expect(switcher.state.tabs.map((tab) => tab.title)).toEqual(['First', 'Second']);
  });
  it('imports the background worker', async () => {
    chrome._clearListeners();
    const background = await import('../background.js');
    expect(typeof background.openSwitcher).toBe('function');
    expect(chrome.commands.onCommand.hasListeners()).toBe(true);
  });
});
