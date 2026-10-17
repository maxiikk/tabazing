// The fake chrome.* API itself (tests/setup/chrome.js): the parts other tests rely on.
import { describe, it, expect } from 'vitest';

describe('fake chrome.tabs.query', () => {
  it('matches exact URLs and match patterns', async () => {
    chrome._addTab({ url: 'https://a.com/x' });
    chrome._addTab({ url: 'http://b.org/' });
    chrome._addTab({ url: 'chrome://newtab/' });
    chrome._addTab({ url: 'https://sub.c.net/p' });
    const urls = async (url) => (await chrome.tabs.query({ url })).map((t) => t.url);
    expect(await urls('https://a.com/x')).toEqual(['https://a.com/x']);
    expect(await urls('http://*/*')).toEqual(['http://b.org/']);
    expect(await urls(['http://*/*', 'https://*/*'])).toEqual(['https://a.com/x', 'http://b.org/', 'https://sub.c.net/p']);
    expect(await urls('*://*.c.net/*')).toEqual(['https://sub.c.net/p']);
    expect(await urls('<all_urls>')).not.toContain('chrome://newtab/');
  });
  it('is reset before every test', async () => {
    expect(await chrome.tabs.query({})).toEqual([]);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe('fake chrome.storage', () => {
  it('round-trips values as copies and reports changes', async () => {
    const seen = [];
    chrome.storage.onChanged.addListener((c, area) => seen.push([Object.keys(c), area]));
    const v = { a: [1] };
    await chrome.storage.local.set({ k: v });
    v.a.push(2);
    expect(await chrome.storage.local.get('k')).toEqual({ k: { a: [1] } });
    expect(await chrome.storage.local.get({ missing: 5 })).toEqual({ missing: 5 });
    await chrome.storage.local.remove('k');
    expect(seen).toEqual([[['k'], 'local'], [['k'], 'local']]);
  });
});

describe('fake chrome.tabs.move / update', () => {
  const order = () => chrome._data.tabs.filter((t) => t.windowId === 1).sort((a, b) => a.index - b.index).map((t) => t.title);
  const seed = () => ['A', 'B', 'C', 'D'].map((title) => chrome._addTab({ windowId: 1, title }));
  it('moves a tab to exactly the index asked for, left or right', async () => {
    const [a, , , d] = seed();
    await chrome.tabs.move(a.id, { index: 2 });
    expect(order()).toEqual(['B', 'C', 'A', 'D']);
    await chrome.tabs.move(d.id, { index: 0 });
    expect(order()).toEqual(['D', 'B', 'C', 'A']);
    await chrome.tabs.move(d.id, { index: -1 });
    expect(order()).toEqual(['B', 'C', 'A', 'D']);
  });
  it('moves a pinned tab to the end of the pinned ones, an unpinned one just after them', async () => {
    const [, b, c] = seed();
    await chrome.tabs.update(c.id, { pinned: true });
    expect(order()).toEqual(['C', 'A', 'B', 'D']);
    await chrome.tabs.update(b.id, { pinned: true });
    expect(order()).toEqual(['C', 'B', 'A', 'D']);
    await chrome.tabs.update(c.id, { pinned: false });
    expect(order()).toEqual(['B', 'C', 'A', 'D']);
  });
});
