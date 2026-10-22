import { describe, it, expect, vi } from 'vitest';
import { isOwnUrl, normalizeUrl, isCapturableUrl, isWorthReopening } from '../../utils/extension.js';

const OWN = `chrome-extension://${chrome.runtime.id}/`;

describe('isOwnUrl', () => {
  it('matches the extension origin, optionally under a path', () => {
    expect(isOwnUrl(OWN)).toBe(true);
    expect(isOwnUrl(OWN + 'markup/switcher.html?x=1')).toBe(true);
    expect(isOwnUrl(OWN + 'markup/switcher.html', 'markup/switcher.html')).toBe(true);
    expect(isOwnUrl(OWN + 'markup/sweep.html', 'markup/switcher.html')).toBe(false);
  });
  it('rejects other origins and non-strings', () => {
    expect(isOwnUrl('chrome-extension://otherotherotherotherotherotherot/markup/switcher.html')).toBe(false);
    expect(isOwnUrl('https://example.com/' + OWN)).toBe(false);
    expect(isOwnUrl(`chrome-extension://${chrome.runtime.id}`)).toBe(false); // no trailing slash: not a page URL
    for (const value of [undefined, null, 1, {}, '']) expect(isOwnUrl(value)).toBe(false);
  });
  it('accepts both the dynamic origin and the real-id one (use_dynamic_url)', async () => {
    vi.resetModules();
    chrome.runtime.getURL.mockImplementation((path = '') => 'chrome-extension://0f1e2d3c-dynamic/' + path);
    const extensionModule = await import('../../utils/extension.js');
    expect(extensionModule.isOwnUrl('chrome-extension://0f1e2d3c-dynamic/markup/switcher.html', 'markup/switcher.html')).toBe(true);
    expect(extensionModule.isOwnUrl(OWN + 'markup/switcher.html', 'markup/switcher.html')).toBe(true);
    expect(extensionModule.isWorthReopening('chrome-extension://0f1e2d3c-dynamic/markup/sweep.html')).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('drops the fragment and trailing slashes, so variants share one key', () => {
    const normalized = normalizeUrl('https://a.com');
    expect(normalized).toBe('https://a.com/');
    expect(normalizeUrl('https://a.com/')).toBe(normalized);
    expect(normalizeUrl('https://a.com/#top')).toBe(normalized);
    expect(normalizeUrl('https://a.com/x/y///')).toBe('https://a.com/x/y');
    expect(normalizeUrl('https://a.com/x/#h')).toBe('https://a.com/x');
  });
  it('keeps the query string and the case of the path', () => {
    expect(normalizeUrl('https://A.com/Path/?q=1#f')).toBe('https://a.com/Path?q=1');
  });
  it('treats a path of only slashes as the root', () => {
    expect(normalizeUrl('https://a.com///')).toBe('https://a.com/');
  });
  it('returns "" for unusable input', () => {
    for (const value of ['', 'not a url', '/relative', undefined, null, 42, {}]) expect(normalizeUrl(value)).toBe('');
  });
  it('handles non-http URLs', () => {
    expect(normalizeUrl('chrome://settings/#x')).toBe('chrome://settings/');
    expect(normalizeUrl('file:///C:/a/b/')).toBe('file:///C:/a/b');
  });
  it('parses each address once (remembered), but not very long ones', () => {
    let made = 0;
    vi.stubGlobal('URL', class extends URL { constructor(...parameters) { made++; super(...parameters); } });
    try {
      const url = 'https://memo.example/p/?q=1#h';
      for (let i = 0; i < 5; i++) expect(normalizeUrl(url)).toBe('https://memo.example/p?q=1');
      expect(made).toBe(1);
      expect(normalizeUrl('not a url (memo)')).toBe('');
      expect(normalizeUrl('not a url (memo)')).toBe('');
      expect(made).toBe(2);
      const long = 'https://memo.example/' + 'x'.repeat(3000) + '/';
      expect(normalizeUrl(long)).toBe(long.slice(0, -1));
      expect(normalizeUrl(long)).toBe(long.slice(0, -1));
      expect(made).toBe(4);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('isCapturableUrl', () => {
  it('allows http(s) pages', () => {
    expect(isCapturableUrl('https://example.com/')).toBe(true);
    expect(isCapturableUrl('http://localhost:3000/x')).toBe(true);
    expect(isCapturableUrl('https://chrome.google.com/search')).toBe(true); // only /webstore is blocked there
    expect(isCapturableUrl('https://sub.chromewebstore.google.com/')).toBe(true);
  });
  it('rejects the stores Chrome protects', () => {
    expect(isCapturableUrl('https://chromewebstore.google.com/detail/x')).toBe(false);
    expect(isCapturableUrl('https://chrome.google.com/webstore/detail/x')).toBe(false);
    expect(isCapturableUrl('https://microsoftedge.microsoft.com/addons')).toBe(false);
  });
  it('rejects other schemes and garbage', () => {
    for (const value of ['chrome://newtab/', 'file:///a.html', 'about:blank', OWN + 'x.html', 'data:text/html,hi', 'nope', '', undefined, null])
      expect(isCapturableUrl(value)).toBe(false);
  });
});

describe('isWorthReopening', () => {
  it('lists ordinary pages', () => {
    expect(isWorthReopening('https://example.com/')).toBe(true);
    expect(isWorthReopening('chrome://settings/')).toBe(true);
  });
  it('skips blank, New Tab and own pages', () => {
    for (const value of ['about:blank', 'chrome://newtab/', 'chrome-search://local-ntp/', 'edge://newtab/', 'brave://newtab/', OWN + 'markup/switcher.html', '', undefined, null])
      expect(isWorthReopening(value)).toBe(false);
  });
});
