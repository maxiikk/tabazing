// utils/favicons.js and the icons kept in utils/store.js (Firefox, which has no favicon service): each site's icon from
// its tabs, as a data: URL by host, decoded here (nothing is downloaded), kept a week, the most recent sites only.
import { describe, it, expect } from 'vitest';
import { faviconHost, dataUrlBlob, keepFavicon } from '../../utils/favicons.js';
import { getFavicons, putFavicon, faviconSource } from '../../utils/store.js';
import { LIMITS } from '../../utils/constants.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4z8BAEmIY1TCqYfhqAAAz9n8B5FvG8gAAAABJRU5ErkJggg==';

describe('faviconHost', () => {
  it('is the page’s host for web and file pages, nothing for the rest', () => {
    expect(faviconHost('https://mail.example.com/inbox?x=1')).toBe('mail.example.com');
    expect(faviconHost('http://127.0.0.1:8080/a')).toBe('127.0.0.1:8080');
    expect(faviconHost('file:///C:/notes.html')).toBe('file');
    for (const url of ['about:blank', 'data:text/html,x', 'moz-extension://x/y.html', '', 'not a url']) expect(faviconHost(url)).toBe('');
  });
});

describe('dataUrlBlob', () => {
  it('reads base64 and percent-encoded data: URLs; refuses a broken one', () => {
    const png = dataUrlBlob(PNG);
    expect(png.type).toBe('image/png');
    expect(png.size).toBe(atob(PNG.split(',')[1]).length);
    const svg = dataUrlBlob('data:image/svg+xml,%3Csvg%2F%3E');
    expect(svg.type).toBe('image/svg+xml');
    expect(svg.size).toBe('<svg/>'.length);
    expect(dataUrlBlob('data:image/png;base64')).toBe(null);
    expect(dataUrlBlob('data:image/png;base64,%%%')).toBe(null);
  });
});

describe('keepFavicon', () => {
  it('keeps the icon a tab has as a data: URL, under its site (as it came where it can’t be drawn here)', async () => {
    await keepFavicon({ url: 'https://mail.example.com/inbox', favIconUrl: PNG });
    const icons = await getFavicons();
    expect(Object.keys(icons)).toEqual(['mail.example.com']);
    expect(icons['mail.example.com']).toMatch(/^data:image\/png;base64,/);
  });

  it('downloads nothing: an icon given as a web address is left out, and so is a page without a site', async () => {
    await keepFavicon({ url: 'https://a.example/', favIconUrl: 'https://a.example/favicon.ico' });
    await keepFavicon({ url: 'about:blank', favIconUrl: PNG });
    await keepFavicon({ url: 'https://b.example/', favIconUrl: '' });
    expect(await getFavicons()).toEqual({});
  });

  it('a site’s icon from the same address is taken once a week, a new one at once', async () => {
    await keepFavicon({ url: 'https://a.example/', favIconUrl: PNG });
    const first = await faviconSource('a.example');
    await keepFavicon({ url: 'https://a.example/other', favIconUrl: PNG });
    expect(await faviconSource('a.example')).toEqual(first);
    const other = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
    await keepFavicon({ url: 'https://a.example/', favIconUrl: other });
    expect((await faviconSource('a.example')).s).toBe(other);
  });
});

describe('putFavicon', () => {
  it('keeps only data: pictures, not too long, and the most recently seen sites', async () => {
    await putFavicon('a.example', 'https://a.example/icon.png', 'x');
    await putFavicon('b.example', 'data:image/png;base64,' + 'A'.repeat(LIMITS.FAVICON_MAX_LENGTH), 'x');
    expect(await getFavicons()).toEqual({});
    const stored = Object.fromEntries(Array.from({ length: LIMITS.MAX_FAVICONS + 2 }, (unused, i) => [`site${i}.example`, { d: PNG, s: PNG, t: 1000 + i }]));
    await chrome.storage.local.set({ favicons: stored });
    await putFavicon('new.example', PNG, PNG);
    const icons = await getFavicons();
    expect(Object.keys(icons)).toHaveLength(LIMITS.MAX_FAVICONS);
    expect(icons['new.example']).toBe(PNG);
    expect(icons['site0.example']).toBe(undefined); // (the oldest went)
  });
});
