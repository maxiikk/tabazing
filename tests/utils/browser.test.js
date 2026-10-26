// utils/browser.js: which browser this is (Chrome here, as the fake chrome.* is; Firefox when the extension's pages are
// moz-extension:// pages), the extension's origin in each, closing times in seconds or milliseconds, and the top
// bookmark folders under either browser's ids.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { IS_FIREFOX, BROWSER_NAME, EXTENSION_ORIGIN, closedTime, folderTypeOf, topFolder, BOOKMARKS_ROOT } from '../../utils/browser.js';

afterEach(() => { vi.resetModules(); chrome.runtime.getURL.mockReset(); chrome.runtime.getURL.mockImplementation((path = '') => `chrome-extension://${chrome.runtime.id}/${String(path).replace(/^\//, '')}`); });

describe('the browser', () => {
  it('is Chrome: its name, its real-id origin, its bookmark root', () => {
    expect(IS_FIREFOX).toBe(false);
    expect(BROWSER_NAME).toBe('Chrome');
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${chrome.runtime.id}`);
    expect(BOOKMARKS_ROOT).toBe('0');
  });

  it('is Firefox where the extension’s pages are moz-extension:// pages (whose uuid is not the add-on’s id)', async () => {
    chrome.runtime.getURL.mockImplementation((path = '') => `moz-extension://6f1e2d3c-4b5a-4c7d-8e9f-0a1b2c3d4e5f/${path}`);
    vi.resetModules();
    const firefox = await import('../../utils/browser.js');
    expect(firefox.IS_FIREFOX).toBe(true);
    expect(firefox.BROWSER_NAME).toBe('Firefox');
    expect(firefox.EXTENSION_ORIGIN).toBe('moz-extension://6f1e2d3c-4b5a-4c7d-8e9f-0a1b2c3d4e5f');
    expect(firefox.BOOKMARKS_ROOT).toBe('root________');
  });
});

describe('closedTime', () => {
  it('reads Chrome’s seconds and Firefox’s milliseconds alike; 0 when there is none', () => {
    expect(closedTime({ lastModified: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(closedTime({ lastModified: 1_700_000_000_123 })).toBe(1_700_000_000_123);
    expect(closedTime({ lastModified: 0 })).toBe(0);
    expect(closedTime({})).toBe(0);
    expect(closedTime(null)).toBe(0);
  });
});

describe('the top bookmark folders', () => {
  it('folderTypeOf: by folderType, then Firefox’s ids, then Chrome’s', () => {
    expect(folderTypeOf({ id: '9', folderType: 'other' })).toBe('other');
    expect(folderTypeOf({ id: 'toolbar_____' })).toBe('bookmarks-bar');
    expect(folderTypeOf({ id: 'unfiled_____' })).toBe('other');
    expect(folderTypeOf({ id: 'mobile______' })).toBe('mobile');
    expect(folderTypeOf({ id: 'menu________' })).toBe('menu');
    expect(folderTypeOf({ id: '1' })).toBe('bookmarks-bar');
    expect(folderTypeOf({ id: '2' })).toBe('other');
    expect(folderTypeOf({ id: '42' })).toBe(null);
    expect(folderTypeOf(null)).toBe(null);
  });

  it('topFolder: the one the browser names so first, then the one known by its id', () => {
    expect(topFolder([{ id: '2' }, { id: '9', folderType: 'other' }], 'other').id).toBe('9');
    expect(topFolder([{ id: 'menu________' }, { id: 'toolbar_____' }, { id: 'unfiled_____' }], 'other').id).toBe('unfiled_____');
    expect(topFolder([{ id: '5' }], 'other')).toBe(null);
  });
});
