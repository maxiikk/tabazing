import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KEY, MSG } from '../lib/constants.js';

// The progress window: sweep.js runs at import (top-level await), against sweep.html's own markup.
// Elements are found by data-testid only.
const BODY = readFileSync(resolve(process.cwd(), 'sweep.html'), 'utf8')
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, '');

const tid = (id) => document.querySelector(`[data-testid="${id}"]`);
const flush = () => new Promise((r) => setTimeout(r, 0));

async function open(state) {
  if (state !== undefined) await chrome.storage.session.set({ [KEY.SWEEP]: state });
  document.body.innerHTML = BODY;
  chrome._clearListeners();
  vi.resetModules();
  await import('../sweep.js');
  await flush(); // the initial storage read
}
const setProgress = (p) => chrome.storage.session.set({ [KEY.SWEEP]: p });

beforeEach(() => { document.title = ''; });

describe('sweep page', () => {
  it('localizes the page and draws Y-bit', async () => {
    await open();
    expect(document.title).toBe('Tabazing: capturing previews');
    const svg = tid('ybit');
    expect(svg.tagName).toBe('svg');
    expect(tid('ybit-slot').contains(svg)).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--accent')).not.toBe('');
  });

  it('shows the progress already stored when it opens', async () => {
    await open({ running: true, done: 1, total: 4 });
    expect(tid('msg').textContent).toBe('Tab 2 of 4');
    expect(tid('fill').style.width).toBe('25%');
    expect(tid('sweep-progress').getAttribute('aria-valuenow')).toBe('25');
  });

  it('follows progress updates', async () => {
    await open({ running: true, done: 0, total: 3 });
    expect(tid('msg').textContent).toBe('Tab 1 of 3');
    expect(tid('fill').style.width).toBe('0%');
    await setProgress({ running: true, done: 2, total: 3 });
    expect(tid('msg').textContent).toBe('Tab 3 of 3');
    expect(tid('fill').style.width).toBe('67%');
    await setProgress({ running: true, done: 3, total: 3 }); // last one done: never "Tab 4 of 3"
    expect(tid('msg').textContent).toBe('Tab 3 of 3');
    expect(tid('fill').style.width).toBe('100%');
  });

  it('says Done when the run ends (or there is none)', async () => {
    await open();
    expect(tid('msg').textContent).toBe('Done.');
    await setProgress({ running: true, done: 0, total: 2 });
    await setProgress({ running: false, done: 0, total: 0 });
    expect(tid('msg').textContent).toBe('Done.');
    expect(tid('fill').style.width).toBe('100%');
  });

  it('ignores the same key in other storage areas and unrelated session keys', async () => {
    await open({ running: true, done: 0, total: 2 });
    await chrome.storage.local.set({ [KEY.SWEEP]: { running: false } });
    await chrome.storage.session.set({ other: 1 });
    expect(tid('msg').textContent).toBe('Tab 1 of 2');
  });

  it('Stop asks the background to cancel', async () => {
    await open({ running: true, done: 0, total: 2 });
    chrome.runtime.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist.')); // swallowed
    tid('cancel').click();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG.SWEEP_CANCEL });
    expect(tid('msg').textContent).toBe('Stopping…');
    await flush();
  });
});
